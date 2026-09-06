// e2e/tests/videovarispeed-multislot-persist.spec.ts
//
// Regression: loading videos into MULTIPLE "Load multiple…" slots must persist
// every slot to the synced node.data.slotMeta. Before the fix, writeSlotMeta
// read back a previously-written entry (a live Y type) and reassigned the whole
// array, which Yjs rejects ("reassigning object that already occurs in the
// tree") — the transaction aborted, so only the FIRST loaded slot ever saved.
// (Same Y-reintegration trap as the sequencer save-to-slot bug.)
//
// Drives the REAL card (panel → <input type=file> per slot) against the live
// store; no video decode assertions, so it's CI-renderer-safe.

import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { spawnPatch } from './_helpers';

const FX = fileURLToPath(new URL('../fixtures/lobby-clip.webm', import.meta.url));


/** Open a videovarispeed node's dock full view — every transport affordance
 *  (file input, PLAY/LOOP, slots, crop) is its `fullViewBody`; the SAME
 *  `videovarispeed-*` testids the card carried render there, including the
 *  state attributes, which live on `videovarispeed-face-body`. Idempotent
 *  (openFullView de-dupes). */
async function openVvsPane(page: import('@playwright/test').Page, id: string): Promise<void> {
  await page.waitForFunction(
    () =>
      typeof (globalThis as unknown as { __openDockFullView?: unknown }).__openDockFullView ===
      'function',
    undefined,
    { timeout: 30_000 },
  );
  await page.evaluate(
    (i) => (globalThis as unknown as { __openDockFullView: (x: string) => void }).__openDockFullView(i),
    id,
  );
  await page
    .locator(`[data-testid="dock-fullview-pane"][data-pane-node="${id}"] [data-testid="videovarispeed-face-body"]`)
    .waitFor({ state: 'visible', timeout: 60_000 });
}

test('videovarispeed persists every loaded asset slot to the synced doc', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await page.goto('/rack?seed=none');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [{ id: 'vv1', type: 'videovarispeed', domain: 'video', position: { x: 140, y: 80 } }]);
  await openVvsPane(page, 'vv1');

  // The 7-slot ASSET BANK is ALWAYS-ON in the dock face (the card needed a
  // right-click gesture to reveal it; that chrome died with the card — and a
  // spare Escape here would close the whole full view).
  await expect(page.locator('[data-testid="videovarispeed-multi-panel"]')).toBeVisible();

  // Load the same fixture into three different slots (0, 1, 2).
  for (const i of [0, 1, 2]) {
    await page.locator(`[data-testid="videovarispeed-slot-input-${i}"]`).setInputFiles(FX);
    await page.waitForFunction(
      (slot) => {
        const w = globalThis as unknown as { __patch: { nodes: Record<string, { data?: { slotMeta?: Array<unknown> } }> } };
        const sm = w.__patch.nodes['vv1']?.data?.slotMeta;
        return Array.isArray(sm) && sm[slot] != null;
      },
      i,
      { timeout: 5000 },
    );
  }

  const slotMeta = await page.evaluate(() => {
    const w = globalThis as unknown as { __patch: { nodes: Record<string, { data?: { slotMeta?: Array<{ name?: string } | null> } }> } };
    return w.__patch.nodes['vv1']?.data?.slotMeta ?? null;
  });

  expect(Array.isArray(slotMeta)).toBe(true);
  // The regression: all three loaded slots survived to the synced doc.
  expect(slotMeta![0]?.name).toBe('lobby-clip.webm');
  expect(slotMeta![1]?.name).toBe('lobby-clip.webm');
  expect(slotMeta![2]?.name).toBe('lobby-clip.webm');

  // No "reassigning object that already occurs in the tree" (the abort).
  expect(pageErrors.filter((m) => /already occurs in the tree/.test(m))).toEqual([]);
});
