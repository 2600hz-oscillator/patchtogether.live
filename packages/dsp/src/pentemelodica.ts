// packages/dsp/src/pentemelodica.ts
//
// PENTEMELODICA — 5-voice polyphonic analog-style synth (AudioWorklet entry).
//
// A POLY input drives five band-limited VCO voices (each with TUNE / FINE /
// exponential-FM / phase-mod / pulse-width and a continuous tri→saw→square
// WAVE morph), each gated by its own ADSR, summed through a per-voice level /
// equal-power-pan stereo mixer, then through an embedded multimode
// (LP→BP→HP→Notch) filter with a wet/dry bypass. Per-voice pre-mixer mono taps
// and per-voice FM inputs are exposed.
//
// I/O (see packages/web/src/lib/audio/modules/pentemelodica.ts for the def):
//   inputs : 0 = poly (10-ch polyPitchGate: [pitch0,gate0,…,pitch4,gate4]),
//            1..5 = fm1..fm5 (mono audio-rate FM/PM modulators, voice 1..5).
//   outputs: 0 = out_l, 1 = out_r (stereo mix, post-filter),
//            2..6 = voice1..voice5 (pre-mixer mono taps, post-ADSR).
//
// ALL DSP math lives in ./lib/pentemelodica-dsp (pure + exported) so unit tests
// and the web render mirror share exactly one definition of the audio. This
// entry is the worklet glue only; it MUST NOT export the Processor class (that
// would leak into the esbuild ESM bundle + break ART's classic-script eval) —
// it ends with registerProcessor('pentemelodica', …) only.

import {
  PENTE_VOICES,
  makePenteState,
  makeRenderOut,
  renderPentemelodica,
  type PenteParams,
  type PenteRenderOut,
  type PenteState,
} from './lib/pentemelodica-dsp';

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

/** Read a (possibly k-rate single-value) param array's first sample. */
function p0(arr: Float32Array | undefined): number {
  return arr && arr.length > 0 ? arr[0]! : 0;
}

class PentemelodicaProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    const descs: Array<{
      name: string;
      defaultValue: number;
      minValue: number;
      maxValue: number;
      automationRate: 'k-rate';
    }> = [];
    // Per-voice (×5): tune, fine, fm, pm, pw, wave, attack, decay, sustain,
    // release, level, pan.
    for (let v = 1; v <= PENTE_VOICES; v++) {
      descs.push(
        { name: `v${v}_tune`,    defaultValue: 0,     minValue: -36,  maxValue: 36,  automationRate: 'k-rate' },
        { name: `v${v}_fine`,    defaultValue: 0,     minValue: -100, maxValue: 100, automationRate: 'k-rate' },
        { name: `v${v}_fm`,      defaultValue: 0,     minValue: -1,   maxValue: 1,   automationRate: 'k-rate' },
        { name: `v${v}_pm`,      defaultValue: 0,     minValue: -1,   maxValue: 1,   automationRate: 'k-rate' },
        { name: `v${v}_pw`,      defaultValue: 0.5,   minValue: 0.05, maxValue: 0.95, automationRate: 'k-rate' },
        { name: `v${v}_wave`,    defaultValue: 0,     minValue: 0,    maxValue: 1,   automationRate: 'k-rate' },
        { name: `v${v}_attack`,  defaultValue: 0.005, minValue: 0.001, maxValue: 5,  automationRate: 'k-rate' },
        { name: `v${v}_decay`,   defaultValue: 0.1,   minValue: 0.001, maxValue: 5,  automationRate: 'k-rate' },
        { name: `v${v}_sustain`, defaultValue: 0.7,   minValue: 0,    maxValue: 1,   automationRate: 'k-rate' },
        { name: `v${v}_release`, defaultValue: 0.2,   minValue: 0.001, maxValue: 5,  automationRate: 'k-rate' },
        { name: `v${v}_level`,   defaultValue: 0.8,   minValue: 0,    maxValue: 1,   automationRate: 'k-rate' },
        { name: `v${v}_pan`,     defaultValue: 0,     minValue: -1,   maxValue: 1,   automationRate: 'k-rate' },
      );
    }
    // Filter (×1).
    descs.push(
      { name: 'cutoff',    defaultValue: 1000, minValue: 20, maxValue: 20000, automationRate: 'k-rate' },
      { name: 'resonance', defaultValue: 0.2,  minValue: 0,  maxValue: 0.99,  automationRate: 'k-rate' },
      { name: 'mode',      defaultValue: 0,    minValue: 0,  maxValue: 1,     automationRate: 'k-rate' },
      { name: 'wetdry',    defaultValue: 1,    minValue: 0,  maxValue: 1,     automationRate: 'k-rate' },
    );
    return descs;
  }

  private state: PenteState = makePenteState();
  private out: PenteRenderOut = makeRenderOut(128);
  // Scratch param object reused each block (avoid per-block allocation).
  private params: PenteParams = {
    voices: Array.from({ length: PENTE_VOICES }, () => ({
      tune: 0, fine: 0, fm: 0, pm: 0, pw: 0.5, wave: 0,
      attack: 0.005, decay: 0.1, sustain: 0.7, release: 0.2, level: 0.8, pan: 0,
    })),
    filter: { cutoff: 1000, resonance: 0.2, mode: 0, wetdry: 1 },
  };
  private polyScratch = new Float32Array(PENTE_VOICES * 2);
  private fmConst = new Float32Array(PENTE_VOICES);
  private fmArrs: (Float32Array | undefined)[] = new Array(PENTE_VOICES).fill(undefined);

  constructor(options?: { processorOptions?: unknown }) {
    super(options);
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const outL = outputs[0]?.[0];
    const outR = outputs[1]?.[0];
    if (!outL || !outR) return true;
    const n = outL.length;

    // Resize scratch render-out if the block size changed (rare).
    if (this.out.outL.length !== n) this.out = makeRenderOut(n);

    // ── Read params into the scratch param object. ──
    for (let v = 0; v < PENTE_VOICES; v++) {
      const vp = this.params.voices[v]!;
      const i = v + 1;
      vp.tune    = p0(parameters[`v${i}_tune`]);
      vp.fine    = p0(parameters[`v${i}_fine`]);
      vp.fm      = p0(parameters[`v${i}_fm`]);
      vp.pm      = p0(parameters[`v${i}_pm`]);
      vp.pw      = p0(parameters[`v${i}_pw`]);
      vp.wave    = p0(parameters[`v${i}_wave`]);
      vp.attack  = p0(parameters[`v${i}_attack`]);
      vp.decay   = p0(parameters[`v${i}_decay`]);
      vp.sustain = p0(parameters[`v${i}_sustain`]);
      vp.release = p0(parameters[`v${i}_release`]);
      vp.level   = p0(parameters[`v${i}_level`]);
      vp.pan     = p0(parameters[`v${i}_pan`]);
    }
    this.params.filter.cutoff    = p0(parameters.cutoff);
    this.params.filter.resonance = p0(parameters.resonance);
    this.params.filter.mode      = p0(parameters.mode);
    this.params.filter.wetdry    = p0(parameters.wetdry);

    // ── Poly bus: input 0 carries up to 10 channels (5 pitch/gate pairs).
    // Read the first sample of each channel (gates/pitches change at block
    // boundaries). ──
    const poly = inputs[0];
    for (let v = 0; v < PENTE_VOICES; v++) {
      this.polyScratch[v * 2]     = poly?.[v * 2]?.[0] ?? 0;
      this.polyScratch[v * 2 + 1] = poly?.[v * 2 + 1]?.[0] ?? 0;
    }

    // ── Per-voice FM jacks (inputs 1..5). Pass the per-sample arrays when
    // present so FM is audio-rate. ──
    for (let v = 0; v < PENTE_VOICES; v++) {
      this.fmArrs[v] = inputs[1 + v]?.[0];
      this.fmConst[v] = 0;
    }

    renderPentemelodica(
      this.params,
      this.polyScratch,
      this.fmConst,
      n,
      sampleRate,
      this.state,
      this.out,
      this.fmArrs,
    );

    // ── Copy render-out into the worklet output buffers. ──
    outL.set(this.out.outL.subarray(0, n));
    outR.set(this.out.outR.subarray(0, n));
    for (let v = 0; v < PENTE_VOICES; v++) {
      const vo = outputs[2 + v]?.[0];
      if (vo) vo.set(this.out.voices[v]!.subarray(0, n));
    }

    return true;
  }
}

registerProcessor('pentemelodica', PentemelodicaProcessor);

// Pure-math mirror of the DSP lives in
// packages/dsp/src/lib/pentemelodica-dsp.ts (imported here AND re-exported by
// the web module as `pentemelodicaMath`) so unit tests + ART scenarios can
// render audio under node without an AudioWorkletGlobalScope. Any algorithmic
// change goes in the lib, never duplicated here.
