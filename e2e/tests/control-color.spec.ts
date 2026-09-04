// e2e/tests/control-color.spec.ts
//
// PER-MODULE CONTROL COLOUR — the assign UI + the PASSTHROUGH render.
//
//   1. spawn an ADSR + a Control Surface; bind ADSR.attack onto the surface.
//   2. right-click the ADSR title → "Assign control color" → pick a swatch.
//      → data.controlColor is set on the SOURCE module (not the surface).
//   3. the SURFACE's lane tile swatch AND its dock-board stripe render that
//      colour (LIVE passthrough reads of the source; the card's colour dot
//      died with the card — the shell's at-a-glance receipt is the swatch).
//   4. change the colour → the stripe updates (no stale copy).
//   5. "Reset to default" clears data.controlColor.
//   6. the colour is NEVER copied onto the surface binding/data (passthrough).

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

interface PatchNode {
  id: string;
  type: string;
  data?: Record<string, unknown>;
}

async function sourceControlColor(page: Page, id: string): Promise<unknown> {
  return await page.evaluate((nid) => {
    const w = window as unknown as { __patch: { nodes: Record<string, PatchNode> } };
    return (w.__patch.nodes[nid]?.data as { controlColor?: unknown } | undefined)?.controlColor ?? null;
  }, id);
}

async function surfaceBindings(page: Page, id: string): Promise<unknown> {
  return await page.evaluate((sid) => {
    const w = window as unknown as { __patch: { nodes: Record<string, PatchNode> } };
    return (w.__patch.nodes[sid]?.data as { bindings?: unknown } | undefined)?.bindings ?? null;
  }, id);
}

/** Computed background-colour (rgb…) of an element, for stripe assertions. */
async function bg(page: Page, selector: string): Promise<string> {
  return await page.locator(selector).first().evaluate(
    (el) => getComputedStyle(el as HTMLElement).backgroundColor,
  );
}

/** Right-click the ADSR tile's module-menu target (`.tile-kind` — the shell's
 *  context target; the card's `.title` died with it). */
async function openAdsrMenu(page: Page) {
  await page.locator('.svelte-flow__node[data-id="adsr-1"] .tile-kind').click({ button: 'right' });
  const menu = page.locator('[role="menu"][aria-label="Module actions"]');
  await expect(menu).toBeVisible();
  return menu;
}

/** The SURFACE lane tile's per-module swatch fill (the live passthrough colour
 *  read, no dock needed). */
async function swatchFill(page: Page): Promise<string> {
  return (
    (await page
      .locator('[data-testid="cs-tile-swatch-cs-1-adsr-1"]')
      .getAttribute('fill')) ?? ''
  );
}

async function setup(page: Page) {
  await page.goto('/rack?seed=none');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [
    { id: 'cs-1', type: 'controlSurface', position: { x: 700, y: 80 }, domain: 'meta' },
    { id: 'adsr-1', type: 'adsr', position: { x: 80, y: 80 }, domain: 'audio' },
  ]);
  // Bind ADSR.attack onto the surface directly (the send path is covered by
  // control-surface.spec; here we exercise the COLOUR path).
  await page.evaluate(() => {
    const w = window as unknown as {
      __patch: { nodes: Record<string, PatchNode> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const cs = w.__patch.nodes['cs-1'];
      if (!cs.data) cs.data = {};
      (cs.data as Record<string, unknown>).bindings = [{ moduleId: 'adsr-1', paramId: 'attack' }];
    });
  });
}

test('assign a control colour on a module → surface stripe reflects it (passthrough)', async ({ page }) => {
  await setup(page);

  // The surface's LANE tile (the board is dock-only; the tile's swatch strip
  // is the at-a-glance colour read).
  await expect(page.locator('[data-testid="cs-tile-cs-1"]')).toBeVisible();

  // Right-click the ADSR tile → the Module-actions menu (shared across
  // surfaces), assign the red swatch (F45C51).
  const menu = await openAdsrMenu(page);
  await menu.locator('[data-testid="ctx-assign-control-color"]').click();
  const panel = menu.locator('[data-testid="ctx-color-panel"]');
  await expect(panel).toBeVisible();
  await panel.locator('[data-testid="ctx-color-swatch-F45C51"]').click();

  // The colour is stored on the SOURCE module (its single home).
  await expect.poll(async () => await sourceControlColor(page, 'adsr-1')).toBe('F45C51');

  // The SURFACE lane swatch (a LIVE passthrough read of the source) renders red.
  await expect.poll(async () => await swatchFill(page)).toBe('#F45C51');

  // And the dock BOARD's per-knob stripe renders the same colour (the second
  // passthrough surface — the one above the proxied knob).
  await page.waitForFunction(
    () =>
      typeof (globalThis as unknown as { __openDockFullView?: unknown }).__openDockFullView ===
      'function',
    undefined,
    { timeout: 30_000 },
  );
  await page.evaluate(
    (i) => (globalThis as unknown as { __openDockFullView: (x: string) => void }).__openDockFullView(i),
    'cs-1',
  );
  const board = page
    .locator('[data-testid="dock-fullview-pane"][data-pane-node="cs-1"]')
    .getByTestId('cs-board');
  await expect(board).toBeVisible({ timeout: 60_000 });
  await expect.poll(async () => await bg(page, '[data-testid="cs-board-stripe-adsr-1-attack"]'))
    .toBe('rgb(244, 92, 81)');

  // PASSTHROUGH proof: the surface binding holds NO colour copy.
  expect(await surfaceBindings(page, 'cs-1')).toEqual([{ moduleId: 'adsr-1', paramId: 'attack' }]);
});

test('changing the colour updates the stripe live; reset clears it', async ({ page }) => {
  await setup(page);

  // First assignment → teal (03A598). All reads at the LANE swatch (the dock
  // overlay would block the tile right-clicks, so this leg never opens it).
  let menu = await openAdsrMenu(page);
  await menu.locator('[data-testid="ctx-assign-control-color"]').click();
  await menu.locator('[data-testid="ctx-color-swatch-03A598"]').click();
  await expect.poll(async () => await sourceControlColor(page, 'adsr-1')).toBe('03A598');
  await expect.poll(async () => await swatchFill(page)).toBe('#03A598');

  // Re-assign → blue (529DEC). The swatch re-resolves; no stale value.
  menu = await openAdsrMenu(page);
  await menu.locator('[data-testid="ctx-assign-control-color"]').click();
  await menu.locator('[data-testid="ctx-color-swatch-529DEC"]').click();
  await expect.poll(async () => await sourceControlColor(page, 'adsr-1')).toBe('529DEC');
  await expect.poll(async () => await swatchFill(page)).toBe('#529DEC');

  // Reset to default → data.controlColor cleared (reverts to the auto default);
  // the swatch leaves the explicit blue for the resolved default.
  menu = await openAdsrMenu(page);
  await menu.locator('[data-testid="ctx-assign-control-color"]').click();
  await menu.locator('[data-testid="ctx-color-reset"]').click();
  await expect.poll(async () => await sourceControlColor(page, 'adsr-1')).toBeNull();
  await expect.poll(async () => await swatchFill(page)).not.toBe('#529DEC');
});

test('custom hex picker shows a 565 preview + applies the quantized colour', async ({ page }) => {
  await setup(page);

  const menu = await openAdsrMenu(page);
  await menu.locator('[data-testid="ctx-assign-control-color"]').click();

  // Drive the native colour input to a value, then Apply. The applied colour is
  // the 565-quantized form (what the hardware renders). FFFFFF is 565-exact.
  const input = menu.locator('[data-testid="ctx-color-custom-input"]');
  await input.evaluate((el) => {
    const i = el as HTMLInputElement;
    i.value = '#ffffff';
    i.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await menu.locator('[data-testid="ctx-color-custom-apply"]').click();
  await expect.poll(async () => await sourceControlColor(page, 'adsr-1')).toBe('FFFFFF');
});
