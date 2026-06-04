// packages/dsp/src/lib/spring-reverb-dsp.test.ts
//
// Pure-DSP unit tests for the in-house spring-reverb tank (MOOG 905). These
// PROVE the model behaves like a spring reverb (decaying, dispersive tail),
// not merely that it runs:
//   • An impulse produces a DECAYING tail: energy exists later in time but
//     trends to zero; a longer `decay` ⇒ a longer tail.
//   • DISPERSION is present: the impulse response is SPREAD OUT over many
//     samples (not a single returned spike) — the spring "chirp".
//   • STABILITY: bounded output, no NaN/Inf, across extreme params
//     (decay=1, size=0 and size=1) over thousands of samples.
//   • Silence in ⇒ silence out once the tail has rung down.

import { describe, it, expect } from 'vitest';
import { SpringReverb, FEEDBACK_MAX } from './spring-reverb-dsp';

const SR = 48000;

/** Render the wet output of an impulse (amplitude 1 at sample 0) for N
 *  samples at the given params. */
function impulseResponse(
  params: { decay: number; size: number },
  n: number,
): Float32Array {
  const sr = new SpringReverb(SR);
  sr.setParams(params);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = sr.step(i === 0 ? 1 : 0);
  return out;
}

/** Energy (sum of squares) of a window. */
function energy(buf: Float32Array, start: number, end = buf.length): number {
  let s = 0;
  for (let i = start; i < end; i++) s += buf[i]! * buf[i]!;
  return s;
}

/** Peak |sample|. */
function peak(buf: Float32Array, start = 0, end = buf.length): number {
  let m = 0;
  for (let i = start; i < end; i++) m = Math.max(m, Math.abs(buf[i]!));
  return m;
}

describe('SpringReverb — decaying tail', () => {
  it('an impulse produces a tail with energy AFTER the impulse', () => {
    const ir = impulseResponse({ decay: 0.7, size: 0.5 }, SR); // 1 s
    // There is real wet energy in the tail beyond the first few ms.
    const tailE = energy(ir, Math.round(0.02 * SR));
    expect(tailE).toBeGreaterThan(1e-4);
  });

  it('the tail DECAYS over time (later windows quieter than earlier ones)', () => {
    const ir = impulseResponse({ decay: 0.7, size: 0.5 }, 2 * SR); // 2 s
    const early = energy(ir, Math.round(0.05 * SR), Math.round(0.25 * SR));
    const late = energy(ir, Math.round(1.0 * SR), Math.round(1.2 * SR));
    expect(early).toBeGreaterThan(0);
    // Monotone-ish decay: the late window is much quieter than the early one.
    expect(late).toBeLessThan(early * 0.5);
  });

  it('the tail eventually rings down to (near) silence', () => {
    const ir = impulseResponse({ decay: 0.7, size: 0.5 }, 6 * SR); // 6 s
    // The last 100 ms should be essentially silent.
    const tailPeak = peak(ir, Math.round(5.9 * SR));
    expect(tailPeak).toBeLessThan(1e-3);
  });

  it('a longer decay param yields a longer tail (more late energy)', () => {
    const N = 3 * SR;
    const shortIr = impulseResponse({ decay: 0.3, size: 0.5 }, N);
    const longIr = impulseResponse({ decay: 0.9, size: 0.5 }, N);
    const win = (b: Float32Array) =>
      energy(b, Math.round(1.0 * SR), Math.round(1.5 * SR));
    // At 1..1.5 s, the high-decay tank still has substantially more energy.
    expect(win(longIr)).toBeGreaterThan(win(shortIr) * 5);
  });
});

describe('SpringReverb — dispersion (the spring chirp)', () => {
  it('spreads an impulse over many samples (not a single returned spike)', () => {
    const ir = impulseResponse({ decay: 0.6, size: 0.5 }, SR);
    // Count how many samples in the first 60 ms carry meaningful energy.
    // A pure single-tap delay would return one (or a few) large spikes; a
    // dispersive all-pass cascade smears that across a broad swath.
    const win = ir.subarray(0, Math.round(0.06 * SR));
    const pk = peak(win);
    expect(pk).toBeGreaterThan(0);
    let significant = 0;
    for (let i = 0; i < win.length; i++) {
      if (Math.abs(win[i]!) > pk * 0.05) significant++;
    }
    // Smearing means hundreds of non-trivial samples, not a handful.
    expect(significant).toBeGreaterThan(50);
  });

  it('the first returned energy is delayed (the tank is not a passthrough)', () => {
    const ir = impulseResponse({ decay: 0.6, size: 0.8 }, SR);
    // The wet path reads from the delay line, so the very first samples are
    // (near) silent until the round-trip + dispersion arrives.
    const immediate = peak(ir, 0, 4);
    const later = peak(ir, Math.round(0.01 * SR), Math.round(0.1 * SR));
    expect(later).toBeGreaterThan(immediate);
  });
});

describe('SpringReverb — stability (no blowup)', () => {
  const EXTREMES: Array<{ decay: number; size: number }> = [
    { decay: 1, size: 0 },
    { decay: 1, size: 1 },
    { decay: 1, size: 0.5 },
    { decay: 0, size: 0 },
    { decay: 0, size: 1 },
  ];

  for (const params of EXTREMES) {
    it(`stays finite + bounded at decay=${params.decay}, size=${params.size} over a sustained drive`, () => {
      const sr = new SpringReverb(SR);
      sr.setParams(params);
      // Drive 3 s of full-scale noise + sine through the tank; assert every
      // output is finite and bounded.
      let lcg = 12345;
      let pk = 0;
      const N = 3 * SR;
      for (let i = 0; i < N; i++) {
        lcg = (lcg * 1103515245 + 12345) & 0x7fffffff;
        const noise = ((lcg >> 8) & 0xff) / 255 - 0.5;
        const x = 0.5 * Math.sin((2 * Math.PI * 220 * i) / SR) + noise;
        const y = sr.step(x);
        expect(Number.isFinite(y)).toBe(true);
        const a = Math.abs(y);
        if (a > pk) pk = a;
      }
      // With feedback clamped < 1 and an in-loop low-pass, the tank cannot
      // run away. A generous ceiling still catches a real blowup.
      expect(pk).toBeLessThan(20);
    });
  }

  it('feedback gain is clamped strictly below 1 even at decay=1', () => {
    expect(FEEDBACK_MAX).toBeLessThan(1);
  });

  it('silence in ⇒ silence out after the tail rings down', () => {
    const sr = new SpringReverb(SR);
    sr.setParams({ decay: 0.8, size: 0.5 });
    // Kick it with an impulse, then feed silence and let it ring down.
    sr.step(1);
    let last = 0;
    for (let i = 0; i < 8 * SR; i++) last = sr.step(0);
    // After 8 s of silence the output is essentially zero.
    expect(Math.abs(last)).toBeLessThan(1e-4);
  });

  it('reset() returns the tank to silence', () => {
    const sr = new SpringReverb(SR);
    sr.setParams({ decay: 0.9, size: 0.6 });
    for (let i = 0; i < 2000; i++) sr.step(Math.sin(i * 0.1));
    sr.reset();
    // Immediately after reset, a single silent step yields exactly 0.
    expect(sr.step(0)).toBe(0);
  });
});

describe('SpringReverb — param scaling sanity', () => {
  it('size changes the round-trip delay (different IR onset/spacing)', () => {
    const small = impulseResponse({ decay: 0.6, size: 0.05 }, Math.round(0.3 * SR));
    const large = impulseResponse({ decay: 0.6, size: 0.95 }, Math.round(0.3 * SR));
    // Find the first sample exceeding a small threshold for each — a longer
    // spring (size↑) has a longer round trip, so its energy onset differs.
    const onset = (b: Float32Array) => {
      const pk = peak(b);
      for (let i = 0; i < b.length; i++) {
        if (Math.abs(b[i]!) > pk * 0.2) return i;
      }
      return b.length;
    };
    // They should not be identical — size genuinely changes the geometry.
    expect(onset(small)).not.toBe(onset(large));
  });

  it('decay=0 gives a short, quickly-collapsing tail', () => {
    const ir = impulseResponse({ decay: 0, size: 0.5 }, SR);
    // With zero feedback the tank passes one dispersed reflection then dies.
    const late = energy(ir, Math.round(0.3 * SR));
    expect(late).toBeLessThan(1e-5);
  });
});
