// Pins the normalize core's contract (owner ruling: 0 dBFS target, DC first).

import { describe, expect, it } from 'vitest';
import { NORMALIZE_DC_EPS, normalizeSample } from './samsloop-normalize';
import { mulberry32 } from './noise-dsp';

function tone(n: number, amp: number, offset = 0): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = offset + amp * Math.sin((2 * Math.PI * 440 * i) / 24_000);
  return out;
}

function peak(x: Float32Array): number {
  let p = 0;
  for (let i = 0; i < x.length; i++) p = Math.max(p, Math.abs(x[i]!));
  return p;
}

function mean(x: Float32Array): number {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i]!;
  return s / x.length;
}

describe('normalizeSample', () => {
  it('removes the DC offset FIRST, then lands the peak on exactly 1.0', () => {
    const x = tone(24_000, 0.1, 0.05);
    const before = tone(24_000, 0.1, 0.05);
    // NEGATIVE CONTROL: the input fails both assertions, so they are non-vacuous.
    expect(Math.abs(mean(before))).toBeGreaterThan(0.04);
    expect(peak(before)).toBeLessThan(0.2);
    const r = normalizeSample(x);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Math.abs(mean(x))).toBeLessThan(NORMALIZE_DC_EPS);
    expect(peak(x)).toBe(1); // exactly, not toBeCloseTo — the division form guarantees it
    expect(r.dcOffset).toBeCloseTo(0.05, 4);
    expect(r.peakBefore).toBeCloseTo(0.1, 4);
    expect(r.gainDb).toBeCloseTo(20, 1);
  });

  it('a quiet vocal-shaped take (seeded noise at −40 dBFS) reaches exactly 1.0 and is idempotent', () => {
    const rnd = mulberry32(0xc0ffee);
    const x = new Float32Array(48_000);
    for (let i = 0; i < x.length; i++) x[i] = (rnd() * 2 - 1) * 0.01;
    expect(normalizeSample(x).ok).toBe(true);
    expect(peak(x)).toBe(1);
    const copy = x.slice();
    const second = normalizeSample(x);
    expect(second).toEqual({ ok: false, reason: 'already-full-scale' });
    expect(x).toEqual(copy); // a refusal writes nothing
  });

  it('silent → silent (digital zero AND a pure DC constant), buffer untouched', () => {
    const zero = new Float32Array(1000);
    expect(normalizeSample(zero)).toEqual({ ok: false, reason: 'silent' });
    const dc = new Float32Array(1000).fill(0.3);
    expect(normalizeSample(dc)).toEqual({ ok: false, reason: 'silent' });
    expect(dc[0]).toBe(Math.fround(0.3));
    expect(normalizeSample(new Float32Array(0))).toEqual({ ok: false, reason: 'silent' });
  });

  it('full scale with no offset → already-full-scale; full scale WITH an offset is normalised', () => {
    const full = tone(4800, 1.0);
    // A 440 Hz tone at 24 kHz does not hit exactly 1.0 on a sample; scale so it does.
    const p = peak(full);
    for (let i = 0; i < full.length; i++) full[i] = full[i]! / p;
    expect(peak(full)).toBe(1);
    expect(normalizeSample(full)).toEqual({ ok: false, reason: 'already-full-scale' });
    const offset = new Float32Array(4);
    offset.set([0.2, 1.2, 0.2, 0.2]); // extent after DC removal ≈ 0.75, offset 0.45
    const r = normalizeSample(offset);
    expect(r.ok).toBe(true);
    expect(peak(offset)).toBe(1);
    expect(Math.abs(mean(offset))).toBeLessThan(1e-6);
  });

  it('NaN / Infinity anywhere → not-finite, buffer untouched', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      const x = tone(1000, 0.2);
      x[500] = bad;
      const copy = x.slice();
      expect(normalizeSample(x)).toEqual({ ok: false, reason: 'not-finite' });
      // toEqual treats NaN === NaN; compare the finite neighbours and the bad slot's kind.
      expect(x[499]).toBe(copy[499]);
      expect(Number.isFinite(x[500]!)).toBe(false);
    }
  });

  it('DOCUMENTED: a single-sample click sets the gain (peak-normalise means the peak)', () => {
    const x = tone(24_000, 0.01); // −40 dBFS body
    x[12_000] = 0.5; // one click
    const r = normalizeSample(x);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(peak(x)).toBe(1);
    expect(Math.abs(x[12_000]!)).toBe(1); // the click IS the peak
    expect(r.gainDb).toBeCloseTo(20 * Math.log10(1 / 0.5), 1); // +6 dB, not +40
  });
});
