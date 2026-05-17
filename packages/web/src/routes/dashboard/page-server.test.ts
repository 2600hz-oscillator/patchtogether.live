// packages/web/src/routes/dashboard/page-server.test.ts
//
// Regression for the dashboard load fallback: a failure inside
// `listSavedGroupsForUser` (missing table, transient Neon error, …)
// must NOT take the dashboard down. Rackspaces is core — failures there
// still bubble so SvelteKit can 500.
//
// See incident: dev hard-500 on 2026-05-17 from the `saved_groups`
// table not yet existing in the dev Neon branch.
//
// Filename note: SvelteKit reserves any path under `src/routes` whose
// basename starts with `+` — naming this `+page.server.test.ts` makes
// `svelte-kit sync` throw "Files prefixed with + are reserved". The
// suffix-style name keeps vitest's default `*.test.ts` glob happy while
// staying out of SvelteKit's route discovery.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const listRackspacesForUserMock = vi.fn();
const listSavedGroupsForUserMock = vi.fn();

vi.mock('$lib/server/rackspaces', () => ({
  listRackspacesForUser: listRackspacesForUserMock,
}));

vi.mock('$lib/server/saved-groups', () => ({
  listSavedGroupsForUser: listSavedGroupsForUserMock,
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

describe('dashboard load — saved-groups fallback', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    listRackspacesForUserMock.mockReset();
    listSavedGroupsForUserMock.mockReset();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('returns savedGroups=[] when listSavedGroupsForUser throws (missing table)', async () => {
    listRackspacesForUserMock.mockResolvedValue([RACK]);
    const dbErr = Object.assign(new Error('relation "saved_groups" does not exist'), {
      code: '42P01',
    });
    listSavedGroupsForUserMock.mockRejectedValue(dbErr);

    const out = await load(makeEvent());

    expect(out).toEqual({
      rackspaces: [RACK],
      savedGroups: [],
      userId: 'user_test_1',
    });
    // Log line must include the user id, the Postgres error message,
    // and the SQLSTATE code so on-call can grep Cloudflare Workers logs.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const line = String(warnSpy.mock.calls[0][0]);
    expect(line).toMatch(/\[dashboard\] saved-groups load failed/);
    expect(line).toContain('user_test_1');
    // Postgres message is JSON-stringified into the log payload, so the
    // embedded double-quotes around `saved_groups` are escaped. Match the
    // unescaped substrings on either side instead of the raw message.
    expect(line).toContain('relation ');
    expect(line).toContain('saved_groups');
    expect(line).toContain('does not exist');
    expect(line).toContain('42P01');
  });

  it('returns savedGroups=[] for a non-Error rejection (defensive)', async () => {
    listRackspacesForUserMock.mockResolvedValue([]);
    listSavedGroupsForUserMock.mockRejectedValue('plain string boom');

    const out = (await load(makeEvent())) as { savedGroups: unknown[] };

    expect(out.savedGroups).toEqual([]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain('plain string boom');
  });

  it('passes saved groups through unchanged on success', async () => {
    listRackspacesForUserMock.mockResolvedValue([RACK]);
    const sg = {
      id: 'sg_1',
      userId: 'user_test_1',
      label: 'FILTERS',
      payload: { label: 'FILTERS', exposedPorts: [], children: [], internalEdges: [] },
      createdAt: 1,
      updatedAt: 2,
    };
    listSavedGroupsForUserMock.mockResolvedValue([sg]);

    const out = (await load(makeEvent())) as { savedGroups: unknown[] };

    expect(out.savedGroups).toEqual([sg]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('still bubbles a rackspaces failure (rackspaces is core; failing fast is correct)', async () => {
    listRackspacesForUserMock.mockRejectedValue(new Error('rackspaces table is down'));
    listSavedGroupsForUserMock.mockResolvedValue([]);

    await expect(load(makeEvent())).rejects.toThrow('rackspaces table is down');
  });

  it('redirects unauthenticated requests before touching the data layer', async () => {
    await expect(load(makeEvent({ auth: { userId: null } }))).rejects.toMatchObject({
      status: 303,
      location: '/sign-in?redirect_url=/dashboard',
    });
    expect(listRackspacesForUserMock).not.toHaveBeenCalled();
    expect(listSavedGroupsForUserMock).not.toHaveBeenCalled();
  });
});
