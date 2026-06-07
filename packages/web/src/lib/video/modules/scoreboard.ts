// packages/web/src/lib/video/modules/scoreboard.ts
//
// SCOREBOARD — 4-digit neon 7-segment counter widget.
//
// I/O:
//   inputs:
//     - score (cv-typed gate, paramTarget 'scoreTrig')  rising edge → counter += 1
//     - reset (cv-typed gate, paramTarget 'resetTrig')  rising edge → counter = 0
//   outputs:
//     - out   (video)                                   the rendered display
//   params:
//     - color (linear 0..1, default ≈ 0.33 ≈ 120° green) — hue in HSL,
//       maps the lit-segment colour + glow halo.
//
// Increment policy: WRAP at 10000 back to 0 (the natural choice for
// sequencing — a periodic counter never gets stuck at the maximum). The
// alternative (clamp at 9999) makes the widget useless after a few seconds
// of any sequencer driving it. See SCOREBOARD_WRAP_AT in scoreboard-draw.
//
// Gate-input handling: the CV bridge already routes a gate signal from
// the audio domain into our `setParam(paramId, value)` calls — exactly
// the same path 4PLEXVID uses for its per-output gate inputs (see
// 4plexvid.ts). The factory holds a tiny hysteresis edge-detector per
// gate channel (rise > 0.6, fall < 0.4; see plex-select.gateEdge) so a
// CV signal that hovers in the dead band never chatters the counter.
// Zero engine plumbing changes were required for this PR.
//
// Render: we draw the digits into a 640×240 OffscreenCanvas via the pure
// `drawScoreboard` helper, then upload that as an RGBA8 texture every
// frame the score or hue changed. A trivial fragment shader letterboxes
// the texture into the engine's 640×480 FBO (SCOREBOARD is 8:3, much
// wider than the engine's 4:3 — we keep WIDTH-locked and centre
// vertically, leaving a wide band top + bottom). The same helper is
// invoked from the card's preview canvas at a smaller size.

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface, VideoEngineContext } from '$lib/video/engine';
import { gateEdge, makeGateState, type GateState } from '$lib/video/plex-select';
import {
  SCOREBOARD_WRAP_AT,
  drawScoreboard,
} from './scoreboard-draw';

/** Source-texture resolution. Shorter-than-engine height (240 vs 480) so the
 *  digits sit on a band; the shader letterboxes onto the FBO. 8:3 is the
 *  natural shape of a 4-digit numeric display. */
const SOURCE_W = 640;
const SOURCE_H = 240;

/** Default hue ≈ 0.333 (≈120° in HSL = pure green). The neon-green
 *  scoreboard look. */
export const SCOREBOARD_DEFAULT_HUE = 1 / 3;

/** Module params: a single user-facing colour knob + two synthetic gate
 *  params driven by the CV bridge through setParam. */
interface ScoreboardParams {
  color: number;
  scoreTrig: number;
  resetTrig: number;
}

const DEFAULTS: ScoreboardParams = {
  color: SCOREBOARD_DEFAULT_HUE,
  scoreTrig: 0,
  resetTrig: 0,
};

// Fragment shader: sample the SOURCE_W×SOURCE_H scoreboard texture into
// the engine's FBO, centred vertically (the source aspect is wider than
// the FBO). Black outside the active band.
const FRAG_SRC = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uTex;
uniform float uHas;
uniform vec2 uLetterbox; // (sx, sy) — UV size of the active region

void main() {
  if (uHas < 0.5) {
    outColor = vec4(0.04, 0.02, 0.02, 1.0);
    return;
  }
  vec2 centered = (vUv - 0.5) / uLetterbox + 0.5;
  if (centered.x < 0.0 || centered.x > 1.0 || centered.y < 0.0 || centered.y > 1.0) {
    outColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  outColor = vec4(texture(uTex, centered).rgb, 1.0);
}`;

/** Wrap an increment so the counter rolls over at SCOREBOARD_WRAP_AT.
 *  Exposed so the test can assert it directly without poking the factory. */
export function scoreboardWrap(score: number): number {
  // Defensive mod: tolerate non-integer + negative inputs.
  const s = Math.max(0, Math.floor(score));
  return s % SCOREBOARD_WRAP_AT;
}

export const scoreboardDef: VideoModuleDef = {
  type: 'scoreboard',
  palette: { top: 'Video modules', sub: 'Utilities' },
  domain: 'video',
  label: 'scoreboard',
  category: 'utilities',
  schemaVersion: 1,
  inputs: [
    // Two cv-typed gate inputs. paramTarget routes incoming CV through
    // the audio→video CV bridge into our setParam, where the edge
    // detector lives. The port id is human-readable (matches the
    // card's SCORE/RESET labels) while the param id carries the
    // synthetic "trig" suffix (mirrors acidwarp's `sceneTrig`).
    { id: 'score', type: 'cv', paramTarget: 'scoreTrig' },
    { id: 'reset', type: 'cv', paramTarget: 'resetTrig' },
  ],
  outputs: [{ id: 'out', type: 'video' }],
  params: [
    {
      id: 'color',
      label: 'Color',
      defaultValue: DEFAULTS.color,
      min: 0,
      max: 1,
      curve: 'linear',
    },
    // Synthetic gate params — hidden from the card; rendered as cv
    // jacks via the standard port row. curve 'linear' so setParam values
    // arrive raw for the edge detector.
    { id: 'scoreTrig', label: 'SCORE', defaultValue: 0, min: 0, max: 1, curve: 'linear' },
    { id: 'resetTrig', label: 'RESET', defaultValue: 0, min: 0, max: 1, curve: 'linear' },
  ],

  factory(ctx: VideoEngineContext, node): VideoNodeHandle {
    const gl = ctx.gl;
    const program = ctx.compileFragment(FRAG_SRC);
    const uTex = gl.getUniformLocation(program, 'uTex');
    const uHas = gl.getUniformLocation(program, 'uHas');
    const uLetterbox = gl.getUniformLocation(program, 'uLetterbox');

    const { fbo, texture } = ctx.createFbo();

    // Source texture — pre-allocated at SOURCE_W×SOURCE_H. We re-upload
    // via texImage2D from an OffscreenCanvas each frame the score / hue
    // changes; in steady state (counter held), no upload happens.
    const sourceTex = gl.createTexture();
    if (!sourceTex) throw new Error('SCOREBOARD: createTexture failed');
    gl.bindTexture(gl.TEXTURE_2D, sourceTex);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      SOURCE_W,
      SOURCE_H,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array(SOURCE_W * SOURCE_H * 4),
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // Letterbox: keep WIDTH locked, shrink height by the aspect ratio.
    // Engine FBO is 4:3 = 1.33:1; source is 8:3 ≈ 2.67:1. The active
    // region in V is (fboAspect / sourceAspect) = 0.5 (a tight band
    // top + bottom; the rest is black). Was 0.667 on a 16:9 FBO.
    const fboAspect = ctx.res.width / ctx.res.height;
    const sourceAspect = SOURCE_W / SOURCE_H;
    const letterboxU = Math.min(1.0, sourceAspect / fboAspect);
    const letterboxV = Math.min(1.0, fboAspect / sourceAspect);

    // ----- JS-side state -----
    const params: ScoreboardParams = {
      ...DEFAULTS,
      ...(node.params as Partial<ScoreboardParams>),
    };
    // Persistent counter — NOT a param (we don't want it visible as a
    // knob + the persistence layer would have to know it's an integer
    // anyway). Persistence: starts at 0 on every spawn — by design.
    //
    // VRT hook: the harness sets `window.__scoreboardVrtSeed = 1234` so the
    // captured baseline shows a stable, non-zero, all-segments-touching
    // value (1234 lights enough variety of segments to prove rendering).
    // No-op when the global is unset — production paths still start at 0.
    let counter = 0;
    if (typeof globalThis !== 'undefined') {
      const seed = (globalThis as unknown as { __scoreboardVrtSeed?: number }).__scoreboardVrtSeed;
      if (typeof seed === 'number' && Number.isFinite(seed)) {
        counter = scoreboardWrap(seed);
      }
    }
    let lastDrawnScore = -1;     // forces an initial upload on first draw
    let lastDrawnHue = Number.NaN;

    // Edge detectors — one per gate channel.
    const scoreGateState: GateState = makeGateState();
    const resetGateState: GateState = makeGateState();

    // OffscreenCanvas + 2D context for drawing the digits. We lazy-init
    // because jsdom (vitest) may not ship OffscreenCanvas in every
    // environment; the GL upload is then no-op until the canvas is
    // available, which is fine — the tests don't exercise GL.
    let offscreen: OffscreenCanvas | HTMLCanvasElement | null = null;
    let drawCtx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;
    function ensureCanvas(): boolean {
      if (drawCtx) return true;
      // Try OffscreenCanvas first (the browser hot path), then fall back to
      // an in-DOM <canvas>. Both `new OffscreenCanvas(...)` and
      // `document.createElement('canvas')` can THROW in test environments
      // (node's vitest pool exposes `document` as a stub whose
      // `createElement` is undefined); wrap in try/catch so the factory
      // still spawns in the unit suite without a real 2D rasteriser. The
      // GL path is fake-stubbed in tests anyway, so the missing canvas
      // doesn't matter — the GL upload is just skipped.
      try {
        if (typeof OffscreenCanvas !== 'undefined') {
          offscreen = new OffscreenCanvas(SOURCE_W, SOURCE_H);
        } else if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
          const c = document.createElement('canvas');
          c.width = SOURCE_W;
          c.height = SOURCE_H;
          offscreen = c;
        } else {
          return false;
        }
      } catch {
        return false;
      }
      try {
        const got = offscreen.getContext('2d');
        if (!got) return false;
        drawCtx = got as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
        return true;
      } catch {
        return false;
      }
    }

    function repaintIfNeeded(): void {
      if (counter === lastDrawnScore && params.color === lastDrawnHue) return;
      if (!ensureCanvas() || !drawCtx || !offscreen) return;
      drawScoreboard(
        drawCtx as CanvasRenderingContext2D,
        SOURCE_W,
        SOURCE_H,
        counter,
        params.color,
      );
      // Upload to GL.
      gl.bindTexture(gl.TEXTURE_2D, sourceTex);
      // texImage2D accepts ImageBitmap / HTMLCanvasElement / OffscreenCanvas
      // directly — the same path PICTUREBOX uses. UNPACK_FLIP_Y so the
      // canvas (top-down) lands right-side-up in GL (bottom-up).
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      // Cast because the WebGL2 TexImageSource union here covers both
      // OffscreenCanvas + HTMLCanvasElement.
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        offscreen as unknown as TexImageSource,
      );
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      lastDrawnScore = counter;
      lastDrawnHue = params.color;
    }

    // First paint — so the FBO carries something coherent before any
    // gate fires.
    repaintIfNeeded();

    const surface: VideoNodeSurface = {
      fbo,
      texture,
      draw(frame) {
        repaintIfNeeded();
        const g = frame.gl;
        g.bindFramebuffer(g.FRAMEBUFFER, fbo);
        g.viewport(0, 0, ctx.res.width, ctx.res.height);
        g.useProgram(program);
        g.activeTexture(g.TEXTURE0);
        g.bindTexture(g.TEXTURE_2D, sourceTex);
        g.uniform1i(uTex, 0);
        g.uniform1f(uHas, drawCtx ? 1.0 : 0.0);
        g.uniform2f(uLetterbox, letterboxU, letterboxV);
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
        if (paramId === 'scoreTrig') {
          params.scoreTrig = value;
          if (gateEdge(scoreGateState, value)) {
            counter = scoreboardWrap(counter + 1);
          }
          return;
        }
        if (paramId === 'resetTrig') {
          params.resetTrig = value;
          if (gateEdge(resetGateState, value)) {
            counter = 0;
          }
          return;
        }
        if (paramId === 'color') {
          params.color = value;
          return;
        }
      },
      readParam(paramId) {
        return (params as unknown as Record<string, number>)[paramId];
      },
      read(key) {
        // Card preview polls this each rAF for the live counter.
        if (key === 'score') return counter;
        if (key === 'color') return params.color;
        return undefined;
      },
      dispose() { surface.dispose(); },
    };
  },
};
