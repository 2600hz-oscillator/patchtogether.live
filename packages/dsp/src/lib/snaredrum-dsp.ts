// packages/dsp/src/lib/snaredrum-dsp.ts
//
// SNARE DRUM (id `snaredrum`) — the single-hit stereo snare VOICE, the shared
// re-excitable wire-buzz BED, the shared drive/DC/ceiling BUS, and the stereo
// stage. Mate to KICK DRUM: it clones that proven template (state-object
// discipline, sr-calibrated decay, seeded xorshift reseeded per strike,
// FLUSH=1e-20, per-channel tanh ceiling, mono-safe M/S) and adds the polyphonic
// two-hand drumroll (packages/dsp/src/lib/snare-roll-dsp.ts). Design + build
// spec: .myrobots/snare-drum-module-design.md.
//
// Four decoupled acoustic layers, each an independently-decaying generator
// (design §1):
//   HEAD  — an inharmonic membrane modal bank at Bessel-zero ratios (self-ringing
//           Chamberlin resonators struck by an impulse) → the pitchless "thunk".
//   BODY  — band-passed seeded noise around the head → the drum's noisy "tone";
//           `tone` crossfades HEAD ↔ BODY.
//   WIRE  — the DEFINING snare timbre: bright HP'd noise on a SHARED re-excitable
//           bed (rings between strokes) PLUS a contact term gain-modulated by the
//           rectified head displacement. Lives on the top state (NOT per-voice) so
//           roll continuity never depends on voice count (design §3.5).
//   CRACK — a short band-passed noise stick-contact transient.
//
// The voice is a CHEAP GENERATOR only (HEAD + BODY + CRACK, short tails). Drive /
// DC / ceiling / stereo are applied ONCE to the summed pool+bed on the shared bus
// (design §3.6) — never per voice (per-voice oversampled drive × N voices would be
// catastrophic and needless). Every time constant derives from the LIVE sr; no
// Math.random / Date.now — every strike reseeds a deterministic xorshift.

import { clamp, dcBlockStep, makeDcBlockState, type DcBlockState } from './chowkick-dsp';
import { createOversampler, type Oversampler } from './oversample';
import { makeBiquad, biquadStep, updateHighpass, type Biquad } from './rbj-biquad';
import {
  MAX_VOICES,
  allocateVoice,
  makeRollState,
  rollStep,
  xorshift32,
  type RollParams,
  type RollState,
} from './snare-roll-dsp';

const FLUSH = 1e-20;

// ─────────────────────────────────────────────────────────────────────────
// Physical constants (design §2)
// ─────────────────────────────────────────────────────────────────────────

/** Head modal count. */
const NHEAD = 4;
/** Bessel-zero membrane ratios (ideal circular membrane); air-loading pulls the
 *  low pair together — index 1 is the (0,1) air-coupled partner ~3 % up. */
const MODE_RATIO = [1.0, 1.03, 1.593, 2.135] as const;
/** The Bessel ratios, exported for the frequency-law unit test. */
export const MODE_RATIO_TEST: readonly number[] = MODE_RATIO;
/** Per-mode output gains — the fundamental pair is present but heavily damped
 *  (design §1.1), the upper inharmonic modes carry the pitchless thunk. */
const MODE_GAIN = [0.9, 0.5, 0.6, 0.48] as const;
/** Impulse energy injected into each mode band at the strike. */
const INIT_EXCITE = [1.0, 0.75, 0.7, 0.6] as const;
/** Per-mode Q-loss multiplier — the (0,1) fundamental pair is heavily damped. */
const MODE_Q_MULT = [2.4, 2.2, 1.0, 0.9] as const;

/** Fixed crack-transient length (ms to −60 dB) — the stick-contact tick. */
const CRACK_LEN_MS = 8;
/** Deterministic per-strike noise seed base (reseeded, per-voice-index-varied). */
const NOISE_SEED_BASE = 0x2f6e15c3;
/** Whole-voice output trim so a default single hit sits ~0.6 pre-ceiling. */
const VOICE_NORM = 0.62;
/** Bed contact model: rectified-head → wire-gain scale + one-sided threshold. */
const CONTACT_K = 2.2;
const CONTACT_THRESH = 0.02;
/** How hard `accent_in` scales a hit's velocity (the accent macro; +drive/+level
 *  is applied pre-core in the worklet). */
const ACCENT_VEL = 0.5;
/** Energy-follower coefficient (the lowest-energy steal metric). */
const ENERGY_COEF = 0.02;
/** Voice-inactive threshold (skip the step; no denormal accumulation). */
const EPS_ACTIVE = 1e-4;
/** Chamberlin SVF center clamp (fraction of sr) — the numerical-stability guard
 *  for the low-Q self-ringing resonators. */
const SVF_FC_FRAC = 0.153;

// ─────────────────────────────────────────────────────────────────────────
// Params
// ─────────────────────────────────────────────────────────────────────────

export interface SnaredrumParams {
  tune: number; // head fundamental Hz (90..400)
  tone: number; // 0 HEAD-modes .. 1 BODY-noise crossfade
  damping: number; // head-mode Q/ring (tight muted .. open ringy)
  headDecay: number; // modal head ring to −60 dB (ms)
  bodyDecay: number; // noise-body decay to −60 dB (ms)
  pitchAmt: number; // downward head pitch-drop depth (st)
  pitchTime: number; // head pitch-drop settle time (ms)
  wire: number; // snare-wire buzz amount (the sizzle)
  wireTone: number; // wire HP corner (Hz)
  wireDecay: number; // wire bed decay to −60 dB (ms) — the roll's sustain
  crack: number; // stick-contact transient level
  crackTone: number; // transient band-pass center (Hz)
  damp: number; // global damp — scales head/body/wire decays together
  rollSpeed: number; // roll rate/hand (0..1 → 4..24 Hz)
  bounce: number; // roll type: 0 single → double → 1 buzz
  humanize: number; // seeded timing/vel/tune jitter
  spread: number; // two-hand pan + per-hand detune; 0 = mono
  drive: number; // saturation on the summed bus
  hard: number; // drive character switch (0 tanh @2× / 1 wavefold+asym @4×)
  ceiling: number; // per-channel true-peak soft-clip
  width: number; // M/S width of the decorrelated wire side
  level: number; // output level (dB, pre-ceiling)
  // Inputs surfaced as params for the pure core (worklet feeds them per sample).
  pitchCv: number; // 1 V/oct transpose of the whole voice
  rollSpeedCv: number; // 1 V/oct multiply on rollSpeed
}

export const SNAREDRUM_DEFAULTS: SnaredrumParams = {
  tune: 180,
  tone: 0.5,
  damping: 0.4,
  headDecay: 180,
  bodyDecay: 110,
  pitchAmt: 3,
  pitchTime: 18,
  wire: 0.7,
  wireTone: 4500,
  wireDecay: 260,
  crack: 0.4,
  crackTone: 3200,
  damp: 0.2,
  rollSpeed: 0.5,
  bounce: 0.35,
  humanize: 0.2,
  spread: 0.5,
  drive: 0.2,
  hard: 0,
  ceiling: 0.5,
  width: 0.4,
  level: 0,
  pitchCv: 0,
  rollSpeedCv: 0,
};

// ─────────────────────────────────────────────────────────────────────────
// Shared primitives (define locally — no cross-module coupling to kickdrum)
// ─────────────────────────────────────────────────────────────────────────

/** −60 dB decay-time (ms) → per-sample envelope multiplier (sr-calibrated).
 *  ln(1000) ≈ 6.9078: env·a^(ms·sr/1000) = 10^(−60/20). */
export function decayCoeff(ms: number, sr: number): number {
  const samples = Math.max(1, (clamp(ms, 1, 10000) / 1000) * sr);
  return Math.exp(-6.907755278982137 / samples);
}

/** Reflect-fold into [−1, 1] (period-4 triangle law — the oversampler's rated
 *  wavefold shape, mirrored from kickdrum's HARD drive). */
function reflectFold(x: number): number {
  let y = (x + 1) % 4;
  if (y < 0) y += 4;
  return y < 2 ? y - 1 : 3 - y;
}

// ─────────────────────────────────────────────────────────────────────────
// Frequency law (pure — unit-tested directly)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Head mode `k` frequency (Hz): `tune` (90..400) transposed 1 V/oct by pitchCv
 * and by the latched per-hand `tuneMul`, times the Bessel ratio, times a
 * downward pitch-DROP that starts `pitchAmt` semitones high and settles as
 * `headPitchEnv` decays 1 → 0 (the snare "pit").
 */
export function snareHeadFreqHz(
  tune: number,
  pitchCv: number,
  headPitchEnv: number,
  pitchAmtSt: number,
  tuneMul: number,
  k: number,
): number {
  const base = clamp(tune, 90, 400) * Math.pow(2, pitchCv) * tuneMul;
  const dropMul = Math.pow(2, (clamp(pitchAmtSt, 0, 12) / 12) * clamp(headPitchEnv, 0, 1));
  return base * MODE_RATIO[k]! * dropMul;
}

// ─────────────────────────────────────────────────────────────────────────
// Voice state (per pool voice — carries ONLY the overlapping onset layers)
// ─────────────────────────────────────────────────────────────────────────

export interface SnareVoice {
  idx: number; // fixed pool index (varies the deterministic noise seed)
  active: boolean;
  energy: number; // running |out| follower (the lowest-energy steal metric)
  // HEAD: NHEAD self-ringing Chamberlin resonators.
  modeBand: Float32Array;
  modeLow: Float32Array;
  headAmp: number; // modal head amp env (1 → 0, headDecay)
  headPitchEnv: number; // downward pitch-drop env (pitchTime)
  // BODY: band-passed seeded noise.
  bodyRng: number;
  bodyLow: number;
  bodyBand: number;
  bodyAmp: number;
  // CRACK: short band-passed seeded noise transient.
  crackRng: number;
  crackLow: number;
  crackBand: number;
  crackEnv: number;
  // Latched per-strike values.
  vel: number;
  tuneMul: number;
  pan: number; // -1..1 hand pan
  // The head displacement this sample (the wire-bed contact drive).
  headOut: number;
}

function makeSnareVoice(idx: number): SnareVoice {
  return {
    idx,
    active: false,
    energy: 0,
    modeBand: new Float32Array(NHEAD),
    modeLow: new Float32Array(NHEAD),
    headAmp: 0,
    headPitchEnv: 0,
    bodyRng: NOISE_SEED_BASE,
    bodyLow: 0,
    bodyBand: 0,
    bodyAmp: 0,
    crackRng: NOISE_SEED_BASE ^ 0x55aa55aa,
    crackLow: 0,
    crackBand: 0,
    crackEnv: 0,
    vel: 0,
    tuneMul: 1,
    pan: 0,
    headOut: 0,
  };
}

/** Strike a voice: reset filters, fire envelopes, latch per-hit values, inject
 *  the modal impulse, reseed the deterministic noise. The seed is
 *  `base ^ voiceIdx` (NO strike counter) so re-striking the SAME pool index is
 *  bit-identical (hit N == hit 1) while overlapping voices differ. */
export function strikeVoice(
  v: SnareVoice,
  vel: number,
  tuneMul: number,
  pan: number,
  seedBase: number,
): void {
  v.active = true;
  v.headAmp = 1;
  v.bodyAmp = 1;
  v.crackEnv = 1;
  v.headPitchEnv = 1;
  v.vel = clamp(vel, 0, 1);
  v.tuneMul = tuneMul;
  v.pan = clamp(pan, -1, 1);
  v.energy = 0;
  for (let k = 0; k < NHEAD; k++) {
    v.modeBand[k] = INIT_EXCITE[k]!;
    v.modeLow[k] = 0;
  }
  v.bodyRng = (seedBase ^ (v.idx * 0x9e37)) >>> 0 || 1;
  v.crackRng = (v.bodyRng ^ 0x55aa55aa) >>> 0 || 1;
  v.bodyLow = 0;
  v.bodyBand = 0;
  v.crackLow = 0;
  v.crackBand = 0;
}

// ─────────────────────────────────────────────────────────────────────────
// Per-sample voice step — HEAD + BODY + CRACK (a cheap generator)
// ─────────────────────────────────────────────────────────────────────────

/** Chamberlin SVF `f` coefficient for a center freq, clamped for stability. */
function svfF(fc: number, sr: number): number {
  return 2 * Math.sin((Math.PI * Math.min(fc, SVF_FC_FRAC * sr)) / sr);
}

/** One mono sample of a voice. Runs ONLY while active; also refreshes
 *  `v.headOut` (the wire-bed contact drive) and the energy follower. */
export function snareVoiceStep(v: SnareVoice, p: SnaredrumParams, sr: number): number {
  const damp = clamp(p.damp, 0, 1);
  const damping = clamp(p.damping, 0, 1);

  // ── HEAD: self-ringing modal bank (freq tracks the live pitch DROP). ──
  let headSum = 0;
  const qBase = 0.05 + damping * 0.45;
  for (let k = 0; k < NHEAD; k++) {
    const fc = snareHeadFreqHz(p.tune, p.pitchCv, v.headPitchEnv, p.pitchAmt, v.tuneMul, k);
    const f = svfF(fc, sr);
    // Stability: the two-integrator SVF needs 2q + f < 2 → clamp q < 0.4(2−f).
    const q = Math.min(qBase * MODE_Q_MULT[k]!, 0.4 * (2 - f));
    const band = v.modeBand[k]!;
    const low = v.modeLow[k]!;
    const hp = -low - q * band; // input = 0 → self-excited ringing
    let nb = band + f * hp;
    let nl = low + f * nb;
    if (Math.abs(nb) < FLUSH) nb = 0;
    if (Math.abs(nl) < FLUSH) nl = 0;
    v.modeBand[k] = nb;
    v.modeLow[k] = nl;
    headSum += nb * MODE_GAIN[k]!;
  }
  const head = headSum * v.headAmp;

  // ── BODY: band-passed seeded noise around the head fundamental. ──
  v.bodyRng = xorshift32(v.bodyRng);
  const bnz = (v.bodyRng / 0xffffffff) * 2 - 1;
  const bodyFc = clamp(p.tune, 90, 400) * Math.pow(2, p.pitchCv) * v.tuneMul;
  const fb = svfF(bodyFc, sr);
  const qb = 0.4;
  const bhp = bnz - v.bodyLow - qb * v.bodyBand;
  v.bodyBand += fb * bhp;
  v.bodyLow += fb * v.bodyBand;
  if (Math.abs(v.bodyBand) < FLUSH) v.bodyBand = 0;
  if (Math.abs(v.bodyLow) < FLUSH) v.bodyLow = 0;
  const body = v.bodyBand * v.bodyAmp;

  // ── CRACK: short band-passed seeded noise transient. ──
  v.crackRng = xorshift32(v.crackRng);
  const cnz = (v.crackRng / 0xffffffff) * 2 - 1;
  const fck = svfF(clamp(p.crackTone, 800, 7000), sr);
  const qc = 0.5;
  const chp = cnz - v.crackLow - qc * v.crackBand;
  v.crackBand += fck * chp;
  v.crackLow += fck * v.crackBand;
  if (Math.abs(v.crackBand) < FLUSH) v.crackBand = 0;
  if (Math.abs(v.crackLow) < FLUSH) v.crackLow = 0;
  const crack = v.crackBand * v.crackEnv;

  // ── envelopes (sr-calibrated; global `damp` shortens them together). ──
  v.headAmp *= decayCoeff(clamp(p.headDecay, 30, 600) * (1 - 0.6 * damp), sr);
  v.bodyAmp *= decayCoeff(clamp(p.bodyDecay, 20, 300) * (1 - 0.6 * damp), sr);
  v.crackEnv *= decayCoeff(CRACK_LEN_MS, sr);
  v.headPitchEnv *= decayCoeff(clamp(p.pitchTime, 3, 80), sr);
  if (v.headAmp < FLUSH) v.headAmp = 0;
  if (v.bodyAmp < FLUSH) v.bodyAmp = 0;
  if (v.crackEnv < FLUSH) v.crackEnv = 0;
  if (v.headPitchEnv < FLUSH) v.headPitchEnv = 0;

  // ── tone crossfade + velocity. ──
  const toneMix = clamp(p.tone, 0, 1);
  const headV = head * VOICE_NORM * v.vel;
  const out = (head * toneMix + body * (1 - toneMix) + crack * clamp(p.crack, 0, 1)) * VOICE_NORM * v.vel;
  v.headOut = headV;
  v.energy += (Math.abs(out) - v.energy) * ENERGY_COEF;
  if (v.energy < FLUSH) v.energy = 0;
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// Top-level state (voice pool + roll engine + shared bed + shared bus)
// ─────────────────────────────────────────────────────────────────────────

export interface SnaredrumState {
  voices: SnareVoice[];
  roll: RollState;
  // Shared re-excitable wire-buzz bed (design §3.5).
  bedEnv: number;
  wireRng: number;
  wireRng2: number;
  wireHpL: Biquad;
  wireHpR: Biquad;
  // Shared bus.
  dc: DcBlockState;
  os2: Oversampler;
  os4: Oversampler;
  driveAmt: number;
  driveFold: number;
  softFn: (x: number) => number;
  hardFn: (x: number) => number;
  // Trigger edge.
  trigPrev: number;
}

export function makeSnaredrumState(): SnaredrumState {
  const s: SnaredrumState = {
    voices: Array.from({ length: MAX_VOICES }, (_, i) => makeSnareVoice(i)),
    roll: makeRollState(),
    bedEnv: 0,
    wireRng: 0x6d2b79f5,
    wireRng2: (0x6d2b79f5 ^ 0x55aa55aa) >>> 0,
    wireHpL: makeBiquad(),
    wireHpR: makeBiquad(),
    dc: makeDcBlockState(),
    os2: createOversampler(2),
    os4: createOversampler(4),
    driveAmt: 0,
    driveFold: 0,
    softFn: (x) => x,
    hardFn: (x) => x,
    trigPrev: 0,
  };
  // CLEAN (hard=0): tanh soft-clip @2× — warm sizzle. Pre-gain 1..4.
  s.softFn = (x) => Math.tanh((1 + 3 * s.driveAmt) * x);
  // HARD (hard=1): wavefold + bounded asym @4× — the aggressive/gated snare.
  s.hardFn = (x) => {
    const pre = (1 + 4.5 * s.driveAmt) * (1 + 0.5 * s.driveFold);
    const fld = reflectFold(pre * x);
    return Math.tanh(1.2 * fld + 0.25 * fld * fld);
  };
  return s;
}

const ROLL_P: RollParams = { rollSpeed: 0, rollSpeedCv: 0, bounce: 0, humanize: 0, spread: 0 };

/** Re-excite the shared wire bed on EVERY strike (additive, clamped). */
function exciteBed(s: SnaredrumState, wireAmt: number, vel: number): void {
  s.bedEnv = Math.min(1, s.bedEnv + wireAmt * vel);
}

/**
 * One STEREO sample. Runs the trigger strike + the two-hand roll engine (each
 * fired sub-stroke allocates a pool voice via the lowest-energy allocator and
 * re-excites the shared bed), sums the panned pool with power-normalization,
 * adds the shared wire bed (mono + decorrelated side), and applies the shared
 * drive/DC/level/ceiling bus. `width=0 && spread=0 → out[0] == out[1]` exactly.
 * Writes out[0]=L, out[1]=R.
 */
export function snaredrumStepStereo(
  trigger: number,
  gate: number,
  accent: number,
  p: SnaredrumParams,
  sr: number,
  s: SnaredrumState,
  out: Float32Array,
): void {
  const wireAmt = clamp(p.wire, 0, 1);
  const acc = clamp(accent, 0, 1);

  // ── 1. TRIGGER: one hit per rising edge (always allocates; centered). ──
  const high = trigger >= 0.5;
  const prevHigh = s.trigPrev >= 0.5;
  s.trigPrev = trigger;
  if (high && !prevHigh) {
    const vel = clamp(1 * (1 + ACCENT_VEL * acc), 0, 1);
    const idx = allocateVoice(s.voices, MAX_VOICES);
    strikeVoice(s.voices[idx]!, vel, 1, 0, NOISE_SEED_BASE);
    exciteBed(s, wireAmt, vel);
  }

  // ── 2. ROLL: the two-hand engine drives strikes + bed re-excitation. ──
  ROLL_P.rollSpeed = p.rollSpeed;
  ROLL_P.rollSpeedCv = p.rollSpeedCv;
  ROLL_P.bounce = p.bounce;
  ROLL_P.humanize = p.humanize;
  ROLL_P.spread = p.spread;
  const fired = rollStep(s.roll, gate, ROLL_P, sr);
  for (let f = 0; f < fired; f++) {
    const vel = clamp(s.roll.firedVel[f]! * (1 + ACCENT_VEL * acc), 0, 1);
    exciteBed(s, wireAmt, vel); // ALWAYS re-excite the bed (continuity)
    if (s.roll.firedAlloc[f]) {
      const idx = allocateVoice(s.voices, MAX_VOICES);
      strikeVoice(s.voices[idx]!, vel, s.roll.firedDetune[f]!, s.roll.firedPan[f]!, NOISE_SEED_BASE);
    }
  }

  // ── 3. sum the panned pool (constant-power) with power-normalization. ──
  let poolMid = 0;
  let poolSide = 0;
  let headDisplSum = 0;
  let nact = 0;
  for (let i = 0; i < MAX_VOICES; i++) {
    const v = s.voices[i]!;
    if (!v.active) continue;
    const o = snareVoiceStep(v, p, sr);
    // Constant-power pan expressed so pan=0 gives a side gain of EXACTLY 0
    // (a cos/sin pair differs by 1 ULP at π/4, which would leak a ~1e-16 L≠R;
    // midGain²+sideGain² = 2, so power is preserved). Right pan → negative
    // side so out[1] (=mid−side) is the louder channel.
    const midGain = Math.SQRT2 * Math.cos((v.pan * Math.PI) / 4);
    const sideGain = -Math.SQRT2 * Math.sin((v.pan * Math.PI) / 4);
    poolMid += o * midGain * 0.5;
    poolSide += o * sideGain * 0.5;
    headDisplSum += v.headOut;
    nact++;
    if (v.headAmp < EPS_ACTIVE && v.bodyAmp < EPS_ACTIVE && v.crackEnv < EPS_ACTIVE) {
      v.active = false;
    }
  }
  const norm = 1 / Math.sqrt(Math.max(1, nact));
  let mid = poolMid * norm;
  const sidePool = poolSide * norm;

  // ── 4. shared wire bed: decorrelated HP'd noise, gain = wire·(bed + contact).
  // The rectifier only SCALES zero-mean noise → adds no output DC. ──
  s.wireRng = xorshift32(s.wireRng);
  const nzL = (s.wireRng / 0xffffffff) * 2 - 1;
  s.wireRng2 = xorshift32(s.wireRng2);
  const nzR = (s.wireRng2 / 0xffffffff) * 2 - 1;
  const contact = Math.max(0, Math.abs(headDisplSum) * CONTACT_K - CONTACT_THRESH);
  const wireGain = wireAmt * (s.bedEnv + contact);
  updateHighpass(s.wireHpL, clamp(p.wireTone, 1500, 9000), sr);
  updateHighpass(s.wireHpR, clamp(p.wireTone, 1500, 9000), sr);
  const wireL = biquadStep(s.wireHpL, nzL * wireGain);
  const wireR = biquadStep(s.wireHpR, nzR * wireGain);
  s.bedEnv *= decayCoeff(clamp(p.wireDecay, 40, 700) * (1 - 0.6 * clamp(p.damp, 0, 1)), sr);
  if (s.bedEnv < FLUSH) s.bedEnv = 0;

  // wire MID (mono-safe: added equally to both channels) + wire SIDE (× width).
  mid += 0.5 * (wireL + wireR);
  const side = sidePool + 0.5 * (wireL - wireR) * clamp(p.width, 0, 1);

  // ── 5. shared bus: oversampled drive (gated behind drive>0) → DC block →
  // level → per-channel true-peak ceiling. ──
  let driven = mid;
  const driveAmt = clamp(p.drive, 0, 1);
  if (driveAmt > 0.001) {
    s.driveAmt = driveAmt;
    s.driveFold = clamp(Math.abs(headDisplSum) * 0.5 + s.bedEnv * 0.5, 0, 1);
    driven = p.hard >= 0.5 ? s.os4.process(mid, s.hardFn) : s.os2.process(mid, s.softFn);
  }
  const clean = dcBlockStep(driven, s.dc, 20, sr);
  const lin = Math.pow(10, clamp(p.level, -24, 12) / 20);
  const g = 1 + 2 * clamp(p.ceiling, 0, 1);
  const m = clean * lin;
  const sd = side * lin;
  out[0] = Math.tanh(g * (m + sd));
  out[1] = Math.tanh(g * (m - sd));
}
