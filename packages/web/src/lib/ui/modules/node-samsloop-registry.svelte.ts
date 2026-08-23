// node-samsloop-registry.svelte.ts
//
// NODE-OWNED AUDIO-TAKE LIFETIME — the registry that makes an in-progress
// SAMSLOOP recording outlive the CARD that started it.
//
// THE BUG THIS EXISTS FOR (#1588, P0, found by the #1583 audit): press REC on
// SAMSLOOP, then collapse the module — or let its dock pane be LRU-evicted when
// a third module is expanded, or press ESC, or M/E, or navigate — and up to 60 s
// of unrepeatable live audio was **silently destroyed**. `SamsloopCard`'s
// unmount `$effect` ran:
//
//     if (attachedTap) {
//       attachedTap.setEnabled(false);
//       attachedTap.port.removeEventListener('message', tapHandler);
//     }
//     if (pendingPeakRaf !== null) cancelAnimationFrame(pendingPeakRaf);
//     if (recCounterTicker !== null) clearInterval(recCounterTicker);
//
// ⚠ AND NOTHING CALLED `stopRecording()`. That function is the ONLY path that
// encodes the buffer and writes `node.data.sample`; there was no `onDestroy`, no
// `beforeunload` and no flush anywhere else. So this was STRICTLY WORSE than
// recorderbox before #1574, which at least called `abandon()` and left a
// recover candidate on disk. Here the PCM lived only in a card-local
// `SamsloopCaptureBuffer`, and the unmount dropped the last reference to it.
// Re-expanding showed REC idle, elapsed 0 and the previous waveform.
//
// FOUR card-owned things died with that unmount, and each is fatal on its own:
//   1. THE TAP           — `setEnabled(false)` told the samsloop-tap worklet to
//                          stop posting. Even a surviving buffer receives
//                          nothing after this.
//   2. THE PUMP          — `removeEventListener('message', …)`. SAMSLOOP's
//                          capture pump is the tap port's message handler
//                          (PUSH, ~375 chunks/s at 48 kHz / 128 frames), not a
//                          rAF loop. Removing the listener is the exact
//                          equivalent of #1574's `cancelAnimationFrame`.
//   3. THE ACCUMULATOR   — `capture` was a `let` in the card's instance scope.
//                          The unmount is what made the take unrecoverable:
//                          there is no on-disk artifact for SAMSLOOP, so
//                          "abandon" and "destroy" are the same event here.
//   4. THE COMMIT PATH   — the encode-and-write lived in the card's
//                          `stopRecording`, so even a surviving buffer had
//                          nobody left who knew how to finalize it. This is the
//                          mechanism #1574 did not have, and it is why the
//                          registry — not the card — owns the commit.
//
// There is deliberately NO render-lease mechanism here (#1531/#1574's fourth):
// SAMSLOOP is an AUDIO module. Web Audio evaluates the whole connected graph
// regardless of what is on screen, so nothing about the capture depends on a
// pull root. Its absence is a fact about the domain, not an omission — see the
// "why this is not the recorder registry" note below.
//
// THE RULE THIS ENCODES is the one `$lib/ui/media/node-media-registry` encodes
// for <video>/<img>, `node-present-registry` for projectors (#1531) and
// `node-recorder-registry` for recorderbox's video take (#1574): a resource
// whose LIFETIME is the node's belongs to the NODE, never to whichever view
// happens to be rendering it. Cards ADOPT and READ; they do not CREATE and
// DESTROY. Teardown keys to GRAPH lifetime — `sweep(liveNodeIds)` from Canvas,
// reconciled against the live node set — so a node deleted by ANY route (menu,
// lasso, undo, a peer's CRDT delete, Clear, a patch load) ends its recording
// with no delete site having to remember.
//
// ── WHY THIS IS NOT `node-recorder-registry`, CHECKED FIELD BY FIELD ──────
//
// #1574's registry was the obvious host for this and it does not fit. Every
// element of its contract is video-specific, and the mismatch is total rather
// than partial:
//
//   RecorderEngine (canvas / blitOutputToDrawingBuffer / acquireRenderLease)
//        → SAMSLOOP has no engine handle of that shape and no lease to take.
//   makeRecorder(RecorderboxRecorderOptions) → RecorderboxRecorder
//        → SAMSLOOP's "recorder" is a MessagePort plus a fixed-capacity
//          Float32 accumulator; there is no encoder object at all until STOP.
//   makeCanvas(w, h)
//        → nothing. There is no capture surface; mechanism 3 of #1574 has no
//          analogue because audio never lived in a DOM element.
//   startPump(tick)
//        → the seam is PULL (schedule me, I will read a frame). SAMSLOOP's
//          capture is PUSH (the worklet posts when it has 128 frames). There is
//          no tick to schedule, and inverting it would mean polling a port.
//   stop() → Promise<savedFileName>
//        → SAMSLOOP's stop must ENCODE (quantize + decimate + base64) and WRITE
//          `node.data.sample` through the Yjs envelope. Different terminal act.
//   sweep() → recorder.abandon()  (leaves a recover candidate on disk)
//        → SAMSLOOP has no on-disk artifact and, once the node is gone, no
//          commit target either. Its sweep can only drop the bytes.
//
// Six of six differ. What the two DO share is the Map + a reactive version
// counter + `sweep`, i.e. about a dozen lines, and node-present-registry
// already declines to share those with node-recorder-registry for the same
// reason (one is a class with `$state` fields, the other a factory closure).
// Extracting a `NodeKeyedRegistry<T>` base would refactor two shipped P0 fixes
// to dedupe three lines each and would still leave all the interesting code
// here. What generalizes is the RULE, and the rule is stated in all four files.
//
// HASH TRANSPARENCY: this lives under `lib/ui/**`, NOT `lib/video/**` (hashed
// WHOLESALE for the WebGL attest) and not in `lib/audio/modules/**` (globbed by
// `module-manifest.ts`, which treats every `.ts` there as a module def). Both
// placements are deliberate constraints on any future edit: do not move it.
//
// TESTABILITY: the clock, the publish ticker and the COMMIT are injectable
// seams, so the whole registry drives under vitest's node environment with no
// rAF, no DOM, no AudioContext and no Yjs store.

import { patch } from '$lib/graph/store';
import {
  SamsloopCaptureBuffer,
  buildRecordedSample,
  clearSamsloopUploadKeys,
  encodeRecordingBytes,
  foldCapturePeaks,
  SAMSLOOP_PEAK_SLOT_NONE,
  type SamsloopRecBits,
  type SamsloopRecChannels,
  type SamsloopRecRate,
} from '$lib/audio/modules/samsloop-record';
import { SAMSLOOP_WINDOW_RANGE } from '$lib/audio/modules/samsloop';

/** The engine handle's `recTap` surface: the worklet's port, its enable switch
 *  and the rate it captures at. Resolved by the CARD at REC-press time (it is
 *  read through the card's engine context) and stored on the entry, because the
 *  ENGINE outlives every card while the card's context handle does not. */
export interface SamsloopTap {
  port: Pick<MessagePort, 'addEventListener' | 'removeEventListener' | 'start'>;
  setEnabled(enabled: boolean): void;
  /** The AudioContext's native rate — what the capture actually is. */
  sampleRate: number;
}

/** Everything a take needs, resolved ONCE at REC-press time. The settings are
 *  frozen for the take's duration (the card stops the recording on any settings
 *  change), so the registry never has to re-read them from a card that may not
 *  be mounted. */
export interface StartTakeArgs {
  tap: SamsloopTap;
  /** Accumulator capacity in CAPTURE-rate frames — `samsloopMaxCaptureFrames`
   *  of the tap's own rate, the settings and the live rack headroom. Its
   *  capacity IS the byte budget, so `full` is the auto-stop trigger and no
   *  separate seconds arithmetic can disagree with it. */
  captureFrames: number;
  /** Pixel width of the card's live-record bar at REC time. The peak buffer is
   *  registry-owned so the bar keeps filling while the card is gone and shows
   *  the WHOLE take on re-expand, not a hole where the collapse was. */
  barWidth: number;
  /** Seconds the bar's x-axis spans (`samsloopMaxSecondsExact`). */
  barSeconds: number;
  rate: SamsloopRecRate;
  bits: SamsloopRecBits;
  channels: SamsloopRecChannels;
}

/** A finished take, handed to the commit seam. Raw capture-rate Float32 — the
 *  encode (decimate + quantize + base64) happens inside the commit so a test
 *  double can observe the SAMPLES rather than a base64 blob. */
export interface FinishedTake {
  l: Float32Array;
  r: Float32Array;
  /** The rate the samples ARE — the tap's own, never the RATE switch. */
  captureRate: number;
  rate: SamsloopRecRate;
  bits: SamsloopRecBits;
  channels: SamsloopRecChannels;
}

/** Why a take ended. `node-removed` is not a user outcome — the node left the
 *  graph, so there is nothing to commit into. */
export type SamsloopStopReason = 'user' | 'cap' | 'node-removed';

/** LIFECYCLE read for a card: what this node's take IS. Changes rarely (start /
 *  stop / sweep), so it is published on the coarse version counter. */
export interface SamsloopTakeView {
  state: 'recording' | 'stopped';
  stopReason: SamsloopStopReason | null;
  /** True once a stopped take's bytes reached `node.data.sample`. */
  committed: boolean;
  captureRate: number;
  capacityFrames: number;
  barWidth: number;
  barSeconds: number;
  rate: SamsloopRecRate;
  bits: SamsloopRecBits;
  channels: SamsloopRecChannels;
}

/**
 * PROGRESS read for a card: how much has actually been CAPTURED.
 *
 * ⚠ READ THE `elapsed` / `wallElapsed` SPLIT BEFORE ASSERTING ON EITHER. The
 * card used to show `(performance.now() - recStartTimeMs) / 1000`, and that
 * number is INVARIANT TO THE PUMP BEING DEAD: a wall clock advances whether or
 * not a single sample arrived. Asserting on it would have been a gate blind to
 * exactly the defect #1588 is about — the half-fix where the entry survives the
 * collapse but the tap is detached.
 *
 *   * `elapsed`     = frames / captureRate. The LENGTH OF THE TAKE. Moves only
 *                     when the tap posts and the accumulator appends, so it is
 *                     the causal quantity and it is what every assertion uses.
 *   * `wallElapsed` = the wall clock since REC. Kept, and named for what it is,
 *                     precisely so the two can be compared: a permanent unit
 *                     test asserts wallElapsed grows while elapsed stays 0 when
 *                     the tap posts nothing. That is the negative control on
 *                     the INSTRUMENT, not on the code.
 */
export interface SamsloopTakeProgress {
  frames: number;
  elapsed: number;
  wallElapsed: number;
  /** Peak-per-column for the live bar. Mutated in place; valid until the next
   *  chunk. Read it inside the same effect run that read this object. */
  peaks: Float32Array;
  capacityFrames: number;
  barWidth: number;
  barSeconds: number;
}

/** The flat, structured-clone-safe shape the e2e probe reads (Canvas exposes it
 *  as `__samsloopRecording`). Declared here so the spec and the registry cannot
 *  drift about what a field means. */
export interface SamsloopProbe {
  recording: boolean;
  state: 'recording' | 'stopped' | null;
  stopReason: SamsloopStopReason | null;
  committed: boolean;
  frames: number;
  elapsed: number;
  wallElapsed: number;
  captureRate: number;
  capacityFrames: number;
}

interface Entry {
  nodeId: string;
  tap: SamsloopTap;
  handler: (ev: MessageEvent) => void;
  /** Null once the take is committed — the bytes are encoded, so a 3 MB
   *  accumulator should not linger until the node is deleted. */
  capture: SamsloopCaptureBuffer | null;
  /** ⚠ MIRRORED OFF THE BUFFER, not read through it. `frames` and
   *  `capacityFrames` must still answer after `capture` is released, or a card
   *  that re-mounts after the stop reads a take of length 0 and redraws a blank
   *  bar — and the e2e's causal probe would read 0 for a take that finished
   *  perfectly. Written on the one path that changes them. */
  frames: number;
  capacityFrames: number;
  peaks: Float32Array;
  peakSlot: number;
  samplesPerSlot: number;
  barWidth: number;
  barSeconds: number;
  captureRate: number;
  rate: SamsloopRecRate;
  bits: SamsloopRecBits;
  channels: SamsloopRecChannels;
  startedAtMs: number;
  wallElapsed: number;
  state: 'recording' | 'stopped';
  stopReason: SamsloopStopReason | null;
  committed: boolean;
  stopTicker: () => void;
}

/** Injectable seams (tests replace these; production uses the real ones). */
export interface SamsloopRegistryDeps {
  /** Monotonic milliseconds. */
  now(): number;
  /**
   * Start the PUBLISH ticker and return its canceller. This is NOT the capture
   * pump — capture is push-driven by the tap. All this does is bump the
   * reactive counter so a mounted card repaints at a sane rate.
   *
   * ⚠ IT IS DELIBERATELY NOT A rAF. The card used to coalesce redraws onto
   * `requestAnimationFrame`, which is one more mechanism to keep alive across a
   * collapse for no benefit: nothing is painting while the card is gone, and
   * 20 Hz is more than enough for a peak bar. Fewer moving parts is the point
   * of the whole file.
   */
  startTicker(tick: () => void): () => void;
  /**
   * Write a finished take onto the node. Returns true if it landed.
   * Injected so the registry drives with no Yjs store under vitest — and so a
   * test can observe the raw Float32 the card would otherwise have encoded away.
   */
  commit(nodeId: string, take: FinishedTake): boolean;
}

/** How often the reactive counter is bumped while recording, in ms. A DISPLAY
 *  cadence, not a capture one — nothing is lost if a bump is late. */
const PUBLISH_MS = 50;

/**
 * Encode + write a finished take onto a node-shaped TARGET.
 *
 * Takes the target rather than an id so it is unit-testable against a plain
 * object, and so the whole commit — including the one-sample invariant's
 * upload-key clear and the window-fader reset — is one reviewable function
 * instead of a tail of statements inside a card's stop handler. This is the
 * mechanism #1574 did not need: recorderbox's take becomes a FILE, SAMSLOOP's
 * becomes graph data, so the finalize step cannot live in the view.
 */
export function writeSamsloopTake(
  target: { data?: Record<string, unknown>; params: Record<string, number> },
  take: FinishedTake,
): { frames: number; storedRate: number } | null {
  if (take.l.length === 0) return null;
  // ⚠ `storedRate` is the ENCODER's answer, not `take.rate`. The RATE switch is
  // a request; integer decimation may not be able to honour it, and tagging the
  // bytes with the request is what detuned every take made from a 48 kHz
  // context (−148 cents, 8.8 % long). See `samsloopAchievedRate`.
  const { bytes, rate: storedRate } = encodeRecordingBytes(
    take.l,
    take.r,
    take.captureRate,
    take.rate,
    take.bits,
    take.channels,
  );
  if (!target.data) target.data = {};
  const d = target.data;
  // THE ONE-SAMPLE INVARIANT (samsloop.ts header): a new recording REPLACES the
  // previously loaded sample. Clear the upload keys FIRST — a record-after-
  // upload that left both sets on node.data made the reader's precedence, not
  // the user's last action, decide what plays.
  clearSamsloopUploadKeys(d);
  const { sample, frames } = buildRecordedSample(bytes, storedRate, take.bits, take.channels);
  d.sample = sample;
  // The window faders bound against these. Written straight from the encode
  // rather than waiting on the factory's poll, so they are correct the instant
  // REC stops.
  d.sampleLength = frames;
  d.sampleRate = storedRate;
  // The window opens to the WHOLE take. As a FRACTION that is 0..1 and does not
  // depend on `frames` at all — which is the point: `end = frames` was a frame
  // index against a param declared `0..1e6`, so a take longer than ~20.8 s at
  // 48 kHz wrote an END the model silently clamped away.
  target.params.start = SAMSLOOP_WINDOW_RANGE.min;
  target.params.end = SAMSLOOP_WINDOW_RANGE.max;
  return { frames, storedRate };
}

const defaultDeps: SamsloopRegistryDeps = {
  now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  startTicker: (tick) => {
    const h = setInterval(tick, PUBLISH_MS);
    return () => clearInterval(h);
  },
  commit: (nodeId, take) => {
    const t = patch.nodes[nodeId] as
      | { data?: Record<string, unknown>; params: Record<string, number> }
      | undefined;
    // The node went away between the last chunk and the commit (a peer's
    // delete, Clear, a patch load). Nothing to write into; the sweep will have
    // torn the machinery down already.
    if (!t) return false;
    return writeSamsloopTake(t, take) !== null;
  },
};

export class NodeSamsloopRegistry {
  #entries = new Map<string, Entry>();
  /** LIFECYCLE version — start / stop / sweep. Read by `isRecording` + `view`. */
  #version = $state(0);
  /**
   * PROGRESS version — bumped by the publish ticker only. Split from `#version`
   * on purpose: a single counter bumped at 20 Hz would invalidate EVERY card
   * that ever read the registry, and a non-recording SAMSLOOP card's waveform
   * effect decodes its persisted PCM on each run. Cards subscribe to this one
   * only inside the `if (isRecording)` branch, so an idle card pays nothing.
   */
  #captureVersion = $state(0);
  #deps: SamsloopRegistryDeps;

  constructor(deps: Partial<SamsloopRegistryDeps> = {}) {
    this.#deps = { ...defaultDeps, ...deps };
  }

  /** Is this node capturing right now? Survives card unmount by construction. */
  isRecording(nodeId: string): boolean {
    void this.#version;
    return this.#entries.get(nodeId)?.state === 'recording';
  }

  /** Reactive LIFECYCLE read for a card. Null when this node has no take. */
  view(nodeId: string): SamsloopTakeView | null {
    void this.#version;
    const e = this.#entries.get(nodeId);
    if (!e) return null;
    return {
      state: e.state,
      stopReason: e.stopReason,
      committed: e.committed,
      captureRate: e.captureRate,
      capacityFrames: e.capacityFrames,
      barWidth: e.barWidth,
      barSeconds: e.barSeconds,
      rate: e.rate,
      bits: e.bits,
      channels: e.channels,
    };
  }

  /** Reactive PROGRESS read — see `SamsloopTakeProgress` on why `elapsed` and
   *  `wallElapsed` are two different numbers. */
  progress(nodeId: string): SamsloopTakeProgress | null {
    void this.#version;
    void this.#captureVersion;
    const e = this.#entries.get(nodeId);
    if (!e) return null;
    return {
      frames: e.frames,
      elapsed: e.captureRate > 0 ? e.frames / e.captureRate : 0,
      wallElapsed: e.wallElapsed,
      peaks: e.peaks,
      capacityFrames: e.capacityFrames,
      barWidth: e.barWidth,
      barSeconds: e.barSeconds,
    };
  }

  /** Flat probe for the e2e hook + diagnostics. One shape, defined once. */
  probe(nodeId: string): SamsloopProbe {
    const v = this.view(nodeId);
    const p = this.progress(nodeId);
    return {
      recording: this.isRecording(nodeId),
      state: v?.state ?? null,
      stopReason: v?.stopReason ?? null,
      committed: v?.committed ?? false,
      frames: p?.frames ?? 0,
      elapsed: p?.elapsed ?? 0,
      wallElapsed: p?.wallElapsed ?? 0,
      captureRate: v?.captureRate ?? 0,
      capacityFrames: v?.capacityFrames ?? 0,
    };
  }

  /**
   * Begin a take owned by `nodeId`.
   *
   * Idempotent while one is live: a second press cannot silently replace the
   * take the user is already making. A STOPPED entry, by contrast, is replaced —
   * that is the ordinary "record again" case and the one-sample invariant says
   * the new take wins.
   *
   * @returns true if a take is now running.
   */
  start(nodeId: string, args: StartTakeArgs): boolean {
    if (this.#entries.get(nodeId)?.state === 'recording') return true;

    const captureRate = args.tap.sampleRate > 0 ? args.tap.sampleRate : 0;
    const barWidth = Math.max(1, Math.floor(args.barWidth));
    // The bar's x-axis is `barSeconds` wide, so one column is that many capture
    // frames. Derived once here rather than per chunk from a card-held width.
    const samplesPerSlot = Math.max(
      1,
      Math.floor((captureRate * args.barSeconds) / barWidth),
    );

    const capture = new SamsloopCaptureBuffer(args.captureFrames);
    const entry: Entry = {
      nodeId,
      tap: args.tap,
      handler: () => {},
      capture,
      frames: 0,
      capacityFrames: capture.capacityFrames,
      peaks: new Float32Array(barWidth),
      peakSlot: SAMSLOOP_PEAK_SLOT_NONE,
      samplesPerSlot,
      barWidth,
      barSeconds: args.barSeconds,
      captureRate,
      rate: args.rate,
      bits: args.bits,
      channels: args.channels,
      startedAtMs: this.#deps.now(),
      wallElapsed: 0,
      state: 'recording',
      stopReason: null,
      committed: false,
      stopTicker: () => {},
    };

    // THE PUMP. A push-side listener, owned here — this is the line whose
    // card-scoped twin destroyed the take.
    entry.handler = (ev: MessageEvent) => {
      const msg = ev.data as { type?: string; l?: Float32Array; r?: Float32Array } | null;
      if (!msg || msg.type !== 'chunk' || !msg.l || !msg.r) return;
      this.#onChunk(entry, msg.l, msg.r);
    };
    try {
      args.tap.port.addEventListener('message', entry.handler as EventListener);
      // `addEventListener` does NOT auto-start a MessagePort (only `onmessage`
      // does), so this is load-bearing, not defensive.
      args.tap.port.start();
    } catch {
      /* an exotic port shape — the enable below is still worth attempting */
    }
    try {
      args.tap.setEnabled(true);
    } catch {
      /* the worklet is gone; the take will simply capture nothing */
    }

    entry.stopTicker = this.#deps.startTicker(() => {
      entry.wallElapsed = (this.#deps.now() - entry.startedAtMs) / 1000;
      this.#captureVersion++;
    });

    this.#entries.set(nodeId, entry);
    this.#bump();
    return true;
  }

  /** One capture chunk from the tap worklet: append, fold the bar, cap-stop. */
  #onChunk(entry: Entry, l: Float32Array, r: Float32Array): void {
    if (entry.state !== 'recording' || !entry.capture) return;
    const before = entry.capture.frames;
    const written = entry.capture.append(l, r);
    entry.frames = entry.capture.frames;
    if (written > 0) {
      // O(chunk) running max per column — see `foldCapturePeaks` for why a
      // per-chunk column rescan was quadratic in the byte budget. L only, so
      // the trace's shape does not change with the CHAN switch.
      entry.peakSlot = foldCapturePeaks(
        entry.peaks,
        entry.samplesPerSlot,
        before,
        l,
        written,
        entry.peakSlot,
      );
    }
    // AUTO-STOP ON CAP, and it now happens WHEREVER the card is. The
    // accumulator's capacity IS the budget, so `full` is the trigger and the
    // take is finalized even if nobody is looking — which is the second half of
    // #1588's acceptance ("collapse, then stop while collapsed: a complete take
    // is written").
    if (entry.capture.full) this.stop(entry.nodeId, 'cap');
  }

  /**
   * USER INTENT (or the cap): finish the take, encode it and write it to the
   * node. The ONLY endings besides `sweep()`.
   *
   * @returns true if bytes reached `node.data.sample`.
   */
  stop(nodeId: string, reason: 'user' | 'cap'): boolean {
    const entry = this.#entries.get(nodeId);
    if (!entry || entry.state !== 'recording') return false;
    this.#endCapture(entry);
    entry.state = 'stopped';
    entry.stopReason = reason;
    const captured = entry.capture?.channels();
    let committed = false;
    if (captured && captured.l.length > 0) {
      committed = this.#deps.commit(nodeId, {
        l: captured.l,
        r: captured.r,
        captureRate: entry.captureRate,
        rate: entry.rate,
        bits: entry.bits,
        channels: entry.channels,
      });
    }
    entry.committed = committed;
    // Release the accumulator now the bytes are encoded — a 3 MB take should not
    // linger until the node is deleted. The entry itself stays (frames and
    // capacity are mirrored on it) so a card that re-mounts after the stop can
    // still read "max length reached" and redraw the take it just made.
    entry.capture = null;
    this.#bump();
    return committed;
  }

  /**
   * GRAPH LIFETIME: the node is gone (deleted by ANY route), so its take has no
   * commit target — there is no `node.data` left to write into, and unlike
   * recorderbox there is no on-disk recover candidate either. Drop it.
   *
   * This is the ONLY teardown besides `stop()`, and it is keyed to the node set
   * rather than to any view. That is the whole point of the file.
   */
  sweep(liveNodeIds: Iterable<string>): void {
    const live = liveNodeIds instanceof Set ? liveNodeIds : new Set(liveNodeIds);
    let changed = false;
    for (const [nodeId, entry] of [...this.#entries]) {
      if (live.has(nodeId)) continue;
      this.#entries.delete(nodeId);
      if (entry.state === 'recording') {
        this.#endCapture(entry);
        entry.state = 'stopped';
        entry.stopReason = 'node-removed';
        entry.capture = null;
      }
      changed = true;
    }
    if (changed) this.#bump();
  }

  /** Detach the machinery around a live capture. NEVER called on card unmount —
   *  there is no public route to it, and that absence is the guard. */
  #endCapture(entry: Entry): void {
    entry.stopTicker();
    entry.stopTicker = () => {};
    try {
      entry.tap.setEnabled(false);
    } catch {
      /* the worklet is already gone */
    }
    try {
      entry.tap.port.removeEventListener('message', entry.handler as EventListener);
    } catch {
      /* ditto */
    }
  }

  #bump(): void {
    this.#version++;
  }

  /** Test-only introspection: which nodes hold an entry (live or stopped). */
  get nodeIds(): string[] {
    void this.#version;
    return [...this.#entries.keys()];
  }

  /** Test-only introspection: which nodes are capturing right now. */
  get recordingNodeIds(): string[] {
    void this.#version;
    return [...this.#entries.values()].filter((e) => e.state === 'recording').map((e) => e.nodeId);
  }
}

/** The singleton the cards read through. */
export const nodeSamsloop = new NodeSamsloopRegistry();
