// packages/web/src/routes/r/[id]/page-server.test.ts
//
// Regression for the 2026-07-28 incident: the Neon account exceeded its
// compute-time quota, every query returned HTTP 402, and this loader — which
// had no error handling at all — let the raw error bubble into an opaque
// HTTP 500. Every rackspace URL on every tier (INCLUDING PRODUCTION) served an
// internal-error page for ~24h, and the deploy-time live smoke
// (`/r/[id] must not 500 @smoke`) was red on every run the whole time.
//
// Two directions are asserted, and the second matters as much as the first:
//   1. DB unreachable  → 503 (degrade, retryable, friendly page)
//   2. DB answered with a SQLSTATE → still 500 (the live-smoke canary must
//      keep catching schema bugs like the migration-005 42809 read failure)
//
// Filename note: SvelteKit reserves `src/routes` basenames starting with `+`,
// so this is `page-server.test.ts`, matching dashboard/page-server.test.ts.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const getRackspaceMock = vi.fn();
const isMemberMock = vi.fn();
const getInviteCodeMock = vi.fn();
const verifyInviteCodeMock = vi.fn();

vi.mock('$lib/server/rackspaces', () => ({
  getRackspace: getRackspaceMock,
  isMember: isMemberMock,
  RACKSPACE_MAX_MEMBERS: 4,
}));

vi.mock('$lib/server/invites', () => ({
  getInviteCode: getInviteCodeMock,
  verifyInviteCode: verifyInviteCodeMock,
}));

const { load } = await import('./+page.server');

/** VERBATIM Neon HTTP driver text from the live incident. */
const NEON_402_MESSAGE =
  'Server error (HTTP status 402): {"message":"Your account or project has ' +
  'exceeded the compute time quota. Upgrade your plan to increase limits.",' +
  '"code":"","neon:retryable":true}';

const RACK = {
  id: 'r_abc123',
  name: 'Test rack',
  ownerUserId: 'user_owner',
  memberUserIds: ['user_owner'],
  createdAt: 0,
};

function makeEvent({
  userId = null as string | null,
  id = 'not-a-real-rackspace',
  search = '',
} = {}) {
  const url = new URL(`https://autotest.patchtogether.live/r/${id}${search}`);
  return {
    locals: { auth: () => ({ userId }) },
    params: { id },
    url,
    request: { headers: new Headers({ 'user-agent': 'vitest' }) },
  } as unknown as Parameters<typeof load>[0];
}

/** Resolve to the thrown value instead of rejecting, so we can inspect it.
 *  `load` returns SvelteKit's `MaybePromise<void | PageData>`, so accept a
 *  plain `unknown` return and normalise it here (svelte-check is stricter
 *  than vitest about this). */
async function thrownBy(fn: () => unknown): Promise<any> {
  return Promise.resolve()
    .then(() => fn())
    .then(
      () => null,
      (e) => e,
    );
}

describe('/r/[id] load — database unavailable degrades to 503', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    getRackspaceMock.mockReset();
    isMemberMock.mockReset();
    getInviteCodeMock.mockReset();
    verifyInviteCodeMock.mockReset();
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('THE INCIDENT: a Neon 402 on getRackspace yields 503, not 500', async () => {
    getRackspaceMock.mockRejectedValue(new Error(NEON_402_MESSAGE));

    const thrown = await thrownBy(() => load(makeEvent()));

    expect(thrown?.status, 'must degrade to 503 rather than crash with 500').toBe(503);
    expect(thrown.status).not.toBe(500);
  });

  it('the ?invite= path also yields 503 (separate code path through the loader)', async () => {
    getRackspaceMock.mockRejectedValue(new Error(NEON_402_MESSAGE));

    const thrown = await thrownBy(() =>
      load(makeEvent({ search: '?invite=0000000000000000' })),
    );

    expect(thrown?.status).toBe(503);
  });

  it('a 402 on isMember (authed path) also yields 503', async () => {
    getRackspaceMock.mockResolvedValue(RACK);
    isMemberMock.mockRejectedValue(new Error(NEON_402_MESSAGE));

    const thrown = await thrownBy(() => load(makeEvent({ userId: 'user_owner' })));

    expect(thrown?.status).toBe(503);
  });

  it('emits the greppable db-unavailable diagnostic', async () => {
    getRackspaceMock.mockRejectedValue(new Error(NEON_402_MESSAGE));
    await thrownBy(() => load(makeEvent()));

    const line = errorSpy.mock.calls.map((c) => String(c[0])).find((l) => l.includes('db-unavailable'));
    expect(line, 'a db-unavailable log line').toBeTruthy();
    expect(JSON.parse(line!).op).toBe('getRackspace');
  });
});

describe('/r/[id] load — PRESERVES THE CANARY (negative control)', () => {
  beforeEach(() => {
    getRackspaceMock.mockReset();
    isMemberMock.mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a 42809 schema error is NOT degraded — it still bubbles (→ 500)', async () => {
    // The migration-005 bug. If this ever degrades to 503, the live smoke goes
    // green and a week-long P0 ships unnoticed. See rackspaces.ts.
    const schemaErr = Object.assign(
      new Error('WITHIN GROUP is required for ordered-set aggregate mode'),
      { code: '42809' },
    );
    getRackspaceMock.mockRejectedValue(schemaErr);

    const thrown = await thrownBy(() => load(makeEvent()));

    expect(thrown, 'the original error must reach SvelteKit unchanged').toBe(schemaErr);
    expect(thrown.status, 'must NOT have been converted into an HttpError').toBeUndefined();
  });

  it('a 42703 undefined_column is NOT degraded either', async () => {
    const schemaErr = Object.assign(new Error('column "mode" does not exist'), {
      code: '42703',
    });
    getRackspaceMock.mockRejectedValue(schemaErr);

    expect(await thrownBy(() => load(makeEvent()))).toBe(schemaErr);
  });
});

describe('/r/[id] load — existing behaviour is unchanged when the DB is healthy', () => {
  beforeEach(() => {
    getRackspaceMock.mockReset();
    isMemberMock.mockReset();
    getInviteCodeMock.mockReset();
    verifyInviteCodeMock.mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('still 404s for an unknown rackspace', async () => {
    getRackspaceMock.mockResolvedValue(null);

    const thrown = await thrownBy(() => load(makeEvent()));

    expect(thrown?.status).toBe(404);
  });

  it('still redirects an unauthed visitor with no valid invite to /sign-in', async () => {
    getRackspaceMock.mockResolvedValue(RACK);
    verifyInviteCodeMock.mockResolvedValue(false);

    const thrown = await thrownBy(() => load(makeEvent()));

    // SvelteKit redirects are thrown; 303 must not have been swallowed.
    expect(thrown?.status).toBe(303);
    expect(thrown?.location).toContain('/sign-in');
  });

  it('still admits an anon visitor holding a valid invite', async () => {
    getRackspaceMock.mockResolvedValue(RACK);
    verifyInviteCodeMock.mockResolvedValue(true);

    const out: any = await load(makeEvent({ search: '?invite=good' }));

    expect(out.isAnon).toBe(true);
    expect(out.currentUserId).toBeNull();
    expect(out.rackspace.id).toBe(RACK.id);
  });

  it('still returns the invite code for an authed member', async () => {
    getRackspaceMock.mockResolvedValue(RACK);
    isMemberMock.mockResolvedValue(true);
    getInviteCodeMock.mockResolvedValue('inv_code');

    const out: any = await load(makeEvent({ userId: 'user_owner' }));

    expect(out.isMember).toBe(true);
    expect(out.currentUserId).toBe('user_owner');
    expect(out.inviteCode).toBe('inv_code');
  });
});
