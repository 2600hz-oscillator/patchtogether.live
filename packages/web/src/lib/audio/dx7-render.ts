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
import {
  dx7LevelToAmp,
  dx7LevelToDb,
  dx7RateToDbPerSec,
  dx7EgAmpFromDb,
  dx7EgTick,
  dx7FixedHzFromRatio,
} from './dx7-syx';

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

  // Per-op patch state. MIRRORS the worklet's `applyPatch` exactly.
  const ops = voice.operators.map((op) => ({
    ratesDbPerSec: [
      dx7RateToDbPerSec(op.r[0]), dx7RateToDbPerSec(op.r[1]),
      dx7RateToDbPerSec(op.r[2]), dx7RateToDbPerSec(op.r[3]),
    ] as [number, number, number, number],
    levelsDb: [
      dx7LevelToDb(op.l[0]), dx7LevelToDb(op.l[1]),
      dx7LevelToDb(op.l[2]), dx7LevelToDb(op.l[3]),
    ] as [number, number, number, number],
    ratio: op.ratio,
    detuneFactor: op.detuneFactor,
    fixedMode: op.fixedMode,
    fixedHz:
      typeof op.fixedHz === 'number' && Number.isFinite(op.fixedHz) && op.fixedHz > 0
        ? op.fixedHz
        : dx7FixedHzFromRatio(op.ratio),
    outputAmp: dx7LevelToAmp(op.level),
  }));

  const fbAmount = voice.feedback / 7;
  const hz = C4_HZ * Math.pow(2, (opts.midi - 60) / 12);

  // Per-op state. `envDb` is the authoritative envelope state (Float64 —
  // see dx7EgTick); `envValue` is the derived linear amplitude.
  const phase = new Float64Array(6);
  const envDb = new Float64Array(6);
  const envValue = new Float32Array(6);
  const envSeg = new Int32Array(6);
  const opOut = new Float32Array(6);
  let fbMem = 0;
  let releasing = false;

  // The DX7 envelope IDLES at L4 — the same level the release lands on.
  for (let k = 0; k < 6; k++) {
    envDb[k] = ops[k]!.levelsDb[3];
    envValue[k] = dx7EgAmpFromDb(envDb[k]!);
  }

  const releaseAtSample = opts.holdGate === false ? Math.floor(totalSamples / 2) : totalSamples + 1;

  for (let i = 0; i < totalSamples; i++) {
    if (i === releaseAtSample) {
      releasing = true;
      for (let k = 0; k < 6; k++) envSeg[k] = 3;
    }

    // Update envelopes. Segments 0..2 run while the gate is high; reaching 3
    // with the gate still high HOLDS at L3 until `releasing`.
    for (let opIdx = 0; opIdx < 6; opIdx++) {
      const op = ops[opIdx]!;
      dx7EgTick(envDb, envSeg, opIdx, op.levelsDb, op.ratesDbPerSec, releasing, dt);
      envValue[opIdx] = dx7EgAmpFromDb(envDb[opIdx]!);
    }

    // Render ops in op1..op6 order. Modulators sourced from this-block (for
    // ops < current) or 1-sample-delayed (for ops ≥ current).
    for (let opIdx = 0; opIdx < 6; opIdx++) {
      const op = ops[opIdx]!;
      let modIn = 0;
      const srcs = algo.modSrcs[opIdx]!;
      for (let s = 0; s < srcs.length; s++) {
        modIn += opOut[srcs[s]!]!;
      }
      // The feedback path, which is PER-ALGORITHM: inject the loop memory into
      // the op the DX7 chart wires it to (op6 in most algorithms, but
      // op2/op3/op4/op5 in others; algorithms 4 and 6 are multi-operator loops
      // whose memory is sourced from op4 / op5 respectively).
      if (opIdx === algo.feedback.to && fbAmount > 0) {
        modIn += fbMem * fbAmount;
      }

      // FIXED mode ignores the note pitch, the ratio table AND detune.
      const opHz = op.fixedMode ? op.fixedHz : hz * op.ratio * op.detuneFactor;
      phase[opIdx] = (phase[opIdx]! + opHz * dt) % 1;
      const ph = phase[opIdx]! * TWO_PI + modIn * Math.PI;
      const sample = Math.sin(ph) * envValue[opIdx]! * op.outputAmp;
      opOut[opIdx] = sample;
    }
    fbMem = (fbMem + opOut[algo.feedback.from]!) * 0.5;

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
