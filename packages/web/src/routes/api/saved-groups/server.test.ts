// packages/web/src/routes/api/saved-groups/server.test.ts
//
// Route-level validation tests for POST + GET /api/saved-groups. Mocks
// the data layer so the test focuses on auth + body-shape validation
// without touching Postgres.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const saveGroupMock = vi.fn();
const listSavedGroupsForUserMock = vi.fn();

vi.mock('$lib/server/saved-groups', () => ({
  SAVED_GROUP_LABEL_MAX: 64,
  SAVED_GROUP_MAX_PAYLOAD_BYTES: 256 * 1024,
  SAVED_GROUP_MAX_PER_USER: 100,
  saveGroup: saveGroupMock,
  listSavedGroupsForUser: listSavedGroupsForUserMock,
}));

const { POST, GET } = await import('./+server');

interface FakeAuth {
  userId: string | null;
}

const validPayload = {
  label: 'MY FILTER STACK',
  exposedPorts: [],
  children: [
    { id: 'lfo-1', type: 'lfo', domain: 'audio', position: { x: 0, y: 0 }, params: {} },
  ],
  internalEdges: [],
};

function makePostEvent({
  body,
  auth = { userId: 'user_test_1' },
}: {
  body: unknown;
  auth?: FakeAuth;
}) {
  return {
    locals: { auth: () => auth },
    request: { json: async () => body },
  } as unknown as Parameters<typeof POST>[0];
}

function makeGetEvent({ auth = { userId: 'user_test_1' } }: { auth?: FakeAuth } = {}) {
  return {
    locals: { auth: () => auth },
  } as unknown as Parameters<typeof GET>[0];
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

async function runGet(event: Parameters<typeof GET>[0]) {
  try {
    const res = await GET(event);
    return { ok: true as const, status: res.status, body: await res.json() };
  } catch (e) {
    const err = e as { status?: number; body?: { message?: string } };
    return { ok: false as const, status: err.status ?? 500, message: err.body?.message };
  }
}

describe('POST /api/saved-groups validation', () => {
  beforeEach(() => {
    saveGroupMock.mockReset();
    saveGroupMock.mockResolvedValue({
      status: 'ok',
      savedGroup: {
        id: 'sg_xyz',
        userId: 'user_test_1',
        label: 'MY FILTER STACK',
        payload: validPayload,
        createdAt: 1,
        updatedAt: 1,
      },
    });
  });

  it('401 when not authenticated', async () => {
    const r = await runPost(
      makePostEvent({ body: { label: 'x', payload: validPayload }, auth: { userId: null } }),
    );
    expect(r.status).toBe(401);
    expect(saveGroupMock).not.toHaveBeenCalled();
  });

  it('400 when label missing', async () => {
    const r = await runPost(makePostEvent({ body: { payload: validPayload } }));
    expect(r.status).toBe(400);
    expect(r.message).toMatch(/label/i);
  });

  it('400 when label is empty after trim', async () => {
    const r = await runPost(makePostEvent({ body: { label: '   ', payload: validPayload } }));
    expect(r.status).toBe(400);
    expect(r.message).toMatch(/label/i);
  });

  it('400 when label exceeds 64 chars', async () => {
    const r = await runPost(
      makePostEvent({ body: { label: 'x'.repeat(65), payload: validPayload } }),
    );
    expect(r.status).toBe(400);
    expect(r.message).toMatch(/64/);
  });

  it('400 when payload missing', async () => {
    const r = await runPost(makePostEvent({ body: { label: 'ok' } }));
    expect(r.status).toBe(400);
    expect(r.message).toMatch(/payload/);
  });

  it('400 when payload.children is not an array', async () => {
    const r = await runPost(
      makePostEvent({
        body: { label: 'ok', payload: { ...validPayload, children: 'bogus' } },
      }),
    );
    expect(r.status).toBe(400);
    expect(r.message).toMatch(/children/);
  });

  it('400 when a child lacks id/type/domain', async () => {
    const r = await runPost(
      makePostEvent({
        body: {
          label: 'ok',
          payload: { ...validPayload, children: [{ id: 'x' }] },
        },
      }),
    );
    expect(r.status).toBe(400);
    expect(r.message).toMatch(/child/i);
  });

  it('413 when payload exceeds 256 KB', async () => {
    const heavyChildren = Array.from({ length: 5000 }, (_, i) => ({
      id: `n-${i}`,
      type: 'lfo',
      domain: 'audio',
      position: { x: 0, y: 0 },
      params: { freq: 220, amp: 1 },
      data: { blob: 'x'.repeat(60) },
    }));
    const r = await runPost(
      makePostEvent({
        body: { label: 'big', payload: { ...validPayload, children: heavyChildren } },
      }),
    );
    expect(r.status).toBe(413);
  });

  it('409 when the per-user cap is reached', async () => {
    saveGroupMock.mockResolvedValueOnce({ status: 'cap-reached', count: 100 });
    const r = await runPost(makePostEvent({ body: { label: 'ok', payload: validPayload } }));
    expect(r.status).toBe(409);
    expect(r.message).toMatch(/cap/);
  });

  it('200 + returns the saved group on success', async () => {
    const r = await runPost(makePostEvent({ body: { label: 'ok', payload: validPayload } }));
    expect(r.status).toBe(200);
    expect(saveGroupMock).toHaveBeenCalledWith(
      'user_test_1',
      'ok',
      expect.objectContaining({ label: 'MY FILTER STACK' }),
    );
    expect(r.ok && r.body).toMatchObject({ savedGroup: { id: 'sg_xyz' } });
  });

  it('trims the label before persisting', async () => {
    await runPost(makePostEvent({ body: { label: '  trimmed  ', payload: validPayload } }));
    expect(saveGroupMock).toHaveBeenCalledWith('user_test_1', 'trimmed', expect.anything());
  });
});

describe('GET /api/saved-groups', () => {
  beforeEach(() => {
    listSavedGroupsForUserMock.mockReset();
    listSavedGroupsForUserMock.mockResolvedValue([
      {
        id: 'sg_1',
        userId: 'user_test_1',
        label: 'A',
        payload: validPayload,
        createdAt: 1,
        updatedAt: 1,
      },
    ]);
  });

  it('401 when not authenticated', async () => {
    const r = await runGet(makeGetEvent({ auth: { userId: null } }));
    expect(r.status).toBe(401);
    expect(listSavedGroupsForUserMock).not.toHaveBeenCalled();
  });

  it('200 + returns the user library', async () => {
    const r = await runGet(makeGetEvent({}));
    expect(r.status).toBe(200);
    expect(listSavedGroupsForUserMock).toHaveBeenCalledWith('user_test_1');
    expect(r.ok && (r.body as { savedGroups: unknown[] }).savedGroups).toHaveLength(1);
  });
});
