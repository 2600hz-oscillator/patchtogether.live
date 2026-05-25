// packages/server/src/reaper.test.ts
//
// Unit coverage for the slot-leak reaper. The reaper reconciles the
// in-memory slot tracker against Hocuspocus's live connections so a slot
// whose socket died without a clean onDisconnect (crashed tab, killed
// machine) self-heals instead of pinning a rack at 4/4 forever.

import { describe, it, expect, vi } from 'vitest';
import { createSlotTracker } from './capacity.js';
import { sweepLeakedSlots, startReaper, type LiveConnectionSource } from './reaper.js';

function fakeServer(
  live: Record<string, string[]>,
): LiveConnectionSource {
  const documents = new Map<string, { getConnections(): Array<{ socketId: string }> }>();
  for (const [name, ids] of Object.entries(live)) {
    documents.set(name, { getConnections: () => ids.map((socketId) => ({ socketId })) });
  }
  return { documents };
}

describe('sweepLeakedSlots', () => {
  it('reaps slots with no matching live connection', () => {
    const slots = createSlotTracker(4);
    // 3 slots acquired, but only s1 is still a live connection — s2 + s3
    // are leaks (their onDisconnect never fired).
    slots.acquire('r1', 's1');
    slots.acquire('r1', 's2');
    slots.acquire('r1', 's3');
    const server = fakeServer({ r1: ['s1'] });

    const reaped = sweepLeakedSlots(slots, server);
    expect(reaped).toBe(2);
    expect(slots.size('r1')).toBe(1);
  });

  it('reaps ALL slots for a doc with no live Document at all', () => {
    const slots = createSlotTracker(4);
    slots.acquire('ghost', 's1');
    slots.acquire('ghost', 's2');
    // server.documents has no entry for "ghost" → every slot is a leak.
    const server = fakeServer({});

    const reaped = sweepLeakedSlots(slots, server);
    expect(reaped).toBe(2);
    expect(slots.size('ghost')).toBe(0);
    expect(slots.docs()).toEqual([]);
  });

  it('is a no-op when every slot has a live connection', () => {
    const slots = createSlotTracker(4);
    slots.acquire('r1', 's1');
    slots.acquire('r1', 's2');
    const server = fakeServer({ r1: ['s1', 's2'] });

    const log = vi.fn();
    const reaped = sweepLeakedSlots(slots, server, log);
    expect(reaped).toBe(0);
    expect(slots.size('r1')).toBe(2);
    // Healthy server stays quiet — no log line unless something was reaped.
    expect(log).not.toHaveBeenCalled();
  });

  it('unsticks a 4/4 rack so a new joiner can connect again', () => {
    // The operator's "stuck rack": 4 slots held, but all 4 sockets are
    // dead (machine was killed mid-connection). A new joiner gets
    // reject(full) until the reaper runs.
    const slots = createSlotTracker(4);
    for (let i = 1; i <= 4; i++) slots.acquire('stuck', `dead${i}`);
    expect(slots.acquire('stuck', 'newcomer')).toBe(false); // 4/4 → rejected

    // No live connections for "stuck" — Document was torn down with the
    // machine but the slots leaked.
    const server = fakeServer({});
    const reaped = sweepLeakedSlots(slots, server);
    expect(reaped).toBe(4);

    // Now the newcomer gets in.
    expect(slots.acquire('stuck', 'newcomer')).toBe(true);
    expect(slots.size('stuck')).toBe(1);
  });

  it('logs only the docs it actually reaped', () => {
    const slots = createSlotTracker(4);
    slots.acquire('healthy', 'h1');
    slots.acquire('leaky', 'l1');
    slots.acquire('leaky', 'l2');
    const server = fakeServer({ healthy: ['h1'], leaky: ['l1'] });

    const log = vi.fn();
    sweepLeakedSlots(slots, server, log);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain('leaky');
    expect(log.mock.calls[0][0]).toContain('reaped 1');
  });
});

describe('startReaper', () => {
  it('sweeps on the configured interval and stop() halts it', () => {
    vi.useFakeTimers();
    try {
      const slots = createSlotTracker(4);
      slots.acquire('r1', 's1'); // will leak (no live conn below)
      const server = fakeServer({});
      const log = vi.fn();

      const handle = startReaper(slots, server, { intervalMs: 1000, log });
      expect(slots.size('r1')).toBe(1); // not swept yet

      vi.advanceTimersByTime(1000);
      expect(slots.size('r1')).toBe(0); // first sweep reaped it

      // After stop(), further ticks don't fire.
      handle.stop();
      slots.acquire('r2', 's2');
      vi.advanceTimersByTime(5000);
      expect(slots.size('r2')).toBe(1); // untouched — reaper stopped
    } finally {
      vi.useRealTimers();
    }
  });
});
