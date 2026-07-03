// art/setup/drivers.ts
//
// Canonical DETERMINISTIC drivers for ART audio-profile scenarios (spec
// §4.2/§4.3 — .myrobots/plans/art-backfill-audio-profiles-2026-07-01.md).
// One driver per module category, so every profile is driven the same way:
//
//   source (self-driving)   → none (params only; seeded PRNG where RNG-based)
//   FX / processor          → vcoTestSignal() (C4 saw/sine) or seededNoise()
//   envelope / modulator    → heldGate() / gateTrain() (held-square gate)
//   clocked step source     → clockTrain() (240 BPM per DETERMINISM.md)
//
// The gate/trigger waveform constants come from the SHARED semantic model
// ($lib/audio/gate-trigger) — never re-derive GATE_HI / TRIGGER_PULSE_S.
// Every driver is a pure function of its arguments (fixed phase 0 / epoch 0 /
// explicit PRNG seed), so two renders are bit-identical by construction.

import { GATE_HI, TRIGGER_PULSE_S } from '$lib/audio/gate-trigger';
import { SAMPLE_RATE } from './render';

export { GATE_HI, TRIGGER_PULSE_S };

/** C4 in Hz — the codebase's 1V/oct 0V reference (matches analog-vco). */
export const C4_HZ = 261.626;

/** Canonical clocked-source tempo (DETERMINISM.md "Sequencer BPM" row:
 *  240 BPM = ~63 ms per 16th, so a 1 s window sees ~16 pings). */
export const CLOCK_BPM = 240;

const n = (durationS: number, sr: number) => Math.round(sr * durationS);

// ---------------------------------------------------------------------------
// Gate / trigger / clock drivers
// ---------------------------------------------------------------------------

export interface HeldGateOptions {
  /** Total driver length in seconds. */
  totalS: number;
  /** Gate-high span [0, onS). Held-square GATE semantics (level > GATE_HI
   *  while active; consumers react to both edges). */
  onS: number;
  level?: number;
  sampleRate?: number;
}

/** One held-square gate: high for `onS` seconds from t=0, then low. The
 *  canonical envelope driver (attack→decay→sustain while high, release on
 *  the falling edge). */
export function heldGate(opts: HeldGateOptions): Float32Array {
  const sr = opts.sampleRate ?? SAMPLE_RATE;
  const buf = new Float32Array(n(opts.totalS, sr));
  const onN = Math.min(buf.length, n(opts.onS, sr));
  buf.fill(opts.level ?? 1, 0, onN);
  return buf;
}

export interface GateTrainOptions {
  totalS: number;
  /** Beats per minute — one gate per beat, starting at t=0 (epoch 0). */
  bpm: number;
  /** Gate-high length per beat in seconds (must be < beat period). */
  gateS: number;
  level?: number;
  sampleRate?: number;
}

/** Repeating held-square gates at `bpm` (first rising edge at sample 0). */
export function gateTrain(opts: GateTrainOptions): Float32Array {
  const sr = opts.sampleRate ?? SAMPLE_RATE;
  const buf = new Float32Array(n(opts.totalS, sr));
  const periodN = Math.max(1, Math.round((60 / opts.bpm) * sr));
  const gateN = Math.max(1, Math.min(periodN - 1, Math.round(opts.gateS * sr)));
  const level = opts.level ?? 1;
  for (let start = 0; start < buf.length; start += periodN) {
    buf.fill(level, start, Math.min(buf.length, start + gateN));
  }
  return buf;
}

/** Short TRIGGER pulses (flat-top, TRIGGER_PULSE_S wide) at `bpm` — the
 *  canonical strike/clock waveform (one clean GATE_HI crossing per pulse). */
export function triggerTrain(opts: { totalS: number; bpm: number; pulseS?: number; sampleRate?: number }): Float32Array {
  return gateTrain({
    totalS: opts.totalS,
    bpm: opts.bpm,
    gateS: opts.pulseS ?? TRIGGER_PULSE_S,
    sampleRate: opts.sampleRate,
  });
}

/** Fixed 240 BPM clock (DETERMINISM.md), epoch pinned to sample 0. */
export function clockTrain(totalS: number, sampleRate?: number): Float32Array {
  return triggerTrain({ totalS, bpm: CLOCK_BPM, sampleRate });
}

// ---------------------------------------------------------------------------
// Audio-input drivers (for FX / processor profiles)
// ---------------------------------------------------------------------------

export interface VcoTestSignalOptions {
  totalS: number;
  freqHz?: number;
  shape?: 'saw' | 'sine';
  amp?: number;
  sampleRate?: number;
}

/** Canonical VCO test signal for FX profiles: C4 saw (default) or sine,
 *  phase pinned to 0 at sample 0. Naive (non-bandlimited) shapes on purpose —
 *  the driver is a fixed, reproducible test stimulus, not a hi-fi source. */
export function vcoTestSignal(opts: VcoTestSignalOptions): Float32Array {
  const sr = opts.sampleRate ?? SAMPLE_RATE;
  const freq = opts.freqHz ?? C4_HZ;
  const amp = opts.amp ?? 0.5;
  const shape = opts.shape ?? 'saw';
  const buf = new Float32Array(n(opts.totalS, sr));
  let phase = 0;
  for (let i = 0; i < buf.length; i++) {
    buf[i] = amp * (shape === 'sine' ? Math.sin(2 * Math.PI * phase) : 2 * phase - 1);
    phase += freq / sr;
    phase -= Math.floor(phase);
  }
  return buf;
}

export interface ToneBurstOptions extends VcoTestSignalOptions {
  /** Burst length in seconds — the VCO tone spans [0, burstS), then silence
   *  out to totalS. */
  burstS: number;
}

/** A short vcoTestSignal burst at t = 0 followed by silence — the canonical
 *  TRANSIENT driver for FX with an echo/decay tail (the cofefve batch-2
 *  precedent: dry hit, then the ringing tail IS the profile). */
export function toneBurst(opts: ToneBurstOptions): Float32Array {
  const sr = opts.sampleRate ?? SAMPLE_RATE;
  const buf = new Float32Array(n(opts.totalS, sr));
  const burst = vcoTestSignal({ ...opts, totalS: Math.min(opts.burstS, opts.totalS) });
  buf.set(burst, 0);
  return buf;
}

/** Deterministic seed for profile noise drivers (also the chowkick worklet's
 *  default noise seed). DETERMINISM.md "Random seed (ART audio profiles)". */
export const PROFILE_NOISE_SEED = 0xc0ffee;

/** Seeded white noise in [-1, 1) via xorshift32 — bit-identical for a given
 *  seed. Use for noise-based sources/FX so profiles never touch Math.random. */
export function seededNoise(totalS: number, seed: number = PROFILE_NOISE_SEED, sampleRate?: number): Float32Array {
  const sr = sampleRate ?? SAMPLE_RATE;
  const buf = new Float32Array(n(totalS, sr));
  let x = seed >>> 0 || 1; // xorshift32 must not start at 0
  for (let i = 0; i < buf.length; i++) {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    buf[i] = x / 0x80000000 - 1;
  }
  return buf;
}
