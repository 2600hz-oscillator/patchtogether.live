// packages/web/src/lib/audio/modules/clipplayer.test.ts
//
// Drives the REAL clipplayer (v2, 8-lane) factory + tick loop against a fake
// AudioContext (advanceable currentTime) and the live graph store, asserting
// per-lane launch / quantized switch / stop / TIMELORDE-lock / silent-when-empty
// behavior. The audible end-to-end chain (TIMELORDE → clipplayer → voice → RMS)
// is covered by the e2e spec.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { midiToVOct } from '$lib/audio/note-entry';

// Capture the scheduler-clock tick so we can drive it manually.
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

// ---- Minimal fake AudioContext (same shape as sequencer-reset-dedup.test) ----
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
  createConstantSource() {
    return new FakeConstantSource() as unknown as ConstantSourceNode;
  }
  createGain() {
    return new FakeGain() as unknown as GainNode;
  }
  createAnalyser() {
    return new FakeAnalyser() as unknown as AnalyserNode;
  }
  createChannelMerger() {
    return new FakeGain() as unknown as ChannelMergerNode;
  }
}

function pulseBuffer(len = 2048): Float32Array {
  const b = new Float32Array(len);
  for (let i = len - 64; i < len; i++) b[i] = 1;
  return b;
}

import { clipplayerDef } from './clipplayer';
import { clipIndex, type NoteClipRecord } from './clip-types';
import { pushAudition, clearAudition } from './clip-audition';

const NODE_ID = 'cp1';

function clearPatch() {
  for (const k of Object.keys(livePatch.nodes)) delete livePatch.nodes[k];
  for (const k of Object.keys(livePatch.edges)) delete livePatch.edges[k];
}
function noteClip(midi: number, lengthSteps = 4): NoteClipRecord {
  return {
    kind: 'note',
    steps: [{ step: 0, midi, velocity: 127, lengthSteps: 1 }],
    lengthSteps,
    root: 48,
    loop: true,
  };
}
/** Per-lane state array of length 8 with `val` at `lane`. */
function lane8<T>(lane: number, val: T, fill: T): T[] {
  const a = new Array<T>(8).fill(fill);
  a[lane] = val;
  return a;
}
function seed(params: Record<string, number>, data: Record<string, unknown>) {
  clearPatch();
  livePatch.nodes[NODE_ID] = {
    id: NODE_ID,
    type: 'clipplayer',
    domain: 'audio',
    position: { x: 0, y: 0 },
    params,
    data,
  } as never;
}
function seedTimelorde(running: number, bpm = 120) {
  livePatch.nodes['tl'] = {
    id: 'tl', type: 'timelorde', domain: 'audio', position: { x: 0, y: 0 }, params: { running, bpm }, data: {},
  } as never;
}
function gateOf(handle: { outputs: Map<string, { node: unknown }> }, lane: number): FakeParam {
  return (handle.outputs.get(`gate${lane + 1}`)!.node as unknown as FakeConstantSource)
    .offset as unknown as FakeParam;
}
function hasHighEvent(param: FakeParam): boolean {
  return param.events.some((e) => e.value >= 0.5);
}
async function build(ctx: FakeAudioContext) {
  return clipplayerDef.factory(
    ctx as unknown as AudioContext,
    { id: NODE_ID, type: 'clipplayer', params: livePatch.nodes[NODE_ID]!.params } as never,
  );
}
function run(ctx: FakeAudioContext, fromS: number, toS: number, tickMs = 0.025) {
  for (let t = fromS; t < toS; t += tickMs) {
    ctx.currentTime = t;
    hoisted.tick!();
  }
}

beforeEach(() => {
  hoisted.tick = null;
  clearPatch();
});

describe('clipplayer: module def', () => {
  it('registers as audio-domain "clipplayer" with a lowercase label', () => {
    expect(clipplayerDef.type).toBe('clipplayer');
    expect(clipplayerDef.domain).toBe('audio');
    expect(clipplayerDef.label).toBe('clip player');
    expect(clipplayerDef.label).toBe(clipplayerDef.label.toLowerCase());
    expect(clipplayerDef.category).toBe('modulation');
  });
  it('declares stop_all in + 8 lanes × (pitch/gate/vel) out', () => {
    expect(clipplayerDef.inputs.map((p) => p.id)).toEqual(['stop_all']);
    const outs = Object.fromEntries(clipplayerDef.outputs.map((p) => [p.id, p.type]));
    expect(clipplayerDef.outputs).toHaveLength(24);
    expect(outs.pitch1).toBe('polyPitchGate');
    expect(outs.gate1).toBe('gate');
    expect(outs.vel1).toBe('cv');
    expect(outs.pitch8).toBe('polyPitchGate');
    expect(outs.gate8).toBe('gate');
    expect(outs.vel8).toBe('cv');
  });
  it('has no BPM/clock — STEP param drives steps-per-beat', () => {
    const ids = clipplayerDef.params.map((p) => p.id);
    expect(ids).toContain('stepDiv');
    expect(ids).not.toContain('bpm');
    expect(clipplayerDef.inputs.map((p) => p.id)).not.toContain('clock');
  });
  it('declares a discrete s&h param defaulting ON (1), lowercase label', () => {
    const snh = clipplayerDef.params.find((p) => p.id === 'snh');
    expect(snh).toBeDefined();
    expect(snh!.defaultValue).toBe(1);
    expect(snh!.min).toBe(0);
    expect(snh!.max).toBe(1);
    expect(snh!.curve).toBe('discrete');
    expect(snh!.label).toBe(snh!.label.toLowerCase());
  });
});

describe('clipplayer: gate-sampled S&H (pitch holds between gates)', () => {
  // A sparse clip: a note at step 0 (midi 72) only, then rests. gateLength low
  // so the gate closes well before step 1. Under S&H the lane's pitch must HOLD
  // the held value through the empty step (not reset to C4/0).
  function sparseClip(midi: number): NoteClipRecord {
    return {
      kind: 'note',
      steps: [{ step: 0, midi, velocity: 100, lengthSteps: 1 }],
      lengthSteps: 4, // step 0 note, steps 1..3 are rests
      root: 48,
      loop: true,
    };
  }

  it('S&H ON: the lane pitch HOLDS through an empty step (not rewritten to 0)', async () => {
    seed(
      { stepDiv: 2, quantize: 0, octave: 0, gateLength: 0.2, snh: 1 },
      { clips: { [clipIndex(0, 0)]: sparseClip(72) }, queued: lane8(0, 0, null) },
    );
    seedTimelorde(1); // running
    const ctx = new FakeAudioContext();
    const handle = await build(ctx);
    // stepDiv 2 @120bpm → 0.25 s/step. Advance through step 0 (note) into step 1
    // (rest) and step 2 (rest) so the held value is observed across rests.
    run(ctx, 0, 0.7);
    expect(handle.read!('activeLane:0')).toBe(0);
    // Pitch HELD at the step-0 note across the rests (S&H ON).
    expect(handle.read!('pitchVOct:0')).toBeCloseTo(midiToVOct(72), 5);
    // The gate went low on the rest (no held-gate).
    expect(handle.read!('gateValue:0')).toBe(0);
  });

  it('S&H OFF: the lane pitch is rewritten to 0 (C4) on an empty step', async () => {
    seed(
      { stepDiv: 2, quantize: 0, octave: 0, gateLength: 0.2, snh: 0 },
      { clips: { [clipIndex(0, 0)]: sparseClip(72) }, queued: lane8(0, 0, null) },
    );
    seedTimelorde(1);
    const ctx = new FakeAudioContext();
    const handle = await build(ctx);
    run(ctx, 0, 0.7);
    expect(handle.read!('activeLane:0')).toBe(0);
    // With S&H OFF a rest rewrites pitch to 0 (the legacy continuous drift).
    expect(handle.read!('pitchVOct:0')).toBeCloseTo(0, 5);
    expect(handle.read!('gateValue:0')).toBe(0);
  });

  it('a NEW clip\'s leading rest does NOT hold the prior clip\'s pitch through a gated step', async () => {
    // Clip A (slot 0): note at step 0 = midi 72. Clip B (slot 1): note at step 1
    // (a LEADING rest at step 0) = midi 48. After launching A then switching to
    // B, B's first GATED step must re-latch to 48 (not hold A's 72).
    const clipB: NoteClipRecord = {
      kind: 'note',
      steps: [{ step: 1, midi: 48, velocity: 100, lengthSteps: 1 }],
      lengthSteps: 4,
      root: 48,
      loop: true,
    };
    seed(
      { stepDiv: 2, quantize: 0, octave: 0, gateLength: 0.2, snh: 1 },
      {
        clips: { [clipIndex(0, 0)]: sparseClip(72), [clipIndex(1, 0)]: clipB },
        queued: lane8(0, 0, null),
      },
    );
    seedTimelorde(1);
    const ctx = new FakeAudioContext();
    const handle = await build(ctx);
    run(ctx, 0, 0.3); // launch A, sound step 0
    expect(handle.read!('pitchVOct:0')).toBeCloseTo(midiToVOct(72), 5);
    // Switch to clip B (immediate, quantize off). Its step 0 is a rest, step 1
    // is the gated note 48.
    (livePatch.nodes[NODE_ID]!.data as Record<string, unknown>).queued = lane8(0, 1, null);
    run(ctx, 0.3, 1.0); // through B's leading rest into its gated step 1
    expect(handle.read!('pitchVOct:0')).toBeCloseTo(midiToVOct(48), 5);
  });
});

describe('clipplayer: per-lane launch', () => {
  it('launches a queued clip immediately (quantize off) on its OWN lane', async () => {
    // clip 0 = lane0/slot0; clip 9 = lane1/slot1.
    seed(
      { stepDiv: 2, quantize: 0, octave: 0, gateLength: 0.9 },
      {
        clips: { [clipIndex(0, 0)]: noteClip(72), [clipIndex(1, 1)]: noteClip(60) },
        queued: [0, 1, null, null, null, null, null, null],
      },
    );
    const ctx = new FakeAudioContext();
    const handle = await build(ctx);
    run(ctx, 0, 0.1);
    expect(handle.read!('activeLane:0')).toBe(0);
    expect(handle.read!('activeLane:1')).toBe(1);
    expect(handle.read!('pitchVOct:0')).toBeCloseTo(midiToVOct(72), 5);
    expect(handle.read!('pitchVOct:1')).toBeCloseTo(midiToVOct(60), 5);
    expect(hasHighEvent(gateOf(handle, 0))).toBe(true);
    expect(hasHighEvent(gateOf(handle, 1))).toBe(true);
    // an un-launched lane stays silent
    expect(handle.read!('activeLane:2')).toBe(-1);
    expect(hasHighEvent(gateOf(handle, 2))).toBe(false);
  });

  it('applies the octave param to the emitted pitch', async () => {
    seed(
      { stepDiv: 2, quantize: 0, octave: 1, gateLength: 0.9 },
      { clips: { [clipIndex(0, 0)]: noteClip(60) }, queued: lane8(0, 0, null) },
    );
    const ctx = new FakeAudioContext();
    const handle = await build(ctx);
    run(ctx, 0, 0.1);
    expect(handle.read!('pitchVOct:0')).toBeCloseTo(midiToVOct(60) + 1, 5);
  });
});

describe('clipplayer: quantized switch (per lane, at the loop boundary)', () => {
  it('a queued clip takes over only at the active lane loop boundary', async () => {
    // both clips on lane 0: slot0 (clip 0) + slot1 (clip 1).
    seed(
      { stepDiv: 2, quantize: 1, octave: 0, gateLength: 0.9 },
      { clips: { [clipIndex(0, 0)]: noteClip(72), [clipIndex(1, 0)]: noteClip(48) } },
    );
    const ctx = new FakeAudioContext();
    const handle = await build(ctx);

    (livePatch.nodes[NODE_ID]!.data as Record<string, unknown>).queued = lane8(0, 0, null);
    run(ctx, 0, 0.1);
    expect(handle.read!('activeLane:0')).toBe(0); // started immediately (was idle)

    (livePatch.nodes[NODE_ID]!.data as Record<string, unknown>).queued = lane8(0, 1, null);
    run(ctx, 0.1, 0.16);
    expect(handle.read!('activeLane:0')).toBe(0); // still clip 0 before the boundary
    run(ctx, 0.16, 0.8);
    expect(handle.read!('activeLane:0')).toBe(1); // switched at the loop boundary
    expect(handle.read!('pitchVOct:0')).toBeCloseTo(midiToVOct(48), 5);
  });
});

describe('clipplayer: stop', () => {
  it('stop_all rising edge stops every lane', async () => {
    seed(
      { stepDiv: 2, quantize: 0, octave: 0, gateLength: 0.9 },
      {
        clips: { [clipIndex(0, 0)]: noteClip(72), [clipIndex(0, 1)]: noteClip(60) },
        queued: [0, 0, null, null, null, null, null, null],
      },
    );
    const ctx = new FakeAudioContext();
    const handle = await build(ctx);
    run(ctx, 0, 0.1);
    expect(handle.read!('activeLane:0')).toBe(0);
    expect(handle.read!('activeLane:1')).toBe(0);

    const stopGain = handle.inputs.get('stop_all')!.node as unknown as FakeGain;
    stopGain.injected = pulseBuffer();
    run(ctx, 0.1, 0.15);
    expect(handle.read!('activeLane:0')).toBe(-1);
    expect(handle.read!('activeLane:1')).toBe(-1);
  });
});

describe('clipplayer: TIMELORDE lock', () => {
  it('freezes (no gate) while TIMELORDE is stopped; runs when started', async () => {
    seed(
      { stepDiv: 2, quantize: 0, octave: 0, gateLength: 0.9 },
      { clips: { [clipIndex(0, 0)]: noteClip(72) }, queued: lane8(0, 0, null) },
    );
    seedTimelorde(0);
    const ctx = new FakeAudioContext();
    const handle = await build(ctx);
    run(ctx, 0, 0.1);
    expect(handle.read!('transportRunning')).toBe(0);
    expect(hasHighEvent(gateOf(handle, 0))).toBe(false); // frozen

    (livePatch.nodes['tl']!.params as Record<string, number>).running = 1;
    run(ctx, 0.1, 0.25);
    expect(handle.read!('transportRunning')).toBe(1);
    expect(hasHighEvent(gateOf(handle, 0))).toBe(true); // now sounding
  });

  it('reports externallyClocked when TIMELORDE.start_in is patched', async () => {
    seed({ stepDiv: 2, quantize: 0, octave: 0, gateLength: 0.9 }, { clips: {} });
    seedTimelorde(1);
    livePatch.edges['e1'] = {
      source: { nodeId: 'mc', portId: 'midistart' },
      target: { nodeId: 'tl', portId: 'start_in' },
    } as never;
    const ctx = new FakeAudioContext();
    const handle = await build(ctx);
    run(ctx, 0, 0.05);
    expect(handle.read!('externallyClocked')).toBe(1);
  });
});

describe('clipplayer: silent when empty', () => {
  it('emits no gate when no clip is launched', async () => {
    seed({ stepDiv: 2, quantize: 1, octave: 0, gateLength: 0.9 }, {});
    const ctx = new FakeAudioContext();
    const handle = await build(ctx);
    run(ctx, 0, 0.3);
    expect(handle.read!('activeLane:0')).toBe(-1);
    expect(hasHighEvent(gateOf(handle, 0))).toBe(false);
  });
});

describe('clipplayer: transport-start re-align (regression)', () => {
  // Two lanes playing POLYMETER clips (length 16 + 17). When both are mid-cycle
  // (stepIndex ≠ 0) and the transport edges 0→1, BOTH lanes snap to step 0 on the
  // downbeat — regardless of WHO flipped TIMELORDE.running (a direct param write
  // or the grid TRANSPORT pad, which write the same flag). Free-running polymeter
  // drift between starts is intended; the re-align is the contract under test.
  function seedTwoLanePolymeter() {
    // dense clips (a note on every step) so currentStep tracks the playhead.
    const denseClip = (len: number): NoteClipRecord => ({
      kind: 'note',
      lengthSteps: len,
      root: 48,
      loop: true,
      steps: Array.from({ length: len }, (_, s) => ({ step: s, midi: 60, velocity: 100, lengthSteps: 1 })),
    });
    seed(
      { stepDiv: 2, quantize: 0, octave: 0, gateLength: 0.9 },
      {
        clips: { [clipIndex(0, 0)]: denseClip(16), [clipIndex(1, 1)]: denseClip(17) },
        queued: [0, 1, null, null, null, null, null, null],
      },
    );
    seedTimelorde(1); // running so the lanes launch + advance
  }

  async function runUntilMidCycle(ctx: FakeAudioContext, handle: { read?: (k: string) => unknown }) {
    // advance well past step 0 on BOTH lanes (stepDiv 2 @ 120bpm → 0.25s/step).
    run(ctx, 0, 1.2);
    expect(handle.read!('activeLane:0')).toBe(0);
    expect(handle.read!('activeLane:1')).toBe(1);
    // both lanes are sounding a step ≠ 0 (mid-cycle).
    expect(handle.read!('currentStep:0')).not.toBe(0);
    expect(handle.read!('currentStep:1')).not.toBe(0);
  }

  it('re-aligns both lanes to step 0 — DIRECT params.running 0→1', async () => {
    seedTwoLanePolymeter();
    const ctx = new FakeAudioContext();
    const handle = await build(ctx);
    await runUntilMidCycle(ctx, handle);

    // stop, then restart via a DIRECT TIMELORDE.running write (1→0→1 edge).
    (livePatch.nodes['tl']!.params as Record<string, number>).running = 0;
    run(ctx, 1.2, 1.3);
    (livePatch.nodes['tl']!.params as Record<string, number>).running = 1;
    // one tick services the 0→1 edge → realign; the immediately-scheduled step 0
    // is observable as soon as its time passes.
    run(ctx, 1.3, 1.35);
    expect(handle.read!('currentStep:0')).toBe(0);
    expect(handle.read!('currentStep:1')).toBe(0);
  });

  it('re-aligns both lanes to step 0 — GRID toggleTransport path (same flag)', async () => {
    seedTwoLanePolymeter();
    const ctx = new FakeAudioContext();
    const handle = await build(ctx);
    await runUntilMidCycle(ctx, handle);

    // The grid TRANSPORT pad toggles TIMELORDE.running. Replicate that exact
    // write (read current → write the opposite) to prove the grid path lands on
    // the SAME params.running the engine re-aligns from.
    const gridToggleTransport = () => {
      const tl = livePatch.nodes['tl']!.params as Record<string, number>;
      tl.running = tl.running >= 0.5 ? 0 : 1;
    };
    gridToggleTransport(); // 1 → 0 (stop)
    run(ctx, 1.2, 1.3);
    gridToggleTransport(); // 0 → 1 (start) — the 0→1 edge
    run(ctx, 1.3, 1.35);
    expect(handle.read!('currentStep:0')).toBe(0);
    expect(handle.read!('currentStep:1')).toBe(0);
  });
});

describe('clipplayer: overdub vs replace record mode', () => {
  // A pre-seeded arrangement the arm-edge either KEEPS (overdub) or WIPES
  // (replace). Reads the SYNCED node.data.arrangement — the observable contract.
  const PRE_EVENTS = [
    { beat: 0, lane: 2, slot: 0 },
    { beat: 4, lane: 2, slot: 1 },
  ];
  function liveArrangeEvents(): { beat: number; lane: number; slot: number | 'stop' }[] {
    const a = (livePatch.nodes[NODE_ID]!.data as Record<string, unknown>).arrangement as
      | { events?: { beat: number; lane: number; slot: number | 'stop' }[] }
      | undefined;
    return a?.events ?? [];
  }

  it('REPLACE (default): arming RECORD clears the existing log', async () => {
    seed(
      { stepDiv: 2, quantize: 0, octave: 0, gateLength: 0.9 },
      {
        clips: { [clipIndex(0, 0)]: noteClip(72) },
        arrangement: { events: [...PRE_EVENTS], lengthBeats: 8, loop: true },
        recording: false,
        // recordMode absent ⇒ replace
      },
    );
    const ctx = new FakeAudioContext();
    await build(ctx);
    run(ctx, 0, 0.05);
    expect(liveArrangeEvents()).toHaveLength(2); // present before arm

    // Arm — the rising edge clears the log.
    (livePatch.nodes[NODE_ID]!.data as Record<string, unknown>).recording = true;
    run(ctx, 0.05, 0.1);
    expect(liveArrangeEvents()).toHaveLength(0); // wiped on arm
  });

  it('OVERDUB: arming RECORD KEEPS the existing log', async () => {
    seed(
      { stepDiv: 2, quantize: 0, octave: 0, gateLength: 0.9 },
      {
        clips: { [clipIndex(0, 0)]: noteClip(72) },
        arrangement: { events: [...PRE_EVENTS], lengthBeats: 8, loop: true },
        recording: false,
        recordMode: 'overdub',
      },
    );
    const ctx = new FakeAudioContext();
    await build(ctx);
    run(ctx, 0, 0.05);
    expect(liveArrangeEvents()).toHaveLength(2);

    // Arm — overdub must NOT clear.
    (livePatch.nodes[NODE_ID]!.data as Record<string, unknown>).recording = true;
    run(ctx, 0.05, 0.1);
    expect(liveArrangeEvents()).toHaveLength(2); // take preserved
    expect(liveArrangeEvents().map((e) => e.beat)).toEqual([0, 4]);
  });

  it('OVERDUB: a new launch MERGES into the kept log, beat-sorted', async () => {
    // Pre-seed a lane-2 launch at beat 0; overdub-arm; then launch lane 0 some
    // beats in. The new event must insert in song-beat order and NOT replace the
    // pre-seeded one. quantize off + free-run (no TIMELORDE) → launch applies
    // immediately and records at the current songBeat.
    seed(
      { stepDiv: 2, quantize: 0, octave: 0, gateLength: 0.9 },
      {
        clips: { [clipIndex(0, 0)]: noteClip(72), [clipIndex(0, 2)]: noteClip(60) },
        arrangement: { events: [{ beat: 0, lane: 2, slot: 0 }], lengthBeats: 8, loop: true },
        recording: false,
        recordMode: 'overdub',
      },
    );
    const ctx = new FakeAudioContext();
    await build(ctx);
    // Arm overdub.
    (livePatch.nodes[NODE_ID]!.data as Record<string, unknown>).recording = true;
    run(ctx, 0, 1.0); // ~2 beats @120bpm so songBeat advances past 0

    // Now launch lane 0 (queue it) — applies immediately + records at songBeat>0.
    (livePatch.nodes[NODE_ID]!.data as Record<string, unknown>).queued = lane8(0, 0, null);
    run(ctx, 1.0, 1.1);

    const evs = liveArrangeEvents();
    // The pre-seeded lane-2 event survives + the new lane-0 event merged in.
    expect(evs.length).toBeGreaterThanOrEqual(2);
    expect(evs.some((e) => e.lane === 2 && e.beat === 0)).toBe(true); // kept
    expect(evs.some((e) => e.lane === 0)).toBe(true); // overdubbed
    // beats stay non-decreasing (recordEvent inserts in sorted order).
    for (let i = 1; i < evs.length; i++) expect(evs[i].beat).toBeGreaterThanOrEqual(evs[i - 1].beat);
    // the overdubbed lane-0 event landed at a beat > 0 (true current song-beat).
    expect(evs.find((e) => e.lane === 0)!.beat).toBeGreaterThan(0);
  });
});

// ===========================================================================
// LIVE AUDITION (dual-Launchpad KEYS keyboard side-channel). The binding pushes
// note on/off into clip-audition; the factory tick DRAINS it BEFORE the
// transport gate + drives the lane's gate/vel/poly, so keys sound with the
// transport STOPPED. (The audible end-to-end chain is the e2e's job; here we pin
// the drain drives the lane outputs.)
// ===========================================================================
describe('clipplayer: live audition (KEYS)', () => {
  function velOf(handle: { outputs: Map<string, { node: unknown }> }, lane: number): FakeParam {
    return (handle.outputs.get(`vel${lane + 1}`)!.node as unknown as FakeConstantSource)
      .offset as unknown as FakeParam;
  }

  it('a pushed note-on raises the lane gate + velocity even with the transport STOPPED', async () => {
    clearAudition(NODE_ID);
    seed({ stepDiv: 2, quantize: 0, octave: 0 }, { clips: { [clipIndex(0, 0)]: noteClip(60) } });
    seedTimelorde(0); // transport STOPPED
    const handle = await build(ctx0());
    const gate = gateOf(handle as never, 0);
    const vel = velOf(handle as never, 0);
    // press a key on lane 0 (audition on).
    pushAudition(NODE_ID, { lane: 0, midi: 67, velocity: 127, on: true });
    hoisted.tick!();
    expect(hasHighEvent(gate), 'audition drove the lane gate high (transport stopped)').toBe(true);
    expect(vel.events.some((e) => e.value > 0), 'velocity CV written').toBe(true);
    // release → gate returns to 0.
    pushAudition(NODE_ID, { lane: 0, midi: 67, velocity: 0, on: false });
    hoisted.tick!();
    expect(gate.events.at(-1)!.value, 'gate closes on release').toBe(0);
  });

  it('is a no-op when nothing is queued (held gates are not re-written)', async () => {
    clearAudition(NODE_ID);
    seed({ stepDiv: 2, quantize: 0 }, { clips: {} });
    seedTimelorde(0);
    const handle = await build(ctx0());
    const gate = gateOf(handle as never, 0);
    const before = gate.events.length;
    hoisted.tick!();
    hoisted.tick!();
    expect(gate.events.length, 'empty drain writes nothing').toBe(before);
  });

  it('a HELD key keeps the gate high across ticks even while the clip PLAYS (no stomp)', async () => {
    // The bug: scheduled clip playback (emitLaneStep) was zeroing the held
    // audition voice/gate each step. A held key must hold the gate OPEN.
    clearAudition(NODE_ID);
    seed(
      { stepDiv: 2, quantize: 0, octave: 0, gateLength: 0.9 },
      { clips: { [clipIndex(0, 0)]: noteClip(60) }, playing: lane8(0, 0, null) },
    );
    seedTimelorde(1); // transport RUNNING → the clip is actively scheduled
    const ctx = ctx0();
    const handle = await build(ctx);
    const gate = gateOf(handle as never, 0);
    run(ctx, 0, 0.2); // playback running (gate toggles per step)
    // press + HOLD a keyboard note.
    pushAudition(NODE_ID, { lane: 0, midi: 67, velocity: 110, on: true });
    hoisted.tick!();
    const afterOn = gate.events.length;
    // keep the transport running for many ticks WITHOUT re-pressing.
    run(ctx, 0.2, 0.8);
    // no gate event since the note-on may write to 0 — the held gate stays HIGH.
    const stomped = gate.events.slice(afterOn).some((e) => e.value < 0.5);
    expect(stomped, 'the held key was NOT stomped to 0 by playback').toBe(false);
    expect(gate.events.at(-1)!.value, 'gate still high while held').toBe(1);
    // release → gate closes.
    pushAudition(NODE_ID, { lane: 0, midi: 67, velocity: 0, on: false });
    hoisted.tick!();
    expect(gate.events.at(-1)!.value, 'gate closes on release').toBe(0);
  });
});

// A fresh advanceable context per audition test (currentTime already at 0).
function ctx0(): FakeAudioContext {
  return new FakeAudioContext();
}
