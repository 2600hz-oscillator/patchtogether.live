// packages/web/src/lib/audio/modules/timelorde.test.ts
//
// Tests for TIMELORDE's start_in / stop_in transport gates.
// Pattern follows dx7.test.ts: mock AudioContext + AudioWorkletNode so the
// factory can be driven from node without spinning up Web Audio. The
// rising-edge transport logic itself is also exposed as a pure helper
// (transportEventsToRunState) which gets a separate unit-test block.
//
// IMPORTANT: start_in / stop_in flip the `running` AudioParam, NOT
// muteOutputs. running=0 means the worklet HALTS the clock (phase
// accumulator freezes); muteOutputs=1 means the card's MUTE button
// silenced output gates but the clock keeps turning. The two are
// independent — these tests pin that separation as a regression guard.
//
// We do NOT cover the worklet's DSP-side BPM / phase / multiplier math —
// that's the ART scenario's job (art/scenarios/timelorde/).

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  timelordeDef,
  transportEventsToRunState,
  externalBpmLockOnMeasure,
  externalBpmLockOnUserWrite,
  externalBpmLockOnUnpatch,
  BPM_LOCK_UNLOCKED,
  TIMELORDE_BPM_MIN,
  TIMELORDE_BPM_MAX,
} from './timelorde';
import { patch as livePatch } from '$lib/graph/store';
import type { ModuleNode } from '$lib/graph/types';

// ---------------- module-def shape ----------------

// ── swingSource: FIVE declarations of ONE range ───────────────────────────
//
// The 2026-08-03 audit found `swingSource` capped at 10 while `SWING_SOURCES`
// has 12 entries — 1/64 was unreachable from the UI, from a saved patch and
// from CV, while the card's own SRC_LABELS listed all twelve. The audit named
// three sites (def, worklet descriptor, card). There are FIVE: the Electra
// hardware preset hardcoded `max: 10` twice more, in the control and in the
// allocation, plus an eleven-item overlay — and it was found only because its
// committed snapshot happened to print the number.
//
// CLAUDE.md's rule is "a control's range must come from ONE place", and the
// three of these that can't share an import (a worklet that must not import
// web code, a .svelte template, a hardware preset table) are joined HERE
// instead: ground truth is the SWING_SOURCES ARTIFACT, and every other site
// must agree with it. Fixing four of five leaves this red.
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../../../../..');
const readRepo = (rel: string): string => readFileSync(resolve(REPO, rel), 'utf8');

/** Ground truth: the number of OUT_* entries in the core's SWING_SOURCES. */
function swingSourceCount(): number {
  const core = readRepo('packages/dsp/src/lib/timelorde-clock-core.ts');
  const m = /export const SWING_SOURCES = \[([\s\S]*?)\];/.exec(core);
  if (!m) throw new Error('swingSource gate: SWING_SOURCES literal not found in the clock core');
  return (m[1]!.match(/\bOUT_[A-Z0-9_]+\b/g) ?? []).length;
}

describe('TIMELORDE swingSource range is declared in FIVE places and must agree', () => {
  it('every declaration matches SWING_SOURCES.length - 1', () => {
    const n = swingSourceCount();
    expect(n, 'SWING_SOURCES entries (one per gate output, 1x .. 1/64)').toBe(12);
    const want = n - 1;

    // 1. the module def (live, not text)
    const p = timelordeDef.params.find((x) => x.id === 'swingSource')!;
    expect(p.max, 'timelordeDef swingSource max').toBe(want);
    expect(p.min, 'timelordeDef swingSource min').toBe(0);

    // 2. the worklet's frozen parameterDescriptors
    const dsp = readRepo('packages/dsp/src/timelorde.ts');
    const dspMax = /name: 'swingSource',[^}]*maxValue:\s*(\d+)/.exec(dsp);
    expect(dspMax, 'swingSource descriptor not found in packages/dsp/src/timelorde.ts').not.toBeNull();
    expect(Number(dspMax![1]), 'worklet parameterDescriptors swingSource maxValue').toBe(want);

    // 3. the card's Knob — a card can silently disagree with its def and no
    //    runtime gate sees it (CLAUDE.md, backdraft XyPad).
    const card = readRepo('packages/web/src/lib/ui/modules/TimelordeCard.svelte');
    const knob = /<Knob[^>]*paramId="swingSource"[^>]*\/>/.exec(card)
      ?? /max=\{(\d+)\}[^>]*label="Src"/.exec(card);
    expect(knob, 'the SRC Knob was not found in TimelordeCard.svelte').not.toBeNull();
    const cardMaxLine = card.split('\n').find((l) => l.includes('label="Src"'))!;
    const cardMax = /max=\{(\d+)\}/.exec(cardMaxLine);
    expect(cardMax, 'no max={…} on the SRC Knob').not.toBeNull();
    expect(Number(cardMax![1]), 'TimelordeCard SRC Knob max').toBe(want);

    // 4. the card's SRC list (what the footer prints) — and this site was PAID
    //    OFF rather than kept in agreement, 2026-08-23.
    //
    // ⚠ IT USED TO COUNT QUOTES IN A LITERAL: `const SRC_LABELS = ['1x', …]`, a
    // hand-typed copy of the def's own output order that this gate could only
    // ever check for LENGTH — twelve wrong names would have passed it. The face
    // work needed the same twelve names on the DEF (a faceplate over an
    // option-less discrete param prints a bare integer), and once they were
    // there, keeping a second copy on the card would have been the
    // `sampleHold`/`moog904b` shape with a gate wrapped around it. So the card
    // now IMPORTS the derived roster and the clause asserts the DUPLICATE IS
    // GONE, which is strictly stronger than asserting two copies agree.
    expect(
      /const SRC_LABELS\s*=\s*\[/.test(card),
      'TimelordeCard re-declares SRC_LABELS as a literal array — that is the duplicate the ' +
        'derived roster removed, and a literal here can disagree with the def about which ' +
        'index is `1/12` while this gate (which only ever counted entries) stays green',
    ).toBe(false);
    expect(card, 'the card no longer imports the derived roster').toContain('TIMELORDE_SWING_SOURCES');
    // …and the roster it imports really is n long, read off the LIVE def.
    expect(p.options?.length, 'the derived swingSource roster').toBe(n);
    expect(
      p.options?.map((o) => o.value),
      'the roster is not TOTAL over swingSource min..max — a gap is a reachable state with no name',
    ).toEqual(Array.from({ length: n }, (_, i) => i));

    // 5. the Electra hardware preset — control range, allocation range, overlay
    const electra = readRepo('packages/web/src/lib/electra/preset.ts');
    const swLabels = /const SWING_SRC_LABELS = \[([^\]]*)\]/.exec(electra);
    expect(swLabels, 'SWING_SRC_LABELS not found in the Electra preset').not.toBeNull();
    expect((swLabels![1]!.match(/'/g) ?? []).length / 2, 'Electra SWING_SRC_LABELS entries').toBe(n);
    expect(
      electra.includes("max: 10 }, overlayId: ovId"),
      'the Electra SwSrc control re-hardcodes a literal ceiling instead of deriving it',
    ).toBe(false);
  });

  // NEGATIVE CONTROL, every run: the parser must actually COUNT, or "12" above
  // is a constant this test could satisfy while reading nothing.
  it('NEGATIVE CONTROL: the SWING_SOURCES parser counts entries, it does not assume', () => {
    const core = readRepo('packages/dsp/src/lib/timelorde-clock-core.ts');
    const shortened = core.replace(
      /export const SWING_SOURCES = \[([\s\S]*?)\];/,
      'export const SWING_SOURCES = [\n  OUT_1X, OUT_8X,\n];',
    );
    expect(shortened, 'the SWING_SOURCES literal must still be present to tamper with').not.toBe(core);
    const m = /export const SWING_SOURCES = \[([\s\S]*?)\];/.exec(shortened)!;
    expect((m[1]!.match(/\bOUT_[A-Z0-9_]+\b/g) ?? []).length).toBe(2);
  });
});

// ---------------- transportEventsToRunState (pure) ----------------

describe('transportEventsToRunState', () => {
  it('start edge while stopped resumes (run=0 → 1)', () => {
    expect(transportEventsToRunState({ startEdges: 1, stopEdges: 0, prevRunning: 0 })).toBe(1);
  });

  it('stop edge while running halts (run=1 → 0)', () => {
    expect(transportEventsToRunState({ startEdges: 0, stopEdges: 1, prevRunning: 1 })).toBe(0);
  });

  it('idempotent: start while already running stays running', () => {
    expect(transportEventsToRunState({ startEdges: 1, stopEdges: 0, prevRunning: 1 })).toBe(1);
  });

  it('idempotent: stop while already stopped stays stopped', () => {
    expect(transportEventsToRunState({ startEdges: 0, stopEdges: 1, prevRunning: 0 })).toBe(0);
  });

  it('no edges: leaves prevRunning untouched (running stays running)', () => {
    expect(transportEventsToRunState({ startEdges: 0, stopEdges: 0, prevRunning: 1 })).toBe(1);
  });

  it('no edges: leaves prevRunning untouched (stopped stays stopped)', () => {
    expect(transportEventsToRunState({ startEdges: 0, stopEdges: 0, prevRunning: 0 })).toBe(0);
  });

  it('simultaneous start + stop in one poll window: stop wins', () => {
    // Conservative interpretation: if a stop happened in the same window,
    // honor it. Avoids a malformed-burst MIDI device leaving the rack
    // unexpectedly running.
    expect(transportEventsToRunState({ startEdges: 1, stopEdges: 1, prevRunning: 1 })).toBe(0);
    expect(transportEventsToRunState({ startEdges: 1, stopEdges: 1, prevRunning: 0 })).toBe(0);
  });

  it('multi-edge counts behave like single edges (rising-edge is binary)', () => {
    expect(transportEventsToRunState({ startEdges: 3, stopEdges: 0, prevRunning: 0 })).toBe(1);
    expect(transportEventsToRunState({ startEdges: 0, stopEdges: 4, prevRunning: 1 })).toBe(0);
  });
});

// ---------------- factory: gate-driven mute-state transitions ----------------
//
// We mock Web Audio (AudioContext, AudioWorkletNode, GainNode,
// AnalyserNode, ConstantSourceNode, AudioParam) just enough to drive
// timelordeDef.factory(...). The scheduler-clock is replaced with an
// in-memory subscriber list so the test can fire `tick()` synchronously
// and observe what livePatch + the muteOutputs AudioParam look like.

interface FakeParam {
  value: number;
  setValueAtTime: (v: number, t: number) => void;
  cancelScheduledValues: (t: number) => void;
}
function makeParam(initial = 0): FakeParam {
  const p: FakeParam = {
    value: initial,
    setValueAtTime(v) { p.value = v; },
    cancelScheduledValues() { /* */ },
  };
  return p;
}

// Each AnalyserNode keeps an `fftSize`-sample ring buffer of the most-recent
// samples written into its connected gain. Tests use pushSamples(...) to
// stuff edges in directly. The buffer is (re)sized off `fftSize` whenever the
// factory assigns it, so this mock tracks the real widened ring (16384) the
// production factory now requests rather than a hard-coded 2048.
class FakeAnalyserNode {
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
  /** Append `samples` to the right edge of the ring buffer, shifting
   *  older samples out the left. Mirrors how WebAudio fills the analyser
   *  buffer between draws. */
  pushSamples(samples: number[]): void {
    const n = samples.length;
    if (n >= this.buf.length) {
      this.buf.set(samples.slice(samples.length - this.buf.length));
      return;
    }
    this.buf.copyWithin(0, n);
    for (let i = 0; i < n; i++) {
      this.buf[this.buf.length - n + i] = samples[i]!;
    }
  }
}

class FakeGainNode {
  gain = makeParam(1);
  connect = vi.fn();
  disconnect = vi.fn();
}

class FakeConstantSourceNode {
  offset = makeParam(0);
  start = vi.fn();
  stop = vi.fn();
  connect = vi.fn();
  disconnect = vi.fn();
}

// Capture every worklet node the factory constructs so a test can reach
// its `.port.onmessage` (the path the worklet posts measuredBpm on).
const constructedWorklets: FakeAudioWorkletNode[] = [];

class FakeAudioWorkletNode {
  parameters: { get: (k: string) => FakeParam | undefined };
  port = {
    onmessage: null as ((e: { data: unknown }) => void) | null,
    postMessage: vi.fn(),
    close: vi.fn(),
  };
  disconnect = vi.fn();
  _paramMap: Map<string, FakeParam>;
  constructor(_ctx: unknown, _name: string, _opts?: unknown) {
    constructedWorklets.push(this);
    this._paramMap = new Map([
      ['bpm', makeParam(120)],
      ['swingAmount', makeParam(0)],
      ['swingSource', makeParam(0)],
      ['muteOutputs', makeParam(0)],
      // running defaults to 1 (clock advances). Test reseeds via node.params
      // when an explicit value is required for a scenario.
      ['running', makeParam(1)],
      ['hasExternalClock', makeParam(0)],
      // wizardOn (card-visual show/hide flag; gate input + button converge here).
      ['wizardOn', makeParam(1)],
    ]);
    this.parameters = { get: (k) => this._paramMap.get(k) };
  }
}

// In-memory scheduler-clock so the test can call tick() synchronously.
// We replace the scheduler-clock module with this before importing
// timelorde, then drive it ourselves.
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

// Shim the worklet module-url import; the factory only awaits
// ctx.audioWorklet.addModule(url) which our fake ctx no-ops anyway.
vi.mock('@patchtogether.live/dsp/dist/timelorde.js?url', () => ({ default: 'timelorde.js' }));

interface FakeAudioCtx {
  currentTime: number;
  sampleRate: number;
  audioWorklet: { addModule: (u: string) => Promise<void> };
  createGain: () => FakeGainNode;
  createAnalyser: () => FakeAnalyserNode;
  createConstantSource: () => FakeConstantSourceNode;
}
function makeMockCtx(): FakeAudioCtx {
  const ctx: FakeAudioCtx = {
    currentTime: 0,
    sampleRate: 48000,
    audioWorklet: { addModule: vi.fn(async () => {}) },
    createGain: () => new FakeGainNode(),
    createAnalyser: () => new FakeAnalyserNode(),
    createConstantSource: () => new FakeConstantSourceNode(),
  };
  return ctx;
}

function makeNode(params?: Record<string, number>): ModuleNode {
  return {
    id: 'timelorde-test',
    type: 'timelorde',
    domain: 'audio',
    position: { x: 0, y: 0 },
    params: params ?? {},
    data: {},
  };
}

function tickAll(): void {
  for (const cb of [...fakeSchedulerSubs]) cb();
}

function rising(prevHigh: boolean): number[] {
  // 4 low + 8 high samples → a single rising edge near the buffer's end.
  // Use prevHigh to keep the detector's cross-tick state honest if we
  // chain pushes (not needed for the small-scenario tests below, but
  // documented for future expansion).
  void prevHigh;
  return [0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1];
}

describe('timelordeDef.factory: start_in / stop_in transport gates', () => {
  beforeEach(() => {
    fakeSchedulerSubs.length = 0;
    // Register the test node in livePatch so the factory's
    // livePatch.nodes[nodeId].params writes have somewhere to land.
    for (const k of Object.keys(livePatch.nodes)) delete livePatch.nodes[k];
    livePatch.nodes['timelorde-test'] = {
      id: 'timelorde-test',
      type: 'timelorde',
      domain: 'audio',
      position: { x: 0, y: 0 },
      // Start STOPPED so a start_in edge can flip running 0→1 + leave
      // muteOutputs at its default (the card's MUTE button isn't relevant
      // to the transport-gate path).
      params: { running: 0, muteOutputs: 0 },
      data: {},
    } as ModuleNode;
    (globalThis as unknown as { AudioWorkletNode: typeof FakeAudioWorkletNode }).AudioWorkletNode =
      FakeAudioWorkletNode;
  });

  it('exposes start_in + stop_in in the handle.inputs map', async () => {
    const ctx = makeMockCtx();
    const node = makeNode({ running: 0 });
    const handle = await timelordeDef.factory(
      ctx as unknown as AudioContext,
      node,
    );
    expect(handle.inputs.has('start_in')).toBe(true);
    expect(handle.inputs.has('stop_in')).toBe(true);
    expect(handle.inputs.has('clock')).toBe(true);
  });

  // #229-style regression: the start_in / stop_in edge-detector analysers
  // must use a wide ring (≥16384 samples, ~341 ms @ 48 kHz) so a long
  // main-thread stall (canvas pan/drag event-storm, 80–150 ms) can't
  // overwrite a transport edge before pollTransportGates() reads it. A
  // narrow 2048-sample ring (~42 ms) drops those edges ⇒ a missed start/stop
  // under UI load. We assert the analyser fftSize the factory requested,
  // pulled off the gain → analyser wiring.
  it('widens the start_in / stop_in edge-detector ring to ≥16384 (no dropped transport edge under UI stall)', async () => {
    const ctx = makeMockCtx();
    const node = makeNode({ running: 0 });
    const handle = await timelordeDef.factory(
      ctx as unknown as AudioContext,
      node,
    );
    for (const port of ['start_in', 'stop_in'] as const) {
      const gain = handle.inputs.get(port)!.node as unknown as FakeGainNode;
      const ana = gain.connect.mock.calls[0]?.[0] as FakeAnalyserNode;
      expect(ana, `${port} gain connected to an analyser`).toBeDefined();
      expect(ana.fftSize).toBeGreaterThanOrEqual(16384);
      // fftSize must be a power of two for WebAudio to accept it.
      expect(Number.isInteger(Math.log2(ana.fftSize))).toBe(true);
      // The scan buffer the factory reads into must match the ring width,
      // else widening the ring buys no extra lookback.
      expect(ana.buf.length).toBe(ana.fftSize);
    }
  });

  it('rising edge on start_in while stopped sets running ← 1 (and leaves muteOutputs alone)', async () => {
    const ctx = makeMockCtx();
    const node = makeNode({ running: 0, muteOutputs: 0 });
    const handle = await timelordeDef.factory(
      ctx as unknown as AudioContext,
      node,
    );
    // Sanity: the scheduler subscribers were registered — the transport-gate
    // poll AND the wizard-gate (gate→wizardOn level) poll = 2.
    expect(fakeSchedulerSubs.length).toBe(2);

    // First poll has elapsed=0 → no edges to scan. Advance time so the
    // next poll covers a real window.
    tickAll();
    ctx.currentTime = 0.025;

    // Pull the analyser via the gain node's .connect() argument.
    const startGain = handle.inputs.get('start_in')!.node as unknown as FakeGainNode;
    const ana = startGain.connect.mock.calls[0]?.[0] as FakeAnalyserNode;
    expect(ana, 'gain connected to an analyser').toBeDefined();
    ana.pushSamples(rising(false));

    tickAll();

    // The scheduler tick should have routed the rising edge through
    // transportEventsToRunState and written running ← 1 in BOTH the
    // patch store and the running AudioParam. muteOutputs MUST be
    // unchanged — start_in/stop_in are the transport, not the mute.
    expect(livePatch.nodes['timelorde-test']!.params.running).toBe(1);
    expect(livePatch.nodes['timelorde-test']!.params.muteOutputs).toBe(0);
    expect(handle.read?.('running')).toBe(1);
  });

  it('rising edge on stop_in while running sets running ← 0 (and leaves muteOutputs alone)', async () => {
    const ctx = makeMockCtx();
    // Start in the running state.
    livePatch.nodes['timelorde-test']!.params.running = 1;
    livePatch.nodes['timelorde-test']!.params.muteOutputs = 0;
    const node = makeNode({ running: 1, muteOutputs: 0 });
    const handle = await timelordeDef.factory(
      ctx as unknown as AudioContext,
      node,
    );

    tickAll();
    ctx.currentTime = 0.025;

    const stopGain = handle.inputs.get('stop_in')!.node as unknown as FakeGainNode;
    const ana = stopGain.connect.mock.calls[0]?.[0] as FakeAnalyserNode;
    ana.pushSamples(rising(false));

    tickAll();

    expect(livePatch.nodes['timelorde-test']!.params.running).toBe(0);
    expect(livePatch.nodes['timelorde-test']!.params.muteOutputs).toBe(0);
    expect(handle.read?.('running')).toBe(0);
  });

  it('stop_in halts even when muteOutputs is already 1 (transport stop ≠ mute)', async () => {
    // Regression pin: the card's MUTE button (muteOutputs=1) is
    // ORTHOGONAL to the external stop gate. A patched stop_in must
    // still flip running 1→0 + leave muteOutputs at 1.
    const ctx = makeMockCtx();
    livePatch.nodes['timelorde-test']!.params.running = 1;
    livePatch.nodes['timelorde-test']!.params.muteOutputs = 1;
    const node = makeNode({ running: 1, muteOutputs: 1 });
    const handle = await timelordeDef.factory(
      ctx as unknown as AudioContext,
      node,
    );

    tickAll();
    ctx.currentTime = 0.025;

    const stopGain = handle.inputs.get('stop_in')!.node as unknown as FakeGainNode;
    const ana = stopGain.connect.mock.calls[0]?.[0] as FakeAnalyserNode;
    ana.pushSamples(rising(false));

    tickAll();

    expect(livePatch.nodes['timelorde-test']!.params.running).toBe(0);
    // muteOutputs UNCHANGED — the gates are independent.
    expect(livePatch.nodes['timelorde-test']!.params.muteOutputs).toBe(1);
  });

  it('start_in resumes from halted, leaving muteOutputs untouched', async () => {
    // DAW-transport pattern: a stopped clock that gets a fresh start_in
    // edge resumes from its frozen position. The factory level can only
    // observe the running flag; the position-preservation guarantee is
    // a worklet-side property (the process() block early-returns when
    // running=0, so internalPhase + sampleCount do not advance — see
    // packages/dsp/src/timelorde.ts). Here we pin the factory-level
    // signal so the worklet receives running=1 on the resume edge.
    const ctx = makeMockCtx();
    livePatch.nodes['timelorde-test']!.params.running = 0;
    livePatch.nodes['timelorde-test']!.params.muteOutputs = 1;
    const node = makeNode({ running: 0, muteOutputs: 1 });
    const handle = await timelordeDef.factory(
      ctx as unknown as AudioContext,
      node,
    );

    tickAll();
    ctx.currentTime = 0.025;

    const startGain = handle.inputs.get('start_in')!.node as unknown as FakeGainNode;
    const ana = startGain.connect.mock.calls[0]?.[0] as FakeAnalyserNode;
    ana.pushSamples(rising(false));

    tickAll();

    expect(livePatch.nodes['timelorde-test']!.params.running).toBe(1);
    // muteOutputs UNCHANGED — even if the rack is muted, the transport
    // can still be running underneath (LIVECODE keeps consuming ticks).
    expect(livePatch.nodes['timelorde-test']!.params.muteOutputs).toBe(1);
  });

  it('idempotent: pulsing start_in while already running is a no-op', async () => {
    const ctx = makeMockCtx();
    livePatch.nodes['timelorde-test']!.params.running = 1;
    livePatch.nodes['timelorde-test']!.params.muteOutputs = 0;
    const node = makeNode({ running: 1, muteOutputs: 0 });
    const handle = await timelordeDef.factory(
      ctx as unknown as AudioContext,
      node,
    );

    tickAll();
    ctx.currentTime = 0.025;

    const startGain = handle.inputs.get('start_in')!.node as unknown as FakeGainNode;
    const ana = startGain.connect.mock.calls[0]?.[0] as FakeAnalyserNode;
    ana.pushSamples(rising(false));

    // Must not throw; final state unchanged.
    expect(() => tickAll()).not.toThrow();
    expect(livePatch.nodes['timelorde-test']!.params.running).toBe(1);
    expect(livePatch.nodes['timelorde-test']!.params.muteOutputs).toBe(0);
    expect(handle.read?.('running')).toBe(1);
  });

  it('handle.dispose() unsubscribes BOTH scheduler subscriptions (transport + wizard-gate)', async () => {
    const ctx = makeMockCtx();
    const node = makeNode({ running: 0 });
    const handle = await timelordeDef.factory(
      ctx as unknown as AudioContext,
      node,
    );
    // Two subscriptions: the transport-gate poll + the wizard-gate poll.
    expect(fakeSchedulerSubs.length).toBe(2);
    handle.dispose();
    expect(fakeSchedulerSubs.length).toBe(0);
  });
});

// ---------------- factory: gate → wizardOn (level-sensitive) ----------------
//
// The `gate` input is LEVEL-SENSITIVE: when a cable is patched, its level
// owns wizardOn (HIGH = on, LOW = off). When nothing is patched, the on-card
// button governs (the factory leaves wizardOn alone so the silence-source 0
// doesn't clamp the wizard off). These tests drive the analyser ring directly
// (like the start_in/stop_in tests) and assert the livePatch write-through.

describe('timelordeDef.factory: gate → wizardOn (wizard show/hide)', () => {
  beforeEach(() => {
    fakeSchedulerSubs.length = 0;
    for (const k of Object.keys(livePatch.nodes)) delete livePatch.nodes[k];
    for (const k of Object.keys(livePatch.edges)) delete livePatch.edges[k];
    livePatch.nodes['timelorde-test'] = {
      id: 'timelorde-test',
      type: 'timelorde',
      domain: 'audio',
      position: { x: 0, y: 0 },
      params: { wizardOn: 1 },
      data: {},
    } as ModuleNode;
    (globalThis as unknown as { AudioWorkletNode: typeof FakeAudioWorkletNode }).AudioWorkletNode =
      FakeAudioWorkletNode;
  });
  afterEach(() => {
    for (const k of Object.keys(livePatch.edges)) delete livePatch.edges[k];
  });

  function wireGateEdge(): void {
    // A gate cable into TIMELORDE.gate so pollWizardGate considers it patched.
    livePatch.edges['e-wiz'] = {
      id: 'e-wiz',
      source: { nodeId: 'src', portId: 'out' },
      target: { nodeId: 'timelorde-test', portId: 'gate' },
      sourceType: 'gate',
      targetType: 'gate',
    } as (typeof livePatch.edges)[string];
  }

  it('exposes the gate input in the handle.inputs map', async () => {
    const ctx = makeMockCtx();
    const handle = await timelordeDef.factory(ctx as unknown as AudioContext, makeNode());
    expect(handle.inputs.has('gate')).toBe(true);
  });

  it('a HIGH gate level (patched) sets wizardOn ← 1; a LOW level sets it ← 0', async () => {
    const ctx = makeMockCtx();
    const handle = await timelordeDef.factory(ctx as unknown as AudioContext, makeNode());
    wireGateEdge();

    const gateGain = handle.inputs.get('gate')!.node as unknown as FakeGainNode;
    const ana = gateGain.connect.mock.calls[0]?.[0] as FakeAnalyserNode;
    expect(ana, 'gate gain connected to an analyser').toBeDefined();

    // Drive the gate LOW first → wizardOn 0.
    ana.pushSamples([0, 0, 0, 0]);
    tickAll();
    expect(livePatch.nodes['timelorde-test']!.params.wizardOn).toBe(0);

    // Drive the gate HIGH → wizardOn 1.
    ana.pushSamples([1, 1, 1, 1]);
    tickAll();
    expect(livePatch.nodes['timelorde-test']!.params.wizardOn).toBe(1);
  });

  it('leaves wizardOn alone when NO gate cable is patched (button stays in control)', async () => {
    const ctx = makeMockCtx();
    // No wireGateEdge() — nothing patched into `gate`.
    const handle = await timelordeDef.factory(ctx as unknown as AudioContext, makeNode());
    const gateGain = handle.inputs.get('gate')!.node as unknown as FakeGainNode;
    const ana = gateGain.connect.mock.calls[0]?.[0] as FakeAnalyserNode;
    // Even though the (unpatched) analyser reads 0, an unpatched gate must
    // NOT clamp wizardOn off — the button governs. wizardOn stays at its
    // seeded value (1).
    ana.pushSamples([0, 0, 0, 0]);
    tickAll();
    expect(livePatch.nodes['timelorde-test']!.params.wizardOn).toBe(1);
  });
});

describe('timelordeDef.factory: external-clock BPM follow (measuredBpm → bpm)', () => {
  beforeEach(() => {
    fakeSchedulerSubs.length = 0;
    constructedWorklets.length = 0;
    for (const k of Object.keys(livePatch.nodes)) delete livePatch.nodes[k];
    livePatch.nodes['timelorde-test'] = {
      id: 'timelorde-test',
      type: 'timelorde',
      domain: 'audio',
      position: { x: 0, y: 0 },
      params: { bpm: 120 },
      data: {},
    } as ModuleNode;
    (globalThis as unknown as { AudioWorkletNode: typeof FakeAudioWorkletNode }).AudioWorkletNode =
      FakeAudioWorkletNode;
  });

  function fireMeasuredBpm(bpm: number): void {
    // The factory assigns workletNode.port.onmessage; the worklet posts
    // { type: 'measuredBpm', bpm } when it locks to / drifts on an external
    // clock (bpm:0 on dropout).
    const w = constructedWorklets[constructedWorklets.length - 1];
    w?.port.onmessage?.({ data: { type: 'measuredBpm', bpm } });
  }

  it('a positive measuredBpm writes through to the bpm param AND livePatch.params.bpm', async () => {
    // THE GAP-FILL: before this, a measured external tempo was display-only
    // (read('measuredBpm')); the bpm param stayed at the internal knob, so
    // LIVECODE's clock.bpm() / clocked() kept deriving the wrong period
    // while the gate outputs followed the hardware. Now an external lock
    // propagates into bpm everywhere.
    const ctx = makeMockCtx();
    const handle = await timelordeDef.factory(ctx as unknown as AudioContext, makeNode({ bpm: 120 }));
    // The card still surfaces the measured value too.
    fireMeasuredBpm(140);
    expect(handle.read?.('measuredBpm')).toBe(140);
    // …and now the bpm param + the patch store follow it.
    expect(handle.readParam?.('bpm')).toBe(140);
    expect(livePatch.nodes['timelorde-test']!.params.bpm).toBe(140);
  });

  it('measured BPM is clamped to the param range (10..300)', async () => {
    const ctx = makeMockCtx();
    const handle = await timelordeDef.factory(ctx as unknown as AudioContext, makeNode({ bpm: 120 }));
    fireMeasuredBpm(5000); // absurd glitch reading
    expect(handle.readParam?.('bpm')).toBe(300);
    fireMeasuredBpm(2); // below floor
    expect(handle.readParam?.('bpm')).toBe(10);
  });

  it('a dropout (bpm:0) does NOT clobber the bpm param — holds the last followed tempo', async () => {
    const ctx = makeMockCtx();
    const handle = await timelordeDef.factory(ctx as unknown as AudioContext, makeNode({ bpm: 120 }));
    fireMeasuredBpm(132);
    expect(handle.readParam?.('bpm')).toBe(132);
    // Clock unplugged → worklet posts bpm:0. We hold 132 (NOT reset to 120).
    fireMeasuredBpm(0);
    expect(handle.readParam?.('bpm')).toBe(132);
    expect(livePatch.nodes['timelorde-test']!.params.bpm).toBe(132);
    // measuredBpm read still reflects the dropout for the card display.
    expect(handle.read?.('measuredBpm')).toBe(0);
  });
});

// ---------------- factory: video_out passthrough source ----------------
//
// TIMELORDE publishes a `video_out` cross-domain source via the handle's
// videoSources map. The card pushes the current display picture each rAF via
// write('displayFrame', ImageBitmap); the bridge calls drawFrame(canvas) to
// blit the latest frame for downstream video modules. These tests cover the
// structural contract + the write→drawFrame handoff (without a real GPU/DOM).

describe('timelordeDef.factory: video_out cross-domain source', () => {
  beforeEach(() => {
    fakeSchedulerSubs.length = 0;
    for (const k of Object.keys(livePatch.nodes)) delete livePatch.nodes[k];
    livePatch.nodes['timelorde-test'] = {
      id: 'timelorde-test',
      type: 'timelorde',
      domain: 'audio',
      position: { x: 0, y: 0 },
      params: { running: 1, muteOutputs: 0 },
      data: {},
    } as ModuleNode;
    (globalThis as unknown as { AudioWorkletNode: typeof FakeAudioWorkletNode }).AudioWorkletNode =
      FakeAudioWorkletNode;
  });

  it('exposes a video_out entry in handle.videoSources with an analyser + drawFrame', async () => {
    const ctx = makeMockCtx();
    const handle = await timelordeDef.factory(ctx as unknown as AudioContext, makeNode());
    const src = handle.videoSources?.get('video_out');
    expect(src).toBeDefined();
    expect(src?.analyser).toBeDefined();
    expect(src?.sampleRate).toBe(ctx.sampleRate);
    expect(typeof src?.drawFrame).toBe('function');
  });

  it('drawFrame paints an idle frame before any displayFrame is pushed (no throw)', async () => {
    const ctx = makeMockCtx();
    const handle = await timelordeDef.factory(ctx as unknown as AudioContext, makeNode());
    const drawFrame = handle.videoSources?.get('video_out')?.drawFrame;
    expect(drawFrame).toBeDefined();
    // A minimal 2D-canvas stub captures the draw calls (jsdom/node has no real
    // canvas). drawFrame must paint a fill rect (the idle frame) + not throw.
    const calls: string[] = [];
    const canvas = makeFakeCanvas(calls);
    expect(() => drawFrame!(canvas)).not.toThrow();
    expect(calls).toContain('fillRect'); // idle fill (no frame yet)
    expect(calls).not.toContain('drawImage');
  });

  it('write(displayFrame) is adopted → drawFrame blits it (the passthrough)', async () => {
    const ctx = makeMockCtx();
    const handle = await timelordeDef.factory(ctx as unknown as AudioContext, makeNode());
    const drawFrame = handle.videoSources?.get('video_out')?.drawFrame;
    // A fake ImageBitmap-shaped value. Production checks `instanceof ImageBitmap`;
    // jsdom/node lacks ImageBitmap, so make the global match our stub class so
    // the guard accepts it. (drawImage on the canvas stub is what we assert.)
    const closed: boolean[] = [];
    class FakeBitmap { close() { closed.push(true); } }
    (globalThis as unknown as { ImageBitmap: typeof FakeBitmap }).ImageBitmap = FakeBitmap;
    const bmp1 = new FakeBitmap();
    handle.write?.('displayFrame', bmp1 as unknown as ImageBitmap);
    const calls: string[] = [];
    drawFrame!(makeFakeCanvas(calls));
    expect(calls).toContain('drawImage'); // the pushed frame is blitted through
    // Pushing a NEW frame closes the previous bitmap (memory hygiene).
    const bmp2 = new FakeBitmap();
    handle.write?.('displayFrame', bmp2 as unknown as ImageBitmap);
    expect(closed.length).toBe(1); // bmp1 was closed when bmp2 replaced it
  });
});

// ── THE EXTERNAL-CLOCK BPM LOCK IS NON-DESTRUCTIVE ────────────────────────
//
// THE DEFECT, as it shipped. `livePatch.nodes[id].params.bpm` was overwritten by
// the measured external tempo and never given back: patch a MIDICLOCK at 137
// into a rack the player had hand-set to 120, pull the cable, and 137 is the
// stored tempo forever. It is not undoable either — the write is a factory
// write, not a tracked user edit — and the only surface that ever hinted a
// follower owned the number is a card footer a faceplate does not paint.
//
// ⚠ THE POSITIVE CONTROL IS THE FIRST TEST IN THIS BLOCK AND IT IS NOT
// DECORATION. Every assertion below would also pass on a build that simply
// stopped writing the measured tempo through at all — which would be a
// different, worse bug (LIVECODE's clock.bpm() reads the stored param, so the
// follower's write-through is load-bearing). So the block first PINS the locked
// behaviour that must NOT change, and only then asserts the restore. A fix that
// bought the restore by dropping the follow reddens on the control, not on the
// feature.
describe('timelordeDef.factory: the external-clock BPM lock is NON-DESTRUCTIVE', () => {
  beforeEach(() => {
    fakeSchedulerSubs.length = 0;
    constructedWorklets.length = 0;
    for (const k of Object.keys(livePatch.nodes)) delete livePatch.nodes[k];
    for (const k of Object.keys(livePatch.edges)) delete livePatch.edges[k];
    livePatch.nodes['timelorde-test'] = {
      id: 'timelorde-test',
      type: 'timelorde',
      domain: 'audio',
      position: { x: 0, y: 0 },
      // The PLAYER'S tempo — the value the defect destroyed.
      params: { bpm: 120 },
      data: {},
    } as ModuleNode;
    (globalThis as unknown as { AudioWorkletNode: typeof FakeAudioWorkletNode }).AudioWorkletNode =
      FakeAudioWorkletNode;
    // `syncExternalFlag` — the ONLY code that can see the cable leave — runs on
    // a 250 ms setInterval the factory owns. Fake timers make the unpatch edge
    // a deterministic step instead of a wall-clock wait.
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    for (const k of Object.keys(livePatch.edges)) delete livePatch.edges[k];
  });

  function wireClockEdge(): void {
    livePatch.edges['e-clk'] = {
      id: 'e-clk',
      source: { nodeId: 'midiclock', portId: 'clock' },
      target: { nodeId: 'timelorde-test', portId: 'clock' },
      sourceType: 'gate',
      targetType: 'gate',
    } as (typeof livePatch.edges)[string];
  }
  function unwireClockEdge(): void {
    delete livePatch.edges['e-clk'];
  }
  /** Post a worklet `measuredBpm` message the way the DSP does. */
  function postMeasured(bpm: number): void {
    const w = constructedWorklets[constructedWorklets.length - 1]!;
    w.port.onmessage?.({ data: { type: 'measuredBpm', bpm } });
  }
  /** Advance past one `syncExternalFlag` interval (the unpatch scan). */
  function scanExternalFlag(): void {
    vi.advanceTimersByTime(250);
  }
  const storedBpm = (): number | undefined => livePatch.nodes['timelorde-test']!.params.bpm;

  it('POSITIVE CONTROL: while the cable is IN, the measured tempo still writes through to BOTH layers', async () => {
    const ctx = makeMockCtx();
    const handle = await timelordeDef.factory(ctx as unknown as AudioContext, makeNode({ bpm: 120 }));
    wireClockEdge();
    scanExternalFlag(); // hasExternalClock ← 1
    postMeasured(137);
    // The patch store — what LIVECODE's clock.bpm() and every rack-mate read.
    expect(storedBpm(), 'the follower writes the measured tempo into the patch store').toBe(137);
    // …and the AudioParam, so the worklet phase agrees with the outputs.
    expect(handle.readParam?.('bpm'), 'and into the bpm AudioParam').toBe(137);
  });

  it('THE FIX: pulling the clock cable RESTORES the tempo the player set', async () => {
    const ctx = makeMockCtx();
    const handle = await timelordeDef.factory(ctx as unknown as AudioContext, makeNode({ bpm: 120 }));
    wireClockEdge();
    scanExternalFlag();
    postMeasured(137);
    expect(storedBpm(), 'precondition: the lock took the tempo over').toBe(137);

    unwireClockEdge();
    scanExternalFlag();

    // ⚠ THIS IS THE ASSERTION THE SHIPPED BUILD FAILS. Pre-fix it read 137 in
    // both layers, permanently, with nothing on any surface to say why.
    expect(storedBpm(), "the player's hand-set tempo comes back on unpatch").toBe(120);
    expect(handle.readParam?.('bpm'), 'and the AudioParam is restored with it').toBe(120);
  });

  it('a DROPOUT is not an unlock: bpm 0 with the cable still in HOLDS the followed tempo', async () => {
    const ctx = makeMockCtx();
    await timelordeDef.factory(ctx as unknown as AudioContext, makeNode({ bpm: 120 }));
    wireClockEdge();
    scanExternalFlag();
    postMeasured(137);
    // The worklet's dropout signal — the pulses stopped, the cable did not move.
    postMeasured(0);
    scanExternalFlag();
    expect(
      storedBpm(),
      'the external transport still owns the tempo, so the last followed value stands',
    ).toBe(137);
  });

  it('re-setting the tempo DURING the lock is what comes back, not the pre-lock value', async () => {
    const ctx = makeMockCtx();
    const handle = await timelordeDef.factory(ctx as unknown as AudioContext, makeNode({ bpm: 120 }));
    wireClockEdge();
    scanExternalFlag();
    postMeasured(137);
    // The player turns the knob while the follower owns it (every user write —
    // knob, face cell, TAP, topbar surface — lands on setParam).
    handle.setParam?.('bpm', 90);
    postMeasured(137); // the follower immediately takes the number back

    unwireClockEdge();
    scanExternalFlag();
    expect(storedBpm(), 'the LATEST intent is restored, not the pre-lock 120').toBe(90);
  });

  it('NEGATIVE CONTROL: a rack that never had a clock cable is never written', async () => {
    const ctx = makeMockCtx();
    await timelordeDef.factory(ctx as unknown as AudioContext, makeNode({ bpm: 120 }));
    // Many scans, no cable, no measurement: the restore must be a NO-OP rather
    // than a write of a default — otherwise it would clobber a value the player
    // set through some other path between two scans.
    scanExternalFlag();
    scanExternalFlag();
    livePatch.nodes['timelorde-test']!.params.bpm = 175;
    scanExternalFlag();
    expect(storedBpm(), 'nothing was owed, so nothing was written').toBe(175);
  });

  it('a SECOND lock stashes the RESTORED value, not the first external tempo', async () => {
    const ctx = makeMockCtx();
    await timelordeDef.factory(ctx as unknown as AudioContext, makeNode({ bpm: 120 }));
    wireClockEdge();
    scanExternalFlag();
    postMeasured(137);
    unwireClockEdge();
    scanExternalFlag();
    expect(storedBpm()).toBe(120);

    wireClockEdge();
    scanExternalFlag();
    postMeasured(90);
    expect(storedBpm(), 'the second lock follows its own clock').toBe(90);
    unwireClockEdge();
    scanExternalFlag();
    expect(storedBpm(), 'and still gives back 120 — the stash did not latch 137').toBe(120);
  });
});

// The pure reducer under the factory wiring above. Fast, exhaustive, and the
// place the CLAMP is pinned against the def's own declared range rather than
// two re-typed literals.
describe('externalBpmLock* (pure)', () => {
  it('the first measurement stashes the STORED tempo and writes the measured one', () => {
    const r = externalBpmLockOnMeasure(BPM_LOCK_UNLOCKED, { measuredBpm: 137, storedBpm: 120 });
    expect(r.state.stashed).toBe(120);
    expect(r.write).toBe(137);
  });

  it('later measurements do NOT re-stash — the stash would become the followed tempo', () => {
    const first = externalBpmLockOnMeasure(BPM_LOCK_UNLOCKED, { measuredBpm: 137, storedBpm: 120 });
    // storedBpm is now 137 (we wrote it); a naive re-stash would capture it and
    // the restore would hand back the external clock's tempo — a fix that
    // restores nothing while looking exactly like one.
    const second = externalBpmLockOnMeasure(first.state, { measuredBpm: 138, storedBpm: 137 });
    expect(second.state.stashed).toBe(120);
  });

  it('a non-positive measurement is a DROPOUT: no write, no stash', () => {
    expect(externalBpmLockOnMeasure(BPM_LOCK_UNLOCKED, { measuredBpm: 0, storedBpm: 120 })).toEqual({
      state: BPM_LOCK_UNLOCKED,
      write: null,
    });
  });

  it('clamps to the def’s declared bpm range, in both directions', () => {
    const bpmDef = timelordeDef.params.find((p) => p.id === 'bpm')!;
    expect([TIMELORDE_BPM_MIN, TIMELORDE_BPM_MAX], 'the clamp IS the def’s range').toEqual([
      bpmDef.min,
      bpmDef.max,
    ]);
    expect(
      externalBpmLockOnMeasure(BPM_LOCK_UNLOCKED, { measuredBpm: 5000, storedBpm: 120 }).write,
    ).toBe(bpmDef.max);
    expect(
      externalBpmLockOnMeasure(BPM_LOCK_UNLOCKED, { measuredBpm: 0.5, storedBpm: 120 }).write,
    ).toBe(bpmDef.min);
  });

  it('a user write with NO lock live is a no-op (nothing to remember)', () => {
    expect(externalBpmLockOnUserWrite(BPM_LOCK_UNLOCKED, 90)).toBe(BPM_LOCK_UNLOCKED);
  });

  it('a user write DURING a lock replaces the stash', () => {
    const locked = externalBpmLockOnMeasure(BPM_LOCK_UNLOCKED, { measuredBpm: 137, storedBpm: 120 }).state;
    expect(externalBpmLockOnUserWrite(locked, 90).stashed).toBe(90);
  });

  it('unpatching with nothing stashed owes nothing', () => {
    expect(externalBpmLockOnUnpatch(BPM_LOCK_UNLOCKED)).toEqual({
      state: BPM_LOCK_UNLOCKED,
      restore: null,
    });
  });

  it('unpatching returns the stash and clears it (a second unpatch owes nothing)', () => {
    const locked = externalBpmLockOnMeasure(BPM_LOCK_UNLOCKED, { measuredBpm: 137, storedBpm: 120 }).state;
    const first = externalBpmLockOnUnpatch(locked);
    expect(first.restore).toBe(120);
    expect(externalBpmLockOnUnpatch(first.state).restore).toBeNull();
  });
});

/** Minimal 2D canvas stub: records the context method names called so a test
 *  can assert which drawing path drawFrame took (fillRect = idle, drawImage =
 *  pushed-frame passthrough). width/height satisfy the drawFrame sizing reads. */
function makeFakeCanvas(calls: string[]): HTMLCanvasElement {
  const ctx2d = {
    clearRect: () => calls.push('clearRect'),
    fillRect: () => calls.push('fillRect'),
    drawImage: () => calls.push('drawImage'),
    set fillStyle(_v: string) { /* */ },
    get fillStyle() { return ''; },
  };
  return {
    width: 220,
    height: 220,
    getContext: (_type: string) => ctx2d,
  } as unknown as HTMLCanvasElement;
}
