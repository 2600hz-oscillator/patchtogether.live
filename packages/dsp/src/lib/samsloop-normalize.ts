// SAMSLOOP "normalize" core — DC removal then sample-peak normalisation.
//
// OWN CODE — CLEAN-ROOM (docs/adr/018 provenance posture). The two-step ORDER
// (remove the offset, then scale the extent) is the published Audacity
// Normalize behaviour and the technique every sampler ships; nothing here is
// a port of Audacity (GPL) or SoX (GPL) source.
//
// Owner ruling 2026-09-15: the target is 0 dBFS — the sample peak lands on
// exactly ±1.0, not the −1 dBFS graph ceiling the designs recommended.
//
// Semantics, in the order they run:
//   1. Refuse if any sample is non-finite (nothing written).
//   2. mean = Σx / L (Float64 accumulation). extent = max |x − mean|
//      (Audacity's order: the offset first, then the extent AFTER it).
//   3. extent == 0 → 'silent' (a constant buffer, DC or digital zero).
//      |mean| < NORMALIZE_DC_EPS AND |1 − extent| < NORMALIZE_FULL_SCALE_EPS →
//      'already-full-scale' (nothing to do). A DC-offset buffer whose extent
//      is already 1.0 is NOT refused: removing the offset is the change.
//   4. y = (x − mean) / extent, in ONE pass. DIVISION, not `× (1/extent)`:
//      a/a is exactly 1 in IEEE arithmetic and every |x − mean| ≤ extent
//      divides to ≤ 1, so the peak is exactly ±1.0 after the float32 store —
//      the `× reciprocal` form can round the peak to 1.0000001.
//
// Sample-peak is the right statistic INSIDE this graph: the worklet plays the
// buffer through linear interpolation (a convex combination never exceeds the
// buffer's sample peak) and the terminal sink is the −1 dBFS look-ahead
// limiter. Documented limitation: one click sets the gain — a single-sample
// spike in a quiet take is the peak, and this is what peak-normalise means.

export const NORMALIZE_TARGET = 1.0;
/** |mean| below this counts as "no offset" for the already-full-scale test. */
export const NORMALIZE_DC_EPS = 1e-6;
/** |1 − extent| below this is already full scale (float32 ulp at 1.0 is 6e-8). */
export const NORMALIZE_FULL_SCALE_EPS = 1e-6;

export type NormalizeResult =
  | { ok: true; dcOffset: number; peakBefore: number; gainDb: number }
  | { ok: false; reason: 'silent' | 'already-full-scale' | 'not-finite' };

/** In place. O(1) extra memory. On `ok: false` the buffer is untouched. */
export function normalizeSample(x: Float32Array): NormalizeResult {
  const len = x.length;
  if (len === 0) return { ok: false, reason: 'silent' };
  let sum = 0;
  for (let i = 0; i < len; i++) {
    const v = x[i]!;
    if (!Number.isFinite(v)) return { ok: false, reason: 'not-finite' };
    sum += v;
  }
  const mean = sum / len;
  let extent = 0;
  for (let i = 0; i < len; i++) {
    const d = Math.abs(x[i]! - mean);
    if (d > extent) extent = d;
  }
  if (extent === 0) return { ok: false, reason: 'silent' };
  if (Math.abs(mean) < NORMALIZE_DC_EPS && Math.abs(NORMALIZE_TARGET - extent) < NORMALIZE_FULL_SCALE_EPS) {
    return { ok: false, reason: 'already-full-scale' };
  }
  for (let i = 0; i < len; i++) x[i] = ((x[i]! - mean) * NORMALIZE_TARGET) / extent;
  return { ok: true, dcOffset: mean, peakBefore: extent, gainDb: 20 * Math.log10(NORMALIZE_TARGET / extent) };
}
