// packages/web/src/lib/graph/cv-buddy-es9-reconcile.ts
//
// CV BUDDY → ES-9 JANITOR (Part A). An INDEPENDENT graph-change reconciler that
// wires each CV Buddy instance's note/transport OUTPUTS to the single ES-9
// node's physical output jacks per the slot allocator, and writes each driven
// jack's voltage CLASS (out{N}_class) onto the ES-9 node. It touches NO columns
// and needs nothing from the workflow column planner — mirrors the
// automation-assign / singleton-cleanup janitor patterns.
//
// DESIGN:
//   * PURE planner `planCvBuddyEs9(nodes, edges)` decides the edge + class diff
//     against plain fixtures (unit-tested, no Yjs). `reconcileCvBuddyEs9()`
//     reads the live store, calls the planner, and applies the diff in ONE
//     non-undo-tracked transaction (CVBUDDY_JANITOR_ORIGIN — it runs on every
//     peer from the Canvas graph-change seam, so undo-tracking it would plant
//     phantom undo items on every OTHER client, exactly like automation-assign).
//   * LAZY ES-9 RESOLVE: with no ES-9 node in the rack CV Buddy is INERT — no
//     edges are written and the card prompts the user to add an ES-9 + run the
//     helper. The janitor NEVER force-creates the ES-9 node.
//   * IDEMPOTENT: the plan diffs desired against the live edges/params, so a
//     converged graph yields an empty plan (no transaction). Every peer computes
//     the identical plan from the identical snapshot (id-sorted allocation).
//   * RESET ON UNCLAIM: when an instance is removed (or a lower-id one is, so a
//     survivor shifts its jacks — incl. inheriting RUN/CLOCK) the freed jacks'
//     class is reset to audio(0). This is LOAD-BEARING: the ES-9 gate/cv classes
//     HOLD their last voltage on a stream hiccup, so leaving a freed jack's class
//     non-audio would freeze a stale voltage on the hardware; audio(0) fades it
//     to 0 V. Reset scope = ALL eight jacks CV Buddy manages (slot 7 = RUN, slot
//     8 = CLOCK) — so while a CV Buddy is present those jacks belong to it; set
//     an ES-9 out-class by hand only when no CV Buddy is in the rack.
//
// KNOWN MINOR QUIRK: if the LAST CV Buddy is deleted and its edges cascade away
// in the same transaction (removePatchNode drops connected edges), that
// reconcile sees zero CV Buddies AND zero cv-buddy edges → it stays inert and
// does NOT reset the (now orphaned) jack classes. This is harmless — with no
// edge feeding the jack the ES-9 input is 0, so the jack sits at ~0 V regardless
// of class — and it self-heals the instant another CV Buddy is added (the new
// owner re-claims + overwrites). Documented so it isn't mistaken for a bug.

import { patch, ydoc } from '$lib/graph/store';
import type { Edge, ModuleNode } from '$lib/graph/types';
import {
  allocateCvBuddySlots,
  slotToEs9,
  slotsToReset,
  CV_BUDDY_MANAGED_SLOTS,
  ES9_AUDIO,
  type CvBuddyAlloc,
} from '$lib/audio/cv-buddy/slot-alloc';

/** Non-undo-tracked origin for the janitor's writes (mirrors
 *  AUTO_JANITOR_ORIGIN). Still SYNCS to peers; just never enters an undo stack. */
export const CVBUDDY_JANITOR_ORIGIN = Symbol('cv-buddy-es9-janitor');

/** Deterministic id for a CV-Buddy-owned edge, keyed by (instance, output port)
 *  so a re-allocation reuses the id and just retargets the jack. The
 *  `e-cvbuddy-` prefix marks the edge as janitor-owned. */
function cvBuddyEdgeId(cbId: string, outPort: string): string {
  return `e-cvbuddy-${cbId}-${outPort}`;
}

/** The CV Buddy output port that drives each allocated jack. */
const OUTPUT_FOR = {
  pitch: 'pitchCv',
  gate: 'gate',
  vel: 'velCv',
  run: 'run',
  clock: 'clock',
} as const;

/** Source cable type for each CV Buddy output. */
const SOURCE_TYPE: Record<string, Edge['sourceType']> = {
  pitchCv: 'cv',
  gate: 'gate',
  velCv: 'cv',
  run: 'gate',
  clock: 'gate',
};

interface NodeLike {
  id?: string;
  type?: string;
  params?: Record<string, number>;
}

/** One planned ES-9 class-param write. */
export interface ClassSet {
  es9Id: string;
  paramId: string;
  value: number;
}

/** The diff the reconciler applies. */
export interface CvBuddyEs9Plan {
  edgesToAdd: Edge[];
  edgeIdsToRemove: string[];
  classSets: ClassSet[];
}

const EMPTY_PLAN: CvBuddyEs9Plan = { edgesToAdd: [], edgeIdsToRemove: [], classSets: [] };

/** Parse `out{N}` → N (or null). */
function slotOfPort(portId: string): number | null {
  const m = /^out(\d+)$/.exec(portId);
  return m ? Number(m[1]) : null;
}

/** Build the desired edge for one (instance, role, slot). */
function desiredEdge(cbId: string, outPort: string, es9Id: string, slot: number): Edge {
  return {
    id: cvBuddyEdgeId(cbId, outPort),
    source: { nodeId: cbId, portId: outPort },
    target: { nodeId: es9Id, portId: slotToEs9(slot).port },
    sourceType: SOURCE_TYPE[outPort] ?? 'cv',
    targetType: 'audio', // ES-9 out jacks are audio-typed (accepts cv/pitch/gate)
  };
}

function edgesEqual(a: Edge, b: Edge | undefined): boolean {
  return (
    !!b &&
    a.source.nodeId === b.source.nodeId &&
    a.source.portId === b.source.portId &&
    a.target.nodeId === b.target.nodeId &&
    a.target.portId === b.target.portId &&
    a.sourceType === b.sourceType &&
    a.targetType === b.targetType
  );
}

/**
 * PURE planner: compute the edge + class diff to route every CV Buddy to the
 * single ES-9 node. Returns an EMPTY plan (no ES-9 in the rack, and no lingering
 * cv-buddy edges to clean) so the caller opens no transaction. See file header.
 */
export function planCvBuddyEs9(
  nodes: Record<string, NodeLike | null | undefined>,
  edges: Record<string, Edge | null | undefined>,
): CvBuddyEs9Plan {
  // Resolve the single ES-9 node (lazy — none ⇒ inert). id-min if duplicated.
  let es9Id: string | null = null;
  const cvBuddyIds: string[] = [];
  for (const [id, n] of Object.entries(nodes)) {
    if (!n || !n.type) continue;
    const nid = n.id ?? id;
    if (n.type === 'es9') {
      if (es9Id === null || nid < es9Id) es9Id = nid;
    } else if (n.type === 'cvBuddy') {
      cvBuddyIds.push(nid);
    }
  }

  // Existing janitor-owned edges (id prefix), regardless of whether they still
  // point at a live ES-9.
  const existingCvEdges: Edge[] = [];
  for (const [id, e] of Object.entries(edges)) {
    if (e && id.startsWith('e-cvbuddy-')) existingCvEdges.push(e);
  }

  // No ES-9 → CV Buddy is inert. Only cleanup: drop any lingering cv-buddy edges
  // (can't route or set classes without the ES-9).
  if (es9Id === null) {
    if (existingCvEdges.length === 0) return EMPTY_PLAN;
    return { edgesToAdd: [], edgeIdsToRemove: existingCvEdges.map((e) => e.id), classSets: [] };
  }

  const es9 = nodes[es9Id]!;
  const next = allocateCvBuddySlots(cvBuddyIds);

  // Desired edges + per-jack classes for every claimed slot.
  const desired = new Map<string, Edge>();
  const desiredClass = new Map<number, number>(); // slot → class
  const claimed = new Set<number>();
  const claimJack = (cbId: string, outPort: string, slot: number | null) => {
    if (slot == null) return;
    desired.set(cvBuddyEdgeId(cbId, outPort), desiredEdge(cbId, outPort, es9Id!, slot));
    desiredClass.set(slot, slotToEs9(slot).class);
    claimed.add(slot);
  };
  for (const [cbId, a] of next) {
    claimJack(cbId, OUTPUT_FOR.pitch, a.pitchSlot);
    claimJack(cbId, OUTPUT_FOR.gate, a.gateSlot);
    claimJack(cbId, OUTPUT_FOR.vel, a.velSlot);
    if (a.ownsClock) {
      claimJack(cbId, OUTPUT_FOR.run, a.runSlot);
      claimJack(cbId, OUTPUT_FOR.clock, a.clockSlot);
    }
  }

  // Reconstruct the CURRENTLY-APPLIED allocation from the live cv-buddy edges,
  // so slotsToReset can name the jacks a re-allocation freed.
  const prev = new Map<string, Partial<CvBuddyAlloc>>();
  for (const e of existingCvEdges) {
    const cb = e.source.nodeId;
    const slot = slotOfPort(e.target.portId);
    if (slot == null || e.target.nodeId !== es9Id) continue;
    const a = prev.get(cb) ?? {};
    switch (e.source.portId) {
      case 'pitchCv': a.pitchSlot = slot; break;
      case 'gate': a.gateSlot = slot; break;
      case 'velCv': a.velSlot = slot; break;
      case 'run': a.runSlot = slot; break;
      case 'clock': a.clockSlot = slot; break;
    }
    prev.set(cb, a);
  }

  // Edge diff.
  const edgeIdsToRemove = existingCvEdges.filter((e) => !desired.has(e.id)).map((e) => e.id);
  const edgesToAdd: Edge[] = [];
  for (const [id, e] of desired) {
    if (!edgesEqual(e, edges[id] ?? undefined)) edgesToAdd.push(e);
  }

  // Reset set: jacks freed by re-allocation (edge-derived, precise) UNION the
  // catch-all sweep of managed jacks that are unclaimed yet still carry a
  // non-audio class while a CV Buddy is active (covers a removed instance whose
  // edges have already cascaded away this transaction).
  const active = cvBuddyIds.length > 0 || existingCvEdges.length > 0;
  const resetSlots = new Set<number>(slotsToReset(prev, next));
  if (active) {
    for (const slot of CV_BUDDY_MANAGED_SLOTS) {
      if (claimed.has(slot)) continue;
      const cur = es9.params?.[`out${slot}_class`] ?? ES9_AUDIO;
      if (cur !== ES9_AUDIO) resetSlots.add(slot);
    }
  }

  // Class writes: set the desired class on every claimed jack, reset freed jacks
  // to audio — each only when the ES-9's live param actually differs.
  const classSets: ClassSet[] = [];
  for (const [slot, cls] of desiredClass) {
    const paramId = `out${slot}_class`;
    if ((es9.params?.[paramId] ?? ES9_AUDIO) !== cls) classSets.push({ es9Id, paramId, value: cls });
  }
  for (const slot of [...resetSlots].sort((a, b) => a - b)) {
    const paramId = `out${slot}_class`;
    if ((es9.params?.[paramId] ?? ES9_AUDIO) !== ES9_AUDIO) {
      classSets.push({ es9Id, paramId, value: ES9_AUDIO });
    }
  }

  return { edgesToAdd, edgeIdsToRemove, classSets };
}

/** True when a plan has nothing to apply. */
function planIsEmpty(p: CvBuddyEs9Plan): boolean {
  return p.edgesToAdd.length === 0 && p.edgeIdsToRemove.length === 0 && p.classSets.length === 0;
}

/**
 * Apply the CV Buddy → ES-9 plan to the LIVE store in one janitor transaction.
 * A no-op (no transaction) when the graph is already reconciled. Safe to call on
 * every graph change from the Canvas seam.
 */
export function reconcileCvBuddyEs9(): void {
  const plan = planCvBuddyEs9(patch.nodes, patch.edges);
  if (planIsEmpty(plan)) return;
  ydoc.transact(() => {
    for (const id of plan.edgeIdsToRemove) {
      if (patch.edges[id]) delete patch.edges[id];
    }
    for (const e of plan.edgesToAdd) {
      patch.edges[e.id] = e;
    }
    for (const { es9Id, paramId, value } of plan.classSets) {
      const live = patch.nodes[es9Id] as ModuleNode | undefined;
      if (!live) continue;
      if (!live.params) live.params = {};
      // Programmatic JANITOR write (CVBUDDY_JANITOR_ORIGIN, non-undo-tracked) —
      // deliberately out of the undo stack, like the automation-assign janitor.
      live.params[paramId] = value; // guard:allow-raw-write
    }
  }, CVBUDDY_JANITOR_ORIGIN);
}
