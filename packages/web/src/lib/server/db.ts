// packages/web/src/lib/server/db.ts
//
// Postgres connection helper. Reads DATABASE_URL from env on both runtimes:
//   - Cloudflare Workers (production):  set as a secret_text env var on the
//     CF Pages project. nodejs_compat shims process.env to platform env.
//   - vite dev (local):  process.env.DATABASE_URL or a sensible local default.
//
// Workers can't drive the standard `pg` package over the node:net shim — its
// egress proxy returns "proxy request failed" because pg's socket use isn't
// what cloudflare:sockets expects. We use @neondatabase/serverless's Pool,
// which speaks Postgres-over-WebSocket and is Workers-native. API surface is
// the same as pg.Pool / pg.Client so our query code is unchanged.
//
// On Node (vite dev, the SvelteKit dev server) the same Pool works over a
// real WebSocket — also fine. So one code path covers both runtimes.

import { Pool, type PoolClient } from '@neondatabase/serverless';

function connectionString(): string {
  const url = process.env.DATABASE_URL;
  if (url) return url;
  return 'postgresql://postgres:dev@localhost:54320/patchtogether_dev';
}

// Module-scoped pool. On Workers a fresh isolate gets a fresh pool; the
// pool's first query in that isolate pays the WebSocket handshake (~50ms),
// subsequent queries reuse the connection within the same isolate.
let _pool: Pool | undefined;
function pool(): Pool {
  if (!_pool) _pool = new Pool({ connectionString: connectionString() });
  return _pool;
}

/** Open a per-request client, run a query function, always release. */
export async function withDb<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}
