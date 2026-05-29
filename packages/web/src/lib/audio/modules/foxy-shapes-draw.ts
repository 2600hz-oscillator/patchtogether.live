// packages/web/src/lib/audio/modules/foxy-shapes-draw.ts
//
// FOXY 3dShapeGen — vaporwave on-card visualization.
//
// Renders the Shape[] list inside a wireframe bounding box with a SLOW
// y-axis rotation (~6 RPM, per the spec). All CPU-side — no GL — so the
// renderer matches the existing foxy-draw.ts style + can run inside the
// audio engine's drawFrame callback without a GL context.
//
// Aesthetic targets (per the user's vaporwave reference):
//   • dark purple/midnight backdrop (gives the candy fills their pop)
//   • magenta-cyan-violet wireframe box (the perspective cage)
//   • discrete primitives drawn as candy-bright HSL radial gradients,
//     hue picked from Shape.hue, saturation high, lightness scaled by
//     post-rotation Z (front of scene → brighter)
//   • a faint perspective floor grid under the shapes for depth cue
//   • subtle slow rotation so the 3D nature reads even when nothing changes
//
// Rendering is intentionally CHEAP: a back-to-front painter's algorithm
// (sort shapes by post-rotation Z) then a 2D ellipse-or-disc per shape.
// Cube/cone/cylinder/ring/tetraFrame all stylize to a SILHOUETTE — a single
// 2D primitive whose aspect ratio + outline reads as the underlying type.
// That keeps the per-frame cost at O(shapes), and is enough fidelity for a
// small card preview window.

import type { Shape, FoxyShapeType } from './foxy-shapes';

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const BG_TOP = '#0c0419';
const BG_BOT = '#1a0529';

/** Wireframe box edge colors — cycle the three vaporwave anchors. */
const BOX_EDGE_COLORS = ['#ff5cf2', '#5cf2ff', '#a05cff'] as const;

/** Slow Y-axis rotation rate in radians/ms. 6 RPM = 2π / 10s = 0.000628 rad/ms. */
const ROTATION_RATE = (2 * Math.PI) / 10_000;

/** Perspective focal length (in "box units"). 2.5 is a comfortable
 *  not-too-fish-eye projection that still shows clear depth. */
const FOCAL = 2.5;
/** Camera distance from box center along +Z. */
const CAMERA_Z = 3.0;

/**
 * Project a 3D point in box space (∈ [-1,1]³) into 2D canvas coords.
 * Returns the projected (x, y) + the post-projection Z (used for sorting
 * + the size scale) + a `scale` factor for radius projection.
 */
function project(
  px: number,
  py: number,
  pz: number,
  rotY: number,
  cx: number,
  cy: number,
  boxPx: number,
): { x: number; y: number; z: number; scale: number } {
  // Y-axis rotation: (x, z) → (x*cos + z*sin, -x*sin + z*cos).
  const cosR = Math.cos(rotY);
  const sinR = Math.sin(rotY);
  const rx = px * cosR + pz * sinR;
  const ry = py;
  const rz = -px * sinR + pz * cosR;
  // Perspective: scale = focal / (camera - rz).
  // rz ∈ [-1, 1] → (CAMERA_Z - rz) ∈ [CAMERA_Z - 1, CAMERA_Z + 1] = [2, 4].
  const denom = CAMERA_Z - rz;
  const scale = FOCAL / denom;
  const x = cx + rx * scale * boxPx * 0.5;
  // Canvas Y is down — flip so positive y goes UP visually.
  const y = cy - ry * scale * boxPx * 0.5;
  return { x, y, z: rz, scale };
}

/**
 * Draw the 12 edges of the unit cube (the wireframe bounding box).
 */
function drawWireBox(
  ctx: Ctx2D,
  rotY: number,
  cx: number,
  cy: number,
  boxPx: number,
): void {
  // 8 corners of [-1, 1]³.
  const corners: [number, number, number][] = [
    [-1, -1, -1], [+1, -1, -1], [+1, +1, -1], [-1, +1, -1],
    [-1, -1, +1], [+1, -1, +1], [+1, +1, +1], [-1, +1, +1],
  ];
  const proj = corners.map((c) => project(c[0], c[1], c[2], rotY, cx, cy, boxPx));
  // 12 edges: 4 bottom + 4 top + 4 verticals.
  const edges: [number, number][] = [
    [0, 1], [1, 2], [2, 3], [3, 0],
    [4, 5], [5, 6], [6, 7], [7, 4],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];
  ctx.lineWidth = 1;
  for (let i = 0; i < edges.length; i++) {
    const [a, b] = edges[i]!;
    ctx.strokeStyle = BOX_EDGE_COLORS[i % BOX_EDGE_COLORS.length]!;
    ctx.globalAlpha = 0.55;
    ctx.beginPath();
    ctx.moveTo(proj[a]!.x, proj[a]!.y);
    ctx.lineTo(proj[b]!.x, proj[b]!.y);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

/**
 * Faint perspective floor grid (y = -1 plane). Adds depth cue, reads as
 * the vaporwave "checker floor" without being too busy.
 */
function drawFloorGrid(
  ctx: Ctx2D,
  rotY: number,
  cx: number,
  cy: number,
  boxPx: number,
): void {
  const N = 6;
  ctx.strokeStyle = 'rgba(140, 90, 220, 0.18)';
  ctx.lineWidth = 0.5;
  // Lines parallel to Z (vertical from the camera POV).
  for (let i = 0; i <= N; i++) {
    const t = (i / N) * 2 - 1;
    const p0 = project(t, -1, -1, rotY, cx, cy, boxPx);
    const p1 = project(t, -1, +1, rotY, cx, cy, boxPx);
    ctx.beginPath();
    ctx.moveTo(p0.x, p0.y);
    ctx.lineTo(p1.x, p1.y);
    ctx.stroke();
  }
  // Lines parallel to X (horizontal from the camera POV).
  for (let i = 0; i <= N; i++) {
    const t = (i / N) * 2 - 1;
    const p0 = project(-1, -1, t, rotY, cx, cy, boxPx);
    const p1 = project(+1, -1, t, rotY, cx, cy, boxPx);
    ctx.beginPath();
    ctx.moveTo(p0.x, p0.y);
    ctx.lineTo(p1.x, p1.y);
    ctx.stroke();
  }
}

/** Build an HSL radial-gradient fill for a shape silhouette. The hue
 *  comes from shape.hue; lightness scales with the projected-Z (front of
 *  scene = brighter — candy-bright per spec). */
function shapeFill(
  ctx: Ctx2D,
  shape: Shape,
  x: number,
  y: number,
  rPx: number,
  projZ: number,
): CanvasGradient {
  const hueDeg = (shape.hue * 360) % 360;
  const front = (projZ + 1) * 0.5; // ∈ [0, 1]; +z = back, -z = front
  const lightMid = 70 - front * 25;     // front shapes are brighter
  const lightEdge = 35 - front * 15;
  const inner = `hsl(${hueDeg}, 90%, ${lightMid}%)`;
  const outer = `hsl(${(hueDeg + 30) % 360}, 80%, ${lightEdge}%)`;
  const grad = ctx.createRadialGradient(x - rPx * 0.25, y - rPx * 0.25, rPx * 0.1, x, y, rPx);
  grad.addColorStop(0, inner);
  grad.addColorStop(1, outer);
  return grad;
}

/**
 * Draw a single shape's 2D silhouette. The silhouette PER TYPE is the
 * recognizable iconic shape:
 *   sphere     → filled disc
 *   cube       → filled square (slight rotate w/ box rotY)
 *   cone       → filled triangle (apex up)
 *   cylinder   → filled rounded rectangle (tall pill)
 *   ring       → stroked annulus (donut)
 *   tetraFrame → stroked triangle (frame, no fill — frame look)
 *
 * Drawn at the projected XY with size ∝ shape.radius × projection scale.
 */
function drawShape(
  ctx: Ctx2D,
  shape: Shape,
  x: number,
  y: number,
  rPx: number,
  projZ: number,
): void {
  // Front-of-scene shapes get a stronger alpha — back ones recede.
  const front = (projZ + 1) * 0.5;
  const alpha = 0.95 - front * 0.25;
  ctx.globalAlpha = Math.max(0.4, Math.min(1, alpha));

  switch (shape.type) {
    case 'sphere': {
      ctx.fillStyle = shapeFill(ctx, shape, x, y, rPx, projZ);
      ctx.beginPath();
      ctx.arc(x, y, rPx, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    case 'cube': {
      ctx.fillStyle = shapeFill(ctx, shape, x, y, rPx, projZ);
      ctx.beginPath();
      ctx.rect(x - rPx, y - rPx, rPx * 2, rPx * 2);
      ctx.fill();
      // Cube outline so it reads as a face.
      ctx.strokeStyle = `hsla(${(shape.hue * 360) % 360}, 95%, 80%, 0.9)`;
      ctx.lineWidth = 1;
      ctx.stroke();
      return;
    }
    case 'cone': {
      ctx.fillStyle = shapeFill(ctx, shape, x, y, rPx, projZ);
      ctx.beginPath();
      ctx.moveTo(x, y - rPx);              // apex up
      ctx.lineTo(x + rPx, y + rPx);        // base right
      ctx.lineTo(x - rPx, y + rPx);        // base left
      ctx.closePath();
      ctx.fill();
      return;
    }
    case 'cylinder': {
      ctx.fillStyle = shapeFill(ctx, shape, x, y, rPx, projZ);
      const halfW = rPx * 0.7;
      const halfH = rPx;
      // Rounded-rectangle pill — capsule body.
      ctx.beginPath();
      ctx.moveTo(x - halfW, y - halfH + halfW);
      ctx.arc(x, y - halfH + halfW, halfW, Math.PI, 0, false);
      ctx.lineTo(x + halfW, y + halfH - halfW);
      ctx.arc(x, y + halfH - halfW, halfW, 0, Math.PI, false);
      ctx.closePath();
      ctx.fill();
      return;
    }
    case 'ring': {
      // Donut: stroked annulus.
      const hueDeg = (shape.hue * 360) % 360;
      const front2 = (projZ + 1) * 0.5;
      ctx.strokeStyle = `hsl(${hueDeg}, 95%, ${70 - front2 * 20}%)`;
      ctx.lineWidth = Math.max(2, rPx * 0.35);
      ctx.beginPath();
      ctx.arc(x, y, rPx * 0.7, 0, Math.PI * 2);
      ctx.stroke();
      return;
    }
    case 'tetraFrame': {
      // Frame triangle — stroke only, no fill, matches the SDF's
      // hollow-shell character.
      const hueDeg = (shape.hue * 360) % 360;
      const front3 = (projZ + 1) * 0.5;
      ctx.strokeStyle = `hsl(${hueDeg}, 95%, ${75 - front3 * 20}%)`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, y - rPx);
      ctx.lineTo(x + rPx, y + rPx);
      ctx.lineTo(x - rPx, y + rPx);
      ctx.closePath();
      ctx.stroke();
      // Inner cross-bracing line so it reads as a wireframe tet.
      ctx.beginPath();
      ctx.moveTo(x, y - rPx);
      ctx.lineTo(x, y + rPx);
      ctx.stroke();
      return;
    }
  }
  // Exhaustiveness check.
  const _exhaustive: never = shape.type;
  void _exhaustive;
}

/** Options that the card can pass to control the renderer (currently
 *  just a manual `nowMs` override for deterministic VRT runs). */
export interface FoxyShapesDrawOptions {
  /** Override the rotation clock. If set, rotation phase = nowMs *
   *  ROTATION_RATE. If omitted, the renderer uses performance.now(). */
  nowMs?: number;
}

/**
 * Top-level draw entry: paint the vaporwave 3D-shapes-in-a-box scene.
 *
 * Steps:
 *   1. background gradient + faint floor grid
 *   2. wireframe bounding box
 *   3. sort shapes by post-rotation Z (back → front) and paint each
 *
 * Empty shape list still paints the box + floor — so the user sees the
 * empty stage rather than a blank panel.
 */
export function drawFoxyShapes(
  ctx: Ctx2D,
  shapes: readonly Shape[],
  w: number,
  h: number,
  opts: FoxyShapesDrawOptions = {},
): void {
  // 1. background — vertical gradient (top = midnight purple, bot = navy).
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, BG_TOP);
  grad.addColorStop(1, BG_BOT);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  // Rotation phase.
  const nowMs = opts.nowMs ?? (typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now());
  const rotY = nowMs * ROTATION_RATE;

  // The box occupies a centered square of ~80% of the min dimension.
  const cx = w / 2;
  const cy = h / 2;
  const boxPx = Math.min(w, h) * 0.8;

  // 2. floor grid (behind the wireframe box so the box stays on top).
  drawFloorGrid(ctx, rotY, cx, cy, boxPx);

  // 3. wireframe bounding box.
  drawWireBox(ctx, rotY, cx, cy, boxPx);

  // 4. project + sort + paint shapes back-to-front.
  interface DrawableShape { shape: Shape; sx: number; sy: number; rPx: number; projZ: number }
  const drawables: DrawableShape[] = [];
  for (const sh of shapes) {
    const p = project(sh.pos.x, sh.pos.y, sh.pos.z, rotY, cx, cy, boxPx);
    const rPx = sh.radius * p.scale * boxPx * 0.5;
    drawables.push({ shape: sh, sx: p.x, sy: p.y, rPx, projZ: p.z });
  }
  // Sort: smaller z (further from camera since -z direction is "into screen"
  // after rotation — but we project with (CAMERA_Z - rz) so SMALLER rz = closer
  // to camera). To paint back-to-front we draw LARGER rz first (deeper into
  // the scene), then smaller rz on top.
  drawables.sort((a, b) => b.projZ - a.projZ);
  for (const d of drawables) {
    drawShape(ctx, d.shape, d.sx, d.sy, d.rPx, d.projZ);
  }
  ctx.globalAlpha = 1;
}

/** Tiny utility — exported so the card can pre-resolve the active type
 *  ordering when computing color cycles or legend rows. */
export function foxyShapeTypeLabels(): readonly FoxyShapeType[] {
  return ['sphere', 'cube', 'cone', 'cylinder', 'ring', 'tetraFrame'];
}
