// packages/web/src/lib/audio/modules/fourplexer.test.ts
//
// Unit-test the 4PLEXER module-def shape. The routing + gate-advance
// behaviour is covered by the pure selector unit suite
// (fourplexer-select.test.ts) and the e2e (e2e/tests/4plexer.spec.ts).

import { describe, it, expect } from 'vitest';
import { fourplexerDef } from './fourplexer';

describe('fourplexerDef shape', () => {
  it('declares 4 signal inputs + 4 gate inputs (8 total)', () => {
    const ids = fourplexerDef.inputs.map((p) => p.id).sort();
    expect(ids).toEqual([
      'gate1', 'gate2', 'gate3', 'gate4',
      'in1', 'in2', 'in3', 'in4',
    ]);
  });

  it('declares 4 signal outputs', () => {
    const ids = fourplexerDef.outputs.map((p) => p.id).sort();
    expect(ids).toEqual(['out1', 'out2', 'out3', 'out4']);
  });

  it('signal in/out ports are cv (audio + cv route identically)', () => {
    for (const id of ['in1', 'in2', 'in3', 'in4']) {
      expect(fourplexerDef.inputs.find((p) => p.id === id)?.type).toBe('cv');
    }
    for (const id of ['out1', 'out2', 'out3', 'out4']) {
      expect(fourplexerDef.outputs.find((p) => p.id === id)?.type).toBe('cv');
    }
  });

  it('the 4 gate inputs are gate-typed', () => {
    for (const id of ['gate1', 'gate2', 'gate3', 'gate4']) {
      expect(fourplexerDef.inputs.find((p) => p.id === id)?.type).toBe('gate');
    }
  });

  it('declares 4 discrete selector params, one per output', () => {
    for (const id of ['sel1', 'sel2', 'sel3', 'sel4']) {
      const p = fourplexerDef.params.find((x) => x.id === id);
      expect(p, `param ${id}`).toBeDefined();
      expect(p!.curve).toBe('discrete');
      expect(p!.min).toBe(0);
      expect(p!.max).toBe(3);
    }
  });

  it('default selection is a straight pass-through (out_i = in_i)', () => {
    expect(fourplexerDef.params.find((p) => p.id === 'sel1')?.defaultValue).toBe(0);
    expect(fourplexerDef.params.find((p) => p.id === 'sel2')?.defaultValue).toBe(1);
    expect(fourplexerDef.params.find((p) => p.id === 'sel3')?.defaultValue).toBe(2);
    expect(fourplexerDef.params.find((p) => p.id === 'sel4')?.defaultValue).toBe(3);
  });

  it('is an audio-domain utility', () => {
    expect(fourplexerDef.domain).toBe('audio');
    expect(fourplexerDef.category).toBe('utility');
    expect(fourplexerDef.type).toBe('fourplexer');
  });
});
