// packages/web/src/lib/electra/curve.ts
//
// Curve-aware value ↔ 7-bit CC mapping, shared by the preset generator
// (control range + formatter selection), the feedback pump (param value → CC),
// and the inbound dispatch (CC → param value).
//
// This MIRRORS Knob.svelte's valueToFrac / fracToValue so a knob turned on the
// device lands at the same position the on-screen knob would. midi-learn's
// ccValueToParamValue is LINEAR-only (a known limitation called out in the
// integration plan); these helpers respect the param's declared curve so a log
// param like TIMELORDE bpm (10..300) maps correctly. (The opportunistic
// curve-aware ccValueToParamValue upgrade in midi-learn can later delegate here.)

import type { KnobCurve } from '$lib/graph/types';

/** value → normalized [0,1] honoring the curve (mirror of Knob.valueToFrac). */
export function valueToFrac(v: number, min: number, max: number, curve: KnobCurve): number {
  const clamped = Math.max(min, Math.min(max, v));
  if (curve === 'log') {
    if (min <= 0 || max <= 0) return safeLinFrac(clamped, min, max);
    return Math.log(clamped / min) / Math.log(max / min);
  }
  if (curve === 'exp') {
    const frac = safeLinFrac(clamped, min, max);
    return frac * frac;
  }
  // linear + discrete both map linearly across the range.
  return safeLinFrac(clamped, min, max);
}

/** normalized [0,1] → value honoring the curve (mirror of Knob.fracToValue). */
export function fracToValue(f: number, min: number, max: number, curve: KnobCurve): number {
  const fr = Math.max(0, Math.min(1, f));
  if (curve === 'log') {
    if (min <= 0 || max <= 0) return min + fr * (max - min);
    return min * Math.pow(max / min, fr);
  }
  if (curve === 'exp') {
    return min + Math.sqrt(fr) * (max - min);
  }
  if (curve === 'discrete') {
    // Snap to the nearest integer step in [min,max].
    return Math.round(min + fr * (max - min));
  }
  return min + fr * (max - min);
}

function safeLinFrac(v: number, min: number, max: number): number {
  if (max === min) return 0;
  return (v - min) / (max - min);
}

/** Param value → 7-bit CC (0..127), curve-aware. */
export function valueToCc7(v: number, min: number, max: number, curve: KnobCurve): number {
  const frac = valueToFrac(v, min, max, curve);
  return Math.max(0, Math.min(127, Math.round(frac * 127)));
}

/** 7-bit CC (0..127) → param value, curve-aware. The inverse of valueToCc7
 *  (up to the 7-bit quantization). */
export function cc7ToValue(cc: number, min: number, max: number, curve: KnobCurve): number {
  const frac = Math.max(0, Math.min(127, cc)) / 127;
  return fracToValue(frac, min, max, curve);
}

/** dB value → a normalized level CC for a read-only VU vfader. dBFS in
 *  [floorDb, 0] maps linearly to 0..127. Below floorDb clamps to 0. */
export function dbToMeterCc(db: number, floorDb = -60): number {
  if (!Number.isFinite(db)) return 0;
  const frac = (db - floorDb) / (0 - floorDb);
  return Math.max(0, Math.min(127, Math.round(frac * 127)));
}

/** RMS amplitude (0..1, linear) → dBFS. -Infinity guarded to a floor. */
export function ampToDb(amp: number, floorDb = -60): number {
  if (amp <= 0) return floorDb;
  const db = 20 * Math.log10(amp);
  return db < floorDb ? floorDb : db;
}

/** Linear RMS amplitude → meter CC (0..127), via dBFS. The full app→device
 *  VU path for a per-channel level. */
export function ampToMeterCc(amp: number, floorDb = -60): number {
  return dbToMeterCc(ampToDb(amp, floorDb), floorDb);
}

/** RMS over a time-domain sample window (mirror of scope.ts/engine RMS). */
export function rmsOf(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!;
    sum += s * s;
  }
  return samples.length ? Math.sqrt(sum / samples.length) : 0;
}
