// packages/server/src/db.ts
//
// Postgres pool for the Hocuspocus server. The server is long-lived
// (Fly machines stay up under load + min_machines_running=1 for prod),
// so a real connection pool makes sense — unlike the Workers side which
// has to use per-request clients.
//
// Reads DATABASE_URL from env. Fly Postgres provides this automatically
// when you `flyctl postgres attach`. For local dev, set it explicitly:
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
const memSnapshots = new Map<string, Uint8Array>();

if (USE_MEMORY) {
  // eslint-disable-next-line no-console
  console.log(
    '[hocuspocus] DATABASE_URL unset — running with in-memory snapshot store ' +
      '(local dev / e2e only; set DATABASE_URL for a persistent deploy).',
  );
}

function getPool(): pg.Pool {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL is required. Set it in the Fly app secrets ' +
        '(`flyctl postgres attach` does this) or via .env locally.',
    );
  }
  pool = new Pool({
    connectionString,
    // Fly Postgres tolerates plenty of connections; 10 is fine for one
    // Fly machine. Bump if we vertical-scale.
    max: 10,
    // Hocuspocus's debounced onStoreDocument can fire concurrently per
    // doc; idle connections settle back into the pool.
    idleTimeoutMillis: 30_000,
  });
  // CRITICAL: pg's Pool emits 'error' on a backend connection that dies
  // while IDLE in the pool (TCP reset, Fly Postgres failover, an auth
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

/** Load the persisted Yjs state for a rackspace. Returns null if no
 *  snapshot exists yet (fresh rack). */
export async function loadSnapshot(rackId: string): Promise<Uint8Array | null> {
  if (USE_MEMORY) return memSnapshots.get(rackId) ?? null;
  const result = await getPool().query<{ yjs_state: Buffer }>(
    'SELECT yjs_state FROM rack_snapshots WHERE rack_id = $1',
    [rackId],
  );
  if (result.rowCount === 0) return null;
  return new Uint8Array(result.rows[0].yjs_state);
}

/** Persist a Yjs snapshot. Upsert: one row per rack, latest state wins.
 *  Silently no-ops when the rack doesn't exist (FK violation 23503) —
 *  this codepath is unreachable from real user flows (the SvelteKit
 *  loader inserts the rack before the WS handshake), but Playwright
 *  tests connect with ephemeral rack ids that never get a `racks` row.
 *  Logging + swallowing keeps the test ergonomics clean and is safe in
 *  prod (the FK still enforces integrity if it ever did get triggered). */
export async function storeSnapshot(rackId: string, state: Uint8Array): Promise<void> {
  if (USE_MEMORY) {
    memSnapshots.set(rackId, state);
    return;
  }
  try {
    await getPool().query(
      `INSERT INTO rack_snapshots (rack_id, yjs_state, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (rack_id) DO UPDATE SET yjs_state = $2, updated_at = now()`,
      [rackId, Buffer.from(state)],
    );
  } catch (err) {
    if ((err as { code?: string }).code === '23503') {
      // eslint-disable-next-line no-console
      console.log(`[hocuspocus] persist skipped (no such rack): doc=${rackId}`);
      return;
    }
    // A persist failure must NEVER crash the relay. onStoreDocument has no
    // catch of its own, so a re-throw here becomes an unhandled rejection
    // that kills the whole process (every connected rack drops) — the
    // tab-switch 500 root cause: a transient pg 'Authentication timed out'
    // (08P01) on the unloadImmediately store fired on disconnect churn.
    // A dropped snapshot is recoverable: Hocuspocus re-fires the debounced
    // onStoreDocument on the next edit (and again on the next disconnect),
    // so the latest doc state lands as soon as the DB is reachable again.
    // Log + swallow so one bad write costs at most `debounce` ms of
    // durability, not the entire relay.
    // eslint-disable-next-line no-console
    console.error(
      `[hocuspocus] persist FAILED (transient — relay stays up, will retry): doc=${rackId} ` +
        `code=${(err as { code?: string }).code ?? ''} ${(err as Error).message}`,
    );
  }
}
