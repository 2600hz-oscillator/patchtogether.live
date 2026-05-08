import { describe, it, expect } from 'vitest';
import { mulberry32, splitSeed, fnv1a32 } from './prng';

describe('mulberry32', () => {
  it('matches bryc reference vectors for seed=1', () => {
    const r = mulberry32(1);
    expect(r()).toBeCloseTo(0.6270739405881613, 15);
    expect(r()).toBeCloseTo(0.002735721180215478, 15);
    expect(r()).toBeCloseTo(0.5274470399599522, 15);
    expect(r()).toBeCloseTo(0.9810509674716741, 15);
    expect(r()).toBeCloseTo(0.9683778982143849, 15);
  });

  it('matches bryc reference vectors for seed=0', () => {
    const r = mulberry32(0);
    expect(r()).toBeCloseTo(0.26642920868471265, 15);
    expect(r()).toBeCloseTo(0.0003297457005828619, 15);
    expect(r()).toBeCloseTo(0.2232720274478197, 15);
  });

  it('matches reference vectors for seed=0xdeadbeef', () => {
    const r = mulberry32(0xdeadbeef);
    expect(r()).toBeCloseTo(0.9413696140982211, 15);
    expect(r()).toBeCloseTo(0.26719574979506433, 15);
    expect(r()).toBeCloseTo(0.772033357527107, 15);
  });

  it('matches reference vectors for seed=42', () => {
    const r = mulberry32(42);
    expect(r()).toBeCloseTo(0.6011037519201636, 15);
    expect(r()).toBeCloseTo(0.44829055899754167, 15);
    expect(r()).toBeCloseTo(0.8524657934904099, 15);
  });

  it('produces identical sequences for the same seed across instances', () => {
    const a = mulberry32(12345);
    const b = mulberry32(12345);
    for (let i = 0; i < 1000; i++) {
      expect(a()).toBe(b());
    }
  });

  it('produces values strictly in [0, 1)', () => {
    const r = mulberry32(987654321);
    for (let i = 0; i < 10000; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('produces different sequences for different seeds', () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    let differs = 0;
    for (let i = 0; i < 100; i++) {
      if (a() !== b()) differs++;
    }
    expect(differs).toBe(100);
  });

  it('treats seed as signed 32-bit (negative seeds work)', () => {
    const a = mulberry32(-1);
    const b = mulberry32(0xffffffff | 0);
    for (let i = 0; i < 100; i++) {
      expect(a()).toBe(b());
    }
  });
});

describe('splitSeed', () => {
  it('is deterministic', () => {
    expect(splitSeed(1, 2)).toBe(splitSeed(1, 2));
  });

  it('differs across different instance hashes', () => {
    const a = splitSeed(1234, 1);
    const b = splitSeed(1234, 2);
    expect(a).not.toBe(b);
  });

  it('differs across different rack seeds', () => {
    const a = splitSeed(1, 99);
    const b = splitSeed(2, 99);
    expect(a).not.toBe(b);
  });

  it('produces seeds that, when fed to mulberry32, yield decorrelated streams', () => {
    const sa = splitSeed(0xc0ffee, fnv1a32('lfo-1'));
    const sb = splitSeed(0xc0ffee, fnv1a32('lfo-2'));
    const a = mulberry32(sa);
    const b = mulberry32(sb);
    let same = 0;
    for (let i = 0; i < 100; i++) {
      if (a() === b()) same++;
    }
    expect(same).toBe(0);
  });
});

describe('fnv1a32', () => {
  it('is deterministic', () => {
    expect(fnv1a32('hello')).toBe(fnv1a32('hello'));
  });

  it('returns a u32', () => {
    const h = fnv1a32('any-string');
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(0xffffffff);
  });
});
