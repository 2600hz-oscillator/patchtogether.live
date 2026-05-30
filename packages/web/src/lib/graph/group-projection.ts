// packages/web/src/lib/graph/group-projection.ts
//
// Module-grouping Phase 1 — snapshot projection layer.
//
// Groups are a UI-only abstraction: the audio + video engines must remain
// blissfully unaware that some modules are "inside a group". This file is
// the indirection that makes that possible.
//
// A GROUP! node carries `data.exposedPorts: ExposedPort[]`. Each ExposedPort
// is a stable id paired with the real {childId, childPortId} it stands in
// for. When the canvas draws cables to a group, it draws them onto these
// exposed-port handles. But the reconciler needs to see the REAL child port,
// or it won't be able to materialize the edge in the engine's address space.
//
// `projectGroups(snap)` rewrites any edge endpoint that points at a group's
// exposed port → the real child port. The group node itself stays in the
// snapshot (so the canvas can find it for rendering) but the reconciler's
// `domain === 'meta'` skip rule already keeps it out of engine.addNode.
//
// Pure function. No Yjs, no DOM, no side effects. Empty fast-path: if no
// group nodes exist the input snapshot is returned unchanged (same reference).

import type { Edge, ModuleNode, CableType } from './types';
import type { PatchSnapshot } from './snapshot';

/**
 * A port exposed on the boundary of a GROUP! node. The group's handle at
 * this id stands in for {childId, childPortId} during projection.
 */
export interface ExposedPort {
  /** Stable id used as the group's port handle in Svelte Flow. */
  id: string;
  /** The child module owning the real port. */
  childId: string;
  /** The port id on the child module. */
  childPortId: string;
  /** 'input' or 'output' — drives which handle column on GroupCard. */
  direction: 'input' | 'output';
  /** Cable type — drives the cable-color stripe + canConnect checks. */
  cableType: CableType;
  /** Optional human-readable label (default: derive from childPortId). */
  label?: string;
}

/**
 * Module-grouping Phase 4 — exposed controls.
 *
 * A control surfaced from a child module onto the group's bar. The pair
 * `{childId, controlId}` references an entry in the child module def's
 * `exposableControls` list. The group renderer reads the def at render
 * time so any future control kinds (e.g. mode toggles, faders) flow
 * through without touching this schema. Sister to ExposedPort but for
 * UI controls instead of patch jacks.
 */
export interface ExposedControl {
  /** The child module instance owning the control. */
  childId: string;
  /** Stable id of the exposable control on the child def. */
  controlId: string;
}

/**
 * Instrument-layout data for the v1 "edit phase". The user freely positions +
 * resizes each per-child controls box (and any video screen) inside the
 * instrument card. While `mode === 'edit'` the boxes render with drag/resize
 * affordances; on Save Instrument the layout flips to 'locked' and the user
 * sees a frozen layout the way performers see a hardware instrument.
 *
 * `controls` is keyed by `${childId}.${controlKey}` — `controlKey` is the
 * matching ExposedControl's `controlId` for individual exposed controls,
 * `__module` for the per-child bounding box itself, and `__screen` for the
 * embedded viz screen (BENTBOX, VIDEOOUT, …). Missing keys fall back to the
 * default flow layout, so adding a control to an already-saved instrument
 * doesn't fight the layout — it just lands at the default slot.
 */
export interface InstrumentLayoutEntry {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface InstrumentLayout {
  /** 'edit' = drag/resize affordances visible; 'locked' = frozen render. */
  mode: 'edit' | 'locked';
  /** Per-element absolute positions inside the instrument card. */
  controls: Record<string, InstrumentLayoutEntry>;
}

/**
 * A group node's `data` shape. `childIds` records membership so a follow-up
 * Ungroup can iterate them; `parentGroupId` on each child node also encodes
 * the inverse pointer for fast canvas-side filtering.
 */
export interface GroupData {
  label?: string;
  childIds: string[];
  exposedPorts: ExposedPort[];
  /** Phase 2: when true, the group renders its children in place instead of
   *  collapsing them. Phase 1 always collapses. */
  expanded?: boolean;
  /** Phase 4: per-(childId, controlId) opt-ins surfaced on the group bar.
   *  Empty/omitted = nothing surfaced. */
  exposedControls?: ExposedControl[];
  /** v1 Instruments — see InstrumentLayout. Default behavior when omitted:
   *  the instrument renders the legacy flow layout (no per-element
   *  positions). The right-click "Edit Instrument" entry seeds an empty
   *  layout with mode='edit' on first entry. */
  instrumentLayout?: InstrumentLayout;
  /** v1 Instruments — atomic sequence/score exposure. When true and the
   *  child module is a sequencer/score, the FULL step-grid / score sheet is
   *  rendered inside the instrument (single decision, no per-step controls).
   *  Keyed by childId. */
  exposedSequences?: Record<string, boolean>;
}

/**
 * Read-only view onto a group node + its parsed data. Internal helper —
 * the snapshot's ModuleNode.data is `unknown`, so we narrow it here.
 */
interface ResolvedGroup {
  node: ModuleNode;
  data: GroupData;
}

function asGroupData(data: unknown): GroupData | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Partial<GroupData>;
  if (!Array.isArray(d.exposedPorts)) return null;
  if (!Array.isArray(d.childIds)) return null;
  const out: GroupData = {
    label: typeof d.label === 'string' ? d.label : undefined,
    childIds: d.childIds.filter((x): x is string => typeof x === 'string'),
    exposedPorts: d.exposedPorts.filter((p): p is ExposedPort => {
      if (!p || typeof p !== 'object') return false;
      const ep = p as Partial<ExposedPort>;
      return (
        typeof ep.id === 'string' &&
        typeof ep.childId === 'string' &&
        typeof ep.childPortId === 'string' &&
        (ep.direction === 'input' || ep.direction === 'output')
      );
    }),
    expanded: d.expanded === true,
  };
  if (Array.isArray(d.exposedControls)) {
    out.exposedControls = d.exposedControls.filter((c): c is ExposedControl => {
      if (!c || typeof c !== 'object') return false;
      const ec = c as Partial<ExposedControl>;
      return typeof ec.childId === 'string' && typeof ec.controlId === 'string';
    });
  }
  if (d.instrumentLayout && typeof d.instrumentLayout === 'object') {
    const il = d.instrumentLayout as Partial<InstrumentLayout>;
    const controlsRaw = (il.controls ?? {}) as Record<string, unknown>;
    const controls: Record<string, InstrumentLayoutEntry> = {};
    for (const [k, v] of Object.entries(controlsRaw)) {
      if (!v || typeof v !== 'object') continue;
      const e = v as Partial<InstrumentLayoutEntry>;
      if (
        typeof e.x === 'number' &&
        typeof e.y === 'number' &&
        typeof e.width === 'number' &&
        typeof e.height === 'number'
      ) {
        controls[k] = { x: e.x, y: e.y, width: e.width, height: e.height };
      }
    }
    out.instrumentLayout = {
      mode: il.mode === 'edit' ? 'edit' : 'locked',
      controls,
    };
  }
  if (d.exposedSequences && typeof d.exposedSequences === 'object') {
    const es: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(d.exposedSequences as Record<string, unknown>)) {
      if (typeof v === 'boolean') es[k] = v;
    }
    out.exposedSequences = es;
  }
  return out;
}

/**
 * True iff this snapshot contains at least one group node.
 */
function hasGroups(snap: PatchSnapshot): boolean {
  for (const n of snap.nodes) if (n.type === 'group') return true;
  return false;
}

/**
 * Build the {nodeId:exposedId → {childId, childPortId}} lookup for every
 * exposed port on every group in the snapshot.
 *
 * Returned keys: `${groupNodeId}::${exposedPortId}`.
 */
export function buildExposedPortMap(snap: PatchSnapshot): Map<string, { childId: string; childPortId: string }> {
  const map = new Map<string, { childId: string; childPortId: string }>();
  for (const node of snap.nodes) {
    if (node.type !== 'group') continue;
    const data = asGroupData(node.data);
    if (!data) continue;
    for (const ep of data.exposedPorts) {
      map.set(`${node.id}::${ep.id}`, { childId: ep.childId, childPortId: ep.childPortId });
    }
  }
  return map;
}

/**
 * Resolve one exposed-port handle to its underlying child {nodeId, portId}.
 *
 * Used by the canvas's connect-drag commit path to translate a cable that
 * terminates on a group's exposed handle (`OUT--LUMAKEY-FD8329B3--OUT` etc.)
 * into the real child port the engine will route. Returns null when the
 * group has no entry for that handle id (defensive — caller may then fall
 * back to treating the connection as targeting the group node itself, or
 * abort if no fallback is sensible).
 *
 * Group-membership lookup is a direct read of the node's data; it does NOT
 * walk the whole snapshot. O(exposedPorts) per call. Cheap.
 */
export function resolveExposedPort(
  groupNode: ModuleNode,
  portId: string,
): { childId: string; childPortId: string; cableType: CableType; direction: 'input' | 'output' } | null {
  if (groupNode.type !== 'group') return null;
  const data = asGroupData(groupNode.data);
  if (!data) return null;
  const ep = data.exposedPorts.find((p) => p.id === portId);
  if (!ep) return null;
  return {
    childId: ep.childId,
    childPortId: ep.childPortId,
    cableType: ep.cableType,
    direction: ep.direction,
  };
}

/**
 * Project a snapshot through any GROUP! nodes:
 * - Each edge endpoint that names a group's exposed port is rewritten
 *   to point at the underlying child {nodeId, portId}.
 * - Edges whose endpoint references a group but a non-existent exposed
 *   port are dropped (defensive — a stale edge across a group rename).
 * - Edges that touch no group are passed through unchanged.
 *
 * The group node itself is NOT removed from the snapshot. The reconciler's
 * `domain === 'meta'` skip rule already filters it out before engine.addNode
 * runs.
 *
 * Empty fast-path: if the snapshot has no group nodes the input is returned
 * unchanged (same reference) so equality checks downstream still cache.
 */
export function projectGroups(snap: PatchSnapshot): PatchSnapshot {
  if (!hasGroups(snap)) return snap;

  const exposed = buildExposedPortMap(snap);

  const projectedEdges: Edge[] = [];
  for (const edge of snap.edges) {
    let source = edge.source;
    let target = edge.target;
    let drop = false;

    const srcKey = `${edge.source.nodeId}::${edge.source.portId}`;
    if (exposed.has(srcKey)) {
      const real = exposed.get(srcKey)!;
      source = { nodeId: real.childId, portId: real.childPortId };
    } else {
      // If the source NODE is a group but the portId is unknown, drop.
      const srcNode = snap.nodes.find((n) => n.id === edge.source.nodeId);
      if (srcNode?.type === 'group') drop = true;
    }

    const tgtKey = `${edge.target.nodeId}::${edge.target.portId}`;
    if (exposed.has(tgtKey)) {
      const real = exposed.get(tgtKey)!;
      target = { nodeId: real.childId, portId: real.childPortId };
    } else {
      const tgtNode = snap.nodes.find((n) => n.id === edge.target.nodeId);
      if (tgtNode?.type === 'group') drop = true;
    }

    if (drop) continue;
    projectedEdges.push({
      id: edge.id,
      source,
      target,
      sourceType: edge.sourceType,
      targetType: edge.targetType,
    });
  }

  return {
    nodes: snap.nodes,
    edges: projectedEdges,
  };
}
