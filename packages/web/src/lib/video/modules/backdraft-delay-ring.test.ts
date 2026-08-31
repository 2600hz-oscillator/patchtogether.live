// packages/web/src/lib/video/modules/backdraft-delay-ring.test.ts
//
// The LAZY-GROWING delay ring (2026-08-29, the PR that doubled
// BACKDRAFT_MAX_DELAY_MS 500 → 1000). The owner's condition, verbatim: "if i
// set it to our current max delay, it's the same as today, and only becomes
// larger as i increase the delay" — so the properties pinned here are:
//
//   * a ring at the OLD 500ms max holds the OLD slot count (31) exactly;
//   * anything at or below it holds no more than the old fixed ring did;
//   * the ring GROWS on demand — from the KNOB, from a CV sweep on `delay`
//     (through the real engine cv-bridge), and from the DELAY CLOCK — up to
//     the 61-slot cap;
//   * growth is MONOTONIC: turning the delay back down never shrinks it
//     (hysteresis beats VRAM churn; warm slots make a return instant).
//
// The ring depth is observed through the handle's `read('ringDepth')` — a
// too-shallow ring is invisible in the render (the tap just clamps), so the
// probe is the only observable, exactly like `clockRiseCount` / `panicCount`.
//
// The factory legs run the REAL backdraftDef.factory over a Proxy GL stub and
// drive draw() with a fake frame — the backdraft-gate-edges.test.ts precedent.
// The CV leg runs the REAL VideoEngine + addCvBridge headless (the
// backdraft/panic.test.ts precedent), so "CV asks past the current depth" is
// the shipped tickCvBridges path, not a mirror of it.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  backdraftDef,
  backdraftDelayFrames,
  backdraftRingDepthNeeded,
  BACKDRAFT_BUFFER_FRAMES,
  BACKDRAFT_MAX_DELAY_MS,
  BACKDRAFT_FPS,
  BACKDRAFT_CLOCK_PATCH_GRACE_MS,
  BACKDRAFT_CLOCK_PATCH_GRACE_FRAMES,
} from './backdraft';
import { VideoEngine, type VideoEngineContext, type VideoNodeHandle } from '$lib/video/engine';
import type { ModuleNode } from '$lib/graph/types';
// Side-effect: registers the video defs so VideoEngine.addNode resolves them.
import '$lib/video/modules';

/** The OLD fixed ring's slot count, derived the way the old constant was:
 *  ceil(500ms at 60fps) + 1 headroom = 31. Written as a derivation, not a
 *  frozen literal, so the assertion states WHAT it preserves. */
const OLD_MAX_DELAY_MS = 500;
const OLD_RING_SLOTS = Math.ceil((OLD_MAX_DELAY_MS / 1000) * BACKDRAFT_FPS) + 1;

// The GL stub — Proxy so a shader/uniform call added later cannot silently
// break this file (gate-edges precedent; enum constants read 0 so the real
// engine's framebuffer-complete check passes, the panic.test.ts extension).
function makeFakeGl(): WebGL2RenderingContext {
  return new Proxy(
    {},
    {
      get: (_t, prop) => {
        const p = String(prop);
        if (p.startsWith('create') || p === 'getUniformLocation') return () => ({});
        if (p === 'getProgramParameter' || p === 'getShaderParameter') return () => true;
        if (p === 'getExtension') return () => null;
        if (/^[A-Z][A-Z0-9_]*$/.test(p)) return 0; // enum constants
        return () => 0;
      },
    },
  ) as unknown as WebGL2RenderingContext;
}

function makeCtx(): VideoEngineContext {
  return {
    gl: makeFakeGl(),
    res: { width: 320, height: 240 },
    compileFragment: () => ({}) as WebGLProgram,
    createFbo: () => ({ fbo: {} as WebGLFramebuffer, texture: {} as WebGLTexture }),
    createFloatFbo: () => ({
      fbo: {} as WebGLFramebuffer, texture: {} as WebGLTexture,
      isFloat: false, width: 320, height: 240,
    }),
    drawFullscreenQuad: () => undefined,
  } as unknown as VideoEngineContext;
}

function spawn(params: Record<string, number> = {}): VideoNodeHandle {
  const node = {
    id: 'bd-ring', type: 'backdraft', domain: 'video', position: { x: 0, y: 0 }, params,
  } as unknown as ModuleNode;
  return backdraftDef.factory(makeCtx(), node);
}

function depth(h: VideoNodeHandle): number {
  return h.read?.('ringDepth') as number;
}

function draw(h: VideoNodeHandle, timeSec = 0, frame = 0): void {
  h.surface.draw({
    gl: makeFakeGl(),
    time: timeSec,
    frame,
    getInputTexture: () => null,
  } as never);
}

let nowSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => { nowSpy = vi.spyOn(performance, 'now'); });
afterEach(() => { nowSpy.mockRestore(); });

describe('backdraftRingDepthNeeded — the pure sizing rule', () => {
  it('the OLD max delay needs exactly the OLD fixed ring (slot units)', () => {
    const f = backdraftDelayFrames(OLD_MAX_DELAY_MS, BACKDRAFT_BUFFER_FRAMES);
    expect(backdraftRingDepthNeeded(f, false), 'slots at 500ms').toBe(OLD_RING_SLOTS);
  });

  it('at or below the old max it NEVER exceeds the old allocation (refresh off)', () => {
    for (let ms = 0; ms <= OLD_MAX_DELAY_MS; ms += 10) {
      const f = backdraftDelayFrames(ms, BACKDRAFT_BUFFER_FRAMES);
      expect(
        backdraftRingDepthNeeded(f, false),
        `slots at ${ms}ms must not exceed the old fixed ring`,
      ).toBeLessThanOrEqual(OLD_RING_SLOTS);
    }
  });

  it('the refresh tap (TV+FLICKER) pays for exactly one extra slot, inside the cap', () => {
    expect(backdraftRingDepthNeeded(6, true) - backdraftRingDepthNeeded(6, false)).toBe(1);
    // At the absolute max the cap absorbs it — the refresh tap saturates
    // there, exactly as the old fixed ring saturated at its own max.
    expect(backdraftRingDepthNeeded(60, true)).toBe(BACKDRAFT_BUFFER_FRAMES);
  });

  it('is monotonic in delayFrames and capped at BACKDRAFT_BUFFER_FRAMES', () => {
    let prev = 0;
    for (let f = 1; f <= 120; f++) {
      const d = backdraftRingDepthNeeded(f, false);
      expect(d, `depth(${f} frames) monotonic`).toBeGreaterThanOrEqual(prev);
      expect(d, `depth(${f} frames) capped`).toBeLessThanOrEqual(BACKDRAFT_BUFFER_FRAMES);
      prev = d;
    }
    expect(prev, 'the cap is reached').toBe(BACKDRAFT_BUFFER_FRAMES);
  });
});

describe('the factory ring — lazy at boot, grows on demand, never shrinks', () => {
  it('boot at the default delay allocates the small ring, not the cap', () => {
    const h = spawn();
    // default 16ms → 1 frame → 2 slots.
    expect(depth(h), 'slots at the 16ms default').toBe(2);
    h.surface.dispose();
  });

  it('boot at the OLD 500ms max costs exactly the OLD slot count — the owner condition', () => {
    const h = spawn({ delay: OLD_MAX_DELAY_MS });
    expect(depth(h), 'slots at 500ms').toBe(OLD_RING_SLOTS);
    h.surface.dispose();
  });

  it('the KNOB grows the ring; turning it back down does not shrink it', () => {
    nowSpy.mockImplementation(() => 0);
    const h = spawn();
    expect(depth(h)).toBe(2);
    h.setParam('delay', BACKDRAFT_MAX_DELAY_MS);
    draw(h);
    expect(depth(h), 'slots after asking for the full 1000ms').toBe(BACKDRAFT_BUFFER_FRAMES);
    h.setParam('delay', 50);
    draw(h, 0.1, 1);
    expect(depth(h), 'no shrink on decrease (hysteresis)').toBe(BACKDRAFT_BUFFER_FRAMES);
    h.surface.dispose();
  });

  it('TV MODE + FLICKER grows one refresh slot on the draw that first uses it', () => {
    nowSpy.mockImplementation(() => 0);
    const h = spawn({ delay: 100 }); // 6 frames → 7 slots
    expect(depth(h)).toBe(7);
    h.setParam('tvMode', 1);
    h.setParam('flicker', 1);
    draw(h);
    expect(depth(h), 'one extra slot for the virtual-refresh tap').toBe(8);
    h.surface.dispose();
  });

  it('the DELAY CLOCK grows the ring past the knob (capped like the knob)', () => {
    let nowMs = 0;
    nowSpy.mockImplementation(() => nowMs);
    const h = spawn(); // knob at 16ms → 2 slots
    expect(depth(h)).toBe(2);
    // Two rising edges 900ms apart → periodSec 0.9 → effective 900ms.
    h.setParam('delayClock', 0);
    h.setParam('delayClock', 1);
    nowMs = 900;
    h.setParam('delayClock', 0);
    h.setParam('delayClock', 1);
    // Draw inside the clock-patched freshness window.
    nowMs = 910;
    draw(h, 0.91, 0);
    const f = backdraftDelayFrames(900, BACKDRAFT_BUFFER_FRAMES);
    expect(depth(h), 'slots after a 900ms clock period').toBe(f + 1);
    h.surface.dispose();
  });
});

describe('the CV path — a real cv-bridge sweep on `delay` deepens the ring', () => {
  function makeHeadlessEngine(): VideoEngine {
    const canvas = {
      width: 320,
      height: 240,
      getContext: () => makeFakeGl(),
    } as unknown as HTMLCanvasElement;
    return new VideoEngine({ canvas });
  }

  function makeFakeAnalyser(value: () => number): AnalyserNode {
    return {
      fftSize: 128,
      getFloatTimeDomainData: (buf: Float32Array) => buf.fill(value()),
    } as unknown as AnalyserNode;
  }

  it('cv = +1 into the delay input asks past the boot depth and the ring grows', async () => {
    const ve = makeHeadlessEngine();
    const node = {
      id: 'bd-cv', type: 'backdraft', domain: 'video',
      position: { x: 0, y: 0 }, params: { delay: 16 },
    } as unknown as ModuleNode;
    await ve.addNode(node);
    const h = ve.getNodeHandle('bd-cv')!;
    expect(depth(h), 'boot slots at 16ms').toBe(2);

    // linear cvScale: effective = knob + cv·halfSpan = 16 + 1.0·500 = 516ms.
    ve.addCvBridge('e-delay-cv', makeFakeAnalyser(() => 1.0), 'bd-cv', 'delay', () => {}, 'cv');
    ve.step(); // tickCvBridges writes the mapped delay into the handle
    expect(h.readParam('delay'), 'the bridge drove the delay (ms)').toBeCloseTo(516, 6);

    draw(h); // the next draw grows to what the CV-driven delay needs
    const f = backdraftDelayFrames(516, BACKDRAFT_BUFFER_FRAMES);
    expect(depth(h), 'slots after the CV sweep').toBe(f + 1);
    expect(depth(h), 'a CV past the old max exceeds the old ring').toBeGreaterThan(OLD_RING_SLOTS);
  });
});

describe('clocked delay — a patched clock makes the fader INERT (owner ruling)', () => {
  // Drive the REAL factory through the bridge-replay seam: setParam writes
  // stamp the clock's freshness window (patched = the bridge is writing),
  // rising-edge pairs measure the period, draws resolve the effective delay.
  // The observable is read('effectiveDelayMs') — the value draw() actually
  // used — because the render output cannot show which delay it tapped.
  const eff = (h: VideoNodeHandle): number => h.read?.('effectiveDelayMs') as number;

  function patchTick(h: VideoNodeHandle, level: number): void {
    // What installGateDispatch writes each ~25ms tick while a cable exists:
    // the settled level (edges are explicit 0;1 pairs via clockEdge below).
    h.setParam('delayClock', level);
  }
  function clockEdge(h: VideoNodeHandle): void {
    h.setParam('delayClock', 0);
    h.setParam('delayClock', 1);
  }

  it('patching HOLDS the current delay (no jump), then locks to the measured pulse', () => {
    let nowMs = 0;
    nowSpy.mockImplementation(() => nowMs);
    const h = spawn({ delay: 120 });
    draw(h, 0, 0);
    expect(eff(h), 'unpatched: the fader rules (ms)').toBe(120);

    patchTick(h, 0); // the cable lands; the bridge starts writing
    nowMs = 10;
    draw(h, 0.01, 1);
    expect(eff(h), 'patched, unmeasured: HOLDS 120ms — no jump (ms)').toBe(120);

    h.setParam('delay', 400); // fader move while patched-and-unmeasured
    nowMs = 20;
    patchTick(h, 0);
    draw(h, 0.02, 2);
    expect(eff(h), 'the fader write is ignored while patched (ms)').toBe(120);

    clockEdge(h);
    nowMs = 320;
    clockEdge(h); // two edges 300ms apart → period 0.3s
    draw(h, 0.32, 3);
    expect(eff(h), 'locked to one pulse duration (ms)').toBeCloseTo(300, 6);

    h.setParam('delay', 900); // fader move while clock-driven
    nowMs = 330;
    patchTick(h, 0);
    draw(h, 0.33, 4);
    expect(eff(h), 'the fader stays ignored while clock-driven (ms)').toBeCloseTo(300, 6);
    h.surface.dispose();
  });

  it('unpatching returns control to the fader AT ITS CURRENT POSITION; re-patching holds anew', () => {
    let nowMs = 0;
    let frame = 0;
    nowSpy.mockImplementation(() => nowMs);
    const h = spawn({ delay: 120 });
    clockEdge(h);
    nowMs = 300;
    clockEdge(h);
    draw(h, nowMs / 1000, frame++);
    expect(eff(h), 'clock-driven (ms)').toBeCloseTo(300, 6);

    h.setParam('delay', 777); // moved while clocked — parked, not applied
    // UNPATCH: the bridge stops writing; both freshness legs must lapse
    // (the wall-clock grace AND the frame floor), so advance past each.
    nowMs += BACKDRAFT_CLOCK_PATCH_GRACE_MS + 1;
    for (let i = 0; i <= BACKDRAFT_CLOCK_PATCH_GRACE_FRAMES + 1; i++) {
      draw(h, nowMs / 1000, frame++);
      nowMs += 1;
    }
    expect(eff(h), 'unpatched: the fader rules again, at its parked position (ms)').toBe(777);

    // RE-PATCH: the stale 300ms period must NOT come back — hold 777 instead.
    patchTick(h, 0);
    nowMs += 5;
    draw(h, nowMs / 1000, frame);
    expect(eff(h), 're-patched, unmeasured: HOLDS the current delay (ms)').toBe(777);
    h.surface.dispose();
  });

  it('PANIC resets the fader PARAM while the effective delay stays clocked', () => {
    // The panic semantics (patching preserved) meet the clocked-delay ruling:
    // panic writes the delay param back to its default through the ordinary
    // engine path, and because a clock is patched that write — like any fader
    // write — does not move the effective delay.
    let nowMs = 0;
    nowSpy.mockImplementation(() => nowMs);
    const h = spawn({ delay: 480 });
    clockEdge(h);
    nowMs = 250;
    clockEdge(h);
    draw(h, 0.25, 0);
    expect(eff(h), 'clock-driven (ms)').toBeCloseTo(250, 6);

    // What backdraftPanic's engine push does for `delay` (the def default):
    h.setParam('delay', 16);
    nowMs = 260;
    patchTick(h, 0);
    draw(h, 0.26, 1);
    expect(h.readParam('delay'), 'the fader PARAM did reset (ms)').toBe(16);
    expect(eff(h), 'the effective delay stays clocked (ms)').toBeCloseTo(250, 6);
    h.surface.dispose();
  });
});
