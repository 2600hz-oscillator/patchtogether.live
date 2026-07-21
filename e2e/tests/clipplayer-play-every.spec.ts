// e2e/tests/clipplayer-play-every.spec.ts
//
// PER-NOTE PLAY EVERY end-to-end (card path): drawing a note and picking "Play
// Every 3" from its right-click menu writes `playEvery: 3` onto that note in the
// synced clip data — the observable every peer + the engine + the LED read. The
// deterministic loop-divider FIRING is pinned by the pure + engine unit tests
// (clip-play-every.test.ts / clipplayer.test.ts "silent on loop 0, fires on loop
// 1"); the Launchpad SHIFT+double-tap view by launchpad-play-every.test.ts. Here
// we prove the real card UI writes the data, and that "1" clears it (default).

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

/** The playEvery of the note at step 0 in the clip at lane 0 / slot 0. */
async function step0PlayEvery(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { type?: string; data?: { clips?: Record<string, { steps?: { step: number; playEvery?: number }[] }> } }> };
    };
    const cp = Object.values(w.__patch.nodes).find((n) => n.type === 'clipplayer');
    const note = cp?.data?.clips?.['0']?.steps?.find((s) => s.step === 0);
    return note ? note.playEvery ?? 1 : null; // 1 = default (key absent)
  });
}

async function openEditorWithNote(page: import('@playwright/test').Page) {
  await page.goto('/rack');
  await spawnPatch(page, [{ id: 'pe-cp', type: 'clipplayer', domain: 'audio', x: 200, y: 120 }]);
  const card = page.getByTestId('clipplayer-card').first();
  await card.waitFor({ state: 'visible' });
  await card.locator('.pad').first().dblclick(); // → editor, lane 0 / slot 0
  await page.getByTestId('clipplayer-editor').waitFor({ state: 'visible' });
  // Draw a note at display row 0 / step 0.
  const cell = page.getByTestId('clipplayer-cell-0-0');
  await cell.click();
  return cell;
}

test('@clipplayer card Play Every menu writes playEvery onto the note; "1" clears it', async ({ page }) => {
  const cell = await openEditorWithNote(page);

  // Right-click the note → the per-note menu → Play Every 3.
  await cell.click({ button: 'right' });
  await page.getByTestId('clipplayer-play-every-item-3').click();
  await expect.poll(() => step0PlayEvery(page), { timeout: 5000 }).toBe(3);

  // Re-open the menu and pick "1" (every loop) → the key is removed (back to default).
  await cell.click({ button: 'right' });
  await page.getByTestId('clipplayer-play-every-item-1').click();
  await expect.poll(() => step0PlayEvery(page), { timeout: 5000 }).toBe(1);
});
