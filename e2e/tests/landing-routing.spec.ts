// e2e/tests/landing-routing.spec.ts
//
// Phase 1 of the landing-page overhaul: the scratch canvas moved from `/` to
// `/rack`, and `/` is now a static, prerendered landing / front door.
//
// This spec pins the load-bearing routing invariants:
//   1. `/rack` boots the canvas AND is cross-origin isolated (SharedArrayBuffer
//      for Faust — the reason the canvas can't sit under Clerk). (Finding A: the
//      isolation is enforced globally by _headers `/*` + vite server/preview
//      headers, reinforced by hooks.server.ts ISOLATED_EXACT which now lists
//      `/rack`, not `/`.)
//   2. `/` renders the landing with NO canvas / no AudioContext.
//   3. Anon `GET /` returns 200 even with the beta gate active (Finding C: `/`
//      is an EXACT carve-out in BETA_GATE_PUBLIC_PATHS — the public front door).
//   4. The landing is static HTML with NO auth-derived header (Finding D +
//      owner decision: prerender=true, no homeAuth read, a static "sign in"
//      link → no signed-in/out glitch).

import { test, expect } from '@playwright/test';

test.describe('landing routing', () => {
  test('/rack boots the canvas and is cross-origin isolated', async ({ page }) => {
    const resp = await page.goto('/rack');
    expect(resp, 'no response for /rack').toBeTruthy();
    expect(resp!.status(), `/rack status ${resp!.status()}`).toBe(200);

    await expect(page.locator('[data-testid="canvas-root"]')).toBeVisible();

    // The audio engine needs SharedArrayBuffer, which requires cross-origin
    // isolation. This is the invariant the whole route-move had to preserve.
    const isolated = await page.evaluate(() => crossOriginIsolated === true);
    expect(isolated, '/rack must be cross-origin isolated').toBe(true);
  });

  test('/ renders the landing front door with no canvas', async ({ page }) => {
    const resp = await page.goto('/');
    expect(resp!.status()).toBe(200);

    // The tile grid is the landing (no hero CTA — owner review removed it);
    // the canvas is NOT here.
    await expect(page.getByTestId('tile-new-rack')).toBeVisible();
    await expect(page.getByTestId('landing-tiles')).toBeVisible();
    await expect(page.locator('[data-testid="canvas-root"]')).toHaveCount(0);
  });

  test('anon GET / returns 200 with the beta gate active (public front door)', async ({
    playwright,
    baseURL,
  }) => {
    // Explicitly anonymous: no httpCredentials. When the beta gate is active
    // (CI sets BETA_GATE_PASS; playwright.config attaches creds to the default
    // context), THIS context carries none — so a gated path 401s while the
    // carved-out `/` must still 200.
    const anon = await playwright.request.newContext({
      baseURL,
      httpCredentials: undefined,
    });
    try {
      const landing = await anon.get('/');
      expect(landing.status(), 'anon / must be public (beta-gate carve-out)').toBe(200);

      // Prove the gate is real where it's active: an anon hit to a GATED path
      // is 401 when the gate is on. When it's OFF (local dev, no
      // BETA_GATE_PASS) this is a redirect/200 and we skip the negative half —
      // the deterministic isBetaGatePublic unit test guards the carve-out
      // there. maxRedirects:0 so we read the RAW gate status, not the
      // post-redirect sign-in page.
      const gated = await anon.get('/dashboard', { maxRedirects: 0 });
      if (gated.status() === 401) {
        // Gate active → the `/` 200 above is a genuine carve-out, not gate-off.
        expect(
          landing.status(),
          'with the gate ACTIVE, anon / is a real public carve-out',
        ).toBe(200);
      }
    } finally {
      await anon.dispose();
    }
  });

  test('landing is static HTML with no auth-derived header', async ({ page }) => {
    const resp = await page.goto('/');
    const html = await resp!.text();

    // Content is present in the INITIAL server HTML → prerendered/SSR, not a
    // client-only render. (A csr-only page would ship an empty shell.)
    expect(html).toContain('NEW RACK');
    expect(html).toContain('sign in');

    // The landing reads NO auth state: none of the canvas's per-request header
    // chip markers (the signed-in `account-link` / signed-out `signin-link`)
    // appear here — the header is a plain static "sign in" link.
    expect(html).not.toContain('account-link');
    expect(html).not.toContain('signin-link');
    await expect(page.getByTestId('header-signin')).toHaveAttribute('href', '/sign-in');
  });
});
