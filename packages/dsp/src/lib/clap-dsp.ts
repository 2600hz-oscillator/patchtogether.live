// packages/dsp/src/lib/clap-dsp.ts
//
// CLAP (id `clap`) — analog-modeled handclap voice, the fourth member of
// the drum-voice family (KICK DRUM / SNARE DRUM / TOM DRUM). One curated
// synthesis engine spans the classic analog clap lineage:
//
//   TR-808 canonical — the 808 clap is band-passed white noise (~1 kHz)
//                      through TWO parallel VCAs: a quad-comparator
//                      "sawtooth" envelope that retriggers 3 fast cycles
//                      ~10 ms apart then lets the final discharge ring
//                      ~2× longer (the "crack" of several hands landing
//                      not-quite-together), summed with a separate smooth
//                      ~100 ms "reverb" envelope (the fake room ring-out).
//                      Here: PULSES 3, SPREAD 10 ms, TONE ~1 kHz, TAIL
//                      ~150 ms, SNAP centered — the shipping default.
//   TR-909 dense     — the 909 clap runs brighter DIGITAL shift-register
//                      noise through a ~1.14 kHz / Q≈2 band-pass with a
//                      denser, faster retrigger burst. Here: PULSES 4-5,
//                      SPREAD short, TONE up, COLOR 0 (white), SNAP up.
//   Simmons ClapTrap — the 1980 dedicated clap box: adjustable burst
//                      spread into "applause" territory. Here: SPREAD
//                      long (each pulse reads as its own micro-clap),
//                      WIDTH narrow for the tuned disco slap.
//   LinnDrum-era     — sampled claps are dark and roomy; COLOR down-tilts
//                      the noise toward that heavier, softer read, TAIL
//                      long, SNAP low (room-dominant).
//
// Why every analog clap is built this way (brief): a real clap is a
// short broadband impulse from two palms plus the ROOM's response. One
// synth noise burst reads as "tick"; the circuit-sized caricature every
// clap since the 808 uses is (a) a MULTI-PULSE retrigger burst — several
// people's hands landing milliseconds apart — and (b) a separate longer
// noise envelope standing in for the room reverb. TONE/WIDTH place the
// band-pass (palm cavity resonance), COLOR darkens the noise source
// (analog transistor hiss vs bright digital registers), SNAP balances
// burst against room.
//
// Architecture (state-object discipline cloned from tomtom/kickdrum-dsp:
// sr-calibrated decays, seeded xorshift reseeded per strike, FLUSH=1e-20,
// no Math.random / Date.now — deterministic by construction):
//
//   NOISE  — seeded xorshift32 white noise → COLOR one-pole low-pass
//            (log-swept 9 kHz → 700 Hz: white → dark, gain-compensated).
//   BAND   — Chamberlin SVF band-pass at TONE (400–3 kHz), WIDTH mapping
//            the resonance from ringy Q≈5.5 to a broad splash, with
//            1/√q loudness compensation so WIDTH is a shape, not a
//            volume, knob.
//   BURST  — PULSES (2–5) retriggered fast envelopes SPREAD ms apart;
//            each pulse's −60 dB time equals the spacing (deep sawtooth
//            troughs, the 808 comparator shape) and the FINAL pulse
//            rings 2× longer (the 808's uninterrupted last discharge).
//            Pulse count + spacing are LATCHED at the strike edge.
//   TAIL   — the "reverb" envelope, fired AT THE LAST PULSE so the burst
//            stays articulated; −60 dB time = TAIL ms (CV-modulatable
//            continuously), fed from the band signal through one extra
//            one-pole low-pass (the room eats the top end first).
//   SNAP   — equal-power burst ↔ tail balance (√-law both sides).
//   DRIVE  — 2×-oversampled tanh soft-clip on the summed voice, gated
//            off entirely at drive≈0.
//   BUS    — 20 Hz DC block → level (dB) → final tanh true-peak bound,
//            so |out| < 1 by construction.

import { clamp, dcBlockStep, makeDcBlockState, type DcBlockState } from './dsp-utils';
import { createOversampler, type Oversampler } from './oversample';

const FLUSH = 1e-20;

// ─────────────────────────────────────────────────────────────────────────
// Physical / voicing constants
// ─────────────────────────────────────────────────────────────────────────

/** COLOR one-pole low-pass sweep (Hz, log): 0 = ~white (the pole sits at
 *  9 kHz, essentially transparent under the ≤3 kHz band-pass), 1 = dark
 *  LinnDrum-era rumble (700 Hz — the noise arrives at the band-pass
 *  already tilted, so even a bright TONE setting reads soft). */
const COLOR_FC_MAX = 9000;
const COLOR_FC_MIN = 700;
/** COLOR gain compensation: the dark pole eats broadband energy; up to
 *  +~9.5 dB at full dark keeps COLOR a timbre knob, not a volume knob. */
const COLOR_COMP = 2.0;
/** WIDTH → Chamberlin q coefficient (q = 1/Q): 0 = 0.18 (Q≈5.5, the tuned
 *  ringy disco slap), 1 = 1.60 (Q≈0.6, a broad noise splash). The SVF is
 *  the same Chamberlin used by TOM DRUM's breath layer. */
const WIDTH_Q_MIN = 0.18;
const WIDTH_Q_MAX = 1.6;
/** Band-pass output trim: white noise through the Chamberlin band output
 *  lands well under unity; 1/√q keeps narrow/wide comparably loud. */
const BP_GAIN = 3.0;
/** The FINAL burst pulse rings this × the inter-pulse spacing (the 808's
 *  last comparator discharge runs ~20 ms against the 10 ms cycles). */
const FINAL_PULSE_RATIO = 2;
/** TAIL feed darkening: one extra pole AT the band center — the "room"
 *  reflections lose the top skirt first, so the tail sits under the
 *  burst's crack instead of doubling it. */
const TAIL_GAIN = 1.15;
/** Accent macro: velocity boost (up to +80 % ≈ +5 dB into the output
 *  bound — the drum-family accent tier) and ROOM excitation (a harder
 *  clap pumps the reverb tail disproportionately, up to +60 % tail
 *  excitation — the hit is bigger, not just louder). */
const ACCENT_VEL = 0.8;
const ACCENT_TAIL = 0.6;
/** tone_cv scale: ±1 "volt" moves the band center ±1.5 octaves — a full
 *  ±1 V swing covers the knob's whole 400 Hz–3 kHz range from the 1 kHz
 *  default (the cv-range-standard full-swing rule). */
const TONE_CV_OCT = 1.5;
/** tail_cv: 2 octaves of tail TIME per volt (+1 V = ×4, −1 V = ×0.25) —
 *  ±1 V spans ~37 ms → 600 ms from the 150 ms default, close to the
 *  knob's full 30–800 ms range (same law as TOM DRUM's decay_cv). */
const TAIL_CV_OCT = 2;
const TAIL_CV_CLAMP = 2;
/** spread_cv: ±1.3 octaves of spacing per volt — ±1 V spans ~4.1 ms →
 *  24.6 ms from the 10 ms default: the knob's whole 4–25 ms range. */
const SPREAD_CV_OCT = 1.3;
/** Whole-voice trim so a default hit peaks ~0.6 pre-bound. */
const VOICE_NORM = 1.35;
/** Deterministic per-strike noise seed base. */
const NOISE_SEED_BASE = 0x2b992ddf;
/** Chamberlin SVF center clamp (fraction of sr) — stability guard. */
const SVF_FC_FRAC = 0.153;

// ─────────────────────────────────────────────────────────────────────────
// Params
// ─────────────────────────────────────────────────────────────────────────

export interface ClapParams {
  pulses: number; // burst onsets (2..5) — 3 = the 808, 4-5 = 909-dense
  spread: number; // inter-pulse spacing (ms, 4..25) — latched at the strike
  tone: number; // band-pass center (Hz, 400..3000)
  width: number; // band-pass resonance→bandwidth morph (0..1)
  tail: number; // reverb-tail −60 dB time (ms, 30..800)
  color: number; // noise color, white → dark (0..1)
  snap: number; // burst ↔ tail balance (0 = room only, 1 = dry burst)
  drive: number; // oversampled tanh soft-clip amount (0..1)
  level: number; // output level (dB, −24..+12)
  // CV inputs surfaced as params (the worklet feeds them per sample).
  toneCv: number; // ±1.5 oct/V on the band center (full-swing)
  tailCv: number; // 2 oct of tail time per volt (+1 V = ×4)
  spreadCv: number; // ±1.3 oct/V on the spacing (latched per strike)
}

export const CLAP_DEFAULTS: ClapParams = {
  pulses: 3,
  spread: 10,
  tone: 1000,
  width: 0.5,
  tail: 150,
  color: 0.15,
  snap: 0.5,
  drive: 0.2,
  level: 0,
  toneCv: 0,
  tailCv: 0,
  spreadCv: 0,
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
// Control laws (pure — unit-tested directly)
// ─────────────────────────────────────────────────────────────────────────

/** Effective band-pass center (Hz): TONE knob × 2^(1.5·tone_cv), clamped
 *  200–4200 Hz. ±1 V covers the whole 400–3000 knob range from 1 kHz. */
export function clapToneHz(tone: number, toneCv: number): number {
  return clamp(
    clamp(tone, 400, 3000) * Math.pow(2, TONE_CV_OCT * clamp(toneCv, -2, 2)),
    200,
    4200,
  );
}

/** Effective tail time (ms): TAIL knob × 2^(2·tail_cv), clamped 15–1600. */
export function clapTailMs(tail: number, tailCv: number): number {
  return clamp(
    clamp(tail, 30, 800) *
      Math.pow(2, TAIL_CV_OCT * clamp(tailCv, -TAIL_CV_CLAMP, TAIL_CV_CLAMP)),
    15,
    1600,
  );
}

/** Effective inter-pulse spacing (ms): SPREAD knob × 2^(1.3·spread_cv),
 *  clamped 2–50. Latched at the strike edge (a hit's burst geometry is
 *  fixed the instant the hands land). */
export function clapSpreadMs(spread: number, spreadCv: number): number {
  return clamp(
    clamp(spread, 4, 25) * Math.pow(2, SPREAD_CV_OCT * clamp(spreadCv, -2, 2)),
    2,
    50,
  );
}

/** Latched burst pulse count (integer 2..5). */
export function clapPulseCount(pulses: number): number {
  return Math.round(clamp(pulses, 2, 5));
}

/** WIDTH (0..1) → Chamberlin q coefficient (1/Q): ringy 0.18 → broad 1.6. */
export function clapWidthQ(width: number): number {
  return WIDTH_Q_MIN + (WIDTH_Q_MAX - WIDTH_Q_MIN) * clamp(width, 0, 1);
}

/** COLOR (0..1) → noise low-pass pole (Hz), log-swept 9 kHz → 700 Hz. */
export function clapColorFc(color: number): number {
  return COLOR_FC_MAX * Math.pow(COLOR_FC_MIN / COLOR_FC_MAX, clamp(color, 0, 1));
}

// ─────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────

export interface ClapState {
  // NOISE source + COLOR pole.
  rng: number;
  colorLp: number;
  // BAND Chamberlin SVF state.
  svfLow: number;
  svfBand: number;
  // TAIL darkening pole.
  tailLp: number;
  // Envelopes.
  burstEnv: number; // retriggered fast burst envelope (1 → 0 per pulse)
  tailEnv: number; // the "reverb" envelope (fires at the last pulse)
  // Burst scheduler — latched at the strike edge.
  sinceStrike: number; // samples since the strike (−1 = never struck)
  pulseK: number; // next pulse index to fire
  pulsesN: number; // latched pulse count
  spreadSamp: number; // latched inter-pulse spacing (samples)
  spreadMsLatched: number; // latched spacing (ms) — per-pulse decay time
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

export function makeClapState(): ClapState {
  const s: ClapState = {
    rng: NOISE_SEED_BASE,
    colorLp: 0,
    svfLow: 0,
    svfBand: 0,
    tailLp: 0,
    burstEnv: 0,
    tailEnv: 0,
    sinceStrike: -1,
    pulseK: 0,
    pulsesN: 0,
    spreadSamp: 1,
    spreadMsLatched: 10,
    accentLatch: 0,
    vel: 0,
    trigPrev: 0,
    dc: makeDcBlockState(),
    os2: createOversampler(2),
    driveAmt: 0,
    softFn: (x) => x,
  };
  // Warm tanh soft-clip @2× — pre-gain 1..4 with drive (the drum-family
  // channel saturation; one curated character, no HARD switch).
  s.softFn = (x) => Math.tanh((1 + 3 * s.driveAmt) * x);
  return s;
}

/** Strike: latch the burst geometry (count + spacing) and the accent,
 *  arm the pulse scheduler, reseed + reset the noise/filter state.
 *  Bit-identical per strike by construction. */
export function strikeClap(s: ClapState, accent: number, p: ClapParams, sr: number): void {
  s.sinceStrike = 0;
  s.pulseK = 0;
  s.pulsesN = clapPulseCount(p.pulses);
  s.spreadMsLatched = clapSpreadMs(p.spread, p.spreadCv);
  s.spreadSamp = Math.max(1, Math.round((s.spreadMsLatched / 1000) * sr));
  s.accentLatch = clamp(accent, 0, 1);
  s.vel = 1 + ACCENT_VEL * s.accentLatch;
  s.burstEnv = 0; // pulse 0 fires in the scheduler this same sample
  s.tailEnv = 0; // fires at the last pulse
  s.rng = NOISE_SEED_BASE;
  s.colorLp = 0;
  s.svfLow = 0;
  s.svfBand = 0;
  s.tailLp = 0;
}

// ─────────────────────────────────────────────────────────────────────────
// Per-sample step
// ─────────────────────────────────────────────────────────────────────────

/** Chamberlin SVF `f` coefficient for a center freq, clamped for stability. */
function svfF(fc: number, sr: number): number {
  return 2 * Math.sin((Math.PI * Math.min(fc, SVF_FC_FRAC * sr)) / sr);
}

/** One-pole low-pass gain for a cutoff (Hz). */
function onePoleG(fc: number, sr: number): number {
  return 1 - Math.exp((-2 * Math.PI * Math.min(fc, 0.45 * sr)) / sr);
}

/**
 * One MONO sample. Detects the strike (per-sample rising edge at the
 * canonical 0.5 threshold — the worklet consumer pattern, exempt from
 * createEdgeCounter per CLAUDE.md; the def declares edge:'trigger' via
 * $lib/audio/gate-trigger semantics), runs the burst scheduler, renders
 * NOISE → COLOR → BAND → the two envelope VCAs, applies SNAP / DRIVE /
 * DC / LEVEL, and returns a true-peak bounded sample (|out| < 1 — the
 * chain ends in tanh).
 */
export function clapStep(
  trigger: number,
  accent: number,
  p: ClapParams,
  sr: number,
  s: ClapState,
): number {
  // ── STRIKE: one clap per rising edge (edge:'trigger' semantics). ──
  const high = trigger >= 0.5;
  const prevHigh = s.trigPrev >= 0.5;
  s.trigPrev = trigger;
  if (high && !prevHigh) strikeClap(s, accent, p, sr);

  // ── BURST scheduler: fire pulse k at k·spread; the LAST pulse also
  // fires the reverb TAIL (the 808's final discharge hands off to the
  // room ring-out). ──
  if (s.sinceStrike >= 0) {
    while (s.pulseK < s.pulsesN && s.sinceStrike >= s.pulseK * s.spreadSamp) {
      s.burstEnv = 1;
      if (s.pulseK === s.pulsesN - 1) {
        s.tailEnv = 1 + ACCENT_TAIL * s.accentLatch;
      }
      s.pulseK++;
    }
    s.sinceStrike++;
  }

  // ── NOISE → COLOR pole (white → dark, gain-compensated). ──
  s.rng = xorshift32(s.rng);
  const nz = (s.rng / 0xffffffff) * 2 - 1;
  const colorAmt = clamp(p.color, 0, 1);
  const gC = onePoleG(clapColorFc(colorAmt), sr);
  s.colorLp += gC * (nz - s.colorLp);
  if (Math.abs(s.colorLp) < FLUSH) s.colorLp = 0;
  const colored = s.colorLp * (1 + COLOR_COMP * colorAmt);

  // ── BAND: Chamberlin band-pass at TONE, WIDTH-mapped q, 1/√q trim. ──
  const fcHz = clapToneHz(p.tone, p.toneCv);
  const fB = svfF(fcHz, sr);
  const qB = clapWidthQ(p.width);
  const hp = colored - s.svfLow - qB * s.svfBand;
  s.svfBand += fB * hp;
  s.svfLow += fB * s.svfBand;
  if (Math.abs(s.svfBand) < FLUSH) s.svfBand = 0;
  if (Math.abs(s.svfLow) < FLUSH) s.svfLow = 0;
  const band = (s.svfBand * BP_GAIN) / Math.sqrt(qB);

  // ── TAIL feed: one extra pole at the band center (the room eats the
  // top end first), so the tail sits under the burst's crack. ──
  const gT = onePoleG(fcHz, sr);
  s.tailLp += gT * (band - s.tailLp);
  if (Math.abs(s.tailLp) < FLUSH) s.tailLp = 0;

  // ── The two VCAs + SNAP equal-power balance. ──
  const snapEff = clamp(p.snap, 0, 1);
  const burst = band * s.burstEnv * Math.sqrt(snapEff);
  const tail = s.tailLp * s.tailEnv * TAIL_GAIN * Math.sqrt(1 - snapEff);

  // ── envelopes (sr-calibrated): each burst pulse decays to −60 dB in
  // exactly the inter-pulse spacing (deep sawtooth troughs — the 808
  // comparator shape); the FINAL pulse rings 2× longer; the tail runs
  // the CV-modulatable TAIL time continuously. ──
  const finalPulse = s.pulseK >= s.pulsesN;
  const burstMs = s.spreadMsLatched * (finalPulse ? FINAL_PULSE_RATIO : 1);
  s.burstEnv *= decayCoeff(burstMs, sr);
  s.tailEnv *= decayCoeff(clapTailMs(p.tail, p.tailCv), sr);
  if (s.burstEnv < FLUSH) s.burstEnv = 0;
  if (s.tailEnv < FLUSH) s.tailEnv = 0;

  // ── sum + DRIVE (2×-oversampled warm tanh, gated behind drive>0). ──
  const pre = (burst + tail) * VOICE_NORM * s.vel;
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
