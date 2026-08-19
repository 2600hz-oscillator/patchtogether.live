// packages/web/src/lib/ui/modules/moog911a-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS for moog911a's two derived readouts.
//
// The face rests on two claims, and each is checked against the input a KNOB
// READBACK WOULD BE BLIND TO, permanently:
//
//   `max rate`  is `1/delay1` — the clock ABOVE WHICH THE OUTPUT IS SILENT.
//               It must be invariant to DELAY 2 and to MODE. That invariance is
//               what makes it the other readout's control rather than a second
//               copy of it.
//   `last out`  needs all THREE params, because MODE decides which outputs fire
//               at all. It must MOVE when MODE moves with both dials held —
//               100 / 100 / 200 ms across OFF / PARALLEL / SERIES at the
//               shipped defaults, and 100 / 500 / 600 ms once DELAY 2 is 0.5 s,
//               which is the three-way split no single dial can show.
//
// Both directions on every leg: a probe that cannot move is indistinguishable
// from one reading the wrong thing.
//
// ⚠ WHAT THIS FILE CANNOT SEE. These are closed forms; a unit test over them
// proves only self-consistency. That they describe the SHIPPING DSP — the cliff,
// the mode gating, the exact delays — is answered by driving the real worklet in
// `art/scenarios/moog911a/face-audit.test.ts`.

import { describe, expect, it } from 'vitest';
import {
  fmtDelayMs,
  fmtRateHz,
  moog911aFaceParams,
  moog911aLastOutMs,
  moog911aLastOutText,
  moog911aMaxRateHz,
  moog911aMaxRateText,
  moog911aModeIndex,
  moog911aModeName,
} from './moog911a-face-model';
import { moog911aDef, MOOG911A_MODE_NAMES } from '$lib/audio/modules/moog911a';
import { faceReadoutValueFor } from '$lib/ui/workflow/face-readout-values';

function reader(patch: Record<string, number> = {}) {
  return (id: string): number | undefined => patch[id];
}
const P = (patch: Record<string, number> = {}) => moog911aFaceParams(reader(patch));

describe('moog911a face model — defaults track the def', () => {
  it('every default the model assumes IS the def default (anchored, not copied)', () => {
    const p = P();
    for (const id of ['delay1', 'delay2', 'mode'] as const) {
      const declared = moog911aDef.params.find((q) => q.id === id);
      expect(declared, `${id} must be a declared param of moog911aDef`).toBeDefined();
      expect(p[id], `${id} default`).toBe(declared!.defaultValue);
    }
  });

  it('at the shipped defaults the readouts print 10.0 Hz and 100.0 ms', () => {
    // The rate is the measured cliff: a 9.9 Hz clock passes 29 of 30 triggers
    // and a 10 Hz clock passes NONE (bisected on the worklet to 9.998958 Hz).
    expect(moog911aMaxRateHz(P())).toBeCloseTo(10, 9);
    expect(moog911aMaxRateText(P())).toBe('10.0 Hz');
    expect(moog911aLastOutMs(P())).toBeCloseTo(100, 9);
    expect(moog911aLastOutText(P())).toBe('100 ms');
  });
});

describe('moog911a `max rate` — the number no dial prints, and the other readout\'s control', () => {
  it('tracks 1/delay1 across the whole declared travel', () => {
    const { min, max } = moog911aDef.params.find((q) => q.id === 'delay1')!;
    expect(moog911aMaxRateHz(P({ delay1: min }))).toBeCloseTo(500, 6);
    expect(moog911aMaxRateText(P({ delay1: min }))).toBe('500 Hz');
    expect(moog911aMaxRateHz(P({ delay1: max }))).toBeCloseTo(0.1, 9);
    expect(moog911aMaxRateText(P({ delay1: max }))).toBe('0.1 Hz');
  });

  it('⚠ is EXACTLY invariant to DELAY 2 and to MODE', () => {
    const base = moog911aMaxRateHz(P());
    for (const delay2 of [0.002, 0.5, 10]) {
      expect(moog911aMaxRateHz(P({ delay2 })), `delay2=${delay2}`).toBe(base);
    }
    for (const mode of [0, 1, 2]) {
      expect(moog911aMaxRateHz(P({ mode })), `mode=${mode}`).toBe(base);
    }
  });

  it('…and DELAY 1 does move it, so the invariance above is not a dead probe', () => {
    expect(moog911aMaxRateHz(P({ delay1: 0.002 }))).toBeGreaterThan(moog911aMaxRateHz(P()) * 4);
    expect(moog911aMaxRateHz(P({ delay1: 10 }))).toBeLessThan(moog911aMaxRateHz(P()) / 4);
  });
});

describe('moog911a `last out` — NEGATIVE CONTROL on MODE, the dial that re-routes it', () => {
  it('MODE moves it while NEITHER delay dial moves', () => {
    // At the shipped defaults the three modes give 100 / 100 / 200 ms.
    expect(moog911aLastOutMs(P({ mode: 0 }))).toBeCloseTo(100, 9);
    expect(moog911aLastOutMs(P({ mode: 1 }))).toBeCloseTo(100, 9);
    expect(moog911aLastOutMs(P({ mode: 2 }))).toBeCloseTo(200, 9);
    // …and the dials a reader would have looked at are identical at all three.
    expect(P({ mode: 0 }).delay1).toBe(P({ mode: 2 }).delay1);
    expect(P({ mode: 0 }).delay2).toBe(P({ mode: 2 }).delay2);
  });

  it('with DELAY 2 longer, the three modes separate COMPLETELY — 100 / 500 / 600 ms', () => {
    // This is the leg that shows `last out` is a JOIN and not a relabelled
    // knob: no single dial position distinguishes these three, and the OFF
    // answer is not even a function of delay2 at all.
    const at = (mode: number) => moog911aLastOutMs(P({ delay2: 0.5, mode }));
    expect(at(0)).toBeCloseTo(100, 9);
    expect(at(1)).toBeCloseTo(500, 9);
    expect(at(2)).toBeCloseTo(600, 9);
    expect(new Set([at(0), at(1), at(2)]).size).toBe(3);
  });

  it('⚠ in OFF it is invariant to DELAY 2 — because OUT 2 never fires from TRIG 1 there', () => {
    // Measured on the shipping worklet: a trigger on TRIG 1 in OFF gives one
    // pulse on out1 and ZERO on out2. A "last out" that moved with delay2 in
    // OFF would be describing an output that does not fire.
    const base = moog911aLastOutMs(P({ mode: 0 }));
    for (const delay2 of [0.002, 0.5, 10]) {
      expect(moog911aLastOutMs(P({ mode: 0, delay2 })), `delay2=${delay2}`).toBe(base);
    }
    // …and in the other two modes it is NOT invariant, which is the control.
    expect(moog911aLastOutMs(P({ mode: 1, delay2: 10 }))).not.toBe(
      moog911aLastOutMs(P({ mode: 1, delay2: 0.002 })),
    );
    expect(moog911aLastOutMs(P({ mode: 2, delay2: 10 }))).not.toBe(
      moog911aLastOutMs(P({ mode: 2, delay2: 0.002 })),
    );
  });

  it('PARALLEL takes the LONGER leg, not the sum — the two are distinguishable', () => {
    const p = { delay1: 0.1, delay2: 0.4 };
    expect(moog911aLastOutMs(P({ ...p, mode: 1 }))).toBeCloseTo(400, 9);
    expect(moog911aLastOutMs(P({ ...p, mode: 2 }))).toBeCloseTo(500, 9);
  });
});

describe('moog911a MODE names — the vocabulary promotion would have deleted', () => {
  it('the def now declares the roster the card used to own alone', () => {
    const mode = moog911aDef.params.find((q) => q.id === 'mode')!;
    expect(mode.curve, 'options requires a discrete curve').toBe('discrete');
    expect(mode.options?.map((o) => o.label)).toEqual([...MOOG911A_MODE_NAMES]);
    expect(mode.options?.map((o) => o.value)).toEqual([0, 1, 2]);
    // Every option is a value the param can actually take.
    for (const o of mode.options ?? []) {
      expect(o.value).toBeGreaterThanOrEqual(mode.min);
      expect(o.value).toBeLessThanOrEqual(mode.max);
    }
  });

  it('⚠ the boundaries are Math.round, mirroring the WORKLET and not the core', () => {
    // The pure core clamps `mode <= 0 … mode >= 2`, which would put PARALLEL
    // across the whole open interval. The worklet rounds first, so these are
    // the boundaries the shipping module actually has (bisected on it:
    // 0.4999999851 and 1.4999999404) and the ones the legacy card prints.
    expect(moog911aModeName(0)).toBe('OFF');
    expect(moog911aModeName(0.49)).toBe('OFF');
    expect(moog911aModeName(0.51)).toBe('PARALLEL');
    expect(moog911aModeName(1.49)).toBe('PARALLEL');
    expect(moog911aModeName(1.51)).toBe('SERIES');
    expect(moog911aModeName(2)).toBe('SERIES');
    // Out of range and non-finite are clamped, not thrown.
    expect(moog911aModeIndex(-5)).toBe(0);
    expect(moog911aModeIndex(99)).toBe(2);
    expect(moog911aModeIndex(Number.NaN)).toBe(moog911aDef.params.find((q) => q.id === 'mode')!.defaultValue);
  });
});

describe('moog911a face model — TOTALITY (it runs on every render)', () => {
  it('a fresh node with no params written prints the defaults, not NaN', () => {
    expect(moog911aMaxRateText(moog911aFaceParams(() => undefined))).toBe('10.0 Hz');
    expect(moog911aLastOutText(moog911aFaceParams(() => undefined))).toBe('100 ms');
  });

  it('NaN and ±Infinity on any param fall back to the def default', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      for (const id of ['delay1', 'delay2', 'mode'] as const) {
        const p = P({ [id]: bad });
        expect(Number.isFinite(moog911aMaxRateHz(p)), `${id}=${bad} rate`).toBe(true);
        expect(Number.isFinite(moog911aLastOutMs(p)), `${id}=${bad} last out`).toBe(true);
        expect(moog911aMaxRateText(p)).toBe('10.0 Hz');
      }
    }
  });

  it('a zero or negative delay is total rather than a division blow-up', () => {
    expect(moog911aMaxRateHz({ delay1: 0, delay2: 0.1, mode: 0 })).toBe(Number.POSITIVE_INFINITY);
    expect(moog911aMaxRateText({ delay1: 0, delay2: 0.1, mode: 0 })).toBe('Infinity');
    expect(moog911aLastOutMs({ delay1: -1, delay2: -1, mode: 2 })).toBe(0);
  });

  it('the formatters are total and span the module\'s range', () => {
    expect(fmtRateHz(Number.NaN)).toBe('NaN');
    expect(fmtRateHz(0.1)).toBe('0.1 Hz');
    expect(fmtRateHz(10)).toBe('10.0 Hz');
    expect(fmtRateHz(500)).toBe('500 Hz');
    expect(fmtDelayMs(Number.NaN)).toBe('NaN');
    expect(fmtDelayMs(-1)).toBe('0.0 ms');
    expect(fmtDelayMs(2)).toBe('2.0 ms');
    expect(fmtDelayMs(100)).toBe('100 ms');
    expect(fmtDelayMs(20000)).toBe('20.00 s');
  });
});

describe('moog911a — the readouts the DEF declares are the ones the REGISTRY resolves', () => {
  it('every valueId on the face resolves, and prints what the model prints', () => {
    const declared = (moog911aDef.face?.hero?.readouts ?? []).map((r) => r.valueId);
    expect(declared).toEqual(['moog911a-max-rate', 'moog911a-last-out']);
    const read = reader();
    const expected = ['10.0 Hz', '100 ms'];
    declared.forEach((id, i) => {
      const fn = faceReadoutValueFor(id!);
      expect(fn, `${id} must be registered in face-readout-values.ts`).toBeTypeOf('function');
      expect(fn!(read)).toBe(expected[i]);
    });
  });

  it('the registry entries move with MODE exactly as the model does', () => {
    const at = (mode: number, id: string) =>
      faceReadoutValueFor(id)!(reader({ mode, delay2: 0.5 }));
    expect(at(0, 'moog911a-last-out')).toBe('100 ms');
    expect(at(1, 'moog911a-last-out')).toBe('500 ms');
    expect(at(2, 'moog911a-last-out')).toBe('600 ms');
    // …while the rate is untouched by the same sweep.
    expect(at(0, 'moog911a-max-rate')).toBe(at(2, 'moog911a-max-rate'));
  });
});
