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
// Runs on /rack?mode=workflow (no DB/relay) — the normal e2e lane, same as
// workflow-shell.spec.ts.

import { test, expect, type Page, type Locator } from '@playwright/test';
import { spawnPatch } from './_helpers';

async function gotoWorkflow(page: Page, opts: { shell: boolean }): Promise<void> {
  await page.goto(opts.shell ? '/rack?mode=workflow&shell=1' : '/rack?mode=workflow');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible();
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
  test('adsr renders its SHELL face in-lane (not the placeholder) + the dock shows its pages', async ({ page }) => {
    await gotoWorkflow(page, { shell: true });
    await spawnPatch(page, [{ id: 'env', type: 'adsr', position: { x: 460, y: 240 } }]);

    const laneNode = page.locator('.svelte-flow__node[data-id="env"]');
    const shell = laneNode.locator('[data-testid="module-shell"]');

    // 1) The MIGRATED tile — the curated shell, not the placeholder. The
    //    reveal parks the zoom at 0.6 → the LOD 'full' band.
    await expect(shell).toBeVisible();
    await expect(shell).toHaveAttribute('data-shell-type', 'adsr');
    await expect(laneNode.locator('[data-testid="module-shell-placeholder"]')).toHaveCount(0);

    // FULL tier: adsr's 4-stage face outgrows the row → the 3-col PLATE grid.
    // All four stages render as WHOLE cells; the glyph strip doesn't fit a
    // 2-row plate, so it is not rendered in-lane at this tier (no clipping —
    // the fit plan drops whole elements, never truncates them).
    await expect(shell).toHaveAttribute('data-shell-tier', 'full');
    await expect(shell.locator('.tile-body')).toHaveAttribute('data-body-layout', 'plate');
    const tileBox = (await shell.boundingBox())!;
    for (const paramId of ['attack', 'decay', 'sustain', 'release']) {
      const cell = shell.locator(`[data-testid="control-${paramId}"]`);
      await expect(cell, `full: the ${paramId} cell renders`).toBeVisible();
      await expectWholeInside(cell, tileBox, `full: ${paramId} cell`);
    }
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

  test('kickdrum renders its SHELL face in-lane + the dock shows all six curated pages', async ({ page }) => {
    await gotoWorkflow(page, { shell: true });
    await spawnPatch(page, [{ id: 'kd', type: 'kickdrum', position: { x: 460, y: 240 } }]);

    const laneNode = page.locator('.svelte-flow__node[data-id="kd"]');
    const shell = laneNode.locator('[data-testid="module-shell"]');

    // 1) The MIGRATED tile at the reveal zoom (0.6 → LOD 'full').
    await expect(shell).toBeVisible();
    await expect(shell).toHaveAttribute('data-shell-type', 'kickdrum');
    await expect(laneNode.locator('[data-testid="module-shell-placeholder"]')).toHaveCount(0);

    // FULL tier: kickdrum's 26-rank face → the PLATE grid, WHOLE rows only:
    // exactly ranks 1-6 render (2 rows × 3 cols); rank 7+ (the audition,
    // pitch_time, level, …) are NOT rendered in-lane — never clipped — and the
    // dock has them. Ranks 1-6 are the WHOLE lane budget, by geometry.
    await expect(shell).toHaveAttribute('data-shell-tier', 'full');
    await expect(shell.locator('.tile-body')).toHaveAttribute('data-body-layout', 'plate');
    const tileBox = (await shell.boundingBox())!;
    for (const paramId of ['tune', 'sub_decay', 'drive', 'pitch_amt', 'body_level', 'click_level']) {
      const cell = shell.locator(`[data-testid="control-${paramId}"]`);
      await expect(cell, `full: rank cell ${paramId} renders`).toBeVisible();
      await expectWholeInside(cell, tileBox, `full: ${paramId} cell`);
    }
    await expect(shell.locator('[data-testid="control-pitch_time"]')).toHaveCount(0);
    await expect(shell.locator('[data-testid="control-level"]')).toHaveCount(0);
    await expect(shell.locator('[data-glyph-kind]')).toHaveCount(0);

    // COMPACT: the row face — the hero knob (tune) + the 'scope' glyph (the
    // decaying-burst trace) sized to the remaining row width, WHOLE cells only
    // (rank 3 'drive' yields its slot to the glyph at this width).
    await setZoomTier(page, 'kd', 0.45, 'compact');
    await expect(shell.locator('.tile-body')).toHaveAttribute('data-body-layout', 'row');
    await expect(shell.locator('[data-testid="control-tune"]')).toBeVisible();
    await expect(shell.locator('[data-testid="control-drive"]')).toHaveCount(0);
    const glyph = shell.locator('[data-glyph-kind="scope"]');
    await expect(glyph).toBeVisible();
    await expectWholeInside(glyph, (await shell.boundingBox())!, 'compact: scope glyph');

    // 2) The dock full-view shows the six designed section bands: the HERO
    //    strip, then the three numbered generator layers, then the bus.
    await setZoomTier(page, 'kd', 0.6, 'full');
    await shell.getByTestId('shell-open-dock').click();
    const faceplate = page.getByTestId('dock-full-view');
    await expect(faceplate).toBeVisible();
    await expect(faceplate.locator('[data-testid="module-shell"][data-shell-tier="dock"]')).toBeVisible();

    const pages = faceplate.locator('[data-testid="face-page"]');
    await expect(pages).toHaveCount(6);
    const ids = await pages.evaluateAll((els) => els.map((el) => el.getAttribute('data-face-page')));
    expect(ids).toEqual(['hero', 'sub', 'body', 'click', 'drive', 'dynamics']);
    // Spot-check band membership: the drive page holds the drive knob.
    await expect(
      pages.nth(4).locator('[data-testid="control-drive"]'),
      "page 'drive' holds the drive control",
    ).toBeVisible();
    // The AUDITION leads the faceplate — the dock pane shows ~2 bands before it
    // scrolls, so a strike button further down would be unreachable without
    // scrolling on the one voice that is silent until you hit it.
    await expect(
      pages.nth(0).getByTestId('shell-cell-kickdrum-strike'),
      "page 'hero' leads with the STRIKE audition",
    ).toBeVisible();

    // ── THE HERO BAND IS THE REDESIGN, so assert what it actually says ──
    //
    // The owner's finding was that the shipped face was bands of bare knobs
    // with no title, no readouts, no chain and no presets. These four
    // assertions are that finding, inverted: each one FAILS on the face as it
    // shipped, so they cannot pass by accident on a regression.
    const hero = pages.nth(0);
    // (a) the live caption, derived from the envelope params — not a label.
    await expect(hero.getByTestId('kickdrum-hero-caption')).toHaveText(
      /tail ≈ \d+ ms · \+?\d+ st → \d+ Hz/,
    );
    // (b) the signal-flow diagram, ending where the DSP ends.
    await expect(hero.getByTestId('kickdrum-flow-SUB')).toBeVisible();
    await expect(hero.getByTestId('kickdrum-flow-OUT L·R')).toBeVisible();
    // (c) the stereo-crossover picture.
    await expect(hero.getByTestId('kickdrum-crossover')).toBeVisible();
    // (d) the presets SELECT: clicking 909 CLASSIC stamps its tune (62 Hz),
    //     which the TUNE readout right beside it must then print.
    await hero.getByTestId('kickdrum-preset-909-classic').click();
    await expect(hero.getByTestId('readout-tune')).toHaveText('62 Hz');
    await expect(hero.getByTestId('kickdrum-preset-909-classic')).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    // A VALUE UNDER EVERY KNOB — the mock's other structural demand. Sample
    // one knob per unit family; the def-level gate (kickdrum-face-model.test)
    // holds the completeness half.
    await expect(faceplate.getByTestId('readout-sub_decay')).toHaveText(/^\d+ ms$/);
    await expect(faceplate.getByTestId('readout-body_eq')).toHaveText(/^[+−-]?\d+\.\d dB$/);
    await expect(faceplate.getByTestId('readout-click_tone')).toHaveText(/kHz$|Hz$/);
    await expect(faceplate.getByTestId('readout-body_shape')).toHaveText(/^(SINE|TRI|RECT)$/);

    // The merged 'dynamics · out' band carries BOTH ideas, split by clusters
    // (a ~14px sub-header) rather than by a seventh ~81px band.
    for (const paramId of ['ceiling', 'width', 'level']) {
      await expect(
        pages.nth(5).locator(`[data-testid="control-${paramId}"]`),
        `page 'dynamics' holds ${paramId}`,
      ).toBeVisible();
    }
    // The in-lane-dropped ranks are all reachable in the dock (dock = ALL).
    await expect(faceplate.locator('[data-testid="control-pitch_time"]')).toBeVisible();
    await expect(faceplate.locator('[data-testid="control-level"]')).toBeVisible();
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
