// packages/web/src/lib/audio/modules/cube.ts
//
// CUBE — 3D wavetable-navigator oscillator (slice 3): the web AudioModuleDef +
// factory. See .myrobots/CUBE/PLAN.md for the design.
//
// CUBE builds a 3D scalar field out of THREE e352 wavetables (FLOOR / WALL /
// CEILING) and reads an arbitrary planar slice through it as the played
// waveform (surface-height scan). It's a pitched V/oct oscillator with stereo
// ±5% spread. The pure field/slice DSP lives in
// packages/dsp/src/lib/cube-dsp.ts; the AudioWorklet that runs it is
// packages/dsp/src/cube.ts (registerProcessor('cube', …)).
//
// Wavetable selection rides node.data (per slot: cubeFloor / cubeWall /
// cubeCeiling, each { source, frames?, label? } like WAVESCULPT's per-osc data).
// The factory polls livePatch.nodes[id].data and reposts changed tables to the
// worklet via { type:'loadWavetable', slot, frames }. Defaults on spawn:
//   FLOOR=basic-shapes, WALL=harmonic-sweep, CEILING=basic-shapes.
//
// Params (LITERAL arrays — the module-manifest static extractor can't read
// computed/spread arrays): see `params` below + PLAN §6.
//
// Inputs:  pitch (V/oct node) + CV→AudioParam for slice_y/rx/ry/rz, morph_fc,
//          connect, crush, tune + poly (10-channel polyPitchGate chord bus).
//          When the poly bus carries any gate, CUBE renders one phase
//          accumulator per gated lane through the SAME posted slice waves at
//          that lane's pitch and SUMS them — polyphonic. Unpatched (or no gate)
//          → the mono `pitch` path runs unchanged (back-compat).
// Outputs: SEPARATE L and R audio ports (issue #1) — the worklet's 2-channel
//          output 0 is fanned out through a ChannelSplitter(2) so the ±SPREAD
//          stereo width survives downstream (a single stereo port downmixes to
//          mono into a mono input, erasing the spread). Plus a SYNC port — a
//          pure sine at the playback fundamental, phase-locked to the slice
//          readout (the worklet's mono output 1), exposed directly for
//          hard-syncing other oscillators or a clean reference / sub.
//
// OFF-THREAD SLICE COMPUTE (issue #4): the expensive SURFACE-HEIGHT SCAN
//   (sampleSlice) runs HERE on the main thread, not on the audio thread. On
//   init the factory tells the worklet to go off-thread; the worklet then posts
//   `paramsChanged` (cheap CV-summed scalars) whenever the slice needs a redo,
//   the factory renders the L/R/center waveforms and posts them back via
//   setWave. The audio thread only phase-accumulates → no dropouts. See the
//   worklet header in packages/dsp/src/cube.ts for the protocol.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import { patch as livePatch } from '$lib/graph/store';
import workletUrl from '@patchtogether.live/dsp/dist/cube.js?url';
import {
  framesToPlain,
  framesFromPlain,
  getFactoryTable,
  DEFAULT_FACTORY_TABLE_ID,
} from '$lib/audio/wavetable-factory-tables';
// Pure field/slice DSP — imported via a RELATIVE path (not the `@patchtogether
// .live/dsp/src/...` alias) for the same reason bluebox.ts does: worktrees may
// not symlink the workspace package under node_modules, and the worklet asset
// pipeline / TS path-alias rules don't reliably resolve TS source out of
// node_modules/@patchtogether.live/dsp/src. sampleSlice here is the IDENTICAL
// function the (fallback) worklet + node-ART run, so the off-thread waveform is
// byte-for-byte what the on-thread path would have produced.
import {
  sampleSlice,
  applyFold,
  spreadDepthOffset,
  isSilentWave,
  type SliceParams,
  type Material,
} from '../../../../../dsp/src/lib/cube-dsp';

const PROCESSOR_NAME = 'cube';
const POLL_MS = 200;
const loadedContexts = new WeakSet<BaseAudioContext>();

// ---------- card → module frame-drawer registry (video_out) ----------
//
// The 3D CUBE WebGL render lives in CubeCard.svelte (the card owns the GL
// context + offscreen canvas). The cross-domain video_out bridge needs a
// drawFrame(canvas) callback; the card installs one here keyed by node id (the
// SAME pattern WAVESCULPT uses for its video_out). When nothing is installed
// (card not mounted / GL unavailable) the module's drawFrame paints black so
// the bridge always has a valid frame.
type FrameDrawer = (canvas: OffscreenCanvas | HTMLCanvasElement) => void;
const FRAME_DRAWERS: Map<string, FrameDrawer> = new Map();
export function installCubeFrameDrawer(nodeId: string, fn: FrameDrawer): void {
  FRAME_DRAWERS.set(nodeId, fn);
}
export function uninstallCubeFrameDrawer(nodeId: string): void {
  FRAME_DRAWERS.delete(nodeId);
}

export type CubeSlot = 'floor' | 'wall' | 'ceiling';
export const CUBE_SLOTS: readonly CubeSlot[] = ['floor', 'wall', 'ceiling'];

/** Per-slot wavetable defaults (PLAN §4). */
export const CUBE_DEFAULT_TABLES: Record<CubeSlot, string> = {
  floor: 'basic-shapes',
  wall: 'harmonic-sweep',
  ceiling: 'basic-shapes',
};

/** Per-slot wavetable selection, persisted on node.data. Mirrors WAVESCULPT's
 *  WavesculptOscData shape. `source` is 'factory:<id>' or 'user'. */
export interface CubeSlotData {
  source?: string;
  frames?: number[][];
  label?: string;
}
export interface CubeData {
  floor?: CubeSlotData;
  wall?: CubeSlotData;
  ceiling?: CubeSlotData;
}

interface ResolvedFrames {
  frames: Float32Array[];
  label: string;
  signature: string;
}

/** Resolve a slot's frames from its node.data entry, falling back to the
 *  slot's default factory table. Reuses the SAME factory-table + frame-plain
 *  helpers as WAVESCULPT (no duplication). */
export function resolveSlotFrames(
  slot: CubeSlot,
  slotData: CubeSlotData | undefined,
): ResolvedFrames {
  const src = slotData?.source ?? `factory:${CUBE_DEFAULT_TABLES[slot]}`;
  if (src === 'user' && Array.isArray(slotData?.frames) && slotData!.frames!.length > 0) {
    return {
      frames: framesFromPlain(slotData!.frames!),
      label: slotData?.label ?? 'USER',
      signature: `user:${slotData!.frames!.length}:${slotData?.label ?? ''}`,
    };
  }
  if (src.startsWith('factory:')) {
    const id = src.slice('factory:'.length);
    const t = getFactoryTable(id) ?? getFactoryTable(CUBE_DEFAULT_TABLES[slot]);
    if (t) {
      return {
        frames: t.frames.map((f) => new Float32Array(f)),
        label: t.label,
        signature: `factory:${t.id}`,
      };
    }
  }
  const t = getFactoryTable(CUBE_DEFAULT_TABLES[slot]) ?? getFactoryTable(DEFAULT_FACTORY_TABLE_ID)!;
  return {
    frames: t.frames.map((f) => new Float32Array(f)),
    label: t.label,
    signature: `factory:${t.id}`,
  };
}

export const cubeDef: AudioModuleDef = {
  type: 'cube',
  palette: { top: 'Hybrid', sub: 'Hybrid' },
  domain: 'audio',
  label: 'CUBE',
  category: 'sources',
  schemaVersion: 1,

  inputs: [
    // V/oct pitch — the only audio-rate MONO node input the worklet reads directly.
    { id: 'pitch', type: 'cv' },
    // Polyphonic chord bus (5 voice pairs of pitch+gate over 10 channels). When
    // gated, CUBE renders one phase accumulator per lane → polyphonic; the mono
    // `pitch` input is the fallback when nothing is patched here. Engine routes
    // this 10-channel cable to ONE worklet input (index 1) — same shape as
    // DX7.poly. Listed right after `pitch` so it reads as the pitch family.
    { id: 'poly', type: 'polyPitchGate' },
    // CV → AudioParam (summed into the worklet param by the engine).
    { id: 'slice_y',  type: 'cv', paramTarget: 'slice_y',  cvScale: { mode: 'linear' } },
    { id: 'slice_rx', type: 'cv', paramTarget: 'slice_rx', cvScale: { mode: 'linear' } },
    { id: 'slice_ry', type: 'cv', paramTarget: 'slice_ry', cvScale: { mode: 'linear' } },
    { id: 'slice_rz', type: 'cv', paramTarget: 'slice_rz', cvScale: { mode: 'linear' } },
    { id: 'morph_fc', type: 'cv', paramTarget: 'morph_fc', cvScale: { mode: 'linear' } },
    { id: 'connect',  type: 'cv', paramTarget: 'connect',  cvScale: { mode: 'linear' } },
    { id: 'connect_strength', type: 'cv', paramTarget: 'connect_strength', cvScale: { mode: 'linear' } },
    { id: 'crush',    type: 'cv', paramTarget: 'crush',    cvScale: { mode: 'linear' } },
    { id: 'space_crush',   type: 'cv', paramTarget: 'space_crush',   cvScale: { mode: 'linear' } },
    { id: 'space_diffuse', type: 'cv', paramTarget: 'space_diffuse', cvScale: { mode: 'linear' } },
    { id: 'fold_cv',  type: 'cv', paramTarget: 'fold',     cvScale: { mode: 'linear' } },
    { id: 'tune',     type: 'cv', paramTarget: 'tune',     cvScale: { mode: 'linear' } },
  ],
  // SEPARATE L / R audio out (issue #1). The worklet's single 2-channel output
  // is split by a ChannelSplitter(2) in the factory so each port carries one
  // channel — patching L and R into mono inputs preserves the ±SPREAD width
  // (a single stereo port would downmix to mono and erase it). LITERAL array —
  // the module-manifest static extractor reads this directly.
  outputs: [
    { id: 'L', type: 'audio' },
    { id: 'R', type: 'audio' },
    // SYNC — a pure SINE at the playback fundamental, PHASE-LOCKED to the L/R
    // slice readout (the worklet reads it off the SAME phase accumulator). Hard-
    // sync other oscillators to CUBE or use it as a clean reference / sub. Mono;
    // mapped from the worklet's 2nd output (index 1). Additive — the L/R slice
    // audio is byte-identical to before.
    { id: 'sync', type: 'audio' },
    // Cross-domain mono-video out (issue: video out of the 3D CUBE view). The
    // card installs a frame-drawer that renders its live WebGL 3D cube into the
    // bridge's canvas each video frame; patch this into VIDEOOUT / any video
    // module. Mirrors WAVESCULPT.video_out + WARRENSPECTRUM.viz_out.
    { id: 'video_out', type: 'mono-video' },
  ],
  // LITERAL array — the module-manifest static extractor reads this directly.
  params: [
    { id: 'tune',     label: 'Tune',    defaultValue: 0,   min: -36,  max: 36,  curve: 'linear', units: 'st' },
    { id: 'fine',     label: 'Fine',    defaultValue: 0,   min: -100, max: 100, curve: 'linear', units: '¢' },
    { id: 'morph_fc', label: 'Morph',   defaultValue: 0,   min: 0,    max: 1,   curve: 'linear' },
    { id: 'connect',  label: 'Connect', defaultValue: 0,   min: 0,    max: 1,   curve: 'linear' },
    // CONNECT STRENGTH — overshoot the connector's interior control point "out of
    // the cube" for a dramatic base swell (0 = today's exact shape). Lives next
    // to CONNECT. CV via the connect_strength input.
    { id: 'connect_strength', label: 'Cnct Str', defaultValue: 0, min: 0, max: 1, curve: 'linear' },
    { id: 'crush',    label: 'Crush',   defaultValue: 0,   min: 0,    max: 1,   curve: 'linear' },
    // SPACE CRUSH — independent spatial voxelization of the FIELD lookup coords
    // (chunky voxels, 0 = transparent). SPACE DIFFUSE — gravity pulling the
    // sample cloud toward the cube's emptiest wall (0 = off). Both CV-routed.
    { id: 'space_crush',   label: 'Space Crush',  defaultValue: 0, min: 0, max: 1, curve: 'linear' },
    { id: 'space_diffuse', label: 'Space Diffuse', defaultValue: 0, min: 0, max: 1, curve: 'linear' },
    // FOLD — West-coast wavefolder on the output (0 = pass-through, max = hard
    // fold, adds harmonics). Applied in cube-dsp.applyFold after the slice is
    // sampled, before LEVEL, on both L and R. CV via the fold_cv input.
    { id: 'fold',     label: 'Fold',    defaultValue: 0,   min: 0,    max: 1,   curve: 'linear' },
    { id: 'spread',   label: 'Spread',  defaultValue: 0,   min: 0,    max: 1,   curve: 'linear' },
    { id: 'slice_y',  label: 'Y',       defaultValue: 0.5, min: 0,    max: 1,   curve: 'linear' },
    { id: 'slice_rx', label: 'Rot X',   defaultValue: 0,   min: -3.1416, max: 3.1416, curve: 'linear' },
    { id: 'slice_ry', label: 'Rot Y',   defaultValue: 0,   min: -3.1416, max: 3.1416, curve: 'linear' },
    { id: 'slice_rz', label: 'Rot Z',   defaultValue: 0,   min: -3.1416, max: 3.1416, curve: 'linear' },
    { id: 'level',    label: 'Level',   defaultValue: 1,   min: 0,    max: 2,   curve: 'linear' },
    // Toggles (discrete). wrap: 0=silent-outside, 1=mirror-fold. material:
    // 0=SMOOTH (continuous density), 1=HARD (binary solid).
    { id: 'wrap',     label: 'Wrap',     defaultValue: 0, min: 0, max: 1, curve: 'discrete' },
    { id: 'material', label: 'Material', defaultValue: 0, min: 0, max: 1, curve: 'discrete' },
    // View-only (NOT audio): WebGL camera transform. CV-not-routed (no
    // paramTarget input) and ignored by the worklet — the card reads them.
    { id: 'view_zoom',  label: 'Zoom',  defaultValue: 1, min: 0.3, max: 3, curve: 'log' },
    { id: 'view_rot_x', label: 'View X', defaultValue: 0.6, min: -3.1416, max: 3.1416, curve: 'linear' },
    { id: 'view_rot_y', label: 'View Y', defaultValue: 0.7, min: -3.1416, max: 3.1416, curve: 'linear' },
    { id: 'view_rot_z', label: 'View Z', defaultValue: 0,   min: -3.1416, max: 3.1416, curve: 'linear' },
    // SCREEN on/off (view-only, NOT audio): 1 = the 3D viz screen renders,
    // 0 = the screen is OFF. When OFF *and* video_out is unpatched the card
    // skips ALL visual computation (the rAF render loop + the display-only
    // field/slice/wave draws) — the biggest perf win for CUBE — while audio
    // keeps running untouched. Discrete; ignored by the worklet (the card reads
    // it). Persisted on node.params so the toggle survives reload. (v4 perf.)
    { id: 'screen_on',  label: 'Screen', defaultValue: 1, min: 0, max: 1, curve: 'discrete' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const initialParams = (node.params ?? {}) as Record<string, number>;
    const live: Record<string, number> = {};
    for (const p of cubeDef.params) live[p.id] = initialParams[p.id] ?? p.defaultValue;

    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    // Two outputs: output 0 = the stereo L/R slice audio (fanned into separate
    // L/R ports via the ChannelSplitter below), output 1 = the mono SYNC sine
    // (a phase-locked reference, exposed directly as the `sync` port). Node
    // inputs: input 0 = mono pitch (the CV→AudioParam inputs also sum into
    // input 0's AudioParams via the engine), input 1 = the 10-channel poly bus.
    // channelCountMode defaults to 'max', so the 10-channel poly source passes
    // through to the worklet intact.
    const workletNode = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
      numberOfInputs: 2,
      numberOfOutputs: 2,
      outputChannelCount: [2, 1],
    });
    const params = workletNode.parameters as unknown as Map<string, AudioParam>;

    // Fan the worklet's 2-channel output into SEPARATE L / R node ports (issue
    // #1) so the spread survives downstream. Each port carries one channel from
    // the splitter (output 0 = L, output 1 = R). WAVESCULPT uses the same
    // ChannelSplitter(2) → per-channel-port pattern.
    const splitter = ctx.createChannelSplitter(2);
    workletNode.connect(splitter, 0); // output 0 = stereo L/R slice audio

    // Video-out analyser tap (cross-domain mono-video). The bridge ignores the
    // analyser when a drawFrame is supplied, but the videoSources contract still
    // requires an AnalyserNode handle; tap the worklet's stereo output for it.
    const videoAnalyser = ctx.createAnalyser();
    videoAnalyser.fftSize = 256;
    workletNode.connect(videoAnalyser, 0); // output 0 = stereo L/R slice audio

    // Mirror initial knob values into worklet params (only the ones the
    // worklet actually declares; view_* + spread/fine handled below).
    for (const def of cubeDef.params) {
      const ap = params.get(def.id);
      if (ap) ap.setValueAtTime(live[def.id] ?? def.defaultValue, ctx.currentTime);
    }

    // Keep the worklet alive even with nothing patched into pitch.
    const silence = ctx.createConstantSource();
    silence.offset.value = 0;
    silence.start();
    silence.connect(workletNode, 0, 0);

    // ---------------- per-slot wavetable resolution + poll ----------------
    const resolvedSigs: Record<CubeSlot, string> = { floor: '', wall: '', ceiling: '' };
    const resolvedFrames: Record<CubeSlot, Float32Array[]> = {
      floor: [], wall: [], ceiling: [],
    };
    const resolvedLabels: Record<CubeSlot, string> = { floor: '', wall: '', ceiling: '' };

    function resolveAndPostAll(): void {
      const data = (livePatch.nodes[node.id]?.data ?? {}) as CubeData;
      for (const slot of CUBE_SLOTS) {
        const next = resolveSlotFrames(slot, data[slot]);
        resolvedFrames[slot] = next.frames;
        resolvedLabels[slot] = next.label;
        if (next.signature !== resolvedSigs[slot]) {
          resolvedSigs[slot] = next.signature;
          try {
            workletNode.port.postMessage({
              type: 'loadWavetable',
              slot,
              frames: framesToPlain(next.frames),
            });
          } catch (err) {
            console.error('[cube] loadWavetable post failed', err);
          }
        }
      }
    }
    resolveAndPostAll();

    // ---------------- OFF-THREAD slice compute (issue #4) ----------------
    //
    // The worklet posts `paramsChanged` (cheap CV-summed scalars) when the slice
    // needs a fresh render; we run the SURFACE-HEIGHT SCAN here on the main
    // thread (identical sampleSlice math) and post the L/R/center waveforms
    // back. The audio thread never touches the field math → no dropouts. We keep
    // the last non-silent center wave for the viz too.
    let lastSnapshot: Float32Array | null = null;
    let lastCenterNonSilent: Float32Array | null = null;

    function renderAndPostSlice(p: {
      sliceY: number; rx: number; ry: number; rz: number;
      morphFC: number; connect: number; crush: number; spread: number;
      fold: number; material: number; wrap: number;
      spaceCrush?: number; spaceDiffuse?: number; connectStrength?: number;
    }): void {
      // All three tables must be loaded (resolveAndPostAll seeds defaults on
      // spawn, so this is true almost immediately).
      const floor = resolvedFrames.floor;
      const wall = resolvedFrames.wall;
      const ceiling = resolvedFrames.ceiling;
      if (!floor.length || !wall.length || !ceiling.length) return;
      const sp: SliceParams = {
        sliceY: p.sliceY, rx: p.rx, ry: p.ry, rz: p.rz,
        morphFC: p.morphFC, connect: p.connect, crush: p.crush,
        spaceCrush: p.spaceCrush ?? 0,
        spaceDiffuse: p.spaceDiffuse ?? 0,
        connectStrength: p.connectStrength ?? 0,
        material: (p.material >= 0.5 ? 'hard' : 'smooth') as Material,
        wrap: p.wrap >= 0.5,
      };
      const fold = p.fold ?? 0;
      const dL = spreadDepthOffset(p.spread, -1);
      const dR = spreadDepthOffset(p.spread, +1);
      const center = sampleSlice(floor, wall, ceiling, sp, 0);
      const waveL = dL === 0 ? center : sampleSlice(floor, wall, ceiling, sp, dL);
      const waveR = dR === 0 ? center : sampleSlice(floor, wall, ceiling, sp, dR);
      // FOLD (West-coast wavefolder): AFTER the slice is sampled + BEFORE LEVEL,
      // on BOTH L and R (and the center viz wave so the WAVEFORM view shows the
      // FOLDED wave). In-place + identity at fold=0. waveL/waveR may alias
      // `center` at spread=0, so fold center first then only the distinct ones.
      applyFold(center, fold);
      if (waveL !== center) applyFold(waveL, fold);
      if (waveR !== center && waveR !== waveL) applyFold(waveR, fold);
      // Cache a non-silent center for the viz (the worklet handles the audio
      // keep-last-non-silent rule itself).
      if (!isSilentWave(center)) lastCenterNonSilent = center;
      lastSnapshot = lastCenterNonSilent ?? center;
      try {
        workletNode.port.postMessage({ type: 'setWave', waveCenter: center, waveL, waveR });
      } catch (err) {
        console.error('[cube] setWave post failed', err);
      }
    }

    workletNode.port.onmessage = (e: MessageEvent) => {
      const m = e.data as
        | { type?: string; wave?: Float32Array }
        | (Parameters<typeof renderAndPostSlice>[0] & { type?: string });
      if (!m || typeof m !== 'object') return;
      if (m.type === 'paramsChanged') {
        renderAndPostSlice(m as Parameters<typeof renderAndPostSlice>[0]);
      } else if (m.type === 'snapshot' && (m as { wave?: Float32Array }).wave) {
        // Fallback viz source (only if the worklet ever runs on-thread — it
        // won't in production, but harmless to keep wired).
        lastSnapshot = (m as { wave: Float32Array }).wave;
      }
    };

    // Switch the worklet to off-thread compute. Defer slightly so the
    // loadWavetable posts above are processed first (the worklet needs frames
    // before its first paramsChanged → our render → setWave round-trip).
    try { workletNode.port.postMessage({ type: 'offThread' }); } catch { /* */ }

    let alive = true;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    function poll(): void {
      if (!alive) return;
      resolveAndPostAll();
      pollTimer = setTimeout(poll, POLL_MS);
    }
    pollTimer = setTimeout(poll, POLL_MS);

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        ['pitch',    { node: workletNode, input: 0 }],
        // Poly bus → worklet input 1 (a node connection, not an AudioParam).
        ['poly',     { node: workletNode, input: 1 }],
        ['slice_y',  { node: workletNode, input: 0, param: params.get('slice_y')! }],
        ['slice_rx', { node: workletNode, input: 0, param: params.get('slice_rx')! }],
        ['slice_ry', { node: workletNode, input: 0, param: params.get('slice_ry')! }],
        ['slice_rz', { node: workletNode, input: 0, param: params.get('slice_rz')! }],
        ['morph_fc', { node: workletNode, input: 0, param: params.get('morph_fc')! }],
        ['connect',  { node: workletNode, input: 0, param: params.get('connect')! }],
        ['connect_strength', { node: workletNode, input: 0, param: params.get('connect_strength')! }],
        ['crush',    { node: workletNode, input: 0, param: params.get('crush')! }],
        ['space_crush',   { node: workletNode, input: 0, param: params.get('space_crush')! }],
        ['space_diffuse', { node: workletNode, input: 0, param: params.get('space_diffuse')! }],
        ['fold_cv',  { node: workletNode, input: 0, param: params.get('fold')! }],
        ['tune',     { node: workletNode, input: 0, param: params.get('tune')! }],
      ]),
      outputs: new Map([
        ['L', { node: splitter, output: 0 }],
        ['R', { node: splitter, output: 1 }],
        // SYNC sine: the worklet's 2nd output (index 1), mono, exposed directly
        // (no splitter — it's already single-channel). Phase-locked reference.
        ['sync', { node: workletNode, output: 1 }],
      ]),
      // Cross-domain mono-video: the bridge owns an OffscreenCanvas, calls
      // drawFrame each video frame, then uploads the pixels to a GL texture for
      // downstream video modules. drawFrame delegates to the card's installed
      // 3D-cube frame-drawer (FRAME_DRAWERS); when none is installed it paints
      // black so the bridge always has a valid frame.
      videoSources: new Map([
        ['video_out', {
          analyser: videoAnalyser,
          sampleRate: ctx.sampleRate,
          drawFrame(canvas: OffscreenCanvas | HTMLCanvasElement) {
            const fn = FRAME_DRAWERS.get(node.id);
            if (fn) {
              try { fn(canvas); return; } catch { /* fall through to black */ }
            }
            const c2d = canvas.getContext('2d') as
              | CanvasRenderingContext2D
              | OffscreenCanvasRenderingContext2D
              | null;
            if (!c2d) return;
            c2d.fillStyle = '#000';
            c2d.fillRect(0, 0, canvas.width, canvas.height);
          },
        }],
      ]),
      setParam(paramId, value) {
        live[paramId] = value;
        params.get(paramId)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return live[paramId];
      },
      read(key) {
        if (key === 'snapshot') return lastSnapshot;
        if (key === 'live') return { ...live };
        if (key === 'tableLabels') return { ...resolvedLabels };
        if (key === 'frames') {
          return {
            floor: resolvedFrames.floor,
            wall: resolvedFrames.wall,
            ceiling: resolvedFrames.ceiling,
          };
        }
        return undefined;
      },
      dispose() {
        alive = false;
        if (pollTimer !== null) clearTimeout(pollTimer);
        try { silence.stop(); } catch { /* */ }
        try { silence.disconnect(); } catch { /* */ }
        try { workletNode.port.onmessage = null; } catch { /* */ }
        try { workletNode.disconnect(); } catch { /* */ }
        try { splitter.disconnect(); } catch { /* */ }
        try { videoAnalyser.disconnect(); } catch { /* */ }
      },
    };
  },
};
