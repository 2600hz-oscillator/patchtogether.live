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

## ⚠ THE "§27" THIS BATCH WAS BRIEFED FROM IS NOT IN THIS FILE

Recorded first, because several commit messages and the specs below cite
"§27.4–§27.6" and a reader will not find it. **This file ends at `### 26.9`
(6358 lines). There is no §27 on `main`.** The batch-5 brief (Q38/Q39/Q40 →
`moog902` / `moog904a` / `moog912`, and Q25 → `mandelbulb`) came from a §27 that
exists only in an uncommitted working copy.

Nothing built on it is compromised — every load-bearing figure in that batch was
re-measured against the shipping code before use, and three of those
re-measurements found the §27 prose **wrong** (the −29.40 % corner formula, the
"proper subsets" premise, the mandelbulb inventory note). But it is the sharpest
possible illustration of this file's own rule: **a spec that is not committed is
not a source of truth, it is one machine's opinion.** Cite §26.x, which exists.

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
| `2026-08-19-spec-ruttetra-grainsofvision.md` | `ruttetra`, `grainsOfVision` | YES both (GOV the stronger) | ⚠ **`ruttetra`'s honest page count is 4, not 6** — the queue's 6 requires splitting `h0·xFreq + xPhase`, which is ONE expression, and leaves a 1-control page. So it does **not** reach the tab rail, which **contradicts the owner ruling that named it as the first tabbed application**. Owner decision needed. |
| `2026-08-19-spec-moog961-moog984.md` | `moog961`, `moog984` | **961 NO** / 984 YES | `moog961`'s rejection SURVIVES but its recorded reason is false — the routing is hard-wired in the DSP, on no control. `moog984`'s grid **is representable today with zero platform work**: the CONSOLE GRID (shipping on mixmstrs' 32-cell band), as **ONE band of four clusters** — four *bands* is the trap, since `packRun` packs `[4,4,4,4]` into two rows of eight and the matrix is gone. |
| `2026-08-19-spec-timelorde-treeohvox-scope.md` | `timelorde`, `treeohvox`, `scope` | YES all three | **All three "plan-blocked" claims were stale.** `treeohvox`'s blocker (#1658) is fixed and gated; `scope`'s was settled by `fullViewBody` being wired. `scope` is a **`bespoke-surface`**, not a generic face — all nine params are display-only and four would have no observable at all. |
| `2026-08-19-spec-b3ntb0x-bentbox.md` | `b3ntb0x`, `bentbox` | YES both | ⚠ **They are a FAMILY, not a superset pair** — the param-id intersection is exactly FOUR, and of bentbox's 12 bending knobs **zero** exist on b3ntb0x. And `b3ntb0x`'s `bend_d` is **`enhance` wearing a different name**: both read the same `neighborAvg` and multiply the same chroma carrier, so they compound (×5.40 at both full). The module's own "no dead control" guard proves each uniform is *consumed* and is structurally unable to see that two of them are one operation. |

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
3. **`b3ntb0x`'s `tbc` defaults to 1, which makes the module's own documented
   headline gesture impossible at factory settings.** `(rawOffset + wobble) *
   (1.0 - tbc)` is then exactly `0.0`, while the docs instruct *"Crank Sync
   Crush + Bias to tear and roll"*. Same class as `mandelbulb`'s DETAIL default
   sitting in its dead band, and as `moog921Vco`'s two bit-inert controls.
4. **`b3ntb0x` binds a sampler it never samples.** `uEncode` is declared,
   cached, and bound EVERY FRAME, and two comments assert it is read; no shader
   stage samples it. A per-frame bind for a texture nothing reads.
5. **A cost asymmetry that reads BACKWARDS on video defs, and it changes the
   cheap fix.** `HASH_TRANSPARENT_PROPS` covers `docs` / `controlFamilies` /
   `face` / `noUserControl` — **`params` is not on it**, and both defs sit in the
   WebGL basis. So on a VIDEO def an `options[]` roster is free in the CONTRACT
   but costs a **real-GPU re-attest**, the inverse of the audio rule this batch
   worked under. The boolean-as-`linear` defect on `mirrorX`/`mirrorY` should
   therefore be fixed with `face.paramCells: 'toggle'` (free on both counts)
   rather than `curve: 'discrete'`.

### ONE OF THE TWO IS RULED ON. THE OTHER IS STILL OPEN.

⚠ **An earlier revision of this section said BOTH were ruled on. That was wrong,
and it is corrected here rather than quietly rewritten**, because the error is
the useful part — see the handoff's note on rulings vs recommendations.

1. ✅ **`ruttetra` SHIPS UNTABBED — BUILD IT.** Owner, 2026-08-19, verbatim:
   *"untabbed fine. build."*
   ⚠ The history is kept deliberately: the FIRST reply to this question was
   *"1 - fix it"*, which does not select between two options, and the lane
   recorded it as a settled ruling anyway. It then had to be walked back. **The
   ruling above is the explicit one**; the earlier note is left in the handoff as
   the worked example of laundering an ambiguous reply into authority.
   Technical position, unchanged: 4 honest pages (one per shader expression), no
   padding, no change to `DOCK_TAB_MIN_BANDS`. `spirographs` already demonstrates
   the tabbed ruling at 7+ pages, so the principle was never in question — only
   which module carried it.

   ⚠ **AND A NEW REQUIREMENT ARRIVED WITH THE RULING — the display NAME.** Owner,
   verbatim: *"remeber that 'ruttetra' internal name needs to display as a
   module/card called 'xyz'."* So the module's INTERNAL type id stays `ruttetra`
   (it is the registry key, the VRT scene name, the doc-page slug and the
   `STRICT_FACES` entry — changing it is a rename across every registry), while
   the **user-visible label** must read `xyz`. That is `def.label`, which is what
   the palette, the lane tile and the dock title bar paint.
   ⚠ **Confirm the literal string before building.** `xyz` is recorded here
   VERBATIM rather than interpreted — if it was a placeholder for a real name,
   the builder must ask rather than ship the letters. Note the repo's
   lowercase-module-labels rule applies either way.
2. ✅ **The SCREEN toggle reaches a FACE through `fullViewBody`** — a genuine
   owner direction: *"the way backdraft behaves with its screen is correct, so,
   do that for spirograph"* names both the reference behaviour and the target.
   Applied in #1930; the defect and the still-missing gate are #1928.

The original statement of both, kept because the reasoning is the useful part:

### ⚠ TWO THINGS THE OWNER MUST RULE ON, both raised by the ruttetra/GOV spec

1. **The tabbed ruling names `ruttetra` as its first application, and `ruttetra`
   does not reach the rail.** Its honest page count is **4** (relief / shape /
   scan / beam — one page per shader expression). The queue's 6 is reachable only
   by splitting `h0·xFreq + xPhase`, which is a single expression, and by keeping
   a one-control `intensity` page. Lowering `DOCK_TAB_MIN_BANDS` from 7 to 6
   costs **exactly 3 moved dock baselines** (`cube`, `cofefve`, `marbles` are the
   only faces declaring 6 pages) — and **still would not reach ruttetra at 4**.
   So the options are: ship it untabbed, or revisit which module the ruling meant.
2. **SCREEN ON/OFF has NO faced implementation anywhere (D-8).**
   `previewCollapsed` appears in **zero** shell files. `backdraft` and `videoOut`
   reach it through a `fullViewBody` shell extension; `spirographs` is in
   `STRICT_FACES` yet its switch lives **only on its card**, which the face
   replaces. ⚠ This directly qualifies the OVERLAY paragraph added to the skill in
   #1925: that paragraph documents the **card** pattern correctly, but a *faced*
   video module needs the `fullViewBody` route, and spirographs currently has the
   gap. Confirm `fullViewBody` is the intended home, and close spirographs.

### ⚠ A promotion that would make an existing spec GREEN AND BLIND (D-9)

`e2e/tests/workflow-shell-video.spec.ts:444-450, 516-536` uses `grainsOfVision`
**because it is un-migrated**, as its placeholder-thumb host. Promoting GOV leaves
every assertion in that spec passing while the thing it proves quietly stops
being proven. It must be re-pointed **in the same diff** as the promotion — the
`#1796` class, where a fix removes the condition a gate depended on and the gate
goes green rather than red.

### ⚠ Four §24 claims about these two are REFUTED by the spec

Recorded so they are not carried forward: `readLive` is now on **all** knobs of
both cards; `card-def-debt` no longer ledgers `b3ntb0x`; **`fullViewBody` is
WIRED with two adopters** (backdraft + videoOut), so §24's *"a platform PR
wearing a face"* risk is withdrawn; and §24's `sin ≈ −3.07e−10` could not be
reproduced by reading.

## What is deliberately NOT here

- **Anything already built.** Batch 5's four (`moog902`, `moog904a`, `moog912`,
  `mandelbulb`'s audit) shipped as their own code PRs.
- **Code changes.** See the cost note above — a code change in this PR fires the
  full lane and the docs-only gate then correctly posts nothing.
- **Owner decisions.** Where a spec reaches one, it states the decision and
  stops.
