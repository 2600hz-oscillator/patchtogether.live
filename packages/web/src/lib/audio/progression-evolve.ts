// packages/web/src/lib/audio/progression-evolve.ts
//
// Pure helpers powering POLYSEQZ's EVOLVE button. Given an array of chord
// steps (root + quality), detect the most likely Western key + mode, then
// apply ONE musically-related mutation per call and return a new steps array.
//
// Everything here is deterministic-given-an-RNG: a `random` seed function is
// injectable so unit tests can drive deterministic outcomes. The module is
// AudioContext-free (no DSP imports) so it loads in vitest without jsdom
// audio shims.
//
// Music-theory glossary (used throughout):
//   - tonic = the "home" pitch class (0..11; 0 = C)
//   - mode  = 'major' | 'minor' (Ionian / Aeolian only — enough harmonic
//             coverage for pop/rock/jazz progressions without a Phrygian
//             rabbit hole)
//   - degree = scale-degree number 1..7 (I, II, III...)
//   - diatonic chord = the triad built on each scale degree using only
//                      scale tones
//
// Mutation rules (1 per call, weighted random):
//   1. Functional substitute swap   (40%) — I↔vi, IV↔ii, V↔vii°
//   2. Secondary dominant           (15%) — V→V7, I→I7, II→II7
//   3. ii-V before existing I       (15%) — insert a leading tone chord
//   4. Tritone substitution         (10%) — V7 → bII7
//   5. Voice-leading smoothing      (10%) — collapse a >5-semi jump
//   6. Quality drift                (10%) — maj→maj7, min→min7, etc.

import type {
  ChordQualityName,
  ChordInversion,
  ChordVoicingName,
} from '$lib/audio/chord-tables';

// ---------------- Public types ----------------

export interface EvolveStep {
  on: boolean;
  root: number | null;
  quality: ChordQualityName;
  inversion: ChordInversion;
  voicing: ChordVoicingName;
}

export type KeyMode = 'major' | 'minor';

export interface DetectedKey {
  tonic: number; // 0..11
  mode: KeyMode;
}

export interface EvolveResult {
  steps: EvolveStep[];
  /** Which rule was applied. 'noop' if no eligible mutation found. */
  rule: MutationRuleName;
  /** Index of the step that changed (or null for noop). */
  changedIndex: number | null;
  /** The detected key used to pick the mutation. */
  key: DetectedKey;
}

export type MutationRuleName =
  | 'functional-substitute'
  | 'secondary-dominant'
  | 'ii-V-insert'
  | 'tritone-sub'
  | 'voice-leading'
  | 'quality-drift'
  | 'noop';

// ---------------- Scale + degree tables ----------------

const MAJOR_SCALE_INTERVALS = [0, 2, 4, 5, 7, 9, 11];
const MINOR_SCALE_INTERVALS = [0, 2, 3, 5, 7, 8, 10];

// Diatonic chord qualities for each scale degree (1..7 → index 0..6).
// We only enforce these at "detection" and "still-related" check time; the
// mutation rules themselves may produce 7th-chords or chromatic colors that
// are not strictly diatonic but musically related.
const MAJOR_DEGREE_QUALITIES: ChordQualityName[] = [
  'maj', 'min', 'min', 'maj', 'maj', 'min', 'dim',
];
const MINOR_DEGREE_QUALITIES: ChordQualityName[] = [
  'min', 'dim', 'maj', 'min', 'min', 'maj', 'maj',
];

function scaleIntervals(mode: KeyMode): ReadonlyArray<number> {
  return mode === 'major' ? MAJOR_SCALE_INTERVALS : MINOR_SCALE_INTERVALS;
}

function degreeQualities(mode: KeyMode): ReadonlyArray<ChordQualityName> {
  return mode === 'major' ? MAJOR_DEGREE_QUALITIES : MINOR_DEGREE_QUALITIES;
}

/** Pitch class (0..11) for `root` MIDI. */
export function pitchClass(root: number): number {
  const r = ((root % 12) + 12) % 12;
  return r;
}

/** Scale-degree (1..7) of `root` in the given key, or 0 if non-diatonic. */
export function degreeInKey(root: number, key: DetectedKey): number {
  const pc = pitchClass(root - key.tonic);
  const ivs = scaleIntervals(key.mode);
  const idx = ivs.indexOf(pc);
  return idx < 0 ? 0 : idx + 1;
}

/** True if the given root is a diatonic scale tone in the key. */
export function isDiatonic(root: number, key: DetectedKey): boolean {
  return degreeInKey(root, key) > 0;
}

// ---------------- Key detection (Krumhansl-Schmuckler-lite) ----------------

/**
 * Detect the most likely Western key + mode by scoring each of the 24
 * candidate keys (12 tonics × major/minor). Score = number of step roots
 * that are diatonic to that key, plus a tie-break bonus for "chord quality
 * matches the diatonic quality for that degree".
 *
 * Empty steps (root=null or on=false) are ignored — they contribute no
 * information. If ALL steps are empty, defaults to C major.
 */
export function detectKey(
  steps: ReadonlyArray<Pick<EvolveStep, 'root' | 'quality' | 'on'>>,
): DetectedKey {
  // Filter to "real" chord events.
  const realSteps = steps.filter((s) => s.on && s.root !== null);
  if (realSteps.length === 0) return { tonic: 0, mode: 'major' };

  let bestScore = -Infinity;
  let best: DetectedKey = { tonic: 0, mode: 'major' };

  for (const mode of ['major', 'minor'] as const) {
    const ivs = scaleIntervals(mode);
    const dqs = degreeQualities(mode);
    for (let tonic = 0; tonic < 12; tonic++) {
      let score = 0;
      for (const s of realSteps) {
        const pc = pitchClass((s.root as number) - tonic);
        const idx = ivs.indexOf(pc);
        if (idx >= 0) {
          score += 1;
          // Quality tie-break: matching diatonic quality earns extra weight.
          if (dqs[idx] === s.quality) score += 0.5;
        }
      }
      // Slight bias toward keys whose tonic chord (degree I) actually
      // appears in the progression — helps separate close calls.
      const tonicPresent = realSteps.some((s) => pitchClass((s.root as number) - tonic) === 0);
      if (tonicPresent) score += 0.25;
      if (score > bestScore) {
        bestScore = score;
        best = { tonic, mode };
      }
    }
  }
  return best;
}

// ---------------- Related-key check ----------------

const RELATED_KEYS_MAJOR: ReadonlyArray<DetectedKey> = [
  // Same tonic — major.
  { tonic: 0, mode: 'major' },
  // V (dominant key) — +7 semis, major.
  { tonic: 7, mode: 'major' },
  // IV (subdominant key) — +5 semis, major.
  { tonic: 5, mode: 'major' },
  // vi (relative minor) — +9 semis, minor.
  { tonic: 9, mode: 'minor' },
];

const RELATED_KEYS_MINOR: ReadonlyArray<DetectedKey> = [
  { tonic: 0, mode: 'minor' },
  // Relative major — +3 semis, major.
  { tonic: 3, mode: 'major' },
  // v (dominant minor) — +7 semis, minor.
  { tonic: 7, mode: 'minor' },
  // iv (subdominant minor) — +5 semis, minor.
  { tonic: 5, mode: 'minor' },
];

/** Build the related-key list anchored on a given tonic+mode. */
export function relatedKeys(key: DetectedKey): DetectedKey[] {
  const seeds = key.mode === 'major' ? RELATED_KEYS_MAJOR : RELATED_KEYS_MINOR;
  return seeds.map((s) => ({
    tonic: pitchClass(key.tonic + s.tonic),
    mode: s.mode,
  }));
}

/**
 * Returns true if the new progression stays "musically related" to the
 * original key — at least 50% of its real chord roots are diatonic to the
 * original key OR to one of its related keys (V, IV, relative minor/major).
 */
export function isStillRelated(
  steps: ReadonlyArray<Pick<EvolveStep, 'root' | 'on'>>,
  origKey: DetectedKey,
): boolean {
  const realSteps = steps.filter((s) => s.on && s.root !== null);
  if (realSteps.length === 0) return true;
  const candidates = relatedKeys(origKey);
  for (const cand of candidates) {
    let inKey = 0;
    for (const s of realSteps) {
      if (isDiatonic(s.root as number, cand)) inKey += 1;
    }
    if (inKey / realSteps.length >= 0.5) return true;
  }
  return false;
}

// ---------------- Mutation rules ----------------

type Rng = () => number;

/** Default Math.random-backed RNG. Tests inject a seeded one. */
function defaultRng(): number {
  return Math.random();
}

function pickRandom<T>(rng: Rng, arr: ReadonlyArray<T>): T | null {
  if (arr.length === 0) return null;
  const i = Math.floor(rng() * arr.length);
  return arr[Math.min(i, arr.length - 1)] ?? null;
}

function cloneSteps(steps: ReadonlyArray<EvolveStep>): EvolveStep[] {
  return steps.map((s) => ({ ...s }));
}

/** Indices of "real" (on=true, root non-null) steps. */
function realStepIndices(steps: ReadonlyArray<EvolveStep>): number[] {
  const out: number[] = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s && s.on && s.root !== null) out.push(i);
  }
  return out;
}

/** MIDI root for the chord at degree `d` (1..7) in the given key, anchored
 *  near the reference root (so substitutions don't jump 5 octaves). */
function degreeRoot(d: number, key: DetectedKey, near: number): number {
  if (d < 1 || d > 7) return near;
  const ivs = scaleIntervals(key.mode);
  const semis = ivs[d - 1] ?? 0;
  const targetPc = pitchClass(key.tonic + semis);
  return snapToNearOctave(targetPc, near);
}

/** Pick the octave of `targetPc` that minimizes |delta from near|. */
function snapToNearOctave(targetPc: number, near: number): number {
  const base = Math.floor(near / 12) * 12 + targetPc;
  const candidates = [base - 12, base, base + 12];
  let best = base;
  let bestDist = Infinity;
  for (const c of candidates) {
    const d = Math.abs(c - near);
    if (d < bestDist) { bestDist = d; best = c; }
  }
  return best;
}

interface MutationContext {
  steps: EvolveStep[];
  key: DetectedKey;
  rng: Rng;
  /** Step indices that have been mutated 2+ times consecutively — skip. */
  blockedIndices: ReadonlySet<number>;
}

interface MutationOutcome {
  steps: EvolveStep[];
  changedIndex: number | null;
}

/** Rule 1: swap a step's chord for a functionally-equivalent diatonic
 *  substitute. I↔vi (tonic family), IV↔ii (subdominant), V↔vii° (dominant). */
function ruleFunctionalSubstitute(ctx: MutationContext): MutationOutcome {
  const idxs = realStepIndices(ctx.steps).filter((i) => !ctx.blockedIndices.has(i));
  if (idxs.length === 0) return { steps: ctx.steps, changedIndex: null };

  // Shuffle so we don't always pick the first one.
  const shuffled = [...idxs].sort(() => ctx.rng() - 0.5);
  for (const i of shuffled) {
    const step = ctx.steps[i]!;
    const deg = degreeInKey(step.root as number, ctx.key);
    let targetDeg = 0;
    if (deg === 1) targetDeg = 6;
    else if (deg === 6) targetDeg = 1;
    else if (deg === 4) targetDeg = 2;
    else if (deg === 2) targetDeg = 4;
    else if (deg === 5) targetDeg = 7;
    else if (deg === 7) targetDeg = 5;
    if (targetDeg === 0) continue;
    const newRoot = degreeRoot(targetDeg, ctx.key, step.root as number);
    const newQual = degreeQualities(ctx.key.mode)[targetDeg - 1] ?? 'maj';
    const next = cloneSteps(ctx.steps);
    next[i] = { ...step, root: newRoot, quality: newQual };
    return { steps: next, changedIndex: i };
  }
  return { steps: ctx.steps, changedIndex: null };
}

/** Rule 2: secondary dominant — add a 7th to V (V→V7), or turn I/II into a
 *  dominant-7 of the next chord (I7, II7). Adds tonal pull. */
function ruleSecondaryDominant(ctx: MutationContext): MutationOutcome {
  const idxs = realStepIndices(ctx.steps).filter((i) => !ctx.blockedIndices.has(i));
  if (idxs.length === 0) return { steps: ctx.steps, changedIndex: null };
  const shuffled = [...idxs].sort(() => ctx.rng() - 0.5);
  for (const i of shuffled) {
    const step = ctx.steps[i]!;
    const deg = degreeInKey(step.root as number, ctx.key);
    if (deg === 5 && step.quality === 'maj') {
      const next = cloneSteps(ctx.steps);
      next[i] = { ...step, quality: 'dom7' };
      return { steps: next, changedIndex: i };
    }
    if (deg === 1 && (step.quality === 'maj' || step.quality === 'min')) {
      // I → I7 (secondary dominant of IV).
      const next = cloneSteps(ctx.steps);
      next[i] = { ...step, quality: 'dom7' };
      return { steps: next, changedIndex: i };
    }
    if (deg === 2 && (step.quality === 'min' || step.quality === 'maj')) {
      // II → II7 (secondary dominant of V).
      const next = cloneSteps(ctx.steps);
      next[i] = { ...step, quality: 'dom7' };
      return { steps: next, changedIndex: i };
    }
  }
  return { steps: ctx.steps, changedIndex: null };
}

/** Rule 3: insert a ii-V approach before an existing I chord. We replace
 *  the step BEFORE the I (preserving the wrap-around) with either ii or V
 *  leading toward it. */
function ruleIiVInsert(ctx: MutationContext): MutationOutcome {
  const idxs = realStepIndices(ctx.steps).filter((i) => !ctx.blockedIndices.has(i));
  if (idxs.length === 0) return { steps: ctx.steps, changedIndex: null };

  // Find I-chord step indices (degree 1).
  const tonicIdxs = idxs.filter((i) => {
    const s = ctx.steps[i]!;
    return degreeInKey(s.root as number, ctx.key) === 1;
  });
  if (tonicIdxs.length === 0) return { steps: ctx.steps, changedIndex: null };

  // Shuffle and pick the first I whose PREVIOUS step is mutable.
  const shuffled = [...tonicIdxs].sort(() => ctx.rng() - 0.5);
  for (const ti of shuffled) {
    const prev = (ti - 1 + ctx.steps.length) % ctx.steps.length;
    if (ctx.blockedIndices.has(prev)) continue;
    const prevStep = ctx.steps[prev];
    if (!prevStep) continue;
    // Skip if the prev step is already ii or V — the approach is in place.
    const prevDeg = prevStep.root !== null
      ? degreeInKey(prevStep.root, ctx.key) : 0;
    if (prevDeg === 2 || prevDeg === 5) continue;
    // Pick ii or V (50/50). Both lead well to I.
    const useV = ctx.rng() < 0.5;
    const targetDeg = useV ? 5 : 2;
    const near = prevStep.root !== null ? prevStep.root : (ctx.steps[ti]!.root as number);
    const newRoot = degreeRoot(targetDeg, ctx.key, near);
    const newQual: ChordQualityName = useV
      ? (ctx.key.mode === 'major' ? 'maj' : 'maj') // V is major in both modes for "applied V" feel
      : (ctx.key.mode === 'major' ? 'min' : 'dim');
    const next = cloneSteps(ctx.steps);
    next[prev] = {
      ...prevStep,
      on: true,
      root: newRoot,
      quality: newQual,
    };
    return { steps: next, changedIndex: prev };
  }
  return { steps: ctx.steps, changedIndex: null };
}

/** Rule 4: tritone substitution — V7 → bII7. Pick a step at degree 5 (V)
 *  whose quality is dom7 or maj, replace with the tritone-related dominant
 *  (root shifted by 6 semis, quality dom7). */
function ruleTritoneSub(ctx: MutationContext): MutationOutcome {
  const idxs = realStepIndices(ctx.steps).filter((i) => !ctx.blockedIndices.has(i));
  if (idxs.length === 0) return { steps: ctx.steps, changedIndex: null };

  const shuffled = [...idxs].sort(() => ctx.rng() - 0.5);
  for (const i of shuffled) {
    const step = ctx.steps[i]!;
    const deg = degreeInKey(step.root as number, ctx.key);
    if (deg !== 5) continue;
    if (step.quality !== 'dom7' && step.quality !== 'maj') continue;
    const newRoot = (step.root as number) + 6;
    const next = cloneSteps(ctx.steps);
    next[i] = { ...step, root: newRoot, quality: 'dom7' };
    return { steps: next, changedIndex: i };
  }
  return { steps: ctx.steps, changedIndex: null };
}

/** Rule 5: voice-leading smoothing — find a step whose root jumps >5 semis
 *  from the previous, replace it with a chord whose root is within 2 semis
 *  of the previous. Helper picks the closest diatonic root. */
function ruleVoiceLeading(ctx: MutationContext): MutationOutcome {
  const realIdxs = realStepIndices(ctx.steps);
  if (realIdxs.length < 2) return { steps: ctx.steps, changedIndex: null };
  const candidates: number[] = [];
  for (let k = 1; k < realIdxs.length; k++) {
    const prevI = realIdxs[k - 1]!;
    const curI = realIdxs[k]!;
    if (ctx.blockedIndices.has(curI)) continue;
    const prevR = ctx.steps[prevI]!.root as number;
    const curR = ctx.steps[curI]!.root as number;
    if (Math.abs(curR - prevR) > 5) candidates.push(curI);
  }
  if (candidates.length === 0) return { steps: ctx.steps, changedIndex: null };
  const target = pickRandom(ctx.rng, candidates);
  if (target === null) return { steps: ctx.steps, changedIndex: null };

  // Find the index of `target` in realIdxs to get its predecessor root.
  const k = realIdxs.indexOf(target);
  const prevR = ctx.steps[realIdxs[k - 1]!]!.root as number;
  // Search ±5 semis around prevR for the closest diatonic root in key.
  let bestRoot: number | null = null;
  let bestDist = Infinity;
  for (let delta = -5; delta <= 5; delta++) {
    const cand = prevR + delta;
    if (isDiatonic(cand, ctx.key) && delta !== 0) {
      const d = Math.abs(delta);
      if (d < bestDist) { bestDist = d; bestRoot = cand; }
    }
  }
  if (bestRoot === null) return { steps: ctx.steps, changedIndex: null };
  const step = ctx.steps[target]!;
  // Look up the diatonic quality of the new root.
  const newDeg = degreeInKey(bestRoot, ctx.key);
  const newQual = newDeg > 0
    ? (degreeQualities(ctx.key.mode)[newDeg - 1] ?? 'maj')
    : step.quality;
  const next = cloneSteps(ctx.steps);
  next[target] = { ...step, root: bestRoot, quality: newQual };
  return { steps: next, changedIndex: target };
}

/** Rule 6: quality drift — same root, related quality. maj→maj7, min→min7,
 *  dom7↔sus4 (sus4 wants to resolve to dom7). */
function ruleQualityDrift(ctx: MutationContext): MutationOutcome {
  const idxs = realStepIndices(ctx.steps).filter((i) => !ctx.blockedIndices.has(i));
  if (idxs.length === 0) return { steps: ctx.steps, changedIndex: null };
  const shuffled = [...idxs].sort(() => ctx.rng() - 0.5);
  for (const i of shuffled) {
    const step = ctx.steps[i]!;
    let newQ: ChordQualityName | null = null;
    if (step.quality === 'maj') newQ = 'maj7';
    else if (step.quality === 'min') newQ = 'min7';
    else if (step.quality === 'dom7') newQ = 'sus4';
    else if (step.quality === 'sus4') newQ = 'dom7';
    else if (step.quality === 'maj7') newQ = 'maj';
    else if (step.quality === 'min7') newQ = 'min';
    if (newQ === null) continue;
    const next = cloneSteps(ctx.steps);
    next[i] = { ...step, quality: newQ };
    return { steps: next, changedIndex: i };
  }
  return { steps: ctx.steps, changedIndex: null };
}

// ---------------- Rule selection + main entry ----------------

interface RuleEntry {
  name: MutationRuleName;
  weight: number;
  apply: (ctx: MutationContext) => MutationOutcome;
}

const RULES: ReadonlyArray<RuleEntry> = [
  { name: 'functional-substitute', weight: 0.40, apply: ruleFunctionalSubstitute },
  { name: 'secondary-dominant',    weight: 0.15, apply: ruleSecondaryDominant },
  { name: 'ii-V-insert',           weight: 0.15, apply: ruleIiVInsert },
  { name: 'tritone-sub',           weight: 0.10, apply: ruleTritoneSub },
  { name: 'voice-leading',         weight: 0.10, apply: ruleVoiceLeading },
  { name: 'quality-drift',         weight: 0.10, apply: ruleQualityDrift },
];

function pickRuleByWeight(rng: Rng): RuleEntry {
  const r = rng();
  let acc = 0;
  for (const rule of RULES) {
    acc += rule.weight;
    if (r < acc) return rule;
  }
  return RULES[RULES.length - 1]!;
}

export interface EvolveOptions {
  /** Injectable RNG. Defaults to Math.random. */
  rng?: Rng;
  /** Step indices that mutated in the previous 2 passes — skip to spread
   *  evolution across the progression. */
  recentlyMutated?: ReadonlyArray<number>;
  /** Max number of rules to try before falling back to noop. */
  maxAttempts?: number;
}

/**
 * Apply ONE mutation to a chord progression and return the new steps array.
 *
 * Algorithm:
 *   1. Detect the most likely key + mode from the current steps.
 *   2. Pick a mutation rule by weight.
 *   3. Apply it — if it produces nothing (e.g. tritone sub on a non-V
 *      progression), retry with a different rule up to maxAttempts times.
 *   4. Verify the result is still "musically related" (>=50% of chords
 *      diatonic to the original key or a related key). If not, retry.
 *   5. Return {steps, rule, changedIndex, key}. If no rule applies, the
 *      original steps array is returned unchanged with rule='noop'.
 *
 * The "blocked" set (steps mutated in the previous 2 passes consecutively)
 * is honored to prevent the same step from getting hammered.
 */
export function evolveProgression(
  steps: ReadonlyArray<EvolveStep>,
  options: EvolveOptions = {},
): EvolveResult {
  const rng = options.rng ?? defaultRng;
  const maxAttempts = options.maxAttempts ?? 8;
  const blockedIndices = new Set(options.recentlyMutated ?? []);
  const key = detectKey(steps);
  const baseCtx: MutationContext = {
    steps: cloneSteps(steps),
    key,
    rng,
    blockedIndices,
  };

  // Try up to maxAttempts rules. We allow rule re-selection so weights
  // remain honored even after a failure.
  const triedRules = new Set<MutationRuleName>();
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const rule = pickRuleByWeight(rng);
    // Allow each rule to be tried only once per evolve call — if all rules
    // are exhausted, we'll exit the loop and return noop.
    if (triedRules.has(rule.name)) {
      // Pick the next not-yet-tried rule deterministically.
      const remaining = RULES.filter((r) => !triedRules.has(r.name));
      if (remaining.length === 0) break;
      const next = remaining[Math.floor(rng() * remaining.length)] ?? remaining[0]!;
      triedRules.add(next.name);
      const out = next.apply(baseCtx);
      if (out.changedIndex === null) continue;
      if (!isStillRelated(out.steps, key)) continue;
      return { steps: out.steps, rule: next.name, changedIndex: out.changedIndex, key };
    }
    triedRules.add(rule.name);
    const out = rule.apply(baseCtx);
    if (out.changedIndex === null) continue;
    if (!isStillRelated(out.steps, key)) continue;
    return { steps: out.steps, rule: rule.name, changedIndex: out.changedIndex, key };
  }
  return { steps: cloneSteps(steps), rule: 'noop', changedIndex: null, key };
}

// ---------------- Exposed rules list for docs / tests ----------------

export const EVOLVE_RULES: ReadonlyArray<{ name: MutationRuleName; weight: number }> =
  RULES.map((r) => ({ name: r.name, weight: r.weight }));
