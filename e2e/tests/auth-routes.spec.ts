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

test.describe('auth-route shape', () => {
  test('GET /api/health returns 200 with auth state @smoke', async ({ request }) => {
    const r = await request.get('/api/health');
    expect(r.status(), `health 200; got ${r.status()}`).toBe(200);
    const body = await r.json();
    expect(body.ok, 'health.ok').toBe(true);
    expect(['configured', 'missing']).toContain(body.auth);
    expect(typeof body.env.CLERK_SECRET_KEY).toBe('boolean');
    expect(typeof body.env.PUBLIC_CLERK_PUBLISHABLE_KEY).toBe('boolean');
  });

  test('GET /sign-in is never a 500 @smoke', async ({ request }) => {
    const r = await request.get('/sign-in');
    expect(
      r.status(),
      `sign-in must not 500; got ${r.status()} (200 = Clerk-configured render, ` +
        `503 = auth-not-configured friendly page, 30x = redirect — anything but 5xx is OK)`,
    ).toBeLessThan(500);
  });

  test('GET /dashboard is never a 500 @smoke', async ({ request }) => {
    // Dashboard either: 303 redirects to /sign-in (Clerk-configured + unauthed),
    // 200 (Clerk-configured + authed — won't happen in a no-cookie smoke), or
    // 503 (Clerk env missing, friendly page).
    const r = await request.get('/dashboard', { maxRedirects: 0 });
    expect(r.status(), `dashboard must not 500; got ${r.status()}`).toBeLessThan(500);
  });

  test('GET /r/<id> on a fake id is never a 500 @smoke', async ({ request }) => {
    const r = await request.get('/r/not-a-real-rackspace', { maxRedirects: 0 });
    expect(r.status(), `/r/[id] must not 500; got ${r.status()}`).toBeLessThan(500);
  });

  test('GET /sign-up is never a 500 @smoke', async ({ request }) => {
    const r = await request.get('/sign-up');
    expect(r.status(), `sign-up must not 500; got ${r.status()}`).toBeLessThan(500);
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
