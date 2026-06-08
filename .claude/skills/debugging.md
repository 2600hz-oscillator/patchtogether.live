---
name: debugging
description: Practical patterns for debugging CI failures, local repro, REST-API recon when local git is broken, and how to read the deploy/VRT/E2E pipelines without overflowing context.
---

# Debugging patterns

## Reading a failed CI run

> **NEVER use `gh run view --log` or `gh run view --log-failed`** (with or
> without `--job=`). They stream the entire log buffer and **wedge this
> session's shell** — you lose the terminal. This is a hard rule. Use the
> non-wedging paths below instead.

The fastest path to "which job failed" — list jobs + conclusions via the API
(never wedges):

```sh
flox activate -- gh api repos/2600hz-oscillator/patchtogether.live/actions/runs/<RUN_ID>/jobs \
  --jq '.jobs[] | {id, name, conclusion}'
```

To block on a PR's checks and get the failing detail printed for you, use the
Taskfile wrappers (they fetch logs safely, not via `--log`):

```sh
flox activate -- task pr:watch -- <pr#>   # block until checks resolve, print failing detail
flox activate -- task ci:health           # every open PR + its check status + failing test lines
```

If you must read a specific failing step's text, fetch the job's annotations via
the API (still no `--log`):

```sh
flox activate -- gh api repos/2600hz-oscillator/patchtogether.live/actions/runs/<RUN_ID>/jobs \
  --jq '.jobs[] | select(.conclusion=="failure") | {name, steps:[.steps[]|select(.conclusion=="failure")|.name]}'
```

## Find which PR/branch a run belongs to

```sh
flox activate -- gh run view <RUN_ID> --json headBranch,event,displayTitle,headSha
```

## Inspect repo state without local git

When local `.git` is broken (pack-file corruption — see `git-workflow`
skill), use the REST API to read remote contents:

```sh
# File content on a branch
flox activate -- gh api repos/2600hz-oscillator/patchtogether.live/contents/<path>?ref=<branch> \
  --jq '.content' | base64 -d

# Latest commit on main
flox activate -- gh api repos/2600hz-oscillator/patchtogether.live/commits/main \
  --jq '{sha:.sha[0:10], msg:(.commit.message | split("\n")[0]), date:.commit.committer.date}'

# Diff two branches
flox activate -- gh api repos/2600hz-oscillator/patchtogether.live/compare/<base>...<head> \
  --jq '.files[].filename'
```

This is the fastest way to verify "what's actually on main right now" without
trusting a potentially-stale local checkout.

## Reproducing a flaky test locally

The user's rule: when a CI test fails, reproduce locally before pushing a
fix. Loop the specific test:

```sh
flox activate -- bash -c '
  for i in {1..20}; do
    echo "--- run $i ---"
    task e2e -- -g "<failing-test-pattern>" || { echo "FAILED at run $i"; break; }
  done
'
```

If you can't reproduce in 20 runs, the flake may need test-side hardening
rather than production-side fix; if you reproduce on run 3-5, the bug is
relatively common.

## VRT triage

See dedicated `vrt-failures` skill. Short version: never blanket-recapture;
classify each diff PNG as expected vs unexpected.

## Reading what happened in a session you didn't run

For state changes during a previous session:

```sh
flox activate -- git log --oneline -20
flox activate -- gh pr list --state all --limit 20 --json number,title,state,mergedAt
```

For ongoing operational state:

```sh
flox activate -- gh secret list -R 2600hz-oscillator/patchtogether.live
flox activate -- gh api repos/2600hz-oscillator/patchtogether.live/rulesets/16042163
```

## Inspect the deployed app

- Dev: https://dev.patchtogether.live (basic-auth gated; creds in user's
  local memory, NOT in this skill)
- Autotest: https://autotest.patchtogether.live (basic-auth gated)
- Prod: https://patchtogether.live
- PR preview: `gh pr view <num> --json url` then look for the Cloudflare
  Pages comment with the preview URL

## Reading Cloudflare logs

`wrangler tail` (with the right project name) for live logs. CF Pages
dashboard for build/deploy logs. No need to scrape these from CLI for most
debugging — the deploy workflow output in GHA usually has what you need.

## When to spawn an agent vs investigate directly

- **Direct**: single-file inspection, one-shot grep, reading a known file.
- **Explore agent**: "where is X used?" / "find all callers of Y" / "what
  does this module set up?"
- **General-purpose agent in worktree**: any multi-step change with its own
  test loop (module ports, refactors, multi-file fixes). Especially when
  the work would otherwise blow your context.

When you spawn an agent, give it ENOUGH context to make judgment calls —
don't write a narrow command. The agent should be told what you're trying
to achieve, what you've ruled out, and what success looks like.
