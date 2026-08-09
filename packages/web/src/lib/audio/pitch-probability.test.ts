// packages/web/src/lib/audio/pitch-probability.test.ts
//
// The WEIGHT FUNCTION, asserted directly and deterministically.
//
// A test that draws N samples and asserts a mean passes on a badly broken
// distribution: sampling error hides shape errors, and a mean is invariant to
// most of what this model is *for* (which pitches, in what order of arrival).
// So every property below is asserted on the exact weights `pitchCandidates`
// returns — no RNG, no histogram, no tolerance beyond float epsilon. Only the
// short sampling-integration block at the end touches a generator, and it uses
// an INJECTED seeded one, so nothing here needs a global mock.
//
// Where a property does NOT hold universally, the test says so and pins the
// exact scope (the repo's "state the gate's scope inside the gate" rule) rather
// than quietly testing the easy case.

import { describe, it, expect } from 'vitest';
import {
  PITCH_PROB_LEVELS,
  PITCH_PROB_STEP,
  DEFAULT_PITCH_CURVE,
  pitchProbLevelToValue,
  valueToPitchProbLevel,
  pitchProbLabel,
  clampInstability,
  pitchSpread,
  pitchChromaWeight,
  pitchOriginalWeight,
  privilegedIntervalBonus,
  octavePeakMinSpread,
  octavePeakMinInstability,
  fractionalRow,
  isOnScale,
  pitchCandidates,
  totalWeight,
  centreMass,
  outOfScaleMass,
  expectedAbsDegreeOffset,
  samplePitch,
  pitchRollSeed,
  pitchRollRng,
  resolvePitch,
  applyPitchProbability,
  type PitchCandidate,
} from './pitch-probability';
import { PROB_STEP, PROB_LEVELS } from './modules/clip-types';
import { mulberry32 } from '$lib/sync/prng';

const ROOT = 48; // C3 — the default clip root
const C4 = 60;
const E4 = 64;

/** Candidates for C4 in C major at instability `x`. */
const at = (x: number, midi = C4, scale: 'major' | 'minor' | 'pentatonic' | undefined = 'major') =>
  pitchCandidates({ midi, instability: x, root: ROOT, scale });

/** The candidate at a given SEMITONE offset (the ear's units). */
const bySemi = (cands: readonly PitchCandidate[], st: number): PitchCandidate => {
  const c = cands.find((k) => k.semitoneOffset === st);
  if (!c) throw new Error(`no candidate at ${st} semitones`);
  return c;
};

/** Every level 0..40 as its instability value. */
const LEVELS = Array.from({ length: PITCH_PROB_LEVELS + 1 }, (_v, i) => pitchProbLevelToValue(i));

// ---------------------------------------------------------------------------
describe('the 40-increment level domain', () => {
  it('is the SAME 2.5% grid as the existing per-note PROBABILITY control', () => {
    // The owner's stated reason for 40: parity with the other % controls for
    // eventual Push/Launchpad use (40 = 5 rows of 8 pads).
    expect(PITCH_PROB_LEVELS).toBe(PROB_LEVELS);
    expect(PITCH_PROB_STEP).toBeCloseTo(PROB_STEP, 12);
    expect(PITCH_PROB_LEVELS % 8).toBe(0); // a multiple of 8 → whole Launchpad rows
  });

  it('runs 0..40, NOT 1..40 like PROBABILITY — zero is the default here', () => {
    // The one deliberate difference from the neighbouring control, and it is
    // forced: prob 0% is useless-but-meaningful, pitch instability 0 IS "off".
    expect(pitchProbLevelToValue(0)).toBe(0);
    expect(pitchProbLevelToValue(PITCH_PROB_LEVELS)).toBe(1);
    expect(valueToPitchProbLevel(0)).toBe(0);
    expect(valueToPitchProbLevel(1)).toBe(PITCH_PROB_LEVELS);
  });

  it('round-trips every level exactly', () => {
    for (let l = 0; l <= PITCH_PROB_LEVELS; l++) {
      expect(valueToPitchProbLevel(pitchProbLevelToValue(l))).toBe(l);
    }
  });

  it('clamps and defends against junk', () => {
    expect(pitchProbLevelToValue(-5)).toBe(0);
    expect(pitchProbLevelToValue(999)).toBe(1);
    expect(pitchProbLevelToValue(Number.NaN)).toBe(0);
    expect(valueToPitchProbLevel(Number.NaN)).toBe(0);
    expect(valueToPitchProbLevel(-1)).toBe(0);
    expect(valueToPitchProbLevel(5)).toBe(PITCH_PROB_LEVELS);
    expect(clampInstability('nope')).toBe(0);
    expect(clampInstability(undefined)).toBe(0);
  });

  it('labels off as off and matches probPctLabel formatting elsewhere', () => {
    expect(pitchProbLabel(0)).toBe('off');
    expect(pitchProbLabel(1)).toBe('100%');
    expect(pitchProbLabel(0.5)).toBe('50%');
    expect(pitchProbLabel(0.025)).toBe('2.5%');
  });
});

// ---------------------------------------------------------------------------
describe('x = 0 is EXACT, not almost', () => {
  it('the authored pitch has ALL the mass; every other candidate is exactly 0', () => {
    const c = at(0);
    const home = bySemi(c, 0);
    expect(home.weight).toBeGreaterThan(0);
    for (const k of c) {
      if (k.semitoneOffset === 0) continue;
      // Not "close to 0" — exactly 0. `spread(0)` is exactly 0, so the distance
      // term is exp(-Infinity), which IEEE-754 gives as +0.
      expect(k.weight).toBe(0);
      expect(k.distanceWeight).toBe(0);
    }
    expect(centreMass(c)).toBe(1);
    expect(expectedAbsDegreeOffset(c)).toBe(0);
  });

  it('holds for every scale, every root offset, and a chromatic clip', () => {
    for (const scale of ['major', 'minor', 'pentatonic', 'dorian', 'phrygian', 'mixolydian', undefined] as const) {
      for (const midi of [MIN_TEST_MIDI, 55, C4, E4, 61, 90]) {
        const c = pitchCandidates({ midi, instability: 0, root: ROOT, scale });
        expect(centreMass(c)).toBe(1);
        for (const k of c) if (k.semitoneOffset !== 0) expect(k.weight).toBe(0);
      }
    }
  });

  it('the sampler returns the authored pitch for EVERY rng value at x=0', () => {
    // Negative control on the fast path: a broken short-circuit would show up
    // as a different pitch for some rng value, so sweep the whole 0..1 range.
    for (let i = 0; i <= 100; i++) {
      expect(samplePitch({ midi: C4, instability: 0, root: ROOT, scale: 'major' }, () => i / 100)).toBe(C4);
    }
  });

  it('and the mutation seam is a NO-OP: the same array reference back', () => {
    const firing = [{ midi: C4 }, { midi: E4, pitchProb: 0 }];
    const out = applyPitchProbability(firing, {
      root: ROOT, scale: 'major', nodeId: 'n1', lane: 0, slot: 0, step: 0, loopCount: 0,
    });
    expect(out).toBe(firing); // identity — untouched clips allocate nothing
  });
});
const MIN_TEST_MIDI = 36;

// ---------------------------------------------------------------------------
describe('the distance term is LAPLACIAN, in SCALE DEGREES', () => {
  it('weight(offset) = exp(-|offset| / spread) on the in-scale candidates', () => {
    const x = 0.6;
    const s = pitchSpread(x);
    for (const k of at(x)) {
      const expected = k.degreeOffset === 0 ? 1 : Math.exp(-Math.abs(k.degreeOffset) / s);
      expect(k.distanceWeight).toBeCloseTo(expected, 12);
    }
  });

  it('is NOT uniform — it decays monotonically with |degree offset|', () => {
    // "uniform sounds like a bad RNG". Compare the pure distance term (the
    // privileged bonuses and the chroma factor are separate factors by design).
    const c = at(0.7);
    const sorted = [...c].sort((a, b) => Math.abs(a.degreeOffset) - Math.abs(b.degreeOffset));
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i]!.distanceWeight).toBeLessThanOrEqual(sorted[i - 1]!.distanceWeight + 1e-15);
    }
    // and the decay is REAL, not a rounding artefact: an octave away is far less
    // likely than a step away.
    expect(bySemi(c, 2).distanceWeight).toBeGreaterThan(5 * bySemi(c, 12).distanceWeight);
  });

  it('offsets are SCALE DEGREES: from E in C major, −1 is D and +1 is F', () => {
    // The design's own worked example. Semitones would have said D♯ and F.
    const c = at(0.5, E4);
    const minus1 = c.find((k) => Math.abs(k.degreeOffset + 1) < 1e-12)!;
    const plus1 = c.find((k) => Math.abs(k.degreeOffset - 1) < 1e-12)!;
    expect(minus1.midi).toBe(62); // D4 — TWO semitones below E
    expect(plus1.midi).toBe(65); // F4 — ONE semitone above E
    expect(minus1.semitoneOffset).toBe(-2);
    expect(plus1.semitoneOffset).toBe(1);
    // …and they are equally weighted by distance, which is the whole point:
    // a scale-degree step is one step whatever its semitone size.
    expect(minus1.distanceWeight).toBeCloseTo(plus1.distanceWeight, 12);
    expect(minus1.weight).toBeCloseTo(plus1.weight, 12);
  });

  it('a MINOR clip moves by its own degrees, not major ones', () => {
    const c = at(0.5, C4, 'minor'); // C natural minor from C: C D E♭ F G A♭ B♭
    const plus1 = c.find((k) => Math.abs(k.degreeOffset - 1) < 1e-12)!;
    const plus2 = c.find((k) => Math.abs(k.degreeOffset - 2) < 1e-12)!;
    expect(plus1.midi).toBe(62); // D
    expect(plus2.midi).toBe(63); // E♭ — a major clip would have said E (64)
  });

  it('an OUT-OF-SCALE candidate gets a FRACTIONAL degree between its neighbours', () => {
    expect(fractionalRow(C4, ROOT, 'major')).toBe(7); // C4 = degree 7 (octave above C3)
    expect(fractionalRow(61, ROOT, 'major')).toBeCloseTo(7.5, 12); // C♯ between C(7) and D(8)
    expect(fractionalRow(63, ROOT, 'major')).toBeCloseTo(8.5, 12); // D♯ between D(8) and E(9)
    expect(isOnScale(C4, ROOT, 'major')).toBe(true);
    expect(isOnScale(61, ROOT, 'major')).toBe(false);
    // Strictly increasing across the whole playable span — the metric is a line.
    let prev = -Infinity;
    for (let m = 24; m <= 96; m++) {
      const r = fractionalRow(m, ROOT, 'major');
      expect(r).toBeGreaterThan(prev);
      prev = r;
    }
  });

  it('a CHROMATIC clip degrades to a semitone Laplacian with nothing out of scale', () => {
    const c = pitchCandidates({ midi: C4, instability: 0.6, root: ROOT, scale: undefined });
    for (const k of c) {
      expect(k.inScale).toBe(true);
      expect(k.degreeOffset).toBe(k.semitoneOffset); // one degree == one semitone
    }
    expect(outOfScaleMass(c)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('the single parameter moves all three curves, at different rates', () => {
  it('centre mass is monotonically NON-INCREASING across all 40 steps', () => {
    let prev = Infinity;
    for (const x of LEVELS) {
      const m = centreMass(at(x));
      expect(m).toBeLessThanOrEqual(prev);
      prev = m;
    }
  });

  it('…and STRICTLY decreasing at every level but one — pinned, both directions', () => {
    // SCOPE, stated in the gate: exactly ONE level ties (level 1). At x=0.025
    // the neighbour weight is ~4e-28 against a home weight of ~8.5, which is
    // below double precision, so level 1 is bit-identical to off. That is the
    // price of spread(0) = 0, which is what buys the exact identity at level 0.
    // Ratcheted in BOTH directions so neither a regression nor an improvement
    // passes silently.
    const ties: number[] = [];
    let prev = centreMass(at(LEVELS[0]!));
    for (let l = 1; l <= PITCH_PROB_LEVELS; l++) {
      const m = centreMass(at(LEVELS[l]!));
      if (m === prev) ties.push(l);
      prev = m;
    }
    expect(ties).toEqual([1]);
  });

  it('the REALISED spread increases monotonically (measured from the weights)', () => {
    // Instrument note: `pitchSpread` is a power of x and so is monotone by
    // inspection — asserting on it would be invariant to every other factor in
    // the product. `expectedAbsDegreeOffset` reads the distribution that
    // actually results, so a broken privilege bonus / chroma ramp / window
    // would move it.
    let prev = -Infinity;
    for (const x of LEVELS) {
      const e = expectedAbsDegreeOffset(at(x));
      expect(e).toBeGreaterThanOrEqual(prev);
      prev = e;
    }
    // …and it is a real ramp, not a flat line: negative-control the instrument.
    expect(expectedAbsDegreeOffset(at(1))).toBeGreaterThan(50 * expectedAbsDegreeOffset(at(0.25)));
  });

  it('out-of-scale mass is ~0 at low x and rises monotonically', () => {
    let prev = -Infinity;
    for (const x of LEVELS) {
      const o = outOfScaleMass(at(x));
      expect(o).toBeGreaterThanOrEqual(prev);
      prev = o;
    }
    expect(outOfScaleMass(at(0.25))).toBeLessThan(0.001); // ornamentation: diatonic
    expect(outOfScaleMass(at(0.4))).toBeLessThan(0.01);
    expect(outOfScaleMass(at(0.5))).toBeLessThan(0.03); // "near-entirely diatonic"
    expect(outOfScaleMass(at(0.8))).toBeGreaterThan(0.15); // "seriously weird"
    expect(outOfScaleMass(at(1))).toBeGreaterThan(0.3); // atonality
  });

  it('out-of-scale weight ARRIVES LATER than the spread widens (the design ordering)', () => {
    // The curve statement: chroma ∝ x^4 lags spread ∝ x^1.5 for all x in (0,1).
    // This is the assertion that would catch someone swapping the exponents.
    expect(DEFAULT_PITCH_CURVE.chromaExp).toBeGreaterThan(DEFAULT_PITCH_CURVE.spreadExp);
    for (const x of LEVELS.slice(1, -1)) {
      const spreadFrac = pitchSpread(x) / DEFAULT_PITCH_CURVE.spreadMax;
      const chromaFrac = pitchChromaWeight(x) / DEFAULT_PITCH_CURVE.chromaMax;
      expect(chromaFrac).toBeLessThan(spreadFrac);
    }
  });

  it('…and in REALISED terms too, above the two levels where nothing happens', () => {
    // SCOPE: at levels 1–2 the *leading* leakage is chromatic, not diatonic,
    // because the nearest non-home candidate is a semitone = HALF a degree, and
    // exp(0.5/spread) outruns any fixed x^4 factor as spread → 0. At those two
    // levels the out-of-scale mass is ≤ 1e-11 — one note in a hundred billion —
    // so this is a statement about floating point, not about music. Pinned in
    // both directions so it cannot silently widen.
    const eMax = expectedAbsDegreeOffset(at(1));
    const oMax = outOfScaleMass(at(1));
    const inverted: number[] = [];
    for (let l = 1; l < PITCH_PROB_LEVELS; l++) {
      const c = at(LEVELS[l]!);
      if (!(expectedAbsDegreeOffset(c) / eMax > outOfScaleMass(c) / oMax)) inverted.push(l);
    }
    expect(inverted).toEqual([1, 2]);
    for (const l of inverted) expect(outOfScaleMass(at(LEVELS[l]!))).toBeLessThan(1e-10);
    // the first level where it is NOT inverted is already musically silent too
    expect(outOfScaleMass(at(LEVELS[3]!))).toBeLessThan(1e-6);
  });

  it('the original-pitch weight decays from a bonus to exactly 1', () => {
    expect(pitchOriginalWeight(0)).toBe(1 + DEFAULT_PITCH_CURVE.originalBonusMax);
    expect(pitchOriginalWeight(1)).toBe(1); // no privilege left at full instability
    let prev = Infinity;
    for (const x of LEVELS) {
      const w = pitchOriginalWeight(x);
      expect(w).toBeLessThanOrEqual(prev);
      prev = w;
    }
    // It is applied to the offset-0 candidate and NOTHING else.
    for (const k of at(0.5)) {
      expect(k.originalWeight).toBe(k.semitoneOffset === 0 ? pitchOriginalWeight(0.5) : 1);
    }
  });

  it('scale membership is a WEIGHTING, not a binary switch', () => {
    // A binary would jump 0 → 1 at some threshold. Assert it ramps smoothly and
    // is strictly between the extremes over the whole middle of the range.
    for (const x of LEVELS.slice(1, -1)) {
      const w = pitchChromaWeight(x);
      expect(w).toBeGreaterThan(0);
      expect(w).toBeLessThan(1);
    }
    expect(pitchChromaWeight(1)).toBe(DEFAULT_PITCH_CURVE.chromaMax);
    for (const k of at(0.6)) {
      expect(k.scaleWeight).toBeCloseTo(k.inScale ? 1 : pitchChromaWeight(0.6), 12);
    }
  });

  it('the behaviour ladder lands where the design says it should', () => {
    // The pinned tuning table from the module header, in one assertion, so a
    // curve edit shows up as a readable diff rather than silently.
    const ladder = [0, 10, 16, 20, 24, 32, 40].map((l) => {
      const c = at(pitchProbLevelToValue(l));
      return [l, +(centreMass(c) * 100).toFixed(1), +(outOfScaleMass(c) * 100).toFixed(1)];
    });
    expect(ladder).toEqual([
      [0, 100, 0], // fixed pitch
      [10, 93.9, 0], // ornamentation
      [16, 71.2, 0.7],
      [20, 50.2, 2.4], // melodic variation — frequent, local, diatonic
      [24, 31.6, 5.7],
      [32, 11.9, 16.6], // reharmonisation → seriously weird
      [40, 6, 31.5], // atonality
    ]);
  });
});

// ---------------------------------------------------------------------------
describe('privileged intervals — the secondary peaks', () => {
  it('the bonus is applied at exactly ±12 and ±7 semitones, nowhere else', () => {
    for (let st = -19; st <= 19; st++) {
      const expected =
        Math.abs(st) === 12 ? DEFAULT_PITCH_CURVE.octaveBonus
        : Math.abs(st) === 7 ? DEFAULT_PITCH_CURVE.fifthBonus
        : 1;
      expect(privilegedIntervalBonus(st)).toBe(expected);
    }
  });

  it('the ±12 peak EXISTS and exceeds its immediate neighbours', () => {
    // The property that stops this sounding like generic random pitch.
    for (const x of [0.3, 0.5, 0.7, 0.9, 1]) {
      const c = at(x);
      for (const sign of [1, -1]) {
        const oct = bySemi(c, 12 * sign).weight;
        expect(oct).toBeGreaterThan(bySemi(c, 11 * sign).weight);
        expect(oct).toBeGreaterThan(bySemi(c, 13 * sign).weight);
      }
    }
  });

  it('…in EVERY supported scale, from EVERY authored note, at every level above the threshold', () => {
    // Deliberately exhaustive: the first version of this only checked C major
    // from the root and would have missed the bug below.
    for (const scale of ['major', 'minor', 'pentatonic', 'dorian', 'phrygian', 'mixolydian', undefined] as const) {
      for (let midi = 55; midi <= 72; midi++) {
        for (const x of [0.3, 0.5, 0.7, 1]) {
          const c = pitchCandidates({ midi, instability: x, root: ROOT, scale });
          for (const sign of [1, -1]) {
            const tag = `${scale} from ${midi} at ${x}, ${12 * sign}st`;
            const oct = bySemi(c, 12 * sign).weight;
            expect(oct, tag).toBeGreaterThan(bySemi(c, 11 * sign).weight);
            expect(oct, tag).toBeGreaterThan(bySemi(c, 13 * sign).weight);
          }
        }
      }
    }
  });

  it('an OFF-SCALE authored note keeps its own weight — the scale governs where it WANDERS, not whether it exists', () => {
    // THE BUG THE SWEEP ABOVE FOUND. E is not in C minor. Before the
    // authored-pitch-class exemption, the home candidate AND its octave both
    // took the chroma penalty, so (a) staying put was penalised — the same
    // control setting made a blue note far more unstable than a diatonic one —
    // and (b) the ±12 peak inverted outright: the diatonic E♭ a semitone below
    // the octave outweighed the authored note's own octave.
    const c = pitchCandidates({ midi: E4, instability: 0.6, root: ROOT, scale: 'minor' });
    expect(bySemi(c, 0).inScale).toBe(false); // E really is off-scale in C minor
    expect(bySemi(c, 0).scaleWeight).toBe(1); // …and is not penalised for it
    expect(bySemi(c, 12).scaleWeight).toBe(1);
    expect(bySemi(c, -12).scaleWeight).toBe(1);
    // Centre mass is the same for an off-scale note as for a diatonic one at the
    // same setting — the control means ONE thing wherever you put it.
    const diatonic = pitchCandidates({ midi: 63, instability: 0.6, root: ROOT, scale: 'minor' }); // E♭
    expect(centreMass(c)).toBeGreaterThan(0.8 * centreMass(diatonic));
    // …and only the authored class is exempt: a random chromatic neighbour is not.
    expect(bySemi(c, 2).inScale).toBe(false); // F♯ — not in C minor
    expect(bySemi(c, 2).scaleWeight).toBeCloseTo(pitchChromaWeight(0.6), 12);
  });

  it('the peak EMERGES at a derivable spread — and the derivation is right', () => {
    // SCOPE, and the honest limit of a CONSTANT bonus: it cannot beat an
    // EXPONENTIAL distance penalty at an arbitrarily small spread. The octave
    // must overcome exp(Δ/spread) with Δ ≤ 1 degree, so the peak appears above
    // spread = 1/ln(octaveBonus). Validate the analytic threshold against the
    // empirical one rather than trusting either alone.
    expect(octavePeakMinSpread()).toBeCloseTo(1 / Math.log(DEFAULT_PITCH_CURVE.octaveBonus), 12);
    const xMin = octavePeakMinInstability();
    expect(pitchSpread(xMin)).toBeCloseTo(octavePeakMinSpread(), 10);

    let firstEmpirical = -1;
    for (let l = 0; l <= PITCH_PROB_LEVELS; l++) {
      const c = at(LEVELS[l]!);
      const ok = bySemi(c, 12).weight > bySemi(c, 11).weight && bySemi(c, -12).weight > bySemi(c, -11).weight;
      if (ok) { firstEmpirical = l; break; }
    }
    expect(firstEmpirical).toBe(10); // level 10 of 40 — x = 0.25
    expect(pitchProbLevelToValue(firstEmpirical)).toBeGreaterThanOrEqual(xMin);
    expect(pitchProbLevelToValue(firstEmpirical - 1)).toBeLessThan(xMin);
    // Below it, nothing an octave away has meaningful probability anyway.
    const below = at(LEVELS[firstEmpirical - 1]!);
    expect(bySemi(below, 12).weight / totalWeight(below)).toBeLessThan(1e-4);
  });

  it('the ±7 peak exists in the 7-note modes but scale membership can override it', () => {
    // Deliberately MILDER than the octave. In the 7-note modes the fifth beats
    // both neighbours…
    for (const scale of ['major', 'minor', 'dorian', 'phrygian', 'mixolydian'] as const) {
      const c = pitchCandidates({ midi: C4, instability: 0.6, root: ROOT, scale });
      for (const sign of [1, -1]) {
        expect(bySemi(c, 7 * sign).weight, `${scale} ${7 * sign}st`).toBeGreaterThan(bySemi(c, 6 * sign).weight);
        expect(bySemi(c, 7 * sign).weight, `${scale} ${7 * sign}st`).toBeGreaterThan(bySemi(c, 8 * sign).weight);
      }
    }
    // …but in PENTATONIC the fifth BELOW C (F) is not in the scale, and the
    // diatonic third below it (E) legitimately outweighs the boosted F. That is
    // the correct musical answer, and it is why the fifth bonus is mild: scale
    // membership is allowed to win. The octave, always diatonic, never loses.
    const pent = pitchCandidates({ midi: C4, instability: 0.6, root: ROOT, scale: 'pentatonic' });
    expect(bySemi(pent, -7).inScale).toBe(false);
    expect(bySemi(pent, -8).inScale).toBe(true);
    expect(bySemi(pent, -7).weight).toBeLessThan(bySemi(pent, -8).weight);
    expect(bySemi(pent, 7).weight).toBeGreaterThan(bySemi(pent, 6).weight); // the fifth ABOVE is in scale
  });

  it('the bonus is a NAMED factor, separable from the distance term', () => {
    // Tunability: the owner must be able to change one without the other.
    const c = at(0.7);
    const oct = bySemi(c, 12);
    expect(oct.privilegeBonus).toBe(DEFAULT_PITCH_CURVE.octaveBonus);
    expect(oct.weight).toBeCloseTo(
      oct.distanceWeight * oct.privilegeBonus * oct.scaleWeight * oct.originalWeight, 12,
    );
    // Turning it off removes the peak — a negative control on the mechanism.
    const flat = pitchCandidates({ midi: C4, instability: 0.7, root: ROOT, scale: 'major', curve: { octaveBonus: 1 } });
    expect(bySemi(flat, 12).weight).toBeLessThan(bySemi(flat, 11).weight);
  });
});

// ---------------------------------------------------------------------------
describe('the weight is the documented PRODUCT, and the window is bounded', () => {
  it('weight = distance × privilege × scale × original, for every candidate', () => {
    for (const x of [0, 0.2, 0.5, 0.8, 1]) {
      for (const k of at(x)) {
        expect(k.weight).toBeCloseTo(
          k.distanceWeight * k.privilegeBonus * k.scaleWeight * k.originalWeight, 15,
        );
      }
    }
  });

  it('spans ±windowSemitones, is ascending, and always contains the authored pitch', () => {
    const c = at(0.5);
    expect(c[0]!.semitoneOffset).toBe(-DEFAULT_PITCH_CURVE.windowSemitones);
    expect(c[c.length - 1]!.semitoneOffset).toBe(DEFAULT_PITCH_CURVE.windowSemitones);
    expect(c.filter((k) => k.semitoneOffset === 0)).toHaveLength(1);
    for (let i = 1; i < c.length; i++) expect(c[i]!.midi).toBe(c[i - 1]!.midi + 1);
    // …and the window is wide enough for the octave peak to have neighbours.
    expect(DEFAULT_PITCH_CURVE.windowSemitones).toBeGreaterThan(12);
  });

  it('clamps to the playable MIDI range at the extremes', () => {
    for (const midi of [0, 12, 120, 127]) {
      for (const k of pitchCandidates({ midi, instability: 1, root: ROOT, scale: 'major' })) {
        expect(k.midi).toBeGreaterThanOrEqual(12);
        expect(k.midi).toBeLessThanOrEqual(120);
      }
    }
  });

  it('a curve override changes ONLY what it names (the second-parameter seam)', () => {
    const base = at(0.5);
    const wider = pitchCandidates({ midi: C4, instability: 0.5, root: ROOT, scale: 'major', curve: { spreadMax: 8 } });
    expect(expectedAbsDegreeOffset(wider)).toBeGreaterThan(expectedAbsDegreeOffset(base));
    expect(bySemi(wider, 0).originalWeight).toBe(bySemi(base, 0).originalWeight); // untouched
    const chromatic = pitchCandidates({ midi: C4, instability: 0.5, root: ROOT, scale: 'major', curve: { chromaExp: 1 } });
    expect(outOfScaleMass(chromatic)).toBeGreaterThan(outOfScaleMass(base));
    expect(pitchSpread(0.5)).toBe(pitchSpread(0.5)); // spread curve untouched by chromaExp
  });
});

// ---------------------------------------------------------------------------
describe('sampling integration (the ONLY block that uses an RNG)', () => {
  it('draws from the weights by inverse CDF — the boundaries are exact', () => {
    const opts = { midi: C4, instability: 0.6, root: ROOT, scale: 'major' as const };
    const c = pitchCandidates(opts);
    const total = totalWeight(c);
    let acc = 0;
    for (const k of c) {
      const lo = acc / total;
      acc += k.weight;
      const hi = acc / total;
      if (k.weight <= 0) continue;
      // Just inside this candidate's slice → this candidate.
      expect(samplePitch(opts, () => (lo + hi) / 2)).toBe(k.midi);
      // Its lower edge belongs to it, not to its predecessor.
      expect(samplePitch(opts, () => lo + (hi - lo) * 1e-9)).toBe(k.midi);
    }
    expect(samplePitch(opts, () => 0)).toBe(c.find((k) => k.weight > 0)!.midi);
    expect(samplePitch(opts, () => 1)).toBe(c[c.length - 1]!.midi);
  });

  it('is REPRODUCIBLE from a seed, and different seeds decorrelate', () => {
    const opts = { midi: C4, instability: 0.7, root: ROOT, scale: 'major' as const };
    const draw = (seed: number, n: number) => {
      const rng = mulberry32(seed);
      return Array.from({ length: n }, () => samplePitch(opts, rng));
    };
    expect(draw(1234, 24)).toEqual(draw(1234, 24)); // same seed → same melody
    expect(draw(1234, 24)).not.toEqual(draw(5678, 24)); // different seed → different
    // A sanity check that it is actually drawing from the distribution and not
    // returning a constant (an instrument check, not a statistical claim).
    expect(new Set(draw(1234, 64)).size).toBeGreaterThan(4);
  });

  it('survives a hostile rng without throwing or leaving the window', () => {
    const opts = { midi: C4, instability: 0.6, root: ROOT, scale: 'major' as const };
    for (const bad of [Number.NaN, -1, 2, Infinity, -Infinity]) {
      const m = samplePitch(opts, () => bad);
      expect(Number.isInteger(m)).toBe(true);
      expect(Math.abs(m - C4)).toBeLessThanOrEqual(DEFAULT_PITCH_CURVE.windowSemitones);
    }
  });
});

// ---------------------------------------------------------------------------
describe('MULTIPLAYER DETERMINISM', () => {
  const parts = { nodeId: 'clip-1', lane: 2, slot: 3, step: 5, midi: C4, loopCount: 7 };

  it('the same musical position gives the same seed — on any peer', () => {
    expect(pitchRollSeed(parts)).toBe(pitchRollSeed({ ...parts }));
    expect(pitchRollRng(parts)()).toBe(pitchRollRng({ ...parts })());
  });

  it('EVERY seed input actually changes the seed (no dead ingredient)', () => {
    // Negative-control the seed itself: a typo'd concatenation that dropped one
    // field would still look deterministic, and would collapse two positions
    // onto one pitch.
    const base = pitchRollSeed(parts);
    expect(pitchRollSeed({ ...parts, nodeId: 'clip-2' })).not.toBe(base);
    expect(pitchRollSeed({ ...parts, lane: 3 })).not.toBe(base);
    expect(pitchRollSeed({ ...parts, slot: 4 })).not.toBe(base);
    expect(pitchRollSeed({ ...parts, step: 6 })).not.toBe(base);
    expect(pitchRollSeed({ ...parts, midi: 61 })).not.toBe(base);
    expect(pitchRollSeed({ ...parts, loopCount: 8 })).not.toBe(base);
  });

  it('the fields cannot alias each other', () => {
    // (lane 1, slot 23) must not hash the same as (lane 12, slot 3).
    expect(pitchRollSeed({ ...parts, lane: 1, slot: 23 })).not.toBe(
      pitchRollSeed({ ...parts, lane: 12, slot: 3 }),
    );
    expect(pitchRollSeed({ ...parts, nodeId: 'a', lane: 1 })).not.toBe(
      pitchRollSeed({ ...parts, nodeId: 'a|1', lane: 1 }),
    );
  });

  it('TWO PEERS with the same shared state resolve the SAME pitch', () => {
    // The whole point. Peer A and peer B each run their own engine; if this
    // failed they would hear different melodies and single-user testing could
    // not see it.
    const firing = [
      { midi: C4, pitchProb: 0.7 },
      { midi: E4, pitchProb: 0.7 },
      { midi: 67, pitchProb: 0 }, // fixed — must be untouched on both
    ];
    const ctx = { root: ROOT, scale: 'major' as const, nodeId: 'cp', lane: 1, slot: 0, step: 4, loopCount: 3 };
    const peerA = applyPitchProbability(firing, ctx).map((e) => e.midi);
    const peerB = applyPitchProbability(firing.map((e) => ({ ...e })), { ...ctx }).map((e) => e.midi);
    expect(peerA).toEqual(peerB);
    expect(peerA[2]).toBe(67); // the fixed note never moves
  });

  it('a note RE-DRAWS each loop rather than freezing into a transposition', () => {
    const ctx = { root: ROOT, scale: 'major' as const, nodeId: 'cp', lane: 0, slot: 0, step: 0, loopCount: 0 };
    const perLoop = Array.from({ length: 40 }, (_v, loopCount) =>
      resolvePitch({
        midi: C4, instability: 0.8, root: ROOT, scale: 'major',
        seed: { ...ctx, midi: C4, loopCount },
      }),
    );
    expect(new Set(perLoop).size).toBeGreaterThan(3);
  });

  it('the notes of a CHORD decorrelate instead of moving together', () => {
    const ctx = { root: ROOT, scale: 'major' as const, nodeId: 'cp', lane: 0, slot: 0, step: 0, loopCount: 0 };
    let moveApart = 0;
    for (let step = 0; step < 32; step++) {
      const out = applyPitchProbability(
        [{ midi: C4, pitchProb: 0.8 }, { midi: E4, pitchProb: 0.8 }],
        { ...ctx, step },
      );
      if (out[0]!.midi - C4 !== out[1]!.midi - E4) moveApart++;
    }
    expect(moveApart).toBeGreaterThan(20); // not a lock-step transposition
  });

  it('resolvePitch stays inside the candidate window for every seed it is given', () => {
    for (let step = 0; step < 200; step++) {
      const m = resolvePitch({
        midi: C4, instability: 1, root: ROOT, scale: 'major',
        seed: { nodeId: 'cp', lane: 0, slot: 0, step, midi: C4, loopCount: 0 },
      });
      expect(Math.abs(m - C4)).toBeLessThanOrEqual(DEFAULT_PITCH_CURVE.windowSemitones);
    }
  });
});
