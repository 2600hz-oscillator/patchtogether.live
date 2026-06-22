// packages/web/src/lib/video/modules/spirographs.ts
//
// SPIROGRAPHS — a classic-spirograph video GENERATOR (a pure synth source: no
// video input). It renders 1–3 INDEPENDENT spirographs — hypotrochoid (rolling
// circle INSIDE the fixed one) or epitrochoid (OUTSIDE) — each with its OWN full
// parameter set + matching CV, each DRIFTING around the screen with its fixed
// circle bouncing off the frame edges like a real spirograph constrained to the
// page.
//
// WHY CANVAS2D, NOT GLSL: a spirograph is a long polyline (a closed trochoid
// sampled over many revolutions) stroked with a genuine, visible LINE WIDTH.
// Canvas2D's stroke pipeline (round joins/caps, real px line width) renders
// that crisply in one pass; doing the same in a fragment shader (distance-to-
// curve over thousands of samples per pixel) is far costlier and the thickness
// control reads worse. So, like SHAPEGEN / TEXTMARQUEE, we paint to an
// OffscreenCanvas and upload it as a GL texture each frame. The curve math + the
// bounce-constraint live in the pure, unit-tested spirographs-math layer.
//
// THE 1–3 INDEPENDENT-SPIRO MODEL:
//   • `count` (discrete 1..3, knob + CV) sets how many spiros render.
//   • Each spiro i∈{1,2,3} has its OWN params (prefix `sI_`): fixedRadius (R),
//     rollingRadius (r), penOffset (p), inside (0=epi/outside, 1=hypo/inside),
//     rotation, scale, xOffset, yOffset, thickness, chroma. EVERY one of these
//     has a knob AND a CV input (port id == param id; the cross-domain CV bridge
//     routes a -1..+1 source into setParam(paramId)).
//   • Each spiro's CENTER drifts independently. Its drift velocity + home
//     position are per-spiro CONSTANTS seeded at construction (so the three
//     never move in lockstep), nudged by that spiro's xOffset/yOffset knobs.
//     The fixed-radius circle (radius R, scaled to screen) is constrained to
//     stay FULLY inside the frame and BOUNCES off the perimeter — closed-form
//     via spirographs-math.advanceCenter. Only the fixed circle's center+R is
//     bound; the drawn CURVE may overflow the viewport and clip (desired).
//
// OUTPUTS (both video, on the yellow drill-down PATCH PANEL — no raw side jacks):
//   • out       (video)      — the full-COLOUR composite (each spiro in its
//                              chroma hue, additively composited on black). This
//                              is the canonical surface.
//   • mono_out  (mono-video) — every spiro stroked WHITE on black (a clean matte
//                              for keying / luma downstream). Reachable via
//                              read('outputTexture:mono_out').
//
// INPUTS (PatchPanel, grouped per-spiro): the global `count` CV plus, per spiro,
// the ten per-param CVs. The card groups them into spiro1 / spiro2 / spiro3
// sections in the drill-down.

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';
import {
  advanceCenter,
  type CenterState,
  type SpiroKind,
} from './spirographs-math';
import { drawColorScene, drawMonoScene, type ResolvedSpiro } from './spirographs-draw';

// ── Per-spiro param ids ─────────────────────────────────────────────────────

/** The ten per-spiro param stems. The full param/port id is `s${i}_${stem}`. */
export const SPIRO_PARAM_STEMS = [
  'R',          // fixedRadius
  'r',          // rollingRadius
  'p',          // penOffset
  'inside',     // 0 = epitrochoid (outside), 1 = hypotrochoid (inside)
  'rotation',
  'scale',
  'xOffset',
  'yOffset',
  'thickness',
  'chroma',     // hue 0..1 (colorwheel)
] as const;
export type SpiroParamStem = (typeof SPIRO_PARAM_STEMS)[number];

export const SPIRO_COUNT_MAX = 3;

/** Build the per-spiro param id, e.g. spiroParamId(2, 'R') → 's2_R'. */
export function spiroParamId(i: number, stem: SpiroParamStem): string {
  return `s${i}_${stem}`;
}

// ── Per-spiro defaults (each spiro starts with a distinct look) ──────────────

interface SpiroDefault {
  R: number;
  r: number;
  p: number;
  inside: number;
  rotation: number;
  scale: number;
  xOffset: number;
  yOffset: number;
  thickness: number;
  chroma: number;
}

// Three visually-distinct starting spiros (only `count` of them render).
const SPIRO_DEFAULTS: Record<number, SpiroDefault> = {
  1: { R: 5,   r: 3,   p: 2.2, inside: 1, rotation: 0,    scale: 28, xOffset: 0, yOffset: 0, thickness: 2, chroma: 0.0  },
  2: { R: 7,   r: 3,   p: 3.5, inside: 1, rotation: 0.4,  scale: 22, xOffset: 0, yOffset: 0, thickness: 2, chroma: 0.45 },
  3: { R: 5,   r: 2,   p: 2.0, inside: 0, rotation: 0.9,  scale: 20, xOffset: 0, yOffset: 0, thickness: 2, chroma: 0.72 },
};

/** Per-spiro center-drift constants (home position as a fraction of the frame +
 *  velocity in frame-fractions per second). Distinct per spiro so they never
 *  move in lockstep — this is the "each spiro moves independently" seed. */
const SPIRO_DRIFT: Record<number, { hx: number; hy: number; vx: number; vy: number }> = {
  1: { hx: 0.35, hy: 0.45, vx: 0.055, vy: 0.041 },
  2: { hx: 0.6,  hy: 0.4,  vx: -0.047, vy: 0.063 },
  3: { hx: 0.5,  hy: 0.6,  vx: 0.071, vy: -0.052 },
};

// ── Param value ranges (for clamping + the card faders) ─────────────────────

export const SPIRO_RANGES: Record<SpiroParamStem, { min: number; max: number }> = {
  R:         { min: 1,    max: 12 },
  r:         { min: 0.5,  max: 11 },
  p:         { min: 0,    max: 8 },
  inside:    { min: 0,    max: 1 },
  rotation:  { min: 0,    max: 6.2832 }, // 0..2π
  scale:     { min: 4,    max: 60 },
  xOffset:   { min: -1,   max: 1 },
  yOffset:   { min: -1,   max: 1 },
  thickness: { min: 0.5,  max: 12 },
  chroma:    { min: 0,    max: 1 },
};

function clampStem(stem: SpiroParamStem, v: number): number {
  const rng = SPIRO_RANGES[stem];
  return Math.max(rng.min, Math.min(rng.max, v));
}

// ── The module's flat param map ─────────────────────────────────────────────
//
// `count` (1..3 discrete) + s{i}_{stem} for i in 1..3 × the ten stems.

function buildDefaults(): Record<string, number> {
  const d: Record<string, number> = { count: 1 };
  for (let i = 1; i <= SPIRO_COUNT_MAX; i++) {
    const def = SPIRO_DEFAULTS[i]!;
    for (const stem of SPIRO_PARAM_STEMS) {
      d[spiroParamId(i, stem)] = def[stem];
    }
  }
  return d;
}

const DEFAULTS = buildDefaults();

// ── Param defs + CV input ports ─────────────────────────────────────────────

const PARAMS: VideoModuleDef['params'] = (() => {
  const out: Array<{ id: string; label: string; defaultValue: number; min: number; max: number; curve: 'linear' | 'discrete' }> = [
    { id: 'count', label: 'Count', defaultValue: 1, min: 1, max: SPIRO_COUNT_MAX, curve: 'discrete' },
  ];
  for (let i = 1; i <= SPIRO_COUNT_MAX; i++) {
    for (const stem of SPIRO_PARAM_STEMS) {
      const rng = SPIRO_RANGES[stem];
      out.push({
        id: spiroParamId(i, stem),
        label: `${i} ${stem}`,
        defaultValue: DEFAULTS[spiroParamId(i, stem)]!,
        min: rng.min,
        max: rng.max,
        curve: stem === 'inside' ? 'discrete' : 'linear',
      });
    }
  }
  return out;
})();

const INPUTS: VideoModuleDef['inputs'] = (() => {
  const out: VideoModuleDef['inputs'] = [
    { id: 'count', type: 'cv', paramTarget: 'count', cvScale: { mode: 'discrete' } },
  ];
  for (let i = 1; i <= SPIRO_COUNT_MAX; i++) {
    for (const stem of SPIRO_PARAM_STEMS) {
      const id = spiroParamId(i, stem);
      out.push({
        id,
        type: 'cv',
        paramTarget: id,
        cvScale: { mode: stem === 'inside' ? 'discrete' : 'linear' },
      });
    }
  }
  return out;
})();

// ── Fullscreen-quad shader (samples the painted scene into the FBO) ─────────

const FRAG_SRC = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uScene;

void main() {
  // OffscreenCanvas origin is top-left; WebGL UV origin is bottom-left. Flip Y
  // so the painted scene reads upright in the FBO + downstream.
  vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
  outColor = texture(uScene, uv);
}`;

// ── Module def ──────────────────────────────────────────────────────────────

export const spirographsDef: VideoModuleDef = {
  type: 'spirographs',
  palette: { top: 'Video modules', sub: 'Sources' },
  domain: 'video',
  label: 'spirographs',
  category: 'sources',
  schemaVersion: 1,
  inputs: INPUTS,
  outputs: [
    { id: 'out', type: 'video' },           // full-colour composite (canonical)
    { id: 'mono_out', type: 'mono-video' }, // white-on-black matte
  ],
  params: PARAMS,

  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;
    const program = ctx.compileFragment(FRAG_SRC);
    const uScene = gl.getUniformLocation(program, 'uScene');

    const colorFbo = ctx.createFbo();
    const monoFbo = ctx.createFbo();

    const params: Record<string, number> = { ...DEFAULTS, ...(node.params as Record<string, number>) };

    // ---- Two scene canvases (colour + mono) + their upload textures ----
    // Both may be absent in headless node test envs — fall through to null so
    // the factory still spawns + draw() no-ops the paint/upload.
    function makeCanvas(): OffscreenCanvas | HTMLCanvasElement | null {
      try {
        if (typeof OffscreenCanvas !== 'undefined') {
          return new OffscreenCanvas(ctx.res.width, ctx.res.height);
        }
        if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
          const c = document.createElement('canvas');
          c.width = ctx.res.width;
          c.height = ctx.res.height;
          return c;
        }
      } catch {
        return null;
      }
      return null;
    }
    const colorCanvas = makeCanvas();
    const monoCanvas = makeCanvas();
    const colorCtx = colorCanvas
      ? (colorCanvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null)
      : null;
    const monoCtx = monoCanvas
      ? (monoCanvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null)
      : null;

    function makeSceneTex(): WebGLTexture {
      const t = gl.createTexture();
      if (!t) throw new Error('SPIROGRAPHS: createTexture failed');
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
        new Uint8Array([0, 0, 0, 255]));
      return t;
    }
    const colorTex = makeSceneTex();
    const monoTex = makeSceneTex();

    let framesElapsed = 0;

    /** Resolve the live per-spiro params + bounce-constrained center into the
     *  renderer's ResolvedSpiro list for the first `count` spiros. */
    function resolveSpiros(timeSec: number): ResolvedSpiro[] {
      const count = Math.max(1, Math.min(SPIRO_COUNT_MAX, Math.round(params.count ?? 1)));
      const W = ctx.res.width;
      const H = ctx.res.height;
      const list: ResolvedSpiro[] = [];
      for (let i = 1; i <= count; i++) {
        const R = clampStem('R', params[spiroParamId(i, 'R')] ?? 5);
        const r = clampStem('r', params[spiroParamId(i, 'r')] ?? 3);
        const p = clampStem('p', params[spiroParamId(i, 'p')] ?? 2);
        const insideV = params[spiroParamId(i, 'inside')] ?? 1;
        const kind: SpiroKind = insideV >= 0.5 ? 'inside' : 'outside';
        const rotation = clampStem('rotation', params[spiroParamId(i, 'rotation')] ?? 0);
        const scale = clampStem('scale', params[spiroParamId(i, 'scale')] ?? 24);
        const xOff = clampStem('xOffset', params[spiroParamId(i, 'xOffset')] ?? 0);
        const yOff = clampStem('yOffset', params[spiroParamId(i, 'yOffset')] ?? 0);
        const thickness = clampStem('thickness', params[spiroParamId(i, 'thickness')] ?? 2);
        const chroma = clampStem('chroma', params[spiroParamId(i, 'chroma')] ?? 0);

        // The screen radius of the FIXED circle (R, scaled). This is what the
        // bounce-constraint insets the center by so the circle never leaves frame.
        const fixedRadiusPx = R * scale;

        // Home position (xOffset/yOffset nudge the drift's home a little) + the
        // per-spiro drift velocity, converted from frame-fractions to pixels.
        const drift = SPIRO_DRIFT[i]!;
        const homeX = (drift.hx + xOff * 0.25) * W;
        const homeY = (drift.hy + yOff * 0.25) * H;
        const base: CenterState = {
          x: homeX,
          y: homeY,
          vx: drift.vx * W,
          vy: drift.vy * H,
        };
        const c = advanceCenter(base, fixedRadiusPx, W, H, timeSec);

        list.push({
          kind, R, r, p, rotation, scale,
          cx: c.x, cy: c.y,
          thickness, hue: chroma,
        });
      }
      return list;
    }

    const surface: VideoNodeSurface = {
      fbo: colorFbo.fbo,
      texture: colorFbo.texture,
      draw(frame) {
        const g = frame.gl;
        const timeSec = frame.time;
        const spiros = resolveSpiros(timeSec);
        const W = ctx.res.width;
        const H = ctx.res.height;

        // 1. Paint both scenes (colour + mono) on their 2D canvases.
        if (colorCtx) drawColorScene(colorCtx, spiros, W, H);
        if (monoCtx) drawMonoScene(monoCtx, spiros, W, H);

        // 2. Upload each painted canvas to its texture, then run the
        //    fullscreen-quad shader to copy it into the matching FBO.
        const uploadAndBlit = (
          canvas: OffscreenCanvas | HTMLCanvasElement | null,
          tex: WebGLTexture,
          fbo: WebGLFramebuffer | null,
        ) => {
          if (!canvas || !fbo) return;
          g.bindTexture(g.TEXTURE_2D, tex);
          g.pixelStorei(g.UNPACK_FLIP_Y_WEBGL, 0);
          g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, canvas as unknown as TexImageSource);
          g.bindFramebuffer(g.FRAMEBUFFER, fbo);
          g.viewport(0, 0, W, H);
          g.useProgram(program);
          g.activeTexture(g.TEXTURE0);
          g.bindTexture(g.TEXTURE_2D, tex);
          g.uniform1i(uScene, 0);
          ctx.drawFullscreenQuad();
          g.bindFramebuffer(g.FRAMEBUFFER, null);
        };
        uploadAndBlit(colorCanvas, colorTex, colorFbo.fbo);
        uploadAndBlit(monoCanvas, monoTex, monoFbo.fbo);

        framesElapsed++;
      },
      dispose() {
        gl.deleteFramebuffer(colorFbo.fbo);
        gl.deleteTexture(colorFbo.texture);
        gl.deleteFramebuffer(monoFbo.fbo);
        gl.deleteTexture(monoFbo.texture);
        gl.deleteTexture(colorTex);
        gl.deleteTexture(monoTex);
        gl.deleteProgram(program);
      },
    };

    return {
      domain: 'video',
      surface,
      setParam(paramId, value) {
        if (paramId in params) params[paramId] = value;
      },
      readParam(paramId) {
        return params[paramId];
      },
      read(key) {
        // Multi-output texture lookup (engine's lookupInput calls this for any
        // edge whose source port id != the canonical 'out').
        if (key === 'outputTexture:out') return colorFbo.texture;
        if (key === 'outputTexture:mono_out') return monoFbo.texture;
        if (key === 'framesElapsed') return framesElapsed;
        // Card preview snapshot hook (mirrors AcidwarpCard/ShapegenCard).
        if (key === 'sceneCanvas') return colorCanvas;
        return undefined;
      },
      dispose() { surface.dispose(); },
    };
  },
};
