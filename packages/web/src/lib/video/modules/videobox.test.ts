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
    expect(videoboxDef.schemaVersion).toBe(1);
  });

  it('declares a single play_trigger gate input that routes through a synthetic param', () => {
    expect(videoboxDef.inputs).toHaveLength(1);
    const inp = videoboxDef.inputs[0]!;
    expect(inp.id).toBe('play_trigger');
    expect(inp.type).toBe('gate');
    // The cross-domain bridge sets the synthetic cv_<port> param so the
    // engine setParam path catches edges. Mirrors DOOM's CV-gate plumbing.
    expect(inp.paramTarget).toBe('cv_play_trigger');
  });

  it('declares one video output + stereo audio outputs', () => {
    const outs = videoboxDef.outputs.map((o) => ({ id: o.id, type: o.type }));
    expect(outs).toEqual([
      { id: 'video',   type: 'video' },
      { id: 'audio_l', type: 'audio' },
      { id: 'audio_r', type: 'audio' },
    ]);
  });

  it('exposes a gain user param + the cv_play_trigger edge-detector param', () => {
    const ids = videoboxDef.params.map((p) => p.id);
    expect(ids).toContain('gain');
    expect(ids).toContain('cv_play_trigger');

    const gain = videoboxDef.params.find((p) => p.id === 'gain')!;
    expect(gain.min).toBe(0);
    expect(gain.max).toBe(2);
    expect(gain.defaultValue).toBe(1);
    expect(gain.curve).toBe('linear');

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
