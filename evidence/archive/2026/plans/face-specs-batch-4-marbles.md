# FACE SPEC — `marbles` (batch 4)

## 0. STATUS

**Authored 2026-08-09. Every claim below was measured or read against `main`**
(`ecc48f2e`). Nothing here is implemented; no def, card or DSP file is touched.

**Verdict: PROMOTE — the batch's biggest module and the one where a face changes the
most.** archetype: **RANDOM SOURCE / clock generator** (nothing else in the rack does
this; `sample-hold` is the one-knob version).

Not in `STRICT_FACES`; no `face:` block. In `STRICT_DOCS`; **not** in
`STRICT_VRT_MODULES`. 13 params, 11 in, 6 out. contract-lock = **31 lines**
(`contract-lock.txt:1694-1724`).

**Method, and read this before any number below.** `packages/dsp/src/marbles.ts`
bundled with esbuild and run offline at 48 kHz; gates read by rising-edge detection,
CV read 200 samples after each clock edge.

> ⚠ **I GOT THIS MODULE WRONG THREE TIMES, AND THE THIRD WRONG ANSWER WAS THE MOST
> CONVINCING.** In order: (1) an edge counter that misses the first pulse turned an exact
> `2^(rate/12)` law into an apparent 0.125 Hz shortfall; (2) probing the X section at
> `spread 1` put every sample on the worklet's `clamp(cv/5, −1, 1)` rail, so **six
> scales looked bit-identical because the output was pinned**; (3) probing at `steps 1`
> collapses every scale to its ROOT degree by design, so six scales looked bit-identical
> **again**, from a completely different cause — and this time I had an unclipped probe
> and a passing negative control, which is exactly what made it believable. **`scale` is
> not dead.** Everything below is measured at `spread 0.4` (0 % clipping, verified) and
> across the whole `steps` range.

---

## 1. WHAT IT ACTUALLY DOES

Two independent generators sharing one clock. **T** makes random gates (`t1`, `t2`, and
the master `clk`); **X** makes random CV (`x1`, `x2`, `x3`), sampled on T's clock and
optionally quantised to a scale. Six T models, six scales, and two independent DÉJÀ VU
loop-lockers — one per section.

---

## 2. THE CONTROLS THAT MATTER — 13 params, and the lane cut is brutal

| rank | control | why |
|---|---|---|
| 1 | `rate` | the clock. **3.75 BPM to ~3830 BPM** across the fader (§4-A). |
| 2 | `deja_vu` | the module's identity: the knob that turns noise into a pattern. Locks at **0.5**, not at 1 (§4-B). |
| 3 | `spread` | the X width, and the only X control that is live at the shipped defaults (§4-D). |
| 4 | `t_bias` | the `t1`/`t2` split — measured 100 % → 1.6 % across the travel, the cleanest control on the module. |
| 5 | `steps` | the quantiser depth. **Ranked 5 despite being inert at its own default** (§4-C) precisely because that is what a player needs to discover. |
| 6 | `marbles-loop-{n}` | the PICTURE… **no.** Rank 6 goes to `t_model`; a panel's first legal rank is 7. |
| 6 | `t_model` | six models, **five distinct** (§4-E). |
| 7 | `marbles-loop-{n}` | the picture. |
| 8 | `length` | dock-only. **Bit-exactly inert until `deja_vu` ≥ 0.5** (§4-B). |
| 9 | `x_deja_vu` | dock-only, and **non-monotone** (§4-B). |
| 10 | `x_length` | dock-only, same inertness as `length`. |
| 11 | `scale` | dock-only. **Only distinguishable inside a narrow band of `steps`** (§4-C). |
| 12 | `x_bias` | dock-only. Its two ENDS pin the output to a constant (§4-D). |
| 13 | `t_jitter` | dock-only. Measured CV of the inter-onset interval 0.0000 → 0.3506. |
| 14 | `pw_mean` | last. Gate duty 3.75 % → 90.78 %, and it does not touch `clk` at all. |

**NO AUDITION.** `marbles` free-runs — it is producing clock pulses from the moment it
spawns (§3). Auditioning it would mean nothing.

---

## 3. NOT INERT AT SPAWN — it is the batch's only self-starting module

*Measured* at the shipped defaults over 8 s: **16 `clk` edges (2.000 Hz), 6 `t1`, 10
`t2`**, `x1` ranging [−0.2734, 0.1394]. It runs immediately, with no patching.

⚠ **That has a VRT consequence and it is the analogVco lesson.** A `glyph: 'scope'` or
`'meter'` on this face taps a **free-running** output. #1420 suspends the AudioContext
before the tile is framed, which is what makes analogVco's live saw capture as zeros —
but analogVco is currently the *only* face in the roster exercising that freeze.
**`marbles` would be the second, and its glyph must be verified the same way** (10
separate processes, unmasked) rather than assumed.

---

## 4. WHAT THE FACE MUST MAKE VISIBLE — five measured facts

### A. RATE is a 1000:1 range on a linear fader, and both ends are unusable

`rate` is `−60..60`, `curve: 'linear'`, `units: 'st'`. *Measured* `clk` frequency:

| rate (st) | −60 | −36 | −24 | −12 | **0** | +12 | +24 | +36 | +60 |
|---|---|---|---|---|---|---|---|---|---|
| Hz | **0.0625** | 0.125 | 0.500 | 1.000 | **2.000** | 4.000 | 8.000 | 16.000 | **64.000** |
| BPM | **3.75** | 7.5 | 30 | 60 | **120** | 240 | 480 | 960 | **3840** |

The law is exactly `f = 2 Hz · 2^(rate/12)`. *(My raw edge counts read 31 / 63 / 127 /
511 rather than 32 / 64 / 128 / 512 — **one missing edge, every time, because a rising-edge
detector cannot see a signal that starts HIGH.** An instrument artifact, corrected here
rather than reported as a 0.125 Hz error.)*

At `rate −60` the clock produces **one pulse every 16.00 seconds** (measured directly
over a 40 s render: 2 edges, IOI 16.00 s). A user who drags the fader to the bottom gets
a module that looks broken for a quarter of a minute.

The face's job: **print the BPM.** A "0 st" readout on a clock is information-free.

### B. DÉJÀ VU locks at 0.5 — and the X one is NON-MONOTONE

*Measured*, `length 4`, `rate 24`, 12 s, IOI period-4 match on `t1`:

| `deja_vu` | 0 | 0.25 | **0.5** | 0.75 | 1.0 |
|---|---|---|---|---|---|
| period-4 IOI match | 36.4 % | 25.0 % | **100 %** | **100 %** | **100 %** |
| `t1` onsets | 46 | 45 | **95** | 95 | 95 |

The T loop **snaps closed between 0.25 and 0.5 and is then saturated for the entire top
half of the knob.** The onset count doubles at the same point.

And the X section behaves **differently and non-monotonically** — exact period-4 value
repetition on `x1`:

| `x_deja_vu` | 0 | **0.5** | 0.75 | 1.0 |
|---|---|---|---|---|
| exact repeat | 0.0 % | **100 %** | **50.6 %** | **31.3 %** |

**Turning X DÉJÀ VU up past 0.5 makes it repeat LESS.** In hardware Marbles that is
deliberate — past 12 o'clock the loop starts jumping around itself — but on a 0..1 fader
labelled "Déjà Vu" with no detent and no readout, **the maximum of the knob is not the
maximum of the behaviour**, and nothing on the panel says so. This is the single
strongest argument for a face on this module.

⚠ **And `length` / `x_length` are BIT-EXACTLY INERT while `deja_vu` is 0** — which is the
shipped default. *Measured*: `clk` 63 and `t1` 29 at `length` 1, 2, 4, 8 **and** 16.
Two of the thirteen params do nothing at all until a third one is moved past its
midpoint.

### C. STEPS does no quantisation below ~0.55, so SCALE is inert at the defaults

*Measured*, `spread 0.4` (0 % clipping, verified), 155 clocked samples:

| `steps` | 0 | 0.1 | 0.25 | 0.4 | **0.5 (default)** | 0.6 | 0.75 | 0.9 | 1.0 |
|---|---|---|---|---|---|---|---|---|---|
| distinct x1 values | 155 | 155 | 155 | 155 | **155** | 22 | 15 | 5 | **3** |

**Below 0.55 there is no quantisation at all** — every sample is a distinct value — and
the shipped default sits at **0.5**, on the wrong side of it. So at spawn, `steps` looks
like a dead knob and `scale` genuinely *is* one, because it has nothing to act on.

And SCALE's own discriminability is a narrow band. Distinct output value sets per scale:

| `steps` | scale 0 vs 1 vs 2 | scale 3 | scale 4 vs 5 |
|---|---|---|---|
| ≤ 0.5 | no quantisation — all six identical | — | — |
| **0.6** | **bit-identical (0.00e+0)** | differs (1.92e-2) | identical to each other |
| **0.7 – 0.8** | **all six distinct** ✓ | ✓ | ✓ |
| **0.9** | **bit-identical (0.00e+0)** | differs (1.17e-1) | differ from 0 by 3.40e-4 |
| 1.0 | all collapse to the root — octaves only (−12 / 0 / +12 st) | | |

So: **SCALE is a six-way selector that is only fully six-way inside `steps ∈ [0.7, 0.8]`.**
Outside that band it is one-way, three-way or four-way. That is faithful Marbles
behaviour — coarse quantisation keeps only the heaviest-weighted degrees — and it is
completely invisible on a panel with two independent dials.

⚠ **Both `t_model` and `scale` declare NO `ParamDef.options`.** The names exist
(`MARBLES_T_MODEL_NAMES` = COIN / CLUSTERS / DRUMS / INDEP / 3-STATE / MARKOV;
`MARBLES_SCALE_NAMES` = C major / C minor / Pentatonic / Pelog / Raag Bhairav / Raag
Shri, `marbles.ts:59-77`) but they are **not on the ParamDefs**, so a faceplate prints
`0.00`…`5.00` for both. **Blocking, same as resofilter §4-B**, and here it is worse:
"Raag Bhairav" is not guessable from "3.00".

⚠ **And they will clip.** `filter` ships **three** two-letter options and its dock MODE
still renders `LP · H… · B…`. Six entries of "Raag Bhairav" length is not a Segmented.
**Use `paramCells: { scale: 'grid', t_model: 'grid' }`** — the chip + portaled
diagram-grid popover — and design the popover, not the strip.

### D. SPREAD 0 and X BIAS at either end pin the X outputs to a constant

*Measured*, `rate 24`, 12 s:

| `spread` | 0 | 0.25 | 0.5 | 0.75 | 1.0 |
|---|---|---|---|---|---|
| x1 range | **[0.0000, 0.0000]** | [−0.102, 0.077] | [−0.337, 0.272] | [−0.727, 0.682] | [−1.000, 1.000] |
| sd | **0.0000** | 0.0284 | 0.1057 | 0.3190 | 0.9999 |

At `spread 0` **all three X outputs are exactly 0** — verified on x1, x2 and x3
independently. And `x_bias`:

| `x_bias` | 0 | 0.25 | 0.5 | 0.75 | 1.0 |
|---|---|---|---|---|---|
| x1 range | **[−1, −1]** | [−1, 1] | [−1, 1] | [−1, 1] | **[+1, +1]** |
| mean | −1.0000 | −0.6484 | 0.0110 | 0.6264 | +1.0000 |

**Both ends of X BIAS produce a DC constant** — the randomness is gone, not merely
skewed. ⚠ Those ends are also exactly where the worklet's `clamp(cv/5, −1, 1)` rail sits,
so part of what is measured is the rail. Either way the *observable* is a dead output.

### E. Six T models, five distinct — CLUSTERS is bit-identical to COIN

*Measured* on **both** `t1` and `t2`, at **three** different `t_bias` values (0.3, 0.5,
0.7) to guard against a bias-midpoint degeneracy:

| vs `t_model 0` (COIN) | m1 CLUSTERS | m2 DRUMS | m3 INDEP | m4 3-STATE | m5 MARKOV |
|---|---|---|---|---|---|
| t_bias 0.3 | **IDENTICAL** | differs | differs | differs | differs |
| t_bias 0.5 | **IDENTICAL** | differs | differs | differs | differs |
| t_bias 0.7 | **IDENTICAL** | differs | differs | differs | differs |

**NEGATIVE CONTROL:** DRUMS differs from COIN at every bias, so the comparison is not
blind. `T_MODEL_ORDER` maps index 1 to `T_MODEL.CLUSTERS`
(`packages/dsp/src/marbles.ts:35-41`) and index 0 to `COMPLEMENTARY_BERNOULLI`, so this
is a genuine behavioural collapse in `marbles-core`, not a mapping typo in the worklet.

**One of the six named models is a duplicate of another**, and the name a player reads
("CLUSTERS") describes something the module does not do.

*(Also measured, all correct and worth recording as non-defects: `t_bias` moves the
`t1`/`t2` split 1.000 → 0.016 monotonically; `pw_mean` moves the `t1` duty cycle 3.75 %
→ 90.78 % and leaves `clk` at exactly 50.00 % at every setting; `t_jitter` moves the IOI
coefficient of variation 0.0000 / 0.0014 / 0.0221 / 0.3506 at 0 / 0.25 / 0.5 / 1.0.)*

---

## 5–7 · DELETED 2026-08-12 (the face SHIPPED — #1467)

The proposed `face` block, the derived-readout derivations and the
bespoke-cell argument were deleted: the shipped def is the record, and the
build re-measured the numbers it needed. §§1–4 (the measurements) and §8 (the
defects) are kept.

---

## 8. ALREADY-WRONG

> **Re-checked 2026-08-12.** **B is FIXED** — both selectors now declare
> `options` (`marbles.ts:191, :202`). **A is still true but no longer only
> recorded here** — the def states it (`marbles.ts:223`: "CLUSTERS is not
> implemented in this port and behaves exactly as COIN, so the six positions are
> five behaviours"), which documents it rather than fixing it. **C, D, E, F and
> the spawn-default observation are unchanged** — `steps` still defaults to 0.5
> (`marbles.ts:199`).

- **A · `t_model` 1 (CLUSTERS) is BIT-IDENTICAL to `t_model` 0 (COIN)** on both gate
  outputs at three separate bias settings, with a passing negative control. §4-E. Six
  named models, five behaviours. **Its own PR** — it is a `marbles-core` fix.
- **B · `t_model` and `scale` declare no `ParamDef.options`**, so a face prints
  `0.00`…`5.00` for two twelve-state selectors whose names already exist as exported
  constants. §4-C. Contract change, blocking for the face.
- **C · `length` and `x_length` are bit-exactly inert at the shipped defaults.** §4-B.
  Not a bug — a **documentation and layout** problem, and the reason both are ranked 8th
  and 10th rather than beside their sections' other controls.
- **D · `steps` defaults to 0.5 and the quantiser does not engage until ~0.55.** §4-C.
  So the module ships with its entire X quantiser section — `steps` **and** `scale` — in
  a state where neither does anything. A one-line default change (`steps: 0.7`) would fix
  it, and it **is a contract change that alters every existing patch's spawn state**, so
  it needs an owner decision, not a drive-by.
- **E · `spread 0` and `x_bias` 0 / 1 produce DC constants**, not narrow randomness.
  §4-D. Correct behaviour, undocumented.
- **F · the card re-types the ranges** (9 literal `min=` props in `MarblesCard.svelte`);
  `marbles` is not in `RANGE_BOUND_CARDS`.
- **G · `MARBLES_T_MODEL_NAMES` and `MARBLES_SCALE_NAMES` live on the web def while
  `T_MODEL_ORDER` lives in the worklet** — the same name/order split that let §8-A hide.
  Fixed for free by B.
- **No fully dead controls.** All thirteen move something somewhere — but **four**
  (`length`, `x_length`, `scale`, and `steps` below 0.55) are dead **at the module's own
  spawn defaults**, which is a different and more user-visible thing.

---
