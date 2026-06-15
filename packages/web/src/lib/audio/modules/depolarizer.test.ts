// packages/web/src/lib/audio/modules/depolarizer.test.ts
//
// Three test layers for DEPOLARIZER (1-in / 1-out CV utility, bipolar→unipolar,
// out = 0.5 + depth·(in/2)):
//   1. Module-def shape — pins the CV-only I/O surface (a single `in` cv port,
//      a single `out` cv port, the `depth` param: linear 0..1 default 1).
//   2. DSP correctness — the pure `depolarize(in, depth)` helper IS the
//      contract: in=−1→0, in=0→0.5, in=+1→1 at depth 1, plus the DEPTH-toward-
//      0.5-center semantics (depth=0.5 → 0.25..0.75, depth=0 → flat 0.5).
//   3. Factory behavior — the pure Web Audio affine graph (a GainNode scale
//      depth/2 + a ConstantSource→GainNode FIXED 0.5 center) realizes
//      out = (depth/2)·in + 0.5; default/override/round-trip/dispose.

import { describe, it, expect, vi } from 'vitest';
import { depolarizerDef, depolarize } from './depolarizer';
import type { ModuleNode } from '$lib/graph/types';

// ───────────────────── Layer 1: module-def shape ─────────────────────
describe('depolarizerDef: module def shape', () => {
  it('declares type=depolarizer, label="depolarizer" (lowercase), category=utilities, domain=audio, schemaVersion=1', () => {
    expect(depolarizerDef.type).toBe('depolarizer');
    expect(depolarizerDef.label).toBe('depolarizer');
    expect(depolarizerDef.label).toBe(depolarizerDef.label.toLowerCase());
    expect(depolarizerDef.category).toBe('utilities');
    expect(depolarizerDef.domain).toBe('audio');
    expect(depolarizerDef.schemaVersion).toBe(1);
  });

  it('lands in the Utilities palette (Audio modules → Utility)', () => {
    expect(depolarizerDef.palette).toEqual({ top: 'Audio modules', sub: 'Utility' });
  });

  it('exposes a single CV-only `in` input (no audio widening)', () => {
    expect(depolarizerDef.inputs.map((p) => p.id)).toEqual(['in']);
    const inp = depolarizerDef.inputs[0];
    expect(inp.type).toBe('cv');
    expect(inp.accepts).toBeUndefined();
    expect(inp.paramTarget).toBeUndefined();
  });

  it('exposes a single CV-only `out` output', () => {
    expect(depolarizerDef.outputs.map((p) => p.id)).toEqual(['out']);
    expect(depolarizerDef.outputs[0].type).toBe('cv');
  });

  it('exposes one DEPTH param: linear taper, 0..1, default 1', () => {
    expect(depolarizerDef.params.map((p) => p.id)).toEqual(['depth']);
    const d = depolarizerDef.params[0];
    expect(d.label).toBe('DEPTH');
    expect(d.min).toBe(0);
    expect(d.max).toBe(1);
    expect(d.defaultValue).toBe(1);
    expect(d.curve).toBe('linear');
  });
});

// ───────────────────── Layer 2: DSP correctness ─────────────────────
describe('depolarize(): out = 0.5 + depth·(in/2)', () => {
  it('depth=1 (full map): in=−1 → 0, in=0 → 0.5, in=+1 → 1', () => {
    expect(depolarize(-1, 1)).toBeCloseTo(0, 12);
    expect(depolarize(0, 1)).toBeCloseTo(0.5, 12);
    expect(depolarize(1, 1)).toBeCloseTo(1, 12);
    // Quarter points: (in+1)/2.
    expect(depolarize(-0.5, 1)).toBeCloseTo(0.25, 12);
    expect(depolarize(0.5, 1)).toBeCloseTo(0.75, 12);
  });

  it('depth=0.5: output swings only 0.25..0.75 about the 0.5 center', () => {
    expect(depolarize(-1, 0.5)).toBeCloseTo(0.25, 12);
    expect(depolarize(0, 0.5)).toBeCloseTo(0.5, 12);
    expect(depolarize(1, 0.5)).toBeCloseTo(0.75, 12);
  });

  it('depth=0 → flat 0.5 (the unipolar center) regardless of input', () => {
    for (const x of [-1, -0.4, 0, 0.4, 1]) {
      expect(depolarize(x, 0)).toBeCloseTo(0.5, 12);
    }
  });

  it('input 0 always maps to the 0.5 center at every depth', () => {
    for (const d of [0, 0.25, 0.5, 1]) {
      expect(depolarize(0, d)).toBeCloseTo(0.5, 12);
    }
  });

  it('is the inverse of the unipolar→bipolar map at depth 1 (round-trips)', () => {
    // depolarize(2·u − 1, 1) === u for u in [0,1].
    for (const u of [0, 0.2, 0.5, 0.8, 1]) {
      expect(depolarize(2 * u - 1, 1)).toBeCloseTo(u, 12);
    }
  });
});

// ───────────────────── Layer 3: pure Web Audio factory ─────────────────────
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
    id: 'depolarizer-test',
    type: 'depolarizer',
    domain: 'audio',
    position: { x: 0, y: 0 },
    params,
  };
}

// The factory creates gains in order: [0]=inScale, [1]=out, [2]=center.
const IN_SCALE = 0;
const OUT = 1;
const CENTER = 2;

describe('depolarizer factory: pure Web Audio graph', () => {
  it('creates the affine node set: 3 GainNodes + 1 started ConstantSource', async () => {
    const { ctx, gains, consts } = makeMockCtx();
    await depolarizerDef.factory(ctx as unknown as AudioContext, makeNode());
    expect(gains).toHaveLength(3);
    expect(consts).toHaveLength(1);
    expect(consts[0].start).toHaveBeenCalled();
    expect(consts[0].offset.value).toBe(1);
  });

  it('the `in` port taps the input-scale gain; `out` taps the summing gain', async () => {
    const { ctx, gains } = makeMockCtx();
    const handle = await depolarizerDef.factory(ctx as unknown as AudioContext, makeNode());
    const inEntry = handle.inputs.get('in');
    const outEntry = handle.outputs.get('out');
    expect(inEntry).toBeDefined();
    expect(outEntry).toBeDefined();
    expect(inEntry!.input).toBe(0);
    expect(outEntry!.output).toBe(0);
    expect(inEntry!.node).toBe(gains[IN_SCALE]);
    expect(outEntry!.node).toBe(gains[OUT]);
    expect(gains[OUT].gain.value).toBe(1);
  });

  it('the center offset is a FIXED 0.5 (independent of depth)', async () => {
    const { ctx, gains } = makeMockCtx();
    await depolarizerDef.factory(ctx as unknown as AudioContext, makeNode({ depth: 0.3 }));
    expect(gains[CENTER].gain.value).toBeCloseTo(0.5, 12);
  });

  it('default depth=1 → slope depth/2 = 0.5 on the input', async () => {
    const { ctx, gains } = makeMockCtx();
    await depolarizerDef.factory(ctx as unknown as AudioContext, makeNode());
    expect(gains[IN_SCALE].gain.value).toBeCloseTo(0.5, 12);
  });

  it('applies a saved DEPTH override (depth=0.5 → slope 0.25)', async () => {
    const { ctx, gains } = makeMockCtx();
    await depolarizerDef.factory(ctx as unknown as AudioContext, makeNode({ depth: 0.5 }));
    expect(gains[IN_SCALE].gain.value).toBeCloseTo(0.25, 12);
  });

  it('the realized graph computes out = 0.5 + depth·(in/2) across inputs', async () => {
    for (const depth of [0, 0.5, 1]) {
      const { ctx, gains } = makeMockCtx();
      await depolarizerDef.factory(ctx as unknown as AudioContext, makeNode({ depth }));
      const slope = gains[IN_SCALE].gain.value;
      const offset = gains[CENTER].gain.value; // constant src is 1.0 → offset.gain IS the constant
      for (const x of [-1, -0.5, 0, 0.5, 1]) {
        expect(slope * x + offset).toBeCloseTo(depolarize(x, depth), 12);
      }
    }
  });

  it('setParam then readParam round-trips, and live-updates the slope only', async () => {
    const { ctx, gains } = makeMockCtx();
    const handle = await depolarizerDef.factory(ctx as unknown as AudioContext, makeNode());
    handle.setParam('depth', 0.5);
    expect(handle.readParam('depth')).toBeCloseTo(0.5, 12);
    expect(gains[IN_SCALE].gain.value).toBeCloseTo(0.25, 12);
    // Center stays fixed at 0.5.
    expect(gains[CENTER].gain.value).toBeCloseTo(0.5, 12);
  });

  it('readParam on an unknown param id returns undefined', async () => {
    const { ctx } = makeMockCtx();
    const handle = await depolarizerDef.factory(ctx as unknown as AudioContext, makeNode());
    expect(handle.readParam('nope')).toBeUndefined();
  });

  it('dispose() stops the constant source and disconnects every node', async () => {
    const { ctx, gains, consts } = makeMockCtx();
    const handle = await depolarizerDef.factory(ctx as unknown as AudioContext, makeNode());
    handle.dispose();
    expect(consts[0].stop).toHaveBeenCalled();
    for (const g of gains) expect(g.disconnect).toHaveBeenCalled();
  });
});
