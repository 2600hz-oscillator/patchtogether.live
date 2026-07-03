// art/setup/offline.ts
//
// Shared REAL-DEF-FACTORY capture path for ART audio profiles (backfill
// batch 5 — spec §4.3 `captureOffline`, .myrobots/plans/
// art-backfill-audio-profiles-2026-07-01.md §1.3 rendering path #3).
//
// Some audio modules have NO worklet at all — they are PURE Web Audio node
// graphs (GainNode / DelayNode / WaveShaperNode / ConstantSourceNode) built
// by the def's own factory(). Native primitive nodes DO run under
// node-web-audio-api's OfflineAudioContext, so the highest-fidelity render
// path is the SHIPPING factory itself against an offline context: zero
// mirror, zero drift (the moog907a/moog914 batch-2 precedent, lifted into
// ONE helper because batch 5 profiles six such modules).
//
// A scenario declares: the def, the params to apply (an explicit patch — a
// pure function of the scenario file), a driver buffer per input port (see
// ./drivers), and the output port ids to capture. Multi-output modules
// render ONCE through a ChannelMergerNode (one channel per captured output,
// the illogic-scenario technique) so cross-output assertions see the same
// render.
//
// Determinism: drivers are pure/pinned, AudioBufferSourceNodes start at
// t = 0 with playbackRate 1 (no resampling), and the graph is evaluated
// offline — probe bit-identical in-process AND across processes before
// pinning (the batch-2 discipline; every profile also asserts an
// in-process re-render diff of 0).

import { OfflineAudioContext } from 'node-web-audio-api';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import { SAMPLE_RATE } from './render';

export interface OfflineDefRenderOptions {
  /** Render length in seconds (spec §4.1: ~0.5 s steady FX, ≥1 s for
   *  tails/slow modulation). */
  durationS: number;
  /** node.params handed to the factory — the profile's explicit patch.
   *  (Pass every param you rely on; the factory's own `??` defaults fill
   *  the rest, but explicit values keep the scenario self-describing.) */
  params?: Record<string, number>;
  /** Full-length driver buffer per INPUT PORT ID; omitted ports stay
   *  unpatched (their nodes see silence — the Web Audio unconnected shape). */
  inputs?: Record<string, Float32Array>;
  /** OUTPUT PORT IDS to capture, in channel order. */
  outputs: readonly string[];
  sampleRate?: number;
}

/**
 * Drive `def.factory()` under an OfflineAudioContext and capture every
 * requested output, one merger channel per port. Returns
 * `Record<outputId, Float32Array>` ready for `pinAll` / assertions.
 */
export async function renderOfflineDef(
  def: AudioModuleDef,
  opts: OfflineDefRenderOptions,
): Promise<Record<string, Float32Array>> {
  const sr = opts.sampleRate ?? SAMPLE_RATE;
  const n = Math.round(sr * opts.durationS);
  const outIds = opts.outputs;
  if (outIds.length === 0) throw new Error(`renderOfflineDef(${def.type}): no outputs requested`);

  const ctx = new OfflineAudioContext({
    numberOfChannels: outIds.length,
    length: n,
    sampleRate: sr,
  });

  const node = {
    id: 'profile',
    type: def.type,
    position: { x: 0, y: 0 },
    params: opts.params ?? {},
  } as unknown as Parameters<typeof def.factory>[1];
  const handle = await def.factory(ctx as unknown as AudioContext, node);

  // Wire one looping-free AudioBufferSourceNode per driven input port.
  for (const [portId, data] of Object.entries(opts.inputs ?? {})) {
    const inRef = handle.inputs.get(portId);
    if (!inRef) throw new Error(`renderOfflineDef(${def.type}): no input port '${portId}'`);
    const buf = ctx.createBuffer(1, data.length, sr);
    // Copy defensively so a subarray view can't alias into the buffer.
    const copy = new Float32Array(data.length);
    copy.set(data);
    buf.copyToChannel(copy, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(inRef.node, 0, inRef.input);
    src.start(0);
  }

  // One merger channel per captured output (single-output: connect direct).
  if (outIds.length === 1) {
    const outRef = handle.outputs.get(outIds[0]!);
    if (!outRef) throw new Error(`renderOfflineDef(${def.type}): no output port '${outIds[0]}'`);
    outRef.node.connect(ctx.destination, outRef.output, 0);
  } else {
    const merger = ctx.createChannelMerger(outIds.length);
    outIds.forEach((id, k) => {
      const outRef = handle.outputs.get(id);
      if (!outRef) throw new Error(`renderOfflineDef(${def.type}): no output port '${id}'`);
      outRef.node.connect(merger, outRef.output, k);
    });
    merger.connect(ctx.destination);
  }

  const rendered = await ctx.startRendering();
  const record: Record<string, Float32Array> = {};
  outIds.forEach((id, k) => {
    record[id] = rendered.getChannelData(k).slice();
  });
  return record;
}
