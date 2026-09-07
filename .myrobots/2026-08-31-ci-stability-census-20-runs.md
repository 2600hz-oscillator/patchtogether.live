# CI stability census — last 20 conclusive CI runs

Window: **2026-08-30T03:32Z → 2026-08-31T14:22Z**, workflow `CI` (id 271237008),
all branches. Method: `gh run list --workflow CI`, then `gh run view <id> --json
jobs` and `--log-failed` for every non-success job. Cancelled runs are excluded
from the denominator (they carry no test signal); five runs immediately before
the window are folded in as context because they are the same storm.

Analysis only. Nothing was fixed, parked, re-run, gated, or filed.

## Headline

**10 red / 10 green — a 50% red rate.**

**Zero hard test failures. Zero infra failures.** Every single red in the window
is one of exactly two things:

- **6 runs** — an e2e **flake-gate red** (a test failed then passed on retry).
- **4 runs** — a **webgl-attest hash refusal** on a PR that genuinely edited a
  basis file. Correct behaviour, not instability.

The suite has no broken tests. It has a boot path that is nondeterministic under
shard load, an instrument that asserts on an unvalidated sample, and a
credentials bug that deadlocks the baseline loop. Those three, plus the parking
that has been used to absorb the first one, are the whole census.

## Run-by-run

| # | run | branch | result | failing job | cause |
|---|---|---|---|---|---|
| 1 | 33402250777 | feat/backdraft-panic | ✗ | e2e shard 3/12 | tempolock flake |
| 2 | 33399746547 | feat/backdraft-panic | ✗ | e2e shard 3/12 | backdraft-panic flake |
| 3 | 33397161361 | feat/trails-module | ✓ *(attempt 2)* | attempt 1 = `action_required` | #1815/#1816 approval park |
| 4 | 33395321561 | feat/backdraft-panic | ✗ | webgl-attest | expected hash move `4be797ab` |
| 5 | 33394905776 | main | ✓ | — | — |
| 6 | 33392674245 | fix/tempolock-unpark | ✓ | — | — |
| 7 | 33392669150 | feat/backdraft-panic | ✗ | webgl-attest | expected hash move `4be797ab` (2nd time, same hash) |
| 8 | 33391686574 | main | ✓ | — | — |
| 9 | 33311166513 | main | ✓ | — | — |
| 10 | 33297113901 | feat/record-cv-automation | ✗ | webgl-attest | expected hash move |
| 11 | 33296445368 | fix/present-fullscreen | ✓ | — | — |
| 12 | 33296014167 | feat/ptzcam-multicam | ✓ | — | — |
| 13 | 33295536737 | feat/gibribbon-rewrite | ✗ | webgl-attest | expected hash move `4acb8429` |
| 14 | 33295376635 | fix/tempolock-unpark | ✓ | — | — |
| 15 | 33295180895 | **main** | ✗ | e2e shard 7/12 | workflow-mode flake — **main red** |
| 16 | 33294322926 | fix/vrt-fleet-tolerance | ✓ | — | — |
| 17 | 33294310335 | feat/ptzcam-multicam | ✓ | — | — |
| 18 | 33293449487 | fix/vrt-fleet-tolerance | ✗ | e2e shard 7/12 | workflow-mode flake |
| 19 | 33293431117 | feat/ptzcam-multicam | ✗ | e2e shard 7/12 | workflow-mode flake |
| 20 | 33292812684 | fix/vrt-fleet-tolerance | ✗ | e2e shard 7/12 | workflow-mode flake |

Context, immediately before the window (same night, same storm):

| run | branch | failing job | cause |
|---|---|---|---|
| 33291739984 | feat/ptzcam-multicam | e2e shard 7/12 | workflow-mode:470 |
| 33291594537 | fix/vrt-fleet-tolerance | e2e shard 7/12 | workflow-mode:261 |
| 33290948366 | feat/record-cv-automation | webgl-attest | expected hash move |
| 33290938672 | feat/gibribbon-rewrite | webgl-attest | expected hash move |
| 33290507280 | **main** | e2e shard 7/12 | workflow-mode:261 — **main red** |

## Aggregate: one row per unique (spec, test)

| spec · test | obs | mode | shard | branches | parked? | first→last | evidence-based hypothesis |
|---|---|---|---|---|---|---|---|
| `workflow-mode.spec.ts` · **6 distinct legs, one shared helper** | **7** | recovered-on-retry ×7 | **7/12** | main ×2, fix/vrt-fleet-tolerance ×3, feat/ptzcam-multicam ×2 | **now spec-wide parked** (995e44a14, b9f87522a) | 33290507280 → 33295180895 | Every one is `TimeoutError: page.waitForFunction` inside `waitForPinnedTrio` — the workflow "ensure" effect has not written `__patch.nodes[trio].data.pinned === true` by the bound. Not a per-leg bug: one boot helper, six victims. |
| `tempolock.spec.ts:135` · folds a 216-edge/min onset train to 108 and TIMELORDE follows the tracked tempo | 1 | recovered-on-retry | 3/12 | feat/backdraft-panic | no (un-parked by #2276) | 33402250777 (only) | `Expected < 111, Received 111.96205730280293`. The poll validates sample A (`> 105`); line 214 re-reads a **fresh** sample B and asserts `< 111`. Two independent samples, not one invariant. |
| `backdraft-panic.spec.ts:259` · the panic GATE fires the same reset (deterministic bridge-replay seam) | 1 | recovered-on-retry | 3/12 | feat/backdraft-panic | no | 33399746547 (only) | `Error: live handle reachable — Expected true, Received false` at :284. Handle-readiness race. **Fixed at 317d70d7d**; did not reproduce on the next run. |
| webgl-attest hash refusal | 4 (+2 context) | expected gate | n/a | backdraft-panic ×2, record-cv-automation, gibribbon-rewrite | n/a | 33290938672 → 33395321561 | **Not instability.** PR #2266 edits `packages/web/src/lib/video/modules/backdraft.ts` and `lib/video/panic-hook.ts` — real basis files — and now carries `ci-webgl-attest/4be797ab….json`. |
| `vrt-update-baselines` revalidate · approve → HTTP 403 | **5/5 runs** | infra, deterministic | n/a | feat/trails-module, fix/vrt-fleet-tolerance | n/a | 33288207251 → 33396686517 | PAT lacks `Actions: write`; cannot approve the parked `ci.yml` run its own bot push created. |

## Class A — product bug candidates

**None proven by this window.** No test failed both attempts anywhere.

Two candidates surfaced indirectly and neither is a flake:

1. **`dx7.spec.ts` · "dx7: switching algorithm changes the audible scope
   content"** — currently a runtime skip whose budget reason explicitly says it
   is **not** a park:

   > *CORRECTLY DETECTING A SUSPECTED LIVE REGRESSION — not a parked flake. The
   > repaired assertion fails because switching the algorithm produces NO
   > measurable timbre change; measurements and the host/worklet trace are in
   > the PR body (#1787 batch 5).*

   A live product regression is being carried as a skip. It costs nothing in CI
   and buys nothing in signal.

2. **`workflow-mode` pinned-trio boot** — the failure is *only* ever the boot
   effect not landing in time. Whether that is a slow runner or a workflow
   `ensure` effect that can genuinely stall is unresolved; see class C.

## Class B — test / instrument defects

### B1. `tempolock.spec.ts:214` asserts on a sample it never validated

`e2e/tests/tempolock.spec.ts` (origin/main, lines 208–214):

```ts
await expect
  .poll(() => readTimelordeBpm(page, TL), {
    timeout: process.env.CI ? 90_000 : 25000,
    message: `timelorde bpm settles at the tracked ${TRACKED_BPM} …`,
  })
  .toBeGreaterThan(TRACKED_BPM - 3);                             // validates sample A > 105
expect((await readTimelordeBpm(page, TL))!).toBeLessThan(TRACKED_BPM + 3);  // asserts on FRESH sample B < 111
```

The poll's only exit condition is `> 105`. The follower descends from 216 toward
108, so it crosses 105-and-up long before it settles — the poll returns on a
sample that is still on the way down. The next line then takes an **unvalidated
fresh read** and requires `< 111`. Observed `111.96` is exactly a follower still
descending.

⚠ **This matters for the in-flight fix.** Run 33402250777 is head
`317d70d7d`, which contains merge `e0b023718` pulling in `dd8115bd1` — the
#2276 "CI-aware budgets for tempolock's settle polls" fix (merged 13:03Z; the
run is 14:22Z). **The budget fix was already in and the flake reproduced.** More
budget cannot repair a two-sample assertion. The separate fix in flight should
know this before it re-pins the timeout again.

The repository already has this pattern named: *"Sample twice, assert on the
second"* — validate a frame then re-read is invariant to the subject, and it
reads like a product bug.

### B2. `backdraft-panic.spec.ts:284` — handle readiness (already fixed)

```
Error: live handle reachable
expect(received).toBe(expected)   Expected: true   Received: false
> 284 |     expect(fired.ok, 'live handle reachable').toBe(true);
```

Fixed on the same branch at `317d70d7d` — *"make the panic-GATE e2e wait on the
live handle, not the DOM node"*. Confirmed: it did not reappear on the next run
(33402250777) at that head. Nothing further needed.

## Class C — load / contention sensitive

### C1. `workflow-mode.spec.ts` on e2e shard 7/12 — the dominant story

Seven observations, six distinct test legs, **one shared helper**, always
shard 7:

| run | branch | leg | bound |
|---|---|---|---|
| 33290507280 | **main** | `:261` default wiring: pinned MIXMSTRS master L/R auto-wires to pinned AUDIO OUT | 10 000 ms |
| 33291594537 | fix/vrt-fleet-tolerance | `:261` same leg | 10 000 ms |
| 33291739984 | feat/ptzcam-multicam | `:470` File.. menu: quicksave slot 1 round-trips through quickload | 10 000 ms |
| 33292812684 | fix/vrt-fleet-tolerance | `:326` default wiring carries REAL audio: source → mixmstrs ch1 → auto-wired AUDIO OUT is audible | 10 000 ms |
| 33293431117 | feat/ptzcam-multicam | `:537` File.. menu: Clear rack … KEEPS the pinned trio | 10 000 ms |
| 33293449487 | fix/vrt-fleet-tolerance | `:461` File.. menu: quicksave slot 1 round-trips through quickload | 10 000 ms |
| 33295180895 | **main** | `:531` File.. menu: Clear rack … KEEPS the pinned trio | **30 000 ms** |

All seven are the identical stack:

```
TimeoutError: page.waitForFunction: Timeout 10000ms exceeded.
   48 |   await page.waitForFunction(
      |              ^
   at waitForPinnedTrio (e2e/tests/workflow-mode.spec.ts:48:14)
```

**⚠ The leading hypothesis is disproven by the data.** Commit `995e44a14`
replaced the hand-typed `10_000` with `BOOT_MS` (`SLOW_RENDER ? 30_000 :
15_000`) and documented it as an #1906-class "lost the wall-clock lottery"
site. The very next `main` run (33295180895, head `995e44a14`) timed out at
**30 000 ms** on line 53 anyway. Tripling the bound did not fix it. Whatever
stalls the pinned-trio write is not a 10-vs-30-second margin.

The in-tree response escalated instead of narrowing:

- `9932a6153` — parked 2 legs (typing-inertness, pinned-deletion).
- `995e44a14` — `BOOT_MS` fix **plus** 3 more per-leg parks.
- `b9f87522a` — **spec-wide park**, owner-authorized pre-show, with the honest
  note: *"SIX consecutive runs flaked SIX DIFFERENT legs of this one spec on
  shard 7 … the failing unit is the spec's shared boot path under a degraded
  runner, not any leg, so per-leg parks were whack-a-mole."*

`workflow-mode.spec.ts` now carries **14 `test.fixme`** — second only to
`card-drop-patch.spec.ts` (16).

**Co-tenancy.** Shard 7 carries 191 test results in ~640–750 s; shard 3 carries
302 in ~700–750 s. Shard 7 is a *spread* shard of long, boot-heavy specs, not a
packed one — consistent with the repository's cost-based sharding note. Every
observation is on shard 7 and none on any other shard, so the trigger is
co-located with whatever else shard 7 boots, not global fleet load.

**Skip drift on shard 7** (the parking landing in real time):

| run | date | runtime skips / 191 |
|---|---|---|
| 33290507280 | 08-30 03:32Z | 15 |
| 33291594537 | 08-30 04:02Z | 15 |
| 33292812684 | 08-30 04:35Z | 16 |
| 33291739984 / 33293449487 | 08-30 04:06Z / 04:52Z | 17 |
| 33293431117 / 33295180895 | 08-30 04:51Z / 05:39Z | 18 |
| 33394905776 (main, green) | 08-31 13:19Z | **22** |

Shard 7 gained **7 skips in 34 hours** and went green. Skips are not passes:
22/191 ≈ **11.5% of shard 7 does not run**.

## Class D — infrastructure

### D1. #1815/#1816 — the baseline loop cannot approve its own run (100% reproducible)

Run 33396686517, job *"re-validate CI on feat/trails-module (re-fire +
VERIFY)"*:

```
baseline commit pushed: 25b47d68bca4f6bc6aa29ec92d7a29c83ab620b7
[probe 1] head=25b47d68b runs=[run 33397161361 [parked] status=completed
          conclusion=action_required — PARKED AWAITING APPROVAL (#1815)]
Approving parked run 33397161361 (POST .../actions/runs/33397161361/approve)…
gh: Resource not accessible by personal access token (HTTP 403)
[approve] FAILED … The job's token needs `actions: write`; a fine-grained PAT needs Actions:write.
verdict: approval-failed (re-fires=0, approvals=1, probes=2)
posted a deadlock notice on PR #2277
```

This is not intermittent. The **last five** `VRT update baselines` runs failed
with the identical error, across two branches:

| run | branch | date |
|---|---|---|
| 33396686517 | feat/trails-module | 08-31 13:23Z |
| 33289626080 | fix/vrt-fleet-tolerance | 08-30 03:09Z |
| 33289269230 | fix/vrt-fleet-tolerance | 08-30 03:00Z |
| 33288942338 | fix/vrt-fleet-tolerance | 08-30 02:51Z |
| 33288207251 | fix/vrt-fleet-tolerance | 08-30 02:32Z |

Downstream cost, visible in the window: run **33397161361** (feat/trails-module)
sat at `action_required` on attempt 1 and only went green on a
human-approved **attempt 2**. Two more workflows on that same branch are still
parked: `Deploy` and `VRT changeset gallery`, both `completed/action_required`.

The single-line root cause is in the error text: the token used by the
revalidate job lacks `Actions: write`.

### D2. Everything else in the window was clean

No runner failures. No LFS errors. No artifact upload/download failures. No job
or global timeouts. **No `vrt-strict` shard timeouts** — all 12 shards green in
every run (the 12-shard split is holding; the 8-shard 600 s cliff did not
recur). The `collab` job passed everywhere and remains informational/un-gated.

## Class E — parked tests: is the park working?

**Yes, and the brief's premise needs one correction.**

The excerpt listing `cv-range-uniformity`, `illogic-face`,
`launchpad-perf-controls` ×2 and `per-module-per-port-inputs (synesthesia)` is
**not** a list of new observations. It is the flake-gate's **"Skipped at
runtime"** section — the skip-budget ledger printing every parked test together
with its **historical** reason string. The recovered-on-retry counts inside
those strings ("21 observations in the 96 h census to 2026-08-18", "1
observation, PR #2265 run 33258138560") are baked into the reason text and are
reprinted verbatim on every run, green or red.

**No parked test produced a new observation in this window.** They skipped.
That is the park working exactly as intended, and it should not be read as
leakage.

The problem with the park is its **size**, not its behaviour:

| measure | value |
|---|---|
| e2e tests declared on `origin/main` | 610 |
| `test.fixme` | **205** |
| **share of the e2e suite parked** | **33.6%** |
| spec files carrying at least one park | 67 |
| parks citing `FLAKE-PARK #1847` | 198 |
| named (spec, reason) entries in `scripts/e2e-skip-budget.mjs` | 48 |

Issue #1847 disabled **95** tests on 2026-08-18. Thirteen days later it is
**205**. The census that opened #1847 assessed all 95 and concluded *"none of
the 95 is a low-value test."*

Largest parked specs: `card-drop-patch` (16), `workflow-mode` (14),
`workflow-dock-ux` (7), `io-spec-consistency` (7), `workflow-shell` (6),
`per-module-per-port-behavioral` (6), `clipplayer-songmode` (6),
`clipplayer-controls` (6), `backdraft-preview-toggle` (6).

## What every gate is structurally unable to see

The flake gate prints its own blind spots on every run, and two of them fired
inside this very window:

- **(a) recovery across a whole-JOB re-run** — run 33397161361 is recorded as a
  clean `success` at attempt 2. Nothing in the green signal says attempt 1 was
  `action_required`. Any full-run re-run would be similarly invisible.
- **(b) a test killed by a job or global timeout** reports as a hard failure or
  as nothing, never as `flaky`.
- **(d) nondeterminism that happened to pass twice** — unmeasurable by
  construction, and the whole reason a 50%-red window with zero hard failures
  is not reassuring.

Two more, specific to this census:

- **Parking removes the observation, not the defect.** A spec-wide park converts
  a measurable flake rate into zero data. `workflow-mode`'s root cause is now
  unobservable in CI by design.
- **A run that never runs is not a green run.** The `action_required` park
  produces a PR whose checks are neither red nor green.

## Ranked by blast radius

**Threat to a random PR's green:**

1. **`workflow-mode.spec.ts` boot path on shard 7** — 7 observations, 4
   branches, 6 different legs, ~34 h. Before the spec-wide park it hit roughly
   every other run on any branch that happened to land on shard 7. *Now
   suppressed, not fixed.*
2. **#1815/#1816 approval 403** — deterministic. Every VRT baseline update
   deadlocks its own PR until a human approves.
3. **`tempolock.spec.ts:135`** — un-parked, structurally unsound, and the
   shipped fix targeted the wrong cause. Will recur.
4. **webgl-attest double-red** — not instability, but PR #2266 burned two full
   CI rounds 31 minutes apart on the same missing hash.

**Threat to `main`:**

1. **`workflow-mode` — the only failure family that actually reddened `main`,
   and it did so twice in 2h07m** (33290507280 at 03:32Z, 33295180895 at
   05:39Z). Per the standing rule, a red `main` is P0; this produced two.
2. **The 33.6% park** — a third of the e2e suite is not defending `main` at all.
   The `dx7` skip is a suspected live regression riding through.

## What 100% stability requires

Concrete work items, evidence-attached. Recommendations only — no gates, no
issues, no parks proposed here; those are the owner's to decide.

1. **Root-cause `waitForPinnedTrio`.** This is the highest-leverage item by a
   wide margin. Constraints the evidence already fixes: it is not a
   10-vs-30-second margin (30 000 ms failed on `main`); it is not any single
   leg (six legs, one helper); it is shard-7-local (zero observations on the
   other eleven shards). The open question is whether the workflow "ensure"
   effect that writes `data.pinned` can genuinely stall behind something else
   shard 7 boots, or whether the trio write is racing a Y.Doc/proxy identity
   seam. Un-parking the 14 legs depends entirely on this answer.

2. **Repair the tempolock assertion shape, not its budget.** Fold the band into
   a single polled predicate so the sample that satisfies the wait is the sample
   that is asserted — e.g. poll `bpm > 105 && bpm < 111` to `true`, instead of
   polling one bound and re-reading for the other. The current form cannot be
   made reliable by any timeout. Worth passing to whoever owns the in-flight
   #2276 follow-up before they re-pin the number again.

3. **Grant the vrt-update token `Actions: write`** (or move the approve call to
   a job token that has it). One permission. Unblocks the entire baseline loop
   and removes the only 100%-reproducible red in the fleet.

4. **Decide `dx7`.** A suspected live regression is parked as a skip with a
   reason that says it is not a flake. It is either a product bug to fix or a
   test to delete — a skip is the one option that keeps the cost and drops the
   signal.

5. **Take a position on the 205 parks.** 33.6% of the e2e suite, 67 specs, 198
   citing #1847, and growing ~8/day over the last two weeks. Nothing in CI can
   observe a regression in that third. The census behind #1847 already recorded
   that none of the original 95 was low-value.

6. **Reduce attest round-trips.** `task webgl:attest:check` already exists and
   answers "will this PR be refused?" locally. Two of the four in-window attest
   reds were the same hash on the same branch, 31 minutes apart.

7. **Note for any future census:** a run's `conclusion: success` does not mean
   attempt 1 was green (33397161361). Read `attempt` alongside `conclusion`.

## Appendix — job ids for the evidence quoted

| run | job | what it shows |
|---|---|---|
| 33402250777 | 99522360949 | tempolock `Expected < 111, Received 111.962`; flake-gate red |
| 33399746547 | 99513958991 | backdraft-panic `live handle reachable` false |
| 33295180895 | 99213844669 | workflow-mode `:531`, **30 000 ms** timeout on `main` |
| 33293449487 | 99209314988 | workflow-mode `:461`, 10 000 ms |
| 33293431117 | 99209233681 | workflow-mode `:537`, 10 000 ms |
| 33292812684 | 99207676291 | workflow-mode `:326`, 10 000 ms |
| 33291739984 | 99207067301 | workflow-mode `:470` |
| 33291594537 | 99205327439 | workflow-mode `:261` |
| 33290507280 | 99201570913 | workflow-mode `:261` on `main` |
| 33395321561 | 99498346799 | webgl-attest hash `4be797ab` refusal |
| 33295536737 | 99214439285 | webgl-attest hash `4acb8429` refusal |
| 33396686517 | — | vrt-update revalidate, HTTP 403 on `/approve` |
| 33394905776 | e2e shard 7/12 | green `main`: `0 flaky · 22 skipped` |
