// packages/web/src/lib/video/modules/sourcery.test.ts
//
// SOURCERY module-def SHAPE test (ports / params / CV targets / lowercase
// label). The pure algorithm is covered exhaustively by
// $lib/video/sourcery-core.test.ts; the GL factory's draw() needs a WebGL2
// context (jsdom has none) and is covered by the e2e spec + the auto-enrolled
// per-module-per-port / VRT sweeps.

import { describe, it, expect } from 'vitest';
import { sourceryDef } from './sourcery';
import { SOURCERY_PROC_W, SOURCERY_PROC_H, SOURCERY_MAX_REGIONS } from '$lib/video/sourcery-core';

describe('sourceryDef — module shape', () => {
  it('is a video-domain module called SOURCERY with a lowercase label', () => {
    expect(sourceryDef.type).toBe('sourcery');
    expect(sourceryDef.domain).toBe('video');
    expect(sourceryDef.label).toBe('sourcery');
    expect(sourceryDef.label).toBe(sourceryDef.label.toLowerCase());
    expect(sourceryDef.schemaVersion).toBe(1);
  });

  it('declares exactly two video inputs (a = top, b = bottom)', () => {
    const videoInputs = sourceryDef.inputs.filter((p) => p.type === 'video');
    expect(videoInputs.map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('declares a single video output (out)', () => {
    expect(sourceryDef.outputs).toHaveLength(1);
    expect(sourceryDef.outputs[0]!.id).toBe('out');
    expect(sourceryDef.outputs[0]!.type).toBe('video');
  });

  it('declares the 4 controls: thresholdA / thresholdB / colorSkew / rotate', () => {
    const ids = sourceryDef.params.map((p) => p.id).sort();
    expect(ids).toEqual(['colorSkew', 'rotate', 'thresholdA', 'thresholdB']);
  });

  it('threshold params span 0..1 (default 0.2); skew + rotate default 0.5 (bipolar center)', () => {
    const byId = (id: string) => sourceryDef.params.find((p) => p.id === id)!;
    for (const id of ['thresholdA', 'thresholdB'] as const) {
      const p = byId(id);
      expect(p.min).toBe(0);
      expect(p.max).toBe(1);
      expect(p.defaultValue).toBe(0.2);
      expect(p.curve).toBe('linear');
    }
    for (const id of ['colorSkew', 'rotate'] as const) {
      const p = byId(id);
      expect(p.min).toBe(0);
      expect(p.max).toBe(1);
      expect(p.defaultValue).toBe(0.5);
      expect(p.curve).toBe('linear');
    }
  });

  it('declares a CV input mirroring every modulatable param (port id == param id)', () => {
    const cvInputs = sourceryDef.inputs.filter((p) => p.type === 'cv');
    expect(cvInputs.map((p) => p.id).sort()).toEqual(['colorSkew', 'rotate', 'thresholdA', 'thresholdB']);
    for (const port of cvInputs) {
      expect(port.paramTarget, `cv input ${port.id} paramTarget`).toBe(port.id);
      expect(port.cvScale?.mode).toBe('linear');
    }
  });

  it('is categorised as a video effect/processor', () => {
    expect(sourceryDef.category).toBe('effects');
    expect(sourceryDef.palette).toEqual({ top: 'Video modules', sub: 'Processors' });
  });

  it('exports the processing-grid constants the factory + fill shader use', () => {
    expect(SOURCERY_PROC_W).toBe(128);
    expect(SOURCERY_PROC_H).toBe(96);
    expect(SOURCERY_MAX_REGIONS).toBe(128);
  });

  it('ships co-located living-docs for every port + control (STRICT_DOCS bar)', () => {
    const docs = sourceryDef.docs!;
    expect((docs.explanation ?? '').length).toBeGreaterThan(200);
    for (const p of [...sourceryDef.inputs, ...sourceryDef.outputs]) {
      expect(docs.inputs?.[p.id] ?? docs.outputs?.[p.id], `docs for port ${p.id}`).toBeTruthy();
    }
    for (const p of sourceryDef.params) {
      expect(docs.controls?.[p.id], `docs for control ${p.id}`).toBeTruthy();
    }
  });
});
