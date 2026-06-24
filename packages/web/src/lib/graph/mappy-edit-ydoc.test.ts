// packages/web/src/lib/graph/mappy-edit-ydoc.test.ts
//
// REAL-Y.Doc regression tests for the MAPPY surface edit mutators (add/remove
// surfaces, set/move corners, surfaceCount). Runs against the SAME syncedStore +
// Y.Doc the live patch uses (graph/store.ts), so node.data.surfaces becomes a
// real Y type once written — the way to catch the "Type already integrated" trap
// (control-surface #566) if a mutator ever spread an integrated child. Mirrors
// the control-surface / matrixmix Y.Doc discipline ([[yjs-save-load-real-ydoc]]).

import { describe, it, expect, afterEach } from 'vitest';
import { patch } from '$lib/graph/store';
import type { ModuleNode } from './types';
import {
  ensureSurfaces,
  getSurfaceCount,
  setSurfaceCount,
  addSurface,
  removeSurface,
  setCorner,
  moveSurface,
  resetSurface,
  getSurfaceFit,
  setSurfaceFit,
  toggleSurfaceFit,
} from '$lib/ui/modules/mappy-edit';
import { defaultSurface, insetQuadForIndex, surfaceFitOn } from '$lib/video/modules/mappy';

const MID = 'mappy-ydoc-test';

function setup(): void {
  patch.nodes[MID] = {
    id: MID, type: 'mappy', domain: 'video', position: { x: 0, y: 0 }, params: {}, data: {},
  } as unknown as ModuleNode;
}

afterEach(() => {
  for (const id of Object.keys(patch.nodes)) delete patch.nodes[id];
  for (const id of Object.keys(patch.edges)) delete patch.edges[id];
});

describe('mappy-edit — real Y.Doc surface mutators', () => {
  it('defaults to one live surface; ensureSurfaces seeds six full-frame surfaces', () => {
    setup();
    expect(getSurfaceCount(patch.nodes[MID])).toBe(1);
    const arr = ensureSurfaces(MID);
    expect(arr).toHaveLength(6);
    expect(arr![0]!.corners).toEqual(defaultSurface().corners);
  });

  it('add then remove repeatedly never throws the integrate trap + clamps 1..6', () => {
    setup();
    expect(() => {
      for (let k = 0; k < 8; k++) addSurface(MID); // past 6
    }).not.toThrow();
    expect(getSurfaceCount(patch.nodes[MID])).toBe(6);
    expect(() => {
      for (let k = 0; k < 8; k++) removeSurface(MID); // past 1
    }).not.toThrow();
    expect(getSurfaceCount(patch.nodes[MID])).toBe(1);
  });

  it('a newly-added surface drops in as a staggered inset quad', () => {
    setup();
    addSurface(MID); // count 1 → 2; surface index 1 becomes live
    const arr = ensureSurfaces(MID)!;
    expect(arr[1]!.corners).toEqual(insetQuadForIndex(1));
    expect(arr[1]!.corners).not.toEqual(defaultSurface().corners);
  });

  it('−/+ toggling is NON-destructive: a shaped surface keeps its corners', () => {
    setup();
    addSurface(MID); // count 2; surface 1 is now inset
    // shape surface 1 to a custom skew
    setCorner(MID, 1, 0, 0.11, 0.12);
    setCorner(MID, 1, 2, 0.61, 0.62);
    const shaped = ensureSurfaces(MID)![1]!.corners.map((c) => [...c]);
    removeSurface(MID); // count 1 (surface 1 no longer live, but corners kept)
    addSurface(MID);    // count 2 again — must NOT re-seed (not full-frame)
    const after = ensureSurfaces(MID)![1]!.corners;
    expect(after).toEqual(shaped);
  });

  it('setSurfaceCount mirrors to the param + clamps', () => {
    setup();
    setSurfaceCount(MID, 4);
    expect(getSurfaceCount(patch.nodes[MID])).toBe(4);
    expect(patch.nodes[MID]!.params.surfaceCount).toBe(4);
    setSurfaceCount(MID, 99);
    expect(getSurfaceCount(patch.nodes[MID])).toBe(6);
    expect(patch.nodes[MID]!.params.surfaceCount).toBe(6);
  });

  it('setCorner mutates in place + clamps to [0,1]; survives repeated writes', () => {
    setup();
    expect(() => {
      setCorner(MID, 0, 0, 0.3, 0.4);
      setCorner(MID, 0, 0, 1.5, -0.2); // clamps
      setCorner(MID, 0, 2, 0.9, 0.8);
    }).not.toThrow();
    const arr = ensureSurfaces(MID)!;
    expect(arr[0]!.corners[0]).toEqual([1, 0]);
    expect(arr[0]!.corners[2]).toEqual([0.9, 0.8]);
  });

  it('moveSurface translates every corner, clamped so the quad stays on-screen', () => {
    setup();
    addSurface(MID); // surface 1 = inset quad
    const before = ensureSurfaces(MID)![1]!.corners.map((c) => [...c]);
    moveSurface(MID, 1, 0.1, 0.05);
    const after = ensureSurfaces(MID)![1]!.corners;
    for (let c = 0; c < 4; c++) {
      expect(after[c]![0]).toBeCloseTo(before[c]![0] + 0.1, 6);
      expect(after[c]![1]).toBeCloseTo(before[c]![1] + 0.05, 6);
    }
    // a huge move is clamped — every corner stays inside [0,1]
    moveSurface(MID, 1, 99, 99);
    for (const c of ensureSurfaces(MID)![1]!.corners) {
      expect(c[0]).toBeLessThanOrEqual(1);
      expect(c[1]).toBeLessThanOrEqual(1);
    }
  });

  it('resetSurface restores full-frame', () => {
    setup();
    setCorner(MID, 0, 0, 0.2, 0.2);
    resetSurface(MID, 0);
    expect(ensureSurfaces(MID)![0]!.corners).toEqual(defaultSurface().corners);
  });
});

describe('mappy-edit — per-surface FIT toggle (real Y.Doc)', () => {
  it('defaults FIT ON for every seeded surface', () => {
    setup();
    const arr = ensureSurfaces(MID)!;
    for (const s of arr) expect(surfaceFitOn(s)).toBe(true);
    expect(getSurfaceFit(patch.nodes[MID], 0)).toBe(true);
    expect(getSurfaceFit(patch.nodes[MID], 5)).toBe(true);
  });

  it('setSurfaceFit persists in place + survives repeated writes (no integrate trap)', () => {
    setup();
    expect(() => {
      setSurfaceFit(MID, 0, false);
      setSurfaceFit(MID, 0, true);
      setSurfaceFit(MID, 0, false);
    }).not.toThrow();
    expect(getSurfaceFit(patch.nodes[MID], 0)).toBe(false);
    expect(ensureSurfaces(MID)![0]!.fit).toBe(false);
  });

  it('toggleSurfaceFit flips + returns the NEW value', () => {
    setup();
    expect(toggleSurfaceFit(MID, 2)).toBe(false); // was ON → OFF
    expect(getSurfaceFit(patch.nodes[MID], 2)).toBe(false);
    expect(toggleSurfaceFit(MID, 2)).toBe(true); // OFF → ON
    expect(getSurfaceFit(patch.nodes[MID], 2)).toBe(true);
  });

  it('surfaces are INDEPENDENT — toggling one does not change another', () => {
    setup();
    ensureSurfaces(MID);
    setSurfaceFit(MID, 1, false);
    expect(getSurfaceFit(patch.nodes[MID], 1)).toBe(false);
    expect(getSurfaceFit(patch.nodes[MID], 0)).toBe(true);
    expect(getSurfaceFit(patch.nodes[MID], 2)).toBe(true);
  });

  it('FIT survives corner edits + add/remove churn (independent of geometry)', () => {
    setup();
    setSurfaceFit(MID, 0, false);
    // mutate geometry on the same surface — fit must not be clobbered
    setCorner(MID, 0, 0, 0.3, 0.3);
    moveSurface(MID, 0, 0.05, 0.05);
    expect(getSurfaceFit(patch.nodes[MID], 0)).toBe(false);
    // add/remove churn (re-normalizes / reads) keeps the value
    addSurface(MID);
    removeSurface(MID);
    expect(getSurfaceFit(patch.nodes[MID], 0)).toBe(false);
  });

  it('an OLD persisted surface with no `fit` field reads as ON', () => {
    setup();
    // simulate a pre-toggle patch: surfaces present (length 6) but no fit field.
    patch.nodes[MID]!.data = {
      surfaces: Array.from({ length: 6 }, () => ({
        corners: [[0, 0], [1, 0], [1, 1], [0, 1]],
      })),
    } as unknown as Record<string, unknown>;
    expect(getSurfaceFit(patch.nodes[MID], 0)).toBe(true);
    // and toggling it from the implicit-ON state writes an explicit false
    expect(toggleSurfaceFit(MID, 0)).toBe(false);
    expect(getSurfaceFit(patch.nodes[MID], 0)).toBe(false);
  });
});
