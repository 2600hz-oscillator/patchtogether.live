// packages/web/src/lib/video/recorderbox-recorder.test.ts
//
// Pure-logic coverage for the RECORDERBOX recorder + store helpers. The live
// Mediabunny pipeline + the OPFS Worker are exercised by the bespoke e2e
// (real encoder on this Mac); here we cover the deterministic, browser-API-
// free pieces: encoder probing (graceful-degrade matrix) + filename
// sanitization + OPFS scratch path naming.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  probeEncoders,
  RecorderboxRecorder,
  DEFAULT_VIDEO_BITRATE,
  DEFAULT_AUDIO_BITRATE,
  VIDEO_CODEC,
  AUDIO_CODEC,
  type RecorderboxRecorderOptions,
  type AudioSampleSourceLike,
} from '$lib/video/recorderbox-recorder';
import {
  sanitizeRecordingFilename,
  opfsScratchPath,
  streamOpfsToWritable,
  ensureHandleWritePermission,
  COPY_CHUNK_BYTES,
  type ChunkSink,
  type StreamableFile,
} from '$lib/video/recorderbox-store';

describe('probeEncoders — graceful-degrade matrix', () => {
  it('canRecord=true when H.264 video encode is supported', async () => {
    const s = await probeEncoders(1024, 768, 48_000, {
      canEncodeVideo: async () => true,
      canEncodeAudio: async () => true,
      hasOpfs: () => true,
    });
    expect(s.video).toBe(true);
    expect(s.audio).toBe(true);
    expect(s.opfs).toBe(true);
    expect(s.canRecord).toBe(true);
  });

  it('canRecord=false when NO H.264 encoder (the CI / no-encoder case)', async () => {
    const s = await probeEncoders(1024, 768, 48_000, {
      canEncodeVideo: async () => false,
      canEncodeAudio: async () => true,
      hasOpfs: () => true,
    });
    expect(s.video).toBe(false);
    // canRecord follows VIDEO support — a silent-but-real recording still needs
    // the video encoder; without it we disable + badge.
    expect(s.canRecord).toBe(false);
  });

  it('canRecord stays true with video but NO audio encoder (silent recording ok)', async () => {
    const s = await probeEncoders(1024, 768, 48_000, {
      canEncodeVideo: async () => true,
      canEncodeAudio: async () => false,
      hasOpfs: () => true,
    });
    expect(s.video).toBe(true);
    expect(s.audio).toBe(false);
    expect(s.canRecord).toBe(true);
  });

  it('probes H.264 at the ACTUAL recording resolution + bitrate', async () => {
    let seen: { codec: string; width: number; height: number; bitrate: number } | null = null;
    await probeEncoders(640, 480, 44_100, {
      canEncodeVideo: async (codec, opts) => { seen = { codec, ...opts }; return true; },
      canEncodeAudio: async () => true,
      hasOpfs: () => false,
    });
    expect(seen).toEqual({ codec: VIDEO_CODEC, width: 640, height: 480, bitrate: DEFAULT_VIDEO_BITRATE });
  });

  it('probes AAC stereo at the sample rate + default bitrate', async () => {
    let seen: { codec: string; numberOfChannels: number; sampleRate: number; bitrate: number } | null = null;
    await probeEncoders(640, 480, 44_100, {
      canEncodeVideo: async () => true,
      canEncodeAudio: async (codec, opts) => { seen = { codec, ...opts }; return true; },
      hasOpfs: () => false,
    });
    expect(seen).toEqual({ codec: AUDIO_CODEC, numberOfChannels: 2, sampleRate: 44_100, bitrate: DEFAULT_AUDIO_BITRATE });
  });

  it('never throws when a probe rejects — degrades to unsupported', async () => {
    const s = await probeEncoders(1024, 768, 48_000, {
      canEncodeVideo: async () => { throw new Error('encoder blew up'); },
      canEncodeAudio: async () => { throw new Error('also blew up'); },
      hasOpfs: () => true,
    });
    expect(s.video).toBe(false);
    expect(s.audio).toBe(false);
    expect(s.canRecord).toBe(false);
  });
});

describe('sanitizeRecordingFilename', () => {
  const fixedNow = new Date(2026, 5, 7, 9, 3, 5); // 2026-06-07 09:03:05

  it('appends .mp4 when missing', () => {
    expect(sanitizeRecordingFilename('mytake', 'mp4', fixedNow)).toBe('mytake.mp4');
  });

  it('does not double the extension', () => {
    expect(sanitizeRecordingFilename('mytake.mp4', 'mp4', fixedNow)).toBe('mytake.mp4');
    expect(sanitizeRecordingFilename('mytake.MOV', 'mp4', fixedNow)).toBe('mytake.mp4');
  });

  it('strips path separators + filesystem-hostile chars', () => {
    expect(sanitizeRecordingFilename('a/b\\c:d*e?f"g<h>i|j', 'mp4', fixedNow)).toBe('abcdefghij.mp4');
  });

  it('falls back to a timestamped default for empty / all-stripped input', () => {
    expect(sanitizeRecordingFilename('', 'mp4', fixedNow)).toBe('recording-20260607-090305.mp4');
    expect(sanitizeRecordingFilename('   ', 'mp4', fixedNow)).toBe('recording-20260607-090305.mp4');
    expect(sanitizeRecordingFilename('///', 'mp4', fixedNow)).toBe('recording-20260607-090305.mp4');
  });

  it('honors a webm extension request (last-resort fallback codec)', () => {
    expect(sanitizeRecordingFilename('clip', 'webm', fixedNow)).toBe('clip.webm');
  });
});

describe('opfsScratchPath', () => {
  it('bakes the sanitized filename + a .partial marker into the path', () => {
    // <nameSlug>-<nodeSlug>-<epoch>.partial.mp4 under the recorderbox dir.
    expect(opfsScratchPath('node-abc', 1717000000000, 'My Cool Take')).toBe(
      'recorderbox/My_Cool_Take-node-abc-1717000000000.partial.mp4',
    );
  });

  it('carries the .partial marker so an OPFS entry reads as in-flight', () => {
    expect(opfsScratchPath('n', 1, 'jam')).toMatch(/\.partial\.mp4$/);
  });

  it('strips a user-typed extension before slugging the name (no doubling)', () => {
    expect(opfsScratchPath('n', 1, 'session.mp4')).toBe('recorderbox/session-n-1.partial.mp4');
  });

  it('sanitizes hostile node ids AND hostile filenames to fs-safe slugs', () => {
    // sanitizeRecordingFilename strips '/' (no sub), collapses ' ' → keeps one
    // space → the path slug turns the remaining space into '_': 'x/y z' → 'xy_z'.
    expect(opfsScratchPath('a/b c:d', 42, 'x/y z')).toBe('recorderbox/xy_z-a_b_c_d-42.partial.mp4');
  });

  it('falls back to a "recording" name slug when no filename is given', () => {
    // (the timestamped default sanitizes to recording-YYYYMMDD-HHMMSS → slug
    //  begins with "recording").
    expect(opfsScratchPath('n', 1)).toMatch(/^recorderbox\/recording[-_].*-n-1\.partial\.mp4$/);
  });

  it('two different epochs for the same node produce distinct paths', () => {
    const a = opfsScratchPath('n', 1, 'jam');
    const b = opfsScratchPath('n', 2, 'jam');
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// streamOpfsToWritable — chunked OPFS → destination copy (no full read)
// ---------------------------------------------------------------------------

/** A fake streamable OPFS file backed by an in-memory byte array. Supports the
 *  .stream() path (preferred) OR sliced reads (fallback) per `mode`. */
function fakeFile(bytes: Uint8Array, mode: 'stream' | 'slice', streamChunk = 4): StreamableFile {
  const f: StreamableFile = {
    size: bytes.byteLength,
    slice: (start = 0, end = bytes.byteLength) => ({
      arrayBuffer: async () => bytes.slice(start, end).buffer,
    }),
  };
  if (mode === 'stream') {
    f.stream = () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (let off = 0; off < bytes.byteLength; off += streamChunk) {
            controller.enqueue(bytes.slice(off, Math.min(off + streamChunk, bytes.byteLength)));
          }
          controller.close();
        },
      });
  }
  return f;
}

/** A capturing ChunkSink that records every write + total bytes. */
function captureSink(): ChunkSink & { chunks: number[]; total: number; closed: boolean } {
  const sink = {
    chunks: [] as number[],
    total: 0,
    closed: false,
    async write(chunk: BufferSource | Blob) {
      const len = (chunk as ArrayBufferView).byteLength ?? (chunk as ArrayBuffer).byteLength ?? 0;
      sink.chunks.push(len);
      sink.total += len;
    },
    async close() {
      sink.closed = true;
    },
  };
  return sink;
}

describe('streamOpfsToWritable — chunked copy (never a full read)', () => {
  it('streams ALL bytes via .stream() in multiple chunks + closes the sink', async () => {
    const bytes = new Uint8Array(17).map((_, i) => i);
    const sink = captureSink();
    const written = await streamOpfsToWritable('p', sink, {
      getFile: async () => fakeFile(bytes, 'stream', 4),
    });
    expect(written).toBe(17);
    expect(sink.total).toBe(17);
    // 17 bytes in 4-byte stream chunks → 5 writes (4,4,4,4,1) — proves chunked,
    // not a single full-buffer write.
    expect(sink.chunks.length).toBeGreaterThan(1);
    expect(sink.chunks).toEqual([4, 4, 4, 4, 1]);
    expect(sink.closed).toBe(true);
  });

  it('falls back to bounded sliced reads when .stream() is unavailable', async () => {
    const bytes = new Uint8Array(10).fill(7);
    const sink = captureSink();
    const written = await streamOpfsToWritable('p', sink, {
      getFile: async () => fakeFile(bytes, 'slice'),
      chunkBytes: 3, // force 4 slices: 3,3,3,1
    });
    expect(written).toBe(10);
    expect(sink.total).toBe(10);
    expect(sink.chunks).toEqual([3, 3, 3, 1]);
    expect(sink.closed).toBe(true);
  });

  it('returns 0 + closes the sink when the OPFS file is missing', async () => {
    const sink = captureSink();
    const written = await streamOpfsToWritable('gone', sink, { getFile: async () => null });
    expect(written).toBe(0);
    expect(sink.total).toBe(0);
    expect(sink.closed).toBe(true);
  });

  it('default chunk size is a sane multi-MiB bound (peak memory cap)', () => {
    expect(COPY_CHUNK_BYTES).toBeGreaterThanOrEqual(1024 * 1024);
  });
});

// ---------------------------------------------------------------------------
// ensureHandleWritePermission — re-acquire write on a persisted dest handle
// ---------------------------------------------------------------------------

describe('ensureHandleWritePermission', () => {
  it('returns false for a missing handle (no re-pick possible)', async () => {
    expect(await ensureHandleWritePermission(null)).toBe(false);
    expect(await ensureHandleWritePermission(undefined)).toBe(false);
  });

  it('returns true without prompting when already granted', async () => {
    const requestPermission = vi.fn();
    const handle = {
      queryPermission: vi.fn(async () => 'granted' as PermissionState),
      requestPermission,
    } as unknown as FileSystemFileHandle;
    expect(await ensureHandleWritePermission(handle)).toBe(true);
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('prompts (requestPermission) when in prompt state + returns the grant', async () => {
    const handle = {
      queryPermission: vi.fn(async () => 'prompt' as PermissionState),
      requestPermission: vi.fn(async () => 'granted' as PermissionState),
    } as unknown as FileSystemFileHandle;
    expect(await ensureHandleWritePermission(handle)).toBe(true);
  });

  it('returns false when the user denies the permission prompt', async () => {
    const handle = {
      queryPermission: vi.fn(async () => 'prompt' as PermissionState),
      requestPermission: vi.fn(async () => 'denied' as PermissionState),
    } as unknown as FileSystemFileHandle;
    expect(await ensureHandleWritePermission(handle)).toBe(false);
  });

  it('never throws — a stale handle that rejects resolves false (→ fallback)', async () => {
    const handle = {
      queryPermission: vi.fn(async () => { throw new Error('stale handle'); }),
    } as unknown as FileSystemFileHandle;
    expect(await ensureHandleWritePermission(handle)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Sample-accurate audio capture path (the clicks/pops fix): the recorder feeds
// worklet-posted planar f32 chunks through a BACKPRESSURED AudioSampleSource so
// NO sample is dropped (the old MediaStreamAudioTrackSource hard-drops under
// encoder backpressure → silence-pad → click). These drive the recorder's REAL
// arm + drain wiring with an injected fake source + a stub worklet port, and
// assert: (a) EVERY posted chunk is add()'d (none closed/dropped), and (b) the
// emitted timestamps are exactly contiguous (audio-clock authoritative), EVEN
// when add() is slow (simulated encoder backpressure).
// ---------------------------------------------------------------------------

/** A stub of the worklet's MessagePort. Captures arm/disarm posts; lets the
 *  test inject chunks via the recorder-installed `onmessage`. */
function stubCapturePort() {
  const posts: Array<{ type: string }> = [];
  const port = {
    onmessage: null as ((e: MessageEvent) => void) | null,
    postMessage(msg: { type: string }) { posts.push(msg); },
  };
  return {
    port: port as unknown as MessagePort,
    posts,
    /** Simulate the worklet posting a captured chunk to the main thread. */
    post(chunk: { data: Float32Array; frames: number }) {
      port.onmessage?.({ data: chunk } as MessageEvent);
    },
  };
}

/** A planar stereo chunk of `frames` frames; samples seeded from `seed` so we
 *  can assert no chunk was reordered/lost. */
function chunk(frames: number, seed: number) {
  const data = new Float32Array(frames * 2);
  for (let i = 0; i < data.length; i++) data[i] = seed + i;
  return { data, frames };
}

/** A fake mediabunny AudioSampleSource that records every add()'d sample's
 *  (frames, timestamp). `slow` makes add() resolve on a later macrotask so the
 *  drain experiences real backpressure (the encoder-busy case). */
function fakeAudioSampleSource(slow = false) {
  const added: Array<{ frames: number; timestamp: number }> = [];
  const source = {
    async add(sample: { numberOfFrames: number; timestamp: number }) {
      if (slow) await new Promise<void>((r) => setTimeout(r, 0));
      added.push({ frames: sample.numberOfFrames, timestamp: sample.timestamp });
    },
  };
  return { source: source as unknown as AudioSampleSourceLike, added };
}

/** Build a recorder wired for the capture path WITHOUT calling start() (the real
 *  Mediabunny Output can't construct under node), then drive the same private
 *  setup + arm the start()/stop() flow uses. Mirrors recorderbox-stop.test.ts's
 *  armForStop pattern. */
function makeCaptureRecorder(opts: {
  sampleRate: number;
  makeAudioSampleSource: RecorderboxRecorderOptions['makeAudioSampleSource'];
  port: MessagePort;
}) {
  const rec = new RecorderboxRecorder({
    nodeId: 'cap1',
    canvas: {} as HTMLCanvasElement,
    audioTrack: null,
    audioCapture: { port: opts.port, sampleRate: opts.sampleRate },
    filename: 'cap',
    width: 320,
    height: 240,
    saveBytes: async () => {},
    makeWriter: () => ({ write: async () => {}, close: async () => {} }),
    makeAudioSampleSource: opts.makeAudioSampleSource,
  });
  const internal = rec as unknown as {
    state: string;
    output: { addAudioTrack: (s: unknown) => void };
    capturePort: MessagePort | null;
    captureDrain: unknown;
    captureDrainLoop: Promise<void> | null;
    setupCaptureSource: (
      output: { addAudioTrack: (s: unknown) => void },
      tap: { port: MessagePort; sampleRate: number },
    ) => AudioSampleSourceLike | null;
    armCaptureDrain: (src: AudioSampleSourceLike) => void;
  };
  // Force the recorder into the post-start() state the real start() leaves.
  const addedTracks: unknown[] = [];
  internal.state = 'recording';
  internal.output = { addAudioTrack: (s) => { addedTracks.push(s); } };
  return { rec, internal, addedTracks };
}

describe('sample-accurate capture path — lossless drain through backpressured add()', () => {
  it('add()s EVERY worklet chunk (none dropped) with contiguous timestamps', async () => {
    const sampleRate = 48_000;
    const { source, added } = fakeAudioSampleSource(false);
    const stub = stubCapturePort();
    const { internal } = makeCaptureRecorder({
      sampleRate,
      makeAudioSampleSource: () => source,
      port: stub.port,
    });

    // Wire the capture source (adds the audio track + installs port.onmessage),
    // then ARM + start the drain loop (the same two steps start() runs).
    const src = internal.setupCaptureSource(internal.output, { port: stub.port, sampleRate });
    expect(src).toBe(source);
    expect(stub.posts).toEqual([]); // not armed yet
    internal.armCaptureDrain(src!);
    expect(stub.posts).toEqual([{ type: 'arm' }]); // worklet armed

    // The worklet posts a run of differently-sized batches.
    const sizes = [1024, 1024, 512, 1024, 256];
    sizes.forEach((n, i) => stub.post(chunk(n, i * 10_000)));

    // DISARM + close + await the drain loop (the stop()/finalize sequence). The
    // private fields are what stop() reads.
    stub.post(chunk(128, 99_000)); // a final partial (the disarm-flush analogue)
    (internal.captureDrain as { close: () => void }).close();
    await internal.captureDrainLoop;

    // (a) LOSSLESS: every posted chunk was add()'d, in order, none dropped.
    const expectedFrames = [...sizes, 128];
    expect(added.map((a) => a.frames)).toEqual(expectedFrames);

    // (b) CONTIGUOUS timestamps: sample N starts at (sum of prior frames)/rate.
    let cum = 0;
    for (let i = 0; i < expectedFrames.length; i++) {
      expect(added[i].timestamp).toBeCloseTo(cum / sampleRate, 9);
      cum += expectedFrames[i];
    }
    // First sample at t0 = 0 (shared zero epoch with the video track → A/V sync).
    expect(added[0].timestamp).toBe(0);
  });

  it('is STILL lossless + contiguous when add() is SLOW (encoder backpressure)', async () => {
    const sampleRate = 44_100;
    const { source, added } = fakeAudioSampleSource(true); // slow add → backpressure
    const stub = stubCapturePort();
    const { internal } = makeCaptureRecorder({
      sampleRate,
      makeAudioSampleSource: () => source,
      port: stub.port,
    });
    const src = internal.setupCaptureSource(internal.output, { port: stub.port, sampleRate });
    internal.armCaptureDrain(src!);

    // Burst many chunks FASTER than the slow encoder can drain — the queue fills
    // (the backpressure case that used to drop samples). All must still land.
    const sizes = Array.from({ length: 20 }, (_, i) => (i % 2 ? 512 : 1024));
    sizes.forEach((n, i) => stub.post(chunk(n, i * 5_000)));

    (internal.captureDrain as { close: () => void }).close();
    await internal.captureDrainLoop;

    // LOSSLESS under backpressure: all 20 chunks add()'d, in order.
    expect(added.map((a) => a.frames)).toEqual(sizes);
    // CONTIGUOUS: timestamps never overlap nor gap.
    let cum = 0;
    for (let i = 0; i < sizes.length; i++) {
      expect(added[i].timestamp).toBeCloseTo(cum / sampleRate, 9);
      cum += sizes[i];
    }
    // Drain reports the right total frames emitted.
    expect((internal.captureDrain as { framesEmitted: number }).framesEmitted)
      .toBe(sizes.reduce((a, b) => a + b, 0));
  });

  it('falls back (no capture wiring) when audioCapture is absent', async () => {
    // No audioCapture → the legacy MediaStreamAudioTrackSource(audioTrack) path.
    const rec = new RecorderboxRecorder({
      nodeId: 'fb1',
      canvas: {} as HTMLCanvasElement,
      audioTrack: null,
      filename: 'fb',
      width: 320,
      height: 240,
      saveBytes: async () => {},
      makeWriter: () => ({ write: async () => {}, close: async () => {} }),
      makeAudioSampleSource: () => { throw new Error('must NOT be called on the fallback path'); },
    });
    const internal = rec as unknown as { capturePort: MessagePort | null; captureDrain: unknown };
    // The capture state is never set up without an audioCapture tap.
    expect(internal.capturePort).toBeNull();
    expect(internal.captureDrain).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// CFR frame() — the OSX slow-mo fix. frame() must emit video PTS on an EVEN grid
// (index/fps) regardless of jittery rAF cadence: no wall-clock PTS, no dup PTS,
// no sparse stretch. We drive the REAL frame() with a fake CanvasSource capturing
// (ts, dur) + a stubbed performance.now sequence (fast / slow / hitch).
// ---------------------------------------------------------------------------

/** Force a recorder into the 'recording' state with a fake CanvasSource that
 *  captures every add(ts, dur), bypassing start() (no real encoder). */
function makeCfrRecorder() {
  const adds: Array<{ ts: number; dur: number }> = [];
  const rec = new RecorderboxRecorder({
    nodeId: 'cfr1',
    canvas: {} as HTMLCanvasElement,
    audioTrack: null,
    filename: 'cfr',
    width: 320,
    height: 240,
    saveBytes: async () => {},
    makeWriter: () => ({ write: async () => {}, close: async () => {} }),
  });
  const internal = rec as unknown as {
    state: string;
    canvasSource: { add: (ts: number, dur?: number) => Promise<void> };
    t0: number;
    chunkStartElapsed: number;
  };
  internal.state = 'recording';
  internal.t0 = 0;
  internal.chunkStartElapsed = 0;
  internal.canvasSource = {
    add: async (ts: number, dur?: number) => { adds.push({ ts, dur: dur ?? 0 }); },
  };
  return { rec, adds };
}

describe('CFR frame() — even-grid PTS (the OSX slow-mo fix)', () => {
  const FPS = 30;
  let nowMs = 0;
  let realNow: () => number;
  beforeEach(() => {
    nowMs = 0;
    realNow = performance.now.bind(performance);
    performance.now = () => nowMs;
  });
  afterEach(() => { performance.now = realNow; });

  it('emits PTS on an EVEN grid (index/fps) under JITTERY rAF — no dup, no gap', async () => {
    const { rec, adds } = makeCfrRecorder();
    // A realistic jittery rAF timestamp sequence (fast ticks, a hitch, slow ticks)
    // — the exact input that produced wall-clock slow-mo before the fix.
    const ticks = [0, 10, 22, 33, 33, 40, 70, 130, 133, 200, 215, 300, 380, 433, 800, 833, 1000];
    for (const ms of ticks) {
      nowMs = ms;
      rec.frame();
      // Let the per-frame add() promise chain settle (frame() is non-blocking).
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    }
    expect(adds.length).toBeGreaterThan(0);
    // Every duration is exactly 1/fps (constant — no variable timing).
    for (const a of adds) expect(a.dur).toBeCloseTo(1 / FPS, 9);
    // PTS strictly increasing (no duplicate / 0-duration collisions).
    for (let i = 1; i < adds.length; i++) expect(adds[i].ts).toBeGreaterThan(adds[i - 1].ts);
    // Even grid: each PTS is exactly i/fps (a dense grid, no sparse slow-mo gap).
    adds.forEach((a, i) => expect(a.ts).toBeCloseTo(i / FPS, 9));
  });

  it('does NOT collide (no two frames in one slot) on a sustained FAST machine', async () => {
    const { rec, adds } = makeCfrRecorder();
    // 120 Hz rAF for ~0.5 s → only ~15 grid frames (not ~60 a per-rAF emit makes).
    for (let ms = 0; ms <= 500; ms += 8.333) {
      nowMs = ms;
      rec.frame();
      await Promise.resolve(); await Promise.resolve();
    }
    expect(adds.length).toBeGreaterThanOrEqual(14);
    expect(adds.length).toBeLessThanOrEqual(16);
    // No duplicate PTS.
    const seen = new Set(adds.map((a) => Math.round(a.ts * FPS)));
    expect(seen.size).toBe(adds.length);
  });
});
