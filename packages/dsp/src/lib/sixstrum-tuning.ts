// packages/dsp/src/lib/sixstrum-tuning.ts
//
// SIX STRUM — pure tuning + guitar-chord voicing tables (DSP-package, so the
// worklet can voice a chord from the mono Chord-CV root without importing web
// $lib). Everything here is a deterministic function of (root MIDI, quality,
// tuning) — no state, no audio — so it is unit-testable in isolation.
//
// The GUITAR/BASS/HARP "modes" are NOT DSP branches: they are just different
// TUNING param values (which open-string set the voicer walks) plus knob state
// on the SIX STRUM panel. The chord VOICER is the one genuinely new bit of
// music logic (no fretboard-voicing table existed in the repo): for each
// string it picks the LOWEST chord tone at or above that string's open pitch —
// a real playable open/barre-ish shape, not a stacked triad.
//
// Octave handling: the Chord-CV root is used PITCH-CLASS only (it selects WHICH
// chord — C, D, F#…); the guitar's own REGISTER knob + the tuning set the
// octave. So a rising CV line transposes the chord by pitch-class, and REGISTER
// moves the whole instrument between bass/guitar/harp octaves. (Octave-tracking
// the raw root is a documented follow-up.)

/** Every SIX STRUM voice is one string — always 6, in all three modes. */
export const SIXSTRUM_STRINGS = 6;

export type SixStrumTuning = 'guitar' | 'bass' | 'harp';

/** Tuning ids in selector order (discrete param 0..2). */
export const SIXSTRUM_TUNINGS: readonly SixStrumTuning[] = ['guitar', 'bass', 'harp'] as const;

/**
 * Open-string base MIDI per tuning, low string → high string (6 entries).
 *   guitar — standard EADGBE: E2 A2 D3 G3 B3 E4.
 *   bass   — 6-string low-B BEADGC: B0 E1 A1 D2 G2 C3 (an octave-ish below
 *            guitar; REGISTER usually left at 0 for this set, or drop the whole
 *            instrument further).
 *   harp   — a diatonic C-major open run C3 D3 E3 G3 A3 C4 (open strings ring a
 *            pentatonic-ish chord; the voicer + REGISTER move it musically).
 */
export const TUNING_OPEN_MIDI: Record<SixStrumTuning, readonly number[]> = {
  guitar: [40, 45, 50, 55, 59, 64],
  bass: [23, 28, 33, 38, 43, 48],
  harp: [48, 50, 52, 55, 57, 60],
};

export type SixStrumChordQuality =
  | 'maj'
  | 'min'
  | 'dom7'
  | 'maj7'
  | 'min7'
  | 'sus4'
  | 'power5'
  | 'octave';

/** Chord qualities in selector order (discrete param 0..7). */
export const SIXSTRUM_QUALITIES: readonly SixStrumChordQuality[] = [
  'maj',
  'min',
  'dom7',
  'maj7',
  'min7',
  'sus4',
  'power5',
  'octave',
] as const;

/** Semitone intervals above the root for each quality (pitch-class set source). */
export const SIXSTRUM_CHORD_INTERVALS: Record<SixStrumChordQuality, readonly number[]> = {
  maj: [0, 4, 7],
  min: [0, 3, 7],
  dom7: [0, 4, 7, 10],
  maj7: [0, 4, 7, 11],
  min7: [0, 3, 7, 10],
  sus4: [0, 5, 7],
  power5: [0, 7],
  octave: [0],
};

/** Positive modulo (JS `%` keeps the sign of the dividend). */
function pmod(n: number, m: number): number {
  return ((n % m) + m) % m;
}

/** Resolve a discrete param index to a tuning id (clamped). */
export function tuningForIndex(idx: number): SixStrumTuning {
  const i = Math.max(0, Math.min(SIXSTRUM_TUNINGS.length - 1, Math.round(idx)));
  return SIXSTRUM_TUNINGS[i]!;
}

/** Resolve a discrete param index to a chord quality (clamped). */
export function qualityForIndex(idx: number): SixStrumChordQuality {
  const i = Math.max(0, Math.min(SIXSTRUM_QUALITIES.length - 1, Math.round(idx)));
  return SIXSTRUM_QUALITIES[i]!;
}

/** The set of pitch classes (0..11) sounded by `quality` rooted at `rootMidi`. */
export function chordPitchClasses(
  rootMidi: number,
  quality: SixStrumChordQuality,
): ReadonlyArray<number> {
  const root = Math.round(rootMidi);
  const intervals = SIXSTRUM_CHORD_INTERVALS[quality];
  const seen = new Set<number>();
  for (const iv of intervals) seen.add(pmod(root + iv, 12));
  return [...seen];
}

/** The lowest MIDI ≥ `open` whose pitch class is in `pcs`. Falls back to the
 *  open pitch if (impossibly) none matches within an octave. */
function nearestChordToneAtOrAbove(open: number, pcs: ReadonlySet<number>): number {
  for (let m = open; m < open + 12; m++) {
    if (pcs.has(pmod(m, 12))) return m;
  }
  return open;
}

/**
 * Voice a chord across the 6 strings of `tuning`: each string plays the LOWEST
 * chord tone at or above its open pitch. Returns 6 target MIDI notes (low →
 * high). Pitch-class based (see header) — the actual octave comes from the
 * tuning + the caller's REGISTER transpose.
 */
export function voiceChord(
  rootMidi: number,
  quality: SixStrumChordQuality,
  tuning: SixStrumTuning,
): number[] {
  const open = TUNING_OPEN_MIDI[tuning];
  const pcs = new Set(chordPitchClasses(rootMidi, quality));
  return open.map((o) => nearestChordToneAtOrAbove(o, pcs));
}

/** Open-string MIDI notes for a tuning (the pitches when the Chord input is
 *  unpatched — a bare strum rings the open strings). */
export function openStrings(tuning: SixStrumTuning): readonly number[] {
  return TUNING_OPEN_MIDI[tuning];
}
