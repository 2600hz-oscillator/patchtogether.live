# rings — face record: the MEASUREMENTS, and what is still open

**SHIPPED**, and heavily re-cut on the way in. archetype: **exciter-driven RESONATOR** (the
physical-modelling family: karplus · sixstrum · meowbox · rings). The proposed `face` block, the
band rationale and the cell-by-cell layout have been deleted from here — read the def.

**How everything below was measured.** `packages/dsp/src/rings.ts` was bundled with esbuild against
a stub `AudioWorkletProcessor`/`registerProcessor`/`sampleRate` and run offline at 48 kHz in
128-sample blocks — i.e. **the shipping worklet, not the mirror**. Excitation is a 10 ms gate on
`strum` at sample 1000 unless a scenario says otherwise. Spectral figures are Hann-windowed
Goertzel; **the instrument was negative-controlled against synthetic sines first and reads
0.25 / −0.06 / 0.01 cents at 65.4 / 261.6 / 1046.5 Hz.**

---

## 0 · SHIPPED vs PROPOSED

**Matching:** `hero.cell: 'rings-comb-{n}'`, `hero.control: 'position'`,
`hero.action: 'rings-strum-{n}'`, `glyph: 'scope'`, `title: 'Resonator'`, and the panel ranked 7
(`module-face-lint` refuses a PANEL cell selected at a lane tier and `faceTierCap('full')` is **6**,
so a panel's first legal rank is 7 on every face).

**Did NOT ship:**

| proposed | shipped |
|---|---|
| readout `ring` / `rings-t60-ms` | **`model` / `rings-body`** |
| four pages | **three** — `pickup` and `out` merged into `taps` (`rings.ts:609`, labelled `out`) |
| every band `hint`, and the entire `sidebar` including `signal-flow` | **none** |
| `face.hint` | **none** |
| — | **`paramCells` with six `fader` entries** — a shipped addition the spec did not have |

⚠ **Owner ruling 2026-08-11, recorded verbatim in this module's own def** at
`packages/web/src/lib/audio/modules/rings.ts:585-590` and `:645-650`: *"we should prefer almost zero
AI authored text, and all future faceplate work should reflect that"* and *"lets stop doing these
and clean up the existing ones, get rid of them. lose the signal flow diagrams."* rings is where the
ruling was recorded, which is why its hints and sidebar are gone.

---

## 1 · WHAT IT ACTUALLY DOES

Two resonator models behind one macro set, and **neither makes a sound on its own**.

**MODAL (`model` 0)** — `RingsModal`, `packages/dsp/src/rings.ts:105-190`. 24 RBJ band-passes at
`freq·(i+1)·stretch`, `stretch += structure·0.5` each partial (`:150-156`). DAMPING sets a base
`q = 500·10^(3·(1−damping))` (`:142`) and each filter gets `Q = 1 + fNorm·q` — **Q proportional to
partial frequency**, which is what makes the decay TIME uniform across the bank. BRIGHTNESS sets
`qLoss = b(2−b)·0.85 + 0.15` and `qCurrent *= qLoss` **once per partial** (`:144, :155-156`), so it
is a *cumulative* Q taper down the bank. Peak gain per partial is `Q^0.6`.

**SYMPATHETIC (`model` 1)** — `RingsSympatheticStrings`, `:254-305`. Two Karplus-Strong loops
detuned by `structure·19` semitones (`:265`), each with a brightness one-pole on the input and a
damping one-pole in the loop, `loopGain = 0.998 − damping·0.08` (`:231`).

**The output split is the fact the card hides.** `RingsModal.process` (`:176-185`) accumulates
partial *i* into `odd` when `i` is EVEN and into `even` when `i` is ODD. Partial index 0 is the
fundamental. So:

> **ODD carries only the ODD-numbered harmonics; EVEN carries only the EVEN-numbered harmonics.**
> They are not a stereo pair of the same signal — they are two disjoint combs.

*Measured* (spawn defaults, `structure 0`, noise-burst exciter, Hann, dB re arbitrary reference —
read the CONTRAST, not the absolute):

| | h1 | h2 | h3 | h4 | h5 | h6 |
|---|---|---|---|---|---|---|
| **ODD** | **+26.1** | −89.8 | **+29.7** | −96.7 | **+14.1** | −89.2 |
| **EVEN** | −95.2 | **+29.1** | −90.7 | **+20.3** | −86.1 | **+14.3** |

**116 dB of separation, every bin, both directions.** The docs called this "complementary taps …
patch both for a wide pseudo-stereo image", which is true but radically understates it: patch ODD
alone — the documented mono option, and the head of `stereoPairs` — and **every even harmonic is
gone.** That is a hollow, clarinet-like spectrum, not "the resonator in mono".

---

## 2 · INERT AT SPAWN — and this one is absolute

Nothing patched, no strum: **`odd` peak = 0.000e+0, `even` peak = 0.000e+0.** Not "small" — the
`Float32Array`s are untouched zeros. There is no internal exciter, no free-run, no noise floor.
`packages/dsp/src/rings.ts:402-407` only produces a nonzero sample when `exc` or a plucker burst is
nonzero, and the plucker only runs after a rising edge on `strum` (`:391-397`).

Every one of the seven CV jacks is an exact no-op at 0 V (they are `paramTarget` displacements).
`level` at its 0.8 default is a plain multiply.

**Consequence: an audition is not a nicety on this module, it is the difference between a faceplate
and a photograph.**

---

## 3 · THE SIX MEASURED FACTS THE FACE EXISTS FOR

### A. POSITION is MIRROR-SYMMETRIC — half the knob is a duplicate of the other half

`w = cos(2π·position·i)` (`:176-180`). `cos(2π(1−p)i) = cos(2πi − 2πpi) = cos(2πpi)`, so **p and
1−p are the same filter bank, exactly.** *Measured*, worklet, 1 s render at spawn defaults:

| p vs 1−p | max&#124;Δ odd&#124; | max&#124;Δ even&#124; |
|---|---|---|
| 0.00 / 1.00 | **0.000e+0** | **0.000e+0** |
| 0.25 / 0.75 | **0.000e+0** | 1.494e-15 |
| 0.30 / 0.70 | **0.000e+0** | **0.000e+0** |
| 0.10 / 0.90 | 4.396e-7 | 5.299e-7 |
| 0.20 / 0.80 | 2.533e-7 | 3.427e-7 |
| 0.40 / 0.60 | 5.886e-7 | 7.069e-7 |

The three exact zeros are the proof; the ~5e-7 rows are float32 quantisation of the a-rate param
value (0.1 and 0.9 do not round to exact complements), not a difference in behaviour. **A player
moving POSITION from 0.5 to 1.0 is retracing 0.5 → 0.0 backwards.**

**And the shipped default sits at a maximum, not in the middle.** At `p = 0.5` every `|w| = 1`, the
same as `p = 0`. Measured: ODD at 0.5 is **bit-identical** to ODD at 0 (`max|Δ| = 0.000e+0`), and
EVEN at 0.5 is the **exact polarity inverse** of EVEN at 0 (`max|even(0) + even(0.5)| = 0.000e+0`).
The two default-adjacent extremes differ only in the sign of one channel.

### B. BRIGHTNESS is a RING-TIME control that is documented as a tone control

`docs.controls.brightness` said it "sculpts the high-frequency content of the resonance". *Measured*
in MODAL at a **fixed** `damping = 0.5`, 6 s render:

| brightness | 0.00 | 0.20 | 0.40 | 0.50 | 0.60 | 0.80 | 1.00 |
|---|---|---|---|---|---|---|---|
| **T60** | 266 ms | 276 | 312 | 405 | 1022 | 4002 | **≥6000** (render-limited) |
| RMS | −44.2 dB | −45.9 | −44.8 | −43.4 | −42.5 | −41.5 | −41.1 |

**At least 22× of ring time on the knob the docs call a tone control**, against 3.1 dB of level. For
comparison, DAMPING — the control that *is* documented as ring time — moves T60 from ≥4000 ms to
44 ms. **Two knobs set the decay and only one says so.**

The spectral half is also much stronger than "dark and muted". Per-partial, ODD tap, `structure 0`,
`damping 0.5`:

| brightness | h1 | h3 | h5 | h7 | h9 | h11 |
|---|---|---|---|---|---|---|
| 0.0 | +26.1 | −52.4 | −107.2 | −129.0 | −141.0 | −141.5 |
| 0.5 | +26.1 | +29.7 | +14.1 | +9.8 | −7.9 | −14.8 |
| 1.0 | +25.6 | +37.8 | +37.6 | +40.0 | +40.1 | +36.0 |

At **BRIGHTNESS 0 the 24-partial bank is one sine** (h3 is 78 dB down, h5 is 133 dB down). At
**BRIGHTNESS 1 the fundamental is the QUIETEST partial present** — h3 through h9 sit 12–14 dB above
it. ⚠ **DOCS + FACE finding, not a DSP bug.** `qLoss` is a faithful reading of the reference's
per-partial Q taper; the fault is that nothing told the player their tone knob is also their decay
knob.

### C. POSITION 0.25 / 0.75 mute EVEN to digital zero — correctly, and it is documented

Measured `even` peak **5.028e-16** at 0.25 and **1.302e-15** at 0.75, ODD unaffected (−35.62 dB
both). `docs.outputs.even` already states this and calls it real resonator behaviour, and
`rings.test.ts` uses it as its **permanent negative control** for the ODD-audibility sweep.

### D. STRUCTURE is exact, and it is the module's one printable formula

Partial *n* sits at `f0·n·(1 + structure/2)^(n−1)`-ish through the incremental stretch; for
partial 2 that reduces to `2·f0·(1 + structure/2)`. *Measured* (peak-find on the EVEN tap, which is
where partial 2 lives):

| structure | 0.25 | 0.50 | 0.75 | 1.00 |
|---|---|---|---|---|
| measured p2/p1 | 2.2495 | 2.4997 | 2.7504 | 2.9992 |
| predicted `2(1+s/2)` | 2.2500 | 2.5000 | 2.7500 | 3.0000 |

Re-measured for the def and recorded there (`rings.ts:553-554`) as the exact five-point ladder:
**2.0000 / 2.2500 / 2.5000 / 2.7500 / 3.0000** against `2*(1+s/2)` at structure 0 / .25 / .5 / .75 / 1.

⚠ **The `structure = 0` row was an INSTRUMENT artifact on the first pass, not a finding.** The
peak-find returned 4.000 there, because at `structure 0` the partials are exact harmonics and the
EVEN tap's h4 (+20.3 dB) outranks its h2 in the search window. The formula was right at 0; the probe
picked the wrong peak. Stated because a reader re-running this will hit it.

### E. MODEL is a 5.37 dB level step

Identical macros, 2 s render: MODAL `odd` RMS **−38.67 dB**, SYMPATHETIC **−33.30 dB**. `even` moves
the same way (−38.53 / −33.72). A one-press control that changes output level by more than 5 dB
earns rank 1 and a visible number.

### F. LEVEL's tanh "soft limiter" is a 0.107 dB no-op

*Measured*, strummed defaults, against a linear extrapolation from `level = 0.2`:

| level | RMS | linear prediction | **compression** | peak |
|---|---|---|---|---|
| 0.20 | −47.633 dB | −47.633 | 0.000 dB | 0.088 |
| 0.50 | −39.698 | −39.674 | **−0.024 dB** | 0.217 |
| 0.80 | −35.660 | −35.592 | **−0.068 dB** | 0.339 |
| 1.00 | −33.761 | −33.653 | **−0.107 dB** | 0.415 |

A sustained external exciter does not change the picture: white noise at 0.3 into `in` gives peak
**0.285** at `level = 1`. **The limiter never engages in normal use.**

---

## 4 · THE DERIVED READOUTS AND THEIR NEGATIVE CONTROLS

**A · `rings-t60-ms`** — the ring time, from BOTH knobs. A `paramId: 'damping'` readout prints
`0.50` at every one of these:

| | damping 0.5, brightness 0.0 | 0.5 / 0.5 | 0.5 / 0.8 | 0.5 / 1.0 |
|---|---|---|---|---|
| measured T60 | **266 ms** | 405 ms | 4002 ms | **≥6000 ms** |

*NEGATIVE CONTROL — `brightness`.* A knob readback is invariant to it and the real answer moves by
more than 22×. *SECOND — `model`:* at identical macros SYMPATHETIC reads 482 ms where MODAL reads
405, and at `damping 1.0` SYMPATHETIC's T60 goes *back up* (327 ms at 0.75 → **352 ms** at 1.00,
non-monotonic), so a derivation that assumes the MODAL decade curve is falsified on the spot by
switching model. *THIRD — `damp_cv`:* a knob readback cannot see it at all.

⚠ **HONESTY TERM.** The MODAL closed form is `tau = q/(pi·sr)` with `q = 500·10^(3(1−damping))`,
which gives 0.72 s of T60 at the defaults against a **measured 405 ms** — the formula ignores the
BRIGHTNESS taper and the per-partial `Q^0.6` gain. **Either print the two-variable fit and say it is
a fit, or print the measured lookup.** Do not print the closed form as if it were exact; that is a
number nobody can reproduce. *(This readout is what shipped as `rings-body` instead.)*

**B · `rings-partial2-hz`** — `partial2_hz = 2 · f0 · (1 + structure/2)`, `f0 = 261.6256 ·
2^((pitch·12 + note)/12)`. Agreement to four decimal places (§3-D).
*NEGATIVE CONTROL — `note`.* Both `structure` and `note` must move it, and `damping` must **not** —
a readout that moved with damping would be measuring the envelope, not the bank. *SECOND — `model`:*
in SYMPATHETIC there is no partial 2, there is a second STRING at `+structure·19` semitones, so the
readout must switch its own meaning with the model or it is lying at model 1.

**C · `rings-even-tap-state`** — the one readout with no knob to read. Prints `live` /
**`NODE — silent`** when `|position − 0.25| < ε` or `|position − 0.75| < ε`, and `mirror of <1−p>`
otherwise. *NEGATIVE CONTROL:* a `paramId: 'position'` readout prints `0.75` and `0.25` with no hint
that one output is at digital zero. *SECOND:* POSITION 0.30 and 0.70 must print the *same* mirror
partner, because they are the same setting (`max|Δ| = 0.000e+0`), while the knob readback prints two
different numbers.

⚠ **All three need `structure`/`note`/`damping`/`brightness` at their LIVE values.**
`FaceReadoutValue` is params-only; a CV-displaced macro is invisible to it. Until a widened
`{ read, sampleRate, readLive }` reader lands, the honest fallback is labels that say `knob`.

---

## 5 · DEFECT LEDGER

| # | item | verdict |
|---|---|---|
| **§7-A** | the audition needs a factory seam that does not exist — `strum` is worklet INPUT 2 with no param and no `read()` on the handle, so an `action` cell could not write anything | ✅ **RESOLVED** — shipped as the `rings-strum` family: a host-side `ConstantSource` on the strum input plus `read('manualTrigger')`, the karplus seam verbatim (`rings.ts:734-766`, `shell-cells.ts` `rings-strum-{n}` with `probe: { effect: { kind: 'audition', seam: 'manual-strike' } }`). The card's STRUM button fires the same source, so there is one implementation and not two. |
| **§7-B** | `RingsCard.svelte` had a MODEL button, six faders and a PatchPanel — **and no strum control**, so a user who spawned RINGS and turned every knob heard nothing | ✅ **RESOLVED** by the same seam |
| **A** | the `strum` port declares no `edge` — so `module-docs-lint`'s `if (!p.edge) continue` **skipped the one port whose vocabulary was at stake** (the meowbox finding, second module) | ✅ **FIXED** — `rings.ts:433` is `{ id: 'strum', type: 'gate', edge: 'trigger' }` |
| **B** | **the ART harmonic scenario measures WINDOW LEAKAGE, not harmonics.** `art/scenarios/rings/resonator-character.test.ts:16-25` `powerAt` is an **unwindowed** DFT over a 91 200-sample decaying tail, and asserts `pH2 > pOff·0.5` on the **ODD** tap — where h2 is structurally absent. *Measured at the test's own parameters:* h2 reads **−92.7 dB unwindowed** and **−206.5 dB Hann** — a **491 855×** discrepancy — and Hann-windowed `h2/h1 = 3.81e-8`, i.e. **−148 dB**. The assertion passes with a 2.43× margin on rectangular-window sidelobe leakage from h1 and h3, and the test's own comment rationalises the leakage as a budget artifact. **Negative control run:** subtracting the least-squares 440 Hz component from the same buffer makes the assertion FAIL — confirming the quantity it reads is the leakage, not the partial. **The scenario passes** — a green gate certifying something that is not true. | ⛔ **OPEN.** Fix (own PR): window the probe, and assert h2 on the EVEN tap where it lives. |
| **C** | BRIGHTNESS's doc omits ring time entirely (§3-B) | addressed by the face |
| **D** | LEVEL's "soft-limiter … gentle saturation" is 0.107 dB (§3-F) | addressed by the face |
| **E** | the card re-typed every range and default as a literal, on the same screen as a line that correctly read `ringsDef.params.find(...)!.defaultValue` | ✅ **FIXED** — `RingsCard.svelte` is now in **both** `RANGE_BOUND_CARDS` (`card-range-source.test.ts:263`) and `MAPPING_BOUND_CARDS` (`:292`) |
| **F** | **`ringsMath` is a ~250-line hand-duplicated copy of the worklet, and nothing compares them.** `packages/web/src/lib/audio/modules/rings.ts:75-373` re-declares `_Biquad`, `_RingsModal`, `_KSString`, `_Plucker`, `_RingsSympatheticStrings` — comment for comment. **Every unit test and the entire ART scenario exercise the MIRROR**; users hear the worklet. *Measured today they agree:* `max|Δ| = 2.980e-8` (float32 quantisation) over a 1 s strummed render, with a negative control at `damping 0.50 vs 0.51` reading **7.818e-3**, so the comparison is capable of failing. **There is no test that makes it.** One 20-line parity test in the dsp package closes a whole class. ⚠ One known structural divergence that happens not to matter for static params: the worklet re-`configure()`s every 32 samples (`rings.ts:383-387`) while the mirror configures once per render. | ⛔ **OPEN** |
| **G** | `cycleModel` is a raw dotted param write — `RingsCard.svelte:38-39` `const t = patch.nodes[id]; if (t) t.params.model = next;`, the dotted form `mutate.guard`'s bracket-only `RAW_PARAM_WRITE` was structurally unable to see, one of the 96 | recorded; not a live bug |

**No dead controls.** All seven params reach the DSP and every one measurably moves the output.

⚠ **The compact tile's `scope` glyph is safe here** where analogVco's was not: rings is silent
unless struck (§2), so a frozen-graph capture reads zeros — the ordinary case #1420 already covers.
