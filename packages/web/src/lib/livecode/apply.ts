// packages/web/src/lib/livecode/apply.ts
//
// Apply a Mutation list to the live patch graph. Shared by LivecodeCard
// (one-shot RUN) and the clockedRunner factory (per-tick re-fire).
//
// The CALLER is responsible for wrapping the call in `ydoc.transact`
// so all the mutations land in one Yjs update + remote collaborators
// see the rack change atomically.

import type { Mutation } from './runtime';
import { patch as livePatch } from '$lib/graph/store';

export function applyMutations(mutations: readonly Mutation[]): void {
  for (const m of mutations) {
    applyMutation(m);
  }
}

export function applyMutation(m: Mutation): void {
  if (m.kind === 'spawnNode') {
    livePatch.nodes[m.node.id] = m.node;
    return;
  }
  if (m.kind === 'addEdge') {
    livePatch.edges[m.edge.id] = m.edge;
    return;
  }
  if (m.kind === 'removeEdge') {
    delete livePatch.edges[m.edgeId];
    return;
  }
  if (m.kind === 'setParam') {
    const target = livePatch.nodes[m.nodeId];
    if (!target) return;
    target.params[m.paramId] = m.value;
    return;
  }
  if (m.kind === 'setData') {
    const target = livePatch.nodes[m.nodeId];
    if (!target) return;
    if (!target.data) target.data = {};
    target.data[m.key] = m.value;
    return;
  }
}
