// packages/web/src/lib/ui/modules/toybox-export-guard.test.ts
//
// The pure decision behind "Export refuses to write a preset it knows is
// incomplete" (#1589). No DOM, no engine, no Y.Doc — the guard is a function of
// the data blob and the set of layers that actually produced bytes.
//
// THE FAILURE THIS PINS: before the guard, `resolveLayerVideos` skipped any
// layer with no live object url and `exportPreset` wrote whatever came back. A
// collapse destroyed the urls, so the zip carried ZERO videos and the card said
// "Exported TOYBOX.toybox.zip". Both halves of that are asserted here: the
// refusal fires when bytes are missing, AND it stays silent for every layer
// that legitimately has nothing to embed — a guard that blocked patched feeds
// or empty layers would make Export unusable and would be the worse bug.

import { describe, it, expect } from 'vitest';
import {
  expectedVideoLayers,
  exportRefusalMessage,
  layerVideoName,
  missingVideoLayers,
} from './toybox-export-guard';

/** A layer blob as it actually appears in node.data.layers. */
function videoLayer(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { kind: 'video', contentId: null, params: {}, videoSource: 'file', ...over };
}

describe('layerVideoName — the two spellings reconciled in ONE place', () => {
  it('reads videoMeta.name (what setLayerVideoName writes)', () => {
    expect(layerVideoName(videoLayer({ videoMeta: { name: 'clip.webm' } }))).toBe('clip.webm');
  });

  it('reads the flat videoName (what older blobs + import manifests carry)', () => {
    expect(layerVideoName(videoLayer({ videoName: 'legacy.mp4' }))).toBe('legacy.mp4');
  });

  it('prefers videoMeta.name when both are present', () => {
    expect(
      layerVideoName(videoLayer({ videoMeta: { name: 'current.webm' }, videoName: 'stale.mp4' })),
    ).toBe('current.webm');
  });

  it('treats absent / null / blank as NO name', () => {
    expect(layerVideoName(undefined)).toBeNull();
    expect(layerVideoName(videoLayer())).toBeNull();
    expect(layerVideoName(videoLayer({ videoMeta: { name: null } }))).toBeNull();
    expect(layerVideoName(videoLayer({ videoMeta: { name: '   ' } }))).toBeNull();
    // A malformed videoMeta must not throw or resolve to a name.
    expect(layerVideoName(videoLayer({ videoMeta: 'not-an-object' }))).toBeNull();
  });
});

describe('expectedVideoLayers — which layers a COMPLETE export must carry bytes for', () => {
  it('a named local-file video layer is expected', () => {
    const layers = [videoLayer({ videoMeta: { name: 'a.webm' } })];
    expect(expectedVideoLayers(layers)).toEqual([{ layer: 0, name: 'a.webm' }]);
  });

  it('an ABSENT videoSource counts as file — the #603 default, so old blobs are judged', () => {
    const layers = [{ kind: 'video', videoMeta: { name: 'old.webm' } }];
    expect(expectedVideoLayers(layers)).toEqual([{ layer: 0, name: 'old.webm' }]);
  });

  it('a PATCHED feed is never expected — there are no bytes to embed by design', () => {
    for (const src of ['inA', 'inB', 'layerIn']) {
      const layers = [videoLayer({ videoSource: src, videoMeta: { name: 'ignored.webm' } })];
      expect(expectedVideoLayers(layers), `videoSource=${src}`).toEqual([]);
    }
  });

  it('a CAMERA layer is never expected — a live capture has no file', () => {
    const layers = [videoLayer({ videoSource: 'camera', videoMeta: { name: 'was-a-file.webm' } })];
    expect(expectedVideoLayers(layers)).toEqual([]);
  });

  it('a file layer with NO name is never expected — the user never picked one', () => {
    expect(expectedVideoLayers([videoLayer()])).toEqual([]);
  });

  it('non-video layers are never expected, whatever else they carry', () => {
    const layers = [
      { kind: 'gen', contentId: 'noise-fbm', params: {} },
      { kind: 'image', imageBytes: 'AAAA', videoMeta: { name: 'decoy.webm' } },
      { kind: 'off', contentId: null, params: {} },
      { kind: 'obj', material: {} },
    ];
    expect(expectedVideoLayers(layers)).toEqual([]);
  });

  it('reports the INDEX of each expected layer, in order, across a mixed rack', () => {
    const layers = [
      { kind: 'gen', contentId: 'hsv-plasma', params: {} },
      videoLayer({ videoMeta: { name: 'one.webm' } }),
      videoLayer({ videoSource: 'inA', videoMeta: { name: 'patched.webm' } }),
      videoLayer({ videoName: 'three.mp4' }),
    ];
    expect(expectedVideoLayers(layers)).toEqual([
      { layer: 1, name: 'one.webm' },
      { layer: 3, name: 'three.mp4' },
    ]);
  });

  it('is DERIVED, not sized — a fifth layer enrols with no code change', () => {
    // The repo forbids hand-typed population counts, and this is why: the guard
    // must not know how many layers TOYBOX has.
    const five = Array.from({ length: 5 }, (_, i) => videoLayer({ videoMeta: { name: `l${i}.webm` } }));
    expect(expectedVideoLayers(five).map((e) => e.layer)).toEqual([0, 1, 2, 3, 4]);
  });

  it('refuses to invent expectations from garbage', () => {
    // A blob with no parseable layers must not BLOCK an export — the guard only
    // speaks about what the data actually declares.
    expect(expectedVideoLayers(undefined)).toEqual([]);
    expect(expectedVideoLayers(null)).toEqual([]);
    expect(expectedVideoLayers('layers')).toEqual([]);
    expect(expectedVideoLayers([null, undefined, 42, 'x'])).toEqual([]);
  });
});

describe('missingVideoLayers — expectation minus what actually resolved', () => {
  const expected = [
    { layer: 1, name: 'one.webm' },
    { layer: 3, name: 'three.mp4' },
  ];

  it('nothing is missing when every expected layer resolved', () => {
    expect(missingVideoLayers(expected, [1, 3])).toEqual([]);
  });

  it('reports exactly the layers that did not resolve', () => {
    expect(missingVideoLayers(expected, [1])).toEqual([{ layer: 3, name: 'three.mp4' }]);
    expect(missingVideoLayers(expected, [])).toEqual(expected);
  });

  it('an extra resolved layer never invents a miss', () => {
    expect(missingVideoLayers(expected, [0, 1, 2, 3])).toEqual([]);
  });

  it('THE #1589 SHAPE: every url destroyed by a collapse → every layer missing', () => {
    // This is the exact input the pre-fix code produced, and the exact output
    // that used to be reported as a successful export.
    expect(missingVideoLayers(expected, []).map((m) => m.layer)).toEqual([1, 3]);
  });
});

describe('exportRefusalMessage — loud, actionable, and silent when it should be', () => {
  it('is null when nothing is missing — export proceeds', () => {
    expect(exportRefusalMessage([])).toBeNull();
  });

  it('names the layer 1-INDEXED (matching the card tabs) and the file', () => {
    const msg = exportRefusalMessage([{ layer: 0, name: 'clip.webm' }])!;
    expect(msg).toContain('layer 1');
    expect(msg).toContain('clip.webm');
    // It must not silently succeed-sounding: the word the user reads first.
    expect(msg).toMatch(/^Export cancelled/);
  });

  it('lists every missing layer, not just the first', () => {
    const msg = exportRefusalMessage([
      { layer: 1, name: 'one.webm' },
      { layer: 3, name: 'three.mp4' },
    ])!;
    expect(msg).toContain('layer 2');
    expect(msg).toContain('layer 4');
    expect(msg).toContain('one.webm');
    expect(msg).toContain('three.mp4');
  });

  it('tells the user what to DO — a refusal with no remedy is just a wall', () => {
    const msg = exportRefusalMessage([{ layer: 0, name: 'clip.webm' }])!;
    expect(msg).toMatch(/re-pick/i);
  });
});

describe('the guard END-TO-END over a data blob (the two states that used to be one)', () => {
  const layers = [
    { kind: 'gen', contentId: 'noise-fbm', params: {} },
    videoLayer({ videoMeta: { name: 'loaded.webm' } }),
    videoLayer({ videoSource: 'inB', videoMeta: { name: 'patched.webm' } }),
  ];

  it('LOADED: bytes resolved for the one expected layer → no refusal', () => {
    const expected = expectedVideoLayers(layers);
    const refusal = exportRefusalMessage(missingVideoLayers(expected, [1]));
    expect(refusal).toBeNull();
  });

  it('DESTROYED: the same blob with no resolved bytes → a refusal naming it', () => {
    const expected = expectedVideoLayers(layers);
    const refusal = exportRefusalMessage(missingVideoLayers(expected, []));
    expect(refusal, 'a zero-video export of a named video layer must be refused').not.toBeNull();
    expect(refusal!).toContain('loaded.webm');
    // ...and it must NOT blame the patched layer, which was never going to
    // carry bytes. That distinction is the whole reason this is not just
    // "videos.length === 0".
    expect(refusal!).not.toContain('patched.webm');
  });

  it('NO VIDEO AT ALL: a rack with no file layers exports freely', () => {
    const gensOnly = [
      { kind: 'gen', contentId: 'hsv-plasma', params: {} },
      { kind: 'off', contentId: null, params: {} },
    ];
    expect(exportRefusalMessage(missingVideoLayers(expectedVideoLayers(gensOnly), []))).toBeNull();
  });
});
