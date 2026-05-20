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
  test('ADSR click-open, drag-from-Sequencer, outside-click closes', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [
      { id: 'seq',  type: 'sequencer', position: { x: 80, y: 100 } },
      { id: 'adsr', type: 'adsr',      position: { x: 700, y: 100 } },
    ]);

    // 1. ADSR panel is closed by default.
    await expect(await panel(page, 'adsr')).toHaveAttribute('aria-hidden', 'true');

    // 2. Click ADSR's top-left affordance — panel opens. (Hover-open
    //    was removed in the patch-menu-UX streamline, PR-204.)
    await (await trigger(page, 'adsr')).click();
    await expect(await panel(page, 'adsr')).toHaveAttribute('aria-hidden', 'false');

    // 3. Verbose labels are visible.
    const labels = page.locator(
      `.svelte-flow__node[data-id="adsr"] [data-testid="patch-panel"] [data-testid="port-row-label"]`,
    );
    const labelTexts = (await labels.allTextContents()).map((s) => s.trim());
    for (const expected of ['ATTACK', 'DECAY', 'SUSTAIN', 'RELEASE', 'GATE']) {
      expect(labelTexts).toContain(expected);
    }

    // 4. Pin the seq panel open too (adsr was already pinned at step 2 —
    //    re-clicking its trigger would TOGGLE the pin off, which then
    //    drops the panel back to hover-only state). Both panels must be
    //    pinned open so the cable-drag below has stable handle geometry.
    await (await trigger(page, 'seq')).click();
    await expect(await panel(page, 'seq')).toHaveAttribute('aria-hidden', 'false');
    await expect(await panel(page, 'adsr')).toHaveAttribute('aria-hidden', 'false');

    const seqGate = page.locator(
      `.svelte-flow__node[data-id="seq"] .svelte-flow__handle[data-handleid="gate"][class*="source"]`,
    );
    const adsrGate = page.locator(
      `.svelte-flow__node[data-id="adsr"] .svelte-flow__handle[data-handleid="gate"][class*="target"]`,
    );

    const seqBox = await seqGate.boundingBox();
    const adsrBox = await adsrGate.boundingBox();
    expect(seqBox, 'seq gate has box').toBeTruthy();
    expect(adsrBox, 'adsr gate has box').toBeTruthy();
    if (!seqBox || !adsrBox) return;

    await page.mouse.move(seqBox.x + seqBox.width / 2, seqBox.y + seqBox.height / 2);
    await page.mouse.down();

    // Source panel stays open mid-drag (pinned + stayOpenForDrag).
    await expect(await panel(page, 'seq')).toHaveAttribute('aria-hidden', 'false');

    // Use 25 intermediate steps so Svelte Flow's drag tracker reliably
    // sees the pointermove sequence; a coarser drag (steps: 10 across
    // 600+ px = 60 px/step) was observed to skip handle hit-tests on
    // slower CI runners and leave the connection unformed.
    await page.mouse.move(
      adsrBox.x + adsrBox.width / 2,
      adsrBox.y + adsrBox.height / 2,
      { steps: 25 },
    );
    await page.mouse.up();
    await page.waitForTimeout(150);

    // Edge created.
    await expect(
      page.locator(`.svelte-flow__edge[data-id*="seq-gate-adsr-gate"]`),
    ).toHaveCount(1);

    // The 50 ms click-and-hold timer in Canvas can race the cable-drag's
    // first pointermove on slow CI: if the holdTimer fires before the
    // drag exceeds the 4 px threshold, the patch-to cascade opens at
    // the source port AND `connectDragState.beginCascade(seq)` engages —
    // which sticks `cascadeLockEngaged=true` on the seq panel until the
    // cascade closes. Press Esc first to dismiss any cascade that may
    // have opened, so the next outside-click is the one that drops the
    // panels' pinned drivers.
    await page.keyboard.press('Escape');

    // 5. Outside-click closes both pinned panels (an outside pointerdown
    //    drops the pinned + hovered drivers). Click on the svelte-flow
    //    pane (the canvas background) in a region that is unambiguously
    //    outside every module card — using the .svelte-flow__pane
    //    element directly is more robust than a screen coordinate, since
    //    the topbar and modules can shift between viewport sizes.
    await page.locator('.svelte-flow__pane').click({ position: { x: 50, y: 50 } });
    // toHaveAttribute auto-retries up to 5s, which absorbs the brief gap
    // between the document pointerdown handler clearing the drivers and
    // Svelte propagating the derived `open` flip into aria-hidden.
    await expect(await panel(page, 'adsr')).toHaveAttribute('aria-hidden', 'true');
    await expect(await panel(page, 'seq')).toHaveAttribute('aria-hidden', 'true');
  });

  test('RIOTGIRLS spawn → click-open → 5 sections + verbose labels', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [{ id: 'rg', type: 'riotgirls', position: { x: 200, y: 100 } }]);

    await (await trigger(page, 'rg')).click();
    await expect(await panel(page, 'rg')).toHaveAttribute('aria-hidden', 'false');

    // Section headers organized into voices + master. Post-PR(nested-
    // sections) the per-section header is a clickable <button> exposing
    // data-section-label; we assert via that attribute rather than text
    // content (which now bundles the disclosure glyph + port-count).
    for (const label of [
      'Voice 1 (DG)',
      'Voice 2 (DG)',
      'Voice 3 (DG)',
      'Voice 4 (WT)',
      'Master FX',
    ]) {
      const header = page.locator(
        `.svelte-flow__node[data-id="rg"] ` +
          `[data-testid="patch-panel-section-toggle"][data-section-label="${label}"]`,
      );
      await expect(header, `header for "${label}" rendered`).toHaveCount(1);
    }

    // Verbose label presence — labels stay in DOM regardless of
    // section expand/collapse state, so allTextContents() finds them
    // even with all sections defaulting to collapsed.
    const labels = page.locator(
      `.svelte-flow__node[data-id="rg"] [data-testid="patch-panel"] [data-testid="port-row-label"]`,
    );
    const labelTexts = (await labels.allTextContents()).map((s) => s.trim());
    expect(labelTexts).toContain('V1 TRIGGER');
    expect(labelTexts).toContain('V4 RELEASE');
    expect(labelTexts).toContain('FILTER PING DECAY');
  });
});
