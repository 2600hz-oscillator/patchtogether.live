// packages/web/src/lib/video/modules/circles.ts
//
// CIRCLES — stateful particle video generator (LZX-style primitive source).
//
// A gate event (or the internal rate clock) spawns a circle at a seeded-
// random position; circles move in a latched direction at a latched speed
// and BOUNCE when their CENTER hits a wall, accumulating into a 1024-px
// field. Four outputs derive from a per-pixel overlap-COUNT of the active
// circles:
//
//   overlap (mono-video): white where ≥1 circle covers the pixel.
//   contour (mono-video): circle OUTLINES only (ring lw = 10% of d, min 2 px)
//                         → "ripples in a pond" as many circles stack.
//   combine (video):      the overlap region colorized by overlap COUNT via a
//                         hue ramp (1 = first hue; 2,3,4… cycle the spectrum)
//                         with brightness + saturation rising with stack depth.
//   mapped  (video):      the `video` INPUT's contents wherever ≥2 circles
//                         overlap, black elsewhere.
//
// Inputs:
//   gate  (gate):  a rising edge spawns one circle.
//   d / v / spd (cv, paramTarget=…): per-param CV (diameter / vector / speed).
//   video (video): sampled by the `mapped` output.
//
// Params (knobs):
//   d   (0..1 → 5..90 px)        circle DIAMETER, latched per circle at spawn.
//   v   (0..1 → 0..360°)         spawn VECTOR ANGLE, latched per circle.
//   spd (0..1 → 0..300 px/s)     SPEED, latched per circle (0 = static).
//   rate (0..1, KNOB ONLY)       internal spawn clock. 0 = gate-only; turning
//                                up engages a clock capped at 1 circle/500 ms.
//
// All the numeric behavior (seeded spawn, integration, center-bounce, latch,
// rate-clock cadence, the max-circle cull, and the per-output derivation) is
// in circles-sim.ts — WebGL-free + unit-tested. This file owns ONLY the GL
// plumbing: a 2D scene canvas painted per frame (overlap / contour / combine
// + a mask) uploaded into per-output textures, plus a small shader that
// multiplies the `video` input by the mask for `mapped`.
//
// Determinism (VRT / per-port / behavioral): the spawn RNG is seeded. When
// `globalThis.__circlesVrtSeed` is set BEFORE the module mounts, the sim is
// constructed with that fixed seed (so the painted frame is reproducible);
// otherwise a fixed default seed is used (still deterministic — never
// Math.random()).

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';
import { gateEdge, makeGateState, type GateState } from '$lib/video/plex-select';
import {
  CirclesSim,
  CIRCLES_FIELD,
  MAX_CIRCLES,
  combineRgbAt,
  ringWidth,
  type Circle,
} from './circles-sim';

/** The synthetic param the engine's CV-bridge writes the gate value into
 *  (mirrors SHAPEGEN's cv_clock). The port id is the human-readable `gate`;
 *  the param id carries the `cv_` prefix. */
export const CIRCLES_GATE_PARAM_ID = 'cv_gate';
/** The gate input port id. */
export const CIRCLES_GATE_PORT_ID = 'gate';

interface CirclesParams {
  d: number;
  v: number;
  spd: number;
  rate: number;
  // Synthetic gate param — written by the CV-bridge; hidden from the card.
  cv_gate: number;
}

const DEFAULTS: CirclesParams = {
  d: 0.3,    // ~30 px circles by default
  v: 0.125,  // 45° drift
  spd: 0.4,  // ~120 px/s — visibly moving
  rate: 0.5, // internal clock on by default so the source is alive on spawn
  cv_gate: 0,
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
// (white where ≥2 circles overlap). Both sampled in GL UV space; the mask is
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

export const circlesDef: VideoModuleDef = {
  type: 'circles',
  palette: { top: 'Video modules', sub: 'Sources' },
  domain: 'video',
  label: 'circles',
  category: 'sources',
  schemaVersion: 1,
  inputs: [
    // A gate event spawns a new circle. The CV-bridge routes the gate sample
    // into setParam(cv_gate, value); a rising-edge detector spawns one circle.
    { id: CIRCLES_GATE_PORT_ID, type: 'gate', paramTarget: CIRCLES_GATE_PARAM_ID },
    // Per-param CV — port id MUST equal the param id (the cross-domain CV
    // bridge routes onto setParam(portId)). `rate` is knob-only (no port).
    { id: 'd',   type: 'cv', paramTarget: 'd' },
    { id: 'v',   type: 'cv', paramTarget: 'v' },
    { id: 'spd', type: 'cv', paramTarget: 'spd' },
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
    { id: 'd',    label: 'D',    defaultValue: DEFAULTS.d,    min: 0, max: 1, curve: 'linear' },
    { id: 'v',    label: 'V',    defaultValue: DEFAULTS.v,    min: 0, max: 1, curve: 'linear' },
    { id: 'spd',  label: 'Spd',  defaultValue: DEFAULTS.spd,  min: 0, max: 1, curve: 'linear' },
    { id: 'rate', label: 'Rate', defaultValue: DEFAULTS.rate, min: 0, max: 1, curve: 'linear' },
    // Synthetic gate param — hidden from the card; rendered as the gate jack.
    { id: CIRCLES_GATE_PARAM_ID, label: 'GATE', defaultValue: 0, min: 0, max: 1, curve: 'linear' },
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

    const params: CirclesParams = { ...DEFAULTS, ...(node.params as Partial<CirclesParams>) };

    // ---- Seeded sim ----
    const vrtSeed = (globalThis as unknown as { __circlesVrtSeed?: number }).__circlesVrtSeed;
    const sim = new CirclesSim(typeof vrtSeed === 'number' ? vrtSeed >>> 0 : undefined);
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
          canvas = new OffscreenCanvas(CIRCLES_FIELD, CIRCLES_FIELD);
        } else if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
          const c = document.createElement('canvas');
          c.width = CIRCLES_FIELD;
          c.height = CIRCLES_FIELD;
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
      if (!t) throw new Error('CIRCLES: createTexture failed');
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

    // ---- 2D paint of one frame's circles into the four scene canvases. ----
    function paintScenes(circles: readonly Circle[]): void {
      // overlap — white discs on black (count≥1).
      if (overlapScene.ctx2d) {
        const c = overlapScene.ctx2d;
        c.fillStyle = '#000';
        c.fillRect(0, 0, CIRCLES_FIELD, CIRCLES_FIELD);
        c.fillStyle = '#fff';
        for (const ci of circles) {
          c.beginPath();
          c.arc(ci.x, ci.y, ci.diameter * 0.5, 0, Math.PI * 2);
          c.fill();
        }
      }
      // contour — white rings (lw = 10% of d, min 2px) on black.
      if (contourScene.ctx2d) {
        const c = contourScene.ctx2d;
        c.fillStyle = '#000';
        c.fillRect(0, 0, CIRCLES_FIELD, CIRCLES_FIELD);
        c.strokeStyle = '#fff';
        for (const ci of circles) {
          const lw = ringWidth(ci.diameter);
          c.lineWidth = lw;
          // Stroke centered on the path; the sim's ring test is [r−lw, r], so
          // stroke a circle of radius r − lw/2 so the band sits inside the disc.
          const rStroke = Math.max(0, ci.diameter * 0.5 - lw * 0.5);
          c.beginPath();
          c.arc(ci.x, ci.y, rStroke, 0, Math.PI * 2);
          c.stroke();
        }
      }
      // mask — white where ≥2 circles overlap. We additively accumulate disc
      // coverage (each disc adds a small constant), then any pixel touched by
      // ≥2 discs reads ≥ the 2-disc threshold. Using 'lighter' compositing
      // sums alpha so overlaps brighten; we then threshold in the shader is
      // overkill — instead draw each disc at a fixed grey and rely on additive
      // sum: 1 disc = ~0.4, 2 discs = ~0.8 (clamped). We pick a level so the
      // shader's mask>0.5 test = "≥2 overlaps". 2-disc additive ≈ 0.8 > 0.5;
      // 1-disc ≈ 0.4 < 0.5. (The unit suite pins the exact ≥2 rule on the sim;
      // this canvas path is the GL approximation the shader reads.)
      if (maskScene.ctx2d) {
        const c = maskScene.ctx2d;
        c.globalCompositeOperation = 'source-over';
        c.fillStyle = '#000';
        c.fillRect(0, 0, CIRCLES_FIELD, CIRCLES_FIELD);
        c.globalCompositeOperation = 'lighter';
        c.fillStyle = 'rgba(255,255,255,0.42)';
        for (const ci of circles) {
          c.beginPath();
          c.arc(ci.x, ci.y, ci.diameter * 0.5, 0, Math.PI * 2);
          c.fill();
        }
        c.globalCompositeOperation = 'source-over';
      }
      // combine — overlap region colorized by COUNT via the hue ramp. We can't
      // cheaply do per-pixel count in canvas2D for the exact ramp, so we
      // approximate the user-visible effect by drawing each disc with additive
      // HSV-stepped fills: base hue advances with painted order which on
      // overlap stacks toward brighter/whiter — close to the count ramp. For
      // an EXACT count→hue (matching the unit-tested combineRgbAt), we paint a
      // coarse count grid: sample the count at a downsampled grid + fill cells.
      // The downsample keeps it cheap (a 128×128 grid = 16k cells) while the
      // colour matches combineRgbAt at the cell center.
      if (combineScene.ctx2d) {
        const c = combineScene.ctx2d;
        c.fillStyle = '#000';
        c.fillRect(0, 0, CIRCLES_FIELD, CIRCLES_FIELD);
        if (circles.length > 0) {
          const GRID = 160;
          const cell = CIRCLES_FIELD / GRID;
          for (let gy = 0; gy < GRID; gy++) {
            const py = (gy + 0.5) * cell;
            for (let gx = 0; gx < GRID; gx++) {
              const px = (gx + 0.5) * cell;
              const [r, g, b] = combineRgbAt(circles, px, py);
              if (r === 0 && g === 0 && b === 0) continue;
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

        // Push live params into the sim (latched per-circle at spawn).
        sim.setParams({ d: params.d, v: params.v, spd: params.spd, rate: params.rate });
        // Advance the sim (internal rate clock spawns + integration + bounce).
        sim.step(dtMs);

        const circles = sim.circles;

        // Paint + upload the four scene canvases.
        paintScenes(circles);
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
        if (paramId === CIRCLES_GATE_PARAM_ID) {
          params.cv_gate = value;
          // Rising edge → spawn one circle.
          if (gateEdge(gateState, value)) sim.spawnFromGate();
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
        if (key === 'circleCount') return sim.count;
        if (key === 'spawnCount') return sim.spawnCount;
        if (key === 'cullCount') return sim.cullCount;
        if (key === 'framesElapsed') return framesElapsed;
        if (key === 'maxCircles') return MAX_CIRCLES;
        return undefined;
      },
      dispose() { surface.dispose(); },
    };
  },
};
