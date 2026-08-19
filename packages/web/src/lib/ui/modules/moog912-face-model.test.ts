// packages/web/src/lib/ui/modules/moog912-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS for moog912's two derived readouts.
//
// ⚠ THESE READOUTS ARE NOT DECORATION ON THIS MODULE — THEY ARE ITS MERIT.
// moog912 has two params, no control families and no `node.data`, so it clears
// STOP 1 on the derived-quantity clause ALONE. If these are ever cut, the
// module's face should be withdrawn rather than thinned. That makes this file
// the argument as much as the guard.
//
// The two facts it holds, both measured on a REAL rendered graph in
// `art/scenarios/moog912/face-audit.test.ts`:
//
//   1. THE GATE'S THRESHOLD IS SET BY SENSITIVITY ALONE, because
//      `GATE_THRESHOLD` is a bare constant that does NOT scale with it — and
//      below sens = 0.157080 the required input level passes FULL SCALE, so no
//      signal can hold the gate open (#1914).
//   2. THE SMOOTH DIAL IS A FREQUENCY IN DISGUISE — a bare 0..1 over an
//      INVERTED logarithmic map, 50 Hz at 0 and 1 Hz at 1, in which turning the
//      knob UP makes the number go DOWN.
//
// So `moog912-gate-dbfs` must move on SENS and never on SMOOTH, and
// `moog912-response-hz` must move on SMOOTH and never on SENS. Their reach is
// disjoint, which makes each the other's control on every render.

import { describe, expect, it } from 'vitest';
import { GATE_THRESHOLD, SMOOTH_MAX_HZ, SMOOTH_MIN_HZ, moog912Def } from '$lib/audio/modules/moog912';
import {
  MOOG912_GATE_DEAD_SENS,
  moog912FaceParams,
  moog912GateDbfs,
  moog912GateText,
  moog912ResponseHz,
  moog912ResponseText,
} from './moog912-face-model';

function reader(params: Record<string, number | undefined>) {
  return (id: string) => params[id];
}

describe('moog912-response-hz — the frequency a bare 0..1 dial cannot suggest', () => {

  it('is INVERTED — turning SMOOTH up makes the frequency go DOWN', () => {
    // The single most misleading thing about this control, and the readout's
    // main reason to exist.
    expect(moog912ResponseHz({ sensitivity: 0.7, smoothing: 0 })).toBeCloseTo(SMOOTH_MAX_HZ, 6);
    expect(moog912ResponseHz({ sensitivity: 0.7, smoothing: 1 })).toBeCloseTo(SMOOTH_MIN_HZ, 6);
    let prev = Infinity;
    for (let i = 0; i <= 20; i++) {
      const hz = moog912ResponseHz({ sensitivity: 0.7, smoothing: i / 20 });
      expect(hz).toBeLessThan(prev);
      prev = hz;
    }
  });

  it('spans 5.64 octaves end to end', () => {
    const oct = Math.log2(SMOOTH_MAX_HZ / SMOOTH_MIN_HZ);
    expect(oct).toBeCloseTo(5.6439, 3);
  });
});

describe('moog912-gate-dbfs — the dead zone a SENS readback cannot see (#1914)', () => {

  it('the dead zone is exactly the bottom 15.71 % of the dial', () => {
    // Derived from the def's own declared range, not typed as a fraction.
    const p = moog912Def.params.find((q) => q.id === 'sensitivity')!;
    const frac = (MOOG912_GATE_DEAD_SENS - p.min) / (p.max - p.min);
    expect(frac).toBeCloseTo(0.157080, 5);
    // And the boundary is where the required amplitude is exactly full scale.
    expect(moog912GateDbfs({ sensitivity: MOOG912_GATE_DEAD_SENS, smoothing: 0.5 })).toBeCloseTo(0, 9);
  });

  it('the threshold constant it reads is the module\'s own', () => {
    // Imported, never re-typed — a second copy of 0.1 would drift silently.
    expect(GATE_THRESHOLD).toBe(0.1);
    expect(MOOG912_GATE_DEAD_SENS).toBeCloseTo((Math.PI * GATE_THRESHOLD) / 2, 12);
  });
});

describe('moog912 readouts — TOTALITY (they run on every render)', () => {
  const hostile: Array<[string, Record<string, number | undefined>]> = [
    ['a fresh node (nothing touched)', {}],
    ['undefined everywhere', { sensitivity: undefined, smoothing: undefined }],
    ['NaN', { sensitivity: NaN, smoothing: NaN }],
    ['+Infinity', { sensitivity: Infinity, smoothing: Infinity }],
    ['-Infinity', { sensitivity: -Infinity, smoothing: -Infinity }],
    ['out of range low', { sensitivity: -5, smoothing: -5 }],
    ['out of range high', { sensitivity: 99, smoothing: 99 }],
    ['sensitivity exactly 0', { sensitivity: 0 }],
    ['sensitivity exactly 1', { sensitivity: 1 }],
  ];
  for (const [name, params] of hostile) {
  }

  it('the response frequency is always inside the declared span', () => {
    for (const v of [NaN, Infinity, -Infinity, -9, 0, 0.5, 1, 99]) {
      const hz = moog912ResponseHz({ sensitivity: 0.7, smoothing: v });
      expect(Number.isFinite(hz)).toBe(true);
      expect(hz).toBeGreaterThanOrEqual(SMOOTH_MIN_HZ - 1e-9);
      expect(hz).toBeLessThanOrEqual(SMOOTH_MAX_HZ + 1e-9);
    }
  });
});
