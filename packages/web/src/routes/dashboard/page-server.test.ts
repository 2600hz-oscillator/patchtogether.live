// packages/web/src/routes/dashboard/page-server.test.ts
//
// The dashboard's server load: rackspaces is CORE, so a failure there still
// bubbles and SvelteKit 500s, and an unauthenticated request redirects before
// anything touches the data layer.
//
// ⚠ THIS FILE'S ORIGINAL SUBJECT IS GONE, AND THE COVERAGE LOSS IS REAL. Three
// cases covered the SAVED-GROUPS FALLBACK: `listSavedGroupsForUser` throwing
// (missing table / transient Neon error) had to degrade to an empty library
// rather than take the page down, with a greppable single-line warn carrying the
// user id, the Postgres message and the SQLSTATE. It existed for an incident —
// dev hard-500 on 2026-05-17, `saved_groups` not yet existing in the dev Neon
// branch. The GROUP! module is deleted and with it the library, the
// `/api/saved-groups` routes and that second query, so the load has ONE call
// again and there is no secondary surface left to degrade. The lesson belongs to
// whatever the next secondary surface is; it is recorded here and in
// `+page.server.ts` rather than kept alive against a query that no longer runs.
//
// Filename note: SvelteKit reserves any path under `src/routes` whose
// basename starts with `+` — naming this `+page.server.test.ts` makes
// `svelte-kit sync` throw "Files prefixed with + are reserved". The
// suffix-style name keeps vitest's default `*.test.ts` glob happy while
// staying out of SvelteKit's route discovery.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const listRackspacesForUserMock = vi.fn();

vi.mock('$lib/server/rackspaces', () => ({
  listRackspacesForUser: listRackspacesForUserMock,
}));

const { load } = await import('./+page.server');

interface FakeAuth {
  userId: string | null;
}

function makeEvent({ auth = { userId: 'user_test_1' } }: { auth?: FakeAuth } = {}) {
  return {
    locals: { auth: () => auth },
  } as unknown as Parameters<typeof load>[0];
}

const RACK = {
  id: 'r_abc',
  name: 'Untitled',
  ownerUserId: 'user_test_1',
  memberUserIds: ['user_test_1'],
};

describe('dashboard load', () => {
  beforeEach(() => {
    listRackspacesForUserMock.mockReset();
  });

  it('returns the rackspace list + the user id on success', async () => {
    listRackspacesForUserMock.mockResolvedValue([RACK]);
    expect(await load(makeEvent())).toEqual({ rackspaces: [RACK], userId: 'user_test_1' });
  });

  it('still bubbles a rackspaces failure (rackspaces is core; failing fast is correct)', async () => {
    listRackspacesForUserMock.mockRejectedValue(new Error('rackspaces table is down'));

    await expect(load(makeEvent())).rejects.toThrow('rackspaces table is down');
  });

  it('redirects unauthenticated requests before touching the data layer', async () => {
    await expect(load(makeEvent({ auth: { userId: null } }))).rejects.toMatchObject({
      status: 303,
      location: '/sign-in?redirect_url=/dashboard',
    });
    expect(listRackspacesForUserMock).not.toHaveBeenCalled();
  });
});
