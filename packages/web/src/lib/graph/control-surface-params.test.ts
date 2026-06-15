// packages/web/src/lib/graph/control-surface-params.test.ts
//
// REAL-Y.Doc coverage for the control-surface param ADAPTER (the bridge the
// surface card uses). Runs against the live syncedStore + Y.Doc (graph/store.ts)
// so a toybox node's layers/material/combine are real Y types — the conditions
// the surface actually runs under. Proves:
//   - a NORMAL module routes through the flat node.params def+read+write,
//   - a TOYBOX source routes through resolveToyboxParam: a material 'scale' AND a
//     'combine:<id>:<p>' resolve to a def + get/set that read/write the SAME live
//     node.data location the toybox card mutators write (setLayerMaterialField /
//     setCombineNodeParam), so a surface edit === a card edit,
//   - resolveSurfaceParam returns null for an unresolvable / surface-self source.

import { describe, it, expect, afterEach } from 'vitest';
import '$lib/audio/modules'; // side-effect: register the audio module defs (adsr, …)
import { patch } from '$lib/graph/store';
import type { ModuleNode } from './types';
import {
  resolveSurfaceParam,
  paramDefForBinding,
  hasNestedParams,
  bindingDefinitelyDangling,
  pruneSurfaceDangling,
} from './control-surface-params';
import {
  CONTROL_SURFACE_TYPE,
  addBindingToSurface,
  addScreenToSurface,
  readSurfaceData,
} from './control-surface';
import { setLayerMaterialField } from './toybox-layers';
import { setCombineNodeParam, deleteCombineNode } from './toybox-combine';
import { makeDefaultObjMaterial, type ToyboxLayer } from '$lib/video/toybox-content';
import { makeDefaultCombineGraph } from '$lib/video/toybox-combine-graph';

const TID = 'toybox-cs-test';
const SID = 'surface-cs-test';
const ADSR = 'adsr-cs-test';

function objLayer(material: Record<string, number> = {}): ToyboxLayer {
  return { kind: 'obj', contentId: null, params: {}, material: { ...makeDefaultObjMaterial(), ...material } as never };
}

function makeToybox(): void {
  patch.nodes[TID] = {
    id: TID,
    type: 'toybox',
    domain: 'video',
    position: { x: 0, y: 0 },
    params: {},
    data: { layers: [objLayer({ scale: 1 })], combine: makeDefaultCombineGraph() },
  } as unknown as ModuleNode;
}
function makeAdsr(): void {
  patch.nodes[ADSR] = {
    id: ADSR,
    type: 'adsr',
    domain: 'audio',
    position: { x: 0, y: 0 },
    params: { attack: 0.005 },
    data: {},
  } as unknown as ModuleNode;
}
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
  for (const id of [TID, ADSR, SID]) {
    if (patch.nodes[id]) delete patch.nodes[id];
  }
});

describe('hasNestedParams', () => {
  it('flags toybox, not normal modules', () => {
    expect(hasNestedParams('toybox')).toBe(true);
    expect(hasNestedParams('vco')).toBe(false);
    expect(hasNestedParams(undefined)).toBe(false);
  });
});

describe('resolveSurfaceParam — NORMAL (flat node.params) source', () => {
  it('resolves an adsr param def + reads/writes node.params', () => {
    makeAdsr();
    const r = resolveSurfaceParam(patch.nodes[ADSR] as ModuleNode, 'attack');
    expect(r).not.toBeNull();
    expect(r!.def).toMatchObject({ id: 'attack', label: 'A' });
    expect(r!.get()).toBe(0.005);
    r!.set(1.2);
    expect((patch.nodes[ADSR] as ModuleNode).params.attack).toBe(1.2);
    expect(r!.get()).toBe(1.2);
    // paramDefForBinding agrees with resolveSurfaceParam
    expect(paramDefForBinding(patch.nodes[ADSR] as ModuleNode, 'attack')).toBe(r!.def);
  });
});

describe('resolveSurfaceParam — TOYBOX (nested node.data) source', () => {
  it('resolves a MATERIAL param + a surface write lands where the CARD writes', () => {
    makeToybox();
    const tb = () => patch.nodes[TID] as ModuleNode;
    const r = resolveSurfaceParam(tb(), 'scale');
    expect(r).not.toBeNull();
    expect(r!.def).toMatchObject({ id: 'scale', label: 'SCALE', min: 0.25, max: 3 });
    expect(r!.get()).toBe(1);

    // A SURFACE edit (adapter set) writes the live material.
    r!.set(2.5);
    const matAfterSurface = (tb().data!.layers as ToyboxLayer[])[0]!.material as unknown as Record<string, number>;
    expect(matAfterSurface.scale).toBe(2.5);
    expect(resolveSurfaceParam(tb(), 'scale')!.get()).toBe(2.5);

    // A CARD edit (the toybox card mutator) lands on the SAME location → the
    // surface re-read sees it. (surface edit === card edit === one live param.)
    setLayerMaterialField(TID, 0, 'scale', 0.75);
    expect(resolveSurfaceParam(tb(), 'scale')!.get()).toBe(0.75);
  });

  it('resolves a COMBINE param + surface/card writes agree', () => {
    makeToybox();
    const tb = () => patch.nodes[TID] as ModuleNode;
    const r = resolveSurfaceParam(tb(), 'combine:op1:amount');
    expect(r).not.toBeNull();
    expect(r!.def).toMatchObject({ id: 'combine:op1:amount', min: 0, max: 1 });

    r!.set(0.3); // surface edit
    expect(resolveSurfaceParam(tb(), 'combine:op1:amount')!.get()).toBeCloseTo(0.3);

    setCombineNodeParam(TID, 'op1', 'amount', 0.9); // card edit, same location
    expect(resolveSurfaceParam(tb(), 'combine:op1:amount')!.get()).toBeCloseTo(0.9);
  });

  it('returns null for an unresolvable toybox param', () => {
    makeToybox();
    expect(resolveSurfaceParam(patch.nodes[TID] as ModuleNode, 'bogus-uniform')).toBeNull();
    expect(resolveSurfaceParam(patch.nodes[TID] as ModuleNode, 'combine:nope:amount')).toBeNull();
  });
});

// ───────────────────── TOYBOX model SCALE on a NON-FIRST layer ─────────────────────
//
// REGRESSION (user report: "toybox scale on a model when assigned to a control
// surface doesn't work"). The TOYBOX card learns material/content-uniform knobs
// for whatever layer is ACTIVE, emitting the layer-QUALIFIED paramId
// 'layer:<activeLayer>:scale' (NOT a bare 'scale'). A bare 'scale' resolves to
// the FIRST OBJ layer, so a model the user has on layer 2 was driven on the
// WRONG layer (or not at all if layer 0 isn't an OBJ layer) → "doesn't work".
// The qualified binding must drive the SAME live material the card edits, on the
// exact learned layer, and must NOT disturb a different layer's same-named field.
function makeMultiLayerToybox(): void {
  // layer 0 = OFF (the user's model is on layer 2, not the first layer)
  // layer 1 = a DIFFERENT OBJ (its own scale — must stay untouched)
  // layer 2 = the user's model (the one the card has active + learned)
  patch.nodes[TID] = {
    id: TID,
    type: 'toybox',
    domain: 'video',
    position: { x: 0, y: 0 },
    params: {},
    data: {
      layers: [
        { kind: 'off', contentId: null, params: {} },
        objLayer({ scale: 1.1 }),
        objLayer({ scale: 1 }),
        { kind: 'off', contentId: null, params: {} },
      ],
      combine: makeDefaultCombineGraph(),
    },
  } as unknown as ModuleNode;
}

describe('resolveSurfaceParam — TOYBOX model on a NON-FIRST layer (scale-on-surface bug)', () => {
  it("drives the LEARNED layer's material, not the first OBJ layer", () => {
    makeMultiLayerToybox();
    const tb = () => patch.nodes[TID] as ModuleNode;
    const layers = () => tb().data!.layers as ToyboxLayer[];

    // The card on activeLayer=2 binds 'layer:2:scale'.
    const r = resolveSurfaceParam(tb(), 'layer:2:scale');
    expect(r, 'layer-qualified material id must resolve').not.toBeNull();
    expect(r!.def).toMatchObject({ id: 'layer:2:scale', label: 'SCALE', min: 0.25, max: 3 });
    expect(r!.get()).toBe(1);

    // A SURFACE write lands on LAYER 2's material…
    r!.set(2.5);
    const mat = (i: number) => layers()[i]!.material as unknown as Record<string, number>;
    expect(mat(2).scale, 'the learned layer (2) is driven').toBe(2.5);
    // …and does NOT touch layer 1 (the OBJ that bare-resolution would have hit).
    expect(mat(1).scale, 'a different OBJ layer is untouched').toBe(1.1);

    // A CARD edit on the same layer lands on the SAME location (surface===card).
    setLayerMaterialField(TID, 2, 'scale', 0.75);
    expect(resolveSurfaceParam(tb(), 'layer:2:scale')!.get()).toBe(0.75);
    expect(mat(1).scale).toBe(1.1); // still untouched
  });

  it('keeps backward-compat: a bare saved binding still resolves to the first OBJ layer', () => {
    makeMultiLayerToybox();
    const tb = () => patch.nodes[TID] as ModuleNode;
    // A patch saved BEFORE this fix stored a bare 'scale' — it must still resolve
    // (to the first OBJ layer, here layer 1) so old patches don't break.
    const r = resolveSurfaceParam(tb(), 'scale');
    expect(r).not.toBeNull();
    expect(r!.get()).toBe(1.1); // first OBJ layer = layer 1
  });
});

describe('resolveSurfaceParam — guards', () => {
  it('returns null for a missing node + never proxies a surface onto itself', () => {
    makeSurface();
    expect(resolveSurfaceParam(undefined, 'scale')).toBeNull();
    expect(resolveSurfaceParam(patch.nodes[SID] as ModuleNode, 'anything')).toBeNull();
  });
});

// ───────────────────── #86: auto-prune dangling proxied controls ─────────────────────

function toyboxNoCombine(): void {
  patch.nodes[TID] = {
    id: TID, type: 'toybox', domain: 'video', position: { x: 0, y: 0 },
    params: {}, data: {}, // combine NOT loaded yet
  } as unknown as ModuleNode;
}

describe('bindingDefinitelyDangling — conservative source-gone test', () => {
  it('absent source MODULE → dangling (case 1: mapped module deleted)', () => {
    expect(bindingDefinitelyDangling(undefined, 'attack')).toBe(true);
  });
  it('present flat module → NOT dangling', () => {
    makeAdsr();
    expect(bindingDefinitelyDangling(patch.nodes[ADSR] as ModuleNode, 'attack')).toBe(false);
  });
  it('toybox combine: node PRESENT → not dangling; node ABSENT (graph loaded) → dangling (case 2)', () => {
    makeToybox();
    const tb = patch.nodes[TID] as ModuleNode;
    expect(bindingDefinitelyDangling(tb, 'combine:op1:amount')).toBe(false);
    expect(bindingDefinitelyDangling(tb, 'combine:ghost:amount')).toBe(true);
  });
  it('toybox combine NOT loaded → NOT dangling (never false-prune a not-yet-synced source)', () => {
    toyboxNoCombine();
    expect(bindingDefinitelyDangling(patch.nodes[TID] as ModuleNode, 'combine:op1:amount')).toBe(false);
  });
});

describe('pruneSurfaceDangling — real Y.Doc', () => {
  it('drops every binding when its source MODULE is deleted', () => {
    makeSurface();
    makeAdsr();
    addBindingToSurface(SID, ADSR, 'attack');
    addBindingToSurface(SID, ADSR, 'decay');
    expect(pruneSurfaceDangling(SID), 'nothing dangles while the source exists').toBe(0);
    delete patch.nodes[ADSR];
    expect(pruneSurfaceDangling(SID)).toBe(2);
    expect(readSurfaceData(patch.nodes[SID]).bindings ?? []).toHaveLength(0);
    // idempotent — a second prune is a no-op
    expect(pruneSurfaceDangling(SID)).toBe(0);
  });

  it('drops a TOYBOX combine binding when its op node is deleted, keeps the valid ones', () => {
    makeSurface();
    makeToybox();
    makeAdsr();
    addBindingToSurface(SID, ADSR, 'attack'); // stays (source alive)
    addBindingToSurface(SID, TID, 'combine:op1:amount'); // dropped after the node delete
    expect(pruneSurfaceDangling(SID)).toBe(0);
    // Reconfigure the toybox: delete the op node the surface points at.
    deleteCombineNode(TID, 'op1');
    expect(pruneSurfaceDangling(SID)).toBe(1);
    const ids = (readSurfaceData(patch.nodes[SID]).bindings ?? []).map((b) => b.paramId);
    expect(ids).toEqual(['attack']);
  });

  it('does NOT prune a toybox binding while the combine graph has not loaded', () => {
    makeSurface();
    toyboxNoCombine();
    addBindingToSurface(SID, TID, 'combine:op1:amount');
    expect(pruneSurfaceDangling(SID)).toBe(0);
    expect(readSurfaceData(patch.nodes[SID]).bindings ?? []).toHaveLength(1);
  });

  it('drops a dangling SCREEN when its module is deleted', () => {
    makeSurface();
    makeAdsr();
    addScreenToSurface(SID, ADSR);
    expect(pruneSurfaceDangling(SID)).toBe(0);
    delete patch.nodes[ADSR];
    expect(pruneSurfaceDangling(SID)).toBe(1);
    expect(readSurfaceData(patch.nodes[SID]).screens ?? []).toHaveLength(0);
  });
});
