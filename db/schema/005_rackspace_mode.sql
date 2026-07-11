-- db/schema/005_rackspace_mode.sql
-- WORKFLOW MODE P1: per-rackspace mode flag.
--
-- `mode` distinguishes the two rack shells:
--   'dawless'  — the existing rack UI (default; every pre-migration row
--                backfills to this via the column DEFAULT, so old racks
--                keep rendering exactly what they always did)
--   'workflow' — the workflow shell (WorkflowTopbar + left rail + pinned
--                M/E/C drawer singletons; see
--                .myrobots/plans/workflow-mode-2026-07-10.md)
--
-- Idempotent (IF NOT EXISTS) — the collab-attest local recipe auto-applies
-- every db/schema/*.sql, so re-running against an already-migrated DB must
-- be a no-op. Additive column only; no data rewrite.

ALTER TABLE racks
  ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'dawless'
    CHECK (mode IN ('dawless', 'workflow'));
