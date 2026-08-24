// packages/web/src/lib/audio/modules/kria-types.ts
//
// Data model + PURE helpers for the `kria` module — a clean-room reimagining of
// monome's Kria grid step-sequencer (inspired by monome Kria; NO monome source
// or doc prose is reproduced — behavior was reimplemented from the public docs).
// Kept separate from the def/factory (kria.ts) so the model, the per-track
// step-advance math, the note/scale → V/oct mapping, pattern-cueing quantize,
// and loop/direction math are all unit-testable with no AudioContext or Y.Doc.
// (This file exports no `*Def`, so the audio module glob ignores it; it is on
// the module-manifest non-def allow-list.)
//
// Kria's shape (Ansible Kria): 4 independent TRACKS, each with its own per-step
// TRIG / NOTE / OCTAVE / DURATION sequences (Phase A) plus per-track LOOP, TIME
// (clock division), per-step PROBABILITY, per-step GLIDE, a per-track playback
// DIRECTION, and a shared SCALE. 16 pattern slots hold a full snapshot of all
// four tracks; switching patterns is QUANTIZED (cued, applied on a boundary).
// Outputs: 4× pitch (V/oct) + 4× gate.

import { midiToVOct, C3_MIDI, MIN_MIDI, MAX_MIDI } from '$lib/audio/note-entry';
import {
  MAJOR_SCALE_STEPS,
  MINOR_SCALE_STEPS,
  PENTATONIC_SCALE_STEPS,
} from '$lib/mike/music-theory';

// ---------------------------------------------------------------------------
// Dimensions
// ---------------------------------------------------------------------------
/** Kria is a 4-track sequencer. */
export const KRIA_TRACKS = 4;
/** Steps per track. Kria's grid shows 16 columns = 16 steps. */
export const KRIA_STEPS = 16;
/** Pattern slots (Kria's top-row pattern page = 16 slots). */
export const KRIA_PATTERNS = 16;
/** Grid surface (mext "monome 128", varibright). */
export const GRID_W = 16;
export const GRID_H = 8;

/** Default MIDI root for a track's NOTE page (one octave below C4 = 0V). */
export const KRIA_DEFAULT_ROOT = C3_MIDI; // 48

// ---------------------------------------------------------------------------
// Scales
// ---------------------------------------------------------------------------
export type KriaScaleName = 'major' | 'minor' | 'pentatonic' | 'chromatic';

/** Built-in scale presets, in the order Kria's SCALE page lists them. The
 *  NOTE page's Y axis selects a degree WITHIN the active scale (Kria semantics:
 *  pitch is "within the current scale", not a free chromatic). */
export const KRIA_SCALE_PRESETS: readonly KriaScaleName[] = [
  'major',
  'minor',
  'pentatonic',
  'chromatic',
] as const;

/** Semitone offsets for a scale (degree → semitones above the root). */
export function scaleSemitones(scale: KriaScaleName): readonly number[] {
  switch (scale) {
    case 'major':
      return MAJOR_SCALE_STEPS; // [0,2,4,5,7,9,11]
    case 'minor':
      return MINOR_SCALE_STEPS; // [0,2,3,5,7,8,10]
    case 'pentatonic':
      return PENTATONIC_SCALE_STEPS; // [0,2,4,7,9]
    case 'chromatic':
    default:
      return [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  }
}

// ---------------------------------------------------------------------------
// Playback direction (Kria's DIRECTION modes)
// ---------------------------------------------------------------------------
export type KriaDirection = 'forward' | 'reverse' | 'pingpong' | 'drunk' | 'random';
export const KRIA_DIRECTIONS: readonly KriaDirection[] = [
  'forward',
  'reverse',
  'pingpong',
  'drunk',
  'random',
] as const;

/** Per-track TIME (clock) divisions — how many master ticks per step advance.
 *  Kria's TIME page sets a per-track clock division/multiplier; we model the
 *  common integer divisions (a value of N = advance once every N base steps).
 *  1 = every 16th-note tick, 2 = every 8th, 4 = quarter, etc. */
export const KRIA_TIME_DIVISIONS: readonly number[] = [1, 2, 3, 4, 6, 8, 12, 16] as const;

// ---------------------------------------------------------------------------
// Per-track / per-step model
// ---------------------------------------------------------------------------
/** A single track's full per-step + per-track state. All arrays are length
 *  KRIA_STEPS. Kept as plain arrays of primitives so the whole thing
 *  round-trips through Y.Doc / JSON with no class instances. */
export interface KriaTrack {
  /** TRIG page — does this step fire? */
  trig: boolean[];
  /** TRIG ratchet sub-divisions per step (1 = single hit, 2..4 = ratchets). */
  ratchet: number[];
  /** NOTE page — scale DEGREE per step (0-based; mapped through the scale +
   *  octave to a MIDI note). Kria's Y axis selects pitch within the scale. */
  note: number[];
  /** OCTAVE page — per-step octave offset (0..5, Kria's top-6 octave keys). */
  octave: number[];
  /** DURATION page — gate length per step, in step fractions (0..1 of the
   *  step duration; Kria's duration sliders, relative to the clock). */
  duration: number[];
  /** PROBABILITY page — per-step trigger probability (0..1; Kria's 4-level
   *  fader: 1, 0.5, 0.25, 0). */
  probability: number[];
  /** GLIDE page — per-step pitch slew time, seconds (0 = no glide). */
  glide: number[];
  /** LOOP — per-track loop start step (0..KRIA_STEPS-1). */
  loopStart: number;
  /** LOOP — per-track loop length in steps (1..KRIA_STEPS). Loop wraps if
   *  loopStart + loopLength exceeds KRIA_STEPS. */
  loopLength: number;
  /** TIME — per-track clock division (a value from KRIA_TIME_DIVISIONS). */
  timeDivision: number;
  /** DIRECTION — per-track playback direction. */
  direction: KriaDirection;
  /** Track mute (Kria: hold LOOP + press TRACK). */
  muted: boolean;
}

/** One pattern slot = a full snapshot of all 4 tracks + the active scale. */
export interface KriaPattern {
  tracks: KriaTrack[];
  scale: KriaScaleName;
  /** MIDI root applied to the NOTE/OCTAVE math for every track in this slot. */
  root: number;
}

/** Persisted on node.data. The pattern bank is a STRING-keyed record (slot
 *  index → pattern), NOT a JS array, so it round-trips through SyncedStore
 *  (Yjs forbids `arr[i] = x` index assignment on a live Y.Array; an object
 *  record supports `obj[key] = x` — same discipline clipplayer uses for its
 *  clip bank). Slots are '0'..'15'; absent/null = empty. */
export type KriaPatternBank = Record<string, KriaPattern | null>;
export interface KriaData {
  /** 16 pattern slots keyed '0'..'15'; sparse — absent/null = empty. */
  patterns?: KriaPatternBank;
  /** The pattern slot currently playing (0..KRIA_PATTERNS-1). */
  active?: number;
  /** A cued pattern slot to switch to, or null = nothing cued. Applied when
   *  the cue clock counts down to zero (quantized switching). */
  cued?: number | null;
  /** Cue-clock length in steps: the cued pattern activates after this many
   *  track-0 step advances (Kria's pattern-page row-2 cue clock). 0 = switch
   *  at the next track-0 loop boundary (the simplest quantize). */
  cueSteps?: number;
}

// ---------------------------------------------------------------------------
// Defaults + coercion
// ---------------------------------------------------------------------------
export function defaultTrack(): KriaTrack {
  return {
    trig: new Array<boolean>(KRIA_STEPS).fill(false),
    ratchet: new Array<number>(KRIA_STEPS).fill(1),
    note: new Array<number>(KRIA_STEPS).fill(0),
    octave: new Array<number>(KRIA_STEPS).fill(0),
    duration: new Array<number>(KRIA_STEPS).fill(0.5),
    probability: new Array<number>(KRIA_STEPS).fill(1),
    glide: new Array<number>(KRIA_STEPS).fill(0),
    loopStart: 0,
    loopLength: KRIA_STEPS,
    timeDivision: 1,
    direction: 'forward',
    muted: false,
  };
}

export function defaultPattern(): KriaPattern {
  return {
    tracks: Array.from({ length: KRIA_TRACKS }, defaultTrack),
    scale: 'major',
    root: KRIA_DEFAULT_ROOT,
  };
}

/** A fresh KriaData: pattern 0 seeded (so the card has something to edit),
 *  the rest empty. */
export function defaultKriaData(): KriaData {
  return { patterns: { '0': defaultPattern() }, active: 0, cued: null, cueSteps: 0 };
}

/** Read a raw pattern slot value from a bank (accepts an object record OR a
 *  legacy array shape, so a seeded-as-array test fixture still reads). */
function bankSlot(bank: KriaPatternBank | undefined, slot: number): unknown {
  if (!bank) return undefined;
  // Object record (the canonical shape) — string key.
  const byKey = (bank as Record<string, unknown>)[String(slot)];
  if (byKey !== undefined) return byKey;
  // Array fallback (test fixtures / older saves seeded patterns as an array).
  if (Array.isArray(bank)) return (bank as unknown[])[slot];
  return undefined;
}

function clampInt(n: unknown, lo: number, hi: number, fallback: number): number {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return fallback;
  return Math.max(lo, Math.min(hi, v));
}
function clampNum(n: unknown, lo: number, hi: number, fallback: number): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(lo, Math.min(hi, v));
}
function coerceBoolArr(raw: unknown, fill: boolean): boolean[] {
  const out = new Array<boolean>(KRIA_STEPS).fill(fill);
  if (Array.isArray(raw)) {
    for (let i = 0; i < KRIA_STEPS && i < raw.length; i++) out[i] = !!raw[i];
  }
  return out;
}
function coerceNumArr(raw: unknown, lo: number, hi: number, fill: number, round: boolean): number[] {
  const out = new Array<number>(KRIA_STEPS).fill(fill);
  if (Array.isArray(raw)) {
    for (let i = 0; i < KRIA_STEPS && i < raw.length; i++) {
      out[i] = round ? clampInt(raw[i], lo, hi, fill) : clampNum(raw[i], lo, hi, fill);
    }
  }
  return out;
}

function coerceDirection(raw: unknown): KriaDirection {
  return KRIA_DIRECTIONS.includes(raw as KriaDirection) ? (raw as KriaDirection) : 'forward';
}
function coerceTimeDivision(raw: unknown): number {
  const v = Math.round(Number(raw));
  return KRIA_TIME_DIVISIONS.includes(v) ? v : 1;
}
export function coerceScale(raw: unknown): KriaScaleName {
  return KRIA_SCALE_PRESETS.includes(raw as KriaScaleName) ? (raw as KriaScaleName) : 'major';
}

export function coerceTrack(raw: unknown): KriaTrack {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    trig: coerceBoolArr(r.trig, false),
    ratchet: coerceNumArr(r.ratchet, 1, 4, 1, true),
    note: coerceNumArr(r.note, 0, 35, 0, true),
    octave: coerceNumArr(r.octave, 0, 5, 0, true),
    duration: coerceNumArr(r.duration, 0, 1, 0.5, false),
    probability: coerceNumArr(r.probability, 0, 1, 1, false),
    glide: coerceNumArr(r.glide, 0, 0.5, 0, false),
    loopStart: clampInt(r.loopStart, 0, KRIA_STEPS - 1, 0),
    loopLength: clampInt(r.loopLength, 1, KRIA_STEPS, KRIA_STEPS),
    timeDivision: coerceTimeDivision(r.timeDivision),
    direction: coerceDirection(r.direction),
    muted: !!r.muted,
  };
}

export function coercePattern(raw: unknown): KriaPattern | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const tracksRaw = Array.isArray(r.tracks) ? r.tracks : [];
  const tracks: KriaTrack[] = [];
  for (let i = 0; i < KRIA_TRACKS; i++) tracks.push(coerceTrack(tracksRaw[i]));
  return {
    tracks,
    scale: coerceScale(r.scale),
    root: clampInt(r.root, MIN_MIDI, MAX_MIDI, KRIA_DEFAULT_ROOT),
  };
}

/** Read the active pattern (coerced) from node.data, or null. */
export function activePattern(data: KriaData | undefined): KriaPattern | null {
  if (!data) return null;
  const idx = clampInt(data.active, 0, KRIA_PATTERNS - 1, 0);
  return coercePattern(bankSlot(data.patterns, idx));
}

/** Read pattern at a slot (coerced), or null. */
export function patternAt(data: KriaData | undefined, slot: number): KriaPattern | null {
  if (!data) return null;
  return coercePattern(bankSlot(data.patterns, slot));
}

/** True iff a slot holds a (loaded) pattern. */
export function slotOccupied(data: KriaData | undefined, slot: number): boolean {
  return !!bankSlot(data?.patterns, slot);
}

// ---------------------------------------------------------------------------
// Note/scale → V/oct mapping (PURE)
// ---------------------------------------------------------------------------
/**
 * Map a track step's NOTE degree + OCTAVE offset to a MIDI note, through the
 * pattern's scale + root. Kria semantics: the NOTE page selects a scale degree
 * (wrapping into higher octaves of the scale), and the OCTAVE page adds whole
 * octaves on top.
 */
export function stepMidi(pattern: KriaPattern, track: KriaTrack, step: number): number {
  const degrees = scaleSemitones(pattern.scale);
  const n = degrees.length;
  const deg = track.note[step] ?? 0;
  const scaleOctave = Math.floor(deg / n);
  const within = ((deg % n) + n) % n;
  const octOffset = track.octave[step] ?? 0;
  const midi = pattern.root + (scaleOctave + octOffset) * 12 + degrees[within]!;
  return Math.max(MIN_MIDI, Math.min(MAX_MIDI, midi));
}

/** V/oct for a track step (the value the pitch output emits). */
export function stepVOct(pattern: KriaPattern, track: KriaTrack, step: number): number {
  return midiToVOct(stepMidi(pattern, track, step));
}

// ---------------------------------------------------------------------------
// Loop + direction step-advance math (PURE)
// ---------------------------------------------------------------------------
/** The ordered list of step indices a track visits within its loop window,
 *  given a direction. For forward/reverse/pingpong this is deterministic;
 *  drunk/random need an RNG and are advanced incrementally (advanceStep). */
export function loopWindow(track: KriaTrack): number[] {
  const start = ((track.loopStart % KRIA_STEPS) + KRIA_STEPS) % KRIA_STEPS;
  const len = Math.max(1, Math.min(KRIA_STEPS, track.loopLength));
  const out: number[] = [];
  for (let i = 0; i < len; i++) out.push((start + i) % KRIA_STEPS);
  return out;
}

/** Per-track playback cursor. `pos` is the index WITHIN the loop window (not
 *  the raw step), and `dir` tracks pingpong direction. */
export interface KriaCursor {
  /** Index within loopWindow (0..len-1). */
  pos: number;
  /** +1 / -1 — current travel direction for pingpong. */
  dir: 1 | -1;
}

export function initialCursor(track: KriaTrack): KriaCursor {
  return { pos: 0, dir: track.direction === 'reverse' ? -1 : 1 };
}

/**
 * Advance a cursor one step for the given track + direction, returning the
 * raw STEP index now under the playhead and the next cursor. PURE — drunk /
 * random take an injectable RNG (defaults to Math.random) for deterministic
 * tests. The cursor is clamped to the current loop window length, so a loop
 * resize between calls degrades gracefully.
 */
export function advanceStep(
  track: KriaTrack,
  cursor: KriaCursor,
  rng: () => number = Math.random,
): { step: number; cursor: KriaCursor } {
  const win = loopWindow(track);
  const len = win.length;
  let pos = ((cursor.pos % len) + len) % len;
  let dir = cursor.dir;

  switch (track.direction) {
    case 'forward':
      pos = (pos + 1) % len;
      dir = 1;
      break;
    case 'reverse':
      pos = (pos - 1 + len) % len;
      dir = -1;
      break;
    case 'pingpong': {
      if (len === 1) {
        pos = 0;
      } else {
        let next = pos + dir;
        if (next >= len) {
          next = len - 2;
          dir = -1;
        } else if (next < 0) {
          next = 1;
          dir = 1;
        }
        pos = next;
      }
      break;
    }
    case 'drunk': {
      // ±1 random walk within the window.
      const move = rng() < 0.5 ? -1 : 1;
      pos = (pos + move + len) % len;
      break;
    }
    case 'random': {
      pos = Math.min(len - 1, Math.floor(rng() * len));
      break;
    }
  }
  return { step: win[pos]!, cursor: { pos, dir } };
}

/** True iff advancing this cursor would wrap to the start of the loop window
 *  (used to detect a track-0 loop boundary for pattern-cue quantize). For
 *  forward this is "next pos === 0"; we compute it without mutating state. */
export function willWrap(track: KriaTrack, cursor: KriaCursor): boolean {
  const len = loopWindow(track).length;
  if (len <= 1) return true;
  if (track.direction === 'forward') return (cursor.pos + 1) % len === 0;
  if (track.direction === 'reverse') return (cursor.pos - 1 + len) % len === len - 1;
  // pingpong/drunk/random: treat the end-of-window pass as the boundary.
  return cursor.pos === len - 1;
}

// ---------------------------------------------------------------------------
// Pattern-cue quantize (PURE)
// ---------------------------------------------------------------------------
export interface CueState {
  active: number;
  cued: number | null;
  /** Remaining track-0 step advances before the cued pattern takes over. */
  countdown: number;
}

/**
 * Resolve one track-0 advance against a cue. Kria's cue clock counts down per
 * track-0 step; when it reaches zero the cued pattern activates and the cue
 * clears. With cueSteps 0 the switch happens on the NEXT track-0 loop boundary
 * (so `boundary` must be passed true on the wrap). Returns the new cue state +
 * whether a switch fired this advance.
 *
 *  - cueSteps > 0 : decrement countdown each advance; switch at 0.
 *  - cueSteps = 0 : switch on the next loop boundary (boundary === true).
 */
export function tickCue(
  state: CueState,
  cueSteps: number,
  boundary: boolean,
): { state: CueState; switched: boolean } {
  if (state.cued === null) {
    return { state: { ...state, countdown: 0 }, switched: false };
  }
  if (cueSteps > 0) {
    const countdown = state.countdown - 1;
    if (countdown <= 0) {
      return { state: { active: state.cued, cued: null, countdown: 0 }, switched: true };
    }
    return { state: { ...state, countdown }, switched: false };
  }
  // cueSteps === 0 → quantize to the loop boundary.
  if (boundary) {
    return { state: { active: state.cued, cued: null, countdown: 0 }, switched: true };
  }
  return { state, switched: false };
}

// ---------------------------------------------------------------------------
// Card / grid edit helpers (PURE) — return NEW arrays/objects; callers mutate
// node.data under the in-place Y.Doc discipline at the call site.
// ---------------------------------------------------------------------------
export function toggleTrig(track: KriaTrack, step: number): KriaTrack {
  const trig = track.trig.slice();
  trig[step] = !trig[step];
  return { ...track, trig };
}
export function setNote(track: KriaTrack, step: number, degree: number): KriaTrack {
  const note = track.note.slice();
  note[step] = clampInt(degree, 0, 35, 0);
  return { ...track, note };
}
export function setOctave(track: KriaTrack, step: number, oct: number): KriaTrack {
  const octave = track.octave.slice();
  octave[step] = clampInt(oct, 0, 5, 0);
  return { ...track, octave };
}
export function setDuration(track: KriaTrack, step: number, dur: number): KriaTrack {
  const duration = track.duration.slice();
  duration[step] = clampNum(dur, 0, 1, 0.5);
  return { ...track, duration };
}
export function setRatchet(track: KriaTrack, step: number, n: number): KriaTrack {
  const ratchet = track.ratchet.slice();
  ratchet[step] = clampInt(n, 1, KRIA_RATCHET_MAX, 1);
  return { ...track, ratchet };
}
export function setProbability(track: KriaTrack, step: number, p: number): KriaTrack {
  const probability = track.probability.slice();
  probability[step] = clampNum(p, 0, 1, 1);
  return { ...track, probability };
}
export function setGlide(track: KriaTrack, step: number, secs: number): KriaTrack {
  const glide = track.glide.slice();
  glide[step] = clampNum(secs, 0, KRIA_GLIDE_MAX, 0);
  return { ...track, glide };
}
export function setLoopStart(track: KriaTrack, start: number): KriaTrack {
  return { ...track, loopStart: clampInt(start, 0, KRIA_STEPS - 1, 0) };
}
export function setLoopLength(track: KriaTrack, len: number): KriaTrack {
  return { ...track, loopLength: clampInt(len, 1, KRIA_STEPS, KRIA_STEPS) };
}
export function setTimeDivision(track: KriaTrack, div: number): KriaTrack {
  return { ...track, timeDivision: coerceTimeDivision(div) };
}
export function setDirection(track: KriaTrack, dir: unknown): KriaTrack {
  return { ...track, direction: coerceDirection(dir) };
}
export function setMuted(track: KriaTrack, muted: boolean): KriaTrack {
  return { ...track, muted: !!muted };
}

// ---------------------------------------------------------------------------
// THE STEP-EDITOR GRID MODEL (PURE) — the ONE place row↔value lives
// ---------------------------------------------------------------------------
//
// Every editor of this sequencer reads this model: the legacy card, the
// faceplate's step-grid panel, and — through the pure mutators above — the
// monome grid bridge. It exists because the row↔value mapping used to be
// written TWICE inside KriaCard.svelte, once in the click handler and once in
// the lit test, and the two disagreed.
//
// ⚠ THE BUG THAT PUT THIS HERE. The OCTAVE page computed a clicked value as
// `Math.min(5, 6 - row)` while lighting `6 - row <= oct`. Rows 0 AND 1 both
// wrote octave 5, and `oct = 5` lit rows 1..6 — so **row 0 responded to every
// click and could never display the state it had just written.** A click
// handler and a lit test that are two expressions of one mapping will drift;
// one function answering BOTH cannot.
//
// The rule this encodes: a lane's rows are in BIJECTION with its values. When a
// lane has fewer values than the grid has rows, the surplus rows are INERT —
// refused by `laneRowActive` and painted dead — never
// click-responsive-but-unlightable, and never silently aliased onto a
// neighbouring value.

/** Rows in the step editor. Kria's grid is 16 wide; the editor is 7 tall. */
export const KRIA_EDIT_ROWS = 7;
/** Ratchet ceiling (1 = a single hit, up to 4 sub-hits inside one step). */
export const KRIA_RATCHET_MAX = 4;
/** Glide ceiling in SECONDS — the same bound `coerceTrack` clamps to. */
export const KRIA_GLIDE_MAX = 0.5;
/**
 * Kria's PROBABILITY fader, bottom row first. Four levels, not a continuous
 * scale: index 0 (the bottom row) never fires, index 3 always does.
 */
export const KRIA_PROBABILITY_LEVELS: readonly number[] = [0, 0.25, 0.5, 1] as const;

/** A per-step lane the 7×16 editor can edit. */
export type KriaLane = 'trig' | 'note' | 'octave' | 'duration' | 'probability' | 'glide' | 'ratchet';

/** The lanes, with the short tags the page selector prints. */
export const KRIA_LANES: readonly { id: KriaLane; label: string }[] = [
  { id: 'trig', label: 'TRG' },
  { id: 'note', label: 'NTE' },
  { id: 'octave', label: 'OCT' },
  { id: 'duration', label: 'DUR' },
  { id: 'probability', label: 'PRB' },
  { id: 'glide', label: 'GLD' },
  { id: 'ratchet', label: 'RAT' },
] as const;

/** Is `lane` one of the declared lanes? (A persisted/selector value is data.) */
export function coerceLane(raw: unknown): KriaLane {
  return KRIA_LANES.some((l) => l.id === raw) ? (raw as KriaLane) : 'trig';
}

/**
 * How many rows, counted from the BOTTOM, this lane actually uses. Rows above
 * are inert. `trig` reads 1 because only the bottom row LIGHTS — but see
 * `laneRowActive`: a trig column is clickable anywhere, a different question
 * and the reason these are two functions rather than one.
 */
export function laneRowsUsed(lane: KriaLane): number {
  switch (lane) {
    case 'trig':
      return 1;
    case 'octave':
      return 6; // values 0..5
    case 'probability':
      return KRIA_PROBABILITY_LEVELS.length; // 4
    case 'ratchet':
      return KRIA_RATCHET_MAX; // 4
    case 'note':
    case 'duration':
    case 'glide':
      return KRIA_EDIT_ROWS; // 7
  }
}

/**
 * Is this (lane, row) a live target for a click?
 *
 * ⚠ `trig` is the ONE lane where every row is active while only one row lights,
 * and that is deliberate rather than the octave bug wearing a different hat: a
 * trig column is a single boolean, so clicking anywhere in the column toggles
 * it and the bottom row reports the result. The click has a visible
 * consequence — exactly what row 0 of the octave page did not.
 */
export function laneRowActive(lane: KriaLane, row: number): boolean {
  if (!Number.isInteger(row) || row < 0 || row >= KRIA_EDIT_ROWS) return false;
  if (lane === 'trig') return true;
  // Every other lane fills from the bottom: the used rows are the LAST N.
  return row >= KRIA_EDIT_ROWS - laneRowsUsed(lane);
}

/** The 0-based level a row denotes, counting UP from the bottom row. */
function levelForRow(row: number): number {
  return KRIA_EDIT_ROWS - 1 - row;
}

/**
 * The value a click on (lane, row) writes. `null` for an inert row, so a caller
 * that forgets `laneRowActive` writes nothing rather than a clamped neighbour —
 * the octave failure mode, refused at the return type.
 */
export function laneValueForRow(lane: KriaLane, row: number): number | null {
  if (!laneRowActive(lane, row)) return null;
  const level = levelForRow(row);
  switch (lane) {
    case 'trig':
      return 1; // a toggle; the value is not read
    case 'note':
      return level; // bottom row = degree 0
    case 'octave':
      return level; // rows 1..6 → octaves 5..0
    // ⚠ A BAR FROM THE TOP, unlike every other level lane. Clicking row r fills
    // rows 0..r, so the value is (r+1)/7 and NOT the bottom-anchored `level`.
    // Deriving it from `level` like its neighbours inverts the bar: the click
    // lands on a row the lit test then leaves dark — the same shape as the
    // octave defect, which is how the round-trip property caught it.
    case 'duration':
      return (row + 1) / KRIA_EDIT_ROWS; // top row = shortest gate
    case 'probability':
      return KRIA_PROBABILITY_LEVELS[level] ?? 1;
    case 'ratchet':
      return level + 1; // bottom row = 1 hit
    case 'glide':
      return (level / (KRIA_EDIT_ROWS - 1)) * KRIA_GLIDE_MAX;
  }
}

/** Index of the roster entry nearest `v` (the probability fader's rounding). */
function nearestLevelIndex(levels: readonly number[], v: number): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < levels.length; i++) {
    const d = Math.abs(levels[i]! - v);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** Is (lane, step, row) lit for this track? */
export function laneRowLit(lane: KriaLane, track: KriaTrack, step: number, row: number): boolean {
  if (!laneRowActive(lane, row)) return false;
  const level = levelForRow(row);
  switch (lane) {
    case 'trig':
      return row === KRIA_EDIT_ROWS - 1 && !!track.trig[step];
    case 'note': {
      const deg = Math.max(0, Math.min(KRIA_EDIT_ROWS - 1, track.note[step] ?? 0));
      return level === deg;
    }
    case 'octave':
      return level <= Math.min(5, track.octave[step] ?? 0); // a bar from the bottom
    case 'duration': {
      const filled = Math.max(1, Math.round((track.duration[step] ?? 0.5) * KRIA_EDIT_ROWS));
      return row < filled; // a bar from the top
    }
    case 'probability':
      return level <= nearestLevelIndex(KRIA_PROBABILITY_LEVELS, track.probability[step] ?? 1);
    case 'ratchet':
      return level + 1 <= clampInt(track.ratchet[step], 1, KRIA_RATCHET_MAX, 1);
    case 'glide': {
      const g = clampNum(track.glide[step], 0, KRIA_GLIDE_MAX, 0);
      return level <= Math.round((g / KRIA_GLIDE_MAX) * (KRIA_EDIT_ROWS - 1));
    }
  }
}

/**
 * A step's value on a lane, spoken. This is the ONLY place the sequencer's
 * per-step state exists as readable text: the faceplate paints no resting
 * derived text, so this rides `aria-valuetext` (owner rulings 2026-08-17/19).
 */
export function laneStepText(lane: KriaLane, track: KriaTrack, step: number): string {
  switch (lane) {
    case 'trig':
      return track.trig[step] ? 'on' : 'off';
    case 'note':
      return `degree ${track.note[step] ?? 0}`;
    case 'octave':
      return `octave +${Math.min(5, track.octave[step] ?? 0)}`;
    case 'duration':
      return `gate ${Math.round(clampNum(track.duration[step], 0, 1, 0.5) * 100)}% of the step`;
    case 'probability': {
      const p = clampNum(track.probability[step], 0, 1, 1);
      return p >= 1 ? 'always' : p <= 0 ? 'never' : `${Math.round(p * 100)}% of the time`;
    }
    case 'ratchet': {
      const r = clampInt(track.ratchet[step], 1, KRIA_RATCHET_MAX, 1);
      return r === 1 ? 'single hit' : `${r} hits`;
    }
    case 'glide': {
      const g = clampNum(track.glide[step], 0, KRIA_GLIDE_MAX, 0);
      return g <= 0 ? 'no glide' : `${Math.round(g * 1000)} ms slew`;
    }
  }
}

/** What a cell IS on this lane — the accessible NAME half (the value half is
 *  `laneStepText`). Page-dependent, because a cell on NTE is a scale degree and
 *  the same cell on DUR is a gate width. */
export function laneCellName(lane: KriaLane, step: number, row: number): string {
  const human = KRIA_LANES.find((l) => l.id === lane)?.label ?? lane;
  if (!laneRowActive(lane, row)) return `step ${step + 1}, ${human} (unused row)`;
  switch (lane) {
    case 'trig':
      return `step ${step + 1}, trigger`;
    case 'note':
      return `step ${step + 1}, degree ${levelForRow(row)}`;
    case 'octave':
      return `step ${step + 1}, octave +${levelForRow(row)}`;
    case 'duration':
      return `step ${step + 1}, gate ${KRIA_EDIT_ROWS - row} of ${KRIA_EDIT_ROWS}`;
    case 'probability':
      return `step ${step + 1}, probability ${Math.round((KRIA_PROBABILITY_LEVELS[levelForRow(row)] ?? 1) * 100)}%`;
    case 'ratchet':
      return `step ${step + 1}, ${levelForRow(row) + 1} hits`;
    case 'glide':
      return `step ${step + 1}, glide ${Math.round((levelForRow(row) / (KRIA_EDIT_ROWS - 1)) * KRIA_GLIDE_MAX * 1000)} ms`;
  }
}

/**
 * The full accessible name of one grid cell: what it IS, then what the step
 * currently HOLDS.
 *
 * ⚠ IT ALL GOES IN `aria-label`, AND NOT IN `aria-valuetext`. `aria-valuetext`
 * is only meaningful on a RANGE role; these cells are `role="gridcell"` inside a
 * `role="grid"`, so a value parked there is dropped on the floor by assistive
 * tech and flagged by svelte-check. (Knobs, faders and selectors — real range
 * roles — keep `aria-valuetext` as before. The same correction was made for
 * `role="application"` XY pads in #2038.)
 *
 * This string carries real weight on this module: the faceplate paints NO
 * resting derived text, so the accessible name is the ONLY readable form the
 * sequencer's per-step state has, and it is what every spec proving the face
 * tracks the graph reads. The card it replaces said `step 5 row 2` on every
 * page — a bare grid coordinate, identical on TRIG, NOTE, OCTAVE and DURATION,
 * that never named the value or whether the cell was lit.
 */
export function laneCellAriaLabel(
  lane: KriaLane,
  track: KriaTrack,
  step: number,
  row: number,
): string {
  return `${laneCellName(lane, step, row)} — ${laneStepText(lane, track, step)}`;
}

/** Apply a lane edit to a track, returning a NEW track (or null for an inert
 *  row). The one switch every editor routes through, so a new lane cannot reach
 *  only half the surfaces. */
export function applyLaneEdit(
  lane: KriaLane,
  track: KriaTrack,
  step: number,
  row: number,
): KriaTrack | null {
  const v = laneValueForRow(lane, row);
  if (v === null) return null;
  switch (lane) {
    case 'trig':
      return toggleTrig(track, step);
    case 'note':
      return setNote(track, step, v);
    case 'octave':
      return setOctave(track, step, v);
    case 'duration':
      return setDuration(track, step, v);
    case 'probability':
      return setProbability(track, step, v);
    case 'ratchet':
      return setRatchet(track, step, v);
    case 'glide':
      return setGlide(track, step, v);
  }
}
