// packages/web/src/lib/graph/group-projection.test.ts
//
// Unit tests for projectGroups — the snapshot-projection seam between the
// canvas (which sees groups + exposed ports) and the engine reconciler
// (which must only see real child ports).

import { describe, it, expect } from 'vitest';
import { projectGroups, buildExposedPortMap, resolveExposedPort, type GroupData } from './group-projection';
import type { PatchSnapshot } from './snapshot';
import type { ModuleNode, Edge } from './types';

function n(id: string, type = 'analogVco', data?: Record<string, unknown>): ModuleNode {
  return {
    id,
    type,
    domain: type === 'group' ? 'meta' : 'audio',
    position: { x: 0, y: 0 },
    params: {},
    data,
  };
}

function e(id: string, srcN: string, srcP: string, dstN: string, dstP: string): Edge {
  return {
    id,
    source: { nodeId: srcN, portId: srcP },
    target: { nodeId: dstN, portId: dstP },
    sourceType: 'audio',
    targetType: 'audio',
  };
}

function snap(nodes: ModuleNode[], edges: Edge[]): PatchSnapshot {
  return { nodes, edges };
}

describe('projectGroups', () => {
  it('returns the input snapshot unchanged when there are no group nodes (same reference)', () => {
    const input = snap(
      [n('a'), n('b')],
      [e('e1', 'a', 'out', 'b', 'in')],
    );
    const out = projectGroups(input);
    expect(out).toBe(input);
  });

  it('rewrites edge endpoints that reference a group exposed port → real child port', () => {
    const groupData: GroupData = {
      childIds: ['vco-1', 'flt-1'],
      exposedPorts: [
        { id: 'in-cutoff', childId: 'flt-1', childPortId: 'cutoff', direction: 'input', cableType: 'cv' },
        { id: 'out-audio', childId: 'flt-1', childPortId: 'out', direction: 'output', cableType: 'audio' },
      ],
    };
    const input = snap(
      [
        n('vco-1', 'analogVco'),
        n('flt-1', 'filter'),
        n('g-1', 'group', groupData as unknown as Record<string, unknown>),
        n('out-1', 'audioOut'),
        n('lfo-1', 'lfo'),
      ],
      [
        // External: lfo → group's in-cutoff. Should rewrite to flt-1.cutoff.
        e('ext-in', 'lfo-1', 'phase0', 'g-1', 'in-cutoff'),
        // External: group's out-audio → out-1.L. Should rewrite to flt-1.out.
        e('ext-out', 'g-1', 'out-audio', 'out-1', 'L'),
        // Internal: vco-1 → flt-1 (both inside the group, named directly).
        e('int', 'vco-1', 'sine', 'flt-1', 'in'),
      ],
    );
    const out = projectGroups(input);
    const m = new Map(out.edges.map((edge) => [edge.id, edge]));

    expect(m.get('ext-in')!.target).toEqual({ nodeId: 'flt-1', portId: 'cutoff' });
    expect(m.get('ext-out')!.source).toEqual({ nodeId: 'flt-1', portId: 'out' });
    expect(m.get('int')!.source).toEqual({ nodeId: 'vco-1', portId: 'sine' });
    expect(m.get('int')!.target).toEqual({ nodeId: 'flt-1', portId: 'in' });
  });

  it('passes through edges that do not reference any group endpoint', () => {
    const groupData: GroupData = {
      childIds: ['c-1'],
      exposedPorts: [
        { id: 'in-x', childId: 'c-1', childPortId: 'cv', direction: 'input', cableType: 'cv' },
      ],
    };
    const input = snap(
      [
        n('a'),
        n('b'),
        n('c-1', 'filter'),
        n('g-1', 'group', groupData as unknown as Record<string, unknown>),
      ],
      [e('e1', 'a', 'out', 'b', 'in')],
    );
    const out = projectGroups(input);
    expect(out.edges).toHaveLength(1);
    expect(out.edges[0]!.source).toEqual({ nodeId: 'a', portId: 'out' });
    expect(out.edges[0]!.target).toEqual({ nodeId: 'b', portId: 'in' });
  });

  it('drops edges that reference a group at an unknown exposed-port id (defensive)', () => {
    const groupData: GroupData = {
      childIds: ['c-1'],
      exposedPorts: [
        { id: 'in-x', childId: 'c-1', childPortId: 'cv', direction: 'input', cableType: 'cv' },
      ],
    };
    const input = snap(
      [
        n('lfo-1', 'lfo'),
        n('c-1', 'filter'),
        n('g-1', 'group', groupData as unknown as Record<string, unknown>),
      ],
      [
        // Stale edge: references g-1::in-gone which no longer exists.
        e('stale', 'lfo-1', 'phase0', 'g-1', 'in-gone'),
        // Live edge: references the real exposed port.
        e('live', 'lfo-1', 'phase0', 'g-1', 'in-x'),
      ],
    );
    const out = projectGroups(input);
    expect(out.edges.map((edge) => edge.id)).toEqual(['live']);
    expect(out.edges[0]!.target).toEqual({ nodeId: 'c-1', portId: 'cv' });
  });

  it('treats a group with malformed data as having no exposed ports (drops stale edges)', () => {
    const input = snap(
      [
        n('lfo-1', 'lfo'),
        // exposedPorts missing entirely
        n('g-1', 'group', { childIds: ['c-1'] } as Record<string, unknown>),
      ],
      [e('stale', 'lfo-1', 'phase0', 'g-1', 'whatever')],
    );
    const out = projectGroups(input);
    expect(out.edges).toEqual([]);
  });

  it('preserves both nodes and the snapshot shape', () => {
    const groupData: GroupData = {
      childIds: ['c-1'],
      exposedPorts: [
        { id: 'in-x', childId: 'c-1', childPortId: 'cv', direction: 'input', cableType: 'cv' },
      ],
    };
    const input = snap(
      [n('lfo-1', 'lfo'), n('c-1', 'filter'), n('g-1', 'group', groupData as unknown as Record<string, unknown>)],
      [e('e1', 'lfo-1', 'phase0', 'g-1', 'in-x')],
    );
    const out = projectGroups(input);
    expect(out.nodes).toBe(input.nodes);
    expect(out.nodes.map((node) => node.id)).toEqual(['lfo-1', 'c-1', 'g-1']);
  });
});

describe('resolveExposedPort', () => {
  // Regression: this is the helper Canvas.svelte's handleConnect calls when
  // a cable terminates on a group's exposed handle. Before the fix the
  // connect path bailed because `getModuleDef('group') ?? getVideoModuleDef`
  // returned nothing — so dragging onto the LUMAKEY exposed OUT in an
  // instrument silently failed (no edge added to patch.edges, cable never
  // rendered).
  it('returns childId + childPortId + cableType for a known exposed handle', () => {
    const groupData: GroupData = {
      childIds: ['lumakey-1'],
      exposedPorts: [
        {
          id: 'OUT--LUMAKEY-FD8329B3--OUT',
          childId: 'lumakey-1',
          childPortId: 'out',
          direction: 'output',
          cableType: 'mono-video',
        },
      ],
    };
    const groupNode = n('dmt-warp', 'group', groupData as unknown as Record<string, unknown>);
    const got = resolveExposedPort(groupNode, 'OUT--LUMAKEY-FD8329B3--OUT');
    expect(got).toEqual({
      childId: 'lumakey-1',
      childPortId: 'out',
      cableType: 'mono-video',
      direction: 'output',
    });
  });

  it('returns null for unknown exposed handle ids on a group node', () => {
    const groupData: GroupData = {
      childIds: ['c-1'],
      exposedPorts: [
        { id: 'in-x', childId: 'c-1', childPortId: 'cv', direction: 'input', cableType: 'cv' },
      ],
    };
    const groupNode = n('g-1', 'group', groupData as unknown as Record<string, unknown>);
    expect(resolveExposedPort(groupNode, 'in-missing')).toBeNull();
  });

  it('returns null for non-group nodes (caller must fall back to def lookup)', () => {
    const audioNode = n('vco-1', 'analogVco');
    expect(resolveExposedPort(audioNode, 'out')).toBeNull();
  });

  it('returns null when the group has malformed data', () => {
    const groupNode = n('g-1', 'group', { childIds: ['c-1'] } as Record<string, unknown>);
    expect(resolveExposedPort(groupNode, 'whatever')).toBeNull();
  });
});

describe('buildExposedPortMap', () => {
  it('builds keyed lookup of every group exposed port', () => {
    const groupData: GroupData = {
      childIds: ['c-1'],
      exposedPorts: [
        { id: 'in', childId: 'c-1', childPortId: 'cv', direction: 'input', cableType: 'cv' },
        { id: 'out', childId: 'c-1', childPortId: 'sine', direction: 'output', cableType: 'audio' },
      ],
    };
    const input = snap(
      [n('c-1', 'filter'), n('g-1', 'group', groupData as unknown as Record<string, unknown>)],
      [],
    );
    const m = buildExposedPortMap(input);
    expect(m.size).toBe(2);
    expect(m.get('g-1::in')).toEqual({ childId: 'c-1', childPortId: 'cv' });
    expect(m.get('g-1::out')).toEqual({ childId: 'c-1', childPortId: 'sine' });
  });
});
