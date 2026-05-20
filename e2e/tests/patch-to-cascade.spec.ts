// e2e/tests/patch-to-cascade.spec.ts
//
// "Patch to..." cascading flow on every port. Two gestures route to the
// same cascade:
//   * right-click on a port handle  (PR-104, power-user shortcut)
//   * double-click on a port handle (more discoverable)
// Both lead to: port → "Patch to..." → module → compatible port → edge.
//
// PatchPanel-mounted handles need the panel opened first (default UX);
// cards that render handles directly (e.g. LINES) get the gesture
// immediately. While a cascade is active, the source port's PatchPanel
// stays open underneath the cascade until commit / Esc / new cascade.

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

  // Hover module A (filter) — first hover seeds the submenu (cursor-
  // angle guard in PortContextMenu activates the first hover; subsequent
  // hovers do nothing). Ports panel shows filter's compatible inputs.
  const filterEntry = page.locator('[data-testid="patch-to-module"][data-node-id="flt1"]');
  await filterEntry.hover();
  const portsPanel = page.locator('[data-testid="patch-to-ports"]');
  await expect(portsPanel).toBeVisible();
  let portIds = await portsPanel.locator('[data-testid="patch-to-port"]').evaluateAll((els) =>
    els.map((el) => (el as HTMLElement).getAttribute('data-port-id') ?? ''),
  );
  expect(portIds).toEqual(['cutoff', 'res']);

  // Click module B (vca) — explicit click required to re-pivot the
  // submenu post PortContextMenu cursor-angle hardening (hover-only
  // pivots corrupted the submenu when the user crossed sibling rows
  // diagonally on the way to a port).
  const vcaEntry = page.locator('[data-testid="patch-to-module"][data-node-id="vca1"]');
  await vcaEntry.click();
  await expect(menu, 'modules panel still open').toBeVisible();
  await expect(portsPanel, 'ports panel still open after switching modules').toBeVisible();
  portIds = await portsPanel.locator('[data-testid="patch-to-port"]').evaluateAll((els) =>
    els.map((el) => (el as HTMLElement).getAttribute('data-port-id') ?? ''),
  );
  expect(portIds, 'ports panel content reflects new active module').toContain('cv');

  // Click back to A — content updates again.
  await filterEntry.click();
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

// ---------------------------------------------------------------------------
// Double-click trigger contract (added for discoverability).
// Right-click stays as a power-user shortcut; both gestures end at the
// same cascade. The source port's PatchPanel stays open underneath while
// the cascade is up.
// ---------------------------------------------------------------------------

/** Double-click a handle inside an OPEN PatchPanel. Mirrors
 *  rightClickPanelHandle but uses dblclick instead of right-click. */
async function dblClickPanelHandle(
  page: Page,
  nodeId: string,
  portId: string,
): Promise<void> {
  await openPanel(page, nodeId);
  const handle = page.locator(
    `.svelte-flow__node[data-id="${nodeId}"] [data-testid="patch-panel"] .svelte-flow__handle[data-handleid="${portId}"]`,
  );
  await expect(handle).toBeVisible();
  await handle.hover();
  await handle.dblclick();
  await expect(page.locator('[data-testid="port-context-menu"]')).toBeVisible();
}

test('double-click opens cascade', async ({ page }) => {
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

  await dblClickPanelHandle(page, 'lfo1', 'phase0');
  const menu = page.locator('[data-testid="port-context-menu"]');
  await expect(menu).toBeVisible();

  // Sanity: cascade behaves the same as right-click — modules submenu
  // lists FILTER, picking it lists FILTER's compatible inputs.
  await page.locator('[data-testid="patch-to-module"][data-node-id="flt1"]').click();
  const ports = page.locator('[data-testid="patch-to-port"]');
  const portIds = await ports.evaluateAll((els) =>
    els.map((el) => (el as HTMLElement).getAttribute('data-port-id') ?? ''),
  );
  expect(portIds).toEqual(['cutoff', 'res']);
});

test('PatchPanel stays open underneath cascade (double-click trigger)', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(
    page,
    [
      { id: 'lfo1', type: 'lfo', position: { x: 100, y: 200 } },
      { id: 'flt1', type: 'filter', position: { x: 600, y: 200 } },
    ],
    [],
  );

  await dblClickPanelHandle(page, 'lfo1', 'phase0');
  const menu = page.locator('[data-testid="port-context-menu"]');
  const lfoPanel = page.locator(
    '.svelte-flow__node[data-id="lfo1"] [data-testid="patch-panel"]',
  );
  await expect(menu).toBeVisible();
  await expect(lfoPanel).toHaveAttribute('aria-hidden', 'false');

  // Wander the pointer around — over other modules, off-canvas, back.
  // Both the cascade AND the source PatchPanel must remain visible.
  await page.mouse.move(800, 300, { steps: 10 });
  await expect(menu, 'cascade still visible after pointer over other module').toBeVisible();
  await expect(
    lfoPanel,
    'source PatchPanel still open after pointer over other module',
  ).toHaveAttribute('aria-hidden', 'false');

  await page.mouse.move(10, 10, { steps: 10 });
  await expect(menu, 'cascade still visible off-canvas').toBeVisible();
  await expect(lfoPanel, 'source PatchPanel still open off-canvas').toHaveAttribute(
    'aria-hidden',
    'false',
  );

  await page.mouse.move(400, 400, { steps: 10 });
  await expect(menu).toBeVisible();
  await expect(lfoPanel).toHaveAttribute('aria-hidden', 'false');

  // Esc closes the cascade — the source PatchPanel is then free to
  // close per its normal hover-intent rules (no longer locked).
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
});

test('right-click still opens cascade (PR-104 regression)', async ({ page }) => {
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

  // Source PatchPanel is also locked open under the cascade for
  // right-click (parity with double-click).
  const lfoPanel = page.locator(
    '.svelte-flow__node[data-id="lfo1"] [data-testid="patch-panel"]',
  );
  await expect(lfoPanel).toHaveAttribute('aria-hidden', 'false');
  await page.mouse.move(800, 300, { steps: 10 });
  await expect(lfoPanel).toHaveAttribute('aria-hidden', 'false');
});

test('single-click on a handle opens the cascade (PR-204: fast click is a synonym for click-and-hold)', async ({ page }) => {
  // Post PR-204, a fast click on a port handle (release before the 50 ms
  // hold threshold) is treated as an alias for the click-and-hold gesture
  // — the menu opens the same way it does on right-click / double-click.
  // This guards the contract that new users hitting fast taps still get
  // the patch-to cascade.
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

  await openPanel(page, 'lfo1');
  const handle = page.locator(
    '.svelte-flow__node[data-id="lfo1"] [data-testid="patch-panel"] .svelte-flow__handle[data-handleid="phase0"]',
  );
  await expect(handle).toBeVisible();
  await handle.click();

  await expect(page.locator('[data-testid="port-context-menu"]')).toBeVisible();
});

test('double-click disabled state: lone module shows "no other modules"', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [{ id: 'lfo1', type: 'lfo', position: { x: 200, y: 200 } }], []);

  await dblClickPanelHandle(page, 'lfo1', 'phase0');

  const disabled = page.locator('[data-testid="patch-to-disabled"]');
  await expect(disabled).toBeVisible();
  await expect(disabled).toHaveAttribute('aria-disabled', 'true');
  await expect(disabled).toHaveAttribute('title', /no other modules/i);
});

// ---------------------------------------------------------------------------
// Real-gesture coverage: drives the dblclick via page.mouse.dblclick(x, y)
// at the handle's bounding-box center, NOT via Playwright's locator.dblclick
// wrapper. Catches the failure mode where the handle is technically in the
// DOM but the synthetic gesture only succeeds when Playwright targets the
// element by selector (DOM-bypass tell). If this test passes, a real user
// holding a real mouse over the handle dot can open the cascade.
// ---------------------------------------------------------------------------

test('real-gesture: page.mouse.dblclick at handle center opens cascade', async ({ page }) => {
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

  await openPanel(page, 'lfo1');
  const handle = page.locator(
    '.svelte-flow__node[data-id="lfo1"] [data-testid="patch-panel"] .svelte-flow__handle[data-handleid="phase0"]',
  );
  await expect(handle).toBeVisible();
  await handle.hover();
  const box = await handle.boundingBox();
  expect(box, 'handle has bounding box').not.toBeNull();
  const cx = box!.x + box!.width / 2;
  const cy = box!.y + box!.height / 2;
  await page.mouse.dblclick(cx, cy);

  await expect(page.locator('[data-testid="port-context-menu"]')).toBeVisible();
  // Source label confirms the dblclick was recognised as LFO.phase0, not
  // some accidental click on a panel row or label.
  await expect(page.locator('[data-testid="port-context-menu"] .ctx-header')).toHaveText(
    'LFO.phase0',
  );
});

test('real-gesture: dblclick on direct-render handle (LINES card)', async ({ page }) => {
  // LINES renders <Handle> children directly on the card (no PatchPanel
  // popover). The dblclick path must work on these too — covering the
  // video-domain card pattern.
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(
    page,
    [
      { id: 'lines1', type: 'lines', position: { x: 100, y: 200 }, domain: 'video' },
      { id: 'vout1', type: 'videoOut', position: { x: 600, y: 200 }, domain: 'video' },
    ],
    [],
  );

  const out = page.locator(
    '.svelte-flow__node[data-id="lines1"] .svelte-flow__handle[data-handleid="out"]',
  );
  await expect(out).toBeVisible();
  await out.hover();
  const box = await out.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.dblclick(box!.x + box!.width / 2, box!.y + box!.height / 2);

  await expect(page.locator('[data-testid="port-context-menu"]')).toBeVisible();
  await expect(page.locator('[data-testid="port-context-menu"] .ctx-header')).toHaveText(
    'LINES.out',
  );
});

// ---------------------------------------------------------------------------
// Corner-trigger dblclick: dblclick on either PatchPanel trigger affordance
// opens the cascade sourced from the module's FIRST declared output. Lets
// users skip the open-panel-then-find-the-handle dance for the common
// "I want to patch this module's main output somewhere" workflow.
// ---------------------------------------------------------------------------

test('corner-trigger dblclick: opens cascade sourced from first declared output', async ({
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

  const trigger = page.locator(
    '.svelte-flow__node[data-id="lfo1"] [data-testid="patch-trigger"]',
  );
  await expect(trigger).toBeVisible();
  await trigger.dblclick();

  const menu = page.locator('[data-testid="port-context-menu"]');
  await expect(menu).toBeVisible();
  // LFO's first output is phase0 — confirms we selected the first declared
  // entry from the def's outputs array, not some other rule.
  await expect(menu.locator('.ctx-header')).toHaveText('LFO.phase0');

  // Cascade behaves identically to the handle dblclick path from here on:
  // pick FILTER, get its cv-accepting inputs.
  await page.locator('[data-testid="patch-to-module"][data-node-id="flt1"]').click();
  const portIds = await page
    .locator('[data-testid="patch-to-port"]')
    .evaluateAll((els) => els.map((el) => (el as HTMLElement).getAttribute('data-port-id') ?? ''));
  expect(portIds).toEqual(['cutoff', 'res']);
});

test('corner-trigger dblclick: right-side trigger also opens cascade', async ({ page }) => {
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

  const trigger = page.locator(
    '.svelte-flow__node[data-id="lfo1"] [data-testid="patch-trigger-right"]',
  );
  await expect(trigger).toBeVisible();
  await trigger.dblclick();

  await expect(page.locator('[data-testid="port-context-menu"]')).toBeVisible();
  await expect(page.locator('[data-testid="port-context-menu"] .ctx-header')).toHaveText(
    'LFO.phase0',
  );
});

test('corner-trigger dblclick: zero-output module (AudioOut) is a no-op', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(
    page,
    [
      { id: 'ao1', type: 'audioOut', position: { x: 100, y: 200 } },
      { id: 'lfo1', type: 'lfo', position: { x: 500, y: 200 } },
    ],
    [],
  );

  const trigger = page.locator(
    '.svelte-flow__node[data-id="ao1"] [data-testid="patch-trigger"]',
  );
  await expect(trigger).toBeVisible();
  await trigger.dblclick();

  // No outputs → no cascade. Trigger's single-click behavior (toggle panel)
  // is unaffected — we're asserting the dblclick path specifically declines
  // to open an empty cascade, not breaking the click pipeline.
  await expect(page.locator('[data-testid="port-context-menu"]')).toHaveCount(0);
});

test('corner-trigger single-click still toggles the panel (no regression)', async ({ page }) => {
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

  const trigger = page.locator(
    '.svelte-flow__node[data-id="lfo1"] [data-testid="patch-trigger"]',
  );
  const panel = page.locator(
    '.svelte-flow__node[data-id="lfo1"] [data-testid="patch-panel"]',
  );
  await trigger.click();
  await expect(panel).toHaveAttribute('aria-hidden', 'false');
  // No cascade fires on a single click.
  await expect(page.locator('[data-testid="port-context-menu"]')).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// Regression: ADSR.env → Analog VCO previously showed "No compatible ports"
// because AnalogVCO's tune/fine/fm/pm knobs had no CV input ports. After
// feat/vco-cv-inputs, right-clicking ADSR.env and navigating to Analog VCO
// must list tune/fine/fmAmount/pmAmount as compatible destinations.
// ---------------------------------------------------------------------------

test('ADSR.env → Analog VCO shows tune/fine/fmAmount/pmAmount as compatible CV destinations', async ({
  page,
}) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(
    page,
    [
      { id: 'adsr1', type: 'adsr',      position: { x: 100, y: 200 } },
      { id: 'vco1',  type: 'analogVco', position: { x: 500, y: 200 } },
    ],
    [],
  );

  await rightClickPanelHandle(page, 'adsr1', 'env');
  await page.locator('[data-testid="patch-to-module"][data-node-id="vco1"]').click();

  const ports = page.locator('[data-testid="patch-to-port"]');
  const portIds = await ports.evaluateAll((els) =>
    els.map((el) => (el as HTMLElement).getAttribute('data-port-id') ?? ''),
  );
  // ADSR.env is type='cv'; AnalogVCO's compatible CV-typed inputs are tune,
  // fine, fmAmount, pmAmount (pitch/fm/pm are audio-rate). Order follows
  // declaration order in the module def.
  expect(portIds).toContain('tune');
  expect(portIds).toContain('fine');
  expect(portIds).toContain('fmAmount');
  expect(portIds).toContain('pmAmount');
  // Sanity: no "No compatible ports" — the original user-report bug.
  await expect(page.locator('[data-testid="no-compatible-ports"]')).toHaveCount(0);
});

test('ADSR.env → Wavetable VCO shows tune/fine/fmAmount/pmAmount/wavePos as compatible', async ({
  page,
}) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(
    page,
    [
      { id: 'adsr1', type: 'adsr',         position: { x: 100, y: 200 } },
      { id: 'wt1',   type: 'wavetableVco', position: { x: 500, y: 200 } },
    ],
    [],
  );

  await rightClickPanelHandle(page, 'adsr1', 'env');
  await page.locator('[data-testid="patch-to-module"][data-node-id="wt1"]').click();

  const ports = page.locator('[data-testid="patch-to-port"]');
  const portIds = await ports.evaluateAll((els) =>
    els.map((el) => (el as HTMLElement).getAttribute('data-port-id') ?? ''),
  );
  expect(portIds).toContain('tune');
  expect(portIds).toContain('fine');
  expect(portIds).toContain('fmAmount');
  expect(portIds).toContain('pmAmount');
  expect(portIds).toContain('wavePos');
  await expect(page.locator('[data-testid="no-compatible-ports"]')).toHaveCount(0);
});
