// e2e/tests/aut-patch-panel.spec.ts
//
// @aut Acceptance flow for the hover-revealed patch panel:
//
//  - Open a fresh rack
//  - Spawn an ADSR — see knobs, no jacks
//  - Hover top-left of ADSR — patch panel opens, ATTACK/DECAY/SUSTAIN/
//    RELEASE labels visible
//  - Drag a cable from another module's gate output to ADSR's gate input
//    via the panel — connection works, panel stays open during drag
//  - Move mouse away — panel closes
//  - Spawn RIOTGIRLS — same flow with 55 ports, organized into voice +
//    master sections
//
// AUT (Acceptance User Test) tests are tagged @aut so they're easy to
// run as a focused suite when iterating on the UX.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

async function panel(page: Page, nodeId: string) {
  return page.locator(
    `.svelte-flow__node[data-id="${nodeId}"] [data-testid="patch-panel"]`,
  );
}

async function trigger(page: Page, nodeId: string) {
  return page.locator(
    `.svelte-flow__node[data-id="${nodeId}"] [data-testid="patch-trigger"]`,
  );
}

test.describe('@aut PatchPanel acceptance flow', () => {
  test('ADSR hover-open, drag-from-Sequencer, hover-away closes', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [
      { id: 'seq',  type: 'sequencer', position: { x: 80, y: 100 } },
      { id: 'adsr', type: 'adsr',      position: { x: 700, y: 100 } },
    ]);

    // 1. ADSR panel is closed by default.
    await expect(await panel(page, 'adsr')).toHaveAttribute('aria-hidden', 'true');

    // 2. Hover ADSR's top-left affordance — panel opens.
    await (await trigger(page, 'adsr')).hover();
    await expect(await panel(page, 'adsr')).toHaveAttribute('aria-hidden', 'false');

    // 3. Verbose labels are visible.
    const labels = page.locator(
      `.svelte-flow__node[data-id="adsr"] [data-testid="patch-panel"] [data-testid="port-row-label"]`,
    );
    const labelTexts = (await labels.allTextContents()).map((s) => s.trim());
    for (const expected of ['ATTACK', 'DECAY', 'SUSTAIN', 'RELEASE', 'GATE']) {
      expect(labelTexts).toContain(expected);
    }

    // 4. Open the source panel and drag the cable. Pointerdown on the
    //    source handle activates stayOpenForDrag so the source panel
    //    survives the mouse traversal toward the target.
    await (await trigger(page, 'seq')).hover();
    await expect(await panel(page, 'seq')).toHaveAttribute('aria-hidden', 'false');

    const seqGate = page.locator(
      `.svelte-flow__node[data-id="seq"] .svelte-flow__handle[data-handleid="gate"][class*="source"]`,
    );
    const adsrGate = page.locator(
      `.svelte-flow__node[data-id="adsr"] .svelte-flow__handle[data-handleid="gate"][class*="target"]`,
    );

    const seqBox = await seqGate.boundingBox();
    expect(seqBox, 'seq gate has box').toBeTruthy();
    if (!seqBox) return;

    await page.mouse.move(seqBox.x + seqBox.width / 2, seqBox.y + seqBox.height / 2);
    await page.mouse.down();

    // Source panel stayed open mid-drag (stayOpenForDrag flag).
    await expect(await panel(page, 'seq')).toHaveAttribute('aria-hidden', 'false');

    // Open the target's panel by hovering its trigger en route — must
    // happen BEFORE we drop so the target handle's hit-zone is alive.
    const adsrTrigger = await trigger(page, 'adsr');
    const adsrTriggerBox = await adsrTrigger.boundingBox();
    expect(adsrTriggerBox, 'adsr trigger has box').toBeTruthy();
    if (!adsrTriggerBox) return;
    await page.mouse.move(
      adsrTriggerBox.x + adsrTriggerBox.width / 2,
      adsrTriggerBox.y + adsrTriggerBox.height / 2,
      { steps: 6 },
    );
    await page.waitForTimeout(150);
    await expect(await panel(page, 'adsr')).toHaveAttribute('aria-hidden', 'false');

    const adsrBox = await adsrGate.boundingBox();
    expect(adsrBox, 'adsr gate has box').toBeTruthy();
    if (!adsrBox) return;
    await page.mouse.move(
      adsrBox.x + adsrBox.width / 2,
      adsrBox.y + adsrBox.height / 2,
      { steps: 6 },
    );
    await page.mouse.up();

    // Edge created.
    await expect(
      page.locator(`.svelte-flow__edge[data-id*="seq-gate-adsr-gate"]`),
    ).toHaveCount(1);

    // 5. Move mouse away — panel closes (after the 200ms intent timeout).
    await page.mouse.move(50, 50);
    // Wait for close timeout to fire (~200ms) plus padding.
    await page.waitForTimeout(450);
    await expect(await panel(page, 'adsr')).toHaveAttribute('aria-hidden', 'true');
    await expect(await panel(page, 'seq')).toHaveAttribute('aria-hidden', 'true');
  });

  test('RIOTGIRLS spawn → hover-open → 5 sections + verbose labels', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [{ id: 'rg', type: 'riotgirls', position: { x: 200, y: 100 } }]);

    await (await trigger(page, 'rg')).hover();
    await expect(await panel(page, 'rg')).toHaveAttribute('aria-hidden', 'false');

    // Section headers organized into voices + master.
    const sections = page.locator(
      `.svelte-flow__node[data-id="rg"] [data-testid="patch-panel"] .section-title`,
    );
    const sectionTexts = (await sections.allTextContents()).map((s) => s.trim());
    expect(sectionTexts).toEqual(
      expect.arrayContaining(['Voice 1 (DG)', 'Voice 2 (DG)', 'Voice 3 (DG)', 'Voice 4 (WT)', 'Master FX']),
    );

    // Verbose label presence.
    const labels = page.locator(
      `.svelte-flow__node[data-id="rg"] [data-testid="patch-panel"] [data-testid="port-row-label"]`,
    );
    const labelTexts = (await labels.allTextContents()).map((s) => s.trim());
    expect(labelTexts).toContain('V1 TRIGGER');
    expect(labelTexts).toContain('V4 RELEASE');
    expect(labelTexts).toContain('FILTER PING DECAY');
  });
});
