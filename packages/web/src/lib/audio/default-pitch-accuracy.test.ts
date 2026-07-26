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
// REGISTRY: add a row to PITCHED_VOICES to enroll a voice (karplus, the last
// un-migrated batch-2 pitched voice, enrolls the same check when it migrates;
// sixstrum and dx7 enrolled with their P1 batch-2 faces).
// Each row provides:
//   * renderDefault — the voice at FACTORY DEFAULTS, driven at V/oct 0
//     (0 V = C4, house convention) with the gate held: the shipped tuning.
//   * renderPure    — the voice with its DESIGNED detune/spread/sub character
//     zeroed: proves the V/oct → Hz core itself is exact (≪1 cent), so a
//     default-tier failure can be attributed to the DEFAULTS, not the law.
//
// Bounds: default ≤ DEFAULT_TOLERANCE_CENTS (the owner's "≤ ~5 cents" — the
// measured tidyVco default center is ≈ +4.0¢, the one-sided OSC2 detune
// default of +6¢; sixstrum's is ≈ −3.5¢, its SPREAD detune on the low string;
// dx7's is ≈ +0.01¢, because E.PIANO 1's three ratio-1 carriers are detuned
// SYMMETRICALLY (0 / +1.5 / −1.5¢) so the composite fundamental lands on the
// note; all documented, inside spec). Pure core ≤ 1 cent (measured: tidyVco
// +0.02¢, sixstrum −0.01¢, dx7 +0.01¢ — the karplus and FM V/oct laws are
// both exact).
//
// ONE CAVEAT, dx7 only: it is the single enrolled voice whose pure mirror is a
// SYNC PARTNER (packages/web/src/lib/audio/dx7-render.ts) rather than the
// literal module the worklet bundles — the DX7 worklet
// (packages/dsp/src/dx7.ts) is a standalone processor, not a shared core, and
// the two files are kept in lockstep by the header contract both carry. So for
// dx7 this tier pins the SPEC's tuning; the browser tier
// (e2e/tests/voice-pitch-accuracy.spec.ts) is what pins the shipped worklet,
// and dx7 is enrolled there too. Read them as a pair.

import { describe, it, expect } from 'vitest';

import { detectPitch } from '$lib/audio/pitch-detect';
import { renderDx7Note } from '$lib/audio/dx7-render';
import { findBuiltinPatch } from '$lib/audio/dx7-banks';
import { DX7_DEFAULT_PRESET } from '$lib/audio/modules/dx7';
import type { DX7Voice } from '$lib/audio/dx7-syx';
import {
  TIDY_VCO_DEFAULTS,
  makeTidyVcoState,
  renderTidyVco,
  type TidyVcoParams,
} from '../../../../dsp/src/lib/tidy-vco-dsp';
import {
  SIXSTRUM_DEFAULTS,
  SS_STRINGS,
  makeSixStrumState,
  prepSixStrumBlock,
  sixStrumStep,
  type SixStrumParams,
} from '../../../../dsp/src/lib/sixstrum-dsp';

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

/** Render SIX STRUM's pure math mirror: string 1 driven from POLY lane 0 at
 *  `voct` with its note-on gate held — the voice's REAL V/oct path (its mono
 *  CHORD input is pitch-CLASS only, so POLY is where 1 V/oct lives). One
 *  rising edge plucks the string once; the karplus loop then rings on its own
 *  RING decay, which is the pitch under test. The other five lanes stay
 *  ungated, so exactly one string sounds.
 *
 *  MEASUREMENT MAKEUP GAIN: unlike a sustained oscillator, a plucked string
 *  DECAYS (RING = 2.5 s to −60 dB), and YIN refuses any window under RMS
 *  0.001 — so a raw render goes unvoiced ~1.1 s in and yields barely the 8
 *  windows the median needs. We therefore undo the string's own decay
 *  (10^(3t/ring), the exact inverse of −60 dB per RING seconds, capped) so the
 *  estimator sees a steady level. Pure gain: it scales amplitude only and
 *  cannot move a measured frequency — it just keeps the whole tail voiced.
 *  Re-striking instead is NOT equivalent: each strike's broadband excitation
 *  transient sits inside a 170 ms YIN window and skews the reading flat. */
function renderSixStrum(params: SixStrumParams, voct: number, seconds: number): Float32Array {
  const n = SR * seconds;
  const out = new Float32Array(n);
  const state = makeSixStrumState(SR);
  const frame = {
    strum: new Float32Array(SS_STRINGS),
    mute: new Float32Array(SS_STRINGS),
    polyPitch: new Float32Array(SS_STRINGS),
    polyGate: new Float32Array(SS_STRINGS),
    accent: 0.6, // the worklet's unpatched-ACCENT default
  };
  frame.polyPitch[0] = voct;
  const p: SixStrumParams = { ...params, polyConnected: 1, chordConnected: 0 };
  for (let i = 0; i < n; i += 128) {
    prepSixStrumBlock(p, 60, SR, state);
    const end = Math.min(i + 128, n);
    for (let s = i; s < end; s++) {
      frame.polyGate[0] = s === 0 ? 0 : 1; // rising edge at s = 1 → one pluck, then held
      const makeup = Math.min(1e3, Math.pow(10, (3 * (s / SR)) / p.ring));
      out[s] = sixStrumStep(frame, p, SR, state) * makeup;
    }
  }
  return out;
}

/** Render DX7 at `voct` with the gate held, through the voice-renderer that
 *  mirrors the worklet (see the dx7 caveat in the header).
 *
 *  WHAT "FACTORY DEFAULTS" MEANS HERE. A fresh dx7 loads DX7_DEFAULT_PRESET
 *  (E.PIANO 1) with TRANSPOSE 0, and the worklet resolves a lane's note as
 *  `midi = 60 + voct·12 + transposeParam + (patch.transpose − 24)` — the SYX
 *  centre being 24. So the patch's OWN stored transpose is part of the shipped
 *  default tuning and is applied here; E.PIANO 1 stores 24, i.e. no offset, so
 *  0 V is a true C4 (BASS 1's 12 would be a deliberate octave down, which is
 *  why the offset is read off the patch rather than assumed to be zero).
 *
 *  The master ADSR is deliberately absent: its defaults are attack 0.001 s,
 *  sustain 1 — a VCA that is fully open the whole time a gate is held — so it
 *  is a no-op on a held note, and a gain envelope cannot move a frequency in
 *  any case. RELEASE (the one non-pass-through default) only acts after the
 *  gate falls, which never happens here. LEVEL is likewise pure gain.
 *
 *  `detuneScale` scales every operator's detune away from unity: 1 = the
 *  shipped patch, 0 = the bare V/oct core (the pure tier). */
function renderDx7(voct: number, seconds: number, detuneScale: number): Float32Array {
  const patch = findBuiltinPatch(DX7_DEFAULT_PRESET);
  if (!patch) throw new Error(`dx7: default preset '${DX7_DEFAULT_PRESET}' is missing from the builtin bank`);
  const voice: DX7Voice = {
    ...patch,
    operators: patch.operators.map((op) => ({
      ...op,
      detuneFactor: detuneScale === 1 ? op.detuneFactor : Math.pow(op.detuneFactor, detuneScale),
    })),
  };
  return renderDx7Note(voice, {
    // The worklet's note law, with the patch's own stored transpose folded in.
    midi: 60 + voct * 12 + (patch.transpose - 24),
    durationS: seconds,
    sampleRate: SR,
    holdGate: true,
  });
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
 *  karplus adds a row when its face migrates. */
const PITCHED_VOICES: PitchedVoice[] = [
  {
    name: 'tidyVco',
    renderDefault: () => renderTidy({ ...TIDY_VCO_DEFAULTS }, 0, 3),
    renderPure: () => renderTidy({ ...TIDY_VCO_DEFAULTS, detune: 0, width: 0, sub: 0 }, 0, 3),
  },
  {
    // SIX STRUM (P1 batch-2 face migration). Its DESIGNED per-string character
    // is SPREAD — a symmetric detune whose low-string end sits at −1 of the
    // pattern, so the default 0.25 puts string 1 at −3.5 cents (inside the
    // 5-cent bound); zeroing SPREAD leaves the bare karplus V/oct core. Two
    // seconds is plenty: RING's 2.5 s decay keeps the string voiced across the
    // whole measurement window.
    name: 'sixstrum',
    renderDefault: () => renderSixStrum({ ...SIXSTRUM_DEFAULTS }, 0, 3),
    renderPure: () => renderSixStrum({ ...SIXSTRUM_DEFAULTS, spread: 0 }, 0, 3),
  },
  {
    // DX7 (P1 batch-2 face migration). Its DESIGNED character at the default
    // preset is the three ratio-1 carriers of E.PIANO 1 being spread by the
    // patch's own operator detunes (op1 = 0¢, op3 = +1.5¢, op5 = −1.5¢) — the
    // FM Rhodes' chorusing. That spread is symmetric, so the composite
    // fundamental sits essentially ON C4; zeroing the detunes leaves the bare
    // V/oct core, which must be exact.
    name: 'dx7',
    renderDefault: () => renderDx7(0, 3, 1),
    renderPure: () => renderDx7(0, 3, 0),
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
