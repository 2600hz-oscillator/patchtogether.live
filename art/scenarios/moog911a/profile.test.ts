// art/scenarios/moog911a/profile.test.ts
//
// AUDIO PROFILE for MOOG 911A (dual trigger delay) (backfill batch 3 —
// spec §4.1/§4.3, .myrobots/plans/art-backfill-audio-profiles-2026-07-01.md),
// through the shared capture harness (capture.ts + drivers.ts + worklet.ts).
//
// Category: MODULATION / trigger utility — driven by the canonical TRIGGER
// TRAIN (spec §4.2: triggerTrain, TRIGGER_PULSE_S-wide pulses) at 120 BPM
// (two rising edges in the 1.0 s window, at t=0 and t=0.5).
//
// Patch: SERIES coupling (mode 2) with delay1 0.15 s / delay2 0.25 s —
// the 911A's SIGNATURE is the coupling mode, and SERIES exercises the whole
// module in one patch: trig1 → delay1 → out1, then out1's own ~1 ms pulse
// re-triggers delay2 → out2 (a two-stage chain). Each input edge therefore
// produces an out1 pulse 0.15 s later and an out2 pulse ~0.40 s later —
// two genuinely different gate streams (both captured; signature rule).
//
// Expected timing is SAMPLE-EXACT (the core is a pure counter machine):
// an edge at sample e fires out1 at e + round(0.15·SR); out2's chain sees
// out1's pulse one sample later (causal SERIES feedback), so out2 fires at
// e + round(0.15·SR) + 1 + round(0.25·SR). Pulse width is the core's
// TRIGGER_DELAY_PULSE_S (~1 ms = 48 samples).
//
// Rendering path: the REAL worklet processor class via the shared shim
// loader — moog911a.ts is a thin self-contained wrapper around the
// DualTriggerDelay core (lib/trigger-delay-dsp.ts), pure math, no RNG.
//
// The .sha pins BOTH the worklet entry and the timing core.

import { describe, expect, it } from 'vitest';
import {
  TRIGGER_DELAY_PULSE_S,
  TriggerDelayMode,
} from '../../../packages/dsp/src/lib/trigger-delay-dsp';
import { dspSourceSha, pinAll, SAMPLE_RATE } from '../../setup/capture';
import { triggerTrain } from '../../setup/drivers';
import { captureWorkletProcessor, renderWorklet } from '../../setup/worklet';

const SR = SAMPLE_RATE;
const DURATION_S = 1.0;
const TRIG_BPM = 120; // rising edges at t = 0 s and t = 0.5 s
const DELAY1_S = 0.15;
const DELAY2_S = 0.25;

async function renderProfile(): Promise<Record<string, Float32Array>> {
  const Proc = await captureWorkletProcessor(
    'moog911a',
    () => import('../../../packages/dsp/src/moog911a'),
    SR,
  );
  const proc = new Proc();
  const n = Math.round(SR * DURATION_S);
  return renderWorklet(proc, {
    totalSamples: n,
    // inputs[0] = trig1; inputs[1] = trig2 (ignored in SERIES — unpatched).
    inputs: [triggerTrain({ totalS: DURATION_S, bpm: TRIG_BPM }), null],
    params: { delay1: DELAY1_S, delay2: DELAY2_S, mode: TriggerDelayMode.Series },
    outputs: ['out1', 'out2'],
  });
}

/** Sample indices of rising edges (0 → high) in a gate buffer. */
function risingEdges(buf: Float32Array): number[] {
  const edges: number[] = [];
  for (let i = 0; i < buf.length; i++) {
    const prev = i > 0 ? buf[i - 1]! : 0;
    if (prev < 0.5 && buf[i]! >= 0.5) edges.push(i);
  }
  return edges;
}

describe('ART moog911a / audio profile (SERIES chain: 120 BPM triggers → 0.15 s → 0.25 s)', () => {
  it('fires sample-exact delayed pulses, out2 chained off out1', async () => {
    const bufs = await renderProfile();
    const out1 = bufs.out1!;
    const out2 = bufs.out2!;
    expect(out1.length).toBe(Math.round(SR * DURATION_S));
    expect(out1.every(Number.isFinite)).toBe(true);
    expect(out2.every(Number.isFinite)).toBe(true);

    const d1 = Math.round(DELAY1_S * SR);
    const d2 = Math.round(DELAY2_S * SR);
    const beat = Math.round((60 / TRIG_BPM) * SR);
    // out1: one pulse per input edge, exactly delay1 later.
    expect(risingEdges(out1)).toEqual([d1, beat + d1]);
    // out2: chained one sample after out1's pulse, then delay2.
    expect(risingEdges(out2)).toEqual([d1 + 1 + d2, beat + d1 + 1 + d2]);

    // Pulses are the core's ~1 ms width and clean 0/1 gates.
    const pulseN = Math.max(1, Math.round(TRIGGER_DELAY_PULSE_S * SR));
    const gateStats = (buf: Float32Array) => {
      let high = 0;
      let nonBinary = 0;
      for (const v of buf) {
        if (v === 1) high++;
        else if (v !== 0) nonBinary++;
      }
      return { high, nonBinary };
    };
    const s1 = gateStats(out1);
    const s2 = gateStats(out2);
    expect(s1.nonBinary).toBe(0);
    expect(s2.nonBinary).toBe(0);
    expect(s1.high).toBe(2 * pulseN);
    expect(s2.high).toBe(2 * pulseN);

    // Deterministic re-render is bit-identical (fresh processor instance).
    const again = await renderProfile();
    for (const k of ['out1', 'out2'] as const) {
      let diff = 0;
      for (let i = 0; i < out1.length; i++) diff = Math.max(diff, Math.abs(bufs[k]![i]! - again[k]![i]!));
      expect(diff).toBe(0);
    }
  });

  it('pins the out1/out2 profile baselines (SHA-gated, RMS tier B)', async () => {
    const srcSha = await dspSourceSha('moog911a.ts', 'lib/trigger-delay-dsp.ts');
    await pinAll('moog911a', srcSha, await renderProfile());
  });
});
