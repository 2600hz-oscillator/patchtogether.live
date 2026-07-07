// e2e/tests/noise.spec.ts
//
// NOISE behavioral e2e: LEVEL=0 must silence the output (a knob-value →
// definite-silence contract the registry sweeps don't pin — they only
// assert each output EMITS when driven). Mount smoke + per-output
// "white/pink/brown emit non-silence" tests were deleted as weaker
// duplicates of the per-module-per-port emit sweep + the per-module
// output-alive check (LoC campaign row 2).

import { test, expect } from './_fixtures';
import { type Page } from '@playwright/test';
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

test('noise: LEVEL=0 silences output', async ({ page, rack }) => {
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
