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
  load. Most of our recent red CI (per-port emit, stale SHA pins, missing
  linux-VRT exemptions) was catchable locally with the exact spec for the new
  module.
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

### VRT baselines: DRAIN the pending pairs BEFORE you dispatch the regen

Ordering is load-bearing when you capture missing platform baselines with the
`vrt-update.yml` workflow. A scene still listed in `EXEMPT_BASELINE_PAIRS`
(`e2e/vrt/vrt-exemptions.ts`) is `test.skip()`-ed **UNCONDITIONALLY**, so a
`--update-snapshots` run **writes NOTHING for it** — the dispatch comes back
green having captured exactly zero of the baselines you wanted. **Drain first,
dispatch second:**

1. Remove the pending `<platform>/<scene>` pairs from `EXEMPT_BASELINE_PAIRS`
   **and** lower the vrt-meta linux-deficit ratchet by the same count
   (`packages/web/src/lib/audio/modules/vrt-meta.test.ts` — the ceiling only
   shrinks, so it moves in the SAME commit). Push that commit.
2. *Then* dispatch against the branch that now has the pairs removed:
   `flox activate -- gh workflow run vrt-update.yml -f ref=<branch> -f
   platform=linux` (pick the ONE platform you need — the other runner is
   redundant CI wall-time).
3. The bot commits the PNGs onto the branch and close+reopens the PR so a real
   `pull_request` run re-validates them (a GITHUB_TOKEN push doesn't fire CI,
   and a `workflow_dispatch` run doesn't count toward required checks).

Three dispatch gotchas, all confirmed on real runs:

- **Never pass `-f grep=…`.** The run dies as `startup_failure` before any job
  starts. Dispatch **unscoped** — the full-scene capture is the fast path, and
  a skipped-because-still-exempt scene is untouched anyway.
- The bot's push lands the follow-on runs in **`action_required`** (awaiting
  manual approval), not `queued`. Check `gh run list` and approve rather than
  assuming CI is merely slow.
- **`--update-snapshots` CANNOT regenerate a PASSING-but-stale baseline** — and
  this is a hole in the drain-first rule above, not an instance of it. Playwright
  only rewrites a snapshot when the comparison **FAILS**. So a scene that is
  never exempt, never skipped, and genuinely out of date still comes back with
  **nothing committed** if its diff lands *under* the tolerance
  (`DOCK_MAX_DIFF`, 1500 px). Found on A2 (#1213): swapping filter's MODE from a
  bare detented knob to a labelled Segmented moved the dock face by **865 px** —
  a whole primitive swap — and the dispatch committed zero files, twice.
  **Fix: `git rm` the stale baseline first, then dispatch.** Playwright always
  writes a *missing* snapshot. ⚠ The same arithmetic means the ordinary VRT gate
  would not have flagged that swap either; a sub-tolerance render change is
  invisible to both the gate and the regen. Treat a "green dispatch that
  committed nothing" as a RED FLAG to investigate, never as "nothing to do".

### A platform gap is declared FOUR ways — `EXEMPT_BASELINE_PAIRS` is only one

CI renders on **linux**. A scene captured on darwin but skipped on linux gives
ZERO protection while still counting as "covered" everywhere. That deficit is
declared through **four** separate mechanisms, and for months the ratchet read
one of them:

| # | mechanism | where | gaps (2026-08-01) |
|---|---|---|---|
| A | `'linux/<scene>'` in the SHARED `EXEMPT_BASELINE_PAIRS` | `e2e/vrt/vrt-exemptions.ts` | 89 |
| B | a **private** `const EXEMPT_BASELINE_PAIRS` inside a spec | 4 spec files | 10 |
| C | `test.skip(VRT_PLATFORM === 'linux', …)` — blanket, no list | 8 spec files | 49 |
| D | `darwinOnly: true` on a `CompositeVrtScene` | `e2e/vrt/vrt-composite-scenes.ts` | 3 |

**Measured: 151 real gaps, 89 seen, 62 invisible — and the number it printed was
119**, matching neither, because 30 of its entries named scenes that were not
gaps at all. A count of *declarations* was being read as a count of *gaps*, so
it was wrong in both directions at once. Nothing failed; every assertion it made
was true about the one list it read.

- **Enumerate mechanisms in ONE place.** `e2e/vrt/vrt-platform-gaps.ts` reads
  all four; `vrt-meta.test.ts` ratchets its total (≤151, only shrinks) and fails
  with a per-mechanism breakdown. **A bare number is what let this hide** — name
  the contributors in the message.
- **Anchor the metric to the ARTIFACT, not the list.** Ground truth is a darwin
  PNG with no linux sibling; the mechanisms must then *explain* each gap. A gap
  nobody declares is UNDECLARED → red. Adding a fifth mechanism without teaching
  the enumerator fails automatically.
- **A pair whose PNG is already committed is a DEADLOCK, not just waste.** The
  pair is consulted before the PNG, so the scene is skipped despite the
  baseline — and `--update-snapshots` writes nothing for a skipped test, so the
  "re-capture then drop the pair" plan it waits on can never run. 15 of these
  were drained on 2026-08-01; the stale ratchet is now capped at the 4 tracked
  flake quarantines.
- **A checker that resolves ONE directory cannot speak for the tree.** Both the
  stale ratchet and `scripts/vrt-exemptions-audit.mjs` only ever built the
  `__screenshots__/vrt.spec.ts/…` path, so stale *scene* pairs under other spec
  dirs were structurally invisible. Widening them found **3** more immediately
  (narrow 16 → widened 19 on `77cd1bbc`) — the three `darwin/wavesculpt-blink-*`
  quarantines. Not four: `darwin/rasterize` lives under `vrt.spec.ts`, so the
  narrow check always saw it. The same one-directory blindness was live in the
  cable-stripe palette gate, which read `vrt.spec.ts` only and missed 39
  token-pinned baselines in six sibling dirs — **state a gate's directory scope
  in the gate**, because an unstated scope reads as full coverage.
- **A CEILING can only trip by GROWING — assert the other direction too.** A
  drain that closes gaps and forgets to lower the number passes in total
  silence, and the slack it leaves absorbs the next regression. Every VRT
  ratchet now pairs `actual <= CEILING` with `CEILING - actual === 0`, so
  "lower the ceiling by the same count" is enforced rather than advisory. It
  fired on its first run (the shared-pair ceiling was 10 slack after a cleanup).
- **A drain without its re-capture ships a red lane.** Removing pairs is step 1
  of 2. The 2026-08-01 15-pair drain deferred the dispatch to "a follow-up" and
  every one of the 15 came back as a **dimension mismatch** (212×564 vs
  264×527 …) — Playwright hard-fails on size *before* it computes a ratio, so no
  tolerance argument applies and `maxDiffPixelRatio` is irrelevant. Confirm the
  committed baseline still matches the render, or `git rm` it and dispatch, in
  the SAME PR.

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
- `e2e/vrt/vrt-exemptions.ts` (`EXEMPT_FROM_VRT` / `EXEMPT_BASELINE_PAIRS`)
- `packages/web/src/lib/ui/modules-card-map.test.ts` (`EXPECTED_NODE_TYPES`)
- the per-port / VRT spec lists (`e2e/tests/per-module-per-port*.spec.ts`)
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

⚠ And the meta-tell: **"the result is genuinely different here" and "the
instrument reads differently here" look identical from the output alone.**
Establish which before acting; they need opposite fixes.

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

**Docs are hash-transparent to the attests** (owner directive: "docs must not
change attest hashes"). VIDEO module defs live in the WebGL attest basis, so
authoring their co-located `docs`/`controlFamilies` would otherwise churn the
WebGL hash and force a GPU re-attest. Wrap every such co-located block (and any
docs-only addition to a basis file) in `// docs-hash-ignore:start … :end`
markers — `computeWebglHash` strips those regions before hashing, so doc
authoring is a no-op for the attest (guarded by webgl-attest-coverage.test.ts).
Audio defs are NOT in the WebGL basis and don't need markers. (If the attest
LOGIC or a real contract field changes, that's a legitimate one-time re-attest.)

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
