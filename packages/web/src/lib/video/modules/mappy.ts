// packages/web/src/lib/video/modules/mappy.ts
//
// MAPPY — a multi-surface MANUAL projection mapper (v1 MVP).
//
// ──────────────────────────────────────────────────────────────────────────
// WHAT IT DOES
// ──────────────────────────────────────────────────────────────────────────
// MAPPY hosts up to SIX surfaces. Each surface owns its own draggable QUAD in
// the output frame; surface i is fed by input in(i+1). The surfaces are
// composited (painter's order, OVER) into ONE output → a projector. Use cases:
//   * 1 surface  → DE-SKEW an awkwardly-angled projection (drag the four
//     corners to match the physical screen).
//   * up to 6    → map each face of a white cube to its own video feed (only
//     ~3-4 faces are visible at once from any one projector angle).
//
// GRIDS-FIRST WORKFLOW. A fresh MAPPY shows ONE surface, and a live surface
// with NO input connected renders its NUMBERED CALIBRATION GRID — so with
// nothing patched the output is the grid(s), and you set the geometry up on the
// physical faces FIRST (drag corners, +/− surfaceCount up to 6), THEN connect
// video. The instant inN is connected, that surface swaps grid→warped video in
// the quad you already mapped. surfaceCount governs how many surfaces are live;
// connecting inN auto-activates surface N even beyond the count.
//
// This is the MANUAL mapper: you drag the corners by hand (on the card or in
// the full-window MAP editor). The camera-assisted AUTO-align (point a camera
// at the projection, solve the homography from detected features) is a LATER
// phase — there is NO camera input and NO CV here, by design.
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
 *  NORMALIZED [0,1] output space, corner order TL, TR, BR, BL.
 *
 *  `fit` is the per-surface FIT toggle (default true, OPTIONAL so older
 *  persisted patches that predate the toggle still load — a missing `fit`
 *  reads as ON via `surfaceFitOn`):
 *    • FIT ON  (zoom-fit, the original behaviour): the homography maps the
 *      FULL source [0,1]² into the quad — the whole frame is squeezed/stretched
 *      to fill the dragged box.
 *    • FIT OFF (crop/window, NATIVE scale): the quad becomes a WINDOW onto the
 *      source placed 1:1 in output space — moving the box pans across the
 *      natively-positioned source, resizing the box crops more/less. The
 *      homography is still used for the MASK (which output texels belong to the
 *      quad), but the SAMPLE coordinate is the texel's own output uv. See
 *      `surfaceFitOn` + the WARP shader's `uFit` branch. */
export interface MappySurfaceState {
  corners: [Vec2, Vec2, Vec2, Vec2];
  fit?: boolean;
}

/** Whether a surface is in FIT (zoom-fit) mode — the default. A persisted
 *  surface that predates the toggle has no `fit` field; treat that as ON so
 *  loading an old patch keeps today's zoom-fit behaviour. Shared by the factory,
 *  the card, and the editor so all three agree on the default. */
export function surfaceFitOn(s: { fit?: unknown } | undefined): boolean {
  if (!s) return true;
  return s.fit === undefined ? true : s.fit !== false;
}

/** A FRESH (full-frame) surface — its quad is the UNIT_QUAD, so the input
 *  fills the whole output frame un-warped. The default for every surface so a
 *  newly-connected input is immediately visible (and the behavioral sweep's
 *  drive-one-input-and-see-a-delta invariant holds). FIT defaults ON. */
export function defaultSurface(): MappySurfaceState {
  return {
    corners: [
      [UNIT_QUAD[0][0], UNIT_QUAD[0][1]],
      [UNIT_QUAD[1][0], UNIT_QUAD[1][1]],
      [UNIT_QUAD[2][0], UNIT_QUAD[2][1]],
      [UNIT_QUAD[3][0], UNIT_QUAD[3][1]],
    ],
    fit: true,
  };
}

/** The default surface array — MAPPY_SURFACE_COUNT full-frame surfaces. */
export function defaultSurfaces(): MappySurfaceState[] {
  return Array.from({ length: MAPPY_SURFACE_COUNT }, defaultSurface);
}

/** Minimum number of live surfaces (you always have at least one grid). */
export const MAPPY_MIN_SURFACES = 1;
/** A fresh MAPPY starts with ONE live surface (one grid you set up first). */
export const DEFAULT_SURFACE_COUNT = 1;

/**
 * The quad a NEWLY-ADDED surface drops in as — a staggered inset rectangle so
 * each added grid is an obviously-distinct, fully-on-screen object you can grab
 * and drag onto a physical face (rather than perfectly overlapping the others).
 * `index` is the 0-based surface number; surfaces cascade down-right and wrap.
 * Always inset within [0,1] so every corner handle is reachable.
 */
export function insetQuadForIndex(index: number): [Vec2, Vec2, Vec2, Vec2] {
  const w = 0.34;
  const h = 0.34;
  const step = 0.1;
  const slot = index % 4;
  const x = 0.08 + slot * step;
  const y = 0.08 + slot * step;
  // clamp the origin so the inset box stays fully inside [0,1]
  const ox = Math.min(x, 1 - w - 0.02);
  const oy = Math.min(y, 1 - h - 0.02);
  return [
    [ox, oy],
    [ox + w, oy],
    [ox + w, oy + h],
    [ox, oy + h],
  ];
}

/** Coerce a persisted/loose surface-count into [MAPPY_MIN_SURFACES, COUNT]. */
export function clampSurfaceCount(raw: unknown): number {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return DEFAULT_SURFACE_COUNT;
  return Math.max(MAPPY_MIN_SURFACES, Math.min(MAPPY_SURFACE_COUNT, n));
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
    const s = arr[i] as { corners?: unknown; fit?: unknown } | undefined;
    const corners = Array.isArray(s?.corners) && s!.corners.length === 4
      ? ([
          coerceCorner(s!.corners[0]),
          coerceCorner(s!.corners[1]),
          coerceCorner(s!.corners[2]),
          coerceCorner(s!.corners[3]),
        ] as [Vec2, Vec2, Vec2, Vec2])
      : defaultSurface().corners;
    // Preserve the per-surface FIT toggle; a missing/old value reads as ON
    // (surfaceFitOn), so a pre-toggle persisted patch keeps zoom-fit.
    out.push({ corners, fit: surfaceFitOn(s) });
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
// the inverse homography to the SOURCE uv (`s`). `s` always serves as the
// surface MASK: a texel is part of the quad's footprint iff `s` lands inside
// [0,1] (else transparent so under-layers show through).
//
// FIT (uFit, a per-surface uniform — NOT a new pass/texture/readback):
//   • uFit > 0.5 (ON, default): ZOOM-FIT. We sample the input at `s`, so the
//     full source [0,1]² is squeezed into the quad (the original behaviour).
//   • uFit ≤ 0.5 (OFF): CROP / WINDOW at NATIVE scale. We sample at the texel's
//     OWN output uv (vUv) instead — the source is pinned 1:1 into output space,
//     and the quad merely reveals the part of it that falls under the box. So
//     MOVING the box pans across the natively-placed source; RESIZING crops more
//     or less. The mask still comes from `s`, so the visible region is exactly
//     the quad's shape. (We lerp the sample coord by uFit so it stays a single
//     branchless mix — see main().)
//
// When uShowGrid is on we synthesize a numbered calibration grid in SOURCE space
// (`s`) instead of sampling the input, regardless of FIT — the grid is the
// surface's footprint guide, which is the homography-mapped quad either way.

const WARP_FRAG_SRC = `#version 300 es
precision highp float;

in vec2 vUv;            // OUTPUT uv in [0,1]
out vec4 outColor;

uniform sampler2D uTex; // this surface's input texture
uniform mat3 uInv;      // inverse homography: output uv -> source uv (homogeneous)
uniform float uShowGrid;// >0.5 → draw the numbered calibration grid, not the input
uniform float uIndex;   // surface index 0..5 (drives the grid tint)
uniform float uFit;     // 1 = zoom-fit (sample at back-projected source uv);
                        // 0 = crop/window (sample at native output uv vUv)

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

// Distance from point p to the segment a→b (for the 7-segment digit glyph).
float segDist(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}

// Which of the 7 segments (bits a=1,b=2,c=4,d=8,e=16,f=32,g=64) are lit for a
// single decimal digit 1..6 (the only surface numbers MAPPY can show).
int segMask(int d) {
  if (d == 1) return 6;    // b c
  if (d == 2) return 91;   // a b d e g
  if (d == 3) return 79;   // a b c d g
  if (d == 4) return 102;  // b c f g
  if (d == 5) return 109;  // a c d f g
  return 125;              // 6: a c d e f g
}

// Coverage (0..1) of a 7-segment digit d drawn in local box space p in [0,1]^2
// (x right, y down). Used to label each calibration grid with the number of the
// input that will feed that surface. Deterministic.
float digitCoverage(vec2 p, int d) {
  int m = segMask(d);
  float th = 0.085;   // segment half-thickness
  float aa = 0.02;    // antialias width
  float cov = 0.0;
  // seven segment endpoints in the [0,1] box
  if ((m & 1) != 0)  cov = max(cov, 1.0 - smoothstep(th - aa, th + aa, segDist(p, vec2(0.18, 0.06), vec2(0.82, 0.06)))); // a top
  if ((m & 2) != 0)  cov = max(cov, 1.0 - smoothstep(th - aa, th + aa, segDist(p, vec2(0.82, 0.06), vec2(0.82, 0.50)))); // b top-right
  if ((m & 4) != 0)  cov = max(cov, 1.0 - smoothstep(th - aa, th + aa, segDist(p, vec2(0.82, 0.50), vec2(0.82, 0.94)))); // c bottom-right
  if ((m & 8) != 0)  cov = max(cov, 1.0 - smoothstep(th - aa, th + aa, segDist(p, vec2(0.18, 0.94), vec2(0.82, 0.94)))); // d bottom
  if ((m & 16) != 0) cov = max(cov, 1.0 - smoothstep(th - aa, th + aa, segDist(p, vec2(0.18, 0.50), vec2(0.18, 0.94)))); // e bottom-left
  if ((m & 32) != 0) cov = max(cov, 1.0 - smoothstep(th - aa, th + aa, segDist(p, vec2(0.18, 0.06), vec2(0.18, 0.50)))); // f top-left
  if ((m & 64) != 0) cov = max(cov, 1.0 - smoothstep(th - aa, th + aa, segDist(p, vec2(0.18, 0.50), vec2(0.82, 0.50)))); // g middle
  return cov;
}

// A numbered calibration grid in [0,1] SOURCE space: an 8×8 checker, a bright
// border, centre cross-hairs, and a big readable 7-segment DIGIT (index+1) in
// the centre naming the input that will feed this surface, so each surface reads
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
  // BIG readable digit (idx+1) naming the input that will feed this surface,
  // over a dark backing plate so it reads against any checker tint.
  int num = int(idx + 1.5); // 0..5 → 1..6
  vec2 boxHalf = vec2(0.17, 0.27);
  // Source v is y-UP (vUv = aPos*0.5+0.5 → v=1 at the canvas top), but the 7-seg
  // glyph is authored y-DOWN (segment a = top at small p.y). Flip v for the box
  // so the digit reads upright on screen (matches the upright sampled video).
  vec2 p = (vec2(s.x, 1.0 - s.y) - (vec2(0.5) - boxHalf)) / (2.0 * boxHalf);
  if (p.x >= 0.0 && p.x <= 1.0 && p.y >= 0.0 && p.y <= 1.0) {
    col = mix(col, vec3(0.03), 0.8);
    float dc = digitCoverage(p, num);
    col = mix(col, vec3(1.0), dc);
  }
  return vec4(col, 1.0);
}

void main() {
  // s is the back-projected SOURCE uv — ALWAYS the surface mask (the quad
  // footprint), whatever FIT mode we are in.
  vec2 s = sourceUv(vUv);
  // Outside the source footprint -> transparent (under-layers show through).
  if (s.x < 0.0 || s.x > 1.0 || s.y < 0.0 || s.y > 1.0) {
    outColor = vec4(0.0);
    return;
  }
  if (uShowGrid > 0.5) {
    outColor = calibrationGrid(s, uIndex);
    return;
  }
  // FIT chooses the SAMPLE coordinate (the mask is unchanged):
  //   uFit=1 -> sample at s    (zoom-fit: full source squeezed into the quad)
  //   uFit=0 -> sample at vUv  (crop: source pinned 1:1 in output space; the
  //            box is a moveable/resizable window onto it)
  // A single mix keeps it branchless — zero extra cost over the original.
  vec2 sampleUv = mix(vUv, s, uFit);
  vec4 c = texture(uTex, sampleUv);
  outColor = vec4(c.rgb, 1.0);
}`;

// ───────────────────────── params / defaults ─────────────────────────

interface MappyParams {
  // showGrid is stored as a 0/1 param so it threads through the param/CV
  // plumbing + persistence like every other numeric param, but it's surfaced
  // to the user as a toggle on the card (and ALSO mirrored to node.data.showGrid
  // so the card reads it the same way it reads surfaces).
  showGrid: number;
  // surfaceCount is the number of LIVE surfaces (1..6) — the +/− on the card. A
  // live surface ALWAYS renders: its calibration grid when no input is patched
  // (set up the geometry first), or the warped video once inN is connected. A
  // surface beyond the count still auto-activates the moment its input is
  // connected, so patching inN can never go to a dead surface.
  surfaceCount: number;
}

const DEFAULTS: MappyParams = {
  showGrid: 0,
  surfaceCount: DEFAULT_SURFACE_COUNT,
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
    // surfaceCount (1..6) — the +/− on the card; persisted like any param.
    { id: 'surfaceCount', label: 'Surfaces', defaultValue: DEFAULTS.surfaceCount, min: MAPPY_MIN_SURFACES, max: MAPPY_SURFACE_COUNT, curve: 'linear' },
  ],

  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;
    const program = ctx.compileFragment(WARP_FRAG_SRC);

    const u = {
      tex: gl.getUniformLocation(program, 'uTex'),
      inv: gl.getUniformLocation(program, 'uInv'),
      showGrid: gl.getUniformLocation(program, 'uShowGrid'),
      index: gl.getUniformLocation(program, 'uIndex'),
      fit: gl.getUniformLocation(program, 'uFit'),
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
      surfaceCount: typeof rawParams.surfaceCount === 'number'
        ? clampSurfaceCount(rawParams.surfaceCount)
        : DEFAULTS.surfaceCount,
    };

    /** Live surface state, read every frame from node.data (so dragging a
     *  corner on the card — which writes node.data.surfaces — re-warps next
     *  frame). Falls back to the full-frame default for missing surfaces. */
    function readSurfaces(): MappySurfaceState[] {
      const data = node.data as { surfaces?: unknown } | undefined;
      return normalizeSurfaces(data?.surfaces);
    }
    /** showGrid is mirrored on node.data so the card toggle + the param agree;
     *  prefer node.data when present, else the param. When ON it FORCES the grid
     *  on every live surface (a re-alignment override). */
    function gridOn(): boolean {
      const data = node.data as { showGrid?: unknown } | undefined;
      if (data && typeof data.showGrid === 'boolean') return data.showGrid;
      return params.showGrid >= 0.5;
    }
    /** Number of live surfaces (1..6) — node.data.surfaceCount wins, else param. */
    function surfaceCount(): number {
      const data = node.data as { surfaceCount?: unknown } | undefined;
      if (data && typeof data.surfaceCount === 'number') return clampSurfaceCount(data.surfaceCount);
      return clampSurfaceCount(params.surfaceCount);
    }

    const surface: VideoNodeSurface = {
      fbo: compositeFbo.fbo,
      texture: compositeFbo.texture,
      draw(frame) {
        const g = frame.gl;
        const surfaces = readSurfaces();
        const forceGrid = gridOn();
        const count = surfaceCount();

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
          // A surface is LIVE if it's within the surface count (set up its grid
          // first) OR its input is connected (auto-activate on patch). Surfaces
          // beyond the count with no input are skipped.
          const live = i < count || !!inputTex;
          if (!live) continue;

          const inv = surfaceInverseColumnMajor(surfaces[i]!.corners);
          if (!inv) continue; // degenerate quad → nothing to draw

          // GRIDS-FIRST: draw the numbered calibration grid when there's no
          // input yet (set up the geometry on the physical surface), or when the
          // GRID override forces it. Once inN is connected, the warped video
          // fills the quad you already mapped.
          const drawGrid = forceGrid || !inputTex;

          // Per-surface FIT (a cheap uniform — no extra pass/texture/readback):
          // 1 = zoom-fit (default), 0 = crop/window. The grid case forces FIT on
          // so the calibration grid always fills the quad (it has no native
          // source to pan/crop).
          const fitOn = drawGrid ? true : surfaceFitOn(surfaces[i]);

          g.activeTexture(g.TEXTURE0);
          g.bindTexture(g.TEXTURE_2D, drawGrid ? emptyTex : inputTex);
          g.uniform1i(u.tex, 0);
          g.uniformMatrix3fv(u.inv, false, new Float32Array(inv));
          g.uniform1f(u.showGrid, drawGrid ? 1.0 : 0.0);
          g.uniform1f(u.index, i);
          g.uniform1f(u.fit, fitOn ? 1.0 : 0.0);
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
