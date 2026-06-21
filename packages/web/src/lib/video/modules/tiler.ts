// packages/web/src/lib/video/modules/tiler.ts
//
// TILER — video multiscreen / TILE effect PROCESSOR.
//
// Repeats the input frame in an N×N grid: each cell shows the FULL input
// scaled to 1/N, so the tiled copies are lower-resolution by nature. This
// is the classic video-mixer "multiscreen / tile" effect — a 4×4 grid is
// 16 thumbnails of the same source, a 16×16 grid is 256 tiny copies.
//
// Implemented as a single-pass fragment shader. The whole effect is one
// line: `color = texture(input, fract(uv * N))`. `uv * N` stretches the
// 0..1 UV across N cells; `fract()` wraps each cell back to the full 0..1
// input — so every cell samples the entire source. At N=1 fract(uv) == uv
// (for uv in [0,1)), so N=1 is an exact 1:1 passthrough.
//
// CELLSHADE is STATELESS per frame — the tiling moves/transforms live with
// the source (no feedback, no history) — so it's a pure function of the
// current input frame + the TILE knob (+ its CV).
//
// ── TILE — DISCRETE grid size (6 steps) ───────────────────────────────
// One discrete knob snaps to 6 grid sizes. The param value is the STEP
// INDEX 0..5 (so the discrete fader + the discrete-cvScale CV both snap to
// the 6 steps); the index maps to a grid dimension N:
//
//   idx 0 → N = 1   → 1:1 passthrough (NO tiling — fract(uv)==uv)
//   idx 1 → N = 4   → 4×4 grid (16 copies)
//   idx 2 → N = 6   → 6×6 grid (36 copies)
//   idx 3 → N = 8   → 8×8 grid (64 copies)
//   idx 4 → N = 12  → 12×12 grid (144 copies)
//   idx 5 → N = 16  → 16×16 grid (256 copies)
//
// The lowest step is deliberately N=1 (passthrough) so a fresh TILER, or a
// TILER swept to the bottom of the knob, is a transparent inline node.
//
// ── TILE CV (sum-then-snap to the nearest valid N) ────────────────────
// The TILE CV input uses a DISCRETE cvScale, so the CV bridge snaps the
// incoming CV onto the index steps and SUMS it into the `tile` index param
// (the same plumbing every per-param CV input uses). The displaced index
// can land fractionally between steps (CV resolution + the bridge sum), so
// the module RESOLVES it to a clean grid via `tilerResolveN`: it converts
// the (possibly fractional) summed index to an N value and SNAPS to the
// NEAREST valid N in TILER_GRID_STEPS. So a CV that pushes the knob "a bit
// past 6" lands cleanly on 8 (the nearest valid N), never on an invalid
// 7×7. (The snap is to nearest N, NOT nearest index, so the perceived jump
// matches the grid-size scale the user sees.)
//
// Inputs:
//   in (video): RGB source to tile.
//   tile_cv (cv, paramTarget=tile): DISCRETE cvScale — snaps + sums into
//     the TILE index, then the module snaps to the nearest valid N step.
//
// Outputs:
//   out (video): the tiled frame.
//
// Params:
//   tile (discrete 0..5): grid-size step index (default 0 = N=1 passthrough).

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';

// ----------------------------------------------------------------------
// Grid-size model — exported for unit tests + the card readout (no GL).
// ----------------------------------------------------------------------

/** The 6 grid sizes the TILE knob snaps to. The index into this array ==
 *  the `tile` param value (a discrete 0..5 fader). N is the grid DIMENSION
 *  (N×N cells). N=1 (index 0) is a 1:1 passthrough (no tiling). */
export const TILER_GRID_STEPS: readonly number[] = [1, 4, 6, 8, 12, 16];

/** Default TILE step index — 0 = N=1 = 1:1 passthrough, so a fresh TILER
 *  is a transparent inline node until the user dials in a grid. */
export const TILER_DEFAULT_TILE_INDEX = 0;

/**
 * Clamp + round a raw `tile` param (possibly fractional from a CV write or
 * the bridge sum) to a valid step INDEX 0..5. The discrete fader + discrete
 * cvScale both already snap, but we re-snap here so the shader/CPU-mirror
 * always see a clean integer step (defensive against a fractional value
 * bleeding in). Non-finite → the default index.
 */
export function tilerTileIndex(rawTile: number): number {
  const n = TILER_GRID_STEPS.length;
  if (!Number.isFinite(rawTile)) return TILER_DEFAULT_TILE_INDEX;
  return Math.max(0, Math.min(n - 1, Math.round(rawTile)));
}

/**
 * The grid dimension N (1/4/6/8/12/16) for a `tile` step INDEX. This is the
 * plain knob → N mapping (0..5 → [1,4,6,8,12,16]) with no CV involved:
 * round the index to a clean step, then read N from TILER_GRID_STEPS.
 * Shared by the shader, the card readout, and the unit tests.
 */
export function tilerStepN(rawTile: number): number {
  return TILER_GRID_STEPS[tilerTileIndex(rawTile)]!;
}

/**
 * Snap an arbitrary grid dimension to the NEAREST valid N in
 * TILER_GRID_STEPS. Ties (equidistant between two steps) resolve to the
 * SMALLER N (the lower grid — fewer, larger tiles). Shared by the CV
 * resolve path + the unit tests so "nearest valid N" has one definition.
 */
export function tilerSnapNearestN(n: number): number {
  if (!Number.isFinite(n)) return TILER_GRID_STEPS[TILER_DEFAULT_TILE_INDEX]!;
  let best = TILER_GRID_STEPS[0]!;
  let bestDist = Math.abs(n - best);
  for (let i = 1; i < TILER_GRID_STEPS.length; i++) {
    const cand = TILER_GRID_STEPS[i]!;
    const dist = Math.abs(n - cand);
    // Strictly-less keeps the SMALLER N on a tie (we iterate ascending).
    if (dist < bestDist) {
      best = cand;
      bestDist = dist;
    }
  }
  return best;
}

/**
 * Resolve the effective grid dimension N from the (possibly fractional)
 * summed `tile` index — the CV "sum-then-snap to the nearest valid N" rule.
 *
 * The CV bridge has already SUMMED the (discrete-snapped) CV into the knob
 * index, so `summedTileIndex` is the knob index displaced by the CV. It can
 * be fractional (CV resolution / the bridge sum). We:
 *   1. interpolate that fractional index across TILER_GRID_STEPS to an N
 *      value (so an index of 1.5 is "halfway between N=4 and N=6" = N≈5),
 *      clamping the index to [0, last];
 *   2. SNAP that N to the nearest valid grid (tilerSnapNearestN).
 *
 * So a CV that nudges the knob a little past the "6" step resolves to the
 * nearest real grid (8), never an invalid 7×7. With NO CV (an integer
 * index) this is exactly `tilerStepN` — the plain knob → N mapping.
 *
 * Exported so the shader's draw() + the unit tests share one source of
 * truth for the resolve rule.
 */
export function tilerResolveN(summedTileIndex: number): number {
  const last = TILER_GRID_STEPS.length - 1;
  if (!Number.isFinite(summedTileIndex)) {
    return TILER_GRID_STEPS[TILER_DEFAULT_TILE_INDEX]!;
  }
  const idx = Math.max(0, Math.min(last, summedTileIndex));
  const lo = Math.floor(idx);
  const hi = Math.min(last, lo + 1);
  const frac = idx - lo;
  // Interpolate N across the (unevenly spaced) step values, then snap.
  const interpN = TILER_GRID_STEPS[lo]! + (TILER_GRID_STEPS[hi]! - TILER_GRID_STEPS[lo]!) * frac;
  return tilerSnapNearestN(interpN);
}

const FRAG_SRC = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uTex;
uniform float uHasInput;
uniform float uN;          // grid dimension (1, 4, 6, 8, 12, 16)

void main() {
  if (uHasInput < 0.5) {
    outColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  // Tile: stretch the UV across N cells, wrap each cell back to the full
  // 0..1 input. fract(uv * N) repeats the whole source N×N times. At N=1
  // fract(uv) == uv for uv in [0,1), so this is an exact 1:1 passthrough.
  vec2 tiledUv = fract(vUv * uN);
  outColor = vec4(texture(uTex, tiledUv).rgb, 1.0);
}`;

export interface TilerParams {
  tile: number; // discrete 0..5 grid-size step index
}

export const TILER_DEFAULTS: TilerParams = {
  tile: TILER_DEFAULT_TILE_INDEX,
};

const PARAM_IDS: ReadonlySet<string> = new Set(Object.keys(TILER_DEFAULTS));

export const tilerDef: VideoModuleDef = {
  type: 'tiler',
  palette: { top: 'Video modules', sub: 'Processors' },
  domain: 'video',
  label: 'tiler',
  category: 'effects',
  schemaVersion: 1,
  inputs: [
    { id: 'in', type: 'video' },
    // TILE CV — DISCRETE cvScale so the CV snaps to the index steps and
    // sums into the `tile` index; the module then snaps the summed (possibly
    // fractional) index to the nearest valid N step (tilerResolveN).
    { id: 'tile_cv', type: 'cv', paramTarget: 'tile', cvScale: { mode: 'discrete' } },
  ],
  outputs: [
    { id: 'out', type: 'video' },
  ],
  params: [
    // The step INDEX 0..5 into TILER_GRID_STEPS (discrete fader). The card
    // shows the resulting grid (e.g. "8×8") next to it.
    { id: 'tile', label: 'Tile', defaultValue: TILER_DEFAULTS.tile, min: 0, max: TILER_GRID_STEPS.length - 1, curve: 'discrete' },
  ],

  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;
    const program = ctx.compileFragment(FRAG_SRC);

    const uTex      = gl.getUniformLocation(program, 'uTex');
    const uHasInput = gl.getUniformLocation(program, 'uHasInput');
    const uN        = gl.getUniformLocation(program, 'uN');

    const { fbo, texture } = ctx.createFbo();

    // Strip stray non-numeric / unknown keys so they can't bleed in.
    const rawParams = node.params as Record<string, unknown>;
    const filtered: Record<string, number> = {};
    for (const [k, v] of Object.entries(rawParams)) {
      if (PARAM_IDS.has(k) && typeof v === 'number') filtered[k] = v;
    }
    const params: TilerParams = { ...TILER_DEFAULTS, ...(filtered as Partial<TilerParams>) };

    const surface: VideoNodeSurface = {
      fbo,
      texture,
      draw(frame) {
        const g = frame.gl;
        g.bindFramebuffer(g.FRAMEBUFFER, fbo);
        g.viewport(0, 0, ctx.res.width, ctx.res.height);
        g.useProgram(program);

        const inputTex = frame.getInputTexture(node.id, 'in');
        g.uniform1f(uHasInput, inputTex ? 1.0 : 0.0);
        if (inputTex) {
          g.activeTexture(g.TEXTURE0);
          g.bindTexture(g.TEXTURE_2D, inputTex);
          g.uniform1i(uTex, 0);
        }

        // Resolve the grid dimension N: the (CV-summed, possibly fractional)
        // `tile` index → nearest valid N. With no CV this is exactly the
        // plain knob → N mapping.
        g.uniform1f(uN, tilerResolveN(params.tile));

        ctx.drawFullscreenQuad();
        g.bindFramebuffer(g.FRAMEBUFFER, null);
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
      setParam(paramId, value) {
        if (paramId in params) (params as unknown as Record<string, number>)[paramId] = value;
      },
      readParam(paramId) {
        return (params as unknown as Record<string, number>)[paramId];
      },
      read(key) {
        if (key === 'fboTexture') return surface.texture;
        // UI: the resolved grid dimension N (1/4/6/8/12/16), CV included.
        if (key === 'gridN') return tilerResolveN(params.tile);
        return undefined;
      },
      dispose() { surface.dispose(); },
    };
  },
};
