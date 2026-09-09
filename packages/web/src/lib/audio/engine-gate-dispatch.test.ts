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
import {
  getSchedulerClock,
  __resetSchedulerClockForTests,
  SCHEDULER_TICK_MS,
} from './scheduler-clock';
import { GATE_EDGE_WORKLET_SOURCE } from './gate-edge-worklet';
import type { Edge, ModuleNode } from '$lib/graph/types';

// LEAK-PROOFING: this file needs a synthetic VIDEO module def visible to
// `engine.ts`'s `getVideoModuleDef` lookup. Registering it into the REAL
// registry would mutate process-wide state that registry-SWEEPING tests
// (contract-lock, module-docs-lint, the card-map gate) enumerate — safe today
// only because vitest isolates files, i.e. safe by accident. Instead we overlay
// the lookup for THIS FILE'S module graph only: the real registry is never
// written, so the def cannot leak even if file isolation were disabled.
const SYNTHETIC_VIDEO_DEFS = new Map<string, unknown>();
vi.mock('$lib/video/module-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/video/module-registry')>();
  return {
    ...actual,
    getVideoModuleDef: (type: string) =>
      SYNTHETIC_VIDEO_DEFS.get(type) ?? actual.getVideoModuleDef(type as never),
  };
});

const SAMPLE_RATE = 48000;
/** Render-quantum size — the block the worklet processor is fed. */
const RENDER_QUANTUM = 128;

// ---------------------------------------------------------------------------
// A fake AudioContext whose analyser reconstructs a controllable gate timeline.
// ---------------------------------------------------------------------------

interface FakeClock {
  ctx: AudioContext;
  /** Schedule a HIGH window [startSec, startSec + widthSec). */
  pulse(startSec: number, widthSec: number): void;
  /** Advance BOTH the audio clock and the JS timers by `ms`. */
  advance(ms: number): void;
  /**
   * Advance ONLY the audio thread: the render quanta are produced and the
   * worklet keeps counting, but the MAIN THREAD is frozen — no scheduler
   * ticks run and no port messages are delivered. This is the CI pathology
   * (a renderer preempted for hundreds of ms) reproduced deterministically.
   */
  stallMainThread(ms: number): void;
  nowSec(): number;
  /** Install the fake AudioWorkletNode global bound to THIS clock. */
  enableWorklet(): void;
  /** Replace the 0/1 pulse timeline with an arbitrary CONTINUOUS signal —
   *  an LFO's ±1 sine, the shape a user patches into DELAY CLK. */
  wave(fn: (tSec: number) => number): void;
}

function makeFakeClock(): FakeClock {
  let now = 0;
  let fedUntil = 0;
  const pulses: Array<[number, number]> = [];
  let waveFn: ((tSec: number) => number) | null = null;
  const high = (t: number): number =>
    waveFn ? waveFn(t) : pulses.some(([s, e]) => t >= s && t < e) ? 1 : 0;

  const node = () => ({ connect() { /* */ }, disconnect() { /* */ } });

  /** Live worklet taps: each gets every render quantum. */
  const taps: Array<(block: Float32Array) => void> = [];
  /** Messages produced by the audio thread, awaiting main-thread delivery. */
  let pendingDeliveries: Array<() => void> = [];

  /** Produce whole render quanta up to `now` and feed every worklet tap. The
   *  AudioWorkletGlobalScope globals the processor reads (`currentTime` = the
   *  block's start, `sampleRate`) are set per block, exactly as the real scope
   *  would present them. */
  function pumpAudio(): void {
    const quantumSec = RENDER_QUANTUM / SAMPLE_RATE;
    const g = globalThis as unknown as { currentTime?: number; sampleRate?: number };
    g.sampleRate = SAMPLE_RATE;
    while (taps.length > 0 && fedUntil + quantumSec <= now) {
      const ch = new Float32Array(RENDER_QUANTUM);
      for (let i = 0; i < RENDER_QUANTUM; i++) ch[i] = high(fedUntil + i / SAMPLE_RATE);
      g.currentTime = fedUntil;
      for (const t of taps) t(ch);
      fedUntil += quantumSec;
    }
    if (taps.length === 0) fedUntil = now;
  }

  /** Main thread runs: hand every queued port message to its listener. */
  function deliverMessages(): void {
    const q = pendingDeliveries;
    pendingDeliveries = [];
    for (const d of q) d();
  }

  const ctx = {
    get currentTime() { return now; },
    sampleRate: SAMPLE_RATE,
    destination: { } as unknown as AudioDestinationNode,
    audioWorklet: { addModule: async () => { /* the fake node is the module */ } },
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

  /** Instantiate the REAL shipped worklet source as an audio-thread processor. */
  function spawnProcessor(post: (m: unknown) => void): (block: Float32Array) => void {
    let Ctor: (new () => { process(inputs: Float32Array[][]): boolean }) | undefined;
    const g = globalThis as unknown as Record<string, unknown>;
    const prevBase = g.AudioWorkletProcessor;
    const prevReg = g.registerProcessor;
    g.AudioWorkletProcessor = class { port = { postMessage: post }; };
    g.registerProcessor = (_n: string, c: unknown) => {
      Ctor = c as new () => { process(inputs: Float32Array[][]): boolean };
    };
    try {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
      new Function(GATE_EDGE_WORKLET_SOURCE)();
    } finally {
      g.AudioWorkletProcessor = prevBase;
      g.registerProcessor = prevReg;
    }
    const proc = new Ctor!();
    return (block) => { proc.process([[block]]); };
  }

  return {
    ctx,
    pulse(startSec, widthSec) { pulses.push([startSec, startSec + widthSec]); },
    advance(ms) {
      now += ms / 1000;
      pumpAudio();
      deliverMessages();
      vi.advanceTimersByTime(ms);
    },
    stallMainThread(ms) {
      // Audio thread keeps rendering; main thread does NOT run.
      now += ms / 1000;
      pumpAudio();
    },
    nowSec() { return now; },
    wave(fn) { waveFn = fn; },
    enableWorklet() {
      const g = globalThis as unknown as Record<string, unknown>;
      // `ensureGateEdgeWorklet` builds a blob: URL; node's URL has no
      // createObjectURL, so shim just enough for the registration path.
      const u = g.URL as { createObjectURL?: unknown; revokeObjectURL?: unknown };
      if (typeof u.createObjectURL !== 'function') {
        u.createObjectURL = () => 'blob:gate-edge-test';
        u.revokeObjectURL = () => { /* */ };
      }
      g.AudioWorkletNode = class {
        port: { onmessage: ((e: MessageEvent) => void) | null; close(): void } = {
          onmessage: null,
          close: () => { /* */ },
        };
        private tap: (block: Float32Array) => void;
        constructor() {
          // Messages are QUEUED, not delivered inline — they only reach the
          // main thread when the main thread actually runs (advance()).
          this.tap = spawnProcessor((m) => {
            pendingDeliveries.push(() => {
              this.port.onmessage?.({ data: m } as MessageEvent);
            });
          });
          taps.push(this.tap);
        }
        connect() { /* */ }
        disconnect() {
          const i = taps.indexOf(this.tap);
          if (i >= 0) taps.splice(i, 1);
        }
      };
    },
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

/** A CV source — an LFO's phase output, the cable a user makes by patching an
 *  LFO or an envelope straight into a clock/trigger input. */
const CV_SOURCE_DEF: AudioModuleDef = {
  type: 'gateDispatchTestCvSource',
  domain: 'audio',
  label: 'CvSrc',
  category: 'sources',
  inputs: [],
  outputs: [{ id: 'phase', type: 'cv' }],
  params: [],
  async factory() {
    const n = { connect() { /* */ }, disconnect() { /* */ } };
    return {
      domain: 'audio' as const,
      inputs: new Map(),
      outputs: new Map([['phase', { node: n as unknown as AudioNode, output: 0 }]]),
      setParam() { /* */ },
      readParam() { return undefined; },
      dispose() { /* */ },
    };
  },
};

// Four inputs, one per branch of the dispatch predicate:
//  - `clock_in`  GATE-STYLE, NO `edge` declared (no cvScale → the module
//                edge-detects the raw value, SHAPEGEN's contract — and the exact
//                shape of DOOM's cv_<port> family, doom.ts `inputs`);
//  - `trig_in`   `edge: 'trigger'` (BACKDRAFT's delay_clock, verbatim shape);
//  - `level_in`  `edge: 'gate'` (a level-sensitive consumer, FREEZEFRAME's
//                gate_in shape);
//  - `speed_cv`  CONTINUOUS (a cvScale hint → the per-frame bridge maps it
//                across the param range).
const VIDEO_TARGET_TYPE = 'gateDispatchTestTarget';
function registerVideoTarget(): void {
  // Into the FILE-LOCAL overlay (see the vi.mock above) — never the real
  // registry, so registry-sweeping tests cannot see this synthetic def.
  SYNTHETIC_VIDEO_DEFS.set(VIDEO_TARGET_TYPE, {
    type: VIDEO_TARGET_TYPE,
    domain: 'video',
    label: 'GateTarget',
    category: 'video',
    inputs: [
      { id: 'clock_in', type: 'cv', paramTarget: 'cv_clock' },
      { id: 'trig_in', type: 'cv', edge: 'trigger', paramTarget: 'cv_trig' },
      { id: 'level_in', type: 'cv', edge: 'gate', paramTarget: 'cv_level' },
      { id: 'speed_cv', type: 'cv', paramTarget: 'speed', cvScale: { mode: 'bipolar' } },
    ],
    outputs: [{ id: 'out', type: 'video' }],
    params: [
      { id: 'cv_clock', label: 'clk', min: 0, max: 1, defaultValue: 0 },
      { id: 'cv_trig', label: 'trig', min: 0, max: 1, defaultValue: 0 },
      { id: 'cv_level', label: 'lvl', min: 0, max: 1, defaultValue: 0 },
      { id: 'speed', label: 'speed', min: 0, max: 4, defaultValue: 1 },
    ],
    factory: () => { throw new Error('not instantiated in this test'); },
  });
}

const TARGET_PARAM_BY_PORT: Record<string, string> = {
  clock_in: 'cv_clock',
  trig_in: 'cv_trig',
  level_in: 'cv_level',
  speed_cv: 'speed',
};

class VideoEngineStub implements DomainEngine {
  domain = 'video' as const;
  /** Every (paramId, value) the engine wrote, in order, stamped with the fake
   *  audio clock at the moment of the write (the module's own timestamp). */
  writes: Array<{ paramId: string; value: number; atSec: number }> = [];
  /** Edge ids handed to the legacy per-frame bridge. */
  frameBridges: string[] = [];
  plainEdges: Edge[] = [];

  constructor(private readonly nowSec: () => number = () => 0) {}

  setAudioContext(): void { /* */ }

  addCvBridge(edgeId: string): void { this.frameBridges.push(edgeId); }
  removeCvBridge(): void { /* */ }

  resolveTargetParamId(_nodeId: string, portId: string): string {
    return TARGET_PARAM_BY_PORT[portId] ?? portId;
  }

  getNodeHandle(_nodeId: string): unknown {
    return {
      setParam: (paramId: string, value: number) => {
        this.writes.push({ paramId, value, atSec: this.nowSec() });
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

/** Rising-edge write times (sec) for one param — the instants the consuming
 *  module would timestamp its rises, i.e. what BACKDRAFT's period comes from. */
function risingEdgeTimes(
  writes: Array<{ paramId: string; value: number; atSec: number }>,
  paramId: string,
): number[] {
  let prev = 0;
  const out: number[] = [];
  for (const w of writes) {
    if (w.paramId !== paramId) continue;
    if (prev < 0.5 && w.value >= 0.5) out.push(w.atSec);
    prev = w.value;
  }
  return out;
}

let registered = false;
async function setup(
  targetPortId: string,
  opts: { worklet?: boolean; source?: 'gate' | 'cv' } = {},
) {
  if (!registered) {
    registerModule(GATE_SOURCE_DEF);
    registerModule(CV_SOURCE_DEF);
    registerVideoTarget();
    registered = true;
  }
  const source = opts.source ?? 'gate';
  const clock = makeFakeClock();
  if (opts.worklet) clock.enableWorklet();
  const ae = new AudioEngine(clock.ctx);
  const ve = new VideoEngineStub(() => clock.nowSec());
  const pe = new PatchEngine();
  pe.registerDomain(ae);
  pe.registerDomain(ve);

  const srcNode: ModuleNode = {
    id: 'seq',
    type: source === 'gate' ? 'gateDispatchTestSource' : 'gateDispatchTestCvSource',
    domain: 'audio',
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
    source: { nodeId: 'seq', portId: source === 'gate' ? 'clock' : 'phase' },
    target: { nodeId: 'vid', portId: targetPortId },
    sourceType: source,
    targetType: 'cv',
  };
  pe.addEdge(edge, 'audio', 'video');
  // `installGateDispatch` registers + constructs the worklet across a few
  // microtasks (addModule is async). Drain them so the dispatcher is live
  // before the test drives the clock. Microtasks are NOT faked by
  // vi.useFakeTimers, so this is deterministic.
  for (let i = 0; i < 8; i++) await Promise.resolve();
  return { pe, ve, clock, edge };
}

/**
 * PATCH-TIME variant of `setup`: the source is ALREADY RUNNING `wave` when the
 * cable lands, the worklet is available, and — unlike `setup` — the worklet's
 * registration microtasks are NOT drained here. They resolve when the test
 * next awaits (see `tickAndDrain`), so the analyser fail-safe takes the first
 * tick and the worklet takes over at the second: the handoff happens mid-run,
 * at a known tick, against whatever phase of `wave` that lands on.
 */
async function setupWithWave(
  targetPortId: string,
  wave: (tSec: number) => number,
  source: 'gate' | 'cv' = 'cv',
) {
  if (!registered) {
    registerModule(GATE_SOURCE_DEF);
    registerModule(CV_SOURCE_DEF);
    registerVideoTarget();
    registered = true;
  }
  const clock = makeFakeClock();
  clock.enableWorklet();
  clock.wave(wave);
  const ae = new AudioEngine(clock.ctx);
  const ve = new VideoEngineStub(() => clock.nowSec());
  const pe = new PatchEngine();
  pe.registerDomain(ae);
  pe.registerDomain(ve);
  await pe.addNode({
    id: 'seq',
    type: source === 'gate' ? 'gateDispatchTestSource' : 'gateDispatchTestCvSource',
    domain: 'audio',
    position: { x: 0, y: 0 }, params: {},
  });
  await pe.addNode({
    id: 'vid', type: VIDEO_TARGET_TYPE, domain: 'video',
    position: { x: 0, y: 0 }, params: {},
  });
  const edge: Edge = {
    id: 'e-clk',
    source: { nodeId: 'seq', portId: source === 'gate' ? 'clock' : 'phase' },
    target: { nodeId: 'vid', portId: targetPortId },
    sourceType: source,
    targetType: 'cv',
  };
  pe.addEdge(edge, 'audio', 'video');
  return { pe, ve, clock, edge };
}

/** One scheduler tick, then let pending microtasks (the worklet registration
 *  chain) resolve — the shape a real main thread has between two ticks. */
async function tickAndDrain(clock: FakeClock): Promise<void> {
  clock.advance(SCHEDULER_TICK_MS);
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

describe('PatchEngine — frame-independent gate dispatch (audio → video)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetSchedulerClockForTests();
    // ESTABLISH the precondition, do not INHERIT it. Every test in this
    // describe is about the MAIN-THREAD fail-safe, which is selected by
    // `ensureGateEdgeWorklet` declining — and it declines because no
    // `AudioWorkletNode` global exists. That was left to whatever the process
    // happened to be carrying: vitest shares one process per worker across
    // files, and `mandelbulb.test.ts` installed a fake and never removed it,
    // so when the lane put the two in the same worker this suite quietly ran
    // the WORKLET path and asserted 0 edges against the wrong implementation.
    //
    // The leak is fixed at its source too, but this line is the durable half:
    // a suite whose subject is "the path taken when X is absent" must make X
    // absent itself, or it is only ever testing the last file to run.
    delete (globalThis as unknown as Record<string, unknown>).AudioWorkletNode;
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

// ---------------------------------------------------------------------------
// The AUDIO-THREAD path — what actually ships when a worklet is available.
// ---------------------------------------------------------------------------
//
// The suite above drives the main-thread AnalyserNode FAIL-SAFE (the fake ctx
// there has no audioWorklet, so `ensureGateEdgeWorklet` declines and the bridge
// degrades to `createEdgeCounter`). These tests enable a fake AudioWorkletNode
// that runs the REAL shipped worklet source over the same analytic signal, and
// pin the property the fail-safe CANNOT provide: survival across a main-thread
// stall longer than any possible AnalyserNode window.

describe('PatchEngine — gate dispatch on the AUDIO-THREAD counter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetSchedulerClockForTests();
  });
  afterEach(() => {
    __resetSchedulerClockForTests();
    vi.useRealTimers();
    delete (globalThis as unknown as Record<string, unknown>).AudioWorkletNode;
  });

  it('takes the worklet path when the context can host one', async () => {
    const { pe, ve, clock } = await setup('clock_in', { worklet: true });
    clock.advance(SCHEDULER_TICK_MS);
    ve.writes.length = 0;
    clock.pulse(clock.nowSec() + 0.005, 0.010);
    clock.advance(SCHEDULER_TICK_MS * 2);
    expect(countRisingEdges(ve.writes, 'cv_clock'), 'one pulse → one edge').toBe(1);
    pe.dispose();
  });

  // ---- THE CI REGRESSION ------------------------------------------------
  it('THE CI BUG: edges that fire during a 2 s MAIN-THREAD STALL are ALL delivered on resume', async () => {
    const { pe, ve, clock } = await setup('clock_in', { worklet: true });
    clock.advance(SCHEDULER_TICK_MS);
    ve.writes.length = 0;

    // Four 10 ms pulses spread over a 2 SECOND window in which the main thread
    // never runs — no scheduler tick, no port delivery. The audio thread keeps
    // rendering throughout.
    //
    // 2 s is 2.9x the LARGEST window an AnalyserNode can hold (fftSize 32768 =
    // 683 ms @ 48 kHz), so a main-thread reader physically cannot recover these
    // — the samples are gone from the ring. Measured max poll gap on the real
    // CI-faithful repro was 1626 ms, which is why the analyser-based first fix
    // shipped red. The audio-thread total is accumulated BEHIND the stall.
    const t = clock.nowSec();
    for (let i = 0; i < 4; i++) clock.pulse(t + 0.2 + i * 0.45, 0.010);
    clock.stallMainThread(2000);

    expect(ve.writes, 'main thread was frozen — nothing can have been written yet').toEqual([]);

    // Main thread resumes.
    clock.advance(SCHEDULER_TICK_MS);
    expect(
      countRisingEdges(ve.writes, 'cv_clock'),
      'every edge accumulated during the stall must arrive — none dropped',
    ).toBe(4);
    pe.dispose();
  });

  it('a stall spanning MANY pulses still delivers exactly one edge per pulse', async () => {
    const { pe, ve, clock } = await setup('clock_in', { worklet: true });
    clock.advance(SCHEDULER_TICK_MS);
    ve.writes.length = 0;

    const t = clock.nowSec();
    for (let i = 0; i < 12; i++) clock.pulse(t + 0.1 + i * 0.25, 0.010);
    clock.stallMainThread(3200);
    clock.advance(SCHEDULER_TICK_MS);

    expect(countRisingEdges(ve.writes, 'cv_clock'), 'exact, not approximate').toBe(12);
    pe.dispose();
  });

  // ---- PROOF 2: no double-counting --------------------------------------
  it('PROOF 2: a known pulse train over a known interval counts EXACTLY, tick after tick', async () => {
    const { pe, ve, clock } = await setup('clock_in', { worklet: true });
    clock.advance(SCHEDULER_TICK_MS);
    ve.writes.length = 0;

    // 20 pulses at a 130 ms period — deliberately NOT a multiple of the 25 ms
    // tick, so pulses land at every phase relative to the tick. An
    // off-by-one-per-tick defect (the NUMPAD+/HYDROGEN/ATLANTIS-CATALYST bug
    // class: re-scanning the overlap region) would report far more than 20.
    const t0 = clock.nowSec() + 0.05;
    for (let i = 0; i < 20; i++) clock.pulse(t0 + i * 0.130, 0.010);
    for (let i = 0; i < 130; i++) clock.advance(SCHEDULER_TICK_MS);

    expect(
      countRisingEdges(ve.writes, 'cv_clock'),
      'exactly 20 — never 19 (a drop), never 21+ (a re-count)',
    ).toBe(20);
    pe.dispose();
  });

  it('PROOF 2: many ticks with NO pulse produce ZERO edges', async () => {
    const { pe, ve, clock } = await setup('clock_in', { worklet: true });
    clock.advance(SCHEDULER_TICK_MS);
    ve.writes.length = 0;
    for (let i = 0; i < 200; i++) clock.advance(SCHEDULER_TICK_MS);
    expect(
      countRisingEdges(ve.writes, 'cv_clock'),
      'a quiet gate must not manufacture edges (per-tick off-by-one control)',
    ).toBe(0);
    pe.dispose();
  });

  // ---- PROOF 1: held gates survive --------------------------------------
  it('PROOF 1: a gate held across MANY ticks reads HIGH CONTINUOUSLY — every write, not just the last', async () => {
    const { pe, ve, clock } = await setup('clock_in', { worklet: true });
    clock.advance(SCHEDULER_TICK_MS);
    ve.writes.length = 0;

    // A 1 s held gate — an ADSR sustain / VCA hold / DOOM key-down, NOT a
    // trigger. The repo standard: "Do NOT convert a gate consumer to
    // edge-only." Level-sensitive consumers read the LEVEL.
    const t = clock.nowSec();
    clock.pulse(t + 0.010, 1.000);
    clock.advance(SCHEDULER_TICK_MS * 2); // get inside the gate

    const insideStart = ve.writes.length;
    // ~30 ticks (750 ms) strictly INSIDE the held window.
    for (let i = 0; i < 30; i++) clock.advance(SCHEDULER_TICK_MS);
    const insideWrites = ve.writes.slice(insideStart).filter((w) => w.paramId === 'cv_clock');

    expect(insideWrites.length, 'the bridge must keep writing while held').toBeGreaterThanOrEqual(25);
    expect(
      insideWrites.every((w) => w.value === 1),
      `EVERY write inside the hold must be HIGH — no blip, no chatter `
      + `(saw ${JSON.stringify(insideWrites.slice(0, 12).map((w) => w.value))})`,
    ).toBe(true);
    expect(
      countRisingEdges(ve.writes, 'cv_clock'),
      'a held gate is ONE edge, not one per tick',
    ).toBe(1);

    // ---- release must land ----
    for (let i = 0; i < 20; i++) clock.advance(SCHEDULER_TICK_MS);
    const afterRelease = ve.writes.filter((w) => w.paramId === 'cv_clock').slice(-10);
    expect(
      afterRelease.every((w) => w.value === 0),
      'after release every write must read LOW',
    ).toBe(true);
    expect(countRisingEdges(ve.writes, 'cv_clock'), 'release adds no rising edge').toBe(1);
    pe.dispose();
  });

  it('PROOF 1: a gate still held when the main thread resumes from a stall reads HIGH', async () => {
    const { pe, ve, clock } = await setup('clock_in', { worklet: true });
    clock.advance(SCHEDULER_TICK_MS);
    ve.writes.length = 0;

    clock.pulse(clock.nowSec() + 0.100, 3.000); // long hold
    clock.stallMainThread(1500);                // stall STARTS before, ENDS inside
    clock.advance(SCHEDULER_TICK_MS);

    expect(countRisingEdges(ve.writes, 'cv_clock'), 'the rise still arrives').toBe(1);
    expect(
      ve.writes.filter((w) => w.paramId === 'cv_clock').at(-1)?.value,
      'still inside the hold → must settle HIGH, not LOW',
    ).toBe(1);
    pe.dispose();
  });

  it('teardown removes the worklet tap (silent after removeEdge)', async () => {
    const { pe, ve, clock, edge } = await setup('clock_in', { worklet: true });
    clock.advance(SCHEDULER_TICK_MS);
    pe.removeEdge(edge, 'audio');
    ve.writes.length = 0;
    clock.pulse(clock.nowSec() + 0.005, 0.010);
    clock.advance(SCHEDULER_TICK_MS * 4);
    expect(ve.writes, 'a torn-down worklet dispatcher must be silent').toEqual([]);
    pe.dispose();
  });
});

// ---------------------------------------------------------------------------
// THE DELAY CLK WIDEN (2026-09-09, owner-approved): a CV cable into a target
// that declares `edge: 'trigger'` is dispatched too.
// ---------------------------------------------------------------------------
//
// BACKDRAFT's `delay_clock` is `{ type: 'cv', edge: 'trigger' }` and its docs
// promised the rising edge "is detected as the value arrives from the patch
// bridge rather than sampled once per rendered frame, so … the lock does not
// depend on how fast the renderer is running". Before the widen that was true
// ONLY for a `gate` cable: the dispatch declined every `cv` source on its first
// line, so an LFO patched into DELAY CLK — the ordinary user gesture — fell to
// `tickCvBridges`, ONE analyser tail sample per VIDEO FRAME. A 4 Hz ±1 sine is
// above the rise threshold for 29.5 % of its cycle (73.8 ms of 250), narrower
// than one frame gap at SwiftShader's measured ~8 fps, which is the 2:1 Nyquist
// singularity: simulated at a steady 8.00 fps, ZERO edges in 30 s; at 7.9 fps,
// 253 ms one moment and 4430 ms the next.
//
// The predicate now keys on the TARGET's declared semantics as well as the
// source cable. Every other branch is pinned UNCHANGED below — in particular the
// no-`edge` raw-passthrough shape, which is DOOM's cv_<port> family.

const LFO_HZ = 4;
/** Where a ±1 sine first crosses GATE_HI (0.5) upward: sin(2π·f·t) = 0.5 at
 *  2π·f·t = π/6 → t = 1/(12·f). Derived, so a threshold change moves it. */
const FIRST_RISE_SEC = 1 / (12 * LFO_HZ);
const LFO_PERIOD_SEC = 1 / LFO_HZ;

describe('PatchEngine — a CV cable into an `edge: \'trigger\'` target (the DELAY CLK widen)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetSchedulerClockForTests();
    delete (globalThis as unknown as Record<string, unknown>).AudioWorkletNode;
  });
  afterEach(() => {
    __resetSchedulerClockForTests();
    vi.useRealTimers();
    delete (globalThis as unknown as Record<string, unknown>).AudioWorkletNode;
  });

  it('a cv source into an `edge: \'trigger\'` target takes the dispatch, not the per-frame sampler', async () => {
    const { pe, ve } = await setup('trig_in', { source: 'cv' });
    expect(ve.frameBridges, 'a trigger-edge target must NOT be tail-sampled per frame').toEqual([]);
    expect(ve.plainEdges, 'must not fall through to single-domain dispatch').toEqual([]);
    pe.dispose();
  });

  it('CONTROL — a cv source into a raw-passthrough target with NO `edge` declared (DOOM\'s cv_<port> shape) stays on the per-frame bridge', async () => {
    // `{ id, type: 'cv', paramTarget }` and nothing else is exactly how
    // doom.ts declares every movement/fire/cheat input (doom.ts `inputs`). The
    // widen keys on a DECLARED `edge: 'trigger'`, so this shape is structurally
    // untouched — pinned here so a later "just drop the edge check" cannot
    // silently pull DOOM onto the counted path.
    const { pe, ve } = await setup('clock_in', { source: 'cv' });
    expect(ve.frameBridges, 'an undeclared-edge cv target keeps the legacy sampler').toContain('e-clk');
    pe.dispose();
  });

  it('CONTROL — a cv source into an `edge: \'gate\'` (level-sensitive) target stays on the per-frame bridge', async () => {
    const { pe, ve } = await setup('level_in', { source: 'cv' });
    expect(ve.frameBridges, 'a level consumer reads a LEVEL; it is not converted to edge-only').toContain('e-clk');
    pe.dispose();
  });

  it('CONTROL — a cv source into a CONTINUOUS (cvScale) target stays on the per-frame bridge', async () => {
    const { pe, ve } = await setup('speed_cv', { source: 'cv' });
    expect(ve.frameBridges, 'a cvScale-hinted target still needs per-frame range mapping').toContain('e-clk');
    pe.dispose();
  });

  it('a GATE source into an `edge: \'trigger\'` target is dispatched exactly as before', async () => {
    const { pe, ve } = await setup('trig_in', { source: 'gate' });
    expect(ve.frameBridges).toEqual([]);
    expect(ve.plainEdges).toEqual([]);
    pe.dispose();
  });

  for (const worklet of [false, true]) {
    const path = worklet ? 'AUDIO-THREAD counter' : 'main-thread fail-safe';

    it(`THE DEFECT (${path}): a 4 Hz LFO sine delivers exactly one rising edge per cycle with no frame ever sampled`, async () => {
      const { pe, ve, clock } = await setup('trig_in', { source: 'cv', worklet });
      clock.advance(SCHEDULER_TICK_MS);
      ve.writes.length = 0;

      // A ±1 sine starting at phase 0 from NOW — LFO defaults (shape 0 = sine,
      // depth = unity) at the rate the e2e spec uses.
      const t0 = clock.nowSec();
      clock.wave((t) => (t < t0 ? 0 : Math.sin(2 * Math.PI * LFO_HZ * (t - t0))));
      const RUN_SEC = 2.0;
      for (let i = 0; i < (RUN_SEC * 1000) / SCHEDULER_TICK_MS; i++) clock.advance(SCHEDULER_TICK_MS);

      // Rises at t0 + FIRST_RISE + k/f for every k with that instant < t0 + RUN.
      const expected = Math.ceil((RUN_SEC - FIRST_RISE_SEC) / LFO_PERIOD_SEC);
      expect(expected, 'the derivation yields a real count').toBe(8);
      expect(
        countRisingEdges(ve.writes, 'cv_trig'),
        `${LFO_HZ} Hz for ${RUN_SEC} s → ${expected} rising edges, none dropped, none doubled`,
      ).toBe(expected);
      pe.dispose();
    });

    it(`THE PROMISE (${path}): consecutive replayed edges are one LFO period apart to within ONE bridge tick`, async () => {
      // "The measured period is accurate to about one 25ms bridge tick" —
      // backdraft.ts delay_clock docs. The module timestamps a rise when the
      // replayed setParam(1) lands, so the period it measures is the spacing
      // of those writes: here every one of them, not a median.
      const { pe, ve, clock } = await setup('trig_in', { source: 'cv', worklet });
      clock.advance(SCHEDULER_TICK_MS);
      ve.writes.length = 0;

      const t0 = clock.nowSec();
      clock.wave((t) => (t < t0 ? 0 : Math.sin(2 * Math.PI * LFO_HZ * (t - t0))));
      for (let i = 0; i < 2000 / SCHEDULER_TICK_MS; i++) clock.advance(SCHEDULER_TICK_MS);

      const rises = risingEdgeTimes(ve.writes, 'cv_trig');
      expect(rises.length, 'enough rises to measure a period from').toBeGreaterThanOrEqual(4);
      const periodsMs = rises.slice(1).map((t, i) => (t - rises[i]!) * 1000);
      for (const p of periodsMs) {
        expect(
          Math.abs(p - LFO_PERIOD_SEC * 1000),
          `every measured period is ${LFO_PERIOD_SEC * 1000} ms ± one ${SCHEDULER_TICK_MS} ms tick ` +
            `(saw ${periodsMs.map((x) => x.toFixed(1)).join(', ')} ms)`,
        ).toBeLessThanOrEqual(SCHEDULER_TICK_MS);
      }
      pe.dispose();
    });
  }

  it('the settled LEVEL still follows the cv between edges (a held-high half-cycle reads HIGH)', async () => {
    // The dispatch writes `setParam(currentLevel)` every tick after any replayed
    // edges. For a slow cv that is a 0/1 square at the tick rate — which is how
    // a `clockPatched`-style liveness flag keeps seeing writes, and how a
    // consumer that ALSO reads the level (SHAPEGEN's sample-and-hold) is not
    // reduced to blips by the widen.
    const { pe, ve, clock } = await setup('trig_in', { source: 'cv', worklet: true });
    clock.advance(SCHEDULER_TICK_MS);
    ve.writes.length = 0;
    const t0 = clock.nowSec();
    // 1 Hz: HIGH for [t0+1/12, t0+5/12) — a 333 ms plateau, 13 ticks wide.
    clock.wave((t) => (t < t0 ? 0 : Math.sin(2 * Math.PI * 1 * (t - t0))));
    for (let i = 0; i < 10; i++) clock.advance(SCHEDULER_TICK_MS); // → t0 + 250 ms, inside the plateau
    const last = ve.writes.filter((w) => w.paramId === 'cv_trig').at(-1);
    expect(last?.value, 'inside the positive half-cycle the settled level reads HIGH').toBe(1);
    for (let i = 0; i < 12; i++) clock.advance(SCHEDULER_TICK_MS); // → t0 + 550 ms, past the fall at 417 ms
    const after = ve.writes.filter((w) => w.paramId === 'cv_trig').at(-1);
    expect(after?.value, 'past the fall the settled level reads LOW').toBe(0);
    expect(countRisingEdges(ve.writes, 'cv_trig'), 'one half-cycle, one edge').toBe(1);
    pe.dispose();
  });

  it('removeEdge tears the cv dispatcher down (no writes after teardown)', async () => {
    const { pe, ve, clock, edge } = await setup('trig_in', { source: 'cv', worklet: true });
    clock.advance(SCHEDULER_TICK_MS);
    pe.removeEdge(edge, 'audio');
    ve.writes.length = 0;
    const t0 = clock.nowSec();
    clock.wave((t) => (t < t0 ? 0 : Math.sin(2 * Math.PI * LFO_HZ * (t - t0))));
    clock.advance(SCHEDULER_TICK_MS * 12);
    expect(ve.writes, 'a torn-down cv dispatcher must be silent').toEqual([]);
    pe.dispose();
  });
});

// ---------------------------------------------------------------------------
// PATCH TIME — the analyser → worklet HANDOFF must not manufacture an edge.
// ---------------------------------------------------------------------------
//
// Found by the e2e positive control the widen made possible (the renderer
// stopped, a 4 Hz LFO into DELAY CLK): the first measured periods read 15, 20
// and 87 ms before settling at 250. Reproduced here deterministically: the
// worklet processor started from `prev = 0`, so a source that was HIGH when the
// tap connected posted a rise no transition produced, and the bridge replayed
// it on the next tick — on top of the real rise the analyser fail-safe had
// already delivered. A CV sine is high 30 % of the time, so this fired on
// roughly every third patch; a 10 ms gate pulse is high 4 % of the time at
// 4 Hz, which is why it hid for a year. The fix primes the processor from its
// first sample and hands off at a tick boundary with per-rise timestamps; these
// cases pin the count EXACTLY across every phase of the cycle at patch time.
//
// ONE rise IS still expected when the source is HIGH as the cable lands: the
// consumer's own detector starts low, so the first write of a high level is a
// rise on every path (the legacy per-frame bridge included) — that is the
// "patch a held gate → it fires once" semantic, unchanged here. What must
// never happen is a SECOND one from the same high phase.

describe('PatchEngine — gate dispatch at PATCH TIME (the analyser → worklet handoff)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetSchedulerClockForTests();
  });
  afterEach(() => {
    __resetSchedulerClockForTests();
    vi.useRealTimers();
    delete (globalThis as unknown as Record<string, unknown>).AudioWorkletNode;
    delete (globalThis as unknown as Record<string, unknown>).currentTime;
    delete (globalThis as unknown as Record<string, unknown>).sampleRate;
  });

  /** True rising edges of sin(2π(f·t + phase)) in (0, runSec]: the crossings of
   *  GATE_HI upward at f·t + phase = 1/12 + k. */
  function trueRises(phase: number, runSec: number): number[] {
    const out: number[] = [];
    for (let k = -2; k < runSec * LFO_HZ + 2; k++) {
      const t = (1 / 12 + k - phase) / LFO_HZ;
      if (t > 0 && t <= runSec) out.push(t);
    }
    return out;
  }

  for (const phase of [0, 0.05, 0.1, 0.2, 0.3, 0.45, 0.6, 0.8]) {
    const highAtPatch = Math.sin(2 * Math.PI * phase) >= 0.5;
    it(`a ${LFO_HZ} Hz sine at phase ${phase} (${highAtPatch ? 'HIGH' : 'low'} as the cable lands) counts EXACTLY, across the handoff`, async () => {
      // Install with the wave ALREADY RUNNING — the user patches a live LFO —
      // and let the worklet take over at whatever point in the cycle the
      // registration lands. The worklet primes from its first block and the
      // handoff waits for that, so no phase can manufacture a rise.
      const { pe, ve, clock } = await setupWithWave(
        'trig_in',
        (t) => Math.sin(2 * Math.PI * (LFO_HZ * t + phase)),
      );
      const RUN_SEC = 2.0;
      for (let i = 0; i < (RUN_SEC * 1000) / SCHEDULER_TICK_MS; i++) await tickAndDrain(clock);

      const expected = trueRises(phase, RUN_SEC).length + (highAtPatch ? 1 : 0);
      const rises = risingEdgeTimes(ve.writes, 'cv_trig');
      const periodsMs = rises.slice(1).map((t, i) => (t - rises[i]!) * 1000);
      expect(
        rises.length,
        `${expected} rises expected (${trueRises(phase, RUN_SEC).length} true crossings` +
          `${highAtPatch ? ' + the one for a source HIGH as the cable lands' : ''}); ` +
          `replayed periods: ${periodsMs.map((p) => p.toFixed(1)).join(', ')} ms`,
      ).toBe(expected);
      // …and nothing in the replay looks like a clock faster than the LFO:
      // every period after the patch-time one is a full LFO period ± a tick.
      for (const p of periodsMs.slice(highAtPatch ? 1 : 0)) {
        expect(
          Math.abs(p - LFO_PERIOD_SEC * 1000),
          `no manufactured short period (saw ${periodsMs.map((x) => x.toFixed(1)).join(', ')} ms)`,
        ).toBeLessThanOrEqual(SCHEDULER_TICK_MS);
      }
      pe.dispose();
    });
  }

  it('a gate HELD across the handoff neither double-fires nor dips low', async () => {
    // The gate-source shape of the same defect: a GATE cable (the pre-widen
    // scope) held HIGH from before the cable lands until well after the
    // worklet takes over, into the undeclared-edge target a gate can reach.
    const { pe, ve, clock } = await setupWithWave('clock_in', (t) => (t >= -1 ? 1 : 0), 'gate');
    for (let i = 0; i < 20; i++) await tickAndDrain(clock);
    expect(countRisingEdges(ve.writes, 'cv_clock'), 'one rise for one held gate, handoff included').toBe(1);
    const afterFirst = ve.writes.filter((w) => w.paramId === 'cv_clock').slice(3);
    expect(
      afterFirst.every((w) => w.value === 1),
      `held HIGH throughout — no dip at the handoff (saw ${JSON.stringify(afterFirst.map((w) => w.value))})`,
    ).toBe(true);
    pe.dispose();
  });
});
