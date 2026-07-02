// e2e/tests/sequencer-clock.spec.ts
//
// Sequencer clock chaining: when seqA's `clock` output is patched to seqB's
// `clock` input, seqB advances on seqA's pulses (one step per pulse) instead
// of its internal BPM. Disconnect → seqB falls back to internal BPM.
//
// Test strategy: configure seqA fast (480 BPM, 16th notes ⇒ 8 pulses/sec) and
// seqB slow (30 BPM internal ⇒ 0.5 steps/sec). After 600 ms with the chain
// connected, seqB.currentStep should have advanced ~4 steps. Without the
// chain, it would have advanced ~0 steps. Use a healthy margin.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

test('sequencer-clock: external clock advances slower sequencer at the faster rate', async ({
  page,
}) => {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');

  await spawnPatch(
    page,
    [
      {
        id: 'seqA',
        type: 'sequencer',
        // Fast internal BPM, length 4 ⇒ 8 16th-note pulses per second
        params: { bpm: 480, length: 4, isPlaying: 1 },
      },
      {
        id: 'seqB',
        type: 'sequencer',
        // Slow internal BPM ⇒ 0.5 steps/sec without external clock
        params: { bpm: 30, length: 16, isPlaying: 1 },
      },
    ],
    [
      {
        id: 'eclk',
        from: { nodeId: 'seqA', portId: 'clock' },
        to: { nodeId: 'seqB', portId: 'clock' },
        sourceType: 'gate',
        targetType: 'gate',
      },
    ],
  );

  // Let the chain run.
  await page.waitForTimeout(600);

  const seqBStep = await page.evaluate(() => {
    const w = globalThis as unknown as {
      __engine?: () => {
        read: (node: { id: string; type: string; domain: string }, key: string) => unknown;
      } | null;
      __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
    };
    const eng = w.__engine?.();
    if (!eng) return -1;
    const seqB = w.__patch.nodes['seqB'];
    const cs = eng.read(seqB, 'totalAdvances');
    return typeof cs === 'number' ? cs : -1;
  });

  // Expected: seqA at 480 BPM 16th-notes = 8 pulses/sec. In 600ms ≈ 4.8 advances.
  // seqB internal BPM at 30 = 0.5 steps/sec. In 600ms ≈ 0.3 (rounds to 0).
  // External clock should win — assert seqB stepped at least 3 times.
  expect(seqBStep, `seqB.currentStep after 600ms should reflect external clock`).toBeGreaterThanOrEqual(3);
});

test('sequencer-clock: without chain, sequencer uses internal BPM', async ({ page }) => {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');

  await spawnPatch(
    page,
    [
      {
        id: 'seqAlone',
        type: 'sequencer',
        // 30 BPM ⇒ 0.5 steps/sec. In 600ms ≈ 0 advances.
        params: { bpm: 30, length: 16, isPlaying: 1 },
      },
    ],
    [], // no edges — no external clock
  );

  await page.waitForTimeout(600);

  const step = await page.evaluate(() => {
    const w = globalThis as unknown as {
      __engine?: () => {
        read: (node: { id: string; type: string; domain: string }, key: string) => unknown;
      } | null;
      __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
    };
    const eng = w.__engine?.();
    if (!eng) return -1;
    const node = w.__patch.nodes['seqAlone'];
    const cs = eng.read(node, 'totalAdvances');
    return typeof cs === 'number' ? cs : -1;
  });

  // Without external clock, 30 BPM 16th = 0.5 steps/sec. In 600ms ≈ 1-2 advances.
  expect(step, `seqAlone advances slowly via internal BPM`).toBeLessThanOrEqual(3);
});
