# CI / GitHub Actions

All CI/CD lives in `.github/workflows/`. The critical PR-gate path runs ~4–5 min
thanks to DSP-artifact deduplication.

## Workflows at a glance

| Workflow | File | Trigger | Purpose |
| --- | --- | --- | --- |
| **CI** | `ci.yml` | push to `main`/`first-mvp`, every PR, `workflow_dispatch` | PR-gate suite: typecheck, unit, ART, E2E, build, VRT |
| **Deploy** | `deploy.yml` | push to main, PR, `workflow_dispatch` | Web (CF Pages) + relay (Fly) per tier; prod gated by version bump |
| **VRT update** | `vrt-update.yml` | `workflow_dispatch` | regenerate VRT baselines for linux + darwin |
| **Live smoke** | `live-smoke-alert.yml` | cron (~10 min), `workflow_dispatch` | probe dev web + relay; open GH issue on sustained unhealth |
| **Flake check 3×** | `flake-check-3x.yml` | `workflow_dispatch` | run ONE test 3× with `retries=0` to prove stability |
| **Behavioral flake purge** | `behavioral-flake-purge.yml` | push to `behavioral-purge/**`, dispatch | shard×pass matrix to find unstable behavioral tests |
| **E2E flake purge** | `e2e-flake-purge.yml` | push to `e2e-purge/**`, dispatch | shard×pass matrix to find unstable e2e specs |
| **Chaos 24/7** | `chaos-24-7.yml` | cron (hourly), dispatch | fuzz autotest via invite link; findings → artifact |
| **Deploy video branch** | `deploy-video-branch.yml` | push to `feat/video-domain` | stable dev-only URL for the long-lived video branch |
| **Pages** | `pages.yml` | push to main (when VRT/pages sources change) | publish VRT gallery + ART gallery |

## The CI gate (`ci.yml`)

Jobs run in parallel after the shared prep jobs (`dsp-build`, `build-web`):

- `dsp-build` — compiles Faust **once**, publishes `dsp-dist` artifact. Every
  downstream job downloads it; the Taskfile `status:` guard
  (`dist/.dsp-srchash`) makes transitive `dsp:build` deps no-op.
- `build-web` — builds the Vite/SvelteKit **preview** bundle with
  `VITE_E2E_HOOKS=1`, publishes `web-preview-dist`. E2E/VRT/collab run against
  `vite preview` (:4173), not a dev server.
- `typecheck`, `unit`, `art`, `build`, `e2e` (10 shards) → `merge-reports`,
  `vrt`, `vrt-strict`.

### Required checks (branch protection)

> The live counts + evidence are GENERATED: `docs/testing/test-ledger.generated.md`
> (punch-list + roadmap prose: [`docs/testing/README.md`](../docs/testing/README.md)).
> This section is the human-readable summary of that ledger's Bucket 3 + gating set.

Branch ruleset **id 16042163** requires these **2 exact** status-check names (see
`.claude/skills/pr-workflow.md`, verified against the live ruleset):

1. **`typecheck + unit + ART + E2E`** — the `ci` umbrella job.
2. **`vrt-strict (visual regression — strict subset)`** — the pure-DOM
   deterministic VRT subset.

The umbrella is an aggregator: it fails (blocking merge) if **any** of the jobs
in its failing `if [[ … ]]` is not `success`. Those GATING-through-the-umbrella
jobs are: **actionlint, typecheck, unit, dsp-build, build-web, art, build, e2e,
webgl-smoke, webgl-attest, behavioral-smoke**. So all eleven are REQUIRED even
though only the umbrella's NAME is the branch-protection context. **Renaming the
umbrella job (or `vrt-strict`) breaks the merge gate** unless you also PUT the
ruleset.

- `webgl-attest` (real-GPU attestation verify) is **GATING** (re-armed 2026-06-11,
  Phase 4: `$WEBGL_ATTEST` is in the umbrella `if`) — a WebGL-path change without a
  re-run `task webgl:attest` fails it. `webgl-smoke` (the SwiftShader WebGL floor)
  is likewise gating.
- `behavioral-smoke` is **GATING** — the fast REQUIRED subset of the behavioral
  sweep, grepping 7 rock-solid core modules
  (`adsr|analogVco|filter|lfo|noise|stereovca|vca`).

**Informational (NOT gating)** lanes — run for visibility, never block merge:

- `behavioral-coverage` (the FULL ~168-module behavioral sweep) —
  `continue-on-error: true`, NOT in the umbrella `needs:`, runs only on main-push /
  dispatch / PRs labeled `behavioral`. Per-module delta thresholds are still being
  tuned and it needs a proper 3× flake-purge before it can re-gate; the stable
  `behavioral-smoke` subset gates every PR in the meantime.
- `vrt` (full canvas sweep) — `continue-on-error: true`; canvas/GPU timing may
  drift, so only `vrt-strict` is required.
- `collab` (@collab multi-context) — un-gated pending flake-purge proof.
- `collab-attest` — in the umbrella `needs:` + `env:` but deliberately absent from
  the failing `if` (un-gated 2026-06-28; a local-relay re-attest treadmill made it
  a merge-blocker on the owner's box only). Waited-on, non-blocking.
- `grand-attest` — informational-first (2026-07-19): in `needs:` + `env:`, absent
  from the failing `if`; the owner arms it required later once the pin is stable.

### Merge discipline

- **Do not merge until THIS PR's CI run is green on its FINAL commit** — not an
  earlier run, not a still-running run.
- A **red push run on `main` is a P0** to root-cause, never absorbed as "flake".
- `workflow_dispatch` runs do **not** count toward a PR's required checks (only
  `pull_request`/`push` events credit them).

## HOW TO READ A FAILURE

> **NEVER run `gh run view --log-failed`** — it wedges the shell. Use the
> commands below instead.

### 1. See which checks failed

```sh
flox activate -- gh pr checks <PR-number>          # all check-runs for the PR's head commit
flox activate -- gh run list --workflow ci.yml     # recent CI runs
```

### 2. Read per-check annotations (assertion diffs, stderr)

```sh
# Get the check-run id from `gh pr checks`, then:
flox activate -- gh api repos/{owner}/{repo}/check-runs/{id}/annotations \
  | jq '.[] | {title, message, raw_details}'
```

### 3. Download artifacts and inspect locally

```sh
flox activate -- gh run download <run-id> --name test-results        --dir /tmp/inspect
flox activate -- gh run download <run-id> --name playwright-report   --dir /tmp/inspect
flox activate -- gh run download <run-id> --name blob-report-1       --dir /tmp/inspect   # e2e shard 1
flox activate -- gh run download <run-id> --name vrt-gallery         --dir /tmp/inspect
# then open the report's index.html in a browser
```

Artifact retention: `dsp-dist`/`web-preview-dist` = 1 day; blob reports = 7 days;
HTML reports = 30 days; test-results = 14 days; VRT gallery = 30 days; chaos
findings = 90 days.

### 4. Reproduce locally first

Run the **specific** failing test locally (see [testing.md](testing.md)) before a
push-and-wait cycle. For CI-only WebGL behavior:
`E2E_SWIFTSHADER=1 task vrt:one -- <card>`.

## Operating the other workflows

```sh
# Regenerate VRT baselines (both platforms; auto-commits; re-fires PR CI via close+reopen)
flox activate -- gh workflow run vrt-update.yml -f ref=<branch>

# Prove a single test is stable (3× with retries=0; ANY flake fails)
flox activate -- gh workflow run flake-check-3x.yml --ref <branch> -f suite=e2e -f grep='my-test-title'

# Deploy a tier by hand (latest CI on the branch must be green)
flox activate -- gh workflow run deploy.yml --ref <branch> -f target=autotest

# Force live-smoke to fire (for testing the alert path)
flox activate -- gh workflow run live-smoke-alert.yml -f force_fire=true
```

## Gotchas

- **`dsp-build` cache key** includes `.flox/env/manifest.toml` + `package.json` —
  changing the Faust toolchain pin forces a cold compile (intentional).
- **E2E shards** download `dsp-dist` + `web-preview-dist` at start and do NOT
  rebuild during the run; artifacts are immutable snapshots. No test should write
  to `packages/dsp/dist`.
- **git-LFS cache** is keyed on PNG SHAs — regenerating VRT baselines invalidates
  the cache (all baselines re-fetched next run). Expected; re-run `vrt-update.yml`
  after the baseline commit lands.
- **Postgres service** containers come from AWS ECR Public (`postgres:16` for
  unit, `postgres:17` elsewhere) to dodge Docker Hub rate limits.
- **actionlint** (pinned) lints the workflow YAML itself, not shell inside
  `run:` blocks.
- **Relay CD** only fires on `packages/server/**` or `fly.*.toml` changes —
  web-only merges skip relay redeploy (no dropped WS connections). See
  [deployment.md](deployment.md).
