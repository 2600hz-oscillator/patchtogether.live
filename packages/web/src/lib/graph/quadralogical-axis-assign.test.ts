// packages/web/src/lib/graph/quadralogical-axis-assign.test.ts
//
// REAL-Y.Doc proof of the registration the QUADRALOGICAL pad's bespoke 2-axis
// menu uses to expose pos_x / pos_y as assignable controls. The pad is a custom
// <div> (not a Knob/Fader embedding ControlContextMenu), so it calls the SAME
// surface/Electra mutators the standard ControlContextMenu does, then stamps the
// "QUAD X" / "QUAD Y" preset name. This asserts that two-call sequence (the exact
// card path) produces the expected named pointers, against the live syncedStore
// (so bindings become real Y.Maps — the only way to catch the "Type already
// integrated" trap on the 2nd axis send). Driving the surface/Electra control →
// node.params.pos_x/pos_y is proven end-to-end in e2e/tests/quadralogical-assign.

import { describe, it, expect, afterEach } from 'vitest';
import { patch } from '$lib/graph/store';
import {
  CONTROL_SURFACE_TYPE,
  addBindingToSurface,
  removeBindingFromSurface,
  setBindingName,
  readSurfaceData,
} from './control-surface';
import {
  ELECTRA_CONTROL_TYPE,
  assignSlotToElectra,
  clearSlot,
  setSlotName,
  slotForBinding,
  slotIndex,
  readElectraData,
} from './electra-control';
import type { ModuleNode } from './types';

const QUAD = 'quad-axis-test';
const SID = 'cs-axis-test';
const EID = 'ec-axis-test';

// The friendly axis names the card stamps (mirrors AXIS_NAME in QuadralogicalCard).
const QUAD_X = 'QUAD X';
const QUAD_Y = 'QUAD Y';

function makeNode(id: string, type: string): void {
  patch.nodes[id] = {
    id,
    type,
    domain: 'meta',
    position: { x: 0, y: 0 },
    params: {},
    data: {},
  } as unknown as ModuleNode;
}

afterEach(() => {
  delete patch.nodes[SID];
  delete patch.nodes[EID];
  delete patch.nodes[QUAD];
});

// What the card does on "Send <axis> to <surface>".
function sendAxisToSurface(surfaceId: string, axis: 'pos_x' | 'pos_y'): void {
  addBindingToSurface(surfaceId, QUAD, axis);
  setBindingName(surfaceId, QUAD, axis, axis === 'pos_x' ? QUAD_X : QUAD_Y);
}
// What the card does on "Send <axis> to <electra> ▸ Row ▸ knob".
function sendAxisToElectra(electraId: string, axis: 'pos_x' | 'pos_y', slot: number): void {
  assignSlotToElectra(electraId, slot, QUAD, axis);
  setSlotName(electraId, slot, axis === 'pos_x' ? QUAD_X : QUAD_Y);
}

describe('QUADRALOGICAL axis → Control Surface registration', () => {
  it('sends BOTH axes as named pointers without throwing (the 2nd-axis Y.Map trap)', () => {
    makeNode(QUAD, 'quadralogical');
    makeNode(SID, CONTROL_SURFACE_TYPE);

    expect(() => {
      sendAxisToSurface(SID, 'pos_x');
      sendAxisToSurface(SID, 'pos_y'); // 2nd send: used to throw if the array were spread
    }).not.toThrow();

    expect(readSurfaceData(patch.nodes[SID]).bindings).toEqual([
      { moduleId: QUAD, paramId: 'pos_x', name: QUAD_X },
      { moduleId: QUAD, paramId: 'pos_y', name: QUAD_Y },
    ]);
  });

  it('removes one axis in place, leaving the other intact', () => {
    makeNode(QUAD, 'quadralogical');
    makeNode(SID, CONTROL_SURFACE_TYPE);
    sendAxisToSurface(SID, 'pos_x');
    sendAxisToSurface(SID, 'pos_y');

    expect(() => removeBindingFromSurface(SID, QUAD, 'pos_x')).not.toThrow();
    expect(readSurfaceData(patch.nodes[SID]).bindings).toEqual([
      { moduleId: QUAD, paramId: 'pos_y', name: QUAD_Y },
    ]);
  });

  it('the two axes are DISTINCT bindings (pos_x and pos_y do not clobber each other)', () => {
    makeNode(QUAD, 'quadralogical');
    makeNode(SID, CONTROL_SURFACE_TYPE);
    sendAxisToSurface(SID, 'pos_x');
    sendAxisToSurface(SID, 'pos_y');
    const b = readSurfaceData(patch.nodes[SID]).bindings ?? [];
    expect(b.map((x) => x.paramId).sort()).toEqual(['pos_x', 'pos_y']);
  });
});

describe('QUADRALOGICAL axis → Electra Control registration', () => {
  it('assigns each axis to its fixed (row, knob) slot as a named pointer', () => {
    makeNode(QUAD, 'quadralogical');
    makeNode(EID, ELECTRA_CONTROL_TYPE);

    const xSlot = slotIndex(1, 1); // Row1 knob1 = 0
    const ySlot = slotIndex(2, 2); // Row2 knob2 = 7
    expect(() => {
      sendAxisToElectra(EID, 'pos_x', xSlot);
      sendAxisToElectra(EID, 'pos_y', ySlot);
    }).not.toThrow();

    const data = readElectraData(patch.nodes[EID]);
    expect(data.slots).toEqual({
      [String(xSlot)]: { moduleId: QUAD, paramId: 'pos_x', name: QUAD_X },
      [String(ySlot)]: { moduleId: QUAD, paramId: 'pos_y', name: QUAD_Y },
    });
    expect(slotForBinding(data, QUAD, 'pos_x')).toBe(xSlot);
    expect(slotForBinding(data, QUAD, 'pos_y')).toBe(ySlot);
  });

  it('clears one axis slot, leaving the other intact', () => {
    makeNode(QUAD, 'quadralogical');
    makeNode(EID, ELECTRA_CONTROL_TYPE);
    const xSlot = slotIndex(1, 1);
    const ySlot = slotIndex(2, 2);
    sendAxisToElectra(EID, 'pos_x', xSlot);
    sendAxisToElectra(EID, 'pos_y', ySlot);

    expect(() => clearSlot(EID, xSlot)).not.toThrow();
    expect(Object.keys(readElectraData(patch.nodes[EID]).slots ?? {})).toEqual([String(ySlot)]);
  });
});
