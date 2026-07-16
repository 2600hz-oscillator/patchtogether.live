// packages/web/src/lib/audio/modules/clip-automation-card-actions.test.ts
//
// Real-Y.Doc test for the CARD + MENU automation actions (owner-locked final
// model: MODULE-level assignment + PER-LANE arm). The module card's right-click
// "Assign to automation lane ▸ 1–8" / "Remove automation assignment" writes go
// through the REAL shared seam ($lib/graph/automation-assign — the exact
// functions Canvas's NodeContextMenu wiring calls), driven here against the
// app's live graph store; the card's per-lane ◉ arm toggle uses the SAME
// toggleLaneAutomationArm helper the component calls. Proves:
//
//   • assign writes autoAssign[moduleId] = lane (single-key, in place);
//   • ONE lane per module: re-assigning MOVES it (same player, other lane) and
//     assigning on ANOTHER player removes it there too — atomically;
//   • remove drops the module from whichever player holds it;
//   • prune drops ONLY module-absent assignments (conservative), no-op
//     otherwise — both per-player AND the multi-surface all-players sweep;
//   • per-lane arm sets lanes[L] = {arm, recorderId} (per-lane single-writer,
//     isLaneAutomationRecorder true for THAT lane only);
//   • the chip-row source (autoAssignCounts) mirrors the map exactly.

import { describe, it, expect, beforeEach } from 'vitest';
import * as Y from 'yjs';
import { patch, ydoc, LOCAL_ORIGIN } from '$lib/graph/store';
import {
  assignAutomationLane,
  removeAutomationAssignment,
  automationAssignmentFor,
  pruneAutoAssignDangling,
  pruneAllAutoAssignDangling,
  repairDuplicateAutoAssign,
  listClipPlayers,
  hasRecordedAutomation,
  clearRecordedAutomation,
  clearClipAutomation,
} from '$lib/graph/automation-assign';
import {
  coerceAutoAssign,
  autoAssignCounts,
  assignedLaneOfModule,
  isLaneAutomationRecorder,
  laneAutomationArmed,
  toggleLaneAutomationArm,
  automationTargetKey,
  clipIndex,
  type AutoClipRecord,
  type ClipPlayerData,
  type AutomationTarget,
} from './clip-types';

const CP = 'cp-actions-1';
const CP2 = 'cp-actions-2';
// Two MODULES (the assignable unit) + one control on each (tracks stay
// control-precise — keyed nodeId::paramId).
const MOD_A = 'vco-x';
const MOD_B = 'vcf-x';
const A: AutomationTarget = { nodeId: MOD_A, paramId: 'freq' };
const B: AutomationTarget = { nodeId: MOD_B, paramId: 'cutoff' };

function clearPatch() {
  for (const k of Object.keys(patch.nodes)) delete patch.nodes[k];
  for (const k of Object.keys(patch.edges)) delete patch.edges[k];
}
function seedNode(id: string, type: string) {
  patch.nodes[id] = {
    id, type, domain: 'audio', position: { x: 0, y: 0 }, params: {}, data: {},
  } as never;
}
function cpData(id = CP): ClipPlayerData {
  return (patch.nodes[id]?.data ?? {}) as ClipPlayerData;
}

// ── mirrors ClipplayerCard.toggleLaneAutoArm (the shared seam) ──────────────
function toggleLaneArm(lane: number, clientId: number, id = CP): void {
  const live = patch.nodes[id]!;
  if (!live.data) live.data = {};
  ydoc.transact(() => {
    toggleLaneAutomationArm(live.data as ClipPlayerData, lane, clientId);
  });
}

beforeEach(() => {
  clearPatch();
  seedNode(CP, 'clipplayer');
  seedNode(MOD_A, 'vco');
  seedNode(MOD_B, 'vcf');
});

describe('clip-automation card/menu actions (real Y.Doc, shared assign seam)', () => {
  it('assign writes autoAssign[moduleId] = lane (and the reads mirror it)', () => {
    expect(() => assignAutomationLane(CP, MOD_A, 3)).not.toThrow();
    expect(coerceAutoAssign(cpData().autoAssign)).toEqual({ [MOD_A]: 3 });
    expect(assignedLaneOfModule(cpData(), MOD_A)).toBe(3);
    expect(automationAssignmentFor(patch.nodes, MOD_A)).toEqual({ nodeId: CP, lane: 3 });
    // UI-CAN'T-LIE: the chip row renders EXACTLY this.
    expect(autoAssignCounts(cpData())).toEqual([0, 0, 0, 1, 0, 0, 0, 0]);
  });

  it('ONE lane per module: re-assigning MOVES it to the new lane (no duplicate)', () => {
    assignAutomationLane(CP, MOD_A, 3);
    assignAutomationLane(CP, MOD_A, 5);
    expect(coerceAutoAssign(cpData().autoAssign)).toEqual({ [MOD_A]: 5 });
    expect(autoAssignCounts(cpData())).toEqual([0, 0, 0, 0, 0, 1, 0, 0]);
  });

  it('assigning on ANOTHER player removes it from the first (atomic cross-player move)', () => {
    seedNode(CP2, 'clipplayer');
    assignAutomationLane(CP, MOD_A, 2);
    assignAutomationLane(CP2, MOD_A, 6);
    expect(assignedLaneOfModule(cpData(CP), MOD_A)).toBeNull();
    expect(assignedLaneOfModule(cpData(CP2), MOD_A)).toBe(6);
    expect(automationAssignmentFor(patch.nodes, MOD_A)).toEqual({ nodeId: CP2, lane: 6 });
  });

  it('two modules can share a lane; counts reflect both', () => {
    assignAutomationLane(CP, MOD_A, 1);
    assignAutomationLane(CP, MOD_B, 1);
    expect(autoAssignCounts(cpData())).toEqual([0, 2, 0, 0, 0, 0, 0, 0]);
  });

  it('remove drops only that module’s assignment', () => {
    assignAutomationLane(CP, MOD_A, 1);
    assignAutomationLane(CP, MOD_B, 4);
    removeAutomationAssignment(MOD_A);
    expect(assignedLaneOfModule(cpData(), MOD_A)).toBeNull();
    expect(assignedLaneOfModule(cpData(), MOD_B)).toBe(4);
    // Removing an unassigned module is a safe no-op.
    expect(() => removeAutomationAssignment(MOD_A)).not.toThrow();
  });

  it('lane is clamped into 0..7; non-clipplayer player / dead module / self are no-ops', () => {
    assignAutomationLane(CP, MOD_A, 99);
    expect(assignedLaneOfModule(cpData(), MOD_A)).toBe(7);
    assignAutomationLane(MOD_A, MOD_B, 2); // not a clipplayer → no-op
    expect(automationAssignmentFor(patch.nodes, MOD_B)).toBeNull();
    assignAutomationLane(CP, 'no-such-module', 2); // dead module → no-op
    expect(assignedLaneOfModule(cpData(), 'no-such-module')).toBeNull();
    assignAutomationLane(CP, CP, 2); // a player never automates itself
    expect(assignedLaneOfModule(cpData(), CP)).toBeNull();
  });

  it('prune drops ONLY module-absent assignments (conservative) and is a no-op otherwise', () => {
    assignAutomationLane(CP, MOD_A, 1);
    assignAutomationLane(CP, MOD_B, 2);
    expect(pruneAutoAssignDangling(CP)).toBe(0); // both modules present → no-op
    delete patch.nodes[MOD_A]; // the assigned module is deleted
    expect(pruneAutoAssignDangling(CP)).toBe(1);
    expect(assignedLaneOfModule(cpData(), MOD_A)).toBeNull(); // dangling assignment gone
    expect(assignedLaneOfModule(cpData(), MOD_B)).toBe(2); // the live one stays
    expect(pruneAutoAssignDangling(CP)).toBe(0); // idempotent
  });

  it('MULTI-SURFACE prune sweeps EVERY player (no clipplayer card needs to be mounted)', () => {
    seedNode(CP2, 'clipplayer');
    assignAutomationLane(CP, MOD_A, 1);
    assignAutomationLane(CP2, MOD_B, 2);
    expect(pruneAllAutoAssignDangling()).toBe(0); // nothing dangles → no-op
    delete patch.nodes[MOD_A];
    delete patch.nodes[MOD_B];
    expect(pruneAllAutoAssignDangling()).toBe(2); // one sweep, both players
    expect(coerceAutoAssign(cpData(CP).autoAssign)).toEqual({});
    expect(coerceAutoAssign(cpData(CP2).autoAssign)).toEqual({});
    expect(pruneAllAutoAssignDangling()).toBe(0); // idempotent
  });

  it('JANITOR ORIGIN: the prune never plants undo items on the local stack (a peer-driven module deletion cannot pollute undo)', () => {
    // The app's UndoManager tracks ONLY LOCAL_ORIGIN — mirror it here. The
    // janitor prune must ride AUTO_JANITOR_ORIGIN (untracked): before, a
    // peer's module deletion would sync in, the local janitor would prune
    // under LOCAL_ORIGIN, and every OTHER client's undo stack would grow a
    // phantom item — undoing past it livelocks (restore → re-prune → fresh
    // item) and wipes redo.
    const undo = new Y.UndoManager(ydoc.getMap('nodes'), {
      trackedOrigins: new Set([LOCAL_ORIGIN]),
      captureTimeout: 0,
    });
    assignAutomationLane(CP, MOD_A, 1); // a tracked USER edit
    const userItems = undo.undoStack.length;
    expect(userItems).toBeGreaterThan(0);
    delete patch.nodes[MOD_A]; // the module vanishes (peer-driven — untracked)
    expect(pruneAllAutoAssignDangling()).toBe(1);
    expect(pruneAutoAssignDangling(CP)).toBe(0);
    expect(undo.undoStack.length, 'janitor writes added NOTHING to undo').toBe(userItems);
    expect(assignedLaneOfModule(cpData(), MOD_A)).toBeNull();
    undo.destroy();
  });

  it('mid-session ::-key sweep: retired param-level keys arriving over sync are janitored (always-dangling)', () => {
    // Simulate a legacy peer syncing a retired `nodeId::paramId` assignment
    // into the RAW map mid-session (the factory sweep is load-only).
    const live = patch.nodes[CP]!;
    if (!live.data) live.data = {};
    (live.data as ClipPlayerData).autoAssign = { [`${MOD_A}::freq`]: 3, [MOD_A]: 2 };
    expect(pruneAllAutoAssignDangling()).toBe(1); // the ::-key retired
    expect(coerceAutoAssign(cpData().autoAssign)).toEqual({ [MOD_A]: 2 }); // the module claim stays
  });

  it('REPAIR: the same module claimed on TWO players keeps the LOWEST player id, deterministically', () => {
    seedNode(CP2, 'clipplayer');
    // Bypass the assign seam (which enforces the move) to fabricate the
    // post-merge duplicate-claim state the repair exists for.
    (patch.nodes[CP]!.data as ClipPlayerData).autoAssign = { [MOD_A]: 1 };
    (patch.nodes[CP2]!.data as ClipPlayerData).autoAssign = { [MOD_A]: 5, [MOD_B]: 2 };
    expect(repairDuplicateAutoAssign()).toBe(1); // CP2's duplicate claim dropped
    expect(assignedLaneOfModule(cpData(CP), MOD_A), 'lowest player id keeps the claim').toBe(1);
    expect(assignedLaneOfModule(cpData(CP2), MOD_A)).toBeNull();
    expect(assignedLaneOfModule(cpData(CP2), MOD_B), 'unrelated claim untouched').toBe(2);
    expect(repairDuplicateAutoAssign(), 'idempotent').toBe(0);
  });

  it('listClipPlayers finds every clipplayer (all accept assignments — no stamped clip)', () => {
    seedNode(CP2, 'clipplayer');
    expect(listClipPlayers(patch.nodes).sort()).toEqual([CP, CP2].sort());
  });

  it('PER-LANE arm: sets lanes[L] = {arm, recorderId}; that lane ONLY; toggle disarms', () => {
    assignAutomationLane(CP, MOD_A, 0);
    toggleLaneArm(0, ydoc.clientID);
    const data = cpData();
    expect(laneAutomationArmed(data, 0)).toBe(true);
    expect(laneAutomationArmed(data, 1)).toBe(false); // other lanes untouched
    expect(isLaneAutomationRecorder(data, 0, ydoc.clientID)).toBe(true);
    expect(isLaneAutomationRecorder(data, 0, ydoc.clientID + 1)).toBe(false); // only the arming client
    expect(isLaneAutomationRecorder(data, 1, ydoc.clientID)).toBe(false); // only THAT lane
    toggleLaneArm(0, ydoc.clientID);
    expect(laneAutomationArmed(cpData(), 0)).toBe(false); // toggled off
  });

  it('PER-LANE arm independence: two lanes armed by DIFFERENT clients coexist', () => {
    toggleLaneArm(1, 111);
    toggleLaneArm(2, 222);
    const data = cpData();
    expect(isLaneAutomationRecorder(data, 1, 111)).toBe(true);
    expect(isLaneAutomationRecorder(data, 2, 222)).toBe(true);
    expect(isLaneAutomationRecorder(data, 1, 222)).toBe(false);
    expect(isLaneAutomationRecorder(data, 2, 111)).toBe(false);
    // Disarming lane 1 leaves lane 2 recording.
    toggleLaneArm(1, 111);
    expect(laneAutomationArmed(cpData(), 1)).toBe(false);
    expect(laneAutomationArmed(cpData(), 2)).toBe(true);
  });

  it('the whole assign→arm→move→remove cycle never throws (re-integration safe)', () => {
    expect(() => {
      assignAutomationLane(CP, MOD_A, 0);
      assignAutomationLane(CP, MOD_B, 3);
      toggleLaneArm(0, ydoc.clientID);
      assignAutomationLane(CP, MOD_A, 3); // move
      removeAutomationAssignment(MOD_A);
      removeAutomationAssignment(MOD_B);
    }).not.toThrow();
    expect(coerceAutoAssign(cpData().autoAssign)).toEqual({});
  });
});

// ── DELETE affordances (envelope-belongs-to-the-clip) + arm-time shells ──────

/** Seed a note clip + a recorded auto record at (slot, lane) on CP. */
function seedRecorded(slot: number, lane: number, targets: AutomationTarget[], id = CP) {
  const live = patch.nodes[id]!;
  if (!live.data) live.data = {};
  const d = live.data as ClipPlayerData;
  if (!d.clips) d.clips = {};
  if (!d.auto) d.auto = {};
  const k = String(clipIndex(slot, lane));
  d.clips[k] = { kind: 'note', steps: [], lengthSteps: 8, root: 48, loop: true };
  const tracks: AutoClipRecord['tracks'] = {};
  for (const t of targets) tracks[automationTargetKey(t)] = { events: [{ step: 0, value: 0.5 }] };
  d.auto[k] = { tracks };
}

describe('clip-automation DELETE affordances (real Y.Doc, shared seam)', () => {
  it('hasRecordedAutomation finds a recorded track anywhere', () => {
    expect(hasRecordedAutomation(patch.nodes, A)).toBe(false);
    seedRecorded(0, 2, [A]);
    expect(hasRecordedAutomation(patch.nodes, A)).toBe(true);
    expect(hasRecordedAutomation(patch.nodes, B)).toBe(false);
  });

  it('clearRecordedAutomation (module ASSIGNED): wipes the control from its module’s LANE only; empty shells deleted', () => {
    // A recorded in lane 2 (two clips) AND lane 4 (one clip); MODULE assigned to lane 2.
    seedRecorded(0, 2, [A, B]);
    seedRecorded(1, 2, [A]);
    seedRecorded(0, 4, [A]);
    assignAutomationLane(CP, MOD_A, 2);
    const removed = clearRecordedAutomation(A);
    expect(removed).toBe(2); // both lane-2 clips
    const auto = cpData().auto!;
    const keyA = automationTargetKey(A);
    // Lane 2 slot 0: A gone, B (other track) kept.
    expect((auto[String(clipIndex(0, 2))] as AutoClipRecord).tracks[keyA]).toBeUndefined();
    expect((auto[String(clipIndex(0, 2))] as AutoClipRecord).tracks[automationTargetKey(B)]).toBeTruthy();
    // Lane 2 slot 1 held ONLY A → the whole record is deleted (no empty shell).
    expect(auto[String(clipIndex(1, 2))]).toBeUndefined();
    // Lane 4 (NOT the module's assigned lane) keeps its recording.
    expect((auto[String(clipIndex(0, 4))] as AutoClipRecord).tracks[keyA]).toBeTruthy();
  });

  it('clearRecordedAutomation (module UNASSIGNED): wipes the control from EVERY clip', () => {
    seedRecorded(0, 2, [A]);
    seedRecorded(0, 4, [A]);
    expect(clearRecordedAutomation(A)).toBe(2);
    expect(hasRecordedAutomation(patch.nodes, A)).toBe(false);
    expect(clearRecordedAutomation(A), 'idempotent — nothing left').toBe(0);
  });

  it('clearRecordedAutomation is ONE undoable step (LOCAL_ORIGIN); undo restores the take', () => {
    seedRecorded(0, 2, [A]);
    seedRecorded(1, 2, [A]);
    assignAutomationLane(CP, MOD_A, 2);
    const undo = new Y.UndoManager(ydoc.getMap('nodes'), {
      trackedOrigins: new Set([LOCAL_ORIGIN]),
      captureTimeout: 0, // each transaction = its own item (test isolation)
    });
    clearRecordedAutomation(A);
    expect(undo.undoStack.length).toBe(1);
    expect(hasRecordedAutomation(patch.nodes, A)).toBe(false);
    undo.undo();
    expect(hasRecordedAutomation(patch.nodes, A), 'undo restores the envelopes').toBe(true);
    undo.destroy();
  });

  it('clearClipAutomation deletes ONE clip’s whole record (keeps the notes) — undoable', () => {
    seedRecorded(0, 2, [A, B]);
    const idx = clipIndex(0, 2);
    expect(clearClipAutomation(CP, idx)).toBe(true);
    expect(cpData().auto?.[String(idx)]).toBeUndefined();
    expect(cpData().clips?.[String(idx)], 'notes kept').toBeTruthy();
    expect(clearClipAutomation(CP, idx), 'no-op when already gone').toBe(false);
  });
});

describe('per-lane arm shell pre-creation via the shared toggle (container-LWW hardening)', () => {
  it('arming a lane pre-creates ITS playing clip’s auto[k] shell (assigned module + playing note clip)', () => {
    const live = patch.nodes[CP]!;
    if (!live.data) live.data = {};
    const d = live.data as ClipPlayerData;
    d.clips = { [String(clipIndex(0, 1))]: { kind: 'note', steps: [], lengthSteps: 8, root: 48, loop: true } };
    d.playing = [null, 0, null, null, null, null, null, null];
    assignAutomationLane(CP, MOD_A, 1);
    toggleLaneArm(1, ydoc.clientID);
    expect(cpData().auto?.[String(clipIndex(0, 1))]).toEqual({ tracks: {} });
    // Arming a DIFFERENT lane (nothing assigned/playing) creates no shell.
    toggleLaneArm(3, ydoc.clientID);
    expect(Object.keys(cpData().auto ?? {})).toEqual([String(clipIndex(0, 1))]);
  });
});
