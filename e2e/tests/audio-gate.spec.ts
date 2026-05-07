// e2e/tests/audio-gate.spec.ts
//
// Bug 2 (B5): the audio-gate overlay covers the rack canvas until the user
// clicks once, at which point the AudioContext starts and the overlay fades.
// Solves Chrome's autoplay policy blocking sound on cold loads + post-F5
// reloads of /r/[id].
//
// Coverage: the component logic itself is unit-tested in
// packages/web/src/lib/audio/audio-gate.test.ts (8 tests). This spec covers
// the integration shape — that the overlay renders on /r/[id] and that
// clicking it dismisses it.
//
// Requires a real rackspace to exist for /r/[id] to render (the route
// loader 404s otherwise). Seeding rackspaces via the API needs a Clerk
// session, so the integration test is currently `test.skip`'d behind
// @needs-rackspace-seed; the helper is sketched below for when the test
// rackspace seeding flow lands (post-B5).

import { test, expect } from '@playwright/test';

test.describe('@audio-gate', () => {
  // Disable Chromium's autoplay-policy override so the AudioContext
  // genuinely starts suspended; the gate's whole reason to exist is to
  // unblock the suspended-by-policy state.
  test.use({
    launchOptions: {
      args: ['--autoplay-policy=user-gesture-required'],
    },
  });

  test.skip(
    'overlay appears on cold-load of /r/[id] and dismisses on click @needs-rackspace-seed',
    async ({ page }) => {
      // Pseudo-flow (TODO: enable when rackspace seeding is plumbed):
      //   1. Seed a rackspace + invite via raw SQL or a dev-only API.
      //   2. Navigate to `/r/<id>?invite=<code>`.
      //   3. Wait for the gate.
      //   4. Click; assert the gate disappears + AudioContext is running.
      const rackId = 'test-rackspace-id';
      const invite = 'TODO-seed';
      await page.goto(`/r/${rackId}?invite=${invite}`);
      const gate = page.getByTestId('audio-gate');
      await expect(gate).toBeVisible();
      await gate.click();
      await expect(gate).toBeHidden();
      const ctxState = await page.evaluate(() => {
        const w = window as unknown as { __engine?: () => { ctx?: AudioContext } | null };
        const e = w.__engine?.();
        // The Canvas dev-global returns the engine; ctx is exposed by the
        // AudioEngine domain via `getDomain('audio').ctx`.
        return (e as unknown as { ctx?: AudioContext } | null)?.ctx?.state ?? null;
      });
      expect(ctxState).toBe('running');
    },
  );
});
