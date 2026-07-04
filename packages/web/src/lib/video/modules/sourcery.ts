// packages/web/src/lib/video/modules/sourcery.ts
//
// SOURCERY — a 2-video-input "region shape-match recolor" WebGL module. It
// edge-detects input A (top) and B (bottom), segments each edge map into
// bounded regions (the connected non-edge areas walled off by edges), then for
// each region in A finds the B region most similar in SHAPE (angles + geometry)
// first, SIZE second, and fills the A region with B's colors placed at the SAME
// relative position inside the region. Two global controls — COLOR-SKEW (hue)
// and ROTATE (intra-region sample rotation) — move all the transferred color
// content. One video output.
//
// EXECUTION MODEL — the SHAPEGEN pattern (CPU/JS hybrid on the MAIN thread). A
// stateless per-pixel fragment shader can't do connected-component labeling,
// per-region moments, or an A→B nearest-shape match, so:
//   GPU  — cheap per-pixel Sobel+threshold edge maps (A→R, B→G packed into ONE
//          small FBO), then ONE packed readPixels at PROC_W×PROC_H.
//   CPU  — the pure sourcery-core: CCL → moments → Hu descriptors → z-score
//          A→B match → per-region affine LUT (the correctness gate, unit-tested).
//   GPU  — a FILL pass at full engine res EVERY frame: per pixel sample the
//          coarse labelA (NEAREST), texelFetch the region's affine from the LUT,
//          map rel→uvB, sample the LIVE full-res B color, hue-skew + rotate.
//
// Temporal amortization (mandatory): the expensive shape stage (readback + core
// + LUT upload) runs every K frames; the cheap GPU fill sampling live B runs
// every frame — so B motion stays smooth while the shape/label stage updates at
// ~15-20 Hz. See sourcery-core.ts + .myrobots/sourcery-video-module-design.md.
//
// Fallbacks: B unpatched → passthrough A (identity); an A region with no B match
// → identity/passthrough (the LUT `valid` flag gates the shader), so the output
// NEVER has holes (spec item 5 — all A area maps).
//
// Honest v1 limitations (disclosed): the per-frame-independent segmentation
// SHIMMERS/BOILS on live noisy video at low threshold; region boundaries are
// BLOCKY (label computed at 128×96, nearest-upscaled) while colors are full-res
// sharp; the whole-screen background is one giant region filled by some B shape.

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';
import { EDGES_LUMA_WEIGHTS, EDGES_SOBEL_NORM } from './edges';
import {
  SOURCERY_PROC_W,
  SOURCERY_PROC_H,
  SOURCERY_MAX_REGIONS,
  SOURCERY_LUT_ROWS,
  SOURCERY_AMORTIZE_K,
  SOURCERY_EXTENT_K,
  Amortizer,
  computeTransfer,
  packLabelTexture,
  packRegionLUT,
  type Affine,
} from '$lib/video/sourcery-core';

// ─────────────────────────── params ───────────────────────────

interface SourceryParams {
  thresholdA: number; // 0..1 edge gradient trigger for A
  thresholdB: number; // 0..1 edge gradient trigger for B
  colorSkew: number;  // 0..1 (0.5 = identity) → hue rotation ±180°
  rotate: number;     // 0..1 (0.5 = no rotation) → intra-region rotation ±π
}

const DEFAULTS: SourceryParams = {
  thresholdA: 0.2,
  thresholdB: 0.2,
  colorSkew: 0.5,
  rotate: 0.5,
};

const PARAM_IDS: ReadonlySet<string> = new Set(Object.keys(DEFAULTS));

// ─────────────────────────── edge pre-pass shader ───────────────────────────
//
// Sobel+threshold on A and B luminance (reusing EDGES' math), packed into one
// FBO (edgeA→R, edgeB→G) with a 1px morphological-close "seal" (3×3 dilate) so
// broken contours don't leak regions together. Rendered at PROC_W×PROC_H.

const EDGE_FRAG_SRC = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uTexA;
uniform sampler2D uTexB;
uniform float uHasA;
uniform float uHasB;
uniform vec2  uTexel;      // 1/proc-res — one texel step in UV
uniform float uThrA;
uniform float uThrB;

const float LR = ${EDGES_LUMA_WEIGHTS[0]};
const float LG = ${EDGES_LUMA_WEIGHTS[1]};
const float LB = ${EDGES_LUMA_WEIGHTS[2]};
const float SOBEL_NORM = ${EDGES_SOBEL_NORM.toFixed(1)};

float luma(sampler2D t, vec2 uv) {
  return dot(texture(t, uv).rgb, vec3(LR, LG, LB));
}

// Normalised Sobel gradient magnitude (0..~1), matching EDGES.
float sobelMag(sampler2D t, vec2 uv) {
  float tl = luma(t, uv + uTexel * vec2(-1.0, -1.0));
  float  tt = luma(t, uv + uTexel * vec2( 0.0, -1.0));
  float tr = luma(t, uv + uTexel * vec2( 1.0, -1.0));
  float  l = luma(t, uv + uTexel * vec2(-1.0,  0.0));
  float  r = luma(t, uv + uTexel * vec2( 1.0,  0.0));
  float bl = luma(t, uv + uTexel * vec2(-1.0,  1.0));
  float  bb = luma(t, uv + uTexel * vec2( 0.0,  1.0));
  float br = luma(t, uv + uTexel * vec2( 1.0,  1.0));
  float gx = (tr + 2.0 * r + br) - (tl + 2.0 * l + bl);
  float gy = (bl + 2.0 * bb + br) - (tl + 2.0 * tt + tr);
  return sqrt(gx * gx + gy * gy) / SOBEL_NORM;
}

// Edge at uv (with a 3×3 dilate "seal": edge if ANY neighbour is an edge).
float edgeSealed(sampler2D t, vec2 uv, float thr) {
  float e = 0.0;
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      vec2 o = uTexel * vec2(float(dx), float(dy));
      if (sobelMag(t, uv + o) >= thr) e = 1.0;
    }
  }
  return e;
}

void main() {
  float ea = uHasA > 0.5 ? edgeSealed(uTexA, vUv, uThrA) : 1.0;
  float eb = uHasB > 0.5 ? edgeSealed(uTexB, vUv, uThrB) : 1.0;
  // Pack A→R, B→G. When an input is unpatched we emit ALL-wall (1.0) so the
  // CPU CCL yields zero regions and the fill falls back to passthrough.
  outColor = vec4(ea, eb, 0.0, 1.0);
}`;

// ─────────────────────────── fill shader ───────────────────────────
//
// Full engine-res, every frame. Per pixel: sample coarse labelA (NEAREST) →
// texelFetch the region's affine from the LUT → rel→uvB (the EXACT mirror of
// sourcery-core.relToUvB) → sample LIVE full-res B → hue-skew by COLOR-SKEW.
// The LUT is RGBA32F (uploaded + NEAREST-sampled, never rendered-to → no
// EXT_color_buffer_float needed). ROTATE + COLOR-SKEW are plain uniforms.

const FILL_FRAG_SRC = `#version 300 es
precision highp float;
precision highp sampler2D;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uLabelA;  // coarse region-id map (R + G·256), NEAREST
uniform sampler2D uLUT;     // RGBA32F affine LUT (MAX_REGIONS × LUT_ROWS), NEAREST
uniform sampler2D uTexB;    // live full-res B color
uniform sampler2D uTexA;    // live full-res A color (passthrough fallback)
uniform float uHasA;
uniform float uHasB;
uniform vec2  uProc;        // (PROC_W, PROC_H)
uniform float uRotate;      // radians (intra-region rotation)
uniform float uSkew;        // 0..1 (0.5 = identity) hue rotation
uniform int   uMaxRegions;

const int LUT_ROWS = ${SOURCERY_LUT_ROWS};

// ── HSV mirror of colourofmagic-colorspace (branchless Hocevar) ──
vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}
vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - 1.0, 0.0, 1.0), c.y);
}
// GLSL fract wraps negatives up, matching adjHue.
vec3 hueSkew(vec3 rgb, float skew01) {
  vec3 hsv = rgb2hsv(rgb);
  float h = fract(hsv.x + (skew01 - 0.5)); // (skew−0.5)*360° / 360°
  return hsv2rgb(vec3(h, hsv.y, hsv.z));
}

vec4 lutRow(int region, int row) {
  return texelFetch(uLUT, ivec2(region, row), 0);
}

void main() {
  if (uHasA < 0.5) { outColor = vec4(0.0, 0.0, 0.0, 1.0); return; }

  // Decode the coarse region id (R + G·256) at this pixel.
  vec4 lab = texture(uLabelA, vUv);
  int region = int(floor(lab.r * 255.0 + 0.5)) + int(floor(lab.g * 255.0 + 0.5)) * 256;
  region = clamp(region, 0, uMaxRegions - 1);

  vec4 r0 = lutRow(region, 0); // (aCx, aCy, cosA, sinA)
  vec4 r1 = lutRow(region, 1); // (invSAx, invSAy, valid, 0)
  float valid = r1.z;

  // Passthrough when B is unpatched OR this A region has no match.
  vec3 srcB = uHasB > 0.5 ? texture(uTexB, vUv).rgb : texture(uTexA, vUv).rgb;
  if (uHasB < 0.5 || valid < 0.5) {
    outColor = vec4(hueSkew(srcB, uSkew), 1.0);
    return;
  }

  vec4 r2 = lutRow(region, 2); // (bCx, bCy, cosB, sinB)
  vec4 r3 = lutRow(region, 3); // (sBx, sBy, 0, 0)

  // this pixel in PROC-grid coords
  float px = vUv.x * uProc.x;
  float py = vUv.y * uProc.y;
  float dx = px - r0.x;
  float dy = py - r0.y;

  // A-local normalize (r0.zw = cosA,sinA; r1.xy = invSAx,invSAy) + clamp to unit box
  float u = clamp((dx * r0.z + dy * r0.w) * r1.x, -1.0, 1.0);
  float v = clamp((-dx * r0.w + dy * r0.z) * r1.y, -1.0, 1.0);

  // intra-region rotate
  float cr = cos(uRotate);
  float sr = sin(uRotate);
  float ru = u * cr - v * sr;
  float rv = u * sr + v * cr;

  // B-local reconstruct (r3.xy = sBx,sBy; r2.zw = cosB,sinB)
  float pu = ru * r3.x;
  float pv = rv * r3.y;
  float qx = pu * r2.z - pv * r2.w;
  float qy = pu * r2.w + pv * r2.z;
  float bx = r2.x + qx;
  float by = r2.y + qy;
  vec2 uvB = clamp(vec2(bx / uProc.x, by / uProc.y), 0.0, 1.0);

  vec3 col = texture(uTexB, uvB).rgb;
  outColor = vec4(hueSkew(col, uSkew), 1.0);
}`;

// map the 0..1 knob to an intra-region rotation angle ±π.
const rotateRadians = (knob: number): number => (knob - 0.5) * 2 * Math.PI;

// ─────────────────────────── module def ───────────────────────────

export const sourceryDef: VideoModuleDef = {
  type: 'sourcery',
  palette: { top: 'Video modules', sub: 'Processors' },
  domain: 'video',
  label: 'sourcery',
  category: 'effects',
  schemaVersion: 1,
  inputs: [
    { id: 'a', type: 'video' },
    { id: 'b', type: 'video' },
    { id: 'thresholdA', type: 'cv', paramTarget: 'thresholdA', cvScale: { mode: 'linear' } },
    { id: 'thresholdB', type: 'cv', paramTarget: 'thresholdB', cvScale: { mode: 'linear' } },
    { id: 'colorSkew', type: 'cv', paramTarget: 'colorSkew', cvScale: { mode: 'linear' } },
    { id: 'rotate', type: 'cv', paramTarget: 'rotate', cvScale: { mode: 'linear' } },
  ],
  outputs: [
    { id: 'out', type: 'video' },
  ],
  params: [
    { id: 'thresholdA', label: 'ThrA', defaultValue: DEFAULTS.thresholdA, min: 0, max: 1, curve: 'linear' },
    { id: 'thresholdB', label: 'ThrB', defaultValue: DEFAULTS.thresholdB, min: 0, max: 1, curve: 'linear' },
    { id: 'colorSkew',  label: 'Skew', defaultValue: DEFAULTS.colorSkew,  min: 0, max: 1, curve: 'linear' },
    { id: 'rotate',     label: 'Rot',  defaultValue: DEFAULTS.rotate,     min: 0, max: 1, curve: 'linear' },
  ],

  // docs-hash-ignore:start
  docs: {
    explanation:
      "sourcery is a two-input region-transplant recolorizer: it edge-detects video A (top) and video B (bottom), carves each edge map into bounded regions (the connected non-edge areas walled off by the detected edges), then for every region in A finds the B region most similar in SHAPE (angles + geometry) first and SIZE second, and paints A's region with B's colors placed at the SAME relative position inside the shape (a corner of A samples the matching corner of B). A B shape may be matched by many A regions (reuse is fine) and EVERY part of the A frame maps to some region (tiny/culled regions and the walls are absorbed into their nearest surviving region, so the output never has holes — the whole-screen background becomes one giant region filled by some B shape). Two global controls move all the transferred color: SKEW rotates the hue of every filled pixel, ROT rotates the sampling frame inside each region. The result is a shifting stained-glass / photomosaic where A's edge structure is the cell boundaries and each cell is a warped fragment of B chosen by shape similarity: as B moves the fills shimmer with B's live color, as A moves the boundaries flow with A's structure. Region boundaries are intentionally BLOCKY (segmentation runs at a coarse 128x96 grid, nearest-upscaled) while the colors are full-res sharp (B is sampled at engine resolution). For real-time performance the shape/segmentation stage is amortized (recomputed every few frames) while the color fill sampling live B runs every frame; on live noisy video at low threshold the regions shimmer/boil frame-to-frame (a disclosed v1 limitation). Usage: patch a structural source into A and a colorful source into B, raise ThrA/ThrB until A's cells and B's shapes read cleanly (higher = fewer, bolder regions), then twist SKEW to tint and ROT to swirl the transplanted color; with nothing in B the module passes A through (hue-skewed).",
    inputs: {
      a: "Video input A (top) — its edge map defines the CELL BOUNDARIES: each connected non-edge area becomes a region that gets painted. With nothing patched here the output is black. A's structure flows the cell layout live.",
      b: "Video input B (bottom) — its edge map is segmented into candidate SHAPES and its live full-res color is the paint. Each A region samples the B region matched to it (by shape then size) at the same relative position. With nothing patched in B the module passes A through (hue-skewed only).",
      thresholdA: "CV input that modulates ThrA — the edge gradient trigger for A's segmentation. Raising it keeps only the strongest contours (fewer, larger A cells); lowering it lets faint gradients wall off more, smaller cells. Linear-scaled into 0..1.",
      thresholdB: "CV input that modulates ThrB — the edge gradient trigger for B's segmentation (the pool of candidate shapes A matches against). Linear-scaled into 0..1.",
      colorSkew: "CV input that modulates Skew — rotates the hue of every transferred pixel. Linear-scaled into 0..1 (0.5 = no shift).",
      rotate: "CV input that modulates Rot — rotates the sampling frame inside each region, swirling the transplanted color. Linear-scaled into 0..1 (0.5 = no rotation).",
    },
    outputs: {
      out: "The recolored video frame: A's edge-bounded cells each painted with the relative-position colors of their shape-matched B region, globally hue-skewed. A normal downstream video texture.",
    },
    controls: {
      thresholdA: "ThrA (0..1, default 0.2): the normalised Sobel gradient magnitude at or above which an A pixel is a wall. 0 floods the frame with walls (many tiny cells); 1 keeps almost nothing (one big cell); 0.2 catches salient contours without low-contrast noise. Applied at segmentation time, so under amortization a twist shows on the next recompute.",
      thresholdB: "ThrB (0..1, default 0.2): the same edge trigger for B's segmentation — sets how finely B is broken into candidate shapes for the match. Higher = fewer, bolder B shapes.",
      colorSkew: "Skew (0..1, default 0.5 = identity): global hue rotation of every transferred color, mapped bipolarly to +/-180 degrees (0.5 = no shift, 0 = -180, 1 = +180). Saturation and value pass through untouched.",
      rotate: "Rot (0..1, default 0.5 = no rotation): rotates the intra-region sampling frame, mapped bipolarly to +/-pi radians, so the color content swirls within each cell while the cell boundaries stay put.",
    },
  },
  // docs-hash-ignore:end
  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;
    const edgeProgram = ctx.compileFragment(EDGE_FRAG_SRC);
    const fillProgram = ctx.compileFragment(FILL_FRAG_SRC);

    // edge-pass uniforms
    const uEdgeTexA = gl.getUniformLocation(edgeProgram, 'uTexA');
    const uEdgeTexB = gl.getUniformLocation(edgeProgram, 'uTexB');
    const uEdgeHasA = gl.getUniformLocation(edgeProgram, 'uHasA');
    const uEdgeHasB = gl.getUniformLocation(edgeProgram, 'uHasB');
    const uEdgeTexel = gl.getUniformLocation(edgeProgram, 'uTexel');
    const uEdgeThrA = gl.getUniformLocation(edgeProgram, 'uThrA');
    const uEdgeThrB = gl.getUniformLocation(edgeProgram, 'uThrB');

    // fill-pass uniforms
    const uFillLabelA = gl.getUniformLocation(fillProgram, 'uLabelA');
    const uFillLUT = gl.getUniformLocation(fillProgram, 'uLUT');
    const uFillTexB = gl.getUniformLocation(fillProgram, 'uTexB');
    const uFillTexA = gl.getUniformLocation(fillProgram, 'uTexA');
    const uFillHasA = gl.getUniformLocation(fillProgram, 'uHasA');
    const uFillHasB = gl.getUniformLocation(fillProgram, 'uHasB');
    const uFillProc = gl.getUniformLocation(fillProgram, 'uProc');
    const uFillRotate = gl.getUniformLocation(fillProgram, 'uRotate');
    const uFillSkew = gl.getUniformLocation(fillProgram, 'uSkew');
    const uFillMaxRegions = gl.getUniformLocation(fillProgram, 'uMaxRegions');

    // Output surface (engine res, managed → auto-resizes on aspect switch).
    const { fbo, texture } = ctx.createFbo();

    const rawParams = node.params as Record<string, unknown>;
    const filtered: Record<string, number> = {};
    for (const [k, v] of Object.entries(rawParams)) {
      if (PARAM_IDS.has(k) && typeof v === 'number') filtered[k] = v;
    }
    const params: SourceryParams = { ...DEFAULTS, ...(filtered as Partial<SourceryParams>) };

    const W = SOURCERY_PROC_W, H = SOURCERY_PROC_H;

    // Sentinel 1×1 black for unbound inputs (feedback-loop-safe, CHROMAKEY pattern).
    const emptyTex = gl.createTexture();
    if (!emptyTex) throw new Error('SOURCERY: createTexture failed (emptyTex)');
    gl.bindTexture(gl.TEXTURE_2D, emptyTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // Packed edge FBO at PROC res (edgeA→R, edgeB→G). ONE readPixels off it.
    const edgeFbo = gl.createFramebuffer();
    const edgeTex = gl.createTexture();
    if (!edgeFbo || !edgeTex) throw new Error('SOURCERY: createFramebuffer/Texture failed (edge)');
    gl.bindTexture(gl.TEXTURE_2D, edgeTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, edgeFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, edgeTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    // labelA upload texture (coarse region-id map, NEAREST) — reused each regen.
    const labelTex = gl.createTexture();
    if (!labelTex) throw new Error('SOURCERY: createTexture failed (labelTex)');
    gl.bindTexture(gl.TEXTURE_2D, labelTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // RGBA32F affine LUT (MAX_REGIONS × LUT_ROWS), NEAREST, texelFetch-only.
    // Sampling an RGBA32F texture is core WebGL2 (no EXT_color_buffer_float —
    // that's only needed to RENDER to float, which we never do here).
    const lutTex = gl.createTexture();
    if (!lutTex) throw new Error('SOURCERY: createTexture failed (lutTex)');
    gl.bindTexture(gl.TEXTURE_2D, lutTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, SOURCERY_MAX_REGIONS, SOURCERY_LUT_ROWS, 0, gl.RGBA, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);

    // Preallocated CPU buffers (zero per-frame alloc).
    const packed = new Uint8Array(W * H * 4);
    const edgeA = new Uint8Array(W * H);
    const edgeB = new Uint8Array(W * H);
    const labelBytes = new Uint8Array(W * H * 4);
    const lutFloats = new Float32Array(SOURCERY_MAX_REGIONS * SOURCERY_LUT_ROWS * 4);

    const amortizer = new Amortizer(SOURCERY_AMORTIZE_K);
    let prevMatch: Int32Array | null = null;
    let regenCount = 0;
    let framesElapsed = 0;
    let hadB = false;

    // Render the packed edge pass into edgeFbo, then read it back to `packed`.
    function readEdges(texA: WebGLTexture | null, texB: WebGLTexture | null): void {
      gl.bindFramebuffer(gl.FRAMEBUFFER, edgeFbo);
      gl.viewport(0, 0, W, H);
      gl.useProgram(edgeProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texA ?? emptyTex);
      gl.uniform1i(uEdgeTexA, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, texB ?? emptyTex);
      gl.uniform1i(uEdgeTexB, 1);
      gl.uniform1f(uEdgeHasA, texA ? 1 : 0);
      gl.uniform1f(uEdgeHasB, texB ? 1 : 0);
      gl.uniform2f(uEdgeTexel, 1 / W, 1 / H);
      gl.uniform1f(uEdgeThrA, Math.max(0, Math.min(1, params.thresholdA)));
      gl.uniform1f(uEdgeThrB, Math.max(0, Math.min(1, params.thresholdB)));
      ctx.drawFullscreenQuad();
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, packed);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    // Recompute the shape tables from the packed edges + upload labelA & LUT.
    function recompute(): void {
      for (let i = 0; i < W * H; i++) {
        edgeA[i] = packed[i * 4]! > 127 ? 1 : 0;
        edgeB[i] = packed[i * 4 + 1]! > 127 ? 1 : 0;
      }
      const { finalLabelsA, affines, match } = computeTransfer(edgeA, edgeB, W, H, { prevMatch });
      prevMatch = match;
      packLabelTexture(finalLabelsA, W, H, labelBytes);
      const affTable: Affine[] = affines;
      packRegionLUT(affTable, SOURCERY_MAX_REGIONS, lutFloats);

      gl.bindTexture(gl.TEXTURE_2D, labelTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, labelBytes);
      gl.bindTexture(gl.TEXTURE_2D, lutTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, SOURCERY_MAX_REGIONS, SOURCERY_LUT_ROWS, 0, gl.RGBA, gl.FLOAT, lutFloats);
      gl.bindTexture(gl.TEXTURE_2D, null);
      regenCount++;
    }

    const surface: VideoNodeSurface = {
      fbo,
      texture,
      draw(frame) {
        const g = frame.gl;
        const texA = frame.getInputTexture(node.id, 'a');
        const texB = frame.getInputTexture(node.id, 'b');
        hadB = !!texB;

        // 1. Shape stage — amortized (every K frames). Reads back the packed
        //    edges once, runs the pure core, uploads labelA + LUT.
        if (amortizer.step()) {
          readEdges(texA, texB);
          recompute();
        }

        // 2. Fill pass — EVERY frame, at full engine res, sampling LIVE B.
        g.bindFramebuffer(g.FRAMEBUFFER, fbo);
        g.viewport(0, 0, ctx.res.width, ctx.res.height);
        g.useProgram(fillProgram);
        g.activeTexture(g.TEXTURE0);
        g.bindTexture(g.TEXTURE_2D, labelTex);
        g.uniform1i(uFillLabelA, 0);
        g.activeTexture(g.TEXTURE1);
        g.bindTexture(g.TEXTURE_2D, lutTex);
        g.uniform1i(uFillLUT, 1);
        g.activeTexture(g.TEXTURE2);
        g.bindTexture(g.TEXTURE_2D, texB ?? emptyTex);
        g.uniform1i(uFillTexB, 2);
        g.activeTexture(g.TEXTURE3);
        g.bindTexture(g.TEXTURE_2D, texA ?? emptyTex);
        g.uniform1i(uFillTexA, 3);
        g.uniform1f(uFillHasA, texA ? 1 : 0);
        g.uniform1f(uFillHasB, texB ? 1 : 0);
        g.uniform2f(uFillProc, W, H);
        g.uniform1f(uFillRotate, rotateRadians(params.rotate));
        g.uniform1f(uFillSkew, Math.max(0, Math.min(1, params.colorSkew)));
        g.uniform1i(uFillMaxRegions, SOURCERY_MAX_REGIONS);
        ctx.drawFullscreenQuad();
        g.bindFramebuffer(g.FRAMEBUFFER, null);

        framesElapsed++;
      },
      dispose() {
        gl.deleteFramebuffer(fbo);
        gl.deleteTexture(texture);
        gl.deleteFramebuffer(edgeFbo);
        gl.deleteTexture(edgeTex);
        gl.deleteTexture(labelTex);
        gl.deleteTexture(lutTex);
        gl.deleteTexture(emptyTex);
        gl.deleteProgram(edgeProgram);
        gl.deleteProgram(fillProgram);
      },
    };

    return {
      domain: 'video',
      surface,
      setParam(paramId, value) {
        if (paramId in params) (params as unknown as Record<string, number>)[paramId] = value;
      },
      readParam(paramId) {
        return (params as unknown as Record<string, number>)[paramId];
      },
      read(key) {
        if (key === 'framesElapsed') return framesElapsed;
        if (key === 'regenCount') return regenCount;
        if (key === 'hasB') return hadB ? 1 : 0;
        return undefined;
      },
      dispose() { surface.dispose(); },
    };
  },
};

// Re-exported so the card + tests reference one constant rather than re-typing.
export { SOURCERY_PROC_W, SOURCERY_PROC_H, SOURCERY_MAX_REGIONS, SOURCERY_EXTENT_K };
