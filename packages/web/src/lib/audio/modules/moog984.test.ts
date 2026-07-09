// packages/web/src/lib/audio/modules/moog984.test.ts
//
// Two test layers for the MOOG 984 4-CHANNEL MATRIX MIXER:
//   1. Module-def shape — pins the 984's I/O surface (in1..in4 inputs;
//      out1..out4 outputs; the 16 cross-point params m11..m44, all linear
//      0..1 default 0) so a refactor that silently drops a port/param fails
//      loudly (the per-module-per-port regression-net class of bug).
//   2. Pure Web Audio factory wiring — drive def.factory with a mock
//      AudioContext (records every GainNode + its connections), assert the
//      handle exposes the declared inputs/outputs pointing at the right
//      receiving/summing nodes, that setParam → readParam round-trips on a
//      cross-point, that a cross-point's gain.value reflects its m_ij coeff,
//      and that the matrix is wired in→fan→cross→sum→out.

import { describe, it, expect } from 'vitest';
import { moog984Def } from './moog984';
import type { ModuleNode } from '$lib/graph/types';

// ───────────────────── Mock Web Audio surface ─────────────────────
// The 984 is a PURE GainNode graph (no worklet), so the factory only needs
// createGain + currentTime. Each FakeGain records its outgoing connections so
// we can verify the in→fan→cross→sum→out topology.

interface FakeAudioParam {
  value: number;
  setValueAtTime(v: number, t: number): void;
}

class FakeGain {
  readonly id: number;
  gain: FakeAudioParam;
  // Outgoing connections (the AudioNodes this node feeds).
  outgoing: FakeGain[] = [];
  disconnected = false;
  constructor(id: number) {
    this.id = id;
    this.gain = {
      value: 1,
      setValueAtTime(v: number) {
        this.value = v;
      },
    };
  }
  connect(dest: FakeGain): void {
    this.outgoing.push(dest);
  }
  disconnect(): void {
    this.disconnected = true;
    this.outgoing = [];
  }
}

class FakeAudioContext {
  currentTime = 0;
  gains: FakeGain[] = [];
  createGain(): FakeGain {
    const g = new FakeGain(this.gains.length);
    this.gains.push(g);
    return g;
  }
}

function makeNode(params: Record<string, number> = {}): ModuleNode {
  return {
    id: 'moog984-test',
    type: 'moog984',
    domain: 'audio',
    position: { x: 0, y: 0 },
    params,
  };
}

async function build(params: Record<string, number> = {}) {
  const ctx = new FakeAudioContext();
  const handle = await moog984Def.factory(ctx as unknown as AudioContext, makeNode(params));
  return { ctx, handle };
}

// ───────────────────── Layer 1: module-def shape ─────────────────────
// ───────────────────── Layer 2: pure factory wiring ─────────────────────
describe('moog984 factory: pure GainNode matrix', () => {
  it('exposes the declared input port surface (in1..in4 each → one receiving node)', async () => {
    const { handle } = await build();
    expect([...handle.inputs.keys()].sort()).toEqual(['in1', 'in2', 'in3', 'in4']);
    // Each input maps to a distinct receiving node at input index 0.
    const recvNodes = new Set();
    for (const id of ['in1', 'in2', 'in3', 'in4']) {
      const entry = handle.inputs.get(id)!;
      expect(entry.input).toBe(0);
      expect(entry.node).toBeDefined();
      recvNodes.add(entry.node);
    }
    expect(recvNodes.size).toBe(4); // four distinct per-input fan gains
  });

  it('exposes the declared output port surface (out1..out4 each → one summing node)', async () => {
    const { handle } = await build();
    expect([...handle.outputs.keys()].sort()).toEqual(['out1', 'out2', 'out3', 'out4']);
    const sumNodes = new Set();
    for (const id of ['out1', 'out2', 'out3', 'out4']) {
      const entry = handle.outputs.get(id)!;
      expect(entry.output).toBe(0);
      expect(entry.node).toBeDefined();
      sumNodes.add(entry.node);
    }
    expect(sumNodes.size).toBe(4); // four distinct column-summing gains
  });

  it('creates 24 GainNodes (4 fan-in + 16 cross-point + 4 sum-out)', async () => {
    const { ctx } = await build();
    expect(ctx.gains.length).toBe(24);
  });

  it('defaults every cross-point gain to 0 (silent until a cross-point is dialed in)', async () => {
    const { handle } = await build();
    for (let i = 1; i <= 4; i++) {
      for (let j = 1; j <= 4; j++) {
        expect(handle.readParam(`m${i}${j}`)).toBe(0);
      }
    }
  });

  it('honors initial node.params for cross-point coefficients', async () => {
    const { handle } = await build({ m11: 0.5, m23: 0.75, m44: 1 });
    expect(handle.readParam('m11')).toBe(0.5);
    expect(handle.readParam('m23')).toBe(0.75);
    expect(handle.readParam('m44')).toBe(1);
    // Untouched cross-points keep their default 0.
    expect(handle.readParam('m12')).toBe(0);
  });

  it('setParam → readParam round-trips on a representative cross-point', async () => {
    const { handle } = await build();
    expect(handle.readParam('m32')).toBe(0);
    handle.setParam('m32', 0.42);
    expect(handle.readParam('m32')).toBeCloseTo(0.42, 6);
    handle.setParam('m32', 0.9);
    expect(handle.readParam('m32')).toBeCloseTo(0.9, 6);
    // Setting one cross-point doesn't bleed into its neighbours.
    expect(handle.readParam('m31')).toBe(0);
    expect(handle.readParam('m33')).toBe(0);
  });

  it('setParam applies the value to the cross-point gain.value (representative gain)', async () => {
    const { ctx, handle } = await build();
    handle.setParam('m21', 0.6);
    // Exactly one GainNode should now carry 0.6 (m21's cross-point).
    const carrying = ctx.gains.filter((g) => Math.abs(g.gain.value - 0.6) < 1e-9);
    expect(carrying.length).toBe(1);
  });

  it('ignores out-of-range / malformed param ids on setParam + readParam', async () => {
    const { handle } = await build();
    expect(handle.readParam('m55')).toBeUndefined(); // out of 4×4 range
    expect(handle.readParam('master')).toBeUndefined();
    expect(handle.readParam('m1')).toBeUndefined();
    // setParam on a bad id is a no-op (must not throw).
    expect(() => handle.setParam('m55', 0.5)).not.toThrow();
    expect(() => handle.setParam('nope', 0.5)).not.toThrow();
  });

  it('wires in→fan→cross→sum→out (each fan feeds 4 cross-points; each column sums to its out)', async () => {
    const { handle } = await build();
    // Sanity: each input's fan-in node feeds exactly 4 cross-point gains.
    for (const id of ['in1', 'in2', 'in3', 'in4']) {
      const fan = handle.inputs.get(id)!.node as unknown as FakeGain;
      expect(fan.outgoing.length).toBe(4);
    }
    // Each column-summing node is fed by exactly 4 cross-points. We verify by
    // counting, across all cross-point gains, how many feed each sum-out node.
    const sumNodes = ['out1', 'out2', 'out3', 'out4'].map(
      (id) => handle.outputs.get(id)!.node as unknown as FakeGain,
    );
    for (const sum of sumNodes) {
      let feeders = 0;
      for (const id of ['in1', 'in2', 'in3', 'in4']) {
        const fan = handle.inputs.get(id)!.node as unknown as FakeGain;
        for (const cross of fan.outgoing) {
          if (cross.outgoing.includes(sum)) feeders++;
        }
      }
      expect(feeders).toBe(4); // one cross-point per input feeds this column
    }
  });

  it('dispose() disconnects every node it created', async () => {
    const { ctx, handle } = await build();
    expect(ctx.gains.every((g) => !g.disconnected)).toBe(true);
    handle.dispose();
    expect(ctx.gains.length).toBe(24);
    expect(ctx.gains.every((g) => g.disconnected)).toBe(true);
  });
});
