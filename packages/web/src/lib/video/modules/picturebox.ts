// packages/web/src/lib/video/modules/picturebox.ts
//
// PICTUREBOX — image-file source. User picks a file in the card UI;
// the file is downscaled to 640x480 + JPEG-encoded + base64-stored in
// `node.data.imageBytes`, which rides the Y.Doc out to all rack-mates.
// On every peer (including the loader), the card decodes those bytes
// back into an ImageBitmap and uploads it into our source texture.
//
// schemaVersion bumped to 2 in this PR; v1 had no imageBytes field
// (file-picker was local-only). `migrate` here ensures legacy patches
// load without warnings.
//
// Limits (see lib/multiplayer/picturebox-limits.ts): 2 PICTUREBOX per
// user, 8 per workspace. The 8/workspace cap is mirrored as
// `maxInstances` so the palette greys out the picker at the cap; the
// per-user cap is enforced in Canvas's spawnFromPalette.
//
// Future: 4-image variant with CV switching. The storage shape will
// generalise to `data.images: string[]` (length 1 today). Not in this PR.
//
// File-picker UX lives in PictureboxCard.svelte; this factory exposes
// `setImage(bitmap)` via the handle's `read` channel so the card can
// drive uploads. `setImage(null)` clears.
//
// Inputs:
//   gain (cv, paramTarget=gain): displaces the gain knob.
//
// Outputs:
//   out (image): the loaded image as a video-domain image source.
//
// Params:
//   gain (linear 0..2): output gain (multiplies the image's RGB).

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

/** Persisted shape on `node.data` for PICTUREBOX nodes (schemaVersion 2). */
export interface PictureboxData {
  /** base64-encoded JPEG q=85 bytes, downscaled to 640x480 zoom-fit-crop.
   *  null when no image has been loaded yet. */
  imageBytes: string | null;
  /** MIME of the encoded bytes. Reserved for future codec switching;
   *  always 'image/jpeg' in this version. */
  imageMime: string;
  /** Human-friendly source filename, surfaced in the card UI. */
  imageName: string | null;
  /** User id of whoever spawned this node (Canvas writes this on spawn).
   *  Used by the per-user cap. Pre-this-PR nodes have no creatorId; they
   *  count toward the workspace total but not toward any user's cap. */
  creatorId?: string;
}

const DATA_DEFAULTS: Pick<PictureboxData, 'imageBytes' | 'imageMime' | 'imageName'> = {
  imageBytes: null,
  imageMime: 'image/jpeg',
  imageName: null,
};

export const pictureboxDef: VideoModuleDef = {
  type: 'picturebox',
  palette: { top: 'Video modules', sub: 'Sources' },
  domain: 'video',
  label: 'picturebox',
  category: 'sources',
  schemaVersion: 2,
  // Workspace cap (8 per rack). Mirrored from
  // lib/multiplayer/picturebox-limits.ts → PICTUREBOX_LIMITS.perWorkspace.
  // The palette uses this to grey out the option once the cap is hit;
  // Canvas's spawnFromPalette is the secondary gate.
  maxInstances: 8,
  inputs: [
    // paramTarget == port id keeps docs manifest in sync. Bridge uses
    // port id directly so the runtime works either way.
    { id: 'gain', type: 'cv', paramTarget: 'gain' },
  ],
  outputs: [
    { id: 'out', type: 'image' },
  ],
  params: [
    { id: 'gain', label: 'Gain', defaultValue: DEFAULTS.gain, min: 0, max: 2, curve: 'linear' },
  ],

  // v1 had no imageBytes/imageMime/imageName/creatorId fields. v2 adds
  // them; the migration just fills in defaults so the card's reactive
  // reads find well-defined values rather than `undefined`.
  migrate(data, fromVersion) {
    const d = (data as Partial<PictureboxData> | null | undefined) ?? {};
    if (fromVersion < 2) {
      return {
        ...d,
        imageBytes: d.imageBytes ?? DATA_DEFAULTS.imageBytes,
        imageMime: d.imageMime ?? DATA_DEFAULTS.imageMime,
        imageName: d.imageName ?? DATA_DEFAULTS.imageName,
        // creatorId intentionally NOT defaulted: legacy nodes stay
        // unattributed (loose grandfathering — see picturebox-limits.ts).
      };
    }
    return d;
  },

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
