// LINNSTRUMENT — the module's factory outputs, driven through the REAL
// runtime by RuntimeEvents injected at the source registry (the seam the
// device layer publishes into), with no UI anywhere in the process.
//
// ⚠ SYNTHETIC. No LinnStrument was connected. These events are what WP-A's
// surface map produces for the firmware-documented bytes; the acceptance ids
// (V02..V05, V10, V14) index the design record's synthetic vector table and
// the audible half of every claim is WP-D's e2e on the simulated device.
//
// The fake AudioContext records automation on every ConstantSource, and the
// poly bus is read THROUGH the port's own merger (the trails lesson): lane i's
// pitch is merger input 2i, its gate 2i+1, so the test reads what the engine
// would.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { linnstrumentDef } from './linnstrument';
import {
  bipolarToCc,
  createLinnstrumentRuntime,
  cvPortId,
  polyPortId,
  positionParamId,
  selectorParamId,
  setLinnstrumentConnector,
  type LinnstrumentCardApi,
  type LinnstrumentRuntimeDeps,
} from './linnstrument-runtime';
import { POLY_CHANNEL_PAIRS } from '$lib/audio/poly';
import { midiToVOct } from '$lib/audio/note-entry';
import { __resetLinnstrumentSourceForTest, setLinnstrumentSource } from '$lib/midi/linnstrument/source-registry';
import type { LinnLighting, LinnstrumentSource, RuntimeEvent, RuntimeEventListener, SelectionState, SessionEvent } from '$lib/midi/linnstrument/types';
import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { ModuleNode } from '$lib/graph/types';

// ── Fake Web Audio ────────────────────────────────────────────────────────

interface Recorded {
  kind: 'cancel' | 'set';
  value?: number;
  time: number;
}
function makeParam(initial = 0) {
  const events: Recorded[] = [];
  const p = {
    value: initial,
    events,
    setValueAtTime(v: number, t: number) {
      p.value = v;
      events.push({ kind: 'set', value: v, time: t });
    },
    cancelScheduledValues(t: number) {
      events.push({ kind: 'cancel', time: t });
    },
  };
  return p;
}
class FakeConstantSourceNode {
  offset = makeParam(1);
  start = vi.fn();
  stop = vi.fn();
  disconnect = vi.fn();
  connect(target?: unknown, _output?: number, input?: number): void {
    if (target instanceof FakeChannelMergerNode && typeof input === 'number') target.inputs.set(input, this);
  }
}
class FakeChannelMergerNode {
  readonly inputs = new Map<number, FakeConstantSourceNode>();
  connect = vi.fn();
  disconnect = vi.fn();
  constructor(readonly channelCount: number) {}
}
function makeCtx(): AudioContext & { currentTime: number } {
  return {
    currentTime: 1,
    sampleRate: 48000,
    createConstantSource: () => new FakeConstantSourceNode(),
    createChannelMerger: (n: number) => new FakeChannelMergerNode(n),
  } as unknown as AudioContext & { currentTime: number };
}

function cvValue(handle: AudioDomainNodeHandle, port: string): number {
  const node = handle.outputs.get(port)?.node as unknown as FakeConstantSourceNode;
  return node.offset.value;
}
function laneSource(handle: AudioDomainNodeHandle, port: string, lane: number, kind: 'pitch' | 'gate'): FakeConstantSourceNode {
  const merger = handle.outputs.get(port)?.node as unknown as FakeChannelMergerNode;
  return merger.inputs.get(lane * 2 + (kind === 'gate' ? 1 : 0))!;
}
function laneValue(handle: AudioDomainNodeHandle, port: string, lane: number, kind: 'pitch' | 'gate'): number {
  return laneSource(handle, port, lane, kind).offset.value;
}
function laneEvents(handle: AudioDomainNodeHandle, port: string, lane: number, kind: 'pitch' | 'gate'): Recorded[] {
  return laneSource(handle, port, lane, kind).offset.events;
}
/** What an AudioParam would HOLD at audio time `t` given the recorded
 *  timeline: a `cancel` at c drops every earlier-recorded `set` at ≥ c, then
 *  the value is the last surviving `set` at ≤ t. The initial 0 stands in for
 *  the source's default. */
function laneValueAt(handle: AudioDomainNodeHandle, port: string, lane: number, kind: 'pitch' | 'gate', t: number): number {
  const live: { value: number; time: number }[] = [];
  for (const e of laneEvents(handle, port, lane, kind)) {
    if (e.kind === 'cancel') {
      for (let i = live.length - 1; i >= 0; i--) if (live[i]!.time >= e.time) live.splice(i, 1);
    } else live.push({ value: e.value!, time: e.time });
  }
  return live.filter((e) => e.time <= t).sort((a, b) => a.time - b.time).at(-1)?.value ?? 0;
}

// ── A simulated source on the registry seam ───────────────────────────────

interface Sim extends LinnstrumentSource {
  emit(ev: RuntimeEvent): void;
  acks: SelectionState[];
  lights: LinnLighting[];
  epoch: number;
}
function makeSim(epoch = 1): Sim {
  const listeners = new Set<RuntimeEventListener>();
  const sim: Sim = {
    id: 'sim-linnstrument',
    kind: 'simulated',
    epoch,
    acks: [],
    lights: [],
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    snapshot(): SessionEvent {
      return { kind: 'session', epoch: sim.epoch, state: 'connected', userMode: true, time: 0 };
    },
    onSelection(state) {
      sim.acks.push(state);
    },
    onLighting(l) {
      sim.lights.push(l);
    },
    emit(ev) {
      for (const fn of [...listeners]) fn(ev);
    },
  };
  return sim;
}

// Event builders in the surface map's vocabulary (application coordinates).
let t = 0;
const tick = () => (t += 10);
const edge = (sim: Sim, control: 'r' | 'g' | 'b' | 'panic' | 'keyboard_arp' | 'keyboard_hold' | 'octave_up' | 'octave_down', down: boolean): RuntimeEvent =>
  ({ kind: 'control_edge', epoch: sim.epoch, control, down, time: tick() });
const pointer = (sim: Sim, touch: number, phase: 'down' | 'move' | 'up', u: number, v: number): RuntimeEvent =>
  ({ kind: 'pointer', epoch: sim.epoch, touch, phase, u, v, pressure: 0.5, time: tick() });
const touchStart = (sim: Sim, touch: number, region: 'keys' | 'pad', localCol: number, localRow: number, velocity = 100): RuntimeEvent =>
  ({ kind: 'touch_start', epoch: sim.epoch, touch, region, col: localCol + (region === 'pad' ? 17 : 0), row: localRow, localCol, localRow, note: 0 /* the runtime re-derives it */, velocity, time: tick() });
const touchExpr = (sim: Sim, touch: number, region: 'keys' | 'pad', e: { bendSemitones?: number; pressure?: number; timbre?: number }): RuntimeEvent =>
  ({ kind: 'touch_expression', epoch: sim.epoch, touch, region, ...e, time: tick() });
const touchEnd = (sim: Sim, touch: number, region: 'keys' | 'pad'): RuntimeEvent =>
  ({ kind: 'touch_end', epoch: sim.epoch, touch, region, reason: 'release', time: tick() });

function makeNode(params: Record<string, number> = {}, data: Record<string, unknown> = {}): ModuleNode {
  return { id: 'linn-1', type: 'linnstrument', domain: 'audio', position: { x: 0, y: 0 }, params, data } as unknown as ModuleNode;
}

interface Rig {
  ctx: ReturnType<typeof makeCtx>;
  handle: AudioDomainNodeHandle;
  api: LinnstrumentCardApi;
  sim: Sim;
  commits: { id: string; value: number }[];
  /** The LAST committed value per param — what a save would persist. */
  persisted: () => Record<string, number>;
  deliveries: { nodeId: string; paramId: string; cc: number }[];
  ticks: Set<() => void>;
  tick: (nowMs: number, audioTime?: number) => void;
}

async function build(params: Record<string, number> = {}, opts: Partial<LinnstrumentRuntimeDeps> & { targets?: Record<string, string>; deliverOk?: boolean } = {}): Promise<Rig> {
  const ctx = makeCtx();
  const sim = makeSim();
  setLinnstrumentSource(sim);
  const commits: Rig['commits'] = [];
  const deliveries: Rig['deliveries'] = [];
  const ticks = new Set<() => void>();
  let nowMs = 0;
  const handle = await createLinnstrumentRuntime(ctx, makeNode(params), {
    commitParam: (_n, id, value) => commits.push({ id, value }),
    readTargets: () => opts.targets ?? {},
    deliverCc: (nodeId, paramId, cc) => {
      deliveries.push({ nodeId, paramId, cc });
      return opts.deliverOk ?? true;
    },
    bpm: () => 120,
    clock: { subscribe: (fn) => (ticks.add(fn), () => ticks.delete(fn)) },
    nowMs: () => nowMs,
    batcher: null,
    ...opts,
  });
  const api = handle.read!('card-api') as LinnstrumentCardApi;
  return {
    ctx,
    handle,
    api,
    sim,
    commits,
    deliveries,
    ticks,
    persisted: () => {
      // What a SAVE would see: the pumps' staged values land first (the
      // save/export hooks flush every live pump the same way).
      api.flush();
      const out: Record<string, number> = {};
      for (const c of commits) out[c.id] = c.value;
      return out;
    },
    tick: (ms, audioTime) => {
      nowMs = ms;
      if (audioTime !== undefined) ctx.currentTime = audioTime;
      for (const fn of [...ticks]) fn();
    },
  };
}

let rigs: Rig[] = [];
beforeEach(() => {
  __resetLinnstrumentSourceForTest();
  setLinnstrumentConnector(null);
  t = 0;
});
afterEach(() => {
  for (const r of rigs) r.handle.dispose();
  rigs = [];
  __resetLinnstrumentSourceForTest();
});
async function rig(params?: Record<string, number>, opts?: Parameters<typeof build>[1]): Promise<Rig> {
  const r = await build(params, opts);
  rigs.push(r);
  return r;
}

// ── The contract ──────────────────────────────────────────────────────────

describe('linnstrument def — the contract the runtime implements', () => {
  it('six cv jacks + two poly buses, no inputs, every port on the handle as { node, output }', async () => {
    const r = await rig();
    expect(linnstrumentDef.inputs).toEqual([]);
    for (const s of ['r', 'g', 'b'] as const) {
      for (const axis of ['x', 'y'] as const) {
        expect(linnstrumentDef.outputs.find((o) => o.id === cvPortId(s, axis))?.type).toBe('cv');
        expect(r.handle.outputs.get(cvPortId(s, axis))).toMatchObject({ output: 0 });
      }
    }
    for (const region of ['keys', 'pad'] as const) {
      expect(linnstrumentDef.outputs.find((o) => o.id === polyPortId(region))?.type).toBe('polyPitchGate');
      const merger = r.handle.outputs.get(polyPortId(region))?.node as unknown as FakeChannelMergerNode;
      expect(merger.channelCount).toBe(POLY_CHANNEL_PAIRS * 2);
      expect(merger.inputs.size).toBe(POLY_CHANNEL_PAIRS * 2);
    }
    expect(r.handle.inputs.size).toBe(0);
  });

  it('the factory is the runtime (the def delegates, adds nothing)', async () => {
    const ctx = makeCtx();
    const sim = makeSim();
    setLinnstrumentSource(sim);
    const handle = await linnstrumentDef.factory(ctx, makeNode({ pos_g_x: 0.25 }));
    try {
      expect(cvValue(handle, 'g_x')).toBe(0.25);
      expect(typeof (handle.read!('card-api') as LinnstrumentCardApi).dispatch).toBe('function');
    } finally {
      handle.dispose();
    }
  });

  it('D08 defaults are the RECOMMENDATION: R on, G/B off, centred, arps off', () => {
    const byId = new Map(linnstrumentDef.params.map((p) => [p.id, p]));
    expect(byId.get('sel_r')!.defaultValue).toBe(1);
    expect(byId.get('sel_g')!.defaultValue).toBe(0);
    expect(byId.get('sel_b')!.defaultValue).toBe(0);
    for (const s of ['r', 'g', 'b'] as const) for (const a of ['x', 'y'] as const) expect(byId.get(positionParamId(s, a))!.defaultValue).toBe(0);
    expect(byId.get('keys_arp_on')!.defaultValue).toBe(0);
    expect(byId.get('pad_arp_on')!.defaultValue).toBe(0);
    expect(byId.get('keys_root')!.defaultValue).toBe(36);
    expect(byId.get('pad_root')!.defaultValue).toBe(60);
    expect(byId.get('join_policy')!.defaultValue).toBe(0);
    expect(byId.get('extra_controls')!.defaultValue).toBe(1);
  });

  it('D14: NO expression jacks ship — the buses are pitch + gate only', () => {
    expect(linnstrumentDef.outputs.filter((o) => o.type === 'polyPitchGate').length).toBe(2);
    expect(linnstrumentDef.outputs.some((o) => /press|timbre|vel/.test(o.id))).toBe(false);
  });
});

// ── Selection → CV (V02/V03/V04) ──────────────────────────────────────────

describe('linnstrument runtime — selection, masks and retention through the source seam', () => {
  it('V03: a fresh R edge flips once; a repeated down and the up change nothing; a fresh edge flips again', async () => {
    const r = await rig();
    expect(r.api.selection().mask.r).toBe(true);
    r.sim.emit(edge(r.sim, 'r', true));
    expect(r.api.selection().mask.r).toBe(false);
    r.sim.emit(edge(r.sim, 'r', true));
    expect(r.api.selection().mask.r).toBe(false);
    r.sim.emit(edge(r.sim, 'r', false));
    expect(r.api.selection().mask.r).toBe(false);
    r.sim.emit(edge(r.sim, 'r', true));
    expect(r.api.selection().mask.r).toBe(true);
    // …and the selector is committed as a param each time it flips (the
    // second flip is a coalesced commit inside the pump's window: flush it).
    r.api.flush();
    expect(r.commits.filter((c) => c.id === selectorParamId('r')).map((c) => c.value)).toEqual([0, 1]);
    // The acknowledged state reached the source (the LED writer's token).
    expect(r.sim.acks.length).toBeGreaterThan(0);
    expect(r.sim.acks.at(-1)!.mask.r).toBe(true);
  });

  it('V02: all eight masks are reachable and never a radio group', async () => {
    const r = await rig();
    const seen = new Set<string>();
    const masks = () => `${+r.api.selection().mask.r}${+r.api.selection().mask.g}${+r.api.selection().mask.b}`;
    seen.add(masks());
    // A Gray-code walk from 100: every toggle lands on a mask not yet seen.
    for (const seq of [['g'], ['b'], ['g'], ['r'], ['g'], ['b'], ['g']] as const) {
      for (const s of seq) {
        r.sim.emit(edge(r.sim, s, true));
        r.sim.emit(edge(r.sim, s, false));
      }
      seen.add(masks());
    }
    expect(seen.size).toBe(8);
  });

  it('V04: R+B selected, one sample (u .75, v .25) → R and B receive (.5, −.5) together; G is unchanged', async () => {
    const r = await rig({ sel_r: 1, sel_g: 0, sel_b: 1, pos_g_x: 0.3, pos_g_y: -0.3 });
    r.sim.emit(pointer(r.sim, 7, 'down', 0.75, 0.25));
    expect(cvValue(r.handle, 'r_x')).toBeCloseTo(0.5);
    expect(cvValue(r.handle, 'r_y')).toBeCloseTo(-0.5);
    expect(cvValue(r.handle, 'b_x')).toBeCloseTo(0.5);
    expect(cvValue(r.handle, 'b_y')).toBeCloseTo(-0.5);
    expect(cvValue(r.handle, 'g_x')).toBeCloseTo(0.3);
    expect(cvValue(r.handle, 'g_y')).toBeCloseTo(-0.3);
  });

  it('V04 retention: all six hold after the finger lifts, and the gesture end FLUSHES the final pair', async () => {
    const r = await rig({ sel_r: 1, sel_g: 1, sel_b: 1 });
    r.sim.emit(pointer(r.sim, 7, 'down', 0.5, 0.5));
    r.sim.emit(pointer(r.sim, 7, 'move', 0.9, 0.1));
    r.sim.emit(pointer(r.sim, 7, 'move', 1, 0));
    r.sim.emit(pointer(r.sim, 7, 'up', 1, 0));
    for (const s of ['r', 'g', 'b'] as const) {
      expect(cvValue(r.handle, cvPortId(s, 'x'))).toBeCloseTo(1);
      expect(cvValue(r.handle, cvPortId(s, 'y'))).toBeCloseTo(-1);
      expect(r.persisted()[positionParamId(s, 'x')]).toBeCloseTo(1);
      expect(r.persisted()[positionParamId(s, 'y')]).toBeCloseTo(-1);
    }
    // A second contact while the first is down never steals the pointer (V08).
    r.sim.emit(pointer(r.sim, 8, 'down', 0.5, 0.5));
    r.sim.emit(pointer(r.sim, 9, 'down', 0, 1));
    expect(cvValue(r.handle, 'r_x')).toBeCloseTo(0);
    expect(cvValue(r.handle, 'r_y')).toBeCloseTo(0);
  });

  it('Center zeroes ONLY the selected pairs; Panic keeps every pair', async () => {
    const r = await rig({ sel_r: 1, sel_g: 0, sel_b: 0, pos_r_x: 0.6, pos_r_y: 0.6, pos_g_x: -0.4, pos_g_y: 0.4 });
    r.api.dispatch({ kind: 'center' });
    expect(cvValue(r.handle, 'r_x')).toBe(0);
    expect(cvValue(r.handle, 'r_y')).toBe(0);
    expect(cvValue(r.handle, 'g_x')).toBeCloseTo(-0.4);
    expect(cvValue(r.handle, 'g_y')).toBeCloseTo(0.4);
    r.api.dispatch({ kind: 'panic' });
    expect(cvValue(r.handle, 'g_x')).toBeCloseTo(-0.4);
    expect(r.api.selection().mask).toEqual({ r: true, g: false, b: false });
  });

  it('a knob-cell / collaborator write reaches the same reducer through setParam', async () => {
    const r = await rig();
    r.handle.setParam('pos_b_x', 0.75);
    expect(cvValue(r.handle, 'b_x')).toBeCloseTo(0.75);
    expect(r.api.selection().pairs.b.x).toBeCloseTo(0.75);
    r.handle.setParam('sel_g', 1);
    expect(r.api.selection().mask.g).toBe(true);
    // Out-of-range and non-finite writes clamp / centre, the joystick rule.
    r.handle.setParam('pos_b_y', 7);
    expect(cvValue(r.handle, 'b_y')).toBe(1);
    r.handle.setParam('pos_b_y', Number.NaN);
    expect(cvValue(r.handle, 'b_y')).toBe(1);
  });

  it('while the finger owns a SELECTED pair a store echo cannot drag the CV back', async () => {
    const r = await rig({ sel_r: 1 });
    r.sim.emit(pointer(r.sim, 7, 'down', 1, 1));
    r.handle.setParam('pos_r_x', 0); // a stale coalesced echo mid-gesture
    expect(cvValue(r.handle, 'r_x')).toBeCloseTo(1);
    r.sim.emit(pointer(r.sim, 7, 'up', 1, 1));
    r.handle.setParam('pos_r_x', 0); // after the gesture the store is the truth again
    expect(cvValue(r.handle, 'r_x')).toBe(0);
  });

  it('D07 switch: JUMP follows the next sample; PICKUP waits for the finger to pass the resting pair', async () => {
    const jump = await rig({ sel_r: 1, sel_g: 0, join_policy: 0, pos_g_x: -1, pos_g_y: -1 });
    jump.sim.emit(pointer(jump.sim, 1, 'down', 1, 1));
    jump.handle.setParam('sel_g', 1);
    jump.sim.emit(pointer(jump.sim, 1, 'move', 0.9, 0.9));
    expect(cvValue(jump.handle, 'g_x')).toBeCloseTo(0.8);

    const pickup = await rig({ sel_r: 1, sel_g: 0, join_policy: 1, pos_g_x: -1, pos_g_y: -1 });
    pickup.sim.emit(pointer(pickup.sim, 1, 'down', 1, 1));
    pickup.handle.setParam('sel_g', 1);
    pickup.sim.emit(pointer(pickup.sim, 1, 'move', 0.9, 0.9));
    expect(cvValue(pickup.handle, 'g_x'), 'not picked up yet').toBeCloseTo(-1);
    pickup.sim.emit(pointer(pickup.sim, 1, 'move', 0.02, 0.02));
    expect(cvValue(pickup.handle, 'g_x'), 'picked up within the radius').toBeCloseTo(-0.96);
  });
});

// ── V05: persisted params survive a save/reload at the unit layer ─────────

describe('linnstrument runtime — V05 save/reload retention', () => {
  it('the committed params rebuild the same six coordinates with no gate high', async () => {
    const a = await rig({ sel_r: 1, sel_g: 1, sel_b: 0, pos_b_x: 0.2, pos_b_y: -0.2 });
    a.sim.emit(touchStart(a.sim, 1, 'keys', 0, 0));
    a.sim.emit(pointer(a.sim, 2, 'down', 0.75, 0.25));
    a.sim.emit(pointer(a.sim, 2, 'up', 0.75, 0.25));
    expect(laneValue(a.handle, 'keys_poly', 0, 'gate')).toBe(1);
    // "Save": the durable subset is what the pumps committed plus the untouched defaults.
    const saved = { sel_r: 1, sel_g: 1, sel_b: 0, pos_b_x: 0.2, pos_b_y: -0.2, ...a.persisted() };
    a.handle.dispose();
    rigs = [];
    // "Reload": a fresh runtime from the saved params only.
    const b = await rig(saved);
    expect(cvValue(b.handle, 'r_x')).toBeCloseTo(0.5);
    expect(cvValue(b.handle, 'r_y')).toBeCloseTo(-0.5);
    expect(cvValue(b.handle, 'g_x')).toBeCloseTo(0.5);
    expect(cvValue(b.handle, 'g_y')).toBeCloseTo(-0.5);
    expect(cvValue(b.handle, 'b_x')).toBeCloseTo(0.2);
    expect(cvValue(b.handle, 'b_y')).toBeCloseTo(-0.2);
    expect(b.api.selection().mask).toEqual({ r: true, g: true, b: false });
    for (let lane = 0; lane < POLY_CHANNEL_PAIRS; lane++) {
      expect(laneValue(b.handle, 'keys_poly', lane, 'gate'), 'no active musical gate after a reload').toBe(0);
      expect(laneValue(b.handle, 'pad_poly', lane, 'gate')).toBe(0);
    }
  });
});

// ── Voices → buses, with lane alignment (V10 / V14; V15's STATE half) ──────

describe('linnstrument runtime — voices, lanes and expression alignment', () => {
  it('a keys touch opens lane 0 at (root − 60)/12 with the gate high; release closes it', async () => {
    const r = await rig();
    r.sim.emit(touchStart(r.sim, 1, 'keys', 0, 0, 127));
    expect(laneValue(r.handle, 'keys_poly', 0, 'pitch')).toBeCloseTo(midiToVOct(36));
    expect(laneValue(r.handle, 'keys_poly', 0, 'gate')).toBe(1);
    // +1 column = +1 semitone, +1 row = +5 (D09): cell (5, 1) is 36 + 5 + 5.
    r.sim.emit(touchStart(r.sim, 2, 'keys', 5, 1));
    expect(laneValue(r.handle, 'keys_poly', 1, 'pitch')).toBeCloseTo(midiToVOct(46));
    r.sim.emit(touchEnd(r.sim, 1, 'keys'));
    expect(laneValue(r.handle, 'keys_poly', 0, 'gate')).toBe(0);
    expect(laneValue(r.handle, 'keys_poly', 1, 'gate'), 'the other lane is untouched').toBe(1);
    // The pad bus is separate: nothing there moved.
    expect(laneValue(r.handle, 'pad_poly', 0, 'gate')).toBe(0);
  });

  it('a bend moves the lane pitch; pressure and timbre land on THAT lane only', async () => {
    const r = await rig();
    r.sim.emit(touchStart(r.sim, 1, 'keys', 0, 0));
    r.sim.emit(touchStart(r.sim, 2, 'keys', 0, 0)); // same pitch: a second voice (D13)
    r.sim.emit(touchExpr(r.sim, 1, 'keys', { bendSemitones: 1 }));
    expect(laneValue(r.handle, 'keys_poly', 0, 'pitch')).toBeCloseTo(midiToVOct(37));
    expect(laneValue(r.handle, 'keys_poly', 1, 'pitch')).toBeCloseTo(midiToVOct(36));
    r.sim.emit(touchExpr(r.sim, 2, 'keys', { pressure: 0.75, timbre: 0.25 }));
    const lanes = r.api.expression('keys');
    expect(lanes[0]).toMatchObject({ voice: 1, note: 36, bend: 1, gate: 1 });
    expect(lanes[0]!.pressure).toBe(0);
    expect(lanes[1]).toMatchObject({ voice: 2, note: 36, gate: 1 });
    expect(lanes[1]!.pressure).toBeCloseTo(0.75);
    expect(lanes[1]!.timbre).toBeCloseTo(0.25);
    expect(lanes[1]!.pitchCv).toBeCloseTo(midiToVOct(36));
  });

  it('V10: a 17th touch steals the OLDEST lane; the stolen touch\'s release is a no-op; expression stays aligned', async () => {
    const r = await rig();
    for (let i = 1; i <= POLY_CHANNEL_PAIRS; i++) r.sim.emit(touchStart(r.sim, i, 'keys', i % 16, 0));
    r.sim.emit(touchStart(r.sim, 17, 'keys', 3, 2)); // steals lane 0 from touch 1
    expect(r.api.expression('keys')[0]).toMatchObject({ voice: 17, note: 36 + 3 + 10, gate: 1 });
    expect(laneValue(r.handle, 'keys_poly', 0, 'pitch')).toBeCloseTo(midiToVOct(49));
    expect(r.api.state().counters.steals).toBe(1);
    // Stale expression from the stolen touch reaches no lane…
    r.sim.emit(touchExpr(r.sim, 1, 'keys', { pressure: 1 }));
    expect(r.api.expression('keys')[0]!.pressure).toBe(0);
    // …and its release does not close the newcomer's gate.
    r.sim.emit(touchEnd(r.sim, 1, 'keys'));
    expect(laneValue(r.handle, 'keys_poly', 0, 'gate')).toBe(1);
    expect(r.api.expression('keys')[0]!.voice).toBe(17);
    r.sim.emit(touchEnd(r.sim, 17, 'keys'));
    expect(laneValue(r.handle, 'keys_poly', 0, 'gate')).toBe(0);
  });

  it('V14: an event from another epoch is rejected — no voice, no gate', async () => {
    const r = await rig();
    r.sim.emit({ ...touchStart(r.sim, 1, 'keys', 0, 0), epoch: 99 } as RuntimeEvent);
    expect(laneValue(r.handle, 'keys_poly', 0, 'gate')).toBe(0);
    expect(r.api.state().counters.rejected).toBe(1);
    // A reconnect ends every voice and moves the epoch; the OLD epoch's
    // release cannot resurrect anything.
    r.sim.emit(touchStart(r.sim, 2, 'keys', 0, 0));
    expect(laneValue(r.handle, 'keys_poly', 0, 'gate')).toBe(1);
    r.sim.epoch = 2;
    r.sim.emit({ kind: 'session', epoch: 2, state: 'connected', userMode: true, time: tick() });
    expect(laneValue(r.handle, 'keys_poly', 0, 'gate')).toBe(0);
    r.sim.emit({ kind: 'touch_end', epoch: 1, touch: 2, region: 'keys', reason: 'release', time: tick() });
    r.sim.emit(touchStart(r.sim, 3, 'keys', 0, 0));
    expect(laneValue(r.handle, 'keys_poly', 0, 'gate')).toBe(1);
    expect(r.api.expression('keys')[0]!.voice).toBe(3);
  });

  it('Panic drops both buses\' gates NOW and keeps XY; the finger may play again', async () => {
    const r = await rig({ sel_r: 1, pos_r_x: 0.4 });
    r.sim.emit(touchStart(r.sim, 1, 'keys', 0, 0));
    r.sim.emit(touchStart(r.sim, 2, 'pad', 0, 0));
    expect(laneValue(r.handle, 'keys_poly', 0, 'gate')).toBe(1);
    expect(laneValue(r.handle, 'pad_poly', 0, 'gate')).toBe(1);
    r.ctx.currentTime = 5;
    r.sim.emit(edge(r.sim, 'panic', true));
    expect(laneValue(r.handle, 'keys_poly', 0, 'gate')).toBe(0);
    expect(laneValue(r.handle, 'pad_poly', 0, 'gate')).toBe(0);
    expect(laneEvents(r.handle, 'keys_poly', 0, 'gate').some((e) => e.kind === 'cancel' && e.time === 5)).toBe(true);
    expect(cvValue(r.handle, 'r_x')).toBeCloseTo(0.4);
    expect(r.api.state().active).toEqual({ keys: 0, pad: 0 });
    r.sim.emit(touchStart(r.sim, 3, 'keys', 0, 0));
    expect(laneValue(r.handle, 'keys_poly', 0, 'gate')).toBe(1);
  });

  it('the module\'s ROOT wins: keys_root re-derives the next touch\'s note from its cell', async () => {
    const r = await rig();
    r.handle.setParam('keys_root', 48);
    r.sim.emit(touchStart(r.sim, 1, 'keys', 0, 0));
    expect(laneValue(r.handle, 'keys_poly', 0, 'pitch')).toBeCloseTo(midiToVOct(48));
    r.handle.setParam('pad_root', 72);
    r.sim.emit(touchStart(r.sim, 2, 'pad', 1, 1));
    expect(laneValue(r.handle, 'pad_poly', 0, 'pitch')).toBeCloseTo(midiToVOct(72 + 1 + 5));
    // A cell that would leave MIDI simply does not sound.
    r.handle.setParam('keys_root', 96);
    r.sim.emit(touchStart(r.sim, 3, 'keys', 15, 7));
    expect(r.api.state().active.keys).toBe(1);
  });

  it('the pad finger is BOTH the XY pointer and a pad voice', async () => {
    const r = await rig({ sel_r: 1 });
    r.sim.emit(touchStart(r.sim, 1, 'pad', 0, 0));
    r.sim.emit(pointer(r.sim, 1, 'down', 0.0625, 0.0625));
    expect(laneValue(r.handle, 'pad_poly', 0, 'gate')).toBe(1);
    expect(cvValue(r.handle, 'r_x')).toBeCloseTo(-0.875);
  });
});

// ── The arps through the runtime (V12/V13 at the bus) ─────────────────────

describe('linnstrument runtime — the arps own their bus while on', () => {
  it('keys_arp_on takes the keys bus: one lane, real gate-down events, the pad bus untouched', async () => {
    const r = await rig({ keys_arp_on: 1, keys_arp_dir: 2 });
    r.sim.emit(touchStart(r.sim, 1, 'keys', 0, 0)); // 36
    r.sim.emit(touchStart(r.sim, 2, 'keys', 4, 0)); // 40
    r.sim.emit(touchStart(r.sim, 3, 'keys', 7, 0)); // 43
    r.sim.emit(touchStart(r.sim, 9, 'pad', 0, 0));
    // The arp owns the bus: the direct voice writes did not open lanes.
    expect(laneValue(r.handle, 'keys_poly', 1, 'gate')).toBe(0);
    for (let i = 0; i < 5; i++) r.tick(1000 + i * 500, 10 + i * 0.5);
    const pitches = laneEvents(r.handle, 'keys_poly', 0, 'pitch').filter((e) => e.kind === 'set').map((e) => Math.round(e.value! * 12 + 60));
    expect(pitches).toEqual([36, 40, 43, 40, 36]);
    const gates = laneEvents(r.handle, 'keys_poly', 0, 'gate').filter((e) => e.kind === 'set');
    // Each attack is a 1 followed by a scheduled 0 STRICTLY later (V13).
    const ups = gates.filter((e) => e.value === 1);
    const downs = gates.filter((e) => e.value === 0 && e.time > 10);
    expect(ups.length).toBe(5);
    expect(downs.length).toBe(5);
    for (let i = 0; i < 5; i++) expect(downs[i]!.time).toBeGreaterThan(ups[i]!.time);
    expect(r.api.expression('keys')[0]).toMatchObject({ note: 36, owner: 1, gate: 1 });
    expect(laneValue(r.handle, 'pad_poly', 0, 'gate'), 'the pad bus is the finger\'s').toBe(1);
  });

  it('turning the arp off hands the bus back to what is held; Panic cancels the arp', async () => {
    const r = await rig({ keys_arp_on: 1 });
    r.sim.emit(touchStart(r.sim, 1, 'keys', 0, 0));
    r.tick(1000, 10);
    r.handle.setParam('keys_arp_on', 0);
    expect(laneValue(r.handle, 'keys_poly', 0, 'gate'), 'the held finger sounds again').toBe(1);
    r.handle.setParam('keys_arp_on', 1);
    r.tick(2000, 11);
    r.api.dispatch({ kind: 'panic' });
    const before = laneEvents(r.handle, 'keys_poly', 0, 'pitch').length;
    r.tick(2500, 11.5);
    expect(r.api.state().arp.keys.held, 'panic ended the voices').toEqual([]);
    expect(laneEvents(r.handle, 'keys_poly', 0, 'pitch').length).toBe(before);
  });

  it('F01: PANIC under HOLD with every finger released leaves NOTHING for the next tick to resurrect — on both regions; XY and selection stay', async () => {
    const r = await rig({ keys_arp_on: 1, keys_arp_latch: 1, pad_arp_on: 1, pad_arp_latch: 1, sel_r: 1, pos_r_x: 0.6, pos_r_y: -0.2 });
    r.sim.emit(touchStart(r.sim, 1, 'keys', 0, 0));
    r.sim.emit(touchStart(r.sim, 2, 'pad', 0, 0));
    r.tick(1000, 1);
    r.sim.emit(touchEnd(r.sim, 1, 'keys'));
    r.sim.emit(touchEnd(r.sim, 2, 'pad'));
    // The real latch precondition: no finger, both arps still running on a frozen pool.
    expect(r.api.state().active).toEqual({ keys: 0, pad: 0 });
    expect(r.api.state().arp.keys).toMatchObject({ running: true, held: [], effective: [36] });
    expect(r.api.state().arp.pad).toMatchObject({ running: true, held: [], effective: [60] });
    r.api.dispatch({ kind: 'panic' });
    for (const port of ['keys_poly', 'pad_poly'] as const) expect(laneValueAt(r.handle, port, 0, 'gate', 1), `${port} closes now`).toBe(0);
    expect(r.api.state().arp.keys).toMatchObject({ running: false, effective: [], playing: null });
    expect(r.api.state().arp.pad).toMatchObject({ running: false, effective: [], playing: null });
    // Later ticks: nothing is scheduled on either bus after the PANIC.
    const recorded = { keys_poly: laneEvents(r.handle, 'keys_poly', 0, 'gate').length, pad_poly: laneEvents(r.handle, 'pad_poly', 0, 'gate').length };
    for (let i = 1; i <= 8; i++) r.tick(1000 + i * 250, 1 + i * 0.25);
    for (const port of ['keys_poly', 'pad_poly'] as const) {
      expect(laneEvents(r.handle, port, 0, 'gate').slice(recorded[port])).toEqual([]);
      expect(laneValueAt(r.handle, port, 0, 'gate', 3.1)).toBe(0);
    }
    // Retention is independent of PANIC (ui-specification.md:20).
    expect(r.api.selection().pairs.r).toEqual({ x: 0.6, y: -0.2 });
    expect(r.api.selection().mask.r).toBe(true);
    // A finger still DOWN at PANIC is forgotten too: its later release is a
    // no-op, and a fresh press starts a fresh latched pool (PANIC ≠ arp off).
    r.sim.emit(touchStart(r.sim, 3, 'keys', 4, 0));
    r.api.dispatch({ kind: 'panic' });
    r.tick(4000, 4);
    expect(r.api.state().arp.keys).toMatchObject({ running: false, effective: [] });
    r.sim.emit(touchEnd(r.sim, 3, 'keys'));
    r.tick(4250, 4.25);
    expect(laneValueAt(r.handle, 'keys_poly', 0, 'gate', 4.3)).toBe(0);
    r.sim.emit(touchStart(r.sim, 4, 'keys', 7, 0));
    r.tick(4500, 4.5);
    expect(r.api.state().arp.keys).toMatchObject({ running: true, effective: [43] });
    expect(laneValueAt(r.handle, 'keys_poly', 0, 'gate', 4.526)).toBe(1);
  });

  it('F05: ARP off drops the step the arp had queued inside the lookahead — the re-asserted voice keeps its pitch past the old horizon', async () => {
    const r = await rig({ keys_arp_on: 1, keys_arp_div: 3 }); // 1× at 120 bpm = 500 ms steps
    r.sim.emit(touchStart(r.sim, 1, 'keys', 0, 0)); // 36 → −2 V, direct lane 0
    r.sim.emit(touchStart(r.sim, 2, 'keys', 4, 0)); // 40 → −1.667 V, direct lane 1
    r.tick(1000, 1); // step 1: 36 on lane 0 at 1.025
    r.tick(1500, 1.5); // step 2: 40 on lane 0 at 1.525 — queued 25 ms ahead
    expect(laneEvents(r.handle, 'keys_poly', 0, 'pitch').some((e) => e.kind === 'set' && e.time === 1.525)).toBe(true);
    r.handle.setParam('keys_arp_on', 0);
    // The handover at 1.5: the held C2 is re-asserted on lane 0 and E2 on lane 1…
    expect(laneValueAt(r.handle, 'keys_poly', 0, 'pitch', 1.5)).toBe(midiToVOct(36));
    expect(laneValueAt(r.handle, 'keys_poly', 1, 'pitch', 1.5)).toBe(midiToVOct(40));
    expect(laneValueAt(r.handle, 'keys_poly', 0, 'gate', 1.5)).toBe(1);
    expect(laneValueAt(r.handle, 'keys_poly', 1, 'gate', 1.5)).toBe(1);
    // …and AFTER the old lookahead horizon nothing the arp queued survives:
    // lane 0 is still C2 and its gate is still high (the arp's gate-down at
    // 1.275 is history; its queued 1.525 attack and 1.775 release are gone).
    for (const t of [1.53, 1.6, 1.8, 2.5]) {
      expect(laneValueAt(r.handle, 'keys_poly', 0, 'pitch', t), `lane 0 pitch at ${t}`).toBe(midiToVOct(36));
      expect(laneValueAt(r.handle, 'keys_poly', 0, 'gate', t), `lane 0 gate at ${t}`).toBe(1);
    }
    // Later ticks with the arp off schedule nothing more.
    const n = laneEvents(r.handle, 'keys_poly', 0, 'pitch').length;
    r.tick(2000, 2);
    r.tick(2500, 2.5);
    expect(laneEvents(r.handle, 'keys_poly', 0, 'pitch').length).toBe(n);
    // The mirror transition (ARP on) drops the direct path's queued writes the
    // same way: a voice scheduled ahead of the switch cannot re-gate the bus.
    r.sim.emit(touchStart(r.sim, 3, 'keys', 7, 0));
    r.handle.setParam('keys_arp_on', 1);
    expect(laneValueAt(r.handle, 'keys_poly', 2, 'gate', 2.5)).toBe(0);
  });

  it('D17: the lower control cells flip the keys arp, HOLD and the octave as PARAM commits', async () => {
    const r = await rig();
    r.sim.emit(edge(r.sim, 'keyboard_arp', true));
    expect(r.persisted().keys_arp_on).toBe(1);
    expect(r.api.state().arp.keys.enabled).toBe(true);
    r.sim.emit(edge(r.sim, 'keyboard_hold', true));
    expect(r.persisted().keys_arp_latch).toBe(1);
    r.sim.emit(edge(r.sim, 'octave_up', true));
    expect(r.persisted().keys_root).toBe(48);
    r.sim.emit(edge(r.sim, 'octave_down', true));
    r.sim.emit(edge(r.sim, 'octave_down', true));
    expect(r.persisted().keys_root).toBe(24);
    // OFF leaves the five cells inert (extra_controls is the D17 switch).
    const off = await rig({ extra_controls: 0 });
    off.sim.emit(edge(off.sim, 'keyboard_arp', true));
    expect(off.persisted().keys_arp_on).toBeUndefined();
    expect(off.api.state().arp.keys.enabled).toBe(false);
    // …PANIC included: a hand resting on the column cannot close the voices.
    off.sim.emit(touchStart(off.sim, 1, 'keys', 0, 0));
    expect(laneValue(off.handle, 'keys_poly', 0, 'gate')).toBe(1);
    off.sim.emit(edge(off.sim, 'panic', true));
    expect(laneValue(off.handle, 'keys_poly', 0, 'gate')).toBe(1);
    expect(off.api.state().active.keys).toBe(1);
    // The FACE's PANIC cell is not one of the five: it dispatches the intent directly and still fires.
    off.api.dispatch({ kind: 'panic' });
    expect(laneValue(off.handle, 'keys_poly', 0, 'gate')).toBe(0);
    expect(off.api.state().active.keys).toBe(0);
  });

  it('LIGHTING (D09): the runtime publishes ITS roots and scale to the source, on build and on every change', async () => {
    const r = await rig({ keys_root: 48, pad_root: 72, scale: 1 });
    expect(r.sim.lights.at(-1)).toEqual({ keysRoot: 48, padRoot: 72, scale: 'major' });
    expect(r.api.state().lighting).toEqual({ keysRoot: 48, padRoot: 72, scale: 'major' });
    r.handle.setParam!('scale', 0);
    expect(r.sim.lights.at(-1)).toEqual({ keysRoot: 48, padRoot: 72, scale: undefined });
    r.sim.emit(edge(r.sim, 'octave_up', true)); // OCT+ on the instrument moves keys_root → the lights follow the MODULE
    expect(r.sim.lights.at(-1)).toEqual({ keysRoot: 60, padRoot: 72, scale: undefined });
    r.handle.setParam!('scale', 99); // out of roster → chromatic, never a throw
    expect(r.sim.lights.at(-1)!.scale).toBeUndefined();
  });
});

// ── D15 mirroring, dispose, and "no UI" ───────────────────────────────────

describe('linnstrument runtime — targets, disposal and headless operation', () => {
  it('D15 is OPT-IN: unbound by default, and a bound target receives pos_x/pos_y as 7-bit through the graph seam', async () => {
    const unbound = await rig({ sel_r: 1 });
    unbound.sim.emit(pointer(unbound.sim, 1, 'down', 1, 1));
    expect(unbound.deliveries).toEqual([]);

    const bound = await rig({ sel_r: 1 }, { targets: { r: 'joy-1' } });
    bound.sim.emit(pointer(bound.sim, 1, 'down', 1, 0));
    expect(bound.deliveries).toEqual([
      { nodeId: 'joy-1', paramId: 'pos_x', cc: 127 },
      { nodeId: 'joy-1', paramId: 'pos_y', cc: 0 },
    ]);
    expect(bipolarToCc(0)).toBe(64);
  });

  it('a DELETED target is a declined delivery, never a throw or a dangling write', async () => {
    const r = await rig({ sel_r: 1 }, { targets: { r: 'gone' }, deliverOk: false });
    expect(() => r.sim.emit(pointer(r.sim, 1, 'down', 0.2, 0.8))).not.toThrow();
    expect(r.deliveries.length).toBe(2);
    expect(cvValue(r.handle, 'r_x')).toBeCloseTo(-0.6);
  });

  it('dispose unsubscribes: no later event writes a param, a CV, a lane or a target', async () => {
    const r = await rig({ sel_r: 1 }, { targets: { r: 'joy-1' } });
    r.sim.emit(pointer(r.sim, 1, 'down', 0.75, 0.75));
    r.sim.emit(pointer(r.sim, 1, 'up', 0.75, 0.75));
    const commits = r.commits.length;
    const deliveries = r.deliveries.length;
    r.handle.dispose();
    rigs = [];
    r.sim.emit(pointer(r.sim, 2, 'down', 0, 0));
    r.sim.emit(touchStart(r.sim, 3, 'keys', 0, 0));
    r.sim.emit(edge(r.sim, 'g', true));
    r.tick(5000, 50);
    expect(r.commits.length).toBe(commits);
    expect(r.deliveries.length).toBe(deliveries);
    expect(r.ticks.size, 'the clock subscription is gone').toBe(0);
    expect(laneValue(r.handle, 'keys_poly', 0, 'gate')).toBe(0);
  });

  it('the runtime needs no UI: the card-api answers, notifies, and connect is honest without a connector', async () => {
    const r = await rig();
    let notified = 0;
    const off = r.api.subscribe(() => notified++);
    r.sim.emit(edge(r.sim, 'g', true));
    expect(notified).toBeGreaterThan(0);
    off();
    expect(await r.api.connect()).toBe(false);
    setLinnstrumentConnector(async () => true);
    expect(await r.api.connect()).toBe(true);
    expect(r.handle.read!('persisted')).toEqual({ mask: { r: true, g: true, b: false }, pairs: { r: { x: 0, y: 0 }, g: { x: 0, y: 0 }, b: { x: 0, y: 0 } } });
    expect(r.api.state().source).toEqual({ id: 'sim-linnstrument', kind: 'simulated' });
  });

  it('a late subscriber sees the session; losing the source ends every voice', async () => {
    const r = await rig();
    expect(r.api.state().session.state).toBe('connected');
    r.sim.emit(touchStart(r.sim, 1, 'keys', 0, 0));
    setLinnstrumentSource(null);
    expect(r.api.state().session.state).toBe('disconnected');
    expect(laneValue(r.handle, 'keys_poly', 0, 'gate')).toBe(0);
    expect(r.api.state().active.keys).toBe(0);
  });
});
