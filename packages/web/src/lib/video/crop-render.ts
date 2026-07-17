// packages/web/src/lib/video/crop-render.ts
//
// REUSABLE GPU crop pass — the render half of the crop feature (the pure model
// + math live in crop-core.ts, the editor UI in ui/video/CropOverlay.svelte).
// Module-agnostic: any video module that wants a "Crop" output creates ONE of
// these, points it at whatever source texture it already produces, and exposes
// the pass's `texture` on `read('outputTexture:crop')`. VIDEOVARISPEED wires it
// up first.
//
// The pass is a single fullscreen-quad shader that samples a windowed sub-rect
// of the source texture and writes it, scaled to the full engine resolution,
// into its own managed FBO. A full-frame window (the passthrough default) is a
// straight copy — so the Crop output is NEVER black and always streams, which
// also keeps the registry's per-port / behavioral sweeps seeing deltas with no
// exemption. Cheap: no CPU readback, one extra draw per frame.
//
// The FBO is engine-MANAGED (ctx.createFbo default), so it auto-resizes with
// the FBO's colour texture on an OUTPUT aspect switch — the module needs no
// resize plumbing for it.

import type { VideoEngineContext } from './engine';
import { cropSampleWindow, resolveCrop, type CropRect } from './crop-core';

// vUv is the shared vertex shader's 0..1 quad coord (y-up: vUv.y=0 = bottom of
// the render target). We window the source: sampleUV = uOrigin + vUv * uSize.
// uOrigin/uSize come from cropSampleWindow (already y-up), so a passthrough
// window (0,0,1,1) reproduces the source exactly.
const CROP_FRAG = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uTex;
uniform vec2 uOrigin; // GL sample-UV origin (y-up)
uniform vec2 uSize;   // GL sample-UV size

void main() {
  vec2 uv = uOrigin + vUv * uSize;
  outColor = vec4(texture(uTex, uv).rgb, 1.0);
}`;

export interface CropPass {
  /** The crop output FBO (engine-managed; auto-resizes with the aspect switch). */
  readonly fbo: WebGLFramebuffer;
  /** The crop output colour texture — expose this on read('outputTexture:crop'). */
  readonly texture: WebGLTexture;
  /**
   * Render `srcTexture` cropped by `rect` (or the FULL frame when `rect` is
   * null — passthrough) into the crop FBO at the full engine resolution.
   * `frameAspect`/`regionAspect` resolve the rect's derived height (for
   * VIDEOVARISPEED both are the live output aspect ⇒ a square in UV). Restores
   * the default framebuffer binding when done.
   */
  render(
    srcTexture: WebGLTexture | null,
    rect: CropRect | null,
    frameAspect: number,
    regionAspect: number,
  ): void;
  /** Release the program + FBO/texture. */
  dispose(): void;
}

export function createCropPass(ctx: VideoEngineContext): CropPass {
  const gl = ctx.gl;
  const program = ctx.compileFragment(CROP_FRAG);
  const uTex = gl.getUniformLocation(program, 'uTex');
  const uOrigin = gl.getUniformLocation(program, 'uOrigin');
  const uSize = gl.getUniformLocation(program, 'uSize');
  const { fbo, texture } = ctx.createFbo();

  return {
    fbo,
    texture,
    render(srcTexture, rect, frameAspect, regionAspect) {
      const win = rect
        ? cropSampleWindow(resolveCrop(rect, frameAspect, regionAspect))
        : { u0: 0, v0: 0, w: 1, h: 1 };

      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.viewport(0, 0, ctx.res.width, ctx.res.height);
      gl.useProgram(program);
      gl.activeTexture(gl.TEXTURE0);
      // A null source (e.g. no frame yet) still runs the pass against the crop
      // FBO's own (previous) texture would be a feedback loop, so bind the crop
      // texture only when a real source exists; otherwise bind nothing and let
      // the sampler read the last-bound (harmless for the idle case — the module
      // gates on its own hasInput before showing the crop anyway).
      gl.bindTexture(gl.TEXTURE_2D, srcTexture ?? texture);
      gl.uniform1i(uTex, 0);
      gl.uniform2f(uOrigin, win.u0, win.v0);
      gl.uniform2f(uSize, win.w, win.h);
      ctx.drawFullscreenQuad();
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    },
    dispose() {
      gl.deleteFramebuffer(fbo);
      gl.deleteTexture(texture);
      gl.deleteProgram(program);
    },
  };
}
