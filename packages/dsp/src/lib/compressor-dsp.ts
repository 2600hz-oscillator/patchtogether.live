// packages/dsp/src/lib/compressor-dsp.ts
//
// SIDECAR — pure DSP helpers for the stereo sidechain compressor. Lives in
// `lib/` so esbuild inlines it into packages/dsp/src/sidecar.ts at build
// time (top-level .ts files in packages/dsp/src/ are the worklet entries;
// their helpers go under lib/ and can `export` freely).
//
// ─────────────────────────────────────────────────────────────────────────
// Canonical reference: Giannoulis, Massberg & Reiss, "Digital Dynamic Range
// Compressor Design — A Tutorial and Analysis", J. Audio Eng. Soc., Vol. 60,
// No. 6, June 2012 (hereafter "GMR 2012"). Cross-checked against Faust's
// stdfaust `co.compressor_stereo` (Faust libraries/compressors.lib) which
// uses the same log-domain gain-computer + one-pole smoother topology.
// ─────────────────────────────────────────────────────────────────────────
//
// Topology (matches the spec in the feasibility plan):
//
//   sc_l, sc_r ──► one-pole HPF (sc_hpf) ──► |sL| + |sR|  (stereo-link
//                                                          peak detector)
//                                              │
//                                              ▼
//                              log2 → 3-region soft-knee gain computer
//                                              │
//                                              ▼
//                              asymmetric one-pole smoother (att / rel)
//                                              │
//                                              ▼
//                                  gainDb (negative = reduction)
//                                              │
//                                              ▼
//                                  lin = exp2(gainDb / 6.0205)
//
// Magic number 6.0205 = 20*log10(2) — the conversion factor that turns
// log2 → dB. Using log2/exp2 in the smoother lets the asymmetric one-pole
// run linearly in dB, which is the standard GMR (eq 7) trick: the level
// detector operates on log-magnitude so the attack/release time constants
// are dB-domain (i.e. exponential gain trajectories in the linear domain,
// which matches how analog VCAs ramp).
//
// Sidechain stereo-link mode is always-on (no toggle in v1). The detector
// signal is `|sL| + |sR|` — equivalent to the L+R sum-of-rectifiers used
// by Faust's `co.compressor_stereo` and most hardware bus comps (SSL,
// dbx-160). For mono sources the sum collapses to `2*|s|`, which the
// gain computer's log curve handles cleanly (the +6 dB offset is absorbed
// into the `threshold` knob's perceptual calibration).
//
// env_out semantics (NO hard clamp — by design, per the user override):
//   env_out = (-gainDb / envScaleDb) * envMag
//   With envScaleDb = 24 dB:
//     - at envMag=1 and reduction=24 dB, env_out saturates to 1.0
//     - at envMag=2 and reduction=24 dB, env_out reaches 2.0 (overshoot)
//   Downstream modules MUST tolerate env_out > 1.0 when envMag > 1.
//   env_inv_out = 1 - env_out, also un-clamped (can go negative when
//   env_out > 1).
//
// All functions are deterministic + state-only-via-explicit-state-object,
// so the unit tests can pin per-sample math without touching the worklet.

// ─────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────

/** 20*log10(2). Conversion: dB = 20*log10(lin); since log2 = log10/log10(2),
 *  dB = (20*log10(2)) * log2(lin) = 6.0205... * log2(lin). Equivalently
 *  lin = 2^(dB / 6.0205). Used to bridge between the dB-domain smoother
 *  and the linear-domain VCA multiply. */
export const DB_PER_LOG2 = 20 * Math.log10(2); // ≈ 6.020599913...

/** Floor for log2 of zero-or-tiny inputs. -120 dB ≈ 1e-6 in linear
 *  amplitude, ≈ -19.93 in log2. */
export const LOG2_FLOOR = -20;

/** Default env_out scaling — 24 dB of reduction saturates env_out to 1.0
 *  when envMag=1. Spec choice (NOT a knob; documented constant). */
export const ENV_SCALE_DB = 24;

// ─────────────────────────────────────────────────────────────────────────
// One-pole HPF on the sidechain detector input (NOT the audio path).
//
// Standard one-pole HPF from RBJ cookbook / pirkle's "Designing Audio
// Effect Plugins in C++". For a corner frequency fc:
//   a = exp(-2π·fc / sr)
//   y[n] = a * (y[n-1] + x[n] - x[n-1])
// Steady-state: blocks DC + low frequencies; passes high frequencies.
// Cheap (3 mults + 1 add per sample) and click-free under fc modulation
// because the coefficient varies smoothly with fc.
// ─────────────────────────────────────────────────────────────────────────

export interface HpfState {
  /** Last-sample input (x[n-1]). */
  xPrev: number;
  /** Last-sample output (y[n-1]). */
  yPrev: number;
}

export function makeHpfState(): HpfState {
  return { xPrev: 0, yPrev: 0 };
}

/** One-pole HPF coefficient for a corner frequency fc (Hz) at sr (Hz). */
export function hpfCoef(fcHz: number, sr: number): number {
  // Clamp fc to a sane range to keep `a` ∈ (0, 1). At fc=0 the HPF is a
  // unity-gain pass-through (a=1, y=y+x-xprev); since x-xprev≈0 for slow
  // signals the output decays to 0 over many samples, which is the
  // intended "DC blocker at 20 Hz" behavior. We keep fc=20 as the
  // effective "off" position rather than special-casing fc=0.
  const f = Math.max(0.1, Math.min(sr * 0.49, fcHz));
  return Math.exp(-2 * Math.PI * f / sr);
}

/** Per-sample one-pole HPF. Mutates `state` in place. */
export function hpfStep(x: number, a: number, state: HpfState): number {
  const y = a * (state.yPrev + x - state.xPrev);
  state.xPrev = x;
  state.yPrev = y;
  return y;
}

// ─────────────────────────────────────────────────────────────────────────
// Soft-knee gain computer in log2 domain (GMR 2012 eq 4).
//
// Inputs:
//   xLog2  — input level in log2 (i.e. 6.0205 * xLog2 = level in dB)
//   tDb    — threshold in dB (negative number, e.g. -18)
//   knDb   — knee width in dB (full width; 0 = hard knee)
//   ratio  — compression ratio (1 = no compression, ∞ = limiter)
//
// Returns: gainDb — the amount of gain to apply, in dB. Always ≤ 0 for
// compression. Above threshold + knee/2: linear slope -(1 - 1/ratio).
// Below threshold - knee/2: gainDb = 0 (no reduction).
// Across the knee: quadratic interpolation (C0-continuous + smooth).
//
// Working in log2 internally rather than dB just to skip a constant
// multiply per sample; we still report gainDb in dB units.
// ─────────────────────────────────────────────────────────────────────────

export function computeGainDb(
  xLog2: number,
  tDb: number,
  knDb: number,
  ratio: number,
): number {
  const xDb = DB_PER_LOG2 * xLog2;
  const slope = 1 - 1 / Math.max(1, ratio); // -ve gain slope above threshold
  const halfKn = knDb * 0.5;

  if (knDb <= 0 || xDb <= tDb - halfKn) {
    // Hard-knee path OR below the knee: linear (or no reduction).
    if (xDb <= tDb) return 0;
    return -slope * (xDb - tDb);
  }
  if (xDb >= tDb + halfKn) {
    // Above the knee: full linear slope.
    return -slope * (xDb - tDb);
  }
  // Inside the knee: smooth quadratic transition. GMR eq 4 (knee region):
  //   y = -slope * (x - T + knee/2)^2 / (2 * knee)
  const t = xDb - tDb + halfKn;
  return -slope * (t * t) / (2 * knDb);
}

// ─────────────────────────────────────────────────────────────────────────
// Asymmetric one-pole smoother — separate attack + release time constants.
//
// Standard envelope-follower trick (GMR eq 7, also Faust co.compressor's
// `gain_computer ∘ smoother` pair):
//   if (target ≤ y)   y += (1 - aAtt) * (target - y)   // attack (faster)
//   else              y += (1 - aRel) * (target - y)   // release (slower)
//
// "Faster" because attack ramps DOWN to a lower gain (more compression)
// and release ramps UP back to less compression. Convention here:
//   target  = the desired gainDb from the computer (≤ 0)
//   y       = current smoothed gainDb (≤ 0)
//   target < y  → compressor is engaging more  → ATTACK
//   target > y  → compressor is releasing      → RELEASE
//
// Coefficient: a = exp(-1 / (tau_sec * sr)) where tau is the 1-pole
// time-constant in seconds. tau = msTime / 1000.
// ─────────────────────────────────────────────────────────────────────────

export interface SmootherState {
  /** Current smoothed gain (in dB; ≤ 0 for compression). */
  y: number;
}

export function makeSmootherState(): SmootherState {
  return { y: 0 };
}

export function smootherCoef(msTime: number, sr: number): number {
  const tau = Math.max(1e-6, msTime) * 0.001;
  return Math.exp(-1 / (tau * sr));
}

export function smootherStep(
  targetDb: number,
  aAtt: number,
  aRel: number,
  state: SmootherState,
): number {
  const a = targetDb < state.y ? aAtt : aRel;
  state.y = a * state.y + (1 - a) * targetDb;
  return state.y;
}

// ─────────────────────────────────────────────────────────────────────────
// Per-sample param smoother — kills clicks on step changes to threshold
// and envMag (per PR #435's smoother pattern). 50 Hz one-pole; ≈ 3.2 ms
// time constant which is faster than the audible click duration but slow
// enough to smear an instantaneous jump across enough samples that the
// derivative stays bounded.
// ─────────────────────────────────────────────────────────────────────────

export interface ParamSmoother {
  /** Last smoothed value. */
  y: number;
  /** Coefficient. */
  a: number;
}

export function makeParamSmoother(initial: number, sr: number, cornerHz = 50): ParamSmoother {
  return {
    y: initial,
    a: Math.exp(-2 * Math.PI * cornerHz / sr),
  };
}

export function paramSmootherStep(target: number, s: ParamSmoother): number {
  s.y = s.a * s.y + (1 - s.a) * target;
  return s.y;
}

// ─────────────────────────────────────────────────────────────────────────
// Convenience: compute env_out + env_inv_out from a gainDb. Centralizing
// here so the worklet AND the tests agree on the semantics (no hard clamp).
// ─────────────────────────────────────────────────────────────────────────

/** env_out = (-gainDb / ENV_SCALE_DB) * envMag. NO clamp; can exceed 1.0
 *  when envMag > 1 and reduction is at or beyond ENV_SCALE_DB. */
export function envOut(gainDb: number, envMag: number): number {
  return (-gainDb / ENV_SCALE_DB) * envMag;
}

/** env_inv_out = 1 - env_out. Can go negative when env_out > 1. */
export function envInvOut(envOutValue: number): number {
  return 1 - envOutValue;
}

// ─────────────────────────────────────────────────────────────────────────
// Compressor channel: the full per-sample pipeline as a single function.
// State lives in the caller-owned `SidecarState`. The worklet wraps this
// in its sample loop; the tests drive it directly.
//
// Stereo-link: a single state object is used (one smoother + one HPF L +
// one HPF R), because the gain reduction is computed from the combined
// |sL|+|sR| detector signal. The same gain factor is then applied to both
// audio channels.
// ─────────────────────────────────────────────────────────────────────────

export interface SidecarState {
  hpfL: HpfState;
  hpfR: HpfState;
  smoother: SmootherState;
  thresholdSmoother: ParamSmoother;
  envMagSmoother: ParamSmoother;
}

export function makeSidecarState(sr: number, thresholdInit = -18, envMagInit = 1): SidecarState {
  return {
    hpfL: makeHpfState(),
    hpfR: makeHpfState(),
    smoother: makeSmootherState(),
    thresholdSmoother: makeParamSmoother(thresholdInit, sr),
    envMagSmoother: makeParamSmoother(envMagInit, sr),
  };
}

export interface SidecarParams {
  /** Threshold in dB (smoothed; pass the target — internal smoother ramps). */
  threshold: number;
  /** Compression ratio ≥ 1. */
  ratio: number;
  /** Knee width in dB (full width; 0 = hard knee). */
  knee: number;
  /** envMag (smoothed; pass the target). */
  envMag: number;
  /** Makeup gain in dB (applied after compression). */
  makeup: number;
  /** Attack time constant coefficient (precomputed via smootherCoef). */
  aAtt: number;
  /** Release time constant coefficient. */
  aRel: number;
  /** Sidechain HPF coefficient (precomputed via hpfCoef). */
  hpfA: number;
}

export interface SidecarOutputs {
  outL: number;
  outR: number;
  envOut: number;
  envInvOut: number;
  /** Useful for tests — the smoothed gainDb that was applied. */
  gainDb: number;
}

/** One sample through the full Sidecar pipeline. */
export function sidecarStep(
  audioL: number,
  audioR: number,
  scL: number,
  scR: number,
  p: SidecarParams,
  state: SidecarState,
): SidecarOutputs {
  // 1) Per-sample-smoothed scalar params (kill clicks on jumps).
  const thr = paramSmootherStep(p.threshold, state.thresholdSmoother);
  const eMg = paramSmootherStep(p.envMag, state.envMagSmoother);

  // 2) Sidechain HPF (detector path only — does NOT touch the audio path).
  const fL = hpfStep(scL, p.hpfA, state.hpfL);
  const fR = hpfStep(scR, p.hpfA, state.hpfR);

  // 3) Stereo-link peak detector: |sL| + |sR|.
  const mag = Math.abs(fL) + Math.abs(fR);

  // 4) log2 of magnitude (floor to avoid -∞).
  const xLog2 = mag > 0 ? Math.log2(mag) : LOG2_FLOOR;

  // 5) Static gain computer (soft knee).
  const targetDb = computeGainDb(xLog2, thr, p.knee, p.ratio);

  // 6) Asymmetric smoother (attack / release).
  const gainDb = smootherStep(targetDb, p.aAtt, p.aRel, state.smoother);

  // 7) Linear gain for the audio multiply (log2 → linear via 2^(dB/6.0205)).
  const lin = Math.pow(2, gainDb / DB_PER_LOG2);

  // 8) Makeup (linear, post).
  const makeupLin = Math.pow(2, p.makeup / DB_PER_LOG2);

  const outL = audioL * lin * makeupLin;
  const outR = audioR * lin * makeupLin;

  // 9) Envelope-out path (post-smoother, no clamp).
  const eo = envOut(gainDb, eMg);
  const eio = envInvOut(eo);

  return { outL, outR, envOut: eo, envInvOut: eio, gainDb };
}
