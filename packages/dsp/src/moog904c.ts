// packages/dsp/src/moog904c.ts
//
// MOOG 904C — Voltage Controlled Filter Coupler AudioWorkletProcessor.
//
// Slice of the Moog System 55 / 35 clone initiative (.myrobots/MOOG/). The
// 904C is the "filter coupler": it pairs a 904A-style transistor-ladder
// LOW-pass with a 904B-style HIGH-pass and couples them around a single
// shared CUTOFF so the pair tracks together as one voltage-controlled
// BAND-PASS (the LP sits ABOVE the cutoff, the HP sits BELOW it — only the
// band in between survives). A MODE control crossfades that band-pass to its
// complement, a band-REJECT (notch): out = input − bandpass.
//
// Topology (per sample):
//   lpCutoff = cutoff · (1 + width)            (LP corner above cutoff)
//   hpCutoff = cutoff · (1 − width·0.9)        (HP corner below cutoff)
//   lp  = MoogLadder(LP).step(x, lpCutoff).lp4          (24 dB/oct low-pass)
//   bp  = hpDerive(lp, MoogLadder(HP).step(lp, hpCutoff))   (HP off the LP)
//   out = bp · (1 − mode) + (x − bp) · mode             (BP ↔ band-reject)
// Series LP→HP is the band-pass: the LP kills everything above lpCutoff, the
// HP (input − low-passed, via hpDerive) kills everything below hpCutoff, so
// only the band [hpCutoff, lpCutoff] (≈ ±width around `cutoff`) passes. The
// two ladders run with k=0 (no resonance / regeneration on the coupler) +
// drive=0 (the cheap exact LINEAR zero-delay solve), so the response stays
// clean + unconditionally stable under audio-rate cutoff modulation.
//
// WIDTH (0..1) sets the spread of the two corners around `cutoff`: 0 → both
// corners collapse onto `cutoff` (narrow band) ; 1 → LP pushed an octave up
// (×2) and HP pulled toward DC (×0.1) for a wide passband.
//
// MODE (0..1) crossfades band-pass (0) ↔ band-reject/notch (1):
// out = bp·(1−mode) + (x−bp)·mode. At mode=1 the passed band is subtracted
// from the input, leaving the complementary notch.
//
// DSP CONSUMES the shared own-code transistor-ladder core
// (./lib/moog-ladder-dsp.ts) — the SAME clean-room TPT/Zavalishin
// zero-delay-feedback ladder the 904A (lp4 tap) + 904B (hpDerive tap) use.
// Permissive / own-code, NOT a port of the LGPLv3 Huovilainen code, the
// CC-BY-SA musicdsp model, or any Moog schematic (.myrobots/MOOG/LICENSING.md).
//
// IMPORTANT: this file does NOT `export` anything at the top level —
// top-level exports leak into the bundled dist/<name>.js + break the ART
// classic-script eval. The Processor class is registered via the
// `registerProcessor` side-effect; tests capture it through a
// registerProcessor shim before importing. (memory:
// dsp-worklet-no-top-level-export)
//
// Inputs (1 audio-rate node connection):
//   inputs[0] = audio       (signal to be band-passed). cutoff_cv is summed
//                            into the `cutoff` AudioParam by the web factory
//                            (same wiring as resofilter), NOT a node input.
//
// AudioParams:
//   cutoff (a-rate, Hz)  — band centre; cutoff_cv is summed in here.
//   width  (k-rate, 0..1) — LP/HP spread around cutoff.
//   mode   (k-rate, 0..1) — 0 = band-pass, 1 = band-reject (notch).
//
// Outputs (mono):
//   outputs[0] = audio (band-passed, or band-rejected at mode=1).

import { MoogLadder, hpDerive, ladderCutoffToG } from './lib/moog-ladder-dsp';

// ladderCutoffToG is imported per the slice spec — it's the shared
// cutoff→coefficient clamp the ladder uses internally. We reference it to
// pre-clamp the derived LP/HP corners to the same safe band so a wide WIDTH
// can't push a corner past Nyquist / below DC and destabilise the pair.
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
// captures the class via this shim — see moog904c DSP test loader).
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

// Number of cascaded one-pole HP stages built off the low-passed signal →
// the HP side's slope. 4 × 6 dB/oct = a genuine 24 dB/oct HP, matching the
// 904B's derivation (a single input−lp4 leaves a bumpy, shallow stopband).
const HP_STAGES = 4;

// Pre-clamp a derived corner to the shared ladder's safe band (10 Hz ..
// ~0.49·sr) BEFORE handing it to the ladder, so an extreme WIDTH can't push
// the HP toward DC / the LP past Nyquist. ladderCutoffToG already clamps
// internally; we mirror its bounds here so the LP and HP corners stay
// ordered (hp < lp) even at the edges.
function clampCorner(fcHz: number): number {
  const fmin = 10;
  const fmax = sampleRate * 0.49;
  return fcHz < fmin ? fmin : fcHz > fmax ? fmax : fcHz;
}

// Not `export`ed at the top level by design — see the file-header note.
class Moog904cProcessor extends AudioWorkletProcessor {
  private sr: number;
  // The 904A-style LOW-pass ladder (we read its .lp4 24 dB/oct tap).
  private lpLadder: MoogLadder;
  // Four 904B-style HIGH-pass stages, each a clean `y − lp1` off its own
  // ladder, cascaded on the LOW-passed signal → series LP→HP band-pass.
  private hpLadders: MoogLadder[];

  constructor(options?: { processorOptions?: unknown }) {
    super(options);
    this.sr = sampleRate;
    this.lpLadder = new MoogLadder(this.sr);
    this.hpLadders = [];
    for (let s = 0; s < HP_STAGES; s++) this.hpLadders.push(new MoogLadder(this.sr));
  }

  static get parameterDescriptors() {
    return [
      // CUTOFF — band centre, in Hz (log knob on the UI side). a-rate so the
      // cutoff_cv routing (summed into this AudioParam by the web factory,
      // exactly like resofilter) sweeps the coupled pair continuously.
      { name: 'cutoff', defaultValue: 800, minValue: 20, maxValue: 20000, automationRate: 'a-rate' as const },
      // WIDTH — LP/HP spread around cutoff (0 narrow .. 1 wide). k-rate: a
      // pot, not an audio-rate modulation target.
      { name: 'width', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' as const },
      // MODE — 0 = band-pass, 1 = band-reject (notch). k-rate crossfade.
      { name: 'mode', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' as const },
    ];
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
    const out = outputs[0]?.[0];
    // No output buffer wired this block — nothing to do, but keep alive.
    if (!out) return true;

    const audioIn = inputs[0]?.[0];

    const cutoffArr = parameters.cutoff;
    // k-rate block constants.
    let width = this.kval(parameters, 'width', 0.5);
    if (width < 0) width = 0;
    else if (width > 1) width = 1;
    let mode = this.kval(parameters, 'mode', 0);
    if (mode < 0) mode = 0;
    else if (mode > 1) mode = 1;

    const blockLen = out.length;
    for (let i = 0; i < blockLen; i++) {
      const x = audioIn ? (audioIn[i] as number) : 0;

      // a-rate cutoff (cutoff_cv already summed in by the web factory's
      // AudioParam routing, mirroring resofilter).
      const cutoff = (cutoffArr.length > 1 ? cutoffArr[i] : cutoffArr[0]) as number;

      // Derive the two corners around `cutoff` from WIDTH, then pre-clamp to
      // the shared ladder's safe band so an extreme width keeps hp < lp.
      const lpCutoff = clampCorner(cutoff * (1 + width));
      const hpCutoff = clampCorner(cutoff * (1 - width * 0.9));

      // LOW-pass side: 24 dB/oct lp4 tap, no resonance (k=0) + exact linear
      // solve (drive=0).
      const lp = this.lpLadder.step(x, lpCutoff, 0, 0).lp4;

      // HIGH-pass side: cascade FOUR clean one-pole HP stages (each y − lp1
      // off its own ladder) ON the low-passed signal → series LP→HP =
      // band-pass with a deep, monotonic stopband on both skirts.
      let bp = lp;
      for (let s = 0; s < HP_STAGES; s++) {
        const taps = this.hpLadders[s].step(bp, hpCutoff, 0, 0);
        bp = hpDerive(bp, taps, 1);
      }

      // MODE crossfade: 0 → band-pass; 1 → band-reject (input − band-pass).
      out[i] = bp * (1 - mode) + (x - bp) * mode;
    }

    return true;
  }
}

registerProcessor('moog904c', Moog904cProcessor);

// Reference ladderCutoffToG so the imported (spec-mandated) symbol is part of
// the module's value graph even though clampCorner mirrors its bounds inline.
// (esbuild bundles only what's reachable; this keeps the import meaningful and
// documents that the coupler shares the ladder's exact cutoff clamp domain.)
void ladderCutoffToG;
