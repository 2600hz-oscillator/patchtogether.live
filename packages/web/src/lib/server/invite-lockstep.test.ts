// packages/web/src/lib/server/invite-lockstep.test.ts
//
// LOCKSTEP GUARD — catches ALGORITHM drift between the two halves of the
// anonymous-invite scheme:
//
//   MINT (web):    packages/web/src/lib/server/invites.ts  → getInviteCode()
//   VERIFY (relay): packages/server/src/auth.ts            → verifyToken('anon:…')
//
// The web app mints HMAC-SHA256(INVITE_SECRET, rackspaceId)[0:16] and the relay
// re-derives + constant-time-compares it at the Hocuspocus WS handshake
// (onAuthenticate in packages/server/src/index.ts). If anyone edits the hash,
// the truncation length, the encoding, or the key derivation in ONE file but
// not the OTHER, every anon guest is silently rejected (red dot, `nodes 0`)
// while signed-in users are unaffected — exactly the failure this test exists
// to fail loudly on, in `task test`, before it ships.
//
// This is the ALGORITHM half of the guard. The SECRET-VALUE half (deployed web
// build vs deployed relay use the same INVITE_SECRET) is covered by the
// deploy-time anon-handshake smoke (scripts/anon-handshake-smoke.mjs, wired
// into deploy.yml). Together they close both drift vectors.

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const SHARED_SECRET = 'lockstep-test-secret-deterministic-32chars-or-more';

// Both code paths must end up keyed by the SAME secret for the lockstep
// assertion to mean "the algorithms agree" rather than "the secrets differ".
//   - web reads $env/dynamic/private.INVITE_SECRET
//   - relay reads process.env.INVITE_SECRET
vi.mock('$env/dynamic/private', () => ({
  env: { INVITE_SECRET: SHARED_SECRET },
}));
process.env.INVITE_SECRET = SHARED_SECRET;
// Relay's auth.ts imports @clerk/backend at module load; we never exercise the
// clerk path here, but the import must resolve. Stub it so we don't reach out.
vi.mock('@clerk/backend', () => ({ verifyToken: vi.fn() }));

// Real modules — NOT re-implementations. Importing the actual exports is what
// makes this catch drift: if either file changes, the imported behavior changes.
const { getInviteCode } = await import('./invites');
// Relative path into the SERVER package's real verifier. The path is built at
// runtime (not a static string literal) so svelte-check doesn't try to
// type-resolve a cross-package `.ts` import — vitest's resolver handles it
// fine at run time. We still import the REAL module, so drift is caught.
const RELAY_AUTH_REL = ['..', '..', '..', '..', 'server', 'src', 'auth.ts'].join('/');
const { verifyToken: relayVerifyToken } = await import(/* @vite-ignore */ RELAY_AUTH_REL);

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_INVITES_SRC = resolve(__dirname, './invites.ts');
const RELAY_AUTH_SRC = resolve(__dirname, '../../../../server/src/auth.ts');

describe('invite mint/verify lockstep (web ↔ relay)', () => {
  it('a code MINTED by the web verifies as ACCEPTED by the relay', async () => {
    const rackId = 'r_lockstep_abc123';
    const minted = await getInviteCode(rackId);
    // This is the exact wire shape the provider sends and onAuthenticate sees.
    const result = await relayVerifyToken(`anon:${minted}`, rackId);
    expect(result).toEqual({ ok: true, userId: null, role: 'anon' });
  });

  it('holds across many rackspace ids (not a one-off coincidence)', async () => {
    for (const id of ['r_a', 'rackspace-with-dashes', 'r_' + 'x'.repeat(40), 'Z9']) {
      const minted = await getInviteCode(id);
      const result = await relayVerifyToken(`anon:${minted}`, id);
      expect(result, `id=${id}`).toEqual({ ok: true, userId: null, role: 'anon' });
    }
  });

  it('relay rejects a web-minted code under the WRONG rackspace id', async () => {
    // Sanity that the verifier is actually binding to the doc name, so the
    // "accepts" assertions above are meaningful and not vacuously true.
    const minted = await getInviteCode('r_one');
    const result = await relayVerifyToken(`anon:${minted}`, 'r_two');
    expect(result).toEqual({ ok: false, reason: 'unauthorized' });
  });

  it('the two source files agree on INVITE_LENGTH', () => {
    const re = /INVITE_LENGTH\s*=\s*(\d+)/;
    const webLen = readFileSync(WEB_INVITES_SRC, 'utf8').match(re)?.[1];
    const relayLen = readFileSync(RELAY_AUTH_SRC, 'utf8').match(re)?.[1];
    expect(webLen, 'web invites.ts declares INVITE_LENGTH').toBeDefined();
    expect(relayLen, 'relay auth.ts declares INVITE_LENGTH').toBeDefined();
    expect(webLen).toBe(relayLen);
  });

  it('the two source files agree on the HMAC hash function', () => {
    // Guard against one side moving to SHA-512 / a different MAC while the
    // other stays on SHA-256. We assert both name the same `hash:` in their
    // importKey call.
    const re = /hash:\s*'([^']+)'/;
    const webHash = readFileSync(WEB_INVITES_SRC, 'utf8').match(re)?.[1];
    const relayHash = readFileSync(RELAY_AUTH_SRC, 'utf8').match(re)?.[1];
    expect(webHash, 'web declares a hash').toBe('SHA-256');
    expect(relayHash, 'relay declares a hash').toBe('SHA-256');
    expect(webHash).toBe(relayHash);
  });
});
