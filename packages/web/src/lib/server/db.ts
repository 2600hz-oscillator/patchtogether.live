// packages/web/src/lib/server/db.ts
//
// Postgres connection helper. Reads DATABASE_URL from env on both runtimes:
//   - Cloudflare Workers (production):  set as a secret_text env var on the
//     CF Pages project. nodejs_compat shims process.env to platform env.
//   - vite dev (local):  process.env.DATABASE_URL or a sensible local default.
//
// Workers cannot drive standard `pg` (node:net shim returns "proxy request
// failed") and cannot drive @neondatabase/serverless's WebSocket Pool
// either (CF egress proxy 403s the outbound WS handshake — confirmed
// via wrangler tail). The HTTP-only `neon` template tag uses fetch()
// under the hood, which works in both Workers and Node, so we standardize
// on it.
//
// Trade-off: HTTP transactions are a single round-trip array of queries
// with no conditional logic between them. Anything that needed BEGIN /
// conditional-INSERT / COMMIT is rewritten as a single SQL statement
// (CTE with WHERE NOT EXISTS, ON CONFLICT, etc.) — see rackspaces.ts.

import { neon, type NeonQueryFunction } from '@neondatabase/serverless';

function connectionString(): string {
  const url = process.env.DATABASE_URL;
  if (url) return url;
  return 'postgresql://postgres:dev@localhost:54320/patchtogether_dev';
}

let _sql: NeonQueryFunction<false, false> | undefined;

/** Tagged-template query function. Returns rows for SELECT, full result for others. */
export function sql(): NeonQueryFunction<false, false> {
  if (!_sql) _sql = neon(connectionString());
  return _sql;
}
