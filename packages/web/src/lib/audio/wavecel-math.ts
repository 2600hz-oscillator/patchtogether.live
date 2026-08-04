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

/** The widest half-span, at spread = 5. Pan is proportional to a tap's
 *  DISTANCE FROM CENTRE MEASURED AGAINST THIS — see the DSP copy. */
const SPREAD_MAX_HALF_SPAN = 2;

/** Compute the active-tap descriptors for the given spread + center frame.
 *  Used by both the audio worklet (for stereo mixing — see wavecel.ts) and
 *  the on-card visualizer (for highlighting active frames in WavecelCard.svelte).
 *
 *  spread=1   → single tap at center, weight=1, pan=0 (mono).
 *  spread=N>1 → an ODD, CENTRE-INCLUSIVE bank at integer frame offsets;
 *  off-centre taps fade IN from weight 0 and pan widens with the span.
 *
 *  ⚠ THIS MUST STAY IDENTICAL TO packages/dsp/src/lib/wavetable-osc.ts — the
 *  card draws what the worklet plays, and nothing but
 *  `wavecel-spread-parity.test.ts` joins the two copies. The full rationale
 *  (the 43 dB cliff and the exactly-zero stereo the previous layout produced)
 *  lives in the DSP copy's docstring; do not let the two drift. */
export function spreadTaps(spread: number, centerFrame: number): SpreadTap[] {
  const N = clampRange(spread, 1, 5);
  const halfSpan = (N - 1) / 2; // 0 .. 2
  if (halfSpan === 0) {
    return [{ frameFloat: centerFrame, weight: 1, pan: 0 }];
  }
  const outer = Math.ceil(halfSpan); // 1 or 2
  const taps: SpreadTap[] = [];
  for (let k = -outer; k <= outer; k++) {
    const weight = k === 0 ? 1 : clamp01(halfSpan - Math.abs(k) + 1);
    if (weight <= 0) continue;
    taps.push({
      frameFloat: centerFrame + k,
      weight,
      pan: clampRange(k / SPREAD_MAX_HALF_SPAN, -1, 1),
    });
  }
  return taps;
}

/** Stereo-spread mix of `tapCount` samples around `centerFrame`, returning
 *  (L, R) gains aggregated as a sum. Pure-math companion to the per-sample
 *  inner loop in wavecel.ts — sample fetch is left to the caller (in the
 *  worklet it reads from the live frames; in tests it's a stub function).
 *
 *  Equal-power panning maps each tap's offset into [-1, +1] against the
 *  WIDEST half-span, then panAngle = π/4 * (1 + pan). Each channel is
 *  normalised by ITS OWN weight sum — a weighted AVERAGE — so identical taps
 *  reproduce the sample exactly at any spread and SPREAD cannot act as a
 *  level control. */
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
  let gainL = 0;
  let gainR = 0;
  for (const tap of taps) {
    const sample = fetchSampleAtFrame(tap.frameFloat);
    const panAngle = (Math.PI / 4) * (1 + tap.pan);
    const gl = Math.cos(panAngle) * tap.weight;
    const gr = Math.sin(panAngle) * tap.weight;
    sumL += sample * gl;
    sumR += sample * gr;
    gainL += gl;
    gainR += gr;
  }
  return { l: gainL > 0 ? sumL / gainL : 0, r: gainR > 0 ? sumR / gainR : 0 };
}
