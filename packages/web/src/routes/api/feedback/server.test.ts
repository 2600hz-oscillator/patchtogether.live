// packages/web/src/routes/api/feedback/server.test.ts
//
// Route-level validation tests for POST /api/feedback. We mock the server
// data layer so the test focuses on input shape (auth, kind enum, length,
// patch_json size cap) without touching Postgres.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const recordFeedbackMock = vi.fn();

vi.mock('$lib/server/feedback', () => ({
  FEEDBACK_MAX_LENGTH: 512,
  recordFeedback: recordFeedbackMock,
}));

const { POST } = await import('./+server');

interface FakeAuth {
  userId: string | null;
}

function makeEvent({
  body,
  auth = { userId: 'user_test_1' },
}: {
  body: unknown;
  auth?: FakeAuth;
}) {
  return {
    locals: { auth: () => auth },
    request: {
      json: async () => body,
    },
  } as unknown as Parameters<typeof POST>[0];
}

async function runPost(event: Parameters<typeof POST>[0]) {
  // SvelteKit's `error()` throws a HttpError; capture status to assert on.
  try {
    const res = await POST(event);
    return { ok: true as const, status: res.status, body: await res.json() };
  } catch (e) {
    const err = e as { status?: number; body?: { message?: string } };
    return { ok: false as const, status: err.status ?? 500, message: err.body?.message };
  }
}

describe('POST /api/feedback validation', () => {
  beforeEach(() => {
    recordFeedbackMock.mockReset();
    recordFeedbackMock.mockResolvedValue({ id: 42 });
  });

  it('401 when not authenticated', async () => {
    const r = await runPost(makeEvent({
      body: { kind: 'bug', message: 'crash' },
      auth: { userId: null },
    }));
    expect(r.status).toBe(401);
    expect(recordFeedbackMock).not.toHaveBeenCalled();
  });

  it('400 when kind missing', async () => {
    const r = await runPost(makeEvent({ body: { message: 'help' } }));
    expect(r.status).toBe(400);
    expect(r.message).toMatch(/kind/i);
    expect(recordFeedbackMock).not.toHaveBeenCalled();
  });

  it('400 when kind not in enum', async () => {
    const r = await runPost(makeEvent({ body: { kind: 'feature', message: 'hi' } }));
    expect(r.status).toBe(400);
    expect(r.message).toMatch(/kind/i);
  });

  it('400 when message missing', async () => {
    const r = await runPost(makeEvent({ body: { kind: 'bug' } }));
    expect(r.status).toBe(400);
    expect(r.message).toMatch(/message/i);
  });

  it('400 when message empty after trim', async () => {
    const r = await runPost(makeEvent({ body: { kind: 'bug', message: '   \n' } }));
    expect(r.status).toBe(400);
    expect(r.message).toMatch(/message/i);
  });

  it('400 when message exceeds 512 characters', async () => {
    const r = await runPost(makeEvent({
      body: { kind: 'suggestion', message: 'x'.repeat(513) },
    }));
    expect(r.status).toBe(400);
    expect(r.message).toMatch(/512/);
  });

  it('413 when patchJson exceeds 64 KB', async () => {
    // Build an object whose JSON.stringify length crosses the 64KB cap.
    const big = { blob: 'x'.repeat(70 * 1024) };
    const r = await runPost(makeEvent({
      body: { kind: 'bug', message: 'with patch', patchJson: big },
    }));
    expect(r.status).toBe(413);
  });

  it('400 when rackId is not a string', async () => {
    const r = await runPost(makeEvent({
      body: { kind: 'bug', message: 'help', rackId: 12345 },
    }));
    expect(r.status).toBe(400);
    expect(r.message).toMatch(/rackId/);
  });

  it('200 + returns id on minimal valid bug submission', async () => {
    const r = await runPost(makeEvent({ body: { kind: 'bug', message: 'crashed on click' } }));
    expect(r.status).toBe(200);
    expect(recordFeedbackMock).toHaveBeenCalledWith(
      'user_test_1',
      null,
      'bug',
      'crashed on click',
      null,
    );
    expect(r.ok && r.body).toEqual({ id: 42 });
  });

  it('200 + accepts suggestion with rackId + patchJson', async () => {
    const patch = { envelopeVersion: 1, savedAt: 't', moduleSchemas: {}, update: 'AAAA' };
    const r = await runPost(makeEvent({
      body: { kind: 'suggestion', message: 'add reverb tails', rackId: 'r_abc123', patchJson: patch },
    }));
    expect(r.status).toBe(200);
    expect(recordFeedbackMock).toHaveBeenCalledWith(
      'user_test_1',
      'r_abc123',
      'suggestion',
      'add reverb tails',
      patch,
    );
  });

  it('trims message before recording', async () => {
    await runPost(makeEvent({ body: { kind: 'bug', message: '  whitespace  ' } }));
    expect(recordFeedbackMock).toHaveBeenCalledWith(
      'user_test_1',
      null,
      'bug',
      'whitespace',
      null,
    );
  });
});
