# Adversarial CI simplification audit — 2026-08-23

Owner directive: the build/test pipeline is overengineered and clumsy; recommend what to
delete. Posture: burden of proof on EXISTENCE. Recommendations only — nothing here was
changed. Evidence window: the week of 2026-08-16..23 (the face program's heavy accretion).

## The headline numbers

| fact | measured |
|---|---|
| workflows | 15 |
| scripts/ entries | 101 (≈38 are `*.test.ts` gating CI itself, not product) |
| committed cost/ledger artifacts | 4 (`e2e-timings`, `vrt-strict-timings`, waits ledger, skip budget) |
| commits to ONE planner file this week | 21 (`scripts/e2e-shard-plan.mjs`) |
| commits to cost artifacts this week | 14 |
| red PR runs caused by MACHINERY (not product) this week | ≥9 (shard-budget 85% on #2100/#2110/#2123/#2131/#2142; capture-timeout killed 3 lanes' captures; PENDING-freshness reds ×3) |
| red MAIN runs caused by machinery this week | ≥3 (stale inventory count; vrt-strict capacity ×2 — incl. today's) |
| stale-cost incidents total ("the saga") | 6 |

The pattern: every gate that fails on a FORECAST (a budget, a freshness deadline, a
headroom percentage) converted artifact staleness into red CI, and the artifacts go stale
by design because the face program grows the suite daily. Gates that fail on EVENTS
(a test failed, a flake recovered, a hash mismatched) caught real product bugs all week.

**Keep event gates. Delete forecast gates.** That one sentence is most of this audit.

## DELETE NOW

| # | machinery | protects (claimed) | cost this week (measured) | what deleting looks like |
|---|---|---|---|---|
| 1 | **Shard-budget headroom FAIL** — `scripts/e2e-shard-budget.sh` fail-at-85% + the identical vrt-strict step | "a shard near `--global-timeout` might be killed mid-run someday" | 5 PR reds + 2 main reds, all with EVERY TEST PASSING | Delete the failure exit (and per the owner: no warning replacement). The real event — a shard actually killed by `--global-timeout` — is already loud and unambiguous. Files: the exit-code logic in `e2e-shard-budget.sh`, its test, the vrt-strict twin step. |
| 2 | **PENDING_FIRST_MEASUREMENT machinery** — the list in `e2e-shard-plan.mjs`, its freshness-gate legs, the deadline choreography | cost-accuracy of the planner it feeds | 3 PR reds; every new spec owes paperwork | Dies with #1 and #3. Delete the list, the two gate legs in `e2e-shard-plan.test.ts`, every "delete this entry on first accept" ritual. |
| 3 | **The LPT cost planner + both cost artifacts + both accept scripts** — `e2e-shard-plan.mjs`, `vrt-shard-plan.mjs`, `e2e-timings.generated.json`, `vrt-strict-timings.generated.json`, `e2e-timings-accept.mjs`, `vrt-strict-timings-accept.mjs`, `vrt-shard-coverage.*` | even shard packing | 21+14 commits of churn; the 6-incident staleness saga; a per-face "recost policy" tax | Use Playwright's native `--shard=k/N`. Worst case is uneven shards costing single-digit minutes of wall time — vs a week in which the planner itself was the top source of red CI. If a specific pair of specs genuinely must not co-locate, pin THAT pair explicitly; don't maintain a cost database for it. |
| 4 | **Capture-timeout ratchet** — `vrt-capture-timeout.test.ts` + the derived-ceiling comment block in `vrt-update.yml` | "the capture may exceed its timeout as baselines grow" | 1 PR red (fired on its own author); the 75→115→125 bump saga | Keep `timeout-minutes: 125`, delete the forecasting test. When a capture actually times out, the scoped `GREP=` dispatches are the working path anyway (3 min vs 45). |
| 5 | **Citation gate** — `agent-context.test.ts` (tree-wide "no file cites a missing `.myrobots` record") | stale prose pointers | 1 PR red (#2133) | Delete. A stale pointer in a comment is a nuisance; a gate that reds CI over it is a tax. |
| 6 | **docs-only-gate pair** — `docs-only-gate.yml` + `.mjs` + test + the `paths-ignore` complement in `ci.yml` | required-context deadlock on prose-only PRs | none this week, but it is a matched-pair trap by design ("the path lists move TOGETHER") | Delete by removing `paths-ignore` from `ci.yml`: docs PRs just run CI. They are rare; ~25 wasted minutes per docs PR buys deleting a whole workflow, a script, a test, and a standing footgun. |
| 7 | **Park-tracking triplication** — SKIP_BUDGET (`e2e-skip-budget.mjs`) + the `.myrobots` tests-to-fix list + the flake-park ledger | disabled tests stay visible | 1 PR red for missing paperwork that existed in a sibling mechanism | ONE park list. Recommend keeping the deny-by-default skip budget (it is anchored both directions and enforces the owner's park rule) and deleting the other two as authorities — `.myrobots` notes stay as prose, not gates. |

## SIMPLIFY

| machinery | keep the goal, shrink the mechanism |
|---|---|
| **vrt-scope auto-derivation** (`vrt-scope.mjs` tokenizer) | Keep manual `GREP=<module>` scoped dispatch (real 3-min-vs-45-min win). Drop the diff-tokenizer inference — its false positives (comment text, `.filter(`, `edges` as identifier) forced full sweeps three times this week. The dispatcher asks the human/agent for the module name; deny nothing. |
| **Scheduled flake-hunting workflows** — `behavioral-flake-purge.yml`, `e2e-flake-purge.yml`, `flake-check-3x.yml`, `chaos-24-7.yml` | Four scheduled hunters predate this week but overlap the PR-time flake gate. Consolidate to at most one nightly; disable the rest. (Owner call — they cost runner minutes, not attention.) |
| **Gallery conveniences** — `vrt-changeset-gallery.yml`, `art-gallery.yml` | Keep only if actually opened by a human this month; otherwise disable the schedules. |
| **scripts meta-gate long tail** (~38 `*.test.ts` gating CI plumbing: umbrella-parity, selection-audit, report-audit, exemption anchors, boot-bound source, observation-window, setup-credit, greppable-source, …) | Each is small, but together they are a parallel test suite ABOUT the test suite. Rule of thumb to apply in one sweep: a meta-gate that (a) guards machinery recommended deleted above → delete with it; (b) has never fired on a real defect → delete; (c) fired on a real defect this week (flake-gate test, skip-budget anchors, attest basis tests) → keep. |

## KEEP — earned it this week, with evidence

| machinery | the real thing it caught |
|---|---|
| **Flake gate** (`--fail-on-flaky` + `ci-flake-gate.test.ts`) | Every "recovered flake" red this week was a REAL defect: under-budgeted specs (4 found+fixed), the quadralogical transition race, the blood-keyboard instability, the wavetable worklet-load race. This is the single highest-yield gate in the repo. |
| **WebGL attest** (whole chain) | Owner-valued; caught genuine basis drift (the unattested-main incident was a process gap, not the gate's). |
| **Worker-size check** (`measure-worker-bundle --check` in `build`) | The 3 MiB deploy outage class; 1.3 s; event-shaped (measures the actual bundle). |
| **Face/contract meta-gates in `packages/web`** (module-face-lint, face-readout/resting-text/width-source, parity suite, card-def-agreement, range gates, inventory DATA gates, the new drop gate) | Dozens of real product defects this week: dead knob travel, wrong-value announcements, unreadable toggles, the blank-lane refusal, range clobbering. These gate PRODUCT, not CI — different category from the plumbing above. |
| **Waits ledger + lint rule** | Mid-payoff (429→383) and its conversions keep exposing vacuous assertions (dx7). Keep until paid; add no machinery around it. |
| **worktree-guard / dev-server identity / e2e-port** | Local-dev safety; caught real cross-worktree server reuse. Not in the CI path. |
| **contract-lock / docs gates / ART pins** | The product's actual contract system; predates this week; event-shaped. |

## The minimal honest pipeline (what survives)

`ci.yml`: actionlint · lint · typecheck · unit · art · build (with worker-size) · dsp-build ·
build-web · e2e (plain `--shard`, `--fail-on-flaky`) · collab · webgl-smoke · webgl-attest ·
vrt-strict (plain shard) · behavioral-smoke → umbrella. Plus `deploy.yml`,
`vrt-update.yml` (capture, fixed 125-min timeout, scoped dispatch), `pages.yml`,
`live-smoke-alert.yml`, one nightly flake hunter, `daily-prod-deploy.yml`.

Everything else on the DELETE list above: ~2 workflows, ~10 scripts, 2 committed cost
artifacts, and the per-PR paperwork rituals (PENDING entries, recost-on-absorb, budget
math in PR bodies) that consumed a measurable fraction of every lane's attention this week.

## What this buys

- The 6-incident staleness class becomes structurally impossible (nothing consumes the costs).
- Face PRs lose three ritual steps (recost, PENDING entry, budget note).
- Red CI regains its meaning: a red run implies a failed test, a flake, or a hash mismatch — never arithmetic about the future.
