# FACE SPEC — `hypercube` (batch 5)

## 0. STATUS

**Authored 2026-08-10. Every claim below was measured or read against `main`**
(`153e5c36`). Nothing here is implemented; no def, card or DSP file is touched.

**Verdict: BLOCKED — do not face this module until ONE question is answered.
`alpha` and `morph_fc` — the two controls that make HYPERCUBE a hypercube rather
than a CUBE — are IDENTICAL in every phase-invariant statistic at 0, 0.5 and 1.
I cannot yet distinguish "dead controls" from "my harness never loaded the fourth
wavetable", and the difference decides whether this is a face PR or a P1 bug.**

Separately and independently measurable: **both audio outputs carry a −0.375 DC
offset at every setting of every control** (the AC signal is 0.348 rms — the
offset is LARGER than the signal), and **the module is not reproducible
run-to-run** (`max|run1 − run2| = 8.453e-1` on identical params, against
`0.000e+0` for every other module in this batch).

archetype: **the 4-D WAVETABLE-TERRAIN OSCILLATOR** — the tesseract sibling of
`cube`.

Not in `STRICT_FACES`; no `face:` block. In `STRICT_DOCS`; **not** in
`STRICT_VRT_MODULES`; **not** in `PUSH_CARD_CONTROLS`. 20 params, 11 in, 3 out
(2 audio + `mono-video`). contract-lock = **35 lines**.

**Method.** REAL factory → REAL worklet (`packages/dsp/src/hypercube.ts`) under
`node-web-audio-api`'s `OfflineAudioContext`, 48 kHz.

---

## 1. THE INSTRUMENT HAD TO BE REBUILT TWICE, AND BOTH FAILURES ARE THE FINDING

**Failure 1 — `max|Δ|` is unusable on this module.** A first pass swept every
param and read `Δ = 8.45e-1` for `alpha` at 0.25 / 0.5 / 0.75 / 1 — the *same*
number at all four, with `acRms` identical to six decimals. That incoherence
(a "big effect" that does not grow with the control) is the tell. A determinism
control settled it:

| module | `max|run1 − run2|` on identical params |
|---|---|
| swolevco | 0.000e+0 |
| warrensspectrum | 0.000e+0 |
| cofefve | 0.000e+0 |
| ninelives | 0.000e+0 |
| **hypercube** | **8.453e-1** |

**hypercube renders differently every time**, by nearly full scale in the sample
domain, while its RMS is stable to eight significant figures — the signature of a
random start phase. So every `Δ` figure in the first pass was phase noise
dressed as a measurement.

**Failure 2 — RMS alone is not enough either.** RMS is blind to timbre, so a
"no change in RMS" reading proves nothing on a wavetable oscillator. The
instrument that settles it is **phase-invariant and spectrum-sensitive**: rms to
8 s.f., peak to 6 d.p., Hann-windowed spectral centroid to 0.1 Hz, and five
log-band energies to 0.01 dB.

---

## 2. WHAT THAT INSTRUMENT SAYS

*Measured*, 1 s render, tail half, everything else at defaults:

| patch | rms | peak | centroid | band energies 20/80/320/1250/5k–20k (dB) |
|---|---|---|---|---|
| default | 0.51118300 | 0.845406 | 3174.0 Hz | −87.44 −5.03 −15.56 −16.89 −26.13 |
| **`alpha = 0`** | 0.51118300 | 0.845406 | 3174.0 | −87.44 −5.03 −15.56 −16.89 −26.13 |
| **`alpha = 0.5`** | **0.51118300** | **0.845406** | **3174.0** | **−87.44 −5.03 −15.56 −16.89 −26.13** |
| **`alpha = 1`** | **0.51118300** | **0.845406** | **3174.0** | **−87.44 −5.03 −15.56 −16.89 −26.13** |
| **`morph_fc = 0.5`** | **0.51118300** | **0.845406** | **3174.0** | **−87.44 −5.03 −15.56 −16.89 −26.13** |
| **`morph_fc = 1`** | **0.51118300** | **0.845406** | **3174.0** | **−87.44 −5.03 −15.56 −16.89 −26.13** |
| `fold = 0.5` | 0.68777972 | **1.000000** | 3207.1 | −65.27 −2.58 −14.50 −14.24 −23.37 |
| `fold = 1` | 0.69840082 | 0.999998 | 3245.1 | −68.72 −2.55 −14.85 −14.15 −22.97 |
| `crush = 0.5` | 0.51005894 | 0.854697 | **3826.8** | −68.84 −5.05 −15.59 −17.11 −27.74 |
| `spread = 0.5` | 0.50786492 | 0.833468 | 3186.6 | **−72.86** −5.03 −15.58 −16.90 −26.12 |

**`alpha` and `morph_fc` do not move a single figure.** The three positive
controls all do — `fold` moves rms by 36 % and clips the peak to 1.000000,
`crush` moves the centroid by 653 Hz, `spread` moves the 20–80 Hz band by 15 dB.
The instrument is demonstrably not blind.

---

## 3. WHY THIS IS "BLOCKED" AND NOT "TWO DEAD CONTROLS"

Both params **are** read by the worklet — `this.smAlpha.step(...)` and
`this.smMorphFc.step(...)` at `hypercube.ts:374,379`, and `alpha` is part of the
field-recompute cache key at `:294-319`. `alpha`'s job is to blend the fourth
(HOLO) wavetable into the field: `f4 = (1−alpha)·f3 + alpha·dH`, and
`docs.controls.alpha` says *"0 = identity to a 3-table CUBE render (the HOLO
table is inert)"*.

**If the HOLO table is never loaded, `dH` equals `f3` and `alpha` is correctly a
no-op.** And the tables ride `workletNode.port.postMessage({ type:
'loadWavetable', … })` (`hypercube.ts:285`) — a MessagePort hop whose delivery is
**not guaranteed to land before an OfflineAudioContext finishes rendering faster
than real time.** So the honest statement is:

> **With the tables this harness delivered, ALPHA and MORPH_FC are identical in
> every phase-invariant statistic. Whether that is the module or the harness is
> NOT DETERMINED.**

**The instrument that settles it** is the one `macrooscillator` used: bundle
`packages/dsp/src/hypercube.ts` against stubbed worklet globals with esbuild,
instantiate `HypercubeProcessor` directly, **hand it the four factory tables
synchronously**, and re-run the same phase-invariant ladder. That is a
half-day of work and it must happen **before** a faceplate paints ALPHA as a
working control. Putting a live-looking dial on a dead one is the precise defect
`macrooscillator`'s face was built to avoid.

---

## 4. THE DC OFFSET — measurable NOW, and independent of §3

*Measured*, `acRms` (RMS after removing the mean) and the mean itself, on `L`,
tail half of a 0.5 s render:

| patch | DC | acRms | peak |
|---|---|---|---|
| **defaults** | **−0.375433** | 0.348243 | 0.8454 |
| `tune = ±36` | −0.372983 … −0.374425 | 0.3486 | 0.8454 |
| `fold = 1` | **−0.523562** | 0.459852 | 1.0000 |
| `level = 2` | **−0.750866** | 0.696486 | **1.6908** |
| `wrap = 1` | **+0.119504** | 0.562110 | 0.8835 |
| `slice_ry = −3.1416` | −0.377875 | 0.362196 | 0.9989 |
| `level = 0` | 0.000000 | 0.000000 | 0.0000 |

**At the factory defaults the DC offset is −0.375 against an AC signal of
0.348 — the offset is larger than the sound.** It is present at *every* setting
of *every* control (only `level = 0` removes it, by removing everything), it
scales with `level` (−0.751 at level 2), and `wrap = 1` is the only control that
changes its sign.

This is the same class as the `cube` rebuild's blocker (`crush ≥ 0.999` and
`space_diffuse = 1.0` driving `acRms` to zero with a full-scale DC), **with the
difference that cube's fault lives at two knob extremes and hypercube's is the
default state.** It is also invisible to any RMS-based check: a plain rms probe
reads 0.51 and calls it healthy.

⚠ **NOT DETERMINED: whether a DC blocker sits downstream in the shipping graph.**
The measurement is taken at the def's declared `L`/`R` output ports — what a
patch cable sees — and the factory adds no highpass between the worklet and those
refs that this read found. But the master bus may. **Check `audio-out`'s chain
before filing.**

---

## 5. WHAT ELSE IS TRUE — five params are VIDEO-ONLY

*Measured*: `view_rot_x`, `view_rot_y`, `view_rot_z`, `view_zoom` and `screen_on`
are **bit-identical on both audio outputs** across their full ranges
(`dc = −0.375433`, `acRms = 0.348243`, `peak = 0.8454` at every value). They aim
the WebGL camera at the `video_out` port. Correct — and it means **five of twenty
params on an `domain=audio` module do nothing audible**, which is precisely the
kind of thing a faceplate should band separately rather than mixing into the
oscillator's controls.

Live and well-behaved: `fold` (rms +36 %, clips at 1.0000), `crush` (centroid
+653 Hz), `spread` (−15 dB in the sub band), `slice_y` / `slice_rx` / `slice_ry` /
`slice_rz` (all move acRms and/or peak), `connect` (small: acRms 0.348243 →
0.348162), `material`, `wrap`, `level`, `tune`, `fine`.

Near-inert: **`connect`** moves `acRms` by 8.1e-5 across its whole range
(0.348243 → 0.348162) and `peak` by 0.0003 — a 0.002 dB control.

---

## 6. THE FACE, WHEN IT IS UNBLOCKED — a sketch, not a spec

Recorded so the work is not lost, and explicitly **not** authored to the batch's
bar, because §3 can change what half of it means.

- **Rank 1 `morph_fc`, rank 2 `alpha`** *if* §3 resolves in their favour — they
  are the module's identity. If §3 says they are dead, they must **not** appear
  above rank 7, and the face becomes a CUBE face with four extra jacks.
- **Rank 3–6**: `fold`, `slice_y`, `crush`, `spread` — the four measurably
  largest live controls, in that order.
- **A separate `view` band** for the five video-only params (§5), labelled as
  such. This is the clearest banding argument on the module and it survives §3
  either way.
- **`glyph: 'scope'`** — hypercube free-runs, so it would be the *n*-th face
  depending on #1420's pre-frame freeze. ⚠ **AND IT IS THE FIRST ONE WHERE THE
  FREEZE MIGHT NOT BE ENOUGH:** every other free-running face is deterministic
  once frozen; hypercube is not deterministic at all (§1). The freeze stops the
  graph before the frame, so the analyser should read zeros regardless — but that
  must be **derived, not assumed**, the analogVco way (10 separate processes,
  unmasked) before this face enters the VRT roster.
- **A `hypercube-dc` readout** is not possible: DC is a property of the signal,
  not of the params, and `FaceReadoutValue` is params-only. The DC fact belongs
  in the sidebar as `text` until §4 is fixed — at which point it should not need
  saying at all.

---

## 7. ALREADY-WRONG

- **A · BLOCKER: `alpha` and `morph_fc` are indistinguishable from no-ops** in
  every phase-invariant statistic (§2). **Investigation, not a fix** — run the
  direct-processor harness of §3 first.
- **B · a −0.375 DC offset on both audio outputs at every setting** (§4),
  scaling to −0.751 at `level = 2`. Its own DSP PR; check for a downstream
  blocker first.
- **C · the render is not reproducible** (`8.453e-1` between identical runs,
  §1). For an oscillator this is usually a deliberate random start phase and
  therefore fine — **but it means hypercube can never hold a byte-exact ART
  baseline**, and it is why `art/scenarios/hypercube/` must be checked for what
  it actually pins.
- **D · `connect` is worth 0.002 dB** (§5) across its whole range.
- **E · five of twenty params are video-only** (§5) and are not banded as such
  on the card.
- **F · `HypercubeCard.svelte` re-types ZERO literal ranges** in 1044 lines —
  clean, like `warrensspectrum`, and also not in `RANGE_BOUND_CARDS`, so nothing
  keeps it that way.

---

## 8. COST — deferred

No CI arithmetic is offered, because the face's shape is not settled. What **is**
settled: §7-A is a half-day investigation, §7-B is a small DSP PR with an ART
re-pin, and **neither belongs in a face wave** (CLAUDE.md: never fold a DSP
change into a face wave). **Two prerequisite PRs, then re-spec.**
