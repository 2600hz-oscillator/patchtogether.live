// packages/web/src/lib/server/saved-groups.ts
//
// Saved-group library data layer — Neon HTTP API.
//
// A "saved group" is a serialized snippet of the patch graph: the group
// node, its children, internal edges between them, and the exposed-port
// list. The user saves one from a rack; later they re-insert a copy
// (fresh ids minted at insert time) into any rack they're in.
//
// The library is per-user (scoped by Clerk user id). Saves/lists/deletes
// all require the requester to own the row; cross-user reads are
// rejected at the route handler.

import { sql } from './db.js';
import type { Edge, ModuleNode } from '$lib/graph/types';
import type { ExposedPort } from '$lib/graph/group-projection';

/** Hard cap on label length (DB CHECK enforces 1..64 too). */
export const SAVED_GROUP_LABEL_MAX = 64;
/** Per-user cap on saved groups. */
export const SAVED_GROUP_MAX_PER_USER = 100;
/** Hard cap on payload JSON size (bytes after JSON.stringify). */
export const SAVED_GROUP_MAX_PAYLOAD_BYTES = 256 * 1024;

/**
 * Serializable snapshot of a group + everything you need to re-stamp it
 * into another rack. All ids are LOCAL to this blob — they're rewritten
 * to fresh global ids at insert time (see resurrectSavedGroup).
 */
export interface SavedGroupPayload {
  label: string;
  exposedPorts: ExposedPort[];
  /** The group's children (not the group node itself; the group is rebuilt
   *  from `exposedPorts` + `label` at insert time). */
  children: ModuleNode[];
  /** Edges with both endpoints inside the group. Endpoints reference
   *  childIds within this payload. */
  internalEdges: Edge[];
}

export interface SavedGroup {
  id: string;
  userId: string;
  label: string;
  payload: SavedGroupPayload;
  createdAt: number;
  updatedAt: number;
}

interface SavedGroupRow {
  id: string;
  user_id: string;
  label: string;
  payload: SavedGroupPayload;
  created_at: string;
  updated_at: string;
}

function rowToSavedGroup(row: SavedGroupRow): SavedGroup {
  return {
    id: row.id,
    userId: row.user_id,
    label: row.label,
    payload: row.payload,
    createdAt: new Date(row.created_at).getTime(),
    updatedAt: new Date(row.updated_at).getTime(),
  };
}

function generateId(): string {
  // Saved-group ids are not bearer tokens (every read is auth-checked
  // against the owning user), so the entropy bar is lower than rackspace
  // ids — Math.random + base36 is fine. Prefix `sg_` so they sort
  // distinctly in logs.
  return `sg_${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 6)}`;
}

export type SaveResult =
  | { status: 'ok'; savedGroup: SavedGroup }
  | { status: 'cap-reached'; count: number };

/**
 * Persist a saved group for the given user. Single CTE keeps the cap
 * check + insert atomic against concurrent saves from the same user.
 */
export async function saveGroup(
  userId: string,
  label: string,
  payload: SavedGroupPayload,
): Promise<SaveResult> {
  const id = generateId();
  // Neon HTTP needs `${jsonb}::jsonb`-cast bind params for jsonb columns;
  // passing the object via template tag serializes to text by default.
  const payloadJson = JSON.stringify(payload);

  const rows = (await sql()`
    WITH owned AS (
      SELECT COUNT(*)::int AS n
        FROM saved_groups
       WHERE user_id = ${userId}
    ),
    inserted AS (
      INSERT INTO saved_groups (id, user_id, label, payload)
      SELECT ${id}, ${userId}, ${label}, ${payloadJson}::jsonb
        FROM owned
       WHERE owned.n < ${SAVED_GROUP_MAX_PER_USER}
      RETURNING id, user_id, label, payload, created_at, updated_at
    )
    SELECT
      (SELECT n FROM owned) AS owned_n,
      (SELECT id         FROM inserted) AS id,
      (SELECT user_id    FROM inserted) AS user_id,
      (SELECT label      FROM inserted) AS label,
      (SELECT payload    FROM inserted) AS payload,
      (SELECT created_at FROM inserted) AS created_at,
      (SELECT updated_at FROM inserted) AS updated_at
  `) as Array<{
    owned_n: number;
    id: string | null;
    user_id: string | null;
    label: string | null;
    payload: SavedGroupPayload | null;
    created_at: string | null;
    updated_at: string | null;
  }>;
  const row = rows[0];
  if (row.id === null) {
    return { status: 'cap-reached', count: row.owned_n };
  }
  return {
    status: 'ok',
    savedGroup: rowToSavedGroup({
      id: row.id,
      user_id: row.user_id!,
      label: row.label!,
      payload: row.payload!,
      created_at: row.created_at!,
      updated_at: row.updated_at!,
    }),
  };
}

/** List saved groups owned by `userId`, newest first. */
export async function listSavedGroupsForUser(userId: string): Promise<SavedGroup[]> {
  const rows = (await sql()`
    SELECT id, user_id, label, payload, created_at, updated_at
      FROM saved_groups
     WHERE user_id = ${userId}
     ORDER BY created_at DESC
  `) as SavedGroupRow[];
  return rows.map(rowToSavedGroup);
}

/** Fetch a single saved group; returns null when missing OR when the
 *  requester is not the owner (we don't differentiate to avoid leaking
 *  ownership). */
export async function getSavedGroupForUser(
  id: string,
  userId: string,
): Promise<SavedGroup | null> {
  const rows = (await sql()`
    SELECT id, user_id, label, payload, created_at, updated_at
      FROM saved_groups
     WHERE id = ${id} AND user_id = ${userId}
     LIMIT 1
  `) as SavedGroupRow[];
  if (rows.length === 0) return null;
  return rowToSavedGroup(rows[0]);
}

export type DeleteSavedGroupResult = 'ok' | 'not-found';

/** Owner-only delete. "not-found" covers both "no such id" and "wrong
 *  owner" so we don't leak existence of someone else's saved groups. */
export async function deleteSavedGroupForUser(
  id: string,
  userId: string,
): Promise<DeleteSavedGroupResult> {
  const rows = (await sql()`
    DELETE FROM saved_groups
     WHERE id = ${id} AND user_id = ${userId}
    RETURNING id
  `) as Array<{ id: string }>;
  return rows.length > 0 ? 'ok' : 'not-found';
}
