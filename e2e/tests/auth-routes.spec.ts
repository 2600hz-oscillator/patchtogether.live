// e2e/tests/auth-routes.spec.ts
//
// Shape-of-auth tests. Asserts that auth-touched routes serve sane responses
// in every deployment configuration — Clerk-configured envs (autotest, dev,
// PR previews once env is set) AND no-Clerk envs (prod until launch).
//
// Critically: NO route should ever return 500. The original PR-2 preview
// shipped with /sign-in and /dashboard 500ing because withClerkHandler threw
// when env vars weren't in the Preview scope. Nothing caught that until the
// user manually tried to sign in. These specs run in @smoke so live deploys
// flag the regression class going forward.
//
// These tests are credential-free on purpose. Full credentialed flow lands
// in a separate spec once we provision Clerk test users for the autotest
// instance (see roadmap discussion).

import { test, expect } from '@playwright/test';

/**
 * True when this run targets a DEPLOYED tier (the live smoke) rather than a
 * local dev/preview server.
 *
 * Why it's needed: the CI e2e lane sets DATABASE_URL to a LOCAL Postgres
 * service container, but `$lib/server/db.ts` always drives the Neon **HTTP**
 * driver — which cannot speak to a raw local Postgres socket. So on CI the
 * health probe legitimately reports the database as unreachable. Gating on a
 * live target keeps the assertion below out of the REQUIRED
 * `typecheck + unit + ART + E2E` lane entirely, where it would otherwise go
 * red for a reason that says nothing about the deploy.
 */
const IS_LIVE_TARGET = /^https?:\/\/(?!localhost|127\.0\.0\.1)/.test(
  process.env.E2E_BASE_URL ?? '',
);

test.describe('auth-route shape', () => {
  test('GET /api/health returns 200 with auth state @smoke', async ({ request }) => {
    const r = await request.get('/api/health');
    expect(r.status(), `health 200; got ${r.status()}`).toBe(200);
    const body = await r.json();
    expect(body.ok, 'health.ok').toBe(true);
    expect(['configured', 'missing']).toContain(body.auth);
    expect(typeof body.env.CLERK_SECRET_KEY).toBe('boolean');
    expect(typeof body.env.PUBLIC_CLERK_PUBLISHABLE_KEY).toBe('boolean');
    // INVITE_SECRET presence + non-secret fingerprint (drift-detection input
    // for the anon-handshake smoke). Fingerprint is null when unset; a
    // `len=.. sha256:..` string otherwise — never the value itself.
    expect(typeof body.env.INVITE_SECRET).toBe('boolean');
    expect(
      body.inviteSecretFingerprint === null ||
        /^len=\d+ sha256:[0-9a-f]{8}$/.test(body.inviteSecretFingerprint),
      `inviteSecretFingerprint must be null or a fingerprint string; got ${body.inviteSecretFingerprint}`,
    ).toBe(true);
  });

  test('GET /api/health surfaces observability fields (status/version/deps) @smoke', async ({
    request,
  }) => {
    const r = await request.get('/api/health');
    expect(r.status(), `health 200; got ${r.status()}`).toBe(200);
    const body = await r.json();
    // `status` reflects relay + DB reachability; ALL THREE are valid in a smoke
    // env — the relay may be unreachable from the test runner (degraded), and a
    // DB-less/unreachable-DB runner is honestly 'down'. Assert the contract
    // shape (a known verdict), not a specific health outcome.
    expect(['healthy', 'degraded', 'down'], `status; got ${body.status}`).toContain(body.status);
    expect(typeof body.version, 'version is a string').toBe('string');
    // deps.hocuspocus is the cross-tier relay probe.
    expect(body.deps?.hocuspocus, 'deps.hocuspocus present').toBeTruthy();
    expect(typeof body.deps.hocuspocus.ok, 'deps.hocuspocus.ok is boolean').toBe('boolean');
    // deps.database is PRESENT but NOT PROBED on the shallow default — the DB
    // read is opt-in (`?deep=1`) because this endpoint is polled every 3
    // minutes and a query on that path kept Neon awake 24/7 (99.8% of the
    // bill; the 2026-07-29 HTTP 402 outage). Assert the shallow contract
    // explicitly, so a regression that silently re-adds the query is visible
    // here rather than only on the invoice.
    expect(body.deps?.database, 'deps.database present').toBeTruthy();
    expect(body.deps.database.probed, 'shallow /api/health must NOT probe the DB').toBe(false);
    expect(body.deps.database.ok, 'unprobed reports ok=null, not a boolean verdict').toBeNull();
    expect(body.db, 'db field says unprobed on the shallow path').toBe('unprobed');
    // …and an unprobed DB must never be reported as an outage.
    expect(body.status, 'shallow must not report down from an unprobed DB').not.toBe('down');
  });

  // The DEEP probe: same endpoint, `?deep=1`, actually reads the database.
  // This is the contract the live-smoke script depends on every 10 minutes.
  test('GET /api/health?deep=1 runs the REAL DB read @smoke', async ({ request }) => {
    const r = await request.get('/api/health?deep=1');
    expect(r.status(), `health 200; got ${r.status()}`).toBe(200);
    const body = await r.json();
    expect(body.deps?.database, 'deps.database present').toBeTruthy();
    expect(body.deps.database.probed, 'deep must actually probe').toBe(true);
    expect(typeof body.deps.database.ok, 'deps.database.ok is boolean when probed').toBe('boolean');
    if (body.deps.database.ok) {
      expect(['current', 'mode-missing'], `db schema; got ${body.deps.database.schema}`).toContain(
        body.deps.database.schema,
      );
    }
  });

  // A DEPLOYED tier that HAS a database configured must be able to REACH it.
  //
  // Why this exists: `/r/[id]` used to answer an unreachable database with an
  // opaque 500, so the "must not 500" specs below doubled as the outage alarm.
  // Now that the loader correctly degrades to a 503 (see
  // $lib/server/db-availability), those specs would go GREEN during a total
  // database outage — the deploy gate would have stopped reporting the very
  // condition that took every rackspace URL down on 2026-07-28 (Neon compute
  // quota exhausted → HTTP 402 on autotest, dev AND prod for ~24h).
  //
  // So the outage assertion moves here, where it belongs: it names the real
  // condition instead of inferring it from a crash.
  //
  // Scope notes:
  //   • LIVE targets only — see IS_LIVE_TARGET above (CI's local Postgres is
  //     unreachable over the Neon HTTP driver by construction).
  //   • `db: 'missing'` (no DATABASE_URL — prod before launch, a DB-less
  //     preview) is exempt: an absent database is a valid configuration, an
  //     unreachable one is not.
  test('deployed tier can REACH its configured database @smoke', async ({ request }) => {
    test.skip(!IS_LIVE_TARGET, 'live-deploy only (E2E_BASE_URL must be a remote host)');

    // ⚠ `?deep=1` IS REQUIRED. `/api/health` is SHALLOW by default and does not
    // touch Postgres — it is polled every 3 minutes by uptime monitors, and a DB
    // read on that path kept Neon awake 24/7 (99.8% of the bill). Without the
    // flag `deps.database.ok` is `null` (not probed) and this assertion fails
    // with "Probe error: none reported" — which is precisely the trap: there is
    // no error because the query never ran. THIS TEST FAILED ON MAIN EXACTLY
    // THAT WAY, reporting a healthy autotest tier as an infrastructure outage.
    const body = await (await request.get('/api/health?deep=1')).json();
    test.skip(body.db === 'missing', 'tier has no DATABASE_URL configured — nothing to reach');

    // Assert the probe RAN before trusting its verdict. An unasked question is
    // not a bad answer, and without this the failure above is unreadable.
    expect(
      body.deps.database.probed,
      'the DB probe did not RUN — `?deep=1` was dropped from the request above, ' +
        'or the endpoint stopped honouring it. The reachability verdict below is ' +
        'meaningless until this is true.',
    ).toBe(true);

    expect(
      body.deps.database.ok,
      `Deployed tier reports a configured database it CANNOT REACH — every ` +
        `rackspace URL on this tier is degraded (503). This is an ` +
        `INFRASTRUCTURE/BILLING condition, not a code regression: check the ` +
        `Neon project quota + status first. Probe error: ` +
        `${body.deps.database.error ?? 'none reported'}`,
    ).toBe(true);
  });

  test('responses carry an x-request-id correlation header @smoke', async ({ request }) => {
    const r = await request.get('/api/health');
    const id = r.headers()['x-request-id'];
    expect(id, 'x-request-id header present').toBeTruthy();
    expect(id.length, `x-request-id length >= 16; got "${id}"`).toBeGreaterThanOrEqual(16);
  });

  // Why "not 500" instead of "< 500": 503 is the *expected* response when
  // Clerk env is missing — that's the friendly auth-not-configured page
  // hooks.server.ts returns by design. 500 is what we actually want to
  // forbid: an unhandled exception bubbling up from withClerkHandler. The
  // assertion shape is "no opaque server crash," not "no 5xx of any kind."
  test('GET /sign-in is never a 500 @smoke', async ({ request }) => {
    const r = await request.get('/sign-in');
    expect(
      r.status(),
      `sign-in must not 500; got ${r.status()} (200 = Clerk-configured render, ` +
        `503 = auth-not-configured friendly page, 30x = redirect — all OK; 500 is the failure shape)`,
    ).not.toBe(500);
  });

  test('GET /dashboard is never a 500 @smoke', async ({ request }) => {
    // Dashboard either: 303 redirects to /sign-in (Clerk-configured + unauthed),
    // 200 (Clerk-configured + authed — won't happen in a no-cookie smoke), or
    // 503 (Clerk env missing, friendly page).
    const r = await request.get('/dashboard', { maxRedirects: 0 });
    expect(r.status(), `dashboard must not 500; got ${r.status()}`).not.toBe(500);
  });

  test('GET /r/<id> on a fake id is never a 500 @smoke', async ({ request }) => {
    const r = await request.get('/r/not-a-real-rackspace', { maxRedirects: 0 });
    expect(r.status(), `/r/[id] must not 500; got ${r.status()}`).not.toBe(500);
  });

  test('GET /r/<id>?invite=<bad> on a fake id is never a 500 @smoke', async ({ request }) => {
    // Anon-via-invite (PR B-c) takes a separate code path through the route
    // loader (HMAC verify + early return). Make sure it doesn't 500 either.
    const r = await request.get('/r/not-a-real-rackspace?invite=0000000000000000', {
      maxRedirects: 0,
    });
    expect(
      r.status(),
      `/r/[id]?invite=<bad> must not 500; got ${r.status()}`,
    ).not.toBe(500);
  });

  test('GET /sign-up is never a 500 @smoke', async ({ request }) => {
    const r = await request.get('/sign-up');
    expect(r.status(), `sign-up must not 500; got ${r.status()}`).not.toBe(500);
  });

  // When auth IS configured, sign-in must actually serve a Clerk widget host
  // (not a 503). When auth is NOT configured, the route returns 503 by
  // design. The test branches based on /api/health so both deployment
  // configurations pass.
  test('auth: /sign-in matches the env reported by /api/health', async ({ request, page }) => {
    const health = await (await request.get('/api/health')).json();
    if (health.auth === 'configured') {
      const r = await page.goto('/sign-in');
      expect(r?.status()).toBeLessThan(400);
      // svelte-clerk renders <SignIn /> inside .auth-page wrapper.
      await expect(page.locator('.auth-page')).toBeVisible();
    } else {
      const r = await request.get('/sign-in');
      expect(
        r.status(),
        'auth=missing → /sign-in should be 503 (auth not configured)',
      ).toBe(503);
    }
  });
});
