// packages/dsp/src/wavesculpt-engine.ts
//
// WAVESCULPT engine — 4 wavetable oscillators summed into a stereo bus.
// Each oscillator is the same WavetableOsc class WAVECEL uses (shared lib
// at packages/dsp/src/lib/wavetable-osc.ts), so the wavetable interpolation
// path is DRY across both modules.
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
    }
    return desc;
  }

  private oscs: WavetableOsc[];
  /** Cached pan per osc (computed once). */
  private pans: Array<{ l: number; r: number }>;

  constructor(options?: { processorOptions?: unknown }) {
    super(options);
    this.oscs = [
      new WavetableOsc(sampleRate),
      new WavetableOsc(sampleRate),
      new WavetableOsc(sampleRate),
      new WavetableOsc(sampleRate),
    ];
    this.pans = [panForOsc(0), panForOsc(1), panForOsc(2), panForOsc(3)];
    this.port.onmessage = (e: MessageEvent) => {
      const m = e.data as LoadMessage;
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
      }
    };
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean {
    // Stereo output on output 0, channels [L, R].
    const outL = outputs[0]?.[0];
    const outR = outputs[0]?.[1];
    if (!outL || !outR) return true;
    outL.fill(0);
    outR.fill(0);

    // Per-osc pitch CV inputs. Inputs 0..3 are pitchN — single-channel CV.
    const pitchIns: Array<Float32Array | undefined> = [
      inputs[0]?.[0],
      inputs[1]?.[0],
      inputs[2]?.[0],
      inputs[3]?.[0],
    ];

    const block = outL.length;
    for (let o = 0; o < 4; o++) {
      const osc = this.oscs[o]!;
      if (!osc.framesLoaded()) continue;

      const pIn = pitchIns[o];
      const tune = parameters[`tune${o + 1}`]![0]!;
      const fine = parameters[`fine${o + 1}`]![0]!;
      const morphArr = parameters[`morph${o + 1}`]!;
      const spreadArr = parameters[`spread${o + 1}`]!;
      const foldArr = parameters[`fold${o + 1}`]!;
      const envArr = parameters[`env${o + 1}`]!;
      const distArr = parameters[`distGain${o + 1}`]!;
      const pan = this.pans[o]!;

      for (let i = 0; i < block; i++) {
        const pitch = pIn ? pIn[i]! : 0;
        const morph = morphArr.length > 1 ? morphArr[i]! : morphArr[0]!;
        const spread = spreadArr.length > 1 ? spreadArr[i]! : spreadArr[0]!;
        const foldAmt = foldArr.length > 1 ? foldArr[i]! : foldArr[0]!;
        const env = envArr.length > 1 ? envArr[i]! : envArr[0]!;
        const dist = distArr.length > 1 ? distArr[i]! : distArr[0]!;
        const voct = pitch + tune / 12 + fine / 1200;
        const { l, r } = osc.step(voct, morph, spread, foldAmt);
        // Sum per-osc into the master bus, gated by env * dist and panned.
        const gate = env * dist;
        outL[i]! += l * pan.l * gate;
        outR[i]! += r * pan.r * gate;
      }
    }

    return true;
  }
}

registerProcessor('wavesculpt-engine', WavesculptEngineProcessor);
