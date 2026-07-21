// packages/web/src/lib/graph/channel-columns.ts
//
// WORKFLOW CHANNEL COLUMNS — PURE geometry + ordered-membership array helpers.
//
// The workflow-mode canvas is projected as 8 numbered CHANNEL COLUMNS (1..8) with
// a SENDS rail (SEND 1 / SEND 2) to their right. A module dropped/added in a
// column joins that channel's vertical DSP chain (source → filter → reverb →
// mixer channel); a module dropped in a send box joins that aux-send loop.
//
// SCHEMA (the load-bearing collab design — see workflow-mode-channel-columns):
//   * MEMBERSHIP truth = a scalar on the member node: `data.channel: 1..8` (a
//     column member) or `data.sendSlot: 1|2` (a send tenant). An independent
//     CRDT key on an independent node → no last-writer-wins loss.
//   * ORDER = an explicit `string[]` per column on the pinned-mixmstrs node
//     (`data.columns['1'..'8']` / `data.sends['1'|'2']`). The chain is a PURE
//     function of this array; on-screen slot is COMPUTED from the array index
//     (position = render output), so a drag-nudge can never reorder the chain
//     and per-user layouts stay free.
//   * A lost concurrent append (node has data.channel===ch but is missing from
//     the order array — the array is last-writer-wins in a Y.Map value) SELF-
//     HEALS: reconcileColumnOrder ADOPTS it at the bottom (sorted for cross-peer
//     determinism), which is the feature's own "added at bottom" semantic.
//
// PURE — no Svelte / Yjs / DOM. Geometry reuses the rack-grid pitches; the
// Canvas owns the side effects (Yjs writes, reading nodeFootprintPx from the DOM).

import { HP_UNIT, RACK_UNIT, snapPositionToGrid } from '$lib/ui/rack-grid';

// ---------------- Constants ----------------

/** The workflow view has exactly 8 channel columns (= the 8 mixmstrs channels).
 *  HARD CAP — no scroll/page beyond 8. */
export const COLUMN_COUNT = 8;

/** Number of aux-send boxes in the sends rail (= the 2 mixmstrs aux sends). */
export const SEND_BOX_COUNT = 2;

/** Column width in flow-space px. A FIXED 34 HP (34 × 22.5 = 765px) so the
 *  WIDEST workflow cards fit WITHOUT clipping: tidyvco + sixstrum are 4hp = 720px
 *  wide, and with the 22.5px left pad (COLUMN_PAD_X) the card's right edge lands
 *  at 742.5px, leaving a 22.5px right gutter before the divider (owner: "columns
 *  must be wide enough to hold tidyvco AND sixstrum without clipping"). The send
 *  boxes track this width (SEND_BOX_W = COLUMN_W). */
export const COLUMN_HP = 34;
export const COLUMN_W = COLUMN_HP * HP_UNIT;

/** Each aux-send box is one column wide; the two boxes sit SIDE BY SIDE to the
 *  right of column 8 (owner: "the send columns should be next to each other").
 *  (Width standardization is a deliberate follow-up.) */
export const SEND_BOX_W = COLUMN_W;
export const SEND_RAIL_W = SEND_BOX_W * SEND_BOX_COUNT;

/** Flow-space origin of the column band (top-left). Columns and the sends rail
 *  are laid out to the right of this point. Kept at the flow origin so the
 *  overlay + hit-tests share one coordinate frame. */
export const COLUMN_ORIGIN_X = 0;
export const COLUMN_TOP_Y = 0;

/** Vertical slot pitch — the deterministic per-index stacking height. A clean
 *  4u (RACK_UNIT × 4 = 720px) multiple so a 3u instrument fits with a 1u gap AND
 *  every derived slot Y lands on the 180px rack grid (snap is a no-op). Keeps
 *  position a pure function of the array index. */
export const COLUMN_SLOT_H = RACK_UNIT * 4; // 720px (grid-aligned)

/** Left padding inside a column band so cards don't butt the divider. */
export const COLUMN_PAD_X = HP_UNIT; // 22.5px

/** The number of slots budgeted above the baseline before a column overflows
 *  upward (visual band height). Columns are BOTTOM-ANCHORED: the tail (output)
 *  sits just above the baseline near the channel number, and members stack
 *  UPWARD, so a newly-added module lands at the BOTTOM (owner: "snap to the
 *  bottom, not the top"). */
export const COLUMN_MAX_SLOTS = 6;
export const COLUMN_H = COLUMN_SLOT_H * COLUMN_MAX_SLOTS;

/** The flow-space Y BASELINE the columns bottom-anchor to — where the numbered
 *  1..8 labels sit. Member `i` of a `total`-member column is placed ABOVE it. */
export const COLUMN_BASELINE_Y = COLUMN_TOP_Y + COLUMN_H;

// ---------------- Geometry (pure) ----------------

/** The `[x0, x1)` flow-space horizontal band of channel column `ch` (1-based). */
export function columnXBand(ch: number): [number, number] {
  const x0 = COLUMN_ORIGIN_X + (ch - 1) * COLUMN_W;
  return [x0, x0 + COLUMN_W];
}

/** The `[x0, x1)` flow-space band of send box `slot` (1|2) — SIDE BY SIDE right
 *  of column 8. */
export function sendBoxXBand(slot: number): [number, number] {
  const railX0 = COLUMN_ORIGIN_X + COLUMN_COUNT * COLUMN_W;
  const x0 = railX0 + (slot - 1) * SEND_BOX_W;
  return [x0, x0 + SEND_BOX_W];
}

/** The `[x0, x1)` flow-space band of the WHOLE sends rail (both boxes). */
export function sendRailXBand(): [number, number] {
  const x0 = COLUMN_ORIGIN_X + COLUMN_COUNT * COLUMN_W;
  return [x0, x0 + SEND_RAIL_W];
}

/**
 * Hit-test a flow-space X to a drop target:
 *   * 1..8            — the channel column at that X.
 *   * 'send'          — the sends rail (which box is resolved by sendBoxForFlowX).
 *   * null            — outside the workflow bands (free canvas).
 */
export function columnForFlowX(x: number): number | 'send' | null {
  const [railX0, railX1] = sendRailXBand();
  if (x >= railX0 && x < railX1) return 'send';
  if (x < COLUMN_ORIGIN_X) return null;
  const idx = Math.floor((x - COLUMN_ORIGIN_X) / COLUMN_W);
  if (idx < 0 || idx >= COLUMN_COUNT) return null;
  return idx + 1;
}

/** Which send box (1|2) a flow-space X lands in — the two boxes are side by
 *  side, so it's an X hit-test (not Y). */
export function sendBoxForFlowX(x: number): 1 | 2 {
  const railX0 = COLUMN_ORIGIN_X + COLUMN_COUNT * COLUMN_W;
  return x < railX0 + SEND_BOX_W ? 1 : 2;
}

/**
 * Deterministic flow-space TOP-LEFT position of member `index` (0-based, 0 = top
 * / source) of a `total`-member column `ch`. BOTTOM-ANCHORED: the tail
 * (index = total-1) sits one slot above the baseline (near the number), and
 * earlier members stack UPWARD — so appending a member lands it at the bottom.
 * Position is a PURE function of (ch, index, total): the chain order IS the
 * on-screen order. Grid-snapped.
 */
export function columnMemberPos(ch: number, index: number, total: number): { x: number; y: number } {
  const [x0] = columnXBand(ch);
  const n = Math.max(total, index + 1);
  return snapPositionToGrid({
    x: x0 + COLUMN_PAD_X,
    y: COLUMN_BASELINE_Y - (n - index) * COLUMN_SLOT_H,
  });
}

/** Deterministic TOP-LEFT position of send-box `slot` tenant `index` of `total`
 *  — bottom-anchored like a column, in the box's own X band. */
export function sendMemberPos(slot: number, index: number, total: number): { x: number; y: number } {
  const [x0] = sendBoxXBand(slot);
  const n = Math.max(total, index + 1);
  return snapPositionToGrid({
    x: x0 + COLUMN_PAD_X,
    y: COLUMN_BASELINE_Y - (n - index) * COLUMN_SLOT_H,
  });
}

/** The flow-space position for a NEW member appended at the BOTTOM of column
 *  `ch` that currently has `currentCount` members (the new bottom slot). */
export function columnBottomFlowPos(ch: number, currentCount: number): { x: number; y: number } {
  return columnMemberPos(ch, currentCount, currentCount + 1);
}

/**
 * FLUSH bottom-up stacking (owner: "modules stack at the BOTTOM and grow UPWARD,
 * sitting directly on top of each other with NO vertical space between them").
 * Given each member's PIXEL height in array order (index 0 = TOP of the visual
 * stack, last = BOTTOM), returns the top-left flow-space position of every
 * member such that:
 *   - the LAST (bottom) member's BOTTOM edge sits exactly on COLUMN_BASELINE_Y,
 *   - each earlier member sits FLUSH directly on top of the one below it (its
 *     bottom edge == the next member's top edge — zero gap),
 *   - a single member therefore lands at the very bottom of the column.
 * Position is a PURE function of (ch, heights) — heights are derived from each
 * member's rack tier (a per-TYPE constant), so every peer computes the SAME
 * layout (collab-convergent). X is the column's left pad; Y is exact (heights are
 * rack-grid multiples, so the result is grid-aligned without a snap step).
 */
export function columnFlushPositions(
  ch: number,
  heightsPx: readonly number[],
): { x: number; y: number }[] {
  const [x0] = columnXBand(ch);
  const x = x0 + COLUMN_PAD_X;
  const out: { x: number; y: number }[] = new Array(heightsPx.length);
  let bottom = COLUMN_BASELINE_Y;
  for (let i = heightsPx.length - 1; i >= 0; i--) {
    const top = bottom - (heightsPx[i] ?? COLUMN_SLOT_H);
    out[i] = { x, y: top };
    bottom = top;
  }
  return out;
}

/** Send-box twin of columnFlushPositions — flush bottom-up in the box's own X
 *  band. */
export function sendFlushPositions(
  slot: number,
  heightsPx: readonly number[],
): { x: number; y: number }[] {
  const [x0] = sendBoxXBand(slot);
  const x = x0 + COLUMN_PAD_X;
  const out: { x: number; y: number }[] = new Array(heightsPx.length);
  let bottom = COLUMN_BASELINE_Y;
  for (let i = heightsPx.length - 1; i >= 0; i--) {
    const top = bottom - (heightsPx[i] ?? COLUMN_SLOT_H);
    out[i] = { x, y: top };
    bottom = top;
  }
  return out;
}

/** The flow-space position for a NEW tenant appended at the BOTTOM of send box
 *  `slot` that currently has `currentCount` tenants. */
export function sendBottomFlowPos(slot: number, currentCount: number): { x: number; y: number } {
  return sendMemberPos(slot, currentCount, currentCount + 1);
}

/**
 * Compute the insert INDEX for a reorder drop: where in the current member list
 * a member dropped at `dropY` should land. `memberCenters` are the current
 * members' slot-center Y positions IN ORDER (excluding the dragged member).
 * Returns the count when the drop is below every sibling (append).
 */
export function indexForDropY(memberCenters: readonly number[], dropY: number): number {
  let i = 0;
  while (i < memberCenters.length && dropY > memberCenters[i]!) i++;
  return i;
}

// ---------------- Ordered-membership array helpers (pure, CRDT-safe) ----------------

/** Minimal node view the membership reconciler reads — the id + the scalar
 *  membership keys (`data.channel` / `data.sendSlot`). */
export interface ColumnNodeView {
  id: string;
  /** node.data.channel (1..8) — column membership truth, or undefined. */
  channel?: number;
  /** node.data.sendSlot (1|2) — send membership truth, or undefined. */
  sendSlot?: number;
}

/** De-duplicate an id array preserving FIRST occurrence order. */
export function dedup(order: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of order) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Reconcile ONE column's order array against the live membership truth
 * (`data.channel`). PURE + idempotent + collab-convergent:
 *   1. KEEP the current order, dropping ids that no longer exist OR whose
 *      data.channel !== ch (a stale/moved/deleted member), de-duped.
 *   2. ADOPT-at-bottom any node whose data.channel === ch that is MISSING from
 *      the kept order (a lost concurrent append), appended in SORTED id order so
 *      every peer converges on the same tail ordering.
 * The result is the healed order; re-running it on its own output is a no-op.
 */
export function reconcileColumnOrder(
  currentOrder: readonly string[],
  ch: number,
  nodes: ReadonlyMap<string, ColumnNodeView>,
): string[] {
  const keep = dedup(currentOrder).filter((id) => nodes.get(id)?.channel === ch);
  const present = new Set(keep);
  const adopted: string[] = [];
  for (const v of nodes.values()) {
    if (v.channel === ch && !present.has(v.id)) adopted.push(v.id);
  }
  adopted.sort();
  return [...keep, ...adopted];
}

/** Reconcile ONE send box's order array against `data.sendSlot` — the send-loop
 *  twin of reconcileColumnOrder (same prune + adopt-at-bottom discipline). */
export function reconcileSendOrder(
  currentOrder: readonly string[],
  slot: number,
  nodes: ReadonlyMap<string, ColumnNodeView>,
): string[] {
  const keep = dedup(currentOrder).filter((id) => nodes.get(id)?.sendSlot === slot);
  const present = new Set(keep);
  const adopted: string[] = [];
  for (const v of nodes.values()) {
    if (v.sendSlot === slot && !present.has(v.id)) adopted.push(v.id);
  }
  adopted.sort();
  return [...keep, ...adopted];
}

/** Append `id` at the BOTTOM of `order` (no-op if already present). */
export function insertBottom(order: readonly string[], id: string): string[] {
  return order.includes(id) ? [...order] : [...order, id];
}

/** Insert `id` at the TOP of `order` (no-op if already present). */
export function insertTop(order: readonly string[], id: string): string[] {
  return order.includes(id) ? [...order] : [id, ...order];
}

/** Remove `id` from `order`. */
export function removeFrom(order: readonly string[], id: string): string[] {
  return order.filter((x) => x !== id);
}

/**
 * Move `id` to `newIndex` within `order` (a reorder). The index is interpreted
 * against the array WITH `id` removed, so `newIndex === length-after-removal`
 * means "to the end". Clamped. No-op if `id` is absent.
 */
export function reorder(order: readonly string[], id: string, newIndex: number): string[] {
  if (!order.includes(id)) return [...order];
  const without = order.filter((x) => x !== id);
  const idx = Math.max(0, Math.min(without.length, Math.trunc(newIndex)));
  return [...without.slice(0, idx), id, ...without.slice(idx)];
}

/** Result of moving a member between two columns/boxes. */
export interface MoveResult {
  from: string[];
  to: string[];
}

/**
 * Move `id` out of `fromOrder` and append it at the bottom of `toOrder`. Used
 * for a cross-column drag (and column→send / send→column). If `id` isn't in
 * `fromOrder` it is still added to `toOrder` (the membership scalar is truth;
 * this keeps the order arrays consistent with it).
 */
export function moveBetween(
  fromOrder: readonly string[],
  toOrder: readonly string[],
  id: string,
): MoveResult {
  return { from: removeFrom(fromOrder, id), to: insertBottom(toOrder, id) };
}
