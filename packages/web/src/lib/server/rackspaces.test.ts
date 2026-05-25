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

const { leaveRackspace } = await import('./rackspaces');

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
