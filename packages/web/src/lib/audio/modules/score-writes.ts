// packages/web/src/lib/audio/modules/score-writes.ts
//
// THE ONE WRITE SEAM for SCORE's music.
//
// `score-data.ts` owns the arithmetic and is pure (no store, no Y.Doc);
// `score-layout.ts` owns the pixels. This file owns the WRITES, and it is the
// only place `node.data` is edited for this module. Three surfaces call it —
// the legacy card, the faceplate's staff panel, and the faceplate's band cells
// — so "the card and the face write the same keys through the same helper" is a
// property of the code rather than something to re-verify per PR.
//
// ==========================================================================
// FOUR DEFECTS THIS FILE EXISTS TO CLOSE
// ==========================================================================
//
// (1) ⚠ EVERY EDIT TO THE MUSIC WAS OUTSIDE Cmd-Z. `ScoreCard.svelte`'s
//     `writeData` and its quicksave `applySnapshot` both called
//     `ydoc.transact(fn)` with NO origin argument, and `transport-card.ts`'s
//     `setData` reaches the doc through the same untagged `transact`. `store.ts`
//     configures the UndoManager `trackedOrigins: new Set([LOCAL_ORIGIN])`, so an
//     untagged transaction (origin `null`) is silently not captured: every note,
//     tie, dynamic, key change, page, loop flag and stop bar was un-undoable.
//     THREE LINES AWAY the same card's `set()` is `setNodeParam`, which IS
//     tagged — so the BPM fader and the four ADSR faders were undoable while the
//     instrument was not. No gate could see it: `mutate.guard.test.ts`'s
//     `RAW_PARAM_WRITE` regex anchors on the literal token `.params`, and every
//     one of these writes is `.data`.
//
//     Everything here routes `mutateNode`, which defaults to LOCAL_ORIGIN.
//
// (2) ⚠ A NOTE COULD BARELY BE DELETED. `deleteNote` had exactly one call site
//     in the whole repo — the `Backspace`/`Delete` branch of the staff's own
//     `onkeydown`, acting on `event.target.closest('[data-note-id]')`, i.e. the
//     FOCUSED note. Focusing one is close to unreachable in ordinary use: `Tab`
//     is consumed bare by the rack flip (`workflow-pins.ts` RACK_FLIP_KEY, and
//     an SVG `<g tabindex="0">` is not an `isTypingTarget`), and the staff's own
//     `pointerdown` calls `preventDefault()` before capturing the pointer, which
//     suppresses the compatibility mouse events Chromium sets focus from. No
//     e2e anywhere exercised note deletion. `deleteNote` here is reachable from
//     a POINTER on both surfaces (click the selected note again).
//
// (3) ⚠ A TIE COULD NEVER BE REMOVED. `addTie` was the only writer of
//     `data.ties`; the only deletion was the collateral filter inside
//     `deleteNote` — so the only way to undo a tie was to delete one of its
//     notes, and per (2) that was itself unreachable. `setTiedToNext` is a
//     TOGGLE and removes as readily as it adds.
//
// (4) ⚠ THE PAGE COUNT WAS A ONE-WAY RATCHET. `addPage` was
//     `d.pages = min(MAX_PAGES, d.pages + 1)` and nothing anywhere decremented
//     it. That is not cosmetic: `liveTotalGridTicks` / `liveStopGridTick` derive
//     the sequence LENGTH from `pages`, so one stray click made the piece 16
//     bars longer with no way back and the playhead walked 768 extra grid ticks
//     of silence on every pass. `setPages` goes both ways.
//
//     ⚠ AND SHRINKING IS NON-DESTRUCTIVE BY DESIGN. `setPages` writes `pages`
//     and NOTHING ELSE: notes on a page that is no longer allocated survive in
//     `node.data` and simply stop sounding (`noteStartingAt` never reaches
//     them), so growing back restores the music. A filter over `d.notes` in this
//     setter would be the wrong control — it would turn a mis-click into
//     permanent data loss, which is the defect it is meant to fix, inverted.
//
// ==========================================================================
// ⚠ THE SELECTION AND THE NOTE VALUE LIVE ON THE NODE, AND THAT IS FORCED
// ==========================================================================
// A face cell's `value(node)` receives the node and nothing else
// (`shell-cells.ts`), so state the mark cells must READ — the selection AND the
// armed marks below — has literally nowhere else to live: component-local, a
// selection would make every one of them inert.
// The cost is real and is not hidden — `node.data` rides the Y.Doc, so two
// collaborators editing one score share a selection cursor. kria ships the
// identical construct with the identical property for its track/lane selection.
//
// ⚠ BOTH ARE READ WITH AN ABSENT-DEFAULT AND NEVER SEEDED. A fresh score must
// write NOTHING to `node.data` on mount: a face that seeds its own defaults
// dirties every saved patch the moment it is opened and pushes a Y.Doc update
// to every collaborator for doing nothing. Absent `noteValue` reads `'quarter'`
// (the card's own default); absent `selectedNoteId` reads `null`, and every mark
// cell renders with nothing selected.
//
// ⚠ SELECTING IS NOT EDITING, so navigation writes carry a NON-TRACKED origin.
// Tagged LOCAL_ORIGIN, Cmd-Z would walk back through every note you had merely
// LOOKED at instead of through the notes you wrote.

import { mutateNode } from '$lib/graph/mutate';
import { patch } from '$lib/graph/store';
import type { ModuleNode } from '$lib/graph/types';
import {
  MAX_PAGES,
  NOTE_DURATIONS,
  SCORE_MAX_MIDI,
  SCORE_MIN_MIDI,
  TICKS_PER_BAR,
  DYNAMIC_SCALE,
  canPlace,
  clampKeySignature,
  coerceScoreData,
  dynamicAt,
  nextNoteAfter,
  quantizeTick,
  sortedNotes,
  staffStepToMidi,
  totalBars,
  type Accidental,
  type DynamicLevel,
  type NoteDuration,
  type ScoreData,
  type ScoreNote,
} from './score-data';

/** Navigation (which note is selected, which value the next click places) is
 *  deliberately NOT on the undo stack. See the header. */
export const SCORE_VIEW_ORIGIN = Symbol('score-view');

function nodeOf(nodeId: string): ModuleNode | undefined {
  return patch.nodes[nodeId] as ModuleNode | undefined;
}

function genId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}

// ── READS ───────────────────────────────────────────────────────────────────

/** The node's music, coerced. Pure — safe on `undefined`. */
export function readScore(node: ModuleNode | undefined): ScoreData {
  return coerceScoreData(node?.data);
}

/** The note value the NEXT staff click places. Absent ⇒ `'quarter'`. */
export function readNoteValue(node: ModuleNode | undefined): NoteDuration {
  const v = (node?.data as Record<string, unknown> | undefined)?.noteValue;
  return typeof v === 'string' && (NOTE_DURATIONS as string[]).includes(v)
    ? (v as NoteDuration)
    : 'quarter';
}

/**
 * The SELECTED note, or null.
 *
 * ⚠ RESOLVED AGAINST THE LIVE ROSTER, not returned raw. A note can be deleted
 * by a collaborator (or by this player, on another surface) while its id is
 * still sitting in `data.selectedNoteId`; every mark cell would then read and
 * write a note that does not exist. Resolving here means "selected" always
 * means "selected AND present", on every consumer, with no per-cell guard.
 */
export function readSelectedNote(node: ModuleNode | undefined): ScoreNote | null {
  const id = (node?.data as Record<string, unknown> | undefined)?.selectedNoteId;
  if (typeof id !== 'string' || !id) return null;
  return readScore(node).notes.find((n) => n.id === id) ?? null;
}

export function readSelectedNoteId(node: ModuleNode | undefined): string | null {
  return readSelectedNote(node)?.id ?? null;
}

/**
 * The RAW `selectedNoteId` key, unresolved.
 *
 * ⚠ IT EXISTS FOR EXACTLY ONE CALLER AND THE DISTINCTION IS A REAL BUG THIS
 * CAUGHT. `deleteNote` clears the selection when it pointed at the note being
 * removed — but by the time it asks, the note is already gone, so the RESOLVED
 * reader returns `null`, the `=== noteId` guard never fires, and the dead id
 * stays on the node forever. Every consumer reads through `readSelectedNote`,
 * so nothing looks wrong; `node.data` just accumulates a key naming nothing.
 * Nowhere else should use this.
 */
function readRawSelectedNoteId(node: ModuleNode | undefined): string | null {
  const id = (node?.data as Record<string, unknown> | undefined)?.selectedNoteId;
  return typeof id === 'string' && id ? id : null;
}

// ── ARMED MARK STATE ────────────────────────────────────────────────────────
//
// ⚠ THE MARK CELLS ARE ARMED STATE THAT *ALSO* EDITS THE SELECTION, AND THAT IS
// NOT A CONCESSION — IT IS HOW A NOTATION EDITOR WORKS. Select a note and the
// accidental button rewrites it; select nothing and the same button ARMS what
// you write next. The legacy card had only the second half, as a MODE you had to
// remember you were in; the face has both, in one control, with no mode.
//
// ⚠ AND IT IS WHAT MAKES THEM LIVE ON A FRESH SCORE. A cell that acts only on a
// selection is INERT the moment there is nothing selected — which on a
// just-spawned score (`notes: []`) is always. `faces-parity` caught exactly that
// and it was right to: an inert cell is the sixstrum defect wearing a green
// tick, and the fix belongs in the DESIGN rather than in an exemption.

/** The accidental armed for the next placed note. Absent ⇒ none. */
export function readArmedAccidental(node: ModuleNode | undefined): Accidental {
  const v = (node?.data as Record<string, unknown> | undefined)?.armedAccidental;
  return v === 'sharp' || v === 'flat' || v === 'natural' ? v : null;
}

/** The dynamic armed for the next placed note. Absent ⇒ none. */
export function readArmedDynamic(node: ModuleNode | undefined): DynamicLevel | null {
  const v = (node?.data as Record<string, unknown> | undefined)?.armedDynamic;
  return typeof v === 'string' && v in DYNAMIC_SCALE ? (v as DynamicLevel) : null;
}

/** Whether newly placed notes are tied to the note before them. Absent ⇒ false. */
export function readArmedTie(node: ModuleNode | undefined): boolean {
  return (node?.data as Record<string, unknown> | undefined)?.armedTie === true;
}

function setArmed(nodeId: string, key: string, value: unknown): void {
  mutateNode(
    nodeId,
    (live) => {
      if (!live.data) live.data = {};
      (live.data as Record<string, unknown>)[key] = value;
    },
    { origin: SCORE_VIEW_ORIGIN },
  );
}

export function armAccidental(nodeId: string, accidental: Accidental): void {
  setArmed(nodeId, 'armedAccidental', accidental);
}
export function armDynamic(nodeId: string, level: DynamicLevel | null): void {
  setArmed(nodeId, 'armedDynamic', level);
}
export function armTie(nodeId: string, on: boolean): void {
  setArmed(nodeId, 'armedTie', on);
}

// ── THE CORE EDIT ───────────────────────────────────────────────────────────

/**
 * Apply `mut` to a CLONE of the node's music and write the result back, in one
 * origin-tagged transaction.
 *
 * The clone is not ceremony: `node.data`'s arrays hold live Y types behind a
 * proxy, and reassigning an already-integrated type at a second path is the
 * "Not supported: reassigning object that already occurs in the tree" throw.
 * Cloning to plain objects and assigning those back is what the card has always
 * done; the only thing that changed is that it now happens INSIDE a transaction
 * that re-reads the live node, so a remote write landing between render and
 * mutation cannot be clobbered by a stale snapshot.
 */
export function editScore(nodeId: string, mut: (d: ScoreData) => void): void {
  mutateNode(nodeId, (live) => {
    const cur = coerceScoreData(live.data);
    const next: ScoreData = {
      notes: cur.notes.map((n) => ({ ...n })),
      dynamics: cur.dynamics.map((d) => ({ ...d })),
      ties: cur.ties.map((t) => ({ ...t })),
      keySignature: cur.keySignature,
      pages: cur.pages,
      loop: cur.loop,
      stopBar: cur.stopBar ? { ...cur.stopBar } : undefined,
    };
    mut(next);
    if (!live.data) live.data = {};
    const td = live.data as Record<string, unknown>;
    td.notes = next.notes;
    td.dynamics = next.dynamics;
    td.ties = next.ties;
    td.keySignature = next.keySignature;
    td.pages = next.pages;
    td.loop = next.loop;
    // Null-sentinel removal (Yjs map shape) — the card's own convention.
    if (next.stopBar) td.stopBar = next.stopBar;
    else td.stopBar = undefined;
  });
}

// ── NOTES ───────────────────────────────────────────────────────────────────

/**
 * Place a note. Returns the new note's id, or null when the placement was
 * REJECTED (bar overflow, overlap, or a pitch outside C4..C6) — the caller
 * flashes its own overflow feedback on a null.
 */
export function addNote(
  nodeId: string,
  bar: number,
  tick: number,
  step: number,
  duration: NoteDuration,
): string | null {
  const node = nodeOf(nodeId);
  if (!node) return null;
  const data = readScore(node);
  // ⚠ THE ARMED MARKS APPLY AT PLACEMENT. This is the half the card never had:
  // its ♯ tool was a MODE that could only retouch a note after the fact.
  const accidental = readArmedAccidental(node);
  const armedDyn = readArmedDynamic(node);
  const armedTie = readArmedTie(node);
  const midi = staffStepToMidi(step, data.keySignature, accidental);
  if (midi < SCORE_MIN_MIDI || midi > SCORE_MAX_MIDI) return null;
  const snapTick = quantizeTick(tick, duration);
  if (!canPlace(bar, snapTick, duration, midi, data.notes, undefined, totalBars(data))) return null;
  const id = genId('n');
  editScore(nodeId, (d) => {
    d.notes.push({ id, bar, tick: snapTick, duration, midi, staffStep: step, accidental });
    // ⚠ "THE NOTE BEFORE IT" IS RESOLVED IN SCORE ORDER *AFTER* THE PUSH, NOT AS
    // "the last note written". Those differ the moment you fill a gap: place a
    // note in the middle of an existing phrase and the last-written note is
    // somewhere off to the right, so a tie to it would leap across the bar and
    // hold a gate over music it has nothing to do with.
    if (armedTie) {
      const sorted = sortedNotes(d.notes);
      const i = sorted.findIndex((n) => n.id === id);
      const prev = i > 0 ? sorted[i - 1] : null;
      if (prev) d.ties.push({ id: genId('t'), fromNoteId: prev.id, toNoteId: id });
    }
    // ⚠ A MARKER IS PLACED ONLY WHEN IT WOULD CHANGE SOMETHING. `dynamicAt`
    // forward-fills, so stamping the armed level onto every note would litter
    // the staff with markings that say what is already in force.
    if (armedDyn && dynamicAt(bar, snapTick, d.dynamics) !== armedDyn) {
      d.dynamics = d.dynamics.filter((m) => !(m.bar === bar && m.tick === snapTick));
      d.dynamics.push({ id: genId('d'), bar, tick: snapTick, level: armedDyn });
    }
  });
  return id;
}

/** Remove a note and every tie that referenced it. Clears the selection if it
 *  pointed at the removed note — a dangling selection is a mark cell reading a
 *  note nobody can see. */
export function deleteNote(nodeId: string, noteId: string): void {
  editScore(nodeId, (d) => {
    d.notes = d.notes.filter((n) => n.id !== noteId);
    d.ties = d.ties.filter((t) => t.fromNoteId !== noteId && t.toNoteId !== noteId);
  });
  if (readRawSelectedNoteId(nodeOf(nodeId)) === noteId) selectNote(nodeId, null);
}

/** Move a note to (bar, tick, step). No-op when the target is illegal, so a
 *  drag across a full bar leaves the note where it was rather than vanishing. */
export function moveNote(
  nodeId: string,
  noteId: string,
  bar: number,
  tick: number,
  step: number,
): void {
  editScore(nodeId, (d) => {
    const idx = d.notes.findIndex((n) => n.id === noteId);
    if (idx < 0) return;
    const n = { ...d.notes[idx] };
    const snapTick = quantizeTick(tick, n.duration);
    const midi = staffStepToMidi(step, d.keySignature, n.accidental);
    if (midi < SCORE_MIN_MIDI || midi > SCORE_MAX_MIDI) return;
    if (!canPlace(bar, snapTick, n.duration, midi, d.notes, n.id, totalBars(d))) return;
    n.bar = bar;
    n.tick = snapTick;
    n.staffStep = step;
    n.midi = midi;
    d.notes[idx] = n;
  });
}

/** Transpose a note by whole staff steps (the Arrow-key gesture's seam). */
export function transposeNote(nodeId: string, noteId: string, delta: number): void {
  editScore(nodeId, (d) => {
    const idx = d.notes.findIndex((n) => n.id === noteId);
    if (idx < 0) return;
    const n = { ...d.notes[idx] };
    const newStep = n.staffStep + delta;
    const midi = staffStepToMidi(newStep, d.keySignature, n.accidental);
    if (midi < SCORE_MIN_MIDI || midi > SCORE_MAX_MIDI) return;
    n.staffStep = newStep;
    n.midi = midi;
    d.notes[idx] = n;
  });
}

/**
 * Set a note's accidental ABSOLUTELY (`null` = follow the key signature).
 *
 * The card's gesture is a TOGGLE (clicking ♯ on a note that is already sharp
 * clears it) and keeps its own wrapper below; the face's selector needs to
 * express "make it this", which a toggle cannot.
 */
export function setAccidental(nodeId: string, noteId: string, accidental: Accidental): void {
  editScore(nodeId, (d) => {
    const idx = d.notes.findIndex((n) => n.id === noteId);
    if (idx < 0) return;
    const n = { ...d.notes[idx] };
    n.accidental = accidental;
    n.midi = staffStepToMidi(n.staffStep, d.keySignature, accidental);
    d.notes[idx] = n;
  });
}

/** The card's per-note ♯/♭ gesture: same wanted accidental twice clears it. */
export function toggleAccidental(nodeId: string, noteId: string, kind: 'sharp' | 'flat'): void {
  const note = readScore(nodeOf(nodeId)).notes.find((n) => n.id === noteId);
  if (!note) return;
  setAccidental(nodeId, noteId, note.accidental === kind ? null : kind);
}

// ── TIES ────────────────────────────────────────────────────────────────────

/** Is `noteId` tied FORWARD to the note that follows it in score order? */
export function isTiedToNext(node: ModuleNode | undefined, noteId: string): boolean {
  const data = readScore(node);
  const next = nextNoteAfter(noteId, data.notes);
  if (!next) return false;
  return data.ties.some((t) => t.fromNoteId === noteId && t.toNoteId === next.id);
}

/**
 * Tie `noteId` to the note after it — or UNTIE it. The face's tie control is a
 * toggle rather than the card's two-click pick, which is what makes a tie
 * removable at all (defect 3 in the header).
 */
export function setTiedToNext(nodeId: string, noteId: string, tied: boolean): void {
  const node = nodeOf(nodeId);
  if (!node) return;
  const next = nextNoteAfter(noteId, readScore(node).notes);
  if (!next) return;
  editScore(nodeId, (d) => {
    const existing = d.ties.some((t) => t.fromNoteId === noteId && t.toNoteId === next.id);
    if (tied && !existing) {
      d.ties.push({ id: genId('t'), fromNoteId: noteId, toNoteId: next.id });
    } else if (!tied) {
      d.ties = d.ties.filter((t) => !(t.fromNoteId === noteId && t.toNoteId === next.id));
    }
  });
}

/** The card's explicit two-note tie pick. */
export function addTie(nodeId: string, fromId: string, toId: string): void {
  if (fromId === toId) return;
  editScore(nodeId, (d) => {
    d.ties.push({ id: genId('t'), fromNoteId: fromId, toNoteId: toId });
  });
}

// ── DYNAMICS ────────────────────────────────────────────────────────────────

/** Place (or replace) the dynamic marker at (bar, tick). */
export function placeDynamic(nodeId: string, bar: number, tick: number, level: DynamicLevel): void {
  editScore(nodeId, (d) => {
    d.dynamics = d.dynamics.filter((m) => !(m.bar === bar && m.tick === tick));
    d.dynamics.push({ id: genId('d'), bar, tick, level });
  });
}

/** Remove any dynamic marker sitting exactly at (bar, tick). */
export function clearDynamicAt(nodeId: string, bar: number, tick: number): void {
  editScore(nodeId, (d) => {
    d.dynamics = d.dynamics.filter((m) => !(m.bar === bar && m.tick === tick));
  });
}

// ── STOP BAR / LOOP ─────────────────────────────────────────────────────────

export function setStopBar(nodeId: string, bar: number, tick: number): void {
  editScore(nodeId, (d) => {
    // Snap to 16th boundaries (multiples of 3), as the card always has.
    const snap = Math.max(0, Math.min(TICKS_PER_BAR, Math.round(tick / 3) * 3));
    d.stopBar = { bar, tick: snap };
  });
}

export function clearStopBar(nodeId: string): void {
  editScore(nodeId, (d) => { d.stopBar = undefined; });
}

export function setLoop(nodeId: string, loop: boolean): void {
  editScore(nodeId, (d) => { d.loop = loop; });
}

export function toggleLoop(nodeId: string): void {
  setLoop(nodeId, !readScore(nodeOf(nodeId)).loop);
}

// ── PAGES ───────────────────────────────────────────────────────────────────

/** Set the piece's length in pages. Writes `pages` and NOTHING ELSE — see
 *  defect 4 in the header: shrinking must be non-destructive. */
export function setPages(nodeId: string, pages: number): void {
  const n = Math.max(1, Math.min(MAX_PAGES, Math.round(pages)));
  editScore(nodeId, (d) => { d.pages = n; });
}

export function addPage(nodeId: string): void {
  setPages(nodeId, readScore(nodeOf(nodeId)).pages + 1);
}

// ── KEY SIGNATURE ───────────────────────────────────────────────────────────

/**
 * Set the key signature, respelling every note that carries no explicit
 * accidental. A note the player has marked ♯/♭/♮ is left alone — the key
 * signature is a bulk DEFAULT, not an override.
 */
export function setKeySignature(nodeId: string, ks: number): void {
  const next = clampKeySignature(ks);
  editScore(nodeId, (d) => {
    d.keySignature = next;
    d.notes = d.notes.map((n) =>
      n.accidental === null ? { ...n, midi: staffStepToMidi(n.staffStep, next, null) } : n,
    );
  });
}

export function cycleKey(nodeId: string, delta: 1 | -1): void {
  setKeySignature(nodeId, readScore(nodeOf(nodeId)).keySignature + delta);
}

export function resetKey(nodeId: string): void {
  setKeySignature(nodeId, 0);
}

// ── SELECTION + NOTE VALUE (navigation — NOT on the undo stack) ─────────────

export function selectNote(nodeId: string, noteId: string | null): void {
  mutateNode(
    nodeId,
    (live) => {
      if (!live.data) live.data = {};
      (live.data as Record<string, unknown>).selectedNoteId = noteId;
    },
    { origin: SCORE_VIEW_ORIGIN },
  );
}

export function setNoteValue(nodeId: string, duration: NoteDuration): void {
  mutateNode(
    nodeId,
    (live) => {
      if (!live.data) live.data = {};
      (live.data as Record<string, unknown>).noteValue = duration;
    },
    { origin: SCORE_VIEW_ORIGIN },
  );
}

/**
 * The staff's single pointer gesture on an EXISTING note: select it, or — if it
 * was already selected — delete it.
 *
 * ⚠ ONE COMPARISON IS THE WHOLE OF DEFECT 2's FIX, and it is deliberately here
 * rather than in the panel: the legacy card calls it too, so the affordance the
 * def's own `docs.controls` has always promised ("click a note to select/remove
 * it") becomes true on BOTH surfaces in the same commit.
 */
export function selectOrDeleteNote(nodeId: string, noteId: string): 'selected' | 'deleted' {
  if (readSelectedNoteId(nodeOf(nodeId)) === noteId) {
    deleteNote(nodeId, noteId);
    return 'deleted';
  }
  selectNote(nodeId, noteId);
  return 'selected';
}
