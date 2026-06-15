// packages/web/src/lib/audio/modules/clip-types.ts
//
// Data model + PURE helpers for the `clipplayer` module — the clip-launcher's
// "clip page". Kept separate from the def/factory (clipplayer.ts) so the model,
// the note→V/oct scheduling math, and the Deluge-style note-editor row math are
// all unit-testable with no engine. (This file exports no `*Def`, so the audio
// module glob ignores it.)
//
// A clip slot holds any `ClipRecord` kind; v1 ships the `'note'` arm (a small
// step/note pattern — tiny, no audio bytes). `'audio'` + `'snapshot'` kinds are
// forward-declared (later phases) so the union + launch machinery don't churn.

import { midiToVOct, C3_MIDI, MIN_MIDI, MAX_MIDI } from '$lib/audio/note-entry';
import {
  MAJOR_SCALE_STEPS,
  MINOR_SCALE_STEPS,
  PENTATONIC_SCALE_STEPS,
  type ScaleName,
} from '$lib/mike/music-theory';
import { POLY_CHANNEL_PAIRS } from '$lib/audio/poly';

// ---------------------------------------------------------------------------
// Dimensions (DECIDED 2026-06-15): rows = INSTRUMENTS, columns = clip SLOTS.
// 8 instrument lanes × 8 clip slots = 64 clips on the left 8×8 grid quadrant.
// Each lane drives its own pitch/gate/velocity output pair (the owner's
// "each row reflects a given instrument's materials" model). The flat index is
// row-major (index = lane*CLIP_SLOTS + slot), i.e. identical numerics to the
// grid's `y*8 + x` so the pad↔index mapping is unchanged.
// ---------------------------------------------------------------------------
export const CLIP_LANES = 8; // rows = instruments
export const CLIP_SLOTS = 8; // columns = clip alternatives per instrument
export const CLIP_COUNT = CLIP_LANES * CLIP_SLOTS; // 64
export const DEFAULT_CLIP_STEPS = 16;
export const MAX_CLIP_STEPS = 64;
export const DEFAULT_VELOCITY = 100; // MIDI 0..127

// Back-compat aliases (older call sites used track/scene naming).
export const CLIP_TRACKS = CLIP_SLOTS;
export const CLIP_SCENES = CLIP_LANES;

/** Flat clip-bank index for a (slot=col, lane=row) cell, row-major. */
export function clipIndex(slot: number, lane: number): number {
  return lane * CLIP_SLOTS + slot;
}
/** Which instrument lane (row) a flat clip index belongs to. */
export function laneOf(index: number): number {
  return Math.floor(index / CLIP_SLOTS);
}
/** Which clip slot (column) within its lane a flat clip index is. */
export function slotOf(index: number): number {
  return index % CLIP_SLOTS;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type ClipKind = 'note' | 'audio' | 'snapshot';

/** One note in a note clip. Multiple events may share a `step` (a chord). */
export interface NoteEvent {
  step: number; // 0..lengthSteps-1 — the step the note starts on
  midi: number; // MIDI note int (c4 = 60), same convention as note-entry.ts
  velocity?: number; // 0..127 (default DEFAULT_VELOCITY)
  lengthSteps?: number; // gate width in steps (default 1)
  prob?: number; // 0..1 per-step probability (default 1)
}

export interface ClipBase {
  kind: ClipKind;
  name?: string;
  color?: number; // 0..15 grid varibright tint / hue bucket
  loop: boolean;
  gain?: number;
}

/** v1 — note/pattern clip. Tiny: a sparse NoteEvent[] + a few ints. */
export interface NoteClipRecord extends ClipBase {
  kind: 'note';
  steps: NoteEvent[];
  lengthSteps: number;
  root: number; // MIDI root for the in-key editor (e.g. C3 = 48)
  scale?: ScaleName; // absent = chromatic editor rows
}

/** LATER — audio-loop clip (reuses SAMSLOOP's bytes discipline). */
export interface AudioClipRecord extends ClipBase {
  kind: 'audio';
  fileBytesB64: string;
  fileSize: number;
  fileMime?: string;
  fileName?: string;
  sampleRate?: number;
  sampleLength?: number;
}

/** LATER — node-state snapshot clip (param/graph scene). */
export interface SnapshotClipRecord extends ClipBase {
  kind: 'snapshot';
  snapshot: Record<string, unknown>;
}

export type ClipRecord = NoteClipRecord | AudioClipRecord | SnapshotClipRecord;

/** Persisted on node.data. Note clips are tiny so no caps in v1. */
export interface ClipPlayerData {
  clips?: Record<string, ClipRecord | null>; // sparse; null/absent = empty
  /** Per-lane active clip SLOT (0..CLIP_SLOTS-1) or null = stopped. Length
   *  CLIP_LANES. SYNCED — the playing-set all peers + grids see (§5.2). Up to
   *  8 clips (one per instrument lane) play simultaneously. */
  playing?: (number | null)[];
  /** Per-lane queued action applied on that lane's loop boundary: a slot index
   *  to launch, 'stop' to stop the lane, or null/absent = nothing queued. */
  queued?: (number | 'stop' | null)[];
  creatorId?: string;
}

/** Normalize a per-lane state array to exactly CLIP_LANES entries. */
function coerceLaneArray<T>(raw: unknown, fallback: T): T[] {
  const out: T[] = new Array(CLIP_LANES).fill(fallback);
  if (Array.isArray(raw)) {
    for (let i = 0; i < CLIP_LANES; i++) if (i < raw.length) out[i] = raw[i] as T;
  }
  return out;
}
/** The active clip slot for a lane (or null = stopped). */
export function lanePlaying(data: ClipPlayerData | undefined, lane: number): number | null {
  const v = data?.playing?.[lane];
  return typeof v === 'number' ? v : null;
}
/** The queued action for a lane: a slot index, 'stop', or null. */
export function laneQueued(
  data: ClipPlayerData | undefined,
  lane: number,
): number | 'stop' | null {
  const v = data?.queued?.[lane];
  return v === 'stop' || typeof v === 'number' ? v : null;
}
/** Read the full per-lane playing-set, normalized to CLIP_LANES entries. */
export function playingSet(data: ClipPlayerData | undefined): (number | null)[] {
  return coerceLaneArray<number | null>(data?.playing, null);
}

// ---------------------------------------------------------------------------
// Defaults + coercion
// ---------------------------------------------------------------------------
export function defaultNoteClip(): NoteClipRecord {
  return {
    kind: 'note',
    steps: [],
    lengthSteps: DEFAULT_CLIP_STEPS,
    root: C3_MIDI,
    scale: 'major',
    loop: true,
  };
}

/** Validate/normalize a raw object to a NoteEvent, or null if unusable. */
export function coerceNoteEvent(raw: unknown): NoteEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const step = Math.trunc(Number(r.step));
  const midi = Math.round(Number(r.midi));
  if (!Number.isFinite(step) || step < 0) return null;
  if (!Number.isFinite(midi) || midi < MIN_MIDI || midi > MAX_MIDI) return null;
  const ev: NoteEvent = { step, midi };
  if (typeof r.velocity === 'number' && Number.isFinite(r.velocity)) {
    ev.velocity = Math.max(0, Math.min(127, Math.round(r.velocity)));
  }
  if (typeof r.lengthSteps === 'number' && Number.isFinite(r.lengthSteps)) {
    ev.lengthSteps = Math.max(1, Math.round(r.lengthSteps));
  }
  if (typeof r.prob === 'number' && Number.isFinite(r.prob)) {
    ev.prob = Math.max(0, Math.min(1, r.prob));
  }
  return ev;
}

/** Validate/normalize a raw object to a ClipRecord, or null. v1 fully handles
 *  the 'note' kind; 'audio'/'snapshot' pass through shape-checked for forward
 *  compat (the runtime ignores them until those phases land). */
export function coerceClipRecord(raw: unknown): ClipRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const loop = r.loop !== false;
  if (r.kind === 'note') {
    const steps = Array.isArray(r.steps)
      ? (r.steps.map(coerceNoteEvent).filter((e): e is NoteEvent => e !== null))
      : [];
    const lengthSteps = clampStepCount(Number(r.lengthSteps));
    const root =
      typeof r.root === 'number' && Number.isFinite(r.root)
        ? Math.round(r.root)
        : C3_MIDI;
    const out: NoteClipRecord = { kind: 'note', steps, lengthSteps, root, loop };
    if (r.scale === 'major' || r.scale === 'minor' || r.scale === 'pentatonic') {
      out.scale = r.scale;
    }
    if (typeof r.color === 'number') out.color = r.color;
    if (typeof r.name === 'string') out.name = r.name;
    if (typeof r.gain === 'number') out.gain = r.gain;
    return out;
  }
  if (r.kind === 'audio' || r.kind === 'snapshot') return r as unknown as ClipRecord;
  return null;
}

export function clampStepCount(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_CLIP_STEPS;
  return Math.max(1, Math.min(MAX_CLIP_STEPS, Math.round(n)));
}

/** Read clip at a flat index from node.data (coerced), or null. Accepts any
 *  clip-bearing shape (the value is coerced/validated), so callers can pass a
 *  raw node.data without first asserting it's a strict ClipPlayerData. */
export function readClip(
  data: { clips?: Record<string, unknown> } | undefined,
  index: string | number,
): ClipRecord | null {
  const clips = data?.clips;
  if (!clips) return null;
  return coerceClipRecord(clips[String(index)]);
}

// ---------------------------------------------------------------------------
// Scheduling math (note clip → poly lanes) — PURE
// ---------------------------------------------------------------------------

/** NoteEvents that START on `step` (their gate opens here). */
export function notesStartingAt(clip: NoteClipRecord, step: number): NoteEvent[] {
  return clip.steps.filter((e) => e.step === step);
}

export interface StepLanes {
  /** Up to POLY_CHANNEL_PAIRS lanes of {pitch V/oct, gate}. */
  lanes: { pitch: number; gate: 0 | 1 }[];
  /** 0..1 velocity for the velocity CV out (max of the starting notes). */
  velocity: number;
  /** Gate width in steps (the longest starting note; ≥1). */
  gateSteps: number;
  /** True if any note starts on this step. */
  any: boolean;
}

/**
 * Resolve the poly output lanes + velocity + gate width for a note clip at a
 * given step. The clip-player schedules its pitch/gate/velocity outs from this.
 * Pitch uses the codebase V/oct convention (midiToVOct). Chords (multiple notes
 * on the same step) fill consecutive lanes, capped at POLY_CHANNEL_PAIRS.
 */
export function lanesForStep(clip: NoteClipRecord, step: number): StepLanes {
  const starting = notesStartingAt(clip, step).slice(0, POLY_CHANNEL_PAIRS);
  const lanes: { pitch: number; gate: 0 | 1 }[] = [];
  let velocity = 0;
  let gateSteps = 1;
  for (const ev of starting) {
    lanes.push({ pitch: midiToVOct(ev.midi), gate: 1 });
    const v = (ev.velocity ?? DEFAULT_VELOCITY) / 127;
    if (v > velocity) velocity = v;
    const len = ev.lengthSteps ?? 1;
    if (len > gateSteps) gateSteps = len;
  }
  return { lanes, velocity, gateSteps, any: starting.length > 0 };
}

// ---------------------------------------------------------------------------
// Deluge note-editor row math (X = step, Y = pitch) — PURE
// ---------------------------------------------------------------------------

/** The semitone offsets for a scale, or the 12-tone chromatic set when no
 *  scale is set (the editor's chromatic rows). */
export function scaleSteps(scale?: ScaleName): readonly number[] {
  switch (scale) {
    case 'major':
      return MAJOR_SCALE_STEPS;
    case 'minor':
      return MINOR_SCALE_STEPS;
    case 'pentatonic':
      return PENTATONIC_SCALE_STEPS;
    default:
      return [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  }
}

/**
 * Map a grid editor ROW to a MIDI note. Row 0 = the clip root; higher rows go
 * up. In-key (scale set): each row is the next scale DEGREE, so a row octave is
 * the scale length (Deluge INKY). Chromatic (no scale): each row is +1 semitone
 * (Deluge ISO). Handles negative rows (scrolling below the root).
 */
export function rowToMidi(row: number, root: number, scale?: ScaleName): number {
  const steps = scaleSteps(scale);
  const n = steps.length;
  const octave = Math.floor(row / n);
  const deg = ((row % n) + n) % n;
  return root + octave * 12 + steps[deg];
}

/**
 * Inverse of rowToMidi — the editor row for a MIDI note, or null if the note is
 * out-of-scale (so an in-key editor knows not to light a chromatic note's cell).
 */
export function midiToRow(midi: number, root: number, scale?: ScaleName): number | null {
  const steps = scaleSteps(scale);
  const n = steps.length;
  const rel = midi - root;
  const octave = Math.floor(rel / 12);
  const within = ((rel % 12) + 12) % 12;
  const deg = steps.indexOf(within);
  if (deg === -1) return null;
  return octave * n + deg;
}

/**
 * Toggle a note at (step, midi) in a note clip — add it (default length 1,
 * default velocity) if absent, remove it if present. Returns a NEW clip
 * (callers mutate node.data via the in-place Y discipline at the call site).
 */
export function toggleNoteAt(clip: NoteClipRecord, step: number, midi: number): NoteClipRecord {
  const existing = clip.steps.findIndex((e) => e.step === step && e.midi === midi);
  const steps =
    existing >= 0
      ? clip.steps.filter((_, i) => i !== existing)
      : [...clip.steps, { step, midi, velocity: DEFAULT_VELOCITY, lengthSteps: 1 }];
  return { ...clip, steps };
}
