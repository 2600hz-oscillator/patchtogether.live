// e2e/tests/voice-chain.spec.ts
//
// The canonical Phase 1 voice chain:
//   Sequencer.pitch → AnalogVCO.pitch
//   Sequencer.gate  → ADSR.gate
//   AnalogVCO.sine  → VCA.audio
//   ADSR.env        → VCA.cv
//   VCA.audio       → Scope.ch1 → AudioOut.audio
//
// Verifies that connecting these modules with a known-good step pattern and
// known knob values produces audible signal at the output (read via the Scope
// module's analyser — engine.read(node, 'snapshot')).
//
// Conceptually this is the seed for our first "real ART" — same patch shape,
// same knob values, same step data should always produce the same audio. The
// next iteration moves this to OfflineAudioContext + bit-accurate baseline
// comparison; for now the assertion is "audio peak above threshold."

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

interface ScopeSnap {
  ch1: number[];
  ch2: number[];
  sampleRate: number;
}

test('voice-chain: Seq → VCO + ADSR → VCA → Scope → Out produces audible signal', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto('/rack');
  await page.waitForLoadState('networkidle');

  // Deterministic patch: known step pattern + known knob values.
  await spawnPatch(
    page,
    [
      {
        id: 'seq',
        type: 'sequencer',
        params: { bpm: 240, length: 4, isPlaying: 1, gateLength: 0.4 },
      },
      { id: 'vco', type: 'analogVco', params: { tune: 0, fine: 0, fmAmount: 0 } },
      {
        id: 'adsr',
        type: 'adsr',
        params: { attack: 0.005, decay: 0.05, sustain: 0.6, release: 0.05 },
      },
      { id: 'vca', type: 'vca', params: { base: 0, cvAmount: 1 } },
      { id: 'scp', type: 'scope', params: { timeMs: 50 } },
      { id: 'out', type: 'audioOut', params: { master: 0.5 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'seq', portId: 'pitch' }, to: { nodeId: 'vco', portId: 'pitch' }, sourceType: 'pitch', targetType: 'pitch' },
      { id: 'e2', from: { nodeId: 'seq', portId: 'gate' },  to: { nodeId: 'adsr', portId: 'gate' },  sourceType: 'gate',  targetType: 'gate' },
      { id: 'e3', from: { nodeId: 'vco', portId: 'sine' },  to: { nodeId: 'vca', portId: 'audio' } },
      { id: 'e4', from: { nodeId: 'adsr', portId: 'env' },  to: { nodeId: 'vca', portId: 'cv' }, sourceType: 'cv', targetType: 'cv' },
      { id: 'e5', from: { nodeId: 'vca', portId: 'audio' }, to: { nodeId: 'scp', portId: 'ch1' } },
      { id: 'e6', from: { nodeId: 'scp', portId: 'ch1_out' }, to: { nodeId: 'out', portId: 'L' } },
    ]
  );

  // Set the step pattern. Four steps on at known pitches; rest off.
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const seq = w.__patch.nodes['seq'];
      if (!seq.data) seq.data = {};
      seq.data.steps = [
        // v2 step shape: midi int (60 = C4 = 261.626 Hz). null = empty.
        { on: true, midi: 60 },
        { on: true, midi: 64 },
        { on: true, midi: 67 },
        { on: true, midi: 72 },
        ...Array.from({ length: 28 }, () => ({ on: false, midi: null })),
      ];
    });
  });

  // Let the chain run for ~1.5 seconds — at 240 BPM, that's ~24 16th-note steps,
  // wrapping the 4-step pattern 6 times. Plenty of audio activity.
  await page.waitForTimeout(1500);

  // Read the scope's most recent buffer via engine.read(node, 'snapshot').
  // Compute peak — confirms audio is flowing through the entire chain.
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
    let energy = 0;
    let nonzeroSamples = 0;
    for (let i = 0; i < snap.ch1.length; i++) {
      const v = snap.ch1[i];
      const a = Math.abs(v);
      if (a > peak) peak = a;
      energy += v * v;
      if (a > 1e-6) nonzeroSamples++;
    }
    return { peak, rms: Math.sqrt(energy / snap.ch1.length), nonzeroSamples, total: snap.ch1.length };
  });

  if ('error' in result) throw new Error(result.error);

  // Assertions:
  //   peak should be well above silence (sine through enveloped VCA at master 0.5
  //   typically lands in the 0.05–0.4 range).
  //   nonzeroSamples should be substantial (the envelope dips between gate cycles
  //   but we should still see plenty of activity in the rolling 50ms window).
  expect(
    result.peak,
    `voice-chain audio peak too low (peak=${result.peak.toFixed(4)}, rms=${result.rms.toFixed(4)})`
  ).toBeGreaterThan(0.01);
  expect(result.nonzeroSamples).toBeGreaterThan(50);
  expect(errors, errors.join('; ')).toEqual([]);
});

test('voice-chain: stopping the sequencer silences the output (gate goes low)', async ({ page }) => {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');

  await spawnPatch(
    page,
    [
      { id: 'seq', type: 'sequencer', params: { bpm: 240, length: 4, isPlaying: 1, gateLength: 0.4 } },
      { id: 'vco', type: 'analogVco' },
      { id: 'adsr', type: 'adsr', params: { attack: 0.001, decay: 0.05, sustain: 0.5, release: 0.05 } },
      { id: 'vca', type: 'vca', params: { base: 0, cvAmount: 1 } },
      { id: 'scp', type: 'scope', params: { timeMs: 30 } },
      { id: 'out', type: 'audioOut', params: { master: 0.5 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'seq', portId: 'pitch' }, to: { nodeId: 'vco', portId: 'pitch' }, sourceType: 'pitch', targetType: 'pitch' },
      { id: 'e2', from: { nodeId: 'seq', portId: 'gate' },  to: { nodeId: 'adsr', portId: 'gate' },  sourceType: 'gate',  targetType: 'gate' },
      { id: 'e3', from: { nodeId: 'vco', portId: 'sine' },  to: { nodeId: 'vca', portId: 'audio' } },
      { id: 'e4', from: { nodeId: 'adsr', portId: 'env' },  to: { nodeId: 'vca', portId: 'cv' }, sourceType: 'cv', targetType: 'cv' },
      { id: 'e5', from: { nodeId: 'vca', portId: 'audio' }, to: { nodeId: 'scp', portId: 'ch1' } },
      { id: 'e6', from: { nodeId: 'scp', portId: 'ch1_out' }, to: { nodeId: 'out', portId: 'L' } },
    ]
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
        // v2 step shape: midi int (60 = C4 = 261.626 Hz). null = empty.
        { on: true, midi: 60 },
        { on: true, midi: 64 },
        { on: true, midi: 67 },
        { on: true, midi: 72 },
        ...Array.from({ length: 28 }, () => ({ on: false, midi: null })),
      ];
    });
  });

  // Confirm audio first
  await page.waitForTimeout(800);
  const playingPeak = await readScopePeak(page);
  expect(playingPeak, 'expected audible signal while playing').toBeGreaterThan(0.01);

  // Stop the sequencer
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { params: Record<string, number> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      w.__patch.nodes['seq'].params.isPlaying = 0;
    });
  });

  // Wait long enough for the ADSR release tail to die out (release=0.05s).
  await page.waitForTimeout(500);
  const stoppedPeak = await readScopePeak(page);
  expect(
    stoppedPeak,
    `expected silence after stop (peak=${stoppedPeak.toFixed(5)})`
  ).toBeLessThan(0.005);
});

async function readScopePeak(page: import('@playwright/test').Page): Promise<number> {
  const result = await page.evaluate(() => {
    const w = globalThis as unknown as {
      __engine?: () => {
        read: (node: { id: string; type: string; domain: string }, key: string) => unknown;
      } | null;
      __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
    };
    const eng = w.__engine?.();
    if (!eng) return 0;
    const node = w.__patch.nodes['scp'];
    const snap = eng.read(node, 'snapshot') as { ch1: Float32Array } | undefined;
    if (!snap) return 0;
    let peak = 0;
    for (let i = 0; i < snap.ch1.length; i++) {
      const a = Math.abs(snap.ch1[i]);
      if (a > peak) peak = a;
    }
    return peak;
  });
  return result;
}
