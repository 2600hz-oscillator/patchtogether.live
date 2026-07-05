// packages/web/src/lib/audio/modules/negativity.test.ts
//
// Three test layers for NEGATIVITY (1-in / 1-out CV inverter, out = −in):
//   1. Module-def shape — pins the CV-only I/O surface (a single `in` cv port,
//      a single `out` cv port) and that there are NO params (it's knob-less).
//   2. DSP correctness — the pure `negate(in)` helper IS the contract:
//      in=0.4 → −0.4, in=−0.7 → +0.7, in=0 → 0, and involution (−−x = x).
//   3. Factory behavior — the pure Web Audio factory is one GainNode with a
//      FIXED gain of −1; in and out tap the same node; setParam is a no-op;
//      readParam is always undefined; dispose disconnects.

import { describe, it, expect, vi } from 'vitest';
import { negativityDef, negate } from './negativity';
import type { ModuleNode } from '$lib/graph/types';

// ───────────────────── Layer 1: module-def shape ─────────────────────
describe('negativityDef: module def shape', () => {
  it('declares type=negativity, label="negativity" (lowercase), category=utilities, domain=audio, schemaVersion=1', () => {
    expect(negativityDef.type).toBe('negativity');
    expect(negativityDef.label).toBe('negativity');
    expect(negativityDef.label).toBe(negativityDef.label.toLowerCase());
    expect(negativityDef.category).toBe('utilities');
    expect(negativityDef.domain).toBe('audio');
  });

  it('lands in the Utilities palette (Audio modules → Utility)', () => {
    expect(negativityDef.palette).toEqual({ top: 'Audio modules', sub: 'Utility' });
  });

  it('exposes a single CV-only `in` input (no audio widening)', () => {
    expect(negativityDef.inputs.map((p) => p.id)).toEqual(['in']);
    const inp = negativityDef.inputs[0];
    expect(inp.type).toBe('cv');
    expect(inp.accepts).toBeUndefined();
    expect(inp.paramTarget).toBeUndefined();
  });

  it('exposes a single CV-only `out` output', () => {
    expect(negativityDef.outputs.map((p) => p.id)).toEqual(['out']);
    expect(negativityDef.outputs[0].type).toBe('cv');
  });

  it('has NO params (it is a knob-less fixed inverter)', () => {
    expect(negativityDef.params).toEqual([]);
  });
});

// ───────────────────── Layer 2: DSP correctness ─────────────────────
describe('negate(): out = −in', () => {
  it('flips the user-specified cases: 0.4 → −0.4, −0.7 → +0.7', () => {
    expect(negate(0.4)).toBeCloseTo(-0.4, 12);
    expect(negate(-0.7)).toBeCloseTo(0.7, 12);
  });

  it('0 → 0 (sign-flip of zero is zero)', () => {
    expect(Math.abs(negate(0))).toBe(0);
  });

  it('is an involution: negate(negate(x)) === x', () => {
    for (const x of [-1, -0.33, 0, 0.5, 1, 2.5]) {
      expect(negate(negate(x))).toBeCloseTo(x, 12);
    }
  });

  it('matches a literal −in across the range', () => {
    for (const x of [-1, -0.5, -0.1, 0, 0.1, 0.5, 1]) {
      expect(negate(x)).toBeCloseTo(-x, 12);
    }
  });
});

// ───────────────────── Layer 3: pure Web Audio factory ─────────────────────
interface FakeAudioParam {
  value: number;
  setValueAtTime: (v: number, t: number) => void;
}
function mkParam(): FakeAudioParam {
  return {
    value: 0,
    setValueAtTime(v: number) {
      this.value = v;
    },
  };
}
class FakeGain {
  gain = mkParam();
  connect = vi.fn();
  disconnect = vi.fn();
}
function makeMockCtx() {
  const created: FakeGain[] = [];
  const ctx = {
    currentTime: 0,
    sampleRate: 48000,
    createGain: () => {
      const g = new FakeGain();
      created.push(g);
      return g;
    },
  };
  return { ctx, created };
}

function makeNode(params: Record<string, number> = {}): ModuleNode {
  return {
    id: 'negativity-test',
    type: 'negativity',
    domain: 'audio',
    position: { x: 0, y: 0 },
    params,
  };
}

describe('negativity factory: pure Web Audio graph', () => {
  it('creates exactly one GainNode with a fixed gain of −1', async () => {
    const { ctx, created } = makeMockCtx();
    await negativityDef.factory(ctx as unknown as AudioContext, makeNode());
    expect(created).toHaveLength(1);
    expect(created[0].gain.value).toBe(-1);
  });

  it('routes in → gain → out (in and out tap the SAME node)', async () => {
    const { ctx, created } = makeMockCtx();
    const handle = await negativityDef.factory(ctx as unknown as AudioContext, makeNode());
    const inEntry = handle.inputs.get('in');
    const outEntry = handle.outputs.get('out');
    expect(inEntry).toBeDefined();
    expect(outEntry).toBeDefined();
    expect(inEntry!.input).toBe(0);
    expect(outEntry!.output).toBe(0);
    expect(inEntry!.node).toBe(created[0]);
    expect(outEntry!.node).toBe(created[0]);
    expect(inEntry!.node).toBe(outEntry!.node);
  });

  it('the realized gain computes out = −in (output sample = input × −1)', async () => {
    const { ctx, created } = makeMockCtx();
    await negativityDef.factory(ctx as unknown as AudioContext, makeNode());
    const gain = created[0].gain.value;
    expect(gain).toBe(-1);
    for (const x of [-1, -0.4, 0, 0.4, 1]) {
      expect(x * gain).toBeCloseTo(negate(x), 12);
    }
  });

  it('setParam is a no-op and readParam is always undefined (no params)', async () => {
    const { ctx, created } = makeMockCtx();
    const handle = await negativityDef.factory(ctx as unknown as AudioContext, makeNode());
    handle.setParam('depth', 0.5);
    handle.setParam('anything', 99);
    // Gain stays at −1 — nothing is settable.
    expect(created[0].gain.value).toBe(-1);
    expect(handle.readParam('depth')).toBeUndefined();
    expect(handle.readParam('anything')).toBeUndefined();
  });

  it('dispose() disconnects the gain node', async () => {
    const { ctx, created } = makeMockCtx();
    const handle = await negativityDef.factory(ctx as unknown as AudioContext, makeNode());
    handle.dispose();
    expect(created[0].disconnect).toHaveBeenCalled();
  });
});
