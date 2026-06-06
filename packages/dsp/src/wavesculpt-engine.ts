// packages/dsp/src/wavesculpt-engine.ts
//
// WAVESCULPT engine — 4 wavetable oscillators summed into a stereo bus.
// Each oscillator is the shared WavetableOsc class at
// packages/dsp/src/lib/wavetable-osc.ts.
//
// What this worklet owns:
//   * 4 phase accumulators (one per WavetableOsc instance)
//   * Per-osc parameter descriptors (tune/fine/morph/spread/fold × 4)
//   * Per-osc envelope gain (driven from the JS side via AudioParam — the
//     factory's ADSR scheduler writes the env value into envN each tick).
//   * Distance-attenuation gain per osc (also driven by JS — `distGainN`
//     AudioParams are mirrored from the factory's per-tick computation).
//   * Per-osc stereo panning based on the fixed wall layout (RED right-
//     biased, GREEN left-biased, BLUE/ALPHA center). Matches the v1.1
//     wavesculpt layout exactly so the audio panning still lines up with
//     the visual ribbon positions.
//
// Per-osc gate / pitch_cv inputs continue to live on the FACTORY side via
// existing AnalyserNode taps — the worklet doesn't need to see gates, only
// the resulting envelope levels.
//
// Wavetable load message:
//   { type: 'loadWavetable', oscIdx: 0..3, frames: number[][] }
// Per-osc frames are independent — the user can load 4 different tables.

import { WavetableOsc, WAVETABLE_FRAME_SIZE } from './lib/wavetable-osc';
import { LumaBandpassChannel } from './lib/wavesculpt-luma-bandpass';

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  port: MessagePort;
  constructor(options?: { processorOptions?: unknown });
  process?(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean;
}
declare function registerProcessor(
  name: string,
  ctor: typeof AudioWorkletProcessor
): void;

interface LoadMessage {
  type: 'loadWavetable';
  oscIdx: number;
  frames: number[][];
}

/** Per-osc pitch-source routing. Each entry is the input index whose
 *  pitch CV the corresponding osc should sample — defaults to identity
 *  [0, 1, 2, 3] (osc i reads pitch input i). The factory posts this
 *  whenever the patched/unpatched state of the four pitch_cv ports
 *  changes, implementing classic patch-cable normalling: an unpatched
 *  voice picks up the most-recent patched-upstream voice's pitch. */
interface PitchRouteMessage {
  type: 'setPitchRoute';
  route: number[];
}

type IncomingMessage = LoadMessage | PitchRouteMessage;

// Per-osc pan: RED (+X) → right-biased, GREEN (-X) → left-biased,
// BLUE / ALPHA (±Y) → centered. equal-power so the stereo image is
// musically usable. Mirrors stereoPanForSource() in the audio module.
function panForOsc(oscIdx: number): { l: number; r: number } {
  // X coord of each wall: [+1, -1, 0, 0] for RED/GREEN/BLUE/ALPHA.
  const x = oscIdx === 0 ? 1 : oscIdx === 1 ? -1 : 0;
  const angle = ((x + 1) / 2) * (Math.PI / 2);
  return { l: Math.cos(angle), r: Math.sin(angle) };
}

class WavesculptEngineProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    const desc: Array<{
      name: string;
      defaultValue: number;
      minValue: number;
      maxValue: number;
      automationRate: 'a-rate' | 'k-rate';
    }> = [];
    for (let i = 1; i <= 4; i++) {
      desc.push({ name: `tune${i}`,   defaultValue: 0, minValue: -36,  maxValue: 36,  automationRate: 'k-rate' });
      desc.push({ name: `fine${i}`,   defaultValue: 0, minValue: -100, maxValue: 100, automationRate: 'k-rate' });
      desc.push({ name: `morph${i}`,  defaultValue: 0, minValue: 0,    maxValue: 1,   automationRate: 'a-rate' });
      desc.push({ name: `spread${i}`, defaultValue: 1, minValue: 1,    maxValue: 5,   automationRate: 'a-rate' });
      desc.push({ name: `fold${i}`,   defaultValue: 0, minValue: 0,    maxValue: 1,   automationRate: 'a-rate' });
      // env[1..4] are envelope gain values (0..1) written from the JS-side
      // ADSR scheduler each tick. a-rate so smoothing rampsApply per-sample.
      desc.push({ name: `env${i}`,    defaultValue: 0, minValue: 0,    maxValue: 1,   automationRate: 'a-rate' });
      // distGain[1..4] is the camera-distance-attenuation gain (0..1)
      // mirrored from the JS side. The factory computes it from camera +
      // wall layout each tick (single source of truth, mirrored into both
      // visual + audio so they can't drift).
      desc.push({ name: `distGain${i}`, defaultValue: 0, minValue: 0,  maxValue: 1, automationRate: 'a-rate' });
      // LUMINOSITY → BANDPASS (k-rate, posted from the card each frame). lumA
      // / lumB are the 0..1 luminosities sampled at the centre points where
      // this line crosses its two walls; the per-osc band-pass cutoff/width is
      // derived from the pair (bright = wide-open, black = narrow-nonzero). See
      // lib/wavesculpt-luma-bandpass.ts. k-rate (one value per block) — the
      // luminosity is a per-frame video read, smoothed inside the filter.
      desc.push({ name: `lumA${i}`, defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' });
      desc.push({ name: `lumB${i}`, defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' });
    }
    // Global LUMINOSITY-BANDPASS DEPTH (0 = OFF / lines unfiltered, 1 = the
    // wall luminosity fully shapes each line's band). k-rate.
    desc.push({ name: 'lumDepth', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' });
    return desc;
  }

  private oscs: WavetableOsc[];
  /** Cached pan per osc (computed once). */
  private pans: Array<{ l: number; r: number }>;
  /** Pitch-input routing per osc. Identity [0,1,2,3] until the factory
   *  posts a 'setPitchRoute' message. See PitchRouteMessage above. */
  private pitchRoute: number[];
  /** Per-osc, per-channel luminosity band-pass filters (L, R). Driven by the
   *  lumA{N}/lumB{N}/lumDepth k-rate params. */
  private lumaBpL: LumaBandpassChannel[];
  private lumaBpR: LumaBandpassChannel[];

  constructor(options?: { processorOptions?: unknown }) {
    super(options);
    this.oscs = [
      new WavetableOsc(sampleRate),
      new WavetableOsc(sampleRate),
      new WavetableOsc(sampleRate),
      new WavetableOsc(sampleRate),
    ];
    this.pans = [panForOsc(0), panForOsc(1), panForOsc(2), panForOsc(3)];
    this.pitchRoute = [0, 1, 2, 3];
    this.lumaBpL = [
      new LumaBandpassChannel(sampleRate),
      new LumaBandpassChannel(sampleRate),
      new LumaBandpassChannel(sampleRate),
      new LumaBandpassChannel(sampleRate),
    ];
    this.lumaBpR = [
      new LumaBandpassChannel(sampleRate),
      new LumaBandpassChannel(sampleRate),
      new LumaBandpassChannel(sampleRate),
      new LumaBandpassChannel(sampleRate),
    ];
    this.port.onmessage = (e: MessageEvent) => {
      const m = e.data as IncomingMessage;
      if (!m || typeof m !== 'object') return;
      if (m.type === 'loadWavetable') {
        const i = m.oscIdx;
        if (!Number.isInteger(i) || i < 0 || i > 3) {
          console.error('[wavesculpt-engine] invalid oscIdx', i);
          return;
        }
        if (!Array.isArray(m.frames) || m.frames.length === 0) {
          console.error('[wavesculpt-engine] empty frames for osc', i);
          return;
        }
        const next: Float32Array[] = [];
        for (let j = 0; j < m.frames.length; j++) {
          const src = m.frames[j];
          if (!src || src.length !== WAVETABLE_FRAME_SIZE) {
            console.error(`[wavesculpt-engine] osc${i} frame ${j} length ${src?.length} != ${WAVETABLE_FRAME_SIZE}`);
            return;
          }
          next.push(Float32Array.from(src));
        }
        this.oscs[i]!.setFrames(next);
      } else if (m.type === 'setPitchRoute') {
        // Validate: every entry must be an integer 0..3. Reject the
        // message wholesale on any bad entry so we never sample out of
        // bounds in the process() hot loop.
        if (!Array.isArray(m.route) || m.route.length !== 4) {
          console.error('[wavesculpt-engine] setPitchRoute: route must be length 4');
          return;
        }
        for (let i = 0; i < 4; i++) {
          const r = m.route[i];
          if (!Number.isInteger(r) || r! < 0 || r! > 3) {
            console.error('[wavesculpt-engine] setPitchRoute: bad entry', m.route);
            return;
          }
        }
        this.pitchRoute = [m.route[0]!, m.route[1]!, m.route[2]!, m.route[3]!];
      }
    };
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean {
    // Per-osc stereo outputs. Outputs 0..3 each carry one osc's RAW
    // shaped stereo signal (no env gating, no distance attenuation,
    // no pan). The JS factory applies env/dist/pan/FX-slot per osc
    // and sums them into the master stereo bus — this lets the
    // user insert a per-osc FX (DELAY/REVERB) between the shaper
    // and the spatial mix, which is the headline behavior the
    // FX-slot UI exposes.
    //
    // Prior shape (numberOfOutputs=1, full mix in worklet) is gone;
    // the JS path can't be replicated inside the worklet without
    // re-implementing every FX in C++/Rust at the worklet level.

    // Per-osc pitch CV inputs. Inputs 0..3 are pitchN — single-channel CV.
    const pitchIns: Array<Float32Array | undefined> = [
      inputs[0]?.[0],
      inputs[1]?.[0],
      inputs[2]?.[0],
      inputs[3]?.[0],
    ];

    // Pre-clear all outputs so a wavetable-not-loaded osc emits silence.
    let block = 128;
    for (let o = 0; o < 4; o++) {
      const out = outputs[o];
      const oL = out?.[0];
      const oR = out?.[1];
      if (oL) { oL.fill(0); block = oL.length; }
      if (oR) oR.fill(0);
    }

    for (let o = 0; o < 4; o++) {
      const osc = this.oscs[o]!;
      if (!osc.framesLoaded()) continue;
      const out = outputs[o];
      const outL = out?.[0];
      const outR = out?.[1];
      if (!outL || !outR) continue;

      // Pitch input source — honour the factory's per-osc routing so
      // an unpatched voice's pitch normals through to whichever
      // upstream voice IS patched.
      const pIn = pitchIns[this.pitchRoute[o]!];
      const tune = parameters[`tune${o + 1}`]![0]!;
      const fine = parameters[`fine${o + 1}`]![0]!;
      const morphArr = parameters[`morph${o + 1}`]!;
      const spreadArr = parameters[`spread${o + 1}`]!;
      const foldArr = parameters[`fold${o + 1}`]!;
      // LUMINOSITY-BANDPASS k-rate values (one per block).
      const lumDepth = parameters['lumDepth']![0]!;
      const lumA = parameters[`lumA${o + 1}`]![0]!;
      const lumB = parameters[`lumB${o + 1}`]![0]!;
      const bpActive = lumDepth > 1e-4;
      const bpL = this.lumaBpL[o]!;
      const bpR = this.lumaBpR[o]!;

      for (let i = 0; i < block; i++) {
        const pitch = pIn ? pIn[i]! : 0;
        const morph = morphArr.length > 1 ? morphArr[i]! : morphArr[0]!;
        const spread = spreadArr.length > 1 ? spreadArr[i]! : spreadArr[0]!;
        const foldAmt = foldArr.length > 1 ? foldArr[i]! : foldArr[0]!;
        const voct = pitch + tune / 12 + fine / 1200;
        let { l, r } = osc.step(voct, morph, spread, foldAmt);
        // LUMINOSITY → BANDPASS: cutoff/width per line are derived from the
        // two wall-crossing luminosities. depth is the dry/wet so depth=0 is a
        // true bypass (lines unfiltered) — the filter still runs (state stays
        // primed) but contributes nothing. Always keep the filter STATE warm
        // so flipping depth on doesn't pop.
        if (bpActive) {
          const wL = bpL.step(l, lumA, lumB, lumDepth);
          const wR = bpR.step(r, lumA, lumB, lumDepth);
          l = l + (wL - l) * lumDepth;
          r = r + (wR - r) * lumDepth;
        } else {
          // Keep state primed (centre/res track toward wide-open) without
          // altering the dry signal.
          bpL.step(l, lumA, lumB, 0);
          bpR.step(r, lumA, lumB, 0);
        }
        // Emit raw shaped stereo per osc on its own output. The JS
        // factory applies env+dist+pan+FX-slot AFTER this point.
        outL[i] = l;
        outR[i] = r;
      }
    }

    return true;
  }
}

registerProcessor('wavesculpt-engine', WavesculptEngineProcessor);
