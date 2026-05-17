// packages/web/src/lib/carl/session-ephemeral.test.ts
//
// Unit tests for the Y.Map-based exclusivity layer. We don't spin up a
// real Hocuspocus connection — instead we simulate "two clients" by
// creating two Y.Doc instances and manually applying updates between
// them, which is the canonical Yjs unit-test pattern.

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  attemptSpawn,
  clearSession,
  observeSession,
  readCarlSession,
} from './session-ephemeral';

function applyUpdates(from: Y.Doc, to: Y.Doc): void {
  const update = Y.encodeStateAsUpdate(from);
  Y.applyUpdate(to, update);
}

describe('session-ephemeral — Y.Map lock', () => {
  it('records the spawner in readCarlSession', () => {
    const ydoc = new Y.Doc();
    expect(readCarlSession(ydoc)).toBeNull();
    attemptSpawn(ydoc, {
      ownerUserId: 'u1',
      ownerDisplayName: 'Alice',
      spawnedAt: 1000,
      seed: 42,
    });
    expect(readCarlSession(ydoc)).toEqual({
      ownerUserId: 'u1',
      ownerDisplayName: 'Alice',
      spawnedAt: 1000,
      seed: 42,
    });
  });

  it('refuses a local spawn when one is already active', () => {
    const ydoc = new Y.Doc();
    const ok = attemptSpawn(ydoc, {
      ownerUserId: 'u1',
      ownerDisplayName: 'Alice',
      spawnedAt: 1000,
      seed: 1,
    });
    expect(ok).toBe(true);
    const ok2 = attemptSpawn(ydoc, {
      ownerUserId: 'u2',
      ownerDisplayName: 'Bob',
      spawnedAt: 1001,
      seed: 2,
    });
    expect(ok2).toBe(false);
    expect(readCarlSession(ydoc)?.ownerUserId).toBe('u1');
  });

  it('clearSession removes the record', () => {
    const ydoc = new Y.Doc();
    attemptSpawn(ydoc, {
      ownerUserId: 'u1',
      ownerDisplayName: 'Alice',
      spawnedAt: 1000,
      seed: 1,
    });
    clearSession(ydoc);
    expect(readCarlSession(ydoc)).toBeNull();
  });

  it('two concurrent docs converge to a single owner after merge', () => {
    // Simulate two browser tabs that both attempt to spawn before they
    // sync. Yjs guarantees a deterministic winner after merge.
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    attemptSpawn(docA, {
      ownerUserId: 'alice',
      ownerDisplayName: 'Alice',
      spawnedAt: 1000,
      seed: 11,
    });
    attemptSpawn(docB, {
      ownerUserId: 'bob',
      ownerDisplayName: 'Bob',
      spawnedAt: 1001,
      seed: 22,
    });
    // Exchange updates.
    applyUpdates(docA, docB);
    applyUpdates(docB, docA);
    const a = readCarlSession(docA);
    const b = readCarlSession(docB);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    // Same winner on both sides.
    expect(a?.ownerUserId).toBe(b?.ownerUserId);
    // And it's one of the two attempted spawners.
    expect(['alice', 'bob']).toContain(a?.ownerUserId);
  });

  it('observeSession fires on initial subscribe + on change', () => {
    const ydoc = new Y.Doc();
    const seen: Array<ReturnType<typeof readCarlSession>> = [];
    const off = observeSession(ydoc, (r) => seen.push(r));
    // Initial fire = null.
    expect(seen).toEqual([null]);
    attemptSpawn(ydoc, {
      ownerUserId: 'u1',
      ownerDisplayName: 'A',
      spawnedAt: 1,
      seed: 0,
    });
    expect(seen.length).toBeGreaterThan(1);
    expect(seen[seen.length - 1]?.ownerUserId).toBe('u1');
    clearSession(ydoc);
    expect(seen[seen.length - 1]).toBeNull();
    off();
  });
});
