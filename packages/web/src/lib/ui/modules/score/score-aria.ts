// packages/web/src/lib/ui/modules/score/score-aria.ts
//
// WHERE SCORE'S REMOVED NUMBERS LIVE.
//
// The owner ruling is that a faceplate paints no resting derived text and that
// the data is REMOVED, not hidden — a hover reveal is "there but hidden" and is
// refused by name. SCORE is the module where that bites hardest, because almost
// everything about it is a number somebody would plausibly print: the playhead's
// bar and beat, the note count, the bar total, the page you are on, the tempo,
// the dynamic's percentage.
//
// None of them is painted. Every one of them is HERE, in an accessible name —
// speakable, assertable, and unpainted — which is what every spec proving this
// face tracks the graph reads. That is what let the readouts be deleted without
// weakening a single assertion.
//
// ⚠ PURE, AND DELIBERATELY IN ITS OWN FILE. These strings are the observable
// half of the face's contract, so they are unit-tested directly rather than
// through a rendered component: a `$derived` that silently threw would take the
// subtree down and the assertion would land somewhere else entirely.

import {
  BARS_PER_PAGE,
  DYNAMIC_NAMES,
  NOTE_DURATION_NAMES,
  TICKS_PER_BAR,
  dynamicAt,
  keySignatureName,
  type DynamicLevel,
  type ScoreData,
  type ScoreNote,
} from '$lib/audio/modules/score-data';
import { noteNameForMidi } from '$lib/audio/note-entry';

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Which beat of its bar a tick falls on, 1-based, as a reader would count. */
export function beatOf(tick: number): number {
  return Math.floor(tick / (TICKS_PER_BAR / 4)) + 1;
}

/**
 * The STAFF panel's accessible name — the whole playhead readout the card would
 * have printed, plus what is selected and which page is on screen.
 */
export function scoreStaffAriaLabel(
  data: ScoreData,
  currentPage: number,
  playingNoteId: string | null,
  selectedNoteId: string | null,
): string {
  const parts: string[] = [];
  parts.push(
    data.notes.length === 0
      ? 'empty staff'
      : `${plural(data.notes.length, 'note')} over ${plural(data.pages * BARS_PER_PAGE, 'bar')}`,
  );
  parts.push(`showing page ${currentPage + 1} of ${data.pages}`);
  parts.push(`key of ${keySignatureName(data.keySignature)}`);
  const playing = playingNoteId ? data.notes.find((n) => n.id === playingNoteId) : undefined;
  parts.push(
    playing ? `playing bar ${playing.bar + 1}, beat ${beatOf(playing.tick)}` : 'not playing',
  );
  const selected = selectedNoteId ? data.notes.find((n) => n.id === selectedNoteId) : undefined;
  parts.push(
    selected
      ? `${noteNameForMidi(selected.midi)} selected`
      : 'no note selected',
  );
  return parts.join('; ');
}

/** One note's accessible name — pitch, value, position, and its two states. */
export function noteAriaLabel(n: ScoreNote, selected: boolean, playing: boolean): string {
  const acc = n.accidental ? `, ${n.accidental}` : '';
  const state = [selected ? 'selected' : null, playing ? 'sounding' : null]
    .filter(Boolean)
    .join(', ');
  return (
    `${NOTE_DURATION_NAMES[n.duration]} note ${noteNameForMidi(n.midi)}${acc}` +
    `, bar ${n.bar + 1}, beat ${beatOf(n.tick)}` +
    (state ? `, ${state}` : '')
  );
}

/**
 * The QUICKSAVE panel's accessible name — which slots hold a pattern, which one
 * is queued, which one was last loaded. All of it was legible on the card only
 * as colour.
 */
export function scoreSlotsAriaLabel(
  filled: readonly string[],
  queued: string | null,
  lastLoaded: string | null,
  pendingMode: string | null,
): string {
  const parts: string[] = [];
  parts.push(
    filled.length === 0
      ? 'no saved patterns'
      : `${filled.length === 1 ? 'slot' : 'slots'} ${filled.join(' and ')} saved`,
  );
  if (lastLoaded) parts.push(`slot ${lastLoaded} last loaded`);
  if (queued) parts.push(`slot ${queued} queued for the end of this pass`);
  parts.push(pendingMode ? `${pendingMode} armed` : 'nothing armed');
  return parts.join('; ');
}

/**
 * The DYN cell's accessible name.
 *
 * ⚠ IT NAMES BOTH THE MARKER *HERE* AND THE LEVEL *IN FORCE*, because they are
 * different facts and the control only shows one of them. A note with no marker
 * of its own still sounds at whatever the last marker set, and a player who can
 * only hear "none" cannot tell a quiet passage from an unmarked one.
 */
export function scoreDynAriaLabel(
  selected: ScoreNote | null,
  data: ScoreData,
): string {
  if (!selected) return 'no note selected';
  const here = data.dynamics.find((m) => m.bar === selected.bar && m.tick === selected.tick);
  const inForce: DynamicLevel = dynamicAt(selected.bar, selected.tick, data.dynamics);
  return here
    ? `${DYNAMIC_NAMES[here.level]} marked here`
    : `no marking here; sounding ${DYNAMIC_NAMES[inForce]}`;
}
