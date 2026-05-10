// packages/web/src/lib/audio/pitch-detect.ts
//
// YIN pitch detector (de Cheveigné & Kawahara 2002).
//
// Why YIN over plain autocorrelation: real instrument tones (and the project's
// own ANALOGVCO/WAVETABLEVCO/DX7 voices) carry rich harmonic content. Bare
// autocorrelation often locks onto an octave-up harmonic instead of the
// fundamental; YIN's cumulative-mean-normalized difference function plus a
// confidence threshold reliably picks the lowest tau corresponding to the
// fundamental period.
//
// Used by SCOPE's pitch tuner readout. Pure data — no Web Audio dependency.
// Source: http://audition.ens.fr/adc/pdf/2002_JASA_YIN.pdf

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

export interface PitchResult {
  /** Detected fundamental in Hz, or null if no pitched signal was detected. */
  hz: number | null;
  /** Closest equal-temperament note name (e.g. "A4"), or null. */
  note: string | null;
  /** Cents offset from the closest note: -50..+50, or null. */
  cents: number | null;
  /** YIN confidence: cmnd[bestTau]. Lower = more confident. null when no period found. */
  confidence: number | null;
}

const EMPTY: PitchResult = { hz: null, note: null, cents: null, confidence: null };

export interface YinOptions {
  /** Threshold on the cumulative-mean-normalized difference function. 0.10–0.20 typical. */
  threshold?: number;
  /** Minimum frequency to detect (Hz). Trims the tau search range. */
  minHz?: number;
  /** Maximum frequency to detect (Hz). */
  maxHz?: number;
}

/**
 * Run YIN on a single Float32Array buffer at the given sample rate.
 * Returns null hz when the signal is too quiet, too noisy, or has no clear
 * periodic component (cmnd never crosses the threshold).
 */
export function detectPitch(
  buffer: Float32Array,
  sampleRate: number,
  opts: YinOptions = {},
): PitchResult {
  const threshold = opts.threshold ?? 0.15;
  const minHz = opts.minHz ?? 50;
  const maxHz = opts.maxHz ?? 4000;

  const N = buffer.length;
  if (N < 64) return EMPTY;

  // Quick energy gate. Pure silence and clipped DC offsets give degenerate YIN
  // results; cheaper to short-circuit on RMS than to chase NaNs through cmnd.
  let energy = 0;
  for (let i = 0; i < N; i++) energy += buffer[i]! * buffer[i]!;
  const rms = Math.sqrt(energy / N);
  if (rms < 0.001) return EMPTY;

  const halfN = Math.floor(N / 2);
  const tauMin = Math.max(2, Math.floor(sampleRate / maxHz));
  const tauMax = Math.min(halfN - 1, Math.ceil(sampleRate / minHz));
  if (tauMax <= tauMin) return EMPTY;

  // Step 1+2: difference function d(tau).
  const d = new Float32Array(tauMax + 1);
  for (let tau = 1; tau <= tauMax; tau++) {
    let sum = 0;
    for (let j = 0; j < halfN; j++) {
      const delta = buffer[j]! - buffer[j + tau]!;
      sum += delta * delta;
    }
    d[tau] = sum;
  }

  // Step 3: cumulative-mean-normalized difference d'(tau).
  const cmnd = new Float32Array(tauMax + 1);
  cmnd[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= tauMax; tau++) {
    running += d[tau]!;
    cmnd[tau] = (d[tau]! * tau) / Math.max(running, 1e-12);
  }

  // Step 4: absolute threshold. Find the first local minimum below `threshold`.
  let bestTau = -1;
  for (let tau = tauMin; tau <= tauMax; tau++) {
    if (cmnd[tau]! < threshold) {
      // Walk down to the local minimum.
      while (tau + 1 <= tauMax && cmnd[tau + 1]! < cmnd[tau]!) tau++;
      bestTau = tau;
      break;
    }
  }
  if (bestTau < 0) return EMPTY;

  // Step 5: parabolic interpolation around bestTau for sub-sample period.
  const x0 = bestTau > tauMin ? bestTau - 1 : bestTau;
  const x2 = bestTau < tauMax ? bestTau + 1 : bestTau;
  let refined: number;
  if (x0 === bestTau) {
    refined = cmnd[bestTau]! <= cmnd[x2]! ? bestTau : x2;
  } else if (x2 === bestTau) {
    refined = cmnd[bestTau]! <= cmnd[x0]! ? bestTau : x0;
  } else {
    const s0 = cmnd[x0]!;
    const s1 = cmnd[bestTau]!;
    const s2 = cmnd[x2]!;
    const denom = 2 * (2 * s1 - s2 - s0);
    refined = denom !== 0 ? bestTau + (s2 - s0) / denom : bestTau;
  }

  const hz = sampleRate / refined;
  if (!Number.isFinite(hz) || hz < minHz || hz > maxHz) return EMPTY;

  const { note, cents } = hzToNoteCents(hz);
  return { hz, note, cents, confidence: cmnd[bestTau]! };
}

/** Hz → ("A4", -3.2 cents) tuple. Equal-tempered, A4 = 440. */
export function hzToNoteCents(hz: number): { note: string; cents: number } {
  const midi = 12 * Math.log2(hz / 440) + 69;
  const nearest = Math.round(midi);
  const cents = (midi - nearest) * 100;
  const name = NOTE_NAMES[((nearest % 12) + 12) % 12]!;
  const octave = Math.floor(nearest / 12) - 1;
  return { note: `${name}${octave}`, cents };
}
