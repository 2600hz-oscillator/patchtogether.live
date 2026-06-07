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
// POLYPHONY (poly input — feat/poly-in-wavcel-cube):
//   inputs[1] is a 10-channel `polyPitchGate` bus (5 voice lanes of pitch+gate;
//   ch 2i = lane-i V/oct, ch 2i+1 = lane-i gate). It's the SAME cable MIDI LANE
//   (mode='poly') + POLYSEQZ emit (see packages/web/src/lib/audio/poly.ts).
//   CUBE phase-accumulates through the posted slice waveforms (waveL/waveR);
//   that slice is a TIMBRE shared by all voices, so polyphony = N independent
//   phase accumulators reading the SAME posted waves at per-lane pitch, summed.
//   When NO lane is gated (poly unpatched / all gates closed) the render falls
//   through to the original single-phase mono path — BYTE-IDENTICAL, so the
//   SYNC output, spread, fold, and ART/VRT baselines are untouched. SYNC tracks
//   the mono `phase` accumulator (lane-0 in poly mode).
//
// Inputs (single-channel CV node connections; CV→AudioParam summing is done by
// the web factory, so the worklet just reads the resulting AudioParam):
//   inputs[0] = pitch  — V/oct pitch CV (0V = C4). The ONLY audio-rate node
//                        input the worklet reads directly; the rest of the CV
//                        inputs are summed into AudioParams by the factory.
//   inputs[1] = poly   — 10-channel polyPitchGate bus (see POLYPHONY above).
//
// Outputs:
//   outputs[0] = [L, R] — the slice audio (one stereo output, 2 channels; the
//                web factory fans these into SEPARATE L and R node ports via a
//                ChannelSplitter so the spread survives). BYTE-IDENTICAL to the
//                pre-SYNC behavior — the SYNC output below is purely additive.
//   outputs[1] = [SYNC] — a pure SINE at the playback fundamental, PHASE-LOCKED
//                to the slice readout (it reuses the SAME `phase` accumulator, so
//                it tracks pitch + tune + fine exactly and stays in lock with the
//                main output). Players hard-sync other oscillators to CUBE or use
//                it as a clean reference / sub. Mono, ~±1. NOT scaled by LEVEL
//                (it's a reference, not part of the voice's loudness).

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
import { Envelope } from './lib/adsr-env';
import {
  polyEnvSum,
  monoEnvSample,
  updateHeldPitch,
  laneRenderVOct,
  type AdsrParams,
} from './lib/poly-osc-sum';

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

// Poly bus shape (mirrors packages/web/src/lib/audio/poly.ts): 5 voice lanes,
// 10 channels (ch 2i = lane-i pitch V/oct, ch 2i+1 = lane-i gate).
const POLY_VOICES = 5;

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

  // Phase accumulator (normalized [0,1)). Doubles as poly lane 0 + the SYNC /
  // mono phase, so the mono path is byte-identical when no poly lane is gated.
  private phase = 0;
  // Per-poly-lane phase accumulators for lanes 1..4 (lane 0 reuses `phase`).
  // Each is an independent [0,1) accumulator reading the SAME posted slice
  // waves at its own pitch. Only used while the poly bus carries a gate.
  private polyPhase: Float64Array = new Float64Array(POLY_VOICES);
  // PERSISTENT per-lane held V/oct — UPDATED while a lane is gated, HELD (never
  // reset) when it's not, so a releasing voice (gate low, env>0) keeps advancing
  // at the played pitch instead of snapping to 0 V/oct (C4). See updateHeldPitch
  // / laneRenderVOct in lib/poly-osc-sum.ts. Starts at 0 (= C4) for never-played
  // lanes, which matches the legacy behavior for a lane that has never gated.
  private heldVOct: Float64Array = new Float64Array(POLY_VOICES);

  // ── Per-voice amplitude ADSR (per-voice-ADSR feature) ──
  // One Envelope per lane. The poly path gate-edges drive env[lane]; the mono
  // TRIGGER input drives env[0]. The GATING MODE is decided by connectedness
  // (poly_connected / trigger_connected params), NOT a first-edge latch: when
  // poly OR trigger is connected the module is GATED (a voice sounds only while
  // gated-or-releasing); when neither is connected it's a continuous raw VCO.
  private env: Envelope[] = Array.from({ length: POLY_VOICES }, () => new Envelope());
  // Previous-block gate per poly lane (rising/falling edge detection).
  private prevGate: Uint8Array = new Uint8Array(POLY_VOICES);
  // Previous-block state of the mono TRIGGER input.
  private prevTrigGate = 0;
  // Reused per-sample scratch for the per-lane (L,R) reads handed to polyEnvSum.
  private laneScratchL = new Float64Array(POLY_VOICES);
  private laneScratchR = new Float64Array(POLY_VOICES);

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
      // Per-voice amplitude ADSR (per-voice-ADSR feature). A single shared
      // A/D/S/R set feeds all 5 lane envelopes; defaults are ~pass-through so an
      // untouched ADSR + an ungated/unpatched TRIGGER keeps the legacy drone
      // byte-identical. k-rate (read once per block, fed to every lane tick).
      { name: 'attack',  defaultValue: 0.001, minValue: 0.001, maxValue: 5, automationRate: 'k-rate' as const },
      { name: 'decay',   defaultValue: 0.1,   minValue: 0.001, maxValue: 5, automationRate: 'k-rate' as const },
      { name: 'sustain', defaultValue: 1,     minValue: 0,     maxValue: 1, automationRate: 'k-rate' as const },
      { name: 'release', defaultValue: 0.005, minValue: 0.001, maxValue: 5, automationRate: 'k-rate' as const },
      // Per-voice VCA FLOOR the envelope rides on top of: gain = base+(1-base)*env
      // per ACTIVE voice. base=1 (default) → gain=1, the env does nothing → the
      // raw-VCO drone is byte-identical (back-compat). base=0 → pure ADSR. k-rate.
      { name: 'base_vol', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' as const },
      // CONNECTEDNESS flags (k-rate, 0/1) pushed by the web factory from the live
      // patch edges — NOT from bus presence, which the trigger keep-alive
      // ConstantSource masks (the input is always present). When poly OR trigger
      // is connected the module is GATED (a voice sounds only while gated-or-
      // releasing); when NEITHER is connected it's a continuous raw VCO. This is
      // the no-stray-drone fix: a patched-but-ungated poly/trigger no longer
      // falls through to the mono drone.
      { name: 'poly_connected',    defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' as const },
      { name: 'trigger_connected', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' as const },
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
    // SYNC reference output (output 1, mono). Optional — older graphs / harnesses
    // may construct the node with a single output; guard so the slice path is
    // untouched when it's absent.
    const outSync = outputs[1]?.[0];
    // Chrome hands `process()` an EMPTY channel array for any output that has no
    // active downstream connection — so when ONLY `sync` is patched, outputs[0]
    // is [] (outL undefined) and vice-versa. Drive the block off whichever
    // output is live; bail only if nothing is connected at all. (Previously this
    // bailed on `!outL`, which silenced SYNC whenever the L/R output was the
    // unpatched one.)
    const n = outL?.length ?? outSync?.length ?? 0;
    if (n === 0) return true;

    // Silent until all three tables are loaded. SYNC tracks the voice: no voice
    // (no tables) → no reference tone, so it stays silent here too.
    if (!this.framesLoaded()) {
      if (outL) outL.fill(0);
      if (outR && outR !== outL) outR.fill(0);
      if (outSync) outSync.fill(0);
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

    // ── Per-voice ADSR params (k-rate; read once, fed to every lane env) ──
    const adsr: AdsrParams = {
      attack:  this.kval(parameters, 'attack', 0.001),
      decay:   this.kval(parameters, 'decay', 0.1),
      sustain: this.kval(parameters, 'sustain', 1),
      release: this.kval(parameters, 'release', 0.005),
    };
    // Per-voice VCA floor (gain = base + (1-base)*env per ACTIVE voice).
    const baseVol = this.kval(parameters, 'base_vol', 1);
    // CONNECTEDNESS (from the factory via k-rate params, not bus presence).
    const polyConnParam = this.kval(parameters, 'poly_connected', 0) >= 0.5;
    const trigConnParam = this.kval(parameters, 'trigger_connected', 0) >= 0.5;

    // ── Poly bus (inputs[1], 10-channel polyPitchGate) ──
    // Sample gate + pitch once at the first sample of the block (sequencer /
    // MIDI LANE write setValueAtTime at block boundaries → first-sample reads
    // are exact). The shared timbre offset (tune/fine) applies to every lane.
    //
    // NOTE on retrigger granularity (CRITIQUE C4): edges are detected ONCE at
    // sample 0, so a sub-block 1→0→1 re-strike (faster than ~one block, ≈2.67 ms
    // @ 48 k) is missed. The retrig floor is ≈one block; this is not "exact" for
    // sub-block events. An intra-block gate scan is a documented follow-up.
    const polyIn = inputs[1];
    const trim = tune / 12 + fine / 1200;
    const laneGate: boolean[] = [false, false, false, false, false];
    let anyPolyGate = false;
    if (polyIn) {
      for (let lane = 0; lane < POLY_VOICES; lane++) {
        const gateCh = polyIn[lane * 2 + 1];
        const pitchCh = polyIn[lane * 2];
        const g = gateCh && gateCh.length > 0 ? (gateCh[0] ?? 0) : 0;
        const gated = g > 0.5;
        if (gated) {
          laneGate[lane] = true;
          anyPolyGate = true;
        }
        // Track this lane's pitch while gated; HOLD it through release. A
        // releasing voice (gate low, env still audible) advances at the held
        // (played) pitch, not 0 V/oct = C4 — the release-tail pitch fix.
        const lanePitch = pitchCh && pitchCh.length > 0 ? (pitchCh[0] ?? 0) : 0;
        this.heldVOct[lane] = updateHeldPitch(this.heldVOct[lane]!, gated, lanePitch);
      }
    }

    // ── Mono TRIGGER input (inputs[2], 1-channel gate) → lane-0 envelope ──
    const trigIn = inputs[2]?.[0];
    const trigGate = trigIn && trigIn.length > 0 ? ((trigIn[0] ?? 0) > 0.5 ? 1 : 0) : 0;

    // Gate-edge detection per poly lane → soft (click-safe) retrigger.
    for (let lane = 0; lane < POLY_VOICES; lane++) {
      const now = laneGate[lane] ? 1 : 0;
      if (now && !this.prevGate[lane]) this.env[lane]!.triggerSoft(true);
      else if (!now && this.prevGate[lane]) this.env[lane]!.triggerSoft(false);
      this.prevGate[lane] = now as number;
    }
    // Mono TRIGGER edge → lane-0 envelope (only meaningful in the gated-MONO path).
    // Suppressed whenever poly is connected or a poly gate is live — the poly
    // lane-0 edges own env[0] in poly mode, and a patched poly bus takes priority.
    if (!polyConnParam && !anyPolyGate) {
      if (trigGate && !this.prevTrigGate) this.env[0]!.triggerSoft(true);
      else if (!trigGate && this.prevTrigGate) this.env[0]!.triggerSoft(false);
    }
    this.prevTrigGate = trigGate;

    // ── GATING MODE (no-stray-drone fix) ──
    // CONNECTEDNESS drives the mode, NOT bus presence (the trigger keep-alive
    // ConstantSource always makes inputs[2] present, masking it). A live gate also
    // implies connectedness (covers the unit-test path that drives a poly bus
    // directly without the connectedness param).
    const polyConn = polyConnParam || anyPolyGate;
    const trigConn = trigConnParam || trigGate === 1;
    // POLY mode: poly is connected → render the per-lane env sum. A never-gated
    // lane stays silent (polyEnvSum excludes inactive lanes), so patching poly no
    // longer auto-drones. Releasing tails finish (env-audible lanes stay active).
    const polyActive = polyConn;
    // GATED-MONO mode: trigger connected (poly not) → lane-0's env shapes the mono
    // oscillator; silent until the first hit, base-floored once active.
    const gatedMono = !polyActive && trigConn;
    // Otherwise (NOTHING connected): the continuous raw VCO. The single voice is
    // "always active"; with no gate the env is idle (0) so its gain = baseVol —
    // baseVol=1 (default) reproduces the legacy continuous drone byte-identically.

    /** Advance a [0,1) phase accumulator by one sample at a V/oct pitch. */
    const advance = (ph: number, voct: number): number => {
      let freq = C4_HZ * Math.pow(2, voct);
      if (freq < 1) freq = 1;
      else if (freq > sr * 0.5) freq = sr * 0.5;
      ph += freq / sr;
      while (ph >= 1) ph -= 1;
      while (ph < 0) ph += 1;
      return ph;
    };

    const frameLen = this.waveCenter.length || CUBE_SLICE_SIZE;
    // Scratch per-lane sample buffers for the poly env sum (reused per sample).
    const laneL = this.laneScratchL;
    const laneR = this.laneScratchR;
    for (let i = 0; i < n; i++) {
      const level = levelArr
        ? (levelArr.length > 1 ? (levelArr[i] as number) : (levelArr[0] as number))
        : 1;

      if (polyActive) {
        // Polyphonic: read each lane's shared slice waves at its own pitch, then
        // hand the per-lane (L,R) samples to polyEnvSum, which ticks every lane
        // envelope, applies the per-voice VCA gain (base + (1-base)*env) to each
        // ACTIVE (gated-or-releasing) lane, sums them, and returns the active-voice
        // normalization. A NEVER-gated lane stays SILENT (excluded) regardless of
        // baseVol — patching poly never auto-drones (the no-stray-drone fix). A
        // lane in RELEASE keeps sounding (env>0). Lane 0 reuses `this.phase` (SYNC
        // + a single held poly note line up with the mono path); lanes 1..4 use
        // polyPhase[]. Silent lanes still advance (tracked at lane-0 pitch) so a
        // re-opened lane doesn't pop.
        // Lane 0. Held pitch (gated OR releasing → own pitch; else lane-0's).
        const v0 = laneRenderVOct(
          this.heldVOct, 0, laneGate[0]!, this.env[0]!.value > 0,
        );
        this.phase = advance(this.phase, v0 + trim);
        laneL[0] = readFrame(this.waveL, this.phase);
        laneR[0] = readFrame(this.waveR, this.phase);
        // Lanes 1..4.
        for (let lane = 1; lane < POLY_VOICES; lane++) {
          // Use the lane's own HELD pitch when it's gated OR still releasing
          // (env>0) — so a released note's tail keeps its played pitch; otherwise
          // track lane-0's held pitch so a re-open doesn't pop.
          const v = laneRenderVOct(
            this.heldVOct, lane, laneGate[lane]!, this.env[lane]!.value > 0,
          );
          this.polyPhase[lane] = advance(this.polyPhase[lane]!, v + trim);
          laneL[lane] = readFrame(this.waveL, this.polyPhase[lane]!);
          laneR[lane] = readFrame(this.waveR, this.polyPhase[lane]!);
        }
        const { sumL, sumR, polyNorm } = polyEnvSum(
          laneL, laneR, this.env, adsr, sr, laneGate, baseVol,
        );
        const l = sumL * polyNorm * level;
        const r = sumR * polyNorm * level;
        if (outL) outL[i] = clampRange(l, -4, 4);
        if (outR && outR !== outL) outR[i] = clampRange(r, -4, 4);
        // SYNC tracks lane 0 (the mono phase accumulator).
        if (outSync) outSync[i] = Math.sin(2 * Math.PI * this.phase);
      } else if (gatedMono) {
        // Gated mono (TRIGGER connected; poly unpatched). The mono oscillator is
        // scaled by lane-0's per-voice VCA gain (base + (1-base)*env). The voice
        // is ACTIVE only while gated-or-releasing → silent until the first hit,
        // base-floored once active (so a patched-but-never-hit TRIGGER does not
        // drone even at baseVol > 0).
        const pitch = pIn ? (pIn[i] ?? 0) : 0;
        this.phase = advance(this.phase, pitch + trim);
        const phaseN = this.phase;
        const active = trigGate === 1 || this.env[0]!.value > 0;
        const { l: el, r: er } = monoEnvSample(
          readFrame(this.waveL, phaseN), readFrame(this.waveR, phaseN),
          this.env[0]!, adsr, sr, baseVol, active,
        );
        if (outL) outL[i] = clampRange(el * level, -4, 4);
        if (outR && outR !== outL) outR[i] = clampRange(er * level, -4, 4);
        if (outSync) outSync[i] = Math.sin(2 * Math.PI * phaseN);
      } else {
        // Raw VCO (NOTHING connected to poly or trigger): the single mono voice is
        // "always active". With no gate the env is idle (0), so its VCA gain is
        // baseVol — baseVol=1 (default) reproduces the legacy continuous drone
        // BYTE-IDENTICALLY (no env multiply), baseVol=0 is silent. baseVol IS the
        // raw-VCO level, replacing the old first-edge drone latch with a user knob.
        const pitch = pIn ? (pIn[i] ?? 0) : 0;
        this.phase = advance(this.phase, pitch + trim);
        // Phase maps to a fractional column index across the 256-sample frame.
        const phaseN = this.phase;
        const l = readFrame(this.waveL, phaseN) * baseVol * level;
        const r = readFrame(this.waveR, phaseN) * baseVol * level;
        if (outL) outL[i] = clampRange(l, -4, 4);
        if (outR && outR !== outL) outR[i] = clampRange(r, -4, 4);
        // SYNC: a pure SINE at the playback fundamental, read from the SAME phase
        // accumulator as the slice → automatically PHASE-LOCKED to the main output
        // (it advances by the identical freq/sr step per sample). Not gain-scaled
        // by LEVEL — it's a clean ±1 reference / sub for hard-syncing downstream.
        if (outSync) outSync[i] = Math.sin(2 * Math.PI * phaseN);
      }
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
