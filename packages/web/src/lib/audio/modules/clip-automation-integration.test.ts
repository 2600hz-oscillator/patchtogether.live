// packages/web/src/lib/audio/modules/clip-automation-integration.test.ts
//
// INTEGRATION test for the clipplayer ↔ PER-CLIP automation WIRING under the
// owner-locked FINAL model (MODULE-level assignment + PER-LANE arm). The pure
// record/playback cores + the AutomationController are unit-tested elsewhere
// (clip-automation-*.test.ts). This proves the CLIPPLAYER-side composition —
// the injected deps the factory builds (readNorm store-tap, curve/unitNorm,
// the transient engine-driven `drive`, the cached `readAutoTracks` merge base,
// and the PER-KEY `commit` into the sibling `auto[k]` map) — against a REAL
// @syncedstore/core Y.Doc + a FAKE engine (mirrors the real-Y.Doc discipline
// of yjs-save-load-real-ydoc):
//
//   1. PLAYBACK writes ZERO Yjs — playbackStep→drive only schedules on the
//      engine; the doc's update count is unchanged across N ticks.
//   2. RECORD commits ONE transaction per pass — per-KEY writes into
//      `auto[k].tracks[targetKey]`, never a whole-record reassign — and the
//      commits ride an UNTRACKED origin (no per-wrap undo flooding).
//   3. THE HEADLINE REGRESSION (note-clobber): a NOTE edit at `clips[k]` and an
//      automation commit at `auto[k]` are DISJOINT keys — a peer's note edit
//      during a recording session clobbers nothing, and a note toggle leaves
//      `auto[k]` byte-identical.
//   4. PER-LANE ARM INDEPENDENCE — an armed lane records ONLY modules assigned
//      to IT; an UNARMED lane's modules don't record even when touched.
//   5. TWO PEERS record DIFFERENT lanes CONCURRENTLY (offline-window merge) —
//      both takes survive on both peers (per-lane single-writer).
//   6. CV EXCLUSION — engine-level modulation (no touch, no store write) is
//      NEVER recorded; a MIDI twist of the same param (touch + store) IS.
//   7. TRACK CAP — touched controls beyond MAX_AUTOMATION_TRACKS don't open
//      tracks; the capHit flag surfaces it.
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
  isLaneAutomationRecorder,
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
const TARGET = 'vco-1'; // the ASSIGNED module (assignment is module-level)
const PARAM = 'freq';
const SLOT = 0;
const LANE = 0;
const IDX = clipIndex(SLOT, LANE); // 0
const KEY = automationTargetKey({ nodeId: TARGET, paramId: PARAM });
/** The record scope the tick passes for LANE (its assigned module set). */
const MODS = new Set([TARGET]);

/** The commit ORIGIN the harness tags its transactions with — mirrors the
 *  app's AUTOMATION_COMMIT_ORIGIN: deliberately NOT an undo-tracked origin
 *  (per-wrap continuous-overdub commits would flood the undo stack; deleting a
 *  take is the explicit, undoable CLEAR affordance instead). */
const ORIGIN = Symbol('test-automation-commit-origin');
/** The undo-TRACKED origin (mirrors the app's LOCAL_ORIGIN). */
const TRACKED_ORIGIN = Symbol('test-local-origin');

/** A fresh note clip for `clips[k]` (the sibling of the auto record). */
function noteClip(len: number, steps: NoteClipRecord['steps'] = []): NoteClipRecord {
  return { kind: 'note', steps, lengthSteps: len, root: 48, loop: true };
}

/**
 * Build the SAME dep set clipplayer.ts wires, bound to a test doc + fake engine.
 * `live` stands in for the resolved surface params' live store values (the knob
 * positions a user is turning — the MODULATION-FREE store tap: CV modulation
 * never appears here, exactly like resolveSurfaceParam().get()); `def` for
 * their shared ParamDef. The commit dep mirrors clipplayer.ts byte-for-byte:
 * per-KEY plain writes into `auto[k].tracks` inside ONE origin-tagged
 * transaction, respecting the cap.
 */
function makeHarness(def: FakeDef) {
  const store = syncedStore<Store>({ nodes: {} });
  const ydoc = getYjsDoc(store);
  const scheduled: ScheduledWrite[] = [];
  const live: Record<string, number> = {};
  const capRef = { hit: false };

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
          if (isNew && count >= MAX_AUTOMATION_TRACKS) {
            capRef.hit = true;
            continue;
          }
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

  return { store, ydoc, scheduled, deps, setLive, capRef };
}

/** Seed the target node + a note clip (+ optional auto sibling) into the doc.
 *  Per-lane arm shape: `automation.lanes[LANE] = {arm, recorderId}`. */
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
  const lanes: ({ arm?: boolean; recorderId?: number } | null)[] = new Array(8).fill(null);
  if (opts.arm) lanes[LANE] = { arm: true, recorderId: opts.recorderId };
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
        automation: { lanes },
        autoAssign: { [TARGET]: LANE }, // MODULE → lane
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
    // The clipplayer arm-reconcile: this lane's recorder client arms IT.
    expect(isLaneAutomationRecorder(h.store.nodes[CLIP]!.data, LANE, h.ydoc.clientID)).toBe(true);
    controller.armLane(LANE);

    // Snapshot the NOTE clip — it must be untouched by the whole session.
    const noteBefore = JSON.stringify(
      (h.store.nodes[CLIP]!.data as ClipPlayerData).clips![String(IDX)],
    );

    // Feed the recorder the lane's audible fractional playhead each tick (as
    // the tick loop does), pushing a moving knob value between ticks. The
    // touch (notifyTouch) is what opens the track — module-level assignment
    // records ANY touched control of an assigned module. It punches in at the
    // clip's own wrap, then commits ONE pass at the NEXT wrap (continuous
    // overdub keeps recording after).
    const drive = (frac: number) => {
      controller.notifyTouch(T); // the user is actively holding the knob
      controller.recordLaneTick(LANE, IDX, MODS, frac, len);
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

  it('UNDO: record-pass commits are NON-UNDOABLE (untracked origin — no per-wrap Cmd-Z flooding); a tracked clear IS one undo step', () => {
    const def: FakeDef = { min: 0, max: 100, curve: 'linear' };
    const h = makeHarness(def);
    const len = 4;
    seed(h, { len, arm: true, recorderId: h.ydoc.clientID, initialParam: 0 });

    // The app's undo manager tracks ONLY LOCAL_ORIGIN — mirror that here. The
    // record commits ride an UNTRACKED origin, so a long take never floods the
    // stack (Cmd-Z regressing one wrap at a time was the refuted failure mode).
    const nodesMap = h.ydoc.getMap('nodes');
    const undo = new Y.UndoManager(nodesMap, { trackedOrigins: new Set([TRACKED_ORIGIN]) });

    const controller = new AutomationController(h.deps);
    controller.armLane(LANE);
    const drive = (frac: number) => {
      controller.notifyTouch(T);
      controller.recordLaneTick(LANE, IDX, MODS, frac, len);
    };
    drive(0); drive(1); drive(2); drive(3);
    h.setLive(T, 0); drive(0); // punch-in
    h.setLive(T, 50); drive(1);
    h.setLive(T, 100); drive(2); drive(3);
    drive(0); // wrap → commit pass 1
    // keep recording another pass → commit 2
    h.setLive(T, 25); drive(1); drive(2); drive(3);
    drive(0); // wrap → commit pass 2
    expect(undo.undoStack.length, 'no undo items from record commits').toBe(0);

    const data = h.store.nodes[CLIP]!.data as ClipPlayerData;
    expect(coerceAutoClipRecord(data.auto![String(IDX)])!.tracks[KEY]!.events.length)
      .toBeGreaterThan(1);
    // The DELETE affordance (the app's clearRecordedAutomation) is TRACKED —
    // one undoable step that removes the take.
    h.ydoc.transact(() => {
      const d = h.store.nodes[CLIP]!.data as ClipPlayerData;
      const rec = d.auto![String(IDX)]!;
      delete rec.tracks[KEY];
    }, TRACKED_ORIGIN);
    expect(undo.undoStack.length, 'the clear is one undo step').toBe(1);
    expect(coerceAutoClipRecord(
      (h.store.nodes[CLIP]!.data as ClipPlayerData).auto![String(IDX)],
    )?.tracks[KEY]).toBeUndefined();
    undo.undo();
    expect(
      coerceAutoClipRecord((h.store.nodes[CLIP]!.data as ClipPlayerData).auto![String(IDX)])!
        .tracks[KEY]!.events.length,
      'undoing the clear restores the take',
    ).toBeGreaterThan(1);
  });

  it('OFFLINE MERGE (container-LWW hardening): two peers’ concurrent first-writes under pre-created containers BOTH survive', () => {
    const def: FakeDef = { min: 0, max: 100, curve: 'linear' };
    const a = makeHarness(def);
    // Seed peer A with the factory-stamped containers + the ARM-time per-clip
    // shell (the fix under test: containers exist BEFORE the racy writes).
    seed(a, { len: 4, arm: true, recorderId: a.ydoc.clientID, initialParam: 0 });
    a.ydoc.transact(() => {
      const d = a.store.nodes[CLIP]!.data as ClipPlayerData;
      d.auto = { [String(IDX)]: { tracks: {} } }; // arm-time shell
    });
    // Bootstrap peer B from A's full state, then go OFFLINE (no live pump —
    // updates are buffered and exchanged only at the end).
    const storeB = syncedStore<Store>({ nodes: {} });
    const docB = getYjsDoc(storeB);
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(a.ydoc));
    const KEY2 = automationTargetKey({ nodeId: TARGET, paramId: 'res' });

    // OFFLINE: peer A records a take into tracks[KEY]…
    const controller = new AutomationController(a.deps);
    controller.armLane(LANE);
    const drive = (frac: number) => {
      controller.notifyTouch(T);
      controller.recordLaneTick(LANE, IDX, MODS, frac, 4);
    };
    drive(0); drive(1); drive(2); drive(3);
    a.setLive(T, 0); drive(0);
    a.setLive(T, 100); drive(2); drive(3);
    drive(0); // commit into auto[IDX].tracks[KEY]
    // …while peer B (offline) writes a SIBLING key of the SAME clip's record
    // (e.g. a paste/clear-era write) + its own autoAssign entry.
    docB.transact(() => {
      const d = storeB.nodes[CLIP]!.data as ClipPlayerData;
      (d.auto![String(IDX)] as AutoClipRecord).tracks[KEY2] = {
        events: [{ step: 0, value: 0.5 }],
      };
      d.autoAssign!['b-peer-module'] = 5;
    });

    // MERGE both ways.
    Y.applyUpdate(a.ydoc, Y.encodeStateAsUpdate(docB));
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(a.ydoc));

    for (const [name, store] of [['A', a.store] as const, ['B', storeB] as const]) {
      const d = store.nodes[CLIP]!.data as ClipPlayerData;
      const rec = coerceAutoClipRecord(d.auto![String(IDX)])!;
      expect(
        (rec.tracks[KEY]?.events.length ?? 0) > 1,
        `peer ${name}: A's take survived the merge`,
      ).toBe(true);
      expect(rec.tracks[KEY2]?.events, `peer ${name}: B's concurrent track survived`).toEqual([
        { step: 0, value: 0.5 },
      ]);
      expect(d.autoAssign?.['b-peer-module'], `peer ${name}: B's assignment survived`).toBe(5);
    }
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
    controller.armLane(LANE);
    const drive = (frac: number) => {
      controller.notifyTouch(T);
      controller.recordLaneTick(LANE, IDX, MODS, frac, 4);
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

  it('PER-LANE ARM INDEPENDENCE: lane 3 armed records only ITS modules; unarmed lane 5’s module never records even when touched', () => {
    const def: FakeDef = { min: 0, max: 100, curve: 'linear' };
    const h = makeHarness(def);
    const MOD5 = 'vcf-5'; // assigned to UNARMED lane 5
    const T5 = { nodeId: MOD5, paramId: 'cutoff' };
    const LANE3 = 3;
    const LANE5 = 5;
    const IDX3 = clipIndex(0, LANE3);
    const IDX5 = clipIndex(0, LANE5);
    seed(h, {
      len: 4, arm: false, recorderId: h.ydoc.clientID, initialParam: 0,
      extraClips: { [String(IDX3)]: noteClip(4), [String(IDX5)]: noteClip(4) },
    });
    h.ydoc.transact(() => {
      const d = h.store.nodes[CLIP]!.data as ClipPlayerData;
      d.autoAssign = { [TARGET]: LANE3, [MOD5]: LANE5 }; // module→lane
      d.automation = { lanes: [null, null, null, { arm: true, recorderId: h.ydoc.clientID }, null, null, null, null] };
    });
    h.setLive(T5, 0);

    const controller = new AutomationController(h.deps);
    controller.armLane(LANE3); // ONLY lane 3 (mirrors the per-lane reconcile)

    const mods3 = new Set([TARGET]);
    const mods5 = new Set([MOD5]);
    const tick = (frac: number) => {
      // BOTH controls are being touched + moved the whole time…
      controller.notifyTouch(T);
      controller.notifyTouch(T5);
      // …but the tick only record-ticks ARMED lanes (the factory gate). Lane 5
      // is unarmed → recordLaneTick(…lane 5…) is guarded inside too.
      controller.recordLaneTick(LANE3, IDX3, mods3, frac, 4);
      controller.recordLaneTick(LANE5, IDX5, mods5, frac, 4); // internally a no-op (unarmed)
    };
    tick(0); tick(1); tick(2); tick(3);
    h.setLive(T, 0); h.setLive(T5, 0); tick(0); // lane 3 punch-in
    h.setLive(T, 60); h.setLive(T5, 60); tick(1);
    h.setLive(T, 100); h.setLive(T5, 100); tick(2); tick(3);
    tick(0); // lane 3 wrap → commit

    const d = h.store.nodes[CLIP]!.data as ClipPlayerData;
    const rec3 = coerceAutoClipRecord(d.auto?.[String(IDX3)]);
    expect((rec3?.tracks[KEY]?.events.length ?? 0) > 1, 'armed lane 3 recorded its module').toBe(true);
    // Lane 3 recorded ONLY its own module's control (module scope).
    expect(Object.keys(rec3!.tracks)).toEqual([KEY]);
    // Unarmed lane 5: NOTHING recorded despite the touch + movement.
    expect(d.auto?.[String(IDX5)], 'unarmed lane 5 never recorded').toBeUndefined();
  });

  it('TWO PEERS record DIFFERENT lanes CONCURRENTLY (offline-window merge) — both takes survive (per-lane single-writer)', () => {
    const def: FakeDef = { min: 0, max: 100, curve: 'linear' };
    const MOD_B = 'vcf-9';
    const T_B = { nodeId: MOD_B, paramId: 'cutoff' };
    const KEY_B = automationTargetKey(T_B);
    const LANE_B = 1;
    const IDX_B = clipIndex(0, LANE_B);

    // Peer A seeds: two lanes' clips, module A→lane 0, module B→lane 1, lane 0
    // armed by A. Shells pre-created for both lanes (the arm-time hardening).
    const a = makeHarness(def);
    seed(a, {
      len: 4, arm: true, recorderId: a.ydoc.clientID, initialParam: 0,
      extraClips: { [String(IDX_B)]: noteClip(4) },
    });
    a.ydoc.transact(() => {
      const d = a.store.nodes[CLIP]!.data as ClipPlayerData;
      d.autoAssign![MOD_B] = LANE_B;
      d.auto = { [String(IDX)]: { tracks: {} }, [String(IDX_B)]: { tracks: {} } };
    });

    // Peer B bootstraps from A, then (still online) arms LANE_B as ITS
    // recorder — sequential arms, so the rebuilt lanes array carries both.
    const b = makeHarness(def);
    Y.applyUpdate(b.ydoc, Y.encodeStateAsUpdate(a.ydoc));
    b.ydoc.transact(() => {
      const d = b.store.nodes[CLIP]!.data as ClipPlayerData;
      const lanes = (d.automation!.lanes ?? []).map((e) =>
        e && (e as { arm?: boolean }).arm === true
          ? { arm: true, recorderId: (e as { recorderId?: number }).recorderId }
          : null,
      );
      while (lanes.length < 8) lanes.push(null);
      lanes[LANE_B] = { arm: true, recorderId: b.ydoc.clientID };
      d.automation!.lanes = lanes;
    });
    Y.applyUpdate(a.ydoc, Y.encodeStateAsUpdate(b.ydoc));

    // Each peer's engine sees ITSELF as recorder of exactly one lane.
    expect(isLaneAutomationRecorder(a.store.nodes[CLIP]!.data, LANE, a.ydoc.clientID)).toBe(true);
    expect(isLaneAutomationRecorder(a.store.nodes[CLIP]!.data, LANE_B, a.ydoc.clientID)).toBe(false);
    expect(isLaneAutomationRecorder(b.store.nodes[CLIP]!.data, LANE_B, b.ydoc.clientID)).toBe(true);
    expect(isLaneAutomationRecorder(b.store.nodes[CLIP]!.data, LANE, b.ydoc.clientID)).toBe(false);

    // OFFLINE WINDOW: both peers record their own lane concurrently.
    const ctrlA = new AutomationController(a.deps);
    ctrlA.armLane(LANE);
    const ctrlB = new AutomationController(b.deps);
    ctrlB.armLane(LANE_B);
    const drvA = (frac: number) => {
      ctrlA.notifyTouch(T);
      ctrlA.recordLaneTick(LANE, IDX, new Set([TARGET]), frac, 4);
    };
    const drvB = (frac: number) => {
      ctrlB.notifyTouch(T_B);
      ctrlB.recordLaneTick(LANE_B, IDX_B, new Set([MOD_B]), frac, 4);
    };
    b.setLive(T_B, 0);
    drvA(0); drvA(1); drvA(2); drvA(3);
    drvB(0); drvB(1); drvB(2); drvB(3);
    a.setLive(T, 0); drvA(0);
    b.setLive(T_B, 100); drvB(0);
    a.setLive(T, 100); drvA(2); drvA(3);
    b.setLive(T_B, 20); drvB(2); drvB(3);
    drvA(0); // A commits lane 0's pass
    drvB(0); // B commits lane 1's pass

    // MERGE the offline windows both ways — DISJOINT auto[k] keys, no clobber.
    Y.applyUpdate(a.ydoc, Y.encodeStateAsUpdate(b.ydoc));
    Y.applyUpdate(b.ydoc, Y.encodeStateAsUpdate(a.ydoc));

    for (const [name, store] of [['A', a.store] as const, ['B', b.store] as const]) {
      const d = store.nodes[CLIP]!.data as ClipPlayerData;
      const recA = coerceAutoClipRecord(d.auto![String(IDX)])!;
      const recB = coerceAutoClipRecord(d.auto![String(IDX_B)])!;
      expect(
        (recA.tracks[KEY]?.events.length ?? 0) > 1,
        `peer ${name}: peer A's lane-0 take survived`,
      ).toBe(true);
      expect(
        (recB.tracks[KEY_B]?.events.length ?? 0) > 1,
        `peer ${name}: peer B's lane-1 take survived`,
      ).toBe(true);
    }
  });

  it('CV EXCLUSION: engine-level modulation (no touch, no store write) records NOTHING; a MIDI twist of the same param DOES', () => {
    const def: FakeDef = { min: 0, max: 100, curve: 'linear' };
    const h = makeHarness(def);
    seed(h, { len: 4, arm: true, recorderId: h.ydoc.clientID, initialParam: 30 });

    const controller = new AutomationController(h.deps);
    controller.armLane(LANE);
    // A CV cable wiggling the param lives at the ENGINE (AudioParam summing) —
    // it neither fires notifyAutomationTouch NOR writes the store the readNorm
    // tap reads. Model it as a value that changes wildly OUTSIDE the harness's
    // `live` store map (readNorm never sees it — modulation-free by
    // construction, the cv-modulation-live-store-write-storm rule).
    let cvPhase = 0;
    const tickWithCv = (frac: number) => {
      cvPhase += 1; // the audible (engine) value is swinging…
      void cvPhase; // …but touches nothing the recorder reads.
      controller.recordLaneTick(LANE, IDX, MODS, frac, 4);
    };
    // Two full loops of armed recording under pure CV modulation.
    for (const f of [0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3, 0]) tickWithCv(f);
    // NO track appeared — CV is never recorded as automation.
    const d1 = h.store.nodes[CLIP]!.data as ClipPlayerData;
    expect(
      coerceAutoClipRecord(d1.auto?.[String(IDX)])?.tracks[KEY],
      'CV modulation recorded nothing',
    ).toBeUndefined();

    // Now a MIDI twist of the SAME param: the CC pump fires the touch seam
    // (holder 'midi') and the coalesced commit moves the STORE value.
    const midiTick = (frac: number, v: number) => {
      controller.notifyTouch(T, 'midi');
      h.setLive(T, v);
      controller.recordLaneTick(LANE, IDX, MODS, frac, 4);
    };
    midiTick(0, 0); midiTick(1, 40); midiTick(2, 80); midiTick(3, 100);
    controller.recordLaneTick(LANE, IDX, MODS, 0, 4); // wrap → commit
    const d2 = h.store.nodes[CLIP]!.data as ClipPlayerData;
    expect(
      (coerceAutoClipRecord(d2.auto?.[String(IDX)])?.tracks[KEY]?.events.length ?? 0) > 1,
      'the MIDI twist recorded a track through the same seam',
    ).toBe(true);
  });

  it('TRACK CAP: touches beyond MAX_AUTOMATION_TRACKS open no new pass entries and set capHit (the polite surface)', () => {
    const def: FakeDef = { min: 0, max: 100, curve: 'linear' };
    const h = makeHarness(def);
    seed(h, { len: 4, arm: true, recorderId: h.ydoc.clientID, initialParam: 0 });

    const controller = new AutomationController(h.deps);
    controller.armLane(LANE);
    // MAX+2 controls on the ONE assigned module, all touched + moving.
    const targets: AutomationTarget[] = Array.from(
      { length: MAX_AUTOMATION_TRACKS + 2 },
      (_, i) => ({ nodeId: TARGET, paramId: `p${i}` }),
    );
    for (const t of targets) h.setLive(t, 0);
    const tick = (frac: number, v: number) => {
      for (const t of targets) {
        controller.notifyTouch(t);
        h.setLive(t, v);
      }
      controller.recordLaneTick(LANE, IDX, MODS, frac, 4);
    };
    tick(0, 0); tick(1, 0); tick(2, 0); tick(3, 0);
    tick(0, 0); // punch-in
    tick(1, 50); tick(2, 100); tick(3, 100);
    controller.recordLaneTick(LANE, IDX, MODS, 0, 4); // wrap → commit
    expect(controller.capHit, 'the cap hit is surfaced').toBe(true);

    const d = h.store.nodes[CLIP]!.data as ClipPlayerData;
    const rec = coerceAutoClipRecord(d.auto![String(IDX)])!;
    expect(Object.keys(rec.tracks).length).toBeLessThanOrEqual(MAX_AUTOMATION_TRACKS);
    expect(Object.keys(rec.tracks).length).toBe(MAX_AUTOMATION_TRACKS);
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

  it('PER-LANE SINGLE-WRITER: the record path is gated off for a non-matching clientId (no commit, no Yjs)', () => {
    const def: FakeDef = { min: 0, max: 100, curve: 'linear' };
    const h = makeHarness(def);
    const len = 4;
    // Lane 0's recorderId is a DIFFERENT client than this doc's clientID.
    const otherClient = h.ydoc.clientID + 1;
    seed(h, { len, arm: true, recorderId: otherClient, initialParam: 0 });

    // The gate the clipplayer runs per lane: this client is NOT the recorder.
    expect(isLaneAutomationRecorder(h.store.nodes[CLIP]!.data, LANE, h.ydoc.clientID)).toBe(false);

    const controller = new AutomationController(h.deps);
    let updates = 0;
    const onUpdate = () => { updates++; };
    h.ydoc.on('update', onUpdate);

    // Replicate the tick gate: a non-recorder NEVER arms nor record-ticks the lane.
    const tick = (frac: number) => {
      if (!isLaneAutomationRecorder(h.store.nodes[CLIP]!.data, LANE, h.ydoc.clientID)) return; // no-op
      controller.recordLaneTick(LANE, IDX, MODS, frac, len);
    };
    // Drive a full arm→capture→wrap sequence with a moving value; all no-ops.
    for (const frac of [0, 1, 2, 3, 0, 1, 2, 3, 0]) { h.setLive(T, frac * 10); tick(frac); }

    h.ydoc.off('update', onUpdate);
    expect(updates).toBe(0); // no commit fired → zero Yjs writes
    // No auto record materialized.
    expect((h.store.nodes[CLIP]!.data as ClipPlayerData).auto?.[String(IDX)]).toBeUndefined();
  });
});
