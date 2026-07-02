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
//      it). COEP is `credentialless` (keeps cross-origin isolation for SAB
//      while letting no-cors third-party media — e.g. ARCHIVIST's archive.org
//      <video>/<audio>/<img> — actually load; see setCoopCoepHeaders below).
//      In production, packages/web/_headers is the belt-and-suspender;
//      hooks.server.ts handles dev + edge cases.

import type { Handle, HandleServerError } from '@sveltejs/kit';
import { sequence } from '@sveltejs/kit/hooks';
import { withClerkHandler } from 'svelte-clerk/server';
import { env as privateEnv } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';
import { sentryEnabled } from '$lib/observability/sentry-config';

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
// Prefix carve-out: anything under /api/test/ is dev/test-only (handlers
// gate themselves on env vars; see routes/api/test/seed-rackspace/+server.ts).
// We skip Clerk on these so e2e specs running without a Clerk session don't
// trip the rate-limit-on-anonymous path.
const PUBLIC_API_PREFIXES = ['/api/test/'];

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
    !PUBLIC_API_PATHS.some((p) => path === p) &&
    !PUBLIC_API_PREFIXES.some((p) => path.startsWith(p));
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

// COOP/COEP enable SharedArrayBuffer for Faust's WASM thread, but they also
// block third-party resources without CORP headers — including Clerk's
// Turnstile widget on /sign-in/sso-callback. Auth routes don't need SAB,
// so we scope these headers to routes that DO: the scratch canvas at `/rack`
// and the rack canvas at `/r/`. Everything else (the prerendered landing at
// `/`, sign-in/up, dashboard, docs, api) gets no isolation headers and can
// load Clerk's widgets.
//
// NOTE (landing-page overhaul): isolation is enforced GLOBALLY by
// packages/web/_headers `/*` (prod / CF Pages) and vite.config.ts
// `server`/`preview` headers (dev / preview / e2e). The ISOLATED_EXACT set
// below is route-keyed belt-and-suspenders for the dev/hooks path — it is NOT
// what makes a route isolated. `/rack` (the moved canvas) is listed here; `/`
// (the new static landing) is NOT — the landing needs no SharedArrayBuffer.
//
// COEP MODE = `credentialless` (NOT `require-corp`). Both keep the page
// cross-origin-ISOLATED (so `crossOriginIsolated === true` and SharedArrayBuffer
// / Faust WASM threads keep working — verified), but `require-corp` BLOCKS every
// cross-origin no-cors subresource that doesn't send a `Cross-Origin-Resource-
// Policy` header, while `credentialless` instead loads such subresources WITHOUT
// credentials and does NOT require CORP. This is what lets ARCHIVIST (and any
// future external media source) actually PLAY archive.org `<video>`/`<audio>` /
// load `<img>`: archive.org's final CDN hop sends neither CORP nor (reliably)
// CORS, so under `require-corp` the media was blocked outright (net::ERR_BLOCKED_
// BY_RESPONSE.NotSameOriginAfterDefaultedToSameOriginByCoep) — it never even
// reached the "tainted texture" stage. Under `credentialless` it loads + plays;
// a no-cors media element is still opaque to the canvas, so the documented
// play-only / no-clean-video-texture limitation is UNCHANGED. `credentialless`
// is supported by Chromium (96+) and Firefox; a browser that doesn't honour it
// simply falls back to a less-isolated state (SAB-gated features already probe
// `crossOriginIsolated`).
//
// `/present` (the second-display popup sink) ALSO gets COOP `same-origin` here
// — NOT for SAB, but so the popup shares a browsing-context group with its
// opener (`/rack` or `/r/`, both COOP `same-origin`). With a MISMATCHED COOP the
// browser severs the opener relationship: the popup's `window.opener` becomes
// null AND the opener loses cross-window DOM access — so the present handshake
// (popup → opener `present:ready`) and the opener's per-frame canvas blit into
// the popup both silently break (a BLACK popup). In production the `_headers`
// `/*` rule already covered `/present`; this makes DEV match prod so the
// pipeline works locally + is e2e-testable. See routes/present/+page.svelte.
const SAB_ROUTES = ['/r/'];
// `/rack` = the scratch canvas (moved off `/` in the landing-page overhaul);
// `/present` = the second-display popup sink. `/` is intentionally absent — the
// static landing that now lives there needs no cross-origin isolation.
const ISOLATED_EXACT = new Set(['/rack', '/present']);
const setCoopCoepHeaders: Handle = async ({ event, resolve }) => {
  const response = await resolve(event);
  const path = event.url.pathname;
  const needsIsolation =
    ISOLATED_EXACT.has(path) || SAB_ROUTES.some((p) => path.startsWith(p));
  if (needsIsolation) {
    response.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    response.headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
  }
  return response;
};

// Username is fixed (just for the basic-auth dialog UX); the password is
// the only secret. Contributors should set BETA_GATE_USER too if they want
// a non-default username, but `beta` is fine in 99% of cases.
const BETA_GATE_USER_DEFAULT = 'beta';
// Carve-outs:
//   - /                 — the prerendered public landing / front door (the
//                        canvas moved to /rack in the landing-page overhaul).
//                        Anon + crawlers must get 200 here, or the SEO/first-
//                        paint rationale for the whole move is defeated. This is
//                        an EXACT match (BETA_GATE_PUBLIC_PATHS, not a prefix) —
//                        it opens ONLY `/`, never the gated app under it.
//   - /api/health      — uptime monitors + ops smoke probes need this
//                        reachable without a credential prompt.
//   - /docs (+ /docs/*) — the in-app docs site is public on every tier so
//                        prospective users can read it without punching a
//                        beta-gate password.
const BETA_GATE_PUBLIC_PATHS = ['/', '/api/health'];
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

// Better Stack Logs HTTP ingest for the PROD web access log. Pure gating helper
// (unit-tested): returns the POST target only when BOTH the source token and
// ingest host are set. Unset in dev / CI / prod-before-provisioning → null → the
// ship is a straight no-op, so nothing changes until the secret is set on the CF
// Pages prod project. Kept separate from the fetch so the env-gating logic is
// deterministically testable without mocking the network.
export function accessLogShipTarget(
  token: string | undefined,
  host: string | undefined,
): { url: string; token: string } | null {
  if (!token || !host) return null;
  // host may be a bare ingest host ("sNNN.…betterstackdata.com") or a full URL.
  const url = /^https?:\/\//.test(host) ? host : `https://${host}`;
  return { url, token };
}

// Fire-and-forget ship of one access-log line to Better Stack. Uses the CF
// runtime's waitUntil so the POST flushes without delaying the response (and the
// isolate doesn't tear down mid-request), and swallows its own errors —
// telemetry must never slow or break a request. This is what turns the console
// access-log line below into a queryable prod-traffic + error-rate signal (the
// Better Stack dashboard); see infra-docs runbooks/observability.md.
function shipAccessLog(
  event: Parameters<Handle>[0]['event'],
  entry: Record<string, unknown>,
): void {
  const target = accessLogShipTarget(
    privateEnv.BETTERSTACK_WEB_SOURCE_TOKEN,
    privateEnv.BETTERSTACK_WEB_INGEST_HOST,
  );
  if (!target) return;
  const ship = fetch(target.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${target.token}`,
    },
    body: JSON.stringify(entry),
  }).catch(() => {
    // best-effort telemetry: a slow/failed drain must never surface to the user
  });
  event.platform?.context?.waitUntil?.(ship);
}

// Per-request correlation id + structured access log. Runs FIRST so it wraps
// every handle (logging the FINAL status — incl beta-gate 401s) and stamps
// x-request-id on the response. The single-line JSON is emitted to the CF tail
// AND shipped to Better Stack (when provisioned) so we can chart prod traffic,
// 401-vs-200 (rejected vs authed beta), 5xx rate, top paths + latency, and
// stitch a browser error report to its server-side request via request_id.
const requestIdAndLog: Handle = async ({ event, resolve }) => {
  const requestId = crypto.randomUUID();
  event.locals.requestId = requestId;
  const start = Date.now();
  const response = await resolve(event);
  response.headers.set('x-request-id', requestId);
  const entry = {
    dt: new Date().toISOString(),
    level: response.status >= 500 ? 'error' : 'info',
    msg: 'request',
    request_id: requestId,
    method: event.request.method,
    path: event.url.pathname,
    status: response.status,
    ms: Date.now() - start,
  };
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(entry));
  shipAccessLog(event, entry);
  return response;
};

// Server/Worker error tracking via Sentry — FULLY ENV-GATED on PUBLIC_SENTRY_DSN.
// With the DSN unset (local dev, CI, prod-before-provisioning) this handle is a
// straight pass-through and handleError falls back to the default shape, so
// nothing changes until a Sentry account is provisioned. The actual SDK
// (@sentry/cloudflare — the one that bundles for the CF Workers runtime; the
// @sentry/sveltekit server path does NOT, see lib/observability/sentry-server.ts)
// is only ever imported via the dynamic import below, so an absent DSN means the
// SDK never enters the request path at all.
const SENTRY_DSN = publicEnv.PUBLIC_SENTRY_DSN;

const sentryServerHandle: Handle = async ({ event, resolve }) => {
  if (!sentryEnabled(SENTRY_DSN)) return resolve(event);
  const { ensureSentryServer, captureServerError } = await import(
    '$lib/observability/sentry-server'
  );
  ensureSentryServer(SENTRY_DSN);
  try {
    return await resolve(event);
  } catch (err) {
    // Capture the error that escaped the inner handles, then rethrow so
    // SvelteKit's normal error handling (handleError + the error page) runs.
    captureServerError(err);
    throw err;
  }
};

// handleError fires for every uncaught server-side error SvelteKit catches
// (load functions, endpoints, render). Forward to Sentry only when enabled;
// always return the same default-shaped message so the error UX is unchanged
// when Sentry is off.
export const handleError: HandleServerError = async ({ error, event }) => {
  if (sentryEnabled(SENTRY_DSN)) {
    try {
      const { ensureSentryServer, captureServerError } = await import(
        '$lib/observability/sentry-server'
      );
      ensureSentryServer(SENTRY_DSN);
      captureServerError(error);
    } catch {
      // Never let observability wiring turn an app error into a worse one.
    }
  }
  const requestId = event.locals?.requestId;
  return { message: 'Internal Error', ...(requestId ? { requestId } : {}) };
};

// Sentry runs FIRST so its try/catch wraps every other handle (it sees errors
// that beta-gate / Clerk / COOP-COEP throw before SvelteKit's handleError does).
export const handle = sequence(
  sentryServerHandle,
  requestIdAndLog,
  betaGate,
  conditionalClerk,
  setCoopCoepHeaders,
);
