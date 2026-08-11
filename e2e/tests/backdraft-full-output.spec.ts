// e2e/tests/backdraft-full-output.spec.ts
//
// BACKDRAFT "full output capabilities" — Full Frame / Full Screen /
// Present-on-other-display, the same surface VIDEO OUT + BENTBOX ship, wired
// onto the BACKDRAFT card via the shared helpers (use-fullscreen /
// use-full-frame / use-present / VideoCanvasContextMenu).
//
// ── NO DISPLAY IN THE RACK — ONE SURFACE, THREE EXPANDED SIZES ──────────────
// BACKDRAFT's in-card display is GONE (owner call). The card still owns the
// <canvas> those output modes present, but only as a SURFACE: in the rack it is
// a 0×0 absolutely-positioned box that is never painted, and each expanded mode
// gives it its size back.
//
//     in the rack   0×0, invisible — the card is controls only
//     Full Frame    the whole card (chrome hidden, dbl-click exits)
//     Full Screen   the physical screen (requestFullscreen on the wrap)
//     Present       blitted into a popup on a second display
//
// It must stay MOUNTED for any of that to work: requestFullscreen() cannot be
// handed a `display: none` element, and the Present popup blits FROM this
// canvas. So "the canvas exists but is not visible" is the invariant, and both
// halves are asserted below — a card that dropped the element would still pass
// a visibility-only check, and a card that showed it again would still pass a
// presence-only check.
//
// ── THE ⛶ OUTPUT BUTTON IS NOW THE SOLE ENTRY POINT ─────────────────────────
// There were two: the button and a right-click on the display. With no display
// there is nothing to right-click, so the button
// ([data-testid="backdraft-output-menu"]) carries the whole feature. Every case
// here drives it, and the first case pins that it is present, visible, enabled
// and claims its click (SvelteFlow's node menu must not also open).
//
// CORNER-RESIZE stays RETIRED. The card is a fixed 4hp×3u rack tier
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
// The card's tier, read from the ONE place that owns it. Hard-coding 720x540
// here would make this a THIRD copy of that truth (card CSS, RACK_SIZE_DEFAULTS,
// spec) and the copies could drift silently in either direction;
// card-control-ranges.test.ts already pins the CSS against this map, so
// importing it makes the pair CSS<->map<->rendered-box transitive.
import { RACK_SIZE_DEFAULTS } from '../../packages/web/src/lib/ui/rack-sizes';

const RACK_UNIT = 180;
const TIER = RACK_SIZE_DEFAULTS.backdraft!;
const TIER_W = TIER.hp * RACK_UNIT;
const TIER_H = Number(TIER.size.replace('u', '')) * RACK_UNIT;

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
// THE DISPLAY'S REMOVAL ATTACKS THE SAME TAX AT ITS SOURCE. With no in-rack
// picture there is nothing to blit into, so the card performs NO GL readback
// while it sits in the rack (see the tick() note in BackdraftCard.svelte) —
// the per-frame cost this note is about is now zero for this card, freeze or
// no freeze. The freeze stays because the ENGINE still renders the node (the
// card marks it watched so the feedback nest keeps advancing), and that is the
// half that competes with the input queue.
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
  await page.goto('/rack?shell=legacy');
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

/** Open the card's OUTPUT menu — the SOLE entry point now that there is no
 *  display to right-click. Waits for the button rather than the surface,
 *  because the surface is invisible until an expanded mode is entered. */
async function openOutputMenu(page: Page): Promise<void> {
  const btn = page.locator('[data-testid="backdraft-output-menu"]');
  await expect(btn, 'OUTPUT button present on the card').toBeVisible();
  await expect(btn, 'OUTPUT button is enabled').toBeEnabled();
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

    // THE SURFACE IS MOUNTED BUT NOT SHOWN. Both halves matter and neither
    // implies the other: dropping the element entirely would still satisfy
    // "not visible" (and would silently break requestFullscreen + Present),
    // while showing a picture again would still satisfy "in the DOM". This is a
    // layout read, not a pixel read — no GL work.
    const canvas = page.locator('canvas[data-testid="backdraft-canvas"]');
    await expect(canvas, 'the output surface is present in the DOM').toHaveCount(1);
    await expect(canvas, 'the output surface is NOT shown in the rack').toBeHidden();
    const wrapBox = await page.locator('[data-testid="backdraft-fs-wrap"]').boundingBox();
    // A 0x0 box: Playwright returns null for a zero-area element, and if it ever
    // returns a box it must still be empty. Either way the card shows no picture.
    expect(
      wrapBox === null || (wrapBox.width === 0 && wrapBox.height === 0),
      `in-rack output surface occupies no space (got ${JSON.stringify(wrapBox)})`,
    ).toBe(true);

    // THE CARD IS ITS TIER, EXACTLY (4hp x 3u = 720x540 today, read from
    // RACK_SIZE_DEFAULTS above). The point of removing the display was a
    // SMALLER card with no dead space, and the height is pinned min AND max, so
    // any part of the tier the layout does not use is permanent grey on every
    // instance of the card — and any part the layout EXCEEDS is silently
    // clipped by `.card { overflow: hidden }`.
    // offsetWidth/offsetHeight are LAYOUT (CSS) px and immune to xyflow's zoom
    // transform, unlike boundingBox() — see the units note in
    // card-control-overflow.spec.ts.
    const size = await page.locator('[data-testid="backdraft-card"]').evaluate((el) => ({
      w: (el as HTMLElement).offsetWidth,
      h: (el as HTMLElement).offsetHeight,
    }));
    expect(size.w, `card width ${size.w} CSS px (want ${TIER.hp}hp = ${TIER_W})`).toBe(TIER_W);
    expect(size.h, `card height ${size.h} CSS px (want ${TIER.size} = ${TIER_H})`).toBe(TIER_H);

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

  test('there is no in-rack picture to right-click — the node menu answers instead', async ({ page }) => {
    const errors = await setup(page);
    await spawnBackdraft(page);

    // The card used to have TWO entry points to the output menu: the button and
    // a right-click on the 320x240 display. The display is gone, so the second
    // one is gone with it and the BUTTON now carries the whole feature.
    //
    // This case pins the consequence rather than mourning it. The output
    // surface is still IN the card (0x0, absolutely positioned), so the failure
    // mode worth guarding is that it silently swallows pointer events over the
    // faceplate: it is `pointer-events: none` in the rack precisely so it
    // cannot. Right-clicking the card must therefore reach SvelteFlow's own
    // node menu (Docs / Duplicate / Delete) exactly as it does on any other
    // card, and must NOT open the output menu.
    await page.locator('[data-testid="backdraft-gates"]').click({ button: 'right' });

    await expect(
      page.locator('[role="menu"][aria-label="Module actions"]'),
      'right-click on the faceplate opens the SvelteFlow node menu',
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="video-canvas-context-menu"]'),
      'right-click does NOT open the output menu (no display to claim it)',
    ).toHaveCount(0);

    expect(errors).toEqual([]);
  });

  test('Full Frame toggles node.data.fullFrame + hides chrome; double-click exits', async ({ page }) => {
    const errors = await setup(page);
    await spawnBackdraft(page);

    const card = page.locator('[data-testid="backdraft-card"]');
    const canvas = page.locator('canvas[data-testid="backdraft-canvas"]');
    const wrap = page.locator('[data-testid="backdraft-fs-wrap"]');

    // Baseline: in the rack the surface occupies NOTHING, so the transition
    // below is asserted as real GROWTH from zero to the whole card. (Playwright
    // returns null for a zero-area box, hence the ?? 0.)
    const beforeBox = await wrap.boundingBox();
    const beforeW = beforeBox?.width ?? 0;
    expect(beforeW, 'in-rack output surface has no width').toBe(0);

    // Enter Full Frame via the OUTPUT menu.
    await openOutputMenu(page);
    await expect(page.locator('[data-testid="video-canvas-context-menu"]')).toBeVisible();
    await page.locator('[data-testid="ctx-full-frame"]').click();

    // Card gains .full-frame + the data attribute flips true + it persists.
    await expect(card, 'card entered full-frame').toHaveClass(/full-frame/);
    await expect(card).toHaveAttribute('data-full-frame', 'true');
    await expect(wrap, 'wrap gained full-frame').toHaveClass(/full-frame/);
    expect(await readFullFrame(page, 'bd'), 'fullFrame persisted true').toBe(true);

    // The point of full-frame: the CONTROLS are gone and the surface — which
    // occupied no space at all a moment ago — has GROWN to consume the whole
    // card. This is the case that proves the 0x0 in-rack surface is genuinely
    // the SAME element every expanded mode presents, not a dead stub.
    await expect(canvas, 'output surface is showing').toBeVisible();
    await expect(
      card.locator('[data-testid="backdraft-controls"]'),
      'controls hidden while full-frame',
    ).toBeHidden();
    const afterBox = await wrap.boundingBox();
    expect(afterBox, 'full-frame display measurable').not.toBeNull();
    expect(
      afterBox!.width,
      `surface GREW into full-frame (${beforeW.toFixed(0)} -> ${afterBox!.width.toFixed(0)})`,
    ).toBeGreaterThan(100);
    const cardBoxFF = await card.boundingBox();
    expect(
      Math.abs(afterBox!.width - cardBoxFF!.width),
      'full-frame display spans the whole card width',
    ).toBeLessThan(4);
    expect(
      Math.abs(afterBox!.height - cardBoxFF!.height),
      'full-frame display spans the whole card height (card padding dropped)',
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
  // preview removed the card is a FIXED 4hp×3u rack tier (rack-sizes.ts) and
  // there is no handle to drag and no node.data.width/height to persist —
  // rack-sizing.test.ts pins the tier and card-control-ranges.test.ts pins that
  // the card no longer reads a persisted size. card-resize.ts itself keeps its
  // coverage on the cards that still use it (bentbox.spec.ts, and the videoOut
  // resize case in workflow-shell-video.spec.ts).
});
