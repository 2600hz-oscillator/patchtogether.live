// packages/web/src/lib/video/modules/edges.ts
//
// EDGES — per-frame Sobel edge-detection PROCESSOR.
//
// Takes a `video` input, runs a 3×3 Sobel operator on its per-pixel
// LUMINANCE (Rec. 601), and emits a MONO-VIDEO frame: white where an edge
// was detected, black everywhere else. EDGES is STATELESS per frame — the
// detected edges move/transform live with the source (no feedback, no
// history), so it's a pure function of the current input frame + the two
// knobs.
//
// ── Algorithm ─────────────────────────────────────────────────────────
// For each output texel we sample the input's luminance in a 3×3
// neighbourhood (one texel step = 1/resolution in UV), convolve with the
// two Sobel kernels:
//
//     Gx = [ -1  0  +1 ]      Gy = [ -1 -2 -1 ]
//          [ -2  0  +2 ]           [  0  0  0 ]
//          [ -1  0  +1 ]           [ +1 +2 +1 ]
//
// and take the gradient MAGNITUDE = sqrt(Gx² + Gy²). The raw Sobel
// magnitude of a unit (0→1) luma step is up to 4.0 (sum of the positive
// kernel weights), so we normalise by /4 to bring it into ~0..1 before
// the threshold test — that makes the THRESHOLD knob read in 0..1 luma-
// step units regardless of the kernel scaling.
//
//   * THRESHOLD (0..1, default 0.2): gradients with normalised magnitude
//     BELOW threshold are NOT edges → black. Raising it keeps only the
//     strongest edges (fewer white pixels); lowering it lets faint
//     gradients through (more white pixels).
//   * THICKNESS (~1px..~8px, default 2px): after the threshold test we
//     DILATE the edge mask by taking the MAX over a square neighbourhood
//     of radius (thickness-1) texels — so a 1px-wide detected edge is
//     rendered up to `thickness` px wide. thickness=1 is the raw edge
//     (no dilation); higher values thicken the strokes.
//
// The dilation is the expensive part (its inner loop is O(radius²)); we
// cap the radius at EDGES_MAX_THICKNESS so a CV signal can't blow up the
// loop bound. The loop is written with a COMPILE-TIME constant bound
// (GLSL requires constant loop bounds) and gated per-iteration on the
// runtime radius.
//
// ── Mono-video output ─────────────────────────────────────────────────
// Output type is `mono-video` (white edges on black). Downstream consumers
// that treat this as a mono stream sample R; we still write all three RGB
// channels = the same value so a plain `video` consumer also sees white.
//
// Inputs:
//   in (video): RGB source whose luminance is edge-detected.
//   threshold / thickness (cv, paramTarget=…): per-param CV (port id == param id).
//
// Outputs:
//   out (mono-video): white edges on black.
//
// Params:
//   threshold (linear 0..1): edge gradient-magnitude trigger (default 0.2).
//   thickness (linear 1..EDGES_MAX_THICKNESS px): rendered edge width (default 2).

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';

/** Maximum rendered edge thickness in pixels. Caps the dilation loop's
 *  neighbourhood radius so a CV signal can't push the per-pixel cost
 *  (O(radius²)) unbounded. The shader's dilation loop uses this as its
 *  COMPILE-TIME constant bound. */
export const EDGES_MAX_THICKNESS = 8;

/** Rec. 601 luma weights — same as LUMA / BACKDRAFT so "luminance" is
 *  consistent across the video modules. */
export const EDGES_LUMA_WEIGHTS: readonly [number, number, number] = [0.299, 0.587, 0.114];

/** Sobel magnitude normaliser. The positive Gx (or Gy) kernel weights sum
 *  to 4 (1+2+1), so a unit (0→1) luma step produces a raw magnitude of up
 *  to 4; dividing by 4 brings the magnitude into ~0..1 so THRESHOLD reads
 *  in luma-step units. Shared by the shader + the pure CPU mirror. */
export const EDGES_SOBEL_NORM = 4.0;

const FRAG_SRC = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uTex;
uniform float uHasInput;
uniform vec2  uTexel;       // 1/resolution — one texel step in UV
uniform float uThreshold;   // 0..1 normalised gradient-magnitude trigger
uniform float uThickness;   // 1..EDGES_MAX_THICKNESS px (dilation radius+1)

const float LUMA_R = ${EDGES_LUMA_WEIGHTS[0]};
const float LUMA_G = ${EDGES_LUMA_WEIGHTS[1]};
const float LUMA_B = ${EDGES_LUMA_WEIGHTS[2]};
const float SOBEL_NORM = ${EDGES_SOBEL_NORM.toFixed(1)};
const int   MAX_R = ${EDGES_MAX_THICKNESS - 1};   // max dilation radius (texels)

float lumaAt(vec2 uv) {
  vec3 c = texture(uTex, uv).rgb;
  return dot(c, vec3(LUMA_R, LUMA_G, LUMA_B));
}

// Normalised Sobel gradient magnitude at a UV (0..~1).
float sobelMag(vec2 uv) {
  float tl = lumaAt(uv + uTexel * vec2(-1.0, -1.0));
  float  t = lumaAt(uv + uTexel * vec2( 0.0, -1.0));
  float tr = lumaAt(uv + uTexel * vec2( 1.0, -1.0));
  float  l = lumaAt(uv + uTexel * vec2(-1.0,  0.0));
  float  r = lumaAt(uv + uTexel * vec2( 1.0,  0.0));
  float bl = lumaAt(uv + uTexel * vec2(-1.0,  1.0));
  float  b = lumaAt(uv + uTexel * vec2( 0.0,  1.0));
  float br = lumaAt(uv + uTexel * vec2( 1.0,  1.0));

  float gx = (tr + 2.0 * r + br) - (tl + 2.0 * l + bl);
  float gy = (bl + 2.0 * b + br) - (tl + 2.0 * t + tr);
  return sqrt(gx * gx + gy * gy) / SOBEL_NORM;
}

// Is the texel at uv an edge (normalised Sobel magnitude >= threshold)?
float isEdge(vec2 uv) {
  return sobelMag(uv) >= uThreshold ? 1.0 : 0.0;
}

void main() {
  if (uHasInput < 0.5) {
    outColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  // Dilation radius in texels: thickness=1 → radius 0 (raw edge); each
  // extra px of thickness adds one texel of neighbourhood. Clamp to the
  // compile-time loop bound so a CV signal can't escape it.
  int radius = int(clamp(floor(uThickness + 0.5), 1.0, float(MAX_R + 1)) - 1.0);

  // Morphological DILATE: this output texel is white if ANY texel within
  // radius is an edge. The loop runs the constant MAX_R bound (GLSL
  // requires constant bounds) and skips iterations beyond the runtime
  // radius. radius==0 => only the centre texel is tested (raw edge).
  float edge = 0.0;
  for (int dy = -MAX_R; dy <= MAX_R; dy++) {
    if (dy < -radius || dy > radius) continue;
    for (int dx = -MAX_R; dx <= MAX_R; dx++) {
      if (dx < -radius || dx > radius) continue;
      vec2 off = uTexel * vec2(float(dx), float(dy));
      edge = max(edge, isEdge(vUv + off));
      if (edge >= 1.0) break; // early-out once we know this texel is white
    }
    if (edge >= 1.0) break;
  }

  outColor = vec4(edge, edge, edge, 1.0);
}`;

export interface EdgesParams {
  threshold: number; // 0..1 normalised gradient-magnitude trigger
  thickness: number; // 1..EDGES_MAX_THICKNESS px (rendered edge width)
}

export const EDGES_DEFAULTS: EdgesParams = {
  // 0.2 normalised gradient — catches the salient contours of a typical
  // moving source (shape outlines, high-contrast detail) without flooding
  // the frame with low-contrast texture noise.
  threshold: 0.2,
  // 2px — visible strokes that read as "edges" rather than 1px hairlines
  // which alias badly on a moving source.
  thickness: 2,
};

const PARAM_IDS: ReadonlySet<string> = new Set(Object.keys(EDGES_DEFAULTS));

/**
 * Pure Rec. 601 luminance of an RGB triple (each channel 0..1). Exported
 * so the unit tests share the shader's definition of "luminance".
 */
export function edgesLuma(r: number, g: number, b: number): number {
  return (
    r * EDGES_LUMA_WEIGHTS[0] + g * EDGES_LUMA_WEIGHTS[1] + b * EDGES_LUMA_WEIGHTS[2]
  );
}

/**
 * Pure CPU mirror of the shader's NORMALISED Sobel gradient magnitude — the
 * single source of truth shared by the unit tests + the GLSL `sobelMag()`.
 *
 * `lumaAt(dx, dy)` returns the luminance of the texel offset (dx, dy) from
 * the pixel under test (caller supplies a sampler over an integer texel
 * grid with edge-clamped lookups, matching the GL CLAMP_TO_EDGE the FBO
 * uses). Returns the magnitude divided by EDGES_SOBEL_NORM so a unit luma
 * step maps to ~1.0 (THRESHOLD reads in luma-step units).
 */
export function edgesSobelMagnitude(
  lumaAt: (dx: number, dy: number) => number,
): number {
  const tl = lumaAt(-1, -1), t = lumaAt(0, -1), tr = lumaAt(1, -1);
  const l = lumaAt(-1, 0), r = lumaAt(1, 0);
  const bl = lumaAt(-1, 1), b = lumaAt(0, 1), br = lumaAt(1, 1);
  const gx = tr + 2 * r + br - (tl + 2 * l + bl);
  const gy = bl + 2 * b + br - (tl + 2 * t + tr);
  return Math.sqrt(gx * gx + gy * gy) / EDGES_SOBEL_NORM;
}

/**
 * Pure CPU mirror of the full per-texel EDGES decision (Sobel → threshold →
 * dilate). Shared by the unit tests so the JS + GLSL agree on the algorithm.
 *
 * @param width/height — grid dimensions.
 * @param lumaGrid     — row-major luminance grid (length width*height, 0..1).
 * @param x/y          — the texel under test.
 * @param threshold    — normalised gradient trigger (0..1).
 * @param thickness    — rendered edge width in px (1..EDGES_MAX_THICKNESS).
 * @returns 1 (white edge) or 0 (black), matching the shader's output value.
 */
export function edgesPixel(
  width: number,
  height: number,
  lumaGrid: ArrayLike<number>,
  x: number,
  y: number,
  threshold: number,
  thickness: number,
): number {
  // Edge-clamped luma sampler over the integer grid (mirrors CLAMP_TO_EDGE).
  const lumaAtAbs = (ax: number, ay: number): number => {
    const cx = Math.max(0, Math.min(width - 1, ax));
    const cy = Math.max(0, Math.min(height - 1, ay));
    return lumaGrid[cy * width + cx]!;
  };
  // Is the texel (ax, ay) an edge?
  const isEdge = (ax: number, ay: number): boolean =>
    edgesSobelMagnitude((dx, dy) => lumaAtAbs(ax + dx, ay + dy)) >= threshold;

  const radius = Math.max(
    0,
    Math.min(EDGES_MAX_THICKNESS - 1, Math.round(thickness) - 1),
  );
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (isEdge(x + dx, y + dy)) return 1;
    }
  }
  return 0;
}

export const edgesDef: VideoModuleDef = {
  type: 'edges',
  palette: { top: 'Video modules', sub: 'Processors' },
  domain: 'video',
  label: 'edges',
  category: 'effects',
  schemaVersion: 1,
  inputs: [
    { id: 'in', type: 'video' },
    // Per-param CV inputs — port id == param id (the cross-domain CV bridge
    // routes audio-side cv onto VideoEngine.setParam(portId)).
    { id: 'threshold', type: 'cv', paramTarget: 'threshold', cvScale: { mode: 'linear' } },
    { id: 'thickness', type: 'cv', paramTarget: 'thickness', cvScale: { mode: 'linear' } },
  ],
  outputs: [
    { id: 'out', type: 'mono-video' },
  ],
  params: [
    { id: 'threshold', label: 'Thresh', defaultValue: EDGES_DEFAULTS.threshold, min: 0, max: 1,                  curve: 'linear' },
    { id: 'thickness', label: 'Thick',  defaultValue: EDGES_DEFAULTS.thickness, min: 1, max: EDGES_MAX_THICKNESS, curve: 'linear', units: 'px' },
  ],

  // docs-hash-ignore:start
  docs: {
    explanation: "edges is a stateless Sobel edge-detector for video: it runs a 3x3 luminance gradient (Rec. 601 luma) over the incoming frame and emits a high-contrast mono-video frame that is white wherever a brightness edge was found and black everywhere else. The detection has no feedback or history, so the white outlines track and morph live with whatever moves in the source. After the threshold test it morphologically dilates the mask (max over a square neighbourhood) so 1px contours render as fatter strokes. Use it to pull line-art/outlines from a camera or any video source, feed a key/mask downstream, or stack it with a colorizer for a glowing-wireframe look; if you get too much speckle raise thresh, if outlines are too thin raise thick.",
    inputs: {
      in: "The video frame to edge-detect. Its per-pixel Rec. 601 luminance is run through the 3x3 Sobel operator; with nothing patched here the output is solid black.",
      threshold: "CV input that modulates Thresh — raising it via CV keeps only the strongest gradients (fewer white pixels), lowering it lets faint edges through. Linear-scaled into the 0..1 control range.",
      thickness: "CV input that modulates Thick — drives the rendered edge width / dilation radius in pixels. Linear-scaled into the 1..8 px control range and clamped so it cannot blow up the dilation loop.",
    },
    outputs: {
      out: "A mono-video frame of white edges on a black background (all three RGB channels written to the same value, so plain video consumers also see white).",
    },
    controls: {
      threshold: "Thresh sets the normalised gradient magnitude (in luma-step units) at or above which a pixel counts as an edge. 0 = every pixel passes so the whole frame floods white; 1 = almost nothing passes (a near-full unit luma step is needed); default 0.2 catches salient contours without low-contrast texture noise.",
      thickness: "Thick is the rendered edge width in pixels (1..8 px, default 2). 1 px is the raw single-texel edge with no dilation; higher values dilate the mask by taking the max over a square neighbourhood of radius round(thickness)-1, fattening the strokes up to the set width.",
    },
  },
  // docs-hash-ignore:end
  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;
    const program = ctx.compileFragment(FRAG_SRC);

    const uTex       = gl.getUniformLocation(program, 'uTex');
    const uHasInput  = gl.getUniformLocation(program, 'uHasInput');
    const uTexel     = gl.getUniformLocation(program, 'uTexel');
    const uThreshold = gl.getUniformLocation(program, 'uThreshold');
    const uThickness = gl.getUniformLocation(program, 'uThickness');

    const { fbo, texture } = ctx.createFbo();

    // Strip stray non-numeric / unknown keys so they can't bleed in.
    const rawParams = node.params as Record<string, unknown>;
    const filtered: Record<string, number> = {};
    for (const [k, v] of Object.entries(rawParams)) {
      if (PARAM_IDS.has(k) && typeof v === 'number') filtered[k] = v;
    }
    const params: EdgesParams = { ...EDGES_DEFAULTS, ...(filtered as Partial<EdgesParams>) };

    const surface: VideoNodeSurface = {
      fbo,
      texture,
      draw(frame) {
        const g = frame.gl;
        g.bindFramebuffer(g.FRAMEBUFFER, fbo);
        g.viewport(0, 0, ctx.res.width, ctx.res.height);
        g.useProgram(program);

        const inputTex = frame.getInputTexture(node.id, 'in');
        g.uniform1f(uHasInput, inputTex ? 1.0 : 0.0);
        if (inputTex) {
          g.activeTexture(g.TEXTURE0);
          g.bindTexture(g.TEXTURE_2D, inputTex);
          g.uniform1i(uTex, 0);
        }

        g.uniform2f(uTexel, 1 / ctx.res.width, 1 / ctx.res.height);
        g.uniform1f(uThreshold, Math.max(0, Math.min(1, params.threshold)));
        g.uniform1f(
          uThickness,
          Math.max(1, Math.min(EDGES_MAX_THICKNESS, params.thickness)),
        );

        ctx.drawFullscreenQuad();
        g.bindFramebuffer(g.FRAMEBUFFER, null);
      },
      dispose() {
        gl.deleteFramebuffer(fbo);
        gl.deleteTexture(texture);
        gl.deleteProgram(program);
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
      dispose() { surface.dispose(); },
    };
  },
};
