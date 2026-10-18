import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioEngine, type AudioDomainNodeHandle } from '$lib/audio/engine';
import { getModuleDef, registerModule, type AudioModuleDef } from '$lib/audio/module-registry';
import type { ModuleNode } from '$lib/graph/types';
import { mutateNode } from '$lib/graph/mutate';
import { patch, ydoc, undoManager } from '$lib/graph/store';
import { __resetDefaultSnapshotBusForTest, getDefaultSnapshotBus } from '$lib/graph/snapshot';
import { phasesDef, type PhasesRuntimeState } from './phases';
import { setPhasesRuntimeMode } from '$lib/audio/phases-runtime';
import {
  PHASES_DEFAULT_VERTICES,
  PHASES_LENGTH_DEFAULT,
  PHASES_LENGTH_MAX,
  PHASES_LENGTH_MIN,
  type PhasesVertex,
} from '../../../../../dsp/src/lib/phases-dsp';

// Drives the real factory and real Yjs data delivery. Worklet signal behavior
// is covered by the DSP and browser tests; this catches broken factory wiring.
class FakeParam {
  constructor(public value: number) {}
  setValueAtTime = vi.fn((value: number, _time: number) => {
    this.value = value;
    return this;
  });
}

class FakeWorklet {
  static all: FakeWorklet[] = [];
  port = {
    postMessage: vi.fn(),
    close: vi.fn(),
    onmessage: null as null | ((event: MessageEvent) => void),
  };
  parameters: Map<string, FakeParam>;
  disconnect = vi.fn();
  addEventListener = vi.fn();

  constructor(_ctx: AudioContext, public name: string, public options: AudioWorkletNodeOptions) {
    this.parameters = new Map(Object.entries(options.parameterData ?? {})
      .map(([id, value]) => [id, new FakeParam(value)]));
    FakeWorklet.all.push(this);
  }

  emit(overrides: Partial<PhasesRuntimeState>): PhasesRuntimeState {
    const lastMode = this.messages('mode').at(-1) as { revision: number } | undefined;
    const state: PhasesRuntimeState = {
      type: 'state', position: 0.3, playing: true, loop: false, reverse: false,
      effectiveLength: 1.2, lengthCvPatched: false, modeRevision: lastMode?.revision ?? 0, ...overrides,
    };
    this.port.onmessage?.({ data: state } as MessageEvent);
    return state;
  }

  messages(type: string): unknown[] {
    return this.port.postMessage.mock.calls.map(([message]) => message)
      .filter((message) => message.type === type);
  }
}

function context(): AudioContext {
  return {
    currentTime: 1,
    audioWorklet: { addModule: vi.fn(async () => {}) },
    // A keepalive connected to input 4 would make unpatched Length read as 0 CV.
    createConstantSource: vi.fn(() => { throw new Error('Phases must not pin an input'); }),
    createGain: vi.fn(() => { throw new Error('Phases must not hide CV cable absence'); }),
  } as unknown as AudioContext;
}

function node(overrides: Partial<ModuleNode> = {}): ModuleNode {
  return {
    id: 'phases-factory-test', type: 'phases', domain: 'audio',
    params: {}, position: { x: 0, y: 0 }, ...overrides,
  };
}

const handles: AudioDomainNodeHandle[] = [];
async function create(n = node(), ctx = context()): Promise<AudioDomainNodeHandle> {
  const handle = await phasesDef.factory(ctx, n);
  handles.push(handle);
  return handle;
}

beforeEach(() => {
  vi.stubGlobal('AudioWorkletNode', FakeWorklet);
  FakeWorklet.all = [];
  for (const id of Object.keys(patch.nodes)) delete patch.nodes[id];
  for (const id of Object.keys(patch.edges)) delete patch.edges[id];
  undoManager.clear();
  __resetDefaultSnapshotBusForTest();
});

afterEach(() => {
  for (const handle of handles.splice(0)) handle.dispose();
  __resetDefaultSnapshotBusForTest();
  for (const id of Object.keys(patch.nodes)) delete patch.nodes[id];
  undoManager.clear();
  vi.unstubAllGlobals();
});

describe('Phases factory', () => {
  it('pins the published Length range to DSP and loads the processor once per context', async () => {
    expect(phasesDef.params.find((p) => p.id === 'length')).toMatchObject({
      min: PHASES_LENGTH_MIN, max: PHASES_LENGTH_MAX, defaultValue: PHASES_LENGTH_DEFAULT,
    });
    const ctx = context();
    const a = await create(node(), ctx);
    const b = await create(node({ id: 'phases-second', params: { length: 7, loop: 1 } }), ctx);
    expect(ctx.audioWorklet.addModule).toHaveBeenCalledTimes(1);
    expect(FakeWorklet.all[0].name).toBe('phases');
    expect(FakeWorklet.all[0].options).toMatchObject({
      numberOfInputs: 5, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1,
    });
    expect(a.readParam('length')).toBe(PHASES_LENGTH_DEFAULT);
    expect(b.readParam('length')).toBe(7);
    expect(b.readParam('loop')).toBe(1);
    expect(FakeWorklet.all[0].messages('vertices')).toEqual([
      { type: 'vertices', vertices: PHASES_DEFAULT_VERTICES },
    ]);
  });

  it('maps every jack to the correct worklet index and leaves Length CV raw and unpinned', async () => {
    const handle = await create();
    const worklet = FakeWorklet.all[0];
    const ids = ['trigger', 'phase_trigger', 'loop', 'reverse', 'length_cv'];
    expect(phasesDef.inputs.map((p) => p.id)).toEqual(ids);
    expect([...handle.inputs.keys()]).toEqual(ids);
    for (const [index, id] of ids.entries()) {
      expect(handle.inputs.get(id)).toEqual({ node: worklet, input: index });
    }
    expect(phasesDef.inputs.find((p) => p.id === 'length_cv')).not.toHaveProperty('paramTarget');
    expect(phasesDef.inputs.find((p) => p.id === 'length_cv')).not.toHaveProperty('cvScale');
    expect(handle.outputs.get('phase_cv')).toEqual({ node: worklet, output: 0 });
    expect([...handle.outputs.keys()]).toEqual(phasesDef.outputs.map((p) => p.id));
    expect(phasesDef.inputs.filter((p) => p.type === 'gate').every((p) => p.edge === 'trigger')).toBe(true);
  });

  it('delivers nested edits, undo, and same-id reloads to the worklet without a mounted editor', async () => {
    const initial: PhasesVertex[] = [
      { x: 0, y: 0, shape: 0.3 }, { x: 0.4, y: 0.8, shape: 0.9 }, { x: 1, y: 0.2, shape: 0 },
    ];
    patch.nodes['phases-factory-test'] = node({ data: { vertices: initial } });
    await create(patch.nodes['phases-factory-test'] as ModuleNode);
    const worklet = FakeWorklet.all[0];
    expect(worklet.messages('vertices')).toEqual([{ type: 'vertices', vertices: initial }]);
    undoManager.clear();
    undoManager.stopCapturing();
    mutateNode('phases-factory-test', (live) => {
      (live.data!.vertices as PhasesVertex[])[1].y = 0.6;
    });
    expect(worklet.messages('vertices').at(-1)).toEqual({
      type: 'vertices', vertices: [initial[0], { ...initial[1], y: 0.6 }, initial[2]],
    });
    undoManager.undo();
    expect(worklet.messages('vertices').at(-1)).toEqual({ type: 'vertices', vertices: initial });

    const count = worklet.messages('vertices').length;
    mutateNode('phases-factory-test', (live) => { live.position.x = 23; });
    expect(worklet.messages('vertices')).toHaveLength(count);

    const replacement = [{ x: 0, y: 1, shape: 0.5 }, { x: 1, y: 0, shape: 0 }];
    ydoc.transact(() => {
      delete patch.nodes['phases-factory-test'];
      patch.nodes['phases-factory-test'] = node({ data: { vertices: replacement } });
    });
    expect(patch.nodes['phases-factory-test']?.data?.vertices).toEqual(replacement);
    expect(getDefaultSnapshotBus().current().nodes.find((n) => n.id === 'phases-factory-test')?.data?.vertices)
      .toEqual(replacement);
    expect(worklet.messages('vertices').at(-1)).toEqual({ type: 'vertices', vertices: replacement });
    expect(FakeWorklet.all).toHaveLength(1);
  });

  it('uses telemetry for playback, modes and patched Length, then restores manual Length on unpatch', async () => {
    const handle = await create();
    const worklet = FakeWorklet.all[0];
    const state = worklet.emit({ loop: true, reverse: true, effectiveLength: 30, lengthCvPatched: true });
    expect(handle.read?.('state')).toEqual(state);
    expect(handle.readParam('loop')).toBe(1);
    expect(handle.readParam('reverse')).toBe(1);
    expect(handle.readParam('length')).toBe(30);
    handle.setParam('length', 2);
    expect(worklet.parameters.get('length')?.value).toBe(2);
    expect(handle.readParam('length'), 'a knob write must not replace the CV readout').toBe(30);
    worklet.emit({ effectiveLength: 9, lengthCvPatched: false });
    expect(handle.readParam('length'), 'an unpatched readout follows the manual parameter').toBe(2);
    handle.setParam('length', 3);
    expect(handle.readParam('length')).toBe(3);
    handle.setParam('polarity', 1);
    expect(handle.readParam('polarity')).toBe(1);
    expect(handle.read?.('unknown')).toBeUndefined();
  });

  it('keeps the latest manual Length through stale unpatched frames and CV patch/unpatch ordering', async () => {
    const handle = await create(node({ params: { length: 2 } }));
    const worklet = FakeWorklet.all[0];
    expect(handle.readEffectiveParam?.('length')).toBe(2);
    handle.setParam('length', 3);
    worklet.emit({ effectiveLength: 2, lengthCvPatched: false, playing: false });
    expect(handle.readParam('length'), 'a queued pre-write frame cannot undo the knob while suspended').toBe(3);
    expect(handle.readEffectiveParam?.('length')).toBe(3);

    worklet.emit({ effectiveLength: 30, lengthCvPatched: true });
    handle.setParam('length', 4);
    expect(handle.readParam('length'), 'patched CV keeps priority over a newer manual value').toBe(30);
    worklet.emit({ effectiveLength: 0.05, lengthCvPatched: true });
    expect(handle.readParam('length')).toBe(0.05);
    worklet.emit({ effectiveLength: 3, lengthCvPatched: false });
    expect(handle.readParam('length'), 'unpatch immediately reveals the latest manual value').toBe(4);
    expect(worklet.parameters.get('length')?.value).toBe(4);
  });

  it('forwards every explicit mode action after a gate changed the effective mode', async () => {
    const handle = await create();
    const worklet = FakeWorklet.all[0];
    worklet.emit({ loop: true, reverse: true });
    handle.setParam('loop', 0); // Stored AudioParam was already 0.
    expect(worklet.messages('mode')).toEqual([{ type: 'mode', name: 'loop', value: false, revision: 1 }]);
    expect(handle.readParam('loop')).toBe(0);
    expect(setPhasesRuntimeMode('phases-factory-test', 'reverse', false)).toBe(true);
    expect(worklet.messages('mode').at(-1)).toEqual({ type: 'mode', name: 'reverse', value: false, revision: 2 });
    expect(handle.readParam('reverse')).toBe(0);
    handle.write?.('mode', { name: 'loop', value: true });
    expect(worklet.messages('mode').at(-1)).toEqual({ type: 'mode', name: 'loop', value: true, revision: 3 });
    handle.write?.('trigger', null);
    handle.write?.('phaseTrigger', null);
    expect(worklet.messages('trigger')).toEqual([{ type: 'trigger' }]);
    expect(worklet.messages('phase-trigger')).toEqual([{ type: 'phase-trigger' }]);
  });

  it('removes graph delivery and imperative mode actions when disposed', async () => {
    patch.nodes['phases-factory-test'] = node();
    const handle = await create(patch.nodes['phases-factory-test'] as ModuleNode);
    const worklet = FakeWorklet.all[0];
    handle.dispose();
    const calls = worklet.port.postMessage.mock.calls.length;
    mutateNode('phases-factory-test', (live) => {
      live.data = { vertices: [{ x: 0, y: 1, shape: 0 }, { x: 1, y: 1, shape: 0 }] };
    });
    handle.write?.('trigger', null);
    handle.setParam('reverse', 1);
    expect(setPhasesRuntimeMode('phases-factory-test', 'loop', true)).toBe(false);
    expect(worklet.port.postMessage).toHaveBeenCalledTimes(calls);
    expect(worklet.port.onmessage).toBeNull();
    expect(worklet.messages('dispose')).toEqual([{ type: 'dispose' }]);
    expect(worklet.port.close).toHaveBeenCalledOnce();
    expect(worklet.disconnect).toHaveBeenCalledOnce();
  });

  it('keeps the surviving mode action when a duplicate in-flight factory is disposed', async () => {
    const original = await create();
    const duplicate = await create();
    duplicate.dispose();
    expect(setPhasesRuntimeMode('phases-factory-test', 'loop', true)).toBe(true);
    expect(original.readParam('loop')).toBe(1);
    expect(FakeWorklet.all[0].messages('mode')).toEqual([{ type: 'mode', name: 'loop', value: true, revision: 1 }]);
    expect(FakeWorklet.all[1].messages('mode')).toEqual([]);
  });

  it('holds manual mode intent until its telemetry acknowledgement, then follows gate changes', async () => {
    const handle = await create();
    const worklet = FakeWorklet.all[0];
    worklet.emit({ loop: true, reverse: false, modeRevision: 0 });
    handle.setParam('loop', 0);
    worklet.emit({ loop: true, reverse: false, modeRevision: 0, position: 0.45 });
    expect(handle.readParam('loop')).toBe(0);
    expect(handle.read?.('state')).toMatchObject({ position: 0.45 });
    handle.setParam('reverse', 1);
    worklet.emit({ loop: false, reverse: false, modeRevision: 1 });
    expect(handle.readParam('loop')).toBe(0);
    expect(handle.readParam('reverse')).toBe(1);
    worklet.emit({ loop: false, reverse: true, modeRevision: 2 });
    expect(handle.readParam('reverse')).toBe(1);
    worklet.emit({ loop: true, reverse: false, modeRevision: 2 });
    expect(handle.readParam('loop')).toBe(1);
    expect(handle.readParam('reverse')).toBe(0);
  });

  it('carries effective Phases values through AudioEngine while ordinary knobs keep their cached values', async () => {
    if (!getModuleDef('phases')) registerModule(phasesDef);
    const ordinary: AudioModuleDef = {
      type: 'phases-test-ordinary-knob', domain: 'audio', label: 'Ordinary', category: 'utilities',
      inputs: [], outputs: [],
      params: [{ id: 'level', label: 'Level', defaultValue: 0.5, min: 0, max: 1, curve: 'linear' }],
      async factory() {
        return {
          domain: 'audio', inputs: new Map(), outputs: new Map(),
          setParam() {}, readParam: () => -99, dispose() {},
        };
      },
    };
    registerModule(ordinary);
    const engine = new AudioEngine(context());
    try {
      const phases = node({ params: { length: 2, loop: 0, reverse: 0, polarity: 1 } });
      await engine.addNode(phases);
      const worklet = FakeWorklet.all[0];
      worklet.emit({ effectiveLength: 30, lengthCvPatched: true, loop: true, reverse: true });
      expect(engine.readParam(phases.id, 'length')).toBe(30);
      expect(engine.readParam(phases.id, 'loop')).toBe(1);
      expect(engine.readParam(phases.id, 'reverse')).toBe(1);
      expect(engine.readParam(phases.id, 'polarity')).toBe(1);
      engine.setParam(phases.id, 'length', 4);
      expect(engine.readParam(phases.id, 'length')).toBe(30);
      worklet.emit({ effectiveLength: 4, lengthCvPatched: false, loop: false, reverse: false });
      expect(engine.readParam(phases.id, 'length')).toBe(4);
      expect(engine.readParam(phases.id, 'loop')).toBe(0);

      const plain = node({ id: 'ordinary-knob', type: ordinary.type, params: { level: 0.7 } });
      await engine.addNode(plain);
      expect(engine.nodes.get(plain.id)?.readParam('level')).toBe(-99);
      expect(engine.readParam(plain.id, 'level')).toBe(0.7);
      engine.setParam(plain.id, 'level', 0.8);
      expect(engine.readParam(plain.id, 'level')).toBe(0.8);
    } finally {
      engine.dispose();
    }
  });
});
