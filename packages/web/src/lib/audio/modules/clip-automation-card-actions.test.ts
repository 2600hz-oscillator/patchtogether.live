// packages/web/src/lib/audio/modules/clip-automation-card-actions.test.ts
//
// Real-Y.Doc test for the CARD + MENU automation actions (per-clip redesign,
// Phase B). The context-menu "Assign to automation lane ▸ 1–8" / "Remove
// automation assignment" writes go through the REAL shared seam
// ($lib/graph/automation-assign — the exact functions makeMidiAssignable
// calls), driven here against the app's live graph store; the card's ◉ AUTO
// arm toggle is mirrored (a thin data write inside a Svelte component). Proves:
//
//   • assign writes autoAssign[targetKey] = lane (single-key, in place);
//   • ONE lane per param: re-assigning MOVES it (same player, other lane) and
//     assigning on ANOTHER player removes it there too — atomically;
//   • remove drops the key from whichever player holds it;
//   • prune drops ONLY module-absent targets (conservative), no-op otherwise;
//   • arm sets arm + recorderId (single-writer, isAutomationRecorder true);
//   • the chip-row source (autoAssignCounts) mirrors the map exactly.

import { describe, it, expect, beforeEach } from 'vitest';
import * as Y from 'yjs';
import { patch, ydoc, LOCAL_ORIGIN } from '$lib/graph/store';
import {
  assignAutomationLane,
  removeAutomationAssignment,
  automationAssignmentFor,
  pruneAutoAssignDangling,
  listClipPlayers,
  hasRecordedAutomation,
  clearRecordedAutomation,
  clearClipAutomation,
} from '$lib/graph/automation-assign';
import {
  coerceAutoAssign,
  autoAssignCounts,
  assignedLaneOf,
  isAutomationRecorder,
  automationTargetKey,
  ensureArmAutoShells,
  clipIndex,
  type AutoClipRecord,
  type ClipPlayerData,
  type AutomationTarget,
} from './clip-types';

const CP = 'cp-actions-1';
const CP2 = 'cp-actions-2';
const A: AutomationTarget = { nodeId: 'vco-x', paramId: 'freq' };
const B: AutomationTarget = { nodeId: 'vcf-x', paramId: 'cutoff' };

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

// ── mirrors ClipplayerCard.toggleAutoArm (arming) ────────────────────────────
function armAutomation(clientId: number): void {
  const live = patch.nodes[CP]!;
  if (!live.data) live.data = {};
  const data = live.data as ClipPlayerData;
  if (!data.automation) data.automation = {};
  data.automation.arm = true;
  data.automation.recorderId = clientId;
}

beforeEach(() => {
  clearPatch();
  seedNode(CP, 'clipplayer');
  seedNode(A.nodeId, 'vco');
  seedNode(B.nodeId, 'vcf');
});

describe('clip-automation card/menu actions (real Y.Doc, shared assign seam)', () => {
  it('assign writes autoAssign[targetKey] = lane (and the reads mirror it)', () => {
    expect(() => assignAutomationLane(CP, A, 3)).not.toThrow();
    expect(coerceAutoAssign(cpData().autoAssign)).toEqual({ [automationTargetKey(A)]: 3 });
    expect(assignedLaneOf(cpData(), A)).toBe(3);
    expect(automationAssignmentFor(patch.nodes, A)).toEqual({ nodeId: CP, lane: 3 });
    // UI-CAN'T-LIE: the chip row renders EXACTLY this.
    expect(autoAssignCounts(cpData())).toEqual([0, 0, 0, 1, 0, 0, 0, 0]);
  });

  it('ONE lane per param: re-assigning MOVES it to the new lane (no duplicate)', () => {
    assignAutomationLane(CP, A, 3);
    assignAutomationLane(CP, A, 5);
    expect(coerceAutoAssign(cpData().autoAssign)).toEqual({ [automationTargetKey(A)]: 5 });
    expect(autoAssignCounts(cpData())).toEqual([0, 0, 0, 0, 0, 1, 0, 0]);
  });

  it('assigning on ANOTHER player removes it from the first (atomic cross-player move)', () => {
    seedNode(CP2, 'clipplayer');
    assignAutomationLane(CP, A, 2);
    assignAutomationLane(CP2, A, 6);
    expect(assignedLaneOf(cpData(CP), A)).toBeNull();
    expect(assignedLaneOf(cpData(CP2), A)).toBe(6);
    expect(automationAssignmentFor(patch.nodes, A)).toEqual({ nodeId: CP2, lane: 6 });
  });

  it('two params can share a lane; counts reflect both', () => {
    assignAutomationLane(CP, A, 1);
    assignAutomationLane(CP, B, 1);
    expect(autoAssignCounts(cpData())).toEqual([0, 2, 0, 0, 0, 0, 0, 0]);
  });

  it('remove drops only that param’s assignment', () => {
    assignAutomationLane(CP, A, 1);
    assignAutomationLane(CP, B, 4);
    removeAutomationAssignment(A);
    expect(assignedLaneOf(cpData(), A)).toBeNull();
    expect(assignedLaneOf(cpData(), B)).toBe(4);
    // Removing an unassigned target is a safe no-op.
    expect(() => removeAutomationAssignment(A)).not.toThrow();
  });

  it('lane is clamped into 0..7; a non-clipplayer target player is a no-op', () => {
    assignAutomationLane(CP, A, 99);
    expect(assignedLaneOf(cpData(), A)).toBe(7);
    assignAutomationLane(A.nodeId, B, 2); // not a clipplayer → no-op
    expect(automationAssignmentFor(patch.nodes, B)).toBeNull();
  });

  it('prune drops ONLY module-absent targets (conservative) and is a no-op otherwise', () => {
    assignAutomationLane(CP, A, 1);
    assignAutomationLane(CP, B, 2);
    expect(pruneAutoAssignDangling(CP)).toBe(0); // both modules present → no-op
    delete patch.nodes[A.nodeId]; // the assigned module is deleted
    expect(pruneAutoAssignDangling(CP)).toBe(1);
    expect(assignedLaneOf(cpData(), A)).toBeNull(); // dangling assignment gone
    expect(assignedLaneOf(cpData(), B)).toBe(2); // the live one stays
    expect(pruneAutoAssignDangling(CP)).toBe(0); // idempotent
  });

  it('listClipPlayers finds every clipplayer (all accept assignments — no stamped clip)', () => {
    seedNode(CP2, 'clipplayer');
    expect(listClipPlayers(patch.nodes).sort()).toEqual([CP, CP2].sort());
  });

  it('arm sets arm + recorderId (single-writer gate true)', () => {
    assignAutomationLane(CP, A, 0);
    armAutomation(ydoc.clientID);
    const data = cpData();
    expect(data.automation?.arm).toBe(true);
    expect(data.automation?.recorderId).toBe(ydoc.clientID);
    expect(isAutomationRecorder(data, ydoc.clientID)).toBe(true);
    expect(isAutomationRecorder(data, ydoc.clientID + 1)).toBe(false); // only the arming client
  });

  it('the whole assign→arm→move→remove cycle never throws (re-integration safe)', () => {
    expect(() => {
      assignAutomationLane(CP, A, 0);
      assignAutomationLane(CP, B, 3);
      armAutomation(ydoc.clientID);
      assignAutomationLane(CP, A, 3); // move
      removeAutomationAssignment(A);
      removeAutomationAssignment(B);
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

  it('clearRecordedAutomation (ASSIGNED): wipes the key from its assigned LANE only; empty shells deleted', () => {
    // A recorded in lane 2 (two clips) AND lane 4 (one clip); assigned to lane 2.
    seedRecorded(0, 2, [A, B]);
    seedRecorded(1, 2, [A]);
    seedRecorded(0, 4, [A]);
    assignAutomationLane(CP, A, 2);
    const removed = clearRecordedAutomation(A);
    expect(removed).toBe(2); // both lane-2 clips
    const auto = cpData().auto!;
    const keyA = automationTargetKey(A);
    // Lane 2 slot 0: A gone, B (other track) kept.
    expect((auto[String(clipIndex(0, 2))] as AutoClipRecord).tracks[keyA]).toBeUndefined();
    expect((auto[String(clipIndex(0, 2))] as AutoClipRecord).tracks[automationTargetKey(B)]).toBeTruthy();
    // Lane 2 slot 1 held ONLY A → the whole record is deleted (no empty shell).
    expect(auto[String(clipIndex(1, 2))]).toBeUndefined();
    // Lane 4 (NOT the assigned lane) keeps its recording.
    expect((auto[String(clipIndex(0, 4))] as AutoClipRecord).tracks[keyA]).toBeTruthy();
  });

  it('clearRecordedAutomation (UNASSIGNED): wipes the key from EVERY clip', () => {
    seedRecorded(0, 2, [A]);
    seedRecorded(0, 4, [A]);
    expect(clearRecordedAutomation(A)).toBe(2);
    expect(hasRecordedAutomation(patch.nodes, A)).toBe(false);
    expect(clearRecordedAutomation(A), 'idempotent — nothing left').toBe(0);
  });

  it('clearRecordedAutomation is ONE undoable step (LOCAL_ORIGIN); undo restores the take', () => {
    seedRecorded(0, 2, [A]);
    seedRecorded(1, 2, [A]);
    assignAutomationLane(CP, A, 2);
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

describe('ensureArmAutoShells via the ARM mirror (container-LWW hardening)', () => {
  it('arming pre-creates auto[k] shells for playing lanes with assigned params', () => {
    const live = patch.nodes[CP]!;
    if (!live.data) live.data = {};
    const d = live.data as ClipPlayerData;
    d.clips = { [String(clipIndex(0, 1))]: { kind: 'note', steps: [], lengthSteps: 8, root: 48, loop: true } };
    d.playing = [null, 0, null, null, null, null, null, null];
    assignAutomationLane(CP, A, 1);
    // The card's toggleAutoArm (arming branch): arm + recorderId + shells.
    const data = cpData();
    if (!data.automation) (live.data as ClipPlayerData).automation = {};
    (live.data as ClipPlayerData).automation!.arm = true;
    (live.data as ClipPlayerData).automation!.recorderId = ydoc.clientID;
    ensureArmAutoShells(live.data as ClipPlayerData);
    expect(cpData().auto?.[String(clipIndex(0, 1))]).toEqual({ tracks: {} });
  });
});
