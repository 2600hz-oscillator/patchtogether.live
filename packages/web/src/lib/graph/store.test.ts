// Unit coverage for the patch store's UndoManager wiring.
//
// Verifies:
//   - the manager only captures edits authored with LOCAL_ORIGIN (so a
//     remote collaborator's ops never end up on a local user's undo stack);
//   - the captureTimeout collapses bursts of LOCAL_ORIGIN edits within
//     ~500ms into a single undoable unit;
//   - structural ops batched into one transact() are always one entry;
//   - undo / redo round-trip leaves the patch graph identical.

import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { syncedStore, getYjsDoc } from '@syncedstore/core';
import { createUndoManager, LOCAL_ORIGIN } from './store';
import type { ModuleNode, Edge } from './types';

type PatchStore = { nodes: Record<string, ModuleNode>; edges: Record<string, Edge> };

function freshPatch() {
  const patch = syncedStore<PatchStore>({ nodes: {}, edges: {} });
  const ydoc = getYjsDoc(patch);
  const undoManager = createUndoManager(ydoc);
  return { patch, ydoc, undoManager };
}

type LivePatch = ReturnType<typeof freshPatch>['patch'];

function addNode(patch: LivePatch, id: string) {
  patch.nodes[id] = {
    id,
    type: 'analogVco',
    domain: 'audio',
    position: { x: 0, y: 0 },
    params: {},
  };
}

describe('createUndoManager — origin filter', () => {
  it('captures edits made with LOCAL_ORIGIN', () => {
    const { patch, ydoc, undoManager } = freshPatch();
    ydoc.transact(() => addNode(patch, 'a'), LOCAL_ORIGIN);
    expect(undoManager.undoStack.length).toBe(1);
    expect(patch.nodes.a).toBeDefined();
    undoManager.undo();
    expect(patch.nodes.a).toBeUndefined();
  });

  it('does NOT capture edits with no origin (treated as remote)', () => {
    const { patch, ydoc, undoManager } = freshPatch();
    ydoc.transact(() => addNode(patch, 'a'));
    expect(undoManager.undoStack.length).toBe(0);
    undoManager.undo();
    expect(patch.nodes.a).toBeDefined();
  });

  it('does NOT capture edits with a different origin (remote collaborator)', () => {
    const { patch, ydoc, undoManager } = freshPatch();
    const REMOTE = Symbol('remote-origin');
    ydoc.transact(() => addNode(patch, 'a'), REMOTE);
    expect(undoManager.undoStack.length).toBe(0);
    undoManager.undo();
    expect(patch.nodes.a).toBeDefined();
  });

  it('mixed local + remote edits: undo only reverts the local one', () => {
    const { patch, ydoc, undoManager } = freshPatch();
    ydoc.transact(() => addNode(patch, 'remote-1'));
    ydoc.transact(() => addNode(patch, 'local-1'), LOCAL_ORIGIN);
    expect(undoManager.undoStack.length).toBe(1);
    undoManager.undo();
    expect(patch.nodes['remote-1']).toBeDefined();
    expect(patch.nodes['local-1']).toBeUndefined();
  });
});

describe('createUndoManager — captureTimeout coalescing', () => {
  it('collapses LOCAL_ORIGIN ops in the same transact into one undo entry', () => {
    const { patch, ydoc, undoManager } = freshPatch();
    ydoc.transact(() => {
      addNode(patch, 'a');
      addNode(patch, 'b');
      addNode(patch, 'c');
    }, LOCAL_ORIGIN);
    expect(undoManager.undoStack.length).toBe(1);
    undoManager.undo();
    expect(patch.nodes.a).toBeUndefined();
    expect(patch.nodes.b).toBeUndefined();
    expect(patch.nodes.c).toBeUndefined();
  });

  it('two transacts within captureTimeout collapse to one undo entry', () => {
    const { patch, ydoc, undoManager } = freshPatch();
    ydoc.transact(() => addNode(patch, 'a'), LOCAL_ORIGIN);
    ydoc.transact(() => addNode(patch, 'b'), LOCAL_ORIGIN);
    expect(undoManager.undoStack.length).toBe(1);
    undoManager.undo();
    expect(patch.nodes.a).toBeUndefined();
    expect(patch.nodes.b).toBeUndefined();
  });

  it('two transacts separated by stopCapturing() are two undo entries', () => {
    const { patch, ydoc, undoManager } = freshPatch();
    ydoc.transact(() => addNode(patch, 'a'), LOCAL_ORIGIN);
    undoManager.stopCapturing();
    ydoc.transact(() => addNode(patch, 'b'), LOCAL_ORIGIN);
    expect(undoManager.undoStack.length).toBe(2);
    undoManager.undo();
    expect(patch.nodes.a).toBeDefined();
    expect(patch.nodes.b).toBeUndefined();
    undoManager.undo();
    expect(patch.nodes.a).toBeUndefined();
  });
});

describe('createUndoManager — round trip', () => {
  it('undo then redo restores the same state', () => {
    const { patch, ydoc, undoManager } = freshPatch();
    ydoc.transact(() => addNode(patch, 'a'), LOCAL_ORIGIN);
    undoManager.stopCapturing();
    ydoc.transact(() => {
      patch.edges['e1'] = {
        id: 'e1',
        source: { nodeId: 'a', portId: 'out' },
        target: { nodeId: 'a', portId: 'in' },
        sourceType: 'audio',
        targetType: 'audio',
      };
    }, LOCAL_ORIGIN);

    expect(Object.keys(patch.nodes).length).toBe(1);
    expect(Object.keys(patch.edges).length).toBe(1);

    undoManager.undo();
    expect(Object.keys(patch.edges).length).toBe(0);
    expect(Object.keys(patch.nodes).length).toBe(1);

    undoManager.redo();
    expect(Object.keys(patch.edges).length).toBe(1);
    expect(patch.edges['e1']).toBeDefined();
  });

  it('a fresh local edit clears the redo stack', () => {
    const { patch, ydoc, undoManager } = freshPatch();
    ydoc.transact(() => addNode(patch, 'a'), LOCAL_ORIGIN);
    undoManager.undo();
    expect(undoManager.redoStack.length).toBe(1);
    ydoc.transact(() => addNode(patch, 'b'), LOCAL_ORIGIN);
    expect(undoManager.redoStack.length).toBe(0);
  });
});

describe('createUndoManager — sanity', () => {
  it('LOCAL_ORIGIN is a unique symbol', () => {
    expect(typeof LOCAL_ORIGIN).toBe('symbol');
    expect(LOCAL_ORIGIN.description).toBe('local-undo-origin');
  });

  it('returns a Y.UndoManager instance', () => {
    const ydoc = new Y.Doc();
    const um = createUndoManager(ydoc);
    expect(um).toBeInstanceOf(Y.UndoManager);
  });
});
