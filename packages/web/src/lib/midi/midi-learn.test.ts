// packages/web/src/lib/midi/midi-learn.test.ts
//
// Unit tests for the MIDI Learn singleton. Uses the MidiAccessLike /
// MidiInputLike / MidiEventLike injection seam from midi-cv-buddy so we
// can drive incoming CC messages without a real Web MIDI device.

import { describe, it, expect, beforeEach } from 'vitest';
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
  __test_setAccess,
  __test_clearBindings,
} from './midi-learn.svelte';

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
});
