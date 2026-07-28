// e2e/tests/backdraft-full-output.spec.ts
//
// BACKDRAFT "full output capabilities" — Full Frame / Full Screen /
// Present-on-other-display, the same surface VIDEO OUT + BENTBOX ship, wired
// onto the BACKDRAFT card via the shared helpers (use-fullscreen /
// use-full-frame / use-present / VideoCanvasContextMenu).
//
// ── WHAT CHANGED WHEN THE PREVIEW WAS REMOVED ───────────────────────────────
// BACKDRAFT's card is now a control surface with no in-rack video thumbnail.
// These features did NOT go with it — they are performance features, not
// preview decoration — but two things about this spec did:
//
//   * ENTRY POINT: the menu used to open on a RIGHT-CLICK on the preview. With
//     no preview to right-click it opens from an explicit OUTPUT button
//     ([data-testid="backdraft-output-menu"]). Every case below drives that.
//   * CORNER-RESIZE: RETIRED, not ported. The corner-drag existed to scale the
//     preview canvas; with the preview gone the card is a fixed 5hp×2u rack
//     tier (rack-sizes.ts) and there is nothing to drag. The resize helper
//     itself (card-resize.ts) is still covered by bentbox.spec.ts + the
//     videoOut resize case in workflow-shell-video.spec.ts.
//
// The output <canvas> is still in the DOM but INERT in the rack (1px,
// invisible, not drawn); it becomes the live surface in each expanded mode.
// So these cases assert COMPONENT STATE + the surface's expanded classes, not
// in-rack pixels.
//
// Mirrors video-fullscreen.spec.ts + video-full-frame.spec.ts + present-second-
// display.spec.ts, scoped to BACKDRAFT.
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

// ── COST ────────────────────────────────────────────────────────────────────
// Every case here asserts the COMPONENT STATE MACHINE (classes, persisted
// node.data, menu items) — not a single pixel. So this spec does no GL work at
// all: it freezes the per-frame video draw (the same __videoEngineFreezeRender
// lever card-control-overflow uses) and spawns BACKDRAFT SOLO with no upstream
// source. The old version fed it from SHAPES and slept 300ms per case purely
// so the in-card PREVIEW had live content to look at — and nothing ever looked.
// On CI's SwiftShader renderer that source + those sleeps were the whole cost.
async function freezeVideoRender(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (globalThis as unknown as { __videoEngineFreezeRender?: boolean })
      .__videoEngineFreezeRender = true;
  });
}

async function setup(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await freezeVideoRender(page);
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');
  return errors;
}

/** Spawn BACKDRAFT solo — no source needed (see the COST note above). */
async function spawnBackdraft(page: Page): Promise<void> {
  await spawnPatch(
    page,
    [{ id: 'bd', type: 'backdraft', position: { x: 200, y: 60 }, domain: 'video' }],
    [],
  );
  await expect(page.locator('[data-testid="backdraft-card"]')).toHaveCount(1);
}

/** Open the card's OUTPUT menu — the entry point that replaced right-clicking
 *  the (now removed) preview. Waits for the button rather than the surface,
 *  because the surface is invisible until an expanded mode is entered. */
async function openOutputMenu(page: Page): Promise<void> {
  const btn = page.locator('[data-testid="backdraft-output-menu"]');
  await expect(btn, 'OUTPUT button present on the card').toBeVisible();
  await btn.click();
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
  // The 60s ceiling is a BOUNDED-FAILURE cap, not a budget these cases use.
  // It was added when this spec was a heavy-WebGL one: the live preview canvas
  // plus the requestFullscreen / full-frame transitions spiked past the default
  // 30s under SwiftShader, and the "Full Frame ↔ Full Screen" case became a
  // chronic shard-1 TIMEOUT. The preview is gone and the draw is frozen (see
  // the COST note above), so there is no per-frame GL work left to contend for
  // the runner. Kept generous anyway — a timeout should report a hang, not a
  // slow runner.
  test.describe.configure({ timeout: 60_000 });

  test('the OUTPUT button opens the menu with Full Frame + Full Screen (Present hidden on single screen)', async ({ page }) => {
    const errors = await setup(page);
    await spawnBackdraft(page);

    // The output surface exists but is INERT in the rack — present in the DOM
    // (requestFullscreen needs a real element to target) and not visible.
    const canvas = page.locator('canvas[data-testid="backdraft-canvas"]');
    await expect(canvas, 'output surface present in the DOM').toHaveCount(1);
    await expect(canvas, 'output surface is NOT an in-rack preview').toBeHidden();

    await openOutputMenu(page);
    const menu = page.locator('[data-testid="video-canvas-context-menu"]');
    await expect(menu, 'output menu opened').toBeVisible();

    // Full Screen + Full Frame are always offered.
    await expect(page.locator('[data-testid="ctx-fullscreen"]'), 'Full Screen item present').toBeVisible();
    await expect(page.locator('[data-testid="ctx-full-frame"]'), 'Full Frame item present').toBeVisible();

    // Present is capability-gated: on a single screen / no Window Management API
    // (the CI default) there is NO "Present on …" entry.
    await expect(page.locator('[data-testid^="ctx-present-"]'), 'no Present entry on single screen').toHaveCount(0);

    // The button click is CLAIMED — the SvelteFlow node menu must NOT also open.
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

    // Enter Full Frame via the OUTPUT menu.
    await openOutputMenu(page);
    await expect(page.locator('[data-testid="video-canvas-context-menu"]')).toBeVisible();
    await page.locator('[data-testid="ctx-full-frame"]').click();

    // Card gains .full-frame + the data attribute flips true + it persists.
    await expect(card, 'card entered full-frame').toHaveClass(/full-frame/);
    await expect(card).toHaveAttribute('data-full-frame', 'true');
    await expect(wrap, 'wrap gained full-frame').toHaveClass(/full-frame/);
    expect(await readFullFrame(page, 'bd'), 'fullFrame persisted true').toBe(true);

    // The point of full-frame: the CONTROLS are gone and the video surface —
    // inert a moment ago — is now the visible card.
    await expect(canvas, 'output surface is now showing').toBeVisible();
    await expect(
      card.locator('[data-testid="backdraft-controls"]'),
      'controls hidden while full-frame',
    ).toBeHidden();

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
    const wrap = page.locator('[data-testid="backdraft-fs-wrap"]');

    // Enter Full Frame first (in-rack, menu reachable).
    await openOutputMenu(page);
    await page.locator('[data-testid="ctx-full-frame"]').click();
    await expect(card, 'entered full-frame').toHaveClass(/full-frame/);

    // Now enter Full Screen — the card must clear full-frame first (mutual
    // exclusion), leaving a single clean .fullscreen state. The OUTPUT button
    // is hidden while full-frame (the chrome is gone), so exit via the
    // documented double-click first, exactly as a user would.
    await card.dblclick();
    await expect(card, 'exited full-frame').not.toHaveClass(/full-frame/);
    await openOutputMenu(page);
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

    await openOutputMenu(page);
    await expect(page.locator('[data-testid="video-canvas-context-menu"]')).toBeVisible();

    // "Present on …" appears only for the NON-current (secondary) display.
    const presentSec = page.locator('[data-testid="ctx-present-display-1"]');
    await expect(presentSec, 'Present-on-secondary entry shown').toBeVisible();
    await expect(presentSec).toHaveText(/Present on DELL U2720Q/);
    // Never offer presenting on THIS (primary) display.
    await expect(page.locator('[data-testid="ctx-present-primary"]'), 'no present-on-primary').toHaveCount(0);

    expect(errors).toEqual([]);
  });

  // RETIRED: 'corner-resize grows the card + persists node.data.width/height'.
  // The corner-drag existed to scale the in-card preview canvas. With the
  // preview removed the card is a FIXED 5hp×2u rack tier (rack-sizes.ts) and
  // there is no handle to drag and no node.data.width/height to persist —
  // rack-sizing.test.ts pins the tier and card-control-ranges.test.ts pins that
  // the card no longer reads a persisted size. card-resize.ts itself keeps its
  // coverage on the cards that still use it (bentbox.spec.ts, and the videoOut
  // resize case in workflow-shell-video.spec.ts).
});
