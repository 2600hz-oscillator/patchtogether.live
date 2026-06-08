// packages/web/src/lib/video/recorderbox-recorder.test.ts
//
// Pure-logic coverage for the RECORDERBOX recorder + store helpers. The live
// Mediabunny pipeline + the OPFS Worker are exercised by the bespoke e2e
// (real encoder on this Mac); here we cover the deterministic, browser-API-
// free pieces: encoder probing (graceful-degrade matrix) + filename
// sanitization + OPFS scratch path naming.

import { describe, expect, it } from 'vitest';
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
  it('is deterministic from (nodeId, startEpoch) under the recorderbox dir', () => {
    expect(opfsScratchPath('node-abc', 1717000000000)).toBe('recorderbox/node-abc-1717000000000.mp4');
  });

  it('sanitizes hostile node ids to a filesystem-safe slug', () => {
    expect(opfsScratchPath('a/b c:d', 42)).toBe('recorderbox/a_b_c_d-42.mp4');
  });

  it('two different epochs for the same node produce distinct paths', () => {
    const a = opfsScratchPath('n', 1);
    const b = opfsScratchPath('n', 2);
    expect(a).not.toBe(b);
  });
});
