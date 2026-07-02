// e2e/tests/video-full-frame.spec.ts
//
// In-app "Full Frame" mode for the video cards (VIDEO OUT / VIDEOBOX /
// BENTBOX). Distinct from true browser fullscreen (video-fullscreen.spec.ts):
// Full Frame keeps the node IN the rack at its position but expands the video
// surface to consume the card's own border, hiding the card chrome (param
// knobs, port labels, the card's own Handle jacks). The goal is tiling several
// nodes into a "wall of TVs".
//
// Behaviour asserted:
//   * right-click the video surface -> menu has a "Full Frame" item
//   * clicking it adds `.full-frame` to the card + sets data-full-frame=true
//   * the card's own Svelte Flow handles become visually hidden (opacity 0 /
//     no pointer events) while staying in the DOM (cables stay connected)
//   * the video surface (wrap) expands to fill the card
//   * node.data.fullFrame is persisted (readable via the dev __patch global)
//   * double-click the card exits back to normal chrome
//   * Full Frame and Fullscreen are mutually exclusive

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

const TRIANGLE_PARAMS = { shape: 2, tile: 0, rotate: 0, zoom: 2.2 };

async function setup(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');
  return errors;
}

/** Read node.data.fullFrame off the dev-mode __patch global. */
async function readFullFrame(page: Page, nodeId: string): Promise<unknown> {
  return page.evaluate((id) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: { fullFrame?: unknown } }> };
    };
    return w.__patch.nodes[id]?.data?.fullFrame;
  }, nodeId);
}

/** Right-click the surface -> Full Frame, assert chrome hidden + state, then
 *  double-click to exit. `surfaceTestId` is the right-clickable video element;
 *  `cardTestId` is the card root; `wrapTestId` is the expanding wrapper;
 *  `nodeId` is the spawned node's id (for the persistence check). */
async function exercise(
  page: Page,
  cardTestId: string,
  surfaceTestId: string,
  wrapTestId: string,
  nodeId: string,
): Promise<void> {
  const card = page.locator(`[data-testid="${cardTestId}"]`);
  await expect(card, `${cardTestId} present`).toHaveCount(1);
  const surface = page.locator(`[data-testid="${surfaceTestId}"]`);
  await expect(surface, `${surfaceTestId} present`).toHaveCount(1);

  // Let any rAF blit tick.
  await page.waitForTimeout(300);

  // Right-click the video surface -> canvas menu with a Full Frame item.
  await surface.click({ button: 'right' });
  const menu = page.locator('[data-testid="video-canvas-context-menu"]');
  await expect(menu, 'canvas context menu opened').toBeVisible();
  const ffItem = page.locator('[data-testid="ctx-full-frame"]');
  await expect(ffItem, 'Full Frame item present').toBeVisible();
  await ffItem.click();

  // Card gains .full-frame + the data attribute flips true.
  await expect(card, 'card entered full-frame').toHaveClass(/full-frame/);
  await expect(card).toHaveAttribute('data-full-frame', 'true');

  // The wrap expands to fill the card.
  const wrap = page.locator(`[data-testid="${wrapTestId}"]`);
  await expect(wrap, 'wrap gained full-frame').toHaveClass(/full-frame/);

  // The card's own Svelte Flow handles are visually hidden (opacity:0 /
  // pointer-events:none) but still present in the DOM (cables stay
  // connected — we hide, not remove).
  const handles = card.locator('.svelte-flow__handle');
  const handleCount = await handles.count();
  expect(handleCount, 'handles still in DOM while full-frame').toBeGreaterThan(0);
  const firstHandle = handles.first();
  await expect(firstHandle).toHaveCSS('opacity', '0');
  await expect(firstHandle).toHaveCSS('pointer-events', 'none');

  // Persisted to node.data.fullFrame.
  expect(await readFullFrame(page, nodeId), 'fullFrame persisted true').toBe(true);

  // Double-click the card exits full-frame.
  await card.dblclick();
  await expect(card, 'card exited full-frame').not.toHaveClass(/full-frame/);
  await expect(card).toHaveAttribute('data-full-frame', 'false');
  expect(await readFullFrame(page, nodeId), 'fullFrame persisted false').toBe(false);
}

test.describe('full-frame — VIDEO OUT + VIDEOBOX + BENTBOX', () => {
  test('VIDEO OUT: right-click -> Full Frame, dblclick exits', async ({ page }) => {
    const errors = await setup(page);
    await spawnPatch(
      page,
      [
        { id: 'src', type: 'shapes', position: { x: 40, y: 40 }, domain: 'video', params: TRIANGLE_PARAMS },
        { id: 'out', type: 'videoOut', position: { x: 520, y: 40 }, domain: 'video' },
      ],
      [{ id: 'e1', from: { nodeId: 'src', portId: 'out' }, to: { nodeId: 'out', portId: 'in' }, sourceType: 'mono-video', targetType: 'video' }],
    );
    await expect(page.locator('[data-testid="video-out-card"]')).toHaveCount(1);
    await exercise(page, 'video-out-card', 'video-out-canvas', 'video-out-fs-wrap', 'out');
    expect(errors).toEqual([]);
  });

  test('VIDEOBOX: right-click -> Full Frame, dblclick exits', async ({ page }) => {
    const errors = await setup(page);
    await spawnPatch(page, [
      { id: 'vb', type: 'videobox', position: { x: 200, y: 60 }, domain: 'video' },
    ]);
    await expect(page.locator('[data-testid="videobox-card"]')).toHaveCount(1);
    await exercise(page, 'videobox-card', 'videobox-fs-wrap', 'videobox-fs-wrap', 'vb');
    expect(errors).toEqual([]);
  });

  test('BENTBOX: right-click -> Full Frame, dblclick exits', async ({ page }) => {
    const errors = await setup(page);
    await spawnPatch(
      page,
      [
        { id: 'src', type: 'shapes', position: { x: 40, y: 40 }, domain: 'video', params: TRIANGLE_PARAMS },
        { id: 'bb', type: 'bentbox', position: { x: 520, y: 40 }, domain: 'video' },
      ],
      [{ id: 'e1', from: { nodeId: 'src', portId: 'out' }, to: { nodeId: 'bb', portId: 'in' }, sourceType: 'mono-video', targetType: 'video' }],
    );
    await expect(page.locator('[data-testid="bentbox-card"]')).toHaveCount(1);
    await exercise(page, 'bentbox-card', 'bentbox-canvas', 'bentbox-fs-wrap', 'bb');
    expect(errors).toEqual([]);
  });

  test('Full Frame and Fullscreen are mutually exclusive (entering Fullscreen exits Full Frame)', async ({ page }) => {
    // We drive the full-frame -> fullscreen direction here. The reverse
    // (fullscreen -> full-frame via the menu) can't be driven in a headless
    // browser because a true-fullscreen element's subtree is the only thing
    // rendered/interactable, so the body-portaled canvas menu isn't
    // reachable over an active OS-fullscreen overlay (the user exits
    // fullscreen via dblclick/Esc first). The code-level guarantee that
    // entering full-frame drops fullscreen is covered by the unit test
    // (use-full-frame.test.ts) — enter() calls fs.exit() before persisting.
    const errors = await setup(page);
    await spawnPatch(
      page,
      [
        { id: 'src', type: 'shapes', position: { x: 40, y: 40 }, domain: 'video', params: TRIANGLE_PARAMS },
        { id: 'out', type: 'videoOut', position: { x: 520, y: 40 }, domain: 'video' },
      ],
      [{ id: 'e1', from: { nodeId: 'src', portId: 'out' }, to: { nodeId: 'out', portId: 'in' }, sourceType: 'mono-video', targetType: 'video' }],
    );
    const card = page.locator('[data-testid="video-out-card"]');
    const wrap = page.locator('[data-testid="video-out-fs-wrap"]');
    const canvas = page.locator('canvas[data-testid="video-out-canvas"]');
    await expect(card).toHaveCount(1);
    await page.waitForTimeout(300);

    // Enter Full Frame first (in-rack, menu reachable).
    await canvas.click({ button: 'right' });
    await page.locator('[data-testid="ctx-full-frame"]').click();
    await expect(card, 'entered full-frame').toHaveClass(/full-frame/);

    // Now enter true Fullscreen. A card is never meant to be both at once —
    // entering Fullscreen on a full-frame card clears full-frame first, so
    // the card is left in a single clean state (.fullscreen, not also
    // .full-frame).
    await canvas.click({ button: 'right' });
    await page.locator('[data-testid="ctx-fullscreen"]').click();
    await expect(wrap, 'entered fullscreen').toHaveClass(/fullscreen/);
    await expect(card, 'full-frame cleared on fullscreen enter').not.toHaveClass(/full-frame/);
    expect(await readFullFrame(page, 'out'), 'fullFrame persisted false on fullscreen enter').toBe(false);

    // Exit fullscreen (dblclick on the wrap, like a video player).
    await wrap.dblclick();
    await page.evaluate(() => { if (document.fullscreenElement) void document.exitFullscreen(); });
    await expect(wrap, 'exited fullscreen').not.toHaveClass(/fullscreen/);

    expect(errors).toEqual([]);
  });
});
