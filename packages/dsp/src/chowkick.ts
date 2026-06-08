// packages/dsp/src/chowkick.ts
//
// CHOWKICK — synth-kick AudioWorkletProcessor.
//
// Hand-port of ChowKick (https://github.com/Chowdhury-DSP/ChowKick,
// BSD-3-Clause) by Jatin Chowdhury / chowdsp. Per-sample DSP math lives
// in ./lib/chowkick-dsp.ts; this file is the worklet wrapper that owns the
// I/O surface and parameter-smoother lifecycle.
//
// IMPORTANT: this file does NOT `export` anything at the top level —
// top-level exports leak into the bundled dist/<name>.js + break the ART
// classic-script eval. The Processor class is registered via the
// `registerProcessor` side-effect. Tests capture the class through a
// registerProcessor shim before importing this module. (memory:
// dsp-worklet-no-top-level-export)
//
// Inputs (audio-rate node connections):
//   inputs[0] = gate_in (rising edge fires a kick)
//   inputs[1] = pitch_cv (1V/oct; freq target *= 2^pitch_cv)
//
// AudioParams (CV is summed in by the web factory as a-rate signals):
//   width, amplitude, decay, sustain, noise_amount, noise_decay,
//   noise_cutoff, noise_type, freq, q, damping, tight, bounce, tone,
//   portamento, level, link
//
// Output: outputs[0] = audio_out (mono).

import {
  type NoiseType,
  type PulseState,
  type NoiseState,
  type ResonantState,
  type OutputState,
  type PitchEnvState,
  type DcBlockState,
  makePulseState,
  makeNoiseState,
  makeResonantState,
  makeOutputState,
  makePitchEnvState,
  makeDcBlockState,
  pulseShaperStep,
  noiseBurstStep,
  resonantCoefs,
  resonantFilterStep,
  outputFilterStep,
  pitchEnvStep,
  dcBlockStep,
  bodyDriveStep,
  portamentoCoeff,
  portamentoStep,
  clamp,
} from './lib/chowkick-dsp';

// WtParamSmoother lives in wavetable-osc.ts as a small reusable 80-Hz
// one-pole knob smoother. Lifted here per PR #435's wavecel pattern so
// per-sample param sums (CV) reach the DSP without zipper noise when the
// user drags a knob.
import { WtParamSmoother } from './lib/wavetable-osc';

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  port: MessagePort;
  constructor(options?: { processorOptions?: unknown });
  process?(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}
declare function registerProcessor(
  name: string,
  ctor: typeof AudioWorkletProcessor,
): void;

// Shim worklet globals when running outside AudioWorkletGlobalScope (vitest
// captures the class via this shim — see chowkick.test.ts loader pattern,
// matching sidecar.test.ts).
const G = globalThis as unknown as {
  AudioWorkletProcessor?: unknown;
  registerProcessor?: unknown;
};
if (typeof G.AudioWorkletProcessor === 'undefined') {
  G.AudioWorkletProcessor = class {};
}
if (typeof G.registerProcessor === 'undefined') {
  G.registerProcessor = () => {};
}

// Not `export`ed at the top level by design — see the file-header note.
class ChowkickProcessor extends AudioWorkletProcessor {
  private sr: number;

  // Per-voice DSP state — single mono voice (gate-triggered).
  private pulseSt: PulseState;
  private noiseSt: NoiseState;
  private resSt: ResonantState;
  private outSt: OutputState;
  private pitchEnvSt: PitchEnvState;
  private dcSt: DcBlockState;

  // Persistent gate edge-detect for the noise burst (mirrors the pulse
  // shaper's own edge detect — both look at the same gate input but the
  // noise envelope retriggers on its own).
  private noiseGatePrev = { v: false };

  // Portamento smoother state (last-sample target freq in Hz).
  private freqSmoothed = 80;

  // Knob smoothers — 80 Hz one-pole on the slowly-changing params keeps
  // CV-zipper out of the audio path on knob drags. Per PR #435, the gate
  // + pitch path stays *unsmoothed* so trigger timing is sample-accurate.
  private smWidth: WtParamSmoother;
  private smAmp: WtParamSmoother;
  private smDecay: WtParamSmoother;
  private smSustain: WtParamSmoother;
  private smNoiseAmt: WtParamSmoother;
  private smNoiseDec: WtParamSmoother;
  private smNoiseCut: WtParamSmoother;
  private smFreq: WtParamSmoother;
  private smQ: WtParamSmoother;
  private smDamping: WtParamSmoother;
  private smTight: WtParamSmoother;
  private smBounce: WtParamSmoother;
  private smTone: WtParamSmoother;
  private smLevel: WtParamSmoother;
  private smPitchAmt: WtParamSmoother;
  private smPitchDec: WtParamSmoother;
  private smDrive: WtParamSmoother;

  constructor(options?: { processorOptions?: unknown }) {
    super(options);
    this.sr = sampleRate;
    this.pulseSt = makePulseState();
    this.noiseSt = makeNoiseState();
    this.resSt = makeResonantState();
    this.outSt = makeOutputState();
    this.pitchEnvSt = makePitchEnvState();
    this.dcSt = makeDcBlockState();
    this.smWidth = new WtParamSmoother(this.sr);
    this.smAmp = new WtParamSmoother(this.sr);
    this.smDecay = new WtParamSmoother(this.sr);
    this.smSustain = new WtParamSmoother(this.sr);
    this.smNoiseAmt = new WtParamSmoother(this.sr);
    this.smNoiseDec = new WtParamSmoother(this.sr);
    this.smNoiseCut = new WtParamSmoother(this.sr);
    this.smFreq = new WtParamSmoother(this.sr);
    this.smQ = new WtParamSmoother(this.sr);
    this.smDamping = new WtParamSmoother(this.sr);
    this.smTight = new WtParamSmoother(this.sr);
    this.smBounce = new WtParamSmoother(this.sr);
    this.smTone = new WtParamSmoother(this.sr);
    this.smLevel = new WtParamSmoother(this.sr);
    this.smPitchAmt = new WtParamSmoother(this.sr);
    this.smPitchDec = new WtParamSmoother(this.sr);
    this.smDrive = new WtParamSmoother(this.sr);
    // Prime smoothers to the defaults so first-sample reads aren't a ramp.
    // (Must match parameterDescriptors' defaultValue for each param.)
    this.smWidth.prime(0.5);
    this.smAmp.prime(1);
    this.smDecay.prime(0.3);
    this.smSustain.prime(0);
    this.smNoiseAmt.prime(0.5);
    this.smNoiseDec.prime(0.07);
    this.smNoiseCut.prime(5500);
    this.smFreq.prime(80);
    this.smQ.prime(1.6);
    this.smDamping.prime(0.4);
    this.smTight.prime(0.6);
    this.smBounce.prime(0);
    this.smTone.prime(3200);
    this.smLevel.prime(0);
    this.smPitchAmt.prime(0.9);
    this.smPitchDec.prime(0.28);
    this.smDrive.prime(0.5);
    this.freqSmoothed = 80;
  }

  static get parameterDescriptors() {
    return [
      // a-rate so CV reaches the DSP per-sample.
      // PUNCH DEFAULTS (PR feat/chowkick-oomph, tuning pass 2): the first fix
      // made a real pitched ~80 Hz kick but the defaults were too polite. This
      // pass leans into perceptual PUNCH — a loud bright SNAP (noise 0.5 @
      // 5.5 kHz, ~1.5 ms), a deep FAST chirp (pitch_amount 0.9, decay 0.28 ≈
      // 8 ms, start mult 4×), a sharper body (q 1.6) and hotter drive (0.5).
      // Measured vs the previous defaults on the stock patch: attack slope
      // +73 %, 0–10 ms click energy +33 %, sub (<120 Hz) energy +56 %, pitch-
      // drop ratio 2.0×→2.7×, 0–2 ms transient peak +32 %. Still bipolar +
      // pitched (DC≈0, 25 zero-crossings 5–150 ms, settles at ~78 Hz).
      { name: 'width',         defaultValue: 0.5,  minValue: 0.1, maxValue: 50,   automationRate: 'a-rate' as const },
      { name: 'amplitude',     defaultValue: 1,    minValue: 0,   maxValue: 2,    automationRate: 'a-rate' as const },
      { name: 'decay',         defaultValue: 0.3,  minValue: 0,   maxValue: 1,    automationRate: 'a-rate' as const },
      { name: 'sustain',       defaultValue: 0,    minValue: 0,   maxValue: 1,    automationRate: 'a-rate' as const },
      // Transient click LOUD + bright by default — the #1 thing the ear reads
      // as "punch". noise_cutoff range pushed to 8 kHz so the user can dial an
      // even brighter snap.
      { name: 'noise_amount',  defaultValue: 0.5,  minValue: 0,   maxValue: 1,    automationRate: 'a-rate' as const },
      { name: 'noise_decay',   defaultValue: 0.07, minValue: 0,   maxValue: 1,    automationRate: 'a-rate' as const },
      { name: 'noise_cutoff',  defaultValue: 5500, minValue: 20,  maxValue: 8000, automationRate: 'a-rate' as const },
      // discrete; 0..3 = Uniform/Gaussian/Pink/Velvet. k-rate (won't smooth).
      { name: 'noise_type',    defaultValue: 0,    minValue: 0,   maxValue: 3,    automationRate: 'k-rate' as const },
      { name: 'freq',          defaultValue: 80,   minValue: 20,  maxValue: 500,  automationRate: 'a-rate' as const },
      // Sharper body resonance (1.6) → the body responds harder + faster per
      // ping (more punch). Range up to 10 for a near-sine boom when wanted.
      { name: 'q',             defaultValue: 1.6,  minValue: 0.1, maxValue: 10,   automationRate: 'a-rate' as const },
      // damping now controls RING TIME (0 = long boom … 1 = short thud); 0.4
      // gives a punchy, medium-length tail.
      { name: 'damping',       defaultValue: 0.4,  minValue: 0,   maxValue: 1,    automationRate: 'a-rate' as const },
      { name: 'tight',         defaultValue: 0.6,  minValue: 0,   maxValue: 1,    automationRate: 'a-rate' as const },
      { name: 'bounce',        defaultValue: 0,    minValue: 0,   maxValue: 1,    automationRate: 'a-rate' as const },
      // Higher tone LPF default (3.2 kHz) so the bright transient click
      // survives; range up to 4 kHz to push the snap even further.
      { name: 'tone',          defaultValue: 3200, minValue: 50,  maxValue: 4000, automationRate: 'a-rate' as const },
      { name: 'portamento',    defaultValue: 0.5,  minValue: 0,   maxValue: 100,  automationRate: 'k-rate' as const },
      { name: 'level',         defaultValue: 0,    minValue: -60, maxValue: 0,    automationRate: 'a-rate' as const },
      // 0 = off, 1 = on. LINK couples Q + Damping (per upstream: when LINK
      // is on, dragging Q also nudges damping so the body+ring stay glued).
      // Currently k-rate; we apply the coupling per-block in process().
      { name: 'link',          defaultValue: 0,    minValue: 0,   maxValue: 1,    automationRate: 'k-rate' as const },
      // PUNCH params. pitch_amount = depth of the per-trigger downward pitch
      // sweep (THE punch — the kick "chirp"); pitch_decay = how fast it snaps
      // down; drive = body waveshaper drive for small-speaker translation +
      // extra weight. Defaults leaned hot (0.9 / 0.28 / 0.5); the full 0..1
      // range lets the user push to a deeper/faster chirp + harder drive, or
      // dial back toward a gentle thump.
      { name: 'pitch_amount',  defaultValue: 0.9,  minValue: 0,   maxValue: 1,    automationRate: 'a-rate' as const },
      { name: 'pitch_decay',   defaultValue: 0.28, minValue: 0,   maxValue: 1,    automationRate: 'a-rate' as const },
      { name: 'drive',         defaultValue: 0.5,  minValue: 0,   maxValue: 1,    automationRate: 'a-rate' as const },
    ];
  }

  private aval(p: Record<string, Float32Array>, name: string, s: number, fallback: number): number {
    const arr = p[name];
    if (!arr || arr.length === 0) return fallback;
    return (arr.length > 1 ? arr[s] : arr[0]) as number;
  }
  private kval(p: Record<string, Float32Array>, name: string, fallback: number): number {
    const arr = p[name];
    return arr && arr.length > 0 ? (arr[0] as number) : fallback;
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const inGate = inputs[0]?.[0];
    const inPitch = inputs[1]?.[0];
    const out = outputs[0]?.[0];
    if (!out) return true;
    const n = out.length;

    // Block-constant knobs (k-rate or smoothed-per-sample).
    const noiseType = (clamp(Math.round(this.kval(parameters, 'noise_type', 0)), 0, 3)) as NoiseType;
    const portamento_ms = this.kval(parameters, 'portamento', 0.5);
    const portAlpha = portamentoCoeff(portamento_ms, this.sr);
    const linkOn = this.kval(parameters, 'link', 0) >= 0.5;

    for (let s = 0; s < n; s++) {
      // Per-sample params (CV-summed + smoothed at 80 Hz).
      const widthRaw   = this.aval(parameters, 'width', s, 0.5);
      const ampRaw     = this.aval(parameters, 'amplitude', s, 1);
      const decayRaw   = clamp(this.aval(parameters, 'decay', s, 0.3), 0, 1);
      const sustainRaw = clamp(this.aval(parameters, 'sustain', s, 0), 0, 1);
      const nAmtRaw    = clamp(this.aval(parameters, 'noise_amount', s, 0.5), 0, 1);
      const nDecRaw    = clamp(this.aval(parameters, 'noise_decay', s, 0.07), 0, 1);
      const nCutRaw    = clamp(this.aval(parameters, 'noise_cutoff', s, 5500), 20, 8000);
      const freqRaw    = clamp(this.aval(parameters, 'freq', s, 80), 20, 500);
      const qRaw       = clamp(this.aval(parameters, 'q', s, 1.6), 0.1, 10);
      const dampRaw    = clamp(this.aval(parameters, 'damping', s, 0.4), 0, 1);
      const tightRaw   = clamp(this.aval(parameters, 'tight', s, 0.6), 0, 1);
      const bounceRaw  = clamp(this.aval(parameters, 'bounce', s, 0), 0, 1);
      const toneRaw    = clamp(this.aval(parameters, 'tone', s, 3200), 50, 4000);
      const levelRaw   = clamp(this.aval(parameters, 'level', s, 0), -60, 0);
      const pAmtRaw    = clamp(this.aval(parameters, 'pitch_amount', s, 0.9), 0, 1);
      const pDecRaw    = clamp(this.aval(parameters, 'pitch_decay', s, 0.28), 0, 1);
      const driveRaw   = clamp(this.aval(parameters, 'drive', s, 0.5), 0, 1);

      const width   = this.smWidth.step(widthRaw);
      const amp     = this.smAmp.step(ampRaw);
      const decay   = this.smDecay.step(decayRaw);
      const sustain = this.smSustain.step(sustainRaw);
      const nAmt    = this.smNoiseAmt.step(nAmtRaw);
      const nDec    = this.smNoiseDec.step(nDecRaw);
      const nCut    = this.smNoiseCut.step(nCutRaw);
      const freqK   = this.smFreq.step(freqRaw);
      let q         = this.smQ.step(qRaw);
      let damping   = this.smDamping.step(dampRaw);
      const tight   = this.smTight.step(tightRaw);
      const bounce  = this.smBounce.step(bounceRaw);
      const tone    = this.smTone.step(toneRaw);
      const level   = this.smLevel.step(levelRaw);
      const pAmt    = this.smPitchAmt.step(pAmtRaw);
      const pDec    = this.smPitchDec.step(pDecRaw);
      const driveAmt = this.smDrive.step(driveRaw);

      // LINK: couple Q ↔ damping per upstream. We use a midpoint blend so
      // either knob effectively drives both — keeps the "tightness" feel.
      if (linkOn) {
        const m = 0.5 * (q / 10 + damping); // normalize q to 0..1 then mean.
        q = clamp(m * 10, 0.1, 10);
        damping = clamp(m, 0, 1);
      }

      // Pitch CV (1V/oct).
      const pitchCv = inPitch ? (inPitch[s] ?? 0) : 0;
      const freqTarget = clamp(freqK * Math.pow(2, pitchCv), 20, 0.45 * this.sr);
      this.freqSmoothed = portAlpha >= 1
        ? freqTarget
        : portamentoStep(freqTarget, this.freqSmoothed, portAlpha);

      const gate = inGate ? (inGate[s] ?? 0) : 0;

      // Per-trigger PITCH ENVELOPE (THE punch): sweep the body freq down from
      // pitchStartMult× the (portamento+CV-)smoothed target to the target,
      // retriggered on the gate rising edge. Applied as a multiplier so V/oct
      // + portamento still set where the sweep lands.
      const bodyFreq = pitchEnvStep(gate, this.freqSmoothed, pAmt, pDec, this.sr, this.pitchEnvSt);

      // Pulse shaper → noise burst → sum → resonant body → drive → DC block →
      // output filter.
      const pulse = pulseShaperStep(gate, width, amp, decay, sustain, this.sr, this.pulseSt);
      const noise = noiseBurstStep(gate, nAmt, nDec, nCut, noiseType, this.sr, this.noiseSt, this.noiseGatePrev);
      const excitation = pulse + noise;

      const coefs = resonantCoefs(bodyFreq, q, damping, tight, bounce, this.sr);
      let body = resonantFilterStep(excitation, coefs, this.resSt);
      // Body drive (extra weight + small-speaker harmonics), gated by `tight`.
      body = bodyDriveStep(body, driveAmt, tight);
      // Per-module DC blocker so we don't rely on audio-out's 5 Hz system HPF.
      body = dcBlockStep(body, this.dcSt, 25, this.sr);

      out[s] = outputFilterStep(body, tone, level, this.sr, this.outSt);
    }

    return true;
  }
}

registerProcessor('chowkick', ChowkickProcessor);
