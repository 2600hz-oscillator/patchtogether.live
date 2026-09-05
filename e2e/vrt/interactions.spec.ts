// e2e/vrt/interactions.spec.ts
//
// Interaction-state VRT. Complements vrt.spec.ts (per-module-card idle
// shots) and playhead.spec.ts (per-step sequencer playhead) by capturing
// the visual surfaces that come up only after user input:
//
//   - patch-panel-open      → PatchPanel popout layout regression catch
//   - node-context-menu     → right-click NodeContextMenu
//   - port-context-menu     → right-click PortContextMenu (a port handle)
//   - module-palette        → Add-module palette (pane right-click), default view
//   - palette-vcos          → palette drilled into "Audio modules → VCOs"
//   (- saved-groups-picker  → DELETED with the GROUP! module; see the note
//                            where scene 6 stood.)
//
// Baselines are authored by LINUX CI — one set, no {platform} segment (see
// vrt.config.ts). `task vrt:commit` dispatches the capture; a local macOS run
// is a smoke test, not a capture.
//
// Why these are split out from vrt.spec.ts: that file iterates over the
// MODULES list with a single test body; bolting in per-state setup logic
// would force every module test through the same per-state branches. The
// interaction surfaces here each need their own setup (route stubs, click
// sequences, hover-intent timing) and benefit from being declarative.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch, openModulePalette, canvasNode } from '../tests/_helpers';
import { pinVrtFonts, awaitVrtFonts } from './_fonts';

// Per-test exemption set, keyed `${platform}/${snapshot-stem}`. Each
// platform's missing baseline is opt-in so a future regression surfaces
// as a real diff, not a silent skip. Delete entries as linux captures land.

/** Hide elements known to introduce 1-2 px non-determinism (other-user
 *  cursors, feedback widget). Belt-and-suspenders on top of
 *  expect.toHaveScreenshot.animations: 'disabled' from vrt.config. */
async function hideJitterers(page: Page): Promise<void> {
  await page.addStyleTag({
    content: `
      .cursor, .awareness-cursor, .selection-rect { display: none !important; }
      .feedback-bug { display: none !important; }
      /* Freeze any hover-intent-debounced transition mid-flight. */
      *, *::before, *::after {
        animation: none !important;
        transition: none !important;
      }
    `,
  });
}

async function bootCanvas(page: Page): Promise<void> {
  // Pin the bundled Inter/JetBrains Mono BEFORE the first navigation and
  // await their decode after load — the app resolves card text through
  // GENERIC stacks (system-ui / ui-monospace) that fontconfig picks
  // nondeterministically, and document.fonts.ready can't see them. Without
  // this the captured text metrics differ run-to-run and platform-to-platform.
  // Full root cause: e2e/vrt/_fonts.ts.
  await pinVrtFonts(page);
  await page.goto('/rack?seed=none');
  await page.waitForLoadState('networkidle');
  await awaitVrtFonts(page);
  await hideJitterers(page);
}

test.describe.configure({ mode: 'default' });

// ----------------------------------------------------------------------
// 1. Module palette — default view (nested categories).
// ----------------------------------------------------------------------
test('module-palette: default nested view', async ({ page }) => {
  await bootCanvas(page);

  // Fixed right-click anchor for determinism (the palette is an ELEMENT
  // screenshot, so its on-page position doesn't affect the pixels — the
  // fixed point just keeps the open deterministic on the empty canvas).
  await openModulePalette(page, { position: { x: 300, y: 200 } });
  const palette = page.locator('.module-palette');
  await palette.waitFor({ state: 'visible', timeout: 5_000 });
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => r())),
  );
  await expect(palette).toHaveScreenshot('module-palette.png');
});

// ----------------------------------------------------------------------
// 2. Module palette → Audio modules → VCOs. Catches palette categorisation
//    regressions. Testid is `palette-sub-{slug-of-name}` — VCOs slugifies
//    to "vcos".
// ----------------------------------------------------------------------
test('palette-vcos: nested drill-down (Audio → VCOs)', async ({ page }) => {
  await bootCanvas(page);

  await openModulePalette(page, { position: { x: 300, y: 200 } });
  const palette = page.locator('.module-palette');
  await palette.waitFor({ state: 'visible', timeout: 5_000 });

  const audioTop = palette.locator('[data-testid^="palette-top-audio"]').first();
  await audioTop.click();

  const vcosSub = palette.locator('[data-testid="palette-sub-vcos"]');
  await vcosSub.waitFor({ state: 'visible', timeout: 5_000 });
  await vcosSub.click();

  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => r())),
  );
  await expect(palette).toHaveScreenshot('palette-vcos.png');
});

// ----------------------------------------------------------------------
// 3. Patch panel open. Click the trigger on an analogVco card (the task
//    spec explicitly calls out analogVco — and it's the canonical card so
//    panel-layout regressions show up first here).
// ----------------------------------------------------------------------
test('patch-panel-open: analogVco patch panel popout', async ({ page }) => {
  await bootCanvas(page);
  await spawnPatch(page, [
    { id: 'vco-pp', type: 'analogVco', position: { x: 80, y: 80 } },
  ]);

  // ⚠ BY NODE ID, NOT NODE TYPE. xyflow tags a lane node with its NODE TYPE
  // and every lane node is `moduleShell`, so a per-module class matches
  // nothing (the mechanism `e2e/tests/ptzcam.spec.ts` records).
  const card = canvasNode(page, 'vco-pp');
  await card.waitFor({ state: 'visible', timeout: 10_000 });

  // Redesign: clicking the trigger opens a BODY-PORTALED chrome (root view:
  // INPUT / OUTPUT pivots), edge-aligned to the card. The chrome lives at
  // body level (data-patch-panel-chrome="<nodeId>"), NOT inside the card, so
  // we screenshot the chrome element itself.
  const trigger = card.locator('[data-testid="patch-trigger"]').first();
  await trigger.click();
  const chrome = page.locator('[data-patch-panel-chrome="vco-pp"]');
  await expect(chrome).toHaveAttribute('aria-hidden', 'false', { timeout: 5_000 });

  // Two rAFs: edge-align position settle + any post-open node-internals beat.
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));

  await expect(chrome).toHaveScreenshot('patch-panel-open.png');
});

// ----------------------------------------------------------------------
// 4. Node context menu (right-click a module). Use VCA — small card, the
//    menu is the dominant visual surface.
// ----------------------------------------------------------------------
test('node-context-menu: right-click on VCA', async ({ page }) => {
  await bootCanvas(page);
  await spawnPatch(page, [
    { id: 'vca-ctx', type: 'vca', position: { x: 100, y: 100 } },
  ]);
  const card = canvasNode(page, 'vca-ctx');
  await card.waitFor({ state: 'visible', timeout: 10_000 });

  // Right-click on the card body (chunky chrome, not a knob).
  const bbox = await card.boundingBox();
  if (!bbox) throw new Error('vca card has no bounding box');
  await page.mouse.click(bbox.x + 40, bbox.y + 20, { button: 'right' });

  const menu = page.locator('[role="menu"][aria-label="Module actions"]');
  await menu.waitFor({ state: 'visible', timeout: 5_000 });
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => r())),
  );
  await expect(menu).toHaveScreenshot('node-context-menu.png');
});

// ----------------------------------------------------------------------
// 5. Port context menu (right-click a port handle). Open the LFO patch
//    panel first so the Handle is positioned in row-form rather than
//    stacked at 8,8 with opacity:0.
// ----------------------------------------------------------------------
test('port-context-menu: right-click on LFO output', async ({ page }) => {
  await bootCanvas(page);
  // Need a SECOND module so the "Patch to..." submenu has entries; otherwise
  // the menu still opens but its content is the "no other modules" stub,
  // which isn't the surface we want to baseline.
  await spawnPatch(page, [
    { id: 'lfo-pc', type: 'lfo', position: { x: 100, y: 100 } },
    { id: 'flt-pc', type: 'filter', position: { x: 600, y: 100 } },
  ]);
  const card = canvasNode(page, 'lfo-pc');
  await card.waitFor({ state: 'visible', timeout: 10_000 });

  // Redesign: the patch-to picker is reached via the carry flow — open the
  // LFO menu, drill OUTPUT, jack-click the phase0 output row (carry), then
  // "patch to" opens the overlay-replace picker (modules list). That's the
  // surface we baseline.
  await card.locator('[data-testid="patch-trigger"]').first().click();
  const chrome = page.locator('[data-patch-panel-chrome="lfo-pc"]');
  await expect(chrome).toHaveAttribute('aria-hidden', 'false', { timeout: 5_000 });
  await chrome.locator('[data-testid="patch-panel-nav"][data-nav="outputs"]').click();
  await chrome.locator('[data-testid="patch-panel-port-row"][data-port-id="phase0"]').click();
  await page.mouse.move(400, 320);
  await chrome.locator('[data-testid="patch-panel-patch-to"]').click();

  const menu = page.locator('[data-testid="port-context-menu"]');
  await menu.waitFor({ state: 'visible', timeout: 5_000 });
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => r())),
  );
  await expect(menu).toHaveScreenshot('port-context-menu.png');
});

// ----------------------------------------------------------------------
// ⚠ SCENE 6 IS GONE: `saved-groups-picker` captured the SavedGroupsPicker
// modal over a stubbed `/api/saved-groups` library, driven through the
// dev-only `__openSavedGroupsPicker` hook. The modal, the hook, the route and
// the whole saved-group library went with the GROUP! module (owner ruling:
// group and sticky are deleted entirely), so the scene has no subject left to
// capture. Its baseline is deleted in the same commit.
// ----------------------------------------------------------------------
