// packages/web/src/lib/audio/modules/clip-automation-integration.test.ts
//
// INTEGRATION test for the clipplayer ↔ automation WIRING (task #183). The pure
// record/playback cores + the AutomationController are unit-tested elsewhere
// (clip-automation-*.test.ts). This proves the CLIPPLAYER-side composition: the
// injected deps the factory builds (readNorm store-tap, curve/unitNorm, the
// transient engine-driven `drive`, the whole-clip plain `commit`) satisfy the
// project's HARD constraints against a REAL @syncedstore/core Y.Doc + a FAKE
// engine (mirrors the real-Y.Doc discipline of midi-learn.test.ts /
// yjs-save-load-real-ydoc):
//
//   1. PLAYBACK writes ZERO Yjs — playbackStep→drive only schedules on the
//      engine; the doc's update count is unchanged across N ticks.
//   2. RECORD commits ONCE per pass — a whole-clip PLAIN reassign into d.clips;
//      exactly one Yjs transaction fires for the commit.
//   3. SINGLE-WRITER — the isAutomationRecorder gate the clipplayer runs makes
//      recordTick a no-op on a non-matching clientId (no commit, no Yjs).
//   6. curve-aware value domain — read via valueToFrac, drive via fracToValue.
//
// The deps here are byte-for-byte the ones clipplayer.ts constructs, just wired
// to the test doc + fake engine instead of the global store + live PatchEngine.

import { describe, it, expect } from 'vitest';
import { syncedStore, getYjsDoc } from '@syncedstore/core';
import { valueToFrac, fracToValue } from '$lib/electra/curve';
import type { KnobCurve } from '$lib/graph/types';
import {
  AutomationController,
  type AutomationControllerDeps,
} from './clip-automation-controller';
import type { RampPoint } from './clip-automation-engine';
import {
  readClip,
  clipIndex,
  isAutomationRecorder,
  type ClipPlayerData,
  type AutomationClipRecord,
  type AutomationTarget,
  type AutomationTrack,
} from './clip-types';

// ── test harness ────────────────────────────────────────────────────────────

interface StoreNode {
  id: string;
  type: string;
  domain: string;
  position: { x: number; y: number };
  params: Record<string, number>;
  data?: ClipPlayerData;
}
type Store = { nodes: Record<string, StoreNode> };

/** A fake target ParamDef — min/max/curve only (the fields the deps read). */
interface FakeDef {
  min: number;
  max: number;
  curve: KnobCurve;
}

interface ScheduledWrite {
  nodeId: string;
  paramId: string;
  value: number;
  atTime: number;
  ramp: boolean;
}

const CLIP = 'clipplayer-1';
const TARGET = 'vco-1';
const PARAM = 'freq';
const SLOT = 0;
const LANE = 0;
const IDX = clipIndex(SLOT, LANE); // 0

/**
 * Build the SAME dep set clipplayer.ts wires, bound to a test doc + fake engine.
 * `liveValue()` stands in for the resolved surface param's live store value (the
 * knob position a user is turning); `def` for its ParamDef.
 */
function makeHarness(def: FakeDef) {
  const store = syncedStore<Store>({ nodes: {} });
  const ydoc = getYjsDoc(store);
  const scheduled: ScheduledWrite[] = [];
  // The (slot,lane) the current record pass commits into (clipplayer sets this
  // right before each recordTick; the commit dep reads it).
  let recordTarget: { slot: number; lane: number } | null = null;
  // The resolved surface param's live value (the knob position the store-tap
  // returns). Modeled as a plain var so a "knob move" is NOT itself a Yjs write —
  // that isolates the AUTOMATION's own doc footprint (the commit) from the input
  // it records. readNorm returns exactly what resolveSurfaceParam().get() would.
  let liveValue = 0;

  const resolveDef = (t: AutomationTarget): FakeDef | null =>
    t.nodeId === TARGET && t.paramId === PARAM ? def : null;
  const liveVal = (t: AutomationTarget): number | null =>
    t.nodeId === TARGET && t.paramId === PARAM ? liveValue : null;

  const fakeEngine = {
    scheduleParam(
      node: StoreNode,
      paramId: string,
      value: number,
      atTime: number,
      ramp: boolean,
    ): void {
      scheduled.push({ nodeId: node.id, paramId, value, atTime, ramp });
    },
  };

  const deps: AutomationControllerDeps = {
    // STORE tap → normalized 0..1 (curve-aware). Mirrors resolveSurfaceParam().get().
    readNorm(target) {
      const d = resolveDef(target);
      const v = liveVal(target);
      if (!d || v == null) return null;
      return valueToFrac(v, d.min, d.max, d.curve);
    },
    curve(target) {
      return resolveDef(target)?.curve;
    },
    unitNorm(target) {
      const d = resolveDef(target);
      if (!d) return undefined;
      return d.curve === 'discrete' ? 1 / Math.max(1, d.max - d.min) : undefined;
    },
    // PLAYBACK — transient, ZERO Yjs. Denormalize (curve-aware) + schedule.
    drive(target, points: RampPoint[]) {
      const d = resolveDef(target);
      const node = store.nodes[target.nodeId];
      if (!d || !node) return;
      for (const p of points) {
        fakeEngine.scheduleParam(
          node,
          target.paramId,
          fracToValue(p.value, d.min, d.max, d.curve),
          p.at,
          p.ramp,
        );
      }
    },
    // RECORD — whole-clip PLAIN reassign (never a live Y.Array splice).
    commit(tracks: AutomationTrack[]) {
      const t = recordTarget;
      if (!t) return;
      const rec = readClip(store.nodes[CLIP]?.data, clipIndex(t.slot, t.lane));
      if (!rec || rec.kind !== 'automation') return;
      const plain: AutomationClipRecord = {
        kind: 'automation',
        lengthSteps: rec.lengthSteps,
        loop: rec.loop,
        tracks: tracks.map((tr) => {
          const out: AutomationTrack = {
            target: { nodeId: tr.target.nodeId, paramId: tr.target.paramId },
            events: tr.events.map((e) => ({ step: e.step, value: e.value })),
          };
          if (tr.interp) out.interp = tr.interp;
          return out;
        }),
      };
      const data = store.nodes[CLIP]!.data as ClipPlayerData;
      if (!data.clips) data.clips = {};
      data.clips[String(clipIndex(t.slot, t.lane))] = plain;
    },
  };

  const setRecordTarget = (t: { slot: number; lane: number } | null) => {
    recordTarget = t;
  };
  const setLiveValue = (v: number) => {
    liveValue = v; // a knob move — NOT a Yjs write
  };

  return { store, ydoc, scheduled, deps, setRecordTarget, setLiveValue };
}

/** Seed the target node + an automation clip (with the given tracks) into the doc. */
function seed(
  h: ReturnType<typeof makeHarness>,
  opts: { tracks: AutomationTrack[]; len: number; arm: boolean; recorderId: number; initialParam: number },
): void {
  h.ydoc.transact(() => {
    h.store.nodes[TARGET] = {
      id: TARGET, type: 'x', domain: 'audio',
      position: { x: 0, y: 0 }, params: { [PARAM]: opts.initialParam },
    };
    h.store.nodes[CLIP] = {
      id: CLIP, type: 'clipplayer', domain: 'audio',
      position: { x: 0, y: 0 }, params: {},
      data: {
        clips: {
          [String(IDX)]: {
            kind: 'automation', lengthSteps: opts.len, loop: true, tracks: opts.tracks,
          },
        },
        automation: { arm: opts.arm, recorderId: opts.recorderId },
      },
    };
  });
  h.setLiveValue(opts.initialParam); // seed the store-tap's live value too
}

// ── tests ─────────────────────────────────────────────────────────────────

describe('clipplayer ↔ automation integration (real Y.Doc + fake engine)', () => {
  it('RECORD: a moving store value across a loop commits ONE plain automation clip with breakpoints', () => {
    const def: FakeDef = { min: 0, max: 100, curve: 'linear' };
    const h = makeHarness(def);
    const len = 4;
    seed(h, {
      tracks: [{ target: { nodeId: TARGET, paramId: PARAM }, events: [] }],
      len, arm: true, recorderId: h.ydoc.clientID, initialParam: 0,
    });

    const controller = new AutomationController(h.deps);
    // The clipplayer arm-reconcile: recorder client arms once.
    expect(isAutomationRecorder(h.store.nodes[CLIP]!.data, h.ydoc.clientID)).toBe(true);
    controller.arm();

    // Feed the recorder the audible fractional playhead each tick (as the tick
    // loop does), pushing a moving knob value between ticks. It punches in at the
    // clip's own wrap, then commits ONE pass at the NEXT wrap (continuous overdub
    // keeps recording after).
    const drive = (frac: number) => {
      h.setRecordTarget({ slot: SLOT, lane: LANE });
      const clip = readClip(h.store.nodes[CLIP]!.data, IDX) as AutomationClipRecord;
      controller.recordTick(clip, frac, len);
    };

    // The commit is the ONLY Yjs write the automation makes across ONE pass (knob
    // moves are not synced writes here) — assert exactly ONE transaction fires per
    // wrap (the whole-clip plain reassign).
    let updates = 0;
    const onUpdate = () => { updates++; };
    h.ydoc.on('update', onUpdate);

    // Loop 0 (armed, pre-punch): playhead sweeps 0→3, no capture yet.
    drive(0); drive(1); drive(2); drive(3);
    // Wrap → punch-in. Now capture across loop 1 while the knob moves 0→100.
    h.setLiveValue(0);   drive(0);
    h.setLiveValue(25);  drive(1);
    h.setLiveValue(50);  drive(2);
    h.setLiveValue(100); drive(3);
    drive(0); // wrap → commit pass 1 (recording continues)

    h.ydoc.off('update', onUpdate);
    expect(updates).toBe(1); // constraint 2: commit is exactly ONE transaction per wrap
    expect(controller.recording).toBe(true); // continuous overdub — still recording

    // The committed clip is a PLAIN automation clip with captured breakpoints.
    const out = readClip(h.store.nodes[CLIP]!.data, IDX) as AutomationClipRecord;
    expect(out.kind).toBe('automation');
    expect(out.tracks).toHaveLength(1);
    const events = out.tracks[0]!.events;
    expect(events.length).toBeGreaterThan(1);
    // Values are stored NORMALIZED 0..1 (constraint 6: valueToFrac on capture):
    // the sweep 0→100 in a 0..100 range lands 0→1.
    expect(events[0]!.value).toBeCloseTo(0, 5);
    expect(events[events.length - 1]!.value).toBeCloseTo(1, 5);
    for (const e of events) {
      expect(e.value).toBeGreaterThanOrEqual(0);
      expect(e.value).toBeLessThanOrEqual(1);
    }
  });

  it('CONTINUOUS OVERDUB: arm → 2 passes (each moves a DIFFERENT param) → disarm; the plain clip holds BOTH tracks', () => {
    const def: FakeDef = { min: 0, max: 100, curve: 'linear' };
    const h = makeHarness(def);
    const P_A = 'pa';
    const P_B = 'pb';
    const len = 4;
    // Seed TWO tracks on the target node (two params), both empty.
    h.ydoc.transact(() => {
      h.store.nodes[TARGET] = {
        id: TARGET, type: 'x', domain: 'audio',
        position: { x: 0, y: 0 }, params: { [P_A]: 0, [P_B]: 0 },
      };
      h.store.nodes[CLIP] = {
        id: CLIP, type: 'clipplayer', domain: 'audio', position: { x: 0, y: 0 }, params: {},
        data: {
          clips: { [String(IDX)]: { kind: 'automation', lengthSteps: len, loop: true, tracks: [
            { target: { nodeId: TARGET, paramId: P_A }, events: [] },
            { target: { nodeId: TARGET, paramId: P_B }, events: [] },
          ] } },
          automation: { arm: true, recorderId: h.ydoc.clientID },
        },
      };
    });
    // The harness store-tap reads a single liveValue; override readNorm to read
    // each param's live store value so the two tracks capture independently.
    const live: Record<string, number> = { [P_A]: 0, [P_B]: 0 };
    const deps: AutomationControllerDeps = {
      ...h.deps,
      readNorm: (t) => valueToFrac(live[t.paramId] ?? 0, 0, 100, 'linear'),
    };
    const controller = new AutomationController(deps);
    expect(isAutomationRecorder(h.store.nodes[CLIP]!.data, h.ydoc.clientID)).toBe(true);
    controller.arm();
    const drive = (frac: number) => {
      h.setRecordTarget({ slot: SLOT, lane: LANE });
      const clip = readClip(h.store.nodes[CLIP]!.data, IDX) as AutomationClipRecord;
      controller.recordTick(clip, frac, len);
    };

    // Pre-punch loop, then punch-in.
    drive(0); drive(1); drive(2); drive(3);
    drive(0); // punch-in (pass 1)
    // PASS 1: move A (0→100), B flat.
    live[P_A] = 25; drive(1);
    live[P_A] = 100; drive(2); drive(3);
    drive(0); // wrap → commit pass 1 (A recorded), keep recording
    // PASS 2: move B (0→100), A held flat (no re-move).
    live[P_B] = 40; drive(1);
    live[P_B] = 100; drive(2); drive(3);
    // DISARM mid-loop-2-boundary: stop cleanly right at the wrap-equivalent by
    // driving one more wrap first, then disarm.
    drive(0); // wrap → commit pass 2 (B recorded)
    controller.disarm(); // manual stop (nothing new since the wrap → no extra commit needed)

    // The plain committed clip holds BOTH params' tracks with breakpoints.
    const out = readClip(h.store.nodes[CLIP]!.data, IDX) as AutomationClipRecord;
    expect(out.kind).toBe('automation');
    expect(out.tracks).toHaveLength(2);
    const a = out.tracks.find((t) => t.target.paramId === P_A)!;
    const b = out.tracks.find((t) => t.target.paramId === P_B)!;
    expect(a.events.length).toBeGreaterThan(1);
    expect(b.events.length).toBeGreaterThan(1);
    expect(Math.max(...a.events.map((e) => e.value))).toBeCloseTo(1, 5);
    expect(Math.max(...b.events.map((e) => e.value))).toBeCloseTo(1, 5);
    // Single-writer gate still holds.
    expect(isAutomationRecorder(h.store.nodes[CLIP]!.data, h.ydoc.clientID)).toBe(true);
    expect(controller.recording).toBe(false); // disarmed → idle (no stuck light)
  });

  it('PLAYBACK: a committed automation clip schedules curve-aware ramps and writes ZERO Yjs', () => {
    const def: FakeDef = { min: 0, max: 100, curve: 'linear' };
    const h = makeHarness(def);
    const len = 4;
    const track: AutomationTrack = {
      target: { nodeId: TARGET, paramId: PARAM },
      events: [{ step: 0, value: 0 }, { step: 2, value: 1 }], // ramp 0→1 over steps 0..2
    };
    seed(h, { tracks: [track], len, arm: false, recorderId: h.ydoc.clientID, initialParam: 0 });

    const controller = new AutomationController(h.deps);
    // NOT armed/recording → playbackStep drives (no self-capture suppression).
    expect(controller.recording).toBe(false);

    // Subscribe to the doc: playback must not fire a single update.
    let updates = 0;
    const onUpdate = () => { updates++; };
    h.ydoc.on('update', onUpdate);

    const laneDur = 0.1;
    const clip = readClip(h.store.nodes[CLIP]!.data, IDX) as AutomationClipRecord;
    for (let step = 0; step < len; step++) {
      const emitAt = 10 + step * laneDur;
      for (const tr of clip.tracks) controller.playbackStep(tr, step, laneDur, emitAt);
    }

    h.ydoc.off('update', onUpdate);
    expect(updates).toBe(0); // constraint 1: PLAYBACK writes ZERO Yjs

    // The fake engine received denormalized, curve-aware, future-timed writes.
    expect(h.scheduled.length).toBeGreaterThan(0);
    for (const s of h.scheduled) {
      expect(s.nodeId).toBe(TARGET);
      expect(s.paramId).toBe(PARAM);
      expect(s.atTime).toBeGreaterThanOrEqual(10); // scheduled in the FUTURE
      expect(s.value).toBeGreaterThanOrEqual(0);
      expect(s.value).toBeLessThanOrEqual(100); // denormalized into the 0..100 range
    }
    // Step 0 anchors at the envelope start (value 0 → 0), and by step 2 the ramp
    // reaches the top breakpoint (value 1 → 100).
    const first = h.scheduled[0]!;
    expect(first.atTime).toBeCloseTo(10, 5);
    expect(first.value).toBeCloseTo(0, 5);
    expect(first.ramp).toBe(false); // first point is a hard anchor
    const top = h.scheduled.find((s) => Math.abs(s.value - 100) < 1e-6);
    expect(top).toBeTruthy(); // the ramp reaches the denormalized max somewhere
  });

  it('SINGLE-WRITER: recordTick is gated off for a non-matching clientId (no commit, no Yjs)', () => {
    const def: FakeDef = { min: 0, max: 100, curve: 'linear' };
    const h = makeHarness(def);
    const len = 4;
    // recorderId is a DIFFERENT client than this doc's clientID.
    const otherClient = h.ydoc.clientID + 1;
    seed(h, {
      tracks: [{ target: { nodeId: TARGET, paramId: PARAM }, events: [] }],
      len, arm: true, recorderId: otherClient, initialParam: 0,
    });

    // The gate the clipplayer runs: this client is NOT the recorder.
    expect(isAutomationRecorder(h.store.nodes[CLIP]!.data, h.ydoc.clientID)).toBe(false);

    const controller = new AutomationController(h.deps);
    let updates = 0;
    const onUpdate = () => { updates++; };
    h.ydoc.on('update', onUpdate);

    // Replicate the tick gate: a non-recorder NEVER arms nor calls recordTick.
    const tick = (frac: number) => {
      if (!isAutomationRecorder(h.store.nodes[CLIP]!.data, h.ydoc.clientID)) return; // no-op
      h.setRecordTarget({ slot: SLOT, lane: LANE });
      const clip = readClip(h.store.nodes[CLIP]!.data, IDX) as AutomationClipRecord;
      controller.recordTick(clip, frac, len);
    };
    // Drive a full arm→capture→wrap sequence with a moving value; all no-ops.
    for (const frac of [0, 1, 2, 3, 0, 1, 2, 3, 0]) { h.setLiveValue(frac * 10); tick(frac); }

    h.ydoc.off('update', onUpdate);
    expect(updates).toBe(0); // no commit fired → zero Yjs writes
    // The clip is untouched: still the empty seeded track.
    const out = readClip(h.store.nodes[CLIP]!.data, IDX) as AutomationClipRecord;
    expect(out.tracks[0]!.events).toHaveLength(0);
  });
});
