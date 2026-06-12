// packages/web/src/lib/graph/control-color-passthrough.test.ts
//
// INTEGRATION / PASSTHROUGH test for the per-module control colour.
//
// THE PRINCIPLE THIS GUARDS: colour is SOURCE-MODULE state, read LIVE
// everywhere (the Control Surface stripe, the ElectraControl stripe, the
// generated Electra preset). It is PASSTHROUGH — never copied onto the
// ControlBinding / ControlSurfaceData / ElectraControlData / any Electra node.
//
// We assign a colour on the SOURCE module (setControlColor) and assert all THREE
// consumers reflect it: the surface stripe colour (resolveControlColor — the
// exact call the ControlSurfaceCard makes), the electra stripe colour (same
// call the ElectraControlCard makes), and the generated Electra preset's
// `c.color` (host.buildLiveGenInput → generatePreset). Then we CHANGE the colour
// and assert all three update with no stale copy. Finally we grep the persisted
// surface/electra data and assert NO colour key was ever stored — so a future
// contributor can't "optimize" the passthrough into a copy.
//
// Runs against the REAL syncedStore + Y.Doc + registered module defs (not mocks)
// so the bindings become real Y types — the conditions the cards actually run
// under ([[yjs-save-load-real-ydoc]]).

import { describe, it, expect, afterEach } from 'vitest';
import '$lib/audio/modules'; // side-effect: register the audio module defs (adsr, …)
import { patch } from '$lib/graph/store';
import type { ModuleNode } from './types';
import { setControlColor } from './mutate';
import { resolveControlColor } from './control-color';
import {
  CONTROL_SURFACE_TYPE,
  addBindingToSurface,
  readSurfaceData,
} from './control-surface';
import {
  ELECTRA_CONTROL_TYPE,
  assignSlotToElectra,
  slotIndex,
  bindingAtSlot,
  readElectraData,
} from './electra-control';
import { buildLiveGenInput } from '$lib/electra/host';
import { generatePreset, PAGE_CONTROL } from '$lib/electra/preset';

const SRC = 'adsr-cc-test';
const SURFACE = 'surface-cc-test';
const ELECTRA = 'electra-cc-test';

function makeSource(): void {
  patch.nodes[SRC] = {
    id: SRC,
    type: 'adsr',
    domain: 'audio',
    position: { x: 0, y: 0 },
    params: { attack: 0.005, decay: 0.1 },
    data: {},
  } as unknown as ModuleNode;
}
function makeSurface(): void {
  patch.nodes[SURFACE] = {
    id: SURFACE,
    type: CONTROL_SURFACE_TYPE,
    domain: 'meta',
    position: { x: 0, y: 0 },
    params: {},
    data: {},
  } as unknown as ModuleNode;
}
function makeElectra(): void {
  patch.nodes[ELECTRA] = {
    id: ELECTRA,
    type: ELECTRA_CONTROL_TYPE,
    domain: 'meta',
    position: { x: 0, y: 0 },
    params: {},
    data: {},
  } as unknown as ModuleNode;
}

/** The surface stripe colour the ControlSurfaceCard renders for the source. */
function surfaceStripeColor(): string {
  return resolveControlColor(patch.nodes[SRC] as ModuleNode | undefined);
}
/** The electra stripe colour the ElectraControlCard renders for a filled slot
 *  pointing at the source. */
function electraStripeColor(): string {
  return resolveControlColor(patch.nodes[SRC] as ModuleNode | undefined);
}
/** The generated Electra preset's CONTROL-page colour for the source's param,
 *  located via the allocation table (keyed `moduleId:paramId`) → the control at
 *  the same (controlSetId, potId). */
function presetControlColor(paramId: string): string | undefined {
  const { preset, allocations } = generatePreset(buildLiveGenInput());
  const alloc = allocations.find((a) => a.key === `${SRC}:${paramId}` && a.pageId === PAGE_CONTROL);
  if (!alloc) return undefined;
  const c = preset.controls.find(
    (x) =>
      x.pageId === PAGE_CONTROL &&
      x.controlSetId === alloc.controlSetId &&
      x.potId === alloc.potId,
  );
  return c?.color;
}

afterEach(() => {
  // Only delete what a given test created — the syncedStore proxy throws on
  // deleting an absent key.
  for (const id of [SRC, SURFACE, ELECTRA]) {
    if (patch.nodes[id]) delete patch.nodes[id];
  }
});

describe('control colour — passthrough end-to-end', () => {
  it('assigning a colour on the SOURCE flows to surface + electra + preset', () => {
    makeSource();
    makeSurface();
    addBindingToSurface(SURFACE, SRC, 'attack');
    addBindingToSurface(SURFACE, SRC, 'decay');

    // Assign a colour on the SOURCE module.
    setControlColor(SRC, 'F45C51'); // red

    // (a) Surface stripe — the live resolved source colour.
    expect(surfaceStripeColor()).toBe('F45C51');
    // (b) Electra stripe — same passthrough read.
    expect(electraStripeColor()).toBe('F45C51');
    // (c) Generated preset (CONTROL SURFACE path) — the control carries it.
    expect(presetControlColor('attack')).toBe('F45C51');
  });

  it('the ElectraControl path (positional grid) also reflects the source colour', () => {
    makeSource();
    makeElectra();
    assignSlotToElectra(ELECTRA, slotIndex(1, 1), SRC, 'attack');

    setControlColor(SRC, '529DEC'); // blue

    // With an Electra node present, host.page1Bindings prefers it; the generated
    // control carries the source colour.
    const { preset } = generatePreset(buildLiveGenInput());
    const ctrl = preset.controls.filter((c) => c.pageId === PAGE_CONTROL);
    expect(ctrl.length).toBe(1);
    expect(ctrl[0]!.color).toBe('529DEC');
    // And the card stripe reads the same live source colour.
    expect(electraStripeColor()).toBe('529DEC');
  });

  it('CHANGING the source colour updates all consumers (no stale copy)', () => {
    makeSource();
    makeSurface();
    addBindingToSurface(SURFACE, SRC, 'attack');

    setControlColor(SRC, 'F45C51');
    expect(surfaceStripeColor()).toBe('F45C51');
    expect(presetControlColor('attack')).toBe('F45C51');

    // Re-assign → every consumer re-resolves live; nothing is stale.
    setControlColor(SRC, '03A598'); // teal
    expect(surfaceStripeColor()).toBe('03A598');
    expect(presetControlColor('attack')).toBe('03A598');

    // Clearing → the auto default; still live everywhere.
    setControlColor(SRC, null);
    const auto = resolveControlColor(patch.nodes[SRC] as ModuleNode);
    expect(surfaceStripeColor()).toBe(auto);
    expect(presetControlColor('attack')).toBe(auto);
  });

  it('NO colour is ever persisted on the binding / surface / electra data (passthrough, not a copy)', () => {
    makeSource();
    makeSurface();
    makeElectra();
    addBindingToSurface(SURFACE, SRC, 'attack');
    addBindingToSurface(SURFACE, SRC, 'decay');
    assignSlotToElectra(ELECTRA, slotIndex(1, 1), SRC, 'attack');

    // Assign + change the colour several times — the surface/electra MUST NOT
    // accumulate a copy of it.
    setControlColor(SRC, 'F45C51');
    setControlColor(SRC, '529DEC');
    setControlColor(SRC, null);
    setControlColor(SRC, '7ED957');

    // (1) The SOURCE node holds the colour — that's the single home.
    expect((patch.nodes[SRC]!.data as { controlColor?: string }).controlColor).toBe('7ED957');

    // (2) The control-surface data — no `color` key anywhere on it or its
    // bindings. Grep the whole persisted blob for a colour-ish key.
    const surfaceData = readSurfaceData(patch.nodes[SURFACE]);
    expect('color' in (surfaceData as Record<string, unknown>)).toBe(false);
    expect('controlColor' in (surfaceData as Record<string, unknown>)).toBe(false);
    for (const b of surfaceData.bindings ?? []) {
      expect('color' in (b as unknown as Record<string, unknown>)).toBe(false);
      expect('controlColor' in (b as unknown as Record<string, unknown>)).toBe(false);
    }
    // Belt-and-suspenders: the serialized surface data mentions no hex colour.
    const surfaceJson = JSON.stringify(surfaceData);
    expect(surfaceJson).not.toContain('7ED957');
    expect(surfaceJson.toLowerCase()).not.toContain('color');

    // (3) The electra data — same: no colour key on it or its slot bindings.
    const electraData = readElectraData(patch.nodes[ELECTRA]);
    const slotBinding = bindingAtSlot(electraData, slotIndex(1, 1));
    expect(slotBinding).toBeDefined();
    expect('color' in (slotBinding as unknown as Record<string, unknown>)).toBe(false);
    expect('controlColor' in (slotBinding as unknown as Record<string, unknown>)).toBe(false);
    const electraJson = JSON.stringify(electraData);
    expect(electraJson).not.toContain('7ED957');
    expect(electraJson.toLowerCase()).not.toContain('color');
  });
});
