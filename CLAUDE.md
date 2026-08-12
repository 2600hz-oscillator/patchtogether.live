# Repository standards

## Run NEW tests locally before pushing to CI

When you add new behavior **and** new tests for it, you ALWAYS run **those
specific tests** locally and confirm they pass **before** relying on CI — never
push new code/tests and use CI as the first check that they pass.

- Run the *specific* new test, not just "the suite I happened to touch": a new
  module is auto-enrolled in the registry-driven sweeps (`per-module-per-port`
  handle/emit, `behavioral`, `vrt.spec` per-card), so run those rows for your
  module too — e.g. `flox activate -- npx --workspace e2e playwright test
  per-module-per-port --grep <yourModuleId>` and `… vrt --grep <id>`, plus your
  bespoke spec. Card UI change? run `task vrt` and inspect the diff.
- Run from a **clean** state when the test loads built artifacts (e.g. a DSP
  worklet dist or an ART baseline): `rm -rf packages/dsp/dist` first, because a
  stale local build can mask an ENOENT/SHA failure that only shows up on a fresh
  CI checkout.
- Run `flox activate -- task typecheck` (svelte-check) in addition to vitest —
  vitest is lenient where svelte-check is strict (e.g. import-less worklet
  TS2306), so a test can pass vitest yet fail the typecheck gate.
- This is the cheapest possible feedback loop; a CI cycle here is ~25 min under
  load. Most of our recent red CI (per-port emit, stale SHA pins) was catchable
  locally with the exact spec for the new module.
- **Capability- and renderer-dependent modules pass locally yet fail on CI** —
  for any module whose test depends on a hardware H.264 encoder, `getUserMedia`,
  or WebGL precision, **gate the assertion on a runtime capability probe**
  (`isConfigSupported()` / `getCapabilities()` / a renderer-tolerant pixel
  assert) and **confirm the check is green ON CI**, not just 3× locally — CI runs
  the SwiftShader software renderer and lacks an OS H.264 encoder, so a flat
  pixel/encode assert that passes on your real GPU goes red on CI (recorderbox
  #687 / edges #688 burned cycles this way). Also **estimate the PR's CI
  wall-time delta and flag anything that adds >~2 min** before merge (heavy
  WebGL/video e2e on the software renderer is the main offender).

### NEVER express a renderer-dependent wait in MILLISECONDS — count FRAMES

The single highest-yield rule for WebGL/video e2e, and the one that has bitten
most often. A wall-clock budget silently becomes a **different number of frames
on every renderer**, so it is not one assertion — it is a different assertion
per machine.

Measured on backdraft PURE TV (#1214): **7.9 fps** under `E2E_SWIFTSHADER=1`
vs ~60 fps on a real GPU — **~7.6× before shard contention**, and CI runs *ten*
e2e shards in parallel on top of that. A 12 s budget was ~700 frames locally and
**~12** on the runner. The effect needs ~80 frames to build (the nest advances
exactly one level per frame), so the test could not pass on CI at any wall-clock
value that still looked sane locally.

- **Wait on a frame count in the page via rAF** (`waitFrames(n)`), not
  `waitForTimeout`. That is renderer-independent *by construction* rather than
  by tuning, and needs no per-machine calibration.
- Keep a wall-clock cap only to **bound the failure**, never as the gate — and
  bound frame-capture loops by time *as well as* count (40 frames at 8 fps is
  5 s of pure frame time, which is its own timeout).
- ⚠ **The ~2.5× "CI is slower" figure is a UNIT-LANE number** (vitest default
  5000 ms; locally-2 s tests timed out at 5.5–6.3 s). It is far too optimistic
  for anything touching WebGL. Do not carry it across.
- Reproduce under the renderer that actually failed — `E2E_SWIFTSHADER=1`
  exists for exactly this and is what caught both this and the gate-bridge
  pathology in #1192.

**Establish WHY before touching any budget.** "Slower on CI" and "the result is
genuinely different on CI" need opposite fixes, and only the first is a timing
problem. #1214 proved sameness first — 10 bands both renderers, brightness
ladder 1.000/0.741/0.631/0.561/0.506 vs 1.000/0.739/0.629/0.559/0.505 — and
only then treated it as a pacing bug.

### Flake-check NEW/changed tests **3×** locally before opening an MR

A single green local run proves pass/fail — it does **not** prove the test is
**stable**. Any test you **add** or **seriously change** must pass **3× in a row
locally with no flakes** before you push it for CI. (Scope this to the new/changed
test — you do **not** run the whole suite 3×.) Use the `REPEAT` env var on the
`*:one` targets (see next section):

```sh
REPEAT=3 flox activate -- task test:one -- my-new-thing      # unit (loops vitest 3×)
REPEAT=3 flox activate -- task art:one  -- my-scenario       # ART
REPEAT=3 flox activate -- task e2e:one  -- my-spec           # e2e (--repeat-each=3)
REPEAT=3 flox activate -- task vrt:one  -- my-card           # VRT
```

The run **fails on the first failing iteration**, so a flake can't hide behind a
later green run. If it flakes locally, fix the flake (diagnose run-bug vs.
test-bug — never just re-run) *before* the MR. A flake that only reproduces under
CI load (e.g. a `@collab` relay-contention timeout) still gets root-caused, not
tolerated — see the `feedback_no_flake_tolerance` discipline.

## Running ONE test locally (fast dev loop)

Dedicated `*:one` targets run a SINGLE test without the full suite, and a
long-lived server lets you iterate e2e/VRT specs without re-booting it each run.
All run through `flox activate -- …`. Prefix any of them with `REPEAT=3` to run
the test 3× and bail on the first failure — the pre-MR flake-check (above).

**Unit / vitest — `task test:one`** (defaults to the web package; `PKG=dsp|server|art`):

```sh
flox activate -- task test:one -- src/lib/ui/canvas/organize.test.ts   # one file
flox activate -- task test:one -- organize -t "deterministic"          # file + name filter
flox activate -- task test:one PKG=dsp -- cube                         # another workspace (PKG before --)
```

**E2E / Playwright — boot the server ONCE, then run single specs against it:**

```sh
flox activate -- task e2e:serve                       # start the dev server (port 5173) + leave it up
flox activate -- task e2e:one -- tests/ai-smoke.spec.ts   # a spec file
flox activate -- task e2e:one -- "title is patchtogether"  # a bare word/phrase → --grep ONE test
HEADED=1 flox activate -- task e2e:one -- tests/audio-gate.spec.ts   # watch it
flox activate -- task e2e:stop                        # tear down (don't leak dev-servers)
```

`e2e:one` runs 1 worker + line reporter and **fails fast** with a hint if the
server isn't up. It reuses the warm server via Playwright's `reuseExistingServer`
(`E2E_SKIP_WEBSERVER=1`), so steady-state single-test iteration is ~1.5s of test
time vs ~4s when each run boots its own server — and SvelteKit's on-demand route
compilation stays warm across runs. Add `E2E_PREVIEW=1` to serve/target the prod
`vite preview` build (port 4173) instead of dev. `task e2e:status` shows whether
the server is up.

**One VRT scene — `task vrt:one`** (reuses the same dev server if up):

```sh
flox activate -- task vrt:one -- adsr        # one card by grep
HEADED=1 flox activate -- task vrt:one -- scope
```

**One ART scenario — `task art:one`**:

```sh
flox activate -- task art:one -- moog911                          # by name
flox activate -- task art:one -- scenarios/meowbox/meow-c4.test.ts   # by path
```

**Fresh worktree without Faust?** The `*:one` audio targets depend on
`task dsp:ensure`, which reuses a current `packages/dsp/dist`, else builds with
Faust if available, else copies a prebuilt dist from the primary checkout
(`task dsp:fetch-dist`). So single-test runs don't fail on a missing DSP bundle
even before `@grame/faustwasm`/the Faust CLI is set up. (CI is unaffected — it
always compiles via the dedicated `dsp-build` job.)

> Note: the clean-state advice above (`rm -rf packages/dsp/dist`) still applies
> when you specifically want to catch a stale-artifact / SHA failure — run a real
> `task dsp:build` after, not `dsp:fetch-dist`, so you're testing this worktree's
> actual sources.

### VRT baselines: there is ONE SET and LINUX CI AUTHORS IT

`snapshotPathTemplate` has **no `{platform}` segment** (`e2e/vrt/vrt.config.ts`).
A baseline is one PNG at `__screenshots__/<spec>/<scene>.png`, written by the
`vrt-update.yml` capture job on ubuntu-latest. **You never commit a baseline.**

```sh
flox activate -- task vrt:commit          # dispatch the capture for THIS branch
flox activate -- task vrt                 # local smoke test: does it render, does it throw
flox activate -- task vrt:docker          # OPTIONAL pixel-exact local loop (needs Docker)
```

- **A local macOS run is not a verification.** It compares Metal-rendered text
  against a linux baseline, so it reports AA/font drift that is not a
  regression. That is the honest reading and it always was: before 2026-08-10 a
  Mac dev's green came from comparing against a `darwin/` set **CI never read**.
- `task vrt:docker` runs the suite in `mcr.microsoft.com/playwright:<pinned>-noble`
  — the image tag is derived from `e2e/package.json`'s `@playwright/test` pin, so
  a different Playwright means a different Chromium means different pixels.
  Docker is **optional**; nothing in the repo requires it.
- An intentional render change is reviewed as a **PR diff** through the
  changeset gallery ci.yml posts (OLD / NEW / DIFF with a slider), not by
  looking at PNG bytes.

**Why it was ever otherwise, and what it cost.** `{platform}` resolves on the
RUNNING machine, so a Mac dev wrote `darwin/` and CI read `linux/`. Two
populations, therefore divergence, therefore an apparatus to track divergence:
four gap-declaration mechanisms, three ratchets, a 617-line enumerator, a
per-platform capture matrix and a merge-collision surface. Measured on `main`
the day it was removed: **300 darwin PNGs, 156 linux, 146 darwin scenes with NO
linux sibling** — 146 scenes that looked covered everywhere and were never
diffed on the platform that gates. All of it is deleted; the sections that
documented drain order, the four mechanisms, and the dispatch gotchas went with
it. If you find a reference to `EXEMPT_BASELINE_PAIRS`, `darwinOnly`,
`VRT_PLATFORM`, `vrt-platform-gaps.ts` or `task vrt:audit`, it is stale prose.

**Three hazards survive the collapse — they were never about platforms:**

- ⚠ **`--update-snapshots` CANNOT regenerate a PASSING-but-stale baseline.**
  Playwright only rewrites on a FAILING comparison, so a scene genuinely out of
  date still commits **nothing** if its diff lands under tolerance. Found on A2
  (#1213): swapping filter's MODE from a bare detented knob to a labelled
  Segmented moved the dock face by **865 px** — a whole primitive swap — and the
  dispatch committed zero files, twice. **Fix: `git rm` the stale baseline
  first**; Playwright always writes a MISSING snapshot (`updateSnapshots`
  defaults to `'missing'`, and `'changed'` — what `task vrt:update` passes —
  explicitly creates missing ones too). The same arithmetic means the ordinary
  VRT gate would not have flagged that swap either. **Treat a green dispatch
  that committed nothing as a RED FLAG, never as "nothing to do", and COUNT the
  files the bot commits against what you predicted.**
- ⚠ **A `git rm`-ed baseline is SILENTLY RECREATED by the next plain VRT run.**
  `'missing'` *creates* an absent snapshot. The test still fails — *"A snapshot
  doesn't exist …, writing actual"* — so it is loud in the RUN OUTPUT and
  completely silent in the **tree**: what lands is an untracked PNG that no gate
  reads and that a `git add -A` will happily commit. **`git status` for
  untracked PNGs after EVERY VRT run in a window where you have deleted a
  baseline** — including read-only "did it still render?" runs you did not think
  of as captures. Measured on vca (#1429) before the collapse; the mechanism is
  unchanged, only the path is.
- ⚠ **Bare `--update-snapshots` is `=all` in Playwright 1.59** and had already
  rewritten 22 unrelated baselines once. `task vrt:update` passes `=changed`.
  The flag lives in the **Taskfile**, not in `e2e/package.json` — that file is a
  `TOOLCHAIN_PIN_FILE` in the WebGL attest basis.

**Two things the capture job can still get wrong, both worth knowing:**

- **The sweep is ONE job.** A single scene that cannot settle aborts the whole
  capture and nothing is committed. This is live: the 2026-08-09 darwin regen
  died on `face-mixer-compact` and `face-ringback-dock`, both tripping #1420's
  `AudioContext is 'running', not 'suspended', at CAPTURE time` guard. **The
  guard is correct** — a face glyph is an AnalyserNode view, and baselining it
  off a running graph is baselining a moving target — so the fix belongs in
  whatever leaves the context running.
- **A capture that rewrote nothing still SUCCEEDS.** `vrt-commit-baselines.sh`
  emits `pushed=false` and a `::warning::` for exactly that case, and
  `revalidate` reads it so an unchanged branch does not burn a close+reopen
  cycle. (`revalidate` exists because a GITHUB_TOKEN push does not fire CI and a
  `workflow_dispatch` run does not count toward a required-status gate —
  confirmed on #524.)

### A FOOTER can move every dock baseline — the mechanism is HEIGHT, not pixels

Added 2026-08-09 (#1425). A new footer readout re-pinned **133** baselines
(two platform sets then; one now) and made `vrt-strict` red on a *different card each cycle*
(15 → 2 → 2 → 1). It looked like a card-render bistability. It was arithmetic.

Measured at the VRT viewport (1280 CSS px, AudioContext booted — the state the
scenes actually capture): `.status` 545.063 px + `.cable-legend` 547.625 px +
35 px padding leaves **147.313 px** of free space. The readout wanted 295 px.
`.cable-legend` compressed until its `li` text wrapped, the bottombar went
**32.375 px → 41 px**, and the canvas lost the same 8.6 px. Every dock and
faceplate scene is laid out *inside* that canvas.

- **Chrome that is not in frame can still move a baseline** — through the
  layout, not the pixels. Before adding anything to the topbar or footer,
  measure the row's free space and the bar's height with and without it.
- **Re-pinning is the wrong response.** It re-pins whichever scenes happened to
  land on the wrong side of the tip *this run*, so the failure appears to move.
  Restore the baselines and fix the layout: with bar height back to main's,
  `vrt-strict` went green with **zero** re-pins, and the only baselines that
  legitimately moved were the **7** page-level captures with the footer in
  frame (`workflow-shell-zoom` ×3 per platform, `workflow-dock-composite` ×1 —
  counted across the two baseline sets that existed then).
- **Gate it in a browser.** A unit test cannot see a flex row wrap, and *where*
  it wraps depends on platform font metrics. `audio-health-readout.spec.ts`
  hides the element and asserts the bottombar height does not move, with a
  second leg asserting the row DOES get narrower so the first cannot pass
  against an out-of-flow element.

### ⚠ `task vrt` / `vrt:update` used to ignore `E2E_PORT` — a green sweep of the WRONG BRANCH

Same day, same PR, and the more transferable half. `vrt.config.ts` reads only
`E2E_BASE_URL`, defaults to `http://localhost:5173`, and sets
`reuseExistingServer: true`. The full-sweep tasks never derived that from
`E2E_PORT` (only `e2e:one` and `vrt:one` had been hardened), so a
`E2E_PORT=5251 task vrt` in an isolated worktree returned **"276 passed, 1
failed" in 11.5 minutes having never loaded the branch under test** — it
rendered the primary checkout's `main` server while comparing against this
worktree's baselines. Three scenes that `vrt:one` had just failed at ~3200 px
each came back green.

Fixed in the Taskfile (all three route through `vrt:run`), but the rule
generalises: **an isolation mechanism that only half the entry points honour is
not isolation.** When you add an `E2E_PORT`-style knob, grep every caller — and
prefer failing loudly over silently falling back to a shared default.

Two more from the same session, both cheap:

- **A toolchain PIN file hashed WHOLESALE makes every unrelated edit a
  re-attest.** `e2e/package.json` is in `TOOLCHAIN_PIN_FILES`
  (`scripts/webgl-attest-lib.ts`) because it pins `@playwright/test` — the
  renderer version. The basis used to hash the whole file, so changing one
  unrelated npm-script string moved the WebGL hash `620fa1b3…` → `ad300c3e…`
  and turned `webgl-attest` red, demanding a trusted-machine GPU re-attest for
  a one-word CLI flag. **FIXED 2026-08-09**: package.json pins are now hashed by
  their dependency/config surface only (`NON_CODE_PACKAGE_JSON_FIELDS` in
  `scripts/attest-code-basis.ts`), so scripts and prose are free while a dep
  bump still counts. `.flox/env/manifest.toml` IS still hashed wholesale —
  before editing it, run `bash scripts/webgl-attest-hash.sh` before and after.
  The hash cannot tell a pin bump from a comment there; only you can.
- **Screenshot the thing and look at it.** `display: inline-flex` on a label +
  value pair drops the whitespace-only anonymous flex item, so the footer read
  `lat13.3/40.0ms drop0/0.0ms tick9ms`. Every text assertion still passed —
  `toContainText(/drop \d+\/\d/)` matches `drop0/0.0ms` perfectly well.

## Worktrees: hard cap of 10

This repo accumulates abandoned `isolation: worktree` agent checkouts fast — each
carries a dead lock plus its own `node_modules`, and they bury the few worktrees
actually in flight. **Never keep more than 10 git worktrees.**

Before creating a new worktree (`git worktree add`, or spawning an agent with
`isolation: "worktree"`):

1. Run `flox activate -- task worktree:guard`.
2. It prunes gone worktrees and removes **abandoned** ones — dead agent-lock
   process **and** a clean tree **and** fully pushed (nothing exists only on
   disk, so no work is lost) — then re-counts.
3. If it's still over 10, it **exits non-zero** and lists the worktrees that
   need a human: dirty trees, unpushed commits, no upstream to verify against,
   plus any genuinely live agents. **Stop and resolve those** — push / commit /
   discard, then `git worktree remove <path>` — or set `WORKTREE_CAP=N` for a
   deliberate one-off, before creating another worktree.

Other entry points:
- `flox activate -- task worktree:list` — classify everything, change nothing.
- `flox activate -- task worktree:clean` — auto-remove abandoned ones only.

Tooling: `scripts/worktree-guard.sh` (`report` | `clean` | `enforce [N]`).

## Post-merge conflict sweep

Module *registration* is now glob+palette-driven (PR #551), so `modules/index.ts`,
`Canvas.svelte`, `module-categories.ts`, and `graph/types.ts` no longer collect
per-module appends — they are no longer the conflict surface. The remaining
hand-maintained list files that concurrent PRs still collide on are:

- `packages/web/src/lib/docs/module-manifest.ts` (`DESCRIPTIONS`)
- `e2e/vrt/vrt-exemptions.ts` (`EXEMPT_FROM_VRT` / `ALLOWED_PERMANENT_EXEMPT`)
- `packages/web/src/lib/ui/modules-card-map.test.ts` (`EXPECTED_NODE_TYPES`)
- the per-port / VRT spec lists (`e2e/tests/per-module-per-port*.spec.ts`)
- `packages/web/src/lib/control/push2/push-card-config.ts` (`PUSH_CARD_CONTROLS`)
  — the owner-editable PUSH CARD schema (which 8 controls each module puts on
  the Push 2 display). Hand-maintained like `DESCRIPTIONS`; its typo gate is
  `push-card-schema.test.ts`, and the AUTHORED-card goldens in that same file
  are an accept-loop — an intentional edit updates both in ONE commit.
  ⚠ Because a push card is resolved from the LIVE def, **adding or renaming a
  param on any module can silently change that module's push card.** The face /
  generic tiers re-rank themselves, so a new param declared early in `params`
  walks onto the generic card and pushes the 8th control off. If a module's
  card matters, give it an explicit entry here — an override REPLACES, so it
  cannot drift.
- `packages/web/src/lib/docs/strict-docs.ts` (`STRICT_DOCS`) — hand-maintained.
  The GENERATED living-docs golden (`contract-lock.txt`) also collides: on
  conflict, take main + re-run `flox activate -- task docs:accept` to
  regenerate — never hand-merge it. (`module-docs.generated.ts` is no longer
  committed — it's a gitignored build artifact, so it can't conflict.)
- `docs/testing/test-ledger.generated.md` — the GENERATED 3-bucket test ledger
  (skips/exemptions/informational-lane counts). Collides like `contract-lock.txt`:
  on conflict, take main + re-run `flox activate -- task test:ledger:accept` —
  never hand-merge it. (Prose/roadmap: `docs/testing/README.md`.)

**Whenever a PR merges to main, look ahead: sweep the other open PRs for conflicts
the merge just created on those files, and rebase them** before they rot into
`CONFLICTING` (which silently blocks them from shipping).

1. After a merge, run `flox activate -- task pr:conflict-sweep` (GitHub
   recomputes mergeability async, so it polls). It lists the open PRs that now
   conflict with main.
2. Rebase each: `git fetch origin && git checkout <branch> && git merge
   origin/main`, resolve, then **verify your additions survived** (e.g.
   `git grep <your-symbol>`), and push.

**Never use `gh pr update-branch`** on PRs touching the shared registry files —
it silently drops the PR's additions when auto-merge picks main's version of a
conflict, with no marker. Always `git merge origin/main` locally and diff.

## VALIDATE THE INSTRUMENT — a wrong metric reads exactly like a finding

> **Deeper treatment lives in the `blind-gates` skill** (`.claude/skills/`), with
> the negative-control discipline worked through case by case; the renderer/frame
> material is in `iterated-render-e2e`. **This section is the always-loaded
> summary — when the two disagree, the skill is the detail and this is the rule.**
> Keep the measured numbers in ONE place (the skill) so they can't drift.

The unifying failure of the 2026-07-28 backdraft session. **Four separate times
the measurement was wrong and its output looked authoritative.** None of them
announced themselves; each produced a confident, plausible, false conclusion.

- **Pearson correlation is invariant to global brightness**, and the sampled lags
  were *even* — so a genuine period-2 limit cycle read as `corr = 1.0` and the
  conclusion was "the servo doesn't oscillate". It did.
- **`getBoundingClientRect()` under xyflow's zoom transform** reported a 310 px
  overflow as 230 px. Sizing from it would have under-provisioned by ~25 %.
- **A wall-clock budget** is a different number of frames on every renderer, so
  "12 s" was ~700 frames locally and ~12 on CI (see the frame-count rule above).
- **A gate that reads only the def** cannot see a card contradicting it (below).

**Before believing a measurement, ask what it is invariant to.** A metric blind
to the very dimension under test will happily return a clean number. Cheap
defences, in rough order of value:

1. **Negative-control the instrument, not just the code** — perturb the thing it
   claims to measure and confirm the number moves. If it doesn't, the metric is
   wrong regardless of what the code does.
2. **Sample at co-prime / irregular offsets** when probing anything periodic; an
   even lag against a period-2 signal aliases to a constant.
3. **State the units in the assertion message** (`CSS px` vs `screen px`,
   `frames` vs `ms`). Half these bugs were unit confusions that a printed label
   would have exposed immediately.
4. **Reproduce under the environment that actually failed** before theorising —
   `E2E_SWIFTSHADER=1` settled two of these.
5. **Never sample a page-side quantity with a Playwright-side poll loop.** Added
   2026-08-02 (`workflow-master-transport`, shard 10). A `while (Date.now() <
   deadline) { await page.evaluate(read); await waitForTimeout(50) }` is one
   `page.evaluate` round-trip per sample **on the same main thread as the thing
   it measures** — so a loaded runner starves the subject and the sampler
   *together*, and a stalled thread can burn the whole 4 s window in two reads
   and then report "the clock never advanced" off a sample size of two.
   "Frozen" and "never looked" both print `Received: 1` and are
   indistinguishable from the output. **Move the accumulator INTO the page**
   (`page.evaluate` returning a Promise, sampling on a `setInterval` finer than
   the tick under test): it adds no protocol traffic, and the accumulated Set
   *survives* a stall, so a thread that freezes for 3 s and then runs still
   reports every value it computed. Report `samples` / `elapsedMs` / the values
   seen in the assertion message — that is what makes the next red run
   diagnosable instead of a coin flip. Measured: the reworked scan reads 200×
   in 4 s where the old loop managed a handful.

⚠ And the meta-tell: **"the result is genuinely different here" and "the
instrument reads differently here" look identical from the output alone.**
Establish which before acting; they need opposite fixes. ⚠ And when the fix is
to the INSTRUMENT, negative-control it in **both** directions before believing
it — force the subject frozen (the advance gate must go red) *and* force it
ever-running (the freeze gate must go red). Better still, make one of those a
PERMANENT leg of the test, so the instrument is negative-controlled on every
run rather than once at authoring time.

## A CARD can silently disagree with its DEF — every def-reading gate is blind to it

**Ask of any new gate: what is it structurally unable to see?** Two holes of this
exact shape were found on one card in one day.

**The bug (backdraft, 2026-07-28).** The def constrained `camTiltX/Y` to ±0.2 and
`camPosX/Y` to ±0.5. `BackdraftCard.svelte` passed literal `xMin={-1} xMax={1}`
to both `XyPad`s. That is **not** a display bug — the pads *wrote values the
contract forbids*, the model silently clamped them, and most of the stick's
travel did nothing. The control lied about its own range.

**Why nothing caught it:** `contract-lock`, `module-docs-lint` and the range
assertions **all read the DEF**. The e2e never touches the pad. So a card
disagreeing with its own def is invisible to the entire gate set, and the work
was honestly reported as "ranges constrained ✓" while the UI was still ±1.

- **A control's range must come from ONE place.** Export the range from the def
  module and have the card import it — never re-type the numbers in the card.
- **Guard it at the SOURCE level**, since no runtime gate sees it: grep the card
  for hardcoded ranges on any control whose def declares them. Precedent already
  in the repo: the `controlFamilies` → card-testid grep in
  `module-docs-lint.test.ts`, which exists for this same divergence class.
- The general rule: **a gate that reads only one side of a two-sided contract
  proves nothing about the other side.**

### A GUARD FOR THAT CLASS THAT IS OPT-IN IS ITSELF AN INSTANCE OF IT

**Audited 2026-08-02. Four gates, all green, all structurally unable to see the
bug class they exist to catch — because each applied a FILTER before the check
that quietly redefined the check's subject.** Coverage before → after:

| gate | the filter | saw | could not see |
|---|---|---|---|
| `mutate.guard`'s `RAW_PARAM_WRITE` | `\.params\[…\]` — **bracket only** | 3 | **96** dotted writes |
| `card-range-source`'s `RANGE_BOUND_CARDS` | an **opt-in filename list** | 7 cards | **186** cards |
| `module-docs-lint`'s edge check | `if (!p.edge) continue` | 63 ports | **299** gate ports |
| `faces-parity`'s `action` branch | *no probe at all* | 0 | **every** dead audition |

The self-tests were blind the same way (the raw-write self-test only ever fed
itself the bracket form), so nothing could have gone red. **Ask of any new gate:
what is it structurally unable to see — and would its green run look any
different if the answer were "everything"?**

The three inversions, applied to all four (details + measured numbers in the
`blind-gates` skill):

1. **Deny by default with a NAMED exemption per instance** — the exact
   `(file, key)` / `(module, port)` / `(card, param, field)` triple, never a
   filename, so a new defect in an already-listed file still reddens.
2. **Anchor to the ARTIFACT, not the list** — a ledger entry naming something
   that no longer exists is RED. A stale exemption is one nobody is watching.
3. ~~**Ratchet in BOTH directions**~~ — **superseded 2026-08-10.** Inversions 1
   and 2 stand; the count does not. Where the old advice was "cap the
   population and assert the cap has no slack", the rule is now **do not have a
   count**: name each instance, anchor the names to the artifact, and let the
   diff be the review. See "NEVER hand-type a population count" below.

Plus: **state the gate's scope inside the gate**, asserting what it still cannot
see — at zero, or in prose with the measured number if it genuinely cannot be
asserted.

## NEVER hand-type a population count

**Never write a new hand-typed population count.** Not a ceiling, not a floor,
not a "frozen at N" — no literal whose value is *how many of something there
are*. This is a P0 owner directive (2026-08-10): *"i want to eliminate the need
for any of this. i don't want to have to track this data"* … *"eliminate
ratchets entirely even if we lose test coverage as a result"*. Nine were deleted
in the first sweep and coverage loss was pre-authorised. **Silent coverage loss
was not** — every protection dropped is named in that PR's body.

**The sweep is FINISHED (Phase 3, 2026-08-12).** Phase 1 took nine; Phase 2
(#1458) took the three VRT platform ceilings by deleting the dimension that
produced them, plus `MIN_TOKEN_PINNED_BASELINES` and the gallery's three
baseline-tree floors. Both phases claimed completeness from a hand-made list and
both were wrong, so Phase 3 built the inventory MECHANICALLY (three independent
searches — named SCREAMING_CASE integer constants used to bound a cardinality;
integer-vs-cardinality comparisons inside files that enumerate the tree;
`expect(<cardinality>).toBe*(N≥2)` anywhere) and closed the tail. **There is now
no hand-typed population count in `packages/`, `e2e/`, `scripts/` or `art/`** —
with ONE known outstanding instance, deliberately not touched:
`EXPECTED_HEAVY_SPEC_COUNT = 58` in `webgl-attest-coverage.test.ts`, which PR
#1479 already removes on its own branch with a stronger property assertion.
Duplicating that removal here would have conflicted with the better version, so
this is the last one and it belongs to that PR. **If it is still on `main` after
#1479 lands, that is a bug in this claim.**

- **The searches, so the next agent can re-run them rather than re-guess:**
  `git grep -nE '_CEILING|_FLOOR|EXPECTED_[A-Z_]*COUNT|FROZEN'`, plus
  `toBeLessThanOrEqual\(\s*[0-9]+` / `toBeGreaterThanOrEqual\(\s*[0-9]+` /
  `toHaveLength\(\s*[0-9]+` filtered to lines whose subject is `.length` /
  `.size` / `Object.keys(...)`, plus `git grep -ni ratchet`.
- ⚠ **What that search set is structurally unable to find, stated rather than
  assumed:** a count with no name and no cardinality vocabulary on its line
  (e.g. a magic `31` compared against a variable computed three lines earlier);
  a count in a language the grep does not cover (`.py`, `.sql`, workflow YAML
  expressions); and a count living in PROSE, which reddens nothing but rots the
  same way. Prose figures were left in place only where they are dated, labelled
  as measurements, and carry the command to re-derive them.

**If you find one anyway, it is a bug in that claim — delete it, do not
maintain it**, and never re-derive a count "just for this one".

**Why, measured.** Three faces were authored concurrently from a base of
`9 / 7` (`card-range-source.test.ts`). cube wrote `10 / 8`; clouds and cofefve
each independently wrote `11 / 9`. The merged truth was `12 / 10`. **Every agent
counted correctly for the tree it was standing in** — the value was stale the
moment a sibling merged. Git surfaced it only because two explanatory comments
happened to differ; had either agent left its comment alone, `11 / 9` would have
**auto-merged cleanly and wrongly** — no conflict, no red test, no marker, and a
full card of slack in a `<=` ratchet for the next regression to hide in. It had
already happened three times on that one file, and three times on the edge
ledger (288 / 277 / 287 where the truth was 275). A value that is correct when
written and wrong when merged, through nobody's error, is the wrong data
structure. **This is a property of the construct, not of anyone's care.**

**What to write instead**, in preference order:

1. **An unconditional assertion.** A ceiling of 0 measures nothing and can only
   go stale — write `expect(offenders).toEqual([])`.
2. **A NAMED deny-by-default list**, each entry carrying the specific
   `(module, scene, reason)` triple and a `why`, anchored so a name that no
   longer resolves is RED. A name is checkable against the tree; a number is
   not. **Better still, put the `why` in the TYPE** — `MaskRect.why` and
   `VrtScene.freezeAudioWhy` are required fields, so `tsc` refuses the
   undeclared form before a test runs (verified: removing one turns
   `task typecheck` red).
3. **A DERIVED assertion** — read the population off the artifact and assert a
   property of it, never its size. `stereo-pairs.test.ts` asserts "no audio port
   carrying an L/R token sits outside a pair" where it used to assert
   "unpaired === 203".
   **The strongest form of this is DERIVED MEMBERSHIP, and it is what retired
   the STRICT_\* floors.** A "this set only grows" floor exists to stop a silent
   un-promotion; if membership is a PROPERTY OF THE DEF, assert that instead and
   the floor is not merely redundant but strictly weaker. `STRICT_DOCS` is now
   "every module whose co-located `docs` are COMPLETE", `STRICT_FACES` is now
   "every def that declares a `face`" — both asserted in both directions, so
   deleting a name while the property holds is RED. Measured before converting:
   **zero** modules were complete-but-unpromoted or faced-but-unpromoted, so
   both pinned the live state rather than raising the bar — and the floors they
   replaced had **13** and **14** slots of slack respectively, i.e. neither
   would have noticed the un-promotion it was written for.
4. **A GENERATED artifact on the accept loop**, when review visibility of a
   whole population is genuinely needed: `contract-lock.txt`,
   `test-ledger.generated.md`, `fingerprints.generated.json`. Regenerated by
   `task *:accept`, reviewed as a diff, conflict-resolved by "take main + re-run
   accept". Never hand-merged, never arithmetic.

**There is no standing exception, and as of Phase 3 no instance of one.** The
narrow case the rule used to hold open — debt that genuinely cannot be paid now
(needs hardware, an owner decision, a re-attest window, a platform migration) —
is now: **derive the number from the artifact, never type it, and state the
deletion criteria in the file**. The three VRT platform ceilings
(`LINUX_DEFICIT_CEILING`, `SHARED_LINUX_PAIR_CEILING`, `STALE_PAIR_CEILING`)
were the last instance, and #1458 is the criteria being met: they vanished with
the `{platform}` dimension and **no successor counter was written**. That is
what paying one looks like — you delete the mechanism, you do not re-scope it.

**What NOT to mistake for a ratchet** (over-deleting a real constant is its own
bug, and the Phase 3 probe returned 367 hits of which the overwhelming majority
were these):
- **policy thresholds on a DERIVED measurement** — a shard budget at 85 % of a
  *configured* timeout, a warn band, a headroom margin. The literal is a POLICY,
  and it does not change when the tree grows.
- **layout / physical constants** — `DOCK_TAB_MIN_BANDS`, cell heights, sample
  rates, buffer sizes, FFT sizes, MIDI ranges.
- **prose-quality floors** — `why.length > 40`. A reason string is not a
  population.
- **assertions over a fixture the test itself built** — `expect(parse(input))
  .toHaveLength(3)` where `input` is a literal three lines up. This is the
  single largest false-positive class; a `toHaveLength(N)` is only suspect when
  its subject came from a glob, a registry or a directory walk.
- **VACUITY FLOORS with real slack** — `expect(defs.length).toBeGreaterThan(150)`
  against ~196 defs is a "the glob resolved something" guard that never needs
  bumping, because only a DELETION can trip it. ⚠ But **check the slack**: three
  such floors in `mono-normal-not-defeated.test.ts` sat exactly ON the
  population (63 files against 63, 10 stereo modules against 10), which makes
  them ratchets in behaviour whatever they are in intent. The fix is not a
  bigger gap — it is to anchor the non-vacuity check to a NAME the population
  must contain, or derive it from a named list.

⚠ **When you delete one, check what it protected FIRST.** Phase 1 found two of
the plan's three "this is redundant" claims were WRONG on measurement. #1458
traced `MIN_TOKEN_PINNED_BASELINES` (200) to three surviving name-anchored
checks that each catch its stated failure before removing it, and kept that
trace where the constant stood. "It is a count, therefore delete it" is not the
rule; "a count is never the right SHAPE, so find the shape that is" is.

**And do not inventory payable debt.** A ledger of *known answers* is deferred
typing, and every agent who touches the area afterwards pays a re-count tax.
Before writing an exemption list, ask whether the answer already exists in the
tree. When the debt is paid, **delete the mechanism entirely** — list, count,
both-directions assertion, stale-entry anchor — and leave no replacement
counter. What remains is the unconditional check plus a permanent negative
control calling the **same predicate** the check calls.

#### …and the LEDGER you invert it with is the NEXT blind spot

Row 3 above was fixed right and then parked wrong. The 299 skipped ports went
into a ledger with a hand-typed count instead of being declared — even though
**295 of them already carried authored prose naming the answer**. Paying it in
full took one session and moved 283 `contract-lock.txt` lines, every one of them
the old line plus one `edge=` token. Three rules, now repo standard:

1. **Pay mechanically-payable debt; never inventory it.** A ledger of *known
   answers* is deferred typing, not engineering, and every agent that touches
   the area afterwards pays a re-count tax. Before writing an exemption list,
   ask whether the answer already exists somewhere in the tree.
2. **Not even unpayable debt gets a typed count** (superseded 2026-08-12 — this
   line used to say "a ratchet is legitimate only for debt that cannot be paid
   now"). If the debt is genuinely unpayable, the number is **DERIVED from the
   artifact** and the file states its deletion criteria; there is no version of
   this where you type the literal. Measured: the literal auto-merged WRONG in
   **3 of 3** parallel branches (288 / 277 / 287 where the truth was the union,
   275); two collided so git surfaced them, the third merged **cleanly and
   wrongly**.
3. **Any migration counter ships with its DELETION CRITERIA stated in the
   file**, or the scaffolding outlives the building.

When the debt is paid, **delete the mechanism** — list, count, both-directions
ratchet, stale-entry anchor — and leave **no replacement counter**: at zero it
measures nothing and can only go stale. Keep the unconditional check plus a
permanent negative control that calls the **same predicate** the check calls
(a re-typed copy in the self-test is how the previous one went blind).

⚠ **Before "fixing" a declaration to satisfy a gate, check the consumer reads
it.** Four cards pass `curve="linear"` where the def says `discrete`; writing
`curve="discrete"` would green the gate and change nothing, because all four are
`<Knob>` and `Knob.svelte` has no `discrete` branch (`Fader.svelte` and
`knob-conic-model.ts` both do). That is a green gate certifying a live bug.

### An ACTION-shaped cell needs a probe, exactly like a PANEL does

`ShellActionCell.probe` is **required**. An audition writes nothing to the graph
by design, so `readParam`/`readData` are structurally blind to it — the
observable is the **audition ledger** (`$lib/ui/modules/audition-ledger`), which
records per press whether the seam resolved a callable off the live engine handle
and called it. `delivered: false` is recorded, never dropped: "pressed and
reached nothing" must be distinguishable from "never pressed".

The predicate is negative-controlled in **both** directions in the unit lane on
every run (`audition-ledger.test.ts`), which is the permanent leg; the e2e side
was verified once by disconnecting karplus's `manualTrigger` read key and
watching `faces-parity` go red at the probe — with `toBeEnabled()` and `click()`
both still passing, which is the finding in one line.

**The sibling hole, same card, same day.** `card-control-overflow` only ever
spawned the module in its DEFAULT state, so controls revealed by a mode switch
were never measured — it missed a ~310 px overflow for hours. When a module has
modes, the sweep must enter them, and **assert the mode's controls are actually
mounted** so it cannot silently re-measure the default layout.

⚠ **That spec reports VIEWPORT-SCALED pixels, not CSS pixels** —
`measureOverflow` uses `getBoundingClientRect()` and xyflow applies a CSS
transform for viewport zoom. Pass/fail is scale-invariant (0 is 0), but every
*magnitude* is scaled: a 720 px card reads as ~530 at 0.736 zoom, and a ~310 px
CSS overflow prints as ~230. **Never size a card from the printed number**, and
never compare overflow figures across spawns unless the zoom matches.

## Living docs: the contract gate + the document-on-touch ratchet

Module documentation is PINNED to the I/O CONTRACT — like ART pins audio to a
source-SHA and VRT pins a card to a baseline image. When a module's contract
changes, the build NOTICES and forces a human to re-author the doc or recognize
a bug. AI may draft the prose; deterministic, zero-flake unit gates hold the line.
(Design + research: `.myrobots/plans/living-docs-drift-2026-06-24.md`.) Three tiers:

- **GENERATED** — the I/O reference (cable types, ranges, cv/edge sentences):
  derived from `PortDef`/`ParamDef` by `io-explain.ts`. Never hand-authored.
- **AUTHORED** — behavioral prose CO-LOCATED on the def in a
  `docs: { explanation, inputs, outputs, controls }` field (so a port change and
  its doc edit land in the SAME PR diff). Dynamic DOM-only controls (step grids,
  transports) declare a `controlFamilies` entry; `docs.controls` keys are param
  ids or `<familyId>-{n}` templates.
- **PINNED** — `contract-lock.txt` (the committed contract golden). GENERATED —
  never hand-edit. It is the ONLY committed living-docs artifact:
  `module-docs.generated.ts` (the render module the prerendered doc page
  imports, since it can't import the live registry) is a gitignored BUILD
  ARTIFACT, regenerated by the `docs:ensure` seam (the module-docs-ensure spec
  on every full unit sweep; `task docs:ensure` as a dep of
  build/build:web/dev/typecheck; a setupFiles + vite-plugin fallback for
  missing-artifact boots).

Gates (pure-unit, `unit` lane, ~0 added CI wall-time):
- `contract-lock.test.ts` — the contract golden. A port/param/control/flag
  change flips it red with a readable line diff.
- `module-docs-ensure.test.ts` — the render-module seam: on-disk artifact
  matches the live def docs, the generator is deterministic, and the artifact
  stays gitignored (contract-lock.txt stays the only pinned artifact).
- `module-docs-lint.test.ts` — orphaned-key consistency, COMPLETENESS for the
  `STRICT_DOCS` set (every port/param/family documented = deny-missing-docs),
  edge/gate vocabulary coherence, and the `controlFamilies`→card-testid grep.

Accept loop: after an INTENTIONAL contract or docs change, run
`flox activate -- task docs:accept` (re-pins the golden; the render module
refreshes itself as a build artifact), then **review the `git diff`** (a diff =
a contract changed: accept it, or recognize a bug). `task docs:check` runs the
gate read-only.

**THE RATCHET** (how the bar self-enforces, no migration push):
- Every **new** module ships with co-located `docs` and is added to `STRICT_DOCS`
  (`packages/web/src/lib/docs/strict-docs.ts`).
- Any module you **incidentally touch** for a fix is brought up to the bar then
  (boy-scout rule) and added to `STRICT_DOCS`.
- Background batches of ~5 promote the rest over time (author via agents from the
  real source + memories, then adversarially fact-check against the code).

Doc page rendering is currently AUDIO-only (the doc-page manifest is built by an
audio-only `?raw` regex parser); VIDEO modules are gated + authored but have no
`[id]` doc page yet — including them is a known follow-up.

### The attests hash CODE, not bytes — docs are ignored BY DESIGN

**Write documentation anywhere. There is nothing to remember.** Owner directive
2026-08-09: *"docs should not need explicit ignore, they should be ignored by
design; only code that is, you know, code, should be considered."*

`scripts/attest-code-basis.ts` is THE one place that decides what counts as code
for **every** attest hash — webgl, collab, grand — **and** the ART pattern-3
source pins. It parses each basis file with the real TypeScript parser, drops
the documentation nodes, and re-emits with `removeComments`. Removed from the
hash:

- **all comments** — line, block, JSDoc, and inside a `.svelte` `<script>`;
- the **`docs` / `controlFamilies` / `face`** properties of a **module-scope**
  def object literal (`export const fooDef = { … }`);
- **type-only imports** (`import type { ModuleDocs } …`) — erased by the
  compiler, so adding docs to a def that had none is free too;
- a package.json pin's **npm-script and prose fields** (deps still count).

**String safety is a property of the PARSER, not of a pattern.** A `//`-stripping
regex eats `'https://x'`, `` `a // b` `` and `/[//]/` — and so does a bare
`ts.createScanner()` loop on the last one, because `/` is only re-scanned as a
regex literal when the *parser* asks. `scripts/attest-code-basis.test.ts` feeds
all three hostile forms in as a permanent leg.

Every "is ignored" claim there is paired with an "is **not** ignored" twin, per
attest, against the REAL `compute*Hash` over the REAL basis (an injected
`BasisReader` perturbs one file): a comment-only edit and a docs-only edit leave
the hash byte-identical; a param range / port id / shader line / relay branch
edit moves it. A normalizer that returned `''` for everything could not pass.

⚠ **What it still cannot see** (raw-hashed, so a comment edit there DOES cost a
re-attest): `.toml`, `.sql`, `.snap`, and Svelte **markup** comments. That set is
named in `EXPECTED_RAW_BASIS_FILES` and asserted exactly — a new raw-hashed
basis file goes red rather than passing as covered.

⚠ **A nested `face:` is NOT stripped** — only a def's own top-level one. A WebGL
module may carry `face:` on a geometry object, and stripping that would be a
*missed* re-attest, the unsafe direction. Negative-controlled in both directions.

**This replaced 79 `docs-hash-ignore` marker pairs across 77 source files** plus
`video-docs-marker.test.ts`, whose entire job was catching a forgotten marker
before it cost a ~10-min GPU re-attest. It also closed the asymmetry that WAS
the bug: the escape hatch used to live in `webgl-attest-lib.ts` and nowhere
else, so two pure comment lines under `packages/server/src` forced a full relay
re-attest (#1422), and a one-word npm-script edit in `e2e/package.json` forced a
GPU one (#1425). Both are now no-ops.

(A change to the attest LOGIC or to a real contract field is still a legitimate
one-time re-attest. The 2026-08-09 conversion was exactly that: one re-attest
for all three, basis file LISTS verified byte-identical across the change.)

## ART baselines and the fingerprint manifest are ONE truth — re-pin BOTH

`art/baselines/**/*.f32` (+ `.sha`) and
`packages/web/src/lib/art/fingerprints.generated.json` are two artifacts of the
same truth. Re-pinning a baseline without re-pinning the manifest leaves the
manifest stale — which is exactly what #1174 did to `delay/audio` (an
owner-approved equal-power dry/wet fix, +3.01 dB): CI stayed green and the gate
went red only on fresh LOCAL checkouts.

- **Use `flox activate -- task art:update`.** It now chains
  `art:fingerprints:accept`, so the manifest cannot be forgotten. If you re-pin
  a baseline by any other route, run `task art:fingerprints:accept` yourself.
- **REVIEW the manifest diff entry by entry** — it is the accept-loop, same as
  `docs:accept`. The diff tells you what kind of change you made: a
  **labels-only** move (`peakDb`/`rmsDb`) is a pure LEVEL change, while a
  **spectrum/features** move is a TIMBRAL change. A uniform +3.01 dB on both
  peak and RMS with a byte-identical spectrum is the signature of a ×√2 scalar
  gain (e.g. linear→equal-power at mix 0.5). **Any entry you cannot attribute to
  a known intentional change is a real audio regression — stop, do not re-pin.**
- Every entry pins a `sourceSha256` (the sha256 of the `.f32` it was computed
  from, which equals the file's git-LFS oid). `fingerprints.consistency.test.ts`
  check (d) verifies it on EVERY lane — it needs no python, numpy or LFS, so it
  catches baseline↔manifest drift even on an `lfs: false` checkout.

**A gate that cannot fail on CI is decoration.** The byte-exact drift gate needs
materialized LFS bytes + numpy, so it runs in the ci.yml **`art`** job (the only
lane with the real `.f32` bytes) under `ART_FINGERPRINTS_REQUIRED=1`, which makes
it FAIL rather than skip-pass if that environment ever loses those inputs. When
you add a probe-and-skip test, ask where it can actually run — and give it a
loud-skip env flag in the lane that promises to run it (the
`rackspaces-capacity.test.ts` "refusing to skip-pass" precedent).

## Standard/skill updates land with in-flight work

When a new repository standard or convention is introduced mid-development,
fold it into whatever PR is already in flight (e.g. this file + its tooling) —
don't spin up a separate ceremony PR for it. Fewer in-flight PRs = fewer of the
shared-file conflicts the sweep above exists to catch.

## Merge only on THIS PR's final-commit green

**Do not merge until THIS PR's CI run is green on its FINAL commit** — not an
earlier run, not a still-running run, not "the last push was green and this one's
trivial". The run that gates the merge must be the one built from the exact SHA
you're merging.

A **red push run on `main` is a P0** to root-cause immediately — never absorbed
as "flake". (Synesthesia #698 merged near-red after two FAILED PR runs with only
a just-started green run; it broke main CI and spawned #699/#701/#702 the same
day. See also `feedback_never_merge_on_red_collab_is_doom_gate` and
`feedback_no_flake_tolerance`.)

## Docs-only PRs: the path lists in ci.yml and docs-only-gate.yml move TOGETHER

`ci.yml` skips a prose-only change (`paths-ignore: ['**/*.md', '.myrobots/**',
'LICENSE']`) so a typo fix doesn't burn ~25 min. But ruleset 16042163 REQUIRES
`typecheck + unit + ART + E2E` and `vrt-strict (visual regression — strict
subset)`, and a path-skipped workflow reports NOTHING — GitHub treats a
never-reported required check as pending FOREVER, so the PR sits `BLOCKED` with
zero failures and can never auto-merge (#1184).

`.github/workflows/docs-only-gate.yml` breaks that: it fires on the **exact
inverse** filter (`paths:` with the SAME list) and posts those two contexts as
commit statuses — but only when **both** guards agree: every changed file is a
doc **and** GitHub started no `ci.yml` run for that head SHA. A PR touching docs
**and** code fires both workflows; the bypass posts nothing and the real suite
gates it.

- **Editing `ci.yml`'s `paths-ignore` means editing `docs-only-gate.yml`'s
  `paths` in the SAME commit** — the complement is the whole safety argument.
  `scripts/docs-only-gate.test.ts` (unit lane) fails on drift, on a context
  rename, and on any changeset containing a source file.
- **Never** satisfy a required context by naming a job after it: a job-level
  `if:` skip reports as SUCCESS to branch protection, which would green-light
  the mixed docs+code case. Statuses are posted by an explicit guarded call.
- Renaming the `ci` or `vrt-strict` job still needs a coordinated ruleset PUT —
  now plus `REQUIRED_CONTEXTS` in `scripts/docs-only-gate.mjs`.

## Poly/MIDI modules: e2e the REAL source chain

Any **poly or MIDI module** must ship an e2e that **wires the REAL default-mode
source** (MIDI LANE / POLYSEQZ) **→ the module → and asserts audible RMS at the
output**. A per-port "edge materializes" assertion does **NOT** count as poly
coverage, and neither does an ART/behavioral test that drives the engine class
directly with a synthetic note source.

(POLYHELM #674 shipped green-but-silent because ART/behavioral/per-port all drove
the `HelmEngine` class directly; the default mono mode gated poly output to 0, so
the real MIDI-LANE→module chain was dead. The same voice-gating/silent-poly bug
class hit the poly wave 5×. See `poly-modules-test-real-source-chain`.)

## Triggers vs gates: edge-detect through the shared seam

A **trigger** input fires ONCE per rising edge (clock / reset / strike / sync /
start-stop / sample-and-hold); a **gate** input acts WHILE the level is high and
reacts to both edges (an ADSR sustain, a VCA hold, a poly note-on/off). Both
flow through the unified `gate` cable — cross-patching stays legal (it's just
CV) — but the *consumer's* interpretation differs, and that interpretation is
DECLARED on the port (`PortDef.edge: 'trigger' | 'gate'` — see
`$lib/audio/gate-trigger`).

- **Main-thread trigger detection MUST use `$lib/audio/edge-detect`
  `createEdgeCounter`.** NEVER re-scan a whole `AnalyserNode` buffer
  (`getFloatTimeDomainData` + `for (let s = 0; s < buf.length …)` rising-edge
  count). The 2048-sample ring (~42 ms) overlaps the ~25 ms scheduler tick, so a
  whole-buffer rescan counts the same edge twice → "one clock pulse advances two
  steps" (the NUMPAD+/HYDROGEN/ATLANTIS-CATALYST bug, fixed by the windowed
  counter). A worklet consumer is exempt (per-sample `prev<TH && cur>=TH` is
  correct by construction).
- **Do NOT convert a gate consumer to edge-only.** An ADSR sustain is
  level-sensitive on purpose — declare it `edge: 'gate'` and read the level.
- A new module's trigger/gate inputs declare `edge`; the canonical thresholds +
  emitted waveforms (short-triangle trigger / held-square gate) live in
  `$lib/audio/gate-trigger` (`GATE_HI`, `TRIGGER_PULSE_S`, …) — don't re-derive
  the numbers. GATEMAIDEN is the user-facing gate↔trigger converter.

## Commands run through flox

Every command (git, gh, task, npm, node, …) runs inside the Flox env:
`flox activate -- <cmd>`. Running git outside flox can make git-LFS operations
hang.
