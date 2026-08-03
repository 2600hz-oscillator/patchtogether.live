// packages/dsp/src/lib/warrensspectrum-masspass.ts
//
// WARREN'S SPECTRUM — the MASSPASS engine (phase 4).
//
// A transcription of the VST's `dsp/MassPass.cpp` (326 lines, plugin phases
// 39-42). It is the SECOND of `engineMode`'s three DSP classes, and it is
// NOT the spectral engine with different numbers — it shares no code with
// it. Where `WarrensSpectrumEngine` runs an FFT, picks peaks, tracks them
// across frames and renders the survivors, MASSPASS never transforms
// anything:
//
//   in ─> N log-spaced bandpasses (N ∈ 16/24/33/48/66/99), 50 Hz .. 12 kHz
//         per band i:
//           bp_i          = BP_i(in)
//           amp_i         = envelope follower on |bp_i| / Q
//           hz_i          = zero-crossing rate of bp_i, smoothed
//           voice_i       = heldAmp_i * voiceWaveform(phase_i, heldHz_i)
//         sum voice_i * 1/sqrt(N) ─> out
//
// Each band simply REPORTS WHAT IT HEARD. There is no global FFT, no peak
// ranking and no F0 inference, so the character is completely different:
// SPECTRAL is a partial tracker that follows a pitch, MASSPASS is a bank of
// N tuned resonators each running its own little oscillator. That is why it
// is a mode and not a knob.
//
// ── WHY IT SOUNDS "STEPPED" ───────────────────────────────────────────────
// The env follower and the zero-crossing pitch estimator update EVERY
// sample, but the oscillator only resamples them at SLICE boundaries
// (`heldAmp` / `heldHz`). Between snapshots amplitude and frequency are
// literally constant. That sample-and-hold is the engine's signature — it is
// the Panharmonium-ish stepping, and it is why SLICE is a much more dramatic
// control here than it is in SPECTRAL.
//
// ── COST — MEASURED BEFORE THIS FILE WAS WRITTEN ──────────────────────────
// MASSPASS has NO FFT and NO hop, so unlike SPECTRAL its cost is CONTINUOUS
// rather than a spike inside one render quantum. That collapses the two
// budgets the plan (§4.2) is careful to distinguish: "% of one core" and
// "% of the 2.667 ms per-quantum deadline" are THE SAME NUMBER here.
//
//   bands │ ms/quantum │ % of deadline (= % of one core)
//   ──────┼────────────┼────────────────────────────────
//      16 │     0.0380 │   1.42 %
//      24 │     0.0602 │   2.26 %
//      33 │     0.0833 │   3.13 %
//      48 │     0.1268 │   4.75 %
//      66 │     0.1875 │   7.03 %
//      99 │     0.3064 │  11.49 %
//
// (node v22 arm64, worst-case SHAPE 0.75 where every voice pays three
// polyBLEP evaluations, every band active, broadband input so no band
// short-circuits. Same method as plan §4.1.) All six counts ship: the
// maximum is 11.49 %, against SPECTRAL's shipped 256-partial configuration
// at ~8.9 % and the VST's unshippable 892-partial maximum at 53.5 %.
//
// `selectLoudestBands` is O(activeBands x bandCount) and runs ONCE PER
// BLOCK, so it is quadratic in N. Measured separately it is 0.0094 ms at
// N=99 — 0.35 % of the deadline, ~3 % of this engine's total — so the
// selection sort is NOT worth replacing. It was checked precisely because
// an O(N^2) term at N=99 looks alarming until it is measured.

// The SHAPE morph is shared with the SPECTRAL engine — ONE implementation,
// imported by both, so the two can never drift. (The VST keeps two
// hand-synchronised copies; see the note in warrensspectrum-voice.ts.)
import { wsVoiceWaveform } from './warrensspectrum-voice';

/**
 * The six legal band counts (`MassPass.h:38-42`, `PluginProcessor.cpp:207`).
 * 16/24/33/48 cover the audible range at roughly quarter-octave granularity;
 * 66/99 push into ~1/6 and ~1/8 octave bandwidth for a sharper, more
 * vocoder-like character.
 *
 * This array is the SINGLE SOURCE for the count — the def's `options`, the
 * worklet's index→count mapping and this engine all read it, so a seventh
 * value can never be added in one place and forgotten in another.
 */
export const WS_MASSPASS_BAND_COUNTS = [16, 24, 33, 48, 66, 99] as const;

/** The largest count — every state array is allocated at this size ONCE. */
export const WS_MASSPASS_MAX_BANDS = 99;

/** Band span, `MassPass.cpp:15-16`. Same range as the SMS residual bank. */
export const WS_MASSPASS_BAND_LO_HZ = 50;
export const WS_MASSPASS_BAND_HI_HZ = 12000;

/** Envelope follower times, `MassPass.cpp:168-172`. */
export const WS_MASSPASS_ATTACK_S = 0.003;
export const WS_MASSPASS_RELEASE_S = 0.080;
/** Zero-crossing smoother tau, `MassPass.cpp:179-180`. */
export const WS_MASSPASS_ZC_TAU_S = 0.030;

/**
 * Snap an arbitrary number to a legal band count, rounding DOWN to the
 * nearest legal value (`snapBandCount`, `MassPass.cpp:23-30`).
 */
export function wsSnapBandCount(n: number): number {
  for (const c of WS_MASSPASS_BAND_COUNTS) if (n <= c) return c;
  return WS_MASSPASS_MAX_BANDS;
}

/**
 * Map a 0-based option INDEX to its band count, clamped.
 * `PluginProcessor.cpp:209-211` does exactly this via `jlimit(0, 5, …)`.
 */
export function wsBandCountForIndex(idx: number): number {
  const i = Math.max(0, Math.min(WS_MASSPASS_BAND_COUNTS.length - 1, Math.round(idx)));
  return WS_MASSPASS_BAND_COUNTS[i]!;
}

/**
 * The MASSPASS engine. Mono in, mono out, NO ALLOCATION after construction —
 * every array is sized to `WS_MASSPASS_MAX_BANDS` up front so that changing
 * BAND COUNT from the audio thread only recomputes coefficients.
 *
 * State is flat typed arrays rather than an array of per-band objects. That
 * is the shape the cost table above was measured on; 99 objects with 7 float
 * fields each is a different (and worse) memory access pattern, so the
 * layout is load-bearing for the numbers, not a style preference.
 */
export class WsMassPass {
  readonly sampleRate: number;

  // ---- per-band SVF coefficients + state (TPT, mirrors `Svf.h`) ----
  private ic1 = new Float32Array(WS_MASSPASS_MAX_BANDS);
  private ic2 = new Float32Array(WS_MASSPASS_MAX_BANDS);
  private a1 = new Float32Array(WS_MASSPASS_MAX_BANDS);
  private a2 = new Float32Array(WS_MASSPASS_MAX_BANDS);
  private a3 = new Float32Array(WS_MASSPASS_MAX_BANDS);

  // ---- per-band tracking state ----
  private env = new Float32Array(WS_MASSPASS_MAX_BANDS);
  private lastSample = new Float32Array(WS_MASSPASS_MAX_BANDS);
  private smoothedHz = new Float32Array(WS_MASSPASS_MAX_BANDS);
  private oscPhase = new Float32Array(WS_MASSPASS_MAX_BANDS);
  /** SLICE-rate snapshots — what the OSCILLATOR actually reads. */
  private heldAmp = new Float32Array(WS_MASSPASS_MAX_BANDS);
  private heldHz = new Float32Array(WS_MASSPASS_MAX_BANDS);
  private centerHz = new Float32Array(WS_MASSPASS_MAX_BANDS);

  // ---- loudest-band selection scratch ----
  private picked = new Uint8Array(WS_MASSPASS_MAX_BANDS);
  private isActive = new Uint8Array(WS_MASSPASS_MAX_BANDS);

  private bandCount = 24;
  private activeBands = 24;
  private shape = 0;
  private qInv = 1;
  private bankNorm = 1;

  private envAttackCoef = 0;
  private envReleaseCoef = 0;
  private zcSmoothCoef = 0;

  private samplesPerSlice = 480;
  private samplesUntilSnapshot = 0;
  /** Re-run the loudest-band selection on the next sample. */
  private selectionDirty = true;
  private frozen = false;

  constructor(sampleRate: number, bandCount = 24) {
    this.sampleRate = sampleRate;
    const attackSamples = Math.max(1, sampleRate * WS_MASSPASS_ATTACK_S);
    const releaseSamples = Math.max(1, sampleRate * WS_MASSPASS_RELEASE_S);
    this.envAttackCoef = 1 - Math.exp(-1 / attackSamples);
    this.envReleaseCoef = 1 - Math.exp(-1 / releaseSamples);
    this.zcSmoothCoef = 1 - Math.exp(-1 / Math.max(1, sampleRate * WS_MASSPASS_ZC_TAU_S));
    this.samplesPerSlice = Math.max(32, Math.floor(0.01 * sampleRate));
    this.setBandCount(bandCount, true);
  }

  /**
   * Set the total bandpass count, snapping to a legal value. A no-op when
   * the count is unchanged (`PluginProcessor.cpp:212-213` guards the same
   * way) — recomputing 99 `Math.tan` calls every quantum would be a real
   * cost for no reason.
   */
  setBandCount(n: number, force = false): void {
    const snapped = wsSnapBandCount(n);
    if (!force && snapped === this.bandCount) return;
    this.bandCount = snapped;
    // Log-spaced centres. The ratio keeps each band's edges at
    // center/sqrt(r) .. center*sqrt(r), so a Q derived from it gives
    // roughly constant fractional bandwidth across the spectrum
    // (`MassPass.cpp:139-150`).
    const ratio = Math.pow(WS_MASSPASS_BAND_HI_HZ / WS_MASSPASS_BAND_LO_HZ, 1 / snapped);
    const sqrtRatio = Math.sqrt(ratio);
    const q = 1 / Math.max(0.01, sqrtRatio - 1 / sqrtRatio);
    // A high-Q SVF amplifies at resonance by ~Q. The env follower divides
    // its input by Q so the oscillator's amplitude tracks the INPUT level
    // rather than the post-resonance level — without this the bank runs
    // ~+18 dB hot at the default count (`MassPass.h:112-118`).
    this.qInv = 1 / Math.max(0.01, q);
    // Sum of N uncorrelated voices grows ~sqrt(N); normalise it away so
    // BAND COUNT is a timbre control and not a volume control.
    this.bankNorm = 1 / Math.sqrt(snapped);

    const fs = this.sampleRate;
    const k = 1 / Math.max(0.05, q);
    for (let b = 0; b < snapped; b++) {
      const center = WS_MASSPASS_BAND_LO_HZ * Math.pow(ratio, b + 0.5);
      this.centerHz[b] = center;
      const fcut = Math.max(10, Math.min(center, fs * 0.45));
      const g = Math.tan((Math.PI * fcut) / fs);
      const a1 = 1 / (1 + g * (g + k));
      this.a1[b] = a1;
      this.a2[b] = g * a1;
      this.a3[b] = g * (g * a1);
    }
    if (this.activeBands > snapped) this.activeBands = snapped;
    this.selectionDirty = true;
  }

  /**
   * Active band limit, 1..bandCount. Only the loudest `n` bands sound; the
   * rest keep tracking and keep advancing phase so re-activation cannot pop
   * (`MassPass.cpp:296-299`). This is what the module's PARTIALS control
   * drives in MASSPASS mode (`PluginProcessor.cpp:215-217`).
   */
  setActiveBands(n: number): void {
    const clamped = Math.max(1, Math.min(this.bandCount, Math.round(n)));
    if (clamped !== this.activeBands) {
      this.activeBands = clamped;
      this.selectionDirty = true;
    }
  }

  /** SHAPE, 0 = sine, 0.5 = saw, 1 = square — the SAME morph SPECTRAL uses. */
  setShape(v: number): void {
    this.shape = Math.max(0, Math.min(1, v));
  }

  /**
   * SLICE — the sample-and-hold interval, in milliseconds.
   *
   * ⚠ DIVERGENCE, and it is the SAME one the owner already settled for
   * SPECTRAL (plan §3.2.2, "CORRECT, not faithful"): we do NOT reproduce the
   * VST's dead knob travel. Here the range is honoured in full because
   * MASSPASS has no FFT and therefore no `fftSize/2` hop ceiling to collide
   * with — the C++ already honours the whole range (`MassPass.cpp:207-215`),
   * so for this engine "correct" and "faithful" happen to coincide.
   */
  setSliceMs(ms: number, minMs: number, maxMs: number): void {
    const clamped = Math.max(minMs, Math.min(maxMs, ms));
    this.samplesPerSlice = Math.max(32, Math.floor((clamped * 0.001 * this.sampleRate) | 0));
  }

  /**
   * FREEZE.
   *
   * ⚠ DELIBERATE DIVERGENCE FROM THE VST, and the reason is a repo standard
   * rather than a taste call. `PluginProcessor.cpp:219` applies FREEZE to
   * `resynth_` ONLY — there is no `massPass_.setFrozen()` anywhere in the
   * plugin, so in the VST the FREEZE button and its automation lane are
   * silently inert in MASSPASS mode.
   *
   * Our module exposes FREEZE as BOTH a param AND a `gate` INPUT PORT. A
   * port that accepts a cable and does nothing is exactly the "the control
   * lies about itself" failure class CLAUDE.md is built around — and unlike
   * a dead knob, a dead port is invisible to the user until they patch it.
   * So MASSPASS honours FREEZE with the direct analogue of what it means in
   * SPECTRAL: SPECTRAL freezes by skipping the ANALYSIS commit, MASSPASS
   * freezes by skipping the SLICE SNAPSHOT. Both hold the last-captured
   * picture and keep rendering it; neither stops the oscillators.
   */
  setFrozen(f: boolean): void {
    this.frozen = f;
  }

  getBandCount(): number {
    return this.bandCount;
  }

  getActiveBands(): number {
    return this.activeBands;
  }

  /** Centre frequency of band `b`, for tests and the card's readout. */
  getCenterHz(b: number): number {
    return b >= 0 && b < this.bandCount ? this.centerHz[b]! : 0;
  }

  /** Held (post-snapshot) amplitude of band `b` — what the oscillator reads. */
  getHeldAmp(b: number): number {
    return b >= 0 && b < this.bandCount ? this.heldAmp[b]! : 0;
  }

  /** Held (post-snapshot) frequency estimate of band `b`, Hz. */
  getHeldHz(b: number): number {
    return b >= 0 && b < this.bandCount ? this.heldHz[b]! : 0;
  }

  reset(): void {
    this.ic1.fill(0);
    this.ic2.fill(0);
    this.env.fill(0);
    this.lastSample.fill(0);
    this.smoothedHz.fill(0);
    this.oscPhase.fill(0);
    this.heldAmp.fill(0);
    this.heldHz.fill(0);
    this.samplesUntilSnapshot = 0; // first sample takes an immediate snapshot
    this.selectionDirty = true;
  }

  /**
   * Pick the loudest `activeBands` bands by current envelope.
   * `selectLoudestBands`, `MassPass.cpp:107-131`. Selection sort — O(A x N),
   * quadratic in N at A == N. Measured 0.0094 ms at N=99 (0.35 % of a render
   * quantum), so it stays a selection sort.
   */
  private reselect(): void {
    const n = this.bandCount;
    const a = this.activeBands;
    this.picked.fill(0, 0, n);
    this.isActive.fill(0, 0, n);
    for (let slot = 0; slot < a; slot++) {
      let bestIdx = -1;
      let bestEnv = -1;
      for (let b = 0; b < n; b++) {
        if (this.picked[b]! !== 0) continue;
        const e = this.env[b]!;
        if (e > bestEnv) {
          bestEnv = e;
          bestIdx = b;
        }
      }
      if (bestIdx < 0) break;
      this.picked[bestIdx] = 1;
      this.isActive[bestIdx] = 1;
    }
  }

  /**
   * Re-run the loudest-band selection. The worklet calls this ONCE PER
   * BLOCK, mirroring the C++ (`MassPass.cpp:236-247`), because band
   * envelopes evolve smoothly and the selection only needs to be
   * approximate — doing it per sample would make the O(N^2) term 128x
   * bigger and turn a 0.35 % cost into a 45 % one.
   */
  beginBlock(): void {
    this.reselect();
    this.selectionDirty = false;
  }

  /**
   * Advance one sample.
   *
   * @param input          mono sample under analysis
   * @param pitchTranspose multiplicative transposition applied to every
   *                       band's oscillator (CENTER x the V/oct input).
   *
   * ⚠ DIVERGENCE, same argument as FREEZE above: the VST's MassPass has no
   * transposition at all. Our module declares a `pitch` V/oct INPUT PORT and
   * a CENTER param, both of which would be silently dead in this mode. They
   * cost one multiply on a value the oscillator already reads, and the
   * result is musically exactly what SPECTRAL's transposition does — the
   * whole resynthesis moves in pitch — so they are honoured.
   */
  processSample(input: number, pitchTranspose = 1): number {
    if (this.selectionDirty) this.beginBlock();

    const n = this.bandCount;
    const sr = this.sampleRate;
    const invSr = 1 / sr;
    const nyquist = 0.5 * sr;
    const aliasCutoff = nyquist * 0.85;
    const aliasRampStart = nyquist * 0.75;
    const aliasRampSpan = aliasCutoff - aliasRampStart;
    const shape = this.shape;
    const qInv = this.qInv;

    // SLICE snapshot. FREEZE holds the last picture by skipping the copy —
    // the counter still runs, so un-freezing resumes on the normal grid
    // rather than firing an immediate catch-up snapshot.
    if (this.samplesUntilSnapshot <= 0) {
      if (!this.frozen) {
        for (let b = 0; b < n; b++) {
          this.heldAmp[b] = this.env[b]!;
          this.heldHz[b] = this.smoothedHz[b]!;
        }
      }
      this.samplesUntilSnapshot = this.samplesPerSlice;
    }
    this.samplesUntilSnapshot--;

    let sample = 0;
    for (let b = 0; b < n; b++) {
      // (1) Bandpass — TPT SVF, `bp` tap only.
      const ic1 = this.ic1[b]!;
      const ic2 = this.ic2[b]!;
      const v3 = input - ic2;
      const v1 = this.a1[b]! * ic1 + this.a2[b]! * v3;
      const v2 = ic2 + this.a2[b]! * ic1 + this.a3[b]! * v3;
      this.ic1[b] = 2 * v1 - ic1;
      this.ic2[b] = 2 * v2 - ic2;
      const bp = v1;

      // (2) Envelope follower on |bp|/Q — asymmetric, fast attack.
      const absBp = Math.abs(bp) * qInv;
      const envPrev = this.env[b]!;
      const coef = absBp > envPrev ? this.envAttackCoef : this.envReleaseCoef;
      this.env[b] = envPrev + coef * (absBp - envPrev);

      // (3) Zero-crossing pitch estimate. A rising crossing contributes one
      //     impulse of height `sr`; smoothing that impulse train with a
      //     ~30 ms one-pole yields crossings/second == Hz for a signal with
      //     two crossings per cycle... which is what a bandpassed sine is.
      const impulse = bp >= 0 && this.lastSample[b]! < 0 ? sr : 0;
      this.smoothedHz[b] = this.smoothedHz[b]! + this.zcSmoothCoef * (impulse - this.smoothedHz[b]!);
      this.lastSample[b] = bp;

      // (4) Oscillator — reads the HELD values, not the live ones. Phase
      //     advances even for inactive/silent bands so that re-activating a
      //     band does not restart it from phase 0 with a click.
      const effFreq = this.heldHz[b]! * pitchTranspose;
      if (effFreq > 0) {
        let p = this.oscPhase[b]! + effFreq * invSr;
        p -= Math.floor(p);
        this.oscPhase[b] = p;
      }

      if (this.isActive[b]! === 0) continue;
      const amp = this.heldAmp[b]!;
      if (amp <= 1e-6) continue;
      if (effFreq <= 0) continue;

      let aliasGain = 1;
      if (effFreq >= aliasCutoff) aliasGain = 0;
      else if (effFreq > aliasRampStart) aliasGain = (aliasCutoff - effFreq) / aliasRampSpan;
      if (aliasGain <= 0) continue;

      sample += amp * aliasGain * wsVoiceWaveform(this.oscPhase[b]!, effFreq * invSr, shape);
    }

    return sample * this.bankNorm;
  }

  /** Convenience block render — used by the unit gates and the ART profile. */
  processBlock(input: Float32Array, out?: Float32Array, pitchTranspose = 1): Float32Array {
    const dst = out ?? new Float32Array(input.length);
    this.beginBlock();
    for (let i = 0; i < input.length; i++) dst[i] = this.processSample(input[i]!, pitchTranspose);
    return dst;
  }
}
