// packages/web/src/lib/server/rackspaces.ts
//
// Rackspace data layer. Stage A: in-memory Map (resets on server restart —
// fine for local dev iteration on auth + routing). Stage B swaps this for
// Cloudflare D1 with the same API surface.
//
// A Rackspace = an authenticated container for a multi-user patch session.
// Owner creates it via /dashboard, gets a share URL, up to 4 total
// participants (owner + 3 invitees) can join.

const MAX_MEMBERS = 4;

export interface Rackspace {
  id: string;
  ownerUserId: string;
  name: string;
  createdAt: number;
  memberUserIds: string[]; // includes the owner
}

const rackspaces = new Map<string, Rackspace>();

function generateId(): string {
  // Rackspace IDs ARE the bearer token used by share-URL access — anyone with
  // the URL gets visit-and-join rights. Math.random is not cryptographically
  // suitable for that role; use crypto.getRandomValues, available
  // synchronously on both Node and Cloudflare Workers.
  //
  // Rejection-sample bytes against the alphabet length to avoid modulo bias
  // (256 % 31 != 0). Each rejected byte gets resampled until a usable one
  // lands; expected total samples ≈ 8 / (248/256) ≈ 8.3 bytes — negligible.
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const cutoff = Math.floor(256 / alphabet.length) * alphabet.length;
  let id = 'r_';
  while (id.length < 10) {
    const buf = new Uint8Array(8);
    crypto.getRandomValues(buf);
    for (const b of buf) {
      if (b >= cutoff) continue;
      id += alphabet[b % alphabet.length];
      if (id.length === 10) break;
    }
  }
  return id;
}

export function createRackspace(ownerUserId: string, name: string): Rackspace {
  let id = generateId();
  while (rackspaces.has(id)) id = generateId();
  const rackspace: Rackspace = {
    id,
    ownerUserId,
    name,
    createdAt: Date.now(),
    memberUserIds: [ownerUserId],
  };
  rackspaces.set(id, rackspace);
  return rackspace;
}

export function getRackspace(id: string): Rackspace | null {
  return rackspaces.get(id) ?? null;
}

/** Rackspaces this user is a member of (owner included). */
export function listRackspacesForUser(userId: string): Rackspace[] {
  return Array.from(rackspaces.values())
    .filter((r) => r.memberUserIds.includes(userId))
    .sort((a, b) => b.createdAt - a.createdAt);
}

export type JoinResult =
  | { status: 'ok'; rackspace: Rackspace }
  | { status: 'already-member'; rackspace: Rackspace }
  | { status: 'full'; rackspace: Rackspace }
  | { status: 'not-found' };

export function joinRackspace(rackspaceId: string, userId: string): JoinResult {
  const rackspace = rackspaces.get(rackspaceId);
  if (!rackspace) return { status: 'not-found' };
  if (rackspace.memberUserIds.includes(userId)) {
    return { status: 'already-member', rackspace };
  }
  if (rackspace.memberUserIds.length >= MAX_MEMBERS) {
    return { status: 'full', rackspace };
  }
  rackspace.memberUserIds.push(userId);
  return { status: 'ok', rackspace };
}

export function isMember(rackspaceId: string, userId: string): boolean {
  const rackspace = rackspaces.get(rackspaceId);
  return rackspace?.memberUserIds.includes(userId) ?? false;
}

export const RACKSPACE_MAX_MEMBERS = MAX_MEMBERS;
