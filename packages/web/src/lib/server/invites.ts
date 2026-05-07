// packages/web/src/lib/server/invites.ts
//
// Invite codes for anonymous /r/[id] access. A visitor with a valid
// `?invite=<code>` query param can view + edit a rackspace without
// signing in; a bare `/r/[id]` still redirects to /sign-in.
//
// The code is HMAC-SHA256(serverSecret, rackspaceId), truncated to 16 hex
// chars. Deterministic, so the server never needs to store per-rackspace
// invite metadata. Rotating INVITE_SECRET invalidates every outstanding
// invite — that's the (only) revocation primitive in Stage B.
//
// Web Crypto rather than node:crypto so the same code runs on Cloudflare
// Workers in prod. The HMAC key is imported once per process.

import { env } from '$env/dynamic/private';

const INVITE_LENGTH = 16; // hex chars; 64 bits of entropy, fine for share-URL bearer tokens

function getSecret(): string {
  const s = env.INVITE_SECRET;
  if (!s || s.length < 32) {
    // Fail loudly in prod, fall back to a fixed dev value locally so the
    // route works without extra env wiring during PR-B-c development.
    if (env.NODE_ENV === 'production') {
      throw new Error('INVITE_SECRET must be set (>= 32 chars) in production');
    }
    return 'dev-only-invite-secret-change-me-x'.padEnd(32, '_');
  }
  return s;
}

let keyPromise: Promise<CryptoKey> | null = null;
function getKey(): Promise<CryptoKey> {
  if (!keyPromise) {
    const secret = getSecret();
    keyPromise = crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
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

/** Stable invite code for a rackspace. Same input → same output across
 *  server restarts (only the secret changes the mapping). */
export async function getInviteCode(rackspaceId: string): Promise<string> {
  const key = await getKey();
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rackspaceId));
  return bytesToHex(new Uint8Array(sig)).slice(0, INVITE_LENGTH);
}

/** Constant-time compare to dodge timing oracles on the bearer token. */
export async function verifyInviteCode(rackspaceId: string, code: string | null | undefined): Promise<boolean> {
  if (!code || code.length !== INVITE_LENGTH) return false;
  const expected = await getInviteCode(rackspaceId);
  if (expected.length !== code.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ code.charCodeAt(i);
  }
  return diff === 0;
}
