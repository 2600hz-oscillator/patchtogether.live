// packages/dsp/src/lib/snare-roll-dsp.ts
//
// SNARE DRUM — the POLYPHONIC two-hand DRUMROLL engine + the fixed-ring
// lowest-energy voice allocator (design .myrobots/snare-drum-module-design.md
// §3). Pure, deterministic, allocation-free in the hot path; the unit-tested
// correctness gate for the roll. It emits STROKE EVENTS (velocity, hand, pan,
// per-hand detune, and an alloc-vs-bed-only flag) that snaredrum-dsp.ts
// consumes to strike pool voices and re-excite the shared wire-buzz bed.
//
// WHY POLYPHONIC (mechanistic truth, not a fast retrigger). A snare stroke's
// membrane+wire tail lasts ~50–150 ms. At any real roll rate the inter-stroke
// interval is far shorter than that tail (two hands × ~10 Hz ≈ a stroke every
// ~50 ms; buzz sub-strokes are single-digit ms apart), so stroke N+1, N+2 …
// all fire WHILE stroke N still rings. Continuous roll sound is the physical
// SUPERPOSITION of overlapping decaying tails — retriggering ONE mono voice
// truncates the previous tail (amplitude notches + a pulsed "brap-brap"). So
// each stroke allocates its own voice from a pool (same reason KEYS/POLY need
// an allocator), and continuity is committed to a SHARED re-excitable bed.
//
// TWO-HAND SCHEDULER. Two phase accumulators advance at handRate/sr; the right
// hand starts +0.5 (180°) so it strikes in the temporal GAP left by the left —
// this interleave doubles the composite stroke rate and keeps the snare
// re-excited before the previous excitation decays. Micro-asymmetries (seeded,
// deterministic): timing jitter, per-hand velocity, and a small per-hand
// membrane detune create sizzle + a genuine stereo image.
//
// Every time constant derives from the LIVE sr (no 48000 literals); the roll
// PRNG is a seeded xorshift reseeded on the gate rising edge so a roll is
// repeatable relative to the gate epoch. No Math.random / Date.now anywhere.

import { clamp } from './chowkick-dsp';

// GATE high threshold — the shared semantic ($lib/audio/gate-trigger GATE_HI).
// Inlined (a lib/ DSP helper can't import from $lib), kept === 0.5.
export const GATE_HI = 0.5;

// ─────────────────────────────────────────────────────────────────────────
// Constants (FROZEN — the roll's tuning surface)
// ─────────────────────────────────────────────────────────────────────────

/** Voice pool size (design §3.7; verdict 8–12). Continuity lives in the shared
 *  bed, so this only bounds simultaneous TONAL-onset overlap. */
export const MAX_VOICES = 10;

/** Hard cap on NEW-voice allocations per second (design §3.8). Excess bounce
 *  density under a dense buzz routes to bed re-excitation ONLY — perceptually
 *  correct (individual pitched onsets are unresolvable past ~20–30/s) AND it
 *  bounds the voice-flop budget. */
export const ALLOC_RATE_CAP = 70;

/** Max sub-strokes per primary stroke (design §3.3, correction C). */
export const MAX_SUBSTROKES = 6;

/** Floor on inter-bounce spacing (design §3.8) — a buzz's geometric spacing
 *  τ·gᵏ can't collapse below this, so it never schedules near-per-sample. */
export const FLOOR_BOUNCE_S = 0.004;

/** Preallocated stroke-schedule ring size (per engine, both hands). Comfortably
 *  above 2 hands × MAX_SUBSTROKES plus cross-hand overlap. */
export const SCHED_SLOTS = 48;

/** Deterministic roll PRNG seed, reseeded on every gate rising edge. */
const ROLL_SEED = 0x1a2b3c4d;

/** Nominal per-hand rate span for the rate→bounce-count mapping (Hz). */
const HANDHZ_LO = 4;
const HANDHZ_HI = 24;

/** Rebound-interval fraction: τ = REBOUND_FRAC / handHz (seconds) — the first
 *  rebound spacing, TIGHTENING as handRate rises (design §3.3). */
const REBOUND_FRAC = 0.18;
/** Geometric spacing-shrink per bounce (coefficient-of-restitution law). */
const GSPACE = 0.7;

/** Humanize depths (scaled by the `humanize` param 0..1). */
const TIMING_JITTER = 0.08; // ±0.08·period on each sub-stroke countdown
const VEL_JITTER = 0.15; // ±15 % per-sub-stroke velocity
const DETUNE_ST = 1.5; // ± semitones of humanize detune (× spread)

// ─────────────────────────────────────────────────────────────────────────
// Seeded xorshift32 (deterministic humanize jitter)
// ─────────────────────────────────────────────────────────────────────────

export function xorshift32(s: number): number {
  s ^= s << 13;
  s ^= s >>> 17;
  s ^= s << 5;
  return s >>> 0;
}

// ─────────────────────────────────────────────────────────────────────────
// Rate mapping (knob + CV) — FROZEN (design §3.4)
// ─────────────────────────────────────────────────────────────────────────

/** Per-hand roll rate in Hz. roll_speed 0 → 4 Hz, 1 → 24 Hz (exp); roll_speed_cv
 *  is a 1 V/oct multiply (±4 V); composite two-hand sticking ≈ 2× this. */
export function rollHandHz(rollSpeed: number, cv: number): number {
  const hz = HANDHZ_LO * Math.pow(6, clamp(rollSpeed, 0, 1)) * Math.pow(2, clamp(cv, -4, 4));
  return clamp(hz, 1, 40);
}

/** Min samples between NEW-voice allocations (the §3.8 budget). */
export function minAllocIntervalSamples(sr: number): number {
  return Math.max(1, Math.round(sr / ALLOC_RATE_CAP));
}

// ─────────────────────────────────────────────────────────────────────────
// Bounce / stroke structure (design §3.3) — PURE, unit-tested directly
// ─────────────────────────────────────────────────────────────────────────

/**
 * Fill the sub-stroke schedule for ONE primary stroke into caller-provided
 * scratch arrays (no allocation). `outOff` = sample offsets from the primary
 * onset, `outVel` = velocities. Returns the sub-stroke count N (1..MAX_SUBSTROKES).
 *
 * `bounce` (0..1) morphs the roll TYPE:
 *  - ≈0  SINGLE: 1 sub-stroke {0, 1.0} — machine-gun/granular.
 *  - ≈0.2 DOUBLE/open: 2 sub-strokes {0, 1.0}, {τ, ~0.5}; τ TIGHTENS as rate rises.
 *  - →1  BUZZ/press: N≤6 sub-strokes at t=0,τ,τ+τ·g,… with geometric a·rᵏ velocity
 *        and SHRINKING (FLOOR_BOUNCE_S-floored) spacing; N GROWS as handRate falls.
 */
export function bounceSchedule(
  bounce: number,
  handHz: number,
  sr: number,
  outOff: Float32Array | number[],
  outVel: Float32Array | number[],
): number {
  const b = clamp(bounce, 0, 1);
  if (b < 0.05) {
    outOff[0] = 0;
    outVel[0] = 1;
    return 1;
  }
  const maxB = Math.min(MAX_SUBSTROKES, Math.round(1 + b * 5));
  // rateFactor: 1 at the slow end (4 Hz), 0 at the fast end (24 Hz) — slower
  // hands need MORE rebounds to fill the wider gap (research-confirmed §3.3).
  const rateFactor = clamp((HANDHZ_HI - handHz) / (HANDHZ_HI - HANDHZ_LO), 0, 1);
  const N = clamp(Math.round(2 + (maxB - 2) * rateFactor), 2, maxB);
  // Velocity restitution: double ≈ 0.55, buzz ≈ 0.75 (geometric decay).
  const r = 0.5 + 0.25 * b;
  // Rebound interval (seconds), floored; tightens as handHz rises (τ ∝ 1/handHz).
  const tau = clamp(REBOUND_FRAC / handHz, FLOOR_BOUNCE_S, 0.12);
  outOff[0] = 0;
  outVel[0] = 1;
  let tSec = 0;
  let gap = tau;
  for (let k = 1; k < N; k++) {
    const g = Math.max(gap, FLOOR_BOUNCE_S);
    tSec += g;
    outOff[k] = Math.round(tSec * sr);
    outVel[k] = Math.pow(r, k);
    gap *= GSPACE;
  }
  return N;
}

// ─────────────────────────────────────────────────────────────────────────
// Voice-pool allocator (design §3.7) — first-free, else steal LOWEST energy
// ─────────────────────────────────────────────────────────────────────────

/** The minimum a pool voice must expose to be allocated. SnareVoice satisfies
 *  this structurally, keeping the allocator free of the voice DSP. */
export interface AllocSlot {
  active: boolean;
  /** Running |output| estimate (a one-pole follower) — the steal metric. */
  energy: number;
}

/**
 * Pick a voice index to (re)strike: the first INACTIVE voice, else — all busy —
 * the LEAST-AUDIBLE (lowest-energy) voice. Drum voices self-terminate (no
 * note-off), so stealing by energy (not recency) truncates the quietest tail.
 * Never returns out of range; the pool structurally never exceeds `maxVoices`.
 */
export function allocateVoice(voices: readonly AllocSlot[], maxVoices: number): number {
  const n = Math.min(maxVoices, voices.length);
  for (let i = 0; i < n; i++) {
    if (!voices[i]!.active) return i;
  }
  let steal = 0;
  for (let i = 1; i < n; i++) {
    if (voices[i]!.energy < voices[steal]!.energy) steal = i;
  }
  return steal;
}

// ─────────────────────────────────────────────────────────────────────────
// The two-hand roll engine state + step
// ─────────────────────────────────────────────────────────────────────────

/** Continuous roll params the engine reads (subset of the module params). */
export interface RollParams {
  rollSpeed: number; // 0..1
  rollSpeedCv: number; // 1 V/oct multiply
  bounce: number; // 0..1 roll type
  humanize: number; // 0..1 seeded jitter depth
  spread: number; // 0..1 two-hand pan + per-hand detune
}

export interface RollState {
  handPhaseL: number;
  handPhaseR: number;
  rng: number;
  gatePrev: number;
  samplesSinceAlloc: number;
  // Preallocated stroke-schedule ring (sample countdowns; <0 = free slot).
  schedCountdown: Float32Array;
  schedVel: Float32Array;
  schedHand: Int8Array; // 0 = L, 1 = R
  schedDetune: Float32Array; // per-stroke tune multiplier (latched at schedule)
  schedPan: Float32Array; // -1..1
  // Per-schedule scratch (bounceSchedule output; no per-call allocation).
  offScratch: Float32Array;
  velScratch: Float32Array;
  // FIRED-this-sample output (read by the consumer).
  firedCount: number;
  firedVel: Float32Array;
  firedHand: Int8Array;
  firedDetune: Float32Array;
  firedPan: Float32Array;
  firedAlloc: Int8Array; // 1 = allocate a tonal voice; 0 = bed re-excite only
}

export function makeRollState(): RollState {
  return {
    handPhaseL: 0,
    handPhaseR: 0.5,
    rng: ROLL_SEED,
    gatePrev: 0,
    samplesSinceAlloc: 1 << 20,
    schedCountdown: new Float32Array(SCHED_SLOTS).fill(-1),
    schedVel: new Float32Array(SCHED_SLOTS),
    schedHand: new Int8Array(SCHED_SLOTS),
    schedDetune: new Float32Array(SCHED_SLOTS).fill(1),
    schedPan: new Float32Array(SCHED_SLOTS),
    offScratch: new Float32Array(MAX_SUBSTROKES),
    velScratch: new Float32Array(MAX_SUBSTROKES),
    firedCount: 0,
    firedVel: new Float32Array(SCHED_SLOTS),
    firedHand: new Int8Array(SCHED_SLOTS),
    firedDetune: new Float32Array(SCHED_SLOTS),
    firedPan: new Float32Array(SCHED_SLOTS),
    firedAlloc: new Int8Array(SCHED_SLOTS),
  };
}

/** Next bipolar [-1, 1) draw, advancing the seeded PRNG in place. */
function nextBipolar(rs: RollState): number {
  rs.rng = xorshift32(rs.rng);
  return (rs.rng / 0xffffffff) * 2 - 1;
}

/** Clear every pending sub-stroke (gate rising-edge reset). */
function clearSchedule(rs: RollState): void {
  rs.schedCountdown.fill(-1);
}

/** Queue one primary stroke's sub-strokes into the ring. ALWAYS draws a fixed
 *  3·N PRNG values (scaled by humanize) so the schedule is bit-reproducible for
 *  a given gate epoch regardless of the humanize amount. */
function scheduleStroke(rs: RollState, hand: 0 | 1, p: RollParams, sr: number): void {
  const handHz = rollHandHz(p.rollSpeed, p.rollSpeedCv);
  const N = bounceSchedule(p.bounce, handHz, sr, rs.offScratch, rs.velScratch);
  const spread = clamp(p.spread, 0, 1);
  const humanize = clamp(p.humanize, 0, 1);
  const handSign = hand === 1 ? 1 : -1;
  const periodSamples = sr / handHz;
  const pan = handSign * spread;
  for (let k = 0; k < N; k++) {
    // Always draw (constant count) → scale by humanize.
    const jT = nextBipolar(rs) * humanize * TIMING_JITTER * periodSamples;
    const jV = nextBipolar(rs) * humanize * VEL_JITTER;
    const jD = nextBipolar(rs) * humanize * DETUNE_ST * spread;
    let off = rs.offScratch[k]! + Math.round(jT);
    if (off < 0) off = 0;
    const vel = clamp(rs.velScratch[k]! * (1 + jV), 0, 1);
    const detuneSt = handSign * spread * 0.75 + jD;
    const detuneMul = Math.pow(2, detuneSt / 12);
    // Insert into the first free ring slot.
    for (let i = 0; i < SCHED_SLOTS; i++) {
      if (rs.schedCountdown[i]! < 0) {
        rs.schedCountdown[i] = off;
        rs.schedVel[i] = vel;
        rs.schedHand[i] = hand;
        rs.schedDetune[i] = detuneMul;
        rs.schedPan[i] = pan;
        break;
      }
    }
  }
}

/**
 * Advance the roll one sample. Reads the gate level, runs the two-hand
 * scheduler while high, fires due sub-strokes into `rs.fired*` (read by the
 * consumer this same sample), and returns the fired count.
 *
 * Gate edges (design §3.9): RISING resets BOTH hand phases (L=0, R=0.5) + the
 * PRNG seed and fires an immediate L stroke (no initial gap); FALLING stops
 * scheduling (in-flight sub-strokes + the shared bed ring out naturally).
 */
export function rollStep(rs: RollState, gate: number, p: RollParams, sr: number): number {
  rs.firedCount = 0;
  const high = gate >= GATE_HI;
  const prevHigh = rs.gatePrev >= GATE_HI;
  rs.gatePrev = gate;

  if (high && !prevHigh) {
    rs.handPhaseL = 0;
    rs.handPhaseR = 0.5;
    rs.rng = ROLL_SEED;
    rs.samplesSinceAlloc = 1 << 20; // first stroke always allocates
    clearSchedule(rs);
    scheduleStroke(rs, 0, p, sr); // immediate onset — the roll starts NOW
  }

  if (high) {
    const inc = rollHandHz(p.rollSpeed, p.rollSpeedCv) / sr;
    rs.handPhaseL += inc;
    if (rs.handPhaseL >= 1) {
      rs.handPhaseL -= 1;
      scheduleStroke(rs, 0, p, sr);
    }
    rs.handPhaseR += inc;
    if (rs.handPhaseR >= 1) {
      rs.handPhaseR -= 1;
      scheduleStroke(rs, 1, p, sr);
    }
  }

  rs.samplesSinceAlloc++;
  const minI = minAllocIntervalSamples(sr);

  for (let i = 0; i < SCHED_SLOTS; i++) {
    if (rs.schedCountdown[i]! < 0) continue;
    rs.schedCountdown[i] = rs.schedCountdown[i]! - 1;
    if (rs.schedCountdown[i]! <= 0) {
      // §3.8 budget: allocate a tonal voice only if the rate cap allows; else
      // route this sub-stroke into shared-bed re-excitation ONLY.
      let alloc: 0 | 1 = 0;
      if (rs.samplesSinceAlloc >= minI) {
        alloc = 1;
        rs.samplesSinceAlloc = 0;
      }
      const f = rs.firedCount++;
      rs.firedVel[f] = rs.schedVel[i]!;
      rs.firedHand[f] = rs.schedHand[i]!;
      rs.firedDetune[f] = rs.schedDetune[i]!;
      rs.firedPan[f] = rs.schedPan[i]!;
      rs.firedAlloc[f] = alloc;
      rs.schedCountdown[i] = -1; // free the slot
    }
  }
  return rs.firedCount;
}
