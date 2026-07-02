// e2e/tests/clipplayer-edit-launch.spec.ts
//
// The clip EDIT view can launch the clip you're editing without going back to
// the session grid: NOW (immediate, ignores QNT) + QUEUE (next loop boundary,
// follows QNT). Both target the edited clip's own lane+slot. We assert the
// STABLE observable — the edited clip ends up in the lane's synced `playing`
// set — rather than the transient `queued`/`queuedImmediate` flags the engine
// consumes on the next tick (those race the poll). The NOW-vs-QUEUE timing
// distinction is an engine detail covered by the engine; here we prove the
// editor buttons actually start the clip you're editing.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

/** lane-0 entry of the clipplayer's synced `playing` set. */
async function lane0Playing(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { type?: string; data?: { playing?: unknown[] } }> };
    };
    const cp = Object.values(w.__patch.nodes).find((n) => n.type === 'clipplayer');
    return cp?.data?.playing?.[0];
  });
}

/** Spawn a clipplayer and open the editor on lane 0 / slot 0. */
async function openEditorLane0(page: import('@playwright/test').Page) {
  await page.goto('/rack');
  await spawnPatch(page, [{ id: 'cp1', type: 'clipplayer', domain: 'audio', x: 200, y: 120 }]);
  const card = page.getByTestId('clipplayer-card').first();
  await card.waitFor({ state: 'visible' });
  await card.locator('.pad').first().dblclick(); // → edit view, lane 0 / slot 0
  await page.getByTestId('clipplayer-editor').waitFor({ state: 'visible' });
  // Confirm we're editing L1·S1 so the assertion targets lane 0.
  await expect(page.getByTestId('clipplayer-editor').locator('.sel')).toHaveText('L1·S1');
  return card;
}

test('@clipplayer edit-view NOW launches the edited clip', async ({ page }) => {
  await openEditorLane0(page);
  await page.getByTestId('clipplayer-edit-now').click();
  await expect.poll(() => lane0Playing(page), { timeout: 5000 }).toBe(0);
});

test('@clipplayer edit-view QUEUE launches the edited clip', async ({ page }) => {
  await openEditorLane0(page);
  await page.getByTestId('clipplayer-edit-queue').click();
  await expect.poll(() => lane0Playing(page), { timeout: 5000 }).toBe(0);
});
