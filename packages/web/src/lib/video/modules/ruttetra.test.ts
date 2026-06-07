// packages/web/src/lib/video/modules/ruttetra.test.ts
//
// Unit tests for the AUTHENTIC forward-scatter Rutt-Etra scope (port of
// p10entrancer XYZ). Covers:
//   - the pure TS mirror of the GLSL `shapedRamp` (morph 0/0.333/0.666/1
//     + the radial branch);
//   - the line-list index buffer / grid generation (count + topology);
//   - param defaults / ranges;
//   - both modules register with the correct type ids;
//   - the persisted-`ruttetra`(v1) → `reshaper` load-time type remap.

import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { syncedStore, getYjsDoc } from '@syncedstore/core';
import {
  shapedRamp,
  buildRuttetraIndices,
  ruttetraDef,
  RUTTETRA_GRID,
} from './ruttetra';
import './index'; // register all video modules
import { getVideoModuleDef } from '$lib/video/module-registry';
import { makeEnvelope, loadEnvelopeIntoStore, type LivePatch } from '$lib/graph/persistence';
import type { ModuleNode, Edge } from '$lib/graph/types';

const fract = (t: number): number => t - Math.floor(t);

describe('ruttetra shapedRamp (TS mirror of XYZ.metal)', () => {
  const ts = [0, 0.1, 0.25, 0.5, 0.7, 0.999, 1.0, 1.5, 2.3, -0.25];

  it('morph 0 → linear fract(t) (uv ignored)', () => {
    for (const t of ts) {
      expect(shapedRamp(t, 0.2, 0.8, 0)).toBeCloseTo(fract(t), 6);
    }
  });

  it('morph 0.333 → triangle |2*fract(t)-1|', () => {
    for (const t of ts) {
      expect(shapedRamp(t, 0.2, 0.8, 0.333)).toBeCloseTo(Math.abs(2 * fract(t) - 1), 6);
    }
  });

  it('morph 0.666 → soft-fold (raised cosine)', () => {
    for (const t of ts) {
      const sf = 0.5 - 0.5 * Math.cos(2 * Math.PI * fract(t));
      expect(shapedRamp(t, 0.2, 0.8, 0.666)).toBeCloseTo(sf, 6);
    }
  });

  // The radial term itself (its own clamp, sampled directly via the
  // third-segment endpoint). NOTE: the verbatim XYZ.metal segment math
  // crossfades sf↔radial via (morph-0.666)*3, which at morph=1 reaches
  // 1.002 (the three segments are 0.333/0.333/0.334 wide but each ×3), so
  // morph=1 is NOT exactly the pure radial value — it's a hair past it.
  // We assert the verbatim blend so the mirror stays bit-faithful to the
  // shader rather than papering over that quirk.
  const radialTerm = (uvx: number, uvy: number): number => {
    const dx = uvx - 0.5, dy = uvy - 0.5;
    return Math.min(Math.max(Math.sqrt(dx * dx + dy * dy) * 1.41421356, 0), 1);
  };
  const sfTerm = (t: number): number => 0.5 - 0.5 * Math.cos(2 * Math.PI * fract(t));

  it('morph 1 → sf↔radial blend at the verbatim 1.002 endpoint (t/uv)', () => {
    const cases: Array<[number, number]> = [
      [0.5, 0.5],  // center radial 0
      [0.0, 0.0],  // corner radial 1
      [1.0, 1.0],  // opposite corner radial 1
      [0.5, 0.0],  // edge mid radial 0.5·√2
    ];
    for (const [uvx, uvy] of cases) {
      const t = 0.42;
      const sf = sfTerm(t);
      const radial = radialTerm(uvx, uvy);
      const expected = sf + (radial - sf) * ((1 - 0.666) * 3); // verbatim
      expect(shapedRamp(t, uvx, uvy, 1)).toBeCloseTo(expected, 6);
    }
    // The radial term at canonical points (sanity on the helper itself).
    expect(radialTerm(0.5, 0.5)).toBeCloseTo(0, 6);
    expect(radialTerm(0.0, 0.0)).toBeCloseTo(1, 5);
    expect(radialTerm(0.5, 0.0)).toBeCloseTo(0.70710678, 5);
  });

  it('crossfades continuously across the morph boundaries', () => {
    const t = 0.7;
    const lin = fract(t);
    const tri = Math.abs(2 * fract(t) - 1);
    // At the 0.333 seam the `< 0.333` guard is FALSE, so we enter the
    // second branch: mix(tri, sf, (0.333-0.333)*3) = tri exactly. The
    // first segment's right endpoint (lin→tri) thus meets the second
    // segment's left endpoint (tri) — continuous.
    expect(shapedRamp(t, 0, 0, 0.333)).toBeCloseTo(tri, 6);
    // midway through the first segment is a ~50/50 lin↔tri blend.
    expect(shapedRamp(t, 0, 0, 0.1665)).toBeCloseTo(lin + (tri - lin) * (0.1665 * 3), 6);
  });

  it('clamps morph below 0 / above 1', () => {
    const t = 0.3;
    // morph < 0 clamps to 0 → linear.
    expect(shapedRamp(t, 0, 0, -5)).toBeCloseTo(fract(t), 6);
    // morph > 1 clamps to 1 → the same sf↔radial endpoint as morph=1.
    const sf = sfTerm(t);
    const expectedCenter = sf + (0 - sf) * ((1 - 0.666) * 3);
    expect(shapedRamp(t, 0.5, 0.5, 5)).toBeCloseTo(expectedCenter, 6);
  });
});

describe('ruttetra index buffer / grid (port of XYZRenderer.swift)', () => {
  it('default grid is 320×180', () => {
    expect(RUTTETRA_GRID).toEqual({ cols: 320, rows: 180 });
  });

  it('index count === 2*(cols-1)*rows', () => {
    const idx = buildRuttetraIndices(320, 180);
    expect(idx.length).toBe(2 * (320 - 1) * 180);
    expect(idx).toBeInstanceOf(Uint32Array);
  });

  it('connects adjacent columns within each row (line-list topology)', () => {
    const cols = 5;
    const rows = 3;
    const idx = buildRuttetraIndices(cols, rows);
    expect(idx.length).toBe(2 * (cols - 1) * rows);
    // First row, first segment: (0,1). Second segment: (1,2). ...
    expect(Array.from(idx.slice(0, 8))).toEqual([0, 1, 1, 2, 2, 3, 3, 4]);
    // Second row starts at grid id `cols` (=5): segment (5,6).
    const rowStride = 2 * (cols - 1);
    expect(idx[rowStride]).toBe(cols);
    expect(idx[rowStride + 1]).toBe(cols + 1);
    // Every index stays within its own row (never bridges rows): for each
    // line segment the two endpoints share the same row.
    for (let i = 0; i < idx.length; i += 2) {
      const a = idx[i]!;
      const b = idx[i + 1]!;
      expect(Math.floor(a / cols)).toBe(Math.floor(b / cols));
      expect(b - a).toBe(1); // adjacent columns
    }
  });
});

describe('ruttetra param set (matches XYZState.swift defaults)', () => {
  it('exposes the 12 params with exact ids/ranges/defaults', () => {
    const ids = ruttetraDef.params.map((p) => p.id);
    expect(ids).toEqual([
      'xShape', 'yShape', 'xDisp', 'yDisp', 'intensity',
      'tintR', 'tintG', 'tintB', 'xFreq', 'yFreq', 'xPhase', 'yPhase',
    ]);
    const by = Object.fromEntries(ruttetraDef.params.map((p) => [p.id, p]));
    expect(by.xShape).toMatchObject({ min: 0, max: 1, defaultValue: 0 });
    expect(by.yShape).toMatchObject({ min: 0, max: 1, defaultValue: 0 });
    expect(by.xDisp).toMatchObject({ min: -1, max: 1, defaultValue: 0 });
    expect(by.yDisp).toMatchObject({ min: -1, max: 1, defaultValue: -0.3 });
    expect(by.intensity).toMatchObject({ min: 0, max: 2, defaultValue: 1.5 });
    expect(by.tintR).toMatchObject({ min: 0, max: 1, defaultValue: 1 });
    expect(by.tintG).toMatchObject({ min: 0, max: 1, defaultValue: 1 });
    expect(by.tintB).toMatchObject({ min: 0, max: 1, defaultValue: 1 });
    expect(by.xFreq).toMatchObject({ min: 0.25, max: 8, defaultValue: 1 });
    expect(by.yFreq).toMatchObject({ min: 0.25, max: 8, defaultValue: 1 });
    expect(by.xPhase).toMatchObject({ min: 0, max: 1, defaultValue: 0 });
    expect(by.yPhase).toMatchObject({ min: 0, max: 1, defaultValue: 0 });
    for (const p of ruttetraDef.params) expect(p.curve).toBe('linear');
  });

  it('has ONE z video input + 7 cv inputs (port id == param id)', () => {
    const z = ruttetraDef.inputs.find((p) => p.id === 'z');
    expect(z?.type).toBe('video');
    const cv = ruttetraDef.inputs.filter((p) => p.type === 'cv');
    expect(cv.map((p) => p.id).sort()).toEqual(
      ['intensity', 'xDisp', 'xFreq', 'xShape', 'yDisp', 'yFreq', 'yShape'],
    );
    for (const port of cv) expect(port.paramTarget).toBe(port.id);
    // No x/y coordinate-field inputs (that's RESHAPER's shape).
    expect(ruttetraDef.inputs.some((p) => p.id === 'x' && p.type === 'mono-video')).toBe(false);
    expect(ruttetraDef.inputs.some((p) => p.id === 'y' && p.type === 'mono-video')).toBe(false);
  });
});

describe('both modules register with the correct type ids', () => {
  it('reshaper = coord-remap (schemaVersion 1)', () => {
    const def = getVideoModuleDef('reshaper');
    expect(def?.label).toBe('reshaper');
    expect(def?.schemaVersion).toBe(1);
    // RESHAPER keeps the X/Y mono-video coordinate-field inputs.
    expect(def?.inputs.find((p) => p.id === 'x')?.type).toBe('mono-video');
  });

  it('ruttetra = authentic scope (schemaVersion 2)', () => {
    const def = getVideoModuleDef('ruttetra');
    expect(def?.label).toBe('ruttetra');
    expect(def?.schemaVersion).toBe(2);
    expect(def?.inputs.find((p) => p.id === 'z')?.type).toBe('video');
  });
});

describe('persisted ruttetra(v1) → reshaper load-time remap', () => {
  function liveStore(): { ydoc: Y.Doc; patch: LivePatch } {
    const store = syncedStore<{ nodes: Record<string, ModuleNode>; edges: Record<string, Edge> }>({ nodes: {}, edges: {} });
    return { ydoc: getYjsDoc(store), patch: store as unknown as LivePatch };
  }

  // Hand-build an envelope whose moduleSchemas pretends ruttetra was saved
  // at schemaVersion 1 (the OLD coord-remap), containing one ruttetra node.
  function oldRuttetraEnvelope(savedVersion: number) {
    const store = syncedStore<{ nodes: Record<string, ModuleNode>; edges: Record<string, Edge> }>({ nodes: {}, edges: {} });
    const ydoc = getYjsDoc(store);
    ydoc.transact(() => {
      (store.nodes as Record<string, ModuleNode>)['n1'] = {
        id: 'n1',
        type: 'ruttetra',
        domain: 'video',
        position: { x: 0, y: 0 },
        params: { xDisp: 0.4 },
        data: {},
      } as ModuleNode;
    });
    const env = makeEnvelope(ydoc);
    env.moduleSchemas = { ...env.moduleSchemas, ruttetra: savedVersion };
    return env;
  }

  it('remaps a ruttetra node saved at v1 to reshaper (preserves the look)', () => {
    const { ydoc, patch } = liveStore();
    const res = loadEnvelopeIntoStore(oldRuttetraEnvelope(1), ydoc, patch);
    expect(res.nodesLoaded).toBe(1);
    expect(patch.nodes['n1']?.type).toBe('reshaper');
    // Params carry over so the displaced look is preserved.
    expect(patch.nodes['n1']?.params.xDisp).toBe(0.4);
  });

  it('leaves a ruttetra node saved at v2 as the new RUTTETRA', () => {
    const { ydoc, patch } = liveStore();
    const res = loadEnvelopeIntoStore(oldRuttetraEnvelope(2), ydoc, patch);
    expect(res.nodesLoaded).toBe(1);
    expect(patch.nodes['n1']?.type).toBe('ruttetra');
  });
});
