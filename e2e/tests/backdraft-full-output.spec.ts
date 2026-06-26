// e2e/tests/backdraft-full-output.spec.ts
//
// BACKDRAFT "full output capabilities" — the same resize + Full Frame / Full
// Screen / Present-on-other-display surface VIDEO OUT + BENTBOX ship, now wired
// onto the BACKDRAFT card via the shared helpers (card-resize / use-fullscreen /
// use-full-frame / use-present / VideoCanvasContextMenu).
//
// Mirrors video-fullscreen.spec.ts + video-full-frame.spec.ts + present-second-
// display.spec.ts + bentbox.spec.ts's resize test, scoped to BACKDRAFT.
//
// Assertion strategy notes (carried from the sibling specs):
//   * Fullscreen: requestFullscreen() needs a user-gesture; the menu click IS
//     one + chromium grants it headless, but we treat the COMPONENT STATE
//     MACHINE (`.fullscreen` class on the wrap) as the source of truth so the
//     test is robust whether or not the runner actually entered OS fullscreen.
//   * Present: real multi-monitor / the Window Management API can't run in
//     headless CI, so we inject a fake getScreenDetails. On a single screen the
//     menu must NOT offer "Present on …" (capability-gated off, the CI default).

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

// A small structured source so the preview has live, non-black content.
const SRC_PARAMS = { shape: 0, tile: 0, zoom: 0.6 };

async function setup(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  return errors;
}

/** Spawn SHAPES -> BACKDRAFT so the preview canvas has live content. */
async function spawnBackdraft(page: Page): Promise<void> {
  await spawnPatch(
    page,
    [
      { id: 'src', type: 'shapes', position: { x: 40, y: 40 }, domain: 'video', params: SRC_PARAMS },
      { id: 'bd', type: 'backdraft', position: { x: 460, y: 40 }, domain: 'video', params: { feedback: 1.0, delay: 16 } },
    ],
    [{ id: 'e1', from: { nodeId: 'src', portId: 'out' }, to: { nodeId: 'bd', portId: 'in_a' }, sourceType: 'mono-video', targetType: 'video' }],
  );
  await expect(page.locator('[data-testid="backdraft-card"]')).toHaveCount(1);
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

/** Read node.data.width/height off the dev-mode __patch global. */
async function readSize(page: Page, nodeId: string): Promise<{ width?: unknown; height?: unknown }> {
  return page.evaluate((id) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: { width?: unknown; height?: unknown } }> };
    };
    const d = w.__patch.nodes[id]?.data;
    return { width: d?.width, height: d?.height };
  }, nodeId);
}

/** Inject a fake Window Management API returning `screens` (single-screen by
 *  default in CI; multi here to assert the "Present on …" gating). */
async function injectScreens(
  page: Page,
  screens: Array<{ label: string; isPrimary: boolean }>,
): Promise<void> {
  await page.addInitScript((screensArg) => {
    const fakeScreens = screensArg.map((s) => ({
      label: s.label,
      isPrimary: s.isPrimary,
      availLeft: 0,
      availTop: 0,
      availWidth: 1920,
      availHeight: 1080,
    }));
    const details: EventTarget & { screens: unknown[]; currentScreen: unknown } =
      Object.assign(new EventTarget(), {
        screens: fakeScreens,
        currentScreen: fakeScreens[0],
      });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).getScreenDetails = () => Promise.resolve(details);
  }, screens);
}

test.describe('BACKDRAFT — full output capabilities', () => {
  // Heavy WebGL + fullscreen video spec: the BACKDRAFT preview canvas plus the
  // requestFullscreen / full-frame transitions run slowly under CI's SwiftShader
  // software renderer and occasionally spike past the default 30s — a chronic
  // shard-1 TIMEOUT flake (notably the "Full Frame ↔ Full Screen mutually
  // exclusive" case). Give the whole spec headroom; it still completes in
  // ~15-25s on a real GPU, so this adds ~0 typical wall-time and only un-caps
  // the slow-runner tail (the documented video-on-SwiftShader mitigation).
  test.describe.configure({ timeout: 60_000 });

  test('right-click the preview opens the menu with Full Frame + Full Screen (Present hidden on single screen)', async ({ page }) => {
    const errors = await setup(page);
    await spawnBackdraft(page);

    const canvas = page.locator('canvas[data-testid="backdraft-canvas"]');
    await expect(canvas, 'preview canvas present').toHaveCount(1);
    // Let the rAF blit tick so the preview has live content.
    await page.waitForTimeout(300);

    // Right-click the preview surface -> the canvas context menu (NOT the node menu).
    await canvas.click({ button: 'right' });
    const menu = page.locator('[data-testid="video-canvas-context-menu"]');
    await expect(menu, 'canvas context menu opened').toBeVisible();

    // Full Screen + Full Frame are always offered.
    await expect(page.locator('[data-testid="ctx-fullscreen"]'), 'Full Screen item present').toBeVisible();
    await expect(page.locator('[data-testid="ctx-full-frame"]'), 'Full Frame item present').toBeVisible();

    // Present is capability-gated: on a single screen / no Window Management API
    // (the CI default) there is NO "Present on …" entry.
    await expect(page.locator('[data-testid^="ctx-present-"]'), 'no Present entry on single screen').toHaveCount(0);

    // The canvas right-click is CLAIMED — the SvelteFlow node menu must NOT also
    // open (same contract as VIDEO OUT).
    const nodeMenu = page.locator('[role="menu"][aria-label="Module actions"]');
    await expect(nodeMenu, 'node menu did not also open').toHaveCount(0);

    expect(errors).toEqual([]);
  });

  test('Full Frame toggles node.data.fullFrame + hides chrome; double-click exits', async ({ page }) => {
    const errors = await setup(page);
    await spawnBackdraft(page);

    const card = page.locator('[data-testid="backdraft-card"]');
    const canvas = page.locator('canvas[data-testid="backdraft-canvas"]');
    const wrap = page.locator('[data-testid="backdraft-fs-wrap"]');
    await page.waitForTimeout(300);

    // Enter Full Frame via the menu.
    await canvas.click({ button: 'right' });
    await expect(page.locator('[data-testid="video-canvas-context-menu"]')).toBeVisible();
    await page.locator('[data-testid="ctx-full-frame"]').click();

    // Card gains .full-frame + the data attribute flips true + it persists.
    await expect(card, 'card entered full-frame').toHaveClass(/full-frame/);
    await expect(card).toHaveAttribute('data-full-frame', 'true');
    await expect(wrap, 'wrap gained full-frame').toHaveClass(/full-frame/);
    expect(await readFullFrame(page, 'bd'), 'fullFrame persisted true').toBe(true);

    // The card's own Svelte Flow handles are visually hidden but still in the
    // DOM (cables stay connected — we hide, not remove).
    const handles = card.locator('.svelte-flow__handle');
    expect(await handles.count(), 'handles still in DOM while full-frame').toBeGreaterThan(0);
    await expect(handles.first()).toHaveCSS('opacity', '0');
    await expect(handles.first()).toHaveCSS('pointer-events', 'none');

    // Double-click the card exits back to normal chrome.
    await card.dblclick();
    await expect(card, 'card exited full-frame').not.toHaveClass(/full-frame/);
    await expect(card).toHaveAttribute('data-full-frame', 'false');
    expect(await readFullFrame(page, 'bd'), 'fullFrame persisted false').toBe(false);

    expect(errors).toEqual([]);
  });

  test('Full Screen enters the .fullscreen state; double-click exits (Full Frame ↔ Full Screen mutually exclusive)', async ({ page }) => {
    const errors = await setup(page);
    await spawnBackdraft(page);

    const card = page.locator('[data-testid="backdraft-card"]');
    const canvas = page.locator('canvas[data-testid="backdraft-canvas"]');
    const wrap = page.locator('[data-testid="backdraft-fs-wrap"]');
    await page.waitForTimeout(300);

    // Enter Full Frame first (in-rack, menu reachable).
    await canvas.click({ button: 'right' });
    await page.locator('[data-testid="ctx-full-frame"]').click();
    await expect(card, 'entered full-frame').toHaveClass(/full-frame/);

    // Now enter Full Screen — the card must clear full-frame first (mutual
    // exclusion), leaving a single clean .fullscreen state.
    await canvas.click({ button: 'right' });
    await page.locator('[data-testid="ctx-fullscreen"]').click();
    await expect(wrap, 'wrap entered fullscreen state').toHaveClass(/fullscreen/);
    await expect(card, 'full-frame cleared on fullscreen enter').not.toHaveClass(/full-frame/);
    expect(await readFullFrame(page, 'bd'), 'fullFrame false after fullscreen enter').toBe(false);

    // Best-effort: report whether real OS fullscreen engaged.
    const realFs = await page.evaluate(() => document.fullscreenElement !== null);
    console.log(`[fullscreen] backdraft document.fullscreenElement set: ${realFs}`);

    // Double-click exits fullscreen (then force-exit defensively).
    await wrap.dblclick();
    await page.evaluate(() => { if (document.fullscreenElement) void document.exitFullscreen(); });
    await expect(wrap, 'wrap exited fullscreen state').not.toHaveClass(/fullscreen/);
    expect(await page.evaluate(() => document.fullscreenElement), 'fullscreenElement cleared').toBeNull();

    expect(errors).toEqual([]);
  });

  test('two screens -> "Present on <secondary>" entry appears (capability-gated on)', async ({ page }) => {
    await injectScreens(page, [
      { label: 'Built-in Retina', isPrimary: true },
      { label: 'DELL U2720Q', isPrimary: false },
    ]);
    const errors = await setup(page);
    await spawnBackdraft(page);
    await page.waitForTimeout(300);

    const canvas = page.locator('canvas[data-testid="backdraft-canvas"]');
    await canvas.click({ button: 'right' });
    await expect(page.locator('[data-testid="video-canvas-context-menu"]')).toBeVisible();

    // "Present on …" appears only for the NON-current (secondary) display.
    const presentSec = page.locator('[data-testid="ctx-present-display-1"]');
    await expect(presentSec, 'Present-on-secondary entry shown').toBeVisible();
    await expect(presentSec).toHaveText(/Present on DELL U2720Q/);
    // Never offer presenting on THIS (primary) display.
    await expect(page.locator('[data-testid="ctx-present-primary"]'), 'no present-on-primary').toHaveCount(0);

    expect(errors).toEqual([]);
  });

  test('corner-resize grows the card + persists node.data.width/height', async ({ page }) => {
    // Spawn BACKDRAFT ALONE (like the bentbox resize test) so spawnPatch's
    // fit-view doesn't zoom the card down — keeping a 1:1 screen drag and
    // making the measured growth assertion robust.
    const errors = await setup(page);
    await spawnPatch(page, [
      { id: 'bd', type: 'backdraft', position: { x: 200, y: 100 }, domain: 'video' },
    ]);
    await expect(page.locator('[data-testid="backdraft-card"]')).toHaveCount(1);

    const card = page.locator('[data-testid="backdraft-card"]');
    const handle = page.locator('[data-testid="backdraft-resize-handle"]');
    await expect(handle, 'resize handle present').toHaveCount(1);

    // node.data has NO width/height before the first resize (the card uses its
    // DEFAULT constants until the user drags).
    const sizeBefore = await readSize(page, 'bd');
    expect(sizeBefore.width, 'no persisted width before resize').toBeUndefined();

    const initial = await card.evaluate((el) => (el as HTMLElement).getBoundingClientRect());
    const box = await handle.boundingBox();
    expect(box).not.toBeNull();
    if (!box) return;

    const sx = box.x + box.width / 2;
    const sy = box.y + box.height / 2;
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(sx + 120, sy + 100, { steps: 5 });
    await page.mouse.move(sx + 240, sy + 200, { steps: 5 });
    await page.mouse.up();

    // The style width/height is driven by node.data.width/height after onMove
    // writes through — poll the measured width until the resize commits.
    await expect.poll(
      () => card.evaluate((el) => (el as HTMLElement).getBoundingClientRect().width),
      'card width grew after the resize drag',
    ).toBeGreaterThan(initial.width + 20);

    const after = await card.evaluate((el) => (el as HTMLElement).getBoundingClientRect());
    expect(after.width, `card grew horizontally (${initial.width} -> ${after.width})`)
      .toBeGreaterThan(initial.width + 20);
    expect(after.height, `card grew vertically (${initial.height} -> ${after.height})`)
      .toBeGreaterThan(initial.height + 20);

    // The new size is persisted on node.data (Y.Doc-synced) + grew past the
    // 720×540 default.
    const size = await readSize(page, 'bd');
    expect(typeof size.width, 'node.data.width persisted').toBe('number');
    expect(typeof size.height, 'node.data.height persisted').toBe('number');
    expect(size.width as number, 'persisted width grew past the default').toBeGreaterThan(720);
    expect(size.height as number, 'persisted height grew past the default').toBeGreaterThan(540);

    expect(errors).toEqual([]);
  });
});
