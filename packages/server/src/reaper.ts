// packages/server/src/reaper.ts
//
// Slot-leak recovery sweep. Slots are acquired in onAuthenticate and
// released in onDisconnect (index.ts), but onDisconnect is NOT guaranteed
// to fire: a socket that dies without a clean WS close (crashed tab,
// network partition, OOM, or — the one that bit dev — a Fly machine killed
// mid-connection on autostop) leaves its slot held forever. Held slots
// never drop on their own, so a rack drifts up to 4/4 with ghost slots and
// every new joiner gets reject(full) — the "stuck rack that never lets
// anyone in" the operator reported.
//
// The fix is a periodic reconcile against Hocuspocus's OWN live-connection
// source of truth: each Document tracks its real WebSocket connections
// (Document.getConnections() → Connection.socketId). Any slot whose
// socketId is no longer a live connection on that doc is a leak and gets
// reaped. This makes a stuck rack self-heal within one sweep interval
// instead of staying jammed until a manual server restart.

import type { SlotTracker } from './capacity.js';

/** The bits of the Hocuspocus server we read during a sweep. Kept as a
 *  minimal structural type so the reaper is unit-testable with a fake. */
export interface LiveConnectionSource {
  documents: Map<string, { getConnections(): Array<{ socketId: string }> }>;
}

export const REAPER_INTERVAL_MS = 30_000;

/**
 * Reconcile every doc the slot tracker knows about against the live
 * connections Hocuspocus reports. Returns the total number of leaked
 * slots reaped this pass (0 in the steady state). Logs per-doc only when
 * it actually reaps something, so a healthy server stays quiet.
 */
export function sweepLeakedSlots(
  slots: SlotTracker,
  server: LiveConnectionSource,
  log: (msg: string) => void = () => {},
): number {
  let totalReaped = 0;
  for (const documentName of slots.docs()) {
    const doc = server.documents.get(documentName);
    // No live Document at all → every slot for it is a leak (reconcile
    // against an empty set drops them all).
    const liveSocketIds = doc ? doc.getConnections().map((c) => c.socketId) : [];
    const reaped = slots.reconcile(documentName, liveSocketIds);
    if (reaped > 0) {
      totalReaped += reaped;
      log(
        `[hocuspocus] reaped ${reaped} leaked slot(s): doc=${documentName} ` +
          `(now ${slots.size(documentName)}/4)`,
      );
    }
  }
  return totalReaped;
}

/**
 * Start the periodic sweep. Returns a stop() handle (used on shutdown so
 * the interval doesn't keep the process alive during a clean drain).
 */
export function startReaper(
  slots: SlotTracker,
  server: LiveConnectionSource,
  opts: {
    intervalMs?: number;
    log?: (msg: string) => void;
    setIntervalFn?: typeof setInterval;
    clearIntervalFn?: typeof clearInterval;
  } = {},
): { stop: () => void } {
  const intervalMs = opts.intervalMs ?? REAPER_INTERVAL_MS;
  const setIntervalFn = opts.setIntervalFn ?? setInterval;
  const clearIntervalFn = opts.clearIntervalFn ?? clearInterval;
  const timer = setIntervalFn(() => {
    sweepLeakedSlots(slots, server, opts.log);
  }, intervalMs);
  // Don't let the sweep keep the event loop alive on its own.
  (timer as { unref?: () => void }).unref?.();
  return {
    stop: () => clearIntervalFn(timer),
  };
}
