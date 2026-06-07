// packages/web/src/lib/audio/modules/polyhelm.test.ts
//
// Unit tests for the POLYHELM module's host-side def + bridge. The synth DSP
// runs in an AudioWorklet (real-browser only); here we mock AudioContext +
// AudioWorkletNode to verify the def shape, the I/O port wiring (esp. the POLY
// input on input slot 0), and that the MIDI / sequencer bridge posts the right
// messages to the worklet. The voice-allocator + poly→voices + release-holds-
// pitch math is proven directly against the engine in
// packages/dsp/src/lib/helm-engine.test.ts.

import { describe, it, expect, vi } from 'vitest';
import { polyhelmDef } from './polyhelm';
import { helmDef } from './helm';
import type { ModuleNode } from '$lib/graph/types';

// ---------------- module-def shape ----------------

describe('polyhelmDef: shape', () => {
  it('is type=polyhelm, label=polyhelm, in the VCOs palette alongside HELM', () => {
    expect(polyhelmDef.type).toBe('polyhelm');
    expect(polyhelmDef.label).toBe('polyhelm');
    expect(polyhelmDef.domain).toBe('audio');
    expect(polyhelmDef.palette).toEqual({ top: 'Audio modules', sub: 'VCOs' });
    // Same palette bucket as HELM.
    expect(polyhelmDef.palette).toEqual(helmDef.palette);
  });

  it('declares POLY (polyPitchGate) as the first input, plus the HELM mono fallbacks', () => {
    const ins = polyhelmDef.inputs;
    expect(ins[0]).toEqual({ id: 'poly', type: 'polyPitchGate' });
    const byId = Object.fromEntries(ins.map((p) => [p.id, p.type] as const));
    expect(byId).toEqual({
      poly: 'polyPitchGate',
      pitch_cv: 'cv',
      gate: 'gate',
      midi_in: 'cv',
      seq_reset: 'gate',
    });
  });

  it('outputs stereo out_l / out_r (audio)', () => {
    expect(polyhelmDef.outputs).toEqual([
      { id: 'out_l', type: 'audio' },
      { id: 'out_r', type: 'audio' },
    ]);
  });

  it('keeps HELM\'s FULL param set (not a stripped variant)', () => {
    const polyIds = polyhelmDef.params.map((p) => p.id).sort();
    const helmIds = helmDef.params.map((p) => p.id).sort();
    expect(polyIds).toEqual(helmIds);
    // Spot-check a few defaults match HELM exactly.
    const byId = Object.fromEntries(polyhelmDef.params.map((p) => [p.id, p] as const));
    expect(byId.voiceCount).toMatchObject({ min: 1, max: 8, defaultValue: 6, curve: 'discrete' });
    expect(byId.filterCutoff).toMatchObject({ min: 20, max: 20000, curve: 'log' });
    expect(byId.spread).toMatchObject({ min: 0, max: 1, defaultValue: 0.3 });
  });

  it('tags Matt Tytel OSS attribution (GPL-3.0 lineage)', () => {
    expect(polyhelmDef.ossAttribution).toEqual({ author: 'Matt Tytel' });
  });
});

// ---------------- factory port-wiring + bridge ----------------

interface PostedMessage { type: string; [k: string]: unknown }

function makeMockEnv() {
  const posted: PostedMessage[] = [];
  const portMock = {
    postMessage: vi.fn((m: PostedMessage) => { posted.push(m); }),
    onmessage: null as unknown,
    close: vi.fn(),
  };
  const paramSet = new Map<string, { setValueAtTime: (v: number, t: number) => void; value: number }>();
  for (const def of polyhelmDef.params) {
    paramSet.set(def.id, {
      setValueAtTime: vi.fn(function (this: { value: number }, v: number) { this.value = v; }) as never,
      value: 0,
    });
  }
  let lastWorkletOpts: { numberOfInputs?: number; numberOfOutputs?: number; outputChannelCount?: number[] } = {};
  class FakeAudioWorkletNode {
    port = portMock;
    parameters = { get: (k: string) => paramSet.get(k) };
    disconnect = vi.fn();
    connect = vi.fn();
    constructor(_ctx: unknown, _name: string, opts?: unknown) {
      lastWorkletOpts = (opts ?? {}) as typeof lastWorkletOpts;
    }
  }
  const splitterMock = { disconnect: vi.fn() };
  const ctx = {
    audioWorklet: { addModule: vi.fn(async () => {}) },
    currentTime: 0,
    createChannelSplitter: vi.fn(() => splitterMock),
  };
  (globalThis as unknown as { AudioWorkletNode: typeof FakeAudioWorkletNode }).AudioWorkletNode = FakeAudioWorkletNode;
  return { posted, ctx, paramSet, splitterMock, getWorkletOpts: () => lastWorkletOpts };
}

function makeNode(params?: Record<string, number>, data?: Record<string, unknown>): ModuleNode {
  return {
    id: 'ph-test',
    type: 'polyhelm',
    domain: 'audio',
    position: { x: 0, y: 0 },
    params: params ?? {},
    data: data ?? {},
  };
}

describe('polyhelmDef: factory port wiring', () => {
  it('builds a 5-input / stereo-output worklet node', async () => {
    const { ctx, getWorkletOpts } = makeMockEnv();
    await polyhelmDef.factory(ctx as unknown as AudioContext, makeNode());
    const opts = getWorkletOpts();
    expect(opts.numberOfInputs).toBe(5);
    expect(opts.numberOfOutputs).toBe(1);
    expect(opts.outputChannelCount).toEqual([2]);
  });

  it('maps POLY → input 0, the mono fallbacks → 1..4, and out_l/out_r → splitter 0/1', async () => {
    const { ctx } = makeMockEnv();
    const handle = await polyhelmDef.factory(ctx as unknown as AudioContext, makeNode());
    expect(handle.inputs?.get('poly')?.input).toBe(0);
    expect(handle.inputs?.get('pitch_cv')?.input).toBe(1);
    expect(handle.inputs?.get('gate')?.input).toBe(2);
    expect(handle.inputs?.get('midi_in')?.input).toBe(3);
    expect(handle.inputs?.get('seq_reset')?.input).toBe(4);
    expect(handle.outputs?.get('out_l')?.output).toBe(0);
    expect(handle.outputs?.get('out_r')?.output).toBe(1);
  });

  it('applies initial param values from node.params', async () => {
    const { ctx, paramSet } = makeMockEnv();
    await polyhelmDef.factory(ctx as unknown as AudioContext, makeNode({ voiceCount: 8, filterCutoff: 2000 }));
    expect(paramSet.get('voiceCount')?.setValueAtTime).toHaveBeenCalledWith(8, 0);
    expect(paramSet.get('filterCutoff')?.setValueAtTime).toHaveBeenCalledWith(2000, 0);
  });
});

describe('polyhelmDef: sequencer + MIDI bridge (via card-api)', () => {
  it('posts the persisted seqOn state to the worklet on factory init', async () => {
    const { posted, ctx } = makeMockEnv();
    await polyhelmDef.factory(ctx as unknown as AudioContext, makeNode({}, { seqOn: true }));
    const seqMsg = posted.find((m) => m.type === 'set-seq-on');
    expect(seqMsg).toBeDefined();
    expect(seqMsg?.on).toBe(true);
  });

  it('card-api setSeqOn / resetSeq / setSteps post the right worklet messages', async () => {
    const { posted, ctx } = makeMockEnv();
    const handle = await polyhelmDef.factory(ctx as unknown as AudioContext, makeNode());
    const api = handle.read?.('card-api') as {
      setSeqOn(on: boolean): void; resetSeq(): void; setSteps(s: number[]): void;
    };
    expect(api).toBeTruthy();
    const before = posted.length;
    api.setSeqOn(true);
    api.resetSeq();
    api.setSteps([0.5, -0.5, 1]);
    const after = posted.slice(before);
    expect(after.find((m) => m.type === 'set-seq-on' && m.on === true)).toBeTruthy();
    expect(after.find((m) => m.type === 'seq-reset')).toBeTruthy();
    const stepsMsg = after.find((m) => m.type === 'set-steps');
    expect(stepsMsg?.steps).toEqual([0.5, -0.5, 1]);
  });

  it('dispose tears down the worklet + splitter without throwing', async () => {
    const { ctx, splitterMock } = makeMockEnv();
    const handle = await polyhelmDef.factory(ctx as unknown as AudioContext, makeNode());
    expect(() => handle.dispose?.()).not.toThrow();
    expect(splitterMock.disconnect).toHaveBeenCalled();
  });
});
