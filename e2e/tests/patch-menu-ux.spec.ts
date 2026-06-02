// e2e/tests/patch-menu-ux.spec.ts
//
// Regression coverage for the patch-panel / port-menu UX streamline
// (PR-204):
//
//   1. Click-and-hold a port for >50ms without moving → Patch-to menu
//      opens. (Press, hold 50ms, release.)
//   2. Click on a port and start dragging within the 50ms window → menu
//      does NOT open; xyflow's drag-to-connect takes over.
//   3. Cursor-angle navigation across the cascade columns must keep the
//      submenu (port-list) clickable. Moving over sibling module rows
//      en route to the port column does NOT re-pivot the submenu.
//   4. The yellow patch-trigger icon: CLICK opens the panel; pure hover
//      does nothing.
//   5. Esc closes the cascade menu.
//   6. Clicking on canvas negative space (with the cascade open) closes
//      the cascade.
//
// These tests are kept self-contained — each spins a fresh patch with
// two modules so a "Patch to..." target always exists. We use sequencer
// + ADSR (the standard pair from aut-patch-panel.spec.ts) so the gate-
// to-gate cable target is unambiguous.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

/** Click the top-left patch-trigger to open the panel. Post-PR-204 the
 *  trigger is click-only (hover does nothing). */
async function openPanel(page: Page, nodeId: string): Promise<void> {
  await page
    .locator(`.svelte-flow__node[data-id="${nodeId}"] [data-testid="patch-trigger"]`)
    .click();
  await expect(
    page.locator(`.svelte-flow__node[data-id="${nodeId}"] [data-testid="patch-panel"]`),
  ).toHaveAttribute('aria-hidden', 'false');
}

/** Locate a handle (port) inside an opened patch panel. */
function panelHandle(page: Page, nodeId: string, portId: string) {
  return page.locator(
    `.svelte-flow__node[data-id="${nodeId}"] [data-testid="patch-panel"] ` +
      `.svelte-flow__handle[data-handleid="${portId}"]`,
  );
}

async function spawnSeqAdsr(page: Page) {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [
    { id: 'seq', type: 'sequencer', position: { x: 80, y: 100 } },
    { id: 'adsr', type: 'adsr', position: { x: 700, y: 100 } },
  ]);
}

test('click-and-hold on a port for >200ms opens the Patch-to menu', async ({ page }) => {
  await spawnSeqAdsr(page);
  await openPanel(page, 'seq');

  const handle = panelHandle(page, 'seq', 'gate');
  await expect(handle).toBeVisible();
  const box = await handle.boundingBox();
  expect(box).toBeTruthy();
  if (!box) return;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  await page.mouse.move(cx, cy);
  await page.mouse.down();
  // Hold without moving. The toBeVisible assertion below polls up to its
  // default 5 s, so we don't need a manual sleep matched to HOLD_FIRE_MS.
  await expect(page.locator('[data-testid="port-context-menu"]')).toBeVisible();
  // Release — menu must stay open.
  await page.mouse.up();
  await expect(page.locator('[data-testid="port-context-menu"]')).toBeVisible();
});

test('click+drag on a port within the hold threshold does NOT open the menu (drag passes to xyflow)', async ({
  page,
}) => {
  await spawnSeqAdsr(page);
  await openPanel(page, 'seq');

  const handle = panelHandle(page, 'seq', 'gate');
  const box = await handle.boundingBox();
  expect(box).toBeTruthy();
  if (!box) return;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  await page.mouse.move(cx, cy);
  await page.mouse.down();
  // The pointerdown arms the hold gesture. Confirm it's armed before we
  // drag, so the move we issue next is guaranteed to act on a live hold
  // (not a gesture that hasn't registered yet).
  await page.waitForFunction(
    () =>
      (globalThis as unknown as { __portHoldPhase?: () => string })
        .__portHoldPhase?.() === 'armed',
  );

  // Drag well past the 4px tolerance. The product cancels the pending
  // hold the moment a pointermove crosses the tolerance, flipping its
  // gesture phase to 'cancelled-move'. We poll for THAT phase rather
  // than racing the wall-clock HOLD_FIRE_MS timer: on a slow CI runner
  // the synthetic pointermove can be delivered to the product's capture
  // listener late, but once it IS delivered the hold is cancelled
  // deterministically — so waiting for 'cancelled-move' proves the drag
  // took over before we assert the menu never opened.
  await page.mouse.move(cx + 60, cy + 40);
  await page.mouse.move(cx + 120, cy + 60);
  await page.waitForFunction(
    () =>
      (globalThis as unknown as { __portHoldPhase?: () => string })
        .__portHoldPhase?.() === 'cancelled-move',
  );

  // Hold was cancelled by the drag → menu must NOT have appeared.
  await expect(page.locator('[data-testid="port-context-menu"]')).toHaveCount(0);
  await page.mouse.up();
  // And it must STAY closed after release (no fast-click fallback fires,
  // because the gesture was already cancelled by movement).
  await expect(page.locator('[data-testid="port-context-menu"]')).toHaveCount(0);
});

test('cascade submenu persists across cursor-angle motion over sibling module rows', async ({
  page,
}) => {
  // After hovering / clicking a module row in the cascade, the port
  // submenu on the right must remain clickable even if the cursor
  // crosses OTHER module rows on the way to the port column. The fix
  // requires explicit click (not hover) to re-pivot once a module is
  // active.
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  // Three modules → cascade has multiple sibling rows to traverse over.
  await spawnPatch(page, [
    { id: 'seq', type: 'sequencer', position: { x: 80, y: 100 } },
    { id: 'adsr', type: 'adsr', position: { x: 600, y: 100 } },
    { id: 'flt', type: 'filter', position: { x: 1000, y: 100 } },
  ]);
  await openPanel(page, 'seq');

  // Right-click the gate port to open the cascade.
  const seqGate = panelHandle(page, 'seq', 'gate');
  await seqGate.click({ button: 'right' });
  const menu = page.locator('[data-testid="port-context-menu"]');
  await expect(menu).toBeVisible();

  // Hover the ADSR module row — first hover seeds the submenu with
  // ADSR's compatible ports.
  const adsrRow = menu.locator('[data-testid="patch-to-module"][data-node-id="adsr"]');
  await adsrRow.hover();
  const portCol = menu.locator('[data-testid="patch-to-ports"]');
  await expect(portCol).toBeVisible();

  // Walk the cursor diagonally toward a port row, passing OVER the
  // filter row en route. The submenu must NOT swap to filter — that
  // was the original cursor-angle bug.
  const filterRow = menu.locator('[data-testid="patch-to-module"][data-node-id="flt"]');
  const filterBox = await filterRow.boundingBox();
  expect(filterBox).toBeTruthy();
  if (!filterBox) return;
  // Move across filter row...
  await page.mouse.move(filterBox.x + filterBox.width / 2, filterBox.y + filterBox.height / 2, {
    steps: 5,
  });

  // ...then over into the port column.
  const adsrGatePort = menu.locator('[data-testid="patch-to-port"][data-port-id="gate"]');
  await expect(adsrGatePort, 'ADSR gate port still listed (submenu not pivoted)').toBeVisible();
  await adsrGatePort.click();

  // Menu closes; the patch commits.
  await expect(menu).toHaveCount(0);
  // Edge from seq.gate → adsr.gate was created.
  await expect(page.locator(`.svelte-flow__edge[data-id*="seq-gate-adsr-gate"]`)).toHaveCount(1);
});

test('clicking the yellow patch-trigger opens the panel; hover alone does not', async ({
  page,
}) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [{ id: 'adsr', type: 'adsr', position: { x: 200, y: 200 } }]);
  const trigger = page.locator(
    '.svelte-flow__node[data-id="adsr"] [data-testid="patch-trigger"]',
  );
  const panel = page.locator(
    '.svelte-flow__node[data-id="adsr"] [data-testid="patch-panel"]',
  );

  // Hover alone — panel must stay closed.
  await trigger.hover();
  await page.waitForTimeout(200);
  await expect(panel, 'hover does NOT open the panel').toHaveAttribute('aria-hidden', 'true');

  // Click — panel opens.
  await trigger.click();
  await expect(panel).toHaveAttribute('aria-hidden', 'false');
});

test('Esc closes the patch-to cascade menu', async ({ page }) => {
  await spawnSeqAdsr(page);
  await openPanel(page, 'seq');
  await panelHandle(page, 'seq', 'gate').click({ button: 'right' });
  const menu = page.locator('[data-testid="port-context-menu"]');
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
});

test('clicking in canvas negative space closes the patch-to cascade', async ({ page }) => {
  await spawnSeqAdsr(page);
  await openPanel(page, 'seq');
  await panelHandle(page, 'seq', 'gate').click({ button: 'right' });
  const menu = page.locator('[data-testid="port-context-menu"]');
  await expect(menu).toBeVisible();
  // Click far from the menu, in canvas negative space.
  await page.mouse.click(10, 10);
  await expect(menu).toHaveCount(0);
});
