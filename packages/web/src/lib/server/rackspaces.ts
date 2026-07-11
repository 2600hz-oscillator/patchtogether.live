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
import { normalizeRackMode, type RackMode } from '$lib/graph/rack-mode';

const MAX_MEMBERS = 4;
const MAX_OWNED_PER_USER = 4;

export interface Rackspace {
  id: string;
  ownerUserId: string;
  name: string;
  createdAt: number;
  memberUserIds: string[]; // includes the owner
  /** The rack shell: 'dawless' (the existing UI) or 'workflow'. Column
   *  added by db/schema/005_rackspace_mode.sql; pre-migration rows read
   *  as 'dawless' via normalizeRackMode. */
  mode: RackMode;
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
  /** Nullable at the type level for defensive reads; the column itself is
   *  NOT NULL DEFAULT 'dawless' (005_rackspace_mode.sql). */
  mode?: string | null;
}

function rackFromRow(row: RackRow): Rackspace {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    name: row.name,
    createdAt: new Date(row.created_at).getTime(),
    memberUserIds: row.member_user_ids ?? [],
    mode: normalizeRackMode(row.mode),
  };
}

// ---- Pre-005 resilience (racks.mode column missing) -----------------------
// #1050 shipped code reading `racks.mode` while 005_rackspace_mode.sql is a
// MANUAL migration — main auto-deployed to dev ahead of the column and every
// authenticated dashboard load threw 42703 (login appeared broken with a 500).
// The data layer must never depend on deploy-before-migrate ordering: on the
// first undefined-column error we LATCH legacy mode (one loud tagged log
// line), serve `mode: 'dawless'` from column-free queries, and stay latched
// until the process restarts after the migration lands. Same degrade doctrine
// as the relay's `relay_journal_table_missing` (42P01) path.
let modeColumnMissing = false;

function isUndefinedColumnError(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '42703'
  );
}

function latchModeColumnMissing(where: string, err: unknown): void {
  if (!modeColumnMissing) {
    // eslint-disable-next-line no-console
    console.error(
      `event=rackspaces_mode_column_missing level=error where=${where} ` +
        `msg="racks.mode absent — apply db/schema/005_rackspace_mode.sql; serving mode='dawless'" ` +
        `detail="${(err instanceof Error ? err.message : String(err)).replace(/"/g, '\\"')}"`,
    );
  }
  modeColumnMissing = true;
}

/** Run the mode-aware query; on 42703 latch + fall back to the column-free
 *  legacy query (rows read as mode='dawless' via normalizeRackMode(null)). */
async function withModeFallback<T>(
  where: string,
  modern: () => Promise<T>,
  legacy: () => Promise<T>,
): Promise<T> {
  if (!modeColumnMissing) {
    try {
      return await modern();
    } catch (err) {
      if (!isUndefinedColumnError(err)) throw err;
      latchModeColumnMissing(where, err);
    }
  }
  return legacy();
}

/** Test seam: clear the latch between cases. */
export function __resetModeColumnLatchForTests(): void {
  modeColumnMissing = false;
}

export type CreateResult =
  | { status: 'ok'; rackspace: Rackspace }
  | { status: 'cap-reached'; ownedCount: number };

export async function createRackspace(
  ownerUserId: string,
  name: string,
  mode: RackMode = 'dawless',
): Promise<CreateResult> {
  const id = generateId();
  // Defensive: never trust a caller-supplied string beyond the union (the
  // route validates too; the CHECK constraint is the last line).
  const safeMode = normalizeRackMode(mode);
  // CTE: count user's owned racks; only insert if under cap. Single
  // statement keeps the check + insert atomic against concurrent creates.
  // Legacy (pre-005) variant inserts without the mode column — the created
  // rack reads back as 'dawless' (and becomes its stored default once the
  // migration lands).
  const rows = (await withModeFallback(
    'createRackspace',
    () => sql()`
    WITH owned AS (
      SELECT COUNT(*)::int AS n
        FROM racks
       WHERE owner_user_id = ${ownerUserId}
    ),
    new_rack AS (
      INSERT INTO racks (id, owner_user_id, name, mode)
      SELECT ${id}, ${ownerUserId}, ${name}, ${safeMode}
        FROM owned
       WHERE owned.n < ${MAX_OWNED_PER_USER}
      RETURNING id, owner_user_id, name, created_at, mode
    ), new_member AS (
      INSERT INTO rack_members (rack_id, user_id, role)
      SELECT id, owner_user_id, 'owner' FROM new_rack
    )
    SELECT
      (SELECT n FROM owned) AS owned_n,
      (SELECT id            FROM new_rack) AS id,
      (SELECT owner_user_id FROM new_rack) AS owner_user_id,
      (SELECT name          FROM new_rack) AS name,
      (SELECT created_at    FROM new_rack) AS created_at,
      (SELECT mode          FROM new_rack) AS mode
  `,
    () => sql()`
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
      (SELECT created_at    FROM new_rack) AS created_at,
      NULL                                 AS mode
  `,
  )) as Array<{
    owned_n: number;
    id: string | null;
    owner_user_id: string | null;
    name: string | null;
    created_at: string | null;
    mode: string | null;
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
      mode: row.mode,
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

// 'is-owner' is distinct from 'forbidden' so the endpoint can return a
// clear "owners must delete, not leave" message rather than a generic 403.
export type LeaveResult = 'ok' | 'not-found' | 'not-member' | 'is-owner';

export async function leaveRackspace(
  id: string,
  requesterUserId: string,
): Promise<LeaveResult> {
  // Single CTE so the existence + ownership checks travel with the DELETE
  // (the Neon HTTP API has no cross-round-trip transaction). We compute
  // every distinguishing flag up front, then conditionally delete the
  // requester's membership row only when they are a non-owner member.
  // Owners must not leave — their slot is structural (the rack would be
  // ownerless); they delete the rackspace instead.
  const rows = (await sql()`
    WITH rack AS (
      SELECT id, owner_user_id
        FROM racks
       WHERE id = ${id}
    ),
    membership AS (
      SELECT 1 AS one
        FROM rack_members
       WHERE rack_id = ${id} AND user_id = ${requesterUserId}
       LIMIT 1
    ),
    del AS (
      DELETE FROM rack_members
       WHERE rack_id = ${id}
         AND user_id = ${requesterUserId}
         AND EXISTS (SELECT 1 FROM rack)
         AND (SELECT owner_user_id FROM rack) <> ${requesterUserId}
      RETURNING user_id
    )
    SELECT
      EXISTS (SELECT 1 FROM rack)                                   AS rack_exists,
      ((SELECT owner_user_id FROM rack) = ${requesterUserId})       AS is_owner,
      EXISTS (SELECT 1 FROM membership)                             AS is_member,
      EXISTS (SELECT 1 FROM del)                                    AS deleted
  `) as Array<{
    rack_exists: boolean;
    is_owner: boolean;
    is_member: boolean;
    deleted: boolean;
  }>;
  const row = rows[0];
  if (!row.rack_exists) return 'not-found';
  if (row.is_owner) return 'is-owner';
  if (!row.is_member) return 'not-member';
  return 'ok';
}

export async function getRackspace(id: string): Promise<Rackspace | null> {
  const rows = (await withModeFallback(
    'getRackspace',
    () => sql()`
    SELECT r.id, r.owner_user_id, r.name, r.created_at, r.mode,
           COALESCE(
             (SELECT array_agg(m.user_id ORDER BY m.joined_at)
                FROM rack_members m WHERE m.rack_id = r.id),
             ARRAY[]::text[]
           ) AS member_user_ids
      FROM racks r
     WHERE r.id = ${id}
  `,
    () => sql()`
    SELECT r.id, r.owner_user_id, r.name, r.created_at,
           COALESCE(
             (SELECT array_agg(m.user_id ORDER BY m.joined_at)
                FROM rack_members m WHERE m.rack_id = r.id),
             ARRAY[]::text[]
           ) AS member_user_ids
      FROM racks r
     WHERE r.id = ${id}
  `,
  )) as RackRow[];
  if (rows.length === 0) return null;
  return rackFromRow(rows[0]);
}

/** Rackspaces this user is a member of (owner included). */
export async function listRackspacesForUser(userId: string): Promise<Rackspace[]> {
  const rows = (await withModeFallback(
    'listRackspacesForUser',
    () => sql()`
    SELECT r.id, r.owner_user_id, r.name, r.created_at, r.mode,
           COALESCE(
             (SELECT array_agg(m2.user_id ORDER BY m2.joined_at)
                FROM rack_members m2 WHERE m2.rack_id = r.id),
             ARRAY[]::text[]
           ) AS member_user_ids
      FROM racks r
      JOIN rack_members m ON m.rack_id = r.id
     WHERE m.user_id = ${userId}
     ORDER BY r.created_at DESC
  `,
    () => sql()`
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
  `,
  )) as RackRow[];
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
  mode: string | null;
  existing_members: string[];
  inserted: boolean;
}

/** The join CTE, mode-aware (post-005) variant. Kept beside the legacy twin
 *  below — the ONLY differences are the rack CTE's select list and the mode
 *  line of the outer SELECT (NULL in legacy). */
function joinCte(rackspaceId: string, userId: string) {
  return sql()`
      WITH rack AS (
        SELECT id, owner_user_id, name, created_at, mode
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
        (SELECT mode            FROM rack) AS mode,
        COALESCE(
          (SELECT array_agg(user_id ORDER BY joined_at) FROM existing),
          ARRAY[]::text[]
        ) AS existing_members,
        EXISTS (SELECT 1 FROM ins) AS inserted
    `;
}

/** Pre-005 twin of {@link joinCte}: no racks.mode reference; mode reads NULL
 *  → normalizeRackMode → 'dawless'. */
function joinCteLegacy(rackspaceId: string, userId: string) {
  return sql()`
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
        NULL                               AS mode,
        COALESCE(
          (SELECT array_agg(user_id ORDER BY joined_at) FROM existing),
          ARRAY[]::text[]
        ) AS existing_members,
        EXISTS (SELECT 1 FROM ins) AS inserted
    `;
}

export async function joinRackspace(rackspaceId: string, userId: string): Promise<JoinResult> {
  // Atomicity: a single CTE handles existence + capacity + insert in one
  // statement (the Neon HTTP API has no cross-round-trip transactions
  // outside `sql.transaction([...])`). But the CTE alone doesn't lock —
  // two concurrent joins on the last slot can both read `counts.n=3`,
  // both pass `n < MAX_MEMBERS`, and both INSERT, busting the 4-user cap.
  //
  // Fix: wrap the CTE in `sql.transaction([advisory_lock, CTE])` and take
  // a per-rack `pg_advisory_xact_lock` first. The lock is held for the
  // lifetime of the transaction and released on COMMIT (the "xact" suffix
  // — no explicit unlock needed, no leak on error). Hashing the rack id
  // into bigint keys the lock per-rack so concurrent joins to DIFFERENT
  // racks don't serialize.
  //
  // hashtext() is Postgres-internal but deterministic and 32-bit; we cast
  // to bigint to match pg_advisory_xact_lock(bigint)'s preferred overload.
  const runJoinTx = (withMode: boolean) =>
    sql().transaction([
      sql()`SELECT pg_advisory_xact_lock(hashtext(${rackspaceId})::bigint)`,
      withMode ? joinCte(rackspaceId, userId) : joinCteLegacy(rackspaceId, userId),
    ]);
  const txResults = (await withModeFallback(
    'joinRackspace',
    () => runJoinTx(true),
    () => runJoinTx(false),
  )) as [unknown, JoinRow[]];
  const rows = txResults[1];

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
    mode: normalizeRackMode(row.mode),
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

// ---------------- Test-only seed helper ----------------
//
// `seedRackspaceForTest` bypasses the per-user owned-rack cap and the Clerk-
// session requirement so e2e specs can spin up a fresh `/r/[id]` route in one
// round-trip. The route handler that wraps this (see
// routes/api/test/seed-rackspace/+server.ts) is gated on RACKSPACE_SEED_ENABLED
// === '1' so this CANNOT be reached from prod.
//
// The synthetic owner id is namespaced `test_seed_<uuid>` so any leak into
// dashboards / metrics is trivially greppable. The owner membership row is
// inserted with role='owner' so /r/[id]/+page.server.ts sees the synthetic
// owner as a member when needed; anon visitors with the HMAC-derived invite
// code still flow through the unauthed-with-invite path.
//
// Optional `snapshot` is the raw bytes of Y.encodeStateAsUpdate(ydoc),
// inserted into rack_snapshots so the Hocuspocus relay (and any cold
// /r/[id] load that ends up reading the persisted doc) sees the seeded
// patch state without the test having to drive client-side load.
export interface SeedRackspaceInput {
  ownerUserId: string;
  name: string;
  snapshot?: Uint8Array | null;
  /** Rack shell for the seeded rackspace (default 'dawless') — lets e2e
   *  specs boot a workflow rack without the dashboard/Clerk flow. */
  mode?: RackMode;
}

export async function seedRackspaceForTest(input: SeedRackspaceInput): Promise<Rackspace> {
  const id = generateId();
  const mode = normalizeRackMode(input.mode);
  const rows = (await sql()`
    WITH new_rack AS (
      INSERT INTO racks (id, owner_user_id, name, mode)
      VALUES (${id}, ${input.ownerUserId}, ${input.name}, ${mode})
      RETURNING id, owner_user_id, name, created_at, mode
    ), new_member AS (
      INSERT INTO rack_members (rack_id, user_id, role)
      SELECT id, owner_user_id, 'owner' FROM new_rack
    )
    SELECT id, owner_user_id, name, created_at, mode FROM new_rack
  `) as Array<{
    id: string;
    owner_user_id: string;
    name: string;
    created_at: string;
    mode: string | null;
  }>;
  const row = rows[0];
  if (!row) {
    // Insert failed (id collision is the only realistic case — astronomically
    // unlikely with crypto-random ids but worth a clear error rather than a
    // null-ref downstream).
    throw new Error('seedRackspaceForTest: insert returned no row');
  }
  if (input.snapshot && input.snapshot.length > 0) {
    // Same INSERT…ON CONFLICT shape Hocuspocus's snapshot writer uses; safe
    // to run here because we just created the rack so there's no concurrent
    // writer yet. Cast to Buffer for the Neon driver — Uint8Array works on
    // the wire but bytea binding wants a Buffer-ish at the type level.
    await sql()`
      INSERT INTO rack_snapshots (rack_id, yjs_state, updated_at)
      VALUES (${id}, ${input.snapshot}, now())
      ON CONFLICT (rack_id) DO UPDATE SET yjs_state = EXCLUDED.yjs_state, updated_at = now()
    `;
  }
  return rackFromRow({
    id: row.id,
    owner_user_id: row.owner_user_id,
    name: row.name,
    created_at: row.created_at,
    member_user_ids: [row.owner_user_id],
    mode: row.mode,
  });
}
