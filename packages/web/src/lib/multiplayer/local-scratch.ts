// packages/web/src/lib/multiplayer/local-scratch.ts
//
// STABLE per-device id for the SCRATCH canvas's local IndexedDB replica.
//
// The `/rack` scratch canvas (routes/rack/+page.svelte) has no rackspace id
// and no relay — so before this helper it never attached the `local-replica`
// IndexedDB machinery, and a browser refresh threw the whole patch away (new
// JS context → fresh empty createPatch() doc → nothing to rehydrate from).
// This mints a STABLE id that survives a refresh, so `attachLocalReplica(id,
// ydoc)` mirrors the scratch doc into IndexedDB (`pt-rack-v1-<id>`) and a
// reload seeds it back in milliseconds — the same warm-refresh behaviour
// `/r/[id]` already has, minus the relay.
//
// Keyed BY MODE (dawless | workflow) so the two scratch entry points don't
// cross-load each other's patch (the workflow shell auto-spawns its pinned
// trio; the dawless canvas must stay a blank sandbox). The id is a per-device
// UUID rather than a bare 'local-scratch' constant so its IndexedDB DB name
// can never collide with the real rack id space, and a future "reset scratch"
// affordance can just mint a fresh id.
//
// Persisted in localStorage (must survive a refresh — sessionStorage would
// not) under `pt:local-scratch-id:<mode>`. Graceful degrade: a throwing /
// private-mode localStorage falls back to a per-mount EPHEMERAL id (no crash,
// just no cross-refresh persistence in that hostile environment) — the same
// posture as presence.ts's getOrCreateAnonTabId.

import type { RackMode } from '$lib/graph/rack-mode';

/** localStorage key prefix; one entry per rack mode. */
const LOCAL_SCRATCH_KEY_PREFIX = 'pt:local-scratch-id:';

/** Matches presence.ts's helper (kept local — it isn't exported there): a
 *  UUID when the platform offers one, else a short random fallback. */
function cryptoRandomId(): string {
  const g = globalThis as unknown as { crypto?: Crypto };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  return Math.random().toString(36).slice(2, 14);
}

/** localStorage key for a mode's scratch id. Exported for tests + tooling. */
export function localScratchStorageKey(mode: RackMode): string {
  return `${LOCAL_SCRATCH_KEY_PREFIX}${mode}`;
}

/**
 * Get (or lazily create) the STABLE local-scratch replica id for `mode`.
 *
 *   → 'local-scratch-dawless-<uuid>' | 'local-scratch-workflow-<uuid>'
 *
 * Stable across calls for the same mode (persisted in localStorage), distinct
 * per mode. Falls back to a fresh ephemeral id — never throws — when
 * localStorage is unavailable or throws (private mode / sandboxed contexts):
 * persistence is silently skipped in that environment, the canvas just runs
 * refresh-volatile exactly as it did before this fix.
 */
export function getOrCreateLocalScratchId(mode: RackMode): string {
  const key = localScratchStorageKey(mode);
  try {
    const ls = (globalThis as unknown as { localStorage?: Storage }).localStorage;
    if (ls) {
      const existing = ls.getItem(key);
      if (existing) return existing;
      const fresh = `local-scratch-${mode}-${cryptoRandomId()}`;
      ls.setItem(key, fresh);
      return fresh;
    }
  } catch {
    /* localStorage may throw in private mode / sandboxed iframes; fall through
       to an ephemeral id so the page never crashes. */
  }
  return `local-scratch-${mode}-${cryptoRandomId()}`;
}
