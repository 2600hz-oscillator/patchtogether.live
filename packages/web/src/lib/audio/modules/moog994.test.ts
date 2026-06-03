// packages/web/src/lib/audio/modules/moog994.test.ts
//
// Two test layers for the MOOG 994 DUAL MULTIPLES (passive 1→3 fan-out, twice):
//   1. Module-def shape — pins the 994's I/O surface (a_in/b_in inputs; the
//      six a1..a3 / b1..b3 fan-out outputs; the empty param array) so a
//      refactor that silently drops a port fails loudly (the
//      per-module-per-port regression-net class of bug).
//   2. Real factory wiring — the 994 is PURE Web Audio (no worklet / no
//      Faust), so we drive def.factory against a tiny mock AudioContext that
//      records the GainNodes it creates and assert: the handle exposes the
//      declared inputs/outputs, each group input feeds its own unity gain,
//      all three of a group's outputs fan out the SAME gain node (the
//      multiple), setParam/readParam are param-less no-ops, and dispose
//      disconnects both gains.

import { describe, it, expect } from 'vitest';
import { moog994Def } from './moog994';
import type { ModuleNode } from '$lib/graph/types';

// ───────────────────── Layer 1: module-def shape ─────────────────────
describe('moog994Def: module def shape', () => {
  it('declares type=moog994, label="moogafakkin 994 Mult", category=utilities, schemaVersion=1', () => {
    expect(moog994Def.type).toBe('moog994');
    expect(moog994Def.label).toBe('moogafakkin 994 Mult');
    expect(moog994Def.category).toBe('utilities');
    expect(moog994Def.schemaVersion).toBe(1);
  });

  it('classifies under the Clones → moogafakkin palette bucket', () => {
    expect(moog994Def.palette).toEqual({ top: 'Clones', sub: 'moogafakkin' });
  });

  it('exposes the two group inputs: a_in + b_in (both audio)', () => {
    const ids = moog994Def.inputs.map((p) => p.id);
    expect(ids).toEqual(['a_in', 'b_in']);
    for (const p of moog994Def.inputs) {
      expect(p.type).toBe('audio');
      // A passive multiple — the inputs are not knob modulators.
      expect((p as { cvScale?: unknown }).cvScale).toBeUndefined();
      expect((p as { paramTarget?: unknown }).paramTarget).toBeUndefined();
    }
  });

  it('exposes the six fan-out outputs: a1..a3 + b1..b3 (all audio)', () => {
    const ids = moog994Def.outputs.map((p) => p.id);
    expect(ids).toEqual(['a1', 'a2', 'a3', 'b1', 'b2', 'b3']);
    for (const p of moog994Def.outputs) {
      expect(p.type).toBe('audio');
    }
  });

  it('has no params (a passive multiple has no controls)', () => {
    expect(moog994Def.params).toEqual([]);
  });
});

// ───────────────────── Layer 2: real factory wiring ─────────────────────

/** A GainNode stub that records its gain value + disconnect calls. */
interface MockGain {
  gain: { value: number };
  connect: () => void;
  disconnect: () => void;
  disconnectCount: number;
}

/** Minimal mock AudioContext shaped for moog994Def.factory — it only ever
 *  calls createGain(). Each created gain is recorded in `gains` in order. */
function makeMockCtx(): { ctx: AudioContext; gains: MockGain[] } {
  const gains: MockGain[] = [];
  function gainNode(): MockGain {
    const g: MockGain = {
      gain: { value: 0 },
      connect() {},
      disconnect() {
        g.disconnectCount += 1;
      },
      disconnectCount: 0,
    };
    return g;
  }
  const ctx = {
    sampleRate: 48000,
    currentTime: 0,
    createGain: () => {
      const g = gainNode();
      gains.push(g);
      return g;
    },
  } as unknown as AudioContext;
  return { ctx, gains };
}

function makeNode(): ModuleNode {
  return { id: 'm994', type: 'moog994', domain: 'audio', params: {} } as unknown as ModuleNode;
}

describe('moog994 factory: pure Web Audio fan-out wiring', () => {
  it('creates exactly two unity GainNodes (one per group)', async () => {
    const { ctx, gains } = makeMockCtx();
    await moog994Def.factory(ctx, makeNode());
    expect(gains).toHaveLength(2);
    for (const g of gains) expect(g.gain.value).toBe(1);
  });

  it('exposes the declared input ports, each pointing at its group gain', async () => {
    const { ctx, gains } = makeMockCtx();
    const handle = await moog994Def.factory(ctx, makeNode());
    const [aGain, bGain] = gains; // populated in creation order by the factory

    expect([...handle.inputs.keys()].sort()).toEqual(['a_in', 'b_in']);
    expect(handle.inputs.get('a_in')).toEqual({ node: aGain, input: 0 });
    expect(handle.inputs.get('b_in')).toEqual({ node: bGain, input: 0 });
  });

  it('exposes all six output ports; each group fans out its own gain node', async () => {
    const { ctx, gains } = makeMockCtx();
    const handle = await moog994Def.factory(ctx, makeNode());
    const [aGain, bGain] = gains;

    expect([...handle.outputs.keys()]).toEqual(['a1', 'a2', 'a3', 'b1', 'b2', 'b3']);

    // The A group's three outputs all expose the SAME aGain (output 0) — that
    // identity IS the multiple (one signal fanned to three jacks).
    for (const id of ['a1', 'a2', 'a3']) {
      expect(handle.outputs.get(id)).toEqual({ node: aGain, output: 0 });
    }
    for (const id of ['b1', 'b2', 'b3']) {
      expect(handle.outputs.get(id)).toEqual({ node: bGain, output: 0 });
    }
    // The two groups are INDEPENDENT — different nodes.
    expect(aGain).not.toBe(bGain);
  });

  it('setParam is a no-op and readParam returns undefined (param-less)', async () => {
    const { ctx } = makeMockCtx();
    const handle = await moog994Def.factory(ctx, makeNode());
    // No throw, no observable effect — and the round-trip yields undefined.
    expect(() => handle.setParam('whatever', 0.5)).not.toThrow();
    expect(handle.readParam('whatever')).toBeUndefined();
  });

  it('dispose() disconnects both group gains', async () => {
    const { ctx, gains } = makeMockCtx();
    const handle = await moog994Def.factory(ctx, makeNode());
    handle.dispose();
    for (const g of gains) expect(g.disconnectCount).toBeGreaterThanOrEqual(1);
  });
});
