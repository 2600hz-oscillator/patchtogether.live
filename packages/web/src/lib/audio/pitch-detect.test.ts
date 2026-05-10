// packages/web/src/lib/audio/pitch-detect.test.ts
//
// Layer-1 calibration: pure-sine math sanity. Validates that the YIN detector
// + hzToNoteCents math give the right Hz / note name / cents on synthesized
// sines. Layers 2 and 3 (under art/scenarios/scope-tuner/) cover harmonic
// content + real-world references.

import { describe, expect, it } from 'vitest';
import { detectPitch, hzToNoteCents } from './pitch-detect';

const SR = 48000;

function sineBuffer(hz: number, samples: number, sampleRate: number, amp = 0.5): Float32Array {
  const out = new Float32Array(samples);
  const w = (2 * Math.PI * hz) / sampleRate;
  for (let i = 0; i < samples; i++) out[i] = Math.sin(w * i) * amp;
  return out;
}

describe('hzToNoteCents', () => {
  it('440 Hz → A4 / 0 cents', () => {
    const r = hzToNoteCents(440);
    expect(r.note).toBe('A4');
    expect(Math.abs(r.cents)).toBeLessThan(0.01);
  });

  it('261.6256 Hz → C4 / 0 cents', () => {
    const r = hzToNoteCents(261.6256);
    expect(r.note).toBe('C4');
    expect(Math.abs(r.cents)).toBeLessThan(0.1);
  });

  it('detects sharp deviation', () => {
    // A4 + 25 cents = 440 * 2^(25/1200) ≈ 446.4 Hz
    const hz = 440 * Math.pow(2, 25 / 1200);
    const r = hzToNoteCents(hz);
    expect(r.note).toBe('A4');
    expect(r.cents).toBeGreaterThan(24.5);
    expect(r.cents).toBeLessThan(25.5);
  });

  it('detects flat deviation', () => {
    const hz = 440 * Math.pow(2, -30 / 1200);
    const r = hzToNoteCents(hz);
    expect(r.note).toBe('A4');
    expect(r.cents).toBeLessThan(-29.5);
    expect(r.cents).toBeGreaterThan(-30.5);
  });

  it('crosses note boundaries correctly', () => {
    expect(hzToNoteCents(220).note).toBe('A3');
    expect(hzToNoteCents(880).note).toBe('A5');
    expect(hzToNoteCents(1760).note).toBe('A6');
    expect(hzToNoteCents(110).note).toBe('A2');
  });
});

describe('detectPitch — Layer 1: pure sines', () => {
  // Buffer of 4096 covers 2+ cycles even at 50 Hz; YIN needs at least one
  // full period (2 actually, since halfN = bufferLen/2).
  const N = 4096;

  for (const hz of [110, 220, 440, 880, 1760] as const) {
    it(`${hz} Hz sine → detected within 0.5%`, () => {
      const buf = sineBuffer(hz, N, SR);
      const r = detectPitch(buf, SR);
      expect(r.hz, `${hz}Hz: detected ${r.hz}`).not.toBeNull();
      const err = Math.abs((r.hz! - hz) / hz);
      expect(err, `${hz}Hz: relative error ${err}`).toBeLessThan(0.005);
    });
  }

  it('440 Hz → "A4" within ±5 cents', () => {
    const r = detectPitch(sineBuffer(440, N, SR), SR);
    expect(r.note).toBe('A4');
    expect(Math.abs(r.cents!)).toBeLessThan(5);
  });

  it('A2 → "A2", A3 → "A3", A5 → "A5", A6 → "A6"', () => {
    expect(detectPitch(sineBuffer(110, N, SR), SR).note).toBe('A2');
    expect(detectPitch(sineBuffer(220, N, SR), SR).note).toBe('A3');
    expect(detectPitch(sineBuffer(880, N, SR), SR).note).toBe('A5');
    expect(detectPitch(sineBuffer(1760, N, SR), SR).note).toBe('A6');
  });

  it('silence → null', () => {
    const buf = new Float32Array(N);
    const r = detectPitch(buf, SR);
    expect(r.hz).toBeNull();
    expect(r.note).toBeNull();
    expect(r.cents).toBeNull();
  });

  it('white noise → null (or low-confidence reject)', () => {
    const buf = new Float32Array(N);
    // Deterministic LCG so the test isn't flaky.
    let s = 0x12345678;
    for (let i = 0; i < N; i++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      buf[i] = ((s / 0x7fffffff) * 2 - 1) * 0.5;
    }
    const r = detectPitch(buf, SR);
    // YIN may or may not return a value for white noise depending on the
    // RNG path; if it does, confidence must be above the threshold proxy
    // (we set 0.15) — i.e. the result is always null at default threshold.
    expect(r.hz).toBeNull();
  });

  it('sharp by +25 cents → cents ≈ +25', () => {
    const hz = 440 * Math.pow(2, 25 / 1200);
    const r = detectPitch(sineBuffer(hz, N, SR), SR);
    expect(r.note).toBe('A4');
    expect(r.cents!).toBeGreaterThan(20);
    expect(r.cents!).toBeLessThan(30);
  });

  it('flat by -25 cents → cents ≈ -25', () => {
    const hz = 440 * Math.pow(2, -25 / 1200);
    const r = detectPitch(sineBuffer(hz, N, SR), SR);
    expect(r.note).toBe('A4');
    expect(r.cents!).toBeLessThan(-20);
    expect(r.cents!).toBeGreaterThan(-30);
  });
});
