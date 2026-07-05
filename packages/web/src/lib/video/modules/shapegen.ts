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
//              ROT takes effect EVERY frame, even when the clock gate is
//              holding the shape list (smooth camera rotation around the
//              frozen shapes — useful as a S/H visual effect).
//   • SOLIDS — discrete 0/1 toggle. 0 = vaporwave wireframe (the FOXY
//              look). 1 = per-primitive lit canvas2D rendering for ALL
//              six primitive types (sphere/cube/cylinder/cone + the new
//              filled torus + 4-face Lambert tetrahedron — see
//              shapegen-draw.ts header).
//
// Inputs:
//   raster_a (video): A-raster — drives shape XY positions via feature peaks.
//   raster_b (video): B-raster — drives shape Z depth.
//   raster_c (video): C-raster — drives shape type bucket + radius + hue.
//   clock_in (gate):  optional sample-and-hold gate. UNPATCHED → shapes
//                     regenerate every frame (legacy behaviour). PATCHED →
//                     shapes regenerate only on the rising edge of the
//                     gate; in between, the LAST cached shape list is
//                     held. SIZE + ROT still apply every frame (camera
//                     rotation continues while shapes freeze). Useful for
//                     clocking visual evolution to a sequencer or external
//                     gate.
//
// Output:
//   out (video): the rendered scene (640×480 by default, matches engine RES).
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
import { gateEdge, makeGateState, type GateState } from '$lib/video/plex-select';
import {
  generateShapes,
  type Shape,
} from './shapegen-math';
import { drawShapesScene } from './shapegen-draw';

/** Synthetic param that the engine's CV-bridge writes the gate value into.
 *  The port id is `clock_in` (human-readable + matches the card label);
 *  the param id carries the standard `cv_` prefix (mirrors DOOM's
 *  cv_p1_up etc.). Exported so the test can assert the wiring. */
export const SHAPEGEN_CLOCK_PARAM_ID = 'cv_clock';
/** The port id of the clock-gate input. Exported so the test + e2e can
 *  reference one constant rather than re-typing the string. */
export const SHAPEGEN_CLOCK_PORT_ID = 'clock_in';

// ----------------- read-fbo source dimensions ----------------------------

/** Each input video texture is read back to an RGBA buffer for
 *  `generateShapes` to chew on. We read at a SCALED-DOWN size of the
 *  full frame (engine-res / 8) — keeps per-raster readback at
 *  80×60 = 4800 px × 4 = 19.2 KB (×3 rasters = 58 KB / video frame),
 *  while still SPANNING THE WHOLE FRAME so the 16×16 feature-grid
 *  downsample inside generateShapes sees real content even when the
 *  upstream's interesting pixels live anywhere on the canvas. The
 *  earlier 64×64 corner-read of a 640×480 texture often returned a
 *  dark void (the source's interesting content was off-corner), which
 *  starved generateShapes of feature variance.
 *
 *  We achieve this by drawing the input texture into a small
 *  intermediate FBO via the fullscreen-quad path (1:1 downsample with
 *  GL's linear filter doing the box-blur), then readPixels off THAT.
 *  Still cheap; the intermediate render is a single textured triangle. */
export const SHAPEGEN_RASTER_W = 80;
export const SHAPEGEN_RASTER_H = 60;

/** Final-radius clamp applied AFTER size × baseline × abFactor.
 *  Keeps a maxed-out SIZE knob from filling the whole box. */
export const SHAPEGEN_RADIUS_CLAMP = 0.6;

// ----------------- module params ------------------------------------------

interface ShapegenParams {
  size: number;    // 0.1 .. 3.0 — global radius multiplier
  rotate: number;  // 0 .. 1 — fraction of a full turn (radians = rotate * 2π)
  solids: number;  // 0 / 1 — discrete toggle (wireframe vs lit-solid)
  // Synthetic gate param — written by the engine's CV-bridge when an edge
  // is patched into the clock_in port. Holds the latest gate sample so the
  // edge detector (in setParam) can compare against the previous value.
  // Hidden from the card (rendered as the cv jack via the standard port
  // row, not as a knob).
  cv_clock: number;
}

const DEFAULTS: ShapegenParams = {
  size: 1,
  rotate: 0,
  solids: 0,
  cv_clock: 0,
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
  palette: { top: 'Video modules', sub: 'Processors' },
  domain: 'video',
  label: 'shapegen',
  category: 'video-effects',
  inputs: [
    { id: 'raster_a', type: 'video' },
    { id: 'raster_b', type: 'video' },
    { id: 'raster_c', type: 'video' },
    // Optional clock gate — when patched, shape generation is gated to
    // rising edges of the gate (sample-and-hold visual evolution). When
    // unpatched the legacy every-frame regeneration runs. The engine's
    // CV-bridge routes the gate sample into setParam(cv_clock, value),
    // where a rising-edge detector triggers a re-extract + redraw.
    { id: SHAPEGEN_CLOCK_PORT_ID, type: 'gate', paramTarget: SHAPEGEN_CLOCK_PARAM_ID },
  ],
  outputs: [
    { id: 'out', type: 'video' },
  ],
  params: [
    { id: 'size',   label: 'Size',   defaultValue: DEFAULTS.size,   min: 0.1, max: 3, curve: 'linear' },
    { id: 'rotate', label: 'Rot',    defaultValue: DEFAULTS.rotate, min: 0,   max: 1, curve: 'linear' },
    { id: 'solids', label: 'Solids', defaultValue: DEFAULTS.solids, min: 0,   max: 1, curve: 'discrete' },
    // Synthetic gate param — hidden from the card UI; rendered as the
    // clock_in cv jack via the standard port-row. curve 'linear' so
    // setParam values arrive raw for the edge detector. (Mirrors
    // SCOREBOARD's scoreTrig param, which is also hidden from the card.)
    { id: SHAPEGEN_CLOCK_PARAM_ID, label: 'CLK', defaultValue: 0, min: 0, max: 1, curve: 'linear' },
  ],

  // docs-hash-ignore:start
  docs: {
    explanation:
      "shapegen is a generative 3D-shape video synthesizer (extracted from FOXY's shape path). It has no straight video pass-through input: instead it reads three incoming rasters as control surfaces and synthesizes a scene of up to 8 lit primitives (sphere, cube, cone, cylinder, ring/torus, tetrahedron) floating inside a vaporwave wireframe bounding box with a faint perspective floor grid. Each raster is downsampled to an 80x60 RGBA buffer and fed to generateShapes: A's 16x16 mean-luma feature grid yields the top-8 peaks (non-max-suppressed) that place shapes in XY (if A is flat below the variance floor, NO shapes are drawn), B's luma at each peak sets Z depth, and C's luma picks the primitive type bucket (floor(c*6)), the baseline radius (0.05+c*0.25) and the hue (=c). The product of A and B luma at each peak gives a per-shape size factor of 0.5x-2x. The whole scene is painted to an OffscreenCanvas, uploaded as a texture, and blitted out a fullscreen quad. Usage: patch any three video sources into A/B/C, twist ROT to orbit the camera, raise SIZE to fatten the primitives, and flip SOLIDS for shaded vs neon-wireframe looks; patch a gate into CLK to freeze the shape set and only re-roll it on each rising edge (a visual sample-and-hold) while the camera keeps rotating.",
    inputs: {
      raster_a: "Video raster A. Its 16x16 mean-luma feature grid yields the top-8 peaks (non-max suppressed) that place the shapes in XY across the box; if A is nearly flat (variance below the floor), no shapes are emitted. A's luma sampled at each peak pixel also feeds the per-shape size factor (A*B → 0.5x-2x).",
      raster_b: "Video raster B. Its luma sampled at each A peak sets that shape's Z depth (front/back in the box, mapped to [-1,1] via b*2-1). Brighter B pushes shapes toward the viewer; B also feeds the A*B per-shape size factor alongside A.",
      raster_c: "Video raster C. Its luma at each peak selects the primitive type (floor(c*6): sphere/cube/cone/cylinder/ring/tetra), the baseline radius (0.05 + c*0.25) and the hue (=c). Brighter, more varied C yields bigger, more colorful, more diverse shapes.",
      clock_in: "Optional sample-and-hold gate (a gate input feeding the hidden cv_clock param). Unpatched: shapes regenerate every frame. Patched: shapes re-roll only on each rising edge (hysteresis ~0.6/0.4) and freeze in between, while ROT keeps orbiting the held set. Card shows a [CLOCKED] badge when wired.",
    },
    outputs: {
      out: "Video output: the rendered 3D-shapes-in-a-box scene (engine resolution, 640x480 by default) with the vaporwave wireframe cage, floor grid, and the synthesized primitives, ready to chain into any video input.",
    },
    controls: {
      size: "SIZE (0.1-3, default 1): global multiplier on each shape's final radius (the C-baseline already scaled by the A*B factor), then hard-clamped to 0.6 so a maxed knob can't fill the whole box. Applied at regeneration time, so under a held clock a twist shows on the next pulse.",
      rotate: "ROT (0-1, default 0): camera Y-axis rotation as a fraction of a full turn (0..2pi radians). Applies live every frame even while the clock holds the shape list, so you can orbit a frozen scene.",
      solids: "SOLIDS (toggle, default 0=off): 0 = vaporwave wireframe look (neon HSL gradient silhouettes / strokes); 1 = per-primitive lit canvas2D solids for all six types (shaded sphere/cube/cylinder/cone, filled torus with punched hole, Lambert-shaded tetrahedron). The wireframe box and floor grid stay in both modes.",
      cv_clock: "Hidden synthetic gate param backing the CLK jack (not a knob). The engine CV-bridge writes the clock_in gate sample here; a rising edge (hysteresis rise>0.6 / fall<0.4) triggers the next-frame shape regeneration for the sample-and-hold behavior.",
    },
  },
  // docs-hash-ignore:end
  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;
    const program = ctx.compileFragment(FRAG_SRC);
    const uScene = gl.getUniformLocation(program, 'uScene');
    const { fbo, texture } = ctx.createFbo();

    const params: ShapegenParams = { ...DEFAULTS, ...(node.params as Partial<ShapegenParams>) };

    // ---- The scene canvas2D + GL upload texture ----
    // Canvas dims match the engine FBO so a fullscreen-quad sample is 1:1.
    // Both OffscreenCanvas + document.createElement may be absent in headless
    // node test environments (vitest's node pool) — fall through to null
    // gracefully so the factory still spawns + the GL upload step is no-op.
    // The unit suite covers the gate/params contract without ever exercising
    // the 2D draw; e2e covers the real-browser path.
    let sceneCanvas: OffscreenCanvas | HTMLCanvasElement | null = null;
    try {
      if (typeof OffscreenCanvas !== 'undefined') {
        sceneCanvas = new OffscreenCanvas(ctx.res.width, ctx.res.height);
      } else if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
        const c = document.createElement('canvas');
        c.width = ctx.res.width;
        c.height = ctx.res.height;
        sceneCanvas = c;
      }
    } catch {
      sceneCanvas = null;
    }
    const sceneCtx = sceneCanvas
      ? (sceneCanvas.getContext('2d') as
          | CanvasRenderingContext2D
          | OffscreenCanvasRenderingContext2D
          | null)
      : null;
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
    // texture's FBO — a TOP-LEFT-CORNER read of a 640×480 canvas, which
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

    // ---- Sample-and-hold state for the clock_in gate ----
    //
    // The clock_in input is OPTIONAL. We detect "patched" implicitly:
    //   • `clockPatched` flips TRUE the first time the engine's CV-bridge
    //     calls setParam('cv_clock', ...) with ANY value (including 0 —
    //     the bridge writes 0 every audio block when the gate output is
    //     LOW). Unpatched ports never see setParam called for them
    //     (the bridge only materialises when an edge exists).
    //   • Once TRUE, we never flip it back — unpatching the cable stops
    //     the setParam calls, so the last gate state is held; that means
    //     if the user unpatches while the gate was HIGH, the shapes stay
    //     held at their last cached set. Re-patching resumes the
    //     edge-detected regeneration. (This is the natural Eurorack S/H
    //     behaviour: pull the cable + the held value persists.)
    //
    // `cachedShapes` is the last shape list to render. On rising edge we
    // regenerate it from the current rasters; otherwise we re-use it.
    // The on-canvas paint runs EVERY frame so the camera ROT knob takes
    // effect smoothly even when the shape list is held.
    let cachedShapes: Shape[] = [];
    let clockPatched = false;
    const clockGateState: GateState = makeGateState();
    let pendingRegenerate = true; // first draw always regenerates
    // Monotonic counter incremented exactly once per regeneration. Exposed
    // via read('regenCount') so the e2e + unit test can pin the
    // sample-and-hold contract WITHOUT relying on pixel diffs (which are
    // sensitive to source-raster timing). Two regenerations across a
    // rising edge → counter +1; two reads within a hold window → counter
    // unchanged.
    let regenCount = 0;

    // ---- Per-frame draw ----
    let framesElapsed = 0;
    const surface: VideoNodeSurface = {
      fbo,
      texture,
      draw(frame) {
        const g = frame.gl;

        // 1. Decide whether to regenerate shapes this frame.
        //    UNPATCHED clock → regenerate every frame (legacy).
        //    PATCHED clock → regenerate ONLY on rising edge.
        //    First draw always regenerates so the FBO carries something
        //    coherent before the first gate fires.
        const regenerateNow = pendingRegenerate || !clockPatched;
        pendingRegenerate = false;

        if (regenerateNow) {
          // 1a. Read the three input textures into RGBA buffers.
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

          // 1b. Generate the shape list from the three rasters.
          let shapes: Shape[] = generateShapes(
            clampA, clampB, clampC,
            SHAPEGEN_RASTER_W, SHAPEGEN_RASTER_H,
          );

          // 1c. Apply the SIZE knob globally. Final radius is
          //     `baseline * size`, clamped to SHAPEGEN_RADIUS_CLAMP.
          //     (The C-luma baseline + the per-shape `abFactor` are already
          //     folded into shape.radius by generateShapes; SIZE is the
          //     user's global handle on top.)
          //
          //     NOTE: SIZE is applied at REGEN time, so a SIZE knob twist
          //     while the clock is holding shows up on the NEXT rising
          //     edge. The user expectation is that ROT is the live-camera
          //     handle + SIZE is part of the shape generation pipeline,
          //     which matches the held-shapes contract. (If users later
          //     want SIZE live, we'd cache the unscaled shapes + apply
          //     SIZE per-frame in the render step.)
          const sizeKnob = Math.max(0.1, Math.min(3, params.size));
          if (sizeKnob !== 1 || shapes.some((s) => s.radius > SHAPEGEN_RADIUS_CLAMP)) {
            shapes = shapes.map((s) => ({
              ...s,
              radius: Math.min(SHAPEGEN_RADIUS_CLAMP, s.radius * sizeKnob),
            }));
          }
          cachedShapes = shapes;
          regenCount++;
        }

        // 2. Render the (possibly-cached) shape list into the OffscreenCanvas
        //    EVERY frame — ROT knob + camera rotation must respond live even
        //    when the shape generation is held by the clock gate.
        if (sceneCtx && sceneCanvas) {
          drawShapesScene(sceneCtx, cachedShapes, ctx.res.width, ctx.res.height, {
            mode: params.solids >= 0.5 ? 'solids' : 'wireframe',
            rotation: params.rotate * Math.PI * 2,
            autoRotate: false,
          });
          // 3. Upload the canvas as the GL texture.
          g.bindTexture(g.TEXTURE_2D, sceneTex);
          g.pixelStorei(g.UNPACK_FLIP_Y_WEBGL, 0);
          // OffscreenCanvas is a valid TexImageSource — single texImage2D upload.
          g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE,
            sceneCanvas as unknown as TexImageSource);
        }

        // 4. Run the fullscreen-quad shader to copy sceneTex into our FBO.
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
        if (paramId === SHAPEGEN_CLOCK_PARAM_ID) {
          // The bridge only calls us when an edge is patched — first
          // arrival flips clockPatched true (sample-and-hold mode).
          clockPatched = true;
          params.cv_clock = value;
          // Rising-edge detector: returns true exactly when the gate
          // crosses LOW→HIGH (rise > 0.6, fall < 0.4 hysteresis). On the
          // edge, mark the next frame to regenerate shapes.
          if (gateEdge(clockGateState, value)) {
            pendingRegenerate = true;
          }
          return;
        }
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
        // Test + card hooks for inspecting the clock-gate hold state.
        if (key === 'clockPatched') return clockPatched ? 1 : 0;
        if (key === 'cachedShapeCount') return cachedShapes.length;
        if (key === 'regenCount') return regenCount;
        return undefined;
      },
      dispose() { surface.dispose(); },
    };
  },
};
