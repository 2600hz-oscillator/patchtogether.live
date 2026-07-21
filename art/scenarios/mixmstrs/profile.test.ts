// art/scenarios/mixmstrs/profile.test.ts
//
// AUDIO PROFILE for MIXMSTRS (8-channel stereo mixer + EQ/comp + 2 stereo aux
// sends) — backfill batch 6, Faust-in-Node harness (spec §5). MIXMSTRS is the
// batch's harness STRESS TEST: a 20-input / 14-output Faust module
// (packages/dsp/src/mixmstrs.dsp) rendered headless in one pass. Faust I/O
// order is the process() signature: inputs 0,1=ch1 L/R, 2,3=ch2 L/R, … 14,15=ch8
// L/R, 16,17=return1 L/R, 18,19=return2 L/R; outputs 0,1=master L/R, 2,3=send1
// L/R, 4,5=send2 L/R, 6..13=per-channel meter taps (NOT patchable ports).
//
// Category: STEREO MIXER + AUX SENDS, driven so the ROUTING is provable:
//   ch1 (L=R) = C4 saw @ vol 0.8, routed to SEND 1 (ch1_send1 = 0.7)
//   ch2 (L=R) = G4 sine @ vol 0.6, routed to SEND 2 (ch2_send2 = 0.6)
//   EQ flat (0 dB = identity), compressors bypassed (compEnable 0), master 0.9.
// So MASTER carries BOTH tones; SEND 1 carries ONLY ch1's saw; SEND 2 carries
// ONLY ch2's sine — three genuinely different signals.
//
// SIGNATURE outputs (owner §6b.2 — distinct only): masterL, send1L, send2L.
// L/R are byte-identical here (symmetric input, identical per-side chains), so
// the R twins are asserted structurally, not pinned (no near-duplicate lanes).

import { describe, expect, it } from 'vitest';
import { dspSourceSha, pinAll, SAMPLE_RATE } from '../../setup/capture';
import { vcoTestSignal, C4_HZ } from '../../setup/drivers';
import { renderFaustOffline } from '../../setup/faust-offline';

const SR = SAMPLE_RATE;
const DURATION_S = 0.5;
const CH2_HZ = 392; // G4 sine

const saw = vcoTestSignal({ totalS: DURATION_S, shape: 'saw', freqHz: C4_HZ, amp: 0.5 });
const sine = vcoTestSignal({ totalS: DURATION_S, shape: 'sine', freqHz: CH2_HZ, amp: 0.5 });

async function renderProfile(): Promise<Record<string, Float32Array>> {
  const n = Math.round(SR * DURATION_S);
  // 20 inputs: ch1 L/R = saw, ch2 L/R = sine, everything else silent
  // (ch3..ch8 = idx 4..15, returns = idx 16..19 — all silent).
  const inputs: (Float32Array | null)[] = new Array(20).fill(null);
  inputs[0] = saw; inputs[1] = saw;   // ch1 L/R
  inputs[2] = sine; inputs[3] = sine; // ch2 L/R
  return renderFaustOffline({
    name: 'mixmstrs',
    totalSamples: n,
    inputs,
    params: {
      ch1_volume: 0.8, ch2_volume: 0.6, master_volume: 0.9,
      ch1_send1: 0.7, ch2_send2: 0.6,
      // EQ flat + comps bypassed are the defaults, set explicitly for clarity.
      ch1_compEnable: 0, ch2_compEnable: 0,
    },
    // Faust output index order — capture the 6 patchable ports; the 8 trailing
    // meter taps are dropped.
    outputs: ['masterL', 'masterR', 'send1L', 'send1R', 'send2L', 'send2R'],
  });
}

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

describe('ART mixmstrs / audio profile (16-in/12-out stereo mixer routing via the Faust-in-Node harness)', () => {
  it('routes both tones to master, ch1 to send1 only, ch2 to send2 only', async () => {
    const n = Math.round(SR * DURATION_S);
    const b = await renderProfile();
    const s = Math.round(0.1 * SR);
    for (const id of ['masterL', 'send1L', 'send2L']) {
      expect(b[id]!.length, id).toBe(n);
      expect(b[id]!.every(Number.isFinite), id).toBe(true);
    }

    // MASTER carries BOTH tones.
    expect(goertzel(b.masterL!, s, n, C4_HZ)).toBeGreaterThan(0.05);
    expect(goertzel(b.masterL!, s, n, CH2_HZ)).toBeGreaterThan(0.05);

    // SEND 1 carries ch1's saw but essentially NONE of ch2's sine.
    expect(goertzel(b.send1L!, s, n, C4_HZ)).toBeGreaterThan(0.05);
    expect(goertzel(b.send1L!, s, n, CH2_HZ)).toBeLessThan(0.005);

    // SEND 2 carries ch2's sine but essentially NONE of ch1's saw fundamental.
    expect(goertzel(b.send2L!, s, n, CH2_HZ)).toBeGreaterThan(0.05);
    expect(goertzel(b.send2L!, s, n, C4_HZ)).toBeLessThan(0.005);

    // L/R twins are byte-identical (symmetric input) — so pinning only the L
    // side fully covers the pair without a near-duplicate baseline.
    let dMaster = 0, dSend1 = 0, dSend2 = 0;
    for (let i = 0; i < n; i++) {
      dMaster = Math.max(dMaster, Math.abs(b.masterL![i]! - b.masterR![i]!));
      dSend1 = Math.max(dSend1, Math.abs(b.send1L![i]! - b.send1R![i]!));
      dSend2 = Math.max(dSend2, Math.abs(b.send2L![i]! - b.send2R![i]!));
    }
    expect(dMaster).toBe(0);
    expect(dSend1).toBe(0);
    expect(dSend2).toBe(0);

    // Byte-deterministic re-render.
    const again = await renderProfile();
    let diff = 0;
    for (let i = 0; i < n; i++) diff = Math.max(diff, Math.abs(b.masterL![i]! - again.masterL![i]!));
    expect(diff).toBe(0);
  });

  it('pins the distinct signature baselines (masterL / send1L / send2L; SHA-gated on mixmstrs.dsp)', async () => {
    const srcSha = await dspSourceSha('mixmstrs.dsp');
    const b = await renderProfile();
    await pinAll('mixmstrs', srcSha, { masterL: b.masterL!, send1L: b.send1L!, send2L: b.send2L! });
  });
});
