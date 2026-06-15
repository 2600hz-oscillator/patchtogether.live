// packages/web/src/lib/audio/modules/clipplayer.test.ts
//
// Drives the REAL clipplayer factory + tick loop against a fake AudioContext
// (advanceable currentTime) and the live graph store, asserting launch / quantized
// switch / stop / silent-when-empty behavior. The audible end-to-end chain
// (TIMELORDE → clipplayer → voice → RMS) is covered by the e2e spec.

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
import type { NoteClipRecord } from './clip-types';

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
  it('declares the launch I/O ports', () => {
    expect(clipplayerDef.inputs.map((p) => p.id).sort()).toEqual(['clock', 'stop_all']);
    const outs = Object.fromEntries(clipplayerDef.outputs.map((p) => [p.id, p.type]));
    expect(outs).toEqual({
      pitch: 'polyPitchGate',
      gate: 'gate',
      velocity: 'cv',
      clip_gate: 'gate',
    });
  });
});

describe('clipplayer: launch', () => {
  it('launches a queued clip immediately (quantize off) and emits its pitch + gate', async () => {
    seed({ bpm: 120, quantize: 0, octave: 0, gateLength: 0.9 }, { clips: { '0': noteClip(72) }, queued: '0' });
    const ctx = new FakeAudioContext();
    const handle = await build(ctx);
    expect(hoisted.tick).toBeTruthy();
    run(ctx, 0, 0.1);
    expect(handle.read!('activeClip')).toBe(0);
    expect(handle.read!('pitchVOct')).toBeCloseTo(midiToVOct(72), 5); // C5 = +1 V/oct
    const gate = (handle.outputs.get('gate')!.node as unknown as FakeConstantSource).offset as unknown as FakeParam;
    expect(hasHighEvent(gate)).toBe(true);
    const clipGate = (handle.outputs.get('clip_gate')!.node as unknown as FakeConstantSource).offset as unknown as FakeParam;
    expect(hasHighEvent(clipGate)).toBe(true); // pulsed on start
  });

  it('applies the octave param to the emitted pitch', async () => {
    seed({ bpm: 120, quantize: 0, octave: 1, gateLength: 0.9 }, { clips: { '0': noteClip(60) }, queued: '0' });
    const ctx = new FakeAudioContext();
    const handle = await build(ctx);
    run(ctx, 0, 0.1);
    expect(handle.read!('pitchVOct')).toBeCloseTo(midiToVOct(60) + 1, 5);
  });
});

describe('clipplayer: quantized switch', () => {
  it('a queued clip takes over only at the active clip loop boundary', async () => {
    seed(
      { bpm: 120, quantize: 1, octave: 0, gateLength: 0.9 },
      { clips: { '0': noteClip(72), '1': noteClip(48) } },
    );
    const ctx = new FakeAudioContext();
    const handle = await build(ctx);

    // Launch clip 0 — nothing playing yet, so it starts immediately.
    (livePatch.nodes[NODE_ID]!.data as Record<string, unknown>).queued = '0';
    run(ctx, 0, 0.1);
    expect(handle.read!('activeClip')).toBe(0);

    // Queue clip 1. A 4-step clip at 120bpm 16ths loops every 0.5s. The
    // lookahead (200ms) means the state machine crosses the loop boundary
    // ~lookahead ahead of audio time — so before the boundary is *scheduled*
    // it's still clip 0, after it's clip 1.
    (livePatch.nodes[NODE_ID]!.data as Record<string, unknown>).queued = '1';
    // Before the first loop boundary is reached it must still be clip 0.
    run(ctx, 0.1, 0.16);
    expect(handle.read!('activeClip')).toBe(0);
    // Once the lookahead crosses the boundary it switches to clip 1.
    run(ctx, 0.16, 0.8);
    expect(handle.read!('activeClip')).toBe(1);
    expect(handle.read!('pitchVOct')).toBeCloseTo(midiToVOct(48), 5); // C3 = -1 V/oct
  });
});

describe('clipplayer: stop', () => {
  it('stop_all rising edge stops the playing clip', async () => {
    seed({ bpm: 120, quantize: 0, octave: 0, gateLength: 0.9 }, { clips: { '0': noteClip(72) }, queued: '0' });
    const ctx = new FakeAudioContext();
    const handle = await build(ctx);
    run(ctx, 0, 0.1);
    expect(handle.read!('activeClip')).toBe(0);

    // Inject a rising edge on stop_all.
    const stopGain = handle.inputs.get('stop_all')!.node as unknown as FakeGain;
    stopGain.injected = pulseBuffer();
    run(ctx, 0.1, 0.15);
    expect(handle.read!('activeClip')).toBe(-1);
  });
});

describe('clipplayer: silent when empty', () => {
  it('emits no gate when no clip is launched', async () => {
    seed({ bpm: 120, quantize: 1, octave: 0, gateLength: 0.9 }, {});
    const ctx = new FakeAudioContext();
    const handle = await build(ctx);
    run(ctx, 0, 0.3);
    expect(handle.read!('activeClip')).toBe(-1);
    const gate = (handle.outputs.get('gate')!.node as unknown as FakeConstantSource).offset as unknown as FakeParam;
    expect(hasHighEvent(gate)).toBe(false);
  });
});
