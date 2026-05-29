// packages/dsp/src/lib/resofilter-dsp.ts
//
// RESOFILTER — shared DSP helpers for the multi-mode filter ported from
// gabrielsoule/resonarium (Source/dsp/MultiFilter.{h,cpp}). Lives in `lib/`
// so esbuild inlines it into packages/dsp/src/resofilter.ts at build time
// (top-level .ts files in packages/dsp/src/ are the worklet entries; their
// helpers go under lib/ and can `export` freely).
//
// Mode set — from Resonarium's MultiFilter::Type enum + filterTextFunction
// (Source/Parameters.cpp lines 7-21). Upstream enumerates: none, LP, HP, BP,
// NT (notch), AP (allpass). We drop `none` (we have a Mix knob) so the user-
// facing mode list is exactly the five active filter characters.
//
//   index   short   long              topology (per channel)
//   ─────   ─────   ────              ───────────────────────────────────────
//     0     LP      Low-pass          SVF lp tap
//     1     HP      High-pass         SVF hp tap
//     2     BP      Band-pass         SVF bp tap
//     3     NT      Notch             SVF hp + lp tap  (= input - bp tap)
//     4     AP      Allpass           SVF lp + hp − k*bp (TPT allpass form)
//
// Topology — Cytomic / Zavalishin TPT (topology-preserving transform) SVF.
// All five characters are derived from one SVF state per channel, so the
// MODE dial is just an output picker — no state reset, smooth crossfade-free
// switching. Upstream Resonarium uses juce::dsp::IIR direct-form biquads;
// TPT was chosen here because (a) it is stable under audio-rate cutoff
// modulation, which the CV input enables, and (b) the BLADES module in
// this codebase already uses TPT and the implementations stay consistent.
//
//   g  = tan(π * fc / sr)
//   k  = 2 - 2 * res                  (k=0.003 floor — edge of self-osc)
//   a1 = 1 / (1 + g * (g + k))
//   a2 = g * a1
//   a3 = g * a2
//   v3 = in - ic2eq
//   v1 = a1 * ic1eq + a2 * v3
//   v2 = ic2eq + a2 * ic1eq + a3 * v3
//   ic1eq = 2 * v1 - ic1eq
//   ic2eq = 2 * v2 - ic2eq
//   lp = v2;   bp = v1;   hp = in - k * v1 - v2
//   notch = lp + hp = in - k * v1
//   allpass = lp + hp - k * bp = in - 2 * k * v1
//
// Cutoff smoothing — a one-pole low-pass at ~50 Hz applied to the cutoff
// signal inside the worklet (see RfSmoother) keeps the SVF coefficient g
// from snapping on sample-by-sample CV jumps, which the steep transfer
// function would otherwise emit as a click. This is in addition to the
// existing CV-into-AudioParam `setTargetAtTime` smoothing on the web side.

/** Long-form mode display strings, indexed by `mode` param value 0..4. */
export const RESOFILTER_MODE_NAMES = [
  'Low-pass',
  'High-pass',
  'Band-pass',
  'Notch',
  'Allpass',
] as const;

/** Short tags matching Resonarium's filterTextFunction output. */
export const RESOFILTER_MODE_SHORT = ['LP', 'HP', 'BP', 'NT', 'AP'] as const;

export type ResofilterMode = 0 | 1 | 2 | 3 | 4;
export const RESOFILTER_MODE_COUNT = RESOFILTER_MODE_NAMES.length;
export const RESOFILTER_MAX_MODE = RESOFILTER_MODE_COUNT - 1;

export interface SvfState { ic1: number; ic2: number; }

/** Allocate a zeroed SVF state. */
export function makeSvfState(): SvfState {
  return { ic1: 0, ic2: 0 };
}

/** Map resonance (0..1) → damping k. Higher resonance = smaller k = sharper
 *  peak / louder self-oscillation. Clamped above 0 so the SVF denominator
 *  a1 = 1/(1+g*(g+k)) stays well-defined. */
export function resToK(res: number): number {
  const r = res < 0 ? 0 : res > 1 ? 1 : res;
  return Math.max(0.003, 2 - 2 * r);
}

/** Compute g = tan(π * fc / sr), clamped to a safe range near Nyquist. */
export function cutoffToG(fcHz: number, sr: number): number {
  const fmin = 10;
  const fmax = sr * 0.49;
  const fc = fcHz < fmin ? fmin : fcHz > fmax ? fmax : fcHz;
  return Math.tan(Math.PI * fc / sr);
}

/** Step one SVF tick. Returns { lp, bp, hp } from the same shared state.
 *  Mutates `state` in place. */
export function svfStep(
  input: number,
  g: number,
  k: number,
  state: SvfState,
): { lp: number; bp: number; hp: number } {
  const a1 = 1 / (1 + g * (g + k));
  const a2 = g * a1;
  const a3 = g * a2;
  const v3 = input - state.ic2;
  const v1 = a1 * state.ic1 + a2 * v3;
  const v2 = state.ic2 + a2 * state.ic1 + a3 * v3;
  state.ic1 = 2 * v1 - state.ic1;
  state.ic2 = 2 * v2 - state.ic2;
  return { lp: v2, bp: v1, hp: input - k * v1 - v2 };
}

/** Pick the active mode's output from a single SVF tick. */
export function pickModeOutput(
  taps: { lp: number; bp: number; hp: number },
  mode: ResofilterMode,
  k: number,
): number {
  switch (mode) {
    case 0: return taps.lp;
    case 1: return taps.hp;
    case 2: return taps.bp;
    case 3: return taps.lp + taps.hp;            // notch = lp + hp
    case 4: return taps.lp + taps.hp - k * taps.bp; // allpass form
    default: return taps.lp;
  }
}

/** One sample through the filter, for tests + worklet inner loop. */
export function resofilterStep(
  input: number,
  fcHz: number,
  res: number,
  mode: ResofilterMode,
  state: SvfState,
  sr: number,
): number {
  const g = cutoffToG(fcHz, sr);
  const k = resToK(res);
  const taps = svfStep(input, g, k, state);
  return pickModeOutput(taps, mode, k);
}

/** One-pole cutoff smoother — corner frequency in Hz, defaults to 50 Hz.
 *  Use one instance per channel; share between channels would couple their
 *  effective cutoff which we don't want. */
export class RfSmoother {
  private y = 0;
  private alpha: number;

  constructor(sr: number, cornerHz = 50) {
    // 1-pole LP: y = y + α (x - y); α = 1 - exp(-2π fc / sr).
    this.alpha = 1 - Math.exp(-2 * Math.PI * cornerHz / sr);
  }

  /** Reset to a target value (use on construction or large reset events). */
  prime(v: number): void { this.y = v; }

  step(x: number): number {
    this.y += this.alpha * (x - this.y);
    return this.y;
  }
}

/** Stateful per-channel filter — bundles SVF state + cutoff smoother +
 *  dry-mix bookkeeping. The worklet allocates two of these (L, R). */
export class ResofilterChannel {
  private state: SvfState;
  private smoother: RfSmoother;

  constructor(sr: number) {
    this.state = makeSvfState();
    this.smoother = new RfSmoother(sr, 50);
    this.smoother.prime(1000);
  }

  /** Process one sample. Returns the wet/dry-mixed output.
   *  `cutoffHz` is the requested cutoff this sample; it gets smoothed
   *  internally so callers can pass the raw a-rate CV value without
   *  worrying about zipper noise. */
  step(
    x: number,
    cutoffHz: number,
    res: number,
    mode: ResofilterMode,
    mix: number,
    sr: number,
  ): number {
    const fcSmoothed = this.smoother.step(cutoffHz);
    const wet = resofilterStep(x, fcSmoothed, res, mode, this.state, sr);
    const m = mix < 0 ? 0 : mix > 1 ? 1 : mix;
    return (1 - m) * x + m * wet;
  }

  /** Read the smoothed cutoff (mostly for tests). */
  smoothedCutoff(): number { return (this.smoother as unknown as { y: number }).y; }
}

/** Pure-math render helper — used by the unit + DSP-lib tests so we can pin
 *  filter response without spinning up an AudioWorklet. Returns a Float32Array
 *  of length `input.length`. */
export function renderResofilter(
  input: Float32Array,
  opts: {
    cutoffHz: number;       // constant — for ramp tests, pass a Float32Array via cutoffArr
    cutoffArr?: Float32Array;
    res: number;
    mode: ResofilterMode;
    mix?: number;           // 0..1, default 1 (full wet)
    sr: number;
  },
): Float32Array {
  const ch = new ResofilterChannel(opts.sr);
  const out = new Float32Array(input.length);
  const mix = opts.mix ?? 1;
  for (let i = 0; i < input.length; i++) {
    const fc = opts.cutoffArr ? (opts.cutoffArr[i] ?? opts.cutoffHz) : opts.cutoffHz;
    out[i] = ch.step(input[i] ?? 0, fc, opts.res, opts.mode, mix, opts.sr);
  }
  return out;
}
