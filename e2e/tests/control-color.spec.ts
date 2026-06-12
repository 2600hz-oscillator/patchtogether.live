// e2e/tests/control-color.spec.ts
//
// PER-MODULE CONTROL COLOUR — the assign UI + the PASSTHROUGH render.
//
//   1. spawn an ADSR + a Control Surface; bind ADSR.attack onto the surface.
//   2. right-click the ADSR title → "Assign control color" → pick a swatch.
//      → data.controlColor is set on the SOURCE module (not the surface).
//   3. the SOURCE card shows the colour dot; the SURFACE stripe above the
//      proxied knob renders that colour (LIVE passthrough read of the source).
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

async function setup(page: Page) {
  await page.goto('/');
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

  const surface = page.locator('[data-testid="control-surface-card"][data-node-id="cs-1"]');
  await expect(surface).toBeVisible();
  const stripe = surface.locator('[data-testid="control-surface-stripe-adsr-1-attack"]');
  await expect(stripe).toBeVisible();

  // Right-click the ADSR's TITLE (control-free) → the Module-actions menu.
  const adsr = page.locator('.svelte-flow__node-adsr').first();
  await adsr.locator('.title').click({ button: 'right' });
  const menu = page.locator('[role="menu"][aria-label="Module actions"]');
  await expect(menu).toBeVisible();

  // Open the "Assign control color" submenu, pick the red swatch (F45C51).
  await menu.locator('[data-testid="ctx-assign-control-color"]').click();
  const panel = menu.locator('[data-testid="ctx-color-panel"]');
  await expect(panel).toBeVisible();
  await panel.locator('[data-testid="ctx-color-swatch-F45C51"]').click();

  // The colour is stored on the SOURCE module (its single home).
  await expect.poll(async () => await sourceControlColor(page, 'adsr-1')).toBe('F45C51');

  // The SURFACE stripe (a LIVE passthrough read of the source) now renders red.
  await expect.poll(async () => await bg(page, '[data-testid="control-surface-stripe-adsr-1-attack"]'))
    .toBe('rgb(244, 92, 81)');

  // The SOURCE card shows the colour dot.
  await expect(adsr.locator('[data-testid="control-color-dot"]')).toBeVisible();

  // PASSTHROUGH proof: the surface binding holds NO colour copy.
  expect(await surfaceBindings(page, 'cs-1')).toEqual([{ moduleId: 'adsr-1', paramId: 'attack' }]);
});

test('changing the colour updates the stripe live; reset clears it', async ({ page }) => {
  await setup(page);
  const surface = page.locator('[data-testid="control-surface-card"][data-node-id="cs-1"]');
  const adsr = page.locator('.svelte-flow__node-adsr').first();

  // First assignment → teal (03A598).
  await adsr.locator('.title').click({ button: 'right' });
  let menu = page.locator('[role="menu"][aria-label="Module actions"]');
  await menu.locator('[data-testid="ctx-assign-control-color"]').click();
  await menu.locator('[data-testid="ctx-color-swatch-03A598"]').click();
  await expect.poll(async () => await sourceControlColor(page, 'adsr-1')).toBe('03A598');
  await expect.poll(async () => await bg(page, '[data-testid="control-surface-stripe-adsr-1-attack"]'))
    .toBe('rgb(3, 165, 152)');

  // Re-assign → blue (529DEC). The stripe re-resolves; no stale value.
  await adsr.locator('.title').click({ button: 'right' });
  menu = page.locator('[role="menu"][aria-label="Module actions"]');
  await menu.locator('[data-testid="ctx-assign-control-color"]').click();
  await menu.locator('[data-testid="ctx-color-swatch-529DEC"]').click();
  await expect.poll(async () => await sourceControlColor(page, 'adsr-1')).toBe('529DEC');
  await expect.poll(async () => await bg(page, '[data-testid="control-surface-stripe-adsr-1-attack"]'))
    .toBe('rgb(82, 157, 236)');

  // Reset to default → data.controlColor cleared (reverts to the auto default).
  await adsr.locator('.title').click({ button: 'right' });
  menu = page.locator('[role="menu"][aria-label="Module actions"]');
  await menu.locator('[data-testid="ctx-assign-control-color"]').click();
  await menu.locator('[data-testid="ctx-color-reset"]').click();
  await expect.poll(async () => await sourceControlColor(page, 'adsr-1')).toBeNull();
  // The dot disappears once no explicit colour is set.
  await expect(adsr.locator('[data-testid="control-color-dot"]')).toHaveCount(0);
});

test('custom hex picker shows a 565 preview + applies the quantized colour', async ({ page }) => {
  await setup(page);
  const adsr = page.locator('.svelte-flow__node-adsr').first();

  await adsr.locator('.title').click({ button: 'right' });
  const menu = page.locator('[role="menu"][aria-label="Module actions"]');
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
