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

    // Peak never exceeds the input (gain ≤ 1) — a VCA attenuates, never boosts.
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

  it('pins the audio profile baseline (SHA-gated on vca.dsp, RMS tier B)', async () => {
    const srcSha = await dspSourceSha('vca.dsp');
    const bufs = await renderProfile();
    await pinAll('vca', srcSha, { audio: bufs.audio! });
  });
});
