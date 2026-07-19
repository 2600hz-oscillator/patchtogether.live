// Public health probe — never trips the Clerk handler (carve-out in
// hooks.server.ts) so it works in every environment, including the prod
// project that ships without Clerk env until launch.
//
// Reports presence-only of Clerk env vars; never returns key values. Useful
// for: smoke tests asserting the deploy is sane, ops verifying which Pages
// project has which env scope set, and humans diagnosing auth-route 503s.
//
// Also reports a NON-SECRET fingerprint of INVITE_SECRET (length + a short
// SHA-256 prefix, NEVER the value). The deploy-time anon-handshake smoke
// (scripts/anon-handshake-smoke.mjs) compares this against the relay's
// behavior to catch the web↔relay secret-DRIFT that silently rejects every
// anonymous invite guest. Fingerprinting is one-way, so exposing it leaks no
// more than "two deploys share a secret or they don't".

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env as privateEnv } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';
import { probeHocuspocus, probeDatabase } from './probe';
import { sql } from '$lib/server/db';

/** SHA-256 prefix of a secret value, or null if unset. One-way; the value is
 *  never recoverable from this. Matches the fingerprint() in
 *  scripts/sync-secrets.sh + scripts/anon-handshake-smoke.mjs. */
async function fingerprint(value: string | undefined): Promise<string | null> {
  if (!value) return null;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  let hex = '';
  for (const b of new Uint8Array(digest)) hex += b.toString(16).padStart(2, '0');
  return `len=${value.length} sha256:${hex.slice(0, 8)}`;
}

export const GET: RequestHandler = async () => {
  const hasSecret = Boolean(privateEnv.CLERK_SECRET_KEY);
  const hasPublishable = Boolean(publicEnv.PUBLIC_CLERK_PUBLISHABLE_KEY);
  const inviteSecretFingerprint = await fingerprint(privateEnv.INVITE_SECRET);

  // Build-time vars (baked by Vite; CF Pages dashboard env is runtime-only and
  // never reaches the bundle). VITE_SERVER_WS_URL points at this tier's relay;
  // VITE_APP_VERSION is the deployed web build version (see deploy.yml).
  const buildEnv = import.meta.env as Record<string, string | undefined>;
  // Cross-tier signal: probe the relay /health so this single web endpoint
  // reflects relay reachability too. Hard 1.5s cap; never throws.
  const hocuspocus = await probeHocuspocus(buildEnv.VITE_SERVER_WS_URL);

  // REAL DB read probe (not presence-only): an information_schema lookup for the
  // racks.mode column (the migration-005 marker). Replaces the old
  // `DATABASE_URL ? 'configured'` check that returned 200 while every racks.mode
  // read 500'd for a week (deploy-before-migrate — the /r/[id] P0). Bounded +
  // never throws; runs the Neon HTTP tagged template (Workers-safe).
  const hasDb = Boolean(privateEnv.DATABASE_URL);
  const database = await probeDatabase(hasDb, {
    queryModeColumnCount: async () => {
      const rows = await sql()`
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'racks' AND column_name = 'mode'
        LIMIT 1`;
      return (rows as unknown[]).length;
    },
  });

  return json({
    // ok + HTTP 200 stay constant for backward-compat with existing uptime
    // monitors + @smoke; operational state lives in `status` + `deps`, so
    // monitors match on the body field (the live-smoke now alerts on
    // deps.database too — see scripts/live-smoke-alert.sh).
    ok: true,
    // 'down' = a critical dependency (DB) is UNREACHABLE; 'degraded' = the relay
    // is down OR the schema is pre-005 (app runs, on the dawless fallback);
    // 'healthy' = all green.
    status: !database.ok
      ? 'down'
      : !hocuspocus.ok || database.schema !== 'current'
        ? 'degraded'
        : 'healthy',
    version: buildEnv.VITE_APP_VERSION ?? 'unknown',
    auth: hasSecret && hasPublishable ? 'configured' : 'missing',
    // REAL read result (was presence-only 'configured'): 'ok' = reachable +
    // schema current; 'degraded' = reachable but pre-005 (mode column absent);
    // 'error' = unreachable; 'missing' = no DATABASE_URL. Full probe in
    // deps.database.
    db: !hasDb ? 'missing' : !database.ok ? 'error' : database.schema === 'current' ? 'ok' : 'degraded',
    env: {
      CLERK_SECRET_KEY: hasSecret,
      PUBLIC_CLERK_PUBLISHABLE_KEY: hasPublishable,
      INVITE_SECRET: Boolean(privateEnv.INVITE_SECRET),
    },
    // Non-secret fingerprint of INVITE_SECRET for drift detection (see header).
    inviteSecretFingerprint,
    // Downstream-dependency reachability. `hocuspocus.ok` + `database.ok`/schema
    // drive `status` above; the live-smoke alerts on `database` too.
    deps: { hocuspocus, database },
  });
};
