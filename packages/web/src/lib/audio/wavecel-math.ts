// packages/web/src/lib/audio/wavecel-math.ts
//
// Pure DSP math used by the WAVECEL worklet (packages/dsp/src/wavecel.ts).
// Mirrored here so unit tests can pin spread→stereo math, wavefolder
// curve, and frame interpolation without the AudioWorkletGlobalScope.
//
// The worklet has its own private copies of these functions (no imports
// allowed across the worklet boundary). Any change here must be mirrored
// in the worklet — the unit tests assert behavior, not provenance.

export const WAVECEL_FRAME_SIZE = 256;

export function fold(x: number, amount: number): number {
  if (amount <= 0) return x;
  const drive = 1 + amount * 4;
  let y = x * drive;
  let guard = 0;
  while ((y > 1 || y < -1) && guard < 32) {
    if (y > 1) y = 2 - y;
    else y = -2 - y;
    guard++;
  }
  return y;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function clampRange(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Linear-interpolate a single sample out of a frame array at a fractional
 *  frame index AND a fractional sample index. The (s1, s2, sFrac) split is
 *  pre-computed by the caller because every spread tap shares the same
 *  oscillator phase — only `frameFloat` differs per tap. */
export function sampleFrame(
  frames: readonly Float32Array[],
  frameFloat: number,
  FC: number,
  s1: number,
  s2: number,
  sFrac: number,
): number {
  const f1 = Math.max(0, Math.min(FC - 1, Math.floor(frameFloat)));
  const f2 = Math.max(0, Math.min(FC - 1, f1 + 1));
  const frameFrac = frameFloat - Math.floor(frameFloat);
  const a = frames[f1]!;
  const b = frames[f2]!;
  const va = a[s1]! + (a[s2]! - a[s1]!) * sFrac;
  const vb = b[s1]! + (b[s2]! - b[s1]!) * sFrac;
  return va + (vb - va) * frameFrac;
}

/** Per-tap descriptor returned by `spreadTaps`. `frameFloat` is the (possibly
 *  out-of-range) fractional frame index the worklet samples; `weight` is the
 *  edge-fade weight in [0, 1]; `pan` is in [-1, +1] (-1 = full L, +1 = full R,
 *  0 = center). The visualizer uses (frameFloat, weight) to highlight active
 *  frames; the worklet uses all three to compute the stereo mix. */
export interface SpreadTap {
  frameFloat: number;
  weight: number;
  pan: number;
}

/** Compute the active-tap descriptors for the given spread + center frame.
 *  Used by both the audio worklet (for stereo mixing — see wavecel.ts) and
 *  the on-card visualizer (for highlighting active frames in WavecelCard.svelte).
 *
 *  spread=1 → single tap at center, weight=1, pan=0 (mono).
 *  spread=N>1 → ceil(N) taps spaced 1 frame apart around center; outermost
 *  tap weights fade as the fractional spread leaves them behind. */
export function spreadTaps(spread: number, centerFrame: number): SpreadTap[] {
  const N = clampRange(spread, 1, 5);
  const halfSpan = (N - 1) / 2;
  if (halfSpan === 0) {
    return [{ frameFloat: centerFrame, weight: 1, pan: 0 }];
  }
  const tapCount = Math.max(1, Math.ceil(N));
  const taps: SpreadTap[] = [];
  for (let t = 0; t < tapCount; t++) {
    const offset = t - (tapCount - 1) / 2;
    const edgeWeight = Math.max(0, Math.min(1, halfSpan + 0.5 - Math.abs(offset)));
    if (edgeWeight <= 0) continue;
    const norm = clampRange(offset / halfSpan, -1, 1);
    taps.push({ frameFloat: centerFrame + offset, weight: edgeWeight, pan: norm });
  }
  return taps;
}

/** Stereo-spread mix of `tapCount` samples around `centerFrame`, returning
 *  (L, R) gains aggregated as a sum. Pure-math companion to the per-sample
 *  inner loop in wavecel.ts — sample fetch is left to the caller (in the
 *  worklet it reads from the live frames; in tests it's a stub function).
 *
 *  Each tap is offset by `(t - (tapCount-1)/2)` from center; equal-power
 *  panning maps the tap's normalized position into the [-1, +1] range
 *  spanning ±halfSpan, then panAngle = π/4 * (1 + norm).
 *
 *  Returns the (L, R) gain pair plus the running weight sum used to
 *  normalize spread changes (sqrt(weightSum) keeps RMS roughly flat). */
export function spreadMix(
  spread: number,
  centerFrame: number,
  fetchSampleAtFrame: (frameFloat: number) => number,
): { l: number; r: number } {
  const taps = spreadTaps(spread, centerFrame);
  if (taps.length === 1 && taps[0]!.pan === 0 && taps[0]!.weight === 1) {
    const s = fetchSampleAtFrame(taps[0]!.frameFloat);
    return { l: s, r: s };
  }
  let sumL = 0;
  let sumR = 0;
  let weightSum = 0;
  for (const tap of taps) {
    const sample = fetchSampleAtFrame(tap.frameFloat);
    const panAngle = (Math.PI / 4) * (1 + tap.pan);
    sumL += sample * Math.cos(panAngle) * tap.weight;
    sumR += sample * Math.sin(panAngle) * tap.weight;
    weightSum += tap.weight;
  }
  const norm = weightSum > 0 ? 1 / Math.sqrt(weightSum) : 0;
  return { l: sumL * norm, r: sumR * norm };
}
