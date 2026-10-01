// EDGEFADER — a two-source video crossfader that fades THROUGH THE EDGES.
//
// ── SIGNAL FLOW
//   in_a, in_b ──▶ [Sobel + threshold + dilate on BOTH, packed] ──▶ edge atlas
//                                                                      │
//   in_a, in_b, atlas, fader, melt ──▶ [cascading edge-led composite] ──▶ out
//
//   * Both sources get the EDGES operator (same Rec. 601 luma, Sobel kernel,
//     normalisation, THRESHOLD gate and THICKNESS dilation) at half engine
//     resolution, packed into ONE atlas: R = A's edges, G = B's edges,
//     B = where the two COINCIDE — the regions of A and B whose edges sit in
//     the same place, which is where the fade is anchored.
//   * The FADER (0 = only A, 1 = only B) drives a CASCADE down the frame:
//     five 20 % bands, each fading over its own window of the fader's travel,
//     the next band starting when the previous is half done. Within a band
//     edged pixels fade first (coincident edges first of all), a pixel just
//     INSIDE an edge (centre-ward of it) leads one just OUTSIDE, and flat
//     regions follow — the fade ripples down the edges, top to bottom.
//   * The operator is a mid-fade BLUR of the edged regions, or — with MELT
//     engaged by the toggle OR its gate — a per-column liquid slide with
//     droplet heads that carry each melting band down into the band below
//     (DOOM-style screen melt, value-noise smoothed; see the PR body for the
//     prior art).
//
// ── ARCHITECTURE: three passes, STATELESS
//   pass 1 SOBEL     (atlas res) → R/G = isEdge(A)/isEdge(B); the Sobel step is
//                                  one ENGINE texel, so THRESHOLD keeps EDGES'
//                                  luma-step meaning exactly.
//   pass 2 DILATE    (atlas res) → max over a (2r+1)² window per channel,
//                                  B = min(R, G) (coincidence). r comes from
//                                  THICKNESS through `dilateRadius`.
//   pass 3 COMPOSITE (engine res) → the per-pixel cascade/lead/blur-or-melt law.
//   Every term is a function of (A, B, fader, params, pixel) — no clock, no
//   previous frame, no Math.random — so a pinned engine renders the same frame
//   on every step and the module needs no `freeze`. The whole law lives in
//   edgefader-core.ts (pure, unit-pinned); the GLSL below is its line-for-line
//   port with the constants interpolated from the SAME exports.
//
// Unpatched inputs sample an opaque-black 1×1 texture (the FADER precedent), so
// with nothing patched the output is black (see EXEMPT_OUTPUT_EMIT_MODULES).

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
  EDGEFADER_EDGE_SCALE,
  EDGEFADER_DILATE_MAX_R,
  EDGEFADER_LOCAL_FRACTION,
  EDGEFADER_LEAD_EDGE,
  EDGEFADER_LEAD_COINCIDENCE,
  EDGEFADER_LEAD_INSIDE,
  EDGEFADER_BLUR_MAX_PX,
  EDGEFADER_RAY_TAPS_PX,
  EDGEFADER_BLUR_TAPS,
  EDGEFADER_MELT_COLS,
  EDGEFADER_MELT_DELAY_MAX,
  EDGEFADER_DRIP_MAX_UV,
  EDGEFADER_DRIP_MIN_FRAC,
  EDGEFADER_WOBBLE_UV,
  EDGEFADER_FRONT_SOFT_UV,
  EDGEFADER_HEAD_ROUND,
  cascadeProgress,
  dilateRadius,
} from './edgefader-core';

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const f = (x: number): string => {
  const s = String(x);
  return s.includes('.') || s.includes('e') ? s : `${s}.0`;
};

// ─────────────────────────── pass 1: SOBEL ──────────────────────────────────

const SOBEL_FRAG_SRC = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uTexA;
uniform sampler2D uTexB;
uniform float uHasA;
uniform float uHasB;
uniform vec2  uTexel;       // 1/ENGINE res — one INPUT texel (the EDGES step)
uniform float uThreshold;

const float LUMA_R = ${EDGES_LUMA_WEIGHTS[0]};
const float LUMA_G = ${EDGES_LUMA_WEIGHTS[1]};
const float LUMA_B = ${EDGES_LUMA_WEIGHTS[2]};
const float SOBEL_NORM = ${EDGES_SOBEL_NORM.toFixed(1)};

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
  outColor = vec4(ea, eb, min(ea, eb), 1.0);
}`;

// ─────────────────────────── pass 2: DILATE ─────────────────────────────────

const DILATE_FRAG_SRC = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uEdges;
uniform vec2 uAtlasTexel;   // 1/atlas res — one atlas texel
uniform int  uRadius;       // 0..MAX_R atlas texels (dilateRadius(thickness))

const int MAX_R = ${EDGEFADER_DILATE_MAX_R};

void main() {
  float a = 0.0;
  float b = 0.0;
  for (int dy = -MAX_R; dy <= MAX_R; dy++) {
    if (dy < -uRadius || dy > uRadius) continue;
    for (int dx = -MAX_R; dx <= MAX_R; dx++) {
      if (dx < -uRadius || dx > uRadius) continue;
      vec2 e = texture(uEdges, vUv + uAtlasTexel * vec2(float(dx), float(dy))).rg;
      a = max(a, e.r);
      b = max(b, e.g);
    }
  }
  outColor = vec4(a, b, min(a, b), 1.0);
}`;

// ─────────────────────────── pass 3: COMPOSITE ──────────────────────────────

const RAY_TAPS_GLSL = EDGEFADER_RAY_TAPS_PX.map((t) => `
  toward = max(toward, wEdgeAt((pPx + d * ${f(t)}) / uRes));
  away   = max(away,   wEdgeAt((pPx - d * ${f(t)}) / uRes));`).join('');

const BLUR_TAPS_GLSL = EDGEFADER_BLUR_TAPS.map(([ox, oy, wt]) =>
  `  acc += ${f(wt)} * texture(t, uv + vec2(${f(ox)}, ${f(oy)}) * s).rgb;`).join('\n');

const COMPOSITE_FRAG_SRC = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uTexA;
uniform sampler2D uTexB;
uniform sampler2D uAtlas;   // R = dilated edge(A), G = dilated edge(B), B = min(R, G)
uniform vec2  uRes;         // engine px
uniform float uT;           // fader 0..1
uniform float uMelt;        // >= 0.5 → MELT

const float N          = ${f(EDGEFADER_BANDS)};
const float RHO        = ${f(EDGEFADER_LOCAL_FRACTION)};
const float LEAD_EDGE  = ${f(EDGEFADER_LEAD_EDGE)};
const float LEAD_COINC = ${f(EDGEFADER_LEAD_COINCIDENCE)};
const float LEAD_IN    = ${f(EDGEFADER_LEAD_INSIDE)};
const float BLUR_MAX   = ${f(EDGEFADER_BLUR_MAX_PX)};
const float COLS       = ${f(EDGEFADER_MELT_COLS)};
const float DELAY_MAX  = ${f(EDGEFADER_MELT_DELAY_MAX)};
const float DRIP_MAX   = ${f(EDGEFADER_DRIP_MAX_UV)};
const float DRIP_MIN   = ${f(EDGEFADER_DRIP_MIN_FRAC)};
const float WOBBLE     = ${f(EDGEFADER_WOBBLE_UV)};
const float FRONT_SOFT = ${f(EDGEFADER_FRONT_SOFT_UV)};
const float HEAD_ROUND = ${f(EDGEFADER_HEAD_ROUND)};

float clamp01(float x) { return clamp(x, 0.0, 1.0); }

// softStep — smoothstep with the e0 == e1 case made a hard step.
float softStep(float e0, float e1, float x) {
  float d = e1 - e0;
  if (d <= 1e-9) return x < e0 ? 0.0 : 1.0;
  float u = clamp01((x - e0) / d);
  return u * u * (3.0 - 2.0 * u);
}

// meltHash — 32-bit integer hash, bit-exact with the CPU mirror.
float meltHash(int i, int seed) {
  uint h = uint(i) * 374761393u + uint(seed) * 668265263u;
  h = (h ^ (h >> 13u)) * 1274126177u;
  h = h ^ (h >> 16u);
  return float(h & 0xffffffu) / 16777216.0;
}

float valueNoise(float x, int seed) {
  float i = floor(x);
  float fr = x - i;
  float u = fr * fr * (3.0 - 2.0 * fr);
  return mix(meltHash(int(i), seed), meltHash(int(i) + 1, seed), u);
}

// bandProgress — band k's own progress at fader t.
float bandProgress(float t, float k) {
  float start = k / (N + 1.0);
  return clamp01((t - start) * (N + 1.0) * 0.5);
}

// leadFor — normalised lead in [0,1].
float leadFor(float wEdge, float wCoinc, float inside, float nearEdge) {
  float raw = wEdge * (LEAD_EDGE + LEAD_COINC * wCoinc) + LEAD_IN * inside * nearEdge;
  float span = LEAD_EDGE + LEAD_COINC + 2.0 * LEAD_IN;
  return clamp01((raw + LEAD_IN) / span);
}

// localProgress — the pixel's own progress from its band's progress + lead.
float localProgress(float pBand, float leadN) {
  float delay = 1.0 - clamp01(leadN);
  return clamp01((clamp01(pBand) - delay * (1.0 - RHO)) / RHO);
}

float blurRadiusPx(float pLocal, float wEdge) {
  float p = clamp01(pLocal);
  return BLUR_MAX * clamp01(wEdge) * 4.0 * p * (1.0 - p);
}

float wEdgeAt(vec2 uv) {
  vec2 e = texture(uAtlas, uv).rg;
  return max(e.r, e.g);
}

// The 13-tap disc blur (EDGEFADER_BLUR_TAPS); r < 0.5 px is the plain sample.
vec3 blurTex(sampler2D t, vec2 uv, float rPx) {
  if (rPx < 0.5) return texture(t, uv).rgb;
  vec2 s = rPx / uRes;
  vec3 acc = vec3(0.0);
${BLUR_TAPS_GLSL}
  return acc;
}

// meltColumn — one column's drip extent (uv, downward) for band k.
float meltExtent(int col, int k, float pBand) {
  float delay = DELAY_MAX * valueNoise(float(col) * 0.25, 11 + k);
  float lenFrac = DRIP_MIN + (1.0 - DRIP_MIN) * valueNoise(float(col) * 0.125 + 5.0, 23 + k);
  float u = clamp01((clamp01(pBand) - delay) / (1.0 - delay));
  return DRIP_MAX * lenFrac * u * u;
}

// dripFront — the union of three rounded column tips at x.
float dripFront(float x01, int k, float pBand) {
  float colF = x01 * COLS;
  int col = int(floor(colF));
  float fx = colF - floor(colF);
  float dOwn = abs(fx - 0.5);
  float dLeft = fx + 0.5;
  float dRight = 1.5 - fx;
  float tOwn = max(0.0, meltExtent(col, k, pBand) * (1.0 - HEAD_ROUND * dOwn * dOwn));
  float tLeft = max(0.0, meltExtent(col - 1, k, pBand) * (1.0 - HEAD_ROUND * dLeft * dLeft));
  float tRight = max(0.0, meltExtent(col + 1, k, pBand) * (1.0 - HEAD_ROUND * dRight * dRight));
  return max(tOwn, max(tLeft, tRight));
}

// meltLayer — extent, content (1 below the front), source row, x wobble.
vec4 meltLayer(float x01, float rowFromTop, int k, float pBand) {
  float extent = dripFront(x01, k, pBand);
  float bandTop = float(k) / N;
  float dy = rowFromTop - bandTop;
  float soft = min(FRONT_SOFT, extent * 0.5);
  float content = softStep(extent - soft, extent + soft, dy);
  int col = int(floor(x01 * COLS));
  float phase = meltHash(col, 41 + k) * 6.2831853;
  float amount = extent / DRIP_MAX;
  float xShift = WOBBLE * sin(rowFromTop * 31.0 + phase) * amount;
  return vec4(extent, content, rowFromTop - extent, xShift);
}

// A sampled at (x01, rowFromTop) — rowFromTop is 1 - uv.y.
vec3 texAAt(float x01, float rowFromTop) {
  return texture(uTexA, vec2(x01, 1.0 - rowFromTop)).rgb;
}

void main() {
  vec2 uv = vUv;
  float rowFromTop = 1.0 - uv.y;
  float x01 = uv.x;
  int k = int(clamp(floor(rowFromTop * N), 0.0, N - 1.0));
  float pBand = bandProgress(uT, float(k));

  vec3 at = texture(uAtlas, uv).rgb;
  float wEdge = max(at.r, at.g);
  float wCoinc = at.b;

  // inside / outside along the ray to screen centre (px space, so the taps
  // are the same length on both axes).
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

  float leadN = leadFor(wEdge, wCoinc, inside, nearEdge);
  float pLocal = localProgress(pBand, leadN);
  float blend = softStep(0.0, 1.0, pLocal);
  vec3 bAt = texture(uTexB, uv).rgb;

  if (uMelt < 0.5) {
    float r = blurRadiusPx(pLocal, wEdge);
    vec3 a = blurTex(uTexA, uv, r);
    vec3 b = blurTex(uTexB, uv, r);
    outColor = vec4(mix(a, b, blend), 1.0);
    return;
  }

  // MELT — the band's own slide, then any drip arriving from the band above.
  vec4 own = meltLayer(x01, rowFromTop, k, pBand);
  vec3 aOwn = texAAt(x01 + own.w, own.z);
  vec3 slid = mix(aOwn, bAt, blend);
  vec3 col = mix(bAt, slid, own.y);
  if (k > 0) {
    float pAbove = bandProgress(uT, float(k - 1));
    vec4 above = meltLayer(x01, rowFromTop, k - 1, pAbove);
    float reach = above.x;
    if (reach > 0.0) {
      float dy = rowFromTop - float(k) / N;
      float soft = min(FRONT_SOFT, reach * 0.5);
      float inDrip = 1.0 - softStep(reach - soft, reach + soft, dy);
      vec3 aDrip = texAAt(x01 + above.w, above.z);
      float blendAbove = softStep(0.0, 1.0, localProgress(pAbove, leadN));
      vec3 dripped = mix(aDrip, bAt, blendAbove);
      col = mix(col, dripped, inDrip);
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
  // travel, and a freshly patched pair shows the cascade half-way.
  fader: 0.5,
  threshold: EDGES_DEFAULTS.threshold,
  thickness: EDGES_DEFAULTS.thickness,
  melt: 0,
  meltGate: 0,
};

const PARAM_IDS: ReadonlySet<string> = new Set(Object.keys(EDGEFADER_DEFAULTS));

/** Is MELT in effect for these params? The latched toggle OR the held gate. */
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
    explanation: "edgefader is a two-source video crossfader that fades THROUGH the edges of the two pictures instead of dissolving them uniformly. It runs the EDGES operator (Rec. 601 luma, 3x3 Sobel, THRESH gate, THICK dilation) on both IN A and IN B every frame and packs the two masks into one atlas, together with where they COINCIDE — the regions of A and B whose edges sit in the same place. The A/B fader (0 = only A, 1 = only B, exact at both ends) then drives a cascade down the frame: the picture is cut into five 20% bands and each band fades over its own window of the fader's travel, the next band starting when the one above is half done, so by the time the top band is fully across the second is where the first was when the second began, and so on to the bottom. Inside a band the fade is led by the edges: pixels on an edge go first, pixels where A's and B's edges coincide go first of all, a pixel just inside an edge (closer to the centre of the screen than the edge) leads one just outside it, and flat regions follow — the fade ripples down the edges. The operator is a blur that peaks mid-fade (the edged regions go soft, then the incoming picture's edges sharpen in). MELT, a latching toggle OR'd with a gate jack, swaps the blur for a liquid screen melt: each band's content slides down column by column with per-column timing and drip lengths smoothed across neighbouring columns, rounded droplet heads at the drip fronts, a sinusoidal horizontal wobble, and the drips carry the melting band down into the band below before dissolving. The whole law is stateless — a pure function of the two inputs, the fader and the two detector settings — so it renders identically on every frame for a given input. Patch two sources into IN A / IN B, put the fader at either end to see one picture, sweep it to fade; raise THRESH to anchor the fade on fewer, stronger contours, raise THICK to widen the region each contour leads.",
    inputs: {
      in_a: "The A video source — what shows when the A/B fader is at 0, and the picture whose edges are detected as A's edge mask. Left unpatched it reads as opaque black, so an unpatched A with the fader toward A gives a black frame.",
      in_b: "The B video source — what shows when the A/B fader is at 1, and the picture whose edges are detected as B's edge mask. Left unpatched it reads as opaque black.",
      fader: "CV modulation of the A/B fade, centred on the manual A/B slider. Effective position = slider + CV x 0.5, clamped to 0..1. With the slider at 0.5 a bipolar -1..+1 signal sweeps fully from A to B. Unplugging restores the manual slider position.",
      threshold: "CV input that modulates Thresh — raising it via CV keeps only the strongest gradients as edges (fewer anchor regions), lowering it lets faint edges lead the fade. Linear-scaled into the 0..1 control range.",
      thickness: "CV input that modulates Thick — drives the dilation of both edge masks in pixels, i.e. how wide a region around each contour leads the fade. Linear-scaled into the 1..8 px control range and clamped so it cannot blow up the dilation loop.",
      melt_gate: "MELT gate. WHILE the gate is HELD HIGH (level >= 0.5) the blur fade is replaced by the liquid melt — a momentary hold that drops back to the blur the instant the gate goes low. OR-combined with the MELT toggle, so either can engage the melt independently.",
    },
    outputs: {
      out: "The crossfaded picture: exactly IN A with the fader at 0, exactly IN B at 1, and between them the edge-led cascade (blur, or melt when MELT is engaged). With nothing patched into either input this is black.",
    },
    controls: {
      fader: "The A<->B crossfade position: 0 shows only IN A, 1 shows only IN B. In between, the fader's travel is split into five overlapping windows, one per 20% band of the picture from the top down (each band starts when the band above is half done), and within each band the edged regions fade first. Clamped to 0..1.",
      threshold: "Thresh sets the normalised gradient magnitude (in luma-step units) at or above which a pixel counts as an edge in BOTH pictures. 0 = every pixel is an edge, so the whole frame fades as one edged region; 1 = almost nothing is, so the fade degrades to a plain delayed crossfade; default 0.2 catches salient contours without low-contrast texture noise.",
      thickness: "Thick is the width in pixels (1..8 px, default 2) of the region around each detected contour that counts as edged and leads the fade — both masks are dilated by it, and a wider mask also makes more of A's and B's edges coincide.",
      melt: "MELT (0/1, default 0): swaps the blur fade for the liquid screen melt — bands slide down in dripping columns with droplet heads that fall into the band below. Latched by the toggle; the melt gate additionally forces it while that gate is high. The fader's endpoints stay exact in either mode.",
      meltGate: "Melt Gate (0..1, default 0): hidden synthetic param the melt-gate CV bridge writes each frame with the gate LEVEL; while it is HIGH (>= 0.5) the melt is forced (OR-combined with the MELT toggle, so the per-frame level never stomps the toggle's latched state). Exposed only as the melt gate jack, not as a knob.",
    },
  },

  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;
    const sobelProgram = ctx.compileFragment(SOBEL_FRAG_SRC);
    const dilateProgram = ctx.compileFragment(DILATE_FRAG_SRC);
    const compositeProgram = ctx.compileFragment(COMPOSITE_FRAG_SRC);

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
      atlasTexel: gl.getUniformLocation(dilateProgram, 'uAtlasTexel'),
      radius: gl.getUniformLocation(dilateProgram, 'uRadius'),
    };
    const uC = {
      texA: gl.getUniformLocation(compositeProgram, 'uTexA'),
      texB: gl.getUniformLocation(compositeProgram, 'uTexB'),
      atlas: gl.getUniformLocation(compositeProgram, 'uAtlas'),
      res: gl.getUniformLocation(compositeProgram, 'uRes'),
      t: gl.getUniformLocation(compositeProgram, 'uT'),
      melt: gl.getUniformLocation(compositeProgram, 'uMelt'),
    };

    // Output surface (engine res, managed → auto-resizes on the aspect switch).
    const out = ctx.createFbo();

    // Opaque-black 1×1 for any unpatched input (the FADER precedent).
    const emptyTex = gl.createTexture();
    if (!emptyTex) throw new Error('EDGEFADER: createTexture failed (emptyTex)');
    gl.bindTexture(gl.TEXTURE_2D, emptyTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // The two atlas FBOs (sobel → edgeFbo, dilate → atlasFbo), owned here at
    // EDGE_SCALE × engine res, LINEAR so the composite reads soft weights.
    // Unmanaged by the engine's registry, so `resize()` below reallocates them.
    interface OwnedFbo { fbo: WebGLFramebuffer; texture: WebGLTexture }
    function allocAtlas(w: number, h: number): OwnedFbo {
      const fbo = gl.createFramebuffer();
      const texture = gl.createTexture();
      if (!fbo || !texture) throw new Error('EDGEFADER: createFramebuffer/Texture failed (atlas)');
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return { fbo, texture };
    }
    function freeAtlas(a: OwnedFbo): void {
      gl.deleteFramebuffer(a.fbo);
      gl.deleteTexture(a.texture);
    }
    const atlasSize = (w: number, h: number): [number, number] => [
      Math.max(1, Math.round(w * EDGEFADER_EDGE_SCALE)),
      Math.max(1, Math.round(h * EDGEFADER_EDGE_SCALE)),
    ];
    let [aw, ah] = atlasSize(ctx.res.width, ctx.res.height);
    let edgeFbo = allocAtlas(aw, ah);
    let atlasFbo = allocAtlas(aw, ah);

    // F-F1 (keyer-framework §11): the reconciler pushes params only on CHANGE,
    // so read node.params at spawn or a persisted fader/threshold/thickness/melt
    // silently resets on patch reload until touched.
    const rawParams = node.params as Record<string, unknown>;
    const filtered: Record<string, number> = {};
    for (const [k, v] of Object.entries(rawParams)) {
      if (PARAM_IDS.has(k) && typeof v === 'number' && Number.isFinite(v)) filtered[k] = v;
    }
    const params: EdgefaderParams = { ...EDGEFADER_DEFAULTS, ...(filtered as Partial<EdgefaderParams>) };

    const surface: VideoNodeSurface = {
      fbo: out.fbo,
      texture: out.texture,
      draw(frame) {
        const g = frame.gl;
        const W = ctx.res.width;
        const H = ctx.res.height;
        const aTex = frame.getInputTexture(node.id, 'in_a');
        const bTex = frame.getInputTexture(node.id, 'in_b');

        // Pass 1 — SOBEL at atlas res.
        g.bindFramebuffer(g.FRAMEBUFFER, edgeFbo.fbo);
        g.viewport(0, 0, aw, ah);
        g.useProgram(sobelProgram);
        g.activeTexture(g.TEXTURE0);
        g.bindTexture(g.TEXTURE_2D, aTex ?? emptyTex);
        g.uniform1i(uS.texA, 0);
        g.activeTexture(g.TEXTURE1);
        g.bindTexture(g.TEXTURE_2D, bTex ?? emptyTex);
        g.uniform1i(uS.texB, 1);
        g.uniform1f(uS.hasA, aTex ? 1 : 0);
        g.uniform1f(uS.hasB, bTex ? 1 : 0);
        g.uniform2f(uS.texel, 1 / W, 1 / H);
        g.uniform1f(uS.threshold, clamp01(params.threshold));
        ctx.drawFullscreenQuad();

        // Pass 2 — DILATE at atlas res.
        g.bindFramebuffer(g.FRAMEBUFFER, atlasFbo.fbo);
        g.viewport(0, 0, aw, ah);
        g.useProgram(dilateProgram);
        g.activeTexture(g.TEXTURE0);
        g.bindTexture(g.TEXTURE_2D, edgeFbo.texture);
        g.uniform1i(uD.edges, 0);
        g.uniform2f(uD.atlasTexel, 1 / aw, 1 / ah);
        g.uniform1i(uD.radius, dilateRadius(params.thickness));
        ctx.drawFullscreenQuad();

        // Pass 3 — COMPOSITE at engine res.
        g.bindFramebuffer(g.FRAMEBUFFER, out.fbo);
        g.viewport(0, 0, W, H);
        g.useProgram(compositeProgram);
        g.activeTexture(g.TEXTURE0);
        g.bindTexture(g.TEXTURE_2D, aTex ?? emptyTex);
        g.uniform1i(uC.texA, 0);
        g.activeTexture(g.TEXTURE1);
        g.bindTexture(g.TEXTURE_2D, bTex ?? emptyTex);
        g.uniform1i(uC.texB, 1);
        g.activeTexture(g.TEXTURE2);
        g.bindTexture(g.TEXTURE_2D, atlasFbo.texture);
        g.uniform1i(uC.atlas, 2);
        g.uniform2f(uC.res, W, H);
        g.uniform1f(uC.t, clamp01(params.fader));
        g.uniform1f(uC.melt, edgefaderMeltActive(params) ? 1 : 0);
        ctx.drawFullscreenQuad();

        g.bindFramebuffer(g.FRAMEBUFFER, null);
      },
      resize(width, height) {
        const [w, h] = atlasSize(width, height);
        if (w === aw && h === ah) return;
        freeAtlas(edgeFbo);
        freeAtlas(atlasFbo);
        aw = w;
        ah = h;
        edgeFbo = allocAtlas(aw, ah);
        atlasFbo = allocAtlas(aw, ah);
      },
      dispose() {
        gl.deleteFramebuffer(out.fbo);
        gl.deleteTexture(out.texture);
        freeAtlas(edgeFbo);
        freeAtlas(atlasFbo);
        gl.deleteTexture(emptyTex);
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
