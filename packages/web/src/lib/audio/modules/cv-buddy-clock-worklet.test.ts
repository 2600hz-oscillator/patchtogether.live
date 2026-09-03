// packages/web/src/lib/audio/modules/cv-buddy-clock-worklet.test.ts
//
// THE STALL-SIMULATION SUITE for the cv-clock worklet wiring — the structural
// fix for the SPEEDERR-001 dropped pulse (ledger item 10: one pulse lost to a
// 200–360 ms main-thread stall against a 200 ms lookahead; both Pam's re-locked
// audibly).
//
// What the other suites cannot see, and this one exists for:
//   * `cv-clock-core.test.ts` (dsp) proves the audio-thread engine free-runs
//     correctly, but drives it with hand-made configs — it cannot see whether
//     cv-buddy actually POSTS the right configs at the right moments, or what
//     the factory wires to the jacks.
//   * `cv-buddy-clock-skips.test.ts` (#2324) pins the main-thread path on a
//     context with NO AudioWorklet — it proves the fallback, never the fix.
//
// So the centrepiece here couples the REAL factory + REAL scheduler-tick loop
// to a REAL CvClockCore fed by the REAL messages the factory posts, and stalls
// the main thread for 400 ms:
//   * the worklet path emits the COMPLETE grid — zero dropped pulses — because
//     a stall can starve only the config messages;
//   * the POSITIVE CONTROL runs the identical stall against the old
//     main-thread scheduler (a worklet-less context) and loses EXACTLY ONE
//     pulse — the incident, reproduced. Without it, "zero dropped" would be
//     unfalsifiable.
//
// What THIS suite is structurally unable to see: the real AudioWorklet
// machinery (addModule, the processor wrapper, message transport) only exists
// in a browser — that leg is e2e/tests/cv-buddy-clock-worklet.spec.ts.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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
import { cvBuddyDef, type CvBuddyClockHealth, type CvBuddyClockState } from './cv-buddy';
// The SAME core class the shipped processor runs (seq-clock.ts imports it from
// this exact module) — a relative path for the reason videocube.ts gives:
// worktrees may not symlink the workspace package under node_modules.
import { CvClockCore, cvPulsePeriodS } from '../../../../../dsp/src/lib/cv-clock-core';

// ---------------------------------------------------------------- fake audio
class FakeParam {
  value = 0;
  events: Array<{ value: number; time: number }> = [];
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
  connect() {}
  disconnect() {}
}
class FakeGain {
  gain = new FakeParam();
  connect() {}
  disconnect() {}
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
}

/** A context whose audioWorklet accepts the module — flips the factory onto
 *  the worklet path. */
class FakeWorkletContext extends FakeAudioContext {
  audioWorklet = { addModule: async (_url: string) => {} };
}

interface PostedMessage {
  at: number; // ctx.currentTime when posted — main-thread wall time
  data: { type?: string; config?: Record<string, unknown> };
}

/** Captures what the wiring posts; the integration test replays it into a real
 *  CvClockCore at the times it was posted. */
class FakeAudioWorkletNode extends EventTarget {
  static instances: FakeAudioWorkletNode[] = [];
  readonly posted: PostedMessage[] = [];
  readonly name: string;
  readonly options: unknown;
  private readonly ctx: FakeAudioContext;
  port = {
    onmessage: null as null | ((e: MessageEvent) => void),
    postMessage: (data: unknown) => {
      this.posted.push({ at: this.ctx.currentTime, data: data as PostedMessage['data'] });
    },
    close: () => {},
  };
  connect() {}
  disconnect() {}
  constructor(ctx: unknown, name: string, options?: unknown) {
    super();
    this.ctx = ctx as FakeAudioContext;
    this.name = name;
    this.options = options;
    FakeAudioWorkletNode.instances.push(this);
  }
}

// ---------------------------------------------------------------- the rack
const NODE_ID = 'cvb1';
const SR = 48000;

// The SPEEDERR performance's numbers (period ≈ 159.42 ms), same as #2324.
const BPM = 94.08761422877872;
const PPQN = 4;
const PERIOD = cvPulsePeriodS(BPM, PPQN);

function clearPatch() {
  for (const k of Object.keys(livePatch.nodes)) delete livePatch.nodes[k];
  for (const k of Object.keys(livePatch.edges)) delete livePatch.edges[k];
}

function seedPerf() {
  clearPatch();
  livePatch.nodes[NODE_ID] = {
    id: NODE_ID,
    type: 'cvBuddy',
    domain: 'audio',
    position: { x: 0, y: 0 },
    params: { ppqn: PPQN, clockOffsetMs: 0 },
  } as never;
  livePatch.nodes['tl1'] = {
    id: 'tl1',
    type: 'timelorde',
    domain: 'audio',
    position: { x: 0, y: 0 },
    params: { bpm: BPM, running: 1 },
  } as never;
}

async function build(ctx: FakeAudioContext) {
  return cvBuddyDef.factory(
    ctx as unknown as AudioContext,
    { id: NODE_ID, type: 'cvBuddy', params: livePatch.nodes[NODE_ID]!.params } as never,
  );
}

function health(handle: { read?: (k: string) => unknown }): CvBuddyClockHealth {
  return handle.read!('clockHealth') as CvBuddyClockHealth;
}
function state(handle: { read?: (k: string) => unknown }): CvBuddyClockState {
  return handle.read!('state') as CvBuddyClockState;
}

beforeEach(() => {
  hoisted.tick = null;
  clearPatch();
  FakeAudioWorkletNode.instances = [];
  vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

// The tick pattern shared by the fix leg and the positive control, so "the
// same stall" is literal: 1 s of healthy 25 ms ticks, one 400 ms wedge with no
// tick at all, 1 s of recovery. `onAdvance` lets the worklet leg render audio
// in lockstep with main-thread time.
function driveStallScript(ctx: FakeAudioContext, onAdvance?: (t: number) => void): void {
  for (let i = 0; i < 40; i++) {
    hoisted.tick!();
    ctx.currentTime += 0.025;
    onAdvance?.(ctx.currentTime);
  }
  ctx.currentTime += 0.4; // ⚠ THE STALL — no tick, no messages, for 400 ms
  onAdvance?.(ctx.currentTime);
  for (let i = 0; i < 40; i++) {
    hoisted.tick!();
    ctx.currentTime += 0.025;
    onAdvance?.(ctx.currentTime);
  }
}

describe('cv-buddy — the cv-clock worklet wiring', () => {
  it('with an AudioWorklet, the WORKLET drives the jacks (clock=out 0, run=out 1)', async () => {
    seedPerf();
    const ctx = new FakeWorkletContext();
    const handle = await build(ctx);
    const wn = FakeAudioWorkletNode.instances[0]!;
    expect(wn.name).toBe('cv-clock');
    expect(handle.outputs.get('clock')).toEqual({ node: wn, output: 0 });
    expect(handle.outputs.get('run')).toEqual({ node: wn, output: 1 });
    expect(health(handle).driver).toBe('worklet');
    // and the config was pushed at creation, carrying the web constants
    const cfg = wn.posted[0]!.data;
    expect(cfg.type).toBe('config');
    expect(cfg.config).toMatchObject({
      bpm: BPM,
      ppqn: PPQN,
      running: true,
      runLevel: 0.5,
      pulseS: 0.005,
    });
  });

  it('WITHOUT an AudioWorklet, the wiring is byte-identical to the old path', async () => {
    seedPerf();
    const ctx = new FakeAudioContext();
    const handle = await build(ctx);
    expect(FakeAudioWorkletNode.instances).toHaveLength(0);
    // the jack node is the ConstantSource the #2324 suite reads events from
    const clockNode = handle.outputs.get('clock')!.node as unknown as FakeConstantSource;
    expect(clockNode.offset).toBeInstanceOf(FakeParam);
    expect(health(handle).driver).toBe('main');
  });

  it('config messages are COALESCED at rest and carry a bpm edit within one tick', async () => {
    seedPerf();
    const ctx = new FakeWorkletContext();
    await build(ctx);
    const wn = FakeAudioWorkletNode.instances[0]!;

    for (let i = 0; i < 20; i++) {
      hoisted.tick!();
      ctx.currentTime += 0.025;
    }
    // nothing moved → only the creation-time message
    expect(wn.posted).toHaveLength(1);

    // a live BPM edit (what timelorde writes per frame during a knob drag)
    (livePatch.nodes['tl1'] as unknown as { params: { bpm: number } }).params.bpm = 100;
    hoisted.tick!();
    const last = wn.posted[wn.posted.length - 1]!;
    expect(wn.posted).toHaveLength(2);
    expect(last.data.config).toMatchObject({ bpm: 100 });
    // ⚠ NO LOOKAHEAD LAG: the edit reaches the audio thread on the next tick
    // (~25 ms), not after a 200 ms pre-scheduled window plays out.
    expect(last.at - ctx.currentTime).toBeLessThanOrEqual(0.025);
  });

  it('a ppqn/offset setParam reaches the worklet immediately, snapped', async () => {
    seedPerf();
    const ctx = new FakeWorkletContext();
    const handle = await build(ctx);
    const wn = FakeAudioWorkletNode.instances[0]!;
    handle.setParam!('ppqn', 23); // snaps to 24
    const last = wn.posted[wn.posted.length - 1]!.data;
    expect(last.config).toMatchObject({ ppqn: 24 });
  });

  it('health messages from the processor surface on read("clockHealth")', async () => {
    // Includes the CONTEXT-clock fields (renderedS + gap extremes): the e2e
    // stall leg judges the pulse counter against renderedS from the SAME
    // snapshot — a field dropped here would silently un-anchor that spec.
    seedPerf();
    const ctx = new FakeWorkletContext();
    const handle = await build(ctx);
    const wn = FakeAudioWorkletNode.instances[0]!;
    wn.port.onmessage!({
      data: { type: 'health', pulses: 5, skipped: 0, renderedS: 0.9, minGapS: null, maxGapS: null },
    } as MessageEvent);
    expect(health(handle)).toMatchObject({
      workletPulses: 5,
      workletSkips: 0,
      workletRenderedS: 0.9,
      workletMinGapS: null,
      workletMaxGapS: null,
    });
    wn.port.onmessage!({
      data: { type: 'health', pulses: 9, skipped: 2, renderedS: 1.7, minGapS: 0.159, maxGapS: 0.16 },
    } as MessageEvent);
    expect(health(handle)).toMatchObject({
      workletPulses: 9,
      workletSkips: 2,
      workletRenderedS: 1.7,
      workletMinGapS: 0.159,
      workletMaxGapS: 0.16,
    });
  });

  it('dispose tells the processor to stand down (a 0-input source never GCs itself)', async () => {
    seedPerf();
    const ctx = new FakeWorkletContext();
    const handle = await build(ctx);
    const wn = FakeAudioWorkletNode.instances[0]!;
    handle.dispose();
    expect(wn.posted.some((m) => m.data.type === 'dispose')).toBe(true);
  });
});

describe('cv-buddy — the 400 ms stall, both paths (the incident, re-run)', () => {
  it('WORKLET PATH: a 400 ms main-thread stall drops ZERO pulses', async () => {
    seedPerf();
    const ctx = new FakeWorkletContext();
    const handle = await build(ctx);
    const wn = FakeAudioWorkletNode.instances[0]!;

    // The audio thread: a REAL CvClockCore consuming the REAL messages the
    // factory posts, rendered in 128-frame quanta in lockstep with the
    // main-thread clock. During the wedge no messages arrive — and that must
    // not matter, because pulse emission lives on this side.
    const core = new CvClockCore(SR);
    const edges: number[] = [];
    let renderedFrames = 0;
    let prevSample = 0;
    let msgIdx = 0;
    const renderAudioTo = (timeS: number) => {
      const target = Math.floor(timeS * SR);
      while (renderedFrames < target) {
        const quantumStartS = renderedFrames / SR;
        while (msgIdx < wn.posted.length && wn.posted[msgIdx]!.at <= quantumStartS) {
          const m = wn.posted[msgIdx]!.data;
          if (m.type === 'config' && m.config) core.setConfig(m.config);
          msgIdx++;
        }
        const n = Math.min(128, target - renderedFrames);
        const c = new Float32Array(n);
        const r = new Float32Array(n);
        core.process(c, r, n);
        for (let i = 0; i < n; i++) {
          const cur = c[i]!;
          if (prevSample < 0.5 && cur >= 0.5) edges.push(renderedFrames + i);
          prevSample = cur;
        }
        renderedFrames += n;
      }
    };

    driveStallScript(ctx, renderAudioTo);

    const periodSamples = PERIOD * SR;
    // ZERO dropped: a single lost pulse is a ~2-period hole in the train, so
    // the gap law over the WHOLE take (stall window included) is the claim.
    expect(core.skipped).toBe(0);
    expect(edges.length).toBeGreaterThan(10);
    for (let i = 1; i < edges.length; i++) {
      const gap = edges[i]! - edges[i - 1]!;
      expect(gap, `gap after edge ${i - 1} (a dropped pulse reads ≈2 periods)`)
        .toBeLessThan(periodSamples * 1.5);
      expect(gap, `edges ${i - 1}→${i} closer than one period`)
        .toBeGreaterThan(periodSamples - 2);
    }
    // count matches the grid over the rendered span (±1 half-open boundary)
    const spanned = Math.floor((renderedFrames - 1 - edges[0]!) / periodSamples) + 1;
    expect(Math.abs(edges.length - spanned)).toBeLessThanOrEqual(1);

    // …and the SHADOW main path measured the stall: the diagnostic keeps its
    // meaning ("one pulse WOULD have been lost — the worklet absorbed it").
    expect(state(handle).skips).toBe(1);
    expect(health(handle).driver).toBe('worklet');
  });

  it('POSITIVE CONTROL: the old main-thread scheduler under the SAME stall drops EXACTLY ONE', async () => {
    // Derivation (the incident's own arithmetic): ticks land at 0, 25 …
    // 975 ms, so after the last healthy tick the clock is scheduled through
    // 975 + 200 (lookahead) = 1175 ms. The wedge ends at 975 + 25 + 400 =
    // 1400 ms, and the un-covered window [1175, 1400) contains exactly one
    // grid point: 8 × 159.42 = 1275.4 ms. One pulse, unplaceable — the
    // SPEEDERR take, reproduced. If THIS ever reports 0, the stall harness is
    // broken and the worklet leg above proves nothing.
    seedPerf();
    const ctx = new FakeAudioContext(); // no audioWorklet → the old path
    const handle = await build(ctx);
    expect(health(handle).driver).toBe('main');

    driveStallScript(ctx);

    expect(state(handle).skips).toBe(1);
  });
});
