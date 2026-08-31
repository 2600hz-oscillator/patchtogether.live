// packages/web/src/lib/audio/modules/trails.test.ts
//
// Def shape + FACTORY WIRING for the Bela Trails source module.
//
// The wire format is pinned by trails-decode.test.ts and the binding layer by
// trails-device.test.ts. THIS file covers the seam between them and Web Audio:
// "a byte arrived on a simulated Trails" → "the right ConstantSourceNode got
// the right automation event", driven through the REAL device layer and the
// REAL decoder rather than by calling the factory's internals.
//
// Web Audio is mocked exactly as far as the factory needs (the
// midiclock-factory.test.ts harness), so every automation call is recorded and
// replayable.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  trailsDef,
  trailsAxisPortId,
  trailsGatePortId,
  TRAILS_CHANNELS,
  TRAILS_BAR_TRANSMITS_MIDI,
  TRAILS_CLOCK_PORT_ID,
  TRAILS_LOOP_RETRIGGER_NOTCH_S,
  TRAILS_MAX_SMOOTH_TAU_S,
  TRAILS_TRAIL_LENGTH,
  type TrailsCardApi,
  type TrailsState,
} from './trails';
import { GATE_PULSE_S } from './midiclock';
import { TRAILS_CC_FULL_SCALE } from '$lib/midi/trails-decode';
import {
  __resetTrailsForTest,
  installSimulatedTrails,
  type SimulatedTrails,
} from '$lib/midi/trails-device';
import { __resetSchedulerClockForTests } from '$lib/audio/scheduler-clock';
import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { ModuleNode } from '$lib/graph/types';

// ── The Web Audio mock (midiclock-factory harness) ─────────────────────────

interface RecordedSchedule {
  kind: 'cancel' | 'set' | 'target';
  value?: number;
  time: number;
  tau?: number;
}

function makeParam(initial = 0): {
  value: number;
  events: RecordedSchedule[];
  setValueAtTime: (v: number, t: number) => void;
  setTargetAtTime: (v: number, t: number, tau: number) => void;
  cancelScheduledValues: (t: number) => void;
} {
  const events: RecordedSchedule[] = [];
  const p = {
    value: initial,
    events,
    setValueAtTime(v: number, t: number) {
      p.value = v;
      events.push({ kind: 'set', value: v, time: t });
    },
    setTargetAtTime(v: number, t: number, tau: number) {
      p.value = v;
      events.push({ kind: 'target', value: v, time: t, tau });
    },
    cancelScheduledValues(t: number) {
      events.push({ kind: 'cancel', time: t });
    },
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

function makeMockCtx(): AudioContext {
  return {
    currentTime: 0,
    sampleRate: 48000,
    createConstantSource: () => new FakeConstantSourceNode(),
  } as unknown as AudioContext;
}

function makeNode(params?: Record<string, number>): ModuleNode {
  return {
    id: 'trails-test',
    type: 'trails',
    domain: 'audio',
    position: { x: 0, y: 0 },
    params: params ?? {},
    data: {},
  } as unknown as ModuleNode;
}

/** The automation events written to one output port's offset. */
function eventsOn(handle: AudioDomainNodeHandle, portId: string): RecordedSchedule[] {
  const out = handle.outputs.get(portId);
  const node = out?.node as unknown as FakeConstantSourceNode | undefined;
  return node?.offset.events ?? [];
}
/** The last VALUE-bearing automation event on a port. */
function lastValue(handle: AudioDomainNodeHandle, portId: string): number | undefined {
  const withValue = eventsOn(handle, portId).filter((e) => e.value !== undefined);
  return withValue.at(-1)?.value;
}

/**
 * RISING EDGES a real AudioParam would actually produce on a port.
 *
 * ⚠ COUNTING `value === 1` CALLS IS NOT THIS, and the difference is a whole
 * class of bug. `makeParam` above RECORDS `cancelScheduledValues` rather than
 * honouring it — which is right for asserting "what did the module ask for",
 * and wrong for asserting "what would the jack DO". A real
 * `cancelScheduledValues(t)` deletes every scheduled point at or after `t`, so
 * two retrigger notches scheduled at the same instant collapse into ONE edge
 * while a call-counter cheerfully reports two.
 *
 * So this replays the recorded calls under the real API's semantics — cancel
 * deletes from `t` onward, `setValueAtTime` inserts a point — sorts the
 * surviving timeline, and counts 0→1 transitions from the ConstantSource's
 * resting 0. It is the difference between a test that pins the module's
 * intention and one that pins the sound.
 */
function risingEdges(handle: AudioDomainNodeHandle, portId: string): number {
  let points: { time: number; value: number }[] = [];
  for (const ev of eventsOn(handle, portId)) {
    if (ev.kind === 'cancel') {
      points = points.filter((p) => p.time < ev.time);
    } else if (ev.value !== undefined) {
      points.push({ time: ev.time, value: ev.value });
    }
  }
  points.sort((a, b) => a.time - b.time);
  let prev = 0;
  let edges = 0;
  for (const p of points) {
    if (prev <= 0 && p.value > 0) edges++;
    prev = p.value;
  }
  return edges;
}

// ── Def shape ──────────────────────────────────────────────────────────────

describe('trails def shape', () => {
  it('is an audio-domain MIDI source with a factory', () => {
    expect(trailsDef.type).toBe('trails');
    expect(trailsDef.domain).toBe('audio');
    expect(trailsDef.palette).toEqual({ top: 'MIDI', sub: 'MIDI' });
    expect(trailsDef.category).toBe('sources');
    expect(typeof trailsDef.factory).toBe('function');
  });

  it('label is lowercase (card CSS uppercases for display)', () => {
    expect(trailsDef.label).toBe(trailsDef.label.toLowerCase());
  });

  it('takes NO inputs — Trails documents no MIDI in', () => {
    expect(trailsDef.inputs).toEqual([]);
  });

  it('the literal output list matches the DERIVED roster 1:1', () => {
    // The def spells its ports as literals so the docs-manifest extractor can
    // read them; this is what stops the two from drifting.
    const derived = [
      ...TRAILS_CHANNELS.flatMap((c) => [trailsAxisPortId(c, 'x'), trailsAxisPortId(c, 'y')]),
      ...TRAILS_CHANNELS.map((c) => trailsGatePortId(c)),
      TRAILS_CLOCK_PORT_ID,
    ];
    expect(trailsDef.outputs.map((p) => p.id)).toEqual(derived);
  });

  it('every output is cv or gate — NEVER pitch or poly (the isNoteSource trap)', () => {
    // A pitch- or poly-typed output would put a touch position onto a note
    // LANE, which is not what a coordinate is.
    for (const port of trailsDef.outputs) {
      expect(['cv', 'gate'], `output ${port.id}`).toContain(port.type);
    }
    expect(trailsDef.outputs.filter((p) => p.type === 'cv')).toHaveLength(8);
    expect(trailsDef.outputs.filter((p) => p.type === 'gate')).toHaveLength(5);
  });

  it('every gate-cable port declares its edge vocabulary', () => {
    for (const port of trailsDef.outputs.filter((p) => p.type === 'gate')) {
      expect(port.edge, `output ${port.id}`).toBeTruthy();
    }
    // The four contact gates are LEVELS; the divided clock is a TRIGGER.
    for (const c of TRAILS_CHANNELS) {
      expect(trailsDef.outputs.find((p) => p.id === trailsGatePortId(c))!.edge).toBe('gate');
    }
    expect(trailsDef.outputs.find((p) => p.id === TRAILS_CLOCK_PORT_ID)!.edge).toBe('trigger');
  });

  it('three params, in range, with named option rosters where they are discrete', () => {
    expect(trailsDef.params.map((p) => p.id)).toEqual(['range', 'smooth', 'divisor']);
    for (const p of trailsDef.params) {
      expect(p.defaultValue).toBeGreaterThanOrEqual(p.min);
      expect(p.defaultValue).toBeLessThanOrEqual(p.max);
      if (p.curve === 'discrete') expect(p.options?.length, `${p.id}.options`).toBeGreaterThan(1);
    }
    const byId = Object.fromEntries(trailsDef.params.map((p) => [p.id, p]));
    // UNIPOLAR by default: a touch position is a coordinate, not an amount.
    expect(byId.range!.defaultValue).toBe(0);
    expect(byId.range!.options!.map((o) => o.label)).toEqual(['UNI', 'BI']);
    // 24 MIDI ticks = one quarter note, the division TIMELORDE expects.
    expect(byId.divisor!.defaultValue).toBe(24);
    expect(byId.divisor!.optionsExhaustive?.why.length).toBeGreaterThan(40);
  });

  it('docs cover the explanation, every output and every control', () => {
    const docs = trailsDef.docs!;
    expect(docs.explanation!.length).toBeGreaterThan(400);
    expect(docs.inputs).toEqual({});
    for (const port of trailsDef.outputs) {
      expect(docs.outputs?.[port.id], `docs.outputs.${port.id}`).toBeTruthy();
    }
    for (const p of trailsDef.params) {
      expect(docs.controls?.[p.id], `docs.controls.${p.id}`).toBeTruthy();
    }
  });

  it('declares NO `bar` output — the Bar is not on the wire and cannot be invented', () => {
    // ⚠ THIS TEST IS A FINDING, NOT A LIMITATION. The device's MIDI mapping
    // table is eight rows (1.X … 4.Y on channels 1–8), the quick reference
    // states the transmit set as "Each X and Y output transmits over its own
    // channel", and the module's physical outputs are 8 CV + 4 gate — the Bar
    // has neither a MIDI message nor an output jack, so no ES-9 patch could
    // carry it either. A `bar` jack here would be a port that can never move.
    //
    // If a firmware ever transmits it, the flag flips, this test changes
    // DELIBERATELY, and the reviewer sees the claim change in the diff.
    expect(TRAILS_BAR_TRANSMITS_MIDI).toBe(false);
    expect(trailsDef.outputs.map((p) => p.id)).not.toContain('bar');
  });

  it('declares NO face — the bespoke-surface disposition is deliberate', () => {
    // Authoring a face IS the promotion (module-face-lint's deny-by-default
    // anchor), and the inventory entry records why this module is not.
    expect((trailsDef as { face?: unknown }).face).toBeUndefined();
  });
});

// ── The data-flow law, at the source ───────────────────────────────────────

describe('trails: the touch stream never reaches the Y.Doc', () => {
  it('the module source imports NO graph-store or mutation seam', () => {
    // A live gesture is 100-250 messages a second. The
    // cv-modulation-live-store-write-storm law says not one of them may become
    // a synced write, and the cheapest way to hold that is to make the module
    // structurally incapable of one: it imports no store, no mutator, no ydoc.
    const src = readFileSync(fileURLToPath(new URL('./trails.ts', import.meta.url)), 'utf8');
    const imports = src.split('\n').filter((l) => /^\s*import\b|from '\$lib/.test(l));
    for (const forbidden of ['$lib/graph/store', '$lib/graph/mutate']) {
      expect(imports.join('\n'), `must not import ${forbidden}`).not.toContain(forbidden);
    }
    for (const seam of ['mutateNode', 'setNodeParam', 'ydoc.transact', 'livePatch']) {
      expect(src, `must not reference ${seam}`).not.toContain(seam);
    }
  });

  it('a burst of touches leaves node.params and node.data untouched', async () => {
    const node = makeNode();
    const handle = await trailsDef.factory!(makeMockCtx(), node);
    const sim = await installSimulatedTrails();
    for (let i = 0; i < 200; i++) sim.touch(1, i / 200, 1 - i / 200);
    expect(node.params).toEqual({});
    expect(node.data).toEqual({});
    handle.dispose();
  });
});

// ── Factory wiring ─────────────────────────────────────────────────────────

/**
 * Real elapsed time between simulated loop repetitions.
 *
 * ⚠ A REAL WAIT, AND IT HAS TO BE. Two gate notches scheduled at the same audio
 * instant collapse into ONE edge on a real AudioParam (see `risingEdges`), so a
 * test asserting "N repetitions, N edges" has to space them in AUDIO time — and
 * audio time here is derived from each frame's `performance.now()` timestamp by
 * the real MIDI scheduler. That scheduler deliberately refuses to project a
 * timestamp dated in the future, and floors one whose lag exceeds its 25 ms
 * lookahead, so a faked clock cannot buy spacing in either direction: pushed
 * forward it re-anchors, pushed back it floors, and every event lands on the
 * same instant either way. Letting real time pass is what actually moves the
 * projection, and 20 ms is comfortably wider than the 5 ms notch while keeping
 * the whole block under the module's 120 ms activity timeout per step.
 */
const LOOP_PERIOD_MS = 20;

/** Let real time pass between two simulated device events. */
function spaceOut(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, LOOP_PERIOD_MS));
}

describe('trails factory: the simulated device drives the outputs', () => {
  let sim: SimulatedTrails;
  let handle: AudioDomainNodeHandle | null = null;

  beforeEach(async () => {
    sim = await installSimulatedTrails();
  });
  afterEach(() => {
    handle?.dispose();
    handle = null;
    __resetTrailsForTest();
    __resetSchedulerClockForTests();
  });

  async function build(params?: Record<string, number>): Promise<AudioDomainNodeHandle> {
    handle = await trailsDef.factory!(makeMockCtx(), makeNode(params));
    return handle;
  }

  it('exposes one output node per declared port', async () => {
    const h = await build();
    expect([...h.outputs.keys()].sort()).toEqual(trailsDef.outputs.map((p) => p.id).sort());
    expect(h.inputs.size).toBe(0);
  });

  it('a touch writes the pad coordinate to that channel\'s X and Y jacks', async () => {
    const h = await build();
    sim.touch(3, 0.75, 0.25);
    expect(lastValue(h, 'x3')).toBeCloseTo(0.75, 4);
    expect(lastValue(h, 'y3')).toBeCloseTo(0.25, 4);
    // …and only that channel moved.
    expect(eventsOn(h, 'x1')).toHaveLength(0);
  });

  it('RANGE=BI maps the pad into -1..+1 about its centre', async () => {
    const h = await build({ range: 1 });
    sim.touch(1, 1, 0.5);
    expect(lastValue(h, 'x1')).toBeCloseTo(1, 4);
    expect(lastValue(h, 'y1')).toBeCloseTo(0, 3);
    sim.touch(1, 0, 0);
    expect(lastValue(h, 'x1')).toBeCloseTo(-1, 4);
  });

  it('RANGE is live — flipping it changes the NEXT sample, not the jack retroactively', async () => {
    const h = await build();
    sim.touch(1, 1, 1);
    expect(lastValue(h, 'x1')).toBeCloseTo(1, 4);
    h.setParam('range', 1);
    sim.touch(1, 0.5, 0.5);
    expect(lastValue(h, 'x1')).toBeCloseTo(0, 3);
  });

  it('SMOOTH=0 steps instantly; SMOOTH>0 ramps with a time constant', async () => {
    const stepped = await build();
    sim.touch(1, 0.5, 0.5);
    expect(eventsOn(stepped, 'x1').filter((e) => e.kind === 'target')).toHaveLength(0);
    expect(eventsOn(stepped, 'x1').some((e) => e.kind === 'set')).toBe(true);
    stepped.dispose();

    handle = null;
    const glided = await build({ smooth: 1 });
    sim.touch(1, 0.5, 0.5);
    const targets = eventsOn(glided, 'x1').filter((e) => e.kind === 'target');
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.at(-1)!.tau).toBeCloseTo(TRAILS_MAX_SMOOTH_TAU_S, 6);
  });

  it('a note on/off drives that channel\'s gate to 1 and back to 0', async () => {
    const h = await build();
    sim.gateOn(2);
    expect(lastValue(h, 'g2')).toBe(1);
    sim.gateOff(2);
    expect(lastValue(h, 'g2')).toBe(0);
    expect(eventsOn(h, 'g1')).toHaveLength(0);
  });

  it('the clock jack pulses once per DIVISOR ticks, high then low', async () => {
    const h = await build({ divisor: 24 });
    sim.clock(23);
    expect(eventsOn(h, TRAILS_CLOCK_PORT_ID)).toHaveLength(0);
    sim.clock(1);
    const pulse = eventsOn(h, TRAILS_CLOCK_PORT_ID).filter((e) => e.value !== undefined);
    expect(pulse.map((e) => e.value)).toEqual([1, 0]);
    expect(pulse[1]!.time - pulse[0]!.time).toBeCloseTo(GATE_PULSE_S, 9);
    // …and the next 24 produce exactly one more pulse.
    sim.clock(24);
    expect(eventsOn(h, TRAILS_CLOCK_PORT_ID).filter((e) => e.value === 1)).toHaveLength(2);
  });

  it('RAW division passes every incoming tick', async () => {
    const h = await build({ divisor: 1 });
    sim.clock(4);
    expect(eventsOn(h, TRAILS_CLOCK_PORT_ID).filter((e) => e.value === 1)).toHaveLength(4);
  });

  it('an illegal saved division SNAPS at the point of use rather than going silent', async () => {
    // A rack saved before the roster existed (or arriving through an undo or a
    // replica restore) must still clock. 7 snaps to the nearest legal value.
    const h = await build({ divisor: 7 });
    sim.clock(24);
    expect(eventsOn(h, TRAILS_CLOCK_PORT_ID).filter((e) => e.value === 1).length).toBeGreaterThan(0);
  });

  it('MIDI Start re-zeroes the divider; Continue deliberately does not', async () => {
    const h = await build({ divisor: 24 });
    sim.clock(12);
    sim.start(); // reset — the next pulse is a full 24 away
    sim.clock(23);
    expect(eventsOn(h, TRAILS_CLOCK_PORT_ID).filter((e) => e.value === 1)).toHaveLength(0);
    sim.clock(1);
    expect(eventsOn(h, TRAILS_CLOCK_PORT_ID).filter((e) => e.value === 1)).toHaveLength(1);
  });

  it('MIDI Stop drops the clock jack low', async () => {
    const h = await build({ divisor: 1 });
    sim.clock(1);
    sim.stop();
    expect(lastValue(h, TRAILS_CLOCK_PORT_ID)).toBe(0);
  });

  // ── The loop gate ────────────────────────────────────────────────────────
  //
  // The owner's report: "when the loop fires it doesn't seem like there is a
  // gate event happening every time". These four tests are the defect, the fix,
  // and the property the fix has to hold.

  it('NEGATIVE CONTROL: gapless playback alone gives ONE rising edge for the whole session', async () => {
    // Drives the real device double through the real decoder into the real
    // automation timeline. Several loops' worth of continuous motion, and the
    // gate jack has exactly one rising edge — because a loop restart is a value
    // discontinuity, not a gap, so nothing in an activity timeout can see it.
    // This is what the hardware was doing.
    const h = await build();
    for (let rep = 0; rep < 5; rep++) {
      await spaceOut();
      sim.glide(1, 20, { x: 0, y: 0 }, { x: 1, y: 1 });
    }
    expect(risingEdges(h, 'g1')).toBe(1);
  });

  it('one Start per repetition gives exactly ONE rising edge per repetition', async () => {
    const h = await build();
    // The gesture is already playing when the first repetition is announced —
    // the order it happens in on hardware, and the order that separates the one
    // CONTACT edge from the per-repetition ones.
    sim.glide(1, 20, { x: 0, y: 0 }, { x: 1, y: 1 });
    expect(risingEdges(h, 'g1'), 'contact').toBe(1);
    const REPS = 4;
    for (let rep = 0; rep < REPS; rep++) {
      // ⚠ SPACED like real repetitions. Two notches scheduled at ONE instant
      // collapse into a single edge on a real AudioParam (see `risingEdges`),
      // so a synchronous burst would measure the harness, not the module.
      await spaceOut();
      sim.playLoop(1, 20, { x: 0, y: 0 }, { x: 1, y: 1 });
    }
    expect(risingEdges(h, 'g1'), 'one edge per repetition, plus the contact edge').toBe(1 + REPS);
    // …and the counters the card shows agree with the timeline.
    const st = h.read!('state') as TrailsState;
    expect(st.loopRestarts).toBe(REPS);
    expect(st.gateEdges[0]).toBe(1 + REPS);
  });

  it('the retrigger is a NOTCH — low, then high one notch later', async () => {
    // The mechanism, pinned. A "set high" would be a no-op on an already-high
    // jack and the rack would see nothing at all.
    const h = await build();
    sim.glide(1, 8); // gate up, streaming
    const before = eventsOn(h, 'g1').length;
    await spaceOut();
    sim.loopRestart();
    const added = eventsOn(h, 'g1')
      .slice(before)
      .filter((e) => e.value !== undefined);
    expect(added.map((e) => e.value)).toEqual([0, 1]);
    expect(added[1]!.time - added[0]!.time).toBeCloseTo(TRAILS_LOOP_RETRIGGER_NOTCH_S, 9);
  });

  it('with NOTHING recorded, a running transport does not put a pulse train on the gates', async () => {
    // A Start with no gesture anywhere is not a gesture repetition. Striking
    // channel 1 anyway would pulse an empty jack for as long as the device's
    // transport ran — a gate that means nothing.
    const h = await build();
    for (let i = 0; i < 3; i++) {
      await spaceOut();
      sim.loopRestart();
    }
    for (const c of TRAILS_CHANNELS) expect(eventsOn(h, trailsGatePortId(c))).toHaveLength(0);
    // The restarts were still DECODED — the clock divider still re-zeroes.
    expect((h.read!('state') as TrailsState).loopRestarts).toBe(3);
  });

  it('a loop restart leaves the OTHER channels alone', async () => {
    const h = await build();
    sim.glide(2, 8);
    await spaceOut();
    sim.loopRestart();
    // Channel 2 was streaming, so it re-strikes; channels 3 and 4 were not.
    expect(risingEdges(h, 'g2')).toBeGreaterThan(0);
    expect(eventsOn(h, 'g3')).toHaveLength(0);
    expect(eventsOn(h, 'g4')).toHaveLength(0);
  });
});

// ── The card-visible surface ───────────────────────────────────────────────

describe('trails factory: the state the pad mirror paints', () => {
  let sim: SimulatedTrails;
  let handle: AudioDomainNodeHandle | null = null;

  beforeEach(async () => {
    sim = await installSimulatedTrails();
  });
  afterEach(() => {
    handle?.dispose();
    handle = null;
    __resetTrailsForTest();
    __resetSchedulerClockForTests();
  });

  function state(h: AudioDomainNodeHandle): TrailsState {
    return h.read!('state') as TrailsState;
  }

  it('reports the pad\'s OWN coordinates, independent of the RANGE knob', async () => {
    // The view mirrors the physical surface; the jacks are what RANGE changes.
    handle = await trailsDef.factory!(makeMockCtx(), makeNode({ range: 1 }));
    sim.gateOn(1);
    sim.touch(1, 0.9, 0.1);
    const ch = state(handle).channels[0]!;
    expect(ch.x).toBeCloseTo(0.9, 4);
    expect(ch.y).toBeCloseTo(0.1, 4);
    expect(lastValue(handle, 'x1')).toBeCloseTo(0.8, 3); // BI, for contrast
  });

  it('the trail is a bounded ring — it never grows with stream length', async () => {
    handle = await trailsDef.factory!(makeMockCtx(), makeNode());
    sim.gateOn(1);
    for (let i = 0; i < TRAILS_TRAIL_LENGTH * 5; i++) sim.touch(1, i / 1000, 0.5);
    expect(state(handle).channels[0]!.trail.length).toBe(TRAILS_TRAIL_LENGTH);
  });

  it('a falling gate clears the trail so the next touch reads as a NEW stroke', async () => {
    handle = await trailsDef.factory!(makeMockCtx(), makeNode());
    sim.gateOn(1);
    sim.touch(1, 0.2, 0.2);
    expect(state(handle).channels[0]!.trail.length).toBeGreaterThan(0);
    sim.gateOff(1);
    expect(state(handle).channels[0]!.trail).toHaveLength(0);
  });

  it('counts axis messages and clock ticks so a silent module is distinguishable', async () => {
    handle = await trailsDef.factory!(makeMockCtx(), makeNode());
    expect(state(handle).axisMessages).toBe(0);
    sim.touch(1, 0.5, 0.5);
    expect(state(handle).axisMessages).toBe(4); // 2 axes x (MSB + LSB)
    sim.clock(3);
    expect(state(handle).clockTicks).toBe(3);
  });

  it('the MIDI monitor reports traffic the decoder REJECTED, which is its whole job', async () => {
    handle = await trailsDef.factory!(makeMockCtx(), makeNode());
    const api = handle.read!('card-api') as TrailsCardApi;
    sim.touch(1, 0.5, 0.5); // four frames the decoder understands
    // CC47 on channel 1: what a firmware using the MIDI-convention fine partner
    // would send. The module ignores it — and the monitor must SAY so, because
    // this is exactly the shape of a wrong CC-pair constant.
    sim.send([0xb0, 47, 0x40]);
    // Channel 9 carries no Trails axis, so this is dropped too.
    sim.send([0xb8, 0x0f, 0x40]);

    const snap = api.monitor();
    expect(snap.total).toBe(6);
    expect(snap.unrecognised).toBe(2);
    expect(snap.rows.find((r) => r.label === 'ch1 CC47')?.decoded).toBe(false);
    // The COUNT — the header prints "N not decoded" even at zero, so the bare
    // phrase would pass on a monitor that dropped the rejected frames.
    expect(snap.summary).toContain('2 not decoded');

    // The cheap counters on `state` agree, so a closed card can still warn.
    const st = handle.read!('state') as TrailsState;
    expect(st.midiFrames).toBe(6);
    expect(st.midiFramesUnrecognised).toBe(2);

    api.resetMonitor();
    expect(api.monitor().total).toBe(0);
    expect((handle.read!('state') as TrailsState).midiFrames).toBe(0);
  });

  it('exposes a gesture-gated connect on the card API and mirrors the status', async () => {
    handle = await trailsDef.factory!(makeMockCtx(), makeNode());
    const api = handle.read!('card-api') as TrailsCardApi;
    expect(typeof api.connect).toBe('function');
    expect(api.status().kind).toBe('bound');
    expect(state(handle).status.portNames).toEqual(['Bela Trails']);
  });

  it('dispose() unsubscribes — a later frame reaches nothing', async () => {
    handle = await trailsDef.factory!(makeMockCtx(), makeNode());
    const h = handle;
    sim.touch(1, 0.5, 0.5);
    const before = state(h).axisMessages;
    h.dispose();
    handle = null;
    sim.touch(1, 0.9, 0.9);
    // The handle is torn down; its counters must not have moved.
    expect((h.read!('state') as TrailsState).axisMessages).toBe(before);
  });

  it('NEGATIVE CONTROL: with no touches, every jack is still at rest', async () => {
    handle = await trailsDef.factory!(makeMockCtx(), makeNode());
    for (const port of trailsDef.outputs) {
      expect(eventsOn(handle, port.id), `port ${port.id}`).toHaveLength(0);
    }
    expect(state(handle).channels.every((c) => !c.gate && c.trail.length === 0)).toBe(true);
  });
});

describe('trails: full-scale arithmetic', () => {
  it('the pad\'s far corner is exactly 1.0 on the jack', async () => {
    const sim = await installSimulatedTrails();
    const handle = await trailsDef.factory!(makeMockCtx(), makeNode());
    sim.send([0xb0, 0x0f, 0x7f]);
    sim.send([0xb0, 0x25, 0x7f]);
    expect(lastValue(handle, 'x1')).toBe(TRAILS_CC_FULL_SCALE / TRAILS_CC_FULL_SCALE);
    handle.dispose();
    __resetTrailsForTest();
    __resetSchedulerClockForTests();
  });
});
