// packages/web/src/lib/audio/modules/clipplayer-automation-seams.test.ts
//
// FACTORY-LEVEL tests for the param-jump policy SEAMS (Phase 0 adversarial
// fixes): drives the REAL clipplayer factory + tick loop against a fake
// AudioContext, the live graph store, and a FAKE active engine that records
// every scheduleParam/holdParam call IN ORDER (with the audio clock at call
// time), so the seam ORDERING itself is asserted:
//
//  1. SAME-TICK ORDERING (fix #1): a quantized switch away from an automating
//     clip must NOT cancel-at-now after the incoming clip's step-0 events are
//     scheduled — no hold may appear in the log after the incoming clip's first
//     scheduled point, and a SHARED param gets no resting pin at all (the
//     incoming glide takes over at the boundary).
//  2. BOUNDARY PIN (fixes #1+#2): a non-shared outgoing param is pinned WITH an
//     explicit resting value AT the boundary time (a FUTURE pin — atTime is
//     ahead of the clock at call time), never a cancel at "now" that would
//     truncate the outgoing tail ~200 ms early.
//  3. QUANTIZED STOP (fix #3): an immediate stop's resting value is computed at
//     an INTEGER step of the envelope (peer-convergent), at a near-now atTime.
//  4. DISPOSE (fix #4): deleting the player while automation plays holds the
//     target params (no ghost-tail-then-freeze on the dispose path).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Capture the scheduler-clock tick so we can drive it manually.
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
import { setActiveEngine } from '$lib/audio/engine-ref';
import type { PatchEngine } from '$lib/audio/engine';
// Register the module defs — resolveSurfaceParam (the automation target
// resolver) reads the target's ParamDef ('vca'.base) from the registry.
import '$lib/audio/modules';
import { clipplayerDef } from './clipplayer';
import {
  clipIndex,
  automationTargetKey,
  type AutoClipRecord,
  type NoteClipRecord,
  type AutomationEvent,
} from './clip-types';
import { SEAM_GLIDE_S } from './clip-automation-engine';

// ---- Minimal fake AudioContext (same shape as clipplayer.test.ts) ----
class FakeParam {
  value = 0;
  setValueAtTime(value: number) {
    this.value = value;
    return this;
  }
  cancelScheduledValues() {
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
class FakeAnalyser {
  fftSize = 2048;
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

const NODE_ID = 'cp1';

/** One ordered engine-call record. `now` = the audio clock AT CALL TIME, so a
 *  "near-now cancel" vs a "future boundary pin" is directly distinguishable. */
type EngineCall =
  | { kind: 'schedule'; nodeId: string; paramId: string; value: number; atTime: number; ramp: boolean; now: number }
  | { kind: 'hold'; nodeId: string; paramId: string; atTime: number; toValue: number | undefined; glideS: number | undefined; now: number };

function makeFakeEngine(ctx: FakeAudioContext) {
  const log: EngineCall[] = [];
  const engine = {
    scheduleParam(node: { id: string }, paramId: string, value: number, atTime: number, ramp: boolean) {
      log.push({ kind: 'schedule', nodeId: node.id, paramId, value, atTime, ramp, now: ctx.currentTime });
    },
    holdParam(node: { id: string }, paramId: string, atTime: number, toValue?: number, glideS?: number) {
      log.push({ kind: 'hold', nodeId: node.id, paramId, atTime, toValue, glideS, now: ctx.currentTime });
    },
    setDisplayParam() {},
  } as unknown as PatchEngine;
  return { engine, log };
}

function clearPatch() {
  for (const k of Object.keys(livePatch.nodes)) delete livePatch.nodes[k];
  for (const k of Object.keys(livePatch.edges)) delete livePatch.edges[k];
}
function lane8<T>(lane: number, val: T, fill: T): T[] {
  const a = new Array<T>(8).fill(fill);
  a[lane] = val;
  return a;
}
/** A NOTE clip (empty pattern, `len` steps) + its SIBLING auto record driving
 *  `nodeId`.base — the per-clip model: the note clip goes in `clips[k]`, the
 *  envelope in `auto[k]` keyed by targetKey. */
function noteWithAuto(
  nodeId: string,
  events: AutomationEvent[],
  len = 8,
): { clip: NoteClipRecord; auto: AutoClipRecord } {
  return {
    clip: { kind: 'note', steps: [], lengthSteps: len, root: 48, loop: true },
    auto: { tracks: { [automationTargetKey({ nodeId, paramId: 'base' })]: { events } } },
  };
}
function seedVca(id: string, base = 0.5) {
  livePatch.nodes[id] = {
    id, type: 'vca', domain: 'audio', position: { x: 0, y: 0 }, params: { base }, data: {},
  } as never;
}
function seedPlayer(
  cells: Record<string, { clip: NoteClipRecord; auto: AutoClipRecord }>,
  launchSlot: number,
) {
  const clips: Record<string, NoteClipRecord> = {};
  const auto: Record<string, AutoClipRecord> = {};
  for (const [k, v] of Object.entries(cells)) {
    clips[k] = v.clip;
    auto[k] = v.auto;
  }
  livePatch.nodes[NODE_ID] = {
    id: NODE_ID,
    type: 'clipplayer',
    domain: 'audio',
    position: { x: 0, y: 0 },
    params: { stepDiv: 2, quantize: 1, octave: 0, gateLength: 0.5 },
    data: { clips, auto, queued: lane8<number | null>(0, launchSlot, null) },
  } as never;
}
function seedTimelorde(running: number, bpm = 120) {
  livePatch.nodes['tl'] = {
    id: 'tl', type: 'timelorde', domain: 'audio', position: { x: 0, y: 0 }, params: { running, bpm }, data: {},
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
function queueSlot(slot: number | 'stop') {
  (livePatch.nodes[NODE_ID]!.data as Record<string, unknown>).queued = lane8<number | 'stop' | null>(
    0, slot, null,
  );
}

// A's envelope stays HIGH (0.6..0.9); B's stays LOW (0.1..0.3) — so which clip a
// scheduled point came from is legible from its value range.
const ENV_A: AutomationEvent[] = [{ step: 0, value: 0.8 }, { step: 8, value: 0.6 }];
const ENV_B: AutomationEvent[] = [{ step: 0, value: 0.2 }, { step: 8, value: 0.3 }];

// stepDiv 2 @120bpm → 0.125 s/step; len 8 → a 1 s loop (first launch anchors at
// ~0.01 s, so the first boundary lands at ~1.01 s).

beforeEach(() => {
  hoisted.tick = null;
  clearPatch();
});
afterEach(() => {
  setActiveEngine(null);
});

describe('clipplayer automation seams (factory-level, ordered engine log)', () => {
  it('fix #1 ORDERING: a boundary switch between clips sharing a param never cancels after the incoming clip schedules (shared param: anchors only, no resting pin)', async () => {
    seedVca('va', 0.5);
    seedPlayer(
      { [clipIndex(0, 0)]: noteWithAuto('va', ENV_A), [clipIndex(1, 0)]: noteWithAuto('va', ENV_B) },
      0,
    );
    seedTimelorde(1);
    const ctx = new FakeAudioContext();
    const { engine, log } = makeFakeEngine(ctx);
    setActiveEngine(engine);
    const handle = await build(ctx);

    run(ctx, 0, 0.6); // launch A (immediate first launch), play half a loop
    expect(
      log.some((e) => e.kind === 'schedule' && e.paramId === 'base' && e.value >= 0.55),
      'A (high envelope) is playing',
    ).toBe(true);

    queueSlot(1); // queue B — applies at the ~1.01 s loop boundary
    run(ctx, 0.6, 1.8);

    // B took over (low-envelope points scheduled).
    const bFirst = log.findIndex((e) => e.kind === 'schedule' && e.value <= 0.45);
    expect(bFirst, 'B (low envelope) scheduled after the switch').toBeGreaterThan(0);

    // THE ORDERING FIX: nothing may hold/cancel the param AFTER the incoming
    // clip's events are scheduled — the old post-loop stop-detect fired a
    // cancel-at-now here and wiped B's fresh step-0 anchor/glide.
    const holdsAfterB = log.slice(bFirst).filter((e) => e.kind === 'hold');
    expect(holdsAfterB, 'no hold fires after the incoming clip scheduled').toEqual([]);

    // SHARED param: no resting pin anywhere — the boundary seam SKIPS params the
    // incoming clip drives (its step-0 glide takes over). The only holds are the
    // switch-INTO anchors (no explicit value — the engine pins its cached
    // intrinsic at the anchor time).
    for (const h of log.filter((e) => e.kind === 'hold')) {
      expect(h.toValue, 'anchor-only holds on a shared param').toBeUndefined();
    }
    handle.dispose();
  });

  it('fix #1+#2 BOUNDARY PIN: a non-shared outgoing param pins its explicit resting value AT the boundary (a future pin, not a cancel at now)', async () => {
    seedVca('va', 0.5);
    seedVca('vb', 0.5);
    seedPlayer(
      { [clipIndex(0, 0)]: noteWithAuto('va', ENV_A), [clipIndex(1, 0)]: noteWithAuto('vb', ENV_B) },
      0,
    );
    seedTimelorde(1);
    const ctx = new FakeAudioContext();
    const { engine, log } = makeFakeEngine(ctx);
    setActiveEngine(engine);
    const handle = await build(ctx);

    run(ctx, 0, 0.6);
    queueSlot(1);
    run(ctx, 0.6, 1.8);

    // va (outgoing, NOT driven by B) got exactly one resting pin…
    const vaPins = log.filter(
      (e): e is Extract<EngineCall, { kind: 'hold' }> =>
        e.kind === 'hold' && e.nodeId === 'va' && e.toValue != null,
    );
    expect(vaPins.length, 'one hold-last-value pin for the outgoing param').toBe(1);
    const pin = vaPins[0]!;
    // …with the DETERMINISTIC envelope value at the loop end (ENV_A at step 8 =
    // 0.6; vca base is 0..1 linear so denormalized == normalized)…
    expect(pin.toValue).toBeCloseTo(0.6, 9);
    expect(pin.glideS).toBeCloseTo(SEAM_GLIDE_S, 9);
    // …AT the boundary — a FUTURE atTime relative to the clock when it fired
    // (the old bug cancelled at "now", truncating the outgoing tail early).
    expect(pin.atTime - pin.now, 'pinned at the boundary, ahead of now').toBeGreaterThan(0.05);
    // And the incoming clip's param (vb) is anchored before its first schedule.
    const vbFirstSched = log.findIndex((e) => e.kind === 'schedule' && e.nodeId === 'vb');
    const vbAnchor = log.findIndex((e) => e.kind === 'hold' && e.nodeId === 'vb');
    expect(vbAnchor, 'switch-INTO anchor exists for the incoming param').toBeGreaterThanOrEqual(0);
    expect(vbAnchor, 'anchor precedes the incoming schedule').toBeLessThan(vbFirstSched);
    handle.dispose();
  });

  it('fix #3 QUANTIZED STOP: a transport stop pins the envelope value at an INTEGER step (peer-convergent), near now', async () => {
    seedVca('va', 0.5);
    // A linear 0→0.8 ramp over 8 steps ⇒ the value at integer step k is k*0.1 —
    // so "quantized to the step grid" is directly checkable on the pin value.
    seedPlayer({ [clipIndex(0, 0)]: noteWithAuto('va', [{ step: 0, value: 0 }, { step: 8, value: 0.8 }]) }, 0);
    seedTimelorde(1);
    const ctx = new FakeAudioContext();
    const { engine, log } = makeFakeEngine(ctx);
    setActiveEngine(engine);
    const handle = await build(ctx);

    run(ctx, 0, 0.56); // mid-loop (audible ~step 4)
    livePatch.nodes['tl']!.params.running = 0; // stop the transport
    run(ctx, 0.56, 0.66); // the stop tick fires the hold

    const pins = log.filter(
      (e): e is Extract<EngineCall, { kind: 'hold' }> =>
        e.kind === 'hold' && e.nodeId === 'va' && e.toValue != null,
    );
    expect(pins.length, 'transport stop holds the automated param').toBe(1);
    const pin = pins[0]!;
    // The resting value sits ON the integer-step grid of the envelope (k*0.1).
    const k = Math.round(pin.toValue! / 0.1);
    expect(Math.abs(pin.toValue! - k * 0.1), 'value quantized to an integer step').toBeLessThan(1e-6);
    expect(k).toBeGreaterThan(0); // NOT snapped to zero/default
    // An immediate seam: held at (near) now, not some future time.
    expect(pin.atTime).toBeLessThanOrEqual(pin.now + 0.001);
    handle.dispose();
  });

  it('fix #4 DISPOSE: deleting the player mid-playback holds the automated param (no ghost-tail freeze)', async () => {
    seedVca('va', 0.5);
    seedPlayer({ [clipIndex(0, 0)]: noteWithAuto('va', ENV_A) }, 0);
    seedTimelorde(1);
    const ctx = new FakeAudioContext();
    const { engine, log } = makeFakeEngine(ctx);
    setActiveEngine(engine);
    const handle = await build(ctx);

    run(ctx, 0, 0.6); // playing mid-loop
    const holdsBefore = log.filter((e) => e.kind === 'hold' && e.toValue != null).length;
    handle.dispose();
    const pins = log.filter(
      (e): e is Extract<EngineCall, { kind: 'hold' }> =>
        e.kind === 'hold' && e.nodeId === 'va' && e.toValue != null,
    );
    expect(pins.length, 'dispose pinned the resting value').toBe(holdsBefore + 1);
    expect(pins[pins.length - 1]!.toValue).toBeGreaterThan(0.5); // A's high envelope, not zero
  });

  it('CO-DRIVE: a note clip with NOTES + sibling automation emits notes AND drives its auto tracks in the same lane', async () => {
    seedVca('va', 0.5);
    const cell = noteWithAuto('va', ENV_A);
    cell.clip.steps = [{ step: 0, midi: 60 }, { step: 4, midi: 64 }]; // real notes
    seedPlayer({ [clipIndex(0, 0)]: cell }, 0);
    seedTimelorde(1);
    const ctx = new FakeAudioContext();
    const { engine, log } = makeFakeEngine(ctx);
    setActiveEngine(engine);
    const handle = await build(ctx);

    // Poll the lane's gate output while running — a note step must fire it high.
    let sawGateHigh = false;
    for (let t = 0; t < 1.2; t += 0.025) {
      ctx.currentTime = t;
      hoisted.tick!();
      if ((handle.read?.('gateValue:0') ?? 0) === 1) sawGateHigh = true;
    }
    expect(sawGateHigh, 'the NOTE path emitted (gate went high)').toBe(true);
    // …AND the sibling automation drove the param through the same step loop.
    const autoPoints = log.filter((e) => e.kind === 'schedule' && e.paramId === 'base');
    expect(autoPoints.length, 'automation scheduled alongside the notes').toBeGreaterThan(3);
    handle.dispose();
  });

  it('SINGLE DRIVER: two lanes carrying the SAME param — only the owner drives; assignment moves ownership; the owner’s stop hands over (truncate, no pin)', async () => {
    seedVca('va', 0.5);
    // Lane 0 clip carries a HIGH envelope for va.base; lane 1 clip a LOW one.
    const cellA = noteWithAuto('va', ENV_A, 8); // HIGH (0.6..0.8)
    const cellB = noteWithAuto('va', ENV_B, 8); // LOW (0.2..0.3)
    livePatch.nodes[NODE_ID] = {
      id: NODE_ID,
      type: 'clipplayer',
      domain: 'audio',
      position: { x: 0, y: 0 },
      params: { stepDiv: 2, quantize: 1, octave: 0, gateLength: 0.5 },
      data: {
        clips: { [clipIndex(0, 0)]: cellA.clip, [clipIndex(0, 1)]: cellB.clip },
        auto: { [clipIndex(0, 0)]: cellA.auto, [clipIndex(0, 1)]: cellB.auto },
        queued: (() => { const q = lane8<number | null>(0, 0, null); q[1] = 0; return q; })(),
      },
    } as never;
    seedTimelorde(1);
    const ctx = new FakeAudioContext();
    const { engine, log } = makeFakeEngine(ctx);
    setActiveEngine(engine);
    const handle = await build(ctx);

    // Both lanes launch. UNASSIGNED → the LOWEST carrier (lane 0, HIGH) owns.
    const isBaseSched = (e: EngineCall): e is Extract<EngineCall, { kind: 'schedule' }> =>
      e.kind === 'schedule' && e.paramId === 'base';
    const nodeData = () =>
      (livePatch.nodes[NODE_ID] as unknown as { data: Record<string, unknown> }).data;
    run(ctx, 0, 0.8);
    const early = log.filter(isBaseSched);
    expect(early.length, 'the owner drives').toBeGreaterThan(0);
    expect(
      early.every((e) => e.value >= 0.55),
      'ONLY the owning lane’s (HIGH) envelope is scheduled — the shadowed lane is silent',
    ).toBe(true);

    // ASSIGN module va to lane 1 → ownership moves; the LOW envelope takes
    // over (assignment is MODULE-level; its params follow the module's lane).
    nodeData().autoAssign = { va: 1 };
    const mark = log.length;
    run(ctx, 0.8, 1.9);
    const afterAssign = log.slice(mark).filter(isBaseSched);
    expect(afterAssign.length).toBeGreaterThan(0);
    expect(
      afterAssign.every((e) => e.value <= 0.45),
      'after assignment the LOW (assigned lane 1) envelope owns the param',
    ).toBe(true);

    // STOP the OWNING lane (peer stop) → lane 0 repossesses: the stop must be a
    // TRUNCATE (no resting pin — the survivor takes over), then HIGH resumes.
    const d = nodeData() as { playing?: (number | null)[] };
    const playing = (d.playing ?? []).slice();
    playing[1] = null;
    d.playing = playing;
    const mark2 = log.length;
    run(ctx, 1.9, 3.0);
    const pinsAfterStop = log
      .slice(mark2)
      .filter((e) => e.kind === 'hold' && e.nodeId === 'va' && e.toValue != null);
    expect(pinsAfterStop.length, 'no resting pin — the surviving carrier repossesses').toBe(0);
    const afterStop = log.slice(mark2).filter(isBaseSched);
    expect(
      afterStop.some((e) => e.value >= 0.55),
      'the surviving lane (HIGH) resumed driving after the owner stopped',
    ).toBe(true);
    handle.dispose();
  });

  it('ZOMBIE SWEEP: a retired stamped kind:automation cell + the old pointer are deleted at factory boot; containers initialized', async () => {
    seedVca('va', 0.5);
    livePatch.nodes[NODE_ID] = {
      id: NODE_ID,
      type: 'clipplayer',
      domain: 'audio',
      position: { x: 0, y: 0 },
      params: { stepDiv: 2, quantize: 1 },
      data: {
        sv: 2,
        clips: {
          '448': { kind: 'automation', lengthSteps: 64, loop: true, div: 1, tracks: [] },
          '0': { kind: 'note', steps: [], lengthSteps: 8, root: 48, loop: true },
        },
        automation: { arm: false, recorderId: 1, clip: { lane: 7, slot: 0 } },
        autoAssign: { 'legacy::paramKey': 3 }, // retired param-level key
      },
    } as never;
    seedTimelorde(1);
    const ctx = new FakeAudioContext();
    const { engine } = makeFakeEngine(ctx);
    setActiveEngine(engine);
    const handle = await build(ctx);
    const d = (livePatch.nodes[NODE_ID] as unknown as { data: Record<string, unknown> }).data;
    const clips = d.clips as Record<string, unknown>;
    expect(clips['448'], 'stamped automation zombie deleted').toBeUndefined();
    expect(clips['0'], 'real note clip untouched').toBeTruthy();
    expect((d.automation as Record<string, unknown>).clip, 'legacy pointer deleted').toBeUndefined();
    // CLEAN BREAK (per-lane arm): the retired GLOBAL arm fields are swept too.
    expect((d.automation as Record<string, unknown>).arm, 'legacy global arm deleted').toBeUndefined();
    expect((d.automation as Record<string, unknown>).recorderId, 'legacy recorderId deleted').toBeUndefined();
    // CLEAN BREAK (module assignment): retired `nodeId::paramId` keys swept.
    expect(d.autoAssign, 'legacy param-level assign keys swept').toEqual({});
    expect(d.auto, 'auto container initialized at the load seam').toEqual({});
    handle.dispose();
  });

  it('GHOST GUARD: a pass whose latched clip was DELETED mid-record commits nothing (no resurrected auto[k])', async () => {
    const { notifyAutomationTouch, notifyAutomationRelease } = await import(
      '$lib/audio/automation-touch'
    );
    const { ydoc } = await import('$lib/graph/store');
    seedVca('va', 0.1);
    seedPlayer(
      { [clipIndex(0, 0)]: { clip: { kind: 'note', steps: [], lengthSteps: 8, root: 48, loop: true }, auto: { tracks: {} } } },
      0,
    );
    const data = livePatch.nodes[NODE_ID]!.data as Record<string, unknown>;
    data.autoAssign = { va: 0 }; // MODULE → lane
    data.automation = { lanes: [{ arm: true, recorderId: ydoc.clientID }] }; // lane 0 armed
    seedTimelorde(1);
    const ctx = new FakeAudioContext();
    const { engine } = makeFakeEngine(ctx);
    setActiveEngine(engine);
    const handle = await build(ctx);
    // NOTE: the factory boot sweep runs before the auto container has the shell —
    // the seeded empty shell record survives (it has no tracks).
    run(ctx, 0, 1.05); // punch-in at the first wrap
    notifyAutomationTouch({ nodeId: 'va', paramId: 'base' }, 'pointer');
    livePatch.nodes['va']!.params.base = 0.9; // a big move mid-pass
    run(ctx, 1.05, 1.4);
    // The clip is DELETED mid-pass (a peer wipe / paste-away).
    delete (data.clips as Record<string, unknown>)[String(clipIndex(0, 0))];
    run(ctx, 1.4, 1.8); // the lane stops → punch-out → commit SKIPPED (guard)
    notifyAutomationRelease({ nodeId: 'va', paramId: 'base' }, 'pointer');
    const auto = data.auto as Record<string, { tracks?: Record<string, unknown> }>;
    const tracks = auto?.[String(clipIndex(0, 0))]?.tracks ?? {};
    expect(Object.keys(tracks), 'no take resurrected onto the deleted clip').toEqual([]);
    handle.dispose();
  });

  it('TRANSPORT STOP punches out an in-flight record pass (partial commit at the stop instant — nothing left frozen in controller memory)', async () => {
    const { notifyAutomationTouch, notifyAutomationRelease } = await import(
      '$lib/audio/automation-touch'
    );
    const { ydoc } = await import('$lib/graph/store');
    seedVca('va', 0.1);
    seedPlayer(
      { [clipIndex(0, 0)]: { clip: { kind: 'note', steps: [], lengthSteps: 8, root: 48, loop: true }, auto: { tracks: {} } } },
      0,
    );
    const data = livePatch.nodes[NODE_ID]!.data as Record<string, unknown>;
    data.autoAssign = { va: 0 };
    data.automation = { lanes: { '0': { arm: true, recorderId: ydoc.clientID } } };
    seedTimelorde(1);
    const ctx = new FakeAudioContext();
    const { engine } = makeFakeEngine(ctx);
    setActiveEngine(engine);
    const handle = await build(ctx);

    // Grab BEFORE the wrap → the entry seeds at pass start with the pre-move
    // value (0.1); the mid-pass move to 0.9 is then real motion (maxDev).
    notifyAutomationTouch({ nodeId: 'va', paramId: 'base' }, 'pointer');
    run(ctx, 0, 1.05); // punch-in at the first wrap (~1.01 s)
    livePatch.nodes['va']!.params.base = 0.9; // a big move mid-pass
    run(ctx, 1.05, 1.5);
    // STOP the transport mid-pass → the armed lane's partial pass must commit
    // NOW (the laneStopped punch-out), not sit frozen until restart/disarm.
    livePatch.nodes['tl']!.params.running = 0;
    run(ctx, 1.5, 1.6); // the stop tick fires the punch-out
    notifyAutomationRelease({ nodeId: 'va', paramId: 'base' }, 'pointer');
    const auto = data.auto as Record<string, { tracks?: Record<string, { events?: unknown[] }> }>;
    const track = auto?.[String(clipIndex(0, 0))]?.tracks?.['va::base'];
    expect(track, 'the partial pass committed at the stop instant').toBeTruthy();
    expect((track!.events?.length ?? 0)).toBeGreaterThan(0);
    handle.dispose();
  });

  it('FULL RECORD PATH: assign → arm → touch + move → the factory commits into auto[k] (per-key, real store) + publishes the per-lane countdown', async () => {
    const { notifyAutomationTouch, notifyAutomationRelease } = await import(
      '$lib/audio/automation-touch'
    );
    const { ydoc } = await import('$lib/graph/store');
    const { getAutomationRender } = await import('./clip-automation-render');
    const { isAutomationArmed } = await import('./clip-types');
    seedVca('va', 0.1);
    // A note clip with NO pre-existing automation — recording creates auto[k].
    seedPlayer(
      { [clipIndex(0, 0)]: { clip: { kind: 'note', steps: [], lengthSteps: 8, root: 48, loop: true }, auto: { tracks: {} } } },
      0,
    );
    // Assign MODULE va to lane 0 + arm LANE 0 (this client is its single writer).
    const data = livePatch.nodes[NODE_ID]!.data as Record<string, unknown>;
    data.autoAssign = { va: 0 };
    data.automation = { lanes: [{ arm: true, recorderId: ydoc.clientID }] };
    seedTimelorde(1);
    const ctx = new FakeAudioContext();
    const { engine } = makeFakeEngine(ctx);
    setActiveEngine(engine);
    const handle = await build(ctx);

    // Loop 1 (armed, pre-punch): the playhead sweeps to the first wrap (~1.01 s).
    run(ctx, 0, 1.05);
    expect(isAutomationArmed(livePatch.nodes[NODE_ID]!.data as never)).toBe(true);
    // While armed + playing, the per-lane countdown publishes for lane 0.
    const rs = getAutomationRender(NODE_ID);
    expect(rs, 'per-lane render state published while armed').not.toBeNull();
    expect(rs!.lanes.some((l) => l.lane === 0 && l.recording)).toBe(true);
    // Loop 2: GRAB the knob (touch) and sweep it across the loop.
    notifyAutomationTouch({ nodeId: 'va', paramId: 'base' }, 'pointer');
    const sweep: [number, number][] = [
      [1.1, 0.2], [1.3, 0.4], [1.5, 0.6], [1.7, 0.8], [1.9, 0.95],
    ];
    let t0 = 1.05;
    for (const [t, v] of sweep) {
      livePatch.nodes['va']!.params.base = v; // the knob move (store value)
      run(ctx, t0, t);
      t0 = t;
    }
    // Cross the wrap (~2.01 s) → the pass commits into auto[k].
    run(ctx, t0, 2.2);
    notifyAutomationRelease({ nodeId: 'va', paramId: 'base' }, 'pointer');

    const auto = (livePatch.nodes[NODE_ID]!.data as { auto?: Record<string, { tracks?: Record<string, { events?: unknown[] }> }> }).auto;
    const track = auto?.[String(clipIndex(0, 0))]?.tracks?.['va::base'];
    expect(track, 'the take committed into the sibling auto[k] under the target key').toBeTruthy();
    expect((track!.events?.length ?? 0), 'captured breakpoints').toBeGreaterThan(1);
    handle.dispose();
  });
});
