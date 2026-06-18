// packages/web/src/lib/video/recorderbox-capture-drain.ts
//
// RECORDERBOX audio capture-drain core (PURE — no Web Audio, no mediabunny, no
// DOM, so it unit-tests headlessly and is CI-safe).
//
// ── Why this exists ──────────────────────────────────────────────────────────
// The old capture path fed mediabunny a `MediaStreamAudioTrackSource`, which
// HARD-DROPS incoming samples when the AAC encoder's queue backs up under
// main-thread load (mediabunny media-source.ts: `if (queueSize >= 8) {
// sample.close(); return; }`). A dropped sample then makes mediabunny insert a
// silence-fill for the missing frames — that discontinuity IS the click/pop,
// baked into the file (never heard live because the OS speaker callback is
// realtime-priority while the main-thread capture reader is not).
//
// The fix: capture on the AUDIO THREAD via an AudioWorklet tap that posts planar
// stereo Float32 chunks (the port buffers under load — the audio thread never
// drops), then drain them on the main thread through mediabunny's BACKPRESSURED
// `AudioSampleSource.add()` (await). When the encoder is busy the queue FILLS and
// drains later — no sample is ever lost, and timestamps stay monotonic +
// contiguous (audio-clock authoritative), so mediabunny never silence-pads.
//
// This module is the pure heart of that: a queue of worklet chunks → a stream of
// AudioSampleInit objects with correct timestamps, plus the drain loop that
// respects an injected (awaitable) `add`. The Web-Audio worklet wiring lives in
// video/modules/recorderbox.ts; the mediabunny AudioSampleSource lives in
// recorderbox-recorder.ts.

/** One stereo block posted by the capture worklet. `data` is PLANAR f32:
 *  `[L0..L(frames-1), R0..R(frames-1)]` (length === 2 * frames) — exactly the
 *  layout mediabunny's `AudioSample` wants for `format: 'f32-planar'`,
 *  `numberOfChannels: 2`. */
export interface CaptureChunk {
  data: Float32Array;
  frames: number;
}

/** The init object handed to `new AudioSample(...)` (mediabunny). Kept as a plain
 *  structural type so this core never imports mediabunny / WebCodecs. */
export interface CaptureSampleInit {
  data: Float32Array;
  format: 'f32-planar';
  numberOfChannels: 2;
  sampleRate: number;
  /** Presentation timestamp in SECONDS — monotonic + contiguous (audio clock). */
  timestamp: number;
}

/**
 * Buffers worklet-posted stereo chunks and converts them, in order, to
 * timestamped AudioSampleInit objects. The audio thread `push()`es (never drops);
 * the recorder `drain()`s through a backpressured `add`.
 */
export class AudioCaptureDrain {
  private queue: CaptureChunk[] = [];
  private cumulativeFrames = 0;
  private closed = false;
  private running = false;
  /** Largest queue depth (frames) seen — diagnostic for tuning / tests. */
  private peakPending = 0;

  /**
   * @param sampleRate the capture context rate (the ENCODABLE rate — 44.1/48k,
   *        post the low-rate→48k bridge in recorderbox.ts).
   * @param t0 timestamp (seconds) of the first frame; share the video track's t0
   *        for A/V sync (defaults to 0 → 'zero' basis).
   */
  constructor(private readonly sampleRate: number, private readonly t0 = 0) {
    if (!(sampleRate > 0)) throw new Error('AudioCaptureDrain: sampleRate must be > 0');
  }

  /** A worklet chunk arrived. Never drops — under load the queue simply grows and
   *  drains later (the whole point). A zero-frame / mismatched chunk is ignored
   *  defensively (a malformed post can't corrupt the timestamp clock). */
  push(chunk: CaptureChunk): void {
    if (this.closed) return;
    if (!chunk || chunk.frames <= 0 || chunk.data.length < chunk.frames * 2) return;
    this.queue.push(chunk);
    const pending = this.pendingFrames;
    if (pending > this.peakPending) this.peakPending = pending;
  }

  /** Pop the next chunk as a timestamped sample init, or null when the queue is
   *  empty. Timestamp = t0 + (frames emitted so far)/sampleRate, so successive
   *  samples are exactly contiguous (no overlap, no gap) regardless of when they
   *  were pushed — the audio clock, not wall time, drives A/V. Pure. */
  next(): CaptureSampleInit | null {
    const chunk = this.queue.shift();
    if (!chunk) return null;
    const timestamp = this.t0 + this.cumulativeFrames / this.sampleRate;
    this.cumulativeFrames += chunk.frames;
    return {
      data: chunk.data,
      format: 'f32-planar',
      numberOfChannels: 2,
      sampleRate: this.sampleRate,
      timestamp,
    };
  }

  /**
   * Drain the queue through the backpressured `add` until closed + empty. For
   * each queued chunk: build the sample init and `await add(init)` — the await is
   * what makes capture LOSSLESS (when the encoder is busy, add() blocks, the
   * queue fills, and we resume draining when it frees, instead of dropping). When
   * the queue is momentarily empty (capture out-pacing... i.e. encoder caught up),
   * `await idle()` yields until more arrives or close() is called. Single-flight:
   * a second concurrent call is a no-op.
   */
  async drain(
    add: (init: CaptureSampleInit) => Promise<void>,
    idle: () => Promise<void>,
  ): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      // Continue while more can still arrive (open) OR data remains to flush.
      while (!this.closed || this.queue.length > 0) {
        const init = this.next();
        if (!init) {
          if (this.closed) break; // closed + drained → done
          await idle();
          continue;
        }
        await add(init);
      }
    } finally {
      this.running = false;
    }
  }

  /** No more chunks will be pushed; the drain loop flushes what's queued + exits. */
  close(): void {
    this.closed = true;
  }

  /** Frames still waiting to be encoded (queue depth). */
  get pendingFrames(): number {
    let n = 0;
    for (const c of this.queue) n += c.frames;
    return n;
  }

  /** Total frames handed to the encoder so far (drives the timestamp clock). */
  get framesEmitted(): number {
    return this.cumulativeFrames;
  }

  /** Peak queue depth observed (frames) — for tuning the worklet batch size. */
  get peakPendingFrames(): number {
    return this.peakPending;
  }
}
