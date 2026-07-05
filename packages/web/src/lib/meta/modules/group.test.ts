// packages/web/src/lib/meta/modules/group.test.ts
//
// Unit tests for the GROUP! meta-domain module def + makeGroupNode factory.

import { describe, it, expect } from 'vitest';
import { groupDef, makeGroupNode } from './group';
import type { ExposedPort } from '$lib/graph/group-projection';

describe('groupDef', () => {
  it('has the meta-domain shape: type=group, no ports, no params', () => {
    expect(groupDef.type).toBe('group');
    expect(groupDef.domain).toBe('meta');
    expect(groupDef.inputs).toEqual([]);
    expect(groupDef.outputs).toEqual([]);
    expect(groupDef.params).toEqual([]);
  });
});

describe('makeGroupNode', () => {
  it('builds a domain=meta node carrying childIds + exposedPorts in data', () => {
    const exposed: ExposedPort[] = [
      { id: 'in-cutoff', childId: 'flt-1', childPortId: 'cutoff', direction: 'input', cableType: 'cv' },
      { id: 'out-audio', childId: 'flt-1', childPortId: 'out', direction: 'output', cableType: 'audio' },
    ];
    const node = makeGroupNode({
      id: 'g-1',
      position: { x: 100, y: 200 },
      childIds: ['vco-1', 'flt-1'],
      exposedPorts: exposed,
      label: 'My Voice',
    });
    expect(node.id).toBe('g-1');
    expect(node.type).toBe('group');
    expect(node.domain).toBe('meta');
    expect(node.position).toEqual({ x: 100, y: 200 });
    expect(node.params).toEqual({});
    expect(node.data).toMatchObject({
      childIds: ['vco-1', 'flt-1'],
      exposedPorts: exposed,
      label: 'My Voice',
    });
  });

  it('omits the label key when not provided', () => {
    const node = makeGroupNode({
      id: 'g-2',
      position: { x: 0, y: 0 },
      childIds: ['a'],
      exposedPorts: [],
    });
    expect(node.data).not.toHaveProperty('label');
  });
});
