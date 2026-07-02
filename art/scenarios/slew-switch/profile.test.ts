// art/scenarios/slew-switch/profile.test.ts
//
// AUDIO PROFILE for SLEWSWITCH (quad slew limiter + 4→1 sequential switch)
// (backfill batch 4 — spec §4.1/§4.3,
// .myrobots/plans/art-backfill-audio-profiles-2026-07-01.md), through the
// shared capture harness (capture.ts + drivers.ts + worklet.ts).
//
// Category: CV UTILITY with BOTH a per-channel law (the one-pole slew) and
// a clocked selector. Four spectrally/temporally distinct CV drivers, each
// with its own slew constant, so all four channel laws are visible:
//   cv1 = 2 Hz square (gateTrain 120 BPM, 50% duty), slew 0.02 s — snappy
//         rounded square (the "fast portamento" end)
//   cv2 = 1 Hz square (gateTrain 60 BPM, 50% duty),  slew 0.2 s  — deep
//         exponential rise/fall (the classic slew-limiter picture)
//   cv3 = 4 Hz sine, slew 0.05 s — a lagged/attenuated sine (one-pole LP)
//   cv4 = seeded noise (PROFILE_NOISE_SEED), slew 0.3 s — a smooth
//         deterministic random walk
// step_clock = canonical 240 BPM clockTrain (epoch 0) → six advances in
// 1.5 s; forward mode walks 1→2→3→0(wrap: EOC)→1→2 with the worklet's
// 50 ms equal-power crossfade at each hop.
//
// DETERMINISM: forward mode NEVER draws from the worklet's step PRNG (rand()
// is reached only in random mode), and the PRNG seed is injected anyway via
// processorOptions.seed = PROFILE_NOISE_SEED so construction itself never
// touches Math.random (see DETERMINISM.md "Random seed (ART audio
// profiles)" — the seam exists for a future random-mode profile).
//
// Rendering path: the REAL worklet processor class via the shared shim
// loader — slewswitch.ts is self-contained pure math with the seeded PRNG
// above.
//
// SIGNATURE outputs (owner decision §6b.2): `out2` (the slew law drawn
// large) and `switched` (the equal-power selector walk — the module's
// headline). out1/out3/out4 demonstrate the SAME one-pole law on other
// inputs (asserted structurally below, not pinned); step_idx is a derived
// 4-level staircase and eoc a fixed 5 ms wrap pulse (both asserted
// sample-exact, not pinned).
//
// The .sha pins the (self-contained) worklet entry.

import { describe, expect, it } from 'vitest';
import { dspSourceSha, pinAll, SAMPLE_RATE } from '../../setup/capture';
import {
  clockTrain,
  gateTrain,
  PROFILE_NOISE_SEED,
  seededNoise,
  vcoTestSignal,
} from '../../setup/drivers';
import { captureWorkletProcessor, renderWorklet } from '../../setup/worklet';

const SR = SAMPLE_RATE;
const DURATION_S = 1.5;
const SEGMENT_S = 0.25; // 240 BPM step clock period
const XFADE_S = 0.05;

const cv1 = gateTrain({ totalS: DURATION_S, bpm: 120, gateS: 0.25 });
const cv2 = gateTrain({ totalS: DURATION_S, bpm: 60, gateS: 0.5 });
const cv3 = vcoTestSignal({ totalS: DURATION_S, shape: 'sine', freqHz: 4, amp: 1 });
const cv4 = seededNoise(DURATION_S);

const SLEW = [0.02, 0.2, 0.05, 0.3] as const;

async function renderProfile(): Promise<Record<string, Float32Array>> {
  const Proc = await captureWorkletProcessor(
    'slewswitch',
    () => import('../../../packages/dsp/src/slewswitch'),
    SR,
  );
  const proc = new Proc({ processorOptions: { seed: PROFILE_NOISE_SEED } });
  const n = Math.round(SR * DURATION_S);
  return renderWorklet(proc, {
    totalSamples: n,
    // inputs[0..3] = cv1..cv4, inputs[4] = step_clock, inputs[5] = reset.
    inputs: [cv1, cv2, cv3, cv4, clockTrain(DURATION_S), null],
    params: {
      slew1: SLEW[0],
      slew2: SLEW[1],
      slew3: SLEW[2],
      slew4: SLEW[3],
      mode: 0, // forward (shipping default — no PRNG draw)
      length: 4,
      xfadeTime: XFADE_S,
    },
    outputs: ['out1', 'out2', 'out3', 'out4', 'switched', 'step_idx', 'eoc'],
  });
}

function rms(b: Float32Array, s: number, e: number): number {
  let x = 0;
  for (let i = s; i < e; i++) x += b[i]! * b[i]!;
  return Math.sqrt(x / Math.max(1, e - s));
}

describe('ART slew-switch / audio profile (four slewed CVs, 240 BPM selector walk with EOC wrap)', () => {
  it('slews each channel by its own tau and walks the selector 1→2→3→0→1→2', async () => {
    const bufs = await renderProfile();
    const n = Math.round(SR * DURATION_S);
    for (const name of ['out1', 'out2', 'out3', 'out4', 'switched', 'step_idx', 'eoc'] as const) {
      expect(bufs[name]!.length).toBe(n);
      expect(bufs[name]!.every(Number.isFinite)).toBe(true);
    }

    // out2 — the deep slew: rises toward 1 while the 1 Hz gate is high
    // ([0, 0.5)); 1 − e^(−0.5/0.2) ≈ 0.918 at the top; falls after.
    const out2 = bufs.out2!;
    const top = out2[Math.round(0.5 * SR) - 1]!;
    expect(top).toBeGreaterThan(0.88);
    expect(top).toBeLessThan(0.94);
    for (let i = 1; i < Math.round(0.5 * SR); i++) {
      if (out2[i]! < out2[i - 1]!) throw new Error(`out2 not rising at ${i}`);
    }
    for (let i = Math.round(0.5 * SR) + 1; i < Math.round(1.0 * SR); i++) {
      if (out2[i]! > out2[i - 1]!) throw new Error(`out2 not falling at ${i}`);
    }

    // out1 — the fast slew: within 100 ms of the first gate it is nearly 1
    // (tau 0.02 → 5 taus), and within 100 ms of the fall nearly 0.
    const out1 = bufs.out1!;
    expect(out1[Math.round(0.1 * SR)]!).toBeGreaterThan(0.95);
    expect(out1[Math.round(0.35 * SR)]!).toBeLessThan(0.05); // gate fell at 0.25
    // out3 — one-pole on a 4 Hz sine: gain 1/√(1+(2π·4·0.05)²) ≈ 0.62.
    const g3 = rms(bufs.out3!, Math.round(0.25 * SR), n) / rms(cv3, Math.round(0.25 * SR), n);
    expect(g3).toBeGreaterThan(0.5);
    expect(g3).toBeLessThan(0.75);
    // out4 — heavily smoothed noise: bounded and step-continuous (per-sample
    // delta ≤ alpha·range vs the raw noise's jumps of up to 2).
    const out4 = bufs.out4!;
    let maxDelta = 0;
    for (let i = 1; i < n; i++) maxDelta = Math.max(maxDelta, Math.abs(out4[i]! - out4[i - 1]!));
    expect(maxDelta).toBeLessThan(5e-4);
    for (const v of out4) expect(Math.abs(v)).toBeLessThanOrEqual(1);

    // switched — after each hop's 50 ms crossfade settles, it tracks the
    // selected channel (walk: seg k → channel WALK[k]). The settled tail of
    // each segment must match that channel's slewed output to within the
    // equal-power fade's float residue.
    const WALK = [1, 2, 3, 0, 1, 2]; // selected index during segment k
    const sw = bufs.switched!;
    const outs = [bufs.out1!, bufs.out2!, bufs.out3!, bufs.out4!];
    for (let k = 0; k < WALK.length; k++) {
      const from = Math.round((k * SEGMENT_S + XFADE_S + 0.02) * SR);
      const to = Math.round((k + 1) * SEGMENT_S * SR);
      const target = outs[WALK[k]!]!;
      for (let i = from; i < to; i++) {
        if (Math.abs(sw[i]! - target[i]!) > 1e-6) {
          throw new Error(`switched ≠ out${WALK[k]! + 1} at sample ${i} (segment ${k})`);
        }
      }
    }

    // step_idx — the derived 4-level staircase ((idx/3)·2 − 1), held per
    // segment (sampled mid-segment, past the hop).
    const stepIdx = bufs.step_idx!;
    for (let k = 0; k < WALK.length; k++) {
      const expected = Math.fround((WALK[k]! / 3) * 2 - 1);
      const probe = Math.round((k * SEGMENT_S + 0.125) * SR);
      expect(stepIdx[probe]!, `step_idx segment ${k}`).toBe(expected);
    }

    // eoc — exactly one 5 ms pulse, starting at the wrap edge (t = 0.75 s).
    const eoc = bufs.eoc!;
    const eocStart = Math.round(0.75 * SR);
    const eocLen = Math.round(0.005 * SR);
    let high = 0;
    for (const v of eoc) high += v;
    expect(high).toBe(eocLen);
    expect(eoc[eocStart]).toBe(1);
    expect(eoc[eocStart + eocLen - 1]).toBe(1);
    expect(eoc[eocStart + eocLen]).toBe(0);

    // Deterministic re-render is bit-identical (fresh processor, same seed).
    const again = await renderProfile();
    for (const name of ['out2', 'switched'] as const) {
      let diff = 0;
      for (let i = 0; i < n; i++) diff = Math.max(diff, Math.abs(bufs[name]![i]! - again[name]![i]!));
      expect(diff, name).toBe(0);
    }
  });

  it('pins the out2 + switched profile baselines (SHA-gated, RMS tier B)', async () => {
    const srcSha = await dspSourceSha('slewswitch.ts');
    const bufs = await renderProfile();
    await pinAll('slew-switch', srcSha, { out2: bufs.out2!, switched: bufs.switched! });
  });
});
