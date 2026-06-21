// packages/dsp/src/lib/synesthesia-dsp.ts
//
// SYNESTHESIA — shared DSP for the audio-analysis module. Lives under lib/ so
// esbuild inlines it into the worklet entry (packages/dsp/src/synesthesia.ts);
// lib/ files MAY export freely. Also imported directly by the unit + ART tests
// so band-filtering / envelope / gate behaviour is verifiable without spinning
// up an AudioWorklet (the same pattern as renderResofilter()).
//
// Splits a mono signal into 4 MUSICAL spectral bands (bass 20–200, low-mid
// 200–1k, high-mid 1k–4k, treble 4k+), applies a per-band gain combined with a
// master "floor" gain, and derives a fast + slow envelope follower, a gate, a
// VU meter level, and a per-band BEAT TRIGGER (spectral-flux onset) per band.
// All state is per-instance so two independent copies (A/B) never share state.
//
// Modeled on the LZX Sensory Translator: split audio into musical bands → turn
// each band's energy into video EVENTS. The per-band onset detector converts a
// kick / snare / hat transient into a clean ~10 ms trigger pulse for driving
// video switches/flashes, instead of just a continuous envelope.

import { svfStep, cutoffToG, makeSvfState, type SvfState } from './resofilter-dsp';

/** Crossover frequencies (Hz). 4 MUSICAL bands: bass [20,200], low-mid
 *  (200,1000], high-mid (1000,4000], treble (4000,∞). Tuned for turning a
 *  drum kit into video events (kick→band1, snare→band2/3, hats→band4). */
export const SYN_BAND_EDGES = [200, 1000, 4000] as const;
export const SYN_NUM_BANDS = 4;

/** Envelope-follower attack + release times (ms) — see module spec.
 *  A REAL attack stage (was instant-attack, which strobes on video). Releases
 *  are kept at the original 50 / 500 ms so gibribbon's slow-env game feel
 *  barely shifts; only the rising edge is ramped instead of instant.
 *
 *  KICK-BASS RE-TUNE (this PR): the FAST attack dropped 5 ms → 2 ms so a kick
 *  onset hits the bass CV hard and locked-to-the-transient (atk-to-90% on a
 *  4-on-the-floor kick: ~19 ms → ~11 ms). The SLOW attack is unchanged (40 ms)
 *  so gibribbon's slow-env game cadence is untouched; only the fast CV sharpens.
 *  Releases unchanged so the env still decays cleanly between kicks at DnB
 *  (~174), industrial (~130) and psytrance (~145) tempos (the env returns to
 *  ~0 well before the next kick at all three). */
export const ENV_FAST_ATK_MS = 2;
export const ENV_FAST_REL_MS = 50;
export const ENV_SLOW_ATK_MS = 40;
export const ENV_SLOW_REL_MS = 500;
// Back-compat aliases (the release time is the dominant "decay" the gate +
// downstream CV key off; kept so existing call-sites/tests read unchanged).
export const ENV_FAST_MS = ENV_FAST_REL_MS;
export const ENV_SLOW_MS = ENV_SLOW_REL_MS;

/**
 * Per-band CV MAKEUP gain — applied ONLY to the env-follower OUTPUT values that
 * become the `env_slow` / `env_fast` CV streams (then clamped to 0..1). This is
 * the kick-bass re-tune's core: a full-amplitude band transient lands the env
 * CV near FULL SCALE (≈1.0) instead of the ~0.64 a raw band amplitude reached,
 * so a strong kick drives a downstream CV input (e.g. OUTLINES "rotation")
 * across (near) its full range.
 *
 * Measured (full-amplitude percussive burst per band): raw fast-env peaks
 * cluster at ~0.62–0.68, so ~1.5–1.6× brings any band's strong hit to full
 * scale; softer hits scale proportionally (dynamics preserved, not crushed).
 * Bass gets the slightly-higher value (the band the kick lives in). Values are
 * intentionally near-uniform so per-band response stays consistent + predictable.
 *
 * IMPORTANT: the makeup is applied to the env OUTPUT, NOT to the band signal
 * feeding the GateDetector / OnsetDetector — those keep reading the un-boosted
 * env, so the gate hysteresis (0.05/0.02) + the scale-invariant onset flux are
 * unchanged. (gibribbon reads the SLOW env CV directly, which IS boosted — its
 * demo's per-band gains were re-balanced for the new scaling; see the
 * gibribbon-demo-calibration guard.)
 */
export const CV_MAKEUP: readonly [number, number, number, number] = [1.6, 1.6, 1.6, 1.5];

/** Clamp an env-follower value to the 0..1 CV range after makeup. */
function cvClamp(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Remap a finished UNIPOLAR env CV value (0..1, post-makeup, post-clamp) to the
 * BIPOLAR [-1, +1] range when `bipolar` is on; otherwise pass it through.
 *
 * WHY: the cv→video bridge's `scaleCv` (cv-bridge-map.ts) CENTERS modulation on
 * the destination knob. A unipolar [0,1] kick with the knob at centre only
 * sweeps the UPPER half of the destination range. Remapped to [-1,+1] (silence
 * → -1, strong kick → +1), ±1 sweeps the FULL [min,max] range regardless of the
 * knob position — exactly what a Eurorack bipolar CV does.
 *
 * Applied to the env CV OUTPUT ONLY (env_slow / env_fast); the gate + onset
 * detectors keep reading the un-remapped env, so beat triggers / gate
 * hysteresis are unchanged. Default OFF preserves the existing [0,1] behaviour.
 */
export function applyBipolar(env01: number, bipolar: boolean): number {
  return bipolar ? 2 * env01 - 1 : env01;
}

/**
 * Per-band ENVELOPE-OUTPUT DEPTH (the `${c}_envdepth${b}` knob). Scales the
 * env-follower OUTPUT level — BOTH env_slow AND env_fast for that band — so the
 * user can dial how strongly a band's envelopes modulate downstream, AT THE
 * SOURCE (this replaces the scrapped per-cable/edge depth idea — depth lives
 * entirely on SYNESTHESIA).
 *
 * Range 0..2: default 1.0 = unchanged (bit-identical current behaviour), 0 =
 * that band's env outputs are silenced, 2 = doubled (then clamped to the 0..1
 * CV ceiling). Applied to the UNIPOLAR env value AFTER the CV makeup but BEFORE
 * the [0,1] clamp + the optional bipolar remap, so:
 *   - depth=0 → unipolar 0 → (bipolar) -1, i.e. the band sits at its silent rail;
 *   - depth=2 boosts a weak band's env toward full scale (clamped at 1).
 * It does NOT touch the gate / onset / band-audio / meter stages (they read the
 * un-scaled env), so triggers + gates + audio + VU are unchanged. Default 1.0
 * everywhere keeps existing patches + ART/VRT baselines byte-for-byte identical.
 */
export const ENVDEPTH_MIN = 0;
export const ENVDEPTH_MAX = 2;
export const ENVDEPTH_DEFAULT = 1;
export function applyEnvDepth(env01: number, depth: number): number {
  return env01 * depth;
}

// Butterworth damping (Q≈0.707 → k = 1/Q = √2). Cascading two such 2nd-order
// SVF stages per crossover edge gives a ~24 dB/oct Linkwitz-Riley-style slope —
// steep enough that a test tone one band away is well rejected.
const K_BUTTERWORTH = Math.SQRT2;

/**
 * Combined per-band gain. The master gain (0.5..1.5, unity at 12:00) raises or
 * lowers the floor; the per-band gain (1..2) adds on top, clamped at 0:
 *   effGain = max(0, master + (bandGain - 1))
 */
export function combinedGain(master: number, bandGain: number): number {
  const g = master + (bandGain - 1);
  return g < 0 ? 0 : g;
}

// A 24 dB/oct cascade = two SVF stages picking the same tap.
interface TwoStage {
  s1: SvfState;
  s2: SvfState;
}
function makeTwoStage(): TwoStage {
  return { s1: makeSvfState(), s2: makeSvfState() };
}
function lp2(x: number, g: number, st: TwoStage): number {
  const a = svfStep(x, g, K_BUTTERWORTH, st.s1).lp;
  return svfStep(a, g, K_BUTTERWORTH, st.s2).lp;
}
function hp2(x: number, g: number, st: TwoStage): number {
  const a = svfStep(x, g, K_BUTTERWORTH, st.s1).hp;
  return svfStep(a, g, K_BUTTERWORTH, st.s2).hp;
}

export interface BandSplitter {
  /** Split one input sample into [band1, band2, band3, band4]. Mutates state. */
  split(x: number): [number, number, number, number];
}

/**
 * Build a 4-band splitter for the given sample rate. MUSICAL bands:
 *   b1 = LP 200             (bass     20–200 Hz)
 *   b2 = HP 200  → LP 1000  (low-mid  200–1000 Hz)
 *   b3 = HP 1000 → LP 4000  (high-mid 1000–4000 Hz)
 *   b4 = HP 4000            (treble   4000+ Hz)
 * Each LP/HP is a 24 dB/oct two-stage SVF cascade (Linkwitz-Riley topology).
 */
export function makeBandSplitter(sr: number): BandSplitter {
  const g200 = cutoffToG(SYN_BAND_EDGES[0], sr);
  const g1000 = cutoffToG(SYN_BAND_EDGES[1], sr);
  const g4000 = cutoffToG(SYN_BAND_EDGES[2], sr);
  const b1lp = makeTwoStage();
  const b2hp = makeTwoStage();
  const b2lp = makeTwoStage();
  const b3hp = makeTwoStage();
  const b3lp = makeTwoStage();
  const b4hp = makeTwoStage();
  return {
    split(x: number): [number, number, number, number] {
      const b1 = lp2(x, g200, b1lp);
      const b2 = lp2(hp2(x, g200, b2hp), g1000, b2lp);
      const b3 = lp2(hp2(x, g1000, b3hp), g4000, b3lp);
      const b4 = hp2(x, g4000, b4hp);
      return [b1, b2, b3, b4];
    },
  };
}

/**
 * Two-coefficient one-pole envelope follower: ramps UP over `attackMs` toward a
 * rising target and DOWN over `releaseMs` toward a falling one. Per sample:
 *   coef = exp(-1/(tau_s·sr))   // tau_s = (atk|rel)/1000
 *   env  = target + coef·(env − target)   // pick atk-coef when target>env
 * A real attack stage replaces the old INSTANT attack — instant-attack strobes
 * downstream video on every transient. After `releaseMs` of silence the
 * envelope still decays to ~1/e (0.368) of its peak (release unchanged), so the
 * gate + slow-CV behaviour gibribbon depends on is preserved.
 *
 * Single-arg constructor (legacy) treats the one value as the release time and
 * keeps instant attack — used nowhere now but kept so old call-sites compile.
 */
export class EnvFollower {
  private env = 0;
  private readonly atkCoef: number;
  private readonly relCoef: number;
  constructor(sr: number, releaseMs: number, attackMs?: number) {
    this.relCoef = Math.exp(-1 / ((releaseMs / 1000) * sr));
    // attackMs omitted ⇒ instant attack (coef 0 ⇒ env jumps straight to target).
    this.atkCoef = attackMs === undefined ? 0 : Math.exp(-1 / ((attackMs / 1000) * sr));
  }
  step(x: number): number {
    const target = x < 0 ? -x : x;
    const coef = target > this.env ? this.atkCoef : this.relCoef;
    this.env = target + coef * (this.env - target);
    return this.env;
  }
}

/**
 * Schmitt-trigger gate driven by an envelope value: goes high when the envelope
 * crosses `thrHigh`, low when it falls back below `thrLow`. Returns 1 or 0.
 */
export class GateDetector {
  private on = false;
  constructor(
    private readonly thrHigh = 0.05,
    private readonly thrLow = 0.02,
  ) {}
  step(env: number): number {
    if (!this.on && env >= this.thrHigh) this.on = true;
    else if (this.on && env < this.thrLow) this.on = false;
    return this.on ? 1 : 0;
  }
}

/** Per-band beat-trigger constants (LZX-Sensory-Translator-style onsets). */
export const ONSET_AVG_WIN_MS = 200; // moving-mean window for the adaptive threshold
export const ONSET_THRESH_MULT = 1.4; // flux must exceed moving-mean·this to fire
export const ONSET_DEBOUNCE_MS = 80; // min inter-onset gap (ignore double-triggers)
export const ONSET_PULSE_MS = 10; // emitted trigger pulse width
// Fast / slow energy envelopes (ms). The "flux" is how far the FAST energy has
// risen above the SLOW baseline, NORMALIZED by the baseline → a scale-invariant
// relative-rise onset measure (fraction, ~0 at steady state, large on a fresh
// transient). Normalizing kills the residual-carrier-ripple re-fire a raw delta
// suffers: the ripple scales with the level, so the RATIO stays small. The fast
// envelope is long enough (15 ms) to average out the per-cycle |x| ripple of a
// musical-band tone while still catching a ~ms transient edge.
const ONSET_FAST_MS = 15; // tracks the leading edge; ≥ a couple carrier cycles
const ONSET_SLOW_MS = 150; // the slow baseline the rise is measured against
const ONSET_FLOOR_LEVEL = 5e-3; // baseline level below which a band is "silent"
const ONSET_FLOOR = 0.15; // min normalized rise (15%) so idle ripple never fires

/**
 * Per-band BEAT TRIGGER via spectral-flux / peak-picking, computed in the WORKLET
 * on a single band's time-domain energy (deterministic + headless-safe — CI does
 * headless capture and a background-tab rAF FFT would throttle, so the bass-band
 * onset ESPECIALLY must come from the worklet band energy where FFT sub-bass
 * resolution is too coarse). One instance per band per copy.
 *
 * Algorithm (sample-rate, no FFT):
 *   1. Rectify the sample and track TWO energy envelopes: a FAST one (15 ms) and
 *      a SLOW baseline (150 ms).
 *   2. "Flux" = NORMALIZED relative rise = max(0, fast − slow) / (slow + floor).
 *      A sustained tone settles to fast≈slow → flux≈0 regardless of carrier
 *      frequency/level (the normalization makes it scale-invariant, so the
 *      per-cycle ripple — which scales with the level — never re-fires). A fresh
 *      amplitude step pushes fast well above slow → a large flux burst. This is
 *      the spectral-flux analogue for a single band's time-domain energy.
 *   3. Adaptive threshold = moving-mean(flux, ~ONSET_AVG_WIN_MS) · ONSET_THRESH_MULT
 *      + an absolute floor (a minimum relative rise) — peak-picking above the
 *      recent average so only a NEW transient that spikes above baseline crosses.
 *   4. A rising cross fires a trigger, then a ONSET_DEBOUNCE_MS lockout blocks
 *      re-triggers (kills the double-trigger on a transient's ringing tail).
 *   5. Each fire latches a ONSET_PULSE_MS high pulse on the output (so a downstream
 *      gate-input sees a real edge, not a 1-sample spike that aliases away).
 *
 * Returns 1 while the pulse is high, else 0.
 */
export class OnsetDetector {
  private fast = 0; // fast band-energy envelope
  private slow = 0; // slow baseline band-energy envelope
  private avgFlux = 0; // moving-mean of the (normalized) flux
  private pulseLeft = 0; // samples remaining in the current output pulse
  private lockLeft = 0; // samples remaining in the debounce lockout
  private readonly fastCoef: number;
  private readonly slowCoef: number;
  private readonly avgCoef: number;
  private readonly pulseSamples: number;
  private readonly debounceSamples: number;
  private readonly threshMult: number;
  constructor(sr: number, opts?: { threshMult?: number }) {
    this.fastCoef = Math.exp(-1 / ((ONSET_FAST_MS / 1000) * sr));
    this.slowCoef = Math.exp(-1 / ((ONSET_SLOW_MS / 1000) * sr));
    this.avgCoef = Math.exp(-1 / ((ONSET_AVG_WIN_MS / 1000) * sr));
    this.pulseSamples = Math.max(1, Math.round((ONSET_PULSE_MS / 1000) * sr));
    this.debounceSamples = Math.max(1, Math.round((ONSET_DEBOUNCE_MS / 1000) * sr));
    this.threshMult = opts?.threshMult ?? ONSET_THRESH_MULT;
  }
  step(x: number): number {
    const a = x < 0 ? -x : x;
    // 1. Two energy envelopes.
    this.fast = a + this.fastCoef * (this.fast - a);
    this.slow = a + this.slowCoef * (this.slow - a);
    // 2. Normalized relative-rise flux (scale-invariant). Gate on an absolute
    //    level floor so a band that's essentially silent (numeric ε / idle hum)
    //    never produces a huge ratio off near-zero.
    const flux =
      this.fast > this.slow && this.slow > ONSET_FLOOR_LEVEL
        ? (this.fast - this.slow) / (this.slow + ONSET_FLOOR_LEVEL)
        : 0;
    // 3. Adaptive threshold from the moving-mean flux.
    const threshold = this.avgFlux * this.threshMult + ONSET_FLOOR;
    // 4. Peak-pick with debounce lockout.
    if (this.lockLeft > 0) this.lockLeft--;
    else if (flux > threshold) {
      this.pulseLeft = this.pulseSamples;
      this.lockLeft = this.debounceSamples;
    }
    // Update the moving-mean AFTER thresholding so a transient doesn't instantly
    // raise its own bar (the mean follows the recent baseline, not the spike).
    this.avgFlux = flux + this.avgCoef * (this.avgFlux - flux);
    // 5. Latch the output pulse.
    if (this.pulseLeft > 0) {
      this.pulseLeft--;
      return 1;
    }
    return 0;
  }
}

/**
 * VU meter ballistics: fast attack, slower release, output 0..1. Maps the band
 * amplitude to a meter value the UI scales into 10 segments.
 */
export class MeterBallistics {
  private m = 0;
  private readonly att: number;
  private readonly rel: number;
  constructor(sr: number, attackMs = 10, releaseMs = 300) {
    this.att = 1 - Math.exp(-1 / ((attackMs / 1000) * sr));
    this.rel = 1 - Math.exp(-1 / ((releaseMs / 1000) * sr));
  }
  step(x: number): number {
    const a = x < 0 ? -x : x;
    const coef = a > this.m ? this.att : this.rel;
    this.m += coef * (a - this.m);
    return this.m > 1 ? 1 : this.m;
  }
}

export interface SynesthesiaRender {
  audio: Float32Array[];
  envSlow: Float32Array[];
  envFast: Float32Array[];
  gate: Float32Array[];
  /** Per-band beat-trigger pulse (0/1), spectral-flux onset. */
  trig: Float32Array[];
  level: Float32Array[];
}

// ───────────────────────── VIDEO mode ─────────────────────────
//
// In VIDEO mode a copy's 4 "bands" become the R, G, B and LUMA channels of an
// incoming video frame instead of spectral bands. The card reads the frame's
// pixels (browser-side, where the canvas lives) and reduces them to four 0..1
// channel levels via `videoChannelLevels`; those levels then drive the SAME
// envelope-follower + gate-detector + meter the audio bands use, and become a
// steady CV-like band-audio output. This keeps the analysis/output stage
// identical across modes — only the source of the per-band scalar differs.

/** Channel index within a copy's 4 lanes when in VIDEO mode. */
export const SYN_VIDEO_CHANNELS = ['R', 'G', 'B', 'L'] as const;

// ITU-R BT.601 luma coefficients.
const LUMA_R = 0.299;
const LUMA_G = 0.587;
const LUMA_B = 0.114;

/**
 * Reduce an RGBA pixel buffer (length = w·h·4, 0..255 per channel — the layout
 * `CanvasRenderingContext2D.getImageData().data` returns) to four normalized
 * 0..1 channel levels [avgR, avgG, avgB, luma]:
 *   - avgR/avgG/avgB = mean of that channel over all pixels, ÷255.
 *   - luma           = 0.299·avgR + 0.587·avgG + 0.114·avgB (BT.601).
 *
 * A FULL REDLINE on one channel occurs when the frame is a solid block of that
 * colour: solid red → R≈1 (G,B≈0); solid white → R=G=B=1 → luma=1 too. A black
 * frame → all ≈0 (the gate floor still keeps the gate closed, not undefined).
 *
 * Returns [0,0,0,0] for an empty/degenerate buffer so callers never divide by
 * zero. Ignores the alpha channel.
 */
export function videoChannelLevels(rgba: Uint8ClampedArray | Uint8Array): [number, number, number, number] {
  const px = (rgba.length / 4) | 0;
  if (px <= 0) return [0, 0, 0, 0];
  let sr = 0, sg = 0, sb = 0;
  for (let i = 0; i < px; i++) {
    const o = i * 4;
    sr += rgba[o]!;
    sg += rgba[o + 1]!;
    sb += rgba[o + 2]!;
  }
  const r = sr / px / 255;
  const g = sg / px / 255;
  const b = sb / px / 255;
  const l = LUMA_R * r + LUMA_G * g + LUMA_B * b;
  return [r, g, b, l];
}

export interface SynesthesiaVideoFrameOut {
  /** Per-channel scaled level after combinedGain (the CV-like band-audio out). */
  audio: [number, number, number, number];
  envSlow: [number, number, number, number];
  envFast: [number, number, number, number];
  gate: [number, number, number, number];
  /** Per-channel beat-trigger pulse (0/1) — onset on the channel energy. */
  trig: [number, number, number, number];
  /** Meter level (0..1) for the VU display. */
  level: [number, number, number, number];
}

/**
 * One copy's VIDEO-mode followers — fed the per-frame R/G/B/Luma levels at the
 * audio sample rate (the card pushes a level; the worklet sample-and-holds it
 * across the render quantum). Mirrors the per-band stage of `runCopy`: each
 * channel level is scaled by `combinedGain(master, gain)` EXACTLY like audio
 * mode, then run through fast/slow envelopes, a gate, and the VU meter.
 */
export class SynesthesiaVideoCopy {
  private fast: EnvFollower[];
  private slow: EnvFollower[];
  private gate: GateDetector[];
  private onset: OnsetDetector[];
  private meter: MeterBallistics[];
  constructor(sr: number) {
    const idx = [0, 1, 2, 3];
    this.fast = idx.map(() => new EnvFollower(sr, ENV_FAST_REL_MS, ENV_FAST_ATK_MS));
    this.slow = idx.map(() => new EnvFollower(sr, ENV_SLOW_REL_MS, ENV_SLOW_ATK_MS));
    this.gate = idx.map(() => new GateDetector());
    this.onset = idx.map(() => new OnsetDetector(sr));
    this.meter = idx.map(() => new MeterBallistics(sr));
  }
  /**
   * Advance one sample. `levels` are the held R/G/B/Luma channel levels (0..1);
   * `master`/`gains` apply the same gain law as audio mode. Returns the
   * per-channel audio/env/gate/trig/level scalars for this sample. When
   * `bipolar` is true the env CV outputs are remapped 0..1 → -1..+1 (see
   * applyBipolar); audio/gate/trig/level are unaffected. `envDepth` (per
   * channel, default 1.0) scales BOTH env CV outputs (env_slow + env_fast) for
   * that channel — the env-OUTPUT depth control (see applyEnvDepth); gate/trig/
   * audio/level read the un-scaled env so they're unaffected.
   */
  step(
    levels: ArrayLike<number>,
    master: number,
    gains: ArrayLike<number>,
    bipolar = false,
    envDepth?: ArrayLike<number>,
  ): SynesthesiaVideoFrameOut {
    const audio: [number, number, number, number] = [0, 0, 0, 0];
    const envSlow: [number, number, number, number] = [0, 0, 0, 0];
    const envFast: [number, number, number, number] = [0, 0, 0, 0];
    const gate: [number, number, number, number] = [0, 0, 0, 0];
    const trig: [number, number, number, number] = [0, 0, 0, 0];
    const level: [number, number, number, number] = [0, 0, 0, 0];
    for (let c = 0; c < SYN_NUM_BANDS; c++) {
      const g = combinedGain(master, gains[c] ?? 1);
      const a = (levels[c] ?? 0) * g;
      audio[c] = a;
      // Same as audio mode: gate keys off the RAW (un-boosted) fast env; the CV
      // makeup is applied to the env OUTPUT only (then clamped to 0..1).
      const ef = this.fast[c]!.step(a);
      const es = this.slow[c]!.step(a);
      const mk = CV_MAKEUP[c] ?? 1;
      const dp = envDepth?.[c] ?? ENVDEPTH_DEFAULT;
      // env CV out: makeup → ×envDepth → clamp to [0,1] → optional bipolar remap.
      envFast[c] = applyBipolar(cvClamp(applyEnvDepth(ef * mk, dp)), bipolar);
      envSlow[c] = applyBipolar(cvClamp(applyEnvDepth(es * mk, dp)), bipolar);
      gate[c] = this.gate[c]!.step(ef);
      trig[c] = this.onset[c]!.step(a);
      level[c] = this.meter[c]!.step(a);
    }
    return { audio, envSlow, envFast, gate, trig, level };
  }
}

/**
 * Pure offline render of ONE copy in VIDEO mode. `levels` is the per-FRAME
 * sequence of [R,G,B,Luma] tuples (e.g. one entry per video frame); each is
 * held for `holdSamples` audio samples. Used by the unit tests to prove the
 * level → envelope/gate/meter path matches audio-mode behaviour.
 */
export function renderSynesthesiaVideo(
  levels: ArrayLike<number>[],
  opts: {
    sr: number;
    master?: number;
    gains?: [number, number, number, number];
    holdSamples?: number;
    /** When true, env CV outputs are bipolar [-1,+1] (default OFF = [0,1]). */
    bipolar?: boolean;
    /** Per-band env-OUTPUT depth (scales env_slow + env_fast); default all 1.0. */
    envDepth?: [number, number, number, number];
  },
): SynesthesiaRender {
  const { sr } = opts;
  const master = opts.master ?? 1;
  const gains = opts.gains ?? [1, 1, 1, 1];
  const hold = opts.holdSamples ?? 1;
  const bipolar = opts.bipolar ?? false;
  const envDepth = opts.envDepth ?? [1, 1, 1, 1];
  const n = levels.length * hold;
  const idx = [0, 1, 2, 3];
  const mk = (): Float32Array[] => idx.map(() => new Float32Array(n));
  const audio = mk(), envSlow = mk(), envFast = mk(), gate = mk(), trig = mk(), level = mk();
  const copy = new SynesthesiaVideoCopy(sr);
  let s = 0;
  for (const frame of levels) {
    for (let h = 0; h < hold; h++) {
      const out = copy.step(frame, master, gains, bipolar, envDepth);
      for (let c = 0; c < SYN_NUM_BANDS; c++) {
        audio[c]![s] = out.audio[c]!;
        envFast[c]![s] = out.envFast[c]!;
        envSlow[c]![s] = out.envSlow[c]!;
        gate[c]![s] = out.gate[c]!;
        trig[c]![s] = out.trig[c]!;
        level[c]![s] = out.level[c]!;
      }
      s++;
    }
  }
  return { audio, envSlow, envFast, gate, trig, level };
}

/**
 * Pure offline render of ONE copy of the SYNESTHESIA circuit. Used by unit
 * tests and ART. Returns per-band arrays (4 entries each, length input.length).
 */
export function renderSynesthesia(
  input: Float32Array,
  opts: {
    sr: number;
    master?: number;
    gains?: [number, number, number, number];
    /** When true, env CV outputs are bipolar [-1,+1] (default OFF = [0,1]). */
    bipolar?: boolean;
    /** Per-band env-OUTPUT depth (scales env_slow + env_fast); default all 1.0. */
    envDepth?: [number, number, number, number];
  },
): SynesthesiaRender {
  const { sr } = opts;
  const master = opts.master ?? 1;
  const gains = opts.gains ?? [1, 1, 1, 1];
  const bipolar = opts.bipolar ?? false;
  const envDepth = opts.envDepth ?? [1, 1, 1, 1];
  const n = input.length;
  const splitter = makeBandSplitter(sr);
  const idx = [0, 1, 2, 3];
  const mk = (): Float32Array[] => idx.map(() => new Float32Array(n));
  const audio = mk(), envSlow = mk(), envFast = mk(), gate = mk(), trig = mk(), level = mk();
  const fast = idx.map(() => new EnvFollower(sr, ENV_FAST_REL_MS, ENV_FAST_ATK_MS));
  const slow = idx.map(() => new EnvFollower(sr, ENV_SLOW_REL_MS, ENV_SLOW_ATK_MS));
  const gates = idx.map(() => new GateDetector());
  const onsets = idx.map(() => new OnsetDetector(sr));
  const meters = idx.map(() => new MeterBallistics(sr));
  for (let i = 0; i < n; i++) {
    const bands = splitter.split(input[i] ?? 0);
    for (let b = 0; b < SYN_NUM_BANDS; b++) {
      const g = combinedGain(master, gains[b] ?? 1);
      const a = (bands[b] as number) * g;
      audio[b]![i] = a;
      // Raw envelope (un-boosted) drives the GATE so its 0.05/0.02 hysteresis is
      // unchanged. CV makeup is applied to the env OUTPUT only (then clamped).
      const ef = fast[b]!.step(a);
      const es = slow[b]!.step(a);
      const mk = CV_MAKEUP[b] ?? 1;
      const dp = envDepth[b] ?? ENVDEPTH_DEFAULT;
      // env CV out: makeup → ×envDepth → clamp to [0,1] → optional bipolar remap.
      envFast[b]![i] = applyBipolar(cvClamp(applyEnvDepth(ef * mk, dp)), bipolar);
      envSlow[b]![i] = applyBipolar(cvClamp(applyEnvDepth(es * mk, dp)), bipolar);
      gate[b]![i] = gates[b]!.step(ef);
      trig[b]![i] = onsets[b]!.step(a);
      level[b]![i] = meters[b]!.step(a);
    }
  }
  return { audio, envSlow, envFast, gate, trig, level };
}
