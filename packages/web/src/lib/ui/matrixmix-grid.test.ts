// packages/web/src/lib/ui/matrixmix-grid.test.ts
//
// PURE unit tests for the MATRIXMIX matrix-classification core. No Svelte / no
// Yjs — exercises every cell-kind branch (direct / inputTaken / outputFanout /
// legalEmpty / illegal) + the legal-patch predicate + the jack/edge helpers.

import { describe, it, expect } from 'vitest';
import type { Edge, PortDef } from '$lib/graph/types';
import {
  jacksForDef,
  resolvePatchRoles,
  findDirectEdge,
  classifyCell,
  matrixEdgeId,
  type Jack,
} from './matrixmix-grid';

// ── fixtures ──
const inPort = (id: string, type = 'audio'): PortDef => ({ id, type });
const outPort = (id: string, type = 'audio'): PortDef => ({ id, type });

const audioIn: Jack = { portId: 'in', direction: 'input', type: 'audio' };
const audioOut: Jack = { portId: 'out', direction: 'output', type: 'audio' };
const cvIn: Jack = { portId: 'cutoff', direction: 'input', type: 'cv' };
const cvOut: Jack = { portId: 'lfo', direction: 'output', type: 'cv' };
const videoOut: Jack = { portId: 'vout', direction: 'output', type: 'video' };

function edge(
  id: string,
  s: [string, string],
  t: [string, string],
  sourceType = 'audio',
  targetType = 'audio',
): Edge {
  return {
    id,
    source: { nodeId: s[0], portId: s[1] },
    target: { nodeId: t[0], portId: t[1] },
    sourceType,
    targetType,
  };
}

const X = 'x-mod';
const Y = 'y-mod';
const THIRD = 'third-mod';
const nameOf = (id: string) => ({ [THIRD]: 'LFO', [X]: 'VCA', [Y]: 'FILTER' }[id] ?? id);

describe('jacksForDef', () => {
  it('emits every input then every output, in def order, tagged by direction', () => {
    const jacks = jacksForDef({
      inputs: [inPort('in'), inPort('cv', 'cv')],
      outputs: [outPort('out')],
    });
    expect(jacks).toEqual([
      { portId: 'in', direction: 'input', type: 'audio', accepts: undefined },
      { portId: 'cv', direction: 'input', type: 'cv', accepts: undefined },
      { portId: 'out', direction: 'output', type: 'audio' },
    ]);
  });

  it('carries an input port `accepts` widening through to the jack', () => {
    const jacks = jacksForDef({
      inputs: [{ id: 'probe', type: 'audio', accepts: ['cv', 'gate', 'pitch'] }],
      outputs: [],
    });
    expect(jacks[0].accepts).toEqual(['cv', 'gate', 'pitch']);
  });

  it('undefined def → no jacks', () => {
    expect(jacksForDef(undefined)).toEqual([]);
  });
});

describe('resolvePatchRoles (legal-patch predicate)', () => {
  it('input + output of compatible type → resolves roles', () => {
    expect(resolvePatchRoles(audioIn, audioOut)).toEqual({ input: audioIn, output: audioOut });
    // order-independent: output as the row, input as the col.
    expect(resolvePatchRoles(audioOut, audioIn)).toEqual({ input: audioIn, output: audioOut });
  });

  it('CV-family cross-patch (cv out → audio... no; but cv→cv, pitch→cv) is legal', () => {
    // cv output → cv input
    expect(resolvePatchRoles(cvIn, cvOut)).toEqual({ input: cvIn, output: cvOut });
  });

  it('input → input is illegal (null)', () => {
    expect(resolvePatchRoles(audioIn, cvIn)).toBeNull();
  });

  it('output → output is illegal (null)', () => {
    expect(resolvePatchRoles(audioOut, cvOut)).toBeNull();
  });

  it('incompatible types (video out → audio in) is illegal (null)', () => {
    expect(resolvePatchRoles(audioIn, videoOut)).toBeNull();
  });

  it('honours an input port `accepts` widening (audio-typed probe taking cv)', () => {
    const probeIn: Jack = { portId: 'probe', direction: 'input', type: 'audio', accepts: ['cv'] };
    expect(resolvePatchRoles(probeIn, cvOut)).toEqual({ input: probeIn, output: cvOut });
  });
});

describe('findDirectEdge', () => {
  it('finds a cable spanning the two matrixed jacks (output→input orientation)', () => {
    // X.out → Y.in (col is X.out, row is Y.in)
    const e = edge('e1', [X, 'out'], [Y, 'in']);
    const found = findDirectEdge(audioIn /* row=Y.in */, audioOut /* col=X.out */, [e], X, Y);
    expect(found).toBe(e);
  });

  it('finds a cable spanning the two jacks in the other orientation (Y.out→X.in)', () => {
    const e = edge('e2', [Y, 'out'], [X, 'in']);
    const found = findDirectEdge(audioOut /* row=Y.out */, audioIn /* col=X.in */, [e], X, Y);
    expect(found).toBe(e);
  });

  it('ignores a cable to a third module', () => {
    const e = edge('e3', [X, 'out'], [THIRD, 'in']);
    expect(findDirectEdge(audioIn, audioOut, [e], X, Y)).toBeUndefined();
  });
});

describe('classifyCell', () => {
  it('DIRECT: a cable between the two jacks → filled dot coloured by source type', () => {
    const e = edge('e1', [X, 'lfo'], [Y, 'cutoff'], 'cv', 'cv');
    const cls = classifyCell(cvIn /* row Y.cutoff */, cvOut /* col X.lfo */, [e], X, Y, nameOf);
    expect(cls.kind).toBe('direct');
    expect(cls.cableType).toBe('cv');
  });

  it('ILLEGAL: input → input → illegal, no patch', () => {
    const cls = classifyCell(audioIn, cvIn, [], X, Y, nameOf);
    expect(cls.kind).toBe('illegal');
    expect(cls.patch).toBeUndefined();
  });

  it('ILLEGAL: output → output → illegal', () => {
    expect(classifyCell(audioOut, cvOut, [], X, Y, nameOf).kind).toBe('illegal');
  });

  it('ILLEGAL: type mismatch (video out → audio in) → illegal', () => {
    // row = Y.in (audio), col = X.vout (video)
    expect(classifyCell(audioIn, videoOut, [], X, Y, nameOf).kind).toBe('illegal');
  });

  it('INPUT-TAKEN: the cell input already fed by a THIRD module → red ✕ + remote tooltip', () => {
    // Cell pairs Y.in (input) + X.out (output). Y.in is already fed by THIRD.lfo.
    const occ = edge('e-occ', [THIRD, 'lfo'], [Y, 'in'], 'cv', 'audio');
    const cls = classifyCell(audioIn /* row Y.in */, audioOut /* col X.out */, [occ], X, Y, nameOf);
    expect(cls.kind).toBe('inputTaken');
    expect(cls.remote).toEqual({ name: 'LFO', port: 'lfo' });
  });

  it('OUTPUT-FANOUT: the cell output already feeds a THIRD module → gray ✕ + remote tooltip', () => {
    // Cell pairs Y.in (input) + X.out (output). X.out already feeds THIRD.in.
    const fan = edge('e-fan', [X, 'out'], [THIRD, 'in']);
    const cls = classifyCell(audioIn /* row Y.in */, audioOut /* col X.out */, [fan], X, Y, nameOf);
    expect(cls.kind).toBe('outputFanout');
    expect(cls.remote).toEqual({ name: 'LFO', port: 'in' });
  });

  it('INPUT-TAKEN wins over OUTPUT-FANOUT when both apply (destructive warned first)', () => {
    const occ = edge('e-occ', [THIRD, 'lfo'], [Y, 'in'], 'cv', 'audio');
    const fan = edge('e-fan', [X, 'out'], [THIRD, 'in']);
    const cls = classifyCell(audioIn, audioOut, [occ, fan], X, Y, nameOf);
    expect(cls.kind).toBe('inputTaken');
  });

  it('LEGAL-EMPTY: compatible input+output, no conflict → clickable with the edge to create', () => {
    const cls = classifyCell(audioIn /* row Y.in */, audioOut /* col X.out */, [], X, Y, nameOf);
    expect(cls.kind).toBe('legalEmpty');
    // Cable runs output(X.out) → input(Y.in).
    expect(cls.patch).toEqual({
      source: { nodeId: X, portId: 'out' },
      target: { nodeId: Y, portId: 'in' },
    });
  });

  it('DIRECT takes precedence over a fan-out read of the same output', () => {
    // The direct cable IS the X.out→Y.in cable; it must read as direct, not
    // as "output fans out to a third party" (it's the matrixed party).
    const e = edge('e1', [X, 'out'], [Y, 'in']);
    const cls = classifyCell(audioIn, audioOut, [e], X, Y, nameOf);
    expect(cls.kind).toBe('direct');
  });

  it('same module on both axes: a jack vs itself is illegal (no self-patch)', () => {
    // X === Y, the diagonal cell pairs in/in or out/out → illegal.
    const cls = classifyCell(audioIn, audioIn, [], X, X, nameOf);
    expect(cls.kind).toBe('illegal');
  });
});

describe('matrixEdgeId', () => {
  it('matches the Canvas/patch-to edge-id convention', () => {
    expect(
      matrixEdgeId({ nodeId: X, portId: 'out' }, { nodeId: Y, portId: 'in' }),
    ).toBe(`e-${X}-out-${Y}-in`);
  });
});
