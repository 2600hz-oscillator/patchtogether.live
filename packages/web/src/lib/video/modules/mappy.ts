// packages/web/src/lib/video/modules/mappy.ts
//
// MAPPY — a multi-surface MANUAL projection mapper (v1 MVP).
//
// ──────────────────────────────────────────────────────────────────────────
// WHAT IT DOES
// ──────────────────────────────────────────────────────────────────────────
// MAPPY spawns up to SIX surfaces. Each surface is fed by a distinct video
// input (in1..in6) and warped onto its own draggable QUAD in the output
// frame, then composited (painter's order, OVER) into ONE output → a
// projector. Use cases:
//   * 1 surface  → DE-SKEW an awkwardly-angled projection (drag the four
//     corners to match the physical screen).
//   * up to 6    → map each face of a white cube to its own video feed (only
//     ~3-4 faces are visible at once from any one projector angle).
//
// This is the MANUAL mapper: you drag the corners by hand on the card. The
// camera-assisted AUTO-align (point a camera at the projection, solve the
// homography from detected features) is a LATER phase — there is NO camera
// input and NO CV here in v1, by design.
//
// ──────────────────────────────────────────────────────────────────────────
// WARP + COMPOSITE
// ──────────────────────────────────────────────────────────────────────────
// Each surface owns a 4-corner QUAD in NORMALIZED [0,1] output space, corner
// order TL, TR, BR, BL — the SAME order as mappy-homography's UNIT_QUAD. The
// homography unitToQuad(corners) maps the unit square (the source frame) onto
// that quad. To RENDER, the warp shader runs per OUTPUT texel: it takes the
// output UV, applies the INVERSE homography to find the matching SOURCE UV,
// and samples the input there — sampling only if that source UV is inside
// [0,1] (else the texel is transparent for this surface, i.e. outside the
// surface's footprint). We pass the inverse mat3 as a GLSL column-major
// uniform via toColumnMajor(invertHomography(unitToQuad(corners))).
//
// Surfaces are drawn ONE AT A TIME into a shared composite FBO with GL blend
// OVER (src-alpha), in surface order (in1 first … in6 last), so later
// surfaces paint over earlier ones where they overlap. A surface with no
// connected input is SKIPPED entirely (it contributes nothing).
//
// Because every surface DEFAULTS to UNIT_QUAD (full-frame), connecting any
// single input lights up the whole frame with that input — so driving ANY
// connected in_i changes the composite output (the behavioral-sweep
// invariant). Drag a surface's corners in to shrink/skew its footprint.
//
// showGrid: when on, each surface draws a NUMBERED calibration grid (a
// labelled checker with the surface index) warped into its quad INSTEAD of
// the input — the manual-alignment aid (line up the grid to the physical
// surface, then turn it off).
//
// ──────────────────────────────────────────────────────────────────────────
// GL FEEDBACK-LOOP RULE
// ──────────────────────────────────────────────────────────────────────────
// We NEVER bind our own composite FBO texture as an input/placeholder (that
// is a read+write-the-same-texture feedback loop, garbage on Chrome — see
// quadralogical.ts / mixer.ts). A 1×1 black sentinel covers the
// nothing-patched case for the sampler binding; an unpatched surface is
// simply not drawn.

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';
import {
  UNIT_QUAD,
  unitToQuad,
  invertHomography,
  toColumnMajor,
  type Vec2,
  type Quad,
} from '$lib/video/mappy-homography';

// ───────────────────────── constants ─────────────────────────

/** Number of MAPPY surfaces (= number of video inputs). */
export const MAPPY_SURFACE_COUNT = 6;

/** The video input port ids, in composite (painter) order. */
export const MAPPY_INPUT_IDS = ['in1', 'in2', 'in3', 'in4', 'in5', 'in6'] as const;

/** Per-surface outline / handle colours (in1..in6), used by the card overlay. */
export const MAPPY_SURFACE_COLORS = [
  '#ff5a5a', // in1 — red
  '#5aff7a', // in2 — green
  '#5a9bff', // in3 — blue
  '#ffd24a', // in4 — yellow
  '#c77dff', // in5 — purple
  '#4adfff', // in6 — cyan
] as const;

// ───────────────────────── pure state helpers ─────────────────────────

/** One MAPPY surface's persisted state: its quad's four corners in
 *  NORMALIZED [0,1] output space, corner order TL, TR, BR, BL. */
export interface MappySurfaceState {
  corners: [Vec2, Vec2, Vec2, Vec2];
}

/** A FRESH (full-frame) surface — its quad is the UNIT_QUAD, so the input
 *  fills the whole output frame un-warped. The default for every surface so a
 *  newly-connected input is immediately visible (and the behavioral sweep's
 *  drive-one-input-and-see-a-delta invariant holds). */
export function defaultSurface(): MappySurfaceState {
  return {
    corners: [
      [UNIT_QUAD[0][0], UNIT_QUAD[0][1]],
      [UNIT_QUAD[1][0], UNIT_QUAD[1][1]],
      [UNIT_QUAD[2][0], UNIT_QUAD[2][1]],
      [UNIT_QUAD[3][0], UNIT_QUAD[3][1]],
    ],
  };
}

/** The default surface array — MAPPY_SURFACE_COUNT full-frame surfaces. */
export function defaultSurfaces(): MappySurfaceState[] {
  return Array.from({ length: MAPPY_SURFACE_COUNT }, defaultSurface);
}

const clamp01 = (v: number): number =>
  !Number.isFinite(v) ? 0 : v < 0 ? 0 : v > 1 ? 1 : v;

/** Coerce arbitrary persisted/loose data into a valid Vec2 in [0,1]. */
function coerceCorner(c: unknown): Vec2 {
  if (Array.isArray(c) && c.length >= 2) {
    return [clamp01(Number(c[0])), clamp01(Number(c[1]))];
  }
  return [0, 0];
}

/**
 * Normalize a persisted `surfaces` value (which may be missing, short, long,
 * or partly malformed after a schema/hand-edit) into exactly
 * MAPPY_SURFACE_COUNT well-formed surfaces. Missing/invalid surfaces fall
 * back to the full-frame default; every corner is clamped to [0,1]. Pure so
 * the factory + the card + the unit test all agree on the canonical state.
 */
export function normalizeSurfaces(raw: unknown): MappySurfaceState[] {
  const arr = Array.isArray(raw) ? raw : [];
  const out: MappySurfaceState[] = [];
  for (let i = 0; i < MAPPY_SURFACE_COUNT; i++) {
    const s = arr[i] as { corners?: unknown } | undefined;
    const corners = Array.isArray(s?.corners) && s!.corners.length === 4
      ? ([
          coerceCorner(s!.corners[0]),
          coerceCorner(s!.corners[1]),
          coerceCorner(s!.corners[2]),
          coerceCorner(s!.corners[3]),
        ] as [Vec2, Vec2, Vec2, Vec2])
      : defaultSurface().corners;
    out.push({ corners });
  }
  return out;
}

/**
 * The COLUMN-MAJOR mat3 a surface's warp shader needs: the INVERSE of the
 * unit-square→quad homography. The shader maps an OUTPUT uv → SOURCE uv with
 * this matrix (so it can sample the input at the back-projected coordinate).
 *
 * A DEGENERATE quad (collinear / zero-area corners) has no invertible
 * homography — mappy-homography throws. The caller treats a throw as "skip
 * this surface" (a zero-area quad shows nothing anyway), so this returns
 * `null` rather than propagating, keeping draw() robust to a user dragging
 * all four corners onto a line.
 */
export function surfaceInverseColumnMajor(corners: Quad): number[] | null {
  try {
    return toColumnMajor(invertHomography(unitToQuad(corners)));
  } catch {
    return null;
  }
}

// ───────────────────────── shader ─────────────────────────
//
// WARP shader — draws ONE surface. The vertex stage is the engine's shared
// fullscreen quad; vUv is the OUTPUT uv in [0,1]. We back-project vUv through
// the inverse homography to the SOURCE uv and sample the input there. Outside
// the source's [0,1] footprint the fragment is transparent (alpha 0) so the
// composite blend leaves the under-layers untouched. When uShowGrid is on we
// synthesize a numbered calibration grid in SOURCE space instead of sampling
// the input.

const WARP_FRAG_SRC = `#version 300 es
precision highp float;

in vec2 vUv;            // OUTPUT uv in [0,1]
out vec4 outColor;

uniform sampler2D uTex; // this surface's input texture
uniform mat3 uInv;      // inverse homography: output uv -> source uv (homogeneous)
uniform float uShowGrid;// >0.5 → draw the numbered calibration grid, not the input
uniform float uIndex;   // surface index 0..5 (drives the grid tint)

const vec3 GRID_COLORS[6] = vec3[6](
  vec3(1.0, 0.35, 0.35),
  vec3(0.35, 1.0, 0.48),
  vec3(0.35, 0.61, 1.0),
  vec3(1.0, 0.82, 0.29),
  vec3(0.78, 0.49, 1.0),
  vec3(0.29, 0.87, 1.0)
);

// Back-project the output uv to source uv via the homogeneous inverse map.
vec2 sourceUv(vec2 uv) {
  vec3 p = uInv * vec3(uv, 1.0);
  return p.xy / p.z;
}

// A numbered calibration grid in [0,1] SOURCE space: an 8×8 checker, a bright
// border, centre cross-hairs, and a small filled "tally" pip block in the
// centre encoding the surface number (index+1 pips) so each surface reads
// distinctly when aligning. Deterministic — no time dependence.
vec4 calibrationGrid(vec2 s, float idx) {
  vec3 tint = GRID_COLORS[int(clamp(idx, 0.0, 5.0))];
  // 8×8 checker
  vec2 cell = floor(s * 8.0);
  float check = mod(cell.x + cell.y, 2.0);
  vec3 col = mix(vec3(0.06), tint * 0.7, check);
  // grid lines (every 1/8)
  vec2 g = abs(fract(s * 8.0) - 0.5);
  float lines = (min(g.x, g.y) > 0.46) ? 1.0 : 0.0;
  col = mix(col, vec3(0.95), lines * 0.6);
  // bright border
  float bw = 0.02;
  float border = (s.x < bw || s.x > 1.0 - bw || s.y < bw || s.y > 1.0 - bw) ? 1.0 : 0.0;
  col = mix(col, tint, border);
  // centre cross-hairs
  vec2 d = abs(s - 0.5);
  float cross = (min(d.x, d.y) < 0.004) ? 1.0 : 0.0;
  col = mix(col, vec3(1.0), cross);
  // tally pips for the surface number (idx+1), a horizontal run in the centre
  float n = idx + 1.0;
  float pipY = abs(s.y - 0.5);
  if (pipY < 0.03) {
    float px = (s.x - 0.5 + n * 0.05) / 0.1; // pips spaced 0.1, centred-ish
    float pipIdx = floor(px);
    float pipFrac = abs(fract(px) - 0.5);
    if (pipIdx >= 0.0 && pipIdx < n && pipFrac < 0.3) {
      col = vec3(1.0);
    }
  }
  return vec4(col, 1.0);
}

void main() {
  vec2 s = sourceUv(vUv);
  // Outside the source footprint → transparent (under-layers show through).
  if (s.x < 0.0 || s.x > 1.0 || s.y < 0.0 || s.y > 1.0) {
    outColor = vec4(0.0);
    return;
  }
  if (uShowGrid > 0.5) {
    outColor = calibrationGrid(s, uIndex);
    return;
  }
  vec4 c = texture(uTex, s);
  outColor = vec4(c.rgb, 1.0);
}`;

// ───────────────────────── params / defaults ─────────────────────────

interface MappyParams {
  // showGrid is stored as a 0/1 param so it threads through the param/CV
  // plumbing + persistence like every other numeric param, but it's surfaced
  // to the user as a toggle on the card (and ALSO mirrored to node.data.showGrid
  // so the card reads it the same way it reads surfaces).
  showGrid: number;
}

const DEFAULTS: MappyParams = {
  showGrid: 0,
};

export const mappyDef: VideoModuleDef = {
  type: 'mappy',
  palette: { top: 'Video modules', sub: 'Utilities' },
  domain: 'video',
  label: 'mappy',
  category: 'utilities',
  schemaVersion: 1,
  inputs: [
    { id: 'in1', type: 'video' },
    { id: 'in2', type: 'video' },
    { id: 'in3', type: 'video' },
    { id: 'in4', type: 'video' },
    { id: 'in5', type: 'video' },
    { id: 'in6', type: 'video' },
  ],
  outputs: [
    { id: 'out', type: 'video' }, // the composite (canonical surface)
  ],
  params: [
    // showGrid is a hidden 0/1 param (the card drives it as a toggle); kept in
    // the param list so it persists + has a default for the manifest.
    { id: 'showGrid', label: 'Grid', defaultValue: DEFAULTS.showGrid, min: 0, max: 1, curve: 'linear' },
  ],

  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;
    const program = ctx.compileFragment(WARP_FRAG_SRC);

    const u = {
      tex: gl.getUniformLocation(program, 'uTex'),
      inv: gl.getUniformLocation(program, 'uInv'),
      showGrid: gl.getUniformLocation(program, 'uShowGrid'),
      index: gl.getUniformLocation(program, 'uIndex'),
    };

    // The canonical composite surface (out port + on-card preview + VRT).
    const compositeFbo = ctx.createFbo();

    // 1×1 black sentinel for sampler bindings (the grid case has no texture).
    // NEVER bind our own compositeFbo texture (GL feedback loop).
    const emptyTex = gl.createTexture();
    if (!emptyTex) throw new Error('MAPPY: createTexture failed');
    gl.bindTexture(gl.TEXTURE_2D, emptyTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const rawParams = node.params as Record<string, unknown>;
    const params: MappyParams = {
      showGrid: typeof rawParams.showGrid === 'number' ? rawParams.showGrid : DEFAULTS.showGrid,
    };

    /** Live surface state, read every frame from node.data (so dragging a
     *  corner on the card — which writes node.data.surfaces — re-warps next
     *  frame). Falls back to the full-frame default for missing surfaces. */
    function readSurfaces(): MappySurfaceState[] {
      const data = node.data as { surfaces?: unknown } | undefined;
      return normalizeSurfaces(data?.surfaces);
    }
    /** showGrid is mirrored on node.data so the card toggle + the param agree;
     *  prefer node.data when present, else the param. */
    function gridOn(): boolean {
      const data = node.data as { showGrid?: unknown } | undefined;
      if (data && typeof data.showGrid === 'boolean') return data.showGrid;
      return params.showGrid >= 0.5;
    }

    const surface: VideoNodeSurface = {
      fbo: compositeFbo.fbo,
      texture: compositeFbo.texture,
      draw(frame) {
        const g = frame.gl;
        const surfaces = readSurfaces();
        const showGrid = gridOn();

        g.bindFramebuffer(g.FRAMEBUFFER, compositeFbo.fbo);
        g.viewport(0, 0, ctx.res.width, ctx.res.height);
        // Clear to opaque black — the projector floor.
        g.clearColor(0, 0, 0, 1);
        g.clear(g.COLOR_BUFFER_BIT);

        g.useProgram(program);

        // Painter's order OVER blend so later surfaces paint over earlier ones
        // where they overlap. (Within one surface every drawn texel is alpha 1
        // and outside-footprint texels are alpha 0, so OVER == replace-inside.)
        const prevBlend = g.isEnabled(g.BLEND);
        g.enable(g.BLEND);
        g.blendFunc(g.SRC_ALPHA, g.ONE_MINUS_SRC_ALPHA);

        for (let i = 0; i < MAPPY_SURFACE_COUNT; i++) {
          const inputTex = frame.getInputTexture(node.id, MAPPY_INPUT_IDS[i]);
          // Skip a surface with no connected input (unless drawing the grid,
          // which is synthesized and needs no input). An unconnected input in
          // grid mode is also skipped — the grid is an ALIGNMENT aid for the
          // connected surfaces, so it tracks the same connected set.
          if (!inputTex) continue;

          const inv = surfaceInverseColumnMajor(surfaces[i]!.corners);
          if (!inv) continue; // degenerate quad → nothing to draw

          g.activeTexture(g.TEXTURE0);
          g.bindTexture(g.TEXTURE_2D, showGrid ? emptyTex : inputTex);
          g.uniform1i(u.tex, 0);
          g.uniformMatrix3fv(u.inv, false, new Float32Array(inv));
          g.uniform1f(u.showGrid, showGrid ? 1.0 : 0.0);
          g.uniform1f(u.index, i);
          ctx.drawFullscreenQuad();
        }

        if (!prevBlend) g.disable(g.BLEND);
        g.bindFramebuffer(g.FRAMEBUFFER, null);
        g.activeTexture(g.TEXTURE0);
      },
      dispose() {
        gl.deleteFramebuffer(compositeFbo.fbo);
        gl.deleteTexture(compositeFbo.texture);
        gl.deleteTexture(emptyTex);
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
        if (key === 'outputTexture:out') return compositeFbo.texture;
        return undefined;
      },
      dispose() { surface.dispose(); },
    };
  },
};
