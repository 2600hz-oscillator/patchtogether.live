# Faceplate build specs — the ROLLING index (opened 2026-08-19)

**This file and the specs beside it land through ONE long-lived PR that is
updated as each spec completes**, rather than a PR per spec. Owner directive,
2026-08-19: *"lets just have 1 open PR for specs and all the rolling work can
land in there… opening a PR per spec would be compounding our CI headaches."*

## Why one PR is genuinely cheap here, not just tidier

Checked rather than assumed, because the opposite arrangement is a documented
trap. `.myrobots/**` appears in `ci.yml`'s `paths-ignore` for **both** the `push`
and `pull_request` events, so a change confined to these files does not start the
full CI lane at all. On its own that would leave the PR **blocked forever** — a
path-skipped workflow reports nothing, and GitHub treats a never-reported
required check as pending indefinitely. It does not, because
`docs-only-gate.yml` fires on the **exact inverse** filter (`paths:` carrying the
same `.myrobots/**` entry) and posts the required contexts, guarded so that a PR
touching both docs and code posts nothing.

Net cost of updating this PR: **one ~1-minute ubuntu job**, no unit lane, no e2e
shards, no VRT. That is the whole reason the rolling shape is affordable.

⚠ **Keep it that way.** The moment a spec PR also touches a file outside the
doc-path list, the full lane fires and the guards correctly refuse to post — so
if a spec's findings need a CODE change, that change belongs in its own PR, not
in here.

## Why these live in version control at all

`.myrobots/` is **not** gitignored and carries 132 tracked files; it is the
project's durable knowledge base, and the faceplate queue itself
(`plans/faceplate-queue-2026-08-14.md`) lives here and is edited by ordinary PRs.

The failure mode this index exists to prevent is the opposite one: a spec written
into an agent's WORKTREE and never committed is **untracked**, and worktrees are
auto-pruned under the 10-worktree cap (`task worktree:guard` removes abandoned
ones). Several `.myrobots/2026-08-13-*.md` notes in the shared checkout are
orphaned in exactly that way. A spec that is not committed is a spec that will be
re-derived from scratch by whoever needs it next.

## Convention

Specs go in `.myrobots/plans/`, alongside `face-specs-batch-3-*.md`,
`face-redo-*.md` and `face-spec-cube-rebuild-2026-08-09.md`. Dated notes at the
`.myrobots/` root are session evidence, not specs.

⚠ **A spec is a HYPOTHESIS, not an instruction.** This is the rule this batch
learned by being burned: batch 5's queue entry proposed a `-3 dB corner` readout
formula for `moog904a` that measured **−29.40 %** wrong at RANGE 3, and the
inventory note for `mandelbulb` named a camera gesture the card does not have.
Both would have shipped had the builder trusted the prose. **Every figure below
is labelled DERIVED-BY-READING or MEASURED, and a builder re-checks the
load-bearing ones against the code before designing against them.**

## The specs in this PR

| spec | modules | state |
|---|---|---|
| _(appended as each lands)_ | | |

## What is deliberately NOT here

- **Anything already built.** Batch 5's four (`moog902`, `moog904a`, `moog912`,
  `mandelbulb`'s audit) shipped as their own code PRs.
- **Code changes.** See the cost note above — a code change in this PR fires the
  full lane and the docs-only gate then correctly posts nothing.
- **Owner decisions.** Where a spec reaches one, it states the decision and
  stops.
