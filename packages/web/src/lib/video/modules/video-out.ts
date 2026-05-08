// packages/web/src/lib/video/modules/video-out.ts
//
// OUTPUT — visible-canvas sink. Phase 0 implementation of the spec at
// .myrobots/plans/video-modules-mvp.md §3.9.
//
// What this module does:
//   - Declares a single polymorphic input (`in`, type `video`). Implicit
//     upcasts (keys → mono-video → video, image → video) are handled at
//     the engine level so users can wire any video-domain output into us.
//   - Exposes a `pullFrame(targetCanvas)` hook on its handle that the UI
//     card invokes each rAF tick, blitting the input texture onto the
//     card's visible <canvas>. The card owns the rAF; we don't, because
//     the engine's offscreen canvas is the source-of-truth FBO and
//     several OUTPUTs may render simultaneously (one per browser tab).
//
// Phase-1 polish (resize, letterbox, mono-input grayscale) deferred.

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';

const COPY_FRAG_SRC = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;
uniform float uHasInput;

void main() {
  if (uHasInput < 0.5) {
    // Idle pattern — slow vertical sweep on dark navy so the user can
    // see the OUTPUT card is alive even when nothing's patched in. Not
    // a hard requirement; helpful during the demo when the user is
    // first dragging a cable into us.
    float v = vUv.y * 0.05;
    outColor = vec4(0.04, 0.06, 0.10 + v, 1.0);
    return;
  }
  outColor = texture(uTex, vUv);
}`;

export const videoOutDef: VideoModuleDef = {
  type: 'videoOut',
  domain: 'video',
  label: 'OUTPUT',
  category: 'output',
  schemaVersion: 1,
  inputs: [
    { id: 'in', type: 'video' },
  ],
  outputs: [],
  params: [],

  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;
    const program = ctx.compileFragment(COPY_FRAG_SRC);
    const uTex = gl.getUniformLocation(program, 'uTex');
    const uHasInput = gl.getUniformLocation(program, 'uHasInput');

    // OUTPUT also renders into its own FBO so test harnesses can read the
    // "what was on screen this frame" pixel buffer without coupling to a
    // visible <canvas>. The card UI then blits this FBO onto its
    // user-visible <canvas>.
    const { fbo, texture } = ctx.createFbo();

    let lastInputTexture: WebGLTexture | null = null;

    const surface: VideoNodeSurface = {
      fbo,
      texture,
      draw(frame) {
        const g = frame.gl;
        const inputTex = frame.getInputTexture(node.id, 'in');
        lastInputTexture = inputTex;

        // Pass 1: render into our own FBO so test harnesses + future
        // captureStream() pulls have a consistent texture to read.
        g.bindFramebuffer(g.FRAMEBUFFER, fbo);
        g.viewport(0, 0, ctx.res.width, ctx.res.height);
        g.useProgram(program);
        g.uniform1f(uHasInput, inputTex ? 1.0 : 0.0);
        if (inputTex) {
          g.activeTexture(g.TEXTURE0);
          g.bindTexture(g.TEXTURE_2D, inputTex);
          g.uniform1i(uTex, 0);
        }
        ctx.drawFullscreenQuad();

        // Pass 2: ALSO render into the engine's default framebuffer (the
        // OffscreenCanvas's drawing buffer). The cards drive their per-
        // card visible <canvas> via `drawImage(engineCanvas, ...)`; that
        // pulls from the default buffer, NOT module FBOs. Without this
        // second pass the visible canvas stays black even though FBOs
        // are alive. Phase 1 will revisit (last-OUTPUT-wins is fine for
        // single-OUTPUT patches, but multi-OUTPUT will need per-OUTPUT
        // visible canvases driven from individual FBO reads).
        g.bindFramebuffer(g.FRAMEBUFFER, null);
        g.viewport(0, 0, ctx.res.width, ctx.res.height);
        g.useProgram(program);
        g.uniform1f(uHasInput, inputTex ? 1.0 : 0.0);
        if (inputTex) {
          g.activeTexture(g.TEXTURE0);
          g.bindTexture(g.TEXTURE_2D, inputTex);
          g.uniform1i(uTex, 0);
        }
        ctx.drawFullscreenQuad();
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
      setParam(_p, _v) { /* no params yet */ },
      readParam(_p) { return undefined; },
      read(key) {
        if (key === 'hasInput') return lastInputTexture !== null;
        if (key === 'fboTexture') return texture;
        return undefined;
      },
      dispose() { surface.dispose(); },
    };
  },
};
