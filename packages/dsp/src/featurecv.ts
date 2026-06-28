// packages/dsp/src/featurecv.ts
//
// FEATURECV — audio→CV feature extractor. Thin AudioWorkletProcessor wrapper
// around the pure core in ./lib/featurecv-dsp.ts (inlined by esbuild). Reads
// ONE mono audio input, extracts whole-signal timbre + dynamics features, and
// writes each to its own mono output channel:
//
//   inputs[0]  = the signal to analyse (already gain-trimmed by the node's
//                input GainNode — the worklet does NOT re-apply `gain`)
//   outputs[0] = loud   (cv, broadband RMS)
//   outputs[1] = bright (cv, zero-crossing-rate brightness)
//   outputs[2] = punch  (cv, crest factor)
//   outputs[3] = onset  (gate, time-domain flux trigger pulse, value 1.0)
//
// The three CV outputs are BIPOLAR (−1..+1) by default; the `bipolar` param
// switches to unipolar 0..1. A `snapshot` (UNIPOLAR feature levels + onset
// activity) is posted to the host for the card's display meters.
//
// IMPORTANT: this file does NOT `export` anything at the top level — top-level
// exports leak into the bundled dist/<name>.js + break the ART classic-script
// eval. The Processor is registered via the registerProcessor side-effect; the
// tests capture it through the registerProcessor shim (see resofilter.ts).
//
// Params (k-rate): attack / release (CV smoothing ms), bipolar (0/1, default 1),
//   onset_sens (0..1), onset_debounce (ms). `gain` lives on the node's input
//   GainNode (factory), NOT here.

import {
  FeatureCvExtractor,
  DEFAULT_ATTACK_MS,
  DEFAULT_RELEASE_MS,
  ATTACK_MIN_MS,
  ATTACK_MAX_MS,
  RELEASE_MIN_MS,
  RELEASE_MAX_MS,
  DEFAULT_ONSET_SENS,
  DEFAULT_ONSET_DEBOUNCE_MS,
  ONSET_DEBOUNCE_MIN_MS,
  ONSET_DEBOUNCE_MAX_MS,
} from './lib/featurecv-dsp';

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

// Shim worklet globals when running outside AudioWorkletGlobalScope (tests
// capture the class via this shim — see the resofilter.test.ts loader).
const G = globalThis as unknown as {
  AudioWorkletProcessor?: unknown;
  registerProcessor?: unknown;
};
if (typeof G.AudioWorkletProcessor === 'undefined') G.AudioWorkletProcessor = class {};
if (typeof G.registerProcessor === 'undefined') G.registerProcessor = () => {};

// Not `export`ed at the top level by design — see the file-header note.
class FeaturecvProcessor extends AudioWorkletProcessor {
  private ex: FeatureCvExtractor;
  private frame = 0;
  private snapLoud = 0;
  private snapBright = 0;
  private snapPunch = 0;
  private snapOnset = 0;

  constructor(options?: { processorOptions?: unknown }) {
    super(options);
    this.ex = new FeatureCvExtractor({ sr: sampleRate });
  }

  static get parameterDescriptors() {
    return [
      { name: 'attack', defaultValue: DEFAULT_ATTACK_MS, minValue: ATTACK_MIN_MS, maxValue: ATTACK_MAX_MS, automationRate: 'k-rate' as const },
      { name: 'release', defaultValue: DEFAULT_RELEASE_MS, minValue: RELEASE_MIN_MS, maxValue: RELEASE_MAX_MS, automationRate: 'k-rate' as const },
      // 0 = UNIPOLAR CV [0,1], 1 = BIPOLAR [-1,+1] (DEFAULT).
      { name: 'bipolar', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' as const },
      { name: 'onset_sens', defaultValue: DEFAULT_ONSET_SENS, minValue: 0, maxValue: 1, automationRate: 'k-rate' as const },
      { name: 'onset_debounce', defaultValue: DEFAULT_ONSET_DEBOUNCE_MS, minValue: ONSET_DEBOUNCE_MIN_MS, maxValue: ONSET_DEBOUNCE_MAX_MS, automationRate: 'k-rate' as const },
    ];
  }

  private kval(p: Record<string, Float32Array>, name: string, fb: number): number {
    const arr = p[name];
    return arr && arr.length > 0 ? (arr[0] as number) : fb;
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const input = inputs[0]?.[0] ?? null;
    const outLoud = outputs[0]?.[0];
    const outBright = outputs[1]?.[0];
    const outPunch = outputs[2]?.[0];
    const outOnset = outputs[3]?.[0];
    const n = outLoud?.length ?? 128;

    // Push the live k-rate params into the extractor (cheap; rebuilds only on
    // a real smoothing-time change).
    this.ex.setSmoothing(
      this.kval(parameters, 'attack', DEFAULT_ATTACK_MS),
      this.kval(parameters, 'release', DEFAULT_RELEASE_MS),
    );
    this.ex.setBipolar(this.kval(parameters, 'bipolar', 1) >= 0.5);
    this.ex.setOnset(
      this.kval(parameters, 'onset_sens', DEFAULT_ONSET_SENS),
      this.kval(parameters, 'onset_debounce', DEFAULT_ONSET_DEBOUNCE_MS),
    );

    let onsetSeen = 0;
    for (let s = 0; s < n; s++) {
      const o = this.ex.step(input?.[s] ?? 0);
      if (outLoud) outLoud[s] = o.loud;
      if (outBright) outBright[s] = o.bright;
      if (outPunch) outPunch[s] = o.punch;
      if (outOnset) outOnset[s] = o.onset;
      if (o.onset > onsetSeen) onsetSeen = o.onset;
    }

    // Snapshot for the card's display meters: UNIPOLAR feature levels (0..1)
    // regardless of output polarity + whether an onset fired this quantum.
    const lv = this.ex.levels();
    this.snapLoud = lv.loud;
    this.snapBright = lv.bright;
    this.snapPunch = lv.punch;
    this.snapOnset = onsetSeen;

    // Post ~ every 16 quanta (≈ 30–60 Hz UI refresh).
    if ((this.frame++ & 15) === 0) {
      try {
        this.port.postMessage({
          type: 'snapshot',
          loud: this.snapLoud,
          bright: this.snapBright,
          punch: this.snapPunch,
          onset: this.snapOnset,
        });
      } catch {
        /* port may be closed during teardown */
      }
    }
    return true;
  }
}

registerProcessor('featurecv', FeaturecvProcessor);
