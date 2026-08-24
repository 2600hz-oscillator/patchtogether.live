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
  noteEffProb,
  noteCovering,
  setNoteProb,
  clipDefaultProbEff,
  setClipDefaultProb,
  notePitchProbEff,
  setNotePitchProb,
  coercePitchProb,
  coercePlayEvery,
  playEveryEff,
  PLAY_EVERY_DEFAULT,
  type NoteClipRecord,
  type NoteEvent,
} from '$lib/audio/modules/clip-types';
import {
  PITCH_PROB_LEVELS,
  pitchProbLevelToValue,
  valueToPitchProbLevel,
} from '$lib/audio/pitch-probability';

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
 *  (step, midi): the note's EFFECTIVE probability level — its OWN `prob` once set,
 *  ELSE the clip default (so an unset note in a 95% clip shows 95%, matching
 *  "every note has a probability = the clip's until you set the note's own"),
 *  ELSE 100%. PURE. */
export function probMenuCheckedLevel(
  clip: NoteClipRecord | null | undefined,
  step: number,
  midi: number,
): number {
  const ev = clip ? noteCovering(clip, step, midi) : undefined;
  return valueToProbLevel(noteEffProb(clip ?? undefined, ev));
}

/** Apply a menu pick → the NEW clip with the note's OWN probability set to
 *  `probLevelToValue(level)` (via setNoteProb: STORES the value, incl a 100% pick
 *  = 1.0 which pins the note above a lower clip default; an empty cell is a no-op
 *  → the same clip reference). PURE. */
export function applyProbMenuPick(
  clip: NoteClipRecord,
  step: number,
  midi: number,
  level: number,
): NoteClipRecord {
  return setNoteProb(clip, step, midi, probLevelToValue(level));
}

// ── PER-NOTE PITCH PROBABILITY menu (the THIRD row of the same note right-click
// menu, beside Probability and Play Every). 41 items: OFF first (the DEFAULT
// check — the authored pitch, exactly) then the 40 increments 2.5% … 100%,
// ASCENDING, because unlike firing probability the default here sits at the
// BOTTOM of the range, so "default first" and "ascending" agree.
//
// The 40 increments are the owner's constraint, for parity with the other %
// controls when this reaches the Push/Launchpad: 40 = 5 rows of 8 pads, so the
// level reads directly as "N of 40 lit". This PR is card-only — no hardware
// binding — but the domain is already the one those surfaces will want. ──

/** The pitch-instability menu levels, [0, 1, … 40] — OFF first (the default
 *  check), then ascending. PURE. */
export function pitchProbMenuLevels(): number[] {
  return Array.from({ length: PITCH_PROB_LEVELS + 1 }, (_v, i) => i);
}

/** The menu level (0..PITCH_PROB_LEVELS) that reads CHECKED for the note
 *  covering (step, midi): its own `pitchProb` level, else 0 (OFF). Unlike firing
 *  probability there is NO clip-level default to inherit — an unset note means
 *  "leave this pitch alone", the only safe reading of a legacy clip. PURE. */
export function pitchProbMenuCheckedLevel(
  clip: NoteClipRecord | null | undefined,
  step: number,
  midi: number,
): number {
  const ev = clip ? noteCovering(clip, step, midi) : undefined;
  return valueToPitchProbLevel(notePitchProbEff(ev));
}

/** Apply a pitch-instability menu pick → the NEW clip with the note's
 *  `pitchProb` set to `pitchProbLevelToValue(level)` (level 0 DELETES the key —
 *  back to the authored pitch, byte-identical to a pre-feature note). An empty
 *  cell is a no-op → the SAME clip reference. PURE. */
export function applyPitchProbMenuPick(
  clip: NoteClipRecord,
  step: number,
  midi: number,
  level: number,
): NoteClipRecord {
  return setNotePitchProb(clip, step, midi, pitchProbLevelToValue(level));
}

// ── CLIP-DEFAULT probability menu (right-click a GRID clip pad). The same 40-
// level list + labels as the per-note menu, but it targets the CLIP's default
// probability (used by every note without its own `prob` set) via
// setClipDefaultProb. 100% is the default check (no default set = every note
// fires at 1). ──

/** The clip-default menu level (1..PROB_LEVELS) that reads CHECKED: the clip's
 *  current default level, or PROB_LEVELS (100%) when no default is set — so 100%
 *  is the default check. PURE. */
export function clipProbMenuCheckedLevel(clip: NoteClipRecord | null | undefined): number {
  return valueToProbLevel(clipDefaultProbEff(clip ?? undefined));
}

/** Apply a clip-default menu pick → the NEW clip with `defaultProb` set to
 *  `probLevelToValue(level)` (via setClipDefaultProb: a 100% pick DELETES the key,
 *  back to the default). PURE. */
export function applyClipProbMenuPick(clip: NoteClipRecord, level: number): NoteClipRecord {
  return setClipDefaultProb(clip, probLevelToValue(level));
}

// ── THE OTHER TWO CLIP-LEVEL PICKS (2026-08-24). The owner's menu is the same
// three categories on BOTH surfaces — the note cell and the launcher pad — so the
// clip pad needs a clip-level counterpart for pitch probability and skip every.
//
// ⚠ ONLY ONE of the three has a clip-level DATA field: `defaultProb`, which notes
// INHERIT. `pitchProb` and `playEvery` are per-note keys with no inheritance in
// the model, and inventing two new clip-level defaults would mean a schema field,
// an engine precedence rule and a Launchpad/Push page each — none of which the
// owner asked for. So the clip-level pick for those two is a BULK WRITE over the
// notes the clip already holds: "set every note in this clip to X". No new
// property, no engine change, the same undoable transaction, and the result is
// readable straight off the notes.
//
// The consequence, stated rather than hidden: the CHECK on those two rows is the
// value the notes AGREE on. A clip whose notes disagree shows NOTHING checked
// (`null`) — the honest reading, where showing the first note's value would be a
// lie about the other 15.

/** The clip-level pitch-instability level: the level EVERY note carries when they
 *  agree, else `null` (mixed → nothing checked). A clip with no notes agrees
 *  vacuously on the default, 0. PURE. */
export function clipPitchProbMenuCheckedLevel(clip: NoteClipRecord | null | undefined): number | null {
  if (!clip || clip.kind !== 'note') return null;
  let seen: number | null = null;
  for (const e of clip.steps) {
    const lv = valueToPitchProbLevel(notePitchProbEff(e));
    if (seen === null) seen = lv;
    else if (seen !== lv) return null;
  }
  return seen ?? 0;
}

/** Apply a clip-level pitch-instability pick → the NEW clip with EVERY note's
 *  `pitchProb` set to `pitchProbLevelToValue(level)`. Level 0 DELETES the key on
 *  every note (the same key-absent-at-default discipline `setNotePitchProb`
 *  keeps, so a clip reset to off round-trips byte-identical). PURE. */
export function applyClipPitchProbPick(clip: NoteClipRecord, level: number): NoteClipRecord {
  const p = coercePitchProb(pitchProbLevelToValue(level));
  const steps = clip.steps.map((e) => {
    if (p <= 0) {
      const { pitchProb: _drop, ...rest } = e;
      return rest as NoteEvent;
    }
    return { ...e, pitchProb: p };
  });
  return { ...clip, steps };
}

/** The clip-level skip-every count: the count EVERY note carries when they agree,
 *  else `null` (mixed → nothing checked). A clip with no notes agrees vacuously
 *  on the default, 1. PURE. */
export function clipPlayEveryMenuCheckedLevel(clip: NoteClipRecord | null | undefined): number | null {
  if (!clip || clip.kind !== 'note') return null;
  let seen: number | null = null;
  for (const e of clip.steps) {
    const n = playEveryEff(e);
    if (seen === null) seen = n;
    else if (seen !== n) return null;
  }
  return seen ?? PLAY_EVERY_DEFAULT;
}

/** Apply a clip-level skip-every pick → the NEW clip with EVERY note's
 *  `playEvery` set to `n`. `1` DELETES the key on every note (back to "every
 *  loop", byte-identical to a pre-feature note). PURE. */
export function applyClipPlayEveryPick(clip: NoteClipRecord, n: number): NoteClipRecord {
  const v = coercePlayEvery(n);
  const steps = clip.steps.map((e) => {
    if (v <= PLAY_EVERY_DEFAULT) {
      const { playEvery: _drop, ...rest } = e;
      return rest as NoteEvent;
    }
    return { ...e, playEvery: v };
  });
  return { ...clip, steps };
}
