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

// A small structured source so the feedback graph is a realistic 2-node patch.
const SRC_PARAMS = { shape: 0, tile: 0, zoom: 0.6 };

// ── COST: this spec asserts STATE, never PIXELS ──────────────────────────────
// Every case here reads the component state machine (classes, persisted
// node.data, menu entries) or layout geometry. Not one reads a pixel. So the
// live BACKDRAFT feedback render — a full software-rasterised feedback loop on
// CI's SwiftShader — was pure cost with no assertion behind it.
//
// It is not a small cost, and it is not paid where you would guess. It is paid
// PER PLAYWRIGHT ROUND TRIP: a pointer action is several main-thread round
// trips (actionability → the 2-frame stability check → hit test → dispatch),
// and each one queues behind the engine's rAF draw.
//
// MEASURED (dev server, E2E_SWIFTSHADER=1, idle 10-core box) with a BACKDRAFT
// card mounted — the negative control is the same page with the draw frozen:
//
//   live render    rAF interval 24.3 ms  (41 fps)  ← ~8 ms/frame of main thread
//   frozen render  rAF interval 16.0 ms  (62 fps)  ← pure vsync, no GL work
//
// On CI that tax dominates. From the shard-1 TRACE of run 30423306408 — the
// timeout this note exists for — every action in this test cost ~8 s and every
// page.evaluate ~2 s, UNIFORMLY, with no single wedge anywhere:
//
//   click canvas 7.9s │ click ctx-full-frame 9.2s │ click canvas 7.5s
//   click ctx-fullscreen 8.4s │ dblclick wrap 7.9s   = 41 s of a 60 s budget
//
// ⚠ The failing case was never slower for any reason OF ITS OWN. It has FIVE
// pointer actions; its siblings have three and landed at 55.7 s / 55.8 s — also
// at the edge. It simply had the most round trips to pay for, so it tipped
// first. Raising the ceiling would only move which case tips.
//
// AND IT IS NOT THE RUNNER. Median duration of a click STEP, per spec file, in
// that same shard-1 run — i.e. same runner, same 4 workers, same minute:
//
//   backdraft-full-output.spec.ts   7946 ms   ← this file
//   blood-keyboard.spec.ts           471 ms
//   cable-drag-section-expand.spec.ts 213 ms
//   aut-patch-panel.spec.ts          141 ms
//
// A 17-56x outlier against healthy neighbours. So "shard 1 is over budget" is
// the WRONG diagnosis — the shard is fine and every other spec on it clicks in
// milliseconds. What is slow is this PAGE, and specifically its rAF interval:
// Playwright paces actionability on rAF (the stability check wants two
// consecutive frames with an unchanged box), so a page rendering at ~1 fps
// makes every phase of every action cost ~1 s. The trace's internal log shows
// exactly that shape — ~1.5-1.9 s to go from "waiting for element to be
// visible, enabled and stable" to "element is visible, enabled and stable",
// which is two frames at ~0.8 s each.
//
// So: freeze the per-frame draw. `__videoEngineFreezeRender` is the existing
// lever the per-module-per-port sweeps use for exactly this — engine.ts
// documents it as "keep the graph fully consistent … but SKIP the expensive
// per-frame work", and it was introduced for this same timeout class on heavy
// cards (b3ntb0x, mandelbulb). The graph still builds, shaders still compile,
// FBOs still allocate, edges still reconcile, the canvas is still laid out and
// clickable — every assertion in this file observes exactly what it observed
// before. There is just no longer a software-rendered feedback loop competing
// with the input queue.
//
// ⚠ Do NOT add a pixel assertion to this spec without removing the freeze —
// and if you do, expect the timeouts back. Pixels are asserted where a live
// source already exists: backdraft.spec.ts and backdraft-pure-tv.spec.ts.
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
  // BEFORE goto: the flag has to be set before the app boots.
  await freezeVideoRender(page);
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');
  return errors;
}

/** Spawn SHAPES -> BACKDRAFT. The source makes this a realistic feedback patch;
 *  it costs nothing per frame with the draw frozen (measured: 16.0 ms rAF with
 *  the source vs 16.3 ms without — identical, both pure vsync). */
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
  // A BOUNDED-FAILURE cap, not a budget these cases spend. It was raised to 60s
  // while this spec still rendered a live feedback loop per frame, and that did
  // NOT fix the "Full Frame ↔ Full Screen" timeout — the case simply came back
  // at 64.8s instead of 34.8s, because a uniform per-round-trip tax scales with
  // the ceiling rather than fitting under it. The draw is frozen now (see the
  // COST note above), so there is no per-frame GL work left to contend for the
  // runner. Kept generous anyway: a timeout here should report a HANG, not a
  // slow runner.
  test.describe.configure({ timeout: 60_000 });

  test('right-click the preview opens the menu with Full Frame + Full Screen (Present hidden on single screen)', async ({ page }) => {
    const errors = await setup(page);
    await spawnBackdraft(page);

    const canvas = page.locator('canvas[data-testid="backdraft-canvas"]');
    await expect(canvas, 'preview canvas present').toHaveCount(1);

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
