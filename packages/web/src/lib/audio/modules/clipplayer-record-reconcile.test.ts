// packages/web/src/lib/audio/modules/clipplayer-record-reconcile.test.ts
//
// ENGINE behavior for the live-record redesign's stale-note fix (§3) + the
// shrunk record-lane lookahead (§3.3), driven through the REAL clipplayer
// factory + tick loop against a fake (advanceable) AudioContext — same harness
// style as clip-div-swing.test.ts / clipplayer.test.ts.
//
//   • RECONCILE — removing a note from a PLAYING clip + pushing a reconcile CUTS
//     that note's in-flight/scheduled gate NOW (the erased note stops), while
//     every KEPT note re-lands at its ORIGINAL grid time (no phase shift). This
//     is the missing side effect behind owner problem 3.
//   • SHRUNK LOOKAHEAD — a lane being note-recorded schedules only a few ms
//     ahead (so an edit can't be out-run by ~200 ms-old audio), while other
//     lanes keep the full lookahead.

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
import { clipplayerDef } from './clipplayer';
import { clipIndex, type NoteClipRecord } from './clip-types';
import { pushReconcile } from './clip-reconcile';

// ---- Minimal fake AudioContext (advanceable currentTime; records param events) ----
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
  connect(target?: unknown, _output?: number, input?: number) {
    const t = target as { _inputs?: Record<number, FakeConstantSource> } | undefined;
    if (t && t._inputs && typeof input === 'number') t._inputs[input] = this;
  }
  disconnect() {}
}
class FakeGain {
  gain = new FakeParam();
  _inputs: Record<number, FakeConstantSource> = {};
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
    out.fill(0);
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

const NODE_ID = 'cp-recrec';

function clearPatch() {
  for (const k of Object.keys(livePatch.nodes)) delete livePatch.nodes[k];
  for (const k of Object.keys(livePatch.edges)) delete livePatch.edges[k];
}
function noteClip(steps: NoteClipRecord['steps'], lengthSteps: number): NoteClipRecord {
  return { kind: 'note', steps, lengthSteps, root: 48, loop: true };
}
function allStepsClip(lengthSteps: number): NoteClipRecord {
  return noteClip(
    Array.from({ length: lengthSteps }, (_, i) => ({ step: i, midi: 60, velocity: 127, lengthSteps: 1 })),
    lengthSteps,
  );
}
function lane8<T>(entries: Record<number, T>, fill: T): T[] {
  const a = new Array<T>(8).fill(fill);
  for (const [k, v] of Object.entries(entries)) a[Number(k)] = v;
  return a;
}
function seed(data: Record<string, unknown>) {
  clearPatch();
  livePatch.nodes[NODE_ID] = {
    id: NODE_ID, type: 'clipplayer', domain: 'audio', position: { x: 0, y: 0 },
    params: { stepDiv: 2, quantize: 0, octave: 0, gateLength: 0.9, snh: 1 }, data,
  } as never;
  livePatch.nodes['tl'] = {
    id: 'tl', type: 'timelorde', domain: 'audio', position: { x: 0, y: 0 },
    params: { running: 1, bpm: 120 }, data: {},
  } as never;
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
type Handle = { outputs: Map<string, { node: unknown }> };
function gateHighTimes(handle: Handle, lane: number): number[] {
  const p = (handle.outputs.get(`gate${lane + 1}`)!.node as unknown as FakeConstantSource)
    .offset as unknown as FakeParam;
  return p.events.filter((e) => e.value >= 0.5).map((e) => e.time).sort((a, b) => a - b);
}
function liveClip(idx: number): NoteClipRecord {
  return (livePatch.nodes[NODE_ID]!.data as { clips: Record<string, NoteClipRecord> }).clips[String(idx)];
}

const BASE = 0.125; // 120 bpm, stepDiv 2 → 0.125 s/step

beforeEach(() => {
  hoisted.tick = null;
  clearPatch();
});

describe('stale-note reconcile (engine §3.1)', () => {
  it('removing a note from a playing clip + reconcile CUTS its scheduled gate; kept notes re-land on-grid', async () => {
    // Notes on step 4 (0.5 s) and step 6 (0.75 s) of an 8-step loop on lane 0.
    seed({
      clips: { [clipIndex(0, 0)]: noteClip([{ step: 4, midi: 60, velocity: 127, lengthSteps: 1 }, { step: 6, midi: 62, velocity: 127, lengthSteps: 1 }], 8) },
      playing: lane8({ 0: 0 }, null),
    });
    const ctx = new FakeAudioContext();
    const handle = (await build(ctx)) as unknown as Handle;

    // Run until step 4's gate is committed in the lookahead but before it is
    // audible; step 6 (two steps later) is still beyond the horizon. (The lane's
    // immediate-launch grid is anchored at now+0.01, so the exact times are read
    // dynamically rather than hard-coded — only the SPACING matters.)
    run(ctx, 0, 0.375);
    const pre = gateHighTimes(handle, 0);
    expect(pre.length, 'exactly step 4 scheduled pre-erase').toBe(1);
    const step4T = pre[0]!;
    const step6T = step4T + 2 * BASE; // step 6 = step 4 + two step durations

    // ERASE step 4's note on the PLAYING clip (plain-cloned reassign — the
    // yjs-save-load discipline) + publish a reconcile, then tick.
    const clip = liveClip(clipIndex(0, 0));
    const data = livePatch.nodes[NODE_ID]!.data as { clips: Record<string, NoteClipRecord> };
    data.clips[String(clipIndex(0, 0))] = {
      ...clip,
      steps: clip.steps.filter((s) => s.step !== 4).map((s) => ({ ...s })),
    };
    pushReconcile(NODE_ID, { lane: 0 });
    ctx.currentTime = 0.375;
    hoisted.tick!();

    // The erased step-4 gate is CANCELLED — the note stops NOW.
    expect(gateHighTimes(handle, 0), 'erased step 4 gate cut').not.toContainEqual(
      expect.closeTo(step4T, 4),
    );

    // Run on; step 6 (kept) still sounds at its ORIGINAL grid time — the
    // reconcile preserved the loop phase, it did not shift the grid.
    run(ctx, 0.4, 0.95);
    expect(gateHighTimes(handle, 0), 'kept step 6 re-lands on-grid').toContainEqual(
      expect.closeTo(step6T, 3),
    );
  });
});

describe('shrunk record-lane lookahead (engine §3.3)', () => {
  it('a note-RECORDING lane schedules only a few ms ahead; other lanes keep the full lookahead', async () => {
    // Lane 0 is being note-recorded; lane 1 plays normally. Same all-steps clip.
    seed({
      clips: {
        [clipIndex(0, 0)]: allStepsClip(8),
        [clipIndex(0, 1)]: allStepsClip(8),
      },
      playing: lane8({ 0: 0, 1: 0 }, null),
      noteRec: { lane: 0, slot: 0, armed: false, recording: true, overdub: false },
    });
    const ctx = new FakeAudioContext();
    const handle = (await build(ctx)) as unknown as Handle;

    // One tick at t = 0.1: the recording lane 0 schedules while nextStepTime <
    // 0.1 + 0.05 = 0.15 (→ furthest emit ≈ 0.125); lane 1 while < 0.1 + 0.2 =
    // 0.3 (→ furthest emit ≈ 0.25).
    run(ctx, 0, 0.125);
    const rec = gateHighTimes(handle, 0);
    const play = gateHighTimes(handle, 1);
    const maxRec = Math.max(...rec);
    const maxPlay = Math.max(...play);
    expect(maxRec, 'recording lane horizon is tight').toBeLessThan(0.2);
    expect(maxPlay, 'non-recording lane keeps the full lookahead').toBeGreaterThan(maxRec + BASE / 2);
  });
});
