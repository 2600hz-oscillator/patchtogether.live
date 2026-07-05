// packages/web/src/lib/audio/note-entry.ts
//
// Note-name <-> MIDI int conversion + helpers for the Sequencer / Cartesian
// text-entry pitch input (D5).
//
// Format:
//   - Accepted: 'a1', 'A1', 'a#1', 'aB1', 'db4', 'F#8', etc.
//   - Whitespace ignored; case-insensitive on input.
//   - Sharps via '#', flats via 'b'. Both forms parsed; canonicalize to sharp.
//   - Range: 'a1' (MIDI 33, 55Hz) .. 'f#8' (MIDI 102, ~5919.911 Hz).
//
// MIDI convention used everywhere here: a4 = 69, c4 = 60, c-1 = 0.
// V/oct convention used elsewhere in the codebase: 0V = C4 = MIDI 60. So
// midiToVOct(m) = (m - 60) / 12.

// Range covers C0..C8 (the user-requested span — see CV-semantic
// rework PR `feat/cv-additive-semantic-and-pitch-c0-c8`). C0 (MIDI
// 12, 16.35 Hz) sits below human pitch perception but is a legitimate
// modulation source for filter cutoff, LFO rate, etc.; C8 (MIDI 108,
// 4186 Hz) is the top of an 88-key piano. Pre-rework cap was a1..f#8
// (MIDI 33..114) which excluded C0/C1 — users could not type "c1"
// into sequencer steps even though those notes are valid voct sources.
export const MIN_MIDI = 12;  // c0  = 16.35   Hz
export const MAX_MIDI = 108; // c8  = 4186.01 Hz
//
// Note: the spec text in .myrobots/plans/sequencer-cartesian-note-entry.md
// lists f#8 as MIDI 102 in the "ART tests" table, but with the standard
// convention (a4 = MIDI 69) and the listed frequency 5919.911 Hz, the correct
// MIDI int for f#8 is 114. We use the correct value here since the two fixed
// anchors (a4=69=440Hz universal; 5919.911 Hz at the top end) are unambiguous;
// the MIDI column in the spec was a typo.
export const C4_MIDI = 60;
/** Default seed pitch for newly-created Sequencer steps + Cartesian cells.
 *  C3 is one octave below the V/oct origin (C4 = 0V), which is in the middle
 *  of a typical bass-to-lead range — easier to hear immediately than C4. */
export const C3_MIDI = 48;
export const A4_MIDI = 69;
export const A4_HZ = 440;

const SHARP_NAMES = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b'] as const;

// Pitch-class index 0..11 for each spelling. Lowercase canonical. Note that
// 'b#' wraps to next octave's 'c' and 'cb' wraps to previous octave's 'b' —
// we do not handle wrapping spellings; out-of-class names return null.
const PITCH_CLASS: Record<string, number> = {
  'c': 0,
  'c#': 1, 'db': 1,
  'd': 2,
  'd#': 3, 'eb': 3,
  'e': 4,
  'f': 5,
  'f#': 6, 'gb': 6,
  'g': 7,
  'g#': 8, 'ab': 8,
  'a': 9,
  'a#': 10, 'bb': 10,
  'b': 11,
};

/** Strip whitespace and lowercase. */
function normalize(input: string): string {
  return input.replace(/\s+/g, '').toLowerCase();
}

/**
 * Parse a user-entered note name to a MIDI int in [MIN_MIDI, MAX_MIDI], or
 * null on invalid input or out-of-range.
 *
 * Accepts:
 *   'a4', 'A4', 'a#4', 'aB4' (== a#4? NO, B is a SHARP per spec... wait,
 *   re-read spec: 'sharps via #, flats via b. Both forms parsed.' so 'ab4'
 *   means a-flat-4. Same letter case-insensitive only in pitch-letter slot
 *   and digit. The accidental is positional: char after letter, before digit).
 *
 * Algorithm:
 *   1. normalize (strip ws, lowercase)
 *   2. regex out [a-g] then optional accidental [#b], then signed octave digits
 *   3. look up pitch class; 12*(octave+1) + class = MIDI
 */
export function parseNoteName(input: string): number | null {
  if (typeof input !== 'string') return null;
  const s = normalize(input);
  if (s.length === 0) return null;

  // Pattern: letter [a-g], optional accidental [#b], signed integer octave.
  // Octave covers any int but we'll bounds-check after computing MIDI.
  const m = /^([a-g])([#b]?)(-?\d+)$/.exec(s);
  if (!m) return null;
  const letter = m[1];
  const accidental = m[2];
  const octStr = m[3];

  const className = letter + accidental;
  const cls = PITCH_CLASS[className];
  if (cls === undefined) return null;

  const octave = parseInt(octStr, 10);
  if (!Number.isFinite(octave)) return null;

  const midi = (octave + 1) * 12 + cls;
  if (midi < MIN_MIDI || midi > MAX_MIDI) return null;
  return midi;
}

/**
 * Canonical note-name spelling for a MIDI int. Sharps only; lowercase.
 * Returns empty string if midi is outside the supported range.
 */
export function noteNameForMidi(midi: number): string {
  if (!Number.isFinite(midi)) return '';
  const m = Math.round(midi);
  if (m < MIN_MIDI || m > MAX_MIDI) return '';
  const cls = ((m % 12) + 12) % 12;
  const oct = Math.floor(m / 12) - 1;
  return `${SHARP_NAMES[cls]}${oct}`;
}

/** Convert MIDI int to V/oct using the codebase convention (0V = C4 = MIDI 60). */
export function midiToVOct(midi: number): number {
  return (midi - C4_MIDI) / 12;
}

/** Convert V/oct CV to MIDI int (rounded to nearest semitone). */
export function vOctToMidi(vOct: number): number {
  return Math.round(vOct * 12 + C4_MIDI);
}

/** Frequency in Hz for a MIDI int (equal-tempered, A4=440Hz). */
export function midiToHz(midi: number): number {
  return A4_HZ * Math.pow(2, (midi - A4_MIDI) / 12);
}

// ---------------- Migration / shape interop ----------------

/** Max simultaneous voices a poly step can hold (NUMPAD+ poly mode records up
 *  to this many of the keys held on the keypad). */
export const NOTE_STEP_MAX_VOICES = 5;

export interface NoteStep {
  on: boolean;
  midi: number | null;
  /** Polyphonic held notes (NUMPAD+ poly mode): up to NOTE_STEP_MAX_VOICES MIDI
   *  ints recorded from the keys HELD when the step was captured. `midi` mirrors
   *  the LOWEST of these so monophonic consumers (which only read `midi`) keep
   *  working; absent/empty ⇒ a plain monophonic step. */
  midis?: number[];
}

/**
 * Read a {on, midi: int|null} step shape and return a canonical NoteStep.
 * A midi outside [MIN_MIDI, MAX_MIDI] becomes null. on flag preserved.
 */
export function coerceToNoteStep(raw: unknown): NoteStep {
  if (!raw || typeof raw !== 'object') return { on: false, midi: null };
  const r = raw as Record<string, unknown>;
  const on = !!r.on;
  const step: NoteStep = { on, midi: coerceMidiField(r) };
  // Polyphonic held-notes (NUMPAD+ poly) — optional + back-compat: validated
  // MIDI ints, capped to NOTE_STEP_MAX_VOICES. Consumers that only read `midi`
  // ignore it. Only attached when non-empty so mono steps stay `{on, midi}`.
  if (Array.isArray(r.midis)) {
    const midis = (r.midis as unknown[])
      .filter((m): m is number => typeof m === 'number' && Number.isFinite(m))
      .map((m) => Math.round(m))
      .filter((m) => m >= MIN_MIDI && m <= MAX_MIDI)
      .slice(0, NOTE_STEP_MAX_VOICES);
    if (midis.length > 0) step.midis = midis;
  }
  return step;
}

/** Resolve the canonical `midi` field from a v2 (`midi`) step. Fresh text /
 *  keyboard note entry always writes `midi`, so that is the only shape read. */
function coerceMidiField(r: Record<string, unknown>): number | null {
  if ('midi' in r) {
    const m = r.midi;
    if (typeof m === 'number' && Number.isFinite(m)) {
      const rounded = Math.round(m);
      return rounded >= MIN_MIDI && rounded <= MAX_MIDI ? rounded : null;
    }
    return null;
  }
  return null;
}
