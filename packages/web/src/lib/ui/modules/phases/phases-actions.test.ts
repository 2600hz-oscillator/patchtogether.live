import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { patch, ydoc, undoManager, LOCAL_ORIGIN, createPatch } from '$lib/graph/store';
import { sanitizePhasesVertices, type PhasesVertex } from '../../../../../../dsp/src/lib/phases-dsp';
import { registerPhasesRuntimeMode } from '$lib/audio/phases-runtime';
import {
  readPhasesVertices, writePhasesVertices, setPhasesVertexY,
  setPhasesShape, addPhasesVertex, removePhasesVertex, setPhasesMode,
} from './phases-actions';

const ID = 'phases-edit-test';
const POINTS = [
  { x: 0, y: 0, shape: 0.5 },
  { x: 0.4, y: 0.8, shape: 1 },
  { x: 1, y: 0.2, shape: 0 },
];

beforeEach(() => {
  ydoc.transact(() => {
    patch.nodes[ID] = {
      id: ID, type: 'phases', domain: 'audio', position: { x: 0, y: 0 },
      params: { loop: 0, reverse: 0, polarity: 0, length: 0.05 },
      data: { vertices: POINTS.map((v) => ({ ...v })), label: 'keep me' },
    };
  }, LOCAL_ORIGIN);
  undoManager.clear();
  undoManager.stopCapturing();
});
afterEach(() => { delete patch.nodes[ID]; undoManager.clear(); });

describe('Phases edits against the real collaborative graph', () => {
  it('deletes an interior vertex in one undoable edit and retains the left shape', () => {
    expect(removePhasesVertex(ID, 0.4)).toBe(0);
    expect(readPhasesVertices(ID)).toEqual([POINTS[0], POINTS[2]]);
    expect(patch.nodes[ID]!.data!.label).toBe('keep me');
    expect(undoManager.undoStack).toHaveLength(1);
    undoManager.undo();
    expect(readPhasesVertices(ID)).toEqual(POINTS);
    undoManager.redo();
    expect(readPhasesVertices(ID)[0]!.shape).toBe(0.5);
    expect(readPhasesVertices(ID)).toHaveLength(2);
  });

  it('vertical dragging and shape writes preserve all other vertex properties', () => {
    setPhasesVertexY(ID, 0.4, 0.25);
    setPhasesShape(ID, 0.4, 0.6);
    expect(readPhasesVertices(ID)).toEqual([
      POINTS[0], { x: 0.4, y: 0.25, shape: 0.6 }, POINTS[2],
    ]);
    expect(POINTS[1]).toEqual({ x: 0.4, y: 0.8, shape: 1 });
  });

  it('keeps both boundary vertices and ignores a drag after its vertex disappeared', () => {
    expect(removePhasesVertex(ID, 0)).toBeNull();
    expect(removePhasesVertex(ID, 1)).toBeNull();
    expect(undoManager.undoStack).toHaveLength(0);
    removePhasesVertex(ID, 0.4);
    setPhasesVertexY(ID, 0.4, 1);
    setPhasesShape(ID, 0.4, 0.2);
    expect(readPhasesVertices(ID)).toEqual([POINTS[0], POINTS[2]]);
  });

  it('writes fresh arrays without losing existing node metadata', () => {
    writePhasesVertices(ID, POINTS);
    setPhasesVertexY(ID, 1, 1.5);
    setPhasesVertexY(ID, 0, -1);
    expect(readPhasesVertices(ID).map((v) => v.y)).toEqual([0, 0.8, 1]);
    expect(patch.nodes[ID]!.data!.label).toBe('keep me');
  });

  it('merges simultaneous peer edits to distinct vertex fields without losing either', () => {
    const peer = createPatch();
    try {
      Y.applyUpdate(peer.ydoc, Y.encodeStateAsUpdate(ydoc));
      setPhasesVertexY(ID, 0.4, 0.3);
      setPhasesShape(ID, 0, 0.25);
      peer.ydoc.transact(() => {
        const vertices = peer.patch.nodes[ID]!.data!.vertices as PhasesVertex[];
        vertices[1]!.shape = 0.2;
        vertices[2]!.y = 0.9;
      });
      Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(peer.ydoc));
      Y.applyUpdate(peer.ydoc, Y.encodeStateAsUpdate(ydoc));
      const expected = [
        { x: 0, y: 0, shape: 0.25 },
        { x: 0.4, y: 0.3, shape: 0.2 },
        { x: 1, y: 0.9, shape: 0 },
      ];
      expect(readPhasesVertices(ID)).toEqual(expected);
      expect(sanitizePhasesVertices(peer.patch.nodes[ID]!.data!.vertices)).toEqual(expected);
      undoManager.undo();
      expect(readPhasesVertices(ID)).toEqual([
        POINTS[0], { ...POINTS[1], shape: 0.2 }, { ...POINTS[2], y: 0.9 },
      ]);
    } finally { peer.undoManager.destroy(); peer.ydoc.destroy(); }
  });

  it.each(['insert', 'delete'] as const)('%s retains a concurrent peer level and left phase shape edit', (action) => {
    const peer = createPatch();
    try {
      Y.applyUpdate(peer.ydoc, Y.encodeStateAsUpdate(ydoc));
      if (action === 'insert') expect(addPhasesVertex(ID, 0.2)?.x).toBe(0.2);
      else removePhasesVertex(ID, 0.4);
      peer.ydoc.transact(() => {
        const vertices = peer.patch.nodes[ID]!.data!.vertices as PhasesVertex[];
        vertices[0]!.shape = 0.9;
        vertices[2]!.y = 0.6;
      });
      Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(peer.ydoc));
      Y.applyUpdate(peer.ydoc, Y.encodeStateAsUpdate(ydoc));
      const result = readPhasesVertices(ID);
      expect(result[0]!.shape).toBe(0.9);
      expect(result.at(-1)!.y).toBe(0.6);
      expect(result).toHaveLength(action === 'insert' ? 4 : 2);
      expect(sanitizePhasesVertices(peer.patch.nodes[ID]!.data!.vertices)).toEqual(result);
    } finally { peer.undoManager.destroy(); peer.ydoc.destroy(); }
  });

  it('deletes the visible vertex after two peers concurrently insert at the same position', () => {
    const peer = createPatch();
    try {
      Y.applyUpdate(peer.ydoc, Y.encodeStateAsUpdate(ydoc));
      const added = addPhasesVertex(ID, 0.2)!;
      peer.ydoc.transact(() => {
        const vertices = peer.patch.nodes[ID]!.data!.vertices as PhasesVertex[];
        vertices.splice(1, 0, { ...added });
      });
      Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(peer.ydoc));
      Y.applyUpdate(peer.ydoc, Y.encodeStateAsUpdate(ydoc));
      const raw = () => patch.nodes[ID]!.data!.vertices as PhasesVertex[];
      expect(raw().filter((v) => v.x === 0.2)).toHaveLength(2);
      expect(readPhasesVertices(ID)).toHaveLength(4);

      undoManager.stopCapturing();
      expect(removePhasesVertex(ID, 0.2)).toBe(0);
      expect(readPhasesVertices(ID), 'a hidden duplicate must not make Delete appear ineffective').toEqual(POINTS);
      expect(raw().some((v) => v.x === 0.2)).toBe(false);
      Y.applyUpdate(peer.ydoc, Y.encodeStateAsUpdate(ydoc));
      expect(sanitizePhasesVertices(peer.patch.nodes[ID]!.data!.vertices)).toEqual(POINTS);

      undoManager.undo();
      expect(readPhasesVertices(ID)).toHaveLength(4);
      expect(raw().filter((v) => v.x === 0.2)).toHaveLength(2);
    } finally { peer.undoManager.destroy(); peer.ydoc.destroy(); }
  });

  it('delivers explicit manual mode even when a gate changed only the runtime', () => {
    const mode = vi.fn();
    const dispose = registerPhasesRuntimeMode(ID, mode);
    try {
      setPhasesMode(ID, 'loop', 0);
      setPhasesMode(ID, 'loop', 0);
      expect(mode.mock.calls).toEqual([['loop', false], ['loop', false]]);
      setPhasesMode(ID, 'reverse', 1);
      expect(mode).toHaveBeenLastCalledWith('reverse', true);
      expect(patch.nodes[ID]!.params.reverse).toBe(1);
      undoManager.undo();
      expect(patch.nodes[ID]!.params.reverse).toBe(0);
    } finally { dispose(); }
    setPhasesMode('missing-phases', 'loop', 1);
    expect(patch.nodes['missing-phases']).toBeUndefined();
  });
});
