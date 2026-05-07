// packages/web/src/lib/server/db.ts
//
// Postgres connection helper. Reads DATABASE_URL via SvelteKit's
// `$env/dynamic/private` so it works on both runtimes:
//   - Cloudflare Workers (production):  CF Pages env vars come through
//     the platform `env` parameter, NOT process.env. SvelteKit wraps that
//     into $env/dynamic/private. Reading process.env.DATABASE_URL on
//     Workers silently returns undefined and we fall back to localhost,
//     which CF then 1003s as "Direct IP access not allowed" — that's how
//     the original bug masqueraded as three different driver issues.
//   - vite dev (local):  $env/dynamic/private reads from process.env / .env.
//
// We use @neondatabase/serverless's HTTP `neon` template tag because
// CF Workers can't drive raw `pg` sockets and CF's egress proxy 403s
// the package's WebSocket Pool. HTTP via fetch() is the only path
// that works across Workers, Node, and tests.
//
// Trade-off: HTTP transactions are a single round-trip array of queries
// with no conditional logic between them. Anything that needed BEGIN /
// conditional-INSERT / COMMIT is rewritten as a single SQL statement
// (CTE with WHERE NOT EXISTS, ON CONFLICT, etc.) — see rackspaces.ts.

import { env as privateEnv } from '$env/dynamic/private';
import { neon, type NeonQueryFunction } from '@neondatabase/serverless';

function connectionString(): string {
  const url = privateEnv.DATABASE_URL;
  if (url) return url;
  return 'postgresql://postgres:dev@localhost:54320/patchtogether_dev';
}

let _sql: NeonQueryFunction<false, false> | undefined;

/** Tagged-template query function. Returns rows for SELECT, full result for others. */
export function sql(): NeonQueryFunction<false, false> {
  if (!_sql) _sql = neon(connectionString());
  return _sql;
}
