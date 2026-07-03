// packages/dsp/src/lib/pentemelodica-dsp.ts
//
// PENTEMELODICA — shared DSP math for the 5-voice polyphonic analog-style
// synth. Lives in `lib/` so esbuild inlines it into the worklet entry
// (packages/dsp/src/pentemelodica.ts) at build time; top-level src/*.ts files
// are the worklet entries (they must call registerProcessor) and their helpers
// go under lib/ where they may `export` freely.
//
// Everything here is PURE given its args — the caller owns the phase / envelope
// / filter state — so it is trivially unit-testable AND reusable by the web
// module's render mirror. Reuses the already-ported building blocks instead of
// re-deriving:
//
//   * Oscillator core   — moogWaves()/MOOG_C4_HZ from ./moog-vco-dsp (a
//     clean-room polyBLEP band-limited oscillator emitting sine/triangle/
//     sawtooth/rectangular off ONE shared phase). The WAVE morph crossfades
//     the band-limited taps so the morph is anti-aliased for free.
//   * Filter core       — svfStep()/cutoffToG()/resToK()/makeSvfState() from
//     ./resofilter-dsp (a Cytomic/Zavalishin TPT state-variable filter). The
//     MODE morph blends its {lp,bp,hp} taps (+ notch = x - bp) into a
//     continuous LP→BP→HP→Notch dial. No QBRT-style ping / edge gate.
//   * Envelope          — a verbatim copy of the Helm synth's Envelope (linear attack,
//     single-pole-exp decay/release, seconds-based, gate-edge triggered).
//
// The full per-render pipeline is:
//
//   poly lane i (pitch V/oct + gate)
//     → per-voice VCO (tune/fine/exp-FM + phase-mod off the fmN jack)
//     → WAVE morph (tri→saw→square)
//     → per-voice envelope, gated by lane i's edge, reading the ONE SHARED
//       device A/D/S/R (gate edge → Attack / Release)    ── tapped pre-mixer
//     → mixer (level + equal-power pan)  → stereo bus L/R
//     → embedded multimode filter (cutoff/resonance/MODE) with wet/dry
//     → stereo out L/R
//
// SHARED A/D/S/R (poly-adsr alignment): every voice has its OWN Envelope +
// gate edge, but they ALL read ONE device-level attack/decay/sustain/release
// (PenteParams.adsr) — matching CUBE / WAVECEL / DX7. (Previously each voice
// carried its own a/d/s/r in PenteVoiceParams — 20 params; now 4 shared.)
//
// HELD PITCH THROUGH RELEASE (release-tail pitch fix, #669 pattern): the poly
// bus zeroes a released lane's pitch channel, so a voice still RINGING in its
// release tail (gate low, env > 0) used to read 0 V/oct = C4 and snap to that
// constant pitch. Each voice now keeps a PERSISTENT held V/oct — updated only
// while gated, HELD through release — via updateHeldPitch / laneRenderVOct
// (lib/poly-osc-sum.ts), so the tail rings at the played note's pitch.
//
// Both the worklet inner loop AND the web module's render mirror call the same
// helpers below, so the audio is defined in exactly one place.

import { moogWaves, MOOG_C4_HZ, type MoogWaveSet } from './moog-vco-dsp';
import {
  svfStep,
  cutoffToG,
  resToK,
  makeSvfState,
  type SvfState,
} from './resofilter-dsp';
import {
  updateHeldPitch,
  laneRenderVOct,
  type AdsrParams,
} from './poly-osc-sum';

export type { AdsrParams };

export const PENTE_VOICES = 5;

// ----------------------------------------------------------------------------
// Envelope — copied verbatim from the Helm synth (mopo/envelope.cpp
// algorithm port): linear attack ramp, single-pole exponential decay/release,
// times in SECONDS, sustain 0..1, gate edge via trigger(on).
// ----------------------------------------------------------------------------

export enum EnvState {
  Idle = 0,
  Attack = 1,
  Decay = 2,
  Sustain = 3,
  Release = 4,
}

export class Envelope {
  state: EnvState = EnvState.Idle;
  value = 0;
  /** Gate trigger: rising edge → Attack; falling edge → Release. */
  trigger(on: boolean): void {
    if (on) {
      this.state = EnvState.Attack;
      this.value = 0;
    } else if (this.state !== EnvState.Idle) {
      this.state = EnvState.Release;
    }
  }
  /** Advance one sample. attack/decay/release are in SECONDS, sustain 0..1. */
  tick(attack: number, decay: number, sustain: number, release: number, sr: number): number {
    if (this.state === EnvState.Attack) {
      const a = Math.max(1e-6, attack);
      const inc = 1 / (sr * a);
      this.value += inc;
      if (this.value >= 0.999) {
        this.value = 1.0;
        this.state = EnvState.Decay;
      }
    } else if (this.state === EnvState.Decay) {
      const d = Math.max(1e-6, decay);
      const susTarget = Math.max(0, Math.min(1, sustain));
      const coef = Math.exp(-1 / (sr * d));
      this.value = susTarget + (this.value - susTarget) * coef;
      if (Math.abs(this.value - susTarget) < 1e-4) {
        this.value = susTarget;
        this.state = EnvState.Sustain;
      }
    } else if (this.state === EnvState.Sustain) {
      this.value = Math.max(0, Math.min(1, sustain));
    } else if (this.state === EnvState.Release) {
      const r = Math.max(1e-6, release);
      const coef = Math.exp(-1 / (sr * r));
      this.value *= coef;
      if (this.value < 1e-5) {
        this.value = 0;
        this.state = EnvState.Idle;
      }
    }
    return this.value;
  }
}

// ----------------------------------------------------------------------------
// Per-voice frequency map. Mirrors moogFreqHz's exponential V/oct math but
// folds in fine cents + exponential FM (the fmN audio input scaled by the FM
// depth) directly in the exponent. 0 V = C4 = 261.626 Hz everywhere.
// ----------------------------------------------------------------------------

/** V/oct + coarse semitones + fine cents + exponential FM → Hz, clamped to a
 *  safe sub-Nyquist span. `fmExp` is the exponential-domain FM term already
 *  multiplied by the FM depth × modulator sample (it shifts the exponent in
 *  octaves, like 1V/oct). */
export function voiceFreqHz(
  voct: number,
  tuneSemis: number,
  fineCents: number,
  fmExp: number,
  sr: number,
): number {
  let f = MOOG_C4_HZ * Math.pow(2, voct + tuneSemis / 12 + fineCents / 1200 + fmExp);
  const hi = Math.min(40000, sr * 0.49);
  if (f < 0.01) f = 0.01;
  else if (f > hi) f = hi;
  return f;
}

// ----------------------------------------------------------------------------
// WAVE morph — continuous triangle → saw → square crossfade over the
// band-limited taps from moogWaves (so the morph stays anti-aliased).
//   wave = 0.0 → triangle
//   wave = 0.5 → sawtooth
//   wave = 1.0 → square (rectangular at the voice's pulse width)
// ----------------------------------------------------------------------------

export function waveMorph(waves: MoogWaveSet, wave: number): number {
  const w = wave < 0 ? 0 : wave > 1 ? 1 : wave;
  const tri = waves.triangle;
  const saw = waves.sawtooth;
  const sqr = waves.rectangular;
  if (w < 0.5) {
    const t = 2 * w;
    return tri * (1 - t) + saw * t;
  }
  const t = 2 * w - 1;
  return saw * (1 - t) + sqr * t;
}

// ----------------------------------------------------------------------------
// MODE morph — continuous LP → BP → HP → Notch dial over the SVF taps.
//   notch = x - bp  (the SVF identity)
//   mode = 0.000 → LP
//   mode = 1/3    → BP
//   mode = 2/3    → HP
//   mode = 1.000  → Notch
// `x` is the filter INPUT sample (needed for the notch tap).
// ----------------------------------------------------------------------------

export function modeMorph(
  taps: { lp: number; bp: number; hp: number },
  x: number,
  mode: number,
): number {
  const m = mode < 0 ? 0 : mode > 1 ? 1 : mode;
  const m3 = m * 3;
  const seg = Math.min(2, Math.floor(m3));
  const t = m3 - seg;
  const notch = x - taps.bp;
  if (seg === 0) return taps.lp * (1 - t) + taps.bp * t;
  if (seg === 1) return taps.bp * (1 - t) + taps.hp * t;
  return taps.hp * (1 - t) + notch * t;
}

// ----------------------------------------------------------------------------
// Render — the shared inner loop. Used by both the worklet and the web/ART/unit
// mirror. State is held by the caller in a PenteState so successive blocks /
// successive render() calls stay phase- and envelope-coherent.
// ----------------------------------------------------------------------------

/** Per-voice parameter set for one render. The amplitude envelope's A/D/S/R is
 *  NOT per-voice — it lives in the shared PenteParams.adsr (poly-adsr alignment
 *  with CUBE / WAVECEL / DX7). Only the OSC + level/pan are per-voice. */
export interface PenteVoiceParams {
  tune: number;     // coarse semitones
  fine: number;     // cents
  fm: number;       // exponential-FM depth (bipolar), × the fmN input
  pm: number;       // phase-mod index (bipolar), × the fmN input
  pw: number;       // pulse width for the rectangular tap
  wave: number;     // tri→saw→square morph 0..1
  level: number;    // 0..1 mixer level
  pan: number;      // -1..1 equal-power pan
}

export interface PenteFilterParams {
  cutoff: number;     // Hz
  resonance: number;  // 0..0.99
  mode: number;       // LP→BP→HP→Notch morph 0..1
  wetdry: number;     // 0 = dry bypass, 1 = full wet
}

export interface PenteParams {
  voices: PenteVoiceParams[]; // length PENTE_VOICES
  /** ONE shared amplitude A/D/S/R fed identically into every voice envelope
   *  (poly-adsr alignment with CUBE / WAVECEL / DX7). */
  adsr: AdsrParams;
  filter: PenteFilterParams;
}

/** Mutable per-instance state — five phase accumulators, five envelopes, five
 *  gate-edge latches, five PERSISTENT held V/octs (the release-tail pitch fix),
 *  and one SVF state per stereo channel. */
export interface PenteState {
  phase: Float64Array;       // [PENTE_VOICES]
  env: Envelope[];           // [PENTE_VOICES]
  prevGate: Uint8Array;      // [PENTE_VOICES]
  // PERSISTENT per-lane held V/oct — UPDATED while a lane is gated, HELD (never
  // reset) when it isn't, so a releasing voice (gate low, env > 0) keeps
  // advancing at the played pitch instead of snapping to 0 V/oct (C4). See
  // updateHeldPitch / laneRenderVOct in ./poly-osc-sum.
  heldVOct: Float64Array;    // [PENTE_VOICES]
  svfL: SvfState;
  svfR: SvfState;
}

export function makePenteState(): PenteState {
  const env: Envelope[] = [];
  for (let i = 0; i < PENTE_VOICES; i++) env.push(new Envelope());
  return {
    phase: new Float64Array(PENTE_VOICES),
    env,
    prevGate: new Uint8Array(PENTE_VOICES),
    heldVOct: new Float64Array(PENTE_VOICES),
    svfL: makeSvfState(),
    svfR: makeSvfState(),
  };
}

/** Fixed master gain on the summed stereo bus. A constant (not 1/sqrt(active))
 *  keeps the render note-count-independent for deterministic baselines. */
export const PENTE_MASTER_GAIN = 0.6;

/** Output buffers for one render: stereo L/R plus a pre-mixer mono tap per
 *  voice (post-ADSR, before level/pan). */
export interface PenteRenderOut {
  outL: Float32Array;
  outR: Float32Array;
  voices: Float32Array[]; // [PENTE_VOICES]
}

export function makeRenderOut(n: number): PenteRenderOut {
  const voices: Float32Array[] = [];
  for (let i = 0; i < PENTE_VOICES; i++) voices.push(new Float32Array(n));
  return { outL: new Float32Array(n), outR: new Float32Array(n), voices };
}

/**
 * Render `numFrames` samples.
 *
 * @param params        per-voice OSC/mix params + the ONE shared A/D/S/R +
 *                      filter params (read once per call; the worklet calls
 *                      this once per 128-frame block at k-rate).
 * @param polyPitchGate length-2*PENTE_VOICES; [pitchV0, gate0, pitchV1, …].
 *                      gate > 0.5 = on. Lane i → voice i (fixed mapping).
 * @param fmInputs      length PENTE_VOICES; per-voice FM/PM modulator value
 *                      (the fmN audio jack). Pass a constant when no per-sample
 *                      array is available (mirror/ART path).
 * @param fmInputArrs   optional per-sample arrays for audio-rate FM (the
 *                      worklet path passes these); when present they override
 *                      fmInputs per sample.
 */
export function renderPentemelodica(
  params: PenteParams,
  polyPitchGate: ArrayLike<number>,
  fmInputs: ArrayLike<number>,
  numFrames: number,
  sr: number,
  state: PenteState,
  out: PenteRenderOut,
  fmInputArrs?: (Float32Array | undefined)[],
): void {
  const f = params.filter;
  const a = params.adsr; // ONE shared A/D/S/R for every voice envelope.
  const g = cutoffToG(f.cutoff, sr);
  const k = resToK(f.resonance);
  const wetdry = f.wetdry < 0 ? 0 : f.wetdry > 1 ? 1 : f.wetdry;

  // Gate edge detection — once per render (block boundary). MIDI/sequencers
  // write param/gate changes at block boundaries, so the first-sample read is
  // exact. Also update each lane's PERSISTENT held V/oct: track the live pitch
  // while gated, HOLD it through release (the release-tail pitch fix).
  for (let v = 0; v < PENTE_VOICES; v++) {
    const gated = (polyPitchGate[v * 2 + 1] ?? 0) > 0.5;
    const gateNow = gated ? 1 : 0;
    if (gateNow && !state.prevGate[v]) state.env[v]!.trigger(true);
    else if (!gateNow && state.prevGate[v]) state.env[v]!.trigger(false);
    state.prevGate[v] = gateNow as number;
    const lanePitch = polyPitchGate[v * 2] ?? 0;
    state.heldVOct[v] = updateHeldPitch(state.heldVOct[v]!, gated, lanePitch);
  }

  for (let i = 0; i < numFrames; i++) {
    let sumL = 0;
    let sumR = 0;

    for (let v = 0; v < PENTE_VOICES; v++) {
      const vp = params.voices[v]!;
      // Pitch the voice should advance at: its OWN held pitch while gated OR
      // still env-audible (releasing tail → played pitch, not 0 V/oct = C4);
      // lane-0's held pitch when silent so a re-open doesn't pop.
      const gated = state.prevGate[v] === 1;
      const voct = laneRenderVOct(
        state.heldVOct, v, gated, state.env[v]!.value > 0,
      );

      // Per-voice FM/PM modulator sample (shared jack drives both).
      const arr = fmInputArrs ? fmInputArrs[v] : undefined;
      const fmIn = arr ? (arr[i] ?? 0) : (fmInputs[v] ?? 0);

      // Frequency: V/oct + coarse + fine + exponential FM (depth × jack).
      const freq = voiceFreqHz(voct, vp.tune, vp.fine, vp.fm * fmIn, sr);
      const dt = freq / sr;

      // Phase-mod injects into the phase READ (does not advance the
      // accumulator): ±pm × jack ≈ ±pm cycles.
      let pPhase = state.phase[v]! + vp.pm * fmIn;
      pPhase -= Math.floor(pPhase);

      const waves = moogWaves(pPhase, dt, vp.pw);
      const osc = waveMorph(waves, vp.wave);

      // Advance the accumulator ALWAYS (even when gated off → no pop on
      // re-open).
      let ph = state.phase[v]! + dt;
      ph -= Math.floor(ph);
      state.phase[v] = ph;

      const e = state.env[v]!.tick(a.attack, a.decay, a.sustain, a.release, sr);
      const voiceSample = osc * e;

      // Pre-mixer mono tap (before level/pan).
      out.voices[v]![i] = voiceSample;

      // Equal-power pan: -1 → hard L, 0 → -3 dB center, +1 → hard R.
      const pan = vp.pan < -1 ? -1 : vp.pan > 1 ? 1 : vp.pan;
      const theta = (pan + 1) * (Math.PI / 4);
      const gMix = voiceSample * vp.level;
      sumL += gMix * Math.cos(theta);
      sumR += gMix * Math.sin(theta);
    }

    sumL *= PENTE_MASTER_GAIN;
    sumR *= PENTE_MASTER_GAIN;

    // Embedded filter + wet/dry per channel (state advances even at wetdry=0).
    const tapsL = svfStep(sumL, g, k, state.svfL);
    const wetL = modeMorph(tapsL, sumL, f.mode);
    out.outL[i] = (1 - wetdry) * sumL + wetdry * wetL;

    const tapsR = svfStep(sumR, g, k, state.svfR);
    const wetR = modeMorph(tapsR, sumR, f.mode);
    out.outR[i] = (1 - wetdry) * sumR + wetdry * wetR;
  }
}
