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

// ───────────────────── Layer 1: module-def shape ─────────────────────
describe('ninelivesDef: module def shape', () => {
  it('is a lowercase-labelled audio modulation module', () => {
    expect(ninelivesDef.type).toBe('ninelives');
    expect(ninelivesDef.label).toBe('nine lives');
    expect(ninelivesDef.label).toBe(ninelivesDef.label.toLowerCase()); // lowercase-label guard
    expect(ninelivesDef.domain).toBe('audio');
    expect(ninelivesDef.category).toBe('modulation');
    expect(ninelivesDef.palette).toEqual({ top: 'Audio modules', sub: 'Utility' });
  });

  it('exposes a single RESET input declared as a TRIGGER (gate cable)', () => {
    expect(ninelivesDef.inputs.map((p) => p.id)).toEqual(['reset']);
    const reset = ninelivesDef.inputs[0]!;
    expect(reset.type).toBe('gate');
    expect(reset.edge).toBe('trigger');
  });

  it('exposes nine CV outputs out1..out9 in order', () => {
    const ids = ninelivesDef.outputs.map((p) => p.id);
    expect(ids).toEqual(['out1', 'out2', 'out3', 'out4', 'out5', 'out6', 'out7', 'out8', 'out9']);
    for (const o of ninelivesDef.outputs) expect(o.type).toBe('cv');
  });

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

  it('declares exactly the rate + shape params (no CV param inputs)', () => {
    expect(ninelivesDef.params.map((p) => p.id)).toEqual(['rate', 'shape']);
  });

  it('documents every port + every param (STRICT_DOCS completeness)', () => {
    const docs = ninelivesDef.docs!;
    expect(docs.explanation && docs.explanation.length).toBeGreaterThan(40);
    for (const inp of ninelivesDef.inputs) {
      expect(docs.inputs?.[inp.id], `input ${inp.id} documented`).toBeTruthy();
    }
    for (const out of ninelivesDef.outputs) {
      expect(docs.outputs?.[out.id], `output ${out.id} documented`).toBeTruthy();
    }
    for (const p of ninelivesDef.params) {
      expect(docs.controls?.[p.id], `control ${p.id} documented`).toBeTruthy();
    }
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

  it('maps out1..out9 to worklet outputs 0..8 in order', async () => {
    const { handle } = await runFactory();
    expect(handle.outputs.size).toBe(9);
    for (let n = 1; n <= 9; n++) {
      const out = handle.outputs.get(`out${n}`)!;
      expect(out, `out${n} present`).toBeDefined();
      expect(out.output).toBe(n - 1);
    }
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
