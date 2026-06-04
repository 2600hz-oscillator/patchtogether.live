// packages/web/src/lib/audio/modules/moog992.test.ts
//
// Two test layers for the MOOG 992 CV PANEL (moogafakkin System 55/35 clone):
//   1. Module-def shape — pins the 992's I/O surface (cv1..cv4 inputs, the
//      single cv_out output, the literal atten1..atten4 param array) so a
//      refactor that silently drops a port / param fails loudly (the
//      per-module-per-port regression-net class of bug).
//   2. Factory wiring — the 992 is PASSIVE (pure Web Audio: GainNode per
//      channel → one summing GainNode), so there's no worklet to instantiate.
//      We drive the factory with a mock AudioContext whose GainNodes record
//      their connections + gain.value, then assert: every declared input/output
//      is exposed and points at the right node, each channel's attenuator maps
//      to its gain (channel 4 NEGATED so it inverts), all four channels feed the
//      one summer, setParam→readParam round-trips, and dispose() disconnects
//      every node the factory made.

import { describe, it, expect } from 'vitest';
import { moog992Def } from './moog992';
import type { ModuleNode } from '$lib/graph/types';

// ───────────────────── Layer 1: module-def shape ─────────────────────
describe('moog992Def: module def shape', () => {
  it('declares type=moog992, label="992 Control Voltage Panel", category=modulation, schemaVersion=1', () => {
    expect(moog992Def.type).toBe('moog992');
    expect(moog992Def.label).toBe('992 Control Voltage Panel');
    expect(moog992Def.category).toBe('modulation');
    expect(moog992Def.schemaVersion).toBe(1);
  });

  it('lives in the Ports → moogafakkin palette bucket and uses the Moog992Card', () => {
    expect(moog992Def.palette).toEqual({ top: 'Ports', sub: 'moogafakkin' });
    expect(moog992Def.card).toBe('Moog992Card');
  });

  it('exposes the four CV inputs: cv1..cv4 (all cv cables, PASSTHROUGH)', () => {
    const ids = moog992Def.inputs.map((p) => p.id);
    expect(ids).toEqual(['cv1', 'cv2', 'cv3', 'cv4']);
    for (const p of moog992Def.inputs) {
      expect(p.type).toBe('cv');
      // The inputs are signals being routed, not knob modulators.
      expect(p.cvScale).toBeUndefined();
      expect(p.paramTarget).toBeUndefined();
    }
  });

  it('exposes a single summed cv output: cv_out (cv)', () => {
    const ids = moog992Def.outputs.map((p) => p.id);
    expect(ids).toEqual(['cv_out']);
    expect(moog992Def.outputs[0].type).toBe('cv');
  });

  it('exposes 4 params (atten1..atten4), all linear 0..1 default 1', () => {
    const ids = moog992Def.params.map((p) => p.id);
    expect(ids).toEqual(['atten1', 'atten2', 'atten3', 'atten4']);
    for (const p of moog992Def.params) {
      expect(p.min).toBe(0);
      expect(p.max).toBe(1);
      expect(p.defaultValue).toBe(1);
      expect(p.curve).toBe('linear');
    }
  });
});

// ───────────────────── Layer 2: factory wiring ─────────────────────
//
// Minimal Web Audio mock. Each GainNode tracks its gain.value + the nodes it
// connected to, so we can assert the summing topology + the inverting channel.
interface MockGainNode {
  gain: { value: number };
  connectedTo: MockGainNode[];
  connect: (dest: MockGainNode) => void;
  disconnect: () => void;
  disconnectCount: number;
}

function makeMockCtx(): { ctx: AudioContext; gains: MockGainNode[] } {
  const gains: MockGainNode[] = [];
  function createGain(): MockGainNode {
    const g: MockGainNode = {
      gain: { value: 1 },
      connectedTo: [],
      disconnectCount: 0,
      connect(dest: MockGainNode) {
        this.connectedTo.push(dest);
      },
      disconnect() {
        this.disconnectCount++;
      },
    };
    gains.push(g);
    return g;
  }
  const ctx = { createGain } as unknown as AudioContext;
  return { ctx, gains };
}

function makeNode(params: Record<string, number> = {}): ModuleNode {
  return {
    id: 'moog992-test',
    type: 'moog992',
    domain: 'audio',
    position: { x: 0, y: 0 },
    params,
    data: {},
  };
}

describe('moog992 factory: wiring + params', () => {
  it('exposes the four declared inputs, each at input index 0 of its own node', async () => {
    const { ctx } = makeMockCtx();
    const handle = await moog992Def.factory(ctx, makeNode());
    for (const id of ['cv1', 'cv2', 'cv3', 'cv4']) {
      const entry = handle.inputs.get(id);
      expect(entry, `input ${id}`).toBeDefined();
      expect(entry!.input).toBe(0);
    }
    // The four inputs land on four DISTINCT nodes (one attenuator each).
    const nodes = ['cv1', 'cv2', 'cv3', 'cv4'].map((id) => handle.inputs.get(id)!.node);
    expect(new Set(nodes).size).toBe(4);
  });

  it('exposes cv_out at output index 0 of the summing node', async () => {
    const { ctx } = makeMockCtx();
    const handle = await moog992Def.factory(ctx, makeNode());
    const out = handle.outputs.get('cv_out');
    expect(out).toBeDefined();
    expect(out!.output).toBe(0);
  });

  it('routes all four channel attenuators into the one summing node', async () => {
    const { ctx } = makeMockCtx();
    const handle = await moog992Def.factory(ctx, makeNode());
    const summer = handle.outputs.get('cv_out')!.node as unknown as MockGainNode;
    for (const id of ['cv1', 'cv2', 'cv3', 'cv4']) {
      const chan = handle.inputs.get(id)!.node as unknown as MockGainNode;
      expect(chan.connectedTo, `${id} → summer`).toContain(summer);
    }
  });

  it('applies the default attenuators (1.0) to channels 1..3 and NEGATES channel 4', async () => {
    const { ctx } = makeMockCtx();
    const handle = await moog992Def.factory(ctx, makeNode());
    for (const id of ['cv1', 'cv2', 'cv3']) {
      const g = handle.inputs.get(id)!.node as unknown as MockGainNode;
      expect(g.gain.value, `${id} gain`).toBeCloseTo(1, 6);
    }
    // Channel 4 is signal-inverting → gain is −atten4.
    const g4 = handle.inputs.get('cv4')!.node as unknown as MockGainNode;
    expect(g4.gain.value).toBeCloseTo(-1, 6);
    // The summing node is unity.
    const summer = handle.outputs.get('cv_out')!.node as unknown as MockGainNode;
    expect(summer.gain.value).toBeCloseTo(1, 6);
  });

  it('honors initial node.params at mount (channel gains seeded from params, ch4 negated)', async () => {
    const { ctx } = makeMockCtx();
    const handle = await moog992Def.factory(
      ctx,
      makeNode({ atten1: 0.25, atten2: 0.5, atten3: 0.75, atten4: 0.6 }),
    );
    expect((handle.inputs.get('cv1')!.node as unknown as MockGainNode).gain.value).toBeCloseTo(0.25, 6);
    expect((handle.inputs.get('cv2')!.node as unknown as MockGainNode).gain.value).toBeCloseTo(0.5, 6);
    expect((handle.inputs.get('cv3')!.node as unknown as MockGainNode).gain.value).toBeCloseTo(0.75, 6);
    expect((handle.inputs.get('cv4')!.node as unknown as MockGainNode).gain.value).toBeCloseTo(-0.6, 6);
  });

  it('setParam then readParam round-trips for each channel (ch4 magnitude, not polarity)', async () => {
    const { ctx } = makeMockCtx();
    const handle = await moog992Def.factory(ctx, makeNode());
    // Defaults read back as 1 (ch4 reports its positive attenuator magnitude).
    for (const id of ['atten1', 'atten2', 'atten3', 'atten4']) {
      expect(handle.readParam(id), `${id} default`).toBeCloseTo(1, 6);
    }
    handle.setParam('atten1', 0.3);
    handle.setParam('atten2', 0.0);
    handle.setParam('atten3', 0.9);
    handle.setParam('atten4', 0.4);
    expect(handle.readParam('atten1')).toBeCloseTo(0.3, 6);
    expect(handle.readParam('atten2')).toBeCloseTo(0.0, 6);
    expect(handle.readParam('atten3')).toBeCloseTo(0.9, 6);
    expect(handle.readParam('atten4')).toBeCloseTo(0.4, 6);
  });

  it('setParam(atten4) applies a NEGATED live gain (the inverting channel)', async () => {
    const { ctx } = makeMockCtx();
    const handle = await moog992Def.factory(ctx, makeNode());
    handle.setParam('atten4', 0.4);
    const g4 = handle.inputs.get('cv4')!.node as unknown as MockGainNode;
    // Live gain is negative (inverts the signal); readParam reports +0.4.
    expect(g4.gain.value).toBeCloseTo(-0.4, 6);
    expect(handle.readParam('atten4')).toBeCloseTo(0.4, 6);
  });

  it('setParam for channels 1..3 applies a positive gain (no inversion)', async () => {
    const { ctx } = makeMockCtx();
    const handle = await moog992Def.factory(ctx, makeNode());
    handle.setParam('atten2', 0.7);
    const g2 = handle.inputs.get('cv2')!.node as unknown as MockGainNode;
    expect(g2.gain.value).toBeCloseTo(0.7, 6);
  });

  it('setParam ignores unknown param ids without throwing', async () => {
    const { ctx } = makeMockCtx();
    const handle = await moog992Def.factory(ctx, makeNode());
    expect(() => handle.setParam('nope', 0.5)).not.toThrow();
    expect(handle.readParam('nope')).toBeUndefined();
  });

  it('dispose() disconnects every node the factory created (4 channels + summer)', async () => {
    const { ctx, gains } = makeMockCtx();
    const handle = await moog992Def.factory(ctx, makeNode());
    // 4 channel gains + 1 summing gain.
    expect(gains.length).toBe(5);
    handle.dispose();
    for (const g of gains) {
      expect(g.disconnectCount).toBeGreaterThanOrEqual(1);
    }
  });
});
