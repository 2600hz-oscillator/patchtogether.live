# Repository standards

## Run NEW tests locally before pushing to CI

When you add new behavior **and** new tests for it, you ALWAYS run **those
specific tests** locally and confirm they pass **before** relying on CI — never
push new code/tests and use CI as the first check that they pass.

- Run the *specific* new test, not just "the suite I happened to touch": a new
  module is auto-enrolled in the registry-driven sweeps (`per-module-per-port`
  handle/emit, `behavioral`, `vrt.spec` per-card), so run those rows for your
  module too — e.g. `flox activate -- npx --workspace e2e playwright test
  per-module-per-port --grep <yourModuleId>` and `… vrt --grep <id>`, plus your
  bespoke spec. Card UI change? run `task vrt` and inspect the diff.
- Run from a **clean** state when the test loads built artifacts (e.g. a DSP
  worklet dist or an ART baseline): `rm -rf packages/dsp/dist` first, because a
  stale local build can mask an ENOENT/SHA failure that only shows up on a fresh
  CI checkout.
- Run `flox activate -- task typecheck` (svelte-check) in addition to vitest —
  vitest is lenient where svelte-check is strict (e.g. import-less worklet
  TS2306), so a test can pass vitest yet fail the typecheck gate.
- This is the cheapest possible feedback loop; a CI cycle here is ~25 min under
  load. Most of our recent red CI (per-port emit, stale SHA pins, missing
  linux-VRT exemptions) was catchable locally with the exact spec for the new
  module.

### Flake-check NEW/changed tests **3×** locally before opening an MR

A single green local run proves pass/fail — it does **not** prove the test is
**stable**. Any test you **add** or **seriously change** must pass **3× in a row
locally with no flakes** before you push it for CI. (Scope this to the new/changed
test — you do **not** run the whole suite 3×.) Use the `REPEAT` env var on the
`*:one` targets (see next section):

```sh
REPEAT=3 flox activate -- task test:one -- my-new-thing      # unit (loops vitest 3×)
REPEAT=3 flox activate -- task art:one  -- my-scenario       # ART
REPEAT=3 flox activate -- task e2e:one  -- my-spec           # e2e (--repeat-each=3)
REPEAT=3 flox activate -- task vrt:one  -- my-card           # VRT
```

The run **fails on the first failing iteration**, so a flake can't hide behind a
later green run. If it flakes locally, fix the flake (diagnose run-bug vs.
test-bug — never just re-run) *before* the MR. A flake that only reproduces under
CI load (e.g. a `@collab` relay-contention timeout) still gets root-caused, not
tolerated — see the `feedback_no_flake_tolerance` discipline.

## Running ONE test locally (fast dev loop)

Dedicated `*:one` targets run a SINGLE test without the full suite, and a
long-lived server lets you iterate e2e/VRT specs without re-booting it each run.
All run through `flox activate -- …`. Prefix any of them with `REPEAT=3` to run
the test 3× and bail on the first failure — the pre-MR flake-check (above).

**Unit / vitest — `task test:one`** (defaults to the web package; `PKG=dsp|server|art`):

```sh
flox activate -- task test:one -- src/lib/ui/canvas/organize.test.ts   # one file
flox activate -- task test:one -- organize -t "deterministic"          # file + name filter
flox activate -- task test:one PKG=dsp -- cube                         # another workspace (PKG before --)
```

**E2E / Playwright — boot the server ONCE, then run single specs against it:**

```sh
flox activate -- task e2e:serve                       # start the dev server (port 5173) + leave it up
flox activate -- task e2e:one -- tests/ai-smoke.spec.ts   # a spec file
flox activate -- task e2e:one -- "title is patchtogether"  # a bare word/phrase → --grep ONE test
HEADED=1 flox activate -- task e2e:one -- tests/audio-gate.spec.ts   # watch it
flox activate -- task e2e:stop                        # tear down (don't leak dev-servers)
```

`e2e:one` runs 1 worker + line reporter and **fails fast** with a hint if the
server isn't up. It reuses the warm server via Playwright's `reuseExistingServer`
(`E2E_SKIP_WEBSERVER=1`), so steady-state single-test iteration is ~1.5s of test
time vs ~4s when each run boots its own server — and SvelteKit's on-demand route
compilation stays warm across runs. Add `E2E_PREVIEW=1` to serve/target the prod
`vite preview` build (port 4173) instead of dev. `task e2e:status` shows whether
the server is up.

**One VRT scene — `task vrt:one`** (reuses the same dev server if up):

```sh
flox activate -- task vrt:one -- adsr        # one card by grep
HEADED=1 flox activate -- task vrt:one -- scope
```

**One ART scenario — `task art:one`**:

```sh
flox activate -- task art:one -- moog911                          # by name
flox activate -- task art:one -- scenarios/meowbox/meow-c4.test.ts   # by path
```

**Fresh worktree without Faust?** The `*:one` audio targets depend on
`task dsp:ensure`, which reuses a current `packages/dsp/dist`, else builds with
Faust if available, else copies a prebuilt dist from the primary checkout
(`task dsp:fetch-dist`). So single-test runs don't fail on a missing DSP bundle
even before `@grame/faustwasm`/the Faust CLI is set up. (CI is unaffected — it
always compiles via the dedicated `dsp-build` job.)

> Note: the clean-state advice above (`rm -rf packages/dsp/dist`) still applies
> when you specifically want to catch a stale-artifact / SHA failure — run a real
> `task dsp:build` after, not `dsp:fetch-dist`, so you're testing this worktree's
> actual sources.

## Worktrees: hard cap of 10

This repo accumulates abandoned `isolation: worktree` agent checkouts fast — each
carries a dead lock plus its own `node_modules`, and they bury the few worktrees
actually in flight. **Never keep more than 10 git worktrees.**

Before creating a new worktree (`git worktree add`, or spawning an agent with
`isolation: "worktree"`):

1. Run `flox activate -- task worktree:guard`.
2. It prunes gone worktrees and removes **abandoned** ones — dead agent-lock
   process **and** a clean tree **and** fully pushed (nothing exists only on
   disk, so no work is lost) — then re-counts.
3. If it's still over 10, it **exits non-zero** and lists the worktrees that
   need a human: dirty trees, unpushed commits, no upstream to verify against,
   plus any genuinely live agents. **Stop and resolve those** — push / commit /
   discard, then `git worktree remove <path>` — or set `WORKTREE_CAP=N` for a
   deliberate one-off, before creating another worktree.

Other entry points:
- `flox activate -- task worktree:list` — classify everything, change nothing.
- `flox activate -- task worktree:clean` — auto-remove abandoned ones only.

Tooling: `scripts/worktree-guard.sh` (`report` | `clean` | `enforce [N]`).

## Post-merge conflict sweep

Many PRs are in flight at once and they touch shared registry files
(`modules/index.ts`, `Canvas.svelte`, `module-categories.ts`, `types.ts`,
the per-port/VRT specs). **Whenever a PR merges to main, look ahead: sweep the
other open PRs for conflicts the merge just created, and rebase them** before
they rot into `CONFLICTING` (which silently blocks them from shipping).

1. After a merge, run `flox activate -- task pr:conflict-sweep` (GitHub
   recomputes mergeability async, so it polls). It lists the open PRs that now
   conflict with main.
2. Rebase each: `git fetch origin && git checkout <branch> && git merge
   origin/main`, resolve, then **verify your additions survived** (e.g.
   `git grep <your-symbol>`), and push.

**Never use `gh pr update-branch`** on PRs touching the shared registry files —
it silently drops the PR's additions when auto-merge picks main's version of a
conflict, with no marker. Always `git merge origin/main` locally and diff.

## Standard/skill updates land with in-flight work

When a new repository standard or convention is introduced mid-development,
fold it into whatever PR is already in flight (e.g. this file + its tooling) —
don't spin up a separate ceremony PR for it. Fewer in-flight PRs = fewer of the
shared-file conflicts the sweep above exists to catch.

## Commands run through flox

Every command (git, gh, task, npm, node, …) runs inside the Flox env:
`flox activate -- <cmd>`. Running git outside flox can make git-LFS operations
hang.
