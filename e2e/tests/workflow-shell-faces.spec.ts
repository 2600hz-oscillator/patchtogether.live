// e2e/tests/workflow-shell-faces.spec.ts
//
// P1 batch 1 — the first six MIGRATED module faces, end to end. Two sampled
// modules (adsr + kickdrum) prove the migration seam behaves under `?shell=1`:
//
//   1) The lane renders the CURATED ModuleShell face — NOT the un-migrated
//      placeholder — with the designer's top-ranked controls live (real
//      KnobConic cells bound to the graph params) + the declared glyph at the
//      glance tiers (mini/compact — where the fit plan keeps it).
//   2) The NO-CLIP guarantee (laneBodyPlan): the fixed 192×180 tile renders
//      only WHOLE control cells at every tier — at the 'full' tier a big face
//      becomes the 3-col plate grid and ranked controls that don't fit whole
//      are simply not rendered in-lane (the dock has everything); nothing ever
//      renders partially clipped.
//   3) The dock full-view mounts the shell at the 'dock' face tier and shows
//      the curated SECTION BANDS — one labeled band per declared `face.pages`
//      page, each holding its page's controls.
//   4) Preview OFF (the default) stays a strict NO-OP for a MIGRATED module:
//      the legacy card renders in the lane exactly as today (the P0.3b
//      no-op guarantee now covering a module that HAS a face).
//
// Runs on /rack?shell=legacy (no DB/relay) — the normal e2e lane, same as
// workflow-shell.spec.ts.

import { test, expect, type Page, type Locator } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { BOOT_MS, SLOW_BOOT_TEST_TIMEOUT_MS } from '../_helpers/boot-budget';

// ⚠ THE PER-TEST BUDGET IS A BOUND, AND IT WAS THE INVISIBLE 30 s DEFAULT.
//
// This file bounds its boot wait with `BOOT_MS` — 30 000 on CI, IDENTICAL to
// the 30 000 default budget it was running inside. 1 site, 1.00x.
//
// An inner bound at or above the budget that CONTAINS it can never come true:
// the outer clock kills the test first, so a legible `element not found` is
// converted into an illegible `Test timeout of 30000ms exceeded` — the class
// #2291 root-caused and #2293 repaired at its second call site. Nothing in this
// file said "30000"; `e2e/playwright.config.ts` never overrides Playwright's
// default, so there was nothing to grep for except the ABSENCE of a budget.
//
// The budget therefore comes from `boot-budget` (90 000 on CI/SwiftShader,
// 30 000 local) instead of the invisible default. A bound only costs wall-clock
// when it is EXCEEDED, so this adds exactly zero to a green run; lane cost stays
// gauged by `--global-timeout`, not by this.
//
// ⚠ BOUNDS ONLY. No assertion, subject or wait target changed here.
test.describe.configure({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });

async function gotoWorkflow(page: Page): Promise<void> {
  await page.goto('/rack');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: BOOT_MS });
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
}

/** Set the viewport ZOOM (keeps pan) and wait for the LOD tier to settle on the
 *  target shell tile. spawnPatch's reveal parks the viewport at zoom 0.6 (the
 *  LOD 'full' band); this walks the SAME node across tier boundaries. */
async function setZoomTier(page: Page, nodeId: string, zoom: number, tier: string): Promise<void> {
  await page.evaluate((z) => {
    const f = (globalThis as unknown as { __flow: { getViewport: () => { x: number; y: number; zoom: number }; setViewport: (vp: { x: number; y: number; zoom: number }, o?: { duration?: number }) => void } }).__flow;
    const vp = f.getViewport();
    f.setViewport({ x: vp.x, y: vp.y, zoom: z }, { duration: 0 });
  }, zoom);
  await page.waitForFunction(
    ({ nodeId, tier }) => {
      const el = document.querySelector(
        `.svelte-flow__node[data-id="${nodeId}"] [data-testid="module-shell"]`,
      );
      return !!el && el.getAttribute('data-shell-tier') === tier;
    },
    { nodeId, tier },
    { timeout: 10_000 },
  );
}

/** Assert `el` renders FULLY inside the tile box (screen space, ±1px rounding)
 *  — the no-partial-cell guarantee made measurable. */
async function expectWholeInside(el: Locator, tileBox: { x: number; y: number; width: number; height: number }, what: string): Promise<void> {
  const box = await el.boundingBox();
  expect(box, `${what}: bounding box resolved`).toBeTruthy();
  expect(box!.x, `${what}: left edge inside the tile`).toBeGreaterThanOrEqual(tileBox.x - 1);
  expect(box!.y, `${what}: top edge inside the tile`).toBeGreaterThanOrEqual(tileBox.y - 1);
  expect(box!.x + box!.width, `${what}: right edge inside the tile`).toBeLessThanOrEqual(tileBox.x + tileBox.width + 1);
  expect(box!.y + box!.height, `${what}: bottom edge inside the tile (no partial clip)`).toBeLessThanOrEqual(tileBox.y + tileBox.height + 1);
}

test.describe('P1 batch-1 curated faces (?shell=1)', () => {
  // ⏸ FLAKE-PARK #1847 — parked with `test.fixme`; the body and its assertions are UNCHANGED.
  // NONDETERMINISM: 2 recovered-on-retry observation(s) across 1 SHA(s) / 1 branch(es) in the
  // 96 h CI census to 2026-08-18 — never a hard failure, so every one of those jobs reported SUCCESS.
  // LOST WHILE PARKED: the migration seam itself — that a MIGRATED module renders its curated ModuleShell face in-lane rather than the un-migrated placeholder, and that the dock exposes its declared pages.
  // Re-enable only on a root cause (#1847); "it passes now" is not one.
  test.fixme('adsr renders its SHELL face in-lane (not the placeholder) + the dock shows its pages', { annotation: { type: 'fixme', description: 'FLAKE-PARK #1847 — nondeterministic on CI: 2 recovered-on-retry observations in the 96 h census to 2026-08-18; parked until root-caused' } }, async ({ page }) => {
    await gotoWorkflow(page);
    await spawnPatch(page, [{ id: 'env', type: 'adsr', position: { x: 460, y: 240 } }]);

    const laneNode = page.locator('.svelte-flow__node[data-id="env"]');
    const shell = laneNode.locator('[data-testid="module-shell"]');

    // 1) The MIGRATED tile — the curated shell, not the placeholder. The
    //    reveal parks the zoom at 0.6 → the LOD 'full' band.
    await expect(shell).toBeVisible();
    await expect(shell).toHaveAttribute('data-shell-type', 'adsr');

    // FULL tier: adsr's 4-stage face outgrows the row → the 3-col PLATE grid.
    //
    // ⚠ FOUR STAGES AGAIN — it was three between 2026-08-12 and 2026-08-17, and
    // every one of those moves was a HEIGHT, never a ranking.
    // `faceLaneCellHeights` reserves `LANE_KNOB_READOUT_H` (57 px) for a cell
    // that PAINTS a readout and the 42 px design row otherwise. Every adsr param
    // declares a `format`, so while a `format` painted, every cell was 57 — two
    // such rows plus the 4 px gap is 118 px against a 112 px body, the plate
    // held ONE row, and DECAY (rank 4) was dock-only.
    //
    // The owner's 2026-08-17 ruling stopped a declared numeric `format` from
    // painting anything, so not one adsr cell reserves a readout line and all
    // four are back on two design-height rows. That it followed with no code
    // change is the point: `curated-face` IMPORTS the render's own
    // `paintsReadout` rather than re-typing its condition, so the reserved
    // height and the drawn line cannot disagree. The unit side of this exact
    // move is `kickdrum-face.test.ts` / `ringback-crush-model.test.ts`.
    //
    // Before the plate's tracks were sized PER ROW this face rendered all four
    // and the first three painted 9.0 CSS px OVER the fourth: `grid-auto-rows`
    // is a fixed track and `align-items: start` spills rather than clips, so
    // the A/D/S/R values sat on top of the knob beneath them. Whole cells or
    // nothing is the guarantee; four overlapping cells was neither. That fix is
    // what makes "all four render" safe now rather than a return to the bug.
    await expect(shell).toHaveAttribute('data-shell-tier', 'full');
    await expect(shell.locator('.tile-body')).toHaveAttribute('data-body-layout', 'plate');
    // TWO tracks, both the design row — one number PER ROW, space-separated.
    await expect(shell.locator('.tile-body')).toHaveAttribute('data-plate-row-h', '42 42');
    const tileBox = (await shell.boundingBox())!;
    for (const paramId of ['release', 'attack', 'sustain', 'decay']) {
      const cell = shell.locator(`[data-testid="control-${paramId}"]`);
      await expect(cell, `full: the ${paramId} cell renders`).toBeVisible();
      await expectWholeInside(cell, tileBox, `full: ${paramId} cell`);
    }
    // …so this face now has NO dock-only stage at the lane's richest tier. The
    // `expectWholeInside` loop above is what keeps that from being a regression
    // dressed as a feature: four cells that fit is the claim, not four cells.
    await expect(shell.locator('[data-glyph-kind]')).toHaveCount(0);

    // COMPACT (the glance tier): the row face — the designer's top-ranked
    // controls (RELEASE rank 1, then ATTACK — release is the only stage that
    // runs unconditionally, and under the rack's canonical 5 ms trigger pulse
    // it is the whole audible envelope) + the 'envelope' glyph sized to its
    // cell (fluid — never the old fixed-width clip).
    await setZoomTier(page, 'env', 0.45, 'compact');
    await expect(shell.locator('.tile-body')).toHaveAttribute('data-body-layout', 'row');
    await expect(shell.locator('[data-testid="control-release"]')).toBeVisible();
    await expect(shell.locator('[data-testid="control-attack"]')).toBeVisible();
    const glyph = shell.locator('[data-glyph-kind="envelope"]');
    await expect(glyph).toBeVisible();
    await expectWholeInside(glyph, (await shell.boundingBox())!, 'compact: envelope glyph');

    // 2) EXPAND → the dock full-view mounts the shell at the 'dock' tier with
    //    the curated SECTION BANDS: adsr declares ONE page ('stages') holding
    //    all four stage controls in canonical A/D/S/R order.
    await setZoomTier(page, 'env', 0.6, 'full');
    await shell.getByTestId('shell-open-dock').click();
    const faceplate = page.getByTestId('dock-full-view');
    await expect(faceplate).toBeVisible();
    const dockShell = faceplate.locator('[data-testid="module-shell"][data-shell-tier="dock"]');
    await expect(dockShell).toBeVisible();

    const pages = faceplate.locator('[data-testid="face-page"]');
    await expect(pages).toHaveCount(1);
    await expect(pages.first()).toHaveAttribute('data-face-page', 'stages');
    // The page ID is stable ('stages'); the LABEL teaches the signal path —
    // a gate drives the four stages, in the order they run.
    await expect(pages.first().locator('.page-label')).toHaveText(
      'gate → attack · decay · sustain · release',
    );
    for (const paramId of ['attack', 'decay', 'sustain', 'release']) {
      await expect(
        pages.first().locator(`[data-testid="control-${paramId}"]`),
        `page 'stages' holds the ${paramId} control`,
      ).toBeVisible();
    }
    // The dock hero glyph is present (the dock always shows everything).
    await expect(dockShell.locator('[data-glyph-kind="envelope"]')).toBeVisible();

    // ESC closes the dock; the lane shell face remains.
    await page.keyboard.press('Escape');
    await expect(faceplate).toHaveCount(0);
    await expect(shell).toBeVisible();
  });
  // ⚠ REMOVED WITH THE SIDEBAR (owner ruling, 2026-08-19): "kickdrum renders its SHELL face in-lane + a HERO slot over five curated pages".
  // Its subject was a dock sidebar panel; `face.sidebar` is deleted
  // platform-wide, so there is no element left to assert on. See
  // ModuleFaceHero in graph/types.ts for the ruling set.
});
