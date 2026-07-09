import { test, expect } from './_fixtures';

test('clear after voice demo removes all nodes + edges', async ({ page, rack }) => {
  // Load example (5 nodes / 6 edges, sequencer auto-playing)
  await page.getByTestId('load-example-select').selectOption('sequenced-vco');
  await expect(page.locator('.svelte-flow__node')).toHaveCount(5, { timeout: 10_000 });
  await expect(page.locator('.svelte-flow__edge')).toHaveCount(6);

  // Click Clear
  await page.getByRole('button', { name: 'Clear' }).click();
  await page.waitForTimeout(300);

  // Assert canvas is empty
  await expect(page.locator('.svelte-flow__node')).toHaveCount(0);
  await expect(page.locator('.svelte-flow__edge')).toHaveCount(0);
});
