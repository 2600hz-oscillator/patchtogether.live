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
  MAX_CUSTOM_SOURCE_BYTES,
  makeDefaultLayers,
  makeDefaultCombine,
  makeDefaultObjMaterial,
  customShaderKey,
  customObjKey,
  utf8ByteLength,
} from './toybox-content';
import { isShadertoySource } from './toybox-shadertoy';

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

describe('custom disk-loaded source keys (shader / OBJ)', () => {
  const GEN = '#version 300 es\nprecision highp float;\nin vec2 vUv;\nout vec4 outColor;\nvoid main(){ outColor = vec4(1.0,0.0,1.0,1.0); }';
  const ST = 'void mainImage(out vec4 o, in vec2 fc){ o = vec4(1.0); }';
  const OBJ = 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n';

  it('customShaderKey is prefixed + deterministic for identical source', () => {
    const k = customShaderKey(GEN);
    expect(k.startsWith('custom-shader:')).toBe(true);
    expect(customShaderKey(GEN)).toBe(k); // stable
  });

  it('customShaderKey differs for different source (cache slots do not collide)', () => {
    expect(customShaderKey(GEN)).not.toBe(customShaderKey(ST));
  });

  it('customObjKey is prefixed, deterministic, and disjoint from shader keys', () => {
    const k = customObjKey(OBJ);
    expect(k.startsWith('custom-obj:')).toBe(true);
    expect(customObjKey(OBJ)).toBe(k);
    // The prefixes guarantee a custom OBJ key never collides with a shader key
    // (or any manifest content/model id).
    expect(k.startsWith('custom-shader:')).toBe(false);
  });

  it('a custom GEN source is NOT detected as Shadertoy (plain void main)', () => {
    expect(isShadertoySource(GEN)).toBe(false);
  });

  it('a custom Shadertoy source (mainImage) IS detected as Shadertoy', () => {
    expect(isShadertoySource(ST)).toBe(true);
  });
});

describe('utf8ByteLength + MAX_CUSTOM_SOURCE_BYTES', () => {
  it('counts ASCII bytes 1:1', () => {
    expect(utf8ByteLength('abc')).toBe(3);
    expect(utf8ByteLength('')).toBe(0);
  });

  it('counts multi-byte UTF-8 correctly', () => {
    expect(utf8ByteLength('é')).toBe(2); // U+00E9 → 2 bytes
    expect(utf8ByteLength('好')).toBe(3); // CJK → 3 bytes
    expect(utf8ByteLength('𝄞')).toBe(4); // surrogate pair (musical symbol) → 4 bytes
  });

  it('exposes a 2MB sanity cap', () => {
    expect(MAX_CUSTOM_SOURCE_BYTES).toBe(2 * 1024 * 1024);
  });
});
