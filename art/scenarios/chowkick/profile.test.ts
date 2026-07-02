// art/scenarios/chowkick/profile.test.ts
//
// AUDIO PROFILE for CHOWKICK (backfill Phase-0 pilot — spec §4.1/§4.3,
// .myrobots/plans/art-backfill-audio-profiles-2026-07-01.md). First scenario
// through the shared capture harness (art/setup/capture.ts + drivers.ts).
//
// Category: gate-triggered SOURCE. Driver: canonical held-square gate train
// (two kicks at 120 BPM over 1.0 s — spec §4.1 wants ≥1.0 s for decay-tail
// modules so the full kick body + tail is visible in the gallery).
// Signature output captured: `audio_out` (the module's only audio out).
//
// Rendered from the pure-TS core (packages/dsp/src/lib/chowkick-dsp.ts) with
// the worklet's SHIPPING DEFAULT patch, mirroring chowkick.ts process()
// order exactly: pitch-env → pulse+noise → resonant body → drive → DC-block
// → output filter. Deterministic: the noise burst runs on the seeded
// xorshift32 PRNG (same 0xC0FFEE default seed as the worklet), and freq/CV
// are constant so the portamento smoother is a fixed point.
//
// The .sha pin covers BOTH the worklet entry and the -dsp lib (the
// combinedSourceSha discipline), so a coefficient change in either forces an
// intentional `task art:update` re-capture.
//
// The sibling canonical-kicks.test.ts pins behavioral characteristics
// (envelope shape, punch metrics); THIS file pins the raw audio profile.

import { describe, expect, it } from 'vitest';
import {
  makeDcBlockState,
  makeNoiseState,
  makeOutputState,
  makePitchEnvState,
  makePulseState,
  makeResonantState,
  bodyDriveStep,
  dcBlockStep,
  noiseBurstStep,
  outputFilterStep,
  pitchEnvStep,
  pulseShaperStep,
  resonantCoefs,
  resonantFilterStep,
} from '../../../packages/dsp/src/lib/chowkick-dsp';
import { captureOutputs, dspSourceSha, pinAll, SAMPLE_RATE } from '../../setup/capture';
import { gateTrain, PROFILE_NOISE_SEED } from '../../setup/drivers';

const SR = SAMPLE_RATE;
const DURATION_S = 1.0;

// The worklet's shipping defaults (chowkick.ts parameterDescriptors).
const DEF = {
  width_ms: 0.5,
  amp: 1,
  decay01: 0.3,
  sustain01: 0,
  noiseAmount: 0.5,
  noiseDecay01: 0.07,
  noiseCutoff: 5500,
  noiseType: 0 as const,
  freqHz: 80,
  q: 1.6,
  damping01: 0.4,
  tight01: 0.6,
  bounce01: 0,
  toneHz: 3200,
  levelDb: 0,
  pitchAmount: 0.9,
  pitchDecay01: 0.28,
  drive01: 0.5,
};

/** Render the default-patch kick train through the full pure-core chain. */
function renderProfile(): Record<string, Float32Array> {
  // Two kicks: rising edges at 0 ms and 500 ms (120 BPM), 10 ms gates.
  const gate = gateTrain({ totalS: DURATION_S, bpm: 120, gateS: 0.01 });
  const pulseSt = makePulseState();
  const noiseSt = makeNoiseState(PROFILE_NOISE_SEED);
  const resSt = makeResonantState();
  const outSt = makeOutputState();
  const pitchSt = makePitchEnvState();
  const dcSt = makeDcBlockState();
  const noisePrev = { v: false };
  return captureOutputs({ durationS: DURATION_S, outputs: ['audio_out'] }, (i) => {
    const g = gate[i]!;
    const bodyFreq = pitchEnvStep(g, DEF.freqHz, DEF.pitchAmount, DEF.pitchDecay01, SR, pitchSt);
    const pulse = pulseShaperStep(g, DEF.width_ms, DEF.amp, DEF.decay01, DEF.sustain01, SR, pulseSt);
    const noise = noiseBurstStep(
      g, DEF.noiseAmount, DEF.noiseDecay01, DEF.noiseCutoff, DEF.noiseType, SR, noiseSt, noisePrev,
    );
    const coefs = resonantCoefs(bodyFreq, DEF.q, DEF.damping01, DEF.tight01, DEF.bounce01, SR);
    let body = resonantFilterStep(pulse + noise, coefs, resSt);
    body = bodyDriveStep(body, DEF.drive01, DEF.tight01);
    body = dcBlockStep(body, dcSt, 25, SR);
    return { audio_out: outputFilterStep(body, DEF.toneHz, DEF.levelDb, SR, outSt) };
  });
}

function rms(b: Float32Array, s = 0, e = b.length): number {
  let x = 0;
  for (let i = s; i < e; i++) x += b[i]! * b[i]!;
  return Math.sqrt(x / Math.max(1, e - s));
}

describe('ART chowkick / audio profile (default patch, 2-kick gate train)', () => {
  it('renders a finite, audible, deterministic kick train', () => {
    const { audio_out } = renderProfile();
    const buf = audio_out!;
    expect(buf.length).toBe(Math.round(SR * DURATION_S));
    expect(buf.every(Number.isFinite)).toBe(true);
    // Audible + bounded (the body's safety tanh caps the peak).
    let peak = 0;
    for (const v of buf) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeGreaterThan(0.3);
    expect(peak).toBeLessThan(5);
    // BOTH kicks landed: attack-window energy after each rising edge.
    expect(rms(buf, 0, Math.round(0.1 * SR))).toBeGreaterThan(0.01);
    expect(rms(buf, Math.round(0.5 * SR), Math.round(0.6 * SR))).toBeGreaterThan(0.01);
    // Deterministic: a second render is bit-identical (seeded PRNG).
    const again = renderProfile().audio_out!;
    let diff = 0;
    for (let i = 0; i < buf.length; i++) diff = Math.max(diff, Math.abs(buf[i]! - again[i]!));
    expect(diff).toBe(0);
  });

  it('pins the audio_out profile baseline (SHA-gated, RMS tier B)', async () => {
    const srcSha = await dspSourceSha('chowkick.ts', 'lib/chowkick-dsp.ts');
    await pinAll('chowkick', srcSha, renderProfile());
  });
});
