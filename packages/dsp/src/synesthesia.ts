// packages/dsp/src/synesthesia.ts
//
// SYNESTHESIA — two independent copies (A/B) of a 4-band audio-analysis
// circuit. Each copy: mono in → 4 spectral bands (0–200 / 200–500 / 500–2000 /
// 2000+) → per-band gain (master floor + band gain) → band audio, fast (50 ms)
// + slow (500 ms) envelope followers, a gate, and a VU level. The DSP maths
// live in ./lib/synesthesia-dsp.ts (inlined by esbuild); this file is the thin
// AudioWorkletProcessor wrapper.
//
// IMPORTANT: this file does NOT `export` anything at the top level — top-level
// exports leak into the bundled dist/<name>.js + break the ART classic-script
// eval. The Processor is registered via the registerProcessor side-effect; the
// tests capture it through the registerProcessor shim (see resofilter.ts).
//
// Inputs (2 mono audio connections):
//   inputs[0] = copy A in
//   inputs[1] = copy B in
// Outputs (8 outputs × 4 channels = per copy × per band):
//   0 = audioA    1 = audioB
//   2 = envSlowA  3 = envSlowB
//   4 = envFastA  5 = envFastB
//   6 = gateA     7 = gateB
// VU levels are posted to the host via port.postMessage({type:'snapshot', ...}),
// not as an audio output.
// Params (k-rate): a_master/b_master (0.5..1.5); a_gain1..4 / b_gain1..4 (1..2);
//   a_mode/b_mode (0=AUDIO spectral bands, 1=VIDEO R/G/B/Luma channels).
//
// VIDEO mode (per copy, independent): the card reads the patched video frame's
// pixels and posts {type:'video', copy:'a'|'b', levels:[R,G,B,Luma]} (0..1) to
// this worklet's port. We sample-and-hold those levels across each render
// quantum and feed them through the SAME envelope/gate/meter stage the audio
// bands use (see SynesthesiaVideoCopy), so env_slow/env_fast/gate/band-audio
// outputs + the VU snapshot all keep working — the only change is the source of
// the per-lane scalar (a held channel level instead of a filtered band sample).
// AUDIO-mode behaviour is byte-for-byte unchanged when a copy's mode = 0.

import {
  makeBandSplitter,
  EnvFollower,
  GateDetector,
  MeterBallistics,
  SynesthesiaVideoCopy,
  combinedGain,
  SYN_NUM_BANDS,
  ENV_FAST_MS,
  ENV_SLOW_MS,
  type BandSplitter,
} from './lib/synesthesia-dsp';

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

interface Copy {
  // Audio-mode stage.
  splitter: BandSplitter;
  fast: EnvFollower[];
  slow: EnvFollower[];
  gate: GateDetector[];
  meter: MeterBallistics[];
  // Video-mode stage (independent state so switching modes never cross-talks).
  video: SynesthesiaVideoCopy;
  /** Held per-channel R/G/B/Luma levels (0..1), posted by the card. */
  videoLevels: Float32Array;
}
function makeCopy(sr: number): Copy {
  const idx = [0, 1, 2, 3];
  return {
    splitter: makeBandSplitter(sr),
    fast: idx.map(() => new EnvFollower(sr, ENV_FAST_MS)),
    slow: idx.map(() => new EnvFollower(sr, ENV_SLOW_MS)),
    gate: idx.map(() => new GateDetector()),
    meter: idx.map(() => new MeterBallistics(sr)),
    video: new SynesthesiaVideoCopy(sr),
    videoLevels: new Float32Array(SYN_NUM_BANDS),
  };
}

// Not `export`ed at the top level by design — see the file-header note.
class SynesthesiaProcessor extends AudioWorkletProcessor {
  private a: Copy;
  private b: Copy;
  private frame = 0;
  private levelsA = new Float32Array(SYN_NUM_BANDS);
  private levelsB = new Float32Array(SYN_NUM_BANDS);

  constructor(options?: { processorOptions?: unknown }) {
    super(options);
    this.a = makeCopy(sampleRate);
    this.b = makeCopy(sampleRate);
    // The card posts per-frame VIDEO channel levels here in VIDEO mode. We just
    // latch them into the matching copy's hold buffer; process() sample-and-
    // holds them across the quantum. Ignored entirely while a copy is in audio
    // mode (the mode param gates which stage runs). Guarded because the test
    // shim constructs the Processor with no `port` (it sets one afterwards).
    try {
      this.port.onmessage = (e: MessageEvent): void => this.onVideoMessage(e.data);
    } catch {
      /* no port yet (test harness) — onVideoMessage can be invoked directly */
    }
  }

  /** Latch posted VIDEO channel levels into the target copy's hold buffer. */
  onVideoMessage(data: unknown): void {
    const m = data as { type?: string; copy?: string; levels?: ArrayLike<number> } | undefined;
    if (!m || m.type !== 'video' || !m.levels) return;
    const dst = m.copy === 'b' ? this.b.videoLevels : this.a.videoLevels;
    for (let c = 0; c < SYN_NUM_BANDS; c++) {
      const v = m.levels[c] ?? 0;
      dst[c] = v < 0 ? 0 : v > 1 ? 1 : v;
    }
  }

  static get parameterDescriptors() {
    const p = [
      { name: 'a_master', defaultValue: 1, minValue: 0.5, maxValue: 1.5, automationRate: 'k-rate' as const },
      { name: 'b_master', defaultValue: 1, minValue: 0.5, maxValue: 1.5, automationRate: 'k-rate' as const },
      // 0 = AUDIO (spectral bands), 1 = VIDEO (R/G/B/Luma channels). Per copy.
      { name: 'a_mode', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' as const },
      { name: 'b_mode', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' as const },
    ];
    for (const c of ['a', 'b']) {
      for (let n = 1; n <= SYN_NUM_BANDS; n++) {
        p.push({ name: `${c}_gain${n}`, defaultValue: 1, minValue: 1, maxValue: 2, automationRate: 'k-rate' as const });
      }
    }
    return p;
  }

  private kval(p: Record<string, Float32Array>, name: string, fb: number): number {
    const arr = p[name];
    return arr && arr.length > 0 ? (arr[0] as number) : fb;
  }

  private runCopy(
    copy: Copy,
    input: Float32Array | null,
    master: number,
    gains: number[],
    n: number,
    audio?: Float32Array[],
    slow?: Float32Array[],
    fast?: Float32Array[],
    gate?: Float32Array[],
    levels?: Float32Array,
  ): void {
    const peak = [0, 0, 0, 0];
    for (let s = 0; s < n; s++) {
      const bands = copy.splitter.split(input?.[s] ?? 0);
      for (let b = 0; b < SYN_NUM_BANDS; b++) {
        const g = combinedGain(master, gains[b] ?? 1);
        const a = (bands[b] as number) * g;
        const ef = copy.fast[b]!.step(a);
        const es = copy.slow[b]!.step(a);
        const gt = copy.gate[b]!.step(ef);
        const lv = copy.meter[b]!.step(a);
        if (audio?.[b]) audio[b]![s] = a;
        if (slow?.[b]) slow[b]![s] = es;
        if (fast?.[b]) fast[b]![s] = ef;
        if (gate?.[b]) gate[b]![s] = gt;
        if (lv > peak[b]!) peak[b] = lv;
      }
    }
    if (levels) for (let b = 0; b < SYN_NUM_BANDS; b++) levels[b] = peak[b]!;
  }

  /**
   * VIDEO-mode counterpart of runCopy: the per-lane scalar is the held R/G/B/
   * Luma level (sample-and-held across the quantum) instead of a filtered band
   * sample. Same combinedGain law, same envelope/gate/meter stage — so the
   * env/gate/band-audio outputs + VU snapshot keep working. The band-audio
   * output emits the scaled channel level as a steady CV-like signal.
   */
  private runVideoCopy(
    copy: Copy,
    master: number,
    gains: number[],
    n: number,
    audio?: Float32Array[],
    slow?: Float32Array[],
    fast?: Float32Array[],
    gate?: Float32Array[],
    levels?: Float32Array,
  ): void {
    const peak = [0, 0, 0, 0];
    for (let s = 0; s < n; s++) {
      const out = copy.video.step(copy.videoLevels, master, gains);
      for (let b = 0; b < SYN_NUM_BANDS; b++) {
        if (audio?.[b]) audio[b]![s] = out.audio[b]!;
        if (slow?.[b]) slow[b]![s] = out.envSlow[b]!;
        if (fast?.[b]) fast[b]![s] = out.envFast[b]!;
        if (gate?.[b]) gate[b]![s] = out.gate[b]!;
        if (out.level[b]! > peak[b]!) peak[b] = out.level[b]!;
      }
    }
    if (levels) for (let b = 0; b < SYN_NUM_BANDS; b++) levels[b] = peak[b]!;
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const n = outputs[0]?.[0]?.length ?? 128;
    const gainsOf = (c: string): number[] => [1, 2, 3, 4].map((i) => this.kval(parameters, `${c}_gain${i}`, 1));
    // mode >= 0.5 → VIDEO. Independent per copy, so switching A never touches B.
    const aVideo = this.kval(parameters, 'a_mode', 0) >= 0.5;
    const bVideo = this.kval(parameters, 'b_mode', 0) >= 0.5;

    // Output index map: 0/1=audio, 2/3=envSlow, 4/5=envFast, 6/7=gate (A/B).
    if (aVideo) {
      this.runVideoCopy(
        this.a, this.kval(parameters, 'a_master', 1), gainsOf('a'), n,
        outputs[0], outputs[2], outputs[4], outputs[6], this.levelsA,
      );
    } else {
      this.runCopy(
        this.a, inputs[0]?.[0] ?? null, this.kval(parameters, 'a_master', 1), gainsOf('a'), n,
        outputs[0], outputs[2], outputs[4], outputs[6], this.levelsA,
      );
    }
    if (bVideo) {
      this.runVideoCopy(
        this.b, this.kval(parameters, 'b_master', 1), gainsOf('b'), n,
        outputs[1], outputs[3], outputs[5], outputs[7], this.levelsB,
      );
    } else {
      this.runCopy(
        this.b, inputs[1]?.[0] ?? null, this.kval(parameters, 'b_master', 1), gainsOf('b'), n,
        outputs[1], outputs[3], outputs[5], outputs[7], this.levelsB,
      );
    }

    // Post the VU snapshot ~ every 16 render quanta (≈ 30–60 Hz UI refresh).
    // Send copies so the host never reads a buffer mid-mutation.
    if ((this.frame++ & 15) === 0) {
      try {
        this.port.postMessage({
          type: 'snapshot',
          levelsA: this.levelsA.slice(),
          levelsB: this.levelsB.slice(),
        });
      } catch {
        /* port may be closed during teardown */
      }
    }
    return true;
  }
}

registerProcessor('synesthesia', SynesthesiaProcessor);
