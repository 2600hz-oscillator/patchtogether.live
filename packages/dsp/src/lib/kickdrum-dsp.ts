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
// explicit state object (chowkick discipline) so per-sample math is
// unit-testable without the worklet. Denormals flushed at 1e−20.

import { clamp, dcBlockStep, makeDcBlockState, type DcBlockState } from './chowkick-dsp';
import { moogWaves } from './moog-vco-dsp';
import { createOversampler, type Oversampler } from './oversample';

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
   *  canonical 4× start multiple — matches chowkick's PITCH_ENV_START_MULT). */
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
  /** Chamberlin SVF band-pass state for the click tone. */
  clickLow: number;
  clickBand: number;

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
    os2: createOversampler(2),
    os4: createOversampler(4),
    driveAmt: 0,
    driveFold: 0,
    // Placeholders — replaced right below once `s` exists to close over.
    softFn: (x) => x,
    hardFn: (x) => x,
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
 * One mono sample of the Phase-1 voice (sub + body → headroom-normalized sum
 * → 20 Hz DC block). `trigger` is the raw trigger-input sample; `accent` is
 * the raw accent-CV sample (latched at the strike edge only).
 */
export function kickdrumP1Step(
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
    // Click: reseed + zero the filter so every hit is bit-identical.
    s.clickEnv = 1;
    s.clickRng = CLICK_SEED;
    s.clickLow = 0;
    s.clickBand = 0;
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

  // ── click layer: seeded noise → Chamberlin SVF band-pass → its envelope ──
  s.clickRng = xorshift32(s.clickRng);
  const noise = (s.clickRng / 0xffffffff) * 2 - 1;
  const fc = clamp(p.clickTone, 500, 6000);
  const f = 2 * Math.sin((Math.PI * Math.min(fc, sr * 0.22)) / sr);
  const hp = noise - s.clickLow - 0.6 * s.clickBand;
  s.clickBand += f * hp;
  s.clickLow += f * s.clickBand;
  if (Math.abs(s.clickBand) < FLUSH) s.clickBand = 0;
  if (Math.abs(s.clickLow) < FLUSH) s.clickLow = 0;
  const click = s.clickBand * s.clickEnv;

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
  return dcBlockStep(driven, s.dc, 20, sr);
}
