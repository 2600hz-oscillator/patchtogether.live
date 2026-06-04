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
} from './b3ntb0x';
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
  SYNC_TIP_VOLTAGE,
  BLANK_VOLTAGE,
  REGION_SYNC,
  REGION_BLANK,
  REGION_BURST,
  REGION_ACTIVE,
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
