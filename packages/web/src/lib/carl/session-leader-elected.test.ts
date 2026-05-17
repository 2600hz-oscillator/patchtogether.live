// packages/web/src/lib/carl/session-leader-elected.test.ts
//
// Unit tests for the leader-elected exclusivity layer. We simulate
// Y.Awareness with a tiny in-memory shim — the real Awareness class
// has the same interface but pulling it in requires a Y.Doc + browser
// globals (its constructor reads from `crypto` for clientID generation).

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  attemptSpawn,
  clearSession,
  computeLeader,
  readCarlSession,
  publishLeaderCandidacy,
  withdrawLeaderCandidacy,
} from './session-leader-elected';

function applyUpdates(from: Y.Doc, to: Y.Doc): void {
  const update = Y.encodeStateAsUpdate(from);
  Y.applyUpdate(to, update);
}

/** Minimal awareness shim — same shape as y-protocols/awareness. */
class FakeAwareness {
  clientID: number;
  private states = new Map<number, Record<string, unknown>>();
  private handlers = new Set<() => void>();
  constructor(clientID: number) {
    this.clientID = clientID;
    this.states.set(clientID, {});
  }
  /** Pretend a peer connected and joined the awareness pool. */
  attachPeer(other: FakeAwareness): void {
    this.states.set(other.clientID, other.getLocalState() ?? {});
    other.states.set(this.clientID, this.getLocalState() ?? {});
    this.fire();
    other.fire();
  }
  /** Pretend a peer disconnected. */
  detachPeer(clientId: number): void {
    this.states.delete(clientId);
    this.fire();
  }
  getStates() {
    return this.states;
  }
  getLocalState(): Record<string, unknown> | null {
    return this.states.get(this.clientID) ?? null;
  }
  setLocalStateField(field: string, value: unknown): void {
    const cur = this.states.get(this.clientID) ?? {};
    if (value === null) {
      delete cur[field];
    } else {
      cur[field] = value;
    }
    this.states.set(this.clientID, cur);
    this.fire();
  }
  on(_event: 'change' | 'update', handler: () => void): void {
    this.handlers.add(handler);
  }
  off(_event: 'change' | 'update', handler: () => void): void {
    this.handlers.delete(handler);
  }
  private fire() {
    for (const h of this.handlers) h();
  }
}

describe('session-leader-elected — session record', () => {
  it('active=true flag gates readCarlSession', () => {
    const ydoc = new Y.Doc();
    expect(readCarlSession(ydoc)).toBeNull();
    attemptSpawn(ydoc, {
      ownerUserId: 'u1',
      ownerDisplayName: 'Alice',
      spawnedAt: 1000,
      seed: 7,
    });
    const r = readCarlSession(ydoc);
    expect(r).not.toBeNull();
    expect(r?.active).toBe(true);
    expect(r?.ownerUserId).toBe('u1');
  });

  it('clearSession flips active=false', () => {
    const ydoc = new Y.Doc();
    attemptSpawn(ydoc, {
      ownerUserId: 'u1',
      ownerDisplayName: 'Alice',
      spawnedAt: 1000,
      seed: 7,
    });
    clearSession(ydoc);
    expect(readCarlSession(ydoc)).toBeNull();
  });

  it('refuses a second spawn while active', () => {
    const ydoc = new Y.Doc();
    expect(
      attemptSpawn(ydoc, {
        ownerUserId: 'u1',
        ownerDisplayName: 'Alice',
        spawnedAt: 1000,
        seed: 1,
      }),
    ).toBe(true);
    expect(
      attemptSpawn(ydoc, {
        ownerUserId: 'u2',
        ownerDisplayName: 'Bob',
        spawnedAt: 1001,
        seed: 2,
      }),
    ).toBe(false);
    expect(readCarlSession(ydoc)?.ownerUserId).toBe('u1');
  });

  it('two concurrent docs converge to a single owner after merge', () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    attemptSpawn(docA, {
      ownerUserId: 'alice',
      ownerDisplayName: 'A',
      spawnedAt: 1,
      seed: 0,
    });
    attemptSpawn(docB, {
      ownerUserId: 'bob',
      ownerDisplayName: 'B',
      spawnedAt: 2,
      seed: 0,
    });
    applyUpdates(docA, docB);
    applyUpdates(docB, docA);
    const a = readCarlSession(docA);
    const b = readCarlSession(docB);
    expect(a?.ownerUserId).toBe(b?.ownerUserId);
    expect(['alice', 'bob']).toContain(a?.ownerUserId);
  });
});

describe('session-leader-elected — leader election', () => {
  it('no candidates → no leader', () => {
    const aw = new FakeAwareness(7);
    expect(computeLeader(aw)).toEqual({
      leaderClientId: null,
      isLocalLeader: false,
      candidates: [],
    });
  });

  it('one candidate → that candidate is the leader', () => {
    const aw = new FakeAwareness(5);
    publishLeaderCandidacy(aw);
    const info = computeLeader(aw);
    expect(info.leaderClientId).toBe(5);
    expect(info.isLocalLeader).toBe(true);
    expect(info.candidates).toEqual([5]);
  });

  it('lowest clientId wins among multiple candidates', () => {
    const aw1 = new FakeAwareness(11);
    const aw2 = new FakeAwareness(3);
    const aw3 = new FakeAwareness(8);
    publishLeaderCandidacy(aw1);
    publishLeaderCandidacy(aw2);
    publishLeaderCandidacy(aw3);
    aw1.attachPeer(aw2);
    aw1.attachPeer(aw3);
    const info = computeLeader(aw1);
    expect(info.leaderClientId).toBe(3);
    expect(info.candidates).toEqual([3, 8, 11]);
    // Local for aw1 (clientID=11) is NOT the leader.
    expect(info.isLocalLeader).toBe(false);
  });

  it('withdrawing candidacy removes a candidate', () => {
    const aw1 = new FakeAwareness(11);
    const aw2 = new FakeAwareness(3);
    publishLeaderCandidacy(aw1);
    publishLeaderCandidacy(aw2);
    aw1.attachPeer(aw2);
    expect(computeLeader(aw1).leaderClientId).toBe(3);
    withdrawLeaderCandidacy(aw2);
    // The "remote" aw1 still has aw2's old state cached — in real
    // Awareness, aw2's withdrawal would propagate via an update event.
    // Simulate by re-attaching state.
    aw1.attachPeer(aw2);
    expect(computeLeader(aw1).leaderClientId).toBe(11);
  });

  it('peer disconnect frees the leadership to the next-lowest', () => {
    const aw1 = new FakeAwareness(11);
    const aw2 = new FakeAwareness(3);
    publishLeaderCandidacy(aw1);
    publishLeaderCandidacy(aw2);
    aw1.attachPeer(aw2);
    expect(computeLeader(aw1).leaderClientId).toBe(3);
    // aw2 drops off the rack.
    aw1.detachPeer(3);
    expect(computeLeader(aw1).leaderClientId).toBe(11);
    expect(computeLeader(aw1).isLocalLeader).toBe(true);
  });
});
