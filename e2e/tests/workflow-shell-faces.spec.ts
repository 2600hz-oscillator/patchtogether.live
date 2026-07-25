// e2e/tests/workflow-shell-faces.spec.ts
//
// P1 batch 1 — the first six MIGRATED module faces, end to end. Two sampled
// modules (adsr + kickdrum) prove the migration seam behaves under `?shell=1`:
//
//   1) The lane renders the CURATED ModuleShell face — NOT the un-migrated
//      placeholder — with the designer's top-ranked controls live (real
//      KnobConic cells bound to the graph params) + the declared glyph.
//   2) The dock full-view mounts the shell at the 'dock' face tier and shows
//      the curated SECTION BANDS — one labeled band per declared `face.pages`
//      page, each holding its page's controls.
//   3) Preview OFF (the default) stays a strict NO-OP for a MIGRATED module:
//      the legacy card renders in the lane exactly as today (the P0.3b
//      no-op guarantee now covering a module that HAS a face).
//
// Runs on /rack?mode=workflow (no DB/relay) — the normal e2e lane, same as
// workflow-shell.spec.ts.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

async function gotoWorkflow(page: Page, opts: { shell: boolean }): Promise<void> {
  await page.goto(opts.shell ? '/rack?mode=workflow&shell=1' : '/rack?mode=workflow');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible();
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
}

test.describe('P1 batch-1 curated faces (?shell=1)', () => {
  test('adsr renders its SHELL face in-lane (not the placeholder) + the dock shows its pages', async ({ page }) => {
    await gotoWorkflow(page, { shell: true });
    await spawnPatch(page, [{ id: 'env', type: 'adsr', position: { x: 460, y: 240 } }]);

    const laneNode = page.locator('.svelte-flow__node[data-id="env"]');
    const shell = laneNode.locator('[data-testid="module-shell"]');

    // 1) The MIGRATED tile — the curated shell, not the placeholder.
    await expect(shell).toBeVisible();
    await expect(shell).toHaveAttribute('data-shell-type', 'adsr');
    await expect(laneNode.locator('[data-testid="module-shell-placeholder"]')).toHaveCount(0);

    // The designer's top-ranked control (attack — rank 1, so it shows at EVERY
    // tier) is a live curated KnobConic cell, and the 'envelope' glyph renders.
    await expect(shell.locator('[data-testid="control-attack"]')).toBeVisible();
    await expect(shell.locator('[data-glyph-kind="envelope"]')).toBeVisible();

    // 2) EXPAND → the dock full-view mounts the shell at the 'dock' tier with
    //    the curated SECTION BANDS: adsr declares ONE page ('stages') holding
    //    all four stage controls in canonical A/D/S/R order.
    await shell.getByTestId('shell-open-dock').click();
    const faceplate = page.getByTestId('dock-full-view');
    await expect(faceplate).toBeVisible();
    const dockShell = faceplate.locator('[data-testid="module-shell"][data-shell-tier="dock"]');
    await expect(dockShell).toBeVisible();

    const pages = faceplate.locator('[data-testid="face-page"]');
    await expect(pages).toHaveCount(1);
    await expect(pages.first()).toHaveAttribute('data-face-page', 'stages');
    await expect(pages.first().locator('.page-label')).toHaveText('stages');
    for (const paramId of ['attack', 'decay', 'sustain', 'release']) {
      await expect(
        pages.first().locator(`[data-testid="control-${paramId}"]`),
        `page 'stages' holds the ${paramId} control`,
      ).toBeVisible();
    }

    // ESC closes the dock; the lane shell face remains.
    await page.keyboard.press('Escape');
    await expect(faceplate).toHaveCount(0);
    await expect(shell).toBeVisible();
  });

  test('kickdrum renders its SHELL face in-lane + the dock shows all six curated pages', async ({ page }) => {
    await gotoWorkflow(page, { shell: true });
    await spawnPatch(page, [{ id: 'kd', type: 'kickdrum', position: { x: 460, y: 240 } }]);

    const laneNode = page.locator('.svelte-flow__node[data-id="kd"]');
    const shell = laneNode.locator('[data-testid="module-shell"]');

    // 1) The MIGRATED tile with the designer's hero control (tune — rank 1)
    //    live + the 'scope' glyph.
    await expect(shell).toBeVisible();
    await expect(shell).toHaveAttribute('data-shell-type', 'kickdrum');
    await expect(laneNode.locator('[data-testid="module-shell-placeholder"]')).toHaveCount(0);
    await expect(shell.locator('[data-testid="control-tune"]')).toBeVisible();
    await expect(shell.locator('[data-glyph-kind="scope"]')).toBeVisible();

    // 2) The dock full-view shows the six designed section bands, in the
    //    designer's reading order (the layers, then the bus).
    await shell.getByTestId('shell-open-dock').click();
    const faceplate = page.getByTestId('dock-full-view');
    await expect(faceplate).toBeVisible();
    await expect(faceplate.locator('[data-testid="module-shell"][data-shell-tier="dock"]')).toBeVisible();

    const pages = faceplate.locator('[data-testid="face-page"]');
    await expect(pages).toHaveCount(6);
    const ids = await pages.evaluateAll((els) => els.map((el) => el.getAttribute('data-face-page')));
    expect(ids).toEqual(['sub', 'body', 'click', 'drive', 'dynamics', 'output']);
    // Spot-check band membership: the drive page holds the drive knob.
    await expect(
      pages.nth(3).locator('[data-testid="control-drive"]'),
      "page 'drive' holds the drive control",
    ).toBeVisible();
  });

  test('preview OFF stays a strict no-op for a MIGRATED module: the legacy card renders in the lane', async ({ page }) => {
    await gotoWorkflow(page, { shell: false });
    await spawnPatch(page, [{ id: 'env', type: 'adsr', position: { x: 460, y: 240 } }]);

    const laneNode = page.locator('.svelte-flow__node[data-id="env"]');
    await expect(laneNode).toHaveCount(1);
    // The REAL legacy card + its controls render in the lane, exactly as today…
    await expect(laneNode.locator('[data-testid="control-attack"]')).toBeVisible();
    // …and NEITHER shell surface is emitted (no shell, no placeholder).
    await expect(laneNode.locator('[data-testid="module-shell"]')).toHaveCount(0);
    await expect(laneNode.locator('[data-testid="module-shell-placeholder"]')).toHaveCount(0);
  });
});
