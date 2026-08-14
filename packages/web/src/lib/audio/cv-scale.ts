// packages/web/src/lib/audio/cv-scale.ts
//
// CV → AudioParam scaling. Project convention (see
// docs/adr/004-cv-range-convention.md): the `cv` cable type carries a
// bipolar -1..+1 modulation signal. ±1 should sweep the destination
// param through its FULL natural range, centered on the user-set knob
// position.
//
// Without scaling, Web Audio's default sum-into-AudioParam-value behavior
// produces sweeps of (typically) 1-50% of the param's natural range,
// because most params have ranges much wider than ±1 (e.g. attack 0.001-10s,
// cutoff 20-20000Hz). This file provides the pure helpers + audio-graph
// builder that the engine uses to interpose scaling nodes between the
// source and the AudioParam.
//
// Three scaling modes match the three common knob-curve shapes:
//   linear   — additive: knob + cv * (max-min)/2
//   log      — multiplicative: knob * (max/min)^(cv/2)
//   discrete — bucketed: floor((cv+1)/2 * N)
//
// Each scaling builds an audio-rate processing chain:
//
//   source ─► [scaleNode] ─► destinationParam
//
// The scaleNode's output value at any instant equals the *delta* that
// should be summed into the param's intrinsic value (the user-set knob).
// At cv=0 the delta is 0 (no modulation); at cv=±1 the delta is
// ±half-the-natural-span. Web Audio sums this with the param's intrinsic
// value via the existing connect-source-to-AudioParam plumbing, and the
// param's `min..max` clamp pins outliers — which matches Eurorack
// semantics ("CV pushes the knob around its current setting; outside the
// natural range, it pins").
//
// ⚠ `discrete` is the ONE mode where "cv=0 ⇒ no modulation" does NOT hold,
// and that is DELIBERATE, not a defect: a bucket selector is an ABSOLUTE map
// (cv=-1 → min bucket, cv=+1 → max bucket, IGNORING the knob) so that a
// full-scale LFO reaches every model/scale/mode regardless of where the knob
// sits — see the `discrete` branch of `scaleCv`. cv=0 therefore selects the
// MIDDLE bucket. What `CURVE_LEN` guarantees for discrete is narrower but no
// less real: that the LUT returns that bucket EXACTLY, rather than a
// half-integer wedged between two buckets, which is a value the mode can
// never legitimately produce.

import type { CvScaleHint, ParamDef } from '$lib/graph/types';

/**
 * Pure scaling math. Given a CV sample `c` ∈ [-1, +1], the user's knob
 * position `knob`, the param's natural range, and the scale hint, return
 * the EFFECTIVE param value that should be presented to the audio thread.
 *
 * For unit testing — the audio-graph plumbing in `attachCvScale` builds
 * the equivalent processing graph in real time.
 */
export function scaleCv(
  c: number,
  knob: number,
  paramMin: number,
  paramMax: number,
  hint: CvScaleHint,
): number {
  const depth = hint.depth ?? 1.0;
  const cv = clamp(c, -1, 1);
  switch (hint.mode) {
    case 'passthrough':
      // Legacy: sum directly. No clamping here — the AudioParam clamps.
      return knob + cv;
    case 'linear': {
      // Additive: ±1 sweeps half the natural range each direction.
      const halfSpan = (paramMax - paramMin) / 2;
      const effective = knob + cv * depth * halfSpan;
      return clamp(effective, paramMin, paramMax);
    }
    case 'log': {
      // Multiplicative: knob * (max/min)^(cv/2). At cv=+1: knob * sqrt(max/min).
      // At cv=-1: knob / sqrt(max/min). For a 0.001..10 range, that's a
      // ±100x multiplier, so cv=+1 around knob=0.1 sweeps to 10 (full max);
      // cv=-1 sweeps to 0.001 (full min). Symmetric in log space.
      if (paramMin <= 0 || paramMax <= 0) {
        // Log scaling requires positive bounds — fall back to linear.
        const halfSpan = (paramMax - paramMin) / 2;
        return clamp(knob + cv * depth * halfSpan, paramMin, paramMax);
      }
      const ratio = Math.pow(paramMax / paramMin, cv * depth / 2);
      return clamp(knob * ratio, paramMin, paramMax);
    }
    case 'discrete': {
      // Bucket the cv sweep across the integer values in [paramMin, paramMax].
      // cv=-1 → paramMin; cv=+1 → paramMax; symmetric.
      const span = paramMax - paramMin;
      const bucketed = Math.round(paramMin + ((cv + 1) / 2) * span);
      return clamp(bucketed, paramMin, paramMax);
    }
  }
}

/**
 * Compute the audio-graph SCALING delta — what's added to the param's
 * intrinsic value via Web Audio summing — for a given CV sample.
 *
 * scaleCv(...) returns the EFFECTIVE param value (knob + delta). The
 * delta is what we want the scaling node to OUTPUT, because Web Audio
 * sums that output into the AudioParam.value (which holds knob).
 */
export function scaleCvDelta(
  c: number,
  knob: number,
  paramMin: number,
  paramMax: number,
  hint: CvScaleHint,
): number {
  return scaleCv(c, knob, paramMin, paramMax, hint) - knob;
}

function clamp(v: number, lo: number, hi: number): number {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

/**
 * Build the audio-graph scaling chain for a `cv → AudioParam` edge.
 *
 * Inputs:
 *   ctx        — the AudioContext to allocate Web Audio nodes in
 *   paramDef   — the modulated param's def (range + curve)
 *   hint       — the cvScale hint (mode + depth)
 *   knob       — the param's CURRENT intrinsic value at the moment the cable
 *                is plugged in. Baked into the LUT so the modulation
 *                centres on the user's actual knob position rather than
 *                the static defaultValue. Future: subscribe to knob
 *                changes and rebuild the LUT — for v1 we accept that
 *                manual knob movements after the cable is plugged update
 *                only the additive part (Web Audio sums knob + delta) so
 *                the user still sees their knob position drive the
 *                centre of the sweep.
 *
 * Returns:
 *   { input: AudioNode (where source connects), output: AudioNode (where the
 *     scaled signal exits — to be connected into targetParam),
 *     teardown: () => void }
 *
 * The output's per-sample value is `delta` such that
 * `param.value + delta` equals the EFFECTIVE param value scaleCv(...) computes.
 * Web Audio's `output.connect(targetParam)` adds delta to the param at audio
 * rate; the AudioParam's intrinsic value is `knob` (set by setParam from the
 * fader). When cv=0, delta=0 → no modulation (exactly 0, guaranteed by the odd
 * `CURVE_LEN` — see its comment; `discrete` selects the middle bucket instead,
 * by design). When cv=±1, delta=±halfSpan (linear) or knob*(ratio - 1) (log).
 *
 * For `passthrough`, no scaling node is interposed — the source connects
 * directly to the target param (caller may skip calling this function).
 */
export function attachCvScale(
  ctx: AudioContext,
  paramDef: ParamDef,
  hint: CvScaleHint,
  knob: number = paramDef.defaultValue,
): {
  /** Where the upstream source should connect. */
  input: AudioNode;
  /** Where the chain emits its scaled signal — connect into the target param. */
  output: AudioNode;
  /** Tear down all internal nodes. */
  teardown: () => void;
} {
  const depth = hint.depth ?? 1.0;
  const min = paramDef.min;
  const max = paramDef.max;

  // For ALL three scaling modes, the cleanest implementation is a
  // WaveShaperNode whose curve is the lookup of cv → delta. The WaveShaperNode
  // input/output is sample-accurate audio rate; the curve table provides
  // arbitrary nonlinear mapping including log + discrete bucketing.
  //
  // Linear mode is technically expressible as a single GainNode(halfSpan*depth)
  // — but to keep the graph layout uniform across modes, and to handle
  // clamping at min/max correctly, we always use a WaveShaperNode. Cost is
  // ~negligible (one curve table per edge, sub-1KB; sample-rate evaluation
  // is what GainNode does anyway under the hood for audio-rate paths).
  const shaper = ctx.createWaveShaper();
  shaper.oversample = 'none';
  shaper.curve = buildCvCurve(min, max, knob, hint, depth);

  return {
    input: shaper,
    output: shaper,
    teardown: () => {
      try { shaper.disconnect(); } catch { /* may already be disconnected */ }
    },
  };
}

/**
 * LUT size. **ODD ON PURPOSE — do not "round" it back to a power of two.**
 *
 * A WaveShaperNode maps its input to a fractional table position
 * `v = (N-1)/2 · (x+1)` and LINEARLY INTERPOLATES between `curve[⌊v⌋]` and
 * `curve[⌊v⌋+1]`. With an EVEN `N` there is no table entry at the centre, so
 * `cv = 0` — the value a patched-but-idle cable holds — lands at `v = (N-1)/2`,
 * i.e. exactly HALFWAY between two samples, and the shaper emits their MEAN
 * rather than the curve's true value at zero.
 *
 * That mean equals the true value only where the delta function happens to be
 * ODD-SYMMETRIC about cv=0. It is not, in three cases, all of them real:
 *
 *   1. `discrete` — the buckets straddling the centre differ by one, so the
 *      mean is a HALF-INTEGER: a value the mode can never legitimately produce.
 *      Measured on the registry at N=4096: 16 of 17 discrete ports emitted a
 *      non-bucket value at cv=0 (macrooscillator.model_cv read 6.5 of 0..13;
 *      qbrt.mode / rings.model_cv / the 8 mixmstrs compEnable switches read
 *      0.5 of 0..1 — a boolean stuck exactly between off and on).
 *   2. `linear` with the knob AT a range end — the min/max clamp flattens one
 *      side, so the two neighbours are not ∓equal. 74 registry ports, biased by
 *      `range / (4·(N-1))` ≈ 0.0061 % of range (e.g. analogVco.shape 0..1 at
 *      knob 0 idled at 6.105e-5 instead of 0).
 *   3. `log` — the exponential is convex, so the mean of the neighbours sits
 *      above the true value. All 39 log ports, ≤ 1.1e-5 % of range.
 *
 * 130 of 317 curve-backed ports were affected. An ODD `N` puts a sample
 * EXACTLY at cv=0 (index `(N-1)/2`), so the shaper reads it directly (f=0) and
 * the guarantee "cv=0 ⇒ the unmodulated value" holds BY CONSTRUCTION for every
 * mode — including modes added later — instead of by accident of symmetry.
 *
 * The ENDS are unaffected: `i=0 → cv=-1` and `i=N-1 → cv=+1` hold for any `N`,
 * and the shaper clamps `v` to `[0, N-1]`, so `cv=±1` still reads `curve[0]` /
 * `curve[N-1]` exactly. 4097 additionally makes EVERY sample position an exact
 * dyadic rational (`i/2048 - 1`), removing the float rounding that 4095ths
 * carried. Cost is 4 bytes per curve.
 */
export const CURVE_LEN = 4097;

/**
 * Build the curve mapping cv ∈ [-1, +1] to the *delta* that should be added to
 * the param's intrinsic value. Outputs are clamped to the param's own bounds.
 *
 * `len` exists ONLY so tests can drive this REAL builder with a different table
 * shape (the negative control pins that an EVEN table fails the cv=0 gate).
 * Production always uses `CURVE_LEN`.
 */
export function buildCvCurve(
  paramMin: number,
  paramMax: number,
  knob: number,
  hint: CvScaleHint,
  depth: number = hint.depth ?? 1.0,
  len: number = CURVE_LEN,
): Float32Array<ArrayBuffer> {
  // Allocate on a fresh ArrayBuffer to satisfy WaveShaperNode.curve's strict
  // typed-array signature (cf. illogic.ts and fold-curve.ts).
  const curve = new Float32Array(new ArrayBuffer(len * 4));
  for (let i = 0; i < len; i++) {
    // Map index [0, len-1] → cv ∈ [-1, +1] (the WaveShaperNode's standard
    // input domain).
    const cv = (i / (len - 1)) * 2 - 1;
    const effective = scaleCv(cv, knob, paramMin, paramMax, { ...hint, depth });
    // Web Audio sums (delta + knob) into the param. We want effective; so
    // delta = effective - knob.
    curve[i] = effective - knob;
  }
  return curve;
}

/**
 * Read a curve THE WAY THE AUDIO THREAD DOES — the Web Audio spec's
 * WaveShaperNode transfer function, verbatim:
 *
 *   v = (N-1)/2 · (x+1);  k = ⌊v⌋;  f = v - k
 *   v ≤ 0    → curve[0]          (input below -1 clamps)
 *   v ≥ N-1  → curve[N-1]        (input above +1 clamps)
 *   else     → (1-f)·curve[k] + f·curve[k+1]
 *
 * **Use this, never `curve[Math.round(…)]`, to assert anything about a curve.**
 * Nearest-index sampling is a DIFFERENT function: for an even-length table it
 * reports `curve[N/2]` at cv=0 — one whole half-step off — which is how a
 * ±3-range port came to look like it idled at 7.326e-4 when a real
 * WaveShaperNode renders it as exactly 0. The instrument was reading a sample
 * the audio thread never emits on its own.
 *
 * Validated against a real Chromium `OfflineAudioContext` in both directions:
 * spiking one centre sample of an odd table moves the rendered output to it,
 * and spiking BOTH neighbours of an even table renders their mean.
 */
export function sampleCvCurve(curve: Float32Array, cv: number): number {
  const n = curve.length;
  const v = ((n - 1) / 2) * (cv + 1);
  if (v <= 0) return curve[0] as number;
  if (v >= n - 1) return curve[n - 1] as number;
  const k = Math.floor(v);
  const f = v - k;
  // Exact table hit — return the sample untouched rather than letting an
  // arithmetic round-trip perturb it.
  if (f === 0) return curve[k] as number;
  return (1 - f) * (curve[k] as number) + f * (curve[k + 1] as number);
}
