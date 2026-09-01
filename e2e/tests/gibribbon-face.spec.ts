// e2e/tests/gibribbon-face.spec.ts
//
// GIBRIBBON, against the FACEPLATE — the DEFAULT renderer.
//
// `gibribbon.spec.ts` rides the `rack` fixture (`?shell=legacy`), which is
// correct as coverage of the legacy card but structurally cannot see anything
// the default renderer paints. This file is the other half, deliberately
// SMALL: one test per seam the promotion moved. The game's arithmetic is
// unit-pinned (gibribbon-engine.test.ts, gibribbon-liveness.test.ts,
// gibribbon-face-model.test.ts); this proves the SURFFACE IS WIRED TO IT.
//
//   1. The LANE tile carries the live picture (hasVideoSurface → the thumb)
//      — the fate the old placeholder tile never had.
//   2. The DOCK body mounts the playfield; the KEYBOARD plays through it
//      (focus-gated, per the GAMES.md canon), and a press is the arcade
//      "insert coin" (attract → play).
//   3. SCREEN OFF removes the playfield (capture released by construction)
//      while the game KEEPS TICKING on the scheduler clock — the sequencer
//      half of the module stays alive with the screen dark.
//   4. MONITOR hides the control bands and keeps the picture.
//
// Assertions read the GRAPH and the ENGINE (`node.data`, engine `read`),
// never pixels — the pixels are the dock VRT scenes' job.

import { test, expect, type Locator, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

const SLOW_RENDER = process.env.E2E_SWIFTSHADER === '1' || !!process.env.CI;
const NODE = 'gib';

async function gotoShell(page: Page): Promise<void> {
  await page.goto('/rack?seed=none');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({
    timeout: SLOW_RENDER ? 30_000 : 15_000,
  });
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
}

function laneShell(page: Page, nodeId: string): Locator {
  return page.locator(`.svelte-flow__node[data-id="${nodeId}"] [data-testid="module-shell"]`);
}

/** Open the node's dock faceplate, SCOPED BY NODE. */
async function openDock(page: Page, nodeId: string): Promise<Locator> {
  const shell = laneShell(page, nodeId);
  await expect(shell).toBeVisible();
  await shell.getByTestId('shell-open-dock').click();
  const dockShell = page
    .getByTestId('dock-full-view')
    .locator(`[data-testid="module-shell"][data-shell-tier="dock"][data-shell-node="${nodeId}"]`);
  await expect(dockShell).toBeVisible();
  return dockShell;
}

async function readKey(page: Page, key: string): Promise<unknown> {
  return await page.evaluate(
    ({ id, k }) => {
      const w = globalThis as unknown as {
        __engine?: () => {
          read: (node: { id: string; type: string; domain: string }, key: string) => unknown;
        } | null;
        __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
      };
      const eng = w.__engine?.();
      const node = w.__patch.nodes[id];
      if (!eng || !node) return null;
      return eng.read(node, k) ?? null;
    },
    { id: NODE, k: key },
  );
}

async function spawnGibribbon(page: Page): Promise<void> {
  await gotoShell(page);
  await spawnPatch(page, [
    { id: NODE, type: 'gibribbon', position: { x: 220, y: 160 }, domain: 'video' },
  ]);
  await expect(laneShell(page, NODE)).toBeVisible();
}

test.describe('GIBRIBBON faceplate', () => {
  test('the LANE tile paints the live game thumb — the placeholder era is over', async ({ page }) => {
    // Before the rewrite gibribbon was un-migrated: `laneRenderKind` returned
    // 'placeholder' and the shipping shell mounted NO gibribbon surface at
    // all. Video domain + promotion = the free VideoTileThumb.
    await spawnGibribbon(page);
    const lane = laneShell(page, NODE);
    await expect(
      lane.locator('[data-testid="video-tile-thumb"], canvas'),
      'the lane tile must carry the live picture (VideoTileThumb), not a placeholder',
    ).toBeVisible();
    // …and the rank-1 control (DIFFICULTY) is reachable without the dock.
    await expect(lane.locator('[data-cell-key="difficulty"]')).toBeVisible();
  });

  test('the DOCK body mounts the playfield; a key press is the INSERT COIN', async ({ page }) => {
    await spawnGibribbon(page);
    const dock = await openDock(page, NODE);

    const body = dock.locator('[data-testid="gibribbon-body"]');
    await expect(body).toBeVisible();
    const playfield = body.locator('[data-testid="gibribbon-playfield"]');
    await expect(playfield).toBeVisible();

    // Fresh module, nothing patched → honest ATTRACT.
    await expect.poll(async () => readKey(page, 'mode'), { timeout: 10_000 }).toBe('attract');

    // Focus the playfield and press a play key: the arcade insert-coin —
    // attract exits into a fresh PLAY run, and the press reached the module
    // through the SAME judge path a patched cable uses.
    await playfield.click();
    await page.keyboard.press('j'); // X button
    await expect.poll(async () => readKey(page, 'mode'), { timeout: 10_000 }).toBe('play');

    // Focus-gated capture: further presses are consumed (counted) while the
    // playfield holds focus…
    const before = (await readKey(page, 'presses')) as number;
    await page.keyboard.press('f');
    await expect
      .poll(async () => readKey(page, 'presses'), { timeout: 5000 })
      .toBeGreaterThan(before);

    // …and ESC is NOT captured (it falls through to the dock chrome — the
    // playfield keeps focus and the press count does not move).
    const beforeEsc = (await readKey(page, 'presses')) as number;
    await page.keyboard.press('Escape');
    expect((await readKey(page, 'presses')) as number).toBe(beforeEsc);
  });

  test('SCREEN OFF releases the keyboard AND the game keeps ticking', async ({ page }) => {
    await spawnGibribbon(page);
    const dock = await openDock(page, NODE);
    const body = dock.locator('[data-testid="gibribbon-body"]');
    await expect(body).toBeVisible();

    // Turn the screen OFF: the playfield unmounts (capture released by
    // construction — there is nothing left to hold focus).
    await body.locator('[data-testid="gibribbon-screen-toggle"]').click();
    await expect(body.locator('[data-testid="gibribbon-playfield"]')).toHaveCount(0);
    await expect
      .poll(async () =>
        page.evaluate(
          (id) =>
            (globalThis as unknown as {
              __patch: { nodes: Record<string, { data?: { previewCollapsed?: boolean } }> };
            }).__patch.nodes[id]?.data?.previewCollapsed === true,
          NODE,
        ),
      )
      .toBe(true);

    // ⚠ THE ENGINE KEEPS TICKING — the game runs on the shared scheduler
    // clock in the FACTORY, so the dark screen stops a blit and nothing else
    // (attract keeps generating evt_* gates: the sequencer half, alive).
    const t0 = (await readKey(page, 'schedTick')) as number;
    await expect
      .poll(async () => readKey(page, 'schedTick'), { timeout: 5000 })
      .toBeGreaterThan(t0);

    // And back ON restores the playfield.
    await body.locator('[data-testid="gibribbon-screen-toggle"]').click();
    await expect(body.locator('[data-testid="gibribbon-playfield"]')).toBeVisible();
  });

  test('MONITOR hides the control bands and keeps the picture', async ({ page }) => {
    await spawnGibribbon(page);
    const dock = await openDock(page, NODE);
    const body = dock.locator('[data-testid="gibribbon-body"]');
    await expect(body).toBeVisible();

    // Baseline: the ranked cells render under the body.
    await expect(dock.locator('[data-cell-key="difficulty"]')).toBeVisible();

    await body.locator('[data-testid="gibribbon-monitor-toggle"]').click();
    await expect
      .poll(async () =>
        page.evaluate(
          (id) =>
            (globalThis as unknown as {
              __patch: { nodes: Record<string, { data?: { hideControls?: boolean } }> };
            }).__patch.nodes[id]?.data?.hideControls === true,
          NODE,
        ),
      )
      .toBe(true);
    // The bands are gone; the picture is not.
    await expect(dock.locator('[data-cell-key="difficulty"]')).toHaveCount(0);
    await expect(body.locator('[data-testid="gibribbon-playfield"]')).toBeVisible();

    // And the gesture is reversible.
    await body.locator('[data-testid="gibribbon-monitor-toggle"]').click();
    await expect(dock.locator('[data-cell-key="difficulty"]')).toBeVisible();
  });
});
