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

// ---------------- WORKFLOW MODE P1: the racks.mode column ----------------

const { createRackspace, getRackspace } = await import('./rackspaces');

describe('createRackspace — mode plumbing', () => {
  beforeEach(() => {
    sqlTagMock.mockReset();
  });

  function mockCreateRow(mode: string | null) {
    sqlTagMock.mockResolvedValueOnce([
      {
        owned_n: 0,
        id: 'r_modetest1',
        owner_user_id: 'user_a',
        name: 'My rack',
        created_at: '2026-07-10T08:00:00Z',
        mode,
      },
    ]);
  }

  it('binds the requested mode into the INSERT and returns it', async () => {
    mockCreateRow('workflow');
    const result = await createRackspace('user_a', 'My rack', 'workflow');
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.rackspace.mode).toBe('workflow');
    // The tagged-template call carries 'workflow' as a bound parameter.
    const boundValues = sqlTagMock.mock.calls[0].slice(1);
    expect(boundValues).toContain('workflow');
    expect(boundValues).toContain('user_a');
  });

  it('defaults to dawless when the caller omits mode', async () => {
    mockCreateRow('dawless');
    const result = await createRackspace('user_a', 'My rack');
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.rackspace.mode).toBe('dawless');
    const boundValues = sqlTagMock.mock.calls[0].slice(1);
    expect(boundValues).toContain('dawless');
    expect(boundValues).not.toContain('workflow');
  });

  it('cap-reached path is unchanged by mode', async () => {
    sqlTagMock.mockResolvedValueOnce([
      { owned_n: 4, id: null, owner_user_id: null, name: null, created_at: null, mode: null },
    ]);
    const result = await createRackspace('user_a', 'One too many', 'workflow');
    expect(result).toEqual({ status: 'cap-reached', ownedCount: 4 });
  });
});

describe('getRackspace — old rows without mode read as dawless', () => {
  beforeEach(() => {
    sqlTagMock.mockReset();
  });

  function mockGetRow(mode: string | null | undefined) {
    sqlTagMock.mockResolvedValueOnce([
      {
        id: 'r_oldrow',
        owner_user_id: 'user_b',
        name: 'Pre-migration rack',
        created_at: '2026-01-01T00:00:00Z',
        member_user_ids: ['user_b'],
        ...(mode === undefined ? {} : { mode }),
      },
    ]);
  }

  it('a NULL / absent mode column value normalizes to dawless', async () => {
    mockGetRow(null);
    expect((await getRackspace('r_oldrow'))?.mode).toBe('dawless');
    mockGetRow(undefined);
    expect((await getRackspace('r_oldrow'))?.mode).toBe('dawless');
  });

  it('a stored workflow mode round-trips', async () => {
    mockGetRow('workflow');
    expect((await getRackspace('r_oldrow'))?.mode).toBe('workflow');
  });

  it('garbage in the column normalizes to dawless (defensive)', async () => {
    mockGetRow('yolo');
    expect((await getRackspace('r_oldrow'))?.mode).toBe('dawless');
  });
});

describe('seedRackspaceForTest — mode plumbing', () => {
  beforeEach(() => {
    sqlTagMock.mockReset();
  });

  it('binds the requested mode and returns it', async () => {
    sqlTagMock.mockResolvedValueOnce([
      {
        id: 'r_seedwf',
        owner_user_id: 'test_seed_wf',
        name: 'Workflow seed',
        created_at: '2026-07-10T08:00:00Z',
        mode: 'workflow',
      },
    ]);
    const result = await seedRackspaceForTest({
      ownerUserId: 'test_seed_wf',
      name: 'Workflow seed',
      mode: 'workflow',
    });
    expect(result.mode).toBe('workflow');
    expect(sqlTagMock.mock.calls[0].slice(1)).toContain('workflow');
  });

  it('defaults to dawless when mode is omitted', async () => {
    sqlTagMock.mockResolvedValueOnce([
      {
        id: 'r_seeddl',
        owner_user_id: 'test_seed_dl',
        name: 'Default seed',
        created_at: '2026-07-10T08:00:00Z',
        mode: 'dawless',
      },
    ]);
    const result = await seedRackspaceForTest({
      ownerUserId: 'test_seed_dl',
      name: 'Default seed',
    });
    expect(result.mode).toBe('dawless');
    expect(sqlTagMock.mock.calls[0].slice(1)).toContain('dawless');
  });
});
