// packages/web/src/lib/server/home-auth.test.ts
//
// Covers the server-side auth read that feeds the `/` header when the
// client <ClerkProvider> is NOT mounted (SAB / cross-origin isolation
// constraint). The behavior we lock in:
//   - valid session cookie  -> isSignedIn:true (+ avatar/initials)
//   - no cookie             -> signed out ("Sign in")
//   - bad/expired cookie    -> signed out (verifyToken throws)
//   - getUser failure       -> still signed in, just no avatar/name
//   - Clerk not configured  -> signed out, no token work attempted

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Cookies } from '@sveltejs/kit';

// SvelteKit-magic env aliases vitest can't resolve. Default = Clerk configured.
const privateEnv = { CLERK_SECRET_KEY: 'sk_test_fixture' };
const publicEnv = { PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_test_fixture' };
vi.mock('$env/dynamic/private', () => ({ env: privateEnv }));
vi.mock('$env/dynamic/public', () => ({ env: publicEnv }));

const verifyToken = vi.fn();
vi.mock('@clerk/backend', () => ({ verifyToken: (...a: unknown[]) => verifyToken(...a) }));

const getUser = vi.fn();
vi.mock('svelte-clerk/server', () => ({
  clerkClient: { users: { getUser: (...a: unknown[]) => getUser(...a) } },
}));

const { readHomeAuth } = await import('./home-auth');

/** Minimal Cookies stub: only `.get` is used by readHomeAuth. */
function cookiesWith(map: Record<string, string>): Cookies {
  return { get: (name: string) => map[name] } as unknown as Cookies;
}

describe('readHomeAuth', () => {
  beforeEach(() => {
    verifyToken.mockReset();
    getUser.mockReset();
    privateEnv.CLERK_SECRET_KEY = 'sk_test_fixture';
    publicEnv.PUBLIC_CLERK_PUBLISHABLE_KEY = 'pk_test_fixture';
  });

  it('signed-in cookie -> isSignedIn:true with avatar + initials', async () => {
    verifyToken.mockResolvedValue({ sub: 'user_123' });
    getUser.mockResolvedValue({
      hasImage: true,
      imageUrl: 'https://img.clerk/avatar.png',
      firstName: 'Ada',
      lastName: 'Lovelace',
    });

    const state = await readHomeAuth(cookiesWith({ __session: 'valid.jwt.token' }));

    expect(state.isSignedIn).toBe(true);
    expect(state.userId).toBe('user_123');
    expect(state.imageUrl).toBe('https://img.clerk/avatar.png');
    expect(state.initials).toBe('AL');
    expect(verifyToken).toHaveBeenCalledWith('valid.jwt.token', {
      secretKey: 'sk_test_fixture',
    });
  });

  it('no session cookie -> signed out, never touches Clerk', async () => {
    const state = await readHomeAuth(cookiesWith({}));

    expect(state).toEqual({ isSignedIn: false, userId: null, imageUrl: null, initials: null });
    expect(verifyToken).not.toHaveBeenCalled();
    expect(getUser).not.toHaveBeenCalled();
  });

  it('invalid/expired cookie (verifyToken throws) -> signed out', async () => {
    verifyToken.mockRejectedValue(new Error('token expired'));

    const state = await readHomeAuth(cookiesWith({ __session: 'expired.jwt' }));

    expect(state.isSignedIn).toBe(false);
    expect(state.userId).toBeNull();
    expect(getUser).not.toHaveBeenCalled();
  });

  it('valid session but missing sub -> signed out', async () => {
    verifyToken.mockResolvedValue({});
    const state = await readHomeAuth(cookiesWith({ __session: 'x' }));
    expect(state.isSignedIn).toBe(false);
  });

  it('valid session, getUser failure -> still signed in without avatar/name', async () => {
    verifyToken.mockResolvedValue({ sub: 'user_456' });
    getUser.mockRejectedValue(new Error('clerk api 500'));

    const state = await readHomeAuth(cookiesWith({ __session: 'valid' }));

    expect(state.isSignedIn).toBe(true);
    expect(state.userId).toBe('user_456');
    expect(state.imageUrl).toBeNull();
    expect(state.initials).toBeNull();
  });

  it('user without an image -> signed in, imageUrl null, initials still derived', async () => {
    verifyToken.mockResolvedValue({ sub: 'user_789' });
    getUser.mockResolvedValue({
      hasImage: false,
      imageUrl: 'https://img.clerk/default.png',
      firstName: 'Grace',
      lastName: null,
    });

    const state = await readHomeAuth(cookiesWith({ __session: 'valid' }));

    expect(state.isSignedIn).toBe(true);
    expect(state.imageUrl).toBeNull();
    expect(state.initials).toBe('G');
  });

  it('Clerk not configured -> signed out, no token verification attempted', async () => {
    privateEnv.CLERK_SECRET_KEY = '';
    const state = await readHomeAuth(cookiesWith({ __session: 'valid' }));
    expect(state.isSignedIn).toBe(false);
    expect(verifyToken).not.toHaveBeenCalled();
  });
});
