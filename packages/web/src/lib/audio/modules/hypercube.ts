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
  // HypercubeCard renders the 4D tesseract via a real WebGL2 context → this
  // audio-domain module is a GPU render path. The marker mechanically pulls
  // hypercube.ts into the WebGL content-hash basis + is cross-checked against
  // the card's getContext('webgl2') by the §12 coverage guard.
  rendersWebGL: true,
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
  // docs-hash-ignore:start
  // HYPERCUBE's card renders WebGL (rendersWebGL: true), so its def is in the
  // WebGL attest basis. Living-docs is hash-transparent: these markers make
  // computeWebglHash strip the co-located docs so authoring them does NOT churn
  // the GPU attest hash. (Owner directive: "docs must not change attest hashes";
  // sibling cube.ts uses the same markers — see scripts/webgl-attest-lib.ts
  // stripDocsForHash.)
  docs: {
    explanation:
      "A 4D-tesseract wavetable-terrain oscillator — the 4-dimensional sibling of CUBE. CUBE stacks three wavetables (FLOOR / WALL / CEILING) into a 3D scalar field and plays the heightmap of a flat plane sliced through it as its waveform; HYPERCUBE adds a FOURTH wavetable (HOLO) and an ALPHA axis that is the slice's 4th-dimension (w) coordinate. As you raise ALPHA the field's occupancy blends toward the HOLO cell (f4 = (1−alpha)·f3 + alpha·dH) — a genuine tesseract cross-section, where ALPHA selects WHICH 3D field the still-2D plane is cut from. At ALPHA = 0 the render collapses to a plain three-table CUBE, byte-for-byte. You aim the slicing plane with the Y height knob and three rotation knobs (Rot X / Y / Z), each CV-able; MORPH cross-fades the layers, CONNECT bulges the interior, CRUSH bit-reduces the read-out, FOLD is a west-coast wavefolder, and WRAP/MATERIAL choose how the slice reads outside the cube and how dense the field is. It is a pitched V/oct oscillator with a stereo ±SPREAD (L/R read slightly offset planes), and the card shows a live WebGL render of the 4D cube, the cut plane, and the output waveform — patchable out the VIDEO port, and switchable off to save GPU.",
    inputs: {
      pitch: 'Mono V/oct pitch control voltage — the standard 1V-per-octave oscillator pitch input, read directly by the worklet. Summed with the TUNE/FINE offsets (and the TUNE CV) to set the playback fundamental.',
      slice_y: 'CV that offsets the Y param — raises or lowers the slicing plane through the cube, scanning the cut across the floor→ceiling stack.',
      slice_rx: 'CV that offsets the Rot X param — tilts the slicing plane about the X axis (±π), changing the surface contour it reads.',
      slice_ry: 'CV that offsets the Rot Y param — tilts the slicing plane about the Y axis (±π).',
      slice_rz: 'CV that offsets the Rot Z param — rotates the slicing plane about the Z axis (±π).',
      morph_fc: 'CV that offsets the Morph param, cross-fading the floor↔ceiling wavetable layers of the field.',
      connect: 'CV that offsets the Connect param, blending the floor and ceiling into a connected interior shape.',
      crush: 'CV that offsets the Crush param, driving the bit/sample reduction applied to the slice\'s read-out waveform.',
      fold_cv: 'CV that offsets the Fold param, modulating the output wavefolder depth (added harmonics).',
      alpha: 'CV that offsets the ALPHA param — the slice\'s 4th-dimension (w) coordinate. Sweeping it morphs the cross-section from the plain 3-table CUBE (alpha 0) toward the HOLO field, the signature HYPERCUBE motion.',
      tune: 'CV that offsets the Tune param, shifting pitch in semitones around the base note (summed with the PITCH input and the FINE knob).',
    },
    outputs: {
      L: 'Left audio channel of the sliced oscillator, including the −SPREAD plane offset, post-FOLD and post-LEVEL. Split out as its own mono port so the stereo width survives even into a mono input.',
      R: 'Right audio channel, including the +SPREAD plane offset (the partner of L). Together L and R carry the spread stereo image.',
      video_out: 'A mono-video output carrying a live render of the 4D cube view — the field volume, the cut plane positioned by Y + the rotation knobs (and ALPHA\'s 4th-dimension slice), and the output waveform. Patch it into VIDEOOUT or any video module; it keeps emitting frames even when the on-card SCREEN is off.',
    },
    controls: {
      tune: 'Coarse pitch in semitones (−36..+36), summed with the FINE offset and the PITCH/TUNE CV to set the oscillator fundamental.',
      fine: 'Fine pitch trim in cents (−100..+100) for tuning between the semitone steps of TUNE.',
      morph_fc: 'Cross-fades the FLOOR↔CEILING wavetable layers of the 3D field (0 = floor, 1 = ceiling), reshaping the terrain the plane slices through. CV via the MORPH input.',
      connect: 'Blends the floor and ceiling layers into a single connected interior shape (0 = separate, 1 = fully connected). CV via the CONNECT input.',
      crush: 'Bit/sample reduction applied to the slice\'s read-out waveform (0 = clean, max = heavily crushed) for digital grit. CV via the CRUSH input.',
      fold: 'West-coast wavefolder on the output (0 = pass-through, max = hard fold), applied after the slice is sampled and before LEVEL on both L and R, adding harmonics. CV via the FOLD input.',
      alpha: 'ALPHA — the 4th-dimension (w) coordinate that makes HYPERCUBE a tesseract: 0 = identity to a 3-table CUBE render (the HOLO table is inert), and raising it blends the field toward the HOLO cell, selecting a different 3D cross-section to slice. CV via the ALPHA input.',
      spread: 'Stereo width (0..1): at higher values the L and R taps read planes offset by up to ±5% of depth, so the two channels diverge (0 = mono, both channels identical).',
      slice_y: 'Height of the slicing plane through the cube (0..1) — scans the cut from the floor up to the ceiling. CV via the Y input.',
      slice_rx: 'Rotation of the slicing plane about the X axis (±π radians), tilting which surface contour it reads. CV via the ROT X input.',
      slice_ry: 'Rotation of the slicing plane about the Y axis (±π radians). CV via the ROT Y input.',
      slice_rz: 'Rotation of the slicing plane about the Z axis (±π radians). CV via the ROT Z input.',
      level: 'Output gain on the sliced audio (0..2, applied after FOLD); 1 = unity, above 1 boosts.',
      wrap: 'What happens when the slicing plane reads outside the cube: OFF = those regions are silent, ON = the coordinates mirror-fold back inside so the slice stays full.',
      material: 'Field density model: SMOOTH (0) = continuous density gradients, HARD (1) = a binary solid (sharp inside/outside), which makes the sliced waveform edgier.',
      view_zoom: 'Visualization-only camera zoom for the 4D cube view (no effect on sound or the selected slice).',
      view_rot_x: 'Visualization-only camera rotation about X — orbits the 3D view (no effect on audio).',
      view_rot_y: 'Visualization-only camera rotation about Y — orbits the 3D view (no effect on audio).',
      view_rot_z: 'Visualization-only camera rotation about Z — orbits the 3D view (no effect on audio).',
      screen_on: 'Turns the on-card WebGL viz screen on/off. When OFF and the VIDEO output is unpatched, the card skips the render to save GPU — audio keeps running untouched. A patched VIDEO output still receives live frames even with the screen off.',
    },
  },
  // docs-hash-ignore:end

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
