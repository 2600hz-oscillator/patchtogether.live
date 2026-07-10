-- 004_rack_update_journal.sql
--
-- Append-style per-update journal for the relay (crash durability between
-- snapshot debounces).
--
-- The relay persists full doc snapshots on a 2s/5s debounce
-- (packages/server/src/snapshot-config.ts). A relay crash (OOM, kill -9,
-- Fly host failure) between debounces loses up to 5s of edits — and a
-- persist FAILURE window loses everything since the last successful
-- snapshot. This journal closes that: every incremental Yjs update is
-- appended as it arrives (packages/server/src/journal.ts), and on doc load
-- the relay replays journal rows on top of the snapshot (Y.applyUpdate is
-- idempotent, so replaying rows the snapshot already contains is safe).
--
-- Growth is bounded by COMPACTION: after every SUCCESSFUL snapshot store,
-- rows with seq <= the pre-encode watermark are deleted (their content is
-- inside the snapshot by construction). Steady-state size ≈ one debounce
-- window of updates per active rack; it only grows while snapshot writes
-- are failing — which is exactly when we need it.
--
-- yjs_update (not "update"): UPDATE is a reserved word in Postgres.
-- FK CASCADE mirrors rack_snapshots: deleting a rack cleans its journal.
-- Relay writes for ephemeral test racks (no racks row) are skipped via the
-- same 23503-swallow pattern storeSnapshot uses.

CREATE TABLE rack_update_journal (
  seq         bigserial PRIMARY KEY,
  rack_id     text NOT NULL REFERENCES racks(id) ON DELETE CASCADE,
  yjs_update  bytea NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Load path is "all rows for one rack, in seq order"; compaction is
-- "delete rows for one rack up to a seq" — both served by this index.
CREATE INDEX idx_rack_update_journal_rack_seq ON rack_update_journal(rack_id, seq);
