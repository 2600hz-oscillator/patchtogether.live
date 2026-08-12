// packages/web/src/lib/video/warrensvisions-core.test.ts
//
// Gates for the WARREN'S VISIONS spectral core. The load-bearing ones are the
// COHERENCE legs: the whole module is a claim about what phase does, and a
// test that only asserted "the output is not black" would pass with the
// servo deleted.

import { describe, it, expect } from 'vitest';
import {
  WarrensVisionsEngine,
  WvFft,
  wvFft2d,
  wvHarmonicWeight,
  wvPeakSalience,
  WV_GRID,
  WV_MAX_COMPONENTS,
  WV_RESIDUAL_RINGS,
  WV_MAX_HARMONICS,
  WV_SLEW_MIN_S,
} from './warrensvisions-core';

const N = WV_GRID;

/** A single 2D cosine grating: amplitude `amp`, wavevector (u,v) cycles per
 *  grid, phase `phase`, on a mid-grey pedestal. */
function grating(u: number, v: number, amp = 0.3, phase = 0, dc = 0.5): Float32Array {
  const f = new Float32Array(N * N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      f[y * N + x] = dc + amp * Math.cos((2 * Math.PI * (u * x + v * y)) / N + phase);
    }
  }
  return f;
}

/** Deterministic pseudo-image with broadband content. */
function noiseField(seed = 1): Float32Array {
  const f = new Float32Array(N * N);
  let s = seed >>> 0 || 1;
  for (let i = 0; i < f.length; i++) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    f[i] = s / 4294967295;
  }
  return f;
}

/** Drive `commits` analysis frames of the same field, advancing 1/60 s each. */
function settle(eng: WarrensVisionsEngine, field: Float32Array, commits: number): void {
  for (let i = 0; i < commits; i++) {
    eng.analyze(field);
    eng.advance(1 / 60);
  }
}

function rms(a: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * a[i]!;
  return Math.sqrt(s / a.length);
}

/** Normalised correlation between two planes after removing their means —
 *  1 = identical structure, 0 = unrelated, −1 = inverted.
 *
 *  ⚠ This is Pearson, which is invariant to gain AND to sign flips of the
 *  whole plane. It is used here only where the thing under test is the
 *  STRUCTURE, and every use is paired with a control that must NOT correlate,
 *  so a metric that returned a constant could not pass. */
function correlation(a: Float32Array, b: Float32Array): number {
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < a.length; i++) {
    ma += a[i]!;
    mb += b[i]!;
  }
  ma /= a.length;
  mb /= b.length;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]! - ma;
    const y = b[i]! - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  return num / (Math.sqrt(da * db) + 1e-20);
}

describe('WvFft', () => {
  it('round-trips a random plane to itself', () => {
    const fft = new WvFft(N);
    const re = noiseField(7);
    const im = new Float32Array(N * N);
    const orig = Float32Array.from(re);
    wvFft2d(fft, re, im, N, false);
    wvFft2d(fft, re, im, N, true);
    let maxErr = 0;
    for (let i = 0; i < re.length; i++) maxErr = Math.max(maxErr, Math.abs(re[i]! - orig[i]!));
    expect(maxErr).toBeLessThan(1e-4);
  });

  it('puts a pure grating on exactly one conjugate pair', () => {
    const fft = new WvFft(N);
    const re = grating(5, 3, 1, 0, 0);
    const im = new Float32Array(N * N);
    wvFft2d(fft, re, im, N, false);
    const mag = (u: number, v: number) => {
      const ix = ((u % N) + N) % N;
      const iy = ((v % N) + N) % N;
      return Math.hypot(re[iy * N + ix]!, im[iy * N + ix]!);
    };
    const peak = mag(5, 3);
    expect(peak).toBeGreaterThan((N * N) / 4);
    expect(mag(-5, -3)).toBeCloseTo(peak, 1);
    // Everything else is numerically zero.
    let other = 0;
    for (let iy = 0; iy < N; iy++) {
      for (let ix = 0; ix < N; ix++) {
        const u = ix <= N / 2 ? ix : ix - N;
        const v = iy <= N / 2 ? iy : iy - N;
        if ((u === 5 && v === 3) || (u === -5 && v === -3)) continue;
        other = Math.max(other, Math.hypot(re[iy * N + ix]!, im[iy * N + ix]!));
      }
    }
    expect(other).toBeLessThan(peak * 1e-3);
  });

  it('rejects a non-power-of-two size rather than producing wrong numbers', () => {
    expect(() => new WvFft(100)).toThrow(/power of two/);
  });
});

describe('wvHarmonicWeight', () => {
  it('is a bare fundamental at SHAPE 0', () => {
    expect(wvHarmonicWeight(1, 0)).toBe(1);
    for (let n = 2; n <= WV_MAX_HARMONICS; n++) expect(wvHarmonicWeight(n, 0)).toBe(0);
  });

  it('is the saw series at SHAPE 0.5', () => {
    for (let n = 1; n <= WV_MAX_HARMONICS; n++) {
      expect(wvHarmonicWeight(n, 0.5)).toBeCloseTo(1 / n, 6);
    }
  });

  it('drops the even harmonics at SHAPE 1 and keeps the odd ones', () => {
    for (let n = 2; n <= WV_MAX_HARMONICS; n += 2) expect(wvHarmonicWeight(n, 1)).toBeCloseTo(0, 6);
    for (let n = 1; n <= WV_MAX_HARMONICS; n += 2) expect(wvHarmonicWeight(n, 1)).toBeCloseTo(1 / n, 6);
  });

  it('never rescales the fundamental, so SHAPE does not change contrast', () => {
    for (let s = 0; s <= 1.0001; s += 0.1) expect(wvHarmonicWeight(1, s)).toBe(1);
  });
});

describe('wvPeakSalience', () => {
  it('is bare amplitude with no lattice', () => {
    expect(wvPeakSalience(4, 0, 0.25, 0, 0, 0, 1)).toBeCloseTo(0.25, 9);
  });

  it('bonuses a peak sitting on the comb, and by less for higher harmonics', () => {
    const first = wvPeakSalience(4, 0, 0.25, 4, 0, 2.4, 1);
    const third = wvPeakSalience(12, 0, 0.25, 4, 0, 2.4, 1);
    expect(first).toBeGreaterThan(0.25);
    expect(third).toBeGreaterThan(0.25);
    expect(third).toBeLessThan(first);
  });

  it('gives no bonus off the comb — including at the same |k|, wrong angle', () => {
    // Same radius as 2·k0 but rotated 90°: a radius-only test would pass this
    // wrongly, so this is the leg that proves the comb is a VECTOR comb.
    expect(wvPeakSalience(0, 8, 0.25, 4, 0, 2.4, 1)).toBeCloseTo(0.25, 9);
  });

  it('is gated off by LOCK 0 and by low confidence', () => {
    expect(wvPeakSalience(4, 0, 0.25, 4, 0, 2.4, 0)).toBeCloseTo(0.25, 9);
    expect(wvPeakSalience(4, 0, 0.25, 4, 0, 0.5, 1)).toBeCloseTo(0.25, 9);
  });
});

describe('WarrensVisionsEngine — analysis', () => {
  it('recovers a grating\'s wavevector and contrast', () => {
    const eng = new WarrensVisionsEngine();
    eng.setComponents(8);
    eng.setStabilityFrames(1);
    eng.setLock(0);
    settle(eng, grating(6, 4, 0.3), 40);
    const comps = eng.snapshot();
    expect(comps.length).toBeGreaterThan(0);
    const top = comps.reduce((a, b) => (b.amp > a.amp ? b : a));
    expect(top.kx).toBeCloseTo(6, 0);
    expect(top.ky).toBeCloseTo(4, 0);
    // Contrast within 15 % — a windowed estimate, not an exact identity.
    expect(top.amp).toBeGreaterThan(0.3 * 0.85);
    expect(top.amp).toBeLessThan(0.3 * 1.15);
  });

  it('recovers the DC level exactly, unaffected by the grating on top of it', () => {
    const eng = new WarrensVisionsEngine();
    eng.setSlewSeconds(0.02);
    settle(eng, grating(6, 4, 0.2, 0, 0.42), 60);
    expect(eng.getDc()).toBeCloseTo(0.42, 3);
    // The negative control: a different pedestal must read differently, so
    // this cannot pass against a hardcoded mid-grey.
    const dim = new WarrensVisionsEngine();
    dim.setSlewSeconds(0.02);
    settle(dim, grating(6, 4, 0.2, 0, 0.17), 60);
    expect(dim.getDc()).toBeCloseTo(0.17, 3);
  });

  it('COMPONENTS caps the bank, and the survivors are the salient ones', () => {
    const eng = new WarrensVisionsEngine();
    eng.setStabilityFrames(1);
    eng.setComponents(12);
    settle(eng, noiseField(3), 8);
    expect(eng.snapshot().length).toBeLessThanOrEqual(12);
    const eng2 = new WarrensVisionsEngine();
    eng2.setStabilityFrames(1);
    eng2.setComponents(WV_MAX_COMPONENTS);
    settle(eng2, noiseField(3), 8);
    expect(eng2.snapshot().length).toBeGreaterThan(12);
  });

  it('FLOOR gates weak peaks out', () => {
    // COMPONENTS is opened to its ceiling so the FLOOR is the only limiter —
    // at the default 64 both settings hit the cap and the gate reads nothing.
    // One strong grating over faint broadband: the FLOOR is RELATIVE to the
    // loudest component, so this is a field with a real dynamic range to
    // threshold against. Uniform noise has none — every bin sits within a
    // dozen dB of the peak and both settings hit the bank ceiling.
    const faint = noiseField(11);
    const field = new Float32Array(N * N);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        field[y * N + x] =
          0.5 + 0.4 * Math.cos((2 * Math.PI * (7 * x + 3 * y)) / N) + 0.01 * (faint[y * N + x]! - 0.5);
      }
    }
    const at = (db: number) => {
      const eng = new WarrensVisionsEngine();
      eng.setStabilityFrames(1);
      eng.setComponents(WV_MAX_COMPONENTS);
      eng.setFloorDb(db);
      settle(eng, field, 8);
      return eng.snapshot().length;
    };
    expect(at(-20)).toBeLessThan(at(-90));
    expect(at(-20)).toBeGreaterThan(0);
  });

  it('STABILITY holds a new component down until it has survived N commits', () => {
    // AC energy of the reconstruction after exactly `commits` commits, at two
    // STABILITY settings. Contrast slew is taken out of the picture (SLEW at
    // its floor) so what is left is the stability ramp alone.
    const acAfter = (stability: number, commits: number) => {
      const eng = new WarrensVisionsEngine();
      eng.setComponents(8);
      eng.setStabilityFrames(stability);
      eng.setSlewSeconds(WV_SLEW_MIN_S);
      eng.setResidual(0);
      const field = grating(6, 4, 0.3);
      for (let i = 0; i < commits; i++) {
        eng.analyze(field);
        eng.advance(1 / 60);
      }
      const out = new Float32Array(N * N);
      eng.synthesize(out);
      const dc = eng.getDc();
      let ac = 0;
      for (let i = 0; i < out.length; i++) ac += (out[i]! - dc) ** 2;
      return Math.sqrt(ac / out.length);
    };
    // At 2 commits, STABILITY 8 has ramped 2/8 while STABILITY 1 is fully in.
    const slow = acAfter(8, 2);
    const fast = acAfter(1, 2);
    expect(slow).toBeGreaterThan(0);
    expect(slow).toBeLessThan(fast * 0.45);
    // …and by 20 commits the slow one has caught up.
    expect(acAfter(8, 20)).toBeGreaterThan(acAfter(1, 20) * 0.9);
  });

  it('FREEZE is the caller not committing — the bank keeps its components', () => {
    const eng = new WarrensVisionsEngine();
    eng.setStabilityFrames(1);
    eng.setComponents(16);
    settle(eng, grating(6, 4, 0.3), 20);
    const before = eng.snapshot().length;
    const committedBefore = eng.getCommittedFrames();
    for (let i = 0; i < 30; i++) eng.advance(1 / 60);
    expect(eng.getCommittedFrames()).toBe(committedBefore);
    expect(eng.snapshot().length).toBe(before);
  });

  it('tracks a moving wavevector as ONE component rather than reborn ones', () => {
    const eng = new WarrensVisionsEngine();
    eng.setComponents(6);
    eng.setStabilityFrames(1);
    eng.setLock(0);
    // 20 → 21 cycles is a 5 % step, inside the match tolerance.
    settle(eng, grating(20, 0, 0.3), 12);
    const aliveBefore = eng.snapshot()[0]?.framesAlive ?? 0;
    settle(eng, grating(21, 0, 0.3), 12);
    const after = eng.snapshot();
    const top = after.reduce((a, b) => (b.amp > a.amp ? b : a));
    expect(top.kx).toBeCloseTo(21, 0);
    expect(top.framesAlive).toBeGreaterThan(aliveBefore);
  });
});

describe('WarrensVisionsEngine — COHERENCE', () => {
  // The module's whole claim. Each leg is paired with its opposite so a
  // servo that did nothing, and a servo that was always on, both go red.

  const source = grating(9, 5, 0.35, 1.1);

  function reconstruct(coherence: number, commits: number): Float32Array {
    const eng = new WarrensVisionsEngine();
    eng.setComponents(32);
    eng.setStabilityFrames(1);
    eng.setLock(0);
    eng.setResidual(0);
    eng.setSlewSeconds(0.02);
    eng.setCoherence(coherence);
    settle(eng, source, commits);
    const out = new Float32Array(N * N);
    eng.synthesize(out);
    return out;
  }

  it('COHERENCE 1 reconstructs the source — structure, position and all', () => {
    const out = reconstruct(1, 40);
    expect(correlation(out, source)).toBeGreaterThan(0.9);
  });

  it('COHERENCE 0 keeps the source\'s SPECTRUM but loses its POSITION', () => {
    // Birth phase is the measured phase, so a static source that never moves
    // would look identical at 0 — the interesting statement is what happens
    // when the source's phase MOVES underneath a free-running bank.
    const eng = new WarrensVisionsEngine();
    eng.setComponents(32);
    eng.setStabilityFrames(1);
    eng.setLock(0);
    eng.setResidual(0);
    eng.setSlewSeconds(0.02);
    eng.setCoherence(0);
    settle(eng, grating(9, 5, 0.35, 0), 30);
    // Now shift the grating by half a period: the picture moved, the
    // magnitudes did not.
    const shifted = grating(9, 5, 0.35, Math.PI);
    settle(eng, shifted, 30);
    const out = new Float32Array(N * N);
    eng.synthesize(out);
    // Free-running: it still shows the ORIGINAL position, i.e. it is now
    // anti-correlated with the source it is being fed.
    expect(correlation(out, shifted)).toBeLessThan(-0.5);
  });

  it('COHERENCE 1 FOLLOWS that same shift — the negative control for the above', () => {
    const eng = new WarrensVisionsEngine();
    eng.setComponents(32);
    eng.setStabilityFrames(1);
    eng.setLock(0);
    eng.setResidual(0);
    eng.setSlewSeconds(0.02);
    eng.setCoherence(1);
    settle(eng, grating(9, 5, 0.35, 0), 30);
    const shifted = grating(9, 5, 0.35, Math.PI);
    settle(eng, shifted, 30);
    const out = new Float32Array(N * N);
    eng.synthesize(out);
    expect(correlation(out, shifted)).toBeGreaterThan(0.9);
  });

  it('is MONOTONIC in between — more coherence, more of the source', () => {
    const shifted = grating(9, 5, 0.35, Math.PI);
    const corrAt = (c: number) => {
      const eng = new WarrensVisionsEngine();
      eng.setComponents(32);
      eng.setStabilityFrames(1);
      eng.setLock(0);
      eng.setResidual(0);
      eng.setSlewSeconds(0.02);
      eng.setCoherence(c);
      settle(eng, grating(9, 5, 0.35, 0), 30);
      settle(eng, shifted, 6);
      const out = new Float32Array(N * N);
      eng.synthesize(out);
      return correlation(out, shifted);
    };
    const c0 = corrAt(0);
    const c3 = corrAt(0.3);
    const c7 = corrAt(0.7);
    const c1 = corrAt(1);
    expect(c3).toBeGreaterThan(c0);
    expect(c7).toBeGreaterThan(c3);
    expect(c1).toBeGreaterThan(c7);
  });

  it('reconstructs a BROADBAND field, not just a single grating', () => {
    const eng = new WarrensVisionsEngine();
    eng.setComponents(WV_MAX_COMPONENTS);
    eng.setStabilityFrames(1);
    eng.setLock(0);
    eng.setResidual(0);
    eng.setSlewSeconds(0.02);
    eng.setCoherence(1);
    // A smooth blobby field — the sparse bank can actually represent this,
    // where white noise is by construction unrepresentable in 256 taps.
    const field = new Float32Array(N * N);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        field[y * N + x] =
          0.5 +
          0.2 * Math.sin((2 * Math.PI * 3 * x) / N) * Math.cos((2 * Math.PI * 2 * y) / N) +
          0.12 * Math.sin((2 * Math.PI * (5 * x + 7 * y)) / N + 0.7) +
          0.08 * Math.cos((2 * Math.PI * (11 * x - 4 * y)) / N);
      }
    }
    settle(eng, field, 40);
    const out = new Float32Array(N * N);
    eng.synthesize(out);
    expect(correlation(out, field)).toBeGreaterThan(0.9);
  });
});

describe('WarrensVisionsEngine — synthesis controls', () => {
  it('SHAPE adds harmonics of the component and SHAPE 0 does not', () => {
    const mk = (shape: number) => {
      const eng = new WarrensVisionsEngine();
      eng.setComponents(4);
      eng.setStabilityFrames(1);
      eng.setLock(0);
      eng.setResidual(0);
      eng.setSlewSeconds(0.02);
      eng.setShape(shape);
      settle(eng, grating(5, 0, 0.3), 30);
      const out = new Float32Array(N * N);
      eng.synthesize(out);
      // Measure the 2nd harmonic (k = 10) of the reconstruction.
      const fft = new WvFft(N);
      const re = Float32Array.from(out);
      const im = new Float32Array(N * N);
      wvFft2d(fft, re, im, N, false);
      const at = (u: number) => Math.hypot(re[((u % N) + N) % N]!, im[((u % N) + N) % N]!);
      return { h1: at(5), h2: at(10), h3: at(15) };
    };
    const sine = mk(0);
    const saw = mk(0.5);
    const square = mk(1);
    expect(sine.h2 / sine.h1).toBeLessThan(1e-3);
    expect(saw.h2 / saw.h1).toBeGreaterThan(0.3);
    // A square has no even harmonics but keeps the odd ones.
    expect(square.h2 / square.h1).toBeLessThan(0.05);
    expect(square.h3 / square.h1).toBeGreaterThan(0.2);
  });

  it('CENTER transposes every wavevector by the same ratio', () => {
    const eng = new WarrensVisionsEngine();
    eng.setComponents(4);
    eng.setStabilityFrames(1);
    eng.setLock(0);
    eng.setResidual(0);
    eng.setSlewSeconds(0.02);
    settle(eng, grating(6, 0, 0.3), 30);
    const out = new Float32Array(N * N);
    const dominant = () => {
      const fft = new WvFft(N);
      const re = Float32Array.from(out);
      const im = new Float32Array(N * N);
      wvFft2d(fft, re, im, N, false);
      let best = 0;
      let bestU = 0;
      for (let u = 1; u < N / 2; u++) {
        const m = Math.hypot(re[u]!, im[u]!);
        if (m > best) {
          best = m;
          bestU = u;
        }
      }
      return bestU;
    };
    eng.setCenterCents(0);
    eng.synthesize(out);
    expect(dominant()).toBe(6);
    eng.setCenterCents(1200); // one octave up = twice the spatial frequency
    eng.synthesize(out);
    expect(dominant()).toBe(12);
    eng.setCenterCents(-1200);
    eng.synthesize(out);
    expect(dominant()).toBe(3);
  });

  it('bandlimits rather than aliasing when CENTER pushes past the grid', () => {
    const eng = new WarrensVisionsEngine();
    eng.setComponents(8);
    eng.setStabilityFrames(1);
    eng.setResidual(0);
    eng.setSlewSeconds(0.02);
    settle(eng, grating(40, 0, 0.3), 30);
    const out = new Float32Array(N * N);
    eng.setCenterCents(0);
    eng.synthesize(out);
    const dc0 = eng.getDc();
    let ac0 = 0;
    for (let i = 0; i < out.length; i++) ac0 += (out[i]! - dc0) ** 2;
    eng.setCenterCents(3600); // ×8 → 320 cycles, far past the 64-cycle limit
    eng.synthesize(out);
    let ac1 = 0;
    for (let i = 0; i < out.length; i++) ac1 += (out[i]! - dc0) ** 2;
    // Everything is gone, and nothing folded back as a low-frequency ghost.
    expect(Math.sqrt(ac1 / out.length)).toBeLessThan(Math.sqrt(ac0 / out.length) * 0.02);
  });

  it('DRIFT moves the picture and DRIFT 0 does not', () => {
    const mk = (drift: number) => {
      const eng = new WarrensVisionsEngine();
      eng.setComponents(16);
      eng.setStabilityFrames(1);
      eng.setLock(0);
      eng.setResidual(0);
      eng.setSlewSeconds(0.02);
      eng.setCoherence(0);
      eng.setDrift(drift);
      settle(eng, grating(9, 5, 0.35), 30);
      const a = new Float32Array(N * N);
      eng.synthesize(a);
      for (let i = 0; i < 20; i++) eng.advance(1 / 60);
      const b = new Float32Array(N * N);
      eng.synthesize(b);
      return correlation(a, b);
    };
    expect(mk(0)).toBeGreaterThan(0.999);
    expect(mk(1)).toBeLessThan(0.9);
  });

  it('RESIDUAL rings carry the energy the components did NOT claim', () => {
    const eng = new WarrensVisionsEngine();
    eng.setComponents(4);
    eng.setStabilityFrames(1);
    eng.setResidual(1);
    settle(eng, noiseField(23), 20);
    const gains = new Float32Array(WV_RESIDUAL_RINGS);
    eng.residualGains(gains);
    let total = 0;
    for (const g of gains) total += g;
    expect(total).toBeGreaterThan(0);

    // A pure grating leaves almost nothing unclaimed.
    const clean = new WarrensVisionsEngine();
    clean.setComponents(16);
    clean.setStabilityFrames(1);
    clean.setResidual(1);
    settle(clean, grating(9, 5, 0.35), 20);
    const cleanGains = new Float32Array(WV_RESIDUAL_RINGS);
    clean.residualGains(cleanGains);
    let cleanTotal = 0;
    for (const g of cleanGains) cleanTotal += g;
    expect(cleanTotal).toBeLessThan(total * 0.25);
  });

  it('RESIDUAL puts texture into the SYNTHESISED PLANE, not just into a gain array', () => {
    // The gain array is introspection; the plane is the product. A residual
    // that only moved `residualGains` and never reached a pixel would pass
    // the ring tests above and fail this one.
    const plane = (residual: number) => {
      const eng = new WarrensVisionsEngine();
      eng.setComponents(4);
      eng.setStabilityFrames(1);
      eng.setSlewSeconds(WV_SLEW_MIN_S);
      eng.setResidual(residual);
      settle(eng, noiseField(23), 25);
      const out = new Float32Array(N * N);
      eng.synthesize(out);
      const dc = eng.getDc();
      let ac = 0;
      for (let i = 0; i < out.length; i++) ac += (out[i]! - dc) ** 2;
      return { out, ac: Math.sqrt(ac / out.length) };
    };
    const off = plane(0);
    const on = plane(1);
    expect(on.ac).toBeGreaterThan(off.ac * 1.5);
    // …and it is genuinely different pixels, not a uniform brightening.
    expect(correlation(on.out, off.out)).toBeLessThan(0.95);
    // The plane stays real and finite — a broken conjugate write shows up
    // here as NaN or as an imaginary component leaking into the output.
    for (let i = 0; i < on.out.length; i += 331) expect(Number.isFinite(on.out[i]!)).toBe(true);
  });

  it('the residual is DETERMINISTIC across engines and moves under DRIFT', () => {
    const mk = (drift: number) => {
      const eng = new WarrensVisionsEngine();
      eng.setComponents(4);
      eng.setStabilityFrames(1);
      eng.setSlewSeconds(WV_SLEW_MIN_S);
      eng.setResidual(1);
      eng.setDrift(drift);
      settle(eng, noiseField(23), 25);
      const a = new Float32Array(N * N);
      eng.synthesize(a);
      for (let i = 0; i < 15; i++) eng.advance(1 / 60);
      const b = new Float32Array(N * N);
      eng.synthesize(b);
      return { a, b };
    };
    const one = mk(0);
    const two = mk(0);
    expect(Array.from(one.a)).toEqual(Array.from(two.a));
    expect(correlation(one.a, one.b)).toBeGreaterThan(0.999);
    const moving = mk(1);
    expect(correlation(moving.a, moving.b)).toBeLessThan(0.95);
  });

  it('RESIDUAL 0 silences the rings entirely', () => {
    const eng = new WarrensVisionsEngine();
    eng.setStabilityFrames(1);
    eng.setResidual(0);
    settle(eng, noiseField(23), 20);
    const gains = new Float32Array(WV_RESIDUAL_RINGS);
    eng.residualGains(gains);
    for (const g of gains) expect(g).toBe(0);
  });
});

describe('WarrensVisionsEngine — lattice LOCK', () => {
  it('detects the fundamental of a periodic field with confidence', () => {
    const eng = new WarrensVisionsEngine();
    eng.setStabilityFrames(1);
    // A square-wave-ish grating: energy at k0 and its harmonics.
    const field = new Float32Array(N * N);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        let v = 0.5;
        for (let h = 1; h <= 5; h += 2) v += (0.25 / h) * Math.sin((2 * Math.PI * h * 4 * x) / N);
        field[y * N + x] = v;
      }
    }
    settle(eng, field, 30);
    const f = eng.getLatticeFundamental();
    expect(Math.hypot(f.kx, f.ky)).toBeCloseTo(4, 0);
    expect(f.confidence).toBeGreaterThan(1.4);
  });

  it('stays disengaged on a field with no periodic structure', () => {
    const eng = new WarrensVisionsEngine();
    eng.setStabilityFrames(1);
    settle(eng, noiseField(97), 30);
    // Either no fundamental at all, or one the confidence gate holds off.
    const f = eng.getLatticeFundamental();
    const confNorm = Math.max(0, Math.min(1, (f.confidence - 1.3) / 1.1));
    expect(confNorm).toBeLessThan(0.5);
  });

  it('snaps an off-lattice component toward the comb, and LOCK 0 does not', () => {
    const build = (lock: number) => {
      const eng = new WarrensVisionsEngine();
      eng.setStabilityFrames(1);
      eng.setComponents(24);
      eng.setLock(lock);
      const field = new Float32Array(N * N);
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          let v = 0.5;
          // fundamental at 5, harmonics at 10/15/20, plus one detuned partial
          // at 30.4 that LOCK should pull toward 30.
          for (let h = 1; h <= 4; h++) v += (0.2 / h) * Math.sin((2 * Math.PI * h * 5 * x) / N);
          v += 0.08 * Math.sin((2 * Math.PI * 30.4 * x) / N);
          field[y * N + x] = v;
        }
      }
      settle(eng, field, 30);
      const comps = eng.snapshot().filter((c) => Math.abs(c.ky) < 0.5 && c.kx > 28 && c.kx < 33);
      return comps.length ? comps.reduce((a, b) => (b.amp > a.amp ? b : a)).kx : NaN;
    };
    const free = build(0);
    const locked = build(1);
    expect(Number.isFinite(free)).toBe(true);
    expect(Number.isFinite(locked)).toBe(true);
    expect(Math.abs(locked - 30)).toBeLessThan(Math.abs(free - 30));
  });
});

describe('WarrensVisionsEngine — determinism and allocation discipline', () => {
  it('two engines fed the same input produce byte-identical planes', () => {
    const a = new WarrensVisionsEngine();
    const b = new WarrensVisionsEngine();
    for (const e of [a, b]) {
      e.setComponents(64);
      e.setStabilityFrames(2);
      e.setDrift(0.5);
      e.setShape(0.7);
    }
    const field = noiseField(5);
    settle(a, field, 25);
    settle(b, field, 25);
    const oa = new Float32Array(N * N);
    const ob = new Float32Array(N * N);
    a.synthesize(oa);
    b.synthesize(ob);
    expect(Array.from(oa)).toEqual(Array.from(ob));
  });

  it('reset() returns a driven engine to its birth state', () => {
    const eng = new WarrensVisionsEngine();
    eng.setStabilityFrames(1);
    settle(eng, noiseField(13), 20);
    expect(eng.snapshot().length).toBeGreaterThan(0);
    eng.reset();
    expect(eng.snapshot()).toEqual([]);
    expect(eng.getCommittedFrames()).toBe(0);
    expect(eng.getDc()).toBe(0);
  });

  it('clamps every control to its declared range', () => {
    const eng = new WarrensVisionsEngine();
    eng.setComponents(9999);
    eng.setStabilityFrames(-5);
    settle(eng, grating(4, 4, 0.3), 4);
    expect(eng.snapshot().length).toBeLessThanOrEqual(WV_MAX_COMPONENTS);
    // A NaN control must not poison the plane.
    eng.setShape(NaN);
    eng.setCoherence(NaN);
    const out = new Float32Array(N * N);
    eng.synthesize(out);
    for (let i = 0; i < out.length; i += 997) expect(Number.isFinite(out[i]!)).toBe(true);
  });
});
