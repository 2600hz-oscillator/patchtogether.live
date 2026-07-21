// packages/web/src/lib/video/frametable-ring.ts
//
// SHARED GPU frame-ring plumbing — the GL resource helpers a video WAVETABLE
// module needs to record N input frames into a TEXTURE_2D_ARRAY ring and detile
// a saved .frametable.png atlas back into it. Extracted from FRAMETABLE's factory
// closure so VIDEOCUBE (which embeds THREE of these rings) reuses the exact same
// allocation / clear / copy-detile primitives instead of duplicating them (the
// spec's `frametable-ring.ts` helper — .myrobots/plans/videocube-2026-07-19.md).
//
// NO per-frame state lives here — these are pure GL allocators + one shader
// source. The ring HEAD / first-frame-fill / freeze REDUCERS remain in the pure
// `frametable-core.ts` (jsdom-unit-tested); the SELECT/read shader stays in each
// module (FRAMETABLE's mosaic vs. VIDEOCUBE's occupancy combine differ).
//
// NOTE (attest): this file lives under lib/video/, so resolveWebglBasis sweeps it
// into the WebGL content-hash basis (the COPY_FRAG shader source is real GL). A
// new/changed basis file is a ONE-TIME re-attest on a trusted GPU — expected when
// VIDEOCUBE lands (it forces the same re-attest).

/**
 * P0 COPY/DETILE shader — copy a source frame into a ring layer. Two callers:
 *   • live CAPTURE — uTileScale=(1,1), uTileOffset=(0,0) ⇒ the identity copy of
 *     the whole input frame;
 *   • file LOAD DETILE — a per-tile sub-rect of an uploaded atlas texture is
 *     copied into each ring layer, GL LINEAR-scaling a differently-sized saved
 *     tile to the current ring res for free.
 *
 * IDENTICAL to FRAMETABLE's COPY_FRAG (kept a byte-for-byte string so the two
 * modules share the exact same detile semantics + the same attest coverage).
 */
export const RING_COPY_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;
uniform float uHas;
uniform vec2 uTileScale;   // (1,1) for a full-frame copy; (1/COLS,1/ROWS) to detile
uniform vec2 uTileOffset;  // (0,0) for a full-frame copy; tile origin in UV to detile
void main(){ outColor = vec4(uHas > 0.5 ? texture(uTex, vUv * uTileScale + uTileOffset).rgb : vec3(0.0), 1.0); }`;

/** An N-layer RGBA8 TEXTURE_2D_ARRAY at (w×h). LINEAR filter, CLAMP on S/T/R. */
export function createRingArray(
  gl: WebGL2RenderingContext,
  w: number,
  h: number,
  layers: number,
): WebGLTexture {
  const tex = gl.createTexture();
  if (!tex) throw new Error('frametable-ring: createTexture (ring array) failed');
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
  gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.RGBA8, w, h, layers, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
  return tex;
}

/** A plain RGBA8 TEXTURE_2D render target (a module's SELECT output = surface.texture). */
export function createRingTarget(
  gl: WebGL2RenderingContext,
  w: number,
  h: number,
): { fbo: WebGLFramebuffer; texture: WebGLTexture } {
  const tex = gl.createTexture();
  if (!tex) throw new Error('frametable-ring: createTexture (output) failed');
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fbo = gl.createFramebuffer();
  if (!fbo) { gl.deleteTexture(tex); throw new Error('frametable-ring: createFramebuffer failed'); }
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.viewport(0, 0, w, h);
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { fbo, texture: tex };
}

/** Clear every layer of a ring array to opaque black so an unwritten layer never
 *  samples garbage. `fbo` is a scratch framebuffer retargeted per layer via
 *  framebufferTextureLayer. */
export function clearRingLayers(
  gl: WebGL2RenderingContext,
  fbo: WebGLFramebuffer,
  ringTex: WebGLTexture,
  layers: number,
  w: number,
  h: number,
): void {
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.viewport(0, 0, w, h);
  gl.clearColor(0, 0, 0, 1);
  for (let i = 0; i < layers; i++) {
    gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, ringTex, 0, i);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}
