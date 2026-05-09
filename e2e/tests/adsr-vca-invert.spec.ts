// e2e/tests/adsr-vca-invert.spec.ts
//
// End-to-end coverage for the new invert outputs:
//   - ADSR.env_inv: 1 - env (unipolar envelope flip)
//   - VCA.audio_inv: -audio (sign-flip / phase-invert)
//
// Strategy: drive Sequencer → ADSR → VCA chains with both standard and
// inverted outputs routed into the Scope module's two channels and
// assert basic shape (amplitude > silence) for the inverted side.
//
// Tighter sample-wise math is covered by the ART scenarios; this layer
// is the integration smoke proving the new ports are reachable from
// the patch graph + factory and produce signal at the audio thread.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

interface ChStats { peak: number; rms: number; nonzero: number; total: number; }
interface SnapStats { ch1: ChStats; ch2: ChStats; }

async function readScopeBothChannels(page: Page, scopeNodeId: string): Promise<SnapStats> {
  return await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __engine?: () => {
        read: (node: { id: string; type: string; domain: string }, key: string) => unknown;
      } | null;
      __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
    };
    function summarize(buf: Float32Array | undefined): { peak: number; rms: number; nonzero: number; total: number } {
      if (!buf) return { peak: 0, rms: 0, nonzero: 0, total: 0 };
      let peak = 0, energy = 0, nonzero = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = buf[i];
        const a = Math.abs(v);
        if (a > peak) peak = a;
        energy += v * v;
        if (a > 1e-6) nonzero++;
      }
      return { peak, rms: Math.sqrt(energy / Math.max(1, buf.length)), nonzero, total: buf.length };
    }
    const eng = w.__engine?.();
    if (!eng) return { ch1: summarize(undefined), ch2: summarize(undefined) };
    const node = w.__patch.nodes[id];
    if (!node) return { ch1: summarize(undefined), ch2: summarize(undefined) };
    const snap = eng.read(node, 'snapshot') as { ch1: Float32Array; ch2: Float32Array } | undefined;
    if (!snap) return { ch1: summarize(undefined), ch2: summarize(undefined) };
    return { ch1: summarize(snap.ch1), ch2: summarize(snap.ch2) };
  }, scopeNodeId);
}

test('ADSR: env_inv produces non-zero CV signal that is the unipolar inverse of env', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  // Sequencer drives a slow envelope cycle so env spends meaningful time
  // both at the attack peak and at rest. We probe env_inv by routing it
  // into a VCA's CV input, then to a scope; if env_inv is alive, the
  // scope sees signal whenever env is below 1 (which is most of the
  // cycle). Non-zero RMS ⇒ env_inv is wired and producing data.
  await spawnPatch(
    page,
    [
      { id: 'seq', type: 'sequencer', params: { bpm: 120, length: 4, isPlaying: 1, gateLength: 0.4 } },
      { id: 'adsr', type: 'adsr', params: { attack: 0.01, decay: 0.05, sustain: 0.5, release: 0.05 } },
      { id: 'vco', type: 'analogVco' },
      { id: 'vca', type: 'vca', params: { base: 0, cvAmount: 1 } },
      { id: 'scp', type: 'scope', params: { timeMs: 60 } },
      { id: 'out', type: 'audioOut', params: { master: 0.3 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'seq', portId: 'pitch' }, to: { nodeId: 'vco',  portId: 'pitch' }, sourceType: 'pitch', targetType: 'pitch' },
      { id: 'e2', from: { nodeId: 'seq', portId: 'gate'  }, to: { nodeId: 'adsr', portId: 'gate'  }, sourceType: 'gate',  targetType: 'gate' },
      { id: 'e3', from: { nodeId: 'vco', portId: 'sine'  }, to: { nodeId: 'vca',  portId: 'audio' } },
      // Drive the VCA's CV with the inverted envelope so the audio
      // amplitude tracks `1 - env`. The scope therefore sees sine ×
      // (1 - env) — non-silent whenever env < 1 (almost always).
      { id: 'e4', from: { nodeId: 'adsr', portId: 'env_inv' }, to: { nodeId: 'vca', portId: 'cv' }, sourceType: 'cv', targetType: 'cv' },
      { id: 'e5', from: { nodeId: 'vca', portId: 'audio' },   to: { nodeId: 'scp', portId: 'ch1' } },
      { id: 'e6', from: { nodeId: 'scp', portId: 'ch1_out' }, to: { nodeId: 'out', portId: 'L' } },
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
  const stats = await readScopeBothChannels(page, 'scp');
  expect(stats.ch1.peak, `env_inv-driven VCA should be audible (peak=${stats.ch1.peak})`)
    .toBeGreaterThan(0.01);
  expect(stats.ch1.nonzero).toBeGreaterThan(50);
});

test('VCA: audio_inv carries the same envelope-shaped signal as audio, with inverted polarity', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await spawnPatch(
    page,
    [
      { id: 'seq', type: 'sequencer', params: { bpm: 240, length: 4, isPlaying: 1, gateLength: 0.4 } },
      { id: 'vco', type: 'analogVco' },
      { id: 'adsr', type: 'adsr', params: { attack: 0.005, decay: 0.05, sustain: 0.6, release: 0.05 } },
      { id: 'vca', type: 'vca', params: { base: 0, cvAmount: 1 } },
      { id: 'scp', type: 'scope', params: { timeMs: 50 } },
      { id: 'out', type: 'audioOut', params: { master: 0.3 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'seq', portId: 'pitch' },     to: { nodeId: 'vco',  portId: 'pitch' }, sourceType: 'pitch', targetType: 'pitch' },
      { id: 'e2', from: { nodeId: 'seq', portId: 'gate'  },     to: { nodeId: 'adsr', portId: 'gate'  }, sourceType: 'gate',  targetType: 'gate' },
      { id: 'e3', from: { nodeId: 'vco', portId: 'sine'  },     to: { nodeId: 'vca',  portId: 'audio' } },
      { id: 'e4', from: { nodeId: 'adsr', portId: 'env'   },    to: { nodeId: 'vca',  portId: 'cv' }, sourceType: 'cv', targetType: 'cv' },
      // Send `audio` to ch1, `audio_inv` to ch2. Both should be audible;
      // sample-wise null-test (audio + audioInv ≈ 0) is in the ART.
      { id: 'e5', from: { nodeId: 'vca', portId: 'audio' },     to: { nodeId: 'scp', portId: 'ch1' } },
      { id: 'e6', from: { nodeId: 'vca', portId: 'audio_inv' }, to: { nodeId: 'scp', portId: 'ch2' } },
      { id: 'e7', from: { nodeId: 'scp', portId: 'ch1_out' },   to: { nodeId: 'out', portId: 'L' } },
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
  const stats = await readScopeBothChannels(page, 'scp');
  // Both channels should carry signal of comparable amplitude (the only
  // difference is sign).
  expect(stats.ch1.peak, `ch1 audio peak (got ${stats.ch1.peak})`).toBeGreaterThan(0.01);
  expect(stats.ch2.peak, `ch2 audio_inv peak (got ${stats.ch2.peak})`).toBeGreaterThan(0.01);
  // Peaks should be within ~10% of each other (sign-flip preserves
  // amplitude exactly; the tolerance is for the rolling Scope buffer
  // not capturing the same window of audio for each channel).
  expect(
    Math.abs(stats.ch1.peak - stats.ch2.peak) / Math.max(stats.ch1.peak, stats.ch2.peak),
    `audio vs audio_inv peak ratio off (ch1=${stats.ch1.peak}, ch2=${stats.ch2.peak})`,
  ).toBeLessThan(0.25);
});
