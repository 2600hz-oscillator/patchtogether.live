// packages/web/src/lib/livecode/port-types.test.ts
//
// Tests resolveCable() — the heart of LIVECODE's direction-agnostic
// patch logic. The runtime + the linter + the autocomplete all defer
// to this function so a single test surface keeps them aligned.

import { describe, expect, it } from 'vitest';
import { resolveCable, isPatchCompatible, parsePortRef, findModuleByName } from './port-types';
import type { ModuleNode } from '$lib/graph/types';

import '$lib/audio/modules';
import '$lib/video/modules';

function makeNode(id: string, type: string, name: string): ModuleNode {
  return {
    id,
    type: type as never,
    domain: 'audio',
    position: { x: 0, y: 0 },
    params: {},
    data: { name },
  };
}

function env(...nodes: ModuleNode[]): Record<string, ModuleNode> {
  const out: Record<string, ModuleNode> = {};
  for (const n of nodes) out[n.id] = n;
  return out;
}

describe('parsePortRef', () => {
  it('parses module.port', () => {
    expect(parsePortRef('vco1.sine')).toEqual({ node: 'vco1', port: 'sine' });
  });

  it('returns null for malformed refs', () => {
    expect(parsePortRef('vco1')).toBeNull();
    expect(parsePortRef('.sine')).toBeNull();
    expect(parsePortRef('vco1.')).toBeNull();
    expect(parsePortRef('')).toBeNull();
  });

  it('handles port ids with underscores or numbers', () => {
    expect(parsePortRef('hyd1.trig0')).toEqual({ node: 'hyd1', port: 'trig0' });
    expect(parsePortRef('seq1.out_l')).toEqual({ node: 'seq1', port: 'out_l' });
  });
});

describe('findModuleByName', () => {
  it('finds by display name, case-insensitively', () => {
    const nodes = env(makeNode('a', 'analogVco', 'MyVco'));
    expect(findModuleByName(nodes, 'myvco')?.id).toBe('a');
    expect(findModuleByName(nodes, 'MYVCO')?.id).toBe('a');
  });

  it('finds by raw node id', () => {
    const nodes = env(makeNode('a-123', 'analogVco', 'lead'));
    expect(findModuleByName(nodes, 'a-123')?.id).toBe('a-123');
  });

  it('returns undefined when neither matches', () => {
    expect(findModuleByName({}, 'ghost')).toBeUndefined();
  });
});

describe('isPatchCompatible', () => {
  it('allows same-type pairs', () => {
    expect(isPatchCompatible('audio', 'audio')).toBe(true);
    expect(isPatchCompatible('gate', 'gate')).toBe(true);
  });

  it('allows CV-family interchange', () => {
    expect(isPatchCompatible('gate', 'cv')).toBe(true);
    expect(isPatchCompatible('pitch', 'cv')).toBe(true);
    expect(isPatchCompatible('cv', 'gate')).toBe(true);
  });

  it('allows audio ↔ cv (engine-permitted widening)', () => {
    expect(isPatchCompatible('audio', 'cv')).toBe(true);
    expect(isPatchCompatible('cv', 'audio')).toBe(true);
  });

  it('rejects video → audio', () => {
    expect(isPatchCompatible('video', 'audio')).toBe(false);
  });

  it('allows polyPitchGate to all CV-family + audio', () => {
    expect(isPatchCompatible('polyPitchGate', 'pitch')).toBe(true);
    expect(isPatchCompatible('polyPitchGate', 'audio')).toBe(true);
    expect(isPatchCompatible('audio', 'polyPitchGate')).toBe(true);
  });
});

describe('resolveCable: direction-agnostic patch resolution', () => {
  it('source-first resolves with source/target correctly set', () => {
    const nodes = env(
      makeNode('vco', 'analogVco', 'vco1'),
      makeNode('sc', 'scope', 'scope1'),
    );
    const r = resolveCable(nodes, 'vco1.sine', 'scope1.ch1');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.source.port.id).toBe('sine');
    expect(r.target.port.id).toBe('ch1');
  });

  it('destination-first ALSO resolves (swapped source/target back)', () => {
    const nodes = env(
      makeNode('vco', 'analogVco', 'vco1'),
      makeNode('sc', 'scope', 'scope1'),
    );
    const r = resolveCable(nodes, 'scope1.ch1', 'vco1.sine');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.source.port.id).toBe('sine');
    expect(r.source.node.id).toBe('vco');
    expect(r.target.port.id).toBe('ch1');
    expect(r.target.node.id).toBe('sc');
  });

  it('rejects two outputs (no in)', () => {
    const nodes = env(
      makeNode('a', 'analogVco', 'vco1'),
      makeNode('b', 'analogVco', 'vco2'),
    );
    const r = resolveCable(nodes, 'vco1.sine', 'vco2.sine');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/both.*outputs/i);
  });

  it('rejects two inputs (no out)', () => {
    const nodes = env(
      makeNode('a', 'scope', 'scope1'),
      makeNode('b', 'scope', 'scope2'),
    );
    const r = resolveCable(nodes, 'scope1.ch1', 'scope2.ch1');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/both.*inputs/i);
  });

  it('rejects when a module is missing', () => {
    const nodes = env(makeNode('a', 'analogVco', 'vco1'));
    const r = resolveCable(nodes, 'vco1.sine', 'ghost.ch1');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/ghost.*not found/i);
  });

  it('rejects when a port is missing', () => {
    const nodes = env(
      makeNode('a', 'analogVco', 'vco1'),
      makeNode('b', 'scope', 'scope1'),
    );
    const r = resolveCable(nodes, 'vco1.notReal', 'scope1.ch1');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/no port/i);
  });
});
