#!/usr/bin/env bash
# scripts/apply-db-schema.sh
#
# Apply EVERY db/schema/*.sql, in filename order, to one database.
#
#   scripts/apply-db-schema.sh "$DATABASE_URL"
#   DATABASE_URL=... scripts/apply-db-schema.sh
#
# WHY THIS EXISTS (the bug it replaces)
# ------------------------------------
# Every CI workflow used to spell its schema apply out by hand:
#
#     psql "$DATABASE_URL" -f db/schema/001_init.sql -f db/schema/005_rackspace_mode.sql
#
# ...at 14 separate sites. `002_feedback.sql`, `003_saved_groups.sql` and
# `004_rack_update_journal.sql` were in NO list, so CI ran every lane against a
# database missing three tables. That is not a loud failure — all three
# consumers DEGRADE on a missing table, by design:
#
#   * journal.ts        catches 42P01, warns ONCE, returns → the relay silently
#                       drops to snapshot-only durability. So the entire
#                       journal/replay durability feature was exercised by
#                       ZERO CI runs while every @collab test passed.
#   * dashboard/+page.server.ts  catches, warns, returns [] → saved-groups
#                       coverage was vacuous: an empty library either way.
#                       (That consumer is GONE — the saved-groups library was
#                       deleted with the GROUP! module. The journal case above
#                       is the live example; this one is kept because the
#                       argument needs BOTH, and it is the clearer of the two.)
#
# A hand-copied list at 14 sites cannot be kept correct; the fix is to stop
# keeping a list. This script reads the DIRECTORY, so a new migration is picked
# up by every lane the moment it lands, with no workflow edit at all.
#
# ON_ERROR_STOP=1 is the second half of the fix. Plain `psql -f a.sql -f b.sql`
# exits 0 even when a file errors — it prints the error, moves on, and the step
# goes green with a half-applied schema. That failure mode was live at all 14
# sites too.
#
# SAFETY: several migrations are destructive on re-apply (002 opens with
# `DROP TABLE IF EXISTS feedback CASCADE` — a documented pre-launch
# drop-and-recreate). That is fine for the ephemeral per-run Postgres service
# containers CI uses, and NOT fine anywhere else. scripts/ci-db-schema.test.ts
# asserts every caller targets a localhost `*_test` database, so pointing one
# of these steps at a real environment fails the unit lane.

set -euo pipefail

url="${1:-${DATABASE_URL:-}}"
if [ -z "$url" ]; then
  echo "apply-db-schema: no database URL (pass one as \$1 or set DATABASE_URL)" >&2
  exit 1
fi

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
shopt -s nullglob
files=("$root"/db/schema/*.sql)

# A glob that matches nothing would make this script a silent no-op — the exact
# "green gate that checked nothing" class this file exists to remove.
if [ ${#files[@]} -eq 0 ]; then
  echo "apply-db-schema: no .sql files found in db/schema/ — refusing to report success" >&2
  exit 1
fi

echo "apply-db-schema: applying ${#files[@]} migration(s)"
for f in "${files[@]}"; do
  echo "  → ${f#"$root"/}"
  psql "$url" -v ON_ERROR_STOP=1 -q -f "$f"
done
echo "apply-db-schema: OK"
