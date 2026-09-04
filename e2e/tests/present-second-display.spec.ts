// e2e/tests/present-second-display.spec.ts
//
// "Present an OUTPUT on a second display" — a SEPARATE popup window placed on
// display 2, into which the OPENER blits the OUTPUT card's live canvas every
// frame (a direct same-origin canvas → canvas drawImage; no MediaStream, no
// <video>, no autoplay/fullscreen gesture). The main patcher stays interactive
// on display 1 (unlike true fullscreen, which relocates the whole tab).
//
// Real multi-monitor + the Window Management API can't run in headless CI, so
// we inject a fake window.getScreenDetails (2 screens) for placement. But the
// blit PIPELINE itself is fully exercisable: we let the REAL window.open open
// the REAL /present popup (captured via Playwright's popup event), wait for the
// OUTPUT card to render its source canvas, and assert the popup's
// `present-canvas` receives a NON-BLACK frame — which is exactly the failure
// the captureStream→<video> pipeline produced on real hardware (a black popup).
//
// We assert three contracts deterministically:
//   1. SINGLE-SCREEN / unsupported (the CI default): the canvas right-click
//      menu shows NO "Present on …" entry — the feature capability-gates off
//      and nothing throws.
//   2. MULTI-SCREEN (injected): a "Present on <secondary>" entry shows, clicking
//      it opens a REAL /present popup, that popup's canvas gets non-black
//      pixels, AND — the part a frame counter cannot see — a change to the
//      GRAPH reaches those pixels, stops reaching them when the blit is
//      deliberately severed, and comes back when it is restored. "Stop
//      presenting" then closes the popup.
//   3. The /present route loads chrome-less + safe with no opener.
//
// ── WHY THE CAUSAL + SEVERED LEGS EXIST ────────────────────────────────────
//
// "Non-black once, shortly after opening" is a real assertion but a weak one:
// it cannot see a projector that goes black or freezes LATER, which is the
// failure mode this feature has actually shipped (the owner P0 that produced
// node-present-registry, and the frozen-last-frame class the sink's link
// monitor now reports). And the blit it is watching black-fills every frame and
// swallows draw errors ON PURPOSE, so "the loop is running" is decoupled from
// "there is a picture" by construction.
//
// So the gate below is causal — mutate a source param through the live Y.Doc
// and require the RECEIVER's pixel hash to follow — and it is negative-
// controlled: with `__severPresentBlit(true)` cutting the source read, the same
// probe must go RED. A continuity probe that has never been seen to fail is a
// decoration; this one is failed on every run, on purpose, and then recovered.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { waitFrames } from '../_helpers/frames';
import {
  awaitReceiver,
  describeReceiver,
  followReceiver,
  presentSinkStats,
  requirePresentFrame,
} from '../_helpers/present';

const TRIANGLE_PARAMS = { shape: 2, tile: 0, rotate: 0, zoom: 2.2 };

/** Inject a fake Window Management API returning `screens` so the present menu
 *  capability-gates on + getScreenRect() resolves popup placement. We do NOT
 *  stub window.open here — the real popup must open so we can read its canvas. */
async function injectScreens(
  page: Page,
  screens: Array<{ label: string; isPrimary: boolean }>,
): Promise<void> {
  await page.addInitScript((screensArg) => {
    const fakeScreens = screensArg.map((s, i) => ({
      label: s.label,
      isPrimary: s.isPrimary,
      // Working-area geometry so getScreenRect() resolves popup placement.
      // Keep the secondary placement inside the test viewport so the popup is
      // actually creatable + visible to Playwright (left=0 second screen).
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

async function setup(page: Page): Promise<void> {
  await page.goto('/rack?shell=legacy&seed=none');
  await page.waitForLoadState('networkidle');
  await spawnPatch(
    page,
    [
      { id: 'src', type: 'shapes', position: { x: 40, y: 40 }, domain: 'video', params: TRIANGLE_PARAMS },
      { id: 'out', type: 'videoOut', position: { x: 500, y: 40 }, domain: 'video' },
    ],
    [{ id: 'e1', from: { nodeId: 'src', portId: 'out' }, to: { nodeId: 'out', portId: 'in' }, sourceType: 'mono-video', targetType: 'video' }],
  );
  await expect(page.locator('[data-testid="video-out-card"]')).toHaveCount(1);
  // Let the OUTPUT card's rAF render the source frame into its canvas.
  await page.waitForTimeout(500);
}

/** Write a param on a node through the live Y.Doc, exactly as a control would —
 *  the CAUSE half of the causal probe. */
async function setParam(page: Page, nodeId: string, key: string, value: number): Promise<void> {
  await page.evaluate(
    ({ nodeId: id, key: k, value: v }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes[id];
        if (n) n.params[k] = v;
      });
    },
    { nodeId, key, value },
  );
}

/** Cut (or restore) the opener→sink blit. The hook is committed behind the same
 *  DEV / VITE_E2E_HOOKS gate as every other Playwright seam in this repo. */
async function severBlit(page: Page, on: boolean): Promise<void> {
  const installed = await page.evaluate((flag) => {
    const w = globalThis as unknown as { __severPresentBlit?: (on?: boolean) => void };
    if (typeof w.__severPresentBlit !== 'function') return false;
    w.__severPresentBlit(flag);
    return true;
  }, on);
  expect(
    installed,
    '__severPresentBlit hook not present — a DEV/VITE_E2E_HOOKS build is expected. ' +
      'Without it the negative control below cannot run, and a gate whose red path ' +
      'is unreachable proves nothing.',
  ).toBe(true);
}

/** Read whether a canvas locator has ANY non-black pixel. We sample the canvas
 *  pixels in-page (it's same-origin, so getImageData is allowed). */
async function canvasHasNonBlackPixel(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>(
      '[data-testid="present-canvas"]',
    );
    if (!c || c.width < 2 || c.height < 2) return false;
    const ctx = c.getContext('2d');
    if (!ctx) return false;
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    // Any pixel whose RGB is meaningfully above black => the blit landed.
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 16 || data[i + 1] > 16 || data[i + 2] > 16) return true;
    }
    return false;
  });
}

test.describe('present on a second display — VIDEO OUT', () => {
  test('single screen / unsupported -> NO "Present on …" entry (safe no-op, CI path)', async ({ page }) => {
    // Only one fake display -> capability-gated off (same as a real
    // single-monitor or a browser without getScreenDetails).
    await injectScreens(page, [{ label: 'Only Display', isPrimary: true }]);
    await setup(page);

    const canvas = page.locator('canvas[data-testid="video-out-canvas"]');
    await canvas.click({ button: 'right' });
    await expect(page.locator('[data-testid="video-canvas-context-menu"]')).toBeVisible();

    // No present entries at all on a single screen; nothing thrown.
    await expect(page.locator('[data-testid^="ctx-present-"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="ctx-stop-present"]')).toHaveCount(0);
  });

  test('two screens -> "Present on <secondary>" opens a REAL /present popup that gets a NON-BLACK frame', async ({ page, context }) => {
    // ⚠ THE WALL CLOCK BOUNDS THE FAILURE; THE FRAME BUDGET IS THE GATE — and
    // the DEFAULT 30 s bound is too small to contain its own gate. FRAME_BUDGET
    // below is 180 rendered frames, which is ~23 s at the 7.9 fps this repo
    // measured under E2E_SWIFTSHADER=1, and slower still with ten shards on one
    // runner. Add this file's ~35 s recorded CI cost (e2e-timings.generated.json)
    // across its three tests and the budget cannot be spent inside 30 s: the
    // test died mid-`click` on shard 8 with the blit assertion already PASSED
    // (#1903 follow-up). Raise the bound so the frame budget is spendable —
    // never shrink the gate to fit the clock.
    //
    // 90 s -> 150 s for the causal + severed-blit legs added below. Their frame
    // budgets are 180 + 60 + 60 + 180, and only ONE of those (the negative leg,
    // 60) is unconditional — the rest exit on the frame the change lands, which
    // locally is the first batch. Measured worst case is therefore ~480 opener
    // frames on top of the existing 180, ≈ 60 s at the 7.9 fps this repo
    // measured under E2E_SWIFTSHADER=1, and the typical spend is a small
    // fraction of it. Still a FAILURE BOUND, never the gate.
    test.setTimeout(150_000);
    await injectScreens(page, [
      { label: 'Built-in Retina', isPrimary: true },
      { label: 'DELL U2720Q', isPrimary: false },
    ]);
    await setup(page);

    const canvas = page.locator('canvas[data-testid="video-out-canvas"]');
    await canvas.click({ button: 'right' });
    await expect(page.locator('[data-testid="video-canvas-context-menu"]')).toBeVisible();

    // "Present on …" appears only for the NON-current (secondary) display.
    const presentSec = page.locator('[data-testid="ctx-present-display-1"]');
    await expect(presentSec).toBeVisible();
    await expect(presentSec).toHaveText(/Present on DELL U2720Q/);
    // Never offer presenting on THIS (primary) display.
    await expect(page.locator('[data-testid="ctx-present-primary"]')).toHaveCount(0);

    // Click it -> the REAL window.open fires a popup; capture the popup Page.
    const popupPromise = context.waitForEvent('page');
    await presentSec.click();
    const popup = await popupPromise;
    await popup.waitForLoadState('domcontentloaded');

    // The popup is the chrome-less /present sink with a present-canvas.
    expect(popup.url()).toContain('/present');
    await expect(popup.locator('[data-testid="present-canvas"]')).toBeAttached();

    // THE BUG FIX ASSERTION: the opener blits the OUTPUT canvas into the popup's
    // canvas every frame, so it must show NON-BLACK pixels (the captureStream→
    // <video> pipeline produced an all-black popup here). Poll: the first blit
    // lands a frame or two after the popup's `present:ready` handshake.
    // ⚠ FRAMES, NOT MILLISECONDS. The blit lands ON A FRAME, so a wall-clock
    // budget is a DIFFERENT assertion on every renderer: 8 s was ~480 frames on
    // a real GPU but only ~63 under SwiftShader, and fewer still on a CI runner
    // hosting ten shards. The frame count is renderer-independent; the test
    // timeout remains the wall-clock bound on the failure, never the gate.
    // BATCH is the CHECK GRANULARITY, not the gate: the loop overshoots by up
    // to one batch past the frame the blit actually lands on. Measured locally
    // under E2E_SWIFTSHADER=1, the popup is already non-black at the FIRST
    // check, so a 15-frame batch spent ~12 frames the behaviour did not need —
    // free locally, seconds on a contended runner. 5 keeps the same ceiling and
    // pays a cheap pixel read for it. (`expect.poll` got this for free; a frame
    // loop has to choose it.)
    const FRAME_BUDGET = 180;
    const FRAME_BATCH = 5;
    const startedAt = Date.now();
    let framesWaited = 0;
    let nonBlack = false;
    while (!nonBlack && framesWaited < FRAME_BUDGET) {
      // ⚠ FRAMES ARE COUNTED IN THE OPENER, NOT THE POPUP. The OPENER runs the
      // blit loop (it copies its output canvas into the popup every frame); the
      // popup is passive. An unfocused popup also has its rAF THROTTLED by the
      // browser, so counting frames there measured the wrong clock and could
      // stall while the behaviour under test was working — that is why the
      // first frames-based fix still flaked (#1903 red, 2026-08-24).
      await waitFrames(page, FRAME_BATCH);
      framesWaited += FRAME_BATCH;
      nonBlack = await canvasHasNonBlackPixel(popup);
    }
    expect(
      nonBlack,
      `the popup canvas must receive a NON-BLACK blit from the opener within `
        + `${FRAME_BUDGET} rendered frames (observed ${framesWaited} frames, units: FRAMES; `
        + `${Date.now() - startedAt} ms elapsed, units: MS — the ms is DIAGNOSTIC ONLY, `
        + `it says how fast this renderer drew those frames and gates nothing)`,
    ).toBe(true);

    // ── THE SINK CARRIES ITS OWN IDENTITY ────────────────────────────────
    // Without `?slot=` every projector is `window.open('/present', '_blank',
    // '<geometry>')` — identical URL, window name and feature shape — and a
    // native shell's window-open handler cannot tell an output slot's sink from
    // an old patch's restored projector, so it can route neither.
    expect(popup.url(), 'the sink URL carries the (node, display) slot').toContain('slot=');
    await expect(popup.locator('[data-testid="present-root"]')).toHaveAttribute(
      'data-slot',
      /out/,
    );

    // ── POSITIVE CONTROL: THE PROJECTOR FOLLOWS THE GRAPH ────────────────
    // The counter-shaped assertion above says the loop ran. This says the
    // PICTURE is downstream of the patch: change SHAPES' zoom and require the
    // RECEIVER's pixel hash to move. (zoom is a log-curve 0.05..10 control;
    // 2.2 -> 0.15 shrinks the primitive from frame-filling to a speck, so
    // essentially every sampled pixel moves. A value outside a param's declared
    // range is silently clamped and makes a control leg vacuous.)
    const CAUSAL_BUDGET = 180;
    const before = await requirePresentFrame(popup, 'before the causal change');
    await setParam(page, 'src', 'zoom', 0.15);
    const followed = await followReceiver(page, popup, before.hash, CAUSAL_BUDGET);
    expect(
      followed.reads,
      `the probe never got a usable read of the projector — ZERO SAMPLES is an `
        + `instrument failure, never a pass. ${describeReceiver(followed)}`,
    ).toBeGreaterThan(0);
    expect(
      followed.ok,
      `a graph change must reach the projector's PIXELS within ${CAUSAL_BUDGET} `
        + `opener frames. ${describeReceiver(followed)}`,
    ).toBe(true);

    // ── NEGATIVE CONTROL: SEVER THE BLIT AND THE SAME PROBE MUST GO RED ──
    // ⚠ THIS IS THE POINT. Everything above passes just as happily against a
    // projector that is black or frozen, because the blit black-fills every
    // frame and swallows draw errors by design. Cutting the source read must
    // therefore (a) turn the picture black and (b) make a graph change stop
    // arriving. If the probe still sees a change here, it is reading something
    // that is not the projector and every green above is worthless.
    const SEVER_BUDGET = 60;
    // ⚠ SAMPLE THE LIT PICTURE **BEFORE** CUTTING. The black-fill lands on the
    // very next frame, so a read taken after the sever can already be the black
    // one — and then "did it change?" compares black to black and the control
    // silently inverts. Predicate on NON-BLACK rather than on a hash difference
    // for the same reason: any hash move would also be satisfied by a source
    // that merely animated.
    await requirePresentFrame(popup, 'just before the blit was cut');
    await severBlit(page, true);
    const wentBlack = await awaitReceiver(page, popup, (s) => !s.nonBlack, SEVER_BUDGET);
    expect(
      wentBlack.ok,
      `severing the blit must black the projector out within ${SEVER_BUDGET} frames — `
        + `if it does not, the hook is not wired to the loop under test and the `
        + `"red" below would be meaningless. ${describeReceiver(wentBlack)}`,
    ).toBe(true);

    const dark = await requirePresentFrame(popup, 'after the blit was cut');
    // Read the painted count only once the picture is already black, so it is
    // sampled after the freeze rather than racing it.
    const paintedWhenCut = (await presentSinkStats(popup))?.painted ?? -1;
    await setParam(page, 'src', 'zoom', 8);
    const blind = await followReceiver(page, popup, dark.hash, SEVER_BUDGET);
    expect(
      blind.reads,
      `the negative leg read nothing, so it proves nothing. ${describeReceiver(blind)}`,
    ).toBeGreaterThan(0);
    expect(
      blind.ok,
      `WITH THE BLIT SEVERED a graph change must NOT reach the projector. It did, `
        + `so this probe is not measuring the projector. ${describeReceiver(blind)}`,
    ).toBe(false);
    // And the transport says so from the receiver's side: the opener's painted
    // count froze, which is the signal the old void-returning protocol could
    // not carry at all.
    const cutStats = await presentSinkStats(popup);
    expect(
      cutStats,
      'the sink must publish its link stats in a hooks build (they are how a '
        + 'failure names WHICH half broke)',
    ).not.toBeNull();
    expect(
      cutStats!.painted,
      `the sink's painted-frame count must FREEZE while the blit is cut `
        + `(was ${paintedWhenCut}). ${describeReceiver(blind)}`,
    ).toBe(paintedWhenCut);

    // ── RECOVERY: and the same probe goes GREEN again ────────────────────
    // Proves the black above was caused by the sever and not by the projector
    // dying for an unrelated reason mid-test — the difference between a
    // negative control and an outage.
    await severBlit(page, false);
    const recovered = await awaitReceiver(
      page,
      popup,
      (s) => s.nonBlack && s.hash !== dark.hash,
      CAUSAL_BUDGET,
    );
    expect(
      recovered.ok,
      `restoring the blit must bring the picture back — otherwise the "red" above `
        + `was an outage, not a control. ${describeReceiver(recovered)}`,
    ).toBe(true);

    // Re-open the menu on the opener -> "Stop presenting" now shows + closes it.
    await canvas.click({ button: 'right' });
    const stop = page.locator('[data-testid="ctx-stop-present"]');
    await expect(stop).toBeVisible();

    const popupClosed = popup.waitForEvent('close');
    await stop.click();
    await popupClosed;
    expect(popup.isClosed()).toBe(true);

    // "Stop presenting" is gone again after stopping.
    await canvas.click({ button: 'right' });
    await expect(page.locator('[data-testid="ctx-stop-present"]')).toHaveCount(0);
  });
});

test.describe('present sink route', () => {
  test('/present renders a black chrome-less canvas sink', async ({ page }) => {
    // The sink with no opener just shows its black canvas (it never gets drawn
    // into), proving the route loads chrome-less + safe.
    await page.goto('/present');
    await expect(page.locator('[data-testid="present-root"]')).toBeVisible();
    await expect(page.locator('[data-testid="present-canvas"]')).toBeAttached();
  });
});
