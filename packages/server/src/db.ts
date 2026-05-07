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
  return pool;
}

/** Lookup whether a Clerk user id is a member of a rackspace.
 *  Returns false if the rack doesn't exist (caller's gate is identical
 *  for "no such rack" and "not a member"). */
export async function isRackspaceMember(rackId: string, userId: string): Promise<boolean> {
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
  const result = await getPool().query(
    'SELECT 1 FROM racks WHERE id = $1 LIMIT 1',
    [rackId],
  );
  return result.rowCount !== null && result.rowCount > 0;
}

/** Load the persisted Yjs state for a rackspace. Returns null if no
 *  snapshot exists yet (fresh rack). */
export async function loadSnapshot(rackId: string): Promise<Uint8Array | null> {
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
    throw err;
  }
}
