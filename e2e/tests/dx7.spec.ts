// e2e/tests/dx7.spec.ts
//
// E2E for the DX7 module (Plaits SixOpEngine, engine_id = 10): spawn a
// Sequencer → DX7 → Scope → AudioOut chain, run for ~1.5 seconds, read
// the scope snapshot, assert peak audio above silence floor.
//
// Companion to art/scenarios/dx7/non-silence.test.ts. ART verifies the
// wasm boots and renders sane numbers offline; this E2E verifies the wasm
// loads via AudioWorklet and produces audio through the patch graph
// end-to-end.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

test('dx7: Seq → DX7 → Scope → Out produces audible signal', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await spawnPatch(
    page,
    [
      {
        id: 'seq',
        type: 'sequencer',
        params: { bpm: 240, length: 4, isPlaying: 1, gateLength: 0.4 },
      },
      {
        id: 'dx7',
        type: 'dx7',
        params: { note: 60, algorithm: 0.0, brightness: 0.6, envelope: 0.5, velocity: 0.5, level: 1 },
      },
      { id: 'scp', type: 'scope', params: { timeMs: 50 } },
      { id: 'out', type: 'audioOut', params: { master: 0.5 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'seq', portId: 'pitch' }, to: { nodeId: 'dx7', portId: 'pitch' }, sourceType: 'pitch', targetType: 'pitch' },
      { id: 'e2', from: { nodeId: 'seq', portId: 'gate' },  to: { nodeId: 'dx7', portId: 'trigger' }, sourceType: 'gate', targetType: 'gate' },
      { id: 'e3', from: { nodeId: 'dx7', portId: 'audio' }, to: { nodeId: 'scp', portId: 'ch1' } },
      { id: 'e4', from: { nodeId: 'scp', portId: 'ch1_out' }, to: { nodeId: 'out', portId: 'L' } },
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
      seq.data.steps = [
        { on: true, midi: 60 },
        { on: true, midi: 64 },
        { on: true, midi: 67 },
        { on: true, midi: 72 },
        ...Array.from({ length: 28 }, () => ({ on: false, midi: null })),
      ];
    });
  });

  await page.waitForTimeout(1500);

  const result = await page.evaluate(() => {
    const w = globalThis as unknown as {
      __engine?: () => {
        read: (node: { id: string; type: string; domain: string }, key: string) => unknown;
      } | null;
      __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
    };
    const eng = w.__engine?.();
    if (!eng) return { error: 'no engine' } as const;
    const node = w.__patch.nodes['scp'];
    const snap = eng.read(node, 'snapshot') as
      | { ch1: Float32Array; sampleRate: number }
      | undefined;
    if (!snap) return { error: 'no snapshot' } as const;
    let peak = 0;
    let nonzero = 0;
    for (let i = 0; i < snap.ch1.length; i++) {
      const a = Math.abs(snap.ch1[i]);
      if (a > peak) peak = a;
      if (a > 1e-6) nonzero++;
    }
    return { peak, nonzero, total: snap.ch1.length };
  });

  if ('error' in result) throw new Error(result.error);

  expect(
    result.peak,
    `dx7 peak too low (peak=${result.peak.toFixed(4)}, nonzero=${result.nonzero}/${result.total})`,
  ).toBeGreaterThan(0.01);
  expect(result.nonzero).toBeGreaterThan(50);
  // Filter out worklet-loading warnings; real wasm faults surface via pageerror.
  const realErrors = errors.filter((e) => !e.includes('plaits.worklet.js'));
  expect(realErrors, realErrors.join('; ')).toEqual([]);
});
