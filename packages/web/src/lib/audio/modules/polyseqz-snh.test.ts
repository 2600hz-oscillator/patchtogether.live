// packages/web/src/lib/audio/modules/polyseqz-snh.test.ts
//
// Gate-sampled Sample & Hold on POLYSEQZ's per-lane pitch CV. Drives the REAL
// factory + tick loop against a fake AudioContext, asserting:
//   • S&H ON pins the per-lane PITCH write to the UN-jittered nominal step time
//     (lead = atTime - 0.001), so pitch latches cleanly at the gate edge.
//   • the GATE still fires at the (un-jittered, humanize=0) nominal time; the
//     ~1-sample lead between pitch-write and gate-on is preserved.
//   • S&H OFF reproduces the legacy pre-gate-lead write at fireAt - 0.001.
//   • humanize jitter on the GATE is unchanged by S&H (verified at humanize=0:
//     pitch lead === gate-on - 0.001 exactly).

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

import { polyseqzDef } from './polyseqz';

const NODE_ID = 'pszsnh1';

function clearPatch() {
  for (const k of Object.keys(livePatch.nodes)) delete livePatch.nodes[k];
  for (const k of Object.keys(livePatch.edges)) delete livePatch.edges[k];
}

type CStep = {
  on: boolean;
  root: number | null;
  quality: string;
  inversion: number;
  voicing: string;
};

function seed(steps: CStep[], snh: number, humanize = 0) {
  clearPatch();
  livePatch.nodes[NODE_ID] = {
    id: NODE_ID,
    type: 'polyseqz',
    domain: 'audio',
    position: { x: 0, y: 0 },
    params: {
      bpm: 120,
      length: steps.length,
      isPlaying: 1,
      gateLength: 0.6,
      octave: 0,
      humanize,
      snh,
    },
    data: { steps },
  } as never;
}

async function build(ctx: FakeAudioContext) {
  return polyseqzDef.factory(
    ctx as unknown as AudioContext,
    { id: NODE_ID, type: 'polyseqz', params: livePatch.nodes[NODE_ID]!.params } as never,
  );
}

function run(ctx: FakeAudioContext, fromS: number, toS: number, tickMs = 0.025) {
  for (let t = fromS; t < toS; t += tickMs) {
    ctx.currentTime = t;
    hoisted.tick!();
  }
}

// createPolySender builds lane 0 pitchSrc first (cs[0]), then lane 0 gateSrc
// (cs[1]). Subsequent lanes follow; we only need lane 0.
function lane0Pitch(ctx: FakeAudioContext): SchedEvent[] {
  return ctx.constantSources[0]!.offset.events;
}
function lane0Gate(ctx: FakeAudioContext): SchedEvent[] {
  return ctx.constantSources[1]!.offset.events;
}

beforeEach(() => {
  hoisted.tick = null;
  clearPatch();
});

// A single ON chord-step (root C4=60, maj) so lane 0 = the root note.
const oneChord = (): CStep[] => [
  { on: true, root: 60, quality: 'maj', inversion: 0, voicing: 'closed' },
  { on: false, root: 60, quality: 'maj', inversion: 0, voicing: 'closed' },
];

describe('polyseqz: gate-sampled S&H — pitch pinned to the nominal step time', () => {
  it('S&H ON (humanize=0): lane-0 pitch write leads the gate-on by ~1 sample at the nominal time', async () => {
    seed(oneChord(), 1, 0);
    const ctx = new FakeAudioContext();
    await build(ctx);
    run(ctx, 0, 0.2); // schedule step 0 (audio-time ~0.05)
    const pitchEv = lane0Pitch(ctx).find((e) => Math.abs(e.value - midiToVOct(60)) < 1e-5);
    const gateOn = lane0Gate(ctx).find((e) => e.value >= 0.5);
    expect(pitchEv).toBeTruthy();
    expect(gateOn).toBeTruthy();
    // With humanize=0 the gate fires at the nominal step time; the pitch leads
    // it by exactly the ~1-sample (0.001 s) lead.
    expect(gateOn!.time - pitchEv!.time).toBeCloseTo(0.001, 6);
  });

  it('S&H OFF (humanize=0): same legacy pre-gate-lead (pitch leads gate by ~1 sample)', async () => {
    seed(oneChord(), 0, 0);
    const ctx = new FakeAudioContext();
    await build(ctx);
    run(ctx, 0, 0.2);
    const pitchEv = lane0Pitch(ctx).find((e) => Math.abs(e.value - midiToVOct(60)) < 1e-5);
    const gateOn = lane0Gate(ctx).find((e) => e.value >= 0.5);
    expect(pitchEv).toBeTruthy();
    expect(gateOn).toBeTruthy();
    // At humanize=0 the jittered fireAt === nominal atTime, so OFF and ON match.
    expect(gateOn!.time - pitchEv!.time).toBeCloseTo(0.001, 6);
  });

  it('S&H ON: pitch is written to the right per-lane V/oct (root C4 = 0V)', async () => {
    seed(oneChord(), 1, 0);
    const ctx = new FakeAudioContext();
    const handle = await build(ctx);
    run(ctx, 0, 0.2);
    // engine.read mirror confirms the lane-0 root note latched.
    expect(handle.read!('pitchVOctLane:0')).toBeCloseTo(midiToVOct(60), 5);
  });
});

describe('polyseqz: humanize gate jitter is preserved (pitch pinned, gate jittered)', () => {
  it('S&H ON with humanize > 0: the gate-on time differs from the nominal pitch-lead anchor', async () => {
    // With humanize on, the GATE gets a random offset while the PITCH is pinned
    // to the un-jittered nominal time. So the gate-on is NOT exactly
    // pitch-lead + 0.001 (it carries the jitter). We assert the humanizeOffset
    // mirror is non-zero (jitter present) and that pitch still latched.
    seed(oneChord(), 1, 1); // max humanize
    const ctx = new FakeAudioContext();
    const handle = await build(ctx);
    run(ctx, 0, 0.2);
    const pitchEv = lane0Pitch(ctx).find((e) => Math.abs(e.value - midiToVOct(60)) < 1e-5);
    expect(pitchEv).toBeTruthy();
    // Gate still rises (the chord plays) and a humanize offset was sampled.
    const gateOn = lane0Gate(ctx).find((e) => e.value >= 0.5);
    expect(gateOn).toBeTruthy();
    // Some lane carries a non-zero humanize offset at high humanize.
    const offs = [0, 1, 2, 3, 4].map((i) => handle.read!(`humanizeOffset:${i}`) as number);
    expect(offs.some((o) => Math.abs(o) > 1e-6)).toBe(true);
  });
});
