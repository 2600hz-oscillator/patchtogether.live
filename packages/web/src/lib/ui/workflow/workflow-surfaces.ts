// packages/web/src/lib/ui/workflow/workflow-surfaces.ts
//
// WORKFLOW MODE P2 — pure helpers behind the topbar surface menus
// (ClockSurface / MidiDinSurface / AudioIoSurface). Framework-free (no
// Svelte, no Yjs, no DOM) so every decision the menus make is unit-testable
// against plain fixtures; the actual Yjs transacts live in the components.
//
// The three surfaces drive EXISTING module mechanisms — nothing here
// invents a parallel path:
//  - The clock surface targets THE rack TIMELORDE (pinned or a dawless
//    import's canvas one) and writes its `bpm` param — the same param the
//    card knob + the Electra tap pad drive.
//  - The MIDI-DIN surface assigns a MIDI input by wiring the hidden pinned
//    MIDICLOCK bridge to TIMELORDE with ordinary cables:
//    clock→clock, midistart→start_in, midistop→stop_in — exactly the
//    hand-patched MIDICLOCK card wiring documented on both defs.
//  - "Externally clocked" is edge-presence on TIMELORDE's `clock` input
//    (the same predicate TimelordeCard greys its TAP button with), so a
//    hand-patched clock cable and a DIN assignment flip the same state.

import type { TapTempo } from '$lib/electra/tap-tempo';

/** Minimal node shape the resolvers inspect. */
export interface SurfaceNodeLike {
  id: string;
  type: string;
}

/** Minimal edge shape the wiring planners inspect. */
export interface SurfaceEdgeLike {
  id: string;
  source: { nodeId: string; portId: string };
  target: { nodeId: string; portId: string };
}

/** Edge collections come in two shapes — the snapshot bus's sorted array
 *  and the live store's `patch.edges` record values — so every helper
 *  takes an iterable of (possibly undefined) edges. */
export type SurfaceEdges = Iterable<SurfaceEdgeLike | undefined>;

/**
 * THE rack timelorde the clock + DIN surfaces control.
 *
 * Preference order:
 *  1. the deterministic pinned instance (`pinned-timelorde`) — the normal
 *     workflow-rack case;
 *  2. otherwise the lexicographically-smallest node of type 'timelorde' —
 *     a dawless-authored patch loaded into a workflow rack carries a
 *     random-id canvas TIMELORDE; it IS the rack clock (maxInstances=1),
 *     so the surface drives it rather than spawning a competitor. Lex
 *     order makes every client pick the same one in the (transient)
 *     two-instance merge window.
 */
export function resolveWorkflowTimelorde<T extends SurfaceNodeLike>(
  nodes: ReadonlyArray<T>,
): T | null {
  let best: T | null = null;
  for (const n of nodes) {
    if (n.type !== 'timelorde') continue;
    if (n.id === 'pinned-timelorde') return n;
    if (best === null || n.id < best.id) best = n;
  }
  return best;
}

/** True when a cable is patched into `<timelordeId>.clock` — TIMELORDE is
 *  externally clocked, the measured external tempo owns BPM, and the tap
 *  button + tempo knob step aside (same predicate as TimelordeCard). */
export function hasExternalClock(
  edges: SurfaceEdges,
  timelordeId: string | null,
): boolean {
  if (!timelordeId) return false;
  for (const edge of edges) {
    if (!edge) continue;
    if (edge.target.nodeId === timelordeId && edge.target.portId === 'clock') return true;
  }
  return false;
}

/**
 * The MIDICLOCK→TIMELORDE bridge wiring, port-pair by port-pair. This is
 * the exact pairing both defs document for slaving the rack to hardware:
 * tempo (clock), transport start, transport stop.
 */
export const DIN_EDGE_PAIRS: ReadonlyArray<{ from: string; to: string }> = [
  { from: 'clock', to: 'clock' },
  { from: 'midistart', to: 'start_in' },
  { from: 'midistop', to: 'stop_in' },
] as const;

/** Canonical edge id — same `e-<src>-<srcPort>-<dst>-<dstPort>` format the
 *  canvas commit paths write, so a DIN-assigned edge is indistinguishable
 *  from a hand-patched one. */
export function dinEdgeId(
  midiclockId: string,
  fromPort: string,
  timelordeId: string,
  toPort: string,
): string {
  return `e-${midiclockId}-${fromPort}-${timelordeId}-${toPort}`;
}

export interface DinEdgeSpec {
  id: string;
  source: { nodeId: string; portId: string };
  target: { nodeId: string; portId: string };
  sourceType: 'gate';
  targetType: 'gate';
}

export interface DinAssignPlan {
  /** Edges to delete first: anything already targeting the three TIMELORDE
   *  inputs (assign REPLACES the clock source — matches the canvas picker's
   *  replace-occupant semantics on input ports). */
  deleteIds: string[];
  /** The three bridge edges to write. */
  add: DinEdgeSpec[];
}

/** Plan the assign: replace whatever feeds TIMELORDE's clock/start/stop
 *  with the pinned MIDICLOCK bridge. Pure — the component transacts it. */
export function planDinAssign(
  edges: SurfaceEdges,
  midiclockId: string,
  timelordeId: string,
): DinAssignPlan {
  const targetPorts = new Set(DIN_EDGE_PAIRS.map((p) => p.to));
  const deleteIds: string[] = [];
  for (const edge of edges) {
    if (!edge) continue;
    if (edge.target.nodeId === timelordeId && targetPorts.has(edge.target.portId)) {
      deleteIds.push(edge.id);
    }
  }
  const add: DinEdgeSpec[] = DIN_EDGE_PAIRS.map((p) => ({
    id: dinEdgeId(midiclockId, p.from, timelordeId, p.to),
    source: { nodeId: midiclockId, portId: p.from },
    target: { nodeId: timelordeId, portId: p.to },
    sourceType: 'gate',
    targetType: 'gate',
  }));
  return { deleteIds, add };
}

/** Plan the unassign: remove ONLY the bridge's own edges into TIMELORDE
 *  (a hand-patched cable from some other module is not ours to cut). */
export function planDinUnassign(
  edges: SurfaceEdges,
  midiclockId: string,
  timelordeId: string,
): string[] {
  const pairSet = new Set(DIN_EDGE_PAIRS.map((p) => `${p.from}→${p.to}`));
  const deleteIds: string[] = [];
  for (const edge of edges) {
    if (!edge) continue;
    if (
      edge.source.nodeId === midiclockId &&
      edge.target.nodeId === timelordeId &&
      pairSet.has(`${edge.source.portId}→${edge.target.portId}`)
    ) {
      deleteIds.push(edge.id);
    }
  }
  return deleteIds;
}

/** True when the DIN bridge currently drives TIMELORDE's tempo (the clock
 *  pair is wired). The transport pairs alone don't make it "assigned" —
 *  tempo is the assignment's meaning. */
export function isDinAssigned(
  edges: SurfaceEdges,
  midiclockId: string,
  timelordeId: string | null,
): boolean {
  if (!timelordeId) return false;
  for (const edge of edges) {
    if (!edge) continue;
    if (
      edge.source.nodeId === midiclockId &&
      edge.source.portId === 'clock' &&
      edge.target.nodeId === timelordeId &&
      edge.target.portId === 'clock'
    ) {
      return true;
    }
  }
  return false;
}

/**
 * One tap, guarded: while TIMELORDE is externally clocked the tap surface
 * is DISABLED — the tap is a no-op AND the in-progress series is forgotten
 * (so a later un-patch starts a clean count instead of averaging across
 * the externally-clocked gap). Mirrors TimelordeCard's tap() + its
 * reset-on-external effect in one pure step. Returns the BPM to write, or
 * null (guarded, or fewer than 2 taps buffered).
 */
export function tapWithExternalGuard(
  controller: TapTempo,
  now: number,
  externallyClocked: boolean,
): number | null {
  if (externallyClocked) {
    controller.reset();
    return null;
  }
  return controller.tap(now);
}
