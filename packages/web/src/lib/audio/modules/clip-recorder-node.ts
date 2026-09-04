// packages/web/src/lib/audio/clip-recorder-node.ts
//
// WIRING for the clip-recorder AudioWorklet — the main-thread half of
// packages/dsp/src/clip-recorder.ts. This file owns exactly three seams:
//
//   1. INPUTS. Each of the eight worklet inputs is fed from the tap seam the
//      mixmstrs factory publishes (`read('recTaps')`), picked with
//      `mixmstrsRecTapPair` — the ONE place a (recTap value, channel) becomes
//      a stereo leg pair. This file never recomputes a splitter index and
//      never walks the factory graph; a second copy of `6 + 2*ch` is how a
//      meter ends up on channel 4 while the recorder is on channel 5.
//
//   2. MESSAGES. The port protocol (`arm` / `stopAt` / `cancel` in, `chunk` /
//      `done` out) is IMPORTED from the dsp package's own protocol module
//      (the cube-dsp relative-path convention), so both threads share one
//      spelling and a renamed field is a tsc error on both sides, not a
//      silently-dead message on one. The machine's effects are spent through
//      these senders.
//
//   3. CHUNKS → THE STORE. A posted planar chunk becomes an interleaved
//      pcm-f32 `ClipMediaChunk` and goes to the lane's `ClipMediaDrain`
//      (stall-never-skip — the drain's ordering and backpressure are
//      structural, so this pump does not await; it hands over and returns).
//
// ⚠ THE KEEP-ALIVE IS LOAD-BEARING. An AudioWorkletNode with no path to the
// destination is an orphan subgraph Chromium won't pull, so its process()
// never runs and a take records nothing while every test that drives the
// processor directly stays green. gain(0) → destination keeps the recorder
// pulled and inaudible — recorderbox's own fix, adopted verbatim.
//
// ⚠ NO dispose()/release()/detach() ON A TAKE lives here or anywhere — a take
// ends by its frame boundary, `stopAt`, or the registry's graph-lifetime
// sweep (slice 5). `disconnectClipRecorderWiring` tears down GRAPH PLUMBING
// (the factory's own dispose path / a recTap re-wire between takes), which is
// a different lifecycle from a take's.

import clipRecorderWorkletUrl from '@patchtogether.live/dsp/dist/clip-recorder.js?url';
// The shared port protocol, via a RELATIVE path (not the
// `@patchtogether.live/dsp/src/...` alias) for the reason cube.ts documents:
// worktrees may not symlink the workspace package under node_modules.
import {
  CLIP_RECORDER_LANES,
  CLIP_RECORDER_PROCESSOR,
  type ClipRecorderChunkMsg,
  type ClipRecorderDoneMsg,
  type ClipRecorderOutMsg,
} from '../../../../../dsp/src/lib/clip-recorder-protocol';
import { createWorkletNode, type WorkletOwner } from '../worklet-guard';
import { mixmstrsRecTapPair, type MixmstrsRecTaps } from './mixmstrs';
import type { RecordingWindow } from '../clip-media';
import type { ClipMediaChunk, ClipMediaDrain } from '../clip-media-drain';

export {
  CLIP_RECORDER_LANES,
  CLIP_RECORDER_PROCESSOR,
  type ClipRecorderChunkMsg,
  type ClipRecorderDoneMsg,
  type ClipRecorderOutMsg,
};

/** Bytes per interleaved pcm-f32 stereo frame (the studio default the drain
 *  positions by): 2 channels × 4 bytes. */
export const CLIP_RECORDER_BYTES_PER_FRAME = 8;

// ---------------------------------------------------------------------------
// Module registration
// ---------------------------------------------------------------------------

/** One in-flight/settled addModule per context, so N recorders share ONE
 *  registration (the gate-edge-worklet pattern; addModule twice with the same
 *  name in one scope throws in some engines). */
const registrations = new WeakMap<BaseAudioContext, Promise<void>>();

/** Register the clip-recorder worklet module on `ctx` (idempotent per
 *  context). Rejects if the context has no audioWorklet (the caller decides
 *  what refusing to arm looks like — slice 5). */
export function ensureClipRecorderWorklet(ctx: BaseAudioContext): Promise<void> {
  const prior = registrations.get(ctx);
  if (prior) return prior;
  const aw = (ctx as unknown as { audioWorklet?: { addModule(u: string): Promise<void> } })
    .audioWorklet;
  if (!aw || typeof aw.addModule !== 'function') {
    return Promise.reject(new Error('clip-recorder: AudioWorklet unavailable on this context'));
  }
  const p = aw.addModule(clipRecorderWorkletUrl).catch((err) => {
    // A failed load must not poison the context forever — allow a retry.
    registrations.delete(ctx);
    throw err;
  });
  registrations.set(ctx, p);
  return p;
}

// ---------------------------------------------------------------------------
// Graph wiring
// ---------------------------------------------------------------------------

export interface ClipRecorderWiring {
  /** The eight-stereo-input recorder node. */
  node: AudioWorkletNode;
  /** One per lane: the stereo merger feeding worklet input `lane`. */
  mergers: ChannelMergerNode[];
  /** gain(0) → destination — the pull that makes process() run. */
  keepAlive: GainNode;
}

/**
 * Build the recorder node and connect every lane's stereo pair from the
 * published tap rosters under `recTap` value `tap` (0 = BOARD IN, the
 * default; 1 = POST FADER; 2 = MASTER — `mixmstrsRecTapPair` owns the
 * meaning). The worklet module must already be registered
 * (`ensureClipRecorderWorklet`).
 *
 * The tap is LATCHED AT ARM (edge 24): changing `recTap` mid-take is a
 * splice, so a re-wire between takes goes through
 * `disconnectClipRecorderWiring` + a fresh call, never a live re-patch.
 */
export function wireClipRecorder(
  ctx: BaseAudioContext,
  taps: MixmstrsRecTaps,
  tap: number,
  owner?: WorkletOwner,
): ClipRecorderWiring {
  // Through the SEAM, never bare `new AudioWorkletNode` — a processor that
  // throws latches to permanent silence with nothing logged, and the guard is
  // what makes that loud and attributed (worklet-guard.ts). The processor name
  // is the LITERAL: mono-normal-scan resolves this factory from it.
  const node = createWorkletNode(owner ?? null, ctx, 'clip-recorder', {
    numberOfInputs: CLIP_RECORDER_LANES,
    numberOfOutputs: 1,
    channelCount: 2,
    channelCountMode: 'explicit',
  });
  const mergers: ChannelMergerNode[] = [];
  for (let lane = 0; lane < CLIP_RECORDER_LANES; lane++) {
    const pair = mixmstrsRecTapPair(taps, tap, lane);
    const merger = ctx.createChannelMerger(2);
    pair.l.node.connect(merger, pair.l.output, 0);
    pair.r.node.connect(merger, pair.r.output, 1);
    merger.connect(node, 0, lane);
    mergers.push(merger);
  }
  const keepAlive = ctx.createGain();
  keepAlive.gain.value = 0; // tap-only: pulled, never audible
  node.connect(keepAlive);
  keepAlive.connect(ctx.destination);
  return { node, mergers, keepAlive };
}

/** Tear down the wiring's GRAPH PLUMBING (factory dispose / recTap re-wire
 *  between takes). Not a take lifecycle — see the file header. */
export function disconnectClipRecorderWiring(w: ClipRecorderWiring): void {
  for (const m of w.mergers) {
    try {
      m.disconnect();
    } catch {
      /* already gone */
    }
  }
  try {
    w.node.disconnect();
  } catch {
    /* already gone */
  }
  try {
    w.keepAlive.disconnect();
  } catch {
    /* already gone */
  }
}

// ---------------------------------------------------------------------------
// Port protocol — senders
// ---------------------------------------------------------------------------

/** Arm lane `lane` for the window (absolute context frames; stopFrame null =
 *  open endless take). The machine's `armWorklet` effect. */
export function armClipRecorderLane(
  node: Pick<AudioWorkletNode, 'port'>,
  lane: number,
  window: RecordingWindow,
): void {
  node.port.postMessage({
    type: 'arm',
    lane,
    startFrame: window.startFrame,
    stopFrame: window.stopFrame,
  });
}

/** Resolve lane `lane`'s stop to an absolute frame (the machine's
 *  `stopWorklet` effect). The worklet never EXTENDS a resolved stop, so a
 *  duplicate send is structurally a no-op. */
export function stopClipRecorderLane(
  node: Pick<AudioWorkletNode, 'port'>,
  lane: number,
  stopFrame: number,
): void {
  node.port.postMessage({ type: 'stopAt', lane, stopFrame });
}

/** Discard lane `lane`'s take silently (the machine's `cancelWorklet`
 *  effect). The OPFS scratch is the caller's to free or keep. */
export function cancelClipRecorderLane(node: Pick<AudioWorkletNode, 'port'>, lane: number): void {
  node.port.postMessage({ type: 'cancel', lane });
}

// ---------------------------------------------------------------------------
// Port protocol — receiving chunks into the store
// ---------------------------------------------------------------------------

/** Validate a raw port message against the shared protocol shapes. Anything
 *  malformed is null (dropped by the pump) — a recorder must never throw
 *  inside onmessage and take the whole take down with it. PURE. */
export function coerceClipRecorderMsg(raw: unknown): ClipRecorderOutMsg | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  const lane = m.lane;
  if (
    typeof lane !== 'number' ||
    !Number.isInteger(lane) ||
    lane < 0 ||
    lane >= CLIP_RECORDER_LANES
  ) {
    return null;
  }
  if (m.type === 'done') {
    if (typeof m.frames !== 'number' || !Number.isFinite(m.frames) || m.frames < 0) return null;
    return { type: 'done', lane, frames: Math.trunc(m.frames) };
  }
  if (m.type === 'chunk') {
    const { firstFrame, frames, data } = m as Partial<ClipRecorderChunkMsg>;
    if (typeof firstFrame !== 'number' || !Number.isInteger(firstFrame) || firstFrame < 0) return null;
    if (typeof frames !== 'number' || !Number.isInteger(frames) || frames <= 0) return null;
    if (!(data instanceof Float32Array) || data.length < frames * 2) return null;
    return { type: 'chunk', lane, firstFrame, frames, data };
  }
  return null;
}

/** Planar [L…, R…] → interleaved [L0, R0, L1, R1, …]. PURE. The store
 *  positions bytes by `firstFrame × bytesPerFrame`, so every chunk must be
 *  the SAME frame-addressable layout — interleaved f32 is the studio tier's
 *  on-disk truth. */
export function interleaveClipChunk(planar: Float32Array, frames: number): Float32Array {
  const out = new Float32Array(frames * 2);
  for (let i = 0; i < frames; i++) {
    out[2 * i] = planar[i] ?? 0;
    out[2 * i + 1] = planar[frames + i] ?? 0;
  }
  return out;
}

/** One posted chunk → the drain's input: interleaved pcm-f32 bytes at the
 *  chunk's own take-relative frame. PURE. */
export function clipChunkToMediaChunk(msg: ClipRecorderChunkMsg): ClipMediaChunk {
  const interleaved = interleaveClipChunk(msg.data, msg.frames);
  return {
    firstFrame: msg.firstFrame,
    bytes: new Uint8Array(interleaved.buffer, 0, msg.frames * CLIP_RECORDER_BYTES_PER_FRAME),
    frames: msg.frames,
  };
}

export interface ClipRecorderSink {
  /** The drain for a lane's in-flight take, or null when nothing is armed
   *  there (a late chunk after cancel is dropped ON THE FLOOR deliberately —
   *  the take it belonged to no longer exists; this is not the mid-take drop
   *  the drain forbids). */
  drainFor(lane: number): ClipMediaDrain | null;
  /** The worklet finished a lane: exactly `frames` frames were captured.
   *  Fired AFTER the final chunk was handed to the drain. */
  onDone(lane: number, frames: number): void;
}

/**
 * Attach the chunk pump: every valid `chunk` goes to its lane's drain (the
 * drain's promise chain is the ordering + backpressure — this pump hands over
 * and returns, it does not await), every `done` is reported. Returns the
 * handler for tests; the node's port is wired as a side effect.
 */
export function attachClipRecorderSink(
  node: Pick<AudioWorkletNode, 'port'>,
  sink: ClipRecorderSink,
): (e: MessageEvent) => void {
  const handler = (e: MessageEvent): void => {
    const msg = coerceClipRecorderMsg(e.data);
    if (!msg) return;
    if (msg.type === 'chunk') {
      const drain = sink.drainFor(msg.lane);
      if (!drain) return;
      // NOT awaited: ClipMediaDrain chains every write onto the previous
      // one's promise, so ordering is structural; the drain's own queue is
      // the stall-never-skip backpressure.
      void drain.add(clipChunkToMediaChunk(msg)).catch(() => {
        // The drain records the first failure itself (`drain.error`); the
        // commit path reads it. Swallow here so an OPFS error cannot become
        // an unhandled rejection inside onmessage.
      });
      return;
    }
    sink.onDone(msg.lane, msg.frames);
  };
  node.port.onmessage = handler;
  return handler;
}
