// packages/web/src/lib/video/modules/luma.test.ts
//
// LUMA module-def tests. Pure (no GL).

import { describe, it, expect } from 'vitest';
import { lumaDef } from './luma';

describe('lumaDef shape', () => {
  it('declares threshold / softness / invert params', () => {
    const ids = lumaDef.params.map((p) => p.id).sort();
    expect(ids).toEqual(['invert', 'softness', 'threshold']);
  });

  it('declares CV inputs for both continuous params', () => {
    const inputIds = lumaDef.inputs.map((p) => p.id);
    expect(inputIds).toContain('in');
    expect(inputIds).toContain('threshold');
    expect(inputIds).toContain('softness');
  });

  it('invert is a discrete 0/1 toggle', () => {
    const invert = lumaDef.params.find((p) => p.id === 'invert');
    expect(invert?.min).toBe(0);
    expect(invert?.max).toBe(1);
    expect(invert?.curve).toBe('discrete');
  });

  it('output is a single mono-video keys mask', () => {
    expect(lumaDef.outputs.map((o) => o.id)).toEqual(['out']);
    expect(lumaDef.outputs[0]!.type).toBe('mono-video');
  });
});
