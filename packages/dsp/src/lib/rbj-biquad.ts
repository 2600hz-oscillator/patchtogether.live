// packages/dsp/src/lib/rbj-biquad.ts
//
// OWN-CODE RBJ biquads (Robert Bristow-Johnson's Audio EQ Cookbook — public-
// domain formulas, re-derived here; deliberately NOT resofilter-dsp.ts, which
// is a GPL Resonarium port and firewalled from permissive modules — see the
// kick plan's provenance section). Shared by the kick voice's EQ and any
// future own-code filter stage.
//
// Style: explicit state objects + per-sample steps (DSP-core discipline).
// Coefficients are cached inside the state and recomputed only when the
// controlling parameters change, so a per-sample caller with static knobs
// pays one comparison, not transcendental math.

export interface Biquad {
  // Direct-form-1 coefficients (a0-normalized).
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
  // State.
  x1: number;
  x2: number;
  y1: number;
  y2: number;
  // Coefficient cache key (params packed by the updater).
  k1: number;
  k2: number;
}

export function makeBiquad(): Biquad {
  return { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0, x1: 0, x2: 0, y1: 0, y2: 0, k1: NaN, k2: NaN };
}

const FLUSH = 1e-20;

/** One DF1 sample. */
export function biquadStep(bq: Biquad, x: number): number {
  const y = bq.b0 * x + bq.b1 * bq.x1 + bq.b2 * bq.x2 - bq.a1 * bq.y1 - bq.a2 * bq.y2;
  bq.x2 = bq.x1;
  bq.x1 = x;
  bq.y2 = bq.y1;
  bq.y1 = Math.abs(y) < FLUSH ? 0 : y;
  return bq.y1;
}

export function resetBiquad(bq: Biquad): void {
  bq.x1 = 0;
  bq.x2 = 0;
  bq.y1 = 0;
  bq.y2 = 0;
}

/** Peaking EQ: `dbGain` at `fc`, bandwidth via Q. */
export function updatePeaking(bq: Biquad, fc: number, dbGain: number, Q: number, sr: number): void {
  if (bq.k1 === fc && bq.k2 === dbGain) return;
  bq.k1 = fc;
  bq.k2 = dbGain;
  const A = Math.pow(10, dbGain / 40);
  const w0 = (2 * Math.PI * Math.min(fc, sr * 0.45)) / sr;
  const alpha = Math.sin(w0) / (2 * Q);
  const cw = Math.cos(w0);
  const a0 = 1 + alpha / A;
  bq.b0 = (1 + alpha * A) / a0;
  bq.b1 = (-2 * cw) / a0;
  bq.b2 = (1 - alpha * A) / a0;
  bq.a1 = (-2 * cw) / a0;
  bq.a2 = (1 - alpha / A) / a0;
}

/** Low shelf: `dbGain` below `fc` (S = 1). */
export function updateLowShelf(bq: Biquad, fc: number, dbGain: number, sr: number): void {
  if (bq.k1 === fc && bq.k2 === dbGain) return;
  bq.k1 = fc;
  bq.k2 = dbGain;
  const A = Math.pow(10, dbGain / 40);
  const w0 = (2 * Math.PI * Math.min(fc, sr * 0.45)) / sr;
  const cw = Math.cos(w0);
  const alpha = (Math.sin(w0) / 2) * Math.SQRT2; // S = 1
  const twoRootAalpha = 2 * Math.sqrt(A) * alpha;
  const a0 = A + 1 + (A - 1) * cw + twoRootAalpha;
  bq.b0 = (A * (A + 1 - (A - 1) * cw + twoRootAalpha)) / a0;
  bq.b1 = (2 * A * (A - 1 - (A + 1) * cw)) / a0;
  bq.b2 = (A * (A + 1 - (A - 1) * cw - twoRootAalpha)) / a0;
  bq.a1 = (-2 * (A - 1 + (A + 1) * cw)) / a0;
  bq.a2 = (A + 1 + (A - 1) * cw - twoRootAalpha) / a0;
}

/** High shelf: `dbGain` above `fc` (S = 1). */
export function updateHighShelf(bq: Biquad, fc: number, dbGain: number, sr: number): void {
  if (bq.k1 === fc && bq.k2 === dbGain) return;
  bq.k1 = fc;
  bq.k2 = dbGain;
  const A = Math.pow(10, dbGain / 40);
  const w0 = (2 * Math.PI * Math.min(fc, sr * 0.45)) / sr;
  const cw = Math.cos(w0);
  const alpha = (Math.sin(w0) / 2) * Math.SQRT2;
  const twoRootAalpha = 2 * Math.sqrt(A) * alpha;
  const a0 = A + 1 - (A - 1) * cw + twoRootAalpha;
  bq.b0 = (A * (A + 1 + (A - 1) * cw + twoRootAalpha)) / a0;
  bq.b1 = (-2 * A * (A - 1 + (A + 1) * cw)) / a0;
  bq.b2 = (A * (A + 1 + (A - 1) * cw - twoRootAalpha)) / a0;
  bq.a1 = (2 * (A - 1 - (A + 1) * cw)) / a0;
  bq.a2 = (A + 1 - (A - 1) * cw - twoRootAalpha) / a0;
}

/** 2nd-order Butterworth-style highpass (Q defaults to 1/√2). */
export function updateHighpass(bq: Biquad, fc: number, sr: number, Q = Math.SQRT1_2): void {
  if (bq.k1 === fc && bq.k2 === Q) return;
  bq.k1 = fc;
  bq.k2 = Q;
  const w0 = (2 * Math.PI * Math.min(fc, sr * 0.45)) / sr;
  const cw = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Q);
  const a0 = 1 + alpha;
  bq.b0 = (1 + cw) / 2 / a0;
  bq.b1 = -(1 + cw) / a0;
  bq.b2 = (1 + cw) / 2 / a0;
  bq.a1 = (-2 * cw) / a0;
  bq.a2 = (1 - alpha) / a0;
}

/** 2nd-order lowpass (Q defaults to 1/√2). */
export function updateLowpass(bq: Biquad, fc: number, sr: number, Q = Math.SQRT1_2): void {
  if (bq.k1 === fc && bq.k2 === Q) return;
  bq.k1 = fc;
  bq.k2 = Q;
  const w0 = (2 * Math.PI * Math.min(fc, sr * 0.45)) / sr;
  const cw = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Q);
  const a0 = 1 + alpha;
  bq.b0 = (1 - cw) / 2 / a0;
  bq.b1 = (1 - cw) / a0;
  bq.b2 = (1 - cw) / 2 / a0;
  bq.a1 = (-2 * cw) / a0;
  bq.a2 = (1 - alpha) / a0;
}
