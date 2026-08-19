// e2e/tests/freezeframe-screen-toggle.spec.ts
//
// SCREEN ON / OFF on the FREEZEFRAME card (owner ruling, 2026-08-18:
// "'screen on / off' on the card like that is a thing all video modules should
// have moving forward").
//
// THE OWNER'S STATED FLOOR IS PERSISTENCE — the on/off state must survive a tab
// switch — and nothing tested that on backdraft either, so it is the first leg
// here. The second is the one that makes this affordance different from
// "hide the canvas": the module KEEPS RENDERING while the screen is off, so
// switching it back on shows the LIVE picture rather than a stale frame. That
// is the #1720/#1721 bug class, and tearing the producer down is the tempting
// wrong implementation.
//
// ⚠ NO WALL-CLOCK WAITS. The one place this spec needs to know the renderer has
// advanced, it counts FRAMES through the shared `waitFrames` helper — a
// millisecond budget is a different number of frames on every renderer, and
// this is a video card.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { waitFrames } from '../_helpers/frames';
import { measureOverflow, describeReport, settleLayout } from './_card-overflow';

const CARD = '[data-testid="freezeframe-card"]';
const TOGGLE = '[data-testid="freezeframe-preview-toggle"]';
const CANVAS = '[data-testid="freezeframe-preview"]';

async function spawnFreezeframe(page: import('@playwright/test').Page) {
  await page.goto('/rack?shell=legacy&seed=none');
  await spawnPatch(
    page,
    [{ id: 'sut', type: 'freezeframe', position: { x: 400, y: 60 }, domain: 'video', params: {} }],
    [],
  );
  await expect(page.locator(CARD), 'freezeframe card visible').toBeVisible();
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

test.describe('freezeframe: SCREEN ON / OFF', () => {
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
    await spawnFreezeframe(page);

    await page.locator(TOGGLE).click();
    await settleLayout(page);
    await waitFrames(page, 30);
    await expect(page.locator(CANVAS), 'collapsed while off').toBeHidden();

    await page.locator(TOGGLE).click();
    await settleLayout(page);
    await waitFrames(page, 10);

    await expect(page.locator(CANVAS), 'the picture returns').toBeVisible();
    const box = await page.locator(CANVAS).evaluate((el) => el.getBoundingClientRect().height);
    expect(box, 'the preview has its space back').toBeGreaterThan(50);
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
