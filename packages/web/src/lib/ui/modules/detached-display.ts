// packages/web/src/lib/ui/modules/detached-display.ts
//
// THE DETACHED DISPLAY (#1821) — the pure model behind "right-click → detach
// display": a free-floating, resizable picture of one video OUTPUT, with no
// patch wires, that re-attaches from either side and dies with its node.
//
// Owner, 2026-08-17:
//
//   "when i detach the view i want something like this — free floating, no patch
//    wires, can be resized. if it's detached we can right click either it OR the
//    underlying video output card, and click 're-attach'. also if we delete the
//    card the output goes away and if we right click the floating output and
//    delete it the card goes away"
//
// and then, relaxing it:
//
//   "if there's an easier way to just have the detachable overlay with more
//    constraints its probably fine"
//
// ── WHY A CANVAS PANEL AND NOT `present-window.ts` ───────────────────────────
//
// There is a shipped popup projector (`present-window.ts` → `window.open('/present')`),
// and the first reading of this issue proposed reusing it. It is the wrong
// mechanism, for three reasons that are about the SPEC rather than about effort:
//
//   1. "NO PATCH WIRES" only says something about a surface that could HAVE
//      them. A browser popup has none by definition, so as an instruction about
//      a popup the clause is vacuous — it is an instruction about an in-canvas
//      surface.
//   2. "the same resizable nearly borderless thing we have now" names something
//      that already exists: the OUTPUT card in FULL FRAME — chrome hidden, body
//      all picture, corner-drag resize. That is in-canvas.
//   3. Present-on-a-second-display is ALREADY a separate item in the same menu
//      and means something else (a projector on another monitor). Overloading it
//      would delete a shipped affordance to add one.
//
// So: an absolutely-positioned panel rendered ABOVE the flow pane, outside
// `<SvelteFlow>` — which is what makes "no patch wires" STRUCTURAL rather than
// styled. It is not a flow node, so there is nothing for an edge to attach to
// and nothing for the edge renderer to draw.
//
// ── WHY THE STATE LIVES ON THE NODE ──────────────────────────────────────────
//
// `node.data.detached` + its geometry, written through `mutateNode` — the same
// seam `node.data.fullFrame` and backdraft's `previewCollapsed` (#1784) already
// use. That choice is what makes the owner's bidirectional lifecycle STRUCTURAL
// instead of two symmetric handlers that can drift:
//
//   * **delete the card → the overlay goes with it, BY CONSTRUCTION.** The
//     overlay is rendered by iterating the live nodes for the flag. A deleted
//     node is not in that iteration, so there is no teardown to forget and no
//     registry to sweep.
//   * **delete from the overlay → the node's own delete path.** The overlay's
//     menu calls the SAME `deleteNode(id)` the node context menu calls, so the
//     card going away is not a second implementation of "delete" — it is the
//     only one.
//   * **re-attach → clear one flag**, and both right-click entries call the same
//     function.
//
// It also comes with three properties for free, because `node.data` is Y.Doc
// state: it survives the card unmounting (the #1531/#1574/#1583 class), it
// survives reload, and it syncs to collaborators.
//
// ── THE CONSTRAINTS CHOSEN, AND WHY EACH IS SAFE ─────────────────────────────
//
// The owner blessed a more constrained overlay. Taken, and named here so the
// trade is visible rather than discovered:
//
//   * ONE detached view per node (the flag is a boolean, not a list). Many
//     nodes may be detached at once.
//   * CANVAS-RESIDENT, not a browser window — see above; it is also what the
//     "no patch wires" clause implies.
//   * SCREEN-SPACE geometry, not flow-space: the panel does NOT pan or zoom with
//     the rack. "Free floating" reads as independent of the patch, and a picture
//     that shrinks when you zoom out to see your rack is the opposite of what
//     detaching is for.
//   * CLAMPED to the viewport rather than free geometry, so a panel can never be
//     dragged somewhere it cannot be dragged back from.
//   * A MINIMUM SIZE, so the picture can never be resized into a handle-less dot.
//
// PURE — no Svelte, no DOM, no Yjs. Every rule above is a function here and a
// test in `detached-display.test.ts`; the component only renders what this says.

import type { ModuleNode } from '$lib/graph/types';
import { videoPortsOf, type DropDefLike } from '$lib/ui/patch-drop/drop-plan';

/** The `node.data` keys this feature owns. One place, so a reader and a writer
 *  cannot disagree about the spelling. */
export const DETACHED_KEYS = {
  on: 'detached',
  x: 'detachedX',
  y: 'detachedY',
  w: 'detachedW',
  h: 'detachedH',
} as const;

/**
 * Minimum panel size, CSS px. Physical constants, not a population count: below
 * this the resize grip overlaps the panel's own chrome and the picture stops
 * being a picture. 4:3 at the floor so the default is not letterboxed on both
 * axes the moment it opens.
 */
export const DETACHED_MIN_W = 240;
export const DETACHED_MIN_H = 180;

/** Default panel size when a node is detached for the first time. */
export const DETACHED_DEFAULT_W = 480;
export const DETACHED_DEFAULT_H = 360;

/** How much of the panel must stay on screen after a drag, CSS px. Enough to
 *  grab the header and drag it back — the whole point of clamping. */
export const DETACHED_KEEP_VISIBLE = 64;

/** A detached panel's screen-space rectangle, CSS px. */
export interface DetachedRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Viewport extent used for clamping, CSS px. */
export interface ViewportSize {
  width: number;
  height: number;
}

/** One module type whose OUTPUT picture may be detached. */
export interface DetachableEntry {
  /** The registered module type id. Anchored to a live def by the test. */
  type: string;
  /** WHY this module gets a detached display. Required BY THE TYPE. */
  why: string;
}

/**
 * THE SCOPE — deny by default, `why` in the type.
 *
 * ⚠ Like `BRIDGE_ON_DELETE`, this is the DECLARED half of a two-part rule; the
 * DERIVED half is `supportsDetachedDisplay`, which additionally requires the def
 * to actually publish a video picture (a video-domain def with at least one
 * video output — the thing `blitOutputToDrawingBuffer` can render). A scoped
 * type that stops satisfying it is RED, not silently inert.
 */
export const DETACHABLE_DISPLAYS: readonly DetachableEntry[] = [
  {
    type: 'videoOut',
    why:
      'the OUTPUT monitor is the screen at the end of a video chain, and the owner asked for its '
      + 'picture to come OFF the card so the card no longer needs arbitrary resizing: '
      + '"the display is now the same resizable nearly borderless thing we have now".',
  },
] as const;

const SCOPED: ReadonlySet<string> = new Set(DETACHABLE_DISPLAYS.map((e) => e.type));

/**
 * May this module's picture be detached?
 *
 * BOTH halves: the DECLARED scope, then the DERIVED capability — the def must
 * publish a video output, because that is the texture the panel blits. A def
 * with no video output has no picture to detach, so the panel would be a black
 * rectangle with a resize grip.
 */
export function supportsDetachedDisplay(type: string, def: DropDefLike | undefined): boolean {
  if (!SCOPED.has(type)) return false;
  if (!def) return false;
  return videoPortsOf(def, 'outputs').length > 0;
}

/** Is this node's display currently detached? Absent ⇒ false ⇒ attached, so an
 *  existing rack loads exactly as it does today. */
export function isDetached(node: ModuleNode | undefined): boolean {
  return (node?.data?.[DETACHED_KEYS.on] as boolean | undefined) === true;
}

function num(node: ModuleNode | undefined, key: string): number | undefined {
  const v = node?.data?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * Clamp a rectangle so it is at least the minimum size and cannot be parked
 * where it can no longer be grabbed.
 *
 * TOTAL by construction: a NaN / Infinity / negative input resolves to the
 * default rather than throwing, because this runs on every render and a throw
 * mid-drag takes the whole canvas down.
 */
export function clampDetachedRect(rect: Partial<DetachedRect>, viewport: ViewportSize): DetachedRect {
  const vw = Number.isFinite(viewport.width) && viewport.width > 0 ? viewport.width : DETACHED_DEFAULT_W;
  const vh = Number.isFinite(viewport.height) && viewport.height > 0 ? viewport.height : DETACHED_DEFAULT_H;

  const finite = (v: number | undefined, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback;

  // Size first — the position clamp depends on it.
  let w = Math.max(DETACHED_MIN_W, Math.round(finite(rect.w, DETACHED_DEFAULT_W)));
  let h = Math.max(DETACHED_MIN_H, Math.round(finite(rect.h, DETACHED_DEFAULT_H)));
  // Never wider/taller than the window: a panel you cannot see the grip of is
  // a panel you cannot resize back.
  w = Math.min(w, Math.max(DETACHED_MIN_W, Math.round(vw)));
  h = Math.min(h, Math.max(DETACHED_MIN_H, Math.round(vh)));

  const x = Math.round(finite(rect.x, Math.max(0, (vw - w) / 2)));
  const y = Math.round(finite(rect.y, Math.max(0, (vh - h) / 2)));

  // KEEP_VISIBLE px of the panel must remain inside the viewport on every edge.
  const minX = DETACHED_KEEP_VISIBLE - w;
  const maxX = Math.round(vw) - DETACHED_KEEP_VISIBLE;
  const minY = 0; // never above the top: the header IS the drag handle
  const maxY = Math.round(vh) - DETACHED_KEEP_VISIBLE;

  return {
    x: Math.min(Math.max(x, minX), Math.max(minX, maxX)),
    y: Math.min(Math.max(y, minY), Math.max(minY, maxY)),
    w,
    h,
  };
}

/** The clamped rectangle for a node's detached panel, read off `node.data`. */
export function detachedRect(node: ModuleNode | undefined, viewport: ViewportSize): DetachedRect {
  return clampDetachedRect(
    {
      x: num(node, DETACHED_KEYS.x),
      y: num(node, DETACHED_KEYS.y),
      w: num(node, DETACHED_KEYS.w),
      h: num(node, DETACHED_KEYS.h),
    },
    viewport,
  );
}

/**
 * The `node.data` patch that DETACHES a node, geometry included.
 *
 * Returned as a plain object rather than applied here so the caller writes it
 * through `mutateNode` in one transaction — one undo entry for the whole
 * gesture, and the pure tier stays free of Yjs.
 */
export function detachPatch(rect: DetachedRect): Record<string, number | boolean> {
  return {
    [DETACHED_KEYS.on]: true,
    [DETACHED_KEYS.x]: rect.x,
    [DETACHED_KEYS.y]: rect.y,
    [DETACHED_KEYS.w]: rect.w,
    [DETACHED_KEYS.h]: rect.h,
  };
}

/**
 * The keys RE-ATTACH clears.
 *
 * ⚠ It clears the FLAG ONLY and deliberately keeps the geometry: detach →
 * re-attach → detach should put the panel back where the user last left it,
 * which is the behaviour of every other remembered window. Nothing reads the
 * geometry while attached, so keeping it costs one number per node.
 */
export const REATTACH_CLEARS: readonly string[] = [DETACHED_KEYS.on];
