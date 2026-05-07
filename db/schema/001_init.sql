-- db/schema/001_init.sql
-- Initial schema for patchtogether.live persistence (B1).
--
-- Three tables:
--   racks          — one row per rackspace, owned by a Clerk user
--   rack_members   — N rows per rack, lists Clerk user ids that have
--                    joined; the owner is also a member with role='owner'
--   rack_snapshots — one row per rack, the binary Yjs doc state.
--                    Updated debouncedly by Hocuspocus's onStoreDocument.
--
-- Stage A's in-memory rackspaces.ts had the same shape; this is a
-- straight port to durable storage.

CREATE TABLE racks (
  id             text PRIMARY KEY,
  owner_user_id  text NOT NULL,
  name           text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_racks_owner ON racks(owner_user_id);

CREATE TABLE rack_members (
  rack_id    text NOT NULL REFERENCES racks(id) ON DELETE CASCADE,
  user_id    text NOT NULL,
  role       text NOT NULL CHECK (role IN ('owner', 'member')),
  joined_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (rack_id, user_id)
);

CREATE INDEX idx_rack_members_user ON rack_members(user_id);

CREATE TABLE rack_snapshots (
  rack_id     text PRIMARY KEY REFERENCES racks(id) ON DELETE CASCADE,
  yjs_state   bytea NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
