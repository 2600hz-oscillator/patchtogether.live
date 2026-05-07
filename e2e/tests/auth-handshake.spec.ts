// e2e/tests/auth-handshake.spec.ts
//
// @auth tests: Hocuspocus WS handshake validates the auth token (Stage B
// PR-D). Two valid token forms — `anon:<HMAC>` and `clerk:<JWT>` — and
// the server rejects everything else.
//
// These tests exercise the rejection paths (bad token shapes, mismatched
// invites). The happy path for `anon:` is already exercised by every
// @collab + @capacity test, since __attachProvider derives a valid anon
// token by default. A credentialed `clerk:` happy-path test would need
// real Clerk fixtures and is out of scope until we provision a Clerk
// test instance.
//
// Run only @auth:  flox activate -- task e2e -- --grep @auth

import { test, expect } from '@playwright/test';

async function attempt(
  page: import('@playwright/test').Page,
  rackspaceId: string,
  token: string,
): Promise<{ ok: boolean; reason?: string }> {
  return await page.evaluate(
    async ({ id, t }) => {
      const w = window as unknown as {
        __attachProvider: (id: string, token?: string) => Promise<unknown>;
      };
      try {
        await w.__attachProvider(id, t);
        return { ok: true };
      } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message : String(e) };
      }
    },
    { id: rackspaceId, t: token },
  );
}

test.describe('@auth', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.waitForFunction(
      () =>
        typeof (window as unknown as { __attachProvider?: unknown }).__attachProvider ===
        'function',
    );
  });

  test('rejects an empty token with invalid-format', async ({ page }) => {
    const r = await attempt(page, `auth-${Date.now()}-empty`, '');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('invalid-format');
  });

  test('rejects an unrecognized prefix with invalid-format', async ({ page }) => {
    const r = await attempt(page, `auth-${Date.now()}-prefix`, 'stub:whatever');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('invalid-format');
  });

  test('rejects an anon: token whose HMAC does not match the doc name', async ({ page }) => {
    // 16 hex chars but not the right ones for this doc.
    const r = await attempt(page, `auth-${Date.now()}-badhmac`, 'anon:0000000000000000');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('unauthorized');
  });

  test('rejects an anon: token of the wrong length', async ({ page }) => {
    const r = await attempt(page, `auth-${Date.now()}-shortcode`, 'anon:short');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('unauthorized');
  });

  test('rejects a clerk: token with a malformed JWT', async ({ page }) => {
    // No CLERK_SECRET_KEY in the test env → server returns null userId
    // → unauthorized. Either way (bad JWT or missing secret), the wire
    // result is the same rejection code.
    const r = await attempt(page, `auth-${Date.now()}-badjwt`, 'clerk:not.a.real.jwt');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('unauthorized');
  });

  test('accepts a derived anon: token (default __attachProvider behavior)', async ({ page }) => {
    // No explicit token → __attachProvider derives a valid anon HMAC.
    // This is the happy path that every @collab/@capacity test relies on.
    const r = await attempt(page, `auth-${Date.now()}-happy`, undefined as unknown as string);
    expect(r.ok, `attach: ${r.reason ?? 'ok'}`).toBe(true);
  });
});
