// unpatch-menu.test.ts
//
// The right-click UNPATCH affordance, in two halves:
//
//  1. buildUnpatchPlan — the PURE derivation every jack field's right-click
//     runs (which cables are seated on this hole, what each line says, when
//     "Unpatch all" appears, and — critically — that an UNPATCHED point yields
//     NO items so the surfaces leave its right-click behaviour untouched).
//
//  2. The REMOVAL SEAM the menu drives, exercised on a REAL syncedStore peer
//     pair + the app's own UndoManager (createPatch/createUndoManager from
//     graph/store). The menu deliberately re-uses the shipped edge-delete path
//     — one LOCAL_ORIGIN `delete patch.edges[id]` transact, plus the MAJOR-1
//     `wcolDetached` suppression for a reconciler-owned lane cable — so what is
//     pinned here is that this op set (a) converges to a collaborator and
//     (b) undoes as ONE unit, restoring both the edge and the suppression.
//     ([[yjs-save-load-real-ydoc]] discipline; the hidden-card peer harness.)

import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { buildUnpatchPlan } from './unpatch-menu';
import { createPatch, LOCAL_ORIGIN } from '$lib/graph/store';
import type { AnyDef } from './port-patch-helpers';
import type { Edge, ModuleNode } from '$lib/graph/types';

// ---------------------------------------------------------------------------
// Fixtures for the pure half — a minimal def registry (label only; that is all
// moduleDisplayName reads).
// ---------------------------------------------------------------------------

const DEFS: Record<string, { label: string }> = {
  clipplayer: { label: 'CLIP PLAYER' },
  sixstrum: { label: 'SIX STRUM' },
  mixmstrs: { label: 'MIXMSTRS' },
  vca: { label: 'VCA' },
};
const defLookup = (type: string) => DEFS[type] as unknown as AnyDef | undefined;

function node(id: string, type: string): ModuleNode {
  return { id, type, domain: 'audio', position: { x: 0, y: 0 }, params: {} } as ModuleNode;
}

function edge(id: string, s: [string, string], t: [string, string]): Edge {
  return {
    id,
    source: { nodeId: s[0], portId: s[1] },
    target: { nodeId: t[0], portId: t[1] },
    sourceType: 'audio',
    targetType: 'audio',
  } as Edge;
}

const NODES: Record<string, ModuleNode> = {
  'pinned-clipplayer': node('pinned-clipplayer', 'clipplayer'),
  'strum-1': node('strum-1', 'sixstrum'),
  'pinned-mixmstrs': node('pinned-mixmstrs', 'mixmstrs'),
  'vca-1': node('vca-1', 'vca'),
  'vca-2': node('vca-2', 'vca'),
};

describe('buildUnpatchPlan — the patch-point menu model', () => {
  it("the OWNER'S CASE: a lane-wired POLY input lists its one source cable", () => {
    // Exactly what a workflow lane auto-wires for a poly instrument: the clip
    // player's pitch lane → SIX STRUM's poly input, as a reconciler-owned
    // wcol- edge the user never drew and previously could not remove.
    const edges = {
      'wcol-e-poly': edge('wcol-e-poly', ['pinned-clipplayer', 'pitch1'], ['strum-1', 'poly']),
    };
    const plan = buildUnpatchPlan(edges, NODES, defLookup, {
      nodeId: 'strum-1',
      portId: 'poly',
      direction: 'input',
    });
    expect(plan.title).toBe('SIX STRUM POLY');
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].edgeId).toBe('wcol-e-poly');
    expect(plan.items[0].label).toBe('Unpatch — CLIP PLAYER PITCH1');
    // ONE cable → no "Unpatch all" line.
    expect(plan.allLabel).toBeNull();
  });

  it('an UNPATCHED point yields NO items (no unpatch affordance at all)', () => {
    const edges = {
      e1: edge('e1', ['pinned-clipplayer', 'pitch1'], ['strum-1', 'poly']),
    };
    const plan = buildUnpatchPlan(edges, NODES, defLookup, {
      nodeId: 'strum-1',
      portId: 'strum1', // a different, unpatched hole on the same card
      direction: 'input',
    });
    expect(plan.items).toEqual([]);
    expect(plan.allLabel).toBeNull();
  });

  it('DIRECTION discriminates: the same port id as input vs output', () => {
    // 'out' is strum-1's OUTPUT; nothing terminates on an input named 'out'.
    const edges = { e1: edge('e1', ['strum-1', 'out'], ['pinned-mixmstrs', 'ch1']) };
    expect(
      buildUnpatchPlan(edges, NODES, defLookup, {
        nodeId: 'strum-1',
        portId: 'out',
        direction: 'input',
      }).items,
    ).toEqual([]);
    const asOutput = buildUnpatchPlan(edges, NODES, defLookup, {
      nodeId: 'strum-1',
      portId: 'out',
      direction: 'output',
    });
    expect(asOutput.items).toHaveLength(1);
    // Outputs use the → arrow (they FEED the remote).
    expect(asOutput.items[0].label).toBe('Unpatch → MIXMSTRS CH1');
  });

  it('a FANNED-OUT output lists every consumer + an "Unpatch all (N)"', () => {
    const edges = {
      'e-c': edge('e-c', ['strum-1', 'out'], ['vca-2', 'audio']),
      'e-a': edge('e-a', ['strum-1', 'out'], ['pinned-mixmstrs', 'ch1']),
      'e-b': edge('e-b', ['strum-1', 'out'], ['vca-1', 'audio']),
    };
    const plan = buildUnpatchPlan(edges, NODES, defLookup, {
      nodeId: 'strum-1',
      portId: 'out',
      direction: 'output',
    });
    // Deterministic order (by edge id) so two peers + two runs agree.
    expect(plan.items.map((i) => i.edgeId)).toEqual(['e-a', 'e-b', 'e-c']);
    expect(plan.allLabel).toBe('Unpatch all (3)');
    // Repeat instances of one type are numbered exactly like every other
    // patch surface (moduleDisplayName is shared).
    expect(plan.items.map((i) => i.remote)).toEqual([
      'MIXMSTRS CH1',
      'VCA #1 AUDIO',
      'VCA #2 AUDIO',
    ]);
  });

  it('a duplicate cable on ONE input is individually removable (no assumed 1:1)', () => {
    const edges = {
      e1: edge('e1', ['pinned-clipplayer', 'pitch1'], ['strum-1', 'poly']),
      e2: edge('e2', ['vca-1', 'out'], ['strum-1', 'poly']),
    };
    const plan = buildUnpatchPlan(edges, NODES, defLookup, {
      nodeId: 'strum-1',
      portId: 'poly',
      direction: 'input',
    });
    expect(plan.items.map((i) => i.edgeId)).toEqual(['e1', 'e2']);
    expect(plan.allLabel).toBe('Unpatch all (2)');
  });

  it('a HALF-FORMED edge is skipped, never thrown on (runs over the live store)', () => {
    const edges = {
      bad1: { id: 'bad1' } as unknown as Edge,
      bad2: { id: 'bad2', source: { nodeId: 1 }, target: {} } as unknown as Edge,
      ok: edge('ok', ['pinned-clipplayer', 'pitch1'], ['strum-1', 'poly']),
    };
    const plan = buildUnpatchPlan(edges, NODES, defLookup, {
      nodeId: 'strum-1',
      portId: 'poly',
      direction: 'input',
    });
    expect(plan.items.map((i) => i.edgeId)).toEqual(['ok']);
  });

  it('falls back to the node TYPE when a remote module has no def', () => {
    const edges = { e1: edge('e1', ['ghost-1', 'out'], ['strum-1', 'poly']) };
    const nodes = { ...NODES, 'ghost-1': node('ghost-1', 'notregistered') };
    const plan = buildUnpatchPlan(edges, nodes, defLookup, {
      nodeId: 'strum-1',
      portId: 'poly',
      direction: 'input',
    });
    expect(plan.items[0].label).toBe('Unpatch — notregistered OUT');
  });
});

// ---------------------------------------------------------------------------
// The removal seam — real Y.Doc peers + the app's UndoManager.
// ---------------------------------------------------------------------------

const WCOL_ID = 'wcol-e-pinned-clipplayer-pitch1-strum-1-poly';

/** The EXACT op set Canvas's unpatchEdges runs for a managed lane cable. */
function unpatch(
  peer: ReturnType<typeof createPatch>,
  edgeId: string,
  colKey: string | null,
): void {
  peer.ydoc.transact(() => {
    if (colKey && edgeId.startsWith('wcol-e-')) {
      const mixer = peer.patch.nodes['pinned-mixmstrs'];
      if (mixer) {
        if (!mixer.data) mixer.data = {};
        const d = mixer.data as { wcolDetached?: Record<string, string[]> };
        if (!d.wcolDetached) d.wcolDetached = {};
        const cur = d.wcolDetached[colKey] ?? [];
        if (!cur.includes(edgeId)) d.wcolDetached[colKey] = [...cur, edgeId];
      }
    }
    delete peer.patch.edges[edgeId];
  }, LOCAL_ORIGIN);
}

/** The suppression set on the pinned mixer, as the reconcile reads it. */
function detached(
  peer: ReturnType<typeof createPatch>,
): Record<string, string[]> | undefined {
  const d = peer.patch.nodes['pinned-mixmstrs']?.data as
    | { wcolDetached?: Record<string, string[]> }
    | undefined;
  return d?.wcolDetached;
}

function seed(peer: ReturnType<typeof createPatch>): void {
  peer.ydoc.transact(() => {
    peer.patch.nodes['pinned-mixmstrs'] = { ...node('pinned-mixmstrs', 'mixmstrs'), data: {} } as ModuleNode;
    peer.patch.nodes['strum-1'] = { ...node('strum-1', 'sixstrum'), data: { channel: 1 } } as ModuleNode;
    peer.patch.edges[WCOL_ID] = edge(
      WCOL_ID,
      ['pinned-clipplayer', 'pitch1'],
      ['strum-1', 'poly'],
    );
  });
}

function converge(a: ReturnType<typeof createPatch>, b: ReturnType<typeof createPatch>): void {
  Y.applyUpdate(b.ydoc, Y.encodeStateAsUpdate(a.ydoc));
  Y.applyUpdate(a.ydoc, Y.encodeStateAsUpdate(b.ydoc));
}

describe('unpatch removal seam — real syncedStore peers + UndoManager', () => {
  it('the removal CONVERGES: a collaborator sees the cable gone', () => {
    const a = createPatch();
    const b = createPatch();
    seed(a);
    converge(a, b);
    expect(b.patch.edges[WCOL_ID]).toBeDefined();

    unpatch(a, WCOL_ID, '1');
    converge(a, b);

    expect(a.patch.edges[WCOL_ID]).toBeUndefined();
    expect(b.patch.edges[WCOL_ID]).toBeUndefined();
    // …and the suppression marker rode the SAME sync, so the collaborator's
    // reconcile pass will not re-add the lane cable either.
    expect(detached(b)?.['1']).toEqual([WCOL_ID]);
  });

  it('UNDO restores the cable AND clears the suppression (ONE undo unit)', () => {
    const a = createPatch();
    seed(a);
    // The seed is not the unit under test — start the undo stack clean.
    a.undoManager.clear();

    unpatch(a, WCOL_ID, '1');
    expect(a.patch.edges[WCOL_ID]).toBeUndefined();

    a.undoManager.undo();
    const restored = a.patch.edges[WCOL_ID];
    expect(restored).toBeDefined();
    expect(restored!.target).toEqual({ nodeId: 'strum-1', portId: 'poly' });
    // Both writes were one LOCAL_ORIGIN transact → one undo entry, so the
    // detach suppression is lifted with the cable (else the reconcile would
    // immediately delete the cable undo just restored).
    expect(detached(a)?.['1'] ?? []).toEqual([]);

    // Redo removes it again — the round trip is symmetric.
    a.undoManager.redo();
    expect(a.patch.edges[WCOL_ID]).toBeUndefined();
  });

  it('a HAND-DRAWN cable is removed without planting any suppression marker', () => {
    const a = createPatch();
    const b = createPatch();
    seed(a);
    a.ydoc.transact(() => {
      a.patch.edges['e-hand'] = edge('e-hand', ['vca-1', 'out'], ['strum-1', 'poly']);
    });
    converge(a, b);

    unpatch(a, 'e-hand', '1'); // colKey resolves, but the id is not wcol-
    converge(a, b);

    expect(b.patch.edges['e-hand']).toBeUndefined();
    expect(b.patch.edges[WCOL_ID]).toBeDefined(); // untouched
    expect(detached(b)).toBeUndefined();
  });
});
