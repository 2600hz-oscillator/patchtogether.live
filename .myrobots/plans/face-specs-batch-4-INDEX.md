# FACE SPECS — BATCH 4 · the index

## 0. STATUS — AUTHORED 2026-08-09, VERIFIED AGAINST `main`

**Every claim in these eight files was measured or read against `main` at `ecc48f2e`,
not against an earlier spec.** Batch 3's index needed exactly this correction three days
after it landed, so it is written in from the start.

**Nothing here is implemented. No def, card, DSP file or test is touched by this PR** —
it is eight documents in `.myrobots/plans/`, so it consumes no faceplate PR slot. The
working tree diff is 9 markdown files, 0 source files; `flox activate -- task typecheck`
is **0 errors** (3307 files), unchanged.

⚠ **This PR is docs-only**, so `ci.yml` path-skips it and
`.github/workflows/docs-only-gate.yml` posts the two required contexts. That bypass fires
only when **every** changed file is a doc — do not add a source file to this branch.

**Ground truth used for "unfaced":** `STRICT_FACES`
(`packages/web/src/lib/ui/workflow/strict-faces.ts`) plus whether the def declares a
`face`. As of `ecc48f2e` that is **23 faced** of **171 audio modules**; 98 unfaced audio
modules were enumerated from `contract-lock.txt` before choosing.

---

## 1. THE EIGHT, AND WHAT I PROPOSE

| module | family | verdict | the one-line proposal |
|---|---|---|---|
| **rings** | voice | **PROMOTE** | ODD and EVEN are **not a stereo pair** — they are spectrally disjoint combs 116 dB apart, so the documented "mono" output is missing every even harmonic. Hero = the pickup comb, which also makes visible that **POSITION `p` and `1−p` are bit-identical**. |
| **treeohvox** | voice | **PROMOTE** | RESONANCE is exponentially skewed — knob 0.5 is effective **0.818** — and its first tenth is a 14 dB level cliff that **clips**. Hero = the filter-envelope sweep, because ENVELOPE and DECAY move nothing a meter can see. |
| **sidecar** | effect / dynamics | **PROMOTE** | MAKEUP is a **sidechain-branch** gain, not an output gain (bit-identical with the SC silent), and it reaches **+17.98 dBFS** unlimited. The detector **sums** `|L|+|R|`, so the THRESHOLD dial is 6.02 dB off for any centred trigger. |
| **resofilter** | effect / filter | **PROMOTE — cheapest** | RESONANCE means **four different things** by MODE: a 26 dB peak in LP/BP, the notch **width** in NT, and **0.00 dB** of magnitude in AP. ⚠ Its tiers collapse (`full` ≡ `dock`, four cells). |
| **attenumix** | utility / mixing | **PROMOTE** | The mix bus tanh is **always on** — 1.96 % THD and 0.68 dB of loss at the *default* master with one channel — while the direct outs measure 0.00004 %. Two signals, one panel. |
| **clouds** | effect / granular | **PROMOTE** | Bit-zero for its first **0.25 s** and 12 dB down until exactly **t = 2.0 s**. PITCH is a **−10.5 dB step** the instant it leaves zero. POSITION is total and **invisible to every level metric in the repo**. |
| **marbles** | sequencing / random | **PROMOTE — largest** | `t_model` 1 (CLUSTERS) is **bit-identical** to `t_model` 0 (COIN): six named models, five behaviours. DÉJÀ VU locks at **0.5**, and the X one repeats **less** above it. |
| **drumseqz** | sequencing | **PROMOTE — blocked on §4-A** | `trk{N}_euclid` is a **write-only param**: nothing at play time reads it, and a **shipped LIVECODE example writes it**. Fix that first or the face ships four dead dials. |

**Spread:** 2 voice · 3 effect/processor · 1 utility mixer · 2 sequencing. No two are the
same archetype, and only one (`resofilter`) is a filter.

**All eight are PROMOTE.** That is not a soft result — §2 is the list of what was
examined and rejected, and three modules were dropped on merit before these eight were
chosen.

### 1.1 THE ONE THAT IS GENUINELY BLOCKED

**`drumseqz` should not ship a face until `trk{N}_euclid` is live.**
`applyEuclideanToTrack` is called from exactly one place in the repo —
`DrumseqzCard.svelte:140` — and the scheduler never reads the param. Writing it from
LIVECODE, MIDI-learn, the Push 2 card, an automation lane **or a faceplate** changes a
number and produces no rhythm. `packages/web/src/lib/livecode/examples.ts:198` ships
`set('drums', 'trk1_euclid', 4); // four-on-the-floor kick on track 1`, which is
documentation for a control that does nothing.

That is a **behaviour PR of its own**, before the face. Everything else in the batch is
buildable now.

---

## 2. WHAT WAS REJECTED, AND WHY

Considered from the 98 unfaced audio modules and **not** taken:

| module | reason |
|---|---|
| `mixmstrs` (91 params), `wavesculpt` (90), `moog960` (36), `foxy` (33) | Too large for a batch that has to be reviewable. Each is a face *programme*, not a face. |
| `twotracks`, `cube` | Already **SWAP OUT** in batch 3, on measurement, and neither has been fixed. |
| `samsloop` | Already **blocked** in batch 3 on a P0 (a recorded sample never plays) plus three param promotions. |
| `noise` | Already **NO FACE ON MERIT** in batch 3, and the argument still holds. |
| `es9`, `synesthesia`, `chromaconsole`, `clipplayer`, `timelorde`, `kria`, `score` | Hardware-, video- or grid-bound; their faces are a different design problem (and `clipplayer`/`kria` are their own products). |
| `gatemaiden`, `sampleHold`, `scaler`, `depolarizer`, `polarizer`, `flipper` | 1–2 params. Same shape as `noise`: **all four tiers would be identical.** `gatemaiden` was the closest call — it is the canonical gate↔trigger utility named in CLAUDE.md — but 2 params and one behaviour is a fader and a glyph. |
| `charlottesEchos`, `cofefve` | Deliberately deferred: memory `cofefve-replaces-cocoadelay` has `charlottes-echos` **migrating to `analog-delay-core`**. Speccing a face against a DSP that is scheduled to be replaced is the batch-3 `cube` mistake. |
| `moog9xx` (23 modules) | A clone family. If they get faces they should get **one shared design**, not 23 independent specs. |
| `sequencer`, `cartesian`, `polyseqz`, `macseq`, `writeseq`, `numpadPlus` | Six more sequencers. `drumseqz` was taken as the batch's sequencing slot; taking a second would break the family-spread rule. |
| `warrensspectrum`, `wavecel`, `swolevco`, `hypercube`, `slewSwitch`, `sidecar`'s neighbours | Genuine candidates, no measurement done, **explicitly deferred to batch 5** rather than half-specced. `warrensspectrum` is the strongest of them (15 params, already in `RANGE_BOUND_CARDS`). |

⚠ **No module in this batch received a NO-FACE-ON-MERIT verdict**, and that is worth
stating rather than glossing: the eight were chosen *after* the 98-module enumeration
precisely so the small-surface modules that would earn that verdict (`noise`'s shape)
were filtered out at selection. The rejections above are where that judgement lives.

---

## 3. THE DEFECTS THIS INVESTIGATION FOUND IN SHIPPED CODE

Ranked by how much they hurt. Every one is cited with its measurement in the per-module
spec. **None is fixed here.**

| # | module | defect |
|---|---|---|
| 1 | **drumseqz** | **`trk{N}_euclid` is a write-only param** — no play-time reader, four write surfaces, **and a shipped LIVECODE example that produces silence** (`livecode/examples.ts:198`). |
| 2 | **marbles** | **`t_model` 1 (CLUSTERS) is BIT-IDENTICAL to `t_model` 0 (COIN)** on both gate outputs, verified at three separate `t_bias` values with a passing negative control. Six named models, five behaviours. |
| 3 | **sidecar** | **MAKEUP's doc says "output gain"; it is a sidechain-branch gain.** Measured bit-identical at 0 and 24 dB with the SC silent — and it reaches **peak 7.92 (+17.98 dBFS)** with no limiter. |
| 4 | **treeohvox** | **RESONANCE 0 clips** (peak 1.0226 on a bare note) and **33 of 144 control corners exceed full scale, worst +6.70 dBFS.** No output stage. |
| 5 | **resofilter** | **18 of 60 corners exceed full scale, worst +44.4 dBFS** from a −6 dBFS input. The clamp plateaus at `k ≈ 0.003`, so the top 0.15 % of RESONANCE is one setting at +50.44 dB. |
| 6 | **rings** | **The ART harmonic scenario passes on rectangular-window LEAKAGE.** `powerAt` is an unwindowed DFT over a 91 200-sample decaying tail; h2 reads **−92.7 dB unwindowed vs −206.5 dB Hann** (491 855×), and the assertion clears by 2.43×. Hann-windowed `h2/h1 = −148 dB` — h2 is structurally absent from that tap. |
| 7 | **drumseqz** | **EUCLID is a 16-step tile truncated by LENGTH.** EUCLID 5 plays 5 hits at LENGTH 16, **4 at LENGTH 12, 2 at LENGTH 7**. Exact only at the default. |
| 8 | **clouds** | **Nothing anywhere states the 2-second buffer fill** — bit-zero for 0.25 s, 12 dB down to exactly 2.0 s. `clouds` is in `STRICT_DOCS`; the completeness gate checks a sentence EXISTS, not that it is the right sentence. |
| 9 | **sidecar** | **The `env_out` header's overshoot precondition is false.** It says "when envMag > 1"; measured **1.9774 at `envMag = 1`**, with `env_inv_out` at −0.98. |
| 10 | **treeohvox** | **RESONANCE's exponential skew is undocumented.** Knob 0.5 = effective 0.818; the bottom quarter is 55.5 % of the range and the top half is 18.2 %. |
| 11 | **rings** | **BRIGHTNESS is a ring-time control documented as a tone control** — T60 266 ms → ≥6000 ms at a FIXED damping, ≥22×. |
| 12 | **marbles** | **`length` and `x_length` are bit-exactly inert at the shipped defaults**, and `steps` ships at 0.5 where the quantiser does not engage until ~0.55 — so `scale` is inert too. Four of thirteen params dead at spawn. |
| 13 | **sidecar** | **`inputLevel` declares `units: '%'` on a 0..2 range** → renders `1.00 %`. Latent only because `SidecarCard.svelte` passes **no units at all** on any of nine faders; **a face reads the def and makes it visible.** |
| 14 | **resofilter · marbles** | **Four discrete selectors with no `ParamDef.options`** (`resofilter.mode`, `marbles.t_model`, `marbles.scale`) — a face prints `0.00`…`5.00` where the card prints `Low-pass` / `Raag Bhairav`. Names already exist as exported constants, duplicated by hand. |
| 15 | **attenumix** | **The ART "mix-saturation" scenario is an algebraic identity check** — it asserts `mixSample(sum, 1) ≈ tanh(sum)` to 12 decimals and never renders a signal, so nothing would notice if the distortion went from 2 % to 20 %. |
| 16 | **rings · attenumix** | **Hand-duplicated DSP with no parity test.** `ringsMath` re-declares 250 lines of the worklet comment-for-comment and **every unit test and the whole ART scenario exercise the MIRROR**. Measured agreement today: `2.980e-8`, with a negative control at `7.818e-3`. Nothing enforces it. |
| 17 | **rings** | **`strum` declares no `edge`**, while its own doc says "A TRIGGER … fires on the edge only". `module-docs-lint` does `if (!p.edge) continue`, so the vocabulary gate skips the one port whose vocabulary is at stake — the meowbox finding on a second module. |
| 18 | **rings** | **The card cannot play the instrument.** Measured peak **exactly 0.000e+0** unpatched, and `RingsCard.svelte` has no strum control at all. Same for `treeohvox`. |
| 19 | **all eight** | **Every one re-types its def's ranges in the card**, and **none is in `RANGE_BOUND_CARDS`** (8 entries repo-wide). `treeohvox` is the sharpest case: `treeohvox-range-source.test.ts` exists specifically to hold CUTOFF's 40/6000 in one place, joins the def + the AudioParam descriptor + the DSP constant — and the **card re-types both numbers a fourth time, unguarded.** |

---

## 4. WHAT THESE EIGHT FOUND ABOUT THE PLATFORM

Four things, all of which will bite the next author.

### 4.1 A PANEL's first legal rank is 7, and three of these eight cannot reach it

`module-face-lint` refuses a `panel` cell selected at a lane tier and `faceTierCap('full')`
is **6**, so a picture's first legal rank is 7 on every face, always — the drummergirl
wall. **`resofilter` (4 params) and `attenumix` (5) cannot reach rank 7 at all.**

The meowbox answer applies and both use it: **the picture goes in the SIDEBAR as a
`custom` block**, which carries no `face.order` key and therefore no rank. Two generic
panel ids fall out of this batch — `filter-response-curve` and `softclip-transfer` — and
both are written with props so a second module can reuse them.

### 4.2 The glyph meters the FIRST audio output, and that is wrong on two of eight

`primaryAudioOutPortId` picks the first audio output in declaration order
(`shell-glyph-live.ts:96`). On **`attenumix`** that is `out1` — a single channel's clean
direct out — on a module whose entire story is the mix bus. On **`drumseqz`** there is
**no audio output at all** (nine `gate`/`pitch` jacks), so there is nothing to tap and the
face declares `glyph: 'none'`.

This is the `noise` white-tap finding, twice more. **A face should not declare a glyph
without naming which jack it reads.** Either the platform gains a declared glyph source,
or every affected face states it in the sidebar.

### 4.3 `marbles` would be only the SECOND face exercising #1420's graph freeze

`analogVco` is currently the only free-running module holding a face, and it is the only
thing in the roster that can catch a regression of the pre-frame `AudioContext` freeze or
its ordering. **`marbles` free-runs too** (measured: 16 `clk` edges in 8 s at spawn, no
patching). Promoting it doubles that coverage — and its glyph determinism must be
**derived the analogVco way (10 separate processes, unmasked)**, not assumed.

`clouds` raises a related first: its hero panel is a function of **TIME** (a ring-buffer
write head), not of params. No face panel has been that before. Verify it separately.

### 4.4 A `controlFamily` is selectable at a lane tier; a `panel` is not

`drumseqz` ranks its 16-cell step grid **first** because `curatedFace` resolves
`drumseqz-pitch-{n}` to `kind: 'family'`, which the lane tiers accept. That is the only
reason a sequencer face can show its pattern at `compact`. Worth a line in the
`ModuleFaceHero` doc beside the rank-7 note, because the two rules look alike and are not.

---

## 5. THE RULES THESE SPECS WERE WRITTEN UNDER

1. **`face.hint` and `face.title` DO NOT PAINT.** `facePageHeader(def, annotations = false)`
   returns `null` before reading anything (`dock-faceplate-model.ts:90`); owner ruling
   2026-08-03. **Every load-bearing fact in these eight files is in a band LABEL, a
   READOUT or a sidebar `text` entry** — never in a hint. Eight batch-3 specs got this
   wrong; none of these do.
2. **Label clipping is invisible to `faces-parity`** (`toHaveText` reads `textContent`;
   a CSS ellipsis leaves no trace). `filter` ships three two-letter options and still
   renders `LP · H… · B…`. **Every band label over ~30 characters in this batch is
   flagged inline with a measured character count and a shorter fallback that keeps the
   fact.** Ten labels carry that warning.
3. **A derived readout must name the perturbation that distinguishes it from a knob
   readback**, and where a one-sided control would pass, it carries a **second** leg that
   must *not* move. Every `valueId` here does.
4. **A readout that cannot be honest is omitted, not softened.** Three are named as
   un-shippable until `FaceReadoutValue` widens beyond params-only
   (`sidecar-reduction-db`, `clouds-buffer-fill`, `drumseqz-played-hits`) — with the
   reason, so the next author does not "fix" them into existence as static strings.
5. **Never fold a DSP change into a face wave.** Seven real audio fixes surfaced here
   (drumseqz's euclid param, marbles' duplicate model, sidecar's makeup routing,
   treeohvox's resonance clipping, resofilter's clamp, rings' ART probe, attenumix's
   identity-only gate). **Each is its own PR**, and two of them (`drumseqz`, `marbles`)
   are behaviour changes needing an owner decision.
6. **A control's range comes from ONE place.** All eight violate this; §3-19.
7. **Where I inferred rather than measured, the spec says so** — and where the
   *measurement itself* was wrong, it says that too (§6).

---

## 6. THE INSTRUMENT WAS WRONG SIX TIMES, AND EVERY WRONG ANSWER LOOKED AUTHORITATIVE

This is the CLAUDE.md **VALIDATE THE INSTRUMENT** rule, earned six more times in one
session. Each is recorded in its own spec rather than quietly corrected, because the
shape recurs.

| # | module | what the bad instrument said | why it was wrong |
|---|---|---|---|
| 1 | **rings** | "the module is 2400 cents flat" | **Autocorrelation on a stretched partial series** locks to a long quasi-period. A Hann-windowed peak-find, negative-controlled to 0.25 cents on synthetic sines, showed the tuning is exact and the bank is merely top-heavy. |
| 2 | **sidecar** | "KNEE is worth 0.09 dB — a dead control" | Probed at a level **far above** the threshold, where a knee is *supposed* to do nothing. Sweeping the input **across** the threshold gives 1.71 dB, and a RATIO negative control on the same probe proves it is not blind. |
| 3 | **clouds** | two passes disagreed by **18 dB** on the same setting | The output is **not stationary** and the two passes averaged different windows. Fixed by a broadband source, a fixed 2–6 s window, and a **permanent** dry-path control that measures 0.00 dB of variation. |
| 4 | **resofilter** | "RESONANCE does nothing in NOTCH — 0.52 dB" | A **broadband RMS** metric is blind to a notch **WIDTH** change. Per-frequency, the same travel takes the notch from ±2 octaves to zero. |
| 5 | **marbles** | "all six SCALES are bit-identical" | `spread 1` puts every sample on the worklet's `clamp(cv/5, −1, 1)` **rail**. |
| 6 | **marbles** | "all six SCALES are bit-identical" — **again** | `steps 1` collapses every scale to its **root degree by design**. This one had an *unclipped* probe and a *passing* negative control, which is precisely what made it convincing. Scales are distinguishable only inside `steps ∈ [0.7, 0.8]`. |

Two smaller ones are recorded inline: a rising-edge counter cannot see a signal that
starts HIGH (marbles' clock read 0.125 Hz slow at every rate), and a peak-find returns a
*partial*, not the fundamental, when the partials are louder (rings' STRUCTURE row at 0).

**The meta-lesson, which #5 and #6 make sharper than anything in batch 3: a passing
negative control proves the probe can move, not that it is measuring the right thing.**
Both marbles probes had one.

---

## 7. CI WALL-TIME — the honest arithmetic for eight faces

Each face adds **two VRT scenes per platform** (`face-<type>-{compact,dock}`,
`e2e/vrt/workflow-shell-faces.spec.ts`) and **one `faces-parity` row**
(registry-driven off `STRICT_FACES`).

| lane | delta | gating? |
|---|---|---|
| **`vrt` (informational)** | **+32 scenes** (8 faces × 2 scenes × 2 platforms). Same shape as the 26 face scenes already there. **Estimate +4 to +5 min** on a 621 s single-worker step. ⚠ **ESTIMATE, not a measurement** — the way to settle it is to land ONE face and difference the `Run VRT` step. | **no** — `continue-on-error`, not in `needs` |
| **`vrt-strict` (REQUIRED)** | **+0 scenes from the faces.** ⚠ **But `drumseqz` is in `STRICT_VRT_MODULES`**, so any change to `DrumseqzCard.svelte` — which the §1.1 euclid fix requires — re-captures a REQUIRED baseline on **both** platforms. **Keep that fix in its own PR** so a red `vrt-strict` has one cause. | **yes, for drumseqz's card** |
| **`e2e` (REQUIRED, 10 shards)** | +8 parity rows. Cells: drumseqz **≈35** (18 params + a 16-cell family + panel), marbles 15, sidecar 10, clouds 8, rings 9, treeohvox 9, attenumix 5, resofilter 4 = **≈95 driven cells**. At ~0.8 s/cell on SwiftShader plus ~8 s boot per row: **≈ +140 s total ≈ +14 s per shard.** **Comfortably under the 2-minute bar.** ⚠ **drumseqz's row must pin `length` at its default** — the family is `countParam: 'length'` and can reach **128 cells**. | **yes** |
| **darwin baselines** | 32 new PNGs captured locally; **32 linux PNGs need `vrt-update.yml` dispatches**, each drain lowering the vrt-meta linux-deficit ratchet **in the same commit** plus a `task test:ledger:accept` re-pin. | — |

**Recommendation on cost — three PRs, not one, and NOT three of three:**

1. **PR A — the four clean promotions**: `resofilter`, `attenumix`, `rings`, `clouds`.
   No blocking prerequisite; 26 parity cells; one dispatch.
2. **PR B — the two needing a factory seam**: `treeohvox`, `sidecar`. Both want a small
   non-DSP change first (`treeohvox` a held-gate `manualGate` read key; `sidecar` the
   `inputLevel` units fix).
3. **PR C — the two big ones**: `marbles` and `drumseqz`, each **after** its own
   behaviour PR (§1.1, §3-2). These are the tabbed faces and the expensive parity rows.

By PR B the `Run VRT` estimate above is a measurement.
