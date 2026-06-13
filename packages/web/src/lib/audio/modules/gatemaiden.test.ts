// packages/web/src/lib/audio/modules/gatemaiden.test.ts
//
// GATEMAIDEN module-def shape — ports, edge semantics, params. The per-sample
// conversion behaviour is covered by packages/dsp/src/lib/gatemaiden-dsp.test.ts.

import { describe, it, expect } from 'vitest';
import { gatemaidenDef } from './gatemaiden';

describe('gatemaidenDef shape', () => {
  it('is a lowercase-labelled audio Utility module', () => {
    expect(gatemaidenDef.type).toBe('gatemaiden');
    expect(gatemaidenDef.label).toBe('gatemaiden'); // lowercase-label guard
    expect(gatemaidenDef.domain).toBe('audio');
  });

  it('has ONE generic input that accepts the CV family', () => {
    expect(gatemaidenDef.inputs.map((p) => p.id)).toEqual(['in']);
    const inp = gatemaidenDef.inputs[0]!;
    expect(inp.type).toBe('gate');
    expect(inp.accepts).toEqual(['cv', 'pitch']);
  });

  it('emits a gate out + a trigger out with declared edge semantics', () => {
    const gate = gatemaidenDef.outputs.find((o) => o.id === 'gate')!;
    const trig = gatemaidenDef.outputs.find((o) => o.id === 'trig')!;
    expect(gate.type).toBe('gate');
    expect(gate.edge).toBe('gate');
    expect(trig.type).toBe('gate');
    expect(trig.edge).toBe('trigger'); // the trigger output is edge-semantic
  });

  it('input declares the gate (level-reading) edge semantic', () => {
    expect(gatemaidenDef.inputs[0]!.edge).toBe('gate');
  });

  it('has a log Len param + a discrete trigShape param', () => {
    const len = gatemaidenDef.params.find((p) => p.id === 'gateLen')!;
    expect(len.curve).toBe('log');
    expect(len.min).toBe(0.005);
    expect(len.max).toBe(2);
    expect(gatemaidenDef.params.find((p) => p.id === 'trigShape')!.curve).toBe('discrete');
  });
});
