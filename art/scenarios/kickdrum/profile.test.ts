// art/scenarios/kickdrum/profile.test.ts
//
// AUDIO PROFILE for KICK DRUM (id `kickdrum` — the layered stereo kick
// voice, build plan .myrobots/plans/kick-drum-voice-2026-07-01.md). Ships
// with the module per the audio-profile gate (#999): every new audio def
// lands with ≥1 committed baseline.
//
// Category: trigger-fired SOURCE. Driver: canonical trigger train — two
// strikes at 120 BPM over 1.0 s (spec §4.1 wants ≥1.0 s for decay-tail
// modules so the full sub tail is visible in the gallery). Signature output
// captured: `audio_l` ONLY — the voice is mono-summed L = R until the
// Phase-5 stereo crossover lands, so the right lane is byte-identical and
// pinning it would be a redundant near-identical lane (owner decision
// §6b.2). When L/R genuinely diverge, add `audio_r`.
//
// Rendered from the PURE core (packages/dsp/src/lib/kickdrum-dsp.ts
// kickdrumP1Step — the full Phases-1–4 chain: sub+body+click → oversampled
// drive → EQ+translate → dynamics/ceiling) with the def's shipping
// defaults — deterministic by construction: the strike resets oscillator
// phases to 0 AND reseeds the click's xorshift32 noise, and the trigger
// train is epoch-pinned to sample 0.
//
// The .sha pin covers the worklet entry AND every -dsp lib the per-sample
// math flows through (kickdrum-dsp + its moog-vco / chowkick-dsp imports),
// so a coefficient change in ANY of them forces an intentional
// `task art:update` re-capture. Re-pin the .sha LAST (memory
// `art-sha-pin-regenerate-last`).

import { describe, expect, it } from 'vitest';
import {
  KICKDRUM_P1_DEFAULTS,
  kickdrumP1Step,
  makeKickdrumState,
} from '../../../packages/dsp/src/lib/kickdrum-dsp';
import { captureOutputs, dspSourceSha, pinAll, SAMPLE_RATE } from '../../setup/capture';
import { triggerTrain } from '../../setup/drivers';

const SR = SAMPLE_RATE;
const DURATION_S = 1.0;

/** Render the default-patch 2-strike train through the pure Phase-1 core. */
function renderProfile(): Record<string, Float32Array> {
  // Two strikes: rising edges at 0 ms and 500 ms (120 BPM), canonical
  // TRIGGER_PULSE_S-wide pulses. Accent unpatched (0).
  const trig = triggerTrain({ totalS: DURATION_S, bpm: 120 });
  const p = { ...KICKDRUM_P1_DEFAULTS };
  const st = makeKickdrumState();
  return captureOutputs({ durationS: DURATION_S, outputs: ['audio_l'] }, (i) => ({
    audio_l: kickdrumP1Step(trig[i]!, 0, p, SR, st),
  }));
}

function rms(b: Float32Array, s = 0, e = b.length): number {
  let x = 0;
  for (let i = s; i < e; i++) x += b[i]! * b[i]!;
  return Math.sqrt(x / Math.max(1, e - s));
}

describe('ART kickdrum / audio profile (default patch, 2-strike trigger train)', () => {
  it('renders a finite, audible, deterministic kick train', () => {
    const { audio_l } = renderProfile();
    const buf = audio_l!;
    expect(buf.length).toBe(Math.round(SR * DURATION_S));
    expect(buf.every(Number.isFinite)).toBe(true);
    // Audible + true-peak bounded (the core ends in the ceiling tanh, so
    // |out| is STRICTLY < 1 by construction).
    let peak = 0;
    for (const v of buf) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeGreaterThan(0.2);
    expect(peak).toBeLessThan(1);
    // BOTH strikes landed: attack-window energy after each rising edge.
    expect(rms(buf, 0, Math.round(0.1 * SR))).toBeGreaterThan(0.01);
    expect(rms(buf, Math.round(0.5 * SR), Math.round(0.6 * SR))).toBeGreaterThan(0.01);
    // The LONG sub tail is present (sub_decay 450 ms ≫ body_decay 120 ms):
    // the 300–450 ms window still carries energy while the body is gone.
    expect(rms(buf, Math.round(0.3 * SR), Math.round(0.45 * SR))).toBeGreaterThan(1e-3);
    // DC ≈ 0 (the core's own 20 Hz DC block).
    let sum = 0;
    for (const v of buf) sum += v;
    expect(Math.abs(sum / buf.length)).toBeLessThan(0.01);
    // Deterministic: a second render is bit-identical (phase-reset strike +
    // the click noise reseeded at every strike).
    const again = renderProfile().audio_l!;
    let diff = 0;
    for (let i = 0; i < buf.length; i++) diff = Math.max(diff, Math.abs(buf[i]! - again[i]!));
    expect(diff).toBe(0);
  });

  it('pins the audio_l profile baseline (SHA-gated, RMS tier B)', async () => {
    const srcSha = await dspSourceSha(
      'kickdrum.ts',
      'lib/kickdrum-dsp.ts',
      'lib/moog-vco-dsp.ts',
      'lib/chowkick-dsp.ts',
    );
    await pinAll('kickdrum', srcSha, renderProfile());
  });
});
