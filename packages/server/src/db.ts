// packages/server/src/db.ts
//
// Postgres pool for the Hocuspocus server. The server is long-lived
// (Fly machines stay up under load + min_machines_running=1 for prod),
// so a real connection pool makes sense — unlike the Workers side which
// has to use per-request clients.
//
// Reads DATABASE_URL from env. In every deployed tier this is the **Neon
// DIRECT (non-pooled) endpoint** — the same Neon database the web tier uses,
// just reached over TCP with `pg` instead of Neon's HTTP driver. Do NOT point
// it at Neon's `-pooler` host: that endpoint exists for serverless/HTTP
// clients, not for a long-lived pool. It is pushed by
// `scripts/sync-secrets.sh` from `NEON_{TIER}_DIRECT_URL`.
//
// (Historical: this used to be a Fly Managed Postgres DSN attached via
// `flyctl postgres attach`. That whole stack was decommissioned when Neon
// landed — see db/README.md. There is only ONE database.)
//
// For local dev, set it explicitly:
//   DATABASE_URL=postgresql://postgres:dev@localhost:54320/patchtogether_dev

import pg from 'pg';

const { Pool } = pg;

let pool: pg.Pool | null = null;

// ── In-memory fallback (no DATABASE_URL) ────────────────────────────────────
//
// When DATABASE_URL is unset we run the collab server fully in memory: no
// Postgres connection, snapshots live in a process-local Map, and membership
// checks treat every rack as joinable. This is the LOCAL DEV + E2E mode — the
// @collab Playwright suite (2-/4-context DOOM netgame, host-migration, etc.)
// can then actually connect + sync without standing up Postgres, which is why
// those tests historically could only "skip-clean" locally and were never
// validated for real. Prod + dev deploys always set DATABASE_URL (Fly secret),
// so this branch is never taken there and persistence/membership are unchanged.
//
// NOTE: snapshots in this mode do not survive a server restart — fine for
// ephemeral test racks (Playwright uses a fresh rack id per run) and a dev
// loop where durability isn't the point.
const USE_MEMORY = !process.env.DATABASE_URL;
const memSnapshotRecords = new Map<string, SnapshotRecord>();
let memSnapshotGeneration = 0n;
const memSnapshotGarbage = new Map<string, number>();

export interface SnapshotRecord {
  state: Uint8Array;
  generation: string;
  r2Key: string | null;
}

/** Allocate before starting object I/O, so late completion cannot replace a newer save. */
export async function nextSnapshotGeneration(): Promise<string> {
  if (USE_MEMORY) return String(++memSnapshotGeneration);
  const result = await getPool().query<{ generation: string }>(
    "SELECT nextval('rack_snapshot_generation')::text AS generation",
  );
  return result.rows[0]!.generation;
}

export async function loadSnapshotRecord(rackId: string): Promise<SnapshotRecord | null> {
  if (USE_MEMORY) {
    return memSnapshotRecords.get(rackId) ?? null;
  }
  const result = await getPool().query<{ yjs_state: Buffer; generation: string; r2_key: string | null }>(
    'SELECT yjs_state, generation::text, r2_key FROM rack_snapshots WHERE rack_id = $1', [rackId],
  );
  const row = result.rows[0];
  return row ? { state: new Uint8Array(row.yjs_state), generation: row.generation, r2Key: row.r2_key } : null;
}

/** Commit the authority and payload together. False keeps the crash journal intact. */
export async function storeSnapshotRecord(rackId: string, record: SnapshotRecord): Promise<boolean> {
  if (USE_MEMORY) {
    const previous = memSnapshotRecords.get(rackId);
    if (!previous || BigInt(previous.generation) < BigInt(record.generation)) {
      if (previous?.r2Key && previous.r2Key !== record.r2Key) memSnapshotGarbage.set(previous.r2Key, Date.now());
      memSnapshotRecords.set(rackId, record);
    } else if (record.r2Key && record.r2Key !== previous.r2Key) {
      memSnapshotGarbage.set(record.r2Key, Date.now());
    }
    return true;
  }
  try {
    await getPool().query(
      `WITH committed AS (INSERT INTO rack_snapshots (rack_id, yjs_state, generation, r2_key, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (rack_id) DO UPDATE SET yjs_state = EXCLUDED.yjs_state,
         generation = EXCLUDED.generation, r2_key = EXCLUDED.r2_key, updated_at = now()
       WHERE rack_snapshots.generation < EXCLUDED.generation RETURNING rack_id)
       INSERT INTO rack_snapshot_garbage(object_key)
       SELECT $4::text WHERE $4::text IS NOT NULL AND NOT EXISTS (SELECT 1 FROM committed)
         AND NOT EXISTS (SELECT 1 FROM rack_snapshots WHERE rack_id = $1 AND r2_key = $4)
       ON CONFLICT DO NOTHING`,
      [rackId, Buffer.from(record.state), record.generation, record.r2Key],
    );
    return true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[hocuspocus] snapshot authority commit failed: doc=${rackId} ${(err as Error).message}`);
    return false;
  }
}

export async function retiredSnapshotObjects(): Promise<string[]> {
  if (USE_MEMORY) return [...memSnapshotGarbage].filter(([, at]) => at < Date.now() - 3600_000).slice(0, 32).map(([key]) => key);
  const result = await getPool().query<{ object_key: string }>(
    "SELECT object_key FROM rack_snapshot_garbage WHERE retired_at < now() - interval '1 hour' ORDER BY retired_at LIMIT 32",
  );
  return result.rows.map(row => row.object_key);
}

export async function forgetRetiredSnapshotObject(key: string): Promise<void> {
  if (USE_MEMORY) { memSnapshotGarbage.delete(key); return; }
  await getPool().query('DELETE FROM rack_snapshot_garbage WHERE object_key = $1', [key]);
}

if (USE_MEMORY) {
  // eslint-disable-next-line no-console
  console.log(
    '[hocuspocus] DATABASE_URL unset — running with in-memory snapshot store ' +
      '(local dev / e2e only; set DATABASE_URL for a persistent deploy).',
  );
}

/** Which snapshot store the relay is currently using.
 *  'postgres' = durable (DATABASE_URL set); 'memory' = process-local + lost on
 *  restart (the local-dev/e2e fallback). Surfaced on /health + /metrics so a
 *  misconfigured prod relay serving a NON-persistent rack is observable instead
 *  of silently lossy. */
export function persistenceMode(): 'postgres' | 'memory' {
  return USE_MEMORY ? 'memory' : 'postgres';
}

/** Pure decision for the prod startup fail-fast guard (kept side-effect-free so
 *  vitest can exercise it without actually `process.exit`-ing).
 *
 *  The in-memory snapshot store (PR #310) is INTENTIONAL for local dev + the
 *  @collab e2e suite (it lets two browser contexts join the same rack without
 *  standing up Postgres). But a PROD relay that boots into memory mode silently
 *  serves a rack whose state vanishes on the next deploy/restart — exactly the
 *  "looks fine, loses everything" footgun this guard exists to prevent.
 *
 *  Fire ONLY when ALL hold:
 *    - NODE_ENV === 'production'  (all three fly.tomls set it; local + the
 *      @collab CI/test env do NOT → the in-memory @collab path stays untouched)
 *    - we resolved to memory mode (no DATABASE_URL)
 *    - the operator did NOT set the ALLOW_MEMORY_STORE=1 escape hatch (for a
 *      deliberate ephemeral prod-memory run)
 *
 *  `usingMemory` is injectable so the test doesn't depend on the module-load-time
 *  USE_MEMORY snapshot; it defaults to the live persistence mode. */
export function shouldFailFast(
  env: Record<string, string | undefined> = process.env,
  usingMemory: boolean = persistenceMode() === 'memory',
): boolean {
  return env.NODE_ENV === 'production' && usingMemory && env.ALLOW_MEMORY_STORE !== '1';
}

/** Shared relay-wide pg pool. Exported (since the journal slice) so sibling
 *  persistence modules — journal.ts, snapshot-store.ts — reuse the SAME pool
 *  (and its crash-proofing 'error' listener) instead of growing their own. */
export function getPool(): pg.Pool {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      // FIXED 2026-08-17. This text used to say `flyctl postgres attach` — the
      // decommissioned Fly Managed Postgres stack — and was knowingly left
      // wrong, because the STRING was in the @collab attest basis (comments were
      // not, verified 2026-08-11) so rewording it cost a `task collab:attest`
      // cycle. The comment said "fix it the next time you are re-attesting
      // anyway"; collab-attest was deleted instead, so it is free now. That is
      // the shape of what a non-gating gate costs: a wrong operator message
      // shipped for months to protect a hash nothing checked.
      'DATABASE_URL is required. Set it via `scripts/sync-secrets.sh <tier> --apply` ' +
        '(pushes NEON_<TIER>_DIRECT_URL) or in .env locally.',
    );
  }
  pool = new Pool({
    connectionString,
    // Neon's direct endpoint tolerates plenty of connections; 10 is fine for
    // one Fly machine. Bump if we vertical-scale.
    max: 10,
    // Hocuspocus's debounced onStoreDocument can fire concurrently per
    // doc; idle connections settle back into the pool.
    idleTimeoutMillis: 30_000,
  });
  // CRITICAL: pg's Pool emits 'error' on a backend connection that dies
  // while IDLE in the pool (TCP reset, a Neon compute suspend/restart, an auth
  // timeout on a connection that was mid-acquire). With NO listener, node
  // treats that emit as an unhandled 'error' event and CRASHES the whole
  // relay process — which is exactly the tab-switch 500 the operator hit:
  // rapid connect/disconnect churn (unloadImmediately fires onStoreDocument
  // on the last disconnect) triggered a transient pg 'Authentication timed
  // out' (code 08P01) on the pool, the rejection went unhandled, node exited
  // 1, the Fly machine rebooted, and in-flight WS + HTTP requests got
  // connection-reset (the user-visible server error). A logging listener
  // demotes these to recoverable noise; the next query re-establishes a
  // healthy connection. See packages/web/src/routes/r/[id]/+page.server.ts +
  // the relay crash trace in the PR.
  pool.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error(
      `[hocuspocus] pg pool idle-client error (recovered, relay stays up): ${
        (err as { code?: string }).code ?? ''
      } ${err.message}`,
    );
  });
  return pool;
}

/** Lookup whether a Clerk user id is a member of a rackspace.
 *  Returns false if the rack doesn't exist (caller's gate is identical
 *  for "no such rack" and "not a member"). */
export async function isRackspaceMember(rackId: string, userId: string): Promise<boolean> {
  // In-memory mode (local dev / e2e): no membership table — treat every
  // authenticated member as allowed so two real browser contexts can join the
  // same rack. Prod always has DATABASE_URL set and runs the real query.
  if (USE_MEMORY) return true;
  const result = await getPool().query<{ ok: boolean }>(
    'SELECT 1 AS ok FROM rack_members WHERE rack_id = $1 AND user_id = $2 LIMIT 1',
    [rackId, userId],
  );
  return result.rowCount !== null && result.rowCount > 0;
}

/** Whether a rackspace exists at all. Used to reject anon WS connections
 *  for nonexistent rackspaces (otherwise an anon-with-valid-invite for a
 *  fake rackspace id passes auth + creates an empty Hocuspocus doc that
 *  never persists). */
export async function rackspaceExists(rackId: string): Promise<boolean> {
  // In-memory mode: every rack id is considered to exist (anon test racks).
  if (USE_MEMORY) return true;
  const result = await getPool().query(
    'SELECT 1 FROM racks WHERE id = $1 LIMIT 1',
    [rackId],
  );
  return result.rowCount !== null && result.rowCount > 0;
}

/** Test-only: wipe the in-memory snapshot map between cases. */
export function _resetMemorySnapshots(): void {
  memSnapshotRecords.clear();
  memSnapshotGeneration = 0n;
  memSnapshotGarbage.clear();
}
