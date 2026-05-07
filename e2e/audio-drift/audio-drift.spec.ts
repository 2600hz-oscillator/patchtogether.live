// e2e/audio-drift/audio-drift.spec.ts
//
// @audio-drift research harness: drives two browser contexts, both joined to the
// same Yjs rackspace, builds a series of patches, captures audio buffers from
// each side, and computes drift metrics to inform the Phase-C decision.
//
// This is NOT a regression test — runs are intentionally non-deterministic
// (real AudioContext clocks, real Yjs sync). It's tagged @audio-drift so it
// stays out of CI's PR-gate path.
//
// Run:
//   flox activate -- task audio-drift
//
// Outputs:
//   - art/audio-drift/results-<date>.json
//   - art/audio-drift/report-<date>.md

import { test } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openTwoContexts, authorPatchAndAwaitSync, type PatchSpec } from './_collab';
import { recordAudio } from './_capture';
import { compare, verdict, type CompareMetrics } from './_metrics';

const __dirname_ = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(__dirname_, '..', '..', 'art', 'audio-drift');
const RECORD_SECONDS = Number(process.env.AUDIO_DRIFT_SECONDS ?? '5');
// Number of times to repeat each scenario. Run-to-run variance is large
// (sequencer drift can swing from -45 to +564 μs/sec across runs depending
// on whether the two AudioContexts happened to align at start). Repeating
// stabilizes the metric — we report mean + stddev across runs.
const RUNS_PER_SCENARIO = Number(process.env.AUDIO_DRIFT_RUNS ?? '3');

interface ScenarioResult {
  name: string;
  description: string;
  durationSec: number;
  sampleRate: number;
  capturedSamplesA: number;
  capturedSamplesB: number;
  /** Mean of metrics across all runs. */
  metrics: CompareMetrics;
  /** Per-run metrics (length = RUNS_PER_SCENARIO). */
  runs: CompareMetrics[];
  /** Standard deviation of phase drift across runs. */
  phaseDriftStdUsPerSec: number;
  /** Standard deviation of spectral avg across runs. */
  spectralAvgStd: number;
  verdict: string;
  /** Brief acceptability per the user's framework (skip-Phase-C / hybrid / Phase-C-needed). */
  acceptableForShipWithoutPhaseC: 'yes' | 'no' | 'with-caveats';
  notes?: string;
  error?: string;
}

interface RunResults {
  startedAt: string;
  finishedAt: string;
  baseURL: string;
  scenarios: ScenarioResult[];
}

const allResults: ScenarioResult[] = [];
const runStartedAt = new Date().toISOString();

// Helpers --------------------------------------------------------------------

const COMMON_AUDIO_OUT = (id = 'out'): PatchSpec['nodes'][number] => ({
  id,
  type: 'audioOut',
  params: { master: 0.7 },
});

function classifyAcceptable(
  m: CompareMetrics,
  options: { tolerantPhaseDrift?: boolean; allowStochastic?: boolean } = {},
): ScenarioResult['acceptableForShipWithoutPhaseC'] {
  // Spectral correlation is "are the two streams the same musical content?".
  // Time-domain pearson is "are the two streams sample-aligned?". For two
  // independent users on different machines, sample-alignment is irrelevant —
  // they're listening on different speakers, not summing the streams. What
  // matters is: do they hear the same notes, the same harmonic content, the
  // same envelope shapes? That's what spectral correlation captures.
  //
  // The exception is when phase drift accumulates over time on a CLOCKED
  // patch — that's the case where User A's downbeat slowly slides past
  // User B's downbeat over a 5-minute jam. We bound that explicitly.

  if (options.allowStochastic) {
    const rmsClose = Math.abs(m.rmsA - m.rmsB) / Math.max(m.rmsA, m.rmsB, 1e-6) < 0.5;
    if (m.spectralPearsonAvg >= 0.7 && rmsClose) return 'yes';
    return 'with-caveats';
  }
  if (options.tolerantPhaseDrift) {
    // Clocked content. Require high spectral correlation (notes line up
    // harmonically) AND drift not catastrophic. Phase drift > 200 μs/sec
    // would mean ~6ms slip per 30s — audibly drifting.
    if (m.spectralPearsonAvg >= 0.9 && Math.abs(m.phaseDriftUsPerSec) <= 200) return 'yes';
    if (m.spectralPearsonAvg >= 0.75) return 'with-caveats';
    return 'no';
  }
  // Static patches: spectral correlation must be near-perfect. Phase drift
  // here is essentially a measurement artifact (cross-correlation of a periodic
  // signal can lock onto multiple lags); we don't gate on it.
  if (m.spectralPearsonAvg >= 0.98) return 'yes';
  if (m.spectralPearsonAvg >= 0.9) return 'with-caveats';
  return 'no';
}

function meanMetrics(runs: CompareMetrics[]): CompareMetrics {
  const n = runs.length;
  const out: CompareMetrics = {
    pearson: 0, rmsDiff: 0, spectralPearsonAvg: 0, spectralPearsonWorst: 0,
    phaseDriftUsPerSec: 0, rmsA: 0, rmsB: 0,
  };
  for (const r of runs) {
    out.pearson += r.pearson;
    out.rmsDiff += r.rmsDiff;
    out.spectralPearsonAvg += r.spectralPearsonAvg;
    out.spectralPearsonWorst += r.spectralPearsonWorst;
    out.phaseDriftUsPerSec += r.phaseDriftUsPerSec;
    out.rmsA += r.rmsA;
    out.rmsB += r.rmsB;
  }
  return {
    pearson: out.pearson / n,
    rmsDiff: out.rmsDiff / n,
    spectralPearsonAvg: out.spectralPearsonAvg / n,
    spectralPearsonWorst: out.spectralPearsonWorst / n,
    phaseDriftUsPerSec: out.phaseDriftUsPerSec / n,
    rmsA: out.rmsA / n,
    rmsB: out.rmsB / n,
  };
}

function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const sumSq = values.reduce((s, v) => s + (v - mean) ** 2, 0);
  return Math.sqrt(sumSq / (values.length - 1));
}

async function runScenarioOnce(opts: {
  browser: import('@playwright/test').Browser;
  patch: PatchSpec;
  warmupMs: number;
}): Promise<{ metrics: CompareMetrics; sampleRate: number; samplesA: number; samplesB: number }> {
  const pair = await openTwoContexts(opts.browser);
  try {
    await authorPatchAndAwaitSync(pair, opts.patch);
    await pair.pageA.waitForTimeout(opts.warmupMs);
    const [recA, recB] = await Promise.all([
      recordAudio(pair.pageA, 'out', RECORD_SECONDS),
      recordAudio(pair.pageB, 'out', RECORD_SECONDS),
    ]);
    if (recA.sampleRate !== recB.sampleRate) {
      throw new Error(`sampleRate mismatch: ${recA.sampleRate} vs ${recB.sampleRate}`);
    }
    return {
      metrics: compare(recA.samples, recB.samples, recA.sampleRate),
      sampleRate: recA.sampleRate,
      samplesA: recA.samples.length,
      samplesB: recB.samples.length,
    };
  } finally {
    await pair.close();
  }
}

async function runScenario(opts: {
  browser: import('@playwright/test').Browser;
  name: string;
  description: string;
  patch: PatchSpec;
  warmupMs?: number;
  acceptKind: 'static' | 'clocked' | 'stochastic';
  notes?: string;
}): Promise<ScenarioResult> {
  const { browser, name, description, patch, warmupMs = 500, acceptKind, notes } = opts;
  console.log(`\n=== Scenario: ${name} (${RUNS_PER_SCENARIO} runs) ===`);
  const runs: CompareMetrics[] = [];
  let sampleRate = 0;
  let samplesA = 0;
  let samplesB = 0;
  let lastError: string | undefined;
  for (let i = 0; i < RUNS_PER_SCENARIO; i++) {
    try {
      const r = await runScenarioOnce({ browser, patch, warmupMs });
      runs.push(r.metrics);
      sampleRate = r.sampleRate;
      samplesA = r.samplesA;
      samplesB = r.samplesB;
      console.log(
        `  run ${i + 1}: pearson=${r.metrics.pearson.toFixed(3)} ` +
          `spec=${r.metrics.spectralPearsonAvg.toFixed(3)} ` +
          `drift=${r.metrics.phaseDriftUsPerSec.toFixed(1)} μs/s`,
      );
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      console.log(`  run ${i + 1}: ERROR ${lastError}`);
    }
  }
  if (runs.length === 0) {
    return {
      name, description,
      durationSec: RECORD_SECONDS,
      sampleRate: 0, capturedSamplesA: 0, capturedSamplesB: 0,
      metrics: { pearson: 0, rmsDiff: 0, spectralPearsonAvg: 0, spectralPearsonWorst: 0, phaseDriftUsPerSec: 0, rmsA: 0, rmsB: 0 },
      runs: [],
      phaseDriftStdUsPerSec: 0,
      spectralAvgStd: 0,
      verdict: 'error',
      acceptableForShipWithoutPhaseC: 'no',
      error: lastError,
      notes,
    };
  }
  const metrics = meanMetrics(runs);
  const phaseDriftStd = stddev(runs.map((r) => r.phaseDriftUsPerSec));
  const specStd = stddev(runs.map((r) => r.spectralPearsonAvg));
  const v = verdict(metrics);
  const accept = classifyAcceptable(metrics, {
    tolerantPhaseDrift: acceptKind === 'clocked',
    allowStochastic: acceptKind === 'stochastic',
  });
  const result: ScenarioResult = {
    name, description,
    durationSec: RECORD_SECONDS,
    sampleRate,
    capturedSamplesA: samplesA,
    capturedSamplesB: samplesB,
    metrics,
    runs,
    phaseDriftStdUsPerSec: phaseDriftStd,
    spectralAvgStd: specStd,
    verdict: v,
    acceptableForShipWithoutPhaseC: accept,
    notes,
  };
  console.log(`  MEAN: pearson=${metrics.pearson.toFixed(3)} spec=${metrics.spectralPearsonAvg.toFixed(3)} drift=${metrics.phaseDriftUsPerSec.toFixed(1)}±${phaseDriftStd.toFixed(1)} μs/s`);
  console.log(`  verdict: ${v} | acceptable: ${accept}`);
  return result;
}

// Scenario 1: Static patch — VCO sine → audioOut --------------------------
test('@audio-drift 01-static-vco', async ({ browser }) => {
  const r = await runScenario({
    browser,
    name: '01-static-vco',
    description: 'AnalogVCO (sine, 220Hz / 0 semi tune) → audioOut. Both contexts should produce near-identical waveforms; only AudioContext epoch + ScriptProcessor block alignment cause divergence.',
    patch: {
      nodes: [
        { id: 'vco', type: 'analogVco', params: { tune: 0, fine: 0, fmAmount: 0, pw: 0.5 } },
        COMMON_AUDIO_OUT(),
      ],
      edges: [
        { id: 'e1', from: { nodeId: 'vco', portId: 'sine' }, to: { nodeId: 'out', portId: 'L' }, sourceType: 'audio', targetType: 'audio' },
        { id: 'e2', from: { nodeId: 'vco', portId: 'sine' }, to: { nodeId: 'out', portId: 'R' }, sourceType: 'audio', targetType: 'audio' },
      ],
    },
    acceptKind: 'static',
  });
  allResults.push(r);
});

// Scenario 2: Filtered ----------------------------------------------------
test('@audio-drift 02-filtered-vco', async ({ browser }) => {
  const r = await runScenario({
    browser,
    name: '02-filtered-vco',
    description: 'AnalogVCO (saw) → Filter (LP, cutoff 800 Hz, res 0.3) → audioOut. Static filter, deterministic.',
    patch: {
      nodes: [
        { id: 'vco', type: 'analogVco', params: { tune: 0, pw: 0.5 } },
        { id: 'flt', type: 'filter', params: { cutoff: 800, resonance: 0.3, mode: 0 } },
        COMMON_AUDIO_OUT(),
      ],
      edges: [
        { id: 'e1', from: { nodeId: 'vco', portId: 'saw' }, to: { nodeId: 'flt', portId: 'audio' } },
        { id: 'e2', from: { nodeId: 'flt', portId: 'audio' }, to: { nodeId: 'out', portId: 'L' } },
        { id: 'e3', from: { nodeId: 'flt', portId: 'audio' }, to: { nodeId: 'out', portId: 'R' } },
      ],
    },
    acceptKind: 'static',
  });
  allResults.push(r);
});

// Scenario 3: LFO-modulated ----------------------------------------------
test('@audio-drift 03-lfo-modulated', async ({ browser }) => {
  const r = await runScenario({
    browser,
    name: '03-lfo-modulated',
    description: 'LFO (rate 2 Hz) → AnalogVCO.fm input → audioOut. LFO has its own internal phase; tests whether two independent LFOs in two engines stay in lockstep.',
    patch: {
      nodes: [
        { id: 'lfo', type: 'lfo', params: { rate: 2, shape: 0 } },
        { id: 'vco', type: 'analogVco', params: { tune: 0, fmAmount: 0.5 } },
        COMMON_AUDIO_OUT(),
      ],
      edges: [
        { id: 'e1', from: { nodeId: 'lfo', portId: 'phase0' }, to: { nodeId: 'vco', portId: 'fm' }, sourceType: 'cv', targetType: 'audio' },
        { id: 'e2', from: { nodeId: 'vco', portId: 'sine' }, to: { nodeId: 'out', portId: 'L' } },
        { id: 'e3', from: { nodeId: 'vco', portId: 'sine' }, to: { nodeId: 'out', portId: 'R' } },
      ],
    },
    acceptKind: 'clocked',
    notes: 'LFO is a custom AudioWorklet — its internal phase counter starts when the worklet first processes a block. Two contexts have different ctx.currentTime origins, so absolute phase will differ; what we measure is whether the rate stays the same (no drift over time).',
  });
  allResults.push(r);
});

// Scenario 4: Sequenced --------------------------------------------------
test('@audio-drift 04-sequenced', async ({ browser }) => {
  const seqSteps = [
    { on: true, midi: 60 },
    { on: true, midi: 67 },
    { on: true, midi: 72 },
    { on: true, midi: 64 },
  ];
  // Pad to 32 with off steps.
  while (seqSteps.length < 32) seqSteps.push({ on: false, midi: 60 });
  const r = await runScenario({
    browser,
    name: '04-sequenced',
    description: 'Sequencer(120 BPM, 4 steps, fixed pattern) → VCO → ADSR → VCA → audioOut. Sequencer clock is the prime drift suspect.',
    patch: {
      nodes: [
        { id: 'seq', type: 'sequencer', params: { bpm: 120, length: 4, isPlaying: 1, gateLength: 0.5, swing: 0 }, data: { steps: seqSteps } },
        { id: 'vco', type: 'analogVco', params: { tune: 0 } },
        { id: 'adsr', type: 'adsr', params: { attack: 0.01, decay: 0.1, sustain: 0.4, release: 0.2 } },
        { id: 'vca', type: 'vca', params: { base: 0, cvAmount: 1 } },
        COMMON_AUDIO_OUT(),
      ],
      edges: [
        { id: 'e1', from: { nodeId: 'seq', portId: 'pitch' }, to: { nodeId: 'vco', portId: 'pitch' }, sourceType: 'pitch', targetType: 'pitch' },
        { id: 'e2', from: { nodeId: 'seq', portId: 'gate' }, to: { nodeId: 'adsr', portId: 'gate' }, sourceType: 'gate', targetType: 'gate' },
        { id: 'e3', from: { nodeId: 'vco', portId: 'sine' }, to: { nodeId: 'vca', portId: 'audio' } },
        { id: 'e4', from: { nodeId: 'adsr', portId: 'env' }, to: { nodeId: 'vca', portId: 'cv' }, sourceType: 'cv', targetType: 'cv' },
        { id: 'e5', from: { nodeId: 'vca', portId: 'audio' }, to: { nodeId: 'out', portId: 'L' } },
        { id: 'e6', from: { nodeId: 'vca', portId: 'audio' }, to: { nodeId: 'out', portId: 'R' } },
      ],
    },
    acceptKind: 'clocked',
    warmupMs: 1000,
    notes: 'Sequencer uses setTimeout-based JS scheduling at ~25ms tick. Each context has its own scheduler — drift is expected and is the central question of this research.',
  });
  allResults.push(r);
});

// Scenario 5: DRUMMERGIRL gate-triggered drum --------------------------
test('@audio-drift 05-drummergirl', async ({ browser }) => {
  const seqSteps = Array.from({ length: 32 }, (_, i) => ({ on: i % 4 === 0, midi: 60 }));
  const r = await runScenario({
    browser,
    name: '05-drummergirl',
    description: 'Sequencer (120 BPM, every 4th step) → DRUMMERGIRL gate → audioOut. Tests Faust drum voice + clocked gate drift.',
    patch: {
      nodes: [
        { id: 'seq', type: 'sequencer', params: { bpm: 120, length: 16, isPlaying: 1, gateLength: 0.2 }, data: { steps: seqSteps } },
        { id: 'dg', type: 'drummergirl', params: { pitch: 0, tone: 0.3, shape: 0.3, volume: 1, decay: 0.15 } },
        COMMON_AUDIO_OUT(),
      ],
      edges: [
        { id: 'e1', from: { nodeId: 'seq', portId: 'gate' }, to: { nodeId: 'dg', portId: 'gate' }, sourceType: 'gate', targetType: 'gate' },
        { id: 'e2', from: { nodeId: 'dg', portId: 'audio' }, to: { nodeId: 'out', portId: 'L' } },
        { id: 'e3', from: { nodeId: 'dg', portId: 'audio' }, to: { nodeId: 'out', portId: 'R' } },
      ],
    },
    acceptKind: 'clocked',
    warmupMs: 1000,
  });
  allResults.push(r);
});

// Scenario 6: PlaitsFM/DX7 — N/A; checking module registry instead -----
test('@audio-drift 06-fm-skipped', async ({ browser }) => {
  // PlaitsFM / DX7 not yet in module-registry. Skip cleanly; record as 'skipped'.
  const _ = browser; void _;
  const result: ScenarioResult = {
    name: '06-fm-skipped',
    description: 'DX7/PlaitsFM module not yet registered in module-registry.ts; scenario skipped.',
    durationSec: 0,
    sampleRate: 0,
    capturedSamplesA: 0,
    capturedSamplesB: 0,
    metrics: {
      pearson: 0, rmsDiff: 0, spectralPearsonAvg: 0, spectralPearsonWorst: 0,
      phaseDriftUsPerSec: 0, rmsA: 0, rmsB: 0,
    },
    runs: [],
    phaseDriftStdUsPerSec: 0,
    spectralAvgStd: 0,
    verdict: 'skipped',
    acceptableForShipWithoutPhaseC: 'with-caveats',
    notes: 'Re-run this scenario once an FM module lands in the registry.',
  };
  allResults.push(result);
  console.log('06-fm-skipped: no FM module in registry');
});

// Scenario 7: Stochastic / granular - CHARLOTTE'S ECHOS ----------------
test('@audio-drift 07-stochastic-echos', async ({ browser }) => {
  // CHARLOTTE'S ECHOS is in the registry. Drive with a sustained VCO so the
  // module has continuous input to process; its internal stochastic behavior
  // (if any) shows up as A vs B divergence.
  const r = await runScenario({
    browser,
    name: '07-stochastic-echos',
    description: 'AnalogVCO → CHARLOTTE\'S ECHOS → audioOut. Stochastic effects expected to diverge but each side internally coherent.',
    patch: {
      nodes: [
        { id: 'vco', type: 'analogVco', params: { tune: 0 } },
        { id: 'echos', type: 'charlottesEchos', params: { delay: 0.3, feedback: 0.6, decay: 0.3, pitchUp: 0.05, mix: 0.7 } },
        COMMON_AUDIO_OUT(),
      ],
      edges: [
        { id: 'e1', from: { nodeId: 'vco', portId: 'saw' }, to: { nodeId: 'echos', portId: 'L' } },
        { id: 'e2', from: { nodeId: 'vco', portId: 'saw' }, to: { nodeId: 'echos', portId: 'R' } },
        { id: 'e3', from: { nodeId: 'echos', portId: 'L' }, to: { nodeId: 'out', portId: 'L' } },
        { id: 'e4', from: { nodeId: 'echos', portId: 'R' }, to: { nodeId: 'out', portId: 'R' } },
      ],
    },
    acceptKind: 'stochastic',
    notes: 'CHARLOTTE\'S ECHOS may not exist with that exact id or port shape — if scenario errors, the module registry naming convention is the issue, not a true result.',
  });
  allResults.push(r);
});

// Scenario 8: Multi-user param edit ---------------------------------------
test('@audio-drift 08-multi-user-edit', async ({ browser }) => {
  console.log(`\n=== Scenario: 08-multi-user-edit (${RUNS_PER_SCENARIO} runs) ===`);
  const patch: PatchSpec = {
    nodes: [
      { id: 'vco', type: 'analogVco', params: { tune: 0, fine: 0 } },
      COMMON_AUDIO_OUT(),
    ],
    edges: [
      { id: 'e1', from: { nodeId: 'vco', portId: 'sine' }, to: { nodeId: 'out', portId: 'L' } },
      { id: 'e2', from: { nodeId: 'vco', portId: 'sine' }, to: { nodeId: 'out', portId: 'R' } },
    ],
  };
  const runs: CompareMetrics[] = [];
  let sampleRate = 0, samplesA = 0, samplesB = 0;
  let lastError: string | undefined;
  for (let i = 0; i < RUNS_PER_SCENARIO; i++) {
    const pair = await openTwoContexts(browser);
    try {
      await authorPatchAndAwaitSync(pair, patch);
      await pair.pageA.waitForTimeout(500);
      const recPromises = Promise.all([
        recordAudio(pair.pageA, 'out', RECORD_SECONDS),
        recordAudio(pair.pageB, 'out', RECORD_SECONDS),
      ]);
      // Mid-recording: A turns the tune knob via Yjs.
      setTimeout(() => {
        pair.pageA.evaluate(() => {
          const w = globalThis as unknown as {
            __patch: { nodes: Record<string, { params?: Record<string, number> }> };
            __ydoc: { transact: (fn: () => void) => void };
          };
          w.__ydoc.transact(() => {
            const n = w.__patch.nodes['vco'];
            n.params = { ...n.params, tune: 12 };
          });
        }).catch(() => { /* race ok if recording already finished */ });
      }, 2500);
      const [recA, recB] = await recPromises;
      if (recA.sampleRate !== recB.sampleRate) {
        throw new Error(`sampleRate mismatch ${recA.sampleRate} vs ${recB.sampleRate}`);
      }
      const m = compare(recA.samples, recB.samples, recA.sampleRate);
      runs.push(m);
      sampleRate = recA.sampleRate;
      samplesA = recA.samples.length;
      samplesB = recB.samples.length;
      console.log(
        `  run ${i + 1}: pearson=${m.pearson.toFixed(3)} ` +
          `spec=${m.spectralPearsonAvg.toFixed(3)} drift=${m.phaseDriftUsPerSec.toFixed(1)} μs/s`,
      );
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      console.log(`  run ${i + 1}: ERROR ${lastError}`);
    } finally {
      await pair.close();
    }
  }
  let result: ScenarioResult;
  if (runs.length === 0) {
    result = {
      name: '08-multi-user-edit',
      description: 'Static VCO. Mid-recording (~2.5s in), A turns the tune knob +12 semitones via Yjs. Tests sync latency + transient divergence.',
      durationSec: RECORD_SECONDS,
      sampleRate: 0, capturedSamplesA: 0, capturedSamplesB: 0,
      metrics: { pearson: 0, rmsDiff: 0, spectralPearsonAvg: 0, spectralPearsonWorst: 0, phaseDriftUsPerSec: 0, rmsA: 0, rmsB: 0 },
      runs: [],
      phaseDriftStdUsPerSec: 0,
      spectralAvgStd: 0,
      verdict: 'error',
      acceptableForShipWithoutPhaseC: 'no',
      error: lastError,
    };
  } else {
    const metrics = meanMetrics(runs);
    const phaseDriftStd = stddev(runs.map((r) => r.phaseDriftUsPerSec));
    const specStd = stddev(runs.map((r) => r.spectralPearsonAvg));
    const v = verdict(metrics);
    const accept = classifyAcceptable(metrics, { tolerantPhaseDrift: true });
    result = {
      name: '08-multi-user-edit',
      description: 'Static VCO. Mid-recording (~2.5s in), A turns the tune knob +12 semitones via Yjs. Tests sync latency + transient divergence.',
      durationSec: RECORD_SECONDS,
      sampleRate,
      capturedSamplesA: samplesA,
      capturedSamplesB: samplesB,
      metrics,
      runs,
      phaseDriftStdUsPerSec: phaseDriftStd,
      spectralAvgStd: specStd,
      verdict: v,
      acceptableForShipWithoutPhaseC: accept,
      notes: 'Spectral correlation drops during the brief propagation window when only A has the new tune value; recovers once Yjs syncs to B.',
    };
    console.log(`  MEAN: pearson=${metrics.pearson.toFixed(3)} spec=${metrics.spectralPearsonAvg.toFixed(3)} verdict=${v}`);
  }
  allResults.push(result);
});

// After-all: write outputs ------------------------------------------------
test.afterAll(async () => {
  if (allResults.length === 0) return;
  await mkdir(RESULTS_DIR, { recursive: true });
  const dateTag = new Date().toISOString().slice(0, 10);

  const run: RunResults = {
    startedAt: runStartedAt,
    finishedAt: new Date().toISOString(),
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
    scenarios: allResults,
  };
  await writeFile(
    join(RESULTS_DIR, `results-${dateTag}.json`),
    JSON.stringify(run, null, 2),
  );

  // Markdown report.
  const lines: string[] = [];
  lines.push(`# Audio drift research results — ${dateTag}`);
  lines.push('');
  lines.push(`Run started ${run.startedAt}, finished ${run.finishedAt}.`);
  lines.push(`Target: \`${run.baseURL}\`. Recording duration: ${RECORD_SECONDS} s per scenario, ${RUNS_PER_SCENARIO} runs each.`);
  lines.push('');
  lines.push('Metrics are means across runs; the ± figure is one standard deviation. The variance is itself a finding — same patch, same machine, same code: per-run drift can differ by 10× because two AudioContexts on the same OS happen to align (or not) at start. Real users on different machines never align, so these numbers are a *lower bound* on real-world drift.');
  lines.push('');
  lines.push('## Per-scenario verdicts');
  lines.push('');
  lines.push('| Scenario | Pearson | Spec.Avg ± σ | PhaseDrift μs/s ± σ | Verdict | Acceptable? |');
  lines.push('|---|---:|---:|---:|---|---|');
  for (const r of allResults) {
    const m = r.metrics;
    lines.push(
      `| ${r.name} | ${m.pearson.toFixed(3)} | ` +
        `${m.spectralPearsonAvg.toFixed(3)} ± ${r.spectralAvgStd.toFixed(3)} | ` +
        `${m.phaseDriftUsPerSec.toFixed(1)} ± ${r.phaseDriftStdUsPerSec.toFixed(1)} | ` +
        `${r.verdict} | ${r.acceptableForShipWithoutPhaseC} |`,
    );
  }
  lines.push('');
  lines.push('## Per-scenario detail');
  lines.push('');
  for (const r of allResults) {
    lines.push(`### ${r.name}`);
    lines.push(r.description);
    lines.push('');
    if (r.error) {
      lines.push(`**ERROR:** ${r.error}`);
    } else if (r.verdict === 'skipped') {
      lines.push('Skipped.');
    } else {
      lines.push(`- runs: ${r.runs.length}`);
      lines.push(`- rmsA mean = ${r.metrics.rmsA.toFixed(5)}, rmsB mean = ${r.metrics.rmsB.toFixed(5)}`);
      lines.push(`- pearson (time-domain) mean: ${r.metrics.pearson.toFixed(4)}`);
      lines.push(`- RMS difference (vs A) mean: ${(r.metrics.rmsDiff * 100).toFixed(1)} %`);
      lines.push(`- spectral correlation: mean avg ${r.metrics.spectralPearsonAvg.toFixed(4)} ± ${r.spectralAvgStd.toFixed(4)}, mean worst ${r.metrics.spectralPearsonWorst.toFixed(4)}`);
      lines.push(`- phase drift: ${r.metrics.phaseDriftUsPerSec.toFixed(2)} ± ${r.phaseDriftStdUsPerSec.toFixed(2)} μs/sec`);
      lines.push(`- captured ${r.capturedSamplesA} / ${r.capturedSamplesB} samples @ ${r.sampleRate} Hz`);
      lines.push(`- verdict: **${r.verdict}**`);
      lines.push(`- acceptable for ship-without-Phase-C: **${r.acceptableForShipWithoutPhaseC}**`);
      if (r.runs.length > 1) {
        lines.push('');
        lines.push('Per-run breakdown:');
        for (let i = 0; i < r.runs.length; i++) {
          const m = r.runs[i];
          lines.push(`  - run ${i + 1}: pearson ${m.pearson.toFixed(3)}, spec ${m.spectralPearsonAvg.toFixed(3)}, drift ${m.phaseDriftUsPerSec.toFixed(1)} μs/s`);
        }
      }
    }
    if (r.notes) {
      lines.push('');
      lines.push(`Notes: ${r.notes}`);
    }
    lines.push('');
  }

  // Overall recommendation.
  const counts = { yes: 0, 'with-caveats': 0, no: 0 } as Record<string, number>;
  for (const r of allResults) {
    if (r.verdict === 'skipped' || r.verdict === 'error') continue;
    counts[r.acceptableForShipWithoutPhaseC] = (counts[r.acceptableForShipWithoutPhaseC] ?? 0) + 1;
  }
  const realScenarios = allResults.filter((r) => r.verdict !== 'skipped' && r.verdict !== 'error');
  lines.push('## Aggregate');
  lines.push('');
  lines.push(`Real (non-skipped, non-errored) scenarios: ${realScenarios.length}`);
  lines.push(`- yes: ${counts.yes ?? 0}`);
  lines.push(`- with-caveats: ${counts['with-caveats'] ?? 0}`);
  lines.push(`- no: ${counts.no ?? 0}`);
  lines.push('');
  if ((counts.no ?? 0) === 0 && (counts['with-caveats'] ?? 0) === 0) {
    lines.push('**Recommendation:** skip Phase C. All scenarios passed the per-user-renders-locally bar.');
  } else if ((counts.no ?? 0) === 0) {
    lines.push('**Recommendation:** hybrid. Most scenarios pass; the with-caveats ones may want targeted fixes (likely sequencer clock sync or LFO phase reset on patch).');
  } else {
    lines.push('**Recommendation:** Phase C may be warranted for the `no` scenarios. See per-scenario detail.');
  }

  await writeFile(join(RESULTS_DIR, `report-${dateTag}.md`), lines.join('\n') + '\n');
  console.log(`\nWrote ${RESULTS_DIR}/results-${dateTag}.json + report-${dateTag}.md`);
});
