// packages/web/src/lib/audio/modules/polarizer.test.ts
//
// Three test layers for POLARIZER (1-in / 1-out CV utility, unipolar→bipolar,
// out = (2·in − 1)·depth):
//   1. Module-def shape — pins the CV-only I/O surface (a single `in` cv port,
//      a single `out` cv port, the `depth` param: linear 0..1 default 1) so a
//      refactor that silently drops a port / flips a type / changes the range
//      fails loudly (the per-module-per-port regression class).
//   2. DSP correctness — the pure `polarize(in, depth)` helper IS the contract:
//      assert the user-specified cases (in=0→−1, in=0.5→0, in=1→+1 at depth 1)
//      plus the DEPTH scaling (depth=0.5 → half swing, depth=0 → flat 0) and a
//      symmetry/affine check.
//   3. Factory behavior — drive the PURE Web Audio factory with a mock
//      AudioContext (a GainNode scale + a ConstantSource→GainNode offset, no
//      worklet): assert the affine graph realizes out = scale·in + offset with
//      scale = 2·depth and offset = −depth, the default applies, saved
//      overrides apply, and setParam/readParam round-trips.

import { describe, it, expect, vi } from 'vitest';
import { polarizerDef, polarize } from './polarizer';
import type { ModuleNode } from '$lib/graph/types';

// ───────────────────── Layer 1: module-def shape ─────────────────────
// ───────────────────── Layer 2: DSP correctness ─────────────────────
describe('polarize(): out = (2·in − 1)·depth', () => {
  it('depth=1 (full ±1 swing): in=0 → −1, in=0.5 → 0, in=1 → +1', () => {
    expect(polarize(0, 1)).toBeCloseTo(-1, 12);
    expect(polarize(0.5, 1)).toBeCloseTo(0, 12);
    expect(polarize(1, 1)).toBeCloseTo(1, 12);
    // Quarter points too.
    expect(polarize(0.25, 1)).toBeCloseTo(-0.5, 12);
    expect(polarize(0.75, 1)).toBeCloseTo(0.5, 12);
  });

  it('depth=0.5 halves the swing about 0: in=0 → −0.5, in=0.5 → 0, in=1 → +0.5', () => {
    expect(polarize(0, 0.5)).toBeCloseTo(-0.5, 12);
    expect(polarize(0.5, 0.5)).toBeCloseTo(0, 12);
    expect(polarize(1, 0.5)).toBeCloseTo(0.5, 12);
  });

  it('depth=0 → flat 0 regardless of input', () => {
    for (const x of [0, 0.25, 0.5, 0.75, 1]) {
      // ±0 are equal numerically; normalize to avoid the -0 vs +0 strict mismatch.
      expect(polarize(x, 0) + 0).toBe(0);
    }
  });

  it('center (in=0.5) maps to 0 at every depth (the bipolar zero stays put)', () => {
    for (const d of [0, 0.25, 0.5, 1]) {
      expect(polarize(0.5, d)).toBeCloseTo(0, 12);
    }
  });

  it('is affine: out = 2·depth·in − depth (slope 2·depth, offset −depth)', () => {
    for (const depth of [0.1, 0.5, 1]) {
      for (const x of [0, 0.2, 0.5, 0.8, 1, -0.3, 1.7]) {
        expect(polarize(x, depth)).toBeCloseTo(2 * depth * x - depth, 12);
      }
    }
  });
});

// ───────────────────── Layer 3: pure Web Audio factory ─────────────────────
// POLARIZER is a pure-node module (no worklet): a GainNode (input scale) + a
// ConstantSourceNode → GainNode (the −depth offset), both summed into a unity
// `out` GainNode. Mock just the slice of AudioContext the factory touches.
interface FakeAudioParam {
  value: number;
  setValueAtTime: (v: number, t: number) => void;
}
function mkParam(initial = 0): FakeAudioParam {
  return {
    value: initial,
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
class FakeConstant {
  offset = mkParam();
  start = vi.fn();
  stop = vi.fn();
  connect = vi.fn();
  disconnect = vi.fn();
}
function makeMockCtx() {
  const gains: FakeGain[] = [];
  const consts: FakeConstant[] = [];
  const ctx = {
    currentTime: 0,
    sampleRate: 48000,
    createGain: () => {
      const g = new FakeGain();
      gains.push(g);
      return g;
    },
    createConstantSource: () => {
      const c = new FakeConstant();
      consts.push(c);
      return c;
    },
  };
  return { ctx, gains, consts };
}

function makeNode(params: Record<string, number> = {}): ModuleNode {
  return {
    id: 'polarizer-test',
    type: 'polarizer',
    domain: 'audio',
    position: { x: 0, y: 0 },
    params,
  };
}

// The factory creates gains in order: [0]=inScale, [1]=out, [2]=offset.
const IN_SCALE = 0;
const OUT = 1;
const OFFSET = 2;

describe('polarizer factory: pure Web Audio graph', () => {
  it('creates the affine node set: 3 GainNodes + 1 started ConstantSource', async () => {
    const { ctx, gains, consts } = makeMockCtx();
    await polarizerDef.factory(ctx as unknown as AudioContext, makeNode());
    expect(gains).toHaveLength(3);
    expect(consts).toHaveLength(1);
    // The constant source is started (so it actually emits the offset).
    expect(consts[0].start).toHaveBeenCalled();
    // The constant carries 1.0 (the offset GainNode scales it to −depth).
    expect(consts[0].offset.value).toBe(1);
  });

  it('the `in` port taps the input-scale gain; `out` taps the summing gain', async () => {
    const { ctx, gains } = makeMockCtx();
    const handle = await polarizerDef.factory(ctx as unknown as AudioContext, makeNode());
    const inEntry = handle.inputs.get('in');
    const outEntry = handle.outputs.get('out');
    expect(inEntry).toBeDefined();
    expect(outEntry).toBeDefined();
    expect(inEntry!.input).toBe(0);
    expect(outEntry!.output).toBe(0);
    expect(inEntry!.node).toBe(gains[IN_SCALE]);
    expect(outEntry!.node).toBe(gains[OUT]);
    // The summing OUT gain is unity (it just sums scale + offset).
    expect(gains[OUT].gain.value).toBe(1);
  });

  it('default depth=1 → slope 2·1=2 on the input, offset −1', async () => {
    const { ctx, gains } = makeMockCtx();
    await polarizerDef.factory(ctx as unknown as AudioContext, makeNode());
    expect(gains[IN_SCALE].gain.value).toBeCloseTo(2, 12);
    expect(gains[OFFSET].gain.value).toBeCloseTo(-1, 12);
  });

  it('applies a saved DEPTH override (depth=0.5 → slope 1, offset −0.5)', async () => {
    const { ctx, gains } = makeMockCtx();
    await polarizerDef.factory(ctx as unknown as AudioContext, makeNode({ depth: 0.5 }));
    expect(gains[IN_SCALE].gain.value).toBeCloseTo(1, 12);
    expect(gains[OFFSET].gain.value).toBeCloseTo(-0.5, 12);
  });

  it('the realized graph computes out = (2·in − 1)·depth across inputs', async () => {
    // out(x) = inScale.gain·x + offset.gain·1 = 2·depth·x + (−depth).
    for (const depth of [0, 0.5, 1]) {
      const { ctx, gains } = makeMockCtx();
      await polarizerDef.factory(ctx as unknown as AudioContext, makeNode({ depth }));
      const slope = gains[IN_SCALE].gain.value;
      const offset = gains[OFFSET].gain.value; // constant src is 1.0, so offset.gain IS the constant
      for (const x of [0, 0.25, 0.5, 0.75, 1]) {
        expect(slope * x + offset).toBeCloseTo(polarize(x, depth), 12);
      }
    }
  });

  it('setParam then readParam round-trips, and live-updates both gains', async () => {
    const { ctx, gains } = makeMockCtx();
    const handle = await polarizerDef.factory(ctx as unknown as AudioContext, makeNode());
    handle.setParam('depth', 0.25);
    expect(handle.readParam('depth')).toBeCloseTo(0.25, 12);
    expect(gains[IN_SCALE].gain.value).toBeCloseTo(0.5, 12);
    expect(gains[OFFSET].gain.value).toBeCloseTo(-0.25, 12);
  });

  it('readParam on an unknown param id returns undefined', async () => {
    const { ctx } = makeMockCtx();
    const handle = await polarizerDef.factory(ctx as unknown as AudioContext, makeNode());
    expect(handle.readParam('nope')).toBeUndefined();
  });

  it('dispose() stops the constant source and disconnects every node', async () => {
    const { ctx, gains, consts } = makeMockCtx();
    const handle = await polarizerDef.factory(ctx as unknown as AudioContext, makeNode());
    handle.dispose();
    expect(consts[0].stop).toHaveBeenCalled();
    for (const g of gains) expect(g.disconnect).toHaveBeenCalled();
  });
});
