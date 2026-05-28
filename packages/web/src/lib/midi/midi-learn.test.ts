// packages/web/src/lib/midi/midi-learn.test.ts
//
// Unit tests for the MIDI Learn singleton. Uses the MidiAccessLike /
// MidiInputLike / MidiEventLike injection seam from midi-cv-buddy so we
// can drive incoming CC messages without a real Web MIDI device.

import { describe, it, expect, beforeEach } from 'vitest';
import { syncedStore, getYjsDoc } from '@syncedstore/core';
import type {
  MidiAccessLike,
  MidiInputLike,
  MidiEventLike,
} from '$lib/audio/modules/midi-cv-buddy';
import {
  beginLearn,
  cancelLearn,
  registerSetter,
  unregisterSetter,
  getBinding,
  clearBinding,
  bindingKey,
  ccValueToParamValue,
  parseCcMessage,
  importBindings,
  __test_setAccess,
  __test_clearBindings,
} from './midi-learn.svelte';
import { PatchEngine, type DomainEngine } from '$lib/audio/engine';
import { attachReconciler } from '$lib/audio/reconciler';
import { createSnapshotBus } from '$lib/graph/snapshot';
import type { ModuleNode, Edge } from '$lib/graph/types';

// ---------------- Tiny fake MIDIAccess ----------------

function makeFakeAccess(): { access: MidiAccessLike; sendCc: (channel: number, cc: number, value: number) => void } {
  let handler: ((ev: MidiEventLike) => void) | null = null;
  const input: MidiInputLike = {
    id: 'fake-input-0',
    name: 'Fake Controller',
    manufacturer: 'test',
    state: 'connected',
    get onmidimessage() { return handler; },
    set onmidimessage(h) { handler = h; },
  };
  const inputs = new Map<string, MidiInputLike>();
  inputs.set(input.id, input);
  const access: MidiAccessLike = { inputs, onstatechange: null };
  function sendCc(channel: number, cc: number, value: number) {
    if (!handler) return;
    handler({
      data: new Uint8Array([0xb0 | (channel & 0x0f), cc & 0x7f, value & 0x7f]),
      timeStamp: 0,
    });
  }
  return { access, sendCc };
}

beforeEach(() => {
  __test_clearBindings();
  __test_setAccess(null);
});

// ---------------- Pure helpers ----------------

describe('parseCcMessage', () => {
  it('parses a valid 0xB0..0xBF CC message', () => {
    const m = parseCcMessage(new Uint8Array([0xb0, 7, 64]));
    expect(m).toEqual({ channel: 0, cc: 7, value: 64 });
  });
  it('extracts channel from low nibble', () => {
    const m = parseCcMessage(new Uint8Array([0xb5, 11, 127]));
    expect(m?.channel).toBe(5);
  });
  it('returns null for non-CC status bytes', () => {
    expect(parseCcMessage(new Uint8Array([0x90, 60, 100]))).toBeNull(); // note-on
    expect(parseCcMessage(new Uint8Array([0xf0, 0, 0]))).toBeNull();    // sysex
  });
  it('returns null for short buffers', () => {
    expect(parseCcMessage(new Uint8Array([0xb0]))).toBeNull();
    expect(parseCcMessage(new Uint8Array([0xb0, 7]))).toBeNull();
  });
});

describe('ccValueToParamValue', () => {
  it('0 → min', () => {
    expect(ccValueToParamValue(0, -1, 1)).toBe(-1);
    expect(ccValueToParamValue(0, 100, 1000)).toBe(100);
  });
  it('127 → max', () => {
    expect(ccValueToParamValue(127, -1, 1)).toBe(1);
    expect(ccValueToParamValue(127, 0, 10)).toBe(10);
  });
  it('64 ≈ midpoint', () => {
    const mid = ccValueToParamValue(64, 0, 1);
    expect(mid).toBeCloseTo(0.504, 2);
  });
  it('clamps out-of-range inputs', () => {
    expect(ccValueToParamValue(-5, 0, 1)).toBe(0);
    expect(ccValueToParamValue(999, 0, 1)).toBe(1);
  });
});

describe('bindingKey', () => {
  it('composes moduleId:paramId', () => {
    expect(bindingKey('vca-1', 'base')).toBe('vca-1:base');
  });
});

// ---------------- Regression: load-order bug ----------------
//
// Before the setters-map decoupling, `registerSetter` only attached the
// setter if a binding already existed for the key. The Save/Load Local
// Performance flow mounts cards (registerSetter) BEFORE importBindings
// runs (the bindings arrive from the bundle), so setters were silently
// dropped → bindings looked persisted but CCs landed silently until the
// user re-learned (which goes through applyLearn, writing setter +
// binding together). Both orderings must now dispatch.
describe('regression: setter ↔ binding ordering on performance load', () => {
  const MOD = 'vca-1';
  const PARAM = 'base';
  const CH = 3;
  const CC = 42;

  it('dispatches when card mounts BEFORE bindings are imported (the load-order bug)', () => {
    const { access, sendCc } = makeFakeAccess();
    __test_setAccess(access);
    const received: number[] = [];
    registerSetter(MOD, PARAM, { min: 0, max: 1, onchange: (v) => received.push(v) });
    importBindings([{ key: bindingKey(MOD, PARAM), channel: CH, cc: CC, learnedAt: 1 }]);
    sendCc(CH, CC, 127);
    expect(received).toEqual([1]);
  });

  it('also dispatches when bindings are imported BEFORE the card mounts', () => {
    const { access, sendCc } = makeFakeAccess();
    __test_setAccess(access);
    const received: number[] = [];
    importBindings([{ key: bindingKey(MOD, PARAM), channel: CH, cc: CC, learnedAt: 1 }]);
    registerSetter(MOD, PARAM, { min: 0, max: 1, onchange: (v) => received.push(v) });
    sendCc(CH, CC, 0);
    expect(received).toEqual([0]);
  });

  it('unregisterSetter stops dispatch but keeps the binding for re-mount', () => {
    const { access, sendCc } = makeFakeAccess();
    __test_setAccess(access);
    const received: number[] = [];
    importBindings([{ key: bindingKey(MOD, PARAM), channel: CH, cc: CC, learnedAt: 1 }]);
    registerSetter(MOD, PARAM, { min: 0, max: 1, onchange: (v) => received.push(v) });
    sendCc(CH, CC, 64);
    expect(received).toHaveLength(1);
    unregisterSetter(MOD, PARAM);
    sendCc(CH, CC, 127);
    expect(received).toHaveLength(1); // no new dispatch
    expect(getBinding(MOD, PARAM)).toBeDefined(); // binding survives
    // Re-mount: setter rewires + CCs flow again.
    registerSetter(MOD, PARAM, { min: 0, max: 1, onchange: (v) => received.push(v) });
    sendCc(CH, CC, 0);
    expect(received).toHaveLength(2);
    expect(received[1]).toBe(0);
  });
});

// ---------------- Learn flow ----------------

describe('learn flow (capture next CC + bind)', () => {
  it('first CC after beginLearn becomes the binding', async () => {
    const { access, sendCc } = makeFakeAccess();
    __test_setAccess(access);
    let captured = -999;
    const onchange = (v: number) => { captured = v; };
    await beginLearn({ moduleId: 'vca-1', paramId: 'base', min: 0, max: 1, onchange });

    sendCc(/*ch*/ 3, /*cc*/ 22, /*value*/ 64);

    const b = getBinding('vca-1', 'base');
    expect(b).toBeDefined();
    expect(b?.channel).toBe(3);
    expect(b?.cc).toBe(22);
    // The captured value should also fire the setter immediately.
    expect(captured).toBeCloseTo(0.504, 2);
  });

  it('subsequent CCs on the same {channel,cc} drive the bound knob', async () => {
    const { access, sendCc } = makeFakeAccess();
    __test_setAccess(access);
    let captured = -1;
    const onchange = (v: number) => { captured = v; };
    await beginLearn({ moduleId: 'lfo-1', paramId: 'rate', min: 0, max: 100, onchange });
    sendCc(/*ch*/ 0, /*cc*/ 7, /*value*/ 0); // learn capture (sets to 0)
    expect(getBinding('lfo-1', 'rate')).toBeDefined();
    sendCc(0, 7, 127);
    expect(captured).toBe(100);
    sendCc(0, 7, 64);
    expect(captured).toBeCloseTo(50.4, 1);
  });

  it('CCs on a different channel/cc are ignored once bound', async () => {
    const { access, sendCc } = makeFakeAccess();
    __test_setAccess(access);
    const set1Values: number[] = [];
    const onchange = (v: number) => set1Values.push(v);
    await beginLearn({ moduleId: 'vca-1', paramId: 'base', min: 0, max: 1, onchange });
    sendCc(0, 7, 32); // learn captures channel 0, cc 7

    // Reset capture history (the learn pulse already appended one entry).
    set1Values.length = 0;

    sendCc(0, 8, 100);  // wrong cc
    sendCc(1, 7, 100);  // wrong channel
    expect(set1Values).toEqual([]);

    sendCc(0, 7, 100);  // matches
    expect(set1Values.length).toBe(1);
  });

  it('beginLearn cancels a prior in-flight learn', async () => {
    const { access, sendCc } = makeFakeAccess();
    __test_setAccess(access);
    const a = (v: number) => { void v; };
    const b = (v: number) => { void v; };
    await beginLearn({ moduleId: 'vca-1', paramId: 'base',     min: 0, max: 1, onchange: a });
    await beginLearn({ moduleId: 'lfo-1', paramId: 'rate',     min: 0, max: 1, onchange: b });
    // The second beginLearn replaces the first — the next CC binds to LFO, not VCA.
    sendCc(0, 9, 64);
    expect(getBinding('vca-1', 'base')).toBeUndefined();
    expect(getBinding('lfo-1', 'rate')).toBeDefined();
  });

  it('cancelLearn aborts the in-flight learn', async () => {
    const { access, sendCc } = makeFakeAccess();
    __test_setAccess(access);
    const onchange = (v: number) => { void v; };
    await beginLearn({ moduleId: 'vca-1', paramId: 'base', min: 0, max: 1, onchange });
    cancelLearn();
    sendCc(0, 7, 64);
    expect(getBinding('vca-1', 'base')).toBeUndefined();
  });
});

// ---------------- registerSetter / unregisterSetter / clearBinding ----------------

describe('setter lifecycle', () => {
  it('registerSetter on an already-bound key wires CCs to the live setter', async () => {
    // Simulate a fresh page load with a binding in the store but no card mounted yet.
    const { access, sendCc } = makeFakeAccess();
    __test_setAccess(access);
    // Bind by learning, then unregister to simulate card unmount.
    const captureA: number[] = [];
    await beginLearn({ moduleId: 'a', paramId: 'p', min: 0, max: 1, onchange: (v) => captureA.push(v) });
    sendCc(0, 7, 64); // learn
    unregisterSetter('a', 'p');
    sendCc(0, 7, 100); // arrives while setter is detached
    // setter was detached after the learn capture; should be no new entries.
    const beforeRemount = captureA.length;

    // "Re-mount" the card.
    const captureB: number[] = [];
    registerSetter('a', 'p', { min: 0, max: 1, onchange: (v) => captureB.push(v) });
    sendCc(0, 7, 127);
    expect(captureB).toEqual([1]);
    // Old setter stays detached — the most-recent register wins.
    expect(captureA.length).toBe(beforeRemount);
  });

  it('clearBinding removes the entry; future CCs on those (channel,cc) are ignored', async () => {
    const { access, sendCc } = makeFakeAccess();
    __test_setAccess(access);
    let captured = -1;
    await beginLearn({ moduleId: 'm', paramId: 'k', min: 0, max: 1, onchange: (v) => { captured = v; } });
    sendCc(0, 7, 64);
    expect(getBinding('m', 'k')).toBeDefined();
    clearBinding('m', 'k');
    captured = -999;
    sendCc(0, 7, 127);
    expect(captured).toBe(-999); // setter was never invoked
    expect(getBinding('m', 'k')).toBeUndefined();
  });

  it('a remount with a NEW onchange closure dispatches subsequent CCs to the NEW setter', async () => {
    // Guards the "stale closure" failure mode: after a card remounts, the
    // setter MUST point at the fresh onchange (bound to the new component
    // instance's patch-store mutation), not the closure captured during the
    // original learn. If midi-learn kept the learn-time closure, CCs would
    // drive a dead/orphaned onchange and the audio + knob would not move.
    const { access, sendCc } = makeFakeAccess();
    __test_setAccess(access);

    const original: number[] = [];
    await beginLearn({ moduleId: 'mix', paramId: 'ch1_volume', min: 0, max: 1, onchange: (v) => original.push(v) });
    sendCc(15, 13, 64); // learn-capture pulse → original closure
    const afterLearn = original.length;

    // Unmount (onDestroy → unregisterSetter), then remount (onMount →
    // registerSetter) with a brand-new closure.
    unregisterSetter('mix', 'ch1_volume');
    const remounted: number[] = [];
    registerSetter('mix', 'ch1_volume', { min: 0, max: 1, onchange: (v) => remounted.push(v) });

    sendCc(15, 13, 127);
    // New closure drives; original stays frozen at its learn-capture count.
    expect(remounted).toEqual([1]);
    expect(original.length).toBe(afterLearn);
  });
});

// ---------------- Full live-dispatch chain: MIDI CC → set() → reconciler →
// engine.setParam → engine.readParam (= the card's live()/readLive) ----------
//
// The piece the unit tests above can't prove: the MixmstrsCard wires a knob's
// `onchange` to `set(k)` (writes patch.nodes[id].params[k]) and its `readLive`
// to `live(k)` (reads engine.readParam(node, k)). These are DIFFERENT stores —
// patch graph vs. live engine. If a MIDI CC writes the patch store but the
// engine value never follows, the audio (and the motorized knob, which polls
// readLive each rAF) would NOT move even though dispatch "fired". This test
// drives a real reconciler so the patch→engine propagation is exercised, then
// asserts the engine value the knob reads back equals what the CC wrote.

type PatchStore = { nodes: Record<string, ModuleNode>; edges: Record<string, Edge> };

/** Engine that actually STORES param values (unlike reconciler.test's
 *  write-only RecordingEngine) so readParam reflects the most recent setParam
 *  — modelling PatchEngine.readParam → node intrinsic value. */
class StatefulEngine implements DomainEngine {
  domain = 'audio' as const;
  params = new Map<string, number>();
  setParamCalls: Array<{ id: string; p: string; v: number }> = [];
  private key(id: string, p: string) { return `${id}:${p}`; }
  async addNode(n: ModuleNode): Promise<void> {
    for (const [p, v] of Object.entries(n.params)) {
      if (typeof v === 'number') this.params.set(this.key(n.id, p), v);
    }
  }
  removeNode(): void { /* no-op */ }
  addEdge(): void { /* no-op */ }
  removeEdge(): void { /* no-op */ }
  setParam(id: string, p: string, v: number): void {
    this.setParamCalls.push({ id, p, v });
    this.params.set(this.key(id, p), v);
  }
  readParam(id: string, p: string): number | undefined {
    return this.params.get(this.key(id, p));
  }
  read(): unknown { return undefined; }
  dispose(): void { /* no-op */ }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('MIDI CC → set() → reconciler → live() readback (set/live consistency)', () => {
  it('a learned CC drives the param AND the engine value the knob reads back', async () => {
    const NODE_ID = 'mixmstrs-abc';
    const PARAM = 'ch1_volume';

    // --- Real patch store + reconciler + engine, exactly as the app wires it.
    const patch = syncedStore<PatchStore>({ nodes: {}, edges: {} });
    const ydoc = getYjsDoc(patch);
    ydoc.transact(() => {
      patch.nodes[NODE_ID] = {
        id: NODE_ID, type: 'mixmstrs', domain: 'audio',
        position: { x: 0, y: 0 }, params: { [PARAM]: 0.8 },
      };
    });
    const bus = createSnapshotBus({ patch: patch as never, ydoc });
    const pe = new PatchEngine();
    const engine = new StatefulEngine();
    pe.registerDomain(engine);
    const handle = attachReconciler(pe, { bus });
    await flushMicrotasks();
    await handle.reconcile(); // materialize the node (engine learns params)

    // --- MixmstrsCard helper pattern (set writes patch store; live reads engine).
    const node = () => patch.nodes[NODE_ID] as unknown as ModuleNode;
    const set = (k: string) => (v: number) => { const t = patch.nodes[NODE_ID]; if (t) t.params[k] = v; };
    const live = (k: string) => () => pe.readParam(node(), k);
    const paramVal = (k: string, fallback: number) => {
      const v = patch.nodes[NODE_ID]?.params?.[k];
      return typeof v === 'number' ? v : fallback;
    };

    // Sanity: before any CC, set/live/paramVal all agree on the seeded value.
    expect(paramVal(PARAM, -1)).toBe(0.8);
    expect(live(PARAM)()).toBe(0.8);

    // --- Learn + drive via MIDI, using the card's real onchange (= set()).
    const { access, sendCc } = makeFakeAccess();
    __test_setAccess(access);
    await beginLearn({ moduleId: NODE_ID, paramId: PARAM, min: 0, max: 1, onchange: set(PARAM) });

    // Learn-capture CC: full value → writes patch store.
    sendCc(15, 13, 127);
    expect(getBinding(NODE_ID, PARAM)).toMatchObject({ channel: 15, cc: 13 });
    // set() wrote the patch store immediately.
    expect(paramVal(PARAM, -1)).toBe(1);
    // Propagate patch → engine and confirm live()/readLive sees the SAME value.
    await flushMicrotasks();
    await handle.reconcile();
    expect(live(PARAM)()).toBe(1);

    // --- Subsequent live CC (post-capture) moves param AND engine readback.
    sendCc(15, 13, 64);
    const expected64 = ccValueToParamValue(64, 0, 1);
    expect(paramVal(PARAM, -1)).toBeCloseTo(expected64, 6); // patch store
    await flushMicrotasks();
    await handle.reconcile();
    expect(live(PARAM)()).toBeCloseTo(expected64, 6);        // engine readback (knob)
    expect(engine.setParamCalls.some((c) => c.id === NODE_ID && c.p === PARAM)).toBe(true);

    // --- One more CC for good measure — chain stays consistent.
    sendCc(15, 13, 0);
    expect(paramVal(PARAM, -1)).toBe(0);
    await flushMicrotasks();
    await handle.reconcile();
    expect(live(PARAM)()).toBe(0);

    handle.dispose();
  });
});
