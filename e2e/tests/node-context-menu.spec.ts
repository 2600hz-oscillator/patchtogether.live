// e2e/tests/node-context-menu.spec.ts
//
// Right-click on a module card opens a context menu. Actions covered:
//   - Delete: removes node + every edge touching it
//   - Unpatch all: keeps node, removes every edge touching it
//   - Lock / Unlock (virtual-rack Phase 2): "screw down" a module to its rack
//     slot — snap to the 180px grid, persist data.locked, pin non-draggable.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

/** Read a node's persisted position + lock flag from the dev `__patch` global. */
async function readNodeState(
  page: Page,
  id: string,
): Promise<{ x: number; y: number; locked: boolean }> {
  return page.evaluate((nid) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { position: { x: number; y: number }; data?: { locked?: boolean } }> };
    };
    const n = w.__patch.nodes[nid];
    return {
      x: n.position.x,
      y: n.position.y,
      locked: n.data?.rackLocked === true,
    };
  }, id);
}

test('node context menu: right-click opens, Escape closes', async ({ page }) => {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');
  await page.getByTestId('load-example-select').selectOption('sequenced-vco');
  await expect(page.locator('.svelte-flow__node')).toHaveCount(5, { timeout: 10_000 });

  // Right-click on the VCO card BACKGROUND (its title bar). Right-clicking a
  // knob/fader now opens the per-control MIDI menu instead, so we target a
  // non-control region to reach the module menu.
  const vco = page.locator('.svelte-flow__node-analogVco').first();
  await vco.locator('.title').click({ button: 'right' });

  await expect(page.locator('[role="menu"][aria-label="Module actions"]')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.locator('[role="menu"][aria-label="Module actions"]')).toHaveCount(0);
});

test('node context menu: Delete removes the node + all edges touching it', async ({ page }) => {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');
  await page.getByTestId('load-example-select').selectOption('sequenced-vco');
  await expect(page.locator('.svelte-flow__node')).toHaveCount(5, { timeout: 10_000 });
  await expect(page.locator('.svelte-flow__edge')).toHaveCount(6);

  // Right-click on the VCA card. VCA touches 3 edges:
  //   vco.sine → vca.audio
  //   adsr.env → vca.cv
  //   vca.audio → out.L
  //   vca.audio → out.R   (so 4 actually — vd-vca is the hub)
  const vca = page.locator('.svelte-flow__node-vca').first();
  await vca.click({ button: 'right' });

  await page.locator('[role="menuitem"]', { hasText: 'Delete' }).click();

  await expect(page.locator('.svelte-flow__node-vca')).toHaveCount(0);
  await expect(page.locator('.svelte-flow__node')).toHaveCount(4);
  // 6 starting edges − 4 touching VCA = 2 remaining (seq.pitch→vco, seq.gate→adsr)
  await expect(page.locator('.svelte-flow__edge')).toHaveCount(2);
});

test('node context menu: Unpatch all keeps the node, removes only edges touching it', async ({ page }) => {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');
  await page.getByTestId('load-example-select').selectOption('sequenced-vco');
  await expect(page.locator('.svelte-flow__node')).toHaveCount(5, { timeout: 10_000 });
  await expect(page.locator('.svelte-flow__edge')).toHaveCount(6);

  const vca = page.locator('.svelte-flow__node-vca').first();
  await vca.click({ button: 'right' });

  await page.locator('[role="menuitem"]', { hasText: 'Unpatch all' }).click();

  // Node count unchanged
  await expect(page.locator('.svelte-flow__node')).toHaveCount(5);
  await expect(page.locator('.svelte-flow__node-vca')).toHaveCount(1);
  // 6 starting edges − 4 touching VCA = 2 remaining
  await expect(page.locator('.svelte-flow__edge')).toHaveCount(2);
});

test('node context menu: TOYBOX hides "Unpatch all" (node-map module) but keeps Docs/Duplicate/Delete', async ({ page }) => {
  // TOYBOX is a node-map module — its in-card combine editor owns disconnects,
  // so the generic card menu's "Unpatch all" is hidden for type==='toybox'.
  //
  // TOYBOX is itself a WebGL-heavy card (live video layers + combine editor).
  // On CI's SwiftShader software renderer at 1024×768 (#662, 2.56× the pixels
  // of 640×480) its first-paint + menu interaction overruns the default 30s
  // test budget: the menu DOES open + render correctly (the Unpatch-absent /
  // Docs / Duplicate assertions pass), but the slow heavy page burns the clock
  // before the final assertion settles. Give the heavy card headroom.
  test.setTimeout(90_000);
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');
  await spawnPatch(
    page,
    [{ id: 'tb', type: 'toybox', position: { x: 80, y: 40 }, domain: 'video' }],
    [],
  );
  const card = page.locator('.svelte-flow__node-toybox').first();
  await card.waitFor({ state: 'visible', timeout: 10_000 });

  // Right-click the card title (a non-control region) to open the module menu.
  await card.locator('.title').click({ button: 'right' });
  const menu = page.locator('[role="menu"][aria-label="Module actions"]');
  await expect(menu).toBeVisible();

  // Unpatch all is ABSENT; Docs / Duplicate / Delete are present.
  await expect(menu.locator('[role="menuitem"]', { hasText: 'Unpatch all' })).toHaveCount(0);
  await expect(menu.locator('[role="menuitem"]', { hasText: 'Docs' })).toHaveCount(1);
  await expect(menu.locator('[role="menuitem"]', { hasText: 'Duplicate' })).toHaveCount(1);
  await expect(menu.locator('[role="menuitem"]', { hasText: 'Delete' })).toHaveCount(1);
});

test('node context menu: Lock snaps to the HP×U rack grid, marks locked + non-draggable; Unlock reverts', async ({ page }) => {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');
  // Spawn a single module at a DELIBERATELY off-grid position so the snap is
  // observable. The rack grid is ANISOTROPIC (PR #806): X snaps to the 22.5px
  // HP column (1u = 8hp → 180/8), Y snaps to the 180px U row. So 250→247.5 (11hp),
  // 430→360 (2u).
  await spawnPatch(
    page,
    [{ id: 'lck', type: 'vca', position: { x: 250, y: 430 } }],
    [],
  );
  const card = page.locator('.svelte-flow__node[data-id="lck"]');
  await card.waitFor({ state: 'visible', timeout: 10_000 });

  // Sanity: starts free-floating (SvelteFlow tags draggable nodes with the
  // `.draggable` class) and unlocked, at its off-grid spawn point.
  await expect(card).toHaveClass(/\bdraggable\b/);
  let st = await readNodeState(page, 'lck');
  expect(st.locked).toBe(false);
  expect(st.x).toBe(250);
  expect(st.y).toBe(430);

  // Right-click the card title (a non-control region) → menu → Lock.
  await card.locator('.title').click({ button: 'right' });
  const menu = page.locator('[role="menu"][aria-label="Module actions"]');
  await expect(menu).toBeVisible();
  const lockItem = menu.getByTestId('ctx-lock');
  // Gate on the item itself rendering (the menu can be visible a frame before
  // its items populate) before asserting its label, then click.
  await expect(lockItem).toBeVisible({ timeout: 10_000 });
  await expect(lockItem).toHaveText('Lock', { timeout: 10_000 });
  await lockItem.click();

  // (a) position snapped anisotropically: X to the nearest 22.5px HP column,
  // Y to the nearest 180px U row.
  await expect
    .poll(async () => (await readNodeState(page, 'lck')).x)
    .toBe(247.5);
  st = await readNodeState(page, 'lck');
  expect(st.x).toBe(247.5); // 250 → 247.5 (11hp × 22.5)
  expect(st.y).toBe(360); // 430 → 360 (2u × 180)
  expect(st.x % 22.5).toBe(0); // on an HP column
  expect(st.y % 180).toBe(0); // on a U row
  // (b) data.locked persisted true.
  expect(st.locked).toBe(true);
  // (c) the node is now non-draggable — SvelteFlow drops the `.draggable`
  // class + our derivation adds `node-locked`.
  await expect(card).not.toHaveClass(/\bdraggable\b/);
  await expect(card).toHaveClass(/\bnode-locked\b/);

  // Re-open the menu: the entry now reads "Unlock".
  await card.locator('.title').click({ button: 'right' });
  await expect(menu).toBeVisible();
  const unlockItem = menu.getByTestId('ctx-lock');
  await expect(unlockItem).toHaveText('Unlock');
  await unlockItem.click();

  // Unlock clears the flag + restores draggability (position stays snapped).
  await expect(card).toHaveClass(/\bdraggable\b/);
  await expect(card).not.toHaveClass(/\bnode-locked\b/);
  st = await readNodeState(page, 'lck');
  expect(st.locked).toBe(false);
  expect(st.x).toBe(247.5); // left where it snapped
  expect(st.y).toBe(360);
});
