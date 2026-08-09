// packages/web/src/lib/audio/pitch-probability.ts
//
// PER-NOTE PITCH PROBABILITY — the clip player's third per-note performance
// control, alongside PROBABILITY (a firing chance) and PLAY EVERY (a loop
// divider). PURE math: no Svelte, no Yjs, no engine (the `poly-alloc.ts`
// convention), so the whole model is unit-testable in milliseconds.
//
// ── THE MODEL ──────────────────────────────────────────────────────────────
//
// ONE macro parameter — *pitch instability*, `x` ∈ [0,1] — not three parameters
// hidden behind a knob. Turning it up progressively loosens the note's identity:
//
//     x = 0.00   fixed pitch        the authored note, exactly, always
//     x ≈ 0.25   ornamentation      occasional neighbouring scale degrees
//     x ≈ 0.50   melodic variation  frequent, but local and near-entirely diatonic
//     x ≈ 0.75   reharmonisation    wide diatonic leaps, chromatic notes creeping in
//     x = 1.00   atonality          chromatic notes weighted like diatonic ones
//
// Each firing note draws its pitch from a WEIGHTED CANDIDATE DISTRIBUTION over
// nearby pitches. Every candidate's weight is a product of independent factors:
//
//     weight = distanceWeight × privilegeBonus × scaleWeight × originalWeight
//
//   · distanceWeight  exp(-|offset| / spread) — a LAPLACIAN (two-sided
//     exponential) over SCALE-DEGREE distance. Large excursions stay possible
//     but are exponentially rarer than small ones. Deliberately NOT uniform:
//     uniform sounds like a broken RNG, not like a musician.
//   · privilegeBonus  a secondary peak at ±12 (octave) and ±7 (fifth) semitones.
//     An octave preserves musical identity far better than a tritone does,
//     despite being numerically much farther away. This is the single thing that
//     stops the result sounding like generic random pitch.
//   · scaleWeight     1 for an in-scale candidate; a GRADUALLY rising fraction
//     for an out-of-scale one. Scale membership is a weighting, never a binary
//     switch — chromatic notes fade in, they don't flip on. The AUTHORED PITCH
//     CLASS is always exempt: the clip's scale governs where a note may wander
//     TO, never whether the note you wrote is allowed to exist.
//   · originalWeight  extra mass on offset 0 that DECAYS as x rises. This is
//     what "lowers the special weighting of the original pitch" as x grows.
//
// The single parameter drives all three curves at DIFFERENT RATES, which is what
// makes the behaviours arrive in the order listed above:
//
//     spread(x)   ∝ x^1.5     — the distribution widens early
//     chroma(x)   ∝ x⁴        — out-of-scale weight arrives LATE
//     original(x) ∝ (1-x)^2.5 — the home-note bonus melts away in the middle
//
// (The design called for spread ∝ x². Measured, x² leaves roughly the bottom
// QUARTER of the 40-step control inaudible — at level 11 of 40 the chance of any
// mutation is still under 1 %, and the two lowest levels are not merely small but
// *bit-identical* to off, because exp(-1/spread) underflows against the home
// weight in double precision. x^1.5 preserves the whole point of the exponent —
// spread arrives well before chroma, 1.5 ≪ 4 — while cutting the dead zone to
// ~7 of 40 levels. The exponent is a named constant; put it back to 2 to hear
// the difference.)
//
// There is deliberately NO separate "probability of variation". The chance of
// staying on the authored pitch is simply the CENTRE MASS of the distribution —
// an emergent consequence of the shape, not a fourth knob.
//
// ── WHY x = 0 IS EXACT, NOT NEARLY EXACT ───────────────────────────────────
//
// `spread(0)` is exactly 0, so for every non-zero offset the distance term is
// `Math.exp(-d / 0)` = `Math.exp(-Infinity)` = **exactly 0.0** in IEEE-754 — not
// "very small". The offset-0 candidate is defined as weight 1 without dividing
// (exp(0) = 1 for any spread). So x = 0 collapses the distribution to a point
// mass on the authored pitch BY CONSTRUCTION, with no special-case branch and
// no "probability of variation" scalar smuggled in. `pitchProbLevel` 0 also
// deletes the stored key entirely, so an untouched note is byte-identical to a
// pre-feature one.
//
// ── SCALE DEGREES, NOT SEMITONES ───────────────────────────────────────────
//
// Offsets are measured in SCALE DEGREES via the clip's own root+scale row math
// (`rowToMidi` / `midiToRow` in clip-types.ts — the same rows the piano roll
// draws). Offset ±1 from E in C major is D or F, not D#/F. Generating ±N
// semitones and quantising afterwards is a different, less legible instrument:
// it makes the *semitone* distance uniform and the *degree* distance lumpy.
//
// An OUT-OF-SCALE candidate has no integer degree, so it gets a FRACTIONAL one
// by linear interpolation between the scale rows either side (C# in C major sits
// at degree 0.5, between C=0 and D=1). That keeps one distance metric for both
// families, which is what lets the two be compared in a single product.
//
// A CHROMATIC clip (no scale set) has all 12 semitones as degrees, so every
// candidate is "in scale" and the chroma curve is inert — the model degrades to
// a pure semitone Laplacian, which is the musically correct reading of "this
// clip has no key".
//
// ── MULTIPLAYER DETERMINISM ────────────────────────────────────────────────
//
// Every peer runs its own engine, so an unseeded `Math.random()` per peer means
// collaborators hear DIFFERENT NOTES — invisible in single-user testing. The
// pitch draw is therefore seeded from values every peer already agrees on:
// `pitchRollSeed(nodeId, lane, slot, step, midi, loopCount)`. See its doc
// comment for the full argument, and for the caveat it inherits from PLAY EVERY.
//
// ── ADDING A SECOND PARAMETER LATER ────────────────────────────────────────
//
// The design collapses three dimensions into one on purpose, but the owner may
// want one back. Every curve lives in a `PitchProbCurve` record with documented
// named constants; `DEFAULT_PITCH_CURVE` is the single macro-parameter tuning.
// A second control is a `Partial<PitchProbCurve>` override threaded through
// `PitchCandidateOpts.curve` — no call site changes, no rewrite. E.g. a
// "chromaticism" knob is `{ chromaMax }`, a "range" knob is `{ spreadMax }`.

import {
  scaleSteps,
  rowToMidi,
} from '$lib/audio/modules/clip-types';
import { MIN_MIDI, MAX_MIDI } from '$lib/audio/note-entry';
import { mulberry32, fnv1a32 } from '$lib/sync/prng';
import type { ScaleName } from '$lib/mike/music-theory';

// ---------------------------------------------------------------------------
// LEVEL DOMAIN — 40 increments, matching the existing per-note PROBABILITY
// ---------------------------------------------------------------------------
//
// Owner: "to stay consistent with our other %'s for eventual push/launchpad
// use, lets make sure we choose a number of intervals that's a multiple of 8,
// maybe 40 increments so we'd use 5 rows of launchpad lights."
//
// The existing PROBABILITY control (clip-types.ts) is `PROB_LEVELS = 40` levels
// of `PROB_STEP = 0.025`, stored as a raw 0..1 float on the note and coerced at
// the load boundary. This matches that convention EXACTLY — same 2.5% grid, same
// raw-float storage, same clamp-on-coerce.
//
// ⚠ ONE DELIBERATE DIFFERENCE, and it is forced by the semantics. PROBABILITY's
// levels run 1..40 with no level 0, because a 0% note never fires (useless) and
// the UI keeps it visible at level 1. Pitch instability's zero IS the default —
// "leave this note alone" — so its levels run 0..40: forty increments ABOVE an
// off state. On a Launchpad's 5 rows that reads directly as "N of 40 pads lit",
// with none lit at off, which is the count bar the owner asked for.
/** Number of pitch-instability INCREMENTS (a multiple of 8 → 5 Launchpad rows).
 *  Levels run 0..PITCH_PROB_LEVELS; level 0 = off (the authored pitch, exactly). */
export const PITCH_PROB_LEVELS = 40;
/** Value per level — 0.025, the SAME 2.5% grid as clip-types' `PROB_STEP`. */
export const PITCH_PROB_STEP = 1 / PITCH_PROB_LEVELS;

/** UI level (0..PITCH_PROB_LEVELS) → its 0..1 instability value. Level 0 → 0
 *  exactly (the authored pitch); level 40 → 1 exactly.
 *  ⚠ DIVIDES by the level count rather than multiplying by `PITCH_PROB_STEP`
 *  (which is what `probLevelToValue` does): `24 * 0.025` is
 *  0.6000000000000001 in binary floating point, `24 / 40` is exactly 0.6. Same
 *  grid, same round trip, cleaner stored value. PURE. */
export function pitchProbLevelToValue(level: number): number {
  const n = Math.max(0, Math.min(PITCH_PROB_LEVELS, Math.round(Number(level) || 0)));
  return n / PITCH_PROB_LEVELS;
}

/** A 0..1 instability → its UI level (0..PITCH_PROB_LEVELS), nearest 2.5% step.
 *  Non-finite ⇒ 0 (off). PURE. */
export function valueToPitchProbLevel(value: number): number {
  const v = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  return Math.max(0, Math.min(PITCH_PROB_LEVELS, Math.round(v / PITCH_PROB_STEP)));
}

/** Format an instability value as its menu label: `off` at 0, else a percent
 *  with the same integer/half-step rule as `probPctLabel`. PURE. */
export function pitchProbLabel(value: number): string {
  if (!(value > 0)) return 'off';
  const pct = value * 100;
  return (Number.isInteger(pct) ? pct.toFixed(0) : pct.toFixed(1)) + '%';
}

// ---------------------------------------------------------------------------
// TUNING — every curve exponent and privileged-interval bonus, named + measured
// ---------------------------------------------------------------------------
//
// The owner intends to experiment with these ("i want to first start by messing
// with this"), so they are ONE documented record rather than magic numbers
// buried in the arithmetic. The measured behaviour of DEFAULT_PITCH_CURVE
// (C major, note = the root; the ladder is PINNED in `pitch-probability.test.ts`
// so a tuning edit shows up as a readable diff rather than silently):
//
//   level  x      centre mass   out-of-scale   spread   E|degree move|
//     0    0.00      100.0 %          0.0 %      0.00        0.000
//    10    0.25       93.9 %          0.0 %      0.50        0.071
//    16    0.40       71.2 %          0.7 %      1.01        0.514
//    20    0.50       50.2 %          2.4 %      1.41        1.176
//    24    0.60       31.6 %          5.7 %      1.86        1.998
//    32    0.80       11.9 %         16.6 %      2.86        3.287
//    40    1.00        6.0 %         31.5 %      4.00        3.911
//
// Two measured properties of this tuning worth knowing before you retune:
//   · levels 1–6 move fewer than 1 note in 100, and level 1 is BIT-IDENTICAL to
//     off (the neighbour weight underflows against the home weight in double
//     precision). That is the price of `spread(0) = 0`, which is what buys the
//     exact identity at level 0. Lower `originalBonusMax` or `spreadExp` to
//     shorten that tail.
//   · the ±12 peak only DOMINATES its neighbours once the spread is wide enough
//     for a constant bonus to beat an exponential penalty — see
//     `octavePeakMinInstability` (level 10 of 40 at this tuning).
//
export interface PitchProbCurve {
  /** Laplacian spread at FULL instability, in SCALE DEGREES. 4 degrees ≈ a
   *  fifth-and-a-bit in a 7-note scale; excursions beyond it are rare but live. */
  spreadMax: number;
  /** Exponent on the spread ramp: `spread(x) = spreadMax · x^spreadExp`. Well
   *  below `chromaExp`, so the distribution widens EARLY relative to the chroma
   *  ramp — the arrival ordering the design requires. `spread(0) = 0` is what
   *  makes x=0 an exact identity. (Design said 2; see the header note on why
   *  this ships at 1.5.) */
  spreadExp: number;
  /** Out-of-scale weight at FULL instability, relative to in-scale (1). 1 =
   *  chromatic notes are weighted exactly like diatonic ones — atonality. */
  chromaMax: number;
  /** Exponent on the chroma ramp: `chroma(x) = chromaMax · x^chromaExp`. 4 makes
   *  out-of-scale weight arrive LATE — at x=0.5 it is 0.5⁴ = 6.25 % of full, so
   *  the mid-range stays near-entirely diatonic while already mutating freely. */
  chromaExp: number;
  /** Extra multiplicative mass on the offset-0 candidate at x→0, above the 1
   *  every candidate starts with. Sets how sticky the home note is early on. */
  originalBonusMax: number;
  /** Exponent on the home-note decay: `original(x) = 1 + originalBonusMax ·
   *  (1-x)^originalExp`. Melts the bonus away through the middle of the range,
   *  which is what turns "ornamentation" into "melodic variation". */
  originalExp: number;
  /** Multiplier on a candidate exactly ±12 semitones away. An octave preserves
   *  identity, so it gets a secondary peak that beats its neighbours despite
   *  being numerically farther. Measured at x=0.5, C major, note = C: +12
   *  outweighs +11 by 3.9× and +13 by 182×; −12 outweighs −11 by 90× and −13 by
   *  16×. (The asymmetry is the scale's own: B is a semitone below C but a whole
   *  tone above B♭.) Holds in EVERY supported scale above
   *  `octavePeakMinInstability`. */
  octaveBonus: number;
  /** Multiplier on a candidate exactly ±7 semitones away (a perfect fifth). The
   *  owner said "consider ±7" — kept deliberately MILDER than the octave (2.7×
   *  to 170× over its neighbours across the range, vs the octave's 4–2000×).
   *  ⚠ Unlike the octave it does NOT always win, and shouldn't: in PENTATONIC
   *  the fifth BELOW the root (F in C pentatonic) is out of scale, so the
   *  diatonic third below it legitimately outweighs the boosted fifth. A mild
   *  bonus that scale membership can override is the musically right behaviour;
   *  the octave, always diatonic, is never overridden. */
  fifthBonus: number;
  /** Half-width of the candidate window in SEMITONES. Must exceed 12 so the
   *  octave peak has neighbours either side of it; 19 (octave + fifth) bounds
   *  the tail at ~exp(-11/4) ≈ 6 % of centre at full spread. */
  windowSemitones: number;
}

/** The single-macro-parameter tuning. See the table above for its measured
 *  centre-mass / out-of-scale / spread ladder across the 40 levels. */
export const DEFAULT_PITCH_CURVE: PitchProbCurve = {
  spreadMax: 4,
  spreadExp: 1.5,
  chromaMax: 1,
  chromaExp: 4,
  originalBonusMax: 8,
  originalExp: 2.5,
  octaveBonus: 8,
  fifthBonus: 3,
  windowSemitones: 19,
};

/** Clamp a raw instability to 0..1; non-finite ⇒ 0 (off). PURE. */
export function clampInstability(x: unknown): number {
  const v = Number(x);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

/** Laplacian SPREAD in scale degrees at instability `x`: `spreadMax · x^spreadExp`.
 *  Exactly 0 at x=0 — the property that makes the x=0 distribution a point mass
 *  without a special-case branch. Monotonically increasing. PURE. */
export function pitchSpread(x: number, curve: PitchProbCurve = DEFAULT_PITCH_CURVE): number {
  return curve.spreadMax * Math.pow(clampInstability(x), curve.spreadExp);
}

/** OUT-OF-SCALE weight (relative to an in-scale 1) at instability `x`:
 *  `chromaMax · x^chromaExp`. Rises LATER than `pitchSpread` by construction —
 *  `x^chromaExp < x^spreadExp` on (0,1) whenever `chromaExp > spreadExp`, which
 *  is the design's arrival ordering (4 vs 1.5 here, asserted in the tests). PURE. */
export function pitchChromaWeight(x: number, curve: PitchProbCurve = DEFAULT_PITCH_CURVE): number {
  return curve.chromaMax * Math.pow(clampInstability(x), curve.chromaExp);
}

/** The ORIGINAL-pitch weight multiplier at instability `x`:
 *  `1 + originalBonusMax · (1-x)^originalExp`. Decays to exactly 1 at x=1 (the
 *  authored pitch loses every privilege). PURE. */
export function pitchOriginalWeight(x: number, curve: PitchProbCurve = DEFAULT_PITCH_CURVE): number {
  return 1 + curve.originalBonusMax * Math.pow(1 - clampInstability(x), curve.originalExp);
}

/** The PRIVILEGED-INTERVAL bonus for a semitone offset — the secondary peaks at
 *  ±12 (octave) and ±7 (fifth). 1 for every other interval. PURE. */
export function privilegedIntervalBonus(
  semitoneOffset: number,
  curve: PitchProbCurve = DEFAULT_PITCH_CURVE,
): number {
  const s = Math.abs(semitoneOffset);
  if (s === 12) return curve.octaveBonus;
  if (s === 7) return curve.fifthBonus;
  return 1;
}

/**
 * The SMALLEST spread (in degrees) at which the ±12 candidate is guaranteed to
 * out-weigh its semitone neighbours in ANY scale.
 *
 * A CONSTANT multiplicative bonus cannot beat an EXPONENTIAL distance penalty at
 * an arbitrarily small spread: the octave must overcome `exp(Δ/spread)` where Δ
 * is its degree gap from the neighbour. Δ ≤ 1 for every supported scale (it is
 * exactly 1 when both the octave and the note a semitone below it are diatonic,
 * as in the 7-note modes; smaller when the neighbour is chromatic), so
 * `spread > 1 / ln(octaveBonus)` is sufficient everywhere. Below it the peak
 * simply has not emerged yet — and at that spread nothing an octave away has
 * meaningful probability anyway. PURE.
 */
export function octavePeakMinSpread(curve: PitchProbCurve = DEFAULT_PITCH_CURVE): number {
  return 1 / Math.log(curve.octaveBonus);
}

/** `octavePeakMinSpread` expressed back in the parameter's own units — the
 *  instability at/above which the ±12 secondary peak dominates. 0.244 (level 10
 *  of 40) at the default tuning. PURE. */
export function octavePeakMinInstability(curve: PitchProbCurve = DEFAULT_PITCH_CURVE): number {
  return Math.pow(octavePeakMinSpread(curve) / curve.spreadMax, 1 / curve.spreadExp);
}

// ---------------------------------------------------------------------------
// SCALE-DEGREE GEOMETRY
// ---------------------------------------------------------------------------

/**
 * The clip's editor ROW for a MIDI note, FRACTIONAL for an out-of-scale note.
 *
 * `midiToRow` (clip-types) returns null for anything off the scale, which is
 * right for the piano roll — there is no row to draw. But the distance model
 * needs ONE metric that both diatonic and chromatic candidates can be measured
 * in, so an off-scale note is placed by LINEAR INTERPOLATION between the scale
 * rows either side of it: in C major, C# sits at 0.5 (between C=0 and D=1) and
 * D# at 1.5. Whole rows are returned exactly (no float drift) for in-scale
 * notes, so `Number.isInteger(fractionalRow(...))` is the in-scale predicate.
 *
 * Strictly increasing in `midi`, so the row axis stays an ordered line. PURE.
 */
export function fractionalRow(midi: number, root: number, scale?: ScaleName): number {
  const steps = scaleSteps(scale);
  const n = steps.length;
  const rel = midi - root;
  const octave = Math.floor(rel / 12);
  const within = ((rel % 12) + 12) % 12;
  // Largest scale degree at or below `within` (steps[0] is always 0, so this
  // always finds one).
  let i = 0;
  for (let k = 0; k < n; k++) if (steps[k]! <= within) i = k;
  const lower = steps[i]!;
  if (lower === within) return octave * n + i; // in scale — an exact integer row
  const upper = i + 1 < n ? steps[i + 1]! : 12; // past the last degree → next root
  return octave * n + i + (within - lower) / (upper - lower);
}

/** True when `midi` is ON the clip's scale (an exact editor row exists). A
 *  chromatic clip (no scale) puts every semitone on a row, so this is always
 *  true there. PURE. */
export function isOnScale(midi: number, root: number, scale?: ScaleName): boolean {
  return Number.isInteger(fractionalRow(midi, root, scale));
}

// ---------------------------------------------------------------------------
// THE CANDIDATE DISTRIBUTION
// ---------------------------------------------------------------------------

/** One pitch the note may land on, with its weight fully decomposed so a test
 *  can assert each factor rather than a sampled histogram. */
export interface PitchCandidate {
  /** The candidate MIDI note. */
  midi: number;
  /** Signed SCALE-DEGREE offset from the authored pitch (fractional off-scale). */
  degreeOffset: number;
  /** Signed SEMITONE offset from the authored pitch (what the ear hears). */
  semitoneOffset: number;
  /** Whether the candidate is on the clip's scale. Reports the TRUTH — it is not
   *  the same thing as `scaleWeight`, which also exempts the authored pitch
   *  class (see `pitchCandidates`). */
  inScale: boolean;
  /** `exp(-|degreeOffset| / spread)` — exactly 1 at offset 0, exactly 0 for any
   *  other offset when spread is 0. */
  distanceWeight: number;
  /** ±12 / ±7 secondary-peak multiplier (1 elsewhere). */
  privilegeBonus: number;
  /** 1 in scale OR in the AUTHORED pitch class; `pitchChromaWeight(x)` otherwise. */
  scaleWeight: number;
  /** `pitchOriginalWeight(x)` on offset 0; 1 on every other candidate. */
  originalWeight: number;
  /** The product of the four factors above. */
  weight: number;
}

export interface PitchCandidateOpts {
  /** The authored MIDI note. */
  midi: number;
  /** Instability 0..1 (`pitchProbLevelToValue(level)`). */
  instability: number;
  /** The clip's root (MIDI) — the degree grid's origin. */
  root: number;
  /** The clip's scale; undefined = chromatic (every semitone is a degree). */
  scale?: ScaleName;
  /** Curve overrides — the seam a SECOND parameter plugs into later. */
  curve?: Partial<PitchProbCurve>;
}

/**
 * The full weighted candidate distribution for one authored note.
 *
 * Candidates are every playable MIDI note within `windowSemitones` either side
 * of the authored pitch (clamped to the playable range), ordered ascending. The
 * authored pitch itself is always present, always at index `midi - lo`.
 *
 * At instability 0 the authored pitch has weight exactly 1 and EVERY other
 * candidate has weight exactly 0 (see the header note on `spread(0) = 0`).
 *
 * PURE — no allocation beyond the returned array, no RNG, no clock.
 */
export function pitchCandidates(opts: PitchCandidateOpts): PitchCandidate[] {
  const curve = { ...DEFAULT_PITCH_CURVE, ...(opts.curve ?? {}) };
  const x = clampInstability(opts.instability);
  const spread = pitchSpread(x, curve);
  const chroma = pitchChromaWeight(x, curve);
  const original = pitchOriginalWeight(x, curve);
  const root = opts.root;
  const scale = opts.scale;
  const home = Math.round(opts.midi);
  const homeRow = fractionalRow(home, root, scale);
  const w = Math.max(1, Math.round(curve.windowSemitones));
  const lo = Math.max(MIN_MIDI, home - w);
  const hi = Math.min(MAX_MIDI, home + w);

  const out: PitchCandidate[] = [];
  for (let m = lo; m <= hi; m++) {
    const semitoneOffset = m - home;
    const degreeOffset = fractionalRow(m, root, scale) - homeRow;
    const d = Math.abs(degreeOffset);
    const inScale = isOnScale(m, root, scale);
    // exp(0) = 1 for ANY spread, so the home note never divides — and every
    // other candidate divides by a spread that is exactly 0 at x=0, giving
    // exp(-Infinity) = exactly 0. That is what makes x=0 an exact identity.
    const distanceWeight = d === 0 ? 1 : spread > 0 ? Math.exp(-d / spread) : 0;
    const privilegeBonus = privilegedIntervalBonus(semitoneOffset, curve);
    // THE AUTHORED PITCH CLASS IS ALWAYS "IN SCALE" for weighting purposes —
    // the note you wrote, and octaves of it. Without this, a chromatic note in a
    // scaled clip (an E in a C-minor clip, a blue note, a passing tone) has its
    // OWN weight cut by the chroma factor, so the same control setting makes an
    // off-scale note far more unstable than a diatonic one and drags it onto the
    // scale — the control would mean something different depending on which note
    // you put it on. It also broke the ±12 peak outright: a diatonic E♭ a
    // semitone below outweighed the authored note's own octave. Rule, stated
    // once: the clip's scale governs where a note may WANDER TO, never whether
    // the note you authored is allowed to exist. A no-op for an in-scale note
    // (offset 0 and ±12 are already in scale there).
    const samePitchClass = (((semitoneOffset % 12) + 12) % 12) === 0;
    const scaleWeight = inScale || samePitchClass ? 1 : chroma;
    const originalWeight = semitoneOffset === 0 ? original : 1;
    out.push({
      midi: m,
      degreeOffset,
      semitoneOffset,
      inScale,
      distanceWeight,
      privilegeBonus,
      scaleWeight,
      originalWeight,
      weight: distanceWeight * privilegeBonus * scaleWeight * originalWeight,
    });
  }
  return out;
}

/** Total weight of a candidate list (the normalizing constant). PURE. */
export function totalWeight(cands: readonly PitchCandidate[]): number {
  let t = 0;
  for (const c of cands) t += c.weight;
  return t;
}

/** The share of the distribution sitting on the AUTHORED pitch — the emergent
 *  "chance of staying put" (there is no separate variation probability). 1 at
 *  instability 0, monotonically decreasing across the 40 levels. PURE. */
export function centreMass(cands: readonly PitchCandidate[]): number {
  const t = totalWeight(cands);
  if (!(t > 0)) return 1;
  let c = 0;
  for (const k of cands) if (k.semitoneOffset === 0) c += k.weight;
  return c / t;
}

/** The share of the distribution sitting on OUT-OF-SCALE pitches — ~0 at low
 *  instability, arriving later than the spread widens. 0 for a chromatic clip
 *  (nothing is out of scale there). PURE. */
export function outOfScaleMass(cands: readonly PitchCandidate[]): number {
  const t = totalWeight(cands);
  if (!(t > 0)) return 0;
  let c = 0;
  for (const k of cands) if (!k.inScale) c += k.weight;
  return c / t;
}

/**
 * The EXPECTED |degree offset| under the distribution — the spread you can
 * actually hear, measured FROM THE WEIGHTS rather than read off the `spreadMax ·
 * x^spreadExp` parameter.
 *
 * `pitchSpread` is monotone by inspection (it is a power of x), so asserting on
 * it proves nothing about the distribution: it is invariant to every other
 * factor in the product. This reads the REALISED shape, so a privileged-interval
 * bonus, a chroma ramp or a window change that broke the widening would move it.
 * Use THIS as the "spread increases" instrument. PURE.
 */
export function expectedAbsDegreeOffset(cands: readonly PitchCandidate[]): number {
  const t = totalWeight(cands);
  if (!(t > 0)) return 0;
  let s = 0;
  for (const c of cands) s += Math.abs(c.degreeOffset) * c.weight;
  return s / t;
}

/**
 * Draw ONE pitch from the distribution using `rng` (a 0..1 thunk — INJECTED, so
 * tests need no global mocking). Standard inverse-CDF over the cumulative
 * weights. Returns the authored pitch unchanged at instability 0, when the total
 * weight is degenerate, or if `rng` returns something out of range.
 *
 * Deterministic in (opts, rng): the same seeded generator always yields the same
 * pitch, which is what the multiplayer seam below relies on. PURE.
 */
export function samplePitch(opts: PitchCandidateOpts, rng: () => number): number {
  const home = Math.round(opts.midi);
  if (clampInstability(opts.instability) <= 0) return home; // fast path, same result
  const cands = pitchCandidates(opts);
  const total = totalWeight(cands);
  if (!(total > 0)) return home;
  const r = Number(rng());
  const target = (Number.isFinite(r) ? Math.max(0, Math.min(1, r)) : 0) * total;
  let acc = 0;
  for (const c of cands) {
    acc += c.weight;
    if (target < acc) return c.midi;
  }
  return cands[cands.length - 1]!.midi; // r === 1 exactly / float tail
}

// ---------------------------------------------------------------------------
// MULTIPLAYER DETERMINISM
// ---------------------------------------------------------------------------

/** The inputs every peer already agrees on for one note-firing instant. */
export interface PitchRollSeedParts {
  /** The clip-player module's node id (synced graph identity). */
  nodeId: string;
  /** Instrument lane 0..7 (from the synced playing-set). */
  lane: number;
  /** Clip slot within the lane (from the synced playing-set). */
  slot: number;
  /** Step index within the clip. */
  step: number;
  /** The AUTHORED MIDI note — so two notes of a chord mutate independently. */
  midi: number;
  /** The lane's 0-based completed-loop count since launch — the SAME shared
   *  counter PLAY EVERY reads, so a note re-rolls once per pass. */
  loopCount: number;
}

/**
 * A 32-bit seed for one note's pitch draw, derived ONLY from state every peer
 * agrees on. **This is the multiplayer-determinism seam and it is not optional.**
 *
 * Every peer runs its own clip-player engine against the same synced document.
 * An unseeded `Math.random()` therefore gives each peer a DIFFERENT pitch for
 * the same note — collaborators hear different melodies, and single-user testing
 * cannot see it. Seeding from (nodeId, lane, slot, step, midi, loopCount) makes
 * the draw a pure function of the shared musical position:
 *
 *   · nodeId / lane / slot  — graph + synced playing-set identity;
 *   · step                  — position in the clip;
 *   · midi                  — the AUTHORED pitch, so the notes of a chord
 *                             decorrelate instead of all moving together;
 *   · loopCount             — the lane's completed-loop counter, so the same
 *                             note draws a NEW pitch on each pass rather than
 *                             freezing into a fixed transposition.
 *
 * ⚠ INHERITED CAVEAT, stated plainly: `loopCount` is reset to 0 on launch /
 * switch / RST / transport start / peer-adopted switch, so peers converge from
 * the next launch onward rather than instantly. That is exactly the guarantee
 * PLAY EVERY already ships with ("deterministic from the loop count, so
 * collaborators stay in sync"), and this rides the same counter deliberately —
 * a mid-clip joiner is briefly out of phase on BOTH controls, and fixing that is
 * one fix for both, not two.
 *
 * ⚠ SEPARATELY: the existing per-note FIRING probability is NOT deterministic —
 * `clipplayer.ts` rolls it with a live `Math.random()`. See the module note in
 * clipplayer.ts. PURE.
 */
export function pitchRollSeed(parts: PitchRollSeedParts): number {
  // One FNV-1a over a canonical string: cheap, stable across engines, and the
  // pieces cannot alias each other (the separators are not digits).
  return (
    fnv1a32(
      parts.nodeId +
        '|' + Math.trunc(parts.lane) +
        '|' + Math.trunc(parts.slot) +
        '|' + Math.trunc(parts.step) +
        '|' + Math.trunc(parts.midi) +
        '|' + Math.trunc(parts.loopCount),
    ) | 0
  );
}

/** The seeded generator for one note's pitch draw — `mulberry32` (the rack-wide
 *  deterministic PRNG, byte-identical across JS engines). PURE. */
export function pitchRollRng(parts: PitchRollSeedParts): () => number {
  return mulberry32(pitchRollSeed(parts));
}

/**
 * The ONE seam the engine calls: the MIDI note that should actually sound for an
 * authored note at a given musical position, given its pitch instability.
 *
 * Returns the authored pitch unchanged at instability 0 (and for any note with
 * no `pitchProb` key), so a clip that never touches the control is bit-identical
 * to pre-feature playback. Otherwise draws from `pitchCandidates` through a
 * generator seeded by `pitchRollSeed` — identical on every peer. PURE.
 */
export function resolvePitch(
  opts: PitchCandidateOpts & { seed: PitchRollSeedParts },
): number {
  if (clampInstability(opts.instability) <= 0) return Math.round(opts.midi);
  return samplePitch(opts, pitchRollRng(opts.seed));
}

/** Everything the engine knows at one lane-step that the pitch draw needs. */
export interface PitchMutationContext {
  /** The clip's root MIDI (the degree grid's origin). */
  root: number;
  /** The clip's scale; undefined = chromatic. */
  scale?: ScaleName;
  /** Seed inputs — see `pitchRollSeed`. `midi` is filled in per note. */
  nodeId: string;
  lane: number;
  slot: number;
  step: number;
  loopCount: number;
  /** Curve overrides (the future second-parameter seam). */
  curve?: Partial<PitchProbCurve>;
}

/**
 * Map an ALREADY-ROLLED firing set through pitch probability — the single seam
 * the clip-player's tick calls.
 *
 * Returns the SAME ARRAY REFERENCE when no note carries instability, so a clip
 * that never touches the control costs one predicate per note and allocates
 * nothing (playback is then bit-identical to pre-feature). Otherwise returns a
 * new array of shallow-copied events with `midi` replaced, which is what makes
 * the SOUNDED and PRINTED note the same object graph downstream.
 *
 * Generic over the event shape so it needs no import from the clip model. PURE.
 */
export function applyPitchProbability<T extends { midi: number; pitchProb?: number }>(
  firing: readonly T[],
  ctx: PitchMutationContext,
): readonly T[] {
  let any = false;
  for (const ev of firing) {
    if (clampInstability(ev.pitchProb) > 0) {
      any = true;
      break;
    }
  }
  if (!any) return firing; // untouched clip → no allocation, no behaviour change
  return firing.map((ev) => {
    const instability = clampInstability(ev.pitchProb);
    if (instability <= 0) return ev;
    const midi = resolvePitch({
      midi: ev.midi,
      instability,
      root: ctx.root,
      scale: ctx.scale,
      curve: ctx.curve,
      seed: {
        nodeId: ctx.nodeId,
        lane: ctx.lane,
        slot: ctx.slot,
        step: ctx.step,
        midi: ev.midi,
        loopCount: ctx.loopCount,
      },
    });
    return midi === ev.midi ? ev : { ...ev, midi };
  });
}
