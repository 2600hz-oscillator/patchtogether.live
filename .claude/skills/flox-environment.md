---
name: flox-environment
description: How to run shell commands in this project's flox env. Use whenever you run git, gh, npm, task, node, python, or any other CLI.
---

# Flox environment

This project's dev environment is managed by [flox](https://flox.dev/). The
flox manifest at `.flox/env/manifest.toml` defines the packages that must be on
PATH for commands to behave correctly — node version, npm, git, git-lfs, the
`task` runner, playwright browsers, python, etc.

## The rule

**Always wrap commands in `flox activate --`** when running them from a session
that isn't already inside a flox shell. This includes:

- `git` (especially `git push` — without flox-managed git-lfs on PATH, LFS
  upload silently hangs)
- `gh`
- `npm`
- `task`
- `npx`, `node`, `python3`
- Project scripts

```sh
flox activate -- git status
flox activate -- gh pr view 1
flox activate -- task test
flox activate -- npm exec -w packages/e2e -- playwright test
```

To run several commands in a single subshell (faster, single flox startup):

```sh
flox activate -- bash -c '
  git fetch origin
  gh pr list --state open --limit 5
  task typecheck
'
```

## Why this matters

The user has hit the LFS-hang failure mode before: running `git push` outside
flox uses the system git, which can't find the flox-installed `git-lfs` and
hangs indefinitely on LFS-tracked PNG baselines. This caused multiple "stuck"
push debugging sessions.

## Exceptions

- **Reading files** (`Read` tool) — no shell, no flox needed.
- **Editing files** (`Edit`, `Write`) — no shell, no flox needed.
- **GitHub Actions workflows** — runners do `flox activate` as their first step
  on every job; you don't add it in workflow yaml again.

## When you'd want to drop the wrapper anyway

Pure read-only commands that don't depend on workspace tools sometimes work
without flox (`ls`, `cat`, `find`). But it's almost never worth saving the
millisecond — defaulting to `flox activate --` everywhere keeps mental
overhead low. The user has explicitly asked for this default.
