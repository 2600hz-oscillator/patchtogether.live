-- db/schema/002_feedback.sql
-- User feedback (suggestion or bug) captured from the in-app Feedback box.
--
-- The Feedback button lives in the rack bar (and the dashboard); each
-- submission stores the message body, the user's Clerk id, the rack
-- the submission came from (NULL for dashboard submissions), the kind
-- (suggestion/bug — required), and an optional patch_json snapshot
-- captured at submit time so we can reproduce what the user was
-- looking at when they hit submit.
--
-- The column stays named `suggestion` even when kind='bug' — it's the
-- message body either way; the `kind` column qualifies it.
--
-- Pre-launch migration: an earlier draft of this table (without `kind`)
-- was applied to dev/autotest/prod with zero rows. We drop and recreate
-- so all three tiers converge on the final schema. README's stated
-- policy: down migrations are out of scope during beta — we drop and
-- recreate during pre-launch. Re-applying this file is a no-op against
-- the canonical schema (DROP IF EXISTS, then CREATE).

DROP TABLE IF EXISTS feedback CASCADE;

CREATE TABLE feedback (
  id            bigserial PRIMARY KEY,
  user_id       text NOT NULL,
  rack_id       text REFERENCES racks(id) ON DELETE SET NULL,
  kind          text NOT NULL CHECK (kind IN ('suggestion', 'bug')),
  suggestion    text NOT NULL CHECK (char_length(suggestion) <= 512),
  patch_json    jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX feedback_created_at_idx ON feedback(created_at DESC);
CREATE INDEX feedback_user_id_idx ON feedback(user_id);
CREATE INDEX feedback_kind_idx ON feedback(kind);
