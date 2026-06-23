// packages/web/src/lib/audio/modules/spectrograph-draw.test.ts
//
// GPU-free unit tests for the SPECTROGRAPH pure draw core. The web
// package's vitest runs in node (no DOM canvas), so we test the binning
// + colormap math directly against plain Float32Array / number[] buffers
// — the strongest, cheapest coverage for this module.

import { describe, expect, it } from 'vitest';
import {
  SPEC_W,
  SPEC_H,
  DB_LO,
  DB_HI,
  normDb,
  heatmapRgb,
  grayscaleInvRgb,
  writeSpectrumColumn,
  renderSpectrographInto,
} from './spectrograph-draw';

describe('normDb', () => {
  it('maps the display window endpoints to [0,1]', () => {
    expect(normDb(DB_LO)).toBeCloseTo(0, 6);
    expect(normDb(DB_HI)).toBeCloseTo(1, 6);
    expect(normDb((DB_LO + DB_HI) / 2)).toBeCloseTo(0.5, 6);
  });
});

describe('heatmapRgb (COLOR)', () => {
  it('quiet (m=0) is near-black with a hint of blue, NOT white', () => {
    const [r, g, b] = heatmapRgb(0);
    expect(r).toBe(0);
    expect(g).toBe(0);
    expect(b).toBe(80); // dark-blue floor
  });
  it('loud (m=1) is pure red (hot)', () => {
    expect(heatmapRgb(1)).toEqual([255, 0, 0]);
  });
  it('is byte-identical to WAVESCULPT heatmapRgb at the band boundaries', () => {
    // Spot-check the four ramp segments resolve to the documented stops.
    expect(heatmapRgb(0.25)).toEqual([0, 0, 180]); // dark blue → blue start
    expect(heatmapRgb(0.5)).toEqual([0, 200, 255]); // cyan
    expect(heatmapRgb(0.75)).toEqual([255, 255, 0]); // yellow
  });
});

describe('grayscaleInvRgb (B/W) — inverted, printed-sonogram look', () => {
  it('quiet (m=0) is WHITE (light page)', () => {
    expect(grayscaleInvRgb(0)).toEqual([255, 255, 255]);
  });
  it('loud (m=1) is BLACK (dark trace)', () => {
    expect(grayscaleInvRgb(1)).toEqual([0, 0, 0]);
  });
  it('is monochrome (R==G==B) and DECREASES with magnitude (the inversion)', () => {
    const lo = grayscaleInvRgb(0.2);
    const hi = grayscaleInvRgb(0.8);
    expect(lo[0]).toBe(lo[1]);
    expect(lo[1]).toBe(lo[2]);
    // Inverted: a LOUDER bin is DARKER (smaller channel value).
    expect(hi[0]).toBeLessThan(lo[0]);
  });
  it('is the exact inverse of a plain grayscale ramp', () => {
    for (const m of [0, 0.25, 0.5, 0.75, 1]) {
      const g = grayscaleInvRgb(m)[0];
      expect(g).toBe(Math.round((1 - m) * 255));
    }
  });
});

describe('COLOR vs B/W share the same plane but differ by colormap', () => {
  it('at the SAME magnitude the two colormaps disagree (proves two distinct looks)', () => {
    // A mid-loud bin: heat is colored, bw is mid-gray; they must not be equal.
    const m = 0.7;
    expect(heatmapRgb(m)).not.toEqual(grayscaleInvRgb(m));
  });
  it('quiet pixel: COLOR is dark, B/W is light (opposite luminance polarity)', () => {
    const cQuiet = heatmapRgb(0);
    const bwQuiet = grayscaleInvRgb(0);
    const lum = (p: [number, number, number]): number => (p[0] + p[1] + p[2]) / 3;
    expect(lum(cQuiet)).toBeLessThan(50); // heat quiet ≈ dark
    expect(lum(bwQuiet)).toBeGreaterThan(200); // bw quiet ≈ white
  });
});

describe('writeSpectrumColumn — log-bin mapping', () => {
  const SR = 48000;
  const FFT = 1024;
  const BINS = FFT / 2; // frequencyBinCount

  it('maps the bottom row to a LOW Hz bin and the top row to a HIGH Hz bin', () => {
    // bins[k] = the dB at (k * SR / FFT) Hz. Make bin index == value so we
    // can read back which FFT bin each spectrograph row resolved to.
    const bins = new Float32Array(BINS);
    for (let k = 0; k < BINS; k++) bins[k] = k; // sentinel: value == bin index
    const buf = new Float32Array(SPEC_W * SPEC_H).fill(-100);
    writeSpectrumColumn(buf, 0, bins, SR, FFT);

    const hzPerBin = SR / FFT;
    // Bottom row (SPEC_H-1) targets ~20 Hz → bin round(20/hzPerBin), clamped ≥1.
    const bottomBin = buf[0 * SPEC_H + (SPEC_H - 1)]!;
    const expectBottom = Math.max(1, Math.round(20 / hzPerBin));
    expect(bottomBin).toBe(expectBottom);

    // Top row (0) targets min(20kHz, Nyquist) → a high bin.
    const topBin = buf[0 * SPEC_H + 0]!;
    const fHi = Math.min(20000, SR / 2);
    expect(topBin).toBe(Math.round(fHi / hzPerBin));
    // Top must be a strictly higher FFT bin than the bottom (low at bottom).
    expect(topBin).toBeGreaterThan(bottomBin);
  });

  it('rows ascend monotonically in Hz from bottom to top (log scale)', () => {
    const bins = new Float32Array(BINS);
    for (let k = 0; k < BINS; k++) bins[k] = k;
    const buf = new Float32Array(SPEC_W * SPEC_H).fill(-100);
    writeSpectrumColumn(buf, 3, bins, SR, FFT);
    // Walk rows from bottom (SPEC_H-1) to top (0): bin index never decreases.
    let prev = -1;
    for (let r = SPEC_H - 1; r >= 0; r--) {
      const v = buf[3 * SPEC_H + r]!;
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it('never selects bin 0 (DC is skipped)', () => {
    const bins = new Float32Array(BINS);
    for (let k = 0; k < BINS; k++) bins[k] = k;
    const buf = new Float32Array(SPEC_W * SPEC_H).fill(-100);
    writeSpectrumColumn(buf, 0, bins, SR, FFT);
    for (let r = 0; r < SPEC_H; r++) {
      expect(buf[0 * SPEC_H + r]!).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('renderSpectrographInto — scroll order + colormap blit', () => {
  const SR = 48000;
  const FFT = 1024;
  const BINS = FFT / 2;

  it('newest column is at the RIGHT edge of the image', () => {
    const buf = new Float32Array(SPEC_W * SPEC_H).fill(DB_LO); // all quiet
    // Write a LOUD column at writeCol-1 (the newest), leave the rest quiet.
    const loudBins = new Float32Array(BINS).fill(DB_HI);
    let writeCol = 0;
    writeSpectrumColumn(buf, writeCol, loudBins, SR, FFT);
    writeCol = (writeCol + 1) % SPEC_W; // head now points past the loud column

    const data = new Uint8ClampedArray(SPEC_W * SPEC_H * 4);
    renderSpectrographInto(buf, writeCol, data, heatmapRgb);

    // Rightmost column (x = SPEC_W-1) should be the loud one → hot/red.
    const xRight = SPEC_W - 1;
    const yMid = Math.floor(SPEC_H / 2);
    const oRight = (yMid * SPEC_W + xRight) * 4;
    expect(data[oRight]!, 'rightmost (newest) col is loud → red R high').toBeGreaterThan(200);

    // Leftmost column should be quiet → dark blue floor (R≈0).
    const oLeft = (yMid * SPEC_W + 0) * 4;
    expect(data[oLeft]!, 'leftmost (older) col is quiet → R≈0').toBeLessThan(40);
  });

  it('B/W blit of a quiet plane is light (white-ish), of a loud plane is dark', () => {
    const quiet = new Float32Array(SPEC_W * SPEC_H).fill(DB_LO);
    const loud = new Float32Array(SPEC_W * SPEC_H).fill(DB_HI);
    const dQuiet = new Uint8ClampedArray(SPEC_W * SPEC_H * 4);
    const dLoud = new Uint8ClampedArray(SPEC_W * SPEC_H * 4);
    renderSpectrographInto(quiet, 0, dQuiet, grayscaleInvRgb);
    renderSpectrographInto(loud, 0, dLoud, grayscaleInvRgb);
    // Sample a pixel from each.
    expect(dQuiet[0]!).toBeGreaterThan(200); // quiet → light
    expect(dLoud[0]!).toBeLessThan(40); // loud → dark
    // Alpha always opaque.
    expect(dQuiet[3]!).toBe(255);
  });

  it('writes every pixel of the SPEC_W×SPEC_H frame (no gaps)', () => {
    const buf = new Float32Array(SPEC_W * SPEC_H).fill(-50);
    const data = new Uint8ClampedArray(SPEC_W * SPEC_H * 4).fill(7); // sentinel
    renderSpectrographInto(buf, 0, data, heatmapRgb);
    // Every alpha byte must have been set to 255 (proves full coverage).
    let allOpaque = true;
    for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) allOpaque = false;
    expect(allOpaque).toBe(true);
  });
});
