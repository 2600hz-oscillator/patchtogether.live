# FACE RE-DO — the 18 shipped faces against the CORRECTED platform · THE INDEX

**SPEC AND MOCKUP ONLY. Nothing here is implemented; no module def, card, test or source file is
touched.** The owner reviews this and the gallery before any building starts.

- **Mockup gallery (one self-contained file):** `.myrobots/mockups/face-redo-gallery.html`
- **Per-module specs:** `.myrobots/plans/face-redo-<module>.md` — eighteen files
- **Designed against:** the PF-20 faceplate platform on `feat/faceplate-platform-v2`
  (**PR #1301, NOT yet merged**) **with the owner's two corrections applied** (§1).
- **Quality bar:** `.myrobots/plans/dx7-and-faces-design-program-2026-07-27.md` (§7 "THE RECIPE").
- **Format:** `.myrobots/plans/face-specs-batch-3-*.md` (PR #1304).
- **Defect checklist read as "what not to repeat":**
  `.myrobots/plans/face-specs-round-2-2026-08-01.md` and its 71 defects.

---

## 1. THE TWO CORRECTIONS, AND WHAT THEY ACTUALLY CHANGED

### Correction 1 — the readout row is a FULL-WIDTH STRIP BELOW the hero graphic

As shipped on #1301 the readouts are a `<dl class="hero-readouts">` inside `.hero-side`, i.e. a
column beside the hero control. Corrected: the graphic is full width and the labelled values are
their own bordered row spanning the editor, above band 1.

**It is not a cosmetic move, and three specs changed because of it:**

- **kickdrum** must DROP `settles to` (`{ paramId: 'tune' }`). Inline beside the TUNE dial it read
  as a caption; in a wide strip under the graph it reads as *a second, independent measurement that
  happens to agree*. One number, one place.
- **tidyVco** and **delay** carry **zero** `paramId` readouts for the same reason: PF-20's
  `persistentReadout` already prints every dock dial's value under it, so a `paramId` entry beside a
  dial is literally the same string twice.
- **sixstrum** is the only face with TWO readout surfaces (the strip and a sidebar `readouts`
  block), and the correction forces a rule that did not previously need stating: **the strip is what
  you read WHILE PLAYING; the sidebar block is REFERENCE.** A strip entry must change under the
  hand.

**adsr is the module that makes the correction obviously right:** it declares no `cell`, no
`control` and no `action`, so under the shipped layout its three readouts render as a dangling list
floating to the right of a 214 px graph on an ~85 %-empty faceplate.

### Correction 2 — band prose is ANNOTATION, hidden by default

`ModuleFacePage.hint` paints only in annotate mode (`$lib/ui/annotate-mode.svelte.ts` — per-node,
personal, deliberately not synced to Yjs). The prose stays authored on the def; every spec below
writes all of its hints in full.

**Every spec had to answer: does this face read correctly with every hint hidden?** The discipline
the answers converged on:

1. **Do NOT compensate in the band LABEL.** A label is a name. adsr is the clearest case — its face
   passes the test *only because the param labels get spelled out* (`Attack`/`Decay`/`Sustain`/
   `Release`, not `A/D/S/R`). With initials, the hidden band label would have been the only thing
   expanding them, which is the smuggling failure exactly.
2. **Move a load-bearing fact to a surface that always paints.** Three worked examples:
   - sixstrum's *"MATERIAL below ~0.10 pins the ring at 0.78 s whatever RING says"* → the
     `rings for` derived readout. Hold RING at 10 s, turn MATERIAL to 0, and the printed number
     collapses to 0.775 s while the dial still says 10. **The sentence, made observable instead of
     asserted** — this is the single best argument that the correction is an improvement.
   - ringback's *"SIZE ÷ RATE is one lap"* → the `lap` readout; *"the dry never enters the ring"* →
     a `parallel` branch in the signal-flow block.
   - kickdrum's `dynamics` chain order → the two PF-9 **cluster** labels (clusters are not hints and
     still paint) plus the flow block's tail stage.
3. **When a fact genuinely does not survive, that is a finding, not a naming problem.** sixstrum's
   band 5 hint (*"two of its four stages never run"*) has nowhere to go — and the honest response is
   the DSP fix it is pointing at, not a relabelled knob.

---

## 2. THE EIGHTEEN — verdicts

| module | verdict | the one-line proposal |
|---|---|---|
| **adsr** | REWORK (declaration-only) | An ~85 %-empty faceplate that never says *gate, not trigger*. Strip = `note 405 ms · gate to sustain 105 ms · from a trigger 2.5 ms high`; a 5-shape preset roster that **hand-negative-controls the strip on the shipped surface**. No hero picture — the `envelope` glyph already is one. |
| **karplus** | REWORK | The audition DOES reach the shell (checked, unlike sixstrum). Hero = a **PARTIAL LADDER** — the four knobs a time-domain scope structurally cannot show. Strip = ring · damping · exciter, all derived. |
| **tomtom** | REWORK (small version) | Takes the drum grammar's DATA half (title, bands, strip, flow, presets) and declines its CODE half. 4 bands → 2. `ring` is honestly `paramId: 'decay'` — the kickdrum trap **does not reproduce** here and the spec says so. |
| **snaredrum** | REWORK (structural) | Does **not** mirror kickdrum: `hero.action` takes ONE key and this module has TWO auditions. HIT to the hero, ROLL down into the roll band — which fixes a defect the shipped face had on day one. Hero = a ROLL GRID over the wire-bed envelope. |
| **reverb** | REWORK (small) | `diffusion` **rejected out of the wave** (a Faust rebuild + ART re-pin never belongs in a face PR). RT60 survives as a derived readout **per band, not as one broadband scalar** — and the spec refuses to invent the scalar. |
| **shimmershine** | REWORK | 3 declaration-order bands → ONE honest `tank`. ⚠ **Read its §9 first:** the headline "crystalline drone" is a pure DC rail and the shipped default already crosses the boundary. |
| **qbrt** | REWORK | Two instruments sharing four knobs, and **the second is unreachable from every surface in the repo**. Adds the PING audition + a ring/peak strip. Round-2's BLOCKER on this module was false. |
| **cloudseed** | REWORK (additive only) | The 47-key ranking and the tab rail are right. The hero rail is **the only part of the faceplate on screen at all times**, so three of four strip entries print values that live on tabs you cannot see. Rejects the platform `presets` block, three ways. |
| **filter** | REWORK (strictly additive) | Three derived readouts, none of them a knob on the panel; the magnitude curve goes in the **SIDEBAR**, because a `hero.cell` on a 5-param module lands at rank 6 and fails the lint outright. |
| **mixer** | REWORK (short) | A plain uncompensated sum: four unity channels leave at **+12.04 dB**, and the panel has never shown it. 2 pages → 1, because promoting `master` **empties** the `bus` band. |
| **dx7** | REWORK (structural) | The operator map becomes the hero picture — which **deletes a duplicate diagram the dock paints twice today**. 4 pages → 3. Strip constrained by a real platform limit: readouts read params only, so `node.data.voice` is unreachable. |
| **delay** | MECHANICAL ONLY | Control surface untouched. **PF-11 already landed**, so the ART `.sha` the design program flagged as blocking costs zero. Strip = tail · build-up · floor. |
| **lfo** | MECHANICAL ONLY | Already *is* the program's BATCH B entry, better argued. **No strip and no sidebar, both by argument:** every derived candidate is a single-input alias, and a `hero.cell` would suppress a `waveform` glyph that never flatlines. |
| **ringback** | MECHANICAL ONLY | The one face whose ranges already live in ONE model module. Gains the best-earned strip in the batch: the FEEDBACK dial's `6 LAPS` is the kickdrum trap **already shipped on this module's own dial**. |
| **tidyVco** | MECHANICAL ONLY | Not a VCO — the rack's one complete subtractive VOICE, silent until gated. Gains the whole PF-20 surface + the HOLD audition in the hero. **PF-0 is NOT live** — fixed 2026-07-27. |
| **vca** | MECHANICAL ONLY | **Keep it in `STRICT_FACES`** (§6). No hero picture: every candidate graph is a straight line whose two degrees of freedom are the two dials under it. Strip = 2 entries, and the spec names the two it refused to pad with. |
| **kickdrum** | IN FLIGHT — delta only | Being built on #1301. Delta: drop `settles to`, add a derived `starts at` (the function already exists), and confirm the five hidden hints survive — four of five do, via the sidebar. |
| **sixstrum** | IN FLIGHT — delta only | Spec'd in #1304. Delta: the strip-vs-sidebar rule, `note: '14 params'` on the preset rows, and the observation that its most important fact was already in `face.hint` — which correction 2 makes the load-bearing decision of that spec. |

**11 real rework · 5 mechanical only · 2 in flight · 0 drops.**

---

## 3. THREE PLATFORM FINDINGS — the in-flight platform PR should absorb these

Each was found independently while designing against the platform, each is small, and **each is
invisible until a second module adopts PF-20** — which is exactly the class this whole re-do exists
to surface.

### 3.1 On a TABBED face, an annotation hint can never paint — so cloudseed's prose is dead

`ModuleShell` suppresses the band label **and** its hint on a tabbed face (the rail already names
the band). Under correction 2 the hint has nowhere left to go: **cloudseed's eight authored hints
would paint nowhere, even with annotate mode ON.** cloudseed is the only tabbed face in the repo and
the one that most needs teaching.

**Recommendation:** in annotate mode, paint the ACTIVE band's hint between the tab rail and the
band. Also widen `module-face-lint`'s existing *"no page hint on a TABBED face (it could never
render)"* clause, which under the correction becomes wrong in the opposite direction.

### 3.2 `heroFacePlan` drops an emptied CLUSTER but not an emptied BAND

`withoutKeys` filters `clusters` down and drops the empty ones — deliberately, *"a sub-header over
zero cells is a caption for nothing"* — but the band loop has no equivalent guard, and
`ModuleShell` renders a band's `<section>` + `<h4 class="page-label">` unconditionally while
guarding only the control row. **Promoting a whole band's contents into the hero therefore renders a
labelled void.**

**dx7 and mixer hit this independently.** mixer's spec turns it into a design decision (2 pages → 1,
because `master` is the `bus` band's only member); dx7's does the same with its `patch` band. Both
would be simpler if the platform dropped an emptied band the way it already drops an emptied
cluster.

### 3.3 No module with ≤ 6 controls can ever declare a hero picture

`module-face-lint` refuses a `panel` cell SELECTED at a lane tier and `faceTierCap('full')` is 6, so
a panel's first legal rank is **7** — on every face, always. A 4-param module's 5th key is always
selected, so the constraint is not "rank it 7th", it is **"you cannot have one"**.

**adsr, filter and qbrt all hit it.** In all three cases the right answer turned out to be a
`custom` SIDEBAR panel instead (zero contract lines, no operability probe, a 288 px column) — so
this is not blocking. **The one-line fix is to make lane selection kind-aware in `curatedFace`**, and
it is worth doing before a fourth spec re-derives the same wall.

---

## 4. THE DEFECT LEDGER — shipped-code bugs found while reading

**None of these is spec content. Every one is its own follow-up PR**, and the DSP ones are
owner-audition PRs. Ranked by how much they hurt.

| # | module | defect | why nothing caught it |
|---|---|---|---|
| 1 | **shimmershine** | **[P0] The "crystalline drone" is a pure DC rail.** Past the regeneration boundary the sustained state is 100 % DC — 0 Hz at −0.2 dB, every other bin −311…−323 dB. No DC blocker exists anywhere in the loop and the damping one-pole has unity DC gain, so DAMP cannot touch it. **The shipped default `shimmer = 0.4` is already past the boundary (0.388).** | the ART scenario pins a rate, not a spectrum, and nothing asserts AC content |
| 2 | **cloudseed** | **[P1] The worklet re-seeds the entire reverb every 128-sample block.** `setParameter` has no dedupe and the processor pushes all 7 macros unconditionally, so `EqCrossSeed` re-runs the seed/line/post-diffusion rebuild ≈ 2.6 M BigInt LCG iterations/s **on the audio thread while idle**. A comment claims the opposite. The fix is sound-transparent. | no perf assertion on the worklet; the false comment reads as a guarantee |
| 3 | **vca** | **`si.smoo` is applied to the SUM, so it lowpasses the CV as well as the knob.** τ = 22.66 ms, −3 dB at 7.02 Hz, sample-rate invariant. Simulated: **a 1 ms and a 5 ms ADSR attack produce an identical 49.79 ms rise** — the VCA is bit-for-bit blind to any attack under ~20 ms. No percussive envelope survives it. | the ART profile's windows are 0.05–0.45 s and 0.7–1.0 s — the slew is **structurally outside every assertion** |
| 4 | **tomtom** | **`strike` can persist stuck at 1 in the Y.Doc**, and because the worklet ORs *levels* not edges that **permanently masks `trigger_in`** — an external sequencer stops striking the drum, and it survives save/reload. | the sibling audition seam has `ensurePanicListeners()`; the press-param path has nothing, and a shell comment asserts the opposite |
| 5 | **adsr** | **The ART lane is green about a different synth.** `art/scenarios/adsr/profile.test.ts` profiles `adsr-env.ts` — exponential, time-constant — while the module is Faust `en.adsr`, linear, exact-duration. Its `expect(buf[last]).toBeGreaterThan(0)` at gate-off + 2× release would **FAIL** against the real module. | the profile never touches the real module |
| 6 | **ringback** | **Both `out_l` and `out_r` map to output 0** of an `outputChannelCount:[2]` worklet, with no splitter — so patching L and R into two mono destinations collapses to `(L+R)/2` at both. Inherited from twotracks. | a mono source gives L === R, and the ART profile renders one channel by design |
| 7 | **filter** | **`FilterCard`'s `t.params.mode = m` is a raw origin-less write, so MODE is not undoable** while cutoff and res are. `mutate.guard.test.ts`'s `RAW_PARAM_WRITE` check is bracket-only — **the guard and its self-test are blind in the same direction.** | see left — a guard blind in the same direction as the bug |
| 8 | **lfo** | **`LfoCard` never passes `formatValue={p.format}`**, so the legacy card prints `0.50` for DEPTH where the dock prints `±1.00` — **at the shipped default, with no knob moved.** RATE diverges at the low end too. | the card is not in `RANGE_BOUND_CARDS`, and the private duplicate guard inside `lfo-face-model.test.ts` predates the format clause |
| 9 | **snaredrum** | **`accent_in`'s velocity term is inert on every PRIMARY stroke** — `clamp(1·(1+0.5·acc),0,1) ≡ 1` — so a sequencer velocity lane into `trigger_in` yields no dynamics at all. | nothing asserts a level difference between two accents |
| 10 | **karplus** | **`docs.controls.stiffness` claims "a perfectly harmonic string"** — modelled, partial 8 is **+114 ¢ sharp** at BRIGHT 0 and −13 ¢ flat at the default. | the sonic-range test never checks the STIFF = 0 baseline |
| 11 | **mixer** | **`docs.explanation` tells users to watch the level meter to see the sum clip. It cannot** — three separate clamps on the way to the pixel, and a 43 ms RMS is not a peak detector, so 0 dBFS and +12 dBFS paint an identical full meter. | no test asserts the meter distinguishes them |
| 12 | **qbrt** | **`ping` declares no `edge:`**, and `module-docs-lint`'s `if (!p.edge) continue` makes a **missing** declaration structurally invisible — the vocabulary gate is skipped on exactly the ports whose prose is unchecked. | see left |
| 13 | **reverb** | **DAMP's tone is sample-rate dependent** while the tank's timing is SR-adapted — the same rack is brighter at 96 kHz. | no cross-rate assertion anywhere |
| 14 | **shimmershine** | At `damp === 1`, `fbStore = fbStore` freezes at its **live** value, not zero: a persistent, arbitrary-signed DC residue that does not clear when DAMP returns. Two shipped comments claim "freezes at zero" — true only from a cold spawn. | the tests spawn cold |
| 15 | **cloudseed** | Three MOD AMT dials print `round(s×100)+'%'` on a ×2.5-**millisecond** value — full travel prints `250%`. | the dock VRT scene captures only the ACTIVE tab, so 41 of 46 controls are pixel-invisible |
| 16 | **cloudseed** | Early-diffusion modulation is gated `> 0.5` on a *ms* value while its sibling uses `> 0` on *samples*, so MOD AMT is **dead below ~20 %**, including at both defaults. | as above |
| 17 | **dx7** | The dock renders the topology **twice** from the same geometry — a 64 px glyph and a 280 px map. | nothing counts diagrams |
| 18 | **karplus** | BRIGHT's top travel is **dead above ~1 kHz** (the `0.45·sr` cap): at A6, B > 0.567 does nothing at 48 kHz. The docs say the knob "means the same thing at every pitch". | no per-pitch sweep |
| 19 | **filter** | The `mode` option tooltips claim **12 dB/oct for HP and BP** — both wrong; the same def states the correct 6 dB/oct thirty lines later. | tooltips are not gated |
| 20 | **lfo** | `module-manifest.ts` publishes *"External clock — locks LFO rate to incoming pulses"* on the public docs site. **It does not lock the rate** — it re-zeroes phase. Contradicted by the worklet, the def header and the def's own authored `docs.inputs.clock`. | `PORT_NOTES` is not cross-checked against authored docs |
| 21 | **tidyVco** | The `oct2` lane-plate readout overflow the def comment reports is **still live** — 42 px rows, `overflow:hidden`, an unconditional 9 px readout. | the `full` lane tier has **no VRT scene at all** |
| 22 | **karplus** | The dock PLUCK's press animation fires **even when nothing was plucked** — the shell discards `fireManualStrike`'s boolean, which the legacy card honours. | faces-parity's `action` branch asserts `toBeEnabled()` then clicks, and asserts **no effect** |
| 23 | **lfo** | The MORPH law has **three independent implementations** and no cross-check, sitting beside a DEPTH law that has one and is rigorously cross-gated. | see left |
| 24 | **reverb** | `reverb.dsp`'s `spread = 0.5` is a **no-op** — truncated by the integer delay index. (This makes the design program's `room`/`spread` rejection *stronger* than it was argued.) | nothing asserts it does anything |
| 25 | **snaredrum** | The wire bed pans to the **wrong side** during a roll (sign traced; documented as known, still live). | documented, not tested |
| 26 | **adsr** | The `face.order` rank-1 comment's arithmetic is wrong: `fireTrigger` is a triangle above `GATE_HI` for only 2.5 ms and `en.adsr` resets on every rising sample, so CLOCK → ADSR gives a **quarter-height** envelope, not a full one. The conclusion (release outranks attack) survives and is strengthened. | comments are not gated |
| 27 | **cloudseed** | Two docs figures say ~30 s / "near 60 s" for INFINITE PAD's tail. It is **42.5 s**. | — |
| 28 | **qbrt** | `docs.inputs.ping` overstates the click decay ~7× (1.03 ms is τ, not the length); `qbrt.dsp`'s `declare description` is wrong twice and ships in `qbrt.json`. | — |
| 29 | **dx7** | `topologyLabel` prints a bare `5` where the picker chip reads `ALGORITHM 05` — `algorithm` declares no `format`/`options`. | — |
| 30 | **delay** | `docs.controls.time`'s "smooth swoop" understates a 0.25 → 1.5 s jump, which starts at `dt/dτ = 125` — the read head runs **backward at ~124×**. *(Inference from the `setTargetAtTime` law, labelled as such.)* | the 498 Hz varispeed probe has **no artifact in the tree** and is not ART-reproducible |
| 31 | **filter** | The rear card prints `AUDIO` on **both** jacks (no label override passed). | — |
| 32 | **tidyVco** | A DSP comment says "frozen 23-param contract" over a **25**-row `PARAM_TABLE`. | — |
| 33 | **vca** | An ART comment states *"a VCA attenuates, never boosts"* — contradicted by the def, whose gain is unclamped. | — |
| 34 | **—** | **Range/label re-typing in cards, still.** qbrt (12 numbers + **positional** param indexing), reverb (18 def facts), filter (ranges + positional indexing + a second `MODES` vocabulary), adsr (labels — and `card-range-source.test.ts` has range/mapping/format clauses but **no label clause**), karplus (converted to `paramSpec` but never enrolled in the guard lists). All currently AGREE → hazards, not live bugs — except adsr's labels, which already diverge. | the guard is opt-in by file list |
| 35 | **sixstrum** *(carried from #1304, counted once)* | The shipped face **cannot play the instrument** (the strum audition never reached `SHELL_CELLS`, and two repo comments assert it did); the **BASS preset collapses three of six strings** onto one pitch; `ENV DECAY` and `RELEASE` are inert at the shipped defaults; `tuning` writes **14 params while advertising one**. | — |

**35 ledger rows across 17 modules**, of which 4 are P0/P1-class audio or state bugs (#1–#4), 12
are wrong statements a user reads as truth, and the rest are hazards and dead controls.

### Two meta-findings worth more than any single row

- **A gate blind in the same direction as the bug it guards.** filter's undo hole (#7), lfo's format
  divergence (#8) and qbrt's missing `edge` (#12) are all this shape: `RAW_PARAM_WRITE` is
  bracket-only, `RANGE_BOUND_CARDS` is opt-in by filename, and `if (!p.edge) continue` skips exactly
  the ports nobody declared. **Each gate is green because it cannot see the case.**
- **The `action` cell has no probe.** `faces-parity`'s `action` branch asserts `toBeEnabled()` then
  clicks — **it asserts no effect.** A dead audition passes the whole face green. That is the
  revision-only-probe pathology `shell-cells.ts` outlaws for PANEL cells, on a kind that has no
  probe at all. It is why karplus #22 survived and why every audition spec in this batch carries a
  before/after negative control by hand. **Follow-up, its own PR: give `ShellActionCell` an optional
  `probe` mirroring `ShellPanelProbe`.**

---

## 5. COST — the honest arithmetic

| lane | delta across all 18 | gating? |
|---|---|---|
| **contract-lock** | **+2 lines total** — `qbrt family qbrt-ping` and `snaredrum family snaredrum-hero`; plus **1 MODIFIED** line (qbrt's `ping … edge=trigger`, which is a modification, not an addition — round 2 double-counted it). Sixteen of eighteen cost **zero**: `face` is UI metadata and `contract-signature.ts` has no `face` branch. | unit |
| **ART** | **NIL.** PF-11 has already landed, so a face edit on a source-SHA-pinned def is free and `pattern3-face-pin.test.ts` keeps it that way. No `.f32`, no `.sha`, no fingerprint-manifest movement. *(The design program's "PF-11 FIRST … even a pure face edit moves the `.sha`" is stale.)* | art |
| **attest** | **NIL** — verified per module against the bases, not assumed. All eighteen are AUDIO defs; none of the touched shell files is in the collab or grand basis. | — |
| **faces-parity (REQUIRED)** | **+2 cells total** (qbrt's ping action, karplus's panel). A hero PROMOTES a key; it never adds one, so a hero costs **zero** cells. At the measured ~0.8 s/cell on the SwiftShader runner: **≈ +1.6 s**. | **yes** |
| **new bespoke e2e** | one audition spec (qbrt, ≈ +13 s) and one panel spec (snaredrum, ≈ +2 s). | **yes** |
| **`vrt-strict` (REQUIRED)** | **+0 scenes** — `workflow-shell-faces.spec.ts` is in the informational lane (`VRT_STRICT=1` narrows `testMatch` to `vrt.spec.ts`). But **eight of the eighteen are in `STRICT_VRT_MODULES`** (adsr, dx7, filter, mixer, qbrt, reverb, shimmershine, vca), so any LEGACY-CARD edit re-captures a REQUIRED baseline on both platforms. **Only qbrt needs one** — the PING button the docs gate greps for. | **yes, for qbrt** |
| **`vrt` (informational)** | 18 dock baselines move; several compact ones must **NOT**. | no |
| **total CI wall-time** | **≈ +20 s of gating time for the whole batch.** Comfortably under the 2-minute sign-off bar — **and it must still be confirmed ON CI**, because the runner is SwiftShader at roughly 4× the local per-cell cost. | — |

### VRT — the three traps this batch actually contains

1. **Sub-tolerance staleness.** reverb, shimmershine and filter all change the dock face by less than
   `DOCK_MAX_DIFF` in at least one scene, so `--update-snapshots` writes **nothing**.
   **`git rm` the baseline first.** filter is the module where this trap was originally set (865 px
   under a 1500 px tolerance, zero files committed, twice).
2. **Dimension changes.** ringback, tidyVco and cloudseed's dock faces change SIZE, and Playwright
   hard-fails on dimensions before it computes a ratio — no tolerance argument applies.
3. **Ratchets that now assert in BOTH directions.** `SHARED_LINUX_PAIR_CEILING` and
   `LINUX_DEFICIT_CEILING` both fail on slack as well as growth, so a drain that forgets to lower
   the number is now red rather than silent. Round 2's "the ratchet is invisible to CI" is stale.

### Sequencing

**Ship in batches of three or four, not one PR of eighteen.** Each batch is then one
`vrt-update.yml` dispatch, one ratchet decrement, and a differenceable `Run VRT` step — which turns
the wall-time estimate above into a measurement by the second PR.

**Suggested first batch: the five MECHANICAL-ONLY faces** (delay, lfo, ringback, tidyVco, vca).
They are declaration-only, they touch no ranking, and they prove the corrected platform on five real
faces before any rework lands.

---

## 6. WHAT SHOULD BE DROPPED FROM `STRICT_FACES`

**Nothing.** The question was asked of the two candidates and both come back keeps:

- **vca** (2 params) — `STRICT_FACES` **is** the migration switch (`migrated()` reads it), so
  dropping it un-migrates the module to a placeholder tile, and `vca-gain-model.test.ts` already
  fails with *"it was un-migrated"*. Unlike `noise` — which the batch-3 pass correctly recommended
  against on merit — vca's tiers do **not** collapse: mini shows 1 cell and compact/full/dock show
  2, so `order` decides a real thing. Its band label already *is* the gain law and its two
  persistent readouts do real vocabulary work.
- **qbrt** (4 params) — the opposite of a drop candidate. It is the module in the set whose face is
  furthest from what the module actually is.

**One thing worth the owner's decision instead of a drop:** *snaredrum's* hero + strip push the dock
face's existing 282 px overflow to ~550–600 px, so **the pixel gate covers LESS of that face after
the rework than before**. That is a real coverage regression traded for a real design win, and it
should be an explicit choice rather than a side effect.

---

## 7. THE RULES THESE EIGHTEEN WERE WRITTEN UNDER

1. **A derived readout must name the perturbation that distinguishes it from a knob readback** —
   and, where possible, a second leg that must **not** move. Several specs refused a readout on this
   basis (lfo's three single-input aliases; tomtom's `ring`, where the trap measurably does not
   reproduce; qbrt's ring *frequency*, which is `cutoff` wearing a formula; karplus's clamped pitch,
   which is mathematically unreachable). **Refusing is the right answer more often than inventing.**
2. **A control's range comes from ONE place: the def, imported by the card, never re-typed.**
3. **A bespoke visualiser cell is legitimate; a bespoke title, hint, sidebar or readout mechanism is
   not.** Four faces take a picture (dx7, karplus, snaredrum, kickdrum); fourteen do not, and each
   of the fourteen says why.
4. **`hero.cell` SUPPRESSES the dock glyph.** On dx7 that is the point. On nine others it would be a
   downgrade — a live picture traded for a static one.
5. **Never fold a DSP change into a face wave.** Every entry in §4 is its own PR.
6. **Where an agent inferred rather than read, the spec says so.**
