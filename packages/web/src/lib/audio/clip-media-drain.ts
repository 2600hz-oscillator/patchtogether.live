// packages/web/src/lib/audio/clip-media-drain.ts
//
// THE DRAIN — chunks from the capture worklet to the clip media store, in
// order, with backpressure, and WITHOUT EVER DROPPING ONE.
//
// ⚠ THE WHOLE POINT OF THIS FILE IS THE THING IT REFUSES TO DO. A chunk dropped
// to catch up is a HOLE IN THE MIDDLE OF A LOOP. recorderbox measured what that
// sounds like: its old capture path hard-dropped at `queueSize >= 8` and the
// muxer silence-padded the gap — "that discontinuity is the click". A video CFR
// grid can absorb a jittery producer; a loop whose length must be an exact
// number of samples cannot, and unlike a video glitch a hole in a loop is heard
// on every single pass.
//
// So when the disk falls behind, this STALLS. The queue grows and drains later,
// which is exactly what `recorderbox-capture-drain.ts` decided and for the same
// reason. Memory is the price and it is bounded by the take's own byte ceiling.
//
// ⚠ AND A STALL IS NOT A DEBT TO REPAY BY GOING FASTER. There is nothing to
// catch up: the producer is the audio thread and it has already produced the
// samples. The drain owes the disk every byte it was handed, in order, however
// long that takes.

import type { ClipMediaWriter } from './clip-media-store';

/** One planar chunk as the capture worklet posts it, addressed by its own first
 *  frame — so a chunk's byte offset is a pure function of the chunk, never of
 *  how many chunks happen to have been written before it. */
export interface ClipMediaChunk {
  /** The take-relative frame this chunk starts at. */
  firstFrame: number;
  /** Interleaved/planar bytes for `frames` frames — the store does not
   *  interpret them, it positions them. */
  bytes: Uint8Array;
  /** How many FRAMES these bytes are. */
  frames: number;
}

export interface ClipMediaDrainOptions {
  /** Bytes per frame across all channels — the byte offset multiplier. */
  bytesPerFrame: number;
  /** Called after each chunk is durable, with the highest contiguous frame
   *  count written so far. The manifest progress hook. */
  onProgress?: (frames: number) => void;
}

/**
 * Serialises chunk writes onto one `ClipMediaWriter`.
 *
 * `add()` returns a promise that resolves when THAT chunk is durable. Await it
 * to feel the backpressure; ignore it and you get the ordering anyway, because
 * every write is chained onto the previous one's promise.
 */
export class ClipMediaDrain {
  #writer: ClipMediaWriter;
  #bytesPerFrame: number;
  #onProgress?: (frames: number) => void;
  /** The tail of the write chain. Every `add` links onto it, which is what
   *  makes "in order" structural rather than a thing callers must remember. */
  #tail: Promise<void> = Promise.resolve();
  #queued = 0;
  #peakQueued = 0;
  #written = 0;
  #dropped = 0;
  #failed: unknown = null;

  constructor(writer: ClipMediaWriter, opts: ClipMediaDrainOptions) {
    this.#writer = writer;
    this.#bytesPerFrame = Math.max(1, Math.trunc(opts.bytesPerFrame));
    this.#onProgress = opts.onProgress;
  }

  /** Chunks accepted but not yet durable. */
  get queued(): number {
    return this.#queued;
  }
  /** The deepest the queue ever got — the number a stall is diagnosed from. */
  get peakQueued(): number {
    return this.#peakQueued;
  }
  /** Frames durably written. */
  get framesWritten(): number {
    return this.#written;
  }
  /** ⚠ ALWAYS 0, AND ASSERTED TO BE. Kept as a readable counter so the
   *  never-drop property is a value a test can check rather than a claim in a
   *  comment. If this is ever non-zero, someone added a drop path. */
  get dropped(): number {
    return this.#dropped;
  }
  /** The first write error, if any. A failed take keeps its scratch as a
   *  recover candidate rather than being silently discarded. */
  get error(): unknown {
    return this.#failed;
  }

  /** Queue a chunk. NEVER drops, never reorders, never returns early. */
  add(chunk: ClipMediaChunk): Promise<void> {
    this.#queued++;
    if (this.#queued > this.#peakQueued) this.#peakQueued = this.#queued;
    const position = Math.max(0, Math.trunc(chunk.firstFrame)) * this.#bytesPerFrame;
    const next = this.#tail.then(
      async () => {
        try {
          await this.#writer.write(chunk.bytes, position);
          const end = Math.max(0, Math.trunc(chunk.firstFrame)) + Math.max(0, Math.trunc(chunk.frames));
          if (end > this.#written) {
            this.#written = end;
            this.#onProgress?.(end);
          }
        } catch (err) {
          // Record and RE-THROW to this chunk's awaiter, but do not poison the
          // chain: a later chunk still gets its turn, because abandoning the
          // rest of the take on one failed write would turn a recoverable
          // partial into a shorter one for no reason.
          if (this.#failed === null) this.#failed = err;
          throw err;
        } finally {
          this.#queued--;
        }
      },
      () => {
        // The PREVIOUS chunk failed. This one still runs — see above.
        this.#queued--;
      },
    );
    // The chain's tail must never be a rejected promise, or every subsequent
    // link would short-circuit and the take would stop writing after one error.
    this.#tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** Resolve when everything queued so far is durable. */
  async flush(): Promise<void> {
    await this.#tail;
  }
}
