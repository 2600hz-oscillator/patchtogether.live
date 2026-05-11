// Public health probe — never trips the Clerk handler (carve-out in
// hooks.server.ts) so it works in every environment, including the prod
// project that ships without Clerk env until launch.
//
// Phase-1 observability expansion:
//   - Reports presence-only of Clerk env vars; never returns key values.
//   - Probes Hocuspocus reachability with a short HEAD timeout.
//   - Exposes the deployed `version` from package.json so an LLM agent can
//     confirm a rollout actually shipped.
//   - Adds `status` ("healthy" | "degraded") and `deps.hocuspocus` so a
//     JSON-keyword uptime monitor can probe operational state.
//
// Backwards compatibility:
//   - HTTP 200 still always returned. The body's `status` field is the new
//     operational gauge — uptime monitors should match on `"status":"healthy"`
//     rather than the HTTP code so the existing `e2e/tests/auth-routes.spec.ts`
//     `expect(r.status()).toBe(200)` and any external caller pattern-matching
//     on body shape don't regress.
//   - `ok`, `auth`, `env` keys preserved exactly.

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env as privateEnv } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';

// Both VITE_APP_VERSION and VITE_SERVER_WS_URL are baked at build time by
// deploy.yml — read from `import.meta.env` rather than SvelteKit's runtime
// env helpers, which only see Cloudflare dashboard variables. Falls back to
// safe defaults so local dev works without the build-step env.
const APP_VERSION = (import.meta.env.VITE_APP_VERSION as string | undefined) ?? 'unknown';
const SERVER_WS_URL = (import.meta.env.VITE_SERVER_WS_URL as string | undefined) ?? '';

// Probe timeout — short enough that a slow dep doesn't stall an uptime
// check, long enough that a healthy server with cold-edge has a chance.
const DEP_PROBE_TIMEOUT_MS = 1500;

type DepStatus = { ok: boolean; ms?: number; error?: string };

async function probeHocuspocus(wsUrl: string | undefined): Promise<DepStatus> {
  if (!wsUrl) return { ok: false, error: 'VITE_SERVER_WS_URL unset' };
  // Translate `wss://host` → `https://host/health`. Hocuspocus exposes a
  // sibling HTTP health endpoint on PORT_HEALTH = PORT + 1 in dev, but in
  // prod (Fly) we proxy through 443 and the server side mounts /health on
  // the same listener. A HEAD with a tight timeout is cheap and avoids
  // body parsing.
  const httpUrl = wsUrl.replace(/^ws:\/\//, 'http://').replace(/^wss:\/\//, 'https://');
  const target = `${httpUrl.replace(/\/$/, '')}/health`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), DEP_PROBE_TIMEOUT_MS);
  const start = Date.now();
  try {
    const r = await fetch(target, { method: 'GET', signal: controller.signal });
    clearTimeout(t);
    return { ok: r.ok, ms: Date.now() - start, error: r.ok ? undefined : `status ${r.status}` };
  } catch (err) {
    clearTimeout(t);
    return {
      ok: false,
      ms: Date.now() - start,
      error: err instanceof Error ? err.name : String(err),
    };
  }
}

export const GET: RequestHandler = async () => {
  const hasSecret = Boolean(privateEnv.CLERK_SECRET_KEY);
  const hasPublishable = Boolean(publicEnv.PUBLIC_CLERK_PUBLISHABLE_KEY);

  // Hocuspocus probe — non-blocking on missing env (prod web ships without
  // Hocuspocus set in some preview tiers); reported as a dep entry only.
  const hocuspocus = await probeHocuspocus(SERVER_WS_URL);

  // Aggregate: `ok` stays true for the auth-shape contract (existing tests
  // expect it). The new top-level `status` is the operational gauge that
  // BetterStack JSON-keyword monitor reads. We deliberately keep the HTTP
  // code at 200 even when degraded so the existing 200-asserting smoke tests
  // continue to pass; uptime monitors should match on the body field.
  const allDepsOk = hocuspocus.ok;

  return json({
    ok: true,
    status: allDepsOk ? 'healthy' : 'degraded',
    version: APP_VERSION,
    auth: hasSecret && hasPublishable ? 'configured' : 'missing',
    env: {
      CLERK_SECRET_KEY: hasSecret,
      PUBLIC_CLERK_PUBLISHABLE_KEY: hasPublishable,
    },
    deps: {
      hocuspocus,
    },
  });
};
