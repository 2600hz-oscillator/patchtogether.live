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

  it('exposes 2 audio inputs + 1 cv input per param', () => {
    // PR-69 added per-param CV inputs ("scope should have cv inputs
    // for everything"). Port id MUST equal param id so the cross-domain
    // CV bridge in PatchEngine routes via setParam(portId).
    const ids = scopeDef.inputs.map((p) => p.id).sort();
    expect(ids).toEqual(
      [
        'ch1', 'ch2',
        'timeMs',
        'ch1Scale', 'ch1Offset', 'ch1Range',
        'ch2Scale', 'ch2Offset', 'ch2Range',
        'mode',
      ].sort(),
    );
    for (const p of scopeDef.inputs) {
      if (p.id === 'ch1' || p.id === 'ch2') {
        expect(p.type, `${p.id} stays audio`).toBe('audio');
      } else {
        expect(p.type, `${p.id} is CV`).toBe('cv');
        // Param routing invariant: port id == paramTarget == def.params[].id.
        expect((p as { paramTarget?: string }).paramTarget, `${p.id} routes to itself`).toBe(p.id);
      }
    }
  });
});
