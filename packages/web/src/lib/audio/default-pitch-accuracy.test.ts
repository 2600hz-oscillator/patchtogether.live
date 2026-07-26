// packages/web/src/lib/audio/default-pitch-accuracy.test.ts
//
// DEFAULT-TUNING PITCH ACCURACY — the owner guarantee "default tuning always
// leads to sequence notes matching reality": at a pitched voice's DEFAULT
// params, a sequenced note must produce the correct real-world pitch
// (A440 standard: C4 ≈ 261.63 Hz) within a tight cents tolerance.
//
// This is the DETERMINISTIC unit tier of the guard family (its authoritative
// real-chain twin is e2e/tests/voice-pitch-accuracy.spec.ts, which drives the
// REAL sequencer-note → pitch-CV → module → audio-out chain in a browser).
// Here each enrolled voice renders through its PURE DSP math mirror — the
// SAME source the worklet bundles — so the measurement is byte-reproducible:
// zero flake, and a pitch-law or default-tuning drift fails the exact bound.
//
// Measurement: YIN ($lib/audio/pitch-detect — the estimator the SCOPE tuner
// ships) bracketed around the expected note (the sub-octave square of a full
// voice legitimately period-doubles an unbracketed estimator), median over
// many windows (a multi-oscillator default patch BEATS — detune/unison
// spread — so single-window reads wobble by design; the median is the honest
// center).
//
// REGISTRY: add a row to PITCHED_VOICES to enroll a voice (batch-2 pitched
// voices — dx7, sixstrum, karplus — enroll the same check when they migrate).
// Each row provides:
//   * renderDefault — the voice at FACTORY DEFAULTS, driven at V/oct 0
//     (0 V = C4, house convention) with the gate held: the shipped tuning.
//   * renderPure    — the voice with its DESIGNED detune/spread/sub character
//     zeroed: proves the V/oct → Hz core itself is exact (≪1 cent), so a
//     default-tier failure can be attributed to the DEFAULTS, not the law.
//
// Bounds: default ≤ DEFAULT_TOLERANCE_CENTS (the owner's "≤ ~5 cents" — the
// measured tidyVco default center is ≈ +4.0¢, the one-sided OSC2 detune
// default of +6¢; documented, inside spec). Pure core ≤ 1 cent.

import { describe, it, expect } from 'vitest';

import { detectPitch } from '$lib/audio/pitch-detect';
import {
  TIDY_VCO_DEFAULTS,
  makeTidyVcoState,
  renderTidyVco,
  type TidyVcoParams,
} from '../../../../dsp/src/lib/tidy-vco-dsp';

const SR = 48000;
const C4_HZ = 261.6256; // equal temperament, A4 = 440
const DEFAULT_TOLERANCE_CENTS = 5;
const PURE_TOLERANCE_CENTS = 1;

/** Render tidyVco's pure math mirror at mono V/oct `voct`, gate held. */
function renderTidy(params: TidyVcoParams, voct: number, seconds: number): Float32Array {
  const n = SR * seconds;
  const outL = new Float32Array(n);
  const outR = new Float32Array(n);
  const state = makeTidyVcoState();
  const bus = { poly: new Float32Array(10), monoPitch: voct, monoGate: 1, resCv: 0, driveCv: 0 };
  for (let i = 0; i < n; i += 128) {
    renderTidyVco(params, bus, outL, outR, i, Math.min(i + 128, n), SR, state);
  }
  // Mono downmix — what any single measurement tap (analyser) reads of the
  // stereo voice bus.
  const mono = new Float32Array(n);
  for (let i = 0; i < n; i++) mono[i] = (outL[i]! + outR[i]!) / 2;
  return mono;
}

interface PitchedVoice {
  name: string;
  /** The voice at FACTORY DEFAULTS, V/oct 0 (C4), gate held. */
  renderDefault: () => Float32Array;
  /** The voice with its designed detune/spread/sub zeroed — the bare V/oct
   *  core (must be exact to ≪1 cent). */
  renderPure: () => Float32Array;
}

/** ── THE REGISTRY — enroll every pitched voice here ─────────────────────
 *  Batch 2 (dx7 / sixstrum / karplus) add rows when their faces migrate. */
const PITCHED_VOICES: PitchedVoice[] = [
  {
    name: 'tidyVco',
    renderDefault: () => renderTidy({ ...TIDY_VCO_DEFAULTS }, 0, 3),
    renderPure: () => renderTidy({ ...TIDY_VCO_DEFAULTS, detune: 0, width: 0, sub: 0 }, 0, 3),
  },
];

/** Median measured offset (cents vs C4) over sliding YIN windows, bracketed
 *  one fifth around the expected note so the voice's own sub-octave content
 *  can't period-double the estimate. */
function medianCents(mono: Float32Array): { cents: number; windows: number } {
  const WIN = 8192;
  const cents: number[] = [];
  for (let start = SR >> 1; start + WIN <= mono.length; start += WIN >> 1) {
    const r = detectPitch(mono.subarray(start, start + WIN).slice(), SR, { minHz: 180, maxHz: 400 });
    if (r.hz != null) cents.push(1200 * Math.log2(r.hz / C4_HZ));
  }
  cents.sort((a, b) => a - b);
  return { cents: cents[cents.length >> 1] ?? Number.NaN, windows: cents.length };
}

describe('default-pitch accuracy — sequenced C4 measures as real-world C4', () => {
  for (const voice of PITCHED_VOICES) {
    it(`${voice.name}: factory defaults land within ${DEFAULT_TOLERANCE_CENTS} cents of C4`, () => {
      const { cents, windows } = medianCents(voice.renderDefault());
      expect(windows, `${voice.name}: enough voiced measurement windows`).toBeGreaterThanOrEqual(8);
      expect(
        Math.abs(cents),
        `${voice.name}: default-tuning median offset ${cents.toFixed(2)}¢ from C4 (261.63 Hz)`,
      ).toBeLessThanOrEqual(DEFAULT_TOLERANCE_CENTS);
    });

    it(`${voice.name}: the bare V/oct core is exact (≤ ${PURE_TOLERANCE_CENTS} cent)`, () => {
      const { cents, windows } = medianCents(voice.renderPure());
      expect(windows, `${voice.name}: enough voiced measurement windows`).toBeGreaterThanOrEqual(8);
      expect(
        Math.abs(cents),
        `${voice.name}: pure-core median offset ${cents.toFixed(2)}¢ from C4`,
      ).toBeLessThanOrEqual(PURE_TOLERANCE_CENTS);
    });
  }
});
