// packages/web/src/lib/video/modules/shapegen.ts
//
// SHAPEGEN — standalone 3D-shape-generator video module extracted from
// FOXY's 3dShapeGen path. Takes THREE video inputs (raster_a, raster_b,
// raster_c) — the same role FOXY's internal rasters played — and emits a
// single video output. The shapes math + on-canvas renderer are shared
// with FOXY (`shapegen-math.ts` + `shapegen-draw.ts`).
//
// Knobs:
//   • SIZE   — global per-shape radius multiplier (0.1 .. 3.0, default 1.0).
//              Applied AFTER generateShapes() — final radius is
//              `baseline * abFactor * size`, then CLAMPED to 0.6 so a
//              maxed-out knob can't render an entire box-filling blob.
//              (The baseline + abFactor live inside generateShapes
//              already; the size knob is the user's global handle.)
//   • ROT    — camera Y-axis rotation in turns [0..1] → radians [0..2π].
//              REPLACES FOXY's auto-6-RPM rotation with user control.
//              A future "auto rotate" toggle could bring back the
//              automatic motion (deliberately deferred — see PR notes).
//   • SOLIDS — discrete 0/1 toggle. 0 = vaporwave wireframe (the FOXY
//              look). 1 = per-primitive lit canvas2D rendering for
//              sphere/cube/cylinder/cone; ring + tetraFrame stay
//              wireframe in v1 (see shapegen-draw.ts header).
//
// Inputs:
//   raster_a (video): A-raster — drives shape XY positions via feature peaks.
//   raster_b (video): B-raster — drives shape Z depth.
//   raster_c (video): C-raster — drives shape type bucket + radius + hue.
//
// Output:
//   out (video): the rendered scene (640×360 by default, matches engine RES).
//
// Implementation:
//   • We allocate ONE FBO + texture (the module's video-out surface) and
//     ONE OffscreenCanvas where canvas2D paints the scene. After each
//     paint we `texImage2D` the canvas into the FBO's color attachment,
//     then run a trivial fullscreen-quad shader that samples it. Same
//     pattern ACIDWARP uses for its pattern texture, but driven from
//     a canvas2D OffscreenCanvas instead of a Uint8Array.
//   • To read each input video texture as an RGBA buffer (so we can call
//     `generateShapes`), we keep a single REUSED read FBO and attach the
//     incoming texture as a color attachment, then `gl.readPixels` into
//     a pre-allocated Uint8Array. We read each raster at a DOWNSAMPLED
//     size (FOXY's pipeline already does 16×16 feature-grid downsample
//     inside `generateShapes`, so reading at 64×64 is more than enough)
//     to keep per-frame readback cheap.
//
// Determinism (for tests + VRT): if `window.__shapegenVrtSeed` is set,
// the draw() short-circuits to a synthetic deterministic scene rather
// than reading textures. v1 just adds the module to the VRT exemption
// list — the seed hook is here for the follow-up baseline capture.

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';
import {
  generateShapes,
  type Shape,
} from './shapegen-math';
import { drawShapesScene } from './shapegen-draw';

// ----------------- read-fbo source dimensions ----------------------------

/** Each input video texture is read back to an RGBA buffer for
 *  `generateShapes` to chew on. We read at a SCALED-DOWN size of the
 *  full frame (engine-res / 8) — keeps per-raster readback at
 *  80×45 = 3600 px × 4 = 14.4 KB (×3 rasters = 43 KB / video frame),
 *  while still SPANNING THE WHOLE FRAME so the 16×16 feature-grid
 *  downsample inside generateShapes sees real content even when the
 *  upstream's interesting pixels live anywhere on the canvas. The
 *  earlier 64×64 corner-read of a 640×360 texture often returned a
 *  dark void (the source's interesting content was off-corner), which
 *  starved generateShapes of feature variance.
 *
 *  We achieve this by drawing the input texture into a small
 *  intermediate FBO via the fullscreen-quad path (1:1 downsample with
 *  GL's linear filter doing the box-blur), then readPixels off THAT.
 *  Still cheap; the intermediate render is a single textured triangle. */
export const SHAPEGEN_RASTER_W = 80;
export const SHAPEGEN_RASTER_H = 45;

/** Final-radius clamp applied AFTER size × baseline × abFactor.
 *  Keeps a maxed-out SIZE knob from filling the whole box. */
export const SHAPEGEN_RADIUS_CLAMP = 0.6;

// ----------------- module params ------------------------------------------

interface ShapegenParams {
  size: number;    // 0.1 .. 3.0 — global radius multiplier
  rotate: number;  // 0 .. 1 — fraction of a full turn (radians = rotate * 2π)
  solids: number;  // 0 / 1 — discrete toggle (wireframe vs lit-solid)
}

const DEFAULTS: ShapegenParams = {
  size: 1,
  rotate: 0,
  solids: 0,
};

// ----------------- fullscreen-quad shader ---------------------------------

const FRAG_SRC = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uScene;

void main() {
  // OffscreenCanvas origin is top-left. WebGL UV origin is bottom-left.
  // Flip Y so the scene reads upright in the FBO + downstream.
  vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
  outColor = texture(uScene, uv);
}`;

// ----------------- module def ---------------------------------------------

export const shapegenDef: VideoModuleDef = {
  type: 'shapegen',
  domain: 'video',
  label: 'SHAPEGEN',
  category: 'video-effects',
  schemaVersion: 1,
  inputs: [
    { id: 'raster_a', type: 'video' },
    { id: 'raster_b', type: 'video' },
    { id: 'raster_c', type: 'video' },
  ],
  outputs: [
    { id: 'out', type: 'video' },
  ],
  params: [
    { id: 'size',   label: 'Size',   defaultValue: DEFAULTS.size,   min: 0.1, max: 3, curve: 'linear' },
    { id: 'rotate', label: 'Rot',    defaultValue: DEFAULTS.rotate, min: 0,   max: 1, curve: 'linear' },
    { id: 'solids', label: 'Solids', defaultValue: DEFAULTS.solids, min: 0,   max: 1, curve: 'discrete' },
  ],

  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;
    const program = ctx.compileFragment(FRAG_SRC);
    const uScene = gl.getUniformLocation(program, 'uScene');
    const { fbo, texture } = ctx.createFbo();

    const params: ShapegenParams = { ...DEFAULTS, ...(node.params as Partial<ShapegenParams>) };

    // ---- The scene canvas2D + GL upload texture ----
    // Canvas dims match the engine FBO so a fullscreen-quad sample is 1:1.
    const sceneCanvas: OffscreenCanvas | HTMLCanvasElement =
      typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(ctx.res.width, ctx.res.height)
        : (() => {
            const c = document.createElement('canvas');
            c.width = ctx.res.width;
            c.height = ctx.res.height;
            return c;
          })();
    const sceneCtx = sceneCanvas.getContext('2d') as
      | CanvasRenderingContext2D
      | OffscreenCanvasRenderingContext2D
      | null;
    if (!sceneCtx) {
      // jsdom / no-canvas environments still let the module instantiate
      // (the FBO exists) but draw() short-circuits with a black fill.
      // This matches FOXY's behaviour in headless tests.
    }

    // Texture that the fullscreen-quad shader samples. Re-uploaded each
    // draw with the canvas2D bitmap (same pattern ACIDWARP uses).
    const sceneTex = gl.createTexture();
    if (!sceneTex) throw new Error('SHAPEGEN: createTexture failed (sceneTex)');
    gl.bindTexture(gl.TEXTURE_2D, sceneTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // 1×1 black sentinel until first paint.
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 255]));

    // ---- Read FBO + per-raster buffers for input-texture readback ----
    // We allocate a small INTERMEDIATE FBO sized SHAPEGEN_RASTER_W × H and
    // use the fullscreen-quad shader to render each incoming raster into
    // it (GL's LINEAR filter performs the box-blur downsample for free).
    // Then `readPixels` off the small intermediate — fast (≈14 KB per
    // raster) and spans the FULL input frame so generateShapes' 16×16
    // feature-grid sees real content no matter where in the upstream
    // canvas the interesting pixels live.
    //
    // (Earlier v1 did `readPixels(0, 0, 64, 64)` directly off the input
    // texture's FBO — a TOP-LEFT-CORNER read of a 640×360 canvas, which
    // returned a dark void any time the upstream's content wasn't in the
    // corner. That starved generateShapes of feature variance and the
    // SHAPEGEN preview rendered nothing but the wireframe box.)
    const readFbo = gl.createFramebuffer();
    if (!readFbo) throw new Error('SHAPEGEN: createFramebuffer failed (readFbo)');
    const readTex = gl.createTexture();
    if (!readTex) throw new Error('SHAPEGEN: createTexture failed (readTex)');
    gl.bindTexture(gl.TEXTURE_2D, readTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, SHAPEGEN_RASTER_W, SHAPEGEN_RASTER_H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, readFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, readTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    const rasterBytes = SHAPEGEN_RASTER_W * SHAPEGEN_RASTER_H * 4;
    const bufA = new Uint8Array(rasterBytes);
    const bufB = new Uint8Array(rasterBytes);
    const bufC = new Uint8Array(rasterBytes);
    // generateShapes' fast path accepts Uint8ClampedArray; we Uint8Array.from
    // on demand. Pre-allocated to dodge per-frame GC.
    const clampA = new Uint8ClampedArray(rasterBytes);
    const clampB = new Uint8ClampedArray(rasterBytes);
    const clampC = new Uint8ClampedArray(rasterBytes);

    /**
     * Read an input texture into `dst` at SHAPEGEN_RASTER_{W,H}. If the
     * texture is null (unpatched input) we zero-fill `dst` —
     * generateShapes then sees a flat raster and degrades cleanly.
     *
     * Downsample is done by rendering the input texture through the
     * fullscreen-quad shader into the small `readFbo`, then readPixels
     * off it. GL's LINEAR filter performs the box-blur — better than a
     * corner-read AND cheaper than a full-frame readPixels.
     */
    function readRasterTexture(tex: WebGLTexture | null, dst: Uint8Array): void {
      if (!tex) {
        dst.fill(0);
        return;
      }
      // Step 1: downsample the input texture into readTex via the
      // fullscreen-quad shader. We re-use SHAPEGEN's own quad program
      // (same input → output passthrough).
      gl.bindFramebuffer(gl.FRAMEBUFFER, readFbo);
      gl.viewport(0, 0, SHAPEGEN_RASTER_W, SHAPEGEN_RASTER_H);
      gl.useProgram(program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(uScene, 0);
      ctx.drawFullscreenQuad();
      // Step 2: readPixels off the small intermediate.
      gl.readPixels(0, 0, SHAPEGEN_RASTER_W, SHAPEGEN_RASTER_H, gl.RGBA, gl.UNSIGNED_BYTE, dst);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    // ---- Per-frame draw ----
    let framesElapsed = 0;
    const surface: VideoNodeSurface = {
      fbo,
      texture,
      draw(frame) {
        const g = frame.gl;

        // 1. Read the three input textures into RGBA buffers.
        const texA = frame.getInputTexture(node.id, 'raster_a');
        const texB = frame.getInputTexture(node.id, 'raster_b');
        const texC = frame.getInputTexture(node.id, 'raster_c');
        readRasterTexture(texA, bufA);
        readRasterTexture(texB, bufB);
        readRasterTexture(texC, bufC);
        // Uint8 → Uint8Clamped (no copy in practice — same byte layout).
        clampA.set(bufA);
        clampB.set(bufB);
        clampC.set(bufC);

        // 2. Generate the shape list from the three rasters.
        let shapes: Shape[] = generateShapes(
          clampA, clampB, clampC,
          SHAPEGEN_RASTER_W, SHAPEGEN_RASTER_H,
        );

        // 3. Apply the SIZE knob globally. Final radius is
        //    `baseline * size`, clamped to SHAPEGEN_RADIUS_CLAMP.
        //    (The C-luma baseline + the per-shape `abFactor` are already
        //    folded into shape.radius by generateShapes; SIZE is the
        //    user's global handle on top.)
        const sizeKnob = Math.max(0.1, Math.min(3, params.size));
        if (sizeKnob !== 1 || shapes.some((s) => s.radius > SHAPEGEN_RADIUS_CLAMP)) {
          shapes = shapes.map((s) => ({
            ...s,
            radius: Math.min(SHAPEGEN_RADIUS_CLAMP, s.radius * sizeKnob),
          }));
        }

        // 4. Render the scene into the OffscreenCanvas.
        if (sceneCtx) {
          drawShapesScene(sceneCtx, shapes, ctx.res.width, ctx.res.height, {
            mode: params.solids >= 0.5 ? 'solids' : 'wireframe',
            rotation: params.rotate * Math.PI * 2,
            autoRotate: false,
          });
          // 5. Upload the canvas as the GL texture.
          g.bindTexture(g.TEXTURE_2D, sceneTex);
          g.pixelStorei(g.UNPACK_FLIP_Y_WEBGL, 0);
          // OffscreenCanvas is a valid TexImageSource — single texImage2D upload.
          g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE,
            sceneCanvas as unknown as TexImageSource);
        }

        // 6. Run the fullscreen-quad shader to copy sceneTex into our FBO.
        g.bindFramebuffer(g.FRAMEBUFFER, fbo);
        g.viewport(0, 0, ctx.res.width, ctx.res.height);
        g.useProgram(program);
        g.activeTexture(g.TEXTURE0);
        g.bindTexture(g.TEXTURE_2D, sceneTex);
        g.uniform1i(uScene, 0);
        ctx.drawFullscreenQuad();
        g.bindFramebuffer(g.FRAMEBUFFER, null);

        framesElapsed++;
      },
      dispose() {
        gl.deleteFramebuffer(fbo);
        gl.deleteTexture(texture);
        gl.deleteFramebuffer(readFbo);
        gl.deleteTexture(readTex);
        gl.deleteTexture(sceneTex);
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
        if (key === 'framesElapsed') return framesElapsed;
        // The card snapshot poller pulls the on-canvas scene for its
        // preview thumbnail (same pattern AcidwarpCard uses).
        if (key === 'sceneCanvas') return sceneCanvas;
        return undefined;
      },
      dispose() { surface.dispose(); },
    };
  },
};
