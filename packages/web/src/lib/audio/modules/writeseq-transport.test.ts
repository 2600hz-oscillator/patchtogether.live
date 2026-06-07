// packages/web/src/lib/audio/modules/writeseq-transport.test.ts
//
// TRANSPORT-RULE unit tests for WRITESEQ's record state machine (same
// FakeAudioContext harness as writeseq-alignment.test.ts). Covers the design's
// transport transitions T1–T6 + the pass-through invariant:
//
//   - gate-start-when-armed (INTERNAL clock): STOPPED + recArm, no clock edge,
//     inject gate → isPlaying:=1, recording, stepIndex→0, gate recorded step 0.
//   - external-clock-STOPPED → NO record: STOPPED + recArm + clock EDGE present
//     but ZERO clock pulses → no start, no record, data.steps unchanged; gate
//     still passes through on pitch/gate outs.
//   - external-clock-running gate-start works (same but inject clock pulses).
//   - one-shot-to-128 then loop-play (overdub=0, length=4): record over a full
//     pass → recording stops after `length` steps, recArm auto-clears to 0,
//     then loop-plays with no further writes.
//   - overdub vs one-shot: overdub=1 → no clear on start, a gate in loop 2
//     lands + old steps survive; overdub=0 → start clears the prior sequence.
//   - pass-through always on (recArm=0/overdub=0, STOPPED): a held gate+cv
//     drives pitch/gate outs.
//   - run-independent-of-TIMELORDE: no TIMELORDE node, WRITESEQ never reads a
//     `running` flag, still plays on isPlaying / internal clock.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const subs = new Set<() => void>();
  return { subs, tick: () => { for (const fn of subs) fn(); } };
});
vi.mock('$lib/audio/scheduler-clock', () => ({
  SCHEDULER_TICK_MS: 25,
  getSchedulerClock: () => ({
    subscribe: (fn: () => void) => {
      hoisted.subs.add(fn);
      return () => { hoisted.subs.delete(fn); };
    },
    usingWorker: false,
    dispose: () => {},
  }),
}));

import { patch as livePatch } from '$lib/graph/store';

class FakeParam {
  value = 0;
  events: { value: number; time: number }[] = [];
  setValueAtTime(value: number, time: number) { this.events.push({ value, time }); this.value = value; return this; }
  cancelScheduledValues(fromTime: number) { this.events = this.events.filter((e) => e.time < fromTime); return this; }
  linearRampToValueAtTime(value: number, time: number) { this.events.push({ value, time }); this.value = value; return this; }
  setTargetAtTime(value: number, time: number) { this.events.push({ value, time }); this.value = value; return this; }
}
class FakeConstantSource {
  offset = new FakeParam();
  _connectedTo: FakeGain | null = null;
  start() {}
  stop() {}
  connect(node: unknown) { if (node instanceof FakeGain) this._connectedTo = node; }
  disconnect() {}
}
class FakeGain {
  gain = new FakeParam();
  injected: Float32Array | null = null;
  _analyser: FakeAnalyser | null = null;
  connect(node: unknown) { if (node instanceof FakeAnalyser) { this._analyser = node; node._source = this; } }
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
  createConstantSource() { return new FakeConstantSource() as unknown as ConstantSourceNode; }
  createGain() { return new FakeGain() as unknown as GainNode; }
  createAnalyser() { return new FakeAnalyser() as unknown as AnalyserNode; }
}

function pulseBuffer(len: number): Float32Array {
  const b = new Float32Array(len);
  for (let i = len - 64; i < len; i++) b[i] = 1;
  return b;
}
function heldBuffer(len: number): Float32Array {
  // A fully-high buffer: latestSample reads the last sample = 1 (gate HELD),
  // and the rising-edge scan from a 0 baseline sees exactly one edge.
  return new Float32Array(len).fill(1);
}
function constBuffer(len: number, v: number): Float32Array {
  return new Float32Array(len).fill(v);
}

import { writeseqDef } from './writeseq';
import { midiToVOct } from '$lib/audio/note-entry';

const ID = 'wseq1';

function clearPatch() {
  for (const k of Object.keys(livePatch.nodes)) delete livePatch.nodes[k];
  for (const k of Object.keys(livePatch.edges)) delete livePatch.edges[k];
}

interface SeedOpts {
  isPlaying?: number;
  recArm?: number;
  overdub?: number;
  length?: number;
  bpm?: number;
  externalClock?: boolean;
}
function seed(opts: SeedOpts = {}) {
  clearPatch();
  livePatch.nodes[ID] = {
    id: ID,
    type: 'writeseq',
    domain: 'audio',
    position: { x: 0, y: 0 },
    params: {
      bpm: opts.bpm ?? 120,
      length: opts.length ?? 16,
      octave: 0,
      gateLength: 0.5,
      isPlaying: opts.isPlaying ?? 0,
      recArm: opts.recArm ?? 0,
      overdub: opts.overdub ?? 0,
    },
    data: { steps: [] },
  } as never;
  if (opts.externalClock) {
    livePatch.edges['e-clk'] = {
      id: 'e-clk',
      source: { nodeId: 'clk', portId: 'clock' },
      target: { nodeId: ID, portId: 'clock' },
    } as never;
  }
}

interface Handle {
  inputs: Map<string, { node: AudioNode }>;
  outputs: Map<string, { node: AudioNode }>;
  read(key: string): unknown;
  readParam(key: string): number | undefined;
  dispose(): void;
}
async function spawn(ctx: FakeAudioContext): Promise<Handle> {
  return (await writeseqDef.factory(
    ctx as unknown as AudioContext,
    { id: ID, type: 'writeseq', params: livePatch.nodes[ID]!.params } as never,
  )) as unknown as Handle;
}

function gainOf(h: Handle, port: string): FakeGain {
  return h.inputs.get(port)!.node as unknown as FakeGain;
}
function paramOf(h: Handle, port: string): FakeParam {
  return (h.outputs.get(port)!.node as unknown as FakeConstantSource).offset as unknown as FakeParam;
}
function setClock(h: Handle, pulse: boolean) {
  const g = gainOf(h, 'clock');
  const len = g._analyser?.fftSize ?? 16384;
  g.injected = pulse ? pulseBuffer(len) : new Float32Array(len);
}
function setGate(h: Handle, mode: 'low' | 'edge' | 'held') {
  const g = gainOf(h, 'gate');
  const len = g._analyser?.fftSize ?? 2048;
  g.injected = mode === 'low' ? new Float32Array(len) : mode === 'held' ? heldBuffer(len) : pulseBuffer(len);
}
function setCv(h: Handle, vOct: number) {
  const g = gainOf(h, 'cv');
  const len = g._analyser?.fftSize ?? 2048;
  g.injected = constBuffer(len, vOct);
}
function setRec(h: Handle, pulse: boolean) {
  const g = gainOf(h, 'rec');
  const len = g._analyser?.fftSize ?? 2048;
  g.injected = pulse ? pulseBuffer(len) : new Float32Array(len);
}
function steps(): Array<{ on: boolean; midi: number | null }> {
  return (livePatch.nodes[ID]!.data as { steps: Array<{ on: boolean; midi: number | null }> }).steps;
}
function onCount(): number {
  return steps().filter((s) => s?.on).length;
}

describe('WRITESEQ transport rules', () => {
  beforeEach(() => {
    hoisted.subs.clear();
    clearPatch();
  });

  it('T3 gate-start-when-armed (INTERNAL clock): a gate starts seq + record at step 0', async () => {
    seed({ isPlaying: 0, recArm: 1, length: 8 }); // internal clock (no edge)
    const ctx = new FakeAudioContext();
    const h = await spawn(ctx);

    // Warm-up: stopped, armed, no gate.
    ctx.currentTime = 0;
    setClock(h, false); setGate(h, 'low'); setCv(h, midiToVOct(60)); setRec(h, false);
    hoisted.tick();
    expect(h.readParam('isPlaying')).toBe(0);
    expect(h.read('recordingActive')).toBe(0);

    // A gate arrives → starts the sequencer + record (internal pulses always
    // available). Same tick: cv = C4.
    ctx.currentTime = 0.025;
    setGate(h, 'edge'); setCv(h, midiToVOct(60));
    hoisted.tick();

    expect(h.readParam('isPlaying')).toBe(1);
    expect(h.read('recordingActive')).toBe(1);
    expect(h.read('lastRecordedStep')).toBe(0);
    expect(steps()[0]).toEqual({ on: true, midi: 60 });
    h.dispose();
  });

  it('external-clock STOPPED → NO record (no pulses); gate still passes through', async () => {
    seed({ isPlaying: 0, recArm: 1, length: 8, externalClock: true });
    const ctx = new FakeAudioContext();
    const h = await spawn(ctx);
    const pitchOut = paramOf(h, 'pitch');
    const gateOut = paramOf(h, 'gate');

    // Warm-up.
    ctx.currentTime = 0;
    setClock(h, false); setGate(h, 'low'); setCv(h, midiToVOct(67)); setRec(h, false);
    hoisted.tick();

    // A gate arrives but NO clock pulses are injected (external clock stopped).
    // Hold the gate high so pass-through engages.
    ctx.currentTime = 0.025;
    setClock(h, false); setGate(h, 'held'); setCv(h, midiToVOct(67));
    hoisted.tick();

    // NO start, NO record, steps unchanged (all off).
    expect(h.readParam('isPlaying')).toBe(0);
    expect(h.read('recordingActive')).toBe(0);
    expect(onCount()).toBe(0);

    // BUT the held gate passes through to pitch + gate outs.
    expect(gateOut.value).toBeGreaterThanOrEqual(0.5);
    expect(Math.abs(pitchOut.value - midiToVOct(67))).toBeLessThan(0.01);
    h.dispose();
  });

  it('external-clock RUNNING records (clock pulses present): the gate lands a step', async () => {
    // Contrast with the STOPPED case above: WITH actual clock pulses, an armed
    // WRITESEQ records. Playback here is driven by the clock-only branch
    // (isPlaying may stay 0 — the clock IS the play signal), so we assert on the
    // record OUTCOME (recording active + a step written), not the isPlaying flag.
    seed({ isPlaying: 0, recArm: 1, length: 8, externalClock: true });
    const ctx = new FakeAudioContext();
    const h = await spawn(ctx);

    // Warm-up + a clock pulse so the record pass begins (clock active).
    ctx.currentTime = 0;
    setClock(h, false); setGate(h, 'low'); setCv(h, midiToVOct(72)); setRec(h, false);
    hoisted.tick();
    ctx.currentTime = 0.025;
    setClock(h, true); setGate(h, 'low');
    hoisted.tick();
    // Recording began once the clock was active.
    expect(h.read('recordingActive')).toBe(1);

    // A gate arrives WITH a fresh clock pulse (a key in time with the beat) →
    // records a step at midi 72.
    ctx.currentTime = 0.05;
    setClock(h, true); setGate(h, 'edge'); setCv(h, midiToVOct(72));
    hoisted.tick();

    expect(h.read('recordingActive')).toBe(1);
    expect(onCount()).toBeGreaterThanOrEqual(1);
    const recStep = Number(h.read('lastRecordedStep'));
    expect(steps()[recStep]).toEqual({ on: true, midi: 72 });
    h.dispose();
  });

  it('one-shot-to-N then loop-play: recording stops after `length` steps + auto-clears recArm', async () => {
    // Internal clock, length 4, fast bpm so a few steps pass quickly.
    seed({ isPlaying: 1, recArm: 1, length: 4, bpm: 240 });
    const ctx = new FakeAudioContext();
    const h = await spawn(ctx);

    // Pump enough ticks for the internal lookahead to advance > length steps.
    // stepDur @ 240bpm = 60/240/4 = 0.0625s. LOOKAHEAD 0.2s schedules ~3 steps
    // per tick; a handful of ticks covers a full one-shot pass of 4 steps.
    setClock(h, false); setGate(h, 'low'); setCv(h, midiToVOct(60)); setRec(h, false);
    let t = 0;
    let stoppedRecordingSeen = false;
    for (let i = 0; i < 30; i++) {
      ctx.currentTime = t;
      hoisted.tick();
      if (h.read('recordingActive') === 0) stoppedRecordingSeen = true;
      t += 0.025;
    }
    // Recording auto-stopped after the one-shot window.
    expect(stoppedRecordingSeen).toBe(true);
    expect(h.read('recordingActive')).toBe(0);
    // recArm auto-cleared to 0.
    expect(h.readParam('recArm')).toBe(0);
    // No gate was ever pressed, so the (cleared) sequence has no on-steps —
    // the one-shot pass recorded nothing and is now looping/playing empty.
    expect(onCount()).toBe(0);

    // After auto-disarm, further ticks do NOT record (recordingActive stays 0)
    // even if a gate arrives.
    ctx.currentTime = t; setGate(h, 'edge'); setCv(h, midiToVOct(64));
    hoisted.tick();
    expect(h.read('recordingActive')).toBe(0);
    expect(onCount()).toBe(0);
    h.dispose();
  });

  it('one-shot start CLEARS the prior sequence; OVERDUB start does NOT', async () => {
    // ---- one-shot clears ----
    seed({ isPlaying: 0, recArm: 1, overdub: 0, length: 8 });
    const ctx = new FakeAudioContext();
    let h = await spawn(ctx);
    // Pre-populate a step via a recorded gate-start, then re-arm + restart.
    ctx.currentTime = 0; setClock(h, false); setGate(h, 'low'); setCv(h, midiToVOct(60)); setRec(h, false);
    hoisted.tick();
    // Manually pre-seed an existing on-step in the data to prove the clear.
    (livePatch.nodes[ID]!.data as { steps: Array<{ on: boolean; midi: number }> }).steps = [
      { on: true, midi: 48 },
      { on: true, midi: 50 },
    ];
    // Stop, re-arm, start playing → one-shot start should CLEAR.
    livePatch.nodes[ID]!.params.isPlaying = 0;
    ctx.currentTime = 0.025; setGate(h, 'low');
    hoisted.tick();
    livePatch.nodes[ID]!.params.isPlaying = 1;
    livePatch.nodes[ID]!.params.recArm = 1;
    ctx.currentTime = 0.05;
    hoisted.tick();
    expect(onCount()).toBe(0); // prior on-steps cleared
    h.dispose();

    // ---- overdub does NOT clear ----
    hoisted.subs.clear();
    seed({ isPlaying: 0, recArm: 0, overdub: 1, length: 8 });
    const ctx2 = new FakeAudioContext();
    h = await spawn(ctx2);
    ctx2.currentTime = 0; setClock(h, false); setGate(h, 'low'); setCv(h, midiToVOct(60)); setRec(h, false);
    hoisted.tick();
    (livePatch.nodes[ID]!.data as { steps: Array<{ on: boolean; midi: number }> }).steps = [
      { on: true, midi: 48 },
      { on: true, midi: 50 },
    ];
    livePatch.nodes[ID]!.params.isPlaying = 1; // overdub start
    ctx2.currentTime = 0.025;
    hoisted.tick();
    // Old steps survive (no clear under overdub).
    expect(steps()[0]?.on).toBe(true);
    expect(steps()[1]?.on).toBe(true);
    h.dispose();
  });

  it('PASS-THROUGH is always on (recArm=0, overdub=0, STOPPED): a held gate+cv drives the outs', async () => {
    seed({ isPlaying: 0, recArm: 0, overdub: 0, length: 8 });
    const ctx = new FakeAudioContext();
    const h = await spawn(ctx);
    const pitchOut = paramOf(h, 'pitch');
    const gateOut = paramOf(h, 'gate');

    ctx.currentTime = 0; setClock(h, false); setGate(h, 'held'); setCv(h, midiToVOct(64)); setRec(h, false);
    hoisted.tick();

    // Pure monitoring: never playing, never recording, but the live signal
    // appears on both outputs.
    expect(h.readParam('isPlaying')).toBe(0);
    expect(h.read('recordingActive')).toBe(0);
    expect(gateOut.value).toBeGreaterThanOrEqual(0.5);
    expect(Math.abs(pitchOut.value - midiToVOct(64))).toBeLessThan(0.01);
    // No steps were written (pass-through is independent of record).
    expect(onCount()).toBe(0);
    h.dispose();
  });

  it('run is INDEPENDENT of TIMELORDE: no TIMELORDE node, still plays on isPlaying', async () => {
    seed({ isPlaying: 1, recArm: 0, overdub: 0, length: 4, bpm: 240 });
    const ctx = new FakeAudioContext();
    const h = await spawn(ctx);
    // Seed an on-step so playback emits something measurable.
    (livePatch.nodes[ID]!.data as { steps: Array<{ on: boolean; midi: number }> }).steps = [
      { on: true, midi: 60 },
      { on: false, midi: 60 },
      { on: false, midi: 60 },
      { on: false, midi: 60 },
    ];
    const gateOut = paramOf(h, 'gate');

    setClock(h, false); setGate(h, 'low'); setCv(h, 0); setRec(h, false);
    let t = 0;
    for (let i = 0; i < 6; i++) {
      ctx.currentTime = t;
      hoisted.tick();
      t += 0.025;
    }
    // The internal clock advanced + emitted the on-step's gate — no TIMELORDE,
    // no `running` read, just isPlaying + the internal scheduler.
    const onsets = gateOut.events.filter((e) => e.value >= 0.5).length;
    expect(onsets).toBeGreaterThanOrEqual(1);
    expect(Number(h.read('totalAdvances'))).toBeGreaterThan(0);
    h.dispose();
  });

  it('T1: a rec-gate rising edge TOGGLES recArm', async () => {
    seed({ isPlaying: 0, recArm: 0, length: 8 });
    const ctx = new FakeAudioContext();
    const h = await spawn(ctx);
    ctx.currentTime = 0; setClock(h, false); setGate(h, 'low'); setCv(h, 0); setRec(h, false);
    hoisted.tick();
    expect(h.readParam('recArm')).toBe(0);
    // rec rising edge → arm.
    ctx.currentTime = 0.025; setRec(h, true);
    hoisted.tick();
    expect(h.readParam('recArm')).toBe(1);
    // next rec rising edge → disarm (drop then re-pulse).
    ctx.currentTime = 0.05; setRec(h, false);
    hoisted.tick();
    ctx.currentTime = 0.075; setRec(h, true);
    hoisted.tick();
    expect(h.readParam('recArm')).toBe(0);
    h.dispose();
  });
});
