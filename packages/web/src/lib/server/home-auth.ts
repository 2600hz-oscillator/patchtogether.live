// packages/web/src/lib/server/home-auth.ts
//
// Server-side auth read for the COOP/COEP-isolated routes (the public
// canvas at `/`) where we DON'T mount the client <ClerkProvider>.
//
// Why this exists: `/` keeps SharedArrayBuffer / crossOriginIsolated for
// the audio engine, and Clerk's client scripts break cross-origin
// isolation — so hooks.server.ts deliberately skips the Clerk handler on
// `/` (event.locals.auth() is a signed-out no-op there). Without this,
// a genuinely-signed-in user loading `/` saw a "Sign in" header even
// though their session cookie was valid the whole time (clicking it then
// "signed them in" instantly because the session already existed).
//
// The fix: read + verify the Clerk session cookie (`__session`) here,
// SERVER-SIDE, and hand `isSignedIn` (+ minimal display info) to the root
// layout so the header renders correctly without the client provider.
//
// Crucially this never triggers Clerk's handshake/redirect flow (which
// `authenticateRequest` can) — `verifyToken` is a local JWT verification
// against cached JWKs. For anonymous requests (no cookie) it does NO work
// and NO network call, so it doesn't reintroduce the test-instance
// rate-limit problem the hooks.server.ts comments warn about. The
// best-effort `getUser` call for avatar/name only runs when a session is
// already valid (signed-in `/` loads are rare vs. anonymous traffic).

import type { Cookies } from '@sveltejs/kit';
import { verifyToken } from '@clerk/backend';
import { clerkClient } from 'svelte-clerk/server';
import { env as privateEnv } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';

// Clerk's session JWT cookie name (see @clerk/backend constants `Cookies.Session`).
const SESSION_COOKIE = '__session';

export interface HomeAuthState {
  /** True iff the request carries a valid Clerk session cookie. */
  isSignedIn: boolean;
  /** Clerk user id (`sub`), present only when signed in. */
  userId: string | null;
  /** Best-effort avatar URL for the header (null if unavailable). */
  imageUrl: string | null;
  /** Best-effort 1–2 char initials for an avatar fallback. */
  initials: string | null;
}

const SIGNED_OUT: HomeAuthState = {
  isSignedIn: false,
  userId: null,
  imageUrl: null,
  initials: null,
};

function clerkConfigured(): boolean {
  return Boolean(privateEnv.CLERK_SECRET_KEY && publicEnv.PUBLIC_CLERK_PUBLISHABLE_KEY);
}

function initialsFrom(firstName: string | null, lastName: string | null): string | null {
  const f = (firstName ?? '').trim();
  const l = (lastName ?? '').trim();
  const out = `${f.charAt(0)}${l.charAt(0)}`.toUpperCase().trim();
  return out.length > 0 ? out : null;
}

/**
 * Read the Clerk session from the request cookie WITHOUT the client
 * provider or a Clerk handshake. Returns a signed-out state for anonymous
 * requests, on any verification failure, or when Clerk isn't configured —
 * never throws, so it's safe to call from a layout load that runs on every
 * `/` request.
 */
export async function readHomeAuth(cookies: Cookies): Promise<HomeAuthState> {
  if (!clerkConfigured()) return SIGNED_OUT;
  const token = cookies.get(SESSION_COOKIE);
  if (!token) return SIGNED_OUT;

  let userId: string;
  try {
    const claims = await verifyToken(token, {
      secretKey: privateEnv.CLERK_SECRET_KEY,
    });
    if (!claims.sub) return SIGNED_OUT;
    userId = claims.sub;
  } catch {
    // Expired / malformed / wrong-instance cookie → treat as signed out.
    // (Clicking "Sign in" will then run the real workflow on a Clerk route.)
    return SIGNED_OUT;
  }

  // Session is valid. Avatar/name is a nice-to-have, not required for the
  // signed-in header — degrade gracefully if the API call fails.
  let imageUrl: string | null = null;
  let initials: string | null = null;
  try {
    const user = await clerkClient.users.getUser(userId);
    imageUrl = user.hasImage ? user.imageUrl : null;
    initials = initialsFrom(user.firstName, user.lastName);
  } catch {
    // ignore — still signed in, just without avatar/name details.
  }

  return { isSignedIn: true, userId, imageUrl, initials };
}
