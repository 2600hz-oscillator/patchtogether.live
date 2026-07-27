// packages/web/src/lib/audio/engine-gate-dispatch.test.ts
//
// DETERMINISTIC regression coverage for the frame-independent GATE dispatch on
// the cross-domain audio → video CV bridge (PatchEngine.installGateDispatch).
//
// THE BUG THIS PINS (the chronic SHAPEGEN-clock e2e flake, #232):
// `VideoEngine.tickCvBridges` samples ONE analyser sample per VIDEO FRAME. A
// gate pulse is an IMPULSE — the sequencer's clock-out is HIGH for 10 ms, a
// trigger for TRIGGER_PULSE_S = 5 ms — so a frame-rate sampler observes any
// given pulse with probability ≈ pulseWidth / framePeriod. At 60 fps that is
// ~60 %; on a loaded CI runner (measured 19 fps) it is ~19 %. And because both
// the pulse train and rAF are periodic they BEAT: a phase that drops the pulse
// into the gap between two frame samples KEEPS it there, so the consumer's
// counter stalls for SECONDS (measured: 6.7 s of dead air while 13 clock pulses
// fired). No timeout budget can fix an unbounded stall.
//
// WHY THESE TESTS CANNOT FLAKE: there is no wall-clock and no rAF here. The
// AudioContext time, the analyser's sample history, and the scheduler tick are
// all driven by `vi.advanceTimersByTime` through a fake context that
// reconstructs the signal analytically. The decisive case — `pulse that is LOW
// at every single tick instant` — is constructed so that a tail-sampling bridge
// provably observes nothing at all.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AudioEngine, PatchEngine, type DomainEngine } from './engine';
import { registerModule, type AudioModuleDef } from './module-registry';
import { registerVideoModule } from '$lib/video/module-registry';
import {
  getSchedulerClock,
  __resetSchedulerClockForTests,
  SCHEDULER_TICK_MS,
} from './scheduler-clock';
import type { Edge, ModuleNode } from '$lib/graph/types';

const SAMPLE_RATE = 48000;

// ---------------------------------------------------------------------------
// A fake AudioContext whose analyser reconstructs a controllable gate timeline.
// ---------------------------------------------------------------------------

interface FakeClock {
  ctx: AudioContext;
  /** Schedule a HIGH window [startSec, startSec + widthSec). */
  pulse(startSec: number, widthSec: number): void;
  /** Advance BOTH the audio clock and the JS timers by `ms`. */
  advance(ms: number): void;
  nowSec(): number;
}

function makeFakeClock(): FakeClock {
  let now = 0;
  const pulses: Array<[number, number]> = [];
  const high = (t: number): number =>
    pulses.some(([s, e]) => t >= s && t < e) ? 1 : 0;

  const node = () => ({ connect() { /* */ }, disconnect() { /* */ } });

  const ctx = {
    get currentTime() { return now; },
    sampleRate: SAMPLE_RATE,
    createGain() { return { ...node(), gain: { value: 1 } }; },
    createConstantSource() {
      return { ...node(), offset: { value: 0 }, start() { /* */ }, stop() { /* */ } };
    },
    createAnalyser() {
      return {
        ...node(),
        fftSize: 32,
        smoothingTimeConstant: 0,
        // Fill the buffer so index `len-1` is "now" and index 0 is
        // `len-1` samples in the past — the real ring-buffer layout the
        // edge counter's window math assumes.
        getFloatTimeDomainData(buf: Float32Array) {
          const len = buf.length;
          for (let i = 0; i < len; i++) {
            buf[i] = high(now - (len - 1 - i) / SAMPLE_RATE);
          }
        },
      };
    },
  } as unknown as AudioContext;

  return {
    ctx,
    pulse(startSec, widthSec) { pulses.push([startSec, startSec + widthSec]); },
    advance(ms) { now += ms / 1000; vi.advanceTimersByTime(ms); },
    nowSec() { return now; },
  };
}

// ---------------------------------------------------------------------------
// Module defs + a VideoEngine stub that records every setParam write.
// ---------------------------------------------------------------------------

const GATE_SOURCE_DEF: AudioModuleDef = {
  type: 'gateDispatchTestSource',
  domain: 'audio',
  label: 'GateSrc',
  category: 'sources',
  inputs: [],
  outputs: [{ id: 'clock', type: 'gate' }],
  params: [],
  async factory() {
    const n = { connect() { /* */ }, disconnect() { /* */ } };
    return {
      domain: 'audio' as const,
      inputs: new Map(),
      outputs: new Map([['clock', { node: n as unknown as AudioNode, output: 0 }]]),
      setParam() { /* */ },
      readParam() { return undefined; },
      dispose() { /* */ },
    };
  },
};

// Two inputs: `clock_in` is GATE-STYLE (no cvScale → the module edge-detects
// the raw value, SHAPEGEN's contract); `speed_cv` is CONTINUOUS (a cvScale hint
// → the per-frame bridge maps it across the param range).
const VIDEO_TARGET_TYPE = 'gateDispatchTestTarget';
function registerVideoTarget(): void {
  registerVideoModule({
    type: VIDEO_TARGET_TYPE,
    domain: 'video',
    label: 'GateTarget',
    category: 'video',
    inputs: [
      { id: 'clock_in', type: 'cv', paramTarget: 'cv_clock' },
      { id: 'speed_cv', type: 'cv', paramTarget: 'speed', cvScale: { mode: 'bipolar' } },
    ],
    outputs: [{ id: 'out', type: 'video' }],
    params: [
      { id: 'cv_clock', label: 'clk', min: 0, max: 1, defaultValue: 0 },
      { id: 'speed', label: 'speed', min: 0, max: 4, defaultValue: 1 },
    ],
    factory: (() => { throw new Error('not instantiated in this test'); }) as never,
  } as never);
}

class VideoEngineStub implements DomainEngine {
  domain = 'video' as const;
  /** Every (paramId, value) the engine wrote, in order. */
  writes: Array<{ paramId: string; value: number }> = [];
  /** Edge ids handed to the legacy per-frame bridge. */
  frameBridges: string[] = [];
  plainEdges: Edge[] = [];

  setAudioContext(): void { /* */ }

  addCvBridge(edgeId: string): void { this.frameBridges.push(edgeId); }
  removeCvBridge(): void { /* */ }

  resolveTargetParamId(_nodeId: string, portId: string): string {
    return portId === 'clock_in' ? 'cv_clock' : portId === 'speed_cv' ? 'speed' : portId;
  }

  getNodeHandle(_nodeId: string): unknown {
    return {
      setParam: (paramId: string, value: number) => {
        this.writes.push({ paramId, value });
      },
    };
  }

  async addNode(): Promise<void> { /* */ }
  removeNode(): void { /* */ }
  addEdge(e: Edge): void { this.plainEdges.push(e); }
  removeEdge(): void { /* */ }
  setParam(): void { /* */ }
  readParam(): undefined { return undefined; }
  read(): unknown { return undefined; }
  dispose(): void { /* */ }
}

/** Count LOW→HIGH transitions in the recorded write stream for one param —
 *  exactly what the consuming module's hysteresis detector will see. */
function countRisingEdges(
  writes: Array<{ paramId: string; value: number }>,
  paramId: string,
): number {
  let prev = 0;
  let n = 0;
  for (const w of writes) {
    if (w.paramId !== paramId) continue;
    if (prev < 0.5 && w.value >= 0.5) n++;
    prev = w.value;
  }
  return n;
}

let registered = false;
async function setup(targetPortId: string) {
  if (!registered) {
    registerModule(GATE_SOURCE_DEF);
    registerVideoTarget();
    registered = true;
  }
  const clock = makeFakeClock();
  const ae = new AudioEngine(clock.ctx);
  const ve = new VideoEngineStub();
  const pe = new PatchEngine();
  pe.registerDomain(ae);
  pe.registerDomain(ve);

  const srcNode: ModuleNode = {
    id: 'seq', type: 'gateDispatchTestSource', domain: 'audio',
    position: { x: 0, y: 0 }, params: {},
  };
  const dstNode: ModuleNode = {
    id: 'vid', type: VIDEO_TARGET_TYPE, domain: 'video',
    position: { x: 0, y: 0 }, params: {},
  };
  await pe.addNode(srcNode);
  await pe.addNode(dstNode);

  const edge: Edge = {
    id: 'e-clk',
    source: { nodeId: 'seq', portId: 'clock' },
    target: { nodeId: 'vid', portId: targetPortId },
    sourceType: 'gate',
    targetType: 'cv',
  };
  pe.addEdge(edge, 'audio', 'video');
  return { pe, ve, clock, edge };
}

describe('PatchEngine — frame-independent gate dispatch (audio → video)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetSchedulerClockForTests();
  });
  afterEach(() => {
    __resetSchedulerClockForTests();
    vi.useRealTimers();
  });

  it('takes over a GATE source into a GATE-STYLE target (no per-frame bridge)', async () => {
    const { pe, ve } = await setup('clock_in');
    expect(ve.frameBridges, 'gate-style target must NOT use the per-frame sampler').toEqual([]);
    expect(ve.plainEdges, 'must not fall through to single-domain dispatch').toEqual([]);
    pe.dispose();
  });

  it('leaves a CONTINUOUS (cvScale) target on the legacy per-frame bridge', async () => {
    const { pe, ve } = await setup('speed_cv');
    expect(
      ve.frameBridges,
      'a cvScale-hinted target still needs per-frame range mapping',
    ).toContain('e-clk');
    pe.dispose();
  });

  it('THE FIX: a 10 ms pulse that is LOW at every tick instant still fires exactly one rising edge', async () => {
    const { pe, ve, clock } = await setup('clock_in');
    // Settle the first tick so the counter has a baseline.
    clock.advance(SCHEDULER_TICK_MS);
    ve.writes.length = 0;

    // Place a 10 ms pulse strictly INSIDE the gap between two ticks: it starts
    // 5 ms after this tick and ends 10 ms before the next one, so the signal is
    // LOW at every instant the bridge is sampled. A tail-sampling bridge sees
    // 0, 0, 0 … and delivers NOTHING — that is the bug.
    const t = clock.nowSec();
    clock.pulse(t + 0.005, 0.010);
    clock.advance(SCHEDULER_TICK_MS);

    expect(
      countRisingEdges(ve.writes, 'cv_clock'),
      'the elapsed-between-ticks pulse must still be replayed as one rising edge',
    ).toBe(1);
    // And it must SETTLE low again, so the next pulse can rise.
    const last = ve.writes.filter((w) => w.paramId === 'cv_clock').at(-1);
    expect(last?.value, 'must settle back to the current (low) level').toBe(0);
    pe.dispose();
  });

  it('delivers exactly ONE rising edge per pulse over a long train — no drops, no double-counts', async () => {
    const { pe, ve, clock } = await setup('clock_in');
    clock.advance(SCHEDULER_TICK_MS);
    ve.writes.length = 0;

    // 20 pulses at a 130 ms period — deliberately NOT a multiple of the 25 ms
    // tick, so pulses land at every phase relative to the sampler (some inside
    // a tick instant, most between ticks). Exactly 20 edges must arrive.
    const t0 = clock.nowSec() + 0.05;
    for (let i = 0; i < 20; i++) clock.pulse(t0 + i * 0.130, 0.010);
    for (let i = 0; i < 120; i++) clock.advance(SCHEDULER_TICK_MS);

    expect(countRisingEdges(ve.writes, 'cv_clock')).toBe(20);
    pe.dispose();
  });

  it('a HELD gate stays HIGH (level-sensitive consumers keep their level)', async () => {
    const { pe, ve, clock } = await setup('clock_in');
    clock.advance(SCHEDULER_TICK_MS);
    ve.writes.length = 0;

    // One 500 ms gate — a held note, not a trigger.
    clock.pulse(clock.nowSec() + 0.010, 0.500);
    for (let i = 0; i < 8; i++) clock.advance(SCHEDULER_TICK_MS); // ~200 ms in

    expect(countRisingEdges(ve.writes, 'cv_clock'), 'one edge for one gate').toBe(1);
    expect(
      ve.writes.filter((w) => w.paramId === 'cv_clock').at(-1)?.value,
      'still inside the gate → must read HIGH, not a blip',
    ).toBe(1);

    // Run past the end — it must fall.
    for (let i = 0; i < 20; i++) clock.advance(SCHEDULER_TICK_MS);
    expect(
      ve.writes.filter((w) => w.paramId === 'cv_clock').at(-1)?.value,
      'gate released → must read LOW',
    ).toBe(0);
    expect(countRisingEdges(ve.writes, 'cv_clock'), 'still only ONE edge').toBe(1);
    pe.dispose();
  });

  it('writes the level every tick so the target can detect "this input is patched"', async () => {
    const { pe, ve, clock } = await setup('clock_in');
    ve.writes.length = 0;
    clock.advance(SCHEDULER_TICK_MS * 3);
    // SHAPEGEN flips `clockPatched` from the mere fact that setParam is called
    // for cv_clock. A change-only writer would leave it unpatched forever on a
    // clock that has not fired yet.
    expect(ve.writes.filter((w) => w.paramId === 'cv_clock').length).toBeGreaterThanOrEqual(3);
    pe.dispose();
  });

  it('removeEdge unsubscribes the tick (no writes after teardown)', async () => {
    const { pe, ve, clock, edge } = await setup('clock_in');
    clock.advance(SCHEDULER_TICK_MS);
    pe.removeEdge(edge, 'audio');
    ve.writes.length = 0;
    clock.pulse(clock.nowSec() + 0.005, 0.010);
    clock.advance(SCHEDULER_TICK_MS * 4);
    expect(ve.writes, 'a torn-down dispatcher must be silent').toEqual([]);
    pe.dispose();
  });

  it('removeNode unsubscribes the tick even if the edge was never removed', async () => {
    const { pe, ve, clock } = await setup('clock_in');
    clock.advance(SCHEDULER_TICK_MS);
    pe.removeNode({
      id: 'vid', type: VIDEO_TARGET_TYPE, domain: 'video',
      position: { x: 0, y: 0 }, params: {},
    });
    ve.writes.length = 0;
    clock.pulse(clock.nowSec() + 0.005, 0.010);
    clock.advance(SCHEDULER_TICK_MS * 4);
    expect(ve.writes, 'node removal must not leak a scheduler subscription').toEqual([]);
    pe.dispose();
  });
});
