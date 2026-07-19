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
// Type-only import (erased at runtime → no cycle with clip-song.ts, which
// imports VALUES from this file). The SONG model lives in clip-song.ts.
import type { SongData, SongRecState } from './clip-song';

// ---------------------------------------------------------------------------
// Dimensions (DECIDED 2026-06-15): rows = INSTRUMENTS, columns = clip SLOTS.
// 8 instrument lanes; the card shows 8 clip slots at a time (CLIP_SLOTS), but a
// lane can hold clips in up to MAX_SCENES (= SCENE_STRIDE) SLOTS — the launchpad
// Grid scene-scroll reaches slots ≥ 8. Each lane drives its own
// pitch/gate/velocity output pair (the owner's "each row reflects a given
// instrument's materials" model).
//
// FLAT KEY (schema v2, 2026-07-14): the sparse `clips` map is keyed by a flat
// index `lane*SCENE_STRIDE + slot` with a FIXED stride of SCENE_STRIDE (64),
// DECOUPLED from the card's visible column count. This lets the slot (=scene)
// axis grow to MAX_SCENES without renumbering stored clips. Schema v1 (pre-this-
// change) used a stride of 8 (== the old CLIP_SLOTS), so a v1 key `lane*8+slot`
// is re-keyed to `lane*64+slot` on load by `migrateClipPlayerData` (data.sv=2).
// ---------------------------------------------------------------------------
export const CLIP_LANES = 8; // rows = instruments
export const CLIP_SLOTS = 8; // VISIBLE clip columns per instrument (the card grid)
/** FIXED storage stride for the flat clip key (`lane*SCENE_STRIDE + slot`). The
 *  slot axis can grow up to this many scenes without renumbering stored clips —
 *  it is INDEPENDENT of the card's visible CLIP_SLOTS. Also the scene ceiling
 *  (MAX_SCENES in launchpad-map re-exports this value). */
export const SCENE_STRIDE = 64;
/** The pre-schema-v2 (v1) flat-key stride — the OLD `CLIP_SLOTS` value baked into
 *  legacy stored keys (`lane*8+slot`). Used only by the load migration. */
export const LEGACY_SCENE_STRIDE = 8;
/** node.data schema version marker (`ClipPlayerData.sv`). ABSENT/undefined = a
 *  legacy v1 patch (stride-8 clip keys) → `migrateClipPlayerData` re-keys it and
 *  stamps this value. Present = already stride-64 (no migration). */
export const CLIP_SCHEMA_VERSION = 2;
export const CLIP_COUNT = CLIP_LANES * CLIP_SLOTS; // 64 (the visible 8×8 card grid)
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

/** Flat clip-bank index (schema v2) for a (slot, lane) cell: `lane*SCENE_STRIDE +
 *  slot`. The stride is FIXED at SCENE_STRIDE (64), independent of the card's
 *  visible CLIP_SLOTS, so `slot` may range 0..SCENE_STRIDE-1. (Note: for lane 0
 *  the key equals the slot, so lane-0 keys are stride-invariant.) */
export function clipIndex(slot: number, lane: number): number {
  return lane * SCENE_STRIDE + slot;
}
/** Which instrument lane (row) a flat clip index belongs to (stride-64 decode). */
export function laneOf(index: number): number {
  return Math.floor(index / SCENE_STRIDE);
}
/** Which clip slot (scene column) within its lane a flat clip index is. */
export function slotOf(index: number): number {
  return index % SCENE_STRIDE;
}

/** Re-key ONE legacy (schema v1) flat clip key `lane*8+slot` to the current
 *  stride-64 key `lane*64+slot` (= `clipIndex(slot, lane)`), preserving the
 *  (lane, slot) it addressed. PURE. */
export function migrateLegacyClipKey(legacyKey: number): number {
  const lane = Math.floor(legacyKey / LEGACY_SCENE_STRIDE);
  const slot = legacyKey % LEGACY_SCENE_STRIDE;
  return lane * SCENE_STRIDE + slot;
}

/**
 * Bring a clip-player's persisted `data` up to CLIP_SCHEMA_VERSION IN PLACE,
 * re-keying its sparse `clips` map from the legacy stride-8 flat key to the
 * current stride-64 key so EVERY clip stays at the identical (lane, slot).
 *
 * Idempotent + storm-safe (the #1 save-compat requirement):
 *   - a no-op returning `false` when `data` is nullish OR already `sv === 2`;
 *   - stamps `data.sv = 2` so it runs AT MOST ONCE per player (never re-migrates);
 *   - moves ONLY the lane-1..7 keys — lane-0 keys are stride-invariant
 *     (`lane*8+slot === lane*64+slot` when lane=0) so they're left in place;
 *   - the moved keys (≥ SCENE_STRIDE) are DISJOINT from every legacy key
 *     (0..63), so an in-place delete-then-set on the SAME map never collides.
 *   - safe on empty / absent `clips` (just stamps `sv`).
 *
 * Each moved value is passed through `clone` before re-insertion so a LIVE
 * syncedStore Y child is never re-parented into a new key ("Type already
 * integrated" — [[yjs-save-load-real-ydoc]]). The default clone is a JSON deep
 * copy (fine for the plain-object load path); the engine passes `coerceClipRecord`
 * to sever live Y proxies. Returns `true` iff it changed the schema version.
 *
 * STRUCTURAL SAFETY NET: a genuine legacy (stride-8) key is `lane*8+slot` with
 * lane,slot ∈ 0..7, so it NEVER exceeds 63. If ANY clip key is ≥ SCENE_STRIDE the
 * map is unambiguously ALREADY stride-64 (programmatically-built or test v2 data
 * that just never got its `sv` stamped) — re-keying it would corrupt it, so we
 * only stamp `sv` and leave the map untouched. `sv` remains the authoritative
 * marker (the app stamps it at node-add via the engine factory); this net just
 * prevents a mis-migration of unstamped current-schema data.
 */
export function migrateClipPlayerData(
  data: { clips?: Record<string, ClipRecord | null>; sv?: number } | null | undefined,
  clone: (v: ClipRecord | null) => ClipRecord | null = plainCloneClip,
): boolean {
  if (!data || typeof data !== 'object') return false;
  if (data.sv === CLIP_SCHEMA_VERSION) return false; // already current — idempotent
  const clips = data.clips;
  if (clips && typeof clips === 'object' && !hasStride64Key(clips)) {
    for (const key of Object.keys(clips)) {
      const n = Number(key);
      if (!Number.isInteger(n) || n < 0) continue; // non-numeric / bad key → leave as-is
      const newKey = migrateLegacyClipKey(n);
      if (newKey === n) continue; // lane 0 — stride-invariant, no move needed
      const moved = clone(clips[key] ?? null);
      delete clips[key];
      clips[String(newKey)] = moved;
    }
  }
  data.sv = CLIP_SCHEMA_VERSION;
  return true;
}

/** True iff the clips map holds ANY key ≥ SCENE_STRIDE — the tell-tale of
 *  already-stride-64 data (a legacy stride-8 key is always ≤ 63). PURE. */
function hasStride64Key(clips: Record<string, unknown>): boolean {
  for (const key of Object.keys(clips)) {
    const n = Number(key);
    if (Number.isInteger(n) && n >= SCENE_STRIDE) return true;
  }
  return false;
}

/** Plain JSON deep-clone of a clip value (null-safe). The default `clone` for
 *  `migrateClipPlayerData` on the plain-object (envelope) path — and the plain,
 *  Y-severing clone the Launchpad copy/paste buffer + scene paste reuse (a JSON
 *  round-trip fully detaches any live syncedStore child; safe for every clip
 *  kind, which are all pure JSON data). */
export function plainCloneClip(v: ClipRecord | null): ClipRecord | null {
  return v == null ? null : (JSON.parse(JSON.stringify(v)) as ClipRecord);
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
// PER-CLIP AUTOMATION — the sibling `auto` map (automation redesign Phase 1)
// ---------------------------------------------------------------------------
//
// Every NOTE clip implicitly owns an automation object: a SIBLING record in the
// sparse `data.auto` map keyed by the SAME stride-64 `clipIndex(slot, lane)` as
// `data.clips` (Ableton's unlinked-envelope model, stored the way Bitwig 6
// stores it — automation OUT of the note clip value). NEVER a field on the
// NoteClipRecord: notes and automation must stay DISJOINT CRDT/merge/undo
// scopes, so a peer's note edit (`clips[k]`) and an automation record commit
// (`auto[k]`) can never last-writer-wins each other, and `coerceClipRecord`
// ('note') has no tracks field to silently drop (the note-clobber the redesign
// exists to prevent — see .myrobots/plans/automation-redesign-2026-07-16.md).
//
// An AutoClipRecord's `tracks` is keyed by TARGET KEY (`nodeId::paramId`), so a
// record commit writes ONLY the touched track keys (`auto[k].tracks[target] =
// plainEvents`) — never a whole-clip reassign on the recording hot path. Length
// is LINKED to the note clip (`lengthSteps`) in this phase; playback drives the
// mapped params TRANSIENTLY (never the Y.Doc —
// `cv-modulation-live-store-write-storm`). Automation data is CUSTOM
// parameter-envelope data (0..1 in the param's own domain), NOT MIDI.

/** Max automated params (tracks) in one clip's automation object — a UI-sanity
 *  cap, enforced at the coerce boundary AND at the record-commit seam. (NOT a
 *  MIDI-channel limit: automation is CUSTOM parameter-envelope data, not MIDI
 *  CC — owner: "automation data does not need to be midi data".) */
export const MAX_AUTOMATION_TRACKS = 16;

/** Max breakpoints PER track — the durable-size guard for a long automation
 *  take (a slow lane rate + long clip = a multi-minute pass). The recorder's
 *  real-time decimation gate keeps density ~30 pts/s, so this bounds a single
 *  track's committed array (and thus the ydoc/sync payload). Enforced at the
 *  coerce boundary; the recorder also caps before commit. */
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

/** The canonical string key for an automation target — `nodeId::paramId`. The
 *  SINGLE key format shared by `AutoClipRecord.tracks`, `data.autoAssign`, and
 *  the controller's client-local override sets. */
export function automationTargetKey(t: AutomationTarget): string {
  return t.nodeId + '::' + t.paramId;
}
/** Parse an `automationTargetKey` back to its (nodeId, paramId), or null for a
 *  malformed key (the coerce boundary drops those). */
export function parseAutomationTargetKey(key: string): AutomationTarget | null {
  if (typeof key !== 'string') return null;
  const i = key.indexOf('::');
  if (i <= 0 || i + 2 >= key.length) return null;
  return { nodeId: key.slice(0, i), paramId: key.slice(i + 2) };
}

/** One automated parameter's envelope INSIDE an AutoClipRecord — the value side
 *  of a `tracks[targetKey]` entry (the target itself is the key). `interp`
 *  overrides the playback interpolation: 'linear' (smooth ramp between points)
 *  or 'hold' (stepped). Absent ⇒ auto: linear for continuous params, hold for
 *  `curve:'discrete'` params (decided at playback from the ParamDef). */
export interface AutoTrack {
  events: AutomationEvent[]; // step-ordered
  interp?: 'linear' | 'hold';
}

/** ONE note clip's automation object — the value of `data.auto[clipIndex]`.
 *  `tracks` is keyed by `automationTargetKey` so a record commit mutates ONLY
 *  the touched keys (disjoint from every other track AND from the note clip). */
export interface AutoClipRecord {
  tracks: Record<string, AutoTrack>;
}

/** RUNTIME read view of one track — the (parsed target + events) shape the
 *  playback/record controller consumes. Built ONCE per change by the engine's
 *  cached read view (never per tick — the historic lane-stall cause). */
export interface AutomationTrack {
  target: AutomationTarget;
  events: AutomationEvent[]; // step-ordered
  interp?: 'linear' | 'hold';
}

export type ClipRecord = NoteClipRecord | AudioClipRecord | SnapshotClipRecord;

/** Persisted on node.data. Note clips are tiny so no caps in v1. */
export interface ClipPlayerData {
  /** Clip-key SCHEMA VERSION. Absent/undefined = legacy v1 (stride-8 flat clip
   *  keys) → `migrateClipPlayerData` re-keys `clips` to stride-64 on load and
   *  stamps CLIP_SCHEMA_VERSION here. Present = already stride-64. */
  sv?: number;
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
  // ── SCENE REPEATS (clip-scene-repeats.ts owns the model + helpers) ──
  /** Per-SCENE repeat counts — a sparse map keyed by the scene SLOT ('0'..'63'):
   *  an integer 1..SCENE_REPEATS_MAX plays the scene that many times then
   *  auto-advances to the next content scene down; ABSENT/0/invalid = INFINITE
   *  (the default — scenes loop forever). SYNCED CONTENT (duplicated with the
   *  player); PER-KEY writes via `setSceneRepeat` (setting infinite deletes the
   *  key), the same merge discipline as `autoAssign`. The value domain is a
   *  PURE count (extensible: a future per-scene field like a next-scene
   *  override would be a SIBLING map, never a mode folded into this number).
   *  Set from the Launchpad repeat-count view (HOLD GRID + HOLD a scene-launch
   *  button); the card shows a read-only "×N" flair. */
  sceneRepeats?: Record<string, number>;
  /** SCENE-LAUNCH intent marker `{slot, n}` — bumped (n+1) in the SAME
   *  transaction as every whole-scene queued write (`applySceneLaunchWrite`:
   *  Launchpad, monome, and the engine's repeat auto-advance). A resetNonce-
   *  style observed counter: every peer's engine re-anchors its repeat tracker
   *  to `slot` with a FRESH count when `n` changes (adopt-without-fire on the
   *  first tick, so loading a patch never replays a launch; re-launching the
   *  SAME scene resets its count — manual always wins). LIVE state, never
   *  duplicated. */
  sceneLaunch?: { slot: number; n: number };
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
  // ── SONG MODE (arranger v2 — the PRINTED performance; clip-song.ts) ──
  /** The recorded SONG — up to 8 channels of concrete PRINTED notes+timing + 8
   *  automation channels + one arranger-automation lane (clip-song.ts). CONTENT
   *  (copied on duplicate). Distinct from the legacy launch-log `arrangement`
   *  (kept intact for now; superseded by this). Absent = nothing recorded. The
   *  containers are created at the factory load seam (`ensureSongContainers`,
   *  container-LWW hardening) next to `auto`/`autoAssign`. */
  song?: SongData;
  /** SONG-REC arm state — LIVE/TRANSIENT (never duplicated; single-writer
   *  commit via `recorderId`). While `armed`, the recorder client PRINTS the
   *  performed session into `song` at the current song-beat (clip-song.ts). */
  songRec?: SongRecState | null;
  /** DUAL-LAUNCHPAD KEYS note-record state (design: clip-record-note-mode). A
   *  DISTINCT field from `recording` above (that is the ARRANGER launch-recorder
   *  in clip-arrange.ts — sharing it would break both). Set by the launchpad
   *  binding while the KEYS keyboard is armed/recording a clip; peers + the card
   *  see it. Absent/null = not note-recording. v1 single-recorder per clip. */
  noteRec?: NoteRecState | null;
  /** AUTOMATION record-arm state — PER LANE (the owner's Deluge-like model:
   *  "we arm this per channel, not as a global"). `lanes` is a sparse RECORD
   *  keyed by the lane digit ('0'..'7') — a PER-KEY map (like `autoAssign` and
   *  `auto[k].tracks`), so two peers arming/disarming DIFFERENT lanes
   *  concurrently merge key-by-key instead of last-writer-wins clobbering a
   *  whole array. `lanes[L].arm` = lane L armed: while true, touching ANY
   *  control of a MODULE assigned to lane L (screen / MIDI / Electra — never
   *  CV) records into lane L's PLAYING clip's sibling `auto` object (punch-in
   *  at that clip's own wrap; continuous overdub). `recorderId` = the arming
   *  client's `ydoc.clientID` — the SINGLE-WRITER **per lane**: peer A can
   *  record lane 1 while peer B records lane 2 (each lane commits on exactly
   *  one client — see `isLaneAutomationRecorder`). SYNCED; set by the card's
   *  per-lane ◉ / the Launchpad SHIFT+top-row gesture; the engine only READS
   *  it. Absent key = that lane not armed. The containers (`automation` +
   *  `lanes`) are created at the factory load seam next to `auto`/`autoAssign`
   *  (container-LWW hardening). Readers ALSO accept the interim ARRAY shape
   *  (81084fe9) — the branch is unreleased, so a cheap one-way read + a load-
   *  seam migrate cover it; the retired GLOBAL `{arm, recorderId}` fields are
   *  swept at load. */
  automation?: { lanes?: Record<string, AutomationLaneState | null> | (AutomationLaneState | null)[] };
  /** PER-CLIP AUTOMATION (sibling map): each note clip's automation object,
   *  keyed by the SAME stride-64 flat `clipIndex(slot, lane)` as `clips` — a
   *  PARALLEL key, never a field on the note clip, so note edits and automation
   *  commits are disjoint CRDT scopes (see the AutoClipRecord block above).
   *  Sparse; absent/null = the clip carries no automation. */
  auto?: Record<string, AutoClipRecord | null>;
  /** MODULE → LANE automation assignment: module node id → lane index
   *  (0..CLIP_LANES-1). Assignment is MODULE-level (owner-locked model: "we
   *  assign entire modules to a lane, they get the border"): ONE lane per
   *  module (re-assigning MOVES it); while lane L is armed, touching ANY
   *  control of a module assigned to L records that control. SYNCED (the
   *  module card's right-click "Assign to automation lane" menu writes it);
   *  the assigned module's CARD shows a thin border in the lane's colour.
   *  (Clean break: the retired `nodeId::paramId` keys coerce away.) */
  autoAssign?: Record<string, number>;
  creatorId?: string;
}

/** One lane's automation record-arm state (see ClipPlayerData.automation). */
export interface AutomationLaneState {
  arm?: boolean;
  recorderId?: number;
}

/** Lane L's coerced arm state, or null when not armed/absent. Accepts BOTH
 *  shapes: the canonical per-key RECORD ('0'..'7' → state) and the interim
 *  81084fe9 ARRAY (one-way read; the load seam migrates it). PURE. */
function laneAutomationState(
  data: ClipPlayerData | undefined,
  lane: number,
): AutomationLaneState | null {
  const lanes = data?.automation?.lanes;
  if (!lanes || typeof lanes !== 'object') return null;
  const s = Array.isArray(lanes) ? lanes[lane] : lanes[String(lane)];
  return s && typeof s === 'object' ? (s as AutomationLaneState) : null;
}

/** SINGLE-WRITER automation record gate — PER LANE: true ONLY when lane L is
 *  ARMED and THIS client is that lane's designated recorder
 *  (`lanes[L].recorderId === clientId`). Every peer reads the same synced
 *  per-lane state, but only the matching client's engine runs `recordLaneTick`
 *  + commits for that lane — so each lane's pass writes the durable store
 *  exactly once, while DIFFERENT peers may record DIFFERENT lanes
 *  concurrently. The clipplayer tick and the integration test share this
 *  predicate so the gate is one source of truth. */
export function isLaneAutomationRecorder(
  data: ClipPlayerData | undefined,
  lane: number,
  clientId: number,
): boolean {
  const s = laneAutomationState(data, lane);
  return !!s && s.arm === true && s.recorderId === clientId;
}

/** True when lane L's automation record is ARMED — the SYNCED per-lane flag
 *  every peer, the card's per-lane ◉, and the Launchpad top-row arm LEDs read.
 *  Distinct from `isLaneAutomationRecorder`, which also requires THIS client to
 *  be that lane's single-writer. PURE. */
export function laneAutomationArmed(data: ClipPlayerData | undefined, lane: number): boolean {
  return laneAutomationState(data, lane)?.arm === true;
}

/** Every lane's armed flag (length CLIP_LANES). PURE. */
export function armedAutomationLanes(data: ClipPlayerData | undefined): boolean[] {
  const out = new Array<boolean>(CLIP_LANES).fill(false);
  for (let L = 0; L < CLIP_LANES; L++) out[L] = laneAutomationArmed(data, L);
  return out;
}

/** True when ANY lane's automation record is armed on this player. PURE. */
export function isAutomationArmed(data: ClipPlayerData | undefined): boolean {
  for (let L = 0; L < CLIP_LANES; L++) if (laneAutomationArmed(data, L)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// AUTOMATION ASSIGNMENT (MODULE → lane) — PURE reads over `data.autoAssign`.
// The owner-locked model: entire MODULES are assigned to a lane; while that
// lane is armed, touching ANY control of an assigned module records it.
// ---------------------------------------------------------------------------

/** Coerce a raw `autoAssign` map: keep only entries whose key is a plausible
 *  MODULE node id (a non-empty string WITHOUT the retired `::` target-key
 *  separator — clean break: legacy param-level keys coerce away) AND whose
 *  value is an integer lane 0..CLIP_LANES-1. PURE. */
export function coerceAutoAssign(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof key !== 'string' || key.length === 0 || key.includes('::')) continue;
    const lane = Number(v);
    if (!Number.isInteger(lane) || lane < 0 || lane >= CLIP_LANES) continue;
    out[key] = lane;
  }
  return out;
}

/** The lane MODULE `moduleId` is assigned to on this player, or null. PURE. */
export function assignedLaneOfModule(
  data: { autoAssign?: unknown } | undefined,
  moduleId: string,
): number | null {
  const lane = coerceAutoAssign(data?.autoAssign)[moduleId];
  return typeof lane === 'number' ? lane : null;
}

/** The assigned MODULE ids of EACH lane (length CLIP_LANES) — the per-lane
 *  record scope: while lane L is armed, a touched control records IFF its
 *  module is in `laneAssignedModules(d)[L]`. PURE. */
export function laneAssignedModules(
  data: { autoAssign?: unknown } | undefined,
): string[][] {
  const out: string[][] = Array.from({ length: CLIP_LANES }, () => []);
  for (const [moduleId, lane] of Object.entries(coerceAutoAssign(data?.autoAssign))) {
    out[lane]!.push(moduleId);
  }
  return out;
}

/** Per-lane assigned-MODULE counts (length CLIP_LANES) — the card's chip row
 *  renders exactly this, so the readout can never disagree with `autoAssign`.
 *  `exists` (optional) filters out DANGLING modules (deleted) so the chips
 *  never count ghosts while the prune catches up. */
export function autoAssignCounts(
  data: { autoAssign?: unknown } | undefined,
  exists?: (moduleId: string) => boolean,
): number[] {
  const out = new Array<number>(CLIP_LANES).fill(0);
  for (const [moduleId, lane] of Object.entries(coerceAutoAssign(data?.autoAssign))) {
    if (exists && !exists(moduleId)) continue;
    out[lane]!++;
  }
  return out;
}

/**
 * SINGLE-DRIVER playback ownership (per-clip automation, cross-lane rule): for
 * each targetKey carried by any ACTIVE lane's automation, the ONE lane that may
 * drive it this tick — the lane its MODULE is ASSIGNED to when that lane is an
 * active carrier, else the LOWEST active carrier lane. Two clips in different
 * lanes carrying the same param therefore never co-drive (no interleaved ramp
 * fights); the module assignment resolves the tie the owner's way. PURE.
 *
 * `assign` = the coerced MODULE→lane map. `carriers[lane]` = the track-key set
 * of that lane's ACTIVE clip's automation (null/undefined = lane inactive or
 * carries none).
 */
export function autoPlaybackOwners(
  assign: Record<string, number>,
  carriers: ReadonlyArray<ReadonlySet<string> | null | undefined>,
): Map<string, number> {
  const owners = new Map<string, number>();
  for (let lane = 0; lane < carriers.length; lane++) {
    const keys = carriers[lane];
    if (!keys) continue;
    for (const k of keys) {
      if (!owners.has(k)) owners.set(k, lane); // lowest active carrier
    }
  }
  for (const [k] of owners) {
    const target = parseAutomationTargetKey(k);
    if (!target) continue;
    const lane = assign[target.nodeId];
    if (typeof lane === 'number' && carriers[lane]?.has(k)) {
      owners.set(k, lane); // the module's assigned lane WINS when carrying
    }
  }
  return owners;
}

/**
 * ARM-time shell pre-creation (container-LWW hardening), PER LANE: ensure
 * `auto[k]` exists for EVERY note clip in lane L when the lane has ≥1
 * assigned module, so the recorder's per-key commits land in containers
 * created OUTSIDE the racy commit path (a peer's concurrent write to a
 * sibling key can then never be clobbered by a container-creation
 * last-writer-wins). Shelling the WHOLE lane (bounded ≤ SCENE_STRIDE slots)
 * covers the common arm-then-LAUNCH flow too — a clip launched after arming
 * already has its shell. Empty `{tracks:{}}` shells are inert: the carrier
 * probes (`autoClipHasTracks` / `readAutoClip`) require ≥1 track key, so no
 * teal dots light and playback ignores them. Mutates `d` IN PLACE — call
 * inside the lane-arming write's transaction. (A clip CREATED later while
 * armed still falls back to the commit-side creation.)
 */
export function ensureLaneArmAutoShell(d: ClipPlayerData, lane: number): void {
  if (laneAssignedModules(d)[lane]!.length === 0) return;
  if (!d.clips) return;
  let ensured = false;
  for (let slot = 0; slot < SCENE_STRIDE; slot++) {
    const k = String(clipIndex(slot, lane));
    const clip = d.clips[k] as { kind?: unknown } | null | undefined;
    if (!clip || clip.kind !== 'note') continue;
    if (!ensured && !d.auto) d.auto = {};
    ensured = true;
    if (!d.auto![k] || typeof d.auto![k] !== 'object') d.auto![k] = { tracks: {} };
  }
}

/**
 * One-way MIGRATE of the interim 81084fe9 ARRAY `automation.lanes` shape to
 * the canonical per-key RECORD ('0'..'7' → {arm, recorderId}) IN PLACE.
 * No-op when already a record / absent. Plain values only (severs any live Y
 * child — [[yjs-save-load-real-ydoc]]). Called from the factory load seam and
 * defensively from the toggle. Returns true when it migrated.
 */
export function migrateAutomationLanesShape(d: ClipPlayerData): boolean {
  const cur = d.automation?.lanes;
  if (!Array.isArray(cur)) return false;
  const rec: Record<string, AutomationLaneState> = {};
  for (let i = 0; i < CLIP_LANES && i < cur.length; i++) {
    const e = cur[i] as AutomationLaneState | null | undefined;
    if (e && typeof e === 'object' && e.arm === true) {
      const entry: AutomationLaneState = { arm: true };
      if (typeof e.recorderId === 'number') entry.recorderId = e.recorderId;
      rec[String(i)] = entry;
    }
  }
  d.automation!.lanes = rec;
  return true;
}

/**
 * TOGGLE lane L's automation record-arm IN PLACE — the ONE write seam the
 * card's per-lane ◉ AND the Launchpad SHIFT+top-row gesture share (so both
 * surfaces stay in sync via the same synced field). PER-KEY set/delete on the
 * `lanes` record (the same merge discipline as `autoAssign` /
 * `auto[k].tracks`), so concurrent arm/disarm of DIFFERENT lanes by different
 * peers merges key-by-key — never a whole-array LWW. The containers are
 * created at the factory load seam; the lazy init here is only the defensive
 * fallback for data the factory hasn't touched yet. WHEN ARMING: stamps
 * `clientId` as that lane's single-writer recorderId and pre-creates the
 * lane's auto shells (container-LWW hardening). Call inside the caller's
 * transaction. Returns the NEW armed state.
 */
export function toggleLaneAutomationArm(
  d: ClipPlayerData,
  lane: number,
  clientId: number,
): boolean {
  if (!d.automation || typeof d.automation !== 'object') d.automation = {};
  migrateAutomationLanesShape(d); // interim array shape → record (one-way)
  if (!d.automation.lanes || typeof d.automation.lanes !== 'object') d.automation.lanes = {};
  const lanes = d.automation.lanes as Record<string, AutomationLaneState | null>;
  const k = String(Math.max(0, Math.min(CLIP_LANES - 1, Math.trunc(lane))));
  const cur = lanes[k];
  const arming = !(cur && typeof cur === 'object' && cur.arm === true);
  if (arming) {
    lanes[k] = { arm: true, recorderId: clientId }; // single-KEY write
    ensureLaneArmAutoShell(d, lane);
  } else {
    delete lanes[k]; // single-KEY delete
  }
  return arming;
}

// ---------------------------------------------------------------------------
// LIVE-PERFORMANCE (transient) data fields — the DUPLICATE scrub. A duplicated
// clip player must copy CONTENT (clips, recorded automation, per-lane
// settings, the arrangement) but never LIVE STATE: a duplicate born ARMED
// with the original's recorderId would double-record, a copied autoAssign
// would double-claim modules (one lane per module is a GLOBAL invariant), and
// copied playing/queued sets would ghost-launch. The duplicate paths (single
// node + group) call this on the CLONE before insertion.
// ---------------------------------------------------------------------------
/** node.data fields that are LIVE-PERFORMANCE state, never duplicated. */
export const CLIP_PLAYER_TRANSIENT_DATA_FIELDS = [
  'playing', // the live playing-set
  'queued', // pending launches
  'queuedImmediate', // pending NOW overrides
  'recording', // arranger record-arm (legacy launch-log)
  'songRec', // SONG-REC arm (the printed-performance recorder; `song` is CONTENT)
  'noteRec', // KEYS note-record state
  'automation', // per-lane automation arm + recorderIds
  'autoAssign', // module→lane claims (globally exclusive — never copied)
  'resetNonce', // reset intent counter
  'sceneLaunch', // scene-launch intent marker (sceneRepeats itself is CONTENT — copied)
] as const;

/** Strip the live-performance fields from a clip-player data CLONE (in
 *  place). Safe on any shape; a no-op for non-objects. PURE mutation of the
 *  passed clone — callers pass the DUPLICATE's data, never the source's. */
export function scrubClipPlayerTransientData(data: Record<string, unknown> | undefined): void {
  if (!data || typeof data !== 'object') return;
  for (const f of CLIP_PLAYER_TRANSIENT_DATA_FIELDS) {
    if (f in data) delete data[f];
  }
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
  if (r.kind === 'audio' || r.kind === 'snapshot') return r as unknown as ClipRecord;
  // Unknown kinds — including the RETIRED stamped `kind:'automation'` clip from
  // the pre-rehome model (clean break; the branch is unreleased) — coerce away
  // silently: the cell reads as empty, the load never crashes.
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

/** Clamp a raw keyed-track VALUE ({ events, interp? }) into a valid AutoTrack,
 *  or null. Events are coerced, filtered, step-sorted, and capped at
 *  MAX_AUTOMATION_EVENTS (the durable-size guard for long takes). */
export function coerceAutoTrack(raw: unknown): AutoTrack | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Record<string, unknown>;
  const events = (Array.isArray(t.events) ? t.events : [])
    .map(coerceAutomationEvent)
    .filter((e): e is AutomationEvent => e !== null)
    .sort((a, b) => a.step - b.step)
    .slice(0, MAX_AUTOMATION_EVENTS);
  const out: AutoTrack = { events };
  if (t.interp === 'linear' || t.interp === 'hold') out.interp = t.interp;
  return out;
}

/** Coerce ONE clip's raw automation object (`data.auto[k]`) at the boundary:
 *  keep only tracks whose key parses as a target and whose value coerces, in
 *  sorted-key order, capped at MAX_AUTOMATION_TRACKS. Returns a NEW plain
 *  record (a deep, Y-severed copy) or null for an unusable value. PURE. */
export function coerceAutoClipRecord(raw: unknown): AutoClipRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const rawTracks = r.tracks;
  const tracks: Record<string, AutoTrack> = {};
  if (rawTracks && typeof rawTracks === 'object') {
    let n = 0;
    for (const key of Object.keys(rawTracks as Record<string, unknown>).sort()) {
      if (n >= MAX_AUTOMATION_TRACKS) break; // the documented cap, at the boundary
      if (!parseAutomationTargetKey(key)) continue; // malformed key → dropped
      const track = coerceAutoTrack((rawTracks as Record<string, unknown>)[key]);
      if (!track) continue;
      tracks[key] = track;
      n++;
    }
  }
  return { tracks };
}

/** Read + coerce ONE clip's automation object from node.data, or null when the
 *  clip carries none. Accepts any shape (the value is coerced/validated). */
export function readAutoClip(
  data: { auto?: Record<string, unknown> } | undefined,
  index: string | number,
): AutoClipRecord | null {
  const raw = data?.auto?.[String(index)];
  if (!raw) return null;
  const rec = coerceAutoClipRecord(raw);
  return rec && Object.keys(rec.tracks).length > 0 ? rec : null;
}

/** Build the RUNTIME track views (parsed target + step-sorted events) from a
 *  coerced AutoClipRecord — the shape the playback/record controller consumes.
 *  PURE; the engine caches the result per clip identity/revision (coerce-ONCE —
 *  never per tick). */
export function autoTrackViews(rec: AutoClipRecord | null | undefined): AutomationTrack[] {
  if (!rec) return [];
  const out: AutomationTrack[] = [];
  for (const [key, tr] of Object.entries(rec.tracks)) {
    const target = parseAutomationTargetKey(key);
    if (!target) continue;
    const view: AutomationTrack = { target, events: tr.events };
    if (tr.interp) view.interp = tr.interp;
    out.push(view);
  }
  return out;
}

/** Plain deep-clone of an AutoClipRecord (Y-severing — safe to write into the
 *  store, and re-cloned per paste so one buffer never shares refs). Null in,
 *  null out; a record with zero tracks also clones to null (nothing to carry). */
export function plainCloneAutoClip(rec: AutoClipRecord | null | undefined): AutoClipRecord | null {
  if (!rec || !rec.tracks) return null;
  const tracks: Record<string, AutoTrack> = {};
  let any = false;
  for (const [key, tr] of Object.entries(rec.tracks)) {
    const t: AutoTrack = { events: (tr.events ?? []).map((e) => ({ step: e.step, value: e.value })) };
    if (tr.interp === 'linear' || tr.interp === 'hold') t.interp = tr.interp;
    tracks[key] = t;
    any = true;
  }
  return any ? { tracks } : null;
}

/** Mirror an automation record in TIME for PASTE-REVERSE (the envelope belongs
 *  to the clip, so a time-reversed paste carries a time-reversed envelope):
 *  each event's step → lengthSteps − step (clamped ≥ 0), re-sorted. PURE —
 *  returns a NEW plain record. */
export function reverseAutoClipRecord(
  rec: AutoClipRecord,
  lengthSteps: number,
): AutoClipRecord {
  const len = Math.max(1, lengthSteps);
  const tracks: Record<string, AutoTrack> = {};
  for (const [key, tr] of Object.entries(rec.tracks)) {
    const t: AutoTrack = {
      events: (tr.events ?? [])
        .map((e) => ({ step: Math.max(0, len - e.step), value: e.value }))
        .sort((a, b) => a.step - b.step),
    };
    if (tr.interp === 'linear' || tr.interp === 'hold') t.interp = tr.interp;
    tracks[key] = t;
  }
  return { tracks };
}

/** CHEAP carrier probe: does a raw `auto[k]` value hold ≥1 track key? (No full
 *  coerce — the card's per-cell automation dot reads this per render.) PURE. */
export function autoClipHasTracks(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const tracks = (raw as { tracks?: unknown }).tracks;
  if (!tracks || typeof tracks !== 'object') return false;
  for (const key of Object.keys(tracks as Record<string, unknown>)) {
    if (parseAutomationTargetKey(key)) return true;
  }
  return false;
}

/** True when two targets reference the same (nodeId, paramId) control. */
export function sameAutomationTarget(a: AutomationTarget, b: AutomationTarget): boolean {
  return a.nodeId === b.nodeId && a.paramId === b.paramId;
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
 * Callers MUST pass a PLAIN snapshot of `existing` (e.g. from
 * `coerceAutoClipRecord` / the engine's cached read view), NEVER the live
 * Y.Array — `kept` retains references to `existing`'s elements, and reassigning
 * integrated Y children throws "Type already integrated"
 * ([[yjs-save-load-real-ydoc]]). The commit writes the merged PLAIN events into
 * ONLY the touched track key (`auto[k].tracks[target]`). Returns a NEW
 * step-sorted, event-capped array.
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
// SCENE copy/paste — a TYPED clipboard for the Launchpad clip-launcher. A
// "scene" is all CLIP_LANES lanes' clips at ONE slot (`clipIndex(slot, lane)`).
// The buffer holds either ONE clip OR a whole scene, always as PLAIN deep-clones
// (never a live Y child). These helpers are PURE (the .svelte.ts owns the buffer
// state + the origin-tagged Y writes). See launchpad-control.svelte.ts.
// ---------------------------------------------------------------------------

/** What the copy buffer holds, or what a paste targets. */
export type CopyBufferKind = 'clip' | 'scene';
export type CopyTargetKind = 'clip' | 'scene';

/** The TYPED copy buffer: one clip, or a whole scene (all CLIP_LANES lanes'
 *  clips at a slot; an empty lane is `null`). Held as PLAIN deep-clones. The
 *  ENVELOPE BELONGS TO THE CLIP: the buffer also carries each source clip's
 *  sibling automation (`auto`/`autos`, null = the source carried none), so a
 *  paste moves the automation WITH the notes. A SCENE buffer also carries the
 *  source scene's REPEAT COUNT (`repeats`; 0/absent = infinite) — counts are
 *  content, so a full-replace scene paste sets the target's count from the
 *  buffer (or clears it when the source had none — no ghost counts, same
 *  discipline as the automation). */
export type CopyBuffer =
  | { kind: 'clip'; clip: NoteClipRecord; auto: AutoClipRecord | null }
  | {
      kind: 'scene';
      clips: (ClipRecord | null)[];
      autos: (AutoClipRecord | null)[];
      repeats?: number;
    };

/** Paste TYPE-GATE (PURE): a paste applies ONLY when the buffer kind matches the
 *  target kind — scene→scene + clip→clip apply; scene→clip + clip→scene are
 *  NO-OPs (buffer + targets untouched, no write). The single source the surface
 *  and its tests both consult. */
export function pasteApplies(bufferKind: CopyBufferKind, targetKind: CopyTargetKind): boolean {
  return bufferKind === targetKind;
}

/** COPY a whole SCENE (all CLIP_LANES lanes' clips at `slot`) as PLAIN clones —
 *  index i = lane i's clip (coerced/severed from any live Y child) or `null` when
 *  that lane is empty at the slot. PURE (reads only). */
export function readScene(
  data: { clips?: Record<string, unknown> } | undefined,
  slot: number,
): (ClipRecord | null)[] {
  const out: (ClipRecord | null)[] = new Array(CLIP_LANES).fill(null);
  for (let lane = 0; lane < CLIP_LANES; lane++) {
    out[lane] = readClip(data, clipIndex(slot, lane));
  }
  return out;
}

/** COPY a scene's SIBLING AUTOMATION (all CLIP_LANES lanes' `auto[k]` records at
 *  `slot`) as PLAIN coerced clones — index i = lane i's automation or null when
 *  that lane's clip carries none. Paired with `readScene` when filling the
 *  typed scene buffer (the envelope belongs to the clip). PURE. */
export function readSceneAutos(
  data: { auto?: Record<string, unknown> } | undefined,
  slot: number,
): (AutoClipRecord | null)[] {
  const out: (AutoClipRecord | null)[] = new Array(CLIP_LANES).fill(null);
  for (let lane = 0; lane < CLIP_LANES; lane++) {
    out[lane] = readAutoClip(data, clipIndex(slot, lane));
  }
  return out;
}

/** Plan a SCENE paste (FULL REPLACE) into `targetSlot`: for EACH lane 0..7, the
 *  flat clip index + the PLAIN-cloned clip to write — `null` MEANS delete that
 *  lane's key so a lane the source scene left empty EMPTIES the target lane —
 *  PLUS the clip's sibling `auto` record (`null` = delete the target's stale
 *  automation: the envelope belongs to the clip, so replacing/emptying the clip
 *  replaces/empties its automation too). PURE. The caller applies each entry in
 *  ONE origin-tagged transaction (set non-null, delete null, for BOTH maps) → a
 *  single undo step. Re-clones so pasting one buffer to many targets never
 *  shares references. */
export function sceneWritePlan(
  targetSlot: number,
  sceneClips: (ClipRecord | null)[],
  sceneAutos?: (AutoClipRecord | null)[],
): { index: number; value: ClipRecord | null; auto: AutoClipRecord | null }[] {
  const plan: { index: number; value: ClipRecord | null; auto: AutoClipRecord | null }[] = [];
  for (let lane = 0; lane < CLIP_LANES; lane++) {
    const value = plainCloneClip(sceneClips[lane] ?? null);
    plan.push({
      index: clipIndex(targetSlot, lane),
      value,
      // No clip ⇒ no automation either (delete both target keys).
      auto: value === null ? null : plainCloneAutoClip(sceneAutos?.[lane] ?? null),
    });
  }
  return plan;
}

// ---------------------------------------------------------------------------
// Scheduling math (note clip → poly lanes) — PURE
// ---------------------------------------------------------------------------

/** NoteEvents that START on `step` (their gate opens here). */
export function notesStartingAt(clip: NoteClipRecord, step: number): NoteEvent[] {
  return clip.steps.filter((e) => e.step === step);
}

/**
 * The notes that START on `step` AND WIN their per-trigger probability dice-roll
 * — the single source of "what actually fires this pass". The roll is PER-NOTE
 * (probEff >= 1 always fires; else `rng() < probEff`), so a chord PARTIALLY
 * fires. `rng` defaults to `Math.random` (live playback); tests inject a seeded
 * `mulberry32` for deterministic pass/fail counts. Reference: Kria's
 * `prob >= 1 || Math.random() < prob`. PURE — never mutates the clip; the caller
 * (clipplayer's tick loop) rolls ONCE per lane-step and feeds BOTH the audio
 * scheduling AND the song-print buffer so the printed take == what sounded.
 */
export function notesFiringAt(
  clip: NoteClipRecord,
  step: number,
  rng: () => number = Math.random,
): NoteEvent[] {
  return notesStartingAt(clip, step).filter((ev) => {
    const p = probEff(ev);
    return p >= 1 || rng() < p;
  });
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
export function lanesForStep(
  clip: NoteClipRecord,
  step: number,
  rng: () => number = Math.random,
): StepLanes {
  return lanesFromFiring(notesFiringAt(clip, step, rng));
}

/**
 * Build the poly output lanes + velocity + gate width from an ALREADY-ROLLED
 * firing set (the surviving notes for this step). Split out of `lanesForStep`
 * so the clipplayer tick can roll the dice ONCE (`notesFiringAt`) and feed the
 * SAME survivors to both the audio scheduling and the print buffer (decision 3:
 * printed == sounded). Chords fill consecutive lanes, capped at
 * POLY_CHANNEL_PAIRS. PURE.
 */
export function lanesFromFiring(firing: NoteEvent[]): StepLanes {
  const starting = firing.slice(0, POLY_CHANNEL_PAIRS);
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

// ---------------------------------------------------------------------------
// PER-NOTE PROBABILITY (owner-spec'd). Each note carries an optional firing
// PROBABILITY (`NoteEvent.prob`, 0..1, default 1). At playback a per-trigger
// dice-roll (notesFiringAt) gates whether the note sounds. The `prob` KEY IS
// DELETED at ≥100% so "100% = the default" falls out with zero special-casing
// and clips authored before this feature stay byte-identical (an absent key
// reads as 1 via `probEff`). Lives entirely in node.data → NO PortDef/ParamDef,
// schema-version, contract-lock or attest churn.
//
// The "40 levels × 2.5%" is a UI affordance only (the LED count bar + the card
// menu); storage keeps the raw 0..1 float, coerced/clamped in coerceNoteEvent.
// ---------------------------------------------------------------------------
/** UI probability step — 2.5% per level. Storage stays a raw 0..1 float. */
export const PROB_STEP = 0.025;
/** Number of UI probability levels (40): level 1 = 2.5% … level 40 = 100%. */
export const PROB_LEVELS = 40;
/** UI level (1..PROB_LEVELS) → its 0..1 value (n*PROB_STEP; 40 → exactly 1). */
export function probLevelToValue(n: number): number {
  const lvl = Math.max(1, Math.min(PROB_LEVELS, Math.round(n)));
  return lvl === PROB_LEVELS ? 1 : lvl * PROB_STEP;
}
/** A 0..1 probability → its UI level (1..PROB_LEVELS). Rounds to the nearest
 *  2.5% level, clamped to ≥1 (a 0% note still shows level 1 so it stays visible). */
export function valueToProbLevel(p: number): number {
  const v = Math.max(0, Math.min(1, Number.isFinite(p) ? p : 1));
  return Math.max(1, Math.min(PROB_LEVELS, Math.round(v / PROB_STEP)));
}
/** The EFFECTIVE firing probability of a note event — the single source used by
 *  playback (the dice-roll), the LED paint AND the card cell colour. An absent
 *  `prob` key (the common case + every legacy clip) reads as 1 (always fires). */
export function probEff(ev: { prob?: number } | undefined): number {
  const p = ev?.prob;
  return typeof p === 'number' && Number.isFinite(p) ? Math.max(0, Math.min(1, p)) : 1;
}

/**
 * Set the firing PROBABILITY of the note COVERING (step, midi) — the ONE write
 * seam the Launchpad PROB page AND the card's Probability menu share (mirrors
 * `cycleVelocity`). Pure: returns a NEW clip (callers persist via the in-place
 * Y discipline). NEVER creates or removes a note (a plain tap does that) — a
 * press on an empty cell is a no-op (the SAME reference is returned so the
 * caller can skip the write). At ≥100% the `prob` KEY IS DELETED (not set to 1)
 * so "100% = white" falls out for free and old clips round-trip byte-identical.
 */
export function setNoteProb(
  clip: NoteClipRecord,
  step: number,
  midi: number,
  prob: number,
): NoteClipRecord {
  const cov = noteCovering(clip, step, midi);
  if (!cov) return clip; // no note here → no-op (never create)
  const p = Math.max(0, Math.min(1, Number.isFinite(prob) ? prob : 1));
  const steps = clip.steps.map((e) => {
    if (e.step !== cov.step || e.midi !== cov.midi) return e;
    if (p >= 1) {
      // DELETE the key at 100% (the default) — old clips stay byte-identical.
      const { prob: _drop, ...rest } = e;
      return rest;
    }
    return { ...e, prob: p };
  });
  return { ...clip, steps };
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
