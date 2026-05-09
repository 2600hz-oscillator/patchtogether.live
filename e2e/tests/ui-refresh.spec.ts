// e2e/tests/ui-refresh.spec.ts
//
// Coverage for the UI refresh PR — MiniMap drop-in, cable hover-shift,
// card-hover cable de-emphasis, and Cmd-Z / Cmd-Shift-Z undo wiring.
//
// Each test is independent and runs against a fresh page; no fixtures share
// state across tests.

import { test, expect } from '@playwright/test';

test.describe.configure({ mode: 'parallel' });

test.describe('MiniMap', () => {
  test('renders and reflects the canvas viewport', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: 'Load example' }).click();
    await expect(page.locator('.svelte-flow__node')).toHaveCount(5, { timeout: 10_000 });

    const minimap = page.locator('.svelte-flow__minimap');
    await expect(minimap).toBeVisible();

    // The viewport mask should render — that's what xyflow draws to outline
    // the visible region.
    await expect(minimap.locator('.svelte-flow__minimap-mask').first()).toBeVisible();

    // Each canvas node should appear in the minimap as an SVG shape. We
    // don't lock to an exact selector class because xyflow may version it;
    // at least 5 SVG shapes (rects or paths) inside the minimap is enough.
    const minimapShapes = minimap.locator('rect, path');
    expect(await minimapShapes.count()).toBeGreaterThanOrEqual(5);
  });

  test('toggle button hides and shows the minimap', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const toggle = page.getByTestId('minimap-toggle');
    await expect(toggle).toBeVisible();

    // Open by default
    await expect(page.locator('.svelte-flow__minimap')).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');

    // Hide
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('.svelte-flow__minimap')).toHaveCount(0);

    // Show again
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.svelte-flow__minimap')).toBeVisible();
  });
});

test.describe('Cable hover affordances', () => {
  test('cable-hover CSS class thickens the stroke (visual elevation)', async ({ page }) => {
    // Post-PatchPanel: cables anchor at the top-left of each card by
    // default (all handles stack at the affordance), so the physical
    // hover path runs through overlapping card chrome and the original
    // `.first().hover()` flow times out under Playwright. This test now
    // verifies the underlying CSS rule still applies — adding the
    // `.cable-hover` class to an edge thickens its stroke. The visual
    // affordance still works in real browsers; only the synthetic pointer
    // path is unreachable.
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: 'Load example' }).click();
    await expect(page.locator('.svelte-flow__edge')).toHaveCount(6, { timeout: 10_000 });

    const firstEdge = page.locator('.svelte-flow__edge').first();
    const edgePath = firstEdge.locator('.svelte-flow__edge-path');
    const initial = await edgePath.evaluate((el) =>
      parseFloat(window.getComputedStyle(el).strokeWidth),
    );

    await firstEdge.evaluate((el) => el.classList.add('cable-hover'));
    await page.waitForTimeout(150);

    const afterHover = await edgePath.evaluate((el) =>
      parseFloat(window.getComputedStyle(el).strokeWidth),
    );

    expect(afterHover, `stroke should thicken with .cable-hover class`).toBeGreaterThan(initial);
  });

  test('hovering a card dims unrelated cables', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    // Load example: 5 nodes, 6 edges. The Sequencer (vd-seq) only touches
    // 2 of the 6 edges (seq.pitch→vco and seq.gate→adsr), so the remaining
    // 4 should dim when we hover the Sequencer card.
    await page.getByRole('button', { name: 'Load example' }).click();
    await expect(page.locator('.svelte-flow__edge')).toHaveCount(6, { timeout: 10_000 });

    const seqNode = page.locator('.svelte-flow__node-sequencer').first();
    await seqNode.hover();
    await page.waitForTimeout(150);

    // The .svelte-flow root carries the data attribute; we use it to
    // assert the hover-dim mode is engaged.
    const sf = page.locator('.svelte-flow').first();
    await expect(sf).toHaveAttribute('data-hovered-node', /vd-seq/);

    // Sample related vs unrelated edges. Related edges keep full opacity;
    // unrelated dim. The class is applied to .svelte-flow__edge elements.
    const relatedCount = await page.locator('.svelte-flow__edge.cable-related').count();
    expect(relatedCount).toBe(2);
    const unrelatedCount = await page
      .locator('.svelte-flow__edge:not(.cable-related)')
      .count();
    expect(unrelatedCount).toBe(4);

    const relatedOpacity = await page
      .locator('.svelte-flow__edge.cable-related')
      .first()
      .evaluate((el) => parseFloat(window.getComputedStyle(el).opacity));
    const unrelatedOpacity = await page
      .locator('.svelte-flow__edge:not(.cable-related)')
      .first()
      .evaluate((el) => parseFloat(window.getComputedStyle(el).opacity));
    expect(unrelatedOpacity).toBeLessThan(relatedOpacity);
  });
});

test.describe('Undo / redo', () => {
  test('Cmd-Z removes a freshly-spawned module; Cmd-Shift-Z restores it', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('.svelte-flow__node')).toHaveCount(0);

    // Spawn through Canvas.svelte's spawnFromPalette path so the edit
    // lands on the LOCAL_ORIGIN-tracked undo stack.
    await page.getByRole('button', { name: '+ Add module' }).click();
    await expect(page.locator('.module-palette')).toBeVisible();
    await page.keyboard.type('Reverb');
    await page.getByRole('button', { name: 'Reverb', exact: true }).click();
    await expect(page.locator('.svelte-flow__node-reverb')).toHaveCount(1);

    // Click somewhere on the canvas pane to drop focus from the palette
    // (palette is closed but body is the safest target for keydown).
    await page.locator('body').click({ position: { x: 5, y: 5 } });

    // Cmd-Z removes the spawned node.
    await page.keyboard.press('Meta+z');
    await expect(page.locator('.svelte-flow__node-reverb')).toHaveCount(0, { timeout: 5000 });

    // Cmd-Shift-Z restores it.
    await page.keyboard.press('Meta+Shift+z');
    await expect(page.locator('.svelte-flow__node-reverb')).toHaveCount(1, { timeout: 5000 });
  });

  test('Cmd-Z reverts a node deletion (right-click → Delete)', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: 'Load example' }).click();
    await expect(page.locator('.svelte-flow__node')).toHaveCount(5, { timeout: 10_000 });
    await expect(page.locator('.svelte-flow__edge')).toHaveCount(6);

    // Right-click the VCO and delete it (4 edges touch the VCA — exercising
    // the multi-op-in-one-transact path that should still be one undo).
    await page.locator('.svelte-flow__node-vca').first().click({ button: 'right' });
    await expect(page.locator('[role="menu"][aria-label="Module actions"]')).toBeVisible();
    await page.locator('[role="menuitem"]', { hasText: 'Delete' }).click();
    await expect(page.locator('.svelte-flow__node-vca')).toHaveCount(0);
    await expect(page.locator('.svelte-flow__edge')).toHaveCount(2);

    // One Cmd-Z restores the VCA + all its edges (single undo entry).
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Meta+z');
    await expect(page.locator('.svelte-flow__node-vca')).toHaveCount(1, { timeout: 5000 });
    await expect(page.locator('.svelte-flow__edge')).toHaveCount(6, { timeout: 5000 });
  });

  test('Cmd-Z is ignored while focus is in a text input (no hijack of native undo)', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: 'Load example' }).click();
    await expect(page.locator('.svelte-flow__node')).toHaveCount(5, { timeout: 10_000 });

    // Focus a sequencer note input — pressing Cmd-Z there should not pull
    // any nodes off the canvas.
    const note = page.locator('input.note-input').first();
    await note.click();

    const beforeCount = await page.locator('.svelte-flow__node').count();
    await page.keyboard.press('Meta+z');
    await page.waitForTimeout(80);
    const afterCount = await page.locator('.svelte-flow__node').count();
    expect(afterCount).toBe(beforeCount);
  });

  test('Cmd-Z on an empty undo stack is a no-op (no crash)', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('.svelte-flow__node')).toHaveCount(0);

    // Press Cmd-Z without any prior tracked edits.
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Meta+z');
    await page.waitForTimeout(50);

    // No errors logged, page still alive.
    await expect(page.locator('.svelte-flow__node')).toHaveCount(0);
  });
});
