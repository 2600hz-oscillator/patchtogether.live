// Unit tests for group-building-presence — Y.Awareness soft-lock used by
// the GroupBuilderModal (Module-grouping Phase 3C).
//
// Same StubAwareness pattern as camera-presence.test.ts. Purely functional,
// no Yjs / websocket transport needed.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  GROUP_BUILDING_AWARENESS_FIELD,
  setLocalGroupBuildingSelection,
  readRemoteGroupBuilding,
  indexRemoteGroupBuildingByNode,
  overlapsRemoteGroupBuilding,
  type RemoteGroupBuilding,
} from './group-building-presence';
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
const USER_B: PresenceUser = { id: 'user_b', displayName: 'Bob', color: '#3b82f6' };

describe('group-building-presence', () => {
  describe('setLocalGroupBuildingSelection', () => {
    let aw: StubAwareness;
    let provider: StubProvider;

    beforeEach(() => {
      aw = makeAwareness();
      provider = { awareness: aw };
    });

    it('writes the selectionIds list under groupBuilding', () => {
      setLocalGroupBuildingSelection(provider as never, ['n1', 'n2']);
      expect(aw.getLocalState()?.[GROUP_BUILDING_AWARENESS_FIELD]).toEqual({
        selectionIds: ['n1', 'n2'],
      });
    });

    it('clears the field on null payload', () => {
      setLocalGroupBuildingSelection(provider as never, ['n1']);
      setLocalGroupBuildingSelection(provider as never, null);
      expect(aw.getLocalState()?.[GROUP_BUILDING_AWARENESS_FIELD]).toBeNull();
    });

    it('clears the field on empty array', () => {
      setLocalGroupBuildingSelection(provider as never, ['n1']);
      setLocalGroupBuildingSelection(provider as never, []);
      expect(aw.getLocalState()?.[GROUP_BUILDING_AWARENESS_FIELD]).toBeNull();
    });

    it('no-ops on null provider', () => {
      expect(() => setLocalGroupBuildingSelection(null, ['n1'])).not.toThrow();
    });

    it('no-ops on provider without awareness', () => {
      expect(() =>
        setLocalGroupBuildingSelection({ awareness: null } as never, ['n1']),
      ).not.toThrow();
    });

    it('skips re-broadcast if the value is unchanged', () => {
      setLocalGroupBuildingSelection(provider as never, ['n1', 'n2']);
      const spy = vi.spyOn(aw, 'setLocalStateField');
      setLocalGroupBuildingSelection(provider as never, ['n1', 'n2']);
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('readRemoteGroupBuilding', () => {
    it('excludes the local user', () => {
      const aw = makeAwareness(7);
      aw.states.set(7, { user: USER_A, [GROUP_BUILDING_AWARENESS_FIELD]: { selectionIds: ['a'] } });
      aw.states.set(8, { user: USER_B, [GROUP_BUILDING_AWARENESS_FIELD]: { selectionIds: ['b'] } });
      const remotes = readRemoteGroupBuilding(aw as never, 7);
      expect(remotes.map((r) => r.user.id)).toEqual(['user_b']);
    });

    it('skips peers without the groupBuilding field', () => {
      const aw = makeAwareness(7);
      aw.states.set(8, { user: USER_B }); // no groupBuilding field
      const remotes = readRemoteGroupBuilding(aw as never, 7);
      expect(remotes).toHaveLength(0);
    });

    it('skips peers whose selectionIds is empty', () => {
      const aw = makeAwareness(7);
      aw.states.set(8, { user: USER_B, [GROUP_BUILDING_AWARENESS_FIELD]: { selectionIds: [] } });
      const remotes = readRemoteGroupBuilding(aw as never, 7);
      expect(remotes).toHaveLength(0);
    });

    it('returns the cleared peer (null groupBuilding) as absent', () => {
      const aw = makeAwareness(7);
      aw.states.set(8, { user: USER_B, [GROUP_BUILDING_AWARENESS_FIELD]: null });
      expect(readRemoteGroupBuilding(aw as never, 7)).toHaveLength(0);
    });

    it('returns null/undefined awareness as empty list', () => {
      expect(readRemoteGroupBuilding(null, 1)).toEqual([]);
      expect(readRemoteGroupBuilding(undefined, 1)).toEqual([]);
    });
  });

  describe('indexRemoteGroupBuildingByNode', () => {
    it('maps each node-id → its remote user', () => {
      const remotes: RemoteGroupBuilding[] = [
        { clientId: 1, user: USER_A, selectionIds: ['n1', 'n2'] },
        { clientId: 2, user: USER_B, selectionIds: ['n3'] },
      ];
      const idx = indexRemoteGroupBuildingByNode(remotes);
      expect(idx.n1).toEqual(USER_A);
      expect(idx.n2).toEqual(USER_A);
      expect(idx.n3).toEqual(USER_B);
    });

    it('first remote wins when two peers claim the same node id', () => {
      const remotes: RemoteGroupBuilding[] = [
        { clientId: 1, user: USER_A, selectionIds: ['n1'] },
        { clientId: 2, user: USER_B, selectionIds: ['n1'] },
      ];
      const idx = indexRemoteGroupBuildingByNode(remotes);
      expect(idx.n1).toEqual(USER_A);
    });
  });

  describe('overlapsRemoteGroupBuilding', () => {
    const remoteAClaimsN1N2: RemoteGroupBuilding[] = [
      { clientId: 1, user: USER_A, selectionIds: ['n1', 'n2'] },
    ];

    it('returns true when candidate intersects a remote selection', () => {
      expect(overlapsRemoteGroupBuilding(['n2', 'n3'], remoteAClaimsN1N2)).toBe(true);
    });

    it('returns false when candidate and remotes are disjoint', () => {
      expect(overlapsRemoteGroupBuilding(['n5', 'n6'], remoteAClaimsN1N2)).toBe(false);
    });

    it('returns false on empty candidate', () => {
      expect(overlapsRemoteGroupBuilding([], remoteAClaimsN1N2)).toBe(false);
    });

    it('returns false on empty remotes', () => {
      expect(overlapsRemoteGroupBuilding(['n1'], [])).toBe(false);
    });
  });
});
