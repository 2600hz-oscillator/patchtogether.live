// e2e/tests/right-click-patch-to.spec.ts
//
// Right-click "Patch to..." cascading flow on every port:
//   port → "Patch to..." → module → compatible port → edge created.
//
// The flow lets users build cables click-by-click instead of click-and-drag.
// PatchPanel-mounted handles need the panel opened first (default UX); cards
// that render handles directly (e.g. LINES) get right-click immediately.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

interface PatchEdge {
  id: string;
  source: { nodeId: string; portId: string };
  target: { nodeId: string; portId: string };
  sourceType: string;
  targetType: string;
}

async function readEdges(page: Page): Promise<PatchEdge[]> {
  return await page.evaluate(() => {
    const w = window as unknown as { __patch: { edges: Record<string, PatchEdge> } };
    return Object.values(w.__patch.edges).filter(Boolean) as PatchEdge[];
  });
}

async function openPanel(page: Page, nodeId: string): Promise<void> {
  const trigger = page.locator(
    `.svelte-flow__node[data-id="${nodeId}"] [data-testid="patch-trigger"]`,
  );
  // Click pins the panel open (PatchPanel toggles `pinned` on trigger
  // click) so subsequent hovers/clicks elsewhere on the page don't close
  // it. Hover alone closes 200ms after the cursor leaves the trigger.
  await trigger.click();
  const panel = page.locator(
    `.svelte-flow__node[data-id="${nodeId}"] [data-testid="patch-panel"]`,
  );
  await expect(panel).toHaveAttribute('aria-hidden', 'false');
}

/** Right-click a handle inside an OPEN PatchPanel.
 *
 *  PatchPanel's hover-intent state machine closes the panel 200ms after
 *  the cursor leaves the trigger or the panel itself. Moving from the
 *  trigger directly to a handle takes the cursor over the panel's body
 *  along the way, which keeps the panel open via .panel onmouseenter.
 *  We hover the handle explicitly to trigger that, then issue the
 *  right-click. */
async function rightClickPanelHandle(
  page: Page,
  nodeId: string,
  portId: string,
): Promise<void> {
  await openPanel(page, nodeId);
  const handle = page.locator(
    `.svelte-flow__node[data-id="${nodeId}"] [data-testid="patch-panel"] .svelte-flow__handle[data-handleid="${portId}"]`,
  );
  await expect(handle).toBeVisible();
  // Hover the handle — keeps the panel's hover-driver alive while we
  // dispatch the contextmenu. Without this the cursor's motion from the
  // trigger to the handle still keeps the panel open via the panel's
  // own onmouseenter, but Playwright's click() would synthesize a fresh
  // pointer at the target — by then the panel may have closed.
  await handle.hover();
  await handle.click({ button: 'right' });
  await expect(page.locator('[data-testid="port-context-menu"]')).toBeVisible();
}

test.describe.configure({ mode: 'parallel' });

test('happy path: LFO.phase0 → FILTER.cutoff via right-click cascade', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(
    page,
    [
      { id: 'lfo1', type: 'lfo', position: { x: 100, y: 200 } },
      { id: 'flt1', type: 'filter', position: { x: 500, y: 200 } },
    ],
    [],
  );

  await rightClickPanelHandle(page, 'lfo1', 'phase0');

  // Module submenu is rendered; click FILTER1.
  const filterEntry = page.locator('[data-testid="patch-to-module"][data-node-id="flt1"]');
  await expect(filterEntry).toBeVisible();
  await filterEntry.click();

  // Candidate ports (FILTER's INPUTs accepting cv): cutoff + res.
  const ports = page.locator('[data-testid="patch-to-port"]');
  const portIds = await ports.evaluateAll((els) =>
    els.map((el) => (el as HTMLElement).getAttribute('data-port-id') ?? ''),
  );
  expect(portIds).toEqual(['cutoff', 'res']);

  await page.locator('[data-testid="patch-to-port"][data-port-id="cutoff"]').click();
  await expect(page.locator('[data-testid="port-context-menu"]')).toHaveCount(0);

  const edges = await readEdges(page);
  expect(edges.length).toBe(1);
  expect(edges[0]!.source).toEqual({ nodeId: 'lfo1', portId: 'phase0' });
  expect(edges[0]!.target).toEqual({ nodeId: 'flt1', portId: 'cutoff' });
});

test('type filtering: cv → audio shows "No compatible ports"', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(
    page,
    [
      { id: 'lfo1', type: 'lfo', position: { x: 100, y: 200 } },
      { id: 'ao1', type: 'audioOut', position: { x: 500, y: 200 } },
    ],
    [],
  );

  await rightClickPanelHandle(page, 'lfo1', 'phase0');
  await page.locator('[data-testid="patch-to-module"][data-node-id="ao1"]').click();

  await expect(page.locator('[data-testid="no-compatible-ports"]')).toBeVisible();
  // Closing keeps the patch graph empty.
  await page.keyboard.press('Escape');
  const edges = await readEdges(page);
  expect(edges.length).toBe(0);
});

test('destructive overwrite: cutoff already patched → "!" prefix + replaces edge on click', async ({
  page,
}) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(
    page,
    [
      { id: 'lfo1', type: 'lfo', position: { x: 100, y: 100 } },
      { id: 'lfo2', type: 'lfo', position: { x: 100, y: 400 } },
      { id: 'flt1', type: 'filter', position: { x: 600, y: 200 } },
    ],
    [
      {
        id: 'e-pre',
        from: { nodeId: 'lfo1', portId: 'phase0' },
        to: { nodeId: 'flt1', portId: 'cutoff' },
        sourceType: 'cv',
        targetType: 'cv',
      },
    ],
  );

  // Right-click LFO2.phase0 → Patch to FILTER #2 (LFO1 already exists, so
  // the FILTER is index #1 but there's only one filter — its display name
  // stays "Filter"). The two LFOs both exist so the FILTER's "FILTER"
  // entry remains unsuffixed; LFO entries become "LFO #1 / #2" in the
  // submenu of LFO2's right-click... but we're picking FILTER from LFO2's
  // menu, so the submenu just shows LFO1 + FILTER (we excluded LFO2).
  await rightClickPanelHandle(page, 'lfo2', 'phase0');
  await page.locator('[data-testid="patch-to-module"][data-node-id="flt1"]').click();

  const cutoff = page.locator('[data-testid="patch-to-port"][data-port-id="cutoff"]');
  await expect(cutoff).toBeVisible();
  await expect(cutoff).toHaveAttribute('data-occupied', 'true');
  // Tooltip mentions LFO #1 (since both LFOs exist, indexed) + the source port.
  const title = await cutoff.getAttribute('title');
  expect(title).toContain('LFO #1');

  // Visible "!" glyph.
  await expect(cutoff.locator('.warn-glyph')).toHaveText('!');

  await cutoff.click();

  const edges = await readEdges(page);
  expect(edges.length).toBe(1);
  expect(edges[0]!.source).toEqual({ nodeId: 'lfo2', portId: 'phase0' });
  expect(edges[0]!.target).toEqual({ nodeId: 'flt1', portId: 'cutoff' });
});

test('disabled when no other modules exist', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [{ id: 'lfo1', type: 'lfo', position: { x: 200, y: 200 } }], []);

  await rightClickPanelHandle(page, 'lfo1', 'phase0');

  const disabled = page.locator('[data-testid="patch-to-disabled"]');
  await expect(disabled).toBeVisible();
  await expect(disabled).toHaveAttribute('aria-disabled', 'true');
  await expect(disabled).toHaveAttribute('title', /no other modules/i);
});

test('compatible direction: right-click an INPUT lists OUTPUTs of the chosen target', async ({
  page,
}) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(
    page,
    [
      { id: 'lfo1', type: 'lfo', position: { x: 100, y: 200 } },
      { id: 'flt1', type: 'filter', position: { x: 500, y: 200 } },
    ],
    [],
  );

  // Right-click FILTER's cutoff (INPUT). The candidates after picking LFO
  // should be OUTPUTs of LFO (phase0/90/180/270), NOT its inputs.
  await rightClickPanelHandle(page, 'flt1', 'cutoff');
  await page.locator('[data-testid="patch-to-module"][data-node-id="lfo1"]').click();

  const ports = page.locator('[data-testid="patch-to-port"]');
  const portIds = await ports.evaluateAll((els) =>
    els.map((el) => (el as HTMLElement).getAttribute('data-port-id') ?? ''),
  );
  expect(portIds).toEqual(['phase0', 'phase90', 'phase180', 'phase270']);
  // Sanity: none of LFO's inputs (clock / rate / shape) appear here.
  expect(portIds).not.toContain('clock');
  expect(portIds).not.toContain('rate');
  expect(portIds).not.toContain('shape');

  await page.locator('[data-testid="patch-to-port"][data-port-id="phase90"]').click();
  const edges = await readEdges(page);
  expect(edges.length).toBe(1);
  expect(edges[0]!.source).toEqual({ nodeId: 'lfo1', portId: 'phase90' });
  expect(edges[0]!.target).toEqual({ nodeId: 'flt1', portId: 'cutoff' });
});

// ---------------------------------------------------------------------------
// Persistence contract: once opened, the menu stays visible through ALL
// pointer movements. Closes only on Escape, on picking a target port, or
// when the user right-clicks a different port (a fresh menu replaces it).
// ---------------------------------------------------------------------------

test('persists through pointer movement across the viewport', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(
    page,
    [
      { id: 'lfo1', type: 'lfo', position: { x: 100, y: 200 } },
      { id: 'flt1', type: 'filter', position: { x: 500, y: 200 } },
    ],
    [],
  );

  await rightClickPanelHandle(page, 'lfo1', 'phase0');
  const menu = page.locator('[data-testid="port-context-menu"]');
  await expect(menu).toBeVisible();

  // Walk the cursor around the viewport: across modules, off-canvas,
  // back onto canvas. Without the persistence fix, the click-outside
  // overlay (or eager pointerleave) would dismiss the menu mid-trip.
  await page.mouse.move(50, 50, { steps: 10 });
  await expect(menu, 'menu still visible after moving to top-left').toBeVisible();

  await page.mouse.move(700, 500, { steps: 10 });
  await expect(menu, 'menu still visible after moving to bottom-right').toBeVisible();

  await page.mouse.move(10, 10, { steps: 10 });
  await expect(menu, 'menu still visible after moving off-canvas').toBeVisible();

  await page.mouse.move(400, 300, { steps: 10 });
  await expect(menu, 'menu still visible after returning').toBeVisible();
});

test('both panels stay open while hovering through modules', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(
    page,
    [
      { id: 'lfo1', type: 'lfo', position: { x: 100, y: 100 } },
      { id: 'flt1', type: 'filter', position: { x: 500, y: 100 } },
      { id: 'vca1', type: 'vca', position: { x: 100, y: 400 } },
    ],
    [],
  );

  await rightClickPanelHandle(page, 'lfo1', 'phase0');
  const menu = page.locator('[data-testid="port-context-menu"]');
  await expect(menu).toBeVisible();

  // Hover module A (filter) → ports panel for filter shows up.
  const filterEntry = page.locator('[data-testid="patch-to-module"][data-node-id="flt1"]');
  await filterEntry.hover();
  const portsPanel = page.locator('[data-testid="patch-to-ports"]');
  await expect(portsPanel).toBeVisible();
  let portIds = await portsPanel.locator('[data-testid="patch-to-port"]').evaluateAll((els) =>
    els.map((el) => (el as HTMLElement).getAttribute('data-port-id') ?? ''),
  );
  expect(portIds).toEqual(['cutoff', 'res']);

  // Hover module B (vca) → ports panel content swaps.
  const vcaEntry = page.locator('[data-testid="patch-to-module"][data-node-id="vca1"]');
  await vcaEntry.hover();
  await expect(menu, 'modules panel still open').toBeVisible();
  await expect(portsPanel, 'ports panel still open after switching modules').toBeVisible();
  portIds = await portsPanel.locator('[data-testid="patch-to-port"]').evaluateAll((els) =>
    els.map((el) => (el as HTMLElement).getAttribute('data-port-id') ?? ''),
  );
  expect(portIds, 'ports panel content reflects new active module').toContain('cv');

  // Hover back to A — both panels still visible, content updates again.
  await filterEntry.hover();
  await expect(menu).toBeVisible();
  await expect(portsPanel).toBeVisible();
  portIds = await portsPanel.locator('[data-testid="patch-to-port"]').evaluateAll((els) =>
    els.map((el) => (el as HTMLElement).getAttribute('data-port-id') ?? ''),
  );
  expect(portIds).toEqual(['cutoff', 'res']);
});

test('closes on Escape after pointer movement', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(
    page,
    [
      { id: 'lfo1', type: 'lfo', position: { x: 100, y: 200 } },
      { id: 'flt1', type: 'filter', position: { x: 500, y: 200 } },
    ],
    [],
  );

  await rightClickPanelHandle(page, 'lfo1', 'phase0');
  const menu = page.locator('[data-testid="port-context-menu"]');
  await expect(menu).toBeVisible();

  // Open the ports panel by hovering a module.
  await page.locator('[data-testid="patch-to-module"][data-node-id="flt1"]').hover();
  const portsPanel = page.locator('[data-testid="patch-to-ports"]');
  await expect(portsPanel).toBeVisible();

  // Walk the pointer around to prove the menu is sticky.
  await page.mouse.move(50, 50, { steps: 10 });
  await page.mouse.move(700, 500, { steps: 10 });
  await expect(menu, 'menu still open after walk').toBeVisible();
  await expect(portsPanel, 'ports panel still open after walk').toBeVisible();

  // Escape closes both panels.
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(portsPanel).toHaveCount(0);
});

test('closes on commit (port click) after pointer movement', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(
    page,
    [
      { id: 'lfo1', type: 'lfo', position: { x: 100, y: 200 } },
      { id: 'flt1', type: 'filter', position: { x: 500, y: 200 } },
    ],
    [],
  );

  await rightClickPanelHandle(page, 'lfo1', 'phase0');
  const menu = page.locator('[data-testid="port-context-menu"]');

  await page.locator('[data-testid="patch-to-module"][data-node-id="flt1"]').hover();
  const portsPanel = page.locator('[data-testid="patch-to-ports"]');
  await expect(portsPanel).toBeVisible();

  // Pointer wandering proves the menu persists right up to commit.
  await page.mouse.move(50, 50, { steps: 10 });
  await page.mouse.move(700, 500, { steps: 10 });
  await expect(menu).toBeVisible();
  await expect(portsPanel).toBeVisible();

  // Commit by clicking a port.
  await page.locator('[data-testid="patch-to-port"][data-port-id="cutoff"]').click();
  await expect(menu).toHaveCount(0);
  await expect(portsPanel).toHaveCount(0);

  const edges = await readEdges(page);
  expect(edges.length).toBe(1);
  expect(edges[0]!.source).toEqual({ nodeId: 'lfo1', portId: 'phase0' });
  expect(edges[0]!.target).toEqual({ nodeId: 'flt1', portId: 'cutoff' });
});
