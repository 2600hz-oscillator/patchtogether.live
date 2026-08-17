// packages/web/src/lib/dev/video-patch-drop/drop-target.ts
//
// ⛔ DEV SANDBOX — nothing in the engine imports this. It is the pure decision
// layer behind the working drop gesture on /dev/video-patch-drop.
//
// ── WHAT THE LIBRARY DECIDES, AND WHAT IT DOES NOT ───────────────────────
// `useSvelteFlow().getIntersectingNodes(rect, partially)` answers "which nodes
// touch this rect". That is the cheap half. It does NOT answer the three
// questions a drop-to-patch gesture actually has, and its default answer to the
// second one is measurably wrong for our layout:
//
//   * WHICH ONE WINS when the drop overlaps two.  It returns an array.
//   * HOW MUCH OVERLAP COUNTS.  Its default is `partially = true`, whose
//     implementation is literally `overlappingArea > 0` — ONE SQUARE PIXEL.
//     (node_modules/@xyflow/svelte/dist/lib/hooks/useSvelteFlow.svelte.js:90.)
//   * WHETHER THE CARD STAYS WHERE IT LANDED.  Not its business at all.
//
// ⚠ It also resolves a node argument through `store.nodeLookup`, i.e. the
// STORE's position — not the position carried on the drag-stop payload. The
// shipped lane hit-test reads the payload (`n.position`, Canvas.svelte:4422-26)
// and the two e2e drivers deliberately pass synthetic positions that differ
// from the store. Anything that resolves geometry by id would therefore
// silently disagree with lane membership under exactly the tests that exist to
// pin lane membership. So this module takes RECTS, never ids, and the caller
// builds the dragged rect from the payload — mirroring `recomputeLassoHits`
// (Canvas.svelte:5142-5153), the shipped precedent for node-vs-node hit tests.
//
// ── DECISION 2: WHAT OVERLAP COUNTS.  Answer: the dragged card's CENTRE must
// lie inside the candidate. ────────────────────────────────────────────────
// Not a guess, and not a tuned fraction. Two measurements:
//
//  (a) THE LIBRARY DEFAULT IS TOO LOOSE BY THREE ORDERS OF MAGNITUDE. Cards in
//      this app do not merely brush — `findFreeRackSlot` (rack-grid.ts:87)
//      resolves a collision by sliding the card along its row in HP steps of
//      `HP_UNIT` = 180/8 = 22.5 px, and only then jumps a `RACK_UNIT` = 180 px
//      row. So the SMALLEST displacement the app itself ever produces between
//      two cards is 22.5 px, which on a one-U-tall card is 22.5 × 180 =
//      4 050 px² of overlap. A rule that fires at 1 px² fires on every one of
//      those. "Every ordinary lane reshuffle pops a modal" is not a risk here,
//      it is the arithmetic.
//
//  (b) THE APP ALREADY ANSWERED THIS QUESTION, THE SAME WAY. Lane membership —
//      the other "did you drop it on that thing" test in this codebase — probes
//      the card's CENTRE, not its edge:
//
//          const dropCenterY = n.position.y + wcolCardHeightPx(node.type) / 2;
//          const band = laneTargetForFlowPoint({ x: n.position.x, y: dropCenterY }, …)
//
//      and its comment records why an edge test was rejected: a top-edge probe
//      "would unassign it on a 1px nudge during an in-lane reorder"
//      (Canvas.svelte:4415-4419). Adopting centre-containment here means the
//      drop gesture and lane membership answer "am I on it" with ONE rule
//      instead of two that can disagree.
//
// Centre-containment is also scale-free: it needs no per-card tuning, no
// renderer-dependent constant, and no threshold that drifts when card sizes
// change. For two equally-sized cards it is equivalent to "more than half
// overlapped on BOTH axes" — which is what the gesture looks like.
//
// ⚠ REJECTED: the POINTER position. It reads as the more natural hit test
// until you account for the grab offset — you pick a card up by its header, so
// the pointer sits near its top-left and the body trails to the bottom-right.
// The pointer can be over B while the card visibly covers A. The card's own
// centre is the thing the user is aiming, so the centre is what we test.
//
// ── DECISION 1: WHICH NODE WINS ─────────────────────────────────────────
// Ranked by COVERAGE = overlap / min(area(dragged), area(candidate)) — the
// fraction of the SMALLER rect that is covered.
//
// Raw overlap area is biased toward big candidates: clipping the corner of a
// tall card beats being centred on a short one. Normalising by the dragged
// area alone breaks the "drop a big card onto a small one" case (a full cover
// scores small); normalising by the candidate area alone breaks the mirror
// case. `min` is the only denominator under which BOTH full-containment cases
// score 1.0, which is the property we want: fully covering something, or being
// fully inside it, are both unambiguous drops.
//
// Nearest-centre was rejected for the same asymmetry reason (a large card's
// centre can be far away while you are unambiguously inside it), and topmost-z
// because xyflow z is drag/selection order — not something the user is looking
// at or reasoning about.
//
// Ties break by raw overlap px, then centre distance, then id. The last one is
// not a preference: it exists so the decision is a FUNCTION of the geometry.
// A non-deterministic drop target is worse than an arbitrary one, and a test
// cannot pin one.

/** An axis-aligned footprint in FLOW-space px, carrying the node it belongs to.
 *  Same space and same convention as `RackRect` (rack-grid.ts). */
export interface DropRect {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DropCandidateScore {
  id: string;
  /** Overlap in flow px². Reported even for candidates the gate rejects, so a
   *  "no target" answer can be distinguished from "never looked". */
  overlapPx: number;
  /** overlap / min(draggedArea, candidateArea). 1.0 = one fully contains the other. */
  coverage: number;
  /** THE GATE. True when the dragged rect's centre lies inside this candidate. */
  centreInside: boolean;
  /** Euclidean distance between the two centres, flow px. Tie-break only. */
  centreDistance: number;
}

export interface DropTargetDecision {
  /** The claimed node, or null when the gesture was an ordinary move. */
  targetId: string | null;
  /** Every candidate that overlapped AT ALL, ranked. The instrument's raw
   *  reading — present so the sandbox HUD and the tests can both see that a
   *  null answer was a decision rather than a blind spot. */
  ranked: DropCandidateScore[];
  /** Why nothing was claimed. Undefined when `targetId` is set. */
  refusal?: 'no-overlap' | 'centre-outside-every-candidate';
}

/** Overlap of two axis-aligned rects in px². Zero when they merely touch —
 *  the same edge convention as `rectsOverlap` (rack-grid.ts:66). */
export function overlapPx(a: DropRect, b: DropRect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

function centre(r: DropRect): { x: number; y: number } {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

/** True when `point` is strictly inside `r`. Half-open on the far edges so a
 *  card whose centre lands exactly on a seam claims exactly one side. */
function contains(r: DropRect, point: { x: number; y: number }): boolean {
  return point.x >= r.x && point.x < r.x + r.width && point.y >= r.y && point.y < r.y + r.height;
}

/**
 * THE DECISION. Pure: no DOM, no store, no library.
 *
 * `dragged` is built from the drag-stop payload's position plus the card's
 * measured footprint. `candidates` is every other node's rect. The dragged
 * node's own id is excluded if it appears in the list, so a caller may pass the
 * whole node set without filtering.
 */
export function pickDropTarget(
  dragged: DropRect,
  candidates: readonly DropRect[],
): DropTargetDecision {
  const c = centre(dragged);
  const draggedArea = Math.max(dragged.width * dragged.height, 1);

  const ranked: DropCandidateScore[] = [];
  for (const cand of candidates) {
    if (cand.id === dragged.id) continue;
    const px = overlapPx(dragged, cand);
    if (px <= 0) continue;
    const candArea = Math.max(cand.width * cand.height, 1);
    const cc = centre(cand);
    ranked.push({
      id: cand.id,
      overlapPx: px,
      coverage: px / Math.min(draggedArea, candArea),
      centreInside: contains(cand, c),
      centreDistance: Math.hypot(cc.x - c.x, cc.y - c.y),
    });
  }

  ranked.sort(
    (a, b) =>
      Number(b.centreInside) - Number(a.centreInside) ||
      b.coverage - a.coverage ||
      b.overlapPx - a.overlapPx ||
      a.centreDistance - b.centreDistance ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  if (ranked.length === 0) return { targetId: null, ranked, refusal: 'no-overlap' };
  const winner = ranked[0]!;
  if (!winner.centreInside) {
    return { targetId: null, ranked, refusal: 'centre-outside-every-candidate' };
  }
  return { targetId: winner.id, ranked };
}
