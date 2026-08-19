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

| spec | modules | merit | headline |
|---|---|---|---|
| `2026-08-19-spec-moog904bc.md` | `moog904b`, `moog904c` | YES (904b narrowly, on ONE readout) | ⚠ **The queue's "proper subsets of Q39" premise is WRONG in four ways** — 904c has no RANGE param at all, 904b's multiplier is ×1/×2^1.5 (module-local, not the lib's ×1/×4/×16), 904b's dead travel is at BOTH ends, and 904c's cutoff CV is a `cvScale: log` AudioParam sum (±4.98 oct), not a per-sample 1 V/oct multiply. Same `MoogLadder` class, three unrelated findings. |
| `2026-08-19-spec-mandelbulb-face.md` | `mandelbulb` (the FACE build) | YES | The slice-readout question is resolved as a `custom` **sidebar block**, because `hero.cell` would DELETE the live fractal preview at the dock (`module-shell-model.ts:876`) — a parity regression, not a layout choice. |

### ⚠ Two "missing file" notes in the mandelbulb spec are BRANCH ARTEFACTS, not findings

Recorded here so nobody re-investigates them. That spec reports
`mandelbulb-glyph-tap.test.ts` as absent and the SCREEN **overlay** paragraph as
absent from the skill. Both exist — in **PR #1925**, unmerged at the time it
looked, while the worktree sat on a different branch. The glyph mechanism it
re-derived by reading four seams is the same one that test pins, so the two agree;
it is the *file* that was invisible, not the conclusion. **When an agent reads a
shared worktree during concurrent branch work, "not found" means "not on this
branch right now".**

### The two findings from these specs that are NOT yet filed and should be

1. **`moog904b` cannot be promoted as-is — its RANGE would render as an ANONYMOUS
   ROTARY.** `looksLikeToggle` requires `min 0 / max 1` (`group-controls.ts:54-56`)
   and `range` is `1..2`, so `paramCellKind` falls through to `'knob'`
   (`shell-control-kind.ts:264-271`); with no `options[]` roster `paintsReadout`
   is false, so **nothing paints at all** — a two-position switch as an unlabelled
   dial. ⚠ **Both existing gates are blind to it**, which is the interesting half.
   The fix is the roster, and the labels must be `LOW`/`HIGH`: `'×2.83'` and
   `'+1.5 oct'` both trip `looksNumeric` in `face-readout-source.test.ts`.
2. **`moog904b`'s declared cutoff minimum is unreachable.** The def declares
   `min: 4` while `ladderCutoffToG` floors at `fmin = 10`
   (`moog-ladder-dsp.ts:115`), so the bottom **10.758 %** of the dial is bit-exactly
   one filter — and at RANGE HIGH the ×2.8284 multiplier lands before the 20 kHz
   ceiling, killing the top **12.207 %**. **No RANGE position has a fully live
   dial, and the two dead ends are at opposite ends** — which is why the 904a
   analogy fails.

## What is deliberately NOT here

- **Anything already built.** Batch 5's four (`moog902`, `moog904a`, `moog912`,
  `mandelbulb`'s audit) shipped as their own code PRs.
- **Code changes.** See the cost note above — a code change in this PR fires the
  full lane and the docs-only gate then correctly posts nothing.
- **Owner decisions.** Where a spec reaches one, it states the decision and
  stops.
