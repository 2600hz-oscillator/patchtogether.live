// packages/web/src/lib/graph/hidden-card.test.ts
//
// WORKFLOW MODE P4 — the `hiddenCard` node-data flag:
//
//   * the visibility predicates (isHiddenCardNode / isCanvasHiddenNode) —
//     the EXACT rule Canvas's flowNodes derivation + defensive edge
//     filter apply, exercised as the canvas filter would;
//   * hiddenCard vs pinned semantics: hidden nodes COUNT toward
//     `maxInstances` (cap.ts) where pinned ones don't;
//   * REAL Y.Doc round-trip (syncedStore peer harness —
//     workflow-pins-ydoc precedent): the flag is ordinary synced node
//     data, so a COLLABORATOR converges to the same hidden node (and
//     their canvas filter hides it too), a peer's delete converges, and
//     an encode/apply persistence cycle preserves the flag.

import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { syncedStore, getYjsDoc } from '@syncedstore/core';
import type { ModuleNode, Edge } from './types';
import { isHiddenCardNode, isCanvasHiddenNode } from './hidden-card';
import { instanceCount, wouldExceedCap } from './cap';

type PatchStore = { nodes: Record<string, ModuleNode>; edges: Record<string, Edge> };

interface Peer {
  patch: ReturnType<typeof syncedStore<PatchStore>>;
  doc: Y.Doc;
}

function makePeer(): Peer {
  const patch = syncedStore<PatchStore>({ nodes: {}, edges: {} });
  const doc = getYjsDoc(patch);
  return { patch, doc };
}

function converge(a: Peer, b: Peer): void {
  Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
  Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc));
}

function node(
  id: string,
  type: string,
  data: Record<string, unknown> | undefined = undefined,
): ModuleNode {
  return {
    id,
    type,
    domain: type === 'cameraInput' ? 'video' : 'audio',
    position: { x: 24, y: 24 },
    params: {},
    ...(data !== undefined ? { data } : {}),
  } as ModuleNode;
}

/** The canvas filter as Canvas.svelte applies it: visible nodes only. */
function visibleNodes(nodes: ModuleNode[]): ModuleNode[] {
  return nodes.filter((n) => !isCanvasHiddenNode(n));
}

describe('isHiddenCardNode / isCanvasHiddenNode', () => {
  it('only a literal data.hiddenCard === true marks a node hidden', () => {
    expect(isHiddenCardNode(node('a', 'cameraInput', { hiddenCard: true }))).toBe(true);
    expect(isHiddenCardNode(node('b', 'cameraInput', { hiddenCard: false }))).toBe(false);
    expect(isHiddenCardNode(node('c', 'cameraInput', { hiddenCard: 'yes' }))).toBe(false);
    expect(isHiddenCardNode(node('d', 'cameraInput', {}))).toBe(false);
    expect(isHiddenCardNode(node('e', 'cameraInput'))).toBe(false);
    expect(isHiddenCardNode(null)).toBe(false);
    expect(isHiddenCardNode(undefined)).toBe(false);
  });

  it('isCanvasHiddenNode = pinned OR hiddenCard (the single canvas rule)', () => {
    expect(isCanvasHiddenNode(node('a', 'mixmstrs', { pinned: true }))).toBe(true);
    expect(isCanvasHiddenNode(node('b', 'cameraInput', { hiddenCard: true }))).toBe(true);
    expect(isCanvasHiddenNode(node('c', 'cameraInput', {}))).toBe(false);
    expect(isCanvasHiddenNode(node('d', 'vco'))).toBe(false);
  });

  it('the canvas filter hides hidden-flag nodes and keeps everything else', () => {
    const nodes = [
      node('cam-hidden', 'cameraInput', { hiddenCard: true }),
      node('cam-card', 'cameraInput', { deviceId: 'abc' }),
      node('pin', 'mixmstrs', { pinned: true }),
      node('osc', 'vco'),
    ];
    expect(visibleNodes(nodes).map((n) => n.id)).toEqual(['cam-card', 'osc']);
  });
});

describe('hiddenCard vs pinned: the cap economy', () => {
  it('hidden cameras COUNT toward maxInstances; pinned nodes do not', () => {
    const nodes = {
      a: node('a', 'cameraInput', { hiddenCard: true }),
      b: node('b', 'cameraInput', { hiddenCard: true }),
      c: node('c', 'cameraInput', {}), // ordinary canvas CAMERA card
      d: node('d', 'cameraInput', { pinned: true }), // hypothetical pin — excluded
    };
    expect(instanceCount(nodes, 'cameraInput')).toBe(3);
  });

  it('wouldExceedCap trips when hidden + canvas cameras reach the def cap', () => {
    const def = { type: 'cameraInput', maxInstances: 4 };
    const nodes: Record<string, ModuleNode> = {
      a: node('a', 'cameraInput', { hiddenCard: true }),
      b: node('b', 'cameraInput', { hiddenCard: true }),
      c: node('c', 'cameraInput', { hiddenCard: true }),
    };
    expect(wouldExceedCap(nodes, def)).toBe(false); // 3 of 4 — one slot left
    nodes.d = node('d', 'cameraInput', {}); // a canvas card takes the last slot
    expect(wouldExceedCap(nodes, def)).toBe(true); // 4 of 4 — refuse the 5th
  });
});

describe('hiddenCard on real Y.Docs (collaborator + persistence semantics)', () => {
  it('a collaborator converges to the hidden node and their canvas filter hides it too', () => {
    const a = makePeer();
    const b = makePeer();
    a.doc.transact(() => {
      a.patch.nodes['wfcam-1'] = node('wfcam-1', 'cameraInput', {
        hiddenCard: true,
        name: 'CAMERAINPUT',
      });
      a.patch.nodes['osc'] = node('osc', 'vco');
    });
    converge(a, b);

    const bNodes = Object.values(b.patch.nodes).filter((n): n is ModuleNode => !!n);
    const bCam = bNodes.find((n) => n.id === 'wfcam-1');
    expect(bCam).toBeDefined();
    // The flag rode ordinary node-data sync…
    expect(isHiddenCardNode(bCam)).toBe(true);
    // …so the collaborator's canvas ALSO renders no card for it.
    expect(visibleNodes(bNodes).map((n) => n.id)).toEqual(['osc']);
  });

  it('unmap converges: a peer deleting the node + its edges removes it everywhere', () => {
    const a = makePeer();
    const b = makePeer();
    a.doc.transact(() => {
      a.patch.nodes['wfcam-1'] = node('wfcam-1', 'cameraInput', { hiddenCard: true });
      a.patch.nodes['fx'] = node('fx', 'chroma');
      a.patch.edges['e-1'] = {
        id: 'e-1',
        source: { nodeId: 'wfcam-1', portId: 'out' },
        target: { nodeId: 'fx', portId: 'in' },
        sourceType: 'video',
        targetType: 'video',
      } as Edge;
    });
    converge(a, b);

    // Peer B unmaps (the removePatchNode shape: edges first, then the node,
    // one transact — hidden nodes are NOT pinned, so no refusal applies).
    b.doc.transact(() => {
      for (const [eid, edge] of Object.entries(b.patch.edges)) {
        if (edge && (edge.source.nodeId === 'wfcam-1' || edge.target.nodeId === 'wfcam-1')) {
          delete b.patch.edges[eid];
        }
      }
      delete b.patch.nodes['wfcam-1'];
    });
    converge(a, b);

    expect(a.patch.nodes['wfcam-1']).toBeUndefined();
    expect(Object.keys(a.patch.edges)).toEqual([]);
    expect(b.patch.nodes['wfcam-1']).toBeUndefined();
  });

  it('the flag survives a full encode/apply persistence cycle (quicksave-shaped)', () => {
    const a = makePeer();
    a.doc.transact(() => {
      a.patch.nodes['wfcam-1'] = node('wfcam-1', 'cameraInput', {
        hiddenCard: true,
        name: 'CAMERAINPUT2',
        deviceId: 'saved-device',
      });
    });
    // Encode the whole doc, load into a fresh one (reload/quickload shape).
    const bytes = Y.encodeStateAsUpdate(a.doc);
    const fresh = makePeer();
    Y.applyUpdate(fresh.doc, bytes);

    const cam = fresh.patch.nodes['wfcam-1'];
    expect(cam).toBeDefined();
    expect(isHiddenCardNode(cam)).toBe(true);
    // The module's OWN persistence (device choice) rode along unchanged.
    expect((cam!.data as { deviceId?: string }).deviceId).toBe('saved-device');
    expect((cam!.data as { name?: string }).name).toBe('CAMERAINPUT2');
  });
});
