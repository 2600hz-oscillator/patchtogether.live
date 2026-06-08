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
  return json({
    ok: true,
    auth: hasSecret && hasPublishable ? 'configured' : 'missing',
    // Presence-only signal that the web tier has a Postgres connection string
    // (Phase 2a / FW1). We do NOT connect here — this just lets a deploy smoke
    // catch a web tier missing DATABASE_URL before it 503s on the first query.
    // The actual throw-on-missing in the web db layer lands in Phase 2b.
    db: privateEnv.DATABASE_URL ? 'configured' : 'missing',
    env: {
      CLERK_SECRET_KEY: hasSecret,
      PUBLIC_CLERK_PUBLISHABLE_KEY: hasPublishable,
      INVITE_SECRET: Boolean(privateEnv.INVITE_SECRET),
    },
    // Non-secret fingerprint of INVITE_SECRET for drift detection (see header).
    inviteSecretFingerprint,
  });
};
