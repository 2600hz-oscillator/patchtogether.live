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
  setRightStickZeroOnData,
  resetRightStickZeroOnData,
  bindingForOutput,
  exportMapping,
  applyMapping,
  GAMEPAD_PRESETS,
  type GamepadData,
  type GamepadMapping,
  type PhysicalControl,
  type InvertibleAxis,
  type StickCalibration,
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
/** Capture a right-stick axis zero the way the card does (in-place, tracked). */
function zeroRight(axis: 'x' | 'y', raw: number): void {
  mutateNode(TID, (live) => {
    if (!live.data) live.data = {};
    setRightStickZeroOnData(live.data as GamepadData, axis, raw);
  });
}
function resetRightZero(): void {
  mutateNode(TID, (live) => {
    if (live.data) resetRightStickZeroOnData(live.data as GamepadData);
  });
}
function readBindings() {
  return (patch.nodes[TID]!.data as GamepadData).bindings;
}
function readInvert() {
  return (patch.nodes[TID]!.data as GamepadData).invert;
}
function readData() {
  return patch.nodes[TID]!.data as GamepadData;
}
/** Apply a mapping the way the card does — in a tracked transaction against the
 *  live node (the path that must NOT re-assign an integrated Y type). */
function applyMappingLive(mapping: GamepadMapping): void {
  mutateNode(TID, (live) => {
    if (!live.data) live.data = {};
    applyMapping(live.data as GamepadData, mapping);
  });
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

  // ---------------- right-stick ZERO — real Y.Doc persistence ----------------
  // The card captures a right-stick axis zero through
  // `mutateNode(...) → setRightStickZeroOnData(live.data, ...)` against the LIVE
  // SyncedStore proxy, so `node.data.rightStickZero` becomes a real integrated Y
  // type once written. Re-zeroing the SAME axis (or capturing the OTHER axis)
  // must mutate that leaf IN PLACE — never re-assign an already-integrated Y type
  // ("reassigning object that already occurs in the tree"). A pure plain-object
  // test can't catch this (plain objects are never "integrated").
  it('first zero capture persists rightStickZero on the live doc', () => {
    makeGamepad();
    expect(() => zeroRight('x', 0.4)).not.toThrow();
    expect(readData().rightStickZero).toEqual({ x: 0.4, y: 0 });
  });

  it('zeroing the OTHER axis after the leaf exists does NOT throw (integrated-type trap)', () => {
    makeGamepad();
    zeroRight('x', 0.4); // creates the integrated leaf
    // Capturing Y now mutates the SAME already-integrated leaf in place.
    expect(() => zeroRight('y', -0.3)).not.toThrow();
    expect(readData().rightStickZero).toEqual({ x: 0.4, y: -0.3 });
  });

  it('RE-zeroing the same axis twice never throws + updates in place', () => {
    makeGamepad();
    zeroRight('x', 0.4);
    expect(() => { zeroRight('x', 0.2); zeroRight('x', -0.1); }).not.toThrow();
    expect(readData().rightStickZero?.x).toBeCloseTo(-0.1);
  });

  it('reset clears both offsets on the live doc without throwing', () => {
    makeGamepad();
    zeroRight('x', 0.4);
    zeroRight('y', -0.3);
    expect(() => resetRightZero()).not.toThrow();
    expect(readData().rightStickZero).toEqual({ x: 0, y: 0 });
  });

  it('right-stick zero coexists with remaps + invert on the same node.data', () => {
    makeGamepad();
    commitRemap('rx', { kind: 'axis', index: 0 });
    toggleInvert('ly');
    expect(() => zeroRight('x', 0.4)).not.toThrow();
    expect(readData().rightStickZero).toEqual({ x: 0.4, y: 0 });
    expect(readBindings()?.rx).toEqual({ kind: 'axis', index: 0 });
    expect(readInvert()).toEqual({ ly: true });
  });
});

// ---------------------------------------------------------------------------
// SAVE / LOAD MAPPING — applyMapping against the LIVE Y.Doc. The "Load mapping"
// + "Load preset" UIs commit through `mutateNode → applyMapping(live.data, …)`.
// Just like the remap commit, applyMapping must NOT re-assign an already-
// integrated Y type (the "reassigning object that already occurs in the tree"
// throw that killed the card's rAF poll). These exercise that path against the
// real syncedStore, including the apply-over-existing + apply-twice cases that a
// plain-object test can't catch. [[yjs-save-load-real-ydoc]]
// ---------------------------------------------------------------------------
const FULL_MAPPING: GamepadMapping = {
  bindings: { a: { kind: 'button', index: 2 }, rx: { kind: 'axis', index: 0 } },
  invert: { ly: true, rx: true },
  leftStickCalibration: { minX: -0.7, maxX: 0.8, minY: -0.75, maxY: 0.7, deadzone: 0.1 },
  rightStickCalibration: { minX: -0.6, maxX: 0.6, minY: -0.6, maxY: 0.6, deadzone: 0.12 } as StickCalibration,
};

describe('GAMEPAD save/load mapping — real Y.Doc apply', () => {
  it('applyMapping onto a fresh node writes the whole bundle', () => {
    makeGamepad();
    expect(() => applyMappingLive(FULL_MAPPING)).not.toThrow();
    expect(readBindings()?.a).toEqual({ kind: 'button', index: 2 });
    expect(readBindings()?.rx).toEqual({ kind: 'axis', index: 0 });
    expect(readInvert()).toEqual({ ly: true, rx: true });
    expect(readData().leftStickCalibration?.maxX).toBeCloseTo(0.8);
    expect(readData().rightStickCalibration?.deadzone).toBeCloseTo(0.12);
  });

  it('apply OVER an existing mapping does NOT throw (the integrated-type trap)', () => {
    makeGamepad();
    // Seed live state via the SAME mutators the card uses, so the maps are real
    // integrated Y types before the second apply.
    commitRemap('b', { kind: 'button', index: 5 });
    toggleInvert('lx');
    applyMappingLive(FULL_MAPPING); // first apply over live data
    // The second apply (e.g. loading a different file) re-writes the already-
    // integrated bindings/invert maps in place — this is the throw site.
    expect(() => applyMappingLive(FULL_MAPPING)).not.toThrow();
    expect(readBindings()?.a).toEqual({ kind: 'button', index: 2 });
    // The pre-existing 'b' override + 'lx' invert were replaced by the mapping.
    expect(readBindings()?.b).toBeUndefined();
    expect(readInvert()).toEqual({ ly: true, rx: true });
  });

  it('apply TWICE (idempotent) never throws + leaves identical data', () => {
    makeGamepad();
    applyMappingLive(FULL_MAPPING);
    expect(() => applyMappingLive(FULL_MAPPING)).not.toThrow();
    expect(readBindings()?.rx).toEqual({ kind: 'axis', index: 0 });
    expect(readData().rightStickCalibration?.maxX).toBeCloseTo(0.6);
  });

  it('export from the live doc then re-apply round-trips without throwing', () => {
    makeGamepad();
    applyMappingLive(FULL_MAPPING);
    // exportMapping reads the LIVE proxy (integrated Y types) — it must clone, not
    // alias, so the result is a safe plain object to re-apply.
    const exported = exportMapping(readData());
    const target: GamepadData = {};
    expect(() => applyMapping(target, exported)).not.toThrow();
    expect(target.bindings).toEqual(FULL_MAPPING.bindings);
    expect(target.invert).toEqual(FULL_MAPPING.invert);
  });

  it('applying the empty mapping clears the live doc without throwing', () => {
    makeGamepad();
    applyMappingLive(FULL_MAPPING);
    expect(() => applyMappingLive({})).not.toThrow();
    expect(readData().bindings).toBeUndefined();
    expect(readData().invert).toBeUndefined();
    expect(readData().leftStickCalibration).toBeUndefined();
    expect(readData().rightStickCalibration).toBeUndefined();
  });

  it('applying the "NXT Gladiator" preset on the live doc does not throw', () => {
    makeGamepad();
    const preset = GAMEPAD_PRESETS.find((p) => p.name === 'NXT Gladiator')!;
    // Apply over pre-existing live state to also exercise the over-existing path.
    commitRemap('a', { kind: 'button', index: 7 });
    expect(() => applyMappingLive(preset.mapping)).not.toThrow();
    // The placeholder = default bindings → every output resolves to its default.
    expect(bindingForOutput('a', readBindings())).toEqual({ kind: 'button', index: 0 });
  });
});
