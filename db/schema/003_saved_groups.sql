-- db/schema/003_saved_groups.sql
--
-- Saved-group library — per-user "snippets" that capture a group node + its
-- children + internal edges. A logged-in user saves a group from a rack;
-- later they browse their library on the dashboard and re-insert a copy
-- into any rack they're in. The library is scoped strictly by Clerk user
-- id — saved groups are private to the owning user.
--
-- payload shape (JSONB; documented for grep-archaeology):
--   {
--     "label": "MY FILTER STACK",
--     "exposedPorts": [{ id, childId, childPortId, direction, cableType, label? }, ...],
--     "children":     [{ id, type, domain, position, params, data? }, ...],
--     "internalEdges":[{ id, source:{nodeId,portId}, target:{nodeId,portId}, sourceType, targetType }, ...]
--   }
-- All node + edge + port ids inside payload are LOCAL to the saved-group blob;
-- they will be re-minted on insert. Storing the snapshot verbatim keeps the
-- save action a single insert (no need to walk the patch graph at read time)
-- and lets us upgrade the insert/expansion logic without re-saving every
-- existing library row.
--
-- Why JSONB (not a normalized child table): saved groups are write-rare,
-- read-rare, and never mutated server-side after insert. A normalized table
-- would force us to JOIN N+M rows back together on every list / insert.
-- The whole blob is what the user wants to round-trip; JSONB matches that
-- access pattern + lets us add fields (e.g. a 'thumbnail' later) without a
-- schema migration.

CREATE TABLE saved_groups (
  id          text PRIMARY KEY,
  user_id     text NOT NULL,
  label       text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 64),
  payload     jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX saved_groups_user_id_idx ON saved_groups(user_id, created_at DESC);
