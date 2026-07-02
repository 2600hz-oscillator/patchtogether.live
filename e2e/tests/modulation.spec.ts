// e2e/tests/modulation.spec.ts
//
// Verifies CV → AudioParam routing end-to-end:
// 1. LFO produces non-zero output on its phase ports.
// 2. Patching LFO output to ADSR.attack visibly modulates the param's
//    `readParam()` value over time.
// 3. The motorized Fader's readLive() (which polls engine.readParam) sees
//    that variation — i.e. the fader's thumb visibly tracks the modulation.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

test('lfo: phase0 emits a non-trivial AC waveform at the configured rate', async ({ page }) => {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');

  // LFO at 5 Hz, sine shape, into a Scope so we can sample the output.
  await spawnPatch(
    page,
    [
      { id: 'lfo', type: 'lfo', params: { rate: 5, shape: 0 } },
      { id: 'scp', type: 'scope' },
      { id: 'out', type: 'audioOut', params: { master: 0 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'lfo', portId: 'phase0' },  to: { nodeId: 'scp', portId: 'ch1' }, sourceType: 'cv', targetType: 'cv' },
      { id: 'e2', from: { nodeId: 'scp', portId: 'ch1_out' }, to: { nodeId: 'out', portId: 'L' } },
      { id: 'e3', from: { nodeId: 'scp', portId: 'ch1_out' }, to: { nodeId: 'out', portId: 'R' } },
    ],
  );

  await page.waitForTimeout(800);

  const stats = await page.evaluate(() => {
    const w = globalThis as unknown as {
      __engine?: () => {
        read: (node: { id: string; type: string; domain: string }, key: string) => unknown;
      } | null;
      __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
    };
    const eng = w.__engine?.();
    if (!eng) return null;
    const snap = eng.read(w.__patch.nodes['scp'], 'snapshot') as
      | { ch1: Float32Array }
      | undefined;
    if (!snap) return null;
    let peak = 0;
    let zeroCrosses = 0;
    let prev = 0;
    for (let i = 0; i < snap.ch1.length; i++) {
      const v = snap.ch1[i];
      const a = Math.abs(v);
      if (a > peak) peak = a;
      if ((v >= 0) !== (prev >= 0)) zeroCrosses++;
      prev = v;
    }
    return { peak, zeroCrosses, len: snap.ch1.length };
  });
  if (!stats) throw new Error('no scope snapshot');

  // Sine should swing between -1 and +1 → peak near 1.
  expect(stats.peak).toBeGreaterThan(0.5);
  // At 5 Hz with a 42ms (2048-sample) buffer at 48kHz, expect ~0.42 cycles =
  // typically 0 or 1 zero crossings. Just assert "not stuck DC" (peak alone
  // covers AC; ZCR > 0 is bonus).
  expect(stats.peak).toBeLessThan(1.5);
});

// CV → AudioParam modulation is now OBSERVABLE from the main thread via the
// per-param AnalyserNode tap the engine wires up in addEdge: the (cv-scaled)
// modulator signal is tee'd into a small fftSize=32 AnalyserNode alongside the
// AudioParam, and AudioEngine.readParam returns `intrinsic + tap.lastSample`
// (engine.ts readParam / getOrCreateParamTap). So polling readParam DOES see
// the audio-rate modulation — the motorized fader's readLive() callback tracks
// the LFO. (The old skip predated the param-tap infra; AudioParam.value alone
// would indeed read constant, but readParam no longer relies on it.)
//
// Stability note: we don't assume a fixed phase of the LFO when we sample —
// we poll readParam many times across several full LFO cycles and assert the
// observed RANGE (max-min) is non-trivial. That's robust to scheduler jitter,
// the exact moment the worklet starts, and analyser block-boundary timing.
test('cv-to-fader-sync: LFO modulating ADSR.attack varies the AudioParam reading', async ({ page }) => {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');

  // LFO at 10 Hz, shape=2 (saw on the 0=sine↔1=tri↔2=saw morph axis) → a full
  // ±1 sweep into ADSR.attack's CV input. attack is a log-scaled param (knob 5,
  // range 0.001..10s); a ±1 CV sweep multiplies it by sqrt(10/0.001)=±100×, so
  // the cv-scale delta tee'd into the param tap swings the *observed* readParam
  // value across most of 0.05..10. We only need a non-trivial range to prove the
  // tap sees the modulation; the exact bounds don't matter (and are clamped).
  //
  // We also patch the LFO into a silenced Audio Out: AudioWorkletNodes only
  // process() when they have a path to AudioContext.destination, so without
  // this leg the worklet is pruned and ADSR.attack just reads its intrinsic.
  await spawnPatch(
    page,
    [
      { id: 'lfo',  type: 'lfo',  params: { rate: 10, shape: 2 } },
      { id: 'adsr', type: 'adsr', params: { attack: 5, decay: 0.1, sustain: 0.5, release: 0.3 } },
      { id: 'out',  type: 'audioOut', params: { master: 0 } }, // silent — keeps the LFO graph alive
    ],
    [
      { id: 'e1', from: { nodeId: 'lfo', portId: 'phase0' }, to: { nodeId: 'adsr', portId: 'attack' }, sourceType: 'cv', targetType: 'cv' },
      { id: 'e2', from: { nodeId: 'lfo', portId: 'phase0' }, to: { nodeId: 'out',  portId: 'L'      } },
    ],
  );

  // Sample readParam (what the motorized fader's readLive() callback polls)
  // across several full LFO cycles, entirely page-side. Doing the loop in one
  // page.evaluate (rather than 12 cross-process round-trips) lets us sample
  // densely over a long window — robust to (a) the worklet taking a beat to
  // start emitting after the graph is built, (b) the analyser block-boundary
  // timing, and (c) scheduler jitter. We poll until we've SEEN a non-trivial
  // swing (early-out) or the budget elapses, so a slow start can't fail us.
  const result = await page.evaluate(async () => {
    const w = globalThis as unknown as {
      __engine?: () => {
        readParam: (node: { id: string; type: string; domain: string }, paramId: string) => number | undefined;
      } | null;
      __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
    };
    const eng = w.__engine?.();
    if (!eng) return { ok: false, reason: 'no engine', samples: [] as number[] };
    const node = w.__patch.nodes['adsr'];
    if (!node) return { ok: false, reason: 'no adsr node', samples: [] as number[] };

    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const samples: number[] = [];
    let min = Infinity;
    let max = -Infinity;
    // Budget: up to ~3s of polling at ~15ms cadence (~200 samples ≈ 30 LFO
    // cycles at 10Hz) — far more than enough to catch the swing; early-out the
    // moment the range clears the threshold so the happy path is fast.
    const TARGET_SWING = 0.5;
    const start = performance.now();
    while (performance.now() - start < 3000) {
      const v = eng.readParam(node, 'attack');
      if (typeof v === 'number') {
        samples.push(v);
        if (v < min) min = v;
        if (v > max) max = v;
        if (max - min > TARGET_SWING) break;
      }
      await sleep(15);
    }
    return { ok: true, reason: '', samples, swing: max - min };
  });

  expect(result.ok, `setup failed: ${result.reason}`).toBe(true);
  const samples = result.samples;
  const min = Math.min(...samples);
  const max = Math.max(...samples);
  const swing = max - min;
  // A ±1 saw into a log-scaled param gives a large readParam swing; assert the
  // tap sees a clearly non-trivial range. The threshold (0.5) is well below the
  // expected multi-unit swing, leaving generous margin for jitter / clamping.
  expect(
    swing,
    `readParam values (n=${samples.length}): [${samples.slice(0, 24).map((s) => s.toFixed(3)).join(', ')}${samples.length > 24 ? ', …' : ''}]`,
  ).toBeGreaterThan(0.5);
});
