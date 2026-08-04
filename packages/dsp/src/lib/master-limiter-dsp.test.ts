// packages/dsp/src/lib/master-limiter-dsp.test.ts
//
// Unit gate for the master limiter core — the terminal safety stage that
// replaced audio-out's full-band DynamicsCompressorNode (DSP audit P0-A1).
// The system-level proof (no sub pumping in the REAL shipped chain, with the
// old topology as a standing negative control) lives in
// art/scenarios/audio-out/master-limiter-sub-pump.test.ts. THIS file pins the
// core's four contractual guarantees, which that one cannot state as sharply:
//
//   1. Below the ceiling it is the IDENTITY — bit-exact, not "close to unity".
//      This is the whole reason a normally levelled mix cannot be ducked.
//   2. Above the ceiling the output is BOUNDED, for any input and any config.
//   3. The gain is STEREO-LINKED (one gain across L/R, so the image holds).
//   4. Latency is exactly the look-ahead, and nothing else.

import { describe, expect, it } from 'vitest';
import {
  MASTER_CEILING,
  MASTER_LOOKAHEAD_S,
  MASTER_RELEASE_S,
  makeMasterLimiterState,
  masterLimiterReset,
  masterLimiterStepStereo,
  type MasterLimiterState,
} from './master-limiter-dsp';

const SR = 48_000;

/** Deterministic pseudo-noise — a fixed 32-bit LCG, so every run is identical. */
function noise(n: number, amp: number): Float32Array {
  const out = new Float32Array(n);
  let s = 0x2f6e2b1 >>> 0;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out[i] = ((s / 0xffffffff) * 2 - 1) * amp;
  }
  return out;
}

function tone(n: number, hz: number, amp: number, sr = SR): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * hz * i) / sr);
  return out;
}

interface RunResult {
  left: Float32Array;
  right: Float32Array;
  gain: Float32Array;
}

function run(
  l: Float32Array,
  r: Float32Array,
  st: MasterLimiterState,
  sabotage?: (st: MasterLimiterState) => void,
): RunResult {
  const f = new Float32Array(2);
  const res: RunResult = {
    left: new Float32Array(l.length),
    right: new Float32Array(l.length),
    gain: new Float32Array(l.length),
  };
  for (let i = 0; i < l.length; i++) {
    res.gain[i] = masterLimiterStepStereo(l[i]!, r[i]!, st, f);
    res.left[i] = f[0]!;
    res.right[i] = f[1]!;
    sabotage?.(st);
  }
  return res;
}

function peak(x: Float32Array, from = 0): number {
  let p = 0;
  for (let i = from; i < x.length; i++) p = Math.max(p, Math.abs(x[i]!));
  return p;
}

describe('master limiter core', () => {
  it('is the exact IDENTITY below the ceiling, delayed by the look-ahead', () => {
    // 0.85 < the −1 dBFS ceiling (0.8913). Not "approximately unity" — a limiter
    // that colours a mix it is not supposed to touch is the A1 defect.
    const sig = tone(SR, 40, 0.85);
    const st = makeMasterLimiterState(SR);
    const { left, gain } = run(sig, sig, st);
    const d = st.delaySamples;
    expect(d, 'look-ahead in samples').toBe(Math.round(MASTER_LOOKAHEAD_S * SR));

    let worst = 0;
    for (let i = d; i < sig.length; i++) worst = Math.max(worst, Math.abs(left[i]! - sig[i - d]!));
    expect(worst, `largest deviation from the delayed input: ${worst}`).toBe(0);
    for (let i = 0; i < gain.length; i++) expect(gain[i]).toBe(1);
  });

  it('bounds the output at the ceiling for any input, sample rate or config', () => {
    // The no-overshoot argument in the core's header is structural; this is its
    // empirical restatement across the axes it claims independence from.
    for (const sr of [44_100, 48_000, 96_000]) {
      for (const cfg of [
        {},
        { lookaheadS: 0.0005 },
        { lookaheadS: 0.01 },
        { releaseS: 0.01 },
        { releaseS: 8 },
      ]) {
        for (const amp of [1.0, 3.0, 20.0]) {
          const st = makeMasterLimiterState(sr, cfg);
          // Noise (worst-case sample-to-sample jumps) plus a bass tone, so both
          // the transient and the sustained path are exercised.
          const n = Math.round(sr * 0.4);
          const a = noise(n, amp);
          const b = tone(n, 50, amp, sr);
          for (let i = 0; i < n; i++) a[i] = a[i]! + b[i]!;
          const { left, right } = run(a, a, st);
          const p = Math.max(peak(left), peak(right));
          expect(
            p,
            `sr=${sr} cfg=${JSON.stringify(cfg)} amp=${amp} → out peak ${p.toFixed(6)}`,
          ).toBeLessThanOrEqual(MASTER_CEILING);
        }
      }
    }
  });

  it('does not overshoot on a hard step into the ceiling (the look-ahead is doing its job)', () => {
    // A naive feed-forward limiter lets the first few ms through at full level.
    const n = SR;
    const sig = new Float32Array(n);
    for (let i = 0; i < n; i++) sig[i] = i < SR / 2 ? 0 : 4 * Math.sin((2 * Math.PI * 200 * i) / SR);
    const { left } = run(sig, sig, makeMasterLimiterState(SR));
    expect(peak(left), `step-in peak ${peak(left).toFixed(6)}`).toBeLessThanOrEqual(MASTER_CEILING);
  });

  it('[negative control on the ceiling CLAMP] the clamp alone holds the ceiling', () => {
    // The clamp in the core is defence-in-depth: given a coherent state the
    // gain computation already guarantees the bound, so nothing would notice
    // if the clamp were deleted. Sabotage the gain computation — force the
    // envelope and its moving average back to unity after every sample, so the
    // applied gain is 1 — and the clamp is the only thing left.
    const sig = tone(SR / 4, 60, 3.0);
    const st = makeMasterLimiterState(SR);
    const { left } = run(sig, sig, st, (s) => {
      s.env = 1;
      s.ma.fill(1);
      s.maSum = s.ma.length;
    });
    const p = peak(left);
    // Exactly AT the ceiling proves the sabotage was real (a working gain
    // computation would have landed under it) and the clamp caught it.
    expect(p, `sabotaged run peaked at ${p.toFixed(6)}`).toBeCloseTo(MASTER_CEILING, 6);
  });

  it('is STEREO-LINKED: a peak in ONE channel attenuates BOTH', () => {
    // Deliberate, and NOT the defect A1 names — an unlinked stereo limiter
    // wanders the image on every peak. Pin it so nobody "fixes" it later.
    const n = SR / 2;
    const quietL = tone(n, 40, 0.3);
    const loudR = tone(n, 200, 4.0);
    const st = makeMasterLimiterState(SR);
    const { left, gain } = run(quietL, loudR, st);
    const d = st.delaySamples;
    // The left channel never came near the ceiling on its own, yet it is
    // attenuated in step with the right.
    const settled = Math.round(0.2 * SR);
    expect(gain[settled], `linked gain ${gain[settled]}`).toBeLessThan(0.5);
    let worst = 0;
    for (let i = settled; i < n; i++) {
      worst = Math.max(worst, Math.abs(left[i]! - quietL[i - d]! * gain[i]!));
    }
    expect(worst, 'left is exactly the delayed input times the LINKED gain').toBeLessThan(1e-6);
  });

  it('recovers monotonically after an isolated peak, on the release time constant', () => {
    // 0.2 s of loud, then quiet. The gain must climb back — smoothly, and not
    // so fast that it would breathe at a musical strike rate (see the core's
    // measured release table).
    const n = SR * 9;
    const sig = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      sig[i] = 0.3 * Math.sin(2 * Math.PI * 40 * t) + (t < 0.2 ? 3 * Math.sin(2 * Math.PI * 220 * t) : 0);
    }
    const { gain } = run(sig, sig, makeMasterLimiterState(SR));
    const at = (s: number) => gain[Math.round(s * SR)]!;
    const db = (s: number) => 20 * Math.log10(at(s));
    expect(at(0.1), 'engaged during the burst').toBeLessThan(0.4);
    // Monotone recovery — a smooth swell, never a step.
    for (let s = 0.25; s < 8.5; s += 0.05) {
      expect(at(s + 0.05), `gain at ${(s + 0.05).toFixed(2)}s vs ${s.toFixed(2)}s`)
        .toBeGreaterThanOrEqual(at(s) - 1e-9);
    }
    // The COST of the long release, pinned as a number rather than left vague:
    // one time constant on it is still ~2.6 dB down, and it takes ~4 s to come
    // back within 1 dB. That is the deliberate trade — see the core's header.
    expect(at(0.2 + MASTER_RELEASE_S), 'one time constant after the burst').toBeLessThan(0.95);
    expect(db(2.9), `2.7 s after the burst: ${db(2.9).toFixed(2)} dB`).toBeLessThan(-0.9);
    expect(db(4.5), `4.3 s after the burst: ${db(4.5).toFixed(2)} dB`).toBeGreaterThan(-0.7);
    expect(at(8.8), 'fully recovered by the end').toBeGreaterThan(0.99);
  });

  it('produces only finite samples, and reset() returns it to the initial state', () => {
    const st = makeMasterLimiterState(SR);
    const hot = noise(SR, 6);
    const a = run(hot, hot, st);
    expect(a.left.every(Number.isFinite), 'all output samples finite').toBe(true);
    expect(a.right.every(Number.isFinite)).toBe(true);

    masterLimiterReset(st);
    const b = run(hot, hot, st);
    let worst = 0;
    for (let i = 0; i < hot.length; i++) worst = Math.max(worst, Math.abs(a.left[i]! - b.left[i]!));
    expect(worst, 'a reset limiter reproduces the first run exactly').toBe(0);
  });
});
