// packages/web/src/lib/ui/modules/cube/cube-view-mounts.ts
//
// The ONE home for how cube's node-owned renderer is MOUNTED per claimant kind,
// and the drag-to-orbit action both mounts share (legacy-removal S1.5).
//
// ⚠ WHY SIZES LIVE HERE AND NOT ON THE VIEWS. `CubeVizSurface` is mounted ONCE
// per node by `NodeVizSurfaceHost`; the legacy card and the faceplate hero only
// CLAIM its element. The two views historically showed the renderer at
// DIFFERENT sizes — the card at 320×260 / 150×120 / 162×120 (the surface's own
// prop defaults), the hero at 300×210 / 147×104 / 147×104 with drag-to-orbit —
// and cube's look is owner-sensitive, so neither view's picture may change as a
// side effect of who owns the mount. The host therefore re-mounts the surface
// per WINNING CLAIMANT KIND with the numbers below; a view that re-typed its
// own copy would be a second source of truth for a picture it no longer owns.
//
// ⚠ THE SURFACE ITSELF CANNOT GROW A RESIZE PATH: its bytes are pinned by the
// WebGL attest basis (`scripts/webgl-attest-hash.sh --list` names it), so
// per-kind props + a keyed remount are the shape that leaves it byte-identical.
// The remount happens exactly where the OLD design churned anyway — a dock
// full view opening or closing used to mount/destroy a second whole surface.

import { setNodeParam } from '$lib/graph/mutate';
import { patch } from '$lib/graph/store';
import { cubeDef } from '$lib/audio/modules/cube';

/** The size props each claimant kind mounts the surface with. `card` is also
 *  the PARKED shape — a node nobody is viewing keeps the card numbers, which
 *  preserves the bridge picture's aspect exactly as the old headless-hosted
 *  card did (`renderGl` reads the visible canvas's aspect for its projection,
 *  so these numbers are not view chrome — they reach `video_out`). */
export const CUBE_VIEW_SIZES = {
  card: { vizW: 320, vizH: 260, sliceW: 150, sliceH: 120, waveW: 162, waveH: 120 },
  dock: { vizW: 300, vizH: 210, sliceW: 147, sliceH: 104, waveW: 147, waveH: 104 },
} as const;

/** Radians per CSS px of drag — the hero's own number, moved verbatim: a full
 *  sweep of the 300 px view is a bit over half a turn, the sensitivity the
 *  camera knobs give over their own travel. */
const ORBIT_RAD_PER_PX = 0.01;

const defaultFor = (pid: string): number | undefined =>
  cubeDef.params.find((p) => p.id === pid)?.defaultValue;

/** ⚠ RANGES COME FROM THE DEF, never re-typed here (the card-vs-def divergence
 *  class: a control that writes values its own contract forbids). */
const rangeOf = (pid: string): [number, number] => {
  const d = cubeDef.params.find((q) => q.id === pid)!;
  return [d.min, d.max];
};

/**
 * Drag-to-orbit: report a pointer delta in CSS px, write the two camera params.
 *
 * Moved OUT of `CubeHeroPanel` when the hero stopped mounting the renderer —
 * the surface's `onOrbit` prop is wired at MOUNT time, and the host is the one
 * mount now. The gesture still only EXISTS on the dock mount (the host passes
 * `onOrbit` for the `dock` kind alone), so the legacy card's canvas keeps its
 * historical behaviour: a drag there moves the node, not the camera.
 */
export function orbitCubeView(nodeId: string, dxPx: number, dyPx: number): void {
  const bump = (pid: string, delta: number): void => {
    const [lo, hi] = rangeOf(pid);
    const raw = patch.nodes[nodeId]?.params?.[pid];
    const cur = (typeof raw === 'number' ? raw : defaultFor(pid)) ?? 0;
    const next = Math.max(lo, Math.min(hi, cur + delta));
    if (next !== cur) setNodeParam(nodeId, pid, next);
  };
  // Vertical drag = elevation (view_rot_x), horizontal = azimuth (view_rot_y)
  // — the same two angles the eye vector is built from.
  if (dyPx !== 0) bump('view_rot_x', dyPx * ORBIT_RAD_PER_PX);
  if (dxPx !== 0) bump('view_rot_y', -dxPx * ORBIT_RAD_PER_PX);
}
