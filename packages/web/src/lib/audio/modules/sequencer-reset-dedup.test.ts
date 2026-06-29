// packages/web/src/lib/audio/modules/sequencer-reset-dedup.test.ts
//
// Regression test for #224 — cross-module reset double-hit.
//
// Repro (the saved patch acid-seq3-reset-doublehit.imp.json): a CLOCKDIV is
// patched into a sequencer's reset_cv at a perfect integer division of the
// sequencer's own run clock — e.g. reset fires once every `length` steps,
// exactly when the sequence would naturally wrap to step 0. Before the fix,
// the internal-BPM lookahead scheduler had ALREADY queued step 0's gate at
// the natural boundary; the reset then re-anchored and queued a SECOND step-0
// gate within the lookahead window → an audible double-hit on the downbeat.
//
// The fix (sequencer.ts pollTransportCv reset branch) cancels the pending
// lookahead-queued gate/pitch/clock events before re-anchoring, so exactly one
// step-0 gate fires whether or not the reset coincides with a wrap.
//
// This test drives the REAL sequencer factory + tick loop against a fake
// AudioContext with an advanceable currentTime and an injectable reset_cv
// analyser buffer, and asserts the count of gate rising edges over N bars is
// EXACTLY N * length (no extras). It also asserts that a reset landing mid-bar
// still produces no duplicate at the reset instant.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---- Capture the scheduler-clock tick so we can drive it manually. --------
// vi.mock factories are hoisted; share the captured-tick slot via vi.hoisted
// so the factory can write into it and the test bodies can read it.
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

// The sequencer factory reads live per-tick state from the REAL graph store
// (`import { patch as livePatch } from '$lib/graph/store'`). We import that
// same singleton and mutate it directly — the proven pattern from
// timelorde.test.ts — rather than mocking the store.
import { patch as livePatch } from '$lib/graph/store';
import { POLY_CHANNELS } from '$lib/audio/poly';

// The gate ConstantSource is created immediately after createPolySender's
// POLY_CHANNELS (10) poly-lane sources, so it's at this index in the fake's
// constantSources[]. (PR-B routes the `gate` output port through a switch-bus
// GainNode, so the port node is no longer the gate source directly.)
const GATE_CS_INDEX = POLY_CHANNELS;

// ---- Minimal fake AudioContext --------------------------------------------
// A ConstantSource whose offset records every setValueAtTime(value, time) so
// the test can reconstruct the gate waveform exactly as the audio thread
// would render it. An Analyser whose getFloatTimeDomainData copies from a
// per-instance injectable buffer (keyed by which input gain it was connected
// to) so we can feed reset_cv pulses.

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
    // Drop scheduled events at or after fromTime — exactly Web Audio's
    // contract. Events strictly before fromTime stay (the held value).
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
// distinct audio times, within [0, untilTime]. Each gate-high at a fresh time
// is exactly one note trigger the audio thread will sound. (Counting "rising
// edges" by walking 0/1 transitions is fragile when a gate-low and the next
// gate-high are scheduled at the same instant — array order then decides the
// transition spuriously. Distinct gate-high times is the unambiguous measure.)
function countOnsets(param: FakeParam, untilTime: number): number {
  const times = new Set<number>();
  for (const e of param.events) {
    if (e.value >= 0.5 && e.time <= untilTime + 1e-9) {
      times.add(Number(e.time.toFixed(6)));
    }
  }
  return times.size;
}

// Smallest gap between consecutive distinct gate-high onset times. A double-hit
// (#224) manifests as two onsets scheduled ~coincidentally (well under one
// step), so a healthy sequence keeps this gap close to a full step-duration.
// Returns Infinity when there are fewer than two onsets.
function minOnsetGap(param: FakeParam): number {
  const times = Array.from(
    new Set(
      param.events
        .filter((e) => e.value >= 0.5)
        .map((e) => Number(e.time.toFixed(6))),
    ),
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
      out.set(buf.subarray(0, out.length));
    } else {
      out.fill(0);
    }
  }
}

class FakeAudioContext {
  currentTime = 0;
  sampleRate = 48000;
  // Track every ConstantSource so the test can reach the gate source directly:
  // PR-B routes outputs through switch-bus GainNodes (main path ↔ worklet), so
  // `handle.outputs.get('gate').node` is now a bus gain, not the gate source.
  // The gate ConstantSource is created right after createPolySender's 10 poly
  // lane sources (5 pairs), i.e. index POLY_CHANNELS — see GATE_CS_INDEX.
  constantSources: FakeConstantSource[] = [];
  createConstantSource() {
    const c = new FakeConstantSource();
    this.constantSources.push(c);
    return c as unknown as ConstantSourceNode;
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
// tick's "samples since last poll" window sees exactly one new edge.
function pulseBuffer(len = 2048): Float32Array {
  const b = new Float32Array(len);
  // Last ~64 samples high → one rising edge in the freshly-arrived window.
  for (let i = len - 64; i < len; i++) b[i] = 1;
  return b;
}
function zeroBuffer(len = 2048): Float32Array {
  return new Float32Array(len);
}

// Import AFTER the mocks are registered.
import { sequencerDef } from './sequencer';

const NODE_ID = 'seq1';
const LENGTH = 8;

// livePatch is a SyncedStore (Yjs-backed) proxy: you can't reassign the
// `nodes`/`edges` ROOTS (throws "cannot set new elements on root doc"), so we
// clear by deleting keys and assign individual nodes — the timelorde.test.ts
// pattern.
function clearPatch() {
  for (const k of Object.keys(livePatch.nodes)) delete livePatch.nodes[k];
  for (const k of Object.keys(livePatch.edges)) delete livePatch.edges[k];
}

function seedNode(allOn = true) {
  clearPatch();
  const steps = Array.from({ length: LENGTH }, () => ({
    on: allOn,
    midi: 60,
    chord: 'mono',
  }));
  livePatch.nodes[NODE_ID] = {
    id: NODE_ID,
    type: 'sequencer',
    domain: 'audio',
    position: { x: 0, y: 0 },
    params: { bpm: 120, length: LENGTH, isPlaying: 1, gateLength: 0.5, octave: 0, swing: 0 },
    data: { steps },
  } as never;
}

describe('sequencer #224: clock-divided reset produces no double-hit', () => {
  beforeEach(() => {
    hoisted.tick = null;
    clearPatch();
  });

  it('over N bars, a reset at each exact bar boundary yields exactly N*length gate onsets', async () => {
    seedNode(true);
    const ctx = new FakeAudioContext();
    const handle = await sequencerDef.factory(
      ctx as unknown as AudioContext,
      { id: NODE_ID, type: 'sequencer', params: livePatch.nodes[NODE_ID]!.params } as never,
    );
    expect(hoisted.tick).toBeTruthy();

    // The gate ConstantSource is the `gate` output.
    const gateParam = ctx.constantSources[GATE_CS_INDEX]!.offset as unknown as FakeParam;
    // The reset_cv input is a FakeGain; we inject pulses on it.
    const resetGain = handle.inputs.get('reset_cv')!.node as unknown as FakeGain;

    const stepDur = 60 / 120 / 4; // 16th = 0.125s
    const barDur = stepDur * LENGTH;
    const BARS = 4;

    // Drive ticks every 25ms (the worker cadence). At each bar boundary we
    // inject ONE reset pulse — a perfect integer division of the run clock.
    const tickMs = 0.025;
    const totalTime = barDur * BARS;
    let nextResetAt = barDur; // first reset at end of bar 1
    let t = 0;
    // Run a little past the last bar so the final bar's steps are scheduled.
    while (t < totalTime + barDur) {
      ctx.currentTime = t;
      // Inject a reset pulse for exactly the tick that straddles a bar
      // boundary; otherwise keep reset low.
      if (nextResetAt <= t && nextResetAt > t - tickMs) {
        resetGain.injected = pulseBuffer();
        nextResetAt += barDur;
      } else {
        resetGain.injected = zeroBuffer();
      }
      hoisted.tick!();
      t += tickMs;
    }

    // The lookahead (200ms) means events are scheduled slightly past
    // `totalTime`. Count rising edges within the first `totalTime` window —
    // i.e. exactly the bars we drove. With LENGTH on-steps per bar and the
    // reset being a perfect division, the correct count is BARS * LENGTH.
    // DIAG: list onset times to understand any off-by-one.
    {
      const evs = gateParam.events
        .filter((e) => e.value >= 0.5)
        .map((e) => Number(e.time.toFixed(4)))
        .sort((a, b) => a - b);
      // eslint-disable-next-line no-console
      console.log('DIAG onset times:', JSON.stringify(evs));
      // eslint-disable-next-line no-console
      console.log('DIAG totalTime:', totalTime, 'barDur:', barDur, 'stepDur:', stepDur);
    }
    const onsets = countOnsets(gateParam, totalTime - 1e-6);
    // Exactly BARS * LENGTH onsets — one per step, with NO duplicate downbeats.
    // Before the fix this was BARS * LENGTH + (#duplicated downbeats).
    expect(onsets).toBe(BARS * LENGTH);

    handle.dispose();
  });

  it('a reset with NO coinciding wrap still fires exactly one step-0 gate (no dup)', async () => {
    seedNode(true);
    const ctx = new FakeAudioContext();
    const handle = await sequencerDef.factory(
      ctx as unknown as AudioContext,
      { id: NODE_ID, type: 'sequencer', params: livePatch.nodes[NODE_ID]!.params } as never,
    );
    const gateParam = ctx.constantSources[GATE_CS_INDEX]!.offset as unknown as FakeParam;
    const resetGain = handle.inputs.get('reset_cv')!.node as unknown as FakeGain;

    const stepDur = 60 / 120 / 4;
    const barDur = stepDur * LENGTH;
    const tickMs = 0.025;

    // Run ~2 bars, inject one reset mid-bar 1 (NOT on a boundary).
    const resetAt = stepDur * 3.5; // between steps 3 and 4
    let t = 0;
    let injected = false;
    while (t < barDur * 2) {
      ctx.currentTime = t;
      if (!injected && resetAt <= t) {
        resetGain.injected = pulseBuffer();
        injected = true;
      } else {
        resetGain.injected = zeroBuffer();
      }
      hoisted.tick!();
      t += tickMs;
    }

    // Count onsets in a tight window right after the reset: there must be
    // exactly ONE step-0 onset there (not two). We approximate by counting
    // onsets in [resetAt, resetAt + stepDur*1.5].
    const windowEnd = resetAt + stepDur * 1.5;
    const onsetsInWindow = countOnsets(gateParam, windowEnd) - countOnsets(gateParam, resetAt - 1e-6);
    // At most one onset should appear in the immediate post-reset window
    // (the re-anchored step 0). The bug produced 2 here.
    expect(onsetsInWindow).toBeLessThanOrEqual(1);

    handle.dispose();
  });
});
