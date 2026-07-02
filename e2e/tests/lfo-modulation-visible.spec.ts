// e2e/tests/lfo-modulation-visible.spec.ts
//
// "Motorized fader visualizes CV modulation." When an LFO is connected to a
// CV-routed param (paramTarget input), the fader thumb on that param must
// visibly move while the LFO oscillates. Until the engine's per-param
// AnalyserNode tap shipped, AudioParam.value reflected only the intrinsic
// (slider-set) value, so faders appeared frozen even while modulation was
// clearly audible — this spec is a regression smoke for that whole class.
//
// Strategy: spawn LFO + a target with a param-routed input, connect them,
// sample the target fader thumb's CSS `top` at ~10 evenly-spaced points over
// ~1.5s. Assert at least 4 distinct values appear. With LFO at ~2 Hz (default
// 1 Hz works too but slower oscillation = fewer distinct samples per window),
// the thumb should sweep through the modulation depth several times.
//
// Two targets covered: QBRT cutoff (user-reported concern) and DRUMMERGIRL
// volume (added in the same change). Both use paramTarget routing so the
// AnalyserNode tap applies.
//
// `video: 'on'` is set per-test so a passing run still produces a reviewable
// video artifact — useful for catching subtle visual regressions that the
// numeric assertion alone would miss.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.use({ video: 'on' });

async function sampleFaderThumbTops(
  page: import('@playwright/test').Page,
  faderSelector: string,
  samples: number,
  intervalMs: number,
): Promise<string[]> {
  const tops: string[] = [];
  for (let i = 0; i < samples; i++) {
    const top = await page
      .locator(faderSelector)
      .first()
      .locator('.thumb')
      .evaluate((el) => (el as HTMLElement).style.top);
    tops.push(top);
    await page.waitForTimeout(intervalMs);
  }
  return tops;
}

test('LFO modulating QBRT cutoff visibly moves the cutoff fader thumb', async ({ page }) => {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');
  await spawnPatch(
    page,
    [
      // LFO at 4 Hz so we see ~6 cycles per 1.5s sample window.
      { id: 'lfo', type: 'lfo',  position: { x: 100, y: 100 }, params: { rate: 4.0, shape: 0 } },
      { id: 'qb',  type: 'qbrt', position: { x: 500, y: 100 }, params: { cutoff: 1000, resonance: 0.5 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'lfo', portId: 'phase0' }, to: { nodeId: 'qb', portId: 'cutoff' } },
    ],
  );
  await expect(page.locator('.svelte-flow__node-qbrt')).toBeVisible();

  // Locate the QBRT card's "Cut" fader (it's the first fader on the card).
  const cutoffFader = page.locator('.svelte-flow__node-qbrt .fader-wrap').first();

  // Settle, then sample.
  await page.waitForTimeout(300);
  const tops = await sampleFaderThumbTops(
    page,
    '.svelte-flow__node-qbrt .fader-wrap',
    12,
    140,
  );

  const distinct = new Set(tops);
  expect(
    distinct.size,
    `cutoff fader thumb should sweep across multiple positions while LFO modulates ` +
      `(saw ${distinct.size} distinct top values across 12 samples: ${[...distinct].slice(0, 5).join(', ')}…)`,
  ).toBeGreaterThanOrEqual(4);

  // Sanity: card itself didn't error out and the fader is still rendered.
  await expect(cutoffFader.locator('.thumb')).toBeVisible();
});

test('LFO modulating DRUMMERGIRL volume visibly moves the volume fader thumb', async ({ page }) => {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');
  await spawnPatch(
    page,
    [
      { id: 'lfo', type: 'lfo',         position: { x: 100, y: 100 }, params: { rate: 4.0, shape: 0 } },
      { id: 'dg',  type: 'drummergirl', position: { x: 500, y: 100 }, params: { volume: 1.0 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'lfo', portId: 'phase0' }, to: { nodeId: 'dg', portId: 'volume' } },
    ],
  );
  await expect(page.locator('.svelte-flow__node-drummergirl')).toBeVisible();

  // Volume is the LAST fader on DG (after Pitch, Tone, Shape, Decay). Use .last().
  const volumeFader = page.locator('.svelte-flow__node-drummergirl .fader-wrap').last();
  await page.waitForTimeout(300);

  const tops: string[] = [];
  for (let i = 0; i < 12; i++) {
    const top = await volumeFader.locator('.thumb').evaluate((el) => (el as HTMLElement).style.top);
    tops.push(top);
    await page.waitForTimeout(140);
  }

  const distinct = new Set(tops);
  expect(
    distinct.size,
    `volume fader thumb should sweep across multiple positions while LFO modulates ` +
      `(saw ${distinct.size} distinct top values: ${[...distinct].slice(0, 5).join(', ')}…)`,
  ).toBeGreaterThanOrEqual(4);
});
