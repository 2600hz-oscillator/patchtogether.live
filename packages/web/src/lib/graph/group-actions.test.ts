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
    expect(fltOut?.hasInternalCable).toBe(false);
    const lfoPhase = candidates.find((c) => c.childId === 'lfo-1' && c.childPortId === 'phase0');
    expect(lfoPhase?.hasExternalCable).toBe(false); // only patched to flt-1 (inside)
    expect(lfoPhase?.hasInternalCable).toBe(true); // wired to flt-1 cutoff (inside)
    const fltCutoff = candidates.find((c) => c.childId === 'flt-1' && c.childPortId === 'cutoff');
    expect(fltCutoff?.hasExternalCable).toBe(false);
    expect(fltCutoff?.hasInternalCable).toBe(true); // wired from lfo-1 phase0 (inside)
  });

  it('marks ports patched to BOTH inside + outside as hasInternal && hasExternal', () => {
    const candidates = buildPortCandidates({
      selectionIds: ['lfo-1', 'flt-1'],
      nodes: [node('lfo-1', 'lfo'), node('flt-1', 'filter'), node('out-1', 'audioOut')],
      edges: [
        // internal: lfo phase -> flt cutoff
        edge('e1', { n: 'lfo-1', p: 'phase0' }, { n: 'flt-1', p: 'cutoff' }),
        // external: out-1 -> flt cutoff (cv multi-patched)
        edge('e2', { n: 'out-1', p: 'L' }, { n: 'flt-1', p: 'cutoff' }),
      ],
      modulesById: new Map([
        ['lfo-1', lfoMod],
        ['flt-1', filterMod],
      ]),
    });
    const fltCutoff = candidates.find((c) => c.childId === 'flt-1' && c.childPortId === 'cutoff');
    expect(fltCutoff?.hasInternalCable).toBe(true);
    expect(fltCutoff?.hasExternalCable).toBe(true);
    expect(fltCutoff?.internalSummary).toContain('lfo-1.phase0');
    expect(fltCutoff?.externalSummary).toContain('out-1.L');
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
        { childId: 'flt-1', childPortId: 'cutoff', direction: 'input', cableType: 'cv', hasExternalCable: false, hasInternalCable: false },
        { childId: 'flt-1', childPortId: 'out', direction: 'output', cableType: 'audio', hasExternalCable: true, hasInternalCable: false },
        { childId: 'lfo-1', childPortId: 'rate', direction: 'input', cableType: 'cv', hasExternalCable: false, hasInternalCable: false },
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

// --------------------------------------------------------------------
// Phase 2B — planEditExposed
// --------------------------------------------------------------------

import { planEditExposed, planDuplicateGroup } from './group-actions';

describe('planEditExposed', () => {
  it('preserves stable exposed-port ids for ports kept in both old and new lists', () => {
    const oldExposed: ExposedPort[] = [
      { id: 'out--flt-1--out', childId: 'flt-1', childPortId: 'out', direction: 'output', cableType: 'audio' },
    ];
    const group = node('g-1', 'group', {
      childIds: ['lfo-1', 'flt-1'],
      exposedPorts: oldExposed,
    } as unknown as Record<string, unknown>);
    const newExposed: ExposedPort[] = [
      // Caller minted a fresh id, but planEditExposed should keep the old one.
      { id: 'BOGUS-NEW-ID', childId: 'flt-1', childPortId: 'out', direction: 'output', cableType: 'audio' },
      { id: 'in--flt-1--cutoff', childId: 'flt-1', childPortId: 'cutoff', direction: 'input', cableType: 'cv' },
    ];
    const plan = planEditExposed({
      group,
      edges: [],
      newExposedPorts: newExposed,
    });
    expect(plan.mergedExposedPorts).toHaveLength(2);
    const kept = plan.mergedExposedPorts.find((p) => p.childPortId === 'out')!;
    expect(kept.id).toBe('out--flt-1--out'); // OLD id preserved
    const added = plan.mergedExposedPorts.find((p) => p.childPortId === 'cutoff')!;
    expect(added.id).toBe('in--flt-1--cutoff'); // new id used for fresh port
  });

  it('drops edges terminating on un-exposed ports', () => {
    const oldExposed: ExposedPort[] = [
      { id: 'out--flt-1--out', childId: 'flt-1', childPortId: 'out', direction: 'output', cableType: 'audio' },
      { id: 'in--flt-1--cutoff', childId: 'flt-1', childPortId: 'cutoff', direction: 'input', cableType: 'cv' },
    ];
    const group = node('g-1', 'group', {
      childIds: ['flt-1'],
      exposedPorts: oldExposed,
    } as unknown as Record<string, unknown>);
    const plan = planEditExposed({
      group,
      edges: [
        edge('e-keep', { n: 'g-1', p: 'out--flt-1--out' }, { n: 'out-1', p: 'L' }),
        edge('e-drop', { n: 'lfo-1', p: 'phase0' }, { n: 'g-1', p: 'in--flt-1--cutoff' }),
      ],
      newExposedPorts: [
        // Drop the cutoff exposure; keep the out exposure.
        { id: 'out--flt-1--out', childId: 'flt-1', childPortId: 'out', direction: 'output', cableType: 'audio' },
      ],
    });
    expect(plan.deleteEdgeIds).toEqual(['e-drop']);
    expect(plan.mergedExposedPorts).toHaveLength(1);
  });

  it('propagates an explicit label update', () => {
    const group = node('g-1', 'group', {
      childIds: [],
      exposedPorts: [],
      label: 'old',
    } as unknown as Record<string, unknown>);
    const plan = planEditExposed({ group, edges: [], newExposedPorts: [], newLabel: 'shiny' });
    expect(plan.newLabel).toBe('shiny');
  });

  it('handles a group with no prior exposedPorts', () => {
    const group = node('g-1', 'group');
    const newExposed: ExposedPort[] = [
      { id: 'in--flt-1--cutoff', childId: 'flt-1', childPortId: 'cutoff', direction: 'input', cableType: 'cv' },
    ];
    const plan = planEditExposed({ group, edges: [], newExposedPorts: newExposed });
    expect(plan.mergedExposedPorts).toHaveLength(1);
    expect(plan.mergedExposedPorts[0]!.id).toBe('in--flt-1--cutoff');
    expect(plan.deleteEdgeIds).toEqual([]);
  });
});

// --------------------------------------------------------------------
// Phase 2C — planDuplicateGroup
// --------------------------------------------------------------------

describe('planDuplicateGroup', () => {
  it('mints fresh ids for group + every child + every internal edge; external edges NOT cloned', () => {
    const lfo: ModuleNode = { id: 'lfo-1', type: 'lfo', domain: 'audio', position: { x: 0, y: 0 }, params: { rate: 2 } };
    const flt: ModuleNode = { id: 'flt-1', type: 'filter', domain: 'audio', position: { x: 100, y: 0 }, params: {} };
    const group: ModuleNode = {
      id: 'g-1',
      type: 'group',
      domain: 'meta',
      position: { x: 200, y: 200 },
      params: {},
      data: {
        childIds: ['lfo-1', 'flt-1'],
        exposedPorts: [
          { id: 'out--flt-1--out', childId: 'flt-1', childPortId: 'out', direction: 'output', cableType: 'audio' },
        ],
      } as unknown as Record<string, unknown>,
    };
    const internalEdge: Edge = {
      id: 'e-internal',
      source: { nodeId: 'lfo-1', portId: 'phase0' },
      target: { nodeId: 'flt-1', portId: 'cutoff' },
      sourceType: 'cv',
      targetType: 'cv',
    };
    const externalEdge: Edge = {
      id: 'e-external',
      source: { nodeId: 'g-1', portId: 'out--flt-1--out' },
      target: { nodeId: 'out-1', portId: 'L' },
      sourceType: 'audio',
      targetType: 'audio',
    };
    const plan = planDuplicateGroup({
      group,
      children: [lfo, flt],
      edges: [internalEdge, externalEdge],
      existingNodeIds: ['lfo-1', 'flt-1', 'g-1', 'out-1'],
      existingEdgeIds: ['e-internal', 'e-external'],
      positionOffset: { x: 30, y: 30 },
    });

    expect(plan.newChildren).toHaveLength(2);
    const ids = new Set(plan.newChildren.map((c) => c.id));
    expect(ids.has('lfo-1')).toBe(false);
    expect(ids.has('flt-1')).toBe(false);
    expect(plan.newGroup.id).not.toBe('g-1');
    // Positions cascaded.
    const newLfo = plan.newChildren.find((c) => c.type === 'lfo')!;
    expect(newLfo.position).toEqual({ x: 30, y: 30 });
    expect(plan.newGroup.position).toEqual({ x: 230, y: 230 });
    // Params deep-cloned (independent object) but values copied.
    expect(newLfo.params).toEqual({ rate: 2 });
    expect(newLfo.params).not.toBe(lfo.params);

    // ExposedPort rewritten to point at the new child id.
    const newExposed = (plan.newGroup.data as { exposedPorts: ExposedPort[] }).exposedPorts;
    expect(newExposed).toHaveLength(1);
    const newFlt = plan.newChildren.find((c) => c.type === 'filter')!;
    expect(newExposed[0]!.childId).toBe(newFlt.id);

    // Internal edge cloned, external NOT.
    expect(plan.newEdges).toHaveLength(1);
    expect(plan.newEdges[0]!.source.nodeId).toBe(newLfo.id);
    expect(plan.newEdges[0]!.target.nodeId).toBe(newFlt.id);
    expect(plan.newEdges[0]!.id).not.toBe('e-internal');

    // parentGroupId stamped on the new children, NOT the old group id.
    for (const c of plan.newChildren) {
      expect((c.data as { parentGroupId?: string }).parentGroupId).toBe(plan.newGroup.id);
    }
  });

  it('returns an empty plan when the group has no data', () => {
    const group: ModuleNode = {
      id: 'g-1',
      type: 'group',
      domain: 'meta',
      position: { x: 0, y: 0 },
      params: {},
    };
    const plan = planDuplicateGroup({
      group,
      children: [],
      edges: [],
      existingNodeIds: ['g-1'],
      existingEdgeIds: [],
    });
    expect(plan.newChildren).toHaveLength(0);
    expect(plan.newEdges).toHaveLength(0);
    expect((plan.newGroup.data as { exposedPorts: ExposedPort[] }).exposedPorts).toEqual([]);
  });
});
