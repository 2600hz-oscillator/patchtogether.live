// packages/web/src/lib/audio/modules/clip-types.ts
//
// Data model + PURE helpers for the `clipplayer` module — the clip-launcher's
// "clip page". Kept separate from the def/factory (clipplayer.ts) so the model,
// the note→V/oct scheduling math, and the piano-roll note-editor row math are
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
  DORIAN_SCALE_STEPS,
  PHRYGIAN_SCALE_STEPS,
  MIXOLYDIAN_SCALE_STEPS,
  type ScaleName,
} from '$lib/mike/music-theory';
import { coerceRateIndex } from './clip-clock';
import { POLY_CHANNEL_PAIRS } from '$lib/audio/poly';
// Type-only import (erased at runtime → no cycle with clip-arrange.ts, which
// imports VALUES from this file). The arranger model lives in clip-arrange.ts.
import type { ArrangeData, ClipPlayMode } from './clip-arrange';

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
// Max steps in a clip. Bumped 64→128 (DECIDED 2026-06-16): the grid edits up to
// 128 steps via 8 pages of 16. Sparse NoteEvent[] storage doesn't grow with this
// cap — only the clamp + the editor's max page count.
export const MAX_CLIP_STEPS = 128;
// One editor PAGE = 16 steps; up to 8 pages cover the 128-step max.
export const STEPS_PER_PAGE = 16;
export const MAX_EDIT_PAGES = MAX_CLIP_STEPS / STEPS_PER_PAGE; // 8
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
export type ClipKind = 'note' | 'audio' | 'snapshot' | 'automation';

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
  /** Optional PER-CLIP clock DIVIDER — an index into clip-clock.ts RATE_MULTS
   *  ([1/8,1/4,1/2,1,2x,4x]; default 3 = '1'). When set it OVERRIDES the lane's
   *  `rate[]` for this clip's step duration; the engine LATCHES it at the clip's
   *  loop boundary so a live edit only takes effect at the next clip start (see
   *  clipDivIndex in clip-clock.ts). Absent = follow the per-lane rate. Set by
   *  the Launchpad Grid-shift "Clip Div". */
  div?: number;
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

// ---------------------------------------------------------------------------
// AUTOMATION clip — the "automation lane" (task #183)
// ---------------------------------------------------------------------------
//
// An automation clip is a CLIP (kind:'automation') occupying a grid (lane, slot)
// cell like a note clip — it LAUNCHES, LOOPS, and STOPS on its lane's playhead,
// with its own `lengthSteps` + `div` (so it can be long + slow to maximize
// record time). It carries MULTIPLE param tracks (each an AutomationTrack). When
// launched it drives its params; when armed + playing it records live param moves
// for one loop pass (quantized punch-in at the loop start, auto punch-out at the
// loop end). Playback drives the mapped param TRANSIENTLY via engine.setParam —
// it NEVER writes the live Y.Doc (`cv-modulation-live-store-write-storm`);
// recording is the only writer and commits ONCE per pass. Automation data is
// CUSTOM parameter-envelope data (0..1 in the param's own domain), NOT MIDI.

/** Max automated params (tracks) in one automation clip — a UI-sanity cap,
 *  enforced at the coerce boundary. (NOT a MIDI-channel limit: automation is
 *  CUSTOM parameter-envelope data, not MIDI CC — owner: "automation data does
 *  not need to be midi data".) */
export const MAX_AUTOMATION_TRACKS = 16;

/** Max breakpoints PER track — the durable-size guard for a long/slow automation
 *  clip (low clock division + long beat length = a multi-minute pass). The
 *  recorder's real-time decimation gate keeps density ~30 pts/s, so this bounds
 *  a single track's committed array (and thus the ydoc/sync payload). Enforced
 *  at the coerce boundary; the recorder also caps before commit. */
export const MAX_AUTOMATION_EVENTS = 4000;

/** A single automation breakpoint: a normalized param value at a step position.
 *  `step` may be fractional for sub-step resolution; `value` is 0..1 in the
 *  param's normalized space (the same 0..1 a Fader/knob reports), so the track
 *  is independent of the param's real min/max. */
export interface AutomationEvent {
  step: number; // 0..lengthSteps (fractional allowed)
  value: number; // normalized 0..1 in param space
}

/** Stable reference to the automated control — a (nodeId, paramId) pair. */
export interface AutomationTarget {
  nodeId: string;
  paramId: string;
}

/** One automated parameter's breakpoint track. Just a target + its step-ordered
 *  breakpoints (custom envelope data — no MIDI identity). `interp` overrides the
 *  playback interpolation for this track: 'linear' (smooth ramp between points)
 *  or 'hold' (stepped). Absent ⇒ auto: linear for continuous params, hold for
 *  `curve:'discrete'` params (decided at playback from the ParamDef). */
export interface AutomationTrack {
  target: AutomationTarget;
  events: AutomationEvent[]; // step-ordered
  interp?: 'linear' | 'hold';
}

/** The automation clip: many param tracks, looping with the clip length. */
export interface AutomationClipRecord extends ClipBase {
  kind: 'automation';
  lengthSteps: number;
  tracks: AutomationTrack[];
}

export type ClipRecord =
  | NoteClipRecord
  | AudioClipRecord
  | SnapshotClipRecord
  | AutomationClipRecord;

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
  /** Per-lane "launch NOW" override, paired with `queued`: when true the queued
   *  action fires on the next tick regardless of QNT (a mid-clip immediate
   *  switch). Cleared when the launch applies. */
  queuedImmediate?: boolean[];
  /** Per-lane MONO flag (length CLIP_LANES). When a lane is mono, placing a note
   *  in a column that already holds one REPLACES it — a monophonic melody lane.
   *  An EDIT-time constraint (the card's per-lane toggle); absent/false = poly
   *  (up to POLY_CHANNEL_PAIRS notes per column). */
  mono?: boolean[];
  /** Per-lane MUTE flag (length CLIP_LANES). A muted lane KEEPS advancing its
   *  playhead (stays locked to the transport + the other lanes) but emits NO
   *  audio — distinct from a per-lane STOP, which halts the lane entirely.
   *  SYNCED (a performance control the Launchpad surfaces; the card may add a UI
   *  later). Absent/false = live (the default). Back-compat on load like
   *  `mono`/`rate`: a missing array reads as all-live. */
  muted?: boolean[];
  /** Per-lane clock RATE index (length CLIP_LANES) into clip-clock.ts's
   *  RATE_MULTS (1/8 · 1/4 · 1/2 · 1 · 2x · 4x). Absent/invalid ⇒ '1' (the
   *  global STEP grid). SYNCED — the card's per-lane dropdown writes it and
   *  every peer's engine scales that lane's step duration. Card-only control
   *  for now (no monome-grid / Launchpad surface). */
  rate?: number[];
  /** Per-LANE SWING amount (length CLIP_LANES), 0..MAX_SWING. Delays each lane's
   *  ODD steps by swing*laneDur (MPC/off-beat shuffle: even steps stay on the
   *  grid, odd steps push late). Absent/short array/entry ⇒ 0 (straight grid,
   *  byte-identical to the un-swung schedule). SYNCED — the Launchpad Grid-shift
   *  Swing± writes swing[selectedChannel]; every peer's engine offsets that
   *  lane's odd steps. Back-compat on load like `rate`/`mono`. */
  swing?: number[];
  /** Per-lane CLIP COLOR (length CLIP_LANES) — a user-PICKED `#rrggbb` hex for
   *  each instrument CHANNEL (a COLUMN of clips in the transposed grid). Every
   *  non-empty clip in that channel's column renders this color; null/absent =
   *  unpicked, so the card falls back to the lane's default hue. Card-only for
   *  now (the color-picker swatch in the grid header writes it — NOT the
   *  Launchpad LED path). Back-compat on load like `rate`/`mono`/`swing`: a
   *  missing/short array reads as all-unpicked. */
  laneColor?: (string | null)[];
  /** RESET intent nonce. The card's RST button (and its MIDI binding)
   *  INCREMENTS this; every peer's engine observes the change and snaps all
   *  ACTIVE lanes back to step 1 at a common re-anchor instant (queued
   *  launches are untouched). A synced counter — not a boolean — so repeated
   *  presses always re-fire. The `reset` gate INPUT is the CV equivalent
   *  (local rising edge per client). */
  resetNonce?: number;
  // ── SONG MODE (arranger) ──
  /** The recorded arrangement (an event log of clip launches over song time).
   *  Absent = none recorded. See clip-arrange.ts. */
  arrangement?: ArrangeData;
  /** Which transport drives playback: 'session' (launch clips live) or
   *  'arrangement' (replay the recorded log). Absent/falsey = session. */
  clipMode?: ClipPlayMode;
  /** Record-arm: while true AND session AND running, each applied launch is
   *  appended to `arrangement` at the current song-beat. Local-ish (synced so
   *  peers see the armed state); v1 is single-recorder. */
  recording?: boolean;
  /** Record mode: 'replace' (default — arming clears the log + restarts song
   *  time, v1 behaviour) or 'overdub' (arming KEEPS the existing log; new
   *  launches merge into it by song-beat). Absent/unknown ⇒ 'replace'. Synced
   *  so peers see the armed mode. */
  recordMode?: 'replace' | 'overdub';
  /** DUAL-LAUNCHPAD KEYS note-record state (design: clip-record-note-mode). A
   *  DISTINCT field from `recording` above (that is the ARRANGER launch-recorder
   *  in clip-arrange.ts — sharing it would break both). Set by the launchpad
   *  binding while the KEYS keyboard is armed/recording a clip; peers + the card
   *  see it. Absent/null = not note-recording. v1 single-recorder per clip. */
  noteRec?: NoteRecState | null;
  /** AUTOMATION record-arm state (task #183). `arm` = record-armed; while armed
   *  AND playing an automation clip, that clip's live param moves are captured
   *  for one quantized loop pass. `recorderId` = the arming client's
   *  `ydoc.clientID` — the SINGLE-WRITER: only that client's engine runs the
   *  recorder + commits the pass, so peers never double-record (see
   *  `isAutomationRecorder`). SYNCED so every peer sees the armed state (their
   *  engines still PLAY the automation; only the recorder records). Set by the
   *  card/launchpad; the engine only READS it. Playback needs no state here — it
   *  is transient, zero-Yjs. Absent = not armed.
   *
   *  `clip` designates THE automation clip for this player (MVP: exactly one) —
   *  a (lane, slot) pointer into `clips` at a `kind:'automation'` record. The
   *  card's "+AUTO" action stamps the clip into the first empty cell of the last
   *  lane and records the pointer here; the context-menu "Assign to automation
   *  lane" adds tracks to it; the ARM toggle records into it. Absent = the
   *  player has no automation clip yet. */
  automation?: { arm?: boolean; recorderId?: number; clip?: { lane: number; slot: number } };
  creatorId?: string;
}

/** SINGLE-WRITER automation record gate: true ONLY when automation record is
 *  ARMED and THIS client is the designated recorder
 *  (`data.automation.recorderId === clientId`). Every peer reads the same synced
 *  `arm`/`recorderId`, but only the recorder's engine runs `recordTick` +
 *  commits — so a record pass writes the durable store exactly once, never once
 *  per connected peer. The clipplayer tick and the integration test share this
 *  predicate so the gate is one source of truth. */
export function isAutomationRecorder(
  data: ClipPlayerData | undefined,
  clientId: number,
): boolean {
  const a = data?.automation;
  return !!a && a.arm === true && a.recorderId === clientId;
}

/** DUAL-LAUNCHPAD KEYS note-record state (see ClipPlayerData.noteRec). */
export interface NoteRecState {
  /** Instrument lane being recorded (0..CLIP_LANES-1). */
  lane: number;
  /** Clip slot within the lane being recorded (0..CLIP_SLOTS-1). */
  slot: number;
  /** Queue-armed (flashing yellow) — recording begins on the next loop wrap. */
  armed: boolean;
  /** Actively recording (red). */
  recording: boolean;
  /** OVERDUB (additive, endless) vs OFF (TRUE REPLACE — clear each step as the
   *  playhead crosses it, then fill from what's played). */
  overdub: boolean;
}

/** Read + normalize the KEYS note-record state, or null if not note-recording. */
export function readNoteRec(data: ClipPlayerData | undefined): NoteRecState | null {
  const r = data?.noteRec;
  if (!r || typeof r !== 'object') return null;
  const raw = r as unknown as Record<string, unknown>;
  const lane = Number(raw.lane);
  const slot = Number(raw.slot);
  if (!Number.isFinite(lane) || !Number.isFinite(slot)) return null;
  return {
    lane: Math.max(0, Math.min(CLIP_LANES - 1, Math.trunc(lane))),
    slot: Math.max(0, Math.min(CLIP_SLOTS - 1, Math.trunc(slot))),
    armed: raw.armed === true,
    recording: raw.recording === true,
    overdub: raw.overdub === true,
  };
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
/** Whether a lane is MONO (one note per column on note entry). Default poly. */
export function laneMono(data: ClipPlayerData | undefined, lane: number): boolean {
  return data?.mono?.[lane] === true;
}
/** Whether a lane is MUTED (advances its playhead but emits no audio). Default
 *  live — a missing/short array reads as not-muted (back-compat on load). */
export function laneMuted(data: ClipPlayerData | undefined, lane: number): boolean {
  return data?.muted?.[lane] === true;
}
/** Record mode, defaulting to legacy 'replace'. */
export function clipRecordMode(data: ClipPlayerData | undefined): 'replace' | 'overdub' {
  return data?.recordMode === 'overdub' ? 'overdub' : 'replace';
}

// ---------------------------------------------------------------------------
// Per-lane CLIP COLOR (card color-picker) — PURE. Each instrument channel (a
// COLUMN of clips in the transposed grid) carries a user-PICKED hex color; the
// card tints every non-empty clip in that column with it. Stored as a per-lane
// hex array on node.data, same forgiving discipline as `rate`/`mono`/`swing`: a
// missing / short / corrupt entry reads as null (unpicked → the default hue).
// This is node.data only — NO PortDef/ParamDef change, so no contract-lock churn.
// ---------------------------------------------------------------------------
/** Coerce a raw value to a normalized lowercase `#rrggbb` hex, or null. Accepts
 *  a `#rgb` shorthand (expanded to `#rrggbb`) and a full `#rrggbb`; anything
 *  else (null, number, named color, wrong length, non-hex digits) ⇒ null =
 *  unpicked. */
export function coerceLaneColor(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  const m3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(s);
  if (m3) return `#${m3[1]}${m3[1]}${m3[2]}${m3[2]}${m3[3]}${m3[3]}`;
  return /^#[0-9a-f]{6}$/.test(s) ? s : null;
}
/** Normalize the per-lane color array to exactly CLIP_LANES entries, each a
 *  coerced hex or null. Missing / short / non-array ⇒ nulls (back-compat on
 *  load, same shape discipline as `playing`/`mono`/`swing`). */
export function coerceLaneColors(raw: unknown): (string | null)[] {
  const out: (string | null)[] = new Array(CLIP_LANES).fill(null);
  if (Array.isArray(raw)) {
    for (let i = 0; i < CLIP_LANES; i++) if (i < raw.length) out[i] = coerceLaneColor(raw[i]);
  }
  return out;
}
/** Lane L's picked clip color (lowercase `#rrggbb`) or null = unpicked (the card
 *  falls back to the lane's default hue). Absent / short / corrupt ⇒ null —
 *  mirrors `laneMono`/`laneSwing`. */
export function laneColor(data: ClipPlayerData | undefined, lane: number): string | null {
  return coerceLaneColor(data?.laneColor?.[lane]);
}
/** The DEFAULT colour for a channel that has no picked colour: an evenly-spaced
 *  hue around the wheel at hsl(h, 70%, 50%) → #rrggbb. Single source of truth so
 *  the card swatch AND the Launchpad LED pads show the SAME default (hue 0 →
 *  #d92626, hue 90 → #80d926). */
export function defaultLaneColorHex(lane: number): string {
  const h = Math.round((lane * 360) / CLIP_LANES);
  const s = 0.7;
  const l = 0.5;
  const c = (1 - Math.abs(2 * l - 1)) * s; // chroma
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) { r = c; g = x; }
  else if (hp < 2) { r = x; g = c; }
  else if (hp < 3) { g = c; b = x; }
  else if (hp < 4) { g = x; b = c; }
  else if (hp < 5) { r = x; b = c; }
  else { r = c; b = x; }
  const m = l - c / 2;
  const hx = (n: number) => Math.round((n + m) * 255).toString(16).padStart(2, '0');
  return `#${hx(r)}${hx(g)}${hx(b)}`;
}
/** The EFFECTIVE channel colour: the user-picked colour if set, else the default
 *  hue. Both the card and the LED grid use this so a channel with no picked
 *  colour still shows its default hue (not a fixed fallback). */
export function laneColorEff(data: ClipPlayerData | undefined, lane: number): string {
  return laneColor(data, lane) ?? defaultLaneColorHex(lane);
}

// ---------------------------------------------------------------------------
// SWING (per-lane off-beat shuffle) — PURE. Same 0..0.75 range as DRUMSEQZ's
// swing param. The engine delays a lane's ODD steps by swing*laneDur so even
// steps stay locked to the grid (swing 0 ⇒ no offset ⇒ the un-swung schedule).
// ---------------------------------------------------------------------------
/** Max swing amount (fraction of a step the odd steps are pushed late). */
export const MAX_SWING = 0.75;
/** Clamp a raw swing value into [0, MAX_SWING]; non-finite ⇒ 0 (straight). */
export function clampSwing(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(MAX_SWING, n));
}
/** Lane L's swing amount from node.data (0 when absent/short/corrupt — the
 *  straight grid, same back-compat discipline as `rate`/`mono`). */
export function laneSwing(data: { swing?: unknown } | undefined, lane: number): number {
  const arr = data?.swing;
  if (!Array.isArray(arr)) return 0;
  return clampSwing(arr[lane]);
}
/** The time OFFSET (s) to add to a step's on-grid time: ODD steps push late by
 *  swing*stepDur, EVEN steps sit on the grid (offset 0). Single source of the
 *  swing math the scheduler applies. */
export function swingStepOffset(stepIndex: number, swing: number, stepDur: number): number {
  return stepIndex % 2 === 1 ? clampSwing(swing) * stepDur : 0;
}
/** Return-to-center detector — true when swing is 0 within epsilon. The
 *  Launchpad flashes green on the Swing± press that lands back on dead-center. */
export function isSwingCentered(v: number, eps = 1e-9): boolean {
  return Math.abs(v) <= eps;
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
    // Unknown / legacy / absent scale ⇒ undefined (chromatic editor rows).
    const scale = coerceScaleName(r.scale);
    if (scale) out.scale = scale;
    // Per-clip divider: clamp a finite value to a valid RATE index; missing /
    // non-numeric ⇒ undefined (the clip follows its lane's rate).
    if (typeof r.div === 'number' && Number.isFinite(r.div)) out.div = coerceRateIndex(r.div);
    if (typeof r.color === 'number') out.color = r.color;
    if (typeof r.name === 'string') out.name = r.name;
    if (typeof r.gain === 'number') out.gain = r.gain;
    return out;
  }
  if (r.kind === 'automation') {
    const lengthSteps = clampStepCount(Number(r.lengthSteps));
    const rawTracks = Array.isArray(r.tracks) ? r.tracks : [];
    const tracks = rawTracks
      .map(coerceAutomationTrack)
      .filter((t): t is AutomationTrack => t !== null)
      // Enforce the DOCUMENTED cap at the data boundary (MAX_AUTOMATION_TRACKS).
      .slice(0, MAX_AUTOMATION_TRACKS);
    const out: AutomationClipRecord = { kind: 'automation', lengthSteps, tracks, loop };
    if (typeof r.color === 'number') out.color = r.color;
    if (typeof r.name === 'string') out.name = r.name;
    if (typeof r.gain === 'number') out.gain = r.gain;
    return out;
  }
  if (r.kind === 'audio' || r.kind === 'snapshot') return r as unknown as ClipRecord;
  return null;
}

// ---------------------------------------------------------------------------
// AUTOMATION helpers — PURE (record-layer building blocks; the Y.Doc callers
// mutate in place per `yjs-save-load-real-ydoc`, these just compute values)
// ---------------------------------------------------------------------------

/** Clamp a raw value into a valid AutomationEvent, or null. */
export function coerceAutomationEvent(raw: unknown): AutomationEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Record<string, unknown>;
  const step = Number(e.step);
  const value = Number(e.value);
  if (!Number.isFinite(step) || step < 0) return null;
  if (!Number.isFinite(value)) return null;
  return { step, value: Math.max(0, Math.min(1, value)) };
}

/** Clamp a raw object into a valid AutomationTrack, or null (a track with an
 *  unusable target is dropped). Events are coerced, filtered, step-sorted, and
 *  capped at MAX_AUTOMATION_EVENTS (the durable-size guard for long clips). */
export function coerceAutomationTrack(raw: unknown): AutomationTrack | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Record<string, unknown>;
  const target = t.target as Record<string, unknown> | undefined;
  const nodeId = target?.nodeId;
  const paramId = target?.paramId;
  if (typeof nodeId !== 'string' || !nodeId) return null;
  if (typeof paramId !== 'string' || !paramId) return null;
  const events = (Array.isArray(t.events) ? t.events : [])
    .map(coerceAutomationEvent)
    .filter((e): e is AutomationEvent => e !== null)
    .sort((a, b) => a.step - b.step)
    .slice(0, MAX_AUTOMATION_EVENTS);
  const out: AutomationTrack = { target: { nodeId, paramId }, events };
  if (t.interp === 'linear' || t.interp === 'hold') out.interp = t.interp;
  return out;
}

/** True when two targets reference the same (nodeId, paramId) control. */
export function sameAutomationTarget(a: AutomationTarget, b: AutomationTarget): boolean {
  return a.nodeId === b.nodeId && a.paramId === b.paramId;
}

/** Empty automation clip of a given length (defaults to DEFAULT_CLIP_STEPS). */
export function defaultAutomationClip(lengthSteps = DEFAULT_CLIP_STEPS): AutomationClipRecord {
  return { kind: 'automation', lengthSteps: clampStepCount(lengthSteps), tracks: [], loop: true };
}

/**
 * OVERDUB merge (punch-in): replace a track's events inside the re-recorded
 * window with `incoming`, keeping every existing event OUTSIDE it. This is the
 * owner's "overdub must work" — a second pass punches over only the time it
 * covers, preserving the rest.
 *
 * The window is half-open and DIRECTIONAL to support a punch that wraps the loop
 * boundary:
 *   - `windowStart <= windowEnd`  → the window is `[start, end)` (drop events in it).
 *   - `windowStart >  windowEnd`  → the punch WRAPPED the loop: the window is
 *     `[start, ∞) ∪ [0, end)`, so KEEP the events in `[end, start)` (the middle).
 *     (The naive min/max normalization inverts this and deletes the middle —
 *     the exact loop-wrap bug the adversarial review caught.)
 *
 * Callers MUST pass a PLAIN snapshot of `existing` (e.g. from `coerceClipRecord`),
 * NEVER the live Y.Array — `kept` retains references to `existing`'s elements, and
 * reassigning integrated Y children throws "Type already integrated"
 * ([[yjs-save-load-real-ydoc]]). The commit reassigns the whole clip plain.
 * Returns a NEW step-sorted, event-capped array.
 */
export function mergeAutomationOverdub(
  existing: readonly AutomationEvent[],
  incoming: readonly AutomationEvent[],
  windowStart: number,
  windowEnd: number,
): AutomationEvent[] {
  const inWindow = (step: number): boolean =>
    windowStart <= windowEnd
      ? step >= windowStart && step < windowEnd // normal [start, end)
      : step >= windowStart || step < windowEnd; // wrapped [start,∞) ∪ [0,end)
  const kept = existing.filter((e) => !inWindow(e.step));
  const merged = kept.concat(
    incoming.map((e) => ({ step: e.step, value: Math.max(0, Math.min(1, e.value)) })),
  );
  merged.sort((a, b) => a.step - b.step);
  return merged.slice(0, MAX_AUTOMATION_EVENTS);
}

/**
 * Remove ONE param's automation from a record (owner: right-click a mapped
 * thing → "Remove automation" deletes THAT param's data only). Returns a NEW
 * record with the matching track dropped; other tracks untouched. The Y.Doc
 * caller mirrors this by splicing the track out in place.
 */
export function removeAutomationTrack(
  rec: AutomationClipRecord,
  target: AutomationTarget,
): AutomationClipRecord {
  return { ...rec, tracks: rec.tracks.filter((t) => !sameAutomationTarget(t.target, target)) };
}

/** Find a track for a target (or undefined). Used by the recorder to reuse an
 *  existing track (overdub) vs. create a new one. */
export function findAutomationTrack(
  rec: AutomationClipRecord,
  target: AutomationTarget,
): AutomationTrack | undefined {
  return rec.tracks.find((t) => sameAutomationTarget(t.target, target));
}

/**
 * PLAYBACK read — the normalized value a track holds at `step` (hold-last:
 * the value of the most recent event with `event.step <= step`). Returns null
 * when no event precedes `step` (the param is left at its live value until the
 * first breakpoint). `events` must be step-sorted (coerce/merge guarantee it).
 */
export function automationValueAt(
  events: readonly AutomationEvent[],
  step: number,
): number | null {
  let val: number | null = null;
  for (const e of events) {
    if (e.step <= step) val = e.value;
    else break;
  }
  return val;
}

/**
 * PLAYBACK read — LINEAR interpolation of the value at `step` (the default for
 * continuous params; `automationValueAt` is the hold-last variant for discrete).
 * Returns null before the first breakpoint (param left at its live value); holds
 * the final value after the last. `events` must be step-sorted.
 */
export function automationLinearAt(
  events: readonly AutomationEvent[],
  step: number,
): number | null {
  if (events.length === 0) return null;
  if (step < events[0]!.step) return null; // before first bp — leave live value
  let prev = events[0]!;
  for (let i = 1; i < events.length; i++) {
    const cur = events[i]!;
    if (cur.step > step) {
      const span = cur.step - prev.step;
      if (span <= 0) return cur.value;
      const t = (step - prev.step) / span;
      return prev.value + (cur.value - prev.value) * t;
    }
    prev = cur;
  }
  return prev.value; // past the last bp — hold
}

/**
 * The first breakpoint strictly AFTER `step` (or null past the last). The
 * lookahead playback emitter ramps toward this breakpoint's value, scheduled at
 * its audio time, giving click-free, sample-accurate automation between the
 * 25 ms scheduler ticks.
 */
export function automationNextAfter(
  events: readonly AutomationEvent[],
  step: number,
): AutomationEvent | null {
  for (const e of events) if (e.step > step) return e;
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
// piano-roll note-editor row math (X = step, Y = pitch) — PURE
// ---------------------------------------------------------------------------

/** The named scales, in KEYS-view select order. Chromatic is the ABSENCE of a
 *  scale (undefined), so it is not in this list. */
export const SCALE_NAMES: readonly ScaleName[] = [
  'major',
  'minor',
  'pentatonic',
  'dorian',
  'phrygian',
  'mixolydian',
];

/** Coerce a persisted scale value to a known ScaleName, or undefined (chromatic)
 *  for anything unknown / legacy / absent (preserves the chromatic editor rows
 *  on load — same forgiving discipline as the rest of coerceClipRecord). */
export function coerceScaleName(raw: unknown): ScaleName | undefined {
  return (SCALE_NAMES as readonly string[]).includes(raw as string)
    ? (raw as ScaleName)
    : undefined;
}

/** The editor's scale cycle (a SCALE pad / the card tag steps through these).
 *  `undefined` = chromatic (12 semitone rows). Switching to chromatic spreads a
 *  clip's notes apart vertically (each row becomes a semitone, not a degree). */
export const SCALE_CYCLE: readonly (ScaleName | undefined)[] = [...SCALE_NAMES, undefined];
/** Next scale in the cycle (major → minor → pentatonic → chromatic → major). */
export function nextScale(scale: ScaleName | undefined): ScaleName | undefined {
  const i = SCALE_CYCLE.indexOf(scale);
  return SCALE_CYCLE[(i + 1) % SCALE_CYCLE.length];
}
/** Display name for a scale (chromatic when unset). */
export function scaleName(scale: ScaleName | undefined): string {
  return scale ?? 'chromatic';
}

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
    case 'dorian':
      return DORIAN_SCALE_STEPS;
    case 'phrygian':
      return PHRYGIAN_SCALE_STEPS;
    case 'mixolydian':
      return MIXOLYDIAN_SCALE_STEPS;
    default:
      return [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  }
}

/**
 * Map a grid editor ROW to a MIDI note. Row 0 = the clip root; higher rows go
 * up. In-key (scale set): each row is the next scale DEGREE, so a row octave is
 * the scale length (in-key mode). Chromatic (no scale): each row is +1 semitone
 * (chromatic mode). Handles negative rows (scrolling below the root).
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

/** Options for note entry. `mono` = one note per column (replace on add).
 *  `maxVoices` = poly cap per column (default POLY_CHANNEL_PAIRS = 5). */
export interface NoteEntryOpts {
  mono?: boolean;
  maxVoices?: number;
}

/**
 * Toggle a note at (step, midi) in a note clip — add it (default length 1,
 * default velocity) if absent, remove it if present. Returns a NEW clip
 * (callers mutate node.data via the in-place Y discipline at the call site).
 *
 * Voice management on ADD:
 *  - MONO lane: a column holds ONE note. Adding clears every note covering this
 *    column first, then places the new one (replace-on-add — the owner's mono
 *    melody behaviour).
 *  - POLY lane: a column holds at most `maxVoices` (5) notes. Adding a
 *    (maxVoices+1)th re-uses the OLDEST note in that column (first in array
 *    order) so the chord never exceeds the poly width the engine can sound.
 */
export function toggleNoteAt(
  clip: NoteClipRecord,
  step: number,
  midi: number,
  opts: NoteEntryOpts = {},
): NoteClipRecord {
  const existing = clip.steps.findIndex((e) => e.step === step && e.midi === midi);
  if (existing >= 0) {
    // Present → remove (a plain tap toggles off), regardless of mono/poly.
    return { ...clip, steps: clip.steps.filter((_, i) => i !== existing) };
  }
  let steps = clip.steps;
  if (opts.mono) {
    // Mono: clear the whole column, then place the single note.
    steps = steps.filter((e) => !(e.step <= step && step < e.step + (e.lengthSteps ?? 1)));
  } else {
    const max = opts.maxVoices ?? POLY_CHANNEL_PAIRS;
    const here = steps.filter((e) => e.step === step);
    if (here.length >= max) {
      // Re-use the oldest voice in this column (first occurrence in array order).
      const oldest = steps.find((e) => e.step === step);
      steps = steps.filter((e) => e !== oldest);
    }
  }
  return { ...clip, steps: [...steps, { step, midi, velocity: VEL_DEFAULT, lengthSteps: 1 }] };
}

// ---------------------------------------------------------------------------
// Velocity LEVELS (DECIDED 2026-06-15, revised). SIX evenly-spaced steps the
// VELOCITY-hold modifier cycles through, so the velocity CV out (velocity/127)
// spans the FULL 0..1 range. The old 3-tier set (40/80/120) bunched into
// 0.31/0.63/0.94 — too subtle into a sustain/accent VCA (MOOG 911 sus). These
// six give a true 0 floor (a ghost note: the gate/note still fire, vel CV = 0)
// and a true 1.0 ceiling, in 20% steps. Stored as MIDI 0..127 on the event; the
// grid + card render each level as a distinct brightness/shade.
//
// A plain note tap places VEL_DEFAULT (60%). On the grid you HOLD the VELOCITY
// pad + tap a note to cycle its level UP (wrapping, never removing — removal is
// a plain tap).
// ---------------------------------------------------------------------------
/** The six velocity levels (MIDI 0..127) ≈ 0 / 20 / 40 / 60 / 80 / 100%. */
export const VEL_LEVELS: readonly number[] = [0, 25, 51, 76, 102, 127];
/** Number of velocity levels (6) — grid LEDs + card cells render this many. */
export const VEL_LEVEL_COUNT = VEL_LEVELS.length;
/** A freshly-placed note's velocity (≈60% — clearly audible, room both ways). */
export const VEL_DEFAULT = 76;

/** Velocity DISPLAY buckets: the 6 levels collapse to 3 visible colours (TWO
 *  levels per colour). Matches the monome grid's distinguishable brightnesses —
 *  3 note colours + dark (= empty cell). The CV out keeps the full 6 levels;
 *  only the LED/cell colour buckets. */
export const VEL_BUCKET_COUNT = 3;
/** The display bucket (0=low,1=med,2=high) for a velocity — `level >> 1`, so
 *  levels {0,1}→0, {2,3}→1, {4,5}→2. */
export function velBucket(velocity: number | undefined): number {
  return Math.floor(velLevelIndex(velocity) / 2);
}

/** Snap a raw 0..127 velocity to the nearest level INDEX (0..VEL_LEVEL_COUNT-1). */
export function velLevelIndex(velocity: number | undefined): number {
  const v = velocity ?? VEL_DEFAULT;
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < VEL_LEVELS.length; i++) {
    const d = Math.abs(VEL_LEVELS[i] - v);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/**
 * The VELOCITY-hold gesture: cycle the velocity of the note COVERING (step,
 * midi) UP one level (wrapping 100% → 0%). If no note is there yet, place one at
 * VEL_DEFAULT. Never removes a note (a plain tap does that). Returns a NEW clip.
 */
export function cycleVelocity(clip: NoteClipRecord, step: number, midi: number): NoteClipRecord {
  const cov = noteCovering(clip, step, midi);
  if (!cov) {
    return { ...clip, steps: [...clip.steps, { step, midi, velocity: VEL_DEFAULT, lengthSteps: 1 }] };
  }
  const next = VEL_LEVELS[(velLevelIndex(cov.velocity) + 1) % VEL_LEVELS.length];
  const steps = clip.steps.map((e) =>
    e.step === cov.step && e.midi === cov.midi ? { ...e, velocity: next } : e,
  );
  return { ...clip, steps };
}

/** The note event STARTING at (step, midi), or undefined. */
export function noteAt(
  clip: NoteClipRecord,
  step: number,
  midi: number,
): NoteEvent | undefined {
  return clip.steps.find((e) => e.step === step && e.midi === midi);
}

/** The note COVERING (step, midi) — i.e. a note in that row whose held span
 *  [start, start+lengthSteps) includes `step`. Used to render a held note as a
 *  bar across the cells it sustains over (not just its start cell). */
export function noteCovering(
  clip: NoteClipRecord,
  step: number,
  midi: number,
): NoteEvent | undefined {
  return clip.steps.find(
    (e) => e.midi === midi && e.step <= step && step < e.step + (e.lengthSteps ?? 1),
  );
}

/**
 * Make a SINGLE held note spanning steps lo..hi (inclusive) at `midi`, with the
 * gate high the whole time (lengthSteps = hi-lo+1). Any other notes in that row
 * within the span are removed/merged. Returns a NEW clip. This is the
 * "hold a pad + tap another in the same row" tie gesture.
 *
 * In a MONO lane the span is monophonic: every note covering any column in
 * [a,b] (regardless of pitch) is cleared first, so the held note is the only
 * voice across its span.
 */
export function setNoteSpan(
  clip: NoteClipRecord,
  lo: number,
  hi: number,
  midi: number,
  opts: NoteEntryOpts = {},
): NoteClipRecord {
  const a = Math.min(lo, hi);
  const b = Math.max(lo, hi);
  const steps = opts.mono
    ? clip.steps.filter((e) => e.step + (e.lengthSteps ?? 1) - 1 < a || e.step > b)
    : clip.steps.filter((e) => e.midi !== midi || e.step < a || e.step > b);
  steps.push({ step: a, midi, velocity: VEL_DEFAULT, lengthSteps: b - a + 1 });
  return { ...clip, steps };
}

// ---------------------------------------------------------------------------
// Clip transforms (DOUBLE / REVERSE / COPY) — PURE. All return a NEW clip
// (steps cloned), so the caller persists via the in-place Y discipline.
// ---------------------------------------------------------------------------

/**
 * DOUBLE a clip's length, duplicating the first half into the second half.
 * newLen = min(MAX_CLIP_STEPS, lengthSteps*2). For each existing event, a copy
 * is placed at step + lengthSteps; copies whose start lands ≥ newLen are DROPPED,
 * and a copied held note's span is clamped so start+len ≤ newLen (no bleed past
 * the cap). DOUBLE is intentionally destructive to any hidden notes living in the
 * (now-overwritten) second half. If the clip is already at MAX_CLIP_STEPS it is a
 * no-op: the SAME reference is returned so the caller can skip the write entirely.
 */
export function doubleNoteClip(clip: NoteClipRecord): NoteClipRecord {
  const len = clip.lengthSteps;
  if (len >= MAX_CLIP_STEPS) return clip; // === identity → caller skips the write
  const newLen = Math.min(MAX_CLIP_STEPS, len * 2);
  const steps: NoteEvent[] = [];
  for (const e of clip.steps) {
    // keep the original (clamp its span to the new length, defensively)
    steps.push(clampEventSpan({ ...e }, newLen));
    // its mirror in the second half
    const copyStart = e.step + len;
    if (copyStart >= newLen) continue; // dropped — past the new end
    steps.push(clampEventSpan({ ...e, step: copyStart }, newLen));
  }
  return { ...clip, lengthSteps: newLen, steps };
}

/** Clamp an event so step + lengthSteps ≤ maxLen (and lengthSteps ≥ 1). */
function clampEventSpan(e: NoteEvent, maxLen: number): NoteEvent {
  const len = e.lengthSteps ?? 1;
  const max = Math.max(1, maxLen - e.step);
  if (len > max) e.lengthSteps = max;
  return e;
}

/**
 * REVERSE a clip's steps in time. Each event spanning [start, start+len) is
 * re-anchored to the mirrored END of its span: mirroredStart = lengthSteps −
 * (start + len). This keeps held notes the same DURATION but flips their position
 * (it is NOT Array.reverse of the events, which would corrupt forward-held spans).
 * A note whose mirroredStart < 0 (it would start before step 0 — only possible if
 * a span exceeded lengthSteps) is clamped to step 0 with its length trimmed to fit.
 */
export function reverseClipSteps(clip: NoteClipRecord): NoteClipRecord {
  const len = clip.lengthSteps;
  const steps: NoteEvent[] = [];
  for (const e of clip.steps) {
    const span = e.lengthSteps ?? 1;
    let mirroredStart = len - (e.step + span);
    let mirroredLen = span;
    if (mirroredStart < 0) {
      // span ran past the clip end — clamp the start to 0 + trim the length.
      mirroredLen = span + mirroredStart; // = len - e.step
      mirroredStart = 0;
      if (mirroredLen < 1) continue; // nothing of the note remains inside the clip
    }
    steps.push({ ...e, step: mirroredStart, lengthSteps: mirroredLen });
  }
  return { ...clip, steps };
}

/** Structural clone of a note clip (steps[] + lengthSteps + root + scale + loop).
 *  Used by the session COPY/PASTE buffer so the buffer never shares event refs
 *  with the live clip (and a later paste rebuild can't alias a Y type). */
export function copyClip(clip: NoteClipRecord): NoteClipRecord {
  const out: NoteClipRecord = {
    kind: 'note',
    steps: clip.steps.map((s) => ({ ...s })),
    lengthSteps: clip.lengthSteps,
    root: clip.root,
    loop: clip.loop,
  };
  if (clip.scale) out.scale = clip.scale;
  if (typeof clip.div === 'number') out.div = clip.div;
  if (typeof clip.color === 'number') out.color = clip.color;
  if (typeof clip.name === 'string') out.name = clip.name;
  if (typeof clip.gain === 'number') out.gain = clip.gain;
  return out;
}

// ---------------------------------------------------------------------------
// LENGTH-EDIT page math (PURE) — the grid's 2-row length editor. Length L
// (1..MAX_CLIP_STEPS) is described as a 16-step BLOCK + a final STEP within it:
//   endBlock = ceil(L/16)  (1..MAX_EDIT_PAGES)
//   endStep  = L − (endBlock−1)*16  (1..16)
// ---------------------------------------------------------------------------

/** The 16-step block (1-based, 1..MAX_EDIT_PAGES) the clip's last step lives in. */
export function lengthEndBlock(lengthSteps: number): number {
  return Math.ceil(Math.max(1, lengthSteps) / STEPS_PER_PAGE);
}
/** The step within the end block (1-based, 1..16) that is the clip's last step. */
export function lengthEndStep(lengthSteps: number): number {
  const L = Math.max(1, lengthSteps);
  return L - (lengthEndBlock(L) - 1) * STEPS_PER_PAGE;
}
/** Length from a TAP of row-0 block C (1-based): the full C blocks = C*16,
 *  clamped to MAX_CLIP_STEPS. */
export function lengthFromBlockTap(block: number): number {
  const c = Math.max(1, Math.min(MAX_EDIT_PAGES, Math.round(block)));
  return Math.min(MAX_CLIP_STEPS, c * STEPS_PER_PAGE);
}
/** Length from a TAP of row-1 step N (1-based) within the CURRENT end block:
 *  (endBlock−1)*16 + N, clamped to MAX_CLIP_STEPS. */
export function lengthFromStepTap(lengthSteps: number, step: number): number {
  const n = Math.max(1, Math.min(STEPS_PER_PAGE, Math.round(step)));
  const block = lengthEndBlock(lengthSteps);
  return Math.min(MAX_CLIP_STEPS, (block - 1) * STEPS_PER_PAGE + n);
}
