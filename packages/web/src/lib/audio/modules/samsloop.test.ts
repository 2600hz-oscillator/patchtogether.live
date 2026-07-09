// packages/web/src/lib/audio/modules/samsloop.test.ts
//
// Unit tests for SAMSLOOP:
//   - module-def shape (ports, params, registry)
//   - WAV size rejection (>2 MB returns a clear error, no decode attempted)
//   - loop vs one-shot semantics in samsloopMath.render
//   - idle-by-default + mode-aware trigger semantics in
//     samsloopMath.renderWithTriggers (no autoplay; one-shot plays once;
//     loop keeps looping; re-trigger restarts; both gate + manual paths)
//   - varispeed mapping (slider → playback rate) covering ±2 × forward / reverse
//   - start/end clamp logic enforces start < end inside the buffer
//
// The worklet itself (packages/dsp/src/samsloop.ts) mirrors this math; the
// AudioWorkletProcessor isn't importable under vitest so we exercise the
// pure-math `samsloopMath` mirror, same pattern as macrooscillator.test.ts.

import { describe, expect, it } from 'vitest';
import {
  samsloopDef,
  samsloopMath,
  loadSamsloopWav,
  samsloopDecodeBytesB64,
  samsloopDownsample,
  parseWavManually,
  SAMSLOOP_MAX_FILE_BYTES,
  SAMSLOOP_MAX_SAMPLES,
  SAMSLOOP_MAX_DECODED_SAMPLES,
  SAMSLOOP_TARGET_SAMPLE_RATE,
  SAMSLOOP_RATE_RANGE,
  createSamsloopRecMachine,
  samsloopRecStart,
  samsloopRecAppend,
  samsloopRecStop,
  samsloopRecFail,
} from './samsloop';

// ---------- module-def shape ----------

describe('samsloopDef shape', () => {
  it('rate param: −2..+2 with default 1.0 (slider center = forward unity)', () => {
    const p = samsloopDef.params.find((p) => p.id === 'rate')!;
    expect(p.min).toBe(SAMSLOOP_RATE_RANGE.min);
    expect(p.max).toBe(SAMSLOOP_RATE_RANGE.max);
    expect(p.defaultValue).toBe(SAMSLOOP_RATE_RANGE.defaultValue);
  });
});

// ---------- WAV size rejection ----------

describe('loadSamsloopWav size limit', () => {
  // Minimal fake BaseAudioContext — we only ever exercise the size path
  // here, so decodeAudioData should never be called. The test asserts that.
  function makeCtx(): { ctx: BaseAudioContext; calls: number } {
    let calls = 0;
    const ctx = {
      decodeAudioData: async (_ab: ArrayBuffer) => {
        calls++;
        // Should be unreachable in the rejection path.
        return { length: 0, numberOfChannels: 1, sampleRate: 48000, getChannelData: () => new Float32Array(0) } as unknown as AudioBuffer;
      },
    } as unknown as BaseAudioContext;
    return { ctx, get calls() { return calls; } } as { ctx: BaseAudioContext; calls: number };
  }

  it(`rejects files over ${SAMSLOOP_MAX_FILE_BYTES} bytes with a clear error`, async () => {
    const { ctx } = makeCtx();
    const oversized = {
      size: SAMSLOOP_MAX_FILE_BYTES + 1,
      arrayBuffer: async () => new ArrayBuffer(SAMSLOOP_MAX_FILE_BYTES + 1),
    };
    const result = await loadSamsloopWav(oversized, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/too large/i);
    // Cap is now 2 MB (raised from 250 KB) — message reports the MB limit.
    expect(result.error).toMatch(/2 MB/i);
    expect(result.samples).toBeUndefined();
  });

  it('pins SAMSLOOP_MAX_FILE_BYTES at 2 MB (the raised cap)', () => {
    // Load-bearing constant. The raise (250 KB → 2 MB) lets full short
    // songs / field recordings load. The decoded-buffer backstop
    // (SAMSLOOP_MAX_DECODED_SAMPLES) still bounds the in-memory PCM.
    expect(SAMSLOOP_MAX_FILE_BYTES).toBe(2 * 1024 * 1024);
  });

  it('does NOT attempt to decode oversize files (early bail)', async () => {
    const probe = makeCtx();
    const oversized = {
      size: SAMSLOOP_MAX_FILE_BYTES * 4,
      arrayBuffer: async () => new ArrayBuffer(SAMSLOOP_MAX_FILE_BYTES * 4),
    };
    await loadSamsloopWav(oversized, probe.ctx);
    expect(probe.calls).toBe(0);
  });

  it('accepts a file exactly at the limit', async () => {
    // Build a tiny synthetic WAV in-memory and stub decodeAudioData to
    // return a 1-sample mono buffer. We're only testing that the size
    // gate passes when size === SAMSLOOP_MAX_FILE_BYTES.
    const ctx = {
      decodeAudioData: async (_ab: ArrayBuffer): Promise<AudioBuffer> => {
        return {
          length: 1,
          numberOfChannels: 1,
          sampleRate: 22050,
          getChannelData: () => new Float32Array([0.5]),
        } as unknown as AudioBuffer;
      },
    } as unknown as BaseAudioContext;
    const fakeFile = {
      size: SAMSLOOP_MAX_FILE_BYTES,
      arrayBuffer: async () => new ArrayBuffer(SAMSLOOP_MAX_FILE_BYTES),
    };
    const result = await loadSamsloopWav(fakeFile, ctx);
    expect(result.ok).toBe(true);
    expect(result.samples).toBeDefined();
    expect(result.samples!.length).toBe(1);
  });
});

// ---------- multi-format gate (not WAV-only) ----------
//
// The gate must NOT discriminate by extension or magic bytes — it hands
// any bytes the picker accepts straight to decodeAudioData and lets the
// browser decide. This guards against the regression where the loader
// (or, more commonly, the file picker `accept` attribute) was wav-only,
// which silently rejected m4a / mp3 / ogg / flac uploads even though
// the underlying decoder supports them. The decoder is stubbed so the
// test exercises only the gate, not any real codec.
describe('loadSamsloopWav accepts any browser-decodable audio', () => {
  function makeMockingCtx(): BaseAudioContext {
    return {
      decodeAudioData: async (_ab: ArrayBuffer): Promise<AudioBuffer> => ({
        length: 8,
        numberOfChannels: 1,
        sampleRate: 44100,
        getChannelData: () => new Float32Array([0.1, 0.2, 0.3, 0.4, -0.1, -0.2, -0.3, -0.4]),
      } as unknown as AudioBuffer),
    } as unknown as BaseAudioContext;
  }

  it('accepts an m4a file under the size cap (gate is not wav-only)', async () => {
    const fakeM4a = {
      size: 25 * 1024,
      arrayBuffer: async () => new ArrayBuffer(25 * 1024),
    };
    const result = await loadSamsloopWav(fakeM4a, makeMockingCtx());
    expect(result.ok).toBe(true);
    expect(result.samples).toBeDefined();
    expect(result.samples!.length).toBe(8);
    expect(result.sampleRate).toBe(44100);
  });

  it('accepts an mp3 file under the size cap', async () => {
    const fakeMp3 = {
      size: 50 * 1024,
      arrayBuffer: async () => new ArrayBuffer(50 * 1024),
    };
    const result = await loadSamsloopWav(fakeMp3, makeMockingCtx());
    expect(result.ok).toBe(true);
    expect(result.samples).toBeDefined();
  });

  it('reports a friendly "could not decode audio" error (no "WAV" in the copy)', async () => {
    // The decoder rejects → the gate surfaces a format-agnostic message.
    const failingCtx = {
      decodeAudioData: async (_ab: ArrayBuffer): Promise<AudioBuffer> => {
        throw new Error('EncodingError: Unable to decode audio data');
      },
    } as unknown as BaseAudioContext;
    const fakeBlob = {
      size: 1024,
      arrayBuffer: async () => new ArrayBuffer(1024),
    };
    const result = await loadSamsloopWav(fakeBlob, failingCtx);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/could not decode audio/i);
    expect(result.error).not.toMatch(/\bWAV\b/);
  });
});

// ---------- decoded-buffer cap + downsample (load-hang regression) ----------
//
// Regression: a 43 KB 8-bit mono 16 kHz WAV got stuck on "parsing..."
// indefinitely. The raw-file gate (250 KB) passed, but the decoder
// upsampled to the context's native 48 kHz rate (3× sample count), and
// writing the resulting Array<number> into the syncedstore CRDT
// serialized one YArray record per sample — locking the main thread
// for 10+ seconds and broadcasting the same payload to every peer in
// the rackspace. The fix downsamples to a target rate (24 kHz) before
// returning + adds a decoded-buffer cap that fires AFTER decode so a
// small upload that decodes to a huge buffer is rejected cleanly.

describe('parseWavManually — bit-depth matrix the browser may reject', () => {
  function makeWav(opts: {
    audioFormat: number;
    channels: number;
    sampleRate: number;
    bitsPerSample: number;
    frames: number;
    fill: (frameIdx: number, channel: number) => number;
  }): ArrayBuffer {
    const { audioFormat, channels, sampleRate, bitsPerSample, frames, fill } = opts;
    const bytesPerSample = bitsPerSample >> 3;
    const dataSize = frames * channels * bytesPerSample;
    const ab = new ArrayBuffer(44 + dataSize);
    const v = new DataView(ab);
    v.setUint32(0, 0x52494646, false); // "RIFF"
    v.setUint32(4, 36 + dataSize, true);
    v.setUint32(8, 0x57415645, false); // "WAVE"
    v.setUint32(12, 0x666d7420, false); // "fmt "
    v.setUint32(16, 16, true);
    v.setUint16(20, audioFormat, true);
    v.setUint16(22, channels, true);
    v.setUint32(24, sampleRate, true);
    v.setUint32(28, sampleRate * channels * bytesPerSample, true);
    v.setUint16(32, channels * bytesPerSample, true);
    v.setUint16(34, bitsPerSample, true);
    v.setUint32(36, 0x64617461, false); // "data"
    v.setUint32(40, dataSize, true);
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < channels; c++) {
        const o = 44 + (i * channels + c) * bytesPerSample;
        const val = fill(i, c);
        if (audioFormat === 1 && bitsPerSample === 8) v.setUint8(o, val);
        else if (audioFormat === 1 && bitsPerSample === 16) v.setInt16(o, val, true);
        else if (audioFormat === 1 && bitsPerSample === 32) v.setInt32(o, val, true);
        else if (audioFormat === 3 && bitsPerSample === 32) v.setFloat32(o, val, true);
      }
    }
    return ab;
  }

  it('parses 8-bit unsigned PCM mono 16 kHz — the "875 County Rd 13" fixture format', () => {
    // 8-bit PCM is unsigned, centered on 128 (the silence pattern that
    // dominates the bug-report file). Send a small ramp so the parser's
    // (val-128)/128 normalization is verifiable.
    const ab = makeWav({
      audioFormat: 1, channels: 1, sampleRate: 16000, bitsPerSample: 8,
      frames: 8, fill: (i) => 128 + i * 16, // 128, 144, 160, ..., 240
    });
    const r = parseWavManually(ab);
    expect(r).not.toBeNull();
    expect(r!.sampleRate).toBe(16000);
    expect(r!.samples.length).toBe(8);
    expect(r!.samples[0]).toBeCloseTo(0,    5); // 128 → 0
    expect(r!.samples[1]).toBeCloseTo(16/128, 5);
    expect(r!.samples[7]).toBeCloseTo(112/128, 5);
  });

  it('parses 16-bit signed PCM stereo and mono-mixes', () => {
    const ab = makeWav({
      audioFormat: 1, channels: 2, sampleRate: 44100, bitsPerSample: 16,
      frames: 4, fill: (i, c) => (c === 0 ? 16384 : -16384), // L=+0.5, R=-0.5 → mono 0
    });
    const r = parseWavManually(ab);
    expect(r).not.toBeNull();
    expect(r!.sampleRate).toBe(44100);
    for (let i = 0; i < 4; i++) expect(r!.samples[i]).toBeCloseTo(0, 5);
  });

  it('parses 32-bit float PCM', () => {
    const ab = makeWav({
      audioFormat: 3, channels: 1, sampleRate: 48000, bitsPerSample: 32,
      frames: 3, fill: (i) => [0.0, 0.5, -0.75][i]!,
    });
    const r = parseWavManually(ab);
    expect(r).not.toBeNull();
    expect(r!.samples[0]).toBeCloseTo(0,     5);
    expect(r!.samples[1]).toBeCloseTo(0.5,   5);
    expect(r!.samples[2]).toBeCloseTo(-0.75, 5);
  });

  it('returns null for non-RIFF bytes (mp3 / ogg / random)', () => {
    const ab = new ArrayBuffer(64);
    new DataView(ab).setUint32(0, 0xdeadbeef, false);
    expect(parseWavManually(ab)).toBeNull();
  });

  it('returns null for unsupported PCM variants so caller falls back to decodeAudioData', () => {
    // Audio format 6 = A-law (not handled by our parser; valid WAV variant).
    const ab = makeWav({
      audioFormat: 6, channels: 1, sampleRate: 8000, bitsPerSample: 8,
      frames: 4, fill: () => 0,
    });
    expect(parseWavManually(ab)).toBeNull();
  });

  it('tolerates LIST/INFO chunks between fmt and data (Lavf-encoded WAVs)', () => {
    // The user's "875 County Rd 13" file has a LIST chunk after fmt
    // before data. Construct that layout and verify we still find data.
    const frames = 4;
    const dataSize = frames; // 1 channel × 1 byte/sample
    const listChunkSize = 26; // matches the file: "ISFT\0\0\0\0\rLavf61.1.100\0\0"
    const ab = new ArrayBuffer(44 + 8 + listChunkSize + dataSize);
    const v = new DataView(ab);
    v.setUint32(0, 0x52494646, false);
    v.setUint32(4, ab.byteLength - 8, true);
    v.setUint32(8, 0x57415645, false);
    // fmt
    v.setUint32(12, 0x666d7420, false);
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 1, true);
    v.setUint32(24, 16000, true);
    v.setUint32(28, 16000, true);
    v.setUint16(32, 1, true);
    v.setUint16(34, 8, true);
    // LIST chunk
    v.setUint32(36, 0x4c495354, false); // "LIST"
    v.setUint32(40, listChunkSize, true);
    // (chunk body left as zeros — content doesn't matter to the parser)
    // data
    const dataOff = 44 + 8 + listChunkSize;
    v.setUint32(dataOff - 8, 0x64617461, false);
    v.setUint32(dataOff - 4, dataSize, true);
    for (let i = 0; i < frames; i++) v.setUint8(dataOff + i, 128); // silence
    const r = parseWavManually(ab);
    expect(r).not.toBeNull();
    expect(r!.sampleRate).toBe(16000);
    expect(r!.samples.length).toBe(frames);
    for (let i = 0; i < frames; i++) expect(r!.samples[i]).toBe(0);
  });
});

describe('samsloopDownsample', () => {
  it('returns the input unchanged when factor <= 1', () => {
    const buf = new Float32Array([0.1, 0.2, 0.3]);
    expect(samsloopDownsample(buf, 1)).toBe(buf);
    expect(samsloopDownsample(buf, 0)).toBe(buf);
  });

  it('halves length when factor=2 with a box-filter average', () => {
    const buf = new Float32Array([0.0, 1.0, 0.0, 1.0]);
    const out = samsloopDownsample(buf, 2);
    expect(out.length).toBe(2);
    expect(out[0]).toBeCloseTo(0.5, 6);
    expect(out[1]).toBeCloseTo(0.5, 6);
  });

  it('preserves DC offset (constant input → constant output)', () => {
    const buf = new Float32Array(12);
    buf.fill(0.42);
    const out = samsloopDownsample(buf, 3);
    expect(out.length).toBe(4);
    for (let i = 0; i < out.length; i++) {
      expect(out[i]).toBeCloseTo(0.42, 6);
    }
  });
});

describe('loadSamsloopWav downsamples high-rate decoder output', () => {
  function makeCtx(decodedRate: number, decodedLen: number): BaseAudioContext {
    const data = new Float32Array(decodedLen);
    for (let i = 0; i < decodedLen; i++) data[i] = (i % 100) / 100;
    return {
      decodeAudioData: async (_ab: ArrayBuffer): Promise<AudioBuffer> => ({
        length: decodedLen,
        numberOfChannels: 1,
        sampleRate: decodedRate,
        getChannelData: () => data,
      } as unknown as AudioBuffer),
    } as unknown as BaseAudioContext;
  }

  it('downsamples 48 kHz decoder output to ~24 kHz (factor 2)', async () => {
    // Simulates the bug-report case: 8-bit mono 16 kHz WAV decoded by a
    // 48 kHz AudioContext → 65K samples in. After downsample factor 2
    // we get ~32K samples at 24 kHz.
    const ctx = makeCtx(48000, 65_000);
    const file = { size: 43_000, arrayBuffer: async () => new ArrayBuffer(43_000) };
    const result = await loadSamsloopWav(file, ctx);
    expect(result.ok).toBe(true);
    expect(result.sampleRate).toBe(24000);
    // Length halves (factor=2 from floor(48000/24000)).
    expect(result.samples!.length).toBe(32_500);
  });

  it('keeps low-rate decoder output at its native rate (no downsample)', async () => {
    // 22 kHz decoder output is already below target — pass through.
    const ctx = makeCtx(22050, 10_000);
    const file = { size: 20_000, arrayBuffer: async () => new ArrayBuffer(20_000) };
    const result = await loadSamsloopWav(file, ctx);
    expect(result.ok).toBe(true);
    expect(result.sampleRate).toBe(22050);
    expect(result.samples!.length).toBe(10_000);
  });

  it('confirms SAMSLOOP_TARGET_SAMPLE_RATE is 24 kHz', () => {
    expect(SAMSLOOP_TARGET_SAMPLE_RATE).toBe(24000);
  });
});

describe('loadSamsloopWav decoded-buffer cap', () => {
  function makeCtx(decodedLen: number): BaseAudioContext {
    return {
      decodeAudioData: async (_ab: ArrayBuffer): Promise<AudioBuffer> => ({
        length: decodedLen,
        numberOfChannels: 1,
        sampleRate: 22050,
        getChannelData: () => new Float32Array(decodedLen),
      } as unknown as AudioBuffer),
    } as unknown as BaseAudioContext;
  }

  // Constant pin: a regression here is the user-visible "small MP3
  // rejected" bug coming back. Anyone tempted to lower this should read
  // the SAMSLOOP_MAX_DECODED_SAMPLES comment block first — the cap is
  // load-bearing for "typical short-MP3 fits" + decode-time main-thread
  // budget. 1.5M samples ≈ 62 s @ 24 kHz mono.
  it('SAMSLOOP_MAX_DECODED_SAMPLES is pinned to 1_500_000', () => {
    expect(SAMSLOOP_MAX_DECODED_SAMPLES).toBe(1_500_000);
  });

  // The user-reported bug fixture: a small MP3 (~50 KB at 128 kbps) is
  // about 3 seconds = ~144_000 samples at 48 kHz mono, but Chrome decodes
  // to 48 kHz which is then downsampled to 24 kHz. A 250 KB MP3 at typical
  // bitrate decodes to roughly 15–60 s of audio. Pre-fix, any clip past
  // the old 144_000 cap was rejected: a 50 KB MP3 of a 12 s loop produced
  // ~288_000 samples @ 24 kHz → rejection. Post-fix, anything up to
  // 1_500_000 samples passes — covers the realistic short-MP3 range.
  it('accepts a buffer at 396_000 samples (the user-reported failing size)', async () => {
    const ctx = makeCtx(396_000);
    const file = { size: 50 * 1024, arrayBuffer: async () => new ArrayBuffer(50 * 1024) };
    const result = await loadSamsloopWav(file, ctx);
    expect(result.ok).toBe(true);
    expect(result.samples!.length).toBe(396_000);
  });

  it('rejects buffers exceeding SAMSLOOP_MAX_DECODED_SAMPLES with a clear error', async () => {
    // Source rate 22050 (below target → no downsample applied) so we can
    // construct a buffer larger than the cap directly. The raw-file gate
    // is 250 KB which we satisfy with size: 100_000.
    const ctx = makeCtx(SAMSLOOP_MAX_DECODED_SAMPLES + 1);
    const file = { size: 100_000, arrayBuffer: async () => new ArrayBuffer(100_000) };
    const result = await loadSamsloopWav(file, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/decoded buffer too large/i);
    expect(result.error).toMatch(new RegExp(String(SAMSLOOP_MAX_DECODED_SAMPLES)));
    expect(result.samples).toBeUndefined();
  });

  it('accepts buffers exactly at the cap', async () => {
    const ctx = makeCtx(SAMSLOOP_MAX_DECODED_SAMPLES);
    const file = { size: 100_000, arrayBuffer: async () => new ArrayBuffer(100_000) };
    const result = await loadSamsloopWav(file, ctx);
    expect(result.ok).toBe(true);
    expect(result.samples!.length).toBe(SAMSLOOP_MAX_DECODED_SAMPLES);
  });

  it('cap fires AFTER downsample — high-rate input that fits post-downsample is accepted', async () => {
    // 48 kHz decoder output that's just over the cap pre-downsample but
    // comfortably under post-downsample (factor=2). Used to verify that
    // we measure the STORED buffer size, not the decoder's raw output.
    const preDownsampleLen = SAMSLOOP_MAX_DECODED_SAMPLES + 10_000;
    const ctx = {
      decodeAudioData: async (_ab: ArrayBuffer): Promise<AudioBuffer> => ({
        length: preDownsampleLen,
        numberOfChannels: 1,
        sampleRate: 48000,
        getChannelData: () => new Float32Array(preDownsampleLen),
      } as unknown as AudioBuffer),
    } as unknown as BaseAudioContext;
    const file = { size: 100_000, arrayBuffer: async () => new ArrayBuffer(100_000) };
    const result = await loadSamsloopWav(file, ctx);
    expect(result.ok).toBe(true);
    // Length should be the downsampled count, well under the cap.
    expect(result.samples!.length).toBeLessThanOrEqual(SAMSLOOP_MAX_DECODED_SAMPLES);
    expect(result.sampleRate).toBe(24000);
  });
});

// ---------- file-bytes persistence pass-through ----------
//
// On a successful upload, loadSamsloopWav must thread the ORIGINAL file
// bytes (the unmodified Uint8Array as read from the file) through to
// the result so the card can persist them via base64. This replaces the
// old "stuff decoded PCM into a YArray" path, which doesn't survive the
// new 1.5M-sample cap.

describe('loadSamsloopWav returns original file bytes for persistence', () => {
  function makeDecodingCtx(decodedLen = 1000): BaseAudioContext {
    return {
      decodeAudioData: async (_ab: ArrayBuffer): Promise<AudioBuffer> => ({
        length: decodedLen,
        numberOfChannels: 1,
        sampleRate: 22050,
        getChannelData: () => new Float32Array(decodedLen),
      } as unknown as AudioBuffer),
    } as unknown as BaseAudioContext;
  }

  it('exposes fileBytes + fileSize + fileMime on success (mp3 path)', async () => {
    // Simulate a 50 KB "mp3" — the decoder is stubbed so the actual
    // codec doesn't matter; we just need the size gate to pass and the
    // bytes to round-trip into the result.
    const SIZE = 50 * 1024;
    const ab = new ArrayBuffer(SIZE);
    const dv = new DataView(ab);
    // Watermark the buffer so we can verify it survived.
    for (let i = 0; i < 16; i++) dv.setUint8(i, (i * 7) & 0xff);
    const file = {
      size: SIZE,
      type: 'audio/mpeg',
      arrayBuffer: async () => ab,
    };
    const result = await loadSamsloopWav(file, makeDecodingCtx());
    expect(result.ok).toBe(true);
    expect(result.fileBytes).toBeDefined();
    expect(result.fileBytes!.byteLength).toBe(SIZE);
    // Watermark survived (we copy via ab.slice(0) before decode).
    for (let i = 0; i < 16; i++) {
      expect(result.fileBytes![i]).toBe((i * 7) & 0xff);
    }
    expect(result.fileSize).toBe(SIZE);
    expect(result.fileMime).toBe('audio/mpeg');
  });

  it('exposes fileBytes for the manual-WAV parser path too', async () => {
    // Synthesize a tiny valid WAV so parseWavManually succeeds without
    // touching the stubbed decoder.
    const frames = 4;
    const dataSize = frames * 2; // 16-bit mono
    const ab = new ArrayBuffer(44 + dataSize);
    const v = new DataView(ab);
    v.setUint32(0, 0x52494646, false);
    v.setUint32(4, 36 + dataSize, true);
    v.setUint32(8, 0x57415645, false);
    v.setUint32(12, 0x666d7420, false);
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 1, true);
    v.setUint32(24, 22050, true);
    v.setUint32(28, 22050 * 2, true);
    v.setUint16(32, 2, true);
    v.setUint16(34, 16, true);
    v.setUint32(36, 0x64617461, false);
    v.setUint32(40, dataSize, true);
    v.setInt16(44, 1234, true);
    const file = {
      size: ab.byteLength,
      type: 'audio/wav',
      arrayBuffer: async () => ab,
    };
    const result = await loadSamsloopWav(file, makeDecodingCtx());
    expect(result.ok).toBe(true);
    expect(result.fileBytes).toBeDefined();
    expect(result.fileBytes!.byteLength).toBe(ab.byteLength);
    expect(result.fileMime).toBe('audio/wav');
  });

  it('does NOT expose fileBytes on rejection (size-gate failure path)', async () => {
    const file = {
      size: SAMSLOOP_MAX_FILE_BYTES + 1,
      arrayBuffer: async () => new ArrayBuffer(SAMSLOOP_MAX_FILE_BYTES + 1),
    };
    const result = await loadSamsloopWav(file, makeDecodingCtx());
    expect(result.ok).toBe(false);
    expect(result.fileBytes).toBeUndefined();
  });
});

describe('samsloopDecodeBytesB64 — engine-factory hydrate helper', () => {
  function makeCtx(decodedLen = 100): BaseAudioContext {
    return {
      decodeAudioData: async (_ab: ArrayBuffer): Promise<AudioBuffer> => ({
        length: decodedLen,
        numberOfChannels: 1,
        sampleRate: 22050,
        getChannelData: () => new Float32Array(decodedLen),
      } as unknown as AudioBuffer),
    } as unknown as BaseAudioContext;
  }

  // bytes-source for these tests: a tiny valid WAV (manual parser path)
  // so the decoder doesn't even need to fire.
  function makeWavB64(frames = 4): string {
    const dataSize = frames * 2;
    const ab = new ArrayBuffer(44 + dataSize);
    const v = new DataView(ab);
    v.setUint32(0, 0x52494646, false);
    v.setUint32(4, 36 + dataSize, true);
    v.setUint32(8, 0x57415645, false);
    v.setUint32(12, 0x666d7420, false);
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 1, true);
    v.setUint32(24, 22050, true);
    v.setUint32(28, 22050 * 2, true);
    v.setUint16(32, 2, true);
    v.setUint16(34, 16, true);
    v.setUint32(36, 0x64617461, false);
    v.setUint32(40, dataSize, true);
    const bytes = new Uint8Array(ab);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
    return btoa(binary);
  }

  it('returns null for an empty bytes string', async () => {
    const result = await samsloopDecodeBytesB64('', makeCtx());
    expect(result).toBeNull();
  });

  it('returns null for garbage base64', async () => {
    const result = await samsloopDecodeBytesB64('!!!not-base64!!!', makeCtx());
    expect(result).toBeNull();
  });

  it('decodes a real WAV via the manual-parse path (no AudioContext touch)', async () => {
    const b64 = makeWavB64(8);
    // Probe: assert decodeAudioData is NOT called (manual parser handles
    // valid WAV bytes without bothering the browser decoder).
    let decoderCalls = 0;
    const ctx = {
      decodeAudioData: async (_ab: ArrayBuffer): Promise<AudioBuffer> => {
        decoderCalls++;
        return { length: 0, numberOfChannels: 1, sampleRate: 0, getChannelData: () => new Float32Array(0) } as unknown as AudioBuffer;
      },
    } as unknown as BaseAudioContext;
    const result = await samsloopDecodeBytesB64(b64, ctx);
    expect(result).not.toBeNull();
    expect(result!.ok).toBe(true);
    expect(result!.samples).toBeDefined();
    expect(result!.samples!.length).toBe(8);
    expect(decoderCalls).toBe(0);
  });
});

// ---------- varispeed mapping ----------

describe('samsloopMath.rescaleBoundaries (perf-zip boundary-restore fix)', () => {
  it('is a no-op when the re-decoded length matches the saved length (WAV / same machine)', () => {
    expect(samsloopMath.rescaleBoundaries(2700, 8100, 10800, 10800)).toBeNull();
  });

  it('proportionally maps a sub-window when the buffer re-decodes longer', () => {
    // Saved 25%..75% over a 1000-sample buffer; re-decode yields 2000 samples
    // (e.g. a non-WAV source decoded on a higher-rate AudioContext). The window
    // must keep its 25%..75% placement → 500..1500.
    const r = samsloopMath.rescaleBoundaries(250, 750, 1000, 2000);
    expect(r).toEqual({ start: 500, end: 1500 });
  });

  it('proportionally maps when the buffer re-decodes shorter', () => {
    const r = samsloopMath.rescaleBoundaries(500, 1500, 2000, 1000);
    expect(r).toEqual({ start: 250, end: 750 });
  });

  it('re-anchors a pristine full-buffer window to the new length', () => {
    // start=0, end>=savedLen (or the 1e6 default ceiling) → full window.
    expect(samsloopMath.rescaleBoundaries(0, 1000, 1000, 1500)).toEqual({ start: 0, end: 1500 });
    expect(samsloopMath.rescaleBoundaries(0, 1e6, 1000, 1500)).toEqual({ start: 0, end: 1500 });
  });

  it('keeps start < end after rescale (never inverts the window)', () => {
    const r = samsloopMath.rescaleBoundaries(999, 1000, 1000, 4)!;
    expect(r.start).toBeLessThan(r.end);
    expect(r.end).toBeLessThanOrEqual(4);
  });

  it('returns null on degenerate lengths', () => {
    expect(samsloopMath.rescaleBoundaries(10, 20, 0, 100)).toBeNull();
    expect(samsloopMath.rescaleBoundaries(10, 20, 100, 0)).toBeNull();
    expect(samsloopMath.rescaleBoundaries(10, 20, Number.NaN, 100)).toBeNull();
  });
});

describe('samsloopMath.sliderToRate', () => {
  it('center (1.0) → unity forward', () => {
    expect(samsloopMath.sliderToRate(1)).toBe(1);
  });

  it('full right (+2.0) → 2× forward', () => {
    expect(samsloopMath.sliderToRate(2)).toBe(2);
  });

  it('full left (−2.0) → 2× reverse', () => {
    expect(samsloopMath.sliderToRate(-2)).toBe(-2);
  });

  it('0 → halts pitch but still advances (slider value === playback rate)', () => {
    // 0 isn't a meaningful musical value on the slider, but it IS a valid
    // value; the rate becomes 0 and the cursor stops. The slider's center
    // is +1, not 0 — see the rate fader's defaultValue in samsloopDef.
    expect(samsloopMath.sliderToRate(0)).toBe(0);
  });

  it('values past the limits clamp to ±2', () => {
    expect(samsloopMath.sliderToRate(10)).toBe(2);
    expect(samsloopMath.sliderToRate(-10)).toBe(-2);
  });

  it('the convention: center = forward 100%, NOT zero', () => {
    // Sanity check for the slider mapping: the default value is +1, and
    // +1 maps to forward unity. This is the load-bearing constraint the
    // task brief calls out — "0 V CV, slider mid = 1.0× normal playback".
    const c = samsloopDef.params.find((p) => p.id === 'rate')!.defaultValue;
    expect(samsloopMath.sliderToRate(c)).toBe(1.0);
  });
});

// ---------- start/end clamp ----------

describe('samsloopMath.clampWindow', () => {
  it('start < end in [0, len]', () => {
    const { start, end } = samsloopMath.clampWindow(10, 100, 200);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(end).toBeLessThanOrEqual(200);
  });

  it('clamps negative start to 0', () => {
    const w = samsloopMath.clampWindow(-50, 100, 200);
    expect(w.start).toBe(0);
    expect(w.end).toBe(100);
  });

  it('clamps end past buffer length to length', () => {
    const w = samsloopMath.clampWindow(10, 9999, 500);
    expect(w.start).toBe(10);
    expect(w.end).toBe(500);
  });

  it('enforces start < end even when caller passes start === end', () => {
    const w = samsloopMath.clampWindow(50, 50, 200);
    expect(w.end).toBeGreaterThan(w.start);
  });

  it('enforces start < end when caller passes start > end', () => {
    const w = samsloopMath.clampWindow(150, 50, 200);
    expect(w.end).toBeGreaterThan(w.start);
  });

  it('clamps start to len-1 for too-large start', () => {
    const w = samsloopMath.clampWindow(1000, 1200, 500);
    expect(w.start).toBe(499);
    expect(w.end).toBe(500);
  });
});

// ---------- loop vs one-shot semantics ----------

function rampBuffer(n: number): Float32Array {
  // Buffer with `samples[i] = i/n` so we can identify which position the
  // cursor was at by inspecting an output sample.
  const buf = new Float32Array(n);
  for (let i = 0; i < n; i++) buf[i] = i / n;
  return buf;
}

function sine440ish(n: number): Float32Array {
  // A non-trivial oscillating buffer (RMS clearly > 0) for "is there audio?"
  // assertions in the trigger tests. ~10 cycles across the window.
  const buf = new Float32Array(n);
  for (let i = 0; i < n; i++) buf[i] = Math.sin((2 * Math.PI * 10 * i) / n) * 0.8;
  return buf;
}

describe('samsloopMath.render — loop mode', () => {
  it('forward playback inside the window produces non-zero samples', () => {
    const buf = rampBuffer(100);
    const { out, active } = samsloopMath.render(buf, 50, 1, 0, 100, 'loop');
    expect(active).toBe(true);
    expect(out[0]).toBe(0);
    expect(out[49]).toBeCloseTo(49 / 100, 5);
  });

  it('looping wraps cursor: forward playback past `end` resumes near `start`', () => {
    // Window [0..100), rate=1, render 250 samples → cursor wraps twice.
    // After wrap, sample N should equal (N % 100) / 100.
    const buf = rampBuffer(100);
    const { out } = samsloopMath.render(buf, 250, 1, 0, 100, 'loop');
    expect(out[105]).toBeCloseTo(5 / 100, 5);
    expect(out[210]).toBeCloseTo(10 / 100, 5);
  });

  it('reverse playback (rate < 0) starts at end-1 and walks backward', () => {
    const buf = rampBuffer(100);
    const { out } = samsloopMath.render(buf, 50, -1, 0, 100, 'loop');
    expect(out[0]).toBeCloseTo(99 / 100, 5);
    expect(out[10]).toBeCloseTo(89 / 100, 5);
  });

  it('reverse playback wraps from start back to end-1 in loop mode', () => {
    const buf = rampBuffer(100);
    // Start at 99, decrement by 1 each sample. After 100 samples we wrap.
    const { out } = samsloopMath.render(buf, 150, -1, 0, 100, 'loop');
    // At i=0 cursor=99 → value 0.99. At i=99 cursor=0 → value 0. At i=100
    // we've wrapped; cursor should be near end-1 again. Look around i=100.
    expect(out[0]).toBeCloseTo(99 / 100, 5);
    expect(out[99]).toBeCloseTo(0 / 100, 5);
    // After the wrap, we should be back near the high end of the buffer.
    expect(out[101]).toBeGreaterThan(0.5);
  });

  it('rate=2 (forward 2× slider) advances cursor 2× per output sample', () => {
    // Buffer of 200 samples, window [0..200), rate=2 → 100 output samples
    // cover the full buffer.
    const buf = rampBuffer(200);
    const { out } = samsloopMath.render(buf, 100, 2, 0, 200, 'loop');
    // Sample 50: cursor = 100. Value should be ~0.5.
    expect(out[50]).toBeCloseTo(100 / 200, 4);
  });

  it('rate=-2 (reverse 2× slider) walks back 2× per output sample', () => {
    const buf = rampBuffer(200);
    const { out } = samsloopMath.render(buf, 100, -2, 0, 200, 'loop');
    // Sample 0: cursor = 199. Value ~ 0.995.
    expect(out[0]).toBeCloseTo(199 / 200, 4);
    // Sample 50: cursor ≈ 99.
    expect(out[50]).toBeCloseTo(99 / 200, 4);
  });
});

describe('samsloopMath.render — one-shot mode', () => {
  it('one-shot mode stops at end-of-window and emits silence after', () => {
    const buf = rampBuffer(100);
    // Window [0..100), rate=1, render 150 samples. After sample 100 we
    // should be silent.
    const { out, active } = samsloopMath.render(buf, 150, 1, 0, 100, 'one-shot');
    expect(active).toBe(false);
    expect(out[110]).toBe(0);
    expect(out[140]).toBe(0);
  });

  it('one-shot reverse stops at start and emits silence after', () => {
    const buf = rampBuffer(100);
    const { out, active } = samsloopMath.render(buf, 150, -1, 0, 100, 'one-shot');
    expect(active).toBe(false);
    expect(out[110]).toBe(0);
  });
});

describe('samsloopMath.render — rate semantics around the dead-center default', () => {
  // These tests pin the contract the rate-fader-rework relies on. The
  // pure-math mirror models the cursor as advancing by `rate` units per
  // output sample (it intentionally does NOT model the worklet's
  // bufferRate/contextRate scale — that's a separate layer documented in
  // the worklet header). What matters here: rate=1 → cursor moves one
  // buffer-sample per output sample; rate=0 → cursor frozen; rate<0 →
  // cursor walks backwards.

  it('rate=+1 (the default, dead-center on the knob) advances one buffer sample per output sample', () => {
    // Pure ramp 0..1 over 256 samples. After N output samples at rate=1
    // the cursor should be at index N (within fp tolerance), so out[N]
    // ≈ N/256.
    const buf = rampBuffer(256);
    const { out } = samsloopMath.render(buf, 100, 1, 0, 256, 'loop');
    for (const n of [0, 10, 50, 99]) {
      expect(out[n]).toBeCloseTo(n / 256, 5);
    }
  });

  it('rate=0 freezes playback: cursor never moves, all samples == buf[start]', () => {
    // A non-trivial window so we can see start-position parking. We seed
    // start=37 in a 200-sample ramp; the cursor begins at 37 and the
    // rate=0 path keeps it there for every output sample → out[i] = 0.185.
    const buf = rampBuffer(200);
    const { out, active } = samsloopMath.render(buf, 50, 0, 37, 200, 'loop');
    expect(active).toBe(true);
    for (let i = 0; i < 50; i++) {
      expect(out[i]).toBeCloseTo(37 / 200, 6);
    }
  });

  it('rate=-1 (reverse unity) walks the cursor backwards from end-1, one sample per output frame', () => {
    // Window [0..100), rate=-1 → cursor starts at 99 and decrements.
    // out[0] = 99/100, out[10] = 89/100, etc. (mirrors the existing
    // reverse-playback test but pins it as the unity-reverse contract.)
    const buf = rampBuffer(100);
    const { out } = samsloopMath.render(buf, 50, -1, 0, 100, 'loop');
    expect(out[0]).toBeCloseTo(99 / 100, 5);
    expect(out[10]).toBeCloseTo(89 / 100, 5);
    expect(out[49]).toBeCloseTo(50 / 100, 5);
  });
});

describe('samsloopMath.render — empty buffer', () => {
  it('renders silence for an empty buffer with no crashes', () => {
    const empty = new Float32Array(0);
    const { out, active } = samsloopMath.render(empty, 50, 1, 0, 100, 'loop');
    expect(active).toBe(false);
    for (let i = 0; i < out.length; i++) expect(out[i]).toBe(0);
  });
});

// ---------- idle-by-default + mode-aware trigger ----------
//
// The play-state machine the worklet implements (packages/dsp/src/samsloop.ts):
//   - starts IDLE (silent) — NO autoplay, even with a sample loaded
//   - a trigger (trig gate rising edge OR manual TRIGGER button) starts
//     playback from the window edge
//   - one-shot: plays through ONCE, then returns to silence
//   - loop: keeps looping; a re-trigger restarts from the window edge
// samsloopMath.renderWithTriggers mirrors this exactly (`trigSamples` is the
// set of rising-edge indices — the gate AND the button both surface there).

function rmsOf(buf: Float32Array, from = 0, to = buf.length): number {
  let s = 0;
  let n = 0;
  for (let i = from; i < to; i++) { s += (buf[i] ?? 0) ** 2; n++; }
  return n > 0 ? Math.sqrt(s / n) : 0;
}

describe('samsloopMath.renderWithTriggers — idle by default (no autoplay)', () => {
  it('emits PURE SILENCE until the first trigger, even with a sample loaded', () => {
    const buf = rampBuffer(100);
    // No triggers at all → idle the whole time → all silence.
    const { out, playing } = samsloopMath.renderWithTriggers(
      buf, 200, 1, 0, 100, 'loop', [],
    );
    expect(playing).toBe(false);
    for (let i = 0; i < out.length; i++) expect(out[i]).toBe(0);
  });

  it('a loaded buffer does not sound on its own — loop mode stays silent without a trigger', () => {
    const buf = sine440ish(500);
    const { out } = samsloopMath.renderWithTriggers(buf, 500, 1, 0, 500, 'loop', []);
    expect(rmsOf(out)).toBe(0);
  });
});

describe('samsloopMath.renderWithTriggers — one-shot mode', () => {
  it('a trigger plays the sample through ONCE then returns to silence', () => {
    const buf = rampBuffer(100);
    // Trigger at sample 0. Window length 100 at rate 1 → audible for ~100
    // samples, then silent for the rest (one-shot pass complete).
    const { out, playing } = samsloopMath.renderWithTriggers(
      buf, 300, 1, 0, 100, 'one-shot', [0],
    );
    // Early region (during the single pass) carries the ramp.
    expect(out[10]).toBeCloseTo(10 / 100, 5);
    expect(out[50]).toBeCloseTo(50 / 100, 5);
    // After one pass the machine is idle → silent.
    expect(playing).toBe(false);
    expect(out[150]).toBe(0);
    expect(out[299]).toBe(0);
    // Exactly one pass: the tail RMS must be zero.
    expect(rmsOf(out, 120, 300)).toBe(0);
  });

  it('idle before the trigger: silence up to the trigger index', () => {
    const buf = rampBuffer(100);
    // Trigger delayed to sample 40 → silent for [0,40), then the pass.
    const { out } = samsloopMath.renderWithTriggers(buf, 300, 1, 0, 100, 'one-shot', [40]);
    for (let i = 0; i < 40; i++) expect(out[i]).toBe(0);
    // First audible sample is at the trigger index (cursor reset to start).
    expect(out[40]).toBeCloseTo(0 / 100, 5);
    expect(out[50]).toBeCloseTo(10 / 100, 5);
  });
});

describe('samsloopMath.renderWithTriggers — loop mode', () => {
  it('a trigger starts CONTINUOUS playback that keeps producing audio across wraps', () => {
    const buf = sine440ish(50);
    const { out, playing } = samsloopMath.renderWithTriggers(
      buf, 1000, 1, 0, 50, 'loop', [0],
    );
    expect(playing).toBe(true);
    // Audio is present both early and late (it keeps looping, unlike one-shot).
    const early = rmsOf(out, 0, 50);
    const late = rmsOf(out, 900, 1000);
    expect(early).toBeGreaterThan(0.01);
    expect(late).toBeGreaterThan(early * 0.5);
  });

  it('re-trigger RESTARTS the loop from the window edge (cursor resets to start)', () => {
    const buf = rampBuffer(100);
    // Trigger at 0, then re-trigger at 250. After the re-trigger the cursor
    // jumps back to start, so out[250] is buf[start] = 0 and out[260] = 10/100,
    // regardless of where the loop had wandered to.
    const { out } = samsloopMath.renderWithTriggers(
      buf, 400, 1, 0, 100, 'loop', [0, 250],
    );
    expect(out[250]).toBeCloseTo(0 / 100, 5);
    expect(out[260]).toBeCloseTo(10 / 100, 5);
  });
});

describe('samsloopMath.renderWithTriggers — both trigger paths start playback', () => {
  // The gate input AND the manual TRIGGER button both surface as a rising-
  // edge index in trigSamples (the worklet treats them identically: trig
  // edge in process() vs a {type:'trigger'} port message applied at the top
  // of the next block). These two cases prove either source alone starts it.
  it('GATE-path trigger (mid-stream rising edge) starts playback', () => {
    const buf = rampBuffer(100);
    const { out, playing } = samsloopMath.renderWithTriggers(
      buf, 200, 1, 0, 100, 'one-shot', [30], // a gate edge at 30
    );
    for (let i = 0; i < 30; i++) expect(out[i]).toBe(0); // idle before
    expect(out[30]).toBeCloseTo(0, 5);                   // starts at start
    expect(playing).toBe(false);                          // one-shot finished
  });

  it('MANUAL-button trigger (modelled identically) starts playback the same way', () => {
    const buf = rampBuffer(100);
    // The button posts {type:'trigger'} → applied at a block boundary →
    // here modelled as a rising-edge index (5). Same start-from-edge effect.
    const { out } = samsloopMath.renderWithTriggers(buf, 200, 1, 0, 100, 'loop', [5]);
    for (let i = 0; i < 5; i++) expect(out[i]).toBe(0);
    expect(out[5]).toBeCloseTo(0 / 100, 5);
    expect(out[15]).toBeCloseTo(10 / 100, 5);
  });
});

// ---------- mic-record state machine ----------
//
// The state machine is pure; the card owns the actual MediaStream and
// AudioContext wiring. We test the transitions, the cap-enforcement
// auto-stop, and the one-sample-only invariant.

describe('samsloop mic-record state machine — transitions', () => {
  it('createSamsloopRecMachine starts in idle with empty samples', () => {
    const m = createSamsloopRecMachine(48000);
    expect(m.state).toBe('idle');
    expect(m.samples.length).toBe(0);
    expect(m.sampleRate).toBe(48000);
    expect(m.error).toBeNull();
    expect(m.stopReason).toBeNull();
  });

  it('samsloopRecStart: idle → recording, resets sample buffer', () => {
    const m = createSamsloopRecMachine(48000);
    const r = samsloopRecStart(m, 44100);
    expect(r.state).toBe('recording');
    expect(r.samples.length).toBe(0);
    expect(r.sampleRate).toBe(44100);
    expect(r.error).toBeNull();
  });

  it('samsloopRecStart on already-recording is a no-op (idempotent)', () => {
    let m = createSamsloopRecMachine(48000);
    m = samsloopRecStart(m, 48000);
    m = samsloopRecAppend(m, new Float32Array([0.1, 0.2, 0.3]));
    const before = m.samples;
    const after = samsloopRecStart(m, 48000);
    // Same object identity ⇒ no transition happened.
    expect(after).toBe(m);
    expect(after.samples).toBe(before);
  });

  it('samsloopRecStop: recording → stopped with stopReason=user', () => {
    let m = samsloopRecStart(createSamsloopRecMachine(), 48000);
    m = samsloopRecAppend(m, new Float32Array([0.5, 0.4]));
    const stopped = samsloopRecStop(m);
    expect(stopped.state).toBe('stopped');
    expect(stopped.stopReason).toBe('user');
    expect(stopped.samples.length).toBe(2);
  });

  it('samsloopRecStop is a no-op when not recording', () => {
    const idle = createSamsloopRecMachine();
    expect(samsloopRecStop(idle)).toBe(idle);
    const stopped = samsloopRecStop(samsloopRecStop(samsloopRecStart(idle, 48000)));
    expect(stopped.state).toBe('stopped');
    // Calling stop on an already-stopped machine returns the same ref.
    expect(samsloopRecStop(stopped)).toBe(stopped);
  });

  it('samsloopRecFail returns to idle with an inline error message (NOT thrown)', () => {
    const m = samsloopRecStart(createSamsloopRecMachine(), 48000);
    const failed = samsloopRecFail(m, 'Microphone permission denied');
    expect(failed.state).toBe('idle');
    expect(failed.error).toBe('Microphone permission denied');
    // Fresh sample buffer — failed recording does not leak partial samples.
    expect(failed.samples.length).toBe(0);
  });

  it('starting a fresh recording clears a previous error', () => {
    let m = samsloopRecFail(createSamsloopRecMachine(), 'No microphone available');
    expect(m.error).toBe('No microphone available');
    m = samsloopRecStart(m, 48000);
    expect(m.error).toBeNull();
    expect(m.state).toBe('recording');
  });
});

describe('samsloop mic-record state machine — append + cap', () => {
  it('samsloopRecAppend grows the sample buffer in order', () => {
    let m = samsloopRecStart(createSamsloopRecMachine(), 48000);
    m = samsloopRecAppend(m, new Float32Array([0.1, 0.2]));
    m = samsloopRecAppend(m, new Float32Array([0.3, 0.4]));
    expect(Array.from(m.samples)).toEqual([
      // toBeCloseTo not needed — we wrote literal values.
      expect.closeTo(0.1, 6),
      expect.closeTo(0.2, 6),
      expect.closeTo(0.3, 6),
      expect.closeTo(0.4, 6),
    ]);
    expect(m.state).toBe('recording');
  });

  it('samsloopRecAppend on non-recording state is a no-op', () => {
    const idle = createSamsloopRecMachine();
    const out = samsloopRecAppend(idle, new Float32Array([0.5]));
    expect(out).toBe(idle);
    expect(out.samples.length).toBe(0);
  });

  it('SAMSLOOP_MAX_SAMPLES is SAMSLOOP_MAX_FILE_BYTES / 4 (Float32 size)', () => {
    expect(SAMSLOOP_MAX_SAMPLES).toBe(Math.floor(SAMSLOOP_MAX_FILE_BYTES / 4));
  });

  it('auto-stops with stopReason=cap when the cap is exceeded mid-chunk', () => {
    let m = samsloopRecStart(createSamsloopRecMachine(), 22050);
    // Fill to one short of the cap.
    const fill = new Float32Array(SAMSLOOP_MAX_SAMPLES - 1);
    m = samsloopRecAppend(m, fill);
    expect(m.state).toBe('recording');
    // One more chunk pushes over: the helper truncates and stops.
    const oversize = new Float32Array(100);
    m = samsloopRecAppend(m, oversize);
    expect(m.state).toBe('stopped');
    expect(m.stopReason).toBe('cap');
    expect(m.samples.length).toBe(SAMSLOOP_MAX_SAMPLES);
  });

  it('append on a cap-stopped machine is a no-op (no further growth)', () => {
    let m = samsloopRecStart(createSamsloopRecMachine(), 22050);
    m = samsloopRecAppend(m, new Float32Array(SAMSLOOP_MAX_SAMPLES));
    expect(m.state).toBe('stopped');
    const before = m.samples;
    m = samsloopRecAppend(m, new Float32Array([0.99]));
    expect(m.samples).toBe(before);
  });

  it('one-sample invariant: re-start while stopped DROPS the previous take', () => {
    let m = samsloopRecStart(createSamsloopRecMachine(), 48000);
    m = samsloopRecAppend(m, new Float32Array([0.1, 0.2, 0.3]));
    m = samsloopRecStop(m);
    expect(m.samples.length).toBe(3);
    // Starting fresh wipes the previous samples — SAMSLOOP holds ONE
    // sample at a time (see header comment on samsloop.ts).
    m = samsloopRecStart(m, 48000);
    expect(m.samples.length).toBe(0);
    expect(m.state).toBe('recording');
  });
});
