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
}

function makeFakeClock(): FakeClock {
  let now = 0;
  let fedUntil = 0;
  const pulses: Array<[number, number]> = [];
  const high = (t: number): number =>
    pulses.some(([s, e]) => t >= s && t < e) ? 1 : 0;

  const node = () => ({ connect() { /* */ }, disconnect() { /* */ } });

  /** Live worklet taps: each gets every render quantum. */
  const taps: Array<(block: Float32Array) => void> = [];
  /** Messages produced by the audio thread, awaiting main-thread delivery. */
  let pendingDeliveries: Array<() => void> = [];

  /** Produce whole render quanta up to `now` and feed every worklet tap. */
  function pumpAudio(): void {
    const quantumSec = RENDER_QUANTUM / SAMPLE_RATE;
    while (taps.length > 0 && fedUntil + quantumSec <= now) {
      const ch = new Float32Array(RENDER_QUANTUM);
      for (let i = 0; i < RENDER_QUANTUM; i++) ch[i] = high(fedUntil + i / SAMPLE_RATE);
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

// Two inputs: `clock_in` is GATE-STYLE (no cvScale → the module edge-detects
// the raw value, SHAPEGEN's contract); `speed_cv` is CONTINUOUS (a cvScale hint
// → the per-frame bridge maps it across the param range).
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
      { id: 'speed_cv', type: 'cv', paramTarget: 'speed', cvScale: { mode: 'bipolar' } },
    ],
    outputs: [{ id: 'out', type: 'video' }],
    params: [
      { id: 'cv_clock', label: 'clk', min: 0, max: 1, defaultValue: 0 },
      { id: 'speed', label: 'speed', min: 0, max: 4, defaultValue: 1 },
    ],
    factory: () => { throw new Error('not instantiated in this test'); },
  });
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
async function setup(targetPortId: string, opts: { worklet?: boolean } = {}) {
  if (!registered) {
    registerModule(GATE_SOURCE_DEF);
    registerVideoTarget();
    registered = true;
  }
  const clock = makeFakeClock();
  if (opts.worklet) clock.enableWorklet();
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
  // `installGateDispatch` registers + constructs the worklet across a few
  // microtasks (addModule is async). Drain them so the dispatcher is live
  // before the test drives the clock. Microtasks are NOT faked by
  // vi.useFakeTimers, so this is deterministic.
  for (let i = 0; i < 8; i++) await Promise.resolve();
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
