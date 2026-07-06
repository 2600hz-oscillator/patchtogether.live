// Unit tests for the node-scoped version registry (node-versions.svelte.ts)
// — the replacement for the ~18 per-component whole-doc ydoc.on('update')
// version pumps. Real store singleton (never mocks), reading the version
// getters untracked (outside a reactive context).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { patch, ydoc, bindRackspace } from './store';
import {
  nodeVersion,
  edgesVersion,
  nodesStructuralVersion,
  docVersion,
} from './node-versions.svelte';
import type { ModuleNode, Edge } from './types';

const AID = 'nv-node-a';
const BID = 'nv-node-b';
const EID = 'nv-edge-1';

function seed(id: string): void {
  patch.nodes[id] = {
    id,
    type: 'analogVco',
    domain: 'audio',
    position: { x: 0, y: 0 },
    params: { freq: 0.25 },
    data: { steps: [1, 2, 3] },
  } as unknown as ModuleNode;
}

describe('node-versions registry', () => {
  beforeEach(() => {
    seed(AID);
    seed(BID);
  });
  afterEach(() => {
    if (patch.nodes[AID]) delete patch.nodes[AID];
    if (patch.nodes[BID]) delete patch.nodes[BID];
    if (patch.edges[EID]) delete patch.edges[EID];
  });

  it('a param write bumps ONLY the touched node (the whole point)', () => {
    const a0 = nodeVersion(AID);
    const b0 = nodeVersion(BID);
    const e0 = edgesVersion();
    const s0 = nodesStructuralVersion();
    ydoc.transact(() => {
      patch.nodes[AID]!.params.freq = 0.5;
    });
    expect(nodeVersion(AID)).toBeGreaterThan(a0);
    expect(nodeVersion(BID)).toBe(b0);
    expect(edgesVersion()).toBe(e0);
    expect(nodesStructuralVersion()).toBe(s0);
  });

  it('a DEEP data write (steps key reassign under a stable data ref) bumps the node', () => {
    const a0 = nodeVersion(AID);
    ydoc.transact(() => {
      (patch.nodes[AID]!.data as { steps: number[] }).steps = [7, 8, 9];
    });
    expect(nodeVersion(AID)).toBeGreaterThan(a0);
  });

  it('an edge add/remove bumps edgesVersion, not any nodeVersion', () => {
    const a0 = nodeVersion(AID);
    const e0 = edgesVersion();
    patch.edges[EID] = {
      id: EID,
      source: { nodeId: AID, portId: 'out' },
      target: { nodeId: BID, portId: 'in' },
      sourceType: 'audio',
      targetType: 'audio',
    } as unknown as Edge;
    expect(edgesVersion()).toBeGreaterThan(e0);
    expect(nodeVersion(AID)).toBe(a0);
    const e1 = edgesVersion();
    delete patch.edges[EID];
    expect(edgesVersion()).toBeGreaterThan(e1);
  });

  it('node add/remove bumps structural + the touched id', () => {
    const s0 = nodesStructuralVersion();
    const CID = 'nv-node-c';
    const c0 = nodeVersion(CID);
    seed(CID);
    expect(nodesStructuralVersion()).toBeGreaterThan(s0);
    expect(nodeVersion(CID)).toBeGreaterThan(c0);
    const s1 = nodesStructuralVersion();
    delete patch.nodes[CID];
    expect(nodesStructuralVersion()).toBeGreaterThan(s1);
  });

  it('docVersion bumps on every transaction (the legacy escape hatch)', () => {
    const d0 = docVersion();
    ydoc.transact(() => {
      patch.nodes[AID]!.params.freq = 0.33;
    });
    expect(docVersion()).toBe(d0 + 1);
  });

  it('rebind clears per-node versions and re-attaches to the new doc', () => {
    ydoc.transact(() => {
      patch.nodes[AID]!.params.freq = 0.4;
    });
    expect(nodeVersion(AID)).toBeGreaterThan(0);

    // Swap the rackspace — the registry must drop the old id space and
    // observe the NEW doc. (bindRackspace swaps the store singleton; the
    // live `patch`/`ydoc` bindings re-read below observe the new doc.)
    bindRackspace(`node-versions-test-${Date.now()}`);
    expect(nodeVersion(AID)).toBe(0);

    seed(AID);
    const a0 = nodeVersion(AID);
    ydoc.transact(() => {
      patch.nodes[AID]!.params.freq = 0.9;
    });
    expect(nodeVersion(AID)).toBeGreaterThan(a0);
    // cleanup for the shared-process suite: leave a bound, seeded-empty store
    delete patch.nodes[AID];
  });
});
