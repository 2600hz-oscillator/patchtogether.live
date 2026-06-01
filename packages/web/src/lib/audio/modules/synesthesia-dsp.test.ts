// packages/web/src/lib/audio/modules/synesthesia-dsp.test.ts
//
// Pure-math tests for the SYNESTHESIA DSP helpers in
// packages/dsp/src/lib/synesthesia-dsp.ts. This is the deterministic
// band-filtering / envelope / gate proof — no AudioWorklet, no browser.
//
// Lives under web/ (not packages/dsp) because vitest only runs
// `packages/web/src/**/*.test.ts`; the dsp lib is imported via a relative path,
// matching resofilter-dsp.test.ts.

import { describe, it, expect } from 'vitest';
import {
  combinedGain,
  makeBandSplitter,
  EnvFollower,
  GateDetector,
  MeterBallistics,
  renderSynesthesia,
  SYN_NUM_BANDS,
  ENV_FAST_MS,
  ENV_SLOW_MS,
} from '../../../../../dsp/src/lib/synesthesia-dsp';

const SR = 48000;

function sine(freq: number, secs: number, amp = 0.8, sr = SR): Float32Array {
  const n = Math.round(secs * sr);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr);
  return out;
}

/** RMS over the second half of a buffer (skips filter settling). */
function rmsTail(buf: Float32Array): number {
  const start = Math.floor(buf.length / 2);
  let s = 0;
  for (let i = start; i < buf.length; i++) s += buf[i]! * buf[i]!;
  return Math.sqrt(s / (buf.length - start));
}

function bandRmsForTone(freq: number): number[] {
  const { audio } = renderSynesthesia(sine(freq, 0.3), { sr: SR });
  return audio.map(rmsTail);
}

describe('synesthesia-dsp — combinedGain (master floor + band)', () => {
  it('master raises/lowers the floor; band adds on top; clamps at 0', () => {
    expect(combinedGain(1.0, 1.0)).toBeCloseTo(1.0); // unity master, min band
    expect(combinedGain(1.0, 2.0)).toBeCloseTo(2.0); // unity master, max band
    expect(combinedGain(0.5, 1.0)).toBeCloseTo(0.5); // floor down
    expect(combinedGain(1.5, 1.0)).toBeCloseTo(1.5); // floor up
    expect(combinedGain(1.5, 2.0)).toBeCloseTo(2.5); // both maxed
    expect(combinedGain(0.5, 2.0)).toBeCloseTo(1.5);
    expect(combinedGain(0.5, 0.0)).toBe(0); // clamp
  });
});

describe('synesthesia-dsp — band split maps each test tone to its band', () => {
  // 65→b1(0-200), 261→b2(200-500), 1061→b3(500-2000), 2093→b4(2000+)
  const cases: Array<[number, number]> = [
    [65, 0],
    [261, 1],
    [1061, 2],
    [2093, 3],
  ];
  for (const [freq, target] of cases) {
    it(`${freq} Hz dominates band ${target + 1}`, () => {
      const rms = bandRmsForTone(freq);
      const sorted = [...rms].sort((a, b) => b - a);
      // target band is the strict argmax — i.e. the tone maps to its band.
      expect(rms[target]).toBe(sorted[0]);
      // and clearly wins, not a tie. 2093 Hz sits ON the 2000 Hz crossover, so
      // it legitimately bleeds into band 3 — band 4 still leads by ~1.2×; the
      // mid-band isolation test below proves the slopes are steep off-edge.
      expect(rms[target]!).toBeGreaterThan(1.1 * (sorted[1] as number));
    });
  }

  it('mid-band tones are strongly isolated (≥ 12 dB above neighbours)', () => {
    for (const [freq, target] of [[100, 0], [1000, 2]] as Array<[number, number]>) {
      const rms = bandRmsForTone(freq);
      const others = rms.filter((_, i) => i !== target);
      // 12 dB ≈ 4× in amplitude
      expect(rms[target]!).toBeGreaterThan(4 * Math.max(...others));
    }
  });
});

describe('synesthesia-dsp — two tones light the correct bands', () => {
  it('130 Hz + 2093 Hz energize bands 1 and 4, not 2 and 3', () => {
    const a = sine(130, 0.3, 0.5);
    const b = sine(2093, 0.3, 0.5);
    const mix = new Float32Array(a.length);
    for (let i = 0; i < a.length; i++) mix[i] = a[i]! + b[i]!;
    const rms = renderSynesthesia(mix, { sr: SR }).audio.map(rmsTail);
    // The two most-energized bands must be exactly band 1 and band 4.
    const top2 = rms
      .map((v, i) => [v, i] as [number, number])
      .sort((a, b) => b[0] - a[0])
      .slice(0, 2)
      .map((x) => x[1])
      .sort((a, b) => a - b);
    // (top2 == {0,3} already means both band 1 and band 4 strictly exceed
    // bands 2 and 3 — the meaningful "correct bands triggered" claim.)
    expect(top2).toEqual([0, 3]);
  });
});

describe('synesthesia-dsp — envelope followers', () => {
  it('fast follower decays to ~1/e after 50 ms; slow stays high', () => {
    const fast = new EnvFollower(SR, ENV_FAST_MS);
    const slow = new EnvFollower(SR, ENV_SLOW_MS);
    // Charge both to 1.0.
    for (let i = 0; i < SR * 0.1; i++) { fast.step(1); slow.step(1); }
    // Then 50 ms of silence.
    let ef = 0, es = 0;
    for (let i = 0; i < SR * (ENV_FAST_MS / 1000); i++) { ef = fast.step(0); es = slow.step(0); }
    expect(ef).toBeGreaterThan(0.30);
    expect(ef).toBeLessThan(0.45); // ~e^-1 = 0.368
    expect(es).toBeGreaterThan(0.85); // slow barely moved in 50 ms
  });

  it('slow follower decays to ~1/e after 500 ms', () => {
    const slow = new EnvFollower(SR, ENV_SLOW_MS);
    for (let i = 0; i < SR * 0.1; i++) slow.step(1);
    let es = 0;
    for (let i = 0; i < SR * (ENV_SLOW_MS / 1000); i++) es = slow.step(0);
    expect(es).toBeGreaterThan(0.30);
    expect(es).toBeLessThan(0.45);
  });
});

describe('synesthesia-dsp — gate detector (hysteresis)', () => {
  it('fires above thrHigh, releases below thrLow, holds in the dead-band', () => {
    const g = new GateDetector(0.05, 0.02);
    expect(g.step(0.01)).toBe(0);
    expect(g.step(0.06)).toBe(1); // crosses high
    expect(g.step(0.03)).toBe(1); // in dead-band — holds high
    expect(g.step(0.01)).toBe(0); // below low — releases
  });

  it('end-to-end: a band burst opens then closes the gate', () => {
    // 80 ms tone in band 1, then 800 ms silence.
    const tone = sine(65, 0.08, 0.8);
    const sil = new Float32Array(Math.round(0.8 * SR));
    const buf = new Float32Array(tone.length + sil.length);
    buf.set(tone, 0);
    const { gate } = renderSynesthesia(buf, { sr: SR });
    const g1 = gate[0]!;
    expect(Math.max(...g1.subarray(0, tone.length))).toBe(1); // opened during tone
    expect(g1[g1.length - 1]).toBe(0); // closed by the end
  });
});

describe('synesthesia-dsp — meter ballistics', () => {
  it('rises toward the signal level and stays within 0..1', () => {
    const m = new MeterBallistics(SR);
    let v = 0;
    for (let i = 0; i < SR * 0.2; i++) v = m.step(0.7);
    expect(v).toBeGreaterThan(0.6);
    expect(v).toBeLessThanOrEqual(1);
  });
});

describe('synesthesia-dsp — render shape', () => {
  it('returns 4 bands per output stream', () => {
    const r = renderSynesthesia(sine(440, 0.02), { sr: SR });
    for (const stream of [r.audio, r.envSlow, r.envFast, r.gate, r.level]) {
      expect(stream).toHaveLength(SYN_NUM_BANDS);
    }
  });
});
