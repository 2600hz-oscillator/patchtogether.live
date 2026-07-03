// e2e/tests/mobile-mix.spec.ts
//
// MIX tab (/m/synth) — MIXMSTRS horizontal lanes + channel detail. Drags
// faders (relative, drag-committed), mutes (volume-0 + stash), and drives the
// 10-param channel detail (EQ center-detent + tap-to-zero, comp macro +
// advanced, sends). Param moves are asserted against the live store; a mute
// is asserted against the post-fader RMS so it's a real audible change.

import { test, expect } from '@playwright/test';
import { MOBILE_USE, bootFirstBleep, dragSliderBy, nodeParam, readMixLevels } from './_mobile-helpers';

test.use(MOBILE_USE);

async function openMix(page: import('@playwright/test').Page) {
  await page.getByTestId('m-tab-mix').tap();
  await expect(page.getByTestId('m-mix-lane-1')).toBeVisible();
}

test.describe('mix — lanes', () => {
  test('dragging a lane fader lowers the channel volume', async ({ page }) => {
    test.setTimeout(120_000);
    await bootFirstBleep(page);
    await openMix(page);
    const before = (await nodeParam(page, 'mixmstrs', 'ch1_volume')) ?? 0.8;
    await dragSliderBy(page, '[data-testid="m-mix-fader-1"]', -0.4);
    await expect
      .poll(() => nodeParam(page, 'mixmstrs', 'ch1_volume'))
      .toBeLessThan(before - 0.05);
  });

  test('the master fader writes master_volume', async ({ page }) => {
    test.setTimeout(120_000);
    await bootFirstBleep(page);
    await openMix(page);
    const before = (await nodeParam(page, 'mixmstrs', 'master_volume')) ?? 0.8;
    await dragSliderBy(page, '[data-testid="m-mix-fader-master"]', -0.3);
    await expect
      .poll(() => nodeParam(page, 'mixmstrs', 'master_volume'))
      .toBeLessThan(before - 0.05);
  });

  test('mute collapses the lane RMS; the same button unmutes + restores', async ({ page }) => {
    test.setTimeout(120_000);
    await bootFirstBleep(page);
    await openMix(page);
    // Meters before the mute.
    await expect.poll(async () => (await readMixLevels(page))[0] ?? 0, { timeout: 15_000 }).toBeGreaterThan(0.005);
    const stashedVol = (await nodeParam(page, 'mixmstrs', 'ch1_volume')) ?? 0.8;

    await page.getByTestId('m-mix-mute-1').tap();
    await expect(page.getByTestId('m-mix-mute-1')).toHaveAttribute('data-muted', 'true');
    expect(await nodeParam(page, 'mixmstrs', 'ch1_volume')).toBe(0);
    await expect
      .poll(async () => (await readMixLevels(page))[0] ?? 0, { timeout: 15_000 })
      .toBeLessThan(0.002);

    // Tapping the same button unmutes and restores the stashed volume.
    await page.getByTestId('m-mix-mute-1').tap();
    await expect(page.getByTestId('m-mix-mute-1')).toHaveAttribute('data-muted', 'false');
    expect(await nodeParam(page, 'mixmstrs', 'ch1_volume')).toBeCloseTo(stashedVol, 5);
  });
});

test.describe('mix — channel detail', () => {
  test('opens, chevrons step channels, done closes', async ({ page }) => {
    test.setTimeout(120_000);
    await bootFirstBleep(page);
    await openMix(page);
    await page.getByTestId('m-mix-label-1').tap();
    const detail = page.getByTestId('m-channel-detail');
    await expect(detail).toBeVisible();
    await expect(detail.getByText('CH1', { exact: true })).toBeVisible();
    await page.getByLabel('next channel').tap();
    await expect(detail.getByText('CH2', { exact: true })).toBeVisible();
    await page.getByTestId('m-detail-close').tap();
    await expect(page.getByTestId('m-channel-detail')).toHaveCount(0);
  });

  test('EQ low is center-detented; drag moves it, tap-label zeroes it', async ({ page }) => {
    test.setTimeout(120_000);
    await bootFirstBleep(page);
    await openMix(page);
    await page.getByTestId('m-mix-label-1').tap();
    await expect(page.getByTestId('m-channel-detail')).toBeVisible();

    expect((await nodeParam(page, 'mixmstrs', 'ch1_low')) ?? 0).toBe(0);
    await dragSliderBy(page, '[data-testid="m-detail-low"] .hs-track', 0.3);
    await expect.poll(() => nodeParam(page, 'mixmstrs', 'ch1_low')).toBeGreaterThan(1);
    // Tap the label to snap back to 0 dB (EQ tap-to-zero affordance).
    await page.locator('[data-testid="m-detail-low"] .hs-label').tap();
    await expect.poll(() => nodeParam(page, 'mixmstrs', 'ch1_low')).toBe(0);
  });

  test('comp macro + advanced params write the store', async ({ page }) => {
    test.setTimeout(120_000);
    await bootFirstBleep(page);
    await openMix(page);
    await page.getByTestId('m-mix-label-1').tap();
    await expect(page.getByTestId('m-channel-detail')).toBeVisible();

    // The one-knob comp macro.
    await dragSliderBy(page, '[data-testid="m-detail-comp"] .hs-track', 0.5);
    await expect.poll(() => nodeParam(page, 'mixmstrs', 'comp1')).toBeGreaterThan(0.1);

    // Advanced reveals thresh/ratio/enable.
    await page.getByTestId('m-detail-advanced').tap();
    await expect(page.getByTestId('m-detail-thresh')).toBeVisible();
    const enBefore = (await nodeParam(page, 'mixmstrs', 'ch1_compEnable')) ?? 0;
    await page.getByTestId('m-detail-comp-enable').tap();
    await expect.poll(() => nodeParam(page, 'mixmstrs', 'ch1_compEnable')).not.toBe(enBefore);

    // A send moves too.
    await dragSliderBy(page, '[data-testid="m-detail-send1"] .hs-track', 0.4);
    await expect.poll(() => nodeParam(page, 'mixmstrs', 'ch1_send1')).toBeGreaterThan(0.1);
  });
});
