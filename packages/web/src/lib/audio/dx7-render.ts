// packages/web/src/lib/audio/dx7-render.ts
//
// Pure-TS DX7 voice renderer mirroring the worklet's algorithm. The web
// workspace owns the voice + preset definitions, so this renderer is the
// authoritative spec for what the worklet should produce. Used by ART
// tests for spectral validation without needing a full AudioWorklet
// runtime in node.
//
// SYNC PARTNER: packages/dsp/src/dx7.ts. Any change to the render math
// here must be ported there — otherwise the worklet drifts from the ART
// expectations. The host-only helpers (goertzel, hann, midiToHz, rms)
// at the bottom of this file are test-only and have no worklet sibling.

import type { DX7Voice } from './dx7-syx';
import { DX7_ALGORITHMS } from './dx7-algorithms';
import { dx7RateToCoef, dx7LevelToAmp } from './dx7-syx';

const TWO_PI = Math.PI * 2;
const C4_HZ = 261.625565;

interface RenderOptions {
  /** MIDI note to play (gate is held throughout). */
  midi: number;
  /** Render duration in seconds. */
  durationS: number;
  sampleRate?: number;
  /** When true, hold gate open the whole time. When false, drop gate halfway. */
  holdGate?: boolean;
  /** When set, override the preset's algorithm (for algo-knob testing). */
  algorithmOverride?: number;
}

/**
 * Render one note of the given DX7Voice patch and return the audio samples.
 * Single-voice (no polyphony — that's covered separately).
 */
export function renderDx7Note(voice: DX7Voice, opts: RenderOptions): Float32Array {
  const sr = opts.sampleRate ?? 48000;
  const totalSamples = Math.round(opts.durationS * sr);
  const dt = 1 / sr;
  const out = new Float32Array(totalSamples);

  const algo = DX7_ALGORITHMS[Math.max(0, Math.min(31, (opts.algorithmOverride ?? voice.algorithm) - 1))]!;

  // Per-op patch state.
  const ops = voice.operators.map((op) => ({
    rateCoefs: [
      dx7RateToCoef(op.r[0]), dx7RateToCoef(op.r[1]),
      dx7RateToCoef(op.r[2]), dx7RateToCoef(op.r[3]),
    ] as [number, number, number, number],
    levels: [
      dx7LevelToAmp(op.l[0]), dx7LevelToAmp(op.l[1]),
      dx7LevelToAmp(op.l[2]), dx7LevelToAmp(op.l[3]),
    ] as [number, number, number, number],
    ratio: op.ratio,
    detuneFactor: op.detuneFactor,
    fixedMode: op.fixedMode,
    outputAmp: dx7LevelToAmp(op.level),
  }));

  const fbAmount = voice.feedback / 7;
  const hz = C4_HZ * Math.pow(2, (opts.midi - 60) / 12);

  // Per-op state.
  const phase = new Float64Array(6);
  const envValue = new Float32Array(6);
  const envSeg = new Int32Array(6);
  const opOut = new Float32Array(6);
  let fbMem = 0;
  let releasing = false;

  const releaseAtSample = opts.holdGate === false ? Math.floor(totalSamples / 2) : totalSamples + 1;

  for (let i = 0; i < totalSamples; i++) {
    if (i === releaseAtSample) {
      releasing = true;
      for (let k = 0; k < 6; k++) envSeg[k] = 3;
    }

    // Update envelopes.
    for (let opIdx = 0; opIdx < 6; opIdx++) {
      const op = ops[opIdx]!;
      const seg = envSeg[opIdx]!;
      const target = op.levels[seg]!;
      const coef = op.rateCoefs[seg]!;
      const cur = envValue[opIdx]!;
      const k = 1 - Math.exp(-coef * dt);
      const next = cur + (target - cur) * k;
      envValue[opIdx] = next;
      if (seg < 3) {
        const diff = Math.abs(target - next);
        const range = Math.max(1e-6, Math.max(target, cur));
        if (diff / range < 0.01) envSeg[opIdx] = seg + 1;
      }
    }

    // Render ops in op1..op6 order. Modulators sourced from this-block (for
    // ops < current) or 1-sample-delayed (for ops ≥ current).
    for (let opIdx = 0; opIdx < 6; opIdx++) {
      const op = ops[opIdx]!;
      let modIn = 0;
      const srcs = algo.modSrcs[opIdx]!;
      for (let s = 0; s < srcs.length; s++) {
        const src = srcs[s]!;
        if (src === opIdx) {
          modIn += fbMem * fbAmount;
        } else {
          modIn += opOut[src]!;
        }
      }
      // Op6 self-feedback (when not already in srcs).
      if (opIdx === 5 && srcs.indexOf(opIdx) < 0 && fbAmount > 0) {
        modIn += fbMem * fbAmount;
      }

      const opHz = op.fixedMode ? op.ratio * C4_HZ : hz * op.ratio * op.detuneFactor;
      phase[opIdx] = (phase[opIdx]! + opHz * dt) % 1;
      const ph = phase[opIdx]! * TWO_PI + modIn * Math.PI;
      const sample = Math.sin(ph) * envValue[opIdx]! * op.outputAmp;
      opOut[opIdx] = sample;
    }
    fbMem = (fbMem + opOut[5]!) * 0.5;

    // Sum carriers.
    let voiceOut = 0;
    for (const c of algo.carriers) voiceOut += opOut[c]!;
    out[i] = voiceOut * 0.4; // matches the worklet's mix attenuation

    // Single-voice renderer — no per-block voice activation/deactivation
    // (that's the worklet's allocator; here we render exactly one note for
    // ART). Release short-circuits below once envValue ~ 0.
    if (releasing) {
      let total = 0;
      for (let k = 0; k < 6; k++) total += envValue[k]!;
      if (total < 0.0001) {
        // Quietly fill the rest with zeros.
        for (let j = i + 1; j < totalSamples; j++) out[j] = 0;
        break;
      }
    }
  }

  return out;
}

// ---------------- Spectral helpers (test-only) ----------------

/** Goertzel single-bin power. Returns the squared magnitude at targetFreq. */
export function goertzel(samples: Float32Array, sr: number, targetFreq: number): number {
  const N = samples.length;
  const k = (N * targetFreq) / sr;
  const omega = (TWO_PI * k) / N;
  const cosine = Math.cos(omega);
  const coeff = 2 * cosine;
  let q1 = 0;
  let q2 = 0;
  for (let i = 0; i < N; i++) {
    const q0 = coeff * q1 - q2 + samples[i]!;
    q2 = q1;
    q1 = q0;
  }
  return q1 * q1 + q2 * q2 - q1 * q2 * coeff;
}

/** RMS energy of a buffer. */
export function rms(buf: Float32Array): number {
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i]! * buf[i]!;
  return Math.sqrt(s / buf.length);
}

/** Hann window (returns a new buffer; doesn't mutate input). */
export function hann(buf: Float32Array): Float32Array {
  const n = buf.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const w = 0.5 * (1 - Math.cos((TWO_PI * i) / (n - 1)));
    out[i] = buf[i]! * w;
  }
  return out;
}

/** MIDI → Hz (A4 = 440). */
export function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}
