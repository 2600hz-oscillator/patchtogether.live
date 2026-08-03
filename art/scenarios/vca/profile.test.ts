// art/scenarios/vca/profile.test.ts
//
// AUDIO PROFILE for VCA (voltage-controlled amplifier, mono) — backfill
// batch 6, the FAUST-IN-NODE harness's first pinned module (spec §5,
// .myrobots/plans/art-backfill-audio-profiles-2026-07-01.md).
//
// VCA is Faust (packages/dsp/src/vca.dsp): out = audio * (base + cvAmount*cv),
// gain one-pole-smoothed (si.smoo). No pure-TS core, no self-contained TS
// worklet — the ONLY faithful offline render is the compiled wasm itself,
// pumped headless through @grame/faustwasm's FaustMonoOfflineProcessor
// (art/setup/faust-offline.ts). Faust input order = the def's ChannelMerger
// wiring: [audio, cv]; output 0 = the `audio` port.
//
// Category: FX / AMPLIFIER, driven so the DEFINING behavior shows — audio
// GATED by a control signal. A C4 saw is passed while a held CV gate is high
// (t < 0.5 s) and shut off when it falls (t ≥ 0.5 s): the classic envelope-
// gated VCA. cvAmount=1, base=0 (silent-when-unpatched), so the output is
// audio×cv with the smoother rounding the gate edges.
//
// SIGNATURE output (owner decision §6b.2): `audio`. The def's second port
// `audio_inv` is a factory-side GainNode(-1) tap = exactly −audio (no
// independent information), so it is NOT separately pinned.

import { describe, expect, it } from 'vitest';
import { dspSourceSha, pinAll, SAMPLE_RATE } from '../../setup/capture';
import { vcoTestSignal, heldGate, C4_HZ } from '../../setup/drivers';
import { renderFaustOffline } from '../../setup/faust-offline';

const SR = SAMPLE_RATE;
const DURATION_S = 1.0;
const GATE_S = 0.5;

// The CV-BANDWIDTH leg (below) needs its own render, because this profile's
// two measurement windows are 0.05–0.45 s and 0.7–1.0 s — both an order of
// magnitude longer than any envelope slew, so a VCA that lowpassed its own CV
// at 7 Hz was STRUCTURALLY outside every assertion here. It shipped that way.
const SLEW_PROBE_DELAY_S = 0.25; // past si.smoo's own start-up ramp on cvAmount

const audio = vcoTestSignal({ totalS: DURATION_S, shape: 'saw', freqHz: C4_HZ, amp: 0.5 });
const cv = heldGate({ totalS: DURATION_S, onS: GATE_S, level: 1 });

async function renderProfile(): Promise<Record<string, Float32Array>> {
  return renderFaustOffline({
    name: 'vca',
    totalSamples: Math.round(SR * DURATION_S),
    inputs: [audio, cv], // [audio, cv] — the def's merger channel order
    params: { base: 0, cvAmount: 1 },
    outputs: ['audio'], // Faust output 0 = the `audio` port
  });
}

function rms(b: Float32Array, s: number, e: number): number {
  let x = 0;
  for (let i = s; i < e; i++) x += b[i]! * b[i]!;
  return Math.sqrt(x / Math.max(1, e - s));
}

describe('ART vca / audio profile (envelope-gated amplifier via the Faust-in-Node harness)', () => {
  it('passes audio while the CV gate is high and mutes it after the gate falls', async () => {
    const n = Math.round(SR * DURATION_S);
    const out = (await renderProfile()).audio!;
    expect(out.length).toBe(n);
    expect(out.every(Number.isFinite)).toBe(true);

    // While the gate is high the VCA passes the 0.5-amp saw (unity gain): a
    // healthy signal. After the gate falls (+ the ~ms smoother settle) it is
    // essentially silent — the "gate closed → no sound" VCA signature.
    const openRms = rms(out, Math.round(0.05 * SR), Math.round(0.45 * SR));
    const shutRms = rms(out, Math.round(0.7 * SR), n);
    expect(openRms).toBeGreaterThan(0.1);
    expect(shutRms).toBeLessThan(0.005);
    expect(openRms).toBeGreaterThan(shutRms * 20);

    // Peak never exceeds the input IN THIS SCENARIO — base 0, cvAmount 1 and
    // cv ≤ 1, so gain ≤ 1 here. NOT a property of the module: the def's gain
    // is `base + cvAmount * cv` and is UNCLAMPED (vca.ts:209,
    // vca-gain-model.ts:64-67), so it boosts past unity whenever the sum
    // exceeds 1. Widen the scenario and this bound must be re-derived.
    let peak = 0;
    for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]!));
    expect(peak).toBeGreaterThan(0.3);
    expect(peak).toBeLessThan(0.55);

    // Byte-deterministic re-render (headless Faust compute is pure).
    const again = (await renderProfile()).audio!;
    let diff = 0;
    for (let i = 0; i < n; i++) diff = Math.max(diff, Math.abs(out[i]! - again[i]!));
    expect(diff).toBe(0);
  });

  // ── THE LEG THIS PROFILE WAS MISSING ────────────────────────────────────
  // A VCA's headline job is to FOLLOW an envelope, and nothing above could
  // see whether it does. `si.smoo` was applied to the whole `base + cvAmount
  // * cv` sum, so the CV was lowpassed at 7.02 Hz along with the knobs: a
  // 1 ms and a 5 ms ADSR attack both produced an IDENTICAL 49.79 ms rise and
  // the module was bit-for-bit blind to anything under ~20 ms. Every window
  // in this file is ≥ 400 ms wide, so the defect could not register.
  //
  // The assertion is on RISE TIME, and — crucially — on two DIFFERENT
  // attacks producing DIFFERENT rises. A single absolute threshold would
  // pass a VCA that simply slewed faster; requiring the two to separate is
  // what makes "the module tracks its CV" the thing being tested.
  it('tracks the CV: a 1 ms and a 5 ms attack produce DIFFERENT rise times', async () => {
    const n = Math.round(SR * DURATION_S);
    const audio = new Float32Array(n).fill(1); // DC → the output IS the gain

    /** Linear attack ramp starting at SLEW_PROBE_DELAY_S, then held. */
    const attackCv = (attackS: number): Float32Array => {
      const out = new Float32Array(n);
      const d = Math.round(SLEW_PROBE_DELAY_S * SR);
      const a = Math.max(1, Math.round(attackS * SR));
      for (let i = d; i < n; i++) out[i] = i - d < a ? (i - d) / a : 1;
      return out;
    };
    /** 10 → 90 % rise of the gain envelope, in MILLISECONDS (units matter
     *  here: the bug was a time constant hiding inside a level assertion). */
    const riseMs = (g: Float32Array): number => {
      let i10 = -1;
      let i90 = -1;
      for (let i = 0; i < g.length; i++) {
        if (i10 < 0 && g[i]! >= 0.1) i10 = i;
        if (g[i]! >= 0.9) { i90 = i; break; }
      }
      expect(i10, 'gain never reached 0.1').toBeGreaterThanOrEqual(0);
      expect(i90, 'gain never reached 0.9').toBeGreaterThanOrEqual(0);
      return ((i90 - i10) / SR) * 1000;
    };
    const render = async (cv: Float32Array): Promise<Float32Array> =>
      (await renderFaustOffline({
        name: 'vca',
        totalSamples: n,
        inputs: [audio, cv],
        params: { base: 0, cvAmount: 1 },
        outputs: ['audio'],
      })).audio!;

    const r1 = riseMs(await render(attackCv(0.001)));
    const r5 = riseMs(await render(attackCv(0.005)));
    const r50 = riseMs(await render(attackCv(0.05)));

    // 10-90 % of a linear ramp of length T is exactly 0.8·T. Allow a sample
    // or two of quantisation, nothing more — this is a transparent gain
    // stage, so the CV should arrive intact.
    expect(r1, `1 ms attack rose in ${r1.toFixed(2)} ms (expected ≈0.8)`).toBeLessThan(1.5);
    expect(r5, `5 ms attack rose in ${r5.toFixed(2)} ms (expected ≈4.0)`).toBeGreaterThan(3.5);
    expect(r5).toBeLessThan(4.5);
    expect(r50, `50 ms attack rose in ${r50.toFixed(2)} ms (expected ≈40)`).toBeGreaterThan(38);

    // THE DISCRIMINATOR. With the CV smoothed these two read 49.79 / 49.79.
    expect(
      r5 - r1,
      `1 ms → ${r1.toFixed(2)} ms, 5 ms → ${r5.toFixed(2)} ms. If these are ` +
        `equal the VCA is not following its CV — something in the gain path ` +
        `is slew-limiting it (si.smoo applied to the SUM was the shipped bug).`,
    ).toBeGreaterThan(2);
  });

  it('pins the audio profile baseline (SHA-gated on vca.dsp, RMS tier B)', async () => {
    const srcSha = await dspSourceSha('vca.dsp');
    const bufs = await renderProfile();
    await pinAll('vca', srcSha, { audio: bufs.audio! });
  });
});
