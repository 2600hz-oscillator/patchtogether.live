// packages/web/src/hooks.server.ts
//
// Server-side request middleware. Three handles composed in sequence:
//
//   1. Beta gate — basic-auth gate while in beta. Off when BETA_GATE_PASS
//      is unset (local dev), so contributors don't have to keep punching
//      a credential prompt. /api/health (uptime monitors) and /docs/*
//      (the in-app docs site, which is public on every tier) are exempt.
//   2. Clerk auth — populates event.locals.auth with session info every
//      request, lets +page.server.ts loaders use locals.auth.userId.
//   3. COOP/COEP headers — required for SharedArrayBuffer (Faust may use
//      it). In production, packages/web/_headers is the belt-and-suspender;
//      hooks.server.ts handles dev + edge cases.

import type { Handle } from '@sveltejs/kit';
import { sequence } from '@sveltejs/kit/hooks';
import { withClerkHandler } from 'svelte-clerk/server';
import { env as privateEnv } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';

const clerkHandle = withClerkHandler();

// We only run Clerk's middleware on routes that actually need auth state.
// Hitting Clerk's API on every anonymous `/` page load runs the test-instance
// rate limit into the ground (parallel Playwright workers all asking Clerk
// "what's the auth status of this anonymous request?" at once → 429s).
//
// Auth-touched routes — dashboard, the /r/[id] rackspace canvas, all
// /api/rackspaces endpoints (except /api/health, which is public), plus the
// sign-in/sign-up pages so Clerk's components can talk to it — get the full
// handler. Everything else (the public canvas at /, static assets, smoke
// tests) bypasses it and runs as anonymous.
const AUTH_PREFIXES = ['/dashboard', '/r/', '/api/', '/sign-in', '/sign-up'];
// Carve-outs from AUTH_PREFIXES — public API routes that should never trigger
// the Clerk handler. /api/health is the canonical example: ops needs to be
// able to probe it from anywhere, including environments where Clerk isn't
// configured.
const PUBLIC_API_PATHS = ['/api/health'];

function attachNoOpAuth(event: Parameters<Handle>[0]['event']): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
  })) as any;
}

/** True iff the deploy has both Clerk env vars set (in Cloudflare Pages,
 *  via platform.env; in dev, via .env.local). False is a valid prod
 *  configuration today (we ship without auth until launch) — we just need
 *  to render auth-route requests as a clear 503 instead of a 500. */
function clerkConfigured(): boolean {
  return Boolean(privateEnv.CLERK_SECRET_KEY && publicEnv.PUBLIC_CLERK_PUBLISHABLE_KEY);
}

const conditionalClerk: Handle = async ({ event, resolve }) => {
  const path = event.url.pathname;
  const needsAuth =
    AUTH_PREFIXES.some((p) => path === p || path.startsWith(p)) &&
    !PUBLIC_API_PATHS.some((p) => path === p);
  if (!needsAuth) {
    attachNoOpAuth(event);
    return resolve(event);
  }
  if (!clerkConfigured()) {
    // Auth route hit on a deploy without Clerk env. Don't crash with a 500
    // (that's what was happening before this guard) — return a clear,
    // diagnosable 503 so ops sees "auth not configured" instead of an
    // opaque internal error. Probe /api/health to confirm env shape.
    console.warn(
      `[auth] ${path} requested but Clerk env missing ` +
        `(CLERK_SECRET_KEY=${!!privateEnv.CLERK_SECRET_KEY}, ` +
        `PUBLIC_CLERK_PUBLISHABLE_KEY=${!!publicEnv.PUBLIC_CLERK_PUBLISHABLE_KEY})`,
    );
    return new Response(
      'Auth not configured for this environment. ' +
        'Probe /api/health for details. This is expected on the prod project ' +
        'until launch; on autotest/dev/PR-preview it indicates a Cloudflare ' +
        'Variables-and-Secrets gap (likely the Preview scope).\n',
      {
        status: 503,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
        },
      },
    );
  }
  return clerkHandle({ event, resolve });
};

const setCoopCoepHeaders: Handle = async ({ event, resolve }) => {
  const response = await resolve(event);
  response.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  response.headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  return response;
};

// Username is fixed (just for the basic-auth dialog UX); the password is
// the only secret. Contributors should set BETA_GATE_USER too if they want
// a non-default username, but `beta` is fine in 99% of cases.
const BETA_GATE_USER_DEFAULT = 'beta';
// Carve-outs:
//   - /api/health      — uptime monitors + ops smoke probes need this
//                        reachable without a credential prompt.
//   - /docs (+ /docs/*) — the in-app docs site is public on every tier so
//                        prospective users can read it without punching a
//                        beta-gate password.
const BETA_GATE_PUBLIC_PATHS = ['/api/health'];
const BETA_GATE_PUBLIC_PREFIXES = ['/docs/'];

export function isBetaGatePublic(pathname: string): boolean {
  if (BETA_GATE_PUBLIC_PATHS.includes(pathname)) return true;
  if (pathname === '/docs') return true;
  return BETA_GATE_PUBLIC_PREFIXES.some((p) => pathname.startsWith(p));
}

const betaGate: Handle = async ({ event, resolve }) => {
  const pass = privateEnv.BETA_GATE_PASS;
  if (!pass) {
    // Gate disabled (local dev, or any deploy without the env set).
    return resolve(event);
  }
  if (isBetaGatePublic(event.url.pathname)) {
    return resolve(event);
  }
  const expectedUser = privateEnv.BETA_GATE_USER || BETA_GATE_USER_DEFAULT;
  const header = event.request.headers.get('authorization') ?? '';
  const expected = 'Basic ' + btoa(`${expectedUser}:${pass}`);
  // Constant-time compare so we don't leak length info via timing.
  if (header.length === expected.length && timingSafeEqual(header, expected)) {
    return resolve(event);
  }
  return new Response('Authentication required.\n', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="patchtogether.live (beta)", charset="UTF-8"',
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
};

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export const handle = sequence(betaGate, conditionalClerk, setCoopCoepHeaders);
