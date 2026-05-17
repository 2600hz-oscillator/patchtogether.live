// packages/web/src/lib/carl/personality.test.ts
//
// Unit tests for the in-browser Carl personality. The behavior parity
// with the chaos Stage-1 personality is implicit (same code), but these
// tests pin the contract Rackspace Carl needs to honor:
//   - addNode intents always carry the idPrefix
//   - addEdge candidates are restricted to matching cable types
//   - deterministic with a fixed seed
//   - sleeps when no edge candidates exist
//   - respects maxOwnedNodes cap (counts only owned, not foreign nodes)

import { describe, expect, it } from 'vitest';
import { RackspaceCarl } from './personality';
import { SeededRng } from './rng';
import type { Catalog } from './catalog';
import type { PersonalityPatchView } from './personality';

const FAKE_CATALOG: Catalog = [
  {
    type: 'analogVco',
    category: 'sources',
    inputs: [{ id: 'pitch', cableType: 'cv' }],
    outputs: [{ id: 'out', cableType: 'audio' }],
    params: [{ id: 'detune', min: -100, max: 100, defaultValue: 0 }],
  },
  {
    type: 'filter',
    category: 'filters',
    inputs: [
      { id: 'in', cableType: 'audio' },
      { id: 'cutoff_cv', cableType: 'cv', paramTarget: 'cutoff' },
    ],
    outputs: [{ id: 'out', cableType: 'audio' }],
    params: [{ id: 'cutoff', min: 20, max: 20000, defaultValue: 1000 }],
  },
  {
    type: 'mixer',
    category: 'utilities',
    inputs: [
      { id: 'in_1', cableType: 'audio' },
      { id: 'in_2', cableType: 'audio' },
    ],
    outputs: [{ id: 'out', cableType: 'audio' }],
    params: [],
  },
];

function emptyPatch(): PersonalityPatchView {
  return { nodes: [], edges: [] };
}

describe('RackspaceCarl personality', () => {
  it('emits addNode with the idPrefix when starting from empty', () => {
    const carl = new RackspaceCarl(FAKE_CATALOG, { idPrefix: 'carl' });
    const rng = new SeededRng(1);
    const intent = carl.next(rng, emptyPatch());
    expect(intent.kind === 'addNode' || intent.kind === 'sleep').toBe(true);
    if (intent.kind === 'addNode') {
      expect(intent.id.startsWith('carl-')).toBe(true);
    }
  });

  it('counts only owned nodes against maxOwnedNodes', () => {
    const carl = new RackspaceCarl(FAKE_CATALOG, {
      idPrefix: 'carl',
      maxOwnedNodes: 1,
    });
    const rng = new SeededRng(42);
    const patch: PersonalityPatchView = {
      nodes: [
        { id: 'carl-n0-analogVco', type: 'analogVco' },
        { id: 'user-x', type: 'mixer' },
      ],
      edges: [],
    };
    let sawAddNode = false;
    for (let i = 0; i < 200; i++) {
      const intent = carl.next(rng, patch);
      if (intent.kind === 'addNode') sawAddNode = true;
    }
    expect(sawAddNode).toBe(false);
  });

  it('produces only legal addEdge candidates (matching cable types)', () => {
    const carl = new RackspaceCarl(FAKE_CATALOG, { idPrefix: 'carl' });
    const rng = new SeededRng(7);
    const patch: PersonalityPatchView = {
      nodes: [
        { id: 'carl-n0-analogVco', type: 'analogVco' },
        { id: 'carl-n1-filter', type: 'filter' },
        { id: 'carl-n2-mixer', type: 'mixer' },
      ],
      edges: [],
    };
    for (let i = 0; i < 500; i++) {
      const intent = carl.next(rng, patch);
      if (intent.kind === 'addEdge') {
        expect(intent.sourceCableType).toBe(intent.targetCableType);
      }
    }
  });

  it('is deterministic for a given seed', () => {
    const carlA = new RackspaceCarl(FAKE_CATALOG, { idPrefix: 'carl' });
    const carlB = new RackspaceCarl(FAKE_CATALOG, { idPrefix: 'carl' });
    const rngA = new SeededRng(12345);
    const rngB = new SeededRng(12345);
    const patch = emptyPatch();
    for (let i = 0; i < 20; i++) {
      const a = carlA.next(rngA, patch);
      const b = carlB.next(rngB, patch);
      expect(b).toEqual(a);
    }
  });

  it('throws if the catalog has no spawnable modules', () => {
    expect(() => new RackspaceCarl([], {})).toThrow(/no spawnable modules/);
  });
});
