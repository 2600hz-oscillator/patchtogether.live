// packages/web/src/lib/server/rackspaces.ts
//
// Rackspace data layer — Postgres-backed (B1).
//
// Stage A's in-memory Map died on Cloudflare Workers because each
// request can hit a different isolate; window 1 created a rack, window
// 2 hit a different worker and 404'd. This module ports the same API
// surface to a real datastore. Schema lives in db/schema/001_init.sql.
// Connection details: see ./db.ts (DATABASE_URL on both Workers and
// vite-dev; Hyperdrive deferred — see db/README.md).
//
// All functions are async. Callers (4 routes as of B1) await.
//
// A Rackspace = an authenticated container for a multi-user patch
// session. Owner creates one, gets a share URL, up to 4 total users
// (owner + 3 invitees) can join.

import { withDb } from './db.js';

const MAX_MEMBERS = 4;

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
  created_at: Date;
}

async function loadMembers(
  client: import('pg').Client,
  rackIds: string[],
): Promise<Map<string, string[]>> {
  if (rackIds.length === 0) return new Map();
  const { rows } = await client.query<{ rack_id: string; user_id: string }>(
    'SELECT rack_id, user_id FROM rack_members WHERE rack_id = ANY($1::text[]) ORDER BY joined_at',
    [rackIds],
  );
  const out = new Map<string, string[]>();
  for (const id of rackIds) out.set(id, []);
  for (const r of rows) {
    out.get(r.rack_id)!.push(r.user_id);
  }
  return out;
}

function rackFromRow(row: RackRow, memberUserIds: string[]): Rackspace {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    name: row.name,
    createdAt: row.created_at.getTime(),
    memberUserIds,
  };
}

export function createRackspace(ownerUserId: string, name: string): Promise<Rackspace> {
  return withDb(async (client) => {
    const id = generateId();
    await client.query('BEGIN');
    try {
      await client.query(
        'INSERT INTO racks (id, owner_user_id, name) VALUES ($1, $2, $3)',
        [id, ownerUserId, name],
      );
      await client.query(
        "INSERT INTO rack_members (rack_id, user_id, role) VALUES ($1, $2, 'owner')",
        [id, ownerUserId],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
    return {
      id,
      ownerUserId,
      name,
      createdAt: Date.now(),
      memberUserIds: [ownerUserId],
    };
  });
}

export function getRackspace(id: string): Promise<Rackspace | null> {
  return withDb(async (client) => {
    const { rows } = await client.query<RackRow>(
      'SELECT id, owner_user_id, name, created_at FROM racks WHERE id = $1',
      [id],
    );
    if (rows.length === 0) return null;
    const members = await loadMembers(client, [id]);
    return rackFromRow(rows[0], members.get(id) ?? []);
  });
}

/** Rackspaces this user is a member of (owner included). */
export function listRackspacesForUser(userId: string): Promise<Rackspace[]> {
  return withDb(async (client) => {
    const { rows } = await client.query<RackRow>(
      `SELECT r.id, r.owner_user_id, r.name, r.created_at
         FROM racks r
         JOIN rack_members m ON m.rack_id = r.id
        WHERE m.user_id = $1
        ORDER BY r.created_at DESC`,
      [userId],
    );
    const ids = rows.map((r) => r.id);
    const members = await loadMembers(client, ids);
    return rows.map((r) => rackFromRow(r, members.get(r.id) ?? []));
  });
}

export type JoinResult =
  | { status: 'ok'; rackspace: Rackspace }
  | { status: 'already-member'; rackspace: Rackspace }
  | { status: 'full'; rackspace: Rackspace }
  | { status: 'not-found' };

export function joinRackspace(rackspaceId: string, userId: string): Promise<JoinResult> {
  return withDb(async (client) => {
    await client.query('BEGIN');
    try {
      const { rows: rackRows } = await client.query<RackRow>(
        'SELECT id, owner_user_id, name, created_at FROM racks WHERE id = $1 FOR UPDATE',
        [rackspaceId],
      );
      if (rackRows.length === 0) {
        await client.query('ROLLBACK');
        return { status: 'not-found' };
      }
      const members = await loadMembers(client, [rackspaceId]);
      const memberUserIds = members.get(rackspaceId) ?? [];
      if (memberUserIds.includes(userId)) {
        await client.query('ROLLBACK');
        return {
          status: 'already-member',
          rackspace: rackFromRow(rackRows[0], memberUserIds),
        };
      }
      if (memberUserIds.length >= MAX_MEMBERS) {
        await client.query('ROLLBACK');
        return { status: 'full', rackspace: rackFromRow(rackRows[0], memberUserIds) };
      }
      await client.query(
        "INSERT INTO rack_members (rack_id, user_id, role) VALUES ($1, $2, 'member')",
        [rackspaceId, userId],
      );
      await client.query('COMMIT');
      return {
        status: 'ok',
        rackspace: rackFromRow(rackRows[0], [...memberUserIds, userId]),
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  });
}

export function isMember(rackspaceId: string, userId: string): Promise<boolean> {
  return withDb(async (client) => {
    const { rowCount } = await client.query(
      'SELECT 1 FROM rack_members WHERE rack_id = $1 AND user_id = $2',
      [rackspaceId, userId],
    );
    return (rowCount ?? 0) > 0;
  });
}

export const RACKSPACE_MAX_MEMBERS = MAX_MEMBERS;
