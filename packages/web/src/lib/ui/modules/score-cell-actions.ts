// packages/web/src/lib/ui/modules/score-cell-actions.ts
//
// The read/write halves of SCORE's faceplate BAND cells.
//
// ⚠ THE CARD IS MODAL; THE FACE IS NOT, AND THAT IS THE DESIGN RATHER THAN A
// PORT. `ScoreCard.svelte`'s toolbar is fifteen buttons arming fifteen MODES —
// six note values, ♯, ♭, tie, five dynamics, stop-bar — and a click on the staff
// means something different in each. That cannot be expressed as face cells, and
// trying is the trap: fifteen mutually-exclusive arming controls drawn as three
// selectors and two toggles would be five controls claiming to hold ONE
// single-valued state, so whatever they showed, four of the five would be lying.
//
// So the face SELECTS. Click a note to select it, and every mark cell then reads
// and writes THAT note; click the selected note again to delete it. There is no
// MODE — no cell changes what a click on the staff MEANS, which is the property
// the card's toolbar could not have and the reason four of five cells would
// otherwise be painting a state they do not hold.
//
// That is not merely different; it makes three things true that were not:
//   * a note becomes DELETABLE by pointer (its only route was a keystroke on a
//     focus the rack flip and a `preventDefault` between them make close to
//     unreachable);
//   * a tie becomes REMOVABLE (`addTie` was the only writer of `data.ties`);
//   * the def's own `docs.controls['score-note-{n}']` — *"click a note to
//     select/remove it"*, on a module in STRICT_DOCS — stops describing a
//     control the module does not have.
//
// ⚠ EVERY ROSTER IS IMPORTED, NEVER RE-TYPED. `NOTE_DURATIONS`, `DYNAMIC_SCALE`,
// `MAX_PAGES` and the key-signature span all already exist in `score-data.ts`,
// which is the module the ENGINE reads. A hand-typed copy here would let the
// face offer a value the engine cannot play, with every def-reading gate green.
//
// ⚠ NO NUMBERS IN AN OPTION LABEL WHERE A NAME EXISTS. `mf`, `quarter`,
// `G major` are what the state IS; `55 %`, `12 ticks`, `+1` would restate the
// control's own position on its own roster. The one roster whose names ARE
// numerals is PAGES (a count of pages has no other name) — kria's `LEN 1..16`
// is the shipped precedent for that exact shape.
//
// ⚠ THE MARK CELLS ARE **ARMED STATE THAT ALSO EDITS THE SELECTION**, and this
// is the shape the whole face turns on. Select a note and ACC / DYN / TIE
// rewrite it; select nothing and the same control ARMS what your next click
// writes. That is how every notation editor works, and it is strictly more than
// the card had — its ♯ tool was a MODE that could only retouch a note after the
// fact, and it could not spell a note at placement time at all.
//
// ⚠ IT IS ALSO WHAT MAKES THEM LIVE ON A FRESH SCORE, AND THE FIRST DESIGN WAS
// WRONG ABOUT THIS. Cells that acted ONLY on a selection were INERT whenever
// nothing was selected — which on a just-spawned score (`notes: []`) is always,
// because there is nothing to select. `faces-parity` caught it by driving every
// cell on a fresh spawn and asserting the value follows; that is exactly the
// inert-cell class the sweep exists for, and the fix belonged in the DESIGN
// rather than in an exemption. Recorded because "the control is conditional, so
// the gate is too strict" is the tempting and wrong reading.

import type { SelectorOption } from '$lib/ui/controls';
import type { ModuleNode } from '$lib/graph/types';
import { patch } from '$lib/graph/store';
import {
  DYNAMIC_NAMES,
  DYNAMIC_SCALE,
  MAX_KEY_SIGNATURE,
  MAX_PAGES,
  MIN_KEY_SIGNATURE,
  NOTE_DURATIONS,
  NOTE_DURATION_NAMES,
  TICKS_PER_BAR,
  dynamicAt,
  keySignatureName,
  sortedNotes,
  tickWidth,
  type Accidental,
  type DynamicLevel,
  type NoteDuration,
} from '$lib/audio/modules/score-data';
import {
  armAccidental,
  armDynamic,
  armTie,
  clearDynamicAt,
  clearStopBar,
  isTiedToNext,
  placeDynamic,
  readArmedAccidental,
  readArmedDynamic,
  readArmedTie,
  readNoteValue,
  readScore,
  readSelectedNote,
  setAccidental,
  setKeySignature,
  setLoop,
  setNoteValue,
  setPages,
  setStopBar,
  setTiedToNext,
} from '$lib/audio/modules/score-writes';

/** The "nothing here" option value, shared by every cell that can be empty. */
export const SCORE_NONE = '-';

function nodeOf(nodeId: string): ModuleNode | undefined {
  return patch.nodes[nodeId] as ModuleNode | undefined;
}

/**
 * The selected note, re-read from the LIVE graph at WRITE time.
 *
 * A cell's `onchange` receives a nodeId and nothing else, and closing over the
 * note the cell rendered with would write to whatever was selected when the cell
 * last painted — the wrong note after a selection change, silently.
 */
function liveSelected(nodeId: string) {
  return readSelectedNote(nodeOf(nodeId));
}

// ── VALUE — the note the NEXT staff click places ────────────────────────────

export function scoreValueOptions(): SelectorOption<string>[] {
  return NOTE_DURATIONS.map((d) => ({
    value: d,
    label: NOTE_DURATION_NAMES[d],
    title: `the next click on the staff places a ${NOTE_DURATION_NAMES[d]} note`,
  }));
}

export function scoreValueValue(node: ModuleNode | undefined): string {
  return readNoteValue(node);
}

export function scoreSetValue(nodeId: string, v: string): void {
  if ((NOTE_DURATIONS as string[]).includes(v)) setNoteValue(nodeId, v as NoteDuration);
}

// ── ACCIDENTAL — on the SELECTED note ───────────────────────────────────────

export function scoreAccidentalOptions(): SelectorOption<string>[] {
  return [
    { value: SCORE_NONE, label: 'key', title: 'follow the key signature — no accidental of the note\'s own' },
    { value: 'sharp', label: 'sharp', title: 'raise the selected note — or the next one you write — a semitone' },
    { value: 'natural', label: 'natural', title: 'cancel the key signature on the selected note, or on the next one you write' },
    { value: 'flat', label: 'flat', title: 'lower the selected note — or the next one you write — a semitone' },
  ];
}

export function scoreAccidentalValue(node: ModuleNode | undefined): string {
  const n = readSelectedNote(node);
  const acc = n ? n.accidental : readArmedAccidental(node);
  return acc ?? SCORE_NONE;
}

export function scoreSetAccidental(nodeId: string, v: string): void {
  const acc: Accidental = v === 'sharp' || v === 'flat' || v === 'natural' ? v : null;
  // ARM first — always. The armed value is what the next placed note gets, and
  // it is what keeps this cell live with nothing selected.
  armAccidental(nodeId, acc);
  const note = liveSelected(nodeId);
  if (note) setAccidental(nodeId, note.id, acc);
}

// ── DYNAMIC — the marker AT the selected note's position ────────────────────

const DYNAMIC_LEVELS = Object.keys(DYNAMIC_SCALE) as DynamicLevel[];

export function scoreDynOptions(): SelectorOption<string>[] {
  return [
    { value: SCORE_NONE, label: 'none', title: 'no marking here — the previous one stays in force' },
    ...DYNAMIC_LEVELS.map((l) => ({
      value: l,
      label: l,
      title: `${DYNAMIC_NAMES[l]} from the selected note onward — or, with nothing selected, from the next note you write`,
    })),
  ];
}

/**
 * The marker sitting EXACTLY at the selection, not the one in force there.
 *
 * ⚠ THE DISTINCTION IS THE CONTROL'S MEANING. `dynamicAt` forward-fills, so the
 * level "in force" at a note is usually one placed bars earlier; a selector
 * showing that would claim this note carries a marking it does not, and picking
 * the same value again would silently ADD one. This cell edits the marker AT
 * this position and shows `none` when there is not one.
 */
export function scoreDynValue(node: ModuleNode | undefined): string {
  const n = readSelectedNote(node);
  if (!n) return readArmedDynamic(node) ?? SCORE_NONE;
  const here = readScore(node).dynamics.find((m) => m.bar === n.bar && m.tick === n.tick);
  return here ? here.level : SCORE_NONE;
}

export function scoreSetDyn(nodeId: string, v: string): void {
  const level = (DYNAMIC_LEVELS as string[]).includes(v) ? (v as DynamicLevel) : null;
  armDynamic(nodeId, level);
  const note = liveSelected(nodeId);
  if (!note) return;
  if (level === null) clearDynamicAt(nodeId, note.bar, note.tick);
  else placeDynamic(nodeId, note.bar, note.tick, level);
}

/** The level actually IN FORCE at the selection — for the accessible name only,
 *  never painted. Forward-filled, so it answers "what will this note sound
 *  like", which the selector above deliberately does not. */
export function scoreDynInForce(node: ModuleNode | undefined): DynamicLevel | null {
  const n = readSelectedNote(node);
  if (!n) return null;
  return dynamicAt(n.bar, n.tick, readScore(node).dynamics);
}

// ── TIE — the selection, to the note after it ───────────────────────────────

export function scoreTieValue(node: ModuleNode | undefined): boolean {
  const n = readSelectedNote(node);
  return n ? isTiedToNext(node, n.id) : readArmedTie(node);
}

export function scoreSetTie(nodeId: string, on: boolean): void {
  // Armed, this is LEGATO MODE: each note you write is tied to the one before
  // it. With a note selected it is the ordinary per-note tie — and, unlike the
  // card's two-click pick, it can take one OFF again.
  armTie(nodeId, on);
  const note = liveSelected(nodeId);
  if (note) setTiedToNext(nodeId, note.id, on);
}

// ── END — the stop-music bar ────────────────────────────────────────────────

export function scoreStopOptions(): SelectorOption<string>[] {
  return [
    { value: SCORE_NONE, label: 'none', title: 'the piece plays to the end of the last page' },
    { value: 'here', label: 'here', title: 'the piece ends at the selected note — or, with nothing selected, where the written music ends' },
  ];
}

export function scoreStopValue(node: ModuleNode | undefined): string {
  return readScore(node).stopBar ? 'here' : SCORE_NONE;
}

export function scoreSetStop(nodeId: string, v: string): void {
  if (v !== 'here') {
    clearStopBar(nodeId);
    return;
  }
  const note = liveSelected(nodeId);
  if (note) {
    setStopBar(nodeId, note.bar, note.tick);
    return;
  }
  // ⚠ NO SELECTION ⇒ END THE PIECE WHERE THE WRITTEN MUSIC ENDS, which is both
  // the most common thing anyone wants from this control and what keeps it live
  // on a score with nothing selected. On an EMPTY score that is the end of bar
  // one — `liveStopGridTick` clamps into `[1, endOfPages]`, so a stop bar can
  // never produce a zero-length piece.
  const notes = sortedNotes(readScore(nodeOf(nodeId)).notes);
  const last = notes.at(-1);
  if (!last) {
    setStopBar(nodeId, 0, TICKS_PER_BAR);
    return;
  }
  const end = last.tick + tickWidth(last.duration);
  if (end >= TICKS_PER_BAR) setStopBar(nodeId, last.bar + 1, 0);
  else setStopBar(nodeId, last.bar, end);
}

// ── LOOP ────────────────────────────────────────────────────────────────────

export function scoreLoopValue(node: ModuleNode | undefined): boolean {
  return readScore(node).loop;
}

export function scoreSetLoop(nodeId: string, on: boolean): void {
  setLoop(nodeId, on);
}

// ── KEY SIGNATURE ───────────────────────────────────────────────────────────

export function scoreKeyOptions(): SelectorOption<string>[] {
  const out: SelectorOption<string>[] = [];
  for (let ks = MIN_KEY_SIGNATURE; ks <= MAX_KEY_SIGNATURE; ks++) {
    out.push({
      value: String(ks),
      label: keySignatureName(ks),
      title:
        ks === 0
          ? 'no sharps or flats'
          : `${Math.abs(ks)} ${ks > 0 ? 'sharp' : 'flat'}${Math.abs(ks) === 1 ? '' : 's'} — respells every note that carries no accidental of its own`,
    });
  }
  return out;
}

export function scoreKeyValue(node: ModuleNode | undefined): string {
  return String(readScore(node).keySignature);
}

export function scoreSetKey(nodeId: string, v: string): void {
  const n = Number(v);
  if (Number.isFinite(n)) setKeySignature(nodeId, n);
}

// ── PAGES — how long the piece is ───────────────────────────────────────────

export function scorePagesOptions(): SelectorOption<string>[] {
  return Array.from({ length: MAX_PAGES }, (_, i) => ({
    value: String(i + 1),
    label: String(i + 1),
    title:
      i === 0
        ? 'one page — sixteen bars'
        : `${i + 1} pages — ${(i + 1) * 16} bars. Shrinking never deletes notes; they stop sounding and come back if you grow it again.`,
  }));
}

export function scorePagesValue(node: ModuleNode | undefined): string {
  return String(readScore(node).pages);
}

export function scoreSetPages(nodeId: string, v: string): void {
  const n = Number(v);
  if (Number.isFinite(n)) setPages(nodeId, n);
}
