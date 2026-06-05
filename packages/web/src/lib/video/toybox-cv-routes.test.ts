// packages/web/src/lib/video/toybox-cv-routes.test.ts
//
// TOYBOX — CV routing + scale/offset coverage (PURE helpers). Proves the
// three demonstrated assignment setups resolve + map correctly:
//   (a) cv → a SHADER param   (layer 0 content uniform),
//   (b) cv → a COMBINE param  (a fade op node's amount/t),
//   (c) cv → an OBJ param     (a layer's material spin/tint),
// plus the per-input attenuverter/offset map (signal 0..1 × scale + offset →
// param range, via effectiveCvValue), getCvInput defaults, and the no-route
// no-op. (The pure attenuverter math itself is covered in toybox-cv-math.test.)
//
// Shader-uniform routes need the content catalog (getContentMeta), which reads
// the static manifest. We mock global fetch with the real manifest fixture +
// await ensureToyboxCatalog() so getContentMeta returns the genuine schema.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import {
  CV_PORT_IDS,
  CV_PORT_COUNT,
  isCvPortId,
  resolveRoute,
  getCvInput,
  effectiveCvValue,
  DEFAULT_INPUT_SCALE,
  DEFAULT_INPUT_OFFSET,
  listCvTargets,
  listCvParams,
  encodeTargetValue,
  decodeTargetValue,
  MATERIAL_PARAMS,
  type CvRouteTarget,
} from './toybox-cv-routes';
import { ensureToyboxCatalog, type ToyboxLayer } from './toybox-content';
import { makeDefaultCombineGraph, type ToyboxCombineGraph } from './toybox-combine-graph';

// Minimal manifest fixture (a subset of the real static manifest — the params
// we route to are exact). getContentMeta reads from here once loaded.
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

// ── helpers to build live state ──
function shaderLayer(contentId: string, params: Record<string, number> = {}): ToyboxLayer {
  return { kind: 'gen', contentId, params };
}
function objLayer(material: Record<string, number>): ToyboxLayer {
  return { kind: 'obj', contentId: null, params: {}, material: { modelId: 'cube', ...material } as never };
}
function offLayer(): ToyboxLayer {
  return { kind: 'off', contentId: null, params: {} };
}

describe('CV pool port ids', () => {
  it('declares exactly CV_PORT_COUNT generic ports cv1..cvN', () => {
    expect(CV_PORT_COUNT).toBe(6);
    expect(CV_PORT_IDS).toEqual(['cv1', 'cv2', 'cv3', 'cv4', 'cv5', 'cv6']);
  });
  it('isCvPortId recognises pool ports + rejects others', () => {
    expect(isCvPortId('cv1')).toBe(true);
    expect(isCvPortId('cv6')).toBe(true);
    expect(isCvPortId('cv7')).toBe(false); // pool shrank 8→6
    expect(isCvPortId('cv8')).toBe(false);
    expect(isCvPortId('cv9')).toBe(false);
    expect(isCvPortId('speed')).toBe(false);
    expect(isCvPortId('out')).toBe(false);
  });
});

describe('getCvInput (per-input scale/offset defaults)', () => {
  it('defaults to full-passthrough (scale +1, offset 0) when absent', () => {
    expect(getCvInput(undefined, 'cv1')).toEqual({ scale: 1, offset: 0 });
    expect(getCvInput({}, 'cv1')).toEqual({ scale: 1, offset: 0 });
    expect(DEFAULT_INPUT_SCALE).toBe(1);
    expect(DEFAULT_INPUT_OFFSET).toBe(0);
  });
  it('reads a stored scale/offset and fills only the missing field', () => {
    expect(getCvInput({ cv2: { scale: -0.5, offset: 0.3 } }, 'cv2')).toEqual({
      scale: -0.5,
      offset: 0.3,
    });
    // partial / non-finite fields fall back to the default per field.
    expect(getCvInput({ cv3: { scale: 0.4 } as never }, 'cv3')).toEqual({ scale: 0.4, offset: 0 });
    expect(getCvInput({ cv4: { scale: NaN, offset: 0.9 } }, 'cv4')).toEqual({ scale: 1, offset: 0.9 });
  });
});

describe('target/param encode + decode', () => {
  it('round-trips a layer target', () => {
    const v = encodeTargetValue({ target: 'layer', layer: 2 });
    expect(v).toBe('layer:2');
    expect(decodeTargetValue(v)).toEqual({ target: 'layer', layer: 2 });
  });
  it('round-trips a combine target', () => {
    const v = encodeTargetValue({ target: 'combine', nodeId: 'op3' });
    expect(v).toBe('combine:op3');
    expect(decodeTargetValue(v)).toEqual({ target: 'combine', nodeId: 'op3' });
  });
  it('rejects garbage values', () => {
    expect(decodeTargetValue('')).toBeNull();
    expect(decodeTargetValue('combine:')).toBeNull();
    expect(decodeTargetValue('nonsense')).toBeNull();
  });
});

describe('listCvTargets', () => {
  it('lists all 4 layers + every combine op node (not source/output)', () => {
    const layers = [shaderLayer('noise-fbm'), offLayer(), objLayer({ spin: 1 }), offLayer()];
    const combine = makeDefaultCombineGraph(); // 4 sources + 3 fade ops + output
    const targets = listCvTargets(layers, combine);
    const layerTargets = targets.filter((t) => t.target === 'layer');
    const combineTargets = targets.filter((t) => t.target === 'combine');
    expect(layerTargets).toHaveLength(4);
    expect(combineTargets.map((t) => t.nodeId)).toEqual(['op1', 'op2', 'op3']);
    // No source/output node leaks into the target list.
    expect(combineTargets.some((t) => t.nodeId === 'src0' || t.nodeId === 'out')).toBe(false);
  });
});

describe('listCvParams', () => {
  it('shader layer → its content manifest uniforms', () => {
    const layers = [shaderLayer('noise-fbm'), offLayer(), offLayer(), offLayer()];
    const params = listCvParams({ target: 'layer', layer: 0 }, layers, undefined);
    expect(params.map((p) => p.id)).toEqual(['scale', 'speed']);
    expect(params.find((p) => p.id === 'scale')).toMatchObject({ min: 0.5, max: 6 });
  });
  it('obj layer → the MATERIAL_PARAMS schema', () => {
    const layers = [objLayer({ spin: 1 }), offLayer(), offLayer(), offLayer()];
    const params = listCvParams({ target: 'layer', layer: 0 }, layers, undefined);
    expect(params.map((p) => p.id)).toEqual(MATERIAL_PARAMS.map((p) => p.id));
  });
  it('off layer → no params', () => {
    const layers = [offLayer(), offLayer(), offLayer(), offLayer()];
    expect(listCvParams({ target: 'layer', layer: 0 }, layers, undefined)).toEqual([]);
  });
  it('combine fade op → its OP_PARAMS (amount, ...)', () => {
    const combine = makeDefaultCombineGraph();
    const params = listCvParams({ target: 'combine', nodeId: 'op1' }, undefined, combine);
    expect(params.map((p) => p.id)).toContain('amount');
  });
});

describe('effectiveCvValue (signal × scale + offset → param range)', () => {
  it('full passthrough (scale +1, offset 0): unipolar 0..1 sweeps the full range', () => {
    expect(effectiveCvValue(0, 1, 0, 0, 3)).toBeCloseTo(0, 6);
    expect(effectiveCvValue(1, 1, 0, 0, 3)).toBeCloseTo(3, 6);
    expect(effectiveCvValue(0.5, 1, 0, 0, 3)).toBeCloseTo(1.5, 6);
  });
  it('offset 0.5 with no signal parks the param at its midpoint', () => {
    expect(effectiveCvValue(0, 1, 0.5, 0, 3)).toBeCloseTo(1.5, 6);
  });
  it('scale 0 = off (param parks at offset); negative scale inverts', () => {
    expect(effectiveCvValue(1, 0, 0.25, 0, 3)).toBeCloseTo(0.75, 6); // signal ignored
    expect(effectiveCvValue(1, -1, 1, 0, 3)).toBeCloseTo(0, 6); // invert from the top
  });
  it('clamps beyond the natural range', () => {
    expect(effectiveCvValue(1, 1, 0.9, 0, 3)).toBeCloseTo(3, 6);
    expect(effectiveCvValue(0, 1, -0.5, 0, 3)).toBeCloseTo(0, 6);
  });
});

describe('resolveRoute (a) cv → SHADER param', () => {
  it('resolves a layer-0 content uniform, reports its range + writes re-scaled', () => {
    const layers: ToyboxLayer[] = [shaderLayer('hsv-plasma', { speed: 1.5 }), offLayer(), offLayer(), offLayer()];
    const route: CvRouteTarget = { target: 'layer', layer: 0, param: 'speed' };
    const r = resolveRoute(route, layers, undefined);
    expect(r).not.toBeNull();
    expect(r!.min).toBe(0);
    expect(r!.max).toBe(3);
    expect(r!.current).toBe(1.5);
    // full-scale unipolar signal (1) at default scale/offset → max (3).
    r!.apply(effectiveCvValue(1, DEFAULT_INPUT_SCALE, DEFAULT_INPUT_OFFSET, r!.min, r!.max));
    expect(layers[0]!.params!.speed).toBeCloseTo(3, 6);
  });
  it('uses the manifest default as the centre when the param is unset', () => {
    const layers: ToyboxLayer[] = [shaderLayer('noise-fbm', {}), offLayer(), offLayer(), offLayer()];
    const r = resolveRoute({ target: 'layer', layer: 0, param: 'scale' }, layers, undefined);
    expect(r!.current).toBe(2); // noise-fbm scale default
  });
});

describe('resolveRoute (b) cv → COMBINE param', () => {
  it('resolves a fade op node param, reports its range + writes re-scaled', () => {
    const combine: ToyboxCombineGraph = makeDefaultCombineGraph();
    const op = combine.nodes.find((n) => n.id === 'op1')!;
    op.params = { amount: 0 };
    const route: CvRouteTarget = { target: 'combine', nodeId: 'op1', param: 'amount' };
    const r = resolveRoute(route, undefined, combine);
    expect(r).not.toBeNull();
    expect(r!.min).toBe(0);
    expect(r!.max).toBe(1);
    // half-scale signal at default scale/offset → range midpoint (0.5).
    r!.apply(effectiveCvValue(0.5, DEFAULT_INPUT_SCALE, DEFAULT_INPUT_OFFSET, r!.min, r!.max));
    expect(op.params!.amount).toBeCloseTo(0.5, 6);
    // full-scale signal → max (1) regardless of the prior write (no drift).
    const r2 = resolveRoute(route, undefined, combine);
    r2!.apply(effectiveCvValue(1, DEFAULT_INPUT_SCALE, DEFAULT_INPUT_OFFSET, r2!.min, r2!.max));
    expect(op.params!.amount).toBeCloseTo(1, 6);
  });
});

describe('resolveRoute (c) cv → OBJ param', () => {
  it('resolves an OBJ-layer material field, reports its range + writes re-scaled', () => {
    const layers: ToyboxLayer[] = [offLayer(), offLayer(), objLayer({ spin: 0 }), offLayer()];
    const route: CvRouteTarget = { target: 'layer', layer: 2, param: 'material:spin' };
    const r = resolveRoute(route, layers, undefined);
    expect(r).not.toBeNull();
    expect(r!.min).toBe(0);
    expect(r!.max).toBe(3);
    expect(r!.current).toBe(0);
    // half-scale signal → range midpoint (1.5).
    r!.apply(effectiveCvValue(0.5, DEFAULT_INPUT_SCALE, DEFAULT_INPUT_OFFSET, r!.min, r!.max));
    expect((layers[2]!.material as unknown as Record<string, number>).spin).toBeCloseTo(1.5, 6);
  });
  it('routes a material tint field across its 0..1 range', () => {
    const layers: ToyboxLayer[] = [objLayer({ tintR: 0.5 }), offLayer(), offLayer(), offLayer()];
    const r = resolveRoute({ target: 'layer', layer: 0, param: 'material:tintR' }, layers, undefined);
    expect(r!.min).toBe(0);
    expect(r!.max).toBe(1);
    r!.apply(effectiveCvValue(1, DEFAULT_INPUT_SCALE, DEFAULT_INPUT_OFFSET, r!.min, r!.max));
    expect((layers[0]!.material as unknown as Record<string, number>).tintR).toBeCloseTo(1, 6);
  });
});

describe('resolveRoute no-op / unresolvable cases', () => {
  it('returns null for a route to an OFF layer', () => {
    const layers: ToyboxLayer[] = [offLayer(), offLayer(), offLayer(), offLayer()];
    expect(resolveRoute({ target: 'layer', layer: 0, param: 'speed' }, layers, undefined)).toBeNull();
  });
  it('returns null for a material param on a non-OBJ layer', () => {
    const layers: ToyboxLayer[] = [shaderLayer('noise-fbm'), offLayer(), offLayer(), offLayer()];
    expect(resolveRoute({ target: 'layer', layer: 0, param: 'material:spin' }, layers, undefined)).toBeNull();
  });
  it('returns null for an unknown shader uniform', () => {
    const layers: ToyboxLayer[] = [shaderLayer('noise-fbm'), offLayer(), offLayer(), offLayer()];
    expect(resolveRoute({ target: 'layer', layer: 0, param: 'nope' }, layers, undefined)).toBeNull();
  });
  it('returns null for an unknown combine node', () => {
    const combine = makeDefaultCombineGraph();
    expect(resolveRoute({ target: 'combine', nodeId: 'ghost', param: 'amount' }, undefined, combine)).toBeNull();
  });
  it('returns null for a combine source/output node (no params)', () => {
    const combine = makeDefaultCombineGraph();
    expect(resolveRoute({ target: 'combine', nodeId: 'src0', param: 'amount' }, undefined, combine)).toBeNull();
    expect(resolveRoute({ target: 'combine', nodeId: 'out', param: 'amount' }, undefined, combine)).toBeNull();
  });
  it('returns null for an out-of-range layer index', () => {
    const layers: ToyboxLayer[] = [shaderLayer('noise-fbm'), offLayer(), offLayer(), offLayer()];
    expect(resolveRoute({ target: 'layer', layer: 9, param: 'speed' }, layers, undefined)).toBeNull();
  });
});
