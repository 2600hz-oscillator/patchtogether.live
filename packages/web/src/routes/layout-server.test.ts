// packages/web/src/routes/layout-server.test.ts
//
// Bug B regression: a logged-in user used to see "Sign in" on the landing
// page `/`. The root +layout.server.ts now surfaces an `isAuthed` boolean to
// the client WITHOUT mounting ClerkProvider on `/` (which would break the
// SharedArrayBuffer / cross-origin-isolation headers the audio engine needs).
//
// hooks.server.ts deliberately does NOT run Clerk's middleware on `/` (to
// avoid hammering Clerk's rate limit on anonymous landing hits), so
// `locals.auth().userId` is null there. The load therefore ALSO checks the
// `__session` cookie's JWT `exp` locally (no Clerk API round-trip, no
// signature verify — cosmetic affordance only).
//
// Filename note: a `+layout.server.test.ts` basename is reserved by
// SvelteKit's route discovery ("Files prefixed with + are reserved"), so we
// use the suffix-style name; vitest's `*.test.ts` glob still picks it up.

import { describe, it, expect, vi } from 'vitest';

// buildClerkProps reaches into Clerk internals; stub it to a stable shape so
// we can assert our own `isAuthed` field without pulling in the SDK.
vi.mock('svelte-clerk/server', () => ({
  buildClerkProps: (auth: { userId: string | null }) => ({ __clerk: { userId: auth.userId } }),
}));

const { load, sessionCookieLooksAuthed } = await import('./+layout.server');

interface FakeAuth {
  userId: string | null;
}

function makeEvent({
  auth = { userId: null },
  cookie,
}: { auth?: FakeAuth; cookie?: string } = {}) {
  return {
    locals: { auth: () => auth },
    cookies: { get: (name: string) => (name === '__session' ? cookie : undefined) },
  } as unknown as Parameters<typeof load>[0];
}

// Build a minimal unsigned JWT (header.payload.signature) with the given exp.
function fakeJwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '');
  return `${b64({ alg: 'none' })}.${b64(payload)}.sig`;
}

describe('root layout load — isAuthed surfaced for the landing page', () => {
  it('isAuthed=true when locals.auth().userId is set (auth route)', () => {
    const data = load(makeEvent({ auth: { userId: 'user_abc' } }));
    expect(data.isAuthed).toBe(true);
  });

  it('isAuthed=false when logged out and no session cookie (`/`)', () => {
    const data = load(makeEvent({ auth: { userId: null } }));
    expect(data.isAuthed).toBe(false);
  });

  it('isAuthed=true on `/` (userId null) when a non-expired __session cookie exists', () => {
    // hooks.server.ts gives `/` a no-op auth (userId null); the cookie is the
    // only signal that the visitor is logged in.
    const future = Math.floor(Date.now() / 1000) + 3600;
    const data = load(makeEvent({ auth: { userId: null }, cookie: fakeJwt({ exp: future }) }));
    expect(data.isAuthed).toBe(true);
  });

  it('isAuthed=false when the __session cookie is expired', () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    const data = load(makeEvent({ auth: { userId: null }, cookie: fakeJwt({ exp: past }) }));
    expect(data.isAuthed).toBe(false);
  });

  it('still forwards Clerk props for the auth-route ClerkProvider', () => {
    const data = load(makeEvent({ auth: { userId: 'user_abc' } })) as { __clerk: { userId: string } };
    expect(data.__clerk.userId).toBe('user_abc');
  });
});

describe('sessionCookieLooksAuthed', () => {
  it('false for undefined / empty / malformed tokens', () => {
    expect(sessionCookieLooksAuthed(undefined)).toBe(false);
    expect(sessionCookieLooksAuthed('')).toBe(false);
    expect(sessionCookieLooksAuthed('not-a-jwt')).toBe(false);
    expect(sessionCookieLooksAuthed('a.b')).toBe(false);
  });

  it('true for a well-formed token with a future exp', () => {
    const future = Math.floor(Date.now() / 1000) + 60;
    expect(sessionCookieLooksAuthed(fakeJwt({ exp: future }))).toBe(true);
  });

  it('false for a token whose exp is in the past', () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    expect(sessionCookieLooksAuthed(fakeJwt({ exp: past }))).toBe(false);
  });

  it('true for a well-formed token without an exp claim', () => {
    expect(sessionCookieLooksAuthed(fakeJwt({ sub: 'user_abc' }))).toBe(true);
  });
});
