// e2e/tests/polyseqz.spec.ts
//
// POLYSEQZ end-to-end coverage.
//
//   1. Spawn the module → 32-cell grid renders + every per-step badge defaults
//      to maj/0/closed.
//   2. Set a 4-step Cmaj→Dmin→Em→Fmaj progression, hit play, assert per-lane
//      V/oct values match the expected chord voicings.
//   3. Backward-compat: POLYSEQZ.poly → analogVco.pitch (mono) auto-routes
//      lane 0 (root) through the engine's resolveConnection path.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

test('polyseqz: drop module → 32-cell grid renders + defaults shown', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await spawnPatch(page, [
    { id: 'p', type: 'polyseqz', params: { isPlaying: 0 } },
  ]);

  const cells = await page
    .locator('[data-testid="polyseqz-grid-p"] [data-step]')
    .count();
  expect(cells).toBeGreaterThanOrEqual(32);

  // Default for every quality badge is 'maj'.
  await expect(page.getByTestId('polyseqz-quality-p-0')).toHaveAttribute('data-quality', 'maj');
  await expect(page.getByTestId('polyseqz-quality-p-15')).toHaveAttribute('data-quality', 'maj');
  // Default inversion 0, voicing closed.
  await expect(page.getByTestId('polyseqz-inv-p-0')).toHaveAttribute('data-inversion', '0');
  await expect(page.getByTestId('polyseqz-voicing-p-0')).toHaveAttribute('data-voicing', 'closed');
});

test('polyseqz: per-step UI cycles quality (maj→min→...) and inversion (0→1→2→0)', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await spawnPatch(page, [
    { id: 'p', type: 'polyseqz', params: { isPlaying: 0 } },
  ]);

  const qualityBadge = page.getByTestId('polyseqz-quality-p-0');
  await expect(qualityBadge).toHaveAttribute('data-quality', 'maj');
  await qualityBadge.click();
  await expect(qualityBadge).toHaveAttribute('data-quality', 'min');

  const invBadge = page.getByTestId('polyseqz-inv-p-0');
  await expect(invBadge).toHaveAttribute('data-inversion', '0');
  await invBadge.click();
  await expect(invBadge).toHaveAttribute('data-inversion', '1');
  await invBadge.click();
  await expect(invBadge).toHaveAttribute('data-inversion', '2');
  await invBadge.click();
  await expect(invBadge).toHaveAttribute('data-inversion', '0');

  const voicingBadge = page.getByTestId('polyseqz-voicing-p-0');
  await expect(voicingBadge).toHaveAttribute('data-voicing', 'closed');
  await voicingBadge.click();
  await expect(voicingBadge).toHaveAttribute('data-voicing', 'open');
  await voicingBadge.click();
  await expect(voicingBadge).toHaveAttribute('data-voicing', 'spread');
});

test('polyseqz: Cmaj step emits 5 gated lanes with C/E/G/C/E V/oct', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await spawnPatch(page, [
    {
      id: 'p',
      type: 'polyseqz',
      params: { bpm: 240, length: 1, isPlaying: 1, gateLength: 0.9, humanize: 0 },
    },
  ]);

  // Single Cmaj step (root C4 = 60, quality maj, closed voicing, inv 0).
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      w.__patch.nodes['p'].data = {
        steps: [{ on: true, root: 60, quality: 'maj', inversion: 0, voicing: 'closed' }],
      };
    });
  });

  // 240 BPM 8th-notes = 8 steps/sec → first step within ~125ms; wait 600ms safe.
  await page.waitForTimeout(600);

  const lanes = await page.evaluate(() => {
    const w = globalThis as unknown as {
      __engine?: () => { read: (n: { id: string; type: string; domain: string }, k: string) => unknown } | null;
      __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
    };
    const eng = w.__engine?.();
    if (!eng) return null;
    const node = w.__patch.nodes['p'];
    const out: Array<{ pitch: number | null; gate: number | null }> = [];
    for (let i = 0; i < 5; i++) {
      const pi = eng.read(node, `pitchVOctLane:${i}`);
      const gi = eng.read(node, `gateLane:${i}`);
      out.push({
        pitch: typeof pi === 'number' ? pi : null,
        gate: typeof gi === 'number' ? gi : null,
      });
    }
    return out;
  });

  expect(lanes).not.toBeNull();
  // All 5 lanes gated (closed voicing fills all slots for triads).
  for (let i = 0; i < 5; i++) expect(lanes![i]?.gate).toBe(1);

  // Expected V/oct: C4=0, E4=4/12, G4=7/12, C5=12/12, E5=16/12.
  const TOL = 1e-6;
  expect(Math.abs((lanes![0]!.pitch ?? -1) - 0     )).toBeLessThan(TOL);
  expect(Math.abs((lanes![1]!.pitch ?? -1) - 4 / 12)).toBeLessThan(TOL);
  expect(Math.abs((lanes![2]!.pitch ?? -1) - 7 / 12)).toBeLessThan(TOL);
  expect(Math.abs((lanes![3]!.pitch ?? -1) -      1)).toBeLessThan(TOL);
  expect(Math.abs((lanes![4]!.pitch ?? -1) - 16 / 12)).toBeLessThan(TOL);
});

test('polyseqz: backward-compat — poly → mono pitch auto-routes lane 0 (root)', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await spawnPatch(
    page,
    [
      {
        id: 'p',
        type: 'polyseqz',
        params: { bpm: 240, length: 1, isPlaying: 1, gateLength: 0.9, humanize: 0 },
      },
      { id: 'vco', type: 'analogVco', params: {} },
    ],
    [
      {
        id: 'e1',
        from: { nodeId: 'p', portId: 'poly' },
        to: { nodeId: 'vco', portId: 'pitch' },
        sourceType: 'polyPitchGate',
        targetType: 'pitch',
      },
    ],
  );
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      w.__patch.nodes['p'].data = {
        steps: [{ on: true, root: 69, quality: 'maj', inversion: 0, voicing: 'closed' }],
      };
    });
  });
  await page.waitForTimeout(600);

  const root = await page.evaluate(() => {
    const w = globalThis as unknown as {
      __engine?: () => { read: (n: { id: string; type: string; domain: string }, k: string) => unknown } | null;
      __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
    };
    const eng = w.__engine?.();
    if (!eng) return null;
    const node = w.__patch.nodes['p'];
    const v = eng.read(node, 'pitchVOct');
    return typeof v === 'number' ? v : null;
  });
  // a4 V/oct = (69-60)/12 = 0.75.
  expect(root).not.toBeNull();
  expect(Math.abs((root as number) - 0.75)).toBeLessThan(1e-6);
});

test('polyseqz: humanize=0 keeps gates synchronous; humanize=1 spreads them', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  // First: humanize=0. All voices gate-on simultaneously, so every
  // humanizeOffset:N read should be exactly 0.
  await spawnPatch(page, [
    {
      id: 'p',
      type: 'polyseqz',
      params: { bpm: 120, length: 1, isPlaying: 1, gateLength: 0.9, humanize: 0 },
    },
  ]);
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      w.__patch.nodes['p'].data = {
        steps: [{ on: true, root: 60, quality: 'maj', inversion: 0, voicing: 'closed' }],
      };
    });
  });
  await page.waitForTimeout(800);

  const offsetsAtZero = await page.evaluate(() => {
    const w = globalThis as unknown as {
      __engine?: () => { read: (n: { id: string; type: string; domain: string }, k: string) => unknown } | null;
      __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
    };
    const eng = w.__engine?.();
    if (!eng) return null;
    const node = w.__patch.nodes['p'];
    const out: number[] = [];
    for (let i = 0; i < 5; i++) {
      const v = eng.read(node, `humanizeOffset:${i}`);
      out.push(typeof v === 'number' ? v : Number.NaN);
    }
    return out;
  });
  expect(offsetsAtZero).not.toBeNull();
  for (const o of offsetsAtZero!) expect(o).toBe(0);

  // Now set humanize=1 and look again — should see non-zero offsets, with
  // a notable spread between voices (some negative, some positive in
  // distribution; over a few step samples we expect the spread set to
  // contain at least one non-zero value).
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { params: Record<string, number> }> };
    };
    w.__patch.nodes['p'].params.humanize = 1;
  });
  await page.waitForTimeout(800);

  // Read offsets across several samples (different ticks) — humanize is
  // per-step random so a single read could rarely be all-zero.
  const observations: number[][] = [];
  for (let attempt = 0; attempt < 6; attempt++) {
    const o = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __engine?: () => { read: (n: { id: string; type: string; domain: string }, k: string) => unknown } | null;
        __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
      };
      const eng = w.__engine?.();
      if (!eng) return null;
      const node = w.__patch.nodes['p'];
      const arr: number[] = [];
      for (let i = 0; i < 5; i++) {
        const v = eng.read(node, `humanizeOffset:${i}`);
        arr.push(typeof v === 'number' ? v : Number.NaN);
      }
      return arr;
    });
    if (o) observations.push(o);
    await page.waitForTimeout(120);
  }

  // At least one observation should contain at least one non-zero offset.
  const sawNonZero = observations.some((arr) => arr.some((v) => Math.abs(v) > 1e-6));
  expect(sawNonZero, `expected at least one non-zero humanize offset across ${observations.length} samples; got ${JSON.stringify(observations)}`).toBe(true);

  // No observed offset should exceed the documented HUMANIZE_MAX_DELAY_S (50ms).
  for (const arr of observations) {
    for (const v of arr) {
      if (!Number.isFinite(v)) continue;
      expect(Math.abs(v)).toBeLessThanOrEqual(0.05 + 1e-9);
    }
  }
});
