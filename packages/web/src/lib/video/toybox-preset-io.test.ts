// packages/web/src/lib/video/toybox-preset-io.test.ts
//
// Pure round-trip coverage for the TOYBOX preset .zip export/import. No GL/DOM,
// so this is fully deterministic — the real correctness guard for #61.

import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import {
  exportToyboxPreset,
  importToyboxPreset,
  isToyboxPresetZip,
  MAX_VIDEO_BYTES,
  type ToyboxPresetBundle,
} from './toybox-preset-io';

/** A representative node.data blob: layers (incl an INLINE base64 image + custom
 *  shader/obj source that ride along for free), a combine graph, cv routes. */
function sampleData(): Record<string, unknown> {
  return {
    layers: [
      { kind: 'gen', contentId: 'noise-fbm', params: { speed: 0.4 } },
      { kind: 'image', contentId: null, params: {}, imageBytes: 'data:image/png;base64,AAAA', imageName: 'pic.png' },
      { kind: 'shader', contentId: 'custom-shader:abc', params: {}, shaderSrc: 'void main(){}', shaderName: 'my.glsl' },
      { kind: 'obj', contentId: null, params: {}, objSrc: 'v 0 0 0\n', objName: 'mesh.obj', material: { modelId: 'custom' } },
    ],
    combine: { nodes: [{ id: 'src0', kind: 'source', layer: 0, x: 14, y: 14 }], edges: [] },
    cvRoutes: { cv1: { target: 'layer', layer: 0, param: 'speed' } },
    cvInputs: { cv1: { scale: 1, offset: 0 } },
  };
}

function bundle(over: Partial<ToyboxPresetBundle> = {}): ToyboxPresetBundle {
  return { data: sampleData(), videos: [], label: 'My Preset', savedAt: 1234, ...over };
}

describe('toybox-preset-io — export/import round-trip', () => {
  it('round-trips a media-less preset exactly (data + label + savedAt)', () => {
    const b = bundle();
    const round = importToyboxPreset(exportToyboxPreset(b));
    expect(round.data).toEqual(b.data); // images/shader/obj inline → preserved verbatim
    expect(round.label).toBe('My Preset');
    expect(round.savedAt).toBe(1234);
    expect(round.videos).toEqual([]);
  });

  it('round-trips loaded videos (bytes + name + layer) as separate zip entries', () => {
    const v0 = new Uint8Array([1, 2, 3, 4, 5]);
    const v3 = new Uint8Array([9, 8, 7]);
    const b = bundle({
      videos: [
        { layer: 0, name: 'clip a.mp4', bytes: v0 },
        { layer: 3, name: 'clip a.mp4', bytes: v3 }, // same name, different layer → no collision
      ],
    });
    const round = importToyboxPreset(exportToyboxPreset(b));
    expect(round.videos).toHaveLength(2);
    const byLayer = Object.fromEntries(round.videos.map((v) => [v.layer, v]));
    expect(Array.from(byLayer[0]!.bytes)).toEqual([1, 2, 3, 4, 5]);
    expect(Array.from(byLayer[3]!.bytes)).toEqual([9, 8, 7]);
    expect(byLayer[0]!.name).toBe('clip a.mp4');
  });

  it('export is deterministic for a fixed input (savedAt comes from the bundle, not the clock)', () => {
    const a = exportToyboxPreset(bundle());
    const c = exportToyboxPreset(bundle());
    expect(Array.from(a)).toEqual(Array.from(c));
  });

  it('produces a zip recognised by isToyboxPresetZip', () => {
    expect(isToyboxPresetZip(exportToyboxPreset(bundle()))).toBe(true);
    expect(isToyboxPresetZip(new Uint8Array([0, 1, 2, 3]))).toBe(false);
    expect(isToyboxPresetZip(new Uint8Array())).toBe(false);
  });

  it('rejects empty / corrupt / foreign zips with a clear message', () => {
    expect(() => importToyboxPreset(new Uint8Array())).toThrow(/empty/i);
    expect(() => importToyboxPreset(new Uint8Array([1, 2, 3, 4, 5, 6]))).toThrow(/corrupt/i);
  });

  it('rejects a valid-but-foreign zip (no preset.json)', () => {
    const foreign = zipSync({ 'readme.txt': strToU8('hello') });
    expect(() => importToyboxPreset(foreign)).toThrow(/missing preset\.json/i);
    expect(isToyboxPresetZip(foreign)).toBe(false);
  });

  it('rejects a zip whose preset.json declares an unsupported format', () => {
    const wrong = zipSync({
      'preset.json': strToU8(JSON.stringify({ format: 'toybox-preset-v999', data: {}, videos: [] })),
    });
    expect(() => importToyboxPreset(wrong)).toThrow(/unsupported|format/i);
  });

  it('rejects an oversized video on import', () => {
    // Forge a bundle whose video exceeds the cap, export, then import → throws.
    const huge = new Uint8Array(MAX_VIDEO_BYTES + 1);
    const z = exportToyboxPreset(bundle({ videos: [{ layer: 0, name: 'big.mp4', bytes: huge }] }));
    expect(() => importToyboxPreset(z)).toThrow(/100 MB|exceeds/i);
  });

  it('MAX_VIDEO_BYTES is 100 MB', () => {
    expect(MAX_VIDEO_BYTES).toBe(100 * 1024 * 1024);
  });
});
