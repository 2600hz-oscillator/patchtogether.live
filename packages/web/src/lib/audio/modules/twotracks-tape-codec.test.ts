// packages/web/src/lib/audio/modules/twotracks-tape-codec.test.ts
//
// Unit tests for the pure TWOTRACKS tape persistence codec — the
// encode/decode that lets a recorded reel survive the perf-zip round-trip
// (FIX 3: TWOTRACKS media never round-tripped because the tape is worklet-owned
// PCM, never on node.data). 16-bit interleaved-stereo, near-lossless at the
// quantization step.

import { describe, it, expect } from 'vitest';
import { encodeTapeBytes, decodeTapeBytes } from './twotracks';

describe('twotracks tape codec', () => {
  it('round-trips L/R PCM within 16-bit quantization', () => {
    const n = 256;
    const bufL = new Float32Array(n);
    const bufR = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      bufL[i] = Math.sin((2 * Math.PI * i) / 32) * 0.8;
      bufR[i] = Math.cos((2 * Math.PI * i) / 48) * 0.5;
    }
    const bytes = encodeTapeBytes(bufL, bufR, n);
    expect(bytes.byteLength).toBe(n * 4); // 2 ch × 2 bytes

    const decoded = decodeTapeBytes(bytes);
    expect(decoded.bufLen).toBe(n);
    expect(decoded.bufL).toHaveLength(n);
    expect(decoded.bufR).toHaveLength(n);
    // 16-bit step ≈ 1/32768 ≈ 3.05e-5 — allow a generous quantization margin.
    for (let i = 0; i < n; i++) {
      expect(Math.abs(decoded.bufL[i]! - bufL[i]!)).toBeLessThan(1e-4);
      expect(Math.abs(decoded.bufR[i]! - bufR[i]!)).toBeLessThan(1e-4);
    }
  });

  it('encodes ONLY the recorded [0,bufLen) portion (ignores the silent tail)', () => {
    const bufL = new Float32Array(1000);
    const bufR = new Float32Array(1000);
    bufL.fill(0.25);
    bufR.fill(-0.25);
    const bytes = encodeTapeBytes(bufL, bufR, 100); // only first 100 frames
    expect(bytes.byteLength).toBe(100 * 4);
    expect(decodeTapeBytes(bytes).bufLen).toBe(100);
  });

  it('returns empty bytes for an empty take', () => {
    expect(encodeTapeBytes(new Float32Array(0), new Float32Array(0), 0).byteLength).toBe(0);
    expect(encodeTapeBytes(new Float32Array(10), new Float32Array(10), 0).byteLength).toBe(0);
  });

  it('clamps out-of-range samples to [-1, 1]', () => {
    const bufL = Float32Array.from([2.0, -2.0]);
    const bufR = Float32Array.from([-5.0, 5.0]);
    const decoded = decodeTapeBytes(encodeTapeBytes(bufL, bufR, 2));
    expect(decoded.bufL[0]!).toBeCloseTo(1.0, 3);
    expect(decoded.bufL[1]!).toBeCloseTo(-1.0, 3);
    expect(decoded.bufR[0]!).toBeCloseTo(-1.0, 3);
    expect(decoded.bufR[1]!).toBeCloseTo(1.0, 3);
  });

  it('caps bufLen to the shorter of the two channels', () => {
    const bytes = encodeTapeBytes(new Float32Array(50), new Float32Array(20), 50);
    expect(decodeTapeBytes(bytes).bufLen).toBe(20);
  });
});
