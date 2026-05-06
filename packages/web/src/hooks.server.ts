// packages/web/src/hooks.server.ts
//
// Server-side request middleware. Two handles composed in sequence:
//
//   1. Clerk auth — populates event.locals.auth with session info every
//      request, lets +page.server.ts loaders use locals.auth.userId.
//   2. COOP/COEP headers — required for SharedArrayBuffer (Faust may use
//      it). In production, packages/web/_headers is the belt-and-suspender;
//      hooks.server.ts handles dev + edge cases.

import type { Handle } from '@sveltejs/kit';
import { sequence } from '@sveltejs/kit/hooks';
import { withClerkHandler } from 'svelte-clerk/server';

const clerkHandle = withClerkHandler();

// We only run Clerk's middleware on routes that actually need auth state.
// Hitting Clerk's API on every anonymous `/` page load runs the test-instance
// rate limit into the ground (parallel Playwright workers all asking Clerk
// "what's the auth status of this anonymous request?" at once → 429s).
//
// Auth-touched routes — dashboard, the /r/[id] rackspace canvas, all
// /api/rackspaces endpoints, plus the sign-in/sign-up pages themselves so
// Clerk's components can talk to it — get the full handler. Everything
// else (the public canvas at /, static assets, smoke tests) bypasses it
// and runs as anonymous.
const AUTH_PREFIXES = ['/dashboard', '/r/', '/api/', '/sign-in', '/sign-up'];

const conditionalClerk: Handle = async ({ event, resolve }) => {
  const path = event.url.pathname;
  const needsAuth = AUTH_PREFIXES.some((p) => path === p || path.startsWith(p));
  if (!needsAuth) {
    // Provide a no-op auth() so layout/loader code that opt-in calls it
    // doesn't crash on public routes.
    event.locals.auth = (() => ({
      tokenType: 'session_token',
      userId: null,
      sessionId: null,
      sessionClaims: null,
      sessionStatus: 'signed-out',
      actor: null,
      orgId: null,
      orgRole: null,
      orgSlug: null,
      orgPermissions: null,
      factorVerificationAge: null,
      getToken: async () => null,
      has: () => false,
      debug: () => ({}),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    })) as any;
    return resolve(event);
  }
  return clerkHandle({ event, resolve });
};

const setCoopCoepHeaders: Handle = async ({ event, resolve }) => {
  const response = await resolve(event);
  response.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  response.headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  return response;
};

export const handle = sequence(conditionalClerk, setCoopCoepHeaders);
