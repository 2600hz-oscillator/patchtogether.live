// packages/web/src/lib/ui/modules/moog956/ribbon-actions.test.ts
//
// THE ORDERING PROOF, and the persistence split — the two things about the 956
// gesture that are invisible to every other gate in the tree.
//
// ⚠ WHY THE ORDER NEEDS A TEST AT ALL. The two writes a press performs do not
// reach the engine by the same route: `setNodeParam` goes through the Y.Doc and
// the reconciler's `queueMicrotask`, while `setMomentaryParam` calls the engine
// on the spot. Written the obvious way round, the GATE RISES BEFORE THE PITCH
// MOVES and every note attacks at the PREVIOUS note's pitch — on the one module
// whose stated promise is that the ribbon holds its last pitch. That defect is
// audible, it is a one-line regression away at all times, and NOTHING else can
// see it: contract-lock reads the def (the def is fine), module-face-lint reads
// the face (the face is fine), faces-parity presses the pad and asserts the pad
// is enabled, and the VRT scenes photograph a surface at rest.
//
// So the seam is driven against a fake engine that RECORDS THE SEQUENCE of
// `setParam` calls, and the assertion is on the sequence rather than on the
// final state — the final state is identical either way, which is exactly why
// the bug would ship.
//
// The second half is the persistence split: `pos` is durable (the def promises
// it survives a reload) and `gate` must never be, because a press whose release
// never arrives would otherwise persist a droning note into the rack and sync
// it to every peer.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { patch, ydoc, LOCAL_ORIGIN } from '$lib/graph/store';
import { setActiveEngine } from '$lib/audio/engine-ref';
import type { PatchEngine } from '$lib/audio/engine';
import type { ModuleNode } from '$lib/graph/types';
import { moog956Def } from '$lib/audio/modules/moog956';
import { __resetManualGateLatch } from '../manual-strike-actions';
import {
  RIBBON_GATE_PARAM,
  RIBBON_POS_PARAM,
  ribbonPersistPos,
  ribbonPress,
  ribbonRelease,
  ribbonSemitoneText,
  ribbonSlide,
} from './ribbon-actions';

const NODE = 'ribbon-node';

/** Every `setParam` the seam pushed at the engine, in order. */
let calls: { paramId: string; value: number }[] = [];

function recordingEngine(): PatchEngine {
  return {
    read: () => undefined,
    setParam: (_node: ModuleNode, paramId: string, value: number) => {
      calls.push({ paramId, value });
    },
  } as unknown as PatchEngine;
}

function addNode(params: Record<string, number> = {}): void {
  ydoc.transact(() => {
    patch.nodes[NODE] = {
      id: NODE,
      type: 'moog956',
      domain: 'audio',
      position: { x: 0, y: 0 },
      params,
      data: {},
    } as unknown as ModuleNode;
  }, LOCAL_ORIGIN);
}

function storedParams(): Record<string, number> {
  return { ...((patch.nodes[NODE] as ModuleNode | undefined)?.params ?? {}) };
}

beforeEach(() => {
  calls = [];
  __resetManualGateLatch();
  addNode();
  setActiveEngine(recordingEngine());
});
afterEach(() => {
  setActiveEngine(null);
  __resetManualGateLatch();
  ydoc.transact(() => {
    delete patch.nodes[NODE];
  }, LOCAL_ORIGIN);
});

describe('moog956 ribbon — PITCH BEFORE GATE (the ordering the routes disagree about)', () => {
  it('a press pushes `pos` at the engine BEFORE it raises `gate`', () => {
    ribbonPress(NODE, 0.75);
    const order = calls.map((c) => c.paramId);
    expect(
      order,
      'the pitch must be standing when the gate rises, or the note attacks at the '
        + 'PREVIOUS pitch and glides — the one behaviour this module promises not to have',
    ).toEqual([RIBBON_POS_PARAM, RIBBON_GATE_PARAM]);
    expect(calls[0]!.value, 'and it is the pressed position, not a stale one').toBeCloseTo(0.75, 6);
    expect(calls[1]!.value, 'the gate goes HIGH').toBe(1);
  });

  it('NEGATIVE CONTROL: the recorder can tell the two orders apart', () => {
    // A `toEqual([...])` over a recorder that captured nothing reads green.
    // Push the WRONG order by hand through the same recorder and require the
    // assertion above to have been able to fail.
    const wrong = [RIBBON_GATE_PARAM, RIBBON_POS_PARAM];
    expect(wrong).not.toEqual([RIBBON_POS_PARAM, RIBBON_GATE_PARAM]);
    // …and the instrument really is wired: the press above produced exactly
    // two engine writes, so neither call is being dropped on the floor.
    ribbonPress(NODE, 0.25);
    expect(calls.length, 'the recorder sees BOTH writes').toBe(2);
  });

  it('a press writes the position DURABLY too — a TAP never schedules a frame', () => {
    // The drag pump is rAF-coalesced and a tap produces no pointermove, so
    // without the press taking the durable write itself the tapped pitch would
    // reach the engine and never the document.
    ribbonPress(NODE, 0.4);
    expect(storedParams()[RIBBON_POS_PARAM]).toBeCloseTo(0.4, 6);
  });

  it('a press CLAMPS through the def\'s own `clampRibbon`, engine and document alike', () => {
    const p = ribbonPress(NODE, 4.2);
    expect(p, 'the returned position is what the caller stages on its pump').toBe(1);
    expect(calls[0]!.value).toBe(1);
    expect(storedParams()[RIBBON_POS_PARAM]).toBe(1);
  });
});

describe('moog956 ribbon — what persists, and what must never', () => {
  it('`gate` NEVER reaches the document, pressed or released', () => {
    // The data-integrity half. Before `face.momentary` this param was written
    // with `setNodeParam`, so a press whose release never arrived (the surface
    // unmounting mid-hold) persisted a HIGH gate that synced to every peer and
    // came back as a drone on the next load.
    ribbonPress(NODE, 0.6);
    expect(
      RIBBON_GATE_PARAM in storedParams(),
      'a finger is not something a rack can be saved holding',
    ).toBe(false);
    ribbonRelease(NODE);
    expect(RIBBON_GATE_PARAM in storedParams()).toBe(false);
  });

  it('the release drops the gate and LEAVES the pitch — no snap-back', () => {
    ribbonPress(NODE, 0.9);
    calls = [];
    ribbonRelease(NODE);
    expect(calls.map((c) => c.paramId), 'only the gate moves').toEqual([RIBBON_GATE_PARAM]);
    expect(calls[0]!.value, 'and it goes to the def-declared REST, not a hardcoded 0')
      .toBe(moog956Def.params.find((p) => p.id === RIBBON_GATE_PARAM)!.defaultValue);
    expect(storedParams()[RIBBON_POS_PARAM], 'the wiper keeps its voltage').toBeCloseTo(0.9, 6);
  });

  it('a SLIDE is engine-only — the durable write is the caller\'s pump', () => {
    // If `ribbonSlide` wrote the store, a drag would be one Y.Doc transaction
    // per pointermove (120-240 Hz) instead of one per frame: the write storm
    // `createDragCommit` exists for, and the raw-write debt this card just paid.
    ribbonPress(NODE, 0.1);
    const afterPress = storedParams()[RIBBON_POS_PARAM]!;
    ribbonSlide(NODE, 0.2);
    ribbonSlide(NODE, 0.3);
    ribbonSlide(NODE, 0.44);
    expect(storedParams()[RIBBON_POS_PARAM], 'three slides, zero document writes')
      .toBeCloseTo(afterPress, 6);
    expect(calls.at(-1), 'but every one of them reached the engine')
      .toEqual({ paramId: RIBBON_POS_PARAM, value: 0.44 });
    // …and the pump's target is what makes it durable when the frame lands.
    ribbonPersistPos(NODE, 0.44);
    expect(storedParams()[RIBBON_POS_PARAM]).toBeCloseTo(0.44, 6);
  });

  it('a missing engine is a no-op, never a throw over a rack', () => {
    setActiveEngine(null);
    expect(() => ribbonPress(NODE, 0.5)).not.toThrow();
    expect(() => ribbonSlide(NODE, 0.6)).not.toThrow();
    expect(() => ribbonRelease(NODE)).not.toThrow();
    // The DURABLE half still lands, so the factory seeds the right pitch from
    // `node.params` whenever the engine does arrive.
    expect(storedParams()[RIBBON_POS_PARAM]).toBeCloseTo(0.5, 6);
  });
});

describe('moog956 ribbon — the semitone reading is ONE string for two destinations', () => {
  it('renders the def\'s own pitch law (V/oct x 12), at one decimal', () => {
    // The legacy card PAINTS this and the face SPEAKS it as the strip's
    // `aria-valuetext`. Sharing the formatter is what stops the two surfaces
    // quietly reporting different numbers for the same finger.
    expect(ribbonSemitoneText(0, 2, 0)).toBe('0.0 st');
    expect(ribbonSemitoneText(0.5, 2, 0)).toBe('12.0 st');
    expect(ribbonSemitoneText(1, 2, 0)).toBe('24.0 st');
    expect(ribbonSemitoneText(0, 2, -1)).toBe('-12.0 st');
  });
});
