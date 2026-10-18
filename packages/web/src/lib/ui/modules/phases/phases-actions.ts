import { patch } from '$lib/graph/store';
import { mutateNode, setNodeParam } from '$lib/graph/mutate';
import type { ModuleNode } from '$lib/graph/types';
import { setPhasesRuntimeMode, type PhasesMode } from '$lib/audio/phases-runtime';
import {
  insertPhasesVertex,
  sanitizePhasesVertices,
  type PhasesVertex,
} from '../../../../../../dsp/src/lib/phases-dsp';

export function readPhasesVertices(nodeId: string): PhasesVertex[] {
  return sanitizePhasesVertices(patch.nodes[nodeId]?.data?.vertices);
}

/** All edits use the tracked graph seam, so both surfaces, undo and peers agree. */
export function writePhasesVertices(nodeId: string, vertices: readonly PhasesVertex[]): void {
  const next = sanitizePhasesVertices(vertices);
  mutateNode(nodeId, (node) => {
    if (node.type !== 'phases') return;
    if (!node.data) node.data = {};
    node.data.vertices = next;
  });
}

/** Initialize defaults once; ordinary edits retain the integrated Y.Array/maps. */
function editableVertices(node: ModuleNode): PhasesVertex[] {
  if (!node.data) node.data = {};
  const raw = node.data.vertices;
  const valid = Array.isArray(raw) && raw.length >= 2
    && raw.every((v) => v && typeof v === 'object'
      && [v.x, v.y, v.shape].every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1))
    && raw.some((v) => v.x === 0) && raw.some((v) => v.x === 1);
  if (!valid) node.data.vertices = sanitizePhasesVertices(raw);
  return node.data.vertices as PhasesVertex[];
}

export function addPhasesVertex(nodeId: string, x: number): PhasesVertex | null {
  let added: PhasesVertex | null = null;
  mutateNode(nodeId, (node) => {
    if (node.type !== 'phases') return;
    const live = editableVertices(node);
    const current = sanitizePhasesVertices(live);
    const next = insertPhasesVertex(current, x);
    if (next.length === current.length) return;
    const vertex = next.find((v) => !current.some((before) => before.x === v.x))!;
    const index = live.findIndex((v) => v.x > vertex.x);
    live.splice(index < 0 ? live.length : index, 0, vertex);
    added = { ...vertex };
  });
  return added;
}

/** x is immutable while dragging: a peer deleting a point cannot retarget the drag. */
export function setPhasesVertexY(nodeId: string, x: number, y: number): void {
  if (!Number.isFinite(y)) return;
  mutateNode(nodeId, (node) => {
    if (node.type !== 'phases') return;
    const vertex = editableVertices(node).find((v) => v.x === x);
    if (vertex) vertex.y = Math.max(0, Math.min(1, y));
  });
}

export function setPhasesShape(nodeId: string, x: number, shape: number): void {
  if (x === 1 || !Number.isFinite(shape)) return;
  mutateNode(nodeId, (node) => {
    if (node.type !== 'phases') return;
    const vertex = editableVertices(node).find((v) => v.x === x);
    if (vertex) vertex.shape = Math.max(0, Math.min(1, shape));
  });
}

export function removePhasesVertex(nodeId: string, x: number): number | null {
  if (x <= 0 || x >= 1) return null;
  let leftX: number | null = null;
  mutateNode(nodeId, (node) => {
    if (node.type !== 'phases') return;
    const live = editableVertices(node);
    const ordered = sanitizePhasesVertices(live);
    const index = ordered.findIndex((v) => v.x === x);
    if (index <= 0 || index >= ordered.length - 1) return;
    leftX = ordered[index - 1]!.x;
    // Concurrent insertions at the same x render as one vertex. Delete all of
    // them together so a hidden duplicate cannot reappear after the action.
    // Its left neighbour's outgoing shape is untouched by the merge.
    for (let i = live.length - 1; i >= 0; i--) {
      if (live[i]!.x === x) live.splice(i, 1);
    }
  });
  return leftX;
}

/** A gate can change the live mode without changing its saved param. */
export function setPhasesMode(nodeId: string, name: PhasesMode, value: number): void {
  if (patch.nodes[nodeId]?.type !== 'phases') return;
  const enabled = value >= 0.5;
  setPhasesRuntimeMode(nodeId, name, enabled);
  setNodeParam(nodeId, name, enabled ? 1 : 0);
}
