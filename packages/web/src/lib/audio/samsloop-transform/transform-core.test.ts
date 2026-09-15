// The transform core, driven with the REAL dsp cores and no Worker — the
// request→response the worker shim posts and the inline fallback returns.
//
// What is pinned: the record-path round trip at BOTH bit depths (an 8-bit
// take comes back 8-bit — no size growth), the upload (f32) path, the
// stereo→mono collapse, the DENOISE marker (set by denoise, CARRIED through a
// later normalize, never invented by normalize alone), and that every dsp
// refusal reaches the caller by name with NO record built.

import { describe, expect, it } from 'vitest';
import { runSamsloopTransform } from './transform-core';
import {
  buildRecordedSample,
  decodeRecordedPcm,
  quantizeF32ToI16,
  quantizeF32ToI8,
} from '../modules/samsloop-record';

const RATE = 24_000;

/** A quiet, DC-offset 440 Hz tone: 0.1 amplitude + 0.05 offset, `seconds` long. */
function quietTone(seconds: number, amp = 0.1, dc = 0.05): Float32Array {
  const n = Math.floor(RATE * seconds);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin((2 * Math.PI * 440 * i) / RATE) + dc;
  return x;
}

function pcmSource(f32: Float32Array, bits: 8 | 16, channels: 1 | 2 = 1) {
  const q = bits === 16 ? quantizeF32ToI16(f32) : quantizeF32ToI8(f32);
  const bytes = new Uint8Array(q.buffer, q.byteOffset, q.byteLength);
  const { sample } = buildRecordedSample(bytes, RATE, bits, channels, 1);
  return {
    kind: 'pcm' as const,
    bytesB64: sample.bytesB64,
    bits,
    channels,
    rate: RATE,
  };
}

function peakOf(x: Float32Array): number {
  let p = 0;
  for (const v of x) p = Math.max(p, Math.abs(v));
  return p;
}

describe('transform-core — NORMALIZE on the record path', () => {
  it('a 16-bit take comes back 16-bit, mono, at its own rate, peak on exactly +32767', () => {
    const src = pcmSource(quietTone(0.5), 16);
    const res = runSamsloopTransform({ id: 1, kind: 'normalize', source: src, now: 42 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.sample.bits).toBe(16);
    expect(res.sample.channels).toBe(1);
    expect(res.sample.rate).toBe(RATE);
    expect(res.sample.recordedAt).toBe(42);
    expect(res.frames).toBe(Math.floor(RATE * 0.5));
    expect(res.sample.byteLength).toBe(res.frames * 2);
    expect(res.sample.denoised, 'normalize alone never invents the marker').toBeUndefined();
    const out = decodeRecordedPcm(res.sample, 'mix');
    expect(peakOf(out)).toBe(1); // +32767 / 0x7fff is exactly 1
    expect(res.stats.kind).toBe('normalize');
    if (res.stats.kind === 'normalize') {
      expect(res.stats.gainDb).toBeGreaterThan(19);
      expect(res.stats.dcOffset).toBeCloseTo(0.05, 2);
    }
  });

  it('an 8-BIT take stays 8-bit — the write never grows a record (owner: source bit depth)', () => {
    const src = pcmSource(quietTone(0.5), 8);
    const res = runSamsloopTransform({ id: 2, kind: 'normalize', source: src });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.sample.bits).toBe(8);
    expect(res.sample.byteLength, 'one byte per frame').toBe(res.frames);
    const out = decodeRecordedPcm(res.sample, 'mix');
    expect(peakOf(out)).toBe(1); // +127 / 0x7f
  });

  it('a STEREO take collapses to the mono mix playback already heard', () => {
    // Interleaved L/R: L = quiet tone, R = silence → mix = half the tone.
    const mono = quietTone(0.5, 0.2, 0);
    const inter = new Float32Array(mono.length * 2);
    for (let i = 0; i < mono.length; i++) inter[i * 2] = mono[i]!;
    const src = pcmSource(inter, 16, 2);
    const res = runSamsloopTransform({ id: 3, kind: 'normalize', source: src });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.sample.channels).toBe(1);
    expect(res.frames).toBe(mono.length);
    if (res.stats.kind === 'normalize') {
      // The mix peak was 0.1 (half of 0.2), so the gain is +20 dB.
      expect(res.stats.peakBefore).toBeCloseTo(0.1, 3);
    }
  });

  it('NEGATIVE CONTROL: the INPUT is neither zero-mean nor full-scale', () => {
    const x = quietTone(0.5);
    let sum = 0;
    for (const v of x) sum += v;
    expect(Math.abs(sum / x.length)).toBeGreaterThan(0.04);
    expect(peakOf(x)).toBeLessThan(0.2);
  });
});

describe('transform-core — the upload (f32) path', () => {
  it('a transferred Float32 buffer is written at 16-bit mono at the decoded rate', () => {
    const x = quietTone(0.5);
    const res = runSamsloopTransform({
      id: 4,
      kind: 'normalize',
      source: { kind: 'f32', samples: x.buffer as ArrayBuffer, rate: RATE, bits: 16 },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.sample.bits).toBe(16);
    expect(res.sample.rate).toBe(RATE);
    expect(res.frames).toBe(x.length);
  });
});

describe('transform-core — refusals reach the caller by name, with no record built', () => {
  it('silence → silent', () => {
    const res = runSamsloopTransform({ id: 5, kind: 'normalize', source: pcmSource(new Float32Array(RATE), 16) });
    expect(res).toEqual({ id: 5, ok: false, reason: 'silent' });
  });

  it('an empty payload → empty', () => {
    const res = runSamsloopTransform({ id: 6, kind: 'normalize', source: pcmSource(new Float32Array(0), 16) });
    expect(res).toEqual({ id: 6, ok: false, reason: 'empty' });
  });

  it('a second NORMALIZE on the written record → already-full-scale (the QUANTIZED no-op)', () => {
    const first = runSamsloopTransform({ id: 7, kind: 'normalize', source: pcmSource(quietTone(0.5), 16) });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // ⚠ THE FINDING THIS LEG PINS: int16 rounding leaves the written record
    // with a mean ABOVE the core's 1e-6 epsilon, so the core alone would say
    // ok with a ~0 dB gain and the button would rewrite the sample for
    // nothing. Measured here so the guard's premise cannot drift silently.
    const back = decodeRecordedPcm(first.sample, 'mix');
    let sum = 0;
    for (const v of back) sum += v;
    expect(Math.abs(sum / back.length), 'the quantized mean exceeds the core epsilon').toBeGreaterThan(1e-6);
    expect(Math.abs(sum / back.length), '…but is under one 16-bit LSB').toBeLessThan(1 / 0x7fff);
    const again = runSamsloopTransform({
      id: 8,
      kind: 'normalize',
      source: { kind: 'pcm', bytesB64: first.sample.bytesB64, bits: 16, channels: 1, rate: RATE },
    });
    expect(again).toEqual({ id: 8, ok: false, reason: 'already-full-scale' });
  });

  it('a second NORMALIZE on an 8-BIT record → already-full-scale too (one int8 LSB is 0.8 %)', () => {
    const first = runSamsloopTransform({ id: 13, kind: 'normalize', source: pcmSource(quietTone(0.5), 8) });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const again = runSamsloopTransform({
      id: 14,
      kind: 'normalize',
      source: { kind: 'pcm', bytesB64: first.sample.bytesB64, bits: 8, channels: 1, rate: RATE },
    });
    expect(again).toEqual({ id: 14, ok: false, reason: 'already-full-scale' });
  });

  it('DENOISE on a steady pad → no-steady-noise-floor (the owner\'s Q4 refusal)', () => {
    const n = RATE * 2;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let v = 0;
      for (let h = 1; h <= 5; h++) v += Math.sin((2 * Math.PI * 110 * h * i) / RATE) / h;
      x[i] = 0.3 * v;
    }
    const res = runSamsloopTransform({ id: 9, kind: 'denoise', source: pcmSource(x, 16) });
    expect(res).toEqual({ id: 9, ok: false, reason: 'no-steady-noise-floor' });
  });

  it('DENOISE on 0.2 s → too-short', () => {
    const res = runSamsloopTransform({ id: 10, kind: 'denoise', source: pcmSource(quietTone(0.2), 16) });
    expect(res).toEqual({ id: 10, ok: false, reason: 'too-short' });
  });
});

describe('transform-core — the DENOISE marker', () => {
  /** A vocal-like phrase with gaps + white hiss: the fixture the dsp lane
   *  proves the gate on; here only the MARKER and the shape are asserted. */
  function hissyPhrase(): Float32Array {
    const n = RATE * 3;
    const x = new Float32Array(n);
    let s = 0xc0ffee;
    const rnd = () => {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5;
    };
    for (let i = 0; i < n; i++) {
      const t = i / RATE;
      const on = t % 0.6 < 0.35; // 5 syllables, gaps between
      let v = 0;
      if (on) for (const f of [220, 660, 1100]) v += 0.2 * Math.sin(2 * Math.PI * f * t);
      // ≈ −41 dBFS white hiss, plus a +0.01 DC offset (= the hiss RMS): the
      // face runs DENOISE before NORMALIZE, so the offset is still there.
      x[i] = v + 0.01 * rnd() * 2 + 0.01;
    }
    return x;
  }

  it('denoise stamps the record; a later normalize CARRIES it; the stats say what moved', () => {
    const den = runSamsloopTransform({ id: 11, kind: 'denoise', source: pcmSource(hissyPhrase(), 16) });
    expect(den.ok, JSON.stringify(den)).toBe(true);
    if (!den.ok) return;
    expect(den.sample.denoised).toBe(true);
    if (den.stats.kind === 'denoise') {
      expect(den.stats.reductionDb).toBeGreaterThan(9);
      expect(den.stats.noiseFloorDb, 'the floor is the hiss, not the offset').toBeLessThan(-36);
    }
    const norm = runSamsloopTransform({
      id: 12,
      kind: 'normalize',
      source: { kind: 'pcm', bytesB64: den.sample.bytesB64, bits: 16, channels: 1, rate: RATE },
      denoised: !!den.sample.denoised,
    });
    expect(norm.ok).toBe(true);
    if (!norm.ok) return;
    expect(norm.sample.denoised, 'the marker survives a normalize').toBe(true);
    if (norm.stats.kind === 'normalize') {
      expect(norm.stats.dcOffset, 'DENOISE left the offset for NORMALIZE to remove and report').toBeCloseTo(0.01, 3);
    }
  });
});
