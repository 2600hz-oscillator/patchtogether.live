// packages/web/src/lib/server/invites.test.ts
//
// Vitest covers HMAC invite codes: deterministic per rackspace id,
// constant length, and constant-time verify rejects bad codes.

import { describe, it, expect, vi } from 'vitest';

// $env/dynamic/private is a SvelteKit-magic alias that vitest can't resolve.
// Mock it with a known secret so the HMAC keys are deterministic across runs.
vi.mock('$env/dynamic/private', () => ({
  env: { INVITE_SECRET: 'test-secret-deterministic-fixture-32chars' },
}));

const { getInviteCode, verifyInviteCode } = await import('./invites');

describe('invites', () => {
  it('returns a deterministic 16-hex-char code per rackspace id', async () => {
    const a1 = await getInviteCode('r_abc123def');
    const a2 = await getInviteCode('r_abc123def');
    expect(a1).toBe(a2);
    expect(a1).toMatch(/^[0-9a-f]{16}$/);
  });

  it('returns different codes for different rackspaces', async () => {
    const a = await getInviteCode('r_abc123def');
    const b = await getInviteCode('r_xyz987mno');
    expect(a).not.toBe(b);
  });

  it('verifyInviteCode accepts the matching code', async () => {
    const id = 'r_test12345';
    const code = await getInviteCode(id);
    expect(await verifyInviteCode(id, code)).toBe(true);
  });

  it('verifyInviteCode rejects mismatched code', async () => {
    const code = await getInviteCode('r_aaa');
    expect(await verifyInviteCode('r_bbb', code)).toBe(false);
  });

  it('verifyInviteCode rejects empty / null / wrong-length input', async () => {
    const id = 'r_test12345';
    expect(await verifyInviteCode(id, null)).toBe(false);
    expect(await verifyInviteCode(id, undefined)).toBe(false);
    expect(await verifyInviteCode(id, '')).toBe(false);
    expect(await verifyInviteCode(id, 'too-short')).toBe(false);
    expect(await verifyInviteCode(id, 'a'.repeat(17))).toBe(false);
  });

  it('verifyInviteCode rejects bit-flipped code', async () => {
    const id = 'r_test12345';
    const code = await getInviteCode(id);
    // Flip the first hex char to its neighbor.
    const tampered = (code[0] === '0' ? '1' : '0') + code.slice(1);
    expect(await verifyInviteCode(id, tampered)).toBe(false);
  });
});

describe('invites — missing secret outside local dev', () => {
  it('throws on first getInviteCode call when INVITE_SECRET is missing and NODE_ENV is not "development"', async () => {
    // Fresh isolate: re-mock with no secret + non-dev NODE_ENV, then re-import
    // so the module's `keyPromise` memo starts empty and `getSecret()` runs.
    vi.resetModules();
    vi.doMock('$env/dynamic/private', () => ({
      env: { INVITE_SECRET: '', NODE_ENV: 'production' },
    }));
    const mod = await import('./invites');
    await expect(mod.getInviteCode('r_anything')).rejects.toThrow(/INVITE_SECRET must be set/);
    vi.doUnmock('$env/dynamic/private');
    vi.resetModules();
  });
});
