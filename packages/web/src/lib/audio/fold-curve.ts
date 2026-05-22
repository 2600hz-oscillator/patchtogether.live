// packages/web/src/lib/audio/fold-curve.ts
//
// West-Coast (Buchla)-style sin-foldback curve for WaveShaperNode.curve.
// Shared by WAVVIZ and SWOLEVCO; also pinned by the wavefolder ART
// scenario. Originally lived inside vizvco.ts before that module was
// removed — extracted here so the remaining consumers don't depend on a
// deleted module.

/** Wavefolder curve length. 4096 keeps the LUT fine-grained enough that
 *  the LINEAR interp WaveShaperNode does between samples is inaudible at
 *  audio rates. */
const FOLD_CURVE_LEN = 4096;

/**
 * Build a wavefolder curve at the given fold amount.
 *  - fold = 0  → identity (out = in)
 *  - fold > 0 → out = sin(in * π * (1 + fold * 4)) (West-Coast voltage)
 *
 * Returned as `Float32Array<ArrayBuffer>` (not the default
 * `ArrayBufferLike`) so the result is directly assignable to
 * WaveShaperNode.curve (TS's strict typed-array signature).
 */
export function buildFoldCurve(fold: number): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(new ArrayBuffer(FOLD_CURVE_LEN * 4));
  const k = 1 + fold * 4;
  for (let i = 0; i < FOLD_CURVE_LEN; i++) {
    const x = (i / (FOLD_CURVE_LEN - 1)) * 2 - 1; // [-1, 1]
    if (fold <= 0) {
      curve[i] = x;
    } else {
      curve[i] = Math.sin(x * Math.PI * k);
    }
  }
  return curve;
}
