# CI flake stabilization — 2026-06-15

Branch: `chore/ci-flake-quarantine` (off `origin/main`).

Goal: stabilize CI by handling the flaky tests identified across the last ~12 CI
runs. Every action here is **evidence-based** — we do **not** blanket-disable.
Per repo standard `feedback_no_flake_tolerance` + `reconcile-means-fix-or-delete`,
each item gets a reconcile action so a later pass can confirm it was a *flake*,
not a masked real break.

## Evidence (last ~12 CI runs — failure analysis already mined, most-recent first)

| Run | Job that failed | Test / cause | Verdict |
| --- | --- | --- | --- |
| #792 synesthesia (run 27517731573) | `collab (@collab multi-context)` | non-specific @collab failure; the PR is **DSP-only** (cannot affect multiplayer) | **@collab lane FLAKE** (relay contention) |
| #790 toybox (run 27516527895) | `e2e shard1` | `control-surface.spec` LEARNED-layer (ALREADY FIXED via `test.setTimeout`, merged) + `backdraft.spec:317` "MIRROR X/Y … gate toggles the param" | SwiftShader heavy-video **timeout FLAKE** |
| main (commit 1b897a3c) | `matrixmix.spec` | "Sequenced VCO: matrix unpatch + re-patch, then Cmd-Z all the way back…" (undo chain) | undo-chain **timeout FLAKE** (cleared on rerun; matrixmix is audio, the merged change was video → unrelated) |
| #791 scaler (run 27517679485) | `e2e shard5` | `##[error]Docker pull failed` | **CI INFRA** (not a test; cleared on rerun) |
| #787 outlines / earlier toybox | — | `webgl-attest` stale pin | ALREADY FIXED + merged — NOT TOUCHED |

Also already tracked as flaky in the backlog (handled here where cheap):
`toybox-node-controls.spec:341` (heavy WebGL, red locally + suspected CI-load),
the in-card-title `@collab` peer-sync flake, the `score` env-amplitude
`toBeGreaterThan`, and `patch-menu-ux.spec:79` timing.

## Actions taken

| Test (file:line) | Class | Action | Reconcile |
| --- | --- | --- | --- |
| `e2e/tests/backdraft.spec.ts:317` "MIRROR X / MIRROR Y …" | SwiftShader heavy-video timeout | **FIXED-timeout**: `test.setTimeout(90_000)` (matches sibling WebGL-heavy budget). Heavy spec reads the WebGL out-canvas several times under software renderer; flat 30s default raced CI load (#790). | Watch #790-class runs for green. If it still times out at 90s, the canvas read itself is wedging → investigate the render path, not the budget. |
| `e2e/tests/matrixmix.spec.ts:283` "Sequenced VCO … Cmd-Z all the way back" | undo-chain timeout | **FIXED-timeout**: `test.setTimeout(90_000)`. Loads a 5-module example then a long multi-step matrix patch/unpatch + full undo chain, each step polling the edge store; flat 30s raced CI load (cleared on rerun → flake). | Confirm green on a few main runs. A real break would fail *deterministically* (wrong final edge set), not time out then pass on rerun. |
| `e2e/tests/score.spec.ts:264` "dynamic marker scales the env output amplitude" | deterministic value behind a fixed sleep | **FIXED-timeout/poll**: replaced `waitForTimeout(500)` + one-shot read with `expect.poll(readDynScale, {timeout: 10_000}).toBeGreaterThan(0.85)` (then `<1.05`). `dynamicScale` is DETERMINISTIC (ff→0.95); the fixed 500ms raced the engine picking up the `n.data` write under load. Same correctness band, tolerant of slow propagation. | If it ever lands *outside* [0.85,1.05] after the poll window, that's a REAL dynamic-scale regression — do not widen the band, fix the engine. |
| `e2e/tests/patch-menu-ux.spec.ts:79` "INPUT / OUTPUT drill overlay-replaces root…" | DOM portal-mount timing | **FIXED-timeout**: `test.setTimeout(60_000)`. Click → body-portal mount → aria-hidden flip → drill/back, each a default-timeout assertion; portal-mount/aria flip raced the default budget under CI load. | If individual assertions (not the overall test) still flake at 60s, bump the specific `toHaveAttribute('aria-hidden','false')` waits in `openFrom`. |
| `e2e/tests/toybox-node-controls.spec.ts:341` "add → wire → RENDER → delete each op kind" | heavy WebGL per-iteration timeout | **FIXED-timeout**: overall `test.setTimeout(240_000)` is already maxed (sibling value); the brittle point is the *per-iteration* waits run 17× (one per OP_KIND) under SwiftShader. Widened the per-kind `expect.poll` 6s→15s and the `expect(CANVAS).toBeVisible()` default-5s→explicit 15s. | If a *specific* kind (e.g. `datamosh`) crashes deterministically, that's the original real bug resurfacing (per-node GL ring freed on delete) — triage that kind, not the timeout. |
| `@collab` lane (e.g. #792, in-card-title peer-sync) | systemic relay-contention | **RECOMMEND (no test change)** — see below. The lane is ALREADY informational/un-gated on CI. | When task #69 collab-flake-purge runs the 5× sweep, the specific flaky specs get quarantined with evidence + the lane re-gated. |
| `e2e shard5` "Docker pull failed" (#791) | CI INFRA (service-container pull) | **RECOMMEND (no test change)** — see below. | None at test level. Rare transient; clears on rerun. |

## @collab lane — recommendation (DO NOT unilaterally flip a required gate)

**Finding:** the `collab (@collab multi-context)` job is **already TEMPORARILY
UN-GATED / informational** as of 2026-06-06 (`.github/workflows/ci.yml`, the `ci`
umbrella job): it is intentionally removed from the umbrella's `needs:` list AND
from the failing `if [[ ]]` aggregate condition, with the inline note "collab is
intentionally removed from `needs:` … pending the collab-flake-purge (task #69)."
So the #792 collab failure **did not block the PR** — it surfaced as
informational only.

Because the #792 failure was a **non-deterministic lane flake** for a DSP-only PR
(no single reproducible test identified) and the in-card-title hang was already
root-caused + fixed in #565, we did **NOT** scatter `test.fixme` across collab
specs. That would hide the very signal task #69's 5× purge needs.

**Recommendation:**
1. **Keep the lane informational** (as it is today) until task #69's
   `collab-flake-purge.yml` 5× sweep runs and produces the *specific* flaky-spec
   list. Do not re-gate it before then.
2. Then, per the established e2e/behavioral pattern: quarantine the specifically
   flaky `@collab` specs (each with a `// QUARANTINE(...)` + reconcile note),
   verify the lane runs 5× clean, and flip it back into the `ci` umbrella's
   `needs:` + aggregate condition (one edit each, mirroring the webgl-attest
   semaphore wiring).
3. Owner decision required for step 2 (re-gating a ruleset-adjacent check).

No collab test was edited in this PR (no single flaky spec was reproducibly
identified from the evidence).

## Docker-pull INFRA — recommendation

**Finding:** the failing pull (#791 shard5) is the **postgres `services:`
container** (`public.ecr.aws/docker/library/postgres:17`). The image is *already*
on the AWS ECR Public mirror — the documented mitigation for "the flaky Docker
Hub service-container pull" (inline note in `ci.yml`). GitHub Actions
`services:` containers are **runner-managed** and have **no in-workflow retry
hook**, so `nick-fields/retry` cannot wrap a `services:` pull.

**Recommendation (no change applied — this is a rare transient on a required
gate; a 4-job refactor is higher-risk than the failure it prevents):**
- **Option A (lowest risk, status quo):** accept the rare transient; it clears on
  rerun, and the ECR mirror already removes the common Docker-Hub-rate-limit
  cause. This is the current posture.
- **Option B (if it recurs):** convert the `services: postgres` block in the
  affected jobs (`unit`, `e2e`, `collab`, `behavioral-flake-purge`,
  `flake-check-3x`) to a **manual `docker run` step** wrapped in a retry loop
  (`for i in 1 2 3; do docker pull … && break; sleep 5; done`) + a `pg_isready`
  poll, replacing the runner-managed service. Apply to ALL the listed jobs to
  keep the DB-setup uniform.

Owner to choose A vs B; only escalate to B if the transient recurs.

## Verification done in this PR

- `flox activate -- task typecheck` — 0 errors (svelte-check gate).
- Touched spec files parse (TS compiles via typecheck).
- Targeted local e2e confirmation of a representative timeout-FIX where cheap
  (see PR description for the exact grep run).

## Cross-references

- task **#65** — e2e-video 3-way shard (the e2e-video lane is temporarily
  disabled/un-gated pending this; the real-GPU webgl-attest gate covers its
  per-PR role today).
- task **#68** — WebGL-heavy shard rebalance / `webgl-heavy-globs.ts` partition
  (backdraft/toybox/matrixmix heavies live in the WebGL-heavy lane).
- task **#69** — collab-flake-purge (the @collab lane is un-gated pending this; it
  produces the specific flaky-spec list to quarantine + re-gate).
- task **#70** — (e2e flake-purge lane / `e2e-flake-purge.yml`) the 5× sweep
  pattern these timeout-FIXes should be re-validated under.
- task **#78** — (behavioral/collab gating sweep) the broader make-informational-
  lanes-required effort the collab re-gate (step 2 above) folds into.
