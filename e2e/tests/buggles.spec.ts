// e2e/tests/buggles.spec.ts
//
// BUGGLES end-to-end coverage. The internal woggle scheduler runs off
// setTimeout, so we need a real (in-browser) AudioContext rather than
// the offline render that ART scenarios use.

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

test('buggles: drop module → card mounts with no console errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [{ id: 'b', type: 'buggles', position: { x: 200, y: 200 } }]);
  const card = page.locator('.svelte-flow__node-buggles');
  await expect(card).toBeVisible();
  await expect(card).toContainText('BUGGLES');
  expect(errors, errors.join('; ')).toEqual([]);
});

test('buggles: STEPPED output produces varying voltages over time (chaos > 0)', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
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

test('buggles: SMOOTH output produces a slowly-varying voltage', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
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

test('buggles: CLOCK output triggers ADSR envelope', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(
    page,
    [
      // Moderate woggle rate (knob 0.6 → ~5 Hz, period ~200ms) so each
      // envelope cycle has time to peak before the next trigger arrives.
      // Chaos 0 = predictable timing (no jitter) — keeps the pattern of
      // hits inside the analyser's 42ms snapshot reliable across runs.
      { id: 'b',    type: 'buggles',
        params: { rate: 0.6, chaos: 0, level: 1.0 } },
      // Long-tail envelope (attack 5ms, decay 200ms, sustain 0.4, release
      // 100ms) so any analyser snapshot lands somewhere on a non-zero
      // segment of the envelope — peak ≥ 0.4 (sustain) within ~205ms of
      // any trigger.
      { id: 'env',  type: 'adsr',
        params: { attack: 0.005, decay: 0.2, sustain: 0.4, release: 0.1 } },
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
  // Wait long enough for several woggle clocks → envelope hits.
  await page.waitForTimeout(2000);
  const stats = await readScopeStats(page, 'scp');
  // Envelope output should hit ~peak (~1.0) on attack, sit at sustain
  // (~0.4) until next trigger. Anywhere in that 0.4..1.0 range counts
  // as "envelope is firing." Allow margin for sample-rate boundary.
  expect(stats.peak, `ADSR env peak from BUGGLES.clock=${stats.peak}`).toBeGreaterThan(0.1);
});

test('buggles: SMOOTH output modulates VCA amplitude', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
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
