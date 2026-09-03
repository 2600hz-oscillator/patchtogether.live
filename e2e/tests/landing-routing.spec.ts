// e2e/tests/landing-routing.spec.ts
//
// Phase 1 of the landing-page overhaul: the scratch canvas moved from `/` to
// `/rack?seed=none`, and `/` is now a static, prerendered landing / front door.
//
// This spec pins the load-bearing routing invariants:
//   1. `/rack?seed=none` boots the canvas AND is cross-origin isolated (SharedArrayBuffer
//      for Faust — the reason the canvas can't sit under Clerk). (Finding A: the
//      isolation is enforced globally by _headers `/*` + vite server/preview
//      headers, reinforced by hooks.server.ts ISOLATED_EXACT which now lists
//      `/rack?seed=none`, not `/`.)
//   2. `/` renders the landing with NO canvas / no AudioContext.
//   3. Anon `GET /` returns 200 even with the beta gate active (Finding C: `/`
//      is an EXACT carve-out in BETA_GATE_PUBLIC_PATHS — the public front door).
//   4. The landing is static HTML with NO auth-derived header (Finding D +
//      owner decision: prerender=true, no homeAuth read, a static "sign in"
//      link → no signed-in/out glitch).

import { test, expect } from '@playwright/test';
import { BOOT_MS, SLOW_BOOT_TEST_TIMEOUT_MS } from '../_helpers/boot-budget';

// ⚠ THE PER-TEST BUDGET IS A BOUND, AND IT WAS THE INVISIBLE 30 s DEFAULT.
//
// This file bounds its boot waits with `BOOT_MS` — 30 000 on CI, IDENTICAL to
// the 30 000 default budget they were running inside. 2 sites, 1.00x.
//
// An inner bound at or above the budget that CONTAINS it can never come true:
// the outer clock kills the test first, so a legible `element not found` is
// converted into an illegible `Test timeout of 30000ms exceeded` — the class
// #2291 root-caused and #2293 repaired at its second call site. Nothing in this
// file said "30000"; `e2e/playwright.config.ts` never overrides Playwright's
// default, so there was nothing to grep for except the ABSENCE of a budget.
//
// The budget therefore comes from `boot-budget` (90 000 on CI/SwiftShader,
// 30 000 local) instead of the invisible default. A bound only costs wall-clock
// when it is EXCEEDED, so this adds exactly zero to a green run; lane cost stays
// gauged by `--global-timeout`, not by this.
//
// ⚠ BOUNDS ONLY. No assertion, subject or wait target changed here.
test.describe.configure({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });

test.describe('landing routing', () => {
  test('the rack route boots the canvas and is cross-origin isolated', async ({ page }) => {
    const resp = await page.goto('/rack?seed=none');
    expect(resp, 'no response for /rack?seed=none').toBeTruthy();
    expect(resp!.status(), `/rack?seed=none status ${resp!.status()}`).toBe(200);

    await expect(page.locator('[data-testid="canvas-root"]')).toBeVisible({ timeout: BOOT_MS });

    // The audio engine needs SharedArrayBuffer, which requires cross-origin
    // isolation. This is the invariant the whole route-move had to preserve.
    const isolated = await page.evaluate(() => crossOriginIsolated === true);
    expect(isolated, 'the rack route must be cross-origin isolated').toBe(true);
  });

  test('clicking a rack tile from the landing arrives cross-origin ISOLATED (full-page nav, not a soft nav)', async ({
    page,
  }) => {
    // The hole the direct-load test above could not see (a gate that reads only
    // one side): `/` is deliberately NOT isolated, so a CLIENT-SIDE navigation
    // into `/rack?seed=none` keeps the landing's document and arrives with
    // `crossOriginIsolated === false` — SharedArrayBuffer undefined, Faust WASM
    // threads degraded, and the ES-9 bridge card stuck in 'unsupported' with no
    // connect button (owner report 2026-08-05). The rack-bound landing tiles
    // carry `data-sveltekit-reload` so entry is a full-page load that picks up
    // the COOP/COEP headers. This drives the REAL click-through path.
    await page.goto('/');
    await expect(page.getByTestId('landing-tiles')).toBeVisible();
    // Negative control for the instrument: the landing itself must NOT be
    // isolated in dev — if it ever is, this test can no longer distinguish a
    // soft nav from a hard one and must be rethought, so fail loudly here.
    expect(
      await page.evaluate(() => crossOriginIsolated),
      'landing must be non-isolated for this test to prove anything',
    ).toBe(false);

    // The second rack tile ('tile-new-workflow-rack') selected the DELETED
    // shell and is gone; the claim it carried — a landing click-through arrives
    // cross-origin ISOLATED — moves onto the one remaining tile.
    await page.getByTestId('tile-new-rack').click();
    await page.waitForURL('**/rack');
    await expect(page.locator('[data-testid="canvas-root"]')).toBeVisible({ timeout: BOOT_MS });
    expect(
      await page.evaluate(() => crossOriginIsolated),
      'rack entered via the landing tile must be cross-origin isolated',
    ).toBe(true);
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
    // client-only render. (A csr-only page would ship an empty shell.) The
    // tile labels are lowercase in the markup — CSS uppercases them for display.
    expect(html).toContain('new rack');
    expect(html).toContain('sign in');
    // ONE rack tile now — the second one existed only to select the other
    // shell. Asserted as an ABSENCE so this cannot quietly pass if it returns.
    expect(html).not.toContain('new workflow rack');

    // The landing reads NO auth state: none of the canvas's per-request header
    // chip markers (the signed-in `account-link` / signed-out `signin-link`)
    // appear here — the header is a plain static "sign in" link.
    expect(html).not.toContain('account-link');
    expect(html).not.toContain('signin-link');
    await expect(page.getByTestId('header-signin')).toHaveAttribute('href', '/sign-in');
  });
});
