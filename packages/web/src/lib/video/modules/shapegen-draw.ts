// packages/web/src/lib/video/modules/shapegen-draw.ts
//
// SHAPEGEN — on-canvas vaporwave renderer (extracted from FOXY's
// `foxy-shapes-draw.ts`). Same wireframe-vaporwave look as before plus a
// new SOLIDS mode that renders per-primitive lit canvas2D shapes. Both
// modes paint the wireframe bounding box + floor grid so the spatial
// reference reads the same in either rendering.
//
// FOXY's COMBINED video path calls the same `drawShapesScene` (via the
// foxy-shapes-draw.ts re-export shim, default mode = wireframe + auto-
// rotation enabled), so the FOXY visual is byte-identical to before.
//
// Aesthetic targets (per the original FOXY vaporwave reference):
//   • dark purple/midnight backdrop
//   • magenta-cyan-violet wireframe box (the perspective cage)
//   • discrete primitives drawn as candy-bright HSL radial gradients (wireframe mode)
//   • a faint perspective floor grid under the shapes for depth cue
//
// SOLIDS mode (PR #SHAPEGEN, extended in solids-all-primitives PR):
//   • sphere     → filled disc with radial gradient (light spot up-and-left)
//   • cube       → 3 visible faces (top/front/right) in axonometric projection
//   • cylinder   → top ellipse + body horizontal-gradient rect + bottom ellipse
//   • cone       → triangular silhouette with vertical gradient + base ellipse
//   • ring       → filled torus: HSL-radial-gradient disc with the hole
//                  punched via `destination-out`, then an inner-rim darken
//                  band to give the torus 3D thickness.
//   • tetraFrame → 4-face lit tetrahedron. Vertices rotate with the camera
//                  Y rotation (matched against the `rotation` opt), faces
//                  are sorted painter's-algorithm back-to-front, and each
//                  face's brightness is a Lambert term n·L against the
//                  documented light direction. Hue from `shape.hue`.
//
// All canvas2D — no GL. The visuals read as "shaded 3D primitives floating
// in a box" vs the existing "wireframe gradient blobs". The wireframe box
// itself stays in both modes (gives spatial reference).

import type { Shape, FoxyShapeType } from './shapegen-math';

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const BG_TOP = '#0c0419';
const BG_BOT = '#1a0529';

/** Wireframe box edge colors — cycle the three vaporwave anchors. */
const BOX_EDGE_COLORS = ['#ff5cf2', '#5cf2ff', '#a05cff'] as const;

/** FOXY's auto-rotation rate: 6 RPM = 2π / 10s = 0.000628 rad/ms.
 *  SHAPEGEN overrides this with a user-controlled rotation knob. */
const ROTATION_RATE = (2 * Math.PI) / 10_000;

/** Perspective focal length (in "box units"). */
const FOCAL = 2.5;
/** Camera distance from box center along +Z. */
const CAMERA_Z = 3.0;

/** Documented light position for SOLIDS mode (normalized scene coords:
 *  0,0 = top-left of the box face). Used by the lit primitives so the
 *  highlight + shadow direction is consistent across shapes. */
export const SOLIDS_LIGHT_POSITION = { x: 0.3, y: 0.25 } as const;

/**
 * Project a 3D point in box space (∈ [-1,1]³) into 2D canvas coords.
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
  const cosR = Math.cos(rotY);
  const sinR = Math.sin(rotY);
  const rx = px * cosR + pz * sinR;
  const ry = py;
  const rz = -px * sinR + pz * cosR;
  const denom = CAMERA_Z - rz;
  const scale = FOCAL / denom;
  const x = cx + rx * scale * boxPx * 0.5;
  const y = cy - ry * scale * boxPx * 0.5;
  return { x, y, z: rz, scale };
}

/** Draw the 12 edges of the unit cube (the wireframe bounding box). */
function drawWireBox(
  ctx: Ctx2D,
  rotY: number,
  cx: number,
  cy: number,
  boxPx: number,
): void {
  const corners: [number, number, number][] = [
    [-1, -1, -1], [+1, -1, -1], [+1, +1, -1], [-1, +1, -1],
    [-1, -1, +1], [+1, -1, +1], [+1, +1, +1], [-1, +1, +1],
  ];
  const proj = corners.map((c) => project(c[0], c[1], c[2], rotY, cx, cy, boxPx));
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

/** Faint perspective floor grid (y = -1 plane). */
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
  for (let i = 0; i <= N; i++) {
    const t = (i / N) * 2 - 1;
    const p0 = project(t, -1, -1, rotY, cx, cy, boxPx);
    const p1 = project(t, -1, +1, rotY, cx, cy, boxPx);
    ctx.beginPath();
    ctx.moveTo(p0.x, p0.y);
    ctx.lineTo(p1.x, p1.y);
    ctx.stroke();
  }
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

/** Build an HSL radial-gradient fill for a wireframe-mode shape silhouette. */
function shapeFill(
  ctx: Ctx2D,
  shape: Shape,
  x: number,
  y: number,
  rPx: number,
  projZ: number,
): CanvasGradient {
  const hueDeg = (shape.hue * 360) % 360;
  const front = (projZ + 1) * 0.5;
  const lightMid = 70 - front * 25;
  const lightEdge = 35 - front * 15;
  const inner = `hsl(${hueDeg}, 90%, ${lightMid}%)`;
  const outer = `hsl(${(hueDeg + 30) % 360}, 80%, ${lightEdge}%)`;
  const grad = ctx.createRadialGradient(x - rPx * 0.25, y - rPx * 0.25, rPx * 0.1, x, y, rPx);
  grad.addColorStop(0, inner);
  grad.addColorStop(1, outer);
  return grad;
}

// ---------------- WIREFRAME MODE per-primitive draw -----------------------

/** Draw one shape in wireframe (vaporwave) mode. Verbatim FOXY behaviour. */
function drawShapeWireframe(
  ctx: Ctx2D,
  shape: Shape,
  x: number,
  y: number,
  rPx: number,
  projZ: number,
): void {
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
      ctx.strokeStyle = `hsla(${(shape.hue * 360) % 360}, 95%, 80%, 0.9)`;
      ctx.lineWidth = 1;
      ctx.stroke();
      return;
    }
    case 'cone': {
      ctx.fillStyle = shapeFill(ctx, shape, x, y, rPx, projZ);
      ctx.beginPath();
      ctx.moveTo(x, y - rPx);
      ctx.lineTo(x + rPx, y + rPx);
      ctx.lineTo(x - rPx, y + rPx);
      ctx.closePath();
      ctx.fill();
      return;
    }
    case 'cylinder': {
      ctx.fillStyle = shapeFill(ctx, shape, x, y, rPx, projZ);
      const halfW = rPx * 0.7;
      const halfH = rPx;
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
      ctx.beginPath();
      ctx.moveTo(x, y - rPx);
      ctx.lineTo(x, y + rPx);
      ctx.stroke();
      return;
    }
  }
  const _exhaustive: never = shape.type;
  void _exhaustive;
}

// ---------------- SOLIDS MODE per-primitive draw --------------------------

/** Solids-mode SPHERE: filled circle with a radial gradient (light spot
 *  up-and-left, fading to a darker edge shade). HSL with the shape's hue. */
function drawSolidSphere(
  ctx: Ctx2D,
  shape: Shape,
  x: number,
  y: number,
  rPx: number,
): void {
  const hueDeg = (shape.hue * 360) % 360;
  const lightX = x - rPx * 0.4;
  const lightY = y - rPx * 0.5;
  const grad = ctx.createRadialGradient(lightX, lightY, rPx * 0.05, x, y, rPx);
  grad.addColorStop(0, `hsl(${hueDeg}, 85%, 78%)`);
  grad.addColorStop(0.55, `hsl(${hueDeg}, 80%, 50%)`);
  grad.addColorStop(1, `hsl(${hueDeg}, 70%, 22%)`);
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(x, y, rPx, 0, Math.PI * 2);
  ctx.fill();
  // Crisp specular dot — high light reads as glossy.
  ctx.fillStyle = `hsla(${hueDeg}, 100%, 90%, 0.6)`;
  ctx.beginPath();
  ctx.arc(x - rPx * 0.45, y - rPx * 0.55, rPx * 0.12, 0, Math.PI * 2);
  ctx.fill();
}

/** Solids-mode CUBE: 3 visible faces (top / front / right) in a simple
 *  axonometric projection. Top face brightest, front mid, right side darkest.
 *  Use the shape's hue with brightness offsets per face. */
function drawSolidCube(
  ctx: Ctx2D,
  shape: Shape,
  x: number,
  y: number,
  rPx: number,
): void {
  const hueDeg = (shape.hue * 360) % 360;
  // Axonometric offsets: top face slants up-right, right face slants right.
  const dx = rPx * 0.45;
  const dy = rPx * 0.45;
  // FRONT FACE (the main square, mid-brightness).
  ctx.fillStyle = `hsl(${hueDeg}, 75%, 50%)`;
  ctx.beginPath();
  ctx.moveTo(x - rPx, y - rPx);
  ctx.lineTo(x + rPx, y - rPx);
  ctx.lineTo(x + rPx, y + rPx);
  ctx.lineTo(x - rPx, y + rPx);
  ctx.closePath();
  ctx.fill();
  // TOP FACE (parallelogram above the front face, brightest — lit from above-left).
  ctx.fillStyle = `hsl(${hueDeg}, 80%, 70%)`;
  ctx.beginPath();
  ctx.moveTo(x - rPx, y - rPx);
  ctx.lineTo(x + rPx, y - rPx);
  ctx.lineTo(x + rPx + dx, y - rPx - dy);
  ctx.lineTo(x - rPx + dx, y - rPx - dy);
  ctx.closePath();
  ctx.fill();
  // RIGHT FACE (parallelogram right of front face, darkest — in shadow).
  ctx.fillStyle = `hsl(${hueDeg}, 70%, 32%)`;
  ctx.beginPath();
  ctx.moveTo(x + rPx, y - rPx);
  ctx.lineTo(x + rPx + dx, y - rPx - dy);
  ctx.lineTo(x + rPx + dx, y + rPx - dy);
  ctx.lineTo(x + rPx, y + rPx);
  ctx.closePath();
  ctx.fill();
  // Edges so faces don't blur together.
  ctx.strokeStyle = `hsla(${hueDeg}, 90%, 20%, 0.9)`;
  ctx.lineWidth = 1;
  ctx.beginPath();
  // Front face outline.
  ctx.rect(x - rPx, y - rPx, rPx * 2, rPx * 2);
  ctx.stroke();
  // Top-rear edge.
  ctx.beginPath();
  ctx.moveTo(x - rPx + dx, y - rPx - dy);
  ctx.lineTo(x + rPx + dx, y - rPx - dy);
  ctx.stroke();
  // Right-rear edge.
  ctx.beginPath();
  ctx.moveTo(x + rPx + dx, y - rPx - dy);
  ctx.lineTo(x + rPx + dx, y + rPx - dy);
  ctx.stroke();
}

/** Solids-mode CYLINDER: top ellipse + body rectangle + bottom ellipse.
 *  Body uses a horizontal gradient (light on left, dark on right). Top
 *  ellipse brighter. */
function drawSolidCylinder(
  ctx: Ctx2D,
  shape: Shape,
  x: number,
  y: number,
  rPx: number,
): void {
  const hueDeg = (shape.hue * 360) % 360;
  const bodyW = rPx * 1.4;
  const bodyH = rPx * 1.8;
  const halfW = bodyW * 0.5;
  const halfH = bodyH * 0.5;
  const ellipseRy = rPx * 0.35;
  // Body rect with horizontal lighting gradient.
  const grad = ctx.createLinearGradient(x - halfW, y, x + halfW, y);
  grad.addColorStop(0, `hsl(${hueDeg}, 80%, 65%)`);
  grad.addColorStop(0.5, `hsl(${hueDeg}, 75%, 45%)`);
  grad.addColorStop(1, `hsl(${hueDeg}, 70%, 25%)`);
  ctx.fillStyle = grad;
  ctx.fillRect(x - halfW, y - halfH, bodyW, bodyH);
  // Bottom ellipse (darker — in shadow under the cylinder).
  ctx.fillStyle = `hsl(${hueDeg}, 70%, 25%)`;
  ctx.beginPath();
  ctx.ellipse(x, y + halfH, halfW, ellipseRy, 0, 0, Math.PI * 2);
  ctx.fill();
  // Top ellipse (brightest — directly lit).
  ctx.fillStyle = `hsl(${hueDeg}, 85%, 70%)`;
  ctx.beginPath();
  ctx.ellipse(x, y - halfH, halfW, ellipseRy, 0, 0, Math.PI * 2);
  ctx.fill();
  // Edge outlines so the body silhouette reads cleanly.
  ctx.strokeStyle = `hsla(${hueDeg}, 90%, 20%, 0.8)`;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x - halfW, y - halfH);
  ctx.lineTo(x - halfW, y + halfH);
  ctx.moveTo(x + halfW, y - halfH);
  ctx.lineTo(x + halfW, y + halfH);
  ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(x, y - halfH, halfW, ellipseRy, 0, 0, Math.PI * 2);
  ctx.stroke();
}

/** Solids-mode CONE: triangular silhouette filled with a vertical gradient
 *  (apex light, base dark). Add an ellipse at the base for foreshortening. */
function drawSolidCone(
  ctx: Ctx2D,
  shape: Shape,
  x: number,
  y: number,
  rPx: number,
): void {
  const hueDeg = (shape.hue * 360) % 360;
  const apexY = y - rPx;
  const baseY = y + rPx;
  const baseHalfW = rPx;
  const ellipseRy = rPx * 0.3;
  // Vertical gradient — apex brightest (catches the overhead light), base
  // darker.
  const grad = ctx.createLinearGradient(x, apexY, x, baseY);
  grad.addColorStop(0, `hsl(${hueDeg}, 85%, 72%)`);
  grad.addColorStop(0.5, `hsl(${hueDeg}, 80%, 45%)`);
  grad.addColorStop(1, `hsl(${hueDeg}, 70%, 28%)`);
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(x, apexY);
  ctx.lineTo(x + baseHalfW, baseY);
  ctx.lineTo(x - baseHalfW, baseY);
  ctx.closePath();
  ctx.fill();
  // Base ellipse so the cone reads as a 3D solid rather than a flat triangle.
  ctx.fillStyle = `hsl(${hueDeg}, 65%, 22%)`;
  ctx.beginPath();
  ctx.ellipse(x, baseY, baseHalfW, ellipseRy, 0, 0, Math.PI * 2);
  ctx.fill();
  // Silhouette outline.
  ctx.strokeStyle = `hsla(${hueDeg}, 90%, 20%, 0.8)`;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, apexY);
  ctx.lineTo(x + baseHalfW, baseY);
  ctx.lineTo(x - baseHalfW, baseY);
  ctx.closePath();
  ctx.stroke();
}

/** Solids-mode RING (torus): filled disc with a radial gradient (matching
 *  the sphere lighting direction), then a HOLE punched in the centre via
 *  `destination-out` so the box / floor / shapes behind read through. An
 *  inner-rim darken band gives the torus 3D thickness. */
function drawSolidRing(
  ctx: Ctx2D,
  shape: Shape,
  x: number,
  y: number,
  rPx: number,
): void {
  const hueDeg = (shape.hue * 360) % 360;
  // Outer + inner radii. Same 0.7 outer × 0.35 inner ratio the wireframe
  // ring used (stroke width = 0.35 × rPx, centred at 0.7 × rPx → inner
  // edge at 0.525 × rPx, outer at 0.875 × rPx).
  const outerR = rPx * 0.875;
  const innerR = rPx * 0.525;
  // Step 1: outer disc with the standard up-and-left highlight.
  const lightX = x - outerR * 0.4;
  const lightY = y - outerR * 0.5;
  const grad = ctx.createRadialGradient(lightX, lightY, outerR * 0.05, x, y, outerR);
  grad.addColorStop(0, `hsl(${hueDeg}, 85%, 78%)`);
  grad.addColorStop(0.55, `hsl(${hueDeg}, 80%, 50%)`);
  grad.addColorStop(1, `hsl(${hueDeg}, 70%, 22%)`);
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(x, y, outerR, 0, Math.PI * 2);
  ctx.fill();
  // Step 2: punch the inner hole. `destination-out` clears the disc's
  // centre back to whatever was on the canvas behind (the box edges +
  // floor grid + bg gradient stay visible through the hole). Save/restore
  // so the composite mode change is scoped.
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  ctx.beginPath();
  ctx.arc(x, y, innerR, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  // Step 3: inner-rim darken band — a stroked circle along the inner
  // edge gives the torus visible thickness (reads as the cylindrical
  // body curving inward at the hole). Subtle — small fraction of
  // outer-rim opacity so it doesn't overwhelm the highlight.
  ctx.strokeStyle = `hsla(${hueDeg}, 90%, 18%, 0.65)`;
  ctx.lineWidth = Math.max(1, rPx * 0.06);
  ctx.beginPath();
  ctx.arc(x, y, innerR + ctx.lineWidth * 0.5, 0, Math.PI * 2);
  ctx.stroke();
  // Outer-rim darken — same idea on the outer edge to seat the torus
  // visually in the scene (silhouette pass).
  ctx.strokeStyle = `hsla(${hueDeg}, 90%, 20%, 0.8)`;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(x, y, outerR, 0, Math.PI * 2);
  ctx.stroke();
}

/** Solids-mode TETRA (regular tetrahedron, 4 lit faces). Full back-to-
 *  front painter's algorithm: 4 vertices in shape-local space are rotated
 *  by the scene camera Y rotation (so the tetra rotates with the rest of
 *  the box content), each face's centroid Z is used to depth-sort, and
 *  each face is filled with a Lambert-term brightness against the
 *  documented light direction. No GL — pure canvas2D fillTriangle calls. */
function drawSolidTetra(
  ctx: Ctx2D,
  shape: Shape,
  x: number,
  y: number,
  rPx: number,
  rotY: number,
): void {
  const hueDeg = (shape.hue * 360) % 360;
  // Regular-tetrahedron vertices on the unit sphere (radius √(3/8) × 2 ≈
  // 1.225 for an edge length of 2). The vertex set is the four corners
  // of a cube where signed coords multiply to +1 — a classic compact
  // formula for a regular tetrahedron centred at the origin.
  // We scale by rPx (the on-screen projected radius) so the silhouette
  // matches the wireframe-mode tetra's bounding box at the same shape.
  const k = rPx; // local-scale factor — vertex magnitudes are O(1).
  const verts: Array<[number, number, number]> = [
    [+k, +k, +k],
    [+k, -k, -k],
    [-k, +k, -k],
    [-k, -k, +k],
  ];
  // Faces — each is a triangle of 3 vertex indices, wound so the
  // outward-pointing normal computed by (v1-v0)×(v2-v0) faces OUT.
  // (Manually verified the winding for the cube-corner tetra above; if
  // a future vertex set is swapped, recompute normals from cross product
  // — Lambert below uses the explicit normal so the shading stays right.)
  const faces: Array<[number, number, number]> = [
    [0, 1, 2],
    [0, 3, 1],
    [0, 2, 3],
    [1, 3, 2],
  ];
  // Apply scene Y-rotation (same axis the box rotates around). The light
  // direction is fixed in CAMERA space — staying camera-relative means a
  // rotating tetra shows its lit/unlit faces sweep around it (more
  // visually interesting than locking the light to the tetra's frame).
  const cosR = Math.cos(rotY);
  const sinR = Math.sin(rotY);
  const rotated = verts.map(([vx, vy, vz]): [number, number, number] => {
    const rx = vx * cosR + vz * sinR;
    const rz = -vx * sinR + vz * cosR;
    return [rx, vy, rz];
  });
  // Light direction — camera-space, normalised. Same diagonal up-and-
  // forward direction the sphere/cone solids use implicitly.
  const lx = -0.4;
  const ly = -0.6;
  const lz = -0.7;
  const lLen = Math.hypot(lx, ly, lz);
  const lxN = lx / lLen, lyN = ly / lLen, lzN = lz / lLen;
  // Build draw entries: face vertices in 2D + a depth key (avg Z) + a
  // brightness term (Lambert n·L, clamped to [-1,1] then remapped to a
  // brightness band).
  interface FaceDraw {
    x0: number; y0: number; x1: number; y1: number; x2: number; y2: number;
    depthZ: number;
    lightness: number; // 0..1
  }
  const draws: FaceDraw[] = [];
  for (const [a, b, c] of faces) {
    const v0 = rotated[a]!;
    const v1 = rotated[b]!;
    const v2 = rotated[c]!;
    // 2D positions (canvas y grows DOWN, scene y grows UP — flip y on
    // the way to canvas like project() does).
    const x0 = x + v0[0]; const y0 = y - v0[1];
    const x1 = x + v1[0]; const y1 = y - v1[1];
    const x2 = x + v2[0]; const y2 = y - v2[1];
    // Face normal (in scene/camera space — we haven't projected to 2D yet).
    const ex1 = v1[0] - v0[0], ey1 = v1[1] - v0[1], ez1 = v1[2] - v0[2];
    const ex2 = v2[0] - v0[0], ey2 = v2[1] - v0[1], ez2 = v2[2] - v0[2];
    const nx = ey1 * ez2 - ez1 * ey2;
    const ny = ez1 * ex2 - ex1 * ez2;
    const nz = ex1 * ey2 - ey1 * ex2;
    const nLen = Math.hypot(nx, ny, nz) || 1;
    const nxN = nx / nLen, nyN = ny / nLen, nzN = nz / nLen;
    // Lambert term: n · L. We want bright when the normal faces TOWARD the
    // light source, so use the dot with -L (light direction is from-light-
    // to-surface; surface-to-light is -L).
    const lambert = -(nxN * lxN + nyN * lyN + nzN * lzN);
    // Map [-1,1] → [0.18 .. 0.78] lightness band (a face fully facing the
    // light hits 78% L; a face fully turned away sits at 18% L).
    const lightness = 0.18 + (lambert * 0.5 + 0.5) * 0.6;
    // Painter's-algorithm depth: avg Z. Smaller (further from camera at +Z) = back.
    const depthZ = (v0[2] + v1[2] + v2[2]) / 3;
    draws.push({ x0, y0, x1, y1, x2, y2, depthZ, lightness });
  }
  // Back-to-front sort: smallest depth first (most negative Z is furthest
  // back in our +Z-toward-camera convention; project() returns the
  // rotated-z as "rz" with camera at +CAMERA_Z, so a more-NEGATIVE rz is
  // further from the camera. Same sort drawShapesScene's drawables sort
  // uses for inter-shape ordering).
  draws.sort((a, b) => a.depthZ - b.depthZ);
  ctx.lineWidth = 1;
  for (const d of draws) {
    const L = Math.round(d.lightness * 100);
    ctx.fillStyle = `hsl(${hueDeg}, 80%, ${L}%)`;
    ctx.beginPath();
    ctx.moveTo(d.x0, d.y0);
    ctx.lineTo(d.x1, d.y1);
    ctx.lineTo(d.x2, d.y2);
    ctx.closePath();
    ctx.fill();
    // Crisp edge so adjacent faces of close lightness don't blur together.
    ctx.strokeStyle = `hsla(${hueDeg}, 90%, 20%, 0.7)`;
    ctx.stroke();
  }
}

/**
 * Draw one shape in SOLIDS mode. Per-primitive lit rendering for ALL
 * primitive types: sphere/cube/cylinder/cone + (added in this PR) ring
 * (torus with destination-out hole) + tetraFrame (4-face Lambert-shaded
 * tetrahedron rotating with the scene camera).
 */
function drawShapeSolid(
  ctx: Ctx2D,
  shape: Shape,
  x: number,
  y: number,
  rPx: number,
  projZ: number,
  rotY: number,
): void {
  const front = (projZ + 1) * 0.5;
  const alpha = 0.97 - front * 0.2;
  ctx.globalAlpha = Math.max(0.55, Math.min(1, alpha));

  switch (shape.type) {
    case 'sphere':     drawSolidSphere(ctx, shape, x, y, rPx); return;
    case 'cube':       drawSolidCube(ctx, shape, x, y, rPx); return;
    case 'cylinder':   drawSolidCylinder(ctx, shape, x, y, rPx); return;
    case 'cone':       drawSolidCone(ctx, shape, x, y, rPx); return;
    case 'ring':       drawSolidRing(ctx, shape, x, y, rPx); return;
    case 'tetraFrame': drawSolidTetra(ctx, shape, x, y, rPx, rotY); return;
  }
  const _exhaustive: never = shape.type;
  void _exhaustive;
}

// ---------------- Top-level draw entries ----------------------------------

/** Whether a given primitive type renders with the lit/solid path in
 *  SOLIDS mode. After the solids-all-primitives PR this is TRUE for every
 *  primitive — ring + tetraFrame now have their own lit renderers (torus
 *  with destination-out hole; 4-face Lambert tetrahedron). Exported for
 *  tests + the card legend. */
export function isLitShapeType(t: FoxyShapeType): boolean {
  return (
    t === 'sphere' ||
    t === 'cube' ||
    t === 'cylinder' ||
    t === 'cone' ||
    t === 'ring' ||
    t === 'tetraFrame'
  );
}

/** Options for the unified scene renderer. */
export interface ShapesSceneOptions {
  /** Render mode. `'wireframe'` keeps the vaporwave look (FOXY default).
   *  `'solids'` switches sphere/cube/cylinder/cone to lit canvas2D draws;
   *  ring + tetraFrame stay wireframe in v1. */
  mode?: 'wireframe' | 'solids';
  /** Manual camera rotation in radians around the Y axis. When set,
   *  `autoRotate` is implicitly disabled (the user owns the rotation
   *  via this knob). Default 0 (identity camera). */
  rotation?: number;
  /** When true (FOXY's default), the scene auto-rotates at 6 RPM using
   *  `nowMs` as the clock. When false (SHAPEGEN's default), rotation
   *  is whatever the `rotation` option says. */
  autoRotate?: boolean;
  /** Override the rotation clock. If set + `autoRotate`, rotation phase =
   *  nowMs * ROTATION_RATE. If omitted, the renderer uses performance.now(). */
  nowMs?: number;
}

/**
 * Top-level draw entry: paint the 3D-shapes-in-a-box scene at the chosen
 * render mode.
 */
export function drawShapesScene(
  ctx: Ctx2D,
  shapes: readonly Shape[],
  w: number,
  h: number,
  opts: ShapesSceneOptions = {},
): void {
  const mode = opts.mode ?? 'wireframe';
  const autoRotate = opts.autoRotate ?? false;

  // Background — vertical gradient (top = midnight purple, bot = navy).
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, BG_TOP);
  grad.addColorStop(1, BG_BOT);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  // Rotation phase.
  let rotY: number;
  if (autoRotate) {
    const nowMs = opts.nowMs ?? (typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now());
    rotY = nowMs * ROTATION_RATE;
  } else {
    rotY = opts.rotation ?? 0;
  }

  const cx = w / 2;
  const cy = h / 2;
  const boxPx = Math.min(w, h) * 0.8;

  // Floor grid (behind the wireframe box so the box stays on top).
  drawFloorGrid(ctx, rotY, cx, cy, boxPx);

  // Wireframe bounding box (kept in BOTH modes — gives spatial reference).
  drawWireBox(ctx, rotY, cx, cy, boxPx);

  // Project + sort + paint shapes back-to-front.
  interface DrawableShape { shape: Shape; sx: number; sy: number; rPx: number; projZ: number }
  const drawables: DrawableShape[] = [];
  for (const sh of shapes) {
    const p = project(sh.pos.x, sh.pos.y, sh.pos.z, rotY, cx, cy, boxPx);
    const rPx = sh.radius * p.scale * boxPx * 0.5;
    drawables.push({ shape: sh, sx: p.x, sy: p.y, rPx, projZ: p.z });
  }
  drawables.sort((a, b) => b.projZ - a.projZ);
  for (const d of drawables) {
    if (mode === 'solids') drawShapeSolid(ctx, d.shape, d.sx, d.sy, d.rPx, d.projZ, rotY);
    else                   drawShapeWireframe(ctx, d.shape, d.sx, d.sy, d.rPx, d.projZ);
  }
  ctx.globalAlpha = 1;
}

/** FOXY's existing entry point. KEPT for the foxy-shapes-draw re-export
 *  shim — uses wireframe mode + auto-rotation (the FOXY default). The
 *  visual is byte-identical to the previous implementation. */
export interface FoxyShapesDrawOptions {
  /** Override the rotation clock. */
  nowMs?: number;
}

export function drawFoxyShapes(
  ctx: Ctx2D,
  shapes: readonly Shape[],
  w: number,
  h: number,
  opts: FoxyShapesDrawOptions = {},
): void {
  drawShapesScene(ctx, shapes, w, h, {
    mode: 'wireframe',
    autoRotate: true,
    nowMs: opts.nowMs,
  });
}

/** Tiny utility — exported so the card can pre-resolve the active type
 *  ordering when computing color cycles or legend rows. */
export function foxyShapeTypeLabels(): readonly FoxyShapeType[] {
  return ['sphere', 'cube', 'cone', 'cylinder', 'ring', 'tetraFrame'];
}
