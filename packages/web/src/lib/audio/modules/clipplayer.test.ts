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
  // Track which merger channel this source feeds so tests can reach the per-lane
  // poly gate/pitch params (createPolySender does gateSrc.connect(merger,0,ch)).
  connect(target?: unknown, _output?: number, input?: number) {
    const t = target as { _inputs?: Record<number, FakeConstantSource> } | undefined;
    if (t && t._inputs && typeof input === 'number') t._inputs[input] = this;
  }
  disconnect() {}
}
class FakeGain {
  gain = new FakeParam();
  injected: Float32Array | null = null;
  // Populated when this node is used as a ChannelMerger (poly sender output):
  // channel index → the ConstantSource feeding it.
  _inputs: Record<number, FakeConstantSource> = {};
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
/** The POLY-bus gate FakeParam for a lane's voice (default voice 0). Reaches the
 *  per-voice ConstantSource behind the lane's ChannelMerger (pitchN output) via
 *  the merger-input tracking in FakeConstantSource.connect. */
function polyGateOf(
  handle: { outputs: Map<string, { node: unknown }> },
  lane: number,
  voice = 0,
): FakeParam {
  const merger = handle.outputs.get(`pitch${lane + 1}`)!.node as unknown as FakeGain;
  return (merger._inputs[voice * 2 + 1] as unknown as FakeConstantSource).offset as unknown as FakeParam;
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

describe('clipplayer: per-lane clock rate (mult/div) + reset', () => {
  // Dense 128-step clip (a note on every step) so currentStep tracks the
  // playhead and the MONO gate opens once per step (its rising edges ARE the
  // lane's step times). 128 steps ≫ any window here → no loop wrap.
  const denseClip = (len = 128): NoteClipRecord => ({
    kind: 'note',
    lengthSteps: len,
    root: 48,
    loop: true,
    steps: Array.from({ length: len }, (_, s) => ({ step: s, midi: 60, velocity: 100, lengthSteps: 1 })),
  });
  /** Rising-edge (gate-open) times of a lane's mono gate. */
  function openTimes(handle: { outputs: Map<string, { node: unknown }> }, lane: number): number[] {
    return gateOf(handle, lane).events.filter((e) => e.value >= 0.5).map((e) => e.time);
  }
  const cs = (handle: { read?: (k: string) => unknown }, lane: number) =>
    handle.read!(`currentStep:${lane}`) as number;

  // bpm 120 + stepDiv 1 (2 steps/beat) → base step 0.25 s. All rate mults are
  // dyadic, so lane grids anchored at the same origin align EXACTLY.
  function seedRated(rate: number[], extra: Record<string, unknown> = {}) {
    seed(
      { stepDiv: 1, quantize: 0, octave: 0, gateLength: 0.9 },
      {
        clips: {
          [clipIndex(0, 0)]: denseClip(),
          [clipIndex(0, 1)]: denseClip(),
          [clipIndex(0, 2)]: denseClip(),
          [clipIndex(0, 3)]: denseClip(),
        },
        queued: [0, 0, 0, 0, null, null, null, null],
        rate,
        ...extra,
      },
    );
    seedTimelorde(1, 120);
  }

  it('rates advance lanes at EXACT 1/2 : 1 : 2x : 4x ratios from a common origin', async () => {
    // lane0=1/2, lane1=1, lane2=2x, lane3=4x (indices into RATE_MULTS).
    seedRated([2, 3, 4, 5, 3, 3, 3, 3]);
    const ctx = new FakeAudioContext();
    const handle = await build(ctx);
    run(ctx, 0, 2.0); // last tick at 1.975 — all lanes launched at the 0.01 anchor
    // floor((1.975 - 0.01) / laneDur): the ratio is exactly 2:1:4 relative.
    expect(cs(handle, 0)).toBe(3); // ÷2 → 0.5 s/step
    expect(cs(handle, 1)).toBe(7); // 1  → 0.25 s/step
    expect(cs(handle, 2)).toBe(15); // ×2 → 0.125 s/step
    expect(cs(handle, 3)).toBe(31); // ×4 → 0.0625 s/step
  });

  it('phase rule: a ÷2 lane advances on EVEN base steps from the shared origin', async () => {
    seedRated([2, 3, 4, 3, 3, 3, 3, 3]);
    const ctx = new FakeAudioContext();
    const handle = await build(ctx);
    run(ctx, 0, 2.0);
    const base = openTimes(handle, 1); // the 1x lane = the base grid
    const half = openTimes(handle, 0); // the ÷2 lane
    const dbl = openTimes(handle, 2); // the ×2 lane
    expect(half.length).toBeGreaterThanOrEqual(4);
    // Every ÷2 open time coincides with a base-grid open time (even steps 0,2,4…).
    for (const t of half) {
      expect(base.some((b) => Math.abs(b - t) < 1e-9), `÷2 step at ${t} on the base grid`).toBe(true);
    }
    // The ×2 lane lands ON the base grid every second advance (even indices).
    for (let i = 0; i < dbl.length; i += 2) {
      expect(base.some((b) => Math.abs(b - dbl[i]) < 1e-9), `×2 step ${i} at ${dbl[i]} on the base grid`).toBe(true);
    }
  });

  it('tempo change: every lane rescales together, ratios preserved (no inference lag)', async () => {
    // lane1=1x, lane2=2x (lane0 also playing but unasserted).
    seedRated([3, 3, 4, 3, 3, 3, 3, 3]);
    const ctx = new FakeAudioContext();
    const handle = await build(ctx);
    run(ctx, 0, 1.0); // @120bpm
    (livePatch.nodes['tl']!.params as Record<string, number>).bpm = 240; // base 0.25 → 0.125
    run(ctx, 1.0, 2.0); // settle across the transition (old lookahead drains)
    const a1 = cs(handle, 1);
    const a2 = cs(handle, 2);
    run(ctx, 2.0, 3.0); // a clean 1 s window fully at the new tempo
    const d1 = cs(handle, 1) - a1;
    const d2 = cs(handle, 2) - a2;
    expect(d1).toBe(8); // 1 s / 0.125 s per step
    expect(d2).toBe(16); // the ×2 lane holds exactly double — locked to bpm, not inferred
    expect(d2).toBe(2 * d1);
  });

  it('reset input (rising edge): ACTIVE lanes snap to step 1, phase re-anchors COMMON, queued kept', async () => {
    // lane0=1x, lane1=÷2; queue a slot-1 switch on lane0 (quantize would apply
    // it only at the far-away loop boundary — reset must NOT consume it).
    seed(
      { stepDiv: 1, quantize: 1, octave: 0, gateLength: 0.9 },
      {
        clips: { [clipIndex(0, 0)]: denseClip(), [clipIndex(1, 0)]: denseClip(), [clipIndex(0, 1)]: denseClip() },
        playing: [0, 0, null, null, null, null, null, null],
        rate: [3, 2, 3, 3, 3, 3, 3, 3],
      },
    );
    seedTimelorde(1, 120);
    const ctx = new FakeAudioContext();
    const handle = await build(ctx);
    run(ctx, 0, 1.2); // both lanes mid-cycle
    expect(cs(handle, 0)).toBeGreaterThanOrEqual(3);
    expect(cs(handle, 1)).toBeGreaterThanOrEqual(1);
    // queue a switch on lane 0 (its 128-step boundary is ~32 s away → stays queued)
    (livePatch.nodes[NODE_ID]!.data as Record<string, unknown>).queued = lane8<number | null>(0, 1, null);
    run(ctx, 1.2, 1.25);

    const resetGain = handle.inputs.get('reset')!.node as unknown as FakeGain;
    resetGain.injected = pulseBuffer();
    run(ctx, 1.25, 1.27); // ONE tick at t=1.25 services the edge
    resetGain.injected = null;
    const R = 1.25 + 0.01; // the common re-anchor instant (reset-tick time + 10 ms)
    run(ctx, 1.275, 1.35);
    // Both ACTIVE lanes snapped back to step 1 (index 0) and stayed active.
    expect(cs(handle, 0)).toBe(0);
    expect(cs(handle, 1)).toBe(0);
    expect(handle.read!('activeLane:0')).toBe(0);
    expect(handle.read!('activeLane:1')).toBe(0);
    // The queued (not-yet-started) switch was untouched by the reset.
    const queued = (livePatch.nodes[NODE_ID]!.data as { queued?: (number | null)[] }).queued!;
    expect(queued[0]).toBe(1);

    // Phase re-anchor: post-reset, BOTH lanes restart at the SAME instant and
    // the ÷2 lane's opens all land on the 1x lane's (even-step) grid.
    run(ctx, 1.35, 2.5);
    const post1 = openTimes(handle, 0).filter((t) => t >= R - 1e-9);
    const postH = openTimes(handle, 1).filter((t) => t >= R - 1e-9);
    expect(Math.abs(post1[0] - R)).toBeLessThan(1e-9); // step 1 together, at R
    expect(Math.abs(postH[0] - R)).toBeLessThan(1e-9);
    for (const t of postH) {
      expect(post1.some((b) => Math.abs(b - t) < 1e-9), `÷2 post-reset step at ${t} realigned`).toBe(true);
    }
  });

  it('card RST nonce: adopt-on-boot (no replay), then a bump snaps active lanes to step 1', async () => {
    seedRated([3, 3, 3, 3, 3, 3, 3, 3], { resetNonce: 7 }); // saved patch with an old nonce
    const ctx = new FakeAudioContext();
    const handle = await build(ctx);
    run(ctx, 0, 1.2);
    // The pre-existing nonce did NOT pin the playhead (adopted, not replayed).
    expect(cs(handle, 0)).toBeGreaterThanOrEqual(3);
    // Bump (what the card RST button / its MIDI binding writes) → snap.
    (livePatch.nodes[NODE_ID]!.data as Record<string, unknown>).resetNonce = 8;
    run(ctx, 1.2, 1.3);
    expect(cs(handle, 0)).toBe(0);
    expect(handle.read!('activeLane:0')).toBe(0); // still playing
  });

  it('reset with nothing active is a no-op (stopped lanes stay stopped)', async () => {
    seed({ stepDiv: 1, quantize: 1, octave: 0, gateLength: 0.9 }, { clips: {} });
    seedTimelorde(1, 120);
    const ctx = new FakeAudioContext();
    const handle = await build(ctx);
    run(ctx, 0, 0.2);
    const resetGain = handle.inputs.get('reset')!.node as unknown as FakeGain;
    resetGain.injected = pulseBuffer();
    run(ctx, 0.2, 0.25);
    resetGain.injected = null;
    run(ctx, 0.25, 0.4);
    for (let L = 0; L < 8; L++) expect(handle.read!(`activeLane:${L}`)).toBe(-1);
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

// ===========================================================================
// TIED-NOTE POLY GATE (gate/held-note plan Phase 1). A held/tied note
// (lengthSteps>1) must hold its POLY-bus gate across the whole span exactly like
// its MONO gate — before the fix, poly.scheduleStep re-zeroed the gate on every
// rest step, so a tied note released a step early into poly synths while the
// mono bus sustained. Assert the two gates' close schedules AGREE.
// ===========================================================================
describe('clipplayer: tied-note poly gate (Phase 1)', () => {
  it('a tied note holds the POLY gate across its span, matching the MONO gate (no early poly close)', async () => {
    clearAudition(NODE_ID);
    // one 2-step tied note at step 0 of a long clip (so the short run stays well
    // inside it — no loop wrap, no clip-end stop to add unrelated gate events).
    const tied: NoteClipRecord = {
      kind: 'note',
      steps: [{ step: 0, midi: 60, velocity: 127, lengthSteps: 2 }],
      lengthSteps: 16,
      root: 48,
      loop: true,
    };
    seed(
      { stepDiv: 4, quantize: 0, octave: 0, gateLength: 0.9, snh: 1 },
      { clips: { [clipIndex(0, 0)]: tied }, playing: lane8(0, 0, null) },
    );
    seedTimelorde(1); // transport running → the clip is scheduled
    const ctx = ctx0();
    const handle = await build(ctx);
    const mono = gateOf(handle as never, 0);
    const poly = polyGateOf(handle as never, 0);
    run(ctx, 0, 0.5); // crosses the tied note's 2 steps + a couple of rests
    const closes = (p: FakeParam) =>
      p.events.filter((e) => e.value === 0).map((e) => Math.round(e.time * 1e6) / 1e6);
    expect(hasHighEvent(poly), 'poly gate opened for the tied note').toBe(true);
    // The crux: the poly gate must NOT be re-zeroed at the step-1 boundary; its
    // close schedule must EQUAL the mono gate's (whose rest-step else-branch never
    // writes). Pre-fix, poly carried an extra 0 one step early.
    expect(closes(poly), 'poly gate closes agree with the mono gate').toEqual(closes(mono));
  });
});

// ===========================================================================
// STABLE VOICE ALLOCATOR (gate/held-note plan Phase 2a). Held KEYS-audition
// notes each keep their OWN poly voice-lane for their whole life. Releasing a
// LOWER held note must free ONLY its voice and NOT shift/re-write a still-held
// HIGHER note (the old positional repack shifted the survivors down a lane,
// rewriting pitch on a sounding voice → glitch/retrigger). We assert directly on
// the per-voice poly params via the merger-input tracking.
// ===========================================================================
describe('clipplayer: stable voice allocator (KEYS audition, Phase 2a)', () => {
  function polyPitchOf(
    handle: { outputs: Map<string, { node: unknown }> },
    lane: number,
    voice = 0,
  ): FakeParam {
    const merger = handle.outputs.get(`pitch${lane + 1}`)!.node as unknown as FakeGain;
    return (merger._inputs[voice * 2] as unknown as FakeConstantSource).offset as unknown as FakeParam;
  }

  it('releasing a LOWER held note does NOT shift/re-write a still-held HIGHER note', async () => {
    clearAudition(NODE_ID);
    // Pure live audition on lane 0 with the transport STOPPED (no clip launched),
    // so the only writes come from the audition drain.
    seed({ stepDiv: 2, quantize: 0, octave: 0 }, { clips: {} });
    seedTimelorde(0);
    const ctx = ctx0();
    const handle = await build(ctx);

    // Press A (low, midi 60) then B (higher, midi 64): A → voice 0, B → voice 1.
    pushAudition(NODE_ID, { lane: 0, midi: 60, velocity: 100, on: true });
    hoisted.tick!();
    pushAudition(NODE_ID, { lane: 0, midi: 64, velocity: 100, on: true });
    hoisted.tick!();

    const v0gate = polyGateOf(handle as never, 0, 0);
    const v1gate = polyGateOf(handle as never, 0, 1);
    const v1pitch = polyPitchOf(handle as never, 0, 1);
    // B is on voice 1 at its own pitch, gate high (it took the SECOND lane, not 0).
    expect(v1pitch.value).toBeCloseTo(midiToVOct(64), 5);
    expect(v1gate.value).toBe(1);
    const v1GateEvents = v1gate.events.length;
    const v1PitchEvents = v1pitch.events.length;

    // Release the LOWER note A. Its voice (0) falls; B (voice 1) is UNTOUCHED.
    pushAudition(NODE_ID, { lane: 0, midi: 60, velocity: 0, on: false });
    hoisted.tick!();

    // A's voice closed cleanly.
    expect(v0gate.events.at(-1)!.value, "A's voice fell on release").toBe(0);
    // B's voice: NO new gate or pitch events — not shifted down to voice 0, not
    // re-written. This is the positional-repack glitch the allocator fixes.
    expect(v1gate.events.length, 'B gate not re-written').toBe(v1GateEvents);
    expect(v1pitch.events.length, 'B pitch not re-written').toBe(v1PitchEvents);
    expect(v1gate.value, 'B still sounding on voice 1').toBe(1);
    expect(v1pitch.value, 'B still at its own pitch').toBeCloseTo(midiToVOct(64), 5);
    // B did NOT migrate onto A's freed voice 0 (voice 0 keeps A's stale pitch;
    // its gate is closed so it is silent).
    const v0pitch = polyPitchOf(handle as never, 0, 0);
    expect(v0pitch.value, 'voice 0 not overwritten with B').toBeCloseTo(midiToVOct(60), 5);
  });

  it('a released voice-lane is REUSED (lowest-free) by the next held note', async () => {
    clearAudition(NODE_ID);
    seed({ stepDiv: 2, quantize: 0, octave: 0 }, { clips: {} });
    seedTimelorde(0);
    const ctx = ctx0();
    const handle = await build(ctx);
    // Hold three notes → voices 0,1,2.
    for (const m of [60, 64, 67]) {
      pushAudition(NODE_ID, { lane: 0, midi: m, velocity: 100, on: true });
      hoisted.tick!();
    }
    const v1pitch = polyPitchOf(handle as never, 0, 1);
    expect(v1pitch.value).toBeCloseTo(midiToVOct(64), 5);
    // Release the MIDDLE note (voice 1), then press a new note — it takes the
    // freed voice 1 (lowest free) with a clean rising edge at the new pitch.
    pushAudition(NODE_ID, { lane: 0, midi: 64, velocity: 0, on: false });
    hoisted.tick!();
    expect(polyGateOf(handle as never, 0, 1).events.at(-1)!.value).toBe(0);
    pushAudition(NODE_ID, { lane: 0, midi: 72, velocity: 100, on: true });
    hoisted.tick!();
    // New note landed on the reused voice 1 at its own pitch, gate high.
    expect(v1pitch.value, 'reused voice 1 now plays the new note').toBeCloseTo(midiToVOct(72), 5);
    expect(polyGateOf(handle as never, 0, 1).value).toBe(1);
    // Voices 0 and 2 (60, 67) are untouched — still sounding.
    expect(polyGateOf(handle as never, 0, 0).value).toBe(1);
    expect(polyGateOf(handle as never, 0, 2).value).toBe(1);
  });
});

// A fresh advanceable context per audition test (currentTime already at 0).
function ctx0(): FakeAudioContext {
  return new FakeAudioContext();
}
