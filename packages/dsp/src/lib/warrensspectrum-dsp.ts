// packages/dsp/src/lib/warrensspectrum-dsp.ts
//
// WARREN'S SPECTRUM — the SPECTRAL RESYNTH engine (phase 1) + the routing
// into the 8-band FILTERBANK (phase 2; the bank itself is in
// ./warrensspectrum-filterbank.ts).
//
// A port of the SPECTRAL engine of the Warren's Spectrum VST (project id
// `callsine`), MIT-licensed:
//   Upstream:   https://github.com/2600hz-oscillator/callsine
//   Copyright (c) 2026 callsine contributors
//   License:    MIT (compatible with this project's AGPL — one-way).
//
// This file is the PURE-TS engine core: no AudioWorklet globals, no
// browser APIs, no allocation after construction. It is imported by
//   * packages/dsp/src/warrensspectrum.ts  — the AudioWorkletProcessor
//   * packages/dsp/src/lib/warrensspectrum-dsp.test.ts — the unit gates
//   * art/scenarios/warrens-spectrum/profile.test.ts   — the ART golden
// so there is exactly ONE implementation of the algorithm. (Its predecessor
// `callsine` kept a hand-maintained "pure-math mirror" in the web def; the
// two could drift silently. One source, three consumers, no mirror.)
//
// ── SIGNAL PATH (VST src/dsp/SpectralResynth.cpp) ─────────────────────────
//   audio in → circular buffer
//     ↓ every `analysisHop` samples (the SLICE period):
//   Hann window → radix-2 FFT (2048) → magnitude spectrum
//     → adaptive threshold  thr = maxMag · 10^(FLOOR/20)          (:452-453)
//     → harmonic-sum F0 detection, 60-800 Hz, k=1..8, 1/√k        (:232-340)
//     → local-maximum peak pick, parabolic interp in LOG magnitude(:467-498)
//     → SALIENCE ranking (amp × harmonic bonus), keep top PARTIALS(:110-137)
//     → F0 force-inject when confident and F0 is missing          (:521-619)
//     → harmonic LOCK snap toward k·F0                            (:621-652)
//     → McAulay-Quatieri-lite track matching (5 % rel. Hz)        (:654-747)
//     → SMS residual: unclaimed bin energy → 16 log bands         (:749-783)
//     ↓ per sample:
//   oscillator bank (sine→saw→square PolyBLEP morph) + 16-band filtered
//   noise residual → mono out                                     (:888-1008)
//
// ── WHERE WE DELIBERATELY DIVERGE FROM THE VST ────────────────────────────
//
// 1. SLICE'S CEILING IS REMOVED (owner decision: CORRECT, not faithful).
//    The VST declares SLICE as 2..200 ms (`PluginParams.h:163-166`) but
//    `setSliceMs` clamps the hop to `fftSize*0.5` (`SpectralResynth.cpp:
//    362-373`) with `fftOrder` hardcoded to 11 (`PluginProcessor.cpp:55`),
//    so the reachable span is 2.00..21.33 ms — ~90 % of the declared VALUE
//    range and the top ~61 % of the knob's TRAVEL are unreachable.
//
//    The fix is to DELETE THE CEILING, not to work around it. `setSliceMs`
//    here is the VST's function with the `fftSize*0.5` clamp removed and
//    nothing else changed. Two independent reasons that is the intended
//    behaviour rather than a liberty:
//      * the plugin's SIBLING engine honours the full range with no FFT
//        ceiling at all (`MassPass.cpp:206-214`), so the same knob is
//        correct in one engine and broken in the other — the intended range
//        was never ambiguous;
//      * growing the FFT instead is not available: 200 ms at 48 kHz needs
//        fftSize >= 19200 (order 15), past the VST's own clamp(8,14), and
//        order 14 is a 341 ms window whose smearing destroys the transient
//        tracking SLICE exists to control.
//
//    ⚠ REJECTED ALTERNATIVE, recorded so it is not re-proposed: expressing
//    long slices as a COMMIT DECIMATION over a fixed N/4 hop
//    (`commitEvery = round(sliceSamples / hopSize)`). It quantises the
//    realised period to multiples of the hop — 12 ms and 15 ms would both
//    land on 10.67 ms — so it trades a dead top end for a stepped middle,
//    and it replaces a timeline-derivable boundary with a free-running
//    counter (see divergence 2). The window/rate decoupling it was meant to
//    buy is not needed: above the window length a frame is simply a
//    SNAPSHOT of the last 42.7 ms taken every SLICE ms, which is precisely
//    the sample-and-hold behaviour the long end of the knob is for (and is
//    what MassPass does explicitly).
//
//    ⚠ `warrensspectrum-dsp.test.ts` carries a PERMANENT negative control
//    that sweeps SLICE over the full 2..200 ms — including values that are
//    NOT multiples of any hop — and proves the realised period tracks the
//    request and the output moves ABOVE 21.33 ms, i.e. exactly where the VST
//    silently stops responding.
//
// 2. THE COMMIT BOUNDARY IS RE-DERIVED FROM THE TIMELINE, PER BLOCK.
//    `setSyncedHop` mirrors the VST's `setHostSyncedHop`
//    (`SpectralResynth.cpp:374-387`), which `PluginProcessor.cpp:175` calls
//    at the top of EVERY processBlock with a fresh `samplesUntilNext` read
//    off the host timeline. That per-block re-priming — NOT the configured
//    period — is what makes the grid sample-accurate, and it is why the
//    plugin's grid sync works fine at musical tempi despite the clamped
//    period. It only breaks when the block size reaches the clamp
//    (>= 2048 samples: the re-primed first fire per block is on-grid and
//    every subsequent one free-runs at 2047), which is an offline-render /
//    bounce problem rather than a live one.
//
//    We keep the re-priming semantic verbatim and drop the ceiling, so the
//    grid holds at EVERY block size. `setSyncedHop` must be called once per
//    render quantum with a freshly-read `samplesUntilNext`; configuring a
//    period once at setup would reintroduce exactly the drift this note
//    exists to prevent. (Phase 1 ships no SYNC mode on the module — the
//    engine carries the semantic + its gate so phase 5 is a wiring job, not
//    a redesign.)
//
// 3. PARTIALS ceilings at 256, not 892 (`MAX_TRACKS`). At 892/1024 the VST's
//    O(peaks×tracks) matcher costs ~1.07 ms in the quantum the hop fires —
//    53 % of an AudioWorklet's 2.67 ms deadline on an M5, for ONE instance.
//    256 is 4× the VST's own default (64) and 2× its default cap (128).
//
// 4. The FX-bus per-track band weights (`fxWeight`) and the multi-bus render
//    path are not ported — phase 1 is mono in / mono out with no filterbank.
//
// 5. `fastSin2Pi` is NOT ported: measured 1.01× against V8's `Math.sin`
//    intrinsic (the ~4× the polynomial buys in C++ does not exist in JS).
//
// ⚠ Divergence 4 above was written for phase 1 and is now PARTLY SUPERSEDED:
// the filterbank IS ported (phase 2), so the module is mono-in / STEREO-out.
// The FX sends, the feedback loop, the Wavetabler and the master filter are
// still absent — see ./warrensspectrum-filterbank.ts for what phase 2 does
// and does not include.

import {
  WsFilterBank,
  type WsBandSettings,
} from './warrensspectrum-filterbank';
import { WsMassPass, wsBandCountForIndex, WS_MASSPASS_BAND_COUNTS } from './warrensspectrum-masspass';
import { wsVoiceWaveform } from './warrensspectrum-voice';

// The SHAPE morph moved to ./warrensspectrum-voice.ts so MASSPASS can share
// the EXACT same function rather than the VST's hand-synchronised copy. It is
// re-exported here because that is where every existing importer looks for it.
export { wsVoiceWaveform };

// ---------------------------------------------------------------------------
// Fixed algorithm constants.
// ---------------------------------------------------------------------------

/** Analysis window. 2048 = the VST's hardcoded order-11 FFT
 *  (`PluginProcessor.cpp:55` — `resynth_.prepare(sampleRate, 11)`). */
export const WS_FFT_SIZE = 2048;
const FFT_BITS = 11; // log2(WS_FFT_SIZE)
export const WS_NUM_BINS = WS_FFT_SIZE / 2;

/** Oscillator-bank ceiling. See divergence (3) above. */
export const WS_MAX_TRACKS = 256;

/** Peak-list ceiling. A local maximum needs a strictly lower neighbour on
 *  each side, so at most every other bin can be a peak. */
const MAX_PEAKS = WS_NUM_BINS / 2;

/** SLICE's declared range, in ms — the FULL VST-declared range, all of it
 *  reachable here (divergence 1). Exported so the module def cannot re-type
 *  the numbers (CLAUDE.md: "a control's range must come from ONE place"). */
export const WS_SLICE_MIN_MS = 2;
export const WS_SLICE_MAX_MS = 200;

/** The analysis hop FLOOR, in ms — the VST's own 2 ms clamp
 *  (`SpectralResynth.cpp:368`), kept: below it the analyser would fire more
 *  than once per 128-sample render quantum. There is deliberately NO ceiling. */
const MIN_SLICE_MS = WS_SLICE_MIN_MS;

/** F0 search band + harmonic count — `SpectralResynth.cpp:244-246`. */
const F0_LO_HZ = 60;
const F0_HI_HZ = 800;
const F0_MAX_HARMONICS = 8;

/** MQ match tolerance — `SpectralResynth.h:224-226` (`kMatchTolerance`). */
const MATCH_TOLERANCE = 0.05;

/** SMS residual band count — `SpectralResynth.h:195` (`kResidualBands`). */
const RESIDUAL_BANDS = 16;
/** Bins masked either side of a claimed peak — `SpectralResynth.cpp:749`. */
const RESIDUAL_MASK_WIDTH = 3;
/** Residual band-filter resonance — `SpectralResynth.cpp:194` (`setCoefs(center, 1.4f)`). */
const RESIDUAL_Q = 1.4;
/** Band-envelope smoothing time constant — `SpectralResynth.cpp:199-203`. */
const RESIDUAL_ENV_TAU_S = 0.025;
/** xorshift32 seed — `SpectralResynth.h:200`. Constant so the engine is
 *  BYTE-REPRODUCIBLE, which is what makes an ART golden possible at all. */
export const WS_RESIDUAL_NOISE_SEED = 0x9e3779b9;

// ---------------------------------------------------------------------------
// ENGINE MODE (phase 4) — `engineMode`, `PluginParams.h:119-126`.
// ---------------------------------------------------------------------------

/**
 * `engineMode` values. The VST declares THREE
 * (`{ "SPECTRAL", "WAVETABLE", "MASSPASS" }`, `PluginParams.h:126`); we ship
 * two.
 *
 * ⚠ OUR INDICES ARE NOT THE VST'S, and that is deliberate. Upstream MASSPASS
 * is index 2 with WAVETABLE at 1. Carrying that numbering would have made
 * index 1 REACHABLE — by knob, by automation, by a CV cable — while doing
 * nothing but falling back to SPECTRAL. That is dead control travel, which is
 * exactly what the owner's "CORRECT, not faithful" decision (plan §3.2.2)
 * forbids us from reproducing, and `param-vocabulary.test.ts` rejects it
 * outright: every reachable state of a discrete param must be named.
 *
 * So our indices append IN IMPLEMENTATION ORDER: SPECTRAL 0, MASSPASS 1, and
 * WAVETABLE will take 2 when it lands. Appending means a rack saved today
 * keeps its meaning forever. The cost is that a `.wspr` fingerprint (§3.5)
 * needs a two-entry translation on `engineMode` at the import boundary —
 * which is a job for the importer, in the PR that adds it, not a reason to
 * ship a live control position that does nothing.
 */
export const WS_ENGINE_SPECTRAL = 0;
export const WS_ENGINE_MASSPASS = 1;

/** The declared `engineMode` range — every index in it is implemented. */
export const WS_ENGINE_MODE_MIN = 0;
export const WS_ENGINE_MODE_MAX = 1;

/** Re-exported so the def and the worklet read the band-count roster from the
 *  engine rather than re-typing six integers. */
export { WS_MASSPASS_BAND_COUNTS };

/** `spectralBandCount` is an INDEX into `WS_MASSPASS_BAND_COUNTS`, exactly as
 *  the VST declares it (`PluginParams.h:14`, `PluginProcessor.cpp:209-211`).
 *  Declaring the raw counts instead would need an 84-entry `options` roster
 *  to satisfy the "every discrete step is named" vocabulary gate. */
export const WS_BAND_COUNT_IDX_MIN = 0;
export const WS_BAND_COUNT_IDX_MAX = WS_MASSPASS_BAND_COUNTS.length - 1;
/** Default index 1 → 24 bands, the VST's `MassPass` default (`MassPass.h:96`). */
export const WS_BAND_COUNT_IDX_DEFAULT = 1;

/**
 * Mode-change DECLICK, in seconds.
 *
 * Switching `engineMode` swaps one DSP class for another whose output is
 * uncorrelated with it — the sample either side of the switch has no reason
 * to be continuous, so a raw swap is an audible click at any amplitude.
 * Rather than run BOTH engines through a crossfade (which would mean paying
 * SPECTRAL's full FFT cost during a MASSPASS switch, the one thing MASSPASS
 * exists to avoid), the engine ramps the DRY bus down to 0, swaps, and ramps
 * back up. 6 ms total is below the ~10 ms where a gap reads as a dropout and
 * far above the ~0.2 ms where a ramp stops suppressing the click.
 */
const MODE_XFADE_S = 0.003;

/** FILTERBANK WET / INPUT MIX declared ranges (phase 2). Exported for the
 *  same one-place-only reason as the SLICE bounds above. */
export const WS_WET_MIN = 0;
export const WS_WET_MAX = 1;
export const WS_INPUT_MIX_MIN = 0;
export const WS_INPUT_MIX_MAX = 1;

/** One-pole time constant on WET, seconds. */
const WET_SMOOTH_TAU_S = 0.005;
/** Below this the smoothed WET SNAPS to exactly 0 (only while the target is
 *  0). A one-pole never reaches its target, so without the snap a bank that
 *  was turned off would run forever on denormal-scale coefficients — and,
 *  worse, the "default costs nothing" claim would be false by an epsilon that
 *  no test could see. */
const WET_OFF_EPSILON = 1e-6;

// ---------------------------------------------------------------------------
// Precomputed tables (module scope — shared by every instance, read-only).
// ---------------------------------------------------------------------------

const HANN = new Float32Array(WS_FFT_SIZE);
for (let n = 0; n < WS_FFT_SIZE; n++) {
  HANN[n] = 0.5 * (1 - Math.cos((2 * Math.PI * n) / (WS_FFT_SIZE - 1)));
}

const BITREV = new Uint16Array(WS_FFT_SIZE);
for (let i = 0; i < WS_FFT_SIZE; i++) {
  let r = 0;
  let x = i;
  for (let b = 0; b < FFT_BITS; b++) {
    r = (r << 1) | (x & 1);
    x >>= 1;
  }
  BITREV[i] = r;
}

const COS_TWIDDLE = new Float32Array(WS_FFT_SIZE / 2);
const SIN_TWIDDLE = new Float32Array(WS_FFT_SIZE / 2);
for (let k = 0; k < WS_FFT_SIZE / 2; k++) {
  COS_TWIDDLE[k] = Math.cos((-2 * Math.PI * k) / WS_FFT_SIZE);
  SIN_TWIDDLE[k] = Math.sin((-2 * Math.PI * k) / WS_FFT_SIZE);
}

/** Cooley-Tukey radix-2 in-place complex FFT over WS_FFT_SIZE points. */
function inPlaceFFT(re: Float32Array, im: Float32Array): void {
  for (let i = 0; i < WS_FFT_SIZE; i++) {
    const j = BITREV[i]!;
    if (j > i) {
      const tr = re[i]!;
      re[i] = re[j]!;
      re[j] = tr;
      const ti = im[i]!;
      im[i] = im[j]!;
      im[j] = ti;
    }
  }
  for (let size = 2; size <= WS_FFT_SIZE; size <<= 1) {
    const half = size >> 1;
    const stride = WS_FFT_SIZE / size;
    for (let i = 0; i < WS_FFT_SIZE; i += size) {
      for (let j = 0; j < half; j++) {
        const tIdx = j * stride;
        const wr = COS_TWIDDLE[tIdx]!;
        const wi = SIN_TWIDDLE[tIdx]!;
        const aRe = re[i + j]!;
        const aIm = im[i + j]!;
        const bRe = re[i + j + half]!;
        const bIm = im[i + j + half]!;
        const tRe = wr * bRe - wi * bIm;
        const tIm = wr * bIm + wi * bRe;
        re[i + j] = aRe + tRe;
        im[i + j] = aIm + tIm;
        re[i + j + half] = aRe - tRe;
        im[i + j + half] = aIm - tIm;
      }
    }
  }
}

/**
 * SALIENCE — `peakSalience()` (`SpectralResynth.cpp:110-137`). This is what
 * makes reducing PARTIALS collapse toward F0 and its low harmonics rather
 * than toward whichever formant bin happened to be loudest.
 */
export function wsPeakSalience(
  peakHz: number,
  peakAmp: number,
  f0Hz: number,
  f0Confidence: number,
  harmonicLock: number,
): number {
  if (peakHz <= 0 || peakAmp <= 0) return 0;
  let bonus = 1;
  if (f0Hz > 5 && f0Confidence > 1 && harmonicLock > 1e-3) {
    const k = Math.round(peakHz / f0Hz);
    if (k >= 1) {
      const snappedHz = k * f0Hz;
      const cents = 1200 * Math.log2(Math.max(1e-6, peakHz / snappedHz));
      if (Math.abs(cents) < 25) {
        const confTerm = Math.max(0, Math.min(1, (f0Confidence - 1) / 1.4));
        bonus = 1 + 3 * (1 / Math.sqrt(k)) * confTerm * harmonicLock;
      }
    }
  }
  return peakAmp * bonus;
}

// ---------------------------------------------------------------------------
// TPT state-variable filter — a transcription of the VST's `dsp/Svf.h`,
// used ONLY for the 16 residual band filters (bandpass output).
// ---------------------------------------------------------------------------

class Svf {
  private ic1 = 0;
  private ic2 = 0;
  private k = 0;
  private a1 = 1;
  private a2 = 0;
  private a3 = 0;
  private sr: number;

  constructor(sampleRate: number) {
    this.sr = sampleRate;
    this.setCoefs(1000, 0.7071);
  }

  reset(): void {
    this.ic1 = 0;
    this.ic2 = 0;
  }

  setCoefs(cutoffHz: number, q: number): void {
    const fs = this.sr;
    const fcut = Math.max(10, Math.min(cutoffHz, fs * 0.45));
    const qSafe = Math.max(0.05, q);
    const g = Math.tan((Math.PI * fcut) / fs);
    this.k = 1 / qSafe;
    this.a1 = 1 / (1 + g * (g + this.k));
    this.a2 = g * this.a1;
    this.a3 = g * this.a2;
  }

  /** Bandpass output only (the residual synthesiser's `bp` tap). */
  bandpass(input: number): number {
    const v3 = input - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    return v1;
  }
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export interface WsTrackSnapshot {
  freqHz: number;
  amp: number;
  framesAlive: number;
}

/**
 * The Warren's Spectrum SPECTRAL engine. One mono channel, no allocation
 * after construction.
 *
 * Deterministic given (sampleRate, input, parameter trajectory) — the only
 * stochastic element is the residual noise, whose xorshift32 is seeded to
 * `WS_RESIDUAL_NOISE_SEED`. That is a DESIGN CONSTRAINT, not an accident:
 * it is what lets the ART lane pin a byte-exact `.f32` golden.
 */
export class WarrensSpectrumEngine {
  readonly sampleRate: number;

  // ---- analysis buffers ----
  private circular = new Float32Array(WS_FFT_SIZE);
  private circularWrite = 0;
  private samplesSinceHop = 0;
  private fftRe = new Float32Array(WS_FFT_SIZE);
  private fftIm = new Float32Array(WS_FFT_SIZE);
  private mag = new Float32Array(WS_NUM_BINS);
  /** Reused as the residual peak-claim mask (the VST reuses `phaseBin_`). */
  private claimed = new Uint8Array(WS_NUM_BINS);

  // ---- peak list ----
  private peakHz = new Float32Array(MAX_PEAKS);
  private peakAmp = new Float32Array(MAX_PEAKS);
  private peakPhase = new Float32Array(MAX_PEAKS);
  private peakSal = new Float32Array(MAX_PEAKS);
  private numPeaks = 0;

  // ---- oscillator bank ----
  private tAlive = new Uint8Array(WS_MAX_TRACKS);
  private tPhase = new Float32Array(WS_MAX_TRACKS);
  private tFreq = new Float32Array(WS_MAX_TRACKS);
  private tAmp = new Float32Array(WS_MAX_TRACKS);
  private tAmpTarget = new Float32Array(WS_MAX_TRACKS);
  private tFrames = new Int32Array(WS_MAX_TRACKS);
  private matched = new Uint8Array(WS_MAX_TRACKS);
  /** Compacted index of currently-alive-or-draining tracks: lets the render
   *  loop and the matcher skip empty slots without scanning all 256 every
   *  time. Provably identical to the full scan — it holds exactly the slots
   *  the `continue` guards would have kept. */
  private activeIdx = new Int32Array(WS_MAX_TRACKS);
  private numActive = 0;

  // ---- SMS residual ----
  private residualEdges = new Int32Array(RESIDUAL_BANDS + 1);
  private residualBp: Svf[] = [];
  private residualTarget = new Float32Array(RESIDUAL_BANDS);
  private residualEnv = new Float32Array(RESIDUAL_BANDS);
  private residualEnvCoef = 0;
  private noiseState = WS_RESIDUAL_NOISE_SEED >>> 0;

  // ---- detected F0 ----
  private f0Hz = 0;
  private f0Conf = 0;

  // ---- parameters ----
  private partials = 64;
  private thresholdDb = -42;
  private minBirthFrames = 3;
  private harmonicLock = 0.75;
  private residualLevel = 0.5;
  private shape = 0;
  private slewSeconds = 0.6;
  private sliceMs = 10;
  private centerCents = 0;
  private transposeRatio = 1;
  private gainLinear = 1;
  private frozen = false;

  // ---- engine mode (phase 4) ----
  /** Which DSP class produces the DRY bus. Defaults to SPECTRAL, so an
   *  untouched rack takes exactly the phase-1/2 code path. */
  private engineMode: number = WS_ENGINE_SPECTRAL;
  /** The MASSPASS engine. Constructed eagerly (allocation is forbidden on the
   *  audio thread) but it costs NOTHING while SPECTRAL is selected — its
   *  `processSample` is simply never called. */
  private massPass!: WsMassPass;
  /** Samples remaining in the mode-change declick ramp; 0 = not switching. */
  private modeXfadeRemaining = 0;
  /** Total length of the current declick ramp, for normalising the gain. */
  private modeXfadeTotal = 0;
  /** The mode the ramp is heading TO — applied at the ramp's midpoint. */
  private modeXfadePending: number = WS_ENGINE_SPECTRAL;

  // ---- filterbank (phase 2) ----
  /** FILTERBANK WET target. ⚠ DEFAULT 0, and that is a DELIBERATE DIVERGENCE
   *  from the VST's 1.0 (`PluginParams.h` "Filterbank Wet"). Upstream the bank
   *  is the only audio path from the first launch; here the module SHIPPED in
   *  phase 1 without a bank, so defaulting it in would silently re-voice every
   *  rack already saved against phase 1. Opt-in keeps a saved rack sounding
   *  exactly as it was recorded — see the bit-identity assertion in
   *  warrensspectrum-dsp.test.ts, which is what holds this honest. */
  private filterbankWet = 0;
  /** Raw input added on top of the main bus. 0 upstream and here. */
  private inputMix = 0;
  /** Assigned in the constructor — a field initializer would run before
   *  `this.sampleRate` is set. */
  private bank!: WsFilterBank;
  /** One-pole-smoothed WET. Automating a k-rate gain in per-quantum steps
   *  zippers; more importantly the smoother is what lets the bank be SKIPPED
   *  at 0 without a click when it is opened. At target 0 from rest it holds
   *  EXACTLY 0, so the default path stays bit-identical. */
  private wetSmoothed = 0;
  private wetSmoothCoef = 0;
  /** True while the bank has been running — so the reset on the way down
   *  happens ONCE, not every sample. */
  private bankRunning = false;
  /** Right channel of the last `processSample`. See `processSample`'s note on
   *  why the stereo half is a field rather than a returned pair. */
  private rightOut = 0;

  // ---- derived ----
  private ampCoef = 0;
  private freqCoefPerHop = 0;
  private hopSamples = 480; // 10 ms @ 48 kHz — the module's default SLICE
  /** True while a host-synced boundary is in force (cleared by setSliceMs). */
  private syncedActive = false;
  /** Committed analysis frames since construction — the SLICE observable. */
  private committedFrames = 0;

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
    const fLo = 80;
    const fHi = Math.min(12000, 0.45 * sampleRate);
    const ratio = Math.pow(fHi / fLo, 1 / RESIDUAL_BANDS);
    const binHz = sampleRate / WS_FFT_SIZE;
    for (let i = 0; i <= RESIDUAL_BANDS; i++) {
      const edgeHz = fLo * Math.pow(ratio, i);
      this.residualEdges[i] = Math.max(0, Math.min(WS_NUM_BINS, Math.round(edgeHz / binHz)));
    }
    for (let i = 0; i < RESIDUAL_BANDS; i++) {
      const svf = new Svf(sampleRate);
      svf.setCoefs(fLo * Math.pow(ratio, i + 0.5), RESIDUAL_Q);
      this.residualBp.push(svf);
    }
    const tauSamples = Math.max(1, sampleRate * RESIDUAL_ENV_TAU_S);
    this.residualEnvCoef = 1 - Math.exp(-1 / tauSamples);
    this.bank = new WsFilterBank(sampleRate);
    this.massPass = new WsMassPass(sampleRate, wsBandCountForIndex(WS_BAND_COUNT_IDX_DEFAULT));
    // ~5 ms one-pole on WET. Short enough to feel immediate, long enough that
    // a per-quantum k-rate step (2.67 ms at 128/48k) does not read as a step.
    this.wetSmoothCoef = 1 - Math.exp(-1 / Math.max(1, sampleRate * WET_SMOOTH_TAU_S));
    this.recomputeSlice();
    this.recomputeSlew();
  }

  /** Full state reset — used between ART renders so a scenario is order-free. */
  reset(): void {
    this.circular.fill(0);
    this.circularWrite = 0;
    this.samplesSinceHop = 0;
    this.tAlive.fill(0);
    this.tPhase.fill(0);
    this.tFreq.fill(0);
    this.tAmp.fill(0);
    this.tAmpTarget.fill(0);
    this.tFrames.fill(0);
    this.numActive = 0;
    this.numPeaks = 0;
    this.residualTarget.fill(0);
    this.residualEnv.fill(0);
    for (const f of this.residualBp) f.reset();
    this.noiseState = WS_RESIDUAL_NOISE_SEED >>> 0;
    this.f0Hz = 0;
    this.f0Conf = 0;
    this.committedFrames = 0;
    this.bank.reset();
    this.wetSmoothed = 0;
    this.bankRunning = false;
    this.rightOut = 0;
    this.massPass.reset();
    this.modeXfadeRemaining = 0;
    this.modeXfadeTotal = 0;
  }

  // ---- setters (all idempotent; only `slice`/`slew` recompute anything) ----

  /**
   * PARTIALS — the oscillator-bank size, clamped to [1, WS_MAX_TRACKS].
   *
   * In MASSPASS this same control is the ACTIVE-BAND limiter, re-clamped to
   * [1, bandCount] — exactly the VST's reuse of the slider
   * (`PluginProcessor.cpp:215-217`). One knob, two engines, two meanings; the
   * def documents both.
   */
  setPartials(n: number): void {
    this.partials = Math.max(1, Math.min(WS_MAX_TRACKS, Math.round(n)));
    this.massPass.setActiveBands(n);
  }

  /**
   * ENGINE MODE — `WS_ENGINE_SPECTRAL` or `WS_ENGINE_MASSPASS`.
   *
   * An unrecognised value (notably index 1, WAVETABLE, which is declared by
   * the VST but not implemented here) falls back to SPECTRAL rather than
   * silencing the module. A saved rack or a `.wspr` fingerprint written by
   * the plugin can legitimately carry a 1, and "the module went quiet" is a
   * far worse answer to that than "it played the default engine".
   *
   * A real change starts the declick ramp; setting the mode it is already in
   * is a no-op, so a per-quantum k-rate re-set cannot retrigger the ramp and
   * turn a steady setting into a 3 ms tremolo.
   */
  setEngineMode(mode: number): void {
    const wanted = Math.round(mode) === WS_ENGINE_MASSPASS ? WS_ENGINE_MASSPASS : WS_ENGINE_SPECTRAL;
    // Compare against the PENDING mode, not the live one — mid-ramp the live
    // mode may not have flipped yet, and comparing against it would restart
    // the ramp on every quantum until it completed.
    if (wanted === this.modeXfadePending) return;
    this.modeXfadePending = wanted;
    this.modeXfadeTotal = Math.max(2, Math.round(this.sampleRate * MODE_XFADE_S) * 2);
    this.modeXfadeRemaining = this.modeXfadeTotal;
  }

  /** The live engine mode. */
  getEngineMode(): number {
    return this.engineMode;
  }

  /** True while the mode-change declick ramp is running. */
  isModeSwitching(): boolean {
    return this.modeXfadeRemaining > 0;
  }

  /**
   * MASSPASS BAND COUNT, as an INDEX into `WS_MASSPASS_BAND_COUNTS`
   * (0→16 … 5→99). Ignored by SPECTRAL. Changing it re-derives 99 filter
   * coefficients, so `WsMassPass.setBandCount` no-ops when unchanged.
   */
  setBandCountIndex(idx: number): void {
    this.massPass.setBandCount(wsBandCountForIndex(idx));
    // Re-apply PARTIALS: the active-band limit is clamped to the band count,
    // so growing the bank must be able to re-widen it.
    this.massPass.setActiveBands(this.partials);
  }

  /** The MASSPASS engine, for the unit gates and the ART profile. */
  getMassPass(): WsMassPass {
    return this.massPass;
  }

  /**
   * Per-render-quantum hook. The worklet calls this ONCE before each block.
   *
   * It re-runs MASSPASS's loudest-band selection, mirroring the C++, which
   * does the selection at the top of `MassPass::process` — i.e. once per
   * block (`MassPass.cpp:236-247`). It MUST be called periodically: band
   * envelopes evolve continuously, so a selection taken once and never
   * refreshed would pin whichever bands happened to be loudest at startup
   * and PARTIALS would stop tracking the music. Doing it per SAMPLE instead
   * would multiply its O(N^2) cost by 128 and turn 0.35 % of a quantum into
   * ~45 % of one.
   *
   * Cheap and safe to call in SPECTRAL mode (it touches only MASSPASS
   * state), so the worklet does not need to know which engine is live.
   */
  beginBlock(): void {
    this.massPass.beginBlock();
  }

  /** FLOOR — peak threshold in dB BELOW THE LOUDEST BIN, not absolute dBFS. */
  setFloorDb(db: number): void {
    this.thresholdDb = Math.max(-120, Math.min(0, db));
  }

  /** STABILITY — consecutive committed frames before a track is audible. */
  setStabilityFrames(n: number): void {
    this.minBirthFrames = Math.max(1, Math.round(n));
  }

  /** LOCK — harmonic-comb snap strength. Self-disengages on unpitched input. */
  setLock(v: number): void {
    this.harmonicLock = Math.max(0, Math.min(1, v));
  }

  /** RESIDUAL — the SMS stochastic half. 0..2. */
  setResidual(v: number): void {
    this.residualLevel = Math.max(0, Math.min(2, v));
  }

  /** SHAPE — per-voice sine→saw→square morph. */
  setShape(v: number): void {
    this.shape = Math.max(0, Math.min(1, v));
    // SHAPE is genuinely shared: both engines render voices through the SAME
    // `wsVoiceWaveform`, so the knob means the same thing in either mode.
    this.massPass.setShape(v);
  }

  /** SLEW — amplitude/frequency smoothing time in seconds. */
  setSlewSeconds(sec: number): void {
    const v = Math.max(0.005, sec);
    if (v === this.slewSeconds) return;
    this.slewSeconds = v;
    this.recomputeSlew();
  }

  /**
   * SLICE — the FREE-mode analysis period, in ms. The VST's `setSliceMs`
   * with its `fftSize*0.5` ceiling removed (divergence 1); the 2 ms floor is
   * kept verbatim. Also cancels any host-synced boundary.
   */
  setSliceMs(ms: number): void {
    const v = Math.max(WS_SLICE_MIN_MS, Math.min(WS_SLICE_MAX_MS, ms));
    if (v === this.sliceMs && !this.syncedActive) return;
    this.sliceMs = v;
    this.syncedActive = false;
    this.recomputeSlice();
    this.recomputeSlew(); // freqCoefPerHop is expressed in HOPS
    // SLICE drives MASSPASS's sample-and-hold interval. Same knob, same
    // units, but a much more dramatic effect — in SPECTRAL it sets the
    // re-analysis rate, in MASSPASS it IS the stepping.
    this.massPass.setSliceMs(v, WS_SLICE_MIN_MS, WS_SLICE_MAX_MS);
  }

  /**
   * HOST-SYNCED analysis boundary — the VST's `setHostSyncedHop`
   * (`SpectralResynth.cpp:374-387`) minus its `fftSize-1` ceiling.
   *
   * ⚠ CALL THIS EVERY RENDER QUANTUM with a freshly-read `samplesUntilNext`,
   * exactly as `PluginProcessor.cpp:175` does. The sample-accuracy comes from
   * the PER-BLOCK re-priming, not from the period: re-deriving the next
   * boundary off the transport each block is what stops the analyser drifting
   * off the grid. Configuring it once at setup silently degrades into a
   * free-running counter, which is the bug this comment exists to prevent.
   *
   * @param samplesPerSlice the grid period in samples (1/16 at 120 BPM,
   *        48 kHz = 6000). Floored at 2 ms; NOT ceilinged.
   * @param samplesUntilNext samples from the START of this block to the next
   *        grid point, read off the transport.
   *
   * DEVIATION, stated because it is a real (if 1-sample) difference: the VST
   * primes `hopSize_ - samplesUntilNext`, which fires one sample BEFORE the
   * grid point (a 6000-sample grid lands on 5999/11999/17999). We prime
   * `hopSize - 1 - samplesUntilNext` so the commit lands ON the grid sample.
   */
  setSyncedHop(samplesPerSlice: number, samplesUntilNext: number): void {
    const minHop = Math.max(1, Math.round(MIN_SLICE_MS * 0.001 * this.sampleRate));
    const hop = Math.max(minHop, Math.round(samplesPerSlice));
    this.hopSamples = hop;
    this.syncedActive = true;
    this.samplesSinceHop = Math.max(0, Math.min(hop - 1, hop - 1 - Math.round(samplesUntilNext)));
    this.recomputeSlew();
  }

  /** CENTER — post-analysis transposition in cents (`setCenterCents`). */
  setCenterCents(cents: number): void {
    this.centerCents = cents;
    this.transposeRatio = Math.pow(2, cents / 1200);
  }

  /** Output gain, linear. */
  setGainLinear(g: number): void {
    this.gainLinear = Math.max(0, g);
  }

  /** FREEZE — stop committing analysis frames; the bank keeps playing. */
  setFrozen(f: boolean): void {
    this.frozen = f;
    // FREEZE reaches MASSPASS too — see `WsMassPass.setFrozen` for why this
    // DIVERGES from the VST, where the FREEZE button is inert in this mode.
    this.massPass.setFrozen(f);
  }

  // ---- filterbank (phase 2) ----

  /** FILTERBANK WET, 0..1. 0 = the bank is out of circuit entirely (and
   *  costs nothing); 1 = the resynth is heard ONLY through the bands. */
  setFilterbankWet(v: number): void {
    this.filterbankWet = Math.max(WS_WET_MIN, Math.min(WS_WET_MAX, v));
  }

  /** INPUT MIX, 0..1 — the RAW analysed input added on top of the main bus.
   *  Independent of WET: it is the only way to hear the unprocessed source. */
  setInputMix(v: number): void {
    this.inputMix = Math.max(WS_INPUT_MIX_MIN, Math.min(WS_INPUT_MIX_MAX, v));
  }

  /** Replace the whole 8-band table. Callers pass NORMALIZED bands —
   *  `wsNormalizeBands` is the one range-checking seam (see its comment for
   *  why this table cannot lean on AudioParam clamping). */
  setBands(bands: readonly WsBandSettings[]): void {
    this.bank.setBands(bands);
  }

  /** Right channel of the most recent `processSample`. */
  get rightChannel(): number {
    return this.rightOut;
  }

  /** Is the bank actually running this sample? Exported for the CPU budget
   *  test, which must be able to prove the default path SKIPS it rather than
   *  merely multiplying its result by zero. */
  get bankActive(): boolean {
    return this.bankRunning;
  }

  // ---- SLICE introspection (the negative control reads these) ----

  /** The realised analysis period, in samples. Above the 2048-sample window
   *  a frame is a SNAPSHOT of the last 42.7 ms taken once per period — the
   *  sample-and-hold behaviour the long end of SLICE exists for. */
  get analysisHop(): number {
    return this.hopSamples;
  }

  /** The realised analysis period, in ms. THIS is what SLICE actually buys. */
  get effectiveSliceMs(): number {
    return (this.hopSamples * 1000) / this.sampleRate;
  }

  /** Whether a host-synced boundary is currently in force. */
  get isSynced(): boolean {
    return this.syncedActive;
  }

  /** Committed analysis frames since construction/reset. */
  get frameCount(): number {
    return this.committedFrames;
  }

  /** Currently-alive tracked partials. */
  get liveTrackCount(): number {
    let n = 0;
    for (let i = 0; i < WS_MAX_TRACKS; i++) if (this.tAlive[i]) n++;
    return n;
  }

  /** CENTER, in cents (the value `setCenterCents` last received). */
  get centerCentsValue(): number {
    return this.centerCents;
  }

  /** Detected fundamental (Hz) and its z-score confidence. */
  get detectedF0Hz(): number {
    return this.f0Hz;
  }
  get f0Confidence(): number {
    return this.f0Conf;
  }

  /** Alive tracks, for assertions about what the tracker is holding. */
  snapshotTracks(): WsTrackSnapshot[] {
    const out: WsTrackSnapshot[] = [];
    for (let i = 0; i < WS_MAX_TRACKS; i++) {
      if (!this.tAlive[i]) continue;
      out.push({ freqHz: this.tFreq[i]!, amp: this.tAmp[i]!, framesAlive: this.tFrames[i]! });
    }
    return out;
  }

  /**
   * What the VST would have realised for this SLICE value, in ms — i.e.
   * `clamp(sliceSamples, 2 ms, fftSize/2)` (`SpectralResynth.cpp:362-373`).
   * Exists SO THE DIVERGENCE IS TESTABLE rather than merely documented: the
   * negative control asserts our value exceeds this one above 21.33 ms.
   */
  static vstClampedSliceMs(sliceMs: number, sampleRate: number): number {
    const samples = Math.min(
      Math.max(sliceMs * 0.001 * sampleRate, 2 * sampleRate * 0.001),
      WS_FFT_SIZE * 0.5,
    );
    return (Math.max(1, Math.trunc(samples)) * 1000) / sampleRate;
  }

  // ---- derived-value recomputation ----

  private recomputeSlice(): void {
    const minHop = Math.max(1, Math.round(MIN_SLICE_MS * 0.001 * this.sampleRate));
    this.hopSamples = Math.max(minHop, Math.round(this.sliceMs * 0.001 * this.sampleRate));
  }

  private recomputeSlew(): void {
    const samples = Math.max(1, this.sampleRate * this.slewSeconds);
    this.ampCoef = 1 - Math.exp(-1 / samples);
    // SLEW's frequency half is expressed in HOPS, not samples, because a
    // track's frequency only moves when a frame is analysed
    // (`SpectralResynth.cpp:352-359`).
    const hops = Math.max(1, samples / Math.max(1, this.hopSamples));
    this.freqCoefPerHop = 1 - Math.exp(-1 / hops);
  }

  // ---- analysis ----

  private analyzeFrame(): void {
    const N = WS_FFT_SIZE;
    const sr = this.sampleRate;
    const binHz = sr / N;
    this.committedFrames++;

    // (1) Linearise the circular buffer through the Hann window.
    for (let n = 0; n < N; n++) {
      const src = (this.circularWrite + n) % N;
      this.fftRe[n] = this.circular[src]! * HANN[n]!;
      this.fftIm[n] = 0;
    }
    inPlaceFFT(this.fftRe, this.fftIm);

    // (2) Magnitudes. Hann coherent gain 4/N gives per-tone amplitude.
    const ampScale = 4 / N;
    let maxMag = 0;
    let totalEnergy = 0;
    for (let b = 0; b < WS_NUM_BINS; b++) {
      const re = this.fftRe[b]!;
      const im = this.fftIm[b]!;
      const m = Math.sqrt(re * re + im * im);
      this.mag[b] = m;
      if (m > maxMag) maxMag = m;
      totalEnergy += m;
    }

    // (3) Adaptive threshold — FLOOR is RELATIVE to the loudest bin.
    const thr = maxMag * Math.pow(10, this.thresholdDb / 20);

    // (4) F0 via harmonic sum, with a z-score confidence.
    this.detectF0(binHz, totalEnergy);

    // (5) Peak pick — local maxima above thr, parabolic interp in LOG mag.
    this.numPeaks = 0;
    for (let b = 1; b < WS_NUM_BINS - 1 && this.numPeaks < MAX_PEAKS; b++) {
      const m = this.mag[b]!;
      if (m < thr) continue;
      if (m < this.mag[b - 1]!) continue;
      if (m < this.mag[b + 1]!) continue;
      const lm = Math.log(m + 1e-20);
      const lm1 = Math.log(this.mag[b - 1]! + 1e-20);
      const lm2 = Math.log(this.mag[b + 1]! + 1e-20);
      const denom = lm1 - 2 * lm + lm2;
      let delta = 0;
      if (Math.abs(denom) > 1e-12) delta = (0.5 * (lm1 - lm2)) / denom;
      if (delta < -0.5) delta = -0.5;
      else if (delta > 0.5) delta = 0.5;
      const vertexLm = lm - 0.25 * (lm1 - lm2) * delta;
      const i = this.numPeaks++;
      this.peakHz[i] = (b + delta) * binHz;
      this.peakAmp[i] = Math.exp(vertexLm) * ampScale;
      this.peakPhase[i] = this.binPhase01(b);
    }

    // (6) Salience cull — top-`partials` by SALIENCE, not amplitude.
    this.cullBySalience();

    // (7) F0 force-inject, before the LOCK snap so an injected F0 is itself
    //     lockable on this frame (`SpectralResynth.cpp:527-529`).
    this.forceInjectF0(binHz, ampScale);

    // (8) Harmonic LOCK.
    this.applyHarmonicLock();

    // (9) MQ tracking.
    this.matchTracks();

    // (10) SMS residual band targets from the UNCLAIMED bin energy.
    this.updateResidualTargets(binHz, N);
  }

  /** Phase of bin `b`, normalised to [0,1) — the birth phase of a new track. */
  private binPhase01(b: number): number {
    const ang = Math.atan2(this.fftIm[b]!, this.fftRe[b]!);
    let p = ang / (2 * Math.PI);
    p -= Math.floor(p);
    return p;
  }

  private detectF0(binHz: number, totalEnergy: number): void {
    const binLo = Math.max(2, Math.ceil(F0_LO_HZ / binHz));
    const binHi = Math.min(
      Math.floor(WS_NUM_BINS / F0_MAX_HARMONICS),
      Math.floor(F0_HI_HZ / binHz),
    );
    let bestScore = 0;
    let bestBin = -1;
    let sumScores = 0;
    let sumSquares = 0;
    let nScores = 0;
    if (binHi > binLo && totalEnergy > 1e-8) {
      for (let b = binLo; b <= binHi; b++) {
        let score = 0;
        for (let k = 1; k <= F0_MAX_HARMONICS; k++) {
          const hb = b * k;
          if (hb >= WS_NUM_BINS) break;
          score += this.mag[hb]! / Math.sqrt(k);
        }
        sumScores += score;
        sumSquares += score * score;
        nScores++;
        if (score > bestScore) {
          bestScore = score;
          bestBin = b;
        }
      }
    }
    let f0 = 0;
    let conf = 0;
    if (bestBin > 0 && nScores >= 2) {
      const mean = sumScores / nScores;
      const variance = sumSquares / nScores - mean * mean;
      const stddev = Math.sqrt(Math.max(0, variance) + 1e-12);
      const z = (bestScore - mean) / (stddev + 1e-12);
      conf = z / (Math.sqrt(Math.log(nScores + 1)) + 1e-12);
      const lm = Math.log(this.mag[bestBin]! + 1e-20);
      const lm1 = Math.log(this.mag[bestBin - 1]! + 1e-20);
      const lm2 = Math.log(this.mag[bestBin + 1]! + 1e-20);
      const denom = lm1 - 2 * lm + lm2;
      let delta = 0;
      if (Math.abs(denom) > 1e-12) delta = (0.5 * (lm1 - lm2)) / denom;
      if (delta < -0.5) delta = -0.5;
      else if (delta > 0.5) delta = 0.5;
      f0 = (bestBin + delta) * binHz;
    }
    const smooth = 0.3;
    this.f0Conf += smooth * (conf - this.f0Conf);
    if (conf > 1.4) {
      if (this.f0Hz <= 0) this.f0Hz = f0;
      else this.f0Hz += smooth * (f0 - this.f0Hz);
    } else if (this.f0Conf < 0.7) {
      this.f0Hz *= 1 - 0.5 * smooth;
      if (this.f0Hz < 5) this.f0Hz = 0;
    }
  }

  /**
   * Keep the top-`partials` peaks by SALIENCE, descending. Selection sort
   * over the first K, matching `std::partial_sort` semantics exactly
   * (`SpectralResynth.cpp:504-519`) — the tail order is unspecified there
   * and unused here.
   */
  private cullBySalience(): void {
    const n = this.numPeaks;
    if (n === 0) return;
    for (let p = 0; p < n; p++) {
      this.peakSal[p] = wsPeakSalience(
        this.peakHz[p]!,
        this.peakAmp[p]!,
        this.f0Hz,
        this.f0Conf,
        this.harmonicLock,
      );
    }
    const target = Math.min(n, this.partials);
    for (let i = 0; i < target; i++) {
      let best = i;
      for (let j = i + 1; j < n; j++) if (this.peakSal[j]! > this.peakSal[best]!) best = j;
      if (best !== i) {
        let t = this.peakSal[i]!;
        this.peakSal[i] = this.peakSal[best]!;
        this.peakSal[best] = t;
        t = this.peakHz[i]!;
        this.peakHz[i] = this.peakHz[best]!;
        this.peakHz[best] = t;
        t = this.peakAmp[i]!;
        this.peakAmp[i] = this.peakAmp[best]!;
        this.peakAmp[best] = t;
        t = this.peakPhase[i]!;
        this.peakPhase[i] = this.peakPhase[best]!;
        this.peakPhase[best] = t;
      }
    }
    this.numPeaks = target;
  }

  /** `SpectralResynth.cpp:521-619`. */
  private forceInjectF0(binHz: number, ampScale: number): void {
    if (!(this.f0Hz > 5 && this.f0Conf > 1.4)) return;
    for (let p = 0; p < this.numPeaks; p++) {
      const hz = this.peakHz[p]!;
      if (hz <= 0) continue;
      if (Math.abs(1200 * Math.log2(Math.max(1e-6, hz / this.f0Hz))) < 50) return;
    }
    const f0Bin = Math.max(1, Math.min(WS_NUM_BINS - 2, Math.round(this.f0Hz / binHz)));
    const lm = Math.log(this.mag[f0Bin]! + 1e-20);
    const lm1 = Math.log(this.mag[f0Bin - 1]! + 1e-20);
    const lm2 = Math.log(this.mag[f0Bin + 1]! + 1e-20);
    const denom = lm1 - 2 * lm + lm2;
    let delta = 0;
    if (Math.abs(denom) > 1e-12) delta = (0.5 * (lm1 - lm2)) / denom;
    if (delta < -0.5) delta = -0.5;
    else if (delta > 0.5) delta = 0.5;
    const refinedAmp = Math.exp(lm - 0.25 * (lm1 - lm2) * delta) * ampScale;
    let strongest = 0;
    for (let p = 0; p < this.numPeaks; p++) strongest = Math.max(strongest, this.peakAmp[p]!);
    const injectAmp = Math.max(refinedAmp, strongest);
    // Append when there is room; otherwise REPLACE the lowest-salience
    // survivor (the list is salience-sorted, so that is the last one).
    const slot =
      this.numPeaks < this.partials && this.numPeaks < MAX_PEAKS
        ? this.numPeaks++
        : this.numPeaks - 1;
    this.peakHz[slot] = this.f0Hz;
    this.peakAmp[slot] = injectAmp;
    this.peakPhase[slot] = this.binPhase01(f0Bin);
    this.peakSal[slot] = injectAmp;
  }

  /** `SpectralResynth.cpp:621-652`. */
  private applyHarmonicLock(): void {
    if (!(this.harmonicLock > 1e-3 && this.f0Hz > 5)) return;
    const confNorm = Math.max(0, Math.min(1, (this.f0Conf - 1.3) / 1.1));
    const lock = this.harmonicLock * confNorm;
    if (lock <= 1e-3) return;
    for (let p = 0; p < this.numPeaks; p++) {
      const freq = this.peakHz[p]!;
      const k = Math.round(freq / this.f0Hz);
      if (k < 1) continue;
      const snappedHz = k * this.f0Hz;
      if (Math.abs(freq - snappedHz) / freq > 0.06) continue;
      this.peakHz[p] = freq * (1 - lock) + snappedHz * lock;
    }
  }

  /** `SpectralResynth.cpp:654-747` — greedy nearest within 5 % relative Hz. */
  private matchTracks(): void {
    this.matched.fill(0);
    for (let p = 0; p < this.numPeaks; p++) {
      const hz = this.peakHz[p]!;
      const amp = this.peakAmp[p]!;
      let bestIdx = -1;
      let bestDist = MATCH_TOLERANCE;
      for (let a = 0; a < this.numActive; a++) {
        const i = this.activeIdx[a]!;
        if (!this.tAlive[i] || this.matched[i] || this.tFreq[i]! <= 0) continue;
        const f = this.tFreq[i]!;
        const rel = Math.abs(f - hz) / Math.max(f, hz);
        if (rel < bestDist) {
          bestDist = rel;
          bestIdx = i;
        }
      }
      if (bestIdx >= 0) {
        this.tFreq[bestIdx] = this.tFreq[bestIdx]! + this.freqCoefPerHop * (hz - this.tFreq[bestIdx]!);
        this.tAmpTarget[bestIdx] = amp;
        if (this.tFrames[bestIdx]! < 1000000) this.tFrames[bestIdx] = this.tFrames[bestIdx]! + 1;
        this.matched[bestIdx] = 1;
        continue;
      }
      let birth = -1;
      for (let i = 0; i < WS_MAX_TRACKS; i++) {
        if (!this.tAlive[i]) {
          birth = i;
          break;
        }
      }
      if (birth < 0) continue;
      this.tFreq[birth] = hz;
      // amp is deliberately NOT reset — snapping a still-decaying slot to the
      // new target is a step discontinuity, i.e. a click. Phase only jumps
      // when the slot is already silent, for the same reason.
      this.tAmpTarget[birth] = amp;
      this.tFrames[birth] = 1;
      if (this.tAmp[birth]! < 1e-4) this.tPhase[birth] = this.peakPhase[p]!;
      this.tAlive[birth] = 1;
      this.matched[birth] = 1;
    }
    for (let i = 0; i < WS_MAX_TRACKS; i++) {
      if (this.tAlive[i] && !this.matched[i]) {
        this.tAmpTarget[i] = 0;
        this.tAlive[i] = 0;
        this.tFrames[i] = 0;
      }
    }
    this.rebuildActiveIndex();
  }

  /** `SpectralResynth.cpp:749-783`. */
  private updateResidualTargets(binHz: number, N: number): void {
    this.claimed.fill(0);
    for (let p = 0; p < this.numPeaks; p++) {
      const cBin = Math.round(this.peakHz[p]! / binHz);
      const lo = Math.max(0, cBin - RESIDUAL_MASK_WIDTH);
      const hi = Math.min(WS_NUM_BINS - 1, cBin + RESIDUAL_MASK_WIDTH);
      for (let b = lo; b <= hi; b++) this.claimed[b] = 1;
    }
    // Hann coherent gain is 4/N for TONES but ~2/N for distributed noise.
    const magScale = 2 / N;
    for (let rb = 0; rb < RESIDUAL_BANDS; rb++) {
      const b0 = this.residualEdges[rb]!;
      const b1 = this.residualEdges[rb + 1]!;
      let energy = 0;
      for (let b = b0; b < b1; b++) {
        if (this.claimed[b]) continue;
        const m = this.mag[b]!;
        energy += m * m;
      }
      this.residualTarget[rb] = Math.sqrt(energy) * magScale;
    }
  }

  private rebuildActiveIndex(): void {
    let n = 0;
    for (let i = 0; i < WS_MAX_TRACKS; i++) {
      if (this.tAlive[i] || this.tAmp[i]! > 1e-7 || this.tAmpTarget[i]! > 1e-9) {
        this.activeIdx[n++] = i;
      }
    }
    this.numActive = n;
  }

  // ---- render ----

  /**
   * Advance one sample.
   *
   * @param input          the mono sample under analysis
   * @param pitchTranspose extra multiplicative transposition on top of
   *                       CENTER (the V/oct input's `2^volts`). 1 = none.
   */
  processSample(input: number, pitchTranspose = 1): number {
    // (1) Push into the circular buffer; commit an analysis frame on the
    //     SLICE boundary. Freeze skips the COMMIT, never the buffer write —
    //     so un-freezing resumes from live audio, not stale audio.
    // The circular WRITE happens in BOTH modes — it is two operations, and
    // keeping it means switching back to SPECTRAL analyses the audio that
    // just played rather than whatever was in the buffer before the user
    // left SPECTRAL. Only the ANALYSIS (the FFT + matcher, i.e. all of the
    // cost) is skipped in MASSPASS.
    this.circular[this.circularWrite] = input;
    this.circularWrite = (this.circularWrite + 1) % WS_FFT_SIZE;
    const spectralActive = this.engineMode === WS_ENGINE_SPECTRAL;
    if (++this.samplesSinceHop >= this.hopSamples) {
      this.samplesSinceHop = 0;
      if (!this.frozen && spectralActive) this.analyzeFrame();
    }

    // MASSPASS — an entirely separate DSP class. It produces the DRY bus and
    // everything downstream (WET crossfade, INPUT MIX, filterbank, gain) is
    // mode-agnostic, exactly as upstream's `resynthBuf_` is
    // (`PluginProcessor.cpp:296-298`).
    if (!spectralActive) {
      const massDry = this.massPass.processSample(input, this.transposeRatio * pitchTranspose);
      return this.finishSample(massDry, input);
    }

    const sr = this.sampleRate;
    const invSr = 1 / sr;
    const nyquist = 0.5 * sr;
    const aliasCutoff = nyquist * 0.85;
    const aliasRampStart = nyquist * 0.75;
    const aliasRampSpan = aliasCutoff - aliasRampStart;
    const ratio = this.transposeRatio * pitchTranspose;
    const shape = this.shape;
    const minBirth = this.minBirthFrames;

    // (2) Oscillator bank.
    let sample = 0;
    let drained = false;
    for (let a = 0; a < this.numActive; a++) {
      const i = this.activeIdx[a]!;
      const alive = this.tAlive[i] !== 0;
      const amp0 = this.tAmp[i]!;
      const target = this.tAmpTarget[i]!;
      if (!alive && amp0 < 1e-7 && target < 1e-9) {
        drained = true;
        continue;
      }
      const amp = amp0 + this.ampCoef * (target - amp0);
      this.tAmp[i] = amp;

      const effFreq = this.tFreq[i]! * ratio;
      if (effFreq > 0) {
        let p = this.tPhase[i]! + effFreq * invSr;
        if (p >= 1) p -= Math.floor(p);
        this.tPhase[i] = p;
      }

      let aliasGain = 1;
      if (effFreq <= 0 || effFreq >= aliasCutoff) aliasGain = 0;
      else if (effFreq > aliasRampStart) aliasGain = (aliasCutoff - effFreq) / aliasRampSpan;
      if (aliasGain <= 0 || amp <= 1e-6) continue;

      // STABILITY: a track must have been matched on `minBirthFrames`
      // consecutive COMMITS before it is audible; ramp so it fades in
      // rather than hard-unmuting.
      let stabilityGain = 1;
      const frames = this.tFrames[i]!;
      if (minBirth > 1 && frames < minBirth) stabilityGain = frames / minBirth;
      if (stabilityGain <= 0) continue;

      sample += amp * aliasGain * stabilityGain * wsVoiceWaveform(this.tPhase[i]!, effFreq * invSr, shape);
    }
    if (drained) this.rebuildActiveIndex();

    // (3) SMS residual — the half that makes this CallSine rather than a
    //     vocoder. Scaled by cbrt((partials-1)/47) so thinning the bank also
    //     cleans up the noise (`SpectralResynth.cpp:898-907`).
    const partialFraction = Math.max(0, Math.min(1, (this.partials - 1) / 47));
    const effResidual = this.residualLevel * Math.cbrt(partialFraction);
    let residual = 0;
    if (effResidual > 1e-4) {
      let s = this.noiseState;
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      this.noiseState = s >>> 0;
      const noise = (this.noiseState / 4294967295) * 2 - 1;
      for (let rb = 0; rb < RESIDUAL_BANDS; rb++) {
        const env = this.residualEnv[rb]! + this.residualEnvCoef * (this.residualTarget[rb]! - this.residualEnv[rb]!);
        this.residualEnv[rb] = env;
        residual += this.residualBp[rb]!.bandpass(noise) * env;
      }
    }

    // (4) The mono resynth, PRE-GAIN. Upstream this is `resynthBuf_`, and
    //     everything below is `processBlock`'s step [3] (the FILTERBANK WET
    //     crossfade + INPUT MIX add) followed by the master gain at [6].
    const dry = sample + residual * effResidual;

    return this.finishSample(dry, input);
  }

  /**
   * The mode-change DECLICK — a V-shaped gain on the DRY bus that reaches
   * exactly 0 at its midpoint, where the engine swap happens.
   *
   * The two engines' outputs are uncorrelated, so a bare swap steps the
   * waveform by an arbitrary amount and clicks. Crossfading the two SIGNALS
   * would be smoother still, but it would mean running SPECTRAL's FFT and
   * matcher throughout every switch INTO MassPass — paying the exact cost
   * MassPass exists to avoid, at the one moment the user is already asking
   * the CPU for something new. A 6 ms dip is the cheaper honest answer.
   *
   * Returns `dry` UNTOUCHED when no switch is in flight — an early return,
   * not `dry * 1.0`, so the steady-state path adds no float operation and
   * SPECTRAL stays byte-identical to phase 2.
   */
  private applyModeXfade(dry: number): number {
    if (this.modeXfadeRemaining <= 0) return dry;
    const half = this.modeXfadeTotal >> 1;
    const rem = --this.modeXfadeRemaining;
    // Swap at the midpoint, where the ramp gain is 0 and the discontinuity
    // is therefore multiplied by nothing.
    if (rem === half) this.engineMode = this.modeXfadePending;
    const g = rem >= half ? (rem - half) / half : (half - rem) / half;
    return dry * g;
  }

  /**
   * The MODE-AGNOSTIC tail: declick → FILTERBANK WET → INPUT MIX → gain.
   *
   * Both engines hand their mono DRY bus to this, exactly as upstream's two
   * engines both write `resynthBuf_` and share everything after it
   * (`PluginProcessor.cpp:290-300`). Splitting it out is what stops MASSPASS
   * from needing its own copy of the wet/mix/gain logic — a copy that could
   * drift, which is the whole failure mode the shared voice module above
   * also exists to prevent.
   *
   * ⚠ For SPECTRAL with no mode switch in flight this is the SAME SEQUENCE
   * OF FLOAT OPERATIONS phase 2 executed, in the same order — `applyModeXfade`
   * returns `dry` unchanged (an early `return`, not a multiply by 1.0), so
   * there is no extra rounding step. That is what keeps the three committed
   * ART baselines byte-identical, and `warrensspectrum-dsp.test.ts` asserts
   * it rather than leaving it as an argument.
   */
  private finishSample(dryIn: number, input: number): number {
    const dry = this.applyModeXfade(dryIn);

    // (5) WET, smoothed, with an exact-zero snap on the way down.
    //     The snap is to the TARGET, not just to zero. A one-pole reaches
    //     neither end, and both ends are load-bearing: at 0 an un-snapped
    //     residue would keep the bank running forever on denormal-scale
    //     coefficients and make "the default costs nothing" false by an
    //     epsilon no test could see; at 1 it would leak ~-80 dB of DRY into
    //     a bus the user asked to be 100 % wet, so "WET 1 is the bank alone"
    //     would be approximately-true prose over a literally-false signal —
    //     and a hard-panned band would measurably bleed into the far channel.
    const wetTarget = this.filterbankWet;
    let wet = this.wetSmoothed + this.wetSmoothCoef * (wetTarget - this.wetSmoothed);
    if (Math.abs(wetTarget - wet) < WET_OFF_EPSILON) wet = wetTarget;
    this.wetSmoothed = wet;
    const mix = this.inputMix;

    // (6) THE DEFAULT PATH — and the reason phase 2 does not re-voice a rack
    //     saved against phase 1.
    //
    //     ⚠ This is NOT an optimisation with a numerically-equal slow path
    //     standing behind it; it is the SAME EXPRESSION phase 1 returned,
    //     `(sample + residual * effResidual) * gainLinear`, reached by the
    //     same two float operations in the same order. The general path below
    //     would also be bit-identical here on IEEE-754 (`0*b + 1*d + 0*r`
    //     collapses exactly), but that is an argument, and an argument is not
    //     what the ART `.f32` files are pinned to. Taking the untouched
    //     expression makes the byte-identity a property of the code rather
    //     than of a floating-point proof — and it makes the default rack pay
    //     literally zero for a bank it is not using (8 SVFs/sample), which
    //     the CPU-budget test asserts by reading `bankActive`.
    if (wet <= 0) {
      if (this.bankRunning) {
        this.bank.reset();
        this.bankRunning = false;
      }
      if (mix <= 0) {
        const monoOut = dry * this.gainLinear;
        this.rightOut = monoOut;
        return monoOut;
      }
      const bothOut = (dry + mix * input) * this.gainLinear;
      this.rightOut = bothOut;
      return bothOut;
    }

    // (7) Bank in circuit — this is where the module becomes STEREO. The
    //     engine above is mono; `WsFilterBank`'s equal-power per-band pan is
    //     the only stereo-producing stage in the whole chain.
    this.bank.process(dry);
    this.bankRunning = true;
    const dryPart = (1 - wet) * dry;
    const inPart = mix * input;
    const g = this.gainLinear;
    this.rightOut = (wet * this.bank.outR + dryPart + inPart) * g;
    return (wet * this.bank.outL + dryPart + inPart) * g;
  }

  /**
   * Advance one sample and write BOTH channels into `out` (length >= 2).
   *
   * The mono `processSample` above is still the primary entry point — it
   * returns LEFT and stashes RIGHT — because that is the signature the ART
   * profile and every phase-1 unit gate already drive, and changing it would
   * have re-pinned three baselines for no audible reason. This is the
   * convenience wrapper for the worklet's two-channel write.
   */
  processSampleStereo(out: Float32Array, input: number, pitchTranspose = 1): void {
    out[0] = this.processSample(input, pitchTranspose);
    out[1] = this.rightOut;
  }

  /** Convenience block render — used by the unit gates and the ART profile. */
  processBlock(input: Float32Array, out?: Float32Array, pitchTranspose = 1): Float32Array {
    const dst = out ?? new Float32Array(input.length);
    this.beginBlock();
    for (let i = 0; i < input.length; i++) dst[i] = this.processSample(input[i]!, pitchTranspose);
    return dst;
  }
}
