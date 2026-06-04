// packages/dsp/src/hypercube.ts
//
// HYPERCUBE — 4D tesseract extension of CUBE: the AudioWorklet V/oct oscillator.
// A SIBLING module to CUBE (cube.ts is left UNTOUCHED). It clones CUBE's worklet
// and adds a FOURTH "HOLO" wavetable + an ALPHA axis (the slice's 4th-dimension
// w coordinate). The field's occupancy is blended toward the HOLO cell —
// `f4 = (1-alpha)*f3 + alpha*dH` — a genuine tesseract cross-section (NOT a 4D
// march): the slice is still a 2D plane ray-marched through a 3D field, ALPHA
// just selects WHICH 3D field. See cube-dsp.ts (fieldFromHeights / sampleSlice)
// for the shared, off=identity DSP.
//
// What this worklet owns (identical to CUBE except for the HOLO slot + ALPHA):
//   * FOUR loaded wavetables (FLOOR / WALL / CEILING / HOLO) via port messages
//     ({type:'loadWavetable', slot:'floor'|'wall'|'ceiling'|'holo', frames}).
//   * Phase accumulation through three posted slice waveforms (L / R / center).
//   * An `alpha` AudioParam (default 0 → HYPERCUBE-off = identity to a 3-table
//     render) summed by the factory + smoothed here, threaded with the HOLO
//     frames into sampleSlice.
//
// DROPOUT FIX (mirrors CUBE issue #4): the expensive SURFACE-HEIGHT SCAN runs
//   OFF the audio thread (computed on the main thread in the web factory, pushed
//   in via {type:'setWave', …}). A legacy on-thread fallback remains for the
//   unit test / standalone harness (disabled once the first setWave arrives).
//
// IMPORTANT: this file does NOT `export` anything at the top level — top-level
// exports leak into the bundled dist/hypercube.js + break the ART classic-script
// eval. The Processor class is registered via the `registerProcessor`
// side-effect; tests capture it through a registerProcessor shim.
//
// Inputs:  inputs[0] = pitch — V/oct pitch CV (0V = C4). The rest of the CV
//          inputs are summed into AudioParams by the factory.
// Outputs: outputs[0] = [L, R] (fanned into separate L/R node ports by the
//          factory's ChannelSplitter, like CUBE).

import {
  WtParamSmoother,
  sampleSplit,
  clampRange,
  WAVETABLE_FRAME_SIZE,
} from './lib/wavetable-osc';
import {
  sampleSlice,
  applyFold,
  CUBE_SLICE_SIZE,
  spreadDepthOffset,
  isSilentWave,
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
// captures the class via this shim — see hypercube.test.ts loader).
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

type Slot = 'floor' | 'wall' | 'ceiling' | 'holo';
const SLOTS: readonly Slot[] = ['floor', 'wall', 'ceiling', 'holo'];

interface LoadMessage {
  type: 'loadWavetable';
  slot: Slot;
  frames: number[][];
}
/** Off-thread slice push (mirrors CUBE issue #4). */
interface SetWaveMessage {
  type: 'setWave';
  waveCenter: Float32Array;
  waveL: Float32Array;
  waveR: Float32Array;
}
/** Enable the off-thread compute path. Sent once by the web factory on init. */
interface OffThreadMessage {
  type: 'offThread';
}
type IncomingMessage = LoadMessage | SetWaveMessage | OffThreadMessage;

/** Posted BY the worklet TO the main thread when the CV-summed slice-shaping
 *  params change enough to need a fresh slice (off-thread mode only). Carries
 *  ALPHA (HYPERCUBE) in addition to CUBE's scalars. */
interface ParamsChangedMessage {
  type: 'paramsChanged';
  sliceY: number; rx: number; ry: number; rz: number;
  morphFC: number; connect: number; crush: number; spread: number;
  fold: number; alpha: number;
  material: 0 | 1; wrap: 0 | 1; tableEpoch: number;
}

/** Read a single sample from a 256-sample frame at a fractional phase. */
function readFrame(frame: Float32Array, phase: number): number {
  const { s1, s2, sFrac } = sampleSplit(phase, frame.length || WAVETABLE_FRAME_SIZE);
  const a = frame[s1] ?? 0;
  const b = frame[s2] ?? 0;
  return a + (b - a) * sFrac;
}

// Not `export`ed at the top level by design — see the file-header note.
class HypercubeProcessor extends AudioWorkletProcessor {
  // Loaded wavetables (empty until the first loadWavetable per slot).
  private floor: Float32Array[] = [];
  private wall: Float32Array[] = [];
  private ceiling: Float32Array[] = [];
  private holo: Float32Array[] = [];

  // Phase accumulator (normalized [0,1)).
  private phase = 0;

  // Per-channel slice waveforms (recomputed on param/table change).
  private waveL: Float32Array<ArrayBufferLike> = new Float32Array(CUBE_SLICE_SIZE);
  private waveR: Float32Array<ArrayBufferLike> = new Float32Array(CUBE_SLICE_SIZE);
  private waveCenter: Float32Array<ArrayBufferLike> = new Float32Array(CUBE_SLICE_SIZE);
  private haveWave = false;

  // Off-thread path: the web factory sends {type:'offThread'} on init.
  private offThread = false;

  // Smoothers for the slice-shaping params (de-zipper the recompute trigger).
  private smMorphFc: WtParamSmoother;
  private smConnect: WtParamSmoother;
  private smCrush: WtParamSmoother;
  private smSpread: WtParamSmoother;
  private smFold: WtParamSmoother;
  private smAlpha: WtParamSmoother;
  private smSliceY: WtParamSmoother;
  private smRx: WtParamSmoother;
  private smRy: WtParamSmoother;
  private smRz: WtParamSmoother;

  // Cached slice signature so we only recompute when a shaping param crossed a
  // quantization step or a table swapped.
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
    this.smFold = new WtParamSmoother(sampleRate);
    this.smAlpha = new WtParamSmoother(sampleRate);
    this.smSliceY = new WtParamSmoother(sampleRate);
    this.smRx = new WtParamSmoother(sampleRate);
    this.smRy = new WtParamSmoother(sampleRate);
    this.smRz = new WtParamSmoother(sampleRate);
    // Prime to defaults so the first block doesn't ramp from 0.
    this.smMorphFc.prime(0);
    this.smConnect.prime(0);
    this.smCrush.prime(0);
    this.smSpread.prime(0);
    this.smFold.prime(0);
    this.smAlpha.prime(0); // ALPHA defaults 0 → HYPERCUBE-off
    this.smSliceY.prime(0.5);
    this.smRx.prime(0);
    this.smRy.prime(0);
    this.smRz.prime(0);
    this.snapInterval = Math.max(1, Math.round(sampleRate / 30));

    if (!this.port) {
      (this as { port: MessagePort }).port = {
        onmessage: null,
        postMessage: () => {},
      } as unknown as MessagePort;
    }
    this.port.onmessage = (e: MessageEvent) => {
      const m = e.data as IncomingMessage;
      if (!m || typeof m !== 'object') return;
      if (m.type === 'offThread') {
        this.offThread = true;
        this.lastSig = '';
        return;
      }
      if (m.type === 'setWave') {
        this.adoptWave(m.waveCenter, 'center');
        this.adoptWave(m.waveL, 'L');
        this.adoptWave(m.waveR, 'R');
        this.haveWave = true;
        return;
      }
      if (m.type === 'loadWavetable') {
        if (!SLOTS.includes(m.slot)) {
          console.error('[hypercube] invalid slot', m.slot);
          return;
        }
        if (!Array.isArray(m.frames) || m.frames.length === 0) {
          console.error('[hypercube] empty frames for slot', m.slot);
          return;
        }
        const next: Float32Array[] = [];
        for (let j = 0; j < m.frames.length; j++) {
          const src = m.frames[j];
          if (!src || src.length !== WAVETABLE_FRAME_SIZE) {
            console.error(
              `[hypercube] ${m.slot} frame ${j} length ${src?.length} != ${WAVETABLE_FRAME_SIZE}`,
            );
            return;
          }
          next.push(Float32Array.from(src));
        }
        if (m.slot === 'floor') this.floor = next;
        else if (m.slot === 'wall') this.wall = next;
        else if (m.slot === 'ceiling') this.ceiling = next;
        else this.holo = next;
        this.tableEpoch++;
      }
    };
  }

  static get parameterDescriptors() {
    return [
      { name: 'tune', defaultValue: 0, minValue: -36, maxValue: 36, automationRate: 'k-rate' as const },
      { name: 'fine', defaultValue: 0, minValue: -100, maxValue: 100, automationRate: 'k-rate' as const },
      { name: 'morph_fc', defaultValue: 0,   minValue: 0,    maxValue: 1, automationRate: 'a-rate' as const },
      { name: 'connect',  defaultValue: 0,   minValue: 0,    maxValue: 1, automationRate: 'a-rate' as const },
      { name: 'crush',    defaultValue: 0,   minValue: 0,    maxValue: 1, automationRate: 'a-rate' as const },
      { name: 'spread',   defaultValue: 0,   minValue: 0,    maxValue: 1, automationRate: 'a-rate' as const },
      { name: 'fold',     defaultValue: 0,   minValue: 0,    maxValue: 1, automationRate: 'a-rate' as const },
      // HYPERCUBE ALPHA — the slice's 4th-dimension (w) coordinate. Default 0 =
      // HYPERCUBE-off (identity to a 3-table render). a-rate so summed CV reaches it.
      { name: 'alpha',    defaultValue: 0,   minValue: 0,    maxValue: 1, automationRate: 'a-rate' as const },
      { name: 'slice_y',  defaultValue: 0.5, minValue: 0,    maxValue: 1, automationRate: 'a-rate' as const },
      { name: 'slice_rx', defaultValue: 0,   minValue: -3.1416, maxValue: 3.1416, automationRate: 'a-rate' as const },
      { name: 'slice_ry', defaultValue: 0,   minValue: -3.1416, maxValue: 3.1416, automationRate: 'a-rate' as const },
      { name: 'slice_rz', defaultValue: 0,   minValue: -3.1416, maxValue: 3.1416, automationRate: 'a-rate' as const },
      { name: 'wrap',     defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' as const },
      { name: 'material', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' as const },
      { name: 'level',    defaultValue: 1, minValue: 0, maxValue: 2, automationRate: 'a-rate' as const },
    ];
  }

  private kval(p: Record<string, Float32Array>, name: string, fallback: number): number {
    const arr = p[name];
    return arr && arr.length > 0 ? (arr[0] as number) : fallback;
  }
  private aval(p: Record<string, Float32Array>, name: string, fallback: number): number {
    const arr = p[name];
    if (!arr || arr.length === 0) return fallback;
    return (arr.length > 1 ? arr[arr.length - 1] : arr[0]) as number;
  }

  private framesLoaded(): boolean {
    return (
      this.floor.length > 0 &&
      this.wall.length > 0 &&
      this.ceiling.length > 0 &&
      this.holo.length > 0
    );
  }

  /** Adopt one posted slice waveform into the named channel, keeping the
   *  previous non-silent wave if the new one is effectively all-zero. */
  private adoptWave(next: Float32Array | undefined, ch: 'center' | 'L' | 'R'): void {
    if (!next || next.length === 0) return;
    const w = next as Float32Array<ArrayBufferLike>;
    if (this.haveWave && isSilentWave(next)) return; // keep last non-silent
    if (ch === 'center') this.waveCenter = w;
    else if (ch === 'L') this.waveL = w;
    else this.waveR = w;
  }

  /** Decide what to do when the (quantized) slice signature or a table changed.
   *  OFF-THREAD: post a `paramsChanged` (incl. ALPHA) so the main thread renders.
   *  ON-THREAD fallback (unit test / standalone): compute the slice here, passing
   *  the HOLO frames + ALPHA into sampleSlice. */
  private maybeRecompute(sp: SliceParams, spread: number, fold: number, alpha: number): boolean {
    const q = (v: number) => Math.round(v * 512);
    const matBit: 0 | 1 = sp.material === 'hard' ? 1 : 0;
    const wrapBit: 0 | 1 = sp.wrap ? 1 : 0;
    const sig =
      `${this.tableEpoch}|${q(sp.morphFC)}|${q(sp.connect)}|${q(sp.crush)}|` +
      `${q(spread)}|${q(sp.sliceY)}|${q(sp.rx)}|${q(sp.ry)}|${q(sp.rz)}|` +
      `${q(fold)}|${q(alpha)}|${matBit}|${wrapBit}`;
    if (sig === this.lastSig && this.haveWave) return false;
    this.lastSig = sig;

    if (this.offThread) {
      const msg: ParamsChangedMessage = {
        type: 'paramsChanged',
        sliceY: sp.sliceY, rx: sp.rx, ry: sp.ry, rz: sp.rz,
        morphFC: sp.morphFC, connect: sp.connect, crush: sp.crush, spread,
        fold, alpha,
        material: matBit, wrap: wrapBit, tableEpoch: this.tableEpoch,
      };
      try { this.port.postMessage(msg); } catch { /* shim */ }
      return true;
    }

    // ALPHA lives on the SliceParams threaded into sampleSlice; the HOLO frames
    // are the trailing arg. Both must be present for the tesseract cross-section.
    const spa: SliceParams = { ...sp, alpha };
    const dL = spreadDepthOffset(spread, -1);
    const dR = spreadDepthOffset(spread, +1);
    const center = sampleSlice(this.floor, this.wall, this.ceiling, spa, 0, this.holo);
    let nextL: Float32Array;
    let nextR: Float32Array;
    if (dL === 0 && dR === 0) {
      nextL = center;
      nextR = center;
    } else {
      nextL = sampleSlice(this.floor, this.wall, this.ceiling, spa, dL, this.holo);
      nextR = sampleSlice(this.floor, this.wall, this.ceiling, spa, dR, this.holo);
    }
    applyFold(center, fold);
    if (nextL !== center) applyFold(nextL, fold);
    if (nextR !== center && nextR !== nextL) applyFold(nextR, fold);
    this.adoptWave(center, 'center');
    this.adoptWave(nextL, 'L');
    this.adoptWave(nextR, 'R');
    this.haveWave = true;
    return true;
  }

  private postSnapshot(): void {
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

    // Silent until all FOUR tables are loaded.
    if (!this.framesLoaded()) {
      outL.fill(0);
      if (outR && outR !== outL) outR.fill(0);
      return true;
    }

    const tune = this.kval(parameters, 'tune', 0);
    const fine = this.kval(parameters, 'fine', 0);
    const wrap = this.kval(parameters, 'wrap', 0) >= 0.5;
    const material: Material = this.kval(parameters, 'material', 0) >= 0.5 ? 'hard' : 'smooth';

    const morphFC = this.smMorphFc.step(this.aval(parameters, 'morph_fc', 0));
    const connect = this.smConnect.step(this.aval(parameters, 'connect', 0));
    const crush = this.smCrush.step(this.aval(parameters, 'crush', 0));
    const spread = this.smSpread.step(this.aval(parameters, 'spread', 0));
    const fold = this.smFold.step(this.aval(parameters, 'fold', 0));
    const alpha = this.smAlpha.step(this.aval(parameters, 'alpha', 0));
    const sliceY = this.smSliceY.step(this.aval(parameters, 'slice_y', 0.5));
    const rx = this.smRx.step(this.aval(parameters, 'slice_rx', 0));
    const ry = this.smRy.step(this.aval(parameters, 'slice_ry', 0));
    const rz = this.smRz.step(this.aval(parameters, 'slice_rz', 0));

    const sp: SliceParams = { sliceY, rx, ry, rz, morphFC, connect, material, crush, wrap };
    this.maybeRecompute(sp, spread, fold, alpha);

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
      const phaseN = this.phase;
      const l = readFrame(this.waveL, phaseN) * level;
      const r = readFrame(this.waveR, phaseN) * level;
      outL[i] = clampRange(l, -4, 4);
      if (outR && outR !== outL) outR[i] = clampRange(r, -4, 4);
    }
    void frameLen;

    this.snapAccum += n;
    if (this.snapAccum >= this.snapInterval) {
      this.snapAccum = 0;
      this.postSnapshot();
    }

    return true;
  }
}

registerProcessor('hypercube', HypercubeProcessor);
