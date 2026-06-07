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
  isToyboxLayerParamId,
  parseLayerParamId,
  isToyboxCvInputParamId,
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

// ── Audit M4: layer-qualified per-layer paramIds ('layer:<idx>:<param>') bind
//    to a SPECIFIC layer index, so two layers' bindings don't collide (a bare
//    'scale' resolved to the first-owning layer; switching the active layer
//    remounted the knob under the same key onto a different layer's setter).
describe('layer-qualified per-layer params (audit M4)', () => {
  it('isToyboxLayerParamId + parseLayerParamId', () => {
    expect(isToyboxLayerParamId('layer:2:rotX')).toBe(true);
    expect(isToyboxLayerParamId('combine:op1:amount')).toBe(false);
    expect(isToyboxLayerParamId('rotX')).toBe(false);
    expect(parseLayerParamId('layer:0:scale')).toEqual({ layer: 0, param: 'scale' });
    expect(parseLayerParamId('layer:3:speed')).toEqual({ layer: 3, param: 'speed' });
    expect(parseLayerParamId('layer::scale')).toBeNull();
    expect(parseLayerParamId('layer:99:scale')).toBeNull(); // out of range
    expect(parseLayerParamId('layer:1:')).toBeNull();
  });

  it('resolves to the EXACT layer index — two OBJ layers do NOT cross-collide', () => {
    // layer 0 + layer 1 are BOTH OBJ with distinct scales. A bare 'scale' would
    // resolve to layer 0 for both bindings; the layer-qualified id pins each.
    const n = node([objLayer({ scale: 1.1 }), objLayer({ scale: 2.2 }), offLayer(), offLayer()]);
    const r0 = resolveToyboxParam(n, 'layer:0:scale')!;
    const r1 = resolveToyboxParam(n, 'layer:1:scale')!;
    expect(r0.get()).toBe(1.1);
    expect(r1.get()).toBe(2.2);
    // Writing layer 1 must NOT touch layer 0 (the M4 collision).
    r1.set(2.9);
    expect(r1.get()).toBe(2.9);
    expect(r0.get()).toBe(1.1);
    // And the def id carries the qualified paramId (so the surface/MIDI key sticks).
    expect(r1.def.id).toBe('layer:1:scale');
  });

  it('resolves a content uniform on a specific shader layer index', () => {
    const n = node([offLayer(), shaderLayer('noise-fbm', { speed: 0.9 }), offLayer(), offLayer()]);
    const r = resolveToyboxParam(n, 'layer:1:speed')!;
    expect(r.get()).toBe(0.9);
    r.set(1.5);
    expect(r.get()).toBe(1.5);
  });

  it('returns null when the indexed layer does not own the param', () => {
    const n = node([objLayer(), offLayer(), offLayer(), offLayer()]);
    expect(resolveToyboxParam(n, 'layer:1:scale')).toBeNull(); // layer 1 is off
    expect(resolveToyboxParam(n, 'layer:0:speed')).toBeNull(); // obj has no 'speed'
  });
});

// ── Audit M6: cvN:scale / cvN:offset (the per-input attenuverter knobs) resolve
//    against node.data.cvInputs so the Control Surface no longer silently drops
//    the binding (MIDI-learn already worked, so they DISAGREED before this).
describe('cvInputs SCALE/OFFSET params (audit M6)', () => {
  it('isToyboxCvInputParamId detects cvN:scale / cvN:offset', () => {
    expect(isToyboxCvInputParamId('cv1:scale')).toBe(true);
    expect(isToyboxCvInputParamId('cv6:offset')).toBe(true);
    expect(isToyboxCvInputParamId('cv7:scale')).toBe(false); // only cv1..cv6 exist
    expect(isToyboxCvInputParamId('cv1:bogus')).toBe(false);
    expect(isToyboxCvInputParamId('combine:op1:amount')).toBe(false);
  });

  it('resolves cv1:scale with the bipolar attenuverter range + round-trips', () => {
    const n: { data: Record<string, unknown> } = {
      data: { layers: [offLayer()], cvInputs: { cv1: { scale: 0.5, offset: 0.1 } } },
    };
    const r = resolveToyboxParam(n, 'cv1:scale')!;
    expect(r.def).toMatchObject({ id: 'cv1:scale', min: -1, max: 1 });
    expect(r.get()).toBe(0.5);
    r.set(-0.75);
    expect(r.get()).toBe(-0.75);
    // The live cvInputs map was mutated in place.
    expect((n.data.cvInputs as Record<string, { scale: number }>).cv1.scale).toBe(-0.75);
  });

  it('resolves cv2:offset (0..1) and seeds the cvInputs entry when absent', () => {
    const n: { data: Record<string, unknown> } = { data: { layers: [offLayer()] } };
    const r = resolveToyboxParam(n, 'cv2:offset')!;
    expect(r.def).toMatchObject({ id: 'cv2:offset', min: 0, max: 1 });
    expect(r.get()).toBe(0); // default offset
    r.set(0.6);
    expect(r.get()).toBe(0.6);
    expect((n.data.cvInputs as Record<string, { offset: number }>).cv2.offset).toBe(0.6);
  });
});
