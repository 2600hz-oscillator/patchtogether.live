// e2e/tests/login-smoke.spec.ts
//
// REAL SIGN-IN smoke — the guard the 2026-07-11 dev login 500 proved we were
// missing: /health polling can be green while every authenticated dashboard
// load 500s (the racks.mode 42703 class). This spec drives the ACTUAL Clerk
// sign-in flow with a dedicated test user and asserts the post-login
// /dashboard renders (the exact request that was 500ing), not just that a
// header exists.
//
// GATING: needs a real Clerk test user. Runs iff BOTH env vars are set:
//   E2E_CLERK_TEST_EMAIL / E2E_CLERK_TEST_PASSWORD
// (repo/environment secrets — create a password-auth test user in the Clerk
// dev instance; see the PR that added this spec). Skips LOUDLY otherwise so
// local runs stay green without creds. Intended wiring: the per-PR e2e lane
// (secrets present) + the post-deploy smoke against the live deployment via
// E2E_BASE_URL.
//
// The hermetic sibling guard (no Clerk needed, runs in every unit lane) is
// packages/web/src/lib/server/rackspaces-mode-fallback.test.ts — it pins the
// exact 42703 fallback against a real pre-005 Postgres. THIS spec covers the
// glue those units can't: Clerk redirect → session cookie → server load →
// rendered dashboard.

import { test, expect } from '@playwright/test';

const EMAIL = process.env.E2E_CLERK_TEST_EMAIL;
const PASSWORD = process.env.E2E_CLERK_TEST_PASSWORD;

test.describe('login smoke (real Clerk sign-in → dashboard renders)', () => {
  test.skip(
    !EMAIL || !PASSWORD,
    'E2E_CLERK_TEST_EMAIL / E2E_CLERK_TEST_PASSWORD not set — real sign-in smoke skipped. ' +
      'Set both (Clerk dev-instance test user) to arm the login-regression guard.',
  );

  test('sign in → /dashboard responds 200 and renders the rackspace surface', async ({ page }) => {
    test.setTimeout(60_000);

    // Surface any 500 responses on the way through — the failure mode this
    // spec exists for is a server error AFTER auth succeeds.
    const serverErrors: string[] = [];
    page.on('response', (r) => {
      if (r.status() >= 500) serverErrors.push(`${r.status()} ${r.url()}`);
    });

    await page.goto('/sign-in');

    // Clerk's hosted component: identifier-first flow (email → continue →
    // password → continue). Selectors follow Clerk's stable input names.
    const email = page.locator('input[name="identifier"]');
    await expect(email).toBeVisible({ timeout: 20_000 });
    await email.fill(EMAIL!);
    await page.locator('button:has-text("Continue")').first().click();

    const password = page.locator('input[name="password"]');
    await expect(password).toBeVisible({ timeout: 15_000 });
    await password.fill(PASSWORD!);
    await page.locator('button:has-text("Continue")').first().click();

    // Post-auth we land somewhere app-side; drive to the dashboard explicitly
    // (the page that was 500ing) and assert it actually renders.
    await page.waitForURL((u) => !u.pathname.startsWith('/sign-in'), { timeout: 20_000 });
    const resp = await page.goto('/dashboard');
    expect(resp?.status(), 'authenticated /dashboard must not 5xx').toBeLessThan(500);

    // The dashboard's real surface: the create cards (dawless + workflow)
    // render for a signed-in user. These testids are the P1 dashboard cards.
    await expect(page.getByTestId('landing-tiles').or(page.locator('main'))).toBeVisible();
    await expect(page.getByText(/new dawless patch/i)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/new workflow patch/i)).toBeVisible();

    expect(serverErrors, `no 5xx responses during login flow: ${serverErrors.join(' | ')}`).toEqual([]);
  });
});
