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
  it('is an audio-domain utility', () => {
    expect(rasterizeDef.type).toBe('rasterize');
    expect(rasterizeDef.domain).toBe('audio');
    expect(rasterizeDef.category).toBe('utilities');
  });

  it('declares the mono-video output port (the audio→video bridge seam)', () => {
    const out = rasterizeDef.outputs.find((p) => p.id === 'out');
    expect(out, 'rasterize.out video port present').toBeDefined();
    expect(out?.type).toBe('mono-video');
  });

  it('declares an audio passthrough output', () => {
    const thru = rasterizeDef.outputs.find((p) => p.id === 'thru');
    expect(thru?.type).toBe('audio');
  });

  it('has exactly the audio in + one CV input per knob', () => {
    const ids = rasterizeDef.inputs.map((p) => p.id).sort();
    expect(ids).toEqual(['cursor', 'gain', 'in', 'samplesPerFrame', 'wrap']);
    for (const p of rasterizeDef.inputs) {
      if (p.id === 'in') {
        expect(p.type, 'in stays audio').toBe('audio');
      } else {
        expect(p.type, `${p.id} is CV`).toBe('cv');
        // Param routing invariant: port id == paramTarget == param id, so
        // the cross-domain CV bridge routes via setParam(portId).
        expect((p as { paramTarget?: string }).paramTarget, `${p.id} routes to itself`).toBe(p.id);
      }
    }
  });

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

  it('every CV input has a matching param (1:1 port↔param)', () => {
    const paramIds = new Set(rasterizeDef.params.map((p) => p.id));
    for (const p of rasterizeDef.inputs) {
      if (p.id === 'in') continue;
      expect(paramIds.has(p.id), `${p.id} has a param`).toBe(true);
    }
  });
});
