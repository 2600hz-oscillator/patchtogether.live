// packages/web/src/lib/graph/undo-cap.test.ts
//
// The undo depth cap (undo-cap.ts). The claims under test are the ones the
// header derives its numbers from:
//
//   1. RECLAMATION — a capped, aged doc encodes near the no-undo floor, an
//      order of magnitude under the unbounded one. This is the whole point.
//   2. THE SPLICE-ONLY TRAP (negative control) — dropping stack entries
//      WITHOUT releasing their keep flags reclaims nothing. This is the
//      mistake the release path exists to make impossible; if this control
//      ever starts passing, the assertion in (1) has gone vacuous.
//   3. UNDO STILL WORKS to the full retained depth after heavy trimming, and
//      restores real content — the cap must never corrupt what it keeps.
//   4. REDO is bounded by construction — it is fed only by undo() pops.
//
// Docs are built raw (no store singleton import): the cap attaches to any
// (Y.Doc, UndoManager) pair, and the store wires it in createUndoManager.

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { UNDO_STACK_CAP, attachUndoCap } from './undo-cap';

const LOCAL = Symbol('test-local');

function makeDoc() {
  const ydoc = new Y.Doc(); // gc: default true, matching the app
  const nodes = ydoc.getMap('nodes');
  const um = new Y.UndoManager([nodes, ydoc.getMap('edges')], {
    captureTimeout: 0, // 1 edit = 1 step; real users pause >500ms between undo units
    trackedOrigins: new Set<unknown>([LOCAL]),
  });
  return { ydoc, nodes, um };
}

function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A realistic aging mix: mostly param settles, some add/delete pairs whose
 *  payloads carry real tombstone weight (a 64-step pattern). */
function age(ydoc: Y.Doc, nodes: Y.Map<unknown>, steps: number): void {
  const rand = mulberry32(7);
  const ids: string[] = [];
  ydoc.transact(() => {
    for (let i = 0; i < 20; i++) {
      ids.push(`seed${i}`);
      nodes.set(`seed${i}`, { type: 'tidyVco', data: { p: rand() } });
    }
  }, LOCAL);
  for (let i = 0; i < steps; i++) {
    const r = rand();
    ydoc.transact(() => {
      if (r < 0.7) {
        const id = ids[Math.floor(rand() * ids.length)]!;
        nodes.set(id, { type: 'tidyVco', data: { p: rand() } });
      } else if (r < 0.85 || ids.length < 8) {
        const id = `n${i}`;
        ids.push(id);
        nodes.set(id, {
          type: 'clipplayer',
          data: { pattern: Array.from({ length: 64 }, () => Math.floor(rand() * 128)) },
        });
      } else {
        const at = Math.floor(rand() * ids.length);
        nodes.delete(ids[at]!);
        ids.splice(at, 1);
      }
    }, LOCAL);
  }
}

const STEPS = 3000;

describe('undo depth cap', () => {
  it('RECLAIMS: a capped aged doc encodes an order of magnitude under an unbounded one', () => {
    const unbounded = makeDoc();
    age(unbounded.ydoc, unbounded.nodes, STEPS);
    const unboundedSize = Y.encodeStateAsUpdate(unbounded.ydoc).length;

    const capped = makeDoc();
    attachUndoCap(capped.ydoc, capped.um);
    age(capped.ydoc, capped.nodes, STEPS);
    const cappedSize = Y.encodeStateAsUpdate(capped.ydoc).length;

    const floor = makeDoc(); // no undo manager tracking at all
    floor.um.destroy();
    age(floor.ydoc, floor.nodes, STEPS);
    const floorSize = Y.encodeStateAsUpdate(floor.ydoc).length;

    // Same materialized state in all three (same seed, same mix).
    expect(capped.nodes.toJSON()).toEqual(unbounded.nodes.toJSON());

    // The headline: capped ≪ unbounded, and within 2x of the no-undo floor.
    expect(cappedSize, `capped=${cappedSize}B unbounded=${unboundedSize}B`).toBeLessThan(
      unboundedSize / 5,
    );
    expect(cappedSize, `capped=${cappedSize}B floor=${floorSize}B`).toBeLessThan(floorSize * 2);
    // …and the stack really is at the cap, not empty.
    expect(capped.um.undoStack.length).toBe(UNDO_STACK_CAP);
  });

  it('NEGATIVE CONTROL: splicing the stack WITHOUT releasing reclaims nothing', () => {
    const spliced = makeDoc();
    // The trap this module exists to close: forget the steps, keep the pins.
    spliced.um.on('stack-item-added', () => {
      while (spliced.um.undoStack.length > UNDO_STACK_CAP) spliced.um.undoStack.shift();
    });
    age(spliced.ydoc, spliced.nodes, STEPS);
    const splicedSize = Y.encodeStateAsUpdate(spliced.ydoc).length;

    const capped = makeDoc();
    attachUndoCap(capped.ydoc, capped.um);
    age(capped.ydoc, capped.nodes, STEPS);
    const cappedSize = Y.encodeStateAsUpdate(capped.ydoc).length;

    // Identical stack depth, wildly different retention: the release is the
    // load-bearing half of the trim.
    expect(spliced.um.undoStack.length).toBe(UNDO_STACK_CAP);
    expect(splicedSize, `spliced=${splicedSize}B capped=${cappedSize}B`).toBeGreaterThan(
      cappedSize * 5,
    );
  });

  it('UNDO works to the full retained depth after trimming, restoring real content', () => {
    const { ydoc, nodes, um } = makeDoc();
    attachUndoCap(ydoc, um);
    // 300 sequential sets of the same key: steps 201..300 survive the cap.
    for (let i = 1; i <= 300; i++) {
      ydoc.transact(() => nodes.set('probe', { v: i }), LOCAL);
    }
    expect(um.undoStack.length).toBe(UNDO_STACK_CAP);
    let undone = 0;
    while (um.canUndo()) {
      um.undo();
      undone++;
      expect(undone).toBeLessThanOrEqual(UNDO_STACK_CAP);
    }
    expect(undone).toBe(UNDO_STACK_CAP);
    // 100 undos off v=300 lands on v=200 — the exact edge of the window.
    expect((nodes.get('probe') as { v: number }).v).toBe(200);
  });

  it('REDO is bounded by construction and round-trips across the window edge', () => {
    const { ydoc, nodes, um } = makeDoc();
    attachUndoCap(ydoc, um);
    for (let i = 1; i <= 150; i++) {
      ydoc.transact(() => nodes.set('probe', { v: i }), LOCAL);
    }
    while (um.canUndo()) um.undo();
    expect(um.redoStack.length).toBeLessThanOrEqual(UNDO_STACK_CAP);
    while (um.canRedo()) um.redo();
    expect((nodes.get('probe') as { v: number }).v).toBe(150);
  });
});
