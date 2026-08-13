# Issue-driven workflow

**Every feature added and every bug fixed — whether the owner reported it or an
agent found it — is logged as a GitHub issue and closed when resolved.**

Owner directive, 2026-08-12. This document is the whole policy.

## Why

Before this, real work was tracked in chat transcripts, `.myrobots/` session
records, and agent memory files. None of those are queryable by the next person, and
none of them survive the conversation that produced them. The tracker was almost
entirely automated health alerts. The cost shows up as re-derivation: an agent
rediscovers a defect that was found and fixed six weeks ago, or re-litigates a
decision nobody can find the record of.

## The rule

1. **File before or with the PR.** An issue exists for the work before it merges.
2. **Agents file for what they find, even when they fix it immediately.** File, then
   close it with the fix. The issue may be open for four minutes — that is fine. The
   record is the point, not the ceremony.
3. **PRs close their issue** with `Fixes #N` / `Closes #N` in the PR body, so the
   merge closes it automatically.
4. **An issue is closed by a merged fix or an explicit owner `wontfix`** — never by
   "this seems fine now" or by going quiet.
5. **Automated health alerts are exempt** (`alert` / `observability` labels). They
   have their own open/close lifecycle driven by the monitors.

## Filing

Templates live in `.github/ISSUE_TEMPLATE/`:

| template | for |
|---|---|
| `bug.yml` | something is broken |
| `feature.yml` | something should exist |
| `agent-found.yml` | a defect or gap an agent measured — carries evidence and priority |

From the CLI, which is how agents file:

```sh
flox activate -- gh issue create \
  --title "…" --body-file <path> --label "p1,testing"
```

**Write evidence as `path:line` pinned to a SHA.** Line numbers drift; a claim
without a SHA cannot be re-checked. State what you measured and how, so the next
agent can re-run it rather than re-guess.

## Labels

Priority — exactly one per issue:

| label | meaning |
|---|---|
| `p0` | address immediately |
| `p1` | high-value correctness |
| `p2` | maintainability / debt |
| `p3` | after the p2s |

Area — one or more: `process`, `ai-context`, `ci-health`, `testing`, `ui-v2`,
`legacy-removal`, `docs-truth`, plus the pre-existing `bug`, `enhancement`,
`documentation`, `observability`, `alert`, `behavioral`.

`punchlist` marks the 2026-08 hardening series specifically.

## Enforcement

Deliberately soft. The PR template carries a `Fixes #` line and the PR checklist in
`.claude/skills/pr-workflow.md` asks for it. **There is no required status check on
issue references** — the friction is being measured first, and hardening it is an
owner decision, not a default.

## What this is not

- Not a project board, milestone, or triage rotation.
- Not retroactive — work merged before 2026-08-12 is not backfilled.
- Not a reason to split one coherent change across several issues. One issue may
  span several PRs, and one PR may close several issues when they are genuinely the
  same change.
