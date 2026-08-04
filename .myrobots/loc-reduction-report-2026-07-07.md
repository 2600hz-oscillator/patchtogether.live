# LoC-Reduction Study — Consolidated Report

**Repo:** patchtogether.live (`inet.modular`) · **Date:** 2026-07-07 · **Method:** 7 investigator reports, adversarially spot-checked (cited files read; the largest estimates recomputed from their own arithmetic; overlaps merged; double-counts removed).

> # STATUS 2026-08-04 — KEPT. Waves 0–3 shipped in 48 hours, then the campaign STOPPED.
>
> This is a **campaign plan with a 21-row ranked backlog**, not a completion
> report. `git log --grep="chore(loc)"` returns exactly **5 merged PRs, all
> between 2026-07-07 and 2026-07-09, and nothing since.**
>
> **SHIPPED — rows 1, 2, 3, 4, 5, 6, 7, 10, 11, 16:**
>
> | rows | PR | verified |
> |---|---|---|
> | 1 — def-shape unit tests | **#1035** | `delay.test.ts` / `adsr.test.ts` / `vca.test.ts` all gone |
> | 2 + 3 + 10 + 16 — e2e smokes, `_fixtures.ts`, dead probes, helper prune | **#1036** | `attenumix.spec.ts` + `doom-mp-probe.spec.ts` gone; `e2e/tests/_fixtures.ts` exists |
> | 4 — uncommit `module-docs.generated.ts` | **#1037** | file absent; CLAUDE.md now documents it as a gitignored build artifact |
> | 7 + 11 — dead scripts/assets + DOOM harnesses | **#1034** | 51 files, **3,552 deletions**; `blood-frame-harness.mjs` deliberately kept, exactly as recommended |
> | 5 + 6 — card helpers + shared CSS | **#1040** | `card-kit.ts` → `portsFromDef` (**144 of 193** cards), `cardParams` (71 files, shipped under a different name than the report's `useCardParams`), `captureFlowStore`; `_module-card.css` = 523 lines |
>
> **STILL OPEN — 11 rows, untouched, and this file is their only record:**
>
> | row | check run 2026-08-04 | result |
> |---|---|---|
> | 8 worklet factory helper | `grep createWorkletFactory` | 0 hits |
> | 9 video fragment-effect runtime | `grep defineFragmentEffect` | 0 hits; **86** modules still call `compileFragment` (report said 59) |
> | 12 dsp ambient types / `defineWorklet` | `packages/dsp/src/worklet-globals.d.ts` | missing; **61** files still carry per-file `declare` blocks (report said 56) |
> | 13 worklet test-harness dedup | — | no shared util |
> | 14 ART `goertzel`/`rms` helpers | `art/setup/analysis.ts` | missing; **28** files still carry their own `goertzel` |
> | 15 workflow YAML composite | `.github/actions/` | no such dir; the two flake-purge workflows are still twins |
> | 17 GL utils dedup | — | `video/mat4.ts` exists, but `WavesculptCard.svelte:1006` still defines its own `compileShader` |
> | 18 Canvas.svelte internal dedup | `wc -l` | **8,821 lines — it GREW** |
> | **19 AutoCard — DECISION POINT** | `find AutoCard*` | 0 hits. The report says take the go/no-go "after #5/#6 land on ~50 cards". **144 cards landed. The decision was never taken or recorded anywhere.** |
> | **20 VFPGA bitstream/census — OWNER CALL** | — | both files still present; **the call was never made** |
> | 21 sequencer transport core | — | deferred to PR-C by design |
>
> ⚠ **Do not quote its baselines without re-deriving them.** The measured surfaces
> have grown *past* them: cards 63,070 → **69,352** lines (178 → **193**
> `*Card.svelte`); `e2e/tests/*.spec.ts` 314 → **396**. The campaign's ~15k
> deletions were absorbed by new modules, so the "realistic 30,000–45,000" ceiling
> needs recomputing.
>
> The **"What NOT to do"** section is the other reason this is kept: comment-stripping,
> pruning the 695 test-only exports, a def-declaration DSL, uncommitting
> `contract-lock.txt` or the ART fingerprints golden, booking Canvas decomposition as
> savings, trusting `knip --production` on Svelte — **each was measured and rejected.**
> Losing that invites a future agent to re-propose all seven.

---

## Executive summary

**Realistic net savings: 30,000–45,000 lines** for the core high-value subset, executed over a phased campaign. If the full menu lands at estimate, the arithmetic ceiling is ~40,000–60,000. The measured surfaces: cards 63,070 (178 `*Card.svelte`), e2e 80,536 (314 specs), web module unit tests 61,451, dsp entries 17,404, plus scripts/workflows.

**The 3 moves that matter most:**

1. **Delete the redundant test mass (~13,000–20,000 lines, near-zero gate churn).** Per-module def-shape unit tests are a second, weaker copy of the `contract-lock.txt` golden (verified: `delay.test.ts` is 44/44 lines of fields the golden already pins). Bespoke e2e smoke tests re-assert what the three registry sweeps (`per-module-per-port`, behavioral, modules render) already pin — `attenumix.spec.ts` is 131/131 lines redundant (verified by reading both). This is pure deletion of *weaker duplicates of existing gates*, and it raises suite signal quality, which is the owner's standing e2e-quality verdict anyway.

2. **Card-layer mechanical dedup with zero-pixel proof (~7,500–14,500 lines, no re-baselining).** `portsFromDef` + `useCardParams`/card-kit + shared control-row loops (verified: 2,838 lines of hand-typed PortDescriptor lists, 738 Knob/Fader instances restating ParamDef, 14,607 verbatim-duplicate script lines) plus shared card CSS (verified: 15,435 style lines, 72% verbatim-duplicate). Both are provable with *zero-diff VRT runs* — the suite becomes the regression proof, not a re-baseline bill. Critically, spot-check confirmed **only 3 cards** (Cube/Hypercube/Wavesculpt) are in the WebGL attest basis — the other ~184 cards migrate with zero attest churn.

3. **Pure-deletion hygiene sweep (~8,000–9,500 lines, near-zero risk).** Uncommit `module-docs.generated.ts` (4,531 verified — generated, never hand-edited, a known conflict file), delete `scripts/omr/` (2,299 incl. a committed pip log; zero refs verified), the 4 unreferenced asset-builder scripts (671 verified), the 3 non-CI DOOM acceptance harnesses (~1,000; CI runs only lockstep-barrier, verified), `doom-mp-probe.spec.ts` (1,262 verified; self-described manual probe for a bug already root-caused in #345).

**What NOT to do** (each was measured and rejected — see final section): comment-stripping (~6,600 comment lines in the monoliths are design documentation), pruning the 695 test-only exports (that's the pure-core unit/ART testing seam), a def-declaration DSL (breaks the static-literal manifest extractors), uncommitting `contract-lock.txt` or the ART fingerprints golden (destroys gates), Canvas.svelte decomposition booked as savings (moves lines, doesn't cut them), and trusting knip `--production` on Svelte (verified false positives: it misses template imports).

**Corrections applied during consolidation:**
- The claim that any card edit churns the WebGL attest is **false** — `resolveWebglBasis()` includes only cards whose source creates a GL context (3 by direct regex match, verified), all of `lib/video/**` *excluding* `.test.ts`, and 3 flagged audio defs. This makes the card campaign cheaper than two investigators believed.
- Two investigators independently counted `scripts/omr` + asset builders — counted **once** here.
- Two investigators measured the def-shape test mass differently (9,137 vs 12,134 block lines); my independent recount (def-only-ish files: audio 53 files/11,715 lines, video 37/7,465) supports the larger figure but not full deletability → merged honest range 6,000–10,000.
- The AutoCard renderer estimate (18,000–28,000) was **downgraded**: two-thirds of it rests on single-file samples per tier, it double-counts the mechanical-helper and CSS savings which are its own prerequisite slices, and it uniquely carries a full VRT re-baseline bill. Treated as a *decision point* worth +5,000–8,000 incremental beyond the helpers, not a committed line item.

---

## Ranked table

| # | Approach | Est. LoC saved (honest) | Risk | Gate churn | Incremental? |
|---|----------|------------------------|------|-----------|--------------|
| 1 | Delete def-shape unit tests (+ invariant sweep first) | 6,000–10,000 | Low | None (video `.test.ts` excluded from attest basis — verified; ART pins never hash web tests) | Yes, per-batch |
| 2 | Delete sweep-redundant e2e smoke tests | 5,500–9,000 | Low-med (guard-list discipline) | Collab basis only for the 25 `@collab`-content specs | Yes, per-batch |
| 3 | e2e shared fixtures (`_fixtures.ts`: errorWatch, rack, setNodeParams adoption) | 4,500–7,000 (net of #2) | Low | One batched collab re-attest | Yes |
| 4 | Uncommit `module-docs.generated.ts` (build-time generation) | 4,531 repo lines | Low | None | Single PR |
| 5 | Card mechanical helpers (portsFromDef / card-kit / control-row loops) | 4,000–8,000 | Med | Zero expected (0-diff VRT proof); exclude 3 GL cards | Yes, per-batch |
| 6 | Shared card CSS extraction | 3,500–6,500 | Med | Zero expected (0-diff VRT proof) | Yes, per-batch |
| 7 | Dead scripts/assets (`scripts/omr`, 4 builders, tr808 flacs) | 2,300–3,000 (+3.4 MB) | Near-zero | None | Single PRs |
| 8 | Worklet factory helper for audio defs | 1,900–2,600 | Med | ~7 ART `.sha` re-pins, once | Yes |
| 9 | Video fragment-effect runtime (~45 single-pass modules) | 1,800–2,700 | Med-high | WebGL re-attest ×~3 batches; **currently blocked** | Batched only |
| 10 | e2e dead/diagnostic (doom-mp-probe + fixme corpses) | 1,300–1,600 | Low | One `@collab` file (batch with #3) | Yes |
| 11 | DOOM/nblood non-CI acceptance harnesses | 1,000–1,300 | Low (tooling loss) | None | Yes |
| 12 | dsp ambient `worklet-globals.d.ts` + `defineWorklet` harness | 950–1,300 | Low-med | One ART `.sha` re-pin wave (~52 scenarios), batched once | Yes |
| 13 | Worklet test-harness dedup (24 vitest files) | 850–1,400 | Low | None (one dsp cache-key rotation) | Yes |
| 14 | ART analysis helpers (`goertzel`/`rms` ×19/×28) | 450–750 | Low | None (pins hash sources, not scenario tests — verified) | Yes |
| 15 | Workflow YAML composite + flake-purge merge | 450–750 | Med (CI spine) | None, but required-check names must not move | Yes |
| 16 | e2e helper-export prune + server/art micro-sweep | 350–570 | Low | Collab-basis half batched with #3 | Yes |
| 17 | GL utils dedup (mat4 / compileShader / FBO) | 250–450 | Med | WebGL re-attest (batch with #9) | Batched |
| 18 | Canvas.svelte internal dedup (loader table, test-hook helper) | 250–450 | Low | None | Yes |
| 19 | **Decision point:** AutoCard def-driven renderer | +5,000–8,000 beyond #5+#6 | High | Full VRT re-baseline of every migrated card ×2 platforms | Yes, but pays VRT per batch |
| 20 | **Parked:** VFPGA bitstream/census deletion | 0 or 962 | Owner call | WebGL re-attest | — |
| 21 | **Deferred:** sequencer transport core | 1,000–1,800 | High | ART + behavioral lane churn | Ride the seq-clock PR-C migration |

Core subset (1–8, 10–14, 16, 18): **arithmetic 36,000–56,000; with a 20–30% slippage haircut on the refactor items, realistic 30,000–45,000.**

---

## Per-approach detail

### 1. Delete def-shape unit tests (merged: defs-engines #1 + test-inf #1)

**Mechanism.** `contract-lock.txt` (3,292 lines, verified) pins every port id/type/paramTarget/cvScale/edge, every param min/max/curve/default, stereo pairs, exposable controls, and control families per module, enforced by `contract-lock.test.ts`. The per-module "module-def shape" describe blocks assert the same fields, weaker (no removal detection). Delete the shape blocks; ~40–50 def-only test files collapse entirely. First land one registry-driven invariant sweep for the fields the golden deliberately excludes: `contract-signature.ts` header confirms `label`/`category` are cosmetic and excluded (verified), so the existing lowercase-label guard must gain a category-validity check before deletion.

**Evidence (spot-checked).** `delay.test.ts`: all 44 lines assert golden-pinned fields. `adsr.test.ts`/`vca.test.ts` "math" tests assert a locally defined lambda — zero product coverage. My independent recount: audio 53 def-only-ish files / 11,715 lines, video 37 / 7,465 (upper bounds; some def modules export real pure functions whose tests must be kept). `webgl-attest-lib.ts:231` confirms `.test.ts` under `lib/video/**` is excluded from the attest basis, so video test deletion is attest-free.

**Pros.** Largest zero-functionality-loss deletion; the contract stays pinned, stronger. Gate-free. New-module authoring gets cheaper.
**Cons.** Per-block classification needed (~1 in 5 shape blocks smuggles a behavioral assert); rationale comments ("feedback.max<1 self-osc protection") should migrate into `docs` fields.
**Risks.** Deleting label/category asserts before the sweep lands = brief coverage gap. Wide diff invites conflicts with in-flight module PRs.
**Prerequisites.** Invariant sweep PR first; owner sign-off that the golden diff is the accepted failure surface.
**First slice.** Sweep + delete the ~48 pure def-only audio files (~9,000 lines, one reviewable PR).

### 2. Delete sweep-redundant e2e smoke tests

**Mechanism.** The three registry sweeps assert per module: handle presence, outputs emit typed signal at a sink, inputs accept + edge materializes, plus a calibrated behavioral delta. Bespoke-spec tests that only assert mount/toContainText/no-console-error/"audio flows" are strictly weaker duplicates. Delete test-by-test; whole-file only where 100% smoke and cited by no exemption.

**Evidence (spot-checked).** `attenumix.spec.ts` read end-to-end: both tests are mount + `__ydoc.transact` param sweeps + `errors.toEqual([])` — fully covered by sweep dims 1–3. Sweep header confirms the three dims over ~327 tests. **Caution upgraded during consolidation:** the "covered by \*.spec.ts" exemption citations number ~183 across the three sweep files (more than the investigator's ≥55) — the deletion guard list is mandatory, per-batch.

**Pros.** ~8–12% of e2e/ with near-zero real coverage loss; deletions need no flake-check; cuts CI wall-time (each deleted test is a page boot).
**Cons.** 177-file triage, human judgment per test.
**Risks.** Never delete poly/MIDI real-source-chain e2e (CLAUDE.md hard rule) even when they look like smokes. Param-corner chaos tests occasionally catch NaN/crash bugs — consider one registry-driven param-corner dim before deleting that class. Specs containing `@collab` re-hash the collab basis on deletion — batch those.
**First slice.** The ~10 pure-smoke files in no exemption citation (attenumix archetype), ~900–1,200 lines, with affected sweep rows run locally.

### 3. e2e shared fixtures

**Mechanism.** New `e2e/tests/_fixtures.ts` (deliberately NOT `_helpers.ts`, which is in the collab basis): errorWatch auto-fixture (replaces 351 hand-rolled collectors — verified count — and *adds* error coverage to ~200 specs that have none), rack-navigation fixture (805 `goto('/rack')` + 799 `networkidle` verified), adoption of the already-existing `setNodeParams` (verified: only 5 importers vs 285 inline `__ydoc.transact` blocks) and `readScopeSnapshot`/`summarize`.

**Pros.** Mechanical, codemod-able; raises coverage while deleting lines.
**Cons.** 250+ file diff; errorWatch will surface pre-existing benign console errors needing triage (run report-only first).
**Risks.** The 25 `@collab`-content specs must be edited in ONE PR paying one collab re-attest (relay+DB required). Keep helper timing identical on SwiftShader-slow CI.
**First slice.** `_fixtures.ts` + ~20 non-collab specs, REPEAT=3.

### 4. Uncommit `module-docs.generated.ts`

**Mechanism.** The 4,531-line render module (verified) is already produced headlessly by the `DOCS_UPDATE=1` contract-lock run; extract that writer into a prebuild script wired into prepare/pretest/vite-plugin, gitignore the output, drop the freshness assertion. `contract-lock.txt` stays committed — it IS the gate.

**Honest framing.** This cuts repo lines and kills a documented merge-conflict artifact, but removes zero maintenance burden (nobody hand-edits it). Book it as hygiene, not as refactor value.
**Risks.** CI unit lane and prerender must generate before first import — 3 entry points to wire; miss one and CI reds on a missing module.
**First slice.** The whole thing is one PR.

### 5 + 6. Card mechanical helpers + shared card CSS (merged: cards #2/#3 + bigfiles #2/#3)

**Mechanism.** (a) `portsFromDef(def)` replaces the 2,838 lines of hand-typed PortDescriptor lists (verified); `useCardParams` replaces the copy-pasted set/live/param closures (176× identical props line, 156× `useEngine`, 96 files with the live factory — verified counts from two independent investigators agree); `{#each def.params}` loops collapse the 738 control instances' restated min/max/default. (b) Extend the existing `_module-card.css` (the pattern is proven in-repo, and by the docs house.css extraction #994) with the ≥10×-duplicated blocks: fader-row/preview/panel/pill/readout families (15,435 style lines, 11,061 verbatim-duplicate — verified; discounted heavily because much of that is trivially-common lines).

**The proof discipline is the point:** both are zero-pixel changes, so the affected VRT rows must diff ZERO — the suite is the regression proof and no baselines are re-generated. Any diff = a bug in the conversion, not a re-baseline event.

**Pros.** Kills the def↔card value-drift bug class (880 restated min/max/default lines with no gate today). Zero attest churn for ~184 of 187 cards (verified basis mechanics). Natural Slice-0 for the AutoCard decision.
**Cons.** Touch-every-file diff volume; cards with deliberate label/order divergence need an explicit overrides arg (silent-label-regression vector — VRT catches text, so run the rows).
**Risks.** Shared unscoped CSS changes cascade specificity — extract in ~10-card batches with per-batch `task vrt`. Leave the 3 GL cards (Cube/Hypercube/Wavesculpt) out of mechanical batches entirely.
**First slice.** Helpers + ~15 tiny/mid cards, zero-VRT-diff assertion; CSS: the fader-row + pill/panel families (38+21 sharing cards).

### 7. Dead scripts/assets (merged: deadcode #3 + test-inf #4 — was double-counted)

Verified: `scripts/omr/` = 2,299 lines including a committed `pip_install.log` and probe logs, zero references in Taskfile/workflows/package.json. Builders = 671 lines, zero references (media-burn tiles are baked into the envelope's base64 — the static copies are unused; `CadillacOverlay` uses `/img/cadillac.png`). tr808 flacs orphaned since HYDROGEN's deletion (#1013). Grep `.myrobots/` for path refs before deleting; ping owner on the moonlight note data (score/#155 provenance — worst case move 2 data files to the plan dir, still ~1,900 saved) and the recently-touched gibribbon builder. Record the deleting SHA in the PR body as the regeneration pointer.

### 8. Worklet factory helper (audio defs)

`createWorkletFactory(def, opts)` replaces the byte-identical 35–50-line boot scaffold in 54 modules (WeakSet guard, addModule, param-init, port-index Maps derived from def order — which is what every module hand-writes today). Contract-lock untouched; correct-by-construction port maps kill a silent-desync bug class. **Risks:** ~7 audio module files sit in explicit ART pin path lists — those pins must ADD the helper path or future helper edits escape the hash; land a pre-migration invariant sweep asserting handle-map keys == def port ids to surface any *deliberate* deviations before flattening them; never infer channel counts — pass worklet options explicitly per module. First slice: helper + 5 boring modules + the invariant sweep; verify empty contract-lock diff.

### 9 + 17. Video fragment-effect runtime + GL utils (attest-batched)

~45 of 59 `compileFragment` modules share a byte-similar 55–75-line factory; `defineFragmentEffect` collapses each to ~10–15 declarative lines, shaders untouched. GL utils (canonical compileShader/linkProgram/FBO from engine.ts; WavesculptCard's private mat4 block replaced by the tested `video/mat4.ts` — with a matrix-convention equivalence unit test FIRST, since a transposed matrix typechecks and renders garbage). **Hard blocker:** local `task webgl:attest` currently refuses (video-orientation camera failures — known memory). Every slice pays a real-GPU re-attest, so batch into ~3 PRs total, pilot on modules with existing DRS attest coverage (edges, chroma), and have the helper validate texture/uniform port ids against `def.inputs` at factory time (throw, don't render black).

### 10 + 11. e2e dead/diagnostic + DOOM harnesses

`doom-mp-probe.spec.ts` (1,262 verified) self-describes as a manual, non-gating probe for a bug confirmed fixed in #345; the asserting gate and regression pin both stay. Offer owner delete-vs-relocate to `e2e/manual/`. The 22 `test.fixme` sites follow reconcile-means-fix-or-delete: recorderbox/edges fixmes trace to the CI capability gap and represent *intended coverage of real features* — flag to owner for the capability-probe fix pattern rather than silent deletion; the in-card-title collab-sync fixme should be fixed, not deleted. Of the 4 non-CI native harnesses (verified: CI runs only lockstep-barrier), delete the 3 DOOM ones; hold `blood-frame-harness.mjs` until Blood Phase-2 scope confirms it's not reused. Honest note: these are debugging tools with optionality value — the #345 saga was diagnosed with exactly this kind of harness; the deleting SHA goes in the runbook.

### 12 + 13 + 14. dsp ceremony, worklet test harness, ART analysis helpers

dsp: one ambient `worklet-globals.d.ts` kills the 56 verified per-file declare blocks (~700 net); `defineWorklet` removes the remaining class/registerProcessor ceremony (~300–500 more) while preserving the no-top-level-export rule and the vitest registerProcessor shim. **Pay the ART churn once:** both changes edit all entry sources, so do them in ONE sweep, re-pin `.sha` LAST, and treat any `.f32` diff as a conversion bug. Port-messaging entries (17 files) last or never. The dsp investigator's own honest ceiling — ~1,100–1,450 net, i.e. 3–4% of the package — is correct; the rest is genuine DSP math, documentation, and tests. Separately: the 24 copy-pasted vitest worklet harnesses (verified grep) → one shared util (~850–1,400); the 19 goertzel + 28 rms copies in ART scenarios → `art/setup/analysis.ts` (~450–750; verify numeric equivalence per variant — a different normalization silently shifts a threshold; pins are unaffected since they hash sources, not scenario tests — verified).

### 15. Workflow YAML

Composite `setup-workspace` action for the ~20 re-declared setup blocks + merge the flake-purge twins. Do the twins first (dispatch-only, zero gate risk, ~170 lines). The composite touches the required-gate spine: required check names must not move, cache-path variance must be diffed per job, and per the CI-walltime standard anything with >2 min impact needs owner OK. Lowest LoC-per-risk on the list — do it opportunistically, not as a campaign pillar.

### 16 + 18. Micro-sweeps

Orphaned e2e helper exports (verified method: knip cross-checked against grep, with knip's vrt-config blind spot identified and compensated), the 7-line `mike/intent.ts` shim, server/art unused exports, Canvas loader-table + test-hook publish helper (keep debug-global names byte-compatible — e2e polls them). Split collab-basis files (`_helpers.ts`, `_collab-helpers.ts`) into the batched collab re-attest PR.

### 19. Decision point: AutoCard renderer

The mechanism is sound (card-map already supports fallback resolution; defs already carry everything the 738 controls re-type; descriptors can live outside the attest basis and outside contract-lock — all verified) and it's the only path that meaningfully compounds (new modules get cards for free; migrating = deleting a file). But the consolidated verdict is: **do not commit to it yet.** Two-thirds of its 18–28k estimate rests on one sample file per size tier; it double-counts #5/#6; the huge tier (28,560 lines) barely benefits; the descriptor language can eat its own savings; 1,026 load-bearing testids must pass through verbatim; and unlike everything else in this report it converts VRT from a zero-diff proof into a re-baseline bill for every migrated card on two platforms, with owner-examined diffs per the house rule. **Decide after #5/#6 land on ~50 cards:** if the residual per-card mass is still large and the descriptor sketch validates on 3 representative cards, the incremental +5,000–8,000 (plus ~120 file deletions) is worth it, starting with the 49 tiny cards.

### 20 + 21. Parked / deferred

**VFPGA bitstream/census (962):** production-dead (verified: only test importers) but 10 days old and adversarially built as a deliberate future seam — owner call, and it costs a WebGL re-attest, so if approved, ride a #9 batch. **Sequencer transport core (1,000–1,800):** real duplication (verified pairwise 26–38% identical lines) but collides head-on with the in-flight seq-clock worklet migration (PR-B #969 / planned PR-C) and reopens the just-stabilized behavioral lane; do it *as part of* PR-C's per-module rewiring or not at all.

---

## Sequencing

The two treadmills to respect: every `lib/video/**` edit = a real-GPU WebGL re-attest (currently locally **blocked**), and every dsp entry-source edit = an ART `.sha` re-pin wave. Batch each so the toll is paid once per wave. Keep ≤2 PRs in flight; run `task pr:conflict-sweep` after each merge — several waves touch the hand-maintained conflict files (`modules-card-map.test.ts`, per-port spec lists, `vrt-exemptions.ts`).

- **Wave 0 — free deletions (now, zero gates):** #7 dead scripts/assets, #11 DOOM harnesses, #4 generated-file uncommit, #10 doom-mp-probe, non-collab half of #16. ~9,000–10,500 lines, no attest/ART/VRT/contract churn at all.
- **Wave 1 — test-mass deletion:** land the invariant sweep, then #1 def-shape batches (~30 files/PR); #2 e2e smoke batches (~15 specs/PR) with the exemption guard list built first. Defer every `@collab`-content spec to Wave 2's collab PR.
- **Wave 2 — e2e fixtures + the single collab re-attest:** #3 `_fixtures.ts` pilot then non-collab batches; ONE dedicated PR editing/deleting all 25 `@collab` specs + `_helpers.ts`/`_collab-helpers.ts` prunes, paying one collab re-attest with relay+DB up.
- **Wave 3 — card layer (zero-pixel):** #5 helpers then #6 CSS, ~10–20 cards per PR, each with a zero-diff VRT run and its per-module-per-port rows; 3 GL cards excluded. At ~50 cards migrated, hold the **AutoCard go/no-go** with the owner.
- **Wave 4 — audio ART-pin batch:** #12 dsp ambient types + defineWorklet + #8 worklet-factory pilots + the dx7/fourplexer mirror-table moves in as few sweeps as possible; `.sha` re-pins LAST, `.f32` must not move; #13/#14 ride along (pin-free).
- **Wave 5 — video attest batch:** first unblock local `task webgl:attest` (the video-orientation camera failures); then #9 runtime + #17 GL utils (+ #20 if approved) in ~3 batched PRs, each a planned re-attest.
- **Continuous:** #15 flake-purge merge and #18 Canvas dedup slot in anywhere; #21 rides PR-C.

---

## Costs of the campaign — honest accounting

- **Owner review load is the real currency.** Waves 1–3 are 100–400-file diffs of individually trivial hunks. Budget roughly: Wave 0 ~1 hr; Wave 1 ~4–6 hrs of spot-check plus sign-offs on two policy calls (golden-as-failure-surface; param-corner chaos deletion); Wave 3 the largest — per-batch VRT runs must be *examined, not rubber-stamped* even when the expectation is zero diff. If AutoCard is greenlit, add per-batch baseline-diff review on two platforms — that bill is the main argument for stopping at Wave 3.
- **Regression risk on 187 cards / 168 modules is managed by proof discipline, not care:** zero-diff VRT for #5/#6, empty contract-lock diff for #8, `.sha`-only ART diffs for #12, REPEAT=3 on every changed spec. Any deviation is a conversion bug to fix, never a baseline to accept.
- **Gate-churn tolls, paid deliberately:** one collab re-attest (Wave 2), one ART re-pin wave (~52 scenarios, Wave 4), ~3 WebGL re-attests (Wave 5, after unblocking). Nothing else in Waves 0–3 touches an attest basis — verified against `resolveWebglBasis()` mechanics, not assumed.
- **Coverage optics will look worse while reality improves:** unit-test count drops sharply in Wave 1 and e2e count in Waves 1–2. The replacement coverage (golden + sweeps + errorWatch-everywhere) is strictly stronger; say so in each PR body so future agents don't "restore" the deleted smokes.
- **Where NOT to cut:** docs prose and header comments are owner-mandated product content (AUTHORED tier, ~4,400 def lines + ~6,600 monolith comment lines); test coverage that asserts real behavior (ART scenarios, behavioral deltas, poly/MIDI real-source-chain e2e, the DSP-math unit gates behind the 695 test-only exports); `contract-lock.txt` and `art/fingerprints.generated.json` (committed goldens ARE the gates); the recorderbox/edges fixmes (intended coverage awaiting the capability-probe pattern, not dead weight); and the debugging-harness class generally — deletions there trade lines for optionality and each needs the regeneration pointer recorded.