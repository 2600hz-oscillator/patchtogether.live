// e2e/tests/cable-drag-section-expand.spec.ts
//
// End-to-end coverage for the cable-drop UX:
//
//   1. Dragging a cable over ANY module card auto-opens its patch
//      panel (via the document-level pointermove tracker in
//      connect-drag-state — see connect-drag-state.svelte.ts +
//      PatchPanel.svelte's dragHoverEngaged driver).
//   2. On sectioned cards (HYDROGEN, RIOTGIRLS) the drag-time
//      expand-all opens every section so the user sees every
//      possible target without click-hunting through collapsed
//      headers. Subsections (recursive) are reached too.
//   3. Cursor leaving + returning during the same drag preserves
//      the expansion (regression for the "expandedSections cleared
//      on close → re-open finds nothing expanded" bug).
//   4. The patch-to cascade lists every CV-family-compatible
//      candidate in both directions (gate↔cv↔pitch interchange
//      from canConnect). Regression for the cascade hiding
//      legitimate cross-family targets even when the engine
//      permitted them.
//
// Why HYDROGEN as the canary card: it ships 17 sections (Master +
// 16 instruments) so partial expansion fails loudly. RIOTGIRLS
// would work too but its 4 voices × 10 ports is harder to assert
// against than HYDROGEN's per-instrument single-trig sections.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

/** Click the top-left patch-trigger to open a panel. Mirrors the helper in
 *  patch-menu-ux.spec.ts; duplicated here so this spec stays self-contained
 *  (the patch-menu spec is intentionally focused on the post-PR-204 menu
 *  contract; bundling the helper would couple the two specs). */
async function openPanel(page: Page, nodeId: string): Promise<void> {
  await page
    .locator(`.svelte-flow__node[data-id="${nodeId}"] [data-testid="patch-trigger"]`)
    .first()
    .click();
  await expect(
    page.locator(`.svelte-flow__node[data-id="${nodeId}"] [data-testid="patch-panel"]`),
  ).toHaveAttribute('aria-hidden', 'false');
}

/** Resolve a port handle inside an open PatchPanel. */
function panelHandle(page: Page, nodeId: string, portId: string) {
  return page.locator(
    `.svelte-flow__node[data-id="${nodeId}"] [data-testid="patch-panel"] ` +
      `.svelte-flow__handle[data-handleid="${portId}"]`,
  );
}

/** Card-wrapper locator. */
function nodeWrapper(page: Page, nodeId: string) {
  return page.locator(`.svelte-flow__node[data-id="${nodeId}"]`);
}

/** Read drag-state from the dev-mode global. */
async function readDragMode(page: Page): Promise<string> {
  return page.evaluate(() => {
    const w = globalThis as unknown as { __connectDragState?: { mode: string } };
    return w.__connectDragState?.mode ?? 'idle';
  });
}

// ============================================================================
// (1) + (2) — cable-drop opens panel + expands all sections
// ============================================================================

test.describe('cable-drag → panel auto-opens + sections expand', () => {
  test('dragging from SEQUENCER.gate over HYDROGEN opens the panel and expands every section', async ({
    page,
  }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await spawnPatch(page, [
      { id: 'seq', type: 'sequencer', position: { x: 80, y: 100 } },
      // HYDROGEN is wide — keep enough horizontal room to land cursor cleanly.
      { id: 'hyd', type: 'hydrogen', position: { x: 900, y: 100 } },
    ]);

    await openPanel(page, 'seq');
    const sourceHandle = panelHandle(page, 'seq', 'gate');
    await expect(sourceHandle).toBeVisible();
    const sBox = await sourceHandle.boundingBox();
    expect(sBox).toBeTruthy();
    if (!sBox) return;

    // Locate HYDROGEN's card bounds so we can drag the cable INTO it.
    const hyd = nodeWrapper(page, 'hyd');
    await expect(hyd).toBeVisible();
    const hBox = await hyd.boundingBox();
    expect(hBox).toBeTruthy();
    if (!hBox) return;

    // Start the drag from SEQUENCER.gate, move past the 5 px connect
    // threshold so xyflow fires onConnectStart.
    const sx = sBox.x + sBox.width / 2;
    const sy = sBox.y + sBox.height / 2;
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(sx + 30, sy + 10, { steps: 5 });

    // Drag is active in our state machine.
    await expect.poll(() => readDragMode(page), { timeout: 1500 }).toBe('dragging');

    // Move the cursor over the destination card body.
    const tx = hBox.x + hBox.width / 2;
    const ty = hBox.y + hBox.height / 2;
    await page.mouse.move(tx, ty, { steps: 10 });

    // (1) Destination panel auto-opens.
    const hydPanel = page
      .locator(`.svelte-flow__node[data-id="hyd"] [data-testid="patch-panel"]`)
      .first();
    await expect(hydPanel).toHaveAttribute('aria-hidden', 'false', { timeout: 1500 });

    // (2) Every section reachable — the drag-time expand-all opens
    // each header so every per-instrument trig handle is visible
    // without click-hunting. We assert a handle in the *last*
    // declared section (the deepest non-master one) because if the
    // expand-all only ran for the first section we'd miss this.
    const lastTrig = panelHandle(page, 'hyd', 'trig15');
    await expect(lastTrig).toBeVisible({ timeout: 1500 });

    // Cancel — release on the canvas pane far from any handle.
    await page.mouse.move(20, 20);
    await page.mouse.up();
    await expect.poll(() => readDragMode(page), { timeout: 1500 }).toBe('idle');
  });

  test('cursor leaving + returning during one drag preserves the expanded sections', async ({
    page,
  }) => {
    // Regression for "expandedSections cleared on close mid-drag,
    // re-open finds everything collapsed".
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await spawnPatch(page, [
      { id: 'seq', type: 'sequencer', position: { x: 80, y: 100 } },
      { id: 'hyd', type: 'hydrogen', position: { x: 900, y: 100 } },
    ]);

    await openPanel(page, 'seq');
    const sourceHandle = panelHandle(page, 'seq', 'gate');
    const sBox = await sourceHandle.boundingBox();
    if (!sBox) return;
    const hyd = nodeWrapper(page, 'hyd');
    const hBox = await hyd.boundingBox();
    if (!hBox) return;

    const sx = sBox.x + sBox.width / 2;
    const sy = sBox.y + sBox.height / 2;
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(sx + 30, sy + 10, { steps: 5 });
    await expect.poll(() => readDragMode(page), { timeout: 1500 }).toBe('dragging');

    const tx = hBox.x + hBox.width / 2;
    const ty = hBox.y + hBox.height / 2;
    // First visit: panel opens, sections expand.
    await page.mouse.move(tx, ty, { steps: 10 });
    const lastTrig = panelHandle(page, 'hyd', 'trig15');
    await expect(lastTrig).toBeVisible({ timeout: 1500 });

    // Leave the card — cursor on empty canvas.
    await page.mouse.move(20, 20, { steps: 10 });
    // Re-enter.
    await page.mouse.move(tx, ty, { steps: 10 });
    // Section content STILL visible — the expand-all re-fires (or
    // expandedSections was preserved across the close-reopen flip).
    await expect(lastTrig).toBeVisible({ timeout: 1500 });

    // Cancel.
    await page.mouse.move(20, 20);
    await page.mouse.up();
    await expect.poll(() => readDragMode(page), { timeout: 1500 }).toBe('idle');
  });
});

// ============================================================================
// (4) — patch-to cascade lists CV-family-compatible candidates
// ============================================================================

test.describe('patch-to cascade — cv-family interchange', () => {
  test('SEQUENCER.gate → ADSR lists gate + every cv input (attack/decay/sustain/release)', async ({
    page,
  }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await spawnPatch(page, [
      { id: 'seq', type: 'sequencer', position: { x: 80, y: 100 } },
      { id: 'adsr', type: 'adsr', position: { x: 600, y: 100 } },
    ]);

    await openPanel(page, 'seq');
    const handle = panelHandle(page, 'seq', 'gate');
    await expect(handle).toBeVisible();
    await handle.hover();
    await handle.click({ button: 'right' });
    await expect(page.locator('[data-testid="port-context-menu"]')).toBeVisible();

    await page.locator('[data-testid="patch-to-module"][data-node-id="adsr"]').click();

    const portIds = await page
      .locator('[data-testid="patch-to-port"]')
      .evaluateAll((els) =>
        els.map((el) => (el as HTMLElement).getAttribute('data-port-id') ?? ''),
      );
    expect(portIds.sort()).toEqual(['attack', 'decay', 'gate', 'release', 'sustain']);

    await page.keyboard.press('Escape');
  });

  test('SEQUENCER.pitch → ANALOG VCO lists pitch_cv + cv params (tune / fmAmount), excludes audio', async ({
    page,
  }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await spawnPatch(page, [
      { id: 'seq', type: 'sequencer', position: { x: 80, y: 100 } },
      { id: 'vco', type: 'analogVco', position: { x: 600, y: 100 } },
    ]);

    await openPanel(page, 'seq');
    const handle = panelHandle(page, 'seq', 'pitch');
    await expect(handle).toBeVisible();
    await handle.hover();
    await handle.click({ button: 'right' });
    await expect(page.locator('[data-testid="port-context-menu"]')).toBeVisible();

    await page.locator('[data-testid="patch-to-module"][data-node-id="vco"]').click();

    const portIds = await page
      .locator('[data-testid="patch-to-port"]')
      .evaluateAll((els) =>
        els.map((el) => (el as HTMLElement).getAttribute('data-port-id') ?? ''),
      );
    // Expect pitch_cv (pitch→pitch equality) + every cv input on the VCO.
    // 'fm' is type 'audio' and must NOT appear (audio family is strict).
    expect(portIds).toContain('pitch_cv');
    expect(portIds).toContain('tune');
    expect(portIds).toContain('fine');
    expect(portIds).toContain('fmAmount');
    expect(portIds).toContain('pmAmount');
    expect(portIds).not.toContain('fm');
  });

  test('reverse: right-click ADSR.gate (input) → LFO lists every cv output', async ({
    page,
  }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await spawnPatch(page, [
      { id: 'adsr', type: 'adsr', position: { x: 80, y: 100 } },
      { id: 'lfo', type: 'lfo', position: { x: 600, y: 100 } },
    ]);

    await openPanel(page, 'adsr');
    const handle = panelHandle(page, 'adsr', 'gate');
    await expect(handle).toBeVisible();
    await handle.hover();
    await handle.click({ button: 'right' });
    await expect(page.locator('[data-testid="port-context-menu"]')).toBeVisible();

    await page.locator('[data-testid="patch-to-module"][data-node-id="lfo"]').click();

    const portIds = await page
      .locator('[data-testid="patch-to-port"]')
      .evaluateAll((els) =>
        els.map((el) => (el as HTMLElement).getAttribute('data-port-id') ?? ''),
      );
    // All four LFO phase outputs are cv → previously REJECTED (cv→gate),
    // now permitted via CV_FAMILY interchange.
    expect(portIds.sort()).toEqual(['phase0', 'phase180', 'phase270', 'phase90']);
  });

  test('commits successfully: SEQUENCER.gate → ADSR.attack via cascade (cross-family edge)', async ({
    page,
  }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await spawnPatch(page, [
      { id: 'seq', type: 'sequencer', position: { x: 80, y: 100 } },
      { id: 'adsr', type: 'adsr', position: { x: 600, y: 100 } },
    ]);

    await openPanel(page, 'seq');
    const handle = panelHandle(page, 'seq', 'gate');
    await handle.hover();
    await handle.click({ button: 'right' });
    await page.locator('[data-testid="patch-to-module"][data-node-id="adsr"]').click();
    await page
      .locator('[data-testid="patch-to-port"][data-port-id="attack"]')
      .click();
    await expect(page.locator('[data-testid="port-context-menu"]')).toHaveCount(0);

    const edges = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { edges: Record<string, unknown> };
      };
      return Object.values(w.__patch.edges);
    });
    expect(edges.length).toBe(1);
  });
});
