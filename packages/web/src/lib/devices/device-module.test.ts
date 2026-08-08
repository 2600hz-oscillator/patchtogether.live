// packages/web/src/lib/devices/device-module.test.ts
//
// The device handle, driven exactly as the engine drives it: `setParam` for a
// knob move, `scheduleParam` for clip automation, `holdParam` for a transport
// seam. Everything is injected (clock, timer, port), so the interesting cases
// — a ramp that gets cut off, a slot pointed at a control that no longer
// exists, an action fired twice with the same value — are testable without a
// browser or a real device.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEVICE_SLOT_IDS,
  createDeviceHandle,
  deviceSlotParams,
  type DeviceCardApi,
  type DeviceHandle,
} from './device-module';
import { CHROMA_CONSOLE } from './hologram-chroma-console';
import { controlById } from './device-descriptor';

/** A manual clock + timer queue, so ramp draining is stepped by hand. */
function makeHarness(opts: { assign?: Record<string, string> } = {}) {
  let clock = 0;
  const timers: { at: number; fn: () => void }[] = [];
  const sent: number[][] = [];
  let assign: Record<string, string> | undefined = opts.assign;
  const params: Record<string, number> = {};

  const port = {
    id: 'fake',
    name: 'HOLOGRAM Chroma Console MIDI',
    state: 'connected',
    send(data: Uint8Array | number[]) {
      sent.push(Array.from(data));
    },
  };

  const access = {
    outputs: new Map<string, unknown>([['fake', port]]),
    inputs: new Map(),
    onstatechange: null as null | (() => void),
  };

  const handle = createDeviceHandle({
    descriptor: CHROMA_CONSOLE,
    ctx: { currentTime: 0 },
    nowMs: () => clock,
    scheduleTick: (fn, ms) => {
      const t = { at: clock + ms, fn };
      timers.push(t);
      return t;
    },
    cancelTick: (h) => {
      const i = timers.indexOf(h as { at: number; fn: () => void });
      if (i >= 0) timers.splice(i, 1);
    },
    access: {
      readAssign: () => assign,
      writeAssign: (next) => { assign = next; },
      readSlotValue: (slotId) => params[slotId] ?? 0,
    },
  }) as DeviceHandle;

  const api = handle.read!('card-api') as DeviceCardApi;

  return {
    handle,
    api,
    sent,
    port,
    get assign() { return assign; },
    access,
    setParamValue: (slotId: string, v: number) => { params[slotId] = v; },
    advance(ms: number) {
      clock += ms;
      // Fire every timer whose deadline has passed, allowing re-arm.
      for (let guard = 0; guard < 500; guard++) {
        const idx = timers.findIndex((t) => t.at <= clock);
        if (idx < 0) break;
        const [t] = timers.splice(idx, 1);
        t!.fn();
      }
    },
    ccs: () => sent.filter((m) => (m[0] ?? 0) >= 0xb0 && (m[0] ?? 0) <= 0xbf),
    valuesFor: (cc: number) =>
      sent.filter((m) => m[1] === cc).map((m) => m[2]!),
  };
}

/**
 * The handle resolves its port list from the granted MIDIAccess, which only
 * `connect()` sets — and `connect()` needs `navigator.requestMIDIAccess`. Rather
 * than mock the whole permission dance in every test, install a navigator stub
 * once so `api.connect()` is the REAL path under test.
 */
function stubMidiAccess(outputs: Map<string, unknown>): void {
  // `navigator` is a getter-only global here, so assignment throws — stubGlobal
  // is the supported route and it unwinds in afterEach.
  vi.stubGlobal('navigator', {
    requestMIDIAccess: async () => ({ inputs: new Map(), outputs, onstatechange: null }),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('deviceSlotParams', () => {
  it('declares exactly the fixed slot set, all 0..127 linear', () => {
    const params = deviceSlotParams(CHROMA_CONSOLE);
    expect(params.map((p) => p.id)).toEqual([...DEVICE_SLOT_IDS]);
    for (const p of params) {
      expect(p.min).toBe(0);
      expect(p.max).toBe(127);
      expect(p.curve).toBe('linear');
    }
  });

  it('seeds each default from the control the slot initially holds', () => {
    const params = deviceSlotParams(CHROMA_CONSOLE);
    expect(params[0]!.defaultValue).toBe(controlById(CHROMA_CONSOLE, 'tilt')!.default);
  });

  it('slot ids are GENERIC — no CC name reaches the contract', () => {
    // The whole rename-migration argument in one assertion: correcting the
    // descriptor must never move a ParamDef id.
    for (const p of deviceSlotParams(CHROMA_CONSOLE)) {
      expect(p.id).toMatch(/^slot\d+$/);
    }
  });
});

describe('device handle — transmission', () => {
  let h: ReturnType<typeof makeHarness>;

  beforeEach(async () => {
    h = makeHarness();
    stubMidiAccess(new Map([['fake', h.port]]));
    await h.api.connect();
    h.api.selectPort('fake');
  });

  it('setParam on slot1 sends TILT (CC 64) on channel 1', () => {
    h.handle.setParam('slot1', 100);
    expect(h.sent).toEqual([[0xb0, 64, 100]]);
  });

  it('slot2 sends RATE = CC 66 and slot3 sends TIME = CC 68', () => {
    h.handle.setParam('slot2', 10);
    h.handle.setParam('slot3', 20);
    expect(h.sent).toEqual([
      [0xb0, 66, 10],
      [0xb0, 68, 20],
    ]);
  });

  it('an UNASSIGNED slot sends nothing at all', () => {
    h.api.assignSlot('slot1', null);
    h.handle.setParam('slot1', 100);
    expect(h.sent).toEqual([]);
  });

  it('a STALE assignment sends nothing and is reported', () => {
    const stale = makeHarness({ assign: { slot1: 'goneInV2' } });
    stubMidiAccess(new Map([['fake', stale.port]]));
    return stale.api.connect().then(() => {
      stale.api.selectPort('fake');
      stale.handle.setParam('slot1', 100);
      expect(stale.sent, 'a dead slot must not transmit').toEqual([]);
      expect(stale.api.status().staleSlots).toContain('slot1');
    });
  });

  it('readParam reports what the APP wrote — never a device reading', () => {
    h.handle.setParam('slot1', 77);
    expect(h.handle.readParam('slot1')).toBe(77);
    // Nothing can make this reflect the hardware; the device cannot be asked.
    expect(h.api.status().connected).toBe(true);
  });

  it('reassigning a slot re-points it at the new controller', () => {
    h.api.assignSlot('slot1', 'mix');
    h.handle.setParam('slot1', 42);
    expect(h.sent).toEqual([[0xb0, 70, 42]]); // MIX
  });
});

describe('device handle — ramps (the anti-step control)', () => {
  let h: ReturnType<typeof makeHarness>;

  beforeEach(async () => {
    h = makeHarness();
    stubMidiAccess(new Map([['fake', h.port]]));
    await h.api.connect();
    h.api.selectPort('fake');
  });

  it('a ramped scheduleParam emits INTERMEDIATE values, not just the endpoint', () => {
    h.handle.setParam('slot1', 0);
    h.sent.length = 0;
    // Ramp to 60 over one second of audio time (ctx.currentTime is 0, clock 0).
    h.handle.scheduleParam!('slot1', 60, 1, true);
    h.advance(1200);

    const values = h.valuesFor(64);
    expect(values.length, 'a train, not a step').toBeGreaterThan(5);
    expect(values.at(-1), 'the endpoint always lands').toBe(60);
    for (let i = 1; i < values.length; i++) {
      expect(values[i]!).toBeGreaterThan(values[i - 1]!);
    }
  });

  it('an UNRAMPED scheduleParam emits exactly one message, at the target time', () => {
    h.handle.scheduleParam!('slot1', 90, 0.5, false);
    expect(h.sent, 'nothing before the deadline').toEqual([]);
    h.advance(700);
    expect(h.valuesFor(64)).toEqual([90]);
  });

  it('holdParam drops the un-emitted remainder and pins the value', () => {
    h.handle.setParam('slot1', 0);
    h.handle.scheduleParam!('slot1', 127, 2, true);
    h.advance(200);
    const midCount = h.valuesFor(64).length;
    expect(midCount, 'the ramp had started').toBeGreaterThan(1);

    h.handle.holdParam('slot1', 30);
    h.advance(3000);

    const values = h.valuesFor(64);
    expect(values.at(-1), 'pinned where the seam said').toBe(30);
    // Nothing from the cancelled tail arrives afterwards.
    expect(values.filter((v) => v === 127), 'the tail never lands').toEqual([]);
  });

  it('a manual setParam supersedes a ramp still in flight', () => {
    h.handle.setParam('slot1', 0);
    h.handle.scheduleParam!('slot1', 127, 2, true);
    h.advance(100);
    h.handle.setParam('slot1', 5);
    h.sent.length = 0;
    h.advance(3000);
    expect(h.sent, 'the abandoned ramp does not resume').toEqual([]);
  });
});

describe('device handle — push, actions, and the open loop', () => {
  let h: ReturnType<typeof makeHarness>;

  beforeEach(async () => {
    h = makeHarness();
    stubMidiAccess(new Map([['fake', h.port]]));
    await h.api.connect();
    h.api.selectPort('fake');
  });

  it('pushAll re-asserts every assigned slot even when nothing changed', () => {
    h.handle.setParam('slot1', 100);
    h.sent.length = 0;
    // Without the resync inside pushAll, suppression would swallow all of these
    // and the "make the pedal match the screen" button would do nothing — the
    // single most important thing on the card for a device that cannot be read.
    const count = h.api.pushAll();
    expect(count).toBe(DEVICE_SLOT_IDS.length);
    expect(h.sent).toHaveLength(DEVICE_SLOT_IDS.length);
  });

  it('an ACTION fires on every press, even at the same value', () => {
    // Tap tempo is the case that proves it: two taps at the same value must be
    // two messages, or the tempo can never be changed.
    h.api.fireAction('tapTempo');
    h.api.fireAction('tapTempo');
    expect(h.valuesFor(93)).toHaveLength(2);
  });

  it('fireAction REFUSES a non-action control', () => {
    // Routing a continuous control through the action path would bypass both
    // suppression and the undo stack.
    expect(h.api.fireAction('tilt')).toBeNull();
    expect(h.sent).toEqual([]);
  });

  it('an unknown control id is refused rather than silently sending CC 0', () => {
    expect(h.api.fireAction('nonexistent')).toBeNull();
    expect(h.sent).toEqual([]);
  });

  it('with NO port selected, a write is recorded as undelivered — not dropped', () => {
    h.api.selectPort(null);
    h.handle.setParam('slot1', 100);
    expect(h.sent).toEqual([]);
    const status = h.api.status();
    expect(status.connected).toBe(false);
    expect(status.undelivered, '"tried and reached nothing" is visible').toBeGreaterThan(0);
    expect(status.delivered).toBe(0);
  });

  it('changing channel re-asserts on the new channel', () => {
    h.handle.setParam('slot1', 100);
    h.api.setChannel(5);
    h.handle.setParam('slot1', 100);
    expect(h.sent).toEqual([
      [0xb0, 64, 100],
      [0xb4, 64, 100],
    ]);
  });

  it('dispose stops the ramp drain and detaches the port listener', () => {
    h.handle.setParam('slot1', 0);
    h.handle.scheduleParam!('slot1', 127, 5, true);
    h.handle.dispose();
    h.sent.length = 0;
    h.advance(10_000);
    expect(h.sent, 'a disposed module must go quiet').toEqual([]);
  });
});
