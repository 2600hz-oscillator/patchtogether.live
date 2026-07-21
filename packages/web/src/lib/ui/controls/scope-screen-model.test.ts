import { describe, it, expect } from 'vitest';
import {
  envelopeCurvePoints,
  valueToY,
  morphWaveSample,
  morphWavePoints,
  samplesToPoints,
  bipolarToY,
  peakAmplitude,
  ENV_V_PAD,
} from './scope-screen-model';

const W = 120;
const H = 64;

describe('envelopeCurvePoints', () => {
  it('produces the 5 ADSR anchors in the right shape', () => {
    const pts = envelopeCurvePoints({ attack: 0.1, decay: 0.2, sustain: 0.6, release: 0.3 }, W, H);
    expect(pts).toHaveLength(5);
    // start at bottom-left, end at bottom-right
    expect(pts[0]!.x).toBe(0);
    expect(pts[4]!.x).toBe(W);
    // start & end are at value 0 (same y)
    expect(pts[0]!.y).toBeCloseTo(pts[4]!.y, 6);
    // attack peak (pts[1]) is the highest point (smallest y)
    expect(pts[1]!.y).toBeLessThan(pts[0]!.y);
    for (const p of pts) expect(p.y).toBeGreaterThanOrEqual(pts[1]!.y - 1e-9);
    // sustain plateau: pts[2] and pts[3] share the same y (held level)
    expect(pts[2]!.y).toBeCloseTo(pts[3]!.y, 6);
    // x is monotonic nondecreasing
    for (let i = 1; i < pts.length; i++) expect(pts[i]!.x).toBeGreaterThanOrEqual(pts[i - 1]!.x);
  });
  it('longer attack pushes the peak x further right', () => {
    const shortA = envelopeCurvePoints({ attack: 0.05, decay: 0.2, sustain: 0.5, release: 0.2 }, W, H);
    const longA = envelopeCurvePoints({ attack: 0.5, decay: 0.2, sustain: 0.5, release: 0.2 }, W, H);
    expect(longA[1]!.x).toBeGreaterThan(shortA[1]!.x);
  });
  it('sustain level sets the plateau height', () => {
    const lo = envelopeCurvePoints({ attack: 0.1, decay: 0.1, sustain: 0.2, release: 0.1 }, W, H);
    const hi = envelopeCurvePoints({ attack: 0.1, decay: 0.1, sustain: 0.9, release: 0.1 }, W, H);
    // higher sustain → smaller y (higher on screen)
    expect(hi[2]!.y).toBeLessThan(lo[2]!.y);
  });
  it('degenerate box → empty', () => {
    expect(envelopeCurvePoints({ attack: 1, decay: 1, sustain: 0.5, release: 1 }, 0, H)).toEqual([]);
    expect(envelopeCurvePoints({ attack: 1, decay: 1, sustain: 0.5, release: 1 }, W, 0)).toEqual([]);
  });
  it('all-zero stages → flat baseline', () => {
    const pts = envelopeCurvePoints({ attack: 0, decay: 0, sustain: 0, release: 0 }, W, H);
    expect(pts).toHaveLength(2);
    expect(pts[0]!.y).toBeCloseTo(pts[1]!.y, 6);
  });
});

describe('valueToY', () => {
  it('maps value 1 to the top pad and 0 to the bottom pad', () => {
    const pad = ENV_V_PAD * H;
    expect(valueToY(1, H)).toBeCloseTo(pad, 6);
    expect(valueToY(0, H)).toBeCloseTo(H - pad, 6);
    expect(valueToY(0.5, H)).toBeCloseTo(H / 2, 6);
  });
});

describe('morphWaveSample', () => {
  it('morph 0 = sawtooth ramp', () => {
    expect(morphWaveSample(0, 0)).toBeCloseTo(-1, 6);
    expect(morphWaveSample(0.5, 0)).toBeCloseTo(0, 6);
    expect(morphWaveSample(1, 0)).toBeCloseTo(-1, 6); // wraps (phase 1 → 0)
    expect(morphWaveSample(0.999, 0)).toBeCloseTo(0.998, 3);
  });
  it('morph 1 = pulse (duty pw)', () => {
    expect(morphWaveSample(0.1, 1)).toBe(1);
    expect(morphWaveSample(0.4, 1)).toBe(1);
    expect(morphWaveSample(0.6, 1)).toBe(-1);
    expect(morphWaveSample(0.9, 1)).toBe(-1);
  });
  it('morph 0.5 is the crossfade of saw and square', () => {
    // at phase 0.25: saw=-0.5, square=+1 → 0.5*(-0.5)+0.5*(1)=0.25
    expect(morphWaveSample(0.25, 0.5)).toBeCloseTo(0.25, 6);
  });
  it('respects custom pulse width', () => {
    expect(morphWaveSample(0.2, 1, 0.25)).toBe(1);
    expect(morphWaveSample(0.3, 1, 0.25)).toBe(-1);
  });
});

describe('morphWavePoints', () => {
  it('spans the full width and stays within the padded box', () => {
    const pts = morphWavePoints(0, W, H, 64);
    expect(pts).toHaveLength(64);
    expect(pts[0]!.x).toBe(0);
    expect(pts[pts.length - 1]!.x).toBeCloseTo(W, 6);
    const pad = 0.1 * H;
    for (const p of pts) {
      expect(p.y).toBeGreaterThanOrEqual(pad - 1e-9);
      expect(p.y).toBeLessThanOrEqual(H - pad + 1e-9);
    }
  });
  it('degenerate → empty', () => {
    expect(morphWavePoints(0, 0, H)).toEqual([]);
    expect(morphWavePoints(0, W, H, 1)).toEqual([]);
  });
});

describe('bipolarToY', () => {
  it('maps +1 to top pad, -1 to bottom pad, 0 to center', () => {
    const pad = 0.1 * H;
    expect(bipolarToY(1, H)).toBeCloseTo(pad, 6);
    expect(bipolarToY(-1, H)).toBeCloseTo(H - pad, 6);
    expect(bipolarToY(0, H)).toBeCloseTo(H / 2, 6);
  });
  it('clamps out-of-range samples', () => {
    expect(bipolarToY(5, H)).toBeCloseTo(bipolarToY(1, H), 6);
    expect(bipolarToY(-5, H)).toBeCloseTo(bipolarToY(-1, H), 6);
  });
});

describe('samplesToPoints', () => {
  it('decimates a buffer across the width', () => {
    const buf = new Float32Array(2048);
    for (let i = 0; i < buf.length; i++) buf[i] = Math.sin((2 * Math.PI * i) / 64);
    const pts = samplesToPoints(buf, W, H, 200);
    expect(pts.length).toBeLessThanOrEqual(200);
    expect(pts.length).toBeGreaterThan(2);
    expect(pts[0]!.x).toBe(0);
    expect(pts[pts.length - 1]!.x).toBeCloseTo(W, 6);
  });
  it('empty / degenerate → empty', () => {
    expect(samplesToPoints(new Float32Array(0), W, H)).toEqual([]);
    expect(samplesToPoints(new Float32Array(10), 0, H)).toEqual([]);
  });
});

describe('peakAmplitude', () => {
  it('is 0 for silence and the max abs otherwise', () => {
    expect(peakAmplitude(new Float32Array(64))).toBe(0);
    expect(peakAmplitude([0.1, -0.7, 0.3])).toBeCloseTo(0.7, 6);
  });
});
