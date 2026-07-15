// art/scenarios/sixstrum/profile.test.ts
//
// AUDIO PROFILE for SIX STRUM (id `sixstrum` — the 6-voice guitar/bass/harp
// instrument: six karplus string voices + per-voice ADSR + strum scheduler +
// resonant body, summed mono). Ships with the module per the audio-profile
// gate: every new audio def lands with ≥1 committed baseline.
//
// Rendered from the PURE core (packages/dsp/src/lib/sixstrum-dsp.ts) with the
// def's shipping defaults — deterministic by construction (each voice's burst
// xorshift32 is seeded at construction and reseeded per strike; the strum
// trigger train is epoch-pinned to sample 0). The .sha pin covers the worklet
// entry AND every lib the per-sample math flows through — karplus-dsp,
// analog-delay-core (the shared cofefve loop), adsr-env, sixstrum-tuning,
// dsp-utils — so any change there forces an intentional re-capture HERE too.
// Re-pin the .sha LAST (memory `art-sha-pin-regenerate-last`).

import { describe, expect, it } from 'vitest';
import {
  SIXSTRUM_DEFAULTS,
  SS_STRINGS,
  type SixStrumParams,
  type SixStrumFrame,
  makeSixStrumState,
  prepSixStrumBlock,
  sixStrumStep,
} from '../../../packages/dsp/src/lib/sixstrum-dsp';
import { captureOutputs, dspSourceSha, pinAll, SAMPLE_RATE } from '../../setup/capture';

const SR = SAMPLE_RATE;
const DURATION_S = 1.5;
const BLOCK = 128;

function makeFrame(): SixStrumFrame {
  return {
    strum: new Float32Array(SS_STRINGS),
    mute: new Float32Array(SS_STRINGS),
    polyPitch: new Float32Array(SS_STRINGS),
    polyGate: new Float32Array(SS_STRINGS),
    accent: 0.6,
  };
}

/** Render the default patch: a C-major guitar chord (Chord CV = C) strummed
 *  twice (down-strums at 0 ms and 500 ms), the module's real strummed path. */
function renderProfile(): Record<string, Float32Array> {
  const p: SixStrumParams = { ...SIXSTRUM_DEFAULTS, chordConnected: 1 };
  const st = makeSixStrumState(SR);
  const frame = makeFrame();
  const pulse = Math.round(0.003 * SR); // 3 ms strum trigger
  const strum2 = Math.round(0.5 * SR);
  return captureOutputs({ durationS: DURATION_S, outputs: ['out'] }, (i) => {
    if (i % BLOCK === 0) prepSixStrumBlock(p, 60, SR, st); // chord root = C4
    frame.strum.fill(0);
    // Two down-strums: barre all six strum inputs.
    if (i < pulse || (i >= strum2 && i < strum2 + pulse)) frame.strum.fill(1);
    return { out: sixStrumStep(frame, p, SR, st) };
  });
}

/** Render a POLY melodic phrase: MIDI-LANE-style note-ons on three lanes at
 *  0 / 0.5 / 1.0 s stepping A3→C4→E4 (the real poly source path). */
function renderPoly(): Record<string, Float32Array> {
  const p: SixStrumParams = { ...SIXSTRUM_DEFAULTS, polyConnected: 1 };
  const st = makeSixStrumState(SR);
  const frame = makeFrame();
  // A3 = MIDI 57 → V/oct (57−60)/12 = −0.25; C4 = 0; E4 = (64−60)/12 = 0.333.
  const notesV = [-3 / 12, 0, 4 / 12];
  const onsets = [0, Math.round(0.5 * SR), Math.round(1.0 * SR)];
  const holdS = Math.round(0.4 * SR);
  return captureOutputs({ durationS: DURATION_S, outputs: ['poly'] }, (i) => {
    if (i % BLOCK === 0) prepSixStrumBlock(p, 60, SR, st);
    for (let n = 0; n < 3; n++) {
      frame.polyPitch[n] = notesV[n]!;
      frame.polyGate[n] = i >= onsets[n]! && i < onsets[n]! + holdS ? 1 : 0;
    }
    return { poly: sixStrumStep(frame, p, SR, st) };
  });
}

function rms(b: Float32Array, s = 0, e = b.length): number {
  let x = 0;
  for (let i = s; i < e; i++) x += b[i]! * b[i]!;
  return Math.sqrt(x / Math.max(1, e - s));
}

describe('ART sixstrum / audio profile (default patch, C chord strummed twice)', () => {
  it('renders a finite, audible, ringing, deterministic strum', () => {
    const { out } = renderProfile();
    const buf = out!;
    expect(buf.length).toBe(Math.round(SR * DURATION_S));
    expect(buf.every(Number.isFinite)).toBe(true);
    let peak = 0;
    for (const v of buf) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeGreaterThan(0.05);
    expect(peak).toBeLessThan(4);
    // Both strums land: energy after each down-strum.
    expect(rms(buf, 0, Math.round(0.15 * SR))).toBeGreaterThan(0.01);
    expect(rms(buf, Math.round(0.5 * SR), Math.round(0.65 * SR))).toBeGreaterThan(0.01);
    // The chord rings into the tail but decays below the fresh second strum.
    const tail = rms(buf, Math.round(1.2 * SR), Math.round(1.45 * SR));
    expect(tail).toBeGreaterThan(1e-4);
    expect(tail).toBeLessThan(rms(buf, Math.round(0.5 * SR), Math.round(0.65 * SR)));
    // Deterministic: a second render is bit-identical.
    const again = renderProfile().out!;
    let diff = 0;
    for (let i = 0; i < buf.length; i++) diff = Math.max(diff, Math.abs(buf[i]! - again[i]!));
    expect(diff).toBe(0);
  });

  it('pins the out + poly profile baselines (SHA-gated, RMS tier B)', async () => {
    const srcSha = await dspSourceSha(
      'sixstrum.ts',
      'lib/sixstrum-dsp.ts',
      'lib/sixstrum-tuning.ts',
      'lib/karplus-dsp.ts',
      'lib/analog-delay-core.ts',
      'lib/adsr-env.ts',
      'lib/dsp-utils.ts',
    );
    await pinAll('sixstrum', srcSha, { ...renderProfile(), ...renderPoly() });
  });
});

describe('ART sixstrum / poly phrase (MIDI-LANE-style A3→C4→E4)', () => {
  it('each poly note-on drives a string audibly', () => {
    const { poly } = renderPoly();
    const buf = poly!;
    expect(buf.every(Number.isFinite)).toBe(true);
    for (const at of [0, 0.5, 1.0]) {
      expect(rms(buf, Math.round(at * SR), Math.round((at + 0.1) * SR))).toBeGreaterThan(0.005);
    }
    const again = renderPoly().poly!;
    let diff = 0;
    for (let i = 0; i < buf.length; i++) diff = Math.max(diff, Math.abs(buf[i]! - again[i]!));
    expect(diff).toBe(0);
  });
});
