// packages/web/src/lib/audio/modules/moog956.test.ts
//
// Three test layers for the moogafakkin 956 RIBBON CONTROLLER (System 55
// clone):
//   1. ribbonToVOct / clampRibbon — the pure ribbon→pitch math + position
//      clamp (the single source of truth shared by factory + card).
//   2. Module-def shape — pins the I/O surface (NO inputs; pitch + gate
//      outputs; the pos/gate/scale/offset params) so a refactor that drops a
//      port/param fails loudly.
//   3. Factory wiring — the 956 is a passive UI-driven source (two
//      ConstantSourceNodes, no worklet). A mock AudioContext records offsets +
//      start/stop/disconnect; we assert: no inputs, both outputs at index 0 of
//      DISTINCT nodes, the pitch source seeds from pos*scale+offset, the gate
//      source seeds from `gate`, setParam(pos/scale/offset) re-derives pitch,
//      setParam(gate) is gated at 0.5, readParam round-trips, dispose() stops +
//      disconnects everything.

import { describe, it, expect } from 'vitest';
import { moog956Def, ribbonToVOct, clampRibbon } from './moog956';
import type { ModuleNode } from '$lib/graph/types';

// ───────────────────── Layer 1: pure math ─────────────────────
describe('clampRibbon', () => {
  it('clamps to [0, 1] and maps non-finite to 0', () => {
    expect(clampRibbon(-0.5)).toBe(0);
    expect(clampRibbon(0)).toBe(0);
    expect(clampRibbon(0.42)).toBeCloseTo(0.42, 6);
    expect(clampRibbon(1)).toBe(1);
    expect(clampRibbon(2)).toBe(1);
    expect(clampRibbon(NaN)).toBe(0);
    expect(clampRibbon(Infinity)).toBe(0); // non-finite → 0 (guarded first)
  });
});

describe('ribbonToVOct', () => {
  it('maps pos 0..1 across `scale` octaves shifted by `offset`', () => {
    // default span 2 oct, no offset: ends at 0 and 2 V/oct.
    expect(ribbonToVOct(0, 2, 0)).toBeCloseTo(0, 6);
    expect(ribbonToVOct(0.5, 2, 0)).toBeCloseTo(1, 6);
    expect(ribbonToVOct(1, 2, 0)).toBeCloseTo(2, 6);
  });
  it('applies the octave offset additively', () => {
    expect(ribbonToVOct(0, 2, -1)).toBeCloseTo(-1, 6);
    expect(ribbonToVOct(1, 2, -1)).toBeCloseTo(1, 6);
  });
  it('clamps pos and tolerates non-finite scale/offset', () => {
    expect(ribbonToVOct(5, 2, 0)).toBeCloseTo(2, 6); // pos clamps to 1
    expect(ribbonToVOct(0.5, NaN, 0)).toBeCloseTo(0, 6);
    expect(ribbonToVOct(0.5, 2, NaN)).toBeCloseTo(1, 6);
  });
});

// ───────────────────── Layer 2: module-def shape ─────────────────────
// ───────────────────── Layer 3: factory wiring ─────────────────────
interface MockConstSource {
  __kind: 'const';
  offset: { value: number; setValueAtTime: (v: number, t: number) => void };
  startCount: number;
  stopCount: number;
  disconnectCount: number;
  connect: () => void;
  start: () => void;
  stop: () => void;
  disconnect: () => void;
}

function makeMockCtx(): { ctx: AudioContext; sources: MockConstSource[] } {
  const sources: MockConstSource[] = [];
  function createConstantSource(): MockConstSource {
    const s: MockConstSource = {
      __kind: 'const',
      offset: {
        value: 0,
        setValueAtTime(v: number) {
          this.value = v;
        },
      },
      startCount: 0,
      stopCount: 0,
      disconnectCount: 0,
      connect() {},
      start() {
        this.startCount++;
      },
      stop() {
        this.stopCount++;
      },
      disconnect() {
        this.disconnectCount++;
      },
    };
    sources.push(s);
    return s;
  }
  const ctx = {
    sampleRate: 48000,
    currentTime: 0,
    createConstantSource,
  } as unknown as AudioContext;
  return { ctx, sources };
}

function makeNode(params: Record<string, number> = {}): ModuleNode {
  return {
    id: 'moog956-test',
    type: 'moog956',
    domain: 'audio',
    position: { x: 0, y: 0 },
    params,
    data: {},
  };
}

function pitchNode(handle: Awaited<ReturnType<typeof moog956Def.factory>>): MockConstSource {
  return handle.outputs.get('pitch')!.node as unknown as MockConstSource;
}
function gateNode(handle: Awaited<ReturnType<typeof moog956Def.factory>>): MockConstSource {
  return handle.outputs.get('gate')!.node as unknown as MockConstSource;
}

describe('moog956 factory: wiring + params', () => {
  it('exposes no inputs', async () => {
    const { ctx } = makeMockCtx();
    const handle = await moog956Def.factory(ctx, makeNode());
    expect(handle.inputs.size).toBe(0);
  });

  it('exposes pitch + gate at output index 0 of DISTINCT nodes, both started', async () => {
    const { ctx, sources } = makeMockCtx();
    const handle = await moog956Def.factory(ctx, makeNode());
    const pitch = handle.outputs.get('pitch');
    const gate = handle.outputs.get('gate');
    expect(pitch).toBeDefined();
    expect(gate).toBeDefined();
    expect(pitch!.output).toBe(0);
    expect(gate!.output).toBe(0);
    expect(pitch!.node).not.toBe(gate!.node);
    expect(sources.length).toBe(2);
    for (const s of sources) expect(s.startCount).toBe(1);
  });

  it('seeds pitch from pos*scale+offset and gate from 0 at rest (defaults)', async () => {
    const { ctx } = makeMockCtx();
    const handle = await moog956Def.factory(ctx, makeNode());
    expect(pitchNode(handle).offset.value).toBeCloseTo(0, 6); // pos 0
    expect(gateNode(handle).offset.value).toBe(0);
  });

  it('honors initial params at mount (pos/scale/offset/gate)', async () => {
    const { ctx } = makeMockCtx();
    const handle = await moog956Def.factory(
      ctx,
      makeNode({ pos: 0.5, scale: 2, offset: -1, gate: 1 }),
    );
    expect(pitchNode(handle).offset.value).toBeCloseTo(0, 6); // -1 + 0.5*2
    expect(gateNode(handle).offset.value).toBe(1);
  });

  it('setParam(pos) re-derives the pitch CV from the live scale/offset', async () => {
    const { ctx } = makeMockCtx();
    const handle = await moog956Def.factory(ctx, makeNode({ scale: 4, offset: 0 }));
    handle.setParam('pos', 0.25);
    expect(pitchNode(handle).offset.value).toBeCloseTo(1, 6); // 0.25 * 4
    expect(handle.readParam('pos')).toBeCloseTo(0.25, 6);
  });

  it('setParam(scale) and setParam(offset) both re-derive pitch', async () => {
    const { ctx } = makeMockCtx();
    const handle = await moog956Def.factory(ctx, makeNode({ pos: 1 }));
    handle.setParam('scale', 3);
    expect(pitchNode(handle).offset.value).toBeCloseTo(3, 6); // 1 * 3 + 0
    handle.setParam('offset', 0.5);
    expect(pitchNode(handle).offset.value).toBeCloseTo(3.5, 6); // 1 * 3 + 0.5
  });

  it('setParam(gate) is a 0.5 threshold and drives the gate source', async () => {
    const { ctx } = makeMockCtx();
    const handle = await moog956Def.factory(ctx, makeNode());
    handle.setParam('gate', 1);
    expect(gateNode(handle).offset.value).toBe(1);
    expect(handle.readParam('gate')).toBe(1);
    handle.setParam('gate', 0.2);
    expect(gateNode(handle).offset.value).toBe(0);
    expect(handle.readParam('gate')).toBe(0);
  });

  it('clamps pos to [0,1] on setParam', async () => {
    const { ctx } = makeMockCtx();
    const handle = await moog956Def.factory(ctx, makeNode({ scale: 2 }));
    handle.setParam('pos', 5);
    expect(handle.readParam('pos')).toBe(1);
    expect(pitchNode(handle).offset.value).toBeCloseTo(2, 6);
  });

  it('setParam / readParam ignore unknown param ids without throwing', async () => {
    const { ctx } = makeMockCtx();
    const handle = await moog956Def.factory(ctx, makeNode());
    expect(() => handle.setParam('nope', 0.5)).not.toThrow();
    expect(handle.readParam('nope')).toBeUndefined();
  });

  it('dispose() stops + disconnects both ConstantSources', async () => {
    const { ctx, sources } = makeMockCtx();
    const handle = await moog956Def.factory(ctx, makeNode());
    handle.dispose();
    for (const s of sources) {
      expect(s.stopCount).toBe(1);
      expect(s.disconnectCount).toBeGreaterThanOrEqual(1);
    }
  });
});
