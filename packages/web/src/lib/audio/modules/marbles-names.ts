// packages/web/src/lib/audio/modules/marbles-names.ts
//
// MARBLES' two named rosters, and the ONE reason they are not on the def:
// `marbles.ts` imports its worklet as `…/marbles.js?url`, which Node cannot
// resolve. Anything that imports the def is therefore unloadable from a
// Playwright process — so `marbles-face.spec.ts` could not check the strings
// the faceplate prints against the strings the module declares, which is
// exactly the check worth having.
//
// This module has NO imports at all. The def re-exports both arrays so every
// existing consumer's import surface is unchanged.
//
// ⚠ COSMETIC, NOT CONTRACT. `contract-signature.ts` projects only
// `id/min/max/curve/defaultValue/units` off a ParamDef, so declaring `options`
// from these rosters moves ZERO lines of `contract-lock.txt` — verified by
// running `task docs:accept` across the change, which moved exactly one line
// and it was the control family. (The face spec priced the two rosters at
// "+12 lines … a contract change, blocking for the face"; they are neither.)

/** The six T-section gate models, in `t_model` index order.
 *
 * ⚠ INDEX 1 IS A STUB. `marbles-core.ts` / `marbles-engine.ts` both carry
 * `case T_MODEL.CLUSTERS: case T_MODEL.DIVIDER: … generateComplementaryBernoulli`
 * with the comment "Simplified divider/cluster: treat as Bernoulli with bias
 * for v1", so CLUSTERS is bit-identical to COIN on both gate outputs. The face
 * prints `CLUSTERS → COIN` rather than asserting a behaviour the DSP does not
 * have; implementing it is its own PR. */
export const MARBLES_T_MODEL_NAMES = [
  'COIN', // complementary Bernoulli
  'CLUSTERS', // NOT IMPLEMENTED — falls through to COIN (see above)
  'DRUMS',
  'INDEP',
  '3-STATE',
  'MARKOV',
] as const;

export const MARBLES_MAX_T_MODEL = MARBLES_T_MODEL_NAMES.length - 1;

/** The six quantiser scales, in `scale` index order. Their DEGREES and WEIGHTS
 *  live in `marbles-engine`'s `PRESET_SCALES` — these are only the labels. */
export const MARBLES_SCALE_NAMES = [
  'C major',
  'C minor',
  'Pentatonic',
  'Pelog',
  'Raag Bhairav',
  'Raag Shri',
] as const;

/**
 * The rosters as `ParamDef.options` — DERIVED from the arrays above rather than
 * re-typed, so a rename cannot leave the selector and the card disagreeing.
 *
 * ⚠ BOTH ARE PAINTED BY A `grid`, NOT A SEGMENTED ROW. `.seg` is `flex: 1` —
 * flex-BASIS 0 — so a segmented group splits its width EQUALLY and every
 * caption is allotted the roster MEAN. `filter` ships three TWO-LETTER options
 * and still renders `LP · H… · B…`; six captions averaging 5.8 characters
 * (T MODEL) and 8.7 (SCALE, up to "Raag Bhairav") clip on every one of them.
 */
const asOptions = (names: readonly string[]) => names.map((label, value) => ({ value, label }));

export const MARBLES_T_MODEL_OPTIONS = asOptions(MARBLES_T_MODEL_NAMES);
export const MARBLES_SCALE_OPTIONS = asOptions(MARBLES_SCALE_NAMES);
