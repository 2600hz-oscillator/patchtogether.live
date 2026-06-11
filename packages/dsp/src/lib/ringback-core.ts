// packages/dsp/src/lib/ringback-core.ts
//
// RINGBACK — the twotracks record-time crush, extracted and made intentional.
//
// The artifact: while TWOTRACKS fresh-records, it writes the live input into
// INTEGER ring-buffer cells (sample-quantized) at a fractional, varispeed
// write/read cursor, then reads those same cells back with LINEAR INTERPOLATION
// at the fractional cursor. The integer-cell write vs. fractional interp read
// makes the read-back a decimated, aliased copy of the input — a metallic
// "bitcrushed" tone. TWOTRACKS no longer sums that read-back into its monitor
// (that was a bug); RINGBACK packages the EXACT same mechanism as a deliberate
// stereo effect.
//
// Per channel (L + R), per sample:
//   1. read  = readInterp(buf, cursor)            // fractional interp read-back
//   2. write buf cells [cursor, cursor+rate) = in + feedback*read   // int cells
//   3. wet   = read
//   4. out   = (1-mix)*in + mix*wet
//   cursor  += rate (wraps over the small ring)
//
// Controls (all derive directly from the mechanism):
//   • RATE      — the write/read cursor advance per sample. The mismatch between
//                 the integer-quantized write span and the interpolated read is
//                 the crush. rate=1 = mildest; rate≠1 (esp. <1) stair-steps and
//                 aliases hardest. This is the "amount/depth" of the artifact.
//   • SIZE      — ring length in samples (a few → comb/ring resonance; larger →
//                 a short grainy delay-ish smear). The "ring" in ringback.
//   • FEEDBACK  — how much of the read-back is summed back into the cell on
//                 write (the "buffer/feedback issue" the owner suspected),
//                 building the metallic ring. Clamped < 1 so it can't blow up.
//   • MIX       — dry/wet between the clean input and the crushed read-back.
//
// This core is PURE + deterministic (no RNG, no time) so vitest/ART/VRT can pin
// it. The worklet (../ringback.ts) imports + runs THIS code — no mirror, no
// drift, same discipline as twotracks-engine.ts.

/** Min/max ring size in samples. Small enough to ring, big enough to smear. */
export const RINGBACK_MIN_SIZE = 2;
export const RINGBACK_MAX_SIZE = 4096;

/** Feedback is clamped strictly below 1 so the ring can't self-amplify to ∞. */
export const RINGBACK_MAX_FEEDBACK = 0.98;

/** Linear-interpolated read from a ring buffer at a fractional position. Wraps
 *  modulo `size` so the read head is always inside the live ring. */
export function ringRead(buf: Float32Array, pos: number, size: number): number {
  const n = size <= 0 ? 0 : size > buf.length ? buf.length : size;
  if (n === 0) return 0;
  // wrap pos into [0, n)
  let p = pos % n;
  if (p < 0) p += n;
  const i = Math.floor(p);
  const f = p - i;
  const a = buf[i] ?? 0;
  const b = buf[(i + 1) % n] ?? 0;
  return a + (b - a) * f;
}

/**
 * Write `value` across the INTEGER cells the head sweeps from `from`→`to`
 * (varispeed span-fill, the recordSpan mechanism), wrapping modulo `size`.
 * Sample-quantized: |rate|>1 smears across several cells; |rate|<1 lands the
 * value on the shared cell. This quantization (vs. the interp read) is the
 * crush. Mutates `buf` in place.
 */
export function ringWriteSpan(
  buf: Float32Array,
  from: number,
  to: number,
  value: number,
  size: number,
): void {
  const n = size <= 0 ? 0 : size > buf.length ? buf.length : size;
  if (n === 0) return;
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  let p = Math.floor(lo);
  // Always write at least the starting cell (covers |rate|<1 and rate≈0).
  const end = Math.max(Math.ceil(hi), p + 1);
  for (; p < end; p++) {
    let c = p % n;
    if (c < 0) c += n;
    buf[c] = value;
  }
}

/** Clamp a ring SIZE (samples) into the supported range, integer. */
export function clampSize(size: number): number {
  const s = Math.round(size);
  return s < RINGBACK_MIN_SIZE ? RINGBACK_MIN_SIZE : s > RINGBACK_MAX_SIZE ? RINGBACK_MAX_SIZE : s;
}

/** Clamp FEEDBACK to [0, RINGBACK_MAX_FEEDBACK] (no runaway). */
export function clampFeedback(fb: number): number {
  return fb < 0 ? 0 : fb > RINGBACK_MAX_FEEDBACK ? RINGBACK_MAX_FEEDBACK : fb;
}

/** Clamp MIX (dry/wet) to [0, 1]. */
export function clampMix(mix: number): number {
  return mix < 0 ? 0 : mix > 1 ? 1 : mix;
}

/** Dry/wet output mix: (1-mix)*dry + mix*wet. */
export function mixSample(dry: number, wet: number, mix: number): number {
  const m = clampMix(mix);
  return (1 - m) * dry + m * wet;
}

/**
 * One ring channel's per-sample state: a buffer + a fractional cursor. The
 * worklet holds one per channel (L + R).
 */
export class RingChannel {
  buf: Float32Array;
  cursor = 0;
  constructor(maxSize: number = RINGBACK_MAX_SIZE) {
    this.buf = new Float32Array(Math.max(RINGBACK_MIN_SIZE, Math.min(RINGBACK_MAX_SIZE, maxSize)));
  }

  /**
   * Process ONE sample. Reproduces the twotracks record-time crush exactly:
   * interp read-back of integer-written cells at a varispeed cursor, optional
   * feedback into the ring, dry/wet out. Returns the output sample.
   */
  step(input: number, rate: number, size: number, feedback: number, mix: number): number {
    const n = clampSize(size);
    const fb = clampFeedback(feedback);
    // 1. read the head (fractional interp) — the decimated read-back.
    const wet = ringRead(this.buf, this.cursor, n);
    // 2. write the input (+ feedback of the read-back) across the integer cells
    //    the head sweeps this sample — sample-quantized (the crush source).
    ringWriteSpan(this.buf, this.cursor, this.cursor + rate, input + fb * wet, n);
    // 3. advance the cursor (wrap into the ring).
    this.cursor = (this.cursor + rate) % n;
    if (this.cursor < 0) this.cursor += n;
    // 4. dry/wet.
    return mixSample(input, wet, mix);
  }

  reset(): void {
    this.buf.fill(0);
    this.cursor = 0;
  }
}
