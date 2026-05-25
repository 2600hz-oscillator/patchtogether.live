// packages/web/src/lib/video/modules/videobox.test.ts
//
// Locks down VIDEOBOX's module-def shape. Mirrors doom.test.ts —
// no factory/runtime execution (those need WebGL + a real <video>
// element; covered in e2e).

import { describe, expect, it } from 'vitest';
import { videoboxDef } from './videobox';
import { getVideoModuleDef, listVideoModuleDefs } from '$lib/video/module-registry';
// Side-effect import auto-registers every video def (including ours).
import '$lib/video/modules';

describe('videoboxDef — module def shape', () => {
  it('registers under type "videobox" with the right metadata', () => {
    expect(videoboxDef.type).toBe('videobox');
    expect(videoboxDef.domain).toBe('video');
    expect(videoboxDef.label).toBe('VIDEOBOX');
    expect(videoboxDef.category).toBe('sources');
    expect(videoboxDef.schemaVersion).toBe(2);
    expect(typeof videoboxDef.migrate).toBe('function');
  });

  it('keeps the legacy play_trigger gate (no rename → no broken patches)', () => {
    const inp = videoboxDef.inputs.find((p) => p.id === 'play_trigger')!;
    expect(inp).toBeDefined();
    expect(inp.type).toBe('gate');
    expect(inp.paramTarget).toBe('cv_play_trigger');
  });

  it('declares the new transport gate inputs (start/pause/reset/loop) as rising-edge gates', () => {
    const gateIds = ['cv_start', 'cv_pause', 'cv_reset', 'cv_loop_toggle'];
    for (const gid of gateIds) {
      const inp = videoboxDef.inputs.find((p) => p.id === gid)!;
      expect(inp, `${gid} present`).toBeDefined();
      expect(inp.type, `${gid} is a gate`).toBe('gate');
      // port id == paramTarget per the PR #264 convention.
      expect(inp.paramTarget, `${gid} paramTarget`).toBe(gid);
    }
  });

  it('declares speed/start/end CV inputs (bipolar) with matching paramTargets', () => {
    for (const cid of ['speedCv', 'startCv', 'endCv']) {
      const inp = videoboxDef.inputs.find((p) => p.id === cid)!;
      expect(inp, `${cid} present`).toBeDefined();
      expect(inp.type, `${cid} is cv`).toBe('cv');
      expect(inp.paramTarget, `${cid} paramTarget`).toBe(cid);
    }
  });

  it('every CV/gate input has a paramTarget that exists in params', () => {
    const paramIds = new Set(videoboxDef.params.map((p) => p.id));
    for (const port of videoboxDef.inputs) {
      if (port.type === 'cv' || port.type === 'gate') {
        expect(port.paramTarget, `${port.id} has paramTarget`).toBeDefined();
        expect(paramIds.has(port.paramTarget!), `${port.id} → ${port.paramTarget} exists`).toBe(true);
      }
    }
  });

  it('declares one video output + stereo audio outputs', () => {
    const outs = videoboxDef.outputs.map((o) => ({ id: o.id, type: o.type }));
    expect(outs).toEqual([
      { id: 'video',   type: 'video' },
      { id: 'audio_l', type: 'audio' },
      { id: 'audio_r', type: 'audio' },
    ]);
  });

  it('exposes gain + transport user params with the right ranges/defaults', () => {
    const ids = videoboxDef.params.map((p) => p.id);
    expect(ids).toContain('gain');
    expect(ids).toContain('cv_play_trigger');

    const gain = videoboxDef.params.find((p) => p.id === 'gain')!;
    expect(gain.min).toBe(0);
    expect(gain.max).toBe(2);
    expect(gain.defaultValue).toBe(1);
    expect(gain.curve).toBe('linear');

    // Speed knob: normalized 0..1, default 0.5 (= +1× per the piecewise map).
    const speed = videoboxDef.params.find((p) => p.id === 'speed')!;
    expect(speed.min).toBe(0);
    expect(speed.max).toBe(1);
    expect(speed.defaultValue).toBe(0.5);

    // START default 0 (beginning), END default 1 (full duration).
    const start = videoboxDef.params.find((p) => p.id === 'start')!;
    expect(start.min).toBe(0);
    expect(start.max).toBe(1);
    expect(start.defaultValue).toBe(0);
    const end = videoboxDef.params.find((p) => p.id === 'end')!;
    expect(end.min).toBe(0);
    expect(end.max).toBe(1);
    expect(end.defaultValue).toBe(1);

    const cv = videoboxDef.params.find((p) => p.id === 'cv_play_trigger')!;
    expect(cv.min).toBe(0);
    expect(cv.max).toBe(1);
    expect(cv.curve).toBe('linear');
  });

  it('every default value is within the declared min/max range', () => {
    for (const p of videoboxDef.params) {
      expect(p.defaultValue, `${p.id} ≥ min`).toBeGreaterThanOrEqual(p.min);
      expect(p.defaultValue, `${p.id} ≤ max`).toBeLessThanOrEqual(p.max);
    }
  });

  it('appears in the global video registry list (auto-registered via barrel import)', () => {
    const types = listVideoModuleDefs().map((d) => d.type);
    expect(types).toContain('videobox');
    const looked = getVideoModuleDef('videobox');
    expect(looked).toBe(videoboxDef);
  });

  it('has a factory function (not invoked under node — see e2e)', () => {
    expect(typeof videoboxDef.factory).toBe('function');
  });
});
