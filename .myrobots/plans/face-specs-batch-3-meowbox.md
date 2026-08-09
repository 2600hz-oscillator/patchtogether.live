# FACE SPEC — `meowbox` (batch 3)

> ## STATUS — **BUILT 2026-08-08** (`face/meowbox`). This file is now the RECORD, not the plan.
>
> Everything below the horizontal rule is the spec as SHIPPED. Where the original
> 2026-08-02 draft was wrong, the correction is inline and marked **⚠ SPEC WAS
> STALE**. Six of those are structural — one of them made the draft's central
> declaration *impossible to ship as written*.
>
> **Platform status, corrected.** PF-20 (**PR #1301**) merged `c6ff9253` on
> 2026-08-02; PF-21 dock ROW PACKING landed `9bf12df7`. `face.title` / `face.hint`
> / every band `hint` are **ANNOTATION-ONLY** (`facePageHeader` returns `null`
> before it reads anything — `dock-faceplate-model.ts:90`; owner decision
> 2026-08-03). The module NAME still paints, from the dock title bar. Band LABELS
> stay — they are fieldset legends, structure not description.
>
> **Batch 3 shipped four faces before this one** — `clap`, `drummergirl`,
> `pentemelodica` and a RE-DO of `sixstrum` (**#1332**, `2d111616`). They POSTDATE
> this document and they are the bar. Where they and this draft disagreed, they won.

**Verdict: PROMOTED.** archetype: **formant-resonator VOICE with a five-anchor
preset morph.** In `STRICT_FACES` as of this PR.

---

## 0. THE SIX PLACES THIS SPEC WAS STALE

| # | the draft said | the truth |
|---|---|---|
| **1** | hero `cell: 'meowbox-hero-{n}'` — a promoted PANEL picture | **STRUCTURALLY IMPOSSIBLE ON THIS MODULE.** `module-face-lint` fails any panel SELECTED at a lane tier, and the `full` lane cap is **6** (`LANE_PLATE_MAX_CELLS = PLATE_COLS × PLATE_MAX_ROWS`). meowbox has **4 params**; with the audition at rank 5 a panel can only reach rank 6 — inside the plate. A panel's first legal rank is 7 and there is no sixth rankable key. **The picture moved to the SIDEBAR as a `custom` block, which carries no `face.order` key at all and therefore no rank.** See §6. |
| **2** | the audition is a one-shot strike | **It is a HELD GATE.** `ampEnv = en.adsr(0.005, 0.05, **0.4**, …)` sustains at 0.4 while the gate is high, so the shared `TRIGGER_PULSE_S` (5 ms) would release the envelope ~5 ms into a 400 ms tail and audition a blip. `mode: 'gate'` → `manualGate`, the snaredrum-ROLL shape. The draft's own §6-F found the fact and did not carry it into §4. |
| **3** | a `formant-map` `custom` sidebar block **in addition to** the hero picture | ONE picture, per the batch rule ("exactly one panel, its picture"). The two were the same drawing twice. Merged into the single sidebar panel `formant-bank`. |
| **4** | `meowbox-length-ms` — "the note's real length" | **There is no such number.** The envelope sustains at 0.4 *while the gate is high*, so total length is gate-dependent and unanswerable from the params (the `drummergirlHitText` → `'sustains'` precedent). Shipped as **`meowbox-tail-s`** — the RELEASE tail, `decay × decayScaleOf(morph)`, which is exactly the quantity the draft's negative control was about. |
| **5** | "⚠ The card **re-types every range** and is not in `RANGE_BOUND_CARDS`, so the source-level guard is blind to it" | Half stale. `RANGE_BOUND_CARDS` is still an opt-in list (7 cards) — but a SECOND, deny-by-default gate landed 2026-08-02: `card-def-agreement.test.ts`, which sweeps all ~193 cards and already ledgers meowbox's four real divergences in `card-def-debt.ts:85`. The card was never invisible; it was visible to a different gate. **Fixed anyway** — the 12 range numbers + 4 curves now come from `paramSpec(meowboxDef, id)`. |
| **6** | "**ART** | none" | Understated. meowbox has **three** ART scenarios and **no `.f32` baseline** (`ART_BACKLOG`, and that list is at its `ART_BACKLOG_MAX = 44` floor with zero slack). `meow-c4` renders a **stub**; `voct-tracking` uses an `OscillatorNode` stand-in; only `voct-real-dsp` touches the shipped wasm, and it deliberately asserts the octave RATIO only. **Consequence for this PR: no audio pin would have noticed a DSP drift, so the model's re-typed tables are pinned by a SOURCE GREP instead** (the drummergirl route). Baseline held: all three green, unchanged. |

---

## 1. WHAT IT ACTUALLY DOES

**It is not a glottal model and it has no vowels.** `packages/dsp/src/meowbox.dsp:2`
is the honest line: *"morph crossfades 5 anchor presets (kitten, adult meow, purr,
yowl, hiss)"*. There is no vowel table in the file. (The def's own
`docs.explanation` named the a/e/i/o/u regions — fixed in this PR; see §7-E.)

- **Source** (`:86-90`): four table-lookup sines at F, 2F, 3F, 4F with amplitudes
  1, 0.5, 0.25, 0.125, blended with `no.noise` as
  `voicedExc·voicedOf(m) + noise·(1 − voicedOf(m))` (`:98-100`).
- **Tremolo** (`:96`): a fixed **15 Hz** AM on the voiced path only, depth
  `0.4·(1 − voicedOf(m))` — 0.06 at the default morph.
- **Formants** (`:103-106`): three parallel `fi.resonbp(fN, qN, 1.0)` summed with
  weights `aN`. `resonbp` is `tf2s(0, gain, 0, 1/Q, 1, 2π·fc)`, so at `ω = ω₁`,
  `H = gain·j / (j/Q)` = **`gain·Q` exactly**. Re-verified numerically this PR:
  0.500000 / 6.000000 / 10.000000 / 12.000000 / 14.000000 / 16.000000 at
  Q = 0.5/6/10/12/14/16. **The effective peak gain of band N is `aN(m)·qN(m)`,
  not `aN(m)`** — which is what §5-B exists to expose.
- **The morph** (`:44-63`): `mIdx = clamp(0,4, m·4)`, linear in **Hz**, over
  **thirteen** tables. One knob moves F1/F2/F3, Q1/Q2/Q3, A1/A2/A3, `voiced`,
  `riseAmt`, `fallAmt` and `decayScale` together.
- **Envelopes** (`:78-82`, `:109`). `ampEnv` is `en.adsr(0.005, 0.05, **0.4**,
  decay·decayScaleOf(m), g)` — linear-segment, **sustaining at 0.4 while the gate
  is non-zero**. The pitch contour is `en.are(0.03,0.08,g)·riseAmt·12 −
  en.adsr(0,0.25,0,…)·fallAmt·12`; `en.are` sustains at **1.0**, so the note starts
  `−fallAmt·12` flat, sweeps up, and **settles `+riseAmt·12` sharp and stays there**.
- **Stereo** (`:113-117`): `R = de.fdelay(48, (1−ampEnv)·0.6·48, L)` — R is L
  delayed by 0–0.6 ms, *inversely* to the envelope. Not a decorrelated voice.

**Resolved anchor table** — recomputed from source this PR, all figures verified:

| morph | F1 | F2 | F3 | Q1/Q2/Q3 | peak `a·Q` | voiced | trem | rise/fall (st) | decayScale |
|---|---|---|---|---|---|---|---|---|---|
| 0.00 kitten | 700 | 1900 | 3000 | 12/14/12 | 12 / 11.9 / 6.0 | .85 | .06 | +3.00 / −2.64 | 0.7 |
| **0.25 default** | **450** | **1300** | **2700** | 10/12/12 | **10 / 8.4 / 4.8** | .85 | .06 | **+1.80 / −2.16** | **1.0** |
| 0.375 *(mid-glide)* | 315 | 825 | 1750 | 8/10/10 | 8 / 6.5 / 3.5 | .725 | .11 | +0.90 / −1.08 | 1.25 |
| 0.50 purr | 180 | 350 | 800 | 6/8/8 | 6 / 4.8 / 2.4 | .60 | .16 | 0 / 0 | 1.5 |
| 0.75 yowl | 380 | 1100 | 2400 | 14/16/14 | 14 / 13.6 / 8.4 | .80 | .08 | +0.96 / −1.68 | 2.0 |
| 1.00 hiss | 100 | 4500 | 8000 | 0.5/8/8 | **0** / 5.6 / 4.0 | .15 | **.34** | 0 / 0 | 0.6 |

---

## 2. THE CONTROLS THAT MATTER — four params, and no loser

| rank | control | why |
|---|---|---|
| 1 | `morph` | **the only timbre control**, and it drives thirteen tables at once. |
| 2 | `pitch` | ±36 st, summed with the V/oct volts inside one `pow(2,·)` (`:72`). |
| 3 | `decay` | the ADSR release **and** the pitch-fall term's release, both multiplied by `decayScaleOf(morph)` — so it is not a seconds value. |
| 4 | `level` | a scalar on L only (`:116`); R inherits it through the delay. |
| 5 | `meowbox-meow-{n}` | **the audition.** The module is silent until a gate arrives, and neither surface had a way to make it sound. |

**Losers: none.** Rank 5 is the last rank, and the lane plate holds 6 — so every
control reaches every tier from `full` up, and ranks 1–4 only decide the mini
(1 cell) and compact (2 cells beside the glyph) tiles. **The audition is
deliberately LAST**: at rank 5 it never reaches mini or compact — a button in a
46 px knob column is a bare glyph — while still always painting on the plate,
where there is room for six cells and only four knobs.

---

## 3. INERT AT SPAWN — MEASURED

**The whole module.** With no gate cable `g = 0` → `ampEnv = 0` → `leftCh = 0`
and `rightCh = fdelay(…, 0) = 0`; the factory feeds a `ConstantSource` at 0 into
both merger channels (`meowbox.ts`), so the DSP runs and is silent. **That is what
the audition is for, and it is the single largest thing this face adds.**

Two further inert findings, both re-measured rather than argued:

- **`max(0.5, …)` on Q (`:54-56`) is dead code.** Swept `m` at 10 001 points:
  the clamp binds at **0** of them. The table minimum is already 0.5 and a lerp of
  two values ≥ 0.5 is ≥ 0.5. Left in place (it is harmless and removing it is a
  DSP change), stated here so nobody reads it as a live constraint.
- **F1/Q1 are inert at `morph = 1.0` and NOWHERE ELSE.** `a1Of` is
  1.0 / 1.0 / 1.0 / 1.0 / 0.0, so it is 1.0 across the whole of [0, 0.75] and
  falls linearly to 0 across (0.75, 1.0]: measured `a1 = 0.4` at m 0.9,
  `0.04` at 0.99, `0.004` at 0.999, and bit-exactly `0` only at 1.0. **The face
  prints this rather than hiding it** — `meowbox-formant-gain` reads `−∞ dB` for
  band 1 at m = 1.0, which is the honest number and is pinned in the model test.

---

## 4. THE FACE — AS SHIPPED

```ts
controlFamilies: [
  { id: 'meowbox-meow', label: 'Meow — audition the voice', kind: 'other',
    testidPrefix: 'meowbox-meow' },
],

face: {
  order: ['morph', 'pitch', 'decay', 'level', 'meowbox-meow-{n}'],
  pages: [
    { id: 'source', label: '1 · four sines and a noise bed',
      controls: ['meowbox-meow-{n}', 'morph', 'pitch'] },   // → ['pitch'] after the hero split
    { id: 'tail',   label: '2 · the tail, and what scales it',
      controls: ['decay', 'level'] },
  ],
  glyph: 'scope',
  hero: {
    control: 'morph',
    action: 'meowbox-meow-{n}',
    readouts: [
      { label: 'formants', valueId: 'meowbox-formants' },
      { label: 'settles',  valueId: 'meowbox-settled-hz' },
      { label: 'tail',     valueId: 'meowbox-tail-s' },
    ],
  },
  sidebar: [ signal-flow · presets (the five anchors) · custom 'formant-bank' · readouts ],
  rear: { groups: [{ id: 'voice', label: 'play', ports: ['gate', 'pitch'] }],
          audioRate: ['gate', 'pitch'] },
}
```

**⚠ THE PROMOTED KEYS ARE DECLARED IN A BAND, and the band survives the split.**
`face.hero` MOVES a key, it does not copy one, and `heroFacePlan` DROPS a band the
promotion empties — taking its `hint` with it, which then fails the
annotation-reachability clause (the drummergirl scar). Band 1 declares
`[meowbox-meow-{n}, morph, pitch]` and renders `[pitch]` after the split, which is
also why band 1 is named for what the voice is MADE OF rather than for MORPH:
PITCH is the F that the four partials are built on, so the label still describes
its survivor.

**`glyph: 'scope'` stays, and the audition is what makes it honest** — the
sixstrum argument verbatim. Before the pad, every screenshot of this voice was a
flat line.

---

## 5. DERIVED READOUTS — six, each with a PERMANENT negative control

All six are registered in `face-readout-values.ts` and negative-controlled in
`meowbox-face-model.test.ts`, **in both directions**: the number moves under the
perturbation it is about, and it does **not** move under the ones it is not.

### A. `meowbox-formants` — the resolved F1 / F2 / F3
`fN(m) = fNAt(⌊4m⌋)·(1−frac) + fNAt(min(4,⌊4m⌋+1))·frac`
**NEG:** morph 0.375 → **315 / 825 / 1750 Hz**, a triple in no table row. A knob
readback prints `0.375` and cannot express mid-glide. **Invariant leg:** the whole
pitch/decay/level travel leaves the string frozen.

### B. `meowbox-formant-gain` — the effective peak, and it is NOT the `a` table
`peak_N(m) = aN(m)·qN(m)` in dB.
**NEG — morph 0.5 → 0.75.** `A1` is **1.0 at both endpoints and at every point
between** (measured at 0.5/0.5625/0.625/0.6875/0.75 — all exactly 1.0), so a
readout of the amplitude table is *flat across the entire move* — while band 1's
peak goes 6 → 14, **+7.36 dB**, because Q1 goes 6 → 14. Any readout that reads
`a` alone is blind by construction, and that blindness is invisible from its
output. Both legs pinned.

### C. `meowbox-settled-hz` — where the note ends up, which is not where you asked
`f_sus = 261.6256 · 2^(pitchSemi/12 + riseAmtOf(morph))`
At the factory defaults: onset **230.94 Hz**, sustain **290.29 Hz**. **The module
never settles on the notated pitch — it ends 1.80 semitones sharp.**
**NEG:** morph 0.25 → 0.50 drops the sustained fundamental 290.29 → **261.63 Hz**
— a real 1.8-semitone pitch change caused by the *timbre* knob, with PITCH reading
0 in both states. **Invariant leg:** decay and level do not move it.

### D. `meowbox-tail-s` — the release tail (⚠ renamed, see §0-4)
`tail = decay · decayScaleOf(morph)`
**NEG:** hold DECAY at 0.40 s and move morph 0.25 → 0.75: **400 ms → 800 ms**; at
morph 1.0 it is **240 ms**. The DECAY knob's own "0.40 s" caption is correct at
exactly one morph position out of a continuum. Full reachable span 30 ms → 4.0 s.
⚠ At the shipped defaults it reads `400 ms`, which is *also* what the dial says —
the sixstrum `rings for` trap. That is precisely why the negative control is the
morph sweep and not the default value.

### E. `meowbox-tremolo` — and the comment it contradicts
`depth = 0.4·(1 − voicedOf(morph))`
**NEG:** it must be **maximal at hiss (0.34) and minimal at kitten (0.06)** —
the *opposite* of what `meowbox.dsp:92-95` claims. Pinned as a DEFECT, not
approved: the test fails the day the DSP comment is made true.

### F. `meowbox-comb-null` — the one that NO knob moves, and that is the point
`f_null1 = 1 / (2·(1−ampEnv)·0.6·0.001)` → **833 Hz idle, 1389 Hz at the 0.4
sustain, ∞ at the envelope peak.**
**NEG, BOTH DIRECTIONS, and it is the sharpest one here.** The model function takes
the *envelope* as its argument, so the moving leg perturbs `ampEnv` and watches
833 → 1389 → ∞. The frozen leg sweeps **every param** through the registered
readout and asserts the string never changes. A readout that responded to a knob
would be measuring something else — this is the only readout on the module where
that is true, and the test says so in both directions rather than asserting the
easy half.

---

## 6. THE PICTURE, THE RANGES, AND WHAT WAS ALREADY WRONG

**THE PICTURE — `formant-bank`, a `custom` SIDEBAR block.** The three resonance
peaks on a log-frequency axis with the four source partials (F · 2F · 3F · 4F)
marked underneath, so "which harmonic is inside which formant" is visible, and
each peak is drawn at its **`a·Q`** height so §5-B becomes a picture rather than a
number. ⚠ **It is a SIDEBAR panel and not `hero.cell` for a structural reason, not
a taste one** — see §0-1. This is also the answer drummergirl deferred: that
module dropped its hero picture *and* its audition together because the panel
could not be ranked below 7. **The rank wall applies only to `hero.cell`; a
`sidebar` `custom` block carries no `face.order` key and no rank at all.** Worth
carrying back to drummergirl.

**RANGES — FIXED.** `MeowboxCard.svelte` re-typed all 12 range numbers and all 4
curves. They agreed, but agreeing is not the bar (CLAUDE.md: "a control's range
must come from ONE place"). They now come from `paramSpec(meowboxDef, id)`, the
ringback/adsr route, and `MeowboxCard.svelte` is added to `RANGE_BOUND_CARDS` +
`MAPPING_BOUND_CARDS` with both floors raised. ⚠ **`label` and `units` are
deliberately NOT bound**, and the four `card-def-debt.ts` entries stay: binding
them flips the card's visible text to `Ptch`/`Dcy`/`Lvl` and its unit suffix to
`semi`, which repaints a card in `STRICT_VRT_MODULES` — the **required**
`vrt-strict` lane, on both platforms. That is a vocabulary decision for its own
PR, not a rider on a face.

**ALREADY-WRONG — the ledger, and what this PR did with each:**

| | defect | disposition |
|---|---|---|
| A | `meowbox.dsp:26` says hiss `F=(0,…)`, `Q=(0,…)`; the tables say `100.0` and `0.5`. At morph 0.875 the interpolated F1 is **240 Hz actual vs 190 Hz if the comment were true** (26 % error). | **Left** — a DSP comment fix is a DSP PR. Pinned: the model test asserts the *table* values, so the day someone "fixes" the table to match the comment, it goes red. |
| B | `:92-95` is backwards — depth scales with `(1 − voiced)`, i.e. **inversely**. Maximal exactly where the comment says minimal. | **Left, pinned** by readout E's negative control. |
| C | `:111-112` "delayed by up to 1 ms" — the `·0.6` caps it at **0.6 ms**. | **Left, pinned** by readout F (833 Hz idle is only true at 0.6 ms). |
| D | `:74-77` "then it falls toward 0" — `en.are` sustains at 1.0, so it **stays** at `+riseAmt·12`. | **Left, pinned** by readout C. |
| E | **vowels do not exist.** `meowbox.ts:28, 102, 116` all claimed "vowel" and "the a/e/i/o/u regions" on a module in `STRICT_DOCS`. | **FIXED** in this PR — the def now names the five cat anchors the DSP actually crossfades. |
| F | `docs.inputs.gate` was **factually inverted**: *"It responds to the edge, not how long the level stays up."* `ampEnv` sustains at 0.4, so length = gate-high time + release. It is a **gate** consumer. | **FIXED** — the prose, and the audition shape follows it (`mode: 'gate'`). |
| G | why nothing caught F: the def declared **no `edge:`**, and `module-docs-lint.test.ts:217` does `if (!p.edge) continue`. The one gate that owns this vocabulary was structurally unable to see it. | **FIXED** — `edge: 'gate'` declared; `meowbox` removed from `undeclared-edge-ledger.ts` and its ceiling lowered. This is a contract-lock move (`task docs:accept`). |
| H | `module-manifest.ts` `'meowbox.gate': 'Trigger.'` and `'meowbox.pitch': 'CV -> pitch.'` — the first is wrong, the second stale since schema-v2. | **FIXED** — both. |
| I | `docs.outputs.L`: "summing to mono is fine" — R is a delayed copy of L, so mono-summing combs at 833 → 1389 Hz **through the formant region**. | **FIXED** in the prose; readout F is the live number. |
| J | stale CV LUT: the `decay` `cvScale` chain bakes `liveKnob` at edge-attach time, so turning DECAY *after* patching its CV leaves the scaling centred on the old value. | **Left** — a shared `engine.ts` defect, and `engine.ts` is fenced (PR #1409). Not a meowbox bug. |

---

## 7. COST — AS BUILT

| | |
|---|---|
| **contract-lock** | **+2 lines, 1 modified.** `meowbox control meowbox-meow …` and the `edge=gate` on the gate port. `task docs:accept`, diff reviewed. |
| **ART** | **none — verified.** All three scenarios green and byte-unchanged. Nothing in this PR touches `packages/dsp/src/meowbox.dsp`, so every source-SHA pin holds; the factory gained a `ConstantSource` + a `read()` seam, neither of which is in the DSP hash basis. |
| **VRT — ⚠ REQUIRED LANE** | `meowbox` is in `STRICT_VRT_MODULES`, so the card's new MEOW pad re-captures `vrt.spec.ts/{darwin,linux}/meowbox.png`. Plus **2 new face scenes per platform** (`face-meowbox-compact`, `face-meowbox-dock`) in the INFORMATIONAL lane. |
| **e2e** | +1 `faces-parity` row, **5 cells** (4 knobs + 1 gate-mode action, which the sweep drives on BOTH edges). REQUIRED lane, ≈ +12 s on one shard. |
| **unit** | +1 `meowbox-face-model.test.ts`. Pure, node-only, no fixtures. |
