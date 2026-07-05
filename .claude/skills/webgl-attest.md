# Running the WebGL GPU attestation (`task webgl:attest`)

The WebGL attest is a **local, real-GPU** gate. It runs the heavy WebGL specs on
the actual GPU, hashes the WebGL basis (`lib/video/**` + audio `rendersWebGL`
defs + WebGL cards + heavy-spec globs + config + toolchain pins), and writes
`ci-webgl-attest/<hash>.json`. **CI runs only the cheap CHECK** (`webgl:attest:check`,
no GPU) — it confirms the committed json's hash matches the current basis. So a
committed, matching json = the `webgl-attest` gate is green on CI.

You re-attest whenever you change a basis file (any `lib/video/**` source, a
`rendersWebGL` audio def, a WebGL card, the heavy-spec set, etc.).

## RULE 1 — it MUST run PARALLEL (≈half-cores). NEVER pin `workers=1`.

The attest defaults to `--workers=ceil(cpus/2)` and finishes in **~1–5 min**.
**`--workers=1` is a known regression** (PR #941) that serializes ~49 heavy specs
and takes **50–90 min** — most of each spec's wall-time is NON-GPU overhead (page
boot, `networkidle`, `spawnPatch`, teardown) that does NOT overlap serially. The
"GPU serialises the work anyway" claim is false. See memory
`attest-perf-workers1-regression` + PR #943 (restored parallel + added the
`--global-timeout` backstop).

- Do NOT pin `WEBGL_ATTEST_WORKERS=1` to dodge a flake (see RULE 4) — that trades
  a 2-min re-run for an hour.
- The only place `workers=1` is correct is the 3× flake-check (`REPEAT>1`), which
  forces it automatically.
- If a branch predates #943 (its `scripts/webgl-attest.ts` has no
  `DEFAULT_WORKERS`), **merge `origin/main` first** to get the parallel default —
  which you need anyway (RULE 3).

## RULE 2 — the machine must be GPU-SOLO

The pre-flight (`preflightSolo`) **refuses** if a GPU co-tenant (Chrome / Edge /
Safari / Brave / **Electron apps like Discord** / Spotify) is using ≥25% CPU, or
load > cores·0.5. A co-tenant steals GPU cycles from the single ANGLE/Metal
context and makes timing-sensitive specs flake. **Quit Discord / Steam / Edge /
heavy browser tabs before attesting.** Check first:

```sh
ps -A -o %cpu=,comm= | awk '$1>=25' | grep -iE "Discord|Steam|Chrome|Edge|Safari|Electron|Spotify"
uptime   # load should be well under (cores/2)
```

Override only on a trusted dedicated runner: `WEBGL_ATTEST_ALLOW_BUSY=1`.

## RULE 3 — re-attest is the LAST step, on the rebased branch (treadmill)

Two PRs that both touch the WebGL basis **cannot both be attested independently** —
whichever merges second invalidates the first's hash. So:
1. Merge/rebase the branch onto the CURRENT target main FIRST.
2. Re-attest (parallel).
3. Commit the json + push + merge.
4. For the *next* basis PR: rebase onto the new main, re-attest, merge.

Also: re-attest AFTER any look-review approval, not before — a shader tweak the
owner requests would just invalidate it again.

## RULE 4 — a missing local dep looks like a 50-min hang (it isn't)

If a branch adds an npm dep (e.g. `milkdrop-preset-converter`) and you haven't
`npm install`ed it, **vite can't build → the app boots into an error overlay →
EVERY spec fails/times out** (`passed=0, failed=N, skipped=M` over 15+ min). This
masquerades as a slow/hung attest. **Run `flox activate -- npm install` first.**
To confirm, read a failing spec's `e2e/test-results/*/error-context.md` — the page
snapshot shows the vite `Failed to resolve import` overlay.

**Branch-switch prune trap (bit us twice):** `node_modules` is SHARED across all
branches/worktrees of a checkout. Running `npm install` on branch B (whose
`package.json` lacks a dep) PRUNES that dep — so when you switch back to branch A
that needs it, it's gone. **ALWAYS `npm install` again right after switching to
the branch you're about to attest**, especially after attesting a sibling branch.

## RULE 5 — `scope-video-out` can flake under parallel (re-run, don't serialize)

If the attest refuses with `N recovered-flaky test(s) exceeds MAX_FLAKY=1`, it's
usually the 2 `scope-video-out.spec.ts` tests under GPU contention. Observed on a
10-core machine: the default `ceil(cpus/2)=5` workers flakes **2** (→ refuse,
~1m35s), while **`WEBGL_ATTEST_WORKERS=3` flakes ≤1 (→ clean, ~2m)**. So:
**`WEBGL_ATTEST_WORKERS=3 flox activate -- task webgl:attest`** is the reliable
parallel setting here until scope-video-out is hardened. Do NOT pin `workers=1`
to make it pass (that's the 50-min regression — RULE 1).

Proper fix (tracked): `scope-video-out.spec.ts` is an e2e file → NOT in the attest
basis, so bumping its `waitForFunction` timeout / adding a settle loop is
hash-free (no re-attest) and would let the default-5 run clean.

## RULE 6 — the camera-test refusal is NOT your change

`task webgl:attest` can **REFUSE** because the 2 `video-orientation.spec`
`cameraInput` tests fail Pass-A-heavy on some machines (a `getUserMedia`/fake-cam
timing issue), which is **unrelated to your basis edit** — but it blocks ANY video
re-attest. CI only hash-*verifies* (no GPU/camera), so this stays latent until you
try to re-attest locally. If you hit it and can't clear it (it's a known-flaky
camera spec, not something you touched), you're genuinely blocked — fix/stabilise
the camera spec first, or split the PR so the basis-touching part waits. Don't
force-write around it. (Memory `webgl-attest-video-orientation-camera-fail`;
parked ruttetra rename #979.)

To reproduce CI's software renderer locally (SwiftShader ≠ your real GPU — a flat
pixel/encode assert that passes on Metal can go red on CI): `E2E_ANGLE_BACKEND=swiftshader`.

## The procedure

```sh
# 0. quiet machine (RULE 2) + on the rebased branch (RULE 3) + deps present (RULE 4)
flox activate -- npm install
flox activate -- git checkout -- packages/web/src/lib/video/modules/backdraft.ts  # sync-layer stray guard
# 1. attest (PARALLEL — the default; ~1–5 min)
flox activate -- task webgl:attest
# 2. verify the written hash matches the working tree
flox activate -- task webgl:attest:check          # → "matching attestation exists"
# 3. commit + push (json only)
flox activate -- git add ci-webgl-attest/ && flox activate -- git commit -m "chore(attest): re-pin <module> WebGL attestation"
flox activate -- git push origin <branch>
```

## Gotchas
- `scripts/webgl-attest.ts` and `packages/web/src/lib/video/modules/backdraft.ts`
  are sync-layer-reverted files — commit edits promptly; `git checkout --` any
  stray before attesting so the hash is clean. (A duplicate `const WORKERS` decl
  from a sync-layer + merge collision once TransformError'd every attest.)
- `scripts/` is NOT in the basis — editing the attest runner itself is hash-free
  (a scripts-only attest fix merges without a real re-attest).
- Env knobs: `WEBGL_ATTEST_WORKERS=N` (override parallelism),
  `WEBGL_ATTEST_GLOBAL_TIMEOUT_MS` (backstop, default 15 min/pass),
  `WEBGL_ATTEST_ALLOW_BUSY=1` (skip the quiet-machine guard — trusted runner only).
- Never `gh run view <run> --log-failed` (wedges the shell); read the committed
  per-job annotations or the downloaded `playwright-test-results-*` artifact.
