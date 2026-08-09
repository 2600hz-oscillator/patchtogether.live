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

## 5. THE FACE

```ts
face: {
  title: 'Random',
  hint:
    'Two generators on one clock: T makes gates, X makes CV sampled on them. DÉJÀ VU locks the loop ' +
    'at 0.5, not at 1 — and the X one repeats LESS above 0.5, by design. LENGTH and X LENGTH do ' +
    'nothing at all until their DÉJÀ VU is past the midpoint. STEPS does no quantisation below ' +
    '~0.55, which is where it ships, so SCALE is inert at the defaults.',

  order: [
    'rate', 'deja_vu', 'spread', 't_bias', 'steps', 't_model',   // 1-6 = the lane budget
    'marbles-loop-{n}',                                           // panel: first legal rank is 7
    'length', 'x_deja_vu', 'x_length', 'scale', 'x_bias', 't_jitter', 'pw_mean',
  ],
  // SIX BANDS ⇒ the dock TAB RAIL, deliberately — the pentemelodica precedent. Two
  // symmetric sections (T and X) with a shared clock is the shape `face.order` cannot
  // express, and PF-21 row packing does not apply to a tabbed face.
  pages: [
    { id: 'clock',  label: '1 · clock — 3.75 to 3840 BPM',
      hint: 'f = 2 Hz × 2^(RATE/12), measured exact. At the bottom of the fader that is ONE PULSE ' +
            'EVERY 16 SECONDS. JITTER moves the inter-onset CV from 0.0000 to 0.3506.',
      controls: ['rate', 't_jitter'] },
    { id: 'tgates', label: '2 · T — the gates',
      hint: 'BIAS splits t1 against t2 (measured 100 % → 1.6 % across the travel). PW sets the t1 ' +
            'duty 3.75 % → 90.8 % and does NOT touch clk, which stays at exactly 50 %.',
      controls: ['t_bias', 'pw_mean', 't_model'] },
    { id: 'tloop',  label: '3 · T loop — locks at 0.5, saturated above',
      hint: 'Measured period-N repetition: 36 % / 25 % / 100 % / 100 % / 100 % at DÉJÀ VU ' +
            '0 / 0.25 / 0.5 / 0.75 / 1. LENGTH is bit-exactly inert below the lock.',
      controls: ['deja_vu', 'length'] },
    { id: 'xcv',    label: '4 · X — the voltages',
      hint: 'SPREAD 0 pins all three X outputs to exactly 0; X BIAS at either end pins them to a ' +
            'DC constant. Only the middle of both dials is random.',
      controls: ['spread', 'x_bias'] },
    { id: 'xquant', label: '5 · X quantiser — off below 0.55',
      hint: 'Measured distinct values out of 155 samples: 155 / 155 / 155 / 22 / 15 / 5 / 3 at STEPS ' +
            '0 / 0.25 / 0.5 / 0.6 / 0.75 / 0.9 / 1. The six SCALES are only all distinguishable ' +
            'between STEPS 0.7 and 0.8; at 1.0 every scale collapses to octaves.',
      controls: ['marbles-loop-{n}', 'steps', 'scale'] },
    { id: 'xloop',  label: '6 · X loop — turning it UP repeats LESS',
      hint: 'Measured exact repetition: 0 % / 100 % / 50.6 % / 31.3 % at X DÉJÀ VU 0 / 0.5 / 0.75 / 1. ' +
            'The maximum of the knob is not the maximum of the behaviour.',
      controls: ['x_deja_vu', 'x_length'] },
  ],
  glyph: 'meter',
  paramCells: { t_model: 'grid', scale: 'grid' },   // §4-C — six named states each, and they will not fit a strip

  hero: {
    cell:    'marbles-loop-{n}',
    control: 'deja_vu',
    readouts: [
      { label: 'clock',  valueId: 'marbles-bpm' },
      { label: 'T loop', valueId: 'marbles-t-loop-state' },
      { label: 'X loop', valueId: 'marbles-x-loop-state' },
    ],
  },

  sidebar: [
    { kind: 'signal-flow', label: 'signal flow', stages: [
      { label: 'RATE → MASTER PHASE', role: 'generator', note: '2 Hz × 2^(st/12)' },
      { label: 'JITTER',   role: 'bus' },
      { label: 'T MODEL',  role: 'bus', note: 'six named, five distinct' },
      { label: 'BIAS → t1 / t2', role: 'bus' },
      { label: 'PW',       role: 'bus', note: 'gates only; clk stays 50 %' },
      { label: 'X SAMPLE @ CLOCK', role: 'bus', parallel: true, note: 'the same phase drives both' },
      { label: 'SPREAD · BIAS',    role: 'bus', parallel: true },
      { label: 'QUANTISER',        role: 'bus', parallel: true, note: 'off below STEPS 0.55' },
    ] },
    { kind: 'presets', label: 'presets', entries: [
      /* free clock · locked 8-bar loop (deja_vu 0.5, length 8) · quantised pentatonic
         (steps 0.75, scale 2) · drum-ish (t_model 2, t_bias 0.35) — each pinned to a
         MEASURED observable, so a preset is a claim rather than a mood. */
    ] },
  ],
}
```

⚠ **SIX BANDS MEANS THE TAB RAIL, AND THAT IS THE POINT.** PF-21 row packing shares
consecutive packable bands into one row — but a **tabbed face never packs**, and this
module wants tabs: T and X are two instruments, and putting `deja_vu` next to
`x_deja_vu` in one row would flatten exactly the distinction §4-B exists to teach.
Same reasoning as pentemelodica.

⚠ Band labels 1, 3, 5 and 6 are 26–44 characters and **all four carry the finding**.
Label clipping is invisible to `faces-parity`. **Measure every one against the tab rail's
width, which is narrower than a band header.** Fallbacks that keep the point:
`1 · clock — 3.75…3840 BPM`, `3 · T loop — locks at 0.5`, `5 · quantiser — off below .55`,
`6 · X loop — up = less`.

⚠ `title` / `hint` / band hints are ANNOTATION and paint nothing at rest
(`dock-faceplate-model.ts:90`).

⚠ `marbles-loop-{n}` is rank 7 (`faceTierCap('full')` = 6, and a PANEL cannot be selected
at a lane tier). Fourteen keys, so rank 7 is comfortable.

---

## 6. DERIVED READOUTS

### A. `marbles-bpm` — because "0 st" is not a clock

```
bpm = 120 · 2^(rate/12)
```
*Measured against the worklet:* 3.75 / 30 / 60 / **120** / 240 / 960 / 3840 BPM at rate
−60 / −24 / −12 / 0 / +12 / +36 / +60. Exact.
**NEGATIVE CONTROL — `t_jitter`.** The BPM must **not** move with jitter (measured IOI
mean 6000 / 6000 / 5998 / 5970 samples at jitter 0 / 0.25 / 0.5 / 1.0 — the mean is
stable to 0.5 % while the sd goes 0 → 2093). A readout that moved with jitter would be
reporting the last interval, not the rate. **SECOND — `rate_cv`:** the whole point of a
clock module is that its rate gets modulated; needs `readLive`.

### B. `marbles-t-loop-state` / `marbles-x-loop-state` — the pair that carries §4-B

Print `free` / **`LOCKED · 8`** / `locked, drifting 50 %`, per section.
**NEGATIVE CONTROL — `length`.** At `deja_vu 0` the readout must print `free` and must
**not** print a length, because LENGTH is measurably inert there (bit-identical output at
length 1, 2, 4, 8, 16). A readout that showed "8" at deja_vu 0 would be advertising a
control that does nothing. **SECOND CONTROL — `x_deja_vu` at 1.0:** the X readout must
print *less* locked than at 0.5 (measured 31.3 % vs 100 %), i.e. it must be **non-monotone
in the same direction the module is.** A derivation that simply scaled with the knob
would be wrong at exactly the setting a player is most likely to try.
⚠ **HONESTY TERM:** the repetition percentages above are measured over a finite window
with one RNG seed. The readout should print the *declared* state (locked / drifting), not
a fabricated percentage.

### C. `marbles-quantiser-state` (sidebar) — "SCALE does nothing right now"

Prints `off` below `steps ≈ 0.55`, `<scale name> · N degrees` above it, and
`octaves only` at `steps ≥ 0.95`.
**NEGATIVE CONTROL — `scale`.** Below the threshold the readout must be **invariant to
SCALE**, which is exactly what the module measures (all six bit-identical, and no
quantisation at all). **SECOND — `steps` at 0.75:** it must name the scale there, because
that is the one band where all six are distinguishable. **This readout is the only place
a player can learn §4-C**, and it is the reason `scale` is worth keeping on the face at
all rather than deleting.

---

## 7. THE BESPOKE CELL

**LEGITIMATE — `marbles-loop-{n}`: the loop ring.** A ring of `length` slots with the
current position marked, filled for T and X separately, shaded by how locked each section
is, plus the quantiser's active degrees drawn as tick marks on a second ring. It answers
§4-B and §4-C simultaneously and there is no number that can.

---

## 8. ALREADY-WRONG

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

## 9. COST — the most expensive face in the batch

| | |
|---|---|
| **contract-lock** | **+1 line** for the panel family, **+12 lines** if the two `options` rosters land (six each). No audition. |
| **ART** | none from the face. `art/scenarios/marbles/gate-and-cv.test.ts` exists; there is **no `art/baselines/marbles/`**, so the scenario asserts properties, not bytes — §8-A is a behaviour change with no pinned audio to protect it. |
| **VRT** | not in `STRICT_VRT_MODULES`. +`face-marbles-{compact,dock}` × 2 = **4 informational baselines**. ⚠ **`marbles` FREE-RUNS (§3)**, so it is only the SECOND face in the roster that exercises #1420's pre-frame graph freeze. **Derive its glyph determinism the analogVco way — 10 separate processes, unmasked — before merging.** A tabbed six-band dock is also the tallest face scene in the batch; the dock VRT scene now runs at `FOLD_VIEWPORT` 1280×1400 with `unfoldDockPane()`, so height is covered, but check it. |
| **e2e** | +1 `faces-parity` row, **15 cells** — the largest new row in the batch, ≈ +20 s on one shard on top of the ~8 s boot. Under the 2-minute bar, but it is the row to watch. |
