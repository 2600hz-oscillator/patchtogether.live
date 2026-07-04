// packages/web/src/lib/graph/electra-control.test.ts
//
// ELECTRA CONTROL coverage. Two halves:
//
//   1. PURE GEOMETRY — the (row, knob) ↔ slotIndex ↔ (controlSetId, potId)
//      bijection (§2). Pins BOTH directions + the round-trip + the two canonical
//      anchors (Row2→2 = cs1/pot8/slot7; Row6→6 = cs3/pot12/slot35), so the
//      storage ordering can never be silently transposed against the firmware
//      grid walk. Also runs the geometry through the real generatePreset to prove
//      the slots land on the canonical (controlSetId, potId, bounds) grid.
//
//   2. REAL-Y.Doc MUTATORS — assign / overwrite / clear / rename against the SAME
//      syncedStore + Y.Doc the live patch uses (graph/store.ts), so slot bindings
//      become real Y.Maps once written — the only way to catch the "Type already
//      integrated" trap (a SECOND assign to a different slot must not throw). Do
//      NOT mock (memory [[yjs-save-load-real-ydoc]]).

import { describe, it, expect, afterEach } from 'vitest';
import { patch } from '$lib/graph/store';
import {
  ELECTRA_CONTROL_TYPE,
  ELECTRA_SLOT_COUNT,
  slotIndex,
  rowKnobOf,
  electraPosOf,
  electraPosOfSlot,
  bankForRow,
  readElectraData,
  listElectraControls,
  slotForBinding,
  hasSlotBinding,
  bindingAtSlot,
  assignSlotToElectra,
  clearSlot,
  setSlotName,
  pruneElectraDangling,
} from './electra-control';
import { electraControlDef } from '$lib/meta/modules/electra-control';
import { generatePreset, PAGE_CONTROL, type SurfaceBinding, type GenParamDef } from '$lib/electra/preset';
import type { ModuleNode } from './types';

// ──────────────────────────── pure geometry ────────────────────────────

describe('slotIndex / rowKnobOf — row-major 6×6', () => {
  it('maps (row, knob) → 0..35 row-major', () => {
    expect(slotIndex(1, 1)).toBe(0);
    expect(slotIndex(1, 6)).toBe(5);
    expect(slotIndex(2, 1)).toBe(6);
    expect(slotIndex(2, 2)).toBe(7);
    expect(slotIndex(6, 6)).toBe(35);
  });

  it('round-trips every (row, knob) in the 6×6 grid', () => {
    for (let row = 1; row <= 6; row++) {
      for (let knob = 1; knob <= 6; knob++) {
        const s = slotIndex(row, knob);
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s).toBeLessThan(ELECTRA_SLOT_COUNT);
        expect(rowKnobOf(s)).toEqual({ row, knob });
      }
    }
  });
});

describe('electraPosOf — the (row, knob) → (controlSetId, potId) bijection (§2)', () => {
  it('places knobs 1..6 of odd rows on pots 1..6 (a band TOP sub-row)', () => {
    expect(electraPosOf(1, 1)).toEqual({ controlSetId: 1, potId: 1 });
    expect(electraPosOf(1, 6)).toEqual({ controlSetId: 1, potId: 6 });
    expect(electraPosOf(3, 1)).toEqual({ controlSetId: 2, potId: 1 });
    expect(electraPosOf(5, 1)).toEqual({ controlSetId: 3, potId: 1 });
  });

  it('places knobs 1..6 of even rows on pots 7..12 (a band BOTTOM sub-row)', () => {
    expect(electraPosOf(2, 1)).toEqual({ controlSetId: 1, potId: 7 });
    // ANCHOR: Row2 → 2 = control set 1 (TOP), pot 8, slot index 7.
    expect(electraPosOf(2, 2)).toEqual({ controlSetId: 1, potId: 8 });
    expect(slotIndex(2, 2)).toBe(7);
    expect(electraPosOf(2, 6)).toEqual({ controlSetId: 1, potId: 12 });
    expect(electraPosOf(4, 6)).toEqual({ controlSetId: 2, potId: 12 });
  });

  it('ANCHOR Row6 → 6 = control set 3 (BOTTOM), pot 12, slot 35 (rightmost-bottom)', () => {
    expect(electraPosOf(6, 6)).toEqual({ controlSetId: 3, potId: 12 });
    expect(slotIndex(6, 6)).toBe(35);
    expect(electraPosOfSlot(35)).toEqual({ controlSetId: 3, potId: 12 });
  });

  it('electraPosOfSlot agrees with electraPosOf(rowKnobOf(slot)) for ALL 36 slots', () => {
    for (let s = 0; s < ELECTRA_SLOT_COUNT; s++) {
      const { row, knob } = rowKnobOf(s);
      expect(electraPosOfSlot(s)).toEqual(electraPosOf(row, knob));
    }
  });

  it('is a BIJECTION onto the 3×12 firmware grid (every (cs,pot) hit exactly once)', () => {
    const seen = new Set<string>();
    for (let s = 0; s < ELECTRA_SLOT_COUNT; s++) {
      const { controlSetId, potId } = electraPosOfSlot(s);
      expect(controlSetId).toBeGreaterThanOrEqual(1);
      expect(controlSetId).toBeLessThanOrEqual(3);
      expect(potId).toBeGreaterThanOrEqual(1);
      expect(potId).toBeLessThanOrEqual(12);
      const key = `${controlSetId}:${potId}`;
      expect(seen.has(key), `(${controlSetId},${potId}) duplicated`).toBe(false);
      seen.add(key);
    }
    expect(seen.size).toBe(36);
  });
});

describe('bank membership — rows {1,2}=TOP/cs1, {3,4}=MIDDLE/cs2, {5,6}=BOTTOM/cs3', () => {
  it('groups each row into the right 2-row band', () => {
    expect(bankForRow(1)).toEqual({ label: 'TOP', controlSetId: 1 });
    expect(bankForRow(2)).toEqual({ label: 'TOP', controlSetId: 1 });
    expect(bankForRow(3)).toEqual({ label: 'MID', controlSetId: 2 });
    expect(bankForRow(4)).toEqual({ label: 'MID', controlSetId: 2 });
    expect(bankForRow(5)).toEqual({ label: 'BOT', controlSetId: 3 });
    expect(bankForRow(6)).toEqual({ label: 'BOT', controlSetId: 3 });
  });
});

// ───── generator round-trip: the fixed slots land on the canonical grid ─────

describe('generatePreset over the fixed ElectraControl slots', () => {
  // Build a SurfaceBinding list at fixed slots (the host.ts ElectraControl path
  // does this), using the GENERATOR'S page-local slot index =
  // (controlSetId-1)*12 + (potId-1), derived via electraPosOfSlot — NOT the raw
  // storage slotIndex (those orderings differ at band boundaries).
  const def: GenParamDef = { id: 'p', label: 'Cut', min: 0, max: 1, defaultValue: 0.5, curve: 'linear' };
  function bindingAt(storageSlot: number, moduleId: string, paramId: string, name?: string): SurfaceBinding {
    const { controlSetId, potId } = electraPosOfSlot(storageSlot);
    const genSlot = (controlSetId - 1) * 12 + (potId - 1);
    return { moduleId, paramId, name, slot: genSlot };
  }

  it('Row2→2 lands at controlSet 1 / pot 8 / bounds [187,118,146,56]', () => {
    const storageSlot = slotIndex(2, 2); // 7
    const { preset } = generatePreset({
      surfaceBindings: [bindingAt(storageSlot, 'flt', 'cutoff')],
      moduleLabel: () => 'FILTER',
      resolveParamDef: () => def,
      mixmstrsId: null,
      timelordeId: null,
    });
    const page1 = preset.controls.filter((c) => c.pageId === PAGE_CONTROL);
    expect(page1).toHaveLength(1);
    expect(page1[0]).toMatchObject({ controlSetId: 1, potId: 8 });
    expect(page1[0]!.bounds).toEqual([187, 118, 146, 56]);
  });

  it('Row6→6 lands at controlSet 3 / pot 12 / bounds [855,478,146,56] (rightmost-bottom)', () => {
    const storageSlot = slotIndex(6, 6); // 35
    const { preset } = generatePreset({
      surfaceBindings: [bindingAt(storageSlot, 'vco', 'tune')],
      moduleLabel: () => 'VCO',
      resolveParamDef: () => def,
      mixmstrsId: null,
      timelordeId: null,
    });
    const page1 = preset.controls.filter((c) => c.pageId === PAGE_CONTROL);
    expect(page1[0]).toMatchObject({ controlSetId: 3, potId: 12 });
    expect(page1[0]!.bounds).toEqual([855, 478, 146, 56]);
  });

  it('emits NO per-module group headers + a custom name wins (clamped to 14)', () => {
    const { preset } = generatePreset({
      surfaceBindings: [
        bindingAt(slotIndex(1, 1), 'a', 'p', 'A VERY LONG CUSTOM NAME'),
        bindingAt(slotIndex(3, 4), 'b', 'q'),
      ],
      moduleLabel: (id) => id.toUpperCase(),
      resolveParamDef: () => def,
      mixmstrsId: null,
      timelordeId: null,
    });
    // Positional emit: no CONTROL-page group headers (a flat positional grid).
    expect(preset.groups.filter((g) => g.pageId === PAGE_CONTROL)).toHaveLength(0);
    const page1 = preset.controls.filter((c) => c.pageId === PAGE_CONTROL);
    const names = page1.map((c) => c.name);
    expect(names).toContain('A VERY LONG CU'); // custom wins, clamped to 14
  });

  it('skips empty slots — only the assigned ones emit controls', () => {
    const { preset } = generatePreset({
      surfaceBindings: [bindingAt(slotIndex(1, 1), 'a', 'p'), bindingAt(slotIndex(6, 6), 'b', 'q')],
      moduleLabel: (id) => id,
      resolveParamDef: () => def,
      mixmstrsId: null,
      timelordeId: null,
    });
    expect(preset.controls.filter((c) => c.pageId === PAGE_CONTROL)).toHaveLength(2);
  });
});

// ───── meta def shape ─────

describe('electraControlDef: meta def shape', () => {
  it('is a meta module with no ports/params + the right card + palette', () => {
    expect(electraControlDef.type).toBe(ELECTRA_CONTROL_TYPE);
    expect(electraControlDef.domain).toBe('meta');
    expect(electraControlDef.card).toBe('ElectraControlCard');
    expect(electraControlDef.inputs).toEqual([]);
    expect(electraControlDef.outputs).toEqual([]);
    expect(electraControlDef.params).toEqual([]);
    expect(electraControlDef.palette).toEqual({ top: 'Hybrid', sub: 'Hybrid' });
  });

  it('is a SINGLETON (maxInstances 1) but stays DELETABLE (no undeletable)', () => {
    // Max ONE ElectraControl per rack — the card owns the whole-rack "Send to
    // Electra" flash, so a second surface is redundant. Unlike TIMELORDE it is
    // NOT undeletable, so a merge-duplicate is auto-covered by the deterministic
    // singleton cleanup (see singleton-cleanup-registry.test.ts).
    expect(electraControlDef.maxInstances).toBe(1);
    expect(
      (electraControlDef as { undeletable?: boolean }).undeletable,
    ).toBeUndefined();
  });
});

// ───── real-Y.Doc slot mutators ─────

const EID = 'electra-ydoc-test';

function makeElectra(): void {
  patch.nodes[EID] = {
    id: EID,
    type: ELECTRA_CONTROL_TYPE,
    domain: 'meta',
    position: { x: 0, y: 0 },
    params: {},
    data: {},
  } as unknown as ModuleNode;
}

afterEach(() => {
  // Guard the delete: the geometry-only tests never create EID, and the
  // syncedStore proxy's deleteProperty trap throws on an absent key.
  if (patch.nodes[EID]) delete patch.nodes[EID];
});

describe('ElectraControl — real Y.Doc slot mutators', () => {
  it('lists electraControl nodes id-sorted, ignoring others', () => {
    makeElectra();
    patch.nodes['z-other'] = { id: 'z-other', type: 'analogVco', domain: 'audio', position: { x: 0, y: 0 }, params: {} } as unknown as ModuleNode;
    expect(listElectraControls(patch.nodes).map((e) => e.id)).toContain(EID);
    expect(listElectraControls(patch.nodes).some((e) => e.id === 'z-other')).toBe(false);
    delete patch.nodes['z-other'];
  });

  it('assigns a binding to EXACTLY the requested slot', () => {
    makeElectra();
    assignSlotToElectra(EID, slotIndex(2, 2), 'vco-1', 'morph'); // slot 7
    const data = readElectraData(patch.nodes[EID]);
    expect(bindingAtSlot(data, 7)).toEqual({ moduleId: 'vco-1', paramId: 'morph' });
    expect(hasSlotBinding(data, 7)).toBe(true);
    expect(hasSlotBinding(data, 8)).toBe(false);
    expect(slotForBinding(data, 'vco-1', 'morph')).toBe(7);
  });

  it('a SECOND assign to a DIFFERENT slot does NOT throw "Type already integrated"', () => {
    makeElectra();
    expect(() => {
      assignSlotToElectra(EID, 0, 'adsr-1', 'attack');
      assignSlotToElectra(EID, 7, 'adsr-1', 'decay'); // ← used to break (spread re-integrate)
      assignSlotToElectra(EID, 35, 'vco-1', 'tune');
    }).not.toThrow();
    const data = readElectraData(patch.nodes[EID]);
    expect(Object.keys(data.slots ?? {}).sort()).toEqual(['0', '35', '7']);
  });

  it('re-assigning an OCCUPIED slot OVERWRITES its binding', () => {
    makeElectra();
    assignSlotToElectra(EID, 10, 'a', 'p');
    expect(() => assignSlotToElectra(EID, 10, 'b', 'q')).not.toThrow();
    expect(bindingAtSlot(readElectraData(patch.nodes[EID]), 10)).toEqual({ moduleId: 'b', paramId: 'q' });
  });

  it('re-assigning the SAME pointer to a NEW slot MOVES it (no duplicate)', () => {
    makeElectra();
    assignSlotToElectra(EID, 3, 'vco-1', 'tune');
    assignSlotToElectra(EID, 20, 'vco-1', 'tune'); // move
    const data = readElectraData(patch.nodes[EID]);
    expect(hasSlotBinding(data, 3)).toBe(false);
    expect(bindingAtSlot(data, 20)).toEqual({ moduleId: 'vco-1', paramId: 'tune' });
    expect(slotForBinding(data, 'vco-1', 'tune')).toBe(20);
  });

  it('clearSlot removes a binding in place, leaving the rest intact', () => {
    makeElectra();
    assignSlotToElectra(EID, 0, 'a', 'p');
    assignSlotToElectra(EID, 1, 'b', 'q');
    expect(() => clearSlot(EID, 0)).not.toThrow();
    const data = readElectraData(patch.nodes[EID]);
    expect(hasSlotBinding(data, 0)).toBe(false);
    expect(bindingAtSlot(data, 1)).toEqual({ moduleId: 'b', paramId: 'q' });
    // ...and we can keep assigning afterward (map still healthy).
    expect(() => assignSlotToElectra(EID, 2, 'c', 'r')).not.toThrow();
    expect(Object.keys(readElectraData(patch.nodes[EID]).slots ?? {}).length).toBe(2);
  });

  it('sets / updates / trims / clears a slot custom name IN PLACE without throwing', () => {
    makeElectra();
    assignSlotToElectra(EID, 0, 'macro-1', 'timbre');
    assignSlotToElectra(EID, 7, 'macro-1', 'harmonics');
    // Name the SECOND slot (whose Y.Map is already integrated) — in place.
    expect(() => setSlotName(EID, 7, 'Color')).not.toThrow();
    expect(bindingAtSlot(readElectraData(patch.nodes[EID]), 7)?.name).toBe('Color');
    expect(bindingAtSlot(readElectraData(patch.nodes[EID]), 0)?.name).toBeUndefined();
    // Re-name updates in place; whitespace trims.
    setSlotName(EID, 7, '  Tone  ');
    expect(bindingAtSlot(readElectraData(patch.nodes[EID]), 7)?.name).toBe('Tone');
    // Blank value CLEARS the custom name.
    expect(() => setSlotName(EID, 7, '   ')).not.toThrow();
    expect(bindingAtSlot(readElectraData(patch.nodes[EID]), 7)?.name).toBeUndefined();
    // Naming an EMPTY slot is a no-op (does not throw / create).
    expect(() => setSlotName(EID, 30, 'X')).not.toThrow();
    expect(hasSlotBinding(readElectraData(patch.nodes[EID]), 30)).toBe(false);
    // ...and assigning more afterward still works (map stays healthy).
    expect(() => assignSlotToElectra(EID, 35, 'macro-1', 'morph')).not.toThrow();
  });

  it('pruneElectraDangling drops slots whose source module is gone (conservative)', () => {
    makeElectra();
    patch.nodes['alive'] = { id: 'alive', type: 'analogVco', domain: 'audio', position: { x: 0, y: 0 }, params: {} } as unknown as ModuleNode;
    assignSlotToElectra(EID, 0, 'alive', 'tune');
    assignSlotToElectra(EID, 1, 'dead', 'q');
    const removed = pruneElectraDangling(EID);
    expect(removed).toBe(1);
    const data = readElectraData(patch.nodes[EID]);
    expect(hasSlotBinding(data, 0)).toBe(true);
    expect(hasSlotBinding(data, 1)).toBe(false);
    // No-op (returns 0) when nothing dangles.
    expect(pruneElectraDangling(EID)).toBe(0);
    delete patch.nodes['alive'];
  });

  it('full lifecycle: assign many → rename → move → clear, never throws', () => {
    makeElectra();
    expect(() => {
      for (let i = 0; i < 6; i++) assignSlotToElectra(EID, i, `m${i}`, 'p');
      setSlotName(EID, 0, 'First');
      setSlotName(EID, 5, 'Last');
      assignSlotToElectra(EID, 30, 'm0', 'p'); // move slot 0's pointer to 30
      clearSlot(EID, 2);
    }).not.toThrow();
    const data = readElectraData(patch.nodes[EID]);
    // m0:p moved from 0 → 30; slot 2 cleared.
    expect(hasSlotBinding(data, 0)).toBe(false);
    expect(hasSlotBinding(data, 2)).toBe(false);
    expect(bindingAtSlot(data, 30)).toMatchObject({ moduleId: 'm0', paramId: 'p' });
  });
});
