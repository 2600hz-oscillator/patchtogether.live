// packages/web/src/lib/video/toybox-surface.test.ts
//
// Unit tests for the PURE texmap helpers: readSurfaceSource (defensive
// normalisation of material.surfaceSource) + resolveRenderOrder (the per-frame
// dependency order + safe-source guard). The GL pass itself is VRT-only; these
// prove the ordering + cycle/self/out-of-range guards that keep the bind safe.

import { describe, it, expect } from 'vitest';
import {
  readSurfaceSource,
  resolveRenderOrder,
  layerHasInputEdge,
  layerInputWanted,
} from './toybox-surface';
import { LAYER_COUNT, makeDefaultObjMaterial, type ToyboxLayer } from './toybox-content';
import {
  LAYER_INPUT_SOURCE,
  makeDefaultCombineGraph,
  validateConnect,
  type ToyboxCombineGraph,
} from './toybox-combine-graph';

/** Build a 4-layer array; `objSources[i]` (if a number) makes layer i an OBJ
 *  with material.surfaceSource = that value. Otherwise the layer is 'off'. */
function layersWith(objSources: Array<number | null | undefined | 'noobj'>): ToyboxLayer[] {
  const out: ToyboxLayer[] = [];
  for (let i = 0; i < LAYER_COUNT; i++) {
    const s = objSources[i];
    if (s === 'noobj' || s === undefined) {
      out.push({ kind: 'off', contentId: null, params: {} });
    } else {
      const material = makeDefaultObjMaterial('sphere');
      if (typeof s === 'number') material.surfaceSource = s;
      out.push({ kind: 'obj', contentId: null, params: {}, material });
    }
  }
  return out;
}

describe('readSurfaceSource — defensive normalisation', () => {
  it('returns a valid in-range non-self source', () => {
    const layers = layersWith([1, 'noobj', 'noobj', 'noobj']);
    expect(readSurfaceSource(layers, 0)).toBe(1);
  });

  it('returns -1 for undefined / -1 / NaN', () => {
    expect(readSurfaceSource(layersWith([undefined, 'noobj', 'noobj', 'noobj']), 0)).toBe(-1);
    expect(readSurfaceSource(layersWith([-1, 'noobj', 'noobj', 'noobj']), 0)).toBe(-1);
    expect(readSurfaceSource(layersWith([NaN, 'noobj', 'noobj', 'noobj']), 0)).toBe(-1);
  });

  it('returns -1 for self-reference (would be a feedback loop)', () => {
    expect(readSurfaceSource(layersWith([0, 'noobj', 'noobj', 'noobj']), 0)).toBe(-1);
  });

  it('returns -1 for out-of-range', () => {
    expect(readSurfaceSource(layersWith([99, 'noobj', 'noobj', 'noobj']), 0)).toBe(-1);
    expect(readSurfaceSource(layersWith([LAYER_COUNT, 'noobj', 'noobj', 'noobj']), 0)).toBe(-1);
  });

  it('returns -1 for a non-OBJ layer even if surfaceSource is set', () => {
    const layers = layersWith([1, 'noobj', 'noobj', 'noobj']);
    layers[0] = { kind: 'gen', contentId: 'noise-fbm', params: {} };
    expect(readSurfaceSource(layers, 0)).toBe(-1);
  });

  it('a FRAG layer depends on the layer directly below (i-1)', () => {
    const layers = layersWith(['noobj', 'noobj', 'noobj', 'noobj']);
    layers[0] = { kind: 'gen', contentId: 'noise-fbm', params: {} };
    layers[1] = { kind: 'frag', contentId: 'invert', params: {} };
    expect(readSurfaceSource(layers, 1)).toBe(0); // FRAG at L1 → scene = L0
  });

  it('a FRAG layer at index 0 has nothing below → -1', () => {
    const layers = layersWith(['noobj', 'noobj', 'noobj', 'noobj']);
    layers[0] = { kind: 'frag', contentId: 'invert', params: {} };
    expect(readSurfaceSource(layers, 0)).toBe(-1);
  });

  it('orders the below-layer BEFORE a FRAG that samples it', () => {
    const layers = layersWith(['noobj', 'noobj', 'noobj', 'noobj']);
    layers[0] = { kind: 'gen', contentId: 'noise-fbm', params: {} };
    layers[1] = { kind: 'frag', contentId: 'invert', params: {} };
    const { order, safeSource } = resolveRenderOrder(layers);
    expect(order.indexOf(0)).toBeLessThan(order.indexOf(1));
    expect(safeSource[1]).toBe(0);
  });
});

describe('resolveRenderOrder — ordering + safe-source guard', () => {
  it('renders the source layer BEFORE the OBJ that samples it', () => {
    // Layer 0 = OBJ sampling layer 1. Layer 1 must come first in the order.
    const { order, safeSource } = resolveRenderOrder(layersWith([1, 'noobj', 'noobj', 'noobj']));
    expect(order.indexOf(1)).toBeLessThan(order.indexOf(0));
    expect(safeSource[0]).toBe(1); // textured
    expect(order).toHaveLength(LAYER_COUNT);
    // order is a permutation of 0..3
    expect([...order].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
  });

  it('no surfaceSource → ascending order, all matcap', () => {
    const { order, safeSource } = resolveRenderOrder(
      layersWith(['noobj', 'noobj', 'noobj', 'noobj']),
    );
    expect(order).toEqual([0, 1, 2, 3]);
    expect(safeSource).toEqual([-1, -1, -1, -1]);
  });

  it('self-reference → matcap-only (safeSource -1)', () => {
    const { safeSource } = resolveRenderOrder(layersWith([0, 'noobj', 'noobj', 'noobj']));
    expect(safeSource[0]).toBe(-1);
  });

  it('out-of-range / undefined source → matcap-only', () => {
    const { safeSource } = resolveRenderOrder(layersWith([99, undefined, 'noobj', 'noobj']));
    expect(safeSource[0]).toBe(-1);
  });

  it('a 2-cycle (0→1, 1→0) degrades BOTH to matcap-only', () => {
    // Layer 0 textures layer 1, layer 1 textures layer 0.
    const { order, safeSource } = resolveRenderOrder(layersWith([1, 0, 'noobj', 'noobj']));
    // Both layers still render (every layer renders into its FBO).
    expect(order).toHaveLength(LAYER_COUNT);
    expect([...order].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
    // Neither can safely sample the other (cycle) → both matcap.
    expect(safeSource[0]).toBe(-1);
    expect(safeSource[1]).toBe(-1);
  });

  it('a 3-chain (2←1←0... i.e. 0 textures 1, 1 textures 2) orders the deepest first', () => {
    // dep: layer0→1, layer1→2 (layer 2 plain). Render order 2, 1, 0.
    const { order, safeSource } = resolveRenderOrder(layersWith([1, 2, 'noobj', 'noobj']));
    expect(order.indexOf(2)).toBeLessThan(order.indexOf(1));
    expect(order.indexOf(1)).toBeLessThan(order.indexOf(0));
    expect(safeSource[0]).toBe(1);
    expect(safeSource[1]).toBe(2);
  });

  it('keeps produced[] indexing by TRUE layer index (order is a permutation)', () => {
    // Even with a deep dependency, the order set is exactly {0,1,2,3} so a
    // caller writing produced[trueIndex] covers every layer once.
    const { order } = resolveRenderOrder(layersWith([3, 'noobj', 'noobj', 'noobj']));
    expect([...order].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
    expect(new Set(order).size).toBe(LAYER_COUNT);
  });

  it('a -2 (LAYER INPUT sentinel) surfaceSource does NOT register a sibling-layer dep', () => {
    // The sentinel is resolved by layerInputWanted (prev-frame OUT), NOT a
    // sibling-FBO texmap, so readSurfaceSource (negatives → -1) keeps safeSource -1.
    const layers = layersWith([LAYER_INPUT_SOURCE, 'noobj', 'noobj', 'noobj']);
    expect(readSurfaceSource(layers, 0)).toBe(-1);
    const { safeSource } = resolveRenderOrder(layers);
    expect(safeSource[0]).toBe(-1);
  });
});

// ---------------- LAYER INPUT (prev-frame OUT feedback tap) ----------------

/** A combine graph with a feedback-tap edge wired into src{i}.in0 (op1's output
 *  → src{i}). Uses validateConnect (which exempts source-in0 from cycle
 *  rejection) so the edge is the real shape the mutator pushes. */
function graphWithTap(i: number): ToyboxCombineGraph {
  const g = makeDefaultCombineGraph();
  const v = validateConnect(g, 'op1', `src${i}`, 'in0');
  expect(v.ok).toBe(true);
  g.edges.push(v.edge!);
  return g;
}

/** A 4-layer array where layer i is an OBJ whose surfaceSource is the sentinel. */
function objLayerInputAt(i: number): ToyboxLayer[] {
  const out: ToyboxLayer[] = [];
  for (let j = 0; j < LAYER_COUNT; j++) {
    if (j === i) {
      const material = makeDefaultObjMaterial('sphere');
      material.surfaceSource = LAYER_INPUT_SOURCE;
      out.push({ kind: 'obj', contentId: null, params: {}, material });
    } else {
      out.push({ kind: 'off', contentId: null, params: {} });
    }
  }
  return out;
}

describe('layerHasInputEdge — a wired SOURCE in0 tap', () => {
  it('false on the default graph (no tap wired)', () => {
    const g = makeDefaultCombineGraph();
    for (let i = 0; i < LAYER_COUNT; i++) expect(layerHasInputEdge(g, i)).toBe(false);
  });

  it('true for exactly the layer whose source has a wired in0 edge', () => {
    const g = graphWithTap(2);
    expect(layerHasInputEdge(g, 2)).toBe(true);
    expect(layerHasInputEdge(g, 0)).toBe(false);
    expect(layerHasInputEdge(g, 1)).toBe(false);
  });

  it('false for a non-graph / legacy combine', () => {
    expect(layerHasInputEdge({ steps: [] }, 0)).toBe(false);
    expect(layerHasInputEdge(undefined, 0)).toBe(false);
    expect(layerHasInputEdge(null, 0)).toBe(false);
  });
});

describe('layerInputWanted — sentinel selected AND a wired tap', () => {
  it('OBJ: true only when surfaceSource is the sentinel AND src.in0 is wired', () => {
    const layers = objLayerInputAt(0);
    // (a) sentinel + wired tap → wanted.
    expect(layerInputWanted(layers, graphWithTap(0), 0)).toBe(true);
    // (b) sentinel but NO wired tap → no-op (default graph).
    expect(layerInputWanted(layers, makeDefaultCombineGraph(), 0)).toBe(false);
  });

  it('OBJ: false when the param is MATCAP / a sibling index even with a wired tap', () => {
    const g = graphWithTap(0);
    const matcap = objLayerInputAt(0);
    matcap[0]!.material!.surfaceSource = -1;
    expect(layerInputWanted(matcap, g, 0)).toBe(false);
    const sibling = objLayerInputAt(0);
    sibling[0]!.material!.surfaceSource = 1;
    expect(layerInputWanted(sibling, g, 0)).toBe(false);
  });

  it('VIDEO: true only when videoSource is layerIn AND a wired tap', () => {
    const layers: ToyboxLayer[] = [
      { kind: 'video', contentId: null, params: {}, videoSource: 'layerIn' },
      { kind: 'off', contentId: null, params: {} },
      { kind: 'off', contentId: null, params: {} },
      { kind: 'off', contentId: null, params: {} },
    ];
    expect(layerInputWanted(layers, graphWithTap(0), 0)).toBe(true);
    expect(layerInputWanted(layers, makeDefaultCombineGraph(), 0)).toBe(false);
    // A different videoSource → not wanted even with the tap.
    layers[0] = { kind: 'video', contentId: null, params: {}, videoSource: 'file' };
    expect(layerInputWanted(layers, graphWithTap(0), 0)).toBe(false);
  });

  it('FRAG: true only when sceneInputSource is layer-input AND a wired tap', () => {
    const layers: ToyboxLayer[] = [
      { kind: 'frag', contentId: 'invert', params: {}, sceneInputSource: 'layer-input' },
      { kind: 'off', contentId: null, params: {} },
      { kind: 'off', contentId: null, params: {} },
      { kind: 'off', contentId: null, params: {} },
    ];
    expect(layerInputWanted(layers, graphWithTap(0), 0)).toBe(true);
    expect(layerInputWanted(layers, makeDefaultCombineGraph(), 0)).toBe(false);
    layers[0] = { kind: 'frag', contentId: 'invert', params: {}, sceneInputSource: 'below' };
    expect(layerInputWanted(layers, graphWithTap(0), 0)).toBe(false);
  });

  it('other layer kinds (gen/shader/image/off) are never wanted', () => {
    const g = graphWithTap(0);
    for (const kind of ['gen', 'shader', 'image', 'off'] as const) {
      const layers: ToyboxLayer[] = [
        { kind, contentId: null, params: {} },
        { kind: 'off', contentId: null, params: {} },
        { kind: 'off', contentId: null, params: {} },
        { kind: 'off', contentId: null, params: {} },
      ];
      expect(layerInputWanted(layers, g, 0)).toBe(false);
    }
  });
});
