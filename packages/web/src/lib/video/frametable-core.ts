// packages/web/src/lib/video/frametable-core.ts
//
// FRAMETABLE — pure math core. Every function here is the CPU MIRROR of the GLSL
// selection shader in ./modules/frametable.ts (the EDGES / CELLSHADE / BACKDRAFT /
// GRAINS-OF-VISION source-of-truth pattern): unit-testing them pins the semantics
// the shader transliterates 1:1. NO WebGL in this file — it runs in jsdom.
//
// FrameTable records the last N=60 rendered input frames into a GPU frame ring
// (a TEXTURE_2D_ARRAY, one layer per frame). For EVERY output pixel the shader
// draws exactly ONE source frame — a whole-pixel dither/mosaic, never an
// alpha-average — chosen probabilistically from a bell distribution over a
// MORPH-centred, SPREAD-wide window of the ring.
//
// The three owner HARD REQUIREMENTS this core encodes:
//   1. WHOLE-PIXEL SELECTION — pickLagIndex returns ONE integer ring index; the
//      shader does one array fetch. No accumulation / no blend.
//   2. O(1) PER FRAGMENT — the per-pixel frame comes from an ANALYTIC inverse-CDF
//      (one sqrt + one branch), never a 60-frame loop. triangularOffset /
//      gaussianOffset invert the exact CDF, so the fraction of thresholds landing
//      in each integer bin equals the analytic bell's integral over that bin.
//   3. STILL-IMAGE CONSISTENCY — the per-pixel threshold is STATIC in screen space
//      (see the shader's gl_FragCoord blue-noise/hash sample; no time term), so a
//      still input yields a stable image even while the ring keeps refreshing.
//
// The distribution unit test sweeps threshold01 UNIFORMLY over [0,1) and
// histograms pickLagIndex, then compares the empirical frequencies against the
// analytic binned weights (triangularWeight) — the certification that the math
// hack reproduces the target bell with NO per-fragment loop.

/** Ring depth — the number of rendered input frames held in the GPU frame ring
 *  (one TEXTURE_2D_ARRAY layer per frame). 60 ≪ the spec-guaranteed
 *  MAX_ARRAY_TEXTURE_LAYERS floor of 256, so the array is always allocatable. */
export const FRAMETABLE_RING_FRAMES = 60;

/** Reduced render resolution — half-res (512×384 at the 4:3 default), matching
 *  GRAINS / MIRRORPOOL / MANDELBULB. 60 layers × 0.75 MiB ≈ 45 MiB — safe on the
 *  SwiftShader/CI + mobile budget. A mosaic/dither effect looks fine at half res. */
export const FRAMETABLE_RENDER_SCALE = 0.5;

/** Blue-noise / hash threshold tile size (screen-space, tiled at gl_FragCoord).
 *  Used as the `uBlueNoiseSize` uniform. v1 samples a stable per-pixel hash (no
 *  embedded tile yet — see TODO in the shader); the size still governs the tile
 *  period of the (future) void-and-cluster texture. */
export const FRAMETABLE_BLUE_NOISE_SIZE = 128;

/** weight-shape selector: < 0.5 = triangular (default), >= 0.5 = gaussian. */
export const FRAMETABLE_SHAPE_TRIANGULAR = 0;
export const FRAMETABLE_SHAPE_GAUSSIAN = 1;

// ----------------------------------------------------------------------
// Render MODE encoding (owner-decided). ONE selector param, 0/1/2, curve
// 'discrete'. Defined ONCE here and imported into the factory (shader uMode
// int), the card (segment order) and the tests so the encoding never drifts.
// ----------------------------------------------------------------------

/** SMOOTH — the new DEFAULT. Two morphable waveforms paint a smooth 2D field of
 *  temporal sample-centres; each pixel is a CAPPED WEIGHTED TEMPORAL AVERAGE
 *  (a blend, not a pick) of the ring over a ±Spread window. AUTO-LAGGED. */
export const FRAMETABLE_MODE_SMOOTH = 0;
/** MORPH — a spatially-uniform, buttery cross-dissolve scan of the 60-frame
 *  table via a periodic Hann reconstruction kernel (C¹ + N-periodic seam).
 *  AUTO-LAGGED. */
export const FRAMETABLE_MODE_MORPH = 1;
/** CHAOS — the ORIGINAL per-pixel stochastic inverse-CDF single-frame pick
 *  (today's dither/mosaic look). Always REAL-TIME (no lag). Reachable via the
 *  selector (index 2) AND a momentary CHAOS gate/switch that overrides it. */
export const FRAMETABLE_MODE_CHAOS = 2;

/** SMOOTH-mode temporal tap counts (logical taps × 2 array fetches each). T=8
 *  on a real GPU; T=4 (8 fetches) on the SwiftShader software renderer (CI).
 *  Gate on a renderer probe — a flat perf/pixel assert that passes on a GPU
 *  goes red on CI (the recorderbox/edges failure class). */
export const FRAMETABLE_SMOOTH_TAPS_GPU = 8;
export const FRAMETABLE_SMOOTH_TAPS_SOFT = 4;
/** MORPH Hann-kernel cap (SEPARATE from SMOOTH's compile cap — Hann taps are
 *  single-fetch): beyond this many in-window frames the kernel stride-subsamples
 *  + renormalises, bounding the worst-case fetch count at full spread. */
export const FRAMETABLE_MORPH_TAP_CAP = 32;

// ----------------------------------------------------------------------
// Scalar helpers (transliterated 1:1 into GLSL).
// ----------------------------------------------------------------------

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
function fract(v: number): number {
  return v - Math.floor(v);
}

/**
 * Positive modulo wrap into [0, n). GLSL `mod()` on the ring index; matches the
 * shader's `wrapRing` (mod then guard negative).
 */
export function wrapIndex(x: number, n: number = FRAMETABLE_RING_FRAMES): number {
  let m = x % n;
  if (m < 0) m += n;
  return m;
}

/**
 * Nearest SIGNED offset of `delta` on a ring of size `n`, in [-n/2, n/2). Used to
 * find the wrapped offset of a candidate frame `k` relative to the continuous
 * centre `c` when building the analytic bin weights (so a window straddling the
 * 59→0 seam is scored with no gap or double-count; `2h ≤ N` guarantees no
 * self-overlap).
 */
export function wrapNearestOffset(delta: number, n: number = FRAMETABLE_RING_FRAMES): number {
  return delta - n * Math.round(delta / n);
}

/**
 * Winitzki rational approximation of erf⁻¹ (a = 0.147, ~1e-3 accuracy),
 * GLSL-friendly (no special functions). Used ONLY by the optional gaussian
 * "smooth" weight-shape mode. `x` is expected in (-1, 1).
 */
export function erfinv(x: number): number {
  const a = 0.147;
  const ln = Math.log(Math.max(1e-12, 1 - x * x)); // ln(1-x²) < 0 on (-1,1)
  const t1 = 2 / (Math.PI * a) + ln / 2;
  const t2 = ln / a; // negative → t1² − t2 > t1² so the inner sqrt is real + > t1
  const sign = x < 0 ? -1 : 1;
  return sign * Math.sqrt(Math.max(0, Math.sqrt(t1 * t1 - t2) - t1));
}

// ----------------------------------------------------------------------
// The analytic inverse-CDF (threshold → offset). O(1) — one sqrt + one branch.
// ----------------------------------------------------------------------

/**
 * Triangular inverse-CDF: for a uniform threshold `t ∈ [0,1)`, return the offset
 * `d ∈ [-h, h]` sampled from the symmetric triangular PDF `f(x)=(1/h)(1-|x|/h)`.
 * This is the DEFAULT weight shape.
 *
 *   t < 0.5 :  d = h·( √(2t)       − 1 )   (left half,  d ∈ [-h, 0])
 *   t ≥ 0.5 :  d = h·( 1 − √(2(1−t)) )     (right half, d ∈ [ 0, h])
 *
 * Because we invert the EXACT CDF, the fraction of thresholds landing in each
 * integer bin equals the analytic bell's integral over that bin — no
 * per-fragment loop, no 60-frame CDF build.
 */
export function triangularOffset(t: number, h: number): number {
  const tt = clamp(t, 0, 1);
  if (tt < 0.5) return h * (Math.sqrt(2 * tt) - 1);
  return h * (1 - Math.sqrt(2 * (1 - tt)));
}

/**
 * Gaussian "smooth" inverse-CDF: sigma = spread/6 (so the half-width h = 0.5·spread
 * = 3σ), truncated to [-h, h]. `A = Φ(-3) ≈ 0.00135` remaps the uniform onto the
 * central ±3σ mass so the tails don't pile on the clamp.
 */
export function gaussianOffset(t: number, spread: number, h: number): number {
  const sigma = spread / 6;
  const A = 0.00135; // Φ(-3)
  const p = A + clamp(t, 0, 1) * (1 - 2 * A);
  const d = sigma * Math.SQRT2 * erfinv(2 * p - 1);
  return clamp(d, -h, h);
}

/**
 * Threshold → offset `d`, dispatching on the weight-shape selector (< 0.5 =
 * triangular default, >= 0.5 = gaussian). `spread` is the window width (frames);
 * the half-width is `h = 0.5·spread`.
 */
export function selectOffset(t: number, spread: number, shape: number): number {
  const h = 0.5 * spread;
  return shape < 0.5 ? triangularOffset(t, h) : gaussianOffset(t, spread, h);
}

// ----------------------------------------------------------------------
// Selection — threshold → a single ring index (O(1), one whole-pixel choice).
// ----------------------------------------------------------------------

/**
 * The whole-pixel frame choice. Given MORPH (0..1, → centre lag `c = morph·N`),
 * SPREAD (1..60, → half-width `h = 0.5·spread`), a uniform per-pixel threshold
 * `t ∈ [0,1)`, and the weight SHAPE, return the SINGLE rounded ring lag index the
 * pixel draws — wrapped into [0, N). This is what the shader turns into one
 * `texture(uRing, vec3(uv, k))` fetch — hard requirement #1 (one frame, no blend)
 * and #2 (analytic, no loop).
 *
 * Work is in LAG SPACE relative to the write head so a moving head is transparent
 * (see lagToLayer for the head mapping). `spread = 1 → h = 0.5` collapses to the
 * centre frame (a delta); `spread = N-1 → h = (N-1)/2` spans nearly the whole
 * ring as one bell. Spread is clamped to `[1, N-1]` — EXACTLY matching the
 * shader's factory-side `clamp(params.spread, 1, N-1)` (so the CPU mirror stays
 * faithful at the boundary) and keeping `2h ≤ N-1 < N` so the ±h window never
 * self-overlaps across the wrap seam.
 */
export function pickLagIndex(
  morph: number,
  spread: number,
  t: number,
  shape: number = FRAMETABLE_SHAPE_TRIANGULAR,
  ringFrames: number = FRAMETABLE_RING_FRAMES,
): number {
  const c = clamp(morph, 0, 1) * ringFrames;
  const d = selectOffset(t, clamp(spread, 1, ringFrames - 1), shape);
  // round(c + d) == floor(c + d + 0.5), the shader's `wrapRing(x + 0.5)`.
  return wrapIndex(Math.round(c + d), ringFrames);
}

/**
 * Lag → ring LAYER: lag 0 = newest = layer `head`; lag N-1 = oldest = layer
 * `(head+1) mod N`. The shader passes `head` as a uniform and computes
 * `layer = mod(head − lag, N)`. Rounded + wrapped here for the CPU mirror.
 */
export function lagToLayer(
  head: number,
  lag: number,
  ringFrames: number = FRAMETABLE_RING_FRAMES,
): number {
  return wrapIndex(Math.round(head - lag), ringFrames);
}

// ----------------------------------------------------------------------
// Analytic target weights — the binned integral the histogram must match.
// ----------------------------------------------------------------------

/**
 * Triangular CDF on [-h, h] (F(x)=P(offset ≤ x)):
 *   x < -h            → 0
 *   -h ≤ x < 0        → (x+h)² / (2h²)
 *   0 ≤ x ≤ h         → 1 − (h−x)² / (2h²)
 *   x > h             → 1
 */
export function triangularCdf(x: number, h: number): number {
  if (h <= 0) return x < 0 ? 0 : 1;
  if (x < -h) return 0;
  if (x > h) return 1;
  if (x < 0) return ((x + h) * (x + h)) / (2 * h * h);
  return 1 - ((h - x) * (h - x)) / (2 * h * h);
}

/**
 * Analytic probability mass the TRIANGULAR bell assigns to the integer frame `k`
 * when the window is centred on the continuous lag `center` with the given
 * `spread`. The bin for `k` is [off−0.5, off+0.5] where `off` is the wrapped
 * nearest offset of `k` to `center`; the mass is F(min(b,h)) − F(max(a,−h)),
 * clamped to ≥ 0. Σ over the ~spread in-window frames = 1; the centre bin is the
 * single largest weight. This is the target the empirical histogram of
 * `pickLagIndex` is compared against (total-variation + max-abs).
 */
export function triangularWeight(
  k: number,
  center: number,
  spread: number,
  ringFrames: number = FRAMETABLE_RING_FRAMES,
): number {
  const h = 0.5 * spread;
  const off = wrapNearestOffset(k - center, ringFrames);
  const a = off - 0.5;
  const b = off + 0.5;
  if (b <= -h || a >= h) return 0;
  const w = triangularCdf(Math.min(b, h), h) - triangularCdf(Math.max(a, -h), h);
  return Math.max(0, w);
}

// ----------------------------------------------------------------------
// The static screen-space threshold source (hash fallback — v1).
// ----------------------------------------------------------------------

/**
 * Dave-Hoskins hash21 → [0,1). The CPU mirror (EXACT, modulo float32/float64 low
 * bits) of the shader's `hash21`, used as the STATIC per-pixel threshold when no
 * blue-noise tile is embedded (v1). It is a pure function of screen position
 * (gl_FragCoord in the shader) with NO time / frame / head term — that staticness
 * is what gives hard requirement #3 (still-image consistency).
 *
 * It is amplitude-UNIFORM over the 128×128 screen tile (KS ≈ 0.007 vs the uniform
 * CDF, mean ≈ 0.5 — pinned by the hash21-uniformity test), so the per-pixel
 * selection histogram matches the target bell with no low/high bias. It is NOT
 * true blue noise, though: amplitude-uniform (white) but not spectrally blue, so it
 * clumps more than a void-and-cluster tile → the pattern is a touch more visible.
 * Embedding a blue-noise tile (shader TODO) is a SPATIAL/spectral quality upgrade,
 * NOT a distribution fix. The distribution unit test also sweeps the threshold
 * UNIFORMLY (not through this hash), so the inverse-CDF math is certified
 * independent of the noise source.
 */
export function hash21(x: number, y: number): number {
  let p3x = fract(x * 0.1031);
  let p3y = fract(y * 0.1031);
  let p3z = fract(x * 0.1031);
  // p3 += dot(p3, p3.yzx + 33.33) — scalar broadcast, NO per-component fract, so
  // this is the EXACT mirror of the GLSL hash21. (The earlier per-component-fract
  // variant both diverged from the shader AND biased the mean low to ~0.37; the one
  // large-magnitude combine below is what actually decorrelates the bits.)
  const d = p3x * (p3y + 33.33) + p3y * (p3z + 33.33) + p3z * (p3x + 33.33);
  p3x += d;
  p3y += d;
  p3z += d;
  return fract((p3x + p3y) * p3z);
}

/**
 * Optional temporal SHIMMER of the threshold: `t' = fract(t + shimmer · fract(frame
 * · φ⁻¹))`, a golden-ratio (temporally blue-noise) hop. shimmer 0 ⇒ fully static
 * (returns `t` unchanged ⇒ hard req #3 holds). Low values (0.02–0.1) animate the
 * threshold along a low-discrepancy sequence so moving content gets a gentle
 * living grain while the TIME-AVERAGED distribution stays exactly the target bell.
 */
export function shimmerThreshold(t: number, shimmer: number, frameIndex: number): number {
  if (shimmer <= 0) return t;
  return fract(t + shimmer * fract(frameIndex * 0.61803399));
}

// ----------------------------------------------------------------------
// Ring / freeze / save reducers (pure — the factory's state machine mirror).
// ----------------------------------------------------------------------

/**
 * Advance the ring write head one step, UNLESS frozen. FREEZE gates only the
 * capture + head advance (the SELECT/output pass keeps running every frame, so
 * MORPH/SPREAD stay live over the held 60). frozen high → head pinned (contents
 * frozen); low → head advances → the ring keeps refreshing.
 */
export function advanceHead(
  head: number,
  frozen: boolean,
  ringFrames: number = FRAMETABLE_RING_FRAMES,
): number {
  return frozen ? head : wrapIndex(head + 1, ringFrames);
}

// ======================================================================
// 3-MODE REWORK — pure CPU mirrors of the SMOOTH + MORPH shader paths and
// the mode/lag/first-frame-fill dispatch reducers. Every function below is a
// 1:1 transliteration of the GLSL in ./modules/frametable.ts SELECT program.
// ======================================================================

/** GLSL `mix(a,b,t) = a + (b-a)·t`. */
function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
/** GLSL `smoothstep(e0,e1,x)`. */
function smoothstep(e0: number, e1: number, x: number): number {
  if (e1 === e0) return x < e0 ? 0 : 1;
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

// ----------------------------------------------------------------------
// Mode / lag / read-centre dispatch reducers (§2.2 / §2.3).
// ----------------------------------------------------------------------

/**
 * Resolve the EFFECTIVE render mode. The momentary CHAOS gate/switch
 * (`chaosActive`) overrides the selector while held; otherwise the selector's
 * rounded 0/1/2 value wins. Mirrors the factory's `effMode`.
 */
export function frametableEffMode(mode: number, chaosActive: boolean): number {
  return chaosActive ? FRAMETABLE_MODE_CHAOS : Math.round(clamp(mode, 0, 2));
}

/**
 * Is this frame LAGGED (trailing read) or REAL-TIME? `lag = (mode ≠ CHAOS) &&
 * !LIVE`: CHAOS is always real-time; SMOOTH/MORPH auto-lag UNLESS LIVE forces
 * real-time. Mirrors the factory's `lagged`.
 */
export function frametableLagged(effMode: number, liveActive: boolean): boolean {
  return effMode !== FRAMETABLE_MODE_CHAOS && !liveActive;
}

/**
 * The morph CENTRE `c` (frames of lag back from the head), biased per §2.3(a):
 *   - REAL-TIME (chaos / live-forced): `c = morph·N` — today's centre (window
 *     may sit at the newest frame; a seam straddle is invisible in a
 *     per-pixel dither / softened by the average).
 *   - LAGGED (smooth/morph, !live): `c = h + morph·(N − 2h)` ⇒ `c ∈ [h, N−h]`
 *     so the ±Spread window always sits in already-populated trailing layers,
 *     clear of the head↔head-1 write seam.
 * `spread` is clamped to `[1, N−1]` so `h ≤ (N−1)/2` and `[h, N−h]` is non-empty.
 */
export function frametableReadCentre(
  morph: number,
  spread: number,
  lagged: boolean,
  ringFrames: number = FRAMETABLE_RING_FRAMES,
): number {
  const N = ringFrames;
  const m = clamp(morph, 0, 1);
  if (!lagged) return m * N;
  const h = 0.5 * clamp(spread, 1, N - 1);
  return h + m * (N - 2 * h);
}

/** Alias of {@link frametableReadCentre} used by the SMOOTH sampler (§2.3). */
export function smoothCentre(
  morph: number,
  spread: number,
  lagged: boolean,
  ringFrames: number = FRAMETABLE_RING_FRAMES,
): number {
  return frametableReadCentre(morph, spread, lagged, ringFrames);
}

// ----------------------------------------------------------------------
// SMOOTH — morphable waveform → 2D temporal field → weighted average (§3).
// ----------------------------------------------------------------------

/**
 * The morphable unit waveform in [-1,1] (§3.2): one continuous `shape ∈ [0,1]`
 * sweeps four ZERO-CROSSING-ALIGNED anchors (sine → tri → saw → square) so
 * blending never phase-cancels. All four cross zero ascending at `p=0`, so any
 * blend of them is ≈0 at `p=0` (the anti-cancellation guarantee).
 *   u=axis coord, freq=cycles across axis, phase=offset (FLOW), shape 0..1.
 */
export function wshape(u: number, freq: number, phase: number, shape: number): number {
  const p = u * freq + phase;
  const sine = Math.sin(6.28318530718 * p);
  const tri = 1 - 4 * Math.abs(fract(p + 0.25) - 0.5); // 0 rising at p=0, peak p=.25
  const saw = 2 * fract(p + 0.5) - 1; // 0 rising at p=0
  const sq = clamp(4 * sine, -1, 1); // soft anti-aliased square
  const S = clamp(shape, 0, 1) * 3; // 0..3 across the 4 anchors
  let w = sine;
  w = mix(w, tri, smoothstep(0, 1, clamp(S, 0, 1)));
  w = mix(w, saw, smoothstep(0, 1, clamp(S - 1, 0, 1)));
  w = mix(w, sq, smoothstep(0, 1, clamp(S - 2, 0, 1)));
  return w;
}

/**
 * The 2D temporal-displacement FIELD in FRAMES (§3.3): two axis waveforms
 * summed with a moderated ring-mod cross-term that couples the axes into
 * flowing diagonal whorls. `ampX/ampY` are in FRAMES (the factory maps
 * `waveAmt·(N/2)`); `cross` is the coupling (default 0.4). `fieldGain=0`
 * FLATTENS the field (MORPH), yielding a spatially-constant 0 displacement.
 */
export function smoothField(
  ux: number,
  uy: number,
  freqX: number,
  ampX: number,
  phaseX: number,
  shapeX: number,
  freqY: number,
  ampY: number,
  phaseY: number,
  shapeY: number,
  cross: number,
  fieldGain = 1,
): number {
  const a = wshape(ux, freqX, phaseX, shapeX);
  const b = wshape(uy, freqY, phaseY, shapeY);
  return fieldGain * (ampX * a + ampY * b + cross * 0.5 * (ampX + ampY) * a * b);
}

/**
 * Manual inter-layer LINEAR interpolation (§3.5). WebGL2 `sampler2DArray` does
 * NOT filter across layers (it rounds the layer coord), so a fractional temporal
 * position must be blended by hand: fetch the two adjacent layers and `mix`.
 * `ringAt(layer)` models one colour channel of the ring at an integer layer;
 * `lag` is frames back from `head` (fractional). Wrapping keeps it on the ring.
 */
export function sampleRingLerp(
  ringAt: (layer: number) => number,
  head: number,
  lag: number,
  ringFrames: number = FRAMETABLE_RING_FRAMES,
): number {
  const layerF = head - lag; // fractional layer
  const l0 = Math.floor(layerF);
  const f = layerF - l0; // sub-frame fraction
  const c0 = ringAt(wrapIndex(l0, ringFrames));
  const c1 = ringAt(wrapIndex(l0 + 1, ringFrames));
  return mix(c0, c1, f); // TRUE adjacent-frame blend
}

/**
 * The CAPPED WEIGHTED TEMPORAL AVERAGE (§3.4) — the SMOOTH smoothness: a BLEND,
 * not a pick. `taps` equal-weight stratified importance samples of the fixed
 * GAUSSIAN bell (`selectOffset` as the placement → samples auto-concentrate on
 * the peak frame), each read with `sampleRingLerp` for sub-frame temporal
 * blending, then averaged. `field` is the per-pixel spatial displacement (§3.3;
 * 0 = spatially uniform). A still ring ⇒ output == that still value (constant);
 * an impulse ring ⇒ a value STRICTLY between (an average), never a single frame.
 */
export function smoothSample(
  ringAt: (layer: number) => number,
  morph: number,
  spread: number,
  taps: number,
  lagged: boolean,
  field = 0,
  head: number = FRAMETABLE_RING_FRAMES - 1,
  ringFrames: number = FRAMETABLE_RING_FRAMES,
): number {
  const s = clamp(spread, 1, ringFrames - 1);
  const c = frametableReadCentre(morph, s, lagged, ringFrames);
  const lagCentre = c + field;
  const T = Math.max(1, Math.round(taps));
  let acc = 0;
  let wsum = 0;
  for (let i = 0; i < T; i++) {
    const t = (i + 0.5) / T; // regular strata in [0,1) — no per-pixel noise
    const d = selectOffset(t, s, FRAMETABLE_SHAPE_GAUSSIAN); // gaussian placement
    acc += sampleRingLerp(ringAt, head, lagCentre + d, ringFrames);
    wsum += 1;
  }
  return acc / Math.max(wsum, 1);
}

// ----------------------------------------------------------------------
// MORPH — periodic raised-cosine (Hann) reconstruction kernel (§4.1).
// ----------------------------------------------------------------------

/** The Hann-kernel result: spatially-uniform per-frame weights + ring layers. */
export interface MorphKernel {
  /** Ring layer index per tap (integer, already `head−k` wrapped). */
  layers: number[];
  /** Normalised weight per tap (Σ = 1). */
  weights: number[];
  /** Number of taps (≤ cap). */
  count: number;
}

/**
 * MORPH's periodic raised-cosine (Hann) reconstruction kernel (§4.1). Computed
 * ONCE per frame (spatially uniform) and uploaded as uniform arrays. For each
 * integer lag `k ∈ [⌈ℓ−h⌉, ⌊ℓ+h⌋]` with `ℓ = frametableReadCentre` and
 * `h = max(0.5, spread/2)`:
 *   g(δ) = 0.5·(1 + cos(π·δ/h))   for |δ| ≤ h,  δ = k − ℓ
 *   w_k  = g / Σg   (normalise)
 *   layer_k = mod(round(head − k), N)   (PERIODIC ring index)
 * Guarantees (a) no pop at frame boundaries — `g(±h)=0` AND `g'(±h)=0` so a
 * frame joins/leaves with zero weight AND zero slope (C¹ in ℓ), and (b) no pop
 * across the 59→0 wrap seam — `layer_k` is N-periodic so `R(ℓ)` is N-periodic
 * and C¹. Beyond `cap` taps the window is STRIDE-SUBSAMPLED + renormalised
 * (a smooth low-pass is visually identical), bounding worst-case fetch cost.
 */
export function morphKernel(
  morph: number,
  spread: number,
  head: number,
  lagged: boolean,
  cap: number = FRAMETABLE_MORPH_TAP_CAP,
  ringFrames: number = FRAMETABLE_RING_FRAMES,
): MorphKernel {
  const N = ringFrames;
  const s = clamp(spread, 1, N - 1);
  const c = frametableReadCentre(morph, s, lagged, N); // scan centre ℓ
  const h = Math.max(0.5, 0.5 * s);

  const kLo = Math.ceil(c - h);
  const kHi = Math.floor(c + h);
  const ks: number[] = [];
  for (let k = kLo; k <= kHi; k++) ks.push(k);

  // Stride-subsample beyond the cap (keeps the endpoints; smooth low-pass).
  // Base the stride on the SMOOTH `spread` control via the window's WORST-CASE
  // integer-tap count (`floor(2h)+1`, a closed interval of width 2h holds at
  // most that many integers), NOT on the realized `ks.length` — which jitters
  // ±1 as the centre `c` crosses integers. A `ks.length`-based stride flips
  // 1↔2 for a single frame right at the cap boundary (spread≈32: 32→stride 1,
  // 33→stride 2), roughly doubling the kept frames' weights for that frame — a
  // visible C¹ break in the scan. `maxTaps` is a pure function of `spread`, so
  // the stride is CONSTANT across a scan at fixed spread (no per-frame flip),
  // while still bounding the tap count ≤ cap (= the shader uWeights[] size).
  const maxTaps = Math.floor(2 * h) + 1;
  const stride = maxTaps > cap ? Math.ceil(maxTaps / cap) : 1;

  const layers: number[] = [];
  const rawW: number[] = [];
  let sum = 0;
  for (let idx = 0; idx < ks.length; idx += stride) {
    const k = ks[idx]!;
    const delta = k - c;
    const g = 0.5 * (1 + Math.cos((Math.PI * delta) / h)); // Hann; g(±h)=0
    layers.push(wrapIndex(Math.round(head - k), N));
    rawW.push(g);
    sum += g;
  }

  // Degenerate guard (e.g. spread=1 with c exactly on a half-integer makes both
  // edge weights 0): fall back to a single delta at the nearest layer.
  if (layers.length === 0 || sum <= 1e-12) {
    return { layers: [wrapIndex(Math.round(head - c), N)], weights: [1], count: 1 };
  }

  const weights = rawW.map((w) => w / sum);
  return { layers, weights, count: layers.length };
}

// ----------------------------------------------------------------------
// First-frame fill reducer (§2.4).
// ----------------------------------------------------------------------

/** Capture-state the fill reducer reads + advances. */
export interface FrametableFillState {
  head: number;
  capturedAny: boolean;
  framesElapsed: number;
}
/** The fill transition for ONE unfrozen capture step. */
export interface FrametableFillResult {
  /** true on the FIRST real input frame → the factory fills ALL N ring layers
   *  with that frame (buffer instantly FULL = a still image). */
  filled: boolean;
  head: number;
  capturedAny: boolean;
  framesElapsed: number;
}

/**
 * First-frame-fill reducer (§2.4). On the FIRST real input frame (`!capturedAny
 * && hasInput`) signal `filled` so the factory copies that frame into ALL 60
 * ring layers (a full buffer, still image); real frames then wash in over ~N
 * frames (the "2-second lag"). No-ops (never re-fills) once `capturedAny`.
 * Head advances every unfrozen step regardless (capture always records at full
 * rate; LIVE/mode never gate CAPTURE, only the READ centre).
 */
export function fillOnFirstFrame(
  state: FrametableFillState,
  hasInput: boolean,
  ringFrames: number = FRAMETABLE_RING_FRAMES,
): FrametableFillResult {
  const firstReal = !state.capturedAny && hasInput;
  return {
    filled: firstReal,
    head: wrapIndex(state.head + 1, ringFrames),
    capturedAny: state.capturedAny || hasInput,
    framesElapsed: state.framesElapsed + 1,
  };
}
