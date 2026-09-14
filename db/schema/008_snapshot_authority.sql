-- Version zero denotes a snapshot written before storage authority was recorded.
-- A non-null r2_key names one immutable object; yjs_state is then empty.
CREATE SEQUENCE IF NOT EXISTS rack_snapshot_generation;
ALTER TABLE rack_snapshots ADD COLUMN IF NOT EXISTS generation bigint NOT NULL DEFAULT 0;
ALTER TABLE rack_snapshots ADD COLUMN IF NOT EXISTS r2_key text;

-- Queue retired objects transactionally with the head change. Retain them for
-- an hour so readers that already fetched the old head can finish safely.
CREATE TABLE IF NOT EXISTS rack_snapshot_garbage (
  object_key text PRIMARY KEY,
  retired_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_snapshot_garbage_retired ON rack_snapshot_garbage(retired_at);
CREATE OR REPLACE FUNCTION retire_snapshot_object() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.r2_key IS NOT NULL AND (TG_OP = 'DELETE' OR OLD.r2_key IS DISTINCT FROM NEW.r2_key) THEN
    INSERT INTO rack_snapshot_garbage(object_key) VALUES (OLD.r2_key) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS retire_snapshot_object ON rack_snapshots;
CREATE TRIGGER retire_snapshot_object AFTER UPDATE OR DELETE ON rack_snapshots
FOR EACH ROW EXECUTE FUNCTION retire_snapshot_object();
