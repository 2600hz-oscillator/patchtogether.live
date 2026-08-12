// packages/web/src/lib/video/modules/warrensvisions.test.ts
//
// Def-shape gates. The algorithm is covered by warrensvisions-core.test.ts;
// what is checked here is the CONTRACT — that the def, the core's clamps and
// the card cannot disagree.

import { describe, it, expect } from 'vitest';
import { warrensvisionsDef, WARRENSVISIONS_RANGES } from './warrensvisions';
import {
  WV_MAX_COMPONENTS,
  WV_COMPONENTS_MIN,
  WV_FLOOR_MIN_DB,
  WV_FLOOR_MAX_DB,
  WV_SLICE_MIN_FRAMES,
  WV_SLICE_MAX_FRAMES,
  WV_CENTER_MIN_CENTS,
  WV_CENTER_MAX_CENTS,
} from '$lib/video/warrensvisions-core';

describe('warrensvisions def', () => {
  it('is a video module in the palette', () => {
    expect(warrensvisionsDef.type).toBe('warrensvisions');
    expect(warrensvisionsDef.domain).toBe('video');
    expect(warrensvisionsDef.palette).toEqual({ top: 'Video modules', sub: 'Processors' });
    expect(typeof warrensvisionsDef.factory).toBe('function');
  });

  it('has a lowercase label', () => {
    expect(warrensvisionsDef.label).toBe(warrensvisionsDef.label.toLowerCase());
  });

  it('caps itself at ONE instance, visibly', () => {
    // The palette drops any def at its cap, so this is the whole mechanism —
    // the module disappears from the palette rather than spawning a second
    // instance that silently halves the frame rate.
    expect(warrensvisionsDef.maxInstances).toBe(1);
  });

  it('renders on the MAIN thread', () => {
    // The worker renderer's getInputTexture() returns null unconditionally and
    // it exposes no createFloatFbo, so a module that reads an upstream video
    // texture cannot run there. Absent = 'main'.
    expect(warrensvisionsDef.renderLocus ?? 'main').toBe('main');
  });

  it('takes one video input and emits one video output', () => {
    expect(warrensvisionsDef.inputs.find((p) => p.id === 'video_in')?.type).toBe('video');
    expect(warrensvisionsDef.outputs).toHaveLength(1);
    expect(warrensvisionsDef.outputs[0]).toMatchObject({ id: 'out', type: 'video' });
  });

  it('declares FREEZE as a level gate, not a trigger', () => {
    const gate = warrensvisionsDef.inputs.find((p) => p.id === 'gate');
    expect(gate?.type).toBe('gate');
    // Level-sensitive by design: a held gate holds the freeze. Converting it
    // to edge-only would make FREEZE a latch, which is a different control.
    expect(gate?.edge).toBe('gate');
    expect(gate?.paramTarget).toBe('engineFreeze');
  });

  it('gives every CV input a cvScale and a real param target', () => {
    const paramIds = new Set(warrensvisionsDef.params.map((p) => p.id));
    const cvs = warrensvisionsDef.inputs.filter((p) => p.type === 'cv');
    expect(cvs.length).toBeGreaterThan(0);
    for (const p of cvs) {
      expect(p.paramTarget, `${p.id} targets a param`).toBeTruthy();
      expect(paramIds.has(p.paramTarget!), `${p.id} → ${p.paramTarget} exists`).toBe(true);
      // Without cvScale the bridge writes the RAW sample, which is gate
      // semantics and makes a continuous knob input read dead.
      expect(p.cvScale, `${p.id} declares a cvScale`).toBeTruthy();
    }
  });

  it('every param range comes from WARRENSVISIONS_RANGES, and every range is used', () => {
    const declared = new Map(warrensvisionsDef.params.map((p) => [p.id, p]));
    for (const [id, r] of Object.entries(WARRENSVISIONS_RANGES)) {
      const p = declared.get(id);
      expect(p, `${id} is a declared param`).toBeTruthy();
      expect({ min: p!.min, max: p!.max, defaultValue: p!.defaultValue }).toEqual(r);
    }
    // …and nothing declares a range outside the table.
    expect(warrensvisionsDef.params.map((p) => p.id).sort()).toEqual(
      Object.keys(WARRENSVISIONS_RANGES).sort(),
    );
  });

  it('the declared ranges are the CORE\'s clamps, not a second copy of them', () => {
    // The one that matters: a def that declared a wider range than the engine
    // accepts would give the knob dead travel, which is the backdraft defect.
    const r = WARRENSVISIONS_RANGES;
    expect(r.visionsComponents.min).toBe(WV_COMPONENTS_MIN);
    expect(r.visionsComponents.max).toBe(WV_MAX_COMPONENTS);
    expect(r.visionsFloor.min).toBe(WV_FLOOR_MIN_DB);
    expect(r.visionsFloor.max).toBe(WV_FLOOR_MAX_DB);
    expect(r.visionsSlice.min).toBe(WV_SLICE_MIN_FRAMES);
    expect(r.visionsSlice.max).toBe(WV_SLICE_MAX_FRAMES);
    expect(r.visionsCenter.min).toBe(WV_CENTER_MIN_CENTS);
    expect(r.visionsCenter.max).toBe(WV_CENTER_MAX_CENTS);
  });

  it('every default sits inside its own range', () => {
    for (const p of warrensvisionsDef.params) {
      expect(p.defaultValue, `${p.id} default >= min`).toBeGreaterThanOrEqual(p.min);
      expect(p.defaultValue, `${p.id} default <= max`).toBeLessThanOrEqual(p.max);
    }
  });

  it('defaults to a RECOGNISABLE reconstruction', () => {
    // COHERENCE 1 and MIX 1: the module should demonstrate what it does the
    // moment it is patched, and the abstract end is where the user travels to.
    expect(WARRENSVISIONS_RANGES.visionsCoherence.defaultValue).toBe(1);
    expect(WARRENSVISIONS_RANGES.visionsMix.defaultValue).toBe(1);
    expect(WARRENSVISIONS_RANGES.engineFreeze.defaultValue).toBe(0);
  });

  it('documents every port and every control', () => {
    const docs = warrensvisionsDef.docs;
    expect(docs?.explanation?.length ?? 0).toBeGreaterThan(400);
    for (const p of warrensvisionsDef.inputs) {
      expect(docs?.inputs?.[p.id], `docs.inputs.${p.id}`).toBeTruthy();
    }
    for (const p of warrensvisionsDef.outputs) {
      expect(docs?.outputs?.[p.id], `docs.outputs.${p.id}`).toBeTruthy();
    }
    for (const p of warrensvisionsDef.params) {
      expect(docs?.controls?.[p.id], `docs.controls.${p.id}`).toBeTruthy();
    }
  });
});
