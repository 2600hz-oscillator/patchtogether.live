// packages/web/src/lib/audio/modules/wavetable-osc-smoothing.test.ts
//
// Pure-math tests for the per-sample shape-param smoother that lives in
// packages/dsp/src/lib/wavetable-osc.ts. The smoother is THE fix for the
// "clicks on FOXY even with FREEZE TABLE on" report: morph / spread /
// fold are a-rate AudioParams whose VALUE is constant across a 128-sample
// block, so a setValueAtTime jump between blocks produces a hard sample-
// level step → audible click. WtParamSmoother is a 1-pole LP that the
// wavecel worklet applies per-sample to morph / spread / fold (NOT pitch
// — sequencer step transitions must stay sample-instant).
//
// What's pinned here:
//   1. The smoother holds at the primed value when the input doesn't move
//      (steady-state = constant output, no drift).
//   2. A step input does NOT pass through instantly — the first sample
//      after the step is FAR closer to the previous value than to the new
//      one, then converges over many samples.
//   3. The convergence time matches the corner-frequency formula so we
//      don't accidentally regress to a 1-sample passthrough or an
//      excessively-long ramp.
//   4. End-to-end: an abrupt morph jump driven through WavetableOsc.step
//      WITHOUT smoothing produces a per-sample delta spike >> the table's
//      intrinsic per-sample motion; WITH smoothing the max delta drops
//      back into the same band as the baseline (no abrupt-morph) run.
//      This is the "no click" assertion in concrete numeric form.
//
// Why this file lives under web/ (mirroring resofilter-dsp.test.ts): the
// dsp workspace has no vitest target, so `task test` only picks up
// packages/web/src/**/*.test.ts. Direct relative import into the dsp
// source tree keeps the math testable without a real AudioContext.

import { describe, it, expect } from 'vitest';
import {
  WtParamSmoother,
  WavetableOsc,
  WAVETABLE_FRAME_SIZE,
} from '../../../../../dsp/src/lib/wavetable-osc';

const SR = 48000;

describe('WtParamSmoother — steady state', () => {
  it('holds at the primed value when the input is constant', () => {
    const s = new WtParamSmoother(SR);
    s.prime(0.42);
    for (let i = 0; i < 1000; i++) {
      const y = s.step(0.42);
      expect(y).toBeCloseTo(0.42, 8);
    }
  });

  it('converges toward a held input over time', () => {
    const s = new WtParamSmoother(SR);
    s.prime(0);
    // Hold input at 1 for 200 ms — well past the ~2 ms time constant.
    const n = Math.floor(SR * 0.2);
    let y = 0;
    for (let i = 0; i < n; i++) y = s.step(1);
    expect(y).toBeCloseTo(1, 3);
  });
});

describe('WtParamSmoother — step response (no instant passthrough)', () => {
  it('the first sample after a 0→1 step is close to 0, not close to 1', () => {
    const s = new WtParamSmoother(SR);
    s.prime(0);
    const y0 = s.step(1);
    // With α = 1 - exp(-2π·80/48000) ≈ 0.01045 the first sample lands at
    // ~0.0105 (FAR closer to the old value 0 than to the new value 1).
    // Pin a generous upper bound — the exact value can drift with corner
    // choice; what matters is "definitely not a passthrough".
    expect(y0).toBeLessThan(0.05);
    expect(y0).toBeGreaterThan(0); // and it DID move toward the target.
  });

  it('reaches ~63% of a step within ~one time constant (~2 ms at 80 Hz)', () => {
    const s = new WtParamSmoother(SR);
    s.prime(0);
    // 1 / (2π · 80 Hz) ≈ 1.99 ms ≈ 95 samples at 48 kHz.
    const oneTau = Math.round(SR / (2 * Math.PI * 80));
    let y = 0;
    for (let i = 0; i < oneTau; i++) y = s.step(1);
    expect(y).toBeGreaterThan(0.55);
    expect(y).toBeLessThan(0.7);
  });

  it('a custom corner converges faster than the default', () => {
    const slow = new WtParamSmoother(SR, 20);
    const fast = new WtParamSmoother(SR, 500);
    slow.prime(0);
    fast.prime(0);
    let ys = 0;
    let yf = 0;
    for (let i = 0; i < 50; i++) {
      ys = slow.step(1);
      yf = fast.step(1);
    }
    expect(yf).toBeGreaterThan(ys);
  });
});

// ── End-to-end: smoothed morph jump produces no per-sample delta spike ──
//
// The user-visible bug: FOXY's audio output clicks when morph jumps
// abruptly, even when the wavetable is frozen (so the click is NOT a
// table swap — it's the morph step landing at a non-zero-crossing phase,
// shifting which two frames are blended and at what weights). Below we
// replicate the worklet's per-sample loop in pure JS against a static
// pre-loaded set of frames, run two passes (no-smoothing vs smoothing),
// and compare the largest per-sample output delta after the morph jump.
//
// Frame design — kept INTENTIONALLY smooth WITHIN each frame AND smooth
// along the morph axis (frame index): every frame is constant at level
// `lerp(+0.8, -0.8, f / (FC-1))`. With both axes smooth, the baseline
// per-sample motion of a running oscillator is ~0, and a SMOOTH morph
// ramp produces an output that tracks the morph linearly (small per-
// sample deltas). What's distinctive is the UN-smoothed morph step: it
// reads the SAME phase at frame 0 (level +0.8) and frame 63 (level
// -0.8) in two consecutive samples → a hard ~1.6-amplitude click. The
// smoothed pass spreads that 1.6-amplitude transition over ~5 ms ≈ 240
// samples, capping the per-sample delta at ~0.01 · 1.6 ≈ 0.017.
function buildContrastingFrames(): Float32Array[] {
  const frames: Float32Array[] = [];
  const FC = 64;
  for (let f = 0; f < FC; f++) {
    const frame = new Float32Array(WAVETABLE_FRAME_SIZE);
    // Smooth linear ramp from +0.8 at frame 0 to -0.8 at frame 63.
    const t = f / (FC - 1);
    const level = 0.8 * (1 - 2 * t);
    frame.fill(level);
    frames.push(frame);
  }
  return frames;
}

function runWithMorphSchedule(
  frames: Float32Array[],
  morphAt: (sampleIdx: number) => number,
  useSmoother: boolean,
): { samples: Float32Array; maxAbsDelta: number; deltaAtJump: number } {
  // Match the worklet's WavetableOsc + smoother wiring exactly.
  const osc = new WavetableOsc(SR);
  osc.setFrames(frames);
  // setFrames triggers a 4 ms crossfade (per WavetableOsc setFrames
  // docstring) which would dominate the first ~190 samples of output
  // and mask the morph-jump click. Pre-roll past the crossfade with a
  // held morph BEFORE the schedule kicks in so we measure morph clicks
  // only — not table-swap-crossfade transients.
  const xfadeSamples = Math.round(SR * 0.004) + 8;
  const morphInitial = morphAt(0);
  for (let i = 0; i < xfadeSamples; i++) {
    osc.step(0, morphInitial, 1, 0);
  }
  const smoother = new WtParamSmoother(SR);
  smoother.prime(morphInitial);
  const N = 4096;
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const rawMorph = morphAt(i);
    const morph = useSmoother ? smoother.step(rawMorph) : rawMorph;
    const { l } = osc.step(0, morph, 1, 0);
    out[i] = l;
  }
  let maxAbs = 0;
  for (let i = 1; i < N; i++) {
    const d = Math.abs(out[i]! - out[i - 1]!);
    if (d > maxAbs) maxAbs = d;
  }
  // Sample-after-the-jump delta — for the no-smoothing pass this is the
  // pure click; for the smoothed pass this should be ~indistinguishable
  // from the baseline per-sample motion.
  const jumpAt = Math.floor(N / 2);
  const deltaAtJump = Math.abs(out[jumpAt]! - out[jumpAt - 1]!);
  return { samples: out, maxAbsDelta: maxAbs, deltaAtJump };
}

describe('wavecel — abrupt morph jump produces no click WITH smoothing', () => {
  const frames = buildContrastingFrames();
  // morph schedule: hold at 0 for the first half, then JUMP to 1.
  // (Mirrors what setValueAtTime delivers to the worklet across blocks.)
  const jumpAt = 2048;
  const morphAt = (i: number): number => (i < jumpAt ? 0 : 1);

  it('unsmoothed: the morph jump produces a large per-sample delta', () => {
    const { maxAbsDelta, deltaAtJump } = runWithMorphSchedule(
      frames,
      morphAt,
      /* useSmoother */ false,
    );
    // With a static-but-contrasting frame set and an instant 0→1 morph
    // jump, the no-smoothing pass should produce a hard discontinuity.
    expect(deltaAtJump).toBeGreaterThan(0.5);
    // …and the maximum delta over the whole run is dominated by that
    // single sample (much larger than baseline sine-to-sine motion).
    expect(maxAbsDelta).toBeGreaterThan(0.5);
  });

  it('smoothed: the same morph jump produces NO click — max delta stays small', () => {
    const { maxAbsDelta, deltaAtJump } = runWithMorphSchedule(
      frames,
      morphAt,
      /* useSmoother */ true,
    );
    // With the LP in place, the morph traverses 0 → 1 over ~5 ms instead
    // of in 1 sample. Per-sample output deltas now reflect normal sine
    // motion at the highest active frame's partial. Pin a generous
    // upper bound that the unsmoothed pass clearly fails (0.5 above)
    // and the smoothed pass clearly meets — keeps the regression signal
    // crisp without locking the corner choice.
    expect(deltaAtJump).toBeLessThan(0.15);
    expect(maxAbsDelta).toBeLessThan(0.2);
  });

  it('smoothed: settled output still reaches the target morph (no permanent offset)', () => {
    const { samples } = runWithMorphSchedule(frames, morphAt, true);
    // With the morph held at 1 from sample 2048 onwards + the default
    // 80 Hz corner, ~15 τ later (sample ≈ 3500) the smoother is
    // effectively at the target. The last 64 samples sit in the -0.8
    // plateau region of the table (frames 8..63) → mean ≈ -0.8.
    const tailStart = samples.length - 64;
    let sum = 0;
    for (let i = tailStart; i < samples.length; i++) sum += samples[i]!;
    const mean = sum / 64;
    // Generous bands so a different smoother corner doesn't break this
    // assertion — what we're pinning is "the morph actually got there",
    // not the exact settle time.
    expect(mean).toBeLessThan(-0.5);
    expect(mean).toBeGreaterThan(-1.0);
  });
});

// Symmetric coverage for spread + fold — the same step-response semantics
// the morph test pins also apply to the other two perceptually-sensitive
// shape params. Keeping these tight + cheap (no full WavetableOsc loop)
// so the test file stays under a few hundred ms even when running every
// `task test` invocation.
describe('WtParamSmoother — spread + fold step semantics', () => {
  it('smooths a spread jump 1 → 5 over ms, not samples', () => {
    const s = new WtParamSmoother(SR);
    s.prime(1);
    // After 1 sample the spread should still be far from the target.
    const y0 = s.step(5);
    expect(y0 - 1).toBeLessThan(0.1);
    // After ~10 ms (≈480 samples) it should be near the target.
    let y = y0;
    for (let i = 0; i < 480; i++) y = s.step(5);
    expect(y).toBeGreaterThan(4.5);
  });

  it('smooths a fold jump 0 → 1 over ms, not samples', () => {
    const s = new WtParamSmoother(SR);
    s.prime(0);
    const y0 = s.step(1);
    expect(y0).toBeLessThan(0.05);
    let y = y0;
    for (let i = 0; i < 480; i++) y = s.step(1);
    expect(y).toBeGreaterThan(0.85);
  });
});
