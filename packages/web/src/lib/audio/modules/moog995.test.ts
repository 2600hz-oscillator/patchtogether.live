// packages/web/src/lib/audio/modules/moog995.test.ts
//
// Two test layers for the MOOG 995 ATTENUATORS (Moog System 55/35 clone —
// three INDEPENDENT passive variable attenuators):
//   1. Module-def shape — pins the 995's I/O surface (in1..in3 → out1..out3
//      audio ports, the atten1..atten3 param array) so a refactor that silently
//      drops a port fails loudly (the per-module-per-port regression-net class
//      of bug).
//   2. Factory behavior — drive the PURE Web Audio factory with a mock
//      AudioContext (three GainNodes, no worklet): assert the handle exposes
//      the declared inputs/outputs pointing at the right GainNode, that each
//      input feeds its OWN gain node (full channel independence), that
//      setParam→readParam round-trips on the live gain, and that the initial
//      param value is applied to the gain.

import { describe, it, expect, vi } from 'vitest';
import { moog995Def } from './moog995';
import type { ModuleNode } from '$lib/graph/types';

// ───────────────────── Layer 1: module-def shape ─────────────────────
describe('moog995Def: module def shape', () => {
  it('declares type=moog995, label="Moog 995 Atten", category=utilities, domain=audio, schemaVersion=1', () => {
    expect(moog995Def.type).toBe('moog995');
    expect(moog995Def.label).toBe('Moog 995 Atten');
    expect(moog995Def.category).toBe('utilities');
    expect(moog995Def.domain).toBe('audio');
    expect(moog995Def.schemaVersion).toBe(1);
  });

  it('is filed under the Moog → SYS55 palette bucket', () => {
    expect(moog995Def.palette).toEqual({ top: 'Moog', sub: 'SYS55' });
  });

  it('exposes the three audio inputs: in1..in3', () => {
    const ids = moog995Def.inputs.map((p) => p.id);
    expect(ids).toEqual(['in1', 'in2', 'in3']);
    for (const p of moog995Def.inputs) {
      expect(p.type).toBe('audio');
      // Passive signal attenuation — not a CV→param routing.
      expect(p.paramTarget).toBeUndefined();
      expect(p.cvScale).toBeUndefined();
    }
  });

  it('exposes the three audio outputs: out1..out3', () => {
    const ids = moog995Def.outputs.map((p) => p.id);
    expect(ids).toEqual(['out1', 'out2', 'out3']);
    for (const p of moog995Def.outputs) {
      expect(p.type).toBe('audio');
    }
  });

  it('exposes 3 params (atten1..atten3), all linear 0..1 default 1', () => {
    const ids = moog995Def.params.map((p) => p.id);
    expect(ids).toEqual(['atten1', 'atten2', 'atten3']);
    for (const p of moog995Def.params) {
      expect(p.min).toBe(0);
      expect(p.max).toBe(1);
      expect(p.defaultValue).toBe(1);
      expect(p.curve).toBe('linear');
    }
  });
});

// ───────────────────── Layer 2: pure Web Audio factory ─────────────────────
// The 995 is a pure-gain module (no worklet / no Faust). Mock just the slice
// of AudioContext the factory touches: createGain() + currentTime. Each
// GainNode carries a settable .gain.value (via setValueAtTime) and a
// connect/disconnect spy — the same FakeGain shape the foxy/scope factory
// tests use.
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
    id: 'moog995-test',
    type: 'moog995',
    domain: 'audio',
    position: { x: 0, y: 0 },
    params,
  };
}

describe('moog995 factory: pure Web Audio graph', () => {
  it('creates exactly three GainNodes (one per channel)', async () => {
    const { ctx, created } = makeMockCtx();
    await moog995Def.factory(ctx as unknown as AudioContext, makeNode());
    expect(created).toHaveLength(3);
  });

  it('exposes the declared inputs in1..in3, each at { input: 0 } of its own gain node', async () => {
    const { ctx, created } = makeMockCtx();
    const handle = await moog995Def.factory(ctx as unknown as AudioContext, makeNode());
    for (let ch = 1; ch <= 3; ch++) {
      const entry = handle.inputs.get(`in${ch}`);
      expect(entry).toBeDefined();
      expect(entry!.input).toBe(0);
      // The channel's input feeds its OWN gain node (the same one its output
      // taps) — proving each channel is an independent attenuator.
      expect(entry!.node).toBe(created[ch - 1]);
    }
  });

  it('exposes the declared outputs out1..out3, each at { output: 0 } of its own gain node', async () => {
    const { ctx, created } = makeMockCtx();
    const handle = await moog995Def.factory(ctx as unknown as AudioContext, makeNode());
    for (let ch = 1; ch <= 3; ch++) {
      const entry = handle.outputs.get(`out${ch}`);
      expect(entry).toBeDefined();
      expect(entry!.output).toBe(0);
      expect(entry!.node).toBe(created[ch - 1]);
    }
  });

  it('routes in_N and out_N to the SAME node (in_N → gain_N → out_N) — no cross-talk', async () => {
    const { ctx } = makeMockCtx();
    const handle = await moog995Def.factory(ctx as unknown as AudioContext, makeNode());
    for (let ch = 1; ch <= 3; ch++) {
      expect(handle.inputs.get(`in${ch}`)!.node).toBe(handle.outputs.get(`out${ch}`)!.node);
    }
    // ...and DIFFERENT channels use different nodes.
    const nodes = [1, 2, 3].map((ch) => handle.inputs.get(`in${ch}`)!.node);
    expect(new Set(nodes).size).toBe(3);
  });

  it('applies the def default (1.0 = unity) to every gain when no params are saved', async () => {
    const { ctx, created } = makeMockCtx();
    await moog995Def.factory(ctx as unknown as AudioContext, makeNode());
    for (const g of created) {
      expect(g.gain.value).toBe(1);
    }
  });

  it('applies saved param overrides to the matching gain', async () => {
    const { ctx } = makeMockCtx();
    const handle = await moog995Def.factory(
      ctx as unknown as AudioContext,
      makeNode({ atten1: 0.25, atten2: 0.5, atten3: 0 }),
    );
    expect(handle.readParam('atten1')).toBeCloseTo(0.25, 12);
    expect(handle.readParam('atten2')).toBeCloseTo(0.5, 12);
    expect(handle.readParam('atten3')).toBe(0);
  });

  it('setParam then readParam round-trips on each channel independently', async () => {
    const { ctx } = makeMockCtx();
    const handle = await moog995Def.factory(ctx as unknown as AudioContext, makeNode());
    handle.setParam('atten1', 0.3);
    handle.setParam('atten2', 0.7);
    handle.setParam('atten3', 0.9);
    expect(handle.readParam('atten1')).toBeCloseTo(0.3, 12);
    expect(handle.readParam('atten2')).toBeCloseTo(0.7, 12);
    expect(handle.readParam('atten3')).toBeCloseTo(0.9, 12);
    // Moving one channel does not disturb the others.
    handle.setParam('atten2', 0.1);
    expect(handle.readParam('atten1')).toBeCloseTo(0.3, 12);
    expect(handle.readParam('atten2')).toBeCloseTo(0.1, 12);
    expect(handle.readParam('atten3')).toBeCloseTo(0.9, 12);
  });

  it('setParam writes the representative gain on the channel-2 GainNode', async () => {
    const { ctx, created } = makeMockCtx();
    const handle = await moog995Def.factory(ctx as unknown as AudioContext, makeNode());
    handle.setParam('atten2', 0.42);
    // created[1] is the channel-2 gain node — its live .gain.value reflects it.
    expect(created[1].gain.value).toBeCloseTo(0.42, 12);
  });

  it('readParam on an unknown param id returns undefined', async () => {
    const { ctx } = makeMockCtx();
    const handle = await moog995Def.factory(ctx as unknown as AudioContext, makeNode());
    expect(handle.readParam('nope')).toBeUndefined();
  });

  it('dispose() disconnects every gain node it created', async () => {
    const { ctx, created } = makeMockCtx();
    const handle = await moog995Def.factory(ctx as unknown as AudioContext, makeNode());
    handle.dispose();
    for (const g of created) {
      expect(g.disconnect).toHaveBeenCalled();
    }
  });
});
