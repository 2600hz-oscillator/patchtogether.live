# BACKDRAFT FLICKER — research + derived model

**Date:** 2026-07-26
**Branch:** `feat/backdraft-flicker`
**Owner ask:** a knob with **OFF / 24 / 50 / 60 Hz** on BACKDRAFT's feedback path.
OFF = exactly today's behaviour; each frequency models the relative effect of that
display flicker as seen by our virtual camera.
**Acceptance bar (owner's words):** *"it is possible to find settings where pulses
of light build up and fade away with zero or extremely subtle variations in camera
position, orientation, etc."*

> **SHIPPED — kept as the derivation, not as a plan. Re-verified 2026-08-12.**
> FLICKER is live in `packages/web/src/lib/video/modules/backdraft.ts`, which
> **cites this document by path at `:105`** — do not delete it without fixing the
> citation. `BACKDRAFT_FLICKER_SHUTTER = 0.25` and
> `BACKDRAFT_FLICKER_READOUT = 0.5` are exported there, matching §7. v1 = **#1181**;
> v2 landed on top. **Nothing in this file is outstanding work.**
>
> **§0–§6 are the v1 record**; §5's SHUTTER is v1's 0.5, and §5.7's per-position
> numbers were deleted in the 2026-08-12 sweep because they no longer describe the
> code. **§7 is the v1 → v2 accounting and is what ships today**: why v1 strobed,
> every mechanism considered, which were adopted, which were **rejected and why**
> (§7.5's eigenvalue-zero argument and §7.6's AGC sensitivity argument are the two
> worth reading before anyone proposes either again), the per-position character
> notes, and the genlock decisions.

---

## 0. TL;DR — the mechanism, and why we don't have it today

A real camera-into-monitor loop does **not** have a constant per-pass gain. The
display emits light in **pulses** (one per refresh); the camera **integrates** over
an exposure window that is shorter than the pulse period and **samples** at its own
frame rate. The emission rate and the sampling rate **beat**, so the fraction of
each pulse the camera actually catches **cycles above and below its own average** —
the instantaneous loop gain oscillates around unity even though its long-run average
is unity. That is what lets light **build up over several frames and then fade back
down** instead of racing to the clip ceiling and staying there.

BACKDRAFT today composites

```
out = clamp(source + fb·FEEDBACK·effectScale, 0, 1)
```

with `FEEDBACK` a **constant**. Every coefficient is non-negative and the clamp is
monotone increasing, so the whole per-pixel iteration is a **monotone positive map**.
A monotone positive map has only fixed-point attractors: gain < 1 ⇒ decay to the
source-supported equilibrium, gain > 1 ⇒ climb to the clip ceiling and stay. **Adding
delay cannot change this** — a delay only creates oscillation when the loop contains a
sign inversion or a level-dependent correction, and ours contains neither. This is the
exact, formal reason the owner's observation holds: *"all our feedback saturates to
bright white and stays there, even with delay modeled."*

FLICKER is the missing term. It makes the per-pass gain a function of time,
`g(t)`, which breaks monotonicity and produces the build/fade limit cycle.

---

## 1. Crutchfield 1984, "Space-time dynamics in video feedback" (Physica D 10, 229–245)

Read in full from the CSC/UC Davis scan (OCR text layer extracted). The canonical
treatment. What it actually gives us:

### 1.1 The discrete-time model

Crutchfield's image space is the space of positive-valued intensity functions
`I(x)` on the screen `[-1,1]²`; the dynamic is a map `T : I_n ↦ I_{n+1}` applied
**once per raster time**. His first model (his eq. 1):

> `I_{n+1}(x) = L·I_n(x) + s·f·I_n(bRx)`

- `L` — intensity dissipation of the **storage elements** (monitor phosphor, but
  *dominated by the camera photoconductor*).
- `f ∈ [0,1]` — **the f/stop / iris**. This is the loop-gain knob.
- `b` — **zoom** (spatial magnification), `R` — **rotation** between the two rasters.
- `s = ±1` — luminance inversion.

Our module is a direct descendant: `FEEDBACK` ≈ `f`, `ZOOM`/`ROTATE`/`OFF X/Y` ≈ `bR`
plus translation, `LUMA` ≈ `s·L`.

His fuller model (eq. 4) adds the camera's **temporal storage and integration** as a
weighted sum of past images with decay `L`:

> `I_{n+1}(x) = L·(I_n(x))_τ + L'·(I_n(x))_κ + s·f·I_n(bRx)`

where `(·)_τ` is a temporal low-pass over past frames and `(·)_κ` is the spatial
(focus) diffusion convolution. Continuum form (eq. 7) is a **reaction–diffusion PDE**
with a **non-local** transport term:

> `dI(x)/dt = L·I(x) + s·f·I(bRx) + σ∇²I(x)`

Turing's result carries over: with linear reaction this system "gives rise to spatial
patterns that can oscillate temporally". Video feedback differs from a classical
Turing system only by that non-local `I(bRx)` coupling from zoom+rotation.

### 1.2 The attractor taxonomy — where "build up and fade away" lives

His Table II maps observed behaviour to state-space objects:

| observed | attractor |
|---|---|
| equilibrium image | fixed point |
| **temporally repeating images** | **limit cycle** |
| temporally aperiodic images | chaotic attractor |
| **random relaxation oscillation** | **limit cycle with noise-modulated stability** |
| dislocations / spatially decorrelated | quasi-attractor |

And, critically, the regime the owner is describing:

> *"At large zoom, or spatial magnification, the system noise is readily (and
> exponentially) amplified. This regime is dominated by **bursts of light and colour**.
> Depending on the controls, the bursts can come at **regular intervals or at random
> times**. … This behaviour is quite reminiscent of a **limit cycle with (noise)
> modulated stability**."*

That *is* "pulses of light build up and fade away". He also notes the settings that
give the dead ends we currently have: *"For extreme parameter settings, such as small
rotation, low contrast, large demagnification … **equilibrium images** are typically
observed."*

### 1.3 What actually saturates the loop

Appendix A gives the nonlinearity: the vidicon photoconductor responds `i₀ ∝ I_i^γ`
with `γ ∈ [0.6, 0.9]` and **saturates above an intensity threshold**; the monitor adds
its own saturating nonlinearity at high brightness/contrast. Our `clamp(·, 0, 1)` is
that saturation, and (as in §0) with a constant gain a saturating monotone map can
only pin.

### 1.4 The one place Crutchfield's model **omits** our effect — and why that is the gap

Crutchfield explicitly drops the field-rate flicker:

> *"the bulk of them transmit two interlaced half-rasters, or **fields**, every
> sixtieth of a second. … **Since the time scale of this is much less than the image
> storage and integration time of the vidicon it can be neglected.**"*

and

> *"the charge storage and integration during each raster time places an upper limit
> on the temporal frequency response … this **storage time τ_s** can be quite a bit
> longer than the raster time τ_r of 1/30 second. A rough approximation would be
> **τ_s ≈ 10·τ_r ≈ 1/3 second**. Thus the system's frequency response should always
> be **slower than 3 Hz**."*

> *"the **phosphor's persistence is typically a single raster time** and so it can be
> neglected compared to the vidicon's storage time."*

**This is the crux.** A 1980s *vidicon tube* camera is a ~1/3-second integrator: it
smears 10 refreshes together, so the 50/60 Hz emission pulse train is averaged flat
and the flicker term genuinely vanishes. Crutchfield was right to drop it *for his
apparatus*.

Every camera anyone will point at a screen today is a **CMOS sensor** with:
- an **exposure window** typically 1/50–1/500 s — *shorter* than the emission period,
  not 20× longer;
- **essentially zero inter-frame charge storage** (the ~1/3 s smear is gone);
- a **rolling shutter** — each row is exposed at a different instant.

So the term Crutchfield legitimately neglected is exactly the term that dominates a
modern loop, and it is exactly the term we are missing. Our simulation inherited the
vidicon-era simplification without inheriting the vidicon.

---

## 2. Temporal mechanics of a real loop

### 2.1 The display side — emission is a pulse train, not a constant

- **CRT / impulse displays.** A phosphor is struck once per refresh and decays; the
  emission is a narrow pulse plus an exponential tail. Measured CRT phosphor decay is
  fast — brightness falls by ~100× within about a millisecond — so a 60 Hz CRT is dark
  for most of each 16.7 ms period. Crutchfield's "persistence ≈ one raster time" is the
  same statement.
- **LCD with PWM backlight / BFI / strobed backlight.** Emission is a literal square
  wave; duty cycle sets brightness. Blur Busters' CRT-beam-simulation shader work is
  built on precisely this "rolling scan plus phosphor fade" impulse model, and notes
  that all refresh cycles must be processed **independently of content frame rate** —
  the same separation of emission clock from content clock we need.
- **Film projector.** A 24 fps projector uses a **two- or three-bladed shutter** so
  each frame is flashed 2× or 3×; the *flicker* rate is 48 or 72 Hz even though the
  *frame* rate is 24. (See §5 — we deliberately model the knob's literal 24 Hz.)

Common shape for all three: periodic emission at `f`, mean-normalised, with
significant modulation depth.

### 2.2 The camera side — integrate, then sample

Two independent windows:

- **Exposure / integration time `T_e`.** The sensor sums light over `T_e`. This is a
  boxcar filter, and a boxcar of width `T_e` has frequency response `sinc(f·T_e)`.
  **`T_e` an exact integer multiple of `1/f` ⇒ the response is exactly zero ⇒ no
  flicker.** This is not a coincidence, it is the entire flicker-free-shooting rule of
  thumb: *shoot 1/50 s or 1/100 s under 50 Hz mains, 1/60 s or 1/120 s under 60 Hz*.
  Our model reproduces this rule exactly and we unit-test it.
- **Frame rate `f_c`.** The camera samples the (already integrated) signal at `f_c`.
  Sampling folds the emission frequency to the alias
  `f_beat = |f − round(f/f_c)·f_c|`.

### 2.3 The beat is the whole point

The per-frame captured energy oscillates at `f_beat`, so the loop's **instantaneous**
gain rides above and below its mean. Provided the *long-run* gain sits near unity, the
loop alternates between expanding and contracting phases: **light accumulates for the
half-cycle where gain > 1 and drains for the half-cycle where gain < 1.** Pulses build
and fade. This is the regime Crutchfield calls "bursts of light and colour … at regular
intervals" and is precisely the acceptance bar.

### 2.4 Rolling shutter turns the beat into crawling bands

With a rolling shutter, row `v` starts its exposure at `t + v·T_ro`, where `T_ro` is the
sensor readout time. The flicker phase therefore varies **down the frame**, producing
the familiar light/dark **banding**. Community measurement confirms the standard
relation — the number of bands equals the number of flicker cycles that elapse during
one readout, `bands = f · T_ro`; e.g. a 50 ms readout under 120 Hz mains flicker gives
6 bands. When `f` is close to the camera rate (our case) `f·T_ro < 1`, so you get **one
broad band / gradient**, and it **crawls vertically at the beat frequency** — which is
exactly the slow hum bar you see when you film a TV. Feeding that spatially-varying
gain back through the loop is where the "visual network" the owner describes comes
from: bands seed structure that the spatial transform then carries around the loop.

### 2.5 Interaction with the existing DELAY (explicitly reasoned, per the brief)

BACKDRAFT's DELAY is a ring tap: the composite reads output frame `n − d`. With the
flicker gain applied at **capture** time the recursion becomes

```
I_{n+1} = source + g(t_n) · FEEDBACK · effectScale · I_{n−d}
```

Unrolling `k` loop passes gives a product of gains
`∏_{j=0..k-1} g(t_{n − j(d+1)})` — the phase experienced per pass advances by
`(d+1)/f_c` seconds, i.e. by `f_beat·(d+1)/f_c` cycles.

Consequences, all of which fall out for free and none of which need extra code:

- **Coherence is automatic** *provided `g` is a function of absolute simulation time
  rather than of a per-tap counter.* Because we evaluate `g(t)` at the current virtual
  camera frame and the tap reaches `d` frames back, the gains composed along the
  delayed path are the ones that really occurred at those times. This is the single
  design decision that makes DELAY and FLICKER interact physically instead of
  arbitrarily.
- **Resonance / subharmonics.** When the beat period is commensurate with `(d+1)`
  frames, successive passes land on the same phase and reinforce → strong, locked
  pulsing. Crutchfield's bifurcation route (2) — *"the introduction of subharmonics at
  frequencies lower than that of the original limit cycle"* — is exactly this.
- **Quasiperiodic wandering.** When incommensurate, each pass lands on a slightly
  different phase and the pattern precesses — long, non-repeating evolution, the
  "network" richness.
- **Reinforcement of Crutchfield's own point** that the loop delay is at minimum one
  frame; DELAY simply lengthens it, and lengthening it multiplies the number of
  distinct flicker phases in flight.

---

## 3. Why 24 / 50 / 60 specifically

| knob | origin | pairs historically with | beat vs our 60 Hz virtual camera |
|---|---|---|---|
| **24** | cinema frame rate (and 23.976 for NTSC-compatible digital cinema) | film; on 60 Hz video it needs **3:2 pulldown**, the source of 24p judder | `\|24 − 0·60\| = 24 Hz` → 2.5 camera frames per cycle: a hard, fast **strobe** |
| **50** | **PAL/SECAM** field rate; 50 Hz mains (Europe, most of Asia/Africa) | European broadcast + European mains lighting | `\|50 − 60\| = 10 Hz` → 6 camera frames per cycle: a **slow, clean throb** — the classic "filming a PAL monitor with an NTSC camera" roll |
| **60** | **NTSC** field rate; 60 Hz mains (North America, parts of Japan) | US broadcast + US mains lighting | see below |

The 60 position needs care and it is an interesting piece of real physics.
"60 Hz video" is **not** 60.000 Hz — NTSC's field rate is `60000/1001 = 59.94 Hz`.
Against a 60.00 Hz camera that beats at **0.06 Hz**, a **16.7-second** cycle: the
famous *very slowly crawling hum bar* you get pointing a camera at a television. If we
instead modelled the 60 position as exactly 60.000 Hz it would be perfectly
**genlocked** — the camera would sample the identical phase forever, the gain would be
a **constant** (in our tuning, ≈0.68), and the knob position would behave as a dumb
attenuator with no motion at all. We model **59.94 Hz** because it is both the more
correct number and the one that produces the real-world behaviour.

So the three positions are deliberately three *orders of magnitude* of beat rate:
**24 Hz strobe → 10 Hz throb → 0.06 Hz breathe.**

Note on the projector nuance from §2.1: a real 24 fps projector flickers at 48 or
72 Hz because of its multi-bladed shutter. We model the knob's **literal 24 Hz**
(a display refreshing at 24 Hz / a source strobing at 24 Hz), because the owner asked
for "that flicker" at the labelled frequency and because a 48 Hz position would be a
surprising thing to hide behind a knob labelled 24. Adding an explicit shutter-blade
multiplier is a clean follow-up.

---

## 4. Survey — how other software feedback sims handle this

Short answer: **they don't.** Findings:

- **Shader/GPU feedback implementations** (the whole `previous-frame texture × decay`
  family, including our own FEEDBACK / VDELAY / TUNNEL / BACKDRAFT) use a **constant**
  per-frame persistence coefficient. Constant gain ⇒ §0's monotone map ⇒ decay or clip.
  This is the universal simplification.
- **Crutchfield's own digital simulations** reproduced "equilibrium images with spatial
  symmetry analogous to Turing's waves; fixed point images stable under perturbation;
  meta-stability; logarithmic spirals; logarithmic divergence" — i.e. **fixed points,
  spirals and divergence**, and notably *not* the burst/limit-cycle regime. Consistent
  with a model whose flicker term was (correctly, for his hardware) dropped.
- **The one adjacent body of work that models emission timing properly** is display
  simulation rather than feedback simulation: Blur Busters' CRT-beam-simulation /
  ShaderBeam work models rolling scan + phosphor fade per refresh cycle, decoupled from
  content frame rate. That is the emission half of our model, built for a different
  purpose (motion clarity), and it validates the impulse-emission approach.
- **Camera-side flicker** is well modelled in imaging/ISP literature and patents
  (flicker-band detection, integration-time/illuminant-frequency mismatch detection,
  multi-exposure band detection) — again the sampling half, never joined to a feedback
  loop.

Nobody appears to have closed the loop: emission pulse train × camera integration ×
camera sampling × rolling shutter, *fed back*. That is what this feature does.

---

## 5. THE DERIVED MODEL (what we implement)

### 5.1 Emission — fundamental-only pulse train

Normalise the display's emission so its **time average is 1** (so the model is a pure
identity when flicker is off, and turning it on does not change what the FEEDBACK knob
means):

```
e(τ) = 1 + m·cos(2π f τ)                       m = FLICKER_DEPTH
```

Keeping only the fundamental of the pulse train is justified twice over: the camera's
exposure boxcar attenuates the `n`-th harmonic by `sinc(n·f·T_e)`, and phosphor /
backlight decay is itself a low-pass. It also keeps `g` smooth, which matters for
frame-rate robustness (a hard pulse train aliases badly when the render loop is not
exactly on the virtual grid).

`m = 0.85`: not 1.0, because a real display does not reach exactly zero between pulses
— phosphor persistence / backlight tail leave a floor. 0.85 leaves a 15% floor.

### 5.2 Exposure integration ⇒ the first sinc

Integrating `e` over an exposure window of length `T_e` starting at `t`:

```
g(t) = (1/T_e)·∫ₜ^{t+T_e} e(τ) dτ
     = 1 + m·sinc(f·T_e)·cos(2π f (t + T_e/2))        sinc(x) = sin(πx)/(πx)
```

The exposure window contributes **exactly** a `sinc(f·T_e)` attenuation of the
modulation depth and a `T_e/2` phase lag. `sinc(1) = 0` reproduces the flicker-free
shutter rule of §2.2 exactly — this is a **unit-tested property**, not an assertion.

`T_e = SHUTTER / f_cam` with **`SHUTTER = 0.5`**: a **180° shutter**, the universal
cinema/video convention (1/120 s at 60 fps).

### 5.3 Rolling shutter ⇒ the spatial term and the second sinc

Row `v ∈ [0,1]` (screen space, bottom→top) begins its window at `t + v·T_ro`:

```
g(t, v) = 1 + m·sinc(f·T_e)·cos(2π f (t + v·T_ro + T_e/2))
```

Averaging over rows gives the **frame-mean** gain and a second sinc:

```
ḡ(t)   = 1 + m·sinc(f·T_e)·sinc(f·T_ro)·cos(2π f (t + T_ro/2 + T_e/2))
```

`T_ro = READOUT / f_cam` with **`READOUT = 0.5`**: the sensor reads out over half a
frame period — mid-range CMOS (real sensors span ~0.15 for fast stacked sensors to
~1.0 for cheap ones). The choice is a genuine trade-off and the second sinc is exactly
the dial: `READOUT → 0` is a global shutter (full mean pulsing, no bands);
`READOUT = f_cam/f` makes `sinc = 0` and gives **pure standing bands with zero mean
pulsing**. 0.5 keeps a strong mean pulse (≈0.46 depth at 50 Hz) *and* a visible
~0.42-cycle gradient that crawls.

**Yes, we include the rolling-shutter spatial term** — the research supports it
(§2.4), it is a large part of the real look, and bands crawling through the feedback
network is exactly the emergent structure the owner is after.

### 5.4 Virtual camera sampling ⇒ the beat

The virtual camera runs at a **fixed** `f_cam = BACKDRAFT_FPS = 60`. Simulation time is
quantised onto its frame grid before evaluating the phase:

```
n  = floor(t · f_cam)          # virtual camera frame index
tₙ = n / f_cam                 # its sample instant
```

This quantisation is **load-bearing for determinism**: without it a 120 Hz ProMotion
display would sample the 50 Hz emission at 120 Hz and see a 50 Hz beat instead of a
10 Hz one — a completely different look for the same knob settings. With it, the
alias is fixed at `|f − round(f/f_cam)·f_cam|` on every machine.

### 5.5 Operating-point normalisation

A gain whose **arithmetic** mean is 1 has **geometric** mean < 1 (AM–GM), and a
multiplicative loop cares about the geometric mean. Left uncorrected, switching FLICKER
on would silently *damp* the loop and force the user to re-hunt the FEEDBACK setting.
In a real rig the operator does exactly that — reopens the iris to compensate. We fold
that compensation in so the FEEDBACK knob keeps meaning the same thing:

```
a = m·sinc(f·T_e)·sinc(f·T_ro)              # frame-mean modulation depth
A = 2 / (1 + √(1 − a²))                      # from ∫log(1 + a·cosθ)dθ/2π = log((1+√(1−a²))/2)
```

so the frame-mean gain has **unit geometric mean over a beat cycle**. Verified
numerically: `geoMean ≈ 1.0001` over 10 s at 24 and 50 Hz.

### 5.6 Final model

```
g(t, v) = A · [ 1 + m·sinc(f·T_e)·cos( 2π f (tₙ + T_e/2) + 2π f T_ro · v ) ]
```

shipped to the shader as four scalars (plus an on/off flag):

```
uFlickerGain  = A
uFlickerDepth = A · m · sinc(f·T_e)
uFlickerPhase = 2π f (tₙ + T_e/2)          (wrapped to [0, 2π))
uFlickerRow   = 2π f T_ro
→  g = uFlickerGain + uFlickerDepth · cos(uFlickerPhase + vUv.y · uFlickerRow)
```

**Application point.** `g` multiplies the **feedback tap immediately after sampling**,
before the colour processing — because it is the light the *camera captured*, and the
per-channel/luma/chroma gains are the *electronics* downstream of the sensor. It is
therefore inherited by both the additive accumulator and the hall-of-mirrors path
without special-casing either. The row coordinate is the raw **screen** `vUv.y` (like
the screen-space SHAPE mask), because the rolling shutter is a property of the sensor
scanning the screen, not of the feedback geometry.

**OFF is byte-identical.** The entire block sits behind `if (uFlickerOn > 0.5)` in the
shader — the same load-bearing-gate idiom as PIXELATE's `if (uPixelate > 0.0)`. At OFF
not a single additional float operation executes, and the CPU helper returns
`enabled: false` with `gain` exactly `1` and `depth` exactly `0`.

### 5.7 Numbers

**Deleted 2026-08-12 — v1's per-position table was computed at `SHUTTER = 0.5` and
had no 6 or 120 position. The current numbers, at the shipped `SHUTTER = 0.25`
with the storage and shoulder terms in the signal path, are §7.7's table.** The
one v1 conclusion worth carrying forward — *50 Hz is the best build-and-fade,
because 6 virtual-camera frames per beat is long enough for the loop to integrate
up and drain back down* — survives verbatim in §7.7 and is what the DRS e2e
asserts the band on.

---

## 6. Design constraints — how each is met

| constraint | how |
|---|---|
| **Deterministic & frame-rate independent** | `g` is a pure function of `frame.time` (the engine's accumulated simulation clock, the repo's Idiom-A pattern — LINES/TEXTMARQUEE), **quantised onto the fixed 60 Hz virtual-camera grid** (§5.4). Same settings ⇒ same evolution on 60 Hz, 120 Hz ProMotion, and SwiftShader. `frame.time` is also the clock pinned by `__videoEngineFreezeTime`, so the DRS harness can advance it in exact 1/60 s steps and get a bit-reproducible sequence — no wall-clock race on CI. |
| **OFF byte-identical** | shader gate `if (uFlickerOn > 0.5)`; default `flicker = 0`; pure helper returns `enabled:false, gain:1, depth:0`. BACKDRAFT is `EXEMPT_FROM_VRT` so there are no baselines to move; behavioural + existing e2e are the empirical proof. |
| **DELAY coherence** | §2.5 — reasoned explicitly; automatic because `g` is a function of absolute simulation time, not of a per-tap counter. |

(The v1 row describing a **4-position** knob and its legacy-card button row is
deleted: the shipped control has **six** positions, and BACKDRAFT's card has been
reworked twice since — #1223/#1231 the virtual camera, #1260 "lose the display".)

---

## 7. v1 → v2: why v1 strobed, and what fixed it

**Date:** 2026-07-27 · **Branch:** `feat/backdraft-flicker-v2` · v1 = PR #1181.

### 7.1 The symptom, measured

v1 implemented §5 exactly and applied `g(t, v)` as a **linear, full-depth
multiplier on the whole feedback tap**. On the row-aware loop mirror that
`backdraft.test.ts` runs as a negative control (identity transform, uniform
source = 0.06, `FEEDBACK = 1.0`, 32 rows, settled tail), v1's **full-field
frame-to-frame luminance step** was:

| position | v1 max frame step | v1 full-field peak-to-peak |
|---|---|---|
| 6 Hz *(hypothetical — v1 had no 6 position)* | **0.469** | 0.908 |
| 24 | **0.463** | 0.719 |
| 50 | **0.312** | 0.566 |
| 60 (59.94) | 0.002 | 0.698 |

WCAG 2.3.1's *general flash threshold* treats a pair of opposing changes of
**≥ 0.10 relative luminance** (darker state below 0.80) as a flash, and more than
three per second as a seizure risk. v1's fast positions ran **3–5× over that
bound, at 10–24 flashes per second**. That is a photic strobe, not video
feedback — and it is why the owner's read of v1 was "too strobey".

The mistake was **not** the emission physics; §2 and §5 are right about how a
pulsed display is captured. The mistake is that v1 modelled
emission → exposure → sampling faithfully and then **modelled nothing downstream
of the sensor**. In a real rig, everything downstream of the sensor is what makes
the loop *breathe* rather than flash.

### 7.2 Mechanisms considered

Six were evaluated against the primary source and against the loop sim. **Two new
model terms were adopted, one existing parameter was retuned, and three were
rejected on evidence.**

| # | mechanism | verdict | why |
|---|---|---|---|
| 1 | **Camera multi-frame STORAGE** — the sensor's own charge storage/integration, as a one-pole IIR on the beat | **ADOPTED** | This is *the* mechanism Crutchfield names as setting the loop's temporal character, and v1 deleted it. See §7.3. |
| 2 | **Capture SHOULDER** — the sensor/monitor saturating response | **ADOPTED** | Makes the response level-dependent, so a gain modulation stops acting where the image is already hot: full-field flash becomes contour shimmer. It is also the loop's only true amplitude limiter. See §7.4. |
| 3 | **Spatial diffusion** — blur the fed-back tap, on the theory that a diffusive term damps the pulse | **REJECTED** | The eigenvalue argument, §7.5. Verbatim: *the Laplacian has eigenvalue zero on the uniform mode, so blur cannot damp a full-field pulse at all* — the sim confirmed it changes the metric by **< 0.0005**. |
| 4 | **AGC servo** — an auto-exposure/auto-gain feedback loop that pulls the frame mean back toward a target | **REJECTED** | Absent from the primary source, and *its sensitivity function passes exactly the fast beats that need taming*: a servo slow enough to be physical (AGC time constants are ~0.3–1 s) has a high-pass sensitivity, so it attenuates the 0.06 Hz swell we want to keep and passes the 6–24 Hz beat we need to kill. It would invert the intended ordering. It also adds per-frame state, which the freeze/DRS pins forbid. |
| 5 | **Shutter angle 180° → 90°** (`SHUTTER 0.5 → 0.25`) | **ADOPTED (parameter)** | v1's `T_e = 0.5/60` is *exactly one period* of 120 Hz, so `sinc(f·T_e) = sinc(1) = 0` and a 120 position would be **perfectly dead**. A shorter shutter is also what a real camera picks pointed at a bright screen. 0.25 leaves every position alive. |
| 6 | **A safety clamp on the modulation depth** | **REJECTED** | An arbitrary magic number that hides the physics and would have to be re-tuned for every future position. Every term in v2 is a documented physical mechanism; the bound falls out of them. This was the explicit design constraint. |

Net effect of 1 + 2 + 5, same harness, same operating point:

| position | beat vs 60 fps camera | \|H\| (storage) | v1 step | **v2 step** | improvement | v2 full-field range |
|---|---|---|---|---|---|---|
| **6** | 6.00 Hz | 0.160 | 0.469 | **0.066** | **7.1×** | 0.690 … 0.886 |
| **24** | 24.00 Hz | 0.053 | 0.463 | **0.024** | **19.3×** | 0.789 … 0.815 |
| **50** | 10.00 Hz | 0.100 | 0.312 | **0.030** | **10.3×** | 0.758 … 0.828 |
| **60** | 0.06 Hz | 0.998 | 0.002 | **0.002** | 1.0× (untouched) | 0.230 … 0.984 |
| **120** | 0.12 Hz | 0.992 | 0.000 † | **0.000** | – (pure band) | 0.606 … 0.608 |

† v1 had no 6 or 120 position; those two v1 columns are the v1 model *evaluated
at* those rates. At 120 the v1 number is 0.000 for the wrong reason — v1's 180°
shutter puts `sinc(f·T_e) = sinc(1) = 0`, i.e. the position would have been
**dead**, not soft (mechanism #5 above).

Every position is now **well inside** the 0.10 flash threshold — the worst (6 Hz)
sits at 0.066 — while the slow positions keep their **full** breathing swing
(the 60 position still travels 0.23 → 0.98). That asymmetry is not a compromise;
it is the *point*: the storage term is a low-pass **on the beat**, so it removes
exactly the fast full-field flashing and leaves the slow swell alone. The bound
also holds across the whole FEEDBACK range (0.5 / 0.8 / 1.0 / 1.2 all tested).

Verified on the **real GL path** too, not just the CPU mirror: the DRS e2e
measures 50 → max step 7.0/255 (0.027) and 6 → 14.7/255 (0.058), matching the
mirror's 0.030 / 0.066 to within the readback quantisation, and bit-identical
between a real GPU and SwiftShader.

### 7.3 STORAGE — the term v1 read and drew the opposite conclusion from

Crutchfield, Appendix A (p. 244):

> *"the charge storage and integration during each raster time places an upper
> limit on the temporal frequency response of the system. In fact, this storage
> time τ_s can be quite a bit longer than the raster time τ_r … A rough
> approximation to this would be τ_s ~ 10 τ_r ~ 1/3 second. Thus the system's
> frequency response should always be slower than 3 Hz. And this is what is
> observed experimentally."*

His eq. (4) carries it as `(I_n)_τ = Σ_i I_{n−i} · L^i`. **A real loop physically
cannot strobe** — the camera itself is a few-Hz low-pass.

v1 read this same passage (§1.4) and concluded the *opposite*: that a modern CMOS
sensor has no such storage, so the flicker term Crutchfield dropped is the one
that dominates today. **Both halves of that are true, and together they are the
bug.** Deleting the integrator is precisely *why* naive digital feedback reads
harsh; the fix is to put the integrator **back**, not to add a full-depth gain
LFO on top of its absence. v1 added the LFO and kept the integrator deleted,
which is the worst of both.

Implemented in **closed form** rather than with an accumulator. Normalised to
unit DC gain, the geometric sum is a one-pole IIR with per-frame retention
`L = exp(−1/τ_frames)`, whose response is

```
H(ω) = (1 − L) / (1 − L·e^{−iω}),      ω = 2π·f_beat / f_cam
```

and the gain we ship is a pure sinusoid **at the beat frequency**, so the
steady-state response is *exact*. We get a 10-frame integrator's physics with **no
per-frame state** — no threat to determinism, to `freeze`, or to the DRS pins.
`τ = 10` frames is Crutchfield's own figure.

The shape is the whole point: it is a low-pass **on the beat**, so it cuts the
fast beats (which are the strobe) and passes the slow ones (which are the
breathing). That one fact is what separates 6/24/50 from 60/120 in v2.

### 7.4 SHOULDER — the loop's only real amplitude limiter

Crutchfield, Appendix A: the vidicon photoconductor *"response function saturates
above some intensity threshold I_sat"*, and *"within the monitor there are
saturating nonlinearities in its response to large intensity signals and high
brightness or high contrast settings"*. He lists these among the errors excluded
*"for simplicities sake"* — but in a **loop**, that saturation is the only thing
limiting amplitude, and a bare `clamp()` is not it: a clamp is perfectly linear
right up until it pins.

```
shoulder(x) = x                                        for x ≤ k
            = k + (1−k)·(1 − exp(−(x−k)/(1−k)))        for x > k        (k = 0.55)
```

Identity below the knee; above it an exponential roll-off toward 1.0 with **unit
slope at the knee**, so it is C¹ and never adds a visible crease. `k → 1` is the
exact identity, which is how OFF stays bit-identical.

Because the incremental response falls to ~0 as a region approaches white, a gain
modulation **stops acting where the image is already hot** and keeps acting in the
midtones — the beat reads as **contour shimmer** instead of a full-field flash.
A bare gamma/power law would **not** do this: a power law is scale-free, so
`d(log out)/d(log in)` is identical at every brightness.

### 7.5 REJECTED: spatial diffusion — the eigenvalue-zero argument

The sharpest finding of the v2 round, stated verbatim:

> **The Laplacian has eigenvalue zero on the uniform mode, so blur cannot damp a
> full-field pulse at all** — the sim confirmed it changes the metric by
> **< 0.0005**.

The reasoning: a diffusion/blur term contributes `∇²` to the update. Decompose the
frame into spatial eigenmodes of the Laplacian; the **uniform (DC) mode** — a
field that is equally bright everywhere — has eigenvalue **0**, so the diffusion
term contributes **exactly nothing** to it. But "full-field flash" *is* the DC
mode. Blur can smooth spatial structure as much as you like and the whole-field
luminance pulse passes through completely untouched. It is not that blur is a weak
fix; it is that blur is **provably the wrong operator** for this quantity. The
0-D/2-D sim was run as a check and confirmed it: `< 0.0005` change in the metric.

This is worth keeping on the record because "just blur the feedback a bit" is the
first thing anyone reaches for, and it cannot work here for a structural reason.

### 7.6 REJECTED: an AGC servo

An auto-gain/auto-exposure servo that measures the frame mean and pulls it back
toward a target is superficially attractive — real cameras have one. Rejected on
three grounds:

1. **Not in the primary source.** Crutchfield's rig has manual gain; the paper's
   temporal ceiling comes from storage, not from a servo.
2. **Its sensitivity function passes exactly the fast beats that need taming.** A
   servo with a physical time constant (~0.3–1 s) has a **high-pass** sensitivity:
   it suppresses what is slow and passes what is fast. That is precisely backwards
   — it would flatten the 0.06 Hz swell we want to keep and leave the 6–24 Hz
   flashing untouched.
3. **State.** A servo is an integrator with per-frame memory in the render path,
   which conflicts with `freeze`, the DRS pins and bit-reproducibility.

### 7.7 The six positions — character and beat arithmetic

Beat = `|f − round(f/60)·60|` against the fixed 60 fps virtual camera.
`|H|` = the storage low-pass at that beat. `bands` = `f·T_ro` = how many full
light/dark cycles fit down the frame (`T_ro = 0.5/60`).

| pos | f (Hz) | beat | frames/cycle | \|H\| | bands | character |
|---|---|---|---|---|---|---|
| **OFF** | – | – | – | – | – | The exact no-op. Constant loop gain; the shader branch is skipped; output bit-identical to pre-FLICKER BACKDRAFT. |
| **6** | 6.000 | 6 Hz | 10 | 0.160 | 0.05 | **Sub-refresh** — no display refreshes this slowly, so this position models a slow **strobe / BFI / dimmer**. It is *below* the camera rate, so there is **no aliasing**: the camera sees the pulsing directly. Spatially near-uniform (0.05 of a band), so its whole character is a **full-field breathe** — the largest swing of any position (0.69 → 0.89) and therefore the one the photosensitivity bound is really about. |
| **24** | 24.000 | 24 Hz | 2.5 | 0.053 | 0.20 | **Cinema.** 2.5 camera frames per cycle is too fast for the loop to travel far before reversing, so it dithers rather than pulses: a **fine, fast texture** rather than a throb. The storage term cuts it hardest of all (|H| = 0.05), which is correct — it is the fastest beat. |
| **50** | 50.000 | 10 Hz | 6 | 0.100 | 0.42 | **PAL/SECAM field rate + 50 Hz mains.** The classic *filming a European monitor with an NTSC camera* roll. 6 frames per cycle is long enough to genuinely integrate up and drain back down, and 0.42 of a band down the frame gives a **strong crawling bar** at the same time. The best all-round build-and-fade, and the position the DRS e2e asserts the band on. |
| **60** | 59.940 | 0.06 Hz | ~1000 | 0.998 | 0.50 | **True NTSC field rate.** A **16.7-second slow swell** — the very slowly crawling hum bar off a television. Storage passes it essentially untouched (0.998), so this position keeps its **full** dynamic range (0.23 → 0.98) while being far too slow to flash. Half a band down the frame. |
| **120** | 119.880 | 0.12 Hz | ~500 | 0.992 | 1.00 | **A 120 Hz panel** (or double-strobed 60). `f·T_ro ≈ 1.000`, so the rolling shutter fits **exactly one full band cycle** down the frame and the row-average sinc **cancels the whole-frame pulse almost completely** — the full-field range collapses to 0.606 … 0.608. What is left is a **pure crawling band** with a flat global level: the most "broadcast artefact" of the set, and the only position whose life is entirely spatial. |

**Ordering sanity check** (asserted in the e2e): the 6 position must swing *more*
in full-field terms than the 50 position. Two independent reasons, both pointing
the same way — the storage low-pass passes a 6 Hz beat (0.160) better than a
10 Hz one (0.100), *and* 6 Hz spreads only 0.05 of a band down the frame so the
rolling shutter barely washes its whole-frame pulse out (0.42 bands at 50 washes
out noticeably more). Measured 22.0% vs 6.6% on the real GL path. That ordering
is the observable signature of the camera-side terms actually being in the signal
path — delete them and it breaks.

### 7.8 Genlock: 59.94 not 60.000, and 119.88 not 120.000

Both new/kept high positions use the **NTSC** rates, and this is load-bearing
rather than pedantic.

- The virtual camera is pinned at exactly **60.000 fps** (§5.4 — that pin is what
  makes the beat frame-rate independent and therefore deterministic).
- If the 60 position were **60.000 Hz** it would be **genlocked** to the camera:
  `beat = |60 − 1·60| = 0`. The camera would sample the identical emission phase
  forever, `g` would be a **constant**, and the position would degrade to a dumb
  attenuator with **no motion at all**.
- Identically, a **120.000 Hz** position gives `beat = |120 − 2·60| = 0` — dead.
- The real numbers are `60000/1001 = 59.9401 Hz` and `2 × 60000/1001 =
  119.8801 Hz`, giving beats of **0.0599 Hz** and **0.1199 Hz**: ~16.7 s and
  ~8.3 s cycles. So the NTSC rates are simultaneously **more correct** and the
  **only** ones that move.
- This also means the two are *not* redundant: 120 is not "60 twice as fast". Its
  beat is twice as fast (8.3 s vs 16.7 s), but far more importantly its
  `f·T_ro = 1.000` puts it exactly on the rolling-shutter null, which converts it
  from a full-field swell into a pure band. Same family, opposite character.
- The 120 position is *also* the reason the shutter had to move to 90°: at
  `T_e = 0.5/60`, `sinc(119.88 · 0.5/60) ≈ sinc(0.999) ≈ 0` would have killed it
  outright (mechanism #5 above).

### 7.9 What holds the line

- **Unit** (`backdraft.test.ts`, pure, zero added CI wall-time): the storage
  response is a monotone low-pass that passes DC and lags; the shoulder is the
  exact identity below the knee, C¹ at it, monotone and never reaching the
  ceiling; `knee ≥ 1` is the exact identity (how OFF stays bit-identical); OFF
  returns `gain 1 / depth 0 / knee 1` with no float slop; every ON position has
  real row modulation and never negative gain; the geometric mean of the frame
  gain stays 1; and a **row-aware loop mirror** enforces the **swing bound at
  every position across the whole FEEDBACK range**, with **v1 reconstructed as a
  negative control that must FAIL the bound** so it cannot go vacuous.
- **E2E** (`backdraft-render-smoke.spec.ts`, real GL, pinned clock): OFF
  saturates and stays; 50 builds, fades, and moves a rolling-shutter band; 6
  swings more than 50 (the storage ordering); and **neither flashes** on the real
  shader path.
- **Docs**: the co-located `docs.controls.flicker` prose and the card tooltips
  are generated from the same constants, and the param range is pinned by
  `contract-lock.txt`.

---

## 8. Sources

- Crutchfield, J.P., "Space-time dynamics in video feedback", *Physica D* **10** (1984)
  229–245 — <https://csc.ucdavis.edu/~cmg/papers/Crutchfield.PhysicaD1984.pdf>
  (also <https://vasulka.org/Kitchen/PDF_Eigenwelt/pdf/191-207.pdf>)
- Video feedback (loop delay ≥ one frame time) — <https://en.wikipedia.org/wiki/Video_feedback>
- CRT phosphor decay / camera-vs-CRT sampling artefacts —
  <https://nyanpasu64.gitlab.io/blog/crt-photography/>, <https://michaelbach.de/misc/crtlimits/>
- Screen flicker, impulse vs sample-and-hold — <https://en.wikipedia.org/wiki/Flicker_(screen)>
- Blur Busters CRT beam simulation / rolling scan + phosphor fade shaders —
  <https://blurbusters.com/crt-simulation-in-a-gpu-shader-looks-better-than-bfi/>,
  <https://blurbusters.com/blur-busters-open-source-display-initiative-refresh-cycle-shaders/>
- Rolling-shutter banding, bands = f·T_readout, sensor readout measurements —
  <https://github.com/horshack-dpreview/RollingShutter>,
  <https://forums.raspberrypi.com/viewtopic.php?t=207440>
- Flicker-free shutter selection (1/50 vs 1/60, shutter angle, 24p judder) —
  <https://www.provideocoalition.com/rolling-shutter-and-flickering-hmis/>,
  <https://www.cinematography.net/edited-pages/Is_23.976_A_Flicker_Free_Frame_Rate.htm>,
  <https://www.urbanvideo.ca/avoid-video-flicker>
