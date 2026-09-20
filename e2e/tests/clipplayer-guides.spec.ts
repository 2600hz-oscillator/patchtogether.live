import { test, expect } from './_fixtures';

test('Clip Player illustrated guide preserves reference, bookmarks and mobile layout', async ({ page }, testInfo) => {
  await page.goto('/docs/modules/clipplayer');
  await expect(page.getByTestId('clipplayer-guide')).toBeVisible();
  await expect(page.locator('[data-testid="io-outputs"]')).toContainText('audio1L');
  await page.getByRole('link', { name:'Record & play audio', exact:true }).click();
  await expect(page).toHaveURL(/#audio$/);
  await expect(page.getByTestId('clip-guide-audio')).toBeVisible();
  await page.getByTestId('clip-guide-audio').screenshot({ path:testInfo.outputPath('clip-audio-guide.png') });
  await page.locator('#monome summary').click();
  await expect(page.locator('#monome svg')).toHaveCount(3);
  await page.setViewportSize({ width:390,height:844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.goto('/docs/modules/grid-clip-launcher#song-mode');
  await expect(page).toHaveURL(/\/clipplayer#song-mode$/);
  await expect(page.getByTestId('clip-guide-song')).toBeVisible();
});

test('Push mode guide shows its physical audio map and links to the canonical workflow', async ({ page }, testInfo) => {
  await page.goto('/docs/modules/push2Control');
  const guide = page.getByTestId('push2-pad-guide');
  await guide.getByRole('button', { name:'Audio',exact:true }).click();
  await expect(guide).toContainText('CC 43');
  await expect(guide).toContainText('REPLACE TAKE');
  await expect(guide).toContainText('physical Record button is unbound');
  await guide.locator('figure').screenshot({ path:testInfo.outputPath('push-audio-map.png') });
  await guide.getByRole('button', { name:'Clip',exact:true }).click();
  await expect(guide).toContainText('VEL HOLD');
  await guide.getByRole('checkbox', { name:'Show SHIFT layer' }).check();
  await expect(guide).toContainText('FOLLOW');
  await page.setViewportSize({ width:390,height:844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test('Launchpad single and pair audio guides retain keyboard-operable mode navigation', async ({ page }, testInfo) => {
  await page.goto('/docs/modules/launchpadControlLeft');
  await page.getByRole('tab', { name:'Audio', exact:true }).click();
  await expect(page.locator('#lp1-panel-audio')).toContainText('BANK UP / DOWN');
  await page.locator('#lp1-panel-audio figure').screenshot({ path:testInfo.outputPath('launchpad-audio-map.png') });
  await page.getByRole('tab', { name:'2 Launchpads', exact:true }).click();
  await page.getByRole('tab', { name:'Audio (Unit R)', exact:true }).click();
  await expect(page.locator('#lp2-panel-audio')).toContainText('PICK');
  await expect(page.locator('#lp2-panel-audio')).toContainText('AUTO');
  await page.locator('#lp2-panel-audio figure').screenshot({ path:testInfo.outputPath('launchpad-pair-audio-map.png') });
  await page.getByRole('tab', { name:'Audio (Unit R)', exact:true }).press('ArrowLeft');
  await expect(page.getByRole('tab', { name:'Audio (Unit R)', exact:true })).toHaveAttribute('aria-selected','false');
  await page.setViewportSize({ width:390,height:844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});
