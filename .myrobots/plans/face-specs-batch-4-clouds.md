# FACE SPEC — `clouds` (batch 4)

## 0-BIS. RE-MEASURED AT BUILD TIME — three numbers below are WRONG (2026-08-10)

**Appended by the implementation (PR #1451), not by the spec's author.** The
build re-measured every claim against `cloudsMath` before writing a readout
around it, and the spec's own §3 headline did not survive. Recorded here because
these figures are quotable and two of them are quoted twice below.

| §  | the spec says | measured |
|----|---------------|----------|
| §3, §4-A, §5, §6-A | "bit-zero for the first **0.25 s**" | bit-zero for exactly **one GRAIN LENGTH**: 60.0 / 134.1 / **300.0** / 670.8 / 800.0 ms at size 0 / .25 / .5 / .75 / .9. POSITION-invariant to the sample. |
| §3, §5 | "the step is at exactly **t = 2.000 s**, to the sample" | 2.0 s is when the RING fills. At 2.00 s the output is still ~12 dB down; the climb runs **2.02 → 2.30 s**, i.e. `BUFFER_SECONDS + one grain`. |
| §4-B, §6-C | "about **10.5 dB**, implying N ≈ 11 grains" | **10.60 dB** measured. N is not ~11: the pool SATURATES at **24** from density 0.489 at the shipped SIZE. The first-principles ratio `10·log10(N·E[env]²/E[env²])` gives 12.55 dB and is 4.7 dB out at TEXTURE 0, because it does not model the output `tanh` — so no derived dB is printed anywhere. |

**Why the spec got the first two wrong, and it is a method note rather than a
correction:** it measured on a **0.25 s RMS bucket grid**. A bucket cannot
resolve a 60 ms window, and it reports the *level* of a transition rather than
its *edge*. The build's oracle reads the **first non-zero SAMPLE** — a time, not
a level. The spec's own §0 warning ("my first two passes disagreed by 18 dB
because they averaged different windows of a signal I had assumed was
stationary") is the same instrument problem, caught once and not the second
time.

**NOT IN THE SPEC AT ALL — a real dead zone.** `safeLen = min(lengthSamples,
floor(bufLen·0.4))` caps the grain at 800 ms, so **SIZE 0.805 / 0.85 / 0.9 / 1.0
render BIT-IDENTICAL output — 19.5 % of the dial**. §8's "no dead controls" is
false. Worklet arithmetic, so it is deferred to a DSP PR; the face prints
`CLAMPED` and a bit-identity oracle turns that claim red when it is fixed.

**Resolved from the spec's open questions:** §6-A's `clouds-buffer-fill` is NOT
shipped and no widened `FaceReadoutValue` was built — there is no honest
observable (`fillLevel` is not an AudioParam and the worklet posts nothing) and
a `currentTime`-derived one would make the VRT baseline a race. The hero panel
is a pure function of the six macros instead, and the two facts a live head
would have shown are printed as numbers (`silent for` / `full level at`) that
move with SIZE. §5-A's ruling (freeze is LATCHING, not `momentary`) was
confirmed, though not by the stated mechanism: the worklet does not read the
param as a level, it toggles on the rising edge. The conclusion survives — a
momentary render pulses on press *and* release, so the latch is un-holdable.

## 0. STATUS

**Authored 2026-08-09. Every claim below was measured or read against `main`**
(`ecc48f2e`). Nothing here is implemented; no def, card or DSP file is touched.

**Verdict: PROMOTE.** archetype: **granular TEXTURE processor** (the only one in the
rack; `samsloop` and `twotracks` are buffer players, not grain clouds).

Not in `STRICT_FACES`; no `face:` block. In `STRICT_DOCS`; **not** in
`STRICT_VRT_MODULES`. 7 params, 10 in, 2 out. contract-lock = **22 lines**.

**Method — and the method is half the finding.** `packages/dsp/src/clouds.ts` bundled
with esbuild and run offline at 48 kHz.

⚠ **MY FIRST TWO PASSES DISAGREED BY 18 dB ON THE SAME SETTING**, because they averaged
different windows of a signal I had assumed was stationary. It is not. Everything below
is measured on **broadband noise, averaged over 2–6 s**, with a **permanent negative
control**: the same probe on the DRY path (`blend 0`) measures **0.00 dB of variation**
for all three test signals, so a moving number is the module and not the meter. A pure
sine is a *pathological* granular source — every grain is coherent, so they beat — and
where a figure below could only have come from a sine it says so.

---

## 1. WHAT IT ACTUALLY DOES

A 2-second stereo ring buffer, up to 24 overlapping windowed grains read out of it, and
a dry/wet crossfade. `BUFFER_SECONDS = 2.0`, `MAX_GRAINS = 24`
(`packages/dsp/src/clouds.ts:70-71`). Six k-rate macros plus an a-rate `freeze`.

Everything about how it *feels* follows from one thing the panel never says: **the grains
are only coherent when nothing is transposing them.**

---

## 2. THE CONTROLS THAT MATTER — 7 params, and the lane cut

| rank | control | why |
|---|---|---|
| 1 | `blend` | ranked first on a processor because the module is **silent for its first quarter-second and 12 dB down for two seconds** (§4-A) — BLEND is the control that tells you whether you are hearing it at all. |
| 2 | `density` | the grain count. The largest real span on broadband: 8.80 dB. |
| 3 | `pitch` | ranked 3 because it is **also a −10.5 dB fader the instant it leaves zero** (§4-B), which is the module's single most surprising behaviour. |
| 4 | `size` | grain length. 5.05 dB span, non-monotone (§4-D). |
| 5 | `position` | **the strongest control in the module and the one no level metric can see** (§4-C). Ranked 5, not higher, precisely because at the lane tiers it would show as a dial that does nothing. |
| 6 | `freeze` | the latch — a `momentary`?ate **no**: it is a LATCHING toggle, not a press-pad (§5-A). |
| 7 | `clouds-buffer-{n}` | the picture. First legal panel rank. |
| 8 | `texture` | dock-only. **Its top half is worth 0.01 dB** (§4-E). |

**NO AUDITION.** clouds is an insert with nothing to strike. Its "play me" affordance is
FREEZE, which is a real param and is ranked.

---

## 3. INERT AT SPAWN — twice over, and the second one is a stopwatch

Unpatched: `out_l` / `out_r` peak **0.000e+0**.

With audio patched and `blend 1`, *measured* quarter-second RMS ladder from the very
first sample (broadband noise in, defaults):

```
 -∞   -10.4  -17.0  -17.0  -17.5  -17.3  -16.8  -16.8 │ -9.7  -5.6  -5.4  -5.2  -5.2  -5.2 …
 └── first 0.25 s: DIGITAL SILENCE ──┘                └── the step is at exactly t = 2.0 s
```

- **The first quarter second is bit-zero.**
- **The next 1.75 s run ~12 dB below steady state.**
- The step lands at **t = 2.000 s**, which is `BUFFER_SECONDS` to the sample: until the
  ring buffer has been written all the way round, most grains are reading zeros.

**NEGATIVE CONTROL:** the dry path over the same window measures a 0.00 dB span, so this
is the module and not the probe.

**This is the single most face-worthy thing about `clouds`**: "I patched it and nothing
happened" is the correct description of its first two seconds, and there is currently
nothing anywhere — card, docs or manifest — that says so.

---

## 4. WHAT THE FACE MUST MAKE VISIBLE — five measured facts

### A. See §3. The two-second fill is a *fact about the instrument*, not a startup detail.

It recurs every time the buffer is cleared or the source stops, and it is what makes
FREEZE feel magic when it works and broken when it does not.

### B. PITCH is a −10.5 dB fader the moment it leaves zero — symmetrically

*Measured*, broadband noise, `blend 1`, 2–6 s average:

| pitch (st) | −24 | −12 | **0** | +12 | +24 |
|---|---|---|---|---|---|
| RMS | −17.46 dB | −16.03 | **−5.46** | −15.97 | −15.95 |

**Leaving zero in either direction costs about 10.5 dB, and going further costs almost
nothing more.** That shape is the tell: at `pitch 0` every grain reads the buffer at
exactly the write rate, so the overlapping grains stay **phase-coherent** and sum
linearly (`N·a`); at any other pitch they decorrelate and sum in power (`√N·a`). The
difference is `10·log10(N)`, and **10.5 dB implies N ≈ 11** simultaneously-sounding
grains, against a `MAX_GRAINS` of 24 — which is a plausible steady-state count at
`density 0.5`.

So PITCH is not "transpose"; it is "transpose **and** drop 10.5 dB". A player automating
PITCH through zero gets a 10 dB level bump at the centre detent.

### C. POSITION is the strongest control on the module and it is INVISIBLE to every level metric

*Measured* on broadband noise: span across the whole travel = **0.17 dB**. On a marked
source (a 4 Hz click train, where position genuinely selects different material):
**0.63 dB**.

That reads like a dead control. It is the opposite. On the same click-train probe,
`max|Δ|` against `position 0.5` measures **9.82e-1** — on a signal whose own peak is
about 1.0, i.e. **an entirely different waveform** at every position, with the level
unchanged to within two thirds of a decibel.

⚠ **This is the blind-metric trap in its purest form in this batch.** Every RMS-based
sweep in the repo, and my own first three passes, report "POSITION does nothing". The
correct instrument is a **difference** metric against a *marked* source, and it says the
control is total.

**Consequence for the face:** POSITION's readout must not be a level or a number. It is
the one control here that needs the *picture* (§7) — a playhead on the buffer.

### D. SIZE is non-monotone; DENSITY and TEXTURE spend their upper halves cheaply

Broadband, 2–6 s average, `blend 1`:

| | 0 | 0.25 | 0.5 | 0.75 | 1 | span |
|---|---|---|---|---|---|---|
| `density` | −14.27 | −9.60 | **−5.46** | −5.53 | −5.50 | 8.80 dB |
| `size` | −10.52 | −10.31 | **−5.46** | −7.77 | −6.19 | 5.05 dB |
| `texture` | −2.52 | −3.51 | **−5.46** | −5.46 | −5.46 | 2.94 dB |
| `position` | −5.30 | −5.47 | **−5.46** | −5.46 | −5.47 | 0.17 dB |
| `blend` | −10.81 | −11.91 | −10.37 | −7.83 | **−5.46** | 6.44 dB |

- **SIZE peaks in the middle** (−5.46 at 0.5) and is 5 dB quieter at both ends. A knob
  whose loudest point is its default and which gets quieter in both directions.
- **DENSITY's top half is level-flat** (−5.46 / −5.53 / −5.50) but **not inert**:
  `max|Δ|` against `density 0.5` measures 0.99 / 1.09 / 1.03 / **1.20** at
  0.6 / 0.75 / 0.9 / 1.0. It changes the sound completely and the level not at all —
  the same shape as POSITION, one notch less extreme.
- **TEXTURE's top half is very nearly inert.** RMS across 0.5 → 1.0 moves **0.010 dB**
  (−5.612 → −5.602) and `max|Δ|` only reaches 8.208e-2. On the sine probe the sidebands
  move 2.2 dB (440 Hz: −46.6 → −44.4) and the centroid 1 Hz. **So roughly half of
  TEXTURE's physical travel is worth about 2 dB of a sideband.** Not dead — the smallest
  real control on the module by a wide margin, and the reason it is ranked last.
- **BLEND is not monotone either**: −10.81 / −11.91 / −10.37 / −7.83 / −5.46. It dips
  **1.1 dB below dry at blend 0.25**, because a partly-decorrelated wet signal
  partially cancels the dry it is crossfading against. A crossfade with a hole in it.
  ⚠ **BLEND 0 is dry to 2.274e-13** — effectively bit-exact (float32 rounding). A
  checked non-defect.

### E. Level behaviour is exemplary, and that is worth stating

**0 of 54 measured corners exceed full scale** on a −6 dBFS broadband input; the worst is
**0.9893 (−0.09 dBFS)**. Against treeohvox (+6.70 dBFS), sidecar (+17.98) and resofilter
(+44.4) in this same batch, `clouds` is the only one of the four that stays inside the
rails everywhere. The face should not warn about a hazard this module does not have.

**And the stereo spread from a mono source is real but modest:** `rms(L−R)` measures
**−27.44 dB** against `L` at −8.81 dB, i.e. the side signal is **18.6 dB below mid**.
"Shimmering cloud" is fair; "wide" would not be.

---

## 5. THE FACE

```ts
face: {
  title: 'Texture',
  hint:
    'A 2-second ring buffer sprayed back out as up to 24 overlapping grains. It is SILENT for its ' +
    'first quarter second and 12 dB down until the buffer has filled at exactly 2.0 s. PITCH is ' +
    'not just a transpose: at 0 the grains are phase-coherent, and leaving zero in either ' +
    'direction costs about 10.5 dB. POSITION changes the sound completely and the level not at all.',

  order: [
    'blend', 'density', 'pitch', 'size', 'position', 'freeze',   // 1-6 = the lane budget
    'clouds-buffer-{n}',                                          // panel: first legal rank is 7
    'texture',
  ],
  pages: [
    { id: 'buffer', label: '1 · the buffer — two seconds, and it must FILL first',
      hint: 'Measured from spawn: bit-zero for 0.25 s, then ~12 dB down until t = 2.0 s, which is ' +
            'BUFFER_SECONDS exactly. FREEZE latches the buffer so the texture keeps playing with no ' +
            'input — and freezing BEFORE anything has been recorded holds it at digital silence.',
      controls: ['clouds-buffer-{n}', 'position', 'freeze'] },
    { id: 'grains', label: '2 · the grains',
      hint: 'DENSITY is the overlap count (8.8 dB of span, all of it below 0.5 — the top half changes ' +
            'the sound completely and the level by 0.07 dB). SIZE is loudest at its DEFAULT and ' +
            '5 dB quieter at both ends. TEXTURE’s upper half is worth 0.01 dB.',
      controls: ['density', 'size', 'texture'] },
    { id: 'out', label: '3 · pitch and blend',
      hint: 'Leaving PITCH 0 decorrelates the grains and costs 10.5 dB in either direction — a level ' +
            'bump at the centre detent. BLEND dips 1.1 dB BELOW dry around 0.25 where the wet ' +
            'partially cancels it; blend 0 is bit-exact dry.',
      controls: ['pitch', 'blend'] },
  ],
  glyph: 'meter',

  hero: {
    cell:    'clouds-buffer-{n}',
    control: 'position',
    readouts: [
      { label: 'buffer',  valueId: 'clouds-buffer-fill' },
      { label: 'grain',   valueId: 'clouds-grain-ms' },
      { label: 'coherent', valueId: 'clouds-coherence-state' },
    ],
  },

  sidebar: [
    { kind: 'signal-flow', label: 'signal flow', stages: [
      { label: 'IN L/R',      role: 'generator' },
      { label: 'RING 2.0 s',  role: 'bus', note: 'writes stop under FREEZE' },
      { label: 'GRAIN SCHED', role: 'bus', note: 'DENSITY · up to 24' },
      { label: 'READ @ POSITION', role: 'bus', note: 'SIZE · PITCH' },
      { label: 'WINDOW',      role: 'bus', note: 'TEXTURE' },
      { label: 'DRY',         role: 'bus', parallel: true, note: 'bit-exact at BLEND 0' },
      { label: 'BLEND → OUT', role: 'bus', note: 'linear crossfade; dips 1.1 dB at 0.25' },
    ] },
  ],
}
```

⚠ **5-A · `freeze` IS A LATCHING TOGGLE, NOT A MOMENTARY PAD.** Its shape
(`0..1 discrete default 0`) is identical to a press-param, and `ModuleFace.momentary`
exists precisely because shape cannot tell them apart. **Do NOT list it in
`momentary`** — the worklet reads it as a level and ORs it with `freeze_gate`
(a-rate), so a momentary render would make the latch un-holdable. This is the
kickdrum/snaredrum `hard` case, not the tomtom/clap `strike` case. Getting it wrong is a
one-word error that breaks the module's headline feature.

⚠ `title` / `hint` / band hints are ANNOTATION and paint nothing at rest
(`dock-faceplate-model.ts:90`). Band 1's LABEL carries the two-second fact.

⚠ Band 1's label is 47 characters — **the longest in this batch.** Label clipping is
invisible to `faces-parity`. **Measure it**; the fallback that keeps the fact is
`1 · the buffer — 2 s, and it must FILL`.

⚠ `clouds-buffer-{n}` is rank 7 because `faceTierCap('full')` is 6 and a PANEL cell
cannot be selected at a lane tier. Eight keys total, so rank 7 is reachable.

---

## 6. DERIVED READOUTS

### A. `clouds-buffer-fill` — the readout that answers "why is nothing happening"

Percentage of the 2-second ring that has been written since the last clear, printed as
`filling 43 %` / `full` / `FROZEN`.
**NEGATIVE CONTROL — time itself.** No knob readback of any kind can produce this; it is
not a function of any param. It must reach the engine. **SECOND CONTROL — `freeze`:** it
must STOP advancing under freeze and must not reset. *Measured anchors:* bit-zero for
0.25 s, −12 dB until 2.0 s, steady after.
⚠ **This needs the widened `FaceReadoutValue`** (`readLive` / an engine leg);
`FaceReadoutValue` is params-only today. **This readout cannot ship honestly as a
param-derived value at all** — there is no param to derive it from — so either it lands
with the widened reader or it is omitted. **Do not substitute a static string.**

### B. `clouds-grain-ms` — the grain length in milliseconds

`SIZE` maps to a grain length; print the ms, not the 0..1.
**NEGATIVE CONTROL — `density`.** Grain LENGTH must be invariant to how many are firing,
while §4-D shows DENSITY moving the output 8.8 dB. **SECOND — `pitch`:** a transposed
grain covers a different amount of buffer in the same output time, so the readout must
state which it prints (**source ms** or **output ms**) and they differ by `2^(pitch/12)`.
⚠ **State the units and the frame in the label.** This is a two-clocks readout and the
label is the only place the ambiguity can be resolved.

### C. `clouds-coherence-state` — the 10.5 dB the PITCH knob does not mention

Prints `coherent` at `pitch == 0` and `spread −10.5 dB` otherwise.
**NEGATIVE CONTROL — `pitch` at ±0.5 st.** A knob readback prints `0.50 st`, a
musically negligible detune; the measured level consequence is the full ~10.5 dB step,
because coherence is a **threshold**, not a slope (measured −5.46 dB at 0 against
−15.97 / −16.03 at ±12 and −15.95 / −17.46 at ±24 — the step is at zero, not spread
across the travel). **SECOND CONTROL — `pitch_cv`:** a slow LFO on pitch crossing zero
produces a periodic 10 dB bump that no static readout can predict; needs `readLive`.
⚠ **HONESTY TERM: 10.5 dB is `10·log10(N)` for the ~11 grains sounding at
`density 0.5`.** It is therefore **density-dependent** and the readout must either
compute it from the live density or print it as approximate. A hard-coded "−10.5 dB"
would be right at one setting and wrong everywhere else.

---

## 7. THE BESPOKE CELL

**LEGITIMATE — `clouds-buffer-{n}`: the ring buffer with its playhead.** Two seconds of
buffer drawn as a ring or a strip; the write head advancing (or stopped, under FREEZE);
the POSITION read point; the active grains drawn as arcs whose length is SIZE and whose
count is DENSITY; unwritten regions shaded. That picture answers §3, §4-A and §4-C at
once — and §4-C is a control that **cannot be represented as a number at all**, which is
the strongest possible argument for a panel.

---

## 8. ALREADY-WRONG

- **A · nothing anywhere states the two-second fill.** Not the def's `docs.explanation`,
  not `module-manifest.ts`, not the card. Measured: bit-zero for 0.25 s, ~12 dB down to
  2.0 s. `clouds` is in `STRICT_DOCS`, so the completeness gate is satisfied by prose
  that omits the module's most confusing behaviour — the gate checks that a sentence
  EXISTS, not that it is the right sentence.
- **B · `docs.controls.position` describes a control that no level-based test can
  verify**, and none does. §4-C. Not a doc error — a **coverage** hole: if POSITION
  broke tomorrow the RMS-based sweeps would stay green (measured span 0.17 dB
  broadband). **The test that would catch it is a difference metric against a marked
  source**, and it does not exist.
- **C · `art/scenarios/clouds/granular-texture.test.ts` is the only ART coverage and
  there is no `art/baselines/clouds/`** — so the scenario asserts properties, not bytes.
  Worth knowing before anyone proposes a DSP change here: **there is no pinned audio to
  re-pin, and equally none to protect you.**
- **D · the card re-types the ranges**; `clouds` is not in `RANGE_BOUND_CARDS`.
- **E · `freeze` is a latch whose shape is indistinguishable from a press-pad**, and the
  face is the first surface that has to decide. §5-A. Flagged before it ships, not after.
- **No dead controls** — but two (**POSITION**, and **DENSITY above 0.5**) are dead to
  every metric the repo currently uses, which is a different and more dangerous thing.

---

## 9. COST

| | |
|---|---|
| **contract-lock** | **+1 line** (`clouds family clouds-buffer kind=cell prefix=clouds-buffer`). No audition. |
| **ART** | none from the face; no `.f32` baselines exist to re-pin (§8-C). |
| **VRT** | not in `STRICT_VRT_MODULES`. +`face-clouds-{compact,dock}` × 2 = **4 informational baselines**. ⚠ **The `clouds-buffer` panel animates** — a write head advancing in real time. Under #1420's frozen-graph capture the AudioContext is suspended before the tile is framed, so the head should rest at a deterministic position; **verify that specifically** (10 separate processes, unmasked, the analogVco derivation) rather than assuming, because this is the first face panel whose picture is a function of TIME rather than of params. |
| **e2e** | +1 `faces-parity` row, 8 cells, no audition ≈ +14 s on one shard. |
