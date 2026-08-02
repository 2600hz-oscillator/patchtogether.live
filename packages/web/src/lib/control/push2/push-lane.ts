// packages/web/src/lib/control/push2/push-lane.ts
//
// WHICH MODULE'S PUSH CARD is on the Push 2 screen — the lane membership +
// focus rules behind the owner's spec:
//
//   "when we select a channel, we see the push card for the most recent module
//    added to the lane, or, the most recent module viewed on the push if we've
//    viewed the lane previously in this rack"
//
// PURE — no Yjs, no localStorage, no DOM. The caller passes the node map and
// the pinned mixer's `data`; the remembered-focus half is persistence and lives
// in push2-view.svelte.ts. Everything here is a function of its arguments, so
// the whole selection rule is node-testable.
//
// ── THE ORDERING ALREADY EXISTS; WE DO NOT INVENT ONE ─────────────────────
//
// Workflow lane membership is a scalar on the member node (`data.channel`,
// 1..8 — CRDT-safe, an independent key), and the ORDER is an explicit
// `string[]` per column on the pinned mixer
// (`patch.nodes['pinned-mixmstrs'].data.columns['1'..'8']`).
//
// Every add site APPENDS (`insertBottom`), and `reconcileColumnOrder`'s
// adopt-pass appends too — so **the LAST live element of the array is the most
// recently added module**. `columnFlushPositions` anchors index 0 at the column
// BOTTOM and stacks upward, so the array tail is also the TOP tile on canvas,
// which is what "most recent" looks like to the owner.
//
// We reuse `reconcileColumnOrder` itself rather than reading the raw array:
// it prunes members that left the lane and ADOPTS a node whose `data.channel`
// says it belongs but that a lost concurrent write dropped from the array. So
// the Push heals exactly as the canvas does, from the same function.
//
// ⚠ TWO HONEST CAVEATS (both stated to the owner rather than papered over):
//   1. The array is POSITION order, not a timestamp. A user drag-REORDER moves
//      a module to the tail without it being newly added, so "most recent" and
//      "top tile" diverge after a deliberate reorder. Adding a monotonic
//      counter to the Y.Doc to fix that costs a schema field for a case where
//      "the top module in the lane" is almost certainly what is wanted.
//   2. VIDEO modules never get `data.channel` (the Canvas refuses a column drop
//      for `domain === 'video'` — the video zone owns them), so no video module
//      can appear in any lane. The generic VIDEO push card is authored and
//      currently UNREACHABLE through lane select. See the PR body.

import { COLUMN_COUNT, reconcileColumnOrder, type ColumnNodeView } from '$lib/graph/channel-columns';

/** Lanes on the Push = workflow channel columns = mixmstrs channels. */
export const PUSH_LANE_COUNT = COLUMN_COUNT;

/** Hardest a single encoder message may move the card selection. `decodeRelativeCc`
 *  can legitimately return ±63 on a hard flick; letting that through would jump
 *  the whole list instead of "one card at a time". */
export const MAX_SCROLL_STEP = 4;

/** The slice of a node this module reads — deliberately structural so a test
 *  can hand it plain objects and so nothing here depends on ModuleNode. */
export interface LaneNodeLike {
  data?: { channel?: unknown } | undefined;
}

/** The slice of the pinned mixer's `data` that carries the column order. */
export interface LaneColumnsData {
  columns?: Record<string, string[] | undefined> | undefined;
}

function channelOf(node: LaneNodeLike | undefined): number | undefined {
  const c = node?.data?.channel;
  return typeof c === 'number' && Number.isFinite(c) ? c : undefined;
}

/**
 * The live, ordered member ids of lane `lane` (1..8), bottom tile first and the
 * MOST RECENTLY ADDED last. Out-of-range lanes are empty.
 *
 * Runs the order array through `reconcileColumnOrder` so a member that left the
 * lane is pruned and a member the array lost is adopted at the tail — the same
 * heal the canvas applies, from the same function.
 */
export function laneMembers(
  nodes: Record<string, LaneNodeLike | undefined>,
  mixerData: LaneColumnsData | undefined,
  lane: number,
): string[] {
  if (!Number.isInteger(lane) || lane < 1 || lane > PUSH_LANE_COUNT) return [];
  const views = new Map<string, ColumnNodeView>();
  for (const [id, n] of Object.entries(nodes)) {
    if (!n) continue;
    views.set(id, { id, channel: channelOf(n) });
  }
  return reconcileColumnOrder(mixerData?.columns?.[String(lane)] ?? [], lane, views);
}

/**
 * WHICH member the Push shows for a lane, per the owner's rule.
 *
 * `remembered` is the last module VIEWED on the Push for this lane in this rack
 * (null if the lane was never viewed). It wins when it is still in the lane;
 * otherwise — never viewed, or the remembered module was deleted / moved to
 * another lane / removed by a peer — the focus falls to the MOST RECENTLY ADDED
 * member, i.e. the array TAIL. The caller rewrites the memory on that fall-back
 * so the two converge instead of drifting.
 */
export function resolveLaneFocus(
  members: readonly string[],
  remembered: string | null,
): string | null {
  if (remembered && members.includes(remembered)) return remembered;
  return members.length ? members[members.length - 1] : null;
}

/** Clamp a raw relative-encoder delta to at most one card per detent-burst. */
export function clampScrollDelta(delta: number): number {
  if (!Number.isFinite(delta)) return 0;
  return Math.max(-MAX_SCROLL_STEP, Math.min(MAX_SCROLL_STEP, Math.trunc(delta)));
}

/**
 * Step the focused module within a lane — the #2-from-the-left encoder.
 *
 * WRAPS rather than clamping. The owner's word is "flips THROUGH the push cards
 * for the modules in the lane", and a lane holds a handful of modules (the
 * column lays out 6 slots), so a wrap is a one- or two-detent trip back to the
 * other end and never leaves you stuck at an edge wondering if the encoder
 * broke. A clamp would make the two ends behave differently from the middle for
 * no benefit at this list length.
 *
 * An unknown `currentId` (the focused module was just deleted) restarts from
 * the tail — the same "most recently added" default a fresh lane select gets.
 */
export function stepLaneFocus(
  members: readonly string[],
  currentId: string | null,
  delta: number,
): string | null {
  if (!members.length) return null;
  const step = clampScrollDelta(delta);
  const cur = currentId ? members.indexOf(currentId) : -1;
  if (cur < 0) return members[members.length - 1];
  if (step === 0) return members[cur];
  const n = members.length;
  return members[(((cur + step) % n) + n) % n];
}

/** 1-based position of `id` within `members`, or null. Counts from array index
 *  0 = "1" — the FIRST-added / bottom tile — so the default focus (the tail)
 *  reads as "N/N". (Owner question: count from the bottom, as here, or from the
 *  top so the default reads "1/N"? One line either way.) */
export function laneFocusIndex(members: readonly string[], id: string | null): number | null {
  if (!id) return null;
  const i = members.indexOf(id);
  return i < 0 ? null : i + 1;
}
