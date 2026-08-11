# Kill dawless mode; make the new shell the default

**Owner directive, 2026-08-11, verbatim:**

> *"lets complete our 'remove dawless mode entirely and then drop the name for
> `workflow mode` because its now our only mode' work which we scoped out. also
> as part of this we're going to make the new shell default, doesn't need a
> querystring param, and we're going to lock the old workflow ui under
> `&shell=legacy`"*
>
> *"we can destroy all saved rackspaces in this migration, it's fine. in fact we
> should do that for a clean reset"*

This file is EVIDENCE. Verify every claim against the tree before relying on it.

---

## The three-state mess this collapses

Today there are effectively **three** UI states, and two different flags select
them:

| state | selected by |
|---|---|
| dawless rack UI | `racks.mode = 'dawless'` (the DB default) |
| workflow shell, legacy cards | `mode = 'workflow'` + no `?shell=1` |
| workflow shell, new faceplates | `mode = 'workflow'` + `?shell=1` |

`Canvas.svelte:522` — `shellPreview = workflowMode && shell === '1'`.

**After this work there are two, selected by one flag:**

| state | selected by |
|---|---|
| the shell with faceplates | **default** — nothing |
| the shell with legacy cards | `?shell=legacy` |

`dawless` ceases to exist as a concept: no mode column, no `RackMode` type, no
`normalizeRackMode`, no Y.Doc `rackMeta` mode mirror, and **the word "workflow"
stops being a distinguishing name** because there is nothing to distinguish it
from. Renaming is part of the job, not a follow-up.

## Measured surface (at `75ec196e`)

- **63 files** mention `dawless` — 43 `packages/web`, 16 `e2e`, 1 `scripts`,
  1 `db/schema`, 2 `.myrobots`.
- Densest: `Canvas.svelte` (30), `local-scratch.test.ts` (36),
  `patch-mode.ts`+test (40), `rackspaces.ts`+tests (33), `rack-mode.ts`+test (18),
  `WorkflowTopbar.svelte` (10), `dashboard/+page.svelte` (8).
- `db/schema/005_rackspace_mode.sql` adds
  `racks.mode text NOT NULL DEFAULT 'dawless' CHECK (mode IN ('dawless','workflow'))`.
- `rack-mode.ts` also owns a **Y.Doc `rackMeta` mirror** written under a
  non-tracked origin (`RACK_MODE_ORIGIN`) so it stays off the undo stack. That
  mirror goes too.

## The clean reset

The owner has authorised **destroying all saved rackspaces**, which removes the
hard part: no backfill, no CHECK-constraint rewrite, no compatibility window for
rows that say `'dawless'`. Migration `006` can simply drop the column after the
table is cleared.

⚠ **PROD IS OUT OF SCOPE. Owner ruling 2026-08-11:** *"prod deploys on version
bump only … we're not going to do that until all the faces are done and this is
all more tested."*

So this PR touches **dev and autotest only**. The production branch is not
migrated, not reset, and not deployed to. That is a deliberate deferral, not an
oversight — record it as such in the PR body.

The sequencing works because the two halves are independent: dropping the
`mode` column from the CODE is safe against a prod DB that still HAS the column
(an unused column is inert). Prod's migration 006 + `DELETE FROM racks` happen
at version-bump time, once the faces are done and this has soaked.

Mechanics for that later step, so they are not re-derived: the Neon topology is
branch-per-tier, one project (`twilight-tree-01652938`), key in `../neon.txt`
(SECRET — never echo it or a derived connection string). dev and autotest writes
pass the auto classifier; **PROD writes are refused by it regardless of
credentials**, so prod is run by the owner via a `!`-prefixed one-liner, exactly
as migration 005 was. New keys are NOT needed.

⚠ `local-scratch.ts` also persists mode CLIENT-side. A browser holding a stale
scratch entry must not resurrect a dead mode — handle it, and prove it with a
test that feeds the old shape in.

## Definition of done

1. `dawless` appears nowhere in the tree (outside `.myrobots` history).
2. One mode; the `RackMode` type, normalizer, DB column and Y.Doc mirror are gone.
3. The faceplate shell renders with **no querystring**.
4. `?shell=legacy` renders the old workflow UI (legacy cards) — this is the
   `legacy-fallback.ts:108` predicate inverted: today it is
   `if (!i.workflowMode || !i.shellPreview || !i.hasCard) return 'legacy'`.
5. "workflow mode" is renamed out wherever the name only existed to contrast
   with dawless. Keep `workflow` where it names the shell's own components
   (`WorkflowTopbar`, `ui/workflow/*`) unless the rename is cheap and total —
   a half-done rename is worse than none.
6. All rackspaces destroyed on the tiers you can reach; PROD flagged for the owner.
7. Every gate green, and **the VRT baselines re-pinned deliberately** — this
   changes what the default page renders, so a large baseline movement is
   EXPECTED. Review a sample rather than accepting blind; state how many you
   looked at.

## Watch for

- **This is the biggest look change of the effort** — the default UI changes for
  every user. It is not a face MR and does **not** self-merge.
- The VRT single-baseline collapse (#1458) just landed. There is now ONE
  platform-less baseline set of 307. Do not reintroduce a `{platform}` path.
- **Never introduce a hand-typed population count** (installed as `9a8016d7`).
- `?shell=1` may be hard-coded in e2e specs, VRT scene helpers and docs. Grep for
  it as carefully as for `dawless`; a spec that still asks for `shell=1` will
  silently test the wrong thing rather than fail.
