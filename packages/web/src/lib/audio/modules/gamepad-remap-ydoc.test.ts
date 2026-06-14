// packages/web/src/lib/audio/modules/gamepad-remap-ydoc.test.ts
//
// REAL-Y.Doc regression for the GAMEPAD remap mutation. The card commits a
// remap through `mutateNode(...) → applyBindingToData(live.data, ...)` against
// the LIVE SyncedStore proxy, so `node.data.bindings` becomes a real Y.Map once
// written. The shipped bug: the commit spread the live proxy and then re-assigned
// its OWN already-integrated value objects back onto it, which Yjs rejects
// ("reassigning object that already occurs in the tree"). That throw escaped the
// card's rAF poll → the poll loop died → the module went DEAD (no CV/output)
// after the 2nd remap (e.g. remapping the right stick after touching anything).
//
// These exercise the SAME mutators the card calls, against the SAME syncedStore
// the live patch uses — the only way to catch the integrated-type trap (a pure
// plain-object test can't, since plain objects are never "integrated"). Mirrors
// toybox-combine-ydoc.test.ts + the [[yjs-save-load-real-ydoc]] discipline.

import { describe, it, expect, afterEach } from 'vitest';
import { patch } from '$lib/graph/store';
import { mutateNode } from '$lib/graph/mutate';
import {
  applyBindingToData,
  clearBindingOnData,
  toggleInvertOnData,
  bindingForOutput,
  type GamepadData,
  type PhysicalControl,
  type InvertibleAxis,
} from './gamepad';
import type { ModuleNode } from '$lib/graph/types';

const TID = 'gamepad-remap-ydoc-test';

function makeGamepad(): void {
  patch.nodes[TID] = {
    id: TID,
    type: 'gamepad',
    domain: 'audio',
    position: { x: 0, y: 0 },
    params: {},
    data: {},
  } as unknown as ModuleNode;
}

/** Commit a remap the way the card does — in a tracked transaction against the
 *  live node. */
function commitRemap(outputId: string, control: PhysicalControl): void {
  mutateNode(TID, (live) => {
    if (!live.data) live.data = {};
    applyBindingToData(live.data as GamepadData, outputId, control);
  });
}
function clearRemap(outputId: string): void {
  mutateNode(TID, (live) => {
    if (live.data) clearBindingOnData(live.data as GamepadData, outputId);
  });
}
function toggleInvert(axisId: InvertibleAxis): void {
  mutateNode(TID, (live) => {
    if (!live.data) live.data = {};
    toggleInvertOnData(live.data as GamepadData, axisId);
  });
}
function readBindings() {
  return (patch.nodes[TID]!.data as GamepadData).bindings;
}
function readInvert() {
  return (patch.nodes[TID]!.data as GamepadData).invert;
}

afterEach(() => {
  delete patch.nodes[TID];
});

describe('GAMEPAD remap — real Y.Doc mutation', () => {
  it('first remap writes the binding (the path that always worked)', () => {
    makeGamepad();
    expect(() => commitRemap('a', { kind: 'button', index: 2 })).not.toThrow();
    expect(readBindings()?.a).toEqual({ kind: 'button', index: 2 });
  });

  it('SECOND remap does NOT throw + preserves the first binding (the bug)', () => {
    makeGamepad();
    commitRemap('a', { kind: 'button', index: 2 });
    // The shipped code threw HERE ("reassigning object that already occurs in
    // the tree"), killing the card's rAF poll → module dead.
    expect(() => commitRemap('rx', { kind: 'axis', index: 5 })).not.toThrow();
    expect(readBindings()?.a).toEqual({ kind: 'button', index: 2 });
    expect(readBindings()?.rx).toEqual({ kind: 'axis', index: 5 });
  });

  it('remapping the RIGHT STICK keeps every OTHER axis/button working', () => {
    makeGamepad();
    // Remap a couple of other outputs first…
    commitRemap('lx', { kind: 'axis', index: 3 });
    commitRemap('a', { kind: 'button', index: 1 });
    // …then remap the right stick X — the user's exact report.
    expect(() => commitRemap('rx', { kind: 'axis', index: 0 })).not.toThrow();
    // The right stick now follows its new axis…
    expect(bindingForOutput('rx', readBindings())).toEqual({ kind: 'axis', index: 0 });
    // …and the previously-remapped outputs are untouched.
    expect(bindingForOutput('lx', readBindings())).toEqual({ kind: 'axis', index: 3 });
    expect(bindingForOutput('a', readBindings())).toEqual({ kind: 'button', index: 1 });
    // …and an un-remapped output still resolves to its default.
    expect(bindingForOutput('b', readBindings())).toEqual({ kind: 'button', index: 1 });
  });

  it('many sequential remaps never throw (re-binding the same output repeatedly)', () => {
    makeGamepad();
    expect(() => {
      commitRemap('rx', { kind: 'axis', index: 0 });
      commitRemap('rx', { kind: 'axis', index: 1 });
      commitRemap('ry', { kind: 'axis', index: 0 });
      commitRemap('a', { kind: 'button', index: 3 });
      commitRemap('rx', { kind: 'axis', index: 5 });
    }).not.toThrow();
    expect(readBindings()?.rx).toEqual({ kind: 'axis', index: 5 });
    expect(readBindings()?.ry).toEqual({ kind: 'axis', index: 0 });
    expect(readBindings()?.a).toEqual({ kind: 'button', index: 3 });
  });

  it('clear an override on the live doc + re-add does not throw', () => {
    makeGamepad();
    commitRemap('a', { kind: 'button', index: 2 });
    commitRemap('b', { kind: 'button', index: 3 });
    expect(() => clearRemap('a')).not.toThrow();
    expect(readBindings()?.a).toBeUndefined();
    expect(readBindings()?.b).toEqual({ kind: 'button', index: 3 });
    // Re-add after a clear (another spread+commit) — still fine.
    expect(() => commitRemap('a', { kind: 'button', index: 4 })).not.toThrow();
    expect(readBindings()?.a).toEqual({ kind: 'button', index: 4 });
  });

  it('invert toggles ride the live doc + survive sequential toggles', () => {
    makeGamepad();
    expect(() => {
      toggleInvert('rx');
      toggleInvert('ly');
      toggleInvert('rx'); // off again
    }).not.toThrow();
    expect(readInvert()).toEqual({ ly: true });
    // Invert + remap coexist on the same node.data without clobbering.
    commitRemap('rx', { kind: 'axis', index: 0 });
    expect(readInvert()).toEqual({ ly: true });
    expect(readBindings()?.rx).toEqual({ kind: 'axis', index: 0 });
  });
});
