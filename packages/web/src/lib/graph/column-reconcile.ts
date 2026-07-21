// packages/web/src/lib/graph/column-reconcile.ts
//
// WORKFLOW CHANNEL COLUMNS — the RECONCILER APPLICATOR (the store-touching seam
// that commits the PURE plans from channel-columns.ts + patch-convenience.ts).
//
// Two idempotent, collab-convergent passes, both run from the Canvas graph-change
// $effect (so they self-heal on every peer, even a peer-driven change):
//
//   1. reconcileColumnMembership() — MEMBERSHIP ORDER heal. Reads the order
//      arrays off the pinned-mixmstrs node (data.columns / data.sends), reconciles
//      each against the live membership truth (each member's data.channel /
//      data.sendSlot), and writes back any changed array with a SINGLE-KEY in-
//      place mutation (never a whole-map rebuild — [[yjs-save-load-real-ydoc]]).
//      A lost concurrent append (a node whose data.channel===ch but is missing
//      from columns[ch]) is ADOPTED at the bottom — the feature's own semantic.
//
//   2. reconcileColumnWiring() — the reconciler-OWNED edge set. Plans every
//      column's + send's desired wcol- edges (planColumnWiring / planSendWiring
//      drive the reused planClipControl / planPairLink / planSendToMixer), then
//      diffs the GLOBAL desired set against the present wcol- edges:
//        * writes desired\present,
//        * deletes present\desired  (stale wcol edges — the un-route + delete-heal),
//        * YIELDS a link whose target port already holds a NON-wcol (hand-drawn)
//          cable, and
//        * DROPS any desired edge that fails validateEdge (so one malformed edge
//          can't abort the whole reconcile pass for every peer).
//      The `wcol-` namespace means the stale-removal pass structurally CANNOT
//      touch a hand-drawn cable. Deterministic edge ids make two peers converge.
//
// Both write under AUTO_JANITOR_ORIGIN (non-undo-tracked): the passes run on
// every client from the graph seam, so a peer-driven change must never plant
// phantom undo items. Idempotent by construction (no writes when already
// converged), so concurrent peers all settle to the same graph.

import { patch, ydoc } from '$lib/graph/store';
import { AUTO_JANITOR_ORIGIN } from './automation-assign';
import type { Edge, ModuleNode } from './types';
import { validateEdge } from './validate-edge';
import {
  COLUMN_COUNT,
  SEND_BOX_COUNT,
  reconcileColumnOrder,
  reconcileSendOrder,
  type ColumnNodeView,
} from './channel-columns';
import {
  planColumnWiring,
  planSendWiring,
  type ColumnMember,
  type ConvenienceDef,
  type WcolEdge,
} from './patch-convenience';

/** Deterministic ids of the workflow pinned singletons the columns anchor to. */
export const PINNED_MIXER_ID = 'pinned-mixmstrs';
export const PINNED_CLIP_ID = 'pinned-clipplayer';

/** Namespace prefix for reconciler-owned edges (wcolEdgeId writes this). */
const WCOL_EDGE_PREFIX = 'wcol-e-';

/** A (type) → full-def lookup — the Canvas passes its defLookup chain
 *  (getModuleDef ?? getVideoModuleDef ?? getMetaModuleDef). Must return the FULL
 *  def (with stereoPairs + chainWiring) so the wiring planners resolve correctly. */
export type ColumnDefResolver = (type: string) => ConvenienceDef | undefined;

/** The columns/sends order maps stored on the pinned-mixmstrs node.data. */
interface MixerColumnsData {
  columns?: Record<string, string[]>;
  sends?: Record<string, string[]>;
}

function channelOf(node: ModuleNode | undefined): number | undefined {
  const c = (node?.data as { channel?: unknown } | undefined)?.channel;
  return typeof c === 'number' && Number.isFinite(c) ? c : undefined;
}
function sendSlotOf(node: ModuleNode | undefined): number | undefined {
  const s = (node?.data as { sendSlot?: unknown } | undefined)?.sendSlot;
  return typeof s === 'number' && Number.isFinite(s) ? s : undefined;
}

function buildNodeViews(): Map<string, ColumnNodeView> {
  const m = new Map<string, ColumnNodeView>();
  for (const [id, n] of Object.entries(patch.nodes)) {
    if (!n) continue;
    m.set(id, { id, channel: channelOf(n as ModuleNode), sendSlot: sendSlotOf(n as ModuleNode) });
  }
  return m;
}

function arrayEq(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * MEMBERSHIP ORDER heal (pass 1). Reconciles every column + send order array on
 * the pinned-mixmstrs node against the live membership truth. Returns true when
 * something was written. No transaction when already converged (idempotent).
 */
export function reconcileColumnMembership(): boolean {
  const mixer = patch.nodes[PINNED_MIXER_ID] as ModuleNode | undefined;
  if (!mixer) return false;
  const views = buildNodeViews();
  const data = (mixer.data ?? {}) as MixerColumnsData;
  const curCols = data.columns ?? {};
  const curSends = data.sends ?? {};

  const nextCols: Record<string, string[]> = {};
  const nextSends: Record<string, string[]> = {};
  let changed = false;

  for (let ch = 1; ch <= COLUMN_COUNT; ch++) {
    const key = String(ch);
    const healed = reconcileColumnOrder(curCols[key] ?? [], ch, views);
    nextCols[key] = healed;
    if (!arrayEq(curCols[key] ?? [], healed)) changed = true;
  }
  for (let s = 1; s <= SEND_BOX_COUNT; s++) {
    const key = String(s);
    const healed = reconcileSendOrder(curSends[key] ?? [], s, views);
    nextSends[key] = healed;
    if (!arrayEq(curSends[key] ?? [], healed)) changed = true;
  }
  if (!changed) return false;

  ydoc.transact(() => {
    const live = patch.nodes[PINNED_MIXER_ID] as ModuleNode | undefined;
    if (!live) return;
    if (!live.data) live.data = {};
    const d = live.data as MixerColumnsData;
    if (!d.columns) d.columns = {};
    if (!d.sends) d.sends = {};
    // Single-key in-place writes — only the arrays that changed. Assigning a new
    // plain array to ONE key of the columns/sends map is the allowed pattern
    // (mirrors assignAutomationLane's d.autoAssign[id] = L); we never rebuild the
    // whole columns/sends Y.Map.
    for (let ch = 1; ch <= COLUMN_COUNT; ch++) {
      const key = String(ch);
      if (!arrayEq(d.columns[key] ?? [], nextCols[key]!)) d.columns[key] = nextCols[key]!;
    }
    for (let s = 1; s <= SEND_BOX_COUNT; s++) {
      const key = String(s);
      if (!arrayEq(d.sends[key] ?? [], nextSends[key]!)) d.sends[key] = nextSends[key]!;
    }
  }, AUTO_JANITOR_ORIGIN);
  return true;
}

/** Resolve an ordered id list to {nodeId, def} members (dropping absent nodes /
 *  unregistered types). */
function resolveMembers(order: readonly string[], resolveDef: ColumnDefResolver): ColumnMember[] {
  const out: ColumnMember[] = [];
  for (const id of order) {
    const n = patch.nodes[id] as ModuleNode | undefined;
    if (!n) continue;
    const def = resolveDef(n.type);
    if (!def) continue;
    out.push({ nodeId: id, def });
  }
  return out;
}

/**
 * WIRING reconcile (pass 2). Plans the GLOBAL desired reconciler-owned edge set
 * across all 8 columns + 2 sends, then diffs it against the present wcol- edges.
 * Returns true when something was written. No transaction when converged.
 */
export function reconcileColumnWiring(resolveDef: ColumnDefResolver): boolean {
  const mixer = patch.nodes[PINNED_MIXER_ID] as ModuleNode | undefined;
  if (!mixer) return false;
  const data = (mixer.data ?? {}) as MixerColumnsData;
  const cols = data.columns ?? {};
  const sends = data.sends ?? {};
  const clipPlayerId = patch.nodes[PINNED_CLIP_ID] ? PINNED_CLIP_ID : null;
  const mixerId = PINNED_MIXER_ID;

  // Build the global desired edge set.
  const desired: WcolEdge[] = [];
  for (let ch = 1; ch <= COLUMN_COUNT; ch++) {
    const members = resolveMembers(cols[String(ch)] ?? [], resolveDef);
    if (members.length === 0) continue;
    desired.push(...planColumnWiring({ channel: ch, members, clipPlayerId, mixerId }));
  }
  for (let s = 1; s <= SEND_BOX_COUNT; s++) {
    const members = resolveMembers(sends[String(s)] ?? [], resolveDef);
    if (members.length === 0) continue;
    desired.push(...planSendWiring({ slot: s, members, mixerId }));
  }

  // De-dup by id, then DROP any edge that fails validateEdge (prevents one
  // malformed edge from poisoning the whole reconcile pass for every peer).
  const nodesArr = Object.values(patch.nodes).filter(Boolean) as ModuleNode[];
  const desiredById = new Map<string, WcolEdge>();
  for (const e of desired) {
    if (desiredById.has(e.id)) continue;
    const asEdge: Edge = {
      id: e.id, source: e.source, target: e.target,
      sourceType: e.sourceType, targetType: e.targetType,
    };
    if (!validateEdge(asEdge, nodesArr, resolveDef as never).ok) continue;
    desiredById.set(e.id, e);
  }

  // Present wcol- edges + the ports currently held by a NON-wcol (hand) cable.
  const presentWcol = new Set<string>();
  const handOccupied = new Set<string>(); // "nodeId:portId"
  for (const [eid, ed] of Object.entries(patch.edges)) {
    if (!ed) continue;
    if (eid.startsWith(WCOL_EDGE_PREFIX)) {
      presentWcol.add(eid);
    } else {
      handOccupied.add(`${ed.target.nodeId}:${ed.target.portId}`);
    }
  }

  // YIELD RULE: a desired link whose target port holds a hand cable backs off.
  const toAdd: WcolEdge[] = [];
  const desiredIds = new Set<string>();
  for (const e of desiredById.values()) {
    if (handOccupied.has(`${e.target.nodeId}:${e.target.portId}`)) continue;
    desiredIds.add(e.id);
    if (!presentWcol.has(e.id)) toAdd.push(e);
  }
  const toDelete: string[] = [];
  for (const eid of presentWcol) if (!desiredIds.has(eid)) toDelete.push(eid);

  if (toAdd.length === 0 && toDelete.length === 0) return false;
  ydoc.transact(() => {
    for (const eid of toDelete) delete patch.edges[eid];
    for (const e of toAdd) {
      patch.edges[e.id] = {
        id: e.id,
        source: { ...e.source },
        target: { ...e.target },
        sourceType: e.sourceType,
        targetType: e.targetType,
      };
    }
  }, AUTO_JANITOR_ORIGIN);
  return true;
}

/**
 * The combined workflow-columns janitor the Canvas graph-change $effect calls
 * (workflow racks only). Membership heal FIRST (so the wiring reconcile sees the
 * healed order), then the wiring reconcile. A no-op (no transaction) when the
 * graph is already converged.
 */
export function reconcileColumns(resolveDef: ColumnDefResolver): void {
  if (!patch.nodes[PINNED_MIXER_ID]) return;
  reconcileColumnMembership();
  reconcileColumnWiring(resolveDef);
}
