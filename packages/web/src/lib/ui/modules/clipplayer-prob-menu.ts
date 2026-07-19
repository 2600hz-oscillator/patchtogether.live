// packages/web/src/lib/ui/modules/clipplayer-prob-menu.ts
//
// PURE logic for the clipplayer card's PER-NOTE PROBABILITY right-click menu —
// extracted from ClipplayerCard.svelte so the "Probability ▸" submenu (the level
// list, the default-checked 100%, the percent labels, the write) is unit-testable
// without rendering the component (the repo's card-logic convention, cf.
// clipplayer-keyboard.ts). The DOM open/close + positioning stay in the card;
// the visual (the purple cell) is covered by VRT.

import {
  PROB_LEVELS,
  probLevelToValue,
  valueToProbLevel,
  probEff,
  noteCovering,
  setNoteProb,
  type NoteClipRecord,
} from '$lib/audio/modules/clip-types';

/** The 40 probability menu levels, HIGH→LOW: [40, 39, … 1] so 100% is FIRST
 *  (the default-checked item) and 2.5% is last. PURE. */
export function probMenuLevels(): number[] {
  return Array.from({ length: PROB_LEVELS }, (_v, i) => PROB_LEVELS - i);
}

/** Format a 0..1 probability as its menu percent label: an integer percent shows
 *  no decimal (100% · 5%), a half-step keeps one (2.5% · 97.5%). PURE. */
export function probPctLabel(value: number): string {
  const pct = value * 100;
  return (Number.isInteger(pct) ? pct.toFixed(0) : pct.toFixed(1)) + '%';
}

/** The menu level (1..PROB_LEVELS) that should read CHECKED for the note covering
 *  (step, midi): the note's current level, or PROB_LEVELS (100%) when the cell
 *  holds no note / the note has no `prob` key — so 100% is the default check.
 *  PURE. */
export function probMenuCheckedLevel(
  clip: NoteClipRecord | null | undefined,
  step: number,
  midi: number,
): number {
  const ev = clip ? noteCovering(clip, step, midi) : undefined;
  return valueToProbLevel(probEff(ev));
}

/** Apply a menu pick → the NEW clip with the note's probability set to
 *  `probLevelToValue(level)` (via setNoteProb: a 100% pick DELETES the key; an
 *  empty cell is a no-op → the same clip reference). PURE. */
export function applyProbMenuPick(
  clip: NoteClipRecord,
  step: number,
  midi: number,
  level: number,
): NoteClipRecord {
  return setNoteProb(clip, step, midi, probLevelToValue(level));
}
