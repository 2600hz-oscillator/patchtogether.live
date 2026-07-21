// packages/web/src/lib/storage/local-scratch.ts
//
// STABLE per-device id for the SCRATCH canvas's local IndexedDB replica.
//
// Lives under lib/storage (NOT lib/multiplayer) on purpose: this is a
// client-only, single-user localStorage id helper — it has nothing to do with
// collaboration/sync. lib/multiplayer is a whole-directory collab-attest basis
// root (scripts/collab-attest-lib.ts COLLAB_DIR_ROOTS), so putting a non-collab
// file there would falsely force a collab re-attest on every edit. Keep it out.
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

/** localStorage key holding the mode of the MOST RECENTLY opened scratch rack.
 *  Powers the landing "Return to last rack" card (which mode to reopen). Kept
 *  separate from the per-mode id keys so a single read tells us "last kind". */
const LAST_SCRATCH_MODE_KEY = 'pt:last-scratch-mode';

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

/**
 * Read the stored scratch id for `mode` WITHOUT minting one when absent — the
 * read-only counterpart to getOrCreateLocalScratchId. Returns null when no id
 * has been persisted yet (the user has never opened that mode's scratch) or
 * localStorage is unavailable. Used by "Return to last rack" to test for a
 * prior rack without side-effecting a brand-new id into existence.
 */
export function peekLocalScratchId(mode: RackMode): string | null {
  try {
    const ls = (globalThis as unknown as { localStorage?: Storage }).localStorage;
    return ls ? ls.getItem(localScratchStorageKey(mode)) : null;
  } catch {
    return null;
  }
}

/**
 * Mint a FRESH scratch id for `mode` and persist it, REPLACING any existing
 * one. This is the "File → New rack" (logged-out) primitive: a new id ⇒ a new
 * replica DB name ⇒ the reloaded scratch canvas rehydrates an EMPTY doc instead
 * of the old one (the previous id's IndexedDB rows are simply orphaned — the
 * documented "reset scratch" affordance this file's header anticipated). Falls
 * back to a returned-but-unpersisted ephemeral id when localStorage throws.
 */
export function resetLocalScratchId(mode: RackMode): string {
  const fresh = `local-scratch-${mode}-${cryptoRandomId()}`;
  try {
    (globalThis as unknown as { localStorage?: Storage }).localStorage?.setItem(
      localScratchStorageKey(mode),
      fresh,
    );
  } catch {
    /* private mode / sandboxed → ephemeral, exactly like getOrCreate. */
  }
  return fresh;
}

/**
 * Record `mode` as the most-recently-opened scratch kind (called when the
 * scratch canvas mounts). Best-effort — a throwing/absent localStorage is a
 * silent no-op (the "Return to last rack" card just won't offer that session).
 */
export function recordLastScratchMode(mode: RackMode): void {
  try {
    (globalThis as unknown as { localStorage?: Storage }).localStorage?.setItem(
      LAST_SCRATCH_MODE_KEY,
      mode,
    );
  } catch {
    /* ignore — the card degrades to hidden, never crashes. */
  }
}

/** Read the most-recently-opened scratch mode, or null when none/garbage. */
export function readLastScratchMode(): RackMode | null {
  try {
    const v = (globalThis as unknown as { localStorage?: Storage }).localStorage?.getItem(
      LAST_SCRATCH_MODE_KEY,
    );
    return v === 'workflow' || v === 'dawless' ? v : null;
  } catch {
    return null;
  }
}

/** A prior scratch rack the landing can offer to reopen. */
export interface LastScratchRack {
  /** The rack kind (drives which scratch route to reopen). */
  mode: RackMode;
  /** The persisted per-device scratch id (⇒ the replica DB name). */
  id: string;
  /** The route to navigate to — preserves `?mode=` for workflow. */
  href: string;
}

/**
 * Resolve the last scratch rack from localStorage ALONE (sync, no IndexedDB):
 * the recorded last mode plus a persisted id for that mode. Returns null when
 * there is no prior session. Callers that need the stricter "actually persisted
 * in IndexedDB" guarantee additionally probe `replicaDbName(id)` — this is the
 * cheap first gate that also yields the id + reopen href.
 */
export function readLastScratchRack(): LastScratchRack | null {
  const mode = readLastScratchMode();
  if (!mode) return null;
  const id = peekLocalScratchId(mode);
  if (!id) return null;
  return { mode, id, href: mode === 'workflow' ? '/rack?mode=workflow' : '/rack' };
}

/** Replica DB-name prefix — MIRRORS lib/multiplayer/local-replica.ts
 *  REPLICA_DB_PREFIX. Duplicated (not imported) on purpose: local-replica pulls
 *  in y-indexeddb + yjs, and this module is imported by the STATIC landing page
 *  — importing the constant from there would drag that whole dependency into
 *  the landing chunk. The scratch-persist e2e pins the same literal, so a drift
 *  between the two surfaces as a test failure. */
const REPLICA_DB_PREFIX = 'pt-rack-v1-';

/** The IndexedDB replica DB name for a scratch id (mirror of replicaDbName). */
export function scratchReplicaDbName(id: string): string {
  return `${REPLICA_DB_PREFIX}${id}`;
}

/**
 * Resolve the last scratch rack AND verify it is actually persisted in
 * IndexedDB (the "rack in memory" the landing card gates on). Async because it
 * enumerates `indexedDB.databases()`. Returns null when there's no prior
 * session OR its replica DB isn't present. Degrades to the localStorage-only
 * signal (returns the sync result) when `indexedDB.databases()` is unavailable
 * — older engines can't enumerate, so we trust the recorded session.
 */
export async function resolveLastScratchRack(): Promise<LastScratchRack | null> {
  const last = readLastScratchRack();
  if (!last) return null;
  try {
    const idb = (globalThis as unknown as { indexedDB?: IDBFactory }).indexedDB;
    const enumerate = (idb as unknown as { databases?: () => Promise<{ name?: string }[]> })
      ?.databases;
    if (idb && typeof enumerate === 'function') {
      const list = await enumerate.call(idb);
      const want = scratchReplicaDbName(last.id);
      return list.some((d) => d.name === want) ? last : null;
    }
  } catch {
    /* enumeration blocked (private mode) → fall back to the localStorage signal */
  }
  return last;
}
