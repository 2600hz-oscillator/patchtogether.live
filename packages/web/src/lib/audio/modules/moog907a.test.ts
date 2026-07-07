// packages/web/src/lib/audio/modules/moog907a.test.ts
//
// Two test layers for the MOOG 907A FIXED FILTER BANK (moogafakkin System 35 clone):
//   1. Module-def shape — pins the 907A's I/O surface (single audio in, single
//      audio out, the hp / band1..band8 / lp param array driven by the SHARED
//      FILTERBANK_907A_CENTERS table) so a refactor that silently drops a port
//      / param fails loudly (the per-module-per-port regression-net class of
//      bug). The param list is ASSERTED against the shared lib data so 907A vs
//      914 provably differ only by which center array they import.
//   2. Factory wiring — the 907A is PASSIVE (pure Web Audio: a fan GainNode →
//      one HP biquad + N BP biquads + one LP biquad, each → a level GainNode →
//      one summing GainNode), so there's no worklet to instantiate. We drive
//      the factory with a mock AudioContext whose Gain/Biquad nodes record
//      their wiring + values, then assert: the single audio in/out is exposed
//      and points at the right node, every section's biquad is configured
//      (type + center freq + Q), every section feeds the one summer, the band
//      levels default to 0.5, setParam→readParam round-trips, and dispose()
//      disconnects every node the factory made.

import { describe, it, expect } from 'vitest';
import { moog907aDef } from './moog907a';
import {
  FILTERBANK_907A_CENTERS,
  FILTERBANK_Q,
  bandParamId,
} from '../../../../../dsp/src/lib/moog-filterbank-dsp';
import type { ModuleNode } from '$lib/graph/types';

const N = FILTERBANK_907A_CENTERS.length;
const BAND_IDS = FILTERBANK_907A_CENTERS.map((_, i) => bandParamId(i + 1));
const ALL_PARAM_IDS = ['hp', ...BAND_IDS, 'lp'];

// ───────────────────── Layer 1: module-def shape ─────────────────────
describe('moog907aDef: module def shape', () => {
  it('exposes params hp, band1..bandN, lp — N from the SHARED 907A centers', () => {
    const ids = moog907aDef.params.map((p) => p.id);
    expect(ids).toEqual(ALL_PARAM_IDS);
    // The band count is exactly the shared lib's center count (8 for 907A).
    expect(BAND_IDS.length).toBe(N);
    expect(N).toBe(8);
  });

});

// ───────────────────── Layer 2: factory wiring ─────────────────────
//
// Minimal Web Audio mock. GainNodes track gain.value + the nodes they connect
// to; BiquadFilterNodes track type/frequency/Q + connections — so we can
// assert the fan→filters→summer topology + each section's configuration.
interface MockNode {
  kind: 'gain' | 'biquad';
  gain?: { value: number; setValueAtTime: (v: number, t: number) => void };
  type?: BiquadFilterType;
  frequency?: { value: number };
  Q?: { value: number };
  connectedTo: MockNode[];
  connect: (dest: MockNode) => void;
  disconnect: () => void;
  disconnectCount: number;
}

function makeMockCtx(): { ctx: AudioContext; nodes: MockNode[] } {
  const nodes: MockNode[] = [];
  function base(kind: 'gain' | 'biquad'): MockNode {
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
  function createBiquadFilter(): MockNode {
    const n = base('biquad');
    n.type = 'lowpass';
    n.frequency = { value: 350 };
    n.Q = { value: 1 };
    return n;
  }
  const ctx = {
    createGain,
    createBiquadFilter,
    currentTime: 0,
  } as unknown as AudioContext;
  return { ctx, nodes };
}

function makeNode(params: Record<string, number> = {}): ModuleNode {
  return {
    id: 'moog907a-test',
    type: 'moog907a',
    domain: 'audio',
    position: { x: 0, y: 0 },
    params,
    data: {},
  };
}

describe('moog907a factory: wiring + params', () => {
  it('exposes the single audio input at input index 0 of the fan node', async () => {
    const { ctx } = makeMockCtx();
    const handle = await moog907aDef.factory(ctx, makeNode());
    const entry = handle.inputs.get('audio');
    expect(entry).toBeDefined();
    expect(entry!.input).toBe(0);
  });

  it('exposes the single audio output at output index 0 of the summing node', async () => {
    const { ctx } = makeMockCtx();
    const handle = await moog907aDef.factory(ctx, makeNode());
    const out = handle.outputs.get('audio');
    expect(out).toBeDefined();
    expect(out!.output).toBe(0);
  });

  it('builds one HP + N BP + one LP biquad, each configured with its center + shared Q', async () => {
    const { ctx, nodes } = makeMockCtx();
    await moog907aDef.factory(ctx, makeNode());
    const biquads = nodes.filter((n) => n.kind === 'biquad') as MockNode[];
    // 1 HP + N bandpass + 1 LP.
    expect(biquads.length).toBe(N + 2);

    const hp = biquads.find((b) => b.type === 'highpass');
    const lp = biquads.find((b) => b.type === 'lowpass');
    const bps = biquads.filter((b) => b.type === 'bandpass');
    expect(hp).toBeDefined();
    expect(lp).toBeDefined();
    expect(bps.length).toBe(N);

    // Every bandpass center matches the shared lib table (order-independent).
    const bpFreqs = bps.map((b) => b.frequency!.value).sort((a, b) => a - b);
    const expected = [...FILTERBANK_907A_CENTERS].sort((a, b) => a - b);
    expect(bpFreqs).toEqual(expected);

    // Shared Q on every filter section.
    for (const b of biquads) {
      expect(b.Q!.value).toBe(FILTERBANK_Q);
    }
  });

  it('routes every section (fan → biquad → level) into the one summing node', async () => {
    const { ctx, nodes } = makeMockCtx();
    const handle = await moog907aDef.factory(ctx, makeNode());
    const fan = handle.inputs.get('audio')!.node as unknown as MockNode;
    const summer = handle.outputs.get('audio')!.node as unknown as MockNode;

    const biquads = nodes.filter((n) => n.kind === 'biquad') as MockNode[];
    // The fan connects to every biquad section (HP + N BP + LP).
    expect(fan.connectedTo.length).toBe(N + 2);
    for (const b of biquads) {
      expect(fan.connectedTo, 'fan → biquad').toContain(b);
      // Each biquad connects to exactly one level gain…
      expect(b.connectedTo.length).toBe(1);
      const level = b.connectedTo[0]!;
      expect(level.kind).toBe('gain');
      // …which connects into the summer.
      expect(level.connectedTo, 'level → summer').toContain(summer);
    }
  });

  it('defaults every band level to 0.5 (unity-ish neutral)', async () => {
    const { ctx } = makeMockCtx();
    const handle = await moog907aDef.factory(ctx, makeNode());
    for (const id of ALL_PARAM_IDS) {
      expect(handle.readParam(id), `${id} default`).toBeCloseTo(0.5, 6);
    }
  });

  it('honors initial node.params at mount (section levels seeded from params)', async () => {
    const { ctx } = makeMockCtx();
    const handle = await moog907aDef.factory(
      ctx,
      makeNode({ hp: 0.1, band1: 0.9, lp: 0.2 }),
    );
    expect(handle.readParam('hp')).toBeCloseTo(0.1, 6);
    expect(handle.readParam('band1')).toBeCloseTo(0.9, 6);
    expect(handle.readParam('lp')).toBeCloseTo(0.2, 6);
    // Untouched bands keep their default.
    expect(handle.readParam('band2')).toBeCloseTo(0.5, 6);
  });

  it('setParam then readParam round-trips for every section', async () => {
    const { ctx } = makeMockCtx();
    const handle = await moog907aDef.factory(ctx, makeNode());
    handle.setParam('hp', 0.0);
    handle.setParam('band1', 0.33);
    handle.setParam(bandParamId(N), 0.77);
    handle.setParam('lp', 1.0);
    expect(handle.readParam('hp')).toBeCloseTo(0.0, 6);
    expect(handle.readParam('band1')).toBeCloseTo(0.33, 6);
    expect(handle.readParam(bandParamId(N))).toBeCloseTo(0.77, 6);
    expect(handle.readParam('lp')).toBeCloseTo(1.0, 6);
  });

  it('setParam ignores unknown param ids without throwing', async () => {
    const { ctx } = makeMockCtx();
    const handle = await moog907aDef.factory(ctx, makeNode());
    expect(() => handle.setParam('nope', 0.5)).not.toThrow();
    expect(handle.readParam('nope')).toBeUndefined();
  });

  it('dispose() disconnects every node the factory created (fan + filters + levels + summer)', async () => {
    const { ctx, nodes } = makeMockCtx();
    const handle = await moog907aDef.factory(ctx, makeNode());
    // fan + summer (2 gains) + (N+2) level gains + (N+2) biquads.
    expect(nodes.length).toBe(2 + (N + 2) + (N + 2));
    handle.dispose();
    for (const n of nodes) {
      expect(n.disconnectCount).toBeGreaterThanOrEqual(1);
    }
  });
});
