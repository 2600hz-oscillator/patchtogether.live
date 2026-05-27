// packages/web/src/lib/doom/doom-instrumentation.ts
//
// Monotonic, remount-proof instrumentation counters for the DOOM card's
// storm-throttle guard (the multiplayer-hang probe).
//
// WHY THIS EXISTS (the negative-counter bug): the probe measures the
// awareness-update flood vs. the heavy election/roster recompute by taking a
// BASELINE counter reading, driving sustained play, then reading the counters
// again and subtracting (end - baseline). When the counters lived as plain
// per-instance closure variables inside DoomCard.svelte, a mid-run REMOUNT of
// the card (a hot-join relaunch re-runs G_InitNew + can recreate the Svelte
// component; SvelteFlow also remounts nodes on certain canvas churn) reset them
// to 0. After such a reset `end < baseline`, so the probe's subtraction came
// out NEGATIVE (the observed ownerAwarenessUpdates=-14). The numbers were never
// wrong per-second — only the aggregate, because the baseline was captured
// against a counter that later reset.
//
// FIX: keep the counters in module scope keyed by node id so they SURVIVE a
// component remount (the same node id is reused), and only ever increment. The
// card bumps them; the debug hook (`__doomCards[id].getState()`) reads them.
// Module-global is the right scope: there is exactly ONE DOOM node per rack
// (maxInstances:1), and a node's identity is its id.

interface DoomCounters {
  /** Total awareness `update` events the card's observer has seen. */
  awarenessUpdateCount: number;
  /** Times the EXPENSIVE election/roster/slot recompute actually ran (gated
   *  behind the awareness-signature filter — should stay a small fraction of
   *  awarenessUpdateCount under a per-tic ticcmd flood). */
  electionRecomputeCount: number;
  /** Times THIS peer actually WROTE its ticcmd to awareness
   *  (setLocalStateField) — i.e. AFTER the netcode's only-on-change
   *  suppression. This is the REAL awareness-write rate the storm hypothesis
   *  depends on. Holding a STEADY movement key produces a constant ticcmd which
   *  is suppressed, so this rises only when the ticcmd actually CHANGES (turning,
   *  alternating movement, fire on/off) — the measurement that tells us whether
   *  per-tic ticcmds genuinely flood at the ~35 Hz tic rate or not. */
  ticcmdWriteCount: number;
}

const COUNTERS = new Map<string, DoomCounters>();

function ensure(id: string): DoomCounters {
  let c = COUNTERS.get(id);
  if (!c) {
    c = { awarenessUpdateCount: 0, electionRecomputeCount: 0, ticcmdWriteCount: 0 };
    COUNTERS.set(id, c);
  }
  return c;
}

/** Increment the awareness-update counter for this node. Monotonic; survives
 *  card remounts (the counter is keyed by the stable node id). */
export function bumpAwarenessUpdate(id: string): number {
  const c = ensure(id);
  return ++c.awarenessUpdateCount;
}

/** Increment the election-recompute counter for this node. */
export function bumpElectionRecompute(id: string): number {
  const c = ensure(id);
  return ++c.electionRecomputeCount;
}

/** Increment the ticcmd-WRITE counter for this node (called by the netcode only
 *  when it ACTUALLY writes a changed ticcmd to awareness, after suppression). */
export function bumpTiccmdWrite(id: string): number {
  const c = ensure(id);
  return ++c.ticcmdWriteCount;
}

/** Snapshot the current (monotonic) counters for this node. */
export function readCounters(id: string): DoomCounters {
  const c = ensure(id);
  return { ...c };
}

/** Test-only: clear all counters (so unit tests don't bleed into each other). */
export function __resetDoomCounters(): void {
  COUNTERS.clear();
}
