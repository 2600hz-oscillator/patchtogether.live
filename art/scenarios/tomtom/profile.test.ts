// art/scenarios/tomtom/profile.test.ts
//
// AUDIO PROFILE for TOM DRUM (id `tomtom` — the analog-modeled tom voice:
// membrane fundamental + 1.593× overtone on one exponential bend law,
// band-passed breath noise, 2×-oversampled warm-tanh drive). Ships with the
// module per the audio-profile gate: every new audio def lands with ≥1
// committed baseline.
//
// Category: trigger-fired SOURCE. Driver: canonical trigger train — two
// strikes at 120 BPM over 1.0 s (≥1.0 s for decay-tail modules; the default
// 350 ms decay tail is fully visible in the gallery). Signature output
// captured: `audio_out` (the module's ONE mono output).
//
// Rendered from the PURE core (packages/dsp/src/lib/tomtom-dsp.ts
// tomtomStep — strike edge-detect + accent latch inside the core) with the
// def's shipping defaults — deterministic by construction: the strike
// resets both oscillator phases AND reseeds the breath-noise xorshift32,
// and the trigger train is epoch-pinned to sample 0.
//
// The .sha pin covers the worklet entry AND every lib the per-sample math
// flows through (tomtom-dsp + its dsp-utils / oversample imports), so a
// coefficient change in ANY of them forces an intentional
// `task art:update` re-capture. Re-pin the .sha LAST (memory
// `art-sha-pin-regenerate-last`).

import { describe, expect, it } from 'vitest';
import {
  TOMTOM_DEFAULTS,
  makeTomtomState,
  tomtomStep,
} from '../../../packages/dsp/src/lib/tomtom-dsp';
import { captureOutputs, dspSourceSha, pinAll, SAMPLE_RATE } from '../../setup/capture';
import { triggerTrain } from '../../setup/drivers';

const SR = SAMPLE_RATE;
const DURATION_S = 1.0;

/** Render the default-patch 2-strike train through the pure core. */
function renderProfile(): Record<string, Float32Array> {
  // Two strikes: rising edges at 0 ms and 500 ms (120 BPM), canonical
  // TRIGGER_PULSE_S-wide pulses. Accent unpatched (0).
  const trig = triggerTrain({ totalS: DURATION_S, bpm: 120 });
  const p = { ...TOMTOM_DEFAULTS };
  const st = makeTomtomState();
  return captureOutputs({ durationS: DURATION_S, outputs: ['audio_out'] }, (i) => ({
    audio_out: tomtomStep(trig[i]!, 0, p, SR, st),
  }));
}

function rms(b: Float32Array, s = 0, e = b.length): number {
  let x = 0;
  for (let i = s; i < e; i++) x += b[i]! * b[i]!;
  return Math.sqrt(x / Math.max(1, e - s));
}

describe('ART tomtom / audio profile (default patch, 2-strike trigger train)', () => {
  it('renders a finite, audible, deterministic tom train', () => {
    const { audio_out } = renderProfile();
    const buf = audio_out!;
    expect(buf.length).toBe(Math.round(SR * DURATION_S));
    expect(buf.every(Number.isFinite)).toBe(true);
    // Audible + true-peak bounded (the core ends in tanh, so |out| < 1).
    let peak = 0;
    for (const v of buf) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeGreaterThan(0.2);
    expect(peak).toBeLessThan(1);
    // BOTH strikes landed: attack-window energy after each rising edge.
    expect(rms(buf, 0, Math.round(0.1 * SR))).toBeGreaterThan(0.01);
    expect(rms(buf, Math.round(0.5 * SR), Math.round(0.6 * SR))).toBeGreaterThan(0.01);
    // The default 350 ms decay tail is present: the 250–350 ms window still
    // carries energy while the breath (≤105 ms here) is long gone.
    expect(rms(buf, Math.round(0.25 * SR), Math.round(0.35 * SR))).toBeGreaterThan(1e-3);
    // DC ≈ 0 (the core's own 20 Hz DC block).
    let sum = 0;
    for (const v of buf) sum += v;
    expect(Math.abs(sum / buf.length)).toBeLessThan(0.01);
    // Deterministic: a second render is bit-identical (phase-reset strike +
    // the breath noise reseeded at every strike).
    const again = renderProfile().audio_out!;
    let diff = 0;
    for (let i = 0; i < buf.length; i++) diff = Math.max(diff, Math.abs(buf[i]! - again[i]!));
    expect(diff).toBe(0);
  });

  it('pins the audio_out profile baseline (SHA-gated, RMS tier B)', async () => {
    const srcSha = await dspSourceSha(
      'tomtom.ts',
      'lib/tomtom-dsp.ts',
      'lib/dsp-utils.ts',
      'lib/oversample.ts',
    );
    await pinAll('tomtom', srcSha, renderProfile());
  });
});
