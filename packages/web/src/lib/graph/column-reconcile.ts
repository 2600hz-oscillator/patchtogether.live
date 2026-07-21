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
import {
  AUTO_JANITOR_ORIGIN,
  assignAutomationLane,
  automationAssignmentFor,
  listClipPlayers,
} from './automation-assign';
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
  resolveColumnHead,
  resolveMainAudioIn,
  isChainAudioParticipant,
  isReturnSource,
  type ColumnMember,
  type ConvenienceDef,
  type CvBuddyReturn,
  type SourceHeadState,
  type WcolEdge,
} from './patch-convenience';
import { allocateCvBuddySlots } from '$lib/audio/cv-buddy/slot-alloc';

/** Deterministic ids of the workflow pinned singletons the columns anchor to. */
export const PINNED_MIXER_ID = 'pinned-mixmstrs';
export const PINNED_CLIP_ID = 'pinned-clipplayer';

/** Namespace prefix for reconciler-owned edges (wcolEdgeId writes this). */
const WCOL_EDGE_PREFIX = 'wcol-e-';

/** A (type) → full-def lookup — the Canvas passes its defLookup chain
 *  (getModuleDef ?? getVideoModuleDef ?? getMetaModuleDef). Must return the FULL
 *  def (with stereoPairs + chainWiring) so the wiring planners resolve correctly. */
export type ColumnDefResolver = (type: string) => ConvenienceDef | undefined;

/** The columns/sends order maps + the user-detach suppression set stored on the
 *  pinned-mixmstrs node.data. */
interface MixerColumnsData {
  columns?: Record<string, string[]>;
  sends?: Record<string, string[]>;
  /** MAJOR 1 — durable manual override: wcol- edge ids the USER explicitly
   *  deleted, keyed by column/send key ('1'..'8' | 's1' | 's2'). The reconcile
   *  will NOT re-add a suppressed edge (nor its stereo-pair siblings, MAJOR 2).
   *  Cleared for a key when that column's membership/order changes (a fresh
   *  column edit re-manages it). Written under LOCAL_ORIGIN by the Canvas
   *  edge-delete seam. */
  wcolDetached?: Record<string, string[]>;
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
 * PART B — build the rack-wide CV-Buddy → ES-9 return-audio map. LAZY: with no
 * ES-9 node it returns an empty map (a return source then emits no audio). The
 * ES-9 is resolved id-min (mirrors the CV-Buddy→ES-9 janitor's single-ES-9 rule)
 * and each CV Buddy's input pair comes from the id-sorted slot allocator, so
 * every peer computes the identical map from the converged snapshot. Only the
 * first two CV Buddies get a slot (allocateCvBuddySlots); a 3rd+ is absent →
 * inert. The pair's ES-9 OUTPUT ports are `in{N}` (es9.ts).
 */
function buildCvBuddyReturns(): Map<string, CvBuddyReturn> {
  const out = new Map<string, CvBuddyReturn>();
  let es9Id: string | null = null;
  const cvBuddyIds: string[] = [];
  for (const [id, n] of Object.entries(patch.nodes)) {
    if (!n) continue;
    const type = (n as ModuleNode).type;
    if (type === 'es9') {
      if (es9Id === null || id < es9Id) es9Id = id;
    } else if (type === 'cvBuddy') {
      cvBuddyIds.push(id);
    }
  }
  if (es9Id === null) return out; // no ES-9 → no return audio (inert)
  for (const [cbId, alloc] of allocateCvBuddySlots(cvBuddyIds)) {
    out.set(cbId, {
      es9NodeId: es9Id,
      inPortL: `in${alloc.inPair[0]}`,
      inPortR: `in${alloc.inPair[1]}`,
    });
  }
  return out;
}

/** Read the head flag off a node's data (tri-state: true / false / undefined). */
function headFlagOf(node: ModuleNode | undefined): boolean | undefined {
  const v = (node?.data as { isColumnHead?: unknown } | undefined)?.isColumnHead;
  return typeof v === 'boolean' ? v : undefined;
}

/** A member is a chain SOURCE (a head CANDIDATE) when it participates in the
 *  audio chain (has a resolvable main out) yet has NO main audio-in — so it can
 *  only sit at the ROOT of the chain. FX (a main audio-in) and pure-video/CV
 *  members are excluded. PLUS a CV-Buddy RETURN source (Part B) — its ES-9 return
 *  audio is a lane head even though it exposes no audio-typed port. */
function isColumnHeadCandidate(def: ConvenienceDef): boolean {
  return (isChainAudioParticipant(def) && resolveMainAudioIn(def) === null) || isReturnSource(def);
}

/** The column's chain-source members (head candidates) in order, each with its
 *  persisted head flag — the input to resolveColumnHead. */
function columnSourceHeadStates(
  order: readonly string[],
  resolveDef: ColumnDefResolver,
): SourceHeadState[] {
  const out: SourceHeadState[] = [];
  for (const id of order) {
    const n = patch.nodes[id] as ModuleNode | undefined;
    if (!n) continue;
    const def = resolveDef(n.type);
    if (!def || !isColumnHeadCandidate(def)) continue;
    out.push({ nodeId: id, isHead: headFlagOf(n) });
  }
  return out;
}

/**
 * HEAD-SOURCE heal (pass 1.5). For each column, resolves the ONE head source from
 * its chain-source members' persisted `node.data.isColumnHead` flags
 * (resolveColumnHead) and persists the flag writes needed to converge — promoting
 * a freshly-added source in a headless column, demoting a 2nd concurrent head on a
 * collab race, and classifying a fresh source as a deliberate non-head when a head
 * already exists. NEVER auto-promotes a deliberate non-head (a deleted head leaves
 * the column headless). Idempotent (no writes once every source is classified);
 * runs under AUTO_JANITOR_ORIGIN. Returns true when something was written.
 *
 * The flag is a per-source SCALAR on the member node (an independent CRDT key,
 * like data.channel), so it does NOT last-writer-wins away when a sibling changes
 * and is collab-deterministic. (node.data is NOT an attest basis file.)
 */
export function reconcileColumnHeads(resolveDef: ColumnDefResolver): boolean {
  const mixer = patch.nodes[PINNED_MIXER_ID] as ModuleNode | undefined;
  if (!mixer) return false;
  const cols = ((mixer.data ?? {}) as MixerColumnsData).columns ?? {};

  const writes: { nodeId: string; isHead: boolean }[] = [];
  for (let ch = 1; ch <= COLUMN_COUNT; ch++) {
    const sources = columnSourceHeadStates(cols[String(ch)] ?? [], resolveDef);
    writes.push(...resolveColumnHead(sources).flagWrites);
  }
  if (writes.length === 0) return false;

  ydoc.transact(() => {
    for (const w of writes) {
      const n = patch.nodes[w.nodeId] as ModuleNode | undefined;
      if (!n) continue;
      if (!n.data) n.data = {};
      const d = n.data as { isColumnHead?: boolean };
      if (d.isColumnHead !== w.isHead) d.isColumnHead = w.isHead;
    }
  }, AUTO_JANITOR_ORIGIN);
  return true;
}

/** The resolved head-source node id for a column (pure read of the persisted
 *  flags via resolveColumnHead — no writes; the head-heal pass owns writes). */
function columnHeadNodeId(order: readonly string[], resolveDef: ColumnDefResolver): string | null {
  return resolveColumnHead(columnSourceHeadStates(order, resolveDef)).headNodeId;
}

/**
 * WIRING reconcile (pass 2). Plans the GLOBAL desired reconciler-owned edge set
 * across all 8 columns + 2 sends, then diffs it against the present wcol- edges.
 * Returns true when something was written. No transaction when converged.
 *
 * YIELD is ALL-OR-NOTHING PER MANAGED LINK (grouped by source→target node pair,
 * so an L/R stereo pair or a pitch+gate control pair yield together — MAJOR 2):
 * a whole group backs off when ANY of its target ports holds a NON-wcol (hand)
 * cable OR any of its edge ids is in the user-detach suppression set (MAJOR 1) —
 * so a manual edit / manual removal durably overrides and never leaves a broken
 * half-managed split image.
 */
export function reconcileColumnWiring(resolveDef: ColumnDefResolver): boolean {
  const mixer = patch.nodes[PINNED_MIXER_ID] as ModuleNode | undefined;
  if (!mixer) return false;
  const data = (mixer.data ?? {}) as MixerColumnsData;
  const cols = data.columns ?? {};
  const sends = data.sends ?? {};
  const clipPlayerId = patch.nodes[PINNED_CLIP_ID] ? PINNED_CLIP_ID : null;
  const mixerId = PINNED_MIXER_ID;

  // PART B — ES-9 return-audio allocation (rack-wide, lazy). Resolve the single
  // ES-9 node (id-min, mirrors the CV-Buddy→ES-9 janitor) and map each CV Buddy
  // to its hardware INPUT pair (1st→in1/in2, 2nd→in3/in4) via the id-sorted slot
  // allocator, so every peer computes the identical returns. Inert (empty map)
  // with no ES-9 — a return source then simply emits no audio.
  const cvBuddyReturns = buildCvBuddyReturns();

  // Build the global desired edge set.
  const desired: WcolEdge[] = [];
  for (let ch = 1; ch <= COLUMN_COUNT; ch++) {
    const order = cols[String(ch)] ?? [];
    const members = resolveMembers(order, resolveDef);
    if (members.length === 0) continue;
    const headNodeId = columnHeadNodeId(order, resolveDef);
    desired.push(...planColumnWiring({
      channel: ch, members, clipPlayerId, mixerId, headNodeId, returns: cvBuddyReturns,
    }));
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

  // The flat set of user-DETACHED wcol edge ids (MAJOR 1 durable removal).
  const detachedSet = new Set<string>();
  for (const arr of Object.values(data.wcolDetached ?? {})) {
    for (const id of arr ?? []) detachedSet.add(id);
  }

  // GROUP desired edges by managed link (source→target node pair) for the
  // all-or-nothing yield.
  const groups = new Map<string, WcolEdge[]>();
  for (const e of desiredById.values()) {
    const key = `${e.source.nodeId}->${e.target.nodeId}`;
    const g = groups.get(key);
    if (g) g.push(e);
    else groups.set(key, [e]);
  }

  const toAdd: WcolEdge[] = [];
  const desiredIds = new Set<string>();
  for (const group of groups.values()) {
    const blocked = group.some(
      (e) => handOccupied.has(`${e.target.nodeId}:${e.target.portId}`) || detachedSet.has(e.id),
    );
    if (blocked) continue; // yield the WHOLE link (never manage it this pass)
    for (const e of group) {
      desiredIds.add(e.id);
      if (!presentWcol.has(e.id)) toAdd.push(e);
    }
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
 * AUTOMATION-LANE heal (MAJOR 3). Every COLUMN member must be bound to its
 * channel's automation lane (ch-1) — but assignAutomationLane runs only in the
 * drag/drop path, so a member whose data.channel arrives via duplicate / paste /
 * import would otherwise have chain+clip+send but NO lane. Bind any column
 * member missing (or mis-bound) its lane, under AUTO_JANITOR_ORIGIN (part of the
 * heal). Idempotent — only writes on a mismatch. Send tenants get NO lane.
 */
export function healColumnAutomationLanes(): boolean {
  const mixer = patch.nodes[PINNED_MIXER_ID] as ModuleNode | undefined;
  if (!mixer) return false;
  const clipId = patch.nodes[PINNED_CLIP_ID] ? PINNED_CLIP_ID : (listClipPlayers(patch.nodes).sort()[0] ?? null);
  if (!clipId) return false;
  const cols = ((mixer.data ?? {}) as MixerColumnsData).columns ?? {};
  let wrote = false;
  for (let ch = 1; ch <= COLUMN_COUNT; ch++) {
    for (const id of cols[String(ch)] ?? []) {
      if (!patch.nodes[id]) continue;
      const cur = automationAssignmentFor(patch.nodes, id);
      if (cur && cur.nodeId === clipId && cur.lane === ch - 1) continue; // already bound
      assignAutomationLane(clipId, id, ch - 1, AUTO_JANITOR_ORIGIN);
      wrote = true;
    }
  }
  return wrote;
}

/**
 * The combined workflow-columns janitor the Canvas graph-change $effect calls
 * (workflow racks only). Membership heal FIRST (so the head + wiring reconciles
 * see the healed order), then the head-source heal (so the wiring reconcile sees
 * the resolved head), then the automation-lane heal, then the wiring reconcile. A
 * no-op (no transaction) when the graph is already converged.
 */
export function reconcileColumns(resolveDef: ColumnDefResolver): void {
  if (!patch.nodes[PINNED_MIXER_ID]) return;
  reconcileColumnMembership();
  reconcileColumnHeads(resolveDef);
  healColumnAutomationLanes();
  reconcileColumnWiring(resolveDef);
}
