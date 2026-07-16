// packages/web/src/lib/audio/modules/clip-automation-integration.test.ts
//
// INTEGRATION test for the clipplayer ↔ PER-CLIP automation WIRING (redesign
// Phases 1+2). The pure record/playback cores + the AutomationController are
// unit-tested elsewhere (clip-automation-*.test.ts). This proves the
// CLIPPLAYER-side composition — the injected deps the factory builds (readNorm
// store-tap, curve/unitNorm, the transient engine-driven `drive`, the cached
// `readAutoTracks` merge base, and the PER-KEY `commit` into the sibling
// `auto[k]` map) — against a REAL @syncedstore/core Y.Doc + a FAKE engine
// (mirrors the real-Y.Doc discipline of yjs-save-load-real-ydoc):
//
//   1. PLAYBACK writes ZERO Yjs — playbackStep→drive only schedules on the
//      engine; the doc's update count is unchanged across N ticks.
//   2. RECORD commits ONE transaction per pass — per-KEY writes into
//      `auto[k].tracks[targetKey]`, never a whole-record reassign — and each
//      commit is ONE undo step (transaction-origin scoped).
//   3. THE HEADLINE REGRESSION (note-clobber): a NOTE edit at `clips[k]` and an
//      automation commit at `auto[k]` are DISJOINT keys — a peer's note edit
//      during a recording session clobbers nothing, and a note toggle leaves
//      `auto[k]` byte-identical.
//   4. TWO LANES record concurrently into their OWN clips' auto objects.
//   5. SINGLE-WRITER — the isAutomationRecorder gate the clipplayer runs makes
//      the record path a no-op on a non-matching clientId (no commit, no Yjs).
//   6. curve-aware value domain — read via valueToFrac, drive via fracToValue.
//
// The deps here are byte-for-byte the ones clipplayer.ts constructs, just wired
// to the test doc + fake engine instead of the global store + live PatchEngine.

import { describe, it, expect } from 'vitest';
import { syncedStore, getYjsDoc } from '@syncedstore/core';
import * as Y from 'yjs';
import { valueToFrac, fracToValue } from '$lib/electra/curve';
import type { KnobCurve } from '$lib/graph/types';
import {
  AutomationController,
  type AutomationControllerDeps,
  type AutoTrackUpdate,
} from './clip-automation-controller';
import type { RampPoint } from './clip-automation-engine';
import {
  clipIndex,
  isAutomationRecorder,
  coerceAutoClipRecord,
  autoTrackViews,
  automationTargetKey,
  toggleNoteAt,
  MAX_AUTOMATION_TRACKS,
  type ClipPlayerData,
  type NoteClipRecord,
  type AutoClipRecord,
  type AutoTrack,
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
const KEY = automationTargetKey({ nodeId: TARGET, paramId: PARAM });

/** The commit ORIGIN the harness tags its transactions with (mirrors the app's
 *  LOCAL_ORIGIN discipline so the UndoManager scopes a take-pass to one step). */
const ORIGIN = Symbol('test-local-origin');

/** A fresh note clip for `clips[k]` (the sibling of the auto record). */
function noteClip(len: number, steps: NoteClipRecord['steps'] = []): NoteClipRecord {
  return { kind: 'note', steps, lengthSteps: len, root: 48, loop: true };
}

/**
 * Build the SAME dep set clipplayer.ts wires, bound to a test doc + fake engine.
 * `live` stands in for the resolved surface params' live store values (the knob
 * positions a user is turning); `def` for their shared ParamDef. The commit dep
 * mirrors clipplayer.ts byte-for-byte: per-KEY plain writes into
 * `auto[k].tracks` inside ONE origin-tagged transaction, respecting the cap.
 */
function makeHarness(def: FakeDef) {
  const store = syncedStore<Store>({ nodes: {} });
  const ydoc = getYjsDoc(store);
  const scheduled: ScheduledWrite[] = [];
  const live: Record<string, number> = {};

  const deps: AutomationControllerDeps = {
    // STORE tap → normalized 0..1 (curve-aware). Mirrors resolveSurfaceParam().get().
    readNorm(target) {
      const v = live[`${target.nodeId}::${target.paramId}`];
      if (v == null) return null;
      return valueToFrac(v, def.min, def.max, def.curve);
    },
    curve() {
      return def.curve;
    },
    unitNorm() {
      return def.curve === 'discrete' ? 1 / Math.max(1, def.max - def.min) : undefined;
    },
    // PLAYBACK — transient, ZERO Yjs. Denormalize (curve-aware) + schedule.
    drive(target, points: RampPoint[]) {
      const node = store.nodes[target.nodeId];
      if (!node) return;
      for (const p of points) {
        scheduled.push({
          nodeId: node.id,
          paramId: target.paramId,
          value: fracToValue(p.value, def.min, def.max, def.curve),
          atTime: p.at,
          ramp: p.ramp,
        });
      }
    },
    // The MERGE BASE — the coerced view of auto[k] (clipplayer caches this;
    // the test re-coerces per call, correctness-identical).
    readAutoTracks(idx: number): readonly AutomationTrack[] {
      const raw = (store.nodes[CLIP]?.data as { auto?: Record<string, unknown> } | undefined)
        ?.auto?.[String(idx)];
      if (!raw) return [];
      return autoTrackViews(coerceAutoClipRecord(raw));
    },
    // RECORD — per-KEY plain writes into auto[k].tracks, ONE transaction.
    commit(idx: number, updates: AutoTrackUpdate[]) {
      if (updates.length === 0) return;
      ydoc.transact(() => {
        const data = store.nodes[CLIP]!.data as ClipPlayerData;
        if (!data.auto) data.auto = {};
        if (!data.auto[String(idx)] || typeof data.auto[String(idx)] !== 'object') {
          data.auto[String(idx)] = { tracks: {} };
        }
        const rec = data.auto[String(idx)] as AutoClipRecord;
        if (!rec.tracks || typeof rec.tracks !== 'object') rec.tracks = {};
        let count = Object.keys(rec.tracks).length;
        for (const u of updates) {
          const isNew = !(u.key in rec.tracks);
          if (isNew && count >= MAX_AUTOMATION_TRACKS) continue;
          const prevInterp = (rec.tracks[u.key] as AutoTrack | undefined)?.interp;
          const plain: AutoTrack = {
            events: u.events.map((e) => ({ step: e.step, value: e.value })),
          };
          if (prevInterp === 'linear' || prevInterp === 'hold') plain.interp = prevInterp;
          rec.tracks[u.key] = plain;
          if (isNew) count++;
        }
      }, ORIGIN);
    },
  };

  const setLive = (t: AutomationTarget, v: number) => {
    live[`${t.nodeId}::${t.paramId}`] = v; // a knob move — NOT a Yjs write
  };

  return { store, ydoc, scheduled, deps, setLive };
}

/** Seed the target node + a note clip (+ optional auto sibling) into the doc. */
function seed(
  h: ReturnType<typeof makeHarness>,
  opts: {
    len: number;
    arm: boolean;
    recorderId: number;
    initialParam: number;
    auto?: Record<string, AutoClipRecord>;
    extraClips?: Record<string, NoteClipRecord>;
  },
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
          [String(IDX)]: noteClip(opts.len, [{ step: 0, midi: 60 }]),
          ...(opts.extraClips ?? {}),
        },
        ...(opts.auto ? { auto: opts.auto } : {}),
        automation: { arm: opts.arm, recorderId: opts.recorderId },
        autoAssign: { [KEY]: LANE },
      },
    };
  });
  h.setLive({ nodeId: TARGET, paramId: PARAM }, opts.initialParam);
}

/** Plain JSON snapshot of the auto map (for byte-identical assertions). */
function autoSnapshot(h: ReturnType<typeof makeHarness>): string {
  return JSON.stringify((h.store.nodes[CLIP]!.data as ClipPlayerData).auto ?? null);
}

const T = { nodeId: TARGET, paramId: PARAM };

// ── tests ─────────────────────────────────────────────────────────────────

describe('clipplayer ↔ per-clip automation integration (real Y.Doc + fake engine)', () => {
  it('RECORD: a moving store value across a loop commits ONE transaction, writing ONLY auto[k].tracks[key]', () => {
    const def: FakeDef = { min: 0, max: 100, curve: 'linear' };
    const h = makeHarness(def);
    const len = 4;
    seed(h, { len, arm: true, recorderId: h.ydoc.clientID, initialParam: 0 });

    const controller = new AutomationController(h.deps);
    // The clipplayer arm-reconcile: recorder client arms once.
    expect(isAutomationRecorder(h.store.nodes[CLIP]!.data, h.ydoc.clientID)).toBe(true);
    controller.arm();

    // Snapshot the NOTE clip — it must be untouched by the whole session.
    const noteBefore = JSON.stringify(
      (h.store.nodes[CLIP]!.data as ClipPlayerData).clips![String(IDX)],
    );

    // Feed the recorder the lane's audible fractional playhead each tick (as
    // the tick loop does), pushing a moving knob value between ticks. It
    // punches in at the clip's own wrap, then commits ONE pass at the NEXT
    // wrap (continuous overdub keeps recording after).
    const drive = (frac: number) => {
      controller.notifyTouch(T); // the user is actively holding the knob
      controller.recordLaneTick(LANE, IDX, [T], frac, len);
    };

    // The commit is the ONLY Yjs write the automation makes across ONE pass
    // (knob moves are not synced writes here) — assert exactly ONE transaction.
    let updates = 0;
    const onUpdate = () => { updates++; };
    h.ydoc.on('update', onUpdate);

    // Loop 0 (armed, pre-punch): playhead sweeps 0→3, no capture yet.
    drive(0); drive(1); drive(2); drive(3);
    // Wrap → punch-in. Now capture across loop 1 while the knob moves 0→100.
    h.setLive(T, 0);   drive(0);
    h.setLive(T, 25);  drive(1);
    h.setLive(T, 50);  drive(2);
    h.setLive(T, 100); drive(3);
    drive(0); // wrap → commit pass 1 (recording continues)

    h.ydoc.off('update', onUpdate);
    expect(updates).toBe(1); // constraint 2: commit is exactly ONE transaction per wrap
    expect(controller.recording).toBe(true); // continuous overdub — still recording

    // The committed record lives at auto[k], keyed by targetKey, NORMALIZED 0..1.
    const data = h.store.nodes[CLIP]!.data as ClipPlayerData;
    const rec = coerceAutoClipRecord(data.auto![String(IDX)])!;
    const events = rec.tracks[KEY]!.events;
    expect(events.length).toBeGreaterThan(1);
    expect(events[0]!.value).toBeCloseTo(0, 5);
    expect(events[events.length - 1]!.value).toBeCloseTo(1, 5);
    for (const e of events) {
      expect(e.value).toBeGreaterThanOrEqual(0);
      expect(e.value).toBeLessThanOrEqual(1);
    }
    // …and the sibling NOTE clip at clips[k] is BYTE-IDENTICAL (disjoint keys).
    expect(JSON.stringify(data.clips![String(IDX)])).toBe(noteBefore);
  });

  it('UNDO: each record-pass commit is ONE undo step (transaction-origin scoped)', () => {
    const def: FakeDef = { min: 0, max: 100, curve: 'linear' };
    const h = makeHarness(def);
    const len = 4;
    seed(h, { len, arm: true, recorderId: h.ydoc.clientID, initialParam: 0 });

    // Track ONLY the harness's commit origin (the app tracks LOCAL_ORIGIN).
    const nodesMap = h.ydoc.getMap('nodes');
    const undo = new Y.UndoManager(nodesMap, { trackedOrigins: new Set([ORIGIN]) });

    const controller = new AutomationController(h.deps);
    controller.arm();
    const drive = (frac: number) => {
      controller.notifyTouch(T);
      controller.recordLaneTick(LANE, IDX, [T], frac, len);
    };
    drive(0); drive(1); drive(2); drive(3);
    h.setLive(T, 0); drive(0); // punch-in
    h.setLive(T, 50); drive(1);
    h.setLive(T, 100); drive(2); drive(3);
    drive(0); // wrap → commit pass 1
    expect(undo.undoStack.length, 'one undo step per take-pass commit').toBe(1);

    const data = h.store.nodes[CLIP]!.data as ClipPlayerData;
    expect(coerceAutoClipRecord(data.auto![String(IDX)])!.tracks[KEY]!.events.length)
      .toBeGreaterThan(1);
    undo.undo();
    const after = (h.store.nodes[CLIP]!.data as ClipPlayerData).auto?.[String(IDX)];
    const events = after ? coerceAutoClipRecord(after)?.tracks[KEY]?.events : undefined;
    expect(events == null || events.length === 0, 'undo reverts the whole take-pass').toBe(true);
  });

  it('HEADLINE REGRESSION: a note toggle in clips[k] leaves auto[k] BYTE-IDENTICAL', () => {
    const def: FakeDef = { min: 0, max: 100, curve: 'linear' };
    const h = makeHarness(def);
    const auto: AutoClipRecord = {
      tracks: { [KEY]: { events: [{ step: 0, value: 0.25 }, { step: 3, value: 0.9 }] } },
    };
    seed(h, {
      len: 4, arm: false, recorderId: h.ydoc.clientID, initialParam: 0,
      auto: { [String(IDX)]: auto },
    });

    const before = autoSnapshot(h);
    // The card's note-edit path: toggleNoteAt returns a NEW clip; the write
    // reassigns clips[k] (the note key) — the exact pattern that used to
    // round-trip coerceClipRecord('note') and DROP embedded tracks.
    h.ydoc.transact(() => {
      const data = h.store.nodes[CLIP]!.data as ClipPlayerData;
      const clip = data.clips![String(IDX)] as NoteClipRecord;
      const next = toggleNoteAt(
        { ...clip, steps: clip.steps.map((s) => ({ ...s })) },
        2,
        64,
      );
      data.clips![String(IDX)] = next;
    });
    // The note landed…
    const clip = (h.store.nodes[CLIP]!.data as ClipPlayerData).clips![String(IDX)] as NoteClipRecord;
    expect(clip.steps.some((s) => s.step === 2 && s.midi === 64)).toBe(true);
    // …and the sibling automation is BYTE-IDENTICAL (the note-clobber fix).
    expect(autoSnapshot(h)).toBe(before);
  });

  it('MULTIPLAYER: a peer note-edit DURING a recording session clobbers neither key (disjoint CRDT scopes)', () => {
    const def: FakeDef = { min: 0, max: 100, curve: 'linear' };
    // PEER A (the recorder) + PEER B (the note editor), synced doc-to-doc.
    const a = makeHarness(def);
    const storeB = syncedStore<Store>({ nodes: {} });
    const docB = getYjsDoc(storeB);
    const docA = a.ydoc;
    const pump = (from: Y.Doc, to: Y.Doc) => (u: Uint8Array) => Y.applyUpdate(to, u);
    docA.on('update', pump(docA, docB));
    docB.on('update', pump(docB, docA));

    seed(a, { len: 4, arm: true, recorderId: docA.clientID, initialParam: 0 });
    expect(storeB.nodes[CLIP], 'peer B synced the seed').toBeTruthy();

    const controller = new AutomationController(a.deps);
    controller.arm();
    const drive = (frac: number) => {
      controller.notifyTouch(T);
      controller.recordLaneTick(LANE, IDX, [T], frac, 4);
    };
    drive(0); drive(1); drive(2); drive(3);
    a.setLive(T, 0); drive(0); // punch-in
    a.setLive(T, 40); drive(1);
    // MID-PASS: peer B toggles a note into the SAME clip's note record.
    docB.transact(() => {
      const data = storeB.nodes[CLIP]!.data as ClipPlayerData;
      const clip = data.clips![String(IDX)] as NoteClipRecord;
      const next = toggleNoteAt(
        { kind: 'note', steps: clip.steps.map((s) => ({ ...s })), lengthSteps: clip.lengthSteps, root: clip.root, loop: clip.loop },
        3,
        67,
      );
      data.clips![String(IDX)] = next;
    });
    a.setLive(T, 100); drive(2); drive(3);
    drive(0); // wrap → peer A commits the pass into auto[k]

    // BOTH survive on BOTH peers: the note edit and the automation take.
    for (const [name, store] of [['A', a.store] as const, ['B', storeB] as const]) {
      const data = store.nodes[CLIP]!.data as ClipPlayerData;
      const clip = data.clips![String(IDX)] as NoteClipRecord;
      expect(
        clip.steps.some((s) => s.step === 3 && s.midi === 67),
        `peer ${name}: the mid-record note edit survived the commit`,
      ).toBe(true);
      const rec = coerceAutoClipRecord(data.auto?.[String(IDX)]);
      expect(
        (rec?.tracks[KEY]?.events.length ?? 0) > 1,
        `peer ${name}: the automation take survived the note edit`,
      ).toBe(true);
    }
  });

  it('TWO LANES record CONCURRENTLY into their OWN clips’ auto objects (assign → arm → overdub → disarm)', () => {
    const def: FakeDef = { min: 0, max: 100, curve: 'linear' };
    const h = makeHarness(def);
    const T2 = { nodeId: TARGET, paramId: 'res' };
    const KEY2 = automationTargetKey(T2);
    const LANE2 = 1;
    const IDX2 = clipIndex(0, LANE2); // 64
    seed(h, {
      len: 4, arm: true, recorderId: h.ydoc.clientID, initialParam: 0,
      extraClips: { [String(IDX2)]: noteClip(8) },
    });
    // Assign the second param to lane 1 (the two-lane assignment).
    h.ydoc.transact(() => {
      const data = h.store.nodes[CLIP]!.data as ClipPlayerData;
      data.autoAssign![KEY2] = LANE2;
    });
    h.setLive(T2, 100);

    const controller = new AutomationController(h.deps);
    controller.arm();
    // Interleave the two lanes' ticks — DIFFERENT lengths (4 vs 8), so their
    // wraps land at different times (per-lane windows are independent).
    const tick = (fracA: number, fracB: number) => {
      controller.recordLaneTick(LANE, IDX, [T], fracA, 4);
      controller.recordLaneTick(LANE2, IDX2, [T2], fracB, 8);
    };
    tick(0, 0); tick(1, 1); tick(2, 2); tick(3, 3);
    // Lane 0 wraps first (len 4) → punch-in; lane 1 still climbing.
    controller.notifyTouch(T); controller.notifyTouch(T2);
    h.setLive(T, 20); h.setLive(T2, 80); tick(0, 4);
    h.setLive(T, 60); h.setLive(T2, 50); tick(1, 5);
    h.setLive(T, 100); h.setLive(T2, 20); tick(2, 6);
    tick(3, 7);
    tick(0, 0); // lane 0 wraps (commit A's pass 2… actually pass 1) + lane 1 punches in at ITS wrap
    // Lane 1 records its own pass now.
    h.setLive(T2, 0); tick(1, 1);
    h.setLive(T2, 100); tick(2, 4); tick(3, 6);
    tick(0, 0); // lane 0 wrap + lane 1 mid-loop
    tick(1, 0); // lane 1 wrap → commit B
    controller.disarm();

    const data = h.store.nodes[CLIP]!.data as ClipPlayerData;
    const recA = coerceAutoClipRecord(data.auto![String(IDX)])!;
    const recB = coerceAutoClipRecord(data.auto![String(IDX2)])!;
    // Each clip carries ONLY its own lane's assigned param.
    expect(Object.keys(recA.tracks)).toEqual([KEY]);
    expect(Object.keys(recB.tracks)).toEqual([KEY2]);
    expect(recA.tracks[KEY]!.events.length).toBeGreaterThan(1);
    expect(recB.tracks[KEY2]!.events.length).toBeGreaterThan(1);
  });

  it('PLAYBACK: committed sibling automation schedules curve-aware ramps and writes ZERO Yjs', () => {
    const def: FakeDef = { min: 0, max: 100, curve: 'linear' };
    const h = makeHarness(def);
    const len = 4;
    const auto: AutoClipRecord = {
      tracks: { [KEY]: { events: [{ step: 0, value: 0 }, { step: 2, value: 1 }] } },
    };
    seed(h, {
      len, arm: false, recorderId: h.ydoc.clientID, initialParam: 0,
      auto: { [String(IDX)]: auto },
    });

    const controller = new AutomationController(h.deps);
    expect(controller.recording).toBe(false);

    // Subscribe to the doc: playback must not fire a single update.
    let updates = 0;
    const onUpdate = () => { updates++; };
    h.ydoc.on('update', onUpdate);

    const laneDur = 0.1;
    const tracks = h.deps.readAutoTracks(IDX);
    for (let step = 0; step < len; step++) {
      const emitAt = 10 + step * laneDur;
      for (const tr of tracks) controller.playbackStep(tr, step, laneDur, emitAt);
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
    const first = h.scheduled[0]!;
    expect(first.atTime).toBeCloseTo(10, 5);
    expect(first.value).toBeCloseTo(0, 5);
    expect(first.ramp).toBe(false); // first point is a hard anchor
    const top = h.scheduled.find((s) => Math.abs(s.value - 100) < 1e-6);
    expect(top).toBeTruthy(); // the ramp reaches the denormalized max somewhere
  });

  it('SINGLE-WRITER: the record path is gated off for a non-matching clientId (no commit, no Yjs)', () => {
    const def: FakeDef = { min: 0, max: 100, curve: 'linear' };
    const h = makeHarness(def);
    const len = 4;
    // recorderId is a DIFFERENT client than this doc's clientID.
    const otherClient = h.ydoc.clientID + 1;
    seed(h, { len, arm: true, recorderId: otherClient, initialParam: 0 });

    // The gate the clipplayer runs: this client is NOT the recorder.
    expect(isAutomationRecorder(h.store.nodes[CLIP]!.data, h.ydoc.clientID)).toBe(false);

    const controller = new AutomationController(h.deps);
    let updates = 0;
    const onUpdate = () => { updates++; };
    h.ydoc.on('update', onUpdate);

    // Replicate the tick gate: a non-recorder NEVER arms nor record-ticks.
    const tick = (frac: number) => {
      if (!isAutomationRecorder(h.store.nodes[CLIP]!.data, h.ydoc.clientID)) return; // no-op
      controller.recordLaneTick(LANE, IDX, [T], frac, len);
    };
    // Drive a full arm→capture→wrap sequence with a moving value; all no-ops.
    for (const frac of [0, 1, 2, 3, 0, 1, 2, 3, 0]) { h.setLive(T, frac * 10); tick(frac); }

    h.ydoc.off('update', onUpdate);
    expect(updates).toBe(0); // no commit fired → zero Yjs writes
    // No auto record materialized.
    expect((h.store.nodes[CLIP]!.data as ClipPlayerData).auto?.[String(IDX)]).toBeUndefined();
  });
});
