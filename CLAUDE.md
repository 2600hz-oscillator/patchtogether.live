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
