// packages/server/src/rack-access.test.ts
//
// Coverage for the post-auth WS access gate. Two interesting axes:
//   - role: member vs anon
//   - NODE_ENV: production vs (dev|test|undefined)
//
// The anon-prod-existence-check is the Codex-audit fix (#5): without it,
// an attacker holding a valid HMAC invite for a NONEXISTENT rack id could
// churn WS connects and balloon the Hocuspocus process memory with empty
// Yjs docs (each connect allocates a doc; the FK violation only fires on
// the first persist, which is debounced 2s). In prod we now SELECT 1 from
// `racks` and reject with 'no-such-rack' if missing. Dev/test bypass the
// check to keep Playwright @collab spec ergonomics (rack ids are ephemeral
// and never seeded in any racks table).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkRackAccess } from './rack-access.js';
import type { AuthOk } from './auth.js';

const memberAuth: AuthOk = { ok: true, userId: 'user_clerk', role: 'member' };
const anonAuth: AuthOk = { ok: true, userId: null, role: 'anon' };

function deps(opts: {
  isMember?: boolean;
  exists?: boolean;
  nodeEnv?: string | undefined;
}) {
  return {
    isRackspaceMember: vi.fn(async () => opts.isMember ?? true),
    rackspaceExists: vi.fn(async () => opts.exists ?? true),
    nodeEnv: opts.nodeEnv,
  };
}

describe('checkRackAccess — member role', () => {
  it('accepts an authenticated member', async () => {
    const d = deps({ isMember: true });
    const out = await checkRackAccess(memberAuth, 'r_abc', d);
    expect(out).toBe('ok');
    expect(d.isRackspaceMember).toHaveBeenCalledWith('r_abc', 'user_clerk');
    // Members never trigger the rackspaceExists probe.
    expect(d.rackspaceExists).not.toHaveBeenCalled();
  });

  it('rejects a non-member with not-member (regardless of env)', async () => {
    const d = deps({ isMember: false, nodeEnv: 'production' });
    expect(await checkRackAccess(memberAuth, 'r_abc', d)).toBe('not-member');
  });
});

describe('checkRackAccess — anon role (the Codex #5 fix)', () => {
  it('PROD + existing rack: accept', async () => {
    const d = deps({ exists: true, nodeEnv: 'production' });
    expect(await checkRackAccess(anonAuth, 'r_real', d)).toBe('ok');
    expect(d.rackspaceExists).toHaveBeenCalledWith('r_real');
    expect(d.isRackspaceMember).not.toHaveBeenCalled();
  });

  it('PROD + nonexistent rack: reject with no-such-rack (memory-leak prevention)', async () => {
    const d = deps({ exists: false, nodeEnv: 'production' });
    expect(await checkRackAccess(anonAuth, 'r_bogus', d)).toBe('no-such-rack');
    expect(d.rackspaceExists).toHaveBeenCalledWith('r_bogus');
  });

  it('DEV + nonexistent rack: accept (test ergonomics bypass)', async () => {
    const d = deps({ exists: false, nodeEnv: 'development' });
    expect(await checkRackAccess(anonAuth, 'r_ephemeral', d)).toBe('ok');
    // Probe MUST NOT be called in dev — that's the whole point of the bypass.
    expect(d.rackspaceExists).not.toHaveBeenCalled();
  });

  it('TEST + nonexistent rack: accept (test ergonomics bypass)', async () => {
    const d = deps({ exists: false, nodeEnv: 'test' });
    expect(await checkRackAccess(anonAuth, 'r_ephemeral', d)).toBe('ok');
    expect(d.rackspaceExists).not.toHaveBeenCalled();
  });

  it('UNDEFINED NODE_ENV + nonexistent rack: accept (treated as dev)', async () => {
    const d = deps({ exists: false, nodeEnv: undefined });
    expect(await checkRackAccess(anonAuth, 'r_ephemeral', d)).toBe('ok');
    expect(d.rackspaceExists).not.toHaveBeenCalled();
  });
});

describe('checkRackAccess — process.env.NODE_ENV fallback', () => {
  // When deps.nodeEnv is not passed, the implementation should read
  // process.env.NODE_ENV. The two surrounding tests pin/restore the value
  // so they don't leak.
  const original = process.env.NODE_ENV;
  beforeEach(() => {
    process.env.NODE_ENV = original;
  });

  it('uses process.env.NODE_ENV=production when deps.nodeEnv is undefined', async () => {
    process.env.NODE_ENV = 'production';
    const d = {
      isRackspaceMember: vi.fn(async () => true),
      rackspaceExists: vi.fn(async () => false),
      // nodeEnv intentionally omitted
    };
    expect(await checkRackAccess(anonAuth, 'r_bogus', d)).toBe('no-such-rack');
    expect(d.rackspaceExists).toHaveBeenCalledTimes(1);
  });

  it('uses process.env.NODE_ENV=development when deps.nodeEnv is undefined', async () => {
    process.env.NODE_ENV = 'development';
    const d = {
      isRackspaceMember: vi.fn(async () => true),
      rackspaceExists: vi.fn(async () => false),
    };
    expect(await checkRackAccess(anonAuth, 'r_ephemeral', d)).toBe('ok');
    expect(d.rackspaceExists).not.toHaveBeenCalled();
  });
});
