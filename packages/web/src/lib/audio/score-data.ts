// packages/web/src/lib/audio/score-data.ts
//
// Pure data model + math helpers for the SCORE sheet-music sequencer module.
// No AudioContext, no DOM — safe to import from unit tests, the audio module
// factory, and the UI card.
//
// Time grid: TICKS_PER_BAR = 48 (LCM of 16ths and 8th-triplets in 4/4).
// 4/4 = 4 quarters/bar = 16 sixteenths/bar; one 16th = 3 ticks.
// One 8th-triplet = 4 ticks (3 of them = 12 ticks = 1 quarter).
//
// Pitch: MIDI ints in [C4_MIDI=60, C6_MIDI=84]. Treble clef only.
//
// Staff geometry: a "staff step" indexes diatonic positions on the staff,
// where step 0 = the top staff line (F5 in C major) and step increases
// downward, one step per line/space. C4 sits below the staff on a ledger
// line.
//
// Key signature is encoded as a signed integer in [-7, 7]: positive = sharps,
// negative = flats. Order of sharps: F# C# G# D# A# E# B#. Order of flats:
// Bb Eb Ab Db Gb Cb Fb. Per-note accidentals override the key signature.
//
// "Slur vs tie": the user wording is "tie" but the spec semantics (arc over
// any two notes regardless of pitch) is what engravers call a slur. We render
// an arc and call it a tie per user vocabulary.

export const TICKS_PER_BAR = 48;
export const BARS_PER_ROW = 4;
export const ROWS = 2;
export const TOTAL_BARS = ROWS * BARS_PER_ROW;
export const C4_MIDI = 60;
export const C6_MIDI = 84;

export type NoteDuration =
  | 'whole'
  | 'half'
  | 'quarter'
  | 'eighth'
  | 'triplet8th'
  | '16th';

export const ALL_DURATIONS: readonly NoteDuration[] = [
  'whole', 'half', 'quarter', 'eighth', 'triplet8th', '16th',
] as const;

const DURATION_TICKS: Record<NoteDuration, number> = {
  whole: 48,
  half: 24,
  quarter: 12,
  eighth: 6,
  triplet8th: 4,
  '16th': 3,
};

export type Accidental = 'natural' | 'sharp' | 'flat' | null;

export type DynamicLevel = 'pp' | 'p' | 'mf' | 'f' | 'ff';

export const ALL_DYNAMICS: readonly DynamicLevel[] = ['pp', 'p', 'mf', 'f', 'ff'] as const;

export const DYNAMIC_SCALE: Record<DynamicLevel, number> = {
  pp: 0.25,
  p: 0.40,
  mf: 0.55,
  f: 0.75,
  ff: 0.95,
};

export interface ScoreNote {
  id: string;
  bar: number;
  tick: number;
  duration: NoteDuration;
  midi: number;
  staffStep: number;
  accidental: Accidental;
}

export interface DynamicMarker {
  id: string;
  bar: number;
  tick: number;
  level: DynamicLevel;
}

export interface Tie {
  id: string;
  fromNoteId: string;
  toNoteId: string;
}

export interface ScoreData {
  notes: ScoreNote[];
  dynamics: DynamicMarker[];
  ties: Tie[];
  keySignature: number;
}

export function emptyScore(): ScoreData {
  return { notes: [], dynamics: [], ties: [], keySignature: 0 };
}

/** Width in ticks of a notated duration. */
export function tickWidth(d: NoteDuration): number {
  return DURATION_TICKS[d];
}

/** Snap a raw tick (0..TICKS_PER_BAR) to the active duration's grid.
 *  16ths snap to multiples of 3, triplet-8ths to multiples of 4, etc. */
export function quantizeTick(tickInBar: number, d: NoteDuration): number {
  const w = DURATION_TICKS[d];
  const snapped = Math.round(tickInBar / w) * w;
  return Math.max(0, Math.min(TICKS_PER_BAR - w, snapped));
}

/** Sum of duration widths in a single bar's existing notes. */
export function barCapacityRemaining(bar: number, notes: readonly ScoreNote[]): number {
  let used = 0;
  for (const n of notes) if (n.bar === bar) used += DURATION_TICKS[n.duration];
  return Math.max(0, TICKS_PER_BAR - used);
}

/** Drop validation: rejects bar overflow, overlap, and out-of-range pitch.
 *  Pass `excludeId` when validating a drag-move (the moving note must not
 *  collide with itself). */
export function canPlace(
  bar: number,
  tick: number,
  duration: NoteDuration,
  midi: number,
  notes: readonly ScoreNote[],
  excludeId: string | null = null,
): boolean {
  if (bar < 0 || bar >= TOTAL_BARS) return false;
  if (tick < 0) return false;
  const w = DURATION_TICKS[duration];
  if (tick + w > TICKS_PER_BAR) return false;
  if (midi < C4_MIDI || midi > C6_MIDI) return false;
  for (const n of notes) {
    if (n.id === excludeId) continue;
    if (n.bar !== bar) continue;
    const a0 = tick, a1 = tick + w;
    const b0 = n.tick, b1 = n.tick + DURATION_TICKS[n.duration];
    if (a0 < b1 && b0 < a1) return false;
  }
  return true;
}

// ---------------- Staff <-> MIDI mapping ----------------
//
// Treble clef layout, top→bottom (each staff step = one diatonic step):
//   step  0: F5     <- top line
//   step  1: E5     <- top space
//   step  2: D5     <- 2nd line
//   step  3: C5     <- 2nd space
//   step  4: B4     <- middle line
//   step  5: A4
//   step  6: G4
//   step  7: F4
//   step  8: E4     <- bottom line
//   step  9: D4
//   step 10: C4     <- ledger line below staff
// We extend up to step -2 (B5) and -4 (C6 ledger above) for the C4..C6 range.
//
// Diatonic letter sequence (descending from F5, lowercase): f e d c b a g f e d c b a g ...
// We encode each step's natural-scale MIDI directly so callers don't need to
// re-derive the letter wheel.

const STEP_NATURAL_MIDI: number[] = [
  // step  0: F5
  77,
  // step  1: E5
  76,
  // step  2: D5
  74,
  // step  3: C5
  72,
  // step  4: B4
  71,
  // step  5: A4
  69,
  // step  6: G4
  67,
  // step  7: F4
  65,
  // step  8: E4
  64,
  // step  9: D4
  62,
  // step 10: C4
  60,
];

// Letter at each step index 0..10 (top line F5 → ledger C4).
const STEP_LETTER: ReadonlyArray<'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g'> = [
  'f', 'e', 'd', 'c', 'b', 'a', 'g', 'f', 'e', 'd', 'c',
] as const;

export const TOP_STAFF_STEP = 0;
export const BOTTOM_STAFF_STEP = 10;

/** Step index for a MIDI note's natural-spelling staff position. Returns the
 *  staff step (0..10 for the C4..F5 range; may be negative for notes above F5
 *  up to C6, treated as ledger-line positions above the staff). */
export function midiToStaffStep(midi: number): number {
  // Above F5 (top line). Step -1 = G5, -2 = A5, -3 = B5, -4 = C6.
  if (midi > STEP_NATURAL_MIDI[0]!) {
    const naturalAboveF5: number[] = [79, 81, 83, 84];
    for (let i = 0; i < naturalAboveF5.length; i++) {
      if (midi <= naturalAboveF5[i]!) return -(i + 1);
    }
    return -(naturalAboveF5.length);
  }
  // Within the staff: find the matching natural step or the nearest below.
  for (let s = 0; s <= BOTTOM_STAFF_STEP; s++) {
    if (STEP_NATURAL_MIDI[s] === midi) return s;
    if (s + 1 <= BOTTOM_STAFF_STEP && STEP_NATURAL_MIDI[s + 1]! < midi && midi < STEP_NATURAL_MIDI[s]!) {
      return s;
    }
  }
  return BOTTOM_STAFF_STEP;
}

/** Returns the natural-letter MIDI (no accidentals) at a staff step. Step 0
 *  is F5 (top line). Negative steps extend above the staff toward C6. Steps
 *  beyond BOTTOM_STAFF_STEP extend below toward... we don't go below C4. */
function naturalMidiForStep(step: number): number {
  if (step >= 0 && step <= BOTTOM_STAFF_STEP) {
    return STEP_NATURAL_MIDI[step]!;
  }
  if (step < 0) {
    // -1=G5, -2=A5, -3=B5, -4=C6
    const above = [79, 81, 83, 84];
    const idx = -step - 1;
    return above[Math.min(idx, above.length - 1)]!;
  }
  // Below the bottom: extend descending diatonically from C4.
  // (Out of range; clamp to C4.)
  return C4_MIDI;
}

/** Returns the letter (a..g) for a staff step. Used to apply key-sig. */
function letterForStep(step: number): 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g' {
  if (step >= 0 && step <= BOTTOM_STAFF_STEP) {
    return STEP_LETTER[step]!;
  }
  if (step < 0) {
    // -1=G, -2=A, -3=B, -4=C, -5=D, -6=E, -7=F, ...
    const seq: ReadonlyArray<'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g'> =
      ['g', 'a', 'b', 'c', 'd', 'e', 'f'];
    const idx = ((-step - 1) % seq.length + seq.length) % seq.length;
    return seq[idx]!;
  }
  return 'c';
}

/** Sharps order for key signatures with positive count. */
const SHARP_LETTERS: ReadonlyArray<'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g'> =
  ['f', 'c', 'g', 'd', 'a', 'e', 'b'];
/** Flats order for key signatures with negative count. */
const FLAT_LETTERS: ReadonlyArray<'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g'> =
  ['b', 'e', 'a', 'd', 'g', 'c', 'f'];

/** Key signature → set of letters that get a sharp / flat in this key. */
export function keyAccidentals(keySig: number): {
  sharps: ReadonlySet<string>;
  flats: ReadonlySet<string>;
} {
  const sharps = new Set<string>();
  const flats = new Set<string>();
  if (keySig > 0) for (let i = 0; i < Math.min(7, keySig); i++) sharps.add(SHARP_LETTERS[i]!);
  if (keySig < 0) for (let i = 0; i < Math.min(7, -keySig); i++) flats.add(FLAT_LETTERS[i]!);
  return { sharps, flats };
}

/** Convert a staff step + per-note accidental + key signature to a MIDI int.
 *  Per-note accidental ('natural'/'sharp'/'flat') overrides the key sig.
 *  null accidental means "follow the key signature". */
export function staffStepToMidi(
  step: number,
  keySig: number,
  accidental: Accidental,
): number {
  const natural = naturalMidiForStep(step);
  if (accidental === 'sharp') return natural + 1;
  if (accidental === 'flat') return natural - 1;
  if (accidental === 'natural') return natural;
  // Apply key signature.
  const letter = letterForStep(step);
  const { sharps, flats } = keyAccidentals(keySig);
  if (sharps.has(letter)) return natural + 1;
  if (flats.has(letter)) return natural - 1;
  return natural;
}

/** Cycle the key signature one step up the circle of fifths.
 *  +1 takes C(0)→G(1)→D(2)→...→C#(7); +1 from 7 stays 7 (no flip to flats). */
export function cycleKeySharper(keySig: number): number {
  return Math.min(7, keySig + 1);
}

/** Cycle the key signature one step down the circle of fifths (towards flats). */
export function cycleKeyFlatter(keySig: number): number {
  return Math.max(-7, keySig - 1);
}

// ---------------- Dynamics forward-fill ----------------

/** Compare two (bar, tick) positions. */
function posBefore(aBar: number, aTick: number, bBar: number, bTick: number): boolean {
  if (aBar !== bBar) return aBar < bBar;
  return aTick < bTick;
}

/** Returns the dynamic level in effect at the given (bar, tick) position via
 *  forward-fill: the most recent marker at-or-before the position. Default
 *  is 'mf' if no marker precedes the position. */
export function dynamicAt(
  bar: number,
  tick: number,
  dynamics: readonly DynamicMarker[],
): DynamicLevel {
  let bestLevel: DynamicLevel = 'mf';
  let haveBest = false;
  let bestBar = -1;
  let bestTick = -1;
  for (const d of dynamics) {
    // d at-or-before (bar, tick)?
    if (d.bar > bar) continue;
    if (d.bar === bar && d.tick > tick) continue;
    if (!haveBest || posBefore(bestBar, bestTick, d.bar, d.tick)) {
      bestLevel = d.level;
      bestBar = d.bar;
      bestTick = d.tick;
      haveBest = true;
    }
  }
  return bestLevel;
}

// ---------------- Tie span ----------------

/** Returns all notes covered by a tie (start, end, and everything in
 *  notation order between). Notes are ordered by (bar, tick); only notes
 *  whose (bar, tick) falls between the tie endpoints inclusive are included. */
export function notesUnderTie(
  tie: Tie,
  notes: readonly ScoreNote[],
): ScoreNote[] {
  const a = notes.find((n) => n.id === tie.fromNoteId);
  const b = notes.find((n) => n.id === tie.toNoteId);
  if (!a || !b) return [];
  const lo = posBefore(a.bar, a.tick, b.bar, b.tick) ? a : b;
  const hi = lo === a ? b : a;
  return notes
    .filter(
      (n) =>
        !posBefore(n.bar, n.tick, lo.bar, lo.tick) &&
        !posBefore(hi.bar, hi.tick, n.bar, n.tick),
    )
    .slice()
    .sort((p, q) => (p.bar - q.bar) || (p.tick - q.tick));
}

// ---------------- Note ordering helpers ----------------

/** Sort notes in playback order: ascending (bar, tick). */
export function sortNotes(notes: readonly ScoreNote[]): ScoreNote[] {
  return notes.slice().sort((a, b) => (a.bar - b.bar) || (a.tick - b.tick));
}

/** Find the note (if any) starting at the given absolute tick.
 *  absoluteTick = bar * TICKS_PER_BAR + tickInBar. */
export function noteStartingAt(
  notes: readonly ScoreNote[],
  bar: number,
  tickInBar: number,
): ScoreNote | undefined {
  return notes.find((n) => n.bar === bar && n.tick === tickInBar);
}
