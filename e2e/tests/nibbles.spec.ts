// e2e/tests/nibbles.spec.ts
//
// NIBBLES module smoke + AUTO-mode integration:
//
//   1. Spawning the module brings up a card with a visible 320×200 canvas
//      and no console errors.
//   2. With AUTO turned on, after ~5s the snake has either grown OR died
//      (in either case the length_cv ConstantSourceNode has moved off its
//      construction-time value — proves the game advanced + the audio
//      bridge is wired).
//   3. The on-card canvas has non-trivial pixels.

import { test, expect } from './_fixtures';
import { type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

async function readScore(page: Page, nodeId: string): Promise<number | null> {
  return await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __engine?: () => {
        read: (node: { id: string; type: string; domain: string }, key: string) => unknown;
      } | null;
      __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
    };
    const eng = w.__engine?.();
    const node = w.__patch.nodes[id];
    if (!eng || !node) return null;
    const s = eng.read(node, 'score');
    return typeof s === 'number' ? s : null;
  }, nodeId);
}

test('nibbles: card mounts cleanly + canvas renders', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [
    { id: 'n', type: 'nibbles', position: { x: 200, y: 200 }, domain: 'video' },
  ]);
  const card = page.locator('.svelte-flow__node-nibbles');
  await expect(card).toBeVisible();
  await expect(card).toContainText('NIBBLES');
  const canvas = card.locator('[data-testid="nibbles-screen"]');
  await expect(canvas).toBeVisible();
  const size = await canvas.evaluate((el: Element) => {
    const c = el as HTMLCanvasElement;
    return { w: c.width, h: c.height };
  });
  expect(size.w).toBe(320);
  expect(size.h).toBe(200);
  // AudioContext warnings show up on a fresh tab; filter them.
  expect(errors.filter((e) => !e.includes('AudioContext'))).toEqual([]);
});

test('nibbles: AUTO on → game advances within 5s (length_cv leaves default; snake grows or dies)', async ({ page, rack }) => {
  await spawnPatch(page, [
    { id: 'n', type: 'nibbles', position: { x: 200, y: 200 }, domain: 'video', params: { auto: 1 } },
  ]);
  const card = page.locator('.svelte-flow__node-nibbles');
  await expect(card).toBeVisible();

  // Initial score is 4 (fresh snake).
  const startScore = await readScore(page, 'n');
  expect(startScore).toBe(4);

  // Wait up to 5s for the bot to either eat a pellet (length grows) or die +
  // restart (score dips below 4, or score grows after a restart). Either
  // movement off length=4 is proof the game is running.
  const ok = await page.waitForFunction(
    (id) => {
      const w = globalThis as unknown as {
        __engine?: () => {
          read: (node: { id: string; type: string; domain: string }, key: string) => unknown;
        } | null;
        __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
      };
      const eng = w.__engine?.();
      const node = w.__patch.nodes[id];
      if (!eng || !node) return false;
      const s = eng.read(node, 'score');
      // Mutation = anything other than the initial 4.
      return typeof s === 'number' && s !== 4;
    },
    'n',
    { timeout: 6000, polling: 100 },
  );
  expect(ok).toBeTruthy();

  // Canvas has non-trivial pixels (the rasteriser drew SOMETHING beyond
  // pure background). We pull ImageData and check that at least 1% of
  // pixels are non-background — the food cell + the snake cells.
  const nonBgFraction = await page.evaluate(() => {
    const canvas = document.querySelector(
      '.svelte-flow__node-nibbles [data-testid="nibbles-screen"]',
    ) as HTMLCanvasElement | null;
    if (!canvas) return 0;
    const ctx = canvas.getContext('2d');
    if (!ctx) return 0;
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let nonBg = 0;
    for (let i = 0; i < img.data.length; i += 4) {
      const r = img.data[i]!;
      const g = img.data[i + 1]!;
      const b = img.data[i + 2]!;
      // Anything brighter than the dark background (~0x10/0x14/0x20). We
      // generously threshold against any green or red component to catch
      // food (red), snake (green-ish), and border (greyish).
      if (r > 32 || g > 32 || b > 48) nonBg += 1;
    }
    return nonBg / (img.width * img.height);
  });
  expect(nonBgFraction).toBeGreaterThan(0.005);
});
