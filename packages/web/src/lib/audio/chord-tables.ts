// packages/web/src/lib/audio/chord-tables.ts
//
// POLYSEQZ + future chord-aware modules share these pure-data lookup tables.
// Everything in this file is dependency-free — chord intervals + voicing
// strategies are deterministic functions of (root MIDI, quality, inversion,
// voicing). We do NOT import poly.ts here so the table can be unit-tested
// independently and re-used by any module that wants chord math (a future
// chord-mode arpeggiator, a chord-quality CV input on a riff sequencer, etc.).
//
// Notes on the design choices:
//   - Quality labels match the literal user-facing UI strings ("maj", "min",
//     "maj7", "min7", "dom7", "sus2", "sus4", "dim", "aug").
//   - Inversion (0|1|2) rotates chord tones by N positions and lifts the
//     rotated tones by an octave so the root remains in the bass before the
//     voicing strategy expands across 5 voices.
//   - Voicing strategies expand a 3- or 4-note chord across the polyPitchGate
//     cable's 5 voice slots:
//       'closed'  → fill the lowest N voices with chord tones, repeat the root
//                   one octave up to fill remaining slots (default for triads;
//                   gives a tight piano-style voicing).
//       'open'    → spread chord tones across two octaves (drop the 3rd by an
//                   octave) — sounds airier; classic "open" jazz voicing.
//       'spread'  → alternating chord-degree + octave-up doubling — gives a
//                   fuller pad-like sound across the full 5 voice range.
//   - Lanes outside the chord's note count are populated with octave-doubled
//     copies (closed/spread) or left silent (open) when no octave-double makes
//     musical sense. Out-of-range lanes silently drop to gate=0.

import { MAX_MIDI, MIN_MIDI } from '$lib/audio/note-entry';

// ---------------- Types ----------------

/** All chord qualities POLYSEQZ exposes. The 'mono' value is intentionally
 *  absent — POLYSEQZ is always polyphonic. The Sequencer module's mono/maj/min
 *  triplet (defined in $lib/audio/poly) covers the mono case. */
export type ChordQualityName =
  | 'maj' | 'min'
  | 'maj7' | 'min7' | 'dom7'
  | 'sus2' | 'sus4'
  | 'dim'  | 'aug';

/** All allowed quality strings, in cycle-tap order (right-click cycles). */
export const CHORD_QUALITY_NAMES: ReadonlyArray<ChordQualityName> = [
  'maj', 'min', 'maj7', 'min7', 'dom7', 'sus2', 'sus4', 'dim', 'aug',
];

export type ChordInversion = 0 | 1 | 2;

export type ChordVoicingName = 'closed' | 'open' | 'spread';

export const CHORD_VOICING_NAMES: ReadonlyArray<ChordVoicingName> = [
  'closed', 'open', 'spread',
];

// ---------------- Quality table ----------------
//
// Intervals are in semitones above the root, sorted ascending. We DO include
// the root (0) so the table is self-contained — callers don't have to remember
// to prepend it.

const CHORD_INTERVALS: Record<ChordQualityName, ReadonlyArray<number>> = {
  maj:  [0, 4, 7],
  min:  [0, 3, 7],
  maj7: [0, 4, 7, 11],
  min7: [0, 3, 7, 10],
  dom7: [0, 4, 7, 10],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
  dim:  [0, 3, 6],
  aug:  [0, 4, 8],
};

/** Read-only accessor — returns the interval list (includes root at index 0). */
export function chordIntervals(quality: ChordQualityName): ReadonlyArray<number> {
  return CHORD_INTERVALS[quality];
}

/**
 * Apply an inversion to a chord's interval list.
 * Inversion 0 = root position; 1 = first inversion (root → up an octave);
 * 2 = second inversion (root + 3rd → up an octave).
 *
 * Returns a NEW array of semitone offsets (sorted ascending after the rotate).
 * If the chord has fewer than 3 tones (impossible with our table, but guarded
 * for completeness), inversion is clamped to a safe value.
 */
export function applyInversion(
  intervals: ReadonlyArray<number>,
  inversion: ChordInversion,
): number[] {
  const arr = [...intervals];
  if (arr.length === 0) return arr;
  const inv = Math.max(0, Math.min(inversion, arr.length - 1)) as ChordInversion;
  // Lift the first `inv` tones by an octave.
  for (let i = 0; i < inv; i++) {
    arr[i] = (arr[i] ?? 0) + 12;
  }
  arr.sort((a, b) => a - b);
  return arr;
}

// ---------------- Voicing strategy ----------------

/**
 * Output type for chordToVoices() — exactly 5 lanes mirroring the
 * polyPitchGate cable shape from $lib/audio/poly. Lanes whose midi is null
 * (out of MIDI range or surplus to chord requirements) carry gate=0 so the
 * downstream poly receiver leaves them silent.
 */
export interface ChordVoiceLane {
  midi: number | null;
  gate: 0 | 1;
}

/** Number of voice lanes POLYSEQZ emits — MUST match POLY_CHANNEL_PAIRS (poly.ts).
 *  Kept as a local literal so this table stays dependency-free (see header);
 *  polyseqz.test.ts pins `VOICE_LANES === POLY_CHANNEL_PAIRS` to catch drift. */
export const VOICE_LANES = 16;

const SILENT_LANE: ChordVoiceLane = { midi: null, gate: 0 };

function laneFor(midi: number): ChordVoiceLane {
  if (!Number.isFinite(midi)) return SILENT_LANE;
  const r = Math.round(midi);
  if (r < MIN_MIDI || r > MAX_MIDI) return SILENT_LANE;
  return { midi: r, gate: 1 };
}

/**
 * Build the 5-lane voicing for a chord step.
 *
 * Pipeline:
 *   1. Look up the chord's interval list.
 *   2. Apply inversion (rotates tones up by an octave).
 *   3. Add `root` MIDI to every offset.
 *   4. Spread across 5 lanes via the chosen voicing strategy.
 *
 * If `root` is null (empty step), every lane is silent.
 */
export function chordToVoices(
  root: number | null,
  quality: ChordQualityName,
  inversion: ChordInversion,
  voicing: ChordVoicingName,
): ChordVoiceLane[] {
  if (root === null || !Number.isFinite(root)) {
    return Array.from({ length: VOICE_LANES }, () => ({ ...SILENT_LANE }));
  }

  const intervals = applyInversion(chordIntervals(quality), inversion);
  const tones = intervals.map((iv) => Math.round(root) + iv);
  // tones is sorted ascending (applyInversion sorted) and has 3 or 4 entries.

  const lanes: ChordVoiceLane[] = [];
  if (voicing === 'closed') {
    // Lowest N lanes carry chord tones; remaining lanes octave-double the
    // root (then the 3rd, then the 5th) to fill the cable.
    for (const t of tones) lanes.push(laneFor(t));
    let fill = 0;
    while (lanes.length < VOICE_LANES) {
      const baseTone = tones[fill % tones.length] ?? tones[0]!;
      lanes.push(laneFor(baseTone + 12));
      fill++;
    }
  } else if (voicing === 'open') {
    // Drop the 3rd (intervals[1]) by an octave so chord spreads across two
    // octaves. Result: [3rd-12, root, 5th, 7th?, root+12].
    const open: number[] = [];
    if (tones.length >= 1) open.push(tones[0]!); // root
    if (tones.length >= 2) open.push(tones[1]! - 12); // 3rd dropped
    if (tones.length >= 3) open.push(tones[2]!); // 5th
    if (tones.length >= 4) open.push(tones[3]!); // 7th if present
    open.push((tones[0] ?? root) + 12); // root + octave on top
    open.sort((a, b) => a - b);
    for (const t of open) lanes.push(laneFor(t));
    while (lanes.length < VOICE_LANES) lanes.push({ ...SILENT_LANE });
    // open may produce 4-5 lanes already; if more than 5 we keep first 5.
    if (lanes.length > VOICE_LANES) lanes.length = VOICE_LANES;
  } else {
    // 'spread': alternate chord-degree + octave-up doubling — fills 5 lanes
    // across two octaves with extra body.
    //   [root, 3rd, 5th, root+12, 5th+12]   (triad)
    //   [root, 3rd, 5th, 7th, root+12]      (4-note chord)
    if (tones.length >= 4) {
      for (const t of tones) lanes.push(laneFor(t));
      lanes.push(laneFor(tones[0]! + 12));
    } else {
      // Triad case: triad + root-octave + 5th-octave.
      for (const t of tones) lanes.push(laneFor(t));
      lanes.push(laneFor(tones[0]! + 12));
      lanes.push(laneFor((tones[2] ?? tones[0]!) + 12));
    }
    while (lanes.length < VOICE_LANES) lanes.push({ ...SILENT_LANE });
    if (lanes.length > VOICE_LANES) lanes.length = VOICE_LANES;
  }

  return lanes;
}

// ---------------- UI helpers ----------------

/** Cycle the next quality in CHORD_QUALITY_NAMES order. */
export function nextChordQualityName(
  q: ChordQualityName | undefined,
): ChordQualityName {
  const cur = q ?? 'maj';
  const idx = CHORD_QUALITY_NAMES.indexOf(cur);
  if (idx < 0) return 'maj';
  return CHORD_QUALITY_NAMES[(idx + 1) % CHORD_QUALITY_NAMES.length] as ChordQualityName;
}

/** Cycle the next voicing in CHORD_VOICING_NAMES order. */
export function nextChordVoicingName(
  v: ChordVoicingName | undefined,
): ChordVoicingName {
  const cur = v ?? 'closed';
  const idx = CHORD_VOICING_NAMES.indexOf(cur);
  if (idx < 0) return 'closed';
  return CHORD_VOICING_NAMES[(idx + 1) % CHORD_VOICING_NAMES.length] as ChordVoicingName;
}

/** Cycle inversion 0 → 1 → 2 → 0 in display order. */
export function nextInversion(inv: ChordInversion | undefined): ChordInversion {
  const cur = inv ?? 0;
  return ((cur + 1) % 3) as ChordInversion;
}
