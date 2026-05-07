// packages/server/src/auth.ts
//
// Stage B PR-D: validate the auth token at the Hocuspocus handshake.
// Two valid forms:
//   clerk:<JWT>      → verified via @clerk/backend.verifyToken
//   anon:<16hexchar> → HMAC-verified against the documentName
// Anything else fails. The verifyToken result is used by index.ts'
// onAuthenticate to populate context.userId / role for later hooks.
//
// Membership check (does this user belong to this rackspace?) is NOT
// performed here — that requires access to the rackspace store which
// lives in the web package. Authed users can WS-connect to any rack
// they know the id of, gated only by the HTTP /r/[id] route loader.
// Closing that gap is post-Stage-B work (requires shared rackspace
// storage, e.g. Cloudflare D1).

import { verifyToken as clerkVerifyToken } from '@clerk/backend';

const INVITE_LENGTH = 16; // hex chars; same as packages/web/src/lib/server/invites.ts

export interface AuthOk {
  ok: true;
  userId: string | null; // null for anon
  role: 'member' | 'anon';
}

export interface AuthFail {
  ok: false;
  reason: 'unauthorized' | 'invalid-format';
}

export type AuthResult = AuthOk | AuthFail;

function getInviteSecret(): string {
  const s = process.env.INVITE_SECRET;
  if (!s || s.length < 32) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('INVITE_SECRET must be set (>= 32 chars) in production');
    }
    // MUST stay in lockstep with packages/web/src/lib/server/invites.ts.
    // If you change one, change both.
    return 'dev-only-invite-secret-change-me-x'.padEnd(32, '_');
  }
  return s;
}

let keyPromise: Promise<CryptoKey> | null = null;
function getKey(): Promise<CryptoKey> {
  if (!keyPromise) {
    keyPromise = crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(getInviteSecret()),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
  }
  return keyPromise;
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

async function verifyInviteCode(rackspaceId: string, code: string): Promise<boolean> {
  if (code.length !== INVITE_LENGTH) return false;
  const key = await getKey();
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rackspaceId));
  const expected = bytesToHex(new Uint8Array(sig)).slice(0, INVITE_LENGTH);
  if (expected.length !== code.length) return false;
  // Constant-time compare to dodge timing oracles on the bearer token.
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ code.charCodeAt(i);
  }
  return diff === 0;
}

async function verifyClerkJwt(jwt: string): Promise<string | null> {
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('CLERK_SECRET_KEY must be set in production');
    }
    // No way to verify in dev without a key — return null and the caller
    // rejects. Local-dev WS sessions should pass invite tokens instead.
    return null;
  }
  try {
    const payload = await clerkVerifyToken(jwt, { secretKey });
    // JWT `sub` claim is the user id.
    return typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}

/** Verify a Hocuspocus auth token against a documentName.
 *  Returns userId + role on success, a fail-reason otherwise. */
export async function verifyToken(token: string, documentName: string): Promise<AuthResult> {
  if (!token || typeof token !== 'string') {
    return { ok: false, reason: 'invalid-format' };
  }
  if (token.startsWith('anon:')) {
    const code = token.slice('anon:'.length);
    const ok = await verifyInviteCode(documentName, code);
    return ok ? { ok: true, userId: null, role: 'anon' } : { ok: false, reason: 'unauthorized' };
  }
  if (token.startsWith('clerk:')) {
    const jwt = token.slice('clerk:'.length);
    const userId = await verifyClerkJwt(jwt);
    return userId
      ? { ok: true, userId, role: 'member' }
      : { ok: false, reason: 'unauthorized' };
  }
  return { ok: false, reason: 'invalid-format' };
}

/** Standardized rejection messages returned to the client. The provider's
 *  onAuthenticationFailed handler keys off these to surface the right UX. */
export const AUTH_REJECTION = {
  unauthorized: 'unauthorized',
  invalidFormat: 'invalid-format',
} as const;
