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
}

export function makeKickdrumState(): KickdrumState {
  return {
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
  };
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

  // ── envelope decays (all sr-calibrated; −60 dB at the knob time) ──
  s.subAmp *= decayCoeff(p.subDecay, sr);
  s.bodyAmp *= decayCoeff(p.bodyDecay, sr);
  // Pitch envelopes: body at the pitchTime knob; sub settles 3× slower than
  // the body sweep (the "slow settle" of the plan's Layer 1).
  s.bodyPitchEnv *= decayCoeff(clamp(p.pitchTime, 5, 120), sr);
  s.subPitchEnv *= decayCoeff(clamp(p.pitchTime, 5, 120) * 3, sr);
  if (s.subAmp < FLUSH) s.subAmp = 0;
  if (s.bodyAmp < FLUSH) s.bodyAmp = 0;
  if (s.subPitchEnv < FLUSH) s.subPitchEnv = 0;
  if (s.bodyPitchEnv < FLUSH) s.bodyPitchEnv = 0;

  // ── mix with the Phase-1 headroom invariant: peak ≤ 1 pre-drive ──
  const subLv = clamp(p.subLevel, 0, 1);
  const bodyLv = clamp(p.bodyLevel, 0, 1);
  const norm = Math.max(1, subLv + bodyLv);
  const mixed = (sub * subLv + body * bodyLv) / norm;

  // ── DC block (~20 Hz; strips any strike step before the later drive) ──
  return dcBlockStep(mixed, s.dc, 20, sr);
}
