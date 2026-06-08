// packages/server/src/boot-id.ts
//
// A boot id identifies one relay process lifetime. A fresh boot gets a new id,
// so a downstream watcher (the /metrics scraper, log-based alerting) can detect
// "the relay restarted" by an id flip — and, crucially, correlate the structured
// uncaught-exception / unhandled-rejection log lines (see relay-error-handlers.ts)
// with the conn/room/memory snapshot served on /health + /metrics
// (see http-introspection.ts). Both reuse the SAME id for that correlation.

/** Mint a short boot id. The deploy doesn't need cryptographic uniqueness, just
 *  enough variation that a restart is obvious in the scrape / log stream. */
export function newBootId(now: () => number = Date.now): string {
  return `${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** The boot id for THIS relay process. Generated once at module load and shared
 *  by every subsystem that wants to tag its output with the process lifetime. */
export const RELAY_BOOT_ID = newBootId();
