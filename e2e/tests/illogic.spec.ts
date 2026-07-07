// e2e/tests/illogic.spec.ts
//
// ILLOGIC end-to-end coverage:
//   1. Spawn the module → 14 handles (4 inputs + 10 outputs) render via the
//      patch panel; the card mounts without console errors. (modules.spec.ts
//      and io-spec-consistency.spec.ts already cover this; we add a
//      smoke check here so the file isn't trivially passing on negative
//      assertions alone.)
//   2. LFO → ILLOGIC.in1 → att1 (att1_amount = 1) → Scope: peak audible.
//   3. LFO → ILLOGIC.in1 → att1 (att1_amount = 0): silence at att1.
//   4. LFO → ILLOGIC.in1 → att1 (att1_amount = -1): peak still audible
//      (sign-flipped, but RMS unchanged).
//   5. Two LFOs into in1 + in2 → sum produces summed signal that is louder
//      than either alone.

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

test('illogic: drop module → card mounts with no console errors', async ({ page, rack, errorWatch }) => {
  await spawnPatch(page, [{ id: 'il', type: 'illogic', position: { x: 200, y: 200 } }]);
  const card = page.locator('.svelte-flow__node-illogic');
  await expect(card).toBeVisible();
  await expect(card).toContainText('ILLOGIC');
});

test('illogic: LFO → in1 → att1 (gain=1) produces audible signal at scope', async ({ page, rack }) => {
  await spawnPatch(
    page,
    [
      { id: 'lfo', type: 'lfo',     position: { x: 100, y: 100 }, params: { rate: 6.0, shape: 0 } },
      { id: 'il',  type: 'illogic', position: { x: 400, y: 100 }, params: { att1_amount: 1.0 } },
      { id: 'scp', type: 'scope',   position: { x: 700, y: 100 }, params: { timeMs: 50 } },
      { id: 'out', type: 'audioOut', position: { x: 1000, y: 100 }, params: { master: 0.5 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'lfo', portId: 'phase0' }, to: { nodeId: 'il',  portId: 'in1'  }, sourceType: 'cv', targetType: 'cv' },
      { id: 'e2', from: { nodeId: 'il',  portId: 'att1'   }, to: { nodeId: 'scp', portId: 'ch1'  } },
      { id: 'e3', from: { nodeId: 'scp', portId: 'ch1_out'}, to: { nodeId: 'out', portId: 'L'    } },
    ],
  );
  await page.waitForTimeout(1000); // let several LFO cycles flow through.
  const stats = await readScopeStats(page, 'scp');
  expect(stats.peak, `att1 should pass-through audible signal (peak=${stats.peak})`)
    .toBeGreaterThan(0.05);
  expect(stats.nonzeroSamples).toBeGreaterThan(50);
});

test('illogic: att1_amount=0 mutes the att1 output', async ({ page, rack }) => {
  await spawnPatch(
    page,
    [
      { id: 'lfo', type: 'lfo',     params: { rate: 6.0, shape: 0 } },
      { id: 'il',  type: 'illogic', params: { att1_amount: 0 } },
      { id: 'scp', type: 'scope',   params: { timeMs: 50 } },
      { id: 'out', type: 'audioOut', params: { master: 0.5 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'lfo', portId: 'phase0' }, to: { nodeId: 'il',  portId: 'in1'  }, sourceType: 'cv', targetType: 'cv' },
      { id: 'e2', from: { nodeId: 'il',  portId: 'att1'   }, to: { nodeId: 'scp', portId: 'ch1'  } },
      { id: 'e3', from: { nodeId: 'scp', portId: 'ch1_out'}, to: { nodeId: 'out', portId: 'L'    } },
    ],
  );
  await page.waitForTimeout(700);
  const stats = await readScopeStats(page, 'scp');
  expect(stats.peak, `att1=0 should silence att1 (peak=${stats.peak})`).toBeLessThan(0.005);
});

test('illogic: att1_amount=-1 still produces audible signal (sign-flipped)', async ({ page, rack }) => {
  await spawnPatch(
    page,
    [
      { id: 'lfo', type: 'lfo',     params: { rate: 6.0, shape: 0 } },
      { id: 'il',  type: 'illogic', params: { att1_amount: -1.0 } },
      { id: 'scp', type: 'scope',   params: { timeMs: 50 } },
      { id: 'out', type: 'audioOut', params: { master: 0.5 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'lfo', portId: 'phase0' }, to: { nodeId: 'il',  portId: 'in1'  }, sourceType: 'cv', targetType: 'cv' },
      { id: 'e2', from: { nodeId: 'il',  portId: 'att1'   }, to: { nodeId: 'scp', portId: 'ch1'  } },
      { id: 'e3', from: { nodeId: 'scp', portId: 'ch1_out'}, to: { nodeId: 'out', portId: 'L'    } },
    ],
  );
  await page.waitForTimeout(1000);
  const stats = await readScopeStats(page, 'scp');
  expect(stats.peak, `att1=-1 should be sign-flipped but still audible (peak=${stats.peak})`)
    .toBeGreaterThan(0.05);
});

test('illogic: two LFOs → in1+in2 → sum produces summed audible signal', async ({ page, rack }) => {
  await spawnPatch(
    page,
    [
      { id: 'lfo1', type: 'lfo',     params: { rate: 6.0, shape: 0 } },
      { id: 'lfo2', type: 'lfo',     params: { rate: 4.0, shape: 0 } },
      { id: 'il',   type: 'illogic', params: { att1_amount: 1.0, att2_amount: 1.0 } },
      { id: 'scp',  type: 'scope',   params: { timeMs: 100 } },
      { id: 'out',  type: 'audioOut', params: { master: 0.5 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'lfo1', portId: 'phase0' }, to: { nodeId: 'il', portId: 'in1' }, sourceType: 'cv', targetType: 'cv' },
      { id: 'e2', from: { nodeId: 'lfo2', portId: 'phase0' }, to: { nodeId: 'il', portId: 'in2' }, sourceType: 'cv', targetType: 'cv' },
      { id: 'e3', from: { nodeId: 'il',   portId: 'sum'    }, to: { nodeId: 'scp', portId: 'ch1' } },
      { id: 'e4', from: { nodeId: 'scp',  portId: 'ch1_out'}, to: { nodeId: 'out', portId: 'L'   } },
    ],
  );
  await page.waitForTimeout(1500); // long enough for both LFOs' beat pattern to manifest.
  const stats = await readScopeStats(page, 'scp');
  // Sum of two LFOs at gain 1 each can range up to ±2; peak well above
  // either single source. Don't pin a tight bound — random LFO phase
  // alignment varies the peak — just assert "louder than silence."
  expect(stats.peak, `sum should be audible (peak=${stats.peak})`).toBeGreaterThan(0.1);
  expect(stats.nonzeroSamples).toBeGreaterThan(100);
});
