# CI adversarial audit — "too many reds today"

**Window:** 2026-08-30T19:30Z → 2026-09-01T19:00Z (~47.5 h), workflow `ci.yml` only.
**Method:** four area audits, each independently refuted by a second reviewer; this
synthesis re-measured the cross-cutting numbers directly from the Actions API and
from `origin/main` (`7957400c0`). Where an area reviewer and their refuter disagreed,
the refuter wins unless I could re-measure it myself. Read-only throughout: no edits,
no re-runs, no dispatches, no parks, no issues.

**DOOM is excluded by name and untouched.** `doom-{identity-crossview,late-join,launch,
mp-latejoin-freeze,mp-lockstep-sharedstate,mp-real,multiplayer}.spec.ts` are
`@collab`-wrapped and resolve in the `collab` lane; none appears in any red job in the
window. The `gibribbon` flake that reddened `main` is **not** DOOM — `gibribbon.ts`
imports only `loadWad` (a byte fetch) and the pure `wad-sprites` decoders, calls no
`runTic`, and carries an explicit read-only carve-out comment at `gibribbon.ts:52-55`.
Nothing below touches DOOM code, specs, waits, budgets, ledger entries or sweep
behaviour, and nothing below is recommended for DOOM.

---

## 1. Verdict

CI is red this often because **five of every six red runs are reddened by something
outside the change under test**, and because the three surfaces that do it — a
merge-order race on generated artifacts, an armed flake gate over a spec fleet where
54 % of specs run on an invisible 30 s budget, and a set of per-test bounds that were
migrated at some call sites and not others — are all *structurally invisible* to the
gates that go red. The gates are not broken. They are honest detectors pointed at the
wrong end of a causal chain: every one of them fires on the *result* of a shared-state
collision, on whichever PR happens to be next in the queue, and none of them can fire
on the collision itself.

Concretely, three mechanisms account for 30 of 38 red runs:

1. **Two PRs regenerate the same artifact against the same base and merge cleanly.**
   Git merges them without conflict and produces a third value the generator would
   never emit. On 2026-09-01 this happened twice inside the same 65-second batch, on
   two different artifacts, and left `main` red for 3 h 45 m. Every open PR that then
   merged or rebased inherited the red. **12 runs.**
2. **`--fail-on-flaky` is armed, and the fleet's per-test budget is an invisible
   default.** 265 of 490 specs set no budget from any source, so they run on
   Playwright's undocumented 30 000 ms. Seventeen of those specs *also* declare a
   `timeout:` bound taken from `boot-budget` that is ≥ their own budget — an
   unreachable bound, which converts a legible `element not found` into an illegible
   `Test timeout of 30000ms exceeded`. Seven of the window's seventeen recovered
   flakes carry exactly that signature. **13 runs, 3 of the 4 red mains.**
3. **A registry- or budget-derived guard changes population when a face PR lands**,
   and reddens the next PR through a file it did not edit. **5 runs.**

The lever the owner actually has is small: the repair pattern for mechanism 2 is
already merged and proven (`05ca9298c` / #2291), it is one line per spec, it costs
zero seconds on a green run, and it is unblocked. Mechanism 1 is a merge-*policy*
question, not an engineering one — nothing can gate a two-PR merge before it happens.

One correction to the brief I was handed: **cost-artifact churn (lead #2) did not fire
today.** `e2e-timings.generated.json` was re-pinned exactly once in the window
(`a7065bb86`, 2026-09-01T11:38:02Z), and the only repeated flake subject that spans
that re-pin — `workflow-media.spec.ts:206` "sticky menu" — landed on **shard 9 both
times**, before and after. Three other subjects repeated twice each in the window and
each stayed on its own shard (seqtris-inputs → 4/4, tidyVco glyph → 6/6, videoOut
spawn → 6/6). The mechanism is real (31 accepts in 45 days, 86–92 % of specs
re-assigned per accept, measured independently by two reviewers) but it is **latent,
not active**, and attributing today's reds to it points repair at the wrong file.

---

## 2. The numbers

### Population

| | count |
|---|---|
| `ci.yml` runs in window | **111** |
| succeeded | 44 |
| **failed** | **38** |
| cancelled (evidence destroyed — see §4.6) | 29 |
| pass rate among completed runs | **53.7 %** |
| failing **leaf** jobs across the 38 (excl. the `ci` umbrella and the `vrt-strict` aggregator) | **44** |
| red `main` pushes | **4** |

### The split the owner asked for — by run (primary cause)

| bucket | runs | share |
|---|---|---|
| **(a) a real defect in the PR under test** | **6** | 15.8 % |
| **(b) reddened by a shared surface it does not touch** | **15** | 39.5 % |
| **(c) recovered flake (0 failed, ≥1 flaky)** | **13** | 34.2 % |
| **(d) infra** | **2** | 5.3 % |
| **(e) expected attest refusal (gate working)** | **2** | 5.3 % |

> **32 of 38 red runs (84 %) were not a defect in the change under test.**
> The owner's complaint is measured and correct.

### Same split — by failing leaf job (44)

(a) 7 · (b) 16 · (c) 17 · (d) 2 · (e) 2

### The four red `main` pushes

| run | cause | detail |
|---|---|---|
| `33453270535` | **(b)** | `webgl-attest` hash `20cc0b74…` never attested by any PR **and** `unit` → `face-migration.generated.md` STALE. Two independent generated-artifact collisions from one 65-s batch. Red 00:04:24Z → 03:49:45Z (**3 h 45 m**). |
| `33498984183` | **(c)** | e2e shard 9 — `FLAKE (2 attempts)` "gibribbon: an uncleared event HITS the marine". Attempt-1 error is a real assertion (`expect(['wounded','critical','dead']).toContain`), not a timeout. |
| `33515494374` | **(c)** | e2e shard 3 — `FLAKE` "OWNER CASE: gamepad CV movement … records into the clip". Attempt-1 is an assertion on take marks. |
| `33408552411` | **(c)** | e2e shard 5 — `FLAKE` "livecode: JS recreates the voice-demo patch". Attempt-1: `page.waitForLoadState: Test timeout of 30000ms exceeded`. **`livecode.spec.ts` sets no budget on `origin/main` today.** |

### Bucket (a) in full — the six runs where the PR really was at fault

| run | branch | leaf failure |
|---|---|---|
| `33537413256` | `fix/trails-note-mode-axes` | e2e 11/12 — `trails.trig1 (type=gate): scope.ch1 peak above floor (maxPeak=0.0000)` |
| `33518505901` | `fix/trails-note-mode-axes` | same, **plus** `typecheck` exit 2 |
| `33472900654` | `feat/seqtris` | `unit` — `README module counts match the live registries` (121 audio / 68 video / 8 meta) |
| `33417470524` | `feat/seqtris` | `art` ×3 scenario files — `Error: $state is not defined` |
| `33408905820` | `fix/workflow-pinned-trio` | `typecheck` exit 1 |
| `33435725342` | `feat/blood-face` | e2e 5/12 — `BLOOD audio_l → SCOPE` hard `Test timeout of 90000ms exceeded` (⚠ classification judgment — see §7) |

---

## 3. Ranked causes by blast radius

### C1 · Generated-artifact collision on batch merges — 12 runs, 13 leaf failures, **threatens main** ✅ realized

**Mechanism.** `resolveWebglBasis()` (`scripts/webgl-attest-lib.ts:261-263`) hashes the
whole of `packages/web/src/lib/video/**`. Two PRs that each touch that tree and each
carry their own re-attest against the same base merge without conflict, and the
resulting tree hashes to a value **neither PR attested**. The same shape applies to
`docs/design/face-migration.generated.md` (checked by `face-migration-inventory.test.ts`
in `unit`) and to the README module counts (`docs-facts.test.ts`).

**Evidence.** `6de10728d` (00:03:16Z), `28d9ddbe0` (00:03:28Z), `c3ad67529` (00:04:21Z)
— 65 seconds. Main then hashed to `20cc0b74…`; run `33453270535` logs
`##[error]No real-GPU WebGL attestation for the current WebGL content (hash 20cc0b74…)`
**and** `AssertionError: docs/design/face-migration.generated.md is STALE`. Ten PR runs
inherited it before `facf6a177` (#2287, a genuine re-attest at 03:31:16Z) landed:
`33454323639, 33454421905, 33454495143, 33455143346, 33456508068, 33460363831,
33461900648, 33462033103, 33463360785, 33463658069` — branches `feat/trails-module`,
`feat/seqtris`, `feat/skifree-face`, `feat/modtris-face`, `fix/main-inventory-regen`,
`feat/ptzcam-face`, `feat/audioin-face` ×2, `feat/textmarquee-face` ×2. One of the ten
(`33461900648`, audioIn) shows hash `671522fb…` rather than `20cc0b74…` — same class,
its own tree.

A twelfth run, `33503508277` (`feat/ptzcam-face`, created 11:38:28Z), went red on the
face-migration inventory **26 seconds after `a7065bb86` merged** the same artifact into
main. Same mechanism, no batch required — merge order alone is enough.

**Why no gate can see it.** Both attests were correct *in isolation*. The gate reads
one tree; the collision exists only between two trees. `concurrency: cancel-in-progress:
true` on `main` (`ci.yml:137-138`) then cancelled `6de10728d` at 34 s and `28d9ddbe0` at
76 s, so two of the three commits have no CI result at all and "which commit broke it"
is not answerable from run history. (This happened a third time in the window:
`ff4cad1ab`, cancelled at 17 s.)

**Cost:** 12 of 38 red runs (32 %), one red main for 3 h 45 m, ~20 min of human time to
fix each time.

### C2 · Recovered flakes under an armed `--fail-on-flaky` — 13 runs, 17 leaf, **threatens main** ✅ 3 realized

`ci.yml:1421` passes `--fail-on-flaky`; a shard that reports `1 flaky / 0 failed` is a
hard red. That is #1847 working as designed. The population it is now surfacing:

| attempt-1 error class | leaf failures |
|---|---|
| bare `Test timeout of 30000ms exceeded` (the invisible default) | **7** |
| explicit `page.waitForFunction: Timeout 15000ms exceeded` | 3 |
| `mount FRAME budget exhausted after 300 frames` (correct instrument shape) | 2 |
| ordinary assertion failure | 4 |
| `Test timeout of 120000ms exceeded` (BLOOD, its own raised budget) | 1 |

The seven 30 s-class flakes: `workflow-media` "sticky menu" ×2, `workflow-shell-live-glyphs`
"tidyVco dock hero glyph" ×2, `dx7-algorithm-picker` ×1, `workflow-shell-dual-glyph`
"(a) dock hero shows BOTH displays" ×1, `livecode` ×1 (**red main**).

**Four of the seven are already repaired on `origin/main`** — `05ca9298c` (#2291,
merged 10:44Z) gave `dx7-algorithm-picker` and `workflow-shell-live-glyphs` a
`describe.configure({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS })`, and `7957400c0` (#2293)
did the same for `workflow-media`. **Three remain live**: `livecode.spec.ts` and
`workflow-shell-dual-glyph.spec.ts` still set no budget from any source, verified on
`origin/main` today.

That is the repair pattern, already merged, already proven, one line per spec.

### C3 · Unreachable and over-summed per-test bounds — 3 runs, **does not currently threaten main**

`BOOT_MS` is `30_000` on CI (`e2e/_helpers/boot-budget.ts:83`) — *identical* to the
invisible default. `PLACEHOLDER_PAINT_MS` is `45_000`. I measured on `origin/main`:

- **490** specs; **265** set no `test.setTimeout` / `describe.configure({timeout})` /
  `test.slow()` from any source (54 %).
- **47** specs use a `boot-budget` constant as a `timeout:` value.
- **17** do both — they declare a bound ≥ the budget that contains it:
  `adsr-face`, `frogger`, `landing-links`, `landing-routing`, `menu-viewport-clamp`,
  `new-rack-return-to-last`, `p1-batch2-faces`, `rack-audio-gate`, `seed-none-fixture`,
  `skifree-face`, `workflow-dock-occupancy`, `workflow-dock-ux`, `workflow-dock`,
  **`workflow-shell-dual-glyph`**, `workflow-shell-faces`, `workflow-shell`,
  `workflow-viewport-nav`.

`workflow-shell.spec.ts` — the spec `boot-budget.ts` itself names as the most-flaked in
the suite — declares `PLACEHOLDER_PAINT_MS` (45 000) inside a 30 000 ms budget: 1.5×.
`frogger.spec.ts` is worse and was missed by every area reviewer's per-test-block scan
because the bounds live in a module-scope helper (`openFroggerFace`, `:218`, two
`SLOW_BOOT_TEST_TIMEOUT_MS` bounds = 90 000 each, 3.0× per bound in a 30 000 budget).

The **summed** variant hard-failed both attempts in the window:
`launchpad-perf-controls.spec.ts:407` declares 15 000 + 8 000 + 4 000 + 15 000 =
**42 000 ms** of tolerance in a 30 000 ms test. Run `33503519404` (branch
`fix/trails-note-mode-axes`, which touches no launchpad code):
`Test timeout of 32594ms exceeded` then `33150ms`. The odd numbers are `_setup-credit`
crediting the fixture nav. That is a pure bucket-(b) red.

### C4 · Registry- and budget-derived guards coupled to face promotion — ~5 runs

A face PR changes the migrated-module population, and a guard keyed on that population
changes its skip or its count in a file the PR did not edit.

- `33432670685` (`feat/modtris-face`): e2e shard 6 red with **0 flaky, 0 failed** —
  `1 skip-budget violation(s) in lane 'e2e'`, naming
  `workflow-shell.spec.ts — un-migrated module → placeholder in lane + legacy card
  operable in the dock`. A whole red-run class the flake-vs-hard-failure taxonomy has
  no bucket for.
- `33472900654` (`feat/seqtris`): `unit` → `README module counts match the live
  registries` (a new module, README not regenerated).
- `33503508277` / `33453270535`: the face-migration inventory (also C1).

### C5 · Infra — 2 runs, silent

- `33463360785`: `vrt-strict shard 3/12` printed `32 passed (4.1m)` and then
  `##[error]Failed to CreateArtifact: … Request timeout`. The failing step is
  `ci.yml:2743`, the **only** `if: always()` upload in the job (the other three are
  `if: failure()`). A telemetry harvest reddened a required check with every test
  passing.
- `33459245291` (`feat/ptzcam-face`): `conclusion: failure`, **zero jobs**, created
  01:34Z, `updated_at` 17:21Z. A red required check with no job, no log and no
  recoverable evidence of any kind.

### C6 · Expected attest refusal — 2 runs, **gate working correctly**

`33392669150` and `33395321561` (`feat/backdraft-panic`), hash `4be797ab…`: a video
module changed without a re-attest, told loudly. Do not "fix" these.

---

## 4. What our gates are STRUCTURALLY UNABLE to see

This is the section that matters. Each item is a defect class that can exist
indefinitely behind an all-green board.

**4.1 · 42 of 490 e2e specs execute in no CI job on a PR.**
`WEBGL_HEAVY_GLOBS` minus `WEBGL_HEAVY_EXCLUDE` resolves (via the repo's own
`resolveHeavyWebglSpecs()`) to 66 heavy specs excluded from the sharded matrix.
`webgl-smoke` runs 14 in full and reaches 10 more via `--grep @webgl-smoke`. The
remaining **42 run nowhere** — including `wavesculpt`, `videocube`, `colourofmagic`,
`quadralogical`, `4plexvid`, `sourcery`, `cellshade` (×2), `keyer-functional`,
`posterbox-functional`, `milkdrop-render-smoke`, `video-hide-controls`, and 11
`toybox-*`. What stands in for them is `webgl-attest`, a **sha256 of source bytes**,
which cannot observe behaviour at all. And the attest basis deliberately excludes
`e2e/tests/**` (`webgl-attest-lib.ts:279-296`, an explicit owner directive that test
edits must not force a GPU re-attest) — so **adding a new spec that matches an existing
heavy glob moves nothing**: the spec runs nowhere, and the standing attestation
silently no longer covers the set it claims.

**4.2 · 209 of 594 committed VRT baselines (35 %) are compared by no CI job.**
`STRICT_MATCH` is two spec files; `VRT_STRICT` filters `vrt.spec.ts` to the 45 names in
`STRICT_VRT_MODULES`. No workflow runs `FULL_MATCH` in compare mode. 83 card baselines
+ 126 in 28 other spec directories (`interactions` 6, `vrt-toybox` 27, `vrt-composite`
14, landing/dashboard/topbar) are captured, committed, diffed by a human once, and
never compared again. **Eight modules have zero pixel comparison anywhere** — no strict
card baseline and no face baseline: `chromaconsole`, `clipplayer`, `nibbles`,
`recorderbox`, `seqtris`, `textmarquee`, `toybox`, `trails`. (`seqtris` and `trails`
got their baselines today, so 2 of 8 are in flight.) `ci.yml:2310-2320` states this
policy honestly; what nobody re-derived is that the hole **grew from 66 to 83 card
baselines** since 2026-08-12.

**4.3 · Nothing in the tree reads the absence of a per-test budget.**
265 of 490 specs run on a number that appears nowhere in their source. The one gate
aimed at this class, `scripts/e2e-boot-bound-source.test.ts`, denies the **5 s expect
default** for **two** named boot subjects (topbar, `canvas-root`) — and the
most-used boot subject in the suite, `.svelte-flow__pane`, is not one of them: 73
`waitFor` sites across 67 files, **exactly one** bounded. Worse, the gate is
structurally green on the *unreachable bound* class, because `{ timeout: BOOT_MS }`
satisfies it at 1.00× the budget — it cannot compare a bound to the budget that
contains it. And a third readiness API is bounded by nothing at all:
`page.waitForLoadState('networkidle')`, **405 sites in 237 spec files, zero bounded**,
which is what killed `livecode.spec.ts` on `main`.

**4.4 · The e2e lane cannot compare assigned files to executed files. The VRT lane can.**
`scripts/vrt-shard-coverage.mjs` runs per `vrt-strict` shard, compares planned to
executed in both directions, treats a skip as not-executed, and fails on any mismatch
(`ci.yml:2732`). **There is no e2e equivalent.** The consequences it therefore cannot
see, all confirmed against the run's own blob reports by one reviewer:
`scripts/e2e-shard-plan.mjs:189` emits **basenames**, which `playwright test` consumes
as **regex path filters**, so 4 basenames over-match and 3 test executions happen twice
per run (`workflow-shell-live-glyphs` and `aut-patch-panel`); 19 `@collab` specs and 2
non-spec helper files occupy 21 of 426 shard slots and run zero tests; the accept script
sums both executions of a duplicated file into one row, so those two pins are ~2×
reality and feed back into the next plan.

**4.5 · Nothing compares the shard plan's prediction to the measured wall.**
`planShards` reports a **1.001×** spread across 12 e2e shards. The same 12 shards on
green `main` run `33537312141` took **412–714 s — 1.73×**, mean absolute error 87 s on
a 491 s prediction. The three largest misses are all *underpins on the files the
makespan is most sensitive to*: `faces-parity-4` pinned 970.7 / actual **1406 s**
(+45 %); `face-screen-render` pinned 330.8 / actual **710.1 s** (+115 %, and this is the
file that was split *for being too big*); `layers-survive-card-collapse` pinned 54.8 /
actual **122.3 s** (+123 %, and this is the file named in the planner's own #1600 war
story). The headline 1.001 × is a statement about arithmetic, not about CI.

**4.6 · 29 of 111 runs (26 %) were cancelled, and a cancelled job destroys its own
flake evidence.** `concurrency: cancel-in-progress: true` is unconditional. A cancelled
job never reaches its `if: always()` audit step, so any flake inside it is unobserved
and unrecorded. If cancelled runs fail at the same rate as completed ones (46 %), the
real red count in this window is closer to **51 than 38**, and roughly 13 reds are
simply not in any dataset. This is a larger blind spot than any single gate's.

**4.7 · No gate can see a two-PR merge, only its result.** C1's mechanism has no
detector anywhere in the tree, by construction. The one place it *could* be caught —
comparing the merged tree's regenerated artifact to what either PR attested — happens
only after the merge, on `main`, as a red.

**4.8 · The `vrt-strict` required-context name is pinned by nothing in `ci.yml`.**
It is required via ruleset 16042163 by literal string. `scripts/vrt-revalidate-gate.test.ts`
holds the literal in `REQUIRED_CONTEXTS`, but nothing asserts that the `ci.yml` **job
name** equals it. Renaming the job silently retires the required check.
`ci.yml:2330-2334` already says so in prose.

**4.9 · `coveredBy` is anchored to `existsSync`, not to execution.**
`workflow-shell-faces.spec.ts:949` checks that each named coverage path exists.
`milkdrop`'s exemption names 5 gates; **2 of them are in the never-run 42**. The
faceplate whose body has no pixel baseline anywhere is justified partly by specs no PR
ever runs.

**4.10 · A passing determinism probe is a control that moves, not one that measures.**
`_shell-faces.ts:1311` records that the `mirrorpool` compact scene was called BIT-EXACT
by `vrt-determinism-probe`, the tier was removed, and "the DOCK scene is unaffected and
still gates." In this window that was falsified: run `33474772983`, `face-mirrorpool-dock`,
`63 pixels (ratio 0.01) are different` against `DOCK_MAX_DIFF = 0`, `retries: 0`, on a
branch that changed no mirrorpool code, between two green runs of the same branch. The
co-tenancy explanation is **dead**: the scene planned onto shard 9 in all three runs and
the shard's 33-scene plan is byte-identical across them, and `vrt.config.ts:218-219`
sets `workers: 1, fullyParallel: false` precisely so no two VRT scenes contend. The PR
merged as `a7065bb86` with the flake neither fixed nor parked.

**4.11 · The flake gate cannot classify a timeout kill at all — by its own printed
scope note.** Every shard prints that it cannot see "a test killed by the job or global
timeout, which reports as a hard failure or as nothing at all, never as `flaky`." So a
shard killed by `--global-timeout` reports **zero failed tests**. Measured headroom:
the slowest of 12 `vrt-strict` shards hit **481 s = 80.2 %** of its 600 s global timeout
on run `33537312141` with `33 passed`; the owner-deleted budget wrapper used to fire at
85 %. The lane now runs ~5 points below where its warning tier used to be, with a hard
red as the only remaining backstop.

**4.12 · Skip enforcement runs on 1 of 4 gated lanes at runtime.** `--lane` appears once
in `ci.yml` (line 1420, `e2e`); `collab`, `webgl-smoke` and `behavioral-smoke` call the
audit bare and `violations` is set to `null`. `AUDITED_LANES` still contains
`'behavioral'`, which no job can select. Materially small — the source-side
deny-by-default in `e2e-skip-budget.test.ts` walks all of `e2e/tests` fleet-wide in the
`unit` lane, and today's ungoverned runtime population is three rows, all named and all
printed to the step summary.

**4.13 · Owner reservation is a naming convention enforced by nothing.**
`scripts/e2e-report-audit.mjs:53` reserves DOOM by **filename** —
`/(^|\/)doom-[^/]*\.spec\.ts$/`. A DOOM row in a differently-named spec would gate. This
is the second instance of the known "spec filename decides its CI lane" hazard, in a
different gate. **Realized cost in this window: zero** — no DOOM row gated, and the
gibribbon red is not DOOM. Latent, ~2 spec files of real exposure
(`per-module.spec.ts`, `per-module-per-port-inputs.spec.ts`).

---

## 5. Instruments that lie

Ranked by how badly a reader is misled. Each of these reports the wrong thing rather
than failing honestly, and one of them **manufactured a false finding inside this very
audit**.

**5.1 · `scripts/e2e-shard-plan.test.ts` — the file's own stated safety argument is
vacuous.** Line 40 calls `planShards(files, timings, SHARDS)` with **no contention
argument**, so PASS 1 never executes in the assertion the header calls "the safety
argument for the whole change." A reviewer's negative control (a copy, in scratch)
injected the single duplication bug PASS 1 makes possible and got:
`as the test calls it → 402 files, 402 unique, PASSES` / `as CI actually calls it →
439 placements, 402 unique, 37 FILES DUPLICATED`. Green on a 37-file duplication in the
only configuration CI runs. Compounding: line 31 plans over `Object.keys(timings)`
rather than the discovered spec list, so both `spread < 1.15` assertions are evaluated
with zero median-charged files present.

**5.2 · `scripts/ci-flake-gate.test.ts` — a comment can arm the gate.**
The header (lines 59-63) asserts "Comments are stripped first — `#` is a comment in
BOTH the YAML and the shell here, so PROSE ABOUT the flag can never be mistaken for the
flag." The strip is `/^\s*#/` — **whole-line only**. Re-running the production parser
verbatim over fixtures:

```
inline comment   npx playwright test --reporter=json  # TODO add --fail-on-flaky   → gate=true
trailing-comment job key   "  newlane: # sharded"    → job VANISHES into the preceding gated job
underscore / uppercase job key                        → job invisible entirely
continue-on-error / if:false / "… --fail-on-flaky || true"  → gate=true
playwright invoked via a wrapper script or reusable workflow → invisible
```

The `CONTROL: prose mentioning the flag` fixture only exercises a whole-line comment,
so the control passes over the hole. All latent today; the first is one YAML comment
away from certifying an unarmed lane as gated.

**5.3 · `.github/workflows/vrt-update.yml` contradicts itself, and the contradiction
produced a false finding in this audit.** The job header (line 60) says the capture runs
`--update-snapshots=all`; the command (line 356) is `--update-snapshots=changed`, and
line 343 explicitly says so. One area reviewer read the comment and concluded that a
regression in the 209 uncompared baselines "is laundered into its own baseline." That
conclusion is **false**, and it was manufactured entirely by a stale comment.

**5.4 · `e2e/playwright.config.ts:145-148` states the opposite of `ci.yml:1421`.**
The config says the per-shard audit "deliberately does NOT" pass `--fail-on-flaky` and
"gets armed when the tail above is drained." It is armed, and job logs print
`##[error]FLAKE (2 attempts)`. `ci.yml:1379-1400` *does* carry an "IS NOW ARMED (#1903)"
block — so this is a contradiction between two files, and anyone reasoning about
masking from the config gets the wrong answer in the reassuring direction.

**5.5 · `ci.yml:1306` is prose from a superseded topology, echoed as telemetry.**
`shard 10 15.2 min ← 1.8 min under budget` is a static comment describing a **10-shard**
layout; the lane runs 12 shards. It is printed in the banner of *every* e2e job, on
every day, on every PR, identically. One of my area reviewers read it as a measurement
and reported "10.6 % shard headroom" as a finding. Measured on green run `33537426937`,
the slowest of 12 shards is 13.3 min = **78 %** of the 17-min global timeout.

**5.6 · `faceplate-platform.spec.ts` declares per-test guards that can never fire.**
`sweepBudgetMs(n) = 30_000 + n * 20_000` (`:162`), uncapped, called at `:472`, `:638`,
`:965`. Measured in the blob reports: three tests carrying **19.8 min and 58.8 min**
budgets against a **17-min** `--global-timeout`. The shard dies before the guard fires.
It grows by 20 s per STRICT_FACES adopter, ×3 call sites — **every face promotion
widens it**, silently, in a derived number nothing prints. Eleven tests across five
files cannot survive two attempts inside the shard budget.

**5.7 · The cost-pin review prompt fires ~90 times per accept.**
`e2e-timings-accept.mjs` prints "REVIEW THE DIFF — a cost that moved a lot is a finding"
for every row that moved >25 %. Between the last two accepts, 90 of 402 rows qualified.
At that rate none of them is a finding, and the one that actually mattered
(`faces-parity-4` re-pinned from ~1370 to 970.7 on a single low sample) went through.

**5.8 · Stale numeric prose at the exact places people reason from.**
`ci.yml:1245` and `faces-parity-suite.ts:173` still say 17 min "is the MAXIMUM the
margin invariant permits (ceiling 20 − MIN_MARGIN_MIN 3)"; `ci.yml:1058` sets
`timeout-minutes: 25`, so the permitted maximum is **22**. `faces-parity-suite.ts:187`
says "against today's 5_000" while `FACE_PER_CELL_MS` is `14_000`.
`e2e/playwright.config.ts:83-85` says "each test file runs in its own worker. Tests
within a file run serially" — false under `fullyParallel: true`, and "correcting" the
config to match its comment would turn a 1406 s file into a serial wall against a
1020 s global timeout, i.e. a dead shard.
`e2e-skip-budget.mjs:752` says "fifteen modules" where the map holds **13**;
`:766` says `webgl-smoke` "has no JSON audit step" (it has had one since #1903), and
the file header says the same of `collab` (also false since #1903).

**5.9 · `scripts/webgl-attest-coverage.test.ts` test (4) is titled "the heavy WebGL
spec glob resolves the expected count" and pins no count** — only `> 0`. The title is
the artifact that makes 4.1 invisible to a reader scanning test names.

**5.10 · Unverifiable evidence printed as evidence.** `landing-new-rack-is-fresh.spec.ts:56`
cites `run 33230xxx` — a redacted id — as the justification for a live park, and that
string is printed verbatim into every `$GITHUB_STEP_SUMMARY`. Two of the ledger's 82
rows (`card-drop-patch.spec.ts:265`, `backdraft-preview-toggle.spec.ts:377`) do not name
their test at all, rendering as `(no title)` and a truncated fragment.

**5.11 · `scripts/e2e-shard-plan.test.ts:150` uses `WEBGL_HEAVY_GLOBS` instead of
`resolveEffectiveHeavySpecGlobs()`**, never subtracting `WEBGL_HEAVY_EXCLUDE`, so it
mis-derives 11 specs as not-scheduled while the matrix runs them. Latent, and it
re-creates the exact "one literal, two consumers" divergence `webgl-heavy-globs.ts`
exists to prevent.

---

## 6. Options for the owner

Everything below is a **choice**, not a decision I have made or taken. Nothing here has
been implemented. I have separated pure defect repair — where an instrument already
contradicts itself or an existing gate is already vacuous — from anything that adds
machinery, which under the standing rulings is the owner's call alone.

### (i) Pure defect repair — no new gate, no new workflow, no ruling needed

**O1 · Give the 17 unreachable-bound specs a budget derived from `boot-budget`.**
*This is the single highest-leverage item in the audit.* The repair pattern is already
merged and proven twice (`05ca9298c` / #2291, `7957400c0` / #2293): one
`test.describe.configure({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS })` per file, bound taken
from the shared export, no hand-typed number.
*Would fix:* the 30 s-default class outright — 7 of 17 recovered flakes in the window,
including `livecode` (a **red main**) and `workflow-shell-dual-glyph`, plus the standing
exposure of `workflow-shell.spec.ts` (the most-flaked spec in the suite, currently at
1.5×) and `frogger.spec.ts` (at 3.0×).
*Would not fix:* the over-summed class (`launchpad-perf-controls` declares 42 000 in
30 000 — that needs the sum reduced or the budget raised past 42 s, a separate
judgment), or the BLOOD 90/120 s class, which is a genuinely slow subject.
*Cost:* zero seconds on a green run — a bound only costs when exceeded. ⚠ **Not
zero-risk:** it costs *more* on a red run, because a test that used to die at 30 s now
runs to 90 s, lengthening the failing path toward the shard's `--global-timeout` that
`ci.yml:1220` exists to keep from destroying its own evidence. Given §4.11's measured
78–80 % occupancy, that margin is real but not comfortable.

**O2 · Fix `parsePwJobs`'s comment strip and job-key regex** (5.2). The file's own
header claims the behaviour the code does not have; repairing it makes the header true.
*Cost:* one regex change plus a fixture. It will go red on nothing today — a passing
negative control, not a positive one, which the repo's own standard says is weak
evidence. *Would fix:* the "green gate over an unarmed lane" shape. *Would not fix:*
`continue-on-error` / `if:` / `|| true` — the gate proves the flag is **typed**, never
that the step can fail the job.

**O3 · Pass the contention map in `e2e-shard-plan.test.ts`'s union assertion** (5.1) —
a missing fourth argument. *Would fix:* the assertion currently green on a 37-file
duplication in the only configuration CI runs. *Cost:* one line. *Note:* pointing the
same test at the discovered spec list rather than `Object.keys(timings)` is a larger
change and **may fail `spread < 1.15` on day one** — that is the finding, not a reason
to skip it, but it is a separate decision.

**O4 · Emit anchored path filters instead of basenames from `e2e-shard-plan.mjs`.**
*Would fix:* 3 duplicated test executions per run, the doubled flake exposure of
`workflow-shell-live-glyphs` and `aut-patch-panel`, and the ~2× pin error those two
feed back into the plan. *Cost:* one line in the planner, plus the accept script's
basenaming must follow. *Risk if botched:* a filter matching nothing is silently
dropped coverage — which is exactly the case for the assigned-vs-executed check in
(ii), so the two decisions are coupled. *Realized waste today:* ~35 CPU-s. Worth fixing
for legibility; **not** a threat to `main`.

**O5 · Treat a `0` cost row as unmeasured** (`timings[f] > 0 ? … : median`) and break
the LPT tie by lowest file count. *Would fix:* the deterministic pile of 15 zero-cost
parked specs onto one shard (the `-> 50 spec files` shard, where every other gets
31–36) and the ~27–70 s of per-shard file-collection overhead that scales with file
count. *Cost:* ~2 lines. *Would not fix:* the cost model's 1.73× error, which lives in
the pins, not the packing.

**O6 · Re-pin the three underpinned files from a real measurement** (`faces-parity-4`
970.7→~1406, `face-screen-render` 330.8→~710, `layers-survive-card-collapse` 54.8→~122).
*Would fix:* most of the observed 1.73× shard spread. *Cost:* an accept cycle.
*Caveat:* the pin is a single sample of a quantity with ±45 % run-to-run variance, so
this reduces the error without removing the mechanism.

**O7 · Correct the lying prose** (5.3, 5.4, 5.5, 5.8, 5.9, 5.10). Zero CI cost. Two
of these items have already produced false findings inside this audit (5.3, 5.5), and
two currently understate available headroom by 5 minutes at the exact place a parked
spec cites as blocked.

**O8 · Hoist `creditSetupBudget` into `spawnPatch`.** `_fixtures.ts:143-149` records
that the blocker was removed on 2026-08-17 and the work is "payable"; it is 2026-09-01.
Today the fixture credits only its own `goto` (~2–3 s) while `_setup-credit.ts:25`
traces a `spawnPatch` engine boot at up to **24.61 s inside a 30 s budget**. ~416 spec
files, ~1132 call sites, one edit. ⚠ **This changes the effective budget of the whole
lane at once** — it wants its own PR and a measured series, never a ride-along.
*Would fix:* the structural cause under most of the 30 s class, more durably than O1.
*Would not fix:* the 197 specs that import `test` from `@playwright/test` rather than
`./_fixtures` and so never reach the seam at all — that is a separate, nameable,
one-import migration (the `waitForPinnedTrio` shape: a seam adopted at half its call
sites).

**O9 · Reconcile the six `waitForPinnedTrio` copies.** All six now use `{ timeout:
BOOT_MS }` (#2279 migrated the bound) but three wait on `electraControl` and three on
`audioOut`. That is a product-truth disagreement about which module the shell pins,
wearing a duplication costume. *Cost:* answer the question once, then delete five
copies.

### (ii) Adds machinery or changes policy — the owner's call, presented as options

**O10 · The merge-order question (C1).** Three shapes, none free:
(a) *serialize merges that touch the WebGL basis or a generated artifact* — pure
policy, zero machinery, costs merge throughput and requires someone to notice which PRs
qualify; (b) *re-attest as a merge-queue step* — needs a real-GPU runner, which the
owner has ruled out; (c) *accept it* — treat "main red on attest after a batch" as a
known 20-minute fix, which is what happens today, at a cost of 12 red runs and 3 h 45 m
of red `main` in this window. Option (c) is defensible; not knowing the cause is not,
and now it is written down.

**O11 · An assigned-vs-executed check for the e2e lane.** The instrument already exists
one lane over: `scripts/vrt-shard-coverage.mjs` does exactly this per `vrt-strict`
shard. Porting it is nevertheless **a new gate on a new lane** and needs a ruling.
*Would fix:* §4.4 entirely — duplicate executions, the 21 phantom slots, and any future
spec silently dropped on the discovery side. *Cost:* one script + one step ×12 shards
(seconds); it would likely go red on day one on the 21 phantoms, which is a
bookkeeping fix, not a defect.

**O12 · Comparing a declared bound to the budget that contains it.** *Would fix:* the
whole unreachable-bound class permanently, including the module-scope-helper variant
(`frogger`) that defeats every per-test-block scan. *Cost:* it would redden 17–36 files
on day one, and per the #1903 precedent a gate that reds a large population on arrival
gets reverted rather than drained. Drain first (O1), arm second, is the shape that has
worked here.

**O13 · Adding `.svelte-flow__pane` to `BOOT_SUBJECTS`** in the existing
`e2e-boot-bound-source.test.ts`. This is a change to what a *current* gate reads, not a
new gate — but it would redden 63–73 files on arrival. Same drain-then-arm caveat.

**O14 · A top-level `timeout` in `e2e/playwright.config.ts` derived from
`boot-budget`.** This is the "option-B call" that two park entries are explicitly
waiting on. *Would fix:* the invisible default fleet-wide, in one line, without
touching 265 specs. *Cost:* a fleet-wide bound change — every currently-green test gets
a longer failing path, and the `--global-timeout` margin (§4.11) absorbs it.

**O15 · `continue-on-error: true` on `ci.yml:2743`** (the `vrt-strict` timings-harvest
upload). *Would fix:* C5's first case — a required check reddened by an artifact-service
timeout with every test passing. ⚠ *Would also* swallow the failure that leaves
`vrt-strict-timings.generated.json` un-refreshable, i.e. the stale-cost-table class.
It is a CI change; owner's call.

**O16 · Re-anchoring `isDoomReserved` on subject rather than filename** (§4.13).
⚠ This touches DOOM sweep behaviour and therefore **requires explicit owner approval
before anyone writes it**. I am naming it only so the latent hole is on the record;
realized cost in this window was zero, and I recommend nothing.

**O17 · An exit policy for #1847.** Today 193 `test.fixme` parks across 67 spec files
and 45 skip-budget entries have **no** age, no ceiling, and no assertion that reads
either — a park 14 days old and one 14 months old are indistinguishable to every check
in the tree. Shapes: a review cadence; surfacing park age in the CI summary the audit
already writes; or leaving it. ⚠ **"Reclassify some as permanent" should not be on the
list** — it contradicts the standing reconcile = fix-or-delete ruling that
`scripts/test-ledger.mjs:415` itself encodes.
*Context that argues against urgency:* the ledger is **not** stalled. In this window
alone, #2276, #2279, #2291 and #2293 removed **11 declaration-level parks and 3 budget
entries by root cause**, and two more subjects are diagnosed in flight. The population
looks flat because absorption and production are running at about the same rate. That
is a throughput problem, not neglect.

**O18 · `--lane` on the three lanes that lack it**, or deleting `'behavioral'` from
`AUDITED_LANES` so the dead branch stops implying coverage. *Cost:* low; *value:* also
low — the source-side deny-by-default already covers every spec fleet-wide in `unit`,
and today's ungoverned runtime population is three already-named rows.

**O19 · Median-of-N cost pins** instead of last-sample. *Would fix:* the `faces-parity-4`
outlier that caused shard 9's over-run. *Cost:* the accept script must download N runs'
blob artifacts; **artifact retention is 30 days**, which bounds N in practice.

---

## 7. What this audit could not determine

- **The window is `ci.yml` only.** `collab-nightly`, `vrt-update`, `daily-prod-deploy`,
  `chaos-24-7`, `e2e-flake-purge` and `flake-check-3x` runs are not in any count here.
  `collab-nightly` cannot be audited even in principle — it runs Playwright with
  `--reporter=list,html`, no `json` — and its alert fires only on `!success()`, so a
  recovered flake there is green and silent. (Its own header says it is a diagnostic
  backstop that runs *after* prod ships, not a gate; that characterisation is correct.)
- **29 cancelled runs are unknowable.** Their jobs never reach the `if: always()` audit
  step. If they red at the completed-run rate, ~13 additional reds exist that no
  dataset contains. Every count in §2 is therefore a **lower bound**.
- **Two bucket assignments are judgments, not measurements.** (1) `33435725342`
  (`BLOOD audio_l` hard-failing at 90 s on `feat/blood-face`) is filed under (a) because
  the branch owns the module — but the same test recovered as a flake on an unrelated
  branch a day later, which argues it is a shared under-budgeted subject and belongs in
  (b)/(c). (2) `33432670685` (the skip-budget violation on `feat/modtris-face`) is filed
  under (b) because the defect is the guard's coupling to a registry-derived population,
  not the PR's product change — a reasonable person could call it (a).
- **I did not read a single Playwright trace, and I re-ran nothing.** Every flake
  attribution is from the attempt-1 error string in the job log. The claim that a
  30 s-class flake was "competing with an uncredited boot" is a hypothesis consistent
  with `_setup-credit.ts`'s own traced measurement, **not** something I observed.
- **Co-tenancy (lead #2) is downgraded, not disproven.** One re-pin in the window
  (`a7065bb86` @ 11:38:02Z); the one repeated subject spanning it kept its shard; the
  other three repeated subjects each kept theirs. The mechanism is well-measured over
  longer windows (31 accepts in 45 days, 86–92 % re-assignment per accept) — it simply
  did not fire today, and repairs aimed at it would not have prevented any red in §2.
- **Counts I inherited rather than re-measured myself**, and which therefore carry the
  reviewers' error bars: the 42 never-run specs and the 66/11 heavy resolution; the
  594/128/45/209 baseline census and the 8 zero-comparison modules; the 193 parks / 45
  budget entries / 82 ledger rows; the `faceplate-platform` and `frogger` budget
  arithmetic; the `parsePwJobs` fixture outputs; every per-file cost figure derived from
  blob reports on run `33537312141`; the 405 `networkidle` sites. I re-measured
  independently: the run/job census and every bucket assignment; the 490/265/47/17 spec
  budget population; the presence or absence of a budget in `livecode`,
  `workflow-shell-dual-glyph`, `workflow-shell-live-glyphs`, `dx7-algorithm-picker` and
  `workflow-media`; the `boot-budget` constants; the cost-artifact re-pin count and
  timing; the shard stability of the four repeated flake subjects; and the existence of
  `vrt-shard-coverage.mjs` with no e2e counterpart.
- **Where two reviewers disagreed and I could not adjudicate**, I took the refuter:
  notably that the `gibribbon` red is not DOOM, that `vrt-update` uses `=changed`, that
  the "10.6 % shard headroom" figure was a workflow comment rather than telemetry, and
  that four of the nine "undiagnosed" flake subjects were in fact fixed or parked inside
  the window.
