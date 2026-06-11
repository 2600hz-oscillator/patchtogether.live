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
| **Pages** | `pages.yml` | push to main (when VRT/pages sources change) | publish VRT gallery + test-reconciliation site |

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

Branch ruleset **id 16042163** requires these **exact** status-check names:

1. **`typecheck + unit + ART + E2E`** — the `ci` umbrella job. It `needs:`
   actionlint, typecheck, unit, dsp-build, build-web, art, build, e2e. **Renaming
   this job breaks the merge gate** unless you also PUT the ruleset.
2. **`vrt-strict`** — the pure-DOM deterministic VRT subset (also REQUIRED).
3. **`webgl-smoke`** — the renderer-tolerant SwiftShader WebGL floor (a few
   `@webgl-smoke`-tagged specs: context-not-lost / shader-compiles / canvas-not-blank).
   REQUIRED via the umbrella's aggregate `if`.

**Informational (NOT gating)** lanes:

- `webgl-attest` (real-GPU attestation gate) — **PHASED: currently NON-gating.**
  The verify job runs + is visible, but is intentionally left out of the umbrella
  `if` because the heavy WebGL suite has ~15 rotted specs (ungated since `e2e-video`
  was disabled) and the attestation can't bootstrap green yet. After the heavy-WebGL
  triage campaign + the first real-GPU attestation, re-add `|| "$WEBGL_ATTEST" !=
  "success"` to the umbrella `if` to enforce it. See
  `.myrobots/plans/webgl-attestation-semaphore.md` §-2 + the dev flow in
  [testing.md](testing.md).

- `vrt` (full canvas sweep) — `continue-on-error: true`; canvas/GPU timing may
  drift, so only `vrt-strict` is required.
- `collab` (@collab multi-context) — un-gated pending flake-purge proof.
- `behavioral` — `continue-on-error: true`, runs only on main-push / dispatch /
  PRs labeled `behavioral`; per-module thresholds still being tuned.
- `e2e-video` (WebGL-heavy) — temporarily gated to `workflow_dispatch` only;
  pending a 3-way shard rebalance.

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
