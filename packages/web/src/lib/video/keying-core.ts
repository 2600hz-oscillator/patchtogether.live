// packages/web/src/lib/video/keying-core.ts
//
// THE shared keying core for the keyer/compositor family (design:
// .myrobots/plans/keyer-framework-2026-07-11.md §4, as amended by the §11
// adversarial review). One source of truth for:
//
//   kcLuma        Rec. 601 luma Y' = dot(c, KEY_LUMA_WEIGHTS) — the app-wide
//                 luminance flavor (601, documented per-module).
//   kcChroma      full-swing Rec. 601 chroma-plane coordinates (Cb, Cr) of an
//                 R'G'B' triple: Cb = (B'-Y')*0.564, Cr = (R'-Y')*0.713.
//   kcLumaMask    the canonical CENTERED smoothstep luma window —
//                 bit-compatible with LUMAKEY's historical expression
//                 (clamp thr 0..1, soft 0..0.5 floored at 0.001, invert flips).
//   kcChromaMask  key-relative chroma-plane distance (Vlahos-family metric):
//                 d = |kcChroma(c) - kcChroma(key)| / |kcChroma(key)|, alpha =
//                 smoothstep(thr, thr+soft, d). 0 at the key colour; EXACTLY
//                 1.0 for any neutral gray vs any saturated key (a gray's
//                 chroma is the zero vector, so its distance from the key IS
//                 the key's chroma magnitude). Low-chroma subject pixels are
//                 inherently far from a saturated key — no saturation gate.
//   kcDespill     dominant-channel min-limit spill suppression (the standard
//                 despill family: for a green key g' = min(g, max(r, b)),
//                 lerped by amount). EXACT identity at amount = 0.
//   kcComposite   the one blessed compositing line: mix(bg, fg, alpha).
//
// PATTERN (proven by mapper.ts / fader-transitions.ts): the pure TS mirrors
// below are the unit-tested source of truth; GLSL_KEY_HELPERS is a
// line-for-line port INTERPOLATED into each consumer module's FRAG_SRC.
// Shared numeric constants are template-interpolated into the GLSL from the
// SAME exported TS constants (§11 change 5), so GLSL <-> TS lockstep holds by
// construction — not by a string-containment test.
//
// DEFENSIVE CLAMPS (§11 change 4): ydoc params are NOT range-validated (only
// CV writes are clamped, by scaleCv), so the masks clamp thr/soft/amount to
// the declared param ranges as the last line of defense — preserving the
// exact semantics the per-module shaders had before the extraction.
//
// ACHROMATIC KEYS: kcChromaMask floors the key's chroma magnitude at
// KEY_ACHROMATIC_FLOOR (0.05). A neutral (black/white/gray) key colour has
// ~zero chroma, so with the floored normalizer EVERY neutral pixel measures
// as "at the key" and ALL neutrals key out together, regardless of luma —
// an achromatic key cannot separate black from white. Use LUMAKEY for
// black/white-backdrop keying (documented on CHROMAKEY's card docs).
//
// Consumers today: CHROMAKEY (kcChromaMask + kcDespill + kcComposite),
// LUMAKEY (kcLuma + kcLumaMask + kcComposite). Future adopters (§8 of the
// design): QUADRALOGICAL edge-fx, TOYBOX combine ops, and the Rec.601-weight
// re-exports in MAPPER / EDGES / FREEZEFRAME.

/** Rec. 601 luma weights — the app-wide luminance flavor (12+ video modules
 *  use exactly these; keep 601, document per-module). */
export const KEY_LUMA_WEIGHTS: readonly [number, number, number] = [0.299, 0.587, 0.114];

/** Full-swing Rec. 601 chroma scale factors: Cb = (B'-Y')*CB, Cr = (R'-Y')*CR. */
export const KEY_CB_SCALE = 0.564;
export const KEY_CR_SCALE = 0.713;

/** Softness floor — keeps smoothstep's edges strictly ordered so soft = 0
 *  degrades to a (numerically safe) hard cut, same value the per-module
 *  shaders used before the extraction. */
export const KEY_SOFT_MIN = 0.001;

/** Floor on the key colour's chroma magnitude in kcChromaMask's normalizer.
 *  See the ACHROMATIC KEYS note above. */
export const KEY_ACHROMATIC_FLOOR = 0.05;

// ── GLSL — interpolate into a consumer module's FRAG_SRC ────────────────────
//
// All numeric constants are template-interpolated from the TS exports above,
// so the GLSL cannot drift from the unit-tested mirrors.

export const GLSL_KEY_HELPERS = /* glsl */ `
const vec3 KC_LUMA_W = vec3(${KEY_LUMA_WEIGHTS[0]}, ${KEY_LUMA_WEIGHTS[1]}, ${KEY_LUMA_WEIGHTS[2]});

// Rec. 601 luma Y' of a gamma-encoded R'G'B' triple.
float kcLuma(vec3 c) { return dot(c, KC_LUMA_W); }

// Full-swing Rec. 601 chroma coordinates (Cb, Cr) of an R'G'B' triple.
vec2 kcChroma(vec3 c) {
  float y = kcLuma(c);
  return vec2((c.b - y) * ${KEY_CB_SCALE}, (c.r - y) * ${KEY_CR_SCALE});
}

// LUMA MASK — the canonical centered smoothstep window (bit-compatible with
// LUMAKEY's historical expression). invert > 0.5 flips the matte.
float kcLumaMask(float luma, float thr, float soft, float invert) {
  float t = clamp(thr, 0.0, 1.0);
  float s = max(clamp(soft, 0.0, 0.5), ${KEY_SOFT_MIN});
  float a = smoothstep(t - s, t + s, luma);
  return invert > 0.5 ? 1.0 - a : a;
}

// CHROMA MASK — key-relative chroma-plane distance (Vlahos-style): 0 at the
// key colour, EXACTLY 1.0 for neutral grays vs a saturated key. Low-chroma
// pixels are inherently far from a saturated key -> no saturation gate.
float kcChromaMask(vec3 c, vec3 key, float thr, float soft, float invert) {
  vec2 kc = kcChroma(key);
  float d = distance(kcChroma(c), kc) / max(length(kc), ${KEY_ACHROMATIC_FLOOR});
  float t = clamp(thr, 0.0, 1.0);
  float s = max(clamp(soft, 0.0, 0.5), ${KEY_SOFT_MIN});
  float a = smoothstep(t, t + s, d);
  return invert > 0.5 ? 1.0 - a : a;
}

// DESPILL — limit the key's dominant channel (standard min-limit despill,
// e.g. green key: g' = min(g, max(r, b)), lerped by amount). EXACT identity
// at amount = 0. Ties resolve green > blue > red (a pure key colour always
// picks its own channel).
vec3 kcDespill(vec3 c, vec3 key, float amount) {
  float amt = clamp(amount, 0.0, 1.0);
  if (key.g >= key.r && key.g >= key.b) {
    float lim = max(c.r, c.b);
    return vec3(c.r, mix(c.g, min(c.g, lim), amt), c.b);
  } else if (key.b >= key.r) {
    float lim = max(c.r, c.g);
    return vec3(c.r, c.g, mix(c.b, min(c.b, lim), amt));
  }
  float lim = max(c.g, c.b);
  return vec3(mix(c.r, min(c.r, lim), amt), c.g, c.b);
}

// COMPOSITE — alpha = fg opacity. The one blessed compositing line.
vec3 kcComposite(vec3 bg, vec3 fg, float alpha) { return mix(bg, fg, alpha); }
`;

// ── Pure TS mirrors (the unit-tested source of truth) ───────────────────────

export type KcVec3 = readonly [number, number, number];

const clamp = (x: number, lo: number, hi: number): number =>
  x < lo ? lo : x > hi ? hi : x;

/** GLSL-identical smoothstep. Callers guarantee e1 > e0 (the soft floor). */
export function kcSmoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Rec. 601 luma Y' of a gamma-encoded R'G'B' triple. */
export function kcLuma(c: KcVec3): number {
  return c[0] * KEY_LUMA_WEIGHTS[0] + c[1] * KEY_LUMA_WEIGHTS[1] + c[2] * KEY_LUMA_WEIGHTS[2];
}

/** Full-swing Rec. 601 chroma coordinates (Cb, Cr) of an R'G'B' triple. */
export function kcChroma(c: KcVec3): [number, number] {
  const y = kcLuma(c);
  return [(c[2] - y) * KEY_CB_SCALE, (c[0] - y) * KEY_CR_SCALE];
}

/** The canonical centered smoothstep luma window; invert > 0.5 flips. */
export function kcLumaMask(luma: number, thr: number, soft: number, invert: number): number {
  const t = clamp(thr, 0, 1);
  const s = Math.max(clamp(soft, 0, 0.5), KEY_SOFT_MIN);
  const a = kcSmoothstep(t - s, t + s, luma);
  return invert > 0.5 ? 1 - a : a;
}

/** Normalized key-relative chroma-plane distance (exposed for tests/probes):
 *  0 at the key colour, exactly 1.0 for a neutral gray vs a saturated key. */
export function kcChromaDistance(c: KcVec3, key: KcVec3): number {
  const [cb, cr] = kcChroma(c);
  const [kb, kr] = kcChroma(key);
  const d = Math.hypot(cb - kb, cr - kr);
  return d / Math.max(Math.hypot(kb, kr), KEY_ACHROMATIC_FLOOR);
}

/** Key-relative chroma-plane mask; invert > 0.5 flips. */
export function kcChromaMask(
  c: KcVec3,
  key: KcVec3,
  thr: number,
  soft: number,
  invert: number,
): number {
  const d = kcChromaDistance(c, key);
  const t = clamp(thr, 0, 1);
  const s = Math.max(clamp(soft, 0, 0.5), KEY_SOFT_MIN);
  const a = kcSmoothstep(t, t + s, d);
  return invert > 0.5 ? 1 - a : a;
}

/** Dominant-channel min-limit despill. EXACT identity at amount = 0. */
export function kcDespill(c: KcVec3, key: KcVec3, amount: number): [number, number, number] {
  const amt = clamp(amount, 0, 1);
  const mix = (a: number, b: number, t: number): number => a + (b - a) * t;
  if (key[1] >= key[0] && key[1] >= key[2]) {
    const lim = Math.max(c[0], c[2]);
    return [c[0], mix(c[1], Math.min(c[1], lim), amt), c[2]];
  } else if (key[2] >= key[0]) {
    const lim = Math.max(c[0], c[1]);
    return [c[0], c[1], mix(c[2], Math.min(c[2], lim), amt)];
  }
  const lim = Math.max(c[1], c[2]);
  return [mix(c[0], Math.min(c[0], lim), amt), c[1], c[2]];
}

/** out = mix(bg, fg, alpha). */
export function kcComposite(bg: KcVec3, fg: KcVec3, alpha: number): [number, number, number] {
  return [
    bg[0] + (fg[0] - bg[0]) * alpha,
    bg[1] + (fg[1] - bg[1]) * alpha,
    bg[2] + (fg[2] - bg[2]) * alpha,
  ];
}
