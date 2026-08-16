// packages/web/src/lib/video/modules/backdraft-gate-edges.test.ts
//
// BACKDRAFT's clock/gate inputs, driven through the REAL factory by the REAL
// `installGateDispatch` write sequence. The behavioural half of #1725.
//
// ── THE DEFECT ──
// Every one of backdraft's raw-passthrough clock/gate inputs edge-detected
// inside `draw()`, by reading `params.<id>`. `PatchEngine.installGateDispatch`
// (audio/engine.ts) does NOT stream the gate waveform to a video module: it
// counts rising edges in the audio thread and REPLAYS them on the ~25 ms
// scheduler tick as `setParam(0); setParam(1)` per counted edge, then
// `setParam(currentLevel)` — all inside the same millisecond. A draw-time
// detector therefore samples only the SETTLED LEVEL, and for a real trigger
// that level is 0 again before any frame renders.
//
// ── WHY THIS FILE DRIVES THE FACTORY AND NOT A CPU MIRROR ──
// The defect is PLACEMENT. The edge primitives (`detectEdge`,
// `backdraftClockTick`, `backdraftMirrorGateTick`) were always correct, and
// `backdraft.test.ts` drives every one of them directly and passed throughout.
// What was wrong is WHERE the factory called them from. A CPU mirror of the
// gate handling would reproduce whatever the mirror's author believed, so it
// could be "fixed" while backdraft.ts stayed dead — the exact failure mode
// `trigger-edge-placement.test.ts` records in its own header. This file
// therefore spawns the real `backdraftDef.factory` over a Proxy GL stub (the
// b3ntb0x.test.ts precedent) and observes it ONLY through `readParam` / `read`.
//
// ── THE MEASUREMENT, AND THE NUMBERS ──
// CAPTURE RATE = (rising edges the module ACTED on) / (rising edges the bridge
// DELIVERED). The unit is EDGES and it is printed in every assertion message.
// Swept over the pulse's offset inside the 25 ms tick window, because a single
// offset ALIASES against the tick grid and returns a constant.
//
//   pulse width                 detection in draw()      detection in setParam
//   5 ms  (TRIGGER_PULSE_S)     28.6 %  flat 1-16 Hz     100 %
//   10 ms (sequencer clock-out) 42.9 %  flat 1-16 Hz     100 %
//   50 ms (DEFAULT_GATE_LEN_S)  100 %                    100 %
//   5 ms @ 8 fps (SwiftShader)  0.0 %                    100 %
//
// The 28.6 % and 42.9 % are not noise, they are arithmetic: the bridge reports
// the LEVEL once per 25 ms tick, so a w-ms pulse is seen as HIGH only when a
// tick instant lands inside it, which is w/25 of the offsets (2/7 and 3/7 of
// the offsets swept here). FLAT ACROSS RATES — which is the #1703 signature and
// the reason this never looked like a clock bug. And the 50 ms row is why it
// survived: a gate wider than one tick reads 100 %, so every manual check with
// a held gate passed.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { backdraftDef } from './backdraft';
import { detectEdge, makeEdgeState } from '$lib/doom/cv-gate-edge';
import { SCHEDULER_TICK_MS } from '$lib/audio/scheduler-clock';
import { GATE_HI, TRIGGER_PULSE_S, DEFAULT_GATE_LEN_S } from '$lib/audio/gate-trigger';
import type { VideoEngineContext, VideoNodeHandle } from '$lib/video/engine';
import type { ModuleNode, PortDef } from '$lib/graph/types';

// ---------------------------------------------------------------------------
// The GL stub. A Proxy so a shader/uniform call added to backdraft later cannot
// silently break this file (the b3ntb0x.test.ts pattern).
// ---------------------------------------------------------------------------

function makeFakeGl(): WebGL2RenderingContext {
  return new Proxy(
    {},
    {
      get: (_t, prop) => {
        const p = String(prop);
        if (p.startsWith('create') || p === 'getUniformLocation') return () => ({});
        if (p === 'checkFramebufferStatus') return () => 0x8cd5;
        if (p === 'getProgramParameter' || p === 'getShaderParameter') return () => true;
        if (p === 'getExtension') return () => null;
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

function spawnBackdraft(): VideoNodeHandle {
  const node = {
    id: 'bd', type: 'backdraft', domain: 'video', position: { x: 0, y: 0 }, params: {},
  } as unknown as ModuleNode;
  return backdraftDef.factory(makeCtx(), node);
}

// ---------------------------------------------------------------------------
// WHICH PORTS ARE IN SCOPE — DERIVED from the def, never listed and never
// counted. The predicate MIRRORS the dispatch's own two conditions line for
// line, so a port this test covers is exactly a port the bridge can feed:
//
//   engine.ts  `if (edge.sourceType !== 'gate') return false;`            (source)
//   engine.ts  `if (input.cvScale && input.cvScale.mode !== 'passthrough') return false;`
//
// plus `canConnect`'s CV_FAMILY (cv / pitch / gate, freely interchangeable) and
// `modsignal`, which a gate cable may also terminate on. `installGateDispatch`
// never reads the TARGET's declared type, so neither does this.
// ---------------------------------------------------------------------------

const GATE_REACHABLE_INPUT_TYPE = new Set(['gate', 'cv', 'pitch', 'modsignal']);

function bridgeReachableGateInputs(): PortDef[] {
  return (backdraftDef.inputs ?? []).filter(
    (p) =>
      typeof p.paramTarget === 'string' &&
      GATE_REACHABLE_INPUT_TYPE.has(p.type) &&
      !(p.cvScale && p.cvScale.mode !== 'passthrough'),
  );
}

// ---------------------------------------------------------------------------
// HOW EACH PORT IS OBSERVED, from OUTSIDE the factory.
//
// A NAMED entry per port with the `why` in the TYPE — a required field, so tsc
// refuses an observer that does not say what reading it implements before any
// test runs. The keys are asserted against the DERIVED set above in BOTH
// directions, so this is not a population list: a new raw-passthrough port on
// backdraft is RED here until someone decides how to observe it, and an entry
// for a port that no longer exists is RED too.
// ---------------------------------------------------------------------------

interface Observer {
  /** What ONE rising edge does, and how that becomes visible from outside. */
  why: string;
  /** Reading that CHANGES exactly once per acted-on edge, so the number of
   *  transitions IS the number of edges the module acted on. */
  read(h: VideoNodeHandle): number;
}

const OBSERVERS: Readonly<Record<string, Observer>> = {
  delay_clock: {
    why: 'a rising edge timestamps a pulse; the monotonic clockRiseCount probe is the ONLY thing that distinguishes "every edge" from "one in four", because a dropped edge just measures a longer period and the picture still looks fine',
    read: (h) => (h.read?.('clockRiseCount') as number | undefined) ?? 0,
  },
  mirror_x_gate: {
    why: 'a rising edge FLIPS mirrorX, folding the left half of the composite over the right',
    read: (h) => h.readParam?.('mirrorX') ?? 0,
  },
  mirror_y_gate: {
    why: 'a rising edge FLIPS mirrorY, folding the top half of the composite over the bottom',
    read: (h) => h.readParam?.('mirrorY') ?? 0,
  },
  shape_gate: {
    why: 'a rising edge CYCLES shape (square->circle->pentagon->triangle->octagon->square)',
    read: (h) => h.readParam?.('shape') ?? 0,
  },
  pure_geo_gate: {
    why: 'a rising edge TOGGLES pureGeo (screen-space crop <-> zoomed-source crop)',
    read: (h) => h.readParam?.('pureGeo') ?? 0,
  },
  tv_gate: {
    why: 'a rising edge CYCLES tvMode (OFF -> PURE TV -> CRITICAL -> OFF)',
    read: (h) => h.readParam?.('tvMode') ?? 0,
  },
};

// ---------------------------------------------------------------------------
// THE TIMELINE. Scheduler ticks every SCHEDULER_TICK_MS deliver the bridge's
// replay; video draws every framePeriodMs. The virtual clock drives BOTH
// `frame.time` (what draw() reads) and `performance.now()` (what the setParam
// detector reads), so the two PLACEMENTS are compared on the SAME clock and the
// result cannot be an artefact of one being faster than the other.
// ---------------------------------------------------------------------------

/** How the timeline's OWN, independent detector reads the param stream — the
 *  negative controls. `none` = observe the module only. */
type Control =
  /** The PRE-FIX placement, verbatim: one `detectEdge` over `readParam(<gate
   *  param>)` per DRAW. Not a mirror of the module, an independent reader of
   *  the same param at the same place the shipped code used to read it. */
  | 'drawTimeLevel'
  /** The OVER-COUNT direction: a STATELESS threshold reader in setParam that
   *  acts on every write >= GATE_HI. Dropping the edge state is the realistic
   *  mistake in the opposite direction, and it must read WAY over 100 %. */
  | 'statelessThreshold'
  | 'none';

interface TimelineOpts {
  portId: string;
  /** Pulse rate in Hz. */
  rateHz: number;
  /** Pulse WIDTH in ms. */
  pulseMs: number;
  /** Video frame rate. 8 fps is the measured `E2E_SWIFTSHADER=1` figure. */
  fps: number;
  /** Where the pulse STARTS inside the 25 ms tick window. This is the whole
   *  ballgame for a draw-time reading: the bridge writes `setParam(level)` once
   *  per tick, so a short pulse is reported HIGH only when a tick instant lands
   *  inside it. Sweeping it is what stops the measurement aliasing to a
   *  constant. */
  pulseOffsetMs: number;
  /** How many pulses to fire. */
  pulses: number;
  control?: Control;
  /** Hold the gate HIGH for the whole run instead of pulsing (the held-gate
   *  leg: N ticks of level 1 must still be exactly ONE rising edge). */
  hold?: boolean;
  /** Deliver NOTHING — no setParam at all. The unpatched leg. */
  silent?: boolean;
}

interface TimelineResult {
  /** Rising edges the BRIDGE actually replayed into setParam. */
  delivered: number;
  /** Rising edges the MODULE acted on (or the control's own reader saw). */
  captured: number;
  /** captured / delivered, as a percentage. Explicitly in EDGES. */
  ratePct: number;
  /** The period the module measured, in SECONDS. */
  measuredPeriodSec: number;
  /** `read('clockDriving')`. */
  clockDriving: boolean;
  /** Draws executed, so "never rendered" is distinguishable from "rendered and
   *  saw nothing" — the two look identical from a bare capture count. */
  draws: number;
}

function runGateTimeline(o: TimelineOpts): TimelineResult {
  const obs = OBSERVERS[o.portId];
  if (!obs) throw new Error(`no observer for ${o.portId}`);
  const port = bridgeReachableGateInputs().find((p) => p.id === o.portId);
  if (!port) throw new Error(`${o.portId} is not a bridge-reachable gate input`);
  const paramId = port.paramTarget!;
  const control = o.control ?? 'none';

  const h = spawnBackdraft();
  let nowMs = 0;
  nowSpy.mockImplementation(() => nowMs);

  const periodMs = 1000 / o.rateHz;
  const framePeriodMs = 1000 / o.fps;
  const durationMs = periodMs * (o.pulses + 1);
  const pulseAt = (k: number): number => periodMs * (k + 1) + o.pulseOffsetMs;

  const events: Array<{ t: number; kind: 'tick' | 'draw' }> = [];
  for (let t = SCHEDULER_TICK_MS; t < durationMs; t += SCHEDULER_TICK_MS) {
    events.push({ t, kind: 'tick' });
  }
  for (let t = framePeriodMs; t < durationMs; t += framePeriodMs) events.push({ t, kind: 'draw' });
  events.sort((a, b) => a.t - b.t || (a.kind === 'tick' ? -1 : 1));

  // Sample the module's observable after EVERY write and every draw, so several
  // edges replayed inside one tick are each counted. Sampling once per draw
  // would undercount a TOGGLE by construction and make a fast clock look broken
  // for a reason that has nothing to do with the module.
  let last = obs.read(h);
  let captured = 0;
  const sampleModule = (): void => {
    const v = obs.read(h);
    if (v !== last) { captured++; last = v; }
  };

  // The controls' own readers.
  const ctlEdge = makeEdgeState();
  let ctlCaptured = 0;

  const write = (v: number): void => {
    h.setParam?.(paramId, v);
    if (control === 'statelessThreshold') {
      if (v >= GATE_HI) ctlCaptured++;
    }
    if (control === 'none') sampleModule();
  };

  let edgesSeen = 0;
  let delivered = 0;
  let draws = 0;
  for (const e of events) {
    nowMs = e.t;
    if (e.kind === 'tick') {
      if (o.silent) continue;
      let edges = 0;
      let level = 0;
      if (o.hold) {
        // A gate opened once, before the first tick, and never closed.
        level = 1;
        if (edgesSeen === 0) { edges = 1; edgesSeen = 1; }
      } else {
        for (let k = 0; k < o.pulses; k++) {
          const start = pulseAt(k);
          if (start <= e.t && k >= edgesSeen) { edges++; edgesSeen = k + 1; }
          if (e.t >= start && e.t < start + o.pulseMs) level = 1;
        }
      }
      delivered += edges;
      for (let i = 0; i < edges; i++) { write(0); write(1); }
      write(level);
    } else {
      h.surface.draw({
        gl: makeFakeGl(),
        time: e.t / 1000,
        frame: draws,
        getInputTexture: () => null,
      } as never);
      draws++;
      if (control === 'drawTimeLevel') {
        // VERBATIM the pre-fix placement: read the gate param's LEVEL at draw
        // time and edge-detect it there.
        if (detectEdge(ctlEdge, h.readParam?.(paramId) ?? 0)?.pressed) ctlCaptured++;
      }
      if (control === 'none') sampleModule();
    }
  }

  const measuredPeriodSec = (h.read?.('clockPeriodSec') as number | undefined) ?? 0;
  const clockDriving = (h.read?.('clockDriving') as boolean | undefined) ?? false;
  h.surface.dispose();

  const seen = control === 'none' ? captured : ctlCaptured;
  return {
    delivered,
    captured: seen,
    ratePct: delivered > 0 ? (seen / delivered) * 100 : 0,
    measuredPeriodSec,
    clockDriving,
    draws,
  };
}

let nowSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => { nowSpy = vi.spyOn(performance, 'now'); });
afterEach(() => { nowSpy.mockRestore(); });

/** Pulse-start offsets inside the 25 ms tick window. Irregular and spanning the
 *  whole window, so a short pulse is sometimes reported HIGH and sometimes not.
 *  A single offset aliases against the tick grid and returns a constant — the
 *  "sample at co-prime / irregular offsets" rule, applied to the tick period
 *  rather than to the frame period. */
const PULSE_OFFSETS_MS = [0.5, 4.5, 9.5, 13.5, 18.5, 22.5, 24.5];

interface SweepResult { delivered: number; captured: number; ratePct: number; cells: number[] }

/** Aggregate over the offset sweep. */
function sweepOffsets(o: Omit<TimelineOpts, 'pulseOffsetMs'>): SweepResult {
  let delivered = 0;
  let captured = 0;
  const cells: number[] = [];
  for (const pulseOffsetMs of PULSE_OFFSETS_MS) {
    const r = runGateTimeline({ ...o, pulseOffsetMs });
    delivered += r.delivered;
    captured += r.captured;
    cells.push(r.ratePct);
  }
  return {
    delivered, captured, cells,
    ratePct: delivered > 0 ? (captured / delivered) * 100 : 0,
  };
}

const RATES_HZ = [1, 2, 4, 8, 16];
const TRIGGER_WIDTHS_MS = [TRIGGER_PULSE_S * 1000, 10];
const HELD_WIDTH_MS = DEFAULT_GATE_LEN_S * 1000;
const FPS = [8, 30, 60, 120];
const PULSES = 12;

const gatePorts = (): string[] => bridgeReachableGateInputs().map((p) => p.id);

// ===========================================================================
// THE HEADLINE. Deny by default: EVERY bridge-reachable gate port, at EVERY
// rate and width and frame rate, must act on EVERY delivered edge. There is no
// exemption list, because there is nothing left to exempt.
// ===========================================================================

describe('backdraft: every bridge-reachable gate input captures 100% of delivered edges', () => {
  for (const rateHz of RATES_HZ) {
    for (const pulseMs of [...TRIGGER_WIDTHS_MS, HELD_WIDTH_MS]) {
      it(`${rateHz} Hz, ${pulseMs} ms pulse: every port captures every edge`, () => {
        const bad: string[] = [];
        for (const portId of gatePorts()) {
          const r = sweepOffsets({ portId, rateHz, pulseMs, fps: 60, pulses: PULSES });
          if (r.ratePct !== 100) {
            bad.push(
              `${portId}: ${r.captured}/${r.delivered} EDGES = ${r.ratePct.toFixed(1)}% ` +
              `(per-offset cells %: ${r.cells.map((c) => c.toFixed(0)).join(',')})`,
            );
          }
        }
        expect(
          bad,
          bad.length === 0 ? '' : [
            '',
            `Edges DELIVERED by installGateDispatch's replay but never ACTED ON, at ${rateHz} Hz / ${pulseMs} ms:`,
            ...bad.map((b) => `  • ${b}`),
            '',
            'UNITS: edges, not frames and not milliseconds. A rate under 100 % means the',
            'detection is reading a LEVEL somewhere that only sees the settled value —',
            'almost certainly back in draw(). A rate OVER 100 % means an edge is being',
            'counted more than once. See the header for the pre-fix numbers.',
          ].join('\n'),
        ).toEqual([]);
      });
    }
  }

  it('a 5 ms TRIGGER is captured at every frame rate, including the 8 fps SwiftShader floor', () => {
    // The pre-fix placement measured 0.0 % here: the level the bridge reports
    // stands for one 25 ms tick, and at 8 fps the next draw is 125 ms away, so
    // no frame could land inside it. Detection on the setParam clock is
    // renderer-independent BY CONSTRUCTION — it never looks at a frame.
    const bad: string[] = [];
    for (const fps of FPS) {
      for (const portId of gatePorts()) {
        const r = sweepOffsets({ portId, rateHz: 4, pulseMs: TRIGGER_PULSE_S * 1000, fps, pulses: PULSES });
        if (r.ratePct !== 100) bad.push(`${portId} @${fps}fps: ${r.captured}/${r.delivered} EDGES = ${r.ratePct.toFixed(1)}%`);
      }
    }
    expect(bad, `a trigger must not depend on the renderer:\n${bad.join('\n')}`).toEqual([]);
  });

  it('the timeline actually RAN — draws happened and edges were delivered', () => {
    // "Frozen" and "never looked" are indistinguishable from a capture count
    // alone. Assert the preconditions so a harness that silently delivered
    // nothing cannot report a clean 0/0.
    const r = runGateTimeline({
      portId: 'shape_gate', rateHz: 4, pulseMs: 5, fps: 60, pulseOffsetMs: 0.5, pulses: PULSES,
    });
    expect(r.delivered, 'the bridge replayed every pulse').toBe(PULSES);
    expect(r.draws, 'the surface actually drew').toBeGreaterThan(PULSES);
  });
});

// ===========================================================================
// NEGATIVE CONTROLS — BOTH DIRECTIONS, both PERMANENT LEGS.
//
// A gate that can only fail one way proves half of what it claims. #1703's
// sibling fix records the measurement: a bigger buffer alone OVER-counted at
// 143.8-150.0 %, so "the number went up" is not evidence of a fix. Each control
// below drives the SAME timeline through the SAME real factory and differs only
// in WHERE its detector reads.
// ===========================================================================

describe('NEGATIVE CONTROLS: the timeline can fail in both directions', () => {
  it('UNDER-COUNT: the PRE-FIX draw-time level reading still fails this timeline', () => {
    // If this ever passes, the headline sweep proves nothing — it would be
    // satisfiable without moving the detection at all. This is not a mirror of
    // backdraft's logic: it is one `detectEdge` over `readParam(<gate param>)`
    // called once per DRAW, which is character for character where the shipped
    // code used to read.
    const rows: string[] = [];
    for (const rateHz of RATES_HZ) {
      for (const pulseMs of TRIGGER_WIDTHS_MS) {
        const r = sweepOffsets({
          portId: 'shape_gate', rateHz, pulseMs, fps: 60, pulses: PULSES, control: 'drawTimeLevel',
        });
        rows.push(`${rateHz}Hz/${pulseMs}ms = ${r.ratePct.toFixed(1)}% (${r.captured}/${r.delivered} EDGES)`);
        expect(
          r.ratePct,
          `the draw-time reading captured EVERY edge at ${rateHz} Hz / ${pulseMs} ms — the timeline cannot tell the two placements apart, so the headline sweep is decoration: ${rows.join('  ')}`,
        ).toBeLessThan(100);
      }
    }
  });

  it('UNDER-COUNT: and its rate is FLAT in the clock rate — the #1703 signature', () => {
    // The tell that this is a SAMPLING defect and not a clock defect. The
    // bridge reports the level once per tick, so the loss is set by the pulse
    // WIDTH against the 25 ms tick and is invariant to how fast the clock runs.
    // Asserting flatness (a property) rather than the value (a number) means
    // nothing here goes stale when the offset sweep changes.
    for (const pulseMs of TRIGGER_WIDTHS_MS) {
      const rates = RATES_HZ.map((rateHz) => sweepOffsets({
        portId: 'shape_gate', rateHz, pulseMs, fps: 60, pulses: PULSES, control: 'drawTimeLevel',
      }).ratePct);
      // 16 Hz is excluded from the flatness claim: at a 62.5 ms period a 50 ms
      // pulse would overlap itself, and even at 10 ms the gate spends enough of
      // the period high that the hysteresis fall is not always reached. The
      // flat band is the rates where the pulse is a small part of the period.
      const flatBand = rates.slice(0, RATES_HZ.indexOf(16));
      const spread = Math.max(...flatBand) - Math.min(...flatBand);
      expect(
        spread,
        `draw-time capture rate should be FLAT across ${RATES_HZ.slice(0, RATES_HZ.indexOf(16)).join('/')} Hz at a ${pulseMs} ms width — measured [${rates.map((r) => r.toFixed(1)).join(', ')}] %`,
      ).toBeLessThan(1);
      expect(
        flatBand[0],
        `and it must be BELOW 100 %, or there is nothing to fix: [${rates.map((r) => r.toFixed(1)).join(', ')}] %`,
      ).toBeLessThan(100);
    }
  });

  it('WHY IT WENT UNNOTICED: the same draw-time reading scores 100% on a HELD gate', () => {
    // The other half of the control, and the reason this shipped. A gate wider
    // than one 25 ms tick is reported HIGH by at least one tick whatever the
    // offset, so the level STANDS across a frame and the draw-time detector
    // does see the rise. Every manual check with a sustained gate passed.
    for (const rateHz of [1, 2, 4]) {
      const r = sweepOffsets({
        portId: 'shape_gate', rateHz, pulseMs: HELD_WIDTH_MS, fps: 60, pulses: PULSES, control: 'drawTimeLevel',
      });
      expect(
        r.ratePct,
        `a ${HELD_WIDTH_MS} ms gate at ${rateHz} Hz should be fully visible even to the broken placement (that is why nobody noticed): ${r.captured}/${r.delivered} EDGES`,
      ).toBe(100);
    }
  });

  it('OVER-COUNT: a STATELESS threshold reader blows past 100%', () => {
    // The opposite failure, and the one a "just make the detector see more"
    // fix produces. Drop the edge state and act on every write >= GATE_HI: the
    // bridge writes the settled level EVERY tick, so a held gate machine-guns.
    // A permanent leg — if this ever reads <= 100 % the sweep has lost its
    // ability to detect double-counting and the 100 % headline is worthless.
    const r = sweepOffsets({
      portId: 'shape_gate', rateHz: 2, pulseMs: HELD_WIDTH_MS, fps: 60, pulses: PULSES,
      control: 'statelessThreshold',
    });
    expect(
      r.ratePct,
      `a stateless >= ${GATE_HI} reader must OVER-count (it sees every per-tick level report as an edge): ${r.captured}/${r.delivered} EDGES = ${r.ratePct.toFixed(1)}%`,
    ).toBeGreaterThan(100);
  });

  it('the module itself does NOT machine-gun: a HELD gate is exactly ONE edge', () => {
    // The over-count direction applied to the SHIPPED code, not to a straw man.
    // installGateDispatch writes `setParam(level)` on EVERY tick while a gate
    // is held, so a detector without hysteresis state would fire once per tick.
    // The whole run must produce exactly one advance.
    for (const portId of gatePorts()) {
      const r = runGateTimeline({
        portId, rateHz: 1, pulseMs: 0, fps: 60, pulseOffsetMs: 0, pulses: 4, hold: true,
      });
      expect(r.delivered, `${portId}: the held-gate timeline delivered one edge`).toBe(1);
      expect(
        r.captured,
        `${portId}: a HELD gate must advance EXACTLY ONCE, not once per ${SCHEDULER_TICK_MS} ms tick — saw ${r.captured} advances over ${r.draws} draws`,
      ).toBe(1);
    }
  });

  it('an UNPATCHED input never fires (the bridge writes nothing at all)', () => {
    // A module detects "this input is patched" from the fact that setParam is
    // called for it at all. With no writes there must be no advance, and the
    // DELAY CLOCK must not claim to be driving the delay.
    for (const portId of gatePorts()) {
      const r = runGateTimeline({
        portId, rateHz: 1, pulseMs: 5, fps: 60, pulseOffsetMs: 0.5, pulses: 4, silent: true,
      });
      expect(r.delivered, `${portId}: nothing was delivered`).toBe(0);
      expect(r.captured, `${portId}: an unpatched gate fired ${r.captured} times`).toBe(0);
      expect(r.draws, `${portId}: the surface still drew`).toBeGreaterThan(0);
      expect(r.clockDriving, `${portId}: an unpatched module must not report clockDriving`).toBe(false);
    }
  });
});

// ===========================================================================
// DELAY CLOCK — the period, separately from the edge count.
// ===========================================================================

describe('backdraft DELAY CLOCK: the measured period, in SECONDS', () => {
  it('locks to the pulse period within one scheduler tick', () => {
    // The residual error is the bridge's delivery granularity, not a detector
    // bug: an edge counted in the audio thread is replayed on the next ~25 ms
    // scheduler tick and carries NO timestamp of its own, so the period we can
    // measure is quantized to SCHEDULER_TICK_MS. That is inherent to the wire
    // protocol — measuring at draw time instead would quantize to the FRAME
    // and, far worse, miss ~3 edges in 4 and report a MULTIPLE of the period.
    const bad: string[] = [];
    for (const rateHz of RATES_HZ) {
      for (const pulseOffsetMs of PULSE_OFFSETS_MS) {
        const r = runGateTimeline({
          portId: 'delay_clock', rateHz, pulseMs: TRIGGER_PULSE_S * 1000,
          fps: 60, pulseOffsetMs, pulses: PULSES,
        });
        const trueMs = 1000 / rateHz;
        const errMs = Math.abs(r.measuredPeriodSec * 1000 - trueMs);
        if (!r.clockDriving || errMs > SCHEDULER_TICK_MS) {
          bad.push(
            `${rateHz}Hz off+${pulseOffsetMs}ms: measured ${(r.measuredPeriodSec * 1000).toFixed(1)} ms ` +
            `vs true ${trueMs.toFixed(1)} ms (err ${errMs.toFixed(1)} ms), driving=${r.clockDriving}`,
          );
        }
      }
    }
    expect(
      bad,
      `DELAY CLOCK period error exceeded the ${SCHEDULER_TICK_MS} ms bridge tick (UNITS: ms):\n${bad.join('\n')}`,
    ).toEqual([]);
  });

  it('NEGATIVE CONTROL: a dropped edge shows up as a MULTIPLE of the period', () => {
    // Proves the period assertion above can actually fail, and pins the shape
    // of the failure it is looking for. Deliver every OTHER edge and the
    // measured period must roughly double — which is exactly what the pre-fix
    // placement produced whenever it saw two edges at all.
    const h = spawnBackdraft();
    let nowMs = 0;
    nowSpy.mockImplementation(() => nowMs);
    const trueMs = 250;
    for (let k = 1; k <= 6; k++) {
      nowMs = k * trueMs * 2; // every OTHER pulse
      h.setParam?.('delayClock', 0);
      h.setParam?.('delayClock', 1);
      h.setParam?.('delayClock', 0);
    }
    const measuredMs = ((h.read?.('clockPeriodSec') as number) ?? 0) * 1000;
    h.surface.dispose();
    expect(
      measuredMs,
      `half the edges dropped must read as ~2x the true ${trueMs} ms period — measured ${measuredMs.toFixed(1)} ms`,
    ).toBeCloseTo(trueMs * 2, 5);
  });
});

// ===========================================================================
// THE DEF SIDE. Derived membership, asserted both ways, no count anywhere.
// ===========================================================================

describe('backdraft def: every bridge-reachable gate input declares its edge semantic', () => {
  it("all of them declare edge: 'trigger' — none reads a held level", () => {
    // Established from the CONSUMER, not from the name: each of these acts once
    // per rising edge (toggle / cycle / timestamp) and nothing in backdraft
    // reads the held level of any of them. That is what makes 'trigger' the
    // honest declaration and hands the port to rule 2 of
    // trigger-edge-placement.test.ts, which then requires the setParam
    // detection this file measures.
    const undeclared = bridgeReachableGateInputs()
      .filter((p) => p.edge !== 'trigger')
      .map((p) => `${p.id} (edge=${String(p.edge)})`);
    expect(
      undeclared,
      `these bridge-reachable inputs do not declare edge: 'trigger'. If one of them genuinely ` +
      `acts WHILE the level is high it should declare 'gate' instead — and then it must NOT be ` +
      `in OBSERVERS as an edge-counted port: ${undeclared.join(', ')}`,
    ).toEqual([]);
  });

  it('OBSERVERS is anchored to the def and moves in BOTH directions', () => {
    // Ground truth is the live scan of the def. A new raw-passthrough gate port
    // on backdraft is RED until it is given an observer; an observer for a port
    // that no longer exists (or that grew a real cvScale and left the dispatch
    // path) is RED too. No count, no ceiling, no floor.
    expect(Object.keys(OBSERVERS).sort()).toEqual(gatePorts().sort());
  });

  it('every observer states WHAT reading it implements', () => {
    for (const [portId, o] of Object.entries(OBSERVERS)) {
      expect(o.why.length, `${portId}'s observer must say what one edge does`).toBeGreaterThan(40);
    }
  });

  it('INSTRUMENT: the scope predicate can see a port and can also reject one', () => {
    // The predicate mirrors installGateDispatch. Prove it discriminates, or a
    // scope that silently matched NOTHING would let every assertion above pass
    // over an empty set. Both directions, against the real def.
    expect(gatePorts().length, 'the def yields at least one bridge-reachable gate port').toBeGreaterThan(0);
    const ids = gatePorts();
    // A port WITH a real cvScale is off the dispatch path (engine.ts:1569) and
    // must not be in scope — `zoom` is one, and it is a continuous knob CV.
    expect(ids, 'a cvScale-swept CV input is NOT a gate port').not.toContain('zoom');
    // …and a plain video input has no paramTarget at all.
    expect(ids, 'a video input is NOT a gate port').not.toContain('in_a');
  });
});

// ===========================================================================
// ⚠ WHAT THIS FILE CANNOT SEE — stated, not implied.
//
//  · It drives `installGateDispatch`'s WRITE SEQUENCE, not the dispatcher. That
//    the audio-thread worklet counts the right number of edges in the first
//    place is `engine-gate-dispatch.test.ts`'s job; if the bridge under-delivers
//    then every rate here is 100 % of a wrong denominator.
//  · The GL context is a Proxy stub, so nothing here says the mutated params
//    reach the SHADER. `e2e/tests/backdraft*.spec.ts` and the VRT scenes are
//    what pin the picture.
//  · It observes `readParam` / `read`, which is the ENGINE's view. Whether the
//    engine-side mutation is reflected back into the patch STORE (so the card
//    button and a save both agree) is a separate defect, tracked as #1723 and
//    deliberately untouched here.
//  · The scheduler tick is modelled as exactly SCHEDULER_TICK_MS with no
//    lateness. A loaded main thread delivers it late; the bridge's worklet
//    accumulator makes that cost latency rather than edges, which is the
//    property `engine-gate-dispatch.test.ts` covers.
// ===========================================================================
