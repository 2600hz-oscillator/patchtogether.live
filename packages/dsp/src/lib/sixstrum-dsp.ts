// packages/dsp/src/lib/sixstrum-dsp.ts
//
// SIX STRUM — the pure 6-voice guitar/bass/harp engine. SIX independent
// Extended-Karplus-Strong string voices (karplus-dsp.ts, one makeKarplusState
// + karplusStep per string, each seeded DISTINCTLY so a simultaneous barre
// doesn't comb), each behind its own amplitude ADSR (adsr-env.ts), summed to
// MONO through a small resonant BODY bank. No per-voice controls beyond the
// shared knobs — GUITAR / BASS / HARP are three knob states of the SAME engine
// (TUNING + REGISTER + RING + MATERIAL + …), never a DSP branch.
//
// Signal per string i:
//   pitch  ← Poly lane i (if a poly source is patched) · else the voiced Chord
//            root (Chord CV patched) · else the open-string tuning. + REGISTER
//            transpose + a tiny per-voice SPREAD detune.
//   pluck  ← Poly lane i gate rising edge (poly mode) · else STRUM input i
//            (normalled #1→all upstream), staggered by STRUM SPREAD / DIR.
//   mute   ← MUTE gate i → karplus `damp` (dead, dark, ~unpitched palm-mute)
//            PLUS an extra amplitude choke scaled by MUTE DEPTH.
//   amp    ← per-voice ADSR (fast attack, S=1 so the STRING'S ring is the
//            sustain; RELEASE bites on note-off / mute).
//
// Everything is a deterministic function of state + inputs (seeds fixed at
// construction; no Math.random / Date) so ART renders bit-identically.

import {
  KARPLUS_SEED,
  type KarplusParams,
  type KarplusState,
  makeKarplusState,
  karplusStep,
} from './karplus-dsp';
import { Envelope } from './adsr-env';
import {
  SIXSTRUM_STRINGS,
  voiceChord,
  openStrings,
  tuningForIndex,
  qualityForIndex,
} from './sixstrum-tuning';
import { clamp } from './dsp-utils';

export const SS_STRINGS = SIXSTRUM_STRINGS; // 6

/** karplus `tune` we pin every voice to; the note rides on pitchCv.
 *  220 Hz = A3 = MIDI 57, so pitchCv = (midi − 57) / 12. */
const SS_TUNE_HZ = 220;
const SS_REF_MIDI = 57;

/** Per-voice seed stride (golden-ratio odd constant) — distinct burst seeds so
 *  a simultaneous barre strike decorrelates instead of phase-combing. */
const SS_SEED_STRIDE = 0x9e3779b1;

/** SPREAD knob → per-voice detune, symmetric about 0 (cents at spread = 1). */
const SS_DETUNE_MAX_CENTS = 14;
const SS_DETUNE_PATTERN = [-1, -0.6, -0.25, 0.25, 0.6, 1]; // low→high strings

/** Max total strum time across the 6 strings (s) — STRUM SPREAD 0..1 maps here. */
export const SS_STRUM_SPREAD_MAX_S = 0.045;

/** Body resonance centres (Hz) + Q per tuning (guitar/bass/harp box). */
const SS_BODY: Record<string, { f: [number, number]; q: number }> = {
  guitar: { f: [100, 215], q: 3.2 },
  bass: { f: [58, 120], q: 3.0 },
  harp: { f: [175, 330], q: 2.6 },
};

const TWO_PI = Math.PI * 2;
const FLUSH = 1e-20;

// ─────────────────────────────────────────────────────────────────────────
// Params (numbers; the worklet feeds these from AudioParams each block)
// ─────────────────────────────────────────────────────────────────────────

export interface SixStrumParams {
  /** Global transpose, semitones (−24..+24). */
  register: number;
  /** String ring: decay to −60 dB, seconds (0.1..10). → karplus decay. */
  ring: number;
  /** Material / brightness 0..1. → karplus brightness. */
  material: number;
  /** Pick position 0.02..0.5. → karplus position. */
  pickPos: number;
  /** Stiffness / inharmonicity 0..1. → karplus stiffness. */
  stiffness: number;
  /** Pick tone (exciter brightness) 0..1. → karplus color. */
  pickTone: number;
  /** Pick grain (excitation length, periods) 0.1..4. → karplus burst. */
  pickGrain: number;
  /** ADSR attack, seconds. */
  attack: number;
  /** ADSR decay, seconds. */
  envDecay: number;
  /** ADSR sustain 0..1 (default 1 — the string ring is the real sustain). */
  sustain: number;
  /** ADSR release, seconds. */
  release: number;
  /** Extra amplitude mute depth 0..1 layered on the karplus damp. */
  muteDepth: number;
  /** Strum spread 0..1 (→ 0..SS_STRUM_SPREAD_MAX_S total across the strings). */
  strumSpread: number;
  /** Strum direction: 0 down (low→high) · 1 up · 2 alternate. */
  strumDir: number;
  /** SPREAD: per-voice detune + (fixed) seed decorrelation richness 0..1. */
  spread: number;
  /** Body resonance wet mix 0..1 (0 = dry/identity). */
  body: number;
  /** Output level, dB (−24..+12). */
  level: number;
  /** Tuning selector index (0 guitar / 1 bass / 2 harp). */
  tuning: number;
  /** Chord quality selector index (0..7). */
  quality: number;
  /** 1 when a poly source is patched (else strum/chord/open drive it). */
  polyConnected: number;
  /** 1 when the mono Chord CV input is patched. */
  chordConnected: number;
}

export const SIXSTRUM_DEFAULTS: SixStrumParams = {
  register: 0,
  ring: 2.5,
  material: 0.55,
  pickPos: 0.17,
  stiffness: 0.06,
  pickTone: 0.6,
  pickGrain: 1,
  attack: 0.003,
  envDecay: 0.12,
  sustain: 1,
  release: 0.35,
  muteDepth: 0.5,
  strumSpread: 0.28,
  strumDir: 0,
  spread: 0.25,
  body: 0.35,
  level: 0,
  tuning: 0,
  quality: 0,
  polyConnected: 0,
  chordConnected: 0,
};

/** Per-sample inputs. The worklet fills these each sample (6-wide arrays reused);
 *  `strum` is already normalled (#1→all) and `accent` already defaulted. */
export interface SixStrumFrame {
  strum: Float32Array; // 6 effective trigger levels
  mute: Float32Array; // 6 gate levels
  polyPitch: Float32Array; // 6 V/oct
  polyGate: Float32Array; // 6 gate levels
  accent: number; // 0..1
}

// ─────────────────────────────────────────────────────────────────────────
// Biquad (RBJ band-pass, DF-I) for the body bank
// ─────────────────────────────────────────────────────────────────────────

interface Biquad {
  b0: number; b1: number; b2: number; a1: number; a2: number;
  x1: number; x2: number; y1: number; y2: number;
}

function makeBiquad(): Biquad {
  return { b0: 0, b1: 0, b2: 0, a1: 0, a2: 0, x1: 0, x2: 0, y1: 0, y2: 0 };
}

/** RBJ constant-0dB-peak band-pass at f0/Q. */
function setBandpass(bq: Biquad, f0: number, q: number, sr: number): void {
  const w0 = (TWO_PI * Math.min(f0, 0.45 * sr)) / sr;
  const cw = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Math.max(0.1, q));
  const a0 = 1 + alpha;
  bq.b0 = alpha / a0;
  bq.b1 = 0;
  bq.b2 = -alpha / a0;
  bq.a1 = (-2 * cw) / a0;
  bq.a2 = (1 - alpha) / a0;
}

function biquad(bq: Biquad, x: number): number {
  let y = bq.b0 * x + bq.b1 * bq.x1 + bq.b2 * bq.x2 - bq.a1 * bq.y1 - bq.a2 * bq.y2;
  if (Math.abs(y) < FLUSH) y = 0;
  bq.x2 = bq.x1;
  bq.x1 = x;
  bq.y2 = bq.y1;
  bq.y1 = y;
  return y;
}

// ─────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────

interface BlockCache {
  /** karplus params shared by all voices this block (pitchCv set per voice). */
  kp: KarplusParams;
  /** Non-poly target MIDI per string (chord voicing or open tuning). */
  chordOrOpenMidi: number[];
  /** Total strum spread in samples across the strings (STRUM SPREAD → time). */
  strumSpreadSamples: number;
  /** Per-voice detune in V/oct (SPREAD). */
  detuneVOct: number[];
}

export interface SixStrumState {
  sr: number;
  voice: KarplusState[]; // 6
  env: Envelope[]; // 6
  /** karplus pitchCv held per voice (captured at each strike). */
  heldPitchCv: number[];
  prevStrum: Float32Array; // edge memory (strum mode)
  prevPolyGate: Float32Array; // edge memory (poly mode)
  prevMute: Float32Array; // edge memory (mute → env release)
  strikeCountdown: Int32Array; // -1 idle, else samples until the delayed strike
  muteEnv: Float32Array; // smoothed 0..1 mute follower per voice
  energy: Float32Array; // |out| follower per voice (active-count metric)
  altFlip: boolean; // STRUM DIR alternate: flips each strum event
  bodyA: Biquad;
  bodyB: Biquad;
  cache: BlockCache;
}

function seedForVoice(i: number): number {
  return (KARPLUS_SEED + Math.imul(i, SS_SEED_STRIDE)) >>> 0;
}

export function makeSixStrumState(sr: number): SixStrumState {
  const rate = sr > 0 ? sr : 48000;
  const voice: KarplusState[] = [];
  const env: Envelope[] = [];
  for (let i = 0; i < SS_STRINGS; i++) {
    voice.push(makeKarplusState(rate, seedForVoice(i)));
    env.push(new Envelope());
  }
  return {
    sr: rate,
    voice,
    env,
    heldPitchCv: new Array(SS_STRINGS).fill(0),
    prevStrum: new Float32Array(SS_STRINGS),
    prevPolyGate: new Float32Array(SS_STRINGS),
    prevMute: new Float32Array(SS_STRINGS),
    strikeCountdown: new Int32Array(SS_STRINGS).fill(-1),
    muteEnv: new Float32Array(SS_STRINGS),
    energy: new Float32Array(SS_STRINGS),
    altFlip: false,
    bodyA: makeBiquad(),
    bodyB: makeBiquad(),
    cache: {
      kp: { ...({} as KarplusParams) },
      chordOrOpenMidi: new Array(SS_STRINGS).fill(SS_REF_MIDI),
      strumSpreadSamples: 0,
      detuneVOct: new Array(SS_STRINGS).fill(0),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Per-block prep (cheap; recompute derived values from the k-rate params)
// ─────────────────────────────────────────────────────────────────────────

/** Recompute the per-block cache. `chordRootMidi` is the Chord CV root (only
 *  used when p.chordConnected); harmless otherwise. */
export function prepSixStrumBlock(
  p: SixStrumParams,
  chordRootMidi: number,
  sr: number,
  s: SixStrumState,
): void {
  const c = s.cache;
  const tuning = tuningForIndex(p.tuning);

  // Shared karplus params (pitchCv is set per voice in the step). LEVEL stays 0
  // — master level/normalisation happen on the mono sum.
  c.kp.tune = SS_TUNE_HZ;
  c.kp.decay = clamp(p.ring, 0.1, 10);
  c.kp.brightness = clamp(p.material, 0, 1);
  c.kp.position = clamp(p.pickPos, 0.02, 0.5);
  c.kp.stiffness = clamp(p.stiffness, 0, 1);
  c.kp.color = clamp(p.pickTone, 0, 1);
  c.kp.burst = clamp(p.pickGrain, 0.1, 4);
  c.kp.level = 0;
  c.kp.pitchCv = 0;

  // Non-poly per-string target: voiced chord, or the open strings.
  const target = p.chordConnected >= 0.5
    ? voiceChord(chordRootMidi, qualityForIndex(p.quality), tuning)
    : openStrings(tuning);
  for (let i = 0; i < SS_STRINGS; i++) c.chordOrOpenMidi[i] = target[i]!;

  // Strum stagger total (samples); per-string order/delay is resolved at the
  // strum edge in the step so STRUM DIR = alternate can flip per event.
  c.strumSpreadSamples = clamp(p.strumSpread, 0, 1) * SS_STRUM_SPREAD_MAX_S * sr;

  // Per-voice detune (SPREAD), symmetric so the chord stays centred.
  const cents = clamp(p.spread, 0, 1) * SS_DETUNE_MAX_CENTS;
  for (let i = 0; i < SS_STRINGS; i++) {
    c.detuneVOct[i] = (SS_DETUNE_PATTERN[i]! * cents) / 1200;
  }

  // Body bank coefficients follow the tuning's box.
  const body = SS_BODY[tuning] ?? SS_BODY.guitar!;
  setBandpass(s.bodyA, body.f[0], body.q, sr);
  setBandpass(s.bodyB, body.f[1], body.q, sr);
}

// ─────────────────────────────────────────────────────────────────────────
// Per-sample step
// ─────────────────────────────────────────────────────────────────────────

/** V/oct (0V = C4 = MIDI 60) → karplus pitchCv (relative to A3 = MIDI 57). */
function polyVOctToPitchCv(vOct: number): number {
  // midi = 60 + vOct*12; pitchCv = (midi − 57)/12 = vOct + 3/12.
  return vOct + 3 / 12;
}

function midiToPitchCv(midi: number): number {
  return (midi - SS_REF_MIDI) / 12;
}

/**
 * One sample of the whole instrument → the mono output sample.
 * Call `prepSixStrumBlock` once per block first.
 */
export function sixStrumStep(f: SixStrumFrame, p: SixStrumParams, sr: number, s: SixStrumState): number {
  const c = s.cache;
  const poly = p.polyConnected >= 0.5;
  const registerCv = clamp(p.register, -24, 24) / 12;
  const muteDepth = clamp(p.muteDepth, 0, 1);
  // ~8 ms mute smoothing.
  const muteCoeff = 1 - Math.exp(-1 / (0.008 * sr));
  // ~40 ms energy follower for the active-voice count.
  const enCoeff = 1 - Math.exp(-1 / (0.04 * sr));

  let sum = 0;
  let active = 0;

  for (let i = 0; i < SS_STRINGS; i++) {
    // ── target pitch for this voice (poly lane, else chord/open) ──
    const baseCv = poly
      ? polyVOctToPitchCv(f.polyPitch[i]!)
      : midiToPitchCv(c.chordOrOpenMidi[i]!);
    const targetCv = baseCv + registerCv + c.detuneVOct[i]!;

    // ── strike + envelope gating ──
    let trig = 0;
    if (poly) {
      const g = f.polyGate[i]!;
      const rising = g >= 0.5 && s.prevPolyGate[i]! < 0.5;
      const falling = g < 0.5 && s.prevPolyGate[i]! >= 0.5;
      s.prevPolyGate[i] = g;
      if (rising) {
        s.heldPitchCv[i] = targetCv;
        s.env[i]!.triggerSoft(true);
      } else if (falling) {
        s.env[i]!.triggerSoft(false);
      }
      trig = g; // karplus strikes on its own rising edge
    } else {
      // Strum-mode edge → schedule a (possibly delayed) strike.
      const st = f.strum[i]!;
      const rising = st >= 0.5 && s.prevStrum[i]! < 0.5;
      s.prevStrum[i] = st;
      if (rising) {
        // STRUM DIR = alternate flips on the event lead (string 0) so the whole
        // barre uses one consistent direction, alternating each strum.
        const dir = Math.round(p.strumDir);
        if (dir === 2 && i === 0) s.altFlip = !s.altFlip;
        const order = dir === 1
          ? SS_STRINGS - 1 - i
          : dir === 2
            ? (s.altFlip ? SS_STRINGS - 1 - i : i)
            : i;
        const d = Math.round((order / (SS_STRINGS - 1)) * c.strumSpreadSamples);
        if (d <= 0) {
          trig = 1;
          s.heldPitchCv[i] = targetCv;
          s.env[i]!.triggerSoft(true);
        } else {
          s.strikeCountdown[i] = d;
        }
      }
      if (s.strikeCountdown[i]! > 0) {
        s.strikeCountdown[i]!--;
        if (s.strikeCountdown[i] === 0) {
          trig = 1;
          s.heldPitchCv[i] = targetCv;
          s.env[i]!.triggerSoft(true);
          s.strikeCountdown[i] = -1;
        }
      }
      // A mute gate rising edge also RELEASES the amp envelope (note-off).
      const mu = f.mute[i]!;
      if (mu >= 0.5 && s.prevMute[i]! < 0.5) s.env[i]!.triggerSoft(false);
      s.prevMute[i] = mu;
    }

    // ── the string voice (karplus): held pitch, mute as `damp` ──
    c.kp.pitchCv = s.heldPitchCv[i]!;
    const damp = f.mute[i]!;
    const raw = karplusStep(trig, f.accent, damp, c.kp, sr, s.voice[i]!);

    // ── amplitude ADSR + extra mute choke ──
    const env = s.env[i]!.tick(p.attack, p.envDecay, clamp(p.sustain, 0, 1), p.release, sr);
    const muteTarget = damp >= 0.5 ? 1 : 0;
    s.muteEnv[i]! += muteCoeff * (muteTarget - s.muteEnv[i]!);
    const choke = 1 - muteDepth * s.muteEnv[i]!;
    const vout = raw * env * choke;

    // Active-voice metric (energy follower OR a non-idle envelope).
    const a = Math.abs(vout);
    s.energy[i]! += enCoeff * (a - s.energy[i]!);
    if (s.energy[i]! > 1e-4 || s.env[i]!.value > 1e-4) active++;

    sum += vout;
  }

  // ── mono sum → 1/√active norm → LEVEL ──
  const norm = 1 / Math.sqrt(Math.max(1, active));
  const master = sum * norm * Math.pow(10, clamp(p.level, -24, 12) / 20);

  // ── body resonance (post-sum; body = 0 → dry passthrough) ──
  const bodyAmt = clamp(p.body, 0, 1);
  if (bodyAmt <= 0) return master;
  const wet = (biquad(s.bodyA, master) + biquad(s.bodyB, master)) * 0.7;
  return master * (1 - bodyAmt) + wet * bodyAmt;
}
