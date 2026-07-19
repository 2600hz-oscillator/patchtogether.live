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
 * centre frame (a delta); `spread = 60 → h = 30` covers all 60 as one bell.
 */
export function pickLagIndex(
  morph: number,
  spread: number,
  t: number,
  shape: number = FRAMETABLE_SHAPE_TRIANGULAR,
  ringFrames: number = FRAMETABLE_RING_FRAMES,
): number {
  const c = clamp(morph, 0, 1) * ringFrames;
  const d = selectOffset(t, clamp(spread, 1, ringFrames), shape);
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
