// e2e/tests/videovarispeed-panel-layout.spec.ts
//
// Layout-regression guard for the "Load multiple…" 7-slot panel on the cards
// that have one AND are still operated as cards (see the CARDS note below).
// The card is pinned to an exact rack-unit height (height + min/max-height
// locked by `.rack-sized` in _module-card.css). Before the fix the panel stacked
// in normal flow, pushed past the tier, and its bottom rows (slots A/B) were
// clipped (videovarispeed, which also has `overflow: hidden`) or spilled outside
// the card box (picturebox, since promoted — see below). The panel is now an
// absolute overlay sheet, so this asserts it — including its last slot row —
// stays within the card's box once opened.
//
// Pure geometry: no video decode / WebGL, so it's fast and CI-renderer-safe.

import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';

// ⚠ THE `picturebox` ROW WAS RETIRED WITH THE DESIGN IT COVERED (2026-08-24),
// and the reason is CLAUDE.md's "a gate whose PRECONDITION is the defect" in its
// milder form — here the precondition is not a defect, it is a DESIGN this
// spec's subject has been superseded by.
//
// picturebox is now a FACEPLATE. Its 7-slot bank lives in a `fullViewBody` shell
// extension where there is no rack-unit height, no `overflow: hidden` card box
// and therefore no containment to measure: the constraint this row asserts
// ceases to exist for that module. What it would have kept measuring is the
// LEGACY card, which after promotion is reachable only through the `?shell=
// legacy` debug flag — so the row would have stayed GREEN while asserting a
// containment that no longer constrains anything a player can reach. That is the
// green-and-blind state, and a green-and-blind row is what certifies the next
// bug in the area.
//
// ⚠ THE SPEC IS NOT DELETED, because its real subject is the OVERLAY-SHEET
// TECHNIQUE and not picturebox. `videovarispeed` still draws the same panel
// inside the same rack-sized box, is NOT in STRICT_FACES, and is the harder of
// the two cases (it also carries `overflow: hidden`, so its bottom rows were
// CLIPPED rather than merely spilling). The row that survives is the one that
// caught the original bug in its worst form.
const CARDS = [
  { type: 'videovarispeed', testid: 'videovarispeed', domain: 'video' },
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
