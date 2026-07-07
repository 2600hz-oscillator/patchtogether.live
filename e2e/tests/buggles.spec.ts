// e2e/tests/buggles.spec.ts
//
// BUGGLES end-to-end coverage. The internal woggle scheduler runs off
// setTimeout, so we need a real (in-browser) AudioContext rather than
// the offline render that ART scenarios use.

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

/**
 * Poll the scope analyser until any one snapshot's peak exceeds `threshold`,
 * or `timeoutMs` elapses. The analyser holds only ~43ms of audio (fftSize 2048
 * @ 48kHz), so a single waitForTimeout + read can land entirely inside a dead
 * zone of a transient signal — e.g. an ADSR envelope between gate triggers,
 * which decays to 0 within attack+release after each pulse and stays there
 * until the next gate. Polling at 50ms over multiple gate cycles guarantees
 * we catch the envelope at its peak as long as the signal is firing at all.
 *
 * Returns the highest stats observed across all polls. If we never crossed
 * the threshold, that highest value is what the caller's assertion sees.
 */
async function pollScopePeak(
  page: Page,
  scopeNodeId: string,
  threshold: number,
  timeoutMs: number,
): Promise<ScopeStats> {
  const deadline = Date.now() + timeoutMs;
  let best: ScopeStats = { peak: 0, rms: 0, nonzeroSamples: 0, total: 0 };
  while (Date.now() < deadline) {
    let s: ScopeStats;
    try {
      s = await readScopeStats(page, scopeNodeId);
    } catch (err) {
      // Vite dev-server HMR can drop the execution context mid-poll under
      // load (`Execution context was destroyed, most likely because of a
      // navigation`). Wait for the page to settle and retry — it's not a
      // BUGGLES signal issue.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Execution context was destroyed')) {
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        await page.waitForTimeout(50);
        continue;
      }
      throw err;
    }
    if (s.peak > best.peak) best = s;
    if (best.peak > threshold) return best;
    await page.waitForTimeout(50);
  }
  return best;
}

test('buggles: drop module → card mounts with no console errors', async ({ page, rack, errorWatch }) => {
  await spawnPatch(page, [{ id: 'b', type: 'buggles', position: { x: 200, y: 200 } }]);
  const card = page.locator('.svelte-flow__node-buggles');
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
  // every ~240ms and the envelope rising to ~1.0 on each gate, a 50ms-cadence
  // poll will land on a peak within at most one period.
  const stats = await pollScopePeak(page, 'scp', 0.1, 2000);
  expect(stats.peak, `ADSR env peak from BUGGLES.clock=${stats.peak}`).toBeGreaterThan(0.1);
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
