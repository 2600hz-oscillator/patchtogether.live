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

function makeNode(data?: Record<string, unknown>, params?: Record<string, number>): ModuleNode {
  return {
    id: 'midiclock-test',
    type: 'midiclock',
    domain: 'audio',
    position: { x: 0, y: 0 },
    params: params ?? {},
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

  // ── THE DIVISION'S MIGRATION (2026-08-24) ─────────────────────────────────
  //
  // `divisor` moved from `node.data` to `node.params`, and that is THE ONE WAY
  // A SAVED PATCH COULD REGRESS in this promotion. These four tests are the
  // guard, and they are here rather than in `midiclock.test.ts` because the
  // read order lives in the FACTORY — a pure test of `snapDivisor` cannot see
  // which key the factory reached for first.
  //
  // The observable throughout is `readParam('divisor')`, which returns the
  // engine's live `divisor` closure variable — i.e. the number the divider
  // actually counts to, not a re-read of the node.

  async function bootWith(
    data: Record<string, unknown>,
    params: Record<string, number>,
  ): Promise<{ handle: Awaited<ReturnType<typeof midiclockDef.factory>>; node: ModuleNode }> {
    const node = makeNode(data, params);
    const handle = await midiclockDef.factory(makeMockCtx() as unknown as AudioContext, node);
    return { handle, node };
  }

  it('MIGRATION: a v-old rack with only `data.divisor` keeps clocking at ITS division', async () => {
    // The regression this whole ordering exists to prevent. Before the param
    // existed, `data.divisor = 6` was the only place a sixteenth-note division
    // could live. If the factory read params first and then STOPPED, every rack
    // saved before today would silently snap back to 1/4 on load — a change to
    // what the user hears, on open, with nothing said.
    const { handle } = await bootWith({ divisor: 6 }, {});
    expect(handle.readParam?.('divisor'), 'legacy data.divisor honoured').toBe(6);
  });

  it('MIGRATION: `params.divisor` WINS over a stale `data.divisor`', async () => {
    // The other direction, and the reason the order is params-first rather
    // than data-first. Once the player moves the control, `params` is the
    // truth; the legacy key is left behind untouched (see below) and must
    // never be able to overrule it.
    const { handle } = await bootWith({ divisor: 6 }, { divisor: 3 });
    expect(handle.readParam?.('divisor'), 'params outrank the legacy key').toBe(3);
  });

  it('MIGRATION: the legacy `data.divisor` is READ AND LEFT ALONE — never repaired', async () => {
    // ⚠ THE HALF THAT IS EASY TO GET WRONG BY BEING HELPFUL. Writing the
    // migrated value back would "tidy" the node from inside the engine — an
    // untagged Y.Doc write, outside undo, invisible to collaborators' history,
    // and `types.ts` states the rule: a silent engine-side repair of a
    // data-integrity bug is indistinguishable from no bug. The stored key is
    // normalized by the first ordinary tagged write the player makes, and by
    // nothing else.
    const { handle, node } = await bootWith({ divisor: 6 }, {});
    expect(handle.readParam?.('divisor')).toBe(6);
    expect(node.data?.divisor, 'legacy key not rewritten').toBe(6);
    expect(node.params.divisor, 'no param written behind the user\'s back').toBeUndefined();
  });

  it('MIGRATION: an OFF-ROSTER stored value clocks at its nearest LEGAL division', async () => {
    // A rack can hold anything — an IndexedDB replica restore, a peer's Y
    // update, an undo — and none of those paths goes through a loader. Snapping
    // at the point of use covers all of them. 7 has no meaning here (it does
    // not divide 24), and 6 is its neighbour.
    const { handle, node } = await bootWith({}, { divisor: 7 });
    expect(handle.readParam?.('divisor'), 'snapped to a named member').toBe(6);
    // And STILL not repaired in the graph, for the same reason as above.
    expect(node.params.divisor, 'stored value untouched').toBe(7);
  });

  it('setParam SNAPS rather than dropping — a lane knob cannot leave a dead control', async () => {
    // ⚠ THE ALTERNATIVE IMPLEMENTATION IS THE DEFECT. `if (isValidDivisor(v))
    // setDivisor(v)` looks like careful validation and is a dead control: at
    // every LANE tier `paramCellKind` returns 'knob' for an options param, so a
    // drag walks 1..24 and 19 of those 24 positions would move the dial on
    // screen and change nothing audible.
    const { handle } = await bootWith({}, {});
    handle.setParam?.('divisor', 17);
    // NEAREST BY VALUE, which is the shared `snapToOptions` every exhaustive
    // roster uses: |17−12| = 5 beats |17−24| = 7. Spelled out because the
    // first draft of this line asserted 24 by eye and the arithmetic caught it
    // — the snap is a measurement, not an intuition.
    expect(handle.readParam?.('divisor'), '17 landed on a legal division').toBe(12);
    handle.setParam?.('divisor', 3);
    expect(handle.readParam?.('divisor'), 'a legal value passes through exact').toBe(3);
  });

  it('NEGATIVE CONTROL: readParam answers ONLY for divisor', async () => {
    // Without this, a `readParam` that returned the divisor for every key would
    // satisfy every assertion above — and would hand the wrong number to any
    // future param, silently.
    const { handle } = await bootWith({}, { divisor: 12 });
    expect(handle.readParam?.('divisor')).toBe(12);
    expect(handle.readParam?.('nonsense')).toBeUndefined();
    // …and setParam ignores a key it does not own rather than clobbering.
    handle.setParam?.('nonsense', 1);
    expect(handle.readParam?.('divisor'), 'unrelated write did not move it').toBe(12);
  });
});
