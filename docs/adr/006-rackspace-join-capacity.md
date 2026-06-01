# ADR-006: Capacity + auth gate ordering for rackspace joins

- Status: Accepted (with known race)
- Date: 2026-05-30
- Deciders: project owner
- Tags: multiplayer, auth, persistence

## Context

A rackspace allows up to **4 simultaneous members** (owner + 3 others —
see Memory `multiuser-constraints`). Membership can be acquired two
ways:

1. The owner explicitly invites a Clerk-authed user.
2. Anyone with the invite link joins, possibly anonymously (`anon:`
   role).

Server-side, the join request needs to atomically (a) confirm the
rackspace exists, (b) check the user isn't already a member, (c)
verify capacity is below `MAX_MEMBERS = 4`, and (d) insert the
membership row.

The textbook-correct approach is a row-locked transaction
(`SELECT ... FOR UPDATE` or `pg_advisory_xact_lock`). In practice
under our constraints (4-user cap; observed concurrency: 1 user
clicking once), the failure mode of skipping the lock is bounded:
worst case is two simultaneous joins on the last slot both succeeding,
ending the rackspace at 5 members instead of 4. No data loss; no
security boundary crossed; only the soft cap is breached. The "blast
radius" is trivial.

## Decision

`joinRackspace(rackspaceId, userId)` in
`packages/web/src/lib/server/rackspaces.ts:259` runs as a **single
CTE** that:

1. `WITH rack AS (...)` — load rack metadata.
2. `existing AS (...)` — list current members.
3. `counts AS (SELECT COUNT(*) FROM existing)` — count them.
4. `INSERT INTO rack_members ... SELECT ... WHERE counts.n < MAX_MEMBERS`
   — conditionally insert only if capacity is below cap and the user
   isn't already a member.

The CTE runs in one statement so the read side (counts) and the write
side (INSERT) see a consistent snapshot **within** that statement, but
**not across two concurrent statements** — there's no row lock.

Auth (does the caller have a valid token at all?) runs at the
Hocuspocus handshake in `packages/server/src/auth.ts`, BEFORE the
join CTE. Two valid token forms:

- `clerk:<JWT>` — verified via `@clerk/backend.verifyToken`.
- `anon:<16hex>` — HMAC-verified against the documentName.

**Auth runs before capacity check.** The capacity check assumes the
caller is authenticated; an unauthenticated WS handshake never reaches
the join CTE.

**Membership check** (does *this* user belong to *this* rack?) is NOT
performed at the Hocuspocus handshake — authed users can WS-connect to
any rack id they happen to know. The gate is the HTTP `/r/[id]` route
loader, which does the membership lookup against `rack_members`. This
gap is documented and is post-Stage-B work
(`packages/server/src/auth.ts:9-15`).

## Consequences

**Good:**

- One round-trip to Postgres per join (a single CTE) — fast and
  predictable.
- The 4-user cap keeps the worst-case race-breach to at most 5
  members in one rack, which is harmless.
- Anonymous-via-invite-link flows work with no per-user
  pre-registration.

**Bad / load-bearing:**

- **There is a known race window** between the `counts.n` evaluation
  and the `INSERT`. Two simultaneous joins on slot 4 can both
  succeed. Accepted for v1 (Codex audit P2). Upgrade path:
  `pg_advisory_xact_lock(rack_id_hash)` around the CTE. See Codex
  audit finding #4 + the open task #4 in the audit tracker.
- **Auth-at-handshake does NOT enforce membership.** An authed user
  who scrapes a rack id can WS-connect to it. The Hocuspocus session
  is otherwise harmless (they'd see live edits but can't load the
  page without the HTTP membership check), but this is a leak of
  current-edit metadata. Closing it requires shared rackspace
  storage at the auth layer; tracked as post-Stage-B work
  (`packages/server/src/auth.ts:9-15`).
- **The CTE returns `inserted: boolean`** so callers can distinguish
  "joined" from "already a member" from "rack at capacity" — but it
  conflates "rack doesn't exist" with "capacity exceeded" in the
  `inserted: false` branch. Callers that need to surface a precise
  error to the user should fetch the rack separately first.
- **MAX_MEMBERS lives in code** (`rackspaces.ts:21`), not in the
  rack row. Raising the cap per-rack (e.g. for a premium tier)
  requires a schema change first.

## References

- `packages/web/src/lib/server/rackspaces.ts:259-326` — `joinRackspace`
  CTE.
- `packages/web/src/lib/server/rackspaces.ts:21` — `MAX_MEMBERS = 4`.
- `packages/web/src/lib/server/rackspaces.ts:327` —
  `RACKSPACE_MAX_MEMBERS` export.
- `packages/server/src/auth.ts:1-30` — Hocuspocus handshake auth.
- Memory `multiuser-constraints` — 4-user-per-rack rule.
- Codex audit finding #4 — race + remediation suggestion.
- ADR-002 — per-rackspace Y.Doc lifecycle (the doc each member binds
  to once joined).
