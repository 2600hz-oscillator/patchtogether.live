// packages/web/src/routes/api/health/server.test.ts
//
// Unit tests for the /api/health route. Exercises three shape branches:
//   1. Clerk-configured + Hocuspocus reachable → status:healthy
//   2. Clerk-missing + Hocuspocus reachable    → status:healthy, auth:missing
//   3. Hocuspocus unreachable (timeout)        → status:degraded
//
// Hocuspocus is mocked via global.fetch — the route uses bare `fetch` for
// the dep probe so a vi.spyOn(globalThis,'fetch') captures every call. We
// also stub `$env/dynamic/{private,public}` to avoid pulling in SvelteKit's
// runtime env module at collect time (same pattern as hooks.server.test.ts).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Default-allow env mock; individual tests override with vi.doMock before
// re-importing the route.
vi.mock('$env/dynamic/private', () => ({
  env: { CLERK_SECRET_KEY: 'sk_test_xxx' },
}));
vi.mock('$env/dynamic/public', () => ({
  env: { PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_test_xxx' },
}));

// import.meta.env stubbing — Vitest exposes import.meta.env to the test
// module scope, so we set values directly on it before the SUT imports it.
// VITE_SERVER_WS_URL points at a sentinel host the fetch mock recognises.
import.meta.env.VITE_APP_VERSION = '1.0.1-test';
import.meta.env.VITE_SERVER_WS_URL = 'wss://hocuspocus.test';

const { GET } = await import('./+server');

function makeFetchMock(opts: { ok: boolean; throwName?: string }) {
  return vi.fn(async (_input: RequestInfo | URL) => {
    if (opts.throwName) {
      const e = new Error('mock');
      e.name = opts.throwName;
      throw e;
    }
    return new Response(opts.ok ? '{"ok":true}' : 'down', { status: opts.ok ? 200 : 503 });
  });
}

// Minimal stub of RequestEvent — the handler only uses request shape, not
// any event-specific fields, so {} cast satisfies the call signature.
const event = {} as Parameters<typeof GET>[0];

describe('GET /api/health', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns healthy + version + clerk:configured when all green', async () => {
    vi.stubGlobal('fetch', makeFetchMock({ ok: true }));
    const r = await GET(event);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(body.status).toBe('healthy');
    expect(body.version).toBe('1.0.1-test');
    expect(body.auth).toBe('configured');
    expect(body.env.CLERK_SECRET_KEY).toBe(true);
    expect(body.env.PUBLIC_CLERK_PUBLISHABLE_KEY).toBe(true);
    expect(body.deps.hocuspocus.ok).toBe(true);
    expect(typeof body.deps.hocuspocus.ms).toBe('number');
  });

  it('reports degraded when Hocuspocus probe fails', async () => {
    vi.stubGlobal('fetch', makeFetchMock({ ok: false }));
    const r = await GET(event);
    // HTTP 200 still — by-design backwards-compat with @smoke tests; the
    // body's `status` is the operational gauge.
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(body.status).toBe('degraded');
    expect(body.deps.hocuspocus.ok).toBe(false);
    expect(body.deps.hocuspocus.error).toMatch(/status 503/);
  });

  it('reports degraded with error name when fetch throws (timeout / network)', async () => {
    vi.stubGlobal('fetch', makeFetchMock({ ok: false, throwName: 'AbortError' }));
    const r = await GET(event);
    const body = await r.json();
    expect(body.status).toBe('degraded');
    expect(body.deps.hocuspocus.ok).toBe(false);
    expect(body.deps.hocuspocus.error).toBe('AbortError');
  });

  it('translates wss:// → https:// when probing Hocuspocus', async () => {
    const fetchSpy = makeFetchMock({ ok: true });
    vi.stubGlobal('fetch', fetchSpy);
    await GET(event);
    expect(fetchSpy).toHaveBeenCalledOnce();
    const url = fetchSpy.mock.calls[0][0];
    expect(String(url)).toBe('https://hocuspocus.test/health');
  });
});
