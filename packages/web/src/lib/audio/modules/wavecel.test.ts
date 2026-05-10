// packages/web/src/lib/audio/modules/wavecel.test.ts
//
// Unit test for WAVECEL's def shape, focused on the cross-domain
// video outputs added in this PR. Pure-data assertions only — the
// AudioWorklet factory needs a real AudioContext (covered by e2e +
// ART).

import { describe, expect, it } from 'vitest';
import { wavecelDef } from './wavecel';

describe('WAVECEL module def shape', () => {
  it('keeps the legacy stereo audio outputs', () => {
    const ids = wavecelDef.outputs.map((p) => p.id);
    expect(ids).toContain('out_l');
    expect(ids).toContain('out_r');
    expect(wavecelDef.outputs.find((p) => p.id === 'out_l')?.type).toBe('audio');
    expect(wavecelDef.outputs.find((p) => p.id === 'out_r')?.type).toBe('audio');
  });

  it('exposes scope_out as mono-video (single-color trace)', () => {
    const p = wavecelDef.outputs.find((o) => o.id === 'scope_out');
    expect(p, 'scope_out declared').toBeDefined();
    expect(p?.type).toBe('mono-video');
  });

  it('exposes wave3d_out as video (RGB so orange + white survive)', () => {
    const p = wavecelDef.outputs.find((o) => o.id === 'wave3d_out');
    expect(p, 'wave3d_out declared').toBeDefined();
    expect(p?.type).toBe('video');
  });

  it('has 5 inputs + 4 outputs = 9 handles total', () => {
    expect(wavecelDef.inputs.length).toBe(5);
    expect(wavecelDef.outputs.length).toBe(4);
  });

  it('preserves the stereoPairs metadata for the audio outs', () => {
    expect(wavecelDef.stereoPairs).toEqual([['out_l', 'out_r']]);
  });
});
