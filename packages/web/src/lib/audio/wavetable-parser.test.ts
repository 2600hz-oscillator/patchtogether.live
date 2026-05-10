// packages/web/src/lib/audio/wavetable-parser.test.ts
//
// Pure unit tests for the E352 wavetable WAV parser. Round-trips an
// in-memory synthesized E352-format buffer (encodeE352Wav → parseE352Wav)
// across the standard frame counts (32, 64, 128, 256), and exercises the
// rejection paths for malformed inputs.

import { describe, it, expect } from 'vitest';
import { parseE352Wav, encodeE352Wav, E352_FRAME_SIZE } from './wavetable-parser';

function synthFrames(frameCount: number): Float32Array[] {
  const frames: Float32Array[] = [];
  for (let f = 0; f < frameCount; f++) {
    const frame = new Float32Array(E352_FRAME_SIZE);
    const t = frameCount > 1 ? f / (frameCount - 1) : 0;
    for (let s = 0; s < E352_FRAME_SIZE; s++) {
      const ph = s / E352_FRAME_SIZE;
      const sine = Math.sin(2 * Math.PI * ph);
      const saw = ph * 2 - 1;
      frame[s] = sine * (1 - t) + saw * t;
    }
    frames[f] = frame;
  }
  return frames;
}

describe('parseE352Wav: round-trip', () => {
  for (const fc of [32, 64, 128, 256]) {
    it(`encode → parse preserves ${fc} frames × 256 samples`, () => {
      const original = synthFrames(fc);
      const buf = encodeE352Wav(original, 44100);
      expect(buf.byteLength).toBe(44 + fc * E352_FRAME_SIZE * 2);
      const parsed = parseE352Wav(buf);
      expect(parsed.frames.length).toBe(fc);
      expect(parsed.samplesPerFrame).toBe(256);
      expect(parsed.sampleRate).toBe(44100);
      expect(parsed.bitsPerSample).toBe(16);

      const lastFrameIdx = fc - 1;
      for (const f of [0, Math.floor(fc / 2), lastFrameIdx]) {
        for (let s = 0; s < E352_FRAME_SIZE; s += 17) {
          // 16-bit PCM round-trip tolerance: ±2 LSB ≈ 6e-5.
          expect(Math.abs(parsed.frames[f]![s]! - original[f]![s]!)).toBeLessThan(1e-4);
        }
      }
    });
  }
});

describe('parseE352Wav: rejection cases', () => {
  it('throws on too-short buffer', () => {
    expect(() => parseE352Wav(new ArrayBuffer(20))).toThrow(/too short/);
  });

  it("throws on missing 'RIFF'", () => {
    const buf = encodeE352Wav(synthFrames(32));
    new DataView(buf).setUint8(0, 0);
    expect(() => parseE352Wav(buf)).toThrow(/RIFF/);
  });

  it('throws when sample count is not divisible by 256', () => {
    // Manually build a 200-sample WAV (mono PCM16, 44.1k).
    const totalSamples = 200;
    const dataLen = totalSamples * 2;
    const buf = new ArrayBuffer(44 + dataLen);
    const v = new DataView(buf);
    const writeAscii = (off: number, s: string) => {
      for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
    };
    writeAscii(0, 'RIFF');
    v.setUint32(4, 36 + dataLen, true);
    writeAscii(8, 'WAVE');
    writeAscii(12, 'fmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 1, true);
    v.setUint32(24, 44100, true);
    v.setUint32(28, 44100 * 2, true);
    v.setUint16(32, 2, true);
    v.setUint16(34, 16, true);
    writeAscii(36, 'data');
    v.setUint32(40, dataLen, true);
    expect(() => parseE352Wav(buf)).toThrow(/divisible/);
  });

  it('throws on stereo WAV', () => {
    // Hand-craft minimal stereo (2-channel) PCM16 — fmt sets numChannels=2,
    // data length = 256 frames * 2 channels * 2 bytes = 1024.
    const dataLen = 1024;
    const buf = new ArrayBuffer(44 + dataLen);
    const v = new DataView(buf);
    const writeAscii = (off: number, s: string) => {
      for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
    };
    writeAscii(0, 'RIFF');
    v.setUint32(4, 36 + dataLen, true);
    writeAscii(8, 'WAVE');
    writeAscii(12, 'fmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 2, true);
    v.setUint32(24, 44100, true);
    v.setUint32(28, 44100 * 4, true);
    v.setUint16(32, 4, true);
    v.setUint16(34, 16, true);
    writeAscii(36, 'data');
    v.setUint32(40, dataLen, true);
    expect(() => parseE352Wav(buf)).toThrow(/mono/);
  });

  it('throws on non-PCM format', () => {
    const buf = encodeE352Wav(synthFrames(32));
    new DataView(buf).setUint16(20, 3, true);
    expect(() => parseE352Wav(buf)).toThrow(/PCM/);
  });
});

describe('parseE352Wav: sample range', () => {
  it('all sample values stay within -1..+1', () => {
    const frames = synthFrames(64);
    const buf = encodeE352Wav(frames);
    const parsed = parseE352Wav(buf);
    for (const f of parsed.frames) {
      for (let i = 0; i < f.length; i++) {
        expect(f[i]).toBeGreaterThanOrEqual(-1);
        expect(f[i]).toBeLessThanOrEqual(1);
      }
    }
  });
});
