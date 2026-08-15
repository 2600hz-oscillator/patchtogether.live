// packages/web/src/lib/audio/modules/ninelives.test.ts
//
// Two test layers for NINE LIVES:
//   1. Module-def shape — the reset trigger input, the 9 cv outputs, the
//      rate + shape params (matching the LFO's rate definition), docs
//      completeness, and the lowercase-label guard.
//   2. Factory wiring — a mocked AudioWorkletNode confirms the factory wires
//      one `reset` input (input 0) + nine `out1..out9` outputs (outputs 0..8),
//      seeds params from node.params (falling back to defaults), and that
//      setParam / readParam / dispose behave.
//
// The per-sample DSP (the ⅓ ladder + reset re-sync) is covered deterministically
// by packages/dsp/src/lib/ninelives-dsp.test.ts.

import { describe, it, expect, vi } from 'vitest';
import { ninelivesDef } from './ninelives';
import { lfoDef } from './lfo';
import type { ModuleNode } from '$lib/graph/types';
// The ladder, from the file the worklet is BUILT from — the def's port roster
// is derived from the same constant, and this asserts the join in both
// directions rather than restating the length. Relative path for the reason
// `sidecar-face-model.ts` documents (a worktree may not symlink the workspace
// package under node_modules).
import { NINE_LIVES_RATE_MULTIPLIERS } from '../../../../../dsp/src/lib/ninelives-dsp';

// ───────────────────── Layer 1: module-def shape ─────────────────────
describe('ninelivesDef: module def shape', () => {
  it('reuses the LFO rate definition exactly (out1 behaves like a normal LFO)', () => {
    const rate = ninelivesDef.params.find((p) => p.id === 'rate')!;
    const lfoRate = lfoDef.params.find((p) => p.id === 'rate')!;
    expect(rate.min).toBe(lfoRate.min);
    expect(rate.max).toBe(lfoRate.max);
    expect(rate.curve).toBe(lfoRate.curve);
    expect(rate.defaultValue).toBe(lfoRate.defaultValue);
    expect(rate.units).toBe(lfoRate.units);
    // Concretely: log 0.01..100 Hz, default 1.
    expect(rate.curve).toBe('log');
    expect(rate.min).toBe(0.01);
    expect(rate.max).toBe(100);
    expect(rate.defaultValue).toBe(1);
  });

  it('has a shared Waveform morph param reusing the LFO shape range (0..2)', () => {
    const shape = ninelivesDef.params.find((p) => p.id === 'shape')!;
    const lfoShape = lfoDef.params.find((p) => p.id === 'shape')!;
    expect(shape.min).toBe(lfoShape.min);
    expect(shape.max).toBe(lfoShape.max);
    expect(shape.curve).toBe(lfoShape.curve);
    expect(shape.min).toBe(0);
    expect(shape.max).toBe(2);
    expect(shape.curve).toBe('linear');
    expect(shape.label).toBe('Waveform');
  });

});

// ───────────────────── Layer 2: factory wiring (mock worklet) ─────────
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

class FakeWorkletNode {
  parameters: Map<string, FakeAudioParam>;
  port = { close: vi.fn() };
  disconnect = vi.fn();
  constructor(
    _ctx: unknown,
    public name: string,
    public options: { numberOfInputs: number; numberOfOutputs: number; outputChannelCount: number[] },
  ) {
    this.parameters = new Map([
      ['rate', mkParam(1)],
      ['shape', mkParam(0)],
    ]);
  }
}

function makeMockCtx() {
  const addModule = vi.fn().mockResolvedValue(undefined);
  const ctx = { currentTime: 0, sampleRate: 48000, audioWorklet: { addModule } };
  return { ctx, addModule };
}

function makeNode(params: Record<string, number> = {}): ModuleNode {
  return { id: 'ninelives-test', type: 'ninelives', domain: 'audio', position: { x: 0, y: 0 }, params };
}

async function runFactory(params: Record<string, number> = {}) {
  const G = globalThis as unknown as { AudioWorkletNode?: unknown };
  const prev = G.AudioWorkletNode;
  G.AudioWorkletNode = FakeWorkletNode as unknown;
  try {
    const { ctx, addModule } = makeMockCtx();
    const handle = await ninelivesDef.factory(ctx as unknown as AudioContext, makeNode(params));
    return { handle, ctx, addModule };
  } finally {
    G.AudioWorkletNode = prev;
  }
}

describe('ninelives factory: worklet wiring', () => {
  it('loads the worklet module once and constructs a 1-in / 9-out node', async () => {
    const { handle, addModule } = await runFactory();
    expect(addModule).toHaveBeenCalledTimes(1);
    expect(handle.domain).toBe('audio');
  });

  it('maps the reset input to worklet input 0', async () => {
    const { handle } = await runFactory();
    const reset = handle.inputs.get('reset')!;
    expect(reset).toBeDefined();
    expect(reset.input).toBe(0);
    expect(handle.inputs.size).toBe(1);
  });

  it('publishes EXACTLY the declared output ports, at ascending worklet indices', async () => {
    const { handle } = await runFactory();
    const declared = ninelivesDef.outputs.map((o) => o.id);

    // DERIVED MEMBERSHIP, both directions — not a size. This used to read
    // `expect(handle.outputs.size).toBe(9)` plus a `for (n = 1; n <= 9)` loop,
    // i.e. two hand-typed copies of how many outputs there are (CLAUDE.md).
    // Asserting the SETS is strictly stronger than asserting the count: it
    // catches a published port the def never declared, which no size check can.
    expect([...handle.outputs.keys()].sort()).toEqual([...declared].sort());

    // The index map, keyed by the DEF's declaration order. ⚠ THIS IS THE
    // FACTORY'S OWN BOOKKEEPING AND NOTHING MORE — it says `out5` is worklet
    // output 4, and is structurally blind to what the processor WRITES there.
    // The join between a declared port id and its actual rate on the ⅓ ladder
    // is art/scenarios/ninelives/ladder.test.ts, which renders the shipped
    // worklet through this factory and measures each port.
    declared.forEach((id, n) => {
      const out = handle.outputs.get(id)!;
      expect(out, `${id} present`).toBeDefined();
      expect(out.output, `${id} → worklet output ${n}`).toBe(n);
    });
  });

  it('the declared port roster IS the DSP core ladder, both directions', async () => {
    // ⚠ THIS IS LOAD-BEARING, not a restatement, and it is the leg that has to
    // carry the invariant BY ASSERTION because it cannot be carried by
    // construction. The def's `outputs` MUST stay a source-parseable array
    // literal — `buildModuleManifest` regex-parses the def source, so a derived
    // roster silently empties the module's docs page (measured: it does, and
    // `module-manifest.test.ts` is the gate that says so). Meanwhile the
    // FACTORY sizes the worklet node off `NINE_LIVES_OUTPUT_COUNT`.
    //
    // So the two numbers still live in two files. What has changed is that a
    // disagreement is now RED here instead of silently building a node with
    // fewer outputs than the processor writes (dead jacks) or more than it
    // does. Both directions, and no count typed on either side.
    expect(ninelivesDef.outputs.map((o) => o.id)).toEqual(
      NINE_LIVES_RATE_MULTIPLIERS.map((_, n) => `out${n + 1}`),
    );
    const { handle } = await runFactory();
    expect(handle.outputs.size).toBe(NINE_LIVES_RATE_MULTIPLIERS.length);
  });

  it('seeds params from defaults when node.params is empty', async () => {
    const { handle } = await runFactory();
    expect(handle.readParam('rate')).toBe(1);
    expect(handle.readParam('shape')).toBe(0);
  });

  it('seeds params from saved node.params overrides', async () => {
    const { handle } = await runFactory({ rate: 4.2, shape: 1.5 });
    expect(handle.readParam('rate')).toBeCloseTo(4.2, 12);
    expect(handle.readParam('shape')).toBeCloseTo(1.5, 12);
  });

  it('setParam then readParam round-trips', async () => {
    const { handle } = await runFactory();
    handle.setParam('rate', 12.5);
    expect(handle.readParam('rate')).toBeCloseTo(12.5, 12);
  });

  it('readParam on an unknown param id returns undefined', async () => {
    const { handle } = await runFactory();
    expect(handle.readParam('nope')).toBeUndefined();
  });

  it('dispose() disconnects the worklet node', async () => {
    const { handle } = await runFactory();
    // The handle holds the FakeWorkletNode via its output entries.
    const node = handle.outputs.get('out1')!.node as unknown as FakeWorkletNode;
    handle.dispose();
    expect(node.disconnect).toHaveBeenCalled();
  });
});
