// packages/web/src/lib/graph/delete-bridge-ydoc.test.ts
//
// BRIDGE-ON-DELETE (#1821) against the REAL Y.Doc + syncedStore + UndoManager
// — the tier `delete-bridge.test.ts` cannot reach.
//
// The pure planner proves WHAT should happen. This proves the two things only a
// real document can show:
//
//   1. **delete + bridge is ONE undo entry.** The applicator relies on Yjs
//      transaction NESTING (an inner `transact` joins the open one), which is a
//      property of the library, not of our code — so it is asserted against the
//      real `Y.UndoManager` rather than reasoned about. ⚠ A single Cmd-Z must
//      restore the node AND remove the bridge; two entries would leave the user
//      one undo away from a rack with both.
//   2. **The write ORDER inside that transaction is coherent** — the doomed
//      node's cables are gone and the bridge is present when the transaction
//      closes, with no window in which both exist.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { patch, ydoc, undoManager, LOCAL_ORIGIN } from './store';
import { removePatchNodeBridging, type BridgeResolveDef } from './mutate';
import type { ModuleNode, Edge } from './types';
import type { ValidatorDef } from './validate-edge';

const BD = 'bd';
const VO = 'vo';
const SRC = 'src';

/** The same fake registry shape the pure tier uses — the real defs are exercised
 *  by `delete-bridge.test.ts`'s live-roster anchor. */
const DEFS: Record<string, ValidatorDef> = {
  videoOut: { inputs: [{ id: 'in', type: 'video' }], outputs: [{ id: 'out', type: 'video' }] },
  backdraft: { inputs: [{ id: 'in_a', type: 'video' }], outputs: [{ id: 'out', type: 'video' }] },
  sourcery: { inputs: [{ id: 'in', type: 'video' }], outputs: [{ id: 'out', type: 'video' }] },
};
const resolveDef = ((type: string) => DEFS[type]) as BridgeResolveDef;

function node(id: string, type: string, x: number): ModuleNode {
  return { id, type, domain: 'video', position: { x, y: 0 }, params: {}, data: {} } as ModuleNode;
}

function edge(id: string, sN: string, sP: string, tN: string, tP: string): Edge {
  return {
    id,
    source: { nodeId: sN, portId: sP },
    target: { nodeId: tN, portId: tP },
    sourceType: 'video',
    targetType: 'video',
  };
}

/** backdraft ▸ videoOut ▸ sourcery, with a clean undo stack. */
function seedChain(): void {
  ydoc.transact(() => {
    patch.nodes[BD] = node(BD, 'backdraft', 0);
    patch.nodes[VO] = node(VO, 'videoOut', 200);
    patch.nodes[SRC] = node(SRC, 'sourcery', 400);
    patch.edges['e-bd-out-vo-in'] = edge('e-bd-out-vo-in', BD, 'out', VO, 'in');
    patch.edges['e-vo-out-src-in'] = edge('e-vo-out-src-in', VO, 'out', SRC, 'in');
  }, LOCAL_ORIGIN);
  undoManager.clear();
  undoManager.stopCapturing();
}

function clear(): void {
  for (const id of Object.keys(patch.edges)) delete patch.edges[id];
  for (const id of Object.keys(patch.nodes)) delete patch.nodes[id];
  undoManager.clear();
  undoManager.stopCapturing();
}

beforeEach(clear);
afterEach(clear);

describe('removePatchNodeBridging — the chain survives, in ONE undo entry', () => {
  it('deletes the OUTPUT, patches backdraft ▸ sourcery, and a single undo restores BOTH facts', () => {
    seedChain();

    const outcome = removePatchNodeBridging(VO, resolveDef)!;
    expect(outcome.refused).toEqual([]);
    expect(outcome.bridged.map((e) => e.id)).toEqual(['e-bd-out-src-in']);

    // The node and its own cables are gone…
    expect(patch.nodes[VO]).toBeUndefined();
    expect(patch.edges['e-bd-out-vo-in']).toBeUndefined();
    expect(patch.edges['e-vo-out-src-in']).toBeUndefined();
    // …and the chain is maintained by a REAL edge in the graph the engine reads.
    const bridge = patch.edges['e-bd-out-src-in'];
    expect(bridge).toBeDefined();
    expect(bridge!.source).toEqual({ nodeId: BD, portId: 'out' });
    expect(bridge!.target).toEqual({ nodeId: SRC, portId: 'in' });
    // The neighbours are untouched.
    expect(patch.nodes[BD]).toBeDefined();
    expect(patch.nodes[SRC]).toBeDefined();

    // ⚠ ONE entry, not two. This is the assertion the whole nesting argument
    // exists for.
    expect(undoManager.undoStack.length, 'delete + bridge is ONE undo entry').toBe(1);

    undoManager.undo();
    expect(patch.nodes[VO], 'undo restores the node').toBeDefined();
    expect(patch.edges['e-bd-out-vo-in']).toBeDefined();
    expect(patch.edges['e-vo-out-src-in']).toBeDefined();
    expect(patch.edges['e-bd-out-src-in'], 'undo removes the bridge too').toBeUndefined();
  });

  it('NEGATIVE CONTROL: an ORDINARY delete through the same call is also one entry and writes NO bridge', () => {
    // Output free ⇒ the planner returns null ⇒ this is exactly `removePatchNode`.
    // Asserted through the SAME function so "one entry" above cannot be an
    // artefact of the bridge path being skipped.
    ydoc.transact(() => {
      patch.nodes[BD] = node(BD, 'backdraft', 0);
      patch.nodes[VO] = node(VO, 'videoOut', 200);
      patch.edges['e-bd-out-vo-in'] = edge('e-bd-out-vo-in', BD, 'out', VO, 'in');
    }, LOCAL_ORIGIN);
    undoManager.clear();
    undoManager.stopCapturing();

    const outcome = removePatchNodeBridging(VO, resolveDef)!;
    expect(outcome.bridged).toEqual([]);
    expect(patch.nodes[VO]).toBeUndefined();
    expect(Object.keys(patch.edges)).toEqual([]);
    expect(undoManager.undoStack.length).toBe(1);
  });

  it('SELF-PATCH deletes plainly — no self-edge, no orphan, still one entry', () => {
    ydoc.transact(() => {
      patch.nodes[VO] = node(VO, 'videoOut', 200);
      patch.edges['e-vo-out-vo-in'] = edge('e-vo-out-vo-in', VO, 'out', VO, 'in');
    }, LOCAL_ORIGIN);
    undoManager.clear();
    undoManager.stopCapturing();

    const outcome = removePatchNodeBridging(VO, resolveDef)!;
    expect(outcome.bridged).toEqual([]);
    expect(patch.nodes[VO]).toBeUndefined();
    expect(Object.keys(patch.edges), 'no self-edge left behind').toEqual([]);
    expect(undoManager.undoStack.length).toBe(1);
  });

  it('a non-tracked origin bridges but is deliberately NOT undoable', () => {
    seedChain();
    removePatchNodeBridging(VO, resolveDef, { origin: 'reconciler-sweep' });
    expect(patch.edges['e-bd-out-src-in']).toBeDefined();
    expect(undoManager.undoStack.length).toBe(0);
  });

  it('an absent node and a PINNED node are both no-ops (the removePatchNode rules still hold)', () => {
    expect(removePatchNodeBridging('nope', resolveDef)).toBeNull();
    expect(undoManager.undoStack.length).toBe(0);

    seedChain();
    ydoc.transact(() => {
      (patch.nodes[VO] as ModuleNode).data!.pinned = true;
    }, LOCAL_ORIGIN);
    undoManager.clear();
    undoManager.stopCapturing();

    expect(removePatchNodeBridging(VO, resolveDef)).toBeNull();
    expect(patch.nodes[VO], 'a pinned node is refused, not bridged around').toBeDefined();
    expect(patch.edges['e-bd-out-src-in']).toBeUndefined();
    expect(undoManager.undoStack.length).toBe(0);
  });
});
