// e2e/tests/polyseqz-evolve.spec.ts
//
// End-to-end coverage for the POLYSEQZ EVOLVE button. Spawns a POLYSEQZ
// pre-loaded with a C-major I-IV-V-I, toggles EVOLVE on, lets the engine
// run for several loop passes, and verifies that:
//   1. node.data.evolveGeneration > 0 (mutations actually happened)
//   2. data.steps differs from the initial pattern (destructive change)
//   3. Most root values stay in the C-major / related-key space
//   4. Toggling EVOLVE off freezes the pattern

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

// C major diatonic roots in octave 4: C=60, D=62, E=64, F=65, G=67, A=69, B=71.
// Plus the related keys' scale tones (G major adds F#=66, F major adds Bb=70).
// We'll accept any of those when checking "stayed in key".
const C_MAJOR_RELATED_ROOTS = new Set([
  60, 62, 64, 65, 67, 69, 71, // C major
  // G major (adds F#)
  66,
  // F major (adds Bb)
  70,
  // Same pitch classes in adjacent octaves — POLYSEQZ steps can drift up/down.
  48, 50, 52, 53, 55, 57, 59, 54, 58,
  72, 74, 76, 77, 79, 81, 83, 78, 82,
]);

test('polyseqz-evolve: button toggles + mutations occur over loop passes + pattern stays in key', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await spawnPatch(page, [
    {
      id: 'p',
      type: 'polyseqz',
      params: { bpm: 300, length: 4, isPlaying: 1, gateLength: 0.6, humanize: 0 },
    },
  ]);

  // Seed a C major I-IV-V-I (4 steps).
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes['p'];
      if (!n) return;
      n.data = {
        steps: [
          { on: true, root: 60, quality: 'maj', inversion: 0, voicing: 'closed' },
          { on: true, root: 65, quality: 'maj', inversion: 0, voicing: 'closed' },
          { on: true, root: 67, quality: 'maj', inversion: 0, voicing: 'closed' },
          { on: true, root: 60, quality: 'maj', inversion: 0, voicing: 'closed' },
        ],
        evolveEnabled: false,
        evolveGeneration: 0,
      };
    });
  });

  // The EVOLVE button starts in OFF state.
  const evolveBtn = page.getByTestId('polyseqz-evolve-p');
  await expect(evolveBtn).toHaveAttribute('data-evolve-enabled', 'false');

  // Click EVOLVE → ON.
  await evolveBtn.click();
  await expect(evolveBtn).toHaveAttribute('data-evolve-enabled', 'true');

  // 300 BPM, 8th-note grid = 600 steps/min = 10 steps/sec. 4-step pattern =
  // 2.5 loops/sec. Wait 4 seconds → roughly 10 loop passes.
  await page.waitForTimeout(4000);

  // Stop playback.
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { params: Record<string, number> }> };
    };
    w.__patch.nodes['p']!.params.isPlaying = 0;
  });
  await page.waitForTimeout(200);

  const state = await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
    };
    const d = w.__patch.nodes['p']?.data as Record<string, unknown> | undefined;
    return {
      gen: typeof d?.evolveGeneration === 'number' ? d.evolveGeneration : 0,
      steps: Array.isArray(d?.steps) ? d.steps : [],
    };
  });

  // At least one mutation must have occurred over ~10 passes.
  expect(state.gen).toBeGreaterThan(0);

  // Pattern must differ from the original I-IV-V-I (roots 60-65-67-60).
  const initial = [60, 65, 67, 60];
  const finalRoots = (state.steps as Array<Record<string, unknown>>).map((s) =>
    typeof s?.root === 'number' ? s.root : null,
  );
  const same = finalRoots.length === initial.length
    && initial.every((r, i) => finalRoots[i] === r);
  expect(same, `expected steps to differ from initial ${JSON.stringify(initial)}; got ${JSON.stringify(finalRoots)}`).toBe(false);

  // Most roots stay within the C-major / related-key set.
  let inKey = 0;
  let real = 0;
  for (const s of state.steps as Array<Record<string, unknown>>) {
    if (s?.on !== true) continue;
    if (typeof s?.root !== 'number') continue;
    real += 1;
    if (C_MAJOR_RELATED_ROOTS.has(s.root)) inKey += 1;
  }
  // Allow 1 out-of-strict-set chord for chromatic substitutions (tritone sub).
  expect(real).toBeGreaterThan(0);
  expect(inKey / real).toBeGreaterThanOrEqual(0.5);
});

test('polyseqz-evolve: toggling EVOLVE off freezes mutations', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await spawnPatch(page, [
    {
      id: 'p',
      type: 'polyseqz',
      params: { bpm: 300, length: 4, isPlaying: 1, gateLength: 0.6, humanize: 0 },
    },
  ]);

  // Seed a C major I-IV-V-I + start with EVOLVE on.
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes['p'];
      if (!n) return;
      n.data = {
        steps: [
          { on: true, root: 60, quality: 'maj', inversion: 0, voicing: 'closed' },
          { on: true, root: 65, quality: 'maj', inversion: 0, voicing: 'closed' },
          { on: true, root: 67, quality: 'maj', inversion: 0, voicing: 'closed' },
          { on: true, root: 60, quality: 'maj', inversion: 0, voicing: 'closed' },
        ],
        evolveEnabled: true,
        evolveGeneration: 0,
      };
    });
  });

  // Let it run + mutate for ~2 seconds (5+ passes at 300 BPM 4-step).
  await page.waitForTimeout(2000);

  // Toggle EVOLVE off FIRST, then snapshot — capturing the snapshot before
  // the toggle would race with the engine's next loop-wrap mutation between
  // the read and the click.
  const evolveBtn = page.getByTestId('polyseqz-evolve-p');
  await evolveBtn.click();
  await expect(evolveBtn).toHaveAttribute('data-evolve-enabled', 'false');

  // Settle: wait long enough for any in-flight loop-wrap mutation that
  // started BEFORE the toggle to complete. One full 4-step pass at 300
  // BPM is 800ms; 1.5s buffer is safe.
  await page.waitForTimeout(1500);

  // Snapshot AFTER the freeze is in effect.
  const beforeOff = await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
    };
    const d = w.__patch.nodes['p']?.data as Record<string, unknown> | undefined;
    return {
      gen: typeof d?.evolveGeneration === 'number' ? d.evolveGeneration : 0,
      steps: JSON.parse(JSON.stringify(d?.steps ?? [])),
    };
  });
  // Some mutation must have occurred before the toggle.
  expect(beforeOff.gen).toBeGreaterThan(0);

  // Wait another ~2 seconds (more loop passes) — but EVOLVE is off so no
  // further mutations should occur.
  await page.waitForTimeout(2000);

  const afterOff = await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
    };
    const d = w.__patch.nodes['p']?.data as Record<string, unknown> | undefined;
    return {
      gen: typeof d?.evolveGeneration === 'number' ? d.evolveGeneration : 0,
      steps: JSON.parse(JSON.stringify(d?.steps ?? [])),
    };
  });

  // Generation counter must not have advanced while EVOLVE is off.
  expect(afterOff.gen).toBe(beforeOff.gen);
  // Steps must be byte-identical to the snapshot taken after the freeze.
  expect(JSON.stringify(afterOff.steps)).toBe(JSON.stringify(beforeOff.steps));
});
