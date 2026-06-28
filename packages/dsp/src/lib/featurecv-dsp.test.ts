// packages/dsp/src/lib/featurecv-dsp.test.ts
//
// Behaviour spec for the FEATURECV pure core: the window statistics
// (rms/crest/zcr/flux) on known signals, the 0..1 feature maps, the onset
// detector, and the full renderFeatureCv offline render (loud / bright / punch
// / onset) on the four canonical signals from the module spec:
//   pure sine    → LOW crest + LOW-ish ZCR
//   white noise  → HIGH ZCR brightness (+ higher crest than a sine)
//   amp ramp     → MONOTONE-rising loud
//   transient    → an ONSET pulse crossing GATE_HI

import { describe, it, expect } from 'vitest';
import {
  rms,
  crest,
  zcr,
  flux,
  loudToCv,
  brightToCv,
  punchToCv,
  onsetSensToThreshMult,
  FeatureOnset,
  renderFeatureCv,
  GATE_HI,
  TRIGGER_PULSE_S,
  DEFAULT_ONSET_DEBOUNCE_MS,
  ONSET_SENS_THRESH_MIN,
  ONSET_SENS_THRESH_MAX,
} from './featurecv-dsp';

const SR = 48000;

function sine(freq: number, secs: number, amp = 0.8): Float32Array {
  const n = Math.round(secs * SR);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return out;
}

// Deterministic pseudo-noise (mulberry32) so the test is reproducible.
function noise(secs: number, amp = 0.8, seed = 0x1234): Float32Array {
  const n = Math.round(secs * SR);
  const out = new Float32Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    const r = ((t ^ (t >>> 14)) >>> 0) / 4294967296; // 0..1
    out[i] = (r * 2 - 1) * amp;
  }
  return out;
}

function meanTail(buf: Float32Array, frac = 0.5): number {
  const start = Math.floor(buf.length * frac);
  let s = 0;
  for (let i = start; i < buf.length; i++) s += buf[i]!;
  return s / Math.max(1, buf.length - start);
}

function countPulses(buf: Float32Array): number {
  let count = 0;
  let prev = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i]!;
    if (v >= GATE_HI && prev < GATE_HI) count++;
    prev = v;
  }
  return count;
}

describe('featurecv-dsp — window statistics', () => {
  it('rms of a full-scale sine ≈ amp/√2', () => {
    const w = sine(1000, 1024 / SR, 1.0); // exactly 1024 samples? close enough
    const full = sine(1000, 0.05, 1.0);
    expect(rms(full)).toBeGreaterThan(0.69);
    expect(rms(full)).toBeLessThan(0.72);
    expect(rms(w)).toBeGreaterThan(0); // sanity on the windowed slice
  });

  it('rms of silence is 0; rms of a DC block equals |DC|', () => {
    expect(rms(new Float32Array(512))).toBe(0);
    expect(rms(new Float32Array(512).fill(0.5))).toBeCloseTo(0.5, 6);
  });

  it('crest: sine ≈ √2, DC ≈ 1, an impulse window is large', () => {
    expect(crest(sine(1000, 0.05, 0.8))).toBeGreaterThan(1.35);
    expect(crest(sine(1000, 0.05, 0.8))).toBeLessThan(1.5);
    expect(crest(new Float32Array(512).fill(0.4))).toBeCloseTo(1, 6);
    const imp = new Float32Array(512); // one spike in a sea of zeros → big crest
    imp[10] = 1;
    expect(crest(imp)).toBeGreaterThan(10);
  });

  it('zcr: a low sine ≪ a high sine ≪ noise; silence = 0', () => {
    const lo = zcr(sine(100, 0.05));
    const hi = zcr(sine(8000, 0.05));
    const nz = zcr(noise(0.05));
    expect(zcr(new Float32Array(512))).toBe(0);
    expect(lo).toBeLessThan(hi);
    expect(hi).toBeLessThan(nz);
    expect(nz).toBeGreaterThan(0.3); // white-ish noise crosses ~half the samples
  });

  it('flux is 0 at steady state + positive on a fresh rise above the floor', () => {
    expect(flux(0.5, 0.5)).toBe(0); // fast == slow
    expect(flux(0.2, 0.5)).toBe(0); // fast < slow
    expect(flux(1e-4, 1e-5)).toBe(0); // both below the silence floor
    expect(flux(0.5, 0.1)).toBeGreaterThan(0); // fast ≫ slow → onset-like rise
  });
});

describe('featurecv-dsp — feature → CV maps', () => {
  it('loud/bright/punch maps are monotone + clamped to 0..1', () => {
    expect(loudToCv(0)).toBe(0);
    expect(loudToCv(10)).toBe(1); // clamped
    expect(loudToCv(0.1)).toBeLessThan(loudToCv(0.3));
    expect(brightToCv(0)).toBe(0);
    expect(brightToCv(1)).toBe(1); // clamped (gain 2 × 0.5 → 1)
    expect(punchToCv(1)).toBe(0); // crest 1 (flat) → 0
    expect(punchToCv(100)).toBe(1); // clamped
    expect(punchToCv(2)).toBeGreaterThan(0);
    expect(punchToCv(4)).toBeGreaterThan(punchToCv(2));
  });

  it('onset sensitivity maps higher SENS → LOWER threshold multiplier', () => {
    expect(onsetSensToThreshMult(0)).toBeCloseTo(ONSET_SENS_THRESH_MAX, 6);
    expect(onsetSensToThreshMult(1)).toBeCloseTo(ONSET_SENS_THRESH_MIN, 6);
    expect(onsetSensToThreshMult(1)).toBeLessThan(onsetSensToThreshMult(0));
  });
});

describe('featurecv-dsp — FeatureOnset', () => {
  it('fires once on a step up, latches a TRIGGER_PULSE_S pulse, debounces', () => {
    const det = new FeatureOnset(SR);
    const threshMult = onsetSensToThreshMult(0.5);
    const debounce = Math.round((DEFAULT_ONSET_DEBOUNCE_MS / 1000) * SR);
    const pulseSamples = Math.max(1, Math.round(TRIGGER_PULSE_S * SR)); // 240
    // 100 ms silence, then a sustained loud tone (a fresh attack).
    let fired = 0;
    let pulseLen = 0;
    const pre = Math.round(0.1 * SR);
    const post = Math.round(0.2 * SR);
    for (let i = 0; i < pre; i++) det.step(0, threshMult, debounce);
    let prev = 0;
    for (let i = 0; i < post; i++) {
      const x = 0.8 * Math.sin((2 * Math.PI * 440 * i) / SR);
      const o = det.step(x, threshMult, debounce);
      if (o >= GATE_HI && prev < GATE_HI) fired++;
      if (o >= GATE_HI) pulseLen++;
      prev = o;
    }
    expect(fired).toBe(1); // exactly one onset on the attack, no re-fire on the tail
    expect(pulseLen).toBe(pulseSamples); // a clean TRIGGER_PULSE_S-wide pulse
  });

  it('a steady sustained tone (no fresh attack) does NOT re-fire', () => {
    const det = new FeatureOnset(SR);
    const threshMult = onsetSensToThreshMult(0.5);
    const debounce = Math.round((DEFAULT_ONSET_DEBOUNCE_MS / 1000) * SR);
    let fired = 0;
    let prev = 0;
    const n = Math.round(2.0 * SR);
    for (let i = 0; i < n; i++) {
      const o = det.step(0.6 * Math.sin((2 * Math.PI * 440 * i) / SR), threshMult, debounce);
      if (o >= GATE_HI && prev < GATE_HI) fired++;
      prev = o;
    }
    expect(fired).toBe(1); // the single onset at the very start only
  });
});

describe('featurecv-dsp — renderFeatureCv on canonical signals', () => {
  it('pure sine → LOW punch (crest) and LOW-ish bright; noise is higher on both', () => {
    const sineR = renderFeatureCv(sine(1000, 0.3, 0.8), { sr: SR, bipolar: false });
    const noiseR = renderFeatureCv(noise(0.3, 0.8), { sr: SR, bipolar: false });
    const sineBright = meanTail(sineR.bright);
    const noiseBright = meanTail(noiseR.bright);
    const sinePunch = meanTail(sineR.punch);
    const noisePunch = meanTail(noiseR.punch);
    expect(sineBright).toBeGreaterThanOrEqual(0);
    expect(sineBright).toBeLessThan(0.2); // a 1 kHz tone is not "bright"
    expect(noiseBright).toBeGreaterThan(0.6); // white noise is very bright
    expect(noiseBright).toBeGreaterThan(sineBright + 0.4);
    expect(sinePunch).toBeLessThan(0.15); // a steady sine has a low crest
    expect(noisePunch).toBeGreaterThan(sinePunch); // noise is punchier
  });

  it('amplitude ramp → MONOTONE-rising loud CV', () => {
    const secs = 0.6;
    const n = Math.round(secs * SR);
    const in_ = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const amp = i / n; // 0 → 1 linear amplitude ramp
      in_[i] = amp * Math.sin((2 * Math.PI * 500 * i) / SR);
    }
    const r = renderFeatureCv(in_, { sr: SR, bipolar: false });
    const early = meanTail(r.loud.subarray(0, Math.floor(n / 3)), 0.5);
    const mid = meanTail(r.loud.subarray(Math.floor(n / 3), Math.floor((2 * n) / 3)), 0.5);
    const late = meanTail(r.loud.subarray(Math.floor((2 * n) / 3)), 0.5);
    expect(mid).toBeGreaterThan(early);
    expect(late).toBeGreaterThan(mid);
  });

  it('a transient burst → at least one ONSET pulse crossing GATE_HI', () => {
    const secs = 0.5;
    const n = Math.round(secs * SR);
    const in_ = new Float32Array(n);
    // silence, then a percussive decaying burst part-way through (a fresh hit).
    const hitAt = Math.round(0.25 * SR);
    for (let i = hitAt; i < n; i++) {
      const env = Math.exp(-(i - hitAt) / (0.03 * SR)); // 30 ms decay
      in_[i] = env * Math.sin((2 * Math.PI * 1200 * i) / SR);
    }
    const r = renderFeatureCv(in_, { sr: SR, onsetSens: 0.7 });
    expect(countPulses(r.onset)).toBeGreaterThanOrEqual(1);
  });

  it('bipolar DEFAULT maps silence → −1 and a loud signal → above silence', () => {
    const silent = renderFeatureCv(new Float32Array(Math.round(0.2 * SR)), { sr: SR }); // bipolar default true
    const loud = renderFeatureCv(noise(0.3, 0.9), { sr: SR });
    expect(meanTail(silent.loud)).toBeLessThan(-0.9); // unipolar 0 → bipolar −1
    expect(meanTail(loud.loud)).toBeGreaterThan(meanTail(silent.loud) + 0.3);
  });
});
