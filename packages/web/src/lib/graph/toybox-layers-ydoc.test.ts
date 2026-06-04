// packages/web/src/lib/graph/toybox-layers-ydoc.test.ts
//
// REAL-Y.Doc regression for the TOYBOX per-layer mutators (graph/toybox-layers).
// The card's LAYER-index selector routes every per-layer control through these,
// targeting node.data.layers[<activeLayer>]. We run against the SAME syncedStore
// + Y.Doc the live patch uses (mirrors toybox-presets-ydoc.test.ts +
// [[yjs-save-load-real-ydoc]]) so layers/params/material become real Y types
// after the first write — the only way to catch the "Type already integrated"
// trap when a SECOND write mutates an already-synced layer in place.
//
// The seeding mutators (setLayerKind / setLayerContent) read getContentMeta /
// getModelMeta, which need the static manifest. We mock global fetch with a
// minimal fixture (the real DEFAULT_CONTENT_ID + DEFAULT_MODEL_ID) and await
// ensureToyboxCatalog() so the seed picks up genuine param schemas.

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { patch } from '$lib/graph/store';
import {
  clampLayerIndex,
  ensureLayer,
  setLayerKind,
  setLayerContent,
  setLayerParam,
  setLayerModel,
  setLayerMatcap,
  setLayerSurfaceSource,
  setLayerMaterialField,
} from './toybox-layers';
import {
  DEFAULT_CONTENT_ID,
  DEFAULT_MODEL_ID,
  LAYER_COUNT,
  ensureToyboxCatalog,
  type ToyboxLayer,
} from '$lib/video/toybox-content';
import type { ModuleNode } from './types';

// Minimal manifest fixture: the real default content id (noise-fbm) + default
// model id (spot) so the seed branches in setLayerKind resolve to real schemas.
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
      id: DEFAULT_CONTENT_ID, // 'noise-fbm'
      label: 'NOISE FBM',
      family: 'GEN',
      glsl: `/toybox/shaders/${DEFAULT_CONTENT_ID}.frag.glsl`,
      params: [
        { id: 'scale', label: 'SCALE', min: 0.5, max: 6, default: 2, curve: 'linear' },
        { id: 'speed', label: 'SPEED', min: 0, max: 2, default: 0.4, curve: 'linear' },
      ],
    },
    {
      id: 'cos-gradient',
      label: 'COS GRADIENT',
      family: 'GEN',
      glsl: '/toybox/shaders/cos-gradient.frag.glsl',
      params: [{ id: 'phase', label: 'PHASE', min: 0, max: 6.28, default: 0, curve: 'linear' }],
    },
  ],
  models: [
    { id: DEFAULT_MODEL_ID, label: 'SPOT', obj: '/toybox/models/spot.obj', matcap: 1 },
    { id: 'sphere', label: 'SPHERE', builtin: 'sphere', matcap: 2 },
  ],
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

const TID = 'toybox-layers-ydoc-test';

/** Spawn a TOYBOX node with the given data into the live patch. */
function makeToybox(data: Record<string, unknown> = {}): void {
  patch.nodes[TID] = {
    id: TID,
    type: 'toybox',
    domain: 'video',
    position: { x: 0, y: 0 },
    params: {},
    data,
  } as unknown as ModuleNode;
}

/** Read the live layers off the node. */
function layers(): ToyboxLayer[] {
  return (patch.nodes[TID]!.data as { layers: ToyboxLayer[] }).layers;
}

afterEach(() => {
  if (patch.nodes[TID]) delete patch.nodes[TID];
});

describe('clampLayerIndex', () => {
  it('clamps to [0, LAYER_COUNT-1] + floors / defaults non-finite to 0', () => {
    expect(clampLayerIndex(0)).toBe(0);
    expect(clampLayerIndex(LAYER_COUNT - 1)).toBe(LAYER_COUNT - 1);
    expect(clampLayerIndex(LAYER_COUNT + 5)).toBe(LAYER_COUNT - 1);
    expect(clampLayerIndex(-3)).toBe(0);
    expect(clampLayerIndex(2.9)).toBe(2);
    expect(clampLayerIndex(NaN)).toBe(0);
    expect(clampLayerIndex('x' as unknown)).toBe(0);
  });
});

describe('ensureLayer — seeds + pads node.data.layers in place', () => {
  it('seeds a full default array when layers are absent', () => {
    makeToybox();
    const l = ensureLayer(TID, 2);
    expect(l).not.toBeNull();
    expect(layers()).toHaveLength(LAYER_COUNT);
    // layer 0 is the default gen; the rest are off.
    expect(layers()[0]!.kind).toBe('gen');
    expect(layers()[2]!.kind).toBe('off');
  });

  it('returns null for an unknown node', () => {
    expect(ensureLayer('nope', 0)).toBeNull();
  });
});

describe('per-layer mutators retarget to layers[activeLayer]', () => {
  it('setLayerContent on layer 2 updates layers[2], leaves layer 0 untouched', () => {
    makeToybox();
    // Layer 0 starts as the default gen (noise-fbm).
    ensureLayer(TID, 0);
    const beforeL0 = { kind: layers()[0]!.kind, contentId: layers()[0]!.contentId };

    setLayerContent(TID, 2, 'hsv-plasma');

    // (a) layer 2 got the shader.
    expect(layers()[2]!.kind).toBe('shader');
    expect(layers()[2]!.contentId).toBe('hsv-plasma');
    // params reset to the content's manifest defaults.
    expect(layers()[2]!.params.speed).toBe(1);
    // (b) layer 0 is untouched.
    expect(layers()[0]!.kind).toBe(beforeL0.kind);
    expect(layers()[0]!.contentId).toBe(beforeL0.contentId);
  });

  it('setLayerKind on an OFF layer seeds default content for that layer only', () => {
    makeToybox();
    ensureLayer(TID, 0); // seed defaults; layer 3 is 'off'
    expect(layers()[3]!.kind).toBe('off');

    setLayerKind(TID, 3, 'gen');

    expect(layers()[3]!.kind).toBe('gen');
    expect(layers()[3]!.contentId).toBe(DEFAULT_CONTENT_ID);
    // its params were seeded from the manifest defaults.
    expect(layers()[3]!.params.scale).toBe(2);
    // other layers stay as they were.
    expect(layers()[1]!.kind).toBe('off');
    expect(layers()[2]!.kind).toBe('off');
  });

  it('setLayerKind → obj seeds a material (+ model preferred matcap) for that layer', () => {
    makeToybox();
    setLayerKind(TID, 1, 'obj');
    const mat = layers()[1]!.material!;
    expect(layers()[1]!.kind).toBe('obj');
    expect(mat.modelId).toBe(DEFAULT_MODEL_ID);
    // spot's preferred matcap from the fixture (1) is adopted.
    expect(mat.matcap).toBe(1);
    // layer 0 still the default gen (no material).
    expect(layers()[0]!.kind).toBe('gen');
    expect(layers()[0]!.material).toBeUndefined();
  });

  it('setLayerParam writes one param on the targeted layer only', () => {
    makeToybox();
    setLayerContent(TID, 1, DEFAULT_CONTENT_ID);
    setLayerParam(TID, 1, 'scale', 5.5);
    expect(layers()[1]!.params.scale).toBe(5.5);
    // layer 0's params are independent.
    expect(layers()[0]!.params.scale).not.toBe(5.5);
  });

  it('setLayerModel / setLayerMatcap / setLayerSurfaceSource / material field target the layer', () => {
    makeToybox();
    setLayerKind(TID, 2, 'obj');
    setLayerModel(TID, 2, 'sphere');
    expect(layers()[2]!.material!.modelId).toBe('sphere');
    // sphere's preferred matcap (2) adopted on model change.
    expect(layers()[2]!.material!.matcap).toBe(2);

    setLayerMatcap(TID, 2, 0);
    expect(layers()[2]!.material!.matcap).toBe(0);

    // surface source = layer 0 (texture this OBJ with layer 0's output).
    setLayerSurfaceSource(TID, 2, 0);
    expect(layers()[2]!.material!.surfaceSource).toBe(0);
    // MATCAP (-1) normalisation.
    setLayerSurfaceSource(TID, 2, -1);
    expect(layers()[2]!.material!.surfaceSource).toBe(-1);

    setLayerMaterialField(TID, 2, 'spin', 1.25);
    expect(layers()[2]!.material!.spin).toBe(1.25);
  });
});

describe('real-Y.Doc in-place trap (second write to a synced layer)', () => {
  it('switching a layer content twice never throws (params replaced in place)', () => {
    makeToybox();
    // First write integrates layers[1] + its params as live Y types.
    setLayerContent(TID, 1, DEFAULT_CONTENT_ID);
    expect(layers()[1]!.params.scale).toBe(2);
    // Touch the live params so it's materialised as a Y.Map.
    expect(Object.keys(layers()[1]!.params).length).toBeGreaterThan(0);
    // Second write must clear + repopulate params IN PLACE without reassigning
    // the already-integrated Y.Map.
    expect(() => setLayerContent(TID, 1, 'cos-gradient')).not.toThrow();
    expect(layers()[1]!.kind).toBe('gen');
    expect(layers()[1]!.contentId).toBe('cos-gradient');
    expect(layers()[1]!.params.phase).toBe(0);
    // the old content's 'scale' param is gone (cleared in place).
    expect(layers()[1]!.params.scale).toBeUndefined();
  });

  it('authoring multiple distinct layers builds a multi-layer patch', () => {
    makeToybox();
    setLayerContent(TID, 0, 'hsv-plasma'); // layer 0 = shader
    setLayerKind(TID, 1, 'obj'); // layer 1 = obj
    setLayerContent(TID, 2, 'cos-gradient'); // layer 2 = gen
    // layer 3 remains off.
    expect(layers().map((l) => l.kind)).toEqual(['shader', 'obj', 'gen', 'off']);
    expect(layers()[0]!.contentId).toBe('hsv-plasma');
    expect(layers()[1]!.material!.modelId).toBe(DEFAULT_MODEL_ID);
    expect(layers()[2]!.contentId).toBe('cos-gradient');
  });
});
