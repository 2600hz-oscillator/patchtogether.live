// packages/web/src/lib/graph/group-actions.test.ts
//
// Unit tests for the pure create-group / ungroup planners.

import { describe, it, expect } from 'vitest';
import {
  buildPortCandidates,
  buildExposedPorts,
  planCreateGroup,
  planUngroup,
  type PortLookupModule,
} from './group-actions';
import type { ModuleNode, Edge, PortDef } from './types';
import type { GroupData, ExposedPort } from './group-projection';

function node(id: string, type: string, data?: Record<string, unknown>): ModuleNode {
  return {
    id,
    type,
    domain: type === 'group' ? 'meta' : 'audio',
    position: { x: 100, y: 100 },
    params: {},
    data,
  };
}

function edge(id: string, src: { n: string; p: string }, dst: { n: string; p: string }): Edge {
  return {
    id,
    source: { nodeId: src.n, portId: src.p },
    target: { nodeId: dst.n, portId: dst.p },
    sourceType: 'audio',
    targetType: 'audio',
  };
}

const filterMod: PortLookupModule = {
  id: 'flt-1',
  type: 'filter',
  inputs: [
    { id: 'in', type: 'audio' } as PortDef,
    { id: 'cutoff', type: 'cv' } as PortDef,
  ],
  outputs: [{ id: 'out', type: 'audio' } as PortDef],
};
const lfoMod: PortLookupModule = {
  id: 'lfo-1',
  type: 'lfo',
  inputs: [{ id: 'rate', type: 'cv' } as PortDef],
  outputs: [{ id: 'phase0', type: 'cv' } as PortDef],
};

describe('buildPortCandidates', () => {
  it('marks ports with edges to OUTSIDE the selection as hasExternalCable', () => {
    const candidates = buildPortCandidates({
      selectionIds: ['lfo-1', 'flt-1'],
      nodes: [node('lfo-1', 'lfo'), node('flt-1', 'filter'), node('out-1', 'audioOut')],
      edges: [
        // internal: lfo -> flt
        edge('e1', { n: 'lfo-1', p: 'phase0' }, { n: 'flt-1', p: 'cutoff' }),
        // external: flt -> out-1
        edge('e2', { n: 'flt-1', p: 'out' }, { n: 'out-1', p: 'L' }),
      ],
      modulesById: new Map([
        ['lfo-1', lfoMod],
        ['flt-1', filterMod],
      ]),
    });
    const fltOut = candidates.find((c) => c.childId === 'flt-1' && c.childPortId === 'out');
    expect(fltOut?.hasExternalCable).toBe(true);
    const lfoPhase = candidates.find((c) => c.childId === 'lfo-1' && c.childPortId === 'phase0');
    expect(lfoPhase?.hasExternalCable).toBe(false); // only patched to flt-1 (inside)
    const fltCutoff = candidates.find((c) => c.childId === 'flt-1' && c.childPortId === 'cutoff');
    expect(fltCutoff?.hasExternalCable).toBe(false);
  });

  it('includes every port on every selected module', () => {
    const candidates = buildPortCandidates({
      selectionIds: ['lfo-1', 'flt-1'],
      nodes: [node('lfo-1', 'lfo'), node('flt-1', 'filter')],
      edges: [],
      modulesById: new Map([
        ['lfo-1', lfoMod],
        ['flt-1', filterMod],
      ]),
    });
    // lfo: 1 input + 1 output; filter: 2 inputs + 1 output = 5 candidates
    expect(candidates).toHaveLength(5);
  });
});

describe('buildExposedPorts', () => {
  it('maps user-selected candidates → ExposedPort with stable ids; inputs first, outputs second', () => {
    const ports = buildExposedPorts({
      selectedCandidates: [
        { childId: 'flt-1', childPortId: 'cutoff', direction: 'input', cableType: 'cv', hasExternalCable: false },
        { childId: 'flt-1', childPortId: 'out', direction: 'output', cableType: 'audio', hasExternalCable: true },
        { childId: 'lfo-1', childPortId: 'rate', direction: 'input', cableType: 'cv', hasExternalCable: false },
      ],
    });
    // Inputs first (flt-1 cutoff, lfo-1 rate), then outputs (flt-1 out)
    expect(ports.map((p) => p.id)).toEqual([
      'in--flt-1--cutoff',
      'in--lfo-1--rate',
      'out--flt-1--out',
    ]);
    expect(ports[0]!.direction).toBe('input');
    expect(ports[2]!.direction).toBe('output');
  });
});

describe('planCreateGroup', () => {
  const lfo = node('lfo-1', 'lfo');
  const flt = node('flt-1', 'filter');
  const out = node('out-1', 'audioOut');

  it('rewrites external cables to terminate on the group exposed port; keeps internal edges', () => {
    const exposed: ExposedPort[] = [
      { id: 'out--flt-1--out', childId: 'flt-1', childPortId: 'out', direction: 'output', cableType: 'audio' },
    ];
    const plan = planCreateGroup({
      groupId: 'g-1',
      selectionIds: ['lfo-1', 'flt-1'],
      exposedPorts: exposed,
      nodes: [lfo, flt, out],
      edges: [
        edge('e-internal', { n: 'lfo-1', p: 'phase0' }, { n: 'flt-1', p: 'cutoff' }),
        edge('e-external', { n: 'flt-1', p: 'out' }, { n: 'out-1', p: 'L' }),
      ],
    });
    expect(plan.edges.rewrite).toHaveLength(1);
    expect(plan.edges.rewrite[0]).toEqual({
      id: 'e-external',
      newSource: { nodeId: 'g-1', portId: 'out--flt-1--out' },
    });
    expect(plan.edges.deleteIds).toEqual([]);
  });

  it('deletes external cables whose inside port the user did NOT expose', () => {
    const plan = planCreateGroup({
      groupId: 'g-1',
      selectionIds: ['flt-1'],
      exposedPorts: [], // user unchecked everything
      nodes: [flt, out],
      edges: [edge('e-doomed', { n: 'flt-1', p: 'out' }, { n: 'out-1', p: 'L' })],
    });
    expect(plan.edges.deleteIds).toEqual(['e-doomed']);
    expect(plan.edges.rewrite).toEqual([]);
  });

  it('leaves edges with both endpoints outside untouched', () => {
    const a = node('a', 'lfo');
    const b = node('b', 'filter');
    const plan = planCreateGroup({
      groupId: 'g-1',
      selectionIds: ['flt-1'],
      exposedPorts: [],
      nodes: [flt, a, b],
      edges: [edge('e-untouched', { n: 'a', p: 'phase0' }, { n: 'b', p: 'cutoff' })],
    });
    expect(plan.edges.rewrite).toEqual([]);
    expect(plan.edges.deleteIds).toEqual([]);
  });

  it('plans child parentGroupId sets for every selected node', () => {
    const plan = planCreateGroup({
      groupId: 'g-1',
      selectionIds: ['lfo-1', 'flt-1'],
      exposedPorts: [],
      nodes: [lfo, flt],
      edges: [],
    });
    expect(plan.childParentSets).toEqual([
      { childId: 'lfo-1', parentGroupId: 'g-1' },
      { childId: 'flt-1', parentGroupId: 'g-1' },
    ]);
  });

  it('positions the group at the centroid of selected nodes when no override is given', () => {
    const a: ModuleNode = { ...lfo, position: { x: 0, y: 0 } };
    const b: ModuleNode = { ...flt, position: { x: 200, y: 400 } };
    const plan = planCreateGroup({
      groupId: 'g-1',
      selectionIds: ['lfo-1', 'flt-1'],
      exposedPorts: [],
      nodes: [a, b],
      edges: [],
    });
    expect(plan.groupNode.position).toEqual({ x: 100, y: 200 });
  });

  it('respects an explicit position override', () => {
    const plan = planCreateGroup({
      groupId: 'g-1',
      selectionIds: ['lfo-1'],
      exposedPorts: [],
      nodes: [lfo],
      edges: [],
      position: { x: 999, y: 999 },
    });
    expect(plan.groupNode.position).toEqual({ x: 999, y: 999 });
  });
});

describe('planUngroup', () => {
  it('rewrites edges from group exposed ports back to underlying child ports + clears parentGroupId', () => {
    const groupData: GroupData = {
      childIds: ['lfo-1', 'flt-1'],
      exposedPorts: [
        { id: 'out--flt-1--out', childId: 'flt-1', childPortId: 'out', direction: 'output', cableType: 'audio' },
        { id: 'in--flt-1--cutoff', childId: 'flt-1', childPortId: 'cutoff', direction: 'input', cableType: 'cv' },
      ],
    };
    const group = node('g-1', 'group', groupData as unknown as Record<string, unknown>);
    const plan = planUngroup({
      groupNode: group,
      edges: [
        edge('e-ext-out', { n: 'g-1', p: 'out--flt-1--out' }, { n: 'out-1', p: 'L' }),
        edge('e-ext-in', { n: 'mod-1', p: 'phase0' }, { n: 'g-1', p: 'in--flt-1--cutoff' }),
        edge('e-internal', { n: 'lfo-1', p: 'phase0' }, { n: 'flt-1', p: 'cutoff' }),
      ],
    });
    expect(plan.rewrite).toHaveLength(2);
    expect(plan.rewrite.find((r) => r.id === 'e-ext-out')!.newSource).toEqual({
      nodeId: 'flt-1',
      portId: 'out',
    });
    expect(plan.rewrite.find((r) => r.id === 'e-ext-in')!.newTarget).toEqual({
      nodeId: 'flt-1',
      portId: 'cutoff',
    });
    expect(plan.childrenToClear).toEqual(['lfo-1', 'flt-1']);
    expect(plan.groupNodeId).toBe('g-1');
  });

  it('handles a group with missing/malformed data gracefully', () => {
    const group = node('g-1', 'group');
    const plan = planUngroup({ groupNode: group, edges: [] });
    expect(plan.rewrite).toEqual([]);
    expect(plan.childrenToClear).toEqual([]);
    expect(plan.groupNodeId).toBe('g-1');
  });
});
