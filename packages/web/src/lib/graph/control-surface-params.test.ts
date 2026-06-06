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
} from './control-surface-params';
import { CONTROL_SURFACE_TYPE } from './control-surface';
import { setLayerMaterialField } from './toybox-layers';
import { setCombineNodeParam } from './toybox-combine';
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

describe('resolveSurfaceParam — guards', () => {
  it('returns null for a missing node + never proxies a surface onto itself', () => {
    makeSurface();
    expect(resolveSurfaceParam(undefined, 'scale')).toBeNull();
    expect(resolveSurfaceParam(patch.nodes[SID] as ModuleNode, 'anything')).toBeNull();
  });
});
