// packages/dsp/src/cube.ts
//
// CUBE — 3D wavetable-navigator oscillator (slice 2 of ~8): the AudioWorklet
// V/oct oscillator. See .myrobots/CUBE/PLAN.md §3/§5 for the design + the pure
// field/slice DSP in ./lib/cube-dsp.ts (slice 1, already merged).
//
// What this worklet owns:
//   * Three loaded wavetables (FLOOR / WALL / CEILING), received via port
//     messages ({type:'loadWavetable', slot:'floor'|'wall'|'ceiling', frames}).
//   * Per-render-block recompute of the 256-sample slice waveform via
//     cube-dsp.sampleSlice(...) — but ONLY when a slice-shaping param actually
//     changed (recompute is ~256·96 field reads, far too costly to do every
//     block unconditionally). Params are smoothed with WtParamSmoother so a
//     knob drag de-zippers the recompute trigger.
//   * Phase accumulation through the recomputed frame at the V/oct frequency
//     (reusing lib/wavetable-osc's sampleSplit + linear sample interpolation).
//   * Stereo L/R spread = ±5%: the L channel reads a slice rendered at
//     depthOffset −0.05·spread, the R channel at +0.05·spread (PLAN §5.6). At
//     spread=0 both reuse the center slice → mono.
//   * Posting a viz snapshot (~30 Hz) of the current center-slice waveform to
//     the card via port.
//
// IMPORTANT: this file does NOT `export` anything at the top level — top-level
// exports leak into the bundled dist/cube.js + break the ART classic-script
// eval. The Processor class is registered via the `registerProcessor`
// side-effect; tests capture it through a registerProcessor shim (see
// packages/web/src/lib/audio/modules/cube.test.ts).
//
// Inputs (single-channel CV node connections; CV→AudioParam summing is done by
// the web factory, so the worklet just reads the resulting AudioParam):
//   inputs[0] = pitch  — V/oct pitch CV (0V = C4). The ONLY audio-rate node
//                        input the worklet reads directly; the rest of the CV
//                        inputs are summed into AudioParams by the factory.
//
// Outputs (one stereo output, 2 channels):
//   outputs[0] = [L, R]

import {
  WtParamSmoother,
  sampleSplit,
  clampRange,
  WAVETABLE_FRAME_SIZE,
} from './lib/wavetable-osc';
import {
  sampleSlice,
  CUBE_SLICE_SIZE,
  type SliceParams,
  type Material,
} from './lib/cube-dsp';

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
// captures the class via this shim — see cube.test.ts loader).
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

const C4_HZ = 261.626;

type Slot = 'floor' | 'wall' | 'ceiling';
const SLOTS: readonly Slot[] = ['floor', 'wall', 'ceiling'];

interface LoadMessage {
  type: 'loadWavetable';
  slot: Slot;
  frames: number[][];
}
type IncomingMessage = LoadMessage;

/** Read a single sample from a 256-sample frame at a fractional phase using the
 *  same (s1,s2,sFrac) split the wavetable engine uses. */
function readFrame(frame: Float32Array, phase: number): number {
  const { s1, s2, sFrac } = sampleSplit(phase, frame.length || WAVETABLE_FRAME_SIZE);
  const a = frame[s1] ?? 0;
  const b = frame[s2] ?? 0;
  return a + (b - a) * sFrac;
}

/** Spread depth offset for the L (sign −1) / R (sign +1) channel: ±5% of the
 *  cube at spread=1, linearly scaled, clamped to spread∈[0,1]. */
function spreadDepth(spread: number, sign: number): number {
  const s = spread < 0 ? 0 : spread > 1 ? 1 : spread;
  return sign * 0.05 * s;
}

// Not `export`ed at the top level by design — see the file-header note.
class CubeProcessor extends AudioWorkletProcessor {
  // Loaded wavetables (empty until the first loadWavetable per slot).
  private floor: Float32Array[] = [];
  private wall: Float32Array[] = [];
  private ceiling: Float32Array[] = [];

  // Phase accumulator (normalized [0,1)).
  private phase = 0;

  // Per-channel slice waveforms (recomputed on param/table change).
  // Slice waveforms. Typed with ArrayBufferLike so `sampleSlice`'s return
  // (also Float32Array<ArrayBufferLike> under the strict web tsconfig that
  // compiles this dsp source) assigns cleanly.
  private waveL: Float32Array<ArrayBufferLike> = new Float32Array(CUBE_SLICE_SIZE);
  private waveR: Float32Array<ArrayBufferLike> = new Float32Array(CUBE_SLICE_SIZE);
  // The center (spread=0) slice — posted to the card as the viz snapshot.
  private waveCenter: Float32Array<ArrayBufferLike> = new Float32Array(CUBE_SLICE_SIZE);
  private haveWave = false;

  // Smoothers for the slice-shaping params (de-zipper the recompute trigger).
  private smMorphFc: WtParamSmoother;
  private smConnect: WtParamSmoother;
  private smCrush: WtParamSmoother;
  private smSpread: WtParamSmoother;
  private smSliceY: WtParamSmoother;
  private smRx: WtParamSmoother;
  private smRy: WtParamSmoother;
  private smRz: WtParamSmoother;

  // Cached slice signature so we only recompute the (expensive) slice when a
  // shaping param crossed a quantization step or a table swapped.
  private lastSig = '';
  // Bumped whenever any table is replaced → forces a slice recompute.
  private tableEpoch = 0;

  // Viz snapshot throttle (~30 Hz).
  private snapAccum = 0;
  private snapInterval: number;

  constructor(options?: { processorOptions?: unknown }) {
    super(options);
    this.smMorphFc = new WtParamSmoother(sampleRate);
    this.smConnect = new WtParamSmoother(sampleRate);
    this.smCrush = new WtParamSmoother(sampleRate);
    this.smSpread = new WtParamSmoother(sampleRate);
    this.smSliceY = new WtParamSmoother(sampleRate);
    this.smRx = new WtParamSmoother(sampleRate);
    this.smRy = new WtParamSmoother(sampleRate);
    this.smRz = new WtParamSmoother(sampleRate);
    // Prime to defaults so the first block doesn't ramp from 0.
    this.smMorphFc.prime(0);
    this.smConnect.prime(0);
    this.smCrush.prime(0);
    this.smSpread.prime(0);
    this.smSliceY.prime(0.5);
    this.smRx.prime(0);
    this.smRy.prime(0);
    this.smRz.prime(0);
    // Snapshot every ~1/30 s worth of samples.
    this.snapInterval = Math.max(1, Math.round(sampleRate / 30));

    // The real AudioWorkletGlobalScope gives every processor a MessagePort.
    // The vitest registerProcessor shim does not (base class is `class {}`),
    // so the test installs a stub port before delivering loadWavetable
    // messages; guard the wiring so construction never throws.
    if (!this.port) {
      (this as { port: MessagePort }).port = {
        onmessage: null,
        postMessage: () => {},
      } as unknown as MessagePort;
    }
    this.port.onmessage = (e: MessageEvent) => {
      const m = e.data as IncomingMessage;
      if (!m || typeof m !== 'object') return;
      if (m.type === 'loadWavetable') {
        if (!SLOTS.includes(m.slot)) {
          console.error('[cube] invalid slot', m.slot);
          return;
        }
        if (!Array.isArray(m.frames) || m.frames.length === 0) {
          console.error('[cube] empty frames for slot', m.slot);
          return;
        }
        const next: Float32Array[] = [];
        for (let j = 0; j < m.frames.length; j++) {
          const src = m.frames[j];
          if (!src || src.length !== WAVETABLE_FRAME_SIZE) {
            console.error(
              `[cube] ${m.slot} frame ${j} length ${src?.length} != ${WAVETABLE_FRAME_SIZE}`,
            );
            return;
          }
          next.push(Float32Array.from(src));
        }
        if (m.slot === 'floor') this.floor = next;
        else if (m.slot === 'wall') this.wall = next;
        else this.ceiling = next;
        this.tableEpoch++;
      }
    };
  }

  static get parameterDescriptors() {
    return [
      // Pitch trims — k-rate (instant per block, like the wavetable engine;
      // not smoothed so sequencer steps stay sample-tight).
      { name: 'tune', defaultValue: 0, minValue: -36, maxValue: 36, automationRate: 'k-rate' as const },
      { name: 'fine', defaultValue: 0, minValue: -100, maxValue: 100, automationRate: 'k-rate' as const },
      // Slice-shaping params — a-rate so summed CV reaches them; the worklet
      // smooths + quantizes them to decide when to recompute the slice.
      { name: 'morph_fc', defaultValue: 0,   minValue: 0,    maxValue: 1, automationRate: 'a-rate' as const },
      { name: 'connect',  defaultValue: 0,   minValue: 0,    maxValue: 1, automationRate: 'a-rate' as const },
      { name: 'crush',    defaultValue: 0,   minValue: 0,    maxValue: 1, automationRate: 'a-rate' as const },
      { name: 'spread',   defaultValue: 0,   minValue: 0,    maxValue: 1, automationRate: 'a-rate' as const },
      { name: 'slice_y',  defaultValue: 0.5, minValue: 0,    maxValue: 1, automationRate: 'a-rate' as const },
      { name: 'slice_rx', defaultValue: 0,   minValue: -3.1416, maxValue: 3.1416, automationRate: 'a-rate' as const },
      { name: 'slice_ry', defaultValue: 0,   minValue: -3.1416, maxValue: 3.1416, automationRate: 'a-rate' as const },
      { name: 'slice_rz', defaultValue: 0,   minValue: -3.1416, maxValue: 3.1416, automationRate: 'a-rate' as const },
      // Toggles — k-rate discrete.
      { name: 'wrap',     defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' as const },
      { name: 'material', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' as const },
      // Output level.
      { name: 'level',    defaultValue: 1, minValue: 0, maxValue: 2, automationRate: 'a-rate' as const },
    ];
  }

  private kval(p: Record<string, Float32Array>, name: string, fallback: number): number {
    const arr = p[name];
    return arr && arr.length > 0 ? (arr[0] as number) : fallback;
  }
  /** Read an a-rate param's last value (we drive the smoother once per block at
   *  block rate — sub-sample slice modulation isn't audible and a per-sample
   *  slice recompute is impossible at 256·96 field reads). */
  private aval(p: Record<string, Float32Array>, name: string, fallback: number): number {
    const arr = p[name];
    if (!arr || arr.length === 0) return fallback;
    return (arr.length > 1 ? arr[arr.length - 1] : arr[0]) as number;
  }

  private framesLoaded(): boolean {
    return this.floor.length > 0 && this.wall.length > 0 && this.ceiling.length > 0;
  }

  /** Recompute the L/R/center slice waveforms if the (quantized) slice
   *  signature or a table changed. Returns true if a recompute occurred. */
  private maybeRecompute(sp: SliceParams, spread: number): boolean {
    // Quantize the continuous shaping params so we don't recompute every block
    // on float jitter — but finely enough that a sweep is smooth (~512 steps).
    const q = (v: number) => Math.round(v * 512);
    const sig =
      `${this.tableEpoch}|${q(sp.morphFC)}|${q(sp.connect)}|${q(sp.crush)}|` +
      `${q(spread)}|${q(sp.sliceY)}|${q(sp.rx)}|${q(sp.ry)}|${q(sp.rz)}|` +
      `${sp.material}|${sp.wrap ? 1 : 0}`;
    if (sig === this.lastSig && this.haveWave) return false;
    this.lastSig = sig;

    const dL = spreadDepth(spread, -1);
    const dR = spreadDepth(spread, +1);
    this.waveCenter = sampleSlice(this.floor, this.wall, this.ceiling, sp, 0);
    if (dL === 0 && dR === 0) {
      this.waveL = this.waveCenter;
      this.waveR = this.waveCenter;
    } else {
      this.waveL = sampleSlice(this.floor, this.wall, this.ceiling, sp, dL);
      this.waveR = sampleSlice(this.floor, this.wall, this.ceiling, sp, dR);
    }
    this.haveWave = true;
    return true;
  }

  private postSnapshot(): void {
    // Copy so the card can hold the buffer without racing a recompute.
    const wave = new Float32Array(this.waveCenter);
    try {
      this.port.postMessage({ type: 'snapshot', wave }, [wave.buffer]);
    } catch {
      /* transfer can fail in some shims; ignore */
    }
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const out = outputs[0];
    const outL = out?.[0];
    const outR = out?.[1] ?? out?.[0];
    if (!outL) return true;
    const n = outL.length;

    // Silent until all three tables are loaded.
    if (!this.framesLoaded()) {
      outL.fill(0);
      if (outR && outR !== outL) outR.fill(0);
      return true;
    }

    // k-rate block constants.
    const tune = this.kval(parameters, 'tune', 0);
    const fine = this.kval(parameters, 'fine', 0);
    const wrap = this.kval(parameters, 'wrap', 0) >= 0.5;
    const material: Material = this.kval(parameters, 'material', 0) >= 0.5 ? 'hard' : 'smooth';

    // a-rate shaping params → smooth at block rate.
    const morphFC = this.smMorphFc.step(this.aval(parameters, 'morph_fc', 0));
    const connect = this.smConnect.step(this.aval(parameters, 'connect', 0));
    const crush = this.smCrush.step(this.aval(parameters, 'crush', 0));
    const spread = this.smSpread.step(this.aval(parameters, 'spread', 0));
    const sliceY = this.smSliceY.step(this.aval(parameters, 'slice_y', 0.5));
    const rx = this.smRx.step(this.aval(parameters, 'slice_rx', 0));
    const ry = this.smRy.step(this.aval(parameters, 'slice_ry', 0));
    const rz = this.smRz.step(this.aval(parameters, 'slice_rz', 0));

    const sp: SliceParams = { sliceY, rx, ry, rz, morphFC, connect, material, crush, wrap };
    this.maybeRecompute(sp, spread);

    const pIn = inputs[0]?.[0];
    const levelArr = parameters.level;

    const sr = sampleRate;
    const frameLen = this.waveCenter.length || CUBE_SLICE_SIZE;
    for (let i = 0; i < n; i++) {
      const pitch = pIn ? (pIn[i] ?? 0) : 0;
      const voct = pitch + tune / 12 + fine / 1200;
      let freq = C4_HZ * Math.pow(2, voct);
      if (freq < 1) freq = 1;
      else if (freq > sr * 0.5) freq = sr * 0.5;
      this.phase += freq / sr;
      while (this.phase >= 1) this.phase -= 1;
      while (this.phase < 0) this.phase += 1;

      const level = levelArr
        ? (levelArr.length > 1 ? (levelArr[i] as number) : (levelArr[0] as number))
        : 1;
      // Phase maps to a fractional column index across the 256-sample frame.
      const phaseN = this.phase;
      const l = readFrame(this.waveL, phaseN) * level;
      const r = readFrame(this.waveR, phaseN) * level;
      outL[i] = clampRange(l, -4, 4);
      if (outR && outR !== outL) outR[i] = clampRange(r, -4, 4);
    }
    void frameLen;

    // Throttled viz snapshot (~30 Hz).
    this.snapAccum += n;
    if (this.snapAccum >= this.snapInterval) {
      this.snapAccum = 0;
      this.postSnapshot();
    }

    return true;
  }
}

registerProcessor('cube', CubeProcessor);
