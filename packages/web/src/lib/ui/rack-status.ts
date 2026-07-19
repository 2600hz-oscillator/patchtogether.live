// packages/web/src/lib/ui/rack-status.ts
//
// PURE state helpers for the /r/[id] durability affordances (persistence-
// hardening P1 + P2). Kept framework-free + side-effect-free so the timing
// logic is unit-testable without a browser — the Svelte page owns the
// signals (replica seed, provider synced/unsynced, elapsed time) and feeds
// booleans in here.
//
//   P1 — computeRackStatus: the "restoring / ready / offline" banner state.
//   P2 — computeSaveStatus + shouldPromptUnsaved: the "saving…/all changes
//        saved" chip + the strict beforeunload guard predicate.

// ---------------------------------------------------------------------------
// P1 — restoring / offline banner
// ---------------------------------------------------------------------------

export type RackStatus = 'restoring' | 'ready' | 'offline';

export interface RackStatusInputs {
  /** A RESTORABLE local copy was applied to the doc — i.e. the IndexedDB
   *  replica seed resolved to `'seeded'` (prior data existed and was
   *  merged in). A first-visit `'fresh'` / `'disabled'` / `'cleared-corrupt'`
   *  replica is NOT "seeded" here: there is no local copy to restore yet, so
   *  the page must keep waiting on the relay (this is exactly the cold-load-
   *  with-slow-relay case the banner exists for). */
  seeded: boolean;
  /** The relay provider has completed its initial sync (`provider.synced`).
   *  Latch this true on the first `'synced'` — a later reconnect blip must
   *  not drop us back to "restoring". */
  synced: boolean;
  /** Milliseconds elapsed since the page began waiting. Stays 0 until the
   *  offline timeout fires, at which point the page bumps it to (at least)
   *  `offlineAfterMs`. */
  elapsedMs: number;
}

/** Default grace before an un-seeded, un-synced rack is declared offline. */
export const DEFAULT_OFFLINE_AFTER_MS = 4000;

/**
 * Pure state machine for the rack restore/offline banner.
 *
 *   ready     — we have SOMETHING to work with: a local copy was restored
 *               (`seeded`) OR the relay finished syncing (`synced`).
 *   restoring — neither yet, and we're still inside the grace window.
 *   offline   — neither yet, and the grace window has elapsed → the relay
 *               is slow/down; surface the non-blocking "working from your
 *               local copy" hint (editing stays enabled throughout).
 *
 * `ready` deliberately wins over the timeout: once seeded-or-synced we are
 * never "offline", regardless of elapsed time. And because `restoring`
 * requires `!seeded && !synced`, a warm refresh (replica seeds in ms) can
 * never LATCH into restoring.
 */
export function computeRackStatus(
  { seeded, synced, elapsedMs }: RackStatusInputs,
  offlineAfterMs: number = DEFAULT_OFFLINE_AFTER_MS,
): RackStatus {
  if (seeded || synced) return 'ready';
  if (elapsedMs >= offlineAfterMs) return 'offline';
  return 'restoring';
}

// ---------------------------------------------------------------------------
// P2 — saving indicator + strict unsaved guard
// ---------------------------------------------------------------------------

export type SaveStatus = 'saving' | 'saved' | 'idle';

export interface SaveGauge {
  /** `provider.hasUnsyncedChanges` — true while any local update is still
   *  un-ACKed by the relay (a true unacked-update gauge; see
   *  packages/server/src/reconnect-replay.test.ts). */
  hasUnsyncedChanges: boolean;
  /** `provider.synced` — the initial sync completed and the unacked gauge
   *  has drained to zero at least once. */
  synced: boolean;
}

/**
 * Pure mapping for the "Saving… / All changes saved" chip.
 *   saving — there are un-ACKed local edits in flight.
 *   saved  — synced with nothing outstanding.
 *   idle   — not synced yet and nothing outstanding (initial connect); the
 *            restore/offline banner covers this phase, so the chip stays quiet.
 */
export function computeSaveStatus({ hasUnsyncedChanges, synced }: SaveGauge): SaveStatus {
  if (hasUnsyncedChanges) return 'saving';
  if (synced) return 'saved';
  return 'idle';
}

/**
 * STRICT predicate for the `beforeunload` prompt: prompt ONLY when there are
 * genuinely un-synced local changes. We never nag a fully-synced user (an
 * over-firing beforeunload is user-hostile), so this is an exact-`true` gate.
 */
export function shouldPromptUnsaved({
  hasUnsyncedChanges,
}: {
  hasUnsyncedChanges: boolean;
}): boolean {
  return hasUnsyncedChanges === true;
}
