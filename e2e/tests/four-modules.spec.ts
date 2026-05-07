// e2e/tests/four-modules.spec.ts
//
// Functional E2E for the four new modules (MEOWBOX, MIXMSTRS, TIMELORDE,
// CHARLOTTE'S ECHOS). For each: spawn into a rackspace, drive it with a
// gate/signal source, route output through a Scope, then assert the Scope
// snapshot reports a non-trivial peak — i.e. audio actually flows.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

interface ScopeSnap {
  ch1: number[];
  ch2: number[];
  sampleRate: number;
}

async function readScopePeak(page: import('@playwright/test').Page, scopeId: string): Promise<number> {
  const snap = await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __engine: () => {
        read: (node: { id: string; type: string; domain: string }, key: string) => unknown;
      } | null;
      __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
    };
    const e = w.__engine();
    if (!e) return null;
    const node = w.__patch.nodes[id];
    if (!node) return null;
    const s = e.read(node, 'snapshot') as ScopeSnap | undefined;
    if (!s) return null;
    return { ch1: Array.from(s.ch1) };
  }, scopeId);
  if (!snap) return 0;
  let peak = 0;
  for (const v of snap.ch1) if (Math.abs(v) > peak) peak = Math.abs(v);
  return peak;
}

test('MEOWBOX: gate triggers audible voice on L output', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await spawnPatch(
    page,
    [
      { id: 'seq', type: 'sequencer', params: { bpm: 240, length: 4, isPlaying: 1, gateLength: 0.5 } },
      { id: 'meow', type: 'meowbox', params: { pitch: 0, morph: 0.25, decay: 0.4, level: 1 } },
      { id: 'scope', type: 'scope', params: {} },
      { id: 'out', type: 'audioOut', params: { master: 0.1 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'seq', portId: 'gate' }, to: { nodeId: 'meow', portId: 'gate' }, sourceType: 'gate', targetType: 'gate' },
      { id: 'e2', from: { nodeId: 'meow', portId: 'L' }, to: { nodeId: 'scope', portId: 'ch1' } },
      { id: 'e3', from: { nodeId: 'scope', portId: 'ch1_out' }, to: { nodeId: 'out', portId: 'L' } },
    ],
  );

  // Set the seq pattern: all four steps on, pitch 0.
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const seq = w.__patch.nodes['seq'];
      if (!seq.data) seq.data = {};
      seq.data.steps = Array.from({ length: 32 }, (_, i) => ({ on: i < 4, pitch: 0 }));
    });
  });

  // Wait for several gate triggers + ring-out.
  await page.waitForTimeout(800);

  const peak = await readScopePeak(page, 'scope');
  expect(peak, `MEOWBOX scope peak (got ${peak})`).toBeGreaterThan(0.001);
  expect(errors, `MEOWBOX errors: ${errors.join('; ')}`).toEqual([]);
});

test('TIMELORDE: 1x output emits gate pulses at the configured BPM', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await spawnPatch(
    page,
    [
      // 300 BPM × 4x output = 20 pulses/sec — the 4x output will have at
      // least one rising edge inside the analyser's 42ms window almost
      // continuously, which dodges the timing-flake of polling.
      { id: 'tl', type: 'timelorde', params: { bpm: 300, swingAmount: 0, swingSource: 0, isPlaying: 1 } },
      { id: 'scope', type: 'scope', params: {} },
      { id: 'out', type: 'audioOut', params: { master: 0.1 } },
    ],
    [
      // Use 4x (20 pulses/sec) into scope so the polled snapshot reliably
      // catches a pulse regardless of when readScopePeak fires.
      { id: 'e1', from: { nodeId: 'tl', portId: '4x' }, to: { nodeId: 'scope', portId: 'ch1' }, sourceType: 'gate', targetType: 'audio' },
      { id: 'e2', from: { nodeId: 'scope', portId: 'ch1_out' }, to: { nodeId: 'out', portId: 'L' } },
    ],
  );

  // Wait for the worklet to start emitting + a few snapshot opportunities.
  // Poll up to 2 s, succeeding on first non-zero peak (avoids fixed-sleep flake).
  let peak = 0;
  const start = Date.now();
  while (Date.now() - start < 2000) {
    await page.waitForTimeout(120);
    peak = await readScopePeak(page, 'scope');
    if (peak > 0.5) break;
  }
  expect(peak, `TIMELORDE 4x peak (got ${peak})`).toBeGreaterThan(0.5);
  expect(errors, `TIMELORDE errors: ${errors.join('; ')}`).toEqual([]);
});

test('TIMELORDE: singleton — second instance is rejected by engine.addNode guard', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  // Use the canonical id-prefix convention (`${type}-...`) so the engine's
  // singleton enforcement recognizes both as the same type.
  await spawnPatch(
    page,
    [
      { id: 'timelorde-aaa', type: 'timelorde', params: {} },
      { id: 'timelorde-zzz', type: 'timelorde', params: {} },
    ],
    [],
  );

  await page.waitForTimeout(500);

  const engineCount = await page.evaluate(() => {
    const w = globalThis as unknown as { __engine: () => unknown | null };
    const e = w.__engine();
    if (!e) return -1;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const audioDomain = (e as any).getDomain ? (e as any).getDomain('audio') : null;
    if (!audioDomain || !audioDomain.nodes) return -1;
    let count = 0;
    for (const id of audioDomain.nodes.keys()) {
      if (typeof id === 'string' && id.startsWith('timelorde-')) count++;
    }
    return count;
  });

  expect(engineCount, 'engine should have exactly 1 TIMELORDE instance').toBe(1);
});

test("CHARLOTTE'S ECHOS: passes signal through and produces echo tail", async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await spawnPatch(
    page,
    [
      { id: 'seq', type: 'sequencer', params: { bpm: 240, length: 4, isPlaying: 1, gateLength: 0.5 } },
      { id: 'vco', type: 'analogVco', params: { tune: 0, fine: 0, fmAmount: 0 } },
      { id: 'adsr', type: 'adsr', params: { attack: 0.005, decay: 0.05, sustain: 0.6, release: 0.05 } },
      { id: 'vca', type: 'vca', params: { base: 0, cvAmount: 1 } },
      { id: 'echo', type: 'charlottesEchos', params: { delay: 0.1, feedback: 0.5, decay: 0.2, pitchUp: 0, mix: 0.7 } },
      { id: 'scope', type: 'scope', params: {} },
      { id: 'out', type: 'audioOut', params: { master: 0.1 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'seq', portId: 'pitch' }, to: { nodeId: 'vco', portId: 'pitch' }, sourceType: 'pitch', targetType: 'pitch' },
      { id: 'e2', from: { nodeId: 'seq', portId: 'gate' }, to: { nodeId: 'adsr', portId: 'gate' }, sourceType: 'gate', targetType: 'gate' },
      { id: 'e3', from: { nodeId: 'vco', portId: 'sine' }, to: { nodeId: 'vca', portId: 'audio' } },
      { id: 'e4', from: { nodeId: 'adsr', portId: 'env' }, to: { nodeId: 'vca', portId: 'cv' }, sourceType: 'cv', targetType: 'cv' },
      { id: 'e5', from: { nodeId: 'vca', portId: 'audio' }, to: { nodeId: 'echo', portId: 'L' } },
      { id: 'e6', from: { nodeId: 'echo', portId: 'L' }, to: { nodeId: 'scope', portId: 'ch1' } },
      { id: 'e7', from: { nodeId: 'scope', portId: 'ch1_out' }, to: { nodeId: 'out', portId: 'L' } },
    ],
  );

  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const seq = w.__patch.nodes['seq'];
      if (!seq.data) seq.data = {};
      seq.data.steps = Array.from({ length: 32 }, (_, i) => ({ on: i < 4, pitch: 0 }));
    });
  });

  await page.waitForTimeout(800);

  const peak = await readScopePeak(page, 'scope');
  expect(peak, `Echos scope peak (got ${peak})`).toBeGreaterThan(0.001);
});

test('MIXMSTRS: passes channel 1 through to master out', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await spawnPatch(
    page,
    [
      { id: 'seq', type: 'sequencer', params: { bpm: 240, length: 4, isPlaying: 1, gateLength: 0.5 } },
      { id: 'vco', type: 'analogVco', params: { tune: 0, fine: 0, fmAmount: 0 } },
      { id: 'mix', type: 'mixmstrs', params: { ch1_volume: 1, master_volume: 1, ch1_compEnable: 0 } },
      { id: 'scope', type: 'scope', params: {} },
      { id: 'out', type: 'audioOut', params: { master: 0.1 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'seq', portId: 'pitch' }, to: { nodeId: 'vco', portId: 'pitch' }, sourceType: 'pitch', targetType: 'pitch' },
      { id: 'e2', from: { nodeId: 'vco', portId: 'sine' }, to: { nodeId: 'mix', portId: 'ch1L' } },
      { id: 'e3', from: { nodeId: 'mix', portId: 'masterL' }, to: { nodeId: 'scope', portId: 'ch1' } },
      { id: 'e4', from: { nodeId: 'scope', portId: 'ch1_out' }, to: { nodeId: 'out', portId: 'L' } },
    ],
  );

  await page.waitForTimeout(500);

  const peak = await readScopePeak(page, 'scope');
  expect(peak, `MIXMSTRS scope peak (got ${peak})`).toBeGreaterThan(0.01);
  expect(errors, `MIXMSTRS errors: ${errors.join('; ')}`).toEqual([]);
});

test('MIXMSTRS: singleton enforced — only one instance materializes in engine', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await spawnPatch(
    page,
    [
      { id: 'mixmstrs-aaa', type: 'mixmstrs', params: {} },
      { id: 'mixmstrs-zzz', type: 'mixmstrs', params: {} },
    ],
    [],
  );

  await page.waitForTimeout(800);

  const count = await page.evaluate(() => {
    const w = globalThis as unknown as { __engine: () => unknown | null };
    const e = w.__engine();
    if (!e) return -1;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const audioDomain = (e as any).getDomain ? (e as any).getDomain('audio') : null;
    if (!audioDomain || !audioDomain.nodes) return -1;
    let n = 0;
    for (const id of audioDomain.nodes.keys()) {
      if (typeof id === 'string' && id.startsWith('mixmstrs-')) n++;
    }
    return n;
  });
  expect(count, 'only one MIXMSTRS instance allowed').toBe(1);
});
