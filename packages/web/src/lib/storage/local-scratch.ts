// packages/web/src/lib/storage/local-scratch.ts
//
// STABLE per-device id for the SCRATCH canvas's local IndexedDB replica.
//
// Lives under lib/storage (NOT lib/multiplayer) on purpose: this is a
// client-only, single-user localStorage id helper — it has nothing to do with
// collaboration/sync. That is the whole reason now. It used to have a second,
// mechanical one — lib/multiplayer was a whole-directory collab-attest basis
// root, so a non-collab file there falsely forced a re-attest on every edit —
// and that attest was deleted 2026-08-17. Keep it out on the meaning, not the
// hash.
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
// ONE id, because there is ONE rack shell. This used to be keyed by rack MODE
// ('dawless' | 'workflow') so the two scratch entry points could not cross-load
// each other's patch. Dawless is gone, so the key is unkeyed again — and the
// two mode-suffixed keys a returning browser may still hold are PRUNED rather
// than adopted (see pruneLegacyModeKeys), which is the client-side half of the
// clean reset this migration performs on the server.
//
// The id is a per-device UUID rather than a bare 'local-scratch' constant so
// its IndexedDB DB name can never collide with the real rack id space, and the
// "reset scratch" affordance (File → New rack) can just mint a fresh one.
//
// Persisted in localStorage (must survive a refresh — sessionStorage would
// not). Graceful degrade: a throwing / private-mode localStorage falls back to
// a per-mount EPHEMERAL id (no crash, just no cross-refresh persistence in that
// hostile environment) — the same posture as presence.ts's getOrCreateAnonTabId.

/** localStorage key holding this device's scratch replica id. */
const LOCAL_SCRATCH_KEY = 'pt:local-scratch-id';

/**
 * Keys written by the two-mode era. A browser that last ran the dawless build
 * still holds one or both of these plus `pt:last-scratch-mode`.
 *
 * They are DELETED, never read: adopting the old workflow id would resurrect a
 * patch authored under a shell that no longer exists (and adopting the dawless
 * one would load a patch with no pinned singletons into a shell that requires
 * them — exactly the cross-mode load the deleted patch-mode guard used to
 * refuse). The owner authorised destroying saved racks for a clean reset; this
 * is that reset on the client. The orphaned IndexedDB replicas are left in
 * place, the same way File → New rack has always orphaned the previous one.
 */
const LEGACY_MODE_KEYS = [
  'pt:local-scratch-id:dawless',
  'pt:local-scratch-id:workflow',
  'pt:last-scratch-mode',
] as const;

/** Matches presence.ts's helper (kept local — it isn't exported there): a
 *  UUID when the platform offers one, else a short random fallback. */
function cryptoRandomId(): string {
  const g = globalThis as unknown as { crypto?: Crypto };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  return Math.random().toString(36).slice(2, 14);
}

/** The localStorage handle, or null when unavailable/throwing (private mode,
 *  sandboxed iframes, SSR). Every accessor below funnels through this so a
 *  hostile environment degrades identically everywhere. */
function storage(): Storage | null {
  try {
    return (globalThis as unknown as { localStorage?: Storage }).localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Remove every key the two-mode era wrote. Idempotent, best-effort, and called
 * from each entry point below so a returning browser is cleaned on its first
 * touch of the scratch canvas OR of the landing card — whichever it reaches
 * first. Exported for the test that feeds the old shape in.
 */
export function pruneLegacyModeKeys(): void {
  const ls = storage();
  if (!ls) return;
  for (const k of LEGACY_MODE_KEYS) {
    try {
      ls.removeItem(k);
    } catch {
      /* a throwing removeItem must not take the canvas down with it */
    }
  }
}

/** localStorage key for the scratch id. Exported for tests + tooling. */
export function localScratchStorageKey(): string {
  return LOCAL_SCRATCH_KEY;
}

/**
 * Get (or lazily create) the STABLE local-scratch replica id.
 *
 *   → 'local-scratch-<uuid>'
 *
 * Stable across calls (persisted in localStorage). Falls back to a fresh
 * ephemeral id — never throws — when localStorage is unavailable or throws
 * (private mode / sandboxed contexts): persistence is silently skipped in that
 * environment, the canvas just runs refresh-volatile.
 */
export function getOrCreateLocalScratchId(): string {
  pruneLegacyModeKeys();
  const ls = storage();
  if (ls) {
    try {
      const existing = ls.getItem(LOCAL_SCRATCH_KEY);
      if (existing) return existing;
      const fresh = `local-scratch-${cryptoRandomId()}`;
      ls.setItem(LOCAL_SCRATCH_KEY, fresh);
      return fresh;
    } catch {
      /* fall through to an ephemeral id so the page never crashes */
    }
  }
  return `local-scratch-${cryptoRandomId()}`;
}

/**
 * Read the stored scratch id WITHOUT minting one when absent — the read-only
 * counterpart to getOrCreateLocalScratchId. Returns null when no id has been
 * persisted yet (the user has never opened the scratch canvas) or localStorage
 * is unavailable. Used by "Return to last rack" to test for a prior rack
 * without side-effecting a brand-new id into existence.
 */
export function peekLocalScratchId(): string | null {
  pruneLegacyModeKeys();
  try {
    return storage()?.getItem(LOCAL_SCRATCH_KEY) ?? null;
  } catch {
    return null;
  }
}

/**
 * Mint a FRESH scratch id and persist it, REPLACING any existing one. This is
 * the "File → New rack" (logged-out) primitive: a new id ⇒ a new replica DB
 * name ⇒ the reloaded scratch canvas rehydrates an EMPTY doc instead of the old
 * one (the previous id's IndexedDB rows are simply orphaned). Falls back to a
 * returned-but-unpersisted ephemeral id when localStorage throws.
 */
export function resetLocalScratchId(): string {
  pruneLegacyModeKeys();
  const fresh = `local-scratch-${cryptoRandomId()}`;
  try {
    storage()?.setItem(LOCAL_SCRATCH_KEY, fresh);
  } catch {
    /* private mode / sandboxed → ephemeral, exactly like getOrCreate. */
  }
  return fresh;
}

/** A prior scratch rack the landing can offer to reopen. */
export interface LastScratchRack {
  /** The persisted per-device scratch id (⇒ the replica DB name). */
  id: string;
  /** The route to navigate to. */
  href: string;
}

/**
 * Resolve the last scratch rack from localStorage ALONE (sync, no IndexedDB):
 * a persisted scratch id is itself the "the user has opened a rack before"
 * signal, because it is minted on the scratch canvas's mount. Returns null when
 * there is no prior session. Callers that need the stricter "actually persisted
 * in IndexedDB" guarantee additionally probe `scratchReplicaDbName(id)` — this
 * is the cheap first gate that also yields the id + reopen href.
 */
export function readLastScratchRack(): LastScratchRack | null {
  const id = peekLocalScratchId();
  if (!id) return null;
  return { id, href: '/rack' };
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
