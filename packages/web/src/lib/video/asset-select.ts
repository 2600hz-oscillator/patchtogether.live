// packages/web/src/lib/video/asset-select.ts
//
// Shared PURE helper for the "7-slot asset selector" on the video SOURCE
// modules (PICTUREBOX + VIDEOVARISPEED). A note/gate output from a clip
// player (or any pitch+gate source) selects which of 7 loaded image/video
// assets a module displays.
//
// DESIGN (decided — implemented exactly here):
//   The 7 slots map to the default clip's in-key rows — the C-major scale
//   degrees starting at C3 — matched by PITCH CLASS (octave-independent):
//
//     slot1 = C  (MIDI 48 / pc 0)
//     slot2 = D  (MIDI 50 / pc 2)
//     slot3 = E  (MIDI 52 / pc 4)
//     slot4 = F  (MIDI 53 / pc 5)
//     slot5 = G  (MIDI 55 / pc 7)
//     slot6 = A  (MIDI 57 / pc 9)
//     slot7 = B  (MIDI 59 / pc 11)
//
//   A pitch whose class is NOT one of these 7 (i.e. a black key — C#, D#,
//   F#, G#, A#) maps to NO slot → the caller IGNORES the event (keeps
//   showing the current asset). Octave is irrelevant: a C in any octave
//   selects slot1, a B in any octave selects slot7.
//
// This module is PURE (no DOM, no engine) so it's trivially unit-testable
// (see asset-select.test.ts) and reused byte-identically by both modules.

import { vOctToMidi } from '$lib/audio/note-entry';

/** Number of asset slots a video source module can hold. */
export const ASSET_SLOTS = 7;

/** MIDI ints for the 7 default-clip in-key rows: C3..B3 (C-major degrees).
 *  Index 0 = slot1 (C3) … index 6 = slot7 (B3). */
export const ASSET_SLOT_NOTES: readonly number[] = [48, 50, 52, 53, 55, 57, 59];

/** Single-letter note labels for the 7 slots, slot1..slot7. */
export const ASSET_SLOT_LABELS: readonly string[] = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];

/** The 7 in-key pitch classes (C-major: C D E F G A B), index = slot. The
 *  index of a given pitch class in this array IS the slot index (0..6); a
 *  black-key class is absent ⇒ indexOf returns -1 ⇒ no slot. */
const SLOT_PITCH_CLASSES: readonly number[] = ASSET_SLOT_NOTES.map((m) => ((m % 12) + 12) % 12);

/**
 * Map a MIDI int to a slot index 0..6 by PITCH CLASS (octave-independent),
 * or null when the pitch class is not one of the 7 C-major degrees (a black
 * key). Rounds non-integer MIDI to the nearest semitone first.
 *
 * Pure; identical input → identical output.
 */
export function slotForMidi(midi: number): number | null {
  if (!Number.isFinite(midi)) return null;
  const pc = ((Math.round(midi) % 12) + 12) % 12;
  const slot = SLOT_PITCH_CLASSES.indexOf(pc);
  return slot === -1 ? null : slot;
}

/**
 * Map a raw V/oct CV value to a slot index 0..6, or null when the resolved
 * pitch class is a black key. Converts V/oct → MIDI via the codebase
 * convention (0V = C4 = MIDI 60), rounds to the nearest semitone, then
 * applies {@link slotForMidi}.
 *
 * The clip player emits its pitch as a V/oct ConstantSource (lane 0 of a
 * polyPitchGate cable); a downcast poly→lane0 lands here as a plain V/oct
 * number. Pure; identical input → identical output.
 */
export function slotForVOct(voct: number): number | null {
  if (!Number.isFinite(voct)) return null;
  return slotForMidi(vOctToMidi(voct));
}
