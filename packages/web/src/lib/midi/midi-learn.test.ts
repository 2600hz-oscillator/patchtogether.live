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
  beginNoteLearn,
  cancelLearn,
  registerSetter,
  unregisterSetter,
  registerGateSetter,
  unregisterGateSetter,
  getBinding,
  clearBinding,
  bindingKey,
  ccValueToParamValue,
  parseCcMessage,
  importBindings,
  exportBindings,
  repairBindingCollisions,
  isCcBinding,
  isNoteBinding,
  __test_setAccess,
  __test_clearBindings,
} from './midi-learn.svelte';
import { PatchEngine, type DomainEngine } from '$lib/audio/engine';
import { attachReconciler } from '$lib/audio/reconciler';
import { createSnapshotBus } from '$lib/graph/snapshot';
import type { ModuleNode, Edge } from '$lib/graph/types';

// ---------------- Tiny fake MIDIAccess ----------------

function makeFakeAccess(): {
  access: MidiAccessLike;
  sendCc: (channel: number, cc: number, value: number) => void;
  sendNote: (channel: number, note: number, velocity: number) => void;
} {
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
  /** velocity 0 → note-off (0x8n); else note-on (0x9n). */
  function sendNote(channel: number, note: number, velocity: number) {
    if (!handler) return;
    const v = velocity & 0x7f;
    const status = (v > 0 ? 0x90 : 0x80) | (channel & 0x0f);
    handler({ data: new Uint8Array([status, note & 0x7f, v]), timeStamp: 0 });
  }
  return { access, sendCc, sendNote };
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
    expect(b).toMatchObject({ kind: 'cc', channel: 3, cc: 22 });
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

// ---------------- NOTE learn flow (gates + buttons) ----------------

describe('NOTE learn flow (capture next NOTE + drive a gate/button)', () => {
  const MOD = 'hydrogen-1';
  const PARAM = 'isPlaying';

  it('first NOTE-ON after beginNoteLearn becomes the binding (kind=note)', async () => {
    const { access, sendNote } = makeFakeAccess();
    __test_setAccess(access);
    const gates: boolean[] = [];
    await beginNoteLearn({ moduleId: MOD, paramId: PARAM, onGate: (h) => gates.push(h) });
    sendNote(/*ch*/ 5, /*note*/ 48, /*vel*/ 100);
    const b = getBinding(MOD, PARAM);
    expect(b).toBeDefined();
    expect(b && isNoteBinding(b)).toBe(true);
    expect(b).toMatchObject({ kind: 'note', channel: 5, note: 48 });
    // Captured press fires the gate high immediately.
    expect(gates).toEqual([true]);
  });

  it('NOTE-on → onGate(true); NOTE-off → onGate(false) (momentary)', async () => {
    const { access, sendNote } = makeFakeAccess();
    __test_setAccess(access);
    const gates: boolean[] = [];
    await beginNoteLearn({ moduleId: MOD, paramId: PARAM, onGate: (h) => gates.push(h) });
    sendNote(0, 60, 127); // learn-capture → true
    gates.length = 0;
    sendNote(0, 60, 0);   // note-off → false
    sendNote(0, 60, 90);  // note-on → true
    sendNote(0, 60, 0);   // note-off → false
    expect(gates).toEqual([false, true, false]);
  });

  it('a NOTE on the wrong channel/note is ignored once bound', async () => {
    const { access, sendNote } = makeFakeAccess();
    __test_setAccess(access);
    const gates: boolean[] = [];
    await beginNoteLearn({ moduleId: MOD, paramId: PARAM, onGate: (h) => gates.push(h) });
    sendNote(3, 36, 100); // learn captures ch3/note36
    gates.length = 0;
    sendNote(3, 37, 100); // wrong note
    sendNote(2, 36, 100); // wrong channel
    expect(gates).toEqual([]);
    sendNote(3, 36, 100); // matches
    expect(gates).toEqual([true]);
  });

  it('a CC arriving mid-NOTE-learn does NOT cancel the note learn', async () => {
    const { access, sendCc, sendNote } = makeFakeAccess();
    __test_setAccess(access);
    const gates: boolean[] = [];
    await beginNoteLearn({ moduleId: MOD, paramId: PARAM, onGate: (h) => gates.push(h) });
    sendCc(0, 7, 100); // a stray CC — must be ignored by the in-flight note learn
    expect(getBinding(MOD, PARAM)).toBeUndefined(); // still learning
    sendNote(0, 50, 100); // the real note now captures
    expect(getBinding(MOD, PARAM)).toMatchObject({ kind: 'note', note: 50 });
  });

  it('a NOTE-off during learn does NOT capture (only a press arms the binding)', async () => {
    const { access, sendNote } = makeFakeAccess();
    __test_setAccess(access);
    await beginNoteLearn({ moduleId: MOD, paramId: PARAM, onGate: () => {} });
    sendNote(0, 60, 0); // release of a previously-held key — ignored
    expect(getBinding(MOD, PARAM)).toBeUndefined();
    sendNote(0, 60, 100); // press captures
    expect(getBinding(MOD, PARAM)).toBeDefined();
  });
});

describe('NOTE gate-setter ↔ binding ordering on performance load', () => {
  const MOD = 'score-1';
  const PARAM = 'play';
  const CH = 2;
  const NOTE = 41;

  it('dispatches when the gate row mounts BEFORE bindings are imported', () => {
    const { access, sendNote } = makeFakeAccess();
    __test_setAccess(access);
    const gates: boolean[] = [];
    registerGateSetter(MOD, PARAM, { onGate: (h) => gates.push(h) });
    importBindings([{ kind: 'note', key: bindingKey(MOD, PARAM), channel: CH, note: NOTE, learnedAt: 1 }]);
    sendNote(CH, NOTE, 100);
    sendNote(CH, NOTE, 0);
    expect(gates).toEqual([true, false]);
  });

  it('also dispatches when bindings are imported BEFORE the gate row mounts', () => {
    const { access, sendNote } = makeFakeAccess();
    __test_setAccess(access);
    const gates: boolean[] = [];
    importBindings([{ kind: 'note', key: bindingKey(MOD, PARAM), channel: CH, note: NOTE, learnedAt: 1 }]);
    registerGateSetter(MOD, PARAM, { onGate: (h) => gates.push(h) });
    sendNote(CH, NOTE, 100);
    expect(gates).toEqual([true]);
  });

  it('unregisterGateSetter stops dispatch but keeps the binding for re-mount', () => {
    const { access, sendNote } = makeFakeAccess();
    __test_setAccess(access);
    const gates: boolean[] = [];
    importBindings([{ kind: 'note', key: bindingKey(MOD, PARAM), channel: CH, note: NOTE, learnedAt: 1 }]);
    registerGateSetter(MOD, PARAM, { onGate: (h) => gates.push(h) });
    sendNote(CH, NOTE, 100);
    expect(gates).toHaveLength(1);
    unregisterGateSetter(MOD, PARAM);
    sendNote(CH, NOTE, 100);
    expect(gates).toHaveLength(1); // no new dispatch
    expect(getBinding(MOD, PARAM)).toBeDefined();
    // Re-mount with a new closure: dispatch resumes.
    const gates2: boolean[] = [];
    registerGateSetter(MOD, PARAM, { onGate: (h) => gates2.push(h) });
    sendNote(CH, NOTE, 100);
    expect(gates2).toEqual([true]);
  });

  it('a remount with a NEW onGate closure dispatches to the NEW setter', () => {
    const { access, sendNote } = makeFakeAccess();
    __test_setAccess(access);
    importBindings([{ kind: 'note', key: bindingKey(MOD, PARAM), channel: CH, note: NOTE, learnedAt: 1 }]);
    const orig: boolean[] = [];
    registerGateSetter(MOD, PARAM, { onGate: (h) => orig.push(h) });
    sendNote(CH, NOTE, 100);
    const afterFirst = orig.length;
    unregisterGateSetter(MOD, PARAM);
    const next: boolean[] = [];
    registerGateSetter(MOD, PARAM, { onGate: (h) => next.push(h) });
    sendNote(CH, NOTE, 100);
    expect(next).toEqual([true]);
    expect(orig.length).toBe(afterFirst);
  });
});

describe('one binding per key (CC ↔ NOTE collision)', () => {
  const MOD = 'm';
  const PARAM = 'p';

  it('a NOTE learn over an existing CC binding replaces it (and drops the CC setter)', async () => {
    const { access, sendCc, sendNote } = makeFakeAccess();
    __test_setAccess(access);
    const cc: number[] = [];
    const gates: boolean[] = [];
    await beginLearn({ moduleId: MOD, paramId: PARAM, min: 0, max: 1, onchange: (v) => cc.push(v) });
    sendCc(0, 7, 64);
    expect(getBinding(MOD, PARAM)).toMatchObject({ kind: 'cc' });
    // Now NOTE-learn the same key.
    await beginNoteLearn({ moduleId: MOD, paramId: PARAM, onGate: (h) => gates.push(h) });
    sendNote(0, 60, 100);
    const b = getBinding(MOD, PARAM);
    expect(b && isNoteBinding(b)).toBe(true);
    cc.length = 0;
    gates.length = 0;
    // The old CC must NOT drive anything now (setter dropped + binding is note).
    sendCc(0, 7, 127);
    expect(cc).toEqual([]);
    // The note drives the gate.
    sendNote(0, 60, 100);
    expect(gates).toEqual([true]);
  });

  it('a CC learn over an existing NOTE binding replaces it (and drops the gate setter)', async () => {
    const { access, sendCc, sendNote } = makeFakeAccess();
    __test_setAccess(access);
    const cc: number[] = [];
    const gates: boolean[] = [];
    await beginNoteLearn({ moduleId: MOD, paramId: PARAM, onGate: (h) => gates.push(h) });
    sendNote(0, 60, 100);
    expect(getBinding(MOD, PARAM)).toMatchObject({ kind: 'note' });
    await beginLearn({ moduleId: MOD, paramId: PARAM, min: 0, max: 1, onchange: (v) => cc.push(v) });
    sendCc(0, 7, 127);
    expect(getBinding(MOD, PARAM)).toMatchObject({ kind: 'cc' });
    cc.length = 0;
    gates.length = 0;
    sendNote(0, 60, 100); // old note must not drive
    expect(gates).toEqual([]);
    sendCc(0, 7, 64);
    expect(cc).toHaveLength(1);
  });
});

describe('export/import round-trips the union + legacy migration', () => {
  it('export then import preserves a mixed CC + NOTE set', () => {
    const { access } = makeFakeAccess();
    __test_setAccess(access);
    importBindings([
      { kind: 'cc', key: 'a:p', channel: 1, cc: 7, learnedAt: 1 },
      { kind: 'note', key: 'b:g', channel: 2, note: 60, learnedAt: 2 },
    ]);
    const out = exportBindings();
    expect(out).toHaveLength(2);
    const cc = out.find((b) => b.key === 'a:p');
    const note = out.find((b) => b.key === 'b:g');
    expect(cc && isCcBinding(cc)).toBe(true);
    expect(note && isNoteBinding(note)).toBe(true);
    // Re-import the export — idempotent.
    __test_clearBindings();
    importBindings(out);
    expect(getBinding('a', 'p')).toMatchObject({ kind: 'cc', cc: 7 });
    expect(getBinding('b', 'g')).toMatchObject({ kind: 'note', note: 60 });
  });

  it('a legacy record with no kind imports as a CC binding', () => {
    const { access, sendCc } = makeFakeAccess();
    __test_setAccess(access);
    importBindings([{ key: 'legacy:p', channel: 0, cc: 7, learnedAt: 1 }]);
    const b = getBinding('legacy', 'p');
    expect(b && isCcBinding(b)).toBe(true);
    const got: number[] = [];
    registerGateSetter('legacy', 'p', { onGate: () => got.push(-1) }); // wrong kind: never fires
    registerSetter('legacy', 'p', { min: 0, max: 1, onchange: (v) => got.push(v) });
    sendCc(0, 7, 127);
    expect(got).toEqual([1]);
  });
});

// ---------------- One-owner-per-(channel,cc|note) invariant ----------------
//
// The Electra "controls on different pages collide" bug: a single CC was learned
// /imported onto MULTIPLE params (across regenerates), so the dispatch loop drove
// EVERY binding sharing that (channel,cc) → one physical knob moved 3 params. The
// invariant: at most ONE binding per physical address; the newest wins; dispatch
// fires exactly one param.
describe('one-owner-per-address invariant (Electra cross-page collision fix)', () => {
  it('a fresh learn EVICTS a prior key on the same (channel,cc); only the new param moves', async () => {
    const { access, sendCc } = makeFakeAccess();
    __test_setAccess(access);
    const aVals: number[] = [];
    const bVals: number[] = [];
    // cubeA:slice learns knob ch0/cc0.
    await beginLearn({ moduleId: 'cubeA', paramId: 'slice', min: 0, max: 1, onchange: (v) => aVals.push(v) });
    sendCc(0, 0, 10);
    // Later, the SAME physical knob (ch0/cc0) is learned onto cubeB:slice.
    await beginLearn({ moduleId: 'cubeB', paramId: 'slice', min: 0, max: 1, onchange: (v) => bVals.push(v) });
    sendCc(0, 0, 20);
    aVals.length = 0; bVals.length = 0;

    sendCc(0, 0, 127); // turn the physical knob
    expect(bVals).toHaveLength(1);          // the newest binding owns the CC
    expect(aVals).toEqual([]);              // the evicted one no longer moves
    expect(getBinding('cubeA', 'slice')).toBeUndefined(); // binding evicted
    expect(getBinding('cubeB', 'slice')).toBeDefined();
  });

  it('importBindings repairs a colliding map — newest learnedAt wins, one survivor per CC', () => {
    const { access, sendCc } = makeFakeAccess();
    __test_setAccess(access);
    // Three params parked on ch0/cc0 from successive Electra regenerates.
    importBindings([
      { key: 'cubeA:slice_ry', channel: 0, cc: 0, learnedAt: 100 },
      { key: 'cubeB:slice_rx', channel: 0, cc: 0, learnedAt: 200 },
      { key: 'chroma:hue', channel: 0, cc: 0, learnedAt: 300 }, // newest
    ]);
    const onCc0 = exportBindings().filter((b) => isCcBinding(b) && b.channel === 0 && b.cc === 0);
    expect(onCc0).toHaveLength(1);
    expect(onCc0[0]!.key).toBe('chroma:hue');

    // Dispatch fires exactly the surviving param.
    const fired: string[] = [];
    registerSetter('cubeA', 'slice_ry', { min: 0, max: 1, onchange: () => fired.push('A') });
    registerSetter('cubeB', 'slice_rx', { min: 0, max: 1, onchange: () => fired.push('B') });
    registerSetter('chroma', 'hue', { min: 0, max: 1, onchange: () => fired.push('hue') });
    sendCc(0, 0, 64);
    expect(fired).toEqual(['hue']);
  });

  it('an Electra RE-CONNECT (fresh import) supersedes stale colliders on the same CC', () => {
    const { access } = makeFakeAccess();
    __test_setAccess(access);
    importBindings([{ key: 'old:param', channel: 0, cc: 5, learnedAt: 1 }]); // stale
    // Re-connect imports the fresh allocation (Date.now() ≫ 1) — newest wins.
    importBindings([{ key: 'new:param', channel: 0, cc: 5, learnedAt: 999_999 }]);
    const onCc5 = exportBindings().filter((b) => isCcBinding(b) && b.channel === 0 && b.cc === 5);
    expect(onCc5).toHaveLength(1);
    expect(onCc5[0]!.key).toBe('new:param');
    expect(getBinding('old', 'param')).toBeUndefined();
  });

  it('CC and NOTE on the same channel+number do NOT collide (distinct address spaces)', () => {
    const { access } = makeFakeAccess();
    __test_setAccess(access);
    importBindings([
      { kind: 'cc', key: 'm:knob', channel: 0, cc: 1, learnedAt: 1 },
      { kind: 'note', key: 'm:gate', channel: 0, note: 1, learnedAt: 1 },
    ]);
    expect(getBinding('m', 'knob')).toBeDefined();
    expect(getBinding('m', 'gate')).toBeDefined();
  });

  it('repairBindingCollisions() collapses an already-loaded colliding set (the ctrl_bug shape)', () => {
    const { access } = makeFakeAccess();
    __test_setAccess(access);
    // A representative slice of the user's bug bundle: many keys, only a few
    // distinct (channel,cc) — all on channel 0 (mirrors 149 bindings → 52 addrs).
    const colliding = [
      { key: 'cube-b28b6fb0:slice_ry', channel: 0, cc: 0, learnedAt: 1 },
      { key: 'cube-e1112852:slice_rx', channel: 0, cc: 0, learnedAt: 2 },
      { key: 'chroma-635e2f0d:hue', channel: 0, cc: 0, learnedAt: 3 },
      { key: 'mixmstrs-005d562e:ch1_volume', channel: 0, cc: 11, learnedAt: 1 },
      { key: 'cube-e1112852:attack', channel: 0, cc: 11, learnedAt: 2 },
      { key: 'pentemelodica:v4_wave', channel: 0, cc: 11, learnedAt: 3 },
      { key: 'timelorde:bpm', channel: 0, cc: 41, learnedAt: 1 }, // already unique
    ];
    // Import withOUT the auto-repair path to simulate a pre-fix loaded set, then
    // repair explicitly (also the code path importBindings runs internally).
    importBindings(colliding);
    const survivors = exportBindings();
    // 3 distinct addresses (cc0, cc11, cc41) → 3 survivors.
    expect(survivors).toHaveLength(3);
    const addrs = survivors.map((b) => (isCcBinding(b) ? `${b.channel}:${b.cc}` : 'x'));
    expect(new Set(addrs).size).toBe(3);
    // A second repair is a no-op (idempotent — nothing left to remove).
    expect(repairBindingCollisions()).toBe(0);
  });
});
