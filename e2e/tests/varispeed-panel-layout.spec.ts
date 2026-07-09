// e2e/tests/videovarispeed-panel-layout.spec.ts
//
// Layout-regression guard for the "Load multiple…" 7-slot panel on the cards
// that have one (VIDEOVARISPEED + PICTUREBOX). Both cards are pinned to an
// exact rack-unit height (height + min/max-height locked by `.rack-sized` in
// _module-card.css). Before the fix the panel stacked in normal flow, pushed
// past the tier, and its bottom rows (slots A/B) were clipped (videovarispeed,
// which also has `overflow: hidden`) or spilled outside the card box
// (picturebox). The panel is now an absolute overlay sheet, so this asserts it
// — including its last slot row — stays within the card's box once opened.
//
// Pure geometry: no video decode / WebGL, so it's fast and CI-renderer-safe.

import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';

const CARDS = [
  { type: 'videovarispeed', testid: 'videovarispeed', domain: 'video' },
  { type: 'picturebox', testid: 'picturebox', domain: 'video' },
] as const;

for (const c of CARDS) {
  test(`${c.type} multi-panel fits inside the card (no clip/spill)`, async ({ page, rack }) => {
    await spawnPatch(page, [
      { id: 'n1', type: c.type, domain: c.domain, position: { x: 140, y: 80 } },
    ]);

    const card = page.locator(`[data-testid="${c.testid}-card"]`);
    await expect(card).toBeVisible();

    // Right-click the card to open the "Load multiple…" panel.
    await card.click({ button: 'right', position: { x: 30, y: 30 } });
    const panel = page.locator(`[data-testid="${c.testid}-multi-panel"]`);
    await expect(panel).toBeVisible();
    await page.keyboard.press('Escape'); // dismiss the node context menu the right-click also opened
    await expect(panel).toBeVisible();

    // The 7th (last) slot row — note B — is the one that used to be clipped.
    const lastRow = page.locator(`[data-testid="${c.testid}-slot-6"]`);
    await expect(lastRow).toBeVisible();

    const cardBox = await card.boundingBox();
    const panelBox = await panel.boundingBox();
    const rowBox = await lastRow.boundingBox();
    expect(cardBox && panelBox && rowBox).toBeTruthy();

    const cardBottom = cardBox!.y + cardBox!.height;
    // Allow 1px for sub-pixel rounding.
    expect(panelBox!.y + panelBox!.height).toBeLessThanOrEqual(cardBottom + 1);
    expect(rowBox!.y + rowBox!.height).toBeLessThanOrEqual(cardBottom + 1);
  });
}
