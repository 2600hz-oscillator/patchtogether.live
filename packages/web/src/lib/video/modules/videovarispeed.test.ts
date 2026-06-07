// packages/web/src/lib/video/modules/videovarispeed.test.ts
//
// Locks down VIDEOVARISPEED's module-def shape. Mirrors videobox.test.ts —
// no factory/runtime execution (those need WebGL + a real <video> element;
// covered in e2e).

import { describe, expect, it } from 'vitest';
import { videoVarispeedDef } from './videovarispeed';
import { getVideoModuleDef, listVideoModuleDefs } from '$lib/video/module-registry';
// Side-effect import auto-registers every video def (including ours).
import '$lib/video/modules';

describe('videoVarispeedDef — module def shape', () => {
  it('registers under type "videovarispeed" with the right metadata', () => {
    expect(videoVarispeedDef.type).toBe('videovarispeed');
    expect(videoVarispeedDef.domain).toBe('video');
    expect(videoVarispeedDef.label).toBe('videovarispeed');
    expect(videoVarispeedDef.category).toBe('sources');
    expect(videoVarispeedDef.schemaVersion).toBe(1);
  });

  it('declares the transport gate inputs (start/pause/reset/loop) as rising-edge gates', () => {
    const gateIds = ['cv_start', 'cv_pause', 'cv_reset', 'cv_loop_toggle'];
    for (const gid of gateIds) {
      const inp = videoVarispeedDef.inputs.find((p) => p.id === gid)!;
      expect(inp, `${gid} present`).toBeDefined();
      expect(inp.type, `${gid} is a gate`).toBe('gate');
      expect(inp.paramTarget, `${gid} paramTarget`).toBe(gid);
    }
  });

  it('declares speed/start/end CV inputs (bipolar) with matching paramTargets', () => {
    for (const cid of ['speedCv', 'startCv', 'endCv']) {
      const inp = videoVarispeedDef.inputs.find((p) => p.id === cid)!;
      expect(inp, `${cid} present`).toBeDefined();
      expect(inp.type, `${cid} is cv`).toBe('cv');
      expect(inp.paramTarget, `${cid} paramTarget`).toBe(cid);
    }
  });

  it('every CV/gate input has a paramTarget that exists in params', () => {
    const paramIds = new Set(videoVarispeedDef.params.map((p) => p.id));
    for (const port of videoVarispeedDef.inputs) {
      if (port.type === 'cv' || port.type === 'gate') {
        expect(port.paramTarget, `${port.id} has paramTarget`).toBeDefined();
        expect(paramIds.has(port.paramTarget!), `${port.id} → ${port.paramTarget} exists`).toBe(true);
      }
    }
  });

  it('declares one video output + stereo audio outputs', () => {
    const outs = videoVarispeedDef.outputs.map((o) => ({ id: o.id, type: o.type }));
    expect(outs).toEqual([
      { id: 'video',   type: 'video' },
      { id: 'audio_l', type: 'audio' },
      { id: 'audio_r', type: 'audio' },
    ]);
  });

  it('exposes transport user params with the right ranges/defaults', () => {
    // Speed knob: normalized 0..1, default 0.5 (= +1× per the piecewise map).
    const speed = videoVarispeedDef.params.find((p) => p.id === 'speed')!;
    expect(speed.min).toBe(0);
    expect(speed.max).toBe(1);
    expect(speed.defaultValue).toBe(0.5);

    // START default 0 (beginning), END default 1 (full duration).
    const start = videoVarispeedDef.params.find((p) => p.id === 'start')!;
    expect(start.defaultValue).toBe(0);
    const end = videoVarispeedDef.params.find((p) => p.id === 'end')!;
    expect(end.defaultValue).toBe(1);

    // Bipolar CV params.
    for (const cid of ['speedCv', 'startCv', 'endCv']) {
      const cv = videoVarispeedDef.params.find((p) => p.id === cid)!;
      expect(cv.min, `${cid} min`).toBe(-1);
      expect(cv.max, `${cid} max`).toBe(1);
      expect(cv.curve).toBe('linear');
    }
  });

  it('every default value is within the declared min/max range', () => {
    for (const p of videoVarispeedDef.params) {
      expect(p.defaultValue, `${p.id} ≥ min`).toBeGreaterThanOrEqual(p.min);
      expect(p.defaultValue, `${p.id} ≤ max`).toBeLessThanOrEqual(p.max);
    }
  });

  it('appears in the global video registry list (auto-registered via barrel import)', () => {
    const types = listVideoModuleDefs().map((d) => d.type);
    expect(types).toContain('videovarispeed');
    expect(getVideoModuleDef('videovarispeed')).toBe(videoVarispeedDef);
  });

  it('has a factory function (not invoked under node — see e2e)', () => {
    expect(typeof videoVarispeedDef.factory).toBe('function');
  });
});
