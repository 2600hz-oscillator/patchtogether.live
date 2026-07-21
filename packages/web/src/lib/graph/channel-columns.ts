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

/** Column width in flow-space px — a FIXED 16 HP (16 × 22.5 = 360px) so a wider
 *  module fits without per-column auto-sizing. */
export const COLUMN_HP = 16;
export const COLUMN_W = COLUMN_HP * HP_UNIT;

/** The sends rail sits to the RIGHT of the 8 columns; its width matches one
 *  column so a wide FX module fits. */
export const SEND_RAIL_W = COLUMN_W;

/** Flow-space origin of the column band (top-left). Columns and the sends rail
 *  are laid out to the right/below this point. Kept at the flow origin so the
 *  overlay + hit-tests share one coordinate frame. */
export const COLUMN_ORIGIN_X = 0;
export const COLUMN_TOP_Y = 0;

/** Vertical slot pitch — the deterministic per-index stacking height. Most
 *  workflow instruments are 3u (540px); a slot a touch taller leaves a small
 *  gap and keeps position a pure function of the array index. */
export const COLUMN_SLOT_H = RACK_UNIT * 3 + RACK_UNIT / 3; // 600px

/** Left padding inside a column band so cards don't butt the divider. */
export const COLUMN_PAD_X = HP_UNIT; // 22.5px

/** Total vertical extent used to lay out a column (and to split the sends rail
 *  into 2 boxes). Generous — the column scrolls with the canvas anyway. */
export const COLUMN_H = COLUMN_SLOT_H * 8;

// ---------------- Geometry (pure) ----------------

/** The `[x0, x1)` flow-space horizontal band of channel column `ch` (1-based). */
export function columnXBand(ch: number): [number, number] {
  const x0 = COLUMN_ORIGIN_X + (ch - 1) * COLUMN_W;
  return [x0, x0 + COLUMN_W];
}

/** The `[x0, x1)` flow-space band of the sends rail (to the right of column 8). */
export function sendRailXBand(): [number, number] {
  const x0 = COLUMN_ORIGIN_X + COLUMN_COUNT * COLUMN_W;
  return [x0, x0 + SEND_RAIL_W];
}

/**
 * Hit-test a flow-space X to a drop target:
 *   * 1..8            — the channel column at that X.
 *   * 'send'          — the sends rail (which box is resolved by sendBoxForFlowY).
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

/** Which send box (1|2) a flow-space Y lands in — the rail is split top/bottom. */
export function sendBoxForFlowY(y: number): 1 | 2 {
  return y < COLUMN_TOP_Y + COLUMN_H / 2 ? 1 : 2;
}

/** True when a drop Y is in the TOP THIRD of the column band region occupied by
 *  the current members — the "insert at top of chain" affordance. `spanTop` /
 *  `spanBottom` are the current members' vertical extent (top of first slot,
 *  bottom of last). An empty column always returns false (append == prepend). */
export function isTopThirdDrop(dropY: number, spanTop: number, spanBottom: number): boolean {
  if (spanBottom <= spanTop) return false;
  return dropY < spanTop + (spanBottom - spanTop) / 3;
}

/** Deterministic flow-space TOP-LEFT position of the `index`-th member (0-based)
 *  of channel column `ch`. Position is a PURE function of (ch, index): the chain
 *  order IS the on-screen order. Grid-snapped so it lands on the rack grid. */
export function columnMemberPos(ch: number, index: number): { x: number; y: number } {
  const [x0] = columnXBand(ch);
  return snapPositionToGrid({
    x: x0 + COLUMN_PAD_X,
    y: COLUMN_TOP_Y + index * COLUMN_SLOT_H,
  });
}

/** Deterministic flow-space TOP-LEFT position of the `index`-th send tenant of
 *  send box `slot` (1|2). The two boxes stack in the rail's vertical half. */
export function sendMemberPos(slot: number, index: number): { x: number; y: number } {
  const [x0] = sendRailXBand();
  const boxTop = COLUMN_TOP_Y + (slot - 1) * (COLUMN_H / 2);
  return snapPositionToGrid({
    x: x0 + COLUMN_PAD_X,
    y: boxTop + index * COLUMN_SLOT_H,
  });
}

/** The flow-space position for appending a new member at the BOTTOM of column
 *  `ch` given the current member count. */
export function columnBottomFlowPos(ch: number, currentCount: number): { x: number; y: number } {
  return columnMemberPos(ch, currentCount);
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
