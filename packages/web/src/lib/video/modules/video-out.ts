// packages/web/src/lib/video/modules/video-out.ts
//
// OUTPUT — visible-canvas sink. Phase 0 implementation of the spec at
// .myrobots/plans/video-modules-mvp.md §3.9.
//
// What this module does:
//   - Declares a single polymorphic input (`in`, type `video`). Implicit
//     upcasts (keys → mono-video → video, image → video) are handled at
//     the engine level so users can wire any video-domain output into us.
//   - Per-frame draw renders the input texture into THIS instance's own
//     FBO. The card driving the visible <canvas> calls
//     `engine.blitOutputToDrawingBuffer(nodeId)` right before its
//     `drawImage(engine.canvas, ...)` blit so each OUTPUT card pulls its
//     own per-instance content (not whatever the last OUTPUT happened to
//     write to the shared default framebuffer).
//
// Chainable output (post-video-chain-outputs):
//
// OUTPUT also exposes its FBO texture via the standard `out` port so users
// can chain monitor cards into downstream effects without breaking the
// signal flow. Since OUTPUT's draw writes the input texture (or idle
// pattern) into its FBO every frame, the `out` port is effectively a
// pass-through of `in` (input → FBO → out). The engine's lookupInput
// falls back to surface.texture for single-output modules, so no special
// routing is needed beyond declaring the port.
//
// Multi-OUTPUT routing fix (post-PR-65):
//
// Phase-0 had the OUTPUT module rendering BOTH into its own FBO (pass 1)
// AND into the engine's default FB (pass 2) so the cards' shared
// `drawImage(engine.canvas)` would have something to read. With one
// OUTPUT that worked. With N OUTPUTs in the same engine, every OUTPUT's
// pass 2 wrote to the same shared default FB — the LAST one in topo
// order won, so all N cards displayed the same content (the last
// OUTPUT's input). Fix: pass 2 is gone; engine.blitOutputToDrawingBuffer
// hands ownership of the default-FB write to the card so each card can
// request its own OUTPUT's content right before reading.
//
// Inputs:
//   in (video): polymorphic video input — accepts video, mono-video (upcast), or image.
//
// Outputs:
//   out (video): pass-through of the input FBO (engine reads surface.texture).
//
// Params: none.

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
  palette: { top: 'Video modules', sub: 'Utilities' },
  domain: 'video',
  label: 'output',
  category: 'output',
  schemaVersion: 1,
  inputs: [
    { id: 'in', type: 'video' },
  ],
  outputs: [
    { id: 'out', type: 'video' },
  ],
  params: [],

  // docs-hash-ignore:start
  docs: {
    explanation: "output is the screen sink of the video chain — the card body itself is the live picture. Whatever video signal you patch into it is copied frame-by-frame into this card's own framebuffer (FBO) and blitted onto the visible canvas, aspect-fit (the engine render is letterboxed into the card; the engine is 4:3 by default). The shader is a plain texture copy: with a signal patched it shows the input verbatim; with nothing patched it draws a static idle pattern — a dark navy field with a subtle vertical brightness gradient (the blue channel rises toward one edge) — so you can tell the card is alive while you drag a cable in. The pattern does not animate; there is no time uniform, so it's a fixed gradient, not a moving sweep. Each output card pulls its OWN input via engine.blitOutputToDrawingBuffer(nodeId) (multiple outputs in a rack each show their own feed, no last-one-wins coupling). Right-click the picture for true fullscreen, in-app full-frame (hides chrome, fills the card), or present-on-a-second-display. Use it as the monitor/projector at the end of a video patch — or mid-chain, since it passes its input straight through. The card body is the live output screen and is resizable by dragging the bottom-right corner handle; the engine render (4:3 by default, 1024×768) is aspect-fit (letterboxed) inside whatever size you choose, and the size (node.data.width/height) syncs to collaborators via Y.Doc.",
    inputs: {
      in: "The video signal to display. Polymorphic video input (type video) — it accepts a full video signal, and the engine implicitly upcasts narrower video-domain sources too (keys → mono-video → video, and image → video), so you can wire essentially any video output into it. With nothing patched, the shader's uHasInput branch draws the static navy idle gradient instead of black.",
    },
    outputs: {
      out: "Pass-through of the input. Each frame the card's draw renders its input texture into its own FBO, and out exposes that FBO's texture — effectively a clean copy of in (input → FBO → out). Wire it onward to chain a monitor into downstream video effects without breaking the signal flow; with no input it carries the static idle pattern.",
    },
    controls: {},
  },
  // docs-hash-ignore:end
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

        // Render into our own FBO. The card driving the visible
        // <canvas> selectively re-blits THIS instance's FBO into the
        // engine's drawing buffer via engine.blitOutputToDrawingBuffer
        // before each rAF tick — that's how multiple OUTPUTs each show
        // their own input rather than all sharing the default FB.
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
