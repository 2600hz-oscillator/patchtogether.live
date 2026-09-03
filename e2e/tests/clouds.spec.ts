// e2e/tests/clouds.spec.ts
//
// CLOUDS end-to-end smoke test on the shell the user gets: the tile mounts,
// and the FREEZE switch drives the param both ways (the card's active-class
// assertion, re-anchored on the param + aria-checked state).

import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

test('CLOUDS freeze switch on the tile drives node.params.freeze (and says so via aria)', async ({ page, rack }) => {
  await spawnPatch(
    page,
    [
      { id: 'a-cl',  type: 'clouds',   position: { x: 100, y: 100 }, domain: 'audio' },
    ],
    [],
  );

  const tile = page.locator('.svelte-flow__node[data-id="a-cl"] [data-testid="module-shell"]');
  await expect(tile).toBeVisible();

  const freeze = tile.getByTestId('control-freeze');
  await expect(freeze).toBeVisible();

  const readFreeze = () =>
    page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params?: Record<string, number> }> };
      };
      return Math.round(w.__patch.nodes['a-cl']?.params?.freeze ?? 0);
    });

  expect(await readFreeze()).toBe(0);
  await expect(freeze).toHaveAttribute('aria-checked', 'false');

  await freeze.click();
  await expect.poll(readFreeze).toBe(1);
  await expect(freeze).toHaveAttribute('aria-checked', 'true');

  await freeze.click();
  await expect.poll(readFreeze).toBe(0);
  await expect(freeze).toHaveAttribute('aria-checked', 'false');
});
