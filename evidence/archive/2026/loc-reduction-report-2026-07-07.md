# LoC-Reduction Study — Consolidated Report

**Repo:** patchtogether.live (`inet.modular`) · **Date:** 2026-07-07 · **Method:** 7 investigator reports, adversarially spot-checked (cited files read; the largest estimates recomputed from their own arithmetic; overlaps merged; double-counts removed).

> # STATUS — LIVE but STALLED. Waves 0–3 shipped in 48 hours, then the campaign STOPPED.
>
> This is a **campaign plan with a 21-row ranked backlog**, not a completion
> report. `git log --grep="chore(loc)"` returns exactly **5 merged PRs, all
> between 2026-07-07 and 2026-07-09, and nothing since** (#1034–#1037, #1040,
> covering rows 1–7, 10, 11, 16).
>
> **STILL OPEN — re-verified 2026-08-12:**
>
> | row | check | result |
> |---|---|---|
> | 8 worklet factory helper | `grep createWorkletFactory` | **0 hits** |
> | 9 video fragment-effect runtime | `grep defineFragmentEffect` | **0 hits** |
> | 12 dsp ambient types | `packages/dsp/src/worklet-globals.d.ts` | **absent** |
> | 13 worklet test-harness dedup | — | no shared util |
> | 14 ART `goertzel`/`rms` helpers | `art/setup/analysis.ts` | **absent** |
> | 15 workflow YAML composite | `.github/actions/` | **no such dir**; the flake-purge twins are still twins |
> | 17 GL utils dedup | — | `lib/video/mat4.ts` exists, but `WavesculptCard.svelte` still defines its own `compileShader` |
> | 18 Canvas.svelte dedup | `wc -l` | **8,610 lines** — down 211 from the 8,821 the last triage recorded, still far above the 2026-07-07 baseline |
> | **19 AutoCard — DECISION POINT** | `find AutoCard*` | **0 hits.** The go/no-go was to be taken "after #5/#6 land on ~50 cards"; **144 landed. The decision was never taken or recorded anywhere.** This is the single highest-value unmade decision in the file. |
> | **20 VFPGA bitstream/census — OWNER CALL** | — | both files still present; **the call was never made** |
> | 21 sequencer transport core | — | deferred to PR-C by design |
>
> ⚠ **Do not quote the baselines without re-deriving them.** The measured
> surfaces have grown *past* them. Measured 2026-08-12: cards 63,070 →
> **~70,450 lines** (178 → **195** `*Card.svelte` under `lib/ui/modules`, 197
> repo-wide); `e2e/tests/*.spec.ts` 314 → **417**. The campaign's ~15k deletions
> were absorbed by new modules, so the *"realistic 30,000–45,000"* ceiling
> **needs recomputing** before anyone plans against it.
>
> ⚠ **Rows 9 / 17 and all of Wave 5 are hard-blocked on local
> `task webgl:attest`**, which was refusing on video-orientation camera
> failures. Re-check whether that is still true before scoping them — the
> blocker, not the work, is what stopped them.

---

## Corrections applied during consolidation

- The claim that **any card edit churns the WebGL attest is FALSE** —
  `resolveWebglBasis()` includes only cards whose source creates a GL context
  (**3** by direct regex match, verified), all of `lib/video/**` *excluding*
  `.test.ts`, and 3 flagged audio defs. This *"makes the card campaign cheaper
  than two investigators believed"* — ~184 of 187 cards migrate with zero attest
  churn.
- Two investigators independently counted `scripts/omr` + the asset builders —
  counted **once** here.
- Two investigators measured the def-shape test mass differently (9,137 vs
  12,134 block lines); an independent recount (audio 53 files/11,715 lines,
  video 37/7,465) supports the larger figure but not full deletability → merged
  honest range 6,000–10,000.
- **The AutoCard estimate (18,000–28,000) was DOWNGRADED**: two-thirds of it
  rests on single-file samples per tier, it double-counts the mechanical-helper
  and CSS savings which are its own prerequisite slices, and it uniquely carries
  a full VRT re-baseline bill. Treated as a *decision point* worth +5,000–8,000
  incremental beyond the helpers, not a committed line item.

---

## What NOT to do — each was measured and rejected

**This section is the primary reason the file is kept.** Losing it invites a
future agent to re-propose all seven.

- **Comment-stripping.** ~6,600 comment lines in the monoliths are design
  documentation, and docs prose + header comments are owner-mandated product
  content (AUTHORED tier, ~4,400 def lines).
- **Pruning the 695 test-only exports.** That IS the pure-core unit/ART testing
  seam.
- **A def-declaration DSL.** Breaks the static-literal manifest extractors.
- **Uncommitting `contract-lock.txt` or `art/fingerprints.generated.json`.** The
  committed goldens ARE the gates; removing them destroys the gates.
- **Booking Canvas.svelte decomposition as savings.** It moves lines; it does not
  cut them.
- **Trusting `knip --production` on Svelte.** Verified false positives — it
  misses template imports.
- **Cutting test coverage that asserts real behaviour** — ART scenarios,
  behavioral deltas, poly/MIDI real-source-chain e2e, the DSP-math unit gates
  behind the 695 test-only exports; the recorderbox/edges `fixme`s (intended
  coverage awaiting the capability-probe pattern, not dead weight); and the
  debugging-harness class generally, where deletions trade lines for optionality
  and each needs a regeneration pointer recorded.

---

## The open rows, with enough context to act on

### 8. Worklet factory helper (audio defs) — 1,900–2,600

`createWorkletFactory(def, opts)` replaces the byte-identical 35–50-line boot scaffold in 54 modules (WeakSet guard, addModule, param-init, port-index Maps derived from def order — which is what every module hand-writes today). Contract-lock untouched; correct-by-construction port maps kill a silent-desync bug class. **Risks:** ~7 audio module files sit in explicit ART pin path lists — those pins must ADD the helper path or future helper edits escape the hash; land a pre-migration invariant sweep asserting handle-map keys == def port ids to surface any *deliberate* deviations before flattening them; never infer channel counts — pass worklet options explicitly per module. First slice: helper + 5 boring modules + the invariant sweep; verify empty contract-lock diff.

### 9 + 17. Video fragment-effect runtime + GL utils (attest-batched) — 1,800–2,700 / 250–450

~45 of the `compileFragment` modules share a byte-similar 55–75-line factory; `defineFragmentEffect` collapses each to ~10–15 declarative lines, shaders untouched. GL utils (canonical compileShader/linkProgram/FBO from `engine.ts`; WavesculptCard's private mat4 block replaced by the tested `video/mat4.ts` — **with a matrix-convention equivalence unit test FIRST, since a transposed matrix typechecks and renders garbage**). **Hard blocker:** local `task webgl:attest` was refusing (video-orientation camera failures). Every slice pays a real-GPU re-attest, so batch into ~3 PRs total, pilot on modules with existing DRS attest coverage (edges, chroma), and have the helper validate texture/uniform port ids against `def.inputs` at factory time (throw, don't render black).

### 12 + 13 + 14. dsp ceremony, worklet test harness, ART analysis helpers

dsp: one ambient `worklet-globals.d.ts` kills the per-file declare blocks (~700 net); `defineWorklet` removes the remaining class/registerProcessor ceremony (~300–500 more) while preserving the no-top-level-export rule and the vitest registerProcessor shim. **Pay the ART churn once:** both changes edit all entry sources, so do them in ONE sweep, re-pin `.sha` LAST, and treat any `.f32` diff as a conversion bug. Port-messaging entries (17 files) last or never. The dsp investigator's own honest ceiling — ~1,100–1,450 net, i.e. 3–4 % of the package — is correct; the rest is genuine DSP math, documentation, and tests. Separately: the copy-pasted vitest worklet harnesses → one shared util (~850–1,400); the goertzel + rms copies in ART scenarios → `art/setup/analysis.ts` (~450–750; **verify numeric equivalence per variant — a different normalization silently shifts a threshold**; pins are unaffected since they hash sources, not scenario tests).

### 15. Workflow YAML composite — 450–750

Composite `setup-workspace` action for the ~20 re-declared setup blocks + merge the flake-purge twins. Do the twins first (dispatch-only, zero gate risk, ~170 lines). The composite touches the required-gate spine: **required check names must not move**, cache-path variance must be diffed per job, and per the CI-walltime standard anything with >2 min impact needs owner OK. Lowest LoC-per-risk on the list — do it opportunistically, not as a campaign pillar.

### 18. Canvas.svelte internal dedup — 250–450

Loader table + test-hook publish helper. **Keep debug-global names byte-compatible — e2e polls them.**

### 19. DECISION POINT: AutoCard def-driven renderer — +5,000–8,000 beyond #5+#6

The mechanism is sound (card-map already supports fallback resolution; defs already carry everything the controls re-type; descriptors can live outside the attest basis and outside contract-lock — all verified) and it is the only path that meaningfully compounds (new modules get cards for free; migrating = deleting a file). But the consolidated verdict was: **do not commit to it yet.**

**The decision criteria, verbatim:** *"Decide after #5/#6 land on ~50 cards: if the residual per-card mass is still large and the descriptor sketch validates on 3 representative cards, the incremental +5,000–8,000 (plus ~120 file deletions) is worth it, starting with the 49 tiny cards."* **144 cards landed and the decision was never taken.**

The disqualifiers to weigh against it: two-thirds of the estimate rests on one sample file per size tier; it double-counts #5/#6; **the huge tier (28,560 lines) barely benefits**; the descriptor language can eat its own savings; **1,026 load-bearing testids must pass through verbatim**; and unlike everything else here it converts VRT from a zero-diff proof into a re-baseline bill for every migrated card.

⚠ **Re-score that VRT bill before taking the go/no-go.** The original scoring assumed a per-card re-baseline **on two platforms**. There is now **ONE baseline set**, authored by linux CI — which materially **lowers** AutoCard's cost.

### 20 + 21. Parked / deferred

**VFPGA bitstream/census (962) — OWNER CALL, never made:** production-dead (verified: only test importers) but adversarially built as a deliberate future seam, and it costs a WebGL re-attest, so if approved it should ride a row-9 batch. **Sequencer transport core (1,000–1,800):** real duplication (verified pairwise 26–38 % identical lines) but it collides head-on with the seq-clock worklet migration (PR-B #969 / planned PR-C) and reopens the just-stabilized behavioral lane; do it *as part of* PR-C's per-module rewiring or not at all.

---

## The proof discipline (this is what made the shipped waves safe)

- **Rows 5 and 6 are zero-pixel changes**, so *"the affected VRT rows must diff
  ZERO — the suite is the regression proof and no baselines are re-generated.
  Any diff = a bug in the conversion, not a re-baseline event."*
- Empty `contract-lock` diff for row 8; `.sha`-only ART diffs for row 12;
  `REPEAT=3` on every changed spec. **Any deviation is a conversion bug to fix,
  never a baseline to accept.**
- **Record the deleting SHA in the PR body as the regeneration pointer** for any
  deleted tool or harness.
- **Coverage optics will look worse while reality improves** — unit-test count
  drops sharply in the deletion waves. The replacement coverage (golden + sweeps
  + errorWatch-everywhere) is strictly stronger; *"say so in each PR body so
  future agents don't 'restore' the deleted smokes."*
- **Owner review load is the real currency.** The remaining waves are
  100–400-file diffs of individually trivial hunks; per-batch VRT runs must be
  *examined, not rubber-stamped* even when the expectation is zero diff.
- **Gate-churn tolls, paid deliberately:** one ART re-pin wave (row 12), ~3
  WebGL re-attests (rows 9/17/20, after unblocking). Batch each so the toll is
  paid once per wave, keep ≤2 PRs in flight, and run
  `task pr:conflict-sweep` after each merge — several waves touch the
  hand-maintained conflict files.
