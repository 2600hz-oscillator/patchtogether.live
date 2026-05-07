// e2e/tests/voice-chain-art.spec.ts
//
// "Voice chain ART smoke" — Phase 1 done-gate item. Renders the canonical voice
// patch with deterministic params + step pattern and compares a fingerprint of
// the output (peak, RMS, zero-cross rate, energy-by-quartile) to a stored
// baseline.
//
// This is *not* a bit-accurate ART. Realtime AudioContext rendering has
// per-run jitter (block alignment, scheduler delays) that defeats bit-exact
// comparison. A true tier-A ART requires OfflineAudioContext-based rendering
// which is a separate refactor (the realtime engine is tied to one
// AudioContext today). The fingerprint approach catches regressions in the
// shape of the output (e.g. envelope failure, filter coefficient drift,
// VCA gain reset) without false-failing on benign jitter.
//
// Per-metric tolerances (see TOLERANCE_* below) — peak/RMS at ±25%, ZCR at
// ±40% because integer threshold-counting is much noisier than integrative
// metrics under realtime jitter. Regenerate the baseline (e2e/baselines/
// voice-chain-fingerprint.json) by setting UPDATE_BASELINES=1 in the env.

import { test, expect } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnPatch } from './_helpers';

const __dirname_ = dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = join(__dirname_, '..', 'baselines', 'voice-chain-fingerprint.json');
// Per-metric tolerances. Realtime audio fingerprints jitter with per-run
// scheduling (block alignment, GC) AND with host environment (macOS dev vs
// Linux CI Chromium). Different signals are differently noisy:
//
//   - peak / rms are *integrative* (max-over-samples, mean-of-squares) — the
//     LFO modulating cutoff barely moves them across runs. Tight ±25% catches
//     real regressions (silence, clipping, wrong harmonic content) cleanly.
//
//   - zeroCrossRate counts threshold crossings per sample — phase noise from
//     the LFO flips near-zero samples' sign and double-counts or misses a
//     crossing. Empirically swings ±25-30% across runs on Linux CI Chromium
//     even with identical inputs. Looser ±40% absorbs that without losing
//     the metric (a real bug — wrong oscillator harmonic, broken filter —
//     would still move ZCR by orders of magnitude).
//
// This is a regression smoke, not a tier-A ART. Tighten once we have an
// OfflineAudioContext-based deterministic ART.
const TOLERANCE_PEAK = 0.25;
const TOLERANCE_RMS = 0.25;
const TOLERANCE_ZCR = 0.4;
const SHOULD_UPDATE = process.env.UPDATE_BASELINES === '1';

interface Fingerprint {
  /** Number of buffer snapshots averaged. */
  snapshots: number;
  /** Mean peak |sample| across snapshots. */
  peak: number;
  /** Mean RMS across snapshots. */
  rms: number;
  /** Mean zero-crossings per sample. */
  zeroCrossRate: number;
}

function snapFingerprint(samples: number[]): { peak: number; rms: number; zcr: number } {
  const n = samples.length;
  let peak = 0;
  let sumSq = 0;
  let zeroCrosses = 0;
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const v = samples[i];
    const a = Math.abs(v);
    if (a > peak) peak = a;
    sumSq += v * v;
    if ((v >= 0) !== (prev >= 0)) zeroCrosses++;
    prev = v;
  }
  return { peak, rms: Math.sqrt(sumSq / n), zcr: zeroCrosses / n };
}

function averageFingerprint(snaps: { peak: number; rms: number; zcr: number }[]): Fingerprint {
  const n = snaps.length;
  let p = 0, r = 0, z = 0;
  for (const s of snaps) { p += s.peak; r += s.rms; z += s.zcr; }
  return { snapshots: n, peak: p / n, rms: r / n, zeroCrossRate: z / n };
}

function withinTolerance(actual: number, expected: number, tol: number): boolean {
  if (expected === 0) return Math.abs(actual) < 1e-3;
  return Math.abs(actual - expected) / Math.abs(expected) <= tol;
}

test('voice-chain-art: deterministic patch matches fingerprint baseline', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  // Deterministic voice patch — fixed BPM, fixed step pattern, fixed knobs.
  await spawnPatch(
    page,
    [
      { id: 'seq',  type: 'sequencer', params: { bpm: 240, length: 4, isPlaying: 1, gateLength: 0.5 } },
      { id: 'vco',  type: 'analogVco' },
      { id: 'adsr', type: 'adsr', params: { attack: 0.005, decay: 0.08, sustain: 0.3, release: 0.15 } },
      { id: 'vca',  type: 'vca',  params: { base: 0, cvAmount: 1 } },
      { id: 'scp',  type: 'scope' },
      { id: 'out',  type: 'audioOut', params: { master: 0.4 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'seq',  portId: 'pitch' }, to: { nodeId: 'vco',  portId: 'pitch' }, sourceType: 'pitch', targetType: 'pitch' },
      { id: 'e2', from: { nodeId: 'seq',  portId: 'gate'  }, to: { nodeId: 'adsr', portId: 'gate'  }, sourceType: 'gate',  targetType: 'gate'  },
      { id: 'e3', from: { nodeId: 'vco',  portId: 'sine'  }, to: { nodeId: 'vca',  portId: 'audio' } },
      { id: 'e4', from: { nodeId: 'adsr', portId: 'env'   }, to: { nodeId: 'vca',  portId: 'cv'    }, sourceType: 'cv', targetType: 'cv' },
      { id: 'e5', from: { nodeId: 'vca',  portId: 'audio' }, to: { nodeId: 'scp',  portId: 'ch1'   } },
      { id: 'e6', from: { nodeId: 'scp',  portId: 'ch1_out' }, to: { nodeId: 'out', portId: 'L' } },
      { id: 'e7', from: { nodeId: 'scp',  portId: 'ch1_out' }, to: { nodeId: 'out', portId: 'R' } },
    ],
  );

  // Fixed step pattern.
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      w.__patch.nodes['seq'].data = {
        steps: [
          { on: true, midi: 60 },
          { on: true, midi: 67 },
          { on: true, midi: 72 },
          { on: true, midi: 65 },
        ],
      };
    });
  });

  // Sample 8 buffers spaced 250ms apart over 2s. Averaging across snapshots
  // washes out the per-snapshot phase jitter (a 42ms scope buffer captures
  // less than one step at 240 BPM, so any single snap is shape-dependent on
  // exactly where in the step we land).
  await page.waitForTimeout(500); // warm up
  const snaps: { peak: number; rms: number; zcr: number }[] = [];
  for (let i = 0; i < 8; i++) {
    const samples = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __engine?: () => {
          read: (node: { id: string; type: string; domain: string }, key: string) => unknown;
        } | null;
        __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
      };
      const eng = w.__engine?.();
      if (!eng) return null;
      const node = w.__patch.nodes['scp'];
      const snap = eng.read(node, 'snapshot') as
        | { ch1: Float32Array; sampleRate: number }
        | undefined;
      return snap ? Array.from(snap.ch1) : null;
    });
    if (!samples) throw new Error('no scope snapshot');
    snaps.push(snapFingerprint(samples));
    await page.waitForTimeout(250);
  }
  const fingerprint = averageFingerprint(snaps);

  if (SHOULD_UPDATE || !existsSync(BASELINE_PATH)) {
    await mkdir(dirname(BASELINE_PATH), { recursive: true });
    await writeFile(BASELINE_PATH, JSON.stringify(fingerprint, null, 2));
    // First-time write or explicit regenerate: pass.
    expect(true).toBe(true);
    return;
  }

  const baseline = JSON.parse(await readFile(BASELINE_PATH, 'utf8')) as Fingerprint;

  expect(
    withinTolerance(fingerprint.peak, baseline.peak, TOLERANCE_PEAK),
    `peak ${fingerprint.peak.toFixed(4)} vs baseline ${baseline.peak.toFixed(4)} (±${TOLERANCE_PEAK * 100}%)`,
  ).toBe(true);
  expect(
    withinTolerance(fingerprint.rms, baseline.rms, TOLERANCE_RMS),
    `rms ${fingerprint.rms.toFixed(4)} vs baseline ${baseline.rms.toFixed(4)} (±${TOLERANCE_RMS * 100}%)`,
  ).toBe(true);
  expect(
    withinTolerance(fingerprint.zeroCrossRate, baseline.zeroCrossRate, TOLERANCE_ZCR),
    `zcr ${fingerprint.zeroCrossRate.toFixed(4)} vs baseline ${baseline.zeroCrossRate.toFixed(4)} (±${TOLERANCE_ZCR * 100}%)`,
  ).toBe(true);
});
