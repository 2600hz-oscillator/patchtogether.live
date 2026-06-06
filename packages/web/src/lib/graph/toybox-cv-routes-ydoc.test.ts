// packages/web/src/lib/graph/toybox-cv-routes-ydoc.test.ts
//
// REAL-Y.Doc regression tests for the TOYBOX Phase-5 cvRoutes mutator. Runs
// against the SAME syncedStore + Y.Doc the live patch uses, so cvRoutes entries
// become real Y.Maps once written — the way to catch the "Type already
// integrated" trap if a re-route ever spread an already-integrated entry.
// Mirrors toybox-combine-ydoc.test.ts ([[yjs-save-load-real-ydoc]]).

import { describe, it, expect, afterEach } from 'vitest';
import { patch } from '$lib/graph/store';
import { setCvRoute, clearCvRoute, readCvRoutes } from './toybox-cv-routes';
import { addCombineNode, deleteCombineNode } from './toybox-combine';
import { findOrphanedRoutes, type CvRoutes } from '$lib/video/toybox-cv-routes';
import { makeDefaultCombineGraph } from '$lib/video/toybox-combine-graph';
import { makeDefaultLayers } from '$lib/video/toybox-content';
import type { ModuleNode } from './types';

const TID = 'toybox-cvroutes-ydoc-test';

function makeToybox(): void {
  patch.nodes[TID] = {
    id: TID,
    type: 'toybox',
    domain: 'video',
    position: { x: 0, y: 0 },
    params: {},
    data: {},
  } as unknown as ModuleNode;
}

afterEach(() => {
  delete patch.nodes[TID];
});

describe('toybox cvRoutes — real Y.Doc mutator', () => {
  it('sets a route for a generic cv port (creates the map in place)', () => {
    makeToybox();
    expect(() =>
      setCvRoute(TID, 'cv1', { target: 'layer', layer: 0, param: 'speed' }),
    ).not.toThrow();
    const routes = readCvRoutes(patch.nodes[TID]);
    expect(routes.cv1).toMatchObject({ target: 'layer', layer: 0, param: 'speed' });
  });

  it('sets MULTIPLE distinct routes without throwing (the integrate trap)', () => {
    makeToybox();
    expect(() => {
      setCvRoute(TID, 'cv1', { target: 'layer', layer: 0, param: 'speed' });
      setCvRoute(TID, 'cv2', { target: 'combine', nodeId: 'op1', param: 'amount' });
      setCvRoute(TID, 'cv3', { target: 'layer', layer: 2, param: 'material:spin' });
    }).not.toThrow();
    const routes = readCvRoutes(patch.nodes[TID]);
    expect(routes.cv1).toMatchObject({ target: 'layer', layer: 0, param: 'speed' });
    expect(routes.cv2).toMatchObject({ target: 'combine', nodeId: 'op1', param: 'amount' });
    expect(routes.cv3).toMatchObject({ target: 'layer', layer: 2, param: 'material:spin' });
  });

  it('RE-routes an already-set port in place (set a fresh entry, never spread)', () => {
    makeToybox();
    setCvRoute(TID, 'cv1', { target: 'layer', layer: 0, param: 'speed' });
    expect(() =>
      setCvRoute(TID, 'cv1', { target: 'combine', nodeId: 'op2', param: 'amount' }),
    ).not.toThrow();
    const routes = readCvRoutes(patch.nodes[TID]);
    expect(routes.cv1).toMatchObject({ target: 'combine', nodeId: 'op2', param: 'amount' });
    // No leftover layer field from the prior route.
    expect(routes.cv1!.layer).toBeUndefined();
  });

  it('clears a route (writes null in place)', () => {
    makeToybox();
    setCvRoute(TID, 'cv1', { target: 'layer', layer: 0, param: 'speed' });
    expect(() => clearCvRoute(TID, 'cv1')).not.toThrow();
    const routes = readCvRoutes(patch.nodes[TID]);
    expect(routes.cv1 ?? null).toBeNull();
  });

  it('readCvRoutes returns {} for a node with no cvRoutes', () => {
    makeToybox();
    expect(readCvRoutes(patch.nodes[TID])).toEqual({});
  });
});

// #60: the card's prune effect = findOrphanedRoutes(live routes, live layers,
// live combine) → clearCvRoute(each). Drive that against the REAL Y.Doc (state
// persists) so a stale mapping is forgotten when the tree changes underneath it,
// and a still-valid route survives.
describe('toybox cv orphan auto-unmap — real Y.Doc tree mutations', () => {
  /** Seed live layers + a default combine graph on the node, in place. */
  function seedTree(): void {
    const t = patch.nodes[TID]!;
    if (!t.data) (t as { data: Record<string, unknown> }).data = {};
    const data = t.data as { layers?: unknown; combine?: unknown };
    // layers: default (layer0 = gen, 1..3 off). Push plain clones in place.
    data.layers = [];
    for (const l of makeDefaultLayers()) (data.layers as unknown[]).push(JSON.parse(JSON.stringify(l)));
    // combine: default graph.
    data.combine = { nodes: [], edges: [] };
    const def = makeDefaultCombineGraph();
    const g = data.combine as { nodes: unknown[]; edges: unknown[] };
    for (const n of def.nodes) g.nodes.push(JSON.parse(JSON.stringify(n)));
    for (const e of def.edges) g.edges.push(JSON.parse(JSON.stringify(e)));
  }

  /** Replicate the card's prune: clear every orphaned route in place. */
  function prune(): string[] {
    const data = patch.nodes[TID]?.data as
      | { layers?: never[]; combine?: unknown; cvRoutes?: CvRoutes }
      | undefined;
    const orphans = findOrphanedRoutes(data?.cvRoutes, data?.layers, data?.combine);
    for (const port of orphans) clearCvRoute(TID, port);
    return orphans;
  }

  it('unmaps a route to a DELETED combine node; keeps a valid one', () => {
    makeToybox();
    seedTree();
    const newId = addCombineNode(TID, 'chromakey')!;
    setCvRoute(TID, 'cv1', { target: 'combine', nodeId: newId, param: 'amount' });
    setCvRoute(TID, 'cv2', { target: 'combine', nodeId: 'op1', param: 'amount' });
    expect(prune()).toEqual([]); // both resolvable → nothing pruned

    deleteCombineNode(TID, newId); // orphans cv1
    expect(prune()).toEqual(['cv1']);

    const routes = readCvRoutes(patch.nodes[TID]);
    expect(routes.cv1 ?? null).toBeNull(); // unmapped + persisted
    expect(routes.cv2).toMatchObject({ nodeId: 'op1', param: 'amount' }); // survived
  });

  it('idempotent: a second prune finds nothing (no loop)', () => {
    makeToybox();
    seedTree();
    setCvRoute(TID, 'cv1', { target: 'combine', nodeId: 'op1', param: 'amount' });
    deleteCombineNode(TID, 'op1');
    expect(prune()).toEqual(['cv1']);
    expect(prune()).toEqual([]); // settled — the card's effect won't loop
  });
});
