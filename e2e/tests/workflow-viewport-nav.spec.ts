// e2e/tests/workflow-viewport-nav.spec.ts
//
// WORKFLOW VIEWPORT NAVIGATION — the keyboard pan keys. Proves the real
// window-keydown handler (Canvas.svelte, workflow-mode only) drives xyflow's
// setViewport:
//
//   1. '1'..'8' → pan so THAT channel column is horizontally CENTERED in the
//      viewport with its BASELINE (where the number sits) at the viewport BOTTOM,
//      at the CURRENT zoom.
//   2. 'v'/'V'  → pan so the VIDEO ZONE's lower-left corner maps to the
//      viewport's lower-left corner.
//   3. GUARD: pressing a number while a text input is focused does NOT pan (the
//      isTypingTarget typing-guard) — the number must be free to type into a card.
//
// The pure translate math is unit-tested in channel-columns.test.ts; this spec
// asserts the WIRING end-to-end by projecting the target flow point through the
// LIVE viewport (flowToScreenPosition) after the pan settles and checking where
// it lands on screen. Driving /rack?shell=legacy keeps it in the normal e2e
// lane (no DB/relay).

import { test, expect, type Page } from '@playwright/test';
import { installRenderSmokeHooks } from './_render-smoke';
import { BOOT_MS, SLOW_BOOT_TEST_TIMEOUT_MS } from '../_helpers/boot-budget';

// ⚠ THE PER-TEST BUDGET IS A BOUND, AND IT WAS THE INVISIBLE 30 s DEFAULT.
//
// This file bounds its boot waits with `BOOT_MS` — 30 000 on CI, IDENTICAL to
// the 30 000 default budget they were running inside. 2 sites, 1.00x.
//
// An inner bound at or above the budget that CONTAINS it can never come true:
// the outer clock kills the test first, so a legible `element not found` is
// converted into an illegible `Test timeout of 30000ms exceeded` — the class
// #2291 root-caused and #2293 repaired at its second call site. Nothing in this
// file said "30000"; `e2e/playwright.config.ts` never overrides Playwright's
// default, so there was nothing to grep for except the ABSENCE of a budget.
//
// The budget therefore comes from `boot-budget` (90 000 on CI/SwiftShader,
// 30 000 local) instead of the invisible default. A bound only costs wall-clock
// when it is EXCEEDED, so this adds exactly zero to a green run; lane cost stays
// gauged by `--global-timeout`, not by this.
//
// ⚠ BOUNDS ONLY. No assertion, subject or wait target changed here.
test.describe.configure({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });

// channel-columns.ts geometry (kept in sync with the pure module).
const HP_UNIT = 22.5;
const RACK_UNIT = 180;
const COLUMN_W = 34 * HP_UNIT; // 765
const COLUMN_SLOT_H = RACK_UNIT * 4; // 720
const COLUMN_MAX_SLOTS = 6;
const COLUMN_BASELINE_Y = COLUMN_SLOT_H * COLUMN_MAX_SLOTS; // 4320
const VIDEO_AREA_HEIGHT = RACK_UNIT * 3; // 540
const columnBandCenterX = (ch: number) => (ch - 1) * COLUMN_W + COLUMN_W / 2;
const videoArea = () => ({ x0: 0, y1: COLUMN_BASELINE_Y + VIDEO_AREA_HEIGHT });

async function waitForPinnedTrio(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const w = globalThis as unknown as {
        __patch?: { nodes: Record<string, { data?: { pinned?: boolean } } | undefined> };
      };
      return !!w.__patch && ['pinned-mixmstrs', 'pinned-clipplayer', 'pinned-audioOut'].every(
        (id) => w.__patch!.nodes[id]?.data?.pinned === true,
      );
    },
    undefined,
    { timeout: BOOT_MS },
  );
}

async function waitForFlowHook(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const w = globalThis as unknown as {
        __flow?: { flowToScreenPosition?: unknown; getViewport?: unknown };
      };
      return typeof w.__flow?.flowToScreenPosition === 'function' && typeof w.__flow?.getViewport === 'function';
    },
    undefined,
    { timeout: BOOT_MS },
  );
}

/**
 * The pane rect AND a flow point projected through the LIVE viewport, in ONE
 * page round trip — so the two can never come from different animation frames,
 * which is exactly the class of error a two-evaluate read invites while an
 * animated `setViewport` is still running.
 */
async function paneAndPoint(
  page: Page,
  p: { x: number; y: number },
): Promise<{
  rect: { left: number; top: number; width: number; height: number };
  point: { x: number; y: number };
}> {
  return page.evaluate((pt) => {
    const w = globalThis as unknown as {
      __flow: { flowToScreenPosition: (q: { x: number; y: number }) => { x: number; y: number } };
    };
    const el = document.querySelector('.svelte-flow') as HTMLElement | null;
    const r = (el ?? document.body).getBoundingClientRect();
    return {
      rect: { left: r.left, top: r.top, width: r.width, height: r.height },
      point: w.__flow.flowToScreenPosition(pt),
    };
  }, p);
}

/** `within` px of `want`, else the signed miss — so a failing poll prints the
 *  per-axis error in CSS px rather than a bare boolean. */
const near = (got: number, want: number, within: number, ok: string): string =>
  Math.abs(got - want) < within ? ok : `off by ${Math.round(got - want)} CSS px`;

async function getViewport(page: Page): Promise<{ x: number; y: number; zoom: number }> {
  return page.evaluate(() => (globalThis as unknown as { __flow: { getViewport: () => { x: number; y: number; zoom: number } } }).__flow.getViewport());
}

test.describe('workflow viewport navigation (keyboard pan)', () => {
  // The workflow video-zone defaults (videoOut + recorderbox + synesthesia,
  // PR #1155) run a live WebGL loop that saturates CI's SwiftShader main thread
  // and makes keyboard-pan timing flake under contention. This spec asserts the
  // viewport transform, not video — idle the engine rAF loop before boot (the
  // render-smoke seam; no assertion weakened).
  test.beforeEach(async ({ page }) => {
    await installRenderSmokeHooks(page);
  });

  test("'3' centers column 3 horizontally with its baseline at the viewport bottom", async ({ page }) => {
    await page.goto('/rack?shell=legacy');
    await waitForPinnedTrio(page);
    await waitForFlowHook(page);

    // Focus the canvas body (not a text field) so the window keydown fires.
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('3');

    // WHERE THE PAN LANDS is the subject, so wait on THAT rather than budget
    // 600 ms for a 220 ms animation (Canvas.svelte WCOL_PAN_MS). The poll
    // returns the instant the transform arrives, and still fails — naming the
    // axis and the miss in CSS px — if it never does. ONE assertion, because a
    // second read after a passing poll could only ever be vacuous.
    await expect
      .poll(
        async () => {
          const { rect, point } = await paneAndPoint(page, {
            x: columnBandCenterX(3),
            y: COLUMN_BASELINE_Y,
          });
          return {
            // The band center of column 3 must land at the horizontal center
            // of the pane…
            x: near(point.x, rect.left + rect.width / 2, 6, 'at viewport center-x'),
            // …and the baseline near the very bottom of the pane.
            y: near(point.y, rect.top + rect.height, 6, 'near viewport bottom'),
          };
        },
        { message: "'3' centers column 3's band with its baseline at the pane bottom" },
      )
      .toEqual({ x: 'at viewport center-x', y: 'near viewport bottom' });
  });

  test("'V' snaps the video area's lower-left corner to the viewport's lower-left corner", async ({ page }) => {
    await page.goto('/rack?shell=legacy');
    await waitForPinnedTrio(page);
    await waitForFlowHook(page);

    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('v');

    // Same shape as '3' above: poll the LANDING, not a budget for the 220 ms
    // WCOL_PAN_MS animation.
    const b = videoArea();
    await expect
      .poll(
        async () => {
          const { rect, point } = await paneAndPoint(page, { x: b.x0, y: b.y1 });
          // Lower-LEFT of the video zone → lower-LEFT of the viewport.
          return {
            x: near(point.x, rect.left, 6, 'at viewport left'),
            y: near(point.y, rect.top + rect.height, 6, 'near viewport bottom'),
          };
        },
        { message: "'V' snaps the video area's lower-left corner to the pane's lower-left" },
      )
      .toEqual({ x: 'at viewport left', y: 'near viewport bottom' });
  });

  test('GUARD: a number pressed while a text input is focused does NOT pan', async ({ page }) => {
    await page.goto('/rack?shell=legacy');
    await waitForPinnedTrio(page);
    await waitForFlowHook(page);

    // Inject + focus a real text input (mimics a card's number field).
    await page.evaluate(() => {
      const input = document.createElement('input');
      input.type = 'text';
      input.id = '__nav-guard-input';
      document.body.appendChild(input);
      input.focus();
    });

    const before = await getViewport(page);
    await page.keyboard.press('4'); // would center column 4 if it leaked
    // pacing: this is the NEGATIVE case — nothing must happen — so there is no
    // subject to poll; the wait has to outlast the animation whose absence is
    // being asserted. That animation is the product's own: Canvas.svelte's
    // `WCOL_PAN_MS = 220` (packages/web/src/lib/ui/Canvas.svelte), the duration
    // it hands xyflow's setViewport for a column/video pan. 400 ms is that
    // interval with margin, so a leaked keydown has finished panning by the
    // read below rather than being caught mid-flight and read as "unchanged".
    await page.waitForTimeout(400);
    const after = await getViewport(page);

    // The viewport is untouched — the keydown was inert while typing.
    expect(after.x, 'viewport x unchanged while typing').toBeCloseTo(before.x, 3);
    expect(after.y, 'viewport y unchanged while typing').toBeCloseTo(before.y, 3);
    expect(after.zoom, 'zoom unchanged').toBeCloseTo(before.zoom, 5);

    await page.evaluate(() => document.getElementById('__nav-guard-input')?.remove());
  });
});
