// packages/web/src/routes/+layout.server.ts
//
// Hands Clerk's auth state (userId, sessionId, etc.) to the client so
// <ClerkProvider> can render the right UI without a round-trip.
//
// We ALSO surface a plain `isAuthed` boolean for EVERY route — including the
// landing page `/`, where we deliberately do NOT mount <ClerkProvider> so the
// page keeps its SharedArrayBuffer / cross-origin-isolation headers (Clerk's
// CDN can't be loaded under COEP=require-corp; see +layout.svelte). Without
// this, the client on `/` had no way to read the existing server session and
// always rendered "Sign in" even for logged-in users.
//
// Subtlety: hooks.server.ts only runs Clerk's middleware on AUTH_PREFIXES
// (NOT `/`) to avoid hammering Clerk's API with anonymous landing-page hits
// (test-instance rate limits → 429s). So on `/`, `locals.auth().userId` is
// always null. To know "is this visitor logged in" on `/` WITHOUT a Clerk API
// round-trip (preserving that rate-limit protection) and WITHOUT mounting any
// Clerk JS (preserving SAB), we read the `__session` cookie locally and check
// its JWT `exp` claim. We deliberately do NOT verify the signature: this only
// gates a cosmetic header affordance ("Dashboard" vs "Sign in"). A forged or
// stale cookie at worst shows "Dashboard" to someone who then gets bounced by
// the dashboard route's real Clerk auth — no protected data is exposed here.

import type { LayoutServerLoad } from './$types';
import { buildClerkProps } from 'svelte-clerk/server';

/** Cheap, signature-free check that a Clerk session JWT cookie is present and
 *  not past its `exp`. Used only for the cosmetic landing-page affordance —
 *  see the file header for why no verification is needed. */
export function sessionCookieLooksAuthed(token: string | undefined | null): boolean {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  try {
    // base64url → JSON payload
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '='));
    const payload = JSON.parse(json) as { exp?: number };
    if (typeof payload.exp === 'number') {
      return payload.exp * 1000 > Date.now();
    }
    // No exp claim — treat presence of a well-formed token as authed.
    return true;
  } catch {
    return false;
  }
}

export const load: LayoutServerLoad = ({ locals, cookies }) => {
  const auth = locals.auth();
  // Prefer the authoritative server auth (set on auth routes); fall back to
  // the cookie heuristic on `/` where Clerk's middleware doesn't run.
  const isAuthed = !!auth.userId || sessionCookieLooksAuthed(cookies.get('__session'));
  return {
    ...buildClerkProps(auth),
    isAuthed,
  };
};
