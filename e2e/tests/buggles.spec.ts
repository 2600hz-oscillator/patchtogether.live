// e2e/tests/buggles.spec.ts
//
// BUGGLES end-to-end coverage. The internal woggle scheduler runs off
// setTimeout, so we need a real (in-browser) AudioContext rather than
// the offline render that ART scenarios use.

import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';
import { pollScopePeak, readScopeStats, scopePollMsg } from '../_helpers/scope-poll';

test.describe.configure({ mode: 'parallel' });

// The scope poller lives at ONE export site and runs its whole sampling loop
// INSIDE the page. The local copy this replaces did one CDP round trip per
// sample, on the same main thread as the audio graph it was measuring.

test('buggles: drop module → card mounts with no console errors', async ({ page, rack, errorWatch }) => {
  await spawnPatch(page, [{ id: 'b', type: 'buggles', position: { x: 200, y: 200 } }]);
  const card = page.locator('.svelte-flow__node:has([data-shell-type="buggles"])');
  await expect(card).toBeVisible();
  await expect(card).toContainText('BUGGLES');
});

test('buggles: STEPPED output produces varying voltages over time (chaos > 0)', async ({ page, rack }) => {
  // Set rate fairly high (knob 0.7 → ~10 Hz) so we see lots of steps in
  // the test window. Chaos 0.8 ensures big jumps so peaks are visible.
  await spawnPatch(
    page,
    [
      { id: 'b',   type: 'buggles', position: { x: 100, y: 100 },
        params: { rate: 0.7, chaos: 0.8, smoothness: 0, level: 1.0 } },
      { id: 'scp', type: 'scope',   position: { x: 400, y: 100 },
        params: { timeMs: 500, ch1Range: 1 } },
      { id: 'out', type: 'audioOut', position: { x: 700, y: 100 },
        params: { master: 0.0 } }, // mute speakers; we only need scope read-back
    ],
    [
      { id: 'e1', from: { nodeId: 'b',   portId: 'stepped' }, to: { nodeId: 'scp', portId: 'ch1' },
        sourceType: 'cv', targetType: 'cv' },
      { id: 'e2', from: { nodeId: 'scp', portId: 'ch1_out'}, to: { nodeId: 'out', portId: 'L' } },
    ],
  );
  // Give the woggle scheduler time to fire several events.
  await page.waitForTimeout(1500);
  const stats = await readScopeStats(page, 'scp');
  expect(stats.peak, `STEPPED peak=${stats.peak}`).toBeGreaterThan(0.05);
  // Stepped output is non-zero most of the time (S&H holds a value
  // between events).
  expect(stats.nonzeroSamples).toBeGreaterThan(100);
});

test('buggles: SMOOTH output produces a slowly-varying voltage', async ({ page, rack }) => {
  await spawnPatch(
    page,
    [
      { id: 'b',   type: 'buggles',
        params: { rate: 0.6, chaos: 0.5, smoothness: 0.4, level: 1.0 } },
      { id: 'scp', type: 'scope',
        params: { timeMs: 1000, ch1Range: 1 } },
      { id: 'out', type: 'audioOut', params: { master: 0 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'b',   portId: 'smooth'  }, to: { nodeId: 'scp', portId: 'ch1' },
        sourceType: 'cv', targetType: 'cv' },
      { id: 'e2', from: { nodeId: 'scp', portId: 'ch1_out'}, to: { nodeId: 'out', portId: 'L' } },
    ],
  );
  await page.waitForTimeout(1800);
  const stats = await readScopeStats(page, 'scp');
  // Smooth output has measurable variance (voltage moves around).
  expect(stats.peak, `SMOOTH peak=${stats.peak}`).toBeGreaterThan(0.02);
  expect(stats.nonzeroSamples).toBeGreaterThan(100);
});

test('buggles: CLOCK output triggers ADSR envelope', async ({ page, rack }) => {
  await spawnPatch(
    page,
    [
      // Moderate woggle rate (knob 0.6 → ~4 Hz, period ~240ms). Chaos 0 keeps
      // the period stable so the polling loop below catches a peak quickly.
      { id: 'b',    type: 'buggles',
        params: { rate: 0.6, chaos: 0, level: 1.0 } },
      // Short attack + brief release. BUGGLES.clock is a 5ms gate, so the
      // ADSR enters release immediately after attack — sustain is never
      // held between triggers. The envelope is non-zero for ~attack+release
      // = ~75ms per trigger, then sits at 0 for the rest of the period
      // (~165ms). The single-shot read pattern (waitForTimeout + read once)
      // had a ~38% chance of sampling the analyser entirely inside that
      // dead zone; pollScopePeak below catches the next peak deterministically.
      { id: 'env',  type: 'adsr',
        params: { attack: 0.005, decay: 0.05, sustain: 0.4, release: 0.07 } },
      { id: 'scp',  type: 'scope',
        params: { timeMs: 1000, ch1Range: 1 } },
      { id: 'out',  type: 'audioOut', params: { master: 0 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'b',   portId: 'clock'  }, to: { nodeId: 'env', portId: 'gate' },
        sourceType: 'gate', targetType: 'gate' },
      { id: 'e2', from: { nodeId: 'env', portId: 'env'    }, to: { nodeId: 'scp', portId: 'ch1' },
        sourceType: 'cv', targetType: 'cv' },
      { id: 'e3', from: { nodeId: 'scp', portId: 'ch1_out'}, to: { nodeId: 'out', portId: 'L' } },
    ],
  );
  // Poll the analyser over up to 8 woggle periods (~2s). With BUGGLES firing
  // every ~240ms and the envelope rising to ~1.0 on each gate, the in-page
  // sampler lands on a peak within at most one period.
  const stats = await pollScopePeak(page, 'scp', 0.1, 2000);
  expect(stats.peak, scopePollMsg(`ADSR env peak from BUGGLES.clock=${stats.peak}`, stats)).toBeGreaterThan(0.1);
});

test('buggles: SMOOTH output modulates VCA amplitude', async ({ page, rack }) => {
  await spawnPatch(
    page,
    [
      { id: 'b',   type: 'buggles',
        params: { rate: 0.6, chaos: 0.4, smoothness: 0.3, level: 1.0 } },
      // Audio source: noise white into the VCA.
      { id: 'n',   type: 'noise',    params: { level: 0.6 } },
      // VCA driven by buggles.smooth on the cv input.
      { id: 'vca', type: 'vca',      params: { base: 0, cvAmount: 1 } },
      { id: 'scp', type: 'scope',    params: { timeMs: 800, ch1Range: 0 } },
      { id: 'out', type: 'audioOut', params: { master: 0 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'n',   portId: 'white'   }, to: { nodeId: 'vca', portId: 'audio' } },
      { id: 'e2', from: { nodeId: 'b',   portId: 'smooth'  }, to: { nodeId: 'vca', portId: 'cv'   },
        sourceType: 'cv', targetType: 'cv' },
      { id: 'e3', from: { nodeId: 'vca', portId: 'audio'   }, to: { nodeId: 'scp', portId: 'ch1' } },
      { id: 'e4', from: { nodeId: 'scp', portId: 'ch1_out' }, to: { nodeId: 'out', portId: 'L'   } },
    ],
  );
  await page.waitForTimeout(1800);
  const stats = await readScopeStats(page, 'scp');
  // VCA(audio=noise, cv=buggles.smooth) — amplitude modulated by a
  // varying voltage. Peak should be measurable (noise × non-zero
  // smooth voltage). Allow a low threshold because smooth can hover
  // near 0 occasionally.
  expect(stats.peak, `VCA peak with BUGGLES.smooth as cv=${stats.peak}`).toBeGreaterThan(0.005);
  expect(stats.nonzeroSamples).toBeGreaterThan(100);
});
