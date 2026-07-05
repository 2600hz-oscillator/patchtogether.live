---
name: pr-workflow
description: How PRs work on this repo. Branch protection ruleset, the 2 required status checks (vrt-strict + the umbrella job), merge ordering with strict-up-to-date OFF, the gh pr update-branch silent-drop pattern (never use it).
---

# PR workflow

## Branch protection on `main`

Ruleset id **16042163** ("main: green PRs only") enforces:

- **No direct push** to `main`. PRs only.
- **No force-push**. No deletion.
- **PR is required** — the `pull_request` rule. Zero required approvers
  (single-author repo), but a PR object must exist.
- **2 required status checks** must be SUCCESS (verified against the live
  ruleset — `required_status_checks[].context`):
  1. `typecheck + unit + ART + E2E` — the umbrella CI job
  2. `vrt-strict (visual regression — strict subset)` — the strict VRT subset.
     The full-canvas `VRT (visual regression)` job exists but is **informational**,
     NOT the required context (ci.yml: *"ruleset now gates vrt-strict; full canvas
     vrt is informational"*).
- **strict-up-to-date is OFF.** `strict_required_status_checks_policy` is
  **false** on this ruleset — a PR's base does **not** have to equal current
  `main` to merge, and a merge does **not** auto-invalidate other open PRs'
  bases. (You still rebase to pick up real conflicts — see the conflict-sweep
  discipline in CLAUDE.md — but GitHub won't force it.)

To inspect/edit the ruleset:

```sh
flox activate -- gh api repos/2600hz-oscillator/patchtogether.live/rulesets/16042163
flox activate -- gh api repos/2600hz-oscillator/patchtogether.live/rulesets/16042163 \
  --method PUT --input - <<'JSON'
{ ...full ruleset body... }
JSON
```

## Merge ordering when several PRs are open

Strict-up-to-date is OFF, so merging one PR does NOT auto-invalidate the others'
bases. But concurrent PRs that touch the **same hand-maintained file** (manifest
`DESCRIPTIONS`, VRT exemptions, `modules-card-map.test.ts EXPECTED_NODE_TYPES`,
per-port lists — see `module-development`) will conflict after a merge. The play:

1. Pick the smallest / safest PR and merge it.
2. Run `flox activate -- task pr:conflict-sweep` to find PRs the merge just
   turned conflicting (GitHub recomputes mergeability async, so it polls).
3. For each conflicting PR, rebase it LOCALLY and verify your additions survived:
   ```sh
   flox activate -- git fetch origin && git checkout <branch> && git merge origin/main
   # resolve as union (main + your PR's additions), then:
   flox activate -- git grep <your-symbol>   # confirm YOUR adds are still present
   flox activate -- git push
   ```
4. Repeat.

**NEVER use `gh pr update-branch`** to do step 3 — see the silent-drop hazard
below. Always merge `main` in locally and diff.

## Pipeline depth — keep 2 PRs in CI + 1 staged locally

Do not strictly serialize (open one PR, wait ~25 min for CI, then start the next) — that idles both CI and local build capacity. Because **strict-up-to-date is OFF** (see above), open PRs do not invalidate each other, so run a **3-stage pipeline**: up to **2 PRs open in CI at once**, plus a **third block built + committed locally**, ready to open the instant one of the two open PRs merges. As a PR merges, promote: open the staged local block as the new 2nd PR and start building the next block locally.

- **Independent work** (different modules/areas, no shared-file overlap): branch each block from `main`; the two open PRs run CI in parallel; the third is a committed local branch. On each merge, run `task pr:conflict-sweep` for shared-list collisions.
- **Dependent / sequential work** (block N+1 builds on N AND they touch the same GENERATED files — `contract-lock.txt` / `module-docs.generated.ts` — or both re-attest the WebGL hash): **STACK** them — N+1's branch bases on N's branch, so its CI runs against the stacked base and the generated files + attest compose with no conflict. When N merges to `main`: (1) retarget N+1's base to `main` (`gh pr edit <N+1> --base main`) — a stacked PR's base is its PARENT branch, so merging it while base=parent lands it on the parent (shows MERGED but never reaches `main`); always retarget to `main` first and verify with `git grep` on `origin/main`, never trust `state=MERGED`; (2) `git fetch && git merge origin/main`, resolve, push, merge on green; (3) promote the staged block N+2 to an open PR and start N+3 locally. Do NOT arm auto-merge on a still-stacked PR (base != main).

Cap the pipeline at **2 open + 1 local** — more in flight multiplies the shared-file/attest rebase overhead. Every PR still gets its own final-commit green; never merge on red.

## The `gh pr update-branch` silent-drop pattern

**Important — bit us hard, repeatedly.** When you `gh pr update-branch` on a PR
that's stale and touches a **hand-maintained list file** that other PRs also
appended to, the auto-merge can silently take the PR's version of that file —
dropping entries that `main` added but the PR didn't see. **No conflict marker.**

> **NEVER use `gh pr update-branch` on a PR touching a hand-maintained list
> file.** Always `git fetch origin && git merge origin/main` locally and diff
> that your additions survived. This is a hard CLAUDE.md rule.

Module *registration* is now glob+palette-driven (PR #551), so `index.ts` /
`Canvas.svelte` / `module-categories.ts` / `graph/types.ts` no longer collect
per-module appends and are no longer the conflict surface. The remaining
hand-maintained list files that this hazard applies to are:

- `packages/web/src/lib/docs/module-manifest.ts` (`DESCRIPTIONS`)
- `e2e/vrt/vrt-exemptions.ts` (`EXEMPT_FROM_VRT` / `EXEMPT_BASELINE_PAIRS`)
- `packages/web/src/lib/ui/modules-card-map.test.ts` (`EXPECTED_NODE_TYPES`)
- the per-port spec lists (`e2e/tests/per-module-per-port*.spec.ts`)

CI then fails with mysterious "module not found" / "Received: 0 elements"
errors that look unrelated to your PR.

**Mitigation — always rebase locally and diff your adds survived:**

```sh
flox activate -- git fetch origin && git checkout <branch> && git merge origin/main
# resolve any conflict as a UNION (main's entries + your PR's), then:
flox activate -- git grep <your-module-type>   # confirm YOUR entries are present in each list file
flox activate -- git push
```

If your entry is missing after a merge, the resolution dropped it — re-add it
as union, never let auto-merge pick one side.

## Required checks naming

The required VRT context is `vrt-strict (visual regression — strict subset)`,
NOT the full-canvas `VRT (visual regression)` job (which is informational). A PR
whose checks rollup predates a check rename carries the OLD name and cannot merge
under the current ruleset until it picks up the current job names — which needs a
local `git merge origin/main` rebase that re-runs CI (never `gh pr update-branch`).

## Merging

```sh
flox activate -- gh pr merge <num> --squash --delete-branch
```

Always squash. Always delete the branch. Confirm with:

```sh
flox activate -- gh pr view <num> --json state,mergedAt,mergeCommit \
  -t '{{.state}} at {{.mergedAt}} commit={{.mergeCommit.oid}}'
```

## Don't merge without explicit user OK on big changes

Routine fixes that just need to land: the user is usually happy for you to
merge once green. But for any:
- Architectural refactor
- Multi-module change
- Anything that bumps a schema version
- Anything labeled `feat(*)` of size > a few hundred LOC

Confirm with the user before squash-merge. The user has a pattern of
explicitly saying "land helm" / "get 212 in first" — wait for that signal
on substantial PRs.

## When you can't merge: typical causes

- `mergeStateStatus=BLOCKED` + a FAILURE check → fix CI first.
- `state=BEHIND` → `git fetch origin && git merge origin/main` locally, diff
  that your additions survived, push, re-watch. **NOT `gh pr update-branch`.**
- `state=DIRTY` → real merge conflict; resolve in your worktree, push.
- `state=CLEAN` but merge button is greyed → check branch protection allows
  the merge method (`merge | squash | rebase` are all allowed currently).
