// art/scenarios/clap/profile.test.ts
//
// AUDIO PROFILE for CLAP (id `clap` — the analog-modeled handclap voice:
// seeded noise → COLOR pole → Chamberlin band-pass, the 808 twin-VCA
// burst+tail topology, 2×-oversampled warm-tanh drive). Ships with the
// module per the audio-profile gate: every new audio def lands with ≥1
// committed baseline.
//
// Category: trigger-fired SOURCE. Driver: a 3-strike trigger train over
// 2.0 s that is MUSICALLY REPRESENTATIVE — each strike lands at a
// different TONE/TAIL corner of the voice (the sonic-range settings the
// unit tier proves), so the pinned golden covers the spectrum, not one
// default hit:
//
//   strike 1 @ 0.0 s — shipping defaults (the 808 canonical: 1 kHz, 150 ms)
//   strike 2 @ 0.7 s — bright + tight (tone 2400 Hz, tail 60 ms — 909-ish)
//   strike 3 @ 1.4 s — dark + roomy  (tone 500 Hz, tail 500 ms — Linn-ish)
//
// Param changes land at the exact strike sample indexes (deterministic;
// the strike latches burst geometry + reseeds the noise, so each hit is
// bit-identical per render). Signature output captured: `audio_out` (the
// module's ONE mono output).
//
// The .sha pin covers the worklet entry AND every lib the per-sample math
// flows through (clap-dsp + its dsp-utils / oversample imports), so a
// coefficient change in ANY of them forces an intentional
// `task art:update` re-capture. Re-pin the .sha LAST (memory
// `art-sha-pin-regenerate-last`).

import { describe, expect, it } from 'vitest';
import {
  CLAP_DEFAULTS,
  clapStep,
  makeClapState,
  type ClapParams,
} from '../../../packages/dsp/src/lib/clap-dsp';
import { captureOutputs, dspSourceSha, pinAll, SAMPLE_RATE } from '../../setup/capture';
import { TRIGGER_PULSE_S } from '../../setup/drivers';

const SR = SAMPLE_RATE;
const DURATION_S = 2.0;

/** The three strikes: sample index + the TONE/TAIL corner for that hit. */
const STRIKES: ReadonlyArray<{ at: number; tone: number; tail: number }> = [
  { at: 0, tone: CLAP_DEFAULTS.tone, tail: CLAP_DEFAULTS.tail }, // 808 default
  { at: Math.round(0.7 * SR), tone: 2400, tail: 60 }, // bright + tight
  { at: Math.round(1.4 * SR), tone: 500, tail: 500 }, // dark + roomy
];
const PULSE_N = Math.round(TRIGGER_PULSE_S * SR);

/** Render the 3-corner strike train through the pure core. */
function renderProfile(): Record<string, Float32Array> {
  const p: ClapParams = { ...CLAP_DEFAULTS };
  const st = makeClapState();
  return captureOutputs({ durationS: DURATION_S, outputs: ['audio_out'] }, (i) => {
    // Apply each strike's TONE/TAIL corner AT its strike sample (params
    // settle instantly in the pure core — the worklet's smoother is a
    // wrapper concern, not part of the pinned per-sample math).
    for (const s of STRIKES) {
      if (i === s.at) {
        p.tone = s.tone;
        p.tail = s.tail;
      }
    }
    const trig = STRIKES.some((s) => i >= s.at && i < s.at + PULSE_N) ? 1 : 0;
    return { audio_out: clapStep(trig, 0, p, SR, st) };
  });
}

function rms(b: Float32Array, s = 0, e = b.length): number {
  let x = 0;
  for (let i = s; i < e; i++) x += b[i]! * b[i]!;
  return Math.sqrt(x / Math.max(1, e - s));
}

describe('ART clap / audio profile (3-strike TONE/TAIL corner train)', () => {
  it('renders a finite, audible, deterministic clap train', () => {
    const { audio_out } = renderProfile();
    const buf = audio_out!;
    expect(buf.length).toBe(Math.round(SR * DURATION_S));
    expect(buf.every(Number.isFinite)).toBe(true);
    // Audible + true-peak bounded (the core ends in tanh, so |out| < 1).
    let peak = 0;
    for (const v of buf) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeGreaterThan(0.2);
    expect(peak).toBeLessThan(1);
    // ALL three strikes landed: attack-window energy after each edge.
    for (const s of STRIKES) {
      expect(rms(buf, s.at, s.at + Math.round(0.08 * SR))).toBeGreaterThan(0.01);
    }
    // The corners are AUDIBLY different: the roomy hit (tail 500) still
    // carries energy 300-450 ms in, where the tight hit (tail 60) is gone.
    const roomy = rms(buf, STRIKES[2]!.at + Math.round(0.3 * SR), STRIKES[2]!.at + Math.round(0.45 * SR));
    const tight = rms(buf, STRIKES[1]!.at + Math.round(0.3 * SR), STRIKES[1]!.at + Math.round(0.45 * SR));
    expect(roomy).toBeGreaterThan(10 * Math.max(tight, 1e-9));
    // DC ≈ 0 (the core's own 20 Hz DC block).
    let sum = 0;
    for (const v of buf) sum += v;
    expect(Math.abs(sum / buf.length)).toBeLessThan(0.01);
    // Deterministic: a second render is bit-identical (the strike resets
    // filter/envelope state AND reseeds the noise xorshift32).
    const again = renderProfile().audio_out!;
    let diff = 0;
    for (let i = 0; i < buf.length; i++) diff = Math.max(diff, Math.abs(buf[i]! - again[i]!));
    expect(diff).toBe(0);
  });

  it('pins the audio_out profile baseline (SHA-gated, RMS tier B)', async () => {
    const srcSha = await dspSourceSha(
      'clap.ts',
      'lib/clap-dsp.ts',
      'lib/dsp-utils.ts',
      'lib/oversample.ts',
    );
    await pinAll('clap', srcSha, renderProfile());
  });
});
