// packages/web/src/lib/audio/modules/audioin.test.ts
//
// Unit tests for AUDIO IN's def shape. The runtime DSP behavior (attach
// + mono/stereo wiring) needs a MediaStream + AudioContext and is
// covered by the e2e spec (e2e/tests/audio-in.spec.ts) running under
// Chromium with --use-fake-device-for-media-stream.

import { describe, expect, it } from 'vitest';
import { audioInDef } from './audioin';

describe('audioInDef: module-def shape', () => {
  it('declares type=audioIn, label=AUDIO IN, category=sources', () => {
    expect(audioInDef.type).toBe('audioIn');
    expect(audioInDef.label).toBe('audio in');
    expect(audioInDef.category).toBe('sources');
  });

  it('has no inputs (terminal source) + L+R audio outputs', () => {
    expect(audioInDef.inputs).toEqual([]);
    const outIds = audioInDef.outputs.map((p) => p.id).sort();
    expect(outIds).toEqual(['audio_l_out', 'audio_r_out']);
    for (const p of audioInDef.outputs) {
      expect(p.type, `${p.id} type`).toBe('audio');
    }
  });

  it('exposes a single gain param (0..2, default 1.0)', () => {
    expect(audioInDef.params.length).toBe(1);
    const g = audioInDef.params[0]!;
    expect(g.id).toBe('gain');
    expect(g.defaultValue).toBe(1.0);
    expect(g.min).toBe(0);
    expect(g.max).toBe(2);
  });

  it('is NOT a singleton (maxInstances unset/undefined)', () => {
    // Per the spec: users may want multiple AUDIO IN cards on different
    // physical inputs. Singleton would be wrong here.
    expect(audioInDef.maxInstances).toBeUndefined();
  });
});
