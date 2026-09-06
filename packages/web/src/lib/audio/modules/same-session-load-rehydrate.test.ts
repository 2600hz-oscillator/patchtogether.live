// packages/web/src/lib/audio/modules/same-session-load-rehydrate.test.ts
//
// THE HYDRATE-ONCE FAMILY — fleet audit 2026-09-06, findings #4 and #8.
//
// A module factory reads its discrete settings off `node.data` once. The
// reconciler re-materializes a node ONLY on id-absence or a type/domain change
// and never diffs `data`; a same-session load (`loadEnvelopeIntoStore`
// deleting and re-inserting every node at the SAME id in one transaction)
// therefore leaves every engine handle holding the PREVIOUS patch's settings
// while the doc shows the loaded ones. These tests drive the REAL Y.Doc store
// the way that loader does — delete + re-insert at the same id in one
// transaction — and assert the module's OUTPUT follows the loaded patch:
// a gate that rises for the loaded channel and not the old one, clock pulses
// at the loaded division, MIDI bytes on the loaded channel, setSinkId called
// with the loaded device. Presence of the new data in the doc is never the
// assertion; that was always true and is exactly how this shipped.
//
// Real store per [[yjs-save-load-real-ydoc]]: the watcher reads
// `livePatch.nodes[id]` and a plain-object fixture would prove nothing about
// that path. Fake timers drive the poll; the audio graph is a recording fake.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { patch, ydoc, LOCAL_ORIGIN } from '$lib/graph/store';
import type { ModuleNode } from '$lib/graph/types';
import { watchLiveNodeData, LIVE_DATA_POLL_MS } from '$lib/audio/live-node-data';
// (`ModuleNode` is the projection's input; the store is the real Y.Doc.)
import {
  midiCvBuddyDef,
  midiCvBuddyHydrateOf,
  type MidiCvBuddyApi,
  type MidiAccessLike,
  type MidiEventLike,
  type MidiInputLike,
} from './midi-cv-buddy';
import { midiLaneDef, midiLaneHydrateOf, type MidiLaneApi } from './midi-lane';
import { midiOutBuddyDef, midiOutBuddyHydrateOf, type MidiOutBuddyApi } from './midi-out-buddy';
import { midiclockDef, midiclockHydrateOf, type MidiclockApi } from './midiclock';
import { audioOutDef, audioOutSinkPickOf } from './audio-out';
import { SCHEDULER_TICK_MS } from '$lib/audio/scheduler-clock';

// ---------------------------------------------------------------------------
// The store: spawn / same-session load / despawn, all at ONE id
// ---------------------------------------------------------------------------

function spawn(node: ModuleNode): void {
  ydoc.transact(() => {
    patch.nodes[node.id] = node;
  }, LOCAL_ORIGIN);
}

/** What `loadEnvelopeIntoStore` does to a reused id: delete + re-insert in
 *  ONE transaction. The engine handle is not rebuilt; only the doc moved. */
function sameSessionLoad(node: ModuleNode): void {
  ydoc.transact(() => {
    delete patch.nodes[node.id];
    patch.nodes[node.id] = node;
  }, LOCAL_ORIGIN);
}

function despawn(id: string): void {
  if (!patch.nodes[id]) return;
  ydoc.transact(() => {
    delete patch.nodes[id];
  }, LOCAL_ORIGIN);
}

function node(
  id: string,
  type: string,
  data: Record<string, unknown> = {},
  params: Record<string, number> = {},
): ModuleNode {
  return { id, type, domain: 'audio', position: { x: 0, y: 0 }, params, data } as ModuleNode;
}

/** One poll tick. */
function poll(): void {
  vi.advanceTimersByTime(LIVE_DATA_POLL_MS);
}

// ---------------------------------------------------------------------------
// The recording audio graph
// ---------------------------------------------------------------------------

interface Sched { kind: 'cancel' | 'set'; value?: number; time: number }

function makeParam(initial = 0) {
  const events: Sched[] = [];
  const p = {
    value: initial,
    events,
    setValueAtTime(v: number, t: number) { p.value = v; events.push({ kind: 'set', value: v, time: t }); return p; },
    cancelScheduledValues(t: number) { events.push({ kind: 'cancel', time: t }); return p; },
    linearRampToValueAtTime(v: number, t: number) { events.push({ kind: 'set', value: v, time: t }); return p; },
  };
  return p;
}

class FakeNode {
  connect = vi.fn(() => this);
  disconnect = vi.fn();
}
class FakeConstantSource extends FakeNode {
  offset = makeParam(0);
  start = vi.fn();
  stop = vi.fn();
}
class FakeGain extends FakeNode {
  gain = makeParam(1);
}
/** An analyser whose time-domain buffer is whatever the test says it is. */
class FakeAnalyser extends FakeNode {
  fftSize = 2048;
  smoothingTimeConstant = 0;
  level = 0;
  getFloatTimeDomainData(buf: Float32Array): void { buf.fill(this.level); }
}

function makeCtx() {
  const analysers: FakeAnalyser[] = [];
  const ctx = {
    currentTime: 0,
    sampleRate: 48_000,
    destination: new FakeNode(),
    audioWorklet: { addModule: async () => Promise.reject(new Error('no worklet in this lane')) },
    createConstantSource: () => new FakeConstantSource(),
    createGain: () => new FakeGain(),
    createAnalyser: () => { const a = new FakeAnalyser(); analysers.push(a); return a; },
    createChannelMerger: () => new FakeNode(),
    createChannelSplitter: () => new FakeNode(),
    createBiquadFilter: () => ({ ...new FakeNode(), type: '', frequency: makeParam(0), Q: makeParam(0) }),
    createWaveShaper: () => ({ ...new FakeNode(), curve: null, oversample: 'none' }),
  };
  return { ctx, analysers };
}

function gateHighs(src: FakeConstantSource): number {
  return src.offset.events.filter((e) => e.kind === 'set' && e.value === 1).length;
}

// ---------------------------------------------------------------------------
// The fake Web MIDI access
// ---------------------------------------------------------------------------

function makeMidiInput(id: string, name = id): MidiInputLike & { fire: (ev: MidiEventLike) => void } {
  let handler: ((ev: MidiEventLike) => void) | null = null;
  return {
    id, name, state: 'connected',
    get onmidimessage() { return handler; },
    set onmidimessage(fn) { handler = fn as ((ev: MidiEventLike) => void) | null; },
    fire(ev) { if (handler) handler(ev); },
  };
}

function makeMidiAccess(inputs: ReturnType<typeof makeMidiInput>[], outputs: Array<{ id: string; name: string; sent: number[][] }> = []) {
  const ins = new Map<string, MidiInputLike>();
  for (const i of inputs) ins.set(i.id, i);
  const outs = new Map<string, { id: string; name: string; state: string; send: (b: number[]) => void }>();
  for (const o of outputs) outs.set(o.id, { id: o.id, name: o.name, state: 'connected', send: (b) => { o.sent.push([...b]); } });
  return { inputs: ins, outputs: outs, onstatechange: null } as unknown as MidiAccessLike;
}

let originalRequestMIDIAccess: unknown;
function installFakeMidi(access: MidiAccessLike): void {
  const g = globalThis as unknown as { navigator?: Record<string, unknown> };
  if (!g.navigator) g.navigator = {};
  originalRequestMIDIAccess = g.navigator.requestMIDIAccess;
  g.navigator.requestMIDIAccess = vi.fn(async () => access);
}
function restoreMidi(): void {
  const g = globalThis as unknown as { navigator?: Record<string, unknown> };
  if (!g.navigator) return;
  if (originalRequestMIDIAccess === undefined) delete g.navigator.requestMIDIAccess;
  else g.navigator.requestMIDIAccess = originalRequestMIDIAccess;
}

const NOTE_ON = (ch0: number, note = 60, vel = 100) => new Uint8Array([0x90 | ch0, note, vel]);
const NOTE_OFF = (ch0: number, note = 60) => new Uint8Array([0x80 | ch0, note, 0]);

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.useFakeTimers();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// 1. The seam
// ---------------------------------------------------------------------------

describe('watchLiveNodeData — the one re-hydrate seam', () => {
  const ID = 'live-watch-seam';
  afterEach(() => despawn(ID));
  type P = { id: string | null };
  const projectId = (n: ModuleNode): P => ({
    id: ((n.data ?? {}) as { lastDeviceId?: string }).lastDeviceId ?? null,
  });

  it('fires when the DOC differs from the ENGINE, once per real change, and is quiet while equal', () => {
    spawn(node(ID, 'midiclock', { lastDeviceId: 'a' }));
    let engine: string | null = 'a';
    const seen: Array<[string | null, string | null]> = [];
    const stop = watchLiveNodeData<P>({
      nodeId: ID,
      project: projectId,
      current: () => ({ id: engine }),
      onChange: (next, cur) => { seen.push([next.id, cur.id]); engine = next.id; },
    });
    poll(); poll();
    expect(seen, 'doc == engine never fires').toEqual([]);
    // The reused-id load shape, SAME data: a new proxy, an equal value.
    sameSessionLoad(node(ID, 'midiclock', { lastDeviceId: 'a' }));
    poll();
    expect(seen, 'a re-insert with equal data is not a change').toEqual([]);
    sameSessionLoad(node(ID, 'midiclock', { lastDeviceId: 'b' }));
    poll(); poll();
    expect(seen, 'once, with the doc value and the engine value').toEqual([['b', 'a']]);
    stop();
    sameSessionLoad(node(ID, 'midiclock', { lastDeviceId: 'c' }));
    poll();
    expect(seen, 'stopped: nothing after dispose').toEqual([['b', 'a']]);
  });

  it('⚠ THE WRITE RACE: the engine moved through its own api and the doc round-tripped inside ONE poll', () => {
    // The audio-out e2e caught this on its first run against a "last seen"
    // baseline: picker write → engine B, persist → doc B, load v1 → doc A,
    // all between two ticks. Last-seen was A, the doc read A, nothing looked
    // changed, and the engine sat on B. Doc-vs-ENGINE has no such window.
    spawn(node(ID, 'midiclock', { lastDeviceId: 'a' }));
    let engine: string | null = 'a';
    const seen: Array<string | null> = [];
    const stop = watchLiveNodeData<P>({
      nodeId: ID,
      project: projectId,
      current: () => ({ id: engine }),
      onChange: (next) => { seen.push(next.id); engine = next.id; },
    });
    poll();
    expect(seen).toEqual([]);
    engine = 'b'; // the surface's api call…
    sameSessionLoad(node(ID, 'midiclock', { lastDeviceId: 'b' })); // …and its persist
    sameSessionLoad(node(ID, 'midiclock', { lastDeviceId: 'a' })); // a load of v1, before any tick
    poll();
    expect(seen, 'the doc says a, the engine holds b: re-applied').toEqual(['a']);
    expect(engine).toBe('a');
    stop();
  });

  it('a node ABSENT from the graph is skipped, not treated as a change', () => {
    let engine: string | null = 'a';
    const seen: unknown[] = [];
    const stop = watchLiveNodeData<P>({
      nodeId: ID,
      project: projectId,
      current: () => ({ id: engine }),
      onChange: (next) => { seen.push(next.id); engine = next.id; },
    });
    poll();
    expect(seen).toEqual([]);
    spawn(node(ID, 'midiclock', { lastDeviceId: 'z' }));
    poll();
    expect(seen, 'once present with different data, it fires').toEqual(['z']);
    stop();
  });

  it('a custom `equal` can declare a key "no opinion" without the engine ever agreeing', () => {
    spawn(node(ID, 'midiclock', {}));
    const seen: unknown[] = [];
    const stop = watchLiveNodeData<{ legacy: number | null }>({
      nodeId: ID,
      project: (n) => ({ legacy: ((n.data ?? {}) as { divisor?: number }).divisor ?? null }),
      current: () => ({ legacy: 24 }),
      equal: (next, cur) => next.legacy === null || next.legacy === cur.legacy,
      onChange: (next) => seen.push(next.legacy),
    });
    poll(); poll();
    expect(seen, 'null vs 24 is not a change').toEqual([]);
    sameSessionLoad(node(ID, 'midiclock', { divisor: 6 }));
    poll();
    expect(seen).toEqual([6]);
    stop();
  });
});

// ---------------------------------------------------------------------------
// 2. midi-cv-buddy — channel filter + device follow the loaded patch
// ---------------------------------------------------------------------------

describe('midi-cv-buddy: a same-session load at a reused id re-hydrates', () => {
  const ID = 'mcb-reused';
  afterEach(() => { despawn(ID); restoreMidi(); });

  it('the GATE follows the LOADED channel filter, and the old channel goes quiet', async () => {
    const portA = makeMidiInput('port-a', 'Keys A');
    installFakeMidi(makeMidiAccess([portA]));
    const v1 = node(ID, 'midiCvBuddy', { midiInChannel: 0, lastDeviceId: 'port-a', lastDeviceName: 'Keys A' });
    spawn(v1);
    const { ctx } = makeCtx();
    const handle = await midiCvBuddyDef.factory(ctx as unknown as AudioContext, v1);
    const api = handle.read?.('card-api') as MidiCvBuddyApi;
    expect(await api.connect()).toBe(true);
    const gate = handle.outputs.get('gate')!.node as unknown as FakeConstantSource;

    // POSITIVE CONTROL: channel 1 drives the gate before the load.
    portA.fire({ data: NOTE_ON(0), timeStamp: 0 });
    expect(gateHighs(gate)).toBe(1);
    portA.fire({ data: NOTE_OFF(0), timeStamp: 1 });

    // Patch v2 at the SAME id: channel 5.
    sameSessionLoad(node(ID, 'midiCvBuddy', { midiInChannel: 4, lastDeviceId: 'port-a', lastDeviceName: 'Keys A' }));
    poll();

    portA.fire({ data: NOTE_ON(0), timeStamp: 2 });
    expect(gateHighs(gate), 'the PREVIOUS patch\'s channel no longer drives the gate').toBe(1);
    portA.fire({ data: NOTE_ON(4), timeStamp: 3 });
    expect(gateHighs(gate), 'the LOADED channel does').toBe(2);
    expect(api.getState().devices.length).toBe(1);
    handle.dispose();
  });

  it('the DEVICE follows the loaded patch by NAME when its saved id is stale', async () => {
    const portA = makeMidiInput('session2-a', 'Decoy A');
    const portB = makeMidiInput('session2-b', 'Target B');
    installFakeMidi(makeMidiAccess([portA, portB]));
    const v1 = node(ID, 'midiCvBuddy', { midiInChannel: null, lastDeviceId: 'session2-a', lastDeviceName: 'Decoy A' });
    spawn(v1);
    const { ctx } = makeCtx();
    const handle = await midiCvBuddyDef.factory(ctx as unknown as AudioContext, v1);
    const api = handle.read?.('card-api') as MidiCvBuddyApi;
    expect(await api.connect()).toBe(true);
    const gate = handle.outputs.get('gate')!.node as unknown as FakeConstantSource;
    portA.fire({ data: NOTE_ON(0), timeStamp: 0 });
    expect(gateHighs(gate)).toBe(1);
    portA.fire({ data: NOTE_OFF(0), timeStamp: 1 });

    // v2 was saved in a previous session: B's id has been regenerated since.
    sameSessionLoad(node(ID, 'midiCvBuddy', { midiInChannel: null, lastDeviceId: 'session1-b', lastDeviceName: 'Target B' }));
    poll();
    expect(api.getState().selectedDeviceId).toBe('session2-b');
    portA.fire({ data: NOTE_ON(0), timeStamp: 2 });
    expect(gateHighs(gate), 'the decoy port is released').toBe(1);
    portB.fire({ data: NOTE_ON(0), timeStamp: 3 });
    expect(gateHighs(gate), 'the loaded port drives the gate').toBe(2);
    handle.dispose();
  });

  it('⚠ THE WRITE RACE: the face set channel 5 and persisted it, then v1 loaded — inside ONE poll', async () => {
    const port = makeMidiInput('port-a', 'Keys A');
    installFakeMidi(makeMidiAccess([port]));
    const v1 = node(ID, 'midiCvBuddy', { midiInChannel: 0, lastDeviceId: 'port-a', lastDeviceName: 'Keys A' });
    spawn(v1);
    const { ctx } = makeCtx();
    const handle = await midiCvBuddyDef.factory(ctx as unknown as AudioContext, v1);
    const api = handle.read?.('card-api') as MidiCvBuddyApi;
    expect(await api.connect()).toBe(true);
    const gate = handle.outputs.get('gate')!.node as unknown as FakeConstantSource;
    poll();
    // The face: api + doc → channel 5. Then the load of v1 lands before a tick.
    api.setChannel(4);
    ydoc.transact(() => { (patch.nodes[ID]!.data as Record<string, unknown>).midiInChannel = 4; }, LOCAL_ORIGIN);
    sameSessionLoad(node(ID, 'midiCvBuddy', { midiInChannel: 0, lastDeviceId: 'port-a', lastDeviceName: 'Keys A' }));
    poll();
    port.fire({ data: NOTE_ON(4), timeStamp: 0 });
    expect(gateHighs(gate), 'channel 5 (the un-persisted engine state) is gone').toBe(0);
    port.fire({ data: NOTE_ON(0), timeStamp: 1 });
    expect(gateHighs(gate), 'channel 1 (the doc) drives the gate').toBe(1);
    handle.dispose();
  });

  it('the projection is exactly the hydrated keys — a lane column write is not one of them', () => {
    const a = midiCvBuddyHydrateOf(node(ID, 'midiCvBuddy', { midiInChannel: 2, channel: 5 }));
    const b = midiCvBuddyHydrateOf(node(ID, 'midiCvBuddy', { midiInChannel: 2, channel: 7 }));
    expect(a).toEqual(b);
  });
});

// ---------------------------------------------------------------------------
// 3. midi-lane — channel set, CC number and device follow the loaded patch
// ---------------------------------------------------------------------------

describe('midi-lane: a same-session load at a reused id re-hydrates', () => {
  const ID = 'mlane-reused';
  afterEach(() => { despawn(ID); restoreMidi(); });

  it('gate + cc_a follow the LOADED channel set and CC number', async () => {
    const port = makeMidiInput('port-a', 'Keys A');
    installFakeMidi(makeMidiAccess([port]));
    const v1 = node(ID, 'midiLane', { channels: [0], ccA: 1, lastDeviceId: 'port-a', lastDeviceName: 'Keys A' });
    spawn(v1);
    const { ctx } = makeCtx();
    const handle = await midiLaneDef.factory(ctx as unknown as AudioContext, v1);
    const api = handle.read?.('card-api') as MidiLaneApi;
    expect(await api.connect()).toBe(true);
    const gate = handle.outputs.get('gate')!.node as unknown as FakeConstantSource;
    const ccA = handle.outputs.get('cc_a')!.node as unknown as FakeConstantSource;

    port.fire({ data: NOTE_ON(0), timeStamp: 0 });
    expect(gateHighs(gate)).toBe(1);
    port.fire({ data: NOTE_OFF(0), timeStamp: 1 });
    port.fire({ data: new Uint8Array([0xb0, 1, 127]), timeStamp: 2 });
    const ccSetsBefore = ccA.offset.events.filter((e) => e.kind === 'set').length;
    expect(ccSetsBefore).toBeGreaterThan(0);

    sameSessionLoad(node(ID, 'midiLane', { channels: [9], ccA: 74, lastDeviceId: 'port-a', lastDeviceName: 'Keys A' }));
    poll();

    port.fire({ data: NOTE_ON(0), timeStamp: 3 });
    expect(gateHighs(gate), 'the previous channel set is gone').toBe(1);
    port.fire({ data: NOTE_ON(9), timeStamp: 4 });
    expect(gateHighs(gate), 'the loaded channel drives the gate').toBe(2);
    port.fire({ data: new Uint8Array([0xb0 | 9, 1, 127]), timeStamp: 5 });
    expect(ccA.offset.events.filter((e) => e.kind === 'set').length, 'CC1 no longer taps cc_a').toBe(ccSetsBefore);
    port.fire({ data: new Uint8Array([0xb0 | 9, 74, 127]), timeStamp: 6 });
    expect(ccA.offset.events.filter((e) => e.kind === 'set').length, 'CC74 does').toBeGreaterThan(ccSetsBefore);
    expect(api.getState().ccANum).toBe(74);
    handle.dispose();
  });

  it('the projection clones the channel array — a Yjs proxy never becomes the baseline', () => {
    const live = node(ID, 'midiLane', { channels: [1, 2] });
    const h = midiLaneHydrateOf(live);
    expect(h.channels).toEqual([1, 2]);
    expect(h.channels).not.toBe((live.data as { channels: number[] }).channels);
  });
});

// ---------------------------------------------------------------------------
// 4. midi-out-buddy — the bytes on the wire carry the LOADED channel
// ---------------------------------------------------------------------------

describe('midi-out-buddy: a same-session load at a reused id re-hydrates', () => {
  const ID = 'mob-reused';
  afterEach(() => { despawn(ID); restoreMidi(); });

  it('NoteOn bytes carry the LOADED channel, flushed on the old one first', async () => {
    const out = { id: 'out-1', name: 'Synth', sent: [] as number[][] };
    installFakeMidi(makeMidiAccess([], [out]));
    const v1 = node(ID, 'midiOutBuddy', { midiOutChannel: 1, lastDeviceId: 'out-1', lastDeviceName: 'Synth' });
    spawn(v1);
    const { ctx, analysers } = makeCtx();
    const handle = await midiOutBuddyDef.factory(ctx as unknown as AudioContext, v1);
    const api = handle.read?.('card-api') as MidiOutBuddyApi;
    expect(await api.connect()).toBe(true);
    expect(api.getState().selectedDeviceId).toBe('out-1');
    // Taps are created gate, pitch, velocity, then the poly lanes.
    const gateTap = analysers[0]!;
    const velTap = analysers[2]!;
    velTap.level = 1;

    // POSITIVE CONTROL: a rising gate sends NoteOn on channel 1 (0x90).
    gateTap.level = 1;
    vi.advanceTimersByTime(SCHEDULER_TICK_MS);
    const firstOn = out.sent.find((m) => (m[0]! & 0xf0) === 0x90 && m[2]! > 0);
    expect(firstOn?.[0], 'pre-load NoteOn is on channel 1').toBe(0x90);
    gateTap.level = 0;
    vi.advanceTimersByTime(SCHEDULER_TICK_MS);

    sameSessionLoad(node(ID, 'midiOutBuddy', { midiOutChannel: 5, lastDeviceId: 'out-1', lastDeviceName: 'Synth' }));
    poll();
    expect(api.getState().channel).toBe(5);
    out.sent.length = 0;
    gateTap.level = 1;
    vi.advanceTimersByTime(SCHEDULER_TICK_MS);
    const loadedOn = out.sent.find((m) => (m[0]! & 0xf0) === 0x90 && m[2]! > 0);
    expect(loadedOn?.[0], 'post-load NoteOn is on channel 5 (0x94)').toBe(0x94);
    expect(out.sent.some((m) => m[0] === 0x90), 'nothing is still sent on the previous channel').toBe(false);
    handle.dispose();
  });

  it('the projection resolves the EFFECTIVE channel, so a lane move re-routes too', () => {
    const inLane3 = midiOutBuddyHydrateOf(node(ID, 'midiOutBuddy', { channel: 3 }));
    const inLane7 = midiOutBuddyHydrateOf(node(ID, 'midiOutBuddy', { channel: 7 }));
    expect(inLane3.channel).toBe(3);
    expect(inLane7.channel).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// 5. midiclock — legacy division + device follow the loaded patch
// ---------------------------------------------------------------------------

describe('midiclock: a same-session load at a reused id re-hydrates', () => {
  const ID = 'mclk-reused';
  afterEach(() => { despawn(ID); restoreMidi(); });

  function clockPulses(src: FakeConstantSource): number {
    return src.offset.events.filter((e) => e.kind === 'set' && e.value === 1).length;
  }

  it('a LEGACY rack (data.divisor, no params.divisor) re-divides the clock — the P1 half', async () => {
    const port = makeMidiInput('clk-in', 'Drum Machine');
    installFakeMidi(makeMidiAccess([port]));
    const v1 = node(ID, 'midiclock', { lastDeviceId: 'clk-in', lastDeviceName: 'Drum Machine' }, { divisor: 24 });
    spawn(v1);
    const { ctx } = makeCtx();
    const handle = await midiclockDef.factory(ctx as unknown as AudioContext, v1);
    const api = handle.read?.('card-api') as MidiclockApi;
    expect(await api.connect()).toBe(true);
    const clock = handle.outputs.get('clock')!.node as unknown as FakeConstantSource;

    port.fire({ data: new Uint8Array([0xfa]), timeStamp: 0 });
    for (let i = 0; i < 24; i++) port.fire({ data: new Uint8Array([0xf8]), timeStamp: i + 1 });
    expect(clockPulses(clock), 'quarter-note division: one pulse per 24 ticks').toBe(1);

    // v2 was saved before `divisor` was a param: the ONLY division it carries
    // is the legacy data key, which the reconciler's param diff cannot see.
    sameSessionLoad(node(ID, 'midiclock', { divisor: 6, lastDeviceId: 'clk-in', lastDeviceName: 'Drum Machine' }, {}));
    poll();
    expect(handle.readParam?.('divisor')).toBe(6);
    for (let i = 0; i < 24; i++) port.fire({ data: new Uint8Array([0xf8]), timeStamp: 100 + i });
    expect(clockPulses(clock), 'sixteenth division: four pulses per 24 ticks').toBe(1 + 4);
    handle.dispose();
  });

  it('a rack WITH params.divisor leaves the division to the param path (no legacy fight)', () => {
    const h = midiclockHydrateOf(node(ID, 'midiclock', { divisor: 6 }, { divisor: 12 }));
    expect(h.legacyDivisor, 'params present ⇒ the legacy key is not a truth').toBeNull();
    const legacyOnly = midiclockHydrateOf(node(ID, 'midiclock', { divisor: 6 }, {}));
    expect(legacyOnly.legacyDivisor).toBe(6);
  });

  it('the DEVICE follows the loaded patch by NAME, and the rebound port drives the clock', async () => {
    const a = makeMidiInput('s2-a', 'Decoy A');
    const b = makeMidiInput('s2-b', 'Target B');
    installFakeMidi(makeMidiAccess([a, b]));
    const v1 = node(ID, 'midiclock', { lastDeviceId: 's2-a', lastDeviceName: 'Decoy A' }, { divisor: 1 });
    spawn(v1);
    const { ctx } = makeCtx();
    const handle = await midiclockDef.factory(ctx as unknown as AudioContext, v1);
    const api = handle.read?.('card-api') as MidiclockApi;
    expect(await api.connect()).toBe(true);
    const clock = handle.outputs.get('clock')!.node as unknown as FakeConstantSource;
    a.fire({ data: new Uint8Array([0xf8]), timeStamp: 0 });
    expect(clockPulses(clock)).toBe(1);

    sameSessionLoad(node(ID, 'midiclock', { lastDeviceId: 's1-b', lastDeviceName: 'Target B' }, { divisor: 1 }));
    poll();
    expect(api.getState().selectedDeviceId).toBe('s2-b');
    a.fire({ data: new Uint8Array([0xf8]), timeStamp: 1 });
    expect(clockPulses(clock), 'the decoy port is released').toBe(1);
    b.fire({ data: new Uint8Array([0xf8]), timeStamp: 2 });
    expect(clockPulses(clock), 'the loaded port drives the clock').toBe(2);
    handle.dispose();
  });
});

// ---------------------------------------------------------------------------
// 6. audio-out — the loaded sink is APPLIED through setSinkId
// ---------------------------------------------------------------------------

describe('audio-out: a same-session load at a reused id re-applies the sink', () => {
  const ID = 'pinned-audioOut-reused';
  afterEach(() => despawn(ID));

  async function flush(): Promise<void> {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  }

  it('setSinkId is called with the LOADED device, and the applied id reports it', async () => {
    const applied: string[] = [];
    const { ctx } = makeCtx();
    const sinkCtx = Object.assign(ctx, { setSinkId: vi.fn(async (id: string) => { applied.push(id); }) });
    const v1 = node(ID, 'audioOut', { outputDeviceId: 'dev-a' }, { master: 0.7 });
    spawn(v1);
    const handle = await audioOutDef.factory(sinkCtx as unknown as AudioContext, v1);
    await flush();
    expect(applied, 'boot applies the saved pick').toEqual(['dev-a']);

    sameSessionLoad(node(ID, 'audioOut', { outputDeviceId: 'dev-b' }, { master: 0.7 }));
    poll();
    await flush();
    expect(applied, 'the loaded pick reaches setSinkId').toEqual(['dev-a', 'dev-b']);
    expect((handle.read?.('outputSink') as { deviceId: string | null }).deviceId).toBe('dev-b');

    // A patch with NO pick is the browser default — what a fresh page would give.
    sameSessionLoad(node(ID, 'audioOut', {}, { master: 0.7 }));
    poll();
    await flush();
    expect(applied.at(-1), 'no pick ⇒ the default sink').toBe('');
    handle.dispose();
  });

  it('⚠ THE WRITE RACE (the e2e catch): picker → B and persisted, then v1 loaded — inside ONE poll', async () => {
    const applied: string[] = [];
    const { ctx } = makeCtx();
    const sinkCtx = Object.assign(ctx, { setSinkId: vi.fn(async (id: string) => { applied.push(id); }) });
    const v1 = node(ID, 'audioOut', { outputDeviceId: 'dev-a' }, { master: 0.7 });
    spawn(v1);
    const handle = await audioOutDef.factory(sinkCtx as unknown as AudioContext, v1);
    await flush();
    poll();
    expect(applied).toEqual(['dev-a']);
    handle.write?.('outputDeviceId', 'dev-b');
    ydoc.transact(() => { (patch.nodes[ID]!.data as Record<string, unknown>).outputDeviceId = 'dev-b'; }, LOCAL_ORIGIN);
    sameSessionLoad(node(ID, 'audioOut', { outputDeviceId: 'dev-a' }, { master: 0.7 }));
    poll();
    await flush();
    expect(applied, 'the engine was on B, the doc says A: A is re-applied').toEqual(['dev-a', 'dev-b', 'dev-a']);
    expect((handle.read?.('outputSink') as { deviceId: string | null }).deviceId).toBe('dev-a');
    handle.dispose();
  });

  it("the picker's own write is not applied a second time by the watcher", async () => {
    const applied: string[] = [];
    const { ctx } = makeCtx();
    const sinkCtx = Object.assign(ctx, { setSinkId: vi.fn(async (id: string) => { applied.push(id); }) });
    const v1 = node(ID, 'audioOut', {}, { master: 0.7 });
    spawn(v1);
    const handle = await audioOutDef.factory(sinkCtx as unknown as AudioContext, v1);
    await flush();
    expect(applied).toEqual([]);
    // The face: apply through the handle AND persist into the doc.
    handle.write?.('outputDeviceId', 'dev-c');
    ydoc.transact(() => {
      (patch.nodes[ID]!.data as Record<string, unknown>).outputDeviceId = 'dev-c';
    }, LOCAL_ORIGIN);
    poll(); poll();
    await flush();
    expect(applied, 'one apply, not two').toEqual(['dev-c']);
    handle.dispose();
  });

  it('the projection reads the pick or the default', () => {
    expect(audioOutSinkPickOf(node(ID, 'audioOut', { outputDeviceId: 'x' }))).toBe('x');
    expect(audioOutSinkPickOf(node(ID, 'audioOut', {}))).toBe('');
    expect(audioOutSinkPickOf(node(ID, 'audioOut', { outputDeviceId: 42 }))).toBe('');
  });
});
