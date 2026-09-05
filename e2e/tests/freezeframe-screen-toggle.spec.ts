// e2e/tests/freezeframe-screen-toggle.spec.ts
//
// SCREEN ON / OFF on FREEZEFRAME — on the surface it ships on (owner ruling,
// 2026-08-18: "'screen on / off' like that is a thing all video modules should
// have moving forward").
//
// ⚠ THIS FILE USED TO TEST A SURFACE THE FEATURE DID NOT SHIP ON (#1934), and
// it PASSED THROUGHOUT — a gate whose precondition is the defect cannot fail on
// the defect (CLAUDE.md, the #1796 class). The lesson survives the surface that
// taught it: drive the shell the feature SHIPS on. The toggle arrives through
// the `fullViewBody` shell extension, and these legs FAIL if that extension is
// missing, which is the regression #1934 names.
//
// The source-level companion is `video-face-screen-source.test.ts` (#1935),
// which refuses a faced video module with no reachable SCREEN switch by name.
//
// THE OWNER'S STATED FLOOR IS PERSISTENCE — the on/off state must survive a tab
// switch — and nothing tested that on backdraft either, so it is the first leg
// here. The second is the one that makes this affordance different from
// "hide the canvas": the module KEEPS RENDERING while the screen is off, so
// switching it back on shows the LIVE picture rather than a stale frame. That
// is the #1720/#1721 bug class, and tearing the producer down is the tempting
// wrong implementation.
//
// ⚠ NO WALL-CLOCK WAITS AND NO FRAME COUNTS EITHER. Every subject here is a
// DOM or LAYOUT fact, so every wait is an auto-retrying `expect` / `expect.poll`
// on the real subject. An earlier draft counted frames; those counts backed no
// assertion once the "keeps rendering" claim moved to the source gate, and the
// rAF promise they injected was exactly what CI starved. The only wall-clock
// number in the file is the test BUDGET, taken from `boot-budget.ts`.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { SLOW_BOOT_TEST_TIMEOUT_MS } from '../_helpers/boot-budget';
import { waitFrames } from '../_helpers/frames';

const TOGGLE = '[data-testid="freezeframe-preview-toggle"]';
const CANVAS = '[data-testid="freezeframe-preview"]';

/**
 * ⚠ FREEZE THE PER-FRAME GL DRAW. This is a VIDEO card, and the first version
 * of this spec was the only video-card spec in the suite that did not do this.
 * It passed locally and TIMED OUT ON CI — both failing legs at 30 s, in a
 * `page.evaluate` that is nothing but a double rAF.
 *
 * The mechanism is not "CI is slower" in the ordinary sense, and the
 * distinction matters because the two need opposite fixes. FreezeframeCard's
 * rAF loop calls `blitOutputForPreview` + `drawPreviewDownscaled` EVERY FRAME,
 * for the whole life of the test. On CI's two-core runner under a software
 * rasterizer that work saturates the main thread, and an injected
 * `page.evaluate` promise — which resolves on that same thread — gets starved
 * past the test budget. A wall-clock bump would only have bought a slower
 * failure.
 *
 * Freezing costs these tests NOTHING, and that is worth stating rather than
 * assuming: every subject below is a DOM or LAYOUT fact — is the canvas
 * visible, does its box have height, is it the same element. None of them
 * reads a pixel. The one claim that IS about the render continuing to run
 * lives in `freezeframe-screen-source.test.ts`, where it is checked at the
 * source precisely because no runtime gate here can see it. Same lever the
 * registry tile sweep pulls in `io-spec-consistency.spec.ts`.
 */
async function freezeVideoRender(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (globalThis as unknown as { __videoEngineFreezeRender?: boolean })
      .__videoEngineFreezeRender = true;
  });
}

/** The persisted flag, read off the live patch rather than off the DOM — the
 *  DOM is the thing under test, so reading it back would prove nothing about
 *  whether the state actually landed anywhere durable. */
async function persistedCollapsed(page: import('@playwright/test').Page): Promise<unknown> {
  return page.evaluate(() => {
    const w = window as unknown as { __patch?: { nodes?: Record<string, { data?: Record<string, unknown> }> } };
    return w.__patch?.nodes?.sut?.data?.previewCollapsed;
  });
}

// -----------------------------------------------------------------------------
// THE FACE SURFACE - the default shell, which is what actually ships.
// -----------------------------------------------------------------------------

const FACE_TOGGLE = '[data-testid="freezeframe-face-screen-toggle"]';
const FACE_CANVAS = '[data-testid="freezeframe-face-canvas"]';

async function gotoShell(page: Page): Promise<void> {
  await freezeVideoRender(page);
  await page.goto('/rack');
  await expect(page.getByTestId('workflow-topbar'))
    .toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
}

/** Bring the node into the viewport. The lane band sits far down in flow space,
 *  so without this the tile is off-screen and every click times out - and it
 *  also ARMS the video visibility gate that decides whether the node renders.
 *  (backdraft-preview-toggle.spec.ts pattern.) */
async function centerOnNode(page: Page, nodeId: string, zoom = 0.9): Promise<void> {
  await page.evaluate(
    ({ nodeId, zoom }) => {
      const w = globalThis as unknown as {
        __flow: {
          getInternalNode: (id: string) => {
            internals?: { positionAbsolute?: { x: number; y: number } };
            position?: { x: number; y: number };
            measured?: { width?: number; height?: number };
          } | undefined;
          setViewport: (vp: { x: number; y: number; zoom: number }, o?: { duration?: number }) => void;
        };
      };
      const n = w.__flow.getInternalNode(nodeId);
      if (!n) return;
      const x = n.internals?.positionAbsolute?.x ?? n.position?.x ?? 0;
      const y = n.internals?.positionAbsolute?.y ?? n.position?.y ?? 0;
      const cx = x + (n.measured?.width ?? 192) / 2;
      const cy = y + (n.measured?.height ?? 180) / 2;
      const pane = document.querySelector('.svelte-flow') as HTMLElement;
      const r = pane.getBoundingClientRect();
      // Upper QUARTER, not the centre: the dock full view opens over the lower
      // half of the pane and would cover a centred tile.
      w.__flow.setViewport({ x: r.width / 2 - cx * zoom, y: r.height / 4 - cy * zoom, zoom }, { duration: 0 });
    },
    { nodeId, zoom },
  );
  await waitFrames(page, 4);
}

/** Spawn freezeframe on the DEFAULT shell and open its dock faceplate. */
async function openFace(page: Page) {
  await gotoShell(page);
  await spawnPatch(
    page,
    [{ id: 'sut', type: 'freezeframe', position: { x: 400, y: 60 }, domain: 'video', params: {} }],
    [],
  );
  await centerOnNode(page, 'sut');
  const shell = page.locator('.svelte-flow__node[data-id="sut"] [data-testid="module-shell"]');
  await expect(shell, 'the freezeframe shell tile')
    .toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
  await shell.getByTestId('shell-open-dock').click();
  const fv = page.getByTestId('dock-full-view');
  await expect(fv, 'the dock full view').toBeVisible();
  return fv;
}

test.describe('freezeframe: SCREEN ON / OFF - the FACE surface (what ships)', () => {
  test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS);

  test('the SCREEN switch is REACHABLE from the faceplate at all (#1934)', async ({ page }) => {
    // THIS IS THE LEG THE OLD SPEC COULD NOT HAVE HAD. Before the
    // `fullViewBody` extension existed there was NO screen switch anywhere a
    // player could reach, while this file's legs stayed green because they
    // drove a surface the feature did not ship on. It fails if
    // `freezeframeDef.face.extension` is dropped or its shell-extension stops
    // resolving, which is exactly the regression class #1928/#1934 name.
    await openFace(page);
    await expect(page.locator(FACE_TOGGLE), 'the SCREEN switch on the FACE')
      .toBeVisible();
  });

  test('it starts ON, collapses the picture, and RECLAIMS its space', async ({ page }) => {
    await openFace(page);
    const toggle = page.locator(FACE_TOGGLE);
    const canvas = page.locator(FACE_CANVAS);

    // Absent => false => ON, so an existing rack opens unchanged.
    await expect(toggle, 'starts ON').toHaveAttribute('aria-pressed', 'true');
    await expect(toggle).toHaveText('SCREEN ON');
    await expect(canvas, 'the picture is showing').toBeVisible();
    await expect
      .poll(async () => (await canvas.boundingBox())?.height ?? 0,
        { message: 'the preview occupies real vertical space when ON' })
      .toBeGreaterThan(50);

    await toggle.click();

    await expect(toggle, 'now OFF').toHaveAttribute('aria-pressed', 'false');
    await expect(toggle).toHaveText('SCREEN OFF');
    // RECLAIMED, not merely invisible - `visibility: hidden` would keep the
    // box and buy the player nothing, which is the point of the ruling.
    await expect(canvas, 'the picture is gone, not hidden').toHaveCount(0);
    // ...and the control that turns it back on did not vanish with the picture.
    await expect(toggle, 'the toggle survives its own OFF state').toBeVisible();

    await toggle.click();
    await expect(canvas, 'the picture returns').toBeVisible();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  });

  test('the state PERSISTS across closing and reopening the dock', async ({ page }) => {
    // The owner's stated floor, on the surface that ships. `node.data` is what
    // makes it survive; a component `$state` would pass every other assertion
    // here and fail this one, because this body unmounts with the dock (the
    // #1531/#1574/#1583 class).
    //
    // ONE round trip, not one per tab. The parked backdraft persistence test
    // clicked EVERY tab in a loop, which is n chances to lose one coin flip and
    // is why it recovered-on-retry 21 times (#1847). The invariant is
    // node-keyed, so one close/reopen proves it.
    await openFace(page);
    await page.locator(FACE_TOGGLE).click();
    await expect(page.locator(FACE_TOGGLE)).toHaveAttribute('aria-pressed', 'false');
    expect(await persistedCollapsed(page), 'OFF is persisted to the patch').toBe(true);

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('dock-full-view')).toHaveCount(0);

    const shell = page.locator('.svelte-flow__node[data-id="sut"] [data-testid="module-shell"]');
    await shell.getByTestId('shell-open-dock').click();
    await expect(page.getByTestId('dock-full-view')).toBeVisible();

    await expect(page.locator(FACE_TOGGLE), 'still OFF after a remount')
      .toHaveAttribute('aria-pressed', 'false');
    expect(await persistedCollapsed(page), 'and still persisted').toBe(true);
  });
});
