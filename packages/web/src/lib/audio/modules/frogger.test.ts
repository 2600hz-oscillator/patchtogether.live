// packages/web/src/lib/audio/modules/frogger.test.ts
//
// Module-def shape coverage. The state stepper is exhaustively covered by
// frogger-state.test.ts; this file pins the FROGGER def's IO surface so a
// future port edit (rename / type change / missing gate) breaks unit tests
// rather than the e2e + registry-manifest path.

import { describe, it, expect } from 'vitest';
import { froggerDef } from './frogger';

describe('froggerDef — registry shape', () => {
  it('declares the project canonical fields', () => {
    expect(froggerDef.type).toBe('frogger');
    expect(froggerDef.domain).toBe('audio');
    expect(froggerDef.label).toBe('frogger');
    expect(froggerDef.category).toBe('games');
    expect(froggerDef.vizPassthrough).toBe(true);
    expect(froggerDef.ossAttribution?.author).toMatch(/Adrian Eyre/i);
  });

  it('exposes EXACTLY the 5 CV-gate inputs (up/down/left/right/start)', () => {
    const ids = froggerDef.inputs.map((p) => p.id).sort();
    expect(ids).toEqual(['down_gate', 'left_gate', 'right_gate', 'start_gate', 'up_gate']);
    for (const port of froggerDef.inputs) {
      expect(port.type).toBe('gate');
    }
  });

  it('exposes EXACTLY the 3 gate outputs (home/dead/level)', () => {
    const ids = froggerDef.outputs.map((p) => p.id).sort();
    expect(ids).toEqual(['dead_gate', 'home_gate', 'level_gate']);
    for (const port of froggerDef.outputs) {
      expect(port.type).toBe('gate');
    }
  });

  it('has the initialTime knob with sensible bounds + default', () => {
    expect(froggerDef.params).toHaveLength(1);
    const knob = froggerDef.params[0]!;
    expect(knob.id).toBe('initialTime');
    expect(knob.min).toBe(10);
    expect(knob.max).toBe(120);
    expect(knob.defaultValue).toBe(60);
  });
});
