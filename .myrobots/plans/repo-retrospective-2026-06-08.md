# Repo retrospective — week of ~June 3-8, 2026

Source: 5-agent retrospective workflow auditing CI failures, week-of-thrash, and
recurring user directives, assessing repo standards (CLAUDE.md) + workflow skills.

## Executive summary

This week (~June 3-8) ran hot:

- **~400 `ci.yml` runs**, a **34% failure rate** on non-cancelled runs (104/307)
- **~32.3 single-runner hours** burned on red runs
- **~28 merges/day**

The dominant **failure** driver is one infrastructure class: **toybox/video-domain
e2e shard timeouts on CI's SwiftShader software renderer** (43 of 58 detailed
failing-job instances; shards 10/1/9 hottest). It is the explicit subject of 6+
stabilization PRs (#614/#621/#629/#637/#643/#610) yet still recurred through June 8
and bled onto unrelated audio PRs (cube-wavecel #675, chowkick #682, es9 #685,
synesthesia #698).

The dominant **thrash** driver is **green-but-broken merges** that spawn same-hour
follow-up fixes: the poly-synth wave (feats #664/#665/#666/#674 → same-day fixes
#669/#672/#675/#677) re-discovered one voice-gating/silent-poly bug class five
times; synesthesia #698 merged near-red, broke main CI, and triggered #699/#701/#702.

The single highest-leverage **non-test** fix is **documentation truth**: PR #551
(`976d1846`) made module registration glob+palette-driven, but 3-4 skills
(module-development, coding-conventions, architecture) and CLAUDE.md still teach the
dead "edit 6 shared registry files" model; debugging.md recommends
`gh run view --log-failed` (which wedges the shell); pr-workflow.md prescribes the
banned `gh pr update-branch` plus a wrong required-check name and a false
strict-up-to-date claim.

The rules that got violated this week (lowercase labels 4×, green-but-broken,
verify-on-CI, @collab-as-gate) are precisely the ones **living only in memory**, not
in CLAUDE.md or a gate — confirming the owner's thesis that **a rule isn't
internalized until a gate enforces it.**

## Metrics

| Metric | Value |
|--------|-------|
| `ci.yml` runs | ~400 |
| Failure rate (non-cancelled) | 34% (104/307) |
| Red wall-time | ~32.3 single-runner hours |
| Merge rate | ~28/day |
| Failing jobs that were `e2e (shard N/10)` | 43 of 58 detailed instances |
| Failing runs that were toybox/video-domain | 46/58 (79%) |
| @collab as the failing job | 12 of 58 detailed runs |
| Main-push reds leaking past green PR CI | 24/104 (23%) |
| Runs that died on exactly ONE real failing job + the umbrella aggregate | 41/58 |
| Last-50-merges that were fix/revert/perf follow-ups | 34% (17/50) vs 44% net-new feat |
| Fix-of-fix chains on the same just-merged scope | 13 (median time-to-followup 1.4h, mean 6.0h; 12/13 within 24h, all 13 within 48h) |
| Top-3 modules' share of the 100-commit window | ~44% (toybox 25, electra/control-surface 10, video/HD/aspect 9) |

## Top recurring failure modes

1. **Toybox/video e2e shard timeouts on SwiftShader — THE biggest CI-failure
   driver.** 43/58 detailed failing-job instances were `e2e (shard N/10)`,
   concentrated on shard 10/10 (14×), 1/10 (10×), 9/10 (9×); 79% of failing runs
   were toybox/video-domain. A failed shard 9/10 (run 27070164664) ran 20m18s vs
   healthy 4-6m = Playwright-timeout signature on SwiftShader. Stabilization
   commits (#614/#621/#629/#637/#643/#610) all target it yet it recurred Jun5-8
   and bled onto audio PRs.
   - **Fix:** pull WebGL/toybox-graph-interaction specs out of the round-robin
     e2e shards into the dedicated serialized e2e-video lane (per #610); scale
     per-spec timeout by input/capture count not a flat value; make shards 1/9/10
     deterministic; keep these specs informational, not in the required gate,
     until they pass 3× on CI.

2. **Green-but-broken merges that test the wrong layer and spawn same-day fixes.**
   POLYHELM #677 body (verified): *"ART/behavioral tests passed because they drove
   the shared HelmEngine class directly (synthetic noteOnLane)… none exercised the
   real MIDI-LANE-poly→audio chain"* — default mono mode gated poly output to 0,
   so wiring MIDI LANE→POLYHELM was silent though CI was green. Synesthesia #698
   merged 14:18:50Z after FAILED PR runs (27139576499/27140865305), then broke main
   CI run 27144066696 and spawned #699/#701/#702 same day. Poly wave: feats
   #664/#665/#666/#674 → fixes #669/#672/#675/#677, all one bug class.
   - **Fix:** make "real source→module→audible-output" e2e a REQUIRED gate for any
     poly/MIDI module (a per-port edge-materializes assertion does not count —
     assert audible RMS on the default-mode user chain). Add a hard "do not merge
     until THIS PR's final-commit CI run is green" rule; treat a red main-push run
     as P0.

3. **VRT global glyph/layout-determinism flake must be triaged separately from a
   legit own-card change.** es9 #685 (audio-only, run 27130013750) failed 29
   UNRELATED cards (adsr/buggles/dx7/noise/reverb/score…) in both VRT and
   vrt-strict — impossible from an audio change = the ±1px linux glyph/layout
   rounding flake, recurring AFTER determinism fix #598 merged Jun4. Contrast:
   mixmstrs #649 failed exactly 1 card (its own, legit 4→6ch).
   - **Fix:** finish the height-stability/font settle loop (#598 was incomplete);
     auto-classify "N≈all cards failed = flake → re-run/regen via vrt-update" vs
     "1-2 own cards = expected, regen in-PR" so reviewers don't rubber-stamp.

4. **@collab multi-context flakes recur (12×) and leak to main, re-quarantined
   instead of root-caused.** collab was the failing job in 12 of 58 detailed runs,
   incl. 4+ main-push collab-ONLY reds. Treated as flake/quarantine all week:
   #628 un-gate, #636 quarantine 2 fragile, #684 quarantine in-card-title — never
   promoted to required.
   - **Fix:** root-cause the relay-contention/in-card-title peer-sync timeout
     (bound UI actions with `toBeVisible`, don't `fill()` before editor opens) and
     verify @collab actually ran with DATABASE_URL before trusting green; only then
     add it as a 3rd required check, or formally record why it can't be.

5. **e2e-video lane burns 25-29 min per failure — largest per-run wall-time sink.**
   e2e-video ran 25m42s on toybox-video-100mb #657 and 29m17s on toybox-hardening
   #641 before failing (~55 min across 2 runs). HD mode #653 was reverted wholesale
   by #659 partly because the e2e-video lane ran 24-27 min at `--workers=1` with
   zero slack under its 30-min cap.
   - **Fix:** gate recording specs on `isConfigSupported()` and skip/degrade when
     CI lacks an H.264 encoder; make pixel/shader asserts renderer-tolerant; cap
     e2e-video wall-time so a hang fails fast. Audit against the >2-min standard.

6. **Self-inflicted unit/lint failures caught only on CI (preventable locally in
   <1 min).** behavioral-recon-4 #680 failed the unit job at
   `scripts/test-reconciliation.test.ts:199` — the disabled-count meta-test the
   SAME PR changed (fixed in-PR by `e29b36e5`). actionlint failed on
   fix/toybox-node-controls #655. Both deterministic, both runnable in <1 min.
   - **Fix:** per CLAUDE.md "run NEW tests locally before CI": run full `task test`
     (incl. `scripts/test-reconciliation`) for any recon/meta-test change, and run
     actionlint locally before pushing CI-yaml edits.

## Thrash assessment

High churn, and a large share of it is **re-discovery rather than net-new**. Of the
last 50 merges, 34% (17/50) were fix/revert/perf follow-ups vs 44% net-new feat.
There were 13 fix-of-fix chains where a fix/perf/revert landed on the SAME scope as
a just-merged feat/fix: median time-to-followup 1.4h, mean 6.0h, 12/13 within 24h,
all 13 within 48h.

The dominant single cluster is the **poly-synth wave** (5 feats → 5 same-day fixes),
all one voice-gating/pitch-on-release/silent-when-patched bug class that one shared
design+test pass would have prevented.

CI-side, the **re-run treadmill** is the bigger waste: 41/58 detailed runs died on
exactly ONE real failing job plus the umbrella aggregate (one flaky shard sinks the
whole run), and toybox PRs needed 3 full ~15-18min CI cycles each
(#658/#625/#621/#633/#623/#688) — the main contributor to the 32.3h of red
wall-time. Three modules (toybox 25 commits, electra/control-surface 10,
video/HD/aspect 9) account for ~44% of the 100-commit window.

Net: most of the week's lost time is follow-up/re-run churn driven by (a) flaky
toybox/video shards and (b) green-but-broken merges that used CI-green as the first
behavior check — both explicitly forbidden by existing repo standards.

## Suggested standard changes

1. **Final-commit-green / red-main-push-is-P0.** CLAUDE.md has "run new tests
   locally" + "flake-check 3×" but NO rule that a PR's OWN final-commit CI run must
   be green before merge, and none that a red main-push run is P0. *Proposed:* "Do
   not merge until THIS PR's CI run is green on its FINAL commit (not an earlier
   run, not a still-running run). A red main-push run is a P0 to be root-caused,
   never absorbed as flake." (Codifies the memory-only never-merge-on-red +
   verify-green-ON-CI.)

2. **Poly/MIDI real source→module→audible-output e2e.** No standard requires it;
   per-port coverage only asserts the edge materializes. *Proposed:* "Any poly/MIDI
   module ships an e2e that wires the REAL default-mode source (MIDI LANE/POLYSEQZ)
   → module → asserts audible RMS at output. A per-port edge-materializes assertion
   does not count as poly coverage."

3. **Post-merge conflict-sweep file list is stale post-#551.** CLAUDE.md lists
   `modules/index.ts`, `Canvas.svelte`, `module-categories.ts`, `types.ts` — these
   no longer collect per-module adds (registration is glob+palette), and the paths
   are wrong (index.ts split into `lib/{audio,meta,video}/modules/index.ts`,
   Canvas.svelte at `lib/ui/Canvas.svelte`, no `modules/types.ts` — it's
   `lib/graph/types.ts`). *Proposed:* update to the ACTUAL remaining hand-maintained
   surface: `docs/module-manifest.ts` (DESCRIPTIONS), e2e/vrt exemptions,
   `modules-card-map.test.ts EXPECTED_NODE_TYPES`, the per-port/vrt spec lists; note
   registration is now glob/palette-driven; keep the sweep discipline (poll
   mergeability, merge-main-in not update-branch).

4. **@collab decision.** Live ruleset 16042163 has exactly 2 required contexts
   (`vrt-strict (visual regression — strict subset)` and
   `typecheck + unit + ART + E2E`); the "make @collab required once stable" goal is
   memory-only, and @collab failed 12× incl. 4+ main-push collab-only reds.
   *Proposed:* either stabilize @collab and add it as a 3rd required context, or
   record in CLAUDE.md why it can't be (relay single-process / DB-vacuous) so agents
   stop treating its red as optional.

5. **Capability/renderer-dependent + CI wall-time standard.** Both memory-only.
   recorderbox #687 (no CI H.264 encoder) and edges #688 (SwiftShader≠GPU) passed
   3× locally but failed CI; e2e-video hit 25-29 min and contributed to the HD-mode
   wholesale revert. *Proposed:* fold into module-pr-checklist — (a) for any
   hardware-encoder/getUserMedia/WebGL-precision module, gate the assertion on a
   runtime capability probe and confirm green ON CI; (b) estimate the PR's CI
   wall-time delta and flag anything >~2 min before merge.

## Suggested skill changes

- **module-development.md (lines ~38-40):** dead 6-file process. *Verified stale*
  via the file headers (index.ts: "GLOB-DRIVEN… Adding a module no longer requires
  editing this file"; Canvas.svelte uses `buildNodeTypes` from
  `$lib/ui/modules-card-map`, only a timelorde special-case remains;
  module-categories.ts has `MODULE_CATEGORIES = {}` and reads `def.palette`;
  AUDIO_VCOS/UTILITIES arrays don't exist). *Rewrite* to the glob+palette model;
  list actually-hand-maintained files; point at `scripts/new-module.ts`; add a
  "label: must be lowercase (guarded by registry-manifest.test.ts)" line.

- **coding-conventions.md (~84-95) + architecture.md (~96-98):** repeat the same
  dead 6-file model, contradicted by the file headers AND by
  `.claude/workflows/moog-batch-2.js` (which correctly says "do NOT touch any
  shared/registry file — the codegen auto-discovers via import.meta.glob"). *Delete*
  the per-file lists; replace with one line referencing module-development.

- **debugging.md (lines 13, 25):** recommend `gh run view <RUN_ID> --log-failed`
  and `gh run view --job=<JOB_ID> --log` — these WEDGE the shell. *Replace* with the
  non-wedging `gh api .../jobs --jq` + `task pr:watch` / `task ci:health`; add an
  explicit "NEVER use --log/--log-failed (wedges the shell)" warning.

- **pr-workflow.md (lines 17-21, 38):** three verified inaccuracies — (1) required
  checks named `VRT (visual regression)` but the live ruleset requires
  `vrt-strict (visual regression — strict subset)`; (2) claims strict-up-to-date is
  enforced — verified FALSE (`strict_required_status_checks_policy=false`); (3)
  prescribes `gh pr update-branch` which CLAUDE.md + memories forbid (silent-drop),
  while the same file documents the hazard at lines 46-60 (internally
  contradictory). *Fix* the check name; drop the strict-up-to-date claim; replace
  the update-branch recipe with local `git merge origin/main` + diff.

- **deploy-pipeline.md (line 31):** says deploy-prod is workflow_dispatch only — but
  `deploy.yml` (lines 132-147) ALSO fires deploy-prod on push to main when
  `detect-version-bump.outputs.bumped=='true'`. *Add* the push+version-bump
  auto-deploy row.

## Inaccuracies found (verified)

| Location | Stale claim | Reality |
|----------|-------------|---------|
| module-development.md ~38-40 (+ coding-conventions ~84-95, architecture ~96-98, CLAUDE.md conflict sweep) | Adding a module requires editing ~6 shared registry files | PR #551 (`976d1846`) made registration glob+palette-driven; index.ts header says so; Canvas.svelte resolves cards via `buildNodeTypes`/modules-card-map; `MODULE_CATEGORIES={}` reads `def.palette`; ModuleType is an open branded string |
| pr-workflow.md 17-21 | Required checks are `typecheck+unit+ART+E2E` and `VRT (visual regression)`; strict-up-to-date enforced | Live ruleset 16042163: `vrt-strict (visual regression — strict subset)` + `typecheck + unit + ART + E2E`; `strict_required_status_checks_policy=false` |
| pr-workflow.md 38 | `gh pr update-branch` is the standard merge-ordering play | Banned by CLAUDE.md + `feedback_update_branch_silent_drops` (silent-drop); same file documents the hazard at 46-60 |
| debugging.md 13, 25 | `gh run view --log-failed` / `--job= --log` are the fast triage path | They WEDGE the shell; non-wedging `gh api .../jobs --jq` is already present |
| MEMORY.md index line 29 (project_task_targets) | "...no VRT harness yet" | Stale: `task vrt`/`vrt:strict`/`vrt:update`/`vrt:gallery`/`vrt:one` all exist; vrt:strict is a BLOCKING required lane (detail file already self-corrected) |
| deploy-pipeline.md 31 | deploy-prod = manual workflow_dispatch only | `deploy.yml` 132-147 also fires deploy-prod on push to main with a package.json version bump |

## Biggest wins

1. **Fix the toybox/video e2e shards** (the #1 failure driver, 43/58 instances):
   move WebGL/toybox-graph-interaction specs into the serialized e2e-video lane,
   scale per-spec timeout by input/capture count, keep them informational until 3×
   green on CI — so audio PRs stop inheriting the flake and the re-run treadmill
   ends. Recovers the bulk of the 32.3h of red wall-time.

2. **Stop green-but-broken merges** with two codified rules: (a) "do not merge
   until THIS PR's final-commit CI run is green; a red main-push run is P0" (would
   have caught synesthesia #698 + saved #699/#701/#702), and (b) "any poly/MIDI
   module ships an e2e on the REAL default-mode source→module→audible-RMS chain"
   (would have caught POLYHELM #677 + the poly wave's 5 same-day fixes).

3. **Update the stale docs to match PR #551 + the live ruleset:** rewrite the
   6-file registry model to glob+palette in module-development/coding-conventions/
   architecture + CLAUDE.md; fix pr-workflow.md's required-check name; kill its
   update-branch advice + false strict-up-to-date claim; remove debugging.md's
   shell-wedging `--log-failed`. Cheap, high-confidence, stops agents from
   hand-editing codegen-owned files, banned git ops, and shell-wedging commands.
