// Organize-modules layout pass.
//
// User intent: pack modules tightly while preserving the user's "hand of the
// artist" arrangement. The previous declutter-only pass left big gaps and
// only nudged overlapping pairs apart, which felt timid: a layout that drifts
// across the canvas as the patch grows never recovers space the user wishes
// they had back.
//
// The new pass is a row-pack:
//
//   1. Sort by current y (rows preserved top-to-bottom). Stable tiebreak on x.
//   2. Walk sorted modules, packing each into the current row if it fits within
//      `viewport.width`; otherwise wrap to a new row whose y is the previous
//      row's y + max(row height) + GAP.
//   3. Within each row, x is laid out left-to-right with GAP between cards,
//      starting at GAP from `viewport.originX`. Row y starts at GAP from
//      `viewport.originY`.
//   4. All output positions are integer-snapped (Math.round) so xyflow doesn't
//      drift on subpixel rounding.
//
// Why this preserves relative arrangement:
//   - "Upper-left stays upper-left" because we sort by y first → that module
//     is in the topmost row, and its (smallest) x within the row keeps it
//     left-most in that row.
//   - "Lower-right stays lower-right" symmetrically: largest y → bottom row;
//     largest x within → right side of that row.
//   - We never sort by id / type / alphabetical, so "the user's intent" is
//     entirely captured by the relative pre-pass position ordering.
//
// Why it's idempotent:
//   - After one pass, the modules' y values are exactly the row baselines, and
//     their x values are monotonically increasing within each row. Re-sorting
//     by (y, x) yields the same row partition, and packing left-to-right at
//     the same `originX + GAP` cadence reproduces the same x. Ergo:
//     `organize(organize(L)) === organize(L)`.
//
// Variable sizes:
//   - Each row's height is `max(box.h)` for boxes assigned to that row.
//     Wrapping uses `viewport.width` measured in flow-space (caller passes
//     dom width / current zoom).
//
// Fallback (no viewport): when callers don't supply viewport dimensions we
// estimate one from the boxes themselves so the function still produces a
// dense pack (used by unit tests + any caller that hasn't measured the DOM
// yet). The estimate is `~sqrt(N) × averageWidth` which targets a roughly
// square layout — same shape the user sees on a 16:9 canvas.
//
// We considered (and rejected): a true rectangle bin-packer (skyline / MAXRECTS).
// They produce tighter packs but reorder modules to fit, which trashes the
// "preserve arrangement" goal. They also aren't idempotent — once tightly
// packed, a re-run can shuffle modules into different bins. Row-pack keeps
// the user's eye-line intact.
//
// Pure-data, no DOM, no xyflow — easy to unit test.

export interface Box {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OrganizedPosition {
  id: string;
  x: number;
  y: number;
}

const DEFAULT_GAP_PX = 24;
const DEFAULT_VIEWPORT_FALLBACK_PADDING = 0;

export interface OrganizeViewport {
  /** Visible width in flow-space (DOM clientWidth / zoom). */
  width: number;
  /** Visible height in flow-space. Used as a soft hint for fallback sizing. */
  height: number;
  /** Top-left of the visible region in flow-space. Defaults to {0,0}. */
  originX?: number;
  originY?: number;
}

export interface OrganizeOptions {
  /** Spacing between adjacent boxes (and from the viewport edge). */
  gap?: number;
  /** Visible canvas in flow-space. When omitted, an estimate is used. */
  viewport?: OrganizeViewport;
  /** @deprecated Use `gap`. Kept for back-compat with existing callers. */
  minGap?: number;
  /** @deprecated No-op in the row-pack algorithm. Retained for API stability. */
  maxIterations?: number;
}

/**
 * Pack a set of bounding boxes into a tight row-major layout that preserves
 * the user's relative arrangement (top → bottom, left → right within each
 * row).
 *
 * Stable + idempotent: identical input → identical output, and a second pass
 * over already-organized boxes produces the same positions.
 *
 * @param boxes     The current bounding boxes. `x/y` is top-left in flow-space,
 *                  `w/h` is the rendered size. Read-only — not mutated.
 * @param options   `gap`, `viewport`, etc. See {@link OrganizeOptions}.
 * @returns         New positions for every input box, sorted by id for stable
 *                  diffs (callers reapply by id, not by index).
 */
export function organizeLayout(
  boxes: readonly Box[],
  options: OrganizeOptions = {},
): OrganizedPosition[] {
  const gap = options.gap ?? options.minGap ?? DEFAULT_GAP_PX;

  if (boxes.length === 0) return [];
  if (boxes.length === 1) {
    const only = boxes[0];
    return [{ id: only.id, x: Math.round(only.x), y: Math.round(only.y) }];
  }

  const viewport = resolveViewport(boxes, options.viewport, gap);
  const originX = viewport.originX ?? 0;
  const originY = viewport.originY ?? 0;

  // Stable sort by (y, x, id). y first → top rows stay on top.
  // x second → left modules stay left within their row.
  // id third → break ties so two clients with the same input agree.
  const ordered = boxes.slice().sort((a, b) => {
    if (a.y !== b.y) return a.y - b.y;
    if (a.x !== b.x) return a.x - b.x;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  // Row-pack. Each row holds a list of boxes; row width grows as we add.
  const rows: { boxes: Box[]; width: number; height: number }[] = [];
  // Available row width = viewport - left/right margin (gap on each side).
  const usableWidth = Math.max(viewport.width - gap * 2, 0);

  for (const b of ordered) {
    const row = rows[rows.length - 1];
    // Width that adding this box would consume in the current row, including
    // the inter-box gap that precedes it.
    const addedWidth = row && row.boxes.length > 0 ? gap + b.w : b.w;
    if (
      row &&
      // Always allow at least one box per row (a single oversized module
      // shouldn't break the loop — it just owns its row).
      (row.boxes.length === 0 || row.width + addedWidth <= usableWidth)
    ) {
      row.boxes.push(b);
      row.width += addedWidth;
      if (b.h > row.height) row.height = b.h;
    } else {
      rows.push({ boxes: [b], width: b.w, height: b.h });
    }
  }

  // Lay out: top-left at (originX + gap, originY + gap).
  const positions = new Map<string, OrganizedPosition>();
  let cursorY = originY + gap;
  for (const row of rows) {
    let cursorX = originX + gap;
    for (const b of row.boxes) {
      positions.set(b.id, {
        id: b.id,
        x: Math.round(cursorX),
        y: Math.round(cursorY),
      });
      cursorX += b.w + gap;
    }
    cursorY += row.height + gap;
  }

  // Return in id-sorted order for stable diffs (callers re-apply by id).
  return [...positions.values()].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
}

/**
 * When no viewport is supplied, estimate one from the input. We aim for a
 * roughly square pack (~sqrt(N) columns), which matches the shape of a real
 * 16:9 canvas when viewed from a comfortable zoom level.
 */
function resolveViewport(
  boxes: readonly Box[],
  given: OrganizeViewport | undefined,
  gap: number,
): OrganizeViewport {
  if (given) return given;
  // Estimate: pick column count from sqrt(N), then sum widest-N widths.
  const n = boxes.length;
  const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
  // Use the max width among inputs as a conservative per-cell width so the
  // widest module always fits. Same for height.
  let maxW = 0;
  let maxH = 0;
  for (const b of boxes) {
    if (b.w > maxW) maxW = b.w;
    if (b.h > maxH) maxH = b.h;
  }
  const width = cols * maxW + (cols + 1) * gap + DEFAULT_VIEWPORT_FALLBACK_PADDING;
  const rows = Math.ceil(n / cols);
  const height = rows * maxH + (rows + 1) * gap + DEFAULT_VIEWPORT_FALLBACK_PADDING;
  return { width, height, originX: 0, originY: 0 };
}

/**
 * Returns true iff no two boxes overlap (after applying the new positions).
 * Helper for tests + an in-app post-condition check.
 */
export function hasNoOverlaps(
  boxes: readonly Box[],
  positions: readonly OrganizedPosition[],
): boolean {
  const byId = new Map(positions.map((p) => [p.id, p]));
  const placed = boxes.map((b) => {
    const p = byId.get(b.id);
    return { id: b.id, x: p?.x ?? b.x, y: p?.y ?? b.y, w: b.w, h: b.h };
  });
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i];
      const b = placed[j];
      const xOverlap = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const yOverlap = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (xOverlap > 0.5 && yOverlap > 0.5) return false;
    }
  }
  return true;
}

export const ORGANIZE_DEFAULTS = Object.freeze({
  gap: DEFAULT_GAP_PX,
  // Back-compat keys for any caller that read these.
  minGap: DEFAULT_GAP_PX,
  maxIterations: 1,
});
