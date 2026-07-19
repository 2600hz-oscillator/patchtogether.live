// packages/web/src/lib/audio/modules/clip-reconcile.ts
//
// Per-machine, IN-MEMORY SCHEDULER-RECONCILE channel for the clip player — the
// STALE-NOTE FIX seam (redesign §3.1). Mirrors clip-audition.ts: the launchpad
// binding (a global `.svelte.ts` with no engine) cannot cut a sounding voice
// directly, so when a clip mutation REMOVES notes from a clip that is currently
// PLAYING, it PUSHES a reconcile request keyed by nodeId; the clipplayer factory
// `tick` DRAINS it and immediately cuts that lane's sounding + in-lookahead
// scheduled audio, then re-schedules from the FRESH (mutated) clip — so an
// erased note stops NOW instead of ringing out the ~200 ms lookahead (or, in the
// old replace path, sounding a full loop later).
//
// WHY (owner problem 3): a record-time clip edit mutated ONLY the Y.Doc; nothing
// cancelled the voices the scheduler had already committed up to LOOKAHEAD_S
// ahead. This is the missing side effect — the reconcile publish. Render/timing
// state, never a Y.Doc write. Cleared on dispose.

/** A request to reconcile a lane's scheduled audio to its freshly-mutated clip
 *  (an erase / note-removal on a playing clip). Lane-scoped: the drain cuts the
 *  sounding + queued voices on that lane and re-emits from the fresh clip. */
export interface ReconcileEvent {
  /** Instrument lane (0..CLIP_LANES-1) whose playing clip was just mutated. */
  lane: number;
}

const queues = new Map<string, ReconcileEvent[]>();

/** Queue a lane reconcile for `nodeId` (the binding calls this after removing
 *  notes from a PLAYING clip). Deduped per lane — several removals in one frame
 *  collapse to a single reconcile. */
export function pushReconcile(nodeId: string, ev: ReconcileEvent): void {
  let q = queues.get(nodeId);
  if (!q) {
    q = [];
    queues.set(nodeId, q);
  }
  if (!q.some((e) => e.lane === ev.lane)) q.push(ev);
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
