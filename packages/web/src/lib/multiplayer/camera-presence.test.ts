// Unit tests for camera-presence — the Y.Awareness writer/reader for the
// "this user has CAMERA active here" badge surface (PR-62).
//
// The CAMERA module's stream is local-only; camera-presence is the layer
// that lets co-creators SEE each other holding cameras without sending
// pixels. These tests use a tiny stub Awareness that mirrors the y-protocols
// API surface our helpers actually touch — it's purely functional, no
// websocket / Yjs transport needed.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  CAMERA_AWARENESS_FIELD,
  setLocalCameraNodeIds,
  addLocalCameraNodeId,
  removeLocalCameraNodeId,
  readRemoteCameraPresence,
  indexRemoteCamerasByNode,
} from './camera-presence';
import type { PresenceUser } from './presence';

interface StubAwareness {
  clientID: number;
  states: Map<number, Record<string, unknown>>;
  setLocalStateField: (key: string, value: unknown) => void;
  getLocalState: () => Record<string, unknown> | null;
  getStates: () => Map<number, Record<string, unknown>>;
}

function makeAwareness(localClientId = 1): StubAwareness {
  const states = new Map<number, Record<string, unknown>>();
  return {
    clientID: localClientId,
    states,
    setLocalStateField(key, value) {
      const prev = states.get(localClientId) ?? {};
      states.set(localClientId, { ...prev, [key]: value });
    },
    getLocalState() {
      return states.get(localClientId) ?? null;
    },
    getStates() {
      return states;
    },
  };
}

interface StubProvider {
  awareness: StubAwareness | null;
}

const USER_A: PresenceUser = { id: 'user_a', displayName: 'Alice', color: '#ef4444' };
const USER_B: PresenceUser = { id: 'user_b', displayName: 'Bob',   color: '#3b82f6' };

describe('camera-presence', () => {
  describe('setLocalCameraNodeIds', () => {
    let aw: StubAwareness;
    let provider: StubProvider;

    beforeEach(() => {
      aw = makeAwareness();
      provider = { awareness: aw };
    });

    it('writes the node-id list under cameraNodeIds', () => {
      setLocalCameraNodeIds(provider as never, ['n1', 'n2']);
      const state = aw.getLocalState();
      expect(state?.[CAMERA_AWARENESS_FIELD]).toEqual(['n1', 'n2']);
    });

    it('clears with an empty array', () => {
      setLocalCameraNodeIds(provider as never, ['n1']);
      setLocalCameraNodeIds(provider as never, []);
      expect(aw.getLocalState()?.[CAMERA_AWARENESS_FIELD]).toEqual([]);
    });

    it('no-ops on null provider', () => {
      expect(() => setLocalCameraNodeIds(null, ['n1'])).not.toThrow();
    });

    it('no-ops on provider without awareness', () => {
      expect(() => setLocalCameraNodeIds({ awareness: null } as never, ['n1'])).not.toThrow();
    });

    it('skips re-broadcast if the value is unchanged', () => {
      setLocalCameraNodeIds(provider as never, ['n1', 'n2']);
      const spy = vi.spyOn(aw, 'setLocalStateField');
      setLocalCameraNodeIds(provider as never, ['n1', 'n2']);
      expect(spy).not.toHaveBeenCalled();
    });

    it('re-broadcasts when length changes', () => {
      setLocalCameraNodeIds(provider as never, ['n1']);
      const spy = vi.spyOn(aw, 'setLocalStateField');
      setLocalCameraNodeIds(provider as never, ['n1', 'n2']);
      expect(spy).toHaveBeenCalledOnce();
    });

    it('re-broadcasts when ordering changes (defensive — array != set semantics)', () => {
      setLocalCameraNodeIds(provider as never, ['n1', 'n2']);
      const spy = vi.spyOn(aw, 'setLocalStateField');
      setLocalCameraNodeIds(provider as never, ['n2', 'n1']);
      expect(spy).toHaveBeenCalledOnce();
    });
  });

  describe('addLocalCameraNodeId', () => {
    let aw: StubAwareness;
    let provider: StubProvider;

    beforeEach(() => {
      aw = makeAwareness();
      provider = { awareness: aw };
    });

    it('adds the first id', () => {
      addLocalCameraNodeId(provider as never, 'cam-1');
      expect(aw.getLocalState()?.[CAMERA_AWARENESS_FIELD]).toEqual(['cam-1']);
    });

    it('appends to the existing set', () => {
      addLocalCameraNodeId(provider as never, 'cam-1');
      addLocalCameraNodeId(provider as never, 'cam-2');
      expect(aw.getLocalState()?.[CAMERA_AWARENESS_FIELD]).toEqual(['cam-1', 'cam-2']);
    });

    it('is idempotent — adding an existing id does not duplicate', () => {
      addLocalCameraNodeId(provider as never, 'cam-1');
      addLocalCameraNodeId(provider as never, 'cam-1');
      expect(aw.getLocalState()?.[CAMERA_AWARENESS_FIELD]).toEqual(['cam-1']);
    });

    it('no-ops on null provider', () => {
      expect(() => addLocalCameraNodeId(null, 'cam-1')).not.toThrow();
    });
  });

  describe('removeLocalCameraNodeId', () => {
    let aw: StubAwareness;
    let provider: StubProvider;

    beforeEach(() => {
      aw = makeAwareness();
      provider = { awareness: aw };
    });

    it('removes the named id', () => {
      addLocalCameraNodeId(provider as never, 'cam-1');
      addLocalCameraNodeId(provider as never, 'cam-2');
      removeLocalCameraNodeId(provider as never, 'cam-1');
      expect(aw.getLocalState()?.[CAMERA_AWARENESS_FIELD]).toEqual(['cam-2']);
    });

    it('is idempotent — removing an absent id is a no-op', () => {
      addLocalCameraNodeId(provider as never, 'cam-1');
      removeLocalCameraNodeId(provider as never, 'cam-other');
      expect(aw.getLocalState()?.[CAMERA_AWARENESS_FIELD]).toEqual(['cam-1']);
    });

    it('handles the case where no cameras were ever added', () => {
      expect(() => removeLocalCameraNodeId(provider as never, 'cam-1')).not.toThrow();
    });

    it('no-ops on null provider', () => {
      expect(() => removeLocalCameraNodeId(null, 'cam-1')).not.toThrow();
    });
  });

  describe('readRemoteCameraPresence', () => {
    it('returns one entry per remote user with active cameras', () => {
      const aw = makeAwareness(1);
      // Local user (id=1) has a camera, but should be excluded from remotes.
      aw.states.set(1, { user: USER_A, [CAMERA_AWARENESS_FIELD]: ['cam-x'] });
      // Remote user (id=2) has cameras.
      aw.states.set(2, { user: USER_B, [CAMERA_AWARENESS_FIELD]: ['cam-y', 'cam-z'] });
      const out = readRemoteCameraPresence(aw as never, 1);
      expect(out).toHaveLength(1);
      expect(out[0].user).toEqual(USER_B);
      expect(out[0].nodeIds).toEqual(['cam-y', 'cam-z']);
      expect(out[0].clientId).toBe(2);
    });

    it('skips remote users with empty camera lists', () => {
      const aw = makeAwareness(1);
      aw.states.set(2, { user: USER_B, [CAMERA_AWARENESS_FIELD]: [] });
      expect(readRemoteCameraPresence(aw as never, 1)).toEqual([]);
    });

    it('skips remote users without the field at all (steady state)', () => {
      const aw = makeAwareness(1);
      aw.states.set(2, { user: USER_B });
      expect(readRemoteCameraPresence(aw as never, 1)).toEqual([]);
    });

    it('skips states without a user field', () => {
      const aw = makeAwareness(1);
      aw.states.set(2, { [CAMERA_AWARENESS_FIELD]: ['cam-y'] });
      expect(readRemoteCameraPresence(aw as never, 1)).toEqual([]);
    });

    it('returns [] when awareness is null/undefined', () => {
      expect(readRemoteCameraPresence(null, 1)).toEqual([]);
      expect(readRemoteCameraPresence(undefined, 1)).toEqual([]);
    });
  });

  describe('indexRemoteCamerasByNode', () => {
    it('maps node id -> first remote user holding it', () => {
      const idx = indexRemoteCamerasByNode([
        { clientId: 2, user: USER_B, nodeIds: ['cam-y', 'cam-z'] },
      ]);
      expect(idx['cam-y']).toEqual(USER_B);
      expect(idx['cam-z']).toEqual(USER_B);
    });

    it('first-write-wins on duplicate node ids', () => {
      const idx = indexRemoteCamerasByNode([
        { clientId: 2, user: USER_A, nodeIds: ['cam-x'] },
        { clientId: 3, user: USER_B, nodeIds: ['cam-x'] },
      ]);
      expect(idx['cam-x']).toEqual(USER_A);
    });

    it('returns empty map for empty input', () => {
      expect(indexRemoteCamerasByNode([])).toEqual({});
    });
  });
});
