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
  trailsPolyPortId,
  trailsTrigPortId,
  TRAILS_POLY_LANE,
  TRAILS_CHANNELS,
  TRAILS_BAR_TRANSMITS_MIDI,
  TRAILS_CLOCK_PORT_ID,
  TRAILS_LOOP_RETRIGGER_NOTCH_S,
  TRAILS_MAX_SMOOTH_TAU_S,
  TRAILS_TRIGGER_PULSE_S,
  TRAILS_TRAIL_LENGTH,
  type TrailsCardApi,
  type TrailsState,
} from './trails';
import { GATE_PULSE_S } from './midiclock';
import { TRAILS_CC_FULL_SCALE } from '$lib/midi/trails-decode';
import { isNoteSource, isClipEligible, resolveClipWiring } from '$lib/graph/patch-convenience';
import { POLY_CHANNEL_PAIRS } from '$lib/audio/poly';
import { midiToVOct } from '$lib/audio/note-entry';
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
  disconnect = vi.fn();
  /**
   * ⚠ A REAL FUNCTION, not a bare `vi.fn()`, because the poly bus's whole
   * addressing lives in this call: `pitchSrc.connect(merger, 0, lane*2)` is the
   * ONLY thing that says which lane a ConstantSource is. A spy that recorded
   * the call without wiring it would let a test read lane 0 while the module
   * wrote lane 1 and still pass.
   */
  connect(target?: unknown, _output?: number, input?: number): void {
    if (target instanceof FakeChannelMergerNode && typeof input === 'number') {
      target.inputs.set(input, this);
    }
  }
}

/** The poly bus's ChannelMergerNode. Records nothing of its own — every value
 *  the bus carries is written to a ConstantSource `offset`, which the mock above
 *  already records, so the merger only has to exist and accept connections. */
class FakeChannelMergerNode {
  readonly channelCount: number;
  /** Merger input index → the ConstantSource feeding it. */
  readonly inputs = new Map<number, FakeConstantSourceNode>();
  connect = vi.fn();
  disconnect = vi.fn();
  constructor(channels: number) {
    this.channelCount = channels;
  }
}

function makeMockCtx(): AudioContext {
  return {
    currentTime: 0,
    sampleRate: 48000,
    createConstantSource: () => new FakeConstantSourceNode(),
    createChannelMerger: (n: number) => new FakeChannelMergerNode(n),
  } as unknown as AudioContext;
}

/**
 * The automation events on one poly LANE's pitch or gate ConstantSource.
 *
 * ⚠ REACHED THROUGH THE PORT'S OWN MERGER, not through a handle the test kept
 * from construction. `createPolySender` connects lane i's pitch to merger input
 * `i*2` and its gate to `i*2+1`, so this asserts against the node the ENGINE
 * would actually read — the same reason the outputs map stores `{ node, output }`
 * rather than a bare node.
 */
function polyLaneEvents(
  handle: AudioDomainNodeHandle,
  portId: string,
  lane: number,
  kind: 'pitch' | 'gate',
): RecordedSchedule[] {
  const merger = handle.outputs.get(portId)?.node as unknown as FakeChannelMergerNode | undefined;
  if (!merger) return [];
  return merger.inputs.get(lane * 2 + (kind === 'gate' ? 1 : 0))?.offset.events ?? [];
}

/** The last value written to one poly lane's pitch or gate. */
function polyLaneValue(
  handle: AudioDomainNodeHandle,
  portId: string,
  lane: number,
  kind: 'pitch' | 'gate',
): number | undefined {
  const withValue = polyLaneEvents(handle, portId, lane, kind).filter((e) => e.value !== undefined);
  return withValue.at(-1)?.value;
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
      ...TRAILS_CHANNELS.map((c) => trailsTrigPortId(c)),
      ...TRAILS_CHANNELS.map((c) => trailsPolyPortId(c)),
    ];
    expect(trailsDef.outputs.map((p) => p.id)).toEqual(derived);
  });

  it('POSITIONS stay cv, CONTACT stays gate, and only the NOTE buses are poly', () => {
    // ⚠ THIS TEST REVERSED. It used to read "every output is cv or gate —
    // NEVER pitch or poly (the isNoteSource trap)", and the reversal is
    // deliberate and owner-approved rather than a rule quietly relaxed.
    //
    // The original reason still holds for the jacks it was written about: a
    // touch POSITION is not a pitch, so x/y stay `cv` and the contact gates
    // stay `gate`. What is new is four buses that exist only in note mode,
    // where the device genuinely is emitting pitches.
    expect(trailsDef.outputs.filter((p) => p.type === 'cv')).toHaveLength(8);
    expect(trailsDef.outputs.filter((p) => p.type === 'polyPitchGate')).toHaveLength(4);
    // ⚠ THE GATE-CABLE PORTS ARE COUNTED BY EDGE VOCABULARY, not as one lump.
    // Nine share the `gate` CABLE and they are two different signals: four
    // level-sensitive contact gates, and five triggers (four step triggers plus
    // the divided clock). A bare count of nine would have hidden a trig port
    // accidentally declared as a level, which is the mistake rule 7 is about.
    const gateCable = trailsDef.outputs.filter((p) => p.type === 'gate');
    expect(gateCable).toHaveLength(9);
    expect(gateCable.filter((p) => p.edge === 'gate')).toHaveLength(4);
    expect(gateCable.filter((p) => p.edge === 'trigger')).toHaveLength(5);
    // No `pitch`-typed output: a MONO pitch cable would have to pick one of the
    // two axes and call it the note, which is a choice the device does not make.
    expect(trailsDef.outputs.some((p) => p.type === 'pitch')).toBe(false);
    // The positions specifically are still cv, named rather than counted.
    for (const c of TRAILS_CHANNELS) {
      for (const axis of ['x', 'y'] as const) {
        expect(trailsDef.outputs.find((p) => p.id === trailsAxisPortId(c, axis))!.type).toBe('cv');
      }
    }
  });

  it('the poly outputs make it a NOTE SOURCE — and that costs nothing, measured', () => {
    // ⚠ THE CONTRACT CHANGE, WITH ITS BLAST RADIUS PINNED. `isNoteSource` has
    // exactly two consumers and both are about wiring something INTO a module:
    // `resolveClipWiring` (a note source is never a clip target) and the column
    // note-tap pass. TRAILS declares NO INPUTS, so both already declined it —
    // `isClipEligible` was false before this change and is false after.
    //
    // Asserting the BEFORE state too, because "it was already false" is the
    // entire justification for accepting the flip, and an unasserted premise is
    // how a justification rots.
    expect(trailsDef.inputs, 'the premise: nothing can be wired IN').toEqual([]);
    expect(isNoteSource(trailsDef as never), 'the contract flipped').toBe(true);
    expect(isClipEligible(trailsDef as never), 'the behaviour did not').toBe(false);
    expect(resolveClipWiring(trailsDef as never)).toBeNull();
    // …and the same predicate on a def with the poly ports removed agrees, so
    // the `false` above is a property of having no inputs and not of the flip.
    const withoutPoly = {
      ...trailsDef,
      outputs: trailsDef.outputs.filter((p) => p.type !== 'polyPitchGate'),
    };
    expect(isNoteSource(withoutPoly as never)).toBe(false);
    expect(isClipEligible(withoutPoly as never), 'false either way').toBe(false);
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

  it('declares a face, and the CONNECT gesture ranks FIRST on it', () => {
    // ⚠ THIS TEST USED TO ASSERT THE OPPOSITE — `face` is `undefined`, "the
    // bespoke-surface disposition is deliberate" — and that was true until the
    // surface shipped (2026-09-02). INVERTED rather than deleted, because what
    // it pins is the same thing it pinned then: authoring a `face` IS the
    // promotion (module-face-lint's deny-by-default anchor), so this field is
    // load-bearing in both directions and a silent deletion of it would
    // un-promote the module while leaving the extension and the cell in place.
    //
    // The face's STRUCTURE — the forced `glyph: 'none'`, the tier ladder, the
    // audition probe, the page cover — is pinned in
    // `$lib/ui/workflow/trails-face-model.test.ts`, beside the registries that
    // resolve it. This leg is only the def-side existence claim.
    expect(trailsDef.face).toBeTruthy();
    expect(trailsDef.face!.order[0]).toBe('trails-connect-{n}');
    expect(trailsDef.face!.extension).toBe('trails');
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
    expect(snap.rows.find((r) => r.label === 'ch1[1X] CC47')?.decoded).toBe(false);
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
    // ⚠ EVERY OUTPUT, INCLUDING THE POLY BUSES, and they are read through their
    // OWN accessor rather than the ConstantSource one. A poly port's node is a
    // ChannelMergerNode with no `offset` at all, so the scalar reader returns
    // nothing for it — which would make this sweep VACUOUSLY pass on four ports
    // while looking exhaustive. Each kind is asserted with the reader that can
    // actually see it.
    for (const port of trailsDef.outputs) {
      if (port.type === 'polyPitchGate') {
        for (let lane = 0; lane < POLY_CHANNEL_PAIRS; lane++) {
          for (const kind of ['pitch', 'gate'] as const) {
            expect(
              polyLaneEvents(handle, port.id, lane, kind),
              `poly ${port.id} lane ${lane} ${kind}`,
            ).toHaveLength(0);
          }
        }
      } else {
        expect(eventsOn(handle, port.id), `port ${port.id}`).toHaveLength(0);
      }
    }
    expect(state(handle).channels.every((c) => !c.gate && c.trail.length === 0)).toBe(true);
  });
});

// ── NOTE MODE, through the whole module ─────────────────────────────────────
//
// THE OWNER'S REPORT: "when i hit scale i am just getting one continuous note
// output even when i select other notes in the scale."
//
// Enabling both quantisations makes Trails stop sending CC and send notes
// instead — the SAME axes, on the SAME per-axis MIDI channels. The note branch
// used to keep only a gate, so every X/Y jack froze at its last CC value and
// the rack heard one held pitch forever.
//
// ⚠ THESE TESTS ASSERT THE JACK VALUE, NOT THAT AN EDGE FIRED. The gate tests
// above were green for the entire life of this bug.

describe('trails factory: NOTE MODE steers the jacks', () => {
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

  it('THE BUG: two different notes write two DIFFERENT values to the jack', async () => {
    const h = await trailsDef.factory!(makeMockCtx(), makeNode());
    handle = h;
    sim.noteTouch(1, 24, 24);
    const low = lastValue(h, 'x1');
    sim.noteTouch(1, 108, 108);
    const high = lastValue(h, 'x1');
    expect(low, 'a note reaches the jack at all').toBeDefined();
    expect(low).toBeCloseTo(24 / 127, 3);
    expect(high).toBeCloseTo(108 / 127, 3);
    expect(high!, 'the jack MOVED — this is the whole defect').toBeGreaterThan(low! + 0.5);
  });

  it('the Y axis moves independently, on its own MIDI channel', async () => {
    const h = await trailsDef.factory!(makeMockCtx(), makeNode());
    handle = h;
    sim.noteTouch(1, 30, 100);
    expect(lastValue(h, 'x1')).toBeCloseTo(30 / 127, 3);
    expect(lastValue(h, 'y1')).toBeCloseTo(100 / 127, 3);
    // …and nothing leaked onto another Trails channel.
    expect(eventsOn(h, 'x2')).toHaveLength(0);
  });

  it('the gate rises with the strike and falls on the velocity-0 release', async () => {
    // The existing gate behaviour, unchanged by the axis emit — and driven by
    // the release shape the hardware actually sends.
    const h = await trailsDef.factory!(makeMockCtx(), makeNode());
    handle = h;
    sim.noteTouch(2, 60, 64);
    expect(lastValue(h, 'g2')).toBe(1);
    sim.noteRelease(2, 60, 64);
    expect(lastValue(h, 'g2')).toBe(0);
  });

  it('a release HOLDS the jack instead of slamming it to zero', async () => {
    const h = await trailsDef.factory!(makeMockCtx(), makeNode());
    handle = h;
    sim.noteTouch(1, 100, 100);
    const held = lastValue(h, 'x1');
    sim.noteRelease(1, 100, 100);
    expect(lastValue(h, 'x1'), 'the position holds, as it does in CC mode').toBe(held);
  });

  it('RANGE=BI applies to a note-derived axis exactly as it does to a CC one', async () => {
    // The whole reason the fix goes through `emitAxis`: nothing downstream had
    // to learn about notes. Note 127 is the top of the pad, which is +1 in BI.
    const h = await trailsDef.factory!(makeMockCtx(), makeNode({ range: 1 }));
    handle = h;
    sim.noteTouch(1, 127, 0);
    expect(lastValue(h, 'x1')).toBeCloseTo(1, 4);
    expect(lastValue(h, 'y1')).toBeCloseTo(-1, 4);
  });

  it('SMOOTH applies to a note-derived axis too', async () => {
    const h = await trailsDef.factory!(makeMockCtx(), makeNode({ smooth: 1 }));
    handle = h;
    sim.noteTouch(1, 90, 90);
    const targets = eventsOn(h, 'x1').filter((e) => e.kind === 'target');
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.at(-1)!.tau).toBeCloseTo(TRAILS_MAX_SMOOTH_TAU_S, 6);
  });

  it('the pad mirror follows the quantised position, and counts the messages', async () => {
    const h = await trailsDef.factory!(makeMockCtx(), makeNode());
    handle = h;
    sim.noteTouch(1, 127, 0);
    const st = h.read!('state') as TrailsState;
    expect(st.channels[0]!.x).toBeCloseTo(1, 4);
    expect(st.channels[0]!.y).toBeCloseTo(0, 4);
    expect(st.channels[0]!.gate).toBe(true);
    // Two strikes, two axis values — the counter the card shows as RECEIVING
    // now moves in note mode, where before it sat at zero and the module looked
    // like it was not hearing the device at all.
    expect(st.axisMessages).toBe(2);
  });

  it('a run of quantised notes moves the jack EVERY time, never once', async () => {
    // The owner's own capture, played back through the real device double: the
    // notes their hardware sent on channel 1's X. Before the fix this list
    // produced exactly one jack value — the stale CC one — for all five.
    const h = await trailsDef.factory!(makeMockCtx(), makeNode());
    handle = h;
    const seen: number[] = [];
    for (const note of [77, 80, 82, 88, 89]) {
      sim.noteTouch(1, note, 60);
      seen.push(lastValue(h, 'x1')!);
    }
    expect(new Set(seen).size, 'five notes, five distinct jack values').toBe(5);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
  });

  it('THE GATE DEFECT: the jack stays HIGH while either axis is sounding', async () => {
    // Owner: "i need gates on a channel when notes are firing on that channel."
    // One Trails channel spends TWO MIDI channels; both axes' notes shared one
    // deduplicating Set, so an X release with Y still held dropped g2 to 0
    // mid-gesture. `noteTouch` strikes both axes with the SAME note number,
    // which is the collision that made it reachable.
    const h = await trailsDef.factory!(makeMockCtx(), makeNode());
    handle = h;
    sim.noteTouch(2, 71, 71);
    expect(lastValue(h, 'g2')).toBe(1);
    // Release X ONLY, by hand — the sim's `noteRelease` lets go of both.
    sim.send([0x92, 71, 0]);
    expect(lastValue(h, 'g2'), 'Y is still sounding, so the channel is').toBe(1);
    // …and the last axis to let go is the one that lowers it.
    sim.send([0x93, 71, 0]);
    expect(lastValue(h, 'g2')).toBe(0);
  });

  it('a diagonal gesture does not chatter the gate on the pad mirror either', async () => {
    const h = await trailsDef.factory!(makeMockCtx(), makeNode());
    handle = h;
    sim.noteTouch(1, 60, 60);
    expect((h.read!('state') as TrailsState).channels[0]!.gate).toBe(true);
    sim.send([0x90, 60, 0]); // X lets go; Y still holds 60
    expect(
      (h.read!('state') as TrailsState).channels[0]!.gate,
      'the pad mirror must not show the finger lifting either',
    ).toBe(true);
  });

  // ── The per-channel STEP TRIGGERS ──────────────────────────────────────

  it('THE DEFECT, at the jack: one gesture = ONE gate edge but MANY trig pulses', async () => {
    // The owner's report made mechanical at the module boundary. An interleaved
    // gesture (X and Y crossing their quantiser steps at different moments)
    // leaves the contact level high throughout, so a drum on `g2` fires once.
    const h = await trailsDef.factory!(makeMockCtx(), makeNode());
    handle = h;
    const seq: number[][] = [
      [0x92, 60, 127], [0x93, 67, 127],
      [0x92, 60, 0], [0x92, 62, 127],
      [0x93, 67, 0], [0x93, 69, 127],
      [0x92, 62, 0], [0x92, 64, 127],
      [0x93, 69, 0], [0x93, 71, 127],
    ];
    for (const bytes of seq) sim.send(bytes);

    expect(risingEdges(h, 'g2'), 'the contact gate rose once and stayed').toBe(1);
    const pulses = eventsOn(h, 'trig2').filter((e) => e.value === 1);
    expect(pulses.length, 'but the trigger jack articulated every step').toBeGreaterThan(3);
    const st = h.read!('state') as TrailsState;
    expect(st.stepTriggers[1]).toBe(pulses.length);
    expect(st.gateEdges[1], 'the two counters disagree — that IS the defect').toBe(1);
  });

  it('each trigger is a PULSE: high then low one pulse-width later', async () => {
    const h = await trailsDef.factory!(makeMockCtx(), makeNode());
    handle = h;
    sim.noteTouch(1, 60, 67);
    const ev = eventsOn(h, 'trig1').filter((e) => e.value !== undefined);
    expect(ev.map((e) => e.value)).toEqual([1, 0]);
    expect(ev[1]!.time - ev[0]!.time).toBeCloseTo(TRAILS_TRIGGER_PULSE_S, 9);
  });

  it('⚠ RULE 7: the contact gate is STILL a level — no notch was cut into it', async () => {
    // The trade-off, asserted. Adding a jack must not have converted `g1` from
    // a level into an edge: a VCA patched there must not click per step.
    const h = await trailsDef.factory!(makeMockCtx(), makeNode());
    handle = h;
    sim.noteTouch(1, 60, 67);
    sim.send([0x90, 60, 0]);
    sim.send([0x90, 62, 127]); // X steps while Y holds
    const gateValues = eventsOn(h, 'g1')
      .filter((e) => e.value !== undefined)
      .map((e) => e.value);
    expect(gateValues, 'one rise, and nothing cut into it').toEqual([1]);
    expect(lastValue(h, 'g1')).toBe(1);
    // …while the trigger jack carried both steps.
    expect((h.read!('state') as TrailsState).stepTriggers[0]).toBe(2);
  });

  it('two steps closer together than the pulse width still make TWO pulses', async () => {
    // `cancelScheduledValues` first, or the first pulse's pending fall would
    // land after the second rise and leave the jack stuck high.
    const h = await trailsDef.factory!(makeMockCtx(), makeNode());
    handle = h;
    for (let i = 0; i < 3; i++) {
      sim.send([0x90, 60, 127]);
      sim.send([0x90, 60, 0]);
    }
    expect((h.read!('state') as TrailsState).stepTriggers[0]).toBe(3);
    expect(eventsOn(h, 'trig1').filter((e) => e.value === 1)).toHaveLength(3);
  });

  it('CC mode pulses on CONTACT and on each loop restart — bounded, and honest', async () => {
    const h = await trailsDef.factory!(makeMockCtx(), makeNode());
    handle = h;
    sim.glide(1, 8);
    const afterContact = (h.read!('state') as TrailsState).stepTriggers[0];
    expect(afterContact, 'the stream starting is one articulation').toBe(1);
    // A long continuous stream adds nothing — CC mode has no steps on the wire.
    sim.glide(1, 40);
    expect((h.read!('state') as TrailsState).stepTriggers[0]).toBe(afterContact);
    // …and each loop restart articulates.
    sim.loopRestart();
    sim.loopRestart();
    expect((h.read!('state') as TrailsState).stepTriggers[0]).toBe(afterContact! + 2);
  });

  it('resetMonitor zeroes the step counter with the others', async () => {
    const h = await trailsDef.factory!(makeMockCtx(), makeNode());
    handle = h;
    sim.noteTouch(1, 60, 67);
    expect((h.read!('state') as TrailsState).stepTriggers[0]).toBeGreaterThan(0);
    (h.read!('card-api') as TrailsCardApi).resetMonitor();
    expect((h.read!('state') as TrailsState).stepTriggers).toEqual([0, 0, 0, 0]);
  });

  // ── The per-channel poly note buses ────────────────────────────────────
  //
  // Four ports, two lanes each: lane 0 = X, lane 1 = Y. Alive ONLY in note
  // mode, because they are written only from the decoder's `'note'` event and
  // CC mode never produces one.

  it('a note-mode strike puts V/OCT on lane 0 (X) and lane 1 (Y)', async () => {
    const h = await trailsDef.factory!(makeMockCtx(), makeNode());
    handle = h;
    sim.noteTouch(1, 60, 72); // C4 and C5
    const port = trailsPolyPortId(1);
    // ⚠ V/OCT, NOT the normalised 0..1 the x/y jacks carry. 0 V = C4 = MIDI 60,
    // so C4 is exactly 0 and the octave above it is exactly 1.
    expect(polyLaneValue(h, port, TRAILS_POLY_LANE.x, 'pitch')).toBeCloseTo(midiToVOct(60), 9);
    expect(polyLaneValue(h, port, TRAILS_POLY_LANE.x, 'pitch')).toBe(0);
    expect(polyLaneValue(h, port, TRAILS_POLY_LANE.y, 'pitch')).toBe(1);
    // …and both lanes are gated.
    expect(polyLaneValue(h, port, TRAILS_POLY_LANE.x, 'gate')).toBe(1);
    expect(polyLaneValue(h, port, TRAILS_POLY_LANE.y, 'gate')).toBe(1);
  });

  it('an octave up is exactly +1 — the bus really is volts per octave', async () => {
    const h = await trailsDef.factory!(makeMockCtx(), makeNode());
    handle = h;
    const port = trailsPolyPortId(1);
    sim.noteTouch(1, 48, 48);
    const low = polyLaneValue(h, port, TRAILS_POLY_LANE.x, 'pitch')!;
    sim.noteTouch(1, 60, 60);
    const mid = polyLaneValue(h, port, TRAILS_POLY_LANE.x, 'pitch')!;
    sim.noteTouch(1, 72, 72);
    const high = polyLaneValue(h, port, TRAILS_POLY_LANE.x, 'pitch')!;
    expect(mid - low).toBeCloseTo(1, 9);
    expect(high - mid).toBeCloseTo(1, 9);
  });

  it('the lane GATE is a LEVEL — it holds, and falls only on release', async () => {
    // AGENTS.md rule 7: gate consumers stay level-sensitive. `scheduleStep`'s
    // `gateOffSec` would impose a note length the device never sent.
    const h = await trailsDef.factory!(makeMockCtx(), makeNode());
    handle = h;
    const port = trailsPolyPortId(2);
    sim.noteTouch(2, 64, 67);
    expect(polyLaneValue(h, port, TRAILS_POLY_LANE.x, 'gate')).toBe(1);
    // No scheduled gate-down anywhere in the lane's timeline.
    const gateEvents = polyLaneEvents(h, port, TRAILS_POLY_LANE.x, 'gate');
    expect(gateEvents.filter((e) => e.value === 0), 'nothing closed it by itself').toHaveLength(0);
    sim.noteRelease(2, 64, 67);
    expect(polyLaneValue(h, port, TRAILS_POLY_LANE.x, 'gate')).toBe(0);
  });

  it('the two lanes gate INDEPENDENTLY — releasing X leaves Y sounding', async () => {
    // The poly mirror of the channel-gate fix, and the reason the `'note'`
    // event is per-AXIS while the `'gate'` event is the channel-level OR.
    const h = await trailsDef.factory!(makeMockCtx(), makeNode());
    handle = h;
    const port = trailsPolyPortId(2);
    sim.noteTouch(2, 71, 71);
    sim.send([0x92, 71, 0]); // release X only
    expect(polyLaneValue(h, port, TRAILS_POLY_LANE.x, 'gate')).toBe(0);
    expect(polyLaneValue(h, port, TRAILS_POLY_LANE.y, 'gate'), 'Y is still held').toBe(1);
    // …while the CHANNEL gate jack, which is the OR, stays high.
    expect(lastValue(h, 'g2')).toBe(1);
  });

  it('a release HOLDS the lane pitch — last-note priority, as on the CV axis', async () => {
    const h = await trailsDef.factory!(makeMockCtx(), makeNode());
    handle = h;
    const port = trailsPolyPortId(1);
    sim.noteTouch(1, 84, 84);
    const held = polyLaneValue(h, port, TRAILS_POLY_LANE.x, 'pitch');
    sim.noteRelease(1, 84, 84);
    expect(polyLaneValue(h, port, TRAILS_POLY_LANE.x, 'pitch')).toBe(held);
  });

  it('each channel drives its OWN bus — no cross-talk between the four', async () => {
    const h = await trailsDef.factory!(makeMockCtx(), makeNode());
    handle = h;
    sim.noteTouch(3, 60, 62);
    expect(polyLaneValue(h, trailsPolyPortId(3), TRAILS_POLY_LANE.x, 'gate')).toBe(1);
    for (const other of [1, 2, 4] as const) {
      expect(
        polyLaneEvents(h, trailsPolyPortId(other), TRAILS_POLY_LANE.x, 'gate'),
        `channel ${other} must be untouched`,
      ).toHaveLength(0);
    }
  });

  it('X and Y land on lanes 0 and 1 — inside every shipped consumer\'s window', async () => {
    // ⚠ THE REASON THERE ARE FOUR PORTS. The bus is 16 lanes wide, but no
    // shipped consumer reads past lane 4 (CUBE's POLY_VOICES and the shared
    // poly-osc-sum are both 5). A single global port would put channels 3 and 4
    // on lanes 4..7 and every instrument in the rack would silently drop them.
    expect(TRAILS_POLY_LANE).toEqual({ x: 0, y: 1 });
    expect(Math.max(TRAILS_POLY_LANE.x, TRAILS_POLY_LANE.y)).toBeLessThan(5);
    expect(POLY_CHANNEL_PAIRS).toBeGreaterThan(TRAILS_POLY_LANE.y);

    const h = await trailsDef.factory!(makeMockCtx(), makeNode());
    handle = h;
    sim.noteTouch(4, 60, 62);
    // Nothing was written above lane 1 on any port.
    for (const ch of TRAILS_CHANNELS) {
      for (let lane = 2; lane < POLY_CHANNEL_PAIRS; lane++) {
        expect(
          polyLaneEvents(h, trailsPolyPortId(ch), lane, 'gate'),
          `ch${ch} lane ${lane} must stay at rest`,
        ).toHaveLength(0);
      }
    }
  });

  it('⚠ CC MODE LEAVES THE POLY BUSES SILENT — the mode dependence, asserted', async () => {
    // The buses exist only where notes do. A CC gesture must not put anything
    // on them, or a player in the ordinary mode would find a patched poly cable
    // emitting a pitch of 0 V with a gate that never rises — worse than absent.
    const h = await trailsDef.factory!(makeMockCtx(), makeNode());
    handle = h;
    // ⚠ NO `gateOn()` HERE. That helper sends a NOTE — it is the legacy
    // contact-gate double from before note mode existed — so using it in a
    // "CC mode" test would drive the very path this asserts is quiet.
    sim.glide(1, 12);
    sim.clock(24);
    sim.loopRestart();
    // The CC path is alive…
    expect(eventsOn(h, 'x1').length).toBeGreaterThan(0);
    // …and every poly lane on every channel is untouched.
    for (const ch of TRAILS_CHANNELS) {
      for (const kind of ['pitch', 'gate'] as const) {
        for (const lane of [TRAILS_POLY_LANE.x, TRAILS_POLY_LANE.y]) {
          expect(
            polyLaneEvents(h, trailsPolyPortId(ch), lane, kind),
            `ch${ch} lane ${lane} ${kind}`,
          ).toHaveLength(0);
        }
      }
    }
  });

  it('NEGATIVE CONTROL: an unused channel stays at rest through a note run', async () => {
    const h = await trailsDef.factory!(makeMockCtx(), makeNode());
    handle = h;
    for (const note of [40, 60, 80]) sim.noteTouch(3, note, note);
    for (const port of ['x1', 'y1', 'x2', 'y2', 'x4', 'y4', 'g1', 'g2', 'g4']) {
      expect(eventsOn(h, port), `port ${port}`).toHaveLength(0);
    }
    expect(eventsOn(h, 'x3').length).toBeGreaterThan(0);
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
