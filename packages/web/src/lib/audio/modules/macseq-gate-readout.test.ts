// packages/web/src/lib/audio/modules/macseq-gate-readout.test.ts
//
// MACSEQ's `gateValue` READOUT must report the state the ENGINE holds.
//
// `read('gateValue')` is backed by `lastEmittedGate`, and the card, the face
// and the e2e all read it as "is a note sounding right now". It used to be
// written ONLY inside emitStep — every ON step set it to 1, every OFF step set
// it to 0 — while the three TRANSPORT paths that force the gate low (stop,
// start-reanchor, reset_cv) wrote `gateSrc.offset` directly and left the mirror
// untouched. Stop the sequencer on an ON step and the readout kept reporting a
// HIGH gate the engine was no longer holding, indefinitely.
//
// That is the same class as a card whose control declares a range its def
// forbids: a surface asserting something about the engine that the engine does
// not agree with, invisible to every gate that reads only one of the two.
//
// ⚠ EVERY LEG HERE IS PAIRED WITH ITS OPPOSITE, on purpose. A fix that simply
// hard-wired the readout to 0 would satisfy "reads 0 after stop" and be just as
// wrong, so each stop/reset leg is preceded by an assertion that the readout
// reads 1 while a note IS sounding. Those "reads 1" legs are the permanent
// negative control — they run on every invocation, not once at authoring time.

import { describe, it, expect, beforeEach, vi } from 'vitest';

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
import { macseqDef } from './macseq';

// ---- fake Web Audio (advanceable currentTime; recorded param events) ----
interface SchedEvent {
  value: number;
  time: number;
}
class FakeParam {
  value = 0;
  events: SchedEvent[] = [];
  setValueAtTime(v: number, t: number) {
    this.events.push({ value: v, time: t });
    this.value = v;
    return this;
  }
  cancelScheduledValues(fromTime: number) {
    this.events = this.events.filter((e) => e.time < fromTime);
    return this;
  }
  linearRampToValueAtTime(v: number, t: number) {
    this.events.push({ value: v, time: t });
    this.value = v;
    return this;
  }
  setTargetAtTime(v: number) {
    this.value = v;
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
  analysers: FakeAnalyser[] = [];
  createConstantSource() {
    return new FakeConstantSource() as unknown as ConstantSourceNode;
  }
  createGain() {
    return new FakeGain() as unknown as GainNode;
  }
  createAnalyser() {
    const a = new FakeAnalyser();
    this.analysers.push(a);
    return a as unknown as AnalyserNode;
  }
  createChannelSplitter() {
    return new FakeGain() as unknown as ChannelSplitterNode;
  }
  createChannelMerger() {
    return new FakeGain() as unknown as ChannelMergerNode;
  }
}

const NODE_ID = 'macseqgate1';

/** Every step ON, so the readout is 1 on every advance and a stop can never be
 *  confused with "the playhead simply reached a rest". */
function allOnSteps(n = 4) {
  return Array.from({ length: n }, (_, i) => ({ on: true, midi: 60 + i, model: null }));
}

function clearPatch() {
  for (const k of Object.keys(livePatch.nodes)) delete livePatch.nodes[k];
  for (const k of Object.keys(livePatch.edges)) delete livePatch.edges[k];
}

function seed() {
  clearPatch();
  const steps = allOnSteps();
  livePatch.nodes[NODE_ID] = {
    id: NODE_ID,
    type: 'macseq',
    domain: 'audio',
    position: { x: 0, y: 0 },
    params: { bpm: 120, length: steps.length, isPlaying: 1, octave: 0, gateLength: 0.5 },
    data: { steps },
  } as never;
}

async function build(ctx: FakeAudioContext) {
  return macseqDef.factory(
    ctx as unknown as AudioContext,
    { id: NODE_ID, type: 'macseq', params: livePatch.nodes[NODE_ID]!.params } as never,
  );
}

function run(ctx: FakeAudioContext, fromS: number, toS: number, tickMs = 0.025) {
  for (let t = fromS; t < toS; t += tickMs) {
    ctx.currentTime = t;
    hoisted.tick!();
  }
}

/** What the ENGINE holds: the value of the last gate event scheduled at or
 *  before `at`. This is deliberately read off the recorded AudioParam events
 *  rather than off the module's own mirror — a readout can only be checked
 *  against the engine by asking the engine, never by asking the readout. */
function engineGateAt(handle: Awaited<ReturnType<typeof build>>, at: number): number {
  const p = (handle.outputs.get('gate')!.node as unknown as FakeConstantSource)
    .offset as unknown as FakeParam;
  let value = 0;
  let best = -Infinity;
  for (const e of p.events) {
    if (e.time <= at && e.time >= best) {
      best = e.time;
      value = e.value;
    }
  }
  return value;
}

/** Tick forward until the ENGINE's gate is high, and report where. Reads the
 *  engine rather than the readout on purpose: a readout stuck HIGH must not be
 *  allowed to pick the instant at which it is then checked. */
function advanceUntilEngineGateHigh(
  ctx: FakeAudioContext,
  h: Awaited<ReturnType<typeof build>>,
  limitS: number,
  stepMs = 0.005,
): { found: boolean; at: number } {
  for (let t = 0; t < limitS; t += stepMs) {
    ctx.currentTime = t;
    hoisted.tick!();
    if (engineGateAt(h, t) === 1) return { found: true, at: t };
  }
  return { found: false, at: limitS };
}

/** Step the clock through [fromS, toS) and, at EVERY instant, compare the
 *  readout against what the engine holds at that same instant. Returns the set
 *  of readout values seen so the caller can prove the probe was not just
 *  watching a constant. */
function sweepAgreement(
  ctx: FakeAudioContext,
  h: Awaited<ReturnType<typeof build>>,
  fromS: number,
  toS: number,
  // Deliberately NOT a multiple of the 25 ms tick or the 125 ms step: an even
  // sampling lag against a periodic gate can alias onto one phase and report a
  // constant. 7 ms is co-prime with both.
  stepMs = 0.007,
): { seen: Set<number>; samples: number } {
  const seen = new Set<number>();
  let samples = 0;
  for (let t = fromS; t < toS; t += stepMs) {
    ctx.currentTime = t;
    hoisted.tick!();
    const readout = h.read!('gateValue') as number;
    const engine = engineGateAt(h, t);
    expect(
      readout,
      `readout ${readout} vs engine ${engine} at t=${t.toFixed(3)}s (units: seconds of AudioContext time)`,
    ).toBe(engine);
    seen.add(readout);
    samples++;
  }
  return { seen, samples };
}

beforeEach(() => {
  hoisted.tick = null;
  clearPatch();
});

describe('macseq: the gateValue readout agrees with the engine', () => {
  it('agrees at every sampled instant while PLAYING — and both values occur', async () => {
    seed();
    const ctx = new FakeAudioContext();
    const h = await build(ctx);

    const { seen, samples } = sweepAgreement(ctx, h, 0, 1.0);

    // PERMANENT NEGATIVE CONTROL, run on every invocation rather than once at
    // authoring time: a readout hard-wired to either constant would satisfy
    // "agrees with the engine" only if the engine were also constant, so prove
    // the window actually contained both a gate-high and a gate-low.
    expect(samples, 'the sweep actually sampled').toBeGreaterThan(100);
    expect([...seen].sort(), `both gate states occurred in the window; saw ${[...seen]}`)
      .toEqual([0, 1]);
  });

  it('STOP mid-note drops the readout with the gate (not just the gate)', async () => {
    seed();
    const ctx = new FakeAudioContext();
    const h = await build(ctx);

    // Run until a note is genuinely sounding *in the engine*, so the stop below
    // is mid-note rather than mid-rest — otherwise the assertion is vacuous.
    // The search predicate reads the ENGINE, not the readout: using the readout
    // here would let a readout that is stuck HIGH choose its own start point.
    const sounding = advanceUntilEngineGateHigh(ctx, h, 1.0);
    expect(sounding.found, 'the engine gated high somewhere in the first second').toBe(true);
    expect(engineGateAt(h, sounding.at), 'and it is still high at that instant').toBe(1);
    const soundingAt = sounding.at;

    // Press STOP.
    livePatch.nodes[NODE_ID]!.params!.isPlaying = 0;
    ctx.currentTime = soundingAt + 0.005;
    hoisted.tick!();

    expect(engineGateAt(h, ctx.currentTime), 'the ENGINE has dropped the gate').toBe(0);
    expect(
      h.read!('gateValue'),
      'the READOUT must report the state the engine holds, not the last step it scheduled',
    ).toBe(0);

    // …and it must STAY down while stopped, rather than being a one-tick blip.
    for (let t = ctx.currentTime + 0.025; t < soundingAt + 0.6; t += 0.025) {
      ctx.currentTime = t;
      hoisted.tick!();
      expect(h.read!('gateValue'), `still low while stopped at t=${t.toFixed(3)}s`).toBe(0);
    }
  });

  it('re-STARTing raises it again, so the fix is not a hard-wired zero', async () => {
    seed();
    const ctx = new FakeAudioContext();
    const h = await build(ctx);

    run(ctx, 0, 0.3);
    livePatch.nodes[NODE_ID]!.params!.isPlaying = 0;
    ctx.currentTime = 0.3;
    hoisted.tick!();
    expect(h.read!('gateValue'), 'low while stopped').toBe(0);

    livePatch.nodes[NODE_ID]!.params!.isPlaying = 1;
    const { seen } = sweepAgreement(ctx, h, 0.325, 1.2);
    expect(seen.has(1), 'the readout came back up after re-starting').toBe(true);
  });

  it('a reset_cv edge re-anchors the gate AND the readout together', async () => {
    seed();
    // reset_cv patched so the transport-CV drain has a live edge to find.
    livePatch.edges['e_reset'] = {
      id: 'e_reset',
      source: { nodeId: 'srcrst', portId: 'out' },
      target: { nodeId: NODE_ID, portId: 'reset_cv' },
    } as never;

    const ctx = new FakeAudioContext();
    const h = await build(ctx);

    // Advance to an instant where the ENGINE is holding the gate high.
    const sounding = advanceUntilEngineGateHigh(ctx, h, 1.0);
    expect(sounding.found, 'a note is sounding before the reset').toBe(true);
    const soundingAt = sounding.at;

    // Drive a rising edge onto reset_cv's analyser tap.
    const resetGain = h.inputs.get('reset_cv')!.node as unknown as FakeGain;
    const buf = new Float32Array(2048);
    for (let i = 1024; i < 2048; i++) buf[i] = 1;
    resetGain.injected = buf;
    ctx.currentTime = soundingAt + 0.005;
    hoisted.tick!();
    resetGain.injected = null;

    // The reset CANCELS the engine's queued gate future. The readout must have
    // dropped its own queued future in the same breath — this is the leg that
    // a plain "clear the mirror" fix cannot pass, because the same tick's
    // lookahead re-raises the mirror for a step 200 ms away.
    expect(engineGateAt(h, ctx.currentTime), 'the ENGINE re-anchored the gate low').toBe(0);
    expect(h.read!('gateValue'), 'and so did the readout').toBe(0);
  });
});
