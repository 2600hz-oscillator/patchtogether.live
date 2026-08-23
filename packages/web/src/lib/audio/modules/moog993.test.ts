// packages/web/src/lib/audio/modules/moog993.test.ts
//
// Two test layers for the MOOG 993 TRIGGER & ENVELOPE VOLTAGES PANEL:
//   1. Module-def shape — pins the 993's I/O surface (the two trigger SOURCE
//      inputs + two envelope-CV inputs; the three routed trigger outs + two
//      envelope passthroughs; the literal param array) so a refactor that
//      silently drops a port fails loudly (the per-module-per-port class of
//      bug).
//   2. Real factory behavior — drive def.factory with a mock AudioContext
//      (GainNode-only — the 993 is PASSIVE routing, no worklet) and assert the
//      wiring: each trigger out's select gains reflect its route (OFF / FROM 1
//      / FROM 2), env_in → env_out is unity, setParam→readParam round-trips,
//      and dispose() disconnects every node the factory created.

import { describe, it, expect, vi } from 'vitest';
import { moog993Def } from './moog993';
import type { ModuleNode } from '$lib/graph/types';

// ───────────────────── Layer 1: module-def shape ─────────────────────
// ───────────────────── Layer 2: real factory (mock Web Audio) ─────────
// A minimal GainNode mock that records every connect()/disconnect() so we can
// assert the routing graph. setValueAtTime mirrors the .value (the factory
// reads .value back in readParam).
interface Conn { node: FakeGain; }
class FakeAudioParam {
  value = 0;
  setValueAtTime(v: number) { this.value = v; }
}
class FakeGain {
  gain = new FakeAudioParam();
  outgoing: Conn[] = [];
  disconnected = false;
  connect = vi.fn((node: FakeGain) => { this.outgoing.push({ node }); return node; });
  disconnect = vi.fn(() => { this.disconnected = true; });
}

function makeCtx() {
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
    id: 'moog993-test',
    type: 'moog993',
    domain: 'audio',
    position: { x: 0, y: 0 },
    params,
    data: {},
  };
}

/** The select-gain pair feeding a trigger output bus: [src1 gain, src2 gain]. */
function selectGainsOf(outNode: FakeGain, created: FakeGain[]): [number, number] {
  // outNode is fed by exactly two "select" gains (one per source). Find the
  // gains whose outgoing connection targets outNode.
  const feeders = created.filter((g) => g.outgoing.some((c) => c.node === outNode));
  expect(feeders.length).toBe(2);
  // The feeder driven from source 1 is the one src1 connects to (and source 2
  // similarly). We can identify them by which source fan-out gain connects to
  // them — but for the gain-value assertions the ORDER doesn't matter as a set;
  // tests below match against the known [src1, src2] order by reconstructing it.
  return [feeders[0]!.gain.value, feeders[1]!.gain.value] as [number, number];
}

/**
 * The route state a trigger output is ACTUALLY DELIVERING, identified by which
 * SOURCE fan-out feeds the open select gain — never by creation order.
 *
 * Routing is the whole subject here, so the probe must not assume it: a
 * closure that reads `feeders[0]` and calls it "source 1" would report a
 * correct-looking number while reading the wrong jack. `src1`/`src2` are the
 * handle's own declared input nodes, so this reads the delivered wiring.
 *
 * Returns 1 / 2 for a source that reaches the bus at unity, 0 when both select
 * gains are muted, and `'BROKEN'` if both are open (which the module must never
 * do — a summing bus carrying two clocks at once).
 */
function deliveredRoute(
  handle: { inputs: Map<string, { node: unknown }>; outputs: Map<string, { node: unknown }> },
  outId: string,
  created: FakeGain[],
): 0 | 1 | 2 | 'BROKEN' {
  const out = handle.outputs.get(outId)!.node as unknown as FakeGain;
  const src1 = handle.inputs.get('trig_from1')!.node as unknown as FakeGain;
  const src2 = handle.inputs.get('trig_from2')!.node as unknown as FakeGain;
  const feeders = created.filter((g) => g.outgoing.some((c) => c.node === out));
  expect(feeders.length, `${outId} must be fed by exactly two select gains`).toBe(2);
  const from1 = feeders.find((g) => src1.outgoing.some((c) => c.node === g));
  const from2 = feeders.find((g) => src2.outgoing.some((c) => c.node === g));
  expect(from1, `${outId} has no select gain fed by trig_from1`).toBeTruthy();
  expect(from2, `${outId} has no select gain fed by trig_from2`).toBeTruthy();
  const open1 = from1!.gain.value >= 0.5;
  const open2 = from2!.gain.value >= 0.5;
  if (open1 && open2) return 'BROKEN';
  if (open1) return 1;
  if (open2) return 2;
  return 0;
}

/** The state a dial position MEANS: the nearest declared state, clamped to the
 *  declared range. This is the reference the delivered routing is measured
 *  against — it is the definition of a banded selector, not a re-implementation
 *  of the DSP's internals. */
function nearestState(v: number): number {
  return Math.round(Math.max(0, Math.min(2, v)));
}

describe('moog993 ROUTE is a BANDED selector, not a continuous dial (#1911)', () => {
  // 201 evenly-spaced positions across the declared 0..2 travel — the same
  // sweep the issue measured, re-run here as a permanent leg.
  const SWEEP = Array.from({ length: 201 }, (_, i) => i / 100);

  it('every dial position on a fresh spawn delivers its NEAREST declared state', async () => {
    const wrong: string[] = [];
    for (const v of SWEEP) {
      const { ctx, created } = makeCtx();
      const handle = await moog993Def.factory(
        ctx as unknown as AudioContext,
        makeNode({ route1: v }),
      );
      const got = deliveredRoute(handle, 'trig_out1', created);
      if (got !== nearestState(v)) {
        wrong.push(`route1=${v} delivered ${got}, expected state ${nearestState(v)}`);
      }
    }
    expect(wrong, `positions whose delivered routing is not their nearest state (of ${SWEEP.length} swept)`).toEqual([]);
  });

  it('every dial position delivers its nearest state through setParam too', async () => {
    const { ctx, created } = makeCtx();
    const handle = await moog993Def.factory(ctx as unknown as AudioContext, makeNode());
    const wrong: string[] = [];
    for (const v of SWEEP) {
      handle.setParam('route2', v);
      const got = deliveredRoute(handle, 'trig_out2', created);
      if (got !== nearestState(v)) wrong.push(`setParam(route2, ${v}) delivered ${got}`);
    }
    expect(wrong, 'positions whose live setParam routing is not their nearest state').toEqual([]);
  });

  // The instrument's own control: the sweep above cannot pass by always
  // returning one state, because the reference itself takes all three — and a
  // probe blind to the difference would fail THIS test instead.
  it('the reference takes all three states across the sweep (instrument control)', () => {
    expect(new Set(SWEEP.map(nearestState))).toEqual(new Set([0, 1, 2]));
  });

  it('a position inside the OFF band mutes both sources (negative control)', async () => {
    const { ctx, created } = makeCtx();
    const handle = await moog993Def.factory(
      ctx as unknown as AudioContext,
      makeNode({ route3: 0.4 }),
    );
    expect(deliveredRoute(handle, 'trig_out3', created)).toBe(0);
  });

  it('a persisted non-integer route RESPAWNS routed, not silent', async () => {
    // The reload path: a stored 1.4 reached the factory as an initial param and
    // muted both select gains, so the patch came back SILENT on every load.
    const { ctx, created } = makeCtx();
    const handle = await moog993Def.factory(
      ctx as unknown as AudioContext,
      makeNode({ route1: 1.4 }),
    );
    expect(deliveredRoute(handle, 'trig_out1', created)).toBe(1);
  });

  it('one wheel notch off the default still routes', async () => {
    // Knob.svelte's wheel step is 0.005 of the arc → 1.01 on a 0..2 dial.
    const { ctx, created } = makeCtx();
    const handle = await moog993Def.factory(ctx as unknown as AudioContext, makeNode());
    handle.setParam('route1', 1.01);
    expect(deliveredRoute(handle, 'trig_out1', created)).toBe(1);
  });

  it('readParam reports the SAME state the routing delivers, at every position', async () => {
    // Three numbers once described one control: the store held 1.4, the DSP
    // routed nothing, and readParam said 0.
    const { ctx, created } = makeCtx();
    const handle = await moog993Def.factory(ctx as unknown as AudioContext, makeNode());
    const disagreements: string[] = [];
    for (const v of SWEEP) {
      handle.setParam('route1', v);
      const delivered = deliveredRoute(handle, 'trig_out1', created);
      const reported = handle.readParam('route1');
      if (reported !== delivered) {
        disagreements.push(`at ${v}: delivered ${delivered}, readParam ${reported}`);
      }
    }
    expect(disagreements, 'positions where readParam disagrees with the delivered routing').toEqual([]);
  });

  it('an out-of-range value lands on a declared state rather than muting', async () => {
    const { ctx, created } = makeCtx();
    const handle = await moog993Def.factory(ctx as unknown as AudioContext, makeNode());
    handle.setParam('route1', 5);
    expect(deliveredRoute(handle, 'trig_out1', created)).toBe(2);
    handle.setParam('route1', -3);
    expect(deliveredRoute(handle, 'trig_out1', created)).toBe(0);
  });
});

describe('moog993 factory: passive trigger routing', () => {
  it('exposes the declared inputs + outputs on the handle', async () => {
    const { ctx } = makeCtx();
    const handle = await moog993Def.factory(ctx as unknown as AudioContext, makeNode());
    expect([...handle.inputs.keys()].sort()).toEqual(
      ['env_in1', 'env_in2', 'trig_from1', 'trig_from2'].sort(),
    );
    expect([...handle.outputs.keys()].sort()).toEqual(
      ['env_out1', 'env_out2', 'trig_out1', 'trig_out2', 'trig_out3'].sort(),
    );
    // input/output entries carry a real node + the documented index shape.
    for (const v of handle.inputs.values()) {
      expect(v.node).toBeTruthy();
      expect(v.input).toBe(0);
    }
    for (const v of handle.outputs.values()) {
      expect(v.node).toBeTruthy();
      expect(v.output).toBe(0);
    }
  });

  it('default route (FROM 1) opens source-1 select gain, mutes source-2', async () => {
    const { ctx, created } = makeCtx();
    const handle = await moog993Def.factory(ctx as unknown as AudioContext, makeNode());
    const out1 = handle.outputs.get('trig_out1')!.node as unknown as FakeGain;
    const gains = selectGainsOf(out1, created).sort(); // [muted, open]
    expect(gains).toEqual([0, 1]);
  });

  it('route=0 (OFF) mutes BOTH select gains for that out', async () => {
    const { ctx, created } = makeCtx();
    const handle = await moog993Def.factory(ctx as unknown as AudioContext, makeNode({ route2: 0 }));
    const out2 = handle.outputs.get('trig_out2')!.node as unknown as FakeGain;
    expect(selectGainsOf(out2, created)).toEqual([0, 0]);
  });

  it('route=2 (FROM 2) opens exactly one select gain', async () => {
    const { ctx, created } = makeCtx();
    const handle = await moog993Def.factory(ctx as unknown as AudioContext, makeNode({ route3: 2 }));
    const out3 = handle.outputs.get('trig_out3')!.node as unknown as FakeGain;
    const gains = selectGainsOf(out3, created).sort();
    expect(gains).toEqual([0, 1]);
  });

  it('both trigger sources fan out to all three trigger out buses', async () => {
    const { ctx } = makeCtx();
    const handle = await moog993Def.factory(ctx as unknown as AudioContext, makeNode());
    const src1 = handle.inputs.get('trig_from1')!.node as unknown as FakeGain;
    const src2 = handle.inputs.get('trig_from2')!.node as unknown as FakeGain;
    // Each source connects to one select-gain per output → three connections.
    expect(src1.outgoing.length).toBe(3);
    expect(src2.outgoing.length).toBe(3);
  });

  it('env_in1→env_out1 and env_in2→env_out2 are unity passthroughs', async () => {
    const { ctx } = makeCtx();
    const handle = await moog993Def.factory(ctx as unknown as AudioContext, makeNode());
    const in1 = handle.inputs.get('env_in1')!.node as unknown as FakeGain;
    const out1 = handle.outputs.get('env_out1')!.node as unknown as FakeGain;
    const in2 = handle.inputs.get('env_in2')!.node as unknown as FakeGain;
    const out2 = handle.outputs.get('env_out2')!.node as unknown as FakeGain;
    // The passthrough is a single GainNode used as BOTH the input receiver and
    // the output tap, at unity gain.
    expect(in1).toBe(out1);
    expect(in2).toBe(out2);
    expect(in1.gain.value).toBe(1);
    expect(in2.gain.value).toBe(1);
  });

  it('setParam then readParam round-trips each route value', async () => {
    const { ctx } = makeCtx();
    const handle = await moog993Def.factory(ctx as unknown as AudioContext, makeNode());
    for (const [id, value] of [['route1', 2], ['route2', 0], ['route3', 1]] as const) {
      handle.setParam(id, value);
      expect(handle.readParam(id)).toBe(value);
    }
  });

  it('setParam(route, 2) flips the live select gains to source 2', async () => {
    const { ctx, created } = makeCtx();
    const handle = await moog993Def.factory(ctx as unknown as AudioContext, makeNode());
    const out1 = handle.outputs.get('trig_out1')!.node as unknown as FakeGain;
    // Default FROM 1: one gain = 1.
    handle.setParam('route1', 2); // → FROM 2
    const gains = selectGainsOf(out1, created).sort();
    // Still exactly one open gain (the other source), confirming the flip.
    expect(gains).toEqual([0, 1]);
  });

  it('readParam returns undefined for an unknown param id', async () => {
    const { ctx } = makeCtx();
    const handle = await moog993Def.factory(ctx as unknown as AudioContext, makeNode());
    expect(handle.readParam('nope')).toBeUndefined();
  });

  it('dispose() disconnects every node the factory created', async () => {
    const { ctx, created } = makeCtx();
    const handle = await moog993Def.factory(ctx as unknown as AudioContext, makeNode());
    expect(created.length).toBeGreaterThan(0);
    handle.dispose();
    for (const g of created) {
      expect(g.disconnected).toBe(true);
    }
  });
});
