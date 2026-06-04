// packages/web/src/lib/video/toybox-content.test.ts
//
// Pure-helper coverage for the TOYBOX content/model registry (Phase 3). The
// manifest-fetching paths are exercised by the e2e/VRT specs against the real
// static manifest; here we lock the defaulting helpers + the layer/combine
// shapes that persistence and the factory depend on.
import { describe, it, expect } from 'vitest';
import {
  LAYER_COUNT,
  MATCAP_STYLES,
  DEFAULT_MODEL_ID,
  DEFAULT_CONTENT_ID,
  makeDefaultLayers,
  makeDefaultCombine,
  makeDefaultObjMaterial,
} from './toybox-content';

describe('makeDefaultLayers', () => {
  const layers = makeDefaultLayers();
  it('produces LAYER_COUNT layers', () => {
    expect(layers).toHaveLength(LAYER_COUNT);
  });
  it('seeds layer 0 with the default GEN content', () => {
    expect(layers[0]!.kind).toBe('gen');
    expect(layers[0]!.contentId).toBe(DEFAULT_CONTENT_ID);
  });
  it('leaves layers 1..3 off + empty', () => {
    for (let i = 1; i < LAYER_COUNT; i++) {
      expect(layers[i]!.kind).toBe('off');
      expect(layers[i]!.contentId).toBeNull();
    }
  });
});

describe('makeDefaultCombine', () => {
  const c = makeDefaultCombine();
  it('has one step per non-base layer', () => {
    expect(c.steps).toHaveLength(LAYER_COUNT - 1);
  });
  it('targets layers 1..3 with fade at amount 0 (base passes through)', () => {
    c.steps.forEach((s, idx) => {
      expect(s.layer).toBe(idx + 1);
      expect(s.op).toBe('fade');
      expect(s.amount).toBe(0);
    });
  });
});

describe('makeDefaultObjMaterial', () => {
  it('defaults to the default model + a valid matcap index', () => {
    const m = makeDefaultObjMaterial();
    expect(m.modelId).toBe(DEFAULT_MODEL_ID);
    expect(m.matcap).toBeGreaterThanOrEqual(0);
    expect(m.matcap).toBeLessThan(MATCAP_STYLES);
  });
  it('honours an explicit model id', () => {
    expect(makeDefaultObjMaterial('teapot').modelId).toBe('teapot');
  });
  it('has neutral tint + a sensible auto-frame scale', () => {
    const m = makeDefaultObjMaterial();
    expect([m.tintR, m.tintG, m.tintB]).toEqual([1, 1, 1]);
    expect(m.scale).toBeGreaterThan(0);
  });
  it('carries all CV-ready numeric transform fields', () => {
    const m = makeDefaultObjMaterial();
    for (const k of ['rotX', 'rotY', 'rotZ', 'scale', 'spin'] as const) {
      expect(typeof m[k]).toBe('number');
    }
  });
});

describe('MATCAP_STYLES', () => {
  it('exposes at least 3 procedural matcap styles', () => {
    expect(MATCAP_STYLES).toBeGreaterThanOrEqual(3);
  });
});
