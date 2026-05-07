// e2e/tests/feedback.spec.ts
//
// Feedback box (in-app suggestion / bug report).
//
// What's covered here:
//   - Route shape  — /api/feedback rejects unauthed callers (either 401
//                    when Clerk is configured or 503 when it isn't, but
//                    NEVER 200 and NEVER 500). Same auth-shape contract
//                    as auth-routes.spec.ts.
//   - Body shape   — when an unauthed call DOES reach the route handler
//                    (Clerk-configured envs only), the validator rejects
//                    bad shapes with 400 / 401 — never 500.
//
// What's NOT covered here (yet):
//   - The end-to-end "click button → modal opens → submit → DB row"
//     flow needs a Clerk-authed session. Once Clerk test users are
//     provisioned for the autotest tier (same TODO as auth-routes
//     spec calls out), a follow-up spec should cover this.
//
// The form-validation + char-counter + radio-required logic is fully
// covered by the route's vitest unit suite plus the Svelte component
// tests in `packages/web/src/lib/ui/`. This file's job is the wire
// contract: nothing should ever 500.

import { test, expect } from '@playwright/test';

test.describe('feedback route shape', () => {
  test('POST /api/feedback without auth is 401 or 503 (never 200, never 500) @smoke', async ({
    request,
  }) => {
    const r = await request.post('/api/feedback', {
      data: { kind: 'bug', message: 'smoke probe — should be rejected' },
    });
    expect(r.status(), `feedback route returned ${r.status()} (expected 401 or 503)`).not.toBe(
      200,
    );
    expect(r.status(), `feedback route must not 500; got ${r.status()}`).not.toBe(500);
    // 401 = Clerk-configured + unauthed; 503 = Clerk-missing friendly page.
    expect([401, 503]).toContain(r.status());
  });

  test('POST /api/feedback with malformed body still does not 500 @smoke', async ({ request }) => {
    // Send literal text instead of JSON. The handler should reject before
    // running any DB code, so we get a 400/401/503 — definitively not 500.
    const r = await request.post('/api/feedback', {
      headers: { 'content-type': 'application/json' },
      data: 'not actually json',
    });
    expect(r.status(), `feedback malformed-body must not 500; got ${r.status()}`).not.toBe(500);
  });
});

test.describe('feedback UI presence', () => {
  // Pre-Clerk-test-user phase: the only authed entry point we can drive
  // without credentials is the dashboard's 303→sign-in redirect, which
  // doesn't render the FeedbackBox. Once a Clerk session is plumbed in,
  // the UX assertions below should switch from `request` shape checks
  // to actual click-and-type flows.
  //
  // For now we cover the negative case: an unauthed user shouldn't see
  // the Feedback button on the public landing page (it's gated behind
  // an authed dashboard or rackspace).
  test('Feedback button is absent on the public landing page @smoke', async ({ page }) => {
    const r = await page.goto('/');
    expect(r?.status(), `landing page must not 500; got ${r?.status()}`).toBeLessThan(500);
    // The trigger has data-testid='feedback-button' — it should not exist
    // here because the public root doesn't mount the FeedbackBox component.
    await expect(page.locator('[data-testid="feedback-button"]')).toHaveCount(0);
  });
});
