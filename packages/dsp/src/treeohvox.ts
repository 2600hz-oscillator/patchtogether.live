// packages/dsp/src/treeohvox.ts
//
// TREE.oh.VOX — TB-303-style bassline voice. AudioWorkletProcessor wrapper
// around the pure-DSP voice in ./lib/treeohvox-dsp.ts. All the maths
// (filter, envelopes, oscillator, env-mod mapping) live there; this file
// is exclusively about glueing AudioParams + audio-rate CV inputs onto the
// voice, with per-sample WtParamSmoother on each knob path for click-free
// knob drags (per PR #435).
//
// Algorithmic source: Robin Schmidt's Open303 (MIT,
// https://github.com/RobinSchmidt/Open303). The TB-303 filter mode is the
// `TB_303` enum value in rosic::TeeBeeFilter; the diode-feedback ladder +
// envMod scaler/offset math is replicated 1:1 in treeohvox-dsp.ts. See
// that file's header for the per-class citation map.
//
// IMPORTANT: this file does NOT `export` anything at the top level — top-
// level exports leak into the bundled dist/<name>.js + break the ART
// classic-script eval. The Processor class is registered via the
// `registerProcessor` side-effect. Tests that need the class capture it
// through a registerProcessor shim.
//
// Inputs (10 audio-rate node connections):
//   inputs[0] = pitch_cv      (1V/oct)
//   inputs[1] = gate_in       (0/1; rising edge triggers the envelope)
//   inputs[2] = accent_in     (0/1; high at the gate edge flags accent)
//   inputs[3] = tune_cv       (volts, summed into TUNE knob in semitones)
//   inputs[4] = cutoff_cv     (CV, summed into CUTOFF AudioParam)
//   inputs[5] = resonance_cv  (CV, summed into RESONANCE AudioParam)
//   inputs[6] = env_cv        (CV, summed into ENVELOPE AudioParam)
//   inputs[7] = decay_cv      (CV, summed into DECAY AudioParam)
//   inputs[8] = accent_cv     (CV, summed into ACCENT AudioParam)
//
//   (The web factory wires cutoff_cv etc through AudioParams using the
//   same .connect(workletNode, 0, n) trick the rest of the rack uses; the
//   actual port slots above are just the input array indices the worklet
//   reads from for the audio-rate signals pitch / gate / accent. Knob
//   CVs ride on AudioParams.)
//
// Outputs (1, mono):
//   outputs[0][0] = audio_out
//
// CV summing: knob CV (cutoff_cv etc) is summed into the AudioParam by
// Web Audio's native param-CV connection, then this worklet reads the
// resulting per-sample value and feeds it through a WtParamSmoother at
// 80 Hz (~2 ms time constant). Pitch / gate / accent are NOT smoothed —
// pitch needs to snap on the gate edge so the envelope resets land at
// the same sample as the new fundamental.

import {
  TreeohvoxVoice,
  type VoiceParams,
} from './lib/treeohvox-dsp';
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
declare function registerProcessor(name: string, ctor: typeof AudioWorkletProcessor): void;

// Shim worklet globals for vitest. The worklet entry-point file itself is
// classic-script-evaled by the AudioWorkletGlobalScope; in node/vitest we
// fake the symbols so importing the module doesn't throw, then capture the
// Processor class via a registerProcessor shim in the test loader.
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
class TreeohvoxProcessor extends AudioWorkletProcessor {
  private voice: TreeohvoxVoice;
  // Per-knob smoothers. 80 Hz corner ≈ 2 ms time constant — long enough to
  // mask a knob jump from clicking through the steep diode-ladder TF,
  // short enough that a knob drag still feels instant. We do NOT smooth
  // pitch / gate / accent — those are sample-snap events.
  private tuneSm: WtParamSmoother;
  private cutoffSm: WtParamSmoother;
  private resSm: WtParamSmoother;
  private envSm: WtParamSmoother;
  private decaySm: WtParamSmoother;
  private accentSm: WtParamSmoother;
  // Gate edge detector — fires trigger() on the 0 → ≥0.5 transition.
  private lastGate = 0;

  constructor(options?: { processorOptions?: unknown }) {
    super(options);
    const sr = sampleRate;
    const init: VoiceParams = {
      tuneSemitones: 0,
      cutoffHz: 1000,
      resonance: 0.5,
      envAmount01: 0.5,
      decayMs: 600,
      accentAmount01: 0.5,
    };
    this.voice = new TreeohvoxVoice(sr, init);
    this.tuneSm = new WtParamSmoother(sr, 80);
    this.cutoffSm = new WtParamSmoother(sr, 80);
    this.resSm = new WtParamSmoother(sr, 80);
    this.envSm = new WtParamSmoother(sr, 80);
    this.decaySm = new WtParamSmoother(sr, 80);
    this.accentSm = new WtParamSmoother(sr, 80);
    // Prime smoothers at the defaults so the first sample doesn't ramp
    // from zero into the user's chosen patch.
    this.tuneSm.prime(0);
    this.cutoffSm.prime(1000);
    this.resSm.prime(0.5);
    this.envSm.prime(0.5);
    this.decaySm.prime(600);
    this.accentSm.prime(0.5);
  }

  static get parameterDescriptors() {
    return [
      // TUNE — semitones offset, ±12. a-rate so tune_cv CV (volts → summed
      // here as volts then read as semitones via the *12 scaling that
      // pitchCvToFreq applies internally — but TUNE specifically is in
      // semitones so the CV is summed *as semitones*, NOT volts; the
      // factory's cvScale picks the right mapping).
      { name: 'tune',      defaultValue: 0,    minValue: -12,   maxValue: 12,    automationRate: 'a-rate' as const },
      // CUTOFF — Hz, log-tapered on the UI but linear AudioParam here.
      { name: 'cutoff',    defaultValue: 1000, minValue: 40,    maxValue: 6000,  automationRate: 'a-rate' as const },
      // RESONANCE — 0..1 raw (will be exp-skewed inside the filter to
      // match Open303's `resonanceSkewed` math).
      { name: 'resonance', defaultValue: 0.5,  minValue: 0,     maxValue: 1,     automationRate: 'a-rate' as const },
      // ENVELOPE — 0..1 maps to 0..100% envMod in Open303 terms.
      { name: 'envelope',  defaultValue: 0.5,  minValue: 0,     maxValue: 1,     automationRate: 'a-rate' as const },
      // DECAY — milliseconds. 200..2000 covers the canonical 303 range
      // (Open303's normalDecay default is 1000).
      { name: 'decay',     defaultValue: 600,  minValue: 50,    maxValue: 3000,  automationRate: 'a-rate' as const },
      // ACCENT — 0..1. Boosts both the amp envelope peak and the filter
      // env contribution on accented notes (accent_in high at the gate
      // rising edge).
      { name: 'accent',    defaultValue: 0.5,  minValue: 0,     maxValue: 1,     automationRate: 'a-rate' as const },
    ];
  }

  private aval(p: Record<string, Float32Array>, name: string, s: number, fallback: number): number {
    const arr = p[name];
    if (!arr || arr.length === 0) return fallback;
    return (arr.length > 1 ? arr[s] : arr[0]) as number;
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const pitchIn = inputs[0]?.[0] ?? null;
    const gateIn  = inputs[1]?.[0] ?? null;
    const accIn   = inputs[2]?.[0] ?? null;
    const out = outputs[0]?.[0];
    if (!out) return true;
    const n = out.length;

    for (let s = 0; s < n; s++) {
      // 1) Pull smoothed knob values. These ride per-sample so the filter
      //    coefficient recompute inside setParams() picks them up
      //    sample-by-sample for the canonical 303 squelch (cutoff sweep
      //    mid-note feels analog when smoothed, digital when stepped).
      const tune    = this.tuneSm.step(this.aval(parameters, 'tune',      s, 0));
      const cutoff  = this.cutoffSm.step(this.aval(parameters, 'cutoff',  s, 1000));
      const res     = this.resSm.step(this.aval(parameters, 'resonance', s, 0.5));
      const envAmt  = this.envSm.step(this.aval(parameters, 'envelope', s, 0.5));
      const decay   = this.decaySm.step(this.aval(parameters, 'decay',    s, 600));
      const accent  = this.accentSm.step(this.aval(parameters, 'accent',  s, 0.5));

      this.voice.setParams({
        tuneSemitones: tune,
        cutoffHz: cutoff,
        resonance: res,
        envAmount01: envAmt,
        decayMs: decay,
        accentAmount01: accent,
      });

      // 2) Gate edge detection. The accent value is sampled AT the
      //    transition so a brief accent pulse coinciding with the gate
      //    edge counts even if accent_in falls before the next sample.
      const gate = gateIn ? (gateIn[s] ?? 0) : 0;
      if (gate >= 0.5 && this.lastGate < 0.5) {
        const accentHigh = accIn ? ((accIn[s] ?? 0) >= 0.5) : false;
        const pitch = pitchIn ? (pitchIn[s] ?? 0) : 0;
        this.voice.trigger({ pitchCv: pitch, accented: accentHigh });
      }
      this.lastGate = gate;

      // 3) Step the voice. Always run — even when "idle" the filter
      //    state needs to drain so a re-trigger doesn't pop. The voice's
      //    own ampEnv contributes effective silence once decay completes.
      out[s] = this.voice.step();
    }

    return true;
  }
}

registerProcessor('treeohvox', TreeohvoxProcessor);
