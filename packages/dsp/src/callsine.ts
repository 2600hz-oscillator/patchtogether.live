// packages/dsp/src/callsine.ts
//
// CALLSINE — spectral-analysis additive resynthesizer.
//
// Algorithmic port of Warren's Spectrum (a.k.a. CallSine), MIT-licensed.
//   Upstream:   https://github.com/2600hz-oscillator/callsine
//   Copyright (c) 2026 callsine contributors
//   License:    MIT (compatible with this project's AGPL — one-way).
//
// What it does:
//   audio in → real-time STFT → parabolic-interpolated peak detection →
//   harmonic-sum F0 detector → McAulay-Quatieri-lite partial tracking →
//   per-partial sinusoidal oscillator bank → mono out.
//
// Architecture (single AudioWorkletProcessor, pure TS, no Faust):
//   - circular write buffer (FFT_SIZE = 1024 → ~21 ms window @ 48 kHz)
//   - Hann analysis window + custom radix-2 real FFT (no JUCE; clean-room)
//   - hop = FFT_SIZE / 4 → 4× overlap-add analysis cadence
//   - up to N_TRACKS=64 simultaneous tracked sinusoidal oscillators
//   - per-track amplitude + frequency smoothing (per-hop low-pass) to
//     glide between analysis frames without clicks
//   - 2 voice models in v1, scaffolded for >12 more (see VOICE_MODELS):
//       0 SINES  → pure sinusoidal additive (the canonical resynth)
//       1 SAW    → each partial uses a polyBLEP sawtooth at the partial
//                  frequency (Warren's "shape morph" at full-saw position)
//
// Macros (Plaits-style mapping; chosen so all three feel like distinct
// knobs that move the audio, not a 50-knob CallSine front panel):
//   harmonics → partials count (1..N_TRACKS).  More = fuller resynth;
//               fewer = telephone / wind-chime sparseness.
//   timbre    → SLEW (smoothing time in seconds, 5 ms..2 s). Long SLEW
//               = pad / drone; short SLEW = transient-faithful.
//   morph     → harmonic-LOCK (0..1). 0 = raw partial freqs (warbly,
//               vocoder-y on voice); 1 = snap each partial to integer
//               multiples of detected F0 (musical, "comb-like").
//   level     → output gain.
//
// I/O:
//   inputs:  audio_in (mono), pitch (V/oct → center-cents shift),
//            gate (rising edge toggles FREEZE), CV → AudioParam fast paths
//            on every macro.
//   outputs: out (mono).

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  port: MessagePort;
  constructor(options?: { processorOptions?: unknown });
  process?(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}
declare function registerProcessor(name: string, ctor: typeof AudioWorkletProcessor): void;

// ---------------------------------------------------------------------------
// Constants. FFT_SIZE chosen to give ~21 ms analysis window at 48 kHz —
// short enough that vocal/voicing transients land cleanly, long enough
// that bin resolution (~47 Hz) is musically useful. HOP_SIZE = FFT_SIZE/4
// is the 4× overlap-add convention for Hann windows.
// ---------------------------------------------------------------------------
const FFT_SIZE = 1024;
const FFT_BITS = 10;        // log2(FFT_SIZE)
const HOP_SIZE = FFT_SIZE / 4;
const NUM_BINS = FFT_SIZE / 2;
const N_TRACKS = 64;        // max simultaneous oscillators

// F0 search range — covers cello-low (60 Hz) to whistle-low (800 Hz). The
// detector simply doesn't bother outside this band; transposition / center
// can shift it post-analysis.
const F0_LO_HZ = 60;
const F0_HI_HZ = 800;
const F0_MAX_HARMONICS = 8;

// ---------------------------------------------------------------------------
// Hann window — precomputed once.
// ---------------------------------------------------------------------------
const HANN = new Float32Array(FFT_SIZE);
for (let n = 0; n < FFT_SIZE; n++) {
  HANN[n] = 0.5 * (1 - Math.cos((2 * Math.PI * n) / (FFT_SIZE - 1)));
}

// ---------------------------------------------------------------------------
// Bit-reversed permutation table for radix-2 FFT. Computed once.
// ---------------------------------------------------------------------------
const BITREV = new Uint16Array(FFT_SIZE);
for (let i = 0; i < FFT_SIZE; i++) {
  let r = 0;
  let x = i;
  for (let b = 0; b < FFT_BITS; b++) {
    r = (r << 1) | (x & 1);
    x >>= 1;
  }
  BITREV[i] = r;
}

// ---------------------------------------------------------------------------
// Twiddle factors for radix-2 in-place FFT. cosTab/sinTab[k] = exp(-2πi k/N)
// for k in [0..N/2). Used by inPlaceFFT below.
// ---------------------------------------------------------------------------
const COS_TWIDDLE = new Float32Array(FFT_SIZE / 2);
const SIN_TWIDDLE = new Float32Array(FFT_SIZE / 2);
for (let k = 0; k < FFT_SIZE / 2; k++) {
  COS_TWIDDLE[k] = Math.cos((-2 * Math.PI * k) / FFT_SIZE);
  SIN_TWIDDLE[k] = Math.sin((-2 * Math.PI * k) / FFT_SIZE);
}

/**
 * Cooley-Tukey radix-2 in-place complex FFT. re[] and im[] are length
 * FFT_SIZE; result overwrites them with the forward transform.
 *
 * Why a hand-rolled FFT rather than the SubtleCrypto / Web Audio one?
 * No clean cross-platform API exists inside an AudioWorkletGlobalScope —
 * we'd otherwise need to pull a third-party WASM (kissfft etc.). For a
 * 1024-point FFT every ~5.3 ms (the hop period), the pure-JS cost is
 * ~80 µs on Apple Silicon — well inside our worklet budget.
 */
function inPlaceFFT(re: Float32Array, im: Float32Array): void {
  // Bit-reverse permutation.
  for (let i = 0; i < FFT_SIZE; i++) {
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
  // Iterative butterflies. At each stage `size`, the twiddle stride
  // is FFT_SIZE / size so we step through the precomputed table.
  for (let size = 2; size <= FFT_SIZE; size <<= 1) {
    const half = size >> 1;
    const stride = FFT_SIZE / size;
    for (let i = 0; i < FFT_SIZE; i += size) {
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

// ---------------------------------------------------------------------------
// Helpers for the SAW model.
// ---------------------------------------------------------------------------
function polyBlep(t: number, dt: number): number {
  if (t < dt) {
    const x = t / dt;
    return x + x - x * x - 1;
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt;
    return x * x + x + x + 1;
  }
  return 0;
}

// Voice render — `model` picks the waveform of each tracked partial. SINES
// is the canonical CallSine output; SAW makes the bank crunchier (each
// partial becomes a band-limited saw at its tracked frequency). Designed
// as a single function so adding more models (model #2..#13) means
// extending this switch — no per-voice state changes required.
function renderVoice(phase01: number, dt: number, model: number): number {
  if (model === 0) {
    // SINES — the canonical resynth voice.
    return Math.sin(2 * Math.PI * phase01);
  }
  // SAW — naive saw with PolyBLEP correction.
  const naive = 2 * phase01 - 1;
  return naive - polyBlep(phase01, dt);
}

// ---------------------------------------------------------------------------
// CallSine processor. State persists across process() calls; the audio
// thread never allocates after construction.
// ---------------------------------------------------------------------------
interface Track {
  alive: boolean;
  phase: number;       // [0, 1)
  freq: number;        // Hz
  amp: number;         // smoothed toward ampTarget
  ampTarget: number;
}

class CallsineProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      // model: 0=SINES, 1=SAW. maxValue grows as engines land; keep equal
      // to (MODEL_NAMES.length - 1) on the card side.
      { name: 'model',     defaultValue: 0,    minValue: 0,    maxValue: 1,  automationRate: 'a-rate' as const },
      // harmonics: continuous 0..1 maps to partial count 1..N_TRACKS.
      { name: 'harmonics', defaultValue: 0.6,  minValue: 0,    maxValue: 1,  automationRate: 'a-rate' as const },
      // timbre: 0..1 maps to SLEW seconds via log curve (5 ms..2 s).
      { name: 'timbre',    defaultValue: 0.4,  minValue: 0,    maxValue: 1,  automationRate: 'a-rate' as const },
      // morph: 0..1 maps to harmonic LOCK strength (raw → F0-snapped).
      { name: 'morph',     defaultValue: 0.0,  minValue: 0,    maxValue: 1,  automationRate: 'a-rate' as const },
      // level: 0..1 output gain.
      { name: 'level',     defaultValue: 0.8,  minValue: 0,    maxValue: 1,  automationRate: 'a-rate' as const },
      // note: ±60 semitone offset on top of V/oct pitch (transpose
      // resynth output).
      { name: 'note',      defaultValue: 0,    minValue: -60,  maxValue: 60, automationRate: 'a-rate' as const },
    ];
  }

  // ---- buffers ----
  private circular = new Float32Array(FFT_SIZE);
  private circularWrite = 0;
  private samplesSinceHop = 0;
  private fftRe = new Float32Array(FFT_SIZE);
  private fftIm = new Float32Array(FFT_SIZE);
  private mag = new Float32Array(NUM_BINS);
  // peakHz/peakAmp re-used between analyzeFrame() and process() — pre-sized
  // to N_TRACKS so we never allocate on the audio thread.
  private peakHz = new Float32Array(N_TRACKS);
  private peakAmp = new Float32Array(N_TRACKS);
  private numPeaks = 0;

  // ---- tracks (oscillator bank) ----
  private tracks: Track[] = [];

  // ---- detected F0 (smoothed) ----
  private f0Hz = 0;
  private f0Conf = 0;

  // ---- freeze latch + gate edge ----
  private frozen = false;
  private lastGate = 0;

  // ---- precomputed coefficients (recomputed when SLEW changes) ----
  private ampCoef = 0.01;       // per-sample amp slew
  private freqCoefPerHop = 0.1; // per-hop freq slew
  private lastSlewSec = -1;     // memo to skip recompute when stable

  constructor(options?: { processorOptions?: unknown }) {
    super(options);
    for (let i = 0; i < N_TRACKS; i++) {
      this.tracks.push({ alive: false, phase: 0, freq: 0, amp: 0, ampTarget: 0 });
    }
  }

  private setSlewSeconds(sec: number): void {
    if (sec === this.lastSlewSec) return;
    this.lastSlewSec = sec;
    const sr = sampleRate;
    const samples = Math.max(1, sr * sec);
    this.ampCoef = 1 - Math.exp(-1 / samples);
    const hops = Math.max(1, samples / HOP_SIZE);
    this.freqCoefPerHop = 1 - Math.exp(-1 / hops);
  }

  /**
   * Run a full STFT analysis on the current circular buffer + update
   * peak list, F0 estimate, and the track bank's targets. Called once
   * per HOP_SIZE samples, NOT per sample.
   */
  private analyzeFrame(activePartials: number, harmonicLock: number): void {
    // 1) Linearize circular into fftRe, applying Hann window.
    for (let n = 0; n < FFT_SIZE; n++) {
      const src = (this.circularWrite + n) % FFT_SIZE;
      this.fftRe[n] = this.circular[src]! * HANN[n]!;
      this.fftIm[n] = 0;
    }
    inPlaceFFT(this.fftRe, this.fftIm);

    // 2) Magnitudes + total energy. Hann coherent gain 4/N → per-tone amplitude.
    const ampScale = 4 / FFT_SIZE;
    let maxMag = 0;
    let totalEnergy = 0;
    for (let b = 0; b < NUM_BINS; b++) {
      const re = this.fftRe[b]!;
      const im = this.fftIm[b]!;
      const m = Math.sqrt(re * re + im * im);
      this.mag[b] = m;
      if (m > maxMag) maxMag = m;
      totalEnergy += m;
    }

    // 3) Adaptive threshold — peaks must be at least -60 dB below the
    //    loudest bin. Below that they're noise / sidelobes and don't
    //    deserve a tracked oscillator.
    const thr = maxMag * 0.001; // -60 dB
    const binHz = sampleRate / FFT_SIZE;

    // 4) F0 detection via spectral harmonic sum (HSS). For each candidate
    //    F0 bin in [F0_LO_HZ, F0_HI_HZ], sum magnitudes at integer
    //    multiples weighted by 1/sqrt(k). Best candidate is F0; we measure
    //    its confidence as z-score against the whole candidate band.
    const binLo = Math.max(2, Math.ceil(F0_LO_HZ / binHz));
    const binHi = Math.min(
      Math.floor(NUM_BINS / F0_MAX_HARMONICS),
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
          if (hb >= NUM_BINS) break;
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
    // Confidence: z-score normalised by sqrt(log nScores). Pitched
    // material lands ~1.7..2.5; white noise ~1.0..1.2.
    let f0Hz = 0;
    let conf = 0;
    if (bestBin > 0 && nScores >= 2) {
      const mean = sumScores / nScores;
      const variance = sumSquares / nScores - mean * mean;
      const stddev = Math.sqrt(Math.max(0, variance) + 1e-12);
      const z = (bestScore - mean) / (stddev + 1e-12);
      const norm = Math.sqrt(Math.log(nScores + 1));
      conf = z / (norm + 1e-12);
      // Parabolic refine in log-magnitude space — sub-bin precision.
      const lm = Math.log(this.mag[bestBin]! + 1e-20);
      const lm1 = Math.log(this.mag[bestBin - 1]! + 1e-20);
      const lm2 = Math.log(this.mag[bestBin + 1]! + 1e-20);
      const denom = lm1 - 2 * lm + lm2;
      let delta = 0;
      if (Math.abs(denom) > 1e-12) delta = 0.5 * (lm1 - lm2) / denom;
      if (delta < -0.5) delta = -0.5;
      else if (delta > 0.5) delta = 0.5;
      f0Hz = (bestBin + delta) * binHz;
    }
    // Smooth F0 + confidence — short time constant (~30 ms in hops).
    const f0Smooth = 0.3;
    this.f0Conf += f0Smooth * (conf - this.f0Conf);
    if (conf > 1.4) {
      if (this.f0Hz <= 0) this.f0Hz = f0Hz;
      else this.f0Hz += f0Smooth * (f0Hz - this.f0Hz);
    } else if (this.f0Conf < 0.7) {
      this.f0Hz *= 1 - 0.5 * f0Smooth;
      if (this.f0Hz < 5) this.f0Hz = 0;
    }

    // 5) Peak detection — local maxima above threshold, parabolic-interp
    //    refined. Cap at activePartials; the brightest survive.
    this.numPeaks = 0;
    for (let b = 1; b < NUM_BINS - 1 && this.numPeaks < N_TRACKS; b++) {
      const m = this.mag[b]!;
      if (m < thr) continue;
      if (m < this.mag[b - 1]!) continue;
      if (m < this.mag[b + 1]!) continue;
      const lm = Math.log(m + 1e-20);
      const lm1 = Math.log(this.mag[b - 1]! + 1e-20);
      const lm2 = Math.log(this.mag[b + 1]! + 1e-20);
      const denom = lm1 - 2 * lm + lm2;
      let delta = 0;
      if (Math.abs(denom) > 1e-12) delta = 0.5 * (lm1 - lm2) / denom;
      if (delta < -0.5) delta = -0.5;
      else if (delta > 0.5) delta = 0.5;
      const vertexLm = lm - 0.25 * (lm1 - lm2) * delta;
      const refinedMag = Math.exp(vertexLm);
      this.peakHz[this.numPeaks] = (b + delta) * binHz;
      this.peakAmp[this.numPeaks] = refinedMag * ampScale;
      this.numPeaks++;
    }

    // 6) Cull to activePartials by amplitude (descending). Using an
    //    in-place insertion sort because numPeaks is small (≤N_TRACKS),
    //    and the cost is dwarfed by the FFT anyway.
    if (this.numPeaks > activePartials) {
      // Simple top-K selection: sort by amplitude descending, keep K.
      for (let i = 1; i < this.numPeaks; i++) {
        const hz = this.peakHz[i]!;
        const amp = this.peakAmp[i]!;
        let j = i - 1;
        while (j >= 0 && this.peakAmp[j]! < amp) {
          this.peakHz[j + 1] = this.peakHz[j]!;
          this.peakAmp[j + 1] = this.peakAmp[j]!;
          j--;
        }
        this.peakHz[j + 1] = hz;
        this.peakAmp[j + 1] = amp;
      }
      this.numPeaks = activePartials;
    }

    // 7) Harmonic lock — snap each surviving peak toward the nearest
    //    integer multiple of F0 by `morph * confidence-clip`. Only peaks
    //    within ~100 cents of a harmonic are eligible (otherwise we'd
    //    drag formant bins onto the comb and make ugly artefacts).
    if (harmonicLock > 1e-3 && this.f0Hz > 5) {
      const confNorm = Math.max(0, Math.min(1, (this.f0Conf - 1.3) / 1.1));
      const lock = harmonicLock * confNorm;
      if (lock > 1e-3) {
        for (let p = 0; p < this.numPeaks; p++) {
          const freq = this.peakHz[p]!;
          const k = Math.round(freq / this.f0Hz);
          if (k < 1) continue;
          const snappedHz = k * this.f0Hz;
          const relErr = Math.abs(freq - snappedHz) / freq;
          if (relErr > 0.06) continue;
          this.peakHz[p] = freq * (1 - lock) + snappedHz * lock;
        }
      }
    }

    // 8) Track matching — each peak finds its best existing track within
    //    5% relative Hz; matched tracks get freq + amp updates, unmatched
    //    peaks birth in a free slot, unmatched tracks have amp driven to 0.
    const matched = new Uint8Array(N_TRACKS); // re-allocates per hop, small (~64 bytes); fine
    for (let p = 0; p < this.numPeaks; p++) {
      const hz = this.peakHz[p]!;
      const amp = this.peakAmp[p]!;

      let bestIdx = -1;
      let bestDist = 0.05;
      for (let i = 0; i < N_TRACKS; i++) {
        const t = this.tracks[i]!;
        if (!t.alive || matched[i] || t.freq <= 0) continue;
        const rel = Math.abs(t.freq - hz) / Math.max(t.freq, hz);
        if (rel < bestDist) {
          bestDist = rel;
          bestIdx = i;
        }
      }

      if (bestIdx >= 0) {
        const t = this.tracks[bestIdx]!;
        t.freq += this.freqCoefPerHop * (hz - t.freq);
        t.ampTarget = amp;
        matched[bestIdx] = 1;
        continue;
      }

      // Birth in the first inactive slot.
      let birthIdx = -1;
      for (let i = 0; i < N_TRACKS; i++) {
        if (!this.tracks[i]!.alive) {
          birthIdx = i;
          break;
        }
      }
      if (birthIdx < 0) continue;
      const t = this.tracks[birthIdx]!;
      t.freq = hz;
      t.ampTarget = amp;
      // Don't reset amp / phase here — let the smoother glide from where
      // the slot's previous track was (no click at re-use); see Warren's
      // original SpectralResynth.cpp birthing logic for the same trick.
      t.alive = true;
      matched[birthIdx] = 1;
    }

    // Kill unmatched alive tracks (smoother drains them to zero).
    for (let i = 0; i < N_TRACKS; i++) {
      const t = this.tracks[i]!;
      if (t.alive && !matched[i]) {
        t.ampTarget = 0;
        t.alive = false;
      }
    }
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const out = outputs[0]?.[0];
    if (!out) return true;

    // input 0 = audio, input 1 = pitch (V/oct), input 2 = gate.
    const audioIn = inputs[0]?.[0] ?? null;
    const pitchIn = inputs[1]?.[0] ?? null;
    const gateIn = inputs[2]?.[0] ?? null;

    const modelArr = parameters.model;
    const harmArr = parameters.harmonics;
    const timbArr = parameters.timbre;
    const morphArr = parameters.morph;
    const levelArr = parameters.level;
    const noteArr = parameters.note;

    // Block-scoped pulls of the macros — for `a-rate` params we pull per
    // sample where it matters (model decision, level scale); for others
    // (harmonics, timbre, morph) the analyzer runs once per hop so a single
    // pull is correct.
    const harmBlock = harmArr[0]!;
    const timbBlock = timbArr[0]!;
    const morphBlock = morphArr[0]!;

    // Map timbre 0..1 → slew seconds 0.005..2.0 log-curve.
    const slewSec = 0.005 * Math.pow(400, Math.max(0, Math.min(1, timbBlock)));
    this.setSlewSeconds(slewSec);
    const activePartials = Math.max(
      1,
      Math.min(N_TRACKS, Math.round(harmBlock * N_TRACKS)),
    );
    const harmonicLock = Math.max(0, Math.min(1, morphBlock));

    const sr = sampleRate;
    const invSr = 1 / sr;
    const nyquist = 0.5 * sr;
    const aliasCutoff = nyquist * 0.85;
    const aliasRampStart = nyquist * 0.75;
    const aliasRampSpan = aliasCutoff - aliasRampStart;

    for (let i = 0; i < out.length; i++) {
      // 1) Push input into circular; run analysis on hop boundary.
      this.circular[this.circularWrite] = audioIn ? audioIn[i]! : 0;
      this.circularWrite = (this.circularWrite + 1) % FFT_SIZE;
      this.samplesSinceHop++;
      if (this.samplesSinceHop >= HOP_SIZE) {
        if (!this.frozen) this.analyzeFrame(activePartials, harmonicLock);
        this.samplesSinceHop = 0;
      }

      // 2) Gate rising edge toggles freeze. Latch behavior — a quick
      //    pulse on the gate flips the state. Mirrors the CallSine
      //    FREEZE button.
      const gate = gateIn ? gateIn[i]! : 0;
      if (gate >= 0.5 && this.lastGate < 0.5) {
        this.frozen = !this.frozen;
      }
      this.lastGate = gate;

      // 3) Pitch shift via V/oct + note offset. Each track's effective
      //    freq is t.freq × transposeRatio. We compute the ratio per
      //    sample (cheap) so smooth V/oct CV pitch-bends work.
      const pitchV = pitchIn ? pitchIn[i]! : 0;
      const note = noteArr.length > 1 ? noteArr[i]! : noteArr[0]!;
      const semitones = pitchV * 12 + note;
      const transposeRatio = Math.pow(2, semitones / 12);

      // 4) Pick model. a-rate so live model switching is sample-accurate.
      const modelF = modelArr.length > 1 ? modelArr[i]! : modelArr[0]!;
      const modelIdx = Math.max(0, Math.min(1, Math.round(modelF)));

      // 5) Render the bank.
      let sample = 0;
      for (let ti = 0; ti < N_TRACKS; ti++) {
        const t = this.tracks[ti]!;
        // Fast skip: dead AND already drained.
        if (!t.alive && t.amp < 1e-7 && t.ampTarget < 1e-9) continue;

        // Per-sample amplitude smoothing — silent tracks drain to zero
        // and skip on the next iteration.
        t.amp += this.ampCoef * (t.ampTarget - t.amp);

        const effFreq = t.freq * transposeRatio;
        if (effFreq > 0) {
          let p = t.phase + effFreq * invSr;
          if (p >= 1) p -= Math.floor(p);
          t.phase = p;
        }

        // Anti-alias ramp near Nyquist so polyBLEP saw / sine alike stay
        // clean even at extreme transpose.
        let aliasGain = 1;
        if (effFreq <= 0 || effFreq >= aliasCutoff) aliasGain = 0;
        else if (effFreq > aliasRampStart)
          aliasGain = (aliasCutoff - effFreq) / aliasRampSpan;

        if (aliasGain <= 0 || t.amp <= 1e-6) continue;

        const dt = effFreq * invSr;
        sample += t.amp * aliasGain * renderVoice(t.phase, dt, modelIdx);
      }

      const level = levelArr.length > 1 ? levelArr[i]! : levelArr[0]!;
      out[i] = sample * Math.max(0, Math.min(1, level));
    }

    return true;
  }
}

registerProcessor('callsine', CallsineProcessor);

// Pure-math mirror of analyzeFrame() + the per-sample render loop lives in
// packages/web/src/lib/audio/modules/callsine.ts (exported as
// `callsineMath`). Tests + ART scenarios drive that mirror — the worklet
// itself can't be imported from node because AudioWorkletProcessor is
// only present in AudioWorkletGlobalScope. Any algorithmic change here
// MUST be mirrored there.
