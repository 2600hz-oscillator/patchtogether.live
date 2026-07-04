// packages/web/src/lib/video/colourofmagic-colorspace.ts
//
// COLOUR OF MAGIC — pure colorspace core. A 1:1 TS MIRROR of the GLSL in
// modules/colourofmagic.ts (house pattern: mappy-homography.ts /
// vfpga snapshot). NO WebGL here — pure functions the unit suite pins to
// known colorspace values (pure red → HSV(0,1,1); YDbDr of white = (1,0,0);
// hue wraparound; over/clamp). The GLSL copies these constants byte-for-byte
// (never re-derived), and this core is the REAL correctness gate — not the
// SwiftShader GPU.
//
// SIGNAL MODEL (informed by, not copied from, LZX Swatch): each block encodes
// the source into its colorspace, adjusts each component in a UNIPOLAR 0..1
// signal space (bipolar chroma carried on a 0.5 pedestal), then decodes back
// to RGB. OVER wraps out-of-range values (fract); CLAMP clips them (the LZX
// chroma-wrap vs legal-clip look). Hue ALWAYS wraps.

export type Vec3 = [number, number, number];

/** Rec. 601 luma weights. */
export const W601: readonly [number, number, number] = [0.299, 0.587, 0.114];

// ── scalar helpers (match the GLSL builtins) ──
const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
/** GLSL fract(x) = x - floor(x); fract(-0.1) = 0.9 (wraps negatives up). */
const fract = (v: number): number => v - Math.floor(v);
/** GLSL mod(a,b) = a - b*floor(a/b) (positive result for negative a). */
const glslMod = (a: number, b: number): number => a - b * Math.floor(a / b);
/** GLSL mix(a,b,t). Callers here pass t∈{0,1}, so it is exact. */
const mix = (a: number, b: number, t: number): number => a + (b - a) * t;

// ─────────────────────────── YDbDr (SECAM) ───────────────────────────
//
// Dot form (NOT the transposed chromarot mat3). Constants copied verbatim
// into the GLSL rgb2ydbdr / ydbdr2rgb.

export function rgb2ydbdr(c: Vec3): Vec3 {
  return [
    c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114,
    c[0] * -0.450 + c[1] * -0.883 + c[2] * 1.333,
    c[0] * -1.333 + c[1] * 1.116 + c[2] * 0.217,
  ];
}

/** y = (Y, Db, Dr). */
export function ydbdr2rgb(y: Vec3): Vec3 {
  return [
    y[0] - 0.525912 * y[2],
    y[0] - 0.129133 * y[1] + 0.267899 * y[2],
    y[0] + 0.664679 * y[1],
  ];
}

/** Pack ±1.333 chroma into [0,1] with a 0.5 pedestal (K=0.375); Y identity. */
export function packYdbdr(y: Vec3): Vec3 {
  return [y[0], y[1] * 0.375 + 0.5, y[2] * 0.375 + 0.5];
}
export function unpackYdbdr(n: Vec3): Vec3 {
  return [n[0], (n[1] - 0.5) * 2.66667, (n[2] - 0.5) * 2.66667];
}

// ─────────────────────────── YIQ (NTSC composite) ───────────────────────────
//
// The 1953 FCC / Rec.601 YIQ matrix. Its I/Q axes are the YDbDr B−Y / R−Y plane
// ROTATED ~33° onto the orange↔cyan flesh-tone line (I) and green↔magenta (Q) —
// a genuinely new chroma axis, not a rescale of the SECAM block. Constants copied
// VERBATIM into the GLSL rgb2yiq / yiq2rgb (never re-derived). I/Q ride a 0.5
// pedestal; pack scales fill 0..1 (K_I = 0.5/0.5959 = 0.8391, K_Q = 0.5/0.5227 =
// 0.9566), unpack uses the reciprocals so pack∘unpack == identity within epsilon
// (the same truncated-reciprocal idiom YDbDr uses with 0.375 / 2.66667).

export function rgb2yiq(c: Vec3): Vec3 {
  return [
    c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114, // Y  Rec.601 luma
    c[0] * 0.5959 + c[1] * -0.2746 + c[2] * -0.3213, // I  orange<->cyan (flesh)
    c[0] * 0.2115 + c[1] * -0.5227 + c[2] * 0.3112, // Q  green<->magenta
  ];
}

/** y = (Y, I, Q). Exact FCC inverse. */
export function yiq2rgb(y: Vec3): Vec3 {
  return [
    y[0] + 0.9563 * y[1] + 0.621 * y[2],
    y[0] - 0.2721 * y[1] - 0.6474 * y[2],
    y[0] - 1.107 * y[1] + 1.7046 * y[2],
  ];
}

export function packYiq(y: Vec3): Vec3 {
  return [y[0], y[1] * 0.8391 + 0.5, y[2] * 0.9566 + 0.5];
}
export function unpackYiq(n: Vec3): Vec3 {
  return [n[0], (n[1] - 0.5) * (1.0 / 0.8391), (n[2] - 0.5) * (1.0 / 0.9566)];
}

// ─────────────────────────── YCbCr BT.601 STUDIO-SWING ───────────────────────────
//
// Broadcast-legal levels: encode COMPRESSES the picture into the 16..235 luma /
// 16..240 chroma legal window (footroom below, headroom above), decode EXPANDS
// studio→full-range (×255/219 luma, ×255/224 chroma) so every bias is amplified
// ~1.16× — the hard broadcast CRUSH — and over-drive CLAMPs at the illegal
// boundary (a legalizer) or WRAPs super-white through black (the over-legal fold).
// The pack IS the encode (levels baked in); there is no separate pack fn. Chroma
// neutral is 128/255 = 0.502 — the authentic 8-bit digital chroma zero, NOT
// exactly 0.5 (self-consistent; do not "fix" it). Constants copied verbatim into
// the GLSL rgb2ycc_ss / ycc_ss2rgb.

export function rgb2yccSs(c: Vec3): Vec3 {
  const Yf = c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114; // full-range luma 0..1
  const Pb = c[0] * -0.168736 + c[1] * -0.331264 + c[2] * 0.5; // +/-0.5
  const Pr = c[0] * 0.5 + c[1] * -0.418688 + c[2] * -0.081312; // +/-0.5
  return [
    16.0 / 255.0 + (219.0 / 255.0) * Yf, // luma -> footroom/headroom
    128.0 / 255.0 + (224.0 / 255.0) * Pb, // Cb -> 16..240, pedestal 0.502
    128.0 / 255.0 + (224.0 / 255.0) * Pr, // Cr
  ];
}

/** s = encoded studio-swing [Y, Cb, Cr] in 0..1. Expand + inverse BT.601. */
export function yccSs2rgb(s: Vec3): Vec3 {
  const y = (s[0] - 16.0 / 255.0) * (255.0 / 219.0); // expand: the ~1.16x crush
  const cb = (s[1] - 128.0 / 255.0) * (255.0 / 224.0); // -> +/-0.5 (illegal > +/-0.5)
  const cr = (s[2] - 128.0 / 255.0) * (255.0 / 224.0);
  return [
    y + 1.402 * cr,
    y - 0.344136 * cb - 0.714136 * cr,
    y + 1.772 * cb,
  ];
}

// ─────────────────────────── HSV (branchless) ───────────────────────────
//
// The Sam Hocevar branchless form; a 1:1 mirror of the GLSL (K-vector +
// swizzle) so the shader and this core agree bit-for-bit. Matches
// hsvshift / cellshade.

export function rgb2hsv(c: Vec3): Vec3 {
  const K: [number, number, number, number] = [0, -1 / 3, 2 / 3, -1];
  const [r, g, b] = c;
  // step(c.b, c.g): c.g >= c.b ? 1 : 0
  const t1 = g >= b ? 1 : 0;
  // p = mix( vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b,c.g) )
  const A: [number, number, number, number] = [b, g, K[3], K[2]];
  const B: [number, number, number, number] = [g, b, K[0], K[1]];
  const p: [number, number, number, number] = [
    mix(A[0], B[0], t1),
    mix(A[1], B[1], t1),
    mix(A[2], B[2], t1),
    mix(A[3], B[3], t1),
  ];
  // step(p.x, c.r): c.r >= p.x ? 1 : 0
  const t2 = r >= p[0] ? 1 : 0;
  // q = mix( vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x,c.r) )
  const C: [number, number, number, number] = [p[0], p[1], p[3], r];
  const D: [number, number, number, number] = [r, p[1], p[2], p[0]];
  const q: [number, number, number, number] = [
    mix(C[0], D[0], t2),
    mix(C[1], D[1], t2),
    mix(C[2], D[2], t2),
    mix(C[3], D[3], t2),
  ];
  const e = 1e-10;
  const d = q[0] - Math.min(q[3], q[1]);
  const h = Math.abs(q[2] + (q[3] - q[1]) / (6 * d + e));
  const s = d / (q[0] + e);
  const v = q[0];
  return [h, s, v];
}

export function hsv2rgb(c: Vec3): Vec3 {
  const [h, s, v] = c;
  // K = vec4(1., 2./3., 1./3., 3.); p = abs(fract(h + K.xyz)*6 - K.www)
  const px = Math.abs(fract(h + 1) * 6 - 3);
  const py = Math.abs(fract(h + 2 / 3) * 6 - 3);
  const pz = Math.abs(fract(h + 1 / 3) * 6 - 3);
  // v * mix(K.xxx=1, clamp(p-1,0,1), s)
  return [
    v * mix(1, clamp01(px - 1), s),
    v * mix(1, clamp01(py - 1), s),
    v * mix(1, clamp01(pz - 1), s),
  ];
}

// ─────────────────────────── HSL (independent, exact) ───────────────────────────

export function rgb2hsl(c: Vec3): Vec3 {
  const [r, g, b] = c;
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const C = mx - mn;
  const L = (mx + mn) * 0.5;
  const S = L <= 0 || L >= 1 ? 0 : C / (1 - Math.abs(2 * L - 1));
  let H = 0;
  if (C > 1e-10) {
    if (mx === r) H = glslMod((g - b) / C, 6);
    else if (mx === g) H = (b - r) / C + 2;
    else H = (r - g) / C + 4;
    H /= 6;
    if (H < 0) H += 1;
  }
  return [H, S, L];
}

export function hsl2rgb(hsl: Vec3): Vec3 {
  const [H, S, L] = hsl;
  const C = (1 - Math.abs(2 * L - 1)) * S;
  const X = C * (1 - Math.abs(glslMod(H * 6, 2) - 1));
  const m = L - 0.5 * C;
  const h6 = H * 6;
  let base: Vec3;
  if (h6 < 1) base = [C, X, 0];
  else if (h6 < 2) base = [X, C, 0];
  else if (h6 < 3) base = [0, C, X];
  else if (h6 < 4) base = [0, X, C];
  else if (h6 < 5) base = [X, 0, C];
  else base = [C, 0, X];
  return [base[0] + m, base[1] + m, base[2] + m];
}

// ─────────────────────────── per-channel adjust ───────────────────────────
//
// v: base channel (packed 0..1). mono: sampled override (.r) or null = not
// patched. OVER wraps (fract), CLAMP clips. Identity at bias=0/no-mono/clamp.

export function adj(v: number, bias: number, over: boolean, mono: number | null): number {
  const x = (mono !== null ? mono : v) + bias;
  return over ? fract(x) : clamp01(x);
}
/** Hue: mono override + degree bias / 360, ALWAYS wrapped (fract). */
export function adjHue(v: number, biasDeg: number, mono: number | null): number {
  const x = (mono !== null ? mono : v) + biasDeg / 360;
  return fract(x);
}

// ─────────────────────────── palette REPLACE (RGB block) ───────────────────────────
//
// A duotone/tritone-style remap: recompose the image from three PICKED
// palette colours weighted by the (adjusted) R/G/B channel values —
// out = palR·a.r + palG·a.g + palB·a.b. At the identity default the picks are
// pure red/green/blue so REPLACE = passthrough of the RGB block. Applies ONLY
// to the RGB colorized out (mode 1); the mono r/g/b/luma outs stay raw
// channels. (Owner addendum 2026-07-03.)

/** Pack an 0..1 RGB triplet into a 0xRRGGBB integer (picker-friendly param). */
export function packColor01(r: number, g: number, b: number): number {
  const q = (v: number): number => Math.max(0, Math.min(255, Math.round(clamp01(v) * 255)));
  return (q(r) << 16) | (q(g) << 8) | q(b);
}
/** Unpack a 0xRRGGBB integer into an 0..1 RGB triplet (NaN-safe → black). */
export function unpackColor01(packed: number): Vec3 {
  const p = Number.isFinite(packed) ? Math.max(0, Math.min(0xffffff, Math.round(packed))) : 0;
  return [((p >> 16) & 0xff) / 255, ((p >> 8) & 0xff) / 255, (p & 0xff) / 255];
}

// ─────────────────────────── block evaluators ───────────────────────────
//
// These return the same RGB the shader produces. The GLSL rgbBlock /
// ydbdrBlock / hsvBlock reproduce them branch-for-branch.

export interface BlockParams {
  biasR: number; biasG: number; biasB: number;
  biasY: number; biasDb: number; biasDr: number;
  /** Hue bias in DEGREES (÷360 in adjHue). */
  biasH: number; biasS: number; biasV: number;
  /** YIQ block bias (packed 0..1 space; I/Q on the 0.5 pedestal). */
  biasYiqY: number; biasYiqI: number; biasYiqQ: number;
  /** YCbCr studio-swing block bias (encoded legal-range space). */
  biasYccY: number; biasYccCb: number; biasYccCr: number;
  overR: boolean; overG: boolean; overB: boolean;
  overY: boolean; overDb: boolean; overDr: boolean;
  overS: boolean; overV: boolean; // hue always wraps (no overH)
  overYiqY: boolean; overYiqI: boolean; overYiqQ: boolean;
  overYccY: boolean; overYccCb: boolean; overYccCr: boolean;
  /** false = HSV, true = HSL. */
  hsl: boolean;
  /** RGB palette REPLACE on/off + the three picked colours (0..1 RGB). */
  replace: boolean;
  palR: Vec3; palG: Vec3; palB: Vec3;
  /** Per-channel mono overrides (.r sample) or null = not patched. */
  monoR: number | null; monoG: number | null; monoB: number | null;
  monoY: number | null; monoDb: number | null; monoDr: number | null;
  monoH: number | null; monoS: number | null; monoV: number | null;
  monoYiqY: number | null; monoYiqI: number | null; monoYiqQ: number | null;
  monoYccY: number | null; monoYccCb: number | null; monoYccCr: number | null;
}

/** The RAW adjusted RGB channel SCALARS (feeds the mono r/g/b/luma outs). */
export function rgbChannels(src: Vec3, p: BlockParams): Vec3 {
  return [
    adj(src[0], p.biasR, p.overR, p.monoR),
    adj(src[1], p.biasG, p.overG, p.monoG),
    adj(src[2], p.biasB, p.overB, p.monoB),
  ];
}

/** REPLACE remap of the adjusted channels (identity when replace=false). */
export function applyPalette(a: Vec3, p: BlockParams): Vec3 {
  if (!p.replace) return a;
  return [
    p.palR[0] * a[0] + p.palG[0] * a[1] + p.palB[0] * a[2],
    p.palR[1] * a[0] + p.palG[1] * a[1] + p.palB[1] * a[2],
    p.palR[2] * a[0] + p.palG[2] * a[1] + p.palB[2] * a[2],
  ];
}

/** The RGB block COLOUR out (adjusted channels, then optional palette remap). */
export function rgbBlock(src: Vec3, p: BlockParams): Vec3 {
  return applyPalette(rgbChannels(src, p), p);
}

/** The RAW adjusted PACKED YDbDr channel SCALARS (feeds the ydb_y/db/dr taps). */
export function ydbdrChannels(src: Vec3, p: BlockParams): Vec3 {
  const n = packYdbdr(rgb2ydbdr(src));
  return [
    adj(n[0], p.biasY, p.overY, p.monoY),
    adj(n[1], p.biasDb, p.overDb, p.monoDb),
    adj(n[2], p.biasDr, p.overDr, p.monoDr),
  ];
}

export function ydbdrBlock(src: Vec3, p: BlockParams): Vec3 {
  return ydbdr2rgb(unpackYdbdr(ydbdrChannels(src, p)));
}

/** The RAW adjusted HSV/HSL channel SCALARS (feeds the hsv_h/s/v taps). The hue
 *  tap has a hard black↔white seam at 0≡1 — the correct grayscale image of a
 *  CIRCULAR quantity, not a defect (treat it as circular downstream). */
export function hsvChannels(src: Vec3, p: BlockParams): Vec3 {
  const h = p.hsl ? rgb2hsl(src) : rgb2hsv(src);
  return [
    adjHue(h[0], p.biasH, p.monoH),
    adj(h[1], p.biasS, p.overS, p.monoS),
    adj(h[2], p.biasV, p.overV, p.monoV),
  ];
}

export function hsvBlock(src: Vec3, p: BlockParams): Vec3 {
  const a = hsvChannels(src, p);
  return p.hsl ? hsl2rgb(a) : hsv2rgb(a);
}

/** The RAW adjusted PACKED YIQ channel SCALARS (feeds the yiq_y/i/q taps). */
export function yiqChannels(src: Vec3, p: BlockParams): Vec3 {
  const n = packYiq(rgb2yiq(src));
  return [
    adj(n[0], p.biasYiqY, p.overYiqY, p.monoYiqY),
    adj(n[1], p.biasYiqI, p.overYiqI, p.monoYiqI),
    adj(n[2], p.biasYiqQ, p.overYiqQ, p.monoYiqQ),
  ];
}

export function yiqBlock(src: Vec3, p: BlockParams): Vec3 {
  return yiq2rgb(unpackYiq(yiqChannels(src, p)));
}

/** The RAW adjusted ENCODED studio-swing channel SCALARS (feeds ycc_y/cb/cr).
 *  The encode's legal-range levels are baked in (no separate pack). */
export function yccSsChannels(src: Vec3, p: BlockParams): Vec3 {
  const n = rgb2yccSs(src);
  return [
    adj(n[0], p.biasYccY, p.overYccY, p.monoYccY),
    adj(n[1], p.biasYccCb, p.overYccCb, p.monoYccCb),
    adj(n[2], p.biasYccCr, p.overYccCr, p.monoYccCr),
  ];
}

export function yccSsBlock(src: Vec3, p: BlockParams): Vec3 {
  return yccSs2rgb(yccSsChannels(src, p));
}

/** Drive the uOutMode dispatch:
 *   0 pass, 1 rgb(+palette), 2 ydbdr, 3 hsv/hsl,
 *   4/5/6 mono r/g/b (raw adjusted channel), 7 luma of the adjusted channels,
 *   8/9/10 ydbdr y/db/dr taps, 11/12/13 hsv h/s/v taps,
 *   14 yiq colour, 15/16/17 yiq y/i/q taps,
 *   18 ycc studio-swing colour, 19/20/21 ycc y/cb/cr taps.
 *  Palette REPLACE affects ONLY the rgb colour out (mode 1). The mono taps
 *  emit the adjusted PACKED channel as grayscale (vec3(v)) — no decode. */
export function outputFor(mode: number, src: Vec3, p: BlockParams): Vec3 {
  if (mode === 0) return src;
  if (mode === 2) return ydbdrBlock(src, p);
  if (mode === 3) return hsvBlock(src, p);
  if (mode === 14) return yiqBlock(src, p);
  if (mode === 18) return yccSsBlock(src, p);
  // Grayscale channel taps: emit the adjusted PACKED channel (no decode).
  if (mode >= 8 && mode <= 10) { const v = ydbdrChannels(src, p)[mode - 8]!; return [v, v, v]; }
  if (mode >= 11 && mode <= 13) { const v = hsvChannels(src, p)[mode - 11]!; return [v, v, v]; }
  if (mode >= 15 && mode <= 17) { const v = yiqChannels(src, p)[mode - 15]!; return [v, v, v]; }
  if (mode >= 19 && mode <= 21) { const v = yccSsChannels(src, p)[mode - 19]!; return [v, v, v]; }
  // RGB family: 1 rgb(+palette), 4/5/6 mono r/g/b, 7 luma.
  const a = rgbChannels(src, p);
  if (mode === 1) return applyPalette(a, p);
  if (mode === 4) return [a[0], a[0], a[0]];
  if (mode === 5) return [a[1], a[1], a[1]];
  if (mode === 6) return [a[2], a[2], a[2]];
  const l = a[0] * W601[0] + a[1] * W601[1] + a[2] * W601[2];
  return [l, l, l];
}
