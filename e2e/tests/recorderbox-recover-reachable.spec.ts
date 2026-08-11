// e2e/tests/recorderbox-recover-reachable.spec.ts
//
// RECORDERBOX's crash-recovery prompt must be REACHABLE, not merely rendered.
//
// The bug (owner-reported 2026-07-31): "Recover unsaved recording?" appeared at
// the very bottom of the card with its Save / Discard buttons clipped away. The
// card's height is hard-pinned by the rack tier (`_module-card.css` sets
// height/min-height/max-height to `--rack-u * --rack-unit`; recorderbox is 2u)
// and `.card` is `overflow: hidden` — so flow content appended after the RECORD
// button lands outside the box and is unclickable. The user could read the
// question and could not answer it.
//
// WHY NOTHING CAUGHT IT — two structural blind spots, both already named in
// CLAUDE.md, meeting on one card:
//   1. `card-control-overflow` only ever spawns a module in its DEFAULT state.
//      This prompt only exists when a mid-flight recording is left behind, so
//      the sweep never measured the card in the state that overflows.
//   2. Nothing in the repo referenced `recorderbox-recover*` at all — the whole
//      recovery UI had zero coverage. It was written, shipped, and never
//      entered by a test.
//
// So this spec ENTERS THE STATE. It seeds the manifest IndexedDB directly (the
// same record `listRecoverable` scans for — DB `patchtogether-recorderbox`,
// store `manifests`, keyPath `opfsPath`, `status: 'recording'`), then asserts
// the buttons are not just visible but inside the card's own box and hit-
// testable at their centre point.
//
// ⚠ `toBeVisible()` alone would NOT have caught this. An element clipped by an
// ancestor's `overflow: hidden` can still report as visible — it has a non-empty
// box and is not `display:none`. The assertion has to compare geometry against
// the CLIPPING ancestor, which is what `boundingBox` + `elementFromPoint` do
// below.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

const NODE_ID = 'rec1';

test.describe('RECORDERBOX crash-recovery prompt', () => {
  test('Save / Discard are inside the card and clickable', async ({ page }) => {
    await page.goto('/rack?shell=legacy&seed=none');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForFunction(
      () => typeof (globalThis as unknown as { __ensureEngine?: unknown }).__ensureEngine === 'function',
      undefined,
      { timeout: 60_000 },
    );

    // Seed a mid-flight manifest BEFORE the card mounts — `scanRecoverable()`
    // runs on mount, so a later write would not be picked up without a rescan.
    await page.evaluate(async (nodeId) => {
      await new Promise<void>((resolve, reject) => {
        const req = indexedDB.open('patchtogether-recorderbox', 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('manifests')) {
            db.createObjectStore('manifests', { keyPath: 'opfsPath' });
          }
        };
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction('manifests', 'readwrite');
          tx.objectStore('manifests').put({
            nodeId,
            filename: 'interrupted-take',
            startedAt: 1_750_000_000_000,
            mime: 'video/mp4',
            opfsPath: `recorderbox/${nodeId}-1750000000000-interrupted-take.mp4`,
            status: 'recording',
            chunkName: 'interrupted-take.mp4',
          });
          tx.oncomplete = () => { db.close(); resolve(); };
          tx.onerror = () => { db.close(); reject(tx.error); };
        };
        req.onerror = () => reject(req.error);
      });
    }, NODE_ID);

    await spawnPatch(page, [{ id: NODE_ID, type: 'recorderbox', domain: 'video', x: 200, y: 120 }]);

    const prompt = page.getByTestId('recorderbox-recover');
    await expect(prompt, 'the seeded manifest should raise the recovery prompt').toBeVisible({ timeout: 20_000 });

    // The clipping ancestor: `.card` carries the pinned height + overflow:hidden.
    const card = page.locator(`[data-id="${NODE_ID}"] .card`).first();
    const cardBox = await card.boundingBox();
    expect(cardBox, 'card should have a box').not.toBeNull();

    for (const testid of ['recorderbox-recover-save', 'recorderbox-recover-discard']) {
      const btn = page.getByTestId(testid);
      await expect(btn).toBeVisible();
      const box = await btn.boundingBox();
      expect(box, `${testid} should have a box`).not.toBeNull();

      // GEOMETRY, in viewport-scaled px (xyflow applies a zoom transform, so
      // these are NOT CSS px — but both boxes come through the same transform,
      // so the CONTAINMENT comparison is scale-invariant even though the
      // magnitudes are not).
      const overflowBottom = box!.y + box!.height - (cardBox!.y + cardBox!.height);
      expect(
        overflowBottom,
        `${testid} extends ${Math.round(overflowBottom)}px (viewport-scaled) past the bottom of the ` +
          `rack-pinned card, which is overflow:hidden — the control is unreachable`,
      ).toBeLessThanOrEqual(0);

      // HIT TEST — the assertion that actually proves usability. A button can
      // sit inside the card box and still be covered by a sibling; this checks
      // the element at its centre really is the button (or a descendant).
      const hit = await page.evaluate(
        ({ x, y, id }) => {
          const el = document.elementFromPoint(x, y);
          return !!el?.closest(`[data-testid="${id}"]`);
        },
        { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2, id: testid },
      );
      expect(hit, `${testid} is not the topmost element at its own centre — something covers it`).toBe(true);

      // And it must genuinely take a click.
      await expect(btn).toBeEnabled();
    }

    // Discard actually resolves the prompt — proves the buttons are wired, not
    // just positioned, so this spec cannot pass on a decorative panel.
    await page.getByTestId('recorderbox-recover-discard').click();
    await expect(prompt, 'discarding the only candidate should retire the prompt').toBeHidden({ timeout: 20_000 });
  });
});
