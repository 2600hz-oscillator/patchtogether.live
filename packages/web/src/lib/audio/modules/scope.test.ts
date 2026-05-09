// packages/web/src/lib/audio/modules/scope.test.ts
//
// Unit test for SCOPE's def shape, including the new mono-video
// output port added in this PR. SCOPE has no Faust assets so we can
// import its def directly without dynamic-import hedging.

import { describe, expect, it } from 'vitest';
import { scopeDef } from './scope';

describe('SCOPE module def shape', () => {
  it('declares the mono-video output port', () => {
    const out = scopeDef.outputs.find((p) => p.id === 'out');
    expect(out, 'scope.out video port present').toBeDefined();
    expect(out?.type).toBe('mono-video');
  });

  it('preserves the legacy audio passthrough outputs', () => {
    const ids = scopeDef.outputs.map((p) => p.id);
    expect(ids).toContain('ch1_out');
    expect(ids).toContain('ch2_out');
  });

  it('inputs unchanged: ch1, ch2 audio', () => {
    const ids = scopeDef.inputs.map((p) => p.id).sort();
    expect(ids).toEqual(['ch1', 'ch2']);
    for (const p of scopeDef.inputs) {
      expect(p.type).toBe('audio');
    }
  });
});
