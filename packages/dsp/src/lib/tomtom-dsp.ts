// packages/dsp/src/lib/tomtom-dsp.ts
//
// TOM DRUM (id `tomtom`) — analog-modeled tom-tom voice, the third member of
// the drum-voice family (KICK DRUM / SNARE DRUM). One curated synthesis
// engine spans the classic analog tom lineage:
//
//   TR-808 woody  — the 808 tom is a bridged-T resonator (a self-damping
//                   near-sine that rings when pulsed, with a SUBTLE downward
//                   pitch relaxation as the diodes starve the feedback) plus
//                   a band-limited noise "breath" over the attack. Here:
//                   low TUNE, short BEND, moderate NOISE, low TONE.
//   TR-909 punchy — the 909 tom is a swept oscillator with tuned overtone
//                   content (the service notes give a 1 : 1.5 : 2.77 VCO
//                   stack) + click + noise. Here: mid TUNE, medium BEND
//                   depth/time, some TONE (the 2nd partial), DRIVE for the
//                   analog heat.
//   Simmons SDS-V — the classic hexagon synth-tom: triangle VCO + noise
//                   through an SSM2044 LP, with the trademark deep pitch
//                   BEND ("piuuu"). Here: max BEND depth + long BEND time =
//                   the octave-class zap.
//   Vermona DRM1  — the modern analog reference for the CONTROL SET: its tom
//                   channel is tune, bend, decay, attack/noise, drive — the
//                   same curated knob family this module exposes.
//
// Membrane physics (brief): a struck drumhead's (0,1) fundamental is joined
// by inharmonic upper modes — the first meaningful partner sits at ~1.59×
// the fundamental (the Bessel-zero ratio also used by SNARE DRUM's modal
// bank) — and the head TENSION momentarily rises at the strike, so pitch
// starts sharp and relaxes down. That's why EVERY analog tom since the 808
// has a downward pitch envelope: it's the circuit-sized caricature of real
// membrane behavior. TONE here tilts fundamental ↔ that 1.59× second mode;
// BEND is the tension glide; NOISE balances membrane ↔ breath (the SDS-V
// tone/noise mix law — its kits sweep from pure-tone to pure-noise hits).
//
// Architecture (state-object discipline cloned from kickdrum/snaredrum-dsp:
// sr-calibrated decays, seeded xorshift reseeded per strike, FLUSH=1e-20,
// no Math.random / Date.now — deterministic by construction):
//
//   MEMBRANE — phase-accumulated sine fundamental + a 1.593× second-mode
//              partial (TONE), both riding ONE exponential pitch-BEND env
//              (depth st / time ms) and an exponential amp env (DECAY).
//              Decay is FREQUENCY-COMPENSATED: the −60 dB time is set in ms
//              independent of TUNE (a 60 Hz floor tom and a 400 Hz rack tom
//              ring the same length at the same knob), unlike a raw
//              constant-Q resonator whose high tunings die faster.
//   BREATH   — band-passed seeded noise (Chamberlin SVF) tracking the
//              membrane pitch a couple of octaves up: the 808's noisy skin
//              "breath" / the SDS-V's filtered-noise layer. Short decay
//              derived from (and clamped under) the main DECAY.
//   DRIVE    — 2×-oversampled tanh soft-clip on the summed voice (the
//              analog warmth), gated off entirely at drive≈0.
//   BUS      — 20 Hz DC block → level (dB) → final tanh true-peak bound, so
//              |out| < 1 by construction.

import { clamp, dcBlockStep, makeDcBlockState, type DcBlockState } from './dsp-utils';
import { createOversampler, type Oversampler } from './oversample';

const FLUSH = 1e-20;

// ─────────────────────────────────────────────────────────────────────────
// Physical / voicing constants
// ─────────────────────────────────────────────────────────────────────────

/** Second membrane mode ratio — the (1,1)/(0,1) Bessel-zero pair, the same
 *  1.593 SNARE DRUM's modal bank uses. TONE mixes this partial in. */
export const OVERTONE_RATIO = 1.593;
/** The overtone decays faster than the fundamental (higher modes damp
 *  harder on a real head): its −60 dB time is this fraction of DECAY. */
const OVERTONE_DECAY_FRAC = 0.6;
/** Overtone mix gain at TONE = 1 (audibly present, still under the
 *  fundamental once its faster decay is accounted for). */
const OVERTONE_GAIN = 1.0;
/** Breath noise band-pass center = settled fundamental × this ratio (the
 *  808 tom's noise sits well above the resonator; SDS-V "noise tone"). */
const NOISE_CENTER_RATIO = 2.5;
/** Breath band-pass center clamp (Hz). */
const NOISE_FC_MIN = 300;
const NOISE_FC_MAX = 6000;
/** Breath decay = DECAY × this fraction, clamped to [25, 500] ms — the
 *  breath rides (but always undercuts) the main decay, like the SDS-V's
 *  filtered-noise half; it never becomes a sustained hiss. */
const NOISE_DECAY_FRAC = 0.5;
const NOISE_DECAY_MIN_MS = 25;
const NOISE_DECAY_MAX_MS = 500;
/** Breath output gain at NOISE = 1 — compensates the band-pass attenuation
 *  of unit white noise (the Chamberlin band output of white noise at these
 *  centers/q measures ~0.05 rms), so a full-up NOISE reads as a clearly
 *  audible 808-style breath, not a subliminal hiss. */
const NOISE_GAIN = 8;
/** TONE and NOISE are BALANCES, not garnishes (the SDS-V precedent: its
 *  tone/noise mix sweeps between a pure-tone hit and a pure-noise hit).
 *  TONE ducks the fundamental as the second mode comes up; NOISE ducks the
 *  whole membrane as the breath comes up. Neither fully mutes its base
 *  layer — the voice stays a drum at every knob position. */
const TONE_FUND_DUCK = 0.6;
const NOISE_MEMB_DUCK = 0.7;
/** Whole-voice trim so a default hit peaks ~0.6 pre-bound. */
const VOICE_NORM = 0.62;
/** Accent macro: velocity boost (up to +80 % ≈ +5 dB, leaning into the
 *  output bound — the KICK DRUM accent-macro tier), BEND deepening (an
 *  accented stroke stretches the head harder, up to +50 % sweep depth),
 *  and BRIGHTENING (impact nonlinearity: a harder stick excites the upper
 *  mode + the skin noise disproportionately — the accented hit is brighter,
 *  not just louder; up to 2× overtone/breath excitation). */
const ACCENT_VEL = 0.8;
const ACCENT_BEND = 0.5;
const ACCENT_BRIGHT = 1.0;
/** bend_cv scale: ±1 "volt" adds ±24 semitones of bend depth — a full
 *  ±1 V swing covers the knob's whole 0–24 st range from any position
 *  (the cv-range-standard full-swing rule: a ±1 LFO must drive the param
 *  through close to its full range of motion). */
const BEND_CV_ST = 24;
/** decay_cv: 2 octaves of decay TIME per volt (+1 V = ×4, −1 V = ×0.25) —
 *  ±1 V spans ~87 ms → 1400 ms from the 350 ms default, close to the
 *  knob's full 40–1500 ms range (the cv-range-standard rule). */
const DECAY_CV_OCT = 2;
const DECAY_CV_CLAMP = 2;
/** Deterministic per-strike noise seed base. */
const NOISE_SEED_BASE = 0x7c3a9d51;
/** Chamberlin SVF center clamp (fraction of sr) — stability guard. */
const SVF_FC_FRAC = 0.153;

// ─────────────────────────────────────────────────────────────────────────
// Params
// ─────────────────────────────────────────────────────────────────────────

export interface TomtomParams {
  tune: number; // fundamental Hz (60..400) — floor tom .. high rack/timbale
  bendAmt: number; // strike pitch-sweep depth (semitones, 0..24)
  bendTime: number; // sweep settle time to −60 dB (ms, 10..300)
  decay: number; // amp decay to −60 dB (ms, 40..1500) — frequency-compensated
  tone: number; // 2nd-mode (1.593×) overtone mix (0..1)
  noise: number; // breath / skin noise mix (0..1)
  drive: number; // oversampled tanh soft-clip amount (0..1)
  level: number; // output level (dB, −24..+12)
  // CV inputs surfaced as params (the worklet feeds them per sample).
  pitchCv: number; // 1 V/oct multiplier on tune
  bendCv: number; // ±1 V adds ±24 st of bend depth (full-swing)
  decayCv: number; // 2 oct of decay time per volt (+1 V = ×4)
  toneCv: number; // adds to tone (summed, clamped 0..1)
  noiseCv: number; // adds to noise (summed, clamped 0..1)
}

export const TOMTOM_DEFAULTS: TomtomParams = {
  tune: 110,
  bendAmt: 7,
  bendTime: 60,
  decay: 350,
  tone: 0.35,
  noise: 0.25,
  drive: 0.25,
  level: 0,
  pitchCv: 0,
  bendCv: 0,
  decayCv: 0,
  toneCv: 0,
  noiseCv: 0,
};

// ─────────────────────────────────────────────────────────────────────────
// Shared primitives (defined locally — no cross-module coupling)
// ─────────────────────────────────────────────────────────────────────────

/** −60 dB decay-time (ms) → per-sample envelope multiplier (sr-calibrated).
 *  ln(1000) ≈ 6.9078: env·a^(ms·sr/1000) = 10^(−60/20). */
export function decayCoeff(ms: number, sr: number): number {
  const samples = Math.max(1, (clamp(ms, 1, 10000) / 1000) * sr);
  return Math.exp(-6.907755278982137 / samples);
}

/** Deterministic 32-bit xorshift PRNG step. */
export function xorshift32(x: number): number {
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  return x >>> 0;
}

// ─────────────────────────────────────────────────────────────────────────
// Frequency law (pure — unit-tested directly)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Instantaneous fundamental (Hz): `tune` (60..400) transposed 1 V/oct by
 * pitchCv, times the downward pitch BEND — the strike starts `depthSt`
 * semitones sharp (deepened up to +50 % by the latched accent) and settles
 * exponentially as `bendEnv` decays 1 → 0. depthSt = 0 → a stable pitch;
 * depthSt = 24 → a 4× (two-octave) Simmons-class dive.
 */
export function tomFreqHz(
  tune: number,
  pitchCv: number,
  bendEnv: number,
  depthSt: number,
  accent: number,
): number {
  const base = clamp(tune, 60, 400) * Math.pow(2, pitchCv);
  const depth = clamp(depthSt, 0, 36) * (1 + ACCENT_BEND * clamp(accent, 0, 1));
  return base * Math.pow(2, (depth / 12) * clamp(bendEnv, 0, 1));
}

/** Effective bend depth (st) from the knob + bend_cv (±12 st per volt). */
export function tomBendDepthSt(bendAmt: number, bendCv: number): number {
  return clamp(clamp(bendAmt, 0, 24) + BEND_CV_ST * clamp(bendCv, -2, 2), 0, 36);
}

/** Effective decay (ms) from the knob + decay_cv (2 oct of time per volt). */
export function tomDecayMs(decay: number, decayCv: number): number {
  return clamp(
    clamp(decay, 40, 1500) *
      Math.pow(2, DECAY_CV_OCT * clamp(decayCv, -DECAY_CV_CLAMP, DECAY_CV_CLAMP)),
    20,
    3000,
  );
}

// ─────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────

export interface TomtomState {
  // MEMBRANE oscillators (phase 0..1) + envelopes.
  phase1: number;
  phase2: number;
  ampEnv: number; // fundamental amp (1 → 0, decay)
  otEnv: number; // overtone amp (1 → 0, decay × OVERTONE_DECAY_FRAC)
  bendEnv: number; // pitch bend (1 → 0, bendTime)
  // BREATH noise: seeded RNG + Chamberlin band-pass state + envelope.
  rng: number;
  nzLow: number;
  nzBand: number;
  noiseEnv: number;
  // Latched at the strike edge.
  accentLatch: number;
  vel: number;
  // Trigger edge memory.
  trigPrev: number;
  // Shared bus.
  dc: DcBlockState;
  os2: Oversampler;
  driveAmt: number;
  softFn: (x: number) => number;
}

export function makeTomtomState(): TomtomState {
  const s: TomtomState = {
    phase1: 0,
    phase2: 0,
    ampEnv: 0,
    otEnv: 0,
    bendEnv: 0,
    rng: NOISE_SEED_BASE,
    nzLow: 0,
    nzBand: 0,
    noiseEnv: 0,
    accentLatch: 0,
    vel: 0,
    trigPrev: 0,
    dc: makeDcBlockState(),
    os2: createOversampler(2),
    driveAmt: 0,
    softFn: (x) => x,
  };
  // Warm tanh soft-clip @2× — pre-gain 1..4 with drive (the DRM1-style
  // channel saturation; no HARD switch here — one curated character).
  s.softFn = (x) => Math.tanh((1 + 3 * s.driveAmt) * x);
  return s;
}

/** Strike: reset phases (click-free, deterministic), fire every envelope,
 *  latch accent, reseed the breath noise. Bit-identical per strike. */
export function strikeTom(s: TomtomState, accent: number): void {
  s.phase1 = 0;
  s.phase2 = 0;
  s.ampEnv = 1;
  s.bendEnv = 1;
  s.accentLatch = clamp(accent, 0, 1);
  // Impact nonlinearity: a harder strike is BRIGHTER, not just louder —
  // the second mode + the skin breath start proportionally hotter.
  s.otEnv = 1 + ACCENT_BRIGHT * s.accentLatch;
  s.noiseEnv = 1 + ACCENT_BRIGHT * s.accentLatch;
  s.vel = 1 + ACCENT_VEL * s.accentLatch;
  s.rng = NOISE_SEED_BASE;
  s.nzLow = 0;
  s.nzBand = 0;
}

// ─────────────────────────────────────────────────────────────────────────
// Per-sample step
// ─────────────────────────────────────────────────────────────────────────

const TWO_PI = Math.PI * 2;

/** Chamberlin SVF `f` coefficient for a center freq, clamped for stability. */
function svfF(fc: number, sr: number): number {
  return 2 * Math.sin((Math.PI * Math.min(fc, SVF_FC_FRAC * sr)) / sr);
}

/**
 * One MONO sample. Detects the strike (per-sample rising edge — the worklet
 * consumer pattern, exempt from createEdgeCounter per CLAUDE.md), renders
 * MEMBRANE + BREATH, applies drive / DC / level, and returns a true-peak
 * bounded sample (|out| < 1 — the chain ends in tanh).
 */
export function tomtomStep(
  trigger: number,
  accent: number,
  p: TomtomParams,
  sr: number,
  s: TomtomState,
): number {
  // ── STRIKE: one hit per rising edge (edge:'trigger' semantics). ──
  const high = trigger >= 0.5;
  const prevHigh = s.trigPrev >= 0.5;
  s.trigPrev = trigger;
  if (high && !prevHigh) strikeTom(s, accent);

  // ── effective (CV-summed) params. ──
  const depthSt = tomBendDepthSt(p.bendAmt, p.bendCv);
  const decayMs = tomDecayMs(p.decay, p.decayCv);
  const toneEff = clamp(clamp(p.tone, 0, 1) + p.toneCv, 0, 1);
  const noiseEff = clamp(clamp(p.noise, 0, 1) + p.noiseCv, 0, 1);

  // ── MEMBRANE: fundamental + 1.593× second mode on one bend law. ──
  const f1 = Math.min(tomFreqHz(p.tune, p.pitchCv, s.bendEnv, depthSt, s.accentLatch), 0.45 * sr);
  s.phase1 += f1 / sr;
  if (s.phase1 >= 1) s.phase1 -= 1;
  const fund = Math.sin(TWO_PI * s.phase1) * s.ampEnv;
  const f2 = Math.min(f1 * OVERTONE_RATIO, 0.45 * sr);
  s.phase2 += f2 / sr;
  if (s.phase2 >= 1) s.phase2 -= 1;
  const over = Math.sin(TWO_PI * s.phase2) * s.otEnv * toneEff * OVERTONE_GAIN;

  // ── BREATH: band-passed seeded noise tracking the settled pitch. ──
  s.rng = xorshift32(s.rng);
  const nz = (s.rng / 0xffffffff) * 2 - 1;
  const settled = clamp(p.tune, 60, 400) * Math.pow(2, p.pitchCv);
  const nfc = clamp(settled * NOISE_CENTER_RATIO, NOISE_FC_MIN, NOISE_FC_MAX);
  const fn = svfF(nfc, sr);
  const qn = 0.6;
  const nhp = nz - s.nzLow - qn * s.nzBand;
  s.nzBand += fn * nhp;
  s.nzLow += fn * s.nzBand;
  if (Math.abs(s.nzBand) < FLUSH) s.nzBand = 0;
  if (Math.abs(s.nzLow) < FLUSH) s.nzLow = 0;
  const breath = s.nzBand * s.noiseEnv * noiseEff * NOISE_GAIN;

  // ── envelopes (sr-calibrated; decay is FREQUENCY-COMPENSATED: the −60 dB
  // time is in ms regardless of tune, so a 60 Hz floor tom and a 400 Hz
  // rack tom ring equally long at the same knob). ──
  s.ampEnv *= decayCoeff(decayMs, sr);
  s.otEnv *= decayCoeff(decayMs * OVERTONE_DECAY_FRAC, sr);
  s.bendEnv *= decayCoeff(clamp(p.bendTime, 10, 300), sr);
  s.noiseEnv *= decayCoeff(
    clamp(decayMs * NOISE_DECAY_FRAC, NOISE_DECAY_MIN_MS, NOISE_DECAY_MAX_MS),
    sr,
  );
  if (s.ampEnv < FLUSH) s.ampEnv = 0;
  if (s.otEnv < FLUSH) s.otEnv = 0;
  if (s.bendEnv < FLUSH) s.bendEnv = 0;
  if (s.noiseEnv < FLUSH) s.noiseEnv = 0;

  // ── balance + sum + DRIVE (2×-oversampled warm tanh, gated behind
  // drive>0). TONE tilts fundamental ↔ second mode; NOISE balances the
  // whole membrane ↔ breath (the SDS-V tone/noise mix law). ──
  const membrane = fund * (1 - TONE_FUND_DUCK * toneEff) + over;
  const pre = (membrane * (1 - NOISE_MEMB_DUCK * noiseEff) + breath) * VOICE_NORM * s.vel;
  let driven = pre;
  const driveAmt = clamp(p.drive, 0, 1);
  if (driveAmt > 0.001) {
    s.driveAmt = driveAmt;
    driven = s.os2.process(pre, s.softFn);
  }

  // ── DC block → level → true-peak bound. ──
  const clean = dcBlockStep(driven, s.dc, 20, sr);
  const lin = Math.pow(10, clamp(p.level, -24, 12) / 20);
  return Math.tanh(clean * lin);
}
