// packages/web/src/lib/video/modules/b3ntb0x-dsp.ts
//
// B3NTB0X — pure (no-WebGL) DSP helpers for the circuit-level NTSC
// composite re-architecture. These are the load-bearing math primitives
// that the four GLSL passes (EncodeComposite → BendCircuit →
// DecodeComposite → CRTDisplay) mirror; keeping them in plain TS lets the
// encode↔decode invertibility contract + the nonlinearity bounds be
// unit-tested in jsdom WITHOUT a GPU (jsdom can't exercise GL — see
// engine.ts:299-304; float-FBO + 4-pass correctness is only verifiable in
// a real-GL ART/e2e harness).
//
// THE MODEL (Phase 1). Unlike BENTBOX — which works symbolically in the
// RGB/YIQ domain in a single pass — B3NTB0X builds a REAL per-column
// composite VOLTAGE along an oversampled NTSC line:
//
//   active composite v = Y + I*cos(phase) + Q*sin(phase)
//
// on the 3.579545 MHz chroma subcarrier, with sync-tip / blanking /
// back-porch + colour-burst voltages in the non-active regions. The bend
// circuit then processes THAT voltage as an analog signal (AC coupling →
// gain/ENHANCE → bias → soft-clip/diode-clamp/asymmetric saturation), and
// the decoder demodulates I/Q back by carrier phase + a horizontal
// low-pass. Sync crush, dot-crawl, and rainbow EMERGE from the circuit —
// they are not cosmetic hacks.
//
// Attribution: the YIQ matrix + the 3.579545 MHz subcarrier + RS-170A line
// geometry are public-domain physics (FCC RS-170A), re-derived clean here.
// The algorithm SHAPE (per-column composite synthesis, quadrature
// synchronous demod with a Gaussian horizontal LP) is informed by two
// MIT-licensed references — LMP88959's NTSC-CRT
// (https://github.com/LMP88959/NTSC-CRT) and the classic Blargg `ntsc`
// filter (~2003) — but NO code is copied from either, and NOTHING is
// imported from the existing BENTBOX / TOYBOX / QUADRALOGICAL modules.

// ---------------------------------------------------------------------------
// Colour-space conversion (standard NTSC FCC RS-170A matrices).
// ---------------------------------------------------------------------------

/** RGB (0..1) → YIQ. Y ≈ luma in [0,1]; I, Q roughly in [-0.6, 0.6]. */
export function rgbToYiq(r: number, g: number, b: number): { y: number; i: number; q: number } {
  return {
    y: 0.299 * r + 0.587 * g + 0.114 * b,
    i: 0.595716 * r - 0.274453 * g - 0.321263 * b,
    q: 0.211456 * r - 0.522591 * g + 0.311135 * b,
  };
}

/** YIQ → RGB, clamped to [0,1]. Inverse of {@link rgbToYiq}. */
export function yiqToRgb(y: number, i: number, q: number): { r: number; g: number; b: number } {
  const r = y + 0.9563 * i + 0.6210 * q;
  const g = y - 0.2721 * i - 0.6474 * q;
  const b = y - 1.1070 * i + 1.7046 * q;
  return {
    r: Math.max(0, Math.min(1, r)),
    g: Math.max(0, Math.min(1, g)),
    b: Math.max(0, Math.min(1, b)),
  };
}

// ---------------------------------------------------------------------------
// NTSC line geometry + composite voltages.
//
// We model ONE active picture region per output row (the upstream image is
// the active picture) with fixed-fraction porches so the decoder has a real
// sync edge + burst to lock to. Fractions of the total line H_TOTAL,
// expressed as a column position `lineFrac` in [0, 1):
//
//   SYNC TIP        ~0.000 .. 0.075   voltage -0.3  (40 IRE below blank)
//   BLANKING/PORCH  ~0.075 .. 0.100   voltage  0.0  (front + back porch)
//   COLOUR BURST    ~0.100 .. 0.140   8-9 cycles, amp ~0.15, phase 180°
//   BACK PORCH      ~0.140 .. 0.160   voltage  0.0
//   ACTIVE VIDEO    ~0.160 .. 1.000   the picture (Y + I cos + Q sin)
// ---------------------------------------------------------------------------

export const SYNC_TIP_END = 0.075;
export const BLANK_END = 0.10;
export const BURST_END = 0.14;
export const ACTIVE_START = 0.16;

/** Composite voltages for the fixed (non-active) regions. */
export const SYNC_TIP_VOLTAGE = -0.3;
export const BLANK_VOLTAGE = 0.0;
export const BURST_AMPLITUDE = 0.15;

/** Sync-mask region tag written to the A channel. */
export const REGION_SYNC = 0.0;
export const REGION_BLANK = 0.25;
export const REGION_BURST = 0.5;
export const REGION_ACTIVE = 1.0;

/** Which region does a column fraction fall in? Returns the A-channel tag. */
export function regionTagForColumn(lineFrac: number): number {
  if (lineFrac < SYNC_TIP_END) return REGION_SYNC;
  if (lineFrac < BLANK_END) return REGION_BLANK;
  if (lineFrac < BURST_END) return REGION_BURST;
  if (lineFrac < ACTIVE_START) return REGION_BLANK; // back porch after burst
  return REGION_ACTIVE;
}

/**
 * The FIXED composite voltage for a non-active column (sync tip / blanking /
 * back porch). Returns BLANK_VOLTAGE for the burst + active regions — the
 * caller adds the burst carrier (and the active picture) on top, because
 * those depend on the subcarrier phase. Sync tip is the only sub-blanking
 * level; this is what the bend stage CRUSHES when gain + bias push it
 * through the clip with no protective clamp.
 */
export function syncVoltageForColumn(lineFrac: number): number {
  if (lineFrac < SYNC_TIP_END) return SYNC_TIP_VOLTAGE;
  return BLANK_VOLTAGE; // blanking, porches, and the DC base of burst/active
}

// ---------------------------------------------------------------------------
// Subcarrier + composite synthesis.
// ---------------------------------------------------------------------------

/**
 * Subcarrier phase at oversampled active-column index `colIdx`, given
 * `period` oversampled pixels per carrier cycle and a `burstPhase` offset
 * (radians). phase = 2π·colIdx/period + burstPhase.
 */
export function subcarrierPhase(colIdx: number, period: number, burstPhase: number): number {
  return (2 * Math.PI * colIdx) / period + burstPhase;
}

/** Active composite voltage: v = Y + I·cos(phase) + Q·sin(phase). */
export function encodeComposite(y: number, i: number, q: number, phase: number): number {
  return y + i * Math.cos(phase) + q * Math.sin(phase);
}

/** Colour-burst voltage on the back porch: BURST_AMPLITUDE · cos(phase + π).
 *  Burst sits 180° from the +I axis (the reference phase the decoder locks
 *  to). `starve` (0..1) attenuates the burst amplitude — starving the
 *  decoder's phase reference (the Burst Starve control). */
export function burstVoltage(phase: number, starve = 0): number {
  return BURST_AMPLITUDE * (1 - Math.max(0, Math.min(1, starve))) * Math.cos(phase + Math.PI);
}

// ---------------------------------------------------------------------------
// Bend-circuit signal-chain primitives. All operate on the scalar composite
// voltage `v`.
// ---------------------------------------------------------------------------

/**
 * One-pole high-pass / leaky-baseline AC-coupling. Returns BOTH the
 * AC-coupled output (v − baseline) and the NEW baseline (leaked toward v by
 * `alpha`). The new baseline must be persisted (Phase-1: in the Bend
 * ping-pong float buffer) so the integrator is real across frames/columns.
 *
 *   baseline' = baseline + alpha·(v − baseline)
 *   out       = v − baseline'
 *
 * alpha → 0 : baseline barely tracks → strong HP (removes DC, asymmetric
 *             clip about the floating baseline).
 * alpha → 1 : baseline snaps to v → out ≈ 0 (full coupling) — so for DC
 *             passthrough the CALLER blends `out` toward `v` (see acCoupleMix).
 */
export function onePoleHP(v: number, baseline: number, alpha: number): { out: number; baseline: number } {
  const a = Math.max(0, Math.min(1, alpha));
  const nb = baseline + a * (v - baseline);
  return { out: v - nb, baseline: nb };
}

/**
 * Input coupling crossfade. `coupling` 0 = DC passthrough (output = v),
 * 1 = fully AC-coupled (output = the leaky-HP result). The leaky-HP runs
 * with a fixed small alpha so the baseline drifts slowly; `coupling` only
 * sets how much of the HP'd signal replaces the DC signal. Returns the new
 * baseline so the caller can persist it.
 */
export function acCoupleMix(
  v: number,
  baseline: number,
  coupling: number,
  alpha = 0.02,
): { out: number; baseline: number } {
  const hp = onePoleHP(v, baseline, alpha);
  const c = Math.max(0, Math.min(1, coupling));
  return { out: v * (1 - c) + hp.out * c, baseline: hp.baseline };
}

/**
 * ENHANCE — luma/HF peaking. High-pass the local composite (v minus the
 * average of its horizontal neighbours) and add it back scaled by `amt`,
 * sharpening edges + over-ringing (the AVE "Enhance" control).
 */
export function enhancePeak(v: number, neighborAvg: number, amt: number): number {
  return v + (v - neighborAvg) * amt;
}

/** Padé tanh-approximation soft-clip: v·(27 + v²)/(27 + 9v²). Monotonic,
 *  smooth, compressive (|out| < |in| for |in| ≳ 0.6), asymptotes to v/9. */
export function softClip(v: number): number {
  const v2 = v * v;
  return (v * (27 + v2)) / (27 + 9 * v2);
}

/**
 * Diode clamp — one-sided HARD clamp. Positive excursions clamp at `ceil`,
 * negative at `floor`. The asymmetry is the point: with `floor` well below
 * the sync tip, a high-gain/biased path drags the sync tip up THROUGH the
 * clamp and crushes it (the decoder then fails to lock → tearing/rolling).
 */
export function diodeClamp(v: number, ceil: number, floor: number): number {
  return Math.max(floor, Math.min(ceil, v));
}

/**
 * Asymmetric saturation — different soft-clip DRIVE for the + and − halves.
 * v ≥ 0 is driven by `driveP`, v < 0 by `driveN`, then soft-clipped and
 * normalized back by the drive so unity drive is ≈ plain softClip. Larger
 * drive on one half saturates that half harder (even-harmonic asymmetry).
 */
export function asymSat(v: number, driveP: number, driveN: number): number {
  const d = v >= 0 ? Math.max(1e-6, driveP) : Math.max(1e-6, driveN);
  return softClip(v * d) / softClip(d);
}

// ---------------------------------------------------------------------------
// Decoder primitives — quadrature synchronous demod + Gaussian horizontal LP.
// ---------------------------------------------------------------------------

/** Gaussian tap weight for the horizontal LP: exp(−2·k²/N²). */
export function gaussianWeight(k: number, n: number): number {
  return Math.exp((-(k * k) / (n * n)) * 2);
}

/**
 * Reference quadrature demodulator + horizontal low-pass. Given a window of
 * composite `samples` and the per-sample carrier `phases` (recovered burst
 * phase, NOT a clean pixel-x carrier), plus matching Gaussian `weights`,
 * recover Y / I / Q:
 *
 *   ySum += c·w ;  iSum += c·2cos(phase)·w ;  qSum += c·2sin(phase)·w
 *   Y = ySum/Σw ;  I = iSum/Σw ;  Q = qSum/Σw
 *
 * The Σw-normalized accumulation IS the low-pass; the 2× on I/Q is the
 * standard synchronous-demod gain (the chroma sits at half-amplitude after
 * the cos/sin product, so doubling recovers the modulated value). This is
 * the invertible counterpart of encodeComposite — a clean encode→demod
 * round-trip recovers the input Y/I/Q within the LP tolerance.
 */
export function quadDemod(
  samples: readonly number[],
  phases: readonly number[],
  weights: readonly number[],
): { y: number; i: number; q: number } {
  let ySum = 0;
  let iSum = 0;
  let qSum = 0;
  let wSum = 0;
  const n = Math.min(samples.length, phases.length, weights.length);
  for (let k = 0; k < n; k++) {
    const c = samples[k]!;
    const ph = phases[k]!;
    const w = weights[k]!;
    ySum += c * w;
    iSum += c * 2 * Math.cos(ph) * w;
    qSum += c * 2 * Math.sin(ph) * w;
    wSum += w;
  }
  if (wSum === 0) return { y: 0, i: 0, q: 0 };
  return { y: ySum / wSum, i: iSum / wSum, q: qSum / wSum };
}

// ---------------------------------------------------------------------------
// MIRROR fold (ported clean from the kaleidoscope convention — NOT imported
// from bentbox). Visual-top = uv.y ≥ 0.5 (BACKDRAFT-verified).
// ---------------------------------------------------------------------------

/** Pure CPU mirror of the CRT shader's mirrorUv(): MIRROR X keeps u<0.5 and
 *  reflects the right half (1−u); MIRROR Y keeps the visual-top half
 *  (uv.y≥0.5) and reflects the low half (1−v). */
export function b3ntb0xMirrorUv(
  u: number,
  v: number,
  mirrorX: boolean,
  mirrorY: boolean,
): { u: number; v: number } {
  return {
    u: mirrorX ? (u < 0.5 ? u : 1 - u) : u,
    v: mirrorY ? (v >= 0.5 ? v : 1 - v) : v,
  };
}

// ---------------------------------------------------------------------------
// BURST STARVE (decode-side colour-burst starvation).
// ---------------------------------------------------------------------------

/** Strength of the subcarrier-into-luma crawl at full burst starvation. The
 *  DECODE shader (b3ntb0x.ts DECODE_FRAG) keeps an inline copy of this
 *  constant; this is the unit-tested source of truth. */
export const BURST_STARVE_CRAWL = 0.35;

/** Pure CPU mirror of the DECODE pass's BURST STARVE math (see b3ntb0x.ts
 *  DECODE_FRAG). Starving the colour burst (`burstStarve` 0→1) robs the
 *  decoder of its phase / ACC reference, with two faithful consequences:
 *    1) COLOUR KILLER — chroma gain (i,q) collapses toward 0 (desaturation).
 *    2) SUBCARRIER CRAWL — the RAW (pre-kill) subcarrier energy |i|+|q| is no
 *       longer notched out of luma, so a fraction crawls into Y as dot-crawl.
 *  Returns the post-kill chroma + the luma crawl term to ADD to Y. At
 *  `burstStarve` 0 this is the identity (i,q unchanged, lumaCrawl 0); the GLSL
 *  inlines the same arithmetic so the two cannot diverge silently. */
export function b3ntb0xBurstStarve(
  i: number,
  q: number,
  burstStarve: number,
): { i: number; q: number; lumaCrawl: number } {
  const s = Math.max(0, Math.min(1, burstStarve));
  const subcarrierEnergy = Math.abs(i) + Math.abs(q); // pre-kill, for the crawl
  const colourKill = 1 - s;
  return { i: i * colourKill, q: q * colourKill, lumaCrawl: subcarrierEnergy * s * BURST_STARVE_CRAWL };
}

// ---------------------------------------------------------------------------
// HUE — receiver tint control (demod-axis rotation).
//
// A real TV "Tint/Hue" knob rotates the synchronous-demodulator's reference
// axis RELATIVE to the burst the receiver locked to. Rotating the I/Q vector
// by an angle θ is exactly what an analog phase-shift on the demod carrier
// does. Crucially this is a DECODE-side rotation: it is visible on ANY colour
// (it does not cancel against the encoder, unlike a carrier-phase change that
// the decoder also tracks). hue −1..+1 maps to ±π (one full half-turn each
// way is plenty of tint swing; ±π would alias).
// ---------------------------------------------------------------------------

/** Max demod-axis rotation (radians) at hue = ±1. ±0.9π ≈ a strong tint shift
 *  without wrapping all the way around to the same colour. Shared with the
 *  DECODE GLSL (it inlines the same constant). */
export const HUE_MAX_RAD = 0.9 * Math.PI;

/** Rotate a chroma (I,Q) vector by the receiver tint angle. `hue` −1..+1 →
 *  θ = hue·HUE_MAX_RAD. Pure rotation: magnitude (saturation) is preserved,
 *  only the colour angle (tint) changes. Identity at hue = 0. The DECODE pass
 *  applies the IDENTICAL rotation to the demodulated I/Q. */
export function b3ntb0xHueRotate(i: number, q: number, hue: number): { i: number; q: number } {
  const theta = Math.max(-1, Math.min(1, hue)) * HUE_MAX_RAD;
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  return { i: i * c - q * s, q: i * s + q * c };
}

// ---------------------------------------------------------------------------
// SUBCARRIER DRIFT — uncorrected colour-subcarrier instability (rainbow swim).
//
// The receiver locks its demod phase to the colour BURST at the START of each
// line. If the subcarrier oscillator drifts, the carrier phase the picture was
// actually modulated on diverges from that burst lock progressively ACROSS the
// active line (and wanders in time) — so the recovered chroma axis is wrong by
// an angle that GROWS left→right and animates. That is the classic "rainbow
// swimming over the picture" of an unstable colour reference. Modelled as a
// phase ERROR added to the encoder carrier but NOT reflected in the burst the
// decoder locks to (the decoder uses a clean per-line reference), so the
// mismatch is real and does not cancel.
// ---------------------------------------------------------------------------

/** Peak drift phase error (radians) per unit of active-line fraction, at
 *  drift = 1. The error at active-fraction f and time t is
 *  drift · DRIFT_PHASE_GAIN · (f + t·DRIFT_TIME_RATE). Shared with ENCODE GLSL. */
export const DRIFT_PHASE_GAIN = 6.0;
/** How fast the drift error wanders in time (cycles/sec scale). */
export const DRIFT_TIME_RATE = 0.7;

/** Phase error (radians) the subcarrier drift injects at active-line fraction
 *  `activeFrac` (0..1) and time `tSec`, for `drift` 0..1. Identity (0) at
 *  drift = 0. The ENCODE pass adds this to the active carrier phase WITHOUT
 *  folding it into the burst reference, so the decoder (burst-locked) sees a
 *  growing, animated demod-axis error → rainbow swim. */
export function b3ntb0xDriftPhase(activeFrac: number, tSec: number, drift: number): number {
  const d = Math.max(0, Math.min(1, drift));
  return d * DRIFT_PHASE_GAIN * (Math.max(0, Math.min(1, activeFrac)) + tSec * DRIFT_TIME_RATE);
}

// ---------------------------------------------------------------------------
// BEND NETWORK A–D — the circuit-bent patch points on the composite VOLTAGE.
//
// Each is a distinct, classic circuit-bend / video-mangle artifact applied to
// the analog composite voltage `v` in the BEND pass (after gain/bias, before
// the diode clamp). All are the IDENTITY at 0 so a fresh patch is clean. The
// BEND GLSL inlines the identical arithmetic; these are the unit-tested source
// of truth.
//
//   A — WAVEFOLD: reflect the voltage back on itself past a shrinking
//       threshold (classic wavefolder). Creates extra "creases" / solarised
//       banding as |bend_a| grows; sign picks fold polarity.
//   B — COMB RIPPLE: mix a fraction of a horizontally-delayed copy of the
//       voltage back in (a one-tap comb) → ringing / ghost edges / colour
//       beating. Needs the neighbour sample, so it lives inline in GLSL; the
//       CPU mirror takes the delayed sample as an argument.
//   C — CRUSH: quantise the voltage to a few steps (bit-crush / posterise) →
//       hard contour banding. Step count shrinks as |bend_c| → 1.
//   D — CHROMA→SYNC BLEED: add a fraction of the raw subcarrier ripple onto
//       the DC path (cross-coupling) → the picture modulates the baseline,
//       reading as luma buzz / rolling contamination.
// ---------------------------------------------------------------------------

/** A — WAVEFOLD. `amt` −1..+1: pre-gains the voltage then reflects any
 *  excursion past ±threshold back inward (a wavefolder); the threshold shrinks
 *  with |amt| so more of the signal folds. Identity at 0. The sign adds a small
 *  asymmetric DC kick so −/+ read differently. */
export function b3ntb0xBendFold(v: number, amt: number): number {
  const a = Math.max(-1, Math.min(1, amt));
  if (a === 0) return v;
  const mag = Math.abs(a);
  // Pre-gain pushes more of the signal past the (shrinking) fold threshold.
  const t = Math.max(0.1, 1.0 - 0.8 * mag);
  let folded = v * (1 + 1.5 * mag);
  // One reflection each side is enough to read as a crease/solarisation.
  if (folded > t) folded = t - (folded - t);
  else if (folded < -t) folded = -t - (folded + t);
  // Blend dry→folded by |a|; sign adds an asymmetric DC kick.
  return v * (1 - mag) + folded * mag + a * 0.05;
}

/** B — COMB RIPPLE. Mix `amt`·(delayed sample) into v (a one-tap comb).
 *  `vDelayed` is the voltage a few oversampled px to the side. Identity at 0. */
export function b3ntb0xBendComb(v: number, vDelayed: number, amt: number): number {
  const a = Math.max(-1, Math.min(1, amt));
  return v + a * 0.6 * (vDelayed - v);
}

/** C — CRUSH. Quantise v to N steps; N shrinks 64 → 3 as |amt| → 1.
 *  Identity-ish at 0 (64 steps ≈ smooth). */
export function b3ntb0xBendCrush(v: number, amt: number): number {
  const a = Math.abs(Math.max(-1, Math.min(1, amt)));
  if (a === 0) return v;
  const steps = Math.max(3, Math.round(64 * (1 - a) + 3 * a));
  return Math.round(v * steps) / steps;
}

/** D — CHROMA→SYNC BLEED. Add `amt`·(subcarrier ripple) onto the DC path.
 *  `ripple` = v minus its local baseline (the HF/chroma content). Identity at
 *  0; cross-couples the picture into the baseline as |amt| grows. */
export function b3ntb0xBendBleed(v: number, ripple: number, amt: number): number {
  const a = Math.max(-1, Math.min(1, amt));
  return v + a * 0.8 * ripple;
}

// ---------------------------------------------------------------------------
// AC/DC COUPLING droop — strengthened so it is visible on a STATIC scene.
//
// True capacitive (AC) coupling removes the DC level: a large flat bright area
// droops back toward mid-grey because the coupling cap can't hold DC. The
// original leak was so slow that on a still frame baseline ≈ DC ≈ v, so the
// HP'd signal ≈ 0 → no visible change. We expose the coupling strength and a
// FAST-enough leak so flat areas visibly lose their DC pedestal.
// ---------------------------------------------------------------------------

/** Leak coefficient for the AC-coupling one-pole at full coupling. Larger =
 *  the baseline tracks v faster = more DC removed even within a still frame.
 *  Shared with the BEND GLSL. */
export const AC_LEAK_ALPHA = 0.08;
