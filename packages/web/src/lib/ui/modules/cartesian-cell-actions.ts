// packages/web/src/lib/ui/modules/cartesian-cell-actions.ts
//
// THE ONE WRITE PATH for a cartesian pad — shared by `CartesianCard.svelte` and
// by the faceplate's shell cells (`shell-cells.ts`).
//
// ⚠ WHY IT IS EXTRACTED RATHER THAN RE-IMPLEMENTED. The DX7 is the precedent
// and it is a measured one: a card that owned its own action shipped a
// faceplate that could not change the voice at all. A pad's stored shape is
// `{ on, midi, chord }` inside `node.data.cells`, and any surface that writes it
// has to agree about the OTHER two fields — a pitch write that dropped `chord`
// would silently un-voice every chord pad the moment a note was retyped on the
// faceplate. One module owns the read-modify-write; both surfaces call it.
//
// ⚠ AND THE VALIDATOR IS SHARED THE SAME WAY. `parseCartesianPitch` wraps
// `parseNoteName` — the module's own note grammar, unit-tested in
// `note-entry.test.ts` — so the card's field and the face's field accept
// EXACTLY the same strings. Re-typing the grammar in either place is the
// backdraft class applied to a parser: both surfaces render correctly, both
// write plausible values, and they disagree about what `bb2` means with nothing
// red.

import { patch, ydoc } from '$lib/graph/store';
import { parseNoteName } from '$lib/audio/note-entry';
import { nextChordQuality, type ChordQuality } from '$lib/audio/poly';
import { coerceToCartesianCell, defaultCells, type Cell } from '$lib/audio/modules/cartesian';
import type { ModuleNode } from '$lib/graph/types';
import { entryAccept, entryReject, type EntryParse } from '$lib/ui/controls/text-entry-model';

/** The pad array off an already-resolved node (the shell's cell readers hand us
 *  the live node rather than an id). Pure. */
export function cartesianCellsOf(node: ModuleNode | undefined): Cell[] {
  const raw = (node?.data as Record<string, unknown> | undefined)?.cells;
  if (Array.isArray(raw)) return (raw as unknown[]).map(coerceToCartesianCell);
  return defaultCells();
}

function writeCartesianCells(nodeId: string, arr: Cell[]): void {
  const t = patch?.nodes?.[nodeId];
  if (!t) return;
  ydoc.transact(() => {
    if (!t.data) t.data = {};
    (t.data as Record<string, unknown>).cells = arr.map((c) => ({
      on: c.on,
      midi: c.midi,
      chord: c.chord ?? 'mono',
    }));
  });
}

/** Read-modify-write ONE pad, preserving every field the caller did not set. */
function mutateCell(nodeId: string, i: number, edit: (c: Cell) => Cell): void {
  const arr = cartesianCellsOf(patch?.nodes?.[nodeId]);
  const cur = arr[i] ?? { on: false, midi: null, chord: 'mono' as ChordQuality };
  arr[i] = edit({ on: cur.on, midi: cur.midi, chord: cur.chord ?? 'mono' });
  writeCartesianCells(nodeId, arr);
}

// ── PITCH ───────────────────────────────────────────────────────────────────

/**
 * Text → the pad's stored pitch.
 *
 * ⚠ AN EMPTY BOX IS ACCEPTED AND MEANS A REST (`midi: null`) — it is not a
 * rejection. That distinction is exactly why `EntryParse` is a tagged union
 * rather than a `null` sentinel: clearing a pad is a thing a player does on
 * purpose, and the card has always allowed it. Anything else that is not a note
 * name in `c0..c8` is REFUSED, and a refusal writes nothing at all — the pad
 * keeps the pitch it had.
 */
export function parseCartesianPitch(text: string): EntryParse<number | null> {
  const trimmed = text.trim();
  if (trimmed === '') return entryAccept<number | null>(null);
  const midi = parseNoteName(trimmed);
  return midi === null ? entryReject<number | null>() : entryAccept<number | null>(midi);
}

/** Commit an ALREADY-VALIDATED pitch (or a rest). Never takes raw text. */
export function commitCartesianPitch(nodeId: string, i: number, midi: number | null): void {
  mutateCell(nodeId, i, (c) => ({ ...c, midi }));
}

// ── GATE ────────────────────────────────────────────────────────────────────

export function setCartesianGate(nodeId: string, i: number, on: boolean): void {
  mutateCell(nodeId, i, (c) => ({ ...c, on }));
}

// ── CHORD ───────────────────────────────────────────────────────────────────

/** Advance pad `i` to the next chord quality — the CARD's own gesture
 *  (`chord-badge` cycles mono → maj → min), through `nextChordQuality` so the
 *  two surfaces cycle in the same order. */
export function cycleCartesianChord(nodeId: string, i: number): void {
  mutateCell(nodeId, i, (c) => ({ ...c, chord: nextChordQuality(c.chord) }));
}
