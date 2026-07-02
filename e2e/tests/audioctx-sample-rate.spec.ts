// e2e/tests/audioctx-sample-rate.spec.ts
//
// A2a regression guard: the app AudioContext is PINNED to 48 kHz
// (Canvas.svelte boot). Every ART baseline, DSP-core unit test, and worklet
// time-constant is calibrated at 48 000 Hz — on a 44.1 kHz-native device an
// unpinned context would render a graph the baselines never verified. The
// pin makes the browser resample at the OUTPUT instead, so what the engine
// computes is rate-identical everywhere.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

test('app AudioContext is pinned to 48 kHz', async ({ page }) => {
  await page.goto('/');
  // Boot the engine by spawning a trivial node (spawnPatch waits for mount,
  // which requires the engine — and therefore the AudioContext — to exist).
  await spawnPatch(page, [{ id: 'noise-1', type: 'noise', x: 100, y: 100 }]);
  const rate = await page.evaluate(() => {
    const w = globalThis as unknown as {
      __engine?: () => { getDomain: (d: string) => { ctx: AudioContext } };
    };
    return w.__engine?.().getDomain('audio').ctx.sampleRate ?? -1;
  });
  expect(rate).toBe(48000);
});
