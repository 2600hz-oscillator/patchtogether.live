---
name: running-tests
description: How to run unit, ART (audio regression), VRT (visual regression), and E2E tests locally and in CI. Includes baseline-update patterns and when to scope vs. run-all.
---

# Running tests

All test invocations go through go-task targets defined in `Taskfile.yml`.
Always wrap in `flox activate --` (see `flox-environment` skill).

## The 4 test suites + their task targets

| Suite | Target | Speed | What it covers |
|-------|--------|-------|----------------|
| Unit/integration | `task test` | ~1-2 min | Vitest, server + web workspaces. Most module logic, store wiring, helpers. |
| Audio Regression (ART) | `task art` | ~30-60s | Vitest under `packages/art/`. Compares DSP output buffers (`.f32`) + SHAs against committed baselines. |
| Visual Regression (VRT) | `task vrt` | ~3-5 min | Playwright suite under `e2e/vrt/`. Compares per-module card PNGs against committed darwin/linux baselines. |
| E2E | `task e2e` | ~15-20 min | Playwright suite under `e2e/tests/`. Real-browser interaction tests. |

**`task ci`** runs the PR-gate sequence: typecheck → test → art → e2e.

## Scoping a single test (fastest feedback loop)

Pass Playwright/Vitest filters after `--`:

```sh
flox activate -- task e2e -- -g wavesculpt          # only wavesculpt e2e
flox activate -- task vrt -- --grep "helm|wavecel"   # multiple modules
flox activate -- task test -- run -t "filter coeffs" # vitest -t
flox activate -- task art -- run                     # ART = vitest under the hood
```

## Flake-check NEW/changed tests 3× before an MR

A green run proves pass/fail, not **stability**. Any test you **add** or
**seriously change** must pass **3× in a row locally** before you push it — scoped
to that test, not the whole suite. Prefix the `*:one` targets (see the
CLAUDE.md "Running ONE test locally" section) with `REPEAT=3`:

```sh
REPEAT=3 flox activate -- task test:one -- my-thing   # unit (loops vitest 3×)
REPEAT=3 flox activate -- task art:one  -- my-scn     # ART
REPEAT=3 flox activate -- task e2e:one  -- my-spec    # e2e (--repeat-each=3)
REPEAT=3 flox activate -- task vrt:one  -- my-card    # VRT
```

It **bails on the first failing iteration**, so a flake can't hide behind a later
green run. Flake locally → fix it (diagnose run-bug vs test-bug, never just
re-run) before the MR. `@collab` specs are relay/DB-heavy and flake under *CI*
load specifically — verify those on CI rather than hammering the local machine,
but still root-cause every failure (see `feedback_no_flake_tolerance`).

## ⚠ ART: RELEASE every `OfflineAudioContext` you create — `startRendering()` frees it

An `OfflineAudioContext` under `node-web-audio-api` holds a **native render
thread** until it is rendered. A scenario that creates one per module and never
renders — a membership probe, a "does this def expose X?" sweep, anything that
materialises a factory and only reads the handle — accumulates them, and the pool
starves.

**It does not present as a leak. It presents as the SUBJECT being broken**, and
the cost lands on whatever runs *after* the leak, not on the leak itself.
Measured (2026-08-17, #1769):

| | leaked | released |
|---|---|---|
| `cv-terminal`, whole registry | 488 076 ms, **11 modules "cannot materialise"** | **762 ms, zero** |
| `cv-display-param-reach`, 13 ports | 591 388 ms | **795 ms** |

The 11 "failures" were fiction — driven alone those modules build in 66–97 ms —
but they had already been written up as a permanent `harness-cannot-materialize`
exemption covering nine Faust modules and 120 ports, which is what hid a live
defect (#1737).

```ts
/** 128 samples completes the context and frees its native render thread. */
async function release(ctx: OfflineAudioContext): Promise<void> {
  try { await ctx.startRendering(); } catch { /* freed either way */ }
}
```

Release in a `finally`, **including the throw path** — otherwise one module's
failure silently degrades every module measured after it. Full case study:
`blind-gates`, Pattern 6.

## Updating baselines

ART:
```sh
flox activate -- task art:update                     # regenerates ALL ART baselines
```

VRT:
```sh
flox activate -- task vrt:update -- --grep wavesculpt   # specific module
flox activate -- task vrt:update                        # all baselines (rarely correct)
```

**Always examine VRT diffs before accepting a baseline update.** See the
`vrt-failures` skill. The rule is: each pixel change must map to a deliberate
visual change in this PR. If you cannot articulate why a pixel differs, ask
the user.

## Other targets you'll occasionally need

- `task typecheck` — TS across all workspaces.
- `task build` — DSP + web prod build. Required before `task vrt` (vrt depends
  on `dsp:build` because some module cards `import '...?url'` against
  `packages/dsp/dist/`).
- `task vrt:gallery` — builds `docs/vrt/` HTML gallery from current baselines.
- `task ci:smoke:live` — runs `@smoke`-tagged e2e against the live deployed
  URL (default autotest.patchtogether.live).
- `task e2e:headed` — show the browser window during e2e.
- `task e2e:debug` — Playwright inspector.
- `task e2e:ui` — interactive UI mode.

## Run locally before pushing CI fixes

When a CI job fails:

1. Identify the specific failing test from the CI log.
2. Run JUST that test locally with scoped target (`task e2e -- -g <pattern>`).
3. Reproduce the failure.
4. Fix.
5. Re-run scoped target to confirm green.
6. Then push.

Don't ping-pong push-and-wait — CI is 15-20 min round-trip; locally is seconds.
The user has explicitly asked for this discipline.

---

## Moved here from CLAUDE.md (2026-08-12, #1493)

The RULE stays in CLAUDE.md; the measured evidence lives here so the numbers
exist in exactly one place.


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


---

## The vendored `playwright-cli` skill — what it is and is NOT for

`.claude/skills/playwright-cli/` is installed by
`npx @playwright/cli install --skills` (⚠ the bare `playwright-cli` npm package is
DEPRECATED — the real one is `@playwright/cli`). It is vendored: fix it upstream,
do not edit it here. Invoke the binary through `npx @playwright/cli` — it is
deliberately NOT a devDependency, so it costs no install time in any CI job.

It is oriented at **driving a live browser** — `open` / `goto` / `click` against
snapshot refs. That makes it useful for:

- **authoring** a new spec (test-generation, element-attributes) — directly relevant
  to the black-box journey tier, where the suite currently has **zero** `getByLabel`
  uses and only 16 files using `getByRole`;
- **request-mocking**, where a route mock is cleaner than reaching into app internals;
- exploratory debugging against a running dev server.

⚠ **It does NOT help you read a `trace.zip` that CI uploaded.** Its `tracing`
reference covers *recording* a trace from a live CLI session, not inspecting an
artifact from a failed shard. Diagnosing a CI failure is still: pull the job log
via the jobs/logs API (never `gh run view --log-failed`, it wedges the shell), and
if you need the trace, download the artifact and open it with
`npx playwright show-trace`.

The nine reference files are lazy-loaded, so only the one-line description sits in
context until you actually open one.
