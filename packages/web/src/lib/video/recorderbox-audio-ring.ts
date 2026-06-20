// packages/web/src/lib/video/recorderbox-audio-ring.ts
//
// Rolling planar-stereo-f32 ring buffer that retains the trailing N seconds of
// already-emitted capture audio — the 5-SECOND AUDIO OVERLAP for GoPro-style
// chunking. When the recorder rolls to chunk N+1, it PREPENDS this ring's
// retained tail (the last 5 s of chunk N's audio) as the start of chunk N+1, so
// the two files overlap by 5 s of identical audio.
//
// Layout matches the capture path: each frame has an L sample and an R sample;
// we keep two parallel per-channel ring buffers (L[], R[]) so a snapshot can
// rebuild a contiguous planar block `[L0..L(k-1), R0..R(k-1)]` — exactly the
// `f32-planar` / 2-channel shape mediabunny's AudioSample wants.
//
// PURE — no Web Audio, no mediabunny, no DOM — so retention/wraparound/snapshot
// are unit-tested headlessly (CI-safe). The recorder's drain pushes every emitted
// chunk through `pushChunk`; `snapshotPlanar()` materializes the retained tail.

/** One stereo block (PLANAR f32: `[L0..L(frames-1), R0..R(frames-1)]`, length
 *  `2 * frames`) — the same `CaptureChunk` shape the drain emits. */
export interface PlanarStereoChunk {
  data: Float32Array;
  frames: number;
}

/**
 * A fixed-capacity rolling buffer holding the last `capacityFrames` stereo frames.
 * Older frames fall off the front as new ones arrive (the "last N seconds"
 * window). Two per-channel circular buffers keep the planar layout cheap to
 * reconstruct.
 */
export class AudioRingBuffer {
  /** Capacity in FRAMES (e.g. 5 * sampleRate for a 5 s overlap at this rate). */
  readonly capacityFrames: number;
  private readonly L: Float32Array;
  private readonly R: Float32Array;
  /** Write cursor (next slot to write), modulo capacity. */
  private head = 0;
  /** Frames currently retained (≤ capacity). */
  private filled = 0;

  constructor(capacityFrames: number) {
    if (!(capacityFrames > 0)) throw new Error('AudioRingBuffer: capacityFrames must be > 0');
    this.capacityFrames = Math.floor(capacityFrames);
    this.L = new Float32Array(this.capacityFrames);
    this.R = new Float32Array(this.capacityFrames);
  }

  /** Frames currently retained (0..capacity). */
  get retainedFrames(): number {
    return this.filled;
  }

  /**
   * Append a planar stereo chunk's frames into the ring (older frames roll off
   * once full). A malformed/short chunk is ignored defensively (a bad post can't
   * corrupt the window). The `data` is COPIED in — the caller may reuse its buffer.
   */
  pushChunk(chunk: PlanarStereoChunk): void {
    if (!chunk || chunk.frames <= 0) return;
    const frames = chunk.frames;
    if (chunk.data.length < frames * 2) return;
    const cap = this.capacityFrames;
    // If the incoming block is bigger than the whole window, only its TAIL can be
    // retained — fast-path to the last `cap` frames.
    const start = frames > cap ? frames - cap : 0;
    for (let i = start; i < frames; i++) {
      this.L[this.head] = chunk.data[i];
      this.R[this.head] = chunk.data[frames + i];
      this.head = (this.head + 1) % cap;
      if (this.filled < cap) this.filled++;
    }
  }

  /**
   * Materialize the retained tail as a single contiguous PLANAR stereo chunk in
   * chronological order (oldest retained frame first): `[L…, R…]`, length
   * `2 * retainedFrames`. Returns a chunk of `frames === retainedFrames` (0 when
   * empty — e.g. the very first chunk has no preceding audio → overlap = none).
   * Does NOT mutate the ring (snapshot is read-only).
   */
  snapshotPlanar(): PlanarStereoChunk {
    const n = this.filled;
    const data = new Float32Array(n * 2);
    if (n === 0) return { data, frames: 0 };
    const cap = this.capacityFrames;
    // Oldest retained frame is `n` slots behind head (mod cap).
    const startIdx = (this.head - n + cap) % cap;
    for (let i = 0; i < n; i++) {
      const src = (startIdx + i) % cap;
      data[i] = this.L[src];      // L plane
      data[n + i] = this.R[src];  // R plane
    }
    return { data, frames: n };
  }

  /** Drop everything retained (e.g. on a hard reset). */
  clear(): void {
    this.head = 0;
    this.filled = 0;
  }
}
