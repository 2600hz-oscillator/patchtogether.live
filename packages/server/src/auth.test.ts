// packages/server/src/auth.test.ts
//
// Unit coverage for token verification. Clerk's verifyToken is mocked —
// we want to exercise our own dispatch + HMAC code, not the network
// call to Clerk's JWKS endpoint.

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

beforeAll(() => {
  // Pin the secret so the HMAC keys are deterministic across test runs.
  process.env.INVITE_SECRET = 'test-secret-deterministic-fixture-32chars';
  process.env.CLERK_SECRET_KEY = 'sk_test_fixture';
});

vi.mock('@clerk/backend', () => ({
  verifyToken: vi.fn(),
}));

const { verifyToken: clerkVerifyToken } = await import('@clerk/backend');
const clerkVerifyMock = vi.mocked(clerkVerifyToken);
const { verifyToken } = await import('./auth.js');

beforeEach(() => {
  clerkVerifyMock.mockReset();
});

describe('verifyToken', () => {
  it('rejects empty/missing tokens with invalid-format', async () => {
    expect(await verifyToken('', 'r_doc')).toEqual({ ok: false, reason: 'invalid-format' });
    // @ts-expect-error testing runtime guard against non-string
    expect(await verifyToken(null, 'r_doc')).toEqual({ ok: false, reason: 'invalid-format' });
  });

  it('rejects unknown prefixes with invalid-format', async () => {
    expect(await verifyToken('stub:abc', 'r_doc')).toEqual({ ok: false, reason: 'invalid-format' });
    expect(await verifyToken('something-else', 'r_doc')).toEqual({ ok: false, reason: 'invalid-format' });
  });

  describe('anon: tokens', () => {
    it('rejects code shorter or longer than 16 hex chars', async () => {
      expect(await verifyToken('anon:short', 'r_doc')).toEqual({ ok: false, reason: 'unauthorized' });
      expect(await verifyToken('anon:' + 'a'.repeat(17), 'r_doc')).toEqual({
        ok: false,
        reason: 'unauthorized',
      });
    });

    it('rejects bit-flipped code', async () => {
      // Compute a code via the live HMAC so we know what valid looks like.
      const docName = 'r_test12345';
      const valid = await getValidInviteCode(docName);
      const tampered = (valid[0] === '0' ? '1' : '0') + valid.slice(1);
      expect(await verifyToken(`anon:${tampered}`, docName)).toEqual({
        ok: false,
        reason: 'unauthorized',
      });
    });

    it('accepts a code that matches HMAC(secret, docName)', async () => {
      const docName = 'r_test12345';
      const code = await getValidInviteCode(docName);
      expect(await verifyToken(`anon:${code}`, docName)).toEqual({
        ok: true,
        userId: null,
        role: 'anon',
      });
    });

    it('rejects a code valid for a different doc', async () => {
      const code = await getValidInviteCode('r_aaa');
      expect(await verifyToken(`anon:${code}`, 'r_bbb')).toEqual({
        ok: false,
        reason: 'unauthorized',
      });
    });
  });

  describe('clerk: tokens', () => {
    it('returns userId from JWT sub on successful verify', async () => {
      clerkVerifyMock.mockResolvedValueOnce({ sub: 'user_abc123' } as never);
      expect(await verifyToken('clerk:fake.jwt.payload', 'r_doc')).toEqual({
        ok: true,
        userId: 'user_abc123',
        role: 'member',
      });
      expect(clerkVerifyMock).toHaveBeenCalledWith('fake.jwt.payload', {
        secretKey: 'sk_test_fixture',
      });
    });

    it('rejects when verifyToken throws (invalid/expired JWT)', async () => {
      clerkVerifyMock.mockRejectedValueOnce(new Error('expired'));
      expect(await verifyToken('clerk:expired.jwt', 'r_doc')).toEqual({
        ok: false,
        reason: 'unauthorized',
      });
    });

    it('rejects when JWT payload has no string sub', async () => {
      clerkVerifyMock.mockResolvedValueOnce({} as never);
      expect(await verifyToken('clerk:no.sub', 'r_doc')).toEqual({
        ok: false,
        reason: 'unauthorized',
      });
    });
  });
});

// HMAC helper that mirrors auth.ts's invite derivation. Used to generate
// the "right" code in test fixtures so we don't depend on the live web
// package's invites.ts (separate workspace).
async function getValidInviteCode(docName: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(process.env.INVITE_SECRET!),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(docName));
  let hex = '';
  for (const b of new Uint8Array(sig)) hex += b.toString(16).padStart(2, '0');
  return hex.slice(0, 16);
}
