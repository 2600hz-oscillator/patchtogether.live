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
//          connect, crush, tune.
// Outputs: audio_out (stereo, exposed as a single stereo node).

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

const PROCESSOR_NAME = 'cube';
const POLL_MS = 200;
const loadedContexts = new WeakSet<BaseAudioContext>();

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
  domain: 'audio',
  label: 'CUBE',
  category: 'sources',
  schemaVersion: 1,
  // Single stereo output port (the worklet's output 0 carries 2 channels), so
  // there is no L/R port PAIR to declare — stereoPairs is omitted.

  inputs: [
    // V/oct pitch — the only audio-rate node input the worklet reads directly.
    { id: 'pitch', type: 'cv' },
    // CV → AudioParam (summed into the worklet param by the engine).
    { id: 'slice_y',  type: 'cv', paramTarget: 'slice_y',  cvScale: { mode: 'linear' } },
    { id: 'slice_rx', type: 'cv', paramTarget: 'slice_rx', cvScale: { mode: 'linear' } },
    { id: 'slice_ry', type: 'cv', paramTarget: 'slice_ry', cvScale: { mode: 'linear' } },
    { id: 'slice_rz', type: 'cv', paramTarget: 'slice_rz', cvScale: { mode: 'linear' } },
    { id: 'morph_fc', type: 'cv', paramTarget: 'morph_fc', cvScale: { mode: 'linear' } },
    { id: 'connect',  type: 'cv', paramTarget: 'connect',  cvScale: { mode: 'linear' } },
    { id: 'crush',    type: 'cv', paramTarget: 'crush',    cvScale: { mode: 'linear' } },
    { id: 'tune',     type: 'cv', paramTarget: 'tune',     cvScale: { mode: 'linear' } },
  ],
  // Stereo audio out. Declared as two ports forming one stereo pair (the
  // factory exposes both from the worklet's single stereo output channels).
  outputs: [
    { id: 'audio_out', type: 'audio' },
  ],
  // LITERAL array — the module-manifest static extractor reads this directly.
  params: [
    { id: 'tune',     label: 'Tune',    defaultValue: 0,   min: -36,  max: 36,  curve: 'linear', units: 'st' },
    { id: 'fine',     label: 'Fine',    defaultValue: 0,   min: -100, max: 100, curve: 'linear', units: '¢' },
    { id: 'morph_fc', label: 'Morph',   defaultValue: 0,   min: 0,    max: 1,   curve: 'linear' },
    { id: 'connect',  label: 'Connect', defaultValue: 0,   min: 0,    max: 1,   curve: 'linear' },
    { id: 'crush',    label: 'Crush',   defaultValue: 0,   min: 0,    max: 1,   curve: 'linear' },
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
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const initialParams = (node.params ?? {}) as Record<string, number>;
    const live: Record<string, number> = {};
    for (const p of cubeDef.params) live[p.id] = initialParams[p.id] ?? p.defaultValue;

    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    // One stereo output. pitch is the only node input (input 0); the rest of
    // the CV inputs sum into AudioParams.
    const workletNode = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    const params = workletNode.parameters as unknown as Map<string, AudioParam>;

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

    // ---------------- snapshot (viz) reception ----------------
    let lastSnapshot: Float32Array | null = null;
    workletNode.port.onmessage = (e: MessageEvent) => {
      const m = e.data as { type?: string; wave?: Float32Array };
      if (m && m.type === 'snapshot' && m.wave) {
        lastSnapshot = m.wave;
      }
    };

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
        ['tune',     { node: workletNode, input: 0, param: params.get('tune')! }],
      ]),
      outputs: new Map([
        ['audio_out', { node: workletNode, output: 0 }],
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
      },
    };
  },
};
