// packages/web/src/lib/video/modules/loopback.test.ts
//
// Unit-level checks for the LOOPBACK module def. Vitest runs under node (no
// WebGL2), so it verifies the def SHAPE — registration, I/O surface (zero
// inputs, one video output), params + ranges, guardrails — while the GL-bound
// factory + getDisplayMedia path is covered by e2e/tests/loopback.spec.ts.

import { describe, expect, it } from 'vitest';
import { getVideoModuleDef, listVideoModuleDefs } from '$lib/video/module-registry';
// Side-effect import auto-registers the video defs (incl. loopback).
import '$lib/video/modules';

describe('LOOPBACK — module def shape', () => {
  it('is registered under type "loopback" with domain "video"', () => {
    const def = getVideoModuleDef('loopback');
    expect(def).toBeDefined();
    if (!def) return;
    expect(def.domain).toBe('video');
    expect(def.label).toBe('loopback');
    expect(def.category).toBe('sources');
  });

  it('has ZERO inputs (a pure source)', () => {
    const def = getVideoModuleDef('loopback')!;
    expect(def.inputs).toHaveLength(0);
  });

  it('output surface: a single video output "out"', () => {
    const def = getVideoModuleDef('loopback')!;
    expect(def.outputs).toHaveLength(1);
    const out = def.outputs.find((p) => p.id === 'out');
    expect(out?.type).toBe('video');
  });

  it('declares the documented params (gain + crop) with documented ranges', () => {
    const def = getVideoModuleDef('loopback')!;
    const ids = def.params.map((p) => p.id).sort();
    expect(ids).toEqual(['crop', 'gain']);

    const gain = def.params.find((p) => p.id === 'gain')!;
    expect(gain.min).toBe(0);
    expect(gain.max).toBe(2);
    expect(gain.defaultValue).toBe(1);
    expect(gain.curve).toBe('linear');

    const crop = def.params.find((p) => p.id === 'crop')!;
    expect(crop.curve).toBe('discrete');
    // Crop-to-viewport ON by default — "just what I see".
    expect(crop.defaultValue).toBe(1);
    expect(crop.min).toBe(0);
    expect(crop.max).toBe(1);
  });

  it('labels are lowercase (card CSS uppercases for display)', () => {
    const def = getVideoModuleDef('loopback')!;
    expect(def.label).toBe(def.label.toLowerCase());
  });

  it('caps simultaneous instances (one capture per tab is the sane default)', () => {
    const def = getVideoModuleDef('loopback')!;
    expect(def.maxInstances).toBe(2);
  });

  it('every default value is within the declared min/max range', () => {
    const def = getVideoModuleDef('loopback')!;
    for (const p of def.params) {
      expect(p.defaultValue, `${p.id} defaultValue >= min`).toBeGreaterThanOrEqual(p.min);
      expect(p.defaultValue, `${p.id} defaultValue <= max`).toBeLessThanOrEqual(p.max);
    }
  });

  it('appears in the global video registry list (auto-registered)', () => {
    const types = listVideoModuleDefs().map((d) => d.type);
    expect(types).toContain('loopback');
  });

  it('has a factory function (not invoked under node — see e2e)', () => {
    const def = getVideoModuleDef('loopback')!;
    expect(typeof def.factory).toBe('function');
  });

  it('output is type "video" so downstream RECORDERBOX/OUTPUT accept it directly', () => {
    const def = getVideoModuleDef('loopback')!;
    expect(def.outputs[0]?.type).toBe('video');
  });
});
