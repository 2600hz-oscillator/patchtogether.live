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
  renderSynesthesiaVideo,
  videoChannelLevels,
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

// ───────────────────────── VIDEO mode ─────────────────────────

/** Build a w·h RGBA buffer filled with a single colour (0..255 per channel). */
function solidFrame(r: number, g: number, b: number, w = 8, h = 8): Uint8ClampedArray {
  const buf = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    buf[o] = r; buf[o + 1] = g; buf[o + 2] = b; buf[o + 3] = 255;
  }
  return buf;
}

describe('synesthesia-dsp — videoChannelLevels (R/G/B/Luma extraction)', () => {
  it('solid RED → R≈1, G/B≈0, luma≈0.299', () => {
    const [r, g, b, l] = videoChannelLevels(solidFrame(255, 0, 0));
    expect(r).toBeCloseTo(1, 5);
    expect(g).toBeCloseTo(0, 5);
    expect(b).toBeCloseTo(0, 5);
    expect(l).toBeCloseTo(0.299, 3); // luma of pure red
  });

  it('solid GREEN → G≈1, R/B≈0, luma≈0.587', () => {
    const [r, g, b, l] = videoChannelLevels(solidFrame(0, 255, 0));
    expect(g).toBeCloseTo(1, 5);
    expect(r).toBeCloseTo(0, 5);
    expect(b).toBeCloseTo(0, 5);
    expect(l).toBeCloseTo(0.587, 3);
  });

  it('solid BLUE → B≈1, R/G≈0, luma≈0.114', () => {
    const [r, g, b, l] = videoChannelLevels(solidFrame(0, 0, 255));
    expect(b).toBeCloseTo(1, 5);
    expect(r).toBeCloseTo(0, 5);
    expect(g).toBeCloseTo(0, 5);
    expect(l).toBeCloseTo(0.114, 3);
  });

  it('solid WHITE → R=G=B=1 AND luma=1 (the white-redlines-luma rule)', () => {
    const [r, g, b, l] = videoChannelLevels(solidFrame(255, 255, 255));
    expect(r).toBeCloseTo(1, 5);
    expect(g).toBeCloseTo(1, 5);
    expect(b).toBeCloseTo(1, 5);
    expect(l).toBeCloseTo(1, 5); // white maxes luma too
  });

  it('solid BLACK → all ≈0', () => {
    const [r, g, b, l] = videoChannelLevels(solidFrame(0, 0, 0));
    expect(r).toBe(0);
    expect(g).toBe(0);
    expect(b).toBe(0);
    expect(l).toBe(0);
  });

  it('mid-gray → R=G=B=0.5, luma=0.5 (coeffs sum to 1)', () => {
    const [r, g, b, l] = videoChannelLevels(solidFrame(128, 128, 128));
    expect(r).toBeCloseTo(128 / 255, 5);
    expect(l).toBeCloseTo(128 / 255, 5);
    expect(g).toBeCloseTo(r, 5);
    expect(b).toBeCloseTo(r, 5);
  });

  it('empty buffer → [0,0,0,0] (no divide-by-zero)', () => {
    expect(videoChannelLevels(new Uint8ClampedArray(0))).toEqual([0, 0, 0, 0]);
  });
});

describe('synesthesia-dsp — VIDEO mode gain scaling matches audio mode', () => {
  it('band-audio output = level · combinedGain(master, gain), per channel', () => {
    const levels = [1, 0.5, 0.25, 0.8] as const;
    const master = 1.2;
    const gains: [number, number, number, number] = [1, 1.5, 2, 1.25];
    // One frame, hold a single sample so we read the instantaneous scaled value.
    const r = renderSynesthesiaVideo([levels], { sr: SR, master, gains, holdSamples: 1 });
    for (let c = 0; c < SYN_NUM_BANDS; c++) {
      const expected = levels[c]! * combinedGain(master, gains[c]!);
      expect(r.audio[c]![0]).toBeCloseTo(expected, 6);
    }
  });

  it('uses the SAME combinedGain clamp law (master 0.5 + min gain → 0.5×)', () => {
    const r = renderSynesthesiaVideo([[1, 1, 1, 1]], { sr: SR, master: 0.5, gains: [1, 1, 1, 1], holdSamples: 1 });
    for (let c = 0; c < SYN_NUM_BANDS; c++) expect(r.audio[c]![0]).toBeCloseTo(0.5, 6);
  });
});

describe('synesthesia-dsp — VIDEO mode drives envelope/gate followers from levels', () => {
  it('a held high RED level opens the gate; sustained low keeps it closed', () => {
    // ~120 ms of solid red (R=1, others 0), then ~600 ms of black.
    const hold = Math.round(SR * 0.12);
    const sil = Math.round(SR * 0.6);
    const onFrames = Array.from({ length: 1 }, () => [1, 0, 0, 0.299] as const);
    const offFrames = Array.from({ length: 1 }, () => [0, 0, 0, 0] as const);
    const r = renderSynesthesiaVideo(
      [...onFrames.map((f) => f)],
      { sr: SR, holdSamples: hold },
    );
    // R channel (index 0) gate opens while red is held.
    expect(Math.max(...r.gate[0]!)).toBe(1);
    // The G/B channels never opened (they stayed at 0).
    expect(Math.max(...r.gate[1]!)).toBe(0);
    expect(Math.max(...r.gate[2]!)).toBe(0);

    // Now red then black: gate closes by the end.
    const r2 = renderSynesthesiaVideo(
      [[1, 0, 0, 0.299], [0, 0, 0, 0]],
      { sr: SR, holdSamples: Math.max(hold, sil) },
    );
    const g0 = r2.gate[0]!;
    expect(Math.max(...g0)).toBe(1); // opened during the red hold
    expect(g0[g0.length - 1]).toBe(0); // closed after black
  });

  it('envelope follower rises with the held level (fast tracks, slow lags)', () => {
    const r = renderSynesthesiaVideo(
      [[1, 0, 0, 0.299]],
      { sr: SR, holdSamples: Math.round(SR * 0.1) },
    );
    const fast0 = r.envFast[0]!;
    const slow0 = r.envSlow[0]!;
    // Instant-attack peak followers charge to the level; both end near 1.
    expect(fast0[fast0.length - 1]!).toBeCloseTo(1, 2);
    expect(slow0[slow0.length - 1]!).toBeCloseTo(1, 2);
  });

  it('meter level tracks the held channel level (white → all four meters high)', () => {
    const r = renderSynesthesiaVideo(
      [[1, 1, 1, 1]],
      { sr: SR, holdSamples: Math.round(SR * 0.3) },
    );
    for (let c = 0; c < SYN_NUM_BANDS; c++) {
      const m = r.level[c]!;
      expect(m[m.length - 1]!).toBeGreaterThan(0.6);
    }
  });
});
