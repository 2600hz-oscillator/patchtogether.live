// packages/dsp/src/lib/synesthesia-dsp.test.ts
//
// Pure-DSP unit tests for the SYNESTHESIA audio-analysis core (LZX Sensory
// Translator-style: 4-band split → env followers → gate → spectral-flux beat
// triggers → VU meter; plus a VIDEO mode reusing the same follower stage).
// Extracted but untested. Deterministic + headless-safe (the worklet computes
// the onset itself precisely so CI's throttled-rAF FFT can't), so these pin the
// behavior a stub ART baseline never touched:
//   • combinedGain / applyBipolar / applyEnvDepth pure maps.
//   • makeBandSplitter ROUTES each frequency to the right musical band.
//   • EnvFollower attack/release (decays to 1/e after releaseMs).
//   • GateDetector Schmitt hysteresis (0.05 up / 0.02 down).
//   • OnsetDetector fires on a transient, NOT on a steady tone or silence.
//   • MeterBallistics fast-attack/slow-release, clamped at 1.
//   • videoChannelLevels BT.601 luma + video-mode env/gate routing.

import { describe, it, expect } from 'vitest';
import {
  SYN_NUM_BANDS,
  CV_MAKEUP,
  combinedGain,
  applyBipolar,
  applyEnvDepth,
  makeBandSplitter,
  EnvFollower,
  GateDetector,
  OnsetDetector,
  MeterBallistics,
  videoChannelLevels,
  renderSynesthesia,
  renderSynesthesiaVideo,
} from './synesthesia-dsp';

const SR = 48000;

function sine(freqHz: number, n: number, amp = 1): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freqHz * i) / SR);
  return out;
}
function rms(buf: Float32Array, skip = 3000): number {
  let s = 0,
    c = 0;
  for (let i = skip; i < buf.length; i++) {
    s += buf[i]! * buf[i]!;
    c++;
  }
  return Math.sqrt(s / Math.max(1, c));
}
function argmax(vals: number[]): number {
  let best = 0;
  for (let i = 1; i < vals.length; i++) if (vals[i]! > vals[best]!) best = i;
  return best;
}
function risingEdges(buf: Float32Array): number {
  let n = 0;
  for (let i = 1; i < buf.length; i++) if (buf[i]! === 1 && buf[i - 1]! === 0) n++;
  return n;
}

describe('pure gain/CV maps', () => {
  it('combinedGain = max(0, master + (band-1))', () => {
    expect(combinedGain(1, 1)).toBe(1); // unity
    expect(combinedGain(1, 2)).toBe(2);
    expect(combinedGain(0.5, 1)).toBe(0.5);
    expect(combinedGain(0.5, 0)).toBe(0); // clamps at 0
  });
  it('applyBipolar maps [0,1]→[-1,1] only when enabled', () => {
    expect(applyBipolar(0.4, false)).toBe(0.4);
    expect(applyBipolar(0, true)).toBe(-1);
    expect(applyBipolar(0.5, true)).toBe(0);
    expect(applyBipolar(1, true)).toBe(1);
  });
  it('applyEnvDepth scales linearly', () => {
    expect(applyEnvDepth(0.5, 2)).toBe(1);
    expect(applyEnvDepth(0.5, 0)).toBe(0);
  });
  it('CV_MAKEUP has one factor per band', () => {
    expect(CV_MAKEUP).toHaveLength(SYN_NUM_BANDS);
  });
});

describe('makeBandSplitter — frequency routing', () => {
  const cases: Array<{ hz: number; band: number; name: string }> = [
    { hz: 100, band: 0, name: 'bass' },
    { hz: 500, band: 1, name: 'low-mid' },
    { hz: 2000, band: 2, name: 'high-mid' },
    { hz: 8000, band: 3, name: 'treble' },
  ];
  for (const c of cases) {
    it(`routes ${c.hz} Hz to band ${c.band} (${c.name})`, () => {
      const r = renderSynesthesia(sine(c.hz, 12000), { sr: SR });
      const bandRms = r.audio.map((b) => rms(b));
      expect(argmax(bandRms)).toBe(c.band);
    });
  }
  it('the splitter is wired through makeBandSplitter (sanity: 4 bands out)', () => {
    const sp = makeBandSplitter(SR);
    const out = sp.split(0.5);
    expect(out).toHaveLength(4);
  });
});

describe('EnvFollower', () => {
  it('rectifies + rises on attack and decays to ~1/e after releaseMs', () => {
    const env = new EnvFollower(SR, 50, 2); // rel 50 ms, atk 2 ms
    let v = 0;
    for (let i = 0; i < 2000; i++) v = env.step(-1.0); // negative input → rectified
    expect(v).toBeCloseTo(1, 2); // attacked to ~full on |x|
    const peak = v;
    for (let i = 0; i < Math.round(0.05 * SR); i++) v = env.step(0); // exactly releaseMs of silence
    expect(v).toBeCloseTo(peak / Math.E, 2); // one time-constant → 1/e
  });
});

describe('GateDetector — Schmitt hysteresis', () => {
  it('opens at 0.05, holds through the band, closes below 0.02', () => {
    const g = new GateDetector();
    expect(g.step(0.03)).toBe(0); // below open threshold → stays closed
    expect(g.step(0.06)).toBe(1); // crosses 0.05 → open
    expect(g.step(0.03)).toBe(1); // inside hysteresis band → holds open
    expect(g.step(0.01)).toBe(0); // below 0.02 → closes
    expect(g.step(0.03)).toBe(0); // back in band but was closed → stays closed
  });
});

describe('OnsetDetector — spectral-flux beat trigger', () => {
  it('fires on a fresh transient but does not continuously re-fire on a steady tone', () => {
    const trig = new Float32Array(SR); // 1 s
    const od = new OnsetDetector(SR);
    const tone = sine(200, SR, 1.0); // amplitude STEP from silence at t=0
    for (let i = 0; i < SR; i++) trig[i] = od.step(tone[i]!);
    const edges = risingEdges(trig);
    expect(edges).toBeGreaterThanOrEqual(1); // detected the onset
    expect(edges).toBeLessThanOrEqual(4); // didn't keep re-triggering on the sustain
    // a real ~10 ms-ish pulse was emitted (not a 1-sample spike)
    let high = 0;
    for (let i = 0; i < trig.length; i++) high += trig[i]!;
    expect(high).toBeGreaterThan(50);
  });
  it('never fires on pure silence', () => {
    const od = new OnsetDetector(SR);
    let high = 0;
    for (let i = 0; i < SR; i++) high += od.step(0);
    expect(high).toBe(0);
  });
});

describe('MeterBallistics', () => {
  it('rises on attack, clamps at 1, never exceeds it', () => {
    const m = new MeterBallistics(SR);
    let v = 0;
    let maxV = 0;
    for (let i = 0; i < 4000; i++) {
      v = m.step(1.0);
      maxV = Math.max(maxV, v);
    }
    expect(v).toBeGreaterThan(0.5); // climbed
    expect(maxV).toBeLessThanOrEqual(1); // clamped
  });
});

describe('videoChannelLevels (BT.601)', () => {
  function solid(r: number, g: number, b: number, px = 16): Uint8ClampedArray {
    const out = new Uint8ClampedArray(px * 4);
    for (let i = 0; i < px; i++) {
      out[i * 4] = r;
      out[i * 4 + 1] = g;
      out[i * 4 + 2] = b;
      out[i * 4 + 3] = 255;
    }
    return out;
  }
  it('solid red → R≈1, luma≈0.299', () => {
    const [r, g, b, l] = videoChannelLevels(solid(255, 0, 0));
    expect(r).toBeCloseTo(1, 6);
    expect(g).toBeCloseTo(0, 6);
    expect(b).toBeCloseTo(0, 6);
    expect(l).toBeCloseTo(0.299, 6);
  });
  it('solid white → all channels + luma = 1', () => {
    const [r, g, b, l] = videoChannelLevels(solid(255, 255, 255));
    expect(r).toBe(1);
    expect(g).toBe(1);
    expect(b).toBe(1);
    expect(l).toBeCloseTo(1, 12); // 0.299+0.587+0.114 sums to 1 within fp epsilon
  });
  it('black → all zero; empty buffer → all zero (no divide-by-zero)', () => {
    expect(videoChannelLevels(solid(0, 0, 0))).toEqual([0, 0, 0, 0]);
    expect(videoChannelLevels(new Uint8ClampedArray(0))).toEqual([0, 0, 0, 0]);
  });
});

describe('renderSynesthesiaVideo — per-channel routing', () => {
  it('a solid-red frame opens the R gate but leaves the B gate closed', () => {
    const frames = Array.from({ length: 5000 }, () => [1, 0, 0, 0.299] as number[]);
    const r = renderSynesthesiaVideo(frames, { sr: SR });
    expect(r.gate[0]![r.gate[0]!.length - 1]).toBe(1); // R channel active
    expect(r.gate[2]![r.gate[2]!.length - 1]).toBe(0); // B channel idle
  });
  it('bipolar mode rails silent env CV outputs to -1', () => {
    const frames = Array.from({ length: 1000 }, () => [0, 0, 0, 0] as number[]);
    const r = renderSynesthesiaVideo(frames, { sr: SR, bipolar: true });
    expect(r.envSlow[0]![r.envSlow[0]!.length - 1]).toBeCloseTo(-1, 6);
  });
});
