// packages/web/src/routes/api/test/seed-rackspace/server.test.ts
//
// Route-level tests for POST /api/test/seed-rackspace. The endpoint MUST
// be 404 in any environment where neither RACKSPACE_SEED_ENABLED='1' nor
// NODE_ENV='development' is set — the rest of the contract (envelope
// decoding, response shape) only matters when the gate is open.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// SvelteKit's $env/dynamic/private is module-scoped; we re-import the route
// fresh each test so changes to the mocked env take effect.
const envMock: { RACKSPACE_SEED_ENABLED?: string; NODE_ENV?: string } = {};
const seedRackspaceForTestMock = vi.fn();
const getInviteCodeMock = vi.fn();

vi.mock('$env/dynamic/private', () => ({
  env: envMock,
}));
vi.mock('$lib/server/rackspaces', () => ({
  seedRackspaceForTest: seedRackspaceForTestMock,
}));
vi.mock('$lib/server/invites', () => ({
  getInviteCode: getInviteCodeMock,
}));

const { POST } = await import('./+server');

function makeEvent(body: unknown) {
  return {
    request: {
      json: async () => {
        if (body === undefined) throw new Error('no body');
        return body;
      },
    },
  } as unknown as Parameters<typeof POST>[0];
}

async function runPost(event: Parameters<typeof POST>[0]) {
  try {
    const res = await POST(event);
    return { ok: true as const, status: res.status, body: await res.json() };
  } catch (e) {
    const err = e as { status?: number; body?: { message?: string } };
    return { ok: false as const, status: err.status ?? 500, message: err.body?.message };
  }
}

describe('POST /api/test/seed-rackspace', () => {
  beforeEach(() => {
    seedRackspaceForTestMock.mockReset();
    getInviteCodeMock.mockReset();
    delete envMock.RACKSPACE_SEED_ENABLED;
    delete envMock.NODE_ENV;
  });

  it('404 when neither RACKSPACE_SEED_ENABLED nor NODE_ENV=development is set', async () => {
    // Prod shape — both env vars absent / wrong value.
    envMock.NODE_ENV = 'production';
    const r = await runPost(makeEvent({}));
    expect(r.status).toBe(404);
    expect(seedRackspaceForTestMock).not.toHaveBeenCalled();
  });

  it('200 when RACKSPACE_SEED_ENABLED="1"', async () => {
    envMock.RACKSPACE_SEED_ENABLED = '1';
    seedRackspaceForTestMock.mockResolvedValue({
      id: 'r_seed1',
      ownerUserId: 'test_seed_a',
      name: 'x',
      createdAt: 0,
      memberUserIds: ['test_seed_a'],
    });
    getInviteCodeMock.mockResolvedValue('abcd1234efgh5678');
    const r = await runPost(makeEvent({ name: 'mytest' }));
    expect(r.status).toBe(200);
    expect(r.ok && r.body).toMatchObject({ id: 'r_seed1', inviteCode: 'abcd1234efgh5678' });
    expect(seedRackspaceForTestMock).toHaveBeenCalledTimes(1);
    const call = seedRackspaceForTestMock.mock.calls[0][0];
    expect(call.name).toBe('mytest');
    expect(call.ownerUserId).toMatch(/^test_seed_/);
    expect(call.snapshot).toBeNull();
  });

  it('200 when NODE_ENV="development" even without RACKSPACE_SEED_ENABLED', async () => {
    envMock.NODE_ENV = 'development';
    seedRackspaceForTestMock.mockResolvedValue({
      id: 'r_seed2',
      ownerUserId: 'test_seed_b',
      name: 'Test rackspace 0',
      createdAt: 0,
      memberUserIds: ['test_seed_b'],
    });
    getInviteCodeMock.mockResolvedValue('1111222233334444');
    const r = await runPost(makeEvent({}));
    expect(r.status).toBe(200);
    expect(r.ok && r.body).toMatchObject({ id: 'r_seed2', inviteCode: '1111222233334444' });
  });

  it('decodes envelope.update from base64 and passes Uint8Array to seeder', async () => {
    envMock.RACKSPACE_SEED_ENABLED = '1';
    seedRackspaceForTestMock.mockResolvedValue({
      id: 'r_seed3',
      ownerUserId: 'test_seed_c',
      name: 'with envelope',
      createdAt: 0,
      memberUserIds: ['test_seed_c'],
    });
    getInviteCodeMock.mockResolvedValue('aaaabbbbccccdddd');
    // btoa('hi!') == 'aGkh' → bytes [104, 105, 33]
    const envelope = { envelopeVersion: 1, update: 'aGkh' };
    const r = await runPost(makeEvent({ envelope }));
    expect(r.status).toBe(200);
    const call = seedRackspaceForTestMock.mock.calls[0][0];
    expect(call.snapshot).toBeInstanceOf(Uint8Array);
    expect(Array.from(call.snapshot as Uint8Array)).toEqual([104, 105, 33]);
  });

  it('400 when envelope.update is not a string', async () => {
    envMock.RACKSPACE_SEED_ENABLED = '1';
    const r = await runPost(makeEvent({ envelope: { envelopeVersion: 1, update: 42 } }));
    expect(r.status).toBe(400);
    expect(seedRackspaceForTestMock).not.toHaveBeenCalled();
  });

  it('accepts an empty body (uses defaults)', async () => {
    envMock.RACKSPACE_SEED_ENABLED = '1';
    seedRackspaceForTestMock.mockResolvedValue({
      id: 'r_seed4',
      ownerUserId: 'test_seed_d',
      name: 'default',
      createdAt: 0,
      memberUserIds: ['test_seed_d'],
    });
    getInviteCodeMock.mockResolvedValue('eeeeffff00001111');
    // makeEvent(undefined) → request.json throws (matches SvelteKit on empty
    // body); the route should swallow that and proceed with defaults.
    const r = await runPost(makeEvent(undefined));
    expect(r.status).toBe(200);
    const call = seedRackspaceForTestMock.mock.calls[0][0];
    expect(call.ownerUserId).toMatch(/^test_seed_/);
    expect(call.name).toMatch(/^Test rackspace /);
  });
});
