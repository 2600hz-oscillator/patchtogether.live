// e2e/tests/riotgirls.spec.ts
//
// Functional E2E for RIOTGIRLS — drop the module + AUDIOOUT, drive trig1
// from a Sequencer, assert audio activity through a Scope tap on outL.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

interface ScopeSnap { ch1: number[]; ch2: number[]; sampleRate: number }

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

test('RIOTGIRLS: Sequencer-driven trig1 produces audio on outL', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto('/rack');
  await page.waitForLoadState('networkidle');

  await spawnPatch(
    page,
    [
      { id: 'seq', type: 'sequencer', params: { bpm: 240, length: 4, isPlaying: 1, gateLength: 0.5 } },
      { id: 'rg',  type: 'riotgirls', params: { v1_volume: 1.5, flt_cutoff: 18000 } },
      { id: 'scope', type: 'scope', params: {} },
      { id: 'out', type: 'audioOut', params: { master: 0.1 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'seq', portId: 'gate' }, to: { nodeId: 'rg', portId: 'trig1' }, sourceType: 'gate', targetType: 'gate' },
      { id: 'e2', from: { nodeId: 'rg', portId: 'outL' },  to: { nodeId: 'scope', portId: 'ch1' } },
      { id: 'e3', from: { nodeId: 'scope', portId: 'ch1_out' }, to: { nodeId: 'out', portId: 'L' } },
      { id: 'e4', from: { nodeId: 'rg', portId: 'outR' },  to: { nodeId: 'out', portId: 'R' } },
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
      seq.data.steps = Array.from({ length: 32 }, (_, i) => ({ on: i < 4, midi: 60 }));
    });
  });

  let peak = 0;
  const start = Date.now();
  while (Date.now() - start < 2500) {
    await page.waitForTimeout(150);
    peak = await readScopePeak(page, 'scope');
    if (peak > 0.001) break;
  }
  expect(peak, `RIOTGIRLS scope peak (got ${peak})`).toBeGreaterThan(0.001);
  expect(errors, `RIOTGIRLS errors: ${errors.join('; ')}`).toEqual([]);
});

test('RIOTGIRLS: __riotgirlsTriggerVoice test hook fires the requested voice', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto('/rack');
  await page.waitForLoadState('networkidle');

  await spawnPatch(
    page,
    [
      { id: 'rg',    type: 'riotgirls', params: { v2_volume: 1.5, flt_cutoff: 18000, v2_pan: 0 } },
      { id: 'scope', type: 'scope', params: {} },
      { id: 'out',   type: 'audioOut', params: { master: 0.1 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'rg', portId: 'outL' }, to: { nodeId: 'scope', portId: 'ch1' } },
      { id: 'e2', from: { nodeId: 'scope', portId: 'ch1_out' }, to: { nodeId: 'out', portId: 'L' } },
      { id: 'e3', from: { nodeId: 'rg', portId: 'outR' }, to: { nodeId: 'out', portId: 'R' } },
    ],
  );

  // Fire the test hook a handful of times so the scope's analyser window
  // catches at least one transient.
  let lastResult: boolean | null = null;
  let peak = 0;
  const start = Date.now();
  while (Date.now() - start < 4000 && peak <= 0.001) {
    lastResult = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __riotgirlsTriggerVoice?: (id: string, voiceIdx: number) => boolean;
      };
      if (typeof w.__riotgirlsTriggerVoice !== 'function') return null;
      // Fire all four voices — broader hit on the scope's L channel
      // regardless of which voice is currently centered.
      const a = w.__riotgirlsTriggerVoice('rg', 0);
      const b = w.__riotgirlsTriggerVoice('rg', 1);
      const c = w.__riotgirlsTriggerVoice('rg', 2);
      const d = w.__riotgirlsTriggerVoice('rg', 3);
      return a && b && c && d;
    });
    await page.waitForTimeout(180);
    peak = await readScopePeak(page, 'scope');
  }

  expect(lastResult, 'test hook should be installed under VITE_E2E_HOOKS').toBe(true);
  expect(peak, `RIOTGIRLS test-hook scope peak (got ${peak})`).toBeGreaterThan(0.001);
  expect(errors, `RIOTGIRLS test-hook errors: ${errors.join('; ')}`).toEqual([]);
});

test('RIOTGIRLS: every input port in the def has a visible handle', async ({ page }) => {
  // Regression for "card only renders 3 input handles per voice" bug — the
  // module def declares 55 inputs but the card was only rendering trig/gate/
  // pitch + outL/outR. This test asserts that every input id from the def is
  // reachable via Svelte Flow's `data-handleid` attribute on the rendered
  // card. The expected list is hardcoded to keep the test in sync with the
  // module def by intent — adding a new port to the def should require
  // updating this list (and adding the handle to the card).
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto('/rack');
  await page.waitForLoadState('networkidle');

  await spawnPatch(page, [{ id: 'rg', type: 'riotgirls', params: {} }], []);

  const expectedInputIds = [
    'trig1', 'trig2', 'trig3', 'trig4',
    'gate1', 'gate2', 'gate3', 'gate4',
    'pitch1', 'pitch2', 'pitch3', 'pitch4',
    // Per-voice CV (DRUMMERGIRL voices 1-3).
    ...[1, 2, 3].flatMap((v) => [`v${v}_tone`, `v${v}_shape`, `v${v}_volume`, `v${v}_decay`]),
    // Voice 4 distinct CV set.
    'v4_fm', 'v4_wavePos', 'v4_attack', 'v4_decay', 'v4_sustain', 'v4_release', 'v4_volume',
    // Per-voice pan + sends (v1-4).
    ...[1, 2, 3, 4].flatMap((v) => [`v${v}_pan`, `v${v}_sendA`, `v${v}_sendB`]),
    // Master strip.
    'bc_decimate', 'bc_bits', 'bc_wet',
    'rv_size', 'rv_damp', 'rv_mix',
    'flt_cutoff', 'flt_resonance', 'flt_mode', 'flt_pingDecay',
    'returnA', 'returnB',
  ];

  for (const portId of expectedInputIds) {
    const handle = page.locator(
      `.svelte-flow__node[data-id="rg"] .svelte-flow__handle[data-handleid="${portId}"]`,
    );
    await expect(handle, `riotgirls.${portId} input handle missing`).toHaveCount(1);
  }

  // Sanity: outputs are also rendered.
  for (const outId of ['outL', 'outR']) {
    const handle = page.locator(
      `.svelte-flow__node[data-id="rg"] .svelte-flow__handle[data-handleid="${outId}"]`,
    );
    await expect(handle, `riotgirls.${outId} output handle missing`).toHaveCount(1);
  }

  expect(errors, `RIOTGIRLS port-handle errors: ${errors.join('; ')}`).toEqual([]);
});

test('RIOTGIRLS: Sequencer-driven gate1 (alt port) produces audio on outL', async ({ page }) => {
  // Mirror of the trig1 test, but routes the Sequencer gate cable into the
  // gateN alternate port. trigN and gateN share the same underlying gate-input
  // node (Web Audio sums multiple sources), so audio activity should be
  // identical.
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto('/rack');
  await page.waitForLoadState('networkidle');

  await spawnPatch(
    page,
    [
      { id: 'seq', type: 'sequencer', params: { bpm: 240, length: 4, isPlaying: 1, gateLength: 0.5 } },
      { id: 'rg',  type: 'riotgirls', params: { v1_volume: 1.5, flt_cutoff: 18000 } },
      { id: 'scope', type: 'scope', params: {} },
      { id: 'out', type: 'audioOut', params: { master: 0.1 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'seq', portId: 'gate' }, to: { nodeId: 'rg', portId: 'gate1' }, sourceType: 'gate', targetType: 'gate' },
      { id: 'e2', from: { nodeId: 'rg', portId: 'outL' },  to: { nodeId: 'scope', portId: 'ch1' } },
      { id: 'e3', from: { nodeId: 'scope', portId: 'ch1_out' }, to: { nodeId: 'out', portId: 'L' } },
      { id: 'e4', from: { nodeId: 'rg', portId: 'outR' },  to: { nodeId: 'out', portId: 'R' } },
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
      seq.data.steps = Array.from({ length: 32 }, (_, i) => ({ on: i < 4, midi: 60 }));
    });
  });

  let peak = 0;
  const start = Date.now();
  while (Date.now() - start < 2500) {
    await page.waitForTimeout(150);
    peak = await readScopePeak(page, 'scope');
    if (peak > 0.001) break;
  }
  expect(peak, `RIOTGIRLS gate1 scope peak (got ${peak})`).toBeGreaterThan(0.001);
  expect(errors, `RIOTGIRLS gate1 errors: ${errors.join('; ')}`).toEqual([]);
});
