// e2e/tests/freezeframe-screen-toggle.spec.ts
//
// SCREEN ON / OFF on FREEZEFRAME — on BOTH surfaces it ships with (owner
// ruling, 2026-08-18: "'screen on / off' on the card like that is a thing all
// video modules should have moving forward").
//
// ⚠ THIS FILE USED TO TEST ONE SURFACE, AND IT WAS THE WRONG ONE (#1934).
// Every leg opened `/rack?shell=legacy`, which renders the LEGACY CARD — and
// `?shell=legacy` is precisely the surface that promotion does NOT change.
// freezeframe entered `STRICT_FACES` in the same change that added this
// toggle, which makes `migrated()` true and stops BOTH default surfaces from
// rendering the card (`DockFullView.svelte:319` mounts `<ModuleShell>`
// instead). So the control was deleted by its own promotion, and this spec
// PASSED THROUGHOUT and would have gone on passing — a gate whose precondition
// is the defect cannot fail on the defect (CLAUDE.md, the #1796 class).
//
// The fix is to test the shell the feature SHIPS ON, not only the one that is
// convenient to drive. Two describes below:
//   * THE FACE (default `/rack`) — the shipping surface. The toggle arrives
//     through the `fullViewBody` shell extension. These legs FAIL if the
//     extension is missing, which is the regression #1934 names.
//   * THE LEGACY CARD (`?shell=legacy`) — still a real surface while the
//     legacy UI exists, and the card half of the ruling. Kept, not deleted.
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
import { measureOverflow, describeReport, settleLayout } from './_card-overflow';
import { waitFrames } from '../_helpers/frames';

const CARD = '[data-testid="freezeframe-card"]';
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
 * visible, does its box have height, is it the same element, does any control
 * escape the card. None of them reads a pixel. The one claim that IS about the
 * render continuing to run lives in `freezeframe-screen-source.test.ts`, where
 * it is checked at the source precisely because no runtime gate here can see
 * it. Same lever `card-control-overflow.spec.ts` pulls for backdraft.
 */
async function freezeVideoRender(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (globalThis as unknown as { __videoEngineFreezeRender?: boolean })
      .__videoEngineFreezeRender = true;
  });
}

async function spawnFreezeframe(page: Page) {
  await freezeVideoRender(page);
  await page.goto('/rack?shell=legacy&seed=none');
  await spawnPatch(
    page,
    [{ id: 'sut', type: 'freezeframe', position: { x: 400, y: 60 }, domain: 'video', params: {} }],
    [],
  );
  // BOUNDED, not asserted: a bare `toBeVisible()` takes Playwright's 5 s expect
  // default, which is a different assertion on every runner (#1875/#1906).
  await expect(page.locator(CARD), 'freezeframe card visible')
    .toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
  await settleLayout(page);
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

test.describe('freezeframe: SCREEN ON / OFF — the LEGACY CARD surface', () => {
  // The SwiftShader budget, from the ONE export site rather than a literal —
  // a flat wall-clock number is a different assertion on every runner, and
  // CI's two-core boxes swing >=2x run-to-run on identical code (#1860/#1906).
  // This BOUNDS the failure; it is not what any test here asserts.
  test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS);

  test('the toggle starts ON, collapses the picture, and RECLAIMS its space', async ({ page }) => {
    await spawnFreezeframe(page);

    const toggle = page.locator(TOGGLE);
    const canvas = page.locator(CANVAS);

    // Absent => false => ON, so an existing rack opens unchanged.
    await expect(toggle, 'starts ON').toHaveAttribute('aria-pressed', 'true');
    await expect(toggle).toHaveText('SCREEN ON');
    await expect(canvas, 'the picture is showing').toBeVisible();

    const shownHeight = await canvas.evaluate((el) => el.getBoundingClientRect().height);
    expect(shownHeight, 'the preview occupies real vertical space when ON').toBeGreaterThan(50);

    await toggle.click();
    await settleLayout(page);

    await expect(toggle, 'now OFF').toHaveAttribute('aria-pressed', 'false');
    await expect(toggle).toHaveText('SCREEN OFF');
    await expect(canvas, 'the picture is collapsed').toBeHidden();

    // ⚠ RECLAIMED, not merely invisible. `visibility: hidden` would keep the
    // box and buy the player nothing, which is the point of the ruling.
    const collapsedBox = await canvas.evaluate((el) => el.getBoundingClientRect().height);
    expect(collapsedBox, 'the collapsed canvas takes NO vertical space').toBe(0);

    // …and the control that turns it back on did not vanish with the picture.
    await expect(toggle, 'the toggle survives its own OFF state').toBeVisible();
  });

  test('the state PERSISTS — it is on node.data, not component state', async ({ page }) => {
    // The owner's stated floor. `node.data` is what makes it survive a tab
    // switch, a remount and a reload; a `$state` boolean would pass every other
    // assertion in this file and fail this one.
    await spawnFreezeframe(page);
    expect(await persistedCollapsed(page), 'nothing written before the first click').toBeFalsy();

    await page.locator(TOGGLE).click();
    await settleLayout(page);
    expect(await persistedCollapsed(page), 'OFF is persisted to the patch').toBe(true);

    await page.locator(TOGGLE).click();
    await settleLayout(page);
    expect(await persistedCollapsed(page), 'ON is persisted too').toBe(false);
  });

  test('the picture comes BACK after an OFF/ON round trip, and the card survives it', async ({ page }) => {
    // ⚠ WHAT THIS LEG DOES AND DOES NOT PROVE, stated because the first draft
    // of it proved NOTHING. It reached for a `window.__videoEngine.hasNode`
    // hook to assert the node was still in the engine's render set with the
    // screen off. That hook DOES NOT EXIST, so the probe returned null, the
    // assertion was skipped, and the test passed green while measuring
    // nothing — a gate whose failing case is unreachable.
    //
    // The honest split: this test covers the OBSERVABLE half (the round trip
    // restores a real, sized, visible picture and nothing in the card breaks),
    // and the half no runtime gate here can see — that `draw()` RE-ARMS its
    // rAF while collapsed rather than returning dead — is asserted at the
    // SOURCE in `freezeframe-screen-source.test.ts`. That is the repo's
    // standing answer for an invariant no runtime gate can observe
    // (`card-range-source`, `face-readout-source`).
    // ⚠ THE FRAME WAITS THAT USED TO BE HERE ARE GONE, and their absence is the
    // fix rather than a shortcut. `waitFrames(30)` / `waitFrames(10)` were
    // left over from the draft that carried the vacuous `__videoEngine.hasNode`
    // probe: once that claim moved to the source gate, the frames backed NO
    // assertion at all — nothing between them and the next `expect` read a
    // rendered pixel. What each `expect` below actually needs is STATE
    // readiness, and CLAUDE.md is explicit that state readiness is an
    // auto-retrying `expect` on the real subject, never a frame count and
    // never a wall-clock wait. Auto-retry also cannot be starved by the card's
    // own render loop the way an injected rAF promise was.
    await spawnFreezeframe(page);

    await page.locator(TOGGLE).click();
    await expect(page.locator(CANVAS), 'collapsed while off').toBeHidden();

    await page.locator(TOGGLE).click();
    await expect(page.locator(CANVAS), 'the picture returns').toBeVisible();

    // the box has real height again — polled on the subject, not on a clock
    await expect
      .poll(
        async () => (await page.locator(CANVAS).boundingBox())?.height ?? 0,
        { message: 'the preview has its space back' },
      )
      .toBeGreaterThan(50);

    await expect(page.locator(TOGGLE)).toHaveAttribute('aria-pressed', 'true');
    // the canvas is still the same live element, not a remounted blank one
    await expect(page.locator(CANVAS)).toHaveAttribute('data-node-id', 'sut');
  });

  test('nothing overflows the card in EITHER state', async ({ page }) => {
    // The button rides the existing OUT caption row precisely because this card
    // is 3u and the rack clamps it to a hard 540 CSS px. Measured with the
    // gate's own helper so the number means what the other cards' numbers mean.
    await spawnFreezeframe(page);

    const on = await measureOverflow(page, 'freezeframe');
    expect(on.worstBottom, `SCREEN ON — ${describeReport(on)}`).toBeLessThanOrEqual(0);
    expect(on.worstRight, `SCREEN ON — ${describeReport(on)}`).toBeLessThanOrEqual(0);

    await page.locator(TOGGLE).click();
    await settleLayout(page);

    const off = await measureOverflow(page, 'freezeframe');
    expect(off.worstBottom, `SCREEN OFF — ${describeReport(off)}`).toBeLessThanOrEqual(0);
    expect(off.worstRight, `SCREEN OFF — ${describeReport(off)}`).toBeLessThanOrEqual(0);
  });
});

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
    // THIS IS THE LEG THE OLD SPEC COULD NOT HAVE HAD. Promotion deletes the
    // card from both default surfaces, so before the `fullViewBody` extension
    // existed there was NO screen switch anywhere a player could reach - while
    // every legacy-card leg in this file stayed green. It fails if
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
