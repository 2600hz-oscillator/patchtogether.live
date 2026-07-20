// packages/web/src/lib/audio/modules/clip-reconcile.ts
//
// Per-machine, IN-MEMORY SCHEDULER-RECONCILE channel for the clip player — the
// STALE-NOTE FIX seam (redesign §3.1). Mirrors clip-audition.ts: an editor (the
// Launchpad binding OR the on-screen card, both global singletons with no
// engine) cannot cut a sounding voice directly, so when a clip mutation REMOVES
// notes from a clip that is currently PLAYING, it PUSHES a reconcile request
// keyed by nodeId; the clipplayer factory `tick` DRAINS it and immediately cuts
// the ERASED note's sounding + in-lookahead scheduled audio, then re-schedules
// from the FRESH (mutated) clip — so an erased note stops NOW instead of ringing
// out the ~200 ms lookahead (or, in the old replace path, a full loop later).
//
// The reconcile carries the ERASED STEPS so the engine can cut ONLY the erased
// note's voice at the audible playhead (leaving a still-gating KEPT note alone),
// rather than blanket-silencing the lane.
//
// WHY (owner problem 3): a record-time clip edit mutated ONLY the Y.Doc; nothing
// cancelled the voices the scheduler had already committed up to LOOKAHEAD_S
// ahead. This is the missing side effect — the reconcile publish. Render/timing
// state, never a Y.Doc write. Cleared on dispose.

import {
  laneOf,
  slotOf,
  lanePlaying,
  type NoteClipRecord,
  type ClipPlayerData,
} from './clip-types';

/** A request to reconcile a lane's scheduled audio to its freshly-mutated clip
 *  (an erase / note-removal on a playing clip). Lane-scoped: the drain cuts the
 *  removed notes' sounding + queued voices on that lane and re-emits from the
 *  fresh clip. `steps` = the steps whose onsets were removed, so the engine only
 *  force-cuts the currently-sounding voice when the AUDIBLE step is one of them
 *  (a purely-future erase leaves the current note gating). */
export interface ReconcileEvent {
  /** Instrument lane (0..CLIP_LANES-1) whose playing clip was just mutated. */
  lane: number;
  /** The steps whose onsets were removed (deduped, unordered). */
  steps: number[];
}

const queues = new Map<string, ReconcileEvent[]>();

/** Queue a lane reconcile for `nodeId` (the binding calls this after removing
 *  notes from a PLAYING clip). MERGED per lane — several removals in one frame
 *  collapse to a single reconcile whose `steps` is the UNION. */
export function pushReconcile(nodeId: string, ev: ReconcileEvent): void {
  let q = queues.get(nodeId);
  if (!q) {
    q = [];
    queues.set(nodeId, q);
  }
  const existing = q.find((e) => e.lane === ev.lane);
  if (existing) {
    for (const s of ev.steps) if (!existing.steps.includes(s)) existing.steps.push(s);
  } else {
    q.push({ lane: ev.lane, steps: [...ev.steps] });
  }
}

/** Drain (and clear) all pending reconcile requests for `nodeId`. The factory
 *  tick calls this once per tick, before the emit loop. */
export function drainReconcile(nodeId: string): ReconcileEvent[] {
  const q = queues.get(nodeId);
  if (!q || q.length === 0) return [];
  const out = q.slice();
  q.length = 0;
  return out;
}

/** Drop all reconcile state for a node (call on factory dispose). */
export function clearReconcile(nodeId: string): void {
  queues.delete(nodeId);
}

/**
 * SHARED removal-detect + publish (redesign §3.1) — the ONE place both the
 * Launchpad binding and the on-screen card call after a clip write, so the
 * stale-note reconcile can't be wired on one editor and forgotten on the other.
 *
 * Uses a SET DIFFERENCE (notes in `prev` absent from `next`, matched by
 * step+midi), NOT a length compare — so a poly voice-STEAL that keeps the count
 * the same (drop one pitch, add another on the same step) is still detected as a
 * removal of the dropped pitch. Publishes a reconcile ONLY when the edited clip
 * is the one currently PLAYING on its lane (else nothing is scheduled to cut).
 * PURE except the queue push.
 */
export function reconcileClipRemoval(
  nodeId: string,
  prev: NoteClipRecord,
  next: NoteClipRecord,
  index: number,
  data: ClipPlayerData | undefined,
): void {
  if (next === prev) return;
  const removed = prev.steps.filter(
    (p) => !next.steps.some((n) => n.step === p.step && n.midi === p.midi),
  );
  if (removed.length === 0) return; // pure add / no-op — nothing to cut
  const lane = laneOf(index);
  if (lanePlaying(data, lane) !== slotOf(index)) return; // not the playing clip
  const steps = [...new Set(removed.map((r) => r.step))];
  pushReconcile(nodeId, { lane, steps });
}
