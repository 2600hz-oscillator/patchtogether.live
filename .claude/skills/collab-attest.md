# Running the @collab attestation (`task collab:attest`)

The collab attest is the multiplayer analogue of [webgl-attest](webgl-attest.md):
a **local, real-relay + real-Postgres** gate. It boots a **fresh, dedicated
Hocuspocus relay + requires a real Postgres**, runs the `@collab`/`@capacity`
Playwright specs at **`retries=0`**, and — only on a fully-green run with **zero
relay/sync-vacuity skips** — writes `ci-collab-attest/<hash>.json`. **CI runs only
the cheap CHECK** (`collab-attest-verify.sh`, no DB/relay) — it recomputes the
content-hash and confirms a matching committed json exists. So a committed,
matching json = the `collab-attest` gate is green on CI.

`collab-attest` is currently a **non-required** gate (required = `typecheck + unit
+ ART + E2E` and `vrt-strict`). **But a red `collab-attest` ON MAIN is still a
P0** — don't merge a basis change into a collab-red main. Re-attest instead.

## When to re-attest — the basis

Re-attest whenever you touch a **collab-basis** file. The basis
(`scripts/collab-attest-lib.ts`; `**/*.test.ts` EXCLUDED):

- **Whole dirs:** `packages/server/src` (the relay backend — Hocuspocus, auth,
  capacity/slots, snapshot persistence, reaper, heartbeat), `packages/web/src/lib/multiplayer`.
- **Individual files:** `graph/store.ts`, **`graph/persistence.ts`**,
  `graph/snapshot.ts`, `graph/mutate.ts`, `graph/duplicate.ts`, and the DOOM sync
  layer `doom/doom-{netcode,lockstep,roster,presence,session,host-authority,awareness-signature,gating,player-identity}.ts`
  (NON-sync DOOM files — runtime/keys/sprites/cheats — are intentionally NOT in the basis).
- **Helpers + schema:** `e2e/tests/_{collab-helpers,helpers,drivers,registry}.ts`,
  `e2e/playwright.config.ts`, `db/schema/001_init.sql`, `db/schema/003_saved_groups.sql`.
- **Toolchain pins (narrowed):** `packages/{server,web}/package.json` + `e2e/package.json`
  (only the collab-relevant deps — yjs / pg / @hocuspocus/* / @playwright/test — via
  `COLLAB_DEP_ALLOW`, NOT the whole file), `.flox/env/manifest.toml` (wholesale).

> **`graph/persistence.ts` is the one that bites schema/cleanup work** — any patch
> touching the load/save path reds collab-attest. The video-domain deps are
> deliberately NOT in the basis (the narrowed package.json digest exists so a
> *video* dep bump like butterchurn can't drift the collab hash — task #160).
> `scripts/` is NOT in the basis (editing the runner is hash-free).

## Provisioning a local Postgres (the part that's NOT automatic)

`task collab:attest` **boots the relay itself but does NOT provision Postgres** —
it *asserts* `$DATABASE_URL` is set + reachable and refuses otherwise (the @collab
lane is VACUOUS without a DB). **No Postgres runs by default on this machine and
`DATABASE_URL` is empty at rest.** The flox env ships the `postgresql` package
(`postgres`/`pg_ctl`/`initdb`/`psql`/`createdb`), so stand up an ephemeral one:

```sh
PGDATA="$SCRATCH/pgdata"          # a LONG path is fine for the DATA dir
SOCK=/tmp/ptpg                    # the SOCKET dir MUST be short (see gotcha)
mkdir -p "$SOCK"
flox activate -- initdb -U postgres -A trust -D "$PGDATA"
flox activate -- pg_ctl -D "$PGDATA" \
  -o "-p 5432 -k $SOCK -c listen_addresses=127.0.0.1" -l "$SCRATCH/pg.log" -w start
flox activate -- createdb -h 127.0.0.1 -p 5432 -U postgres patchtogether_test
for f in db/schema/*.sql; do
  flox activate -- psql "postgresql://postgres:postgres@127.0.0.1:5432/patchtogether_test" -f "$f"
done
export DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:5432/patchtogether_test"
# stop it after: flox activate -- pg_ctl -D "$PGDATA" stop
```

- **GOTCHA — Unix-socket path ≤ 103 bytes.** Postgres **FATALs at boot** if the
  socket dir makes `<dir>/.s.PGSQL.5432` exceed 103 bytes — the session scratchpad
  path is far too long. It still binds TCP first, so the log shows `listening on
  127.0.0.1` then `could not create any Unix-domain sockets → FATAL`. Point `-k`
  at a SHORT dir (`/tmp/ptpg`) and connect over **TCP** (`host=127.0.0.1`, the
  `DATABASE_URL` above). The data dir path length doesn't matter.
- Trust auth (`-A trust`) means the `:postgres` password in the URL is ignored —
  fine for a throwaway local cluster. The runner also (re)applies `001_init.sql`
  itself; applying all `db/schema/*.sql` up front covers `saved_groups` too.
- The port must be free (default 5432; nothing dev-critical uses it — but note
  BitwigStudio reserves 1234, so we never bind there).

## The procedure

```sh
# 0. quiet machine (heavy multi-context Playwright — run when otherwise idle;
#    do NOT run while the owner's live audio session (Bitwig) needs the CPU
#    unless they've OK'd it). On the rebased branch (treadmill, below). Deps present.
export DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:5432/patchtogether_test"

# 1. dry-run FIRST — verifies DB reachable + relay/skip-classify/writer wiring, fast:
flox activate -- task collab:attest -- --dry-run   # prints the content hash; no long run

# 2. the real run — boots a fresh relay, runs @collab/@capacity at retries=0:
flox activate -- task collab:attest                # ~a few min; writes ci-collab-attest/<hash>.json only on FULL green

# 3. commit the json + push (json only), then merge:
flox activate -- git add ci-collab-attest/<hash>.json
flox activate -- git commit -m "ci(collab): re-attest @collab for <what changed>"
flox activate -- git push origin <branch>

# CI-side (cheap, no DB): task collab:attest:verify. Local read-only check: task collab:attest:check.
```

## Refusal with `0 specs ran` = the app server never came up (env, not tests)

`Timed out waiting 120000ms from config.webServer` + `spec files: 0` means the
attest's **vite preview build+serve** didn't reach its port inside 120s — the
runner refuses (correctly: a run with 0 specs proves nothing). Two observed causes:

- **A leaked server squatting port 4173** — the attest serves the preview build
  on 4173; if an old `E2E_PREVIEW=1 task e2e:serve` is still alive, vite prints
  `Port 4173 is in use, trying another one...` and binds elsewhere while
  Playwright waits on 4173 forever. **Removing a worktree does NOT kill servers
  started from it.** Check `lsof -iTCP:4173 -sTCP:LISTEN` (and 5173) before
  attesting; kill worktree-owned squatters; always `task e2e:stop` in every
  worktree you served from.
- **Machine load** — the full vite build (~30s quiet) can blow the window when
  other agents/builds are churning. Attest on a quiet machine (same discipline
  as webgl RULE 2).

## Rules

1. **`retries=0` + relay-vacuity-skip = HARD FAILURE.** A `test.skip(true,'…relay
   flake / sync did not reach / roster sync…')` firing locally means the run
   proved NOTHING about multiplayer, so the runner refuses to write. A green run
   is only trusted with **zero** such skips + DB + relay confirmed. Do NOT re-run
   to paper over a skip — root-cause it (this is the no-flake-tolerance discipline).
2. **Re-attest is the LAST step, on the rebased branch (treadmill).** Two PRs that
   both touch the collab basis can't both be attested independently — whoever
   merges second invalidates the first's hash. Rebase onto the CURRENT target main
   FIRST, then attest, then commit+push+merge. (Same rule as the WebGL treadmill.)
3. **Flake-check `REPEAT=3`** for a new/changed @collab spec: `REPEAT=3 flox
   activate -- task collab:attest`.
4. **Never `gh run view <run> --log-failed`** (wedges the shell) — read committed
   per-job annotations or the downloaded `playwright-test-results-*` artifact.

## Gotchas

- **`@collab`/`@capacity` in ANY e2e spec — even in a COMMENT — pulls it into the
  basis** (`resolveCollabSpecs` greps content). Write a bare `collab` without the
  `@` in prose to avoid dragging a spec in. (See memory `collab-basis-tag-grep-footgun`.)
- Docs authoring must NOT churn the collab (or webgl) hash — audio defs aren't in
  the basis; wrap any docs-only edit to a basis file in `// docs-hash-ignore:start
  … :end` (see [module-docs](module-docs.md)).
- If the dry-run prints a hash but you expected a match to main, a stray edit to a
  basis file (or a sync-layer revert) moved it — `git status` the basis paths.
- Related memories: `collab-attest-persistence-basis-gates-cleanup` (persistence.ts
  gates cleanup PRs), `collab-attest-main-undrifted-1004`, `relay-single-process-and-drift`.
