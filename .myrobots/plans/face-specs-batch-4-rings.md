# FACE SPEC — `rings` (batch 4)

## 0. STATUS

**Authored 2026-08-09. Every claim below was measured or read against `main`**
(`ecc48f2e`), not against an earlier spec. Nothing here is implemented; no def, card
or DSP file is touched by this document.

**Verdict: PROMOTE — the strongest voice candidate in the batch.**
archetype: **exciter-driven RESONATOR** (the physical-modelling family: karplus ·
sixstrum · meowbox · rings).

Not in `STRICT_FACES` (`packages/web/src/lib/ui/workflow/strict-faces.ts`); the def
declares no `face`. In `STRICT_DOCS`; **not** in `STRICT_VRT_MODULES`. 7 params, 10 in,
2 out. contract-lock block = **21 lines** (`contract-lock.txt:2708-2728`: 1 meta + 10 in
+ 2 out + 7 param + 1 stereo).

**How everything below was measured.** `packages/dsp/src/rings.ts` was bundled with
esbuild against a stub `AudioWorkletProcessor`/`registerProcessor`/`sampleRate` and run
offline at 48 kHz in 128-sample blocks — i.e. **the shipping worklet, not the mirror**
(§8-F covers the mirror separately). Excitation is a 10 ms gate on `strum` at sample
1000 unless a scenario says otherwise. Spectral figures are Hann-windowed Goertzel;
the instrument was negative-controlled against synthetic sines first and reads
**0.25 / −0.06 / 0.01 cents** at 65.4 / 261.6 / 1046.5 Hz.

---

## 1. WHAT IT ACTUALLY DOES

Two resonator models behind one macro set, and **neither makes a sound on its own**.

**MODAL (`model` 0)** — `RingsModal`, `packages/dsp/src/rings.ts:105-190`. 24 RBJ
band-passes at `freq·(i+1)·stretch`, `stretch += structure·0.5` each partial
(`:150-156`). DAMPING sets a base `q = 500·10^(3·(1−damping))` (`:142`) and each filter
gets `Q = 1 + fNorm·q` — **Q proportional to partial frequency**, which is what makes
the decay TIME uniform across the bank. BRIGHTNESS sets `qLoss = b(2−b)·0.85 + 0.15`
and `qCurrent *= qLoss` **once per partial** (`:144, :155-156`), so it is a
*cumulative* Q taper down the bank. Peak gain per partial is `Q^0.6` (`:73, :89`).

**SYMPATHETIC (`model` 1)** — `RingsSympatheticStrings`, `:254-305`. Two Karplus-Strong
loops detuned by `structure·19` semitones (`:265`), each with a brightness one-pole on
the input and a damping one-pole in the loop, `loopGain = 0.998 − damping·0.08`
(`:231`).

**The output split is the fact the card hides.** `RingsModal.process` (`:176-185`)
accumulates partial *i* into `odd` when `i` is EVEN and into `even` when `i` is ODD.
Partial index 0 is the fundamental. So:

> **ODD carries only the ODD-numbered harmonics; EVEN carries only the EVEN-numbered
> harmonics.** They are not a stereo pair of the same signal — they are two disjoint
> combs.

*Measured* (spawn defaults, `structure 0`, noise-burst exciter, Hann, dB re arbitrary
reference — read the CONTRAST, not the absolute):

| | h1 | h2 | h3 | h4 | h5 | h6 |
|---|---|---|---|---|---|---|
| **ODD** | **+26.1** | −89.8 | **+29.7** | −96.7 | **+14.1** | −89.2 |
| **EVEN** | −95.2 | **+29.1** | −90.7 | **+20.3** | −86.1 | **+14.3** |

**116 dB of separation, every bin, both directions.** The docs call this "complementary
taps … patch both for a wide pseudo-stereo image" (`rings.ts:443`), which is true but
radically understates it: patch ODD alone — the documented mono option, and the head of
`stereoPairs` — and **every even harmonic is gone.** That is a hollow, clarinet-like
spectrum, not "the resonator in mono".

---

## 2. THE CONTROLS THAT MATTER — 7 params, and the lane cut

| rank | control | why |
|---|---|---|
| 1 | `model` | it is a **different instrument**, not a variant: a 24-partial bank vs two KS loops, and **5.37 dB apart in level** at identical macros (§4-E). |
| 2 | `damping` | the ring time, and the biggest single move on the module: **T60 ≥4000 ms → 44 ms** across the travel in MODAL. |
| 3 | `brightness` | ranked 3 **because it is a second ring-time control that says it is a tone control** (§4-B). Demoting it would leave the panel with the same lie the docs have. |
| 4 | `position` | the pickup comb, the ODD/EVEN balance — **and only half its travel does anything** (§4-A). |
| 5 | `structure` | the inharmonicity. Real and well-behaved (§4-D), and the only macro whose formula is clean enough to print. |
| 6 | `rings-strum-{n}` | **THE AUDITION.** Rank 6 = the last lane slot, on the clap/sixstrum argument: this module is **digital silence** until something strikes it (§3), and it currently has **no way to be struck from the UI at all** (§7-A). |
| 7 | `note` | dock-only. ±60 st is a *ten-octave* transpose on a module whose pitch normally arrives on the `pitch` jack; it is a setup control, not a performance one. |
| 8 | `level` | last, by the standing rule that an output trim never outranks a timbre — and here it is **a linear gain wearing a limiter's label** (§4-F). |

**LOSERS, with the reason each lost:**
- **`position` loses rank 3 to `brightness`** even though POSITION is the more
  *interesting* control, because BRIGHTNESS is the one a player will mis-set: it is
  ranked as a tone knob everywhere in the repo and it multiplies ring time by ~22×.
- **`note` loses to the audition.** A ±60 st offset is a tuning decision made once.
  Being unable to hear the module is a defect made continuously.
- **`level` is last** and is the only control on the module that is genuinely
  uninteresting — see §4-F, where the interesting thing about it is that it does *not*
  do what its doc says.

---

## 3. INERT AT SPAWN — and this one is absolute

Nothing patched, no strum: **`odd` peak = 0.000e+0, `even` peak = 0.000e+0.** Not
"small" — the `Float32Array`s are untouched zeros. There is no internal exciter, no
free-run, no noise floor. `packages/dsp/src/rings.ts:402-407` only produces a nonzero
sample when `exc` or a plucker burst is nonzero, and the plucker only runs after a
rising edge on `strum` (`:391-397`).

Every one of the seven CV jacks is an exact no-op at 0 V (they are `paramTarget`
displacements). `level` at its 0.8 default is a plain multiply.

**Consequence for the face: an audition is not a nicety on this module, it is the
difference between a faceplate and a photograph.**

---

## 4. WHAT THE FACE MUST MAKE VISIBLE — the six measured facts

### A. POSITION is MIRROR-SYMMETRIC — half the knob is a duplicate of the other half

`w = cos(2π·position·i)` (`:176-180`). `cos(2π(1−p)i) = cos(2πi − 2πpi) = cos(2πpi)`,
so **p and 1−p are the same filter bank, exactly.** *Measured*, worklet, 1 s render at
spawn defaults:

| p vs 1−p | max&#124;Δ odd&#124; | max&#124;Δ even&#124; |
|---|---|---|
| 0.00 / 1.00 | **0.000e+0** | **0.000e+0** |
| 0.25 / 0.75 | **0.000e+0** | 1.494e-15 |
| 0.30 / 0.70 | **0.000e+0** | **0.000e+0** |
| 0.10 / 0.90 | 4.396e-7 | 5.299e-7 |
| 0.20 / 0.80 | 2.533e-7 | 3.427e-7 |
| 0.40 / 0.60 | 5.886e-7 | 7.069e-7 |

The three exact zeros are the proof; the ~5e-7 rows are float32 quantisation of the
a-rate param value (0.1 and 0.9 do not round to exact complements), not a difference in
behaviour. **A player moving POSITION from 0.5 to 1.0 is retracing 0.5 → 0.0 backwards.**

**And the shipped default sits at a maximum, not in the middle.** At `p = 0.5` every
`|w| = 1`, the same as `p = 0`. Measured: ODD at 0.5 is **bit-identical** to ODD at 0
(`max|Δ| = 0.000e+0`), and EVEN at 0.5 is the **exact polarity inverse** of EVEN at 0
(`max|even(0) + even(0.5)| = 0.000e+0`). So the two default-adjacent extremes differ
only in the sign of one channel — which changes the mono fold and nothing else.

**The face must show the comb, and it must show where you are on it.** This is the one
control on the module where a picture is not decoration: a 0..1 slider over a
mirror-symmetric weighting function is unreadable as a number.

### B. BRIGHTNESS is a RING-TIME control that is documented as a tone control

`docs.controls.brightness` (`rings.ts:449`) says it "sculpts the high-frequency content
of the resonance … low values are dark and muted, high values let the upper partials
sing through." *Measured* in MODAL at a **fixed** `damping = 0.5`, 6 s render:

| brightness | 0.00 | 0.20 | 0.40 | 0.50 | 0.60 | 0.80 | 1.00 |
|---|---|---|---|---|---|---|---|
| **T60** | 266 ms | 276 | 312 | 405 | 1022 | 4002 | **≥6000** (render-limited) |
| RMS | −44.2 dB | −45.9 | −44.8 | −43.4 | −42.5 | −41.5 | −41.1 |

**At least 22× of ring time on the knob the docs call a tone control**, against 3.1 dB
of level. For comparison, DAMPING — the control that *is* documented as ring time —
moves T60 from ≥4000 ms to 44 ms. **Two knobs set the decay and only one says so.**

The spectral half is also much stronger than "dark and muted". Per-partial, ODD tap,
`structure 0`, `damping 0.5`:

| brightness | h1 | h3 | h5 | h7 | h9 | h11 |
|---|---|---|---|---|---|---|
| 0.0 | +26.1 | −52.4 | −107.2 | −129.0 | −141.0 | −141.5 |
| 0.5 | +26.1 | +29.7 | +14.1 | +9.8 | −7.9 | −14.8 |
| 1.0 | +25.6 | +37.8 | +37.6 | +40.0 | +40.1 | +36.0 |

At **BRIGHTNESS 0 the 24-partial bank is one sine** (h3 is 78 dB down, h5 is 133 dB
down). At **BRIGHTNESS 1 the fundamental is the QUIETEST partial present** — h3 through
h9 sit 12–14 dB above it. Calling the endpoints "dark" and "bright" is not wrong, but
it hides that the bank's *identity* changes: one partial vs an upper-partial spectrum
where the notated pitch is a residue.

⚠ **This is a DOCS + FACE finding, not a DSP bug.** `qLoss` is a faithful reading of
the reference's per-partial Q taper; the fault is that nothing tells the player their
tone knob is also their decay knob. **Do not fold a DSP change into the face wave.**

### C. POSITION 0.25 / 0.75 mute EVEN to digital zero — correctly, and it is documented

Measured `even` peak **5.028e-16** at 0.25 and **1.302e-15** at 0.75, ODD unaffected
(−35.62 dB both). `docs.outputs.even` already states this and calls it real resonator
behaviour, and `rings.test.ts` uses it as its **permanent negative control** for the
ODD-audibility sweep. Nothing to fix — but the face should draw it, because a stereo
pair where one side vanishes at two knob positions is exactly the kind of thing a
picture answers and a number does not.

### D. STRUCTURE is exact, and it is the module's one printable formula

Partial *n* sits at `f0·n·(1 + structure/2)^(n−1)`-ish through the incremental stretch;
for partial 2 that reduces to `2·f0·(1 + structure/2)`. *Measured* (peak-find on the
EVEN tap, which is where partial 2 lives — see §1):

| structure | 0.25 | 0.50 | 0.75 | 1.00 |
|---|---|---|---|---|
| measured p2/p1 | 2.2495 | 2.4997 | 2.7504 | 2.9992 |
| predicted `2(1+s/2)` | 2.2500 | 2.5000 | 2.7500 | 3.0000 |

⚠ **The `structure = 0` row is an INSTRUMENT artifact, not a finding.** The peak-find
returned 4.000 there, because at `structure 0` the partials are exact harmonics and the
EVEN tap's h4 (+20.3 dB) outranks its h2 in the search window. The formula is right at
0; the probe picked the wrong peak. Stated because a reader re-running this will hit it.

### E. MODEL is a 5.37 dB level step

Identical macros, 2 s render: MODAL `odd` RMS **−38.67 dB**, SYMPATHETIC **−33.30 dB**.
`even` moves the same way (−38.53 / −33.72). A one-press control that changes output
level by more than 5 dB deserves to be ranked first and to have the number visible.

### F. LEVEL's tanh "soft limiter" is a 0.107 dB no-op

`docs.controls.level` (`:452`): "Output gain (0..1) feeding a tanh soft-limiter, so
pushing it adds gentle saturation rather than hard clipping." *Measured*, strummed
defaults, against a linear extrapolation from `level = 0.2`:

| level | RMS | linear prediction | **compression** | peak |
|---|---|---|---|---|
| 0.20 | −47.633 dB | −47.633 | 0.000 dB | 0.088 |
| 0.50 | −39.698 | −39.674 | **−0.024 dB** | 0.217 |
| 0.80 | −35.660 | −35.592 | **−0.068 dB** | 0.339 |
| 1.00 | −33.761 | −33.653 | **−0.107 dB** | 0.415 |

A sustained external exciter does not change the picture: white noise at 0.3 into `in`
gives peak **0.285** at `level = 1`. **The limiter never engages in normal use.** LEVEL
is a linear gain; the doc promises a character it cannot deliver at any setting the
module can reach on its own.

---

## 5. THE FACE

```ts
face: {
  title: 'Resonator',
  hint:
    'A body, not a voice: it makes no sound at all until something excites it — an exciter on IN, ' +
    'or STRUM. ODD and EVEN are NOT a stereo copy of one signal: ODD carries the odd-numbered ' +
    'harmonics and EVEN the even-numbered ones, 116 dB apart, so ODD alone is a hollow half of the ' +
    'body. DAMPING sets the ring time — and so does BRIGHTNESS, by more than 20x.',

  order: [
    'model', 'damping', 'brightness', 'position', 'structure', 'rings-strum-{n}',  // 1-6 = the lane budget
    'rings-comb-{n}',                                                              // panel: first legal rank is 7
    'note', 'level',
  ],
  pages: [
    { id: 'body',   label: '1 · the body — which resonator',
      hint: 'MODAL is 24 stiffness-stretched band-passes (a struck bar); SYMPATHETIC is two Karplus-Strong ' +
            'loops detuned by STRUCTURE. The same five macros mean different things in each, and the two ' +
            'sit 5.4 dB apart in level at identical settings.',
      controls: ['model', 'structure', 'note'] },
    { id: 'ring',   label: '2 · ring time — BOTH of these set it',
      hint: 'DAMPING is the decade curve: T60 runs from seconds down to 44 ms. BRIGHTNESS is the ' +
            'per-partial Q taper, and at a FIXED damping it moves T60 from 266 ms to over six seconds. ' +
            'At BRIGHTNESS 0 the bank is one sine; at 1 the fundamental is the quietest partial in it.',
      controls: ['damping', 'brightness'] },
    { id: 'pickup', label: '3 · pickup — and the two taps',
      hint: 'Partial n is weighted by cos(2*PI*POSITION*n), so POSITION and 1-POSITION are the SAME ' +
            'setting — the top half of the dial retraces the bottom half. 0.25 and 0.75 land every ' +
            'odd partial on a node and EVEN goes silent there.',
      controls: ['rings-comb-{n}', 'rings-strum-{n}', 'position'] },
    { id: 'out',    label: 'out',
      hint: 'A plain gain into a tanh that never engages: at LEVEL 1 the measured compression is 0.107 dB.',
      controls: ['level'] },
  ],
  glyph: 'scope',

  hero: {
    cell:    'rings-comb-{n}',
    control: 'position',
    action:  'rings-strum-{n}',
    readouts: [
      { label: 'ring',      valueId: 'rings-t60-ms' },
      { label: 'partial 2', valueId: 'rings-partial2-hz' },
      { label: 'even tap',  valueId: 'rings-even-tap-state' },
    ],
  },

  sidebar: [
    { kind: 'signal-flow', label: 'signal flow', stages: [
      { label: 'IN',            role: 'generator', note: 'exciter — silent unpatched' },
      { label: 'STRUM PLUCK',   role: 'generator', parallel: true, note: '10 ms noise burst' },
      { label: 'BANK · 24 BP',  role: 'bus', note: 'MODAL — Q proportional to f' },
      { label: 'KS PAIR',       role: 'bus', parallel: true, note: 'SYMPATHETIC — the other model' },
      { label: 'PICKUP COMB',   role: 'bus', note: 'cos(2*PI*POS*n)' },
      { label: 'ODD  → tanh',   role: 'bus', note: 'harmonics 1,3,5 …' },
      { label: 'EVEN → tanh',   role: 'bus', parallel: true, note: 'harmonics 2,4,6 …' },
    ] },
    { kind: 'readouts', label: 'the two taps', entries: [
      { label: 'ODD holds',  text: 'h1 h3 h5 …' },
      { label: 'EVEN holds', text: 'h2 h4 h6 …' },
      { label: 'separation', text: '116 dB measured' },
    ] },
  ],
}
```

**Why four bands, and why `ring` is its own band.** The four are: *which body*, *how
long it rings*, *where you listen*, *out*. Putting DAMPING and BRIGHTNESS in one band
with a hint that says both set the decay is the single highest-value thing this face
does — it is the entire §4-B finding expressed as layout, and it survives with the
hint hidden because the LABEL carries it (`2 · ring time — BOTH of these set it`).

⚠ **That label is 33 characters and it is load-bearing.** Label clipping is invisible to
`faces-parity` (`toHaveText` reads `textContent`; a CSS ellipsis leaves no trace) — the
filter `LP · H… · B…` and macrooscillator `WAVETABLE 60>53` precedents. **Measure this
band header against the dock's real width before building, and if it clips, shorten it
to `2 · ring time — both of these` rather than moving the fact into the hint**, because
the hint is annotation and OFF by default.

⚠ **`title` and `hint` are ANNOTATION-ONLY and paint nothing at rest**
(`facePageHeader(def, annotations = false)` returns `null` before reading anything,
`dock-faceplate-model.ts:90`; owner ruling 2026-08-03). Nothing above depends on them.

⚠ **`rings-comb-{n}` is ranked 7, not 6.** `module-face-lint` refuses a PANEL cell
selected at a lane tier and `faceTierCap('full')` is **6**, so a panel's first legal
rank is 7 on every face. With 7 params plus one audition this face has 9 keys, so rank
7 is comfortably inside the roster — unlike drummergirl, which could not reach it.

---

## 6. DERIVED READOUTS — each with its negative control

### A. `rings-t60-ms` — the ring time, from BOTH knobs

This is the readout that justifies the whole face. A `paramId: 'damping'` readout
prints `0.50` at every one of these:

| | damping 0.5, brightness 0.0 | 0.5 / 0.5 | 0.5 / 0.8 | 0.5 / 1.0 |
|---|---|---|---|---|
| measured T60 | **266 ms** | 405 ms | 4002 ms | **≥6000 ms** |

**NEGATIVE CONTROL — `brightness`.** A knob readback is invariant to it and the real
answer moves by more than 22×. **SECOND CONTROL — `model`:** at identical macros
SYMPATHETIC reads 482 ms where MODAL reads 405, and at `damping 1.0` SYMPATHETIC's T60
goes *back up* (327 ms at 0.75 → **352 ms** at 1.00, non-monotonic), so a derivation
that assumes the MODAL decade curve is falsified on the spot by switching model.
**THIRD — `damp_cv`:** a knob readback cannot see it at all; the derivation must read
the live AudioParam (`engine.readParam` returns intrinsic + tap,
`packages/web/src/lib/audio/engine.ts`).

⚠ **HONESTY TERM.** The MODAL closed form is `tau = q/(pi·sr)` with
`q = 500·10^(3(1−damping))`, which gives 0.72 s of T60 at the defaults against a
**measured 405 ms** — the formula ignores the BRIGHTNESS taper and the per-partial
`Q^0.6` gain. **Either print the two-variable fit and say it is a fit, or print the
measured lookup.** Do not print the closed form as if it were exact; that is a number
nobody can reproduce.

### B. `rings-partial2-hz` — where the second partial actually is

```
partial2_hz = 2 · f0 · (1 + structure/2)      # f0 = 261.6256 · 2^((pitch·12 + note)/12)
```
Measured against prediction at structure 0.25 / 0.50 / 0.75 / 1.00: **2.2495 / 2.4997 /
2.7504 / 2.9992** vs 2.25 / 2.50 / 2.75 / 3.00 — four decimal places.
**NEGATIVE CONTROL — `note`.** Both `structure` and `note` must move it, and
`damping` must **not**. A readout that moved with damping would be measuring the
envelope, not the bank. **SECOND CONTROL — `model`:** in SYMPATHETIC there is no
partial 2, there is a second STRING at `+structure·19` semitones, so the readout must
switch its own meaning with the model or it is lying at model 1. **Print the label as
`string 2` in SYMPATHETIC** — same `valueId`, model-aware text.

### C. `rings-even-tap-state` — the one readout with no knob to read

Prints `live` / **`NODE — silent`** when `|position − 0.25| < ε` or
`|position − 0.75| < ε`, and `mirror of <1−p>` otherwise.
**NEGATIVE CONTROL:** a `paramId: 'position'` readout prints `0.75` and `0.25` with no
hint that one output is at digital zero (measured 1.302e-15 and 5.028e-16 peak).
**SECOND CONTROL:** move POSITION to 0.30 and to 0.70 — the readout must print the
*same* mirror partner for both, because they are the same setting (measured
`max|Δ| = 0.000e+0`), while the knob readback prints two different numbers.

⚠ **All three readouts need `structure`/`note`/`damping`/`brightness` at their LIVE
values.** `FaceReadoutValue` is params-only today; a CV-displaced macro is invisible to
it. Until the widened `{ read, sampleRate, readLive }` reader lands, **ship the labels
as `knob ring` / `knob partial 2`** — the honest fallback, exactly as batch 3 concluded.

---

## 7. THE BESPOKE CELL, AND THE ONE THING THAT MUST SHIP WITH IT

**LEGITIMATE — `rings-comb-{n}`: the pickup comb over the partial bank.** Draw the 24
partials on a log-frequency axis at their measured stretched positions, each bar's
height the product of its `Q^0.6` gain and its `cos(2π·p·i)` pickup weight, coloured by
which tap it lands in — and mirror the POSITION axis so the redundancy in §4-A is
*visible* rather than described. Every number in §6 becomes a picture, and it is the one
thing def introspection cannot synthesise.

### 7-A. ⚠ THE AUDITION NEEDS A FACTORY SEAM THAT DOES NOT EXIST YET

**`rings` has no `strum` param and no `read()` on its handle.** `strum` is worklet
INPUT 2 (`rings.ts:483`), fired by a rising edge in the processor (`:391`). The face's
`action` cell therefore cannot write a param — it needs the **karplus seam**: a
host-side `ConstantSource` wired to the strum input, plus
`read('manualTrigger') → () => fireTrigger(strikeCs, ctx.currentTime)`
(`packages/web/src/lib/audio/modules/karplus.ts:366-376`;
`$lib/audio/gate-trigger` `fireTrigger`).

That is **a factory change, not a DSP change** — no sample the worklet produces moves —
but it is still a change to a shipped module and it must be **in the same PR as the
face**, because `ShellActionCell.probe` is required and a face that declares an
`action` the seam cannot deliver is exactly the sixstrum defect. The `audition-ledger`
predicate (`delivered: false` recorded, never dropped) is what makes the difference
observable.

Scope it explicitly:
1. factory: add `strikeCs` + `read('manualTrigger')` (mirrors karplus verbatim);
2. `SHELL_CELLS`: a `mode:'trigger'` action with
   `probe: { effect: { kind: 'audition', seam: 'manual-strike' } }`;
3. a bespoke spec with a before/after negative control on the ledger.

### 7-B. THE CARD CANNOT PLAY THE INSTRUMENT EITHER

`RingsCard.svelte` has a MODEL button, six faders and a PatchPanel — **and no strum
control.** Combined with §3 (peak exactly 0.0 unpatched), a user who spawns RINGS and
turns every knob hears **nothing**, with no indication why. This is the sixstrum
complaint on the legacy card rather than on a face. Fixing it is the same factory seam
as 7-A plus one button; it is cheap and it should ship with the face.

---

## 8. ALREADY-WRONG

- **A · the `strum` port declares no `edge`.** `contract-lock.txt:2718` reads
  `rings in strum gate` with no `edge=`, while `docs.inputs.strum` (`rings.ts:432`)
  says "A TRIGGER … It fires on the edge only and ignores how long the level stays
  high" and the DSP does exactly that (`packages/dsp/src/rings.ts:391`). Because
  `module-docs-lint.test.ts` does `if (!p.edge) continue`, **the vocabulary gate skips
  the one port whose vocabulary is at stake** — the meowbox finding, on a second
  module. One-line fix: `edge: 'trigger'`. It is a contract change (`docs:accept`).
- **B · the ART harmonic scenario measures WINDOW LEAKAGE, not harmonics.**
  `art/scenarios/rings/resonator-character.test.ts:16-25` `powerAt` is an **unwindowed**
  DFT over a 91 200-sample decaying tail, and the test asserts `pH2 > pOff·0.5` on the
  **ODD** tap — where, per §1, h2 is structurally absent. *Measured at the test's own
  parameters:* h2 reads **−92.7 dB unwindowed** and **−206.5 dB Hann** — a **491 855×**
  discrepancy — and Hann-windowed `h2/h1 = 3.81e-8`, i.e. **−148 dB**. The assertion
  passes with a 2.43× margin on rectangular-window sidelobe leakage from h1 and h3.
  The test's own comment ("H2 / H3 can be slightly below the off-bin Goertzel
  measurement at very low test budgets") rationalises the leakage as a budget artifact.
  **Negative control run:** subtracting the least-squares 440 Hz component from the same
  buffer makes the assertion FAIL — confirming the quantity it reads is the leakage, not
  the partial. **The scenario currently passes** (`task art:one -- rings`, 4/4) — this is
  a green gate certifying something that is not true, not a red one.
  **Fix (own PR): window the probe, and assert h2 on the EVEN tap where it lives.**
- **C · BRIGHTNESS's doc omits ring time entirely** — §4-B. `rings.ts:449` and the
  `module-manifest` description both describe it as spectral only. In `STRICT_DOCS`.
- **D · LEVEL's "soft-limiter … gentle saturation" is 0.107 dB** — §4-F. Also
  `STRICT_DOCS`.
- **E · the card re-types every range and default as a literal.**
  `RingsCard.svelte:61-66`: `min={-60} max={60} defaultValue={0}`,
  `min={0} max={1} defaultValue={0.25}` … six times — on the same screen as `:17-18`,
  which correctly reads `ringsDef.params.find(...)!.defaultValue`. All six currently
  agree; that is the hazard, not the reprieve. `rings` is **not** in
  `RANGE_BOUND_CARDS` (`card-range-source.test.ts:89-98`, 8 entries), so no gate can
  see a divergence. **Convert to `paramSpec()` and enroll it in the same PR.**
- **F · `ringsMath` is a 250-line hand-duplicated copy of the worklet, and nothing
  compares them.** `packages/web/src/lib/audio/modules/rings.ts:75-373` re-declares
  `_Biquad`, `_RingsModal`, `_KSString`, `_Plucker`, `_RingsSympatheticStrings` —
  comment for comment. **Every unit test and the entire ART scenario exercise the
  MIRROR** (`resonator-character.test.ts:12` imports `ringsMath`); users hear the
  worklet. *Measured today they agree:* `max|Δ| = 2.980e-8` (float32 quantisation) over
  a 1 s strummed render, with a negative control at `damping 0.50 vs 0.51` reading
  **7.818e-3**, so the comparison is capable of failing. **There is no test that makes
  it.** One 20-line parity test in the dsp package closes a whole class.
  ⚠ Note one known structural divergence that happens not to matter for static params:
  the worklet re-`configure()`s every 32 samples (`rings.ts:383-387`) while the mirror
  configures once per render.
- **G · `cycleModel` is a raw dotted param write.** `RingsCard.svelte:38-39`:
  `const t = patch.nodes[id]; if (t) t.params.model = next;` — the dotted form that
  `mutate.guard`'s `RAW_PARAM_WRITE` (bracket-only) was structurally unable to see, one
  of the 96. Not a live bug; it belongs on the list.
- **No dead controls.** All seven params reach the DSP and every one measurably moves
  the output.

---

## 9. COST

| | |
|---|---|
| **contract-lock** | **+2 lines** if the audition is a control family (`rings family rings-comb kind=cell prefix=rings-comb`, `rings family rings-strum kind=other prefix=rings-strum`), **+1** if the strike lands as a `momentary` param instead. ⚠ It cannot: there is no `strum` PARAM (§7-A), so unlike clap/tomtom this audition is a family, not a press-param. **Plus 1 line if §8-A's `edge: 'trigger'` lands** — a real contract change, `task docs:accept`. |
| **ART** | none from the face. **§8-B is its own PR** (window the probe + move the h2 assertion to the EVEN tap) and it is a TEST change, not an audio change — no `.f32` exists for rings, so no re-pin. |
| **VRT** | rings is **not** in `STRICT_VRT_MODULES`, so the required lane does not move. The face adds `face-rings-{compact,dock}` × 2 platforms = **4 informational baselines**. ⚠ **The compact tile's `scope` glyph is safe here** where analogVco's was not: rings is silent unless struck (§3), so a frozen-graph capture reads zeros — the ordinary case #1420 already covers. |
| **e2e** | +1 `faces-parity` row. 9 cells (7 params + panel + audition), plus the audition probe. ≈ +15 s on one shard at the ~0.8 s/cell SwiftShader figure. |
| **the factory seam (§7-A)** | ~20 lines, copied from karplus. Not a DSP change; no ART or attest consequence. **Must be in the face PR**, not after it. |
