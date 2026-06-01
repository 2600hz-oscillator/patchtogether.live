// e2e/tests/atlantis-catalyst.spec.ts
//
// SCENECHANGE (internal type: atlantisCatalyst) end-to-end coverage.
// Two scenarios:
//   1. Card mounts under the new SCENECHANGE label.
//   2. Save slot 1 → twiddle live params → recall slot 1 → params restored.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

async function readLiveParam(page: Page, nodeId: string, paramId: string): Promise<number> {
  return await page.evaluate(
    ({ id, p }) => {
      const w = globalThis as unknown as {
        __engine?: () => {
          readParam: (node: { id: string; type: string; domain: string }, key: string) => unknown;
        } | null;
        __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
      };
      const eng = w.__engine?.();
      const node = w.__patch.nodes[id];
      if (!eng || !node) return NaN;
      const v = eng.readParam(node, p);
      return typeof v === 'number' ? v : NaN;
    },
    { id: nodeId, p: paramId },
  );
}

test('SCENECHANGE card mounts under new display label (type id unchanged)', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [
    { id: 'c', type: 'atlantisCatalyst', position: { x: 100, y: 100 } },
  ]);

  const card = page.locator('.svelte-flow__node-atlantisCatalyst');
  await expect(card).toHaveCount(1);
  // In-card title shows the bare-prefix auto-name (ATLANTISCATALYST) rather
  // than the def's display label (SCENECHANGE) — the editable name button
  // takes precedence over `defaultLabel` once `migrateAssignNames` runs at
  // spawn (see $lib/multiplayer/module-naming.ts). The internal type id is
  // still `atlantisCatalyst` (the `.svelte-flow__node-atlantisCatalyst`
  // selector above is the canonical type-id check).
  const nameButton = card.locator('[data-testid="name-label-button"]');
  await expect(nameButton).toHaveText(/^ATLANTISCATALYST(\d+)?$/);
  expect(errors, errors.join('; ')).toEqual([]);
});

test('SCENECHANGE: shift+click saves, click recalls live params', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [
    {
      id: 'c',
      type: 'atlantisCatalyst',
      position: { x: 100, y: 100 },
      // Auto-mode off so the timer doesn't re-roll mid-test.
      params: {
        driftRate: 0.25, chaos: 0.1, coherence: 0.6, sceneDepth: 0.5,
        autoMode: 0, bias: 0.2, level: 0.8,
      },
    },
  ]);

  // Let the engine spin up and drainInputAndStep land at least once.
  await page.waitForTimeout(300);

  // Save current state into slot 1 via shift+click.
  const slot1 = page.locator('[data-testid="catalyst-scene-1"]');
  await expect(slot1).toHaveAttribute('data-saved', '0');
  await slot1.click({ modifiers: ['Shift'] });

  // Slot should now show as saved (the indicator dot fills).
  await expect(slot1).toHaveAttribute('data-saved', '1');

  // Twiddle several params away from the saved values via the patch graph.
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { params: Record<string, number> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const t = w.__patch.nodes['c']!;
      t.params.driftRate = 0.9;
      t.params.chaos = 0.95;
      t.params.coherence = 0.05;
      t.params.bias = -0.9;
      t.params.level = 0.15;
    });
  });

  // Give drainInputAndStep a couple of ticks (25ms) to pick up the changes.
  await page.waitForTimeout(150);
  expect(await readLiveParam(page, 'c', 'driftRate')).toBeCloseTo(0.9, 3);
  expect(await readLiveParam(page, 'c', 'level')).toBeCloseTo(0.15, 3);

  // Click slot 1 → recall. Engine reads node.data.scenes['1'], applies it.
  await slot1.click();
  await page.waitForTimeout(250);

  // Live params should be back to the saved values.
  expect(await readLiveParam(page, 'c', 'driftRate')).toBeCloseTo(0.25, 2);
  expect(await readLiveParam(page, 'c', 'chaos')).toBeCloseTo(0.1, 2);
  expect(await readLiveParam(page, 'c', 'coherence')).toBeCloseTo(0.6, 2);
  expect(await readLiveParam(page, 'c', 'bias')).toBeCloseTo(0.2, 2);
  expect(await readLiveParam(page, 'c', 'level')).toBeCloseTo(0.8, 2);
});

test('SCENECHANGE: clicking an empty slot still triggers a transition (back-compat)', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [
    {
      id: 'c',
      type: 'atlantisCatalyst',
      position: { x: 100, y: 100 },
      params: { autoMode: 0, driftRate: 0.3 },
    },
  ]);

  await page.waitForTimeout(300);

  // No slot has been saved yet — clicking slot 3 should still cause the
  // scene index to land on 2 (0-indexed), even without a snapshot.
  const slot3 = page.locator('[data-testid="catalyst-scene-3"]');
  await expect(slot3).toHaveAttribute('data-saved', '0');
  await slot3.click();
  await page.waitForTimeout(150);

  const sceneIdx = await page.evaluate(() => {
    const w = globalThis as unknown as {
      __engine?: () => { read: (n: { id: string; type: string; domain: string }, k: string) => unknown } | null;
      __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
    };
    const eng = w.__engine?.(); const node = w.__patch.nodes['c'];
    if (!eng || !node) return NaN;
    const v = eng.read(node, 'scene');
    return typeof v === 'number' ? v : NaN;
  });
  expect(sceneIdx).toBe(2);
});
