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
import { faceReadoutValueFor } from '$lib/ui/workflow/face-readout-values';

function reader(params: Record<string, number | undefined>) {
  return (id: string) => params[id];
}
const responseText = (p: Record<string, number | undefined>) =>
  faceReadoutValueFor('moog912-response-hz')!(reader(p));
const gateText = (p: Record<string, number | undefined>) =>
  faceReadoutValueFor('moog912-gate-dbfs')!(reader(p));

describe('moog912 face readouts — registration', () => {
  it('both valueIds the def declares RESOLVE in the shared registry', () => {
    const declared = (moog912Def.face?.hero?.readouts ?? []).map((r) => r.valueId);
    expect(declared).toEqual(['moog912-response-hz', 'moog912-gate-dbfs']);
    for (const id of declared) expect(typeof faceReadoutValueFor(id!)).toBe('function');
  });

  it('each registry entry wires THIS module\'s function, not merely SOME function', () => {
    for (const p of [{}, { sensitivity: 0.3 }, { smoothing: 0.9 }]) {
      expect(responseText(p)).toBe(moog912ResponseText(moog912FaceParams(reader(p))));
      expect(gateText(p)).toBe(moog912GateText(moog912FaceParams(reader(p))));
    }
    expect(responseText({})).not.toBe(gateText({}));
  });
});

describe('moog912-response-hz — the frequency a bare 0..1 dial cannot suggest', () => {
  it('prints 7.07 Hz at the shipped default, where the dial reads 0.50', () => {
    expect(moog912FaceParams(reader({})).smoothing).toBe(0.5);
    expect(responseText({})).toBe('7.07 Hz');
  });

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

  it('is INVARIANT to SENSITIVITY — the permanent negative control', () => {
    // If this ever starts tracking SENS it has stopped describing the filter.
    const base = responseText({ smoothing: 0.5, sensitivity: 0.7 });
    for (let i = 0; i <= 20; i++) {
      expect(responseText({ smoothing: 0.5, sensitivity: i / 20 })).toBe(base);
    }
  });
});

describe('moog912-gate-dbfs — the dead zone a SENS readback cannot see (#1914)', () => {
  it('prints the sustained threshold at the shipped default', () => {
    // Confirmed on a REAL rendered graph: the settled envelope lands on
    // 0.100001 against a threshold of 0.100000 at this sensitivity.
    expect(moog912FaceParams(reader({})).sensitivity).toBe(0.7);
    expect(moog912GateDbfs({ sensitivity: 0.7, smoothing: 0.5 })).toBeCloseTo(-12.980, 3);
    expect(gateText({})).toBe('-13.0 dBFS');
  });

  it('MOVES on SENS across the usable span', () => {
    expect(gateText({ sensitivity: 1 })).toBe('-16.1 dBFS');
    expect(gateText({ sensitivity: 0.5 })).toBe('-10.1 dBFS');
    expect(gateText({ sensitivity: 0.3 })).toBe('-5.6 dBFS');
  });

  it('⚠ PRINTS `—` BELOW THE DEAD-ZONE SENSITIVITY, where the gate is unreachable', () => {
    // THE FINDING. Below this the required input amplitude passes full scale, so
    // a dBFS number would be a promise the module cannot keep.
    expect(MOOG912_GATE_DEAD_SENS).toBeCloseTo(0.157080, 6);
    expect(gateText({ sensitivity: MOOG912_GATE_DEAD_SENS * 0.99 })).toBe('—');
    expect(gateText({ sensitivity: 0.1 })).toBe('—');
    expect(gateText({ sensitivity: 0 })).toBe('—');

    // ...and NOT a dash just above it — the leg that stops this passing for a
    // readout that always says `—`.
    expect(gateText({ sensitivity: MOOG912_GATE_DEAD_SENS * 1.05 })).not.toBe('—');
    expect(gateText({ sensitivity: 0.2 })).not.toBe('—');
  });

  it('the dead zone is exactly the bottom 15.71 % of the dial', () => {
    // Derived from the def's own declared range, not typed as a fraction.
    const p = moog912Def.params.find((q) => q.id === 'sensitivity')!;
    const frac = (MOOG912_GATE_DEAD_SENS - p.min) / (p.max - p.min);
    expect(frac).toBeCloseTo(0.157080, 5);
    // And the boundary is where the required amplitude is exactly full scale.
    expect(moog912GateDbfs({ sensitivity: MOOG912_GATE_DEAD_SENS, smoothing: 0.5 })).toBeCloseTo(0, 9);
  });

  it('is INVARIANT to SMOOTHING — the permanent negative control', () => {
    // The threshold is a level, not a time; if SMOOTH ever moves it, the
    // readout has started describing the wrong filter.
    const base = gateText({ sensitivity: 0.7, smoothing: 0.5 });
    for (let i = 0; i <= 20; i++) {
      expect(gateText({ sensitivity: 0.7, smoothing: i / 20 })).toBe(base);
    }
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
    it(`survives ${name} and prints a finite string`, () => {
      for (const s of [responseText(params), gateText(params)]) {
        expect(typeof s).toBe('string');
        expect(s.length).toBeGreaterThan(0);
        expect(s).not.toMatch(/NaN|Infinity|undefined/);
      }
    });
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
