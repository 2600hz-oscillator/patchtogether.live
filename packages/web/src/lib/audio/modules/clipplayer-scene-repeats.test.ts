// packages/web/src/lib/audio/modules/clipplayer-scene-repeats.test.ts
//
// SCENE REPEATS through the REAL clipplayer engine tick — drives the factory
// against the fake AudioContext + the live graph store (same harness as
// clipplayer.test.ts) and asserts the tick-side semantics:
//   - N repeats of the scene's longest clip → auto-launch the NEXT CONTENT
//     scene down (skipping empty rows) through the normal queued path;
//   - the last content scene keeps LOOPING (never stops, never wraps);
//   - manual always wins: an individual clip launch CANCELS tracking, a manual
//     scene launch mid-count takes over at the next boundary (no Deluge
//     "hostage launch"), and re-launching the SAME scene resets its count;
//   - count edits latch to the next boundary evaluation; the repeat UNIT is
//     FROZEN at launch (mid-count length edits don't move the schedule);
//   - MUTE never voids the count; transport restart resets the live countdown;
//   - a DUPLICATE advance write (the concurrent-peer race) is a clean no-op;
//   - arrangement mode disables tracking entirely.
//
// Timing: TIMELORDE 120 bpm, stepDiv 2 (4 steps/beat) → step = 0.125 s. A
// 4-step clip = 1 beat = 0.5 s per pass; an 8-step clip = 2 beats = 1.0 s.

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

// ---- Minimal fake AudioContext (same shape as clipplayer.test.ts) ----
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
  injected: Float32Array | null = null;
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
    const buf = this._source?.injected;
    if (buf) out.set(buf.subarray(0, out.length));
    else out.fill(0);
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

import { clipplayerDef } from './clipplayer';
import { clipIndex, type ClipPlayerData, type NoteClipRecord } from './clip-types';
import { applySceneLaunchWrite, readSceneLaunch } from './clip-scene-repeats';

const NODE_ID = 'cp1';

function clearPatch() {
  for (const k of Object.keys(livePatch.nodes)) delete livePatch.nodes[k];
  for (const k of Object.keys(livePatch.edges)) delete livePatch.edges[k];
}
function noteClip(lengthSteps = 4, midi = 60): NoteClipRecord {
  return {
    kind: 'note',
    steps: [{ step: 0, midi, velocity: 127, lengthSteps: 1 }],
    lengthSteps,
    root: 48,
    loop: true,
  };
}
function seed(data: Record<string, unknown>, params: Record<string, number> = {}) {
  clearPatch();
  livePatch.nodes[NODE_ID] = {
    id: NODE_ID,
    type: 'clipplayer',
    domain: 'audio',
    position: { x: 0, y: 0 },
    params: { stepDiv: 2, quantize: 1, octave: 0, gateLength: 0.9, snh: 1, ...params },
    data,
  } as never;
  livePatch.nodes['tl'] = {
    id: 'tl', type: 'timelorde', domain: 'audio', position: { x: 0, y: 0 }, params: { running: 1, bpm: 120 }, data: {},
  } as never;
}
function liveData(): ClipPlayerData {
  return livePatch.nodes[NODE_ID]!.data as ClipPlayerData;
}
function playing(): (number | null)[] {
  return (liveData().playing ?? []) as (number | null)[];
}
/** Lane L's mono-gate FakeParam (its scheduled setValueAtTime events carry the
 *  audible step times — the boundary-floor tests assert against those). */
function gateOf(handle: { outputs: Map<string, { node: unknown }> }, lane: number): FakeParam {
  return (handle.outputs.get(`gate${lane + 1}`)!.node as unknown as FakeConstantSource)
    .offset as unknown as FakeParam;
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
/** Fire a scene launch through the SHARED seam (what every surface writes). */
function launchScene(slot: number, immediate = false) {
  applySceneLaunchWrite(liveData(), slot, immediate);
}

beforeEach(() => {
  hoisted.tick = null;
  clearPatch();
});

describe('scene repeats — auto-advance through the engine tick', () => {
  it('N=2: after two passes of the longest clip the NEXT CONTENT scene launches (gap skipped), via the normal queued path', async () => {
    // Scene 0 = lane 0 (4 steps, the longest = the unit). Scene 1 EMPTY.
    // Scene 2 = lane 1. Repeats: scene 0 ×2 → advance lands on scene 2.
    seed({
      clips: { [clipIndex(0, 0)]: noteClip(4), [clipIndex(2, 1)]: noteClip(4) },
      sceneRepeats: { '0': 2 },
    });
    const ctx = new FakeAudioContext();
    await build(ctx);
    run(ctx, 0, 0.06); // first ticks adopt the (absent) marker without firing
    launchScene(0);
    // Unit = 4 steps = 0.5 s; 2 passes ≈ 1.0 s after the start. Well before the
    // boundary window nothing has advanced:
    run(ctx, 0.06, 0.6);
    expect(playing()[0]).toBe(0);
    expect(playing()[1] ?? null).toBeNull();
    expect(readSceneLaunch(liveData())?.n).toBe(1);
    // …and after it, scene 2 is playing: lane 1 launched, lane 0 STOPPED (no
    // clip at slot 2) — the whole-scene plan, recorded through the marker.
    run(ctx, 0.6, 2.2);
    expect(playing()[1]).toBe(2);
    expect(playing()[0] ?? null).toBeNull();
    expect(readSceneLaunch(liveData())).toEqual({ slot: 2, n: 2 });
  });

  it('the LAST content scene keeps LOOPING after N (never stops, never wraps)', async () => {
    seed({
      clips: { [clipIndex(0, 0)]: noteClip(4) },
      sceneRepeats: { '0': 1 },
    });
    const ctx = new FakeAudioContext();
    await build(ctx);
    run(ctx, 0, 0.06);
    launchScene(0);
    run(ctx, 0.06, 3.0); // way past 1 pass
    expect(playing()[0], 'still looping scene 0').toBe(0);
    expect(readSceneLaunch(liveData())?.n, 'no auto-launch was written').toBe(1);
  });

  it('INFINITE (no count set) never advances', async () => {
    seed({
      clips: { [clipIndex(0, 0)]: noteClip(4), [clipIndex(1, 0)]: noteClip(4) },
    });
    const ctx = new FakeAudioContext();
    await build(ctx);
    run(ctx, 0, 0.06);
    launchScene(0);
    run(ctx, 0.06, 3.0);
    expect(playing()[0]).toBe(0);
    expect(readSceneLaunch(liveData())?.n).toBe(1);
  });

  it('manual interference: launching an INDIVIDUAL clip cancels tracking (no later auto-advance)', async () => {
    seed({
      clips: {
        [clipIndex(0, 0)]: noteClip(4),
        [clipIndex(1, 0)]: noteClip(4), // the would-be advance target
        [clipIndex(5, 1)]: noteClip(4), // the manually-launched individual clip
      },
      sceneRepeats: { '0': 2 },
    });
    const ctx = new FakeAudioContext();
    await build(ctx);
    run(ctx, 0, 0.06);
    launchScene(0);
    run(ctx, 0.06, 0.3);
    // The user launches an individual clip on lane 1 (slot 5) mid-count — the
    // per-lane queued write every clip-pad surface makes.
    const d = liveData();
    d.queued = [null, 5, null, null, null, null, null, null];
    run(ctx, 0.3, 3.0);
    expect(playing()[1], 'the manual clip runs').toBe(5);
    expect(playing()[0], 'scene 0 keeps looping — the countdown was cancelled').toBe(0);
    expect(readSceneLaunch(liveData())?.n, 'no auto-launch ever fired').toBe(1);
  });

  it('NO hostage launch: a manual scene launch mid-count takes over at the next boundary, not after the remaining repeats', async () => {
    seed({
      clips: { [clipIndex(0, 0)]: noteClip(4), [clipIndex(3, 0)]: noteClip(4) },
      sceneRepeats: { '0': 5 }, // 5 repeats = 2.5 s — the manual launch must NOT wait for them
    });
    const ctx = new FakeAudioContext();
    await build(ctx);
    run(ctx, 0, 0.06);
    launchScene(0);
    run(ctx, 0.06, 0.7); // ~1 pass in
    launchScene(3); // the user presses scene 3's button
    // It applies at the next loop boundary (~1.05 s), far before 2.5 s:
    run(ctx, 0.7, 1.5);
    expect(playing()[0], 'manual launch won immediately').toBe(3);
    // And the stale scene-0 count never fires later (scene 3 is infinite):
    run(ctx, 1.5, 4.0);
    expect(playing()[0]).toBe(3);
  });

  it('re-launching the SAME scene mid-count resets its count fresh', async () => {
    seed({
      clips: { [clipIndex(0, 0)]: noteClip(4), [clipIndex(1, 0)]: noteClip(4) },
      sceneRepeats: { '0': 2 }, // unit 0.5 s → original boundary ≈ start + 1.0 s
    });
    const ctx = new FakeAudioContext();
    await build(ctx);
    run(ctx, 0, 0.06);
    launchScene(0);
    run(ctx, 0.06, 0.6); // ~1 pass done
    launchScene(0); // SAME scene again → count resets to zero here
    // The ORIGINAL boundary (~1.05 s, decision window ~0.7 s) passes without an
    // advance:
    run(ctx, 0.6, 1.2);
    expect(playing()[0]).toBe(0);
    // The advance lands ~2 units after the RE-launch instead (~0.6+1.0 ≈ 1.6 s):
    run(ctx, 1.2, 2.3);
    expect(playing()[0]).toBe(1);
  });

  it('count edits LATCH: setting N below the already-elapsed count advances at the next boundary, never retroactively', async () => {
    seed({
      clips: { [clipIndex(0, 0)]: noteClip(4), [clipIndex(1, 0)]: noteClip(4) },
    });
    const ctx = new FakeAudioContext();
    await build(ctx);
    run(ctx, 0, 0.06);
    launchScene(0); // infinite at launch
    run(ctx, 0.06, 1.15); // ~2 passes elapse with no count set
    expect(playing()[0]).toBe(0);
    liveData().sceneRepeats = { '0': 1 }; // now BELOW the elapsed count
    // It advances at the next boundary after the edit (within ~1 pass):
    run(ctx, 1.15, 1.9);
    expect(playing()[0]).toBe(1);
  });

  it('the repeat UNIT is FROZEN at launch: a mid-count length edit does not move the scheduled boundary', async () => {
    seed({
      clips: { [clipIndex(0, 0)]: noteClip(8), [clipIndex(1, 0)]: noteClip(4) },
      sceneRepeats: { '0': 2 }, // unit = 8 steps = 1.0 s → boundary ≈ start + 2.0 s
    });
    const ctx = new FakeAudioContext();
    await build(ctx);
    run(ctx, 0, 0.06);
    launchScene(0);
    run(ctx, 0.06, 1.2); // pass 1 done
    // Shrink the playing clip to 2 steps (0.25 s wraps). If the unit were
    // re-derived, "2 passes" would already be long past → an early advance.
    liveData().clips!['0'] = noteClip(2);
    run(ctx, 1.2, 1.55);
    expect(playing()[0], 'no early advance — the unit stayed 1.0 s').toBe(0);
    // The frozen boundary (~2.05 s) still applies, at the shrunken clip's next
    // wrap around it:
    run(ctx, 1.55, 2.6);
    expect(playing()[0]).toBe(1);
  });

  it('MUTE never voids the count: muting the anchor lane mid-count leaves the schedule intact', async () => {
    seed({
      clips: {
        [clipIndex(0, 0)]: noteClip(8), // the anchor (longest)
        [clipIndex(0, 1)]: noteClip(4),
        [clipIndex(1, 0)]: noteClip(4),
      },
      sceneRepeats: { '0': 2 }, // unit = 1.0 s → boundary ≈ start + 2.0 s
    });
    const ctx = new FakeAudioContext();
    await build(ctx);
    run(ctx, 0, 0.06);
    launchScene(0);
    run(ctx, 0.06, 0.6);
    liveData().muted = [true, false, false, false, false, false, false, false];
    run(ctx, 0.6, 1.6);
    expect(playing()[0], 'not yet — mute changed nothing about the schedule').toBe(0);
    run(ctx, 1.6, 2.6);
    expect(playing()[0], 'advance fired on schedule with the anchor muted').toBe(1);
  });

  it('stopping EVERY scene lane cancels the countdown (a silent rack never surprise-launches)', async () => {
    seed({
      clips: { [clipIndex(0, 0)]: noteClip(4), [clipIndex(1, 0)]: noteClip(4) },
      sceneRepeats: { '0': 2 },
    });
    const ctx = new FakeAudioContext();
    await build(ctx);
    run(ctx, 0, 0.06);
    launchScene(0);
    run(ctx, 0.06, 0.3);
    liveData().queued = ['stop', null, null, null, null, null, null, null]; // the only scene lane
    run(ctx, 0.3, 3.0);
    expect(playing()[0] ?? null, 'stopped and stays stopped').toBeNull();
    expect(readSceneLaunch(liveData())?.n, 'no auto-launch after the manual stop').toBe(1);
  });

  it('transport restart resets the LIVE countdown (runtime-only; the stored count is untouched)', async () => {
    seed({
      clips: { [clipIndex(0, 0)]: noteClip(4), [clipIndex(1, 0)]: noteClip(4) },
      sceneRepeats: { '0': 2 }, // unit 0.5 s → 2 passes = 1.0 s
    });
    const ctx = new FakeAudioContext();
    await build(ctx);
    run(ctx, 0, 0.06);
    launchScene(0);
    run(ctx, 0.06, 0.6); // ~1 pass done
    (livePatch.nodes['tl']!.params as Record<string, number>).running = 0;
    run(ctx, 0.6, 0.9);
    (livePatch.nodes['tl']!.params as Record<string, number>).running = 1;
    // The countdown re-anchored at the restart: ~1 unit later still nothing —
    run(ctx, 0.9, 1.5);
    expect(playing()[0]).toBe(0);
    // — and ~2 units after the restart the advance fires.
    run(ctx, 1.5, 2.6);
    expect(playing()[0]).toBe(1);
    expect(liveData().sceneRepeats).toEqual({ '0': 2 }); // stored count untouched
  });

  it('a DUPLICATE advance write (concurrent-peer race) is a clean no-op — no restart, no double-launch', async () => {
    seed({
      clips: { [clipIndex(0, 0)]: noteClip(4), [clipIndex(1, 0)]: noteClip(4) },
      sceneRepeats: { '0': 1 },
    });
    const ctx = new FakeAudioContext();
    const handle = await build(ctx);
    run(ctx, 0, 0.06);
    launchScene(0);
    run(ctx, 0.06, 1.4);
    expect(playing()[0]).toBe(1); // advanced to scene 1
    // A concurrent peer's identical advance write lands late:
    launchScene(1);
    run(ctx, 1.4, 1.5);
    expect(handle.read!('activeLane:0'), 'lane keeps playing slot 1').toBe(1);
    run(ctx, 1.5, 2.4);
    expect(playing()[0]).toBe(1);
    expect((liveData().queued ?? []).every((q) => q === null || q === undefined)).toBe(true);
  });

  it('arrangement mode disables scene-repeat tracking entirely', async () => {
    seed({
      clips: { [clipIndex(0, 0)]: noteClip(4), [clipIndex(1, 0)]: noteClip(4) },
      sceneRepeats: { '0': 1 },
      clipMode: 'arrangement',
    });
    const ctx = new FakeAudioContext();
    await build(ctx);
    run(ctx, 0, 0.06);
    launchScene(0); // the marker fires, but arrangement mode nulls the tracker
    run(ctx, 0.06, 2.0);
    expect(readSceneLaunch(liveData())?.n, 'no auto-launch in arrangement mode').toBe(1);
  });

  it('repeats stay DECOUPLED from automation: carrier clips advance on the identical schedule', async () => {
    // Both scenes' clips carry automation records; the countdown must be
    // byte-identical to the no-automation case (the advance reuses the same
    // setLaneActive seam automation playback hooks — deep envelope continuity
    // is covered by the clip-automation integration suite).
    seed({
      clips: { [clipIndex(0, 0)]: noteClip(4), [clipIndex(1, 0)]: noteClip(4) },
      auto: {
        [String(clipIndex(0, 0))]: { tracks: { 'osc::freq': { events: [{ step: 0, value: 0.2 }, { step: 2, value: 0.8 }] } } },
        [String(clipIndex(1, 0))]: { tracks: { 'osc::freq': { events: [{ step: 0, value: 0.9 }] } } },
      },
      sceneRepeats: { '0': 2 },
    });
    const ctx = new FakeAudioContext();
    await build(ctx);
    run(ctx, 0, 0.06);
    launchScene(0);
    run(ctx, 0.06, 0.7);
    expect(playing()[0], 'both passes play (no early advance)').toBe(0);
    run(ctx, 0.7, 2.2);
    expect(playing()[0], 'the carrier scene advanced on the normal schedule').toBe(1);
    // The clips' automation records rode along untouched.
    expect(Object.keys((liveData().auto ?? {})[String(clipIndex(1, 0))]?.tracks ?? {})).toEqual(['osc::freq']);
  });

  it('BLOCKER regression: a ×N scene launched while a FOREIGN individual clip still plays tracks + advances (grace from the real playing set)', async () => {
    // No tracker is live (no scene was ever launched) and lane 1 plays an
    // individual clip at slot 5. Launching scene 0 (×1) must NOT read that
    // still-playing lane as a deviation on its own first tick — the fresh
    // tracker's transition grace comes from the ACTUAL synced playing set.
    seed({
      clips: {
        [clipIndex(0, 0)]: noteClip(4),
        [clipIndex(1, 0)]: noteClip(4), // the advance target
        [clipIndex(5, 1)]: noteClip(4), // the individually-launched foreign clip
      },
      sceneRepeats: { '0': 1 },
    });
    const ctx = new FakeAudioContext();
    await build(ctx);
    run(ctx, 0, 0.06);
    liveData().queued = [null, 5, null, null, null, null, null, null]; // individual launch
    run(ctx, 0.06, 0.3);
    expect(playing()[1]).toBe(5);
    launchScene(0); // the ×1 scene, pressed while lane 1 still plays slot 5
    run(ctx, 0.3, 1.8);
    expect(playing()[0], 'the repeat advance fired — tracking survived the launch').toBe(1);
    expect(readSceneLaunch(liveData())?.n, 'the advance went through the seam').toBe(2);
  });

  it('BLOCKER regression (reload-adopt): after adopting a persisted marker + playing set, the NEXT ×N launch tracks + advances', async () => {
    // A loaded patch: lanes already playing scene 0, a stale marker present.
    // The first tick adopts WITHOUT firing (no tracker). Launching scene 1
    // (×1) while scene 0 still plays must track (grace = {0}) and advance.
    seed({
      clips: {
        [clipIndex(0, 0)]: noteClip(4),
        [clipIndex(1, 0)]: noteClip(4),
        [clipIndex(2, 0)]: noteClip(4),
      },
      sceneRepeats: { '1': 1 },
      playing: [0, null, null, null, null, null, null, null],
      sceneLaunch: { slot: 0, n: 7 }, // persisted from the previous session
    });
    const ctx = new FakeAudioContext();
    await build(ctx);
    run(ctx, 0, 0.15); // adopt-without-fire; lanes resume playing slot 0
    expect(playing()[0]).toBe(0);
    launchScene(1);
    run(ctx, 0.15, 2.2);
    expect(playing()[0], 'scene 1 counted its pass and advanced to scene 2').toBe(2);
    expect(readSceneLaunch(liveData())).toEqual({ slot: 2, n: 9 });
  });

  it('BOUNDARY FLOOR: an IDLE target lane starts ON the section boundary, on-grid (never at the early write)', async () => {
    // Scene 0 = lane 0 only; scene 1 = lane 1 only, so lane 1 is IDLE when the
    // deliberately-early advance write lands. Without the floor it would start
    // immediately (~0.35 s before the boundary) at an arbitrary grid anchor.
    seed({
      clips: { [clipIndex(0, 0)]: noteClip(4), [clipIndex(1, 1)]: noteClip(4) },
      sceneRepeats: { '0': 1 },
    });
    const ctx = new FakeAudioContext();
    const handle = await build(ctx);
    run(ctx, 0, 0.06);
    launchScene(0);
    run(ctx, 0.06, 1.4);
    expect(playing()[1]).toBe(1);
    const firstHigh = (lane: number) =>
      gateOf(handle as never, lane).events.find((e) => e.value >= 0.5)!.time;
    const t0 = firstHigh(0); // scene 0's audible start
    const boundary = t0 + 0.5; // unit = 4 steps × 0.125 s
    const lane1Start = firstHigh(1);
    expect(lane1Start, 'idle target lane waits for the boundary').toBeGreaterThanOrEqual(boundary - 0.03);
    expect(lane1Start, 'and starts right on it (on-grid anchor)').toBeLessThanOrEqual(boundary + 0.13);
  });

  it('BOUNDARY FLOOR: an outgoing lane with a loop SHORTER than one anchor step cannot flip before the boundary', async () => {
    // Anchor = lane 0 (8 steps at 1x → unit 1.0 s, anchor step 0.125 s).
    // Lane 1 plays a 2-step clip at 4x (loop 62.5 ms) — its wraps land inside
    // the advance write's early window; without the floor it would switch up
    // to ~0.15 s before the boundary. The slot-1 clip's velocity (127 → 1.0)
    // distinguishes it from slot 0's (100 → ~0.79) on the vel bus.
    const fast = noteClip(2);
    fast.div = 5; // 4x
    fast.steps = [{ step: 0, midi: 60, velocity: 100, lengthSteps: 1 }]; // quiet (~0.79 on the vel bus)
    const target = noteClip(4);
    target.steps = [{ step: 0, midi: 60, velocity: 127, lengthSteps: 1 }]; // loud (1.0)
    seed({
      clips: {
        [clipIndex(0, 0)]: noteClip(8),
        [clipIndex(0, 1)]: fast,
        [clipIndex(1, 1)]: target,
      },
      sceneRepeats: { '0': 1 },
    });
    const ctx = new FakeAudioContext();
    const handle = await build(ctx);
    run(ctx, 0, 0.06);
    launchScene(0);
    run(ctx, 0.06, 1.8);
    expect(playing()[1]).toBe(1);
    const gate0 = gateOf(handle as never, 0).events.find((e) => e.value >= 0.5)!.time;
    const boundary = gate0 + 1.0; // 8 × 0.125 s
    const vel1 = (handle.outputs.get('vel2')!.node as unknown as { offset: { events: { value: number; time: number }[] } })
      .offset.events;
    const firstLoud = vel1.find((e) => e.value > 0.9)!;
    expect(firstLoud.time, 'the short-loop lane switched AT/after the boundary').toBeGreaterThanOrEqual(boundary - 0.04);
  });

  it('marker {slot,n} PAIR compare: a same-n DIFFERENT-slot marker (the concurrent-launch LWW loser view) re-anchors instead of cancelling', async () => {
    seed({
      clips: {
        [clipIndex(0, 0)]: noteClip(4),
        [clipIndex(3, 0)]: noteClip(4),
        [clipIndex(4, 0)]: noteClip(4),
      },
      sceneRepeats: { '3': 1 },
    });
    const ctx = new FakeAudioContext();
    await build(ctx);
    run(ctx, 0, 0.06);
    launchScene(0); // marker {0, n:1}
    run(ctx, 0.06, 0.3);
    // The LWW result of a concurrent peer's scene-3 launch: SAME n, new slot.
    const d = liveData();
    d.sceneLaunch = { slot: 3, n: 1 };
    d.queued = [3, 'stop', 'stop', 'stop', 'stop', 'stop', 'stop', 'stop'];
    run(ctx, 0.3, 2.2);
    // Re-anchored to scene 3 (not a spurious cancel) → its ×1 advance fired.
    expect(playing()[0]).toBe(4);
    expect(readSceneLaunch(liveData())?.n).toBe(2);
  });

  it('NO one-shot latch: adding a content scene BELOW after the boundary passed re-arms the advance', async () => {
    seed({
      clips: { [clipIndex(0, 0)]: noteClip(4) },
      sceneRepeats: { '0': 1 },
    });
    const ctx = new FakeAudioContext();
    await build(ctx);
    run(ctx, 0, 0.06);
    launchScene(0);
    run(ctx, 0.06, 1.6); // boundary long past, no content below → keeps looping
    expect(playing()[0]).toBe(0);
    expect(readSceneLaunch(liveData())?.n).toBe(1);
    liveData().clips![String(clipIndex(2, 1))] = noteClip(4); // content appears below
    run(ctx, 1.6, 2.8);
    expect(playing()[1], 'the advance re-armed and fired into the new scene').toBe(2);
    expect(playing()[0] ?? null).toBeNull(); // scene 2 has no lane-0 clip
    expect(readSceneLaunch(liveData())?.slot).toBe(2);
  });

  it('FLAIR honesty: on the LAST content scene the countdown read reverts to -1 once done ≥ N (never a perpetual N/N)', async () => {
    seed({
      clips: { [clipIndex(0, 0)]: noteClip(4) },
      sceneRepeats: { '0': 2 },
    });
    const ctx = new FakeAudioContext();
    const handle = await build(ctx);
    run(ctx, 0, 0.06);
    launchScene(0);
    run(ctx, 0.06, 0.8); // mid pass 2 — genuinely counting
    expect(handle.read!('sceneRepeat:slot')).toBe(0);
    expect(handle.read!('sceneRepeat:done')).toBe(1);
    run(ctx, 0.8, 1.6); // done ≥ 2, no scene below → nothing is scheduled
    expect(playing()[0], 'still looping (last content scene)').toBe(0);
    expect(handle.read!('sceneRepeat:slot'), 'countdown display released').toBe(-1);
    expect(liveData().sceneRepeats, 'the stored count is untouched').toEqual({ '0': 2 });
  });

  it('live progress reads: sceneRepeat:slot/done/total track the pass ordinal', async () => {
    seed({
      clips: { [clipIndex(0, 0)]: noteClip(4), [clipIndex(1, 0)]: noteClip(4) },
      sceneRepeats: { '0': 3 },
    });
    const ctx = new FakeAudioContext();
    const handle = await build(ctx);
    run(ctx, 0, 0.06);
    expect(handle.read!('sceneRepeat:slot'), 'no tracking before a launch').toBe(-1);
    launchScene(0);
    run(ctx, 0.06, 0.3); // mid pass 1
    expect(handle.read!('sceneRepeat:slot')).toBe(0);
    expect(handle.read!('sceneRepeat:done')).toBe(0);
    expect(handle.read!('sceneRepeat:total')).toBe(3);
    run(ctx, 0.3, 0.8); // into pass 2
    expect(handle.read!('sceneRepeat:done')).toBe(1);
  });
});
