// e2e/tests/noise.spec.ts
//
// NOISE module end-to-end: spawn the card, route each output through a
// scope so we can read amplitude back from the engine, assert each
// output produces non-zero signal.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

interface ScopeStats { peak: number; rms: number; nonzeroSamples: number; total: number; }

async function readScopeStats(page: Page, scopeNodeId: string): Promise<ScopeStats> {
  return await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __engine?: () => {
        read: (node: { id: string; type: string; domain: string }, key: string) => unknown;
      } | null;
      __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
    };
    const eng = w.__engine?.();
    if (!eng) return { peak: 0, rms: 0, nonzeroSamples: 0, total: 0 };
    const node = w.__patch.nodes[id];
    if (!node) return { peak: 0, rms: 0, nonzeroSamples: 0, total: 0 };
    const snap = eng.read(node, 'snapshot') as { ch1: Float32Array } | undefined;
    if (!snap) return { peak: 0, rms: 0, nonzeroSamples: 0, total: 0 };
    let peak = 0, energy = 0, nonzero = 0;
    for (let i = 0; i < snap.ch1.length; i++) {
      const v = snap.ch1[i];
      const a = Math.abs(v);
      if (a > peak) peak = a;
      energy += v * v;
      if (a > 1e-6) nonzero++;
    }
    return { peak, rms: Math.sqrt(energy / snap.ch1.length), nonzeroSamples: nonzero, total: snap.ch1.length };
  }, scopeNodeId);
}

test('noise: drop module → card mounts with no console errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [{ id: 'n', type: 'noise', position: { x: 200, y: 200 } }]);
  const card = page.locator('.svelte-flow__node-noise');
  await expect(card).toBeVisible();
  await expect(card).toContainText('NOISE');
  expect(errors, errors.join('; ')).toEqual([]);
});

test('noise: WHITE output produces non-zero audio at scope', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(
    page,
    [
      { id: 'n',   type: 'noise',    position: { x: 100, y: 100 }, params: { level: 0.8 } },
      { id: 'scp', type: 'scope',    position: { x: 400, y: 100 }, params: { timeMs: 50 } },
      { id: 'out', type: 'audioOut', position: { x: 700, y: 100 }, params: { master: 0.3 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'n',   portId: 'white'   }, to: { nodeId: 'scp', portId: 'ch1' } },
      { id: 'e2', from: { nodeId: 'scp', portId: 'ch1_out' }, to: { nodeId: 'out', portId: 'L'   } },
    ],
  );
  await page.waitForTimeout(700);
  const stats = await readScopeStats(page, 'scp');
  expect(stats.peak, `WHITE peak=${stats.peak}`).toBeGreaterThan(0.05);
  // White noise has many non-zero samples — well above 90% of buffer.
  expect(stats.nonzeroSamples).toBeGreaterThan(stats.total * 0.5);
});

test('noise: PINK output produces non-zero audio at scope', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(
    page,
    [
      { id: 'n',   type: 'noise',    params: { level: 0.8 } },
      { id: 'scp', type: 'scope',    params: { timeMs: 50 } },
      { id: 'out', type: 'audioOut', params: { master: 0.3 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'n',   portId: 'pink'    }, to: { nodeId: 'scp', portId: 'ch1' } },
      { id: 'e2', from: { nodeId: 'scp', portId: 'ch1_out' }, to: { nodeId: 'out', portId: 'L'   } },
    ],
  );
  await page.waitForTimeout(700);
  const stats = await readScopeStats(page, 'scp');
  expect(stats.peak, `PINK peak=${stats.peak}`).toBeGreaterThan(0.02);
  expect(stats.nonzeroSamples).toBeGreaterThan(stats.total * 0.5);
});

test('noise: BROWN output produces non-zero audio at scope', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(
    page,
    [
      { id: 'n',   type: 'noise',    params: { level: 0.8 } },
      { id: 'scp', type: 'scope',    params: { timeMs: 200 } },
      { id: 'out', type: 'audioOut', params: { master: 0.3 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'n',   portId: 'brown'   }, to: { nodeId: 'scp', portId: 'ch1' } },
      { id: 'e2', from: { nodeId: 'scp', portId: 'ch1_out' }, to: { nodeId: 'out', portId: 'L'   } },
    ],
  );
  await page.waitForTimeout(700);
  const stats = await readScopeStats(page, 'scp');
  expect(stats.peak, `BROWN peak=${stats.peak}`).toBeGreaterThan(0.01);
  expect(stats.nonzeroSamples).toBeGreaterThan(stats.total * 0.5);
});

test('noise: LEVEL=0 silences output', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(
    page,
    [
      { id: 'n',   type: 'noise',    params: { level: 0 } },
      { id: 'scp', type: 'scope',    params: { timeMs: 50 } },
      { id: 'out', type: 'audioOut', params: { master: 0.3 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'n',   portId: 'white'   }, to: { nodeId: 'scp', portId: 'ch1' } },
      { id: 'e2', from: { nodeId: 'scp', portId: 'ch1_out' }, to: { nodeId: 'out', portId: 'L'   } },
    ],
  );
  await page.waitForTimeout(500);
  const stats = await readScopeStats(page, 'scp');
  expect(stats.peak, `LEVEL=0 should silence (peak=${stats.peak})`).toBeLessThan(0.005);
});
