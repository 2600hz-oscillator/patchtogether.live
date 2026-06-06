// packages/web/src/lib/audio/modules/writeseq-alignment.test.ts
//
// THE GATE — the deterministic sample-accurate DRUMMERGIRL alignment test.
//
// With one shared clock driving BOTH a drum DRIVER (DRUMSEQZ — the
// DRUMMERGIRL-family step source) and WRITESEQ, a key-press passed through to
// WRITESEQ IN TIME with the step-1 beat must record onto the SAME step the
// drum hits — NOT off by one in either direction.
//
// Why this is the gate (not ART): WRITESEQ has no DSP render() and an
// OfflineAudioContext doesn't pump the JS scheduler, so the off-by-one proof
// has to drive the REAL factory tick loop against a fake AudioContext with an
// advanceable currentTime + injectable analyser buffers — the proven harness
// from sequencer-reset-dedup.test.ts, copied verbatim below.
//
// Structure of the no-off-by-one guarantee (asserted here):
//   1. SAME edge detector, SAME window, SAME tick: both factories ride the
//      SAME getSchedulerClock tick and scan the SAME shared clock buffer with
//      the identical (lastSample<0.5 && cur>=0.5) edge test over
//      [len-newSamples, len). A pulse that advances the driver to step 0
//      advances WRITESEQ to step 0 on the same tick.
//   2. Record-start jump-to-step-1 + the pulse advance resolve BEFORE the gate
//      is quantized (tick ordering a→b→c).
//   3. Midpoint rounding is symmetric, anchored to the SAME stepStart the
//      pulse set: an on-beat press rounds to the current step, never next.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---- Capture the scheduler-clock tick so we can drive it manually. --------
// CRITICAL: BOTH the drum DRIVER and WRITESEQ subscribe to the SAME shared
// clock, so the mock must hold a SET of subscribers and fan a single
// `hoisted.tick()` out to ALL of them on the SAME tick (the design's fact-1:
// "both ride the SAME getSchedulerClock tick"). A single-slot mock would let
// the later subscriber clobber the earlier one — the drum would never tick.
const hoisted = vi.hoisted(() => {
  const subs = new Set<() => void>();
  return {
    subs,
    tick: () => {
      for (const fn of subs) fn();
    },
  };
});
vi.mock('$lib/audio/scheduler-clock', () => ({
  SCHEDULER_TICK_MS: 25,
  getSchedulerClock: () => ({
    subscribe: (fn: () => void) => {
      hoisted.subs.add(fn);
      return () => {
        hoisted.subs.delete(fn);
      };
    },
    usingWorker: false,
    dispose: () => {},
  }),
}));

import { patch as livePatch } from '$lib/graph/store';

// ---- Minimal fake AudioContext (verbatim sequencer-reset-dedup harness) ----

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

// Count note ONSETS = distinct gate-high (value === 1) scheduling events at
// distinct audio times within [0, untilTime].
function countOnsets(param: FakeParam, untilTime: number): number {
  const times = new Set<number>();
  for (const e of param.events) {
    if (e.value >= 0.5 && e.time <= untilTime + 1e-9) {
      times.add(Number(e.time.toFixed(6)));
    }
  }
  return times.size;
}

// Smallest gap between consecutive distinct gate-high onset times.
function minOnsetGap(param: FakeParam): number {
  const times = Array.from(
    new Set(param.events.filter((e) => e.value >= 0.5).map((e) => Number(e.time.toFixed(6)))),
  ).sort((a, b) => a - b);
  let min = Infinity;
  for (let i = 1; i < times.length; i++) {
    min = Math.min(min, times[i] - times[i - 1]);
  }
  return min;
}

class FakeConstantSource {
  offset = new FakeParam();
  _connectedTo: FakeGain | null = null;
  start() {}
  stop() {}
  connect(node: unknown) {
    if (node instanceof FakeGain) this._connectedTo = node;
  }
  disconnect() {}
}

class FakeGain {
  gain = new FakeParam();
  // The injectable buffer this gain's downstream analyser will surface.
  injected: Float32Array | null = null;
  _analyser: FakeAnalyser | null = null;
  connect(node: unknown) {
    if (node instanceof FakeAnalyser) {
      this._analyser = node;
      node._source = this;
    }
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
    if (buf) {
      // The factory's buffer length must match the analyser fftSize. WRITESEQ's
      // clock-in uses fftSize 16384; the cv/gate/rec taps + transport use 2048.
      // Copy into whatever length the caller passed.
      out.set(buf.subarray(0, out.length));
    } else {
      out.fill(0);
    }
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
  createChannelSplitter() {
    return new FakeGain() as unknown as ChannelSplitterNode;
  }
  createChannelMerger() {
    return new FakeGain() as unknown as ChannelMergerNode;
  }
}

// Build a square pulse buffer with a single rising edge near the end so the
// tick's "samples since last poll" window sees exactly one new edge. The
// length must match the consuming analyser's fftSize (16384 for the clock-in
// taps; both DRUMSEQZ + WRITESEQ widen their clock-in here).
function pulseBuffer(len: number): Float32Array {
  const b = new Float32Array(len);
  for (let i = len - 64; i < len; i++) b[i] = 1;
  return b;
}
function zeroBuffer(len: number): Float32Array {
  return new Float32Array(len);
}

// Import AFTER the mocks are registered.
import { drumseqzDef } from './drumseqz';
import { writeseqDef } from './writeseq';
import { midiToVOct } from '$lib/audio/note-entry';

const DRUM_ID = 'drum1';
const WSEQ_ID = 'wseq1';
const LENGTH = 16;

function clearPatch() {
  for (const k of Object.keys(livePatch.nodes)) delete livePatch.nodes[k];
  for (const k of Object.keys(livePatch.edges)) delete livePatch.edges[k];
}

// Seed both modules with a clock-input edge present so BOTH take the external-
// clock branch. The edge's source node is irrelevant (the factory only checks
// connectivity); we point both clock inputs at a notional shared clock source.
function seedPatch() {
  clearPatch();
  // DRUMSEQZ driver: track1 step-1 on (every other step off), 16 steps.
  const ON = { on: true, midi: null };
  const OFF = { on: false, midi: null };
  const track1 = Array.from({ length: 128 }, (_, i) => (i === 0 ? ON : OFF));
  const offTrack = Array.from({ length: 128 }, () => OFF);
  livePatch.nodes[DRUM_ID] = {
    id: DRUM_ID,
    type: 'drumseqz',
    domain: 'audio',
    position: { x: 0, y: 0 },
    params: { bpm: 120, length: LENGTH, isPlaying: 1, gateLength: 0.5, octave: 0, swing: 0 },
    data: { tracks: [track1, offTrack, offTrack, offTrack] },
  } as never;
  // WRITESEQ: armed + playing, 16 steps.
  livePatch.nodes[WSEQ_ID] = {
    id: WSEQ_ID,
    type: 'writeseq',
    domain: 'audio',
    position: { x: 0, y: 0 },
    params: { bpm: 120, length: LENGTH, isPlaying: 1, gateLength: 0.5, octave: 0, recArm: 1, overdub: 0 },
    data: { steps: [] },
  } as never;
  // Clock-input edges so both take the external-clock branch.
  livePatch.edges['e-clk-drum'] = {
    id: 'e-clk-drum',
    source: { nodeId: 'clk', portId: 'clock' },
    target: { nodeId: DRUM_ID, portId: 'clock' },
  } as never;
  livePatch.edges['e-clk-wseq'] = {
    id: 'e-clk-wseq',
    source: { nodeId: 'clk', portId: 'clock' },
    target: { nodeId: WSEQ_ID, portId: 'clock' },
  } as never;
}

async function spawnBoth(ctx: FakeAudioContext): Promise<{ drum: AudioNodeHandleLike; wseq: AudioNodeHandleLike }> {
  const drum = (await drumseqzDef.factory(
    ctx as unknown as AudioContext,
    { id: DRUM_ID, type: 'drumseqz', params: livePatch.nodes[DRUM_ID]!.params } as never,
  )) as unknown as AudioNodeHandleLike;
  const wseq = (await writeseqDef.factory(
    ctx as unknown as AudioContext,
    { id: WSEQ_ID, type: 'writeseq', params: livePatch.nodes[WSEQ_ID]!.params } as never,
  )) as unknown as AudioNodeHandleLike;
  return { drum, wseq };
}

// Inject the SAME clock pulse into both modules' clock-in on the SAME tick,
// plus (optionally) a gate pulse + fixed pitch CV into WRITESEQ, then pump the
// shared tick once. fftSize for clock-in is 16384 (DRUMSEQZ uses 2048 — feed
// the right length per analyser by reading each gain's analyser fftSize).
function injectClockPulse(drum: AudioNodeHandleLike, wseq: AudioNodeHandleLike, pulse: boolean) {
  const drumClock = drum.inputs.get('clock')!.node as unknown as FakeGain;
  const wseqClock = wseq.inputs.get('clock')!.node as unknown as FakeGain;
  const drumLen = (drumClock._analyser?.fftSize ?? 2048);
  const wseqLen = (wseqClock._analyser?.fftSize ?? 16384);
  drumClock.injected = pulse ? pulseBuffer(drumLen) : zeroBuffer(drumLen);
  wseqClock.injected = pulse ? pulseBuffer(wseqLen) : zeroBuffer(wseqLen);
}

interface AudioNodeHandleLike {
  inputs: Map<string, { node: AudioNode }>;
  outputs: Map<string, { node: AudioNode }>;
  read(key: string): unknown;
  dispose(): void;
}

function setWseqGate(wseq: AudioNodeHandleLike, high: boolean) {
  const g = wseq.inputs.get('gate')!.node as unknown as FakeGain;
  const len = g._analyser?.fftSize ?? 2048;
  g.injected = high ? pulseBuffer(len) : zeroBuffer(len);
}
function setWseqCv(wseq: AudioNodeHandleLike, vOct: number) {
  const c = wseq.inputs.get('cv')!.node as unknown as FakeGain;
  const len = c._analyser?.fftSize ?? 2048;
  // A constant CV: fill the whole buffer with vOct so latestSample reads it.
  const b = new Float32Array(len);
  b.fill(vOct);
  c.injected = b;
}

describe('WRITESEQ alignment: shared clock with a drum DRIVER (no off-by-one)', () => {
  beforeEach(() => {
    hoisted.subs.clear();
    clearPatch();
  });

  it('records a key IN TIME with the step-1 beat onto the SAME step the drum hits (step 0)', async () => {
    seedPatch();
    const ctx = new FakeAudioContext();
    const { drum, wseq } = await spawnBoth(ctx);
    // Both factories subscribed to the SAME shared clock.
    expect(hoisted.subs.size).toBe(2);

    const drumGate = (drum.outputs.get('gate1')!.node as unknown as FakeConstantSource).offset as unknown as FakeParam;
    const wseqGateOut = (wseq.outputs.get('gate')!.node as unknown as FakeConstantSource).offset as unknown as FakeParam;

    // Tick 0 @ t=0: no pulse yet (lets both factories latch run-start / record).
    ctx.currentTime = 0;
    injectClockPulse(drum, wseq, false);
    setWseqGate(wseq, false);
    setWseqCv(wseq, 0);
    hoisted.tick!();

    // Tick 1 @ t=0.025: the SHARED clock pulse + a key in time (gate rising +
    // fixed pitch CV = 0V = C4 = MIDI 60). Same scan window as the pulse.
    ctx.currentTime = 0.025;
    injectClockPulse(drum, wseq, true);
    setWseqGate(wseq, true);
    setWseqCv(wseq, midiToVOct(60)); // 0V
    hoisted.tick!();

    // Advance ctx a step (25ms) WITHOUT new pulses so the playhead trackers
    // surface the just-emitted step (emit was scheduled at t+0.005).
    ctx.currentTime = 0.05;
    injectClockPulse(drum, wseq, false);
    setWseqGate(wseq, false); // gate released
    hoisted.tick!();

    // ── Driver: step 0 hit. currentStep === 0 (the drum's playhead) AND the
    //    drum's gate1 ConstantSource scheduled exactly ONE onset (sample-locked
    //    to the pulse). The analyser-tapped gateValue:0 read isn't usable on the
    //    fake ctx (the gate src connects to an analyser, not an injectable gain,
    //    so it surfaces the JS-bookkeeping fallback) — the FakeParam onset is
    //    the unambiguous sample-accurate measure the design specifies. ──
    expect(drum.read('currentStep')).toBe(0);
    expect(countOnsets(drumGate, ctx.currentTime + 0.01)).toBe(1);

    // ── WRITESEQ: recorded the SAME step (step 0), NOT step 1 or 127. ──
    const steps = (livePatch.nodes[WSEQ_ID]!.data as { steps: Array<{ on: boolean; midi: number | null }> }).steps;
    expect(steps[0]).toEqual({ on: true, midi: 60 });
    expect(steps[1]?.on ?? false).toBe(false);
    expect(steps[127]?.on ?? false).toBe(false);

    // lastRecordedStep + currentStep match the driver (both step 0).
    expect(wseq.read('lastRecordedStep')).toBe(0);
    expect(wseq.read('currentStep')).toBe(0);

    // Exactly one onset on WRITESEQ's gate-out — no double-hit.
    expect(countOnsets(wseqGateOut, ctx.currentTime + 0.01)).toBe(1);
    // (single onset → minOnsetGap is Infinity; just assert no sub-step double.)
    const gap = minOnsetGap(wseqGateOut);
    expect(gap === Infinity || gap > 0.05).toBe(true);

    drum.dispose();
    wseq.dispose();
  });

  it('a gate a hair EARLY (just before the pulse-step start) still records step 0', async () => {
    seedPatch();
    const ctx = new FakeAudioContext();
    const { wseq } = await spawnBoth(ctx);

    // Warm-up tick.
    ctx.currentTime = 0;
    setWseqGate(wseq, false);
    setWseqCv(wseq, midiToVOct(60));
    hoisted.tick!();

    // Pulse tick: the gate is in the SAME window as the pulse (on-beat). The
    // emit is scheduled a hair AHEAD (t+0.005), so the press (t) is "early"
    // relative to the step start — must still round to step 0.
    const drumNode = livePatch.nodes[DRUM_ID]!;
    // Spawn drum implicitly already; just drive WRITESEQ's clock + gate.
    const wseqClock = wseq.inputs.get('clock')!.node as unknown as FakeGain;
    const wseqGate = wseq.inputs.get('gate')!.node as unknown as FakeGain;
    ctx.currentTime = 0.025;
    wseqClock.injected = pulseBuffer(wseqClock._analyser?.fftSize ?? 16384);
    wseqGate.injected = pulseBuffer(wseqGate._analyser?.fftSize ?? 2048);
    setWseqCv(wseq, midiToVOct(60));
    hoisted.tick!();
    void drumNode;

    const steps = (livePatch.nodes[WSEQ_ID]!.data as { steps: Array<{ on: boolean }> }).steps;
    expect(steps[0]?.on).toBe(true);
    expect(steps[1]?.on ?? false).toBe(false);
    expect(wseq.read('lastRecordedStep')).toBe(0);
    wseq.dispose();
  });

  it('a gate PAST the step midpoint (no coinciding pulse) records the NEXT step (quantizer is live)', async () => {
    seedPatch();
    const ctx = new FakeAudioContext();
    const { wseq } = await spawnBoth(ctx);
    const wseqClock = wseq.inputs.get('clock')!.node as unknown as FakeGain;
    const wseqGate = wseq.inputs.get('gate')!.node as unknown as FakeGain;
    const clkLen = wseqClock._analyser?.fftSize ?? 16384;
    const gateLen = wseqGate._analyser?.fftSize ?? 2048;

    // Warm-up.
    ctx.currentTime = 0;
    wseqClock.injected = zeroBuffer(clkLen);
    wseqGate.injected = zeroBuffer(gateLen);
    setWseqCv(wseq, midiToVOct(64));
    hoisted.tick!();

    // Pulse @ t=0.025 → emit step 0 (scheduled at 0.03), advance to step 1.
    ctx.currentTime = 0.025;
    wseqClock.injected = pulseBuffer(clkLen);
    wseqGate.injected = zeroBuffer(gateLen);
    hoisted.tick!();

    // No pulse; advance well PAST the step midpoint of step 0 (stepDur = 0.125;
    // midpoint ≈ 0.03 + 0.0625 = 0.0925). Press at t = 0.11 (past midpoint) →
    // rounds to step 1.
    ctx.currentTime = 0.11;
    wseqClock.injected = zeroBuffer(clkLen);
    wseqGate.injected = pulseBuffer(gateLen);
    setWseqCv(wseq, midiToVOct(64));
    hoisted.tick!();

    expect(wseq.read('lastRecordedStep')).toBe(1);
    const steps = (livePatch.nodes[WSEQ_ID]!.data as { steps: Array<{ on: boolean; midi: number | null }> }).steps;
    expect(steps[1]).toEqual({ on: true, midi: 64 });
    wseq.dispose();
  });
});
