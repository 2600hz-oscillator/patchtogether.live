// packages/dsp/src/lib/wavetable-osc.test.ts
//
// Pure-DSP unit tests for the SHARED wavetable oscillator core — the most
// widely-imported DSP core in the repo (chowkick, cube, hypercube, moog902,
// moog904a/b, moog921-vco/921a/921b, treeohvox, wavecel, wavesculpt, …). It
// had NO test despite being the math behind ~14 modules' tone generation, so a
// silent regression here (interp, pitch, morph, spread pan-law, wavefolder,
// table-swap crossfade) would slip past every ART/behavioral sweep. These pin
// the contour quantitatively:
//   • clamp helpers + the symmetric foldback wavefolder.
//   • sampleSplit (phase → fractional sample index, with frame wrap).
//   • sampleFrame (bilinear interp across frame × sample).
//   • spreadTaps / spreadMix (equal-power stereo tap pan-law).
//   • WtParamSmoother (1-pole de-zipper).
//   • WavetableOsc — empty→silent, C4 pitch, sine readback, freq clamps,
//     morph interp, mono vs stereo spread, setFrames cold-start vs crossfade,
//     snapshotFrame copy semantics, no-NaN under stress.

import { describe, it, expect } from 'vitest';
import {
  WAVETABLE_FRAME_SIZE,
  WtParamSmoother,
  clamp01,
  clampRange,
  fold,
  sampleFrame,
  spreadTaps,
  spreadMix,
  sampleSplit,
  WavetableOsc,
} from './wavetable-osc';

const SR = 48000;
const FS = WAVETABLE_FRAME_SIZE; // 256
const C4_HZ = 261.626; // matches the source constant (V/oct 0 = C4)

// ── frame builders ──────────────────────────────────────────────────────────
function constFrame(v: number): Float32Array {
  return new Float32Array(FS).fill(v);
}
function sineFrame(): Float32Array {
  const f = new Float32Array(FS);
  for (let i = 0; i < FS; i++) f[i] = Math.sin((2 * Math.PI * i) / FS);
  return f;
}

describe('clamp helpers', () => {
  it('clamp01 clamps to [0,1]', () => {
    expect(clamp01(-3)).toBe(0);
    expect(clamp01(0)).toBe(0);
    expect(clamp01(0.42)).toBe(0.42);
    expect(clamp01(1)).toBe(1);
    expect(clamp01(9)).toBe(1);
  });
  it('clampRange clamps to [lo,hi]', () => {
    expect(clampRange(-5, 1, 5)).toBe(1);
    expect(clampRange(3, 1, 5)).toBe(3);
    expect(clampRange(99, 1, 5)).toBe(5);
  });
});

describe('fold (symmetric wavefolder)', () => {
  it('bypasses when amount <= 0', () => {
    expect(fold(0.7, 0)).toBe(0.7);
    expect(fold(0.7, -0.5)).toBe(0.7);
    expect(fold(-1.5, 0)).toBe(-1.5); // bypass passes through even out-of-range
  });
  it('scales by drive=1+amt*4 while in range', () => {
    // amount 0.25 → drive 2; 0.3*2 = 0.6 stays inside [-1,1].
    expect(fold(0.3, 0.25)).toBeCloseTo(0.6, 12);
  });
  it('reflects values past +1 back inside (foldback)', () => {
    // 0.8 * drive(2) = 1.6 → 2 - 1.6 = 0.4.
    expect(fold(0.8, 0.25)).toBeCloseTo(0.4, 12);
  });
  it('is symmetric for negative foldback', () => {
    // -0.8 * 2 = -1.6 → -2 - (-1.6) = -0.4.
    expect(fold(-0.8, 0.25)).toBeCloseTo(-0.4, 12);
    expect(fold(-0.3, 0.25)).toBeCloseTo(-fold(0.3, 0.25), 12);
  });
  it('keeps output bounded in [-1,1] and finite under a hard sweep', () => {
    for (let xi = -40; xi <= 40; xi++) {
      const x = xi / 10; // -4 .. 4
      for (let ai = 1; ai <= 10; ai++) {
        const y = fold(x, ai / 10);
        expect(Number.isFinite(y)).toBe(true);
        expect(y).toBeGreaterThanOrEqual(-1.0000001);
        expect(y).toBeLessThanOrEqual(1.0000001);
      }
    }
  });
});

describe('sampleSplit (phase → sample index)', () => {
  it('phase 0 → first two samples, no frac', () => {
    expect(sampleSplit(0)).toEqual({ s1: 0, s2: 1, sFrac: 0 });
  });
  it('phase 0.5 → mid-frame', () => {
    expect(sampleSplit(0.5)).toEqual({ s1: FS / 2, s2: FS / 2 + 1, sFrac: 0 });
  });
  it('wraps s2 across the frame boundary', () => {
    const sp = sampleSplit(255.5 / FS); // samplePos 255.5
    expect(sp.s1).toBe(255);
    expect(sp.s2).toBe(0); // (255+1) % 256
    expect(sp.sFrac).toBeCloseTo(0.5, 12);
  });
  it('computes fractional position', () => {
    const sp = sampleSplit(1.5 / FS); // samplePos 1.5
    expect(sp.s1).toBe(1);
    expect(sp.s2).toBe(2);
    expect(sp.sFrac).toBeCloseTo(0.5, 12);
  });
});

describe('sampleFrame (bilinear interp)', () => {
  it('interpolates between samples within one frame', () => {
    const ramp = new Float32Array(FS);
    for (let i = 0; i < FS; i++) ramp[i] = i;
    // single frame, fractional sample 10.5 → 10.5
    expect(sampleFrame([ramp], 0, 1, 10, 11, 0.5)).toBeCloseTo(10.5, 12);
  });
  it('interpolates between adjacent frames', () => {
    const a = constFrame(0);
    const b = constFrame(1);
    // frameFloat 0.5 between frame0(0) and frame1(1) → 0.5
    expect(sampleFrame([a, b], 0.5, 2, 0, 1, 0)).toBeCloseTo(0.5, 12);
    expect(sampleFrame([a, b], 0.25, 2, 0, 1, 0)).toBeCloseTo(0.25, 12);
  });
  it('clamps the frame index at the edges', () => {
    const a = constFrame(2);
    const b = constFrame(7);
    expect(sampleFrame([a, b], -3, 2, 0, 1, 0)).toBeCloseTo(2, 12); // below 0 → frame0
    expect(sampleFrame([a, b], 9, 2, 0, 1, 0)).toBeCloseTo(7, 12); // above FC-1 → frame1
  });
});

describe('spreadTaps', () => {
  it('spread 1 → single centered mono tap', () => {
    expect(spreadTaps(1, 5)).toEqual([{ frameFloat: 5, weight: 1, pan: 0 }]);
  });
  it('spread 3 → three taps spaced 1 frame, symmetric pan, edge weights 0.5', () => {
    const taps = spreadTaps(3, 5);
    expect(taps.map((t) => t.frameFloat)).toEqual([4, 5, 6]);
    expect(taps.map((t) => t.pan)).toEqual([-1, 0, 1]);
    expect(taps.map((t) => t.weight)).toEqual([0.5, 1, 0.5]);
  });
  it('clamps spread to [1,5]', () => {
    expect(spreadTaps(0.2, 5)).toHaveLength(1); // floored to 1 → mono
    expect(spreadTaps(99, 5).length).toBeGreaterThan(1); // capped at 5, still multi-tap
    expect(spreadTaps(99, 5).length).toBeLessThanOrEqual(5);
  });
});

describe('spreadMix (equal-power stereo)', () => {
  const s1 = 0,
    s2 = 1,
    sFrac = 0;
  it('spread 1 → mono (l === r === sampleFrame)', () => {
    const frames = [constFrame(0.5)];
    const m = spreadMix(frames, 0, 1, s1, s2, sFrac);
    expect(m.l).toBeCloseTo(0.5, 12);
    expect(m.r).toBeCloseTo(0.5, 12);
  });
  it('symmetric content → l ≈ r even when spread', () => {
    const frames = [constFrame(0.3), constFrame(0.3), constFrame(0.3)];
    const m = spreadMix(frames, 1, 3, s1, s2, sFrac);
    expect(m.l).toBeCloseTo(m.r, 6);
  });
  it('asymmetric content across the spread → l ≠ r (pinned pan-law)', () => {
    // frame k holds the constant value k → the three taps (frames 4,5,6) read
    // 4,5,6; the equal-power pan tilts energy: left tap → L, right tap → R.
    const frames: Float32Array[] = [];
    for (let k = 0; k < 11; k++) frames.push(constFrame(k));
    const m = spreadMix(frames, 5, 3, s1, s2, sFrac);
    expect(m.l).toBeCloseTo(3.9142, 3);
    expect(m.r).toBeCloseTo(4.6213, 3);
    expect(m.l).toBeLessThan(m.r);
  });
});

describe('WtParamSmoother (1-pole de-zipper)', () => {
  it('has alpha in (0,1)', () => {
    const s = new WtParamSmoother(SR);
    // prime + a single step toward a target must move PART of the way, never overshoot.
    s.prime(0);
    const first = s.step(1);
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(1);
  });
  it('prime sets the value so a step at the same target is a no-op', () => {
    const s = new WtParamSmoother(SR);
    s.prime(0.7);
    expect(s.step(0.7)).toBeCloseTo(0.7, 12);
  });
  it('converges to the target', () => {
    const s = new WtParamSmoother(SR);
    s.prime(0);
    let v = 0;
    for (let i = 0; i < SR; i++) v = s.step(1); // 1 s of settling
    expect(v).toBeCloseTo(1, 3);
  });
  it('monotonically approaches without overshoot (rising target)', () => {
    const s = new WtParamSmoother(SR);
    s.prime(0);
    let prev = 0;
    for (let i = 0; i < 2000; i++) {
      const v = s.step(1);
      expect(v).toBeGreaterThanOrEqual(prev - 1e-12);
      expect(v).toBeLessThanOrEqual(1 + 1e-12);
      prev = v;
    }
  });
});

describe('WavetableOsc', () => {
  it('is silent and reports empty until frames are loaded', () => {
    const osc = new WavetableOsc(SR);
    expect(osc.framesLoaded()).toBe(false);
    expect(osc.frameCount()).toBe(0);
    expect(osc.step(0, 0, 1, 0)).toEqual({ l: 0, r: 0 });
    expect(osc.snapshotFrame(0)).toBeNull();
  });

  it('reads a sine table back at the correct C4 pitch (interp ≈ sin(2π·phase))', () => {
    const osc = new WavetableOsc(SR);
    osc.setFrames([sineFrame()]);
    const inc = C4_HZ / SR; // phase step per sample at V/oct 0
    let phase = 0;
    let maxV = -Infinity;
    let minV = Infinity;
    for (let i = 0; i < 400; i++) {
      const { l, r } = osc.step(0, 0, 1, 0);
      phase += inc;
      while (phase >= 1) phase -= 1;
      const expected = Math.sin(2 * Math.PI * phase);
      // 256-pt linear interp of a sine: max error ≈ 7.5e-4 → 3e-3 is safe.
      expect(l).toBeCloseTo(expected, 2);
      expect(r).toBe(l); // spread 1 → mono
      maxV = Math.max(maxV, l);
      minV = Math.min(minV, l);
    }
    expect(maxV).toBeGreaterThan(0.98); // spanned the full sine
    expect(minV).toBeLessThan(-0.98);
  });

  it('clamps frequency at both extremes without NaN/blowup', () => {
    const osc = new WavetableOsc(SR);
    osc.setFrames([sineFrame()]);
    for (let i = 0; i < 256; i++) {
      const hi = osc.step(100, 0, 1, 0); // → clamps to Nyquist
      expect(Number.isFinite(hi.l)).toBe(true);
      expect(Math.abs(hi.l)).toBeLessThanOrEqual(1.0001);
    }
    const osc2 = new WavetableOsc(SR);
    osc2.setFrames([sineFrame()]);
    for (let i = 0; i < 256; i++) {
      const lo = osc2.step(-100, 0, 1, 0); // → freq floored to 1 Hz
      expect(Number.isFinite(lo.l)).toBe(true);
    }
  });

  it('morph interpolates between frames', () => {
    const osc = new WavetableOsc(SR);
    osc.setFrames([constFrame(0), constFrame(1)]); // constant frames → output = morph value
    expect(osc.step(0, 0, 1, 0).l).toBeCloseTo(0, 6);
    expect(osc.step(0, 1, 1, 0).l).toBeCloseTo(1, 6);
    expect(osc.step(0, 0.5, 1, 0).l).toBeCloseTo(0.5, 6);
  });

  it('spread 1 is mono; spread > 1 over asymmetric frames is stereo', () => {
    const osc = new WavetableOsc(SR);
    const frames: Float32Array[] = [];
    for (let k = 0; k < 11; k++) frames.push(constFrame(k / 10)); // distinct per frame
    osc.setFrames(frames);
    const mono = osc.step(0, 0.5, 1, 0);
    expect(mono.l).toBeCloseTo(mono.r, 9);
    const stereo = osc.step(0, 0.5, 4, 0);
    expect(Math.abs(stereo.l - stereo.r)).toBeGreaterThan(1e-3);
  });

  it('setFrames on a cold start applies instantly (no crossfade ramp)', () => {
    const osc = new WavetableOsc(SR);
    osc.setFrames([constFrame(0.5)]); // first ever load
    expect(osc.step(0, 0, 1, 0).l).toBeCloseTo(0.5, 9); // already the new value, no fade
  });

  it('setFrames swap crossfades old → new over ~4 ms', () => {
    const osc = new WavetableOsc(SR);
    osc.setFrames([constFrame(0.5)]);
    osc.step(0, 0, 1, 0); // settle on old
    osc.setFrames([constFrame(-0.5)]); // swap → ~4 ms fade begins
    const first = osc.step(0, 0, 1, 0).l; // fade t≈0 → still ≈ old
    expect(first).toBeCloseTo(0.5, 2);
    // run well past the ~192-sample (4 ms) fade window
    let last = 0;
    for (let i = 0; i < 400; i++) last = osc.step(0, 0, 1, 0).l;
    expect(last).toBeCloseTo(-0.5, 6); // landed fully on the new table
  });

  it('snapshotFrame returns a defensive copy', () => {
    const osc = new WavetableOsc(SR);
    osc.setFrames([constFrame(0.25)]);
    const snap = osc.snapshotFrame(0)!;
    expect(snap).not.toBeNull();
    expect(snap[0]).toBeCloseTo(0.25, 9);
    snap[0] = 999; // mutate the returned copy
    const snap2 = osc.snapshotFrame(0)!;
    expect(snap2[0]).toBeCloseTo(0.25, 9); // internal frame untouched
  });

  it('never produces NaN/Inf across a parameter sweep', () => {
    const osc = new WavetableOsc(SR);
    osc.setFrames([sineFrame(), constFrame(0.3), constFrame(-0.7)]);
    for (let i = 0; i < 4000; i++) {
      const voct = ((i % 120) - 60) / 12; // -5..+5 oct
      const morph = (i % 100) / 99;
      const spread = 1 + (i % 5);
      const foldAmt = (i % 11) / 10;
      const { l, r } = osc.step(voct, morph, spread, foldAmt);
      expect(Number.isFinite(l)).toBe(true);
      expect(Number.isFinite(r)).toBe(true);
    }
  });
});
