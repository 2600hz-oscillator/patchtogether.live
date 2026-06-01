// e2e/tests/audio-gate.spec.ts
//
// Bug 2 (B5): the audio-gate overlay covers the rack canvas until the user
// clicks once, at which point the AudioContext starts and the overlay fades.
// Solves Chrome's autoplay policy blocking sound on cold loads + post-F5
// reloads of /r/[id].
//
// Coverage:
//   - Component logic is unit-tested in
//     packages/web/src/lib/audio/audio-gate.test.ts (8 tests).
//   - This spec covers the integration shape — that the overlay actually
//     renders on /r/[id] in a real browser AND that clicking it dismisses
//     the gate, with the AudioContext transitioning to `running`.
//
// Used to be `test.skip`'d behind @needs-rackspace-seed because /r/[id]
// requires a real rackspace row in the database and we had no way to seed
// one without a Clerk session. Helpers in e2e/tests/_helpers.ts now wrap
// the dev-only POST /api/test/seed-rackspace endpoint (gated server-side on
// RACKSPACE_SEED_ENABLED='1' OR NODE_ENV=development), so we get a fresh
// rack id + invite code in one round-trip and navigate to it anon-via-invite.

import { test, expect } from '@playwright/test';
import { seedRackspace } from './_helpers';

// seedRackspace requires DATABASE_URL (available in collab lane only).
// Regular e2e shards don't have DB access — skip gracefully.
test.skip(
  !process.env.DATABASE_URL,
  'audio-gate tests require DATABASE_URL — run in collab lane or with DATABASE_URL set',
);

// Disable Chromium's autoplay-policy override so the AudioContext genuinely
// starts suspended; the gate's whole reason to exist is to unblock the
// suspended-by-policy state. Playwright requires test.use() at file top
// level (or in config), not inside a describe block. Overrides the project-
// wide --autoplay-policy=no-user-gesture-required from playwright.config.ts.
test.use({
  launchOptions: {
    args: ['--autoplay-policy=user-gesture-required'],
  },
});

test.describe('@audio-gate', () => {
  test('overlay appears on cold-load of /r/[id] and dismisses on click', async ({ page }) => {
    const seeded = await seedRackspace(page);
    await page.goto(seeded.url);

    // The overlay should be visible immediately on /r/[id] cold-load since
    // the AudioContext is suspended-by-policy (--autoplay-policy override).
    const gate = page.getByTestId('audio-gate');
    await expect(gate).toBeVisible();

    // Clicking the gate counts as a user gesture, which lets the booter
    // (Canvas.svelte's ensureEngine, wired via setBooter) create + resume
    // the AudioContext. The store's statechange listener flips `running`
    // true and the overlay's `{#if visible}` removes the node.
    await gate.click();
    await expect(gate).toBeHidden();

    // Verify the AudioContext is actually running — the most likely
    // regression mode is the overlay hiding (busy/error path) without
    // the ctx ever reaching `running`. Read it via the dev-only __engine
    // global, which Canvas.svelte exposes once ensureEngine resolves.
    // ensureEngine is awaited by gate.resume(), so the ctx should be
    // available by the time the gate hides; we waitForFunction anyway to
    // guard against any micro-task ordering surprise across browsers.
    await page.waitForFunction(
      () => {
        const w = window as unknown as {
          __engine?: () => { ctx?: AudioContext; audioCtx?: AudioContext } | null;
        };
        const eng = w.__engine?.();
        const ctx =
          (eng as { ctx?: AudioContext } | null)?.ctx ??
          (eng as { audioCtx?: AudioContext } | null)?.audioCtx ??
          null;
        return ctx?.state === 'running';
      },
      undefined,
      { timeout: 5_000 },
    );
  });
});
