// packages/web/src/lib/audio/engine-gate-input.test.ts
//
// Coverage for PatchEngine.setGateInput / pulseGateInput — the MIDI-assign
// gate-input injection path (WORKSTREAM B). A MIDI NOTE-on/off on a gate input
// resolves the port's paramTarget and drives setParam(target, 1|0) on the owning
// engine — REUSING the exact same-domain gate-edge mechanism. A gate input with
// NO paramTarget is a no-op (warn-once).
//
// We register a fake audio module def with two gate inputs (one routed via
// paramTarget, one bare) and drive a REAL AudioEngine + PatchEngine, so the
// resolution goes through the real registry + AudioEngine.resolvePortParamTarget.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AudioEngine, PatchEngine } from './engine';
import type { AudioModuleDef } from './module-registry';
import { registerModule } from './module-registry';
import type { ModuleNode } from '$lib/graph/types';

function makeFakeNode(): {
  connect: () => void;
  disconnect: () => void;
} {
  return { connect() { /* */ }, disconnect() { /* */ } };
}

function makeFakeAudioContext(): AudioContext {
  return {
    currentTime: 0,
    sampleRate: 48000,
    createGain() { return { ...makeFakeNode(), gain: { value: 1 } }; },
  } as unknown as AudioContext;
}

/** Records every setParam the handle receives so the test can assert the
 *  resolved param + value sequence. */
const setParamCalls: Array<{ paramId: string; value: number }> = [];

const GATE_TARGET_DEF: AudioModuleDef = {
  type: 'gateInputTestModule',
  domain: 'audio',
  label: 'gateinputtest',
  category: 'utility',
  schemaVersion: 1,
  inputs: [
    // A gate input that DOES route to a param (mirrors a play_cv → isPlaying).
    { id: 'play_cv', type: 'gate', paramTarget: 'isPlaying' },
    // A bare gate input with NO paramTarget (a pure AudioNode gate input).
    { id: 'bare_gate', type: 'gate' },
  ],
  outputs: [],
  params: [
    { id: 'isPlaying', label: 'play', min: 0, max: 1, defaultValue: 0, curve: 'linear' },
  ],
  async factory(_ctx, _node) {
    return {
      domain: 'audio' as const,
      inputs: new Map(),
      outputs: new Map(),
      setParam(paramId, value) { setParamCalls.push({ paramId, value }); },
      readParam() { return undefined; },
      dispose() { /* */ },
    };
  },
};

let registered = false;
function ensureRegistered(): void {
  if (registered) return;
  registerModule(GATE_TARGET_DEF);
  registered = true;
}

async function setup() {
  const ae = new AudioEngine(makeFakeAudioContext());
  const pe = new PatchEngine();
  pe.registerDomain(ae);
  const node: ModuleNode = {
    id: 'gate-1',
    type: 'gateInputTestModule',
    domain: 'audio',
    position: { x: 0, y: 0 },
    params: {},
  };
  await ae.addNode(node);
  return { pe, ae };
}

describe('PatchEngine.setGateInput / pulseGateInput', () => {
  beforeEach(() => {
    ensureRegistered();
    setParamCalls.length = 0;
  });

  it('setGateInput(high=true) resolves the paramTarget and sets it to 1', async () => {
    const { pe } = await setup();
    const drove = pe.setGateInput('gate-1', 'play_cv', true);
    expect(drove).toBe(true);
    expect(setParamCalls).toEqual([{ paramId: 'isPlaying', value: 1 }]);
  });

  it('setGateInput(high=false) sets the resolved param to 0 (momentary release)', async () => {
    const { pe } = await setup();
    pe.setGateInput('gate-1', 'play_cv', true);
    pe.setGateInput('gate-1', 'play_cv', false);
    expect(setParamCalls).toEqual([
      { paramId: 'isPlaying', value: 1 },
      { paramId: 'isPlaying', value: 0 },
    ]);
  });

  it('pulseGateInput sets 1 then 0 on the next tick (trigger pulse shape)', async () => {
    vi.useFakeTimers();
    try {
      const { pe } = await setup();
      const drove = pe.pulseGateInput('gate-1', 'play_cv');
      expect(drove).toBe(true);
      expect(setParamCalls).toEqual([{ paramId: 'isPlaying', value: 1 }]);
      vi.runAllTimers(); // fire the setTimeout(0) fall
      expect(setParamCalls).toEqual([
        { paramId: 'isPlaying', value: 1 },
        { paramId: 'isPlaying', value: 0 },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a bare gate input (no paramTarget) is a no-op + warns once', async () => {
    const { pe } = await setup();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(pe.setGateInput('gate-1', 'bare_gate', true)).toBe(false);
      expect(pe.setGateInput('gate-1', 'bare_gate', false)).toBe(false);
      expect(pe.pulseGateInput('gate-1', 'bare_gate')).toBe(false);
      expect(setParamCalls).toEqual([]);
      // Warn-once: one warning for the (node,port) key across all three calls.
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('an unknown node is a no-op (returns false)', async () => {
    const { pe } = await setup();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(pe.setGateInput('nope', 'play_cv', true)).toBe(false);
      expect(setParamCalls).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });
});
