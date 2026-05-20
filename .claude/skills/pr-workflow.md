---
name: pr-workflow
description: How PRs work on this repo. Branch protection ruleset, required status checks, strict-up-to-date, merge ordering, the auto-merge silent-drop pattern.
---

# PR workflow

## Branch protection on `main`

Ruleset id **16042163** ("main: green PRs only") enforces:

- **No direct push** to `main`. PRs only.
- **No force-push**. No deletion.
- **PR is required** — the `pull_request` rule. Zero required approvers
  (single-author repo), but a PR object must exist.
- **2 required status checks** must be SUCCESS:
  1. `typecheck + unit + ART + E2E` — the main CI job
  2. `VRT (visual regression)` — the visual regression job
- **strict-up-to-date** — the PR's base SHA must equal current `main`. Every
  merge invalidates other open PRs' bases.

To inspect/edit the ruleset:

```sh
flox activate -- gh api repos/2600hz-oscillator/patchtogether.live/rulesets/16042163
flox activate -- gh api repos/2600hz-oscillator/patchtogether.live/rulesets/16042163 \
  --method PUT --input - <<'JSON'
{ ...full ruleset body... }
JSON
```

## The strict-up-to-date consequence: merge ordering

When several PRs are open, every merge invalidates the rest. Standard play:

1. Pick the smallest / safest PR.
2. Merge it.
3. `gh pr update-branch <other-pr>` on each remaining PR — this triggers a
   merge of `main` into the PR branch.
4. Watch CI on each rebased PR.
5. Pick the next-smallest, repeat.

If many PRs are open, this can take hours of CI-cycle waiting; budget
accordingly.

## The `gh pr update-branch` silent-drop pattern

**Important — bit us hard during phase 1.** When you `gh pr update-branch` on
a PR that's many commits stale and touches **shared registry files**
(`audio/modules/index.ts`, `Canvas.svelte`, `module-categories.ts`,
`graph/types.ts`, `vrt-meta.test.ts`, `cv-scale-registry.test.ts`), the
auto-merge can silently take the PR's version of those files — dropping
entries that `main` added but the PR didn't see. No conflict marker.

CI then fails with mysterious "module not found" / "Received: 0 elements"
errors that look unrelated to your PR.

**Mitigation after any update-branch on a multi-PR-stale branch:**

```sh
flox activate -- bash -c '
for f in packages/web/src/lib/audio/modules/index.ts \
         packages/web/src/lib/ui/Canvas.svelte \
         packages/web/src/lib/ui/module-categories.ts \
         packages/web/src/lib/graph/types.ts \
         packages/web/src/lib/audio/modules/vrt-meta.test.ts \
         packages/web/src/lib/audio/cv-scale-registry.test.ts; do
  echo "=== $f ==="
  echo -n "main: "; gh api repos/2600hz-oscillator/patchtogether.live/contents/${f}?ref=main \
    --jq ".content" | base64 -d | grep -cE "registerModule\\(" 2>/dev/null
  echo -n "this branch: "; gh api repos/2600hz-oscillator/patchtogether.live/contents/${f}?ref=<branch> \
    --jq ".content" | base64 -d | grep -cE "registerModule\\(" 2>/dev/null
done
'
```

If counts mismatch in favor of `main`, the update silently dropped content.
Fix: do a real `git merge origin/main` in a fresh shallow clone, resolve as
union (`main` plus your PR's additions), push.

## Required checks naming

The renamed job (`VRT (visual regression)`, formerly `VRT (visual regression,
advisory)`) means any PR opened BEFORE the rename has the old name in its
checks rollup. Those PRs cannot merge under the new ruleset until they pick
up the new job name — which requires a rebase that re-runs CI.

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
- `state=BEHIND` → `gh pr update-branch` then re-watch.
- `state=DIRTY` → real merge conflict; resolve in your worktree, push.
- `state=CLEAN` but merge button is greyed → check branch protection allows
  the merge method (`merge | squash | rebase` are all allowed currently).
