// packages/web/src/lib/audio/modules/vst-bridge-shared.ts
//
// Shared factory plumbing for the two VST BRIDGE cards (vst-instrument.ts +
// vst-fx.ts). NOT a module def — the registry glob imports this file and
// `looksLikeAudioDef` skips it. Both defs ride ONE AudioWorklet processor
// ('vst-bridge', packages/dsp/src/vst-bridge.ts), so the addModule guard
// MUST be shared: a per-file WeakSet would call addModule twice per context
// and the second registerProcessor('vst-bridge') throws NotSupportedError.
//
// ARCHITECTURE (the es9 seam, one connection PER CARD instance):
//
//   ws://127.0.0.1:9309/ws ◀──▶ bridge Worker ◀── 3 SAB rings ──▶
//        (vst-bridge helper,     (vst/bridge.worker.ts,           'vst-bridge'
//         one plugin instance     one per card)                   AudioWorklet
//         per connection)
//
// The ENGINE NODE owns the connection (vst/bridge-owner.ts): acquire here in
// the factory, release ONLY in dispose() — mount/unmount/dock-collapse of
// the card never touches the socket, and hello.clientId = node.id lets the
// helper park + re-adopt the plugin instance across page reloads.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { ModuleNode } from '$lib/graph/types';
import {
  acquireVstBridge,
  releaseVstBridge,
  subscribeVst,
  vstBridgeAvailable,
} from '$lib/audio/vst/bridge-owner';
import { createWorkletNode } from '$lib/audio/worklet-guard';
import workletUrl from '@patchtogether.live/dsp/dist/vst-bridge.js?url';

const loadedContexts = new WeakSet<BaseAudioContext>();

/** The one registered processor. Each DEF passes this literal at its call
 *  site (typed to refuse anything else) so the def file carries the
 *  def→worklet link in its own source — mono-normal-scan.ts resolves a
 *  stereo def to its DSP file by finding the processor-name literal in the
 *  def's code, and a def relying on a constant hidden here would break that
 *  attribution (findStereoModules → dspFile null). */
export type VstProcessorName = 'vst-bridge';

/** Worklet input indices — must mirror packages/dsp/src/vst-bridge.ts. */
export const VST_IN_L = 0;
export const VST_IN_R = 1;
export const VST_POLY = 2;
export const VST_PITCH = 3;
export const VST_GATE = 4;
export const VST_VEL = 5;
const NUM_INPUTS = 6;

export type VstCardMode = 'fx' | 'instrument';

/**
 * Build the engine handle for either VST card. `mode` picks which def ports
 * map onto the worklet's fixed input indices, whether the worker sends audio
 * planes (fx) or mask-0 clock blocks (instrument), and the worklet's
 * not-connected behavior (fx: LOCAL bypass so a dead helper never mutes the
 * lane; instrument: silence).
 */
export async function createVstHandle(
  ctx: AudioContext,
  node: ModuleNode,
  mode: VstCardMode,
  processorName: VstProcessorName,
): Promise<AudioDomainNodeHandle> {
  if (!loadedContexts.has(ctx)) {
    await ctx.audioWorklet.addModule(workletUrl);
    loadedContexts.add(ctx);
  }

  // channelCountMode stays at the default 'max' ON THE INPUTS so the 32-ch
  // polyPitchGate cable fans in whole (the tidyVco precedent); unpatched
  // inputs deliver EMPTY channel arrays, which is how the worklet detects
  // "vel unpatched → DEFAULT_VELOCITY" — so liveness comes from a zero-gain
  // pin (below), never from a silence fan-in.
  const worklet = createWorkletNode(node, ctx, processorName, {
    numberOfInputs: NUM_INPUTS,
    numberOfOutputs: 2,
    outputChannelCount: [1, 1],
  });

  // Pin the worklet into the rendered graph: it must be pulled every quantum
  // to pump the rings (the instrument card's CLOCK is these pulls) even when
  // its outputs aren't patched anywhere yet.
  const pin = ctx.createGain();
  pin.gain.value = 0;
  worklet.connect(pin, 0);
  pin.connect(ctx.destination);

  // One connection per card instance; clientId = node id (parked-instance
  // adoption across reloads). Null in Node/vitest/ART — the module then sits
  // inert and harmless, same as es9.
  const rings = acquireVstBridge(node.id, ctx.sampleRate, {
    clientId: node.id,
    sendPlanes: mode === 'fx',
  });
  if (rings) {
    worklet.port.postMessage({
      type: 'rings',
      in: rings.inRing,
      out: rings.outRing,
      midi: rings.midiRing,
      mode,
    });
  }

  // Live-state relay: the worklet needs to know when the transport is down
  // (fx → local bypass, instrument → silence, both → skip the jitter
  // buffer). Only forward CHANGES — snapshots tick at meter rate (~8 Hz).
  let lastLive: boolean | null = null;
  const unsubscribe = vstBridgeAvailable()
    ? subscribeVst(node.id, (s) => {
        const live = s.state === 'connected';
        if (live !== lastLive) {
          lastLive = live;
          worklet.port.postMessage({ type: 'live', live });
        }
      })
    : null;

  const inputsMap = new Map<string, { node: AudioNode; input: number }>();
  if (mode === 'fx') {
    inputsMap.set('in_l', { node: worklet, input: VST_IN_L });
    inputsMap.set('in_r', { node: worklet, input: VST_IN_R });
  } else {
    inputsMap.set('poly', { node: worklet, input: VST_POLY });
    inputsMap.set('pitch', { node: worklet, input: VST_PITCH });
    inputsMap.set('gate', { node: worklet, input: VST_GATE });
    inputsMap.set('vel', { node: worklet, input: VST_VEL });
  }
  const outputsMap = new Map<string, { node: AudioNode; output: number }>();
  outputsMap.set('out_l', { node: worklet, output: 0 });
  outputsMap.set('out_r', { node: worklet, output: 1 });

  return {
    domain: 'audio',
    inputs: inputsMap,
    outputs: outputsMap,
    setParam() {
      // No numeric params — the card drives the bridge over the control
      // plane (mount/editor/state), not through ParamDefs.
    },
    readParam() {
      return undefined;
    },
    read(key) {
      if (key === 'sampleRate') return ctx.sampleRate;
      return undefined;
    },
    dispose() {
      // The node is leaving the graph — the ONLY place the connection is
      // torn down. A card unmount must never reach here.
      unsubscribe?.();
      releaseVstBridge(node.id);
      worklet.port.postMessage({ type: 'detach' });
      try { worklet.disconnect(); } catch { /* */ }
      try { pin.disconnect(); } catch { /* */ }
    },
  };
}
