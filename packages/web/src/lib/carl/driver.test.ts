// carl/driver.test.ts
//
// THE AI PATCHING PATH IS AN AUDIO EDGE WRITER, and it is the one that does not
// go through Canvas. `applyIntent`'s `addEdge` case writes straight into the
// Y.Doc, so before PR-3 an AI patch of a stereo module was permanently
// half-connected while every Canvas gesture wrote both legs.
//
// ⚠ It is also the writer the plan MIS-CITED: `.myrobots/stereo-audio-plan/
// plan.md` points at `mike/driver.ts:79-105`, which is `organizeAll`'s LAYOUT
// transact and has never touched `patch.edges`. Mike delegates here. This file
// exists so the seam has a test of its own and cannot be lost again.
//
// The def resolver is INJECTED. The real one reads the live registries, which
// are populated by the `$lib/audio/modules` barrel's side effect — a test that
// skipped the barrel would resolve every def to `undefined`, plan one leg, and
// pass. That is the green-gate-over-a-live-bug shape, so the resolver is a
// parameter and these tests hand over defs they control.

import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { applyIntent, type DriverDeps, type PatchLike } from './driver';
import type { StereoDef } from '$lib/graph/stereo-autowire';
import type { Edge, ModuleNode } from '$lib/graph/types';

const clouds: StereoDef = {
  type: 'clouds',
  inputs: [
    { id: 'in_l', type: 'audio' },
    { id: 'in_r', type: 'audio' },
  ],
  outputs: [
    { id: 'out_l', type: 'audio' },
    { id: 'out_r', type: 'audio' },
  ],
  stereoPairs: [
    ['in_l', 'in_r'],
    ['out_l', 'out_r'],
  ],
};

const monoFilter: StereoDef = {
  type: 'filter',
  inputs: [
    { id: 'audio', type: 'audio' },
    { id: 'cutoff', type: 'cv' },
  ],
  outputs: [{ id: 'audio', type: 'audio' }],
};

const monoOsc: StereoDef = {
  type: 'analogVco',
  inputs: [],
  outputs: [{ id: 'out', type: 'audio' }],
};

const DEFS: Record<string, StereoDef> = {
  'carl-n1-clouds': clouds,
  'carl-n2-clouds': clouds,
  'carl-n3-filter': monoFilter,
  'carl-n4-analogVco': monoOsc,
};

function deps(): DriverDeps & { patch: PatchLike } {
  const patch: PatchLike = { nodes: {}, edges: {} };
  for (const id of Object.keys(DEFS)) {
    patch.nodes[id] = {
      id,
      type: DEFS[id]!.type!,
      domain: 'audio',
      position: { x: 0, y: 0 },
      params: {},
    } as ModuleNode;
  }
  return { patch, ydoc: new Y.Doc(), defForNode: (nodeId) => DEFS[nodeId] };
}

function pairs(patch: PatchLike): string[] {
  return Object.values(patch.edges)
    .filter((e): e is Edge => !!e)
    .map((e) => `${e.source.portId}->${e.target.portId}`)
    .sort();
}

describe('AI applyIntent addEdge — routes through the leg-group planner', () => {
  it('stereo → stereo writes BOTH legs from ONE intent', () => {
    const d = deps();
    applyIntent(d, {
      kind: 'addEdge',
      id: 'carl-e0',
      sourceNodeId: 'carl-n1-clouds',
      sourcePortId: 'out_l',
      targetNodeId: 'carl-n2-clouds',
      targetPortId: 'in_l',
      sourceCableType: 'audio',
      targetCableType: 'audio',
    });
    expect(pairs(d.patch)).toEqual(['out_l->in_l', 'out_r->in_r']);
  });

  it('stereo → MONO writes BOTH legs into the mono input (dual-mono)', () => {
    const d = deps();
    applyIntent(d, {
      kind: 'addEdge',
      id: 'carl-e0',
      sourceNodeId: 'carl-n1-clouds',
      sourcePortId: 'out_l',
      targetNodeId: 'carl-n3-filter',
      targetPortId: 'audio',
      sourceCableType: 'audio',
      targetCableType: 'audio',
    });
    expect(pairs(d.patch)).toEqual(['out_l->audio', 'out_r->audio']);
  });

  it('mono → mono still writes exactly one edge', () => {
    const d = deps();
    applyIntent(d, {
      kind: 'addEdge',
      id: 'carl-e0',
      sourceNodeId: 'carl-n4-analogVco',
      sourcePortId: 'out',
      targetNodeId: 'carl-n3-filter',
      targetPortId: 'audio',
      sourceCableType: 'audio',
      targetCableType: 'audio',
    });
    expect(Object.keys(d.patch.edges)).toEqual(['carl-e0']);
  });

  it('the CLICKED leg keeps the intent id (deleteEdge + evict-by-prefix rely on it)', () => {
    const d = deps();
    applyIntent(d, {
      kind: 'addEdge',
      id: 'carl-e0',
      sourceNodeId: 'carl-n1-clouds',
      sourcePortId: 'out_l',
      targetNodeId: 'carl-n2-clouds',
      targetPortId: 'in_l',
      sourceCableType: 'audio',
      targetCableType: 'audio',
    });
    expect(d.patch.edges['carl-e0']?.source.portId).toBe('out_l');
    // The sibling takes the endpoint-derived id. Its node ids still carry the
    // bot prefix, so the evict sweep (which matches on source/target nodeId)
    // still reaches it.
    const sibling = 'e-carl-n1-clouds-out_r-carl-n2-clouds-in_r';
    expect(d.patch.edges[sibling]).toBeDefined();
    expect(d.patch.edges[sibling]!.source.nodeId.startsWith('carl-')).toBe(true);
  });

  it('is IDEMPOTENT — replaying the mirrored intent adds nothing', () => {
    const d = deps();
    const base = {
      kind: 'addEdge' as const,
      sourceNodeId: 'carl-n1-clouds',
      targetNodeId: 'carl-n2-clouds',
      sourceCableType: 'audio' as const,
      targetCableType: 'audio' as const,
    };
    applyIntent(d, { ...base, id: 'carl-e0', sourcePortId: 'out_l', targetPortId: 'in_l' });
    applyIntent(d, { ...base, id: 'carl-e1', sourcePortId: 'out_r', targetPortId: 'in_r' });
    // The second intent's leg group is already on the graph, so nothing new is
    // written — 2 edges, not 3 or 4.
    expect(Object.keys(d.patch.edges)).toHaveLength(2);
  });

  it('does NOT evict — an AI intent stream stays purely additive', () => {
    // Deliberate divergence from the Canvas paths: `addEdge` has always been
    // additive + idempotent, and having a bot silently unpatch cables it did
    // not place is a different feature from the leg-group write.
    const d = deps();
    d.patch.edges['pre'] = {
      id: 'pre',
      source: { nodeId: 'carl-n4-analogVco', portId: 'out' },
      target: { nodeId: 'carl-n2-clouds', portId: 'in_l' },
      sourceType: 'audio',
      targetType: 'audio',
    };
    applyIntent(d, {
      kind: 'addEdge',
      id: 'carl-e0',
      sourceNodeId: 'carl-n1-clouds',
      sourcePortId: 'out_l',
      targetNodeId: 'carl-n2-clouds',
      targetPortId: 'in_l',
      sourceCableType: 'audio',
      targetCableType: 'audio',
    });
    expect(d.patch.edges['pre']).toBeDefined();
  });

  it('a CV intent is untouched by pairing', () => {
    const d = deps();
    applyIntent(d, {
      kind: 'addEdge',
      id: 'carl-e0',
      sourceNodeId: 'carl-n4-analogVco',
      sourcePortId: 'out',
      targetNodeId: 'carl-n3-filter',
      targetPortId: 'cutoff',
      sourceCableType: 'cv',
      targetCableType: 'cv',
    });
    expect(Object.keys(d.patch.edges)).toEqual(['carl-e0']);
  });

  it('deleteEdge takes the WHOLE leg group, not the named leg only', () => {
    const d = deps();
    applyIntent(d, {
      kind: 'addEdge',
      id: 'carl-e0',
      sourceNodeId: 'carl-n1-clouds',
      sourcePortId: 'out_l',
      targetNodeId: 'carl-n2-clouds',
      targetPortId: 'in_l',
      sourceCableType: 'audio',
      targetCableType: 'audio',
    });
    expect(Object.keys(d.patch.edges)).toHaveLength(2);
    applyIntent(d, { kind: 'deleteEdge', id: 'carl-e0' });
    expect(Object.keys(d.patch.edges)).toHaveLength(0);
  });

  it('NEGATIVE CONTROL — with NO def resolver the write collapses to one leg', () => {
    // This is precisely what a barrel-less unit test would have measured, and
    // what shipped before PR-3. If the resolver ever silently stops resolving,
    // the asserts above go red instead of quietly passing on one leg.
    const d = deps();
    const blind: DriverDeps = { patch: d.patch, ydoc: d.ydoc, defForNode: () => undefined };
    applyIntent(blind, {
      kind: 'addEdge',
      id: 'carl-e0',
      sourceNodeId: 'carl-n1-clouds',
      sourcePortId: 'out_l',
      targetNodeId: 'carl-n2-clouds',
      targetPortId: 'in_l',
      sourceCableType: 'audio',
      targetCableType: 'audio',
    });
    expect(pairs(d.patch)).toEqual(['out_l->in_l']);
    expect(() => expect(pairs(d.patch)).toEqual(['out_l->in_l', 'out_r->in_r'])).toThrow();
  });
});
