// packages/web/src/lib/audio/modules/score-data.ts
//
// Pure data helpers for the SCORE module. Kept separate from score.ts so the
// vitest suite (node env) can exercise the math without pulling Faust runtime
// imports.

export const TICKS_PER_BAR = 48;
export const BARS_PER_ROW = 4;
export const TOTAL_BARS = 8;
export const TOTAL_TICKS = TICKS_PER_BAR * TOTAL_BARS;

// Pitch range C4..C6 inclusive (per plan).
export const SCORE_MIN_MIDI = 60; // C4
export const SCORE_MAX_MIDI = 84; // C6

export type NoteDuration =
  | 'whole'
  | 'half'
  | 'quarter'
  | 'eighth'
  | '16th'
  | 'triplet8th';

export type DynamicLevel = 'pp' | 'p' | 'mf' | 'f' | 'ff';

export type Accidental = 'natural' | 'sharp' | 'flat' | null;

export interface ScoreNote {
  id: string;
  bar: number; // 0..TOTAL_BARS-1
  tick: number; // 0..TICKS_PER_BAR-1
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
  keySignature: number; // -7..+7
}

export const DYNAMIC_SCALE: Record<DynamicLevel, number> = {
  pp: 0.25,
  p: 0.4,
  mf: 0.55,
  f: 0.75,
  ff: 0.95,
};

const DURATION_TICKS: Record<NoteDuration, number> = {
  whole: 48,
  half: 24,
  quarter: 12,
  eighth: 6,
  '16th': 3,
  triplet8th: 4,
};

export function tickWidth(duration: NoteDuration): number {
  return DURATION_TICKS[duration];
}

export function emptyScoreData(): ScoreData {
  return { notes: [], dynamics: [], ties: [], keySignature: 0 };
}

/** Sum of tick widths used inside a given bar. */
export function barCapacityRemaining(bar: number, notes: ScoreNote[]): number {
  let used = 0;
  for (const n of notes) {
    if (n.bar === bar) used += tickWidth(n.duration);
  }
  return Math.max(0, TICKS_PER_BAR - used);
}

/** Rejects bar overflow + overlap + out-of-range pitch. */
export function canPlace(
  bar: number,
  tick: number,
  duration: NoteDuration,
  midi: number,
  existingNotes: ScoreNote[],
  ignoreNoteId?: string,
): boolean {
  if (bar < 0 || bar >= TOTAL_BARS) return false;
  if (tick < 0 || tick >= TICKS_PER_BAR) return false;
  if (midi < SCORE_MIN_MIDI || midi > SCORE_MAX_MIDI) return false;
  const w = tickWidth(duration);
  if (tick + w > TICKS_PER_BAR) return false;
  for (const n of existingNotes) {
    if (n.bar !== bar) continue;
    if (ignoreNoteId && n.id === ignoreNoteId) continue;
    const a0 = tick;
    const a1 = tick + w;
    const b0 = n.tick;
    const b1 = n.tick + tickWidth(n.duration);
    if (a0 < b1 && b0 < a1) return false;
  }
  return true;
}

// ---------------- Staff/pitch geometry ----------------
//
// Treble-clef "staff steps" measure positions on the staff in half-line units.
// We anchor step 0 = top staff line = F5 (MIDI 77). Steps grow downward (so
// step 1 = top space = E5, step 2 = next line down = D5, etc.).
//
// Diatonic step letters in C major, descending from F5:
//   F E D C B A G F E D C B A G F E D C ...
// One letter per staff-step.

const TREBLE_TOP_LETTER_INDEX = 3; // F = index 3 in [C,D,E,F,G,A,B]
const TREBLE_TOP_OCTAVE = 5;
const LETTER_TO_PITCH_CLASS = [0, 2, 4, 5, 7, 9, 11]; // C D E F G A B

/** Diatonic letter for a staff step. step 0 = F (top line), step grows down. */
function letterIndexForStep(step: number): number {
  // Cycle [C, D, E, F, G, A, B] with descending steps.
  // letterIndex(step) = (TREBLE_TOP_LETTER_INDEX - step) mod 7
  let i = (TREBLE_TOP_LETTER_INDEX - step) % 7;
  if (i < 0) i += 7;
  return i;
}

/** Octave for a staff step. Octave decreases as step increases past B->A boundary. */
function octaveForStep(step: number): number {
  // top step = F5; each full 7-step descent drops octave by one. But the
  // octave changes specifically between B and A on the way down (i.e. when
  // crossing from C-letter to B-letter going down). Simplest: compute the
  // signed letter index without mod, then divide.
  const raw = TREBLE_TOP_LETTER_INDEX - step; // letter index without mod
  // Octaves count down each time we cross from C (idx 0) to B (idx 6) going
  // down — every floor(raw / 7) bumps octave.
  return TREBLE_TOP_OCTAVE + Math.floor(raw / 7);
}

/** Cycle-of-fifths key signature → array of pitch classes that get sharpened
 *  (positive ks) or flattened (negative ks). Returns the set of letter indices
 *  affected; sharps order F C G D A E B == letter 3,0,4,1,5,2,6. */
const SHARPS_LETTER_ORDER = [3, 0, 4, 1, 5, 2, 6]; // F C G D A E B
const FLATS_LETTER_ORDER = [6, 2, 5, 1, 4, 0, 3]; // B E A D G C F

export function keySignatureLetters(ks: number): { sharps: Set<number>; flats: Set<number> } {
  const sharps = new Set<number>();
  const flats = new Set<number>();
  if (ks > 0) {
    for (let i = 0; i < Math.min(7, ks); i++) sharps.add(SHARPS_LETTER_ORDER[i]);
  } else if (ks < 0) {
    for (let i = 0; i < Math.min(7, -ks); i++) flats.add(FLATS_LETTER_ORDER[i]);
  }
  return { sharps, flats };
}

/**
 * Map a staff step to a MIDI int, applying the key signature for the diatonic
 * letter and (if provided) overriding with a per-note accidental.
 *
 *   - 'natural' overrides the key-sig sharp/flat back to the natural letter.
 *   - 'sharp' / 'flat' override the natural letter pitch by ±1 semitone.
 *   - null = no per-note accidental, key-sig sharp/flat applies.
 */
export function staffStepToMidi(
  step: number,
  keySignature: number,
  accidental: Accidental,
): number {
  const letter = letterIndexForStep(step);
  const oct = octaveForStep(step);
  let midi = (oct + 1) * 12 + LETTER_TO_PITCH_CLASS[letter];
  if (accidental === null) {
    const { sharps, flats } = keySignatureLetters(keySignature);
    if (sharps.has(letter)) midi += 1;
    else if (flats.has(letter)) midi -= 1;
  } else if (accidental === 'sharp') {
    midi += 1;
  } else if (accidental === 'flat') {
    midi -= 1;
  }
  // 'natural' => return the bare letter pitch with no key-sig modifier
  return midi;
}

/** Inverse mapping useful for placing existing notes whose stored midi might
 *  differ from key-sig (e.g., right after a key-sig change). */
export function midiToStaffStepBestEffort(midi: number): number {
  // Use the natural letter that matches; for accidental midis, snap to the
  // letter below.
  const oct = Math.floor(midi / 12) - 1;
  const pc = ((midi % 12) + 12) % 12;
  // Find the letter whose natural pitch class is <= pc (descending letter
  // ordering on the staff).
  let letter = 0;
  for (let i = 0; i < 7; i++) {
    if (LETTER_TO_PITCH_CLASS[i] <= pc) letter = i;
  }
  // Reconstruct staff step from letter+octave.
  // step = TREBLE_TOP_LETTER_INDEX - (letter + 7*(oct - TREBLE_TOP_OCTAVE))
  const raw = letter + 7 * (oct - TREBLE_TOP_OCTAVE);
  return TREBLE_TOP_LETTER_INDEX - raw;
}

/** Forward-fill dynamics: returns the level of the latest marker whose
 *  position <= (bar,tick). Default mf when nothing precedes. */
export function dynamicAt(
  bar: number,
  tick: number,
  dynamics: DynamicMarker[],
): DynamicLevel {
  let best: DynamicMarker | null = null;
  const pos = bar * TICKS_PER_BAR + tick;
  for (const d of dynamics) {
    const dPos = d.bar * TICKS_PER_BAR + d.tick;
    if (dPos <= pos) {
      if (!best || dPos > best.bar * TICKS_PER_BAR + best.tick) {
        best = d;
      }
    }
  }
  return best ? best.level : 'mf';
}

/** Notes that are part of a tie span starting at fromNoteId through toNoteId
 *  (inclusive). Returns the list ordered by absolute position. */
export function tieSpanNotes(
  fromNoteId: string,
  toNoteId: string,
  notes: ScoreNote[],
): ScoreNote[] {
  const sorted = [...notes].sort((a, b) => {
    const aP = a.bar * TICKS_PER_BAR + a.tick;
    const bP = b.bar * TICKS_PER_BAR + b.tick;
    return aP - bP;
  });
  const fromIdx = sorted.findIndex((n) => n.id === fromNoteId);
  const toIdx = sorted.findIndex((n) => n.id === toNoteId);
  if (fromIdx < 0 || toIdx < 0) return [];
  const lo = Math.min(fromIdx, toIdx);
  const hi = Math.max(fromIdx, toIdx);
  return sorted.slice(lo, hi + 1);
}

/** Quantize a tick within a bar to the active duration's grid. */
export function quantizeTick(rawTick: number, duration: NoteDuration): number {
  const w = tickWidth(duration);
  // For non-triplet durations the grid lines up with the duration tick width.
  // For triplet8th (4 ticks) use the 4-tick grid (which subdivides each beat
  // into 3 = 12/4 partitions).
  const snap = Math.max(1, w);
  const n = Math.round(rawTick / snap) * snap;
  return Math.max(0, Math.min(TICKS_PER_BAR - 1, n));
}

// SMuFL Unicode codepoints used by the renderer. Bravura ships these.
export const SMUFL = {
  gClef: '\u{E050}',
  noteWhole: '\u{E1D2}',
  noteheadHalf: '\u{E0A3}',
  noteheadBlack: '\u{E0A4}',
  flag8thUp: '\u{E240}',
  flag8thDown: '\u{E241}',
  flag16thUp: '\u{E242}',
  flag16thDown: '\u{E243}',
  accidentalSharp: '\u{E262}',
  accidentalFlat: '\u{E260}',
  accidentalNatural: '\u{E261}',
  timeSig4: '\u{E084}',
  tuplet3: '\u{E883}',
};
