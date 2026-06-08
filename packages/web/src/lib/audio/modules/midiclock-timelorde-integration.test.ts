// packages/web/src/lib/audio/modules/midiclock-timelorde-integration.test.ts
//
// Integration coverage for the canonical MIDI-slave wiring:
//   MIDICLOCK.midistart → TIMELORDE.start_in
//   MIDICLOCK.midistop  → TIMELORDE.stop_in
//
// The piece this test pins is the BRIDGE between the two factory layers —
// the seam where the per-unit tests in midiclock-factory.test.ts and
// timelorde.test.ts agree on contract but the wire between them might
// silently drop. We simulate the engine-side connect() by funneling
// MIDICLOCK's ConstantSourceNode-style offset automation straight into
// TIMELORDE's AnalyserNode buffer (the analyser is the rising-edge tap
// TIMELORDE polls every 25ms).
//
// What we DON'T test here: real Web Audio scheduling timing. That's
// browser-only and out of scope for vitest. What we DO test is that
// once a pulse-shaped waveform lands in TIMELORDE's analyser buffer
// after the wire is "made," TIMELORDE's poll detects the rising edge
// and flips `running`. The synthetic waveform mirrors EXACTLY what
// MIDICLOCK's pulse() helper produces (setValueAtTime(1, t) →
// setValueAtTime(0, t + GATE_PULSE_S)) rendered onto a 48 kHz buffer.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { midiclockDef, GATE_PULSE_S } from './midiclock';
import { timelordeDef } from './timelorde';
import { patch as livePatch } from '$lib/graph/store';
import type { ModuleNode } from '$lib/graph/types';
import type {
  MidiAccessLike,
  MidiEventLike,
  MidiInputLike,
} from './midi-cv-buddy';

// ---------------- Shared mock plumbing ----------------

interface AutomationEvent {
  kind: 'cancel' | 'set';
  value?: number;
  time: number;
}

interface FakeAudioParam {
  value: number;
  setValueAtTime: (v: number, t: number) => void;
  cancelScheduledValues: (t: number) => void;
  events: AutomationEvent[];
}

function makeParam(initial = 0): FakeAudioParam {
  const events: AutomationEvent[] = [];
  const p: FakeAudioParam = {
    value: initial,
    setValueAtTime(v, t) {
      p.value = v;
      events.push({ kind: 'set', value: v, time: t });
    },
    cancelScheduledValues(t) {
      events.push({ kind: 'cancel', time: t });
    },
    events,
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

class FakeAnalyserNode {
  // buf is (re)sized off fftSize whenever the factory assigns it, so this
  // mock tracks the real widened ring (16384) the production factory now
  // requests for the start_in/stop_in edge detectors rather than a
  // hard-coded 2048. The production scan reads the LAST `newSamples` of the
  // ring, so the mock buffer width must match or pushed edges land outside
  // the scanned window.
  smoothingTimeConstant = 0;
  buf: Float32Array = new Float32Array(2048);
  connect = vi.fn();
  disconnect = vi.fn();
  #fftSize = 2048;
  get fftSize(): number {
    return this.#fftSize;
  }
  set fftSize(n: number) {
    this.#fftSize = n;
    this.buf = new Float32Array(n);
  }
  getFloatTimeDomainData(out: Float32Array): void {
    out.set(this.buf);
  }
  pushSamples(samples: ArrayLike<number>): void {
    const n = samples.length;
    if (n >= this.buf.length) {
      const offset = n - this.buf.length;
      for (let i = 0; i < this.buf.length; i++) this.buf[i] = samples[offset + i] ?? 0;
      return;
    }
    this.buf.copyWithin(0, n);
    for (let i = 0; i < n; i++) {
      this.buf[this.buf.length - n + i] = samples[i] ?? 0;
    }
  }
}

class FakeGainNode {
  gain = makeParam(1);
  connect = vi.fn();
  disconnect = vi.fn();
}

class FakeAudioWorkletNode {
  parameters: { get: (k: string) => FakeAudioParam | undefined };
  port = { onmessage: null as unknown, postMessage: vi.fn(), close: vi.fn() };
  disconnect = vi.fn();
  _paramMap: Map<string, FakeAudioParam>;
  constructor() {
    this._paramMap = new Map([
      ['bpm', makeParam(120)],
      ['swingAmount', makeParam(0)],
      ['swingSource', makeParam(0)],
      ['muteOutputs', makeParam(0)],
      ['running', makeParam(1)],
      ['hasExternalClock', makeParam(0)],
    ]);
    this.parameters = { get: (k) => this._paramMap.get(k) };
  }
}

// In-memory scheduler-clock for the TIMELORDE factory.
const fakeSchedulerSubs: Array<() => void> = [];
vi.mock('$lib/audio/scheduler-clock', () => ({
  getSchedulerClock: () => ({
    subscribe(cb: () => void) {
      fakeSchedulerSubs.push(cb);
      return () => {
        const i = fakeSchedulerSubs.indexOf(cb);
        if (i >= 0) fakeSchedulerSubs.splice(i, 1);
      };
    },
  }),
  SCHEDULER_TICK_MS: 25,
}));
vi.mock('@patchtogether.live/dsp/dist/timelorde.js?url', () => ({ default: 'timelorde.js' }));

interface SharedAudioCtx {
  currentTime: number;
  sampleRate: number;
  audioWorklet: { addModule: (u: string) => Promise<void> };
  createGain: () => FakeGainNode;
  createAnalyser: () => FakeAnalyserNode;
  createConstantSource: () => FakeConstantSourceNode;
}
function makeMockCtx(): SharedAudioCtx {
  return {
    currentTime: 0,
    sampleRate: 48000,
    audioWorklet: { addModule: vi.fn(async () => {}) },
    createGain: () => new FakeGainNode(),
    createAnalyser: () => new FakeAnalyserNode(),
    createConstantSource: () => new FakeConstantSourceNode(),
  };
}

function makeMidiInput(id: string): MidiInputLike & { fire: (ev: MidiEventLike) => void } {
  let handler: ((ev: MidiEventLike) => void) | null = null;
  return {
    id,
    name: id,
    state: 'connected',
    get onmidimessage() { return handler; },
    set onmidimessage(fn) { handler = fn as ((ev: MidiEventLike) => void) | null; },
    fire(ev) { if (handler) handler(ev); },
  };
}

function makeMidiAccess(...inputs: ReturnType<typeof makeMidiInput>[]): MidiAccessLike {
  const map = new Map<string, MidiInputLike>();
  for (const i of inputs) map.set(i.id, i);
  return { inputs: map, onstatechange: null };
}

function installFakeMidi(access: MidiAccessLike): () => void {
  const nav = (globalThis as unknown as { navigator?: Record<string, unknown> }).navigator;
  const orig = nav?.requestMIDIAccess;
  if (!nav) {
    (globalThis as unknown as { navigator?: Record<string, unknown> }).navigator = {
      requestMIDIAccess: vi.fn(async () => access),
    };
  } else {
    nav.requestMIDIAccess = vi.fn(async () => access);
  }
  return () => {
    const n = (globalThis as unknown as { navigator?: Record<string, unknown> }).navigator;
    if (n && orig === undefined) delete n.requestMIDIAccess;
    else if (n) n.requestMIDIAccess = orig;
  };
}

/**
 * Render the MIDICLOCK output ConstantSource's offset automation onto a
 * sample-rate buffer. Mirrors what a real Web Audio implementation would
 * produce: the value is the LAST setValueAtTime <= sampleTime (ignoring
 * cancels for now — we only test forward-going single-pulse sequences,
 * which the factory's pulse() helper produces).
 *
 * Returns the rendered samples; the test then pushes them into TIMELORDE's
 * analyser ring buffer to simulate the engine wiring `startSrc.connect(
 * startGain)` → `startGain.connect(startAna)`.
 */
function renderPulseBuffer(
  events: AutomationEvent[],
  fromTime: number,
  toTime: number,
  sampleRate: number,
): number[] {
  // Only "set" events define the value timeline; the factory uses cancels
  // BEFORE each set to clear any prior schedules, which doesn't change the
  // forward-going value.
  const sets = events.filter((e) => e.kind === 'set');
  const startSample = Math.floor(fromTime * sampleRate);
  const endSample = Math.floor(toTime * sampleRate);
  const n = Math.max(0, endSample - startSample);
  const out: number[] = new Array(n).fill(0);
  // Find the value live at fromTime to seed the buffer.
  let live = 0;
  for (const e of sets) {
    if (e.time <= fromTime) live = e.value ?? 0;
  }
  out[0] = live;
  let cursor = 0;
  for (const e of sets) {
    if (e.time < fromTime || e.time > toTime) continue;
    const eSample = Math.floor(e.time * sampleRate) - startSample;
    // Hold the current value up to eSample, then flip to e.value at eSample.
    for (let i = cursor; i < eSample && i < n; i++) out[i] = live;
    if (eSample >= 0 && eSample < n) out[eSample] = e.value ?? 0;
    live = e.value ?? 0;
    cursor = Math.max(cursor, eSample + 1);
  }
  for (let i = cursor; i < n; i++) out[i] = live;
  return out;
}

function tickAllSchedulers(): void {
  for (const cb of [...fakeSchedulerSubs]) cb();
}

function makeTimelordeNode(): ModuleNode {
  return {
    id: 'tl-1',
    type: 'timelorde',
    domain: 'audio',
    position: { x: 0, y: 0 },
    params: { running: 0, muteOutputs: 0 },
    data: {},
  };
}

function makeMidiclockNode(): ModuleNode {
  return {
    id: 'mc-1',
    type: 'midiclock',
    domain: 'audio',
    position: { x: 0, y: 0 },
    params: {},
    data: {},
  };
}

// ---------------- Tests ----------------

describe('MIDICLOCK → TIMELORDE start/stop bridge integration', () => {
  beforeEach(() => {
    fakeSchedulerSubs.length = 0;
    for (const k of Object.keys(livePatch.nodes)) delete livePatch.nodes[k];
    livePatch.nodes['tl-1'] = {
      id: 'tl-1',
      type: 'timelorde',
      domain: 'audio',
      position: { x: 0, y: 0 },
      params: { running: 0, muteOutputs: 0 },
      data: {},
    } as ModuleNode;
    (globalThis as unknown as { AudioWorkletNode: typeof FakeAudioWorkletNode }).AudioWorkletNode =
      FakeAudioWorkletNode;
  });

  it('0xFA → MIDICLOCK pulses midistart → TIMELORDE.running flips 0 → 1', async () => {
    // Pin the canonical MIDI-slave start path end-to-end: a real MIDI
    // Start byte arrives at MIDICLOCK, the factory emits a pulse on
    // its midistart output, the engine routes that to TIMELORDE's
    // start_in analyser, the next scheduler tick observes the rising
    // edge and TIMELORDE writes running ← 1 in both the AudioParam and
    // the patch store. Pre-fix this test would catch a gap anywhere in
    // the chain.
    //
    // Timing note: MIDICLOCK's schedAt() projects event.timeStamp onto
    // the audio clock with TIMESTAMP_LOOKAHEAD_S (25 ms) of slack so
    // Web Audio never schedules in the past. We honor that lookahead
    // here by rendering the pulse window AFTER ctx.currentTime advances
    // past the scheduled fire-time.
    const ctx = makeMockCtx();
    const input = makeMidiInput('test-port');
    const access = makeMidiAccess(input);
    const restoreMidi = installFakeMidi(access);
    const mcHandle = await midiclockDef.factory(
      ctx as unknown as AudioContext,
      makeMidiclockNode(),
    );
    const tlHandle = await timelordeDef.factory(
      ctx as unknown as AudioContext,
      makeTimelordeNode(),
    );
    try {
      const api = mcHandle.read?.('card-api') as { connect: () => Promise<boolean> };
      await api.connect();

      // Drain the post-attach scheduler tick (the factory subscribes
      // immediately so the very first tick scans a zero-elapsed window).
      tickAllSchedulers();

      // Fire 0xFA at ctx.currentTime = 0. schedAt() projects this to
      // t ≈ 0 + LOOKAHEAD (0.025 s) — actual value depends on the
      // bogus-timestamp branch (perf.now()'s test-env lag is huge so the
      // lookahead floor wins). pulse(startSrc, t) records cancel/set/set
      // events at t and t + GATE_PULSE_S.
      input.fire({ data: new Uint8Array([0xfa]), timeStamp: 0 });

      const midistartOut = mcHandle.outputs.get('midistart')!;
      const startSrc = midistartOut.node as unknown as FakeConstantSourceNode;
      const setHigh = startSrc.offset.events.find(
        (e) => e.kind === 'set' && e.value === 1,
      );
      expect(setHigh, 'MIDICLOCK recorded a midistart pulse').toBeDefined();
      const pulseStart = setHigh!.time;

      // Advance audio time past the pulse so the window we render
      // CONTAINS the pulse + a small lead-in so the rising edge sits
      // INSIDE the window (a window starting AT pulseStart already
      // shows value=1 at sample 0, with no 0→1 transition to detect).
      // 1 sample of lead-in is enough for the detector.
      const oneSample = 1 / ctx.sampleRate;
      const windowStart = pulseStart - oneSample;
      const windowEnd = pulseStart + 0.025;
      ctx.currentTime = windowEnd;
      const samples = renderPulseBuffer(
        startSrc.offset.events,
        windowStart,
        windowEnd,
        ctx.sampleRate,
      );
      // Sanity: the rendered window MUST contain the rising edge,
      // otherwise the detector has nothing to detect and this test
      // pins the wrong contract.
      const hasRisingEdge = samples.some((v, i) => i > 0 && samples[i - 1]! < 0.5 && v >= 0.5);
      expect(hasRisingEdge, 'rendered window contains the 0→1 transition').toBe(true);

      const startGain = tlHandle.inputs.get('start_in')!.node as unknown as FakeGainNode;
      const startAna = startGain.connect.mock.calls[0]?.[0] as FakeAnalyserNode;
      expect(startAna, 'TIMELORDE start_in gain connected to its analyser').toBeDefined();
      startAna.pushSamples(samples);

      tickAllSchedulers();

      expect(
        livePatch.nodes['tl-1']!.params.running,
        'TIMELORDE.running flipped to 1 after MIDI Start',
      ).toBe(1);
      expect(
        livePatch.nodes['tl-1']!.params.muteOutputs,
        'muteOutputs untouched (transport ≠ mute)',
      ).toBe(0);
      expect(tlHandle.read?.('running')).toBe(1);
    } finally {
      restoreMidi();
      mcHandle.dispose();
      tlHandle.dispose();
    }
  });

  it('0xFC → MIDICLOCK pulses midistop → TIMELORDE.running flips 1 → 0', async () => {
    // Pre-condition: TIMELORDE running=1, then a MIDI Stop fires and
    // the same chain runs in reverse, halting the clock without
    // touching muteOutputs.
    const ctx = makeMockCtx();
    const input = makeMidiInput('test-port');
    const access = makeMidiAccess(input);
    const restoreMidi = installFakeMidi(access);
    livePatch.nodes['tl-1']!.params.running = 1;
    const mcHandle = await midiclockDef.factory(
      ctx as unknown as AudioContext,
      makeMidiclockNode(),
    );
    const tlHandle = await timelordeDef.factory(
      ctx as unknown as AudioContext,
      { ...makeTimelordeNode(), params: { running: 1, muteOutputs: 0 } },
    );
    try {
      const api = mcHandle.read?.('card-api') as { connect: () => Promise<boolean> };
      await api.connect();

      tickAllSchedulers();

      input.fire({ data: new Uint8Array([0xfc]), timeStamp: 0 });

      const midistopOut = mcHandle.outputs.get('midistop')!;
      const stopSrc = midistopOut.node as unknown as FakeConstantSourceNode;
      const setHigh = stopSrc.offset.events.find(
        (e) => e.kind === 'set' && e.value === 1,
      );
      expect(setHigh, 'MIDICLOCK recorded a midistop pulse').toBeDefined();
      const pulseStart = setHigh!.time;
      const oneSample = 1 / ctx.sampleRate;
      const windowStart = pulseStart - oneSample;
      const windowEnd = pulseStart + 0.025;
      ctx.currentTime = windowEnd;
      const samples = renderPulseBuffer(
        stopSrc.offset.events,
        windowStart,
        windowEnd,
        ctx.sampleRate,
      );

      const stopGain = tlHandle.inputs.get('stop_in')!.node as unknown as FakeGainNode;
      const stopAna = stopGain.connect.mock.calls[0]?.[0] as FakeAnalyserNode;
      stopAna.pushSamples(samples);

      tickAllSchedulers();

      expect(livePatch.nodes['tl-1']!.params.running, 'running halted to 0').toBe(0);
      expect(livePatch.nodes['tl-1']!.params.muteOutputs, 'muteOutputs untouched').toBe(0);
      expect(tlHandle.read?.('running')).toBe(0);
    } finally {
      restoreMidi();
      mcHandle.dispose();
      tlHandle.dispose();
    }
  });

  it('full DAW-transport sequence: Start → Stop → Start flips running 0→1→0→1', async () => {
    // The user's reproduction shape — hit Play on the DAW, then Stop,
    // then Play again — should produce a faithful running ← 1 → 0 → 1
    // trajectory on TIMELORDE. Pre-fix, the user reported NONE of these
    // transitions landing.
    const ctx = makeMockCtx();
    const input = makeMidiInput('test-port');
    const access = makeMidiAccess(input);
    const restoreMidi = installFakeMidi(access);
    const mcHandle = await midiclockDef.factory(
      ctx as unknown as AudioContext,
      makeMidiclockNode(),
    );
    const tlHandle = await timelordeDef.factory(
      ctx as unknown as AudioContext,
      makeTimelordeNode(),
    );
    try {
      const api = mcHandle.read?.('card-api') as { connect: () => Promise<boolean> };
      await api.connect();

      tickAllSchedulers();

      const midistartOut = mcHandle.outputs.get('midistart')!.node as unknown as FakeConstantSourceNode;
      const midistopOut = mcHandle.outputs.get('midistop')!.node as unknown as FakeConstantSourceNode;
      const startGain = tlHandle.inputs.get('start_in')!.node as unknown as FakeGainNode;
      const stopGain = tlHandle.inputs.get('stop_in')!.node as unknown as FakeGainNode;
      const startAna = startGain.connect.mock.calls[0]?.[0] as FakeAnalyserNode;
      const stopAna = stopGain.connect.mock.calls[0]?.[0] as FakeAnalyserNode;

      // Helper: fire a MIDI event, render the resulting pulse onto the
      // analyser, advance the audio clock past the lookahead window, and
      // tick the scheduler. Each phase is independent — the helper makes
      // the order explicit so it's hard to silently miss a window.
      function pumpPhase(byte: number, srcNode: FakeConstantSourceNode, ana: FakeAnalyserNode, silentAna: FakeAnalyserNode): void {
        const eventsBefore = srcNode.offset.events.length;
        input.fire({ data: new Uint8Array([byte]), timeStamp: 0 });
        const newEvents = srcNode.offset.events.slice(eventsBefore);
        const setHigh = newEvents.find((e) => e.kind === 'set' && e.value === 1);
        expect(setHigh, `MIDI byte 0x${byte.toString(16)} recorded a pulse`).toBeDefined();
        const pulseStart = setHigh!.time;
        const oneSample = 1 / ctx.sampleRate;
        const windowStart = pulseStart - oneSample;
        const windowEnd = pulseStart + 0.025;
        ctx.currentTime = windowEnd;
        ana.pushSamples(renderPulseBuffer(newEvents, windowStart, windowEnd, ctx.sampleRate));
        // Flush the OTHER analyser's ENTIRE ring with silence to keep its
        // cross-tick detector state honest (so a trailing pulse from a
        // previous phase isn't still sitting in the ring to be re-counted).
        // Sized off the ring width (now 16384, ~341 ms @ 48 kHz) rather than
        // a fixed 1200 so a wider ring is still fully cleared — a fixed-1200
        // flush only zeroes the tail and leaves a stale pulse mid-ring.
        silentAna.pushSamples(new Array(silentAna.buf.length).fill(0));
        tickAllSchedulers();
      }

      // Trial 1 — Play.
      pumpPhase(0xfa, midistartOut, startAna, stopAna);
      expect(livePatch.nodes['tl-1']!.params.running, 'after Start: running=1').toBe(1);

      // Trial 2 — Stop.
      pumpPhase(0xfc, midistopOut, stopAna, startAna);
      expect(livePatch.nodes['tl-1']!.params.running, 'after Stop: running=0').toBe(0);

      // Trial 3 — Play again (musical position is preserved at the
      // worklet, but here we only assert the running flag).
      pumpPhase(0xfa, midistartOut, startAna, stopAna);
      expect(livePatch.nodes['tl-1']!.params.running, 'after Resume: running=1').toBe(1);
    } finally {
      restoreMidi();
      mcHandle.dispose();
      tlHandle.dispose();
    }
  });
});
