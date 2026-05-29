// packages/web/src/lib/audio/modules/wavviz.test.ts
//
// Unit tests for WAVVIZ. The factory imports browser-only asset URLs;
// we test the def shape via dynamic import. The shared buildFoldCurve
// helper lives in $lib/audio/fold-curve and is pinned by the wavefolder
// ART scenario.

import { describe, expect, it } from 'vitest';

describe('WAVVIZ module def shape', () => {
  it('exports wavvizDef with the right ports + params', async () => {
    const mod = await import('./wavviz');
    const def = mod.wavvizDef;
    expect(def.type).toBe('wavviz');
    expect(def.domain).toBe('audio');
    expect(def.label).toBe('WAVVIZ');

    const inputIds = def.inputs.map((p) => p.id).sort();
    expect(inputIds).toEqual(['fm', 'foldAmount', 'pitch', 'wavePos'].sort());

    const outputIds = def.outputs.map((p) => p.id).sort();
    expect(outputIds).toEqual(['audio', 'scope']);

    const scope = def.outputs.find((p) => p.id === 'scope');
    expect(scope?.type).toBe('mono-video');

    const foldParam = def.params.find((p) => p.id === 'foldAmount');
    expect(foldParam).toBeDefined();
    expect(foldParam?.min).toBe(0);
    expect(foldParam?.max).toBe(1);
  });

  it('exports WavvizData (compile-time contract for the preset dropdown)', async () => {
    const mod = await import('./wavviz');
    // The WavvizData export is types-only at runtime — synthesize an object
    // matching the shape to validate WavvizCard's payload still typechecks.
    const data: import('./wavviz').WavvizData = {
      wavetableFrames: [[0, 0.5, -0.5]],
      wavetableLabel: 'TEST',
    };
    expect(Array.isArray(data.wavetableFrames)).toBe(true);
    expect(data.wavetableLabel).toBe('TEST');
    expect(typeof mod.wavvizDef).toBe('object');
  });
});
