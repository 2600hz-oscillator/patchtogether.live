// packages/web/src/routes/+layout.server.ts
//
// Two jobs:
//   1. Hand Clerk's auth state (userId, sessionId, etc.) to the client so
//      <ClerkProvider> can render the right UI without a round-trip. This
//      only matters on the auth routes where the provider is mounted
//      (see +layout.svelte AUTH_PREFIXES); on `/` the provider is OFF to
//      preserve SharedArrayBuffer / cross-origin isolation for audio.
//   2. Derive auth state SERVER-SIDE for the routes that DON'T mount the
//      provider (the public canvas at `/`), so the header can show the
//      account when a session cookie is present instead of always
//      rendering "Sign in". See lib/server/home-auth.ts for why the
//      client provider can't be used there.

import type { LayoutServerLoad } from './$types';
import { buildClerkProps } from 'svelte-clerk/server';
import { readHomeAuth } from '$lib/server/home-auth';

// Routes that mount the client <ClerkProvider> (mirror of +layout.svelte's
// AUTH_PREFIXES). On these the provider resolves auth client-side, so the
// extra server-side read here is unnecessary; everywhere else (notably `/`)
// we derive it server-side.
const AUTH_PREFIXES = ['/dashboard', '/r/', '/sign-in', '/sign-up'];

export const load: LayoutServerLoad = async ({ locals, cookies, url }) => {
  const isAuthRoute = AUTH_PREFIXES.some(
    (p) => url.pathname === p || url.pathname.startsWith(p),
  );
  const homeAuth = isAuthRoute
    ? { isSignedIn: false, userId: null, imageUrl: null, initials: null }
    : await readHomeAuth(cookies);
  return {
    ...buildClerkProps(locals.auth()),
    homeAuth,
  };
};
