// packages/web/src/lib/audio/modules/hypercube.ts
//
// HYPERCUBE — 4D tesseract extension of CUBE: the web AudioModuleDef + factory.
// A SIBLING of CUBE (cube.ts is left UNTOUCHED). It clones CUBE's wiring and
// adds a FOURTH "HOLO" wavetable + an ALPHA axis (the slice's 4th-dimension w
// coordinate). The field's occupancy is blended toward the HOLO cell —
// `f4 = (1-alpha)*f3 + alpha*dH` — a genuine tesseract cross-section (the slice
// is still a 2D plane ray-marched through a 3D field; ALPHA selects WHICH 3D
// field). At ALPHA=0 the render collapses to the plain 3-table CUBE, byte-for-
// byte (the off=identity invariant proven in cube-dsp.test.ts).
//
// The pure field/slice DSP lives in packages/dsp/src/lib/cube-dsp.ts (SHARED
// with CUBE; the HOLO/ALPHA additions are no-ops when absent). The AudioWorklet
// is packages/dsp/src/hypercube.ts (registerProcessor('hypercube', …)).
//
// Wavetable selection rides node.data (per slot: floor / wall / ceiling / holo,
// each { source, frames?, label? }). Defaults on spawn:
//   FLOOR=basic-shapes, WALL=harmonic-sweep, CEILING=basic-shapes,
//   HOLO=basic-shapes (the SAME default as floor/ceiling so HYPERCUBE-off is
//   doubly safe — the 4th table is benign until ALPHA is raised).
//
// Inputs:  pitch (V/oct) + CV→AudioParam for slice_y/rx/ry/rz, morph_fc,
//          connect, crush, fold, ALPHA, tune.
// Outputs: SEPARATE L and R audio ports (the worklet's 2-channel output is split
//          by a ChannelSplitter(2)) + a cross-domain mono-video out.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import { patch as livePatch } from '$lib/graph/store';
import workletUrl from '@patchtogether.live/dsp/dist/hypercube.js?url';
import {
  framesToPlain,
  framesFromPlain,
  getFactoryTable,
  DEFAULT_FACTORY_TABLE_ID,
} from '$lib/audio/wavetable-factory-tables';
// Pure field/slice DSP — imported via a RELATIVE path (the bluebox.ts pattern;
// worktrees may not symlink the workspace package under node_modules). This is
// the IDENTICAL function the (fallback) worklet + node-ART run, so the off-thread
// waveform is byte-for-byte what the on-thread path would have produced.
import {
  sampleSlice,
  applyFold,
  spreadDepthOffset,
  isSilentWave,
  type SliceParams,
  type Material,
} from '../../../../../dsp/src/lib/cube-dsp';

const PROCESSOR_NAME = 'hypercube';
const POLL_MS = 200;
const loadedContexts = new WeakSet<BaseAudioContext>();

// ---------- card → module frame-drawer registry (video_out) ----------
type FrameDrawer = (canvas: OffscreenCanvas | HTMLCanvasElement) => void;
const FRAME_DRAWERS: Map<string, FrameDrawer> = new Map();
export function installHypercubeFrameDrawer(nodeId: string, fn: FrameDrawer): void {
  FRAME_DRAWERS.set(nodeId, fn);
}
export function uninstallHypercubeFrameDrawer(nodeId: string): void {
  FRAME_DRAWERS.delete(nodeId);
}

export type HypercubeSlot = 'floor' | 'wall' | 'ceiling' | 'holo';
export const HYPERCUBE_SLOTS: readonly HypercubeSlot[] = ['floor', 'wall', 'ceiling', 'holo'];

/** Per-slot wavetable defaults. HOLO defaults to the SAME table as floor/ceiling
 *  so a freshly-spawned HYPERCUBE (ALPHA=0) is benign until you raise ALPHA. */
export const HYPERCUBE_DEFAULT_TABLES: Record<HypercubeSlot, string> = {
  floor: 'basic-shapes',
  wall: 'harmonic-sweep',
  ceiling: 'basic-shapes',
  holo: 'basic-shapes',
};

export interface HypercubeSlotData {
  source?: string;
  frames?: number[][];
  label?: string;
}
export interface HypercubeData {
  floor?: HypercubeSlotData;
  wall?: HypercubeSlotData;
  ceiling?: HypercubeSlotData;
  holo?: HypercubeSlotData;
}

interface ResolvedFrames {
  frames: Float32Array[];
  label: string;
  signature: string;
}

/** Resolve a slot's frames from its node.data entry, falling back to the slot's
 *  default factory table. */
export function resolveSlotFrames(
  slot: HypercubeSlot,
  slotData: HypercubeSlotData | undefined,
): ResolvedFrames {
  const src = slotData?.source ?? `factory:${HYPERCUBE_DEFAULT_TABLES[slot]}`;
  if (src === 'user' && Array.isArray(slotData?.frames) && slotData!.frames!.length > 0) {
    return {
      frames: framesFromPlain(slotData!.frames!),
      label: slotData?.label ?? 'USER',
      signature: `user:${slotData!.frames!.length}:${slotData?.label ?? ''}`,
    };
  }
  if (src.startsWith('factory:')) {
    const id = src.slice('factory:'.length);
    const t = getFactoryTable(id) ?? getFactoryTable(HYPERCUBE_DEFAULT_TABLES[slot]);
    if (t) {
      return {
        frames: t.frames.map((f) => new Float32Array(f)),
        label: t.label,
        signature: `factory:${t.id}`,
      };
    }
  }
  const t = getFactoryTable(HYPERCUBE_DEFAULT_TABLES[slot]) ?? getFactoryTable(DEFAULT_FACTORY_TABLE_ID)!;
  return {
    frames: t.frames.map((f) => new Float32Array(f)),
    label: t.label,
    signature: `factory:${t.id}`,
  };
}

export const hypercubeDef: AudioModuleDef = {
  type: 'hypercube',
  palette: { top: 'Hybrid', sub: 'Hybrid' },
  domain: 'audio',
  label: 'hypercube',
  category: 'sources',
  schemaVersion: 1,

  inputs: [
    { id: 'pitch', type: 'cv' },
    { id: 'slice_y',  type: 'cv', paramTarget: 'slice_y',  cvScale: { mode: 'linear' } },
    { id: 'slice_rx', type: 'cv', paramTarget: 'slice_rx', cvScale: { mode: 'linear' } },
    { id: 'slice_ry', type: 'cv', paramTarget: 'slice_ry', cvScale: { mode: 'linear' } },
    { id: 'slice_rz', type: 'cv', paramTarget: 'slice_rz', cvScale: { mode: 'linear' } },
    { id: 'morph_fc', type: 'cv', paramTarget: 'morph_fc', cvScale: { mode: 'linear' } },
    { id: 'connect',  type: 'cv', paramTarget: 'connect',  cvScale: { mode: 'linear' } },
    { id: 'crush',    type: 'cv', paramTarget: 'crush',    cvScale: { mode: 'linear' } },
    { id: 'fold_cv',  type: 'cv', paramTarget: 'fold',     cvScale: { mode: 'linear' } },
    // HYPERCUBE ALPHA CV — the slice's 4th-dimension (w) coordinate. CV-able.
    { id: 'alpha',    type: 'cv', paramTarget: 'alpha',    cvScale: { mode: 'linear' } },
    { id: 'tune',     type: 'cv', paramTarget: 'tune',     cvScale: { mode: 'linear' } },
  ],
  outputs: [
    { id: 'L', type: 'audio' },
    { id: 'R', type: 'audio' },
    { id: 'video_out', type: 'mono-video' },
  ],
  params: [
    { id: 'tune',     label: 'Tune',    defaultValue: 0,   min: -36,  max: 36,  curve: 'linear', units: 'st' },
    { id: 'fine',     label: 'Fine',    defaultValue: 0,   min: -100, max: 100, curve: 'linear', units: '¢' },
    { id: 'morph_fc', label: 'Morph',   defaultValue: 0,   min: 0,    max: 1,   curve: 'linear' },
    { id: 'connect',  label: 'Connect', defaultValue: 0,   min: 0,    max: 1,   curve: 'linear' },
    { id: 'crush',    label: 'Crush',   defaultValue: 0,   min: 0,    max: 1,   curve: 'linear' },
    { id: 'fold',     label: 'Fold',    defaultValue: 0,   min: 0,    max: 1,   curve: 'linear' },
    // HYPERCUBE ALPHA — the 4th-dimension (w) coordinate. Default 0 =
    // HYPERCUBE-off (identity to a 3-table CUBE render). CV via the alpha input.
    { id: 'alpha',    label: 'Alpha',   defaultValue: 0,   min: 0,    max: 1,   curve: 'linear' },
    { id: 'spread',   label: 'Spread',  defaultValue: 0,   min: 0,    max: 1,   curve: 'linear' },
    { id: 'slice_y',  label: 'Y',       defaultValue: 0.5, min: 0,    max: 1,   curve: 'linear' },
    { id: 'slice_rx', label: 'Rot X',   defaultValue: 0,   min: -3.1416, max: 3.1416, curve: 'linear' },
    { id: 'slice_ry', label: 'Rot Y',   defaultValue: 0,   min: -3.1416, max: 3.1416, curve: 'linear' },
    { id: 'slice_rz', label: 'Rot Z',   defaultValue: 0,   min: -3.1416, max: 3.1416, curve: 'linear' },
    { id: 'level',    label: 'Level',   defaultValue: 1,   min: 0,    max: 2,   curve: 'linear' },
    { id: 'wrap',     label: 'Wrap',     defaultValue: 0, min: 0, max: 1, curve: 'discrete' },
    { id: 'material', label: 'Material', defaultValue: 0, min: 0, max: 1, curve: 'discrete' },
    { id: 'view_zoom',  label: 'Zoom',  defaultValue: 1, min: 0.3, max: 3, curve: 'log' },
    { id: 'view_rot_x', label: 'View X', defaultValue: 0.6, min: -3.1416, max: 3.1416, curve: 'linear' },
    { id: 'view_rot_y', label: 'View Y', defaultValue: 0.7, min: -3.1416, max: 3.1416, curve: 'linear' },
    { id: 'view_rot_z', label: 'View Z', defaultValue: 0,   min: -3.1416, max: 3.1416, curve: 'linear' },
    { id: 'screen_on',  label: 'Screen', defaultValue: 1, min: 0, max: 1, curve: 'discrete' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const initialParams = (node.params ?? {}) as Record<string, number>;
    const live: Record<string, number> = {};
    for (const p of hypercubeDef.params) live[p.id] = initialParams[p.id] ?? p.defaultValue;

    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const workletNode = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    const params = workletNode.parameters as unknown as Map<string, AudioParam>;

    const splitter = ctx.createChannelSplitter(2);
    workletNode.connect(splitter);

    const videoAnalyser = ctx.createAnalyser();
    videoAnalyser.fftSize = 256;
    workletNode.connect(videoAnalyser);

    for (const def of hypercubeDef.params) {
      const ap = params.get(def.id);
      if (ap) ap.setValueAtTime(live[def.id] ?? def.defaultValue, ctx.currentTime);
    }

    const silence = ctx.createConstantSource();
    silence.offset.value = 0;
    silence.start();
    silence.connect(workletNode, 0, 0);

    // ---------------- per-slot wavetable resolution + poll ----------------
    const resolvedSigs: Record<HypercubeSlot, string> = { floor: '', wall: '', ceiling: '', holo: '' };
    const resolvedFrames: Record<HypercubeSlot, Float32Array[]> = {
      floor: [], wall: [], ceiling: [], holo: [],
    };
    const resolvedLabels: Record<HypercubeSlot, string> = { floor: '', wall: '', ceiling: '', holo: '' };

    function resolveAndPostAll(): void {
      const data = (livePatch.nodes[node.id]?.data ?? {}) as HypercubeData;
      for (const slot of HYPERCUBE_SLOTS) {
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
            console.error('[hypercube] loadWavetable post failed', err);
          }
        }
      }
    }
    resolveAndPostAll();

    // ---------------- OFF-THREAD slice compute ----------------
    let lastSnapshot: Float32Array | null = null;
    let lastCenterNonSilent: Float32Array | null = null;

    function renderAndPostSlice(p: {
      sliceY: number; rx: number; ry: number; rz: number;
      morphFC: number; connect: number; crush: number; spread: number;
      fold: number; alpha: number; material: number; wrap: number;
    }): void {
      const floor = resolvedFrames.floor;
      const wall = resolvedFrames.wall;
      const ceiling = resolvedFrames.ceiling;
      const holo = resolvedFrames.holo;
      if (!floor.length || !wall.length || !ceiling.length || !holo.length) return;
      const sp: SliceParams = {
        sliceY: p.sliceY, rx: p.rx, ry: p.ry, rz: p.rz,
        morphFC: p.morphFC, connect: p.connect, crush: p.crush,
        alpha: p.alpha ?? 0,
        material: (p.material >= 0.5 ? 'hard' : 'smooth') as Material,
        wrap: p.wrap >= 0.5,
      };
      const fold = p.fold ?? 0;
      const dL = spreadDepthOffset(p.spread, -1);
      const dR = spreadDepthOffset(p.spread, +1);
      // Thread the HOLO frames (trailing arg) + ALPHA (on the SliceParams) into
      // every render so the tesseract cross-section matches the worklet fallback.
      const center = sampleSlice(floor, wall, ceiling, sp, 0, holo);
      const waveL = dL === 0 ? center : sampleSlice(floor, wall, ceiling, sp, dL, holo);
      const waveR = dR === 0 ? center : sampleSlice(floor, wall, ceiling, sp, dR, holo);
      applyFold(center, fold);
      if (waveL !== center) applyFold(waveL, fold);
      if (waveR !== center && waveR !== waveL) applyFold(waveR, fold);
      if (!isSilentWave(center)) lastCenterNonSilent = center;
      lastSnapshot = lastCenterNonSilent ?? center;
      try {
        workletNode.port.postMessage({ type: 'setWave', waveCenter: center, waveL, waveR });
      } catch (err) {
        console.error('[hypercube] setWave post failed', err);
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
        lastSnapshot = (m as { wave: Float32Array }).wave;
      }
    };

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
        ['slice_y',  { node: workletNode, input: 0, param: params.get('slice_y')! }],
        ['slice_rx', { node: workletNode, input: 0, param: params.get('slice_rx')! }],
        ['slice_ry', { node: workletNode, input: 0, param: params.get('slice_ry')! }],
        ['slice_rz', { node: workletNode, input: 0, param: params.get('slice_rz')! }],
        ['morph_fc', { node: workletNode, input: 0, param: params.get('morph_fc')! }],
        ['connect',  { node: workletNode, input: 0, param: params.get('connect')! }],
        ['crush',    { node: workletNode, input: 0, param: params.get('crush')! }],
        ['fold_cv',  { node: workletNode, input: 0, param: params.get('fold')! }],
        ['alpha',    { node: workletNode, input: 0, param: params.get('alpha')! }],
        ['tune',     { node: workletNode, input: 0, param: params.get('tune')! }],
      ]),
      outputs: new Map([
        ['L', { node: splitter, output: 0 }],
        ['R', { node: splitter, output: 1 }],
      ]),
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
            holo: resolvedFrames.holo,
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
