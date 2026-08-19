// packages/web/src/lib/ui/modules/moogcp3-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROL for moogCp3's one derived readout.
//
// The face rests on a single claim: the console is +18 dB over full scale AT
// ITS OWN DEFAULTS, and no knob on it says so. The readout is a JOIN over all
// five knobs, so the leg that matters is the one a knob readback would fail —
// ATTENUATOR 4 moves the bus while the CH 4 DIAL DOES NOT MOVE.
//
// ⚠ WHAT THIS FILE CANNOT SEE. These are closed forms. That they describe the
// SHIPPING mix — the ×2 channel law, the missing clamp, the CH4/ATT4 product —
// is answered by driving the real worklet in
// `art/scenarios/moog-cp3/face-audit.test.ts`.

import { describe, expect, it } from 'vitest';
import {
  moogCp3BusDb,
  moogCp3BusGain,
  moogCp3BusText,
  moogCp3FaceParams,
} from './moogcp3-face-model';
import { moogCp3Def } from '$lib/audio/modules/moog-cp3';
import { faceReadoutValueFor } from '$lib/ui/workflow/face-readout-values';

function reader(patch: Record<string, number> = {}) {
  return (id: string): number | undefined => patch[id];
}
const P = (patch: Record<string, number> = {}) => moogCp3FaceParams(reader(patch));

describe('moogCp3 face model — defaults track the def', () => {
  it('every default the model assumes IS the def default (anchored, not copied)', () => {
    const p = P();
    for (const id of ['ch1', 'ch2', 'ch3', 'ch4', 'attenuator4'] as const) {
      const declared = moogCp3Def.params.find((q) => q.id === id);
      expect(declared, `${id} must be a declared param of moogCp3Def`).toBeDefined();
      expect(p[id], `${id} default`).toBe(declared!.defaultValue);
    }
  });

  it('⚠ ALL FIVE KNOBS SHIP AT MAX, which is what makes the finding a finding', () => {
    for (const q of moogCp3Def.params) {
      expect(q.defaultValue, `${q.id} ships at its own max`).toBe(q.max);
    }
  });

  it('at the shipped defaults the bus is x8 and +18.1 dB over full scale', () => {
    // Measured on the shipping worklet: peak 8.0000 from four correlated unity
    // inputs, 10.0000 with EXT 4 also patched, and no clamp anywhere.
    expect(moogCp3BusGain(P())).toBeCloseTo(8, 9);
    expect(moogCp3BusDb(P())).toBeCloseTo(18.0618, 3);
    expect(moogCp3BusText(P())).toBe('+18.1 dB');
  });

  it('UNITY is at the dial MIDPOINT, not at the top', () => {
    // One channel open at 0.5 is a gain of exactly 1.
    const soloMid = P({ ch1: 0.5, ch2: 0, ch3: 0, ch4: 0, attenuator4: 0 });
    expect(moogCp3BusGain(soloMid)).toBeCloseTo(1, 9);
    expect(moogCp3BusText(soloMid)).toBe('0.0 dB');
    // …and at the top it is +6.021 dB, which is the whole reason the defaults
    // add up the way they do.
    const soloMax = P({ ch1: 1, ch2: 0, ch3: 0, ch4: 0, attenuator4: 0 });
    expect(moogCp3BusDb(soloMax)).toBeCloseTo(6.0206, 3);
  });
});

describe('moogCp3 `bus` — NEGATIVE CONTROL on ATTENUATOR 4', () => {
  it('ATT 4 moves the bus while the CH 4 dial does not move', () => {
    // The leg a knob readback fails: CH 4 reads 1.00 at both ends.
    const open = P({ attenuator4: 1 });
    const shut = P({ attenuator4: 0 });
    expect(moogCp3BusGain(open)).toBeCloseTo(8, 9);
    expect(moogCp3BusGain(shut)).toBeCloseTo(6, 9);
    expect(moogCp3BusText(open)).toBe('+18.1 dB');
    expect(moogCp3BusText(shut)).toBe('+15.6 dB');
    expect(open.ch4, 'the CH 4 dial is identical at both').toBe(shut.ch4);
  });

  it('every channel moves it, so the ATT 4 leg is not a dead probe', () => {
    const base = moogCp3BusGain(P());
    for (const id of ['ch1', 'ch2', 'ch3', 'ch4'] as const) {
      expect(moogCp3BusGain(P({ [id]: 0 })), `${id} closed`).toBeLessThan(base);
    }
  });

  it('⚠ CH 4 and ATT 4 are INTERCHANGEABLE — the readout says so because the DSP does', () => {
    // `cp3Mix` applies (in4+ext4)·atten4·g4, so the bus sees only the product.
    // Measured bit-exactly on the worklet with different signals on the two
    // jacks; the model must agree or it would be describing a different module.
    for (const [a, b] of [
      [0.5, 1],
      [0.25, 0.8],
      [0.2, 0.9],
      [0, 1],
    ]) {
      expect(
        moogCp3BusGain(P({ ch4: a, attenuator4: b })),
        `(ch4,att4)=(${a},${b}) vs (${b},${a})`,
      ).toBe(moogCp3BusGain(P({ ch4: b, attenuator4: a })));
    }
    // NEGATIVE CONTROL: a swap that changes the PRODUCT must change the bus,
    // so the invariance above is a property of the law and not of a dead probe.
    expect(moogCp3BusGain(P({ ch4: 0.5, attenuator4: 1 }))).not.toBe(
      moogCp3BusGain(P({ ch4: 0.5, attenuator4: 0.5 })),
    );
  });

  it('⚠ STATED SCOPE: this scalar CANNOT tell CH 1 from CH 4, and that is not the claim', () => {
    // The bus gain is a SUM over channels, so swapping CH 1 with CH 4 leaves it
    // identical too — 2·(0.25+1+1+0.8) is the same number either way. That is a
    // property of the READOUT, not of the module: the two channels carry
    // DIFFERENT SIGNALS in a real patch and are emphatically not
    // interchangeable there.
    //
    // Asserted here so nobody reads the interchangeability leg above as a
    // stronger claim than it is. The claim that CH 4 and ATT 4 are genuinely
    // the same control is made where it can be made — against the SHIPPING
    // worklet with 300 Hz on IN 4 and 700 Hz on EXT 4, in
    // art/scenarios/moog-cp3/face-audit.test.ts, where the CH 1 vs CH 4 swap
    // measures a max abs difference of 2.106857 and the CH 4 vs ATT 4 swap
    // measures 0.000000000000.
    expect(moogCp3BusGain(P({ ch1: 0.25, ch4: 0.8 }))).toBe(
      moogCp3BusGain(P({ ch1: 0.8, ch4: 0.25 })),
    );
  });
});

describe('moogCp3 face model — TOTALITY (it runs on every render)', () => {
  it('a fresh node with no params written prints the defaults, not NaN', () => {
    expect(moogCp3BusText(moogCp3FaceParams(() => undefined))).toBe('+18.1 dB');
  });

  it('NaN and ±Infinity on any param fall back to the def default', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      for (const id of ['ch1', 'ch2', 'ch3', 'ch4', 'attenuator4'] as const) {
        const p = P({ [id]: bad });
        expect(Number.isFinite(moogCp3BusGain(p)), `${id}=${bad}`).toBe(true);
        expect(moogCp3BusText(p)).toBe('+18.1 dB');
      }
    }
  });

  it('every channel closed reads SILENT rather than -Infinity dB', () => {
    const shut = P({ ch1: 0, ch2: 0, ch3: 0, ch4: 0, attenuator4: 0 });
    expect(moogCp3BusGain(shut)).toBe(0);
    expect(moogCp3BusDb(shut)).toBe(Number.NEGATIVE_INFINITY);
    expect(moogCp3BusText(shut)).toBe('silent');
  });

  it('out-of-range knob values are clamped like the DSP clamps them', () => {
    expect(moogCp3BusGain(P({ ch1: 5 }))).toBe(moogCp3BusGain(P({ ch1: 1 })));
    expect(moogCp3BusGain(P({ ch1: -5 }))).toBe(moogCp3BusGain(P({ ch1: 0 })));
  });
});

describe('moogCp3 — the readout the DEF declares is the one the REGISTRY resolves', () => {
  it('the valueId resolves and prints what the model prints', () => {
    const declared = (moogCp3Def.face?.hero?.readouts ?? []).map((r) => r.valueId);
    expect(declared).toEqual(['moogcp3-bus-db']);
    const fn = faceReadoutValueFor('moogcp3-bus-db');
    expect(fn, 'moogcp3-bus-db must be registered in face-readout-values.ts').toBeTypeOf('function');
    expect(fn!(reader())).toBe('+18.1 dB');
    // …and through the registry, ATT 4 still moves it.
    expect(fn!(reader({ attenuator4: 0 }))).toBe('+15.6 dB');
  });
});
