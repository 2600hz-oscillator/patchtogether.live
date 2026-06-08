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

/** Localhost Postgres used only for local dev when DATABASE_URL is unset. */
export const LOCALHOST_DB_URL =
  'postgresql://postgres:dev@localhost:54320/patchtogether_dev';

/** Thrown when a non-dev (deployed) runtime has no DATABASE_URL configured. */
export class MissingDatabaseUrlError extends Error {
  constructor() {
    super(
      'DATABASE_URL is required in production (Neon HTTP). ' +
        'Set it in the Workers/Pages env.'
    );
    this.name = 'MissingDatabaseUrlError';
  }
}

/**
 * Pure resolver for the Postgres connection string — no module-level side
 * effects, fully injectable so the three branches are deterministically
 * unit-testable.
 *
 *   - DATABASE_URL set                  → use it (all deployed tiers do this).
 *   - unset + dev (or allowLocalhost)   → friendly localhost fallback.
 *   - unset + NOT dev (misconfigured
 *     deploy)                           → throw a named config error, so a
 *                                         missing DATABASE_URL on a deployed
 *                                         Worker fails LOUD instead of silently
 *                                         pointing at localhost (→ opaque CF
 *                                         1003 "Direct IP access not allowed").
 *
 * `allowLocalhost` is an explicit escape hatch (see ALLOW_LOCALHOST_DB below)
 * for the rare case where the dev marker can't be trusted.
 */
export function resolveConnectionString({
  databaseUrl,
  isDev,
  allowLocalhost = false,
}: {
  databaseUrl?: string;
  isDev: boolean;
  allowLocalhost?: boolean;
}): string {
  if (databaseUrl) return databaseUrl;
  if (isDev || allowLocalhost) return LOCALHOST_DB_URL;
  throw new MissingDatabaseUrlError();
}

function connectionString(): string {
  // `import.meta.env.DEV` is a Vite build-time constant: statically inlined to
  // `true` in the dev server and `false` in the production Workers/Pages bundle.
  // We deliberately do NOT key off NODE_ENV — CF Pages/Workers does not set
  // process.env.NODE_ENV, so it would be unreliable on the deployed runtime.
  // ALLOW_LOCALHOST_DB === '1' is an explicit override for the rare case the
  // dev marker can't be trusted.
  return resolveConnectionString({
    databaseUrl: privateEnv.DATABASE_URL,
    isDev: import.meta.env.DEV,
    allowLocalhost: privateEnv.ALLOW_LOCALHOST_DB === '1',
  });
}

let _sql: NeonQueryFunction<false, false> | undefined;

/** Tagged-template query function. Returns rows for SELECT, full result for others. */
export function sql(): NeonQueryFunction<false, false> {
  if (!_sql) _sql = neon(connectionString());
  return _sql;
}
