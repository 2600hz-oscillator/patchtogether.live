// packages/web/src/lib/multiplayer/local-replica.ts
//
// LOCAL REPLICA of the rackspace Y.Doc (y-indexeddb), so a relay outage is
// a SYNC outage, not a product outage.
//
// Before this module the client had zero local persistence (grep-confirmed
// in the stack study): if the relay was down the rack page had nothing to
// show, and edits made in the moments before a tab closed rode on nothing
// but the relay's 2-5s snapshot debounce. Now every rack doc is mirrored
// into IndexedDB on the client:
//
//   - LOAD: bindRackspace() hands us the fresh per-rack Y.Doc; we seed it
//     from IndexedDB immediately (milliseconds, no network), then the
//     HocuspocusProvider attaches and the standard y-sync state-vector
//     handshake reconciles BOTH directions — local-ahead (offline edits
//     from a previous session replay to the relay; see the R2 PR's
//     reconnect-replay proof) and server-ahead (stale replica catches up).
//     No custom merge code: CRDT convergence IS the reconciliation.
//   - LIVE: y-indexeddb persists every subsequent update (local + remote
//     origin alike) and self-compacts past PREFERRED_TRIM_SIZE.
//
// Design notes / edge cases handled here:
//
//   STALENESS vs SERVER TRUTH — handled by the sync protocol, with one
//   caveat: if a rack's server-side doc is ever REBUILT from scratch (no
//   shared history), merging an old replica UNIONS old content back in.
//   That doesn't happen in normal operation (deletes are CRDT ops with
//   tombstones; relay compaction preserves history identity). The escape
//   hatch (clearLocalReplica) covers the pathological case.
//
//   CORRUPT REPLICA — y-indexeddb has NO error path for a corrupt stored
//   update: Y.applyUpdate throws inside its internal load chain,
//   `whenSynced` never resolves, and the rejection is unreachable from
//   the outside (verified against y-indexeddb's source). So we PRE-FLIGHT:
//   read the stored rows ourselves and decode-check each against a
//   throwaway Y.Doc. Any bad row → wipe the replica DB (clear + refetch
//   from relay — losing a corrupt cache is the correct trade) and attach
//   fresh. A wedged/blocked IndexedDB (privacy modes, quota) times out
//   into 'disabled': the rack simply runs replica-less, exactly like
//   before this module existed.
//
//   MULTI-TAB — y-indexeddb writes are per-update rows under autoIncrement
//   keys, safe under concurrent tabs; each tab's instance compacts
//   independently. Two OFFLINE tabs don't see each other live (no
//   BroadcastChannel here — when online the relay is the bus), but both
//   tabs' updates land in the same store and merge on the next load.
//
//   ANONYMOUS GUESTS — replicas attach for them too (a guest mid-jam
//   deserves the same outage immunity), keyed by rack id like everyone
//   else. The page clears the rack's replica on an auth REJECTION
//   (revoked membership / dead invite), so a machine that lost access
//   doesn't keep a browsable copy in IndexedDB.
//
//   Y.Doc LIFECYCLE — bindRackspace() creates a fresh doc per mount and
//   destroys it on unbind; we only ever APPLY UPDATES into the live doc
//   (never rebuild-and-reassign Y containers — the #566 lesson), and
//   y-indexeddb auto-destroys with the doc via doc.on('destroy').

import { IndexeddbPersistence } from 'y-indexeddb';
import * as Y from 'yjs';

/** Versioned DB-name prefix: bump to orphan every existing replica if the
 *  storage layout ever changes incompatibly. */
export const REPLICA_DB_PREFIX = 'pt-rack-v1-';

export function replicaDbName(rackspaceId: string): string {
  return `${REPLICA_DB_PREFIX}${rackspaceId}`;
}

/** IndexedDB is unavailable during SSR and in some hardened/private
 *  browser modes — the replica is strictly additive, so it just sits out. */
export function isReplicaSupported(): boolean {
  return typeof indexedDB !== 'undefined' && indexedDB !== null;
}

export type ReplicaSeedResult =
  /** Replica existed and its state was applied into the doc. */
  | 'seeded'
  /** No prior replica (first visit) — persisting from now on. */
  | 'fresh'
  /** Stored rows failed decode validation; DB wiped; persisting fresh.
   *  The relay refetch (provider sync) is the recovery path. */
  | 'cleared-corrupt'
  /** No IndexedDB / it never answered — running replica-less. */
  | 'disabled';

export interface LocalReplicaHandle {
  /** Resolves once the seed decision is made (see ReplicaSeedResult).
   *  Never rejects. */
  whenSeeded: Promise<ReplicaSeedResult>;
  /** Stop persisting for this handle. KEEPS the stored data (normal
   *  unmount path — the replica must survive navigation/reload). */
  destroy(): Promise<void>;
}

/** How long the pre-flight validation read may take before we give up on
 *  IndexedDB for this mount ('disabled'). Generous: a local read of even
 *  a ceiling-sized rack is far under this. */
const VALIDATE_TIMEOUT_MS = 5_000;

interface AttachOptions {
  /** Test seam: shrink the pre-flight timeout. */
  validateTimeoutMs?: number;
  log?: (msg: string) => void;
}

/**
 * Attach a local IndexedDB replica to the CURRENT rack doc.
 *
 * Call order on the rack page: bindRackspace() → attachLocalReplica() →
 * attachProvider(). The seed happens asynchronously; the UI simply sees
 * updates arrive on the doc (same shape as provider sync), so there is no
 * loading gate to coordinate — local bytes win the race against the WS by
 * orders of magnitude, which IS the "seed from local immediately" story.
 */
export function attachLocalReplica(
  rackspaceId: string,
  ydoc: Y.Doc,
  options: AttachOptions = {},
): LocalReplicaHandle {
  // eslint-disable-next-line no-console
  const log = options.log ?? ((msg: string) => console.warn(msg));

  if (!isReplicaSupported()) {
    return { whenSeeded: Promise.resolve('disabled'), destroy: async () => {} };
  }

  const dbName = replicaDbName(rackspaceId);
  let persistence: IndexeddbPersistence | null = null;
  let destroyed = false;

  const whenSeeded: Promise<ReplicaSeedResult> = (async () => {
    // 1. Pre-flight: read + decode-validate the stored rows OURSELVES.
    //    y-indexeddb cannot surface a corrupt row (its load chain just
    //    hangs), so the validation has to happen before it attaches.
    let verdict: 'valid' | 'empty' | 'corrupt' | 'unavailable';
    try {
      verdict = await withTimeout(
        validateReplicaDb(dbName),
        options.validateTimeoutMs ?? VALIDATE_TIMEOUT_MS,
      );
    } catch {
      verdict = 'unavailable';
    }

    if (verdict === 'unavailable') {
      log(`[replica] IndexedDB unavailable — running replica-less: rack=${rackspaceId}`);
      return 'disabled';
    }

    if (verdict === 'corrupt') {
      // Escape hatch: clear + refetch. Losing a corrupt CACHE is correct —
      // the relay (or the other members' replicas) hold the real state.
      log(`[replica] corrupt replica cleared (will refetch from relay): rack=${rackspaceId}`);
      try {
        await deleteDb(dbName);
      } catch {
        // Even the delete failing must not take the rack page down; the
        // pre-flight will just flag it corrupt again next mount.
        return 'disabled';
      }
    }

    // The handle can be torn down while we were validating (fast unmount,
    // strict-mode double-effect) — don't attach a zombie.
    if (destroyed || ydoc.isDestroyed) return 'disabled';

    // 2. Attach y-indexeddb for the seed + ongoing persistence.
    persistence = new IndexeddbPersistence(dbName, ydoc);
    await persistence.whenSynced;
    if (verdict === 'corrupt') return 'cleared-corrupt';
    return verdict === 'valid' ? 'seeded' : 'fresh';
  })().catch(() => 'disabled' as const);

  return {
    whenSeeded,
    async destroy() {
      destroyed = true;
      await whenSeeded; // never rejects; guarantees no half-built attach
      if (persistence) {
        const p = persistence;
        persistence = null;
        try {
          await p.destroy(); // keeps data — destroy() only detaches
        } catch {
          /* teardown is best-effort */
        }
      }
    },
  };
}

/**
 * Wipe a rack's local replica entirely. Used by:
 *  - the auth-rejection path (membership revoked / invite dead → this
 *    machine should not keep a browsable copy);
 *  - the corrupt-replica escape hatch (internally);
 *  - support/debugging ("clear local copy" affordances later).
 * Safe to call when no replica exists. Never rejects.
 */
export async function clearLocalReplica(rackspaceId: string): Promise<void> {
  if (!isReplicaSupported()) return;
  try {
    await deleteDb(replicaDbName(rackspaceId));
  } catch {
    /* best-effort — a failed delete surfaces as 'corrupt' next mount */
  }
}

// ── internals ───────────────────────────────────────────────────────────────

/** Read every stored update row and decode-check it against a THROWAWAY
 *  Y.Doc (structurally-valid updates never touch the real doc here;
 *  garbage throws on decode — the exact corruption class we defend
 *  against). Distinguishes:
 *    'empty'   — DB absent or no rows (first visit)
 *    'valid'   — at least one row, all decode
 *    'corrupt' — any row fails to decode
 */
async function validateReplicaDb(dbName: string): Promise<'valid' | 'empty' | 'corrupt'> {
  // Open WITHOUT creating stores when the DB doesn't exist yet: an
  // upgradeneeded fires only for a brand-new DB — treat that as empty and
  // abort the creation so y-indexeddb owns the schema when it attaches.
  const rows = await new Promise<Uint8Array[] | 'no-db'>((resolve, reject) => {
    const req = indexedDB.open(dbName);
    let isNew = false;
    req.onupgradeneeded = () => {
      isNew = true;
    };
    req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'));
    req.onblocked = () => reject(new Error('indexedDB open blocked'));
    req.onsuccess = () => {
      const db = req.result;
      const finish = (value: Uint8Array[] | 'no-db'): void => {
        db.close();
        if (isNew) {
          // We created an empty shell — remove it so the real attach
          // starts from a clean y-indexeddb-owned schema.
          const del = indexedDB.deleteDatabase(dbName);
          del.onsuccess = del.onerror = del.onblocked = () => resolve(value);
        } else {
          resolve(value);
        }
      };
      if (isNew || !db.objectStoreNames.contains('updates')) {
        finish('no-db');
        return;
      }
      try {
        const tx = db.transaction('updates', 'readonly');
        const getAll = tx.objectStore('updates').getAll();
        getAll.onsuccess = () => finish((getAll.result as Uint8Array[]) ?? []);
        getAll.onerror = () => {
          db.close();
          reject(getAll.error ?? new Error('replica read failed'));
        };
      } catch (err) {
        db.close();
        reject(err as Error);
      }
    };
  });

  if (rows === 'no-db' || rows.length === 0) return 'empty';

  const throwaway = new Y.Doc();
  try {
    for (const row of rows) {
      // Decode errors throw; structurally-valid-but-pending updates are
      // queued internally by Yjs without throwing — both are fine to run
      // against a throwaway doc.
      Y.applyUpdate(throwaway, row instanceof Uint8Array ? row : new Uint8Array(row));
    }
    return 'valid';
  } catch {
    return 'corrupt';
  } finally {
    throwaway.destroy();
  }
}

function deleteDb(dbName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(dbName);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error('deleteDatabase failed'));
    // 'blocked' means another tab holds the DB open; the delete completes
    // once it lets go. Resolve optimistically — the delete is queued.
    req.onblocked = () => resolve();
  });
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
