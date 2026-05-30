// packages/server/src/rack-access.ts
//
// Post-auth gate: given the verified auth result + rack id, decide whether
// to accept the WS handshake. Extracted from index.ts's onAuthenticate so
// the prod-only anon-existence-check branch can be unit-tested without
// standing up a full Hocuspocus instance.
//
// Returns 'ok' or a reject-reason string. Reject-reason 'not-member' is
// used for both clerk-user-not-in-rack AND anon-bogus-rack-id (the wire
// rejection is the same: AUTH_REJECTION.unauthorized; reasons differ only
// for our own log lines).

import type { AuthOk } from './auth.js';

export type AccessDecision = 'ok' | 'not-member' | 'no-such-rack';

export interface AccessDeps {
  isRackspaceMember: (rackId: string, userId: string) => Promise<boolean>;
  rackspaceExists: (rackId: string) => Promise<boolean>;
  /** Defaults to `process.env.NODE_ENV` — overridable for tests. */
  nodeEnv?: string | undefined;
}

export async function checkRackAccess(
  auth: AuthOk,
  rackId: string,
  deps: AccessDeps,
): Promise<AccessDecision> {
  if (auth.role === 'member') {
    const allowed = await deps.isRackspaceMember(rackId, auth.userId!);
    return allowed ? 'ok' : 'not-member';
  }
  // auth.role === 'anon'
  //
  // Anon visitors authenticate by HMAC invite (only the server can derive
  // it), so they don't need a membership row. But a valid invite for a
  // NONEXISTENT rack id is still a problem in prod: it passes auth and
  // makes Hocuspocus allocate an empty Yjs doc that lives in process
  // memory until the first persist throws the 23503 FK violation. An
  // attacker churning connects for bogus ids becomes a memory-pressure
  // vector. One cheap `SELECT 1 FROM racks` closes it.
  //
  // We gate this on NODE_ENV === 'production' so dev/test ergonomics
  // (Playwright @collab specs use ephemeral rack ids that don't exist
  // in any racks table) are preserved.
  const env = deps.nodeEnv ?? process.env.NODE_ENV;
  if (env === 'production') {
    const exists = await deps.rackspaceExists(rackId);
    return exists ? 'ok' : 'no-such-rack';
  }
  return 'ok';
}
