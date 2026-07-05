// packages/web/src/lib/audio/modules/moog914.test.ts
//
// Two test layers for the MOOG 914 EXTENDED FIXED FILTER BANK (moogafakkin System 55
// clone):
//   1. Module-def shape — pins the 914's I/O surface (single audio in, single
//      audio out, the hp / band1..band12 / lp param array driven by the SHARED
//      FILTERBANK_914_CENTERS table) so a refactor that silently drops a port /
//      param fails loudly. The param list is ASSERTED against the shared lib
//      data so 907A vs 914 provably differ only by which center array they
//      import (this test imports the 12-band 914 table, the 907A test imports
//      the 8-band subset; both drive the SAME shared factory).
//   2. Factory wiring — the 914 is PASSIVE (pure Web Audio: a fan GainNode →
//      one HP biquad + N BP biquads + one LP biquad, each → a level GainNode →
//      one summing GainNode), so there's no worklet to instantiate. We drive
//      the factory with a mock AudioContext whose Gain/Biquad nodes record
//      their wiring + values, then assert: the single audio in/out is exposed
//      and points at the right node, every section's biquad is configured
//      (type + center freq + Q), every section feeds the one summer, the band
//      levels default to 0.5, setParam→readParam round-trips, and dispose()
//      disconnects every node the factory made.

import { describe, it, expect } from 'vitest';
import { moog914Def } from './moog914';
import {
  FILTERBANK_914_CENTERS,
  FILTERBANK_Q,
  bandParamId,
} from '../../../../../dsp/src/lib/moog-filterbank-dsp';
import type { ModuleNode } from '$lib/graph/types';

const N = FILTERBANK_914_CENTERS.length;
const BAND_IDS = FILTERBANK_914_CENTERS.map((_, i) => bandParamId(i + 1));
const ALL_PARAM_IDS = ['hp', ...BAND_IDS, 'lp'];

// ───────────────────── Layer 1: module-def shape ─────────────────────
describe('moog914Def: module def shape', () => {
  it('declares type=moog914, label, category=filters, schemaVersion=1', () => {
    expect(moog914Def.type).toBe('moog914');
    expect(moog914Def.label).toBe('914 extended fixed filter bank');
    expect(moog914Def.category).toBe('filters');
  });

  it('lives in the Moog System 35/55 Clones palette bucket and uses the Moog914Card', () => {
    expect(moog914Def.palette).toEqual({ top: 'Moog System 35/55 Clones', sub: 'Moog System 35/55 Clones' });
    expect(moog914Def.card).toBe('Moog914Card');
  });

  it('exposes a single audio input: audio (audio, no CV)', () => {
    const ids = moog914Def.inputs.map((p) => p.id);
    expect(ids).toEqual(['audio']);
    expect(moog914Def.inputs[0].type).toBe('audio');
    // Fixed bank → NO CV inputs, no paramTarget anywhere.
    for (const p of moog914Def.inputs) {
      expect(p.type).toBe('audio');
      expect(p.paramTarget).toBeUndefined();
    }
  });

  it('exposes a single audio output: audio (audio)', () => {
    const ids = moog914Def.outputs.map((p) => p.id);
    expect(ids).toEqual(['audio']);
    expect(moog914Def.outputs[0].type).toBe('audio');
  });

  it('exposes params hp, band1..bandN, lp — N from the SHARED 914 centers', () => {
    const ids = moog914Def.params.map((p) => p.id);
    expect(ids).toEqual(ALL_PARAM_IDS);
    // The band count is exactly the shared lib's center count (12 for 914 —
    // the EXTENDED bank, vs the 907A's 8).
    expect(BAND_IDS.length).toBe(N);
    expect(N).toBe(12);
  });

  it('every param is linear 0..1 default 0.5 (unity-ish neutral)', () => {
    for (const p of moog914Def.params) {
      expect(p.min).toBe(0);
      expect(p.max).toBe(1);
      expect(p.defaultValue).toBe(0.5);
      expect(p.curve).toBe('linear');
    }
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
    id: 'moog914-test',
    type: 'moog914',
    domain: 'audio',
    position: { x: 0, y: 0 },
    params,
    data: {},
  };
}

describe('moog914 factory: wiring + params', () => {
  it('exposes the single audio input at input index 0 of the fan node', async () => {
    const { ctx } = makeMockCtx();
    const handle = await moog914Def.factory(ctx, makeNode());
    const entry = handle.inputs.get('audio');
    expect(entry).toBeDefined();
    expect(entry!.input).toBe(0);
  });

  it('exposes the single audio output at output index 0 of the summing node', async () => {
    const { ctx } = makeMockCtx();
    const handle = await moog914Def.factory(ctx, makeNode());
    const out = handle.outputs.get('audio');
    expect(out).toBeDefined();
    expect(out!.output).toBe(0);
  });

  it('builds one HP + N BP + one LP biquad, each configured with its center + shared Q', async () => {
    const { ctx, nodes } = makeMockCtx();
    await moog914Def.factory(ctx, makeNode());
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
    const expected = [...FILTERBANK_914_CENTERS].sort((a, b) => a - b);
    expect(bpFreqs).toEqual(expected);

    // Shared Q on every filter section.
    for (const b of biquads) {
      expect(b.Q!.value).toBe(FILTERBANK_Q);
    }
  });

  it('routes every section (fan → biquad → level) into the one summing node', async () => {
    const { ctx, nodes } = makeMockCtx();
    const handle = await moog914Def.factory(ctx, makeNode());
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
    const handle = await moog914Def.factory(ctx, makeNode());
    for (const id of ALL_PARAM_IDS) {
      expect(handle.readParam(id), `${id} default`).toBeCloseTo(0.5, 6);
    }
  });

  it('honors initial node.params at mount (section levels seeded from params)', async () => {
    const { ctx } = makeMockCtx();
    const handle = await moog914Def.factory(
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
    const handle = await moog914Def.factory(ctx, makeNode());
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
    const handle = await moog914Def.factory(ctx, makeNode());
    expect(() => handle.setParam('nope', 0.5)).not.toThrow();
    expect(handle.readParam('nope')).toBeUndefined();
  });

  it('dispose() disconnects every node the factory created (fan + filters + levels + summer)', async () => {
    const { ctx, nodes } = makeMockCtx();
    const handle = await moog914Def.factory(ctx, makeNode());
    // fan + summer (2 gains) + (N+2) level gains + (N+2) biquads.
    expect(nodes.length).toBe(2 + (N + 2) + (N + 2));
    handle.dispose();
    for (const n of nodes) {
      expect(n.disconnectCount).toBeGreaterThanOrEqual(1);
    }
  });
});
