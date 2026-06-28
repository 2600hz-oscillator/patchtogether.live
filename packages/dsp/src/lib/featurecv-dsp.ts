// packages/dsp/src/lib/featurecv-dsp.ts
//
// FEATURECV — pure DSP core for the audio→CV feature extractor. Lives under
// lib/ so esbuild inlines it into the worklet entry (packages/dsp/src/
// featurecv.ts); lib/ files MAY export freely. Also imported directly by the
// unit + ART tests so the feature maths are verifiable without spinning up an
// AudioWorklet (the renderResofilter / renderSynesthesia pattern).
//
// FEATURECV extracts WHOLE-SIGNAL TIMBRE + DYNAMICS features from one audio
// stream and emits them as CV plus an onset trigger. Deliberately distinct
// from SYNESTHESIA (which does PER-BAND energy/gate/onset): featurecv analyses
// the broadband signal, time-domain only (NO FFT) so it is fully deterministic.
//
//   loud   = broadband RMS              → cv `loud`   (energy / level)
//   bright = zero-crossing rate (ZCR)   → cv `bright` (spectral-brightness proxy)
//   punch  = crest factor (peak / RMS)  → cv `punch`  (transient-ness / dynamics)
//   onset  = time-domain flux onset     → gate `onset` (a clean trigger pulse)
//
// The three CV features are emitted BIPOLAR (−1..+1) by DEFAULT (a `bipolar`
// toggle switches to unipolar 0..1). A unipolar source from a knob-centred
// destination only sweeps half the range; bipolar sweeps the full range — see
// .myrobots/plans/synesthesia-modulation-depth-2026-06-20.md + applyBipolar.
//
// REUSE: the one-pole EnvFollower + applyBipolar come straight from
// synesthesia-dsp; the onset detector (FeatureOnset) reuses synesthesia's
// time-domain spectral-flux IDEA (fast vs slow energy envelope → normalized
// relative-rise flux → adaptive peak-pick → debounce → latched pulse), adapted
// here to a configurable sensitivity + debounce + a canonical TRIGGER_PULSE_S
// pulse value (1.0 ≫ GATE_HI) instead of synesthesia's fixed 10 ms pulse.

import { EnvFollower, applyBipolar } from './synesthesia-dsp';

// Re-export so the worklet + tests have one import site for the shared helpers.
export { EnvFollower, applyBipolar };

/** Analysis WINDOW (samples) over which rms/crest/zcr are computed. ~21 ms at
 *  48 kHz — long enough to average out the per-cycle ripple of a low tone yet
 *  short enough to track musical dynamics. */
export const FEATURE_WINDOW = 1024;
/** Recompute cadence (samples). One render quantum: the windowed features are
 *  recomputed once per HOP and the per-sample EnvFollower smooths between hops
 *  (cheap + deterministic; matches a real worklet's per-quantum analysis). */
export const FEATURE_HOP = 128;

// ── CV smoothing (attack / release of the feature CV outputs) ──
export const ATTACK_MIN_MS = 0.5;
export const ATTACK_MAX_MS = 500;
export const RELEASE_MIN_MS = 1;
export const RELEASE_MAX_MS = 2000;
export const DEFAULT_ATTACK_MS = 10;
export const DEFAULT_RELEASE_MS = 100;

// ── Feature → 0..1 CV mappings ──
/** RMS makeup: a full-scale sine (rms ≈ 0.707) reaches ≈ full scale; a −12 dBFS
 *  signal (rms ≈ 0.25) lands ≈ 0.5. Clamped to 1. */
export const LOUD_MAKEUP = 2.0;
/** ZCR fraction (0..~0.5 for white noise) → 0..1 brightness. Clamped to 1. */
export const BRIGHT_GAIN = 2.0;
/** Crest-factor window mapped onto 0..1: a DC/flat signal (crest 1) → 0, a sine
 *  (crest √2 ≈ 1.41) → ~0.08, white noise (~3.5) → ~0.5, a sharp transient
 *  (≥ CREST_MAX) → 1. */
export const CREST_MIN = 1;
export const CREST_MAX = 6;

// ── Onset detector (configurable sensitivity + debounce) ──
export const DEFAULT_ONSET_SENS = 0.5;
/** sens → adaptive-threshold multiplier. Higher SENS = LOWER multiplier = more
 *  sensitive (fires on smaller relative rises). */
export const ONSET_SENS_THRESH_MIN = 1.2; // most sensitive (sens = 1)
export const ONSET_SENS_THRESH_MAX = 4.0; // least sensitive (sens = 0)
export const DEFAULT_ONSET_DEBOUNCE_MS = 80;
export const ONSET_DEBOUNCE_MIN_MS = 20;
export const ONSET_DEBOUNCE_MAX_MS = 1000;

/** Canonical short-trigger pulse width (s) + HIGH threshold. MIRRORS
 *  $lib/audio/gate-trigger (TRIGGER_PULSE_S / GATE_HI) — the dsp package can't
 *  import the web lib, so the numbers are duplicated here, same as
 *  gatemaiden-dsp.ts. The onset pulse latches a value of 1.0 for this width,
 *  an unambiguous single crossing of GATE_HI a downstream edge detector sees. */
export const TRIGGER_PULSE_S = 0.005;
export const GATE_HI = 0.5;

// Onset energy-envelope time constants + floors (the synesthesia-onset idea,
// run on the BROADBAND |x| rather than a single band).
const ONSET_FAST_MS = 15; // leading-edge energy; ≥ a couple carrier cycles
const ONSET_SLOW_MS = 150; // slow baseline the rise is measured against
const ONSET_AVG_WIN_MS = 200; // moving-mean window for the adaptive threshold
const ONSET_FLOOR_LEVEL = 5e-3; // level below which the signal is "silent"
const ONSET_FLOOR = 0.15; // min normalized rise (15%) so idle ripple never fires

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// ───────────────────────── Pure window statistics ─────────────────────────
// Stateless functions over an analysis WINDOW (a Float32Array slice). These are
// the load-bearing feature maths; unit-tested directly with known signals.

/** Root-mean-square amplitude of the window (broadband loudness). */
export function rms(window: ArrayLike<number>): number {
  const n = window.length;
  if (n === 0) return 0;
  let s = 0;
  for (let i = 0; i < n; i++) {
    const x = window[i] ?? 0;
    s += x * x;
  }
  return Math.sqrt(s / n);
}

/** Crest factor = peak / RMS of the window — a transient-ness / dynamics
 *  measure. Silence (rms ≈ 0) returns 1 (a flat, peak-equals-rms signal). */
export function crest(window: ArrayLike<number>): number {
  const n = window.length;
  if (n === 0) return 1;
  let peak = 0;
  let s = 0;
  for (let i = 0; i < n; i++) {
    const x = window[i] ?? 0;
    const a = x < 0 ? -x : x;
    if (a > peak) peak = a;
    s += x * x;
  }
  const r = Math.sqrt(s / n);
  return r > 1e-9 ? peak / r : 1;
}

/** Zero-crossing RATE = fraction (0..1) of adjacent sample pairs that change
 *  sign — a cheap brightness proxy (a high tone / noise crosses zero far more
 *  often than a low tone). Silence (all zeros) → 0. */
export function zcr(window: ArrayLike<number>): number {
  const n = window.length;
  if (n < 2) return 0;
  let crossings = 0;
  let prev = window[0] ?? 0;
  for (let i = 1; i < n; i++) {
    const cur = window[i] ?? 0;
    if ((prev >= 0 && cur < 0) || (prev < 0 && cur >= 0)) crossings++;
    prev = cur;
  }
  return crossings / (n - 1);
}

/** Normalized positive relative-rise between a SLOW baseline energy and a FAST
 *  energy — the scale-invariant time-domain spectral-flux measure the onset
 *  detector peak-picks. ~0 at steady state, large on a fresh transient. Gated
 *  on an absolute floor so a near-silent signal can't produce a huge ratio. */
export function flux(fast: number, slow: number, floor = ONSET_FLOOR_LEVEL): number {
  return fast > slow && slow > floor ? (fast - slow) / (slow + floor) : 0;
}

// ── Feature → CV (0..1) maps (exported for unit calibration) ──
export function loudToCv(rmsVal: number): number {
  return clamp01(rmsVal * LOUD_MAKEUP);
}
export function brightToCv(zcrVal: number): number {
  return clamp01(zcrVal * BRIGHT_GAIN);
}
export function punchToCv(crestVal: number): number {
  return clamp01((crestVal - CREST_MIN) / (CREST_MAX - CREST_MIN));
}
/** Map the linear 0..1 ONSET SENS knob to the adaptive-threshold multiplier. */
export function onsetSensToThreshMult(sens01: number): number {
  const s = clamp01(sens01);
  return ONSET_SENS_THRESH_MAX + s * (ONSET_SENS_THRESH_MIN - ONSET_SENS_THRESH_MAX);
}

// ───────────────────────── Onset detector ─────────────────────────

/**
 * Time-domain spectral-flux onset detector for the broadband signal. Reuses
 * synesthesia's OnsetDetector idea (fast/slow energy envelope → normalized
 * relative-rise flux → adaptive moving-mean peak-pick → debounce lockout →
 * latched pulse) but takes the threshold multiplier + debounce length PER STEP
 * so the live SENS / DEBOUNCE knobs need no reconstruction, and latches a
 * value of 1.0 for TRIGGER_PULSE_S (a clean trigger crossing GATE_HI).
 *
 * Returns 1 while the pulse is high, else 0 (per-sample; a worklet consumer is
 * exempt from the main-thread edge-counter rule by construction).
 */
export class FeatureOnset {
  private fast = 0;
  private slow = 0;
  private avgFlux = 0;
  private pulseLeft = 0;
  private lockLeft = 0;
  private readonly fastCoef: number;
  private readonly slowCoef: number;
  private readonly avgCoef: number;
  private readonly pulseSamples: number;
  constructor(sr: number) {
    this.fastCoef = Math.exp(-1 / ((ONSET_FAST_MS / 1000) * sr));
    this.slowCoef = Math.exp(-1 / ((ONSET_SLOW_MS / 1000) * sr));
    this.avgCoef = Math.exp(-1 / ((ONSET_AVG_WIN_MS / 1000) * sr));
    this.pulseSamples = Math.max(1, Math.round(TRIGGER_PULSE_S * sr));
  }
  step(x: number, threshMult: number, debounceSamples: number): number {
    const a = x < 0 ? -x : x;
    this.fast = a + this.fastCoef * (this.fast - a);
    this.slow = a + this.slowCoef * (this.slow - a);
    const fl = flux(this.fast, this.slow);
    const threshold = this.avgFlux * threshMult + ONSET_FLOOR;
    if (this.lockLeft > 0) this.lockLeft--;
    else if (fl > threshold) {
      this.pulseLeft = this.pulseSamples;
      this.lockLeft = Math.max(1, debounceSamples);
    }
    // Update the moving mean AFTER thresholding so a transient never raises its
    // own bar (the mean tracks the recent baseline, not the spike).
    this.avgFlux = fl + this.avgCoef * (this.avgFlux - fl);
    if (this.pulseLeft > 0) {
      this.pulseLeft--;
      return 1;
    }
    return 0;
  }
}

// ───────────────────────── Per-sample extractor ─────────────────────────

export interface FeatureCvOpts {
  sr: number;
  /** CV-smoothing attack (ms). Default DEFAULT_ATTACK_MS. */
  attackMs?: number;
  /** CV-smoothing release (ms). Default DEFAULT_RELEASE_MS. */
  releaseMs?: number;
  /** Emit CV outputs bipolar (−1..+1). Default TRUE (the module default). */
  bipolar?: boolean;
  /** Onset sensitivity (0..1 knob). Default DEFAULT_ONSET_SENS. */
  onsetSens?: number;
  /** Onset debounce (ms). Default DEFAULT_ONSET_DEBOUNCE_MS. */
  onsetDebounceMs?: number;
}

export interface FeatureCvSample {
  loud: number;
  bright: number;
  punch: number;
  onset: number;
}

/**
 * Stateful per-sample feature extractor — the shared core the worklet AND the
 * offline renderFeatureCv drive. Maintains a sliding WINDOW ring buffer; every
 * FEATURE_HOP samples it recomputes rms/crest/zcr over the window and updates
 * the per-feature CV targets, which a one-pole EnvFollower (attack/release)
 * smooths toward per sample. The onset detector runs per-sample on the raw
 * signal. `bipolar`, smoothing times, and onset sens/debounce can all be set
 * LIVE (the worklet pushes the k-rate params each quantum).
 */
export class FeatureCvExtractor {
  private readonly sr: number;
  private readonly ring: Float32Array;
  private readonly scratch: Float32Array;
  private writePos = 0;
  private hop = 0;
  private targetLoud = 0;
  private targetBright = 0;
  private targetPunch = 0;
  private loudSm: EnvFollower;
  private brightSm: EnvFollower;
  private punchSm: EnvFollower;
  private lastAtk: number;
  private lastRel: number;
  private bipolar: boolean;
  private readonly onset: FeatureOnset;
  private threshMult: number;
  private debounceSamples: number;

  constructor(opts: FeatureCvOpts) {
    this.sr = opts.sr;
    this.ring = new Float32Array(FEATURE_WINDOW);
    this.scratch = new Float32Array(FEATURE_WINDOW);
    this.lastAtk = opts.attackMs ?? DEFAULT_ATTACK_MS;
    this.lastRel = opts.releaseMs ?? DEFAULT_RELEASE_MS;
    this.loudSm = new EnvFollower(this.sr, this.lastRel, this.lastAtk);
    this.brightSm = new EnvFollower(this.sr, this.lastRel, this.lastAtk);
    this.punchSm = new EnvFollower(this.sr, this.lastRel, this.lastAtk);
    this.bipolar = opts.bipolar ?? true;
    this.onset = new FeatureOnset(this.sr);
    this.threshMult = onsetSensToThreshMult(opts.onsetSens ?? DEFAULT_ONSET_SENS);
    this.debounceSamples = Math.max(
      1,
      Math.round(((opts.onsetDebounceMs ?? DEFAULT_ONSET_DEBOUNCE_MS) / 1000) * this.sr),
    );
  }

  /** Live-set the CV smoothing times. Rebuilds the one-poles only on a real
   *  change (a knob move resets the envelope state — a negligible glitch for a
   *  smoothing-TIME change). */
  setSmoothing(attackMs: number, releaseMs: number): void {
    if (attackMs === this.lastAtk && releaseMs === this.lastRel) return;
    this.lastAtk = attackMs;
    this.lastRel = releaseMs;
    this.loudSm = new EnvFollower(this.sr, releaseMs, attackMs);
    this.brightSm = new EnvFollower(this.sr, releaseMs, attackMs);
    this.punchSm = new EnvFollower(this.sr, releaseMs, attackMs);
  }

  setBipolar(bipolar: boolean): void {
    this.bipolar = bipolar;
  }

  /** Live-set onset sensitivity (0..1) + debounce (ms). Cheap — no rebuild. */
  setOnset(sens01: number, debounceMs: number): void {
    this.threshMult = onsetSensToThreshMult(sens01);
    this.debounceSamples = Math.max(1, Math.round((debounceMs / 1000) * this.sr));
  }

  private recompute(): void {
    const w = FEATURE_WINDOW;
    // Copy the ring chronologically (oldest = writePos) into the scratch.
    for (let i = 0; i < w; i++) this.scratch[i] = this.ring[(this.writePos + i) % w]!;
    this.targetLoud = loudToCv(rms(this.scratch));
    this.targetBright = brightToCv(zcr(this.scratch));
    this.targetPunch = punchToCv(crest(this.scratch));
  }

  /** Advance one sample; returns the (post-bipolar) CV features + onset gate. */
  step(x: number): FeatureCvSample {
    this.ring[this.writePos] = x;
    this.writePos = (this.writePos + 1) % FEATURE_WINDOW;
    if (++this.hop >= FEATURE_HOP) {
      this.hop = 0;
      this.recompute();
    }
    const loud = applyBipolar(this.loudSm.step(this.targetLoud), this.bipolar);
    const bright = applyBipolar(this.brightSm.step(this.targetBright), this.bipolar);
    const punch = applyBipolar(this.punchSm.step(this.targetPunch), this.bipolar);
    const onset = this.onset.step(x, this.threshMult, this.debounceSamples);
    return { loud, bright, punch, onset };
  }

  /** Latest UNIPOLAR (0..1) feature targets — for the card's display meters
   *  (never the live Y.Doc). Independent of the bipolar output polarity. */
  levels(): { loud: number; bright: number; punch: number } {
    return { loud: this.targetLoud, bright: this.targetBright, punch: this.targetPunch };
  }
}

export interface FeatureCvRender {
  loud: Float32Array;
  bright: Float32Array;
  punch: Float32Array;
  onset: Float32Array;
}

/**
 * Pure OFFLINE render of the FEATURECV circuit — feeds `input` through the
 * extractor and returns the per-sample loud / bright / punch CV + onset gate.
 * Used by the unit tests + ART. `gain` is the input trim (the live module
 * applies it via a GainNode BEFORE the worklet; offline we apply it here so the
 * render is faithful).
 */
export function renderFeatureCv(
  input: Float32Array,
  opts: FeatureCvOpts & { gain?: number },
): FeatureCvRender {
  const n = input.length;
  const gain = opts.gain ?? 1;
  const ex = new FeatureCvExtractor(opts);
  const loud = new Float32Array(n);
  const bright = new Float32Array(n);
  const punch = new Float32Array(n);
  const onset = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = ex.step((input[i] ?? 0) * gain);
    loud[i] = o.loud;
    bright[i] = o.bright;
    punch[i] = o.punch;
    onset[i] = o.onset;
  }
  return { loud, bright, punch, onset };
}
