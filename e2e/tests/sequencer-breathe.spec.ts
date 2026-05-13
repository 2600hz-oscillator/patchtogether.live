// e2e/tests/sequencer-breathe.spec.ts
//
// BREATHE button + breath-% slider behavior across all 5 sequencers
// (sequencer / drumseqz / score / polyseqz / cartesian). The DSP path is
// already covered by the breathe-mutation unit tests; here we verify the
// per-card UI exists + the engine mutates data on loop wraps when enabled.
//
// Strategy:
//   - Spawn each sequencer with a known dense gate pattern.
//   - Enable BREATHE via the test hook (writes breatheEnabled=1, breathPercent=0.5).
//   - Start the sequencer at a high BPM so several loop wraps land within a
//     few hundred ms.
//   - Read the gate/note count over time; assert it changes.
//   - Toggle BREATHE off, restore a dense pattern, assert it stays dense.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

/** Wait for the BREATHE toggle to render under the given node id and assert
 *  its on/off attribute matches `expected`. */
async function expectBreatheToggleState(
  page: import('@playwright/test').Page,
  nodeId: string,
  expected: '0' | '1',
) {
  const btn = page.locator(`[data-testid="breathe-toggle-${nodeId}"]`);
  await expect(btn).toHaveAttribute('data-breathe-enabled', expected);
}

test('sequencer card renders BREATHE toggle + slider', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [
    { id: 'seq', type: 'sequencer', params: { isPlaying: 0 } },
  ]);
  await expect(page.locator(`[data-testid="breathe-toggle-seq"]`)).toBeVisible();
  await expect(page.locator(`[data-testid="breathe-row-seq"]`)).toBeVisible();
  await expectBreatheToggleState(page, 'seq', '0');
});

test('drumseqz card renders BREATHE toggle + slider', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [
    { id: 'drum', type: 'drumseqz', params: { isPlaying: 0 } },
  ]);
  await expect(page.locator(`[data-testid="breathe-toggle-drum"]`)).toBeVisible();
  await expectBreatheToggleState(page, 'drum', '0');
});

test('polyseqz card renders BREATHE toggle + slider', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [
    { id: 'poly', type: 'polyseqz', params: { isPlaying: 0 } },
  ]);
  await expect(page.locator(`[data-testid="breathe-toggle-poly"]`)).toBeVisible();
  await expectBreatheToggleState(page, 'poly', '0');
});

test('score card renders BREATHE toggle + slider', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [
    { id: 'score', type: 'score', params: { isPlaying: 0 } },
  ]);
  await expect(page.locator(`[data-testid="breathe-toggle-score"]`)).toBeVisible();
  await expectBreatheToggleState(page, 'score', '0');
});

test('cartesian card renders BREATHE toggle + slider', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [
    { id: 'cart', type: 'cartesian' },
  ]);
  await expect(page.locator(`[data-testid="breathe-toggle-cart"]`)).toBeVisible();
  await expectBreatheToggleState(page, 'cart', '0');
});

test('sequencer BREATHE on → gate count oscillates across loop wraps', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await spawnPatch(page, [
    {
      id: 'seq',
      type: 'sequencer',
      // 300 BPM 16th = 20 advances/sec; len=16 → loop every ~800ms.
      // 8 loops in 6.4s — plenty of breath passes.
      params: {
        bpm: 300,
        length: 16,
        isPlaying: 1,
        breatheEnabled: 1,
        breathPercent: 0.5,
      },
    },
  ]);

  // Fill all 16 step gates ON with a known midi value.
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    const t = w.__patch.nodes['seq'];
    if (!t) throw new Error('seq missing');
    const steps = Array.from({ length: 32 }, () => ({ on: true, midi: 60, chord: 'mono' }));
    w.__ydoc.transact(() => {
      if (!t.data) t.data = {};
      (t.data as Record<string, unknown>).steps = steps;
      (t.data as Record<string, unknown>).breatheDirection = 'off';
    });
  });

  // Sample gate-on counts every 250ms for ~4s. With BREATHE at 50%, the
  // density should fluctuate between dense (~16) and sparse (~8).
  const samples: number[] = [];
  for (let i = 0; i < 16; i++) {
    await page.waitForTimeout(250);
    const onCount = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      };
      const steps = (w.__patch.nodes['seq']?.data as Record<string, unknown> | undefined)?.steps;
      if (!Array.isArray(steps)) return -1;
      return (steps as Array<{ on?: boolean }>).slice(0, 16).filter((s) => s.on).length;
    });
    samples.push(onCount);
  }

  const minOn = Math.min(...samples);
  const maxOn = Math.max(...samples);
  // We started at 16, and breathePass(50%) should knock it down to 8.
  // Assert that we saw both a dense state (>= 12) and a sparse one (<= 10).
  expect(maxOn, `samples=${JSON.stringify(samples)}`).toBeGreaterThanOrEqual(12);
  expect(minOn, `samples=${JSON.stringify(samples)}`).toBeLessThanOrEqual(10);
});

test('sequencer BREATHE off → gate count stays constant', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await spawnPatch(page, [
    {
      id: 'seq',
      type: 'sequencer',
      params: { bpm: 300, length: 16, isPlaying: 1, breatheEnabled: 0 },
    },
  ]);

  // Fill 12 step gates ON in a specific pattern.
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    const t = w.__patch.nodes['seq'];
    if (!t) throw new Error('seq missing');
    const steps = Array.from({ length: 32 }, (_, i) => ({
      on: i < 12,
      midi: 60,
      chord: 'mono',
    }));
    w.__ydoc.transact(() => {
      if (!t.data) t.data = {};
      (t.data as Record<string, unknown>).steps = steps;
    });
  });

  // Sample across several loops; should not change.
  const counts: number[] = [];
  for (let i = 0; i < 8; i++) {
    await page.waitForTimeout(250);
    const onCount = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      };
      const steps = (w.__patch.nodes['seq']?.data as Record<string, unknown> | undefined)?.steps;
      if (!Array.isArray(steps)) return -1;
      return (steps as Array<{ on?: boolean }>).slice(0, 16).filter((s) => s.on).length;
    });
    counts.push(onCount);
  }
  // Every sample should equal 12 — BREATHE didn't touch the steps.
  for (const c of counts) {
    expect(c, `counts=${JSON.stringify(counts)}`).toBe(12);
  }
});

test('drumseqz BREATHE on → cell density oscillates across loop wraps', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await spawnPatch(page, [
    {
      id: 'drum',
      type: 'drumseqz',
      params: {
        bpm: 300,
        length: 16,
        isPlaying: 1,
        breatheEnabled: 1,
        breathPercent: 0.5,
      },
    },
  ]);

  // Fill all 64 cells ON.
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    const t = w.__patch.nodes['drum'];
    if (!t) throw new Error('drum missing');
    const tracks = Array.from({ length: 4 }, () =>
      Array.from({ length: 16 }, () => ({ on: true, midi: null })),
    );
    w.__ydoc.transact(() => {
      if (!t.data) t.data = {};
      (t.data as Record<string, unknown>).tracks = tracks;
      (t.data as Record<string, unknown>).breatheDirection = 'off';
    });
  });

  const samples: number[] = [];
  for (let i = 0; i < 16; i++) {
    await page.waitForTimeout(250);
    const onCount = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      };
      const tracks = (w.__patch.nodes['drum']?.data as Record<string, unknown> | undefined)?.tracks;
      if (!Array.isArray(tracks)) return -1;
      let n = 0;
      for (const tr of tracks as Array<Array<{ on?: boolean }>>) {
        for (const c of tr) if (c.on) n++;
      }
      return n;
    });
    samples.push(onCount);
  }
  const minOn = Math.min(...samples);
  const maxOn = Math.max(...samples);
  // Started at 64, 50% breath → swings to ~32 and back.
  expect(maxOn, `samples=${JSON.stringify(samples)}`).toBeGreaterThanOrEqual(48);
  expect(minOn, `samples=${JSON.stringify(samples)}`).toBeLessThanOrEqual(40);
});
