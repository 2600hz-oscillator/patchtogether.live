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
import { BOOT_MS, SLOW_BOOT_TEST_TIMEOUT_MS } from '../_helpers/boot-budget';
import { waitFrames } from '../_helpers/frames';

const TRIANGLE_PARAMS = { shape: 2, tile: 0, rotate: 0, zoom: 2.2 };

/** Open a video module's dock full-view pane (the output body is
 *  `fullViewBody`, dock-only) and return the PANE locator. */
async function openPane(page: Page, id: string, bodyTestId: string) {
  await page.waitForFunction(
    () =>
      typeof (globalThis as unknown as { __openDockFullView?: unknown }).__openDockFullView ===
      'function',
    undefined,
    { timeout: 30_000 },
  );
  await page.evaluate(
    (i) => (globalThis as unknown as { __openDockFullView: (x: string) => void }).__openDockFullView(i),
    id,
  );
  const pane = page.locator(`[data-testid="dock-fullview-pane"][data-pane-node="${id}"]`);
  await expect(pane.getByTestId(bodyTestId)).toBeVisible({ timeout: 60_000 });
  return pane;
}

async function setup(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto('/rack?seed=none');
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
    // The output body (`videoout-face-output`, `fullViewBody`) carries the
    // whole mode: right-click the face picture → Full Frame; the body root
    // gains `.full-frame` and the SAME `node.data.fullFrame` key persists.
    // (The card's handles-hidden chrome died with the card — the lane tile's
    // handles are untouched by a dock mode.)
    const pane = await openPane(page, 'out', 'videoout-face-output');
    const body = pane.getByTestId('videoout-face-output');
    const canvas = pane.locator('canvas[data-testid="videoout-face-canvas"]');
    await waitFrames(page, 4); // let the rAF blit tick (frames, not ms)
    await canvas.click({ button: 'right' });
    await expect(page.locator('[data-testid="video-canvas-context-menu"]')).toBeVisible();
    await page.locator('[data-testid="ctx-full-frame"]').click();
    await expect(body, 'body entered full-frame').toHaveClass(/full-frame/);
    expect(await readFullFrame(page, 'out'), 'fullFrame persisted true').toBe(true);
    await body.dblclick();
    await expect(body, 'body exited full-frame').not.toHaveClass(/full-frame/);
    expect(await readFullFrame(page, 'out'), 'fullFrame persisted false').toBe(false);
    expect(errors).toEqual([]);
  });

  // (The VIDEOBOX legacy-card leg is gone: post-promotion the face body is
  // videobox's ONLY surface, and the default-shell leg below — added by the
  // wave-3 promotion as the face's own evidence — already drives the same
  // gesture on the same shared `node.data.fullFrame` key. Two tests of one
  // surface would be a duplicate, not coverage.)

  test('VIDEOBOX on the DEFAULT shell: the FACE body enters Full Frame on the SAME node.data.fullFrame key', async ({ page }) => {
    // ⚠ THE LEG THE WAVE-3 PROMOTION OWES. The leg above was written against
    // the PRE-PROMOTION surface, which is precisely the one promotion does NOT
    // change — a green spec there is never evidence about a face.
    // This leg drives the ModuleShell dock body and reads the flag back off
    // the SAME `readFullFrame` helper (i.e. the same `node.data.fullFrame`
    // key), so the two surfaces cannot quietly fork the persistence: a body
    // writing `data.faceFullFrame` would pass its own DOM assertions and fail
    // HERE, on the shared key.
    //
    // Bounded from the ONE export site: on the default shell the dock body is
    // a LAZY chunk that cannot start loading until the dock opens, so this leg
    // serialises a mount the legacy leg overlapped with page load.
    test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    await page.goto('/rack?seed=none');
    await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: BOOT_MS });
    await spawnPatch(page, [
      { id: 'vbf', type: 'videobox', position: { x: 200, y: 60 }, domain: 'video' },
    ]);

    // The promotion's precondition: no card anywhere on the default shell.
    await expect(page.locator('[data-testid="videobox-card"]')).toHaveCount(0);

    // Open the dock faceplate (auto-retrying — the tile button is
    // hit-testable while a previous pane is still tearing down).
    const shell = page.locator('.svelte-flow__node[data-id="vbf"] [data-testid="module-shell"]');
    await expect(shell).toBeVisible({ timeout: BOOT_MS });
    const dockShell = page
      .getByTestId('dock-full-view')
      .locator('[data-testid="module-shell"][data-shell-tier="dock"][data-shell-node="vbf"]');
    await expect(async () => {
      if (await dockShell.count() === 0) {
        await shell.getByTestId('shell-open-dock').click();
      }
      await expect(dockShell).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });

    const body = dockShell.locator('[data-testid="videobox-face-body"]');
    await expect(body).toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
    const wrap = body.locator('[data-testid="videobox-face-wrap"]');
    await expect(wrap).toBeVisible();

    // Right-click the picture -> canvas menu -> Full Frame.
    await wrap.click({ button: 'right' });
    await expect(page.locator('[data-testid="video-canvas-context-menu"]')).toBeVisible();
    await page.locator('[data-testid="ctx-full-frame"]').click();

    await expect(body).toHaveAttribute('data-full-frame', 'true');
    await expect(wrap, 'wrap gained full-frame').toHaveClass(/full-frame/);
    // The chrome is hidden — the surface shows only video (+ its overlays).
    await expect(body.locator('[data-testid="videobox-play-btn"]')).toBeHidden();
    await expect(body.locator('[data-testid="videobox-seek"]')).toBeHidden();
    // Persisted on the SAME key the legacy card reads.
    expect(await readFullFrame(page, 'vbf'), 'fullFrame persisted true (shared key)').toBe(true);

    // Double-click exits.
    await body.dblclick();
    await expect(body).toHaveAttribute('data-full-frame', 'false');
    await expect(body.locator('[data-testid="videobox-play-btn"]')).toBeVisible();
    expect(await readFullFrame(page, 'vbf'), 'fullFrame persisted false (shared key)').toBe(false);

    expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
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
    // Bentbox's body paints NO full-frame class and its face canvas is a
    // fixed 480×360 buffer — the mode's face observables are the SAME
    // persisted `node.data.fullFrame` key and the shared menu's own state
    // word ('Exit Full Frame' while active — `isFullFrame` reaches the item
    // label). Assert those, and the dblclick exit.
    const pane = await openPane(page, 'bb', 'bentbox-output-body');
    const body = pane.getByTestId('bentbox-output-body');
    const canvas = pane.locator('canvas[data-testid="bentbox-face-canvas"]');
    await waitFrames(page, 4);
    await canvas.click({ button: 'right' });
    await expect(page.locator('[data-testid="video-canvas-context-menu"]')).toBeVisible();
    const ffItem = page.locator('[data-testid="ctx-full-frame"]');
    await expect(ffItem).toHaveText('Full Frame');
    await ffItem.click();
    expect(await readFullFrame(page, 'bb'), 'fullFrame persisted true').toBe(true);
    // Re-open the menu: the item now reads the ACTIVE state.
    await canvas.click({ button: 'right' });
    await expect(ffItem, 'menu reflects the active mode').toHaveText('Exit Full Frame');
    // Close the menu by toggling THROUGH it (never Escape — dock hazard):
    // clicking the item exits full-frame too, which doubles as the exit path
    // check alongside the documented dblclick gesture below.
    await ffItem.click();
    expect(await readFullFrame(page, 'bb'), 'fullFrame persisted false via the menu exit').toBe(false);
    // And the dblclick gesture: enter once more, exit by double-click.
    await canvas.click({ button: 'right' });
    await ffItem.click();
    expect(await readFullFrame(page, 'bb'), 'fullFrame re-entered').toBe(true);
    await body.dblclick();
    await expect
      .poll(() => readFullFrame(page, 'bb'), { message: 'dblclick exits full-frame' })
      .toBe(false);
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
    const pane = await openPane(page, 'out', 'videoout-face-output');
    const body = pane.getByTestId('videoout-face-output');
    const wrap = pane.locator('[data-testid="videoout-fs-wrap"]');
    const canvas = pane.locator('canvas[data-testid="videoout-face-canvas"]');
    await waitFrames(page, 4); // frames, not ms

    // Enter Full Frame first (menu reachable at rest).
    await canvas.click({ button: 'right' });
    await page.locator('[data-testid="ctx-full-frame"]').click();
    await expect(body, 'entered full-frame').toHaveClass(/full-frame/);

    // Now enter true Fullscreen. A surface is never meant to be both at once —
    // entering Fullscreen on a full-frame body clears full-frame first, so it
    // is left in a single clean state (.fullscreen, not also .full-frame).
    await canvas.click({ button: 'right' });
    await page.locator('[data-testid="ctx-fullscreen"]').click();
    await expect(wrap, 'entered fullscreen').toHaveClass(/fullscreen/);
    await expect(body, 'full-frame cleared on fullscreen enter').not.toHaveClass(/full-frame/);
    expect(await readFullFrame(page, 'out'), 'fullFrame persisted false on fullscreen enter').toBe(false);

    // Exit fullscreen (dblclick on the wrap, like a video player).
    await wrap.dblclick();
    await page.evaluate(() => { if (document.fullscreenElement) void document.exitFullscreen(); });
    await expect(wrap, 'exited fullscreen').not.toHaveClass(/fullscreen/);

    expect(errors).toEqual([]);
  });
});
