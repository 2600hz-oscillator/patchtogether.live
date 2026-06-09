// packages/web/src/lib/graph/cap.test.ts
//
// Unit tests for the type-level instance-count helpers (graph/cap.ts).
// Pure functions → small fake node maps + fake defs, no Yjs / Svelte.

import { describe, it, expect } from 'vitest';
import { instanceCount, wouldExceedCap, type TypedNode, type CapDef } from './cap';

/** Build a `{ id: node }` record from a flat list of (id, type) pairs. */
function nodeMap(
  entries: Array<[id: string, type: string]>,
): Record<string, TypedNode> {
  const m: Record<string, TypedNode> = {};
  for (const [id, type] of entries) m[id] = { type };
  return m;
}

describe('instanceCount', () => {
  it('returns 0 for an empty patch', () => {
    expect(instanceCount({}, 'vco')).toBe(0);
  });

  it('counts only nodes of the requested type', () => {
    const nodes = nodeMap([
      ['vco-1', 'vco'],
      ['vco-2', 'vco'],
      ['vcf-1', 'vcf'],
      ['out-1', 'output'],
    ]);
    expect(instanceCount(nodes, 'vco')).toBe(2);
    expect(instanceCount(nodes, 'vcf')).toBe(1);
    expect(instanceCount(nodes, 'output')).toBe(1);
  });

  it('returns 0 for a type that is absent', () => {
    const nodes = nodeMap([['vco-1', 'vco']]);
    expect(instanceCount(nodes, 'timelorde')).toBe(0);
  });

  it('counts by type value regardless of the node id shape (custom / non-prefixed ids)', () => {
    // Saved-group children / pasted nodes can carry ids that do NOT begin
    // with their module type — counting must key off `.type`, not the id.
    const nodes = nodeMap([
      ['my-custom-id', 'vco'],
      ['another_random_42', 'vco'],
      ['group-child-xyz', 'vco'],
      ['vcf-but-actually-a-vco', 'vco'], // id even names a different type
      ['vco-1', 'vcf'], // id begins with "vco" but is a vcf
    ]);
    expect(instanceCount(nodes, 'vco')).toBe(4);
    expect(instanceCount(nodes, 'vcf')).toBe(1);
  });

  it('skips null / undefined holes in the node map', () => {
    const nodes: Record<string, TypedNode | null | undefined> = {
      'vco-1': { type: 'vco' },
      'vco-2': null,
      'vco-3': undefined,
      'vco-4': { type: 'vco' },
    };
    expect(instanceCount(nodes, 'vco')).toBe(2);
  });
});

describe('wouldExceedCap', () => {
  const singleton: CapDef = { type: 'timelorde', maxInstances: 1 };
  const cappedAt3: CapDef = { type: 'doom', maxInstances: 3 };
  const uncapped: CapDef = { type: 'vco' }; // maxInstances undefined

  it('is false when maxInstances is undefined (no cap)', () => {
    const nodes = nodeMap([
      ['vco-1', 'vco'],
      ['vco-2', 'vco'],
      ['vco-3', 'vco'],
      ['vco-4', 'vco'],
    ]);
    expect(wouldExceedCap(nodes, uncapped)).toBe(false);
  });

  it('is false when the def is null / undefined', () => {
    const nodes = nodeMap([['vco-1', 'vco']]);
    expect(wouldExceedCap(nodes, null)).toBe(false);
    expect(wouldExceedCap(nodes, undefined)).toBe(false);
  });

  it('is false when strictly under the cap', () => {
    // singleton (cap 1) with zero existing → adding one is fine.
    expect(wouldExceedCap({}, singleton)).toBe(false);
    // cap 3 with 2 existing → adding the 3rd is fine.
    const nodes = nodeMap([
      ['doom-1', 'doom'],
      ['doom-2', 'doom'],
    ]);
    expect(wouldExceedCap(nodes, cappedAt3)).toBe(false);
  });

  it('is true when AT the cap (adding one more would exceed)', () => {
    // singleton (cap 1) with one existing → can't add a second.
    const one = nodeMap([['timelorde-1', 'timelorde']]);
    expect(wouldExceedCap(one, singleton)).toBe(true);
    // cap 3 with exactly 3 existing → can't add a 4th.
    const three = nodeMap([
      ['doom-1', 'doom'],
      ['doom-2', 'doom'],
      ['doom-3', 'doom'],
    ]);
    expect(wouldExceedCap(three, cappedAt3)).toBe(true);
  });

  it('is true when OVER the cap (e.g. a stale over-budget patch)', () => {
    const four = nodeMap([
      ['doom-1', 'doom'],
      ['doom-2', 'doom'],
      ['doom-3', 'doom'],
      ['doom-4', 'doom'],
    ]);
    expect(wouldExceedCap(four, cappedAt3)).toBe(true);
  });

  it('counts only the def.type — other module types do not consume the cap', () => {
    // A patch full of vcos must not block adding the singleton timelorde.
    const nodes = nodeMap([
      ['vco-1', 'vco'],
      ['vco-2', 'vco'],
      ['vcf-1', 'vcf'],
    ]);
    expect(wouldExceedCap(nodes, singleton)).toBe(false);
  });
});
