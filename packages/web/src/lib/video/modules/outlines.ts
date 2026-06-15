// packages/web/src/lib/video/modules/outlines.ts
//
// OUTLINES — stateful particle video generator (LZX-style primitive source).
//
// (Was CIRCLES — renamed when the SHAPE selector landed: a spawned shape can
// now be a CIRCLE or a regular N-gon — triangle / square / pentagon / hexagon /
// octagon — inscribed in the diameter, plus a live-global ROTATION that spins
// every shape coherently.)
//
// A gate event (or the internal rate clock) spawns a shape at a seeded-
// random position; shapes move in a latched direction at a latched speed
// and BOUNCE when their CENTER hits a wall, accumulating into a 1024-px
// field. Four outputs derive from a per-pixel overlap-COUNT of the active
// shapes:
//
//   overlap (mono-video): white where ≥1 shape covers the pixel.
//   contour (mono-video): shape OUTLINES only (ring lw = 10% of d, min 2 px)
//                         → "ripples in a pond" as many shapes stack.
//   combine (video):      the overlap region colorized by overlap COUNT via a
//                         hue ramp (1 = first hue; 2,3,4… cycle the spectrum)
//                         with brightness + saturation rising with stack depth.
//   mapped  (video):      the `video` INPUT's contents wherever ≥2 shapes
//                         overlap, black elsewhere.
//
// Inputs:
//   gate    (gate):  a rising edge spawns one shape.
//   collide (gate):  LIVE GLOBAL mode (NOT spawn-latched). While HIGH, shapes
//                    bounce off EACH OTHER (elastic, bounding-circle detection —
//                    circumcircles touch when center distance ≤ r1+r2);
//                    LOW/unpatched = pass-through (the original behaviour).
//   d / v / spd / decay / shape / rotation (cv, paramTarget=…): per-param CV
//                 (diameter / vector / speed / fade-out time / shape selector /
//                 bipolar spin).
//   video (video): sampled by the `mapped` output.
//
// Params (knobs):
//   d   (0..1 → 5..270 px)       shape DIAMETER (circumdiameter), latched per
//                                shape at spawn.
//   v   (0..1 → 0..360°)         spawn VECTOR ANGLE, latched per shape.
//   spd (0..1 → 0..300 px/s)     SPEED, latched per shape (0 = static). The
//                                LATCHED velocity drives integration, so a
//                                later spd change affects ONLY new shapes.
//   decay (0..1 → 0..10 s)       FADE-OUT time, latched per shape. 0 = persist
//                                (FIFO-culled); >0 fades alpha→0 + removes the
//                                shape over that many seconds.
//   shape (0..1 → 6 shapes)      SHAPE SELECTOR (circle / triangle / square /
//                                pentagon / hexagon / octagon), quantised +
//                                latched per shape at spawn. A polygon is
//                                inscribed in the diameter (circumradius = d/2),
//                                so COLLIDE's bounding-circle test is unchanged.
//   rotation (0..1 bipolar)      LIVE GLOBAL spin: center (0.5) = no rotation,
//                                left = fast CCW, right = fast CW. Every live
//                                shape shares one rotation angle (NOT latched),
//                                reflected in the geometry AND every output.
//   rate (0..1, KNOB ONLY)       internal spawn clock. 0 = gate-only; turning
//                                up engages a clock capped at 1 shape/500 ms.
//
// All the numeric behavior (seeded spawn, integration, center-bounce, latch,
// SHAPE geometry, ROTATION accumulation, the rate-clock cadence, the
// max-shape cull, and the per-output derivation) is in outlines-sim.ts —
// WebGL-free + unit-tested. This file owns ONLY the GL plumbing: a 2D scene
// canvas painted per frame (overlap / contour / combine + a mask) uploaded
// into per-output textures, plus a small shader that multiplies the `video`
// input by the mask for `mapped`.
//
// Determinism (VRT / per-port / behavioral): the spawn RNG is seeded. When
// `globalThis.__outlinesVrtSeed` is set BEFORE the module mounts, the sim is
// constructed with that fixed seed (so the painted frame is reproducible);
// otherwise a fixed default seed is used (still deterministic — never
// Math.random()).

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';
import { gateEdge, makeGateState, type GateState } from '$lib/video/plex-select';
import {
  OutlinesSim,
  OUTLINES_FIELD,
  MAX_CIRCLES,
  ROT_CENTER,
  ringWidth,
  shapeVertices,
  makeOutlinesField,
  deriveOutlinesField,
  combineRgbFromField,
  type OutlinesField,
  type Circle,
} from './outlines-sim';

/** The synthetic param the engine's CV-bridge writes the gate value into
 *  (mirrors SHAPEGEN's cv_clock). The port id is the human-readable `gate`;
 *  the param id carries the `cv_` prefix. */
export const OUTLINES_GATE_PARAM_ID = 'cv_gate';
/** The gate input port id. */
export const OUTLINES_GATE_PORT_ID = 'gate';

/** The synthetic param the CV-bridge writes the COLLIDE gate LEVEL into. Unlike
 *  the spawn gate (rising-edge → spawn), this is read as a LIVE LEVEL each frame:
 *  HIGH → inter-shape elastic collision ON, LOW → pass-through. */
export const OUTLINES_COLLIDE_PARAM_ID = 'cv_collide';
/** The collide gate input port id. */
export const OUTLINES_COLLIDE_PORT_ID = 'collide';

/** A gate LEVEL ≥ this counts as HIGH (matches the rising-edge detector's
 *  high threshold; the engine writes 0/1 but CV can arrive analog). */
export const COLLIDE_GATE_HIGH = 0.5;

// ── Back-compat aliases for the pre-rename constant names (was CIRCLES_*).
// New code uses the OUTLINES_* names above; these keep any straggling importer
// resolving (there are no production saved patches referencing them).
export const CIRCLES_GATE_PARAM_ID = OUTLINES_GATE_PARAM_ID;
export const CIRCLES_GATE_PORT_ID = OUTLINES_GATE_PORT_ID;
export const CIRCLES_COLLIDE_PARAM_ID = OUTLINES_COLLIDE_PARAM_ID;
export const CIRCLES_COLLIDE_PORT_ID = OUTLINES_COLLIDE_PORT_ID;

interface OutlinesParams {
  d: number;
  v: number;
  spd: number;
  decay: number;
  shape: number;
  rotation: number;
  rate: number;
  // Synthetic gate param — written by the CV-bridge; hidden from the card.
  cv_gate: number;
  // Synthetic COLLIDE gate LEVEL — written by the CV-bridge; hidden from the
  // card. Read live each frame as the inter-shape collision on/off switch.
  cv_collide: number;
}

const DEFAULTS: OutlinesParams = {
  d: 0.3,    // ~85 px shapes by default (0.3 × the new 5..270 range)
  v: 0.125,  // 45° drift
  spd: 0.4,  // ~120 px/s — visibly moving
  decay: 0,  // 0 = persist (preserve the static-field default; FIFO-capped)
  shape: 0,  // circle by default (the legacy look)
  rotation: ROT_CENTER, // center = no spin by default
  rate: 0.5, // internal clock on by default so the source is alive on spawn
  cv_gate: 0,
  cv_collide: 0, // collide OFF by default (pass-through) until the gate goes HIGH
};

// Fullscreen-quad shader: sample the scene texture (top-left-origin canvas →
// flip Y to GL bottom-left). Used to copy each output's 2D scene canvas into
// its FBO.
const COPY_FRAG_SRC = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uScene;
void main() {
  vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
  outColor = texture(uScene, uv);
}`;

// `mapped` shader: multiply the video INPUT texture by the mask texture
// (white where ≥2 shapes overlap). Both sampled in GL UV space; the mask is
// uploaded from a top-left-origin 2D canvas so it's flipped to match.
const MAPPED_FRAG_SRC = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uVideo;   // the video input
uniform sampler2D uMask;    // white where >=2 overlap
uniform float uHasVideo;    // 1 when the video input is patched, else 0
void main() {
  float mask = texture(uMask, vec2(vUv.x, 1.0 - vUv.y)).r;
  vec3 vid = texture(uVideo, vUv).rgb * uHasVideo;
  outColor = vec4(vid * mask, 1.0);
}`;

export const outlinesDef: VideoModuleDef = {
  type: 'outlines',
  palette: { top: 'Video modules', sub: 'Sources' },
  domain: 'video',
  label: 'outlines',
  category: 'sources',
  schemaVersion: 1,
  inputs: [
    // A gate event spawns a new shape. The CV-bridge routes the gate sample
    // into setParam(cv_gate, value); a rising-edge detector spawns one shape.
    { id: OUTLINES_GATE_PORT_ID, type: 'gate', paramTarget: OUTLINES_GATE_PARAM_ID },
    // LIVE inter-shape COLLIDE mode. The CV-bridge routes this gate's LEVEL
    // into setParam(cv_collide, value); the sim reads it each frame (HIGH →
    // shapes bounce off each other elastically, LOW → pass through).
    { id: OUTLINES_COLLIDE_PORT_ID, type: 'gate', paramTarget: OUTLINES_COLLIDE_PARAM_ID },
    // Per-param CV — port id MUST equal the param id (the cross-domain CV
    // bridge routes onto setParam(portId)). `rate` is knob-only (no port).
    // These are CONTINUOUS knob modulators, so each MUST carry a `cvScale`
    // hint: the cv→video bridge (cv-bridge-map.ts) only sweeps a ±1 source
    // across the param's full range CENTERED on the knob when `cvScale` is
    // present. Without it the bridge falls back to GATE semantics (raw
    // passthrough), which clobbers the knob + sends bipolar CV out of the
    // 0..1 range — i.e. the CV input "does nothing useful" (the reported bug).
    { id: 'd',        type: 'cv', paramTarget: 'd',        cvScale: { mode: 'linear' } },
    { id: 'v',        type: 'cv', paramTarget: 'v',        cvScale: { mode: 'linear' } },
    { id: 'spd',      type: 'cv', paramTarget: 'spd',      cvScale: { mode: 'linear' } },
    { id: 'decay',    type: 'cv', paramTarget: 'decay',    cvScale: { mode: 'linear' } },
    // SHAPE selector CV — latched per shape at spawn (like d/v/spd/decay).
    { id: 'shape',    type: 'cv', paramTarget: 'shape',    cvScale: { mode: 'linear' } },
    // ROTATION CV — a LIVE GLOBAL bipolar angular velocity (NOT latched).
    { id: 'rotation', type: 'cv', paramTarget: 'rotation', cvScale: { mode: 'linear' } },
    // The video source for the `mapped` output.
    { id: 'video', type: 'video' },
  ],
  outputs: [
    { id: 'overlap', type: 'mono-video' },
    { id: 'contour', type: 'mono-video' },
    { id: 'combine', type: 'video' },
    { id: 'mapped',  type: 'video' },
  ],
  params: [
    { id: 'd',        label: 'D',     defaultValue: DEFAULTS.d,        min: 0, max: 1, curve: 'linear' },
    { id: 'v',        label: 'V',     defaultValue: DEFAULTS.v,        min: 0, max: 1, curve: 'linear' },
    { id: 'spd',      label: 'Spd',   defaultValue: DEFAULTS.spd,      min: 0, max: 1, curve: 'linear' },
    { id: 'decay',    label: 'Decay', defaultValue: DEFAULTS.decay,    min: 0, max: 1, curve: 'linear' },
    // SHAPE selector knob — 0..1 quantised to 6 discrete shapes at spawn.
    { id: 'shape',    label: 'Shape', defaultValue: DEFAULTS.shape,    min: 0, max: 1, curve: 'linear' },
    // ROTATION knob — BIPOLAR around 0.5 (center = no spin, ± = CW/CCW). Live.
    { id: 'rotation', label: 'Rot',   defaultValue: DEFAULTS.rotation, min: 0, max: 1, curve: 'linear' },
    { id: 'rate',     label: 'Rate',  defaultValue: DEFAULTS.rate,     min: 0, max: 1, curve: 'linear' },
    // Synthetic gate param — hidden from the card; rendered as the gate jack.
    { id: OUTLINES_GATE_PARAM_ID, label: 'GATE', defaultValue: 0, min: 0, max: 1, curve: 'linear' },
    // Synthetic COLLIDE gate param — hidden from the card; rendered as the
    // collide jack. Read live as the inter-shape collision on/off level.
    { id: OUTLINES_COLLIDE_PARAM_ID, label: 'COLLIDE', defaultValue: 0, min: 0, max: 1, curve: 'linear' },
  ],

  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;
    const copyProgram = ctx.compileFragment(COPY_FRAG_SRC);
    const uScene = gl.getUniformLocation(copyProgram, 'uScene');
    const mappedProgram = ctx.compileFragment(MAPPED_FRAG_SRC);
    const uVideo = gl.getUniformLocation(mappedProgram, 'uVideo');
    const uMask = gl.getUniformLocation(mappedProgram, 'uMask');
    const uHasVideo = gl.getUniformLocation(mappedProgram, 'uHasVideo');

    // One FBO+texture per declared output.
    const fboOverlap = ctx.createFbo();
    const fboContour = ctx.createFbo();
    const fboCombine = ctx.createFbo();
    const fboMapped = ctx.createFbo();

    const params: OutlinesParams = { ...DEFAULTS, ...(node.params as Partial<OutlinesParams>) };

    // ---- Seeded sim ----
    const vrtSeed = (globalThis as unknown as { __outlinesVrtSeed?: number }).__outlinesVrtSeed;
    const sim = new OutlinesSim(typeof vrtSeed === 'number' ? vrtSeed >>> 0 : undefined);
    const gateState: GateState = makeGateState();

    // ---- 2D scene canvases (one for the colour combine + per-mono outputs +
    // the mask). We keep FOUR small 2D canvases (overlap / contour / combine /
    // mask) at field resolution. Both OffscreenCanvas + document may be absent
    // in headless node tests — fall through to null; draw() then no-ops the GL
    // upload (the unit suite covers the sim/derivation directly, never the
    // canvas paint).
    function makeCanvas(): { canvas: OffscreenCanvas | HTMLCanvasElement | null; ctx2d: (CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D) | null } {
      let canvas: OffscreenCanvas | HTMLCanvasElement | null = null;
      try {
        if (typeof OffscreenCanvas !== 'undefined') {
          canvas = new OffscreenCanvas(OUTLINES_FIELD, OUTLINES_FIELD);
        } else if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
          const c = document.createElement('canvas');
          c.width = OUTLINES_FIELD;
          c.height = OUTLINES_FIELD;
          canvas = c;
        }
      } catch {
        canvas = null;
      }
      const ctx2d = canvas
        ? (canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null)
        : null;
      return { canvas, ctx2d };
    }

    const overlapScene = makeCanvas();
    const contourScene = makeCanvas();
    const combineScene = makeCanvas();
    const maskScene = makeCanvas();

    // Reusable upload texture: re-bound + re-filled per output per frame.
    function makeUploadTex(): WebGLTexture {
      const t = gl.createTexture();
      if (!t) throw new Error('OUTLINES: createTexture failed');
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
      return t;
    }
    const texOverlap = makeUploadTex();
    const texContour = makeUploadTex();
    const texCombine = makeUploadTex();
    const texMask = makeUploadTex();

    // Trace one shape's PATH on a 2D context: a circle → arc; a polygon → the
    // rotated vertex polyline (closed). `rot` is the live-global rotation angle
    // (added to each shape's seeded baseAngle), so the painted geometry spins
    // exactly like the derivation math reads it. For the polygon contour we
    // shrink the path by `inset` (so a stroke band sits inside the edge, like
    // the disc contour does).
    function traceShapePath(
      c2d: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
      ci: Circle,
      rot: number,
      inset: number,
    ): void {
      const verts = shapeVertices(ci, rot);
      if (verts.length === 0) {
        // Circle.
        c2d.arc(ci.x, ci.y, Math.max(0, ci.diameter * 0.5 - inset), 0, Math.PI * 2);
        return;
      }
      if (inset === 0) {
        c2d.moveTo(verts[0]![0], verts[0]![1]);
        for (let i = 1; i < verts.length; i++) c2d.lineTo(verts[i]![0], verts[i]![1]);
        c2d.closePath();
        return;
      }
      // Inset the polygon by pulling each vertex toward the center by `inset`
      // along its radius (approximate — for a thin stroke band this is fine).
      const r = ci.diameter * 0.5;
      const shrink = r > 0 ? Math.max(0, r - inset) / r : 0;
      const v0x = ci.x + (verts[0]![0] - ci.x) * shrink;
      const v0y = ci.y + (verts[0]![1] - ci.y) * shrink;
      c2d.moveTo(v0x, v0y);
      for (let i = 1; i < verts.length; i++) {
        c2d.lineTo(ci.x + (verts[i]![0] - ci.x) * shrink, ci.y + (verts[i]![1] - ci.y) * shrink);
      }
      c2d.closePath();
    }

    // ---- 2D paint of one frame's shapes into the four scene canvases. ----
    function paintScenes(circles: readonly Circle[], rot: number): void {
      // overlap — white shapes on black (count≥1), each dimmed by its fade alpha.
      if (overlapScene.ctx2d) {
        const c = overlapScene.ctx2d;
        c.globalAlpha = 1;
        c.fillStyle = '#000';
        c.fillRect(0, 0, OUTLINES_FIELD, OUTLINES_FIELD);
        c.fillStyle = '#fff';
        for (const ci of circles) {
          c.globalAlpha = ci.alpha ?? 1;
          c.beginPath();
          traceShapePath(c, ci, rot, 0);
          c.fill();
        }
        c.globalAlpha = 1;
      }
      // contour — white outlines (lw = 10% of d, min 2px) on black, dimmed by
      // fade. The stroke is inset by lw/2 so the band sits inside the shape (the
      // sim's ring test is the [edge − lw, edge] band).
      if (contourScene.ctx2d) {
        const c = contourScene.ctx2d;
        c.globalAlpha = 1;
        c.fillStyle = '#000';
        c.fillRect(0, 0, OUTLINES_FIELD, OUTLINES_FIELD);
        c.strokeStyle = '#fff';
        c.lineJoin = 'round';
        for (const ci of circles) {
          c.globalAlpha = ci.alpha ?? 1;
          const lw = ringWidth(ci.diameter);
          c.lineWidth = lw;
          c.beginPath();
          traceShapePath(c, ci, rot, lw * 0.5);
          c.stroke();
        }
        c.globalAlpha = 1;
      }
      // mask — white where ≥2 shapes overlap. We additively accumulate shape
      // coverage (each shape adds a small constant), then any pixel touched by
      // ≥2 shapes reads ≥ the 2-shape threshold. Using 'lighter' compositing
      // sums alpha so overlaps brighten; 1 shape ≈ 0.42 (<0.5), 2 shapes ≈ 0.84
      // (>0.5) → the shader's mask>0.5 test = "≥2 overlaps". (The unit suite
      // pins the exact ≥2 rule on the sim; this canvas path is the GL
      // approximation the shader reads.)
      if (maskScene.ctx2d) {
        const c = maskScene.ctx2d;
        c.globalCompositeOperation = 'source-over';
        c.fillStyle = '#000';
        c.fillRect(0, 0, OUTLINES_FIELD, OUTLINES_FIELD);
        c.globalCompositeOperation = 'lighter';
        for (const ci of circles) {
          // Each shape adds ~0.42 × its fade alpha → a fully-faded shape stops
          // contributing to the ≥2-overlap (>0.5) mask threshold.
          c.fillStyle = `rgba(255,255,255,${0.42 * (ci.alpha ?? 1)})`;
          c.beginPath();
          traceShapePath(c, ci, rot, 0);
          c.fill();
        }
        c.globalCompositeOperation = 'source-over';
      }
      // combine — overlap region colorized by COUNT via the hue ramp. We can't
      // cheaply do per-pixel count in canvas2D for the exact ramp, so we paint a
      // coarse count grid: sample the count at a downsampled grid + fill cells.
      // The downsample keeps it cheap (a 160×160 grid). The COVERAGE for that
      // grid is derived ONCE per frame (deriveOutlinesField: AABB iteration +
      // circumradius pre-reject + cached polygon normals → ZERO per-cell trig),
      // then each non-empty cell is coloured exactly as combineRgbAt did at the
      // cell center (same live `rot`, so the coloured stack spins with the
      // geometry). This is the #699 per-pixel-trig hot-path fix: byte-identical
      // colour, far fewer ops.
      if (combineScene.ctx2d) {
        const c = combineScene.ctx2d;
        c.fillStyle = '#000';
        c.fillRect(0, 0, OUTLINES_FIELD, OUTLINES_FIELD);
        if (circles.length > 0) {
          const GRID = 160;
          const cell = OUTLINES_FIELD / GRID;
          combineField = makeOutlinesField(GRID, combineField);
          deriveOutlinesField(circles, combineField, rot);
          const cnt = combineField.count;
          for (let gy = 0; gy < GRID; gy++) {
            const rowBase = gy * GRID;
            for (let gx = 0; gx < GRID; gx++) {
              const idx = rowBase + gx;
              if (cnt[idx] === 0) continue; // black cell → leave the cleared bg
              const [r, g, b] = combineRgbFromField(combineField, idx, combineRgbScratch);
              c.fillStyle = `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
              c.fillRect(gx * cell, gy * cell, Math.ceil(cell), Math.ceil(cell));
            }
          }
        }
      }
    }

    function uploadCanvas(tex: WebGLTexture, canvas: OffscreenCanvas | HTMLCanvasElement | null): void {
      if (!canvas) return;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas as unknown as TexImageSource);
    }

    function blitToFbo(fbo: WebGLFramebuffer | null, tex: WebGLTexture): void {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.viewport(0, 0, ctx.res.width, ctx.res.height);
      gl.useProgram(copyProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(uScene, 0);
      ctx.drawFullscreenQuad();
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    let lastTime = -1;
    let framesElapsed = 0;

    // Reused across frames so the combine derive-once path allocates nothing
    // per frame (the coverage buffers + a single RGB scratch triple).
    let combineField: OutlinesField | undefined;
    const combineRgbScratch: [number, number, number] = [0, 0, 0];

    // Snapshot the CURRENT live knob+CV params into the shape the sim latches at
    // spawn. Used both by draw() (every frame) AND by the gate handler (so a
    // gate-spawned shape latches the LIVE spd/v/d/decay/SHAPE at the moment of
    // the edge — not whatever stale params the last draw() happened to push, or
    // the sim's constructor defaults before the first draw ever ran). ROTATION is
    // included too (a LIVE GLOBAL the sim advances each step).
    function liveSpawnParams() {
      return {
        d: params.d,
        v: params.v,
        spd: params.spd,
        decay: params.decay,
        shape: params.shape,
        rotation: params.rotation,
        rate: params.rate,
        collide: params.cv_collide >= COLLIDE_GATE_HIGH,
      };
    }

    const surface: VideoNodeSurface = {
      // Surface.texture is the `combine` output (the default single-output
      // convention + the card preview). Per-output textures are resolved by
      // the engine via read('outputTexture:<portId>').
      fbo: fboCombine.fbo,
      texture: fboCombine.texture,
      draw(frame) {
        const g = frame.gl;

        // dt from the engine clock (seconds → ms). First frame: assume 1/60.
        const t = frame.time;
        const dtMs = lastTime < 0 ? 1000 / 60 : Math.max(0, (t - lastTime) * 1000);
        lastTime = t;

        // Push live params into the sim. d/v/spd/decay/shape latch per-shape at
        // spawn; `collide` + `rotation` are LIVE GLOBALS (collide = gate LEVEL ≥
        // HIGH → on; rotation = a bipolar spin advanced each step).
        sim.setParams(liveSpawnParams());
        // Advance the sim (rate-clock spawns + rotation + integration + bounce).
        sim.step(dtMs);

        const circles = sim.circles;
        const rot = sim.rotationAngle;

        // Paint + upload the four scene canvases (with the live rotation).
        paintScenes(circles, rot);
        uploadCanvas(texOverlap, overlapScene.canvas);
        uploadCanvas(texContour, contourScene.canvas);
        uploadCanvas(texCombine, combineScene.canvas);
        uploadCanvas(texMask, maskScene.canvas);

        // overlap / contour / combine: straight copy of their scene texture.
        blitToFbo(fboOverlap.fbo, texOverlap);
        blitToFbo(fboContour.fbo, texContour);
        blitToFbo(fboCombine.fbo, texCombine);

        // mapped: multiply the video INPUT by the mask. If unpatched, black.
        const videoTex = frame.getInputTexture(node.id, 'video');
        g.bindFramebuffer(g.FRAMEBUFFER, fboMapped.fbo);
        g.viewport(0, 0, ctx.res.width, ctx.res.height);
        g.useProgram(mappedProgram);
        g.activeTexture(g.TEXTURE0);
        g.bindTexture(g.TEXTURE_2D, videoTex ?? texMask);
        g.uniform1i(uVideo, 0);
        g.activeTexture(g.TEXTURE1);
        g.bindTexture(g.TEXTURE_2D, texMask);
        g.uniform1i(uMask, 1);
        g.uniform1f(uHasVideo, videoTex ? 1 : 0);
        ctx.drawFullscreenQuad();
        g.bindFramebuffer(g.FRAMEBUFFER, null);
        g.activeTexture(g.TEXTURE0);

        framesElapsed++;
      },
      dispose() {
        gl.deleteFramebuffer(fboOverlap.fbo); gl.deleteTexture(fboOverlap.texture);
        gl.deleteFramebuffer(fboContour.fbo); gl.deleteTexture(fboContour.texture);
        gl.deleteFramebuffer(fboCombine.fbo); gl.deleteTexture(fboCombine.texture);
        gl.deleteFramebuffer(fboMapped.fbo); gl.deleteTexture(fboMapped.texture);
        gl.deleteTexture(texOverlap); gl.deleteTexture(texContour);
        gl.deleteTexture(texCombine); gl.deleteTexture(texMask);
        gl.deleteProgram(copyProgram); gl.deleteProgram(mappedProgram);
      },
    };

    return {
      domain: 'video',
      surface,
      setParam(paramId, value) {
        if (paramId === OUTLINES_GATE_PARAM_ID) {
          params.cv_gate = value;
          // Rising edge → spawn one shape. Push the CURRENT live params into the
          // sim FIRST so the gate-spawned shape latches the live spd/v/d/decay/
          // SHAPE at the moment of the edge. The gate handler runs on the
          // CV-bridge's cadence, which can fire BEFORE the first draw() (sim
          // still on its constructor defaults) or between draws after a knob
          // change — without this the shape would latch stale params (notably
          // decay=0 → never fades, spd → wrong/zero velocity → doesn't move).
          // draw() still pushes params every frame for the rate-clock spawns +
          // the live collide/rotation modes.
          if (gateEdge(gateState, value)) {
            sim.setParams(liveSpawnParams());
            sim.spawnFromGate();
          }
          return;
        }
        if (paramId in params) (params as unknown as Record<string, number>)[paramId] = value;
      },
      readParam(paramId) {
        return (params as unknown as Record<string, number>)[paramId];
      },
      read(key) {
        // Per-output textures for the engine's multi-output lookupInput path.
        if (key === 'outputTexture:overlap') return fboOverlap.texture;
        if (key === 'outputTexture:contour') return fboContour.texture;
        if (key === 'outputTexture:combine') return fboCombine.texture;
        if (key === 'outputTexture:mapped')  return fboMapped.texture;
        // Card preview blits the combine scene.
        if (key === 'sceneCanvas') return combineScene.canvas;
        // Test/telemetry hooks.
        // The live shape list (latched vx/vy/diameter/decayS/shape/baseAngle) —
        // lets tests assert what a gate-/clock-spawned shape latched at spawn
        // through the real module path (e.g. the gate-spawn live-param
        // regression + the SHAPE latch).
        if (key === 'circles') return sim.circles;
        if (key === 'circleCount') return sim.count;
        if (key === 'spawnCount') return sim.spawnCount;
        if (key === 'cullCount') return sim.cullCount;
        if (key === 'decayCount') return sim.decayCount;
        if (key === 'collisionCount') return sim.collisionCount;
        if (key === 'rotationAngle') return sim.rotationAngle;
        if (key === 'framesElapsed') return framesElapsed;
        if (key === 'maxCircles') return MAX_CIRCLES;
        return undefined;
      },
      dispose() { surface.dispose(); },
    };
  },
};

// Back-compat alias for the pre-rename export name (was circlesDef). The glob
// registry collects exports ending in 'Def'; outlinesDef is the live one. This
// alias keeps any straggling `circlesDef` import resolving but is the SAME def
// object (same type:'outlines'), so it does NOT double-register in the palette.
export const circlesDef = outlinesDef;
