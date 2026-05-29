// packages/web/src/lib/video/modules/scoreboard.test.ts
//
// Module-def shape + factory plumbing for SCOREBOARD. Uses a fake GL
// context (no real WebGL) — mirrors 4plexvid.test.ts.
//
// Coverage:
//   - Module def shape (inputs / outputs / params / category / domain).
//   - Default color = neon green (~0.33 = 120°).
//   - SCORE gate rising-edge increments the counter.
//   - Hysteresis: a held-high gate advances ONCE, not every sample.
//   - Wrap at 10000 → 0.
//   - RESET gate clears the counter to 0.
//   - SCORE + RESET are independent edge detectors.
//   - color knob writes through setParam + reads through readParam.

import { describe, expect, it } from 'vitest';
import { scoreboardDef, SCOREBOARD_DEFAULT_HUE, scoreboardWrap } from './scoreboard';
import type { VideoEngineContext } from '$lib/video/engine';
import type { ModuleNode } from '$lib/graph/types';
import { getVideoModuleDef, listVideoModuleDefs } from '$lib/video/module-registry';
import { SCOREBOARD_WRAP_AT } from './scoreboard-draw';
// Side-effect import registers every video def, including ours.
import '$lib/video/modules';

describe('scoreboardDef — module def shape', () => {
  it('registers under type "scoreboard" with the right metadata', () => {
    expect(scoreboardDef.type).toBe('scoreboard');
    expect(scoreboardDef.domain).toBe('video');
    expect(scoreboardDef.label).toBe('SCOREBOARD');
    expect(scoreboardDef.category).toBe('utilities');
    expect(scoreboardDef.schemaVersion).toBe(1);
  });

  it('declares 2 cv-gate inputs (SCORE + RESET) routed through paramTargets', () => {
    const ids = scoreboardDef.inputs.map((p) => ({ id: p.id, type: p.type, t: p.paramTarget }));
    expect(ids).toEqual([
      { id: 'score', type: 'cv', t: 'scoreTrig' },
      { id: 'reset', type: 'cv', t: 'resetTrig' },
    ]);
  });

  it('declares a single video output named "out"', () => {
    expect(scoreboardDef.outputs.map((o) => ({ id: o.id, type: o.type }))).toEqual([
      { id: 'out', type: 'video' },
    ]);
  });

  it('exposes a user-facing "color" knob plus the two synthetic gate params', () => {
    const byId = new Map(scoreboardDef.params.map((p) => [p.id, p]));
    const color = byId.get('color');
    expect(color, 'color param exists').toBeDefined();
    expect(color!.min).toBe(0);
    expect(color!.max).toBe(1);
    expect(color!.curve).toBe('linear');
    // Default ≈ 120° (= green; ≈ 0.333..) per the spec.
    expect(color!.defaultValue).toBeCloseTo(SCOREBOARD_DEFAULT_HUE, 5);
    expect(color!.defaultValue).toBeGreaterThan(0.3);
    expect(color!.defaultValue).toBeLessThan(0.4);
    // Hidden gate params present.
    expect(byId.get('scoreTrig')).toBeDefined();
    expect(byId.get('resetTrig')).toBeDefined();
  });

  it('every default value sits within the declared min/max', () => {
    for (const p of scoreboardDef.params) {
      expect(p.defaultValue, `${p.id} >= min`).toBeGreaterThanOrEqual(p.min);
      expect(p.defaultValue, `${p.id} <= max`).toBeLessThanOrEqual(p.max);
    }
  });

  it('appears in the global video registry (side-effect import)', () => {
    const types = listVideoModuleDefs().map((d) => d.type);
    expect(types).toContain('scoreboard');
    expect(getVideoModuleDef('scoreboard')).toBe(scoreboardDef);
  });
});

describe('scoreboardWrap — wrap-at-10000 modulo policy', () => {
  it('passes through values below the modulus', () => {
    expect(scoreboardWrap(0)).toBe(0);
    expect(scoreboardWrap(42)).toBe(42);
    expect(scoreboardWrap(9999)).toBe(9999);
  });

  it('wraps exactly at SCOREBOARD_WRAP_AT (10000 → 0)', () => {
    expect(scoreboardWrap(SCOREBOARD_WRAP_AT)).toBe(0);
    expect(scoreboardWrap(SCOREBOARD_WRAP_AT + 1)).toBe(1);
    expect(scoreboardWrap(SCOREBOARD_WRAP_AT * 2 + 7)).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// Factory gate -> counter increment / reset behaviour (fake GL — no WebGL).
// ---------------------------------------------------------------------------

function makeFakeGl(): WebGL2RenderingContext {
  const stub = (): unknown => ({});
  return {
    getUniformLocation: stub,
    createTexture: () => ({}),
    bindTexture: () => undefined,
    texParameteri: () => undefined,
    texImage2D: () => undefined,
    pixelStorei: () => undefined,
    deleteTexture: () => undefined,
    deleteFramebuffer: () => undefined,
    deleteProgram: () => undefined,
    activeTexture: () => undefined,
    bindFramebuffer: () => undefined,
    viewport: () => undefined,
    useProgram: () => undefined,
    uniform1i: () => undefined,
    uniform1f: () => undefined,
    uniform2f: () => undefined,
    TEXTURE_2D: 0, RGBA: 0, UNSIGNED_BYTE: 0,
    TEXTURE_MIN_FILTER: 0, TEXTURE_MAG_FILTER: 0,
    TEXTURE_WRAP_S: 0, TEXTURE_WRAP_T: 0,
    LINEAR: 0, CLAMP_TO_EDGE: 0,
    UNPACK_FLIP_Y_WEBGL: 0,
    TEXTURE0: 0,
    FRAMEBUFFER: 0,
  } as unknown as WebGL2RenderingContext;
}

function makeCtx(): VideoEngineContext {
  return {
    gl: makeFakeGl(),
    res: { width: 640, height: 360 },
    compileFragment: () => ({}) as WebGLProgram,
    createFbo: () => ({ fbo: {} as WebGLFramebuffer, texture: {} as WebGLTexture }),
    drawFullscreenQuad: () => undefined,
  };
}

function spawn(params: Record<string, number> = {}) {
  const node = {
    id: 'sb',
    type: 'scoreboard',
    domain: 'video',
    params,
    position: { x: 0, y: 0 },
  } as ModuleNode;
  return scoreboardDef.factory(makeCtx(), node);
}

/** Fire one gate pulse on a given param: rising edge (1) then release (0). */
function pulse(h: ReturnType<typeof spawn>, paramId: string) {
  h.setParam(paramId, 1);
  h.setParam(paramId, 0);
}

describe('scoreboardDef.factory — SCORE gate rising edge increments counter', () => {
  it('starts the counter at 0', () => {
    const h = spawn();
    expect(h.read?.('score')).toBe(0);
  });

  it('one rising edge on scoreTrig advances the counter by 1', () => {
    const h = spawn();
    pulse(h, 'scoreTrig');
    expect(h.read?.('score')).toBe(1);
  });

  it('counts two rising edges over a [0,0,1,1,0,1] sample sequence', () => {
    const h = spawn();
    const samples = [0, 0, 1, 1, 0, 1];
    for (const s of samples) h.setParam('scoreTrig', s);
    // Two LOW→HIGH transitions (indices 2 + 5). Two increments.
    expect(h.read?.('score')).toBe(2);
  });

  it('a held-high gate advances exactly ONCE (edge-triggered, not level)', () => {
    const h = spawn();
    h.setParam('scoreTrig', 1);
    h.setParam('scoreTrig', 1);
    h.setParam('scoreTrig', 1);
    expect(h.read?.('score')).toBe(1);
  });

  it('hysteresis: in-band noise (0.5) on a high gate does NOT chatter', () => {
    const h = spawn();
    h.setParam('scoreTrig', 1);   // go high
    h.setParam('scoreTrig', 0.5); // still high (above fall=0.4)
    h.setParam('scoreTrig', 0.5); // still high
    h.setParam('scoreTrig', 0.3); // now low (crossed fall<0.4)
    h.setParam('scoreTrig', 1);   // rising edge again
    expect(h.read?.('score')).toBe(2);
  });
});

describe('scoreboardDef.factory — wrap-at-10000 policy', () => {
  it('wraps from 9999 → 0 on the next SCORE pulse', () => {
    const h = spawn();
    // Drive the counter to 9999 directly via 9999 pulses would be slow
    // (and the test would clock at >10ms). Instead we step it past 9998
    // by issuing pulses, but cheaper: monkey-set the counter through a
    // verified path — we use bulk pulses and trust the per-pulse +1
    // increment behaviour proven above.
    for (let i = 0; i < 9999; i++) pulse(h, 'scoreTrig');
    expect(h.read?.('score')).toBe(9999);
    pulse(h, 'scoreTrig');
    expect(h.read?.('score')).toBe(0); // wrapped, not clamped
  });
});

describe('scoreboardDef.factory — RESET gate clears the counter to 0', () => {
  it('a RESET rising edge clears any counter value to 0', () => {
    const h = spawn();
    // Advance by 5.
    for (let i = 0; i < 5; i++) pulse(h, 'scoreTrig');
    expect(h.read?.('score')).toBe(5);
    pulse(h, 'resetTrig');
    expect(h.read?.('score')).toBe(0);
  });

  it('a held-high RESET fires once (same hysteresis as SCORE)', () => {
    const h = spawn();
    for (let i = 0; i < 3; i++) pulse(h, 'scoreTrig');
    h.setParam('resetTrig', 1);
    h.setParam('resetTrig', 1);
    h.setParam('resetTrig', 1);
    expect(h.read?.('score')).toBe(0);
    // A subsequent SCORE pulse still increments cleanly (the SCORE
    // detector is independent of the RESET detector).
    pulse(h, 'scoreTrig');
    expect(h.read?.('score')).toBe(1);
  });

  it('SCORE and RESET edge detectors are INDEPENDENT (one rearming does not affect the other)', () => {
    const h = spawn();
    h.setParam('scoreTrig', 1); // SCORE goes high (counter=1)
    h.setParam('resetTrig', 1); // RESET goes high (counter=0)
    h.setParam('resetTrig', 0); // RESET re-arms
    h.setParam('resetTrig', 1); // RESET rising edge again (counter=0, no change)
    expect(h.read?.('score')).toBe(0);
    // SCORE is still high (we never released it), so a release-then-press
    // is needed for the next increment.
    h.setParam('scoreTrig', 0);
    h.setParam('scoreTrig', 1);
    expect(h.read?.('score')).toBe(1);
  });
});

describe('scoreboardDef.factory — color knob', () => {
  it('readParam returns the default hue', () => {
    const h = spawn();
    expect(h.readParam('color')).toBeCloseTo(SCOREBOARD_DEFAULT_HUE, 5);
  });

  it('setParam updates the live color value', () => {
    const h = spawn();
    h.setParam('color', 0.75);
    expect(h.readParam('color')).toBe(0.75);
  });

  it('honours a persisted color from spawn-time node.params', () => {
    const h = spawn({ color: 0.6 });
    expect(h.readParam('color')).toBe(0.6);
  });

  it('exposes the live color via read("color")', () => {
    const h = spawn();
    h.setParam('color', 0.5);
    expect(h.read?.('color')).toBe(0.5);
  });
});
