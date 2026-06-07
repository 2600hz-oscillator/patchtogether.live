// packages/web/src/lib/audio/modules/audio-out.test.ts
//
// Unit tests for Audio Out's def shape. The actual DSP behavior of the
// DC blocker + master limiter (added in feat/audio-fidelity-...) is
// covered by art/scenarios/audio-out/dc-blocker-and-limiter.test.ts —
// those need an OfflineAudioContext and run under the ART harness.

import { describe, expect, it } from 'vitest';
import { audioOutDef } from './audio-out';

describe('audioOutDef: module-def shape', () => {
  it('declares type=audioOut, label=Audio Out, category=output', () => {
    expect(audioOutDef.type).toBe('audioOut');
    expect(audioOutDef.label).toBe('audio out');
    expect(audioOutDef.category).toBe('output');
  });

  it('exposes L + R audio inputs and no outputs (terminal sink)', () => {
    const inIds = audioOutDef.inputs.map((p) => p.id).sort();
    expect(inIds).toEqual(['L', 'R']);
    for (const p of audioOutDef.inputs) {
      expect(p.type, `${p.id} type`).toBe('audio');
    }
    expect(audioOutDef.outputs).toEqual([]);
  });

  it('declares the master volume param (default 0.7)', () => {
    const m = audioOutDef.params.find((p) => p.id === 'master');
    expect(m).toBeDefined();
    expect(m?.defaultValue).toBe(0.7);
    expect(m?.min).toBe(0);
    expect(m?.max).toBe(1);
  });
});
