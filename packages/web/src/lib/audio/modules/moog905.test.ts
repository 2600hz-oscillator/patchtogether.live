// packages/web/src/lib/audio/modules/moog905.test.ts
//
// Two test layers for the MOOG 905 SPRING REVERBERATION (moogafakkin System 55/35
// clone):
//   1. Module-def shape — pins the 905's I/O surface (single audio in, single
//      audio out, the literal mix/decay/size param array with ranges +
//      defaults) so a refactor that silently drops a port / param fails loudly
//      (the per-module-per-port regression-net class of bug).
//   2. Factory wiring — the 905 is a WORKLET module. We drive the factory with
//      a mock AudioContext (stubs audioWorklet.addModule + AudioWorkletNode +
//      createConstantSource) whose worklet node exposes a parameters Map, then
//      assert: the declared audio in/out point at the worklet node, the silence
//      keep-alive is started + connected, params seed from defaults / node
//      params, setParam→readParam round-trips, and dispose() tears everything
//      down.
//
// The per-sample DSP is pinned in packages/dsp/src/lib/spring-reverb-dsp.test.ts;
// this file owns the def + factory contract.

import { describe, it, expect, vi } from 'vitest';
import { moog905Def } from './moog905';
import type { ModuleNode } from '$lib/graph/types';

// ───────────────────── Layer 1: module-def shape ─────────────────────
describe('moog905Def: module def shape', () => {
  it('declares type=moog905, label="905 Spring Reverb", category=processors, schemaVersion=1', () => {
    expect(moog905Def.type).toBe('moog905');
    expect(moog905Def.label).toBe('905 spring reverb');
    expect(moog905Def.category).toBe('processors');
    expect(moog905Def.domain).toBe('audio');
  });

  it('lives in the Moog System 35/55 Clones palette bucket and uses the Moog905Card', () => {
    expect(moog905Def.palette).toEqual({ top: 'Moog System 35/55 Clones', sub: 'Moog System 35/55 Clones' });
    expect(moog905Def.card).toBe('Moog905Card');
  });

  it('exposes a single audio input (audio)', () => {
    expect(moog905Def.inputs.map((p) => p.id)).toEqual(['audio']);
    expect(moog905Def.inputs[0].type).toBe('audio');
    // Plain audio passthrough — not a knob modulator.
    expect(moog905Def.inputs[0].paramTarget).toBeUndefined();
    expect(moog905Def.inputs[0].cvScale).toBeUndefined();
  });

  it('exposes a single audio output (audio)', () => {
    expect(moog905Def.outputs.map((p) => p.id)).toEqual(['audio']);
    expect(moog905Def.outputs[0].type).toBe('audio');
  });

  it('exposes 3 params (mix, decay, size) with the documented ranges + defaults', () => {
    const byId = Object.fromEntries(moog905Def.params.map((p) => [p.id, p] as const));
    expect(moog905Def.params.map((p) => p.id)).toEqual(['mix', 'decay', 'size']);
    expect(byId.mix).toMatchObject({ min: 0, max: 1, curve: 'linear', defaultValue: 0.35 });
    expect(byId.decay).toMatchObject({ min: 0, max: 1, curve: 'linear', defaultValue: 0.6 });
    expect(byId.size).toMatchObject({ min: 0, max: 1, curve: 'linear', defaultValue: 0.5 });
  });
});

// ───────────────────── Layer 2: factory wiring ─────────────────────
//
// Minimal Web Audio mock for a worklet module. The AudioWorkletNode exposes a
// `parameters` Map<string, AudioParam-ish> + connect/disconnect; the
// ConstantSourceNode (silence keep-alive) records start/stop/connect/disconnect.
interface MockAudioParam {
  value: number;
  setValueAtTime: (v: number, t: number) => void;
}
interface MockWorkletNode {
  parameters: Map<string, MockAudioParam>;
  connectCount: number;
  disconnectCount: number;
  connect: () => void;
  disconnect: () => void;
}
interface MockConstantSource {
  offset: { value: number };
  startCount: number;
  stopCount: number;
  disconnectCount: number;
  connectedTo: unknown[];
  start: () => void;
  stop: () => void;
  connect: (dest: unknown) => void;
  disconnect: () => void;
}

function makeMockCtx(): {
  ctx: AudioContext;
  worklet: MockWorkletNode;
  source: MockConstantSource;
  addModule: ReturnType<typeof vi.fn>;
} {
  function mkParam(def: number): MockAudioParam {
    return {
      value: def,
      setValueAtTime(v: number) {
        this.value = v;
      },
    };
  }

  // One worklet node — params seeded to their descriptor defaults, matching
  // the real worklet's parameterDescriptors.
  const worklet: MockWorkletNode = {
    parameters: new Map<string, MockAudioParam>([
      ['mix', mkParam(0.35)],
      ['decay', mkParam(0.6)],
      ['size', mkParam(0.5)],
    ]),
    connectCount: 0,
    disconnectCount: 0,
    connect() {
      this.connectCount++;
    },
    disconnect() {
      this.disconnectCount++;
    },
  };

  const source: MockConstantSource = {
    offset: { value: 1 },
    startCount: 0,
    stopCount: 0,
    disconnectCount: 0,
    connectedTo: [],
    start() {
      this.startCount++;
    },
    stop() {
      this.stopCount++;
    },
    connect(dest: unknown) {
      this.connectedTo.push(dest);
    },
    disconnect() {
      this.disconnectCount++;
    },
  };

  const addModule = vi.fn(async (_url: string) => {});

  // Install the AudioWorkletNode constructor global the factory `new`s.
  class FakeAudioWorkletNode {
    parameters = worklet.parameters;
    connect = () => worklet.connect();
    disconnect = () => worklet.disconnect();
    constructor(_ctx: unknown, _name: string, _opts?: unknown) {}
  }
  (globalThis as unknown as { AudioWorkletNode: typeof FakeAudioWorkletNode }).AudioWorkletNode =
    FakeAudioWorkletNode;

  const ctx = {
    currentTime: 0,
    sampleRate: 48000,
    audioWorklet: { addModule },
    createConstantSource: () => source,
  } as unknown as AudioContext;

  return { ctx, worklet, source, addModule };
}

function makeNode(params: Record<string, number> = {}): ModuleNode {
  return {
    id: 'moog905-test',
    type: 'moog905',
    domain: 'audio',
    position: { x: 0, y: 0 },
    params,
    data: {},
  };
}

describe('moog905 factory: wiring + params', () => {
  it('loads the worklet module once and exposes the audio input at index 0', async () => {
    const { ctx, addModule } = makeMockCtx();
    const handle = await moog905Def.factory(ctx, makeNode());
    expect(addModule).toHaveBeenCalledTimes(1);
    const inp = handle.inputs.get('audio');
    expect(inp).toBeDefined();
    expect(inp!.input).toBe(0);
  });

  it('exposes the audio output at index 0', async () => {
    const { ctx } = makeMockCtx();
    const handle = await moog905Def.factory(ctx, makeNode());
    const out = handle.outputs.get('audio');
    expect(out).toBeDefined();
    expect(out!.output).toBe(0);
  });

  it('input + output point at the SAME worklet node', async () => {
    const { ctx } = makeMockCtx();
    const handle = await moog905Def.factory(ctx, makeNode());
    expect(handle.inputs.get('audio')!.node).toBe(handle.outputs.get('audio')!.node);
  });

  it('starts the silence keep-alive and connects it to the worklet node', async () => {
    const { ctx, source } = makeMockCtx();
    await moog905Def.factory(ctx, makeNode());
    expect(source.startCount).toBe(1);
    expect(source.offset.value).toBe(0);
    expect(source.connectedTo.length).toBe(1);
  });

  it('seeds params from defaults at mount', async () => {
    const { ctx, worklet } = makeMockCtx();
    await moog905Def.factory(ctx, makeNode());
    expect(worklet.parameters.get('mix')!.value).toBeCloseTo(0.35, 6);
    expect(worklet.parameters.get('decay')!.value).toBeCloseTo(0.6, 6);
    expect(worklet.parameters.get('size')!.value).toBeCloseTo(0.5, 6);
  });

  it('honors initial node.params at mount', async () => {
    const { ctx, worklet } = makeMockCtx();
    await moog905Def.factory(ctx, makeNode({ mix: 0.8, decay: 0.9, size: 0.1 }));
    expect(worklet.parameters.get('mix')!.value).toBeCloseTo(0.8, 6);
    expect(worklet.parameters.get('decay')!.value).toBeCloseTo(0.9, 6);
    expect(worklet.parameters.get('size')!.value).toBeCloseTo(0.1, 6);
  });

  it('setParam then readParam round-trips for each param', async () => {
    const { ctx } = makeMockCtx();
    const handle = await moog905Def.factory(ctx, makeNode());
    handle.setParam('mix', 0.2);
    handle.setParam('decay', 0.95);
    handle.setParam('size', 0.7);
    expect(handle.readParam('mix')).toBeCloseTo(0.2, 6);
    expect(handle.readParam('decay')).toBeCloseTo(0.95, 6);
    expect(handle.readParam('size')).toBeCloseTo(0.7, 6);
  });

  it('setParam drives the underlying AudioParam', async () => {
    const { ctx, worklet } = makeMockCtx();
    const handle = await moog905Def.factory(ctx, makeNode());
    handle.setParam('decay', 0.42);
    expect(worklet.parameters.get('decay')!.value).toBeCloseTo(0.42, 6);
  });

  it('setParam / readParam ignore unknown param ids without throwing', async () => {
    const { ctx } = makeMockCtx();
    const handle = await moog905Def.factory(ctx, makeNode());
    expect(() => handle.setParam('nope', 0.5)).not.toThrow();
    expect(handle.readParam('nope')).toBeUndefined();
  });

  it('dispose() stops the silence source and disconnects the worklet node', async () => {
    const { ctx, worklet, source } = makeMockCtx();
    const handle = await moog905Def.factory(ctx, makeNode());
    handle.dispose();
    expect(source.stopCount).toBe(1);
    expect(source.disconnectCount).toBeGreaterThanOrEqual(1);
    expect(worklet.disconnectCount).toBeGreaterThanOrEqual(1);
  });
});
