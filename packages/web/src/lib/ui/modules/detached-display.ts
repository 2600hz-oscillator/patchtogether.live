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

/** A screen-space box to keep clear when placing a fresh panel. */
export interface AvoidRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function overlaps(a: DetachedRect, b: AvoidRect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * Where a FRESH panel opens.
 *
 * ⚠ IT MUST NOT LAND ON TOP OF THE CARD IT CAME FROM, and that is a requirement
 * rather than a nicety: the owner asked that re-attach be reachable by
 * right-clicking *"the underlying video output card"*, and a panel centred in
 * the viewport lands exactly where a just-revealed card is — covering the very
 * surface whose context menu is the documented way back. Measured as a click
 * interception: the panel's canvas swallowed the right-click aimed at the
 * card's picture.
 *
 * So: centre, and if that overlaps the card, slide to whichever side has more
 * room. Falling back to the centred position when NEITHER side fits is
 * deliberate — a viewport too small to dodge is one where any placement
 * overlaps, and a panel the user can drag beats a panel wedged off-screen.
 */
export function placeDetached(viewport: ViewportSize, avoid?: AvoidRect): DetachedRect {
  const centred = clampDetachedRect({}, viewport);

  // ⚠ TWO DIFFERENT UNKNOWNS. `avoid === undefined` means the caller found NO
  // CARD ELEMENT AT ALL — nothing on screen to collide with, so the centre is
  // correct. A PRESENT element measuring zero (or non-finite) is the other case:
  // the card is there, we simply could not read it, and then the centre is the
  // WORST guess because a just-revealed card is itself centred.
  if (!avoid) return centred;
  const degenerate = !Number.isFinite(avoid.w) || !Number.isFinite(avoid.h) || avoid.w <= 0 || avoid.h <= 0;
  if (degenerate) {
    return clampDetachedRect({ ...centred, x: Math.max(0, viewport.width - centred.w - 24), y: 24 }, viewport);
  }
  if (!overlaps(centred, avoid)) return centred;

  // ⚠ NEVER FALL BACK TO AN OVERLAPPING POSITION. The first version tried right
  // then left and, if neither FIT ON SCREEN, returned the centred rect — which
  // is the collision this function exists to prevent. MEASURED on CI and not
  // locally, because the shape of the failure is pure geometry: the CI viewport
  // is `devices['Desktop Chrome']` = 1280x720, and a 480-wide panel cannot clear
  // a ~360-wide card sitting near the middle of 1280 px on EITHER side (right
  // needs 832+480 = 1312 > 1280; left needs -32 < 0). Both candidates were
  // rejected as off-screen and the overlapping fallback shipped — so the panel
  // covered the card and swallowed the right-click that re-attaches. A wider dev
  // viewport dodged successfully and hid it.
  //
  // So: try the four sides, then the corners, and if NOTHING is fully clear pick
  // the on-screen candidate with the LEAST overlap rather than the most. Least
  // overlap is not a cosmetic tie-break — it is what keeps the card's own centre
  // (where a right-click lands) reachable when the viewport is genuinely too
  // small for a clean dodge.
  const gap = 12;
  const maxX = Math.max(0, viewport.width - centred.w);
  const maxY = Math.max(0, viewport.height - centred.h);
  const xs = [avoid.x + avoid.w + gap, avoid.x - centred.w - gap, maxX, 0];
  const ys = [avoid.y + avoid.h + gap, avoid.y - centred.h - gap, maxY, 0];

  const candidates: DetachedRect[] = [];
  for (const x of xs) candidates.push({ ...centred, x, y: centred.y });
  for (const y of ys) candidates.push({ ...centred, x: centred.x, y });
  // Corners last: they move BOTH axes, so they are the most disruptive option
  // and only worth taking when no single-axis slide works.
  for (const x of [maxX, 0]) for (const y of [0, maxY]) candidates.push({ ...centred, x, y });

  const onScreen = candidates
    .map((c) => clampDetachedRect(c, viewport))
    .filter((c) => c.x >= 0 && c.y >= 0 && c.x + c.w <= viewport.width && c.y + c.h <= viewport.height);

  for (const c of onScreen) if (!overlaps(c, avoid)) return c;

  // Nothing is fully clear — take the least-overlapping on-screen candidate.
  const area = (c: DetachedRect): number => {
    const ox = Math.max(0, Math.min(c.x + c.w, avoid.x + avoid.w) - Math.max(c.x, avoid.x));
    const oy = Math.max(0, Math.min(c.y + c.h, avoid.y + avoid.h) - Math.max(c.y, avoid.y));
    return ox * oy;
  };
  let best = centred;
  let bestArea = area(centred);
  for (const c of onScreen) {
    const a = area(c);
    if (a < bestArea) {
      best = c;
      bestArea = a;
    }
  }
  return best;
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
    // ⚠ DETACH SUPERSEDES FULL FRAME, and it is HERE rather than at the three
    // call sites on purpose. Two of them cleared it and the third — the node
    // context menu, which after promotion is the ONLY detach route a rack TILE
    // has — did not, so the shipping path was the one that skipped the mutual
    // exclusion and left a card expanded around a picture that had left it.
    // Mutual exclusion belongs to the state transition, not to whoever happens
    // to trigger it.
    fullFrame: false,
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
