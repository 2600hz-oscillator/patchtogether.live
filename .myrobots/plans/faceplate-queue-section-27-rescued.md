# §27 — RESCUED FROM AN UNCOMMITTED WORKING COPY (2026-08-19)

**Provenance.** This is the spec lane's Q38–Q41 output, appended to
`.myrobots/plans/faceplate-queue-2026-08-14.md` in the PRIMARY checkout and
**never committed**. The committed queue on `main` ends at `### 26.9` (6358
lines); an earlier docs commit carried §25 and §26 across but predates this
block. It is reproduced here **verbatim** — 837 lines, lifted unedited — because
it is the historical record the batch-5 build was actually briefed from, and
because losing it would leave four merged modules with no written derivation.

**⚠ HOW TO READ IT.** Everything below is the spec lane's text **as written**.
Where the build MEASURED something different, a `>` blockquote marked
**⛔ CORRECTION** or **✅ CONFIRMED** sits directly under the claim. **Nothing in
the original has been edited or deleted.** That is deliberate and it is the
point: the gap between what was claimed and what was measured is itself the
evidence, and silently fixing the record would destroy exactly the thing that
makes this section worth keeping.

**The scorecard, because it is the reusable lesson.** Of the load-bearing
figures the build re-measured:

| claim | outcome |
|---|---|
| `moog902`'s entire measured table (unity at exactly 0.5, ×1.0000000000 at the default, the five-point mode-delta table, 41/41 cvAmount inertness, the 9 V vs 7.5 V ceiling) | **✅ reproduced exactly**, independently, with a channel-aware probe |
| `moog904a`'s dead-dial figures (20.07 % / 40.14 %, boundaries on 20000 ÷ ×4 and ÷ ×16) | **✅ reproduced exactly** |
| `moog904a`'s `-3 dB corner` readout formula | **⛔ −29.40 % wrong at RANGE 3** — rejected, not shipped |
| `moog912`'s gate threshold (−12.980 dBFS), flagged here as unverified | **✅ confirmed on a real rendered graph** (0.100001 vs 0.100000) |
| `moog912`'s `response-ms` readout | **⛔ ~30 % off** the real biquad — rejected, not shipped |
| "DELETE the raw-write ledger entry" (Q38 and Q39) | **⛔ would have reddened the gate** — entries kept |
| "`git rm` the stale VRT baseline first" (Q40) | **⛔ would have reddened `vrt-meta`** — re-captured instead |

So the section's **measurements** held up under independent re-measurement, and
its **prescriptions** did not. That is a sharper and more useful summary than
"the spec was wrong": the numbers a lane MEASURED were sound; the steps it
INFERRED from them were where it went astray, because inference has no
instrument. It is also why the batch's own rule — *a spec is a hypothesis, and a
builder re-checks the load-bearing figures against the code* — is stated at the
top of this PR's index rather than buried.

---

## 27. THE NEXT COHORT — spec lane, 2026-08-19 (the SECOND audio restock)

**Measured against `main` @ `556a9706`.** Where a figure came from the **shipping
`AudioWorkletProcessor`**, it was captured through the same `registerProcessor`
shim `art/setup/worklet.ts` uses and pumped through `process()` in 128-sample
blocks at 48 kHz — the ART capture path, so those are the shipping DSP's own
numbers. **Two of this cohort's four modules have no worklet at all** (`moog912`
and `moog993` are plain Web Audio graphs); for those the **real `def.factory`
was driven against a stub `BaseAudioContext` and the live node values read
back**, which measures the WIRING and the PARAM MAPS and makes no claim about
rendered audio. Every entry says which it is. Anything derived by reading says
so.

**Why this cohort.** §26 restocked the audio half with Q34–Q37 and batches 3–4
consumed all four — `moog911`, `moog911a`, `moogCp3` and `moog921Vco` are all
`done` in the generated inventory. So the audio half is empty AGAIN: the only
audio Q entries not built are Q2/Q3/Q4 (plan-blocked) and Q21/`moog905`
(answered-but-marginal, #1881). These four restock it.

### 27.1 CANDIDATE SELECTION — from the artifact, and what was passed over

`flox activate -- task face:inventory` is GREEN in this tree, so
`docs/design/face-migration.generated.md` is fresh. The pool is its
`generic-face` disposition ∩ `domain: audio` ∩ NOT done. Preference order was
the brief's: a real DSP merit story first, then cohort continuity (the Moog 90x
family has shipped prior art and shared factories), then not-plan-blocked.

**PICKED — `moog902`, `moog904a`, `moog912`, `moog993`.** Two carry a worklet
that can be driven bit-exactly; two carry a **ledgered raw-write `debt` that a
face pays off for free** (a merit argument §26's cohort did not have); all four
have at least one quantity the panel cannot print.

**PASSED OVER, with the reason:**

| module | why not, this round |
|---|---|
| `moog994` | **0 params.** There is nothing to rank. `face.order` would be empty. |
| `moog903a` · `moog962` | **1 param each.** The `noise` case in STOP 1 verbatim — every tier renders the identical single control. |
| `moog961` | 2 params, own worklet, and `switchOnTime` declares `units: 's'` (the Q34 shape). Genuinely next — held only because two-param entries are the closest STOP 1 calls and this cohort already spends one on `moog912`. |
| `moog992` · `moog995` | Attenuator panels of 4 and 3 identical linear knobs, both defaulting to MAX. Q36/`moogCp3` already answered that exact shape ("the merit is the readout, the rank IS declaration order"); a third and fourth telling of it is not a spec. |
| `moog984` | 16 cross-point params — genuinely control-heavy, and the first real `DOCK_TAB_MIN_BANDS` candidate in the family. Held because its merit is the SAME grid-surface question `moog960` just failed (§27.2) and it has no worklet to measure. Next after `moog961`. |
| `moog904b` · `moog904c` | Proper subsets of Q39's story (same ladder core, same RANGE-lies-about-Hz finding, fewer controls). Boy-scout them when Q39 lands. |
| `moog905` | Answered marginal, #1881. |
| `treeohvox` · `scope` · `timelorde` | Plan-blocked. |
| **`moog960`** | **Measured and REJECTED as a generic face — see §27.2. It gets an issue, not a Q number.** |

### 27.2 ⚠ `moog960` WAS PICKED, THEN DISQUALIFIED BY ITS OWN CARD — #1915

It was the obvious fourth: 36 params, the cohort's only control-heavy module,
and a pure `Seq960Stepper` in `packages/dsp/src/lib/seq960-dsp.ts` that drives
in Node. **The pick was wrong, and only reading the card line by line found it**
(§25.8's ATTACK 2: the grep is necessary, not sufficient).

`Moog960Card.svelte` carries two live affordances that are **not `ParamDef`s**:

1. **The column playhead** — `class:active={currentColumn === c - 1}` on the
   column header row and on every cell of all three rows. It is the only thing
   that says where the sequence IS.
2. **The transport readout** — `{isRunning ? '▶ RUN' : '■ STOP'}`.

Neither can be a glyph. Run through the real resolver (§27.9), `moog960`'s
outputs are three `cv` rows plus a `gate`, so `primaryAudioOutPortId` returns
**null** and **all four glyph kinds resolve to `{kind:'static'}`** — the
dead-glyph state. Per the functional-parity rule, *"we would lose the playhead"*
is not an owner choice to surface, so a `moog960` face needs a cell that does
not exist.

**Then the count that settles it.** Nine modules import `createPlayheadTracker`:
`moog960`, `score`, `polyseqz`, `cartesian`, `macseq`, `drumseqz`, `sequencer`,
`writeseq` (plus the tracker's own test). **Eight of the eight real siblings are
`bespoke-surface`. `moog960` alone is `generic-face`.** Zero of the nine declares
a `face`.

The rest of it is genuinely face-shaped, which is why this is a misclassification
rather than a shrug: all 36 knobs already pass `readLive`, all are plain `<Knob>`s
with no radio groups and no raw store writes, and its honest semantic grouping is
**6 pages** (row 1 / row 2 / row 3 / range / mode / clock) — *under*
`DOCK_TAB_MIN_BANDS = 7`, which per the owner ruling of 2026-08-18 means **do not
pad pages to force the rail; raise the threshold to the owner**. Its `range*` and
`mode*` params declare no `options[]`, so the ×1/×2/×4 and NORMAL/SKIP/STOP names
the card computes into each knob's `label` would be lost too.

**#1915** asks for one of: reclassify to `bespoke-surface`, or open a
`needs-playhead-cell` blocker and attach all nine. `moog960` is in
`STRICT_VRT_MODULES`, so either way it is a baseline-moving decision when it
happens.

### 27.3 What all four share (measured, so it is not restated per entry)

| property | `moog902` | `moog904a` | `moog912` | `moog993` |
|---|---|---|---|---|
| params | 3 | 3 | **2** | 3 |
| inputs | 1 `audio` + 2 `cv` | 1 `audio` + 2 `cv` | 1 `audio` | 2 `gate` + 2 `cv` |
| outputs | 2 `audio` | 1 `audio` | 1 `cv` + 1 `gate` | 3 `gate` + 2 `cv` |
| declares `face` | no | no | no | no |
| `primaryAudioOutPortId` | `audio` — a glyph **BINDS** | `audio` — a glyph **BINDS** | **null** → `glyph:'none'` | **null** → `glyph:'none'` |
| compact cap | 2 (`…WITH_GLYPH`) | 2 | 3 | 3 |
| DSP shape | own worklet | own worklet + shared ladder lib | **plain Web Audio graph** | **plain Web Audio graph, no DSP at all** |
| card passes `readLive` | yes, both knobs | yes, both knobs | **yes, both** | **yes, all three** |
| non-param card affordance | ⚠ `role="radiogroup"` LIN/EXP | ⚠ `role="radiogroup"` 1/2/3 | none | none |
| `raw-write-ledger` | ⚠ **`mode`, kind `debt`** | ⚠ **`range`, kind `debt`** | — | — |
| in `STRICT_DOCS` | yes (`:94`) | yes (`:95`) | yes (`:132`) | yes (`:136`) |
| VRT | `EXEMPT_FROM_VRT:916` | `EXEMPT_FROM_VRT:899` | ⚠ **`STRICT_VRT_MODULES:1170`** | ⚠ **`STRICT_VRT_MODULES:1181`** |
| ART | ⚠ **`ART_BACKLOG` — no profile** | `art/scenarios/moog904a` — ⚠ but it drives the LADDER LIB, not the worklet | ⚠ **`ART_BACKLOG`** | ⚠ **`ART_BACKLOG`** |
| `rack-sizes` | 1u / 2hp | 1u / 2hp | 1u / 1hp | 1u / 2hp |
| `DESCRIPTIONS` | present | present | present | present |
| `PUSH_CARD_CONTROLS` | none → GENERIC tier | none | none | none |
| multi-state enum with no `options[]` | 1 (`mode`, `discrete`) | 1 (`range`, `discrete`) | 0 | ⚠ **3 (`route1..3`, declared `linear` — #1911)** |

- **⚠ ALL FOUR CARDS ALREADY PASS `readLive` ON EVERY KNOB** — 11 knobs, 11
  `readLive`s. §26.1 said this for its cohort and it is re-verified here rather
  than inherited: **"a face fixes a live CV defect" is NOT available as a merit
  argument in the Moog family.**
- **TWO OF THE FOUR PAY A LEDGERED DEBT.** `raw-write-ledger.ts` lists
  `Moog902VcaCard.svelte` → `['mode']` and `Moog904aVcfCard.svelte` → `['range']`,
  both `kind: 'debt'`, both *"panel switch write — user gesture, should be
  undoable + synced"*. Those switches call `patch.nodes[id].params.X = v`
  directly instead of `setNodeParam`. **A def-driven face routes through the
  normal param path, so promotion pays the debt** — and the PR **must DELETE the
  ledger entry**, because the ledger is anchored to the artifact and an entry
  naming a write that no longer exists is RED.
- **BUT THE SAME SWITCHES ARE A STOP 2 LOSS.** Those two radio groups are the
  ONLY place `LIN`/`EXP` and the RANGE positions are named. `options[]` is FREE
  on an audio def (`contract-signature.ts`'s projection reads
  `id/min/max/curve/defaultValue/units`, so a `ParamOption` roster costs no
  `contract-lock.txt` line, and audio defs are outside the WebGL basis so attest
  is NIL) — ⚠ but `curve` **is** projected, so `moog993`'s `linear → discrete`
  edit costs a `docs:accept`. Same asymmetry as Q37.
- **All four cards wrap `ui/modules/moog/MoogPanel.svelte`, and a def-driven face
  inherits NEITHER of its two accessibility fixes** (`:165-177` re-points the
  washed-out label tokens including `.range-label` / `.mode-label`; `:190-199`
  re-points the patch-panel subtree). Raised at Q28, unresolved, and it now
  applies to four more. **State what replaces them, in every one of these PRs.**
- **`_face-fixtures.ts` cannot be harmed by any of these four**, checked rather
  than assumed: the audio pool requires the picked module to mount a
  `<NeonFader>`, and **none of the four cards contains the string** (all mount
  `Knob`). Promoting them cannot empty the pool.
- **`DESCRIPTIONS`: not owed** — all four are already in `module-manifest.ts`.
  What the face PRs owe is docs ACCURACY, and #1912/#1913/#1914 are where the
  inaccuracies are.
- **CI wall-time, priced.** `faces-parity` budgets roughly `10 s + 0.8 s/cell`:
  902 → 12.4 s, 904a → 12.4 s, 912 → 11.6 s, 993 → 12.4 s. **All four in one
  wave ≈ 48.8 s**, plus 8 new face VRT scenes (compact + dock each). Under the
  ~2 min bar. **Declare no `face.sidebar` on any of the four** — it is the one
  contract-projected `face` field, and `faceplate-platform.spec.ts`'s
  `sweepBudgetMs(adopterCount)` scales with the sidebar roster.
- ⚠ **TWO of the four move a COMMITTED STRICT baseline** (`moog912`, `moog993`),
  where §26's cohort moved one. Budget for it.
- **SCREEN ON/OFF: n/a.** All four are `domain: 'audio'`; the 2026-08-18 owner
  ruling scopes that cell to video modules.
- **TABBED RULING: none of the four is control-heavy.** 3/3/2/3 controls against
  `DOCK_TAB_MIN_BANDS = 7`. Honest page counts are **2 / 2 / 1 / 1**, and the two
  1-page entries say so instead of inventing a second idea. The one genuinely
  heavy candidate was `moog960`, and it is §27.2.

### 27.4 Q38 · `moog902` — a RESPONSE switch that is really a level control, and a ceiling the docs put 1.5 V too low

**Merit: YES.** 3 params, 3 inputs (1 `audio` + 2 `cv` `paramTarget`), 2 `audio`
outputs.

**What it is FOR, musically.** It is the rack's only DIFFERENTIAL VCA: level as a
voltage, with a bit-exact phase-inverted twin on a second jack. The verb a player
performs is **shaping loudness from a control voltage** — envelope into CV for
dynamics, LFO for tremolo. The one thing it does that `vca` does not: **two
summing control jacks land on ONE gain** (`cv` scaled by a depth knob, `fcv`
straight), and the sum is in VOLTS, not in a 0..1 amount.

**Control-heavy: NO.** Three controls. Honest page count **2**. Nowhere near
`DOCK_TAB_MIN_BANDS = 7`, and there is no honest third idea.

**THE RANKING ARGUMENT, FROM THE DSP.** The law is
`control = gain·6 + fcv + cvAmount·cv` volts, then `LINEAR: g = control/3`
or `EXP: g = EXP_A·(e^(control/5.0102) − 1)`, clamped to ×3.

Measured on the shipping worklet, 220 Hz sine at amplitude 0.5, steady state
read over the last half second:

| param | range | default | delivered at the default | authority |
|---|---|---|---|---|
| `gain` | 0…1, linear | **0.5** | **×1.000000000 (0.0000 dB)** — exactly unity | the whole level, 0 → ×3 |
| `mode` | 0…1, discrete | **0** (LINEAR) | flipping it costs **−2.9841 dB** | up to **−5.4525 dB**, on no dial movement |
| `cvAmount` | −1…1, linear | **1** | nothing | ⚠ **bit-exactly inert at spawn** |

**Rank order: `gain, mode, cvAmount`.**

- **`gain` is rank 1 on UNCONDITIONAL APPLICABILITY.** With nothing patched it is
  the only control that does anything, and its shipped default is *exactly*
  unity — bisected, LINEAR crosses 0 dB at gain knob **0.499999985** (= 3.000000 V).
  `gain = 0` is true silence (the smoother reaches bit-exact zero 10 307 samples
  = 214.729 ms after spawn).
- **`mode` is rank 2 because it is a LEVEL control wearing a character switch's
  clothes.** The two laws agree ONLY at the two anchors:

  | knob | volts | LINEAR dB | EXP dB | delta |
  |---|---|---|---|---|
  | 0.05 | 0.30 | −20.0000 | −25.4525 | **−5.4525** |
  | 0.25 | 1.50 | −6.0206 | −10.4018 | −4.3812 |
  | **0.50 (default)** | 3.00 | **0.0000** | **−2.9841** | **−2.9841** |
  | 0.75 | 4.50 | 3.5218 | 1.9986 | −1.5232 |
  | 1.00 | 6.00 | 6.0206 | 6.0206 | 0.0000 |

  Unity moves with it: **0.499999985 in LINEAR, 0.641521305 in EXP.**
  ⚠ **This argument would be WRONG for most mode switches**, which are
  level-matched by design — that is the test. It is defended by the measurement,
  not by "switches rank high".
- **`cvAmount` is rank 3 on INERTNESS AT SPAWN.** With `cv` unpatched, **41 of 41**
  sampled positions across −1…1 render bit-identically. Positive control: with
  `cv` held at 1 V it moves the gain to **0.666667 / 1.000000 / 1.166667 /
  1.333333** at cvAmount −1 / 0 / 0.5 / 1. Negative control on the instrument
  itself: nudging `gain` 0.5 → 0.6 is correctly NOT bit-identical.

**Tier ladder as a sentence:** a glyph BINDS (`live-audio` on `audio`), so the
compact cap is `LANE_ROW_MAX_CELLS_WITH_GLYPH = 2` — at mini you get GAIN; at
compact GAIN and RESPONSE; at plate and dock all three. **Rank 3 is
effectively plate-and-up**, which is exactly right for the one control that does
nothing until a cable arrives.

**Pages (2):** `gain` = `gain, cvAmount` · `response` = `mode`. ⚠ `order` and
`pages` DISAGREE deliberately — `order` puts the level-moving switch second by
priority, `pages` separates by kind (two continuous level controls vs one law
selector). Say so in the comment. The `response` page is a 1-control band and
earns its header on the skill's "1 that is the module's identity" clause: a 902
IS its LIN/EXP law.

**GLYPH: `'meter'`.** Run, not reasoned (§27.9): `primaryAudioOutPortId` returns
`audio`, and both `'meter'` and `'waveform'` resolve to `live-audio:audio`.
`'meter'` is the honest pick — a VCA's entire job is level, and the module's
sharpest defect (the mode switch moving level silently) is exactly what a meter
shows.

**READOUTS — params-only, so `FaceReadoutValue` can see all of them.**

| `valueId` | formula | at the defaults | the negative control a KNOB READBACK fails |
|---|---|---|---|
| `moog902-gain-db` | `20·log10(g(gain·6, mode))` | **0.0000 dB** | flip MODE: **0.0000 → −2.9841 dB while the GAIN dial never moves** |
| *(optional)* `moog902-headroom-db` | dB from here to the ×3 ceiling | 9.5424 dB | moves on MODE too, and differently (the ceiling is at 9 V vs 7.5 V) |

⚠ **Do NOT read the no-resting-decimals ruling as banning these.** That ruling
deleted `persistentReadout` — the PER-CONTROL decimal. `FaceReadout.valueId` and
the readout ROW below the hero are alive. Totality legs are mandatory: `gain` at
exactly 0 (−∞ dB — print `−∞` or `MUTE`, not `NaN`) and exactly 1, plus NaN and
±Infinity.

**`bareCells`: NO, decided rather than skipped.** GAIN / CV / RESP are three
different things; the captions are not restating a section heading. This is the
tidyVco `A`/`D`/`S`/`R` side of the ruling, not the mixmstrs `1LO…8LO` side.

**STOP 2: ⚠ NOT CLEAN — and the card was READ, not just grepped.** The grep hits
`<button`: `Moog902VcaCard.svelte` owns a `role="radiogroup"` segmented switch
(`data-testid="moog902-mode-switch"`) with two `role="radio"` buttons labelled
**`LIN`** and **`EXP`**. Those two strings are the ONLY place the mode names
exist in the tree — the def has no `options[]`. **The face MUST declare
`options[]` on `mode`** or promotion deletes the names. Everything else is 2
`<Knob>` + `<PatchPanel>` + `<MoogPanel>`; no `<span>` readout, no `node.data`.

**⚠ RAW-WRITE DEBT PAID — AND THE LEDGER ENTRY MUST BE DELETED.**
`setMode(v)` writes `patch.nodes[id].params.mode = v` directly (the knobs use
`setNodeParam`). `raw-write-ledger.ts` lists it as `kind: 'debt'`. A face routes
it normally, so the debt is paid — and the entry then names a write that does not
exist, which is RED. **Delete it in the same PR.**

**⚠ ENROL / RETIRE `RANGE_BOUND_CARDS`.** The card hand-types
`min={0} max={1} defaultValue={0.5}` and `min={-1} max={1} defaultValue={1}`.
They AGREE with the def today, so nothing is red — the `AnalogLogicMathsCard`
case exactly. Promotion makes the dock read the `ParamDef` and the card its own
literals; since the card stops rendering, the clean answer is that it goes away
with the card, but say which you did.

**Push 2:** no `PUSH_CARD_CONTROLS` entry → GENERIC today, moves to the FACE
tier. The golden diffs by the swap of slots 2 and 3 (declaration order
`gain, cvAmount, mode` → face order `gain, mode, cvAmount`). Accept deliberately,
with the reason written in the test.

**VRT:** `EXEMPT_FROM_VRT:916`. ⚠ Its reason names *"a 2-position LIN/EXP switch"*
on a card that stops rendering — a ledger entry describing an artifact that no
longer exists is RED — **and it separately claims ART coverage that does not
exist** (`moog902` is in `ART_BACKLOG`, `profile-coverage.ts:92`; there is no
`art/scenarios/moog902/`). Fix both in the face PR. Two new
`face-moog902-*.png` scenes need a `FACES` entry `{ type: 'moog902', pages: 2 }`
in `e2e/vrt/_shell-faces.ts`.

**Rear card:** 3 input holes, 2 outputs. ⚠ **`cv` and `fcv` BOTH declare
`paramTarget: 'gain'`** — two jacks onto one control, deliberate and documented
(`art/scenarios/cv-terminal/cv-terminal.test.ts:178-179` records that the
aliasing leg has no object to collide because neither publishes an AudioParam).
**Check `rearFieldPlan` against that collision before declaring
`face.rear.groups`** — it is the one shape in this cohort the rear model has not
obviously seen. `audio` has no `paramTarget` and is the orphan.

**DEFECT FILED, not folded in: #1912** — the ×3 ceiling is documented at "~7.5 V"
unconditionally in three places, but bisected it is **9.000000 V in LINEAR (the
default)** and **7.499999 V in EXP**; at 7.5 V LINEAR delivers ×2.500000. Plus
the unnamed mode level delta above, plus the false ART-coverage claim in the VRT
exemption.

**Also measured, not a defect, worth one sentence of boy-scout docs:**
`audio_inv` is **bit-exactly `−audio` on all 48 000 samples** (worst `|a+b| = 0`).
The def says "sample-accurate phase-inverted twin"; "bit-exact" is stronger and
free to say.

**RISK: LOW.** No DSP change, no ART move, no committed VRT baseline moved,
attest NIL, `docs:accept` not required (`options[]` is unprojected; `curve` does
not change). The face is a pure surface addition over a module that works.

### 27.5 Q39 · `moog904a` — a cutoff dial that declares Hz and delivers three different frequencies for the same number

**Merit: YES.** 3 params, 3 inputs (1 `audio` + 2 `cv`), 1 `audio` output.

**What it is FOR, musically.** It is the rack's transistor-ladder 24 dB/oct
low-pass — the one filter that stops being a filter and becomes an oscillator.
The verb is **darkening and opening a sound, and finding the edge where the
filter starts to sing**. What `filter` and `resofilter` do not do: a RANGE switch
that relocates the whole sweep, and a resonance that crosses into a bounded
self-oscillating sine.

**Control-heavy: NO.** Three controls. Honest page count **2**.

**THE RANKING ARGUMENT, FROM THE DSP.** `cutoffHz = cutoffKnob · rangeMultiplier(range) · 2^cutoff_cv`,
clamped to 20 kHz, into a 4-pole TPT ladder whose composite −3 dB point sits at
**0.43419×** the internal `fc` (measured; textbook 0.43501 — the instrument's own
validation).

Measured on the shipping worklet, corner bisected with a Hann-windowed
single-bin DFT:

| param | range | default | delivered at the default | authority |
|---|---|---|---|---|
| `cutoff` | 20…20 000 Hz, log, `units: 'Hz'` | **1000** | **−3 dB at 1769.51 Hz** (dial says 1000) | ×1.7695 at RANGE 2 |
| `range` | 1…3, discrete | **2** | ×4 on the dial | **×0.4347 … ×9.8515** — a **22.66×** spread |
| `regeneration` | 0…1, linear | **0** | flat | filter below **0.665373**, OSCILLATOR above |

**The headline, one dial, three meanings** — dial pinned at 1000 Hz, RANGE swept:

| RANGE | dial says | delivered −3 dB corner | ratio |
|---|---|---|---|
| 1 | 1000 Hz | **434.67 Hz** | ×0.4347 |
| **2 (default)** | 1000 Hz | **1769.51 Hz** | ×1.7695 |
| 3 | 1000 Hz | **9851.52 Hz** | ×9.8515 |

**Rank order: `cutoff, regeneration, range`.**

- **`cutoff` is rank 1 on UNCONDITIONAL APPLICABILITY.** Every patched signal
  passes through it, at every setting of everything else.
- **`regeneration` is rank 2 because it is the only control that changes the
  module's CLASS.** Bisected, **regen = 0.665373** is where a silent, unpatched
  904a starts emitting: below it the self-osc tail peaks at `4.397e-7`, above it
  at `4.375e-1`. That is not a change of degree. ⚠ **This argument would be WRONG
  for `resofilter`**, whose Q never reaches self-oscillation — the coupling is a
  property of a ladder with tanh feedback, not of resonance.
- **`range` is rank 3 despite being the biggest number in the entry**, and the
  demotion is the defensible part: it multiplies what rank 1 already does, and it
  is a set-once placement switch, not a performance control. **Its consequence
  belongs in a READOUT, not in a rank.**

**Tier ladder as a sentence:** a glyph BINDS (`live-audio` on `audio`), so the
compact cap is 2 — mini gives CUTOFF; compact CUTOFF and REGEN; plate and dock
all three, with RANGE only ever visible where the readout that explains it is
also visible.

**Pages (2):** `filter` = `cutoff, range` · `resonance` = `regeneration`.
⚠ `order` and `pages` DISAGREE deliberately — `order` ranks by what a player
reaches for, `pages` groups the two controls that jointly determine one frequency.
Say so in the comment.

**GLYPH: `'waveform'`.** Run (§27.9): `primaryAudioOutPortId` returns `audio`;
`'meter'` and `'waveform'` both resolve `live-audio:audio`. `'waveform'` because
this module's signature event — the ladder breaking into a sine — is a SHAPE, and
a meter would read the same for a filter sweep and a limit cycle.

**READOUTS — the strongest part of this entry.**

| `valueId` | formula | at the defaults | the negative control a KNOB READBACK fails |
|---|---|---|---|
| `moog904a-corner-hz` | `cutoff · rangeMultiplier(range) · 0.43419` | **1769.5 Hz** vs a dial reading 1000 | hold CUTOFF at 1000, sweep RANGE: **434.67 → 1769.51 → 9851.52 Hz while the dial never moves** |
| `moog904a-state` | a NAME: `FILTER` below regen 0.665373, `OSC` above | `FILTER` | the REGEN dial reads the same 0.66 either side of a class change |

⚠ **`moog904a-state` is a NAME, not a number, and that is deliberate** — the
owner ruling permits a readout whose text is a declared landmark NAME (a name
disambiguates otherwise-identical states; a number restates the dial).
⚠ The corner formula inherits the cascade constant's **0.19 %** error against
textbook (0.43419 measured vs 0.43501); round the readout to whole Hz and it
never shows.

> **⛔ CORRECTION (builder, 2026-08-19, #1919 — THE LARGEST ERROR IN THIS
> SECTION).** The 0.19 % figure is true only at LOW frequency, and the readout
> was REJECTED on the measurement rather than shipped. `0.43419` is the
> 4-pole cascade's low-frequency limit, but the ladder is a TPT/ZDF design whose
> `tan` prewarp compresses the mapping as the corner approaches Nyquist — so the
> error is a FUNCTION OF WHERE YOU ARE, not a bias. Measured on the shipping
> worklet with a Hann-windowed single-bin DFT over the settled tail, dial 1000:
>
> | RANGE | internal fc | measured corner | this formula | error |
> |---|---|---|---|---|
> | 1 | 1000 Hz | 434.02 Hz | 434.19 | **−0.04 %** |
> | 2 | 4000 Hz | 1766.87 Hz | 1736.76 | **−1.70 %** |
> | 3 | 16000 Hz | 9840.59 Hz | 6947.04 | **−29.40 %** |
>
> Nearly half an octave wrong exactly where this module's headline claim lives.
> The prewarped closed form `(sr/π)·atan(tan(π·fc/sr)·√(2^¼−1))` tracks to
> 0.25–0.34 % across all three, but needs the SAMPLE RATE, which a
> `FaceReadoutValue` cannot reach. **What shipped is `moog904a-cutoff-hz` — the
> DELIVERED cutoff (`cutoff × rangeMultiplier`, clamped) — which is exact,
> rate-independent, and is the frequency the self-oscillation actually sings at
> (197.645 Hz where it says 200) rather than the corner (86.838 Hz there).**

**`bareCells`: NO.** CUTOFF / REGEN / RANGE are three different things.

**STOP 2: ⚠ NOT CLEAN.** `Moog904aVcfCard.svelte` owns a `role="radiogroup"`
(`data-testid="moog904a-range-switch"`) with three `role="radio"` buttons labelled
`1` / `2` / `3`. Less prose is lost than on the 902 — but the ×1/×4/×16 MEANING
is nowhere on the card either, so `options[]` should carry it (`1 (×1)` /
`2 (×4)` / `3 (×16)`) and the face is a strict improvement. Otherwise 2 `<Knob>`
+ `<PatchPanel>` + `<MoogPanel>`; no `<span>` readout, no `node.data`.

**⚠ RAW-WRITE DEBT PAID — DELETE THE LEDGER ENTRY.** `setRange(v)` writes
`patch.nodes[id].params.range = v` directly; `raw-write-ledger.ts` lists
`Moog904aVcfCard.svelte` → `['range']`, `kind: 'debt'`. Same obligation as Q38.

> **⛔ CORRECTION (builder, 2026-08-19, #1916/#1919). The entry was KEPT on both
> modules, and deleting it would have turned the gate red.** The premise —
> "promotion pays the debt" — is false: **promotion does not delete the card
> FILE.** `migrated()` only stops both surfaces RENDERING it, so
> `target.params.range = v` still exists in the source, `mutate.guard`'s scan is
> textual over the tree, and an entry removed while the write remains fails its
> deny-by-default direction (a write in neither bucket with no inline marker is
> RED). Verified against the precedent rather than argued: `moog921Vco` was
> promoted three commits before this batch, its card and its ledger entry both
> survive, and `mutate.guard` is green on main. Confirmed green with the entries
> kept (7 passed). **The same correction applies to Q38's identical instruction.**

**⚠ `RANGE_BOUND_CARDS`:** the card hand-types `min={20} max={20000}
defaultValue={1000}` and `min={0} max={1} defaultValue={0}`. Same call as Q38.

**Push 2 / VRT / rear:** no `PUSH_CARD_CONTROLS` entry (GENERIC → FACE).
`EXEMPT_FROM_VRT:899` — its reason also names a card that stops rendering; re-word
it. Two new `face-moog904a-*.png` scenes plus `{ type: 'moog904a', pages: 2 }` in
`_shell-faces.ts`. Rear: `cutoff_cv` (⚠ the only `cvScale`-free 1 V/oct jack here
— `PASSTHROUGH_BY_DESIGN`) and `reso_cv` map 1:1 onto their params; `audio` is the
orphan.

**DEFECT FILED, not folded in: #1913 — flagged OWNER EARS** (pitch and level).
The self-oscillation is documented as *"a clean sine at the cutoff frequency"*
and measures **0.224 to 3.578 semitones FLAT**, growing with `fc`; it **does not
track 1 V/oct as an oscillator** (+2.88162 oct at +3 V) even though the FILTER
corner does (+3.00421 oct); it **exceeds full scale** (peak 1.184569 at regen 1);
and the resonance emphasis **peaks at regen ≈ 0.7 (−6.6062 dB) then falls to
−9.5267 dB at max**, against DESCRIPTIONS' *"turned toward max it sharpens into a
strong resonant peak"*. Also in #1913: the top **20.07 %** (RANGE 2) and
**40.14 %** (RANGE 3) of the CUTOFF dial are bit-exactly one filter, and the ART
scenario drives the ladder LIB with a **hand-copied** `DRIVE = 0.5 + REGEN * 0.8`
rather than the worklet.

**⚠ AND ONE THING THE FACE PR MUST NOT ASSUME: `moog904a` IS NOT
BIT-DETERMINISTIC ABOVE `regeneration = 0`.** The thermal-noise dither is
`(Math.random() − 0.5) · 6e-6 · regen⁴`. Two identical renders are bit-equal at
regen 0 and **bit-different at 0.25 / 0.5 / 0.9 / 1**. Any assertion this PR adds
must not compare renders bit-exactly with resonance up. (It does not flake ART
today only because ART never runs the worklet.)

**RISK: LOW for the face.** #1913 is a report, NOT a prerequisite — Q39 ships
against the DSP as it stands and its readouts describe the shipping behaviour.

### 27.6 Q40 · `moog912` — two knobs, and the bottom sixth of one of them cannot open the output it exists to open

**Merit: YES, and it is the closest STOP 1 call in this cohort — say so.** 2
params, 1 `audio` input, 1 `cv` + 1 `gate` output.

⚠ **STOP 1, worked explicitly.** The refuse rule fires when **all** of these hold:
≤2 params · no control families · no `node.data` affordances · **no derived
quantity worth a readout**. `moog912` has 2 params, no families and no
`node.data` — three of four. It survives **only on the fourth clause**, and it
survives it decisively: the SMOOTH knob's real unit is invisible, and the GATE's
threshold in input dBFS is a number nothing on the module prints. This is the Q36
`moogCp3` precedent ("the merit is the READOUT, not the ranking"). **If the
readouts are cut in review, the entry becomes NO FACE ON MERIT — it does not
degrade to a thin face.**

**What it is FOR, musically.** It is the rack's only ANALYSIS module: it turns
*"how loud is this right now"* into a CV plus an *"is it playing"* gate. The verb
is **making one sound play another** — a drum loop opening a filter, a vocal
firing an envelope.

**Control-heavy: NO.** Two controls. **Honest page count 1** — both knobs are the
same idea (how the follower listens), so `pages` is OMITTED and the dock is
single-page. ⚠ Do NOT invent a second page to get a header; the skill is explicit
and a page costs ~81 px on a dock that folds at 720p.

**THE RANKING ARGUMENT, FROM THE DSP.** The chain is
`inputGain(sens) → |x| → lowpass(smoothingToCutoffHz(smooth)) = ENV → step(0.1) = GATE`,
and `GATE_THRESHOLD = 0.1` is a **CONSTANT that does not scale with SENS**.

Measured by driving the real factory against a stub context (wiring and param
maps — no audio was rendered):

| param | range | default | delivered at the default | authority |
|---|---|---|---|---|
| `sensitivity` | 0…1, linear | **0.7** | gate opens at input amplitude **0.224399 (−12.980 dBFS)** | ⚠ below **0.157080** the GATE can NEVER fire |
| `smoothing` | 0…1, linear | **0.5** | **7.071068 Hz**, τ 22.5079 ms, 10–90 % rise **49.4549 ms** | 1…50 Hz inverted = **5.6439 octaves** |

**Rank order: `sensitivity, smoothing`.**

- **`sensitivity` is rank 1 because it is the only control that can silence an
  output.** Derived from the real curve builders plus the DC gain of a lowpass
  (mean |sin| = 2/π): the gate needs `A ≥ π·0.1/(2·sens)`, so **below
  `sens = 0.157080` — the bottom 15.71 % of the dial — the GATE output cannot
  fire even on a full-scale sine.** ⚠ This argument would be WRONG for a follower
  whose threshold scales with sensitivity, which is the usual design; it is
  defended by `GATE_THRESHOLD` being a bare constant.
- **`smoothing` is rank 2**: it shapes the contour and never gates it. It is not
  inert — every position changes the ENV — it is just strictly less consequential.

**Tier ladder as a sentence:** the glyph MUST be `'none'` (below), so the compact
cap is `LANE_ROW_MAX_CELLS = 3` — **both controls fit at compact**, and the tier
ladder only bites at mini, which shows SENS. That is the whole ladder; say it in
one line rather than pretending there is a hierarchy to unfold.

**GLYPH: `'none'`, and it is FORCED.** Run (§27.9): the outputs are `env` (`cv`)
and `gate` (`gate`), so `primaryAudioOutPortId` returns **null** and `'meter'`,
`'waveform'`, `'envelope'` and `'algorithm'` **all resolve to `{kind:'static'}`**
— the dead-glyph state. ⚠ **`'envelope'` does not rescue it either**: the resolver
keys on four params literally named `attack`/`decay`/`sustain`/`release`, and this
module has `sensitivity`/`smoothing`. Same mechanism as #1888.

**READOUTS — the merit.**

| `valueId` | formula | at the defaults | the negative control a KNOB READBACK fails |
|---|---|---|---|
| `moog912-response-ms` | `1000·ln(9)/(2π·smoothingToCutoffHz(s))` | **49.4549 ms** | sweep SMOOTH 0 → 1: **6.9940 → 349.6992 ms**, a 50× swing the 0..1 dial cannot suggest |
| `moog912-gate-dbfs` | `20·log10(π·0.1/(2·sens))`, `—` when > 0 dBFS | **−12.980 dBFS** | sweep SENS: −16.078 / −10.057 / −5.620 / **`—` (unreachable) below 0.157080** |

⚠ **`moog912-gate-dbfs` is DERIVED ARITHMETIC over the real curve builders, not a
driven render** — no `BiquadFilterNode` was run. It is load-bearing for rank 1, so
the builder should confirm it against a real graph before shipping the readout.
Totality legs: `sens = 0` (→ `—`), `sens = 1`, NaN, ±Infinity.

> **✅ CONFIRMED (builder, 2026-08-19, #1927) — and this section asking for it is
> the reason it got checked.** `art/scenarios/moog912/face-audit.test.ts` now
> drives the SHIPPING factory through a real `node-web-audio-api`
> `OfflineAudioContext` at 48 kHz — real GainNode, rectifier, biquad, gate
> shaper. **The settled envelope lands on 0.100001 against a threshold of
> 0.100000.** The arithmetic was right, and it is now anchored to a render.
>
> ⚠ **But the FIRST instrument was wrong, and the failure is instructive.**
> Bisecting on "did the gate EVER open" reported **−14.488 dBFS** against this
> section's −12.980 — reading exactly like "the spec is wrong by 1.5 dB". It was
> not: the envelope OVERSHOOTS its own steady state on attack by a constant
> **1.1861×** (measured at every amplitude tried, as a linear system must). So
> the module has **two** thresholds — a sound ~1.5 dB below the sustained one
> still BLIPS the gate and drops it. Both are now asserted, in both directions.
>
> **⛔ CORRECTION to the row above: `moog912-response-ms` was REJECTED, not
> shipped.** That closed form is the ONE-POLE 10–90 % rise; the shipping filter
> is a BIQUAD at Q = 0.5 and a `FaceReadoutValue` cannot run one, so it would
> have been a model — measured **~30 % off** at the fast end (4.917 ms rendered
> vs 6.994 ms modelled). Worse, the rendered figure is itself the least reliable
> number in the audit: at SMOOTH 0 the cutoff is 50 Hz while the rectified
> 220 Hz tone ripples at 440 Hz only ~19 dB down, so the crossings ride ripple.
> Two uncertain numbers are not a readout. **What shipped is
> `moog912-response-hz` — `smoothingToCutoffHz`, the EXACT value the factory
> writes into `envFilter.frequency`, imported from the module.** It earns its
> place on the same evidence: the dial is a bare 0..1 over an INVERTED
> logarithmic map, 50 Hz at 0 and 1 Hz at 1, 5.6439 octaves, and 7.07 Hz at the
> shipped 0.5.

**`bareCells`: NO.** SENS and SMOOTH are the only thing separating two identical
linear knobs — the tidyVco case.

**STOP 2: CLEAN, and the card was READ line by line.** `Moog912Card.svelte` is 2
`<Knob>` + `<PatchPanel>` + `<MoogPanel>`. The grep finds no
`<button|<select|<input|oncontextmenu|manualTrigger|Toggle|Selector|accept=`, and
reading it finds no `<span>` readout and no `node.data`. Both knobs pass
`readLive`. No `raw-write-ledger` entry. The only losses are MoogPanel's two a11y
fixes (§27.3).

**⚠ VRT: THIS ONE MOVES A COMMITTED STRICT BASELINE.** `moog912` is in
`STRICT_VRT_MODULES` (`:1170`), not the exempt set — it has a captured linux
baseline that the promotion invalidates. Per the skill: **`git rm` the stale
baseline first**, because `--update-snapshots` cannot regenerate a
PASSING-but-stale one; then `git status` for untracked PNGs afterwards; then
**count the files the bot commits against what you predicted**. Two new
`face-moog912-*.png` scenes, `{ type: 'moog912', pages: 1 }` in `_shell-faces.ts`.

> **⛔ CORRECTION (builder, 2026-08-19, #1927). The `git rm` would have been
> ACTIVELY WRONG here, and the baseline was RE-CAPTURED instead.**
> `vrt-meta.test.ts` asserts that **every `STRICT_VRT_MODULES` entry HAS a
> committed baseline** — so removing it reddens a gate rather than clearing the
> way. The `git rm`-first discipline is for a stale baseline whose diff falls
> UNDER the tolerance and therefore passes while wrong; a beige Moog card
> becoming a shell tile is nowhere near that, so the comparison fails loudly and
> the capture rewrites it. Precedent checked rather than assumed: `moog923` is
> promoted, in `STRICT_VRT_MODULES`, and its `moog923.png` is still there.
>
> ✅ **The "count the files against your prediction" instruction, though, is the
> part of this paragraph that paid.** Predicted 3 (2 face scenes + the
> re-captured card), and the scope derivation agreed — "3 of 371 tests · 2 of 31
> spec files". The bot committed **2**. The card baseline was NOT rewritten,
> which is exactly the sub-tolerance case this section warns about, one layer
> further out than expected. Left for `vrt-strict` to adjudicate on the merge
> commit, which is the gate that can actually see it.

**Push 2 / ART / rear:** no `PUSH_CARD_CONTROLS` entry (GENERIC → FACE); the
golden does NOT diff by order (declaration order and face order are the same two
ids) but it does move tier. `ART_BACKLOG` — no profile, so nothing to re-pin.
Rear: one input, two outputs, **no `paramTarget` anywhere** and **no CV inputs at
all** — so the whole rear takes the derived default and there is no orphan
question to answer.

**DEFECT FILED, not folded in: #1914** — the dead bottom of the SENS dial, the
unprinted Hz map, and a **NaN `smoothing` propagating straight into
`envFilter.frequency`**, after which ENV and GATE are dead until something writes
a finite value. (Out-of-range finite values clamp correctly; only NaN escapes.)

**Also worth one sentence of boy-scout docs:** `moog912` declares **no CV inputs
at all**, so neither knob can be modulated. That is defensible for an analysis
utility and it is why two knobs are the whole module — but `docs.explanation`
does not say it.

**RISK: LOW-MEDIUM.** One committed strict baseline moves; no contract change, no
ART, attest NIL.

### 27.7 Q41 · `moog993` — three routers whose dial has exactly TWO live positions out of 201, and the face would ship the bug

**Merit: YES — and Q41 is BLOCKED on #1911.** 3 params, 4 inputs (2 `gate` +
2 `cv`), 5 outputs (3 `gate` + 2 `cv`).

**What it is FOR, musically.** It is the rack's trigger switchboard: two clock
sources, three outputs, and a switch per output that picks which source it
carries — plus two CV thru-jacks. The verb is **re-pointing a clock without
re-patching**. What a multiple does not do: each of the three outs chooses
independently, so one source can drive all three (a 1→3 multiple) or the three
can be split between two clocks mid-performance.

**Control-heavy: NO.** Three controls, all the same control three times. **Honest
page count 1** — one `routing` band. ⚠ It is a CLUSTER question at most, not a
page question, and with three peers it is not even that.

**⚠ THE PREREQUISITE, AND IT IS THE SHARPEST THING IN THIS COHORT.** All three
routers declare **`curve: 'linear'`, `min: 0`, `max: 2`** — the only 3-state
selector in the Moog family not declared `discrete`. The DSP selects on **exact
equality**:

```ts
if (route === 1) return [1, 0];
if (route === 2) return [0, 1];
return [0, 0];              // everything else MUTES
```

Measured by driving the real factory and reading the live select gains:

| probe | result |
|---|---|
| 201 evenly-spaced positions on the 0..2 dial | **2 route anything** (exactly 1.0 and 2.0) |
| `1 ± Number.EPSILON`, `1.0000000001`, `0.9999999999`, `2 − 4ε` | **all SILENT** |
| one wheel notch from the default (`Knob.svelte:258` step 0.005 → value 1.01) | **SILENT** |
| respawn from a persisted `route1 = 1.4` | **SILENT ON RELOAD** |

And `readParam` reconstructs a snapped value from the gains, so **three different
numbers describe one control**: the store holds 1.4, the DSP routes nothing, and
`readLive` returns 0.

**A def-driven face renders `route1..3` straight off the `ParamDef`, and
`Knob.svelte` has no `discrete` branch — so the FACE WOULD SHIP THE BUG.** #1911
(`curve: 'discrete'` + `options[]` + `Math.round` in `selectGains`) is a
**PREREQUISITE**, exactly as #1887 was for Q37. ⚠ And it is the one edit in this
cohort that costs a **`docs:accept`**, because `curve` IS in the contract
projection while `options[]` is not.

**Rank order: `route1, route2, route3` — AND THE RANK IS DECLARATION ORDER, said
outright.** They are numbered peers, each bound to the identically-numbered output
jack. Presenting a reorder of a numbered switchboard as a redesign is §18's
anti-pattern 3, and Q36/`moogCp3` set the precedent: when the controls are
peers, **the merit is the READOUT and not the ranking**, and the entry should
say so instead of manufacturing an argument.

**Tier ladder as a sentence:** glyph `'none'` (forced, below) → compact cap
`LANE_ROW_MAX_CELLS = 3`, so **all three fit from compact upward**; mini shows
ROUTE 1. There is no truncation story to tell.

**Pages:** none — single-page dock, one `routing` band.

**GLYPH: `'none'`, and it is FORCED.** Run (§27.9): every output is `gate` or
`cv`, `primaryAudioOutPortId` returns **null**, and all four kinds resolve
`{kind:'static'}`.

**READOUT — this IS the merit.**

| `valueId` | formula | after #1911, at the defaults | the negative control three KNOB ANGLES fail |
|---|---|---|---|
| `moog993-routing` | a NAME triple, e.g. `1←A · 2←A · 3←OFF` | `1←A · 2←A · 3←A` | three knobs at 45° tell you nothing about WHICH source each out carries; the triple is the module's entire state in one line |

⚠ **Names, not numbers** — permitted by the owner ruling precisely because a name
disambiguates otherwise-identical states. ⚠ **This readout is not authorable
before #1911**, because today the honest text for a knob at 1.4 would be
`OFF`-that-looks-like-`FROM 2`.

**`bareCells`: NO, decided rather than skipped — and it is a genuine call.**
Under a `routing` heading, `Route 1 / 2 / 3` looks like the mixmstrs `1LO…8LO`
case the owner removed. It is not: the ordinal is the **output jack number**, and
without it you cannot tell which knob feeds OUT 2. That is disambiguation of
otherwise-identical controls — the tidyVco side of the ruling. Keep the captions.

**STOP 2: CLEAN, and the card was READ line by line.** `Moog993Card.svelte` is 3
`<Knob>` + `<PatchPanel>` + `<MoogPanel>`; no buttons, no selects, no `<span>`
readout, no `node.data`, all three knobs pass `readLive`, and there is no
`raw-write-ledger` entry. ⚠ Note the contrast with Q38/Q39: this module's
selector is a KNOB, which is exactly why its bug is live and theirs is not.

**⚠ VRT: THIS ONE ALSO MOVES A COMMITTED STRICT BASELINE.** `moog993` is in
`STRICT_VRT_MODULES` (`:1181`). Same `git rm`-first discipline as Q40. Two new
`face-moog993-*.png` scenes, `{ type: 'moog993', pages: 1 }` in `_shell-faces.ts`.

**Push 2 / ART:** no `PUSH_CARD_CONTROLS` entry (GENERIC → FACE); the golden does
not diff by order but does move tier — ⚠ and after #1911 the tier RE-RANKS anyway,
because `curve` changes. `ART_BACKLOG` — no profile.

**Rear card:** 4 input holes and 5 outputs. ⚠ **No input declares a
`paramTarget`**, so all four are orphans against `rearFieldPlan` — and the module
splits cleanly into two ideas the rear should mirror: a `routing` group
(`trig_from1/2` → `trig_out1/2/3`) and a `thru` group (`env_in1/2` → `env_out1/2`,
which no control touches at all). Both env passthroughs measure **unity gain
exactly**.

**DEFECT FILED, and it is a PREREQUISITE not a report: #1911.**

**RISK: MEDIUM.** A prerequisite issue that changes a contract-projected field
(`curve` → `docs:accept`), plus a committed strict baseline. Sequence it last.

### 27.8 THE ADVERSARIAL PASS — what I attacked in my own spec, and what survived

Per `module-adversarial-audit.md`. Recorded because *"verified X by measuring Y"*
beats *"X is true"* — and because **five of these attacks succeeded against me,
one of them against my module PICK.**

**⚠ ATTACK 1 — SUCCEEDED, and it produced four confident wrong numbers that were
internally consistent.** My first `moog902` probe passed an `input(ch, i)` closure
that ignored `ch`, so the 220 Hz test sine was fed into **all three worklet inputs
— including `cv` and `fcv`**. It reported unity at gain knob 0.477063194, the
shipped default at ×1.04565, `gain = 0` delivering ×0.143082, and *"cvAmount is
NOT inert"*. Every one of those is wrong. **The tell was `gain = 0`**: a 0 V
control sum is silence by construction in the law I had just finished reading, so
a non-zero output could only be the instrument. Corrected: unity is exactly 0.5,
the default is exactly ×1.000000000, and cvAmount is bit-inert at 41/41. **A
multi-input worklet probe must be channel-aware; "the same signal everywhere" is a
patched module, not a bare one.**

**⚠ ATTACK 2 — SUCCEEDED, and it is §26.7's window lesson repeating in a new
place.** My `moog904a` dead-dial bisection compared WHOLE buffers and reported the
top **0.00 % / 0.00 % / 6.17 %** of the CUTOFF dial as bit-identical to max.
Comparing the SETTLED TAIL instead gives **0.00 % / 20.07 % / 40.14 %**, and the
boundaries land exactly on the predicted clamp points (20000 ÷ ×1/×4/×16 = 20000 /
5000 / 1250). Both runs were right about their own window: `smCutoff` smooths the
RAW dial in Hz **before** the multiply-and-clamp, so two dials that settle to the
same clamped filter travel there differently. The negative control (2 % below each
boundary, correctly differing, `lastDivergent 23999`) is what made the second
answer believable rather than merely preferable.

**⚠ ATTACK 3 — SUCCEEDED against a claim I had already written down, and the
correction is the subtlest thing here.** One probe told me *"`cutoff_cv` is NOT
1 V/oct"* — +1 V read ×2.1207 and +2 V read ×5.567 against the wanted ×2 and ×4.
Re-measured with the corner kept well below Nyquist (dial 200 Hz, RANGE 1):
**+1.00019 / +2.00100 / +3.00421 oct.** The first reading was the TPT `tan`
prewarp near Nyquist — my instrument, not the DSP. Positive control: doubling the
dial 200 → 400 Hz reads +1.00019 oct, the *same* residual, so the residual is the
bisection's resolution and not an error. ⚠ **But the same DSP genuinely fails the
same test as an OSCILLATOR** (+2.88162 oct at +3 V, #1913). So *"moog904a is
1 V/oct"* and *"moog904a is not 1 V/oct"* are BOTH true, and the question is only
answerable by naming WHICH QUANTITY. **This is the claim in this cohort a builder
should re-check first.**

**⚠ ATTACK 4 — SUCCEEDED against my module PICK, which is the one I did not
expect.** I chose `moog960` as the fourth on cohort continuity and 36 params, and
had already started the entry. Reading the card line by line (not grepping it)
found a live column playhead and a `▶ RUN / ■ STOP` readout, neither a `ParamDef`;
running the real glyph resolver returned `static` for all four kinds; then counting
the cohort found **eight of eight playhead siblings classified `bespoke-surface`
and `moog960` alone `generic-face`**. The pick was wrong AND the inventory row is
wrong (#1915). §27.2 records it. **A disposition in a GENERATED artifact is still
a hypothesis** — §23-20's lesson, now including the ones this repo generates
about itself.

**⚠ ATTACK 5 — SUCCEEDED, a near-miss caught before it reached an issue.** I was
about to file `smoothingToCutoffHz(0)` returning **49.99999999999999** instead of
50 as a defect. It is the same number my own table printed as `50.000000` at 6
decimal places — `exp(ln 50)` does not round-trip. Recorded here so nobody
re-files it, and as the reason the 912 entry prints its Hz column at 6 dp rather
than rounding.

**ATTACK 6 — "the `moog993` dial bug is theoretical; surely the card quantizes."
DISPROVEN by reading the CONSUMER**, which is §26.7's ATTACK 2 rule applied
deliberately this time. `Knob.svelte` has **no `discrete` branch** — `fracToValue`
for `linear` is `min + fr·(max − min)` — and the wheel step is 0.005 in normalized
space, so from the default (`route = 1`, frac 0.5) **one wheel notch is 1.01 and
the output goes silent**. The bug is live on the shipping card, not latent.

**ATTACK 7 — "Q38 and Q39 are one entry: same family, same panel, same
switch-plus-two-knobs shape."** Attacked with Q28's pairing test rather than by
taste. A named shared bus? No. Cross-references in either direction? Zero. The
same merit argument? **No** — the 902's is that a switch silently changes LEVEL;
the 904a's is that a switch silently changes WHAT THE DIAL MEANS. Two entries.
(They DO share the raw-write debt, and that is stated once in §27.3 rather than
twice in the entries.)

**ATTACK 8 — "`moog912` is NO FACE ON MERIT: two params."** It survives STOP 1
**only** on the derived-quantity clause, and §27.6 now says that outright,
including the consequence — if the readouts are cut in review the answer flips to
NO FACE, it does not degrade to a thin face. Presenting a two-knob module as
comfortably meritorious would have been the dishonest version.

**ATTACK 9 — "all four cards are dead to CV, like §25.1's four video ones."**
**False, and checked before it was written.** All **11** knobs across the four
cards pass `readLive`. §26.1 stated this for its cohort; I re-verified it for this
one instead of inheriting it, which is the whole point of §23-18.

**WHAT I DID NOT MEASURE — stated so a builder knows the edges of this spec:**

- **Nothing was rendered in a browser.** No dock layout, no band packing, no tier
  truncation, no VRT pixel. Every page count and cap consequence is
  DERIVED-BY-READING `curated-face.ts`, `dock-row-plan.ts` and `dock-tabs-model.ts`.
- **`moog912` and `moog993` NEVER RENDERED AUDIO.** Both are plain Web Audio
  graphs with no worklet, so I drove the REAL `def.factory` against a stub
  `BaseAudioContext` and read live node values. That measures the wiring, the
  param maps, `setParam`/`readParam` and the spawn path — and nothing else. The
  `moog912` gate-threshold table is arithmetic (mean |sin| = 2/π, unity DC gain of
  a lowpass) on top of the real curve builders; **no `BiquadFilterNode` was run**,
  and that figure is load-bearing for Q40's rank 1.
- **The `moog904a` corner figures are −3 dB points of the whole 4-pole cascade**,
  bisected with a Hann-windowed single-bin DFT. The cascade constant measured
  **0.43419** against the textbook **0.43501**, so `moog904a-corner-hz` inherits a
  0.19 % bias.
- **`moog904a` above `regeneration = 0` is not bit-reproducible** (`Math.random`
  dither), so every bit-exact claim in Q39 is at regen 0 and every claim above it
  is statistical.
- **The `moog902` mode-delta table is steady state.** The transient through
  `smOutGain` on a live mode flip — i.e. whether the switch clicks — was not
  characterized.
- **Push 2 golden diffs are predicted from `push-card-config.ts`'s tier rules**,
  not computed by running `push-card-schema.test.ts`.
- **Neither the 993 nor the 902 was driven through a real engine graph** — only
  through its factory / worklet class. Cable types line up on paper.

### 27.9 GLYPH RESOLUTION — RUN, NOT REASONED

§23-15's rule is *"a glyph that resolves is not a glyph that reads"*. Every glyph
claim in §27.2 and §27.4–§27.7 was **run through the real resolver** via a
throwaway `test:one` against `$lib/ui/workflow/shell-glyph-live` (the probe file
was created, run, and deleted in the same minute; `packages/` is read-only to this
lane and `git status` was checked clean afterwards).

| def | `primaryAudioOutPortId` | `'meter'` | `'waveform'` | `'envelope'` | `'algorithm'` |
|---|---|---|---|---|---|
| `moog902` | **`audio`** | `live-audio`:`audio` | `live-audio`:`audio` | `static` | `static` |
| `moog904a` | **`audio`** | `live-audio`:`audio` | `live-audio`:`audio` | `static` | `static` |
| `moog912` | **null** | `static` | `static` | **`static`** | `static` |
| `moog993` | **null** | `static` | `static` | `static` | `static` |
| `moog960` | **null** | `static` | `static` | `static` | `static` |

(`'none'` returns `{kind:'none'}` on all five, as the first arm.)

Four consequences, all MEASURED rather than derived:

1. **`moog902` and `moog904a` BIND, and the resolver names the port — `audio` in
   both cases.** That answers the #1692 / Q20 *"say WHICH tap"* warning from the
   code rather than from the def's output list, and it fixes their compact cap at
   `LANE_ROW_MAX_CELLS_WITH_GLYPH = 2`.
2. **`moog912` and `moog993` must declare `glyph: 'none'`.** Every other value
   resolves `{kind:'static'}`, which reddens the dead-glyph clause. Their compact
   cap is `LANE_ROW_MAX_CELLS = 3`, which is why both fit entirely at compact.
3. **`moog912` is a second witness for #1888.** It is visibly an envelope module
   and `'envelope'` returns exactly `{kind:'static'}`, because the resolver keys on
   four params literally named `attack`/`decay`/`sustain`/`release`. `moog911` was
   the first; the arm now has two modules it exists to serve and cannot.
4. **`moog960`'s null is what disqualifies it** (§27.2) — there is no glyph that
   can carry a playhead, and no other cell either.

⚠ **What this still does not prove**: that the tap MOVES. All five are
`domain: 'audio'` nodes, so the `mandelbulb` failure mode is structurally absent —
but *"resolves"* and *"reads"* remain two questions and only the first is answered.
The second needs a browser.

### 27.10 THE COHORT AT A GLANCE

| Q | module | dom | par | pages | why it earns a face, in one line |
|---|---|---|---|---|---|
| **Q38** | `moog902` | A | 3 | 2 | A RESPONSE switch that is really a **level control** — **−2.9841 dB at the shipped default, −5.4525 dB at the bottom of the dial, with no dial movement and no name on the def** — over a documented ×3 ceiling that is 1.5 V too low for the DEFAULT mode (#1912). |
| **Q39** | `moog904a` | A | 3 | 2 | A cutoff dial that declares `units: 'Hz'` and delivers **434.67 / 1769.51 / 9851.52 Hz for the same number** (a 22.66× spread on a switch), plus a resonance knob that crosses from filter to **oscillator at 0.665373** (#1913, **owner ears**). |
| **Q40** | `moog912` | A | 2 | 1 | Two knobs, and the **bottom 15.71 % of one cannot open the GATE it exists to open** — even on a full-scale sine — while the other's real unit is **1–50 Hz inverted (49.4549 ms at the default)** and is printed nowhere (#1914). |
| **Q41** | `moog993` | A | 3 | 1 | Three routers whose continuous dial has **2 live positions out of 201** — one wheel notch silences an output, a persisted 1.4 respawns silent, and `readParam` reports a third number — so **the face would ship the bug** until #1911 lands. |

**Issues filed by this lane:** #1911 (993 `route` exact-equality on a `linear`
dial — **PREREQUISITE for Q41**) · #1912 (902 ceiling voltage + the unnamed mode
level delta + a VRT exemption claiming ART that does not exist) · #1913 (904a
self-oscillation pitch/level and the dead dial top — **owner ears**) · #1914 (912
gate dead zone + the unprinted Hz map + NaN propagation) · #1915 (the `moog960`
disposition — **why this cohort is four and not five**).

**Build order, if the wave is taken as one:** **Q38 → Q39 → Q40 → Q41.** Q38 and
Q39 move no baseline and touch no contract, and each pays off a ledgered raw-write
debt. Q40 moves one committed STRICT baseline. Q41 needs #1911 landed first, is
the only one costing a `docs:accept`, and moves the second strict baseline.

**Next after this cohort, in order:** `moog961` (2 params, own worklet,
`units: 's'` — the Q34 shape) · `moog984` (16 params, the family's first genuine
`DOCK_TAB_MIN_BANDS` candidate, but see §27.2's grid-surface question) ·
`moog904b` / `moog904c` (boy-scout once Q39 lands) · then the §26.8 list
(`4plexvid` and the §22 "next-after" names).

**BANK AFTER THIS SECTION, re-derived from the current tree** (a Q entry is in the
bank when its module is NOT `done` in `docs/design/face-migration.generated.md`):

| domain | buildable now | held |
|---|---|---|
| **video** | **9** — `spirographs` (Q23) · `b3ntb0x` (Q24) · `mandelbulb` (Q25) · `grainsOfVision` (Q26) · `quadralogical` (Q27) · `ruttetra` (Q30) · `mirrorpool` (Q31) · `outlines` (Q32) · `freezeframe` (Q33) | — |
| **audio** | **3** — Q38 `moog902` · Q39 `moog904a` · Q40 `moog912` | **Q41 `moog993`** (gated on #1911) · Q2 `timelorde` / Q3 `treeohvox` / Q4 `scope` (plan-blocked) · Q21 `moog905` (answered marginal, #1881) |
| **total** | **12 buildable, 13 spec'd** | |

Before this section the audio half was **0 buildable** — Q34–Q37 all merged, and
every remaining audio entry blocked or marginal. That is the gap §27 exists to
close.
