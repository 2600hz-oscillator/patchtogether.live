// packages/web/src/lib/graph/saved-group-resurrect.test.ts
//
// Unit tests for the pure save/resurrect helpers backing the saved-groups
// library. Round-trip: extractSavedGroupPayload(rack) → SavedGroupPayload
// → resurrectSavedGroup(...payload) → fresh group + children + internal
// edges, ready to be written into a destination rack.

import { describe, it, expect } from 'vitest';
import {
  extractSavedGroupPayload,
  resurrectSavedGroup,
} from './saved-group-resurrect';
import type { ModuleNode, Edge } from './types';
import type { GroupData, ExposedPort } from './group-projection';

function child(id: string, type: string, pos = { x: 100, y: 100 }): ModuleNode {
  return {
    id,
    type,
    domain: 'audio',
    position: pos,
    params: { freq: 220 },
    data: { parentGroupId: 'group-src', extra: 1 },
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

const exposedPorts: ExposedPort[] = [
  { id: 'in--lfo-1--rate', childId: 'lfo-1', childPortId: 'rate', direction: 'input', cableType: 'cv' },
  { id: 'out--flt-1--out', childId: 'flt-1', childPortId: 'out', direction: 'output', cableType: 'audio' },
];

const groupNode: ModuleNode = {
  id: 'group-src',
  type: 'group',
  domain: 'meta',
  position: { x: 200, y: 200 },
  params: {},
  data: {
    label: 'MY FILTER STACK',
    childIds: ['lfo-1', 'flt-1'],
    exposedPorts,
  } as unknown as Record<string, unknown>,
};

const nodes: ModuleNode[] = [
  groupNode,
  child('lfo-1', 'lfo', { x: 100, y: 100 }),
  child('flt-1', 'filter', { x: 300, y: 100 }),
  child('outside-1', 'audioOut', { x: 500, y: 100 }),
];

const edges: Edge[] = [
  // internal — lfo → filter cutoff
  edge('e-internal', { n: 'lfo-1', p: 'phase0' }, { n: 'flt-1', p: 'cutoff' }),
  // external — filter → outside audio out (should NOT be captured)
  edge('e-external', { n: 'flt-1', p: 'out' }, { n: 'outside-1', p: 'L' }),
];

describe('extractSavedGroupPayload', () => {
  it('captures the group label, exposed ports, children, and internal edges', () => {
    const result = extractSavedGroupPayload({ group: groupNode, nodes, edges });
    expect(result).not.toBeNull();
    expect(result!.label).toBe('MY FILTER STACK');
    expect(result!.payload.label).toBe('MY FILTER STACK');
    expect(result!.payload.exposedPorts).toHaveLength(2);
    expect(result!.payload.children.map((c) => c.id)).toEqual(['lfo-1', 'flt-1']);
    expect(result!.payload.internalEdges.map((e) => e.id)).toEqual(['e-internal']);
  });

  it('falls back to "GROUP!" when the group has no label', () => {
    const noLabel: ModuleNode = {
      ...groupNode,
      data: { childIds: ['lfo-1'], exposedPorts: [] } as unknown as Record<string, unknown>,
    };
    const result = extractSavedGroupPayload({
      group: noLabel,
      nodes: [noLabel, child('lfo-1', 'lfo')],
      edges: [],
    });
    expect(result!.label).toBe('GROUP!');
    expect(result!.payload.label).toBe('GROUP!');
  });

  it('skips external edges (one endpoint outside the group)', () => {
    const result = extractSavedGroupPayload({ group: groupNode, nodes, edges });
    const ids = result!.payload.internalEdges.map((e) => e.id);
    expect(ids).not.toContain('e-external');
  });

  it('returns null when the group has no data', () => {
    const broken: ModuleNode = { ...groupNode, data: undefined };
    const result = extractSavedGroupPayload({ group: broken, nodes, edges });
    expect(result).toBeNull();
  });

  it('deep-clones children so subsequent live-graph mutations do not leak', () => {
    const result = extractSavedGroupPayload({ group: groupNode, nodes, edges });
    const captured = result!.payload.children[0];
    captured.params.freq = 999;
    const sourceChild = nodes.find((n) => n.id === captured.id)!;
    expect(sourceChild.params.freq).toBe(220);
  });
});

describe('resurrectSavedGroup', () => {
  it('produces a fresh group + children + edges with no id collisions', () => {
    const extracted = extractSavedGroupPayload({ group: groupNode, nodes, edges })!;
    const plan = resurrectSavedGroup({
      payload: extracted.payload,
      existingNodeIds: ['lfo-1', 'flt-1', 'group-src'],
      existingEdgeIds: ['e-internal', 'e-external'],
      groupPosition: { x: 0, y: 0 },
    });
    const existingNodeSet = new Set(['lfo-1', 'flt-1', 'group-src']);
    expect(existingNodeSet.has(plan.newGroup.id)).toBe(false);
    for (const c of plan.newChildren) expect(existingNodeSet.has(c.id)).toBe(false);
    const existingEdgeSet = new Set(['e-internal', 'e-external']);
    for (const e of plan.newEdges) expect(existingEdgeSet.has(e.id)).toBe(false);
  });

  it('rewrites exposedPorts.childId references to the new child ids', () => {
    const extracted = extractSavedGroupPayload({ group: groupNode, nodes, edges })!;
    const plan = resurrectSavedGroup({
      payload: extracted.payload,
      existingNodeIds: [],
      existingEdgeIds: [],
      groupPosition: { x: 0, y: 0 },
    });
    const newChildIds = new Set(plan.newChildren.map((c) => c.id));
    const data = plan.newGroup.data as unknown as GroupData;
    for (const ep of data.exposedPorts) {
      expect(newChildIds.has(ep.childId)).toBe(true);
    }
  });

  it('rewrites internal-edge endpoints to the new child ids', () => {
    const extracted = extractSavedGroupPayload({ group: groupNode, nodes, edges })!;
    const plan = resurrectSavedGroup({
      payload: extracted.payload,
      existingNodeIds: [],
      existingEdgeIds: [],
      groupPosition: { x: 0, y: 0 },
    });
    const newChildIds = new Set(plan.newChildren.map((c) => c.id));
    for (const e of plan.newEdges) {
      expect(newChildIds.has(e.source.nodeId)).toBe(true);
      expect(newChildIds.has(e.target.nodeId)).toBe(true);
    }
  });

  it("stamps each new child's parentGroupId to the new group id", () => {
    const extracted = extractSavedGroupPayload({ group: groupNode, nodes, edges })!;
    const plan = resurrectSavedGroup({
      payload: extracted.payload,
      existingNodeIds: [],
      existingEdgeIds: [],
      groupPosition: { x: 0, y: 0 },
    });
    for (const c of plan.newChildren) {
      expect((c.data as { parentGroupId?: string }).parentGroupId).toBe(plan.newGroup.id);
    }
  });

  it('anchors the new group at groupPosition + preserves relative child positions', () => {
    const extracted = extractSavedGroupPayload({ group: groupNode, nodes, edges })!;
    const plan = resurrectSavedGroup({
      payload: extracted.payload,
      existingNodeIds: [],
      existingEdgeIds: [],
      groupPosition: { x: 1000, y: 500 },
    });
    expect(plan.newGroup.position).toEqual({ x: 1000, y: 500 });
    const xs = plan.newChildren.map((c) => c.position.x).sort((a, b) => a - b);
    expect(xs).toEqual([900, 1100]);
    for (const c of plan.newChildren) expect(c.position.y).toBe(500);
  });

  it('drops internal-edge rows whose endpoints reference unknown child ids (forward-compat)', () => {
    const extracted = extractSavedGroupPayload({ group: groupNode, nodes, edges })!;
    extracted.payload.internalEdges.push(
      edge('e-broken', { n: 'lfo-1', p: 'phase0' }, { n: 'ghost-node', p: 'in' }),
    );
    const plan = resurrectSavedGroup({
      payload: extracted.payload,
      existingNodeIds: [],
      existingEdgeIds: [],
      groupPosition: { x: 0, y: 0 },
    });
    expect(plan.newEdges).toHaveLength(1);
  });
});

describe('round-trip', () => {
  it('preserves the relative graph shape across save → resurrect', () => {
    const extracted = extractSavedGroupPayload({ group: groupNode, nodes, edges })!;
    const plan = resurrectSavedGroup({
      payload: extracted.payload,
      existingNodeIds: [],
      existingEdgeIds: [],
      groupPosition: { x: 0, y: 0 },
    });
    expect(plan.newChildren).toHaveLength(2);
    expect(plan.newEdges).toHaveLength(1);
    expect(plan.newGroup.type).toBe('group');
    expect(plan.newGroup.domain).toBe('meta');
    const data = plan.newGroup.data as unknown as GroupData;
    expect(data.label).toBe('MY FILTER STACK');
    expect(data.exposedPorts).toHaveLength(2);
    expect(data.childIds).toEqual(plan.newChildren.map((c) => c.id));
  });

  it('round-trips exposedControls + remaps childId references (Phase 4)', () => {
    // Same group fixture but with an exposedControls entry pointing at lfo-1.
    const groupWithControls: ModuleNode = {
      ...groupNode,
      data: {
        ...(groupNode.data as Record<string, unknown>),
        exposedControls: [{ childId: 'lfo-1', controlId: 'playStop' }],
      } as unknown as Record<string, unknown>,
    };
    const extracted = extractSavedGroupPayload({
      group: groupWithControls,
      nodes: [groupWithControls, ...nodes.filter((n) => n.id !== 'group-src')],
      edges,
    })!;
    expect(extracted.payload.exposedControls).toEqual([
      { childId: 'lfo-1', controlId: 'playStop' },
    ]);

    const plan = resurrectSavedGroup({
      payload: extracted.payload,
      existingNodeIds: [],
      existingEdgeIds: [],
      groupPosition: { x: 0, y: 0 },
    });
    const data = plan.newGroup.data as unknown as GroupData;
    expect(data.exposedControls).toHaveLength(1);
    // The remap MUST point at one of the freshly-minted children.
    const newChildIds = new Set(plan.newChildren.map((c) => c.id));
    expect(newChildIds.has(data.exposedControls![0].childId)).toBe(true);
    expect(data.exposedControls![0].controlId).toBe('playStop');
  });

  it('omits exposedControls from the payload when none are set', () => {
    const extracted = extractSavedGroupPayload({ group: groupNode, nodes, edges })!;
    expect(extracted.payload.exposedControls).toBeUndefined();
  });
});
