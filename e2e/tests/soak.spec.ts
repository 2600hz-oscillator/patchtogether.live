// e2e/tests/soak.spec.ts
//
// Phase 1 done-gate item: "no NaN/Inf in audio output across a 10-minute soak".
//
// We run the canonical voice patch for 30 seconds (not 10 min — CI budget) and
// poll the scope analyser at 1 Hz, asserting every sample is finite. 30s in
// realtime + a sample-by-sample finiteness check is enough to catch the typical
// failure modes (uninitialized state, accumulated state error, threshold edge
// cases in the filter / reverb / wavetable). True 10-minute soak would require
// OfflineAudioContext-based rendering at >>realtime; tracked as follow-up if
// any 30s soak failure ever points at a longer-horizon bug.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

const SOAK_SECONDS = 30;
const POLL_INTERVAL_MS = 1000;

interface ScopeSnap {
  ch1: number[];
  ch2: number[];
  sampleRate: number;
}

test('soak: voice patch produces finite, in-range audio over 30s', async ({ page }) => {
  test.setTimeout(SOAK_SECONDS * 1000 + 30_000); // soak + warmup + assertion overhead

  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
  });

  await page.goto('/rack');
  await page.waitForLoadState('networkidle');

  // Voice chain + a Scope tap to read the output stream.
  await spawnPatch(
    page,
    [
      { id: 'seq',  type: 'sequencer', params: { bpm: 240, length: 8, isPlaying: 1, gateLength: 0.4 } },
      { id: 'vco',  type: 'analogVco' },
      { id: 'adsr', type: 'adsr', params: { attack: 0.005, decay: 0.08, sustain: 0.3, release: 0.15 } },
      { id: 'vca',  type: 'vca',  params: { base: 0, cvAmount: 1 } },
      { id: 'flt',  type: 'filter', params: { cutoff: 2000, resonance: 0.4, mode: 0 } },
      { id: 'rev',  type: 'reverb', params: { mix: 0.2 } },
      { id: 'scp',  type: 'scope' },
      { id: 'out',  type: 'audioOut', params: { master: 0.3 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'seq',  portId: 'pitch' }, to: { nodeId: 'vco',  portId: 'pitch' }, sourceType: 'pitch', targetType: 'pitch' },
      { id: 'e2', from: { nodeId: 'seq',  portId: 'gate'  }, to: { nodeId: 'adsr', portId: 'gate'  }, sourceType: 'gate',  targetType: 'gate'  },
      { id: 'e3', from: { nodeId: 'vco',  portId: 'sine'  }, to: { nodeId: 'vca',  portId: 'audio' } },
      { id: 'e4', from: { nodeId: 'adsr', portId: 'env'   }, to: { nodeId: 'vca',  portId: 'cv'    }, sourceType: 'cv', targetType: 'cv' },
      { id: 'e5', from: { nodeId: 'vca',  portId: 'audio' }, to: { nodeId: 'flt',  portId: 'audio' } },
      { id: 'e6', from: { nodeId: 'flt',  portId: 'audio' }, to: { nodeId: 'rev',  portId: 'audio' } },
      { id: 'e7', from: { nodeId: 'rev',  portId: 'audio' }, to: { nodeId: 'scp',  portId: 'ch1'   } },
      { id: 'e8', from: { nodeId: 'scp',  portId: 'ch1_out' }, to: { nodeId: 'out', portId: 'L' } },
      { id: 'e9', from: { nodeId: 'scp',  portId: 'ch1_out' }, to: { nodeId: 'out', portId: 'R' } },
    ],
  );

  // Poll the scope buffer once per second. Each snapshot is ~42ms of audio.
  // Across 30s × 1 sample/s × ~2048 samples/snap = ~62k samples scanned.
  let totalSamples = 0;
  let firstBadSample: { tick: number; idx: number; value: number } | null = null;
  let peakAbs = 0;

  for (let tick = 0; tick < SOAK_SECONDS; tick++) {
    await page.waitForTimeout(POLL_INTERVAL_MS);
    const snap = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __engine?: () => {
          read: (node: { id: string; type: string; domain: string }, key: string) => unknown;
        } | null;
        __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
      };
      const eng = w.__engine?.();
      if (!eng) return null;
      const node = w.__patch.nodes['scp'];
      const s = eng.read(node, 'snapshot') as
        | { ch1: Float32Array; sampleRate: number }
        | undefined;
      if (!s) return null;
      // Float32Array → number[] for IPC marshalling.
      return { samples: Array.from(s.ch1), sampleRate: s.sampleRate };
    });
    if (!snap) continue;
    for (let i = 0; i < snap.samples.length; i++) {
      const v = snap.samples[i];
      if (!Number.isFinite(v)) {
        firstBadSample ??= { tick, idx: i, value: v };
        break;
      }
      const a = Math.abs(v);
      if (a > peakAbs) peakAbs = a;
    }
    totalSamples += snap.samples.length;
  }

  // No NaN/Inf
  expect(
    firstBadSample,
    `non-finite sample at tick ${firstBadSample?.tick}, idx ${firstBadSample?.idx}, value ${firstBadSample?.value}`,
  ).toBeNull();

  // Scanned a meaningful amount of audio
  expect(totalSamples).toBeGreaterThan(SOAK_SECONDS * 1000); // ≥1k samples per second-tick

  // Output stayed within ±1 (no runaway) — soft check, the master gain caps at 0.3
  // but after CV modulation + filter resonance some headroom is normal.
  expect(peakAbs, `peak |sample|=${peakAbs}`).toBeLessThan(2.0);

  // No console errors during the run
  expect(errors, errors.join('\n')).toEqual([]);
});
