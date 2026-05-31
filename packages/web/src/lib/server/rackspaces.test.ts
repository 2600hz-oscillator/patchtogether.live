// packages/web/src/lib/server/rackspaces.test.ts
//
// Regression for the "stuck guest rack" bug: a user who joined someone
// else's rackspace had no way to remove it from their dashboard, because
// the only removal path was owner-only DELETE. `leaveRackspace` adds a
// non-owner exit that frees their slot.
//
// We mock the Neon HTTP `sql()` tagged-template so the test exercises the
// result-classification logic (the four LeaveResult cases) without a live
// Postgres. The CTE returns a single row of boolean flags; the mock yields
// the row shape for each scenario.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlTagMock = vi.fn();

// `sql()` returns a tagged-template function; the data layer calls it as
// `sql()\`...\``. Mock both layers: `sql` -> () => tagFn, tagFn -> rows.
vi.mock('./db.js', () => ({
  sql: () => sqlTagMock,
}));

const { leaveRackspace, seedRackspaceForTest } = await import('./rackspaces');

interface LeaveRow {
  rack_exists: boolean;
  is_owner: boolean;
  is_member: boolean;
  deleted: boolean;
}

function mockLeaveRow(row: LeaveRow) {
  sqlTagMock.mockResolvedValueOnce([row]);
}

describe('leaveRackspace', () => {
  beforeEach(() => {
    sqlTagMock.mockReset();
  });

  it('a non-owner member leaves successfully (slot freed)', async () => {
    // Rack exists, requester is not the owner, was a member, row deleted.
    mockLeaveRow({ rack_exists: true, is_owner: false, is_member: true, deleted: true });
    const result = await leaveRackspace('r_33gjdw9j', 'user_guest');
    expect(result).toBe('ok');
    expect(sqlTagMock).toHaveBeenCalledTimes(1);
  });

  it('the owner is rejected (must delete, not leave)', async () => {
    // Owner row is structural; the CTE never deletes it (deleted=false).
    mockLeaveRow({ rack_exists: true, is_owner: true, is_member: true, deleted: false });
    const result = await leaveRackspace('r_33gjdw9j', 'user_owner');
    expect(result).toBe('is-owner');
  });

  it('a non-member is rejected', async () => {
    mockLeaveRow({ rack_exists: true, is_owner: false, is_member: false, deleted: false });
    const result = await leaveRackspace('r_33gjdw9j', 'user_stranger');
    expect(result).toBe('not-member');
  });

  it('a missing rackspace returns not-found', async () => {
    mockLeaveRow({ rack_exists: false, is_owner: false, is_member: false, deleted: false });
    const result = await leaveRackspace('r_nope', 'user_guest');
    expect(result).toBe('not-found');
  });
});

describe('seedRackspaceForTest', () => {
  beforeEach(() => {
    sqlTagMock.mockReset();
  });

  it('returns the inserted rackspace shape (no snapshot)', async () => {
    // Only the racks INSERT is invoked; rack_snapshots is skipped when snapshot
    // is absent.
    sqlTagMock.mockResolvedValueOnce([
      {
        id: 'r_seedtest1',
        owner_user_id: 'test_seed_xyz',
        name: 'Test rackspace',
        created_at: '2026-05-30T08:00:00Z',
      },
    ]);
    const result = await seedRackspaceForTest({
      ownerUserId: 'test_seed_xyz',
      name: 'Test rackspace',
    });
    expect(result.id).toBe('r_seedtest1');
    expect(result.ownerUserId).toBe('test_seed_xyz');
    expect(result.memberUserIds).toEqual(['test_seed_xyz']);
    expect(sqlTagMock).toHaveBeenCalledTimes(1);
  });

  it('inserts rack + rack_snapshots when snapshot is provided', async () => {
    sqlTagMock.mockResolvedValueOnce([
      {
        id: 'r_seedtest2',
        owner_user_id: 'test_seed_qrs',
        name: 'With snapshot',
        created_at: '2026-05-30T08:00:00Z',
      },
    ]);
    // Snapshot path is a separate `await sql()\`...\``; it just needs to
    // resolve (the route doesn't read its return value).
    sqlTagMock.mockResolvedValueOnce([]);
    const snapshot = new Uint8Array([1, 2, 3, 4, 5]);
    const result = await seedRackspaceForTest({
      ownerUserId: 'test_seed_qrs',
      name: 'With snapshot',
      snapshot,
    });
    expect(result.id).toBe('r_seedtest2');
    expect(sqlTagMock).toHaveBeenCalledTimes(2);
  });

  it('skips the snapshot insert when bytes are empty', async () => {
    sqlTagMock.mockResolvedValueOnce([
      {
        id: 'r_seedtest3',
        owner_user_id: 'test_seed_abc',
        name: 'Empty snap',
        created_at: '2026-05-30T08:00:00Z',
      },
    ]);
    await seedRackspaceForTest({
      ownerUserId: 'test_seed_abc',
      name: 'Empty snap',
      snapshot: new Uint8Array(0),
    });
    // Only the racks insert; the empty Uint8Array shouldn't trigger the
    // snapshot INSERT.
    expect(sqlTagMock).toHaveBeenCalledTimes(1);
  });

  it('throws on no-row return (id collision)', async () => {
    sqlTagMock.mockResolvedValueOnce([]);
    await expect(
      seedRackspaceForTest({ ownerUserId: 'test_seed_zzz', name: 'collide' }),
    ).rejects.toThrow(/no row/);
  });
});
