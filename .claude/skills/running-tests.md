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
