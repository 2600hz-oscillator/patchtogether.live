// packages/web/src/lib/audio/modules/scaler.test.ts
//
// Three test layers for SCALER (1-in / 1-out signal multiplier, out = in × amount):
//   1. Module-def shape — pins the I/O surface (the single `in` audio port that
//      also accepts the CV family, the single `out` audio port, and the `amount`
//      param: log 0.1..10 default 1) so a refactor that silently drops a port or
//      changes the range fails loudly (the per-module-per-port regression class).
//   2. Factory behavior — drive the PURE Web Audio factory with a mock
//      AudioContext (one GainNode, no worklet): assert the handle exposes the
//      declared in/out pointing at the SAME gain node, the default (unity) is
//      applied, saved overrides apply, and setParam/readParam round-trips.
//   3. DSP correctness (out = in × amount) — the GainNode's `gain` IS the
//      multiplier, so for any sample `in`, the output equals `in × amount`.
//      Verify the relationship holds across the full 0.1..10 range: amount=0.5
//      halves, 2 doubles, 10 ×10, 0.1 ×0.1, and default 1.0 is a passthrough.

import { describe, it, expect, vi } from 'vitest';
import { scalerDef } from './scaler';
import type { ModuleNode } from '$lib/graph/types';

// ───────────────────── Layer 1: module-def shape ─────────────────────
describe('scalerDef: module def shape', () => {
  it('declares type=scaler, label="scaler" (lowercase), category=utilities, domain=audio, schemaVersion=1', () => {
    expect(scalerDef.type).toBe('scaler');
    expect(scalerDef.label).toBe('scaler');
    // Guard against the uppercase-label CI failure (card CSS uppercases for display).
    expect(scalerDef.label).toBe(scalerDef.label.toLowerCase());
    expect(scalerDef.category).toBe('utilities');
    expect(scalerDef.domain).toBe('audio');
  });

  it('exposes a single `in` audio input that also accepts the CV family', () => {
    expect(scalerDef.inputs.map((p) => p.id)).toEqual(['in']);
    const inp = scalerDef.inputs[0];
    expect(inp.type).toBe('audio');
    // Widened so a CV / pitch / gate source can be scaled too (SCOPE-probe pattern).
    expect(inp.accepts).toEqual(['cv', 'pitch', 'gate']);
    // It is a signal multiply, NOT a CV→AudioParam routing.
    expect(inp.paramTarget).toBeUndefined();
  });

  it('exposes a single `out` output that adopts its upstream input type', () => {
    expect(scalerDef.outputs.map((p) => p.id)).toEqual(['out']);
    // Declared `audio` is the FALLBACK type (nothing patched upstream).
    expect(scalerDef.outputs[0].type).toBe('audio');
    // TYPE-TRANSPARENT pass-through: the emitted cable type adopts whatever's
    // patched into `in`, so a CV source → a CV out (→ the cross-domain video
    // bridge reads the scaled value on the raw tail-sample path, not the RMS
    // follower that clamped the AMOUNT knob dead). The id MUST reference a real
    // input port. See snapshot.ts resolveAdoptedSourceTypes.
    expect(scalerDef.outputs[0].adoptsUpstreamFrom).toBe('in');
    expect(scalerDef.inputs.map((p) => p.id)).toContain(scalerDef.outputs[0].adoptsUpstreamFrom);
  });

  it('exposes one AMOUNT param: log taper, 0.1..10, default 1 (unity)', () => {
    expect(scalerDef.params.map((p) => p.id)).toEqual(['amount']);
    const amt = scalerDef.params[0];
    expect(amt.label).toBe('AMOUNT');
    expect(amt.min).toBe(0.1);
    expect(amt.max).toBe(10);
    expect(amt.defaultValue).toBe(1);
    // LOG so unity sits at knob center and ×0.1..×10 is symmetric (needs min>0).
    expect(amt.curve).toBe('log');
    expect(amt.min).toBeGreaterThan(0);
  });
});

// ───────────────────── Layer 2 + 3: pure Web Audio factory + DSP ─────────────────────
// SCALER is a pure-gain module (no worklet / no Faust). Mock just the slice of
// AudioContext the factory touches: createGain() + currentTime. The GainNode
// carries a settable .gain.value (via setValueAtTime) + a connect/disconnect
// spy — the same FakeGain shape the moog995 / foxy / scope factory tests use.
interface FakeAudioParam {
  value: number;
  setValueAtTime: (v: number, t: number) => void;
}
function mkParam(): FakeAudioParam {
  return {
    value: 0,
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
function makeMockCtx() {
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
    id: 'scaler-test',
    type: 'scaler',
    domain: 'audio',
    position: { x: 0, y: 0 },
    params,
  };
}

describe('scaler factory: pure Web Audio graph', () => {
  it('creates exactly one GainNode', async () => {
    const { ctx, created } = makeMockCtx();
    await scalerDef.factory(ctx as unknown as AudioContext, makeNode());
    expect(created).toHaveLength(1);
  });

  it('routes in → gain → out (in and out tap the SAME gain node)', async () => {
    const { ctx, created } = makeMockCtx();
    const handle = await scalerDef.factory(ctx as unknown as AudioContext, makeNode());
    const inEntry = handle.inputs.get('in');
    const outEntry = handle.outputs.get('out');
    expect(inEntry).toBeDefined();
    expect(outEntry).toBeDefined();
    expect(inEntry!.input).toBe(0);
    expect(outEntry!.output).toBe(0);
    expect(inEntry!.node).toBe(created[0]);
    expect(outEntry!.node).toBe(created[0]);
    // in and out are the same node — a single multiply stage.
    expect(inEntry!.node).toBe(outEntry!.node);
  });

  it('applies the def default (1.0 = unity passthrough) when no params are saved', async () => {
    const { ctx, created } = makeMockCtx();
    await scalerDef.factory(ctx as unknown as AudioContext, makeNode());
    expect(created[0].gain.value).toBe(1);
  });

  it('applies a saved AMOUNT override', async () => {
    const { ctx, created } = makeMockCtx();
    await scalerDef.factory(ctx as unknown as AudioContext, makeNode({ amount: 3.5 }));
    expect(created[0].gain.value).toBeCloseTo(3.5, 12);
  });

  it('setParam then readParam round-trips on the live gain', async () => {
    const { ctx, created } = makeMockCtx();
    const handle = await scalerDef.factory(ctx as unknown as AudioContext, makeNode());
    handle.setParam('amount', 7.25);
    expect(handle.readParam('amount')).toBeCloseTo(7.25, 12);
    expect(created[0].gain.value).toBeCloseTo(7.25, 12);
  });

  it('readParam on an unknown param id returns undefined', async () => {
    const { ctx } = makeMockCtx();
    const handle = await scalerDef.factory(ctx as unknown as AudioContext, makeNode());
    expect(handle.readParam('nope')).toBeUndefined();
  });

  it('dispose() disconnects the gain node', async () => {
    const { ctx, created } = makeMockCtx();
    const handle = await scalerDef.factory(ctx as unknown as AudioContext, makeNode());
    handle.dispose();
    expect(created[0].disconnect).toHaveBeenCalled();
  });
});

describe('scaler DSP: out = in × amount across the 0.1..10 range', () => {
  // A GainNode multiplies every sample by its `gain` value, so for the chosen
  // AMOUNT the output sample = input sample × gain. We assert that relationship
  // directly: set AMOUNT (the gain), then for representative input samples the
  // expected output is in × amount. Covers the user-specified cases
  // (×0.5 halves, ×2 doubles, ×10, ×0.1, and 1.0 = passthrough) plus the range
  // extremes.
  const INPUTS = [-1, -0.5, -0.123, 0, 0.123, 0.5, 1];
  const AMOUNTS = [
    { amount: 0.1, note: 'min ×0.1' },
    { amount: 0.5, note: '×0.5 halves' },
    { amount: 1.0, note: 'unity passthrough' },
    { amount: 2.0, note: '×2 doubles' },
    { amount: 10.0, note: 'max ×10' },
  ];

  for (const { amount, note } of AMOUNTS) {
    it(`amount=${amount} (${note}): output sample = input × ${amount}`, async () => {
      const { ctx, created } = makeMockCtx();
      await scalerDef.factory(ctx as unknown as AudioContext, makeNode({ amount }));
      const gain = created[0].gain.value;
      // The factory programmed the gain = amount.
      expect(gain).toBeCloseTo(amount, 12);
      // A GainNode output = input × gain, sample-by-sample.
      for (const x of INPUTS) {
        expect(x * gain).toBeCloseTo(x * amount, 12);
      }
    });
  }

  it('default (no saved amount) is exact unity passthrough: out = in', async () => {
    const { ctx, created } = makeMockCtx();
    await scalerDef.factory(ctx as unknown as AudioContext, makeNode());
    const gain = created[0].gain.value;
    expect(gain).toBe(1);
    for (const x of INPUTS) {
      expect(x * gain).toBe(x);
    }
  });

  it('changing AMOUNT live changes the multiplier (setParam updates the gain)', async () => {
    const { ctx, created } = makeMockCtx();
    const handle = await scalerDef.factory(ctx as unknown as AudioContext, makeNode());
    // Start at unity.
    expect(created[0].gain.value).toBe(1);
    // Dial to ×4 — a 0.25 input now yields 1.0.
    handle.setParam('amount', 4);
    expect(0.25 * created[0].gain.value).toBeCloseTo(1.0, 12);
    // Dial down to ×0.1 — a 1.0 input now yields 0.1.
    handle.setParam('amount', 0.1);
    expect(1.0 * created[0].gain.value).toBeCloseTo(0.1, 12);
  });
});

// ───────────────────── AMOUNT scales a CV signal linearly (dead-knob fix) ─────────────────────
// The dead-knob defect was at the cross-domain bridge (an audio-typed out
// hitting the RMS follower); the PURE scaling core is the same GainNode for CV
// as for audio. This block pins the contract the e2e proves end-to-end: for a
// ±CV input, out = cv × amount, LINEARLY, across the AMOUNT range — so amount
// 2 vs 5 vs 10 produce DISTINCT scaled CV (the values the owner saw collapse to
// an identical result when the RMS branch saturated).
describe('scaler CV scaling: out = cv × amount, linear (dead-knob regression)', () => {
  // A representative ±CV value (e.g. an LFO / env tail sample feeding a video
  // module's orient input). Eurorack convention is ±1 on the cv cable.
  const CV = 0.4;
  const AMOUNTS = [2, 5, 10];

  it('different AMOUNTs scale the SAME CV to DISTINCT, ordered values', async () => {
    const scaled: number[] = [];
    for (const amount of AMOUNTS) {
      const { ctx, created } = makeMockCtx();
      await scalerDef.factory(ctx as unknown as AudioContext, makeNode({ amount }));
      const gain = created[0].gain.value;
      expect(gain).toBeCloseTo(amount, 12);
      scaled.push(CV * gain); // GainNode output = input × gain, sample-accurate.
    }
    // amount 2/5/10 → 0.8 / 2.0 / 4.0 — exact, and strictly increasing. (Under
    // the bug these all collapsed to ~the same RMS-clamped result.)
    expect(scaled).toEqual([CV * 2, CV * 5, CV * 10]);
    expect(scaled[0]).toBeLessThan(scaled[1]);
    expect(scaled[1]).toBeLessThan(scaled[2]);
  });

  it('scaling is LINEAR in AMOUNT: doubling AMOUNT doubles the scaled CV', async () => {
    const make = async (amount: number) => {
      const { ctx, created } = makeMockCtx();
      await scalerDef.factory(ctx as unknown as AudioContext, makeNode({ amount }));
      return CV * created[0].gain.value;
    };
    const at2 = await make(2);
    const at4 = await make(4);
    expect(at4).toBeCloseTo(at2 * 2, 12);
  });

  it('attenuation (AMOUNT < 1) scales a CV DOWN, preserving sign', async () => {
    const { ctx, created } = makeMockCtx();
    await scalerDef.factory(ctx as unknown as AudioContext, makeNode({ amount: 0.25 }));
    const gain = created[0].gain.value;
    expect(-0.8 * gain).toBeCloseTo(-0.2, 12); // sign preserved, magnitude ×0.25
    expect(0.8 * gain).toBeCloseTo(0.2, 12);
  });
});
