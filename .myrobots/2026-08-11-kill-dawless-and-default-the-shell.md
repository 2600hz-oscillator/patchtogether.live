# Kill dawless mode — SHIPPED #1459. One thing is still outstanding: PROD.

The plan this file used to carry is **done**. `dawless` no longer exists as a
concept: no `mode` column read by any code path, no `RackMode` type, no
`normalizeRackMode`, no Y.Doc `rackMeta` mode mirror. The faceplate shell renders
with no querystring; `?shell=legacy` is the escape hatch. The remaining textual
hits in the tree are historical comments plus the deliberate legacy-key cleanup
in `local-scratch.ts`.

Everything below is what did NOT ship, and it is a live liability.

---

## ⚠ PROD STILL CARRIES `mode='dawless'` ROWS AGAINST CODE THAT NO LONGER KNOWS THE CONCEPT

Owner ruling 2026-08-11, verbatim:

> *"prod deploys on version bump only … we're not going to do that until all the
> faces are done and this is all more tested."*

So #1459 touched **dev and autotest only**. Prod was deliberately not migrated,
not reset and not deployed to. Two things are therefore still pending on prod,
and **neither has been tested against real rows**:

1. **Migration `006_drop_rackspace_mode.sql` has never run on prod.** The column
   is still there, still `NOT NULL DEFAULT 'dawless'`, still carrying the
   `CHECK (mode IN ('dawless','workflow'))` constraint from 005.
2. **`DELETE FROM racks` (the owner-authorised clean reset) was never performed
   on prod.** Every saved prod rackspace still has `mode='dawless'` in a column
   nothing reads.

**Why this is safe today and why it is still a risk.** The two halves are
independent by construction: code that never selects `mode` does not care
whether the column exists, and a database that still has the column is inert to
code that ignores it. That is the argument 006's own header makes, and it is
correct. The risk is not the column — it is that **the deferral is untested**:
no prod-shaped row has been through the current code, and the assumption "an
unused column is inert" has not been exercised against a real prod dataset.

**Mechanics for the deferred step, so they are not re-derived.** Neon topology is
branch-per-tier, one project (`twilight-tree-01652938`), key in `../neon.txt`
(SECRET — never echo it or a derived connection string). dev and autotest writes
pass the auto classifier; **PROD writes are refused by it regardless of
credentials**, so prod is run by the owner via a `!`-prefixed one-liner, exactly
as migration 005 was. New keys are NOT needed.

⚠ Note 006 is deliberately **non-destructive to rows** — the wipe is NOT written
into it, because `apply-db-schema.sh` re-applies every `db/schema/*.sql` on every
schema apply and a `DELETE FROM racks` living in that file would silently wipe a
tier again on the next unrelated migration. The column drop is the part that is
safe to repeat; the wipe is not, and stays a one-off operational step.
