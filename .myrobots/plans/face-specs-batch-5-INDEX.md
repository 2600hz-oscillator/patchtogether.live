# FACE SPECS — BATCH 5 · the index

## 0. STATUS — AUTHORED 2026-08-10, VERIFIED AGAINST `main`

**Every claim in these twelve files was measured or read against `main` at
`153e5c36`, not against an earlier spec.** Batch 3's index needed exactly that
correction three days after it landed and batch 4 wrote the rule in; this batch
keeps it, and §2 shows why it matters — **one batch-4 rejection is overturned
here on a re-read of the code.**

**Nothing here is implemented. No def, card, DSP file or test is touched by this
PR** — it is twelve documents plus this index plus one HTML review page in
`.myrobots/plans/`, so it consumes no faceplate PR slot. The working tree diff is
**14 files, 0 source files**; `flox activate -- task typecheck` is unchanged.

⚠ **This PR is docs-only**, so `ci.yml` path-skips it and
`.github/workflows/docs-only-gate.yml` posts the two required contexts. That
bypass fires only when **every** changed file is a doc — do not add a source file
to this branch. (`.html` is **not** in the `paths-ignore` list; the review page
lives under `.myrobots/**`, which is, so the bypass still holds. Verify before
pushing anything else.)

**Ground truth used for "unfaced":** `STRICT_FACES`
(`packages/web/src/lib/ui/workflow/strict-faces.ts`) plus whether the def
declares a `face`. As of `153e5c36` that is **25 faced** of **121 audio modules**;
the 96 unfaced audio modules were enumerated from `contract-lock.txt` before
choosing. The 21 already-specced modules (batches 3–4 plus the two 2026-08-09
one-offs) were excluded first.

**The review page** the owner reads is
`.myrobots/plans/face-specs-batch-5-review.html` — self-contained, theme-aware,
no external requests.

---

## 1. THE TWELVE, AND WHAT I PROPOSE

| module | family | verdict | the one-line proposal | headline defect |
|---|---|---|---|---|
| **swolevco** | voice | **PROMOTE** | The two knobs that rank OFF the lane are the two that measure bit-exactly inert at the shipped default — rank *is* the argument. | `ratio ∈ (0, 0.01]` puts up to **+0.574 of DC** on an `audio` jack; the free-run branch is a strict `> 0`. |
| **wavecel** | voice | **PROMOTE** | Five of ten params do nothing until a cable lands, so they rank 7–11 and the dock says why. | **SPREAD at maximum leaves L/R 99.94 % correlated** (side/mid −34.06 dB); RMS reported it as a working control. |
| **hypercube** | voice | **BLOCKED** | Do not face it. `alpha` and `morph_fc` are indistinguishable from no-ops and I cannot yet say whether that is the module or my harness. | **−0.375 DC on both outputs at EVERY setting** — larger than the 0.348 AC signal. |
| **warrensspectrum** | effect / spectral | **PROMOTE — largest** | Two engines behind one panel; seven of sixteen controls belong to only one of them, so `engineMode` is rank 1. | **`spectralBandCount` is bit-exactly inert in the default engine** and worth 10.35 dB in the other. |
| **cofefve** | effect / delay | **PROMOTE — overturns a batch-4 rejection** | Seven of twenty-four controls are asleep; the ranking puts every ENABLER directly above its dependents. | **7 of 24 params `Δ = 0.00e+0` at the factory default**, each gated by an enabler that ships at zero. |
| **destroy** | effect / crusher | **PROMOTE — cheapest** | Three cells, identical at `full` and `dock`; it ships for two numbers. | **`decimate` 1 → 2 is bit-exactly identical** (same 12 698 distinct values, same 275 Hz centroid). |
| **slewSwitch** | utility | **PROMOTE** | Two utilities with no shared state — proven, not asserted — and one exact number. | **`LENGTH = 1` outputs the input × 1.41421 (+3.01 dB)** and bit-silences `step_idx` and `eoc`. |
| **featurecv** | utility / audio→CV | **PROMOTE — blocked on §7-A being ANSWERED** | Four jacks, and the panel currently says nothing true about any of them. | **BRIGHT is bit-identical for a 261 Hz sine and a 261 Hz saw** while separating 261 Hz / 6 kHz / noise cleanly. |
| **ninelives** | utility / LFO | **PROMOTE** | Two knobs, nine jacks, and the entire face is a table of periods the panel cannot show. | **`out9` has a 1 h 49 min period at the default rate** and 65.6 s at the maximum — four of nine outputs are DC over any window. |
| **illogic** | utility / math | **PROMOTE** | Four of ten jacks are behind none of the knobs; the routing picture is the only place that can be said. | **`and`/`or`/`nand`/`not` are `Δ = 0.00e+0` under all four attenuverters**; `diff` peaks at **2.594** on a ±1 bus. |
| **timelorde** | clock / transport | **PROMOTE** | The singleton the whole rack depends on, and its two most important facts are currently unstatable anywhere. | **Every multiplier loses exactly `(multiplier − 1)` pulses at start** — 1 / 3 / 7 on `2x` / `4x` / `8x`, identical at 60, 120 and 240 bpm. |
| **unityscalemathematik** | utility / CV | **NO FACE ON MERIT** | All five controls live, three channels perfectly orthogonal, every tier identical. Nothing a picture adds. | none — and that is the verdict. The durable output is the instrument warning (§6-D). |

**Spread:** 3 voice · 3 effect · 5 utility · 1 clock. Three of the twelve
(`swolevco`, `wavecel`, `hypercube`) also carry a `mono-video`/`video` output, so
the AV bridge is represented without spending a slot on a video-only module.

**Ten PROMOTE, one BLOCKED, one NO-FACE-ON-MERIT.** Batch 4 flagged that it
reached no NO-FACE verdict; this one does, deliberately, and §5 is the
reasoning.

### 1.1 THE ONE THAT IS GENUINELY BLOCKED

**`hypercube` must not be faced until someone runs the direct-processor
harness.** `alpha` and `morph_fc` — the two controls that make it a hypercube
rather than a CUBE — are identical at 0, 0.5 and 1 in rms (8 s.f.), peak
(6 d.p.), spectral centroid (0.1 Hz) and five log-band energies (0.01 dB), while
`fold`, `crush` and `spread` all move. **But the fourth wavetable rides
`port.postMessage`, whose delivery is not guaranteed inside an offline render**,
so "dead control" and "table never arrived" are not yet distinguishable. The
`macrooscillator` route (esbuild the worklet against stub globals, hand the
processor its tables synchronously) settles it in half a day.

**`featurecv` is blocked more softly**: the face is buildable, but the hero
picture labels the BRIGHT jack and §2 of that spec says nobody currently knows
what that jack carries.

---

## 2. WHAT WAS REJECTED, AND WHY — including one batch-4 rejection OVERTURNED

| module | reason |
|---|---|
| **`cofefve`** | ⚠ **BATCH-4 REJECTION OVERTURNED.** Batch 4 deferred it with `charlottesEchos` because "charlottes-echos is **migrating to** `analog-delay-core`". Re-read on `main`: **cofefve IS the replacement** — *"a clean-room, OWN-CODE engine (the replacement for the retired Cocoa Delay; its own DSP, no GPL lineage)"* — with its own 209-line worklet and nothing pending. **Taken.** |
| `charlottesEchos` | Deferral **stands**. Still its own 232-line DSP, still the module the memory has migrating. |
| `mixmstrs` (91 params), `wavesculpt` (90), `moog960` (36), `foxy` (33) | Batch 4's reasoning holds: each is a face *programme*, not a face. |
| `buggles`, `polyseqz`, `sequencer`, `cartesian`, `writeseq`, `numpadPlus`, `macseq`, `score` | ⚠ **A MEASUREMENT limit, not a merit judgement.** Every one is driven by a main-thread `setTimeout`/`setInterval` scheduler that does not advance inside an `OfflineAudioContext`: `buggles` measured **bit-zero on all five outputs at every setting**, which is the harness, not the module. Speccing them to this batch's evidence bar needs a **browser-side** harness. `buggles` was the closest call — a chaotic random source is a player favourite. |
| `scope`, `rasterize`, `spectrograph` | Same scheduler limit plus a video render path. `rasterize`'s mapping math is in a pure module and *could* be measured; its audio path is a passthrough, so the face would be about video params on an audio module — a different design problem, worth its own batch. |
| `wavetableVco`, `stereovca`, `fourplexer`, `gatemaiden`, `sampleHold`, `scaler`, `polarizer`, `depolarizer`, `flipper` | 1–5 params with no mode, no gating and no measured asymmetry. Same shape as `unityscalemathematik` (§5) and `noise`: all tiers identical. Listing them is the judgement. |
| `es9`, `synesthesia`, `chromaconsole`, `clipplayer`, `timelorde`'s neighbours, `kria` | Hardware-, video- or grid-bound; batch 4's reasoning holds. (`timelorde` itself is taken — its clock is a real worklet.) |
| `moog9xx` (23 modules) | A clone family. One shared design or none. |
| `twotracks`, `cube`, `samsloop`, `noise` | Already specced with a standing verdict. |

---

## 3. THE DEFECTS THIS INVESTIGATION FOUND IN SHIPPED CODE

Ranked by how much they hurt. Every one is cited with its measurement in the
per-module spec. **None is fixed here.**

| # | module | defect |
|---|---|---|
| 1 | **hypercube** | **−0.375 DC on both audio outputs at every setting of every control**, scaling to −0.751 at `level = 2`, against an AC signal of 0.348. The `cube`-rebuild fault class, but at the DEFAULT rather than at a knob extreme. |
| 2 | **hypercube** | **`alpha` and `morph_fc` are indistinguishable from no-ops** in every phase-invariant statistic (§1.1). The two controls the module is named for. |
| 3 | **featurecv** | **BRIGHT reads −0.9544 for a 261 Hz sine AND a 261 Hz saw** — four decimals, both polarity modes — while separating 261 Hz / 6 kHz / white noise cleanly. It is tracking pitch, not partials. |
| 4 | **swolevco** | **`ratio ∈ (0, 0.01]` emits up to +0.574 of DC** on `mod_out` (an `audio` jack) and +0.286 on `sum_out`. One ten-thousandth of the dial above `0` drops the modulator ten octaves. |
| 5 | **cofefve** | **7 of 24 params are bit-exactly inert at the factory default** — `lfoFrequency`, `duckAttack`, `duckRelease`, `clockSource`, `panMode`, and effectively `driveMix`/`driveIterations` — each gated by an enabler that ships at zero. |
| 6 | **warrensspectrum** | **`spectralBandCount` is `Δ = 0.00e+0` across all six values in the default engine** (and at bank wet 1), and worth **10.35 dB** in MASSPASS. |
| 7 | **slewSwitch** | **`LENGTH = 1` multiplies the input by exactly √2** (+0.90 in → +1.2728 out, all three modes) — an equal-power crossfade of a source with itself — and bit-silences `step_idx` and `eoc`. |
| 8 | **destroy** | **`decimate` 1, 1.5 and 2 are identical in every statistic** (275 Hz centroid, 12 698 distinct values). The first 1.6 % of the fader is dead. |
| 9 | **wavecel** | **SPREAD at maximum: side/mid −34.06 dB, L/R correlation 0.999429.** The stereo control on a stereo oscillator. |
| 10 | **warrensspectrum** | **`docs.controls.resynthLevel` says turning it up "does not make the module louder".** Measured **+6.26 dB** and peak **1.315**. And the param ID names the *filterbank wet*, not a resynthesis level. |
| 11 | **timelorde** | **Every multiplier output permanently loses `(multiplier − 1)` pulses** — 1 / 3 / 7 — documented in a worklet header and nowhere a user can see. |
| 12 | **illogic** | **`sum` peaks at 1.791 and `diff` at 2.594** from a ≤0.9 stimulus on a ±1 CV bus, unscaled, with no clamp. |
| 13 | **ninelives** | **`shape` is a 3-position selector declared `curve: 'linear'`**; every value between the named positions is **6 dB down in peak**. And the three named shapes differ by **4.77 dB**. |
| 14 | **warrensspectrum** | **`engineFreeze = 1` from spawn is bit-silence** (−240 dB, both windows). A rack saved with FREEZE on boots dead. |
| 15 | **swolevco** | **SYMMETRY peaks at 1.0286 (saw) and 1.0428 (square)** with no output stage, and swings **4.8 dB non-monotonically**. |
| 16 | **cofefve** | **`syncPeriod` is a host-written value** (`setInterval(pushSyncPeriod, 16)`) exposed as a user `ParamDef` with a `0..30 s` range on the card. |
| 17 | **destroy** | **`bits = 1` is −28.3 dB with peak 1.0000** from a 0.5-amplitude input; `bits 1 + decimate 64` is −98.81 dB. |
| 18 | **wavecel** | **2.667 ms (exactly one 128-sample render quantum) of full-scale output** every time a gate cable lands on a silent wavecel. |
| 19 | **warrensspectrum · timelorde · illogic · featurecv · ninelives** | **Five modules with NO audio output at all**, so the shell glyph (`primaryAudioOutPortId`) has nothing to tap. The `noise` white-tap finding, five more times — §4.2. |
| 20 | **eleven of twelve** | **Every card re-types its def's ranges** and **none is in `RANGE_BOUND_CARDS`**. Worst: `cofefve` (34 literal `min=`/`max=` props over 24 params). ⚠ **The two exceptions are `warrensspectrum` and `hypercube`, which re-type ZERO** — and they are not enrolled either, so nothing keeps them clean. |

---

## 4. WHAT THESE TWELVE FOUND ABOUT THE PLATFORM

### 4.1 THE BATCH'S ONE STRUCTURAL DISCOVERY: the MODE-GATED CONTROL is everywhere

Five of the twelve have controls that are **bit-exactly inert in the state the
rack spawns in and fully alive one enabler away**:

| module | gated controls | the enabler | measured when open |
|---|---|---|---|
| `swolevco` | `mod_tune`, `mod_fine` | `ratio = 0` | centroid 33 → 2093 Hz |
| `wavecel` | `base_vol` + all four ADSR | a POLY / TRIG **edge** | full envelope, verified |
| `warrensspectrum` | `spectralBandCount` | `engineMode = 1` | 10.35 dB, 3× centroid |
| `cofefve` | seven, via five enablers | see §3-5 | Δ up to 7.76e-1 |
| `ninelives` | — | — | (the *outputs* are gated instead) |

**Sixteen controls across four modules.** Every one is documented in
`docs.controls`; **none is visible on a panel.** That is the single strongest
argument the batch makes for the faceplate programme, and it produces one
concrete platform ask:

> **A faceplate needs a way to say "this control is currently doing nothing, and
> here is what would wake it."** Today the only surfaces that can carry it are a
> band LABEL, a band HINT (dock-only, and deleted entirely at 7 bands) and a
> sidebar `text` entry. Three of the four specs above spend their sidebar on
> exactly this. **A first-class `enabledBy` on `ParamDef` — or a `FaceReadout`
> that can read connectivity — would replace four bespoke sidebars with one
> platform behaviour.**

### 4.2 FIVE MODULES HAVE NO AUDIO OUTPUT, AND THE GLYPH TAPS THE FIRST ONE

`primaryAudioOutPortId` picks the first `audio` output in declaration order
(`shell-glyph-live.ts:96`). **`warrensspectrum` has exactly one (fine).
`timelorde`, `illogic`, `featurecv` and `ninelives` have NONE** — thirteen gates,
ten cv/gate, four cv/gate and nine cv respectively. A `scope`/`meter` glyph on
any of them taps nothing and paints a black rectangle.

Batch 4 found this twice (`attenumix`, `drumseqz`) and asked for a declared
glyph source. **This batch found it four more times in twelve modules**, which
makes it the most common face-blocking platform gap in the unfaced tail. Two of
these specs work around it (`ninelives` uses the param-derived `'waveform'`
glyph; `timelorde` declares `'none'`), and both workarounds are strictly worse
than a declared source.

### 4.3 THE RANK-7 WALL, QUANTIFIED ACROSS TWELVE MODULES

A `panel`'s first legal rank is **7** (`module-face-lint` refuses a panel selected
at a lane tier; `faceTierCap('full') = 6`). Sorting the batch by key count:

| can reach rank 7 → real `hero.cell` | cannot → sidebar `custom` only |
|---|---|
| `swolevco` (8 keys), `wavecel` (14), `warrensspectrum` (16), `cofefve` (24), `slewSwitch` (7), `timelorde` (6+1), `featurecv` (6+1), `hypercube` (20) | **`destroy` (3), `illogic` (4), `ninelives` (2), `unityscalemathematik` (5)** |

**Four of twelve cannot have a hero picture at all**, and three of those four are
modules whose *entire* face value is a picture (`ninelives`'s rate ladder,
`illogic`'s routing map, `destroy`'s quantisation grid). The meowbox workaround
(sidebar `custom`) covers it, and it is now the majority pattern for small
modules rather than the exception. **Worth reflecting in the `ModuleFaceHero`
doc**: "a picture on a module with fewer than 7 controls goes in the sidebar" is
the rule, not the escape hatch.

### 4.4 THREE MORE FREE-RUNNING FACES, AND ONE THAT MAY BREAK THE FREEZE

`analogVco` and `macrooscillator` are currently the only free-running modules
holding a face, and they are the only roster coverage for #1420's pre-frame
`AudioContext` freeze. **`swolevco`, `wavecel`, `ninelives` and `timelorde` all
free-run**, so promoting them multiplies that coverage by three.

⚠ **`hypercube` would be the first face whose module is NOT DETERMINISTIC at
all** — `max|run1 − run2| = 8.453e-1` on identical params, against `0.000e+0` for
every other module measured in this batch. The freeze stops the graph before the
frame, so the analyser *should* read zeros regardless — **but that must be
derived (10 separate processes, unmasked), never assumed.** Another reason
`hypercube` is blocked.

### 4.5 A GENERIC SIDEBAR PANEL WAS DISCOVERED TWICE INDEPENDENTLY

`ninelives` and `timelorde` both want the same picture — **a divider ladder**:
N rungs, each labelled with its period, at a fixed ratio. Different props
(`divisor: 3, taps: 9` vs `divisor: 2, taps: 13`), same drawing. Registered once
as `rate-ladder` in `sidebar-panels.ts` it serves both, plus every `moog9xx`
divider in the tail. **That is the `custom`-block contract working as designed,
and it is the first time two modules in one batch converged on one panel
without being asked to.**

---

## 5. WHY ONE MODULE GOT "NO FACE ON MERIT"

`unityscalemathematik`: five controls, all live; three channels, verified
**bit-exactly orthogonal** (every off-diagonal `Δ = 0.00e+0`); both curves
monotonic and identical; every attenuverter bit-silent at 0 and symmetric.
`faceTierCap('full') = 6` against 5 params, so `compact`, `full` and `dock`
render the identical five cells. The one asymmetry (UNITY has no CURVE) is
visible by counting knobs.

**Cost avoided: 4 VRT baselines, a 5-cell `faces-parity` row, and a
`STRICT_FACES` entry to maintain forever.** The `noise` precedent says that is a
real saving. The durable output of the file is §6-D below.

---

## 6. THE INSTRUMENT WAS WRONG FOUR TIMES, AND EVERY WRONG ANSWER LOOKED AUTHORITATIVE

The CLAUDE.md **VALIDATE THE INSTRUMENT** rule, earned four more times. Each is
recorded in its own spec, because the shapes recur.

| # | module | what the bad instrument said | why it was wrong |
|---|---|---|---|
| **A** | **wavecel** | "the whole ADSR and BASE are dead — `Δ = 0.00e+0` on three outputs at every value" | The factory reads **`livePatch.edges`**, not bus presence. A driver buffer on the `trigger` input leaves the module in drone mode. Seeding one real edge made all five live. ⚠ **And a second layer**: with the corrected rig but the gate high from sample 0, ATTACK and DECAY *still* read dead, because the note-on landed in the same render quantum as the k-rate `trigger_connected` write. Delaying the gate to t = 1.0 s produced a textbook 1 s ramp at `A = 1`. **Two wrong answers in a row on one control, and SUSTAIN and RELEASE moved throughout — a passing negative control the whole time.** |
| **B** | **hypercube** | "`alpha` does something — `Δ = 8.45e-1`" | **The module is not reproducible run-to-run** (§4.4). `max|Δ|` was reading phase noise. The tell was incoherence: the *same* Δ at 0.25, 0.5, 0.75 and 1 with `acRms` identical to six decimals. Only a phase-invariant instrument (rms 8 s.f. + centroid + band energies) could speak. |
| **C** | **timelorde** | "SWING AMOUNT does nothing — 7 pulses at 45° and 7 at 90°" | **A pulse COUNT is invariant to swing by construction** — swing moves *when* an edge lands, never how many. Inter-pulse intervals: 562.5/437.5 ms at 45°, **625.0/375.0 at 90°**. The counter even had a passing negative control (8 → 7 when swing engaged at all). |
| **D** | **unityscalemathematik · illogic** | "the attenuverter at −1 and +1 are the same — dead control" | **RMS, peak and centroid are all invariant to a sign flip.** Identical to every printed figure; `Δ = 1.60e+0` / `1.80e+0`, exactly twice the amplitude. **An attenuverter is the most common control shape in the unfaced tail** — at least six more modules — and any sweep over them must use a SIGNED comparison. |

Two smaller ones are recorded inline: a `heldGate({ startS, endS })` call against
a `{ totalS, onS }` signature produced an all-zero gate and a confident false
reading (wavecel), and a single-stimulus BRIGHT probe read "pinned at its floor"
where a four-source ladder read "tracks pitch" (featurecv).

**The meta-lesson, sharper than batch 4's:** every one of A, B, C and D had
*something* moving — a passing control — and was still measuring the wrong thing.
**Prefer a POSITIVE control against a known magnitude** (a four-source brightness
ladder; a 1 s attack that must take exactly 1 s; a 5:3 swing ratio) over a
negative control that merely proves the needle can twitch.

---

## 7. THE RULES THESE SPECS WERE WRITTEN UNDER

1. **`face.hint` and `face.title` DO NOT PAINT at rest.**
   `facePageHeader(def, annotations = false)` returns `null` before reading
   anything. **Every load-bearing fact in these twelve files is in a band LABEL, a
   band HINT, a READOUT or a sidebar `text` entry.**
2. **A tabbed face renders NO band hints at all, and tabbing engages at 7 bands**
   (`DOCK_TAB_MIN_BANDS`). Three specs sit at exactly **six** bands
   (`warrensspectrum`, `cofefve`) or fewer and say so inline, because a seventh
   band deletes every hint on the face at once — a cliff, not a gradient.
3. **Label clipping is invisible to `faces-parity`** (`toHaveText` reads
   `textContent`). **Every band label or hint over ~30 characters in this batch
   carries a measured character count and a shorter fallback that keeps the
   fact.** Nine labels carry that warning.
4. **A derived readout must name the perturbation that distinguishes it from a
   knob readback**, and where a one-sided control would pass, it carries a
   **second** leg that must move differently. Every `valueId` here does — see
   `ws-bandcount-state`, `swolevco-mod-hz`, `cofefve-inert-count` and
   `illogic-sum-headroom` in particular.
5. **A readout that cannot be honest is omitted, not softened.** One is named as
   un-shippable until `FaceReadoutValue` widens beyond params-only
   (`wavecel-amp-mode`, which needs the patch edges) — with the reason, so the
   next author does not "fix" it into existence as a static string.
6. **An ACTION cell needs a `ShellActionCell.probe`.** `timelorde`'s TAP button is
   the batch's one genuine audition candidate and it is **NOT** declared, because
   the def exposes no engine-reachable callable. Named as a prerequisite PR
   instead.
7. **Never fold a DSP change into a face wave.** **Eleven** real audio/behaviour
   fixes surfaced here (§3 #1–#8, #12, #13, #17) and **each is its own PR**. Four
   of them (`hypercube`'s DC, `swolevco`'s ratio DC, `slewSwitch`'s √2,
   `destroy`'s decimate) are small and well-scoped; two (`featurecv`'s BRIGHT,
   `hypercube`'s alpha) are investigations before they are fixes.
8. **A control's range comes from ONE place.** Eleven of twelve violate it; §3-20.
9. **Where I inferred rather than measured, the spec says so** — and where the
   *measurement itself* was wrong, it says that too (§6). Five claims across the
   batch are explicitly marked **NOT DETERMINED**.

---

## 8. CI WALL-TIME — the honest arithmetic for ten faces

Each face adds **two VRT scenes per platform** (`face-<type>-{compact,dock}`,
`e2e/vrt/workflow-shell-faces.spec.ts`) and **one `faces-parity` row**
(registry-driven off `STRICT_FACES`).

| lane | delta | gating? |
|---|---|---|
| **`vrt` (informational)** | **+40 scenes** (10 faces × 2 scenes × 2 platforms). ⚠ **ESTIMATE, not a measurement** — batch 4 estimated +4 to +5 min for 32 and the way to settle it is still to land ONE face and difference the `Run VRT` step. | **no** — `continue-on-error` |
| **`vrt-strict` (REQUIRED)** | **+0 scenes.** **None of the twelve is in `STRICT_VRT_MODULES`** — checked. So no required baseline moves from the faces themselves. | **no** |
| **`e2e` (REQUIRED, 10 shards)** | +10 parity rows. Cells: warrensspectrum **25**, cofefve **25**, wavecel **15**, swolevco 9, slewSwitch 8, featurecv 7, timelorde 7, illogic 4, destroy 3, ninelives 2 = **≈105 driven cells**. At ~0.8 s/cell on SwiftShader plus ~8 s boot per row: **≈ +165 s total ≈ +17 s per shard. Under the 2-minute bar.** ⚠ `timelorde` is `maxInstances = 1` and `undeletable` — its row must use the rack's existing singleton. | **yes** |
| **darwin baselines** | 40 new PNGs captured locally; **40 linux PNGs need `vrt-update.yml` dispatches**, each drain lowering the vrt-meta linux-deficit ratchet **in the same commit** plus a `task test:ledger:accept` re-pin. | — |

**Recommendation on cost — four PRs, not one:**

1. **PR A — the four with no prerequisite and a small parity row**: `swolevco`,
   `slewSwitch`, `illogic`, `ninelives`. 23 parity cells, one dispatch. This is
   also where the VRT estimate above becomes a **measurement**.
2. **PR B — the two big ones**: `warrensspectrum`, `cofefve`. 50 parity cells and
   two new sidebar panels; ⚠ `warrensspectrum` is already in
   `PUSH_CARD_CONTROLS`, so check the push card's 8 entries against the face's
   top 8 in the same PR.
3. **PR C — the two needing a small non-DSP seam first**: `wavecel` (the
   2.7 ms connect click, and the `wavecel-amp-mode` readout question) and
   `destroy` (whose `curve: 'log'` question should be settled first because
   `<Fader>` actually implements it).
4. **PR D — `timelorde` alone.** A singleton, `undeletable`, in every rack; its
   parity row and its VRT scene both interact with the rest of the roster, and a
   red run there should have exactly one cause.

`featurecv` and `hypercube` are **not** in this plan. Both wait on an answer
(§1.1), and both answers are investigations that belong in their own PRs.
