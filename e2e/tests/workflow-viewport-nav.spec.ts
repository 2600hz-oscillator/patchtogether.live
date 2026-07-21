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
// it lands on screen. Driving /rack?mode=workflow keeps it in the normal e2e
// lane (no DB/relay).

import { test, expect, type Page } from '@playwright/test';

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
    { timeout: 15_000 },
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
    { timeout: 15_000 },
  );
}

/** The flow pane's client-space bounding rect (xyflow's `.svelte-flow` root). */
async function paneRect(page: Page): Promise<{ left: number; top: number; width: number; height: number }> {
  return page.evaluate(() => {
    const el = document.querySelector('.svelte-flow') as HTMLElement | null;
    const r = (el ?? document.body).getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  });
}

/** Project a flow-space point to client px through the LIVE viewport. */
async function projectFlow(page: Page, p: { x: number; y: number }): Promise<{ x: number; y: number }> {
  return page.evaluate((pt) => {
    const w = globalThis as unknown as { __flow: { flowToScreenPosition: (q: { x: number; y: number }) => { x: number; y: number } } };
    return w.__flow.flowToScreenPosition(pt);
  }, p);
}

async function getViewport(page: Page): Promise<{ x: number; y: number; zoom: number }> {
  return page.evaluate(() => (globalThis as unknown as { __flow: { getViewport: () => { x: number; y: number; zoom: number } } }).__flow.getViewport());
}

test.describe('workflow viewport navigation (keyboard pan)', () => {
  test("'3' centers column 3 horizontally with its baseline at the viewport bottom", async ({ page }) => {
    await page.goto('/rack?mode=workflow');
    await waitForPinnedTrio(page);
    await waitForFlowHook(page);

    // Focus the canvas body (not a text field) so the window keydown fires.
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('3');
    await page.waitForTimeout(600); // let the 220ms animated setViewport settle

    const rect = await paneRect(page);
    // The band center of column 3 must land at the horizontal center of the pane…
    const center = await projectFlow(page, { x: columnBandCenterX(3), y: COLUMN_BASELINE_Y });
    expect(Math.abs(center.x - (rect.left + rect.width / 2)), 'column 3 band-center at viewport center-x').toBeLessThan(6);
    // …and the baseline near the very bottom of the pane.
    expect(Math.abs(center.y - (rect.top + rect.height)), 'column 3 baseline near viewport bottom').toBeLessThan(6);
  });

  test("'V' snaps the video area's lower-left corner to the viewport's lower-left corner", async ({ page }) => {
    await page.goto('/rack?mode=workflow');
    await waitForPinnedTrio(page);
    await waitForFlowHook(page);

    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('v');
    await page.waitForTimeout(600);

    const rect = await paneRect(page);
    const b = videoArea();
    const corner = await projectFlow(page, { x: b.x0, y: b.y1 });
    // Lower-LEFT of the video zone → lower-LEFT of the viewport.
    expect(Math.abs(corner.x - rect.left), 'video-area left edge at viewport left').toBeLessThan(6);
    expect(Math.abs(corner.y - (rect.top + rect.height)), 'video-area bottom near viewport bottom').toBeLessThan(6);
  });

  test('GUARD: a number pressed while a text input is focused does NOT pan', async ({ page }) => {
    await page.goto('/rack?mode=workflow');
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
    await page.waitForTimeout(400);
    const after = await getViewport(page);

    // The viewport is untouched — the keydown was inert while typing.
    expect(after.x, 'viewport x unchanged while typing').toBeCloseTo(before.x, 3);
    expect(after.y, 'viewport y unchanged while typing').toBeCloseTo(before.y, 3);
    expect(after.zoom, 'zoom unchanged').toBeCloseTo(before.zoom, 5);

    await page.evaluate(() => document.getElementById('__nav-guard-input')?.remove());
  });
});
