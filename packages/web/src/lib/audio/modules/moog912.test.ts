// packages/web/src/lib/audio/modules/moog912.test.ts
//
// Two test layers for the MOOG 912 ENVELOPE FOLLOWER (moogafakkin System 55/35 clone):
//   1. Module-def shape — pins the 912's I/O surface (single audio in, the env
//      (cv) + gate outputs, the sensitivity/smoothing param array) so a
//      refactor that silently drops a port / param fails loudly (the
//      per-module-per-port regression-net class of bug).
//   2. Factory wiring — the 912 is PASSIVE (pure Web Audio: input GainNode →
//      rectifier WaveShaper → lowpass BiquadFilter = env → gate WaveShaper),
//      so there's no worklet to instantiate. We drive the factory with a mock
//      AudioContext whose Gain/WaveShaper/Biquad nodes record their wiring +
//      values, then assert: the single audio in / env+gate outs are exposed and
//      point at the right node, the rectifier + gate curves are full-wave / step
//      shaped, the lowpass cutoff tracks the SMOOTHING log map, setParam→readParam
//      round-trips, and dispose() disconnects every node the factory made.
//
// The pure SMOOTHING→cutoff + curve-builder helpers are also asserted directly
// (no Web Audio needed) so the DSP mapping is verifiable in isolation.

import { describe, it, expect } from 'vitest';
import {
  moog912Def,
  smoothingToCutoffHz,
  buildRectifyCurve,
  buildGateCurve,
  SMOOTH_MIN_HZ,
  SMOOTH_MAX_HZ,
  GATE_THRESHOLD,
} from './moog912';
import type { ModuleNode } from '$lib/graph/types';

// ───────────────────── Layer 0: pure DSP helpers ─────────────────────
describe('moog912 DSP helpers', () => {
  it('smoothingToCutoffHz: max smoothing (1.0) → SLOWEST (min Hz), no smoothing (0.0) → FASTEST (max Hz)', () => {
    expect(smoothingToCutoffHz(1)).toBeCloseTo(SMOOTH_MIN_HZ, 6);
    expect(smoothingToCutoffHz(0)).toBeCloseTo(SMOOTH_MAX_HZ, 6);
  });

  it('smoothingToCutoffHz: monotonically DECREASING in smoothing (more smoothing => lower cutoff)', () => {
    const a = smoothingToCutoffHz(0.25);
    const b = smoothingToCutoffHz(0.5);
    const c = smoothingToCutoffHz(0.75);
    expect(a).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(c);
  });

  it('smoothingToCutoffHz: clamps out-of-range inputs into [min,max]', () => {
    expect(smoothingToCutoffHz(2)).toBeCloseTo(SMOOTH_MIN_HZ, 6);
    expect(smoothingToCutoffHz(-1)).toBeCloseTo(SMOOTH_MAX_HZ, 6);
  });

  it('buildRectifyCurve: maps the [-1,1] domain through |x| (full-wave rectify)', () => {
    const c = buildRectifyCurve();
    // First sample = |-1| = 1, mid ≈ |0| = 0, last = |1| = 1.
    expect(c[0]).toBeCloseTo(1, 6);
    expect(c[c.length - 1]).toBeCloseTo(1, 6);
    const mid = c[Math.floor(c.length / 2)]!;
    expect(mid).toBeLessThan(0.01);
    // Every entry is non-negative (it's a magnitude).
    for (const v of c) expect(v).toBeGreaterThanOrEqual(0);
  });

  it('buildGateCurve: ~0 below the threshold, ~1 at/above it', () => {
    const c = buildGateCurve();
    const len = c.length;
    const idxOf = (x: number) => Math.round(((x + 1) / 2) * (len - 1));
    // Just below threshold → 0, just above → 1.
    expect(c[idxOf(GATE_THRESHOLD - 0.05)]).toBe(0);
    expect(c[idxOf(GATE_THRESHOLD + 0.05)]).toBe(1);
    expect(c[idxOf(0.9)]).toBe(1);
    // Negative inputs (never produced by the rectified env) map to 0.
    expect(c[idxOf(-0.5)]).toBe(0);
  });
});

// ───────────────────── Layer 1: module-def shape ─────────────────────
describe('moog912Def: module def shape', () => {
  it('declares type=moog912, label="912 Envelope Follower", category=modulation, schemaVersion=1', () => {
    expect(moog912Def.type).toBe('moog912');
    expect(moog912Def.label).toBe('912 Envelope Follower');
    expect(moog912Def.category).toBe('modulation');
    expect(moog912Def.schemaVersion).toBe(1);
  });

  it('lives in the Clones → moogafakkin palette bucket and uses the Moog912Card', () => {
    expect(moog912Def.palette).toEqual({ top: 'Clones', sub: 'moogafakkin' });
    expect(moog912Def.card).toBe('Moog912Card');
    expect(moog912Def.domain).toBe('audio');
  });

  it('exposes a single audio input: audio (audio, PASSTHROUGH — no CV scale/target)', () => {
    const ids = moog912Def.inputs.map((p) => p.id);
    expect(ids).toEqual(['audio']);
    expect(moog912Def.inputs[0].type).toBe('audio');
    for (const p of moog912Def.inputs) {
      expect(p.cvScale).toBeUndefined();
      expect(p.paramTarget).toBeUndefined();
    }
  });

  it('exposes env (cv) + gate (gate) outputs', () => {
    const ids = moog912Def.outputs.map((p) => p.id);
    expect(ids).toEqual(['env', 'gate']);
    expect(moog912Def.outputs.find((o) => o.id === 'env')!.type).toBe('cv');
    expect(moog912Def.outputs.find((o) => o.id === 'gate')!.type).toBe('gate');
  });

  it('exposes 2 params (sensitivity default 0.7, smoothing default 0.5), both linear 0..1', () => {
    const ids = moog912Def.params.map((p) => p.id);
    expect(ids).toEqual(['sensitivity', 'smoothing']);
    for (const p of moog912Def.params) {
      expect(p.min).toBe(0);
      expect(p.max).toBe(1);
      expect(p.curve).toBe('linear');
      expect(p.label).toBeTruthy();
    }
    expect(moog912Def.params.find((p) => p.id === 'sensitivity')!.defaultValue).toBe(0.7);
    expect(moog912Def.params.find((p) => p.id === 'smoothing')!.defaultValue).toBe(0.5);
  });

  it('output port ids match the handle Map keys exactly (no drift)', async () => {
    const { ctx } = makeMockCtx();
    const handle = await moog912Def.factory(ctx, makeNode());
    const defOutIds = moog912Def.outputs.map((o) => o.id).sort();
    const handleOutIds = [...handle.outputs.keys()].sort();
    expect(handleOutIds).toEqual(defOutIds);
    const defInIds = moog912Def.inputs.map((i) => i.id).sort();
    const handleInIds = [...handle.inputs.keys()].sort();
    expect(handleInIds).toEqual(defInIds);
  });
});

// ───────────────────── Layer 2: factory wiring ─────────────────────
//
// Minimal Web Audio mock. GainNodes track gain.value; WaveShaperNodes track
// their curve; BiquadFilterNodes track type/frequency/Q. Every node records the
// nodes it connects to so we can assert the in→rectify→lowpass→gate topology.
interface MockNode {
  kind: 'gain' | 'waveshaper' | 'biquad';
  gain?: { value: number; setValueAtTime: (v: number, t: number) => void };
  curve?: Float32Array | null;
  oversample?: string;
  type?: BiquadFilterType;
  frequency?: { value: number; setValueAtTime: (v: number, t: number) => void };
  Q?: { value: number };
  connectedTo: MockNode[];
  connect: (dest: MockNode) => void;
  disconnect: () => void;
  disconnectCount: number;
}

function makeMockCtx(): { ctx: AudioContext; nodes: MockNode[] } {
  const nodes: MockNode[] = [];
  function base(kind: MockNode['kind']): MockNode {
    const n: MockNode = {
      kind,
      connectedTo: [],
      disconnectCount: 0,
      connect(dest: MockNode) {
        this.connectedTo.push(dest);
      },
      disconnect() {
        this.disconnectCount++;
      },
    };
    nodes.push(n);
    return n;
  }
  function createGain(): MockNode {
    const n = base('gain');
    n.gain = {
      value: 1,
      setValueAtTime(v: number) {
        n.gain!.value = v;
      },
    };
    return n;
  }
  function createWaveShaper(): MockNode {
    const n = base('waveshaper');
    n.curve = null;
    n.oversample = 'none';
    return n;
  }
  function createBiquadFilter(): MockNode {
    const n = base('biquad');
    n.type = 'lowpass';
    n.frequency = {
      value: 350,
      setValueAtTime(v: number) {
        n.frequency!.value = v;
      },
    };
    n.Q = { value: 1 };
    return n;
  }
  const ctx = {
    createGain,
    createWaveShaper,
    createBiquadFilter,
    currentTime: 0,
  } as unknown as AudioContext;
  return { ctx, nodes };
}

function makeNode(params: Record<string, number> = {}): ModuleNode {
  return {
    id: 'moog912-test',
    type: 'moog912',
    domain: 'audio',
    position: { x: 0, y: 0 },
    params,
    data: {},
  };
}

describe('moog912 factory: wiring + params', () => {
  it('exposes the single audio input at input index 0 of the input-gain node', async () => {
    const { ctx } = makeMockCtx();
    const handle = await moog912Def.factory(ctx, makeNode());
    const entry = handle.inputs.get('audio');
    expect(entry).toBeDefined();
    expect(entry!.input).toBe(0);
    expect((entry!.node as unknown as MockNode).kind).toBe('gain');
  });

  it('exposes env at output 0 of the lowpass biquad, gate at output 0 of a waveshaper', async () => {
    const { ctx } = makeMockCtx();
    const handle = await moog912Def.factory(ctx, makeNode());
    const env = handle.outputs.get('env');
    const gate = handle.outputs.get('gate');
    expect(env).toBeDefined();
    expect(env!.output).toBe(0);
    expect((env!.node as unknown as MockNode).kind).toBe('biquad');
    expect((env!.node as unknown as MockNode).type).toBe('lowpass');
    expect(gate).toBeDefined();
    expect(gate!.output).toBe(0);
    expect((gate!.node as unknown as MockNode).kind).toBe('waveshaper');
  });

  it('wires input → rectifier(waveshaper) → lowpass(biquad) → gate(waveshaper)', async () => {
    const { ctx, nodes } = makeMockCtx();
    const handle = await moog912Def.factory(ctx, makeNode());
    const input = handle.inputs.get('audio')!.node as unknown as MockNode;
    const envFilter = handle.outputs.get('env')!.node as unknown as MockNode;
    const gateShaper = handle.outputs.get('gate')!.node as unknown as MockNode;

    // input → a waveshaper (the rectifier)
    expect(input.connectedTo.length).toBe(1);
    const rectifier = input.connectedTo[0]!;
    expect(rectifier.kind).toBe('waveshaper');
    expect(rectifier).not.toBe(gateShaper);

    // rectifier → the lowpass biquad (= env)
    expect(rectifier.connectedTo).toContain(envFilter);

    // env filter → the gate waveshaper
    expect(envFilter.connectedTo).toContain(gateShaper);

    // Exactly two waveshapers (rectifier + gate), one biquad, one input gain.
    expect(nodes.filter((n) => n.kind === 'waveshaper').length).toBe(2);
    expect(nodes.filter((n) => n.kind === 'biquad').length).toBe(1);
    expect(nodes.filter((n) => n.kind === 'gain').length).toBe(1);
  });

  it('rectifier curve is full-wave |x| (>=0 everywhere); gate curve is a step', async () => {
    const { ctx } = makeMockCtx();
    const handle = await moog912Def.factory(ctx, makeNode());
    const input = handle.inputs.get('audio')!.node as unknown as MockNode;
    const rectifier = input.connectedTo[0]!;
    const gateShaper = handle.outputs.get('gate')!.node as unknown as MockNode;

    expect(rectifier.curve).toBeInstanceOf(Float32Array);
    for (const v of rectifier.curve!) expect(v).toBeGreaterThanOrEqual(0);

    expect(gateShaper.curve).toBeInstanceOf(Float32Array);
    // The gate curve only ever holds 0 or 1.
    for (const v of gateShaper.curve!) expect(v === 0 || v === 1).toBe(true);
  });

  it('defaults: input gain = 0.7 (sensitivity), cutoff = smoothingToCutoffHz(0.5)', async () => {
    const { ctx } = makeMockCtx();
    const handle = await moog912Def.factory(ctx, makeNode());
    const input = handle.inputs.get('audio')!.node as unknown as MockNode;
    const envFilter = handle.outputs.get('env')!.node as unknown as MockNode;
    expect(input.gain!.value).toBeCloseTo(0.7, 6);
    expect(envFilter.frequency!.value).toBeCloseTo(smoothingToCutoffHz(0.5), 4);
  });

  it('honors initial node.params at mount (sensitivity → gain, smoothing → cutoff)', async () => {
    const { ctx } = makeMockCtx();
    const handle = await moog912Def.factory(ctx, makeNode({ sensitivity: 0.3, smoothing: 0.9 }));
    const input = handle.inputs.get('audio')!.node as unknown as MockNode;
    const envFilter = handle.outputs.get('env')!.node as unknown as MockNode;
    expect(input.gain!.value).toBeCloseTo(0.3, 6);
    expect(envFilter.frequency!.value).toBeCloseTo(smoothingToCutoffHz(0.9), 4);
  });

  it('readParam reports defaults (sensitivity 0.7, smoothing 0.5)', async () => {
    const { ctx } = makeMockCtx();
    const handle = await moog912Def.factory(ctx, makeNode());
    expect(handle.readParam('sensitivity')).toBeCloseTo(0.7, 6);
    expect(handle.readParam('smoothing')).toBeCloseTo(0.5, 4);
  });

  it('setParam then readParam round-trips for both params', async () => {
    const { ctx } = makeMockCtx();
    const handle = await moog912Def.factory(ctx, makeNode());
    handle.setParam('sensitivity', 0.42);
    handle.setParam('smoothing', 0.2);
    expect(handle.readParam('sensitivity')).toBeCloseTo(0.42, 6);
    expect(handle.readParam('smoothing')).toBeCloseTo(0.2, 4);
  });

  it('setParam(smoothing) updates the live lowpass cutoff via the log map', async () => {
    const { ctx } = makeMockCtx();
    const handle = await moog912Def.factory(ctx, makeNode());
    const envFilter = handle.outputs.get('env')!.node as unknown as MockNode;
    handle.setParam('smoothing', 1.0); // most smoothing → slowest cutoff
    expect(envFilter.frequency!.value).toBeCloseTo(SMOOTH_MIN_HZ, 4);
    handle.setParam('smoothing', 0.0); // no smoothing → fastest cutoff
    expect(envFilter.frequency!.value).toBeCloseTo(SMOOTH_MAX_HZ, 4);
  });

  it('setParam ignores unknown param ids without throwing', async () => {
    const { ctx } = makeMockCtx();
    const handle = await moog912Def.factory(ctx, makeNode());
    expect(() => handle.setParam('nope', 0.5)).not.toThrow();
    expect(handle.readParam('nope')).toBeUndefined();
  });

  it('dispose() disconnects every node the factory created (gain + 2 shapers + biquad)', async () => {
    const { ctx, nodes } = makeMockCtx();
    const handle = await moog912Def.factory(ctx, makeNode());
    // 1 input gain + 2 waveshapers + 1 biquad.
    expect(nodes.length).toBe(4);
    handle.dispose();
    for (const n of nodes) {
      expect(n.disconnectCount).toBeGreaterThanOrEqual(1);
    }
  });
});
