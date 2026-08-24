// TEMPORARY debug/visual-proof spec — deleted before the PR.
import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'serial' });

type Page = import('@playwright/test').Page;
type W = { __patch: { nodes: Record<string, { data?: { clips?: Record<string, unknown> } }> } };
async function dump(page: Page, label: string) {
  const d = await page.evaluate(
    () => JSON.parse(JSON.stringify((globalThis as unknown as W).__patch.nodes['cp'].data?.clips ?? null)),
  );
  console.log(label, JSON.stringify(d));
}

test('DEBUG undo after clear', async ({ page, rack }) => {
  await spawnPatch(page, [
    { id: 'tl', type: 'timelorde', position: { x: 40, y: 40 }, domain: 'audio' },
    { id: 'cp', type: 'clipplayer', position: { x: 420, y: 40 }, domain: 'audio' },
  ]);
  await expect(page.locator('[data-clip="0"]')).toBeVisible();
  await page.locator('[data-clip="0"]').dblclick();
  await expect(page.getByTestId('clipplayer-pianoroll')).toBeVisible();
  await dump(page, 'after ensureClip:');
  await page.getByTestId('clipplayer-cell-6-4').click();
  await expect.poll(async () => page.evaluate(() => {
    const c = (globalThis as unknown as W).__patch.nodes['cp'].data?.clips?.['0'] as { steps?: unknown[] };
    return c?.steps?.length ?? 0;
  })).toBe(1);
  await dump(page, 'after draw:');
  await page.getByTestId('clipplayer-cell-5-8').click();
  await expect.poll(async () => page.evaluate(() => {
    const c = (globalThis as unknown as W).__patch.nodes['cp'].data?.clips?.['0'] as { steps?: unknown[] };
    return c?.steps?.length ?? 0;
  })).toBe(2);
  await dump(page, 'after draw2:');
  await page.getByTestId('clipplayer-strip-6-cp').click();
  await dump(page, 'PROBE undo after 2 draws (expect 1 note left):');
  await page.getByTestId('clipplayer-strip-7-cp').click();
  await dump(page, 'PROBE redo:');
  await page.getByTestId('clipplayer-strip-2-cp').click();
  await page.locator('[data-clip="0"]').click({ button: 'right' });
  await page.getByTestId('clipplayer-menu-clear-cp').click();
  await dump(page, 'after clear:');
  await page.getByTestId('clipplayer-strip-6-cp').click();
  await dump(page, 'after undo 1:');
  await page.getByTestId('clipplayer-strip-6-cp').click();
  await dump(page, 'after undo 2:');
});
