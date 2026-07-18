// packages/web/src/lib/audio/modules/clip-song.ts
//
// SONG MODE — the SONG data model + PURE helpers for the `clipplayer` module.
//
// (design: .myrobots/plans/arranger-song-mode-2026-07-18.md — PHASE 1 core.)
//
// The owner's model: the arranger view BECOMES a SONG view. Recording under a
// SONG-REC arm captures — over song time — a CONCRETE, PRINTED performance:
//   1. up to 8 channels of NOTE + TIMING (`song.notes[lane]`) — literally what
//      SOUNDED, post per-lane rate/div/swing/mono/S&H, captured at APPLY time;
//   2. up to 8 channels of AUTOMATION (`song.auto[lane]`) captured from the clip
//      automation that fired during playback (engine capture = Phase 2);
//   3. ONE song-wide ARRANGER-AUTOMATION lane (`song.arrangerAuto`) fed by
//      controls assigned to it, which OVERRIDES clip/channel automation per-param
//      (engine capture + playback = Phase 2).
// PLAYBACK: song time drives the printed channels straight out the 8 lane
// pitch/gate/vel outputs — clips do NOT launch live (v1 authoritative).
//
// This file is the throw-out of the launch-log-as-song (clip-arrange.ts's
// ArrangeData). It models a PRINTED performance (concrete notes + automation),
// not a REFERENCE performance (a launch log the engine re-derives at play time).
// The old skeleton is kept intact for now (a separate `clipMode:'arrangement'`);
// its clean-break removal is a later phase.
//
// Kept engine-free (no AudioContext / no Yjs) so the record/print/playback math
// is unit-testable in isolation. The factory owns the song clock + the record
// tee + the playback cursor; this file only shapes + queries the data.
//
// STORAGE DISCIPLINE — deliberately PARALLEL to the per-clip `auto[]` model
// (clip-types.ts): sibling-keyed sparse maps + per-key writes + coerce-at-
// boundary + 0..1-normalized automation, so all the CRDT reasoning
// ([[yjs-save-load-real-ydoc]], [[cv-modulation-live-store-write-storm]])
// transfers with zero new invention. Song positions are ABSOLUTE SONG-BEAT (the
// defining difference from clip-step): the printed timeline is not clip-relative.
//
// (Exports no `*Def`, so the audio-module glob ignores it — allow-listed in
// module-manifest.ts so the "no Def" scan doesn't warn.)

import {
  CLIP_LANES,
  automationTargetKey,
  parseAutomationTargetKey,
  type AutomationTarget,
} from './clip-types';

/** Schema marker for the SONG sub-model (independent of `ClipPlayerData.sv`). */
export const SONG_SCHEMA_VERSION = 1;

/** Max NOTE events in ONE note channel — the durable-size guard for a long
 *  multi-minute print (per-key write; the recorder also caps before commit).
 *  Notes are DISCRETE onsets (no per-tick decimation like automation), so this
 *  is a generous hard ceiling that bounds a single lane's committed array (and
 *  thus the ydoc/sync payload). */
export const MAX_SONG_NOTE_EVENTS = 8000;
/** Max automated params (tracks) in one auto channel / the arranger lane. */
export const MAX_SONG_AUTO_TRACKS = 32;
/** Max breakpoints PER auto track (the decimated-density guard, Phase 2). */
export const MAX_SONG_AUTO_EVENTS = 8000;

// ---------------------------------------------------------------------------
// Types — the printed layers.
// ---------------------------------------------------------------------------

/** One printed note ONSET at an ABSOLUTE song-beat. Poly: several events may
 *  share a `beat` (a chord). `lengthBeats` is the sounding gate width captured
 *  at print time (= the clip note's step length × the lane's step duration, in
 *  song-beats) — so no note-off tracking is needed: the emitted step already
 *  encodes the note's length. */
export interface SongNoteEvent {
  beat: number; // absolute song-beat of the note ONSET (fractional, drift-proof)
  midi: number; // MIDI note int (same convention as NoteEvent; OCT applied at output)
  velocity?: number; // 0..127
  lengthBeats?: number; // gate width in song-beats
}

/** One instrument lane's printed NOTE + TIMING channel (sparse; absent = none). */
export interface SongNoteChannel {
  events: SongNoteEvent[]; // beat-ordered (coerce/merge guarantee it)
}

/** One automation breakpoint at an ABSOLUTE song-beat. `value` is 0..1 in the
 *  param's normalized space (the same 0..1 a Fader/knob reports). */
export interface SongAutoEvent {
  beat: number;
  value: number;
}

/** One automated parameter's envelope INSIDE an auto channel / the arranger
 *  lane — the value side of a `tracks[targetKey]` entry. `interp` overrides
 *  playback interpolation (same semantics as AutoTrack.interp). */
export interface SongAutoTrack {
  events: SongAutoEvent[]; // beat-ordered
  interp?: 'linear' | 'hold';
}

/** One automation channel (a lane's channel, or the arranger lane): a
 *  targetKey→track map, keyed by `automationTargetKey` (`nodeId::paramId`) —
 *  the exact key format clip automation uses. */
export interface SongAutoChannel {
  tracks: Record<string, SongAutoTrack>;
}

/** The recorded Song — a concrete, PRINTED performance over song time. */
export interface SongData {
  /** Schema marker for this sub-model. */
  v: number;
  /** Song length in beats. 0 = OPEN (derive from the furthest event, bar-ceil). */
  lengthBeats: number;
  /** Loop the song (true) or play once then stop (false). */
  loop: boolean;
  /** NOTE + TIMING channels — per instrument lane, sparse. Keyed by lane digit
   *  '0'..'7' (per-key write discipline, like auto[]/autoAssign). */
  notes?: Record<string, SongNoteChannel | null>;
  /** AUTOMATION channels captured from CLIP automation as it fired — per lane,
   *  keyed by lane digit. (Engine capture = Phase 2; the model ships now.) */
  auto?: Record<string, SongAutoChannel | null>;
  /** The single ARRANGER-AUTOMATION LANE: targetKey → track, captured from live
   *  tweaks of controls ASSIGNED to the arranger lane. OVERRIDES clip + channel
   *  automation for the same param (see songPlaybackOwners). */
  arrangerAuto?: SongAutoChannel;
  /** Which MODULES feed the arranger-automation lane: module nodeId → true. A
   *  SEPARATE map from the per-clip `autoAssign` — a module may feed a clip lane
   *  AND/OR the arranger lane. Per-key writes. */
  arrangerAssign?: Record<string, true>;
}

/** Record-arm state (live/transient — never duplicated; single-writer commit). */
export interface SongRecState {
  /** Master arm: song is armed to record on the current/next play. */
  armed?: boolean;
  /** REPLACE (default — arming clears the print + restarts song time) or
   *  OVERDUB (keep the print + song time; new content merges by beat). */
  mode?: 'replace' | 'overdub';
  /** The arming client's `ydoc.clientID` — the SINGLE-WRITER for the PRINT
   *  commit (avoids double-print in multiplayer; others watch/play). */
  recorderId?: number;
  /** Per-channel NOTE-record enable, keyed by lane digit '0'..'7'. Absent =
   *  the channel captures nothing this take (Deluge per-track arrangement arm). */
  noteEnable?: Record<string, true>;
  /** Per-channel AUTOMATION-record enable (captures that lane's clip automation
   *  into song.auto[lane]) — Phase 2. */
  autoEnable?: Record<string, true>;
  /** ARRANGER-automation-lane record enable (captures assigned-module tweaks) —
   *  Phase 2. */
  arrangerEnable?: boolean;
}

// ---------------------------------------------------------------------------
// Defaults + coercion (SyncedStore / patch-load safe — drops garbage, caps
// sizes, plain-object-severs live Y children per [[yjs-save-load-real-ydoc]]).
// ---------------------------------------------------------------------------

/** A fresh, empty song (open length, looping). */
export function defaultSongData(): SongData {
  return { v: SONG_SCHEMA_VERSION, lengthBeats: 0, loop: true };
}

/** Normalize one possibly-garbage note event, or null if unusable. */
export function coerceSongNoteEvent(raw: unknown): SongNoteEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const beat = Number(r.beat);
  const midi = Math.round(Number(r.midi));
  if (!Number.isFinite(beat) || beat < 0) return null;
  if (!Number.isFinite(midi)) return null;
  const ev: SongNoteEvent = { beat, midi };
  if (typeof r.velocity === 'number' && Number.isFinite(r.velocity)) {
    ev.velocity = Math.max(0, Math.min(127, Math.round(r.velocity)));
  }
  if (typeof r.lengthBeats === 'number' && Number.isFinite(r.lengthBeats) && r.lengthBeats > 0) {
    ev.lengthBeats = r.lengthBeats;
  }
  return ev;
}

/** Stable beat comparator (equal beats keep insertion order via a stable sort). */
function byBeat(a: { beat: number }, b: { beat: number }): number {
  return a.beat - b.beat;
}

/** Normalize a possibly-garbage note channel: coerce + drop + beat-sort + cap. */
export function coerceSongNoteChannel(raw: unknown): SongNoteChannel | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const events = (Array.isArray(r.events) ? r.events : [])
    .map(coerceSongNoteEvent)
    .filter((e): e is SongNoteEvent => e !== null)
    .sort(byBeat)
    .slice(0, MAX_SONG_NOTE_EVENTS);
  return { events };
}

/** Clamp a raw value into a valid SongAutoEvent, or null. */
export function coerceSongAutoEvent(raw: unknown): SongAutoEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Record<string, unknown>;
  const beat = Number(e.beat);
  const value = Number(e.value);
  if (!Number.isFinite(beat) || beat < 0) return null;
  if (!Number.isFinite(value)) return null;
  return { beat, value: Math.max(0, Math.min(1, value)) };
}

/** Clamp a raw keyed-track value into a valid SongAutoTrack, or null. */
export function coerceSongAutoTrack(raw: unknown): SongAutoTrack | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Record<string, unknown>;
  const events = (Array.isArray(t.events) ? t.events : [])
    .map(coerceSongAutoEvent)
    .filter((e): e is SongAutoEvent => e !== null)
    .sort(byBeat)
    .slice(0, MAX_SONG_AUTO_EVENTS);
  const out: SongAutoTrack = { events };
  if (t.interp === 'linear' || t.interp === 'hold') out.interp = t.interp;
  return out;
}

/** Coerce ONE automation channel (targetKey→track), dropping malformed keys,
 *  in sorted-key order, capped at MAX_SONG_AUTO_TRACKS. */
export function coerceSongAutoChannel(raw: unknown): SongAutoChannel | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const rawTracks = r.tracks;
  const tracks: Record<string, SongAutoTrack> = {};
  if (rawTracks && typeof rawTracks === 'object') {
    let n = 0;
    for (const key of Object.keys(rawTracks as Record<string, unknown>).sort()) {
      if (n >= MAX_SONG_AUTO_TRACKS) break;
      if (!parseAutomationTargetKey(key)) continue; // malformed key → dropped
      const track = coerceSongAutoTrack((rawTracks as Record<string, unknown>)[key]);
      if (!track) continue;
      tracks[key] = track;
      n++;
    }
  }
  return { tracks };
}

/** True iff a key is a valid lane digit '0'..(CLIP_LANES-1). */
function validLaneKey(key: string): boolean {
  const n = Number(key);
  return Number.isInteger(n) && n >= 0 && n < CLIP_LANES;
}

/** Normalize a possibly-garbage Song (patch-load safe). Returns a NEW plain
 *  object (deep, Y-severed copy) that drops garbage + caps sizes. */
export function coerceSongData(raw: unknown): SongData {
  if (!raw || typeof raw !== 'object') return defaultSongData();
  const r = raw as Record<string, unknown>;
  const lengthBeats =
    typeof r.lengthBeats === 'number' && Number.isFinite(r.lengthBeats) && r.lengthBeats >= 0
      ? r.lengthBeats
      : 0;
  const out: SongData = {
    v: SONG_SCHEMA_VERSION,
    lengthBeats,
    loop: r.loop !== false, // default true
  };
  if (r.notes && typeof r.notes === 'object') {
    const notes: Record<string, SongNoteChannel | null> = {};
    for (const [k, v] of Object.entries(r.notes as Record<string, unknown>)) {
      if (!validLaneKey(k)) continue;
      const ch = coerceSongNoteChannel(v);
      if (ch && ch.events.length) notes[k] = ch;
    }
    if (Object.keys(notes).length) out.notes = notes;
  }
  if (r.auto && typeof r.auto === 'object') {
    const auto: Record<string, SongAutoChannel | null> = {};
    for (const [k, v] of Object.entries(r.auto as Record<string, unknown>)) {
      if (!validLaneKey(k)) continue;
      const ch = coerceSongAutoChannel(v);
      if (ch && Object.keys(ch.tracks).length) auto[k] = ch;
    }
    if (Object.keys(auto).length) out.auto = auto;
  }
  const arrangerAuto = coerceSongAutoChannel(r.arrangerAuto);
  if (arrangerAuto && Object.keys(arrangerAuto.tracks).length) out.arrangerAuto = arrangerAuto;
  if (r.arrangerAssign && typeof r.arrangerAssign === 'object') {
    const assign: Record<string, true> = {};
    for (const [k, v] of Object.entries(r.arrangerAssign as Record<string, unknown>)) {
      if (typeof k === 'string' && k.length > 0 && !k.includes('::') && v === true) assign[k] = true;
    }
    if (Object.keys(assign).length) out.arrangerAssign = assign;
  }
  return out;
}

/** Coerce the transient record-arm state, or null. */
export function coerceSongRecState(raw: unknown): SongRecState | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const out: SongRecState = {};
  if (r.armed === true) out.armed = true;
  out.mode = r.mode === 'overdub' ? 'overdub' : 'replace';
  if (typeof r.recorderId === 'number' && Number.isFinite(r.recorderId)) {
    out.recorderId = r.recorderId;
  }
  const laneEnables = (v: unknown): Record<string, true> | undefined => {
    if (!v || typeof v !== 'object') return undefined;
    const m: Record<string, true> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (validLaneKey(k) && val === true) m[k] = true;
    }
    return Object.keys(m).length ? m : undefined;
  };
  const ne = laneEnables(r.noteEnable);
  if (ne) out.noteEnable = ne;
  const ae = laneEnables(r.autoEnable);
  if (ae) out.autoEnable = ae;
  if (r.arrangerEnable === true) out.arrangerEnable = true;
  return out;
}

// ---------------------------------------------------------------------------
// SONG-REC state reads over node.data (`songRec`) — PURE. Kept here (not in
// clip-types.ts) so clip-types never imports clip-song VALUES (no runtime cycle;
// clip-song imports clip-types values). The engine + card consume these.
// ---------------------------------------------------------------------------

/** True when the SONG is ARMED to record (the SYNCED flag every peer reads). */
export function songArmed(data: { songRec?: unknown } | undefined): boolean {
  return coerceSongRecState(data?.songRec)?.armed === true;
}
/** The SONG-REC mode, defaulting to 'replace'. */
export function songRecMode(data: { songRec?: unknown } | undefined): 'replace' | 'overdub' {
  return coerceSongRecState(data?.songRec)?.mode === 'overdub' ? 'overdub' : 'replace';
}
/** SINGLE-WRITER print gate: true ONLY when armed AND this client is the
 *  designated recorder (`recorderId === clientId`) — the analogue of
 *  `isLaneAutomationRecorder`, so exactly one peer commits the print. When no
 *  `recorderId` was stamped (legacy/hand-built), ANY client may record (single
 *  user), so it falls back to `armed`. */
export function isSongRecorder(
  data: { songRec?: unknown } | undefined,
  clientId: number,
): boolean {
  const rec = coerceSongRecState(data?.songRec);
  if (!rec || rec.armed !== true) return false;
  return typeof rec.recorderId === 'number' ? rec.recorderId === clientId : true;
}
/** Whether lane L's NOTE channel is record-enabled this take. Default (no
 *  explicit `noteEnable` map) = ALL channels enabled (arm-all, Deluge-like). */
export function songNoteEnabled(
  data: { songRec?: unknown } | undefined,
  lane: number,
): boolean {
  const rec = coerceSongRecState(data?.songRec);
  if (!rec || rec.armed !== true) return false;
  return rec.noteEnable ? rec.noteEnable[String(lane)] === true : true;
}
/** Whether lane L's AUTOMATION channel is record-enabled (Phase 2). Default =
 *  all enabled. */
export function songAutoEnabled(
  data: { songRec?: unknown } | undefined,
  lane: number,
): boolean {
  const rec = coerceSongRecState(data?.songRec);
  if (!rec || rec.armed !== true) return false;
  return rec.autoEnable ? rec.autoEnable[String(lane)] === true : true;
}
/** Whether the arranger-automation lane is record-enabled (Phase 2). Default
 *  OFF (opt-in — the arranger lane is a deliberate assignment). */
export function songArrangerEnabled(data: { songRec?: unknown } | undefined): boolean {
  const rec = coerceSongRecState(data?.songRec);
  return rec?.armed === true && rec.arrangerEnable === true;
}

// ---------------------------------------------------------------------------
// Container-init (LWW-race hardening) — create the sparse maps at the factory
// load seam, never lazily inside a racy commit path (a concurrent creation
// would last-writer-wins a peer's whole subtree). Mutates IN PLACE.
// ---------------------------------------------------------------------------

/** Ensure `holder.song` + its sparse containers exist (empty). Idempotent;
 *  called from the engine's deterministic per-node load seam. */
export function ensureSongContainers(holder: { song?: SongData | null }): void {
  if (!holder.song || typeof holder.song !== 'object') holder.song = defaultSongData();
  const s = holder.song as SongData;
  if (typeof s.v !== 'number') s.v = SONG_SCHEMA_VERSION;
  if (typeof s.lengthBeats !== 'number' || !Number.isFinite(s.lengthBeats) || s.lengthBeats < 0) {
    s.lengthBeats = 0;
  }
  if (typeof s.loop !== 'boolean') s.loop = true;
  if (!s.notes || typeof s.notes !== 'object') s.notes = {};
  if (!s.auto || typeof s.auto !== 'object') s.auto = {};
  if (!s.arrangerAuto || typeof s.arrangerAuto !== 'object') s.arrangerAuto = { tracks: {} };
  else if (!s.arrangerAuto.tracks || typeof s.arrangerAuto.tracks !== 'object') {
    s.arrangerAuto.tracks = {};
  }
  if (!s.arrangerAssign || typeof s.arrangerAssign !== 'object') s.arrangerAssign = {};
}

// ---------------------------------------------------------------------------
// NOTE record helpers (PRINT) — PURE. The engine buffers plain SongNoteEvents
// during a take and commits them per-channel at song-loop boundaries / punch-out
// ([[cv-modulation-live-store-write-storm]]).
// ---------------------------------------------------------------------------

/** Merge buffered `incoming` note onsets into an `existing` channel's events:
 *  concat + STABLE beat-sort + cap. OVERDUB (keep everything). Returns a NEW
 *  plain array (callers write it into the per-lane key under the Y discipline). */
export function mergeSongNotes(
  existing: readonly SongNoteEvent[],
  incoming: readonly SongNoteEvent[],
): SongNoteEvent[] {
  const merged = existing
    .concat(incoming)
    .map((e) => {
      const out: SongNoteEvent = { beat: e.beat, midi: e.midi };
      if (typeof e.velocity === 'number') out.velocity = e.velocity;
      if (typeof e.lengthBeats === 'number') out.lengthBeats = e.lengthBeats;
      return out;
    })
    .sort(byBeat);
  return merged.slice(0, MAX_SONG_NOTE_EVENTS);
}

// ---------------------------------------------------------------------------
// PLAYBACK queries — PURE.
// ---------------------------------------------------------------------------

/** A lane's printed note channel from a song, or null. */
export function songNoteChannel(
  song: SongData | undefined,
  lane: number,
): SongNoteChannel | null {
  const ch = song?.notes?.[String(lane)];
  return ch && Array.isArray(ch.events) ? ch : null;
}

/**
 * Note onsets whose beat is in the half-open window [fromBeat, toBeat) — the set
 * the playback cursor must FIRE this window. Half-open so an onset exactly on a
 * boundary fires once, not twice across consecutive windows. The caller splits
 * the range across a loop wrap. `events` must be beat-sorted (coerce guarantees).
 */
export function songNotesInRange(
  channel: SongNoteChannel | null | undefined,
  fromBeat: number,
  toBeat: number,
): SongNoteEvent[] {
  if (!channel || toBeat <= fromBeat) return [];
  return channel.events.filter((e) => e.beat >= fromBeat && e.beat < toBeat);
}

/** The furthest event beat across ALL layers (note onsets incl. their length,
 *  auto tracks, arranger lane), or 0 when the song is empty. PURE. */
export function songFurthestBeat(song: SongData | undefined): number {
  let far = 0;
  if (song?.notes) {
    for (const ch of Object.values(song.notes)) {
      if (!ch) continue;
      for (const e of ch.events) far = Math.max(far, e.beat + (e.lengthBeats ?? 0));
    }
  }
  const scanAuto = (chan: SongAutoChannel | undefined | null): void => {
    if (!chan?.tracks) return;
    for (const tr of Object.values(chan.tracks)) {
      const last = tr.events[tr.events.length - 1];
      if (last) far = Math.max(far, last.beat);
    }
  };
  if (song?.auto) for (const ch of Object.values(song.auto)) scanAuto(ch);
  scanAuto(song?.arrangerAuto);
  return far;
}

/**
 * The song's effective loop length in beats: the explicit `lengthBeats` if set
 * (>0), else the furthest event rounded UP to the next bar (`beatsPerBar`) so
 * the loop ends on a bar line. Empty → one bar.
 */
export function songLengthBeats(song: SongData | undefined, beatsPerBar = 4): number {
  if (song && song.lengthBeats > 0) return song.lengthBeats;
  const far = songFurthestBeat(song);
  const bars = Math.max(1, Math.ceil((far + 1e-9) / beatsPerBar) || 1);
  return bars * beatsPerBar;
}

/** True if the song has any printed content (notes, channel auto, arranger auto). */
export function songHasContent(song: SongData | undefined): boolean {
  if (!song) return false;
  if (song.notes) for (const ch of Object.values(song.notes)) if (ch && ch.events.length) return true;
  if (song.auto) for (const ch of Object.values(song.auto)) if (ch && Object.keys(ch.tracks).length) return true;
  if (song.arrangerAuto && Object.keys(song.arrangerAuto.tracks).length) return true;
  return false;
}

/** Total printed note onsets across all channels (card readout). PURE. */
export function songNoteCount(song: SongData | undefined): number {
  let n = 0;
  if (song?.notes) for (const ch of Object.values(song.notes)) if (ch) n += ch.events.length;
  return n;
}

// ---------------------------------------------------------------------------
// AUTOMATION override ownership (Phase 2 playback drive; locked semantics
// shipped + tested now). PURE.
// ---------------------------------------------------------------------------

/** Sentinel channel index meaning "the arranger-automation lane" (it OVERRIDES
 *  every clip/channel automation for a param). */
export const ARRANGER_LANE = -1;

/**
 * SINGLE-DRIVER playback ownership for SONG automation. For each param key at a
 * song tick, exactly one source drives it (no fights), with the owner precedence
 * (a live hand-grab / soft-takeover is resolved ABOVE this, at the engine):
 *   1. `song.arrangerAuto.tracks[key]` if present → the ARRANGER lane wins;
 *   2. else the LOWEST channel that carries it (`song.auto[lane]`).
 * The direct analogue of `autoPlaybackOwners` (clip automation), with the
 * arranger lane always winning the tie. Returns a Map<key, channel|ARRANGER_LANE>.
 *
 * `arrangerKeys` = the arranger lane's track-key set. `channelCarriers[lane]` =
 * that channel's track-key set (null/undefined = channel carries none).
 */
export function songPlaybackOwners(
  arrangerKeys: ReadonlySet<string> | null | undefined,
  channelCarriers: ReadonlyArray<ReadonlySet<string> | null | undefined>,
): Map<string, number> {
  const owners = new Map<string, number>();
  for (let lane = 0; lane < channelCarriers.length; lane++) {
    const keys = channelCarriers[lane];
    if (!keys) continue;
    for (const k of keys) {
      if (!owners.has(k)) owners.set(k, lane); // lowest carrying channel
    }
  }
  if (arrangerKeys) {
    for (const k of arrangerKeys) owners.set(k, ARRANGER_LANE); // arranger OVERRIDES
  }
  return owners;
}

/** Parse a track key to its target (re-export convenience for the engine). */
export function songTrackTarget(key: string): AutomationTarget | null {
  return parseAutomationTargetKey(key);
}
/** Build a track key (re-export convenience for the engine). */
export function songTrackKey(target: AutomationTarget): string {
  return automationTargetKey(target);
}
