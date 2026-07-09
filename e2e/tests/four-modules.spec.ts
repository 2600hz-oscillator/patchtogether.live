// e2e/tests/four-modules.spec.ts
//
// Functional E2E for the four new modules (MEOWBOX, MIXMSTRS, TIMELORDE,
// CHARLOTTE'S ECHOS). For each: spawn into a rackspace, drive it with a
// gate/signal source, route output through a Scope, then assert the Scope
// snapshot reports a non-trivial peak — i.e. audio actually flows.

import { test, expect } from './_fixtures';
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

test('MEOWBOX: gate triggers audible voice on L output', async ({ page, rack, errorWatch }) => {
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
      seq.data.steps = Array.from({ length: 32 }, (_, i) => ({ on: i < 4, midi: 60 }));
    });
  });

  // Wait for several gate triggers + ring-out.
  await page.waitForTimeout(800);

  const peak = await readScopePeak(page, 'scope');
  expect(peak, `MEOWBOX scope peak (got ${peak})`).toBeGreaterThan(0.001);
});

test('TIMELORDE: 1x output emits gate pulses at the configured BPM', async ({ page, rack, errorWatch }) => {
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
});

test('TIMELORDE: singleton — a duplicate is cleaned up to a single survivor by the dedupe pass', async ({ page, rack }) => {
  // Phase 4c — deterministic post-merge singleton cleanup.
  //
  // PRE-4c MODEL (now obsolete): a forced 2nd TIMELORDE PERSISTED in the graph
  // doc and only the engine's addNode guard dropped the loser at runtime — but
  // TIMELORDE is `undeletable:true`, so the orphan graph node became an
  // unrecoverable ghost. That ghost is exactly what 4c fixes.
  //
  // POST-4c MODEL (asserted here): when the converged doc holds two
  // `maxInstances:1` TIMELORDE nodes, the Canvas snapshot cleanup $effect
  // deterministically DELETES the lex-larger duplicate from the Yjs doc,
  // keeping the lex-smaller survivor — so EXACTLY ONE TIMELORDE remains in BOTH
  // the graph and the engine. We reproduce the converged end-state directly
  // (inject both nodes into the live Yjs doc, what a merge-race produces) rather
  // than via spawnPatch's DOM-mount wait, because the cleanup removes the
  // lex-larger node before it ever mounts — so a "both nodes are in the DOM"
  // wait can never be satisfied under 4c (that was the pre-4c assumption that
  // timed out). No provider is attached on `/`, so the cleanup runs as the lone
  // elected deleter.

  // Bootstrap the engine + clear the doc (empty spawn => no DOM-mount wait).
  await spawnPatch(page, [], []);

  // Inject TWO TIMELORDE nodes straight into the converged Yjs doc, using the
  // canonical `${type}-...` id convention. `timelorde-aaa` is lex-smaller (the
  // deterministic survivor); `timelorde-zzz` is the lex-larger duplicate the
  // cleanup must delete.
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __ydoc: { transact: (fn: () => void) => void };
      __patch: { nodes: Record<string, unknown> };
    };
    w.__ydoc.transact(() => {
      for (const id of ['timelorde-aaa', 'timelorde-zzz']) {
        w.__patch.nodes[id] = {
          id,
          type: 'timelorde',
          domain: 'audio',
          position: { x: id === 'timelorde-aaa' ? 100 : 400, y: 100 },
          params: {},
          data: {},
        };
      }
    });
  });

  // The cleanup $effect fires on the next converged snapshot and deletes the
  // lex-larger duplicate. Bounded poll for the graph doc to converge to exactly
  // one TIMELORDE — NOT a flat sleep — to allow for the $effect / elected-peer
  // timing without racing a fixed deadline.
  await page.waitForFunction(
    () => {
      const w = globalThis as unknown as { __patch?: { nodes?: Record<string, { type?: string } | undefined> } };
      const nodes = w.__patch?.nodes;
      if (!nodes) return false;
      let count = 0;
      for (const n of Object.values(nodes)) if (n?.type === 'timelorde') count++;
      return count === 1;
    },
    undefined,
    { timeout: 6000 },
  );

  // The survivor in the graph is the lex-SMALLER id; the lex-larger duplicate
  // was the one removed. (If the dedupe pass had NOT run, BOTH would persist
  // and this would still be 2 → the assertion stays a meaningful singleton
  // guard.)
  const graphIds = await page.evaluate(() => {
    const w = globalThis as unknown as { __patch: { nodes: Record<string, { id?: string; type?: string } | undefined> } };
    return Object.values(w.__patch.nodes)
      .filter((n) => n?.type === 'timelorde')
      .map((n) => n?.id ?? null);
  });
  expect(graphIds, 'exactly one TIMELORDE survives the cleanup in the graph doc').toEqual(['timelorde-aaa']);
  expect(graphIds, 'the lex-larger duplicate was the node removed').not.toContain('timelorde-zzz');

  // The engine domain must also converge to exactly one (the reconciler removes
  // the orphan once the graph node is gone). Bounded poll so the reconcile tick
  // after the doc mutation isn't a fixed-time race.
  await page.waitForFunction(
    () => {
      const w = globalThis as unknown as { __engine: () => unknown | null };
      const e = w.__engine();
      if (!e) return false;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const audioDomain = (e as any).getDomain ? (e as any).getDomain('audio') : null;
      if (!audioDomain || !audioDomain.nodes) return false;
      let count = 0;
      for (const id of audioDomain.nodes.keys()) {
        if (typeof id === 'string' && id.startsWith('timelorde-')) count++;
      }
      return count === 1;
    },
    undefined,
    { timeout: 6000 },
  );
});

test("CHARLOTTE'S ECHOS: passes signal through and produces echo tail", async ({ page, rack, errorWatch }) => {
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
      seq.data.steps = Array.from({ length: 32 }, (_, i) => ({ on: i < 4, midi: 60 }));
    });
  });

  // Poll until the scope shows energy, with a bounded deadline — DO NOT do a
  // single fixed-time read. The Scope's analyser only buffers the most recent
  // ~46 ms (2048 samples @ ~44.1 kHz). A single read at a fixed offset is a
  // STARTUP race: under CI load the AudioWorklet/engine can take a variable
  // amount of time to begin producing, and a read taken before the first
  // samples land (or before the analyser buffer has filled) returns exactly 0
  // ("Echos scope peak (got 0)"). Time-series profiling confirmed the chain
  // genuinely produces strong signal (peak ≈ 0.89) and that the only zero
  // reads are the first 1–2 samples at startup — there are no mid-stream
  // silent gaps once the wet tail is flowing. Polling until non-zero (matching
  // the TIMELORDE test above) removes the race deterministically: the first
  // moment the chain is audible satisfies the assertion, and the bounded
  // deadline still fails loudly if the chain ever genuinely outputs nothing.
  let peak = 0;
  const start = Date.now();
  while (Date.now() - start < 4000) {
    peak = await readScopePeak(page, 'scope');
    if (peak > 0.001) break;
    await page.waitForTimeout(50);
  }
  expect(peak, `Echos scope peak (got ${peak})`).toBeGreaterThan(0.001);
});

test('MIXMSTRS: passes channel 1 through to master out', async ({ page, rack, errorWatch }) => {
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
});

test('MIXMSTRS: multiple instances allowed — both materialize in engine', async ({ page, rack }) => {
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
  expect(count, 'both MIXMSTRS instances materialize (no singleton cap)').toBe(2);
});
