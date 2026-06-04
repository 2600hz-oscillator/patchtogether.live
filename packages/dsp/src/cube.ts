// packages/dsp/src/cube.ts
//
// CUBE — 3D wavetable-navigator oscillator (slice 2 of ~8): the AudioWorklet
// V/oct oscillator. See .myrobots/CUBE/PLAN.md §3/§5 for the design + the pure
// field/slice DSP in ./lib/cube-dsp.ts (slice 1, already merged).
//
// What this worklet owns:
//   * Three loaded wavetables (FLOOR / WALL / CEILING), received via port
//     messages ({type:'loadWavetable', slot:'floor'|'wall'|'ceiling', frames}).
//   * Phase accumulation through three posted slice waveforms (L / R / center)
//     at the V/oct frequency (reusing lib/wavetable-osc's sampleSplit + linear
//     sample interpolation). This is the cheap hot path: a pointer-walk through
//     256 floats — no field math on the audio thread.
//
// DROPOUT FIX (issue #4): the expensive SURFACE-HEIGHT SCAN (cube-dsp.sampleSlice
//   — ~256·96 field reads, up to 3× for center/L/R) used to run INSIDE process()
//   on the audio thread on every quantized param change, blocking the render and
//   underrunning. The slice is now computed OFF the audio thread (on the main
//   thread in the web factory) and pushed in via a {type:'setWave', waveL,
//   waveR, waveCenter} port message. The worklet only ever phase-accumulates
//   through the posted waves. A legacy on-thread fallback remains for the unit
//   test / standalone harness path (no setWave ever posted): it is disabled the
//   instant the first setWave arrives, so production never computes on-thread.
//
//   * Stereo L/R spread: the factory renders the L channel at a negative depth
//     offset and the R channel at a positive one (bounded, musical) so the two
//     posted waves differ audibly — and CUBE now exposes SEPARATE L and R output
//     PORTS (issue #1) so the spread survives downstream (a single stereo port
//     downmixes to mono into a mono input, erasing the spread). At spread=0 both
//     posted waves equal the center slice → identical L/R (mono).
//   * NO-SILENCE-ON-SWEEP (issue #4): if a freshly posted (or on-thread
//     computed) wave is effectively all-zero — e.g. the slice rotated/moved
//     fully outside the cube with WRAP off — the worklet KEEPS the previous
//     non-silent wave instead of cutting to silence, so sweeping any param never
//     drops the sound out.
//   * Posting a viz snapshot (~30 Hz) of the current center-slice waveform to
//     the card via port (the card also renders the full 3D cube itself).
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
// Outputs (one stereo output, 2 channels — the web factory fans these into
// SEPARATE L and R node ports via a ChannelSplitter so the spread survives):
//   outputs[0] = [L, R]

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
/** Off-thread slice push (issue #4): the main thread computed the three slice
 *  waveforms (center / L / R) and hands them over so the audio thread never runs
 *  the surface-height scan. Buffers are transferred (zero-copy) where possible. */
interface SetWaveMessage {
  type: 'setWave';
  waveCenter: Float32Array;
  waveL: Float32Array;
  waveR: Float32Array;
}
/** Enable the off-thread compute path (issue #4). Sent once by the web factory
 *  on init. Switches the worklet from the legacy on-thread surface-height scan
 *  to posting a `paramsChanged` message whenever the (CV-summed) slice-shaping
 *  params cross a quantization step — the factory then computes the slice and
 *  posts it back via setWave. The unit-test / standalone harness never sends
 *  this, so it keeps the self-sufficient on-thread fallback. */
interface OffThreadMessage {
  type: 'offThread';
}
type IncomingMessage = LoadMessage | SetWaveMessage | OffThreadMessage;

/** Posted BY the worklet TO the main thread when the CV-summed slice-shaping
 *  params change enough to need a fresh slice (off-thread mode only). */
interface ParamsChangedMessage {
  type: 'paramsChanged';
  sliceY: number; rx: number; ry: number; rz: number;
  morphFC: number; connect: number; crush: number; spread: number;
  fold: number;
  spaceCrush: number; spaceDiffuse: number; connectStrength: number;
  material: 0 | 1; wrap: 0 | 1; tableEpoch: number;
}

/** Read a single sample from a 256-sample frame at a fractional phase using the
 *  same (s1,s2,sFrac) split the wavetable engine uses. */
function readFrame(frame: Float32Array, phase: number): number {
  const { s1, s2, sFrac } = sampleSplit(phase, frame.length || WAVETABLE_FRAME_SIZE);
  const a = frame[s1] ?? 0;
  const b = frame[s2] ?? 0;
  return a + (b - a) * sFrac;
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

  // Off-thread path (issue #4): the web factory sends {type:'offThread'} on
  // init → offThread=true. In that mode the audio thread NEVER runs the
  // surface-height scan; instead it posts `paramsChanged` (cheap k-rate scalars)
  // when the CV-summed shaping params cross a quantization step, and the main
  // thread computes the slice + posts it back via setWave. The unit-test /
  // standalone harness never sends `offThread`, so it keeps the self-sufficient
  // on-thread fallback in maybeRecompute().
  private offThread = false;

  // Smoothers for the slice-shaping params (de-zipper the recompute trigger).
  private smMorphFc: WtParamSmoother;
  private smConnect: WtParamSmoother;
  private smCrush: WtParamSmoother;
  private smSpread: WtParamSmoother;
  private smFold: WtParamSmoother;
  private smSliceY: WtParamSmoother;
  private smRx: WtParamSmoother;
  private smRy: WtParamSmoother;
  private smRz: WtParamSmoother;
  private smSpaceCrush: WtParamSmoother;
  private smSpaceDiffuse: WtParamSmoother;
  private smConnectStrength: WtParamSmoother;

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
    this.smFold = new WtParamSmoother(sampleRate);
    this.smSliceY = new WtParamSmoother(sampleRate);
    this.smRx = new WtParamSmoother(sampleRate);
    this.smRy = new WtParamSmoother(sampleRate);
    this.smRz = new WtParamSmoother(sampleRate);
    this.smSpaceCrush = new WtParamSmoother(sampleRate);
    this.smSpaceDiffuse = new WtParamSmoother(sampleRate);
    this.smConnectStrength = new WtParamSmoother(sampleRate);
    // Prime to defaults so the first block doesn't ramp from 0.
    this.smMorphFc.prime(0);
    this.smConnect.prime(0);
    this.smCrush.prime(0);
    this.smSpread.prime(0);
    this.smFold.prime(0);
    this.smSliceY.prime(0.5);
    this.smRx.prime(0);
    this.smRy.prime(0);
    this.smRz.prime(0);
    this.smSpaceCrush.prime(0);
    this.smSpaceDiffuse.prime(0);
    this.smConnectStrength.prime(0);
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
      if (m.type === 'offThread') {
        this.offThread = true;
        // Force a paramsChanged on the next block so the factory renders an
        // initial slice immediately rather than waiting for the first knob move.
        this.lastSig = '';
        return;
      }
      if (m.type === 'setWave') {
        // Off-thread slice push: adopt the three posted waveforms. Keep the
        // previous non-silent wave if a channel arrived all-zero (slice swept
        // outside the cube with WRAP off) so the audio never drops out.
        this.adoptWave(m.waveCenter, 'center');
        this.adoptWave(m.waveL, 'L');
        this.adoptWave(m.waveR, 'R');
        this.haveWave = true;
        return;
      }
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
      { name: 'space_crush',      defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'a-rate' as const },
      { name: 'space_diffuse',    defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'a-rate' as const },
      { name: 'connect_strength', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'a-rate' as const },
      { name: 'spread',   defaultValue: 0,   minValue: 0,    maxValue: 1, automationRate: 'a-rate' as const },
      { name: 'fold',     defaultValue: 0,   minValue: 0,    maxValue: 1, automationRate: 'a-rate' as const },
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

  /** Adopt one posted slice waveform into the named channel, but KEEP the
   *  previous non-silent wave if the new one is effectively all-zero (the slice
   *  swept fully outside the cube with WRAP off). This is the no-dropout rule
   *  (issue #4): a normal param move never cuts the sound to silence. The very
   *  first posted wave is always adopted (there's no prior wave to keep). */
  private adoptWave(next: Float32Array | undefined, ch: 'center' | 'L' | 'R'): void {
    if (!next || next.length === 0) return;
    const w = next as Float32Array<ArrayBufferLike>;
    if (this.haveWave && isSilentWave(next)) return; // keep last non-silent
    if (ch === 'center') this.waveCenter = w;
    else if (ch === 'L') this.waveL = w;
    else this.waveR = w;
  }

  /** Decide what to do when the (quantized) slice signature or a table changed.
   *
   *  OFF-THREAD mode (production, issue #4): post a cheap `paramsChanged` scalar
   *  message so the MAIN thread runs the surface-height scan + posts the slice
   *  back via setWave. The audio thread does NO field math.
   *
   *  ON-THREAD fallback (unit test / standalone harness only): compute the
   *  L/R/center slice waveforms here, applying the same keep-last-non-silent
   *  rule as the posted path so a sweep outside the cube doesn't drop out. */
  private maybeRecompute(sp: SliceParams, spread: number, fold: number): boolean {
    // Quantize the continuous shaping params so we don't churn every block on
    // float jitter — but finely enough that a sweep is smooth (~512 steps).
    const q = (v: number) => Math.round(v * 512);
    const matBit: 0 | 1 = sp.material === 'hard' ? 1 : 0;
    const wrapBit: 0 | 1 = sp.wrap ? 1 : 0;
    const sig =
      `${this.tableEpoch}|${q(sp.morphFC)}|${q(sp.connect)}|${q(sp.crush)}|` +
      `${q(spread)}|${q(sp.sliceY)}|${q(sp.rx)}|${q(sp.ry)}|${q(sp.rz)}|` +
      `${q(fold)}|${matBit}|${wrapBit}` +
      `|${q(sp.spaceCrush ?? 0)}|${q(sp.spaceDiffuse ?? 0)}|${q(sp.connectStrength ?? 0)}`;
    if (sig === this.lastSig && this.haveWave) return false;
    this.lastSig = sig;

    if (this.offThread) {
      // Hand the work to the main thread — no field scan on the audio thread.
      const msg: ParamsChangedMessage = {
        type: 'paramsChanged',
        sliceY: sp.sliceY, rx: sp.rx, ry: sp.ry, rz: sp.rz,
        morphFC: sp.morphFC, connect: sp.connect, crush: sp.crush, spread,
        fold,
        spaceCrush: sp.spaceCrush ?? 0,
        spaceDiffuse: sp.spaceDiffuse ?? 0,
        connectStrength: sp.connectStrength ?? 0,
        material: matBit, wrap: wrapBit, tableEpoch: this.tableEpoch,
      };
      try { this.port.postMessage(msg); } catch { /* shim */ }
      return true;
    }

    const dL = spreadDepthOffset(spread, -1);
    const dR = spreadDepthOffset(spread, +1);
    const center = sampleSlice(this.floor, this.wall, this.ceiling, sp, 0);
    let nextL: Float32Array;
    let nextR: Float32Array;
    if (dL === 0 && dR === 0) {
      nextL = center;
      nextR = center;
    } else {
      nextL = sampleSlice(this.floor, this.wall, this.ceiling, sp, dL);
      nextR = sampleSlice(this.floor, this.wall, this.ceiling, sp, dR);
    }
    // FOLD (West-coast wavefolder): applied AFTER the slice is sampled and
    // BEFORE the output level/gain, on BOTH L and R (and the center viz wave).
    // applyFold is in-place + identity at fold=0, so the unfolded path stays
    // byte-stable (ART baselines unaffected). nextL/nextR may alias `center`
    // (spread=0) — fold center FIRST then derive, to avoid double-folding.
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
    const spaceCrush = this.smSpaceCrush.step(this.aval(parameters, 'space_crush', 0));
    const spaceDiffuse = this.smSpaceDiffuse.step(this.aval(parameters, 'space_diffuse', 0));
    const connectStrength = this.smConnectStrength.step(this.aval(parameters, 'connect_strength', 0));
    const spread = this.smSpread.step(this.aval(parameters, 'spread', 0));
    const fold = this.smFold.step(this.aval(parameters, 'fold', 0));
    const sliceY = this.smSliceY.step(this.aval(parameters, 'slice_y', 0.5));
    const rx = this.smRx.step(this.aval(parameters, 'slice_rx', 0));
    const ry = this.smRy.step(this.aval(parameters, 'slice_ry', 0));
    const rz = this.smRz.step(this.aval(parameters, 'slice_rz', 0));

    const sp: SliceParams = {
      sliceY, rx, ry, rz, morphFC, connect, material, crush, wrap,
      spaceCrush, spaceDiffuse, connectStrength,
    };
    this.maybeRecompute(sp, spread, fold);

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
