# BACKDRAFT — PURE TV (Crutchfield bounded-screen mode)

**Date:** 2026-07-27 · **BUILT AND MERGED (#1214)** · corrected after two adversarial reviews

> **NAMING: this doc says "PURE TV" throughout; the SHIPPED label is
> "VIRTUAL CAMERA".** `BACKDRAFT_TV_MODE_LABELS = ['OFF', 'VIRTUAL CAMERA',
> 'CRITICAL']` in `backdraft.ts`. Read every "PURE TV" below as the mode the card
> calls VIRTUAL CAMERA. Nothing else is renamed — the derivation, the constants and
> the shader all still use the TV vocabulary.
>
> The Dirichlet-zero substitution this doc argues for is live in `backdraft.ts`
> (`TV MODE positions: 0 = OFF (the legacy composite), 1 = PURE TV`), and ROTATE is
> read through a PURE-TV-only scale so the symmetry locks are reachable without
> remapping any other mode's CV. It shipped hard: **#1234, #1249, #1256** are all P0
> main-red follow-ups from this feature, and the frame-count-not-milliseconds rule
> now in CLAUDE.md was learned here. BACKDRAFT was re-laid-out twice (**#1231**,
> **#1260**), so any card geometry is stale. Kept for the Crutchfield derivation,
> which the shipped shader is built on and which `backdraft.ts` cites by path.

**Owner's request (verbatim, load-bearing):**
> "backdraft still not doing crutchfield thing. lets try another gate for a 'pure tv' mode. see how loopback goes recursive when we zoom in out it? this is what we want for a crutchfield / pure tv mode for backdraft. the tv has a frame and each recursing image is shown only inside the boundaries of the interior box. we want to simulate actual crutchfield space/time simulation and the only way this works is if each loop iteration completely constrains the visual field of the suceeding iterations. what we want in this mode is an exact simulation of pointing a camera at a tv screen showing the image that camera sees, and we want delay to cascade through it by simulating phosphor."

**And the answer to "should it be stable?" — verbatim, and it reframes the feature:**
> "this needs to be included, i don't want to review it otherwise. needing to ride the edge of white out and sort of drive it is an expected condition."

**Instability is the instrument, not a defect.** The owner expects to ride the edge
of white-out and drive it. A mode that converges to a static nest and holds it is
not what was asked for. Consequently: the contraction contract is the law for PURE
TV and is **LIFTED** in CRITICAL; the always-on shoulder and the bounded room remain
**soft** limiters — what makes a white-out *recoverable* rather than terminal — and
**recoverability, not stability, is the safety property that gets proven**. "Sort of
drive it" is a RESOLUTION requirement: a binary position cannot ride an edge, so the
near-unity region needs real control resolution and a musical CV response.

Primary sources: Crutchfield, *Space-time dynamics in video feedback*, **Physica D
10 (1984) 229–245**; Crutchfield, *Spatio-Temporal Complexity in Nonlinear Image
Processing*, **IEEE TCAS 35(7) (1988) 770–780**. Prior lineage:
`.myrobots/plans/backdraft-flicker-research-2026-07-26.md` (FLICKER v1/v2 —
orthogonal, keep).

---

## 0. WHAT WE GOT WRONG

**BACKDRAFT had never had a screen. It had a plane.** What makes a LOOPBACK
screenshot read as a Droste is not the shrinking — it is that **outside each
rectangle there is something that is NOT the picture**. That "not-the-TV" region is
the whole effect. Each pass re-photographs the *entire* view — room, card chrome,
picture — and stuffs it inside the next rectangle, so the chrome nests. BACKDRAFT
re-photographed only the picture, onto everything.

Two independent lines of code caused it:

1. **The live input was added to EVERY pixel** — `vec3 additive = source + fb *
   uFeedback * effectScale;`. Whatever level structure the transform builds is
   overwritten by a full-strength flat copy of the input on the *next* pass,
   everywhere. The interior can never be "only the previous frame", which is the
   definition of a nest.
2. **The previous frame was defined everywhere** — `CLAMP_TO_EDGE` on both axes.
   Any tap that leaves the frame returns a smeared copy of the border pixel instead
   of *nothing*. So the image of one pass is the whole frame: no complement, no
   boundary curve to re-image, nothing to nest. The in-file comment even named the
   choice — "no black seam mid-frame" — which is exactly the seam a TV needs.

Crutchfield writes the missing line himself, in the model equation, p.235:

> "b corresponds to the zoom control. **If x′ = bRx lies outside of ℛ² then Iₙ(x′) = 0.**"

Dirichlet zero. We shipped clamp-to-edge. That one substitution is the difference
between a tunnel and a television.

**Why FLICKER couldn't fix it.** FLICKER v1/v2 modulate the *gain* of that plane
map. Gain acts on the range; nesting is a property of the domain. No gain schedule
can create a boundary that was never there.

**And a partial exoneration, because it explains the shape of the fix.** The right
map already existed in the file — `inRing ? source : fb * hallGain`, which *is*
`x ∈ S ? g·prev(A⁻¹x) : room(x)`. It was unreachable and defective three ways, and
the arithmetic is worth keeping because it is why the feature looked impossible:

- Gated on `hallAmt = smoothstep(0.70, 1.0, feedback/2)`. At the default
  `feedback: 0.85` → `fbNorm = 0.425 < 0.70` → **`hallAmt = 0`**. The residual
  additive term kept interior loop gain above 1 until **FEEDBACK = 1.9529** —
  contractive in the top **2.36 %** of the fader only. Below that it clips to white
  before a nest can form.
- `inRing` is only the band the affine *vacates*, so at **`zoom ≥ 1` the ring has
  exactly zero area** (verified: `zoom 1.0 / 1.2 / 1.6` with max offset all give
  `fbUv ⊆ [0,1]²`). The shipped VRT scene is `zoom: 1.15`. **Zoom-in — the LOOPBACK
  gesture the owner described — could never nest**; at max FEEDBACK it faded to
  black instead.
- No bezel. `S = A(Ω)` was welded to the affine, always concentric and frame-shaped,
  and adjacent levels had no contrast boundary, so they merged into smear.

**One thing in the brief is wrong, and it changed the design.** "Phosphor
persistence" is NOT the multi-frame memory. A colour-TV P22 phosphor's carry-over
across one 60 Hz frame is **4×10⁻⁷³ (blue) to 6×10⁻⁸ (red)** — sub-quantum.
Crutchfield, p.244: *"the phosphor's persistence is typically a single raster time
and so it can be neglected compared to the vidicon's storage time."* The real
integrator is the **camera's charge storage**, τ_s ≈ 10 frames ≈ 1/3 s. That is what
we build; it ships under the owner's word (`PHOSPHOR`) and the docs say what it
physically is.

---

## 1. THE MODEL

### 1.1 Coordinates

Work in **aspect-corrected centre-relative space** (the convention `shapeMask`
already uses) so a rolled TV stays rectangular instead of shearing:

```
q(uv) = (uv − 0.5) · (aspect, 1)          frame = [−a/2, a/2] × [−0.5, 0.5],  a = aspect
uv(q) = q / (aspect, 1) + 0.5
```

### 1.2 The bounded-screen map

**Forward** (previous camera frame → the TV inside the new camera frame):

```
T(q′) = c + s · R(φ) · q′        c = (offX·a, offY),   s = fill ∈ (0,1),   φ = rotate
S      = T(frame)                the screen: the frame rect scaled by s, rolled by φ, placed at c
```

**Inverse** (what the shader computes: output pixel → which previous-frame pixel):

```
p(uv) = R(−φ) · (q(uv) − c) / s          previous-frame A-space coordinate
tapUv = p / (a, 1) + 0.5                 the texture coordinate
d     = tvScreenSdf(p)                   signed distance, < 0 inside the picture
```

**Three regions, exhaustive and disjoint** (`tb` = bezel half-width, screen-local):

```
d < 0        → PICTURE :  g · prev(tapUv)                    the tube
0 ≤ d < tb   → BEZEL   :  room-lit dark plastic              the set's frame
d ≥ tb       → ROOM    :  the live input + ambient           everything else in shot
```

**The composite, per frame, per pixel:**

```
roomRgb(x) = R · ( src(x)·(1−A) + A )                    R = ROOM knob, A = TV_AMBIENT = 0.05
lift(x)    = GLASS · roomRgb(x) · (1 − gEff)             GLASS = 0.20  (faceplate reflection + raster floor)

tap(x)     = shoulder( prev_{n−d}(tapUv) · flick(x) )    flick ≤ 1 by construction (§1.6)
tint(x)    = C_chroma( tap(x) · rgb · luma · W )         W = TV_WHITE, C = the chroma operator
picture(x) = tint(x) · gEff + lift(x)

I_n(x)     = mix( region(x), I_{n−1}(x), ρ )             ρ = PHOSPHOR residual, in place, no transform
```

`I_{n−1}(x)` is read at the **same** `x` — untransformed. That is Crutchfield's
`L·(Iₙ)_τ` term (model (4), p.235), which BACKDRAFT had in no form at all, and it is
the whole of "phosphor".

**Boundary handling.** `d < 0 ⟹ tapUv ∈ [0,1]²` by construction: the rect SDF *is*
the `[0,1]²` test, and every other SHAPE is inscribed (`BACKDRAFT_SHAPE_RADIUS =
0.5` reaches the top/bottom frame edges and every polygon circumradius sits inside
it). So `CLAMP_TO_EDGE` is **not reached by the sample centre** and **no GL state
changes**.
*Precision, per review:* bilinear reads a 2×2 neighbourhood, so a fragment within
half a texel of the frame edge **does** touch the clamp — and it clamps to the
previous frame's edge texel, which is ROOM, i.e. the same value the correct
neighbour would have. Write the comment that way. Do **not** write "unreachable" as
a proof.

> **STILL OPEN.** The invariant also silently depends on `aspect ≥ 1` and on that
> 0.5 radius. **Make it an executable assertion, not a comment** — for all 5 shapes
> × `aspect ∈ {4/3, 16/9}` × `fill ∈ {0.35 … 0.95}` × `rotate ∈ {−30 … 30}` ×
> offset corners, `d < 0 ⟹ tapUv ∈ [0,1]²` — so a `BACKDRAFT_SHAPE_RADIUS` bump
> breaks loudly instead of silently re-opening the clamp path.

**Fixed point** (the vanishing point / accumulation point of the nest):
```
q* = (I − s·R(φ))⁻¹ c        φ = 0 ⟹  uv* = (0.5 + offX/(1−s),  0.5 + offY/(1−s))
```

### 1.3 Why this nests, and the old map could not

One pass places a copy of the **entire** previous frame — room, bezel, picture —
inside `S`. By induction the frame contains `S ⊋ T(S) ⊋ T²(S) ⊋ …`, each delimited
by its own bezel band. The nesting is forced by the geometry, not tuned. The old map
had `A(Ω) = Ω` (clamp makes `prev` total) and re-flooded `source` everywhere, so
neither condition held at any parameter setting.

The bezel is **not decoration**: it is the only high-contrast boundary between level
k and level k+1. Without it the nest is a smooth zoom. Every prior-art
implementation that nests has one.

### 1.4 Iterated feedback, not an analytic multi-tap

**Decision: iterated.** One contraction per frame, accumulated in the existing
31-slot ring. A shader that analytically composites N copies per frame is a *picture
of* a Droste: no dynamics, no per-level age, and therefore **no delay cascade at
all** — the other half of the request. Cost: **one extra texture fetch**, no extra
pass, no extra FBO, no extra VRAM.

**Correction to the supplied physics research, carried through:** the per-level age
is **k·d**, not `k(d+1)`. `backdraftTapIndex(head, d, N)` reads the frame written `d`
frames ago and `backdraftDelayFrames` clamps `d ≥ 1`, so `out_n(x∈S) =
g·out_{n−d}(Mx)` unrolls to level k `= out_{n−kd}`. At the default `delay: 16 ms`
(d = 1) level k is exactly k frames old. (Both reviewers independently confirmed
this against the design.)

| Cost | Magnitude | Note |
|---|---|---|
| Depth builds over time, 1 level per `d` frames | d=1 → depth 20 in 0.33 s; `delay = 500 ms` (d=30) → depth 10 takes **5 s** | the slow build *is* the rig |
| Compounded bilinear resample | ~11 crisp levels, then mush | analogue "rescan degradation"; supersampling is phase 3 |
| Parameter changes re-form the nest over `k·d` frames | 0.3–5 s | correct physical behaviour |

A multi-tap "prime the nest on frame 0" boot was considered and **rejected** —
0.33 s is not worth a second code path.

### 1.5 The stability contract — and the two live defects it fixes

Both reviewers found the same class of failure by different routes: the design's
original "the geometry is the limiter, no runaway is possible" claim was **false**,
because the per-pass operator is not `g` alone.

**Defect A.** The colour chain multiplies the tap *before* the clamped gain, and
`luma`/`chroma`/`r`/`g`/`b` all range `−1..+2`. Measured interior steady state with
`min(uTvGain, 0.95)` clamping `g` only:

```
LUMA 1.0  → 0.200 (ok)      LUMA 1.1 → 0.462 (ok)
LUMA 1.2  → 1.000 PINS WHITE — nest destroyed
R    1.3  → 1.000 PINS WHITE
```
**LUMA ≥ 1.18, or any single channel ≥ 1.18, deletes the feature.**

**Defect B.** `backdraftFlickerTerms` normalises the *geometric mean* of the
frame-mean gain to 1 — correct for an additive accumulator, wrong for a loop with no
source anchor. Its **per-row peak** is `gain·(1+rowDepth)`. Recomputed independently
and matching to 4 dp:

| FLICKER | rowDepth | **peak mult** | trough | beat | row phase across frame |
|---|---|---|---|---|---|
| 6 | 0.1335 | **1.1385** | 0.870 | 6 Hz | 18.0° |
| 24 | 0.0332 | **1.0335** | 0.967 | 24 Hz | 72.0° |
| 50 | 0.0752 | **1.0760** | 0.926 | 10 Hz | 150.0° |
| **60** | **0.7639** | **1.8830** | 0.252 | 0.06 Hz | 179.8° |
| **120** | **0.5374** | **1.5374** | 0.463 | 0.12 Hz | 359.6° |

At 60/120 the loop gain sits above 1 for ~8 s and ~4 s of every cycle and the nest
goes **flat** — every level inside k=2 within one 8-bit code of every other. The
saturating shoulder stops it going white; it does not stop it going uniform. This is
worse in PURE TV than in the legacy composite precisely because the source anchor is
gone from the interior.

**The unified fix — one CPU uniform, one shader `min`:**

```
opNorm  = max(|r|,|g|,|b|) · |luma| · max(W) · chromaNorm(chroma)        // CPU, a uniform
gEff(x) = min( FEEDBACK · effectScale(x),  TV_GAIN_MAX / max(opNorm, 1e-4) )
flick   = peak-normalised flicker multiplier  ≤ 1                        // §1.6
```
`chromaNorm(c) = ‖C_c‖∞` where `C_c v = luma(v)·1 + (v − luma(v)·1)·c` — closed
form, exact, CPU-side (1.000 for `c ∈ [0,1]`, 2.575 at `c = 2`, 2.150 at `c = −1`).

Because the shoulder is 1-Lipschitz and `flick ≤ 1`, the per-pass operator norm is
`opNorm · gEff ≤ TV_GAIN_MAX = 0.95 < 1`. Verified:

```
default                gv = [0.850 0.842 0.829]
LUMA 1.2               gv = [0.950 0.940 0.926]      was 1.020 → white
R    1.3               gv = [0.950 0.723 0.712]      hue tint preserved, contraction restored
LUMA 2, FEEDBACK 2     gv = [0.950 0.941 0.926]
FLICKER 60 (peak)      gv = [0.850 0.842 0.829]      was 1.789 → flat field
```

**Also required:** the saturating shoulder must be **always on inside S**, not gated
behind `uFlickerOn`. At the PURE TV default (`flicker: 0`) the loop's only limiter
would otherwise be a bare `clamp()` — the exact thing `backdraft.ts` warns about in
its own comment ("in a loop that saturation is the ONLY amplitude limiter, and a
bare clamp() is not it").

### 1.6 FLICKER in PURE TV is peak-normalised, and that is the physics

A pulsed emitter cannot emit more than 100 % of its drive; in a bounded loop the
correct normalisation is **peak at unity**, i.e. flicker is a pure duty-cycle
*attenuation*:

```
flick(x) = (uFlickerGain + uFlickerDepth·cos(uFlickerPhase + vUv.y·uFlickerRow)) / (uFlickerGain + uFlickerDepth)
```
(fold the divisor into the two uniforms on the CPU — zero shader cost). Peak = the
unmodulated nest, trough = a deeply attenuated one. The look survives; the
contraction survives. The 60 position becomes a slow 16.7 s swell between a full
nest and a 13 %-brightness one.

### 1.7 The brightness cascade — the lift MUST be room-proportional

`B_k = R·gᵏ + P·(1−gᵏ)`, plateau `P`. The original design used an **absolute** lift,
`P = LIFT/(1−g) = 0.20` regardless of the room. Measured on a full 2-D mirror:

```
absolute LIFT = 0.03:
room=1.00  B=[1.000 0.880 0.778 0.691 0.618 0.555]   monotone
room=0.30  B=[0.300 0.285 0.272 0.261 0.252 0.244]   steps < 2/255 — flat
room=0.20  B=[0.200 0.200 0.200 0.200 0.200 0.200]   PERFECTLY FLAT
room=0.05  B=[0.050 0.073 0.092 0.108 0.122 0.133]   INVERTED — brightens inward
```
With nothing patched (`TV_AMBIENT = 0.05`) the "self-demonstrating default" was a
nest that brightens inward to a flat grey core. **That is the smeared grey field
that had been shipping as the default appearance.**

**Fix — the lift is the faceplate reflecting the room, so it scales with the room:**
```
lift(x) = GLASS · roomRgb(x) · (1 − gEff)      ⟹   plateau P(x) = GLASS · roomRgb(x)
```
`roomRgb` is already computed for the ROOM branch — the lift is free, it varies
spatially (a real glass reflection), and `P ≤ 0.2·room` can never exceed the room.
Verified monotone at every room level:

```
room=1.00  P=0.200  B=[1.000 0.880 0.778 0.691 0.618 0.555 0.502]  min step 13.6 codes
room=0.50  P=0.100  B=[0.500 0.440 0.389 0.346 0.309 0.277 0.251]  min step  6.8 codes
room=0.30  P=0.060  B=[0.300 0.264 0.233 0.207 0.185 0.166 0.151]  min step  4.1 codes
room=0.15  P=0.030  B=[0.150 0.132 0.117 0.104 0.093 0.083 0.075]  min step  2.0 codes
```
At `room = 1` the numbers are **identical** to the original design's table, so the
intended milky-grey depth is unchanged — the fix costs nothing at the bright end and
removes the inversion at the dim end. It also makes the radial profile
**scale-invariant in room brightness**. The step falls below 2 codes at
`room < 0.125`; that is the honest floor.

(Note the published `1.000 / 0.880 / …` ladder above is the UNSHOULDERED one — see
the correction in §1.9.)

### 1.8 The phosphor cascade — the exact law

**One in-place, untransformed, unit-DC-gain one-pole per frame:**
```glsl
outTv = mix(outTv, texture(uPersist, uv).rgb, uTvPhos);     // = (1−ρ)·new + ρ·prev
```
Unit DC gain is a **stability requirement, not a nicety**: sup-norm loop gain
`(1−ρ)g + ρ < 1` for any `g<1`, any `ρ<1`. PHOSPHOR is therefore completely
decoupled from stability and from the steady state — the fixed point satisfies
`I* = (1−ρ)C(I*) + ρI* ⟹ I* = C(I*)`, i.e. **ρ changes only the temporal smear,
never the final image**. Had the two terms *added* (`ρ·prev + g·tap`), ρ = 0.9 with
FEEDBACK 0.85 would blow up instantly. **Do not implement it that way.**

Level k has been through the pole k times, so it carries the **k-fold convolution**
of `(1−ρ)ρᵐ` — the negative-binomial kernel `w_k(m) = C(m+k−1, k−1)(1−ρ)ᵏρᵐ`:

| property of level k | value |
|---|---|
| geometry | `Mᵏ` — size `sᵏ`, rotated by `k·φ` |
| brightness | `B_k = R·gᵏ + P(1−gᵏ)` |
| age from DELAY | `k·d` frames |
| extra mean lag from PHOSPHOR | `k·ρ/(1−ρ)` frames |
| temporal blur | `σ = √(k·ρ)/(1−ρ)` frames |
| colour | `Wᵏ` (white-point) and `(rgb·luma)ᵏ` |

**Deeper levels are older ∝ k and blurrier in time ∝ √k.** No per-level state.

Measured cascade in RGBA8 (step 0.20 → 0.90):
```
ρ=0.117  t90 = 1 frame     parks 0.5 codes short
ρ=0.450  t90 = 2 frames    parks 0.5 codes short
ρ=0.774  t90 = 8 frames    parks 1.5 codes short
ρ=0.900  t90 = 21 frames   parks 4.5 codes short
```
Visible cascade at every setting; the 8-bit stall is 2–5 codes and sits below the
room-proportional plateau at any usable room level.

> **STILL OPEN — Bayer dither, "phase 2".** A deterministic 4×4 Bayer dither on the
> TV write path (frame-index-rotated so `freeze`/DRS stay deterministic) unsticks
> that 2–5-code 8-bit decay tail at high PHOSPHOR. There is no `BAYER` or `dither`
> symbol in `backdraft.ts` — this was never built.

PHOSPHOR ladder (one-frame residuals from measured phosphor data — a colour TV
genuinely has **no** inter-frame tail, which is why 0 is the default and the honest
"TV" position):

| knob | ρ | tube | mean lag/level | frames to 1/255 |
|---|---|---|---|---|
| 0.00 | 0.000 | colour TV P22 — no inter-frame persistence exists | 0.00 | 0 |
| 0.13 | 0.117 | P4 mono TV (spec: *"not over 7 % of peak after 33 ms"*) | 0.13 | 2.6 |
| 0.16 | 0.147 | P1 scope green (willemite) | 0.17 | 3.0 |
| 0.50 | 0.450 | — | 0.82 | 6.9 |
| 0.86 | 0.774 | P39 radar / storage | 3.42 | 13.5 |
| 1.00 | 0.900 | P7 dual-layer radar | 9.00 | 52.6 |

### 1.9 Worked arithmetic at the DEFAULTS — proof they visibly nest

`s = 0.75, φ = 0, c = 0, tb = 0.048, g = 0.85, ρ = 0, room = 1`, aspect 4:3,
1024×768, 200 frames, RGBA8 round-trip:

```
k  picture edge (px)  bezel outer (px)  band width (px)  picture value  bezel value  contrast
0        384.0             411.6            27.65           0.810         0.045       18.0×
1        288.0             308.7            20.74           0.719         0.068       10.5×
2        216.0             231.6            15.55           0.641         0.088        7.3×
5         91.1              97.7             6.56           0.471         0.131        3.6×
10        21.6              23.2             1.56           0.320         0.170        1.9×
12        12.2              13.0             0.88           0.287         0.178        1.6×  ← sub-pixel
```
Centre-row band detection on the iterated 2-D sim: **15 dark bands**, measured radius
ratios `1.333 1.333 1.325 1.340 1.324 1.340 1.333 1.333 1.333` — exactly `1/s`.
**Float and RGBA8 produce identical band sets: 8-bit is not the limiter on the
geometry.**

Ceilings: `k_res = ln(2px/W)/ln(s) = 21.7`, `k_amp = ln(1/255)/ln(g) = 34.1`. The
bezel band drops under 1 px at k ≈ 12.

> **Call it ~11 resolved bands plus 3–4 merged ones, not "~15 distinct".** The card
> readout says "≈11 resolved".

⚠ **CORRECTION 2026-07-28 — the brightness ladder in §1.7 is the UNSHOULDERED one,
and §1.5 mandates a shoulder.** The published `1.000 / 0.880 / 0.778 / 0.691 /
0.618 / 0.555` is `gᵏ` with no saturating shoulder in the loop. With the always-on
shoulder, the real ladder is

```
1.000 / 0.739 / 0.629 / 0.559 / 0.505 / 0.459
```

**Both adversarial review passes missed this.** `backdraftTvLevelBrightness(k, g, P,
room, knee)` already models it correctly — the error was in the prose, not the code.
**The card readout, the docs and any test that quotes brightness must use the
SHOULDERED numbers.** (The geometry above — band count, radius ratios, the 1.333
measurement — is unaffected; the shoulder acts on the range, not the domain.)

### 1.10 What this map does NOT do — and the falsified attempt to make it

Frame-to-frame mean |Δ|, measured:
```
f0 = 2.96e-1   f3 = 3.24e-2   f10 = 1.94e-4   f20 = 1.73e-7   f40 = 4.85e-12   f80 = 0   f299 = 0
```
It converges to a **bit-exactly static image by frame ~80 and never moves again** —
including at `rotate = 30°`. This is Banach: `I = g·W·(I∘M) + lift` with
`‖g·W‖∞ < 1` has a unique globally attracting fixed point. **No limit cycles, no
travelling annuli, no nucleation, no bursts, no precession** — none of Crutchfield's
Plates 2–7.

Consequences, applied:
- **The "δ ≠ 0 → the pattern precesses" card readout is removed.** It describes a
  limit cycle this map does not have. What survives is the descriptive `n-fold
  rosette` label from `n = round(360/|φ|)`.

⛔ **FALSIFIED 2026-07-28, during the build. The obvious recipe for real dynamics —
raise the gain ceiling to Λ ≈ 1 and add Crutchfield's ~1 % noise floor — CANNOT
WORK, structurally, not by mistuning.**

Four mechanisms were built and swept in the CPU mirror (96 px, 1000 frames, 4×4-
blurred frame-to-frame correlation at lags 40/100, sampled early/mid/late):
(1) the raised gain ceiling, Λ 0.90–1.08; (2) an expanding spatial map `s·m > 1` —
Crutchfield's *own* bifurcation parameter; (3) lagged local gain droop (vidicon
charge depletion), κ 1–4; (4) off-diagonal colour coupling / per-pass hue rotation
(eq. 5). **Every one converges. With the noise floor OFF, every one converges
bit-exactly — `1 − corr = 0.00e+0` at every lag, at every late time.** With noise ON
they sit at 5e-8…7e-6, which *is* the noise floor — the "measuring noise, proves
nothing" trap.

**Root cause:** the always-on saturating shoulder is **1-Lipschitz**, and its
derivative at the elevated operating point falls below `1/Λ`, so the per-pass
operator remains a sup-norm contraction at its own fixed point *no matter how large
Λ is*. A positive monotone map on a spatially contracting domain has a unique
globally attracting fixed point. **§1.5 (always-on shoulder ⇒ recoverable white-out)
and "dynamics from raising the ceiling" are MUTUALLY EXCLUSIVE. No tuning
reconciles them.**

⚠ **One measurement looked alive and was not:** `fill 0.95 + 8-frame delay` gave
`1 − corr = 2e-2` at frames 200–300, decaying to `1.2e-5` by frame 600. That is the
nest still **BUILDING**, not evolving. **Any dynamics assertion must sample late
enough to tell those apart.**

**RESOLUTION — option B: a slow lagged global AGC servo off the frame mean.** It
blooms, the servo hauls it back, it blooms again — the breathing of a real
camera-at-TV rig, and it **preserves the white-out**, which is what the owner asked
to ride. **Rejected:** a non-monotone **folding** response (~5 shader lines,
physically a CRT beam-current limiter) — it does produce dynamics, but it *removes*
the white-out, folding to dark and boiling instead, which is a different instrument
from the one specified. Carry the *intent* of the Λ ∈ [0.95, 1.05] resolution
requirement across to the servo's time constant; the literal range belonged to the
falsified mechanism.

⚠ **And the CRITICAL assertion is unsound if written as "the frame is not static"** —
the ~1 % noise floor alone makes consecutive frames differ, so a static nest plus
noise passes it. Assert **evolving structure** (decaying frame-to-frame correlation,
a migrating band, the nucleating annulus) and negative-control it: with the noise on
but the gain back in the contraction regime, the CRITICAL assertion must go RED.

Edge-nucleation, for the record: the working hypothesis said structure nucleates at
the screen edge. In a centred zoom+rotate rig it nucleates at the **CENTRE** — the
map's fixed point / phase singularity (1984 Plates 2, 3, 5, 7 all say "center").
Edge nucleation is the *translation* regime — `OFFSET ≠ 0, zoom ≈ 1`, 1988 §VIII
"waterfall" — which BACKDRAFT's OFF X/Y already reach. Different mode; document,
don't design for it here.

---

## 2. GEOMETRY — the parts that are not just parameter plumbing

No new geometry parameter. ZOOM / ROTATE / OFF X / OFF Y are Crutchfield's Table I
one-for-one (`b`, camera roll, raster-centre offset).

**ZOOM direction, corrected** (the original prose had this backwards and it would
have landed in `docs.controls`): **higher ZOOM = the TV subtends MORE of the frame =
a DEEPER nest of thinner, lower-contrast rings** (`k_res` 5.9 at s = 0.35 → 21.7 at
0.75 → 74.8 at 0.95). Lower ZOOM = a chunky 4-level Droste with a big room.

**ROTATE is aspect-rigid in PURE TV.** The legacy path rotates in raw UV, so at 4:3
a rolled rectangle shears into a parallelogram — acceptable for a tunnel, wrong for
a TV. At `fill = 0.95, rotate = 30°` the rolled screen's half-diagonal is
`0.95·√((a/2)²+0.25) = 0.79` vs a frame half-width of `0.667` (4:3) — the screen
corners leave the frame and the room is clipped there. Correct behaviour (the camera
is closer than the set is wide), but the "12.5 % room margin on every side" claim
holds only at φ = 0.

**OFF X / OFF Y.** `c = (offX·a, offY)`, aspect-corrected. **No gain boost**: the
vanishing point sits at `c/(1−s)`, so at the default `s = 0.75` the full ±0.1 range
keeps `q*` on-screen (`0.4a` vs a half-width of `0.5a`). At high fill small offsets
push it off-frame — that is the open-flow/waterfall regime, and it is correct.

> **STILL OPEN — keystone / perspective tilt.** Not in either paper, and a
> perspective warp compounds into an unreadable smear within ~6 levels. Phase 3 at
> the earliest.

---

## 3. THE ROOM

**The room is the LIVE SOURCE at full strength, with an ambient floor. The live
source does NOT appear inside the screen.**

```glsl
vec3 roomRgb = uTvRoom * (srcRaw * (1.0 - TV_AMBIENT) + vec3(TV_AMBIENT));
```

1. **It is the only construction that nests.** Injecting the source inside `S` is
   defect (1) of §0 — it overwrites every level on every pass.
2. **Ambient light is load-bearing in the real rig**, not decorative — Crutchfield
   p.232: *"Some behavior is quite sensitive to, or will not appear at all if, there
   is any external source of light… a flashlight, candle, or a quick flip of the
   light switch, can be good light sources to get the system oscillating again if
   the screen goes dark."* 1988 §X maps basins using *constant* illumination. ROOM
   is that light switch and it deserves CV: a slow LFO on ROOM is Crutchfield's
   flashlight gesture.
3. `TV_AMBIENT = 0.05` is a range-preserving *lift* (`src(1−A)+A`, never exceeds 1),
   so an unpatched or black input still leaves a dim self-lit grey room — **PURE TV
   demonstrates its own geometry with nothing patched**, and with the §1.7 fix that
   demonstration is monotone rather than inverted.

Rejected: flat black (dead — nothing seeds the loop); a user room colour (MIX + an
upstream generator already do that); source both inside and outside (that is the old
bug).

**Document this loudly: in PURE TV your input is the ROOM, not the picture. The
picture is the feedback.**

**Bezel.** Band width `tb` in *screen-local* units, so a level-k bezel lands at
`tb·sᵏ` automatically — deeper bezels shrink because they are *images* of the real
one. Use the exact iq box SDF so the outer bezel corners round slightly, as a real
set does.

**Floor the BEZEL fader.** Measured: `bezel = 0` → **1 band** (the nest visually
disappears) versus 10 at the default. A fader whose minimum deletes the feature is a
bug — hence `BACKDRAFT_TV_BEZEL_MIN = 0.02`.

**Antialias the screen edge.** `uTvOn` is a uniform, so control flow inside the
branch is uniform and `fwidth` is legal. Without it, level 0's edge and bezel
stair-step at `rotate ≠ 0` and on the circle/pentagon/triangle/octagon screens — and
those jaggies then feed back into every deeper level.

---

## 4. FLICKER × PURE TV — the ring claim, downgraded

Because `backdraftFlickerTerms` evaluates at *absolute* simulation time while the
tap reads `d` frames back, level k carries the flicker phase from `t − k·d/60`.
Phase step per level `= 2π·f_beat·d/60`: at d=1 that is 6 Hz → 72°/level (ring every
5 levels), 24 Hz → 144° (2.5), 10 Hz → 60° (every 6 levels), 60/120 → ~0.4°/0.7°
(the whole nest breathes together over 16.7 s / 8.3 s).

**But do not promise "standing concentric rings".** The same product carries a
screen-fixed row gradient of **18° / 72° / 150° / 179.8° / 359.6°** across the frame
(measured, §1.5). At the 50 position the within-level row gradient (150°) **exceeds**
the inter-level step (60°), so the result is a diagonal interference texture over
rectangular annuli, not clean rings — and at 6/24/50 `rowDepth` is only
0.134/0.033/0.075, so the modulation is ±3–13 %, subtle rather than unmissable.
**Simulate before writing any ring claim into the card or docs.** The circular
ring/spiral in the LOOPBACK screenshot is almost certainly **resample moiré** about
the fixed point; PURE TV gets some of that free from the 1/s = 1.333× minification
but neither predicts nor tests it.

The gain + always-on shoulder apply **only to light from inside S** — the tube
emits; the room is ambient-lit and does not flicker. The band phase reads screen-
space `vUv.y` (the rolling shutter scans the sensor, not the scene), so the band
stays screen-fixed and correctly does **not** cross the bezel.

---

## 5. THE E1 INSTRUMENT — why the obvious autocorrelation gate did not work

Kept because it is an instrument-validation result, not a test listing.

E1-as-originally-specified **failed at the shipped default** (corr 0.474 vs a 0.50
gate) in a noise-free sim, and failed outright at low fill (48 samples × 0.02 covers
only 1.8 periods at s = 0.35). A second reviewer independently measured 0.484 and
traced it to the `gᵏ` trend surviving mean/σ normalisation. There is also a hidden
aspect hazard: a *circular annulus* profile over a *rectangular* nest carries a
second periodicity at `ln(aspect)`, which at 4:3 with s = 0.75 coincides with
`ln(1/s)` **exactly by arithmetic accident** and at other fills does not.

Corrected, and re-measured on a corrected profile model:
1. Sample the **horizontal centre ray** (and the vertical ray separately) out from
   the fixed point — not circular annuli. Kills the aspect hazard.
2. **Derive the step from the fill under test:** `Δ = ln(1/s) / 12`, `N = 96`. The
   expected lag is then **exactly 12 at every fill**, and the window always covers
   8 periods.
3. **Detrend** (least-squares remove the linear-in-j component) before
   autocorrelating.
4. **Define the failure mode:** the peak-finder returns `lag = −1` when there is no
   interior local maximum. Assert `lag > 0` explicitly; never compare a sentinel.

| s | 0.35 | 0.50 | 0.60 | **0.75** | 0.85 | 0.92 | 0.95 |
|---|---|---|---|---|---|---|---|
| lag (want 12) | 12 | 12 | 12 | **12** | 12 | 12 | 12 |
| corr | 0.551 | 0.815 | 0.816 | **0.821** | 0.822 | 0.823 | 0.552 |

Gate: `lag === 12 ± 1` and `corr ≥ 0.40`. Margin at the default is 0.42, not 0.016.

Two companion measurements worth keeping:
- **Band counting by absolute threshold is source-brightness dependent** — the
  original `< 0.4 × row median` scored 15 bands at source 0.80 but only **4** at
  source 0.30, and scored the `bezel = 1.0` maximum at 2 bands. Detect a band as a
  local minimum dipping ≥ 40 % below the mean of its two flanking local maxima.
- **The negative control must be non-degenerate.** At `tvMode: 0` with
  `zoom: 1, rotate: 0`, `hasTransform` is false → pure additive → a clipped
  near-binary step, on which the peak-finder is undefined and the assertion passes
  *by accident*. Use `zoom: 0.8` so the control exercises the real additive+clamp
  path PURE TV replaces. (Measured on the additive profile: `lag = −1` — no interior
  peak at all.)

**Renderer tolerance.** Every assertion is a ratio, count, or monotonicity over
large-scale geometry — never a pixel value, never a filtering-sensitive quantity.
The tap **minifies by 1/s = 1.333 with LINEAR and no mipmaps**, so each pass aliases
rather than blurs and SwiftShader/real-GPU divergence compounds over ~15 resamples.
**Add no pixel-value assertion at depth.**

---

## 6. THE M2 ADJUDICATION — why there is no VRT baseline, and what was paid instead

A reviewer offered (a) promote `VRT_SCENES.backdraft` to a real pinned baseline on
`main` first, or (b) claim only "structurally unchanged" and drop the word
"byte-identical", which is not provable here.

**We took (b).** Taking (a) means unmasking an animated feedback module whose tap
minifies with `LINEAR` and no mipmaps over ~15 compounded resamples — the same
divergence the reviewer's own analysis flags. The cost/flake-risk was not justified
by the gate it buys.

**And we paid for it with E5:** render the shipped `VRT_SCENES.backdraft` params at
`tvMode: 0` and `freeze: 1`, then assert **4-quadrant mean luminance** against
literals captured on `main` before the change, tolerance **±2/255**.
Renderer-tolerant, deterministic, and it does catch gross OFF-path drift, which is
the realistic failure. Plus diff discipline: the *only* edits to existing lines are
the two `uTvOn` guards, one `vec3 srcRaw = source;` capture, and new declarations.
The PR description says "structurally unchanged, gated by E5" and never
"byte-identical".

Related, and the reason the OFF path costs nothing: gate the two expensive legacy
computations on the uniform —
```glsl
vec3 fb = (uHasFb > 0.5 && uTvOn < 0.5) ? texture(uFb, fbUv).rgb : vec3(0.0);
if (uFlickerOn > 0.5 && uTvOn < 0.5) { … legacy flicker + shoulder … }
```
With that, **ON costs the same 5 texture fetches and 1 `exp` as OFF does** (the TV
branch's own `uFb` and `uPersist` taps replace the legacy `uFb` tap, and its
shoulder replaces the legacy one), plus ~35 ALU. Without it, ON is 7 fetches +
2 `exp`, and `exp` is not free on SwiftShader.

---

## 7. STILL OPEN

**Polish, on request:**
1. **Deterministic 4×4 Bayer dither** on the TV write path (frame-index-rotated so
   `freeze`/DRS stay deterministic) — unsticks the 2–5-code 8-bit decay tail at high
   PHOSPHOR. §1.8. Not built.
2. **Off-diagonal colour matrix `L̄`** (Crutchfield eq. 5, p.236: *"their
   off-diagonal elements the coupling of the color signals"*) → monotone hue
   precession with depth. One `mat3`, no new state. ⚠ Note this was mechanism (4) in
   the falsified dynamics sweep of §1.10 — it is a *look* feature, not a route to
   dynamics.
3. **Two-pole / power-law phosphor tail** ("the ghost that won't quite go") via 4
   ring taps at `head−1,−2,−4,−8` — zero new state, the ring already holds them.
4. **Hoist the legacy composite into an `else`** if profiling shows the two `uTvOn`
   guards are not enough.

**Research, on request only:**
- **`CAMERA RES`** — quantise the tap → Crutchfield's finite-resolution moiré. This
  is the phase-3 home for the "quantising the tap" idea that PIXELATE deliberately
  does *not* do (PIXELATE affects the source, i.e. the room, only). Renderer-risky.
- **Small barrel curvature** (`k₁ ≈ 0.02–0.04` **only** — it compounds k times, so
  single-pass CRT-shader values are 5–10× too strong here).
- **Radial convergence error.**
- **Supersampled loop** — the digital "rescan with a high-resolution camera"; the
  fix for the ~11-level resample ceiling.
- **An explicit ANNULUS shape** for the 1988 periodic-boundary experiment: *"imposing
  annular boundary conditions… leads to a nearly one-dimensional channel with
  periodic boundary conditions"* (1988 p.774).
- **Scanlines, if ever, go outside the loop, applied once in screen space, off by
  default** — inside the recursion they alias into resolution-dependent moiré and
  are a VRT/SwiftShader flake risk.

Plus the §1.2 executable boundary invariant, still a comment rather than an
assertion.

---

## APPENDIX — files

`packages/web/src/lib/video/modules/backdraft.ts` (`FRAG_SRC`, `shapeMask`,
`feedbackUv`, the source crossfade, flicker+shoulder, the colour chain, the additive
and hall branches, `backdraftFlickerTerms`, the def + params, the ring alloc, the
texture clamp, `draw()`, the head advance — **line numbers deliberately omitted; the
module was re-laid-out twice after this was written**) ·
`packages/web/src/lib/ui/modules/BackdraftCard.svelte` ·
`packages/web/src/lib/video/engine.ts` (`createFboImpl`, RGBA8/LINEAR/CLAMP, `null`
upload ⇒ zero-initialised cold start) ·
`packages/web/src/lib/video/toybox-feedback.ts` (`tunnelTap`, `simulateTunnel` — the
CPU-mirror precedent) · `packages/web/src/lib/video/cv-scale-registry.test.ts` ·
`packages/web/src/lib/docs/strict-docs.ts` ·
`packages/web/src/lib/docs/contract-lock.txt` · `e2e/vrt/vrt-scenes.ts` ·
`e2e/vrt/vrt-exemptions.ts` · `e2e/tests/per-module-per-port-behavioral.spec.ts`
(backdraft is whole-module exempt there — the animated-video variance-floor class —
which is why the bespoke spec is not optional) · `scripts/webgl-attest-lib.ts`.
