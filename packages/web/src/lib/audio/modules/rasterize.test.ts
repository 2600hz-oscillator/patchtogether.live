// packages/web/src/lib/audio/modules/rasterize.test.ts
//
// Unit test for RASTERIZE's def shape — the cross-domain video bridge +
// CV bridge + io-spec-consistency harness all depend on these invariants.
// The factory needs an AudioContext (AnalyserNode/GainNode), so the
// per-frame painting math is covered separately + deterministically in
// rasterize-map.test.ts; here we pin the static def shape.

import { describe, expect, it } from 'vitest';
import { rasterizeDef } from './rasterize';
import { VIDEO_RES } from '$lib/video/engine';

describe('RASTERIZE module def shape', () => {
  it('exposes the four raster knobs with sane ranges', () => {
    const byId = Object.fromEntries(rasterizeDef.params.map((p) => [p.id, p]));
    expect(Object.keys(byId).sort()).toEqual(['cursor', 'gain', 'samplesPerFrame', 'wrap']);
    // Default samples/frame ≈ 48k/60fps so ~1.25 scanlines/frame at 640px.
    expect(byId.samplesPerFrame!.defaultValue).toBe(800);
    // Scan cursor spans the whole engine-res frame (VIDEO_RES = 1024×768).
    expect(byId.cursor!.max).toBe(VIDEO_RES.width * VIDEO_RES.height);
    // Wrap is the discrete 0/1 mode knob.
    expect(byId.wrap!.curve).toBe('discrete');
    expect(byId.wrap!.min).toBe(0);
    expect(byId.wrap!.max).toBe(1);
  });

});
