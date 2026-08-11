// e2e/tests/landing-new-rack-is-fresh.spec.ts
//
// "NEW … RACK" MUST ACTUALLY BE NEW (owner report 2026-08-07: "when i do 'new
// workflow rack', i don't get a fresh rack, i still get what's in local cache").
//
// THE REGRESSION THIS PINS. The landing tile was a plain <a href="/rack?shell=legacy&seed=none">
// link. `/rack?shell=legacy&seed=none` resolves its doc through `getOrCreateLocalScratchId`, which
// returns the EXISTING per-device id — so the link reopened the previous rack
// out of its IndexedDB replica. That was correct while scratch docs were
// ephemeral, and became WRONG the moment local persistence shipped ("refresh
// doesn't lose the rack"), with the tile never edited: "new rack" and
// "Return to last rack" silently became the same button.
//
// This is a persistence test, so it must NOT run with a wiped profile between
// steps — the whole point is that state survives a navigation. Playwright gives
// each test a fresh context, so both halves happen inside ONE test.

import type { Page } from '@playwright/test';
import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

/** Module ids that are NOT part of the rack's own auto-seeded spine. Every
 *  rack spawns its pinned singletons (TIMELORDE / MIXMSTRS / …) plus the
 *  video-zone defaults, so none of those are evidence of a stale rack — only
 *  user-spawned modules are. */
async function userNodeIds(page: Page): Promise<string[]> {
  return await page.evaluate(() => {
    const w = globalThis as unknown as { __patch?: { nodes: Record<string, unknown> } };
    return Object.keys(w.__patch?.nodes ?? {}).filter(
      (id) => !id.startsWith('pinned-') && !id.startsWith('workflow-'),
    );
  });
}

async function scratchId(page: Page): Promise<string | null> {
  return await page.evaluate(() => localStorage.getItem('pt:local-scratch-id'));
}

// OPT IN to the scratch replica. `/rack?shell=legacy` disables the IndexedDB replica under
// the e2e harness by default (navigator.webdriver) so the general suite stays
// ephemeral. This spec is ABOUT persistence, so without the opt-in it would be
// VACUOUS — every rack would look "fresh" and the tile bug would be invisible.
// (Step 2's cache-is-real control is the backstop that catches it regardless.)
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __ptScratchReplica?: boolean }).__ptScratchReplica = true;
  });
});

const TILE = 'tile-new-rack';
const URL_ = '/rack?shell=legacy&seed=none';

test(`landing "${TILE}" gives a genuinely FRESH rack, not the cached one`, async ({
  page,
}) => {
  // ── 1. Build a rack and let it persist. ─────────────────────────────────
  await page.goto(URL_);
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [
    { id: 'stale-marker', type: 'noise', position: { x: 140, y: 140 }, domain: 'audio' },
  ]);
  await expect.poll(() => userNodeIds(page)).toContain('stale-marker');
  const idBefore = await scratchId(page);
  expect(idBefore, 'a scratch id is persisted').toBeTruthy();

  // ── 2. Confirm the CACHE IS REAL — reopening the same URL restores it.
  // This is the negative control: without it, a fresh rack in step 3 could
  // just mean persistence never worked, and the test would "pass" while
  // proving nothing about the tile.
  await page.goto(URL_);
  await page.waitForLoadState('networkidle');
  await expect
    .poll(() => userNodeIds(page), { timeout: 10_000 })
    .toContain('stale-marker');
  expect(await scratchId(page), 'plain revisit keeps the same doc').toBe(idBefore);

  // ── 3. Now go through the LANDING TILE. It must mint a new doc. ─────────
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.getByTestId(TILE).click();
  await page.waitForLoadState('networkidle');

  const idAfter = await scratchId(page);
  expect(idAfter, 'the tile mints a FRESH scratch id').not.toBe(idBefore);
  await expect
    .poll(() => userNodeIds(page), { timeout: 10_000 })
    .not.toContain('stale-marker');

  // The rack must still be FUNCTIONAL, not merely empty: a fresh rack
  // re-spawns its pinned spine (that is what makes sound), so assert the
  // ensures ran rather than treating "no nodes at all" as success.
  await expect
    .poll(async () => await page.evaluate(() => {
      const w = globalThis as unknown as { __patch?: { nodes: Record<string, unknown> } };
      return Object.keys(w.__patch?.nodes ?? {}).filter((id) => id.startsWith('pinned-')).length;
    }), { timeout: 10_000 })
    .toBeGreaterThan(0);

  // ── 4. The fresh rack persists in its own right (we replaced the doc,
  // we did not disable persistence).
  await spawnPatch(page, [
    { id: 'fresh-marker', type: 'noise', position: { x: 200, y: 200 }, domain: 'audio' },
  ]);
  await expect.poll(() => userNodeIds(page)).toContain('fresh-marker');
  await page.goto(URL_);
  await page.waitForLoadState('networkidle');
  await expect
    .poll(() => userNodeIds(page), { timeout: 10_000 })
    .toContain('fresh-marker');
  expect(await userNodeIds(page), 'the old rack stays gone').not.toContain('stale-marker');
});
