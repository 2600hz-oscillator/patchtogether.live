// packages/web/src/lib/audio/modules/moog962.test.ts
//
// Two test layers for the MOOG 962 SEQUENTIAL SWITCH (Moog System 55 clone):
//   1. Module-def shape — pins the 962's I/O surface (in1..in3 + shift inputs,
//      the single out output, the literal `stages` param) so a refactor that
//      silently drops a port / param fails loudly (the per-module-per-port
//      regression-net class of bug). Also pins the handle Map keys === the def
//      port ids.
//   2. Factory wiring — the 962 is a custom AudioWorklet, so we drive the
//      factory with a mock AudioContext whose AudioWorkletNode records its
//      param values + connections, then assert: every declared input/output is
//      exposed at the right index, the stages param seeds from node.params,
//      setParam→readParam round-trips, and dispose() disconnects the node +
//      the silence keepalive.
//
// The pure SHIFT-advance counter is covered separately + exhaustively in
// packages/dsp/src/lib/moog962-dsp.test.ts (rising-edge timing + wrap).

import { describe, it, expect, vi } from 'vitest';
import { moog962Def } from './moog962';
import type { ModuleNode } from '$lib/graph/types';

// The factory imports the worklet bundle URL via `?url`; stub it so the import
// resolves under vitest (no real bundle on disk needed for the def/factory).
vi.mock('@patchtogether.live/dsp/dist/moog962.js?url', () => ({ default: 'moog962.js' }));

// ───────────────────── Layer 1: module-def shape ─────────────────────
describe('moog962Def: module def shape', () => {
  it('declares type=moog962, label="Moog 962 Seq Switch", category=utilities, schemaVersion=1', () => {
    expect(moog962Def.type).toBe('moog962');
    expect(moog962Def.label).toBe('Moog 962 Seq Switch');
    expect(moog962Def.category).toBe('utilities');
    expect(moog962Def.schemaVersion).toBe(1);
    expect(moog962Def.domain).toBe('audio');
  });

  it('lives in the Moog → SYS55 palette bucket and uses the Moog962Card', () => {
    expect(moog962Def.palette).toEqual({ top: 'Moog', sub: 'SYS55' });
    expect(moog962Def.card).toBe('Moog962Card');
  });

  it('exposes three signal inputs (in1..in3, cv) + a shift gate', () => {
    const ids = moog962Def.inputs.map((p) => p.id);
    expect(ids).toEqual(['in1', 'in2', 'in3', 'shift']);
    for (const id of ['in1', 'in2', 'in3']) {
      const p = moog962Def.inputs.find((q) => q.id === id)!;
      expect(p.type).toBe('cv');
      // The inputs are signals being routed, not knob modulators.
      expect(p.cvScale).toBeUndefined();
      expect(p.paramTarget).toBeUndefined();
    }
    expect(moog962Def.inputs.find((p) => p.id === 'shift')!.type).toBe('gate');
  });

  it('exposes a single selected output: out (cv)', () => {
    const ids = moog962Def.outputs.map((p) => p.id);
    expect(ids).toEqual(['out']);
    expect(moog962Def.outputs[0].type).toBe('cv');
  });

  it('exposes one param (stages), discrete 2..3 default 3', () => {
    const ids = moog962Def.params.map((p) => p.id);
    expect(ids).toEqual(['stages']);
    const p = moog962Def.params[0];
    expect(p.min).toBe(2);
    expect(p.max).toBe(3);
    expect(p.defaultValue).toBe(3);
    expect(p.curve).toBe('discrete');
    expect(p.label).toBe('Stages');
  });
});

// ───────────────────── Layer 2: factory wiring ─────────────────────
//
// Minimal Web Audio worklet mock. The AudioWorkletNode tracks its param values
// (via a parameters Map of mock AudioParams), the inputs the silence source
// connected to, and disconnect calls.
interface MockParam {
  value: number;
  setValueAtTime: (v: number, t: number) => void;
}
interface MockWorkletNode {
  parameters: Map<string, MockParam>;
  disconnectCount: number;
  disconnect: () => void;
}
interface MockConstantSource {
  offset: { value: number };
  started: boolean;
  stopped: boolean;
  // [destNode, output, input] tuples
  connections: Array<[MockWorkletNode, number, number]>;
  start: () => void;
  stop: () => void;
  connect: (dest: MockWorkletNode, output: number, input: number) => void;
  disconnect: () => void;
}

function makeParam(v: number): MockParam {
  return {
    value: v,
    setValueAtTime(nv: number) {
      this.value = nv;
    },
  };
}

function makeMockCtx(): {
  ctx: AudioContext;
  worklet: MockWorkletNode;
  silence: MockConstantSource;
} {
  const worklet: MockWorkletNode = {
    parameters: new Map<string, MockParam>([['stages', makeParam(3)]]),
    disconnectCount: 0,
    disconnect() {
      this.disconnectCount++;
    },
  };
  const silence: MockConstantSource = {
    offset: { value: 0 },
    started: false,
    stopped: false,
    connections: [],
    start() {
      this.started = true;
    },
    stop() {
      this.stopped = true;
    },
    connect(dest, output, input) {
      this.connections.push([dest, output, input]);
    },
    disconnect() {
      /* tracked via stopped for the test */
    },
  };

  const ctx = {
    currentTime: 0,
    audioWorklet: { addModule: async () => undefined },
    createConstantSource: () => silence,
  } as unknown as AudioContext;

  // Patch the global AudioWorkletNode constructor for the duration of the test.
  (globalThis as unknown as { AudioWorkletNode: unknown }).AudioWorkletNode =
    function MockAudioWorkletNode() {
      return worklet;
    } as unknown;

  return { ctx, worklet, silence };
}

function makeNode(params: Record<string, number> = {}): ModuleNode {
  return {
    id: 'moog962-test',
    type: 'moog962',
    domain: 'audio',
    position: { x: 0, y: 0 },
    params,
    data: {},
  };
}

describe('moog962 factory: wiring + params', () => {
  it('exposes the four declared inputs at indices 0..3 of the worklet', async () => {
    const { ctx, worklet } = makeMockCtx();
    const handle = await moog962Def.factory(ctx, makeNode());
    const expected: Record<string, number> = { in1: 0, in2: 1, in3: 2, shift: 3 };
    for (const [id, idx] of Object.entries(expected)) {
      const entry = handle.inputs.get(id);
      expect(entry, `input ${id}`).toBeDefined();
      expect(entry!.input).toBe(idx);
      expect(entry!.node).toBe(worklet as unknown as AudioNode);
    }
    // Handle Map keys === def input ids.
    expect([...handle.inputs.keys()]).toEqual(moog962Def.inputs.map((p) => p.id));
  });

  it('exposes out at output index 0 of the worklet', async () => {
    const { ctx, worklet } = makeMockCtx();
    const handle = await moog962Def.factory(ctx, makeNode());
    const out = handle.outputs.get('out');
    expect(out).toBeDefined();
    expect(out!.output).toBe(0);
    expect(out!.node).toBe(worklet as unknown as AudioNode);
    expect([...handle.outputs.keys()]).toEqual(moog962Def.outputs.map((p) => p.id));
  });

  it('seeds the stages param with the default (3) when node.params is empty', async () => {
    const { ctx, worklet } = makeMockCtx();
    await moog962Def.factory(ctx, makeNode());
    expect(worklet.parameters.get('stages')!.value).toBe(3);
  });

  it('seeds the stages param from node.params at mount', async () => {
    const { ctx, worklet } = makeMockCtx();
    await moog962Def.factory(ctx, makeNode({ stages: 2 }));
    expect(worklet.parameters.get('stages')!.value).toBe(2);
  });

  it('connects the silence keepalive into ALL four inputs', async () => {
    const { ctx, silence, worklet } = makeMockCtx();
    await moog962Def.factory(ctx, makeNode());
    expect(silence.started).toBe(true);
    const inputsTouched = silence.connections
      .filter(([dest]) => dest === worklet)
      .map(([, , input]) => input)
      .sort();
    expect(inputsTouched).toEqual([0, 1, 2, 3]);
  });

  it('setParam then readParam round-trips for stages', async () => {
    const { ctx } = makeMockCtx();
    const handle = await moog962Def.factory(ctx, makeNode());
    expect(handle.readParam('stages')).toBe(3);
    handle.setParam('stages', 2);
    expect(handle.readParam('stages')).toBe(2);
  });

  it('setParam ignores unknown param ids without throwing', async () => {
    const { ctx } = makeMockCtx();
    const handle = await moog962Def.factory(ctx, makeNode());
    expect(() => handle.setParam('nope', 0.5)).not.toThrow();
    expect(handle.readParam('nope')).toBeUndefined();
  });

  it('dispose() stops the silence source and disconnects the worklet node', async () => {
    const { ctx, worklet, silence } = makeMockCtx();
    const handle = await moog962Def.factory(ctx, makeNode());
    handle.dispose();
    expect(silence.stopped).toBe(true);
    expect(worklet.disconnectCount).toBeGreaterThanOrEqual(1);
  });
});
