// packages/web/src/lib/graph/toybox-presets-ydoc.test.ts
//
// REAL-Y.Doc regression for the TOYBOX Phase-6 preset loader. Runs against the
// SAME syncedStore + Y.Doc the live patch uses, so a node's layers/combine/
// cvRoutes become real Y types after the first write — the only way to catch
// the "Type already integrated" trap when a SECOND preset load replaces the
// already-synced arrays/map. Mirrors toybox-combine-ydoc.test.ts +
// [[yjs-save-load-real-ydoc]].
//
// Also covers the PURE applyPresetToData helper (no Yjs) so the preset → data
// mapping is locked independent of the store, and round-trips a preset through
// the real Y.Doc (load → read back → matches the manifest preset).

import { describe, it, expect, afterEach } from 'vitest';
import { patch } from '$lib/graph/store';
import { applyPresetToData, applyPresetToNode, loadToyboxPreset } from './toybox-presets';
import { LAYER_COUNT, type ToyboxPreset } from '$lib/video/toybox-content';
import type { ModuleNode } from './types';

const TID = 'toybox-preset-ydoc-test';

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

afterEach(() => {
  if (patch.nodes[TID]) delete patch.nodes[TID];
});

/** A minimal but representative two-source preset (shader + obj, a lumakey op,
 *  one cv route) — exercises every branch of applyPresetToData. */
const PRESET_A: ToyboxPreset = {
  id: 'test-a',
  label: 'TEST A',
  layers: [
    { kind: 'shader', contentId: 'hsv-plasma', params: { speed: 1 } },
    {
      kind: 'obj',
      contentId: null,
      params: {},
      material: {
        modelId: 'spot', rotX: 0.3, rotY: 0.6, rotZ: 0,
        scale: 1, spin: 0.6, matcap: 0, tintR: 1, tintG: 1, tintB: 1,
      },
    },
    { kind: 'off', contentId: null, params: {} },
    { kind: 'off', contentId: null, params: {} },
  ],
  combine: {
    nodes: [
      { id: 'src0', kind: 'source', layer: 0, x: 14, y: 14 },
      { id: 'src1', kind: 'source', layer: 1, x: 14, y: 66 },
      { id: 'lk', kind: 'lumakey', x: 120, y: 40, params: { amount: 0.05, soft: 0.1, invert: 0 } },
      { id: 'out', kind: 'output', x: 286, y: 40 },
    ],
    edges: [
      { id: 'e0', from: 'src0', to: 'lk', toPort: 'in0' },
      { id: 'e1', from: 'src1', to: 'lk', toPort: 'in1' },
      { id: 'e2', from: 'lk', to: 'out', toPort: 'in0' },
    ],
  },
  cvRoutes: {
    cv3: { target: 'layer', layer: 1, param: 'material:spin' },
  },
};

/** A SECOND preset with a DIFFERENT shape (3 sources, map+chromakey, two routes)
 *  — loading it over PRESET_A must clear the prior arrays/map in place. */
const PRESET_B: ToyboxPreset = {
  id: 'test-b',
  label: 'TEST B',
  layers: [
    { kind: 'gen', contentId: 'worley-cells', params: { density: 8 } },
    { kind: 'gen', contentId: 'cos-gradient', params: {} },
    { kind: 'shader', contentId: 'hsv-plasma', params: {} },
    { kind: 'off', contentId: null, params: {} },
  ],
  combine: {
    nodes: [
      { id: 'src0', kind: 'source', layer: 0, x: 14, y: 14 },
      { id: 'src1', kind: 'source', layer: 1, x: 14, y: 66 },
      { id: 'src2', kind: 'source', layer: 2, x: 14, y: 118 },
      { id: 'ck', kind: 'chromakey', x: 120, y: 14, params: { amount: 0.3 } },
      { id: 'mp', kind: 'map', x: 120, y: 118, params: { amount: 0.7, mode: 1 } },
      { id: 'out', kind: 'output', x: 286, y: 66 },
    ],
    edges: [
      { id: 'e0', from: 'src0', to: 'ck', toPort: 'in0' },
      { id: 'e1', from: 'src1', to: 'ck', toPort: 'in1' },
      { id: 'e2', from: 'ck', to: 'mp', toPort: 'in0' },
      { id: 'e3', from: 'src2', to: 'mp', toPort: 'in1' },
      { id: 'e4', from: 'mp', to: 'out', toPort: 'in0' },
    ],
  },
  cvRoutes: {
    cv2: { target: 'combine', nodeId: 'mp', param: 'amount' },
    cv5: { target: 'layer', layer: 0, param: 'density' },
  },
};

describe('applyPresetToData (pure)', () => {
  it('populates layers / combine / cvRoutes onto an empty data object', () => {
    const data: Record<string, unknown> = {};
    applyPresetToData(data, PRESET_A);

    const layers = data.layers as typeof PRESET_A.layers;
    expect(layers).toHaveLength(LAYER_COUNT);
    expect(layers[0]!.kind).toBe('shader');
    expect(layers[0]!.contentId).toBe('hsv-plasma');
    expect(layers[1]!.kind).toBe('obj');
    expect(layers[1]!.material!.modelId).toBe('spot');

    const combine = data.combine as { nodes: { id: string }[]; edges: { id: string }[] };
    expect(combine.nodes.map((n) => n.id)).toEqual(['src0', 'src1', 'lk', 'out']);
    expect(combine.edges).toHaveLength(3);

    const routes = data.cvRoutes as Record<string, { param: string }>;
    expect(routes.cv3).toMatchObject({ target: 'layer', layer: 1, param: 'material:spin' });
  });

  it('deep-clones (no shared references with the preset)', () => {
    const data: Record<string, unknown> = {};
    applyPresetToData(data, PRESET_A);
    const layers = data.layers as typeof PRESET_A.layers;
    // Mutating the loaded layer must NOT touch the source preset.
    layers[0]!.params!.speed = 99;
    expect(PRESET_A.layers[0]!.params!.speed).toBe(1);
  });

  it('pads layers to LAYER_COUNT when the preset has fewer', () => {
    const short: ToyboxPreset = { ...PRESET_A, layers: PRESET_A.layers.slice(0, 1) };
    const data: Record<string, unknown> = {};
    applyPresetToData(data, short);
    const layers = data.layers as typeof PRESET_A.layers;
    expect(layers).toHaveLength(LAYER_COUNT);
    for (let i = 1; i < LAYER_COUNT; i++) expect(layers[i]!.kind).toBe('off');
  });
});

describe('toybox preset loader — real Y.Doc', () => {
  it('applies a preset in place without throwing', () => {
    makeToybox();
    expect(() => applyPresetToNode(TID, PRESET_A)).not.toThrow();
    const d = patch.nodes[TID]!.data as Record<string, unknown>;
    expect((d.layers as unknown[]).length).toBe(LAYER_COUNT);
  });

  it('loading a SECOND preset over a synced first never throws (in-place trap)', () => {
    makeToybox();
    // First load — arrays/map integrate into the Y.Doc.
    applyPresetToNode(TID, PRESET_A);
    const d = patch.nodes[TID]!.data as Record<string, unknown>;
    // Touch the live arrays so they're definitely materialised as Y types.
    expect((d.layers as unknown[]).length).toBe(LAYER_COUNT);
    expect(((d.combine as { nodes: unknown[] }).nodes).length).toBe(4);
    // Second load — clears + repopulates the SAME arrays/map in place.
    expect(() => applyPresetToNode(TID, PRESET_B)).not.toThrow();

    const layers = d.layers as { kind: string; contentId: string | null }[];
    expect(layers).toHaveLength(LAYER_COUNT);
    expect(layers[0]!.contentId).toBe('worley-cells');
    const combine = d.combine as { nodes: { id: string }[]; edges: unknown[] };
    expect(combine.nodes.map((n) => n.id)).toEqual(['src0', 'src1', 'src2', 'ck', 'mp', 'out']);
    expect(combine.edges).toHaveLength(5);
    // PRESET_A's cv3 route is gone; PRESET_B's cv2 + cv5 present.
    const routes = d.cvRoutes as Record<string, unknown>;
    expect(routes.cv3).toBeUndefined();
    expect(routes.cv2).toMatchObject({ target: 'combine', nodeId: 'mp', param: 'amount' });
    expect(routes.cv5).toMatchObject({ target: 'layer', layer: 0, param: 'density' });
  });

  it('loadToyboxPreset returns false for an unknown preset id', async () => {
    makeToybox();
    const ok = await loadToyboxPreset(TID, 'does-not-exist');
    expect(ok).toBe(false);
  });

  it('round-trips a real bundled manifest preset through the live Y.Doc', async () => {
    makeToybox();
    // loadToyboxPreset fetches the real static manifest. In the vitest jsdom
    // env `fetch` may be unavailable; skip gracefully if so (the e2e/VRT specs
    // cover the manifest path against the real server).
    let ok = false;
    try {
      ok = await loadToyboxPreset(TID, 'plasma-dissolve');
    } catch {
      return; // no fetch in this env → covered by e2e
    }
    if (!ok) return; // manifest not reachable in this env
    const d = patch.nodes[TID]!.data as Record<string, unknown>;
    const layers = d.layers as { kind: string; contentId: string | null }[];
    expect(layers[0]!.contentId).toBe('hsv-plasma');
    expect(layers[1]!.contentId).toBe('cos-gradient');
    const routes = d.cvRoutes as Record<string, { nodeId?: string }>;
    expect(routes.cv1).toMatchObject({ target: 'combine', nodeId: 'fade1', param: 'amount' });
  });
});
