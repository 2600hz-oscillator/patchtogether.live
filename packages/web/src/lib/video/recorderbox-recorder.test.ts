// packages/web/src/lib/video/recorderbox-recorder.test.ts
//
// Pure-logic coverage for the RECORDERBOX recorder + store helpers. The live
// Mediabunny pipeline + the OPFS Worker are exercised by the bespoke e2e
// (real encoder on this Mac); here we cover the deterministic, browser-API-
// free pieces: encoder probing (graceful-degrade matrix) + filename
// sanitization + OPFS scratch path naming.

import { describe, expect, it, vi } from 'vitest';
import {
  probeEncoders,
  DEFAULT_VIDEO_BITRATE,
  DEFAULT_AUDIO_BITRATE,
  VIDEO_CODEC,
  AUDIO_CODEC,
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
