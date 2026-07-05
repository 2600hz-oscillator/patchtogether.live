// packages/web/src/lib/graph/quadralogical-cv-nopersist-ydoc.test.ts
//
// Regression net for the QUADRALOGICAL gamepad → X/Y OFFSET bug.
//
// The bug: a physical gamepad patched into QUADRALOGICAL's pos_x/pos_y, saved
// with the pad at a non-centre position, reloaded with the stick physically
// centred — read as a permanent up-and-to-the-right offset. Cause: the moment-
// in-time pad position was stored in the patch (a deliberate drag write), and
// the cv → video bridge baked that stored value as the CV *modulation centre*,
// so a centred stick (cv≈0) landed on the saved base instead of centre.
//
// Two invariants keep it fixed FOREVER:
//   1. NO-PERSIST — CV/live modulation is transient DISPLAY state, routed to the
//      video-engine handle, and must NEVER write the synced Y.Doc. Driving it
//      for many frames produces ZERO ydoc updates and never mutates params.
//   2. SAVE→RELOAD tracks the input — a patch's stored pos_x is only ever the
//      DELIBERATE base (default unless the user dragged), and with a cable
//      connected the effective X/Y equals the input regardless of that base
//      (center: 'default'), so a stale saved position can't offset it. This
//      also HEALS patches saved before the fix (the owner's real .ptperf).
//
// Uses the REAL syncedStore + Y.Doc + persistence path (see
// [[yjs-save-load-real-ydoc]] — never mock Y flows).

import { describe, it, expect, beforeAll } from 'vitest';
import { syncedStore, getYjsDoc } from '@syncedstore/core';
import {
  makeEnvelope,
  parseEnvelope,
  serializeEnvelope,
  loadEnvelopeIntoStore,
  type LivePatch,
} from './persistence';
import { registerVideoModule } from '$lib/video/module-registry';
import { registerModule, type AudioModuleDef } from '$lib/audio/module-registry';
import { quadralogicalDef } from '$lib/video/modules/quadralogical';
import { buildCvBridgeMapping, mapCvBridgeValue } from '$lib/video/cv-bridge-map';
import type { ModuleNode, Edge } from './types';

// The owner's exact saved values (decoded from performance.ptperf): a pad drag
// captured off-centre, up-and-to-the-right.
const POISON_X = 0.4764564431012892;
const POISON_Y = 0.5694425543051558;

const posXInput = quadralogicalDef.inputs.find((i) => i.id === 'pos_x')!;
const posYInput = quadralogicalDef.inputs.find((i) => i.id === 'pos_y')!;
const posXDefault = quadralogicalDef.params.find((p) => p.id === 'pos_x')!.defaultValue;

/** A minimal gamepad-shaped CV source so the pos_x/pos_y cables survive load
 *  validation. The persistence layer only reads schemaVersion + ports. */
const gamepadStub: AudioModuleDef = {
  type: 'gamepad',
  domain: 'audio',
  label: 'Gamepad',
  category: 'sources',
  schemaVersion: 1,
  inputs: [],
  outputs: [
    { id: 'lx', type: 'cv' },
    { id: 'ly', type: 'cv' },
  ],
  params: [],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  factory: (() => { throw new Error('factory should not run in a persistence test'); }) as any,
};

/** Fresh isolated syncedstore + ydoc + LivePatch triple per test (mirrors
 *  persistence.test.ts — never the shared singleton). */
function freshPatch() {
  const store = syncedStore<{ nodes: Record<string, ModuleNode>; edges: Record<string, Edge> }>({
    nodes: {},
    edges: {},
  });
  const ydoc = getYjsDoc(store);
  return { store: store as unknown as LivePatch, ydoc };
}

beforeAll(() => {
  registerVideoModule(quadralogicalDef);
  registerModule(gamepadStub);
});

describe('QUADRALOGICAL CV → X/Y — modulation never persists (no ydoc write-storm)', () => {
  it('driving the CV bridge for 120 frames emits ZERO Y.Doc updates + never mutates pos_x', () => {
    const { store, ydoc } = freshPatch();
    ydoc.transact(() => {
      store.nodes['quad'] = {
        id: 'quad',
        type: 'quadralogical',
        domain: 'video',
        position: { x: 0, y: 0 },
        params: {}, // default — pos_x unset
      } as unknown as ModuleNode;
    });

    // The engine routes each sampled frame to the VIDEO-ENGINE HANDLE's setParam,
    // NOT the store. Reproduce that write path with a recording fake handle.
    const setParamCalls: Array<[string, number]> = [];
    const handle = { setParam: (id: string, v: number) => setParamCalls.push([id, v]) };
    const mapping = buildCvBridgeMapping(posXInput, 'pos_x', quadralogicalDef.params, store.nodes['quad']!.params);

    let updates = 0;
    const onUpdate = () => { updates += 1; };
    ydoc.on('update', onUpdate);
    try {
      for (let f = 0; f < 120; f++) {
        const cv = Math.sin(f / 7); // a moving stick sweeping the full range
        handle.setParam(mapping.targetParamId, mapCvBridgeValue(mapping, cv));
      }
    } finally {
      ydoc.off('update', onUpdate);
    }

    expect(setParamCalls.length).toBe(120);              // modulation reached the handle
    expect(updates).toBe(0);                             // …and NOTHING was synced
    expect(store.nodes['quad']!.params.pos_x).toBeUndefined(); // stored base untouched
  });
});

describe('QUADRALOGICAL CV → X/Y — save → reload keeps X/Y tracking the input', () => {
  it('a never-dragged patch saves the DEFAULT base (not any live modulated value)', () => {
    const { store, ydoc } = freshPatch();
    ydoc.transact(() => {
      store.nodes['quad'] = {
        id: 'quad', type: 'quadralogical', domain: 'video',
        position: { x: 0, y: 0 }, params: {},
      } as unknown as ModuleNode;
      store.nodes['gp'] = {
        id: 'gp', type: 'gamepad', domain: 'audio',
        position: { x: 0, y: 0 }, params: {},
      } as unknown as ModuleNode;
      store.edges['e-lx'] = {
        id: 'e-lx',
        source: { nodeId: 'gp', portId: 'lx' },
        target: { nodeId: 'quad', portId: 'pos_x' },
        sourceType: 'cv', targetType: 'cv',
      } as Edge;
    });

    // A whole session of CV driving the joystick off-centre — routed to a handle,
    // never the store, so the saved base stays default.
    const mapping = buildCvBridgeMapping(posXInput, 'pos_x', quadralogicalDef.params, store.nodes['quad']!.params);
    for (let f = 0; f < 60; f++) void mapCvBridgeValue(mapping, 0.8);

    const reparsed = parseEnvelope(serializeEnvelope(makeEnvelope(ydoc)));
    const dst = freshPatch();
    loadEnvelopeIntoStore(reparsed, dst.ydoc, dst.store);

    const quad = dst.store.nodes['quad']!;
    const base = quad.params.pos_x ?? posXDefault;
    expect(base).toBe(posXDefault);                      // saved base = default, NOT 0.8

    // Cable present ⇒ effective X equals the input (centred on default).
    const m = buildCvBridgeMapping(posXInput, 'pos_x', quadralogicalDef.params, quad.params);
    expect(mapCvBridgeValue(m, 0)).toBeCloseTo(0, 5);
    expect(mapCvBridgeValue(m, 0.5)).toBeCloseTo(0.5, 5);
  });

  it("HEALS the owner's poisoned save: the stored base survives but no longer offsets a cabled X/Y", () => {
    const { store, ydoc } = freshPatch();
    // A patch saved by the BUGGY build: the pad drag captured as pos_x/pos_y bases.
    ydoc.transact(() => {
      store.nodes['quad'] = {
        id: 'quad', type: 'quadralogical', domain: 'video',
        position: { x: 0, y: 0 }, params: { pos_x: POISON_X, pos_y: POISON_Y },
      } as unknown as ModuleNode;
      store.nodes['gp'] = {
        id: 'gp', type: 'gamepad', domain: 'audio',
        position: { x: 0, y: 0 }, params: {},
      } as unknown as ModuleNode;
      store.edges['e-lx'] = {
        id: 'e-lx', source: { nodeId: 'gp', portId: 'lx' }, target: { nodeId: 'quad', portId: 'pos_x' },
        sourceType: 'cv', targetType: 'cv',
      } as Edge;
      store.edges['e-ly'] = {
        id: 'e-ly', source: { nodeId: 'gp', portId: 'ly' }, target: { nodeId: 'quad', portId: 'pos_y' },
        sourceType: 'cv', targetType: 'cv',
      } as Edge;
    });

    const reparsed = parseEnvelope(serializeEnvelope(makeEnvelope(ydoc)));
    const dst = freshPatch();
    loadEnvelopeIntoStore(reparsed, dst.ydoc, dst.store);

    const quad = dst.store.nodes['quad']!;
    // The stored base round-trips faithfully (we don't rewrite it)…
    expect(quad.params.pos_x).toBeCloseTo(POISON_X, 9);
    expect(quad.params.pos_y).toBeCloseTo(POISON_Y, 9);
    // …but a cabled, physically-CENTRED stick now reads CENTRE, not the offset.
    const mx = buildCvBridgeMapping(posXInput, 'pos_x', quadralogicalDef.params, quad.params);
    const my = buildCvBridgeMapping(posYInput, 'pos_y', quadralogicalDef.params, quad.params);
    expect(mx.scale!.knob).toBe(posXDefault);
    expect(my.scale!.knob).toBe(posXDefault);
    expect(mapCvBridgeValue(mx, 0)).toBeCloseTo(0, 5);
    expect(mapCvBridgeValue(my, 0)).toBeCloseTo(0, 5);
    // And it tracks the input across the range.
    expect(mapCvBridgeValue(mx, -0.5)).toBeCloseTo(-0.5, 5);
    expect(mapCvBridgeValue(my, 0.75)).toBeCloseTo(0.75, 5);
  });
});
