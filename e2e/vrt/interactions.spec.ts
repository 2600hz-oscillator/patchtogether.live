// e2e/vrt/interactions.spec.ts
//
// Interaction-state VRT. Complements vrt.spec.ts (per-module-card idle
// shots) and playhead.spec.ts (per-step sequencer playhead) by capturing
// the visual surfaces that come up only after user input:
//
//   - patch-panel-open      → PatchPanel popout layout regression catch
//   - node-context-menu     → right-click NodeContextMenu
//   - port-context-menu     → right-click PortContextMenu (a port handle)
//   - module-palette        → "+ Add module" topbar dropdown, default view
//   - palette-vcos          → palette drilled into "Audio modules → VCOs"
//   - saved-groups-picker   → modal overlay (api stubbed for determinism)
//
// Same path template + per-platform layout as vrt.spec.ts (see
// vrt.config.ts snapshotPathTemplate). Linux baselines are pending on
// first-land — exempted via EXEMPT_BASELINE_PAIRS below. Capture follow-up
// via `task vrt:update` inside docker on a linux runner and remove the
// exemption entries.
//
// Why these are split out from vrt.spec.ts: that file iterates over the
// MODULES list with a single test body; bolting in per-state setup logic
// would force every module test through the same per-state branches. The
// interaction surfaces here each need their own setup (route stubs, click
// sequences, hover-intent timing) and benefit from being declarative.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from '../tests/_helpers';

// Per-test exemption set, keyed `${platform}/${snapshot-stem}`. Each
// platform's missing baseline is opt-in so a future regression surfaces
// as a real diff, not a silent skip. Delete entries as linux captures land.
const EXEMPT_BASELINE_PAIRS = new Set<string>([
  'linux/patch-panel-open',
  'linux/node-context-menu',
  'linux/port-context-menu',
  'linux/module-palette',
  'linux/palette-vcos',
  'linux/saved-groups-picker',
]);
const VRT_PLATFORM = process.platform === 'darwin' ? 'darwin' : 'linux';

function skipIfNoBaseline(t: typeof test, name: string): void {
  t.skip(
    EXEMPT_BASELINE_PAIRS.has(`${VRT_PLATFORM}/${name}`),
    `${name} on ${VRT_PLATFORM}: baseline pending (CI capture follow-up)`,
  );
}

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
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await hideJitterers(page);
}

test.describe.configure({ mode: 'default' });

// ----------------------------------------------------------------------
// 1. Module palette — default view (nested categories).
// ----------------------------------------------------------------------
test('module-palette: default nested view', async ({ page }) => {
  skipIfNoBaseline(test, 'module-palette');
  await bootCanvas(page);

  await page.locator('header.topbar button', { hasText: '+ Add module' }).click();
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
  skipIfNoBaseline(test, 'palette-vcos');
  await bootCanvas(page);

  await page.locator('header.topbar button', { hasText: '+ Add module' }).click();
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
  skipIfNoBaseline(test, 'patch-panel-open');
  await bootCanvas(page);
  await spawnPatch(page, [
    { id: 'vco-pp', type: 'analogVco', position: { x: 80, y: 80 } },
  ]);

  const card = page.locator('.svelte-flow__node-analogVco').first();
  await card.waitFor({ state: 'visible', timeout: 10_000 });

  // Click is the deterministic open path (hover-intent has timing slop).
  const trigger = card.locator('[data-testid="patch-trigger"]').first();
  await trigger.click();
  const panel = card.locator('[data-testid="patch-panel"]').first();
  await expect(panel).toHaveAttribute('aria-hidden', 'false', { timeout: 5_000 });

  // Two rAFs: one for the panel transition (now 0s thanks to hideJitterers)
  // and one for any post-open Handle reposition triggered by
  // useUpdateNodeInternals.
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));

  await expect(card).toHaveScreenshot('patch-panel-open.png');
});

// ----------------------------------------------------------------------
// 4. Node context menu (right-click a module). Use VCA — small card, the
//    menu is the dominant visual surface.
// ----------------------------------------------------------------------
test('node-context-menu: right-click on VCA', async ({ page }) => {
  skipIfNoBaseline(test, 'node-context-menu');
  await bootCanvas(page);
  await spawnPatch(page, [
    { id: 'vca-ctx', type: 'vca', position: { x: 100, y: 100 } },
  ]);
  const card = page.locator('.svelte-flow__node-vca').first();
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
  skipIfNoBaseline(test, 'port-context-menu');
  await bootCanvas(page);
  // Need a SECOND module so the "Patch to..." submenu has entries; otherwise
  // the menu still opens but its content is the "no other modules" stub,
  // which isn't the surface we want to baseline.
  await spawnPatch(page, [
    { id: 'lfo-pc', type: 'lfo', position: { x: 100, y: 100 } },
    { id: 'flt-pc', type: 'filter', position: { x: 600, y: 100 } },
  ]);
  const card = page.locator('.svelte-flow__node-lfo').first();
  await card.waitFor({ state: 'visible', timeout: 10_000 });

  await card.locator('[data-testid="patch-trigger"]').first().click();
  await expect(card.locator('[data-testid="patch-panel"]').first()).toHaveAttribute(
    'aria-hidden',
    'false',
    { timeout: 5_000 },
  );
  // Settle: Handle reposition rAF + Svelte Flow's node-handles bookkeeping.
  await page.waitForTimeout(250);

  // Locate the LFO's `phase0` source handle INSIDE the open patch panel
  // (the off-canvas card-corner handles also exist but are hidden). Pattern
  // mirrors e2e/tests/patch-to-cascade.spec.ts's rightClickPanelHandle —
  // hover keeps the panel's hover-driver alive, then click({button:'right'})
  // synthesizes a contextmenu the capture-phase doc listener picks up.
  // page.mouse.click(x,y,{button:'right'}) does NOT reliably reach the
  // handle's contextmenu listener in this Svelte Flow setup.
  const handle = card.locator(
    '[data-testid="patch-panel"] .svelte-flow__handle[data-handleid="phase0"]',
  );
  await expect(handle).toBeVisible();
  await handle.hover();
  await handle.click({ button: 'right' });

  const menu = page.locator('[data-testid="port-context-menu"]');
  await menu.waitFor({ state: 'visible', timeout: 5_000 });
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => r())),
  );
  await expect(menu).toHaveScreenshot('port-context-menu.png');
});

// ----------------------------------------------------------------------
// 6. Saved-groups picker. Stub /api/saved-groups so the modal renders a
//    deterministic 2-row library. Production trigger is auth-gated; the
//    modal component itself is always mounted, so we flip its `open` prop
//    directly via the dev-only __openSavedGroupsPicker hook wired up in
//    Canvas.svelte.
// ----------------------------------------------------------------------
test('saved-groups-picker: modal with stubbed library', async ({ page }) => {
  skipIfNoBaseline(test, 'saved-groups-picker');
  // Route-stub must register before navigation so the first GET is caught.
  await page.route('**/api/saved-groups', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        savedGroups: [
          {
            id: 'sg-vrt-1',
            label: 'Acid bass',
            payload: {
              children: [{}, {}, {}],
              internalEdges: [{}, {}],
            },
          },
          {
            id: 'sg-vrt-2',
            label: 'Pad voice',
            payload: {
              children: [{}, {}, {}, {}],
              internalEdges: [{}, {}, {}],
            },
          },
        ],
      }),
    });
  });
  await bootCanvas(page);

  await page.waitForFunction(() => {
    const w = globalThis as unknown as { __openSavedGroupsPicker?: () => void };
    return typeof w.__openSavedGroupsPicker === 'function';
  });
  await page.evaluate(() => {
    const w = globalThis as unknown as { __openSavedGroupsPicker: () => void };
    w.__openSavedGroupsPicker();
  });

  const modal = page.locator('[data-testid="saved-groups-picker"]');
  await modal.waitFor({ state: 'visible', timeout: 5_000 });
  // Wait for the stubbed rows to render (loading→loaded transition).
  await modal.locator('[data-testid="saved-group-row"]').first().waitFor({
    state: 'visible',
    timeout: 5_000,
  });
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => r())),
  );
  await expect(modal).toHaveScreenshot('saved-groups-picker.png');
});
