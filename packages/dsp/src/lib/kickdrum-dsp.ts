// packages/dsp/src/lib/kickdrum-dsp.ts
//
// KICK DRUM (id `kickdrum`) — pure DSP core, Phase 1 of the build plan
// (.myrobots/plans/kick-drum-voice-2026-07-01.md): the SUB + BODY generator
// layers and the strike machinery. Later phases add CLICK, the oversampled
// DRIVE (via lib/oversample.ts), EQ, TRANSLATE, DYNAMICS, and the stereo
// crossover — all downstream of the summed layers produced here.
//
// Design (owner-decided): three DECOUPLED generators so "deep pulse" (sub)
// and "punch" (body) live on orthogonal knobs —
//   SUB  : pure sine phase-accumulator at `tune` Hz (20–120), a GENTLE slow
//          pitch settle, LONG amp decay (≤ ~800 ms). The air-moving pulse.
//   BODY : band-limited `moogWaves` morph (sine→tri→rect) one octave above
//          the sub, FAST downward pitch sweep (the 909 "dooo"), SHORT amp
//          decay, optional `tension` amplitude→pitch glide (the modal-design
//          graft: pitch rides the body envelope, clamped ≤ 0.6, smoothed at
//          ~40 Hz so it can't zipper).
//
// STRIKE: one rising edge on the trigger (prev < 0.5 && cur >= 0.5 — the
// canonical per-sample worklet edge) resets BOTH phases to 0 (deterministic,
// click-free, ART-friendly), fires all envelopes, and LATCHES the accent
// input — accent is per-hit, sampled at the edge only.
//
// Every time constant derives from the LIVE sample rate (audit A2 — no 48 000
// literals; the unit tests assert identical decay at 44 100 and 48 000).
// Amp-decay knobs are calibrated as TIME TO −60 dB. All state lives in an
// explicit state object (DSP-core discipline) so per-sample math is
// unit-testable without the worklet. Denormals flushed at 1e−20.

import { clamp, dcBlockStep, makeDcBlockState, type DcBlockState } from './dsp-utils';
import { moogWaves } from './moog-vco-dsp';
import { createOversampler, type Oversampler } from './oversample';
import {
  makeBiquad,
  biquadStep,
  updateHighpass,
  updateLowShelf,
  updatePeaking,
  updateHighShelf,
  updateLowpass,
  type Biquad,
} from './rbj-biquad';

/** Deterministic click-noise seed — reseeded at EVERY strike so hit N is
 *  bit-identical to hit 1 (ART-friendly; no wall-clock randomness). */
const CLICK_SEED = 0x9e3779b9;

function xorshift32(s: number): number {
  s ^= s << 13;
  s ^= s >>> 17;
  s ^= s << 5;
  return s >>> 0;
}

/** Reflect-fold into [−1, 1] (period-4 triangle law — the same shape the
 *  oversampler's proving tests rate). */
function reflectFold(x: number): number {
  let y = (x + 1) % 4;
  if (y < 0) y += 4;
  return y < 2 ? y - 1 : 3 - y;
}

// ─────────────────────────────────────────────────────────────────────────
// Params (Phase-1 subset of the full plan table; ids match the def's params)
// ─────────────────────────────────────────────────────────────────────────

export interface KickdrumP1Params {
  /** Sub fundamental, Hz (plan: 20–120, default 50). */
  tune: number;
  /** Body pitch-sweep depth, semitones above settled (0–48, default 24 = the
   *  canonical 4× start multiple — the canonical kick-voice start multiple). */
  pitchAmt: number;
  /** Body pitch-env decay, ms (5–120, default 30). */
  pitchTime: number;
  /** Amplitude→pitch glide on the body, 0–0.6 (default 0). */
  tension: number;
  /** Sub amp decay, ms to −60 dB (50–800, default 450). */
  subDecay: number;
  /** Body amp decay, ms to −60 dB (20–400, default 120). */
  bodyDecay: number;
  /** Layer mix levels 0–1 (defaults 0.9 / 0.7). */
  subLevel: number;
  bodyLevel: number;
  /** Body waveform morph 0–1: 0 sine → 0.5 triangle → 1 rectangle. */
  bodyShape: number;
  /** 1 V/oct transpose applied to the whole voice (0 = as-tuned). */
  pitchCv: number;

  // ── Phase 2: CLICK layer + oversampled DRIVE ──
  /** Click burst length, ms (2–60, default 12). */
  clickLen: number;
  /** Click band-pass center, Hz (500–6000, default 2800). */
  clickTone: number;
  /** Click mix level 0–1 (default 0.4). */
  clickLevel: number;
  /** Drive amount 0–1 (default 0.4). 0 keeps the stage transparent. */
  drive: number;
  /** The owner's single character switch (0/1, default 0 = clean deep):
   *  0 → tanh soft-clip @2× (clean 909 warmth);
   *  1 → wavefold+asym blend @4×, hotter pre-gain, fold depth riding the
   *      body envelope (more drive + fold + bite). */
  hard: number;

  // ── Phase 3: EQ + harmonic exciter (translate) ──
  /** Sub shelf gain at ~50 Hz, dB (−12..12, default 0). */
  subEq: number;
  /** Body bell gain at ~150 Hz, dB (−12..12, default 3). */
  bodyEq: number;
  /** Attack bell gain at ~2.8 kHz, dB (−12..12, default 2). */
  attackEq: number;
  /** Spectral tilt −1..1 (default 0): negative = darker, positive = brighter
   *  (∓4 dB shelves at 250 Hz / 2.5 kHz). */
  tilt: number;
  /** Harmonic-exciter blend 0..1 (default 0.3): saturates a low-passed copy
   *  of the SUB so small speakers reconstruct the missing fundamental. */
  translate: number;

  // ── Phase 4: dynamics ──
  /** Transient shaper: −1..1 (default 0.2). >0 sharpens the strike onset,
   *  <0 softens it — threshold-free (fast/slow follower pair). */
  attack: number;
  /** Tail shaper: −1..1 (default 0). >0 lifts the decay tail, <0 tucks it. */
  sustain: number;
  /** In-voice opto-style compressor 0..1 (default 0.3). The DETECTOR is
   *  high-passed at ~100 Hz so the 40 Hz sub NEVER pumps the glue. */
  glue: number;
  /** End-stage soft-clip lean 0..1 (default 0.5): drives tanh(1+2·ceiling)
   *  — the voice can sit HOT and stays strictly true-peak-bounded < 1. */
  ceiling: number;
  /** Output level, dB (−24..+12, default 0). Applied BEFORE the ceiling so
   *  hot levels lean into the clip instead of escaping it. */
  level: number;

  // ── Phase 5: stereo ──
  /** Stereo width 0..1 (default 0.2). ONLY the >120 Hz side content widens
   *  (decorrelated L/R click); the sub stays phase-coherent MONO, so the
   *  mono fold-down never thins the low end. */
  width: number;
}

export const KICKDRUM_P1_DEFAULTS: KickdrumP1Params = {
  tune: 50,
  pitchAmt: 24,
  pitchTime: 30,
  tension: 0,
  subDecay: 450,
  bodyDecay: 120,
  subLevel: 0.9,
  bodyLevel: 0.7,
  bodyShape: 0.3,
  pitchCv: 0,
  clickLen: 12,
  clickTone: 2800,
  clickLevel: 0.4,
  drive: 0.4,
  hard: 0,
  subEq: 0,
  bodyEq: 3,
  attackEq: 2,
  tilt: 0,
  translate: 0.3,
  attack: 0.2,
  sustain: 0,
  glue: 0.3,
  ceiling: 0.5,
  level: 0,
  width: 0.2,
};

// ─────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────

export interface KickdrumState {
  subPhase: number;
  bodyPhase: number;
  /** Amp envelopes, 1 at the strike → decaying to 0. */
  subAmp: number;
  bodyAmp: number;
  /** Pitch envelopes, 1 at the strike → decaying to 0. */
  subPitchEnv: number;
  bodyPitchEnv: number;
  /** ~40 Hz-smoothed tension term (amplitude→pitch glide). */
  tensionSm: number;
  gatePrev: number;
  /** Accent latched at the strike edge (0–1). */
  accentLatch: number;
  dc: DcBlockState;

  // ── Phase 2: click layer ──
  /** Click amp envelope, 1 at the strike → decaying to 0 over clickLen. */
  clickEnv: number;
  /** xorshift32 state, reseeded at every strike (deterministic noise). */
  clickRng: number;
  /** Chamberlin SVF band-pass state for the click tone (LEFT chain). */
  clickLow: number;
  clickBand: number;
  /** Decorrelated RIGHT click chain (independent seed + filter). */
  clickRng2: number;
  clickLow2: number;
  clickBand2: number;
  /** 120 Hz-high-passed side signal (this sample), consumed by the stereo
   *  step. 4TH-order (two cascaded biquads, LR4-style): a 12 dB/oct slope
   *  still left −19 dB of 50 Hz in the side — the sub must be untouchable. */
  sideHp: Biquad;
  sideHp2: Biquad;
  sideOut: number;

  // ── Phase 2: oversampled drive ──
  /** Per-mode oversamplers (soft @2×, hard @4× — the rated factors from
   *  oversample.test.ts). */
  os2: Oversampler;
  os4: Oversampler;
  /** Mutable fields the drive closures read (avoids per-sample allocation). */
  driveAmt: number;
  driveFold: number;
  /** The two nonlinearities, created ONCE per state, closing over the two
   *  fields above. */
  softFn: (x: number) => number;
  hardFn: (x: number) => number;

  // ── Phase 3: EQ chain + exciter ──
  eqHp: Biquad; // 22 Hz rumble/DC guard
  eqSub: Biquad; // 50 Hz shelf
  eqBody: Biquad; // 150 Hz bell
  eqAttack: Biquad; // 2.8 kHz bell
  eqTiltLo: Biquad; // 250 Hz shelf (∓)
  eqTiltHi: Biquad; // 2.5 kHz shelf (±)
  exLp: Biquad; // exciter 300 Hz low-pass

  // ── Phase 4: dynamics ──
  /** Fast/slow |x| followers for the threshold-free transient shaper. */
  envFast: number;
  envSlow: number;
  /** Opto detector: 4th-order 100 Hz HPF (two cascaded biquads — a 2nd-order
   *  slope still let a 40 Hz sub pump ~18%) + its envelope. */
  detHp: Biquad;
  detHp2: Biquad;
  detEnv: number;
}

export function makeKickdrumState(): KickdrumState {
  const s: KickdrumState = {
    subPhase: 0,
    bodyPhase: 0,
    subAmp: 0,
    bodyAmp: 0,
    subPitchEnv: 0,
    bodyPitchEnv: 0,
    tensionSm: 0,
    gatePrev: 0,
    accentLatch: 0,
    dc: makeDcBlockState(),
    clickEnv: 0,
    clickRng: CLICK_SEED,
    clickLow: 0,
    clickBand: 0,
    clickRng2: (CLICK_SEED ^ 0x55aa55aa) >>> 0,
    clickLow2: 0,
    clickBand2: 0,
    sideHp: makeBiquad(),
    sideHp2: makeBiquad(),
    sideOut: 0,
    os2: createOversampler(2),
    os4: createOversampler(4),
    driveAmt: 0,
    driveFold: 0,
    // Placeholders — replaced right below once `s` exists to close over.
    softFn: (x) => x,
    hardFn: (x) => x,
    eqHp: makeBiquad(),
    eqSub: makeBiquad(),
    eqBody: makeBiquad(),
    eqAttack: makeBiquad(),
    eqTiltLo: makeBiquad(),
    eqTiltHi: makeBiquad(),
    exLp: makeBiquad(),
    envFast: 0,
    envSlow: 0,
    detHp: makeBiquad(),
    detHp2: makeBiquad(),
    detEnv: 0,
  };
  // CLEAN (hard=0): tanh soft-clip — the 909-warm character. Pre-gain 1..4.
  s.softFn = (x) => Math.tanh((1 + 3 * s.driveAmt) * x);
  // HARD (hard=1): wavefold with depth riding the body envelope (driveFold),
  // then a bounded asymmetric shaper (the x² term adds even-harmonic bite;
  // the post-drive DC block strips its offset). Pre-gain 1..5.5, hotter.
  s.hardFn = (x) => {
    const pre = (1 + 4.5 * s.driveAmt) * (1 + 0.5 * s.driveFold);
    const f = reflectFold(pre * x);
    return Math.tanh(1.2 * f + 0.25 * f * f);
  };
  return s;
}

// ─────────────────────────────────────────────────────────────────────────
// Frequency laws (pure — unit-tested directly)
// ─────────────────────────────────────────────────────────────────────────

/** −60 dB decay-time (ms) → per-sample envelope multiplier. ln(1000) ≈ 6.908:
 *  env·a^(ms·sr/1000) = 10^(−60/20). */
export function decayCoeff(ms: number, sr: number): number {
  const samples = Math.max(1, (clamp(ms, 1, 10000) / 1000) * sr);
  return Math.exp(-6.907755278982137 / samples);
}

/** The sub's frequency law: `tune` transposed by pitch_cv, with a GENTLE
 *  settle — the sub starts at most 1.5× above its tune (scaled by how deep
 *  the body sweep is set) so the low end lands quickly and cleanly. */
export function kickSubFreqHz(p: KickdrumP1Params, subPitchEnv: number): number {
  const base = clamp(p.tune, 20, 120) * Math.pow(2, p.pitchCv);
  const startMult = 1 + 0.5 * clamp(p.pitchAmt / 24, 0, 1);
  return base * (1 + (startMult - 1) * clamp(subPitchEnv, 0, 1));
}

/** The body's frequency law: one octave above the sub's settled pitch, swept
 *  from `pitchAmt` semitones above at the strike, plus the smoothed
 *  amplitude→pitch `tension` term (accent deepens the sweep by up to 50%). */
export function kickBodyFreqHz(
  p: KickdrumP1Params,
  bodyPitchEnv: number,
  tensionTerm: number,
  accent: number,
): number {
  const settled = 2 * clamp(p.tune, 20, 120) * Math.pow(2, p.pitchCv);
  const depthSemis = clamp(p.pitchAmt, 0, 48) * (1 + 0.5 * clamp(accent, 0, 1));
  const sweepMult = Math.pow(2, (depthSemis / 12) * clamp(bodyPitchEnv, 0, 1));
  return settled * sweepMult * (1 + clamp(tensionTerm, 0, 0.6));
}

// ─────────────────────────────────────────────────────────────────────────
// Per-sample step
// ─────────────────────────────────────────────────────────────────────────

const FLUSH = 1e-20;

/**
 * One sample of the full voice, PRE-ceiling (mono mid path). Also refreshes
 * `s.sideOut` (the >120 Hz stereo side). The public steps below apply the
 * level + true-peak ceiling per output channel.
 */
function kickdrumVoiceStep(
  trigger: number,
  accent: number,
  p: KickdrumP1Params,
  sr: number,
  s: KickdrumState,
): number {
  // ── strike detection (per-sample rising edge; worklet-canonical) ──
  const high = trigger >= 0.5;
  const prevHigh = s.gatePrev >= 0.5;
  s.gatePrev = trigger;
  if (high && !prevHigh) {
    s.subPhase = 0;
    s.bodyPhase = 0;
    s.subAmp = 1;
    s.bodyAmp = 1;
    s.subPitchEnv = 1;
    s.bodyPitchEnv = 1;
    s.accentLatch = clamp(accent, 0, 1);
    // Click: reseed + zero BOTH filters so every hit is bit-identical.
    s.clickEnv = 1;
    s.clickRng = CLICK_SEED;
    s.clickLow = 0;
    s.clickBand = 0;
    s.clickRng2 = (CLICK_SEED ^ 0x55aa55aa) >>> 0;
    s.clickLow2 = 0;
    s.clickBand2 = 0;
  }

  // ── tension term: body-amp-proportional, one-pole smoothed at ~40 Hz ──
  const tTarget = clamp(p.tension, 0, 0.6) * s.bodyAmp;
  const tCoeff = Math.exp((-2 * Math.PI * 40) / sr);
  s.tensionSm = tTarget + (s.tensionSm - tTarget) * tCoeff;
  if (Math.abs(s.tensionSm) < FLUSH) s.tensionSm = 0;

  // ── oscillators ──
  const subHz = kickSubFreqHz(p, s.subPitchEnv);
  const subDt = subHz / sr;
  const sub = Math.sin(2 * Math.PI * s.subPhase) * s.subAmp;
  s.subPhase += subDt;
  if (s.subPhase >= 1) s.subPhase -= Math.floor(s.subPhase);

  const bodyHz = kickBodyFreqHz(p, s.bodyPitchEnv, s.tensionSm, s.accentLatch);
  const bodyDt = Math.min(0.49, bodyHz / sr);
  const w = moogWaves(s.bodyPhase, bodyDt, 0.5);
  const shape = clamp(p.bodyShape, 0, 1);
  const bodyWave =
    shape < 0.5
      ? w.sine + (w.triangle - w.sine) * (shape * 2)
      : w.triangle + (w.rectangular - w.triangle) * ((shape - 0.5) * 2);
  const body = bodyWave * s.bodyAmp;
  s.bodyPhase += bodyDt;
  if (s.bodyPhase >= 1) s.bodyPhase -= Math.floor(s.bodyPhase);

  // ── click layer: TWO decorrelated seeded-noise → SVF band-pass chains.
  // Their MID feeds the mono voice; their DIFFERENCE (HP'd at 120 Hz) is
  // the stereo side signal — the only stereo content in the voice. ──
  const fc = clamp(p.clickTone, 500, 6000);
  const f = 2 * Math.sin((Math.PI * Math.min(fc, sr * 0.22)) / sr);
  s.clickRng = xorshift32(s.clickRng);
  const noiseL = (s.clickRng / 0xffffffff) * 2 - 1;
  const hpL = noiseL - s.clickLow - 0.6 * s.clickBand;
  s.clickBand += f * hpL;
  s.clickLow += f * s.clickBand;
  if (Math.abs(s.clickBand) < FLUSH) s.clickBand = 0;
  if (Math.abs(s.clickLow) < FLUSH) s.clickLow = 0;
  s.clickRng2 = xorshift32(s.clickRng2);
  const noiseR = (s.clickRng2 / 0xffffffff) * 2 - 1;
  const hpR = noiseR - s.clickLow2 - 0.6 * s.clickBand2;
  s.clickBand2 += f * hpR;
  s.clickLow2 += f * s.clickBand2;
  if (Math.abs(s.clickBand2) < FLUSH) s.clickBand2 = 0;
  if (Math.abs(s.clickLow2) < FLUSH) s.clickLow2 = 0;
  const clickL = s.clickBand * s.clickEnv;
  const clickR = s.clickBand2 * s.clickEnv;
  const click = 0.5 * (clickL + clickR);

  // ── envelope decays (all sr-calibrated; −60 dB at the knob time) ──
  s.subAmp *= decayCoeff(p.subDecay, sr);
  s.bodyAmp *= decayCoeff(p.bodyDecay, sr);
  s.clickEnv *= decayCoeff(clamp(p.clickLen, 2, 60), sr);
  if (s.clickEnv < FLUSH) s.clickEnv = 0;
  // Pitch envelopes: body at the pitchTime knob; sub settles 3× slower than
  // the body sweep (the "slow settle" of the plan's Layer 1).
  s.bodyPitchEnv *= decayCoeff(clamp(p.pitchTime, 5, 120), sr);
  s.subPitchEnv *= decayCoeff(clamp(p.pitchTime, 5, 120) * 3, sr);
  if (s.subAmp < FLUSH) s.subAmp = 0;
  if (s.bodyAmp < FLUSH) s.bodyAmp = 0;
  if (s.subPitchEnv < FLUSH) s.subPitchEnv = 0;
  if (s.bodyPitchEnv < FLUSH) s.bodyPitchEnv = 0;

  // ── mix with the headroom invariant: peak ≤ 1 into the drive ──
  const subLv = clamp(p.subLevel, 0, 1);
  const bodyLv = clamp(p.bodyLevel, 0, 1);
  const clickLv = clamp(p.clickLevel, 0, 1);
  const norm = Math.max(1, subLv + bodyLv + clickLv);
  const mixed = (sub * subLv + body * bodyLv + click * clickLv) / norm;
  // Stereo side: the decorrelated click difference, HP'd at 120 Hz so no
  // low-band content can ever decohere the sub. Consumed by the stereo step.
  updateHighpass(s.sideHp, 120, sr);
  updateHighpass(s.sideHp2, 120, sr);
  s.sideOut = biquadStep(
    s.sideHp2,
    biquadStep(s.sideHp, (0.5 * (clickL - clickR) * clickLv) / norm),
  );

  // ── oversampled drive (the owner's `hard` switch picks the character AND
  // the rated factor: clean tanh @2×, wavefold+asym @4×) ──
  let driven = mixed;
  const driveAmt = clamp(p.drive, 0, 1);
  if (driveAmt > 0.001) {
    s.driveAmt = driveAmt;
    s.driveFold = s.bodyAmp; // fold depth rides the body envelope (hard mode)
    driven =
      p.hard >= 0.5 ? s.os4.process(mixed, s.hardFn) : s.os2.process(mixed, s.softFn);
  }

  // ── DC block (~20 Hz, POST-drive: strips the asym shaper's offset too) ──
  const clean = dcBlockStep(driven, s.dc, 20, sr);

  // ── Phase 3: harmonic exciter ("translate") — an ASYMMETRIC saturator on a
  // copy of the SUB (the x² term is what creates the EVEN 2nd harmonic; a
  // plain tanh is odd and can only make 3rd/5th), low-passed at 300 Hz. For a
  // 40 Hz tune this synthesizes 80/120/160 Hz so small speakers reconstruct
  // the missing fundamental. Summed BEFORE the EQ chain so the 22 Hz HPF
  // strips the x² term's DC offset. ──
  const tr = clamp(p.translate, 0, 1);
  let pre = clean;
  if (tr > 0.001) {
    updateLowpass(s.exLp, 300, sr);
    const drySub = sub * subLv;
    const excited = biquadStep(s.exLp, Math.tanh(2.2 * drySub + 0.9 * drySub * drySub));
    pre = clean + tr * 0.8 * excited;
  }

  // ── Phase 3: EQ chain (own-code RBJ; NOT resofilter) ──
  updateHighpass(s.eqHp, 22, sr);
  updateLowShelf(s.eqSub, 50, clamp(p.subEq, -12, 12), sr);
  updatePeaking(s.eqBody, 150, clamp(p.bodyEq, -12, 12), 1.0, sr);
  updatePeaking(s.eqAttack, 2800, clamp(p.attackEq, -12, 12), 0.8, sr);
  const tilt = clamp(p.tilt, -1, 1);
  updateLowShelf(s.eqTiltLo, 250, -4 * tilt, sr);
  updateHighShelf(s.eqTiltHi, 2500, 4 * tilt, sr);
  let eq = biquadStep(s.eqHp, pre);
  eq = biquadStep(s.eqSub, eq);
  eq = biquadStep(s.eqBody, eq);
  eq = biquadStep(s.eqAttack, eq);
  eq = biquadStep(s.eqTiltLo, eq);
  eq = biquadStep(s.eqTiltHi, eq);

  // ── Phase 4: threshold-free transient shaper (fast/slow follower pair) ──
  const mag = Math.abs(eq);
  const kUp = (tauMs: number) => 1 - Math.exp(-1000 / (tauMs * sr));
  s.envFast += (mag - s.envFast) * (mag > s.envFast ? kUp(1) : kUp(20));
  s.envSlow += (mag - s.envSlow) * (mag > s.envSlow ? kUp(25) : kUp(120));
  if (s.envFast < FLUSH) s.envFast = 0;
  if (s.envSlow < FLUSH) s.envSlow = 0;
  const transient = clamp((s.envFast - s.envSlow) * 3, 0, 1);
  const tail = clamp((s.envSlow - s.envFast) * 3, 0, 1);
  let shaped = eq * clamp(
    (1 + clamp(p.attack, -1, 1) * 1.2 * transient) *
      (1 + clamp(p.sustain, -1, 1) * 1.0 * tail),
    0.25,
    3,
  );

  // ── Phase 4: opto glue — detector HPF'd at 100 Hz so the sub can't pump ──
  const glue = clamp(p.glue, 0, 1);
  if (glue > 0.001) {
    updateHighpass(s.detHp, 100, sr);
    updateHighpass(s.detHp2, 100, sr);
    const det = Math.abs(biquadStep(s.detHp2, biquadStep(s.detHp, shaped)));
    s.detEnv += (det - s.detEnv) * (det > s.detEnv ? kUp(5) : kUp(150));
    if (s.detEnv < FLUSH) s.detEnv = 0;
    shaped /= 1 + 2.5 * glue * s.detEnv;
  }

  // ── Phase 4: level (pre-ceiling, so hot settings LEAN into the clip).
  // The CEILING itself lives in the public wrappers so each stereo channel
  // is independently true-peak-bounded. ──
  return shaped * Math.pow(10, clamp(p.level, -24, 12) / 20);
}

/** One MONO sample (mid only) through the true-peak ceiling — byte-for-byte
 *  the Phase 1-4 behavior. */
export function kickdrumP1Step(
  trigger: number,
  accent: number,
  p: KickdrumP1Params,
  sr: number,
  s: KickdrumState,
): number {
  const m = kickdrumVoiceStep(trigger, accent, p, sr, s);
  const g = 1 + 2 * clamp(p.ceiling, 0, 1);
  return Math.tanh(g * m);
}

/**
 * One STEREO sample (Phase 5): mid ± width·side through the ceiling, each
 * channel independently bounded. side is >120 Hz only (decorrelated click),
 * so the sub is phase-coherent mono and the mono fold-down never thins —
 * (L+R)/2 cancels the side term to first order. Writes out[0]=L, out[1]=R.
 */
export function kickdrumStepStereo(
  trigger: number,
  accent: number,
  p: KickdrumP1Params,
  sr: number,
  s: KickdrumState,
  out: Float32Array,
): void {
  const m = kickdrumVoiceStep(trigger, accent, p, sr, s);
  const g = 1 + 2 * clamp(p.ceiling, 0, 1);
  const lin = Math.pow(10, clamp(p.level, -24, 12) / 20);
  const sd = s.sideOut * lin * clamp(p.width, 0, 1);
  out[0] = Math.tanh(g * (m + sd));
  out[1] = Math.tanh(g * (m - sd));
}
