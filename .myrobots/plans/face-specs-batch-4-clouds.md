# FACE SPEC — `clouds` (batch 4)

> ## ⚠ READ §0-BIS BEFORE QUOTING ANY NUMBER FROM THIS FILE
>
> **§§2–8 are the measurements taken against `main` on 2026-08-09 and they are
> preserved as a RECORD, not as a reference.** Four of their headline figures did
> not survive re-measurement, and every site that states one is marked inline
> with `⚠ SUPERSEDED`. The corrected values, and *why the original instrument
> produced them*, are in §0-BIS immediately below.
>
> Superseded, in one line each:
> **"bit-zero for the first 0.25 s"** → one GRAIN LENGTH, 60 ms…1.5 s, moving
> with SIZE · **"the step is at exactly t = 2.000 s"** → a ramp, 2.02 → 2.30 s ·
> **"about 10.5 dB, implying N ≈ 11"** → 10.60 dB, and N is 24 (saturated) ·
> **§8's "no dead controls"** → SIZE's top 19.50 % was bit-identical to its
> maximum, undetected here and **fixed in #1456**.

## 0-BIS. RE-MEASURED AT BUILD TIME — three numbers below are WRONG (2026-08-10)

**Appended by the implementation (PR #1451), not by the spec's author.** The
build re-measured every claim against `cloudsMath` before writing a readout
around it, and the spec's own §3 headline did not survive. Recorded here because
these figures are quotable and two of them are quoted twice below.

| §  | the spec says | measured |
|----|---------------|----------|
| §3, §4-A, §5, §6-A | "bit-zero for the first **0.25 s**" | bit-zero for exactly **one GRAIN LENGTH**: 60.0 / 134.1 / **300.0** / 670.8 / 1087.2 / 1500.0 ms at size 0 / .25 / .5 / .75 / .9 / 1. POSITION-invariant to the sample. (The .9 and 1 figures were 800.0 / 800.0 when first re-measured — that was the dead zone, fixed in **#1456**; confirmed on the shipping worklet after the fix.) |
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

> **FIXED 2026-08-10 in the follow-up DSP PR (#1456), and the oracle did its
> job** — it went red at the fix and forced the claim to be withdrawn.
> Re-measured on the SHIPPING WORKLET rather than the mirror this time
> (`registerProcessor` shim + 128-sample block pump; the mirror is now pinned
> bit-identical to it as a permanent leg):
>
> * The plateau was **exactly 19.50 %** of travel, 0.805 → 1.0, and the
>   threshold sits between size 0.8047 and 0.8048 — `log(800/60)/log(25)`.
> * **The instrument point the original note missed:** bit-identity is NOT by
>   itself evidence of a dead control, because `lengthSamples =
>   floor(ms/1000·sr)` quantises. Two sizes render identically within
>   **Δsize ≈ 6e-6…2.7e-5** everywhere on the dial. What made this a defect is
>   the plateau's **WIDTH** — ~10⁴× the quantisation floor. A scan that only
>   asked "are these two identical?" would have called the whole dial dead.
> * **Cause:** two independent literals that disagreed. The law's top
>   (`maxMs = 1500`) and the clamp (`0.4 · 2.0 s = 800 ms`) were separately
>   typed, so nothing could notice. **Fix:** `GRAIN_MAX_MS` is now DERIVED from
>   `GRAIN_CAP_FRACTION` (raised 0.4 → 0.75, preserving the declared 1500 ms),
>   so the clamp is a guard that provably never binds.
> * **Cost, measured:** every SIZE at or below 0.8047 renders BIT-IDENTICALLY
>   before and after (sha256 over 12 probes plus the ART property corner), so no
>   reachable setting that produced a distinct sound changed. Everything above
>   changed — from one hash to eight distinct ones. Peak at SIZE 1 fell 0.961 →
>   0.707. No ART `.f32` baselines exist for clouds (§8-C), so nothing to
>   re-pin.

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
| 1 | `blend` | ranked first on a processor because the module is **silent for its first quarter-second and 12 dB down for two seconds** (§4-A) — BLEND is the control that tells you whether you are hearing it at all. ⚠ SUPERSEDED (§0-BIS): the silence is one GRAIN LENGTH, not a quarter second. The ranking argument survives. |
| 2 | `density` | the grain count. The largest real span on broadband: 8.80 dB. |
| 3 | `pitch` | ranked 3 because it is **also a −10.5 dB fader the instant it leaves zero** (§4-B), which is the module's single most surprising behaviour. ⚠ SUPERSEDED (§0-BIS): 10.60 dB, and the `N ≈ 11` inference is wrong. |
| 4 | `size` | grain length. 5.05 dB span, non-monotone (§4-D). ⚠ SUPERSEDED: that ladder was measured with the top 19.50 % of the dial CLAMPED (§0-BIS); the 0.75 and 1.0 columns changed in #1456. |
| 5 | `position` | **the strongest control in the module and the one no level metric can see** (§4-C). Ranked 5, not higher, precisely because at the lane tiers it would show as a dial that does nothing. |
| 6 | `freeze` | the latch — a `momentary`?ate **no**: it is a LATCHING toggle, not a press-pad (§5-A). |
| 7 | `clouds-buffer-{n}` | the picture. First legal panel rank. |
| 8 | `texture` | dock-only. **Its top half is worth 0.01 dB** (§4-E). |

**NO AUDITION.** clouds is an insert with nothing to strike. Its "play me" affordance is
FREEZE, which is a real param and is ranked.

---

## 3. INERT AT SPAWN — twice over, and the second one is a stopwatch

⚠ **SUPERSEDED — BOTH HEADLINE NUMBERS IN THIS SECTION ARE WRONG. See §0-BIS.**
The 0.25 s bucket grid below cannot resolve a 60 ms window and reports a
transition's LEVEL rather than its EDGE. Kept verbatim because *how* it went
wrong is the section's real value.

Unpatched: `out_l` / `out_r` peak **0.000e+0**.

With audio patched and `blend 1`, *measured* quarter-second RMS ladder from the very
first sample (broadband noise in, defaults):

```
 -∞   -10.4  -17.0  -17.0  -17.5  -17.3  -16.8  -16.8 │ -9.7  -5.6  -5.4  -5.2  -5.2  -5.2 …
 └── first 0.25 s: DIGITAL SILENCE ──┘                └── the step is at exactly t = 2.0 s
```

- ~~**The first quarter second is bit-zero.**~~ ⚠ It is bit-zero for exactly ONE
  GRAIN LENGTH — 300 ms at this SIZE, 60 ms…1.5 s across the travel.
- **The next 1.75 s run ~12 dB below steady state.** ✓ survives.
- ~~The step lands at **t = 2.000 s**, which is `BUFFER_SECONDS` to the sample~~ ⚠
  2.0 s is when the RING fills; the LEVEL ramps from ≈2.02 s to ≈2.30 s, because a
  grain spawned just before the fill reads partly-unwritten tape for its whole
  life. Until the ring has been written all the way round, most grains are
  reading zeros — that part is right.

**NEGATIVE CONTROL:** the dry path over the same window measures a 0.00 dB span, so this
is the module and not the probe.

**This is the single most face-worthy thing about `clouds`**: "I patched it and nothing
happened" is the correct description of its first two seconds, and there is currently
nothing anywhere — card, docs or manifest — that says so.

---

## 4. WHAT THE FACE MUST MAKE VISIBLE — five measured facts

### A. See §3 — AND §0-BIS, which supersedes both of §3's headline figures.

It recurs every time the buffer is cleared or the source stops, and it is what makes
FREEZE feel magic when it works and broken when it does not.

### B. PITCH is a −10.5 dB fader the moment it leaves zero — symmetrically

⚠ **SUPERSEDED in part (§0-BIS): the step is 10.60 dB, and the `N ≈ 11`
inference below is wrong** — the pool SATURATES at 24 from density 0.489 at the
shipped SIZE. The SHAPE (a threshold at zero, not a slope) is confirmed.

*Measured*, broadband noise, `blend 1`, 2–6 s average:

| pitch (st) | −24 | −12 | **0** | +12 | +24 |
|---|---|---|---|---|---|
| RMS | −17.46 dB | −16.03 | **−5.46** | −15.97 | −15.95 |

**Leaving zero in either direction costs about 10.5 dB, and going further costs almost
nothing more.** That shape is the tell: at `pitch 0` every grain reads the buffer at
exactly the write rate, so the overlapping grains stay **phase-coherent** and sum
linearly (`N·a`); at any other pitch they decorrelate and sum in power (`√N·a`). The
difference is `10·log10(N)`, and ~~**10.5 dB implies N ≈ 11** simultaneously-sounding
grains, against a `MAX_GRAINS` of 24 — which is a plausible steady-state count at
`density 0.5`~~ ⚠ **WRONG (§0-BIS): N is 24, saturated.** The inference fails
because `10·log10(N)` is not the right model — the real ratio is
`10·log10(N·E[env]²/E[env²])` (12.55 dB here) and even that is 4.7 dB out at
TEXTURE 0, because neither models the output `tanh`. A plausible number reached
by inverting the wrong formula, which is why the face prints no derived dB
anywhere.

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

⚠ **THE `size` ROW WAS MEASURED WITH THE TOP OF THE DIAL CLAMPED.** Its 1.0
column was really "the same render as 0.805". Re-measured on the shipping
worklet after #1456 (same probe, 2.5–6 s, blend 1): **−10.47 / −10.21 / −5.27 /
−7.59 / −6.01** at 0 / .25 / .5 / .75 / **1**, with −5.67 at 0.8047 and −5.45 at
0.9. Still non-monotone, still loudest near the default; the top of the travel
is now a real 800→1500 ms extension rather than a repeat of 800 ms.

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

## 5–7 · DELETED 2026-08-12 (the face SHIPPED — #1451)

The proposed `face` block, the derived-readout derivations and the
bespoke-cell argument were deleted: the shipped def is the record, and the
build re-measured the numbers it needed. §§1–4 (the measurements) and §8 (the
defects) are kept.

---

## 8. ALREADY-WRONG

- **A · nothing anywhere states the two-second fill.** Not the def's `docs.explanation`,
  not `module-manifest.ts`, not the card. Measured: ~~bit-zero for 0.25 s~~ ⚠ one GRAIN
  LENGTH (§0-BIS), ~12 dB down to
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
