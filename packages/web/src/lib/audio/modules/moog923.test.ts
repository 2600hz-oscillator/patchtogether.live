// packages/web/src/lib/audio/modules/moog923.test.ts
//
// Two test layers for the MOOG 923 FILTERS / NOISE SOURCE (Moog System 35
// clone):
//   1. Module-def shape — pins the 923's I/O surface (single audio input;
//      white/pink/lp/hp outputs; the literal level/lpCutoff/hpCutoff param
//      array) so a refactor that silently drops a port / param fails loudly
//      (the per-module-per-port regression-net class of bug).
//   2. Factory wiring — the 923 is PURE Web Audio (looping noise buffers +
//      a small Biquad graph), no worklet. We drive the factory with a mock
//      AudioContext whose nodes record gain.value / biquad type+frequency
//      and their connections, then assert: every declared input/output is
//      exposed and points at the right node, the noise gains seed from LEVEL,
//      the two biquads are typed lowpass/highpass with the log-mapped corner,
//      the audio input fans into BOTH filters, setParam→readParam round-trips
//      (cutoffs through the log map), and dispose() disconnects everything.

import { describe, it, expect } from 'vitest';
import { moog923Def, cutoffToHz, CUTOFF_MIN_HZ, CUTOFF_MAX_HZ } from './moog923';
import type { ModuleNode } from '$lib/graph/types';

// ───────────────────── Layer 1: module-def shape ─────────────────────
describe('moog923Def: module def shape', () => {
  it('declares type=moog923, label="923 Filters / Noise Source", category=filter, schemaVersion=1', () => {
    expect(moog923Def.type).toBe('moog923');
    expect(moog923Def.label).toBe('923 Filters / Noise Source');
    expect(moog923Def.category).toBe('filter');
    expect(moog923Def.schemaVersion).toBe(1);
  });

  it('lives in the Moog → SYS35 palette bucket and uses the Moog923Card', () => {
    expect(moog923Def.palette).toEqual({ top: 'Moog', sub: 'SYS35' });
    expect(moog923Def.card).toBe('Moog923Card');
  });

  it('exposes a single audio input: audio (PASSTHROUGH)', () => {
    const ids = moog923Def.inputs.map((p) => p.id);
    expect(ids).toEqual(['audio']);
    expect(moog923Def.inputs[0].type).toBe('audio');
    // The input is a signal being filtered, not a knob modulator.
    expect(moog923Def.inputs[0].cvScale).toBeUndefined();
    expect(moog923Def.inputs[0].paramTarget).toBeUndefined();
  });

  it('exposes four audio outputs: white, pink, lp, hp', () => {
    const ids = moog923Def.outputs.map((p) => p.id);
    expect(ids).toEqual(['white', 'pink', 'lp', 'hp']);
    for (const p of moog923Def.outputs) {
      expect(p.type).toBe('audio');
    }
  });

  it('exposes 3 params (level, lpCutoff, hpCutoff), all linear 0..1', () => {
    const ids = moog923Def.params.map((p) => p.id);
    expect(ids).toEqual(['level', 'lpCutoff', 'hpCutoff']);
    for (const p of moog923Def.params) {
      expect(p.min).toBe(0);
      expect(p.max).toBe(1);
      expect(p.curve).toBe('linear');
    }
    const byId = Object.fromEntries(moog923Def.params.map((p) => [p.id, p]));
    expect(byId.level.defaultValue).toBe(0.8);
    expect(byId.lpCutoff.defaultValue).toBe(0.5);
    expect(byId.hpCutoff.defaultValue).toBe(0.5);
  });
});

// ───────────────────── cutoff log map ─────────────────────
describe('cutoffToHz: log map 0..1 → ~40 Hz .. 20 kHz', () => {
  it('maps the endpoints to the band edges', () => {
    expect(cutoffToHz(0)).toBeCloseTo(CUTOFF_MIN_HZ, 3);
    expect(cutoffToHz(1)).toBeCloseTo(CUTOFF_MAX_HZ, 3);
  });
  it('is the geometric mean at the midpoint (log spacing)', () => {
    expect(cutoffToHz(0.5)).toBeCloseTo(Math.sqrt(CUTOFF_MIN_HZ * CUTOFF_MAX_HZ), 3);
  });
  it('clamps out-of-range inputs to the band', () => {
    expect(cutoffToHz(-1)).toBeCloseTo(CUTOFF_MIN_HZ, 3);
    expect(cutoffToHz(2)).toBeCloseTo(CUTOFF_MAX_HZ, 3);
  });
});

// ───────────────────── Layer 2: factory wiring ─────────────────────
//
// Minimal Web Audio mock. Records the topology + node params so we can assert
// the noise gains, the two typed biquads + their corner frequency, and the
// audio-input fan-out.
interface MockNode {
  kind: string;
  connectedTo: MockNode[];
  connect: (dest: MockNode) => void;
  disconnect: () => void;
  disconnectCount: number;
  // GainNode
  gain?: { value: number; setValueAtTime: (v: number) => void };
  // BiquadFilterNode
  type?: string;
  frequency?: { value: number; setValueAtTime: (v: number) => void };
  // AudioBufferSourceNode
  buffer?: unknown;
  loop?: boolean;
  start?: () => void;
  stop?: () => void;
  started?: boolean;
  stopped?: boolean;
}

function makeMockCtx(): { ctx: AudioContext; nodes: MockNode[] } {
  const nodes: MockNode[] = [];
  function base(kind: string): MockNode {
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
  function audioParam() {
    const p = { value: 0, setValueAtTime: (v: number) => { p.value = v; } };
    return p;
  }
  const ctx = {
    sampleRate: 48000,
    currentTime: 0,
    createGain() {
      const n = base('gain');
      n.gain = audioParam();
      n.gain.value = 1;
      return n;
    },
    createBiquadFilter() {
      const n = base('biquad');
      n.type = 'allpass';
      n.frequency = audioParam();
      n.frequency.value = 350;
      return n;
    },
    createBufferSource() {
      const n = base('bufferSource');
      n.loop = false;
      n.started = false;
      n.stopped = false;
      n.start = () => { n.started = true; };
      n.stop = () => { n.stopped = true; };
      return n;
    },
    createBuffer(_channels: number, length: number, _sr: number) {
      const data = new Float32Array(length);
      return { getChannelData: () => data } as unknown as AudioBuffer;
    },
  } as unknown as AudioContext;
  return { ctx, nodes };
}

function makeNode(params: Record<string, number> = {}): ModuleNode {
  return {
    id: 'moog923-test',
    type: 'moog923',
    domain: 'audio',
    position: { x: 0, y: 0 },
    params,
    data: {},
  };
}

describe('moog923 factory: wiring + params', () => {
  it('exposes the single audio input at input index 0', async () => {
    const { ctx } = makeMockCtx();
    const handle = await moog923Def.factory(ctx, makeNode());
    const entry = handle.inputs.get('audio');
    expect(entry).toBeDefined();
    expect(entry!.input).toBe(0);
  });

  it('exposes all four outputs (white, pink, lp, hp) at output index 0', async () => {
    const { ctx } = makeMockCtx();
    const handle = await moog923Def.factory(ctx, makeNode());
    for (const id of ['white', 'pink', 'lp', 'hp']) {
      const out = handle.outputs.get(id);
      expect(out, `output ${id}`).toBeDefined();
      expect(out!.output).toBe(0);
    }
    // The four outputs land on four DISTINCT nodes.
    const out = ['white', 'pink', 'lp', 'hp'].map((id) => handle.outputs.get(id)!.node);
    expect(new Set(out).size).toBe(4);
  });

  it('seeds both noise gains from the default LEVEL (0.8)', async () => {
    const { ctx } = makeMockCtx();
    const handle = await moog923Def.factory(ctx, makeNode());
    const white = handle.outputs.get('white')!.node as unknown as MockNode;
    const pink = handle.outputs.get('pink')!.node as unknown as MockNode;
    expect(white.gain!.value).toBeCloseTo(0.8, 6);
    expect(pink.gain!.value).toBeCloseTo(0.8, 6);
  });

  it('honors an initial LEVEL from node.params on both noise taps', async () => {
    const { ctx } = makeMockCtx();
    const handle = await moog923Def.factory(ctx, makeNode({ level: 0.3 }));
    expect((handle.outputs.get('white')!.node as unknown as MockNode).gain!.value).toBeCloseTo(0.3, 6);
    expect((handle.outputs.get('pink')!.node as unknown as MockNode).gain!.value).toBeCloseTo(0.3, 6);
  });

  it('types the LP output lowpass and the HP output highpass with the log-mapped corner', async () => {
    const { ctx } = makeMockCtx();
    const handle = await moog923Def.factory(ctx, makeNode());
    const lp = handle.outputs.get('lp')!.node as unknown as MockNode;
    const hp = handle.outputs.get('hp')!.node as unknown as MockNode;
    expect(lp.type).toBe('lowpass');
    expect(hp.type).toBe('highpass');
    // Default 0.5 maps to the geometric mean of the band.
    expect(lp.frequency!.value).toBeCloseTo(cutoffToHz(0.5), 3);
    expect(hp.frequency!.value).toBeCloseTo(cutoffToHz(0.5), 3);
  });

  it('honors initial lpCutoff/hpCutoff from node.params (log-mapped)', async () => {
    const { ctx } = makeMockCtx();
    const handle = await moog923Def.factory(ctx, makeNode({ lpCutoff: 0.2, hpCutoff: 0.9 }));
    const lp = handle.outputs.get('lp')!.node as unknown as MockNode;
    const hp = handle.outputs.get('hp')!.node as unknown as MockNode;
    expect(lp.frequency!.value).toBeCloseTo(cutoffToHz(0.2), 3);
    expect(hp.frequency!.value).toBeCloseTo(cutoffToHz(0.9), 3);
  });

  it('fans the single audio input into BOTH filters', async () => {
    const { ctx } = makeMockCtx();
    const handle = await moog923Def.factory(ctx, makeNode());
    const fan = handle.inputs.get('audio')!.node as unknown as MockNode;
    const lp = handle.outputs.get('lp')!.node as unknown as MockNode;
    const hp = handle.outputs.get('hp')!.node as unknown as MockNode;
    expect(fan.connectedTo).toContain(lp);
    expect(fan.connectedTo).toContain(hp);
  });

  it('starts both noise buffer sources (looping)', async () => {
    const { ctx, nodes } = makeMockCtx();
    await moog923Def.factory(ctx, makeNode());
    const sources = nodes.filter((n) => n.kind === 'bufferSource');
    expect(sources.length).toBe(2);
    for (const s of sources) {
      expect(s.loop).toBe(true);
      expect(s.started).toBe(true);
    }
  });

  it('setParam(level) updates both noise gains; readParam round-trips', async () => {
    const { ctx } = makeMockCtx();
    const handle = await moog923Def.factory(ctx, makeNode());
    handle.setParam('level', 0.42);
    expect((handle.outputs.get('white')!.node as unknown as MockNode).gain!.value).toBeCloseTo(0.42, 6);
    expect((handle.outputs.get('pink')!.node as unknown as MockNode).gain!.value).toBeCloseTo(0.42, 6);
    expect(handle.readParam('level')).toBeCloseTo(0.42, 6);
  });

  it('setParam(lpCutoff/hpCutoff) log-maps to biquad frequency; readParam inverts back', async () => {
    const { ctx } = makeMockCtx();
    const handle = await moog923Def.factory(ctx, makeNode());
    handle.setParam('lpCutoff', 0.7);
    handle.setParam('hpCutoff', 0.1);
    const lp = handle.outputs.get('lp')!.node as unknown as MockNode;
    const hp = handle.outputs.get('hp')!.node as unknown as MockNode;
    expect(lp.frequency!.value).toBeCloseTo(cutoffToHz(0.7), 3);
    expect(hp.frequency!.value).toBeCloseTo(cutoffToHz(0.1), 3);
    // readParam recovers the normalized knob value via the inverse map.
    expect(handle.readParam('lpCutoff')).toBeCloseTo(0.7, 4);
    expect(handle.readParam('hpCutoff')).toBeCloseTo(0.1, 4);
  });

  it('reads back defaults: level 0.8, cutoffs 0.5', async () => {
    const { ctx } = makeMockCtx();
    const handle = await moog923Def.factory(ctx, makeNode());
    expect(handle.readParam('level')).toBeCloseTo(0.8, 6);
    expect(handle.readParam('lpCutoff')).toBeCloseTo(0.5, 4);
    expect(handle.readParam('hpCutoff')).toBeCloseTo(0.5, 4);
  });

  it('setParam ignores unknown param ids without throwing; readParam returns undefined', async () => {
    const { ctx } = makeMockCtx();
    const handle = await moog923Def.factory(ctx, makeNode());
    expect(() => handle.setParam('nope', 0.5)).not.toThrow();
    expect(handle.readParam('nope')).toBeUndefined();
  });

  it('dispose() stops both sources and disconnects every node the factory created', async () => {
    const { ctx, nodes } = makeMockCtx();
    const handle = await moog923Def.factory(ctx, makeNode());
    // 2 buffer sources + 2 noise gains + 1 fan gain + 2 biquads = 7 nodes.
    expect(nodes.length).toBe(7);
    handle.dispose();
    for (const s of nodes.filter((n) => n.kind === 'bufferSource')) {
      expect(s.stopped).toBe(true);
    }
    for (const n of nodes) {
      expect(n.disconnectCount, `${n.kind} disconnected`).toBeGreaterThanOrEqual(1);
    }
  });
});
