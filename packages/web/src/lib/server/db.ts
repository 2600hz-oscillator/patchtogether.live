// packages/web/src/lib/server/db.ts
//
// Postgres connection helper. Reads DATABASE_URL from env on both runtimes:
//   - Cloudflare Workers (production):  set as a secret_text env var on the
//     CF Pages project. nodejs_compat shims process.env to platform env.
//   - vite dev (local):  process.env.DATABASE_URL or a sensible local default.
//
// The original B1 plan used Cloudflare Hyperdrive for ~30ms Worker→Fly
// latency vs ~150ms naive, but Fly Postgres ships without TLS at the origin
// and Hyperdrive requires TLS — fixing that needs Postgres to expose a
// real cert. Direct connection is fine for beta load; revisit once RUM
// shows query latency mattering.
//
// Per-request Client (not Pool): Workers have no long-lived process to
// hold a pool. Local dev pays the ~3ms TCP handshake per request, fine.

import pg from 'pg';

function connectionString(): string {
  const url = process.env.DATABASE_URL;
  if (url) return url;
  return 'postgresql://postgres:dev@localhost:54320/patchtogether_dev';
}

/** Open a per-request pg client. Caller must `client.end()` (typically in
 *  a try/finally — use `withDb` for the common case). */
export async function getDb(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: connectionString() });
  await client.connect();
  return client;
}

/** Convenience: open a client, run a query function, always close. */
export async function withDb<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = await getDb();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}
