# FACE SPEC — `cube`, a full visual REBUILD

**Status:** SPEC ONLY — no def edit, no card edit, no implementation. Branch
`docs/face-spec-cube-rebuild`. All measurements taken **2026-08-09** against
`main` @ `2af79daf`, through a verbatim harness over the REAL
`packages/dsp/src/lib/cube-dsp.ts` and the REAL factory tables. Citations are
`file:line`.

> **VERDICT — `PROMOTE — blocked on ONE DSP PR (2 controls emit pure DC at their
> maximum).** cube's control set survives measurement far better than the
> batch-3 audit claimed — MORPH is alive, the paradigm is sound, and 34 of its 36
> controls are honest — but `crush ≥ 0.999` and `space_diffuse = 1.0` both drive
> the oscillator to **acRms exactly 0.000000 with a full-scale DC offset**, and a
> faceplate cannot put a knob on a control whose top end is a DC fault. That is
> one small, well-scoped DSP PR (§8), not the "fix the whole module first"
> verdict batch-3 reached. **Face it immediately after.**

---

## 0 · What this spec is, and what it replaces

The owner asked for three things:

> *"do we have a full spec for a Cube rebuild? … i'd like a visual spec there and
> we need 1:1 parity with all existing faceplate controls but we should not be
> afraid to consider how they all work and decide on the best paradigm."*

So: **a visual spec** (§5), **1:1 control parity** (§3), and **permission to
redesign the paradigm** (§4). This supersedes
`.myrobots/plans/face-specs-batch-3-cube.md`, whose verdict was `SWAP OUT` on the
strength of "7 of 24 knobs do not survive measurement — MORPH is bit-exactly dead
at spawn". **That headline is stale and I re-measured all of it.** §2 says what
held, what did not, and what is new.

### Three numbers in the brief were wrong — correcting them first

| brief said | actual | where |
|---|---|---|
| "**46 params**" | **27 params** | `cube.ts:230-297`. 46 is the *contract-lock row count*: 1 meta + 15 in + 4 out + 27 param = 47 lines, of which 46 are ports+params. `grep -c '^cube ' contract-lock.txt` → **47**. |
| "CubeCard.svelte — 1284 lines" | **1285** | trivial, noted only because the brief said not to trust it. |
| batch-3: "24 knobs" | **24 knobs + 3 toggles + 9 DOM-only = 36 controls** | the 9 wavetable controls (3 selects, 3 preset selects, 3 file loaders, `CubeCard.svelte:1092-1136`) were never counted. |

---

## 1 · The instrument, in one paragraph

cube is **a solid and a cut**. Three e352 wavetables are read as 2-D heightfields
and stacked into a 3-D scalar density field (`cube-dsp.ts:286-313`); a unit
square plane is positioned by `slice_y` and Euler-rotated by `slice_rx/ry/rz`
(`cube-dsp.ts:656-665`); for each of 256 positions along the plane's scan axis a
ray is marched **96 steps along the plane's normal** over a fixed `±√3/2` window
and the accumulated density becomes one sample (`cube-dsp.ts:683-743`). That
256-sample array **is one cycle of the waveform** (`:789`), replayed by a plain
wavetable oscillator at the V/oct frequency, with no band-limiting
(`packages/dsp/src/cube.ts:185-190, 686-695`). Nothing rotates over time — the
angles are static Euler angles evaluated once per slice render.

**Steps 1–5 run on the MAIN thread**, in the factory, not the worklet
(`cube.ts:505-548`); the worklet posts `paramsChanged` and phase-accumulates
through the returned wave (`packages/dsp/src/cube.ts:492-506`).

---

## 2 · MEASUREMENT — what I found, before I designed anything

Harness: a standalone `tsx` script importing the real `cube-dsp.ts` and the two
real factory tables reproduced verbatim from
`wavetable-factory-tables.ts:30-92`. Spawn state =
`floor: basic-shapes, wall: harmonic-sweep, ceiling: harmonic-sweep`
(`cube.ts:109-113`), all params at `defaultValue`.

**Instrument validated first.** Two identical renders → `maxAbsDiff = 0.00e+0`
(deterministic). A 1e-3 nudge on `ry` → `rmsΔ = 3.514e-2` (the metric *moves*). A
pure ×0.5 level change → `rmsΔ = 0.25589` (rmsΔ is **not** level-invariant, so it
cannot hide a gain change the way a correlation would). And where a sweep looked
periodic I **re-sampled at 23 prime-strided offsets** rather than an even 21-grid
— the `slice_y` ripple survived, so it is real structure and not my grid aliasing
against the 96-step ray march.

### 2.1 · The authority league table

Max `rmsΔ` versus the spawn wave, over each control's **full declared travel**:

```
  slice_ry           0.79829  ████████████████████████████████
  crush              0.71639  █████████████████████████████     ← but see 2.2
  slice_rz           0.69973  ████████████████████████████
  space_diffuse      0.57197  ███████████████████████           ← but see 2.2
  wrap (0→1)         0.54037  ██████████████████████
  slice_rx           0.31972  █████████████
  morph_fc           0.14114  ██████
  slice_y            0.13346  █████                             ← but see 2.4
  space_crush        0.07209  ███
  connect            0.06990  ███
  connect_strength   0.04799  ██
  material (0→1)     0.02069  █                                 ← but see 2.7
  spread             0.01922  █
  fold               1.12042  (post-slice; measured separately, peaks at k=0.75)
```

### 2.2 · ⛔ HEADLINE — TWO controls emit PURE DC at their maximum

This is new. Batch-3 called CRUSH "dead over 95 % of travel" and SPACE DIFFUSE
"non-monotonic". Both descriptions are true and both **understate what happens at
the endpoint.** Splitting rms into its DC and AC parts is what exposes it — a
plain rmsΔ reads the collapse as a *large change*, which looks like a strong
control:

```
  k       levels  uniqueVals  acRms(the AUDIO)   DC        verdict
  0.900       27           9          0.354716    -0.3699   audio
  0.950       15           5          0.351914    -0.3934   audio
  0.980        7           2          0.331334    -0.3698   audio
  0.995        3           2          0.490371    -0.5977   audio
  0.999        2           1          0.000000    -1.0000   *** SILENT (pure DC) ***
  1.000        2           1          0.000000    -1.0000   *** SILENT (pure DC) ***

   space_crush=1          acRms=0.333564  DC=-0.3907  uniq=6      (fine — control)
   space_diffuse=1        acRms=0.000000  DC=-0.2125  uniq=1   *** SILENT (pure DC) ***
   space_diffuse=0.95     acRms=0.071570  DC=-0.7907  uniq=230
   wrap ON + crush=1      acRms=1.000000  DC= 0.0000  uniq=2      (a hard square — WRAP rescues it)
```

* **`crush ≥ 0.999` (WRAP off) → the waveform is a constant −1.** `crushLevels(1) = 2`
  (`cube-dsp.ts:350-353`), every depth rounds to level 0, and
  `out[n] = clamp(0·2 − 1) = −1` (`:789`). Output = a full-scale DC step ×
  `level`, into `L` and `R` both.
* **`space_diffuse = 1.0` → the waveform is a constant −0.2125.** `diffusePull`
  at `k=1` is `c + (target − c)·1 = target` (`:501-506`) — every marched sample
  collapses onto the same face coordinate, so all 256 rays read the identical
  column.
* **Both are reachable by knob AND by CV** — `cvScale: {mode:'linear'}` onto a
  `0..1` AudioParam (`cube.ts:203, 205`).
* **The no-dropout guard is structurally blind to both.** `isSilentWave` tests
  `all |v| ≤ 1e-6` (`cube-dsp.ts:81-86`); a constant −1 fails that test, so
  `adoptWave` happily adopts it (`packages/dsp/src/cube.ts:463`). Batch-3's
  finding **C** said the guard is dead code for its documented trigger; the
  measurement above says it is dead code for **the two cases that actually
  occur.**

**Face consequence:** you cannot ship a dial whose last 0.1 % is a DC fault, and
you cannot hide it with a taper — a CV sweep still reaches it. This is the one
blocker, and it is small (§8).

### 2.3 · ⛔ THE PIGEONHOLE — #1314 did not fix the class, it MOVED the collision

Batch-3's headline was "MORPH is bit-exactly dead at spawn", caused by
`ceiling === floor`. #1314 changed the default ceiling to `harmonic-sweep`.
**MORPH is now alive** — a clean linear ladder, `rmsΔ = 0.141` at m=1:

```
   morph=0.00  rmsΔ=0.000000   morph=0.50  rmsΔ=0.070569   morph=1.00  rmsΔ=0.141138
```

But `harmonic-sweep` **is also the WALL**. `occ(z, ceilH, wallH)` with
`ceilH ≡ wallH` hits the degenerate branch
`if (span <= 1e-9) return zz < hi ? 1 : 0` (`cube-dsp.ts:192`) — a hard step, not
a connector. So CONNECT and CONNECT STRENGTH are now **bit-exactly dead on the
ceiling term**:

```
   morph=1 connect=0.5   maxAbsDiff vs connect=0: 0.000e+0
   morph=1 connect=1     maxAbsDiff vs connect=0: 0.000e+0
   morph=1 cnctStr=0.5   maxAbsDiff vs cnctStr=0: 0.000e+0
   morph=1 cnctStr=1     maxAbsDiff vs cnctStr=0: 0.000e+0
```

**There are only TWO factory tables** (`wavetable-factory-tables.ts:96-114`) and
three slots. MORPH needs `floor ≠ ceiling`; the floor connector needs
`floor ≠ wall`; the ceiling connector needs `ceiling ≠ wall`. **By pigeonhole at
least one pair must collide.** Every possible assignment, measured:

```
  floor / wall / ceiling            MORPH 0→1  CONNECT@m=0  CONNECT@m=1  collision
  BASIC / HARM / HARM  ← SHIPPED     0.14114      0.06990      0.00000✗  ceiling == wall
  BASIC / HARM / BASIC ← pre-#1314   0.00000✗     0.06990      0.06990   floor == ceiling
  BASIC / BASIC / HARM               0.14070      0.00000✗     0.06990   floor == wall
  HARM / BASIC / BASIC               0.14070      0.06990      0.00000✗  ceiling == wall
  HARM / BASIC / HARM                0.00000✗     0.06990      0.06990   floor == ceiling
  HARM / HARM / BASIC                0.14114      0.00000✗     0.06990   floor == wall
  BASIC / PWM* / HARM  ← 3 DISTINCT   0.17786      0.13848      0.12141   NONE
```

`* PWM is a hypothetical third table written for this measurement only — it is
not in the repo. That row shows what a third table would BUY, nothing more.`

**The real fix is a THIRD factory table**, and it roughly doubles CONNECT's
authority (0.070 → 0.138) as a bonus. Until then, `DESCRIPTIONS`
(`module-manifest.ts:390`) still tells the user "CEILING must differ from FLOOR
or MORPH … is algebraically inert" — advice that is satisfied by the shipped
defaults and that **breaks a different pair without saying so.**

### 2.4 · 🔑 THE DESIGN FINDING — `slice_y` is dead in exactly ONE state: the SPAWN state

Batch-3 listed `slice_y` as "near-inert, rmsΔ ≤ 0.022 for y ∈ [0, 0.9]". True at
spawn — and **completely wrong as a description of the control.** Y's authority
is a function of the plane's ORIENTATION:

```
  rx      ry      max rmsΔ across y∈[0,1]
   0.000   0.000     0.13346   ← THE SPAWN STATE
   0.400   0.000     0.33299
   0.800   0.000     0.74877
   1.200   0.000     0.76807
   1.571   0.000     0.79371   ← 5.9× the spawn figure; ties slice_ry for #1
   0.000   0.400     0.32630
   0.000   1.571     0.70176
   0.800   0.800     0.63270
```

**Mechanism:** `rayDepth` integrates over a fixed `±√3/2` window *centred on the
ray origin* (`cube-dsp.ts:709-713`). Sliding the plane **along its own normal**
therefore moves the window and its contents together — very nearly a no-op. At
spawn the normal IS the z axis and `slice_y` translates along z, so Y is sliding
along the one direction that does nothing. Tilt the plane and Y stops being a
normal-translation.

**This is the single most important fact about cube's user experience, and no
existing surface says it.** The module's default state hides its own strongest
interaction. §5's readout strip and preset block exist to fix exactly that, at
zero DSP cost.

### 2.5 · `slice_rx` is bit-exactly π-periodic — half its declared travel is a duplicate

```
   a        rmsΔ(a vs a−π)
   0.3      0.000e+0        1.1      0.000e+0        2.5      0.000e+0
   0.7      0.000e+0        1.5      0.000e+0        3.0      0.000e+0
   CONTROL — the same test on ROT Y (must be large, else the test is vacuous):
   0.7      0.24223         1.5      0.53891         2.5      0.83687
```

`f(rx) ≡ f(rx ± π)`, **bit-exactly**, at `depthOffset = 0`. Mechanism: the scan
offset is `rotate(px, 0, 0, rx, ry, rz)` and the X rotation is applied first to a
vector with `y = z = 0`, so **the scan offset never depends on `rx` at all**
(`cube-dsp.ts:620-635, 659`). ROT X's only effect is on the normal — and
`rx + π` negates the normal, while the march window is **symmetric** about the
origin, so it visits the identical sample set in reverse and sums to the same
number. (At `spread > 0` the ±`depthOffset` rides the normal, so `rx + π` swaps L
and R instead of being a true identity.)

The declared range is `±3.1416` = 2π wide. **Exactly half of it is redundant.**
`rx` is NOT even, though — `f(a) ≠ f(−a)` (`rmsΔ` 0.117–0.157), which I
measured rather than assumed after reasoning my way to the wrong answer.

### 2.6 · The output is more DC than signal

```
  spawn:  rms=0.511773  DC=-0.374351  acRms=0.348960  |DC|/acRms=1.073  peak=0.8454
  wrap ON: DC=+0.121  |DC|/acRms=0.215     ry=1.2: |DC|/acRms=2.830
```

`out[n] = depth·2 − 1` with `depth ∈ [0,1]` and a spawn mean depth of ~0.31, so
the wave sits at −0.374 (`cube-dsp.ts:789`). **The L and R ports carry more DC
than audio**, and WRAP is the only control that meaningfully re-centres it. No
control on the current card exposes this; it is a hero-panel readout in §6.

### 2.7 · Where RMS is the wrong instrument: MATERIAL

```
  material HARD   rmsΔ=0.02069  (13th of 13 — looks like the weakest control on the module)
                  turningPoints 26 → 8      uniqueVals 250 → 34
```

MATERIAL barely moves RMS and **halves the waveform's structure**. A face that
ranked by RMS alone would bury it. The turning-point count is the instrument that
sees it, which is why §6 puts it in the hero caption.

### 2.8 · Remaining confirmations and one new asymmetry

| # | finding | measured |
|---|---|---|
| **A** | **SPREAD is documented as ±5 % and is ±18 %.** `CUBE_SPREAD_DEPTH = 0.18` (`cube-dsp.ts:67`); the STRICT_DOCS-gated prose says ±5 % in **five** places (`cube.ts:9, 306, 340, 341, 357`). `DESCRIPTIONS` has it right (`module-manifest.ts:390`) — **the gated doc is the wrong one.** | CONFIRMED |
| **B** | **"±0.18 is clearly audible" (`cube-dsp.ts:65-66`) is false.** | side/mid ladder −234 / −57.0 / −49.9 / −46.9 / **−36.2 dB**; corr(L,R) = 0.999979 at spread 1 |
| **C** | **The no-silence guard never fires; the real behaviour is a full-scale −1 DC step.** | fully-outside slice: `isSilentWave = false`, `all == −1: true`, rms 1.0, DC −1.0 |
| **D** | **`view_rot_z` is a dead control.** A def param (`cube.ts:289`), a card knob (`CubeCard.svelte:1030`), documented as "orbits the 3D view" (`cube.ts:373`) — but `renderGl` reads only `view_zoom / view_rot_x / view_rot_y` (`:577-578`), the eye vector uses only `vrx`/`vry` (`:618-620`), and `sceneSig` omits it (`:586-589`). The sibling implements roll (`video/modules/videocube.ts:1567`). | CONFIRMED 2026-08-09 |
| **E** | `DESCRIPTIONS` still says "v1 is audio-only; a cross-domain viz_out video raster is a planned follow-up" — `video_out` shipped (`cube.ts:227`) and is fully wired (`:612-630`). | CONFIRMED |
| **F** | **"distinct range from crushGridSteps … so the two crushers read differently when stacked" (`cube-dsp.ts:393-396`) is essentially false.** | 193/194, 130/131, 67/69, 29/31, 17/19, 7/9 — within 1–2 cells over the whole range; they diverge only at k=1 (4 vs 6) |
| **G** | **`trigger` declares no `edge:`** while the worklet reads both edges. Already triaged as `edge: 'gate'`, CLEAR, in `.myrobots/2026-08-09-edge-cleanup-table.md:173`. | CONFIRMED — owned by the edge PR, not this one |
| **H** *(new)* | **SYNC is 6.13 dB hotter than the audio, and LEVEL does not touch it.** SYNC is `sin(2π·phase)`, rms 0.7071 (−3.01 dBFS), never multiplied by `level` (`packages/dsp/src/cube.ts:744, 761, 787`); L/R acRms is 0.3490 (−9.14 dBFS). Patching SYNC to a mixer alongside L/R is a +6 dB surprise. | NEW |
| **I** *(new)* | **Only `pitch` is audio-rate.** Every other CV input is summed into an AudioParam that the worklet reads **once per block** via `aval` (`packages/dsp/src/cube.ts:445-449`), quantised to 1/512 of range (`:481`) and smoothed at an 80 Hz corner against the ~375 Hz block rate (`:282-294`). The CV jacks are **control-rate**; an audio-rate LFO into `morph_fc` will alias, not FM. No doc says so. | NEW |
| **J** *(new)* | **L/R are not level-matched at spread.** At spread 1: rmsL −6.04 dB, rmsR −5.85 dB, **ΔL−R = −0.192 dB**; DC_L −0.3562 vs DC_R −0.3717. | NEW |
| **K** *(new)* | **Exact quarter turns collapse the waveform's structure.** `rx=±π/2 → turningPoints 0–1`; `ry=+π/2 → 0`. The collapse is razor-thin (±0.01 rad restores tp to 11–15), so it is a knife-edge, not a dead zone. | NEW |

### 2.9 · Defect vs layout fact — the classification the brief asked for

| # | defect | can a FACE fix it? |
|---|---|---|
| 2.2 crush/diffuse DC fault | **NO — DSP.** `crushLevels`/`diffusePull` endpoints. §8 PR. |
| 2.3 pigeonhole | **NO — DSP/data.** Needs a third factory table. §8 PR. |
| 2.4 Y inert at spawn | **PARTLY — YES, and this is the face's best work.** The degeneracy is real DSP, but "tell the player Y is asleep and give them one click that wakes it" is pure face (§5 readout + preset block). A full fix (march the ray over the cube's actual entry/exit interval instead of a fixed window) is a large DSP change and is **out of scope for both PRs**. |
| 2.5 rx π-redundancy | **NO — def.** Narrowing `slice_rx` to `0..π` is a `ParamDef` range change → contract-lock + attest. §8. |
| 2.6 DC | **NO — DSP.** But the face can *report* it (§6). |
| 2.8 A/B/E/F docs | **YES — pure prose.** `docs`/`DESCRIPTIONS`/comment edits, hash-transparent inside the existing markers (`cube.ts:298, 377`). Fold into the face PR. |
| 2.8 D `view_rot_z` | **card OR def.** Implementing roll is a pure `CubeCard.svelte` change; deleting the param is a def change. §8 offers both. |
| 2.8 H SYNC level | **NO — DSP.** Face reports it in the signal-flow sidebar. |
| 2.8 I control-rate CV | **YES — pure doc + a rear-card `audioRate` declaration** that ticks `pitch` and nothing else. Face PR. |
| 2.8 J 0.192 dB L/R | below any audible threshold — **layout fact, document only.** |
| 2.8 K quarter-turn knife-edge | **layout fact.** Too narrow to design around. |

⚠ **Nothing in §8 is folded into the face wave.** Repo rule; the two PRs are
sequenced in §8.

---

## 3 · THE PARITY LEDGER — all 36 controls

Verdict key, as the brief defines it. `RELOCATE` is measured against the **new
lane budget**: the current card has no tiers, so "tier change" means *the control
is promoted into the 6-cell rack-zoom tile or the hero, i.e. it changes what you
see without opening the dock.*

### 3.1 · The 27 params

| # | param | label | current position | **verdict** | new position | why |
|---|---|---|---|---|---|---|
| 1 | `slice_ry` | Rot Y | knob 13/15 | **RELOCATE** | **hero control** | #1 measured authority, 0.798. The module's identity gesture, currently 13th in a flat bank. |
| 2 | `slice_rz` | Rot Z | knob 14/15 | **RELOCATE** | lane rank 2 · `cut` | #3 authority, 0.700. |
| 3 | `slice_y` | Y | knob 11/15 | **RELOCATE** | lane rank 3 · `cut` | 0.133 at spawn but **0.794 tilted** (§2.4). Ranked on what it does once ranks 1–2 are used, which is the point of ranking it beside them. |
| 4 | `morph_fc` | Morph | knob 3/15 | **RELOCATE** | lane rank 4 · `solid` | 0.141, and the only control that changes *what you are cutting*. Alive since #1314 (§2.3). |
| 5 | `fold` | Fold | knob 9/15 | **RELOCATE** | lane rank 5 · `grain` | Largest single change on the module (1.120) and honest across its whole range. |
| 6 | `wrap` | Wrap | bespoke text button | **REDESIGN** | lane rank 6 · `cut` | Bespoke `<button>WRAP: ON</button>` (`CubeCard.svelte:1142-1148`) → the shell's derived `toggle`. #5 authority (0.540) — a toggle outranking nine knobs — and the only control that re-centres the DC (§2.6). *Also promoted to the lane.* |
| 7 | `material` | Material | bespoke text button | **REDESIGN** | dock · `solid` | Same primitive change. Ranked on turning points (26→8), not RMS (§2.7). |
| 8 | `screen_on` | Screen | bespoke text button | **REDESIGN** | dock · `view` | Same primitive change. |
| 9 | `slice_rx` | Rot X | knob 12/15 | KEEP | dock · `cut` | 0.320. Kept out of the lane because half its travel is a bit-exact duplicate (§2.5) — a lane cell should not be 50 % redundant. |
| 10 | `crush` | Crush | knob 6/15 | KEEP | dock · `grain` | **Ships only after §8 fixes the DC endpoint.** |
| 11 | `space_crush` | Space Crush | knob 7/15 | KEEP | dock · `grain` | 0.072. Weak but honest and monotone-ish; the "distinct range" claim about it is false (2.8 F) and gets a doc fix. |
| 12 | `space_diffuse` | Space Diffuse | knob 8/15 | KEEP | dock · `grain` | **Ships only after §8 fixes the DC endpoint.** |
| 13 | `connect` | Connect | knob 4/15 | KEEP | dock · `solid` | 0.070, and its authority is **attenuated linearly to zero by MORPH** (§2.3, §3.3). |
| 14 | `connect_strength` | Cnct Str | knob 5/15 | KEEP | dock · `solid` | 0.048, same attenuation. |
| 15 | `tune` | Tune | knob 1/15 | KEEP | dock · `pitch` | Honest. |
| 16 | `fine` | Fine | knob 2/15 | KEEP | dock · `pitch` | Honest. |
| 17 | `spread` | Spread | knob 10/15 | KEEP | dock · `pitch` | −36.2 dB at max is weak, **not dead** — it does not meet the CUT bar. Kept, with the honest depth printed beside it (§6). |
| 18 | `level` | Level | knob 15/15 | KEEP | dock · `pitch` | Honest. |
| 19 | `attack` | A | ADSR bank | KEEP | dock · `env` | Alive since #1360 (`base_vol` default 1 → 0, `packages/dsp/src/cube.ts:406-424`). |
| 20 | `decay` | D | ADSR bank | KEEP | dock · `env` | ″ |
| 21 | `sustain` | S | ADSR bank | KEEP | dock · `env` | ″ |
| 22 | `release` | R | ADSR bank | KEEP | dock · `env` | ″ |
| 23 | `base_vol` | Base | ADSR bank | KEEP | dock · `env` | ″ |
| 24 | `view_zoom` | Zoom | view bank | KEEP | dock · `view` | Live (`CubeCard.svelte:577`). |
| 25 | `view_rot_x` | View X | view bank | KEEP | dock · `view` | Live (`:578`). |
| 26 | `view_rot_y` | View Y | view bank | KEEP | dock · `view` | Live (`:578`). |
| 27 | `view_rot_z` | View Z | view bank | **CUT** | — | **Measurably dead** (§2.8 D): declared, knobbed, documented, and never read by any renderer. Meets the CUT bar. ⚠ **Cannot be cut in the face PR** — see §3.4. |

### 3.2 · The 9 DOM-only controls → ONE panel

`CubeCard.svelte:1092-1136` builds, per slot, **three** controls for **one**
decision:

| # | control | testid | **verdict** | folded into |
|---|---|---|---|---|
| 28 | FLOOR factory select | `cube-floor-select` | **MERGE** | `cube-table-stack` |
| 29 | FLOOR preset select | `cube-floor-preset-select` | **MERGE** | ″ |
| 30 | FLOOR .wav load | `cube-floor-load` | **MERGE** | ″ |
| 31–33 | WALL ×3 | `cube-wall-*` | **MERGE** | ″ |
| 34–36 | CEILING ×3 | `cube-ceiling-*` | **MERGE** | ″ |

**Why this is not a loss.** The preset dropdown exists *only* because a
controlled Svelte `<select>` whose bound value never changes will not re-fire
`change` (the "RELOAD FIX, item #1" comment at `CubeCard.svelte:163-170`). That
is a binding bug worked around by adding a second control, not a second decision
— and the workaround leaks into the UI as a permanently blank `— preset —` box
per slot. One roster per slot (factory tables + presets + the synthetic `USER`
entry) plus one LOAD affordance is the same reach in a third of the widgets, and
the panel that hosts them can **draw the three heightfields**, which is the only
way a player will ever see the §2.3 collision.

### 3.3 · The ledger totals

| verdict | count | |
|---|---|---|
| **KEEP** | 18 | same primitive, new position inside the dock |
| **RELOCATE** | 5 | promoted into the 6-cell lane tile |
| **REDESIGN** | 3 | bespoke text `<button>` → the shell's derived `toggle` (`wrap` also promoted) |
| **MERGE** | 9 | the wavetable rows → one `cube-table-stack` panel |
| **CUT** | 1 | `view_rot_z` — dead, evidence §2.8 D |
| | **36** | **every control accounted for** |
| *added* | +2 | `cube-view` (hero panel), `cube-table-stack` (solid panel) — not parity rows |

### 3.4 · ⚠ The parity gate FORBIDS dropping a param's cell — a sequencing constraint

`faces-parity` asserts **exact multiset equality** between the dock's
`control-<paramId>` testids and the def's param ids (`shell-cells.ts:198-203`).
So:

* **No param can be absorbed into a panel.** MERGE is available only for
  DOM-only controls. A camera knob "replaced by drag-to-orbit" still needs its
  cell; the panel gesture and the knob write the same param.
* **`view_rot_z` must SHIP in the face**, in the `view` band, and be removed by
  the §8 PR together with its `face.order` key **in one commit**. Removing the
  param without the key (or vice versa) is a red gate either way.

---

## 4 · THE PARADIGM — argued, with what I rejected

> **cube has exactly two nouns: the SOLID you build, and the CUT you read it
> with. The faceplate is those two objects in that order — and the measurement
> says the CUT owns the timbre by 5.7× (`slice_ry` 0.798 vs `morph_fc` 0.141),
> so the CUT comes first.** Everything after them is post-processing (grain),
> playback (pitch, envelope) and the camera.

That ordering is the **exact inverse** of the def's param order and of the
current card, both of which lead with TUNE / FINE / MORPH / CONNECT and put the
three rotations 12th–14th of 15.

**What I rejected, and why:**

* **By signal stage** (field → slice → readout → shaping → out) — the batch-3
  proposal, and what the current card already is. It ranks the field first
  *because the field is computed first*. That is an implementation order, and it
  puts the module's two weakest continuous controls (`connect` 0.070,
  `connect_strength` 0.048) above its strongest (`slice_ry` 0.798). It is also
  the direct cause of the module reading as "a wall of 24 knobs".
* **By spatial axis** (X / Y / Z) — a false grouping. `slice_rx` (a cut angle),
  `view_rot_x` (a camera angle) and the field's x axis (wavetable sample phase)
  share a letter and nothing else. Grouping by letter would seat a **dead camera
  knob** (§2.8 D) next to the module's #6 control.
* **By mode** — cube has no modes. Its nearest thing to one is the plane's
  orientation, which is continuous.
* **By CV-able vs not** — a routing fact. It belongs on the rear card, where it
  already lives by derivation (§5.4).
* **By raw measured authority alone** — tempting after §2.1, and wrong. It would
  seat `crush` at rank 2 (a control that is flat for 90 % of its travel and then
  faults), bury `material` at rank 13 (RMS is the wrong instrument for it, §2.7),
  and produce an order no player could form a mental model of. **Authority
  informs the ranking; the two nouns give it a shape.**

---

## 5 · THE VISUAL SPEC

### 5.0 · Geometry facts this layout is built on

| fact | value | source |
|---|---|---|
| lane tile | fixed 192 × 180 px | `curated-face.ts:52-56` |
| `faceTierCap('compact')` | 2 with a glyph, 3 without | `curated-face.ts:76-79` |
| `faceTierCap('full')` | **6** (`PLATE_COLS × PLATE_MAX_ROWS`) | `curated-face.ts:46` |
| tab rail engages at | **7 bands** — this face has **6**, deliberately | `dock-tabs-model.ts:53` |
| row packing ceiling | **10 cells** per row; a band with a WIDE cell is SOLO | `dock-row-plan.ts:76, 120-131` |
| a param `toggle` is | a **narrow** column (packs) | `dock-row-plan.ts:118-122` |
| rack size | `cube: { size: '3u', hp: 4 }` — 540 × 720 px | `rack-sizes.ts:43` |

### 5.1 · MINI (1 cell + glyph)

```
┌──────────────────┐
│ CUBE             │
│  ╭────╮   ╱╲╱╲   │   the ONE control: slice_ry (hero control, rank 1)
│  │ ROT│  ╱    ╲  │   glyph: 'scope' — the live output trace
│  │  Y │ ╱      ╲ │
│  ╰────╯          │
└──────────────────┘
```

### 5.2 · COMPACT (glyph + 2) and FULL-IN-LANE (3 × 2 = 6)

```
   COMPACT  (192×180, 2 cells + glyph)      FULL-IN-LANE  (192×180, 3×2 plate, glyph drops)
  ┌──────────────────────────────┐        ┌──────────────────────────────┐
  │ CUBE                         │        │ CUBE                         │
  │  ╭────╮ ╭────╮   ╱╲╱╲╱╲      │        │  ╭───╮  ╭───╮  ╭───╮         │
  │  │ROT │ │ROT │  ╱      ╲     │        │  │ROT│  │ROT│  │ Y │         │
  │  │ Y  │ │ Z  │ ╱        ╲    │        │  │ Y │  │ Z │  │   │         │
  │  ╰────╯ ╰────╯                │       │  ╰───╯  ╰───╯  ╰───╯         │
  │   0.00   0.00                │        │  ╭───╮  ╭───╮  ┌─────┐       │
  │                              │        │  │MRP│  │FLD│  │WRAP │       │
  │                              │        │  │ H │  │   │  │ off │       │
  │                              │        │  ╰───╯  ╰───╯  └─────┘       │
  └──────────────────────────────┘        └──────────────────────────────┘
     ranks 1-2 + 'scope' glyph               ranks 1-6, the whole lane budget
```

**Rank 1–6 = `slice_ry · slice_rz · slice_y · morph_fc · fold · wrap`.** Every
one of those is in the top 6 measured *or* (in `slice_y`'s case) top 2 once ranks
1–2 are used. `crush` and `space_diffuse` are deliberately **not** in the lane
until §8 lands.

### 5.3 · DOCK FULL VIEW — the faceplate

Six bands, one hero, a three-block sidebar. Packs to **four rows** below the
hero. Drawn at the ~1220 px pane the VRT dock scene captures.

```
╔═══════════════════════════════════════════════════════════════════════╤═══════════════════════╗
║  CUBE                                                          [flip] │                       ║
╟───────────────────────────────────────────────────────────────────────┤   ┌───────────────┐   ║
║  ┌──────────────────────────────────┐  ╭─────────╮                    │   │ SIGNAL FLOW   │   ║
║  │ ░░░▒▒▓▓ HERO — `cube-view` ▓▓▒▒░░│  │         │   cut    38°·tilted │   │               │   ║
║  │                                  │  │  ROT Y  │   Y       LIVE     │   │  [3 TABLES]   │   ║
║  │      ╭──────────────╮            │  │         │   levels  256      │   │       ↓  gen  │   ║
║  │     ╱│░░░░░▒▒▒▒▓▓▓▓░│╲           │  ╰─────────╯   width   ±18 %    │   │  [FIELD]      │   ║
║  │    ╱ │░░▒▒▓▓███▓▓▒▒░│ ╲          │      1.05                       │   │       ↓       ║   ║
║  │   ╱  │▒▓█ ╱▔▔▔▔╲ █▓▒│  ╲         │                                 │   │  [CUT PLANE]  │   ║
║  │  │   │▓█ ╱ CUT  ╲ █▓ │   │       │   ┌───────────┐ ┌───────────┐   │   │       ↓       │   ║
║  │  │   │▓█╱  PLANE ╲█▓ │   │       │   │ SLICE     │ │ OUTPUT    │   │   │  [SCAN 256]   │   ║
║  │  │   │▒▓╲________╱▓▒ │   │       │   │  ▒▓██▓▒   │ │ ╱╲  ╱╲    │   │   │       ↓  bus  │   ║
║  │   ╲  │░▒▓▓████▓▓▒░  │  ╱        │   │  ▓███▓▒░  │ │╱  ╲╱  ╲   │   │   │  [GRAIN]      │   ║
║  │    ╲ │░░▒▒▓▓▓▓▒▒░░ │ ╱          │   └───────────┘ └───────────┘   │   │       ↓       │   ║
║  │     ╲│░░░░▒▒▒▒░░░░│╱            │                                 │   │  [FOLD]       │   ║
║  │      ╰──────────────╯            │                                 │   │       ↓       │   ║
║  │  solid 31.3 %   DC −0.374 (1.07× │                                 │   │  [VCA adsr]   │   ║
║  │  the audio)   turning points 26  │                                 │   │       ↓       │   ║
║  └──────────────────────────────────┘                                 │   │  [LEVEL] →L/R │   ║
║       ↑ hero.cell (PANEL, 560 px)        ↑ hero.control  ↑ hero.readouts│  │    ╎  ╎       │   ║
╟───────────────────────────────────────────────────────────────────────┤   │    ╎  └╌╌►VIDEO│  ║
║  1 · THE CUT                                                          │   │    └╌╌╌╌►SYNC  │   ║
║  where the plane sits, and what happens where it leaves the solid     │   │   (SYNC is +6 dB│  ║
║   ╭────╮  ╭────╮  ╭────╮  ┌────────┐                                  │   │    and ignores │   ║
║   │ROT │  │ROT │  │ Y  │  │  WRAP  │                                  │   │    LEVEL)      │   ║
║   │ Z  │  │ X  │  │    │  │  off   │                                  │   └───────────────┘   ║
║   ╰────╯  ╰────╯  ╰────╯  └────────┘                        ROW 1 (4) │                       ║
╟───────────────────────────────────────────────────────────────────────┤   ┌───────────────┐   ║
║  2 · THE SOLID                                                        │   │ SET THE PLANE │   ║
║  three heightfields stacked; MORPH crossfades floor↔ceiling           │   │               │   ║
║  ┌───────────────────────────────┐ ╭────╮ ╭────╮ ╭────╮ ┌────────┐    │   │ flat scan  ▸  │   ║
║  │ `cube-table-stack`  (PANEL)   │ │MRPH│ │CNCT│ │CNCT│ │  MAT   │    │   │  spawn — Y off│   ║
║  │ CEILING ▁▂▃▅▇▅▃▂▁  HARM  [⇪] │ │    │ │    │ │STR │ │ smooth │    │   │               │   ║
║  │ WALL    ▁▂▃▅▇▅▃▂▁  HARM  [⇪] │ ╰────╯ ╰────╯ ╰────╯ └────────┘    │   │ tilted     ▸  │   ║
║  │  ⚠ CEILING = WALL — CONNECT   │                                    │   │  rx 1.2 — Y   │   ║
║  │    is inert while MORPH = 1   │                                    │   │  becomes 5.8× │   ║
║  │ FLOOR   ▁▃▆█▆▃▁▃▆  BASIC [⇪] │                          SOLO ROW  │   │               │   ║
║  └───────────────────────────────┘                          ROW 2 (5) │   │ quarter turn▸ │   ║
╟───────────────────────────────────────────────────────────────────────┤   │  ry π/2 — flat│   ║
║  3 · GRAIN                        │  4 · PITCH · OUT                  │   │               │   ║
║  quantise the value, then the     │  a plain wavetable oscillator —   │   │ mirror     ▸  │   ║
║  lookup coordinates               │  no band-limiting                 │   │  wrap on — DC │   ║
║   ╭────╮ ╭────╮ ╭────╮ ╭────╮     │  ╭────╮ ╭────╮ ╭────╮ ╭────╮      │   │  −0.37 → +0.12│   ║
║   │CRSH│ │SPC │ │SPC │ │FOLD│     │  │TUNE│ │FINE│ │SPRD│ │LVL │      │   └───────────────┘   ║
║   ╰────╯ ╰────╯ ╰────╯ ╰────╯     │  ╰────╯ ╰────╯ ╰────╯ ╰────╯      │                       ║
║                        ROW 3 — bands 3+4 packed = 8 cells ≤ 10        │   ┌───────────────┐   ║
╟───────────────────────────────────────────────────────────────────────┤   │ READOUTS      │   ║
║  5 · VOICE ENVELOPE               │  VIEW                             │   │ f0     261.6Hz│   ║
║  shapes a note only when POLY or  │  camera only — none of these      │   │ harmonics  91 │   ║
║  TRIG is patched                  │  touch a sample                   │   │ CV rate  375Hz│   ║
║   ╭──╮╭──╮╭──╮╭──╮╭────╮          │  ╭────╮╭────╮╭────╮╭────╮┌──────┐ │   │ fold drive 1.0│   ║
║   │A ││D ││S ││R ││BASE│          │  │ZOOM││V X ││V Y ││V Z*││SCREEN│ │   │ spread ±0.0 % │   ║
║   ╰──╯╰──╯╰──╯╰──╯╰────╯          │  ╰────╯╰────╯╰────╯╰────╯└──────┘ │   └───────────────┘   ║
║                        ROW 4 — bands 5+6 packed = 10 cells = ceiling  │                       ║
╚═══════════════════════════════════════════════════════════════════════╧═══════════════════════╝
                                          * V Z is DEAD (§2.8 D) — it ships
                                            in the face and is removed by §8
```

**Band-by-band rationale.**

| band | why it exists | cells |
|---|---|---|
| `cut` | the CUT is noun #1 and owns the timbre (§4). WRAP lives here, not in `grain`, because it is a rule about **where the plane leaves the solid** — and it is the 5th strongest control on the module. | 4 (after `slice_ry` is promoted to the hero) |
| `solid` | noun #2. Leads with the panel because **the collision (§2.3) is only visible as a picture.** Carries a WIDE cell → SOLO row by `dock-row-plan.ts` rule 2, which it earns. | 5 |
| `grain` | the two quantisers plus the folder — everything that damages the wave after it is read. CRUSH and SPACE CRUSH sit adjacent so the false "distinct range" claim (2.8 F) is at least visibly a claim about neighbours. | 4 |
| `pitch` | playback. It is a *separate idea* from the timbre — the table is always 256 samples, so pitch only decides how fast the cycle repeats. | 4 |
| `env` | the ADSR is inert unless POLY or TRIG is patched; a band with that sentence as its hint is the cheapest way to stop the "the envelope does nothing" report. | 5 |
| `view` | camera only. Last, small, and honest about touching no samples. | 5 |

**Six bands is deliberate.** `DOCK_TAB_MIN_BANDS = 7`
(`dock-tabs-model.ts:53`). ⚠ **A seventh band flips the whole face to a tab
rail**, which kills row packing (`dock-row-plan.ts` rule 1) *and* suppresses every
band hint (`dock-faceplate-model.ts:126-133`) — i.e. it silently deletes the
prose this layout leans on. Say so in the `face` comment.

**Clusters, not pages, for the sub-groups.** A page costs a ~81 px band; a
cluster costs ~14 px (`graph/types.ts:499-505`). `env` uses one cluster
(`A · D · S · R` | `BASE`) so the VCA floor reads as a different idea without
buying a seventh band.

### 5.4 · REAR CARD — derivation covers it, with ONE override

15 inputs, 4 outputs. The default derivation (voice/signal band + one band per
page carrying that page's CV holes + the OUTPUTS rail,
`$lib/ui/workflow/rear-card-model`) lands **exactly**:

```
┌───────────────────────────────────────────────────────────────────────┐
│  CUBE — rear                                                   [flip] │
├───────────────────────────────────────────────────────────────────────┤
│  VOICE            ( ~ ) PITCH      ( ) POLY       ( ) TRIG            │
│                     ↑ the ONLY audio-rate input (§2.8 I)              │
├───────────────────────────────────────────────────────────────────────┤
│  1 · THE CUT      ( ) ROT Y   ( ) ROT Z   ( ) ROT X   ( ) Y           │
├───────────────────────────────────────────────────────────────────────┤
│  2 · THE SOLID    ( ) MORPH   ( ) CONNECT ( ) CNCT STR                │
├───────────────────────────────────────────────────────────────────────┤
│  3 · GRAIN        ( ) CRUSH   ( ) SPC CRUSH ( ) SPC DIFF  ( ) FOLD    │
├───────────────────────────────────────────────────────────────────────┤
│  4 · PITCH · OUT  ( ) TUNE                                            │
├───────────────────────────────────────────────────────────────────────┤
│  OUT              (•) L    (•) R    (•) SYNC +6 dB   (▣) VIDEO        │
└───────────────────────────────────────────────────────────────────────┘
   3 voice + 4 + 3 + 4 + 1 = 15 inputs ✓      4 outputs ✓
```

The one override: **`rear: { audioRate: ['pitch'] }`**. That tick is the only
place the player can learn §2.8 I — every other CV jack is read once per block
(~375 Hz), quantised to 1/512, and 80 Hz-smoothed, so it is a control-rate input
wearing an audio-rate cable.

### 5.5 · The `face` block, as it would be authored

⚠ **Wrap the WHOLE block in `// docs-hash-ignore:start … :end`** — `cube.ts` is
in `AUDIO_WEBGL_MODULE_DEFS` (`scripts/webgl-attest-lib.ts:66-70`) and the def
already uses the markers for `docs` at `cube.ts:298, 377`.

```ts
face: {
  // ⚠ SIX BANDS IS LOAD-BEARING. A seventh trips DOCK_TAB_MIN_BANDS (7) and the
  // whole faceplate becomes a tab rail: row packing stops and EVERY page hint
  // below stops painting. Add a cluster, not a page.
  title: 'Solid & cut',                     // ⚠ annotation-only, see §7
  hint:  'A static 3-D density field, read by one movable plane. The 256 ' +
         'samples that plane reads ARE the waveform — so the rotation knobs ' +
         'are the timbre controls and the pitch knobs only decide how fast ' +
         'that cycle repeats.',             // ⚠ annotation-only, see §7
  glyph: 'scope',
  order: [
    // ranks 1-6 = the LANE budget (faceTierCap('full') === 6)
    'slice_ry', 'slice_rz', 'slice_y', 'morph_fc', 'fold', 'wrap',
    // 7+ = dock only
    'slice_rx', 'material', 'crush', 'space_crush', 'space_diffuse',
    'connect', 'connect_strength',
    'tune', 'fine', 'spread', 'level',
    'attack', 'decay', 'sustain', 'release', 'base_vol',
    'view_zoom', 'view_rot_x', 'view_rot_y', 'view_rot_z', 'screen_on',
    // the two PANELS, ranked LAST so neither ever lands inside the 6-cell lane
    // plate (a 300-560px panel in a 192px tile). The dock promotes cube-view
    // into the hero regardless of its rank.
    'cube-table-stack', 'cube-view',
  ],
  hero: {
    cell: 'cube-view',            // must resolve to a PANEL — module-face-lint.test.ts:987-1006
    control: 'slice_ry',
    // no `action`: cube has no audition seam (§7). Inventing one needs a DSP
    // read key, and ShellActionCell.probe is REQUIRED — a dead audition would
    // fail faces-parity, correctly.
    readouts: [
      { label: 'cut',    valueId: 'cube-cut-tilt' },
      { label: 'Y',      valueId: 'cube-y-live' },
      { label: 'levels', valueId: 'cube-crush-levels' },
      { label: 'width',  valueId: 'cube-spread-depth' },
    ],
  },
  pages: [
    { id: 'cut',   label: '1 · the cut',
      hint: 'where the plane sits, and what happens where it leaves the solid',
      controls: ['slice_ry', 'slice_rz', 'slice_rx', 'slice_y', 'wrap'] },
    { id: 'solid', label: '2 · the solid',
      hint: 'three heightfields stacked; MORPH crossfades floor↔ceiling',
      controls: ['cube-table-stack', 'morph_fc', 'connect', 'connect_strength', 'material'] },
    { id: 'grain', label: '3 · grain',
      hint: 'quantise the value, then the lookup coordinates',
      controls: ['crush', 'space_crush', 'space_diffuse', 'fold'] },
    { id: 'pitch', label: '4 · pitch · out',
      hint: 'the table is always 256 samples, so this is a plain wavetable oscillator with no band-limiting',
      controls: ['tune', 'fine', 'spread', 'level'] },
    { id: 'env',   label: '5 · voice envelope',
      hint: 'shapes a note only when POLY or TRIG is patched — unpatched, cube free-runs at full level',
      controls: ['attack', 'decay', 'sustain', 'release', 'base_vol'],
      clusters: [{ label: 'VCA floor', controls: ['base_vol'] }] },
    { id: 'view',  label: 'view',
      hint: 'camera only — none of these touch a sample',
      controls: ['view_zoom', 'view_rot_x', 'view_rot_y', 'view_rot_z', 'screen_on'] },
  ],
  rear: { audioRate: ['pitch'] },
  sidebar: [
    { kind: 'signal-flow', label: 'Signal flow', stages: [
      { label: '3 tables',  role: 'generator', note: 'floor · wall · ceiling' },
      { label: 'field',     role: 'generator', note: 'morph · connect' },
      { label: 'cut plane', role: 'generator', note: 'Y · rot X/Y/Z' },
      { label: 'scan',      role: 'generator', note: '256 rays × 96 steps' },
      { label: 'grain',     role: 'bus',       note: 'crush · space' },
      { label: 'fold',      role: 'bus' },
      { label: 'VCA',       role: 'bus',       note: 'adsr · base' },
      { label: 'level',     role: 'bus' },
      { label: 'sync',      role: 'bus', parallel: true, note: 'sine off the phase — ignores LEVEL' },
      { label: 'video',     role: 'bus', parallel: true, note: 'the card\'s own GL render' },
    ] },
    { kind: 'presets', label: 'Set the plane', entries: [
      { id: 'flat',    label: 'flat scan',    note: 'Y off',   values: { slice_rx: 0, slice_ry: 0, slice_rz: 0, slice_y: 0.5, wrap: 0 } },
      { id: 'tilted',  label: 'tilted',       note: 'Y × 5.8', values: { slice_rx: 1.2, slice_ry: 0, slice_rz: 0, slice_y: 0.5 } },
      { id: 'quarter', label: 'quarter turn', note: 'flat',    values: { slice_rx: 0, slice_ry: 1.5708, slice_rz: 0 } },
      { id: 'mirror',  label: 'mirror',       note: 'DC ≈ 0',  values: { wrap: 1 } },
    ] },
    { kind: 'readouts', label: 'Readouts', entries: [
      { label: 'f0',        valueId: 'cube-f0-knobs' },
      { label: 'harmonics', valueId: 'cube-harmonics' },
      { label: 'CV rate',   text: '≈375 Hz · 1/512 steps' },
      { label: 'fold drive', valueId: 'cube-fold-drive' },
      { label: 'spread',    valueId: 'cube-spread-depth' },
    ] },
  ],
}
```

---

## 6 · READOUTS — every derivation, and where each one is ALLOWED to live

⚠ **The platform constraint that decides this section.**
`FaceReadoutValue = (read: (paramId: string) => number | undefined) => string`
(`face-readout-values.ts:123`). A `valueId` readout is a **pure function of live
PARAMS**. It cannot read `node.data` (which wavetable is loaded) and it cannot
read the engine snapshot (the rendered wave).

**Batch-3 proposed nine derived readouts and six of them are unbuildable as
written** — `cube-solid-pct`, `cube-dc`, `cube-turning-points`,
`cube-width-db`, `cube-folds` and `cube-voices` all need the wave or the live
gates. That is not a small correction: it is the difference between a spec that
can be built and one that discovers this at implementation time.

**The split.** Param-derived numbers go in the `readouts` slots. Wave-derived
numbers go in the **hero panel's own caption**, because a `ShellPanelCell`
component receives the nodeId and can call `useEngine()` itself — exactly as
`CubeCard.svelte:920-931` already does to read `'snapshot'`.

### 6.1 · `valueId` readouts (param-only) — buildable today

| id | derivation | prints | negative control (permanent, in the unit lane) |
|---|---|---|---|
| `cube-cut-tilt` | angle of the rotated normal off +z: `n = rotate(0,0,1, rx,ry,rz)`, `acos(n_z)` in degrees; `'flat · z'` when < 0.5° | `38° · tilted` | perturb `ry` with `rx` frozen → must move; at spawn must read exactly `flat · z` |
| `cube-y-live` | `LIVE` iff `cube-cut-tilt > 0.5°`, else `inert — plane is flat` | `inert` | **the §2.4 readout.** Must read `inert` at spawn and `LIVE` after the `tilted` preset. A knob readback of `slice_y` is blind to this by construction — it prints `0.50` in both states. |
| `cube-crush-levels` | `crushLevels(crush)` (`cube-dsp.ts:350-353`); `2 — DC, no audio` at the top | `256` | must print `2 — DC, no audio` at `crush = 1`; must move at `crush = 0.5` (→ `129`) |
| `cube-spread-depth` | `±(CUBE_SPREAD_DEPTH · spread · 100)` % — **imports `CUBE_SPREAD_DEPTH`, never re-types 0.18** | `±0.0 %` | must print `±18.0 %` at `spread = 1` — which is the number five doc strings get wrong (§2.8 A) |
| `cube-f0-knobs` | `261.626 · 2^(tune/12 + fine/1200)`, clamped `[1, 24000]` | `261.6 Hz` | **must be labelled "knobs only".** It is structurally blind to the V/oct input, which is not a param. Printing it unqualified is the kick-drum-TAIL trap in miniature. |
| `cube-harmonics` | `floor(24000 / f0)` from the same figure | `91` | must fall to `10` at `tune 36 / fine 100`; must print `1 — clamped` where `f0` hits Nyquist |
| `cube-fold-drive` | `1 + fold · FOLD_MAX_DRIVE` (`cube-dsp.ts:535`) | `1.0×` | `5.0×` at `fold = 1` |

### 6.2 · Hero-panel caption (wave-derived; the panel reads the engine)

| number | derivation | at spawn | why it is worth painting |
|---|---|---|---|
| `solid %` | `(mean(wave) + 1) / 2` — the mean over 256 rays of `(1/96)·Σ field` | `31.3 %` | WRAP off→on moves it `31.3 % → 56.1 %`; `crush=1` collapses it to `0.0 %`. No knob shows either. |
| `DC` | `mean(wave)`, printed with `|DC| / acRms` | `−0.374 (1.07× the audio)` | §2.6 — the ports carry more DC than signal, and **nothing else on the module can tell you.** |
| `turning points` | sign changes of the first difference of the posted centre wave | `26` | **the instrument RMS is blind to.** MATERIAL SMOOTH→HARD is `rmsΔ 0.021` (last place) but `26 → 8` turning points. `ry=1.2` → `74`. |

The panel's parity probe is a `text` probe on a **different** element inside it —
the precedent is `macrooscillator`'s `macro-hero-caption`
(`shell-cells.ts:492-505`), and `shell-cells.test.ts` fails a probe whose driven
`testid` equals its observed one.

### 6.3 · ⛔ DO NOT BUILD

* **"beat frequency between two rotation planes."** `rx/ry/rz` are static Euler
  angles evaluated once per slice render (`cube-dsp.ts:656-665`). There is no
  angular velocity and no time term. Any beating belongs to two external LFOs,
  not to cube. Named because it is the obvious readout for a module called
  "cube" and it would be an invention.
* **A stereo-width readout in dB.** It needs both rendered channels, so it is not
  a `valueId`; and putting `−36.2 dB` on the faceplate reports a DSP weakness as
  if it were a setting. `cube-spread-depth` states the **depth offset**, which is
  what the knob actually commands.

---

## 7 · PLATFORM TRUTHS THIS SPEC OBEYS

| truth | consequence here |
|---|---|
| ⚠ **`face.hint` DOES NOT PAINT.** `facePageHeader(def, annotations=false)` returns `null` before reading anything (`dock-faceplate-model.ts:86-90`); `face.title` is annotation-only by owner directive (`:68-81`). | **No load-bearing fact is parked in `title`/`hint`.** Everything the player must know is in a readout, a band hint (also annotation-gated — `bandHeaderPlan`, `:126-133`), a preset label, or the hero caption. The §2.4 finding lands in `cube-y-live`, which paints unconditionally. |
| **The dock VRT scene is NOT capped at ~425 px** — fixed 2026-08-08 in #1413 (`FOLD_VIEWPORT` 1280×1400, `unfoldDockPane()`). | The four-row layout is fully capturable; no scene splitting needed. |
| **PF-21 row packing:** consecutive packable bands share a row (≤10 cells); a band with a WIDE cell is SOLO; a tabbed face never packs. | Planned to exactly 4 rows: `cut`(4) / `solid`(SOLO, 5) / `grain`+`pitch`(8) / `env`+`view`(10 = the ceiling). §5.3. |
| **`faceTierCap('full')` is 6** — a `hero.cell` ranked early lands inside the cap. | Both panels are ranked **last** (28th, 29th). The hero promotion is rank-independent (`module-face-lint.test.ts:951-1008` checks only that the key is ranked and resolves to a panel). |
| **A card must never re-type a range the def declares.** | cube's card is the repo's **good** example — `min={minFor(k.pid)} max={maxFor(k.pid)}` all resolve from `cubeDef.params` (`CubeCard.svelte:65-68, 1170-1172`). ⚠ But **curves ARE re-typed in three places** (`:1175` `curve="linear"`, `:1196` `curve={k.curve}`, `:1217` the view ternary). All three agree today. The rebuild imports them or drops them — and `cube-spread-depth` must import `CUBE_SPREAD_DEPTH`, never re-type `0.18`. |
| **An action cell requires `ShellActionCell.probe`** (`shell-cells.ts:142-168`). | **cube declares no hero `action`.** There is no audition seam — no `manualTrigger` read key on the handle (`cube.ts:638-650` exposes only `snapshot`/`live`/`tableLabels`/`frames`). Adding one is a DSP seam and is listed in §8 as optional. A `toBeEnabled()`-passing dead button is exactly the class the probe requirement exists to catch. |
| ⚠ **Label clipping is invisible to `faces-parity`** (`toHaveText` reads `textContent`). | **Two labels in this layout are at risk and here are their budgets.** `connect_strength` ships as `'Cnct Str'` (8 chars) and `space_diffuse` as `'Space Diffuse'` (13). A knob column measures **40–68.8 px** (`dock-row-plan.ts:82`); at the shell's 9–10 px mono caption that is **~7–8 characters**. `'Space Diffuse'` and `'Space Crush'` **will** clip, silently. **The face must not rename them** (a `ParamDef.label` change is a contract-lock diff) — so the layout budget is: any cell in a packed row gets **≤ 8 characters**, and the two that exceed it are called out here so a reviewer looks at the render instead of trusting the green gate. Screenshot the row and read it. |
| ⚠ **`cube` is in `AUDIO_WEBGL_MODULE_DEFS`** (`scripts/webgl-attest-lib.ts:66-70`). | The `face` block goes inside `docs-hash-ignore` markers → zero attest churn. |
| ⚠ **AND SO IS THE CARD — and so would a new WebGL panel be.** `resolveWebglBasis()` auto-adds **any `.svelte` under `lib/ui/modules` whose source creates a WebGL context** (`:236-242`). | **This is the single biggest cost decision in the rebuild** and it is not in the brief. A `CubeViewPanel.svelte` that calls `getContext('webgl2')` **enrols itself in the WebGL attest basis**, changing the basis SET and forcing a trusted-machine GPU re-attest. `docs-hash-ignore` does **nothing** here — it strips doc regions, not files. **Two routes, priced in §9.** |
| **The parity gate forbids dropping a param's cell** (`shell-cells.ts:198-203`). | §3.4 — `view_rot_z` ships in the face and leaves with §8, in one commit. |

---

## 8 · THE COMPANION DSP PR — scoped, named, and NOT folded into the face wave

> `fix(cube): the two controls whose maximum is a DC fault, and the third factory
> table the field has always needed`

Repo rule: never fold a DSP change into a face wave. This PR lands **first**; the
face PR lands after it is green.

| # | change | evidence | size |
|---|---|---|---|
| **1** | **`crushLevels` floor of 2 → 3** (or clamp the knob's effective top so at least three levels survive). At 2 levels every depth rounds to 0 and the wave is a constant −1. | §2.2 — `acRms 0.000000`, `DC −1.0000` at `k ≥ 0.999` | one constant + a unit test |
| **2** | **`diffusePull` ease `kk²` → `kk²·(1−ε)`**, so `k=1` cannot collapse every sample onto one coordinate. | §2.2 — `acRms 0.000000`, `DC −0.2125` at `k = 1.0` | one line + a unit test |
| **3** | **A THIRD factory table**, and re-default the three slots so no pair collides. | §2.3 — the pigeonhole table; a third table also raises CONNECT 0.070 → 0.138 | one generator + the default map + `cube-morph-default.test.ts` extended to assert **all three** pairs differ |
| **4** | **`isSilentWave` → a "degenerate wave" test** (`acRms < ε`, not `all |v| < ε`), so the no-dropout guard actually covers the cases that occur. | §2.2, §2.8 C | one predicate, negative-controlled both ways |
| **5** | **`view_rot_z`: implement OR delete.** *Implement* = a camera roll in `CubeCard.svelte` (precedent `video/modules/videocube.ts:1567`) — **but the card is in the WebGL basis, so this costs a GPU re-attest.** *Delete* = a def change → contract-lock + `docs:accept` + the `face.order` key, **also** in the basis. **Both cost one re-attest; implementing is the better module.** | §2.8 D | small either way |
| **6** | **`slice_rx` range `±π → 0..π`.** Half the declared travel is bit-exactly redundant. | §2.5 — `rmsΔ(a, a−π) = 0.000e+0` at six angles, with ROT Y as the live control | a `ParamDef` range edit; contract-lock + re-attest |
| **7** | *optional* — a `manualTrigger` read key so the face can have a real audition. | §7 | small; only if the owner wants a hero action |
| **8** | *doc-only, could ride the FACE PR instead* — the five `±5 %` strings → `±18 %`; the false "clearly audible" comment (`cube-dsp.ts:65-66`); the false "distinct range" comment (`:393-396`); the stale "v1 is audio-only" in `DESCRIPTIONS`. | §2.8 A/B/E/F | prose |

Items 1–4 are the **blocker**. Items 5–6 are cleanups that share the same
re-attest, so batching them is free. Item 8 is hash-transparent and I would put
it in the face PR to keep the DSP PR's diff pure.

---

## 9 · BUILD COST

| | |
|---|---|
| **contract-lock** | **0 lines** from the face — `face` is deliberately outside `contract-signature.ts` (`graph/types.ts:519-523`). The §8 PR moves it: −1 line if `view_rot_z` is deleted (47 → 46), +0 if it is implemented, +1 modified if `slice_rx`'s range changes, +1 modified when `edge: 'gate'` lands from the edge PR. |
| **WebGL attest** | **`face` block: ZERO churn** inside `docs-hash-ignore`. **The panels: this is the decision.** ① `cube-view` as a **WebGL** panel → auto-enrolled in the basis (`webgl-attest-lib.ts:236-242`) → **one trusted-machine GPU re-attest** (~10 min, `WEBGL_ATTEST_ALLOW_BUSY=1 task webgl:attest`, kill 5173/4173 + clear `node_modules/.vite` first). ② `cube-view` as a **2-D canvas** panel that blits a frame the existing card renderer produces → **no basis change, no re-attest.** ② is cheaper and loses nothing the faceplate needs — the hero wants a legible picture of the solid and the plane, not a 60 fps orbit. **Recommend ②.** `cube-table-stack` is three heightfield strips = 2-D canvas either way. |
| **VRT** | +1 `face-cube-dock` scene, +1 `face-cube-rear`, +1 lane tile. ⚠ **`'linux/cube'` is in `EXEMPT_BASELINE_PAIRS`** (`vrt-exemptions.ts:1430`) — **cube has ZERO VRT protection on CI today**, which is where it renders. A face rebuild is the right moment to drain that pair, and doing so means: remove the pair **+** lower the `vrt-meta` linux-deficit ratchet by the same count **+** re-run `task test:ledger:accept`, **all in one commit**, *then* dispatch `vrt-update.yml -f platform=linux`. cube's canvases are already handled by `vrt-live-surfaces.ts` (a measured companion + a per-run negative control), not a blanket mask. |
| **faces-parity** | **29 cells** — 27 param cells + 2 panel cells, with 2 promoted into the hero. That is the most expensive face in the repo (pentemelodica was the previous high at 28 in batch 3). |
| **module-face-lint** | +1 face; 7 new `valueId` registrations in `face-readout-values.ts`, each needing its permanent negative control (§6.1). |
| **STRICT_FACES** | cube is **not** currently a member (`strict-faces.ts`); it joins. |
| **CI wall-time** | **Estimated +40–70 s.** Unit lane: 7 pure readout functions + their negative controls ≈ +2 s. faces-parity: 29 cells ≈ +25–40 s on the SwiftShader shard (the parity sweep drives every cell). VRT: 3 scenes ≈ +15–25 s. **Under the ~2 min sign-off threshold**, but only just, and the faces-parity figure is the uncertain one — see §10. |
| **docs** | `task docs:accept` after the §8 item-8 prose fixes. cube is already in `STRICT_DOCS` (`strict-docs.ts:51`), so every port/param must stay documented. |

---

## 10 · WHAT I COULD NOT DETERMINE

1. **The faces-parity wall-time for a 29-cell face.** I extrapolated from
   pentemelodica's 28 cells being called "the most expensive in the batch"
   without a measured per-cell figure. If the sweep is ~1.5 s/cell rather than
   ~1 s, this face alone is ~45 s and the estimate above is low. **Measure one
   existing face's parity row before merging**, not after.
2. **Whether a 2-D hero panel can show the solid legibly.** I recommend route ②
   in §9 on cost grounds, but I did not prototype it. The current card's picture
   is a real WebGL volume render (28 alpha-blended Z-slices,
   `CubeCard.svelte:643-653`); a 2-D reduction may or may not read. **This is the
   one design decision in the spec I would want a mockup for before building.**
3. **Whether `slice_y`'s degeneracy is worth a real DSP fix.** Marching the ray
   over the cube's actual entry/exit interval instead of a fixed `±√3/2` window
   would make Y live everywhere — and would move **every** cube ART baseline and
   the VRT scene. I scoped it OUT of §8 deliberately; whether it is worth its own
   PR is an owner call I cannot make from measurement alone.
4. **The audible threshold for the L/R asymmetry (§2.8 J).** 0.192 dB is below
   any figure I can cite; I called it a layout fact rather than a defect on that
   basis, but I did not verify it against a reference.
5. **Whether the owner wants `view_rot_z` implemented or deleted.** Both cost one
   re-attest (§8 item 5). I recommend implementing — the sibling already does —
   but the ledger records it as CUT because that is what the *measurement*
   supports, and the choice is a product decision.
6. **The `screen_on` interaction with a faceplate hero panel.** Today `screen_on`
   gates the card's rAF loop (`CubeCard.svelte:906-933`). If the hero panel is a
   second live surface, `screen_on` must gate it too or the perf win is lost —
   I did not trace whether `ModuleShell` mounts a panel when the module is
   off-screen.

---

## 11 · VERDICT

> ### `PROMOTE — blocked on the crush/space-diffuse DC fault (§8 items 1–4)`
>
> cube's paradigm is strong, its picture is the best in the module set, and 34 of
> its 36 controls survive measurement — but **two controls drive the output to
> `acRms` exactly 0.000000 with a full-scale DC offset at their maximum, reachable
> by knob and by CV, and the module's own no-dropout guard is structurally blind
> to both.** That is four small DSP edits, not the module-wide rebuild batch-3's
> `SWAP OUT` implied; MORPH is alive, the amp ADSR is alive, and the remaining
> defects are documentable or already owned by other PRs. **Land §8 items 1–4,
> then face it — and note that the pigeonhole (§2.3) means #1314 moved the
> collision rather than removing it, so the third factory table is a fix to the
> class, not to one more instance of it.**
