// packages/web/src/lib/video/modules/ruttetra.ts
//
// RUTTETRA — AUTHENTIC forward-scatter Rutt-Etra raster scope.
//
// A faithful WebGL2 port of p10entrancer's "XYZ" unit
// (P10Entrancer/Shaders/XYZ.metal + Mixer/XYZRenderer.swift). Unlike
// RESHAPER (which is a fragment-shader coordinate REMAP), this is REAL
// line geometry — the classic Rutt-Etra scan-processor look:
//
//   - A cols×rows grid (320×180) of sample points walks the source.
//   - For each grid point: read source luma, compute a shaped H/V ramp
//     base position, displace by luma, emit a vertex.
//   - Draw LINE-LIST segments connecting adjacent COLUMNS within each
//     row. Each row is a horizontal scanline that bows in X/Y by luma.
//   - ADDITIVE blending (CRT phosphor); clear to black.
//
// Bright source pixels push their scanline OUTWARD → a 3D heightmap.
//
// Implementation notes (vs the Metal original):
//   - The engine's compileFragment() only pairs a frag with a shared
//     fullscreen-quad vertex shader. Line geometry needs its own vertex
//     shader, so we build our own program directly via ctx.gl.
//   - Attributeless rendering: an ELEMENT_ARRAY_BUFFER index buffer holds
//     the line list (2*(cols-1)*rows UInt32 grid-point ids, built exactly
//     like XYZRenderer.swift). gl.drawElements(LINES, ..., UNSIGNED_INT).
//     UInt32 indices are core in WebGL2 (no OES_element_index_uint).
//   - In the vertex shader, gl_VertexID == the index value under
//     drawElements (WebGL2), i.e. the grid-point id. We derive
//     col/row/h0/v0 from it and sample Z via vertex texture fetch
//     (WebGL2 guarantees vertex texture units).
//   - Renders into a per-instance FBO from createFbo(); exposes the
//     standard `out` video port + drives the on-card preview via
//     blitOutputToDrawingBuffer, exactly like RESHAPER / videoOut.
//
// Z unpatched: bind a mid-grey source so luma≈0.5 → zero displacement →
// flat scanlines are still drawn (no black void on cold-spawn), matching
// how RESHAPER avoided a black card.
//
// Inputs:
//   z (video): source video — luma drives per-grid-point displacement.
//   xShape / yShape / xDisp / yDisp / intensity / xFreq / yFreq
//     (cv, linear, paramTarget=…): per-param CV.
//
// Outputs:
//   out (video): the additive-blend scanline render.
//
// Params:
//   xShape / yShape (linear 0..1): per-axis ramp shape morph.
//   xDisp / yDisp (linear -1..1): per-axis static displacement.
//   intensity (linear 0..2): luma-to-displacement scale.
//   tintR / tintG / tintB (linear 0..1): scanline tint colour.
//   xFreq / yFreq (linear 0.25..8): per-axis ramp frequency.
//   xPhase / yPhase (linear 0..1): per-axis phase offset.

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';

/** Grid resolution — matches XYZRenderer.swift (320×180 = 57,600 grid
 *  points). Dense enough to read like a real scanline raster, sparse
 *  enough that the heightmap displacement reads clearly. */
const COLS = 320;
const ROWS = 180;

/**
 * Pure TS mirror of the GLSL `shapedRamp` (port of XYZ.metal). Kept in
 * lockstep with the shader source above so the morph crossfade can be
 * unit-tested without a GL context. Any change here MUST be mirrored in
 * VERT_SRC's shapedRamp and vice-versa.
 *
 *   morph 0      → linear ramp  fract(t)
 *   morph 0.333  → triangle     |2*fract(t)-1|
 *   morph 0.666  → soft-fold    0.5 - 0.5*cos(2π*fract(t))
 *   morph 1      → radial       clamp(|uv-0.5|·√2, 0, 1)
 */
export function shapedRamp(t: number, uvx: number, uvy: number, morph: number): number {
  const lin = t - Math.floor(t); // fract(t)
  const tri = Math.abs(2.0 * lin - 1.0);
  const sf = 0.5 - 0.5 * Math.cos(2.0 * Math.PI * lin);
  const dx = uvx - 0.5;
  const dy = uvy - 0.5;
  const radial = Math.min(Math.max(Math.sqrt(dx * dx + dy * dy) * 1.41421356, 0.0), 1.0);
  const m = Math.min(Math.max(morph, 0.0), 1.0);
  if (m < 0.333) {
    return lin + (tri - lin) * (m * 3.0);
  } else if (m < 0.666) {
    return tri + (sf - tri) * ((m - 0.333) * 3.0);
  } else {
    return sf + (radial - sf) * ((m - 0.666) * 3.0);
  }
}

const VERT_SRC = `#version 300 es
precision highp float;

uniform sampler2D uZ;       // source video (luma drives displacement)
uniform float uCols;
uniform float uRows;
uniform float uXShape;
uniform float uYShape;
uniform float uXDisp;
uniform float uYDisp;
uniform float uIntensity;
uniform float uTintR;
uniform float uTintG;
uniform float uTintB;
uniform float uXFreq;
uniform float uYFreq;
uniform float uXPhase;
uniform float uYPhase;

out vec3 vColor;

#define PI 3.14159265358979323846

// Port of XYZ.metal shapedRamp(). morph crossfades:
//   0=linear, 0.333=triangle, 0.666=soft-fold (raised cosine), 1=radial.
float shapedRamp(float t, vec2 uv, float morph) {
  float lin = fract(t);
  float tri = abs(2.0 * lin - 1.0);
  float sf = 0.5 - 0.5 * cos(2.0 * PI * lin);
  float radial = clamp(length(uv - 0.5) * 1.41421356, 0.0, 1.0);
  morph = clamp(morph, 0.0, 1.0);
  if (morph < 0.333) {
    return mix(lin, tri, morph * 3.0);
  } else if (morph < 0.666) {
    return mix(tri, sf, (morph - 0.333) * 3.0);
  } else {
    return mix(sf, radial, (morph - 0.666) * 3.0);
  }
}

void main() {
  // gl_VertexID == the index value pulled from the bound
  // ELEMENT_ARRAY_BUFFER under drawElements (WebGL2). That value is the
  // grid-point id, exactly the Metal vertex_id.
  float id = float(gl_VertexID);
  float cols = uCols;
  float rows = uRows;
  float col = mod(id, cols);
  float row = floor(id / cols);
  float h0 = col / (cols - 1.0);
  float v0 = row / (rows - 1.0);

  // Sample source. Luma drives displacement; color comes out as-is.
  //
  // Y-FLIP: source frames are uploaded with UNPACK_FLIP_Y_WEBGL, so the
  // input texture's v=0 is the BOTTOM of the source and v=1 the TOP — the
  // same convention every fullscreen-quad module relies on when it samples
  // texture(uTex, vUv) and renders upright (CHROMA, BENTBOX, etc.). Grid
  // row 0 (v0=0) is placed at the NDC TOP (ndcY = 1 - 0), so we must read
  // the texture TOP there: sample at (h0, 1.0 - v0). Without the flip,
  // row 0 read texture v=0 (source bottom) and drew it at the top, i.e.
  // the whole raster came out vertically inverted vs. every sibling.
  //
  // IMPORTANT: use textureLod(..., 0.0), NOT texture(). In GLSL ES 3.00 a
  // VERTEX-stage texture() has no implicit LOD (no fragment-quad
  // derivatives exist), so the LOD it samples is implementation-defined.
  // SwiftShader/ANGLE-Vulkan happens to pick LOD 0, but the macOS
  // ANGLE-Metal backend can return a constant value for every vertex —
  // which collapses lum to a constant and turns the per-vertex luma
  // RELIEF into a UNIFORM raster translation (the owner-reported X/Y Disp
  // bug). textureLod with an explicit LOD of 0.0 forces the base mip on
  // every driver, restoring the per-vertex heightmap.
  vec4 src = textureLod(uZ, vec2(h0, 1.0 - v0), 0.0);
  float lum = dot(src.rgb, vec3(0.299, 0.587, 0.114));

  // Shaped ramps → base H/V position. morph 0 = linear, so the unshaped
  // raster reproduces the source 1:1 before luma displacement.
  float h = shapedRamp(h0 * uXFreq + uXPhase, vec2(h0, v0), uXShape);
  float v = shapedRamp(v0 * uYFreq + uYPhase, vec2(h0, v0), uYShape);

  // Bipolar displacement (lum - 0.5 so mid-grey doesn't move).
  float x = h + (lum - 0.5) * uXDisp;
  float y = v + (lum - 0.5) * uYDisp;

  // [0,1] → NDC. UVs are y-down; GL NDC is y-up, so flip Y (matches the
  // Metal port's ndcY = 1 - y*2).
  float ndcX = x * 2.0 - 1.0;
  float ndcY = 1.0 - y * 2.0;

  gl_Position = vec4(ndcX, ndcY, 0.0, 1.0);
  vColor = src.rgb * uIntensity * vec3(uTintR, uTintG, uTintB);
}`;

const FRAG_SRC = `#version 300 es
precision highp float;
in vec3 vColor;
out vec4 outColor;
void main() {
  outColor = vec4(vColor, 1.0);
}`;

interface RuttetraParams {
  xShape: number;
  yShape: number;
  xDisp: number;
  yDisp: number;
  intensity: number;
  tintR: number;
  tintG: number;
  tintB: number;
  xFreq: number;
  yFreq: number;
  xPhase: number;
  yPhase: number;
}

const DEFAULTS: RuttetraParams = {
  xShape: 0,
  yShape: 0,
  xDisp: 0,
  // Default -0.3 makes bright pixels push UP → the classic "raised
  // terrain" Rutt-Etra look out of the box (matches XYZState.swift).
  yDisp: -0.3,
  // 1.5 keeps the additive lines from looking too dim (matches XYZState).
  intensity: 1.5,
  tintR: 1.0,
  tintG: 1.0,
  tintB: 1.0,
  xFreq: 1.0,
  yFreq: 1.0,
  xPhase: 0,
  yPhase: 0,
};

/** Build the line-list index buffer EXACTLY like XYZRenderer.swift:
 *  connect adjacent columns within each row. 2*(cols-1)*rows indices.
 *  Exposed for unit tests. */
export function buildRuttetraIndices(cols = COLS, rows = ROWS): Uint32Array {
  const out = new Uint32Array(2 * (cols - 1) * rows);
  let i = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols - 1; c++) {
      out[i++] = r * cols + c;
      out[i++] = r * cols + c + 1;
    }
  }
  return out;
}

export const RUTTETRA_GRID = { cols: COLS, rows: ROWS } as const;

export const ruttetraDef: VideoModuleDef = {
  type: 'ruttetra',
  palette: { top: 'Video modules', sub: 'Processors' },
  domain: 'video',
  // Display name only — the type id stays 'ruttetra' so existing patches/edges
  // /persistence and all test/VRT/registry keys are untouched (shallow rename).
  label: 'xyz',
  category: 'output',
  // schemaVersion 2: the type id `ruttetra` previously belonged to the
  // coord-remap (now RESHAPER, schemaVersion 1). Patches saved before the
  // rename recorded `ruttetra: 1`; the persistence loader remaps those to
  // `reshaper` so old saves keep their look. See graph/persistence.ts.
  inputs: [
    // Single source video. Polymorphic 'video' so mono-video / image /
    // keys upcast in via the engine's implicit upcasts. (No X/Y
    // coordinate-field inputs — the ramp is internal; that's the
    // difference from RESHAPER.)
    { id: 'z', type: 'video' },
    // CV inputs for the expressive params. port id == param id so the
    // cross-domain CV bridge routes audio cv → setParam(portId).
    { id: 'xShape',    type: 'cv', paramTarget: 'xShape',    cvScale: { mode: 'linear' } },
    { id: 'yShape',    type: 'cv', paramTarget: 'yShape',    cvScale: { mode: 'linear' } },
    { id: 'xDisp',     type: 'cv', paramTarget: 'xDisp',     cvScale: { mode: 'linear' } },
    { id: 'yDisp',     type: 'cv', paramTarget: 'yDisp',     cvScale: { mode: 'linear' } },
    { id: 'intensity', type: 'cv', paramTarget: 'intensity', cvScale: { mode: 'linear' } },
    { id: 'xFreq',     type: 'cv', paramTarget: 'xFreq',     cvScale: { mode: 'linear' } },
    { id: 'yFreq',     type: 'cv', paramTarget: 'yFreq',     cvScale: { mode: 'linear' } },
  ],
  outputs: [
    { id: 'out', type: 'video' },
  ],
  params: [
    { id: 'xShape',    label: 'X Shape',   defaultValue: DEFAULTS.xShape,    min: 0,    max: 1, curve: 'linear' },
    { id: 'yShape',    label: 'Y Shape',   defaultValue: DEFAULTS.yShape,    min: 0,    max: 1, curve: 'linear' },
    { id: 'xDisp',     label: 'X Disp',    defaultValue: DEFAULTS.xDisp,     min: -1,   max: 1, curve: 'linear' },
    { id: 'yDisp',     label: 'Y Disp',    defaultValue: DEFAULTS.yDisp,     min: -1,   max: 1, curve: 'linear' },
    { id: 'intensity', label: 'Intensity', defaultValue: DEFAULTS.intensity, min: 0,    max: 2, curve: 'linear' },
    { id: 'tintR',     label: 'Tint R',    defaultValue: DEFAULTS.tintR,     min: 0,    max: 1, curve: 'linear' },
    { id: 'tintG',     label: 'Tint G',    defaultValue: DEFAULTS.tintG,     min: 0,    max: 1, curve: 'linear' },
    { id: 'tintB',     label: 'Tint B',    defaultValue: DEFAULTS.tintB,     min: 0,    max: 1, curve: 'linear' },
    { id: 'xFreq',     label: 'X Freq',    defaultValue: DEFAULTS.xFreq,     min: 0.25, max: 8, curve: 'linear' },
    { id: 'yFreq',     label: 'Y Freq',    defaultValue: DEFAULTS.yFreq,     min: 0.25, max: 8, curve: 'linear' },
    { id: 'xPhase',    label: 'X Phase',   defaultValue: DEFAULTS.xPhase,    min: 0,    max: 1, curve: 'linear' },
    { id: 'yPhase',    label: 'Y Phase',   defaultValue: DEFAULTS.yPhase,    min: 0,    max: 1, curve: 'linear' },
  ],

  // docs-hash-ignore:start
  docs: {
    explanation: `An authentic forward-scatter Rutt/Etra scan-processor. A 320x180 grid of sample points walks the Z source; for each point it reads the source luma, places it along an internally-generated H/V ramp, then displaces that position by (luma - 0.5) so bright pixels push their scanline outward and dark pixels recede - building a 3D heightmap relief out of the picture. Adjacent grid points within each row are joined into horizontal LINE segments, and the whole raster is drawn with additive (phosphor) blending over a black field, exactly like a CRT scope. With everything at default the ramp is a linear 1:1 mapping and Y Disp = -0.3, so the source is read upright and bright areas raise the terrain - the classic Rutt/Etra "raised landscape" look. Patch any video, image, or keyer into Z; sweep Y Disp (and X Disp) for relief depth, raise Intensity for a brighter glow, morph the X/Y Shape ramps toward triangle/soft/radial for warped scan geometry, and modulate the params with CV for animated topography. Z left unpatched binds a mid-grey sentinel (luma 0.5 = zero displacement), so the card shows flat scanlines rather than a black void. The card has a live preview screen; hiding the controls turns it into a resizable monitor (drag the bottom-right corner, double-click to restore) — a viewport only, it does not change the output resolution.`,
    inputs: {
      z: "Z (video) - the source frame. Its per-pixel luma (0.299R+0.587G+0.114B) is sampled at each of the 320x180 grid points and drives that point's outward displacement; the source RGB is also carried through as the scanline color. Accepts video, mono-video, image, or keys (upcast by the engine). Unpatched, a mid-grey 1x1 texture is bound so luma is 0.5 everywhere and the scanlines draw flat instead of going black.",
      xShape: "X Shape (cv) - modulates the X Shape control, morphing the horizontal ramp shape (linear -> triangle -> soft-fold -> radial) that positions each scanline across the frame.",
      yShape: "Y Shape (cv) - modulates the Y Shape control, morphing the vertical ramp shape (linear -> triangle -> soft-fold -> radial) that stacks the scanlines down the frame.",
      xDisp: "X Disp (cv) - modulates the X Disp control, scaling how far each point is pushed left/right by its luma (bipolar around mid-grey).",
      yDisp: "Y Disp (cv) - modulates the Y Disp control, scaling how far each point is pushed up/down by its luma; this is the main relief/height knob of the heightmap.",
      intensity: "Intensity (cv) - modulates the Intensity control, scaling the brightness of the additively-blended scanlines.",
      xFreq: "X Freq (cv) - modulates the X Freq control, setting how many horizontal ramp cycles span the frame (0.25..8); higher values repeat the scan pattern across X.",
      yFreq: "Y Freq (cv) - modulates the Y Freq control, setting how many vertical ramp cycles span the frame (0.25..8); higher values repeat the scan pattern down Y.",
    },
    outputs: {
      out: "out (video) - the rendered Rutt/Etra raster: additive horizontal scanlines, luma-displaced into a heightmap, over a black phosphor field. Chainable into any video input and also feeds the on-card preview screen.",
    },
    controls: {
      xShape: "X Shape (0..1, default 0) - morphs the horizontal ramp shape that lays the source across each scanline. 0 = linear (1:1, the unwarped raster), ~0.33 = triangle, ~0.66 = soft-fold (raised cosine), 1 = radial (distance from center). The card prints the current name (linear / triangle / soft / radial and the crossfades between them).",
      yShape: "Y Shape (0..1, default 0) - morphs the vertical ramp shape that stacks the scanlines down the frame, through the same linear -> triangle -> soft-fold -> radial sequence as X Shape, with the current name shown on the card.",
      xDisp: "X Disp (-1..1, default 0) - bipolar amount that luma pushes each point horizontally. (luma - 0.5) * X Disp, so mid-grey never moves; negative and positive deflect bright pixels to opposite sides.",
      yDisp: "Y Disp (-1..1, default -0.3) - bipolar amount that luma pushes each point vertically; this builds the 3D relief. The default -0.3 makes bright pixels rise (the classic raised-terrain look).",
      intensity: "Intensity (0..2, default 1.5) - multiplies the scanline color before the additive blend; raises or dims the overall glow of the raster (default 1.5 keeps the additive lines from looking too faint). It affects brightness only, not relief depth.",
      tintR: "Tint R (0..1, default 1) - red multiplier applied to every scanline's color. Lower it to drain red from the phosphor tint. No CV input (panel knob only).",
      tintG: "Tint G (0..1, default 1) - green multiplier applied to every scanline's color. Lower it to drain green from the phosphor tint. No CV input (panel knob only).",
      tintB: "Tint B (0..1, default 1) - blue multiplier applied to every scanline's color. Combine R/G/B to push the whole raster toward a monochrome CRT hue. No CV input (panel knob only).",
      xFreq: "X Freq (0.25..8, default 1) - horizontal ramp frequency: how many shape-ramp cycles span the frame in X. 1 = one pass; higher values repeat/fold the scan pattern across the width. Lives under the card's ADVANCED disclosure.",
      yFreq: "Y Freq (0.25..8, default 1) - vertical ramp frequency: how many shape-ramp cycles span the frame in Y. 1 = one pass; higher values repeat/fold the scanlines down the height. Lives under the card's ADVANCED disclosure.",
      xPhase: "X Phase (0..1, default 0) - phase offset added to the horizontal ramp after the frequency multiply and before shaping, sliding the X scan pattern sideways. Panel knob only (no CV input); under the ADVANCED disclosure.",
      yPhase: "Y Phase (0..1, default 0) - phase offset added to the vertical ramp after the frequency multiply and before shaping, sliding the Y scan pattern up/down. Panel knob only (no CV input); under the ADVANCED disclosure.",
    },
  },
  // docs-hash-ignore:end
  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;

    // ---- Build our own program (line geometry needs a custom vertex
    //      shader; the engine's compileFragment only does fullscreen
    //      quads). ----
    function compile(type: number, src: string): WebGLShader {
      const sh = gl.createShader(type);
      if (!sh) throw new Error('RUTTETRA: createShader failed');
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(sh);
        gl.deleteShader(sh);
        throw new Error(`RUTTETRA: shader compile failed: ${log}`);
      }
      return sh;
    }
    const vs = compile(gl.VERTEX_SHADER, VERT_SRC);
    const fs = compile(gl.FRAGMENT_SHADER, FRAG_SRC);
    const program = gl.createProgram();
    if (!program) throw new Error('RUTTETRA: createProgram failed');
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error(`RUTTETRA: program link failed: ${log}`);
    }

    const uZ         = gl.getUniformLocation(program, 'uZ');
    const uCols      = gl.getUniformLocation(program, 'uCols');
    const uRows      = gl.getUniformLocation(program, 'uRows');
    const uXShape    = gl.getUniformLocation(program, 'uXShape');
    const uYShape    = gl.getUniformLocation(program, 'uYShape');
    const uXDisp     = gl.getUniformLocation(program, 'uXDisp');
    const uYDisp     = gl.getUniformLocation(program, 'uYDisp');
    const uIntensity = gl.getUniformLocation(program, 'uIntensity');
    const uTintR     = gl.getUniformLocation(program, 'uTintR');
    const uTintG     = gl.getUniformLocation(program, 'uTintG');
    const uTintB     = gl.getUniformLocation(program, 'uTintB');
    const uXFreq     = gl.getUniformLocation(program, 'uXFreq');
    const uYFreq     = gl.getUniformLocation(program, 'uYFreq');
    const uXPhase    = gl.getUniformLocation(program, 'uXPhase');
    const uYPhase    = gl.getUniformLocation(program, 'uYPhase');

    // ---- Index buffer + VAO (attributeless; gl_VertexID supplies the
    //      grid-point id). ----
    const indices = buildRuttetraIndices(COLS, ROWS);
    const indexCount = indices.length;
    const vao = gl.createVertexArray();
    const ibo = gl.createBuffer();
    if (!vao || !ibo) throw new Error('RUTTETRA: VAO / index buffer alloc failed');
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);

    // ---- Per-instance FBO (output target + chainable `out` texture). ----
    const { fbo, texture } = ctx.createFbo();

    // Mid-grey 1×1 sentinel for unpatched Z — luma 0.5 → zero
    // displacement → flat scanlines (visible, not a black void).
    const greyTex = gl.createTexture();
    if (!greyTex) throw new Error('RUTTETRA: createTexture failed');
    gl.bindTexture(gl.TEXTURE_2D, greyTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([128, 128, 128, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const params: RuttetraParams = { ...DEFAULTS, ...(node.params as Partial<RuttetraParams>) };

    const surface: VideoNodeSurface = {
      fbo,
      texture,
      draw(frame) {
        const g = frame.gl;
        const zTex = frame.getInputTexture(node.id, 'z');

        g.bindFramebuffer(g.FRAMEBUFFER, fbo);
        g.viewport(0, 0, ctx.res.width, ctx.res.height);

        // Clear to black (CRT phosphor backdrop) then additive-blend the
        // scanlines. Save/restore so we don't leak blend state to the
        // next module in the topo order (fullscreen-quad modules assume
        // blend is off).
        g.clearColor(0, 0, 0, 1);
        g.clear(g.COLOR_BUFFER_BIT);
        g.enable(g.BLEND);
        g.blendFunc(g.ONE, g.ONE);
        g.blendEquation(g.FUNC_ADD);

        g.useProgram(program);
        g.activeTexture(g.TEXTURE0);
        g.bindTexture(g.TEXTURE_2D, zTex ?? greyTex);
        g.uniform1i(uZ, 0);

        g.uniform1f(uCols, COLS);
        g.uniform1f(uRows, ROWS);
        g.uniform1f(uXShape,    params.xShape);
        g.uniform1f(uYShape,    params.yShape);
        g.uniform1f(uXDisp,     params.xDisp);
        g.uniform1f(uYDisp,     params.yDisp);
        g.uniform1f(uIntensity, params.intensity);
        g.uniform1f(uTintR,     params.tintR);
        g.uniform1f(uTintG,     params.tintG);
        g.uniform1f(uTintB,     params.tintB);
        g.uniform1f(uXFreq,     params.xFreq);
        g.uniform1f(uYFreq,     params.yFreq);
        g.uniform1f(uXPhase,    params.xPhase);
        g.uniform1f(uYPhase,    params.yPhase);

        g.bindVertexArray(vao);
        g.drawElements(g.LINES, indexCount, g.UNSIGNED_INT, 0);
        g.bindVertexArray(null);

        g.disable(g.BLEND);
      },
      dispose() {
        gl.deleteFramebuffer(fbo);
        gl.deleteTexture(texture);
        gl.deleteTexture(greyTex);
        gl.deleteBuffer(ibo);
        gl.deleteVertexArray(vao);
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
      read(key) {
        if (key === 'fboTexture') return texture;
        return undefined;
      },
      dispose() { surface.dispose(); },
    };
  },
};
