// packages/server/src/capacity.test.ts
//
// Unit coverage for the slot tracker. The actual hocuspocus integration
// is covered by an e2e test (e2e/tests/capacity.spec.ts) that opens 5
// browser contexts against the same rackspace.

import { describe, it, expect } from 'vitest';
import { createSlotTracker, RACKSPACE_MAX_CONNECTIONS } from './capacity.js';

describe('SlotTracker', () => {
  it('admits up to limit connections per doc', () => {
    const t = createSlotTracker(4);
    expect(t.acquire('r1', 's1')).toBe(true);
    expect(t.acquire('r1', 's2')).toBe(true);
    expect(t.acquire('r1', 's3')).toBe(true);
    expect(t.acquire('r1', 's4')).toBe(true);
    expect(t.size('r1')).toBe(4);
  });

  it('rejects the (limit + 1)th connection', () => {
    const t = createSlotTracker(4);
    for (let i = 1; i <= 4; i++) t.acquire('r1', `s${i}`);
    expect(t.acquire('r1', 's5')).toBe(false);
    expect(t.size('r1')).toBe(4);
  });

  it('frees a slot on release', () => {
    const t = createSlotTracker(4);
    for (let i = 1; i <= 4; i++) t.acquire('r1', `s${i}`);
    t.release('r1', 's2');
    expect(t.size('r1')).toBe(3);
    expect(t.acquire('r1', 's5')).toBe(true);
    expect(t.size('r1')).toBe(4);
  });

  it('isolates capacity per documentName', () => {
    const t = createSlotTracker(2);
    expect(t.acquire('r1', 's1')).toBe(true);
    expect(t.acquire('r1', 's2')).toBe(true);
    expect(t.acquire('r2', 's3')).toBe(true); // r2 has its own pool
    expect(t.acquire('r2', 's4')).toBe(true);
    expect(t.acquire('r1', 's5')).toBe(false); // r1 still full
    expect(t.acquire('r2', 's6')).toBe(false); // r2 also full
  });

  it('acquire is idempotent on the same socketId', () => {
    const t = createSlotTracker(4);
    expect(t.acquire('r1', 's1')).toBe(true);
    expect(t.acquire('r1', 's1')).toBe(true); // same id, no double-count
    expect(t.size('r1')).toBe(1);
  });

  it('release is idempotent on an unknown socketId', () => {
    const t = createSlotTracker(4);
    t.release('r1', 'never-acquired'); // does not throw
    t.acquire('r1', 's1');
    t.release('r1', 's1');
    t.release('r1', 's1'); // double release is no-op
    expect(t.size('r1')).toBe(0);
  });

  it('garbage-collects empty doc entries', () => {
    const t = createSlotTracker(4);
    t.acquire('r1', 's1');
    t.acquire('r2', 's2');
    expect(t.docs().sort()).toEqual(['r1', 'r2']);
    t.release('r1', 's1');
    expect(t.docs()).toEqual(['r2']);
  });

  it('reconcile drops held slots not in the live set and reports the count', () => {
    const t = createSlotTracker(4);
    t.acquire('r1', 's1');
    t.acquire('r1', 's2');
    t.acquire('r1', 's3');
    // s2 died without firing release; reconcile against the surviving set.
    const reaped = t.reconcile('r1', ['s1', 's3']);
    expect(reaped).toBe(1);
    expect(t.size('r1')).toBe(2);
  });

  it('reconcile against an empty set frees the whole doc', () => {
    const t = createSlotTracker(4);
    t.acquire('r1', 's1');
    t.acquire('r1', 's2');
    const reaped = t.reconcile('r1', []);
    expect(reaped).toBe(2);
    expect(t.size('r1')).toBe(0);
    expect(t.docs()).toEqual([]); // empty doc entry is GC'd
  });

  it('reconcile is a no-op when every slot is still live', () => {
    const t = createSlotTracker(4);
    t.acquire('r1', 's1');
    t.acquire('r1', 's2');
    expect(t.reconcile('r1', ['s1', 's2'])).toBe(0);
    expect(t.size('r1')).toBe(2);
  });

  it('reconcile on an unknown doc is a no-op', () => {
    const t = createSlotTracker(4);
    expect(t.reconcile('never-seen', ['x'])).toBe(0);
  });

  it('default limit matches RACKSPACE_MAX_CONNECTIONS', () => {
    expect(RACKSPACE_MAX_CONNECTIONS).toBe(4);
    const t = createSlotTracker();
    for (let i = 1; i <= RACKSPACE_MAX_CONNECTIONS; i++) {
      expect(t.acquire('r1', `s${i}`)).toBe(true);
    }
    expect(t.acquire('r1', 'overflow')).toBe(false);
  });
});
