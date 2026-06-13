// packages/web/src/lib/graph/matrixmix.ts
//
// MATRIXMIX — data model + ydoc helpers.
//
// MATRIXMIX is a meta-domain card whose ONLY persisted state is the two axis
// selections (which module sits on the X axis + which on the Y axis). Every
// connection it shows is derived LIVE from patch.edges each render — never
// cached on the node. So this file is tiny: read the two axis ids, and the
// three side-effecting writers (set X, set Y, create-edge-from-a-cell).
//
// The axis writers mutate node.data IN PLACE through one LOCAL_ORIGIN
// transaction — a single-key set, never a spread/reassign of an integrated Y
// type (the [[yjs-save-load-real-ydoc]] "Type already integrated" trap; see
// control-surface.ts mutateSurface for the same discipline). Axis selection is
// a one-time user action (pick from a dropdown), never per-frame, so there is
// no update-storm risk.
//
// createMatrixEdge() REUSES the platform's existing edge seam: it builds the
// canonical edge shape ({id, source, target, sourceType, targetType}) the
// drag-connect + patch-to paths write, validates it with the SHARED validateEdge
// (so an illegal cell can never materialize), removes any cable currently on the
// target input (an input takes one cable — matches Canvas/patch-to's replace
// semantics), and writes it in ONE LOCAL_ORIGIN transaction so it rides the
// Y.Doc to rack-mates + lands on the undo stack.

import { patch, ydoc, LOCAL_ORIGIN } from '$lib/graph/store';
import type { CableType, Edge, ModuleNode } from '$lib/graph/types';
import { validateEdge, type ResolveDef } from '$lib/graph/validate-edge';
import { matrixEdgeId } from '$lib/ui/matrixmix-grid';

export const MATRIXMIX_TYPE = 'matrixMix';

export interface MatrixMixData {
  /** Node id of the module on the X (column) axis, or undefined. */
  xAxisModuleId?: string;
  /** Node id of the module on the Y (row) axis, or undefined. */
  yAxisModuleId?: string;
}

/** Coerce a node's `data` into a typed MatrixMixData (never throws). */
export function readMatrixData(node: { data?: unknown } | undefined): MatrixMixData {
  const d = node?.data;
  if (!d || typeof d !== 'object') return {};
  return d as MatrixMixData;
}

function mutateMatrix(matrixId: string, fn: (data: MatrixMixData) => void): void {
  ydoc.transact(() => {
    const target = patch.nodes[matrixId];
    if (!target) return;
    if (!target.data) target.data = {};
    fn(target.data as MatrixMixData);
  }, LOCAL_ORIGIN);
}

/** Set (or clear, with undefined/'') the X-axis module selection IN PLACE. */
export function setXAxisModule(matrixId: string, moduleId: string | undefined): void {
  mutateMatrix(matrixId, (data) => {
    if (moduleId) data.xAxisModuleId = moduleId; // set a single key in place
    else delete data.xAxisModuleId;
  });
}

/** Set (or clear) the Y-axis module selection IN PLACE. */
export function setYAxisModule(matrixId: string, moduleId: string | undefined): void {
  mutateMatrix(matrixId, (data) => {
    if (moduleId) data.yAxisModuleId = moduleId; // set a single key in place
    else delete data.yAxisModuleId;
  });
}

/**
 * Create the edge a legal matrix cell describes — the cable runs
 * source(output) → target(input). REUSES the shared validateEdge seam (the
 * same structural gate the drag + patch-to paths use) and SILENTLY no-ops on
 * an illegal candidate, mirroring the drag-path's silent reject.
 *
 * On success: removes any cable currently terminating on the target INPUT (an
 * input holds one cable — same replace semantics as Canvas commitCarriedEdge /
 * patch-to), then writes the new edge, all in ONE LOCAL_ORIGIN transaction.
 *
 * Returns the created edge's id on success, or null when the candidate was
 * rejected / already existed / a node was missing.
 *
 * @param source     output endpoint {nodeId, portId}
 * @param target     input endpoint  {nodeId, portId}
 * @param sourceType the output's emitted cable type
 * @param targetType the input's declared cable type
 * @param resolveDef registry def lookup (the card passes the audio/video/meta
 *                   chain) — validateEdge needs it to confirm direction + types
 */
export function createMatrixEdge(
  source: { nodeId: string; portId: string },
  target: { nodeId: string; portId: string },
  sourceType: CableType,
  targetType: CableType,
  resolveDef: ResolveDef,
): string | null {
  const id = matrixEdgeId(source, target);
  if (patch.edges[id]) return id; // idempotent — same edge already present
  const candidate: Edge = { id, source, target, sourceType, targetType };
  const verdict = validateEdge(
    candidate,
    Object.values(patch.nodes) as ModuleNode[],
    resolveDef,
  );
  if (!verdict.ok) return null; // illegal — silent no-op, matches the drag path
  ydoc.transact(() => {
    // An input takes ONE cable: drop whatever currently feeds the target input
    // (same replace semantics as Canvas commitCarriedEdge / patch-to).
    for (const [edgeId, edge] of Object.entries(patch.edges)) {
      if (edge && edge.target.nodeId === target.nodeId && edge.target.portId === target.portId) {
        delete patch.edges[edgeId];
      }
    }
    patch.edges[id] = { id, source, target, sourceType, targetType };
  }, LOCAL_ORIGIN);
  return id;
}
