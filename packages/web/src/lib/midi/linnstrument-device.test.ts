// THE LINNSTRUMENT DEVICE LAYER, driven through the SIMULATED device — which
// is the real code path with the USB cable replaced (linnstrument-device.ts
// "The simulated device"): port match → claim → decodePhysicalMidi →
// mapSurface → source registry → LED writer. Nothing here calls a decoder
// directly; every event asserted below arrived through `onmidimessage`.
//
// ⚠ SYNTHETIC. No LinnStrument was connected (design.md C02/C03); the bytes
// are what the firmware documentation says the instrument sends. V01 / V11 /
// V14 below are the WP-A corpus entries replayed on the REAL input path, so
// the geometry, boundary and epoch claims hold through the device layer, not
// only through the pure reducers.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetLinnstrumentForTest,
  bindLinnstrument,
  CC_LED_COLOR,
  CC_LED_COLUMN,
  CC_LED_ROW,
  CC_ROW_SLIDE_ENABLE,
  CC_ROW_X_ENABLE,
  CC_ROW_Y_ENABLE,
  CC_ROW_Z_ENABLE,
  connectLinnstrument,
  encodeUserFirmwareMode,
  encodeUserFirmwareModeRead,
  installSimulatedLinnstrument,
  LINN_REPLY_WINDOW_MS,
  USER_MODE_ECHO_CHANNEL,
  ledFrame,
  lightingFromProfile,
  musicalFrame,
  linnstrumentDiagnostics,
  linnstrumentMidiVersion,
  linnstrumentStatus,
  linnstrumentTimeDomain,
  listLinnstrumentPorts,
  setLinnstrumentAudioClock,
  unbindLinnstrument,
  type SimulatedLinnstrument,
} from './linnstrument-device';
import {
  __resetLinnstrumentSourceForTest,
  getLinnstrumentSource,
  publishLinnstrumentLighting,
  publishLinnstrumentSelection,
  subscribeLinnstrumentEvents,
} from './linnstrument/source-registry';
import { createSelectionState, reduceAll } from './linnstrument/selection-reducer';
import { DEFAULT_LINN_PROFILE } from './linnstrument/profile';
import { ACCEPTANCE_VECTORS } from './linnstrument/vectors';
import type { RuntimeEvent, SelectionState } from './linnstrument/types';
import {
  RigBindingStore,
  emptyRigBindings,
  rigBindings,
  setRigBindingsForTests,
  type RigBindings,
  type RigStoreBackend,
} from '$lib/graph/device-slot-bindings';
import { TIMESTAMP_LOOKAHEAD_S } from '$lib/audio/midi-timing';
import { setNativeAvailableForTests } from '$lib/platform/native';

const USER_MODE_ON = encodeUserFirmwareMode(true);
const USER_MODE_OFF = encodeUserFirmwareMode(false);
/** NRPN 299 = 245 — "what mode are you in?" (ls_midi.ino `case 299`). */
const USER_MODE_READ = encodeUserFirmwareModeRead();

/** Does `writes` contain `seq` as a contiguous run? */
function containsRun(writes: number[][], seq: number[][]): number {
  let hits = 0;
  for (let i = 0; i + seq.length <= writes.length; i++) {
    if (seq.every((m, j) => writes[i + j]!.length === m.length && m.every((b, k) => writes[i + j]![k] === b))) hits++;
  }
  return hits;
}
const ledWrites = (writes: number[][]): number[][] =>
  writes.filter((w) => w[0] === 0xb0 && (w[1] === CC_LED_COLUMN || w[1] === CC_LED_ROW || w[1] === CC_LED_COLOR));
/** The cells the LED writes paint, as contiguous CC20/21/22 triples. */
function paintedCells(writes: number[][]): { wireCol: number; ledRow: number; color: number }[] {
  const w = ledWrites(writes);
  const out: { wireCol: number; ledRow: number; color: number }[] = [];
  for (let i = 0; i + 2 < w.length; i += 3) {
    expect([w[i]![1], w[i + 1]![1], w[i + 2]![1]]).toEqual([CC_LED_COLUMN, CC_LED_ROW, CC_LED_COLOR]); // never interleaved
    out.push({ wireCol: w[i]![2]!, ledRow: w[i + 1]![2]!, color: w[i + 2]![2]! });
  }
  return out;
}
const CONTROL_WIRE_COL = DEFAULT_LINN_PROFILE.regions.controls.left + 1;
const controlCells = (writes: number[][]) => paintedCells(writes).filter((c) => c.wireCol === CONTROL_WIRE_COL);
const MUSICAL_CELLS = DEFAULT_LINN_PROFILE.regions.keys.width * DEFAULT_LINN_PROFILE.regions.keys.height + DEFAULT_LINN_PROFILE.regions.pad.width * DEFAULT_LINN_PROFILE.regions.pad.height;
const vector = (id: string) => {
  const v = ACCEPTANCE_VECTORS.find((x) => x.id === id);
  if (!v) throw new Error(`no vector ${id}`);
  return v;
};
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function memBackend(initial: RigBindings = emptyRigBindings()): RigStoreBackend & { saved: RigBindings[] } {
  const saved: RigBindings[] = [];
  return { load: () => initial, save: (b) => void saved.push(b), subscribe: () => () => {}, saved };
}

let events: RuntimeEvent[];
let unsub: () => void;

beforeEach(async () => {
  __resetLinnstrumentForTest();
  __resetLinnstrumentSourceForTest();
  setRigBindingsForTests(new RigBindingStore(memBackend()));
  events = [];
  unsub = subscribeLinnstrumentEvents((e) => events.push(e));
  vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => {
  unsub();
  __resetLinnstrumentForTest();
  __resetLinnstrumentSourceForTest();
  setRigBindingsForTests(null);
  setNativeAvailableForTests(null);
  vi.restoreAllMocks();
});

describe('bind: the sim device reaches the REAL claim and User Firmware Mode goes out on the wire', () => {
  it('connects, attaches the claim to the matching port only, and publishes a connected session', async () => {
    const sim = await installSimulatedLinnstrument({ decoyPortName: 'Ableton Push 2 Live Port' });
    expect(sim.attached()).toBe(true);
    expect(linnstrumentStatus().kind).toBe('bound');
    expect(listLinnstrumentPorts().map((p) => p.inputId)).toEqual([sim.inputId]); // the decoy never matches
    expect(getLinnstrumentSource()?.kind).toBe('simulated');
    const sessions = events.filter((e) => e.kind === 'session');
    // Connected, mode REQUESTED: `userMode` is the instrument's readback, not our write.
    expect(sessions.at(-1)).toMatchObject({ kind: 'session', state: 'connected', userMode: false });
    expect(sessions.at(-1)!.epoch).toBeGreaterThan(0);
  });

  it('User Firmware Mode is CONFIRMED by the NRPN 245 readback, never inferred from the write (design.md:188)', async () => {
    const sim = await installSimulatedLinnstrument();
    expect(containsRun(sim.writes(), USER_MODE_ON)).toBe(1); // the request left…
    expect(linnstrumentStatus().userMode).toBe(false); // …and proves nothing yet
    expect(linnstrumentStatus().reply).toBe('pending');
    expect(linnstrumentStatus().message).toMatch(/requested/);
    expect(linnstrumentStatus().message).not.toMatch(/confirmed/);
    const epoch = linnstrumentStatus().epoch;

    // The firmware's spontaneous echo rides CHANNEL 9 (0xB8), not the row
    // channel we wrote on — the sim's default (ls_settings.ino:2428).
    sim.ackUserMode(true);
    expect(USER_MODE_ECHO_CHANNEL).toBe(8);
    expect(linnstrumentStatus().userMode).toBe(true);
    expect(linnstrumentStatus().reply).toBe('answered');
    expect(linnstrumentStatus().message).toMatch(/confirmed by the instrument/);
    expect(linnstrumentStatus().epoch).toBe(epoch + 1);
    expect(events.filter((e) => e.kind === 'session').at(-1)).toMatchObject({ state: 'mode_changed', userMode: true });

    // The instrument leaving the mode under us is reported, not papered over.
    sim.ackUserMode(false);
    expect(linnstrumentStatus().userMode).toBe(false);
    expect(events.filter((e) => e.kind === 'session').at(-1)).toMatchObject({ state: 'mode_changed', userMode: false });
    expect(linnstrumentStatus().message).toMatch(/reports User Firmware Mode OFF/);

    // Unbind clears it; a re-bind starts unconfirmed again.
    sim.ackUserMode(true);
    unbindLinnstrument();
    expect(linnstrumentStatus().userMode).toBe(false);
    bindLinnstrument(sim.inputId);
    expect(linnstrumentStatus().userMode).toBe(false);
    expect(linnstrumentStatus().reply).toBe('pending');
  });

  it('the bind READS the mode back (NRPN 299 = 245) after the enables, and the answer on the read channel confirms it too — an instrument ALREADY in User Mode echoes nothing (ls_settings.ino:2412)', async () => {
    const sim = await installSimulatedLinnstrument();
    const w = sim.writes();
    expect(USER_MODE_READ).toEqual([
      [0xb0, 99, 2], [0xb0, 98, 43], [0xb0, 6, 1], [0xb0, 38, 117], [0xb0, 101, 127], [0xb0, 100, 127],
    ]);
    expect(containsRun(w, USER_MODE_READ)).toBe(1);
    // Entry → enables → read, in that order, and the read before any LED cell.
    const entryAt = w.findIndex((m) => m[1] === 99 && m[2] === 1);
    const lastEnableAt = w.map((m) => m[1]).lastIndexOf(CC_ROW_Z_ENABLE);
    const readAt = w.findIndex((m) => m[1] === 99 && m[2] === 2);
    const firstLedAt = w.findIndex((m) => m[1] === CC_LED_COLUMN);
    expect(entryAt).toBeLessThan(lastEnableAt);
    expect(lastEnableAt).toBeLessThan(readAt);
    expect(firstLedAt === -1 || readAt < firstLedAt).toBe(true);

    // The firmware answers a read on the channel it was asked on (channel 1
    // here), with the CURRENT mode — the shape an already-in-User-Mode
    // instrument produces when the entry itself changed nothing.
    sim.ackUserMode(true, 0);
    expect(linnstrumentStatus().userMode).toBe(true);
    expect(linnstrumentStatus().reply).toBe('answered');
    expect(events.filter((e) => e.kind === 'session').at(-1)).toMatchObject({ state: 'mode_changed', userMode: true });
  });

  it('a healthy fresh entry answers TWICE (echo on 9, then the read on 1): one repaint, one re-arm of the enables, not two', async () => {
    const sim = await installSimulatedLinnstrument();
    await flush(); // the bind's own paint
    sim.clearWrites();
    sim.ackUserMode(true); // the echo: a transition → enables + full repaint
    await flush();
    const afterEcho = sim.writes();
    expect(afterEcho.filter((m) => m[1] === CC_ROW_X_ENABLE)).toHaveLength(DEFAULT_LINN_PROFILE.rows);
    expect(paintedCells(afterEcho)).toHaveLength(MUSICAL_CELLS);
    sim.clearWrites();
    sim.ackUserMode(true, 0); // the read's answer: same state → nothing to re-send
    await flush();
    expect(sim.writes()).toHaveLength(0);
    expect(linnstrumentStatus().userMode).toBe(true);
  });

  it('an instrument that answers NOTHING inside the reply window is named as silent, with the MIDI I/O guidance; a late answer still confirms', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const sim = await installSimulatedLinnstrument();
      expect(linnstrumentStatus().reply).toBe('pending');
      let bumps = 0;
      const off = linnstrumentMidiVersion.subscribe(() => void bumps++);
      const before = bumps;
      await vi.advanceTimersByTimeAsync(LINN_REPLY_WINDOW_MS - 1);
      expect(linnstrumentStatus().reply).toBe('pending');
      await vi.advanceTimersByTimeAsync(1);
      const st = linnstrumentStatus();
      expect(st.kind).toBe('bound');
      expect(st.reply).toBe('silent');
      expect(st.userMode).toBe(false);
      expect(st.message).toMatch(/answered NOTHING over USB/);
      expect(st.message).toMatch(/MIDI I\/O/);
      expect(st.message).toMatch(/USB/);
      expect(st.message).toMatch(/CONNECT again/);
      expect(warn).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(bumps).toBeGreaterThan(before); // the face is told
      off();
      // The verdict never gates anything: the paint went out at bind time…
      expect(paintedCells(sim.writes())).toHaveLength(MUSICAL_CELLS);
      // …and a late answer confirms exactly as an early one would.
      sim.ackUserMode(true);
      expect(linnstrumentStatus().reply).toBe('answered');
      expect(linnstrumentStatus().userMode).toBe(true);
      expect(linnstrumentStatus().message).toMatch(/confirmed by the instrument/);
      // An unbind inside the window closes it without a verdict.
      unbindLinnstrument();
      bindLinnstrument(sim.inputId);
      unbindLinnstrument();
      await vi.advanceTimersByTimeAsync(LINN_REPLY_WINDOW_MS * 2);
      expect(linnstrumentStatus().reply).toBe('pending');
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('captures the six-message NRPN 245 entry transaction, reset included, then every row axis enable', async () => {
    const sim = await installSimulatedLinnstrument();
    const w = sim.writes();
    expect(USER_MODE_ON).toEqual([
      [0xb0, 99, 1], [0xb0, 98, 117], [0xb0, 6, 0], [0xb0, 38, 1], [0xb0, 101, 127], [0xb0, 100, 127],
    ]);
    expect(containsRun(w, USER_MODE_ON)).toBe(1);
    expect(containsRun(w, USER_MODE_OFF)).toBe(0);
    for (let row = 0; row < DEFAULT_LINN_PROFILE.rows; row++) {
      for (const cc of [CC_ROW_SLIDE_ENABLE, CC_ROW_X_ENABLE, CC_ROW_Y_ENABLE, CC_ROW_Z_ENABLE]) {
        expect(w.filter((m) => m[0] === (0xb0 | row) && m[1] === cc && m[2] === 1)).toHaveLength(1);
      }
    }
    // The entry precedes the enables — the firmware resets them on transition.
    const entryAt = w.findIndex((m) => m[1] === 99);
    const enableAt = w.findIndex((m) => m[1] === CC_ROW_SLIDE_ENABLE);
    expect(entryAt).toBeLessThan(enableAt);
    // On bind the writer lights the KEYS and the PAD (User Mode switches the
    // stock lighting off) but NO control cell: nothing has been acknowledged.
    await flush();
    const painted = paintedCells(sim.writes());
    expect(controlCells(sim.writes())).toHaveLength(0);
    expect(painted).toHaveLength(MUSICAL_CELLS);
    expect(ledWrites(w).length).toBeGreaterThan(0);
  });

  it('a second bind of the same port is idempotent — no second entry, no second session', async () => {
    const sim = await installSimulatedLinnstrument();
    const sessionsBefore = events.filter((e) => e.kind === 'session').length;
    expect(bindLinnstrument(sim.inputId)).toBe(true);
    expect(bindLinnstrument(sim.inputId)).toBe(true);
    expect(containsRun(sim.writes(), USER_MODE_ON)).toBe(1);
    expect(events.filter((e) => e.kind === 'session').length).toBe(sessionsBefore);
    expect(linnstrumentStatus().kind).toBe('bound');
  });

  it('unbind restores the mode (NRPN 245 = 0) and announces disconnected', async () => {
    const sim = await installSimulatedLinnstrument();
    sim.clearWrites();
    unbindLinnstrument();
    expect(containsRun(sim.writes(), USER_MODE_OFF)).toBe(1);
    expect(sim.attached()).toBe(false);
    expect(events.at(-1)).toMatchObject({ kind: 'session', state: 'disconnected', userMode: false });
    expect(linnstrumentStatus().kind).toBe('unbound');
    // Idempotent: a second unbind sends nothing.
    sim.clearWrites();
    unbindLinnstrument();
    expect(sim.writes()).toHaveLength(0);
  });

  it('pagehide releases the temporary User Mode layer', async () => {
    const fakeWindow = new EventTarget();
    vi.stubGlobal('window', fakeWindow);
    const sim = await installSimulatedLinnstrument();
    sim.clearWrites();
    fakeWindow.dispatchEvent(new Event('pagehide'));
    expect(containsRun(sim.writes(), USER_MODE_OFF)).toBe(1);
    expect(sim.attached()).toBe(false);
    vi.unstubAllGlobals();
  });

  it('bumps the version store on bind and unbind', async () => {
    let n = 0;
    const off = linnstrumentMidiVersion.subscribe((v) => void (n = v));
    const before = n;
    await installSimulatedLinnstrument();
    await flush();
    expect(n).toBeGreaterThan(before);
    off();
  });
});

describe('the apply step: the RIG binding decides the port', () => {
  it('connect with a rig binding binds THAT port; a rig pick while connected binds live; clearing it releases', async () => {
    // The /preflight pick flow is the SHELL's (owner ruling 2026-09-15): in a
    // browser the layer binds by name and "clearing the pick" does not exist.
    setNativeAvailableForTests(true);
    const sim = await installSimulatedLinnstrument({ bind: false });
    expect(linnstrumentStatus().kind).toBe('unbound');
    expect(sim.attached()).toBe(false);
    expect(containsRun(sim.writes(), USER_MODE_ON)).toBe(0);

    // The /preflight pick — a store write on the app's rig store, no
    // device-layer call: the layer's own subscription applies it.
    const store = rigBindings();
    store.setLinnstrument({ deviceId: sim.inputId });
    expect(sim.attached()).toBe(true);
    expect(linnstrumentStatus().kind).toBe('bound');
    expect(containsRun(sim.writes(), USER_MODE_ON)).toBe(1);

    // Clearing the binding on /preflight releases the port and restores mode.
    sim.clearWrites();
    store.setLinnstrument(null);
    expect(sim.attached()).toBe(false);
    expect(containsRun(sim.writes(), USER_MODE_OFF)).toBe(1);
    expect(linnstrumentStatus().kind).toBe('unbound');
  });

  it('a rig binding naming an ABSENT port stays unbound with an actionable message, and binds on plug', async () => {
    const store = new RigBindingStore(memBackend({ cameras: {}, outputs: {}, linnstrument: { deviceId: 'sim-linnstrument-in' } }));
    setRigBindingsForTests(store);
    await store.whenReady();
    const sim = await installSimulatedLinnstrument({ bind: false });
    // The rig names the sim's id and it IS present: connect applied it.
    expect(linnstrumentStatus().kind).toBe('bound');

    // Hot-unplug: the port stays enumerated with state 'disconnected' (the
    // Chromium shape); the layer releases WITHOUT a restore (nothing to send to).
    sim.clearWrites();
    sim.unplug();
    expect(sim.attached()).toBe(false);
    expect(linnstrumentStatus().kind).toBe('no-port');
    expect(linnstrumentStatus().message).toMatch(/sim-linnstrument-in/);
    expect(events.at(-1)).toMatchObject({ kind: 'session', state: 'disconnected' });
    expect(containsRun(sim.writes(), USER_MODE_OFF)).toBe(0);

    // Re-plug: the same id comes back → re-bound, User Mode re-entered, new epoch.
    const epochBefore = linnstrumentStatus().epoch;
    sim.plug();
    expect(sim.attached()).toBe(true);
    expect(linnstrumentStatus().kind).toBe('bound');
    expect(containsRun(sim.writes(), USER_MODE_ON)).toBe(1);
    expect(linnstrumentStatus().epoch).toBeGreaterThan(epochBefore);
  });

  it('under the SHELL a connect with NO rig pick binds nothing on its own — the /preflight pick is the authority', async () => {
    setNativeAvailableForTests(true);
    const sim = await installSimulatedLinnstrument({ bind: false });
    expect(linnstrumentStatus().kind).toBe('unbound');
    expect(linnstrumentStatus().message).toMatch(/rig setup \(\/preflight\)/);
    expect(sim.attached()).toBe(false);
    expect(rigBindings().getLinnstrument()).toBeNull();
    // Even the explicit sim bind (what a test does) records NO pick: only the
    // operator's /preflight choice writes the shell's store.
    expect(bindLinnstrument(sim.inputId)).toBe(true);
    expect(rigBindings().getLinnstrument()).toBeNull();
  });

  it('a factory-style consumer never prompts: subscribing costs nothing and connect is the only gate', () => {
    // No access, no binding: the registry hands a late subscriber the
    // disconnected snapshot and nothing else happens (trails convention 2).
    expect(linnstrumentStatus().kind).toBe('idle');
    expect(events).toEqual([{ kind: 'session', epoch: 0, state: 'disconnected', userMode: false, time: 0 }]);
  });
});

describe('V01 geometry on the real onmidimessage path', () => {
  it('wire columns 1 / 17 / 25 land in keys (0,0), control R and pad (24,7)', async () => {
    const sim = await installSimulatedLinnstrument();
    const v = vector('V01');
    v.bytes.forEach((m, i) => sim.send(m, 1000 + i));
    const surface = events.filter((e) => e.kind !== 'session');
    // keys touch_start; control_edge; pad touch_start + its pointer candidate.
    expect(surface).toHaveLength(4);
    expect(surface[0]).toMatchObject({ kind: 'touch_start', region: 'keys', col: 0, row: 0, localCol: 0, localRow: 0, note: 36 });
    expect(surface[1]).toMatchObject({ kind: 'control_edge', control: 'r', down: true });
    expect(surface[2]).toMatchObject({ kind: 'touch_start', region: 'pad', col: 24, row: 7, localCol: 7, localRow: 7 });
    expect(surface[3]).toMatchObject({ kind: 'pointer', phase: 'down' });
    // The sim's app-coordinate helper spells the same wire bytes (the corpus
    // left (0,0) held — a second press there is a duplicate and rejected).
    sim.release(0, 0);
    events.length = 0;
    sim.touch(0, 0);
    expect(events[0]).toMatchObject({ kind: 'touch_start', region: 'keys', col: 0, row: 0 });
    // Negative control: the corpus' own corrupted byte is a different cell.
    events.length = 0;
    const bad = v.bytes[v.negativeControl.message]!.slice();
    bad[v.negativeControl.byte] = v.negativeControl.value;
    sim.send(bad, 2000);
    expect(events.some((e) => e.kind === 'control_edge')).toBe(false);
  });

  it('a pad touch with X/Y/Z produces expression + pointer, all stamped with ONE projected time', async () => {
    const ctx = { currentTime: 10 };
    setLinnstrumentAudioClock(ctx, { nowMs: () => 5000 });
    expect(linnstrumentTimeDomain()).toBe('audio');
    const sim = await installSimulatedLinnstrument();
    events.length = 0;
    // performance.now() is 5000 ms; the event was stamped 4990 → lag 10 ms,
    // so the projection is timestamp + offset + the SHARED 25 ms lookahead.
    sim.send([0x90 | 3, 20, 100], 4990);
    const expected = 4990 / 1000 + (10 - 5) + TIMESTAMP_LOOKAHEAD_S;
    expect(events).toHaveLength(2);
    for (const e of events) expect(e.time).toBeCloseTo(expected, 9);
    expect(events[0]).toMatchObject({ kind: 'touch_start', region: 'pad', col: 19, row: 3 });
    expect(events[1]).toMatchObject({ kind: 'pointer', phase: 'down' });
    events.length = 0;
    sim.move(19, 3, { x: 3000, y: 64, z: 90 });
    expect(events.filter((e) => e.kind === 'touch_expression')).toHaveLength(3);
    expect(events.filter((e) => e.kind === 'pointer' && e.phase === 'move')).toHaveLength(2); // X and Y move it; Z does not
    expect(events.find((e) => e.kind === 'touch_expression' && e.pressure !== undefined)).toMatchObject({ pressure: 90 / 127 });
  });

  it('without an audio clock, time is performance seconds', async () => {
    expect(linnstrumentTimeDomain()).toBe('performance');
    const sim = await installSimulatedLinnstrument();
    events.length = 0;
    sim.send([0x90, 1, 100], 1234);
    expect(events[0]!.time).toBeCloseTo(1.234, 9);
  });
});

describe('V11 boundary — the slide transaction survives the device layer', () => {
  it('a keys-origin slide into the selector column ends the gesture and never toggles or paints', async () => {
    const sim = await installSimulatedLinnstrument();
    sim.clearWrites();
    events.length = 0;
    const v = vector('V11');
    v.bytes.forEach((m, i) => sim.send(m, 1000 + i));
    expect(events.filter((e) => e.kind === 'control_edge')).toHaveLength(0);
    expect(events.filter((e) => e.kind === 'touch_start')).toHaveLength(1);
    expect(events.filter((e) => e.kind === 'touch_end')).toEqual([
      expect.objectContaining({ region: 'keys', reason: 'boundary' }),
    ]);
    await flush();
    expect(controlCells(sim.writes())).toHaveLength(0); // the selector column is never painted by a slide into it
  });

  it('a slide INSIDE the keys region keeps the touch id and never re-attacks', async () => {
    const sim = await installSimulatedLinnstrument();
    events.length = 0;
    sim.touch(3, 2);
    const touch = (events[0] as { touch: number }).touch;
    sim.slide(3, 4, 2);
    expect(events.filter((e) => e.kind === 'touch_start')).toHaveLength(1);
    expect(events.filter((e) => e.kind === 'touch_slide')).toEqual([
      expect.objectContaining({ touch, region: 'keys', fromCol: 3, toCol: 4, row: 2 }),
    ]);
    sim.release(4, 2);
    expect(events.at(-1)).toMatchObject({ kind: 'touch_end', touch, reason: 'release' });
  });
});

describe('V14 epoch — rejected bytes never reach the source registry', () => {
  it('a stale queued Note Off after the NRPN 245 readback is rejected and counted, not published', async () => {
    const sim = await installSimulatedLinnstrument();
    sim.send([0x90, 3, 100], 1000); // a held cell
    const epochBefore = linnstrumentStatus().epoch;
    events.length = 0;
    sim.clearWrites();
    sim.ackUserMode(true); // the firmware's mode notification → new session
    expect(events.filter((e) => e.kind === 'touch_end' && e.reason === 'session')).toHaveLength(1);
    expect(events.filter((e) => e.kind === 'session' && e.state === 'mode_changed')).toHaveLength(1);
    expect(linnstrumentStatus().epoch).toBe(epochBefore + 1);
    // The readback resets the axis enables (design.md:188) → re-armed.
    expect(sim.writes().some((m) => m[1] === CC_ROW_X_ENABLE)).toBe(true);

    const published = events.length;
    const rejectedBefore = linnstrumentDiagnostics().rejected;
    sim.send([0x80, 3, 0], 1001); // the pre-disconnect release arrives late
    expect(events.length).toBe(published);
    expect(linnstrumentDiagnostics().rejected).toBe(rejectedBefore + 1);
  });

  it('malformed / high-bit / unknown-status bytes are rejected on the wire and never published', async () => {
    const sim = await installSimulatedLinnstrument();
    events.length = 0;
    const before = linnstrumentDiagnostics().rejected;
    sim.send([0x90, 1], 1000); // short
    sim.send([0x90, 0x81, 100], 1001); // high-bit data
    sim.send([0xf8], 1002); // real-time: not this device's vocabulary
    sim.send([0xb0, 119, 40], 1003); // slide from a column that does not exist
    expect(events).toHaveLength(0);
    expect(linnstrumentDiagnostics().rejected).toBe(before + 4);
  });
});

describe('the LED writer paints acknowledged state and never decides', () => {
  const ackFrom = (state: SelectionState) => publishLinnstrumentSelection(state);

  it('a hardware selector press paints NOTHING until the reducer acknowledges it', async () => {
    const sim = await installSimulatedLinnstrument();
    sim.clearWrites();
    sim.touch(16, 7); // the R cell
    await flush();
    expect(events.some((e) => e.kind === 'control_edge' && e.control === 'r')).toBe(true);
    expect(ledWrites(sim.writes())).toHaveLength(0);

    // The runtime (WP-C) reduces and acknowledges → the writer paints.
    const state = reduceAll(createSelectionState(DEFAULT_LINN_PROFILE), [{ kind: 'set_selector', selector: 'g', on: true }], DEFAULT_LINN_PROFILE).state;
    ackFrom(state);
    expect(ledWrites(sim.writes())).toHaveLength(0); // coalesced: nothing yet in this tick
    await flush();
    const w = ledWrites(sim.writes());
    // One contiguous CC20/21/22 triple per CONTROL cell of the frame — the
    // musical cells were painted on bind and diff to nothing.
    const frame = ledFrame(state, DEFAULT_LINN_PROFILE).filter((c) => c.wireCol === CONTROL_WIRE_COL);
    expect(frame).toHaveLength(Object.keys(DEFAULT_LINN_PROFILE.controlRows).length);
    expect(w).toHaveLength(frame.length * 3);
    for (const cell of frame) {
      expect(containsRun(w, [[0xb0, CC_LED_COLUMN, cell.wireCol], [0xb0, CC_LED_ROW, cell.ledRow], [0xb0, CC_LED_COLOR, cell.color]])).toBe(1);
    }
    // Geometry: the control column is wire 17 (app 16) and R is LED row 7 (no +1 on rows).
    const r = frame.find((c) => c.ledRow === 7)!;
    expect(r).toMatchObject({ wireCol: 17, ledRow: 7, color: DEFAULT_LINN_PROFILE.palette.red });
    expect(frame.find((c) => c.ledRow === 6)).toMatchObject({ color: DEFAULT_LINN_PROFILE.palette.green });
    expect(frame.find((c) => c.ledRow === 5)).toMatchObject({ color: DEFAULT_LINN_PROFILE.palette.off });
  });

  it('two acks in one tick coalesce into one diffed repaint carrying the FINAL state', async () => {
    const sim = await installSimulatedLinnstrument();
    const base = createSelectionState(DEFAULT_LINN_PROFILE);
    ackFrom(base);
    await flush();
    sim.clearWrites();
    const s1 = reduceAll(base, [{ kind: 'set_selector', selector: 'b', on: true }], DEFAULT_LINN_PROFILE).state;
    const s2 = reduceAll(s1, [{ kind: 'set_selector', selector: 'r', on: false }], DEFAULT_LINN_PROFILE).state;
    ackFrom(s1);
    ackFrom(s2);
    await flush();
    const w = ledWrites(sim.writes());
    // Exactly the two changed cells (B on, R off), each once, nothing for G or the lower five.
    expect(w).toHaveLength(6);
    expect(containsRun(w, [[0xb0, CC_LED_COLUMN, 17], [0xb0, CC_LED_ROW, 5], [0xb0, CC_LED_COLOR, DEFAULT_LINN_PROFILE.palette.blue]])).toBe(1);
    expect(containsRun(w, [[0xb0, CC_LED_COLUMN, 17], [0xb0, CC_LED_ROW, 7], [0xb0, CC_LED_COLOR, DEFAULT_LINN_PROFILE.palette.off]])).toBe(1);
    // An identical ack repaints nothing.
    sim.clearWrites();
    ackFrom(s2);
    await flush();
    expect(ledWrites(sim.writes())).toHaveLength(0);
  });

  it('repaints from the last acknowledged state after a re-bind', async () => {
    const sim = await installSimulatedLinnstrument();
    const state = reduceAll(createSelectionState(DEFAULT_LINN_PROFILE), [{ kind: 'set_selector', selector: 'b', on: true }], DEFAULT_LINN_PROFILE).state;
    ackFrom(state);
    await flush();
    unbindLinnstrument();
    sim.clearWrites();
    bindLinnstrument(sim.inputId);
    await flush();
    expect(ledWrites(sim.writes())).toHaveLength(ledFrame(state, DEFAULT_LINN_PROFILE).length * 3);
  });

  it('extra controls OFF leaves the lower five unlit (D17 is a recommendation, not a ruling)', () => {
    const p = { ...DEFAULT_LINN_PROFILE, extraControlsEnabled: false };
    const column = (frame: ReturnType<typeof ledFrame>) => frame.filter((c) => c.wireCol === CONTROL_WIRE_COL && c.ledRow <= 4);
    expect(column(ledFrame(createSelectionState(p), p))).toHaveLength(5);
    expect(column(ledFrame(createSelectionState(p), p)).every((c) => c.color === p.palette.off)).toBe(true);
    expect(column(ledFrame(createSelectionState(DEFAULT_LINN_PROFILE), DEFAULT_LINN_PROFILE)).every((c) => c.color === DEFAULT_LINN_PROFILE.palette.orange)).toBe(true);
  });
});

describe('the LED writer lights the KEYS and the PAD from the module\'s roots and scale (D09: lighting, not playability)', () => {
  const P = DEFAULT_LINN_PROFILE;
  const at = (frame: ReturnType<typeof musicalFrame>, col: number, row: number) => frame.find((c) => c.wireCol === col + 1 && c.ledRow === row)!;

  it('chromatic (the default): every root of the region is cyan, everything else green; keys and pad each against THEIR root', () => {
    const frame = musicalFrame(P, lightingFromProfile(P));
    expect(frame).toHaveLength(MUSICAL_CELLS);
    // keys root 36 at (0,0): +1 per column, +5 per row (D09).
    expect(at(frame, 0, 0).color).toBe(P.palette.cyan); // 36
    expect(at(frame, 1, 0).color).toBe(P.palette.green); // 37 — chromatic: in scale
    expect(at(frame, 12, 0).color).toBe(P.palette.cyan); // 48
    expect(at(frame, 2, 2).color).toBe(P.palette.cyan); // 36 + 2 + 10 = 48
    expect(at(frame, 7, 1).color).toBe(P.palette.cyan); // 36 + 7 + 5 = 48
    // pad root 60 at app (17,0) — the pad's OWN root, not the keyboard's continuation.
    expect(at(frame, 17, 0).color).toBe(P.palette.cyan); // 60
    expect(at(frame, 18, 0).color).toBe(P.palette.green); // 61
    expect(at(frame, 19, 2).color).toBe(P.palette.cyan); // 60 + 2 + 10 = 72
    // Never a control-column cell, never a wire column outside 1..25.
    expect(frame.some((c) => c.wireCol === CONTROL_WIRE_COL)).toBe(false);
    expect(frame.every((c) => c.wireCol >= 1 && c.wireCol <= 25 && c.ledRow >= 0 && c.ledRow <= 7)).toBe(true);
  });

  it('a scale darkens the out-of-scale cells and leaves them PLAYABLE (the frame is lights only)', () => {
    const frame = musicalFrame(P, { keysRoot: 36, padRoot: 60, scale: 'major' });
    expect(at(frame, 0, 0).color).toBe(P.palette.cyan); // C
    expect(at(frame, 1, 0).color).toBe(P.palette.off); // C# — out of C major, dark
    expect(at(frame, 2, 0).color).toBe(P.palette.green); // D
    expect(at(frame, 4, 0).color).toBe(P.palette.green); // E
    expect(at(frame, 5, 0).color).toBe(P.palette.green); // F
    expect(at(frame, 6, 0).color).toBe(P.palette.off); // F#
    expect(at(frame, 18, 0).color).toBe(P.palette.off); // pad 61 = C# against the pad's C root
  });

  it('a cell whose note leaves MIDI is off; a played cell is white on top of its role', () => {
    const high = musicalFrame(P, { keysRoot: 96, padRoot: 60, scale: undefined });
    expect(at(high, 15, 7).color).toBe(P.palette.off); // 96 + 15 + 35 = 146
    expect(at(high, 0, 0).color).toBe(P.palette.cyan); // 96
    const played = musicalFrame(P, lightingFromProfile(P), [{ col: 0, row: 0 }, { col: 18, row: 3 }]);
    expect(at(played, 0, 0).color).toBe(P.palette.white);
    expect(at(played, 18, 3).color).toBe(P.palette.white);
    expect(at(played, 1, 0).color).toBe(P.palette.green);
  });

  it('the roles are PROFILE DATA (hardware-verify, D18): swapping a role word repaints without touching the writer', () => {
    const lime = { ...P, lighting: { ...P.lighting, inScale: 'lime' as const, played: 'pink' as const } };
    const frame = musicalFrame(lime, lightingFromProfile(lime), [{ col: 2, row: 0 }]);
    expect(at(frame, 1, 0).color).toBe(P.palette.lime);
    expect(at(frame, 2, 0).color).toBe(P.palette.pink);
  });

  it('on the wire: a keys touch paints its cell white, a slide moves the mark, a release restores the role — through the diff', async () => {
    const sim = await installSimulatedLinnstrument();
    await flush();
    sim.clearWrites();
    sim.touch(3, 2);
    await flush();
    expect(paintedCells(sim.writes())).toEqual([{ wireCol: 4, ledRow: 2, color: P.palette.white }]);
    sim.clearWrites();
    sim.move(3, 2, { z: 90, y: 30 }); // expression alone repaints nothing
    await flush();
    expect(paintedCells(sim.writes())).toEqual([]);
    sim.slide(3, 4, 2);
    await flush();
    expect(paintedCells(sim.writes())).toEqual([
      { wireCol: 4, ledRow: 2, color: at(musicalFrame(P, lightingFromProfile(P)), 3, 2).color },
      { wireCol: 5, ledRow: 2, color: P.palette.white },
    ]);
    sim.clearWrites();
    sim.release(4, 2);
    await flush();
    expect(paintedCells(sim.writes())).toEqual([{ wireCol: 5, ledRow: 2, color: at(musicalFrame(P, lightingFromProfile(P)), 4, 2).color }]);
    // A control-column touch is not a played cell: nothing painted until an ack.
    sim.clearWrites();
    sim.touch(16, 0);
    await flush();
    expect(paintedCells(sim.writes())).toEqual([]);
  });

  it('the module\'s lighting wins over the profile: published BEFORE the source exists it is replayed on install, and a later publish repaints the diff', async () => {
    // On a fourths grid the ROOT pattern is root-invariant (cell (c,r) is
    // root + c + 5r, so which cells are roots never depends on the root); the
    // discriminator between the module's lighting and the profile's chromatic
    // fallback is the SCALE.
    publishLinnstrumentLighting({ keysRoot: 36, padRoot: 60, scale: 'major' });
    const sim = await installSimulatedLinnstrument();
    await flush();
    const first = paintedCells(sim.writes());
    expect(first).toHaveLength(MUSICAL_CELLS);
    expect(first.find((c) => c.wireCol === 1 && c.ledRow === 0)!.color).toBe(P.palette.cyan); // app (0,0) = 36, the root
    expect(first.find((c) => c.wireCol === 2 && c.ledRow === 0)!.color).toBe(P.palette.off); // app (1,0) = 37, C# — out of C major, NOT the chromatic fallback's green
    expect(first.find((c) => c.wireCol === 3 && c.ledRow === 0)!.color).toBe(P.palette.green); // app (2,0) = 38, D
    sim.clearWrites();
    publishLinnstrumentLighting({ keysRoot: 36, padRoot: 60, scale: undefined });
    await flush();
    const cells = paintedCells(sim.writes());
    expect(cells.length).toBeGreaterThan(0);
    expect(cells.length).toBeLessThan(MUSICAL_CELLS); // a diff, not a full repaint
    expect(cells.find((c) => c.wireCol === 2 && c.ledRow === 0)!.color).toBe(P.palette.green); // 37 is in scale again
    expect(cells.find((c) => c.wireCol === 1 && c.ledRow === 0)).toBeUndefined(); // the root was cyan in both frames: not in the diff
    expect(cells.find((c) => c.wireCol === 3 && c.ledRow === 0)).toBeUndefined(); // D was green in both
    // An identical publish repaints nothing.
    sim.clearWrites();
    publishLinnstrumentLighting({ keysRoot: 36, padRoot: 60, scale: undefined });
    await flush();
    expect(paintedCells(sim.writes())).toEqual([]);
  });
});

// ── THE BROWSER BINDS BY NAME (owner ruling 2026-09-15) ─────────────────────
//
// /preflight is a native-shell feature; on the web the face's CONNECT is the
// whole gesture. `installSimulatedLinnstrument()` IS `connectLinnstrument()`
// against an in-memory access, so every leg below is the real connect path:
// the /linnstrument/i match, the claim, the NRPN 245 entry, and the rig-store
// write that makes the next CONNECT after a reload bind the same port.
describe('the browser binds by NAME when there is no rig pick', () => {
  it('connect alone binds the LinnStrument port, enters User Firmware Mode, and RECORDS the pick in the rig store', async () => {
    const backend = memBackend();
    setRigBindingsForTests(new RigBindingStore(backend));
    expect(rigBindings().getLinnstrument()).toBeNull();
    const sim = await installSimulatedLinnstrument();
    // Bound through resolvePorts (viaRig), not the sim's explicit fallback:
    // the discriminator is the RECORDED pick — the explicit path never writes.
    expect(linnstrumentStatus().kind).toBe('bound');
    expect(linnstrumentStatus().boundPortName).toBe(sim.portName);
    expect(sim.attached()).toBe(true);
    expect(containsRun(sim.writes(), USER_MODE_ON)).toBe(1);
    expect(rigBindings().getLinnstrument()).toEqual({ deviceId: sim.inputId });
    expect(backend.saved.at(-1)?.linnstrument).toEqual({ deviceId: sim.inputId });
    // The recorded pick re-enters resolvePorts through the rig subscription:
    // ONE entry transaction, one session — idempotent.
    await flush();
    expect(containsRun(sim.writes(), USER_MODE_ON)).toBe(1);
    expect(events.filter((e) => e.kind === 'session' && e.state === 'connected')).toHaveLength(1);
  });

  it('a recorded port that is GONE while another LinnStrument is present re-binds by name and re-records', async () => {
    const store = new RigBindingStore(memBackend({ cameras: {}, outputs: {}, linnstrument: { deviceId: 'stale-port-id' } }));
    setRigBindingsForTests(store);
    await store.whenReady();
    const sim = await installSimulatedLinnstrument();
    expect(linnstrumentStatus().kind).toBe('bound');
    expect(sim.attached()).toBe(true);
    expect(rigBindings().getLinnstrument()).toEqual({ deviceId: sim.inputId });
  });

  it('several LinnStrument ports: the FIRST by name is bound and the others are named in the status line', async () => {
    const sim = await installSimulatedLinnstrument({ decoyPortName: 'LinnStrument MIDI 2' });
    expect(linnstrumentStatus().kind).toBe('bound');
    expect(linnstrumentStatus().boundPortName).toBe('LinnStrument MIDI');
    expect(linnstrumentStatus().portNames).toEqual(['LinnStrument MIDI', 'LinnStrument MIDI 2']);
    expect(linnstrumentStatus().message).toMatch(/not bound: LinnStrument MIDI 2/);
    expect(rigBindings().getLinnstrument()).toEqual({ deviceId: sim.inputId });
  });

  it('a decoy that does NOT match the pattern is never bound and never named', async () => {
    const sim = await installSimulatedLinnstrument({ decoyPortName: 'Ableton Push 2 Live Port' });
    expect(linnstrumentStatus().boundPortName).toBe(sim.portName);
    expect(linnstrumentStatus().message).not.toMatch(/Push 2/);
    expect(listLinnstrumentPorts().map((p) => p.name)).toEqual(['LinnStrument MIDI']);
  });

  it('the sim\'s { bind: false } switches the bind-by-name OFF: a granted-but-UNBOUND access stays possible as a negative control', async () => {
    const sim = await installSimulatedLinnstrument({ bind: false });
    expect(linnstrumentStatus().kind).toBe('unbound');
    expect(linnstrumentStatus().message).toMatch(/Press CONNECT to bind/);
    expect(sim.attached()).toBe(false);
    expect(rigBindings().getLinnstrument()).toBeNull();
    expect(containsRun(sim.writes(), USER_MODE_ON)).toBe(0);
    // A plug event does not bind either — the knob is for the sim's lifetime.
    sim.unplug();
    sim.plug();
    expect(sim.attached()).toBe(false);
    // …and uninstall restores the product policy for the next install.
    sim.uninstall();
    const again = await installSimulatedLinnstrument();
    expect(again.attached()).toBe(true);
    expect(rigBindings().getLinnstrument()).toEqual({ deviceId: again.inputId });
  });

  it('a hot-plug AFTER connect binds by name in the browser (CONNECT was the gesture; the port arrived later)', async () => {
    const sim = await installSimulatedLinnstrument({ bind: false });
    // Re-arm the product policy without re-connecting: a fresh sim with the
    // default option re-uses the same connect path, so drive the plug through it.
    sim.uninstall();
    const late = await installSimulatedLinnstrument();
    late.unplug();
    expect(late.attached()).toBe(false);
    expect(linnstrumentStatus().kind).toBe('no-port');
    late.plug();
    expect(late.attached()).toBe(true);
    expect(linnstrumentStatus().kind).toBe('bound');
    expect(rigBindings().getLinnstrument()).toEqual({ deviceId: late.inputId });
  });
});
