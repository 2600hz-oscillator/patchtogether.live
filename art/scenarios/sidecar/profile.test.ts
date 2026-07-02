// art/scenarios/sidecar/profile.test.ts
//
// AUDIO PROFILE for SIDECAR (stereo sidechain ducker) (backfill batch 3 —
// spec §4.1/§4.3, .myrobots/plans/art-backfill-audio-profiles-2026-07-01.md),
// through the shared capture harness (capture.ts + drivers.ts + worklet.ts).
//
// Category: FX / PROCESSOR — but the ducker needs TWO drivers to show its
// signature (the classic sidechain-pump patch, straight from the worklet's
// own topology doc):
//   MAIN/trigger  = a deterministic "kick": 60 Hz sine × per-beat
//                   exponential decay (exp(-12·t_beat)) at 120 BPM — four
//                   kicks across the 2 s render, pure math, no RNG.
//   SIDECHAIN     = the canonical C4 saw pad (vcoTestSignal, spec §4.2),
//                   steady, so the pump carved into it is unmistakable.
//
// Patch: the SHIPPING DEFAULTS (threshold −18 dB, ratio 4, attack 10 ms,
// release 100 ms, knee 6 dB, makeup 0, sc_hpf 20 Hz, inputLevel 1,
// envMag 1). Each kick passes through while pulling the pad down (~17 dB
// of reduction at the hit), and the pad swells back over the release —
// waveform AND spectrogram both read as the classic pump.
//
// Rendering path: the REAL worklet processor class via the shared shim
// loader — sidecar.ts is a thin self-contained wrapper around the
// GMR-2012 pipeline in lib/compressor-dsp.ts, pure math, no RNG.
//
// SIGNATURE outputs (owner decision §6b.2): `audio_l_out` + `env_out`.
//   - audio_r_out ≡ audio_l_out with mono drivers (the worklet's R→L input
//     fallback; asserted bit-exact below) — bus-duplicate rule.
//   - env_inv_out is EXACTLY 1 − env_out (asserted below) — an affine
//     duplicate with no independent information.
//
// The .sha pins BOTH the worklet entry and the compressor core.

import { describe, expect, it } from 'vitest';
import { dspSourceSha, pinAll, SAMPLE_RATE } from '../../setup/capture';
import { C4_HZ, vcoTestSignal } from '../../setup/drivers';
import { captureWorkletProcessor, renderWorklet } from '../../setup/worklet';

const SR = SAMPLE_RATE;
const DURATION_S = 2.0;
const BEAT_S = 0.5; // 120 BPM
const KICK_HZ = 60;
const KICK_AMP = 0.9;
const KICK_DECAY_PER_S = 12;

/** The deterministic kick driver: 60 Hz sine, per-beat exponential decay. */
function kickTrain(): Float32Array {
  const n = Math.round(SR * DURATION_S);
  const buf = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const tBeat = t % BEAT_S;
    buf[i] = KICK_AMP * Math.exp(-KICK_DECAY_PER_S * tBeat) * Math.sin(2 * Math.PI * KICK_HZ * t);
  }
  return buf;
}

async function renderProfile(): Promise<Record<string, Float32Array>> {
  const Proc = await captureWorkletProcessor(
    'sidecar',
    () => import('../../../packages/dsp/src/sidecar'),
    SR,
  );
  const proc = new Proc();
  const n = Math.round(SR * DURATION_S);
  return renderWorklet(proc, {
    totalSamples: n,
    // inputs[0]=audio_l_in (MAIN/trigger), inputs[1]=audio_r_in (unpatched →
    // falls back to L), inputs[2]=sc_l_in (the ducked pad), inputs[3]=sc_r_in
    // (unpatched → falls back to sc_l).
    inputs: [kickTrain(), null, vcoTestSignal({ totalS: DURATION_S }), null],
    // Shipping defaults, spelled explicitly so the patch is pinned by this file.
    params: {
      threshold: -18,
      ratio: 4,
      attack: 10,
      release: 100,
      knee: 6,
      makeup: 0,
      sc_hpf: 20,
      inputLevel: 1,
      envMag: 1,
    },
    outputs: ['audio_l_out', 'audio_r_out', 'env_out', 'env_inv_out'],
  });
}

/** Goertzel magnitude (normalized 2/N) of freqHz over buf[s, e). */
function goertzel(buf: Float32Array, s: number, e: number, freqHz: number): number {
  const N = e - s;
  const w = (2 * Math.PI * freqHz) / SR;
  const coeff = 2 * Math.cos(w);
  let q1 = 0;
  let q2 = 0;
  for (let i = s; i < e; i++) {
    const q0 = coeff * q1 - q2 + buf[i]!;
    q2 = q1;
    q1 = q0;
  }
  const re = q1 - q2 * Math.cos(w);
  const im = q2 * Math.sin(w);
  return (2 / N) * Math.sqrt(re * re + im * im);
}

const at = (s: number) => Math.round(s * SR);

describe('ART sidecar / audio profile (120 BPM kick ducking a C4 saw pad, default patch)', () => {
  it('pumps: the pad is ducked at each kick and swells back over the release', async () => {
    const bufs = await renderProfile();
    const out = bufs.audio_l_out!;
    const env = bufs.env_out!;
    expect(out.length).toBe(Math.round(SR * DURATION_S));
    expect(out.every(Number.isFinite)).toBe(true);
    expect(env.every(Number.isFinite)).toBe(true);

    // The DUCK, on the audio path: the pad's C4 fundamental in the output is
    // far weaker while the kick is hot (early beat) than once the gain has
    // released (late beat). Probing the saw fundamental keeps the kick's own
    // 60 Hz energy out of the measurement. Same windows of beats 2 and 3
    // (steady state — past the first beat's attack transient from silence).
    const duckedA = goertzel(out, at(0.52), at(0.62), C4_HZ);
    const openA = goertzel(out, at(0.90), at(0.99), C4_HZ);
    const duckedB = goertzel(out, at(1.02), at(1.12), C4_HZ);
    const openB = goertzel(out, at(1.40), at(1.49), C4_HZ);
    expect(duckedA).toBeLessThan(openA * 0.5);
    expect(duckedB).toBeLessThan(openB * 0.5);
    // The recovered pad is actually THERE (saw fundamental of a 0.5-amp saw
    // ≈ 0.32) and the kick passes through (60 Hz strong early in the beat).
    expect(openA).toBeGreaterThan(0.15);
    expect(goertzel(out, at(1.0), at(1.1), KICK_HZ)).toBeGreaterThan(0.1);

    // The envelope out: reduction spikes with each kick, then releases.
    const envPeakBeat = (k: number) => {
      let p = 0;
      for (let i = at(k * BEAT_S); i < at(k * BEAT_S + 0.15); i++) p = Math.max(p, env[i]!);
      return p;
    };
    for (let k = 0; k < 4; k++) expect(envPeakBeat(k)).toBeGreaterThan(0.3);
    // …and by the end of each beat the reduction has mostly released.
    expect(env[at(0.99)]!).toBeLessThan(0.15);
    expect(env[at(1.49)]!).toBeLessThan(0.15);
    let envMin = Infinity;
    for (const v of env) envMin = Math.min(envMin, v);
    expect(envMin).toBeGreaterThanOrEqual(0);

    // Bus/affine duplicates → not pinned (signature rule), proven here:
    const outR = bufs.audio_r_out!;
    let lrDiff = 0;
    for (let i = 0; i < out.length; i++) lrDiff = Math.max(lrDiff, Math.abs(out[i]! - outR[i]!));
    expect(lrDiff).toBe(0);
    const envInv = bufs.env_inv_out!;
    let mirrorErr = 0;
    for (let i = 0; i < env.length; i++) {
      mirrorErr = Math.max(mirrorErr, Math.abs(envInv[i]! - (1 - env[i]!)));
    }
    expect(mirrorErr).toBeLessThan(1e-6);

    // Deterministic re-render is bit-identical (fresh processor instance).
    const again = await renderProfile();
    for (const k of ['audio_l_out', 'env_out'] as const) {
      let diff = 0;
      for (let i = 0; i < out.length; i++) diff = Math.max(diff, Math.abs(bufs[k]![i]! - again[k]![i]!));
      expect(diff).toBe(0);
    }
  });

  it('pins the audio_l_out/env_out profile baselines (SHA-gated, RMS tier B)', async () => {
    const srcSha = await dspSourceSha('sidecar.ts', 'lib/compressor-dsp.ts');
    const bufs = await renderProfile();
    await pinAll('sidecar', srcSha, { audio_l_out: bufs.audio_l_out!, env_out: bufs.env_out! });
  });
});
