// EDGEFADER — a two-source video crossfader that fades THROUGH THE EDGES.
//
// ── SIGNAL FLOW
//   in_a, in_b ──▶ [Sobel + threshold + separable dilate on BOTH, packed] ──▶ atlas
//   in_a, in_b ──▶ [copy + mip chain] ──▶ soft A / soft B (the progressive blur)
//   in_a, in_b, atlas, soft, fader, melt ──▶ [cascading edge-led composite] ──▶ out
//
//   * Both sources get the EDGES operator (same Rec. 601 luma, Sobel kernel,
//     normalisation, THRESHOLD gate and THICKNESS dilation, at full engine
//     resolution) packed into ONE atlas: R = A's edges, G = B's edges, B =
//     where the two COINCIDE, and the atlas's mip chain gives the coarse
//     density of each — a region whose edges mostly coincide (THICK sets the
//     tolerance) is one where A and B are alike in where their edges sit, and
//     those regions lead the fade.
//   * The FADER (0 = only A, 1 = only B) drives a CASCADE down the frame: five
//     20 % bands, each fading over its own window of the fader's travel, the
//     next band starting when the previous is half done (interpolated between
//     band centres so there is no seam). Within a band edged pixels fade first
//     (coincident edges first of all), similar regions lead flat ones, a pixel
//     just INSIDE one of A's edges (centre-ward of it) leads one just OUTSIDE,
//     and flat regions follow — the fade ripples down the edges, top to bottom.
//     The top three quarters of each band start as a unit (the five regions
//     stay visible as regions); the bottom quarter ramps to the next band's
//     start so the boundary is a hand-over, not a seam.
//   * The operator is a mid-fade BLUR around the edges (a mip read of the
//     soft layers at a radius that peaks mid-way, weighted by a wider edge
//     PROXIMITY field so the region around a stroke softens, not just the
//     stroke), or — with MELT engaged by the toggle OR its gate — a per-column
//     liquid slide with droplet tongues that carry each melting band down into
//     the band below. Slid content is blended by the law of the row it CAME
//     FROM, so a band line is never a seam and A's edge mask never ghosts at
//     its old position.
//
// ── PRIOR ART (melt) — cited here once, in prose, never in an identifier:
//   id Software's 1993 screen melt (f_wipe.c: per-column random start, columns
//   accelerate downward, the new screen fills the vacated rows); the
//   gl-transitions port of that melt (Zeh Fernando, MIT) — the stateless
//   per-bar form sampled as `from(uv + phase)` vs `to(uv)`; gl-transitions
//   Dreamy (wobble amplitude ∝ progress so the endpoints stay exact); The Book
//   of Shaders ch. 11 value noise (what replaces the random walk between
//   columns); Inigo Quilez's 2-D SDFs (the droplet = a segment stalk ∪ a
//   circle head). Full list with URLs in the PR body.
//
// ── ARCHITECTURE: six passes, STATELESS
//   copy A, copy B        (engine res) → soft layers; mip chains regenerated
//                                        every frame.
//   SOBEL                 (engine res) → R/G = isEdge(A)/isEdge(B).
//   DILATE H, DILATE V    (engine res) → max over a (2r+1) run per axis (max
//                                        over a square is exactly separable),
//                                        r = round(thickness) − 1 (EDGES' law);
//                                        the V pass also writes B = min(R, G).
//   COMPOSITE             (engine res) → the per-pixel cascade/lead/blur-or-
//                                        melt law. It reads A and B through
//                                        the soft layers' level 0 (exact
//                                        copies), never the upstream textures,
//                                        so a graph cycle through OUT can
//                                        never make it a feedback loop.
//   Every term is a function of (A, B, fader, params, pixel) — no clock, no
//   previous frame, no Math.random — so a pinned engine renders the same frame
//   on every step and the module needs no `freeze`. The whole law lives in
//   edgefader-core.ts (pure, unit-pinned); the GLSL below is its port with the
//   constants interpolated from the SAME exports.
//
// Unpatched inputs sample an opaque-black 1×1 texture (the FADER precedent)
// and contribute NO edges (the Sobel pass is gated per input), so with
// nothing patched the output is black.

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';
import {
  EDGES_LUMA_WEIGHTS,
  EDGES_SOBEL_NORM,
  EDGES_DEFAULTS,
  EDGES_MAX_THICKNESS,
} from './edges';
import {
  EDGEFADER_BANDS,
  EDGEFADER_LOCAL_FRACTION,
  EDGEFADER_LEAD_EDGE,
  EDGEFADER_LEAD_COINCIDENCE,
  EDGEFADER_LEAD_SIMILARITY,
  EDGEFADER_LEAD_INSIDE,
  EDGEFADER_BLUR_MAX_PX,
  EDGEFADER_RAY_TAPS_PX,
  EDGEFADER_COARSE_PX,
  EDGEFADER_BLUR_PROX_PX,
  EDGEFADER_BLUR_PROX_FULL,
  EDGEFADER_BAND_UNIT_FRACTION,
  EDGEFADER_MELT_NOISE_COARSE,
  EDGEFADER_MELT_NOISE_FINE,
  EDGEFADER_MELT_LEN_LANES,
  EDGEFADER_MELT_DELAY_MAX,
  EDGEFADER_MELT_EDGE_BIAS,
  EDGEFADER_DRIP_MAX_UV,
  EDGEFADER_DRIP_MIN_FRAC,
  EDGEFADER_WOBBLE_UV,
  EDGEFADER_WOBBLE_FREQ,
  EDGEFADER_WOBBLE_RATE,
  EDGEFADER_MELT_OCTAVES,
  EDGEFADER_LANE_BIAS,
  EDGEFADER_TAU,
  EDGEFADER_HASH_MUL,
  EDGEFADER_FRONT_SOFT_UV,
  EDGEFADER_DROP_LANES,
  EDGEFADER_DROP_PROB,
  EDGEFADER_DROP_R_MIN,
  EDGEFADER_DROP_R_MAX,
  EDGEFADER_DROP_JITTER,
  EDGEFADER_DROP_LEN_MAX,
  EDGEFADER_DROP_STALK,
  EDGEFADER_SEEDS,
  cascadeProgress,
  dilateRadius,
} from './edgefader-core';

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
/** A number as a GLSL float literal (always carries a decimal point). */
const f = (x: number): string => {
  const s = String(x);
  return s.includes('.') || s.includes('e') ? s : `${s}.0`;
};

// ─────────────────────────── pass 0: COPY (soft layers) ─────────────────────

const COPY_FRAG_SRC = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;
void main() { outColor = vec4(texture(uTex, vUv).rgb, 1.0); }`;

// ─────────────────────────── pass 1: SOBEL ──────────────────────────────────

const SOBEL_FRAG_SRC = `#version 300 es
precision highp float;
precision highp int;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uTexA;
uniform sampler2D uTexB;
uniform float uHasA;
uniform float uHasB;
uniform vec2  uTexel;       // 1/engine res — one texel step (the EDGES step)
uniform float uThreshold;

const float LUMA_R = ${EDGES_LUMA_WEIGHTS[0]};
const float LUMA_G = ${EDGES_LUMA_WEIGHTS[1]};
const float LUMA_B = ${EDGES_LUMA_WEIGHTS[2]};
const float SOBEL_NORM = ${f(EDGES_SOBEL_NORM)};

float lumaAt(sampler2D t, vec2 uv) {
  return dot(texture(t, uv).rgb, vec3(LUMA_R, LUMA_G, LUMA_B));
}

// EDGES' normalised Sobel gradient magnitude (0..~1).
float sobelMag(sampler2D t, vec2 uv) {
  float tl = lumaAt(t, uv + uTexel * vec2(-1.0, -1.0));
  float  tt = lumaAt(t, uv + uTexel * vec2( 0.0, -1.0));
  float tr = lumaAt(t, uv + uTexel * vec2( 1.0, -1.0));
  float  l = lumaAt(t, uv + uTexel * vec2(-1.0,  0.0));
  float  r = lumaAt(t, uv + uTexel * vec2( 1.0,  0.0));
  float bl = lumaAt(t, uv + uTexel * vec2(-1.0,  1.0));
  float  bb = lumaAt(t, uv + uTexel * vec2( 0.0,  1.0));
  float br = lumaAt(t, uv + uTexel * vec2( 1.0,  1.0));
  float gx = (tr + 2.0 * r + br) - (tl + 2.0 * l + bl);
  float gy = (bl + 2.0 * bb + br) - (tl + 2.0 * tt + tr);
  return sqrt(gx * gx + gy * gy) / SOBEL_NORM;
}

void main() {
  float ea = (uHasA > 0.5 && sobelMag(uTexA, vUv) >= uThreshold) ? 1.0 : 0.0;
  float eb = (uHasB > 0.5 && sobelMag(uTexB, vUv) >= uThreshold) ? 1.0 : 0.0;
  outColor = vec4(ea, eb, 0.0, 1.0);
}`;

// ─────────────────────────── pass 2: DILATE (separable) ─────────────────────

const DILATE_FRAG_SRC = `#version 300 es
precision highp float;
precision highp int;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uEdges;
uniform vec2  uStep;        // one texel along the pass axis ((1/W, 0) or (0, 1/H))
uniform int   uRadius;      // 0..MAX_R texels (dilateRadius(thickness))
uniform float uWriteCoinc;  // the LAST pass writes B = min(R, G) — the coincidence

const int MAX_R = ${EDGES_MAX_THICKNESS - 1};

void main() {
  float a = 0.0;
  float b = 0.0;
  for (int d = -MAX_R; d <= MAX_R; d++) {
    if (d < -uRadius || d > uRadius) continue;
    vec2 e = textureLod(uEdges, vUv + uStep * float(d), 0.0).rg;
    a = max(a, e.r);
    b = max(b, e.g);
  }
  outColor = vec4(a, b, uWriteCoinc > 0.5 ? min(a, b) : 0.0, 1.0);
}`;

// ─────────────────────────── pass 3: COMPOSITE ──────────────────────────────

const RAY_TAPS_GLSL = EDGEFADER_RAY_TAPS_PX.map((t) => `
    toward = max(toward, edgeAAt((pPx + d * ${f(t)}) / uRes));
    away   = max(away,   edgeAAt((pPx - d * ${f(t)}) / uRes));`).join('');

const COMPOSITE_FRAG_SRC = `#version 300 es
precision highp float;
precision highp int;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uSoftA;   // copy of A (level 0 exact) with a mip chain (the progressive blur)
uniform sampler2D uSoftB;
uniform sampler2D uAtlas;   // R = dilated edge(A), G = dilated edge(B), B = min(R, G); mip chain = densities
uniform vec2  uRes;         // engine px
uniform float uT;           // fader 0..1
uniform float uMelt;        // >= 0.5 → MELT

const float N          = ${f(EDGEFADER_BANDS)};
const float RHO        = ${f(EDGEFADER_LOCAL_FRACTION)};
const float UNIT_FRAC  = ${f(EDGEFADER_BAND_UNIT_FRACTION)};
const float LEAD_EDGE  = ${f(EDGEFADER_LEAD_EDGE)};
const float LEAD_COINC = ${f(EDGEFADER_LEAD_COINCIDENCE)};
const float LEAD_SIM   = ${f(EDGEFADER_LEAD_SIMILARITY)};
const float LEAD_IN    = ${f(EDGEFADER_LEAD_INSIDE)};
const float BLUR_MAX   = ${f(EDGEFADER_BLUR_MAX_PX)};
const float COARSE_LOD = ${f(Math.log2(EDGEFADER_COARSE_PX))};
const float PROX_LOD   = ${f(Math.log2(EDGEFADER_BLUR_PROX_PX))};
const float PROX_FULL  = ${f(EDGEFADER_BLUR_PROX_FULL)};
const float NOISE_C    = ${f(EDGEFADER_MELT_NOISE_COARSE)};
const float NOISE_F    = ${f(EDGEFADER_MELT_NOISE_FINE)};
const float OCT_C      = ${f(EDGEFADER_MELT_OCTAVES[0])};
const float OCT_F      = ${f(EDGEFADER_MELT_OCTAVES[1])};
const float LEN_LANES  = ${f(EDGEFADER_MELT_LEN_LANES)};
const float DELAY_MAX  = ${f(EDGEFADER_MELT_DELAY_MAX)};
const float EDGE_BIAS  = ${f(EDGEFADER_MELT_EDGE_BIAS)};
const float DRIP_MAX   = ${f(EDGEFADER_DRIP_MAX_UV)};
const float DRIP_MIN   = ${f(EDGEFADER_DRIP_MIN_FRAC)};
const float WOBBLE     = ${f(EDGEFADER_WOBBLE_UV)};
const float WOB_FREQ   = ${f(EDGEFADER_WOBBLE_FREQ)};
const float WOB_RATE   = ${f(EDGEFADER_WOBBLE_RATE)};
const float FRONT_SOFT = ${f(EDGEFADER_FRONT_SOFT_UV)};
const float LANES      = ${f(EDGEFADER_DROP_LANES)};
const float LANE_BIAS  = ${f(EDGEFADER_LANE_BIAS)};
const float DROP_PROB  = ${f(EDGEFADER_DROP_PROB)};
const float DROP_R_MIN = ${f(EDGEFADER_DROP_R_MIN)};
const float DROP_R_MAX = ${f(EDGEFADER_DROP_R_MAX)};
const float DROP_JIT   = ${f(EDGEFADER_DROP_JITTER)};
const float DROP_LEN   = ${f(EDGEFADER_DROP_LEN_MAX)};
const float DROP_STALK = ${f(EDGEFADER_DROP_STALK)};
const float TAU        = ${f(EDGEFADER_TAU)};
const uint HASH_M0 = ${EDGEFADER_HASH_MUL[0]}u;
const uint HASH_M1 = ${EDGEFADER_HASH_MUL[1]}u;
const uint HASH_M2 = ${EDGEFADER_HASH_MUL[2]}u;
const int SEED_DELAY_C = ${EDGEFADER_SEEDS.delayCoarse};
const int SEED_DELAY_F = ${EDGEFADER_SEEDS.delayFine};
const int SEED_LEN     = ${EDGEFADER_SEEDS.len};
const int SEED_WOBBLE  = ${EDGEFADER_SEEDS.wobble};
const int SEED_HAS     = ${EDGEFADER_SEEDS.dropHas};
const int SEED_X       = ${EDGEFADER_SEEDS.dropX};
const int SEED_R       = ${EDGEFADER_SEEDS.dropR};
const int SEED_DLEN    = ${EDGEFADER_SEEDS.dropLen};

float clamp01(float x) { return clamp(x, 0.0, 1.0); }

// softStep — smoothstep with the e0 == e1 case made a hard step.
float softStep(float e0, float e1, float x) {
  float d = e1 - e0;
  if (d <= 1e-9) return x < e0 ? 0.0 : 1.0;
  float u = clamp01((x - e0) / d);
  return u * u * (3.0 - 2.0 * u);
}

// meltHash — 32-bit integer hash, bit-exact with the CPU mirror (highp int).
float meltHash(int i, int seed) {
  uint h = uint(i) * HASH_M0 + uint(seed) * HASH_M1;
  h = (h ^ (h >> 13u)) * HASH_M2;
  h = h ^ (h >> 16u);
  return float(h & 0xffffffu) / 16777216.0;
}

float valueNoise(float x, int seed) {
  float i = floor(x);
  float fr = x - i;
  float u = fr * fr * (3.0 - 2.0 * fr);
  return mix(meltHash(int(i), seed), meltHash(int(i) + 1, seed), u);
}

// sdSegment — iq's distance to a segment a→b.
float sdSegment(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  float bb = dot(ba, ba);
  float h = bb <= 1e-12 ? 0.0 : clamp01(dot(pa, ba) / bb);
  return length(pa - ba * h);
}

// ── the cascade ──
float bandProgress(float t, float k) {
  float start = k / (N + 1.0);
  return clamp01((t - start) * (N + 1.0) * 0.5);
}
// rowStart — the top UNIT_FRAC of each band starts with the band; the rest
// ramps to the next band's start (a hand-over, not a seam).
float rowStart(float rowFromTop) {
  float scaled = rowFromTop * N;
  float k = floor(scaled);
  float fr = scaled - k;
  float c = clamp(k + softStep(UNIT_FRAC, 1.0, fr), 0.0, N - 1.0);
  return c / (N + 1.0);
}
float rowProgress(float t, float rowFromTop) {
  return clamp01((t - rowStart(rowFromTop)) * (N + 1.0) * 0.5);
}

// ── lead / local progress ──
// similarity — of all the edge in the cell, the share that COINCIDES.
float similarity(float densA, float densB, float densC) {
  float hi = max(densA, densB);
  if (hi <= 1e-6) return 0.0;
  return clamp01(densC / hi);
}
float blurWeight(float wProx, float wSim) {
  return max(softStep(0.0, PROX_FULL, wProx), clamp01(wSim));
}
float leadFor(float wEdge, float wCoinc, float wSim, float inside, float nearEdge) {
  float raw = wEdge * (LEAD_EDGE + LEAD_COINC * wCoinc) + LEAD_SIM * wSim + LEAD_IN * max(inside, 0.0) * nearEdge;
  float span = LEAD_EDGE + LEAD_COINC + LEAD_SIM + LEAD_IN;
  return clamp01(raw / span);
}
float localProgress(float pRow, float leadN) {
  float delay = 1.0 - clamp01(leadN);
  return clamp01((clamp01(pRow) - delay * (1.0 - RHO)) / RHO);
}
float blurRadiusPx(float pLocal, float wBlur) {
  float p = clamp01(pLocal);
  return BLUR_MAX * clamp01(wBlur) * 4.0 * p * (1.0 - p);
}
// The ray reads the OUTGOING frame's edges only (A's).
float edgeAAt(vec2 uv) {
  return textureLod(uAtlas, uv, 0.0).r;
}
// leadAt — the full lead of the pixel at uv: the atlas field, the coarse
// similarity, and the inside/outside ray in px space (the taps are the same
// length on both axes).
float leadAt(vec2 uv) {
  vec3 at = textureLod(uAtlas, uv, 0.0).rgb;
  float wEdge = max(at.r, at.g);
  float wCoinc = at.b;
  vec3 dens = textureLod(uAtlas, uv, COARSE_LOD).rgb;
  float wSim = similarity(dens.r, dens.g, dens.b);
  vec2 pPx = uv * uRes;
  vec2 d = 0.5 * uRes - pPx;
  float len = length(d);
  float toward = 0.0;
  float away = 0.0;
  if (len > 1e-6) {
    d /= len;${RAY_TAPS_GLSL}
  }
  float inside = away - toward;
  float nearEdge = max(toward, away);
  return leadFor(wEdge, wCoinc, wSim, inside, nearEdge);
}
// The progressive blur: the soft layer's mip chain read at log2(radius) px,
// faded in from the sharp sample (level 0) over the first px (continuous at
// r = 0 — the endpoints read level 0 exactly).
vec3 softSample(sampler2D soft, vec2 uv, float rPx) {
  vec3 s = textureLod(soft, uv, 0.0).rgb;
  if (rPx <= 0.0) return s;
  float lod = log2(max(rPx, 1.0));
  vec3 b = textureLod(soft, uv, lod).rgb;
  return mix(s, b, softStep(0.0, 1.0, rPx));
}

// ── melt geometry ──
float meltDelayNoise(float x01, int k) {
  return OCT_C * valueNoise(x01 * NOISE_C, SEED_DELAY_C + k) + OCT_F * valueNoise(x01 * NOISE_F, SEED_DELAY_F + k);
}
float meltColumnDensity(float x01, int k) {
  vec2 e = textureLod(uAtlas, vec2(x01, 1.0 - (float(k) + 0.5) / N), COARSE_LOD).rg;
  return max(e.r, e.g);
}
float meltColumnProgress(float x01, int k, float pBand, float edgeDensity) {
  float delay = DELAY_MAX * meltDelayNoise(x01, k) * (1.0 - EDGE_BIAS * clamp01(edgeDensity));
  return clamp01((clamp01(pBand) - delay) / (1.0 - DELAY_MAX));
}
float meltEase(float p) {
  float u = clamp01(p);
  return u * u * (2.0 - u);
}
float meltSlide(float x01, int k, float p) {
  float lenFrac = DRIP_MIN + (1.0 - DRIP_MIN) * valueNoise(x01 * LEN_LANES, SEED_LEN + k);
  return DRIP_MAX * lenFrac * meltEase(p);
}
float meltWobble(float x01, float rowFromTop, int k, float p, float pBand) {
  float phase = meltHash(int(floor(x01 * NOISE_F + LANE_BIAS)), SEED_WOBBLE + k) * TAU;
  return WOBBLE * clamp01(p) * sin(TAU * (WOB_FREQ * rowFromTop) + phase + WOB_RATE * clamp01(pBand));
}
float dropLaneCentre(float x01) {
  return (floor(x01 * LANES + LANE_BIAS) + 0.5) / LANES;
}
// dropLane → (has, cx, r, len)
vec4 dropLane(float x01, int k, float pLane) {
  int lane = int(floor(x01 * LANES + LANE_BIAS));
  float c = (float(lane) + 0.5) / LANES;
  float has = meltHash(lane, SEED_HAS + k) < DROP_PROB ? 1.0 : 0.0;
  float cx = c + (meltHash(lane, SEED_X + k) - 0.5) * DROP_JIT / LANES;
  float r = DROP_R_MIN + (DROP_R_MAX - DROP_R_MIN) * meltHash(lane, SEED_R + k);
  // A polynomial bump: exactly 0 at both ends, so the no-drop sentinel below
  // agrees with the mirror.
  float pl = clamp01(pLane);
  float len = DROP_LEN * 4.0 * pl * (1.0 - pl) * (0.5 + 0.5 * meltHash(lane, SEED_DLEN + k));
  return vec4(has, cx, r, len);
}
// dropDistance — signed distance to the lane's droplet; +1e9 when none.
float dropDistance(float x01, float rowFromTop, float aspect, vec4 lane, float top) {
  if (lane.x < 0.5 || lane.w <= 1e-6) return 1e9;
  vec2 q = vec2((x01 - lane.y) * aspect, rowFromTop);
  float yc = top + lane.w - lane.z;
  float stalk = sdSegment(q, vec2(0.0, top - lane.z), vec2(0.0, yc)) - DROP_STALK * lane.z;
  float head = length(q - vec2(0.0, yc)) - lane.z;
  return min(stalk, head);
}
// meltLayer → (cover, srcRowFromTop, xShift, slide)
vec4 meltLayer(float x01, float rowFromTop, int k, float pBand, float aspect) {
  float p = meltColumnProgress(x01, k, pBand, meltColumnDensity(x01, k));
  float slide = meltSlide(x01, k, p);
  float bandTop = float(k) / N;
  float bandBottom = (float(k) + 1.0) / N;
  float dy = rowFromTop - bandTop;
  float soft = min(FRONT_SOFT, slide * 0.5);
  float inContent = softStep(slide - soft, slide + soft, dy)
    * (1.0 - softStep(bandBottom + slide - soft, bandBottom + slide + soft, rowFromTop));
  float lcx = dropLaneCentre(x01);
  float pLane = meltColumnProgress(lcx, k, pBand, meltColumnDensity(lcx, k));
  vec4 lane = dropLane(x01, k, pLane);
  float top = bandBottom + meltSlide(lane.y, k, meltColumnProgress(lane.y, k, pBand, meltColumnDensity(lane.y, k)));
  float sd = dropDistance(x01, rowFromTop, aspect, lane, top);
  float inDrop = sd >= 1e8 ? 0.0 : 1.0 - softStep(-FRONT_SOFT * 0.5, FRONT_SOFT * 0.5, sd);
  float cover = max(inContent, inDrop);
  float srcContent = rowFromTop - slide;
  float srcDrop = bandBottom - 0.5 * lane.z - max(0.0, rowFromTop - top) * 0.5;
  float src = inDrop > inContent ? srcDrop : srcContent;
  float srcRowFromTop = clamp(src, bandTop, bandBottom);
  return vec4(cover, srcRowFromTop, meltWobble(x01, rowFromTop, k, p, pBand), slide);
}
// meltBlend — the A→B blend of a slid sample: the row law and the lead of the
// SOURCE position, never the destination's (one content row, one blend,
// wherever it has slid to).
float meltBlend(float srcX01, float srcRowFromTop) {
  vec2 srcUv = vec2(srcX01, 1.0 - srcRowFromTop);
  return softStep(0.0, 1.0, localProgress(rowProgress(uT, srcRowFromTop), leadAt(srcUv)));
}
// A sampled at (x01, rowFromTop) through the soft layer's exact level 0 —
// rowFromTop is 1 - uv.y.
vec3 texAAt(float x01, float rowFromTop) {
  return textureLod(uSoftA, vec2(x01, 1.0 - rowFromTop), 0.0).rgb;
}

void main() {
  vec2 uv = vUv;
  float rowFromTop = 1.0 - uv.y;
  float x01 = uv.x;
  int k = int(clamp(floor(rowFromTop * N), 0.0, N - 1.0));

  if (uMelt < 0.5) {
    float pRow = rowProgress(uT, rowFromTop);
    float leadN = leadAt(uv);
    float pLocal = localProgress(pRow, leadN);
    float blend = softStep(0.0, 1.0, pLocal);
    vec3 dens = textureLod(uAtlas, uv, COARSE_LOD).rgb;
    float wSim = similarity(dens.r, dens.g, dens.b);
    vec2 prox = textureLod(uAtlas, uv, PROX_LOD).rg;
    float r = blurRadiusPx(pLocal, blurWeight(max(prox.r, prox.g), wSim));
    vec3 a = softSample(uSoftA, uv, r);
    vec3 b = softSample(uSoftB, uv, r);
    outColor = vec4(mix(a, b, blend), 1.0);
    return;
  }

  // MELT — the band's own slide, then any drip arriving from the band above.
  float aspect = uRes.x / uRes.y;
  vec3 bAt = textureLod(uSoftB, uv, 0.0).rgb;
  float pBand = bandProgress(uT, float(k));
  vec4 own = meltLayer(x01, rowFromTop, k, pBand, aspect);
  vec3 aOwn = texAAt(x01 + own.z, own.y);
  vec3 slid = mix(aOwn, bAt, meltBlend(x01 + own.z, own.y));
  vec3 col = mix(bAt, slid, own.x);
  if (k > 0) {
    float pAbove = bandProgress(uT, float(k - 1));
    vec4 above = meltLayer(x01, rowFromTop, k - 1, pAbove, aspect);
    if (above.x > 0.0) {
      vec3 aDrip = texAAt(x01 + above.z, above.y);
      vec3 dripped = mix(aDrip, bAt, meltBlend(x01 + above.z, above.y));
      col = mix(col, dripped, above.x);
    }
  }
  outColor = vec4(col, 1.0);
}`;

// ─────────────────────────── params ─────────────────────────────────────────

export interface EdgefaderParams {
  fader: number;     // 0 = only A … 1 = only B
  threshold: number; // 0..1 normalised Sobel trigger (EDGES)
  thickness: number; // 1..EDGES_MAX_THICKNESS px (EDGES)
  melt: number;      // 0/1 latching toggle
  meltGate: number;  // raw melt_gate LEVEL; melt WHILE >= 0.5 (OR'd with `melt`)
}

export const EDGEFADER_DEFAULTS: EdgefaderParams = {
  // Mirrors FADER: at rest in the middle so a bipolar CV sweeps the whole
  // travel. With sources patched the resting picture is the cascade half-way:
  // the top two bands B (band 1's lowest rows still finishing), the middle
  // band with its edges fading first, the bottom two A.
  fader: 0.5,
  threshold: EDGES_DEFAULTS.threshold,
  thickness: EDGES_DEFAULTS.thickness,
  melt: 0,
  meltGate: 0,
};

const PARAM_IDS: ReadonlySet<string> = new Set(Object.keys(EDGEFADER_DEFAULTS));

/** Is MELT in effect for these params? The latched toggle OR the held gate —
 *  a bare level test, evaluated fresh on every frame. */
export function edgefaderMeltActive(p: Pick<EdgefaderParams, 'melt' | 'meltGate'>): boolean {
  return p.melt >= 0.5 || p.meltGate >= 0.5;
}

// ─────────────────────────── the def ────────────────────────────────────────

export const edgefaderDef: VideoModuleDef = {
  type: 'edgefader',
  palette: { top: 'Video modules', sub: 'Utilities' },
  domain: 'video',
  label: 'edgefader',
  category: 'utilities',
  inputs: [
    { id: 'in_a', type: 'video' },
    { id: 'in_b', type: 'video' },
    // Per-param CV inputs — port id == param id (the cross-domain CV bridge
    // routes audio-side cv onto VideoEngine.setParam(portId)).
    { id: 'fader',     label: 'A/B CV', type: 'cv', paramTarget: 'fader',     cvScale: { mode: 'linear' } },
    { id: 'threshold', type: 'cv', paramTarget: 'threshold', cvScale: { mode: 'linear' } },
    { id: 'thickness', type: 'cv', paramTarget: 'thickness', cvScale: { mode: 'linear' } },
    // MELT gate — a LEVEL hold (edge:'gate'): melt WHILE the gate is high,
    // OR'd with the latched MELT toggle. Routed to a synthetic `meltGate`
    // param so the per-frame level never stomps the button's latched state
    // (FRAMETABLE's FREEZE-pattern). Gate-typed → no cvScale.
    { id: 'melt_gate', type: 'gate', edge: 'gate', paramTarget: 'meltGate' },
  ],
  outputs: [
    { id: 'out', type: 'video' },
  ],
  params: [
    { id: 'fader',     label: 'A/B',    defaultValue: EDGEFADER_DEFAULTS.fader,     min: 0, max: 1,                   curve: 'linear' },
    { id: 'threshold', label: 'Thresh', defaultValue: EDGEFADER_DEFAULTS.threshold, min: 0, max: 1,                   curve: 'linear' },
    { id: 'thickness', label: 'Thick',  defaultValue: EDGEFADER_DEFAULTS.thickness, min: 1, max: EDGES_MAX_THICKNESS, curve: 'linear', units: 'px' },
    { id: 'melt',      label: 'Melt',   defaultValue: EDGEFADER_DEFAULTS.melt,      min: 0, max: 1,                   curve: 'discrete' },
    // Synthetic gate-level param the melt_gate bridge writes — no faceplate
    // control (see noUserControl).
    { id: 'meltGate',  label: 'Melt Gate', defaultValue: EDGEFADER_DEFAULTS.meltGate, min: 0, max: 1,                curve: 'linear' },
  ],

  noUserControl: [
    {
      param: 'meltGate',
      writer: 'cv-port',
      why: "The `melt_gate` input (edge: 'gate') targets it, and the cross-domain bridge writes that jack's LEVEL into it every frame. `draw()` reads it as `params.meltGate >= 0.5` and ORs it with the latched MELT toggle, which is the entire reason the two are separate params: a per-frame level write into `melt` would erase whatever the player had switched on the instant a cable was patched. The MELT toggle is the control; this is the jack's private landing pad.",
    },
  ],

  face: {
    // The fader is the module; MELT changes what the fader does; the two
    // detector knobs shape where it happens. One unlabelled band of four cells
    // — no `pages`, deliberately: four controls is one honest row, and a
    // heading over two faders would describe the layout rather than the module.
    order: ['fader', 'melt', 'threshold', 'thickness'],

    // ⚠ FADERS, NOT KNOBS — the parity-critical declaration. The A/B crossfade
    // is a THROW (the FADER module declares its two the same way), and THRESH /
    // THICK are declared faders on EDGES, whose operator this module runs twice;
    // nothing in a ParamDef separates "a level" from any other continuous
    // scalar, so an undeclared face would silently substitute dials. `melt` is
    // ABSENT on purpose: a 0/1 discrete param infers to a TOGGLE.
    paramCells: { fader: 'fader', threshold: 'fader', thickness: 'fader' },

    // ⚠ MANDATORY FOR A VIDEO DEF — `out` is `video`, so `primaryAudioOutPortId`
    // is null and any other glyph literal resolves to a dead `{kind:'static'}`
    // that reddens module-face-lint. The live picture arrives from
    // `hasVideoSurface(def)` at the lane and from the `fullViewBody` extension
    // at the dock.
    glyph: 'none',

    // SCREEN ON/OFF arrives through this slot (#1928): a faced video module has
    // no other route to the switch. See
    // `$lib/ui/modules/edgefader/shell-extension.ts`.
    extension: 'edgefader',
  },

  docs: {
    explanation: "edgefader is a two-source video crossfader that fades THROUGH the edges of the two pictures instead of dissolving them uniformly. It runs the EDGES operator (Rec. 601 luma, 3x3 Sobel, THRESH gate, THICK dilation) on both IN A and IN B every frame and packs the two masks into one atlas, together with the coarse edge density of each — the regions of A and B that carry edges in the same place are where the fade anchors. The A/B fader (0 = only A, 1 = only B, exact at both ends) drives a cascade down the frame: the picture is cut into five 20% bands and each band fades over its own window of the fader's travel, the next band starting when the one above is half done, so by the time the top band is fully across the second is where the first was when the second began, and so on to the bottom (the band law is interpolated between band centres so there is no seam). Inside a band the fade is led by the edges: pixels on an edge go first, pixels where A's and B's edges coincide go first of all, a region whose edges mostly coincide (THICK sets how close two edges must sit to count as the same) leads a flat one, a pixel just inside one of A's edges (closer to the centre of the screen than the edge) leads one just outside it, and flat regions follow — the fade ripples down the edges. The top three quarters of each band start together and the bottom quarter ramps to the next band's start, so the five regions stay visible without a seam. The operator is a blur around the edges that peaks mid-fade (the regions around the strokes go soft, then the incoming picture's edges sharpen in). MELT, a latching toggle OR'd with a gate jack, swaps the blur for a liquid screen melt: each band's content slides down column by column with a per-column start delay and drip length drawn from a smooth value noise (columns with more edges start first), rounded droplet tongues hang from the slid content, a sinusoidal horizontal wobble grows with the slide, and the drips carry the melting band down into the band below before dissolving. The whole law is stateless — a pure function of the two inputs, the fader and the two detector settings, with no clock, random source or history — so it renders identically on every frame for a given input, and turning the fader back runs the same cascade in reverse (bottom band first), and the inside/outside ripple is anchored on A's edges in both directions. At the resting fader (0.5) the top two bands show B (the lowest rows of band 1 still finishing), the middle band's edges are fading first, and the bottom two show A. Patch two sources into IN A / IN B, put the fader at either end to see one picture, sweep it to fade; raise THRESH to anchor the fade on fewer, stronger contours, raise THICK to widen the region each contour leads.",
    inputs: {
      in_a: "The A video source — what shows when the A/B fader is at 0, and the picture whose edges are detected as A's edge mask. Left unpatched it reads as opaque black with no edges, so an unpatched A with the fader toward A gives a black frame.",
      in_b: "The B video source — what shows when the A/B fader is at 1, and the picture whose edges are detected as B's edge mask. Left unpatched it reads as opaque black with no edges.",
      fader: "CV modulation of the A/B fade, centred on the manual A/B slider. Effective position = slider + CV x 0.5, clamped to 0..1. With the slider at 0.5 a bipolar -1..+1 signal sweeps fully from A to B. Unplugging restores the manual slider position.",
      threshold: "CV input that modulates Thresh — raising it via CV keeps only the strongest gradients as edges (fewer anchor regions), lowering it lets faint edges lead the fade. Linear-scaled into the 0..1 control range.",
      thickness: "CV input that modulates Thick — drives the dilation of both edge masks in pixels, i.e. how wide a region around each contour leads the fade. Linear-scaled into the 1..8 px control range and clamped so it cannot blow up the dilation loop.",
      melt_gate: "MELT gate. WHILE the gate is HELD HIGH (level >= 0.5) the blur fade is replaced by the liquid melt — a momentary hold that drops back to the blur the instant the gate goes low. OR-combined with the MELT toggle, so either can engage the melt independently.",
    },
    outputs: {
      out: "The crossfaded picture: exactly IN A with the fader at 0, exactly IN B at 1, and between them the edge-led cascade (blur, or melt when MELT is engaged). With nothing patched into either input this is black.",
    },
    controls: {
      fader: "The A<->B crossfade position: 0 shows only IN A, 1 shows only IN B. In between, the fader's travel is split into five overlapping windows, one per 20% band of the picture from the top down (each band starts when the band above is half done), and within each band the edged regions fade first. At the 0.5 default the top two bands show B, the middle band's edges are fading first, and the bottom two show A. Clamped to 0..1.",
      threshold: "Thresh sets the normalised gradient magnitude (in luma-step units) at or above which a pixel counts as an edge in BOTH pictures. 0 = every pixel is an edge, so the whole frame fades as one edged region; 1 = almost nothing is, so the fade degrades to a plain delayed crossfade; default 0.2 catches salient contours without low-contrast texture noise.",
      thickness: "Thick is the width in pixels (1..8 px, default 2) of the region around each detected contour that counts as edged and leads the fade — both masks are dilated by it (the same radius law as EDGES), so it is also the tolerance within which an edge of A and an edge of B count as coinciding.",
      melt: "MELT (0/1, default 0): a toggle you switch on and leave on — it swaps the blur fade for the liquid screen melt, where bands slide down in dripping columns with droplet tongues that fall into the band below. The melt gate additionally forces it while that gate is high. The fader's endpoints stay exact in either mode.",
      meltGate: "Melt Gate (0..1, default 0): hidden synthetic param the melt-gate CV bridge writes each frame with the gate LEVEL; while it is HIGH (>= 0.5) the melt is forced (OR-combined with the MELT toggle, so the per-frame level never stomps the toggle's latched state). Exposed only as the melt gate jack, not as a knob.",
    },
  },

  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;
    const copyProgram = ctx.compileFragment(COPY_FRAG_SRC);
    const sobelProgram = ctx.compileFragment(SOBEL_FRAG_SRC);
    const dilateProgram = ctx.compileFragment(DILATE_FRAG_SRC);
    const compositeProgram = ctx.compileFragment(COMPOSITE_FRAG_SRC);

    const uCopy = { tex: gl.getUniformLocation(copyProgram, 'uTex') };
    const uS = {
      texA: gl.getUniformLocation(sobelProgram, 'uTexA'),
      texB: gl.getUniformLocation(sobelProgram, 'uTexB'),
      hasA: gl.getUniformLocation(sobelProgram, 'uHasA'),
      hasB: gl.getUniformLocation(sobelProgram, 'uHasB'),
      texel: gl.getUniformLocation(sobelProgram, 'uTexel'),
      threshold: gl.getUniformLocation(sobelProgram, 'uThreshold'),
    };
    const uD = {
      edges: gl.getUniformLocation(dilateProgram, 'uEdges'),
      step: gl.getUniformLocation(dilateProgram, 'uStep'),
      radius: gl.getUniformLocation(dilateProgram, 'uRadius'),
      writeCoinc: gl.getUniformLocation(dilateProgram, 'uWriteCoinc'),
    };
    const uC = {
      softA: gl.getUniformLocation(compositeProgram, 'uSoftA'),
      softB: gl.getUniformLocation(compositeProgram, 'uSoftB'),
      atlas: gl.getUniformLocation(compositeProgram, 'uAtlas'),
      res: gl.getUniformLocation(compositeProgram, 'uRes'),
      t: gl.getUniformLocation(compositeProgram, 'uT'),
      melt: gl.getUniformLocation(compositeProgram, 'uMelt'),
    };

    // Every FBO is engine-managed (engine res, auto-resized on the aspect
    // switch) — nothing here is hand-sized, so no resize hook is needed.
    const out = ctx.createFbo();     // the canonical OUT
    const softA = ctx.createFbo();   // copy of A + mip chain
    const softB = ctx.createFbo();   // copy of B + mip chain
    const sobel = ctx.createFbo();   // R/G = raw edges
    const dilH = ctx.createFbo();    // horizontally dilated
    const atlas = ctx.createFbo();   // fully dilated + coincidence + mip chain (densities)

    // The three mip-chained textures sample through their chains; the filter
    // is texture state, which the engine's aspect-switch re-spec (level 0
    // only) leaves alone, so it is set ONCE here. The chains themselves are
    // rebuilt every frame (`refreshMips`).
    for (const r of [softA, softB, atlas]) {
      gl.bindTexture(gl.TEXTURE_2D, r.texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    }
    gl.bindTexture(gl.TEXTURE_2D, null);

    // Opaque-black 1×1 for any unpatched input (the FADER precedent).
    const emptyTex = gl.createTexture();
    if (!emptyTex) throw new Error('EDGEFADER: createTexture failed (emptyTex)');
    gl.bindTexture(gl.TEXTURE_2D, emptyTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // F-F1 (keyer-framework §11): the reconciler pushes params only on CHANGE,
    // so read node.params at spawn or a persisted fader/threshold/thickness/melt
    // silently resets on patch reload until touched.
    const rawParams = node.params as Record<string, unknown>;
    const filtered: Record<string, number> = {};
    for (const [k, v] of Object.entries(rawParams)) {
      if (PARAM_IDS.has(k) && typeof v === 'number' && Number.isFinite(v)) filtered[k] = v;
    }
    const params: EdgefaderParams = { ...EDGEFADER_DEFAULTS, ...(filtered as Partial<EdgefaderParams>) };

    /** Rebuild a texture's mip chain from its freshly rendered level 0. */
    function refreshMips(g: WebGL2RenderingContext, tex: WebGLTexture): void {
      g.bindTexture(g.TEXTURE_2D, tex);
      g.generateMipmap(g.TEXTURE_2D);
    }

    const surface: VideoNodeSurface = {
      fbo: out.fbo,
      texture: out.texture,
      draw(frame) {
        const g = frame.gl;
        const W = ctx.res.width;
        const H = ctx.res.height;
        const aTex = frame.getInputTexture(node.id, 'in_a') ?? emptyTex;
        const bTex = frame.getInputTexture(node.id, 'in_b') ?? emptyTex;
        const hasA = aTex !== emptyTex;
        const hasB = bTex !== emptyTex;

        const fullscreen = (program: WebGLProgram, fbo: WebGLFramebuffer): void => {
          g.bindFramebuffer(g.FRAMEBUFFER, fbo);
          g.viewport(0, 0, W, H);
          g.useProgram(program);
        };
        const bind = (unit: number, tex: WebGLTexture, loc: WebGLUniformLocation | null): void => {
          g.activeTexture(g.TEXTURE0 + unit);
          g.bindTexture(g.TEXTURE_2D, tex);
          g.uniform1i(loc, unit);
        };

        // Pass 0 — the soft layers (copies of A and B with mip chains).
        fullscreen(copyProgram, softA.fbo);
        bind(0, aTex, uCopy.tex);
        ctx.drawFullscreenQuad();
        fullscreen(copyProgram, softB.fbo);
        bind(0, bTex, uCopy.tex);
        ctx.drawFullscreenQuad();

        // Pass 1 — SOBEL on both inputs, gated per input.
        fullscreen(sobelProgram, sobel.fbo);
        bind(0, aTex, uS.texA);
        bind(1, bTex, uS.texB);
        g.uniform1f(uS.hasA, hasA ? 1 : 0);
        g.uniform1f(uS.hasB, hasB ? 1 : 0);
        g.uniform2f(uS.texel, 1 / W, 1 / H);
        g.uniform1f(uS.threshold, clamp01(params.threshold));
        ctx.drawFullscreenQuad();

        // Pass 2 — separable DILATE (H then V) by EDGES' radius law; the V
        // pass also writes the coincidence (B = min(R, G)) of the dilated masks.
        const radius = dilateRadius(params.thickness);
        fullscreen(dilateProgram, dilH.fbo);
        bind(0, sobel.texture, uD.edges);
        g.uniform2f(uD.step, 1 / W, 0);
        g.uniform1i(uD.radius, radius);
        g.uniform1f(uD.writeCoinc, 0);
        ctx.drawFullscreenQuad();
        fullscreen(dilateProgram, atlas.fbo);
        bind(0, dilH.texture, uD.edges);
        g.uniform2f(uD.step, 0, 1 / H);
        g.uniform1i(uD.radius, radius);
        g.uniform1f(uD.writeCoinc, 1);
        ctx.drawFullscreenQuad();

        // Mip chains: the blur radii of the soft layers and the coarse edge
        // densities of the atlas. (Unbind the FBO first — a texture is never
        // mip-generated while it is the bound colour attachment.)
        g.bindFramebuffer(g.FRAMEBUFFER, null);
        g.activeTexture(g.TEXTURE0);
        refreshMips(g, softA.texture);
        refreshMips(g, softB.texture);
        refreshMips(g, atlas.texture);

        // Pass 3 — COMPOSITE. It reads A and B through the soft layers' exact
        // level 0, never the upstream textures: if a graph cycle ever routes
        // OUT back into an input, nothing sampled here is the draw target.
        fullscreen(compositeProgram, out.fbo);
        bind(0, softA.texture, uC.softA);
        bind(1, softB.texture, uC.softB);
        bind(2, atlas.texture, uC.atlas);
        g.uniform2f(uC.res, W, H);
        g.uniform1f(uC.t, clamp01(params.fader));
        g.uniform1f(uC.melt, edgefaderMeltActive(params) ? 1 : 0);
        ctx.drawFullscreenQuad();

        g.bindFramebuffer(g.FRAMEBUFFER, null);
      },
      dispose() {
        for (const r of [out, softA, softB, sobel, dilH, atlas]) {
          gl.deleteFramebuffer(r.fbo);
          gl.deleteTexture(r.texture);
        }
        gl.deleteTexture(emptyTex);
        gl.deleteProgram(copyProgram);
        gl.deleteProgram(sobelProgram);
        gl.deleteProgram(dilateProgram);
        gl.deleteProgram(compositeProgram);
      },
    };

    return {
      domain: 'video',
      surface,
      setParam(paramId, value) {
        // meltGate is a LEVEL read (held WHILE high), consumed as-is in draw —
        // correct for an `edge: 'gate'` port.
        if (PARAM_IDS.has(paramId) && Number.isFinite(value)) {
          (params as unknown as Record<string, number>)[paramId] = value;
        }
      },
      readParam(paramId) {
        return (params as unknown as Record<string, number>)[paramId];
      },
      read(key) {
        // Test/diagnostic seams (the gibribbon `read` precedent): the cascade
        // the current fader resolves to, and whether MELT is in effect.
        if (key === 'cascade') return cascadeProgress(clamp01(params.fader), EDGEFADER_BANDS);
        if (key === 'meltActive') return edgefaderMeltActive(params) ? 1 : 0;
        return undefined;
      },
      dispose() { surface.dispose(); },
    };
  },
};
