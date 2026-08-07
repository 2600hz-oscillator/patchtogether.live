// e2e/tests/landing-new-rack-is-fresh.spec.ts
//
// "NEW … RACK" MUST ACTUALLY BE NEW (owner report 2026-08-07: "when i do 'new
// workflow rack', i don't get a fresh rack, i still get what's in local cache").
//
// THE REGRESSION THIS PINS. The landing tiles were plain <a href="/rack?mode=…">
// links. `/rack` resolves its doc through `getOrCreateLocalScratchId`, which
// returns the EXISTING per-device id — so the link reopened the previous rack
// out of its IndexedDB replica. That was correct while scratch docs were
// ephemeral, and became WRONG the moment local persistence shipped ("refresh
// doesn't lose the rack"), with neither tile edited: "new workflow rack" and
// "Return to last rack" silently became the same button.
//
// This is a persistence test, so it must NOT run with a wiped profile between
// steps — the whole point is that state survives a navigation. Playwright gives
// each test a fresh context, so both halves happen inside ONE test.

import type { Page } from '@playwright/test';
import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

/** Non-pinned module ids present on the canvas. Workflow racks always spawn
 *  their pinned singletons (TIMELORDE / MIXMSTRS / …), so those are NOT
 *  evidence of a stale rack — only user-spawned modules are. */
async function userNodeIds(page: Page): Promise<string[]> {
  return await page.evaluate(() => {
    const w = globalThis as unknown as { __patch?: { nodes: Record<string, unknown> } };
    return Object.keys(w.__patch?.nodes ?? {}).filter((id) => !id.startsWith('pinned-'));
  });
}

async function scratchIdFor(page: Page, mode: string): Promise<string | null> {
  return await page.evaluate((m) => localStorage.getItem(`pt:local-scratch-id:${m}`), mode);
}

// OPT IN to the scratch replica. `/rack` disables the IndexedDB replica under
// the e2e harness by default (navigator.webdriver) so the general suite stays
// ephemeral. This spec is ABOUT persistence, so without the opt-in it would be
// VACUOUS — every rack would look "fresh" and the tile bug would be invisible.
// (Step 2's cache-is-real control is the backstop that catches it regardless.)
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __ptScratchReplica?: boolean }).__ptScratchReplica = true;
  });
});

for (const [mode, tile, url] of [
  ['workflow', 'tile-new-workflow-rack', '/rack?mode=workflow'],
  ['dawless', 'tile-new-rack', '/rack'],
] as const) {
  test(`landing "${tile}" gives a genuinely FRESH ${mode} rack, not the cached one`, async ({
    page,
  }) => {
    // ── 1. Build a rack and let it persist. ─────────────────────────────────
    await page.goto(url);
    await page.waitForLoadState('networkidle');
    await spawnPatch(page, [
      { id: 'stale-marker', type: 'noise', position: { x: 140, y: 140 }, domain: 'audio' },
    ]);
    await expect.poll(() => userNodeIds(page)).toContain('stale-marker');
    const idBefore = await scratchIdFor(page, mode);
    expect(idBefore, 'a scratch id is persisted for this mode').toBeTruthy();

    // ── 2. Confirm the CACHE IS REAL — reopening the same URL restores it.
    // This is the negative control: without it, a fresh rack in step 3 could
    // just mean persistence never worked, and the test would "pass" while
    // proving nothing about the tile.
    await page.goto(url);
    await page.waitForLoadState('networkidle');
    await expect
      .poll(() => userNodeIds(page), { timeout: 10_000 })
      .toContain('stale-marker');
    expect(await scratchIdFor(page, mode), 'plain revisit keeps the same doc').toBe(idBefore);

    // ── 3. Now go through the LANDING TILE. It must mint a new doc. ─────────
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.getByTestId(tile).click();
    await page.waitForLoadState('networkidle');

    const idAfter = await scratchIdFor(page, mode);
    expect(idAfter, 'the tile mints a FRESH scratch id').not.toBe(idBefore);
    await expect
      .poll(() => userNodeIds(page), { timeout: 10_000 })
      .not.toContain('stale-marker');

    // The rack must still be functional, not merely empty: a workflow rack
    // re-spawns its pinned spine (that is what makes sound), so assert the
    // ensures ran rather than treating "no nodes at all" as success.
    if (mode === 'workflow') {
      await expect
        .poll(async () => await page.evaluate(() => {
          const w = globalThis as unknown as { __patch?: { nodes: Record<string, unknown> } };
          return Object.keys(w.__patch?.nodes ?? {}).filter((id) => id.startsWith('pinned-')).length;
        }), { timeout: 10_000 })
        .toBeGreaterThan(0);
    }

    // ── 4. The fresh rack persists in its own right (we replaced the doc,
    // we did not disable persistence).
    await spawnPatch(page, [
      { id: 'fresh-marker', type: 'noise', position: { x: 200, y: 200 }, domain: 'audio' },
    ]);
    await expect.poll(() => userNodeIds(page)).toContain('fresh-marker');
    await page.goto(url);
    await page.waitForLoadState('networkidle');
    await expect
      .poll(() => userNodeIds(page), { timeout: 10_000 })
      .toContain('fresh-marker');
    expect(await userNodeIds(page), 'the old rack stays gone').not.toContain('stale-marker');
  });
}
