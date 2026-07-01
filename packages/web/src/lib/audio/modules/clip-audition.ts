// packages/web/src/lib/audio/modules/clip-audition.ts
//
// Per-machine, IN-MEMORY LIVE-AUDITION channel for the clip player — the bridge
// that lets the dual-Launchpad KEYS keyboard SOUND its notes immediately, with
// or without recording (design: .myrobots/plans/clip-record-note-mode-2026-07-01.md
// P0/P3). It mirrors clip-playhead.ts exactly: the launchpad binding is a global
// `.svelte.ts` singleton with NO engine-context, so it CANNOT call the factory
// handle directly. Instead it PUSHES note on/off events into an in-memory queue
// keyed by nodeId; the clipplayer factory `tick` DRAINS the queue each tick and
// schedules the notes on the lane's poly output — drained BEFORE the
// `if (!running) return` transport gate so keys sound even with the transport
// STOPPED. This is render/performance state, never a Y.Doc write (the
// cv-modulation-write-storm rule). Cleared on factory dispose.

/** A single live-audition note edge from the KEYS keyboard. */
export interface AuditionEvent {
  /** Instrument lane (0..CLIP_LANES-1) the note plays on (the KEYS clip's lane). */
  lane: number;
  /** MIDI note int (c4 = 60). */
  midi: number;
  /** Note-on velocity 0..127 (ignored for note-off). */
  velocity: number;
  /** true = note-on (start sounding), false = note-off (stop sounding). */
  on: boolean;
}

const queues = new Map<string, AuditionEvent[]>();

/** Queue a live-audition note edge for node `nodeId` (the binding calls this on
 *  every KEYS keypress/release). The factory tick drains it. */
export function pushAudition(nodeId: string, ev: AuditionEvent): void {
  let q = queues.get(nodeId);
  if (!q) {
    q = [];
    queues.set(nodeId, q);
  }
  q.push(ev);
}

/** Drain (and clear) all pending audition events for `nodeId`, in push order.
 *  Returns an empty array when nothing is queued. The factory tick calls this. */
export function drainAudition(nodeId: string): AuditionEvent[] {
  const q = queues.get(nodeId);
  if (!q || q.length === 0) return [];
  const out = q.slice();
  q.length = 0;
  return out;
}

/** Drop all audition state for a node (call on factory dispose). */
export function clearAudition(nodeId: string): void {
  queues.delete(nodeId);
}
