// packages/web/src/lib/graph/control-surface-ydoc.test.ts
//
// REAL-Y.Doc regression tests for the control-surface mutators. These run
// against the SAME syncedStore + Y.Doc the live patch uses (graph/store.ts),
// so binding/screen/layout entries become real Y.Maps once written — the only
// way to catch the "Type already integrated" trap. The previous plain-object
// unit tests passed while the live feature broke on the SECOND send-to-surface
// (the mutators spread an already-integrated array into a fresh one). Mirrors
// the sequencer save-to-slot real-Y.Doc discipline ([[yjs-save-load-real-ydoc]]).

import { describe, it, expect, afterEach } from 'vitest';
import { patch } from '$lib/graph/store';
import {
  CONTROL_SURFACE_TYPE,
  addBindingToSurface,
  removeBindingFromSurface,
  setSurfaceGroupPosition,
  setSurfaceLocked,
  readSurfaceData,
  groupBindingsByModule,
} from './control-surface';
import type { ModuleNode } from './types';

const SID = 'cs-ydoc-test';

function makeSurface(): void {
  patch.nodes[SID] = {
    id: SID,
    type: CONTROL_SURFACE_TYPE,
    domain: 'meta',
    position: { x: 0, y: 0 },
    params: {},
    data: {},
  } as unknown as ModuleNode;
}

afterEach(() => {
  delete patch.nodes[SID];
});

describe('control surface — real Y.Doc binding mutators', () => {
  it('sends MULTIPLE controls from MULTIPLE modules without throwing (the 2nd-add regression)', () => {
    makeSurface();
    // The original bug: the FIRST add worked, the SECOND threw "Type already
    // integrated" because the mutator spread the now-integrated first binding
    // into a fresh array. Adding several in a row must not throw.
    expect(() => {
      addBindingToSurface(SID, 'adsr-1', 'attack');
      addBindingToSurface(SID, 'adsr-1', 'decay'); // ← used to break here
      addBindingToSurface(SID, 'vco-1', 'tune');
      addBindingToSurface(SID, 'vco-1', 'fine');
      addBindingToSurface(SID, 'filt-1', 'cutoff');
    }).not.toThrow();

    const data = readSurfaceData(patch.nodes[SID]);
    expect(data.bindings?.length).toBe(5);
    // Grouped by source module, first-seen order preserved.
    const groups = groupBindingsByModule((data.bindings ?? []).map((b) => ({ moduleId: b.moduleId, paramId: b.paramId })));
    expect(groups.map((g) => g.moduleId)).toEqual(['adsr-1', 'vco-1', 'filt-1']);
    expect(groups[0].bindings.length).toBe(2);
    expect(groups[1].bindings.length).toBe(2);
    expect(groups[2].bindings.length).toBe(1);
  });

  it('dedupes a repeated add (same module + param)', () => {
    makeSurface();
    addBindingToSurface(SID, 'adsr-1', 'attack');
    addBindingToSurface(SID, 'adsr-1', 'attack'); // no-op
    expect(readSurfaceData(patch.nodes[SID]).bindings?.length).toBe(1);
  });

  it('removes one binding in place, leaving the rest intact', () => {
    makeSurface();
    addBindingToSurface(SID, 'adsr-1', 'attack');
    addBindingToSurface(SID, 'adsr-1', 'decay');
    addBindingToSurface(SID, 'vco-1', 'tune');
    expect(() => removeBindingFromSurface(SID, 'adsr-1', 'attack')).not.toThrow();
    const data = readSurfaceData(patch.nodes[SID]);
    const keys = (data.bindings ?? []).map((b) => `${b.moduleId}:${b.paramId}`);
    expect(keys).toEqual(['adsr-1:decay', 'vco-1:tune']);
    // ...and we can keep adding afterward (array still healthy).
    expect(() => addBindingToSurface(SID, 'lfo-1', 'rate')).not.toThrow();
    expect(readSurfaceData(patch.nodes[SID]).bindings?.length).toBe(3);
  });

  it('records + re-updates group layout positions in place (move-when-unlocked)', () => {
    makeSurface();
    expect(() => {
      setSurfaceGroupPosition(SID, 'adsr-1', 10, 20);
      setSurfaceGroupPosition(SID, 'vco-1', 200, 40); // 2nd module — used to spread+throw
      setSurfaceGroupPosition(SID, 'adsr-1', 15, 25); // re-move the first
    }).not.toThrow();
    const layout = readSurfaceData(patch.nodes[SID]).layout ?? {};
    expect(layout['adsr-1']).toEqual({ x: 15, y: 25 });
    expect(layout['vco-1']).toEqual({ x: 200, y: 40 });
  });

  it('toggles locked', () => {
    makeSurface();
    setSurfaceLocked(SID, true);
    expect(readSurfaceData(patch.nodes[SID]).locked).toBe(true);
    setSurfaceLocked(SID, false);
    expect(readSurfaceData(patch.nodes[SID]).locked).toBe(false);
  });

  it('full lifecycle: add many → move → lock → remove all, never throws', () => {
    makeSurface();
    expect(() => {
      for (const [m, p] of [['a', 'p1'], ['a', 'p2'], ['b', 'q1'], ['c', 'r1'], ['c', 'r2']] as const) {
        addBindingToSurface(SID, m, p);
      }
      setSurfaceGroupPosition(SID, 'a', 0, 0);
      setSurfaceGroupPosition(SID, 'b', 180, 0);
      setSurfaceGroupPosition(SID, 'c', 0, 150);
      setSurfaceLocked(SID, true);
      removeBindingFromSurface(SID, 'a', 'p1');
      removeBindingFromSurface(SID, 'c', 'r2');
    }).not.toThrow();
    expect(readSurfaceData(patch.nodes[SID]).bindings?.length).toBe(3);
  });
});
