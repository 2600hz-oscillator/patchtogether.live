// packages/web/src/lib/server/db.ts
//
// Postgres connection helper. Two runtimes share this:
//   - Cloudflare Workers (production):  reads connection string from the
//     HYPERDRIVE binding on event.platform.env. Hyperdrive is CF's
//     Postgres connection accelerator — pools + caches at the edge so
//     Workers→Fly Postgres is ~30–50ms instead of ~150ms naive.
//   - vite dev (local):  no platform.env available; falls back to
//     process.env.DATABASE_URL or a sensible local default.
//
// Per-request Client (not Pool): Workers have no long-lived process to
// hold a pool, and Hyperdrive does the pooling for us anyway. Local dev
// pays the ~3ms TCP handshake per request, which is fine for dev.

import pg from 'pg';

interface HyperdriveBinding {
  connectionString: string;
}

interface PlatformEnv {
  HYPERDRIVE?: HyperdriveBinding;
}

function connectionString(platformEnv?: PlatformEnv): string {
  if (platformEnv?.HYPERDRIVE?.connectionString) {
    return platformEnv.HYPERDRIVE.connectionString;
  }
  // SvelteKit `vite dev` path. process.env is available because the
  // SvelteKit dev server runs in Node.
  if (typeof process !== 'undefined' && process.env?.DATABASE_URL) {
    return process.env.DATABASE_URL;
  }
  return 'postgresql://postgres@localhost:54320/patchtogether_dev';
}

/** Open a per-request pg client. Caller must `client.end()` (typically
 *  in a try/finally). */
export async function getDb(platformEnv?: PlatformEnv): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: connectionString(platformEnv) });
  await client.connect();
  return client;
}

/** Convenience: open a client, run a query function, always close. */
export async function withDb<T>(
  platformEnv: PlatformEnv | undefined,
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = await getDb(platformEnv);
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}
