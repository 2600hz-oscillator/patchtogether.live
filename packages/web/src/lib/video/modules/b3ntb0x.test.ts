// packages/web/src/lib/video/modules/b3ntb0x.test.ts
//
// Pure-DSP + module-def-shape coverage for B3NTB0X. The four GLSL passes are
// the renderer; the math they mirror lives in b3ntb0x-dsp.ts and is tested
// here in jsdom (no GL — jsdom can't exercise WebGL; the float-FBO + 4-pass
// correctness is covered by a real-GL ART/e2e harness). The headline test is
// the ENCODE -> DEMOD round-trip: a known (Y,I,Q) synthesized as a composite
// across an oversampled line and demodulated back by the SAME carrier phase
// recovers the input within the LP tolerance — proving the carrier math is a
// REAL, invertible signal path, not symbolic.

import { describe, expect, it } from 'vitest';
import {
  b3ntb0xDef,
  b3ntb0xMirrorGateTick,
  makeB3ntb0xMirrorGateState,
  B3NTB0X_SHADERS,
} from './b3ntb0x';
import type { VideoEngineContext } from '$lib/video/engine';
import type { ModuleNode } from '$lib/graph/types';
import {
  rgbToYiq,
  yiqToRgb,
  softClip,
  diodeClamp,
  asymSat,
  onePoleHP,
  acCoupleMix,
  enhancePeak,
  subcarrierPhase,
  encodeComposite,
  quadDemod,
  gaussianWeight,
  syncVoltageForColumn,
  regionTagForColumn,
  burstVoltage,
  b3ntb0xMirrorUv,
  b3ntb0xBurstStarve,
  BURST_STARVE_CRAWL,
  SYNC_TIP_VOLTAGE,
  BLANK_VOLTAGE,
  REGION_SYNC,
  REGION_BLANK,
  REGION_BURST,
  REGION_ACTIVE,
  b3ntb0xHueRotate,
  b3ntb0xDriftPhase,
  b3ntb0xBendFold,
  b3ntb0xBendComb,
  b3ntb0xBendCrush,
  b3ntb0xBendBleed,
  HUE_MAX_RAD,
  DRIFT_PHASE_GAIN,
} from './b3ntb0x-dsp';

describe('B3NTB0X colour-space round-trip', () => {
  it('round-trips primaries + greys within float tolerance', () => {
    const cases: Array<[number, number, number]> = [
      [1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 1], [0, 0, 0],
      [0.5, 0.5, 0.5], [0.2, 0.7, 0.3], [0.8, 0.1, 0.6],
    ];
    for (const [r, g, b] of cases) {
      const { y, i, q } = rgbToYiq(r, g, b);
      const back = yiqToRgb(y, i, q);
      expect(back.r).toBeCloseTo(r, 3);
      expect(back.g).toBeCloseTo(g, 3);
      expect(back.b).toBeCloseTo(b, 3);
    }
  });

  it('Y = luma for white, I = Q = 0', () => {
    const { y, i, q } = rgbToYiq(1, 1, 1);
    expect(y).toBeCloseTo(1, 3);
    expect(i).toBeCloseTo(0, 3);
    expect(q).toBeCloseTo(0, 3);
  });

  it('clamps out-of-gamut YIQ to [0,1]', () => {
    const rgb = yiqToRgb(2, 2, 2);
    for (const c of [rgb.r, rgb.g, rgb.b]) {
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(1);
    }
  });
});

describe('B3NTB0X encode -> quadrature demod round-trip (the proof point)', () => {
  // Synthesize a constant-(Y,I,Q) active line as a composite voltage across
  // an oversampled span, then demod by the SAME carrier phase + Gaussian LP.
  // A clean (no-bend) path must recover Y/I/Q within the LP tolerance.
  const PERIOD = 4; // oversampled px per subcarrier cycle (matches the module)
  const N = 6;
  const burstPhase = Math.PI; // 180deg reference

  function roundTrip(y: number, i: number, q: number): { y: number; i: number; q: number } {
    // Demod at a center column far enough in that the 13-tap window is valid.
    const center = 64;
    const samples: number[] = [];
    const phases: number[] = [];
    const weights: number[] = [];
    for (let k = -N; k <= N; k++) {
      const col = center + k;
      const phase = subcarrierPhase(col, PERIOD, burstPhase);
      samples.push(encodeComposite(y, i, q, phase));
      phases.push(phase);
      weights.push(gaussianWeight(k, N));
    }
    return quadDemod(samples, phases, weights);
  }

  it('recovers a pure-luma signal (I=Q=0)', () => {
    const out = roundTrip(0.6, 0, 0);
    expect(out.y).toBeCloseTo(0.6, 2);
    expect(out.i).toBeCloseTo(0, 1);
    expect(out.q).toBeCloseTo(0, 1);
  });

  it('recovers chroma (I,Q) by synchronous demod', () => {
    const out = roundTrip(0.5, 0.3, -0.2);
    expect(out.y).toBeCloseTo(0.5, 1);
    expect(out.i).toBeCloseTo(0.3, 1);
    expect(out.q).toBeCloseTo(-0.2, 1);
  });

  it('recovers a real RGB colour end-to-end (RGB->YIQ->encode->demod->RGB)', () => {
    const [r, g, b] = [0.7, 0.2, 0.4];
    const { y, i, q } = rgbToYiq(r, g, b);
    const dec = roundTrip(y, i, q);
    const back = yiqToRgb(dec.y, dec.i, dec.q);
    // LP + finite-window tolerance: a coarse but real recovery.
    expect(back.r).toBeCloseTo(r, 1);
    expect(back.g).toBeCloseTo(g, 1);
    expect(back.b).toBeCloseTo(b, 1);
  });
});

describe('B3NTB0X NTSC line geometry', () => {
  it('syncVoltageForColumn returns the sync tip below blanking', () => {
    expect(syncVoltageForColumn(0.0)).toBe(SYNC_TIP_VOLTAGE);
    expect(syncVoltageForColumn(0.04)).toBe(SYNC_TIP_VOLTAGE);
    expect(SYNC_TIP_VOLTAGE).toBeLessThan(BLANK_VOLTAGE);
  });

  it('syncVoltageForColumn returns blanking level for porches/active base', () => {
    expect(syncVoltageForColumn(0.09)).toBe(BLANK_VOLTAGE); // blanking
    expect(syncVoltageForColumn(0.5)).toBe(BLANK_VOLTAGE);  // active DC base
  });

  it('regionTagForColumn tags sync / blank / burst / active correctly', () => {
    expect(regionTagForColumn(0.01)).toBe(REGION_SYNC);
    expect(regionTagForColumn(0.085)).toBe(REGION_BLANK);
    expect(regionTagForColumn(0.12)).toBe(REGION_BURST);
    expect(regionTagForColumn(0.15)).toBe(REGION_BLANK); // back porch
    expect(regionTagForColumn(0.5)).toBe(REGION_ACTIVE);
  });

  it('burstVoltage starves to 0 amplitude at full Burst Starve', () => {
    const full = Math.abs(burstVoltage(0.3, 0));
    const starved = Math.abs(burstVoltage(0.3, 1));
    expect(full).toBeGreaterThan(0);
    expect(starved).toBeCloseTo(0, 6);
  });
});

describe('B3NTB0X bend-circuit nonlinearities', () => {
  it('softClip is monotonic + compressive for large inputs', () => {
    const xs = [-3, -2, -1, -0.5, 0, 0.5, 1, 2, 3];
    const ys = xs.map(softClip);
    for (let k = 1; k < ys.length; k++) expect(ys[k]!).toBeGreaterThan(ys[k - 1]!);
    for (const v of [-3, -1.5, 1.5, 3, 10]) {
      expect(Math.abs(softClip(v))).toBeLessThan(Math.abs(v));
    }
  });

  it('softClip is approximately identity for small inputs', () => {
    for (const v of [-0.1, 0, 0.1, 0.3]) expect(softClip(v)).toBeCloseTo(v, 1);
  });

  it('diodeClamp respects ceil/floor', () => {
    expect(diodeClamp(2, 1.4, -0.6)).toBe(1.4);
    expect(diodeClamp(-1, 1.4, -0.6)).toBe(-0.6);
    expect(diodeClamp(0.5, 1.4, -0.6)).toBe(0.5);
  });

  it('asymSat saturates the + and - halves differently', () => {
    // Heavier positive drive compresses the + half more than the - half.
    const pos = asymSat(0.8, 4, 1);
    const neg = asymSat(-0.8, 4, 1);
    expect(Math.abs(pos)).not.toBeCloseTo(Math.abs(neg), 2);
  });

  it('onePoleHP leaks the baseline toward the input (AC coupling)', () => {
    let b = 0;
    // Step input to 1.0; baseline should rise toward it over iterations.
    const seq: number[] = [];
    for (let k = 0; k < 50; k++) {
      const r = onePoleHP(1.0, b, 0.1);
      b = r.baseline;
      seq.push(b);
    }
    // Monotonic rise + still below the input (leaky, not instant).
    expect(seq[0]!).toBeLessThan(seq[49]!);
    expect(seq[49]!).toBeGreaterThan(0.9);
    expect(seq[49]!).toBeLessThan(1.0);
  });

  it('acCoupleMix passes DC through at coupling=0 and HPs at coupling=1', () => {
    // DC passthrough: out == v regardless of baseline.
    const dc = acCoupleMix(0.5, 0.2, 0);
    expect(dc.out).toBeCloseTo(0.5, 6);
    // Full AC: removes the (leaked) baseline -> smaller magnitude than v.
    const ac = acCoupleMix(0.5, 0.0, 1);
    expect(Math.abs(ac.out)).toBeLessThan(0.5);
  });

  it('enhancePeak sharpens against the neighbour average', () => {
    // A local peak (v above its neighbours) gets boosted; flat region unchanged.
    expect(enhancePeak(1.0, 0.5, 1)).toBeGreaterThan(1.0);
    expect(enhancePeak(0.5, 0.5, 1)).toBeCloseTo(0.5, 6);
  });
});

describe('B3NTB0X mirror fold geometry', () => {
  it('identity when both off', () => {
    for (const [u, v] of [[0.1, 0.2], [0.9, 0.8]] as const) {
      const o = b3ntb0xMirrorUv(u, v, false, false);
      expect(o.u).toBeCloseTo(u, 6);
      expect(o.v).toBeCloseTo(v, 6);
    }
  });
  it('MIRROR X folds the right half onto the left', () => {
    expect(b3ntb0xMirrorUv(0.8, 0.3, true, false).u).toBeCloseTo(0.2, 6);
    expect(b3ntb0xMirrorUv(0.2, 0.3, true, false).u).toBeCloseTo(0.2, 6);
  });
  it('MIRROR Y keeps the visual-top half (uv.y>=0.5)', () => {
    expect(b3ntb0xMirrorUv(0.3, 0.2, false, true).v).toBeCloseTo(0.8, 6);
    expect(b3ntb0xMirrorUv(0.3, 0.8, false, true).v).toBeCloseTo(0.8, 6);
  });
});

describe('B3NTB0X mirror gate edge detect', () => {
  it('fires only on the rising edge (hysteresis)', () => {
    const st = makeB3ntb0xMirrorGateState();
    expect(b3ntb0xMirrorGateTick(st.x, 0.0)).toBe(false);
    expect(b3ntb0xMirrorGateTick(st.x, 0.7)).toBe(true);
    expect(b3ntb0xMirrorGateTick(st.x, 0.9)).toBe(false);
    expect(b3ntb0xMirrorGateTick(st.x, 0.3)).toBe(false);
    expect(b3ntb0xMirrorGateTick(st.x, 0.7)).toBe(true);
  });
});

describe('B3NTB0X burst starve (decode colour-killer + subcarrier crawl)', () => {
  it('is the identity at burstStarve=0 (no kill, no crawl)', () => {
    const r = b3ntb0xBurstStarve(0.4, -0.3, 0);
    expect(r.i).toBeCloseTo(0.4, 6);
    expect(r.q).toBeCloseTo(-0.3, 6);
    expect(r.lumaCrawl).toBeCloseTo(0, 6);
  });

  it('fully kills chroma + crawls all subcarrier energy into luma at burstStarve=1', () => {
    const i = 0.4, q = -0.3;
    const r = b3ntb0xBurstStarve(i, q, 1);
    expect(r.i).toBeCloseTo(0, 6);
    expect(r.q).toBeCloseTo(0, 6);
    // crawl = (|i|+|q|) * 1 * BURST_STARVE_CRAWL
    expect(r.lumaCrawl).toBeCloseTo((Math.abs(i) + Math.abs(q)) * BURST_STARVE_CRAWL, 6);
  });

  it('is monotonic: more starve → less chroma, more luma crawl', () => {
    const i = 0.5, q = 0.2;
    let prevChroma = Infinity;
    let prevCrawl = -Infinity;
    for (const s of [0, 0.25, 0.5, 0.75, 1]) {
      const r = b3ntb0xBurstStarve(i, q, s);
      const chromaMag = Math.abs(r.i) + Math.abs(r.q);
      expect(chromaMag).toBeLessThanOrEqual(prevChroma + 1e-9);
      expect(r.lumaCrawl).toBeGreaterThanOrEqual(prevCrawl - 1e-9);
      prevChroma = chromaMag;
      prevCrawl = r.lumaCrawl;
    }
  });

  it('clamps out-of-range starve to [0,1]', () => {
    const lo = b3ntb0xBurstStarve(0.4, -0.3, -2);
    expect(lo.i).toBeCloseTo(0.4, 6); // clamped to 0 → identity
    expect(lo.lumaCrawl).toBeCloseTo(0, 6);
    const hi = b3ntb0xBurstStarve(0.4, -0.3, 5);
    expect(hi.i).toBeCloseTo(0, 6); // clamped to 1 → full kill
  });

  it('a grey (zero-chroma) signal has nothing to starve (no crawl, no change)', () => {
    const r = b3ntb0xBurstStarve(0, 0, 1);
    expect(r.i).toBeCloseTo(0, 6);
    expect(r.q).toBeCloseTo(0, 6);
    expect(r.lumaCrawl).toBeCloseTo(0, 6);
  });
});

describe('B3NTB0X module def shape', () => {
  it('declares the video-domain type', () => {
    expect(b3ntb0xDef.type).toBe('b3ntb0x');
    expect(b3ntb0xDef.domain).toBe('video');
    expect(b3ntb0xDef.category).toBe('output');
  });

  it('classifies itself as a Video Processor (palette)', () => {
    expect(b3ntb0xDef.palette).toEqual({ top: 'Video modules', sub: 'Processors' });
  });

  it('has a single video input + a single video output', () => {
    expect(b3ntb0xDef.inputs.find((p) => p.id === 'in' && p.type === 'video')).toBeTruthy();
    expect(b3ntb0xDef.outputs).toHaveLength(1);
    expect(b3ntb0xDef.outputs[0]!.id).toBe('out');
    expect(b3ntb0xDef.outputs[0]!.type).toBe('video');
  });

  it('every CV input has a matching paramTarget that exists in params', () => {
    const paramIds = new Set(b3ntb0xDef.params.map((p) => p.id));
    for (const port of b3ntb0xDef.inputs) {
      if (port.type === 'cv') {
        expect(port.paramTarget, port.id).toBeDefined();
        expect(paramIds.has(port.paramTarget!), `${port.id} -> ${port.paramTarget}`).toBe(true);
      }
    }
  });

  it('continuous CV inputs carry cvScale:linear; mirror gates omit it', () => {
    for (const port of b3ntb0xDef.inputs) {
      if (port.type !== 'cv') continue;
      if (port.id === 'mirror_x_gate' || port.id === 'mirror_y_gate') {
        expect(port.cvScale, port.id).toBeUndefined();
      } else {
        expect(port.cvScale, port.id).toEqual({ mode: 'linear' });
      }
    }
  });

  it('exposes mirror_x_gate / mirror_y_gate as raw gate inputs', () => {
    for (const [pid, target] of [
      ['mirror_x_gate', 'mirrorXGate'],
      ['mirror_y_gate', 'mirrorYGate'],
    ] as const) {
      const g = b3ntb0xDef.inputs.find((p) => p.id === pid);
      expect(g, pid).toBeDefined();
      expect(g?.type).toBe('cv');
      expect(g?.cvScale).toBeUndefined();
      expect(g?.paramTarget).toBe(target);
    }
  });

  it('default params land within their declared ranges', () => {
    for (const p of b3ntb0xDef.params) {
      if (typeof p.min === 'number') expect(p.defaultValue, p.id).toBeGreaterThanOrEqual(p.min);
      if (typeof p.max === 'number') expect(p.defaultValue, p.id).toBeLessThanOrEqual(p.max);
    }
  });

  it('bend A-D are bipolar -1..1 with identity default 0 (P1 stub)', () => {
    const byId = new Map(b3ntb0xDef.params.map((p) => [p.id, p]));
    for (const id of ['bend_a', 'bend_b', 'bend_c', 'bend_d']) {
      const p = byId.get(id)!;
      expect(p.min).toBe(-1);
      expect(p.max).toBe(1);
      expect(p.defaultValue).toBe(0);
    }
  });

  it('TBC/Lock defaults to rock-steady (1) so a fresh patch is stable', () => {
    const tbc = b3ntb0xDef.params.find((p) => p.id === 'tbc')!;
    expect(tbc.defaultValue).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// PARAM-MUTATION WIRING — downgraded from b3ntb0x.spec.ts test 3 ("CV-bending
// knobs mutate params via the patch store"), webgl-suite-optimization §1/§2/§7-3.
// The e2e only wrote node.params into the store and read them BACK from the store
// — it never touched the engine (a pure store round-trip, no GL/engine
// assertion). This drives the REAL b3ntb0xDef factory's setParam hot-path (what
// the CV bridge calls each frame) and reads it back via readParam, with no render
// and no GPU boot, so a broken setParam wiring fails this fast unit test. (b3ntb0x
// is VRT-EXEMPT + per-port-exempt: t1 — structured non-black decode — and t2 —
// bend-mangles-output, the 4-pass NTSC proof — stay in b3ntb0x.spec as the ONLY
// GL pixel gates, per plan §1/§6.)
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
    res: { width: 1024, height: 768 },
    compileFragment: () => ({}) as WebGLProgram,
    createFbo: () => ({ fbo: {} as WebGLFramebuffer, texture: {} as WebGLTexture }),
    createFloatFbo: () => ({ fbo: {} as WebGLFramebuffer, texture: {} as WebGLTexture, isFloat: false, width: 1024, height: 768 }),
    drawFullscreenQuad: () => undefined,
  };
}

describe('B3NTB0X factory setParam propagates to the live engine param', () => {
  it('setParam(sync_crush/enhance/bend_a) updates the engine readback', () => {
    const node = {
      id: 'bb', type: 'b3ntb0x', domain: 'video', position: { x: 0, y: 0 }, params: {},
    } as unknown as ModuleNode;
    const handle = b3ntb0xDef.factory(makeCtx(), node);
    try {
      // Defaults before any drive (sync_crush default 1, enhance 0, bend_a 0).
      expect(handle.readParam?.('sync_crush')).toBe(1);
      expect(handle.readParam?.('enhance')).toBe(0);
      expect(handle.readParam?.('bend_a')).toBe(0);

      // The e2e's exact drive (CV-bend knobs).
      handle.setParam?.('sync_crush', 1.7);
      handle.setParam?.('enhance', 0.6);
      handle.setParam?.('bend_a', -0.5);

      expect(handle.readParam?.('sync_crush'), 'sync_crush propagated').toBe(1.7);
      expect(handle.readParam?.('enhance'), 'enhance propagated').toBe(0.6);
      expect(handle.readParam?.('bend_a'), 'bend_a propagated').toBe(-0.5);
    } finally {
      handle.dispose();
    }
  });
});

// ===========================================================================
// LIVE-CONTROLS AUDIT (owner: "a bunch of controls don't seem to do much").
// Two layers:
//   (A) CPU-mirror behaviour: each previously-dead/weak control's math, at min
//       vs max, yields a DIFFERENT result (proves the effect is real + non-
//       trivial). These mirror the exact GLSL inlined in b3ntb0x.ts.
//   (B) param→uniform WIRING guard: every control's uniform is not just
//       declared but CONSUMED in its pass body, and no uniform is multiplied
//       out by a literal 0 (the old `* 0.0` Bend stub). A static-source guard.
// ===========================================================================

describe('B3NTB0X HUE — receiver tint (decode-side demod-axis rotation)', () => {
  it('is the identity at hue=0 (no tint shift)', () => {
    const r = b3ntb0xHueRotate(0.4, -0.3, 0);
    expect(r.i).toBeCloseTo(0.4, 6);
    expect(r.q).toBeCloseTo(-0.3, 6);
  });

  it('rotates the chroma vector (min vs max give DIFFERENT colour angles)', () => {
    const i = 0.5, q = 0.0;
    const lo = b3ntb0xHueRotate(i, q, -1);
    const hi = b3ntb0xHueRotate(i, q, 1);
    // The two extremes must land at clearly different (I,Q) → different hue.
    const d = Math.hypot(hi.i - lo.i, hi.q - lo.q);
    expect(d).toBeGreaterThan(0.3);
    // And neither extreme equals the unrotated input (it actually moved).
    expect(Math.hypot(lo.i - i, lo.q - q)).toBeGreaterThan(0.1);
    expect(Math.hypot(hi.i - i, hi.q - q)).toBeGreaterThan(0.1);
  });

  it('preserves saturation (pure rotation: |I,Q| unchanged)', () => {
    const i = 0.3, q = 0.4; // magnitude 0.5
    for (const h of [-1, -0.5, 0.5, 1]) {
      const r = b3ntb0xHueRotate(i, q, h);
      expect(Math.hypot(r.i, r.q)).toBeCloseTo(0.5, 5);
    }
  });

  it('uses HUE_MAX_RAD as the ±1 swing (matches the GLSL constant)', () => {
    const r = b3ntb0xHueRotate(1, 0, 1);
    expect(r.i).toBeCloseTo(Math.cos(HUE_MAX_RAD), 6);
    expect(r.q).toBeCloseTo(Math.sin(HUE_MAX_RAD), 6);
  });
});

describe('B3NTB0X SUBCARRIER DRIFT — phase error vs the burst lock', () => {
  it('is zero at drift=0 (no error → cancels, picture is clean)', () => {
    for (const f of [0, 0.5, 1]) {
      for (const t of [0, 1, 5]) {
        expect(b3ntb0xDriftPhase(f, t, 0)).toBeCloseTo(0, 9);
      }
    }
  });

  it('min vs max drift give a DIFFERENT phase error (non-trivial effect)', () => {
    const lo = b3ntb0xDriftPhase(0.5, 1, 0);
    const hi = b3ntb0xDriftPhase(0.5, 1, 1);
    expect(Math.abs(hi - lo)).toBeGreaterThan(1); // > a radian of slip
  });

  it('grows across the active line (rainbow swims left→right)', () => {
    const left = b3ntb0xDriftPhase(0.0, 0, 1);
    const right = b3ntb0xDriftPhase(1.0, 0, 1);
    expect(right).toBeGreaterThan(left + 1); // a full picture-width of slip
  });

  it('wanders in time (animated)', () => {
    const t0 = b3ntb0xDriftPhase(0.5, 0, 1);
    const t1 = b3ntb0xDriftPhase(0.5, 1, 1);
    expect(Math.abs(t1 - t0)).toBeGreaterThan(0.1);
  });
});

describe('B3NTB0X BEND NETWORK A–D — each tap is a real, distinct distortion', () => {
  it('A WAVEFOLD: identity at 0, folds at min/max (different from input + each other)', () => {
    const v = 0.8;
    expect(b3ntb0xBendFold(v, 0)).toBeCloseTo(v, 6);
    const lo = b3ntb0xBendFold(v, -1);
    const hi = b3ntb0xBendFold(v, 1);
    expect(Math.abs(lo - v)).toBeGreaterThan(0.05);
    expect(Math.abs(hi - v)).toBeGreaterThan(0.05);
    // Sign matters: −1 and +1 fold differently.
    expect(Math.abs(hi - lo)).toBeGreaterThan(0.01);
  });

  it('B COMB RIPPLE: identity at 0, mixes the delayed tap at min/max', () => {
    const v = 0.2, vDelayed = 0.9;
    expect(b3ntb0xBendComb(v, vDelayed, 0)).toBeCloseTo(v, 6);
    const hi = b3ntb0xBendComb(v, vDelayed, 1);
    const lo = b3ntb0xBendComb(v, vDelayed, -1);
    expect(hi).not.toBeCloseTo(v, 3);
    expect(lo).not.toBeCloseTo(v, 3);
    expect(hi).not.toBeCloseTo(lo, 3);
  });

  it('C CRUSH: ~identity at 0, quantises hard at max (snaps to few steps)', () => {
    const v = 0.123456;
    expect(b3ntb0xBendCrush(v, 0)).toBeCloseTo(v, 6);
    const crushed = b3ntb0xBendCrush(v, 1);
    // 3 steps at max → value lands on a 1/3 grid, clearly != the raw value.
    expect(Math.abs(crushed - v)).toBeGreaterThan(0.01);
    expect(crushed * 3).toBeCloseTo(Math.round(crushed * 3), 6);
  });

  it('D CHROMA→SYNC BLEED: identity at 0, injects ripple at min/max', () => {
    const v = 0.5, ripple = 0.3;
    expect(b3ntb0xBendBleed(v, ripple, 0)).toBeCloseTo(v, 6);
    const hi = b3ntb0xBendBleed(v, ripple, 1);
    const lo = b3ntb0xBendBleed(v, ripple, -1);
    expect(hi).toBeGreaterThan(v);
    expect(lo).toBeLessThan(v);
  });

  it('the four taps are NOT the same function (each does something distinct)', () => {
    const v = 0.6, side = 0.1, ripple = 0.2;
    const outs = [
      b3ntb0xBendFold(v, 0.8),
      b3ntb0xBendComb(v, side, 0.8),
      b3ntb0xBendCrush(v, 0.8),
      b3ntb0xBendBleed(v, ripple, 0.8),
    ];
    const uniq = new Set(outs.map((x) => x.toFixed(4)));
    expect(uniq.size, 'all four bend taps produce distinct results').toBe(4);
  });
});

// ===========================================================================
// PARAM → UNIFORM WIRING GUARD. For EVERY param (except mirror gates, which
// drive a CPU edge-detect, not a uniform) assert the uniform it feeds is
// referenced in its pass body MORE than once (a declaration + at least one
// real use), and that NO uniform is killed by a literal-0 multiply. This is
// the regression guard for the owner's "dead control" class of bug.
// ===========================================================================

describe('B3NTB0X param→uniform wiring (no dead controls)', () => {
  // param id → { uniform name, which pass shader(s) must CONSUME it }.
  const WIRING: Record<string, { uniform: string; shaders: Array<keyof typeof B3NTB0X_SHADERS> }> = {
    enhance:      { uniform: 'uEnhance',    shaders: ['bend'] },
    bias:         { uniform: 'uBias',       shaders: ['bend'] },
    ac_dc:        { uniform: 'uAcDc',       shaders: ['bend'] },
    sync_crush:   { uniform: 'uSyncCrush',  shaders: ['bend'] },
    bend_a:       { uniform: 'uBendA',      shaders: ['bend'] },
    bend_b:       { uniform: 'uBendB',      shaders: ['bend'] },
    bend_c:       { uniform: 'uBendC',      shaders: ['bend'] },
    bend_d:       { uniform: 'uBendD',      shaders: ['bend'] },
    burst_starve: { uniform: 'uBurstStarve', shaders: ['encode', 'decode'] },
    chroma_leak:  { uniform: 'uChromaLeak', shaders: ['decode'] },
    luma_peak:    { uniform: 'uLumaPeak',   shaders: ['decode'] },
    tbc:          { uniform: 'uTbc',        shaders: ['decode'] },
    hue:          { uniform: 'uHue',        shaders: ['decode'] },
    sub_drift:    { uniform: 'uSubDrift',   shaders: ['encode'] },
    feedback:     { uniform: 'uFeedback',   shaders: ['crt'] },
    tube_bloom:   { uniform: 'uTubeBloom',  shaders: ['crt'] },
    overscan:     { uniform: 'uOverscan',   shaders: ['crt'] },
    barrel:       { uniform: 'uBarrel',     shaders: ['crt'] },
    mirrorX:      { uniform: 'uMirrorX',    shaders: ['crt'] },
    mirrorY:      { uniform: 'uMirrorY',    shaders: ['crt'] },
  };

  it('every continuous/visual param maps to a uniform consumed in its pass', () => {
    for (const [pid, { uniform, shaders }] of Object.entries(WIRING)) {
      for (const s of shaders) {
        const src = B3NTB0X_SHADERS[s];
        const decl = `uniform float ${uniform};`;
        expect(src.includes(decl), `${pid}: ${uniform} declared in ${s}`).toBe(true);
        // It must be REFERENCED in the body beyond its declaration → >1 hit.
        const hits = src.split(uniform).length - 1;
        expect(hits, `${pid}: ${uniform} used in ${s} body (hits=${hits})`).toBeGreaterThan(1);
      }
    }
  });

  it('NO uniform is multiplied out by a literal 0 (the dead-stub pattern)', () => {
    // The original Bend stub was `(uBendA + uBendB + uBendC + uBendD) * 0.0;`.
    // Flag any `<uniform> * 0[.0…]` (direct) — and the exact old group-stub line.
    // (Matches `* 0`, `* 0.`, `* 0.0`, `* 0.000` but NOT `* 0.5`/`* 0.05` — the
    // decimal part, if present, must be all zeros.)
    const zeroMul = (u: string) => new RegExp(`${u}\\s*\\*\\s*0(\\.0*)?(?![.0-9])`);
    for (const { uniform } of Object.values(WIRING)) {
      for (const src of Object.values(B3NTB0X_SHADERS)) {
        expect(zeroMul(uniform).test(src), `${uniform} not multiplied by 0`).toBe(false);
      }
    }
    // Belt-and-suspenders: the exact old dead-stub line is gone.
    expect(B3NTB0X_SHADERS.bend.includes('uBendD) * 0.0')).toBe(false);
    expect(B3NTB0X_SHADERS.bend.includes('* 0.0;')).toBe(false);
  });

  it('every visual param id (minus mirror gates) appears in the wiring table', () => {
    const gateOnly = new Set(['mirrorXGate', 'mirrorYGate']);
    for (const p of b3ntb0xDef.params) {
      if (gateOnly.has(p.id)) continue;
      expect(Object.keys(WIRING), `${p.id} is covered by the wiring guard`).toContain(p.id);
    }
  });

  it('mirror GATES drive the CPU edge-detect (not a uniform) — covered separately', () => {
    // mirrorXGate/mirrorYGate have NO uniform: they tick b3ntb0xMirrorGateTick
    // which flips mirrorX/mirrorY (whose uniforms ARE guarded above). Assert the
    // gate params exist + are excluded from the uniform table on purpose.
    for (const g of ['mirrorXGate', 'mirrorYGate']) {
      expect(b3ntb0xDef.params.find((p) => p.id === g), g).toBeDefined();
    }
  });
});

// ===========================================================================
// FACTORY SMOKE — drive every param through setParam/readParam (the CV hot
// path) so a broken wiring of ANY control fails fast, GPU-free.
// ===========================================================================

describe('B3NTB0X factory accepts + round-trips EVERY param', () => {
  it('setParam/readParam survives a sweep of every declared param', () => {
    const node = {
      id: 'bb', type: 'b3ntb0x', domain: 'video', position: { x: 0, y: 0 }, params: {},
    } as unknown as ModuleNode;
    const handle = b3ntb0xDef.factory(makeCtx(), node);
    try {
      for (const p of b3ntb0xDef.params) {
        const mid = ((p.min ?? 0) + (p.max ?? 1)) / 2 || 0.5;
        handle.setParam?.(p.id, mid);
        expect(handle.readParam?.(p.id), `${p.id} round-trips`).toBe(mid);
      }
    } finally {
      handle.dispose();
    }
  });
});

// ===========================================================================
// REGRESSION: HUE + DRIFT must NOT cancel (the bug the owner reported). The
// old encode applied hue/drift to BOTH the carrier AND the burst reference the
// decoder locks to, so a clean encode→demod round-trip recovered the input
// unchanged → the controls did nothing. Prove the new wiring is non-cancelling.
// ===========================================================================

describe('B3NTB0X HUE/DRIFT no-cancel regression (the owner-reported bug)', () => {
  it('HUE is applied DECODE-side so it cannot cancel an encode carrier shift', () => {
    // Encode carrier phase no longer carries hue (it would cancel in demod);
    // the decode shader rotates the recovered I/Q by uHue instead.
    expect(B3NTB0X_SHADERS.encode.includes('uHue'), 'hue NOT in encode').toBe(false);
    expect(B3NTB0X_SHADERS.decode.includes('uHue'), 'hue IS in decode').toBe(true);
    // A non-zero hue actually moves a coloured pixel (CPU mirror of the demod
    // rotation): the recovered chroma is rotated, so the output colour changes.
    const moved = b3ntb0xHueRotate(0.4, 0.2, 0.7);
    expect(Math.hypot(moved.i - 0.4, moved.q - 0.2)).toBeGreaterThan(0.05);
  });

  it('DRIFT phase error is NOT folded into the burst reference (B channel)', () => {
    // The encode writes the BURST-LOCKED refPhase to B (phaseRef = fract(refPhase
    // /…)), and modulates the picture on refPhase + driftErr → the decoder
    // (demods by B) sees the slip. Guard the source shape so a refactor can't
    // silently re-fold drift into the reference (which would re-introduce the
    // cancel bug).
    const src = B3NTB0X_SHADERS.encode;
    expect(src.includes('phaseRef = fract(refPhase'), 'B = clean refPhase').toBe(true);
    expect(src.includes('cos(carrierPhase)'), 'picture on DRIFTED carrier').toBe(true);
    expect(DRIFT_PHASE_GAIN, 'drift gain is meaningful (> a radian/line)').toBeGreaterThan(1);
  });
});
