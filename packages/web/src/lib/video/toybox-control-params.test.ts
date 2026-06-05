// packages/web/src/lib/video/toybox-control-params.test.ts
//
// TOYBOX → control-surface param ADAPTER coverage. Proves resolveToyboxParam:
//   - resolves a MATERIAL param (e.g. 'scale') against the first OBJ layer, with
//     the def from MATERIAL_PARAMS' range, and round-trips get/set in place,
//   - resolves a projective/SURF-MIX material param (NOT in the CV target set),
//   - resolves a COMBINE param ('combine:<nodeId>:<param>') against the live
//     combine graph + round-trips,
//   - resolves a layer-content UNIFORM (shader/gen) by finding the owning layer,
//   - resolves an IMAGE/VIDEO layer param,
//   - returns null for unknown / unresolvable params (so the surface drops them).
//
// Content-uniform resolution needs the manifest catalog (getContentMeta); we mock
// fetch with the same fixture style the cv-routes test uses + ensureToyboxCatalog.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import {
  resolveToyboxParam,
  isToyboxCombineParamId,
  parseCombineParamId,
} from './toybox-control-params';
import {
  ensureToyboxCatalog,
  makeDefaultObjMaterial,
  type ToyboxLayer,
} from './toybox-content';
import { makeDefaultCombineGraph, type ToyboxCombineGraph } from './toybox-combine-graph';

const MANIFEST = {
  version: 1,
  shaders: [
    {
      id: 'hsv-plasma',
      label: 'HSV PLASMA',
      family: 'FX',
      glsl: '/toybox/shaders/hsv-plasma.frag.glsl',
      params: [{ id: 'speed', label: 'SPEED', min: 0, max: 3, default: 1, curve: 'linear' }],
    },
  ],
  gen: [
    {
      id: 'noise-fbm',
      label: 'NOISE FBM',
      family: 'GEN',
      glsl: '/toybox/shaders/noise-fbm.frag.glsl',
      params: [
        { id: 'scale', label: 'SCALE', min: 0.5, max: 6, default: 2, curve: 'linear' },
        { id: 'speed', label: 'SPEED', min: 0, max: 2, default: 0.4, curve: 'linear' },
      ],
    },
  ],
  models: [],
};

beforeAll(async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => MANIFEST,
    })) as unknown as typeof fetch,
  );
  await ensureToyboxCatalog();
});

// ── helpers to build a live toybox node ──
function objLayer(material: Record<string, number> = {}): ToyboxLayer {
  return { kind: 'obj', contentId: null, params: {}, material: { ...makeDefaultObjMaterial(), ...material } as never };
}
function shaderLayer(contentId: string, params: Record<string, number> = {}): ToyboxLayer {
  return { kind: 'gen', contentId, params };
}
function offLayer(): ToyboxLayer {
  return { kind: 'off', contentId: null, params: {} };
}
function imageLayer(params: Record<string, number> = {}): ToyboxLayer {
  return { kind: 'image', contentId: null, params };
}
function node(layers: ToyboxLayer[], combine?: ToyboxCombineGraph): { data: Record<string, unknown> } {
  return { data: { layers, ...(combine ? { combine } : {}) } };
}

describe('paramId helpers', () => {
  it('isToyboxCombineParamId detects combine ids', () => {
    expect(isToyboxCombineParamId('combine:op1:amount')).toBe(true);
    expect(isToyboxCombineParamId('rotX')).toBe(false);
    expect(isToyboxCombineParamId('scale')).toBe(false);
  });
  it('parseCombineParamId splits nodeId + param (nodeId may have no colon)', () => {
    expect(parseCombineParamId('combine:op3:amount')).toEqual({ nodeId: 'op3', param: 'amount' });
    expect(parseCombineParamId('combine:n12:keyR')).toEqual({ nodeId: 'n12', param: 'keyR' });
    expect(parseCombineParamId('combine:op1:')).toBeNull();
    expect(parseCombineParamId('combine::amount')).toBeNull();
    expect(parseCombineParamId('scale')).toBeNull();
  });
});

describe('resolveToyboxParam — MATERIAL params', () => {
  it("resolves 'scale' against the first OBJ layer with the card's range", () => {
    const n = node([offLayer(), objLayer({ scale: 1.5 }), offLayer(), offLayer()]);
    const r = resolveToyboxParam(n, 'scale');
    expect(r).not.toBeNull();
    expect(r!.def).toMatchObject({ id: 'scale', label: 'SCALE', min: 0.25, max: 3, defaultValue: 1 });
    expect(r!.get()).toBe(1.5);
  });

  it("round-trips get/set for 'scale' (writes the LIVE material in place)", () => {
    const layers = [objLayer({ scale: 1 })];
    const n = node(layers);
    const r = resolveToyboxParam(n, 'scale')!;
    r.set(2.4);
    expect(r.get()).toBe(2.4);
    // the live layer material was mutated in place (same location the card writes)
    expect((layers[0]!.material as unknown as Record<string, number>).scale).toBe(2.4);
  });

  it("resolves 'rotX'/'spin'/'tintR' (the CV-targetable transform/tint set)", () => {
    const n = node([objLayer()]);
    expect(resolveToyboxParam(n, 'rotX')!.def).toMatchObject({ min: -Math.PI, max: Math.PI });
    expect(resolveToyboxParam(n, 'spin')!.def).toMatchObject({ min: 0, max: 3 });
    expect(resolveToyboxParam(n, 'tintR')!.def).toMatchObject({ min: 0, max: 1 });
  });

  it("resolves SURF MIX + projective material params NOT in the CV target set", () => {
    const n = node([objLayer({ surfaceMix: 0.5 })]);
    const mix = resolveToyboxParam(n, 'surfaceMix')!;
    expect(mix.def).toMatchObject({ id: 'surfaceMix', min: 0, max: 1, defaultValue: 1 });
    expect(mix.get()).toBe(0.5);
    mix.set(0.2);
    expect(mix.get()).toBe(0.2);

    const posZ = resolveToyboxParam(n, 'projPosZ')!;
    expect(posZ.def).toMatchObject({ id: 'projPosZ', min: -5, max: 5, defaultValue: 2.5 });
    posZ.set(-3);
    expect(posZ.get()).toBe(-3);

    const fov = resolveToyboxParam(n, 'projFov')!;
    expect(fov.def.min).toBe(0.2);
    expect(fov.def.max).toBe(2.6);
  });

  it('returns null for a material-only param when no OBJ layer exists', () => {
    // 'rotX' is a material-only id (no content declares it) → null without an OBJ.
    expect(resolveToyboxParam(node([shaderLayer('noise-fbm'), offLayer()]), 'rotX')).toBeNull();
  });
});

describe('resolveToyboxParam — COMBINE params', () => {
  it("resolves 'combine:op1:amount' (fade T) + round-trips", () => {
    const combine = makeDefaultCombineGraph(); // op1/op2/op3 are fades
    const n = node([objLayer()], combine);
    const r = resolveToyboxParam(n, 'combine:op1:amount');
    expect(r).not.toBeNull();
    expect(r!.def).toMatchObject({ id: 'combine:op1:amount', min: 0, max: 1, defaultValue: 1 });
    r!.set(0.4);
    expect(r!.get()).toBe(0.4);
    // mutated the live op node's params in place
    const op1 = combine.nodes.find((x) => x.id === 'op1')!;
    expect(op1.params!.amount).toBe(0.4);
  });

  it('returns null for an unknown op node / param / source-or-output node', () => {
    const combine = makeDefaultCombineGraph();
    const n = node([objLayer()], combine);
    expect(resolveToyboxParam(n, 'combine:nope:amount')).toBeNull();
    expect(resolveToyboxParam(n, 'combine:op1:bogus')).toBeNull();
    expect(resolveToyboxParam(n, 'combine:src0:amount')).toBeNull();
    expect(resolveToyboxParam(n, 'combine:out:amount')).toBeNull();
  });

  it('returns null when there is no combine graph', () => {
    expect(resolveToyboxParam(node([objLayer()]), 'combine:op1:amount')).toBeNull();
  });
});

describe('resolveToyboxParam — LAYER content uniforms', () => {
  it('resolves a content uniform by finding the owning shader/gen layer', () => {
    const n = node([offLayer(), shaderLayer('noise-fbm', { scale: 4 }), offLayer()]);
    // 'scale' is BOTH a material id and the noise-fbm uniform id; with no OBJ
    // layer present it resolves to the gen layer's uniform (range 0.5..6).
    const r = resolveToyboxParam(n, 'scale');
    expect(r).not.toBeNull();
    expect(r!.def).toMatchObject({ min: 0.5, max: 6, defaultValue: 2 });
    expect(r!.get()).toBe(4);
    r!.set(5);
    expect(r!.get()).toBe(5);
  });

  it('resolves a uniform unique to the content (speed)', () => {
    const n = node([shaderLayer('noise-fbm')]);
    const r = resolveToyboxParam(n, 'speed')!;
    expect(r.def).toMatchObject({ id: 'speed', min: 0, max: 2, defaultValue: 0.4 });
    expect(r.get()).toBe(0.4); // manifest default when unset
  });

  it('returns null for a uniform no layer declares', () => {
    expect(resolveToyboxParam(node([shaderLayer('noise-fbm')]), 'nonexistent')).toBeNull();
  });
});

describe('resolveToyboxParam — IMAGE/VIDEO layer params', () => {
  it("resolves 'opacity'/'brightness' on the first image/video layer", () => {
    const n = node([imageLayer({ opacity: 0.5 })]);
    const op = resolveToyboxParam(n, 'opacity')!;
    expect(op.def).toMatchObject({ id: 'opacity', min: 0, max: 1, defaultValue: 1 });
    expect(op.get()).toBe(0.5);
    op.set(0.8);
    expect(op.get()).toBe(0.8);
  });
});

describe('resolveToyboxParam — guards', () => {
  it('returns null for no node / no paramId / empty data', () => {
    expect(resolveToyboxParam(undefined, 'scale')).toBeNull();
    expect(resolveToyboxParam(node([objLayer()]), '')).toBeNull();
    expect(resolveToyboxParam({ data: {} }, 'scale')).toBeNull();
  });
});
