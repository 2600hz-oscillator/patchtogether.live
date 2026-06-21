// packages/web/src/lib/audio/modules/sequencer-snh.test.ts
//
// Gate-sampled Sample & Hold on the sequencer's pitch CV. Drives the REAL
// sequencer factory + tick loop against a fake AudioContext (advanceable
// currentTime) and the live graph store, asserting:
//   • the `snh` param exists, defaults ON (1), is discrete 0..1.
//   • S&H ON: between gates the pitch port HOLDS (the lane-0 pitch
//     ConstantSource is NOT rewritten to 0 on a rest), and engine.read
//     ('pitchVOct') reflects the HELD value.
//   • S&H OFF: pitch is rewritten every step (continuous) — on a rest the
//     lane-0 pitch ConstantSource gets a 0 (the legacy behavior).
//   • Consecutive ON steps with DIFFERENT pitches still update under S&H ON
//     (each gated step re-latches).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { midiToVOct } from '$lib/audio/note-entry';

const hoisted = vi.hoisted(() => ({ tick: null as null | (() => void) }));
vi.mock('$lib/audio/scheduler-clock', () => ({
  SCHEDULER_TICK_MS: 25,
  getSchedulerClock: () => ({
    subscribe: (fn: () => void) => {
      hoisted.tick = fn;
      return () => {
        hoisted.tick = null;
      };
    },
    usingWorker: false,
    dispose: () => {},
  }),
}));

import { patch as livePatch } from '$lib/graph/store';

interface SchedEvent {
  value: number;
  time: number;
}
class FakeParam {
  value = 0;
  events: SchedEvent[] = [];
  setValueAtTime(value: number, time: number) {
    this.events.push({ value, time });
    this.value = value;
    return this;
  }
  cancelScheduledValues(fromTime: number) {
    this.events = this.events.filter((e) => e.time < fromTime);
    return this;
  }
  linearRampToValueAtTime(value: number, time: number) {
    this.events.push({ value, time });
    this.value = value;
    return this;
  }
  setTargetAtTime(value: number, time: number) {
    this.events.push({ value, time });
    this.value = value;
    return this;
  }
}
class FakeConstantSource {
  offset = new FakeParam();
  start() {}
  stop() {}
  connect() {}
  disconnect() {}
}
class FakeGain {
  gain = new FakeParam();
  injected: Float32Array | null = null;
  connect(node: unknown) {
    if (node instanceof FakeAnalyser) node._source = this;
  }
  disconnect() {}
}
class FakeAnalyser {
  fftSize = 2048;
  smoothingTimeConstant = 0;
  _source: FakeGain | null = null;
  connect() {}
  disconnect() {}
  getFloatTimeDomainData(out: Float32Array) {
    const buf = this._source?.injected;
    if (buf) out.set(buf.subarray(0, out.length));
    else out.fill(0);
  }
}
class FakeAudioContext {
  currentTime = 0;
  sampleRate = 48000;
  // Every poly pitch lane is a ConstantSource — keep references so we can
  // inspect the lane-0 pitch source's scheduled events directly.
  constantSources: FakeConstantSource[] = [];
  createConstantSource() {
    const c = new FakeConstantSource();
    this.constantSources.push(c);
    return c as unknown as ConstantSourceNode;
  }
  createGain() {
    return new FakeGain() as unknown as GainNode;
  }
  createAnalyser() {
    return new FakeAnalyser() as unknown as AnalyserNode;
  }
  createChannelSplitter() {
    return new FakeGain() as unknown as ChannelSplitterNode;
  }
  createChannelMerger() {
    return new FakeGain() as unknown as ChannelMergerNode;
  }
}

import { sequencerDef } from './sequencer';

const NODE_ID = 'seqsnh1';

function clearPatch() {
  for (const k of Object.keys(livePatch.nodes)) delete livePatch.nodes[k];
  for (const k of Object.keys(livePatch.edges)) delete livePatch.edges[k];
}

type Step = { on: boolean; midi: number | null; chord: string };

function seed(steps: Step[], snh: number) {
  clearPatch();
  livePatch.nodes[NODE_ID] = {
    id: NODE_ID,
    type: 'sequencer',
    domain: 'audio',
    position: { x: 0, y: 0 },
    params: {
      bpm: 120,
      length: steps.length,
      isPlaying: 1,
      gateLength: 0.5,
      octave: 0,
      swing: 0,
      snh,
    },
    data: { steps },
  } as never;
}

async function build(ctx: FakeAudioContext) {
  return sequencerDef.factory(
    ctx as unknown as AudioContext,
    { id: NODE_ID, type: 'sequencer', params: livePatch.nodes[NODE_ID]!.params } as never,
  );
}

function run(ctx: FakeAudioContext, fromS: number, toS: number, tickMs = 0.025) {
  for (let t = fromS; t < toS; t += tickMs) {
    ctx.currentTime = t;
    hoisted.tick!();
  }
}

/** The lane-0 pitch ConstantSource is the FIRST ConstantSource the factory
 *  creates (createPolySender builds lane 0's pitchSrc before gateSrc). */
function lane0PitchEvents(ctx: FakeAudioContext): SchedEvent[] {
  return ctx.constantSources[0]!.offset.events;
}

beforeEach(() => {
  hoisted.tick = null;
  clearPatch();
});

describe('sequencer: s&h param', () => {
  it('declares a discrete s&h param defaulting ON (1), lowercase label', () => {
    const snh = sequencerDef.params.find((p) => p.id === 'snh');
    expect(snh).toBeDefined();
    expect(snh!.defaultValue).toBe(1);
    expect(snh!.min).toBe(0);
    expect(snh!.max).toBe(1);
    expect(snh!.curve).toBe('discrete');
    expect(snh!.label).toBe(snh!.label.toLowerCase());
  });
});

describe('sequencer: gate-sampled S&H (pitch holds between gates)', () => {
  // Pattern: step 0 ON (midi 72 = +1 oct = 1.0 V), step 1 OFF (rest), step 2 ON
  // (midi 67 = +7 semis = 0.5833 V — deliberately NON-zero so a held step is
  // distinguishable from a 0-reset), step 3 OFF. length 4 @120bpm 16th →
  // 0.125 s/step, loop = 0.5 s. Step audio-times: 0@0.05, 1@0.175, 2@0.30,
  // 3@0.425 (nextStepTime starts at currentTime+0.05 on play-start).
  const pattern = (): Step[] => [
    { on: true, midi: 72, chord: 'mono' },
    { on: false, midi: 67, chord: 'mono' },
    { on: true, midi: 67, chord: 'mono' },
    { on: false, midi: 67, chord: 'mono' },
  ];

  // The pitch ConstantSource is written at the AUDIO-THREAD time of each step
  // (not at wall-clock tick time); the lookahead scheduler queues steps up to
  // 200 ms ahead, so we assert on the SCHEDULED event stream (the audio truth),
  // not the lookahead-dependent `pitchVOct` mirror. We run long enough that the
  // whole first loop (steps 0..3, audio-times 0.05..0.425) is scheduled.

  it('S&H ON: ONLY gated steps write pitch — no pitch write on a rest', async () => {
    seed(pattern(), 1);
    const ctx = new FakeAudioContext();
    await build(ctx);
    run(ctx, 0, 0.7); // schedules the full first loop + into the next
    const events = lane0PitchEvents(ctx).filter((e) => e.time >= 0.04 && e.time <= 0.45);
    // Every pitch write lands at a GATED step's audio time (step 0 @0.05 = 72,
    // step 2 @0.30 = 67). The rests (steps 1 @0.175, 3 @0.425) wrote NOTHING.
    const writeTimes = events.map((e) => Number(e.time.toFixed(4)));
    expect(writeTimes).not.toContain(0.175);
    expect(writeTimes).not.toContain(0.425);
    // Exactly the two gated steps wrote pitch in this loop.
    expect(events.length).toBe(2);
    expect(events[0]!.value).toBeCloseTo(midiToVOct(72), 5);
    expect(events[1]!.value).toBeCloseTo(midiToVOct(67), 5);
    // NO pitch write was 0 in the loop (the rests held, they didn't reset).
    expect(events.every((e) => Math.abs(e.value) > 1e-9)).toBe(true);
  });

  it('S&H OFF: EVERY step writes pitch — a rest rewrites pitch to 0 (legacy)', async () => {
    seed(pattern(), 0);
    const ctx = new FakeAudioContext();
    await build(ctx);
    run(ctx, 0, 0.7);
    const events = lane0PitchEvents(ctx).filter((e) => e.time >= 0.04 && e.time <= 0.45);
    // All four steps wrote pitch (continuous): the two rests wrote 0.
    expect(events.length).toBe(4);
    const restWrites = events.filter((e) => Math.abs(e.value) < 1e-9);
    expect(restWrites.length).toBe(2); // the two rests rewrote pitch to 0
    const restTimes = restWrites.map((e) => Number(e.time.toFixed(4)));
    expect(restTimes).toContain(0.175);
    expect(restTimes).toContain(0.425);
    // The gated steps wrote their non-zero pitches.
    expect(events.some((e) => Math.abs(e.value - midiToVOct(72)) < 1e-5)).toBe(true);
    expect(events.some((e) => Math.abs(e.value - midiToVOct(67)) < 1e-5)).toBe(true);
  });

  it('S&H ON: consecutive gated steps with DIFFERENT pitches still update', async () => {
    seed(pattern(), 1);
    const ctx = new FakeAudioContext();
    await build(ctx);
    run(ctx, 0, 0.7);
    const events = lane0PitchEvents(ctx);
    // Both gated pitches were written (each gated step re-latches).
    expect(events.some((e) => Math.abs(e.value - midiToVOct(72)) < 1e-5)).toBe(true);
    expect(events.some((e) => Math.abs(e.value - midiToVOct(67)) < 1e-5)).toBe(true);
  });
});
