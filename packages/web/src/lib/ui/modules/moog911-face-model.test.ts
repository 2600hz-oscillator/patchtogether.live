// packages/web/src/lib/ui/modules/moog911-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS for moog911's three derived readouts.
//
// A derived readout earns its place only if it is checked against the input a
// KNOB READBACK WOULD BE BLIND TO — permanently, not once at authoring time
// (CLAUDE.md, "a wrong metric reads exactly like a finding"). This module's
// whole face rests on one measured fact, so that fact is what these tests hold:
//
//   THE SUSTAIN LEVEL KNOB SETS THE DURATION OF THE DECAY KNOB'S STAGE, AND OF
//   THE RELEASE KNOB'S. Measured on the SHIPPING worklet class at 48 kHz with
//   `t2` pinned at its 0.2 s default, the delivered settle runs 276.313 →
//   262.063 → 239.667 → 92.104 → 0.021 ms as ESUS goes 0 → 0.3 → 0.6 → 0.99 →
//   0.999, **and the T2 dial reads 200.000 ms at every one of them.**
//
// So `settle` and `fall` MUST move when ESUS moves, and `rise` MUST NOT — its
// gap ratio is a constant 1000, which makes it this instrument's own negative
// control (the `clap-q` / `clap-bandwidth-hz` pattern: publishing a quantity
// that is invariant to the input the others depend on is what makes every
// render a check). Both directions are asserted for every leg, because a probe
// that cannot move is indistinguishable from one reading the wrong thing.
//
// ⚠ WHAT THIS FILE CANNOT SEE. These are closed forms, so a unit test over them
// can only prove they are self-consistent. That the forms describe the SHIPPING
// DSP is a separate question, answered by driving the real worklet in
// `art/scenarios/moog911/face-audit.test.ts` — which also RECOVERS the three
// stage-exit thresholds this model has to mirror, from the shipping worklet's
// own delivered durations, so a mirror that drifts from the core it describes
// goes red there rather than silently wrong here.

import { describe, expect, it } from 'vitest';
import {
  MOOG911_ATTACK_PEAK,
  MOOG911_DECAY_SETTLE_EPS,
  MOOG911_RELEASE_FLOOR,
  fmtContourMs,
  moog911AttackMs,
  moog911ContourMs,
  moog911DecayMs,
  moog911FaceParams,
  moog911FallText,
  moog911ReleaseMs,
  moog911RiseText,
  moog911SettleText,
} from './moog911-face-model';
import { moog911Def } from '$lib/audio/modules/moog911';

/** A reader over an explicit patch. Anything unset falls through to the def's
 *  own default, exactly like a fresh `node.params` overlay. */
function reader(patch: Record<string, number> = {}) {
  return (id: string): number | undefined => patch[id];
}
const P = (patch: Record<string, number> = {}) => moog911FaceParams(reader(patch));

/**
 * One sample at 48 kHz, in ms.
 *
 * ⚠ EVERY EXPECTATION BELOW IS A MEASURED NUMBER, not a re-print of the closed
 * form's own output — otherwise this file would assert only that the model
 * equals itself. The measured side is quantised to a sample (the stage exits ON
 * a sample boundary), so the model is held to within TWO of them: one for the
 * quantisation and one for which side of the boundary the exit test lands.
 */
const SAMPLE_MS = 1000 / 48000;
const withinASample = (model: number, measured: number, what: string) => {
  expect(
    Math.abs(model - measured),
    `${what}: model ${model.toFixed(4)} ms vs MEASURED ${measured.toFixed(4)} ms (tolerance ${(2 * SAMPLE_MS).toFixed(4)} ms = 2 samples @ 48 kHz)`,
  ).toBeLessThanOrEqual(2 * SAMPLE_MS);
};

/** The sum of what the three T DIALS say, in ms — the number the readouts are
 *  measured against. DERIVED from the def, never typed. */
const dialSumMs = (p: { t1: number; t2: number; t3: number }) =>
  1000 * (p.t1 + p.t2 + p.t3);

describe('moog911 face model — defaults and thresholds track their sources', () => {
  it('every default the model assumes IS the def default (anchored, not copied)', () => {
    const p = P();
    for (const id of ['t1', 't2', 'esus', 't3'] as const) {
      const declared = moog911Def.params.find((q) => q.id === id);
      expect(declared, `${id} must be a declared param of moog911Def`).toBeDefined();
      expect(p[id], `${id} default`).toBe(declared!.defaultValue);
    }
  });

  it('the mirrored stage-exit thresholds are the values the DSP core uses', () => {
    // ⚠ A MIRROR, and this leg only pins the VALUES. What proves they match the
    // shipping `Moog911Eg.step` is the recovery leg in the ART oracle; this is
    // the cheap half, here so a typo is caught in the unit lane.
    expect(MOOG911_ATTACK_PEAK).toBe(0.999);
    expect(MOOG911_DECAY_SETTLE_EPS).toBe(1e-3);
    expect(MOOG911_RELEASE_FLOOR).toBe(1e-4);
  });

  it('at the shipped defaults the three readouts DISAGREE with their dials', () => {
    // Measured on the shipping worklet at 48 kHz, held gate, reading each
    // stage's own exit sample: 13.833 / 239.667 / 695.958 ms.
    const p = P();
    withinASample(moog911AttackMs(p), 13.833, 'rise at the defaults');
    withinASample(moog911DecayMs(p), 239.667, 'settle at the defaults');
    withinASample(moog911ReleaseMs(p), 695.958, 'fall at the defaults');

    expect(moog911RiseText(p)).toBe('13.8 ms');
    expect(moog911SettleText(p)).toBe('240 ms');
    expect(moog911FallText(p)).toBe('696 ms');

    // The headline: the whole contour against what the dials add up to.
    expect(dialSumMs(p)).toBeCloseTo(610, 9);
    withinASample(moog911ContourMs(p), 949.458, 'the whole contour');
    expect(moog911ContourMs(p) / dialSumMs(p)).toBeCloseTo(1.5565, 3);
  });
});

describe('moog911 `settle` / `fall` — NEGATIVE CONTROL on ESUS, the dial that re-times them', () => {
  // The exact table from the shipping worklet, closed-form side. A knob
  // readback of T2 prints 200 ms at every row.
  const SETTLE_BY_ESUS: readonly (readonly [number, number])[] = [
    [0, 276.313],
    [0.3, 262.063],
    [0.6, 239.667],
    [0.9, 184.208],
    [0.99, 92.104],
  ];

  it('ESUS moves the delivered SETTLE across a 3.0x span while the T2 dial does not move', () => {
    for (const [esus, ms] of SETTLE_BY_ESUS) {
      withinASample(moog911DecayMs(P({ esus })), ms, `settle at esus=${esus}`);
    }
    const first = SETTLE_BY_ESUS[0]![1];
    const last = SETTLE_BY_ESUS[SETTLE_BY_ESUS.length - 1]![1];
    expect(first / last).toBeGreaterThan(2.9);
    // …and the dial the reader would have looked at is IDENTICAL at both ends.
    expect(P({ esus: 0 }).t2).toBe(P({ esus: 0.99 }).t2);
  });

  it('ESUS moves the delivered FALL, and by a DIFFERENT law than it moves settle', () => {
    // 0.000 / 640.500 / 695.958 / 736.813 ms at ESUS 0 / 0.3 / 0.6 / 1,
    // T3 dial fixed at 400.000. Note the DIRECTION is opposite to `settle`'s:
    // more sustain means a longer fall and a shorter settle. That opposition is
    // the check that these two are not one quantity printed twice.
    expect(moog911ReleaseMs(P({ esus: 0 }))).toBe(0);
    withinASample(moog911ReleaseMs(P({ esus: 0.3 })), 640.5, 'fall at esus=0.3');
    withinASample(moog911ReleaseMs(P({ esus: 0.6 })), 695.958, 'fall at esus=0.6');
    withinASample(moog911ReleaseMs(P({ esus: 1 })), 736.813, 'fall at esus=1');

    const settleDir = moog911DecayMs(P({ esus: 0.9 })) - moog911DecayMs(P({ esus: 0.3 }));
    const fallDir = moog911ReleaseMs(P({ esus: 0.9 })) - moog911ReleaseMs(P({ esus: 0.3 }));
    expect(settleDir).toBeLessThan(0);
    expect(fallDir).toBeGreaterThan(0);
  });

  it('⚠ `rise` is EXACTLY invariant to ESUS — the instrument\'s own negative control', () => {
    const base = moog911AttackMs(P({ esus: 0 }));
    for (const esus of [0, 0.3, 0.6, 0.9, 0.999, 1]) {
      // Bit-exact, not approximate: the attack's gap ratio is the CONSTANT
      // 1/(1 − 0.999), so any ESUS dependence at all is a bug in the model.
      expect(moog911AttackMs(P({ esus })), `rise at esus=${esus}`).toBe(base);
      expect(moog911RiseText(P({ esus }))).toBe('13.8 ms');
    }
  });
});

describe('moog911 — each T dial moves ITS OWN readout and no other', () => {
  // The positive half. Without this, "invariant to ESUS" would also be
  // satisfied by a readout that is invariant to everything.
  it('T1 moves rise only', () => {
    expect(moog911AttackMs(P({ t1: 1 }))).toBeGreaterThan(moog911AttackMs(P()) * 90);
    expect(moog911DecayMs(P({ t1: 1 }))).toBe(moog911DecayMs(P()));
    expect(moog911ReleaseMs(P({ t1: 1 }))).toBe(moog911ReleaseMs(P()));
  });

  it('T2 moves settle only', () => {
    expect(moog911DecayMs(P({ t2: 2 }))).toBeCloseTo(moog911DecayMs(P()) * 10, 6);
    expect(moog911AttackMs(P({ t2: 2 }))).toBe(moog911AttackMs(P()));
    expect(moog911ReleaseMs(P({ t2: 2 }))).toBe(moog911ReleaseMs(P()));
  });

  it('T3 moves fall only', () => {
    expect(moog911ReleaseMs(P({ t3: 4 }))).toBeCloseTo(moog911ReleaseMs(P()) * 10, 6);
    expect(moog911AttackMs(P({ t3: 4 }))).toBe(moog911AttackMs(P()));
    expect(moog911DecayMs(P({ t3: 4 }))).toBe(moog911DecayMs(P()));
  });
});

describe('moog911 — the two BIT-EXACT NULL REGIONS are printed, not hidden (#1885)', () => {
  it('SETTLE collapses to 0 in the top 0.1 % of the ESUS dial, and NOT below it', () => {
    // The DSP's decay stage exits when |level − esus| <= 1e-3; at ESUS >= 0.999
    // it is already inside that band on the first sample, so T2 is bit-exactly
    // inert (bisected on the shipping worklet to 0.998999983).
    expect(moog911DecayMs(P({ esus: 0.999 }))).toBe(0);
    expect(moog911DecayMs(P({ esus: 0.9995 }))).toBe(0);
    expect(moog911DecayMs(P({ esus: 1 }))).toBe(0);
    expect(moog911SettleText(P({ esus: 1 }))).toBe('0 ms');
    // ⚠ THE CONTROL IS ON THE OTHER SIDE OF THE BOUNDARY. A "control" at 0.9999
    // sits INSIDE the null region and proves nothing — the exact mistake the
    // queue's own adversarial pass caught in the first probe of this module.
    expect(moog911DecayMs(P({ esus: 0.998 }))).toBeGreaterThan(0);
    withinASample(moog911DecayMs(P({ esus: 0.998 })), 27.729, 'settle at esus=0.998');
    // …and inside the region the T2 DIAL is powerless, which is the finding.
    expect(moog911DecayMs(P({ esus: 1, t2: 10 }))).toBe(moog911DecayMs(P({ esus: 1, t2: 0.0001 })));
  });

  it('FALL collapses to 0 in the bottom 0.01 % of the ESUS dial, and NOT above it', () => {
    // Release exits at level <= 1e-4, so a shelf at or below 1e-4 is already
    // there. ⚠ "FROM SUSTAIN" is the qualifier that makes this honest: a
    // release caught MID-ATTACK still has a real level to decay from, which is
    // why queue §22.6's unqualified version was a misreading (#1885).
    expect(moog911ReleaseMs(P({ esus: 1e-4 }))).toBe(0);
    expect(moog911ReleaseMs(P({ esus: 0 }))).toBe(0);
    expect(moog911FallText(P({ esus: 0 }))).toBe('0 ms');
    expect(moog911ReleaseMs(P({ esus: 1.01e-4 }))).toBeGreaterThan(0);
    withinASample(moog911ReleaseMs(P({ esus: 1e-3 })), 184.208, 'fall at esus=1e-3');
  });

  it('RISE prints the 7x cliff AT the declared minimum rather than smoothing it', () => {
    // `egCoeff` snaps for `T <= MIN_TIME_S`, and MIN_TIME_S EQUALS the def's own
    // declared `min` with a `<=` guard — so the dial's last reachable value
    // completes in one sample and the value adjacent to it takes seven.
    const min = moog911Def.params.find((p) => p.id === 't1')!.min;
    expect(min).toBe(1e-4);
    expect(moog911AttackMs(P({ t1: min }))).toBe(0);
    expect(moog911RiseText(P({ t1: min }))).toBe('0 ms');
    expect(moog911AttackMs(P({ t1: min * 1.00001 }))).toBeGreaterThan(0);
    expect(moog911RiseText(P({ t1: min * 1.00001 }))).toBe('0.14 ms');
  });
});

describe('moog911 face model — TOTALITY (it runs on every render)', () => {
  it('a fresh node with no params written prints the defaults, not NaN', () => {
    expect(moog911RiseText(moog911FaceParams(() => undefined))).toBe('13.8 ms');
    expect(moog911SettleText(moog911FaceParams(() => undefined))).toBe('240 ms');
    expect(moog911FallText(moog911FaceParams(() => undefined))).toBe('696 ms');
  });

  it('NaN and ±Infinity on any param fall back to the def default', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      for (const id of ['t1', 't2', 'esus', 't3'] as const) {
        const p = P({ [id]: bad });
        expect(Number.isFinite(moog911AttackMs(p)), `${id}=${bad} rise`).toBe(true);
        expect(Number.isFinite(moog911DecayMs(p)), `${id}=${bad} settle`).toBe(true);
        expect(Number.isFinite(moog911ReleaseMs(p)), `${id}=${bad} fall`).toBe(true);
        expect(moog911RiseText(p)).toBe('13.8 ms');
      }
    }
  });

  it('ESUS exactly 0 and exactly 1, and out-of-range values, are total', () => {
    for (const esus of [-5, 0, 1, 5]) {
      const p = P({ esus });
      for (const fn of [moog911AttackMs, moog911DecayMs, moog911ReleaseMs, moog911ContourMs]) {
        const v = fn(p);
        expect(Number.isFinite(v), `esus=${esus}`).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
      }
    }
    // Clamped like `Moog911Eg.step` does: below 0 behaves as 0, above 1 as 1.
    expect(moog911DecayMs(P({ esus: -5 }))).toBe(moog911DecayMs(P({ esus: 0 })));
    expect(moog911ReleaseMs(P({ esus: 5 }))).toBe(moog911ReleaseMs(P({ esus: 1 })));
  });

  it('the formatter is total and spans the module\'s five decades', () => {
    expect(fmtContourMs(Number.NaN)).toBe('NaN');
    expect(fmtContourMs(Number.POSITIVE_INFINITY)).toBe('Infinity');
    expect(fmtContourMs(-1)).toBe('0 ms');
    expect(fmtContourMs(0)).toBe('0 ms');
    expect(fmtContourMs(0.1382)).toBe('0.14 ms');
    expect(fmtContourMs(13.8155)).toBe('13.8 ms');
    expect(fmtContourMs(239.6585)).toBe('240 ms');
    expect(fmtContourMs(13815.5)).toBe('13.82 s');
  });
});
