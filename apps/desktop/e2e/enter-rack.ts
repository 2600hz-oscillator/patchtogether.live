import { expect, type Page } from '@playwright/test';

/** Every fresh launch reviews hardware. Use the real handoff without a user
 * gesture so boot.spec still proves gesture-free AudioContext startup. */
export async function enterRack(page: Page): Promise<void> {
  if (/\/rack(\?|$)/.test(page.url())) return;
  await page.waitForURL(/\/preflight(\?|$)/, { timeout: 60_000 });
  await expect(page.getByTestId('preflight-panel')).toBeVisible({ timeout: 60_000 });
  await page.evaluate(() => {
    const w = window as unknown as { ptNative: { command: (op: string) => Promise<unknown> } };
    void w.ptNative.command('preflight.done');
  });
  await page.waitForURL(/\/rack(\?|$)/, { timeout: 60_000 });
}
