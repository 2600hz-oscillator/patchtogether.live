// e2e/tests/backdraft-full-output.spec.ts
//
// BACKDRAFT "full output capabilities" — Full Frame / Full Screen /
// Present-on-other-display, the same surface VIDEO OUT + BENTBOX ship, wired
// onto the BACKDRAFT card via the shared helpers (use-fullscreen /
// use-full-frame / use-present / VideoCanvasContextMenu).
//
// ── ONE SURFACE, FOUR SIZES ─────────────────────────────────────────────────
// BACKDRAFT's card carries a SMALL 320×240 display, centred in a band across
// the top of a 6hp×3u card. That display is not decoration bolted next to the
// output features — it IS the output surface, at its in-rack size:
//
//     in the rack   320×240, centred under the title
//     Full Frame    the whole card (chrome hidden, dbl-click exits)
//     Full Screen   the physical screen (requestFullscreen on the wrap)
//     Present       blitted into a popup on a second display
//
// So the picture you patch is the picture you present, and there is no second
// canvas that could drift from the first.
//
// TWO ENTRY POINTS to the menu, and they are not redundant:
//
//   * ⛶ OUTPUT button ([data-testid="backdraft-output-menu"]) — DISCOVERABLE.
//     The pre-declutter card only had the right-click, which nobody finds.
//   * RIGHT-CLICK on the display — the idiom VIDEO OUT and BENTBOX use. It was
//     unavailable while the card had no picture to right-click; it is back, and
//     it has its own case below (including that it does NOT also open
//     SvelteFlow's node menu).
//
// CORNER-RESIZE stays RETIRED. The card is a fixed 6hp×3u rack tier
// (rack-sizes.ts); 3u is pinned min AND max in _module-card.css, so a resize
// handle would fight the tier and resurrect node.data.width/height as a
// competing truth. The resize helper itself (card-resize.ts) is still covered
// by bentbox.spec.ts + the videoOut resize case in workflow-shell-video.spec.ts.
//
// These cases assert COMPONENT STATE + LAYOUT GEOMETRY (boundingBox), never
// in-rack pixels — see the COST note below for why that distinction is load-
// bearing on the SwiftShader shard.
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
//
// THE CARD'S DISPLAY DOES NOT CHANGE ANY OF THIS. BACKDRAFT now carries a
// 320×240 in-rack display, i.e. exactly the per-frame GL readback this note is
// about — but the card's in-rack blit is itself gated on
// __videoEngineFreezeRender / __videoEnginePause. A frozen engine has no new
// frame to present, so the card presents nothing and this spec pays what it
// paid with no display at all. The card ALSO rations that blit to ~8fps
// wall-clock and skips it entirely when engine.framesDrawnFor() has not
// advanced, which attacks the same rAF-interval tax measured above at the
// SOURCE rather than per-spec — see the tick() note in BackdraftCard.svelte.
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

    // THE DISPLAY. One surface, four sizes — in the rack it is a SMALL, centred
    // 320×240 picture. Visibility alone would be a weak assertion here: the
    // requirement is a display that is *smaller* than the pre-declutter preview
    // (~380×285 on a 720px card), so assert the BOX, not just that something is
    // on screen. This is a layout read, not a pixel read — no GL work.
    const canvas = page.locator('canvas[data-testid="backdraft-canvas"]');
    await expect(canvas, 'the display is present in the DOM').toHaveCount(1);
    await expect(canvas, 'the display is SHOWING in the rack').toBeVisible();
    const wrapBox = await page.locator('[data-testid="backdraft-fs-wrap"]').boundingBox();
    expect(wrapBox, 'display box measurable').not.toBeNull();
    // The node is under xyflow's zoom transform, so normalise to CSS px the way
    // card-control-overflow does — offsetWidth is layout px and immune to
    // ancestor transforms, so their ratio IS the effective scale.
    const scale = await page.locator('[data-testid="backdraft-card"]').evaluate(
      (el) => (el as HTMLElement).getBoundingClientRect().width / (el as HTMLElement).offsetWidth,
    );
    const cssW = wrapBox!.width / scale;
    const cssH = wrapBox!.height / scale;
    expect(cssW, `display width ${cssW.toFixed(1)} CSS px (want 320)`).toBeGreaterThan(316);
    expect(cssW, `display width ${cssW.toFixed(1)} CSS px (want 320)`).toBeLessThan(324);
    expect(cssH, `display height ${cssH.toFixed(1)} CSS px (want 240)`).toBeGreaterThan(236);
    expect(cssH, `display height ${cssH.toFixed(1)} CSS px (want 240)`).toBeLessThan(244);
    // …and CENTRED on the card. The flanks are `flex: 1 1 0`, so this is true by
    // construction — which is exactly why it is cheap to pin.
    const cardBox = await page.locator('[data-testid="backdraft-card"]').boundingBox();
    const cardMid = cardBox!.x + cardBox!.width / 2;
    const dispMid = wrapBox!.x + wrapBox!.width / 2;
    expect(
      Math.abs(dispMid - cardMid) / scale,
      `display is centred on the card (card mid ${cardMid.toFixed(1)}, display mid ${dispMid.toFixed(1)})`,
    ).toBeLessThan(2);

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

  test('right-clicking the display opens the SAME output menu', async ({ page }) => {
    const errors = await setup(page);
    await spawnBackdraft(page);

    // The SECOND entry point, restored with the display: right-click the
    // picture — the idiom VIDEO OUT and BENTBOX already use. It was unavailable
    // while the card had no picture to right-click; the ⛶ OUTPUT button remains
    // the discoverable half of the pair.
    await page.locator('[data-testid="backdraft-fs-wrap"]').click({ button: 'right' });

    await expect(
      page.locator('[data-testid="video-canvas-context-menu"]'),
      'right-click on the display opened the output menu',
    ).toBeVisible();
    await expect(page.locator('[data-testid="ctx-full-frame"]'), 'Full Frame item present').toBeVisible();
    await expect(page.locator('[data-testid="ctx-fullscreen"]'), 'Full Screen item present').toBeVisible();

    // The gesture is CLAIMED (preventDefault + stopPropagation), so SvelteFlow's
    // own node menu must NOT also open. Without the stopPropagation both menus
    // stack, which is the bug this assertion exists to catch.
    await expect(
      page.locator('[role="menu"][aria-label="Module actions"]'),
      'the SvelteFlow node menu did NOT also open',
    ).toHaveCount(0);

    expect(errors).toEqual([]);
  });

  test('Full Frame toggles node.data.fullFrame + hides chrome; double-click exits', async ({ page }) => {
    const errors = await setup(page);
    await spawnBackdraft(page);

    const card = page.locator('[data-testid="backdraft-card"]');
    const canvas = page.locator('canvas[data-testid="backdraft-canvas"]');
    const wrap = page.locator('[data-testid="backdraft-fs-wrap"]');

    // Measure the IN-RACK display first, so the transition below can be
    // asserted as GROWTH. "is visible" is vacuous now that the display is
    // always visible — it would pass with full-frame completely broken.
    const beforeBox = await wrap.boundingBox();
    expect(beforeBox, 'in-rack display measurable').not.toBeNull();

    // Enter Full Frame via the OUTPUT menu.
    await openOutputMenu(page);
    await expect(page.locator('[data-testid="video-canvas-context-menu"]')).toBeVisible();
    await page.locator('[data-testid="ctx-full-frame"]').click();

    // Card gains .full-frame + the data attribute flips true + it persists.
    await expect(card, 'card entered full-frame').toHaveClass(/full-frame/);
    await expect(card).toHaveAttribute('data-full-frame', 'true');
    await expect(wrap, 'wrap gained full-frame').toHaveClass(/full-frame/);
    expect(await readFullFrame(page, 'bd'), 'fullFrame persisted true').toBe(true);

    // The point of full-frame: the CONTROLS are gone and the display — a small
    // centred picture a moment ago — has GROWN to consume the whole card.
    await expect(canvas, 'output surface is showing').toBeVisible();
    await expect(
      card.locator('[data-testid="backdraft-controls"]'),
      'controls hidden while full-frame',
    ).toBeHidden();
    const afterBox = await wrap.boundingBox();
    expect(afterBox, 'full-frame display measurable').not.toBeNull();
    expect(
      afterBox!.width,
      `display GREW into full-frame (${beforeBox!.width.toFixed(0)} → ${afterBox!.width.toFixed(0)})`,
    ).toBeGreaterThan(beforeBox!.width * 2);
    const cardBoxFF = await card.boundingBox();
    expect(
      Math.abs(afterBox!.width - cardBoxFF!.width),
      'full-frame display spans the whole card width',
    ).toBeLessThan(4);

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
