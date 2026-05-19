// e2e/tests/cable-drag-panel-lock.spec.ts
//
// PatchPanel persistence during in-flight cable drags.
//
// Contract: when a PatchPanel opens as a result of an active Svelte Flow
// connect-drag, it stays open until the drag commits (onconnect) or
// releases (onconnectend). PatchPanels NOT opened during a drag keep
// their existing PR-66/PR-88 hover-intent + 300ms post-click hold
// behaviour — only the drag-induced open path is locked.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

interface PatchEdge {
  id: string;
  source: { nodeId: string; portId: string };
  target: { nodeId: string; portId: string };
}

async function readEdges(page: Page): Promise<PatchEdge[]> {
  return await page.evaluate(() => {
    const w = window as unknown as { __patch: { edges: Record<string, PatchEdge> } };
    return Object.values(w.__patch.edges).filter(Boolean) as PatchEdge[];
  });
}

test.describe('PatchPanel: drag-induced lock', () => {
  test('PatchPanel opened mid-drag stays open until the cable connects', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Source LFO at left, target FILTER at right. We pin the source
    // panel via click so we can grab phase0 (the cable starts FROM the
    // source). The TARGET panel is the one we want to verify stays
    // open through the drag — it must NOT have been opened in advance.
    await spawnPatch(page, [
      { id: 'lfo', type: 'lfo', position: { x: 80, y: 100 } },
      { id: 'flt', type: 'filter', position: { x: 700, y: 100 } },
    ]);

    // Open the source panel via click so phase0's handle sits in its
    // open-state row position.
    await page
      .locator(`.svelte-flow__node[data-id="lfo"] [data-testid="patch-trigger"]`)
      .click();
    await expect(
      page.locator(`.svelte-flow__node[data-id="lfo"] [data-testid="patch-panel"]`),
    ).toHaveAttribute('aria-hidden', 'false');

    // Confirm the FILTER panel starts CLOSED. Critical to the test —
    // we want to open it via hover DURING the drag.
    const filterPanel = page.locator(
      `.svelte-flow__node[data-id="flt"] [data-testid="patch-panel"]`,
    );
    await expect(filterPanel).toHaveAttribute('aria-hidden', 'true');

    // Wait for the source panel's handle re-measure to settle.
    await page.waitForTimeout(250);

    const sourceHandle = page.locator(
      `.svelte-flow__node[data-id="lfo"] .svelte-flow__handle[data-handleid="phase0"][class*="source"]`,
    );
    const sBox = await sourceHandle.boundingBox();
    expect(sBox, 'source handle has box').toBeTruthy();
    if (!sBox) return;

    // Begin the drag from the source handle.
    await page.mouse.move(sBox.x + sBox.width / 2, sBox.y + sBox.height / 2);
    await page.mouse.down();

    // Move the pointer onto the FILTER's right-side trigger (the
    // closer corner-anchor when approaching from the left). The
    // hover should open the filter panel mid-drag.
    const filterTrigger = page.locator(
      `.svelte-flow__node[data-id="flt"] [data-testid="patch-trigger"]`,
    );
    const triggerBox = await filterTrigger.boundingBox();
    expect(triggerBox, 'filter trigger has box').toBeTruthy();
    if (!triggerBox) return;

    await page.mouse.move(
      triggerBox.x + triggerBox.width / 2,
      triggerBox.y + triggerBox.height / 2,
      { steps: 20 },
    );

    // FILTER panel must open via hover-intent.
    await expect(filterPanel).toHaveAttribute('aria-hidden', 'false');

    // Drag is in flight + this panel claimed the lock.
    const lockState = await page.evaluate(() => {
      const w = window as unknown as {
        __connectDragState?: { active: boolean; lockedPanelNodeId: string | null };
      };
      return {
        active: w.__connectDragState?.active ?? null,
        lockedPanelNodeId: w.__connectDragState?.lockedPanelNodeId ?? null,
      };
    });
    expect(lockState.active, 'connect-drag active during in-flight drag').toBe(true);
    expect(lockState.lockedPanelNodeId, 'filter panel claimed the lock').toBe('flt');

    // Move the pointer AWAY from the filter trigger and panel — only
    // briefly so xyflow's drag tracker keeps accumulating moves. The
    // 350ms wait is the critical assertion: without the lock the
    // panel would close at the +200ms hover-close grace, so a state
    // check at +350ms proves the lock kept it open.
    await page.mouse.move(triggerBox.x + 200, triggerBox.y + 200, { steps: 5 });
    await page.waitForTimeout(350);
    await expect(
      filterPanel,
      'panel stays open mid-drag despite pointer leaving',
    ).toHaveAttribute('aria-hidden', 'false');

    // Move onto the target port (cutoff) and release to commit the
    // connection. xyflow tracks the connection via continuous
    // pointermoves — we go straight from the previous position to
    // the target handle in many small steps to keep the hit-test
    // bucket size reasonable on slow CI.
    const targetHandle = page.locator(
      `.svelte-flow__node[data-id="flt"] .svelte-flow__handle[data-handleid="cutoff"][class*="target"]`,
    );
    const tBox = await targetHandle.boundingBox();
    expect(tBox, 'target handle has box').toBeTruthy();
    if (!tBox) return;

    await page.mouse.move(tBox.x + tBox.width / 2, tBox.y + tBox.height / 2, { steps: 25 });
    await page.mouse.up();
    await page.waitForTimeout(150);

    // Connection landed.
    const edges = await readEdges(page);
    expect(edges.length).toBe(1);
    expect(edges[0]!.source).toEqual({ nodeId: 'lfo', portId: 'phase0' });
    expect(edges[0]!.target).toEqual({ nodeId: 'flt', portId: 'cutoff' });

    // Lock released after commit.
    const finalLock = await page.evaluate(() => {
      const w = window as unknown as {
        __connectDragState?: { active: boolean; lockedPanelNodeId: string | null };
      };
      return w.__connectDragState?.active ?? null;
    });
    expect(finalLock, 'lock released after connect').toBe(false);
  });

  test('cable release without connecting closes the locked panel', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [
      { id: 'lfo', type: 'lfo', position: { x: 80, y: 100 } },
      { id: 'flt', type: 'filter', position: { x: 700, y: 100 } },
    ]);

    await page
      .locator(`.svelte-flow__node[data-id="lfo"] [data-testid="patch-trigger"]`)
      .click();
    await page.waitForTimeout(250);

    const sourceHandle = page.locator(
      `.svelte-flow__node[data-id="lfo"] .svelte-flow__handle[data-handleid="phase0"][class*="source"]`,
    );
    const sBox = await sourceHandle.boundingBox();
    if (!sBox) return;

    await page.mouse.move(sBox.x + sBox.width / 2, sBox.y + sBox.height / 2);
    await page.mouse.down();

    const filterTrigger = page.locator(
      `.svelte-flow__node[data-id="flt"] [data-testid="patch-trigger"]`,
    );
    const triggerBox = await filterTrigger.boundingBox();
    if (!triggerBox) return;

    await page.mouse.move(
      triggerBox.x + triggerBox.width / 2,
      triggerBox.y + triggerBox.height / 2,
      { steps: 20 },
    );
    const filterPanel = page.locator(
      `.svelte-flow__node[data-id="flt"] [data-testid="patch-panel"]`,
    );
    await expect(filterPanel).toHaveAttribute('aria-hidden', 'false');

    // Release outside any port — drag cancels without a connect.
    await page.mouse.move(triggerBox.x + 200, triggerBox.y - 200, { steps: 10 });
    await page.mouse.up();

    // No edge created.
    const edges = await readEdges(page);
    expect(edges.length).toBe(0);

    // Lock released; with the cursor far from the trigger, the panel
    // closes after the standard hover-close grace (200ms). Wait long
    // enough to be safe on slow CI.
    await page.waitForTimeout(400);
    await expect(filterPanel).toHaveAttribute('aria-hidden', 'true');
  });

  test('non-drag PatchPanel click-open / outside-click-close (PR-204)', async ({ page }) => {
    // No cable drag at all — pure click-open. Post-PR-204 the panel is
    // click-to-open and stays open until an outside click in negative
    // space; hover does nothing.
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [{ id: 'adsr', type: 'adsr', position: { x: 200, y: 200 } }]);

    const trigger = page.locator(
      `.svelte-flow__node[data-id="adsr"] [data-testid="patch-trigger"]`,
    );
    const panel = page.locator(
      `.svelte-flow__node[data-id="adsr"] [data-testid="patch-panel"]`,
    );

    // Hover ALONE no longer opens.
    await trigger.hover();
    await page.waitForTimeout(150);
    await expect(panel).toHaveAttribute('aria-hidden', 'true');

    // Click pins the panel open (no drag involved).
    await trigger.click();
    await expect(panel).toHaveAttribute('aria-hidden', 'false');

    // Cursor leaving the panel area does NOT close it.
    await page.mouse.move(20, 20);
    await page.waitForTimeout(400);
    await expect(panel).toHaveAttribute('aria-hidden', 'false');

    // Outside click dismisses the pin.
    await page.mouse.click(20, 20);
    await page.waitForTimeout(100);
    await expect(panel).toHaveAttribute('aria-hidden', 'true');
  });
});
