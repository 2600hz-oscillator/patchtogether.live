// packages/web/src/lib/video/modules/tiler.ts
//
// TILER — video multiscreen / TILE effect PROCESSOR.
//
// Repeats the input frame in a cols×rows grid: each cell shows the FULL input
// scaled to fit, so the tiled copies are lower-resolution by nature. This is
// the classic video-mixer "multiscreen / tile" effect — a 2×2 grid is 4
// thumbnails of the same source, an 8×8 grid is 64 tiny copies.
//
// The knob value is the TOTAL tile count (1 / 4 / 6 / 12 / 16 / 64). Grids are
// LANDSCAPE (cols >= rows) so each tiled cell keeps the source video's wide
// aspect — the standard video-multiscreen look.
//
// Implemented as a single-pass fragment shader. The whole effect is one line:
// `color = texture(input, fract(uv * vec2(cols, rows)))`. `uv * vec2(cols,rows)`
// stretches the 0..1 UV across the cells; `fract()` wraps each cell back to the
// full 0..1 input — so every cell samples the entire source. At 1×1
// fract(uv) == uv (for uv in [0,1)), so total 1 is an exact 1:1 passthrough.
//
// TILER is STATELESS per frame — the tiling moves/transforms live with the
// source (no feedback, no history) — so it's a pure function of the current
// input frame + the TILE knob (+ its CV).
//
// ── TILE — DISCRETE grid size (6 steps) ───────────────────────────────
// One discrete knob snaps to 6 grids. The param value is the STEP INDEX 0..5
// (so the discrete fader + the discrete-cvScale CV both snap to the 6 steps);
// the index maps to a grid { total, cols, rows }:
//
//   idx 0 → total 1   → 1×1   (1:1 passthrough — NO tiling, fract(uv)==uv)
//   idx 1 → total 4   → 2×2   (4 copies)
//   idx 2 → total 6   → 3×2   (6 copies — landscape "2x3")
//   idx 3 → total 12  → 4×3   (12 copies — landscape "3x4")
//   idx 4 → total 16  → 4×4   (16 copies)
//   idx 5 → total 64  → 8×8   (64 copies)
//
// The lowest step is deliberately total 1 (passthrough) so a fresh TILER, or a
// TILER swept to the bottom of the knob, is a transparent inline node.
//
// ── TILE CV (sum-then-snap to the nearest valid step) ─────────────────
// The TILE CV input uses a DISCRETE cvScale, so the CV bridge snaps the
// incoming CV onto the index steps and SUMS it into the `tile` index param
// (the same plumbing every per-param CV input uses). The displaced index can
// land fractionally between steps (CV resolution + the bridge sum), so the
// module RESOLVES it to a clean grid via `tilerResolveGrid`: it interpolates
// the step TOTAL across the steps for the (possibly fractional) summed index,
// then SNAPS to the step whose total is NEAREST in TILER_STEPS. So a CV that
// pushes the knob "a bit past 6" lands cleanly on the 12 step (the nearest
// valid total), never on an invalid in-between grid. (The snap is to nearest
// total, NOT nearest index, so the perceived jump matches the tile-count scale
// the user sees.)
//
// Inputs:
//   in (video): RGB source to tile.
//   tile_cv (cv, paramTarget=tile): DISCRETE cvScale — snaps + sums into the
//     TILE index, then the module snaps to the nearest valid step.
//
// Outputs:
//   out (video): the tiled frame.
//
// Params:
//   tile (discrete 0..5): grid-size step index (default 0 = total 1 passthrough).

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';

// ----------------------------------------------------------------------
// Grid-size model — exported for unit tests + the card readout (no GL).
// ----------------------------------------------------------------------

/** A single TILE step: the TOTAL tile count and its landscape cols×rows
 *  realization (cols >= rows so each cell keeps the source's wide aspect). */
export interface TilerStep {
  total: number;
  cols: number;
  rows: number;
}

/** The 6 grids the TILE knob snaps to. The index into this array == the `tile`
 *  param value (a discrete 0..5 fader). The knob value the user reads is the
 *  TOTAL tile count. total 1 (index 0) is a 1:1 passthrough (no tiling). */
export const TILER_STEPS: readonly TilerStep[] = [
  { total: 1,  cols: 1, rows: 1 }, // 1:1 passthrough (NO tiling)
  { total: 4,  cols: 2, rows: 2 }, // 2×2
  { total: 6,  cols: 3, rows: 2 }, // 3×2 (landscape "2x3")
  { total: 12, cols: 4, rows: 3 }, // 4×3 (landscape "3x4")
  { total: 16, cols: 4, rows: 4 }, // 4×4
  { total: 64, cols: 8, rows: 8 }, // 8×8
];

/** Back-compat: the step TOTALS in step order ([1,4,6,12,16,64]). The card
 *  uses this for the tick-rail labels. */
export const TILER_GRID_STEPS: readonly number[] = TILER_STEPS.map((s) => s.total);

/** Default TILE step index — 0 = total 1 = 1:1 passthrough, so a fresh TILER
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
  const n = TILER_STEPS.length;
  if (!Number.isFinite(rawTile)) return TILER_DEFAULT_TILE_INDEX;
  return Math.max(0, Math.min(n - 1, Math.round(rawTile)));
}

/**
 * The grid { total, cols, rows } for a `tile` step INDEX. This is the plain
 * knob → grid mapping (0..5 → TILER_STEPS) with no CV involved: round the
 * index to a clean step, then read the grid from TILER_STEPS. Shared by the
 * shader, the card readout, and the unit tests.
 */
export function tilerStepGrid(rawTile: number): TilerStep {
  return TILER_STEPS[tilerTileIndex(rawTile)]!;
}

/**
 * Snap an arbitrary tile TOTAL to the step whose total is NEAREST in
 * TILER_STEPS. Ties (equidistant between two steps) resolve to the SMALLER
 * total (the lower grid — fewer, larger tiles). Shared by the CV resolve path
 * + the unit tests so "nearest valid step" has one definition.
 */
export function tilerSnapNearestStep(total: number): TilerStep {
  if (!Number.isFinite(total)) return TILER_STEPS[TILER_DEFAULT_TILE_INDEX]!;
  let best = TILER_STEPS[0]!;
  let bestDist = Math.abs(total - best.total);
  for (let i = 1; i < TILER_STEPS.length; i++) {
    const cand = TILER_STEPS[i]!;
    const dist = Math.abs(total - cand.total);
    // Strictly-less keeps the SMALLER total on a tie (we iterate ascending).
    if (dist < bestDist) {
      best = cand;
      bestDist = dist;
    }
  }
  return best;
}

/**
 * Resolve the effective grid from the (possibly fractional) summed `tile`
 * index — the CV "sum-then-snap to the nearest valid step" rule.
 *
 * The CV bridge has already SUMMED the (discrete-snapped) CV into the knob
 * index, so `summedTileIndex` is the knob index displaced by the CV. It can be
 * fractional (CV resolution / the bridge sum). We:
 *   1. interpolate the step TOTAL across TILER_STEPS for that fractional index
 *      (so an index of 1.5 is "halfway between total 4 and total 6" = 5),
 *      clamping the index to [0, last];
 *   2. SNAP that total to the nearest valid step (tilerSnapNearestStep).
 *
 * So a CV that nudges the knob a little past the "6" step resolves to the
 * nearest real grid, never an invalid in-between. With NO CV (an integer
 * index) this is exactly `tilerStepGrid` — the plain knob → grid mapping.
 *
 * Exported so the shader's draw() + the unit tests share one source of truth
 * for the resolve rule.
 */
export function tilerResolveGrid(summedTileIndex: number): TilerStep {
  const last = TILER_STEPS.length - 1;
  if (!Number.isFinite(summedTileIndex)) {
    return TILER_STEPS[TILER_DEFAULT_TILE_INDEX]!;
  }
  const idx = Math.max(0, Math.min(last, summedTileIndex));
  const lo = Math.floor(idx);
  const hi = Math.min(last, lo + 1);
  const frac = idx - lo;
  // Interpolate the TOTAL across the (unevenly spaced) step totals, then snap.
  const interpTotal =
    TILER_STEPS[lo]!.total + (TILER_STEPS[hi]!.total - TILER_STEPS[lo]!.total) * frac;
  return tilerSnapNearestStep(interpTotal);
}

const FRAG_SRC = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uTex;
uniform float uHasInput;
uniform float uCols;       // grid columns (1, 2, 3, 4, 4, 8)
uniform float uRows;       // grid rows    (1, 2, 2, 3, 4, 8)

void main() {
  if (uHasInput < 0.5) {
    outColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  // Tile: stretch the UV across cols×rows cells, wrap each cell back to the
  // full 0..1 input. fract(uv * vec2(cols, rows)) repeats the whole source
  // cols×rows times. At 1×1 fract(uv) == uv for uv in [0,1), so this is an
  // exact 1:1 passthrough.
  vec2 tiledUv = fract(vUv * vec2(uCols, uRows));
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
    // TILE CV — DISCRETE cvScale so the CV snaps to the index steps and sums
    // into the `tile` index; the module then snaps the summed (possibly
    // fractional) index to the nearest valid step (tilerResolveGrid).
    { id: 'tile_cv', type: 'cv', paramTarget: 'tile', cvScale: { mode: 'discrete' } },
  ],
  outputs: [
    { id: 'out', type: 'video' },
  ],
  params: [
    // The step INDEX 0..5 into TILER_STEPS (discrete fader). The card shows the
    // resulting grid (e.g. "8×8") next to it.
    { id: 'tile', label: 'Tile', defaultValue: TILER_DEFAULTS.tile, min: 0, max: TILER_STEPS.length - 1, curve: 'discrete' },
  ],

  // docs-hash-ignore:start
  docs: {
    explanation: "TILER is the classic video-mixer \"multiscreen / tile\" effect: it repeats the incoming frame across a landscape cols×rows grid, where every cell shows the FULL source scaled down to fit, so each tile is a lower-resolution thumbnail of the same picture. A 2×2 grid is 4 copies, an 8×8 grid is 64 tiny copies. It's a single-pass shader whose whole effect is one line — fract(uv * vec2(cols, rows)) stretches the UV across the cells and wraps each cell back to the full 0..1 input, so each tile samples the entire source; at the 1×1 step fract(uv)==uv, making it an exact 1:1 passthrough. TILER is stateless per frame (no feedback or history), so tiled copies move and transform live with whatever feeds it. Drop it inline on a video chain and dial the TILE knob up for a quick multiscreen wall, or sweep it (or modulate it via CV) to step between grid densities. With no input it outputs solid black.",
    inputs: {
      in: "Video source to tile. Each grid cell shows this entire frame scaled to fit the cell, so the picture is repeated cols×rows times across the output. With nothing patched here the output is solid black.",
      tile_cv: "CV that modulates the Tile control. It uses a discrete scale, so the incoming CV snaps to the grid steps and sums into the Tile index; the module then resolves the (possibly fractional) summed index to the nearest valid grid step, so it always lands on a real grid (1/4/6/12/16/64), never an in-between.",
    },
    outputs: {
      out: "The tiled frame — the source repeated across the resolved cols×rows landscape grid. At the lowest Tile step (total 1) this is an exact 1:1 passthrough of the input.",
    },
    controls: {
      tile: "Grid size — a 6-step discrete knob selecting the TOTAL tile count: 1, 4, 6, 12, 16, or 64. Each maps to a landscape grid (1×1, 2×2, 3×2, 4×3, 4×4, 8×8) so each cell keeps the source's wide aspect. Default is step 0 (total 1 = 1:1 passthrough, no tiling); higher steps pack more, smaller copies of the source.",
    },
  },
  // docs-hash-ignore:end
  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;
    const program = ctx.compileFragment(FRAG_SRC);

    const uTex      = gl.getUniformLocation(program, 'uTex');
    const uHasInput = gl.getUniformLocation(program, 'uHasInput');
    const uCols     = gl.getUniformLocation(program, 'uCols');
    const uRows     = gl.getUniformLocation(program, 'uRows');

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

        // Resolve the grid: the (CV-summed, possibly fractional) `tile` index →
        // nearest valid step. With no CV this is exactly the plain knob → grid
        // mapping.
        const grid = tilerResolveGrid(params.tile);
        g.uniform1f(uCols, grid.cols);
        g.uniform1f(uRows, grid.rows);

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
        // UI: the resolved grid (CV included).
        if (key === 'gridTotal') return tilerResolveGrid(params.tile).total;
        if (key === 'gridCols') return tilerResolveGrid(params.tile).cols;
        if (key === 'gridRows') return tilerResolveGrid(params.tile).rows;
        return undefined;
      },
      dispose() { surface.dispose(); },
    };
  },
};
