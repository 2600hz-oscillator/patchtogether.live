// packages/web/src/lib/bot/session-lock.test.ts
//
// Tests the generalized bot-session lock — the shared exclusivity layer
// used by Carl + Mike to guarantee at most one bot per rackspace.

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  attemptBotSpawn,
  clearBotSession,
  readBotSession,
} from './session-lock';

function makeRecord(kind: 'carl' | 'mike', who: string) {
  return {
    kind,
    ownerUserId: who,
    ownerDisplayName: who,
    spawnedAt: Date.now(),
    seed: 7,
  } as const;
}

describe('bot/session-lock', () => {
  it('readBotSession is null on a fresh doc', () => {
    const ydoc = new Y.Doc();
    expect(readBotSession(ydoc)).toBeNull();
  });

  it('attemptBotSpawn writes a kind-tagged active record', () => {
    const ydoc = new Y.Doc();
    expect(attemptBotSpawn(ydoc, makeRecord('mike', 'alice'))).toBe(true);
    const r = readBotSession(ydoc);
    expect(r?.kind).toBe('mike');
    expect(r?.ownerUserId).toBe('alice');
    expect(r?.active).toBe(true);
  });

  it('clearBotSession flips active=false', () => {
    const ydoc = new Y.Doc();
    attemptBotSpawn(ydoc, makeRecord('mike', 'alice'));
    clearBotSession(ydoc);
    expect(readBotSession(ydoc)).toBeNull();
  });

  it('Mike refuses spawn while Carl active (different-kind exclusion)', () => {
    const ydoc = new Y.Doc();
    expect(attemptBotSpawn(ydoc, makeRecord('carl', 'alice'))).toBe(true);
    expect(attemptBotSpawn(ydoc, makeRecord('mike', 'bob'))).toBe(false);
    expect(readBotSession(ydoc)?.kind).toBe('carl');
  });

  it('Carl refuses spawn while Mike active (symmetric)', () => {
    const ydoc = new Y.Doc();
    expect(attemptBotSpawn(ydoc, makeRecord('mike', 'alice'))).toBe(true);
    expect(attemptBotSpawn(ydoc, makeRecord('carl', 'bob'))).toBe(false);
    expect(readBotSession(ydoc)?.kind).toBe('mike');
  });

  it('same-kind re-spawn is idempotent (replaces the record)', () => {
    const ydoc = new Y.Doc();
    attemptBotSpawn(ydoc, makeRecord('mike', 'alice'));
    expect(attemptBotSpawn(ydoc, makeRecord('mike', 'alice2'))).toBe(true);
    expect(readBotSession(ydoc)?.ownerUserId).toBe('alice2');
  });

  it('legacy carlSession map is read as an active Carl record', () => {
    // Simulate a doc written by old Carl-only code: only the legacy
    // carlSession Y.Map is populated.
    const ydoc = new Y.Doc();
    const legacy = ydoc.getMap('carlSession');
    legacy.set('ownerUserId', 'legacy-carl');
    legacy.set('ownerDisplayName', 'OldCarl');
    legacy.set('spawnedAt', 1);
    legacy.set('seed', 2);
    legacy.set('active', true);
    const r = readBotSession(ydoc);
    expect(r?.kind).toBe('carl');
    expect(r?.ownerUserId).toBe('legacy-carl');
    expect(r?.active).toBe(true);
    // ... and Mike can't spawn over a legacy Carl either.
    expect(attemptBotSpawn(ydoc, makeRecord('mike', 'bob'))).toBe(false);
  });

  it('clearing legacy + bot maps leaves the lock free for the other bot', () => {
    const ydoc = new Y.Doc();
    attemptBotSpawn(ydoc, makeRecord('carl', 'alice'));
    clearBotSession(ydoc);
    expect(attemptBotSpawn(ydoc, makeRecord('mike', 'bob'))).toBe(true);
    expect(readBotSession(ydoc)?.kind).toBe('mike');
  });
});
