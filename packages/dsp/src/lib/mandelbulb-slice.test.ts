// packages/dsp/src/lib/mandelbulb-slice.test.ts
//
// Tests for the MANDELBULB slice → waveform readout. The slice math is the
// audio analogue of cube-dsp's sampleSlice: it marches the bulb DISTANCE
// ESTIMATOR through a rotatable, FIXED-SIZE plane and reads a 256-sample
// waveform in [-1, 1]. Key invariants pinned here:
//   • deterministic + bounded [-1, 1] (the wavetable contract);
//   • FIXED-SIZE under camera zoom/orbit — the readout is invariant to any
//     camera param because none enter the slice math (the whole point of the
//     fractal-space half-extent);
//   • the origin singularity (DE → NaN) is guarded → no NaN leaks to audio.

import { describe, it, expect } from 'vitest';
import {
  mbSampleSlice,
  mbSliceRay,
  mbRayDepth,
  MB_SLICE_SIZE,
  MB_RAY_STEPS,
  MB_SLICE_HALF,
  MB_SURF_BAND,
  type MbSliceParams,
} from './mandelbulb-slice';

const BASE: MbSliceParams = {
  sliceY: 0, rx: 0.3, ry: 0.5, rz: 0.1, power: 8, iters: 20,
};

describe('mandelbulb-slice — constants', () => {
  it('the readout is a 256-sample wavetable frame', () => {
    expect(MB_SLICE_SIZE).toBe(256);
  });
  it('uses a leaner-than-cube ray budget + a fractal-space half-extent', () => {
    expect(MB_RAY_STEPS).toBe(64);
    expect(MB_SLICE_HALF).toBeCloseTo(1.2, 6);
    expect(MB_SURF_BAND).toBeCloseTo(0.06, 6);
  });
});

describe('mbSampleSlice — contract', () => {
  it('returns a fresh Float32Array(256)', () => {
    const w = mbSampleSlice(BASE);
    expect(w).toBeInstanceOf(Float32Array);
    expect(w.length).toBe(256);
  });

  it('every sample is finite + in [-1, 1] (no NaN from the origin singularity)', () => {
    // A slice passing right through the bulb origin (sliceY=0, no rotation) puts
    // the origin singularity on a marched step — the NaN guard must keep it out.
    const w = mbSampleSlice({ ...BASE, rx: 0, ry: 0, rz: 0, sliceY: 0 });
    for (let i = 0; i < w.length; i++) {
      const v = w[i]!;
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('is deterministic — same params → byte-identical waveform', () => {
    const a = mbSampleSlice(BASE);
    const b = mbSampleSlice(BASE);
    for (let i = 0; i < a.length; i++) expect(a[i]).toBe(b[i]);
  });

  it('is non-trivial: a slice through the bulb is NOT all-silent', () => {
    const w = mbSampleSlice(BASE);
    let energy = 0;
    for (let i = 0; i < w.length; i++) energy += Math.abs(w[i]! - -1); // dist from the silent floor (-1)
    expect(energy).toBeGreaterThan(0);
  });

  it('a slice parked FAR outside the bulb reads silent (-1, the empty floor)', () => {
    // sliceY far beyond MB_SLICE_HALF pushes the whole plane out of the bulb,
    // so every ray's occupancy is ~0 → samples map to -1 (silent), the same
    // "silent outside" rule CUBE has.
    const w = mbSampleSlice({ ...BASE, rx: 0, ry: 0, rz: 0, sliceY: 100 });
    for (let i = 0; i < w.length; i++) expect(w[i]).toBeCloseTo(-1, 5);
  });

  it('moving the slice plane (sliceY) changes the waveform — Y is load-bearing', () => {
    const a = mbSampleSlice({ ...BASE, sliceY: 0 });
    const b = mbSampleSlice({ ...BASE, sliceY: 0.4 });
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff += Math.abs(a[i]! - b[i]!);
    expect(diff).toBeGreaterThan(0.01);
  });

  it('rotating the slice (rx/ry/rz) changes the waveform — rotation is load-bearing', () => {
    const a = mbSampleSlice({ ...BASE, rx: 0, ry: 0, rz: 0 });
    const b = mbSampleSlice({ ...BASE, rx: 1.1, ry: 0.7, rz: 0.4 });
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff += Math.abs(a[i]! - b[i]!);
    expect(diff).toBeGreaterThan(0.01);
  });

  it('higher power reshapes the bulb → reshapes the waveform (power is live)', () => {
    const a = mbSampleSlice({ ...BASE, power: 8 });
    const b = mbSampleSlice({ ...BASE, power: 3 });
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff += Math.abs(a[i]! - b[i]!);
    expect(diff).toBeGreaterThan(0.01);
  });
});

describe('mbSampleSlice — FIXED-SIZE under camera zoom/orbit (the headline guarantee)', () => {
  // The slice math takes ONLY sliceY/rx/ry/rz/power/iters/crush — NO camera
  // params (zoom / rotate_x / rotate_y / hue). So no matter how the user zooms
  // or orbits the on-card view, the audio waveform is byte-identical for a fixed
  // set of slice params. We can't pass camera params to mbSampleSlice at all
  // (they aren't in MbSliceParams) — which is the structural proof — but we also
  // assert that the slice params alone fully determine the output, and that
  // appending bogus extra fields (simulating a caller that wrongly threaded a
  // camera value through) cannot perturb it.
  it('the waveform is fully determined by the slice params (zoom/orbit cannot enter)', () => {
    const ref = mbSampleSlice(BASE);
    // Spread in arbitrary "camera-like" extra fields — they are not read.
    const polluted = mbSampleSlice({
      ...BASE,
      // @ts-expect-error — these are NOT MbSliceParams fields; they must be ignored.
      zoom: 3, rotate_x: 2.0, rotate_y: -1.5, hue: 0.9, eyeDist: 0.4,
    } as MbSliceParams);
    for (let i = 0; i < ref.length; i++) expect(polluted[i]).toBe(ref[i]);
  });

  it('a full zoom/orbit sweep (modelled as repeated reads with unrelated state) is invariant', () => {
    // Simulate a camera animation: many reads with the SAME slice params while
    // "the camera moves" (we just call repeatedly). Every read is identical.
    const first = mbSampleSlice(BASE);
    for (let frame = 0; frame < 8; frame++) {
      const w = mbSampleSlice(BASE);
      for (let i = 0; i < w.length; i++) expect(w[i]).toBe(first[i]);
    }
  });
});

describe('mbSliceRay — geometry', () => {
  it('is centered on the bulb ORIGIN: the middle scan index sits at the plane center', () => {
    // With no rotation + sliceY=0, the scan-axis center (n = SIZE/2) maps to the
    // origin region; the scan spans [-MB_SLICE_HALF, +MB_SLICE_HALF].
    const left = mbSliceRay(0, { ...BASE, rx: 0, ry: 0, rz: 0, sliceY: 0 });
    const right = mbSliceRay(MB_SLICE_SIZE - 1, { ...BASE, rx: 0, ry: 0, rz: 0, sliceY: 0 });
    // Unrotated scan axis is +X; the extremes straddle ±~MB_SLICE_HALF.
    expect(left.origin[0]).toBeLessThan(0);
    expect(right.origin[0]).toBeGreaterThan(0);
    expect(Math.abs(left.origin[0])).toBeCloseTo(MB_SLICE_HALF, 1);
  });

  it('the ray direction is a unit vector (the rotated plane normal)', () => {
    const ray = mbSliceRay(128, BASE);
    const len = Math.hypot(ray.dir[0], ray.dir[1], ray.dir[2]);
    expect(len).toBeCloseTo(1, 6);
  });

  it('sliceY offsets the origin along the (unrotated) normal +Z', () => {
    const a = mbSliceRay(128, { ...BASE, rx: 0, ry: 0, rz: 0, sliceY: 0 });
    const b = mbSliceRay(128, { ...BASE, rx: 0, ry: 0, rz: 0, sliceY: 0.5 });
    expect(b.origin[2] - a.origin[2]).toBeCloseTo(0.5, 6);
  });
});

describe('mbRayDepth — occupancy', () => {
  it('returns a value in [0, 1]', () => {
    for (let n = 0; n < MB_SLICE_SIZE; n += 17) {
      const d = mbRayDepth(mbSliceRay(n, BASE), BASE);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(1);
    }
  });
  it('a ray that misses the bulb entirely reads ~0 occupancy', () => {
    const farRay = mbSliceRay(128, { ...BASE, rx: 0, ry: 0, rz: 0, sliceY: 100 });
    expect(mbRayDepth(farRay, { ...BASE, sliceY: 100 })).toBeCloseTo(0, 5);
  });
});

describe('mbSampleSlice — CRUSH amplitude quantization', () => {
  it('crush=0 / omitted are identical (transparent)', () => {
    const a = mbSampleSlice(BASE);
    const b = mbSampleSlice({ ...BASE, crush: 0 });
    for (let i = 0; i < a.length; i++) expect(a[i]).toBe(b[i]);
  });
  it('crush>0 still yields finite [-1,1] samples', () => {
    const w = mbSampleSlice({ ...BASE, crush: 0.8 });
    for (let i = 0; i < w.length; i++) {
      expect(Number.isFinite(w[i]!)).toBe(true);
      expect(w[i]!).toBeGreaterThanOrEqual(-1);
      expect(w[i]!).toBeLessThanOrEqual(1);
    }
  });
});
