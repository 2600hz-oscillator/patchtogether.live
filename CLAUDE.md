# Repository standards

**Start at [`AGENTS.md`](AGENTS.md)** — authority order, current product state, and
the command cheat-sheet. This file is the *rules*. Each rule states what to do and
the one measurement that justifies it; the case study that produced it lives in the
named skill under `.claude/skills/`. **When this file and a skill disagree, this
file is the rule and the skill is the detail** — and the measured numbers live in
the skill, so they cannot drift between two copies.

## Every feature and every bug fix is a GitHub issue

Whether the owner reported it or an agent found it, it gets an issue **before or
with** its PR, and the PR closes it (`Fixes #N`). Found a defect and fixed it in
the same session? File it anyway, then close it — the issue can be open for
minutes. The point is that the work is searchable six weeks later by someone who
was not in the conversation.

- An issue is closed by a merged fix or an explicit owner `wontfix` — never by
  "seems fine now".
- Automated health alerts (`alert` / `observability` labels) are exempt; they have
  their own lifecycle.
- Details, templates and labels: [`docs/process/issue-workflow.md`](docs/process/issue-workflow.md).

## Commands run through flox

Every command (git, gh, task, npm, node, …) runs inside the Flox env:
`flox activate -- <cmd>`. Running git outside flox can make git-LFS operations hang.

## Run NEW tests locally before pushing to CI

When you add new behavior **and** new tests for it, run **those specific tests**
locally and confirm they pass before relying on CI — never push and use CI as the
first check. A CI cycle here is ~25 min under load; this is the cheapest feedback
loop you have.

- Run the *specific* new test, not "the suite I happened to touch". A new module is
  auto-enrolled in registry-driven sweeps (`per-module-per-port`, `behavioral`,
  `vrt.spec` per-card) — run those rows for your module too, plus your bespoke spec.
- Run from a **clean** state when the test loads built artifacts (`rm -rf
  packages/dsp/dist` first) — a stale local build masks failures that only appear
  on a fresh CI checkout.
- Run `flox activate -- task typecheck` (svelte-check) as well as vitest. Vitest is
  lenient where svelte-check is strict, so a test can pass vitest and fail the gate.
- **Capability- and renderer-dependent modules pass locally yet fail on CI.** For
  anything depending on a hardware H.264 encoder, `getUserMedia`, or WebGL
  precision: gate the assertion on a runtime capability probe and **confirm it is
  green ON CI**, not just 3× locally. CI runs SwiftShader and has no OS H.264
  encoder. Also estimate the PR's CI wall-time delta and flag anything over ~2 min
  before merge.

→ `.claude/skills/running-tests.md` (the `*:one` targets, `REPEAT`, the warm-server
loop, and the recorderbox/edges cases that burned cycles).

### NEVER express a renderer-dependent wait in MILLISECONDS — count FRAMES

The highest-yield rule for WebGL/video e2e. A wall-clock budget is a **different
number of frames on every renderer**, so it is not one assertion — it is a
different assertion per machine. Measured: **7.9 fps** under `E2E_SWIFTSHADER=1`
vs ~60 fps on a real GPU, and CI runs ten shards in parallel on top of that.

- **Wait on a frame count in the page via rAF** (`waitFrames(n)`), never
  `waitForTimeout`. Renderer-independent by construction, no per-machine tuning.
  ONE export site: `e2e/_helpers/frames.ts`. Don't hand-roll another rAF settle.
- **`page.waitForTimeout` under `e2e/` is DENIED BY DEFAULT** (#1523,
  `local/wait-for-timeout-needs-why` — a named, blocking rule in `task lint`).
  Paint readiness → `waitFrames`; state readiness → an auto-retrying `expect` /
  `expect.poll` on the real subject; a genuine **product-side** interval (a
  debounce the app defines, a decay tail, a gate width) → keep it and write
  `// pacing: <which interval this mirrors, and where the product defines it>`
  ON the call site. Waits that predate the rule sit in the GENERATED
  `e2e/waitfortimeout-ledger.generated.txt`; `task lint:waits:accept` regenerates
  it and **refuses to add a line**, so it only shrinks, and a ledger entry naming
  a wait that no longer exists is RED.
- Keep a wall-clock cap only to **bound the failure**, never as the gate.
- ⚠ **DOOM IS EXEMPT FROM THIS RULE. Never convert, annotate or otherwise touch a
  DOOM wait — or any DOOM spec — without specific owner approval** (owner ruling,
  2026-08-17: *"do not fuck with doom in any way without specific approval"*).
  Its ~49 ledger entries are permanent, so **the ledger never reaches zero and
  that is intended** — never write an "0 remaining" check. The reason is
  mechanical, not preference: `video/modules/doom.ts` calls `runtime.runTic()`
  inside `surface.draw`, and `runTic` runs exactly one `dgpt_tick`, so **DOOM's
  game clock IS the frame clock — one rendered frame = one game tic.**
  `waitForTimeout(1200)` is ~72 game tics on a local GPU and ~9 under
  SwiftShader; "fixing" it re-specifies **how far the marine walks** in a suite
  that then asserts on where he ended up. If a sweep's scope would include DOOM,
  **exclude it BY NAME with the reason, and say so in the PR body** — a silent
  inclusion is the failure mode even when the change is correct.
- ⚠ The ~2.5× "CI is slower" figure is a **unit-lane** number. Do not carry it to
  anything touching WebGL.
- **Establish WHY before touching any budget.** "Slower on CI" and "genuinely
  different on CI" need opposite fixes. Reproduce under `E2E_SWIFTSHADER=1`.

→ `.claude/skills/iterated-render-e2e.md`.

### Flake-check NEW/changed tests 3× locally before opening an MR

A single green run proves pass/fail, not **stability**. Any test you add or
seriously change passes **3× in a row locally** before you push it (scoped to the
new/changed test — not the whole suite). Use `REPEAT=3` on the `*:one` targets; the
run fails on the first failing iteration, so a flake cannot hide behind a later
green. If it flakes, diagnose run-bug vs test-bug — **never just re-run**. A flake
that only reproduces under CI load still gets root-caused.

### VRT baselines: there is ONE SET and LINUX CI AUTHORS IT

`snapshotPathTemplate` has no `{platform}` segment. A baseline is one PNG written by
the `vrt-update.yml` capture job on ubuntu-latest. **You never commit a baseline** —
dispatch with `flox activate -- task vrt:commit`. A local macOS run compares Metal
text against a linux baseline, so it is **not a verification**.

**The capture is SCOPED to the branch's diff by default** (#1795) — measured 41-56 min
unscoped against ~3 min scoped. A bare `task vrt:commit` derives the token and prints
the scope, the files that produced it and the test count it selects before dispatching;
`ALL=1 task vrt:commit` is the deliberate full sweep. The derivation is deny-by-default:
two modules, an unattributable renderable file, or an unrecognized path all fall back to
the full sweep **loudly**, and nothing-that-can-move-a-pixel refuses to dispatch at all.
Scoping is safe because it cannot silently under-capture **where it gates** — `vrt-strict`
reddens on the next CI run and names the file.

Three hazards, none of them about platforms:

- ⚠ **`--update-snapshots` CANNOT regenerate a PASSING-but-stale baseline** — it
  only rewrites on a FAILING comparison. **`git rm` the stale baseline first.**
  Treat a green dispatch that committed nothing as a RED FLAG, and **count the files
  the bot commits against what you predicted.**
- ⚠ **A `git rm`-ed baseline is SILENTLY RECREATED by the next plain VRT run** — as
  an untracked PNG no gate reads. **`git status` for untracked PNGs after every VRT
  run** in a window where you deleted a baseline.
- ⚠ **Bare `--update-snapshots` is `=all`** in Playwright 1.59 and once rewrote 22
  unrelated baselines. `task vrt:update` passes `=changed`.

Also: **chrome that is not in frame can still move a baseline — through layout, not
pixels.** Before adding to the topbar or footer, measure the row's free space and
the bar's height with and without it. Re-pinning is the wrong response to that
class; fix the layout.

And: **an isolation mechanism that only half the entry points honour is not
isolation.** When you add an `E2E_PORT`-style knob, grep every caller and prefer
failing loudly over silently falling back to a shared default.

→ `.claude/skills/vrt-baselines.md` (the 865 px dock swap that committed nothing,
the 133-baseline footer incident, the green sweep of the wrong branch).

## Worktrees: hard cap of 10

Abandoned agent checkouts accumulate fast — each carries a dead lock plus its own
`node_modules` and buries the worktrees actually in flight.

Before `git worktree add` or spawning an agent with `isolation: "worktree"`, run
`flox activate -- task worktree:guard`. It prunes gone worktrees, removes abandoned
ones (dead lock **and** clean tree **and** fully pushed, so no work is lost), then
re-counts. If still over 10 it exits non-zero and lists what needs a human — resolve
those before creating another. Also: `worktree:list` (classify, change nothing),
`worktree:clean` (auto-remove abandoned only).

⚠ **`git stash` is shared across all worktrees** — one repo-wide stack. Use WIP
commits instead.

## Post-merge conflict sweep

Module registration is glob+palette-driven, so `modules/index.ts`, `Canvas.svelte`
and friends are no longer the conflict surface. The remaining hand-maintained list
files that concurrent PRs still collide on:

- `packages/web/src/lib/docs/module-manifest.ts` (`DESCRIPTIONS`)
- `e2e/vrt/vrt-exemptions.ts` (`EXEMPT_FROM_VRT` / `ALLOWED_PERMANENT_EXEMPT`)
- `packages/web/src/lib/ui/modules-card-map.test.ts` (`EXPECTED_NODE_TYPES`)
- the per-port / VRT spec lists (`e2e/tests/per-module-per-port*.spec.ts`)
- `packages/web/src/lib/control/push2/push-card-config.ts` (`PUSH_CARD_CONTROLS`)
- `packages/web/src/lib/docs/strict-docs.ts` (`STRICT_DOCS`)

⚠ Because a push card is resolved from the LIVE def, **adding or renaming a param on
any module can silently change that module's push card** — the tiers re-rank
themselves. If a module's card matters, give it an explicit entry (an override
REPLACES, so it cannot drift).

Generated artifacts collide too — `contract-lock.txt`, `test-ledger.generated.md`.
On conflict: **take main + re-run the accept task**, never hand-merge.

**Whenever a PR merges to main, sweep the other open PRs for conflicts the merge
just created** — `flox activate -- task pr:conflict-sweep`, then rebase each with
`git merge origin/main` locally and **verify your additions survived**.

**Never use `gh pr update-branch`** on PRs touching shared registry files — it
silently drops the PR's additions with no marker.

→ `.claude/skills/pr-workflow.md`.

## VALIDATE THE INSTRUMENT — a wrong metric reads exactly like a finding

Four times in one session the measurement was wrong and its output looked
authoritative. None announced themselves; each produced a confident, plausible,
false conclusion. **Before believing a measurement, ask what it is invariant to.** A
metric blind to the dimension under test will happily return a clean number.

1. **Negative-control the instrument, not just the code** — perturb the thing it
   claims to measure and confirm the number moves.
2. **Sample at co-prime / irregular offsets** when probing anything periodic; an
   even lag against a period-2 signal aliases to a constant.
3. **State the units in the assertion message** (`CSS px` vs `screen px`, `frames`
   vs `ms`). Half these bugs were unit confusions a printed label would have caught.
4. **Reproduce under the environment that actually failed** before theorising.
5. **Never sample a page-side quantity with a Playwright-side poll loop.** It is one
   round-trip per sample **on the same main thread as the subject**, so a loaded
   runner starves both — and "frozen" and "never looked" are indistinguishable from
   the output. **Move the accumulator INTO the page**; report `samples` /
   `elapsedMs` / the values seen in the assertion message.

⚠ The meta-tell: **"the result is genuinely different here" and "the instrument
reads differently here" look identical from the output alone.** They need opposite
fixes. ⚠ When the fix is to the INSTRUMENT, negative-control it in **both**
directions, and make one of those a **permanent leg** of the test.

→ `.claude/skills/blind-gates.md`.

## A CARD can silently disagree with its DEF — and a def-reading gate is blind to it

**The case (backdraft, 2026-07-28) is FIXED — read it as the reason for the rule,
not as an open defect to go find.** A def constrained a control to ±0.2; the card
passed literal `xMin={-1} xMax={1}`. The pads *wrote values the contract forbids*
and the model silently clamped them. `contract-lock`, `module-docs-lint` and the
range assertions **all read the DEF**, so the entire gate set was blind and the work
was honestly reported as "ranges constrained ✓" while the UI was still ±1.

Both pads now pass the def's own exported symbols (`BACKDRAFT_CAM_TILT_RANGE` /
`BACKDRAFT_CAM_POS_RANGE`, imported from the def alongside `backdraftDef`), and two
SOURCE-level gates hold the line: `card-range-source.test.ts` (backdraft is in
`RANGE_BOUND_CARDS`) and `card-control-ranges.test.ts`, which rejects a bare numeric
range prop on that file. It is not decoration — **#1223 re-introduced numeric
literals in one of that card's Fader range props and the gate caught it**, as did a
comment that merely *spelled the literal out* (the gate greps source, so it cannot
tell code from comment).

- **A control's range must come from ONE place** — export it from the def and import
  it in the card; never re-type numbers in the card.
- **Guard it at the SOURCE level**, since no runtime gate sees it.
- ⚠ Both gates are **opt-in per card** (`RANGE_BOUND_CARDS`), and every card outside
  that set is unchecked. Bring a card in when you touch it — that blind spot, not
  backdraft, is where this class lives now.
- The general rule: **a gate that reads only one side of a two-sided contract proves
  nothing about the other side.**

**Ask of any new gate: what is it structurally unable to see — and would its green
run look any different if the answer were "everything"?** Four gates were once all
green and all blind, because each applied a FILTER before the check that quietly
redefined the check's subject (one saw 3 of 99 writes; another 7 of 193 cards).

Two inversions, applied always:

1. **Deny by default with a NAMED exemption per instance** — the exact
   `(file, key)` / `(module, port)` triple, never a filename, so a new defect in an
   already-listed file still reddens.
2. **Anchor to the ARTIFACT, not the list** — a ledger entry naming something that
   no longer exists is RED.

Plus: **state the gate's scope inside the gate**, asserting what it still cannot see.

⚠ **Before "fixing" a declaration to satisfy a gate, check the consumer reads it.**
Four cards pass `curve="linear"` where the def says `discrete`; writing `discrete`
would green the gate and change nothing, because `Knob.svelte` has no `discrete`
branch. That is a green gate certifying a live bug.

**An ACTION-shaped cell needs a probe, exactly like a PANEL does.** An audition
writes nothing to the graph by design, so `readParam`/`readData` are structurally
blind to it — the observable is the audition ledger, and `delivered: false` is
recorded, never dropped.

### ⚠ A gate whose PRECONDITION is the defect cannot fail on the defect

The blind-gate rule above asks what a gate cannot SEE. This is the sharper
version: ask what makes the condition it measures **true** — the feature, or the
bug?

**Measured (#1796).** `.faceplate-body` carried `min-width: 900px`, padding every
dock faceplate to 900 px. Five specs asserted things that were only true
*because* of that padding:

- `dock-pane-close-chrome` scrolled `adsr` sideways to prove the ✕ is pane-fixed.
  adsr has **259 px** of real content — it overflowed a half-width pane only
  because the floor inflated it to 900. ⚠ **That test passed vacuously and would
  have CERTIFIED the replacement bug** (a `max-width` clamp that clips a wide
  face instead of scrolling it). It only caught the bug after its subject was
  re-pointed at a genuinely wide face.
- `workflow-shell-live-glyphs` asserted *"blank space remains to the hero's
  right"* — **a gate pinning the wasted space as correct.** It could only ever
  fail if the plate stopped being oversized.
- Two more asserted panes split 50/50 (true only while every face was forced to
  one width) and that a face KEEPS its kit floor (the design being overturned).

**So:** when a fix removes a condition, the gates that depended on it do not
merely go red — some go **green and blind**, and a green-and-blind gate will
certify the next bug in that area. When you change a layout invariant, list the
assertions that consumed it and ask of each whether its precondition still
exists. Fix the SUBJECT (drive the assertion from a case that produces the
condition on its own merits), never the threshold.

The repaired versions are strictly stronger: they exercise real overflow from a
genuinely wide face instead of overflow manufactured by padding a narrow one.

## Faceplate chrome: NO resting derived text, NO useless width

Owner rulings from two review rounds (2026-08-17 and 2026-08-19). They are about
FACEPLATES — the legacy cards are untouched.

**THE RESTING FACEPLATE PAINTS NO DERIVED-STATE TEXT, IN ANY SHAPE.** The owner
has now said this FOUR times about FOUR different mechanisms, and each one had
passed the gate written for the previous one:

1. the resting decimal under a dial (`persistentReadout`, deleted 2026-08-17);
2. the dock SIDEBAR — the right-hand column, all three kinds, deleted
   2026-08-19: *"this should go away and we reclaim the vertical space. I DO NOT
   WANT THESE RIGHT HAND TEXT AREAS I DO NOT WANT EXTRA TEXT. i explicitly
   already dictated that several times"*;
3. the HERO READOUT STRIP — a labelled row of derived values under the hero, on
   50 of 68 faces, deleted 2026-08-19: *"you don't need to have the out-silent
   text at all … we absolutely have to stop doing shit like that. i said
   minimal, and good use of screen real estate"* (#1957);
4. the per-control caption a section heading already conveys (`face.bareCells`).

**Permitted resting text, exhaustively:** the module NAME (dock title bar),
TAB/SECTION labels, CONTROL CAPTIONS, and option/landmark NAMES that
disambiguate a control's own position. Everything else — a value, a measurement,
a state word, a sentence — lives in `aria-valuetext` on the control it
describes, which is speakable and assertable but unpainted.

⚠ **So the gate denies the SHAPE, never a mechanism.**
`face-resting-text-source.test.ts` enumerates the permitted text ROLES and
refuses any `ModuleFace` field without one — RED on the TYPE, before a module
adopts it, which is the only formulation a fifth mechanism cannot walk around.
It states its own blind spot: **text drawn INTO a canvas** (a glyph, a video
surface, a shell extension's `fullViewBody`) is invisible to it, and only the
dock VRT baselines and a human reviewing them can see that.

⚠ **Deleting a readout deletes a FINDING.** Kick drum's TAIL was 398 ms where
the nearest knob said 450; resofilter's five modes collapsed to three distinct
pairs; marbles' CLUSTERS model runs the COIN generator. The arithmetic survives
in the `<mod>-face-model.test.ts` unit lane, but nothing now joins it to a
surface a player can see. When you remove one, **say which finding lost its
surface** rather than letting the coverage quietly lapse.

**No face prints a decimal under a control, and the data is REMOVED, not
hidden.** *"we should kill the light white decimil represebtation of knob state
in ALL modules"* / *"i want the data gone, not there but hidden or something"*.
⚠ **`persistentReadout=false` is NOT the implementation** — a hover reveal is
"there but hidden", refused by name, and the prop is deleted so it cannot come
back. A readout still paints when its text is a declared option/landmark NAME
and the param declares no `format` (`paintsReadout`); a name disambiguates
otherwise-identical states, a number restates the dial. The value survives in
`aria-valuetext`, which is what every spec proving a face tracks the graph now
reads — so no assertion had to be weakened to survive the removal.
Gate: `face-readout-source.test.ts` (source-level, and it denies the PROP, not
its value).

**A per-control label earns its place when it disambiguates otherwise-identical
controls; it is clutter when a section heading already conveys it.** tidyVco's
`A`/`D`/`S`/`R` are the only thing separating four identical knobs and STAY;
mixmstrs' `1LO…8LO` under a `LOW` heading say nothing the grid has not said
twice and GO. Declared per param (`face.bareCells`), dock-only — a lane tile has
no section headings, so the thing that makes the caption redundant is not on
screen. mixmstrs is currently the only face that declares it. ⚠ Hide the TEXT,
never the accessible name: the primitives take `hideCaption` precisely so a
caller cannot do it by dropping `label`.

**Compact is the DEFAULT. Width must be EARNED, and the burden of proof is on
the wide face.** *"we do not want useless gray horizontal space on cards, ever.
prefer compact. screen real estate is expensive!"* A genuine earner is a live
picture, a scope trace, a video preview, an XY pad, or a control that appears in
one mode only. Measured off the committed PNG headers: `.faceplate-body` carried
`min-width: 900px`, so **39 of the 50 dock baselines were EXACTLY 900 px wide**
against ~450 px of content on tidyVco. ⚠ It had already grown two per-occupant
escape hatches; **a default that
needs a new exemption per review is the wrong default** — fix the default, never
add a third hatch. Gates: `face-width-source.test.ts` (the rule) plus the
per-face content-vs-plate measurement in `workflow-shell-faces.spec.ts` (the
result), both deny-by-default with a NAMED exemption carrying the thing that
consumes the width.

## NEVER hand-type a population count

**Never write a new hand-typed population count.** Not a ceiling, not a floor, not a
"frozen at N" — no literal whose value is *how many of something there are*. P0
owner directive (2026-08-10): *"i want to eliminate the need for any of this."*

**The sweep is FINISHED (Phase 3, 2026-08-12): there is no hand-typed population
count in `packages/`, `e2e/`, `scripts/` or `art/`.** If you find one, it is a bug in
that claim — **delete it, do not maintain it**, and never re-derive a count "just for
this one".

**Why, measured:** three faces authored concurrently from a base of `9 / 7` wrote
`10 / 8`, `11 / 9` and `11 / 9`. The merged truth was `12 / 10`. Every agent counted
correctly for the tree it was standing in, and the value was stale the moment a
sibling merged. Had either explanatory comment been left alone it would have
**auto-merged cleanly and wrongly**. This is a property of the construct, not of
anyone's care.

**What to write instead**, in preference order:

1. **An unconditional assertion** — `expect(offenders).toEqual([])`. A ceiling of 0
   measures nothing and can only go stale.
2. **A NAMED deny-by-default list**, each entry carrying its `(module, scene,
   reason)` triple and a `why`, anchored so a name that no longer resolves is RED.
   **Better still, put the `why` in the TYPE** — a required field means `tsc`
   refuses the undeclared form before a test runs.
3. **A DERIVED assertion** — read the population off the artifact and assert a
   property of it, never its size. **The strongest form is DERIVED MEMBERSHIP**: if
   membership is a property of the def, assert that and the floor is not merely
   redundant but strictly weaker (`STRICT_FACES` is now "every def that declares a
   `face`", asserted both directions).
4. **A GENERATED artifact on the accept loop** when review visibility of a whole
   population is genuinely needed — reviewed as a diff, never hand-merged.

**What NOT to mistake for a ratchet** (over-deleting a real constant is its own bug):
policy thresholds on a derived measurement; layout/physical constants; prose-quality
floors (`why.length > 40`); assertions over a fixture the test itself built; and
vacuity floors with real slack — ⚠ but **check the slack**, because a floor sitting
exactly ON the population is a ratchet in behaviour whatever it is in intent.

⚠ **When you delete one, check what it protected FIRST.** "It is a count, therefore
delete it" is not the rule; **"a count is never the right SHAPE, so find the shape
that is"** is.

**And do not inventory payable debt.** A ledger of *known answers* is deferred
typing; every agent who touches the area afterwards pays a re-count tax. When debt
is paid, **delete the mechanism entirely** and leave no replacement counter — keep
the unconditional check plus a permanent negative control calling the **same
predicate** the check calls.

→ `.claude/skills/population-counts.md` (the search commands to re-run, what they
structurally cannot find, and the 283-line payment).

## Living docs: the contract gate

Module documentation is PINNED to the I/O CONTRACT, like ART pins audio to a
source-SHA. Three tiers: **GENERATED** (the I/O reference, derived from
`PortDef`/`ParamDef` — never hand-authored), **AUTHORED** (behavioral prose
co-located on the def in a `docs:` field, so a port change and its doc edit land in
the same diff), and **PINNED** (`contract-lock.txt`, the committed golden —
generated, never hand-edited).

After an intentional contract or docs change run `flox activate -- task docs:accept`,
then **review the `git diff`** — a diff means a contract changed: accept it, or
recognize a bug.

**The ratchet**: every new module ships with co-located `docs` and enters
`STRICT_DOCS`; any module you incidentally touch is brought up to the bar then
(boy-scout).

→ `.claude/skills/module-docs.md`.

### The attests hash CODE, not bytes — docs are ignored BY DESIGN

**Write documentation anywhere. There is nothing to remember.** Owner directive:
*"docs should not need explicit ignore, they should be ignored by design."*

`scripts/attest-code-basis.ts` decides what counts as code for **every** attest hash.
It parses with the real TypeScript parser and drops documentation nodes: all
comments, a def's `docs`/`controlFamilies`/`face` properties, type-only imports, and
a package.json pin's script/prose fields. **String safety is a property of the
PARSER, not of a pattern** — a `//`-stripping regex eats `'https://x'`.

⚠ What it still cannot see (so a comment edit there DOES cost a re-attest): `.toml`,
`.sql`, `.snap`, and Svelte **markup** comments — named in `EXPECTED_RAW_BASIS_FILES`
and asserted exactly. ⚠ A **nested** `face:` is not stripped, only a def's own
top-level one.

## ART baselines and the fingerprint manifest are ONE truth — re-pin BOTH

`art/baselines/**/*.f32` and `fingerprints.generated.json` are two artifacts of the
same truth. **Use `flox activate -- task art:update`** — it chains
`art:fingerprints:accept` so the manifest cannot be forgotten.

**REVIEW the manifest diff entry by entry.** A **labels-only** move (`peakDb`/`rmsDb`)
is a pure LEVEL change; a **spectrum/features** move is TIMBRAL. A uniform +3.01 dB
on both peak and RMS with a byte-identical spectrum is the signature of a ×√2 scalar
gain. **Any entry you cannot attribute to a known intentional change is a real audio
regression — stop, do not re-pin.**

**A gate that cannot fail on CI is decoration.** When you add a probe-and-skip test,
ask where it can actually run, and give it a loud-skip env flag in the lane that
promises to run it.

## Standard/skill updates land with in-flight work

When a new standard or convention is introduced mid-development, fold it into
whatever PR is already in flight — don't spin up a separate ceremony PR. Fewer
in-flight PRs = fewer of the shared-file conflicts the sweep above exists to catch.

## Merge only on THIS PR's final-commit green

**Do not merge until THIS PR's CI run is green on its FINAL commit** — not an earlier
run, not a still-running run, not "the last push was green and this one's trivial".
The run that gates the merge must be built from the exact SHA you're merging.

A **red push run on `main` is a P0** to root-cause immediately — never absorbed as
"flake".

## Docs-only PRs: the path lists in ci.yml and docs-only-gate.yml move TOGETHER

`ci.yml` skips prose-only changes, but the ruleset REQUIRES four contexts and a
path-skipped workflow reports NOTHING — GitHub treats a never-reported required check
as pending forever, so the PR sits BLOCKED with zero failures.
`docs-only-gate.yml` fires on the **exact inverse** filter and posts those contexts,
but only when **both** guards agree: every changed file is a doc **and** GitHub
started no `ci.yml` run for that SHA.

- **Editing `ci.yml`'s `paths-ignore` means editing `docs-only-gate.yml`'s `paths` in
  the SAME commit** — the complement is the whole safety argument.
- **Never** satisfy a required context by naming a job after it: a job-level `if:`
  skip reports as SUCCESS to branch protection.

## Poly/MIDI modules: e2e the REAL source chain

Any poly or MIDI module ships an e2e that **wires the real default-mode source**
(MIDI LANE / POLYSEQZ) **→ the module → and asserts audible RMS at the output**. A
per-port "edge materializes" assertion does **not** count, and neither does an
ART/behavioral test driving the engine class directly with a synthetic note source —
that is how POLYHELM shipped green-but-silent, and the same bug class hit the poly
wave 5×.

## Triggers vs gates: edge-detect through the shared seam

A **trigger** fires ONCE per rising edge (clock/reset/strike/sync); a **gate** acts
WHILE the level is high and reacts to both edges (ADSR sustain, VCA hold, note-on/off).
Both flow through the unified `gate` cable, but the consumer's interpretation differs
and is DECLARED on the port (`PortDef.edge`).

- **Main-thread trigger detection MUST use `$lib/audio/edge-detect`
  `createEdgeCounter`.** NEVER re-scan a whole `AnalyserNode` buffer — the 2048-sample
  ring (~42 ms) overlaps the ~25 ms scheduler tick, so a whole-buffer rescan counts
  the same edge twice ("one clock pulse advances two steps"). A worklet consumer is
  exempt (per-sample compare is correct by construction).
- **Do NOT convert a gate consumer to edge-only** — an ADSR sustain is level-sensitive
  on purpose.
- Canonical thresholds and waveforms live in `$lib/audio/gate-trigger` — don't
  re-derive the numbers.

## The skills

`.claude/skills/` holds the detail behind these rules. Load one when you are working
in its area. ⧉ marks a **vendored** skill — third-party, installed by a tool rather
than authored here, so fix it upstream rather than editing it in place:

| skill | when |
|---|---|
| `agent-orchestration` | spawning agents, worktrees, briefs |
| `architecture` | how the app fits together |
| `blind-gates` | writing or reviewing any gate |
| `coding-conventions` | writing code in this repo |
| `debugging` | chasing a defect |
| `deploy-pipeline` | deploys, environments, previews |
| `flox-environment` | the toolchain |
| `git-workflow` | branches, worktrees, stash hazards |
| `iterated-render-e2e` | WebGL/video e2e, frames vs ms |
| `module-adversarial-audit` | auditing a module |
| `module-development` · `module-docs` · `module-faceplates` | building a module |
| `module-pr-checklist` | shipping a module |
| `playwright-cli` ⧉ | driving a real browser, authoring a new spec, mocking a request |
| `population-counts` | any literal that counts something |
| `pr-workflow` | opening, merging, conflict sweeps |
| `running-tests` | the `*:one` loop, REPEAT, warm server |
| `skeptical-first-baseline` | first measurement of anything |
| `testing-conventions` | what tier a test belongs in |
| `vrt-baselines` · `vrt-failures` | anything touching a baseline |
| `webgl-attest` | touching the attest basis |
