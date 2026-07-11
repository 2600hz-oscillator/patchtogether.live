// packages/dsp/src/lib/tidy-vco-dsp.ts
//
// TIDY VCO (id `tidyVco`) — flagship virtual-analog SUBTRACTIVE SYNTH VOICE:
// 2 morphable oscillators + sub → nonlinear ZDF DIODE LADDER → dual RC-curve
// ADSR (filter + amp) → OTA-flavored VCA → stereo. 5-voice poly (the house
// polyPitchGate bus) AND mono pitch/gate with a real 2-voice unison spread.
//
// ── The research corner (owner directive: NEW DSP, distinct from the
//    catalog's filter/EG/VCA flavors) ─────────────────────────────────────
//
// Catalog occupancy at time of writing: `lib/moog-ladder-dsp.ts` is a TPT
// TRANSISTOR ladder (unidirectional cascade, linear forward path, tanh only
// in the feedback branch); `lib/resofilter-dsp.ts` is the clean linear TPT
// SVF; `lib/adsr-env.ts` is the Helm LINEAR-attack ADSR; VCAs everywhere are
// bare gain multiplies. TIDY VCO deliberately occupies a DIFFERENT corner of
// the VA literature on all three axes:
//
//   FILTER — a zero-delay-feedback DIODE LADDER (the EMS VCS3 / Roland
//   TB-303 lineage; Zavalishin, "The Art of VA Filter Design" rev 2.x, the
//   diode-ladder chapter). Unlike the transistor ladder's one-way cascade,
//   the diode chain couples stages BIDIRECTIONALLY — each internal node
//   feeds current both up and down the ladder. Linearized node equations
//   (equal caps, equal small-signal diode conductance, ωc-normalized):
//
//     y1' = ωc·( (u − y1) + ½(y2 − y1) )        u = comp·drive(x) − fb(y4)
//     y2' = ωc·( ½(y1 − y2) + ½(y3 − y2) )
//     y3' = ωc·( ½(y2 − y3) + ½(y4 − y3) )
//     y4' = ωc·( ½(y3 − y4) )
//
//   Analysis of this system (numeric, pinned in the unit tests): DC gain 1;
//   poles spread at {−0.076, −0.617, −1.38, −1.92}·ωc (the famously SOFT
//   diode knee — a gentle warm shave into a −24 dB/oct asymptote, nothing
//   like the transistor ladder's four coincident poles); loop phase hits
//   −180° at ωc/√2 with |H| = 1/17, so self-oscillation starts at k = 17 —
//   matching Pirkle's published diode-ladder VA analysis (App Note 6 /
//   "Designing Software Synthesizer Plug-Ins in C++") and the Csound
//   `diode_ladder` opcode it seeded. The discrete model integrates the
//   WHOLE coupled system with one trapezoidal (TPT) step and solves the
//   zero-delay feedback loop EXACTLY per sample — a hardcoded 4×4
//   elimination of (I − g·Ā + g·k·b̄·e4ᵀ), no unit delay in the linear loop,
//   unconditionally stable under audio-rate cutoff modulation.
//
//   PITCH-EXACT SELF-OSC: because trapezoidal integration maps the analog
//   axis through tan(), prewarping at the RESONANCE (not the nominal pole)
//   makes the limit-cycle pitch exact at any sample rate:
//       g = √2 · tan(π·fc/fs)   ⇒   the filter whistles AT the cutoff knob.
//   (Proof: discrete oscillation where tan(π·fd/fs)/g = Ω̄180 = 1/√2 ⇒
//   fd = fc identically.) CUTOFF is therefore calibrated to the RESONANT
//   pitch — keytracked self-osc plays in tune — while the zero-res −3 dB
//   knee sits ~3.2 octaves below it (the diode pole spread; that soft top
//   shave IS the warm character, documented, not a bug).
//
//   Nonlinearity (the warmth, Huovilainen's DAFx-04 embedded-nonlinearity
//   technique adapted to the exact-solve structure, all @2× oversampling):
//     • DRIVE tanh input stage with √-law makeup (harmonic growth, not a
//       volume knob),
//     • a FEEDBACK SQUELCH limiter — the resonance return passes through a
//       soft limiter (previous-sample residue, exact-linear at low level)
//       that compresses the resonance the way the 303's feedback buffer
//       clips: bounded, CLEAN self-osc sine instead of a runaway,
//     • a gentle always-on 3rd-order stage-1 saturator (the hottest node),
//       C1-continuous x − x³/6 clamp.
//   RESONANCE-LOSS COMPENSATION (documented choice): the raw diode ladder
//   drops the passband 1/(1+k) — a brutal −25 dB at self-osc. TIDY VCO
//   half-compensates in dB: input × (1+k)^0.6, leaving a musical few-dB
//   squelch dip (the 303 body-drop) instead of full bass loss; the boost
//   also leans on the drive stage harder at high res — authentic squelch
//   compression, measured in the tests.
//
//   EG — an RC-CURVE "punch" ADSR (CEM3310/AS3310 lineage, NOT the house
//   linear-attack Helm envelope): every segment is a true one-pole RC. The
//   attack rises exponentially toward an OVERSHOOT target of 1.08 (the
//   3310 charges toward 5.4 V and terminates at 5.0 V) and switches to
//   decay at 1.0 — a convex, front-loaded punch (value at half the attack
//   time ≈ 0.79 vs a linear ramp's 0.50; gated in the tests). Decay and
//   release are −60 dB-convention exponentials. Retrigger is ANALOG: the
//   attack resumes from the CURRENT level (click-free, and a retriggered
//   note reaches the top faster — real RC behavior). Sustain is read live.
//
//   VCA — an OTA-flavored soft knee (CA3080/LM13700 differential-pair
//   tanh), not a bare multiply: y = [tanh(W·g·x + B·g) − tanh(B·g)]/W.
//   The envelope shifts the operating point up the tanh curve (the B·g
//   bias term), producing a LEVEL-DEPENDENT even-harmonic bloom (≈ −26 dBc
//   H2 at full level for a 0.5-amp signal, fading to nothing as the note
//   dies — measured) plus ~0.4 dB of top-of-envelope knee sag. It runs
//   INSIDE the per-voice 2× oversampled section, so its harmonics can't
//   alias.
//
// ── Voice architecture ───────────────────────────────────────────────────
//   Per voice: OSC1 + OSC2, each a clean-room polyBLEP saw↔pulse MORPH
//   (SHAPE 0 = saw, 1 = pulse; Välimäki & Huovilainen, "Antialiasing
//   Oscillators in Subtractive Synthesis", IEEE SP Mag 2007) with shared
//   PW + PWM CV; OSC2 gets OCT (−1/0/+1) + DETUNE (±50 ¢); equal-power MIX;
//   a polyBLEP SUB square one octave under OSC1. The osc bus feeds the
//   diode ladder (per-voice cutoff = CUTOFF · 2^(TRACK·pitch + ENV·FEG·4oct
//   + 4oct/V·cutoff_cv)), then the OTA VCA driven by the amp EG. Voices sum
//   through equal-power pans with 1/√n normalization → LEVEL (dB) → per-
//   channel DC block → tanh true-peak bound (|out| < 1 by construction).
//
// ── Poly / mono / stereo ─────────────────────────────────────────────────
//   POLY: the 10-channel polyPitchGate bus drives voices lane→voice (fixed
//   1:1, house contract); a releasing voice HOLDS its last gated pitch (the
//   #669 release-tail rule). WIDTH fans the five voices across the field:
//   pan layout [center, L, R, half-L, half-R] · WIDTH (lane 0 = root stays
//   anchored). MONO: with no poly lane gated, the mono pitch/gate pair
//   drives a REAL 2-voice unison — voices 0/1 at ±(7 ¢ · WIDTH) drift,
//   panned ∓WIDTH, each with its OWN filter + EGs + VCA: true stereo
//   beating, not dual-mono. Poly gates take precedence the moment any lane
//   goes high.
//
// Discipline: state-object + per-block pure render (unit/ART-testable under
// node), sr-calibrated everywhere, FLUSH = 1e-20 denormal guards, no
// Math.random / Date.now — deterministic by construction.

import { clamp, dcBlockStep, makeDcBlockState, type DcBlockState } from './dsp-utils';
import { createOversampler, type Oversampler } from './oversample';

const FLUSH = 1e-20;

// ─────────────────────────────────────────────────────────────────────────
// Physical / voicing constants
// ─────────────────────────────────────────────────────────────────────────

/** V/oct anchor: 0 V = C4 (house convention). */
export const TIDY_C4_HZ = 261.626;
/** Poly bus geometry (house polyPitchGate contract). */
export const TIDY_VOICES = 5;
/** Diode-ladder self-oscillation loop gain (numeric analysis of the model
 *  above: |H(j·ωc/√2)| = 1/17 at the −180° crossing — matches Pirkle AN-6). */
export const DIODE_SELF_OSC_K = 17;
/** RES knob → k mapping: k = K_MAX·res^RES_CURVE. K_MAX runs ~15 % past the
 *  self-osc threshold (assured, saturator-bounded whistle at res = 1); the
 *  1.2 curve spreads the pre-onset squelch across more knob travel. Onset
 *  lands at res ≈ (17/19.6)^(1/1.2) ≈ 0.888 (measured in the tests). */
export const RES_K_MAX = 19.6;
const RES_CURVE = 1.2;
/** Trapezoidal prewarp at the RESONANCE: Ω̄180 = 1/√2 for this ladder, so
 *  g = √2·tan(π·fc/fs) puts the LINEAR self-osc limit cycle exactly at fc.
 *  The saturators' describing functions add a constant +7.9 ¢ at the
 *  equilibrium amplitude (measured flat across 55 Hz–5 kHz), folded in
 *  here as ×2^(−7.9/1200) and PINNED by the tuning gate in the tests. */
const RESONANCE_PREWARP = Math.SQRT2 * Math.pow(2, -7.9 / 1200);
/** Resonance-loss compensation exponent: input × (1+k)^0.6 restores most of
 *  the diode ladder's 1/(1+k) passband collapse while keeping a musical
 *  squelch dip (raw −25 dB at k=17 → net ≈ −10 dB; documented choice). */
const RES_COMP_EXP = 0.6;
/** Feedback squelch limiter half-range: the resonance return soft-clips at
 *  this level (bounded self-osc; the 303 feedback-buffer clip). Sets the
 *  self-osc limit-cycle amplitude (~1.15·FB_LIM/k at the ladder output). */
const FB_LIM = 2.5;
/** Always-on stage-1 saturator blend (the ladder's hottest node). */
const STAGE_SAT = 0.3;
/** DRIVE → input tanh pre-gain 1 … 1+DRIVE_MAX, with 1/√gain makeup so the
 *  knob grows harmonics, not volume (RMS pinned within ±2.5 dB in tests). */
const DRIVE_MAX = 7;
/** Drive makeup exponent (makeup = preGain^−0.57): keeps the knob a timbre
 *  control — output RMS pinned within ±1.5 dB across the range in tests. */
const DRIVE_MAKEUP_EXP = 0.57;
/** Whole-voice trim (post-VCA, pre-bound): lands the default mono patch
 *  near −15 dBFS RMS, the house voice level. */
const VOICE_TRIM = 1.8;
/** Filter cutoff clamps (Hz at the OVERSAMPLED rate's tan; the knob itself
 *  spans 40 Hz–14 kHz, log). */
const FC_MIN = 10;
const FC_MAX_FRAC = 0.24; // of the oversampled rate
/** Ladder state hard guard (hostile-extremes belt-and-braces; normal
 *  operation lives well under ±2). */
const STATE_CLAMP = 6;

/** ADSR: the RC attack charges toward this target and terminates at 1.0
 *  (CEM3310: 5.4 V target / 5.0 V threshold = 1.08 — the punch constant). */
export const ADSR_ATTACK_TARGET = 1.08;
const ATK_LN = Math.log(ADSR_ATTACK_TARGET / (ADSR_ATTACK_TARGET - 1)); // ≈ 2.603
/** Decay/release are specified as time-to-(−60 dB of the gap). */
const T60_LN = Math.log(1000); // ≈ 6.908
/** Envelope idle flush threshold. */
const ENV_IDLE = 1e-4;

/** OTA VCA knee shape + bias (see header; H2 signature measured in tests). */
const VCA_W = 0.9;
const VCA_BIAS = 0.22;

/** Filter-EG depth: ENV knob ±1 → ±4 octaves of cutoff sweep. */
const FILTER_ENV_OCT = 4;
/** cutoff_cv: 4 oct/V — a ±1 V full swing covers ±4 octaves from the knob
 *  (the cv-range-standard full-swing rule; the knob's own span is 8.5 oct). */
const CUTOFF_CV_OCT = 4;
/** pwm_cv: ±1 V sweeps pulse width by ±0.45 (full 0.05…0.95 travel). */
const PWM_CV_SCALE = 0.45;
/** res_cv / drive_cv: ±1 V = the whole knob range (full-swing rule). */
const RES_CV_SCALE = 1;
const DRIVE_CV_SCALE = 1;

/** Mono-unison drift at WIDTH = 1 (± this many cents on the voice pair). */
const UNISON_CENTS = 7;
/** Poly pan layout · WIDTH (lane 0 = root anchored center). */
const PAN_LAYOUT: readonly number[] = [0, -1, 1, -0.55, 0.55];
/** Oscillator bus trim into the filter (2-osc + sub headroom). */
const OSC_NORM = 0.5;
/** Sub-oscillator level trim at SUB = 1. */
const SUB_GAIN = 0.9;

// ─────────────────────────────────────────────────────────────────────────
// Params
// ─────────────────────────────────────────────────────────────────────────

export interface TidyVcoParams {
  shape1: number; // OSC1 saw→pulse morph (0..1)
  shape2: number; // OSC2 saw→pulse morph (0..1)
  pw: number; // shared pulse width (0.05..0.5; PWM CV extends to 0.95)
  detune: number; // OSC2 detune (cents, −50..+50)
  oct2: number; // OSC2 octave (−1/0/+1, discrete)
  mix: number; // OSC1↔OSC2 equal-power mix (0..1)
  sub: number; // sub square level (0..1)
  cutoff: number; // filter cutoff = resonant pitch (Hz, 40..14000, log)
  res: number; // resonance (0..1; self-osc onset ≈ 0.89)
  drive: number; // filter input drive (0..1)
  env: number; // filter EG amount (−1..+1 → ±4 oct)
  track: number; // cutoff keytracking (0..1 = 0..100 %)
  fatk: number; // filter EG attack (s)
  fdec: number; // filter EG decay (s)
  fsus: number; // filter EG sustain (0..1)
  frel: number; // filter EG release (s)
  atk: number; // amp EG attack (s)
  dec: number; // amp EG decay (s)
  sus: number; // amp EG sustain (0..1)
  rel: number; // amp EG release (s)
  width: number; // stereo width: poly fan / mono unison spread (0..1)
  level: number; // output level (dB, −24..+12)
}

export const TIDY_VCO_DEFAULTS: TidyVcoParams = {
  shape1: 0,
  shape2: 0,
  pw: 0.5,
  detune: 6,
  oct2: 0,
  mix: 0.5,
  sub: 0.15,
  cutoff: 900,
  res: 0.35,
  drive: 0.25,
  env: 0.45,
  track: 0.4,
  fatk: 0.005,
  fdec: 0.35,
  fsus: 0.2,
  frel: 0.3,
  atk: 0.003,
  dec: 0.25,
  sus: 0.75,
  rel: 0.25,
  width: 0.4,
  level: 0,
};

// ─────────────────────────────────────────────────────────────────────────
// Control laws (pure — unit-tested directly)
// ─────────────────────────────────────────────────────────────────────────

/** V/oct → Hz (0 V = C4 = 261.626 Hz, house convention). */
export function tidyFreqHz(voct: number): number {
  return TIDY_C4_HZ * Math.pow(2, clamp(voct, -6, 6));
}

/** RES knob (0..1, CV-summed) → diode-ladder loop gain k (0..RES_K_MAX). */
export function tidyResToK(res: number): number {
  return RES_K_MAX * Math.pow(clamp(res, 0, 1), RES_CURVE);
}

/** Passband compensation gain for a loop gain k: (1+k)^0.6 (see header). */
export function tidyCompGain(k: number): number {
  return Math.pow(1 + k, RES_COMP_EXP);
}

/** Effective per-voice cutoff (Hz): CUTOFF knob · 2^(TRACK·pitch V +
 *  ENV·FEG·4 oct + 4 oct/V · cutoff_cv). Clamped for tan() stability at the
 *  oversampled rate. */
export function tidyCutoffHz(
  knobHz: number,
  trackAmt: number,
  voct: number,
  envAmt: number,
  feg: number,
  cutoffCv: number,
  osRate: number,
): number {
  const oct =
    clamp(trackAmt, 0, 1) * voct +
    FILTER_ENV_OCT * clamp(envAmt, -1, 1) * feg +
    CUTOFF_CV_OCT * clamp(cutoffCv, -2.5, 2.5);
  return clamp(clamp(knobHz, 40, 14000) * Math.pow(2, oct), FC_MIN, FC_MAX_FRAC * osRate);
}

/** Cutoff (Hz) → prewarped integrator gain g at the (oversampled) rate,
 *  calibrated so the SELF-OSC pitch equals fc exactly (g = √2·tan(π·fc/fs)). */
export function tidyCutoffToG(fcHz: number, osRate: number): number {
  return RESONANCE_PREWARP * Math.tan((Math.PI * clamp(fcHz, FC_MIN, FC_MAX_FRAC * osRate)) / osRate);
}

/** Effective pulse width: PW knob + 0.45/V · pwm_cv, clamped 0.05..0.95. */
export function tidyPwEff(pw: number, pwmCv: number): number {
  return clamp(clamp(pw, 0.05, 0.5) + PWM_CV_SCALE * clamp(pwmCv, -2, 2), 0.05, 0.95);
}

/** DRIVE (0..1, CV-summed) → { preGain, makeup } for the input tanh stage. */
export function tidyDriveGains(drive: number): { preGain: number; makeup: number } {
  const d = clamp(drive, 0, 1);
  const preGain = 1 + DRIVE_MAX * d;
  return { preGain, makeup: Math.pow(preGain, -DRIVE_MAKEUP_EXP) };
}

// ─────────────────────────────────────────────────────────────────────────
// polyBLEP oscillator (clean-room; Välimäki/Huovilainen 2-sample residual)
// ─────────────────────────────────────────────────────────────────────────

/** 2-sample polyBLEP residual at phase t (0..1), increment dt. */
export function tidyPolyBlep(t: number, dt: number): number {
  if (dt <= 0) return 0;
  if (t < dt) {
    const x = t / dt;
    return 2 * x - x * x - 1;
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt;
    return x * x + 2 * x + 1;
  }
  return 0;
}

/** Band-limited sawtooth at phase t — FALLING ramp, so its fundamental is
 *  IN PHASE with tidyPulse's. (With the rising ramp, the SHAPE morph's
 *  crossfade cancels the fundamental near 25 % — an audible thin notch;
 *  caught by the sonic-range monotonicity gate.) */
export function tidySaw(t: number, dt: number): number {
  return 1 - 2 * t + tidyPolyBlep(t, dt);
}

/** Band-limited pulse at phase t, duty pw, DC-centered. */
export function tidyPulse(t: number, dt: number, pw: number): number {
  let v = t < pw ? 1 : -1;
  v += tidyPolyBlep(t, dt);
  v -= tidyPolyBlep((t - pw + 1) % 1, dt);
  return v - (2 * pw - 1); // remove the static duty DC
}

/** SHAPE morph: 0 = saw, 1 = pulse (linear crossfade — both legs are
 *  full-scale bipolar so the midpoint stays hot). */
export function tidyOscSample(t: number, dt: number, shape: number, pw: number): number {
  const s = clamp(shape, 0, 1);
  const saw = s < 1 ? tidySaw(t, dt) : 0;
  const pul = s > 0 ? tidyPulse(t, dt, pw) : 0;
  return (1 - s) * saw + s * pul;
}

// ─────────────────────────────────────────────────────────────────────────
// RC-punch ADSR (CEM3310-lineage; see header)
// ─────────────────────────────────────────────────────────────────────────

export const RC_IDLE = 0;
export const RC_ATTACK = 1;
export const RC_DECAY = 2;
export const RC_RELEASE = 3;

export interface RcAdsrState {
  stage: number; // RC_IDLE | RC_ATTACK | RC_DECAY | RC_RELEASE
  v: number; // current level (0..1)
}

export function makeRcAdsrState(): RcAdsrState {
  return { stage: RC_IDLE, v: 0 };
}

/** Gate edge → stage transitions. Rising: attack FROM THE CURRENT LEVEL
 *  (analog retrigger, click-free). Falling: release from the current level. */
export function rcAdsrGate(s: RcAdsrState, on: boolean): void {
  if (on) {
    s.stage = RC_ATTACK;
  } else if (s.stage !== RC_IDLE) {
    s.stage = RC_RELEASE;
  }
}

/** One envelope sample. All segments are true one-pole RCs:
 *  attack charges toward ADSR_ATTACK_TARGET (1.08) and terminates at 1.0
 *  (τ chosen so 0→1 takes exactly `a` seconds); decay/release approach
 *  sustain/0 with the −60 dB convention (gap × 0.001 after `d`/`r` s).
 *  Sustain is read live (sweeping it during a held note tracks). */
export function rcAdsrTick(
  s: RcAdsrState,
  a: number,
  d: number,
  sus: number,
  r: number,
  sr: number,
): number {
  const susC = clamp(sus, 0, 1);
  if (s.stage === RC_ATTACK) {
    const alpha = 1 - Math.exp(-ATK_LN / (Math.max(a, 0.0005) * sr));
    s.v += alpha * (ADSR_ATTACK_TARGET - s.v);
    if (s.v >= 1) {
      s.v = 1;
      s.stage = RC_DECAY;
    }
  } else if (s.stage === RC_DECAY) {
    const alpha = 1 - Math.exp(-T60_LN / (Math.max(d, 0.001) * sr));
    s.v += alpha * (susC - s.v);
  } else if (s.stage === RC_RELEASE) {
    const alpha = 1 - Math.exp(-T60_LN / (Math.max(r, 0.001) * sr));
    s.v -= alpha * s.v;
    if (s.v < ENV_IDLE) {
      s.v = 0;
      s.stage = RC_IDLE;
    }
  }
  if (Math.abs(s.v) < FLUSH) s.v = 0; // denormal guard (decay toward sus = 0)
  return s.v;
}

// ─────────────────────────────────────────────────────────────────────────
// OTA-flavored VCA (see header; even-harmonic bloom measured in tests)
// ─────────────────────────────────────────────────────────────────────────

/** One VCA sample at envelope level gEnv (0..1). Exactly 0 at gEnv = 0. */
export function tidyOtaVca(x: number, gEnv: number): number {
  if (gEnv <= 0) return 0;
  const b = VCA_BIAS * gEnv;
  return (Math.tanh(VCA_W * gEnv * x + b) - Math.tanh(b)) / VCA_W;
}

// ─────────────────────────────────────────────────────────────────────────
// Nonlinear ZDF diode ladder (see header for the model + solve)
// ─────────────────────────────────────────────────────────────────────────

export interface DiodeLadderState {
  y1: number;
  y2: number;
  y3: number;
  y4: number;
  uPrev: number; // previous ladder input (trapezoidal history)
}

export function makeDiodeLadderState(): DiodeLadderState {
  return { y1: 0, y2: 0, y3: 0, y4: 0, uPrev: 0 };
}

/** C1-continuous cubic soft clip: x − x³/6 inside ±√2, flat ±0.9428 beyond. */
function soft3(x: number): number {
  if (x > Math.SQRT2) return 0.9428090415820634;
  if (x < -Math.SQRT2) return -0.9428090415820634;
  return x - (x * x * x) / 6;
}

/**
 * One diode-ladder sample at integrator gain g and loop gain k.
 * Solves the trapezoidal step of the coupled system with the zero-delay
 * feedback loop folded into the matrix (hardcoded elimination of
 * M = I − g·Ā + g·k·b̄·e4ᵀ — tridiagonal plus the (0,3) feedback corner).
 * The feedback squelch limiter enters as a previous-sample residue
 * Δ = k·y4⁻ − FB_LIM·tanh(k·y4⁻/FB_LIM): exactly linear at low levels,
 * compressive at self-osc amplitudes (bounded clean whistle).
 */
export function diodeLadderStep(s: DiodeLadderState, x: number, g: number, k: number): number {
  // Feedback squelch residue — pass 1 predicts from the previous y4, pass 2
  // refines against the freshly solved y4 (same matrix, new RHS chain), so
  // the limiter behaves as a near-instantaneous describing-function gain:
  // no added loop phase, the self-osc pitch stays put.
  const fbLin0 = k * s.y4;
  let delta = fbLin0 - FB_LIM * Math.tanh(fbLin0 / FB_LIM);

  // Trapezoidal RHS terms that do NOT depend on the residue.
  const r1base = s.y1 + g * (-1.5 * s.y1 + 0.5 * s.y2 + s.uPrev + x);
  const r2 = s.y2 + g * (0.5 * s.y1 - s.y2 + 0.5 * s.y3);
  const r3 = s.y3 + g * (0.5 * s.y2 - s.y3 + 0.5 * s.y4);
  const r4 = s.y4 + g * 0.5 * (s.y3 - s.y4);

  // M row coefficients.
  const m00 = 1 + 1.5 * g;
  const m01 = -0.5 * g;
  const m03 = g * k; // the ZDF feedback corner
  const mOff = -0.5 * g; // shared sub/super-diagonal
  const m11 = 1 + g;
  const m33 = 1 + 0.5 * g;

  // Hardcoded Gaussian elimination factors (structure-exploiting; the
  // matrix is residue-independent, so both passes share them).
  const f1 = mOff / m00;
  const a11 = m11 - f1 * m01;
  const a13 = -f1 * m03;
  const f2 = mOff / a11;
  const a22 = m11 - f2 * mOff;
  const a23 = mOff - f2 * a13;
  const f3 = mOff / a22;
  const a33 = m33 - f3 * a23;

  let xin = 0;
  let y1 = 0;
  let y2 = 0;
  let y3 = 0;
  let y4 = 0;
  for (let pass = 0; pass < 2; pass++) {
    xin = x + delta;
    const r1 = r1base + g * delta;
    const r2e = r2 - f1 * r1;
    const r3e = r3 - f2 * r2e;
    const r4e = r4 - f3 * r3e;
    y4 = r4e / a33;
    y3 = (r3e - a23 * y4) / a22;
    y2 = (r2e - mOff * y3 - a13 * y4) / a11;
    y1 = (r1 - m01 * y2 - m03 * y4) / m00;
    if (pass === 0) {
      const fbLin = k * y4;
      delta = fbLin - FB_LIM * Math.tanh(fbLin / FB_LIM);
    }
  }

  // Gentle always-on stage-1 saturator (the hottest node). Scaled by g so
  // it enters the STAGE ODE (damping tracks the cutoff, ~1 % at unit
  // amplitude) instead of acting as a rate-dependent per-sample nudge —
  // unscaled it would crush the low-cutoff limit cycle and bend its pitch.
  y1 += STAGE_SAT * g * (soft3(y1) - y1);
  y1 = clamp(y1, -STATE_CLAMP, STATE_CLAMP);
  y2 = clamp(y2, -STATE_CLAMP, STATE_CLAMP);
  y3 = clamp(y3, -STATE_CLAMP, STATE_CLAMP);
  y4 = clamp(y4, -STATE_CLAMP, STATE_CLAMP);
  if (Math.abs(y1) < FLUSH) y1 = 0;
  if (Math.abs(y2) < FLUSH) y2 = 0;
  if (Math.abs(y3) < FLUSH) y3 = 0;
  if (Math.abs(y4) < FLUSH) y4 = 0;

  s.y1 = y1;
  s.y2 = y2;
  s.y3 = y3;
  s.y4 = y4;
  s.uPrev = xin - k * y4;
  return y4;
}

// ─────────────────────────────────────────────────────────────────────────
// Voice + device state
// ─────────────────────────────────────────────────────────────────────────

interface TidyVoiceState {
  ph1: number; // OSC1 phase (0..1)
  ph2: number; // OSC2 phase
  phSub: number; // sub square phase (f1/2)
  heldVoct: number; // last gated pitch (release-tail hold, #669 rule)
  gatePrev: number; // per-voice gate edge memory
  unisonSign: number; // mono-unison drift/pan sign (−1 voice 0, +1 voice 1)
  feg: RcAdsrState;
  aeg: RcAdsrState;
  flt: DiodeLadderState;
  os2: Oversampler;
  // Per-sample scratch consumed by the oversampled closure.
  g: number;
  k: number;
  comp: number;
  drivePre: number;
  driveMakeup: number;
  vcaG: number;
  nlFn: (x: number) => number;
}

export interface TidyVcoState {
  voices: TidyVoiceState[];
  dcL: DcBlockState;
  dcR: DcBlockState;
  monoGatePrev: number;
  // Block-rate scratch (pre-allocated — no per-block GC in the worklet).
  gateScratch: Uint8Array;
  panScratch: Float32Array;
  uniScratch: Float32Array;
}

export function makeTidyVcoState(): TidyVcoState {
  const voices: TidyVoiceState[] = [];
  for (let v = 0; v < TIDY_VOICES; v++) {
    const vs: TidyVoiceState = {
      ph1: 0,
      ph2: 0,
      phSub: 0,
      heldVoct: 0,
      gatePrev: 0,
      unisonSign: v === 0 ? -1 : 1,
      feg: makeRcAdsrState(),
      aeg: makeRcAdsrState(),
      flt: makeDiodeLadderState(),
      os2: createOversampler(2),
      g: 0.1,
      k: 0,
      comp: 1,
      drivePre: 1,
      driveMakeup: 1,
      vcaG: 0,
      nlFn: (x) => x,
    };
    // The per-voice 2×-oversampled nonlinear section: DRIVE tanh → passband
    // compensation → diode ladder → OTA VCA. Bound once (no per-sample
    // closure allocation).
    vs.nlFn = (x: number) => {
      const driven = Math.tanh(vs.drivePre * x) * vs.driveMakeup;
      const y = diodeLadderStep(vs.flt, driven * vs.comp, vs.g, vs.k);
      return tidyOtaVca(y, vs.vcaG);
    };
    voices.push(vs);
  }
  return {
    voices,
    dcL: makeDcBlockState(),
    dcR: makeDcBlockState(),
    monoGatePrev: 0,
    gateScratch: new Uint8Array(TIDY_VOICES),
    panScratch: new Float32Array(TIDY_VOICES),
    uniScratch: new Float32Array(TIDY_VOICES),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Per-block render
// ─────────────────────────────────────────────────────────────────────────

export interface TidyVcoBus {
  /** polyPitchGate lane snapshot: length 10, (p0,g0,…,p4,g4), block-rate. */
  poly: ArrayLike<number>;
  /** Mono pitch (V/oct) + gate level (block-rate; poly gates take precedence). */
  monoPitch: number;
  monoGate: number;
  /** Per-sample CV arrays (audio-rate modulation) or block-rate scalars. */
  cutoffCv?: ArrayLike<number> | number;
  pwmCv?: ArrayLike<number> | number;
  resCv: number;
  driveCv: number;
}

function busCv(src: ArrayLike<number> | number | undefined, i: number): number {
  if (src === undefined) return 0;
  if (typeof src === 'number') return src;
  return src.length > 1 ? (src[i] ?? 0) : (src[0] ?? 0);
}

/**
 * Render samples [from, to) into outL/outR (accumulating nothing — plain
 * writes). Gate edges are detected at BLOCK rate from the bus snapshot
 * (the house pente/cube poly pattern); everything else runs per sample.
 */
export function renderTidyVco(
  p: TidyVcoParams,
  bus: TidyVcoBus,
  outL: Float32Array,
  outR: Float32Array,
  from: number,
  to: number,
  sr: number,
  s: TidyVcoState,
): void {
  const osRate = 2 * sr;

  // ── Lane resolution: poly wins the moment any lane gate is high; else the
  // mono pitch/gate pair drives a 2-voice unison (voices 0/1). ──
  let polyActive = false;
  for (let v = 0; v < TIDY_VOICES; v++) {
    if ((bus.poly[v * 2 + 1] ?? 0) > 0.5) {
      polyActive = true;
      break;
    }
  }
  const monoHigh = bus.monoGate > 0.5;

  const width = clamp(p.width, 0, 1);
  const uniCents = UNISON_CENTS * width;

  // Per-voice block-rate setup: gates, held pitch, pan, detune terms.
  const vGate = s.gateScratch;
  const vPan = s.panScratch;
  const vUniOct = s.uniScratch;
  for (let v = 0; v < TIDY_VOICES; v++) {
    const vs = s.voices[v]!;
    let gated = false;
    let pitch = vs.heldVoct;
    if (polyActive) {
      gated = (bus.poly[v * 2 + 1] ?? 0) > 0.5;
      if (gated) pitch = bus.poly[v * 2] ?? 0;
      vPan[v] = (PAN_LAYOUT[v] ?? 0) * width;
      vUniOct[v] = 0;
    } else if (v < 2) {
      gated = monoHigh;
      if (gated) pitch = bus.monoPitch;
      vPan[v] = vs.unisonSign * width;
      vUniOct[v] = (vs.unisonSign * uniCents) / 1200;
    } else {
      gated = false;
      vPan[v] = 0;
      vUniOct[v] = 0;
    }
    vs.heldVoct = pitch;
    const gateNow = gated ? 1 : 0;
    if (gateNow !== vs.gatePrev) {
      rcAdsrGate(vs.feg, gated);
      rcAdsrGate(vs.aeg, gated);
      vs.gatePrev = gateNow;
    }
    vGate[v] = gateNow;
  }

  // Block-rate knob/CV combines.
  const resEff = clamp(clamp(p.res, 0, 1) + RES_CV_SCALE * clamp(bus.resCv, -2, 2), 0, 1);
  const k = tidyResToK(resEff);
  const comp = tidyCompGain(k);
  const driveEff = clamp(clamp(p.drive, 0, 1) + DRIVE_CV_SCALE * clamp(bus.driveCv, -2, 2), 0, 1);
  const { preGain, makeup } = tidyDriveGains(driveEff);
  const mixA = Math.cos((clamp(p.mix, 0, 1) * Math.PI) / 2);
  const mixB = Math.sin((clamp(p.mix, 0, 1) * Math.PI) / 2);
  const subLvl = clamp(p.sub, 0, 1) * SUB_GAIN;
  const oct2 = Math.round(clamp(p.oct2, -1, 1));
  const detOct = clamp(p.detune, -50, 50) / 1200;
  const levelLin = Math.pow(10, clamp(p.level, -24, 12) / 20);

  for (let i = from; i < to; i++) {
    const cutoffCv = busCv(bus.cutoffCv, i - from);
    const pwEff = tidyPwEff(p.pw, busCv(bus.pwmCv, i - from));

    let sumL = 0;
    let sumR = 0;
    let active = 0;

    for (let v = 0; v < TIDY_VOICES; v++) {
      const vs = s.voices[v]!;
      // EGs tick every sample (release tails keep sounding).
      const feg = rcAdsrTick(vs.feg, p.fatk, p.fdec, p.fsus, p.frel, sr);
      const aeg = rcAdsrTick(vs.aeg, p.atk, p.dec, p.sus, p.rel, sr);
      if (!vGate[v] && vs.aeg.stage === RC_IDLE) continue; // fully idle voice
      active++;

      // ── Oscillator bus (1× rate; polyBLEP-band-limited). ──
      const voct = vs.heldVoct + vUniOct[v]!;
      const f1 = clamp(tidyFreqHz(voct), 0.01, 0.24 * sr);
      const f2 = clamp(f1 * Math.pow(2, oct2 + detOct), 0.01, 0.24 * sr);
      const dt1 = f1 / sr;
      const dt2 = f2 / sr;
      const dtSub = dt1 / 2;
      const o1 = tidyOscSample(vs.ph1, dt1, p.shape1, pwEff);
      const o2 = tidyOscSample(vs.ph2, dt2, p.shape2, pwEff);
      const oSub = tidyPulse(vs.phSub, dtSub, 0.5);
      vs.ph1 += dt1;
      if (vs.ph1 >= 1) vs.ph1 -= 1;
      vs.ph2 += dt2;
      if (vs.ph2 >= 1) vs.ph2 -= 1;
      vs.phSub += dtSub;
      if (vs.phSub >= 1) vs.phSub -= 1;
      const oscBus = (mixA * o1 + mixB * o2 + subLvl * oSub) * OSC_NORM;

      // ── Per-voice cutoff → prewarped g (keytrack + filter EG + CV). ──
      const fc = tidyCutoffHz(p.cutoff, p.track, voct, p.env, feg, cutoffCv, osRate);
      vs.g = tidyCutoffToG(fc, osRate);
      vs.k = k;
      vs.comp = comp;
      vs.drivePre = preGain;
      vs.driveMakeup = makeup;
      vs.vcaG = aeg;

      // ── 2×-oversampled nonlinear section: drive → ladder → OTA VCA. ──
      const voice = vs.os2.process(oscBus, vs.nlFn);

      // ── Equal-power pan into the stereo bus. ──
      const panPos = clamp(vPan[v]!, -1, 1);
      const ang = ((panPos + 1) * Math.PI) / 4;
      sumL += voice * Math.cos(ang);
      sumR += voice * Math.sin(ang);
    }

    // 1/√n voice normalization → trim → level → DC block → true-peak bound.
    const norm = (active > 0 ? 1 / Math.sqrt(active) : 1) * VOICE_TRIM;
    const l = dcBlockStep(sumL * norm * levelLin, s.dcL, 20, sr);
    const r = dcBlockStep(sumR * norm * levelLin, s.dcR, 20, sr);
    outL[i] = Math.tanh(l);
    outR[i] = Math.tanh(r);
  }
}
