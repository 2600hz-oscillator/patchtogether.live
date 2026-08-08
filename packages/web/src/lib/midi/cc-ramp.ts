// packages/web/src/lib/midi/cc-ramp.ts
//
// RAMP RASTERIZATION — turning a scheduled param ENDPOINT into a CC train.
//
// THE PROBLEM, precisely. `AudioEngine.scheduleParam(nodeId, paramId, value,
// atTime, ramp)` is how clip automation drives a parameter. For a Web Audio
// param, `ramp: true` means "glide there" and the audio graph interpolates for
// free. A MIDI device has no such affordance: the wire carries discrete
// messages, so the ONLY way a CC parameter glides is if somebody emits the
// intermediate values.
//
// A device module that implements `scheduleParam` by sending one CC at the
// endpoint therefore produces a STEP where the automation lane draws a RAMP.
// It is not subtly wrong — a filter sweep becomes a jump — and nothing in the
// def-reading gate set can see it, because the def, the card and the automation
// data are all correct. Only the bytes are missing.
//
// WHAT THIS FILE IS. A pure function from (start, end, window) to the list of
// (value, time) points that should be transmitted. It is deliberately NOT a
// scheduler: it computes points, and the caller decides when to emit them.
// That split is what makes the interesting cases testable without timers.
//
// TWO BOUNDS, and they interact:
//
//   1. RESOLUTION. A 7-bit CC has 128 distinct values. Emitting more than one
//      message per distinct value is pure waste — the receiver cannot tell them
//      apart. So the point count can never exceed the number of integer steps
//      the ramp actually crosses. A 3-unit move is 3 messages no matter how
//      long it takes.
//   2. RATE. A DIN cable carries ~1040 CC/s TOTAL, shared with every other
//      message. A 127-unit sweep over 20 ms would want 6350 CC/s and would not
//      merely drop values, it would delay everything queued behind it. So there
//      is a per-ramp ceiling, and exceeding it degrades gracefully (coarser
//      steps) rather than flooding.
//
// THE ENDPOINT IS NON-NEGOTIABLE. Whatever the bounds do to the middle, the
// final value is always emitted, at the requested time. This mirrors
// `createCcCommit`'s "the last value ALWAYS lands" rule, and for the same
// reason: a device left one step short of its automation target stays wrong
// until something else happens to move it, and the error is silent.

/** One point in a rasterized ramp. */
export interface CcRampPoint {
  /** Quantized value, in raw CC units. */
  value: number;
  /** When to transmit it, on whatever clock the caller passed in. */
  atS: number;
}

export interface CcRampOpts {
  /** Value at `fromTimeS`, raw CC units. */
  from: number;
  /** Target value at `toTimeS`, raw CC units. */
  to: number;
  fromTimeS: number;
  toTimeS: number;
  /**
   * Per-ramp ceiling on messages per second. The default is deliberately well
   * under the ~1040 CC/s DIN ceiling: a single automation lane is not entitled
   * to the whole cable, and several lanes ramping at once is the normal case.
   */
  maxRateHz?: number;
  /** Quantizer. Defaults to 7-bit integer rounding. A 14-bit control passes
   *  its own so the step count reflects its real resolution. */
  quantize?: (v: number) => number;
}

/** Round to the 7-bit integer grid a CC data byte can actually express. */
export function quantize7(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(127, Math.round(v)));
}

/** Round to the 14-bit grid an MSB/LSB pair can express. */
export function quantize14(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(16383, Math.round(v)));
}

/** Default per-ramp bandwidth ceiling (messages/second). */
export const DEFAULT_RAMP_RATE_HZ = 120;

/**
 * Compute the points to transmit for a ramp from `from` to `to` across
 * [`fromTimeS`, `toTimeS`].
 *
 * Guarantees:
 *   - the LAST point is always exactly `(quantize(to), toTimeS)`;
 *   - values are strictly monotonic in the direction of travel (no duplicates,
 *     no backtracking), so the suppressor downstream has nothing to remove;
 *   - times are strictly increasing and all lie in (`fromTimeS`, `toTimeS`];
 *   - an instantaneous or zero-delta ramp yields exactly one point.
 */
export function rasterizeCcRamp(opts: CcRampOpts): CcRampPoint[] {
  const quantize = opts.quantize ?? quantize7;
  const maxRateHz = opts.maxRateHz ?? DEFAULT_RAMP_RATE_HZ;

  const startV = quantize(opts.from);
  const endV = quantize(opts.to);
  const durationS = opts.toTimeS - opts.fromTimeS;

  // Degenerate cases collapse to the endpoint. Note this covers a NEGATIVE
  // duration too (a schedule already in the past), which must not produce a
  // train running backwards in time.
  if (endV === startV || durationS <= 0) {
    return [{ value: endV, atS: opts.toTimeS }];
  }

  // Bound 1: one message per distinct quantized value the ramp crosses.
  const stepsByResolution = Math.abs(endV - startV);
  // Bound 2: the bandwidth ceiling over this window.
  const stepsByRate = Math.max(1, Math.floor(durationS * maxRateHz));
  const steps = Math.max(1, Math.min(stepsByResolution, stepsByRate));

  const points: CcRampPoint[] = [];
  let previous = startV;
  for (let i = 1; i <= steps; i++) {
    const fraction = i / steps;
    // Linear interpolation. The endpoint is computed rather than interpolated
    // so it is exact regardless of floating-point drift across the loop.
    const value = i === steps ? endV : quantize(startV + (endV - startV) * fraction);
    // Skip a value the wire cannot distinguish from the previous one. This can
    // happen when the rate bound is looser than the resolution bound near the
    // ends of a short ramp.
    if (value === previous) continue;
    points.push({ value, atS: opts.fromTimeS + durationS * fraction });
    previous = value;
  }

  // Defensive: if every intermediate collapsed, still land the endpoint.
  if (points.length === 0 || points[points.length - 1]!.value !== endV) {
    points.push({ value: endV, atS: opts.toTimeS });
  }
  return points;
}
