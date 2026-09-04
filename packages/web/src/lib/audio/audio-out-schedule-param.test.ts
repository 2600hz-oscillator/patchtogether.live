// packages/web/src/lib/audio/audio-out-schedule-param.test.ts
//
// ⚠ NO FADE ON THE MASTER WAS EVER ACTUALLY SCHEDULED.
//
// `audioOutDef`'s handle exposed `setParam` / `readParam` and NO
// `scheduleParam`. `PatchEngine.scheduleParam` (engine.ts) reaches an AudioParam
// three ways, in order:
//
//   1. `handle.scheduleParam(...)`                     ← did not exist
//   2. `handle.inputs.get(paramId)?.param`             ← `master` is not a CV
//                                                        port; `inputs` carries
//                                                        only the audio pins L/R
//   3. best-effort immediate `handle.setParam(...)`    ← what actually ran
//
// So every ramp anyone believed they were scheduling on the master bus was a
// hard step at `ctx.currentTime`. `holdParam` degraded identically through its
// own `else` branch. The failure was SILENT and shaped exactly like success —
// the value arrived, the knob followed, `readParam` agreed; only the RAMP was
// missing — and a jump on the master bus is a click on the actual output. It is
// also a precondition for any envelope-shaped assertion, including the
// click-free crossfade the continuity probe exists to serve.
//
// ── WHY THIS DRIVES THE REAL FACTORY ───────────────────────────────────────
// The bug lived in the gap between a handle and the engine's dispatch, so a
// hand-written stand-in handle would have proved nothing: the whole defect was
// that the SHIPPED handle lacked a method. `audioOutDef.factory` is run here
// against a recording context, and the assertions are on the AudioParam event
// log — the thing the browser would actually schedule.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { audioOutDef } from './modules/audio-out';
import { AudioEngine } from './engine';
import { registerModule } from './module-registry';
import type { ModuleNode } from '$lib/graph/types';

/** One scheduled AudioParam event, in the order the graph would apply it. */
interface ParamEvent {
  kind: 'setValueAtTime' | 'linearRamp' | 'expRamp' | 'cancelAndHold' | 'cancelScheduled';
  value: number;
  time: number;
}

function makeParam(initial = 0) {
  const events: ParamEvent[] = [];
  return {
    value: initial,
    events,
    setValueAtTime(v: number, t: number) {
      events.push({ kind: 'setValueAtTime', value: v, time: t });
      this.value = v;
      return this;
    },
    linearRampToValueAtTime(v: number, t: number) {
      events.push({ kind: 'linearRamp', value: v, time: t });
      return this;
    },
    exponentialRampToValueAtTime(v: number, t: number) {
      events.push({ kind: 'expRamp', value: v, time: t });
      return this;
    },
    cancelAndHoldAtTime(t: number) {
      events.push({ kind: 'cancelAndHold', value: this.value, time: t });
      return this;
    },
    cancelScheduledValues(t: number) {
      events.push({ kind: 'cancelScheduled', value: this.value, time: t });
      return this;
    },
  };
}

type FakeParam = ReturnType<typeof makeParam>;

function makeNode(tag: string, extra: Record<string, unknown> = {}) {
  return {
    __tag: tag,
    connect() {
      /* graph shape is not what this file measures */
    },
    disconnect() {
      /* */
    },
    ...extra,
  };
}

/** Records every gain node the factory creates, in creation order. The master
 *  pair is the first two: `gainL`, `gainR` (audio-out.ts:233-234). */
function makeCtx() {
  const gains: Array<{ gain: FakeParam }> = [];
  const ctx = {
    currentTime: 10, // deliberately non-zero: an `atTime` must be absolute
    sampleRate: 48_000,
    destination: makeNode('destination'),
    // Force the documented degraded path — no worklet in the unit lane. The
    // limiter is irrelevant to param scheduling and the fallback is a pure
    // graph node, so this keeps the fixture honest instead of stubbing a
    // worklet that would not exist in a browser without one either.
    audioWorklet: { addModule: async () => Promise.reject(new Error('no worklet here')) },
    createGain() {
      const g = { ...makeNode('gain'), gain: makeParam(1) };
      gains.push(g);
      return g;
    },
    createBiquadFilter() {
      return { ...makeNode('biquad'), type: '', frequency: makeParam(0), Q: makeParam(0) };
    },
    createChannelMerger() {
      return makeNode('merger');
    },
    createChannelSplitter() {
      return makeNode('splitter');
    },
    createAnalyser() {
      return {
        ...makeNode('analyser'),
        fftSize: 32,
        smoothingTimeConstant: 0,
        getFloatTimeDomainData() {
          /* */
        },
      };
    },
    createConstantSource() {
      return {
        ...makeNode('const'),
        offset: makeParam(0),
        start() {
          /* */
        },
        stop() {
          /* */
        },
      };
    },
    createWaveShaper() {
      return { ...makeNode('waveshaper'), curve: null, oversample: 'none' };
    },
  };
  return { ctx, gains };
}

function moduleNode(): ModuleNode {
  return {
    id: 'pinned-audioOut',
    type: 'audioOut',
    domain: 'audio',
    position: { x: 0, y: 0 },
    params: { master: 0.7 },
  } as ModuleNode;
}

async function buildHandle() {
  const { ctx, gains } = makeCtx();
  const handle = await audioOutDef.factory(ctx as unknown as AudioContext, moduleNode());
  // gainL / gainR are the first two gain nodes the factory creates.
  return { handle, ctx, gainL: gains[0]!.gain, gainR: gains[1]!.gain };
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  // The factory warns about the missing limiter worklet on the degraded path.
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
});

describe('audioOut handle — scheduleParam exists at all', () => {
  it('THE REGRESSION: the shipped handle exposes scheduleParam', async () => {
    // Without this the engine silently takes branch 3 and every ramp is a step.
    const { handle } = await buildHandle();
    expect(typeof handle.scheduleParam).toBe('function');
  });

  it('master is NOT a CV port, so branch 2 could never have covered it', async () => {
    // Pins the reason branch 1 is load-bearing: if `master` ever gains a CV
    // input this assertion goes red and the comment above needs rewriting.
    const { handle } = await buildHandle();
    expect([...handle.inputs.keys()].sort()).toEqual(['L', 'R']);
    expect(handle.inputs.get('master')).toBeUndefined();
  });

  it('a RAMP schedules an anchor plus a linear ramp on BOTH channels', async () => {
    const { handle, gainL, gainR } = await buildHandle();
    gainL.events.length = 0;
    gainR.events.length = 0;
    handle.scheduleParam!('master', 0.2, 12.5, true);
    for (const g of [gainL, gainR]) {
      expect(g.events).toEqual([
        // The anchor, at the CURRENT value (the def's 0.7 default, applied by
        // the factory): linearRampToValueAtTime interpolates from the previous
        // event, so without it the ramp starts from whatever was last set and
        // the jump moves to the START of the fade instead of vanishing.
        { kind: 'setValueAtTime', value: 0.7, time: 10 },
        { kind: 'linearRamp', value: 0.2, time: 12.5 },
      ]);
    }
  });

  it('a NON-ramp schedules a step AT THE REQUESTED TIME, not at now', async () => {
    const { handle, gainL } = await buildHandle();
    gainL.events.length = 0;
    handle.scheduleParam!('master', 0.4, 12.5, false);
    expect(gainL.events).toEqual([{ kind: 'setValueAtTime', value: 0.4, time: 12.5 }]);
  });

  it('a ramp to a PAST time degrades to an immediate step (never a backwards ramp)', async () => {
    const { handle, gainL } = await buildHandle();
    gainL.events.length = 0;
    handle.scheduleParam!('master', 0.4, 5, true); // ctx.currentTime is 10
    expect(gainL.events).toEqual([{ kind: 'setValueAtTime', value: 0.4, time: 10 }]);
  });

  it('an unknown param is ignored, exactly as setParam ignores it', async () => {
    const { handle, gainL } = await buildHandle();
    gainL.events.length = 0;
    handle.scheduleParam!('nonesuch', 0.9, 12, true);
    expect(gainL.events).toEqual([]);
  });

  it('setParam is unchanged: still an immediate step at now', async () => {
    // The fix must not turn every knob twist into a ramp.
    const { handle, gainL } = await buildHandle();
    gainL.events.length = 0;
    handle.setParam('master', 0.55);
    expect(gainL.events).toEqual([{ kind: 'setValueAtTime', value: 0.55, time: 10 }]);
    expect(handle.readParam('master')).toBe(0.55);
  });
});

describe('audioOut through the ENGINE dispatch — the branch that was taken', () => {
  /** Register the handle with a real PatchEngine so the dispatch under test is
   *  engine.ts's, not a re-implementation of it. */
  async function withEngine() {
    registerModule(audioOutDef); // the unit lane has no glob-derived registry
    const { ctx, gains } = makeCtx();
    const engine = new AudioEngine(ctx as unknown as AudioContext);
    await engine.addNode(moduleNode());
    return { engine, gainL: gains[0]!.gain, gainR: gains[1]!.gain };
  }

  it('engine.scheduleParam now reaches branch 1 and a REAL ramp lands', async () => {
    const { engine, gainL, gainR } = await withEngine();
    gainL.events.length = 0;
    gainR.events.length = 0;
    engine.scheduleParam('pinned-audioOut', 'master', 0.0, 12.0, true);
    for (const g of [gainL, gainR]) {
      expect(g.events.map((e) => e.kind)).toEqual(['setValueAtTime', 'linearRamp']);
      const ramp = g.events[1]!;
      expect(ramp.value).toBe(0);
      expect(ramp.time).toBe(12.0);
    }
  });

  it('POSITIVE CONTROL: the OLD behaviour was a step at NOW — assert it is gone', async () => {
    // This is the assertion that fails on origin/main: with no scheduleParam,
    // branch 3 ran `setParam`, producing exactly one setValueAtTime at
    // ctx.currentTime (10) with no ramp event anywhere, whatever `atTime` said.
    const { engine, gainL } = await withEngine();
    gainL.events.length = 0;
    engine.scheduleParam('pinned-audioOut', 'master', 0.0, 12.0, true);
    expect(gainL.events).not.toEqual([{ kind: 'setValueAtTime', value: 0, time: 10 }]);
    expect(gainL.events.some((e) => e.kind === 'linearRamp' && e.time === 12.0)).toBe(true);
  });

  it('engine.holdParam pins at a FUTURE seam instead of jumping now', async () => {
    // holdParam's `else` branch prefers handle.scheduleParam over setParam, so
    // the same missing method broke the seam pin too.
    const { engine, gainL } = await withEngine();
    gainL.events.length = 0;
    engine.holdParam('pinned-audioOut', 'master', 12.0, 0.3, 0.05);
    expect(gainL.events.length).toBeGreaterThan(0);
    const last = gainL.events[gainL.events.length - 1]!;
    expect(last.value).toBe(0.3);
    expect(last.time).toBe(12.0); // the seam, not `now`
  });

  it('a NON-ramp engine schedule still lands at the requested time', async () => {
    const { engine, gainL } = await withEngine();
    gainL.events.length = 0;
    engine.scheduleParam('pinned-audioOut', 'master', 0.9, 11.25, false);
    expect(gainL.events).toEqual([{ kind: 'setValueAtTime', value: 0.9, time: 11.25 }]);
  });
});
