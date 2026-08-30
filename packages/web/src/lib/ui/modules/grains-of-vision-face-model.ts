// packages/web/src/lib/ui/modules/grains-of-vision-face-model.ts
//
// The PURE model behind the GRAINS OF VISION faceplate — the three quantities
// this module's dials are individually blind to.
//
// ⚠ NONE OF THEM HAS A PAINTED SURFACE, BY OWNER RULING (#1957, 2026-08-19).
// They were specced as a `hero.readouts` row; the hero readout strip is DELETED
// from the platform and the resting faceplate paints no derived-state text in
// any shape. What survives is this arithmetic plus its permanent negative
// controls in the unit lane — the disposition `moog984-face-model.ts` and
// `mirrorpool-face-model.ts` took — and `aria-valuetext` on the controls.
//
// ⚠ EVERY FUNCTION BELOW CALLS THE DEF'S OWN EXPORTED HELPERS. Not one line
// re-derives the arithmetic, which is the rule the backdraft class exists to
// enforce one layer up: a re-typed copy here could describe a module that has
// stopped behaving that way, and every gate in the repo would stay green.
//
// PURE: no DOM, no engine, no store, no fs.

import {
  GOV_HISTORY_FRAMES,
  govDelayFrames,
  govFeedbackComposite,
  govReverbAcc,
  govReverbIsDry,
  GRAINS_OF_VISION_DEFAULTS,
} from '$lib/video/modules/grainsOfVision';

/** A face readout's only window onto the node: param id → value, or undefined
 *  on a fresh node that has not written that key yet. */
type Read = (paramId: string) => number | undefined;

/** One param, with the def's own default substituted for anything unwritten or
 *  non-finite.
 *
 *  ⚠ THE NON-FINITE GUARD IS NOT DEFENSIVE PADDING. These run on every render,
 *  so a throw — or a silently NaN-propagating comparison — takes the faceplate
 *  down mid-drag, and a NaN that compares false against every branch reports a
 *  WRONG answer rather than a missing one. */
function num(read: Read, id: keyof typeof GRAINS_OF_VISION_DEFAULTS): number {
  const v = read(id as string);
  return typeof v === 'number' && Number.isFinite(v) ? v : GRAINS_OF_VISION_DEFAULTS[id];
}

/**
 * SMEAR — how many frames back into the history ring a grain may reach.
 *
 * ⚠ THE FINDING THIS EXISTS FOR IS A STEP THE DIAL DOES NOT SHOW.
 * `govDelayFrames` is `round(clamp01(rate) · (ring − 1))`, so the whole bottom
 * `1/(2·(ring−1))` of a dial that looks continuous is BIT-EXACTLY ZERO FRAMES —
 * the module's headline gesture switched off — and the next step up is a full
 * frame, not a fraction of one. The shipped default sits ONE step above the
 * dead band, so a player who nudges RATE downward finds nothing happens and no
 * painted surface explains why.
 */
export function govSmearFrames(read: Read): number {
  return govDelayFrames(num(read, 'rate'));
}

/** The largest RATE that is still bit-exactly zero frames — DERIVED from the
 *  ring depth, never typed, so a deeper ring moves it automatically. */
export const GOV_SMEAR_DEAD_BAND = 1 / (2 * (GOV_HISTORY_FRAMES - 1));

/**
 * FEEDBACK GAIN — what fraction of the previous output actually returns.
 *
 * ⚠ A JOIN, AND A BYPASS NEITHER DIAL SHOWS. `govFeedbackComposite` multiplies
 * `feedback · fb_decay`, so a readback of EITHER is blind to the other: at
 * `fb_decay = 0` the FB dial can read 0.98 while nothing whatsoever returns.
 * And `fb_dry` is a hard bypass consumed as `>= 0.5` — a THIRD control, of a
 * different kind, that zeroes the block outright while both dials stay put.
 *
 * Computed by asking the def's own composite what it does to a unit previous
 * frame with no fresh grains, so it cannot disagree with the shader.
 */
export function govFeedbackGain(read: Read): number {
  if (num(read, 'fb_dry') >= 0.5) return 0;
  return govFeedbackComposite(0, 1, num(read, 'feedback'), num(read, 'fb_decay'));
}

/**
 * REVERB TAIL — the accumulator's per-frame survival fraction.
 *
 * ⚠ TWO INDEPENDENT BYPASSES, either of which makes the whole block a
 * passthrough: `rev_mix` at 0 and the `rev_dry` toggle. `govReverbIsDry` is the
 * def's own predicate for exactly that, so this cannot drift from the branch
 * the shader takes. With neither engaged the tail is `govReverbAcc`'s decay
 * term — again asked of the def rather than restated.
 */
export function govReverbTail(read: Read): number {
  if (govReverbIsDry(num(read, 'rev_mix'), num(read, 'rev_dry'))) return 0;
  return govReverbAcc(0, 1, num(read, 'rev_decay'));
}
