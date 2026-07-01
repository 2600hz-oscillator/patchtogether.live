// packages/web/src/lib/audio/modules/keyboard-map.ts
//
// PURE isomorphic keyboard layout + scale-lighting for the dual-Launchpad KEYS
// mode (design P1). LinnStrument CHROMATIC "fourths" layout (owner Q3): EVERY
// pad is playable (all 12 semitones); the clip's root+scale drive only the
// LIGHTING, they never hide pads (unlike a Launchpad "in-key" layout). Column
// right = +1 semitone; row up = +5 semitones (a perfect fourth) — so an octave =
// 2 rows up + 2 columns right, a chord/scale shape transposes anywhere, and the
// map is continuous in `col` (0..15) so a phrase crossing the L|R unit seam is
// the same shape.
//
// Lighting follows the LinnStrument scheme (colors applied at the launchpad-map
// render layer): every octave's ROOT = cyan, other IN-scale notes = green
// (dimmed so roots pop), OUT-of-scale = dim/off. With no scale set (chromatic)
// nothing is out-of-scale; only the root is highlighted.

import { midiToRow } from './clip-types';
import type { ScaleName } from '$lib/mike/music-theory';

export const KEY_SEMIS_PER_COL = 1; // chromatic columns (a "fret")
export const KEY_SEMIS_PER_ROW = 5; // rows a perfect fourth apart (LinnStrument default)

/**
 * MIDI note for a keyboard cell. `col` is 0-based left→right and CONTINUOUS
 * across both units (0..15); `row` is 0-based BOTTOM→top within the 6-row note
 * band. `rootMidi` is the pitch at the bottom-left cell (col 0, row 0). Offsets
 * are overridable for a future chromatic-overlap / octave-per-row setting.
 */
export function keyboardCellToMidi(
  col: number,
  row: number,
  rootMidi: number,
  semisPerCol: number = KEY_SEMIS_PER_COL,
  semisPerRow: number = KEY_SEMIS_PER_ROW,
): number {
  return rootMidi + col * semisPerCol + row * semisPerRow;
}

export type NoteRole = 'root' | 'inscale' | 'outscale';

/**
 * How a played pitch should be LIT relative to the clip's root + scale:
 *   root    — an octave root of `root` (cyan landmark),
 *   inscale — a scale note (green),
 *   outscale— not in the scale (dim/off).
 * Chromatic (scale undefined) → every non-root pitch is 'inscale' (nothing is
 * out-of-scale). Reuses `midiToRow` (null = out-of-scale) so the layout and the
 * editor agree on scale membership.
 */
export function noteRole(midi: number, root: number, scale?: ScaleName): NoteRole {
  if ((((midi - root) % 12) + 12) % 12 === 0) return 'root';
  return midiToRow(midi, root, scale) !== null ? 'inscale' : 'outscale';
}
