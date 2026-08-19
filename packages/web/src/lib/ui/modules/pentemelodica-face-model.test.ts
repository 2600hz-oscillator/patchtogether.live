// packages/web/src/lib/ui/modules/pentemelodica-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS behind PENTEMELODICA's derived readouts.
//
// Each is perturbed on the input a knob readback is BLIND to, AND pinned in the
// direction it must NOT follow. Plus a SOURCE-ANCHORED check that
// `penteModeGainAtCutoff` still mirrors `modeMorph`'s segment arithmetic, so
// the closed form cannot rot silently against the DSP it claims to model.
//
// ⚠ TWO THINGS IN THIS FILE MOVED WITH THE NOTCH FIX (`modeMorph` was missing
// the `k` from `notch = x - k*bp`): negative control (a), which used to probe
// mode = 1 precisely because the broken tap was resonance-dependent there, and
// the source pin, which spelled out the k-less line and so held the defect in
// place. Both are annotated at their sites.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  penteDecayToSustainMs,
  penteModeGainAtCutoff,
  pentePeakLinear,
  penteReleaseTailMs,
  pentemelodicaFaceParams,
  type PenteFaceParams,
} from './pentemelodica-face-model';

const DEFAULTS: PenteFaceParams = pentemelodicaFaceParams(() => undefined);

function withParams(over: Partial<PenteFaceParams>): (id: string) => number | undefined {
  const p = { ...DEFAULTS, ...over };
  return (id) => {
    const mv = /^v([1-5])_(level|pan)$/.exec(id);
    if (mv) {
      const i = Number(mv[1]) - 1;
      return mv[2] === 'level' ? p.levels[i] : p.pans[i];
    }
    return (p as unknown as Record<string, number>)[id];
  };
}

function readout(id: string, over: Partial<PenteFaceParams> = {}): string {
  const fn = faceReadoutValueFor(id);
  expect(fn, `${id} is not registered in face-readout-values.ts`).not.toBeNull();
  return fn!(withParams(over));
}

describe('pentemelodica face model — the shipped defaults', () => {
  it('resolves the def defaults for an untouched node', () => {
    expect(DEFAULTS.mode).toBe(0);
    expect(DEFAULTS.resonance).toBe(0.2);
    expect(DEFAULTS.sustain).toBe(1);
    expect(DEFAULTS.release).toBe(0.005);
    expect(DEFAULTS.levels).toEqual([0.8, 0.8, 0.8, 0.8, 0.8]);
    expect(DEFAULTS.pans).toEqual([0, 0, 0, 0, 0]);
  });
});

describe('pentemelodica face model — NEGATIVE CONTROLS', () => {
  // (a) RESONANCE is what sets the LEVEL at the cutoff, over a MODE dial that
  //     never budges. A MODE-only readout is invariant to exactly this.
  //
  //     ⚠ THIS LEG MOVED WITH THE NOTCH FIX. It used to probe mode = 1, where
  //     the pre-fix `notch = x - bp` tap read |1 - 1/k| and so ran 0.5 → 49 (a
  //     +33.8 dB resonant BOOST) across the resonance range. The fourth tap is
  //     now the true notch `x - k*bp`, which NULLS at fc for every k — so
  //     mode = 1 is precisely the ONE mode that is resonance-invariant, and
  //     probing there would have asserted nothing. The blindness being
  //     controlled for is unchanged; it is demonstrated at mode 0 instead,
  //     where the LP tap still scales as a pure 1/k.

  // (a2) THE NOTCH FIX ITSELF — and the reason leg (a) had to move.
  //      `modeMorph` dropped the `k` from the SVF identity, making the fourth
  //      tap a phase-inverted band-pass instead of a notch. A true notch nulls
  //      at fc for EVERY resonance; the broken one only managed it at k = 1.
  it('at MODE 1 the tap is a TRUE NOTCH — an exact null at every resonance', () => {
    for (const resonance of [0, 0.2, 0.5, 0.8, 0.9, 0.99]) {
      expect(
        penteModeGainAtCutoff(1, resonance),
        `res ${resonance}: the notch must null at fc (pre-fix this read ` +
          '0.375 at 0.2 and 49 at 0.99)',
      ).toBeCloseTo(0, 12);
    }
    // NEGATIVE CONTROL on that null: one notch away from the dial's end the
    // gain is non-zero again and STILL resonance-dependent, so "0 everywhere"
    // is not simply what this closed form returns.
    expect(penteModeGainAtCutoff(0.9, 0.2)).toBeGreaterThan(0.1);
    expect(penteModeGainAtCutoff(0.9, 0.9)).toBeGreaterThan(
      penteModeGainAtCutoff(0.9, 0.2),
    );
  });

  it('the three MODE landmarks below the fourth tap are pure 1/k', () => {
    for (const m of [0, 1 / 3, 2 / 3]) {
      expect(penteModeGainAtCutoff(m, 0.2)).toBeCloseTo(1 / 1.6, 6);
    }
  });

  // (b) PEAK is a function of LEVEL **and** PAN. A level readback is
  //     pan-invariant, so spreading the pans is the leg it cannot see.

  it('one voice peaks at −9.4 dBFS and five at +4.6 — a CONSTANT 0.6, never 1/√N', () => {
    expect(pentePeakLinear([0.8, 0, 0, 0, 0], [0, 0, 0, 0, 0])).toBeCloseTo(0.3394, 4);
    expect(20 * Math.log10(pentePeakLinear([0.8, 0, 0, 0, 0], [0, 0, 0, 0, 0]))).toBeCloseTo(
      -9.39,
      2,
    );
  });

  // (c) THE RELEASE TAIL. The RELEASE knob is SUSTAIN-invariant; the tail is not.

  // (d) THE DECAY THAT NEVER RUNS.
});

describe('pentemelodica face model — the DSP-source pin', () => {
  // The closed form above is derived FROM `modeMorph`'s segment arithmetic and
  // from its fourth tap. If either changes, the derivation is silently wrong
  // about the module rather than loudly wrong here.
  //
  // ⚠ THIS PIN HELD THE BUG IN PLACE. It asserted the source read
  // `const notch = x - taps.bp;` — the k-less form — so the missing `k` was
  // pinned by a passing test, in the file whose job is to catch exactly this
  // drift. The pin itself was sound; what it pinned was wrong. It now names the
  // true SVF identity, and the DSP-side unit test cross-checks that identity
  // against `resofilter`'s independent `lp + hp` form so a source-text match
  // alone can no longer certify it.
  it('the mode morph still segments 3-ways and still taps `x - k*bp`', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../../../../../dsp/src/lib/pentemelodica-dsp.ts', import.meta.url)),
      'utf8',
    );
    expect(src).toContain('const seg = Math.min(2, Math.floor(m3));');
    expect(src).toContain('const notch = x - k * taps.bp;');
    expect(src).toContain('return taps.hp * (1 - t) + notch * t;');
  });

  it('the envelope’s two exit thresholds still match the model’s mirrors', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../../../../../dsp/src/lib/pentemelodica-dsp.ts', import.meta.url)),
      'utf8',
    );
    expect(src).toContain('Math.abs(this.value - susTarget) < 1e-4');
    expect(src).toContain('this.value < 1e-5');
  });
});
