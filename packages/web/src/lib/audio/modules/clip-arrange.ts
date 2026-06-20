// packages/web/src/lib/audio/modules/clip-arrange.ts
//
// SONG MODE / arranger data model + PURE helpers for the `clipplayer` module.
//
// Session view launches clips that loop; ARRANGEMENT view plays a recorded
// timeline of clip launches over song time. Step 1 (this file) is the model: an
// EVENT LOG — "record an arbitrary sequence of clip launches" — that the engine
// records into (each launch, timestamped in song-beats at the moment it APPLIES)
// and replays through the same setLaneActive() launch path. The editable per-lane
// block timeline is a later view DERIVED from this log; the log is the source of
// truth.
//
// Kept engine-free (no AudioContext / no Yjs) so the record/replay math is
// unit-testable in isolation. The factory owns the song-position clock + the
// record hook + the playback cursor; this file only shapes + queries the data.
// (Exports no `*Def`, so the audio-module glob ignores it — but it IS allow-listed
// in module-manifest.ts so the "no Def" scan doesn't warn.)

import { CLIP_LANES, CLIP_SLOTS } from './clip-types';

/** A launch target in the arrangement: a clip SLOT in the lane, or stop it. */
export type ArrangeSlot = number | 'stop';

/** One recorded launch in the song timeline. */
export interface ArrangeEvent {
  /** Song-time (beats from arrangement start) at which the launch APPLIED. */
  beat: number;
  /** Instrument lane 0..CLIP_LANES-1. */
  lane: number;
  /** The slot launched (0..CLIP_SLOTS-1) or 'stop' to stop the lane. */
  slot: ArrangeSlot;
  /** True if this was a mid-clip IMMEDIATE switch (else it landed on a loop
   *  boundary). Recorded so playback reproduces the exact timing performed. */
  immediate?: boolean;
}

/** The arrangement: a chronological event log + loop settings. */
export interface ArrangeData {
  /** Launch events, sorted by beat (stable within equal beats = scene order). */
  events: ArrangeEvent[];
  /** Explicit loop length in beats, or 0 = OPEN (derive from the last event). */
  lengthBeats: number;
  /** Loop the arrangement (true) or play once then stop (false). */
  loop: boolean;
}

/** Which transport drives clip playback. */
export type ClipPlayMode = 'session' | 'arrangement';

/** A fresh, empty arrangement (open length, looping). */
export function defaultArrangeData(): ArrangeData {
  return { events: [], lengthBeats: 0, loop: true };
}

/** True iff a slot value is a valid launch target (0..CLIP_SLOTS-1 or 'stop'). */
function validSlot(s: unknown): s is ArrangeSlot {
  return s === 'stop' || (typeof s === 'number' && Number.isInteger(s) && s >= 0 && s < CLIP_SLOTS);
}

/** Normalize one possibly-garbage event, or null if unusable. */
export function coerceArrangeEvent(raw: unknown): ArrangeEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const beat = r.beat;
  const lane = r.lane;
  if (typeof beat !== 'number' || !Number.isFinite(beat) || beat < 0) return null;
  if (typeof lane !== 'number' || !Number.isInteger(lane) || lane < 0 || lane >= CLIP_LANES) return null;
  if (!validSlot(r.slot)) return null;
  const ev: ArrangeEvent = { beat, lane, slot: r.slot as ArrangeSlot };
  if (r.immediate === true) ev.immediate = true;
  return ev;
}

/** Normalize a possibly-garbage arrangement (SyncedStore / patch-load safe). */
export function coerceArrangeData(raw: unknown): ArrangeData {
  if (!raw || typeof raw !== 'object') return defaultArrangeData();
  const r = raw as Record<string, unknown>;
  const events = Array.isArray(r.events)
    ? (r.events.map(coerceArrangeEvent).filter(Boolean) as ArrangeEvent[]).sort(byBeat)
    : [];
  const lengthBeats =
    typeof r.lengthBeats === 'number' && Number.isFinite(r.lengthBeats) && r.lengthBeats >= 0
      ? r.lengthBeats
      : 0;
  const loop = r.loop !== false; // default true
  return { events, lengthBeats, loop };
}

/** Stable chronological comparator (equal beats keep insertion order via index). */
function byBeat(a: ArrangeEvent, b: ArrangeEvent): number {
  return a.beat - b.beat;
}

/**
 * Append a launch to the log, keeping it sorted by beat (stable — a later
 * recording at the same beat lands after earlier ones, so a scene's lane order
 * is preserved). Returns a NEW ArrangeData (callers mutate node.data in place at
 * the call site under the Yjs discipline).
 */
export function recordEvent(data: ArrangeData, ev: ArrangeEvent): ArrangeData {
  // Insert at the first index whose beat is strictly greater (stable append
  // within equal beats). Linear scan from the end — recordings arrive in
  // near-chronological order, so this is O(1) amortized.
  const events = data.events.slice();
  let i = events.length;
  while (i > 0 && events[i - 1].beat > ev.beat) i--;
  events.splice(i, 0, { ...ev });
  return { ...data, events };
}

/** Empty the event log (keep loop settings). Returns NEW data. */
export function clearArrange(data: ArrangeData): ArrangeData {
  return { ...data, events: [] };
}

/**
 * The arrangement's effective loop length in beats: the explicit `lengthBeats`
 * if set (>0), else derived from the last event rounded UP to the next bar
 * (`beatsPerBar`, default 4) so the loop ends on a bar line. Empty → one bar.
 */
export function arrangeLengthBeats(data: ArrangeData, beatsPerBar = 4): number {
  if (data.lengthBeats > 0) return data.lengthBeats;
  const last = data.events.length ? data.events[data.events.length - 1].beat : 0;
  const bars = Math.max(1, Math.ceil((last + 1e-9) / beatsPerBar) || 1);
  return bars * beatsPerBar;
}

/**
 * Events whose beat is in the half-open window [fromBeat, toBeat) — the set the
 * playback cursor must FIRE this tick as song-time advances from `fromBeat` to
 * `toBeat`. Half-open so an event exactly on a tick boundary fires once, not
 * twice across consecutive ticks. The caller splits the range across a loop wrap.
 */
export function eventsInRange(data: ArrangeData, fromBeat: number, toBeat: number): ArrangeEvent[] {
  if (toBeat <= fromBeat) return [];
  return data.events.filter((e) => e.beat >= fromBeat && e.beat < toBeat);
}

/** True if the arrangement has at least one recorded launch. */
export function hasArrangement(data: ArrangeData | undefined): boolean {
  return !!data && data.events.length > 0;
}

// ---------------------------------------------------------------------------
// SONG VIEW (Phase 2) — block derivation + edit ops, all PURE.
//
// The event log is the source of truth; the editor renders + mutates a BLOCK
// view DERIVED from it. A launch event starts a block that plays until the
// lane's next event (or the arrangement end); a 'stop' event ends the block
// (its silent span emits no block). Edits map straight back to the log:
//   move block  → change the launch event's beat
//   swap clip   → change the event's slot
//   delete block→ remove the event (the prior clip extends; or insert 'stop')
// ---------------------------------------------------------------------------

/** A contiguous span in one lane where a single clip plays (for the timeline). */
export interface ArrangeBlock {
  lane: number;
  startBeat: number;
  endBeat: number; // exclusive
  slot: number; // the clip slot (blocks are only emitted for launches, not stops)
}

/** Beat-equality tolerance for matching a block back to its launch event. */
const BEAT_EPS = 1e-6;

/** Per-lane blocks for the song view. Each launch runs until the lane's next
 *  event (or `end` = the arrangement length); 'stop' events end a block. */
export function arrangeBlocks(data: ArrangeData, lengthBeats?: number): ArrangeBlock[] {
  const end = lengthBeats ?? arrangeLengthBeats(data);
  const blocks: ArrangeBlock[] = [];
  for (let lane = 0; lane < CLIP_LANES; lane++) {
    const evs = data.events.filter((e) => e.lane === lane).sort((a, b) => a.beat - b.beat);
    for (let i = 0; i < evs.length; i++) {
      const e = evs[i];
      if (e.slot === 'stop') continue; // silence span — no block
      const nextBeat = i + 1 < evs.length ? evs[i + 1].beat : end;
      const startBeat = Math.min(e.beat, end);
      const endBeat = Math.max(startBeat, Math.min(nextBeat, end));
      blocks.push({ lane, startBeat, endBeat, slot: e.slot });
    }
  }
  return blocks;
}

/** Index of the launch event for the block a lane starts at `startBeat`. */
function eventIndexAt(data: ArrangeData, lane: number, startBeat: number): number {
  return data.events.findIndex(
    (e) => e.lane === lane && Math.abs(e.beat - startBeat) < BEAT_EPS,
  );
}

/** Move a block's launch to a new beat (clamped ≥ 0). Re-sorts. Returns NEW. */
export function moveBlock(
  data: ArrangeData,
  lane: number,
  startBeat: number,
  newStartBeat: number,
): ArrangeData {
  const i = eventIndexAt(data, lane, startBeat);
  if (i < 0) return data;
  const events = data.events.map((e, j) =>
    j === i ? { ...e, beat: Math.max(0, newStartBeat) } : e,
  );
  events.sort((a, b) => a.beat - b.beat);
  return { ...data, events };
}

/** Change which clip a block launches. Returns NEW. */
export function setBlockSlot(
  data: ArrangeData,
  lane: number,
  startBeat: number,
  newSlot: number,
): ArrangeData {
  const i = eventIndexAt(data, lane, startBeat);
  if (i < 0) return data;
  const events = data.events.map((e, j) => (j === i ? { ...e, slot: newSlot } : e));
  return { ...data, events };
}

/** Remove a block's launch event (the prior clip in that lane extends over it).
 *  Returns NEW. */
export function deleteBlock(data: ArrangeData, lane: number, startBeat: number): ArrangeData {
  const i = eventIndexAt(data, lane, startBeat);
  if (i < 0) return data;
  return { ...data, events: data.events.filter((_, j) => j !== i) };
}

/** Set the explicit loop length (0 = open/auto). Returns NEW. */
export function setArrangeLength(data: ArrangeData, lengthBeats: number): ArrangeData {
  return { ...data, lengthBeats: Math.max(0, lengthBeats) };
}

/** Snap a beat to a grid (snapTo>0, in beats), clamped ≥0. snapTo<=0 ⇒ no snap
 *  (just clamp ≥0). Used by the drag-to-move flow: bar-snap (4) by default, a
 *  fine mode = beat-snap (1). */
export function snapBeat(beat: number, snapTo: number): number {
  if (snapTo <= 0) return Math.max(0, beat);
  return Math.max(0, Math.round(beat / snapTo) * snapTo);
}
