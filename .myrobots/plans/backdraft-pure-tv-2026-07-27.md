# BACKDRAFT — PURE TV (Crutchfield bounded-screen mode)

**Date:** 2026-07-27 · **Status:** design, corrected after two adversarial reviews · **Repo state:** read-only pass, nothing modified.

**Owner's request (verbatim, load-bearing):**
> "backdraft still not doing crutchfield thing. lets try another gate for a 'pure tv' mode. see how loopback goes recursive when we zoom in out it? this is what we want for a crutchfield / pure tv mode for backdraft. the tv has a frame and each recursing image is shown only inside the boundaries of the interior box. we want to simulate actual crutchfield space/time simulation and the only way this works is if each loop iteration completely constrains the visual field of the suceeding iterations. what we want in this mode is an exact simulation of pointing a camera at a tv screen showing the image that camera sees, and we want delay to cascade through it by simulating phosphor."

Primary sources: Crutchfield, *Space-time dynamics in video feedback*, **Physica D 10 (1984) 229–245**; Crutchfield, *Spatio-Temporal Complexity in Nonlinear Image Processing*, **IEEE TCAS 35(7) (1988) 770–780**. Extracted full text in the session scratchpad (`crutchfield.txt`, `crutchfield1988.txt`, `vasulka.txt`). Prior lineage: `.myrobots/plans/backdraft-flicker-research-2026-07-26.md` (FLICKER v1/v2 — orthogonal, keep).

Target: `packages/web/src/lib/video/modules/backdraft.ts`, `packages/web/src/lib/ui/modules/BackdraftCard.svelte`, `packages/web/src/lib/video/modules/backdraft.test.ts`, new `e2e/tests/backdraft-pure-tv.spec.ts`, `packages/web/src/lib/video/cv-scale-registry.test.ts`, `packages/web/src/lib/docs/contract-lock.txt`.

Every taste call is marked **[TASTE]**. Everything else is derived, verified against the source, or quoted.

---

## 0. WHAT WE GOT WRONG

**BACKDRAFT has never had a screen. It has a plane.** Look at your LOOPBACK screenshot: the thing that makes it read as a Droste is not the shrinking — it is that **outside each rectangle there is something that is NOT the picture**. The page around the card. The rack background. That "not-the-TV" region is the whole effect. Each pass re-photographs the *entire* view — room, card chrome, and picture — and stuffs it inside the next rectangle, so the chrome nests. BACKDRAFT re-photographs only the picture, and re-photographs it onto everything.

Two independent lines of code cause it, both confirmed against the file:

1. **`backdraft.ts:628` — the live input is added to EVERY pixel.**
   ```glsl
   vec3 additive = source + fb * uFeedback * effectScale;
   ```
   Whatever level structure the transform builds is overwritten by a full-strength flat copy of the input on the *next* pass, everywhere. The interior can never be "only the previous frame", which is the definition of a nest.

2. **`backdraft.ts:1559-1560` — the previous frame is defined everywhere.**
   ```glsl
   gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
   gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
   ```
   Any tap that leaves the frame returns a smeared copy of the border pixel instead of *nothing*. So the image of one pass is the whole frame. There is no complement, no boundary curve to re-image, nothing to nest. The comment at `:566-568` even names the choice — "no black seam mid-frame" — which is exactly the seam a TV needs.

Crutchfield writes the missing line himself, in the model equation, p.235:

> "b corresponds to the zoom control. **If x′ = bRx lies outside of ℛ² then Iₙ(x′) = 0.**"

Dirichlet zero. We shipped clamp-to-edge. That one substitution is the difference between a tunnel and a television.

**Why FLICKER couldn't fix it.** FLICKER v1/v2 modulate the *gain* of that plane map. Gain acts on the range; nesting is a property of the domain. No gain schedule can create a boundary that was never there. The v1/v2 work is correct and stays — it is orthogonal, and §5 shows it composes.

**And a partial exoneration, because it matters for the fix.** The right map already exists in the file, at `:654-659`:
```glsl
bool inRing = fbUv.x < 0.0 || fbUv.x > 1.0 || fbUv.y < 0.0 || fbUv.y > 1.0;
vec3 hall = inRing ? source : fb * hallGain;
```
That *is* `x ∈ S ? g·prev(A⁻¹x) : room(x)`. It is unreachable and defective three ways:
- Gated on `hallAmt = smoothstep(0.70, 1.0, feedback/2)` (`:649`). At the default `feedback: 0.85` → `fbNorm = 0.425 < BACKDRAFT_HALL_LO = 0.70` → **`hallAmt = 0`**. The residual additive term keeps interior loop gain above 1 until **FEEDBACK = 1.9529** — contractive in the top **2.36 %** of the fader only. Below that it clips to white before a nest can form.
- `inRing` is only the band the affine *vacates*, so at **`zoom ≥ 1` the ring has exactly zero area** (verified: `zoom 1.0 / 1.2 / 1.6` with max offset all give `fbUv ⊆ [0,1]²`). The shipped VRT scene is `zoom: 1.15`. **Zoom-in — the LOOPBACK gesture you described — can never nest today**; at max FEEDBACK it fades to black instead.
- No bezel. `S = A(Ω)` is welded to the affine, always concentric and frame-shaped, and adjacent levels have no contrast boundary, so they merge into smear.

PURE TV takes that branch, makes it unconditional, gives it a real screen rectangle with a bezel, puts the live input **outside** it, and adds the one term the module has never had: an in-place temporal integrator.

**One thing in the brief is wrong, and it changes the design.** "Phosphor persistence" is not the multi-frame memory. A colour-TV P22 phosphor's carry-over across one 60 Hz frame is 4×10⁻⁷³ (blue) to 6×10⁻⁸ (red) — sub-quantum. Crutchfield, p.244: *"the phosphor's persistence is typically a single raster time and so it can be neglected compared to the vidicon's storage time."* The real integrator is the **camera's charge storage**, τ_s ≈ 10 frames ≈ 1/3 s. We build that, we ship it under your word (`PHOSPHOR`), and the docs say what it physically is. The tube-type ladder in §4 is calibrated from real phosphor data so the long-persistence positions (P39 radar, P7) are honest too.

**And one thing to hear before you look at it.** With a screen boundary and a per-pass gain below 1, the map is a strict contraction — Banach — so it converges to a **static** nest and stays there (measured: bit-exactly still by frame ~80, at any rotation). The *time* you get is the transient: motion in the room cascades inward one level per DELAY, smeared by PHOSPHOR. That is literally "delay cascading through it". What you do **not** get is Crutchfield's self-generated travelling annuli and bursts — those live at loop gain ≈ 1, which is the unstable side. §8 offers that as an explicit **CRITICAL** sub-mode; §9 asks you whether you want it.

---

## 1. THE MODEL

### 1.1 Coordinates

Work in **aspect-corrected centre-relative space** — the convention `shapeMask` already uses (`backdraft.ts:488`) — so a rolled TV stays rectangular instead of shearing:

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

**Three regions, exhaustive and disjoint** (`tb` = bezel half-width in screen-local units):

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

`I_{n−1}(x)` is read at the **same** `x` — untransformed. That is Crutchfield's `L·(Iₙ)_τ` term (model (4), p.235), which BACKDRAFT does not have in any form today, and it is the whole of "phosphor".

**Boundary handling.** `d < 0 ⟹ tapUv ∈ [0,1]²` by construction: the rect SDF *is* the `[0,1]²` test, and every other SHAPE is inscribed (`BACKDRAFT_SHAPE_RADIUS = 0.5`, `:301`, reaches the top/bottom frame edges and every polygon circumradius sits inside it). So `CLAMP_TO_EDGE` is **not reached by the sample centre** and **no GL state changes** — every other mode keeps its documented clamp behaviour.
*Precision, per review:* bilinear reads a 2×2 neighbourhood, so a fragment within half a texel of the frame edge **does** touch the clamp — and it clamps to the previous frame's edge texel, which is ROOM, i.e. the same value the correct neighbour would have. Write the comment that way. Do **not** write "unreachable" as a proof. The invariant also silently depends on `aspect ≥ 1` and on that 0.5 radius — make it an executable assertion (§6, N-INV), not a comment, so a radius bump cannot silently re-open the clamp path.

**Fixed point** (the vanishing point / accumulation point of the nest):
```
q* = (I − s·R(φ))⁻¹ c        φ = 0 ⟹  uv* = (0.5 + offX/(1−s),  0.5 + offY/(1−s))
```

### 1.3 Why this nests, and today's map cannot

One pass places a copy of the **entire** previous frame — room, bezel, picture — inside `S`. By induction the frame contains `S ⊋ T(S) ⊋ T²(S) ⊋ …`, each delimited by its own bezel band. The nesting is forced by the geometry, not tuned. Today's map has `A(Ω) = Ω` (clamp makes `prev` total) and re-floods `source` everywhere, so neither condition holds at any parameter setting.

The bezel is **not decoration**: it is the only high-contrast boundary between level k and level k+1. Without it the nest is a smooth zoom. Every prior-art implementation that nests has one (alexjball/video-feedback draws a `[1.1,1.1,1]`-scaled border mesh *behind* the portal).

### 1.4 Iterated feedback, not an analytic multi-tap — and the bill

**Decision: iterated.** One contraction per frame, accumulated in the existing 31-slot ring.

- You asked for "an exact simulation of pointing a camera at a tv screen". A shader that analytically composites N copies per frame is a *picture of* a Droste: no dynamics, no per-level age, and therefore **no delay cascade at all** — the other half of the request.
- Everything wanted falls out of iteration: level k is `k·d` frames old, carries k applications of the phosphor pole, `W^k` of the white-point error, `g^k` of the gain.
- Cost: **one extra texture fetch**, no extra pass, no extra FBO, no extra VRAM.

**Correction to the supplied physics research, carried through:** the per-level age is **k·d**, not `k(d+1)`. `backdraftTapIndex(head, d, N)` reads the frame written `d` frames ago and `backdraftDelayFrames` already clamps `d ≥ 1`, so `out_n(x∈S) = g·out_{n−d}(Mx)` unrolls to level k `= out_{n−kd}`. At the default `delay: 16 ms` (d = 1) level k is exactly k frames old. This propagates into the FLICKER phase table (§5): 50 Hz at d=1 is **60°/level**, not 120°.

What iteration costs, stated plainly:

| Cost | Magnitude | Note |
|---|---|---|
| Depth builds over time, 1 level per `d` frames | d=1 → depth 20 in 0.33 s; `delay = 500 ms` (d=30) → depth 10 takes **5 s** | the slow build *is* the rig |
| Compounded bilinear resample | ~11 crisp levels, then mush | analogue "rescan degradation"; supersampling is phase 3 |
| Parameter changes re-form the nest over `k·d` frames | 0.3–5 s | correct physical behaviour |

A multi-tap "prime the nest on frame 0" boot was considered and **rejected** — 0.33 s is not worth a second code path.

### 1.5 The stability contract — provable, and it fixes two live defects

Both reviewers found the same class of failure by different routes: the design's original "the geometry is the limiter, no runaway is possible" claim was **false**, because the per-pass operator is not `g` alone.

**Defect A (reviewer 1).** The colour chain multiplies the tap *before* the clamped gain, and `luma`/`chroma`/`r`/`g`/`b` all range `−1..+2` (`backdraft.ts:1389+`). Measured interior steady state with `min(uTvGain, 0.95)` clamping `g` only:

```
LUMA 1.0  → 0.200 (ok)      LUMA 1.1 → 0.462 (ok)
LUMA 1.2  → 1.000 PINS WHITE — nest destroyed
R    1.3  → 1.000 PINS WHITE
```
**LUMA ≥ 1.18, or any single channel ≥ 1.18, deletes the feature.**

**Defect B (reviewer 2).** `backdraftFlickerTerms` normalises the *geometric mean* of the frame-mean gain to 1 — correct for an additive accumulator, wrong for a loop with no source anchor. Its **per-row peak** is `gain·(1+rowDepth)`. Recomputed independently and matching to 4 dp:

| FLICKER | rowDepth | **peak mult** | trough | beat | row phase across frame |
|---|---|---|---|---|---|
| 6 | 0.1335 | **1.1385** | 0.870 | 6 Hz | 18.0° |
| 24 | 0.0332 | **1.0335** | 0.967 | 24 Hz | 72.0° |
| 50 | 0.0752 | **1.0760** | 0.926 | 10 Hz | 150.0° |
| **60** | **0.7639** | **1.8830** | 0.252 | 0.06 Hz | 179.8° |
| **120** | **0.5374** | **1.5374** | 0.463 | 0.12 Hz | 359.6° |

At 60/120 the loop gain sits above 1 for ~8 s and ~4 s of every cycle and the nest goes **flat** — every level inside k=2 within one 8-bit code of every other. The saturating shoulder stops it going white; it does not stop it going uniform. This is worse in PURE TV than today precisely because we removed the source anchor from the interior.

**The unified fix — one CPU uniform, one shader `min`:**

```
opNorm  = max(|r|,|g|,|b|) · |luma| · max(W) · chromaNorm(chroma)        // CPU, a uniform
gEff(x) = min( FEEDBACK · effectScale(x),  TV_GAIN_MAX / max(opNorm, 1e-4) )
flick   = peak-normalised flicker multiplier  ≤ 1                        // §1.6
```
`chromaNorm(c) = ‖C_c‖∞` where `C_c v = luma(v)·1 + (v − luma(v)·1)·c`, i.e. `max_i Σ_j |(1−c)w_j + c δ_ij|` with the shader's luma weights. Closed form, exact, CPU-side (it is 1.000 for `c ∈ [0,1]`, 2.575 at `c = 2`, 2.150 at `c = −1`).

Because the shoulder is 1-Lipschitz and `flick ≤ 1`, the per-pass operator norm is `opNorm · gEff ≤ TV_GAIN_MAX = 0.95 < 1`. **Contraction is guaranteed for every reachable parameter combination.** Verified:

```
default                gv = [0.850 0.842 0.829]
LUMA 1.2               gv = [0.950 0.940 0.926]      was 1.020 → white
R    1.3               gv = [0.950 0.723 0.712]      hue tint preserved, contraction restored
LUMA 2, FEEDBACK 2     gv = [0.950 0.941 0.926]
FLICKER 60 (peak)      gv = [0.850 0.842 0.829]      was 1.789 → flat field
```

**Also required:** the saturating shoulder must be **always on inside S**, not gated behind `uFlickerOn`. At the PURE TV default (`flicker: 0`) the loop's only limiter would otherwise be a bare `clamp()` — the exact thing `backdraft.ts:390` warns about in its own comment ("in a loop that saturation is the ONLY amplitude limiter, and a bare clamp() is not it").

### 1.6 FLICKER in PURE TV is peak-normalised, and that is the physics

The existing operating-point normaliser exists to hold an *additive accumulator's* mean gain at unity. A pulsed emitter cannot emit more than 100 % of its drive; in a bounded loop the correct normalisation is **peak at unity**, i.e. flicker is a pure duty-cycle *attenuation*:

```
flick(x) = (uFlickerGain + uFlickerDepth·cos(uFlickerPhase + vUv.y·uFlickerRow)) / (uFlickerGain + uFlickerDepth)
```
(fold the divisor into the two uniforms on the CPU — zero shader cost). Peak = the unmodulated nest, trough = a deeply attenuated one. The look survives; the contraction survives. The 60 position becomes a slow 16.7 s swell between a full nest and a 13 %-brightness one.

### 1.7 The brightness cascade — and the lift that must be room-proportional

`B_k = R·gᵏ + P·(1−gᵏ)`, plateau `P`. The original design used an **absolute** lift, `P = LIFT/(1−g) = 0.20` regardless of the room. Reviewer 2 measured the consequence on a full 2-D mirror, and it is the failure mode you have been fighting:

```
absolute LIFT = 0.03:
room=1.00  B=[1.000 0.880 0.778 0.691 0.618 0.555]   monotone
room=0.30  B=[0.300 0.285 0.272 0.261 0.252 0.244]   steps < 2/255 — flat
room=0.20  B=[0.200 0.200 0.200 0.200 0.200 0.200]   PERFECTLY FLAT
room=0.05  B=[0.050 0.073 0.092 0.108 0.122 0.133]   INVERTED — brightens inward
```
With nothing patched (`TV_AMBIENT = 0.05`) the "self-demonstrating default" was a nest that brightens inward to a flat grey core. That is the smeared grey field, shipped as the default appearance.

**Fix — the lift is the faceplate reflecting the room, so it scales with the room:**
```
lift(x) = GLASS · roomRgb(x) · (1 − gEff)      ⟹   plateau P(x) = GLASS · roomRgb(x)
```
`GLASS = 0.20` **[TASTE]**. `roomRgb` is already computed for the ROOM branch — the lift is free, it varies spatially (a real glass reflection), and `P ≤ 0.2·room` can never exceed the room. Verified monotone at every room level:

```
room=1.00  P=0.200  B=[1.000 0.880 0.778 0.691 0.618 0.555 0.502]  min step 13.6 codes
room=0.50  P=0.100  B=[0.500 0.440 0.389 0.346 0.309 0.277 0.251]  min step  6.8 codes
room=0.30  P=0.060  B=[0.300 0.264 0.233 0.207 0.185 0.166 0.151]  min step  4.1 codes
room=0.15  P=0.030  B=[0.150 0.132 0.117 0.104 0.093 0.083 0.075]  min step  2.0 codes
```
At `room = 1` the numbers are **identical** to the original design's published table (0.03/(1−0.85) = 0.20), so the intended milky-grey depth is unchanged — the fix costs nothing at the bright end and removes the inversion at the dim end. It also makes the whole radial profile **scale-invariant in room brightness**, which is why the e2e's log-radial assertion (§6) reads the same at room 1.0 and 0.35.
The step falls below 2 codes at `room < 0.125`; that is the honest floor and it is where the e2e precondition comes from.

Taste-call #4 from the original design (`LIFT = P·(1−g)` with P constant) does **not** fix this — it pins the plateau independent of room, so the inversion just moves.

### 1.8 The phosphor cascade — the exact law

**One in-place, untransformed, unit-DC-gain one-pole per frame:**
```glsl
outTv = mix(outTv, texture(uPersist, uv).rgb, uTvPhos);     // = (1−ρ)·new + ρ·prev
```
Unit DC gain is a **stability requirement, not a nicety**: sup-norm loop gain `(1−ρ)g + ρ < 1` for any `g<1`, any `ρ<1`. PHOSPHOR is therefore completely decoupled from stability and from the steady state — the fixed point satisfies `I* = (1−ρ)C(I*) + ρI* ⟹ I* = C(I*)`, i.e. **ρ changes only the temporal smear, never the final image**. Had the two terms *added* (`ρ·prev + g·tap`), ρ = 0.9 with FEEDBACK 0.85 would blow up instantly. Do not implement it that way.

Level k has been through the pole k times, so it carries the **k-fold convolution** of `(1−ρ)ρᵐ` — the negative-binomial kernel `w_k(m) = C(m+k−1, k−1)(1−ρ)ᵏρᵐ`:

| property of level k | value |
|---|---|
| geometry | `Mᵏ` — size `sᵏ`, rotated by `k·φ` |
| brightness | `B_k = R·gᵏ + P(1−gᵏ)` |
| age from DELAY | `k·d` frames |
| extra mean lag from PHOSPHOR | `k·ρ/(1−ρ)` frames |
| temporal blur | `σ = √(k·ρ)/(1−ρ)` frames |
| colour | `Wᵏ` (white-point) and `(rgb·luma)ᵏ` (the existing knobs) |

**Deeper levels are older ∝ k and blurrier in time ∝ √k.** No per-level state: one pole per frame and the k-fold convolution emerges from the iteration.

Measured cascade in RGBA8 (step 0.20 → 0.90):
```
ρ=0.117  t90 = 1 frame     parks 0.5 codes short
ρ=0.450  t90 = 2 frames    parks 0.5 codes short
ρ=0.774  t90 = 8 frames    parks 1.5 codes short
ρ=0.900  t90 = 21 frames   parks 4.5 codes short
```
Visible cascade at every setting; the 8-bit stall is 2–5 codes and sits below the room-proportional plateau at any usable room level. Bayer dither is a defensible **phase 2**.

### 1.9 Worked arithmetic at the DEFAULTS — proof they visibly nest

`s = 0.75, φ = 0, c = 0, tb = 0.048, g = 0.85, ρ = 0, room = 1`, aspect 4:3, 1024×768, 200 frames, RGBA8 round-trip. Reviewer-1's full 2-D mirror:

```
k  picture edge (px)  bezel outer (px)  band width (px)  picture value  bezel value  contrast
0        384.0             411.6            27.65           0.810         0.045       18.0×
1        288.0             308.7            20.74           0.719         0.068       10.5×
2        216.0             231.6            15.55           0.641         0.088        7.3×
5         91.1              97.7             6.56           0.471         0.131        3.6×
10        21.6              23.2             1.56           0.320         0.170        1.9×
12        12.2              13.0             0.88           0.287         0.178        1.6×  ← sub-pixel
```
Centre-row band detection on the iterated 2-D sim: **15 dark bands**, measured radius ratios `1.333 1.333 1.325 1.340 1.324 1.340 1.333 1.333 1.333` — exactly `1/s`. Float and RGBA8 produce **identical** band sets: 8-bit is not the limiter on the geometry.

Ceilings: `k_res = ln(2px/W)/ln(s) = 21.7`, `k_amp = ln(1/255)/ln(g) = 34.1`. The bezel band drops under 1 px at k ≈ 12.

> **Call it ~11 resolved bands plus 3–4 merged ones, not "~15 distinct".** The card readout must say "≈11 resolved".

**What you will see:** a rectangular dark-framed TV centred in the frame at 75 % of it, the live input visible as the room around it. Inside the TV, that entire view at 3/4 scale; inside that, another; ~11 nested dark frames converging on centre, each dimmer than the last, the innermost flattening onto a 20 %-of-room milky core. Wave a hand in front of the camera and it sweeps inward one level per frame.

⚠ **CORRECTION 2026-07-28 — the brightness ladder above is the UNSHOULDERED one, and §1.5 mandates a
shoulder.** The published `1.000 / 0.880 / 0.778 / 0.691 / 0.618 / 0.555` is `gᵏ` with no saturating
shoulder in the loop. With the always-on shoulder §1.5 requires, the real ladder is

```
1.000 / 0.739 / 0.629 / 0.559 / 0.505 / 0.459
```

**Both adversarial review passes missed this.** `backdraftTvLevelBrightness(k, g, P, room, knee)` already
models it correctly — the error is in this prose, not the code. **The card readout, the docs and any test
that quotes brightness must use the SHOULDERED numbers.** (The geometry above — band count, radius ratios,
the 1.333 measurement — is unaffected; the shoulder acts on the range, not the domain.)

### 1.10 What this map does NOT do — stated up front

Frame-to-frame mean |Δ|, measured:
```
f0 = 2.96e-1   f3 = 3.24e-2   f10 = 1.94e-4   f20 = 1.73e-7   f40 = 4.85e-12   f80 = 0   f299 = 0
```
It converges to a **bit-exactly static image by frame ~80 and never moves again** — including at `rotate = 30°`. This is Banach: `I = g·W·(I∘M) + lift` with `‖g·W‖∞ < 1` has a unique globally attracting fixed point. **No limit cycles, no travelling annuli, no nucleation, no bursts, no precession** — none of Crutchfield's Plates 2–7.

Consequences, applied:
- **The "δ ≠ 0 → the pattern precesses" card readout is removed.** It describes a limit cycle this map does not have. What survives is the descriptive `n-fold rosette` label from `n = round(360/|φ|)`.
- The rotate range is `±30°`, so every symmetry lock Crutchfield actually photographs (n = 3/4/5/9 at 120°/90°/72°/40°, 1988 photos 27–31) is **out of range**; the reachable locks (n ≥ 12) are by his own Arnold-tongue statement the *narrowest* windows. → **owner question Q2**.
- ~~The path to real dynamics is known and cheap: raise the gain ceiling to ≈1.02–1.05 (`Λ ≈ 1`), keep the always-on shoulder, add Crutchfield's ~1 % noise floor (Appendix A: *"a signal to noise ratio of about 40 db… about 1 % fluctuation"*). That is **CRITICAL mode**, §8 phase 3, **owner question Q1**.~~

  ⛔ **FALSIFIED 2026-07-28, during the build. This recipe cannot work, structurally — not by mistuning.**
  Four mechanisms were built and swept in the CPU mirror (96 px, 1000 frames, 4×4-blurred frame-to-frame
  correlation at lags 40/100, sampled early/mid/late): (1) the raised gain ceiling above, Λ 0.90–1.08;
  (2) an expanding spatial map `s·m > 1` — Crutchfield's *own* bifurcation parameter; (3) lagged local gain
  droop (vidicon charge depletion), κ 1–4; (4) off-diagonal colour coupling / per-pass hue rotation
  (eq. 5). **Every one converges. With the noise floor OFF, every one converges bit-exactly — `1 − corr =
  0.00e+0` at every lag, at every late time.** With noise ON they sit at 5e-8…7e-6, which *is* the noise
  floor — the "measuring noise, proves nothing" trap.

  **Root cause:** the always-on saturating shoulder is **1-Lipschitz**, and its derivative at the elevated
  operating point falls below `1/Λ`, so the per-pass operator remains a sup-norm contraction at its own
  fixed point *no matter how large Λ is*. A positive monotone map on a spatially contracting domain has a
  unique globally attracting fixed point. **§1.5 (always-on shoulder ⇒ recoverable white-out) and this
  bullet (dynamics from raising the ceiling) are MUTUALLY EXCLUSIVE.** No tuning reconciles them.

  ⚠ One measurement looked alive and was not: fill 0.95 + 8-frame delay gave `1 − corr = 2e-2` at frames
  200–300, decaying to 1.2e-5 by frame 600. That is the nest still **BUILDING**, not evolving. Any
  dynamics assertion must sample late enough to tell those apart.

  **RESOLUTION (2026-07-28): option B — a slow lagged global AGC servo off the frame mean.** It blooms, the
  servo hauls it back, it blooms again — the breathing of a real camera-at-TV rig, and it **preserves the
  white-out**, which is what the owner asked to ride. Rejected: a non-monotone **folding** response (~5
  shader lines, physically a CRT beam-current limiter) — it does produce dynamics, but it *removes* the
  white-out, folding to dark and boiling instead, which is a different instrument from the one specified.
  Carry the *intent* of the Λ ∈ [0.95, 1.05] resolution requirement across to the servo's time constant;
  the literal range belonged to the falsified mechanism.

Edge-nucleation, for the record: the working hypothesis said structure nucleates at the screen edge. In a centred zoom+rotate rig it nucleates at the **CENTRE** — the map's fixed point / phase singularity (1984 Plates 2, 3, 5, 7 all say "center"). Edge nucleation is the *translation* regime — `OFFSET ≠ 0, zoom ≈ 1`, 1988 §VIII "waterfall" — which BACKDRAFT's OFF X/Y already reach. Different mode; document, don't design for it here.

---

## 2. GEOMETRY: PARAMETER MAPPING

No new geometry parameter. ZOOM / ROTATE / OFF X / OFF Y are Crutchfield's Table I one-for-one (`b`, camera roll, raster-centre offset). What changes in PURE TV is ZOOM's *mapping*, ROTATE becoming aspect-rigid, and offsets read in A-space.

### 2.1 ZOOM → screen fill

ZOOM defaults to 1.0; reusing it raw means "the TV fills the frame" — no room, no nest, a degenerate default. PURE TV reads it through one pure, monotone, unit-tested remap:

```ts
export function backdraftTvFill(zoom: number): number {
  const z = clamp(zoom, BACKDRAFT_ZOOM_MIN, BACKDRAFT_ZOOM_MAX);   // 0.4 .. 1.6
  return z <= 1
    ? 0.35 + ((z - 0.4) / 0.6) * (0.75 - 0.35)
    : 0.75 + ((z - 1.0) / 0.6) * (0.95 - 0.75);
}
```

| zoom | 0.4 | 0.6 | 0.8 | **1.0** | 1.2 | 1.45 | 1.6 |
|---|---|---|---|---|---|---|---|
| fill s | 0.350 | 0.483 | 0.617 | **0.750** | 0.817 | 0.900 | 0.950 |

**Direction, corrected** (the original prose had this backwards and it would have landed in `docs.controls`): **higher ZOOM = the TV subtends MORE of the frame = a DEEPER nest of thinner, lower-contrast rings** (`k_res` 5.9 at s = 0.35 → 21.7 at 0.75 → 74.8 at 0.95). Lower ZOOM = a chunky 4-level Droste with a big room.

### 2.2 ROTATE — aspect-rigid

Today the rotation is applied in raw UV (`:515-517`), so at 4:3 a rolled rectangle shears into a parallelogram. Acceptable for a tunnel, wrong for a TV: PURE TV rotates in A-space, so the screen stays rectangular at every angle. **Range unchanged** (`±30°`) unless the owner answers Q2 — widening remaps every existing patch's CV response on `rotate`.

Card readout (hash-free, card-side):
```ts
export function backdraftRotationLock(deg: number): { n: number } {
  return { n: Math.abs(deg) < 1e-6 ? 0 : Math.round(360 / Math.abs(deg)) };
}
```
Display `12-fold rosette`. **No δ / precession claim** (§1.10).

At `fill = 0.95, rotate = 30°` the rolled screen's half-diagonal is `0.95·√((a/2)²+0.25) = 0.79` vs a frame half-width of `0.667` (4:3) — the screen corners leave the frame and the room is clipped there. Correct behaviour (the camera is closer than the set is wide), but the "12.5 % room margin on every side" claim holds only at φ = 0.

### 2.3 OFF X / OFF Y

`c = (offX·a, offY)` — same relative meaning as today (0.1 = 10 % of frame width), aspect-corrected. **No gain boost**: the vanishing point sits at `c/(1−s)`, so at the default `s = 0.75` the full ±0.1 range keeps `q*` on-screen (`0.4a` vs a half-width of `0.5a`). At high fill small offsets push it off-frame — that is the open-flow/waterfall regime, and it is correct.

### 2.4 Out of scope

Keystone / perspective tilt: not in either paper, and a perspective warp compounds into an unreadable smear within ~6 levels. Phase 3 at the earliest.

---

## 3. THE ROOM

**The room is the LIVE SOURCE at full strength, with an ambient floor. The live source does NOT appear inside the screen.**

```glsl
vec3 roomRgb = uTvRoom * (srcRaw * (1.0 - TV_AMBIENT) + vec3(TV_AMBIENT));
```

1. **It is the only construction that nests.** Injecting the source inside `S` is defect (1) of §0 — it overwrites every level on every pass.
2. **It is what your screenshot is.** LOOPBACK captures the tab; the tab shows the capture inside a card; the rest of the page is the room. Same equation, different geometry.
3. **Ambient light is load-bearing in the real rig**, not decorative — Crutchfield p.232: *"Some behavior is quite sensitive to, or will not appear at all if, there is any external source of light… a flashlight, candle, or a quick flip of the light switch, can be good light sources to get the system oscillating again if the screen goes dark."* 1988 §X maps basins using *constant* illumination. ROOM is that light switch and it deserves CV: a slow LFO on ROOM is Crutchfield's flashlight gesture.
4. `TV_AMBIENT = 0.05` is a range-preserving *lift* (`src(1−A)+A`, never exceeds 1), so an unpatched or black input still leaves a dim self-lit grey room — **PURE TV demonstrates its own geometry with nothing patched**, and with the §1.7 fix that demonstration is now monotone rather than inverted.

Rejected: flat black (dead — nothing seeds the loop); a user room colour (MIX + an upstream generator already do that); source both inside and outside (that is today's bug).

**Document this loudly, in `docs.explanation`, the card tooltip, and the PR body: in PURE TV your input is the ROOM, not the picture. The picture is the feedback.**

**Bezel.** `TV_BEZEL_RGB = vec3(0.045)` **[TASTE]**, multiplied by `uTvRoom` so a dark room darkens the set. Band width `tb` in *screen-local* units, so a level-k bezel lands at `tb·sᵏ` automatically — deeper bezels shrink because they are *images* of the real one. Use the exact iq box SDF (`length(max(e,0)) + min(max(e.x,e.y),0)`) so the outer bezel corners round slightly, as a real set does.

**Floor the BEZEL fader.** Reviewer 1 measured `bezel = 0` → **1 band** (the nest visually disappears) versus 10 at the default. A fader whose minimum deletes the feature is a bug:
```ts
tb = BACKDRAFT_TV_BEZEL_MIN + (BACKDRAFT_TV_BEZEL_MAX - BACKDRAFT_TV_BEZEL_MIN) * bezel;   // 0.02 .. 0.12
```

**Antialias the screen edge.** `uTvOn` is a uniform, so control flow inside the branch is uniform and `fwidth` is legal (this is exactly what `shapeMask` does at `:503-504`). Without it, level 0's edge and bezel stair-step at `rotate ≠ 0` and on the circle/pentagon/triangle/octagon screens — and those jaggies then feed back into every deeper level. Two lines:
```glsl
float aa = max(fwidth(d), 1e-4);
float inScreen = 1.0 - smoothstep(-aa, aa, d);
float inSet    = 1.0 - smoothstep(uTvBezel - aa, uTvBezel + aa, d);
outTv = mix(mix(roomRgb, bezelRgb, inSet), pictureRgb, inScreen);
```

---

## 4. THE PARAMETER SET

### 4.1 New params — 5 (2 hidden synthetics)

| id | label | range | curve | default | CV | meaning |
|---|---|---|---|---|---|---|
| `tvMode` | `Pure TV` | 0..1 | linear | **0** | via gate | the mode gate. Card button; `tv_gate` rising edge toggles |
| `tvGate` | `TV Gate` | 0..1 | linear | 0 | (synthetic) | hidden raw gate the bridge writes; no card knob |
| `room` | `Room` | 0..1 | linear | **1.0** | ✅ `room` | ambient/room-light level outside the screen |
| `bezel` | `Bezel` | 0..1 | linear | **0.4** | ✖ | screen-frame width, `tb = 0.02 + 0.10·bezel` (screen-local) |
| `phosphor` | `Phos` | 0..1 | linear | **0** | ✅ `phosphor` | one-frame residual `ρ = 0.90·p`, per-channel tinted |

`tvMode` / `phosphor` default to the **exact-zero no-op** — the established `uPixelate` / `uFlickerOn` load-bearing-gate idiom in this file.

### 4.2 New ports — 3

```ts
{ id: 'tv_gate',  type: 'cv', paramTarget: 'tvGate' },                              // raw, edge-detected → TOGGLE
{ id: 'room',     type: 'cv', paramTarget: 'room',     cvScale: { mode: 'linear' } },
{ id: 'phosphor', type: 'cv', paramTarget: 'phosphor', cvScale: { mode: 'linear' } },
```
`tv_gate` follows `mirror_x_gate` / `shape_gate` exactly (`detectEdge` → flip, per-instance `EdgeState`, bridge writes only while patched). **All three land in phase 1 deliberately** — adding a port later costs another contract-lock re-pin *and* another GPU re-attest.

### 4.3 Constants

```ts
export const BACKDRAFT_TV_FILL_MIN      = 0.35;
export const BACKDRAFT_TV_FILL_DEFAULT  = 0.75;   // at ZOOM = 1.0
export const BACKDRAFT_TV_FILL_MAX      = 0.95;
export const BACKDRAFT_TV_GAIN_MAX      = 0.95;   // operator-norm ceiling → guaranteed contraction
export const BACKDRAFT_TV_GLASS         = 0.20;   // faceplate reflection: plateau = GLASS × local room
export const BACKDRAFT_TV_AMBIENT       = 0.05;   // room-light floor (range-preserving lift)
export const BACKDRAFT_TV_BEZEL_MIN     = 0.02;   // floored: bezel=0 must not delete the nest
export const BACKDRAFT_TV_BEZEL_MAX     = 0.12;   // screen-local units
export const BACKDRAFT_TV_BEZEL_RGB     = [0.045, 0.045, 0.045] as const;
export const BACKDRAFT_TV_WHITE         = [1.0, 0.99, 0.975] as const;   // camera-vs-tube white point
export const BACKDRAFT_TV_PHOSPHOR_MAX  = 0.90;
export const BACKDRAFT_TV_PHOSPHOR_RGB  = [1.0, 0.94, 0.88] as const;    // red slowest
```

PHOSPHOR ladder for the card tooltip (one-frame residuals from measured phosphor data — a colour TV genuinely has **no** inter-frame tail, which is why 0 is the default and the honest "TV" position):

| knob | ρ | tube | mean lag/level | frames to 1/255 |
|---|---|---|---|---|
| 0.00 | 0.000 | colour TV P22 — no inter-frame persistence exists | 0.00 | 0 |
| 0.13 | 0.117 | P4 mono TV (spec: *"not over 7 % of peak after 33 ms"*) | 0.13 | 2.6 |
| 0.16 | 0.147 | P1 scope green (willemite) | 0.17 | 3.0 |
| 0.50 | 0.450 | — | 0.82 | 6.9 |
| 0.86 | 0.774 | P39 radar / storage | 3.42 | 13.5 |
| 1.00 | 0.900 | P7 dual-layer radar | 9.00 | 52.6 |

### 4.4 Uniforms

```glsl
uniform float uTvOn;         // 0 = off (identity), 1 = pure TV
uniform float uTvFill;       // s  = backdraftTvFill(zoom)
uniform float uTvBezel;      // tb
uniform float uTvRoom;       // ROOM 0..1
uniform float uTvGain;       // FEEDBACK (raw; the norm clamp is applied in-shader with effectScale)
uniform float uTvOpNorm;     // max|rgb| · |luma| · max(W) · chromaNorm(chroma)   ≥ 1e-4
uniform vec3  uTvPhos;       // per-channel one-frame residual (0,0,0 = off)
uniform sampler2D uPersist;  // ring[head-1]  → TEXTURE5
uniform float uHasPersist;
```
`uFlickerGain` / `uFlickerDepth` are pre-divided by their peak on the CPU when `tvMode = 1` (§1.6), so the shader is unchanged there.

### 4.5 Cost, stated plainly

- **contract-lock: 8 lines** (3 `in`, 5 `param`) in `packages/web/src/lib/docs/contract-lock.txt` around `:165-218`. Re-pin with `flox activate -- task docs:accept`, then **review the diff**.
- **WebGL attest: one unavoidable re-attest.** `resolveWebglBasis()` (`scripts/webgl-attest-lib.ts:226-233`) walks all of `packages/web/src/lib/video/` excluding `*.test.ts`, fail-closed — `backdraft.ts` is in the basis, so any shader/def/constant edit flips `computeWebglHash`. Run `env WEBGL_ATTEST_ALLOW_BUSY=1 flox activate -- task webgl:attest` on a trusted real GPU. Two known blockers from memory: 2 `cameraInput` tests currently fail and block a local re-attest; and the attest **reuses a stale dev server** unless 4173 is killed and `node_modules/.vite` cleared — **never touch 5173** (owner's dev server).
- **`BackdraftCard.svelte` is NOT in the basis** (rule (2) only admits cards matching `WEBGL_CONTEXT_RE`; the card uses `getContext('2d')` at `:307`). All card work is **hash-free** — put as much there as possible.
- **Docs are hash-transparent**: all new prose goes **inside** the existing `// docs-hash-ignore:start … :end` markers (`:1436` / `:1497`).
- **`cv-scale-registry.test.ts` must be edited** — see §7 M1. This was missed in the first draft.

Nine params were considered and rejected as constants or duplicates of existing knobs: screen X/Y (= OFF X/Y), screen size (= ZOOM), bezel colour, ambient floor, glass fraction, white point, gain ceiling, phosphor tint, rotation snap.

---

## 5. INTERACTION TABLE

**Contract:** `tvMode = 0` is **structurally unchanged** — the TV branch is appended at the end of `main()` and overwrites `outc`; no existing statement's math is edited. (The word "byte-identical" is deliberately **not** used — see §7 M2 for why it is not provable here and what we assert instead.)

| feature | in PURE TV | why |
|---|---|---|
| **MIX** | unchanged | picks which input is the room |
| **FEEDBACK** | **narrows**: the iris / per-pass screen gain, entering the §1.5 operator-norm clamp. Fader range **unchanged** (narrowing it would remap CV + MIDI-learn for the same stored value); the card shows the effective `g` as text | the bounded map is a contraction — no runaway, no AGC servo |
| **DELAY / DELAY CLK** | unchanged; reinterpreted as loop latency. Level k is `k·d` frames old | orthogonal to PHOSPHOR (§1.8) |
| **LUMA / CHROMA / R / G / B** | unchanged in *meaning*, but now folded into `uTvOpNorm` so they cannot break the contraction. Non-unity values compound as `k`-th powers → hue precession per nesting level, free | Crutchfield's `L̄` diagonal: "the electronics between camera and monitor" |
| **LIGHTEN / DARKEN** | unchanged; `effectScale` multiplies the gain *inside* the norm clamp. **Honest limits:** LIGHTEN only has 0.85→0.95 of headroom before the clamp bites (nearly inert at the default), and DARKEN at full leaves the glass plateau `0.20·room`, so it dims rather than blanks | do not describe these as "blank a region" |
| **PIXELATE** | unchanged — source only, i.e. **the room only** | quantising the tap would give Crutchfield's finite-resolution moiré but is renderer-dependent aliasing → phase 3 `CAMERA RES` |
| **ZOOM** | remapped to screen fill (§2.1). Higher zoom = deeper, thinner nest | |
| **ROTATE** | aspect-rigid; card shows `n-fold rosette` (no precession claim) | |
| **OFF X / OFF Y** | place the TV in the field of view, aspect-corrected | |
| **MIRROR X / Y** | unchanged (applied to `vUv` first, so the whole scene including the TV folds) | physically a mirror in front of the lens. `mirrorUv` is idempotent, so the persistence tap may read either coordinate |
| **SHAPE** | **sharpens**: selects the SCREEN's shape (rect TV / round CRT / pentagon / triangle / octagon); the bezel follows its SDF | the 1988 boundary-condition experiment as a knob. The circle is the annular-mask setup: *"imposing annular boundary conditions… leads to a nearly one-dimensional channel with periodic boundary conditions"* (1988 p.774) |
| **PURE GEO** | **ignored** in PURE TV **[TASTE]** | SHAPE means exactly one thing in TV mode |
| **FLICKER** | **kept and peak-normalised** (§1.6). The gain + always-on shoulder apply **only to light from inside S** — the tube emits; the room is ambient-lit and does not flicker. The band phase still reads screen-space `vUv.y` (the rolling shutter scans the sensor, not the scene), so the band stays screen-fixed and correctly does **not** cross the bezel | without the peak normalisation, positions 60/120 flatten the nest for 8 s / 4 s of every cycle (§1.5 Defect B) |
| **FREEZE** | unchanged (`draw()` early-return) | |

**FLICKER × PURE TV — claim downgraded, per review.** Because `backdraftFlickerTerms` evaluates at *absolute* simulation time (`:1231`) while the tap reads `d` frames back, level k carries the flicker phase from `t − k·d/60`. Phase step per level `= 2π·f_beat·d/60`: at d=1 that is 6 Hz → 72°/level (ring every 5 levels), 24 Hz → 144° (2.5), 10 Hz → 60° (**every 6 levels**), 60/120 → ~0.4°/0.7° (the whole nest breathes together over 16.7 s / 8.3 s).

**But do not promise "standing concentric rings".** The same product carries a screen-fixed row gradient of **18° / 72° / 150° / 179.8° / 359.6°** across the frame (measured, §1.5). At the 50 position the within-level row gradient (150°) exceeds the inter-level step (60°), so the result is a diagonal interference texture over rectangular annuli, not clean rings — and at 6/24/50 `rowDepth` is only 0.134/0.033/0.075, so the modulation is ±3–13 %, subtle rather than unmissable. Simulate before writing any ring claim into the card or docs. The circular ring/spiral in the LOOPBACK screenshot is almost certainly **resample moiré** about the fixed point; PURE TV gets some of that free from the 1/s = 1.333× minification but neither predicts nor tests it.

---

## 6. THE PROOF PLAN

Load-bearing insight: **the nest is provable in a pure CPU simulation**, and `toybox-feedback.ts` already ships that pattern (`tunnelTap` `:216`, `simulateTunnel` `:237`). Everything geometric goes in the fast, deterministic, GL-free `unit` lane; the e2e proves only "the GPU really renders it".

### 6.1 New pure exports (the test surface)

```ts
export function backdraftTvFill(zoom: number): number;
export function backdraftTvChromaNorm(chroma: number): number;          // ‖C‖∞, exact
export function backdraftTvOpNorm(p: { r; g; b; luma; chroma }): number;
export function backdraftTvGain(opNorm, feedback, effectScale): number; // the clamped gEff
export function backdraftTvFlickerMult(flicker, timeSec, v): number;    // peak-normalised, ≤ 1
export function backdraftTvPhosphorRgb(p: number): [number, number, number];
export function backdraftTvTap(u, v, o): { tapU; tapV; d; region: 'screen'|'bezel'|'room' };
export function backdraftTvComposite(args): [number, number, number];   // one pixel, exact
export function simulateBackdraftTv(o): { frame: Float32Array; size: number };
export function backdraftTvLevelBrightness(k, gain, plateau): number;
export function backdraftTvDepth(fill, gain, widthPx): { resolution; contrast; resolved };
export function backdraftRotationLock(deg: number): { n: number };
```
`simulateBackdraftTv` mirrors the shader exactly: bilinear sampling, a ring of `d+1` past frames, the explicit three-region boundary, the one-pole persistence, optional RGBA8 quantisation. Size 128 resolves 5–6 levels at s = 0.75.

### 6.2 Unit assertions (vitest, `backdraft.test.ts`) — where NESTING is proven

**N1 — geometric series (headline).** Static bright room, defaults, 120 frames. Walk the centre row out from the fixed point, collect dark-bezel band centres. Assert `r_{k+1}/r_k ∈ [s−0.02, s+0.02]` for k = 0..4 and `r_0 ≈ s·a/2` within one cell. (Both the edge radii *and* the band widths are geometric with ratio s.)

**N2 — the self-similarity identity (strongest single test).** At the fixed point, for every `x` strictly inside S:
```
out(x)  ==  gEff · W · out(M x) + GLASS · roomRgb(x) · (1 − gEff)
```
Assert on 500 pseudo-random interior points (excluding a 3-cell band around each bezel and the innermost 4 levels), tolerance 0.02/channel. **This is your sentence — "each loop iteration completely constrains the visual field of the succeeding iterations" — as an executable assertion.** It fails on today's shader at every parameter setting.

**N3 — no clamp-smear.** Two sims whose previous-frame contents differ arbitrarily but whose room is identical: every pixel with `region === 'room'` must be **bit-identical** between them. Today's `CLAMP_TO_EDGE` path fails this by construction.

**N4 — brightness gradient, ACROSS ROOM LEVELS.** Annulus means strictly decreasing in k and matching `backdraftTvLevelBrightness` within 3 %, run at `room ∈ {1.0, 0.5, 0.3, 0.15}` and with a black source. (The original design tested only the bright case, which is exactly why the inversion of §1.7 survived to review.)

**N5 — phosphor cascade.** Step the room 0.2 → 0.9 at frame T; the frame at which each level's annulus reaches 90 % of its final value must be monotone in k with `t90(k) − t90(k−1) ≈ d + ρ/(1−ρ)` within 1.5 frames. Also: `ρ = 0` reproduces the no-persistence run exactly, and the **converged image is ρ-independent** (unit DC gain).

**N6 — rigid rotation.** `aspect = 4/3, φ = 25°`: the four mapped screen corners form a rectangle (opposite sides equal, diagonals equal) to 1e-6. Fails if the rotation is done in raw UV space.

**N7 — the CONTRACTION CONTRACT (new, and the fix for both stability defects).** Sweep the full reachable product:
`luma ∈ {−1, 0, 1, 1.2, 2} × r,g,b ∈ {−1, 1, 1.3, 2} × chroma ∈ {−1, 0, 1, 2} × feedback ∈ {0, 0.85, 2} × effectScale ∈ {0, 1, MAX} × flicker ∈ {0..5} × v ∈ {0, 0.5, 1}`.
Assert (a) `opNorm · gEff ≤ BACKDRAFT_TV_GAIN_MAX + 1e-6` always; (b) `flickerMult ≤ 1 + 1e-6` always; (c) after 300 frames with room ≡ 1 the pre-clamp interior maximum never exceeds 0.98 and never pins; (d) at the six FLICKER positions the level-brightness gradient stays strictly decreasing (this is the assertion that catches the flat-field failure).

**N8 — the NEGATIVE CONTROL, required.** Same harness at `tvMode = 0` (additive path via `backdraftHallComposite`): N1 finds < 2 bands and N2's residual exceeds 0.2. Without it, N1/N2 could be passing on the harness rather than on the feature (`flaky-tests-can-be-unsound` discipline).

**N-INV — the boundary invariant, as an assertion not a comment.** For all 5 shapes × `aspect ∈ {4/3, 16/9}` × `fill ∈ {0.35 … 0.95}` × `rotate ∈ {−30 … 30}` × `offset` corners: `d < 0 ⟹ tapUv ∈ [0,1]²`. This is the load-bearing reason no GL state changes; a `BACKDRAFT_SHAPE_RADIUS` bump must break it loudly.

**N9 — OFF path.** (a) every existing `backdraftHallComposite` / `backdraftFeedbackUv` / `shapeMask` test passes **unchanged**; (b) a pinned golden of 32 hand-listed `(source, fb, fbUv, feedback, effectScale, hasTransform) → RGB` literals. **State honestly what (b) does and does not do:** it pins a TypeScript function and therefore *cannot* catch shader drift. The shader-side OFF gate is E5 (§6.3) plus diff discipline.

**N10 — contract.** New params/ports exist with the documented ids, ranges, curves, defaults, `cvScale`; `tvMode` / `phosphor` default to the exact-zero no-op.

### 6.3 E2E (`e2e/tests/backdraft-pure-tv.spec.ts`) — proves the GPU renders it

Graph: a large bright source → `backdraft` → `videoOut`. Params `{ tvMode: 1, feedback: 0.85, delay: 16, room: 1, bezel: 0.4, phosphor: 0, zoom: 1, rotate: 0, flicker: 0 }`.

**Convergence, not wall-clock.** `await page.waitForTimeout(800)` is wall-clock; `__videoEngineFreezeTime` pins the simulation clock but not the rAF rate, so nest depth on CI would be `fps × 0.8`. Poll a frame counter (or the engine's frame-count test hook) until `frames ≥ 60`, then set `freeze = 1` and read the canvas. Fail with a clear message if the count is not reached in 5 s.

**PRECONDITION (derived, not guessed).** Mean luminance of the room annulus (radius 0.42–0.48 of frame height) must be **≥ 0.35**. Derivation: with the room-proportional plateau, the k-th step is `(R−P)(1−g)gᵏ = 0.0626·R` at k = 4, so `R ≥ 0.125` is the hard floor for E3's 2/255; 0.35 gives ≥ 4.5 codes at k=4 and ≥ 14 at k=0, plus margin for 8-bit and SwiftShader. **Measure the chosen source and confirm it clears 0.35 before committing the spec** — the `{ shape: 0, zoom: 1.6 }` circle-on-black preset used by `backdraft.spec.ts` probably does not.

**E1 — log-radial autocorrelation, on RAYS, with a fill-derived step (primary).**
Reviewer 1 measured E1-as-originally-specified **failing at the shipped default** (corr 0.474 vs a 0.50 gate) in a noise-free sim, and failing outright at low fill (48 samples × 0.02 covers only 1.8 periods at s = 0.35). Reviewer 2 independently measured 0.484 and traced it to the `gᵏ` trend surviving mean/σ normalisation. There is also a hidden aspect hazard: a *circular annulus* profile over a *rectangular* nest carries a second periodicity at `ln(aspect)`, which at 4:3 with s = 0.75 coincides with `ln(1/s)` **exactly by arithmetic accident** and at other fills does not.

Corrected, and re-measured on a corrected profile model:
1. Sample the **horizontal centre ray** (and the vertical ray separately) out from the fixed point — not circular annuli. Kills the aspect hazard.
2. **Derive the step from the fill under test:** `Δ = ln(1/s) / 12`, `N = 96`. The expected lag is then **exactly 12 at every fill**, and the window always covers 8 periods.
3. **Detrend** (least-squares remove the linear-in-j component) before autocorrelating.
4. **Define the failure mode:** the peak-finder returns `lag = −1` when there is no interior local maximum. Assert `lag > 0` explicitly; never compare a sentinel.

Measured on the corrected profile (detrended, ray, adaptive Δ):

| s | 0.35 | 0.50 | 0.60 | **0.75** | 0.85 | 0.92 | 0.95 |
|---|---|---|---|---|---|---|---|
| lag (want 12) | 12 | 12 | 12 | **12** | 12 | 12 | 12 |
| corr | 0.551 | 0.815 | 0.816 | **0.821** | 0.822 | 0.823 | 0.552 |

Gate: `lag === 12 ± 1` and `corr ≥ 0.40`. Margin at the default is 0.42, not 0.016.

**E2 — bezel band count (secondary), by LOCAL contrast.** The original `< 0.4 × row median` threshold is source-brightness dependent: measured 15 bands at source 0.80 but only **4** at source 0.30 (which still passed the old 0.15 precondition), and it scored the `bezel = 1.0` maximum at 2 bands. Replace with: a band is a local minimum dipping ≥ 40 % below the mean of its two flanking local maxima. Assert **≥ 5** along the centre row's right half. At the defaults there are 10–15 with a large margin.

**E3 — brightness monotone.** Annulus means for k = 0..4 strictly decreasing, each step ≥ 2/255.

**E4 — NEGATIVE CONTROL, required and non-degenerate.** Same patch at `tvMode: 0` **with `zoom: 0.8`** (the original `zoom: 1, rotate: 0` makes `hasTransform` false → pure additive → a clipped near-binary step, on which the peak-finder is undefined and the assertion passes by accident). With a transform it exercises the real additive+clamp path PURE TV replaces. Assert E1 returns `lag === −1` **or** `corr < 0.35`, and E2 finds < 2 bands. (Measured on the additive profile: `lag = −1` — no interior peak at all.)

**E5 — OFF-path drift gate (replaces the unprovable "byte-identical" claim).** Render the shipped `VRT_SCENES.backdraft` params with `tvMode: 0` and `freeze: 1`, then assert 4-quadrant mean luminance against literals **captured on `main` before the change**, tolerance ±2/255. Renderer-tolerant, deterministic, and it does catch gross OFF-path drift. See §7 M2 for why this rather than a VRT baseline.

**Renderer tolerance.** Every assertion is a ratio, count, or monotonicity over large-scale geometry — never a pixel value, never a filtering-sensitive quantity. Note the tap **minifies by 1/s = 1.333 with LINEAR and no mipmaps** (`engine.ts:2159-2173`), so each pass aliases rather than blurs; SwiftShader/real-GPU divergence compounds over ~15 resamples. **Add no pixel-value assertion at depth.**

### 6.4 Flake protocol (mandatory before the MR)

```sh
REPEAT=3 flox activate -- task test:one -- backdraft
flox activate -- task e2e:serve
REPEAT=3 flox activate -- task e2e:one -- backdraft-pure-tv
flox activate -- npx --workspace e2e playwright test per-module-per-port --grep backdraft
flox activate -- task typecheck && flox activate -- task docs:check
flox activate -- task e2e:stop
```
`backdraft` is **fully enrolled** in `per-module-per-port.spec.ts` (no exemption there), so the three new ports create new handle/emit rows that must be run locally. It **is** whole-module exempt from `per-module-per-port-behavioral.spec.ts` (`:426`, animated-video variance-floor class) — which is exactly why the bespoke spec is not optional. **Look at E1's actual correlation number on each run**, not just green/red.

### 6.5 CI wall-time

+1 e2e spec (~15–25 s including spawn and the convergence poll) and ~12 new unit tests (< 1 s). **Well under the ~2 min sign-off bar.**

GPU cost, corrected (reviewer 2's M4 — the original accounting was internally inconsistent and understated). Gate the two expensive legacy computations on the uniform, which is a two-token edit to existing lines and provably a no-op at `tvMode = 0`:
```glsl
vec3 fb = (uHasFb > 0.5 && uTvOn < 0.5) ? texture(uFb, fbUv).rgb : vec3(0.0);
if (uFlickerOn > 0.5 && uTvOn < 0.5) { … legacy flicker + shoulder … }
```
With that, **ON costs the same 5 texture fetches and 1 `exp` as OFF does today** (the TV branch's own `uFb` tap and `uPersist` tap replace the legacy `uFb` tap, and its shoulder replaces the legacy one), plus ~35 ALU. Without it, ON is 7 fetches + 2 `exp`, and `exp` is not free on SwiftShader. No new passes, no new FBOs, no VRAM change.

---

## 7. REVIEW ADJUDICATION — what changed and why

Both reviewers returned **NEEDS-REVISION**. Where they overlap, the fixes compose; where they differ, the call is recorded here.

| finding | who | verdict | applied |
|---|---|---|---|
| Colour chain unclamped → LUMA 1.2 pins white | R1 | **accepted** | §1.5 operator-norm clamp |
| FLICKER peak > 1 → flat nest at 60/120 | R2 | **accepted** | §1.6 peak normalisation; both are the same defect class and are fixed by one uniform + one `min` |
| Shoulder gated behind `uFlickerOn` → bare `clamp()` is the only limiter at the TV default | R1 | **accepted** | always-on inside S |
| Absolute LIFT inverts the gradient below room ≈ 0.20 | R2 | **accepted** | §1.7 room-proportional glass lift. **Neither reviewer proposed this exact form**; R2's suggestion (`LIFT ∝ room`) and R1's silence both leave the spatial case open — tying it to the already-computed local `roomRgb` preserves the room=1 numbers exactly, guarantees `P ≤ 0.2·room` everywhere, and doubles as the glass reflection |
| E1 fails at the shipped default | R1 (corr 0.474) + R2 (0.484) | **accepted** | §6.3: ray sampling + fill-derived Δ + detrend + defined failure mode. Re-measured: lag exactly 12 at every fill, corr 0.55–0.82 |
| E1 window too short at low fill; annulus/aspect commensurability hazard | R1 | **accepted** | fill-derived Δ fixes both structurally |
| E2 threshold source-dependent; precondition too weak | R1 + R2 (different numbers) | **accepted** | local-contrast detection + precondition **derived** as ≥ 0.35 |
| E4 degenerate (no transform → clipped step) | R2 | **accepted** | `zoom: 0.8` in the control |
| `bezel = 0` deletes the nest | R1 | **accepted** | floored at `BACKDRAFT_TV_BEZEL_MIN = 0.02` |
| Strict contraction ⇒ zero dynamics; "δ → precesses" readout is false | R1 | **accepted** | §1.10 stated up front; readout reduced to `n-fold rosette`; CRITICAL mode offered as Q1 |
| `rotate ±30°` excludes every photographed lock | R1 | **surfaced, not decided** | owner Q2 |
| `cv-scale-registry.test.ts` allow-list must gain `tv_gate` | R2 | **accepted** | §4.5 + the sweep note. Verified: `backdraft: ['delay_clock','mirror_x_gate','mirror_y_gate','shape_gate','pure_geo_gate']` at `:53`, with a header comment requiring a per-entry justification |
| "byte-identical" unprovable; N9(b) pins a TS function | R2 | **accepted, resolved as (b)** | see below |
| Perf accounting inconsistent | R2 | **accepted** | §6.5 legacy-path gating brings ON to parity with today's OFF |
| `waitForTimeout` is wall-clock | R2 | **accepted** | convergence poll |
| No `fwidth` AA in `tvScreenSdf` although the branch is uniform | R2 | **accepted** | §3 |
| "CLAMP_TO_EDGE unreachable" over-claimed | R1 | **accepted** | §1.2 precision; comment reworded, invariant promoted to N-INV |
| §2.1 zoom-direction prose backwards | R1 + R2 | **accepted** | §2.1 corrected |
| §6.4 snippet used undeclared GLSL consts | R2 | **accepted** | §4.3/§4.4 declare them; the implementing agent must add matching GLSL `const`s or interpolate the TS constants into the template string as the file already does for `BACKDRAFT_SHAPE_RADIUS` |
| "~15 visible levels" optimistic | R1 | **accepted** | "≈11 resolved" everywhere, including the card |
| "standing concentric rings" from FLICKER | R2 | **accepted, downgraded** | §5: row gradient 150° vs 60° per level at position 50; claim removed pending simulation |
| LIGHTEN nearly inert / DARKEN cannot blank | R2 | **accepted** | §5 descriptions corrected |
| Rotated screen at `fill = 0.95` clips the room at the corners | R2 | **accepted** | §2.2 noted as correct behaviour |
| `k·d` not `k(d+1)` | design vs physics doc | **design is right**, R1 and R2 independently confirm | kept, propagated into the FLICKER table |

**M2 adjudication — we drop "byte-identical" and do NOT promote a VRT baseline in phase 1.** R2 offered (a) promote `VRT_SCENES.backdraft` to a real pinned baseline on `main` first, or (b) claim only "structurally unchanged". Taking (a) means unmasking an animated feedback module whose tap minifies with `LINEAR` and no mipmaps over ~15 compounded resamples — R2's own §4 flags exactly that divergence, and CLAUDE.md's drain-then-dispatch protocol plus the linux-deficit ratchet makes it a multi-day cycle. The cost/flake-risk is not justified by the gate it buys. **We take (b), and pay for it with E5** (§6.3): a 4-quadrant mean-luminance golden on the shipped VRT scene params, captured on `main`, tolerance ±2/255 — renderer-tolerant, deterministic, and it catches gross OFF-path drift, which is the realistic failure. Plus diff discipline: the *only* edits to existing lines are the two `uTvOn` guards of §6.5, one `vec3 srcRaw = source;` capture, and new declarations. That is a reviewer checklist item, and the PR description must say "structurally unchanged, gated by E5" and never "byte-identical".

---

## 8. PHASING INTO PRs

Look-affecting video work is **never auto-merged in this repo** — the owner previews. Every PR below is independently green and independently previewable.

### PR 1 — PURE TV (the whole owner request, one coherent previewable slice)
The bounded-screen map with Dirichlet-zero boundary; the three-region composite with antialiased edges; ROOM as the live input plus ambient, **outside only**; the floored BEZEL; SHAPE as the screen shape; the room-proportional glass lift and `TV_WHITE`; the §1.5 operator-norm contraction contract with the always-on shoulder; §1.6 peak-normalised FLICKER; PHOSPHOR (single pole, per-channel, unit DC gain, ring-tap `head−1`); the 5 params / 3 ports / `cv-scale-registry` entry; the card row and readouts; N1–N10 + N-INV, E1–E5.

Estimated diff: ~250 lines in `backdraft.ts` (mostly new pure functions + the shader branch), ~80 in the card, ~400 in tests, 8 lines of `contract-lock.txt`, 1 line + comment in `cv-scale-registry.test.ts`. One GPU re-attest. **This is what you look at.**

### PR 2 — polish, after the preview
1. Deterministic 4×4 Bayer dither on the TV write path (frame-index-rotated so `freeze`/DRS stay deterministic) — unsticks the 2–5-code 8-bit decay tail at high PHOSPHOR.
2. Off-diagonal colour matrix `L̄` (Crutchfield eq. 5, p.236: *"their off-diagonal elements the coupling of the color signals"*) → monotone hue precession with depth. One `mat3`, no new state.
3. Two-pole / power-law phosphor tail ("the ghost that won't quite go") via 4 ring taps at `head−1,−2,−4,−8` — zero new state, the ring already holds them.
4. Hoist the legacy composite into an `else` if profiling shows the two `uTvOn` guards are not enough.

### ~~PR 3~~ — CRITICAL mode — **PULLED INTO PR 1 (owner, 2026-07-27; see Q1)**
**This is no longer a separate PR.** The owner will not preview a PURE TV without the time half: *"needing to ride the edge of white out and sort of drive it is an expected condition."* Build it inside PR 1, with the contraction contract lifted in CRITICAL only, recoverability (not stability) as the proven safety property, real control resolution across Λ ∈ [0.95, 1.05], and a CRITICAL assertion that a static-nest-plus-noise frame would FAIL. Original text kept below for the design detail:
The **time** half. A second discrete position on the same gate: gain ceiling raised to ≈1.02–1.05, always-on shoulder (already there from PR 1), plus Crutchfield's ~1 % noise floor. `Λ ≈ 1` is where the plates live — nucleating annuli at the centre, symmetry-locked rosettes, bursts. It is *by construction* not a contraction, so it needs its own stability story (the shoulder + the bounded room are the limiters) and its own e2e (assert the frame is **not** static — the exact inverse of PURE TV's assertion). Ship separately so PURE TV's guarantees are never weakened.

### PR 4 — research, on request only
`CAMERA RES` (quantise the tap → Crutchfield's finite-resolution moiré; renderer-risky); small barrel curvature (`k₁ ≈ 0.02–0.04` **only** — it compounds k times, so single-pass CRT-shader values are 5–10× too strong here); radial convergence error; supersampled loop (the digital "rescan with a high-resolution camera"); an explicit ANNULUS shape for the 1988 periodic-boundary experiment. **Scanlines, if ever, go outside the loop, applied once in screen space, off by default** — inside the recursion they alias into resolution-dependent moiré and are a VRT/SwiftShader flake risk.

### Repo obligations, every PR
`STRICT_DOCS` membership means every new port and param needs a `docs.inputs` / `docs.controls` entry **including the hidden `tvGate`** (`mirrorXGate`/`shapeGate`/`pureGeoGate` all carry one today); all prose inside the `docs-hash-ignore` markers at `:1436`/`:1497`; `flox activate -- task docs:accept` then **review the `contract-lock.txt` diff**; `flox activate -- task pr:conflict-sweep` after any merge to main (`contract-lock.txt` **and** `cv-scale-registry.test.ts` are both shared-conflict surfaces here); merge only on **this PR's** final-commit green.

---

## 9. OPEN QUESTIONS FOR THE OWNER

**Q1 — do you want the TIME half, and are you willing to give up the stability guarantee for it?** — **ANSWERED 2026-07-27: YES. CRITICAL MODE SHIPS IN PR 1.**

> *"this needs to be included, i don't want to review it otherwise. needing to ride the edge of white out and sort of drive it is an expected condition."* — owner

The recommendation below (ship PR 1, look, then decide) was **rejected**, and the reasoning behind the rejection reframes the whole feature: **instability is the instrument, not a defect.** The owner expects to ride the edge of white-out and drive it. A mode that converges to a static nest and holds it is not what was asked for, and they will not preview one.

Consequences, all folded into PR 1:

1. **The §1.5 operator-norm contraction contract stays the law for PURE TV and is LIFTED in CRITICAL.** The always-on shoulder and the bounded room remain as **soft** limiters — what makes a white-out *recoverable* rather than terminal — but no hard contraction guarantee is re-imposed. A mode that cannot go unstable is not this mode.
2. **Recoverability is the real safety property, and it is testable.** Driving to full white must never wedge the module, force a reload, or persist a broken state into the Y.Doc; backing the gain off must bring it back. That replaces "cannot go unstable" as the thing PR 1 proves.
3. **"Sort of drive it" is a RESOLUTION requirement.** §8's original *"a second discrete position on the same gate"* is insufficient — a binary cannot ride an edge. The interesting region is roughly Λ ∈ [0.95, 1.05] and behaviour changes fast across it; a control whose useful range is 5 % of its travel is unplayable. The near-unity region needs real resolution and a musical CV response.
4. **The CRITICAL e2e assertion is UNSOUND as originally written.** "The frame is not static" passes for the wrong reason: Crutchfield's ~1 % noise floor alone makes consecutive frames differ, so a static nest plus noise passes it. Assert **evolving structure** — decaying frame-to-frame correlation, a migrating band, the nucleating annulus — and negative-control it: with the noise on but the gain back in the contraction regime, the CRITICAL assertion must go RED. Same failure shape as the dx7 "still audible" trap (see the dx7 program plan §3.6).
5. **Cost improves.** One PR = one GPU re-attest instead of two, one contract-lock re-pin, one preview.
6. **Renderer risk rises.** A non-contraction on CI's SwiftShader can diverge from a real GPU; CRITICAL assertions must be renderer-tolerant, capability-gated, and confirmed green ON CI.

~~**Recommendation: ship PR 1 first, look at it, then decide.** The static Droste is what the screenshot shows and what your sentence describes geometrically; CRITICAL mode (PR 3) is a separate, clearly-labelled position so it can never destabilise PURE TV.~~ — superseded above. PURE TV's own contraction guarantee at its own settings must still survive; if folding CRITICAL in breaks *that*, stop and escalate.

**Q2 — widen ROTATE beyond ±30°?**
Every symmetry lock Crutchfield photographs (n = 3/4/5/9 at 120°/90°/72°/40°) is outside the current range; inside it, only n ≥ 12 is reachable and those are the narrowest, least stable windows. Widening to ±180° unlocks the rosettes but remaps `rotate` CV response for every existing patch.
**Recommendation: widen, but only inside PURE TV** — read `rotate` through a mode-dependent scale (`φ = rotate × 6` when `tvMode = 1`), so stored patches and CV are untouched in every other mode and the full lock range becomes reachable in the mode that wants it. One line, no contract change.

**Q3 — default fill 0.75 (chunky, unmistakable) or 0.92 (Crutchfield's cookbook)?**
Crutchfield's own step 7 (p.232): *"zoom in enough so that the 'first' image of the monitor front fills 90 % of the screen."* That gives a dense ~30-level tunnel; 0.75 gives ~11 obvious frames.
**Recommendation: ship 0.75.** It reads as "a TV showing a TV" at a glance, which is the thing you said is missing. `backdraftTvFill` is a one-line swap if the preview looks too chunky, and ZOOM reaches 0.95 anyway.

**Q4 — PHOSPHOR as a continuous CV-able fader, or a 5-position tube-type button (TV / MONO / SCOPE / LONG / RADAR) matching the FLICKER idiom?**
**Recommendation: continuous.** It is the only new knob worth modulating (a CV ramp on PHOSPHOR is a "the tube is warming up" gesture), and the tooltip carries the tube ladder so the named positions are still discoverable.

**Q5 — PURE GEO is ignored in PURE TV (SHAPE means exactly one thing: the screen).** Confirm, or should PURE GEO stay live as a post-composite screen-space vignette over the whole nest?
**Recommendation: ignore it in PURE TV**, and grey the button out on the card so the state is legible.

---

## 10. TASTE CALLS, COLLECTED

Any of these can be vetoed without touching the architecture.

1. `backdraftTvFill` default 0.75 vs Crutchfield's 0.90 (Q3).
2. `BACKDRAFT_TV_BEZEL_MIN/MAX = 0.02 / 0.12`, `bezel` default 0.4, colour `vec3(0.045)`, rounded outer corners.
3. `TV_GLASS = 0.20` — the milky depth plateau at 20 % of the local room.
4. `TV_WHITE = (1.0, 0.99, 0.975)` — the warm drift into depth. `vec3(1.0)` disables it; the R/G/B knobs already do the same thing more aggressively.
5. `TV_AMBIENT = 0.05` — the self-lit room with nothing patched.
6. PHOSPHOR continuous vs 5-position (Q4).
7. PURE GEO ignored in PURE TV (Q5).
8. Phosphor per-channel tint `(1.0, 0.94, 0.88)` — red slowest.
9. FLICKER's shoulder applied to light from inside S only, leaving the room linear.
10. `tv_gate` in phase 1 rather than later (avoids a second re-attest + contract re-pin).
11. Fader ranges **not** narrowed on the card in TV mode; effective values shown as text, so CV/MIDI-learn mapping stays stable.
12. Glass reflection reads the room at the *same* screen position (a cheap, spatially-varying stand-in for what is behind the camera).

---

## APPENDIX — files and scratch

Repo: `packages/web/src/lib/video/modules/backdraft.ts` (`FRAG_SRC` :401-669, `shapeMask` :486, `feedbackUv` :513, source crossfade :563, flicker+shoulder :583-594, colour chain :606-611, additive :628, hall :643-661, `backdraftFlickerTerms` :1194, def :1332+, params :1388-1433, docs markers :1436/:1497, ring alloc :1546, clamp :1559-1560, `draw()` :1597+, head advance :1740) · `packages/web/src/lib/ui/modules/BackdraftCard.svelte` (2d context :307 — **not** in the attest basis) · `packages/web/src/lib/video/engine.ts:2153` (`createFboImpl`, RGBA8/LINEAR/CLAMP, `null` upload ⇒ zero-initialised cold start) · `packages/web/src/lib/video/toybox-feedback.ts:216,237` (the CPU-mirror precedent) · `packages/web/src/lib/video/cv-scale-registry.test.ts:53` · `packages/web/src/lib/docs/strict-docs.ts:315` · `packages/web/src/lib/docs/contract-lock.txt:165-218` · `e2e/vrt/vrt-scenes.ts:423` · `e2e/vrt/vrt-exemptions.ts:260,829` · `e2e/tests/per-module-per-port-behavioral.spec.ts:426` · `scripts/webgl-attest-lib.ts:226-233`.

Scratch (this session): `/private/tmp/claude-501/-Users-2600hz-Documents-workspace-inet-modular/078589df-a2df-45f2-9b1d-f73c345b45ac/scratchpad/{fl,lv,e1,e1b}.mjs` — the FLICKER peak table, the level-brightness/lift sweep, the operator-norm clamp sweep, and the corrected E1 measurements. Reviewer scratch: `{puretv,sim,stab,e1,dyn,final,e2,flick,flicksim,ring,gain,quant}.mjs`. Crutchfield full text: `{crutchfield,crutchfield1988,vasulka}.txt`.
