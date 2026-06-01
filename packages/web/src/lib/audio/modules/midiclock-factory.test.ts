// packages/web/src/lib/audio/modules/midiclock-factory.test.ts
//
// Factory-level tests for MIDICLOCK: drive synthetic MIDI System Real-Time
// messages (0xF8 Clock, 0xFA Start, 0xFC Stop) through the handler and
// assert the four output ConstantSourceNodes get the right pulses.
//
// The pure helpers in midiclock.test.ts cover divider math, timestamp
// projection, and divisor coercion. THIS file covers the wiring between
// "MIDI byte arrived" and "ConstantSourceNode.offset got automated" — the
// runtime path the user's bug reproduced when MIDI Start/Stop from a real
// DAW transport failed to propagate to a downstream TIMELORDE.
//
// We mock Web Audio just enough for the factory to run in node. The
// ConstantSourceNode mock records every `offset.setValueAtTime` /
// `offset.cancelScheduledValues` call so the test can replay the MIDI
// stream + inspect the resulting automation events directly.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { midiclockDef, GATE_PULSE_S } from './midiclock';
import type { ModuleNode } from '$lib/graph/types';
import type {
  MidiAccessLike,
  MidiEventLike,
  MidiInputLike,
} from './midi-cv-buddy';

// ---------------- mocks ----------------

interface RecordedSchedule {
  kind: 'cancel' | 'set';
  value?: number;
  time: number;
}

interface FakeAudioParam {
  value: number;
  setValueAtTime: (v: number, t: number) => void;
  cancelScheduledValues: (t: number) => void;
  events: RecordedSchedule[];
}

function makeParam(initial = 0): FakeAudioParam {
  const events: RecordedSchedule[] = [];
  const p: FakeAudioParam = {
    value: initial,
    setValueAtTime(v, t) {
      p.value = v;
      events.push({ kind: 'set', value: v, time: t });
    },
    cancelScheduledValues(t) {
      events.push({ kind: 'cancel', time: t });
    },
    events,
  };
  return p;
}

class FakeConstantSourceNode {
  offset = makeParam(0);
  start = vi.fn();
  stop = vi.fn();
  connect = vi.fn();
  disconnect = vi.fn();
}

interface FakeAudioCtx {
  currentTime: number;
  sampleRate: number;
  createConstantSource: () => FakeConstantSourceNode;
}

function makeMockCtx(): FakeAudioCtx {
  return {
    currentTime: 0,
    sampleRate: 48000,
    createConstantSource: () => new FakeConstantSourceNode(),
  };
}

function makeNode(data?: Record<string, unknown>): ModuleNode {
  return {
    id: 'midiclock-test',
    type: 'midiclock',
    domain: 'audio',
    position: { x: 0, y: 0 },
    params: {},
    data: data ?? {},
  };
}

function makeMidiInput(id: string): MidiInputLike & { fire: (ev: MidiEventLike) => void } {
  let handler: ((ev: MidiEventLike) => void) | null = null;
  return {
    id,
    name: id,
    state: 'connected',
    get onmidimessage() {
      return handler;
    },
    set onmidimessage(fn) {
      handler = fn as ((ev: MidiEventLike) => void) | null;
    },
    fire(ev) {
      if (handler) handler(ev);
    },
  };
}

function makeMidiAccess(...inputs: ReturnType<typeof makeMidiInput>[]): MidiAccessLike {
  const map = new Map<string, MidiInputLike>();
  for (const i of inputs) map.set(i.id, i);
  return {
    inputs: map,
    onstatechange: null,
  };
}

// ---------------- tests ----------------

describe('midiclockDef.factory — MIDI System Real-Time → ConstantSourceNode pulses', () => {
  let originalRequestMIDIAccess: unknown;

  beforeEach(() => {
    originalRequestMIDIAccess = (
      globalThis as { navigator?: { requestMIDIAccess?: unknown } }
    ).navigator?.requestMIDIAccess;
  });

  function installFakeMidi(access: MidiAccessLike): void {
    const nav = (globalThis as unknown as { navigator?: Record<string, unknown> }).navigator;
    if (!nav) {
      (globalThis as unknown as { navigator?: Record<string, unknown> }).navigator = {
        requestMIDIAccess: vi.fn(async () => access),
      };
    } else {
      nav.requestMIDIAccess = vi.fn(async () => access);
    }
  }

  function restoreMidi(): void {
    const nav = (globalThis as unknown as { navigator?: Record<string, unknown> }).navigator;
    if (nav && originalRequestMIDIAccess === undefined) {
      delete nav.requestMIDIAccess;
    } else if (nav) {
      nav.requestMIDIAccess = originalRequestMIDIAccess;
    }
  }

  it('exposes midistart + midistop as gate outputs', () => {
    const ids = midiclockDef.outputs.map((o) => o.id);
    expect(ids).toContain('midistart');
    expect(ids).toContain('midistop');
    expect(midiclockDef.outputs.find((o) => o.id === 'midistart')?.type).toBe('gate');
    expect(midiclockDef.outputs.find((o) => o.id === 'midistop')?.type).toBe('gate');
  });

  it('0xFA (MIDI Start) pulses midistart: setValueAtTime(1, t), then 0 at t+GATE_PULSE_S', async () => {
    // Regression pin for the user's bug: 0xFA from a connected DAW must
    // produce a real audio-thread pulse on the midistart output, not
    // just flip internal `running` state. Without this pulse the
    // downstream TIMELORDE.start_in analyser never sees a rising edge
    // and the rack stays halted.
    const input = makeMidiInput('test-port');
    const access = makeMidiAccess(input);
    installFakeMidi(access);
    try {
      const ctx = makeMockCtx();
      const handle = await midiclockDef.factory(
        ctx as unknown as AudioContext,
        makeNode(),
      );
      const apiUnknown = handle.read?.('card-api');
      expect(apiUnknown, 'card-api exposed').toBeDefined();
      const api = apiUnknown as { connect: () => Promise<boolean> };
      const ok = await api.connect();
      expect(ok, 'fake MIDI Access connected').toBe(true);

      // Pull out midistart's ConstantSource so we can read its automation log.
      const midistartOut = handle.outputs.get('midistart')!;
      const startSrc = midistartOut.node as unknown as FakeConstantSourceNode;
      // Pre-pulse state: factory may schedule an initial offset=0 at boot, but no
      // setValueAtTime(1) yet.
      const setEvents0 = startSrc.offset.events.filter(
        (e) => e.kind === 'set' && e.value === 1,
      );
      expect(setEvents0).toHaveLength(0);

      // Drive a MIDI Start byte with a timeStamp that lands just behind
      // performance.now() (typical Web MIDI behavior).
      const perfNow = typeof performance !== 'undefined' ? performance.now() : 0;
      input.fire({
        data: new Uint8Array([0xfa]),
        timeStamp: perfNow,
      });

      // Inspect the recorded automation. The factory's pulse() helper
      // does: cancelScheduledValues(t); setValueAtTime(1, t);
      // setValueAtTime(0, t + GATE_PULSE_S).
      const events = startSrc.offset.events;
      const lastCancel = [...events]
        .reverse()
        .find((e) => e.kind === 'cancel');
      const setHigh = events.find((e) => e.kind === 'set' && e.value === 1);
      const setLow = events
        .filter((e) => e.kind === 'set' && e.value === 0)
        .find((e) => setHigh && Math.abs(e.time - (setHigh.time + GATE_PULSE_S)) < 1e-9);

      expect(lastCancel, 'cancelScheduledValues called before the pulse').toBeDefined();
      expect(setHigh, 'midistart raised to 1').toBeDefined();
      expect(setLow, `midistart lowered to 0 at +${GATE_PULSE_S}s`).toBeDefined();
      // Ordering: cancel before set(1) before set(0).
      const cancelIdx = events.indexOf(lastCancel!);
      const setHighIdx = events.indexOf(setHigh!);
      const setLowIdx = events.indexOf(setLow!);
      expect(cancelIdx).toBeLessThan(setHighIdx);
      expect(setHighIdx).toBeLessThan(setLowIdx);
    } finally {
      restoreMidi();
    }
  });

  it('0xFC (MIDI Stop) pulses midistop: setValueAtTime(1, t), then 0 at t+GATE_PULSE_S', async () => {
    // Symmetric to the Start case — same pulse shape on the stop output.
    const input = makeMidiInput('test-port');
    const access = makeMidiAccess(input);
    installFakeMidi(access);
    try {
      const ctx = makeMockCtx();
      const handle = await midiclockDef.factory(
        ctx as unknown as AudioContext,
        makeNode(),
      );
      const api = handle.read?.('card-api') as { connect: () => Promise<boolean> };
      await api.connect();

      // Start the transport first (a stop without a prior start is a
      // no-op-but-still-pulses scenario; we want the typical DAW flow).
      input.fire({ data: new Uint8Array([0xfa]), timeStamp: 0 });

      const midistopOut = handle.outputs.get('midistop')!;
      const stopSrc = midistopOut.node as unknown as FakeConstantSourceNode;
      const eventsBefore = [...stopSrc.offset.events];
      const setHighBefore = eventsBefore.find(
        (e) => e.kind === 'set' && e.value === 1,
      );
      expect(setHighBefore, 'no spurious midistop pulse before 0xFC').toBeUndefined();

      // Now fire 0xFC.
      input.fire({ data: new Uint8Array([0xfc]), timeStamp: 0 });

      const events = stopSrc.offset.events;
      const setHigh = events.find((e) => e.kind === 'set' && e.value === 1);
      const setLow = events
        .filter((e) => e.kind === 'set' && e.value === 0)
        .find((e) => setHigh && Math.abs(e.time - (setHigh.time + GATE_PULSE_S)) < 1e-9);
      expect(setHigh, 'midistop raised to 1').toBeDefined();
      expect(setLow, `midistop lowered to 0 at +${GATE_PULSE_S}s`).toBeDefined();
    } finally {
      restoreMidi();
    }
  });

  it('0xFB (MIDI Continue) does NOT pulse midistart — only flips run', async () => {
    // Pin the spec note: Continue resumes without re-firing midistart,
    // so downstream loops don't re-zero their phase.
    const input = makeMidiInput('test-port');
    const access = makeMidiAccess(input);
    installFakeMidi(access);
    try {
      const ctx = makeMockCtx();
      const handle = await midiclockDef.factory(
        ctx as unknown as AudioContext,
        makeNode(),
      );
      const api = handle.read?.('card-api') as { connect: () => Promise<boolean> };
      await api.connect();

      const startSrc = handle.outputs.get('midistart')!.node as unknown as FakeConstantSourceNode;
      const runSrc = handle.outputs.get('run')!.node as unknown as FakeConstantSourceNode;

      input.fire({ data: new Uint8Array([0xfb]), timeStamp: 0 });

      const startPulse = startSrc.offset.events.find(
        (e) => e.kind === 'set' && e.value === 1,
      );
      const runHigh = runSrc.offset.events.find(
        (e) => e.kind === 'set' && e.value === 1,
      );
      expect(startPulse, 'midistart UNCHANGED on Continue').toBeUndefined();
      expect(runHigh, 'run raised on Continue').toBeDefined();
    } finally {
      restoreMidi();
    }
  });

  it('Start/Stop sequence: two distinct pulses on the two distinct outputs', async () => {
    // End-to-end the DAW pattern: hit Play, then Stop on the transport.
    // Both events should pulse independently — no cross-talk between
    // the two outputs.
    const input = makeMidiInput('test-port');
    const access = makeMidiAccess(input);
    installFakeMidi(access);
    try {
      const ctx = makeMockCtx();
      const handle = await midiclockDef.factory(
        ctx as unknown as AudioContext,
        makeNode(),
      );
      const api = handle.read?.('card-api') as { connect: () => Promise<boolean> };
      await api.connect();

      const startSrc = handle.outputs.get('midistart')!.node as unknown as FakeConstantSourceNode;
      const stopSrc = handle.outputs.get('midistop')!.node as unknown as FakeConstantSourceNode;

      input.fire({ data: new Uint8Array([0xfa]), timeStamp: 0 });
      input.fire({ data: new Uint8Array([0xfc]), timeStamp: 0 });

      const startHighs = startSrc.offset.events.filter(
        (e) => e.kind === 'set' && e.value === 1,
      ).length;
      const stopHighs = stopSrc.offset.events.filter(
        (e) => e.kind === 'set' && e.value === 1,
      ).length;
      expect(startHighs, 'one midistart pulse fired (from 0xFA)').toBe(1);
      expect(stopHighs, 'one midistop pulse fired (from 0xFC)').toBe(1);
    } finally {
      restoreMidi();
    }
  });
});
