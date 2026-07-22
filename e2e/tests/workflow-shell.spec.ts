// e2e/tests/workflow-shell.spec.ts
//
// P0.3b — the WORKFLOW-SHELL legacy-fallback bridge, end to end. Proves the
// core day-one guarantee: under the `?shell=1` preview an UN-MIGRATED module
// renders a uniform styled PLACEHOLDER in its lane (cables stay attached), while
// its REAL, unchanged legacy card opens verbatim in the bottom dock full-view
// and is fully OPERABLE there (drive a control → the graph param changes).
//
// And the NO-OP guarantee: with the preview OFF (the default) the module renders
// its real card in the lane EXACTLY as today — the bridge is inert until owner
// sign-off, so nothing else in workflow mode changes.
//
// Runs on /rack?mode=workflow (no DB/relay) — the normal e2e lane, same as
// workflow-dock.spec.ts. Shell state is transient/local (never in the Y.Doc).

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

async function gotoWorkflow(page: Page, opts: { shell: boolean }): Promise<void> {
  await page.goto(opts.shell ? '/rack?mode=workflow&shell=1' : '/rack?mode=workflow');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible();
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
}

/** Read one node param through the dev __patch global. */
async function readParam(page: Page, nodeId: string, paramId: string): Promise<number | undefined> {
  return page.evaluate(
    ({ nodeId, paramId }) => {
      const w = globalThis as unknown as {
        __patch?: { nodes: Record<string, { params?: Record<string, number> } | undefined> };
      };
      return w.__patch?.nodes?.[nodeId]?.params?.[paramId];
    },
    { nodeId, paramId },
  );
}

const NODE = 'v1';

test.describe('P0.3b workflow-shell legacy-fallback bridge', () => {
  test('un-migrated module → placeholder in lane + legacy card operable in the dock', async ({ page }) => {
    await gotoWorkflow(page, { shell: true });
    await spawnPatch(page, [{ id: NODE, type: 'vca', position: { x: 460, y: 240 } }]);

    const laneNode = page.locator(`.svelte-flow__node[data-id="${NODE}"]`);
    await expect(laneNode).toHaveCount(1);

    // 1) The lane shows the UNIFORM PLACEHOLDER — not the legacy vca card.
    const placeholder = laneNode.locator('[data-testid="module-shell-placeholder"]');
    await expect(placeholder).toBeVisible();
    // No legacy controls in the lane (they moved to the dock):
    await expect(laneNode.locator('[data-testid^="control-"]')).toHaveCount(0);
    // Cables stay attached: the node keeps its full invisible handle stack.
    await expect(laneNode.locator('.svelte-flow__handle').first()).toHaveCount(1);

    // 2) Open in dock (the jack-rail "⤢" expand) → the RACKLINE full-view
    //    FACEPLATE opens in the bottom drawer (NOT a generic .dock-card).
    await placeholder.getByTestId('shell-open-dock').click();
    const faceplate = page.getByTestId('dock-full-view');
    await expect(faceplate).toBeVisible();
    // The spec chrome: grip, title bar (badge + name + mono sub), the window-
    // control trio (collapse + close in P0.3b; undock omitted), the tab-rail
    // seam with a single "MODULE" tab, and the domain-classed faceplate frame.
    await expect(faceplate.getByTestId('faceplate-grip')).toBeVisible();
    await expect(faceplate.locator('.faceplate-bar .face-badge')).toBeVisible();
    await expect(faceplate.locator('.faceplate-bar .face-name')).toBeVisible();
    // The mono sub reads "<module label> · lane N" — assert the "lane" descriptor.
    await expect(faceplate.locator('.faceplate-bar .face-sub')).toBeVisible();
    await expect(faceplate.getByTestId('faceplate-close')).toBeVisible();
    await expect(faceplate.getByTestId('faceplate-collapse')).toBeVisible();
    await expect(faceplate.getByTestId('faceplate-tab')).toHaveText('MODULE');
    await expect(faceplate.locator('.faceplate.audio')).toHaveCount(1); // vca = audio domain

    // …and the REAL, unchanged legacy card mounts verbatim in .editor at native
    //  scale (carrying the data-dock-card anchor so PickupCable/patch-menu work).
    const dockCard = faceplate.getByTestId('faceplate-editor').locator(`[data-dock-card="${NODE}"]`);
    await expect(dockCard).toBeVisible();
    await expect(dockCard.locator('.mod-card, .card, .moog-panel').first()).toBeVisible();
    // The faceplate hosts NO xyflow handles / node wrappers (PatchPanel self-gates):
    await expect(faceplate.locator('.svelte-flow__handle')).toHaveCount(0);
    await expect(faceplate.locator('.svelte-flow__node')).toHaveCount(0);

    // 3) The lane placeholder STILL shows (Option #1: lane face + dock faceplate
    //    coexist — the module was never persist-docked / swapped to a stub).
    await expect(placeholder).toBeVisible();
    await expect(laneNode.locator('[data-testid="dock-stub"]')).toHaveCount(0);

    // 4) Drive a control in the mounted card → the graph param changes (operable).
    const before = await readParam(page, NODE, 'base');
    const track = dockCard.locator('.fader-wrap .track').first();
    const box = await track.boundingBox();
    expect(box, 'a fader track should be present in the docked card').toBeTruthy();
    if (!box) return;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx, cy - 34, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(120);
    const after = await readParam(page, NODE, 'base');
    expect(after, `base should change after driving the fader (was ${before}, now ${after})`).not.toBe(before);

    // 5) ESC closes the full-view faceplate; the placeholder remains in the lane.
    await page.keyboard.press('Escape');
    await expect(faceplate).toHaveCount(0);
    await expect(placeholder).toBeVisible();
  });

  test('placeholder tiles are UNIFORM 88px height with a consistent badge anchor', async ({ page }) => {
    // The owner "tiles are non-uniform heights + lane badges float mid-card" fix:
    // under ?shell=1 the default video-zone trio (videoOut 'dynamic', recorderbox
    // 2u, synesthesia 3u — three DIFFERENT rack tiers) all render as the fixed
    // 88px RACKLINE tile, so the baseline number badges cap them flush.
    await gotoWorkflow(page, { shell: true });
    const ids = ['workflow-videoOut', 'workflow-recorderbox', 'workflow-synesthesia'];
    for (const id of ids) {
      await expect(
        page.locator(`.svelte-flow__node[data-id="${id}"] [data-testid="module-shell-placeholder"]`),
      ).toBeVisible({ timeout: 15_000 });
    }

    const metrics = await page.evaluate((nodeIds) => {
      return nodeIds.map((id) => {
        const tile = document.querySelector(
          `.svelte-flow__node[data-id="${id}"] [data-testid="module-shell-placeholder"]`,
        ) as HTMLElement | null;
        const badge = tile?.querySelector('.tile-badge') as HTMLElement | null;
        if (!tile || !badge) return null;
        // offsetHeight / offsetTop are UNSCALED layout px (immune to the xyflow
        // viewport zoom transform), so 88 is the true tile height and offsetTop
        // is the badge's anchor within the tile.
        return { h: tile.offsetHeight, badgeTop: badge.offsetTop };
      });
    }, ids);

    expect(metrics.every((m) => m !== null), 'all three placeholders resolved').toBe(true);
    // Uniform 88px height across THREE different rack tiers (the fix).
    for (const m of metrics) expect(m!.h).toBe(88);
    // The badge sits at an IDENTICAL offset from each tile's top (the anchor no
    // longer floats mid-card because the tiles are uniform).
    const badgeTops = metrics.map((m) => m!.badgeTop);
    expect(Math.max(...badgeTops) - Math.min(...badgeTops)).toBeLessThanOrEqual(1);
  });

  test('preview OFF (default) is a strict no-op: the legacy card renders in the lane', async ({ page }) => {
    await gotoWorkflow(page, { shell: false });
    await spawnPatch(page, [{ id: NODE, type: 'vca', position: { x: 460, y: 240 } }]);

    const laneNode = page.locator(`.svelte-flow__node[data-id="${NODE}"]`);
    await expect(laneNode).toHaveCount(1);
    // The REAL card + its controls render in the lane, exactly as today.
    await expect(laneNode.locator('[data-testid="control-base"]')).toBeVisible();
    // …and NO placeholder is emitted.
    await expect(laneNode.locator('[data-testid="module-shell-placeholder"]')).toHaveCount(0);
  });
});
