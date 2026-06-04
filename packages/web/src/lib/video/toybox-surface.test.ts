// packages/web/src/lib/video/toybox-surface.test.ts
//
// Unit tests for the PURE texmap helpers: readSurfaceSource (defensive
// normalisation of material.surfaceSource) + resolveRenderOrder (the per-frame
// dependency order + safe-source guard). The GL pass itself is VRT-only; these
// prove the ordering + cycle/self/out-of-range guards that keep the bind safe.

import { describe, it, expect } from 'vitest';
import { readSurfaceSource, resolveRenderOrder } from './toybox-surface';
import { LAYER_COUNT, makeDefaultObjMaterial, type ToyboxLayer } from './toybox-content';

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
});
