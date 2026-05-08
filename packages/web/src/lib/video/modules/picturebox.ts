// packages/web/src/lib/video/modules/picturebox.ts
//
// PICTUREBOX — image-file source. User picks a file in the card UI; the
// decoded ImageBitmap is uploaded into our output texture and the
// shader passes it through (with a gain knob).
//
// Phase-1 scope: single-output `image` cable; the `r/g/b` per-channel
// outputs from §3.2 are deferred — DESTRUCTOR + downstream COLORIZER
// give the same effect via composition. IndexedDB-backed multiplayer
// sharing is also deferred (the multiplayer story for image bytes is
// non-trivial; see PR notes).
//
// File-picker UX lives in PictureboxCard.svelte; this factory exposes
// `setImage(bitmap)` via the handle's `read` channel so the card can
// drive uploads. `setImage(null)` clears.

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';

const FRAG_SRC = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uTex;
uniform float uHasImage;
uniform float uGain;

void main() {
  if (uHasImage < 0.5) {
    // Idle: subtle dark teal so the card reads as "alive but empty"
    // rather than "broken".
    outColor = vec4(0.02, 0.06, 0.08, 1.0);
    return;
  }
  vec3 col = texture(uTex, vUv).rgb * uGain;
  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

interface PictureboxParams {
  gain: number;
}

const DEFAULTS: PictureboxParams = {
  gain: 1.0,
};

// We expose a small "read"-channel command surface so the UI card can
// upload an ImageBitmap (or HTMLImageElement) into our source texture
// without reaching directly into GL. The card calls
// `engine.read(nodeId, 'setImage:<token>')` and the handle's read()
// implementation pulls the bitmap from a local registry — but simpler
// for Phase-1: expose `read('imageRef')` that returns the underlying
// uploader function.
export interface PictureboxHandleExtras {
  setImage: (bitmap: ImageBitmap | HTMLImageElement | null) => void;
  /** Filename string, surfaced in the UI. */
  setFilename: (name: string | null) => void;
  /** Currently-loaded filename. */
  filename: () => string | null;
}

export const pictureboxDef: VideoModuleDef = {
  type: 'picturebox',
  domain: 'video',
  label: 'PICTUREBOX',
  category: 'sources',
  schemaVersion: 1,
  inputs: [
    { id: 'gain', type: 'cv' },
  ],
  outputs: [
    { id: 'out', type: 'image' },
  ],
  params: [
    { id: 'gain', label: 'Gain', defaultValue: DEFAULTS.gain, min: 0, max: 2, curve: 'linear' },
  ],

  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;
    const program = ctx.compileFragment(FRAG_SRC);

    const uTex      = gl.getUniformLocation(program, 'uTex');
    const uHasImage = gl.getUniformLocation(program, 'uHasImage');
    const uGain     = gl.getUniformLocation(program, 'uGain');

    // Output FBO (where the shader writes); plus a separate "source"
    // texture that the card uploads ImageBitmaps into. Two textures
    // because we want to keep the output FBO at engine-resolution
    // regardless of the source image's dimensions.
    const { fbo, texture } = ctx.createFbo();

    const sourceTex = gl.createTexture();
    if (!sourceTex) throw new Error('PICTUREBOX: createTexture failed');
    gl.bindTexture(gl.TEXTURE_2D, sourceTex);
    // Initialize 1x1 black so the sampler is always bound to something
    // sane before the user picks a file.
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    let hasImage = false;
    let filename: string | null = null;

    const params: PictureboxParams = { ...DEFAULTS, ...(node.params as Partial<PictureboxParams>) };

    function setImage(bitmap: ImageBitmap | HTMLImageElement | null): void {
      if (!bitmap) {
        hasImage = false;
        return;
      }
      gl.bindTexture(gl.TEXTURE_2D, sourceTex);
      // Image data is RGBA; flip Y so the image renders right-side-up
      // (texImage2D defaults to bottom-up texel layout).
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      hasImage = true;
    }

    const surface: VideoNodeSurface = {
      fbo,
      texture,
      draw(frame) {
        const g = frame.gl;
        g.bindFramebuffer(g.FRAMEBUFFER, fbo);
        g.viewport(0, 0, ctx.res.width, ctx.res.height);
        g.useProgram(program);

        g.activeTexture(g.TEXTURE0);
        g.bindTexture(g.TEXTURE_2D, sourceTex);
        g.uniform1i(uTex, 0);
        g.uniform1f(uHasImage, hasImage ? 1.0 : 0.0);
        g.uniform1f(uGain, params.gain);

        ctx.drawFullscreenQuad();
        g.bindFramebuffer(g.FRAMEBUFFER, null);
      },
      dispose() {
        gl.deleteFramebuffer(fbo);
        gl.deleteTexture(texture);
        gl.deleteTexture(sourceTex);
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
        if (key === 'hasImage') return hasImage;
        if (key === 'filename') return filename;
        if (key === 'extras') {
          const extras: PictureboxHandleExtras = {
            setImage,
            setFilename: (name) => { filename = name; },
            filename: () => filename,
          };
          return extras;
        }
        return undefined;
      },
      dispose() { surface.dispose(); },
    };
  },
};
