// packages/web/src/lib/server/rackspaces.ts
//
// Rackspace data layer — Neon HTTP API (B1).
//
// Stage A's in-memory Map died on Cloudflare Workers because each
// request can hit a different isolate. B1 ports the same API surface
// to Postgres on Neon, accessed via @neondatabase/serverless's HTTP
// `neon` template tag (chosen over the WebSocket Pool because CF
// Workers' egress proxy 403s outbound WS handshakes — see ./db.ts).
//
// All multi-step operations are rewritten as single CTE statements so
// they remain atomic without needing a client-side transaction
// (which the HTTP API doesn't support across round-trips).
//
// A Rackspace = an authenticated container for a multi-user patch
// session. Owner creates one, gets a share URL, up to 4 total users
// (owner + 3 invitees) can join.

import { sql } from './db.js';

const MAX_MEMBERS = 4;
const MAX_OWNED_PER_USER = 4;

export interface Rackspace {
  id: string;
  ownerUserId: string;
  name: string;
  createdAt: number;
  memberUserIds: string[]; // includes the owner
}

function generateId(): string {
  // Rackspace IDs ARE the bearer token used by share-URL access — anyone
  // with the URL gets visit-and-join rights. Math.random is not
  // cryptographically suitable for that role; use crypto.getRandomValues,
  // available synchronously on both Node and Cloudflare Workers.
  //
  // Rejection-sample bytes against the alphabet length to avoid modulo
  // bias (256 % 31 != 0).
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

interface RackRow {
  id: string;
  owner_user_id: string;
  name: string;
  created_at: string;
  member_user_ids: string[] | null;
}

function rackFromRow(row: RackRow): Rackspace {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    name: row.name,
    createdAt: new Date(row.created_at).getTime(),
    memberUserIds: row.member_user_ids ?? [],
  };
}

export type CreateResult =
  | { status: 'ok'; rackspace: Rackspace }
  | { status: 'cap-reached'; ownedCount: number };

export async function createRackspace(
  ownerUserId: string,
  name: string,
): Promise<CreateResult> {
  const id = generateId();
  // CTE: count user's owned racks; only insert if under cap. Single
  // statement keeps the check + insert atomic against concurrent creates.
  const rows = (await sql()`
    WITH owned AS (
      SELECT COUNT(*)::int AS n
        FROM racks
       WHERE owner_user_id = ${ownerUserId}
    ),
    new_rack AS (
      INSERT INTO racks (id, owner_user_id, name)
      SELECT ${id}, ${ownerUserId}, ${name}
        FROM owned
       WHERE owned.n < ${MAX_OWNED_PER_USER}
      RETURNING id, owner_user_id, name, created_at
    ), new_member AS (
      INSERT INTO rack_members (rack_id, user_id, role)
      SELECT id, owner_user_id, 'owner' FROM new_rack
    )
    SELECT
      (SELECT n FROM owned) AS owned_n,
      (SELECT id            FROM new_rack) AS id,
      (SELECT owner_user_id FROM new_rack) AS owner_user_id,
      (SELECT name          FROM new_rack) AS name,
      (SELECT created_at    FROM new_rack) AS created_at
  `) as Array<{
    owned_n: number;
    id: string | null;
    owner_user_id: string | null;
    name: string | null;
    created_at: string | null;
  }>;
  const row = rows[0];
  if (row.id === null) {
    return { status: 'cap-reached', ownedCount: row.owned_n };
  }
  return {
    status: 'ok',
    rackspace: rackFromRow({
      id: row.id,
      owner_user_id: row.owner_user_id!,
      name: row.name!,
      created_at: row.created_at!,
      member_user_ids: [ownerUserId],
    }),
  };
}

export type DeleteResult = 'ok' | 'not-found' | 'forbidden';

export async function deleteRackspace(
  id: string,
  requesterUserId: string,
): Promise<DeleteResult> {
  // Two-step semantics in one statement: rows hits if the rack exists AND
  // the requester is the owner; otherwise the WHERE drops it. We then
  // distinguish "not found" from "not owner" with a follow-up existence
  // probe. The DELETE cascades to rack_members + rack_snapshots via
  // ON DELETE CASCADE in the schema.
  const deleted = (await sql()`
    DELETE FROM racks
     WHERE id = ${id}
       AND owner_user_id = ${requesterUserId}
    RETURNING id
  `) as Array<{ id: string }>;
  if (deleted.length > 0) return 'ok';
  const exists = (await sql()`
    SELECT 1 AS one FROM racks WHERE id = ${id} LIMIT 1
  `) as Array<{ one: number }>;
  return exists.length === 0 ? 'not-found' : 'forbidden';
}

export const RACKSPACE_MAX_OWNED = MAX_OWNED_PER_USER;

export async function getRackspace(id: string): Promise<Rackspace | null> {
  const rows = (await sql()`
    SELECT r.id, r.owner_user_id, r.name, r.created_at,
           COALESCE(
             (SELECT array_agg(m.user_id ORDER BY m.joined_at)
                FROM rack_members m WHERE m.rack_id = r.id),
             ARRAY[]::text[]
           ) AS member_user_ids
      FROM racks r
     WHERE r.id = ${id}
  `) as RackRow[];
  if (rows.length === 0) return null;
  return rackFromRow(rows[0]);
}

/** Rackspaces this user is a member of (owner included). */
export async function listRackspacesForUser(userId: string): Promise<Rackspace[]> {
  const rows = (await sql()`
    SELECT r.id, r.owner_user_id, r.name, r.created_at,
           COALESCE(
             (SELECT array_agg(m2.user_id ORDER BY m2.joined_at)
                FROM rack_members m2 WHERE m2.rack_id = r.id),
             ARRAY[]::text[]
           ) AS member_user_ids
      FROM racks r
      JOIN rack_members m ON m.rack_id = r.id
     WHERE m.user_id = ${userId}
     ORDER BY r.created_at DESC
  `) as RackRow[];
  return rows.map(rackFromRow);
}

export type JoinResult =
  | { status: 'ok'; rackspace: Rackspace }
  | { status: 'already-member'; rackspace: Rackspace }
  | { status: 'full'; rackspace: Rackspace }
  | { status: 'not-found' };

interface JoinRow {
  id: string | null;
  owner_user_id: string | null;
  name: string | null;
  created_at: string | null;
  existing_members: string[];
  inserted: boolean;
}

export async function joinRackspace(rackspaceId: string, userId: string): Promise<JoinResult> {
  // Single CTE: load rack metadata, list existing members, conditionally
  // insert the new member (only if rack exists, user is not already a
  // member, and capacity isn't exceeded). The boolean `inserted` tells
  // us which case we hit.
  //
  // Race window: the capacity check (`counts.n < MAX_MEMBERS`) and
  // the INSERT are not row-locked, so two simultaneous joins on the
  // last slot can both succeed. Acceptable for beta (4-user max,
  // very low concurrency); upgrade to advisory_xact_lock if it bites.
  const rows = (await sql()`
    WITH rack AS (
      SELECT id, owner_user_id, name, created_at
        FROM racks
       WHERE id = ${rackspaceId}
    ),
    existing AS (
      SELECT user_id, joined_at
        FROM rack_members
       WHERE rack_id = ${rackspaceId}
    ),
    counts AS (
      SELECT COUNT(*)::int AS n FROM existing
    ),
    ins AS (
      INSERT INTO rack_members (rack_id, user_id, role)
      SELECT ${rackspaceId}, ${userId}, 'member'
        FROM rack, counts
       WHERE NOT EXISTS (SELECT 1 FROM existing WHERE user_id = ${userId})
         AND counts.n < ${MAX_MEMBERS}
      ON CONFLICT (rack_id, user_id) DO NOTHING
      RETURNING user_id
    )
    SELECT
      (SELECT id              FROM rack) AS id,
      (SELECT owner_user_id   FROM rack) AS owner_user_id,
      (SELECT name            FROM rack) AS name,
      (SELECT created_at      FROM rack) AS created_at,
      COALESCE(
        (SELECT array_agg(user_id ORDER BY joined_at) FROM existing),
        ARRAY[]::text[]
      ) AS existing_members,
      EXISTS (SELECT 1 FROM ins) AS inserted
  `) as JoinRow[];

  const row = rows[0];
  if (row.id === null) return { status: 'not-found' };

  const rack: Rackspace = {
    id: row.id,
    ownerUserId: row.owner_user_id!,
    name: row.name!,
    createdAt: new Date(row.created_at!).getTime(),
    memberUserIds: row.inserted
      ? [...row.existing_members, userId]
      : row.existing_members,
  };

  if (row.inserted) return { status: 'ok', rackspace: rack };
  if (row.existing_members.includes(userId)) return { status: 'already-member', rackspace: rack };
  return { status: 'full', rackspace: rack };
}

export async function isMember(rackspaceId: string, userId: string): Promise<boolean> {
  const rows = (await sql()`
    SELECT 1 AS one
      FROM rack_members
     WHERE rack_id = ${rackspaceId} AND user_id = ${userId}
     LIMIT 1
  `) as { one: number }[];
  return rows.length > 0;
}

export const RACKSPACE_MAX_MEMBERS = MAX_MEMBERS;
