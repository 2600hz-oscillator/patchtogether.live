// packages/server/src/snapshot-config.ts
//
// Snapshot persistence knobs for Hocuspocus's onStoreDocument debouncer.
// See ../.myrobots/plans/b1-snapshot-timing.md for the full reasoning.
//
//   debounce      — wait this long after the last update before persisting.
//                   Hocuspocus default 2000ms is correct for our edit rate;
//                   restated explicitly so the value isn't drifting silently
//                   with library upgrades.
//   maxDebounce   — upper bound on staleness while edits keep arriving.
//                   Library default is 10s. We tighten to 5s so a fully cold
//                   reload (no other client connected, host already gone)
//                   sees at most 5s of pre-flush state.
//   unloadImmediately — when the LAST connection drops, fire the pending
//                   onStoreDocument synchronously instead of waiting out
//                   the remaining debounce. Default true; restated for
//                   intent. This is what guarantees a "host closes window"
//                   doesn't lose the last 2s of edits.
//
// Lives in its own file (separate from index.ts) so the unit test can
// import these values without triggering the Server.listen() side effects
// that index.ts performs at module load.

export const SNAPSHOT_PERSISTENCE_CONFIG = {
  debounce: 2000,
  maxDebounce: 5000,
  unloadImmediately: true,
} as const;
