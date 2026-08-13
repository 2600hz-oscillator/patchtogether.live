# Test / CI framework assessment — 2026-08-12

Measured against `main` at `030a03a7`, plus the unmerged branch
`chore/eliminate-all-ratchets` (PR #1486) where noted. Every number below was
taken from the tree, from the GitHub Actions API, or from `git log` on the date
above. Where a figure is an estimate it says so.

The question asked was whether the test/CI apparatus wants a total rewrite or a
significant cleanup, and what should be deleted.

**Answer: cleanup, staged, ~−12,000 LoC of machinery. Not a rewrite.** The
expensive asset — ~358,000 LoC of tests, 314 image baselines, 134 audio
baselines — encodes knowledge that cannot be regenerated and is largely good;
the sweeps caught real bugs (DOOM's lost CV ports, dx7's dead preset selector,
tomtom's latching strike pad). The defect is **accretion, not architecture**.
There is no better architecture to migrate to. There is only less of this one.
The single place "rewrite" is the right word is the attest trio, where three
near-identical implementations should become one.

---

## 1. Measurement

### 1.1 The apparatus, separated from the tests

The distinction that matters: code that **asserts product behaviour** vs code
that **runs and polices** it. The second is the burden.

| Layer | Files | LoC | Comments | Kind |
|---|---:|---:|---:|---|
| `.github/workflows/*.yml` | 15 | 6,189 | 2,029 (33%) | machinery |
| — of which `ci.yml` | 1 | 2,800 | 1,128 (**40%**) | machinery |
| `.github/scripts/` | 1 | 65 | — | machinery |
| `Taskfile.yml` (**83 targets**) | 1 | 1,228 | 248 | machinery |
| `scripts/` non-test | 48 | 10,350 | — | machinery |
| `scripts/*.test.ts` — tests **of** the machinery | 15 | 5,603 | — | machinery policing machinery |
| `e2e/**` non-spec harness | 47 | 14,080 | — | machinery |
| — of which VRT scenes / exemptions / config | ~10 | ~6,000 | — | machinery |
| Unit-lane **policing gates** | 41 | 15,406 | — | machinery |
| Exemption-ledger source booked as product code | 4 | 1,624 | — | machinery |
| `CLAUDE.md` + `.claude/skills/` | 23 | 3,998 | — | machinery (prose) |
| **Machinery total** | **~195** | **~58,500** | | |
| `e2e/**/*.spec.ts` | 459 | 125,328 | 41,166 across e2e (**30%**) | tests |
| — of which universal registry sweeps | 6 | 7,989 | — | tests |
| `packages/**/*.test.ts` minus policing | ~743 | ~210,700 | 36,314 across unit (16%) | tests |
| ART scenarios + harness | 123 | 22,024 | — | tests |
| **Test total** | **~1,325** | **~358,100** | | |
| Product source (`.ts`/`.svelte`, non-test) | 1,261 | ~391,700 | — | product |
| Committed baselines | 314 PNG (13 MB LFS) + 134 `.f32` | — | — | artifacts |
| `.myrobots/` | 132 | 55,332 | — | evidence |

Machinery is **16% of the test corpus** and **15% of the product**.

The exemption-ledger source counted as machinery above:
`packages/web/src/lib/ui/workflow/strict-faces.ts` (660),
`packages/web/src/lib/docs/strict-docs.ts` (444),
`packages/web/src/lib/graph/raw-write-ledger.ts` (326),
`packages/web/src/lib/ui/modules/card-def-debt.ts` (194).
`e2e/vrt/vrt-exemptions.ts` (1,122) is already inside the e2e harness figure.

### 1.2 The clearest single signal

**~78,600 comment lines live in the test/CI apparatus.** 40% of `ci.yml`, 33%
of all workflows, 30% of all e2e TypeScript. The machinery is explaining itself
in-line at industrial scale because its rules cannot be inferred from its code.

### 1.3 Growth

Since 2026-06-01, `.github/ scripts/ Taskfile.yml` took **+24,982 / −6,126** —
a 4:1 add:delete ratio. **645 of 936 non-merge commits (69%)** touched
`.github/`, `scripts/`, `Taskfile.yml` or `e2e/`.

Over the last 30 days: tests and e2e **+146,950 / −19,026**; product
(`.svelte` + non-test `lib/*.ts`) **+119,057 / −24,561**. Test code is written
1.24× faster and deleted 0.78× as often.

The thing being policed did not get 4× safer over that period: **21% of
completed CI runs still fail.**

### 1.4 What one PR costs — measured, run 31603573457 (green, 2026-08-12)

| | |
|---|---:|
| Jobs | 30 |
| **Runner-minutes** | **222.3** |
| Wall clock | 51.2 min |
| **Both required contexts green at** | **+21.9 min** |
| `VRT` (`continue-on-error`) finishes at | **+51.2 min** |
| `vrt-strict` (required) finishes at | +9.1 min |

| Job | min | gates a merge? |
|---|---:|---|
| **VRT (visual regression)** | **48.9** | **no** |
| e2e shards 1–10 | 110.9 | yes |
| unit | 9.7 | yes |
| **collab (@collab multi-context)** | **8.9** | **no** |
| webgl-smoke | 7.2 | yes |
| vrt-strict | 6.7 | yes |
| behavioral-smoke / art / build / build-web / typecheck | 18.5 | yes |
| **merge-reports + collab-attest + grand-attest** | **6.8** | **no** |

**64.6 of 222.3 runner-minutes (29%) gate nothing.** The largest job in CI —
`VRT`, 48.9 min, 22% of all runner time — is `continue-on-error: true` and is
the sole reason the run takes 51 minutes instead of 22.

Last 100 CI runs, a 36-hour window (≈66 runs/day): 46 cancelled, 41 success,
11 failure. Median wall **51.7 min**, p90 54.8, max 420.6.

`CLAUDE.md` states "a CI cycle here is ~25 min" in two places (lines 22 and
788). Measured: mergeable at 21.9, run completes at 51.7. Both wrong, in
opposite directions.

### 1.5 Machinery that is dead, or alive and producing nothing

| Thing | LoC | Evidence |
|---|---:|---|
| `chaos-24-7.yml` + `e2e/chaos/**` + Taskfile target | ~1,100 | workflow state **`disabled_manually`**; last run **2026-05-26** |
| `e2e-flake-purge.yml` (50-job matrix) | 230 | last run **2026-06-06**; last two red |
| `behavioral-flake-purge.yml` (30-job matrix) | 220 | last run **2026-07-01**; last three red |
| `flake-check-3x.yml` | 422 | last run **2026-06-06** |
| **`collab-nightly.yml`** | 252 | see below |
| Unreferenced scripts (4) | 447 | no inbound reference anywhere in the tree |
| `ci-collab-attest/` superseded JSONs | 29 files | webgl and grand prune to 1; collab has no prune step |

**`collab-nightly` is the flagship.** Its **40 most recent runs — every night
back to 2026-07-04 — concluded `cancelled`**, all four shards hitting the
30-minute `timeout-minutes` cap. Its alert job is `if: failure()`, and
**`failure()` does not match `cancelled`**, so the alert was `skipped` all 40
times. That is ≈78 runner-hours since 2026-07-04 producing zero signal and
zero alerts — and it is the nightly backstop whose existence justified
un-gating the `collab` lane.

The same bug class reddened `main` from the other direction hours earlier: the
`unit` job blew its 10-minute cap, and **a cancelled job reports neither pass
nor fail**, so the umbrella turned red and read as a test failure that never
happened.

### 1.6 The attest trio

**~5,580 LoC.** Three near-identical implementations of one idea: hash a file
list, look for `ci-*-attest/<hash>.json`, exit 0 or 1.

- **165 re-attest commits since 2026-06-01** — webgl 122, collab 32, grand 11.
  webgl fires ~1.7/day; **~13% of every commit in this repo owes a
  browser-quitting real-GPU run.**
- Only **webgl** gates. `collab-attest` and `grand-attest` sit in the umbrella's
  `needs:` and `env:` but are absent from its failing `if` — they cost latency
  and a runner slot and cannot block anything. `collab-attest` was un-gated on
  2026-06-28 and **still produced 32 attestations afterward**: pure tax.
- The webgl basis is `packages/web/src/lib/video/**` hashed **wholesale, ~200
  files**. Today's NUL-byte removal left every runtime string byte-identical and
  cost a full GPU window. Four separate false-invalidation classes have already
  had to be engineered away, most recently the 387-line comment normalizer that
  replaced 79 `docs-hash-ignore` marker pairs across 77 files.
- **~1,288 LoC of unit test guards the hashing scripts** — including
  `scripts/attest-code-basis.test.ts:572`, which asserts that the string
  `'MODULE-SCOPE'` appears as a **comment** inside the file whose entire job is
  to **ignore comments**.
- The three design docs the code cites
  (`.myrobots/plans/webgl-attestation-semaphore.md` and two siblings) **do not
  exist**, and 36 references point at them.

### 1.7 VRT

314 baselines, 13 MB LFS. `vrt-strict` — the only required visual context —
narrows to `vrt.spec.ts` and then to `STRICT_VRT_MODULES` (**49 modules**).
`EXEMPT_FROM_VRT` = 80. `ALLOWED_PERMANENT_EXEMPT` = 21. `VRT_MODULE_MASKS` =
31. The 64 `workflow-shell-faces` dock/compact faceplate baselines — the most
actively authored surface in the repo — are entirely in the informational lane.

**~85% of the committed baseline corpus cannot fail a merge.**

### 1.8 Exemptions and the un-gating ratchet

The generated ledger (`docs/testing/test-ledger.generated.md`) reports **374
coverage exemptions, 6 hard skips, 5 informational lanes**. **185 of the 374**
(`BEHAVIORAL_MODULE_EXEMPT` 77 + `BEHAVIORAL_SWEEP_EXEMPT` 108) belong to
`behavioral-coverage`, which is `continue-on-error: true` and does not run on an
unlabelled PR.

Five lanes run and cannot fail a merge: `behavioral-coverage`, `collab`,
`collab-attest`, `grand-attest`, `vrt`. Every one was demoted after flaking.
The campaign to re-promote them (task #69) has been open since **2026-06-06**,
and all three workflows built to earn that re-promotion are dead.

---

## 2. Redundancy

### 2.1 Five membership rules over one tree

This is the finding that answers the question directly.

Five unit gates each independently walk `e2e/vrt/`, build their **own** roster,
and assert "every member is accounted for with a stated reason":

| gate | LoC | its axis |
|---|---:|---|
| `packages/web/src/lib/ui/vrt-cable-stripe.test.ts` | 882 | baseline-dir |
| `packages/web/src/lib/ui/vrt-live-surfaces.test.ts` | 755 | mask |
| `packages/web/src/lib/audio/modules/vrt-meta.test.ts` | 570 | module |
| `packages/web/src/lib/ui/vrt-config-budget.test.ts` | 251 | config |
| `packages/web/src/lib/ui/vrt-font-pinning.test.ts` | 151 | spec |

**2,609 LoC, five rosters, one tree — so a scene can be accounted for in four
and structurally invisible in the fifth. That is the blind-spot class,
generated by the fix for the blind-spot class.**

The 2026-08-02 audit established that a gate applying a filter before its check
quietly redefines the check's subject. The remedy adopted was deny-by-default
with named exemptions. That remedy was then applied five separate times to the
same directory, each application defining membership its own way — which
recreates the original defect at the level *above* the one that was fixed.

### 2.2 One mechanism, reimplemented five times

`worklet-guard` (397), `mutate.guard` (326), `midi-input-ownership` (323),
`mono-normal-not-defeated` (724), `trigger-edge-placement` (1,124) — **2,894
LoC** — are all the same mechanism: a deny-by-default source grep with a
shrink-only ceiling. It was never factored, so **each copy grew its own filter
and therefore its own blind spot.** That is the 2026-08-02 audit failure still
live in five places.

The self-tests were written the same way each time, which is why none of them
could go red: the raw-write self-test only ever fed itself the bracket form.

### 2.3 The rest

- **Card-vs-def range agreement — 4 gates.**
  `card-range-source.test.ts` (529), `card-control-ranges.test.ts` (179),
  `card-def-agreement.test.ts` (290), `device-card-source.test.ts` (112).
  `card-control-ranges` is a strict subset of `card-range-source` — same
  `min|max|step` literal regex, run over a hand-typed 40-card list instead of
  the whole card directory. `device-card-source` is the same rule for exactly
  one card. **≈580 of 1,110 LoC redundant.**
- **Docs/contract drift — 4 gates.** `module-docs-lint` (403),
  `module-manifest.test.ts` (419), `contract-lock.test.ts` (142),
  `module-docs-ensure.test.ts` (82). All four assert "the doc artifact equals
  what the registry says today," each against a different artifact. The last two
  are the same assertion on two files.
- **Card ↔ registry mapping — 5 gates.** `modules-card-map` (210),
  `card-primitive-parity` (538), `push-card-schema` (586), `registry-manifest`
  (237), `param-cell-coverage` (270); `module-face-lint` (1,913) asserts a
  superset over `STRICT_FACES`.
- **Attest-basis sanity — 4 near-clones.** `collab-attest-basis` (148),
  `grand-attest-basis` (100), `webgl-attest-coverage` (463, plus real coverage),
  and a fourth copy in `scripts/attest-code-basis.test.ts`. The first two are
  the same three assertions with different constants.
- **A pure copy.** `packages/web/src/lib/audio/cv-scale-registry.test.ts` (372)
  and `packages/web/src/lib/video/cv-scale-registry.test.ts` (161) — identical
  three assertions over two registries. 533 LoC.
- **Duplicated CI preamble.** ≈820 of `ci.yml`'s 2,800 lines (29%) are
  byte-identical checkout / flox / cache / install blocks — 20 checkouts, 19
  flox installs, 37 caches, 8 identical postgres service blocks — and the same
  `dsp-build`/`build-web` pair is copy-pasted into four other workflows whose
  own comments say "byte-copied from the proven template."
- **Workarounds whose cause could be removed instead.**
  `docs-only-gate.yml` (198) + `scripts/docs-only-gate.mjs` (250) +
  `scripts/docs-only-gate.test.ts` (503) = **951 LoC that exist solely because
  `ci.yml` carries `paths-ignore`**, plus a permanent rule that two files must
  be edited together and a path list mirrored in three places. `revalidate`
  (close + reopen a PR) exists because a `GITHUB_TOKEN` push does not fire CI
  and a `workflow_dispatch` run does not satisfy a required check. The obvious
  remedy for the resulting `action_required` parking, `gh run approve`, **does
  not exist and exits 0**.

Recoverable across all clusters, with no property left unasserted:
**~3,500–4,500 LoC.**

---

## 3. Proposals, ordered by burden removed ÷ risk

Every LoC delta is an estimate unless it names a measured file. Every coverage
cost is named, because silent coverage loss is the standing prohibition.

### P1 — Take `vrt` off the per-PR path — DO THIS FIRST, AS ITS OWN PR

`ci.yml:2407`. Add an `if:` restricting the `vrt` job to push-to-main,
`workflow_dispatch`, and a `vrt` label — the exact pattern
`behavioral-coverage` already uses at `ci.yml:1222`.

- **LoC: ~−10.**
- **Effect, measured:** PR wall clock **51.2 → ~22 min (−57%)**; runner cost
  **222.3 → 173.4 min (−22%)**.
- **Coverage cost: zero today.** The job is `continue-on-error: true` and is
  not in the `ci` umbrella's `needs:` — it cannot fail a merge now. What is lost
  is per-PR *visibility*. `vrt-changeset-gallery.yml` already covers the only
  case that matters — a PR that actually changes baselines — and the nightly
  push run catches drift within a day.
- **Risk: negligible.** No required context moves; `vrt-strict` is untouched.

This is the highest-value single edit in the repository. It is ten lines for
more than half the CI cycle.

### P2 — Delete the dead flake apparatus

`.github/workflows/chaos-24-7.yml`, `e2e/chaos/**` (995 LoC, verified
self-contained — the only inbound reference is the workflow; the other "chaos"
hits in the tree are an unrelated video-module mode) and its `chaos:run`
Taskfile target; `.github/workflows/e2e-flake-purge.yml`;
`.github/workflows/behavioral-flake-purge.yml`;
`.github/workflows/flake-check-3x.yml`.

- **LoC: ~−1,970.**
- **Coverage cost: zero.** Nothing has run in 6–11 weeks, one workflow is
  `disabled_manually`, two were red when last run. **Named loss:** the ability
  to fan out a 50-job 5× stability sweep on demand. Replacement already
  mandated by `CLAUDE.md`: `REPEAT=3 flox activate -- task e2e:one`.
- **Risk: negligible.**

### P3 — Fix or kill `collab-nightly`, and audit every alert condition

Either raise the 30-minute cap and change the alert to `if: !success()`, or
delete the workflow.

- **LoC: −252 if deleted; ~−4 if fixed.**
- **Coverage cost of deleting:** nominally the nightly under-load collab
  regression net. **Actually zero, measured** — it has completed zero of its
  last 40 runs.
- **The generalisable finding is worth more than the workflow:** `failure()`
  does not match `cancelled`, and a cancelled job reports neither pass nor
  fail. Every alert and watchdog condition in the repo needs that audit.
- **Risk: low.**

### P4 — Collapse three attests to one

Keep `webgl-attest` — it gates, and it covers a real hole (CI has no GPU).
Delete `collab-attest` and `grand-attest`: scripts, libs, verify and hash
wrappers, their `ci.yml` jobs, `ci-collab-attest/`, `ci-grand-attest/`, their
two basis tests, and their two skills. Generalise what remains over
`scripts/attest-code-basis.ts` plus one `computeHash(basisList)`.

- **LoC: ~−2,600.**
- **Coverage cost, named:** (a) sync-layer changes no longer force a local
  relay run — but that already does not gate, and produced 32 attestations
  *after* un-gating, i.e. it was pure tax; (b) grand's clip-math pin — replace
  with a `sourceSha256` pin over the same 20 files in the ART fingerprint
  manifest, which is the mechanism ART already uses for exactly this.
- **Risk: low.** Neither is a required context.

### P5 — Narrow the webgl basis from a directory to a dependency set

Replace the wholesale `packages/web/src/lib/video/**` sweep (~200 files) with
the import closure of the shader/renderer entry points. The resolver already
detects `getContext('webgl')` for its fail-closed coverage test — invert that
and make it the basis. Stop hashing `.flox/env/manifest.toml` wholesale.

- **LoC: ~neutral (+40 resolver).**
- **Effect:** re-attest rate ~1.7/day → an estimated ~0.3/day. That is worth
  more than any LoC figure in this document.
- **Coverage cost, named:** a video file reaching the GPU only via a dynamic
  import could fall out of the basis. Mitigated by the existing fail-closed
  `packages/web/src/lib/video/webgl-attest-coverage.test.ts`, which is already
  the negative control for precisely this and stays.
- **Risk: moderate** — it changes what a re-attest means, so it is one
  deliberate re-attest to land.

### P6 — Shard the `unit` lane

`task test` runs four workspaces serially. The job measured 9m32s–9m50s across
eight runs on 2026-08-12 and blew a 10-minute cap on #1476.
`vitest --shard=i/3` → ~3.5 min, and the cap becomes meaningful again.

- **LoC: ~+15.**
- **Coverage cost: zero.**
- **Risk: low** — three postgres service containers instead of one.

### P7 — One composite setup action

`.github/actions/setup/action.yml` (~60 lines) replacing the duplicated
preamble in `ci.yml` and four other workflows.

- **LoC: ~−1,000.**
- **Coverage cost: zero.**
- **Risk: moderate in blast radius only** — a composite action change touches
  every job at once. Land it job-by-job.

### P8 — Remove `docs-only-gate.yml` by removing its cause

Either drop `paths-ignore` from `ci.yml` entirely, or point ruleset 16042163 at
a tiny always-runs `gate.yml` that `needs:` the real jobs.

- **LoC: ~−950**, and the standing "two files move together forever" rule goes
  with it.
- **Coverage cost: zero.** The trade is that a typo-only PR burns a CI run —
  which is the cost this machinery exists to avoid, so the decision is a
  frequency judgement, not a safety one.
- **Risk: low, but needs a coordinated ruleset PUT.** Owner action.

### P9 — Keep the behavioral spec, delete its apparatus

Around `e2e/tests/per-module-per-port-behavioral.spec.ts` (3,474) sit
`merge-behavioral-reports`, `behavioral-watchdog` (318 `ci.yml` lines +
`scripts/behavioral-watchdog.mjs` 335 + its test 199, with `AUTO_ROLLBACK`
**off by default**), the dead purge workflow, and 185 exemption entries — all
serving a lane that cannot fail a merge. Delete the watchdog, the merge job and
the purge. Run the sweep nightly. Keep `behavioral-smoke` (4.0 min, already
required) as the per-PR gate.

- **LoC: ~−1,100**, and 185 exemptions become nightly-only.
- **Coverage cost, named honestly:** the CONTROL→PATCHED delta sweep is the
  only thing that proves an input port *does something*. Moving it to nightly
  means such a regression is caught the next morning rather than pre-merge.
  That is a real loss, small but not zero, and it belongs in the PR body.
- **Risk: low.**

### P10 — Make `E2E_PORT` structural

Isolation is implemented in five `Taskfile.yml` shell wrappers;
`e2e/playwright.config.ts` and `e2e/vrt/vrt.config.ts` read only
`E2E_BASE_URL`, so a bare `npx playwright test` silently targets 5173. Derive
`baseURL` from `E2E_PORT` inside both configs and delete the port plumbing from
every caller.

- **LoC: ~−40.**
- **Coverage cost: zero.**
- **Risk: low.** This converts "an isolation mechanism only half the entry
  points honour is not isolation" from prose into the one place it cannot be
  bypassed.

### P11 — Pay the ratchet tail (**re-scoped against PR #1486**)

See §4 for the full intersection. **The true remainder is 37, not the ~60 I
first counted**, and its character is much milder than what #1486 removed.

- **LoC: ~−200**, dominated by three hand-typed population *lists*.
- **Coverage cost:** for each vacuity floor dropped, the "the scanner returned
  nothing" protection must be replaced with a derived assertion (`> 0`, or a
  property of the population) rather than deleted outright.
- **Risk: low.**

### P12 — One VRT roster, five predicates

Derive membership from the directory **once**; hang the module, mask, palette,
font and config predicates off that single roster.

- **LoC: ~−1,200** of the 2,609.
- **Why it cannot develop the same blind spot:** membership acquires exactly
  one definition. A scene either is in the tree or is not, and every axis sees
  the identical set. The five-rosters failure is *definitionally* unavailable,
  not merely unlikely.
- **Coverage cost: zero** — every existing predicate is retained, only the
  enumeration is shared.
- **Risk: low-moderate** — five gates change at once; land it one predicate at
  a time against the shared roster.

### P13 — One deny-by-default grep helper, with no ceiling parameter

Factor the five copies in §2.2.

- **LoC: ~−800.**
- **Why it is not just another mechanism:** factoring alone does **not** remove
  the blind-spot class, because each caller still supplies its own predicate.
  What removes it is that **the shared API accepts no ceiling argument** — a
  ratchet becomes unexpressible, so a remaining shrink-only ceiling has to be
  paid or dropped rather than copied into the sixth caller. That makes P11
  self-enforcing.
- **Coverage cost:** dropping a ceiling means the debt it capped is either
  fixed or unwatched. Each instance must be named in the PR body.
- **Risk: moderate** — five guards change at once.

### Running total

**≈−12,000 LoC of machinery, −29% runner cost, −57% PR wall clock, and the
re-attest rate down roughly 5×.**

### Three things to leave alone

- **The generated accept-loop artifacts** — `contract-lock.txt` (3,859 lines),
  `test-ledger.generated.md` (466), `fingerprints.generated.json` (124 KB) —
  are the *correct* shape and should not be touched. One `task accept` chaining
  all four accept targets would remove one more rule from the human's head.
- **`e2e/tests/faces-parity.spec.ts`** (1,328) is the highest-value-per-line
  gate in the repo — registry-driven, deny-by-default, per-cell operability
  with a real probe. Its "fails on a different module each full-file run"
  behaviour is a P0 bug in a **required** lane, not a design flaw, and it should
  be root-caused before any of the above.
- **The module sweeps themselves** earn their keep.

---

## 4. The ratchet tail, intersected with PR #1486

PR #1486 (`chore/eliminate-all-ratchets`, +1,442 / −546 across 31 files, open
and unmerged as of this writing) is thorough on the files it touches. Diffed
instance by instance against `origin/chore/eliminate-all-ratchets`:

### What #1486 killed

Essentially **every shrink-only debt ceiling and every frozen set-size floor** —
the dangerous ones, the ones carrying slack a regression can hide in:
`RAW_WRITE_DEBT_CEILING` (51), `WHOLE_BAG_CEILING` (16), `UNCHECKABLE_CEILING`
(87), the worklet ceiling (7), the five per-class `dual-mono` counts, the
`dual-mono` `POPULATION_SIZE` (27), `|STRICT_FACES| >= 18`,
`|STRICT_DOCS| >= 172`, `|STRICT_VRT_MODULES| >= 48`, the
`mono-normal-not-defeated` and `trigger-edge-placement` ceilings.

**The `STRICT_FACES` instance is the model fix, and I want to be exact about
it because it was my sharpest example and it is now stale.** On `main`,
`module-face-lint.test.ts:1911` floored `|STRICT_FACES|` at **18 against an
actual 32** — fourteen modules of slack in the largest gate in the repo (1,913
LoC). On the branch that floor is gone, replaced by a **set identity asserted
in both directions**: `STRICT_FACES` IS the set of defs declaring a `face`.
Authoring a `face` is the promotion; there is no number to lower. The branch's
own comment corroborates the class on the sibling: `STRICT_DOCS` "was 185
against a floor of 172, so THIRTEEN" modules of slack. The example stands as
evidence of the class — it now also stands as the template for the remedy.

### What survives — the true remainder, 37

**33 numeric literals calibrated to the current population**, almost all now
vacuity floors ("the scanner found at least N things") rather than debt
ceilings:

| file:line | literal | counts |
|---|---:|---|
| `packages/web/src/lib/graph/stereo-pairs.test.ts:144,145` | 150, 100 | registered defs / defs with outputs |
| `packages/web/src/lib/ui/modules/card-range-source.test.ts:497,501` | 100, 100 | card sources scanned |
| `packages/web/src/lib/ui/modules/midi-learn-wiring-audit.test.ts:197,198,251` | 50, 400, 3 | cards with knobs / control instances / XyPads |
| `packages/web/src/lib/audio/cv-scale-registry.test.ts:340` | 250 | curve-backed cvScale ports |
| `packages/web/src/lib/docs/module-manifest.test.ts:53,269,272,376` | 19, 12, 55, 60 | moduleCount / mixmstrs audio-ins / mixmstrs params / spawnable specs |
| `packages/web/src/lib/dev/registry-manifest.test.ts:117` | 60 | module specs |
| `packages/web/src/lib/dev/behavioral-smoke-subset.test.ts:118` | 50 | registry rows |
| `packages/web/src/lib/multiplayer/collab-attest-basis.test.ts:37,64` | 30, 10 | basis files / collab specs ("~28 today") |
| `packages/web/src/lib/audio/modules/grand-attest-basis.test.ts:42` | 15 | basis files |
| `packages/web/src/lib/ui/vrt-font-pinning.test.ts:88,92,96` | 20, 15, 15 | vrt specs / that navigate / that pin |
| `packages/web/src/lib/ui/vrt-cable-stripe.test.ts:724` | 20 | retired-hue × current-token pairs |
| `packages/web/src/lib/ui/vrt-config-budget.test.ts:184,199` | 2, 3 | e2e configs / Playwright screenshot keys |
| `packages/web/src/lib/ui/modules-card-components.ssr-stub.test.ts:43,64` | 500, 150 | globbed sources / card components |
| `packages/web/src/lib/audio/dual-mono.test.ts:269` | 3 | engine-seam bypass paths |
| `scripts/attest-code-basis.test.ts:392,488` | 10, 250 | basis files / typescript basis files |
| `scripts/alert-issues.test.ts:187` | 9 | shellcheck ids in `probe.sh` |
| `scripts/no-scratch-tracked.test.ts:50` | 1000 | tracked files |
| `scripts/new-module.test.ts:336` | 3 | files deleted by the scaffolder |
| `scripts/test-reconciliation.test.ts:110` | 2 | disabled tests |
| `scripts/vrt-gallery.test.ts:603` | 1 | spec dirs |
| `scripts/ci-playwright-timeout.test.ts:142` | 4 | Playwright-invoking jobs |

**1 surviving zero-slack ceiling in the banned both-directions form**, inside a
file #1486 touched but did not finish:
`packages/web/src/lib/midi/midi-input-ownership.test.ts:258` —
`const EVERY_PORT_SUBSCRIBERS = 2` — asserted at `:313`
(`toBeLessThanOrEqual`) and `:314`
(`expect(EVERY_PORT_SUBSCRIBERS - n, 'lower … in the same commit').toBe(0)`).

**3 hand-typed population LISTS** — the same defect spelled out instead of
counted, and the genuinely bad survivors:

- **`packages/web/src/lib/ui/modules-card-map.test.ts:36–63` —
  `EXPECTED_NODE_TYPES`, a sorted list of 170 hand-typed module names, sitting
  two lines above `buildNodeTypes(allDefs())`, the glob that derives exactly the
  same set.** Its own comment reads: *"When you add a NEW module, add its type
  id here too — that's the one intentional touch."* **A hand-typed list sitting
  next to its own generator is the thesis in miniature.** Untouched by #1486.
- `packages/web/src/lib/ui/workflow/dom-source-modules.test.ts:88–97` — 9
  in-set and 5 out-of-set module names.
- `scripts/attest-code-basis.test.ts:472` — `EXPECTED_RAW_BASIS_FILES`, four
  paths asserted with an exact `toEqual`.

### The honest reading

**My ~60 collapses to 37, and the class changes.** #1486 removed the ratchets
that could hide a regression; what remains is mostly vacuity floors, whose
failure mode is benign — they go stale downward and never block, and they only
fire if a scanner genuinely breaks. By the letter of the directive they are
still hand-typed populations, and several are badly calibrated (`> 10` where
the comment says "~28 today"). But the dangerous population is gone.

That is a stronger result for #1486 than for my original count, and it should
be recorded that way. The remaining P11 work is small, and the three hand-typed
lists are worth more than the thirty-three numbers.

---

## 5. What should never have been built

**The generating pattern: every time a check produced a false or unreadable
signal, the repo added a second mechanism to interpret the first — and never
removed the first.**

The chain, each link measured:

1. A lane flakes → **demoted to `continue-on-error`** rather than fixed or
   deleted. Five lanes.
2. A demoted lane emits no signal → a **watchdog** is added to scream about it.
   `behavioral-watchdog`, 318 `ci.yml` lines + 534 script LoC, disarmed by
   default.
3. The watchdog needs the lane stable → **flake-purge workflows** are added to
   earn re-promotion. Three of them, 872 LoC, all dead.
4. Re-promotion never happens → a **nightly backstop** is added.
   `collab-nightly` — cancelled 40 nights running, alert silently skipped every
   time. Layer 4 is decoration over layer 3, which is decoration over layer 2.
5. The gates' own inputs need policing → **tests of the gates**: 5,603 LoC in
   `scripts/*.test.ts`, 1,288 LoC guarding the attest hashers — culminating in a
   test asserting that a **comment** exists in the file whose only job is to
   **ignore comments**.
6. The workarounds need workarounds: `docs-only-gate.yml` exists because
   `paths-ignore` exists; `revalidate` exists because a `GITHUB_TOKEN` push does
   not fire CI; `gh run approve` was reached for and **does not exist and exits
   0**, so a fourth mechanism was needed for that too.

**The tell that separates this from ordinary engineering: layer N+1 is always
additive.** That is why machinery took +24,982 / −6,126 in ten weeks while the
failure rate stayed at 21%.

**The rule that would have prevented it: a mechanism whose output cannot fail a
merge gets deleted, not watched. And when a check gives a wrong answer you get
one fix; the second time, you delete the check.**

### Three corollaries

**The count habit was a symptom, not the disease.** Removing the ratchets was
right, and #1486 finishes the dangerous half. But the same instinct survives in
a different costume: 374 exemption entries, 31 mask lists, the pinned-key sets,
and `EXPECTED_NODE_TYPES`'s 170 names. A named, anchored exemption *is* better
than a number. But the question to ask of an exemption list is not "is it
anchored?" — it is **"what happens if I delete the list and the check
together?"** For the 185 behavioral exemptions, today, the answer is *nothing*.

**A remedy applied N times becomes the defect it cured.** §2.1 and §2.2 are the
same story: deny-by-default was the correct answer to the 2026-08-02 audit, and
applying it five times without factoring it produced five filters, five
rosters, five blind spots — at the level above the one that was fixed. **The
next remedy should be applied once, in one place, or not at all.**

**The prose is load-bearing and it is drifting.** ~4,000 lines of `CLAUDE.md`
plus skills that a contributor must hold, containing at least three measurably
stale facts: "a CI cycle here is ~25 min" (measured 51.7, mergeable at 21.9);
"8 shards in CI" in `e2e/tests/per-module-per-port.spec.ts:45` and again in
`ci.yml` (it is 10); and `docs-hash-ignore` described as deleted while
`scripts/attest-code-basis.test.ts` still greps the tree for it.

Of `CLAUDE.md`'s 23 sections:

- **Should be structural, not remembered:** the 3× flake check (a hook, or
  nothing); "never express a renderer-dependent wait in ms" (a lint banning
  `waitForTimeout` under `e2e/**` — trivially greppable, currently 33 lines of
  prose); the worktree cap (a task already — make it a hook); "the two path
  lists move together" (already a unit test; the section is redundant with it);
  "poly modules e2e the real source chain" (a registry-driven assertion);
  "commands run through flox" (a shell wrapper).
- **Scar tissue that can no longer recur:** the VRT platform-split history (the
  `{platform}` dimension is deleted — 60 lines of archaeology, which belong
  here in `.myrobots` rather than in the always-loaded file); the `E2E_PORT`
  half-honoured-knob incident (P10 retires it); the footer-height incident (has
  a browser test now); the `docs-hash-ignore` history (mechanism deleted).
- **Irreducible and worth every line:** "VALIDATE THE INSTRUMENT" and "a gate
  that reads one side of a two-sided contract proves nothing about the other."
  Those are judgement, not rules, and nothing enforces them.

**`CLAUDE.md` should go from 853 lines to roughly 250** — incidents to
`.myrobots`, every "remember to X" converted into the check that enforces X,
keeping the two judgement sections and the local dev-loop commands.

---

## 6. Constraint check on these proposals

**No hand-typed population counts are introduced.** P5 replaces a hand-listed
directory basis with a *derived* import closure. P9 keeps the generated ledger,
already the correct shape. P11/P13 remove survivors rather than adding any.

**On replacing N mechanisms with one.** Only three proposals create anything
new, and each has to earn it:

- **P7 (composite setup action)** is not a check. It has no subject and no
  filter, so there is nothing it could be structurally unable to see. Its
  failure mode is that every job fails to set up — maximally loud.
- **P12 (one VRT roster)** removes the blind-spot class by construction:
  membership acquires exactly one definition, so "accounted for in four,
  invisible in the fifth" is definitionally unavailable.
- **P13 (one grep helper)** does *not* remove the class by factoring alone —
  each caller still supplies its own predicate, and that is where the five
  blind spots came from. It earns its place only because **its API has no
  ceiling parameter**, making a ratchet unexpressible.

Everything else in the plan is a **deletion or a re-schedule**, deliberately.
The documented failure mode of this repository is replacing mechanisms with
mechanisms, and this plan declines to do it more than three times.
