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
