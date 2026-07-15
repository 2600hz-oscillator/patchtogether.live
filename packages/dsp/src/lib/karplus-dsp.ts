// packages/dsp/src/lib/karplus-dsp.ts
//
// KARPLUS (id `karplus`) — pure DSP core for the extended Karplus-Strong
// string/percussive-harp voice. Built ON THE COFEFVE DELAY FUNDAMENTALS
// (owner directive): the string loop IS cofefve's `DelayChannel`
// (lib/analog-delay-core.ts — fractional ring buffer, 4-point Catmull-Rom
// cubic read, eased read pointer), reused as a shared import; a second
// DelayChannel implements the pick-position comb. No parallel delay-line
// implementation was grown for this module.
//
// The algorithm is the CCRMA Extended Karplus-Strong (Jaffe–Smith 1983 CMJ
// "Extensions of the Karplus-Strong Plucked-String Algorithm"; Smith,
// Physical Audio Signal Processing, "EKS" chapter):
//
//   exciter: seeded noise burst (length in PERIODS of f0, energy-normalized
//            so a short mallet tick and a long scrape land at comparable
//            loudness) → COLOR one-pole low-pass (dark felt mallet … bright
//            hard pick) → PICK-POSITION feedforward comb
//            e'[n] = e[n] − e[n − β·N]  (β = position)
//   loop:    delay line (N_frac samples, Catmull-Rom fractional read)
//            → BRIGHTNESS damping filter — a one-pole low-pass whose cutoff
//              TRACKS the note (fc = f0 · 2^(0.5 + 5.5·B), the Rings-style
//              damping vocabulary): dark at B = 0 attenuates even the 2nd
//              partial at any pitch, B = 1 is effectively open. Its phase
//              delay at f0 is compensated EXACTLY (closed form below), so
//              brightness never detunes the string.
//            → STIFFNESS dispersion: two first-order allpasses
//              Hs(z) = (a + z⁻¹)/(1 + a·z⁻¹), a = karplusStiffA(knob, f0)
//              — the knob sets the allpass DC group delay (1 → 12 samples,
//              perceptually tapered, capped at 20 % of the period), so the
//              stretch is audible at EVERY pitch, not just the top octaves
//              (upper partials arrive early → stretched sharp → bell/metal)
//            → in-loop DC blocker whose corner TRACKS the note (f0/20) —
//              see the stability note below
//            → × g, summed with the excitation back into the line.
//
// DECAY is musically calibrated and FREQUENCY-COMPENSATED (Jaffe–Smith
// decay shortening/stretching): the per-period loss factor is
//   ρ = 0.001^(1 / (f0 · t60))
// so the knob reads in SECONDS-TO-−60dB at any pitch — low notes do NOT
// ring 10× longer than high ones. g additionally compensates the damping
// filter's and DC blocker's own magnitude at f0 (g = ρ / (|Hlp(ω0)|·|Hdc(ω0)|),
// capped at KARPLUS_G_MAX), so the FUNDAMENTAL's decay tracks the knob while
// upper partials keep the natural faster fade. (Past the cap — max-dark ×
// long-decay × high pitch — the note decays faster than the knob: a muted
// string, physically sane.)
//
// STABILITY (the loop can have g > 1, so this is load-bearing): a delay-loop
// pole exists at each frequency where the TOTAL loop phase wraps a multiple
// of 2π, with gain g·|Hlp|·|Hdc| there. Modes k ≥ 1 sit at/above f0 where
// |Hlp| is monotone non-increasing, so their gain ≤ ρ·1.001 < 1. The k = 0
// mode does NOT sit at DC — the blocker's phase LEAD pushes it up to
// ≈ 0.085·f0 — which is exactly why the blocker corner TRACKS f0 (f0/20):
// at 0.085·f0 the blocker's own magnitude is ≈ 0.86 at ANY pitch, holding
// the k = 0 mode at ≤ G_MAX·0.87 < 1. (A FIXED low corner fails: for high
// f0 the k = 0 mode lands far above it, |Hdc| ≈ 1, and any g > 1 grows —
// caught by the hostile-extremes unit test.) The pick-position comb's own
// low-frequency rolloff additionally starves that mode of excitation.
//
// TUNING: the loop's total traversal must equal sr/f0, and every loop stage
// contributes phase delay. The delay-line target subtracts each stage's
// EXACT phase delay at f0 (damping = 1 sample by symmetry; allpasses + DC
// blocker via atan2 closed forms below), and the fractional remainder is
// realized by DelayChannel's Catmull-Rom cubic read — this is what keeps
// 1V/oct tracking under 3 cents across ≥5 octaves (unit-gated).
//
// STRIKE: one excitation per rising edge on the trigger (per-sample
// prev < 0.5 && cur >= 0.5 — the canonical worklet edge). The strike
// reseeds the burst xorshift32 and resets the color filter, so every render
// is bit-identical (ART-friendly); the string's residual ring-over is NOT
// cleared (re-plucking a still-ringing string is the physical behavior).
// ACCENT is latched at the edge (per-hit velocity: louder + brighter burst).
// DAMP acts WHILE high (edge:'gate'): the loop decay collapses toward
// DAMP_T60_S like a palm mute, and releases when the gate falls.
//
// All time constants derive from the LIVE sample rate; state lives in an
// explicit object so the per-sample math is unit-testable without the
// worklet. Denormal-scale values are flushed at 1e−20.

import { DelayChannel } from './analog-delay-core';
import { clamp } from './dsp-utils';

/** Deterministic burst-noise seed ("karp"), reseeded at EVERY strike. */
export const KARPLUS_SEED = 0x6b617270;

/** Voice pitch clamp (Hz). 30 Hz keeps the delay line bounded; 4200 Hz
 *  (> C8) keeps the compensated loop ≥ a few samples long. */
export const KARPLUS_F0_MIN = 30;
export const KARPLUS_F0_MAX = 4200;

/** In-loop DC-blocker corner as a fraction of f0 (fc = f0 / 20). Tracking
 *  the note keeps BOTH its cost at the fundamental (≈ 0.12% per period,
 *  compensated anyway) and its grip on the k = 0 loop mode (≈ 0.86 at
 *  0.085·f0) pitch-independent — see the stability note above. */
export const KARPLUS_DC_DIV = 20;

/** Hard cap on the compensated loop gain g. Covers full decay compensation
 *  down to brightness ≈ 0.1; guarantees the k = 0 mode ≤ 1.10·0.87 < 1. */
export const KARPLUS_G_MAX = 1.1;

/** Palm-mute decay time while the DAMP gate is held (s, to −60 dB). */
export const KARPLUS_DAMP_T60_S = 0.05;

/** Stiffness knob → per-allpass DC PHASE delay τ0 (samples) at knob = 1.
 *
 *  SONIC-RANGE RETAPE (2026-07-11 adversarial audit): the original map
 *  a = −0.55·knob gave each allpass a near-FLAT phase delay across the low
 *  normalized frequencies a 48 kHz loop actually uses, so at the DEFAULT
 *  tune (220 Hz, w0 ≈ 0.029 rad) the FULL knob range stretched partial 5 by
 *  only ~2–3 cents — inaudible; the knob was dead below ~500 Hz and only
 *  woke up in the top octaves (the original unit test even probed it at A5
 *  for this reason). The knob now sets the allpass DC phase delay LINEARLY
 *  (τ0 = 1 + 23·knob, a = −(τ0−1)/(τ0+1)) — the pole walks toward z = 1,
 *  which is what actually deepens the dispersion: at 220 Hz the measured
 *  partial-5 stretch is now ≈ +6 c / +34 c / +75 c / +130 c at knob 0.25 /
 *  0.5 / 0.75 / 1 (subtle piano wire → real bell), and knob = 0 keeps
 *  a = 0 exactly (τ0 = 1 — the continuous-topology guarantee: a pure
 *  1-sample delay). Allpasses are unity-magnitude, so loop STABILITY is
 *  unaffected at any a. */
export const KARPLUS_STIFF_TAU_MAX = 24;

/** Fraction of the period the two allpasses may consume at f0 (tuning
 *  budget): 2·τp(w0) ≤ 0.5·(sr/f0) keeps the compensated delay-line target
 *  comfortably positive at every reachable pitch (period ≥ 11.4 samples at
 *  F0_MAX), so high notes stay in tune instead of clamping at the floor. */
export const KARPLUS_STIFF_BUDGET = 0.5;

/** Stiffness knob (0..1) → allpass coefficient a ≤ 0 for the current f0.
 *  Linear DC-phase-delay taper (see KARPLUS_STIFF_TAU_MAX), then a closed-
 *  form BUDGET cap: if the pair's actual phase delay AT f0 would exceed
 *  half the period, τ0 is scaled down (2 fixed-point refinements of the
 *  monotone τ0 → τp(w0) map — deterministic, no search). The compensation
 *  in karplusDelayTarget uses the SAME returned a, so tuning stays exact
 *  wherever the budget lands. */
export function karplusStiffA(stiffness: number, f0: number, sr: number): number {
  const k = clamp(stiffness, 0, 1);
  if (k <= 0) return 0;
  const w0 = (TWO_PI * f0) / sr;
  const budget = (KARPLUS_STIFF_BUDGET * sr) / f0;
  let tau0 = 1 + (KARPLUS_STIFF_TAU_MAX - 1) * k;
  let a = -(tau0 - 1) / (tau0 + 1);
  // τp(w0) is sublinear in τ0, so the plain ratio update approaches the
  // budget from above — 6 bounded iterations land within ~3% (only the
  // high-pitch × high-stiffness corner ever iterates at all).
  for (let i = 0; i < 6; i++) {
    const used = 2 * karplusAllpassPhaseDelay(a, w0);
    if (used <= budget) break;
    tau0 = Math.max(1, tau0 * (budget / used));
    a = -(tau0 - 1) / (tau0 + 1);
  }
  return a;
}

/** Exciter COLOR knob → burst low-pass cutoff sweep (Hz, exponential). */
export const KARPLUS_COLOR_FC_LO = 200;
export const KARPLUS_COLOR_FC_HI = 10000;

const FLUSH = 1e-20;
const TWO_PI = Math.PI * 2;
const LN_0_001 = Math.log(0.001); // −60 dB

// ─────────────────────────────────────────────────────────────────────────
// Params (ids match the def's params; pitchCv is the 1V/oct input)
// ─────────────────────────────────────────────────────────────────────────

export interface KarplusParams {
  /** Base pitch, Hz (55–1760, default 220 = A3). */
  tune: number;
  /** Decay to −60 dB, seconds (0.1–10, default 2). Frequency-compensated. */
  decay: number;
  /** Loop brightness B, 0–1 (default 0.7). 1 = lossless-bright (steel/glass),
   *  0 = darkest (nylon/felt). */
  brightness: number;
  /** Pick position β, 0.02–0.5 (default 0.2): comb at β of the period.
   *  0.5 = hollow mid-pluck (even harmonics cancelled), small = bridge-thin. */
  position: number;
  /** Inharmonicity 0–1 (default 0): dispersion allpasses stretch upper
   *  partials sharp — toward bell/metallic. */
  stiffness: number;
  /** Exciter color 0–1 (default 0.6): burst low-pass 200 Hz → 10 kHz. */
  color: number;
  /** Exciter length in PERIODS of f0 (0.1–4, default 1 = classic K-S fill).
   *  Short+dark = mallet thump, 1 = pluck, long+bright = scrape/bow noise. */
  burst: number;
  /** Output level, dB (−24..+12, default 0). */
  level: number;
  /** 1 V/oct transpose (f0 = tune × 2^pitchCv). */
  pitchCv: number;
}

export const KARPLUS_DEFAULTS: KarplusParams = {
  tune: 220,
  decay: 2,
  brightness: 0.7,
  position: 0.2,
  stiffness: 0,
  color: 0.6,
  burst: 1,
  level: 0,
  pitchCv: 0,
};

// ─────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────

export interface KarplusState {
  /** THE string: cofefve's fractional delay line (shared import). */
  string: DelayChannel;
  /** Pick-position comb history — a second cofefve DelayChannel. */
  comb: DelayChannel;
  /** Brightness one-pole low-pass state. */
  lpState: number;
  /** Two dispersion allpasses (x/y one-sample histories). */
  ap1X1: number;
  ap1Y1: number;
  ap2X1: number;
  ap2Y1: number;
  /** In-loop DC blocker. */
  dcX1: number;
  dcY1: number;
  /** Strike edge detection + per-hit accent latch. */
  gatePrev: number;
  accentLatch: number;
  /** Remaining excitation-burst samples (0 = idle). */
  burstRemaining: number;
  /** Burst xorshift32 SEED — reseeded into `rng` at every strike. Defaults to
   *  KARPLUS_SEED (byte-identical to the original hardcoded reseed). Multi-voice
   *  hosts (SIX STRUM) give each voice a DISTINCT seed so simultaneous strikes
   *  don't produce phase-coherent, combing bursts. */
  seed: number;
  /** xorshift32 state, reseeded to `seed` at every strike. */
  rng: number;
  /** Exciter color one-pole state. */
  colorLp: number;
  /** ~10 ms read-pointer ease (same law as cofefve's TIME glide). */
  easeCoeff: number;
}

export function makeKarplusState(sr: number, seed: number = KARPLUS_SEED): KarplusState {
  const rate = sr > 0 ? sr : 48000;
  return {
    // String must hold one full period at f0 min (+ cubic-read headroom).
    string: new DelayChannel(Math.ceil(rate / KARPLUS_F0_MIN) + 8),
    // Comb holds at most half a period (β ≤ 0.5).
    comb: new DelayChannel(Math.ceil(rate / (2 * KARPLUS_F0_MIN)) + 8),
    lpState: 0,
    ap1X1: 0,
    ap1Y1: 0,
    ap2X1: 0,
    ap2Y1: 0,
    dcX1: 0,
    dcY1: 0,
    gatePrev: 0,
    accentLatch: 0,
    burstRemaining: 0,
    seed: seed >>> 0,
    rng: seed >>> 0,
    colorLp: 0,
    easeCoeff: 1 - Math.exp(-1 / (0.01 * rate)),
  };
}

function xorshift32(s: number): number {
  s ^= s << 13;
  s >>>= 0;
  s ^= s >>> 17;
  s ^= s << 5;
  return s >>> 0;
}

// ─────────────────────────────────────────────────────────────────────────
// Pure laws (exported — unit-tested directly)
// ─────────────────────────────────────────────────────────────────────────

/** Jaffe–Smith per-period loss for a t60-second decay at f0:
 *  ρ = 0.001^(1/(f0·t60)), so ρ^(f0·t) hits −60 dB at t = t60 at ANY pitch. */
export function karplusLoopRho(f0: number, t60: number): number {
  return Math.exp(LN_0_001 / (Math.max(1, f0) * Math.max(0.01, t60)));
}

/** Brightness → loop low-pass cutoff, TRACKING the note so the knob has the
 *  same voicing at every pitch (Rings' damping vocabulary):
 *  fc = f0 · 2^(0.5 + 5.5·B), capped below Nyquist. B = 0 → fc ≈ 1.41·f0
 *  (dark: even the 2nd partial is heavily damped); B = 1 → ≈ 90·f0 (open). */
export function karplusBrightnessCutoffHz(f0: number, brightness: number, sr: number): number {
  return Math.min(0.45 * sr, f0 * Math.pow(2, 0.5 + 5.5 * clamp(brightness, 0, 1)));
}

/** One-pole coefficient for the loop low-pass (y += a·(x − y)). */
export function karplusDampingCoeff(f0: number, brightness: number, sr: number): number {
  return 1 - Math.exp((-TWO_PI * karplusBrightnessCutoffHz(f0, brightness, sr)) / sr);
}

/** |Hlp(e^jw)| of y += a·(x−y): a / |1 − (1−a)e^{−jw}| — monotone
 *  non-increasing in w, unity at DC. */
export function karplusDampingMag(a: number, w: number): number {
  const r = 1 - a;
  return a / Math.sqrt(Math.max(1e-12, 1 - 2 * r * Math.cos(w) + r * r));
}

/** EXACT phase delay (samples) of the same one-pole at radian frequency w. */
export function karplusDampingPhaseDelay(a: number, w: number): number {
  const r = 1 - a;
  return Math.atan2(r * Math.sin(w), 1 - r * Math.cos(w)) / w;
}

/** EXACT phase delay (samples) of the first-order allpass
 *  Hs(z) = (a + z⁻¹)/(1 + a·z⁻¹) at radian frequency w. At a = 0 this is a
 *  pure 1-sample delay (the allpasses stay in the loop at stiffness 0 so the
 *  knob is continuous — no topology switch to detune). */
export function karplusAllpassPhaseDelay(a: number, w: number): number {
  const phase =
    Math.atan2(-Math.sin(w), a + Math.cos(w)) -
    Math.atan2(-a * Math.sin(w), 1 + a * Math.cos(w));
  return -phase / w;
}

/** The f0-tracked DC-blocker pole: R for a corner at f0 / KARPLUS_DC_DIV. */
export function karplusDcR(f0: number, sr: number): number {
  return Math.exp((-TWO_PI * (f0 / KARPLUS_DC_DIV)) / sr);
}

/** EXACT phase delay (samples, NEGATIVE = lead) of the DC blocker
 *  Hdc(z) = (1 − z⁻¹)/(1 − R·z⁻¹) at radian frequency w. */
export function karplusDcBlockPhaseDelay(R: number, w: number): number {
  const phase =
    Math.atan2(Math.sin(w), 1 - Math.cos(w)) -
    Math.atan2(R * Math.sin(w), 1 - R * Math.cos(w));
  return -phase / w;
}

/** |Hdc(e^jw)| for the same blocker. */
export function karplusDcBlockMag(R: number, w: number): number {
  const num = 2 * Math.sin(w / 2);
  const den = Math.sqrt(1 - 2 * R * Math.cos(w) + R * R);
  return den > 0 ? num / den : 1;
}

/** The compensated delay-line target (samples) so the TOTAL loop traversal
 *  is exactly sr/f0: subtract the brightness low-pass's phase delay at f0,
 *  both dispersion allpasses, and the DC blocker (its LEAD adds delay back).
 *  This exactness is what holds 1 V/oct under 3 cents across the range. */
export function karplusDelayTarget(
  f0: number,
  brightness: number,
  stiffness: number,
  sr: number,
): number {
  const w = (TWO_PI * f0) / sr;
  const a = karplusStiffA(stiffness, f0, sr);
  const aLp = karplusDampingCoeff(f0, brightness, sr);
  const target =
    sr / f0 -
    karplusDampingPhaseDelay(aLp, w) -
    2 * karplusAllpassPhaseDelay(a, w) -
    karplusDcBlockPhaseDelay(karplusDcR(f0, sr), w);
  return Math.max(2, target);
}

/** Effective voice frequency: tune transposed by 1 V/oct, clamped. */
export function karplusF0(p: KarplusParams): number {
  const tune = clamp(p.tune, 55, 1760);
  return clamp(tune * Math.pow(2, p.pitchCv), KARPLUS_F0_MIN, KARPLUS_F0_MAX);
}

// ─────────────────────────────────────────────────────────────────────────
// Per-sample step
// ─────────────────────────────────────────────────────────────────────────

/**
 * One sample of the voice. `trigger` fires the strike on its rising edge,
 * `accent` (0..1) is latched at that edge, `damp` (gate level) palm-mutes
 * WHILE ≥ 0.5. Returns the output sample (level applied).
 */
export function karplusStep(
  trigger: number,
  accent: number,
  damp: number,
  p: KarplusParams,
  sr: number,
  s: KarplusState,
): number {
  const f0 = karplusF0(p);
  const periodSamples = sr / f0;

  // ── strike detection (per-sample rising edge; worklet-canonical) ──
  const high = trigger >= 0.5;
  const prevHigh = s.gatePrev >= 0.5;
  s.gatePrev = trigger;
  if (high && !prevHigh) {
    s.burstRemaining = Math.max(2, Math.round(clamp(p.burst, 0.1, 4) * periodSamples));
    s.rng = s.seed;
    s.colorLp = 0;
    s.accentLatch = clamp(accent, 0, 1);
  }

  // ── exciter: seeded noise burst → COLOR low-pass → position comb ──
  let exc = 0;
  if (s.burstRemaining > 0) {
    s.burstRemaining--;
    s.rng = xorshift32(s.rng);
    const noise = s.rng / 0x80000000 - 1;
    // Accent brightens (color pushed up) and loudens the hit.
    const colorEff = clamp(clamp(p.color, 0, 1) + 0.25 * s.accentLatch, 0, 1);
    const fcExc =
      KARPLUS_COLOR_FC_LO *
      Math.pow(KARPLUS_COLOR_FC_HI / KARPLUS_COLOR_FC_LO, colorEff);
    const aExc = 1 - Math.exp((-TWO_PI * Math.min(fcExc, 0.45 * sr)) / sr);
    s.colorLp += aExc * (noise - s.colorLp);
    // Loudness normalization: partial compensation for the color low-pass
    // (dark bursts keep a natural touch less energy but stay clearly
    // audible) and 1/√periods for the burst length (a short mallet tick
    // injects comparable energy to a long scrape — like striking harder).
    const norm =
      clamp(Math.pow((2 - aExc) / aExc, 0.35), 1, 3.5) *
      Math.sqrt(1 / clamp(p.burst, 0.1, 4));
    exc = s.colorLp * norm * (0.55 + 0.4 * s.accentLatch);
  }
  if (Math.abs(s.colorLp) < FLUSH) s.colorLp = 0;

  // Pick-position comb (feedforward, on the excitation only): runs EVERY
  // sample so the delayed negative copy still lands after the burst ends.
  const beta = clamp(p.position, 0.02, 0.5);
  const combDelayed = s.comb.readTap(Math.max(1, beta * periodSamples), 1);
  s.comb.write(exc);
  const excComb = exc - combDelayed;

  // ── the string loop: tap → damping → dispersion → DC block → ×g ──
  const tap = s.string.readTap(
    karplusDelayTarget(f0, p.brightness, p.stiffness, sr),
    s.easeCoeff,
  );

  // Brightness damping: the f0-tracked one-pole low-pass.
  const aLp = karplusDampingCoeff(f0, p.brightness, sr);
  s.lpState += aLp * (tap - s.lpState);
  if (Math.abs(s.lpState) < FLUSH) s.lpState = 0;
  const damped = s.lpState;

  // Two dispersion allpasses: y = a·x + x1 − a·y1.
  const a = karplusStiffA(p.stiffness, f0, sr);
  let ap1 = a * damped + s.ap1X1 - a * s.ap1Y1;
  if (Math.abs(ap1) < FLUSH) ap1 = 0;
  s.ap1X1 = damped;
  s.ap1Y1 = ap1;
  let ap2 = a * ap1 + s.ap2X1 - a * s.ap2Y1;
  if (Math.abs(ap2) < FLUSH) ap2 = 0;
  s.ap2X1 = ap1;
  s.ap2Y1 = ap2;

  // In-loop f0-tracked DC blocker (holds the k = 0 mode below unity — see
  // the stability note in the header).
  const dcR = karplusDcR(f0, sr);
  const dc = ap2 - s.dcX1 + dcR * s.dcY1;
  s.dcX1 = ap2;
  s.dcY1 = Math.abs(dc) < FLUSH ? 0 : dc;

  // Frequency-compensated loop gain: ρ for the (possibly damped) t60,
  // divided by the loop stages' own magnitude at f0 so the FUNDAMENTAL's
  // decay matches the knob. Bounded; modes k ≥ 1 stay ≤ ρ < 1.
  const t60 = damp >= 0.5 ? Math.min(clamp(p.decay, 0.1, 10), KARPLUS_DAMP_T60_S) : clamp(p.decay, 0.1, 10);
  const w0 = (TWO_PI * f0) / sr;
  const rho = Math.min(0.99995, karplusLoopRho(f0, t60));
  const comp = karplusDampingMag(aLp, w0) * karplusDcBlockMag(dcR, w0);
  const g = clamp(rho / Math.max(0.5, comp), 0, KARPLUS_G_MAX);

  s.string.write(excComb + g * dc);

  // ── output: the string itself, at LEVEL ──
  return tap * Math.pow(10, clamp(p.level, -24, 12) / 20);
}
