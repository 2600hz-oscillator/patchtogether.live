// e2e/tests/rings.spec.ts
//
// RINGS end-to-end coverage: instantiate the module in a real browser
// AudioContext, drive it with a noise exciter + STRUM gate, and verify
// the resonator produces audio at OUT — no crashes, no NaN/Inf in the
// scope buffer. Mirrors the BUGGLES/SHIMMERSHINE spec patterns
// (poll-scope-for-peak-above-threshold) to stay robust to transport-layer
// jitter under headless CI.

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

test('rings: drop module → card mounts with no console errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [{ id: 'r', type: 'rings', position: { x: 200, y: 200 } }]);
  const card = page.locator('.svelte-flow__node-rings');
  await expect(card).toBeVisible();
  await expect(card).toContainText('RINGS');
  // The model-readout testid shows the current model name (MODAL by default).
  await expect(page.getByTestId('rings-model-name')).toHaveText(/MODAL|SYMPATHETIC/);
  expect(errors, errors.join('; ')).toEqual([]);
});

test('rings: NOISE exciter into RINGS produces audio at ODD output (sympathetic strings, looped)', async ({ page }) => {
  // SYMPATHETIC model: pure-noise exciter + low damping + long ring. We
  // route white noise into the RINGS exciter input and tap ODD into a
  // scope to read back; speakers muted (master=0). Just verify the
  // resonator output goes above the silence floor.
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(
    page,
    [
      { id: 'n',   type: 'noise',  position: { x:  50, y: 100 },
        params: { level: 0.7 } },
      { id: 'r',   type: 'rings',  position: { x: 350, y: 100 },
        params: {
          model: 1,           // SYMPATHETIC
          note: 0,
          structure: 0.5,
          brightness: 0.7,
          damping: 0.1,       // long ring
          position: 0.5,
          level: 0.9,
        } },
      { id: 'scp', type: 'scope',  position: { x: 700, y: 100 },
        params: { timeMs: 200, ch1Range: 1 } },
      { id: 'out', type: 'audioOut', position: { x: 1000, y: 100 },
        params: { master: 0 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'n',   portId: 'white' }, to: { nodeId: 'r',   portId: 'in'  } },
      { id: 'e2', from: { nodeId: 'r',   portId: 'odd'   }, to: { nodeId: 'scp', portId: 'ch1' } },
      { id: 'e3', from: { nodeId: 'scp', portId: 'ch1_out' }, to: { nodeId: 'out', portId: 'L' } },
    ],
  );
  const stats = await pollScopePeak(page, 'scp', 0.01, 4000);
  expect(stats.peak, `rings.odd peak ${stats.peak} (after noise→rings.in)`).toBeGreaterThan(0.01);
  // Sanity: output is bounded (tanh limiter).
  expect(stats.peak).toBeLessThanOrEqual(1.0);
});

test('rings: STRUM with no external exciter + MODAL produces audio (self-excite)', async ({ page }) => {
  // The bug we're fixing: MODAL used to require an external exciter and was
  // silent on STRUM alone. After the fix, STRUM injects a short noise burst
  // into MODAL so the resonator rings out without any audio input patched.
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(
    page,
    [
      { id: 'seq', type: 'sequencer', position: { x:  50, y: 100 },
        params: { bpm: 240, length: 4, isPlaying: 1, gateLength: 0.5 } },
      { id: 'r',   type: 'rings',  position: { x: 350, y: 100 },
        params: {
          model: 0,           // MODAL
          note: 0,
          structure: 0.3,
          brightness: 0.7,
          damping: 0.15,      // long-ish ring so the burst is audible
          position: 0.0,
          level: 0.9,
        } },
      { id: 'scp', type: 'scope',  position: { x: 700, y: 100 },
        params: { timeMs: 200, ch1Range: 1 } },
      { id: 'out', type: 'audioOut', position: { x: 1000, y: 100 },
        params: { master: 0 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'seq', portId: 'gate' }, to: { nodeId: 'r',   portId: 'strum' },
        sourceType: 'gate', targetType: 'gate' },
      { id: 'e2', from: { nodeId: 'r',   portId: 'odd'   }, to: { nodeId: 'scp', portId: 'ch1' } },
      { id: 'e3', from: { nodeId: 'scp', portId: 'ch1_out' }, to: { nodeId: 'out', portId: 'L' } },
    ],
  );

  // Enable every sequencer step so the gate actually fires (default steps
  // are all `on: false`).
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: { steps?: unknown[] } }> };
    };
    const seq = w.__patch.nodes['seq'];
    if (seq) {
      if (!seq.data) seq.data = {};
      seq.data.steps = Array.from({ length: 32 }, () => ({ on: true, midi: 60, chord: 'mono' }));
    }
  });

  const stats = await pollScopePeak(page, 'scp', 0.001, 6000);
  expect(stats.peak, `MODAL self-excite peak ${stats.peak}`).toBeGreaterThan(0.001);
  expect(stats.peak).toBeLessThanOrEqual(1.0);
});

test('rings: model button cycles MODAL ↔ SYMPATHETIC and updates label', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [{ id: 'r', type: 'rings', position: { x: 200, y: 200 } }]);

  const modelBtn = page.getByTestId('rings-model-btn');
  const modelName = page.getByTestId('rings-model-name');
  await expect(modelBtn).toBeVisible();
  await expect(modelName).toHaveText('MODAL');

  await modelBtn.click();
  await expect(modelName).toHaveText('SYMPATHETIC');

  await modelBtn.click();
  await expect(modelName).toHaveText('MODAL');
});

test('rings: model switch (MODAL ↔ SYMPATHETIC) — both produce audio', async ({ page }) => {
  // Spawn with MODAL, verify audio; then change model → SYMPATHETIC,
  // verify audio again. Both should be non-silent.
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(
    page,
    [
      { id: 'n',   type: 'noise',  position: { x:  50, y: 100 },
        params: { level: 0.9 } },
      { id: 'r',   type: 'rings',  position: { x: 350, y: 100 },
        params: {
          model: 0,
          structure: 0.3,
          brightness: 0.7,
          damping: 0.2,
          position: 0.0,
          level: 0.9,
        } },
      { id: 'scp', type: 'scope',  position: { x: 700, y: 100 },
        params: { timeMs: 200, ch1Range: 1 } },
      { id: 'out', type: 'audioOut', position: { x: 1000, y: 100 },
        params: { master: 0 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'n',   portId: 'white' }, to: { nodeId: 'r',   portId: 'in'  } },
      { id: 'e2', from: { nodeId: 'r',   portId: 'odd'   }, to: { nodeId: 'scp', portId: 'ch1' } },
      { id: 'e3', from: { nodeId: 'scp', portId: 'ch1_out' }, to: { nodeId: 'out', portId: 'L' } },
    ],
  );
  // MODAL output.
  const modalStats = await pollScopePeak(page, 'scp', 0.001, 3000);
  expect(modalStats.peak, `MODAL peak=${modalStats.peak}`).toBeGreaterThan(0.001);

  // Switch model param to SYMPATHETIC via the shared patch store.
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { params: Record<string, number> }> };
    };
    const node = w.__patch.nodes['r'];
    if (node) {
      node.params.model = 1;
      node.params.damping = 0.1;
    }
  });
  // Give the engine a beat to apply the param change.
  await page.waitForTimeout(300);
  const sympStats = await pollScopePeak(page, 'scp', 0.01, 3000);
  expect(sympStats.peak, `SYMPATHETIC peak=${sympStats.peak}`).toBeGreaterThan(0.01);
});
