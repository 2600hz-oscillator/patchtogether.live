---
name: git-workflow
description: Git practices, LFS gotchas, the local pack-file corruption pattern, and the REST-API push workaround when the local repo is too broken to push.
---

# Git workflow

## The basics

- Commits run through `flox activate -- git` (so flox-installed `git-lfs` is
  on PATH — see `flox-environment` skill).
- Conventional commits: `feat(scope): …`, `fix(scope): …`, `chore(scope): …`,
  `ci(scope): …`. Imperative voice. Scope optional but encouraged.
- All AI-authored commits include the `Co-Authored-By: Claude…` trailer (the
  user's instruction).
- Never use destructive flags (`--no-verify`, `--no-gpg-sign`, `--force` to
  main, `reset --hard` etc.) without the user's explicit OK.
- Never amend a commit that's already pushed.
- Prefer NEW commits over `--amend` when a hook fails — the failed commit
  didn't happen, so amend would modify the PREVIOUS commit.

## LFS

- Visual regression baseline PNGs (`e2e/vrt/__screenshots__/**`) are
  LFS-tracked per `.gitattributes`.
- `git push` requires flox-managed `git-lfs` to upload PNGs. Outside flox,
  push hangs indefinitely on the LFS filter step.
- `git lfs install --local` is part of the project setup (handled by the
  flox-managed install path).

## Local repo hazards

### Pack-file corruption

Symptom: `git status` / `git diff` / `git add` hang on `git-lfs filter-process`
or error with `fatal: file ... is far too short to be a packfile`. Has hit
this repo repeatedly during long sessions, especially when parallel agents
are working in the same checkout (different branches).

Recovery:

```sh
mv .git .git.broken && \
  flox activate -- git clone --filter=blob:none \
    https://github.com/2600hz-oscillator/patchtogether.live.git fresh && \
  mv fresh/.git . && rm -rf fresh
```

Then re-checkout your branch. Working tree is unchanged.

### Sync-layer silent edits

Some macOS sync layer (likely iCloud) silently:
- Reverts edits to certain tracked files (`Canvas.svelte`,
  `NodeContextMenu.svelte`, `ModulePalette.svelte`, dashboard files).
- Creates `*" 2".ts`, `*" 3".ts`, `*" 2".png` junk file duplicates.

Mitigation:
- **Commit immediately after each meaningful edit** to a sensitive file.
  Don't batch edits then commit; the sync layer eats batched changes.
- **Leave the `*" N".ts` junk files alone** — `git status` shows them
  untracked; they're not your problem. The user has chosen not to fight
  them; just don't `git add` them.

## When local git can't push: REST-API push pattern

When local `.git` is corrupted mid-task and you need to ship code, use the
GitHub REST API directly. The pattern (working scripts at
`/tmp/wavesculpt-*-upload.py` from prior sessions):

```py
# 1. Get main SHA
# 2. Create branch ref via gh api repos/.../git/refs --method POST
# 3. For each file: gh api repos/.../contents/{path} --method PUT --input -
#    body: { "message": "...", "branch": "...", "content": base64(file_bytes) }
# 4. Open PR via gh pr create
```

**Limitations:**
- Text files only. Binary blobs (PNG baselines) need either a real
  `git push` from a fresh shallow clone, or use of `gh api .../git/blobs`
  + tree + commit (more complex but possible).
- Each file is its own commit unless you batch via blobs→tree→commit.
- Best for small ports / single-file fixes when local git is broken.

## When in doubt: fresh shallow clone

For agent-driven multi-file work where the local repo is uncertain, the
cleanest pattern is:

```sh
flox activate -- git clone --filter=blob:none \
  https://github.com/2600hz-oscillator/patchtogether.live.git /tmp/work-fresh
cd /tmp/work-fresh
flox activate -- git checkout -b feat/whatever
# ... do work ...
flox activate -- git push -u origin feat/whatever
flox activate -- gh pr create --fill
```

This is the safest fallback when:
- Parallel agents have been thrashing the shared checkout.
- A merge needs real conflict resolution and not REST-API patching.
- LFS uploads are involved.

## Branch hygiene

- Don't push to `main`. Always PRs (the branch ruleset blocks direct push
  anyway).
- Delete merged branches (`gh pr merge ... --delete-branch`).
- Agent worktrees accumulate under `.claude/worktrees/agent-*` over a long
  session — periodically `rm -rf .claude/worktrees/agent-*` to recover disk
  (each is ~70-100MB; sessions have hit 3+GB).
