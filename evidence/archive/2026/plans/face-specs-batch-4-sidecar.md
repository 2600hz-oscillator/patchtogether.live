# FACE SPEC — `sidecar` (batch 4)

> ⚠ **PLATFORM CORRECTIONS SINCE THIS WAS WRITTEN — 2026-08-12 janitorial sweep.**
> - **The `signal-flow` sidebar kind was DELETED** (#1468, removed with its twelve
>   adopters). `packages/web/src/lib/graph/types.ts:798` now reads "THERE IS NO
>   `signal-flow` KIND, and re-adding one is the mistake this note prevents."
>   **Any `signal-flow` sidebar block proposed below is VOID** — the surviving
>   kinds are the three in `FaceSidebar.svelte`.
> - **PF-22 freed the hero rank** (#1480): `face.hero.cell` no longer consumes a
>   LANE rank, so a `panel` may now rank FIRST. Any argument below that a module
>   cannot be faced because a panel's first legal rank is 7 is OBSOLETE.
> - **A card↔face PRIMITIVE-PARITY gate now exists** (#1480,
>   `card-primitive-parity.test.ts`): ranking a param whose card binds it to a
>   primitive the platform has no cell kind for now FAILS, naming the
>   `(module, param, primitive)` triple. `XyPad` and `NoteEntry` are the two
>   declared gaps.
> - **The faceplate pipeline is PAUSED by owner directive.** This spec is BANKED,
>   not cancelled and not blocked.


## 0. STATUS

**Authored 2026-08-09. Every claim below was measured or read against `main`**
(`ecc48f2e`). Nothing here is implemented; no def, card or DSP file is touched.

**Verdict: PROMOTE — and it is the batch's clearest case of "a face reveals what
the card structurally cannot".**
archetype: **stereo DYNAMICS processor with a CV envelope tap** (the only
compressor in the rack; `mixmstrs` has per-channel compression but no CV outs).

Not in `STRICT_FACES`; no `face:` block. In `STRICT_DOCS`; **not** in
`STRICT_VRT_MODULES`. 9 params, 7 in, 4 out. contract-lock = **24 lines**.

**Method.** `packages/dsp/src/sidecar.ts` bundled with esbuild against stub worklet
globals, run offline at 48 kHz in 128-sample blocks. Two source shapes were used and
**the difference between them matters**: a 4 Hz decaying kick train (the realistic
case) and a hard STEP into a steady sine (the case that can resolve a time constant).
The step probe carries a permanent negative control — RATIO on the same measurement
must move (measured 0.00 / 6.65 / 9.98 / 12.64 dB at ratio 1 / 2 / 4 / 20).

---

## 1. WHAT IT ACTUALLY DOES

MAIN is the trigger, SIDECHAIN is the thing that ducks, output = **MAIN passthrough +
ducked(inputLevel · SIDECHAIN)**. Detector: `mag = |fL| + |fR|` after a one-pole HPF
(`packages/dsp/src/lib/compressor-dsp.ts:361-362`) → log2 → GMR-2012 3-region soft-knee
gain computer → asymmetric one-pole smoother → duck gain.

Two structural facts the panel does not state, and both change how you set the knobs:

1. **The stereo link SUMS, it does not average** (`|fL| + |fR|`). A centred mono
   trigger is therefore detected **exactly 6.02 dB hotter** than its own level.
2. **The MAIN passthrough is never processed.** Measured Δ = **0.000 dB** between a
   no-duck and a maximum-duck setting with the sidechain silent. Correct by design and
   correctly documented — stated here because it is what makes MAKEUP's doc wrong (§4-A).

---

## 2. THE CONTROLS THAT MATTER — 9 params, and the lane cut

| rank | control | why |
|---|---|---|
| 1 | `threshold` | the control the whole module turns on, **and the one the 6.02 dB detector sum silently offsets** (§4-B). |
| 2 | `makeup` | ranked 2 **because it is the only control that can send this module to +18 dBFS** (measured peak 7.92) **and its doc describes a different control** (§4-A). Ranking it low would hide the batch's biggest level trap. |
| 3 | `ratio` | real, but **79 % spent by its own default** (§4-C). |
| 4 | `release` | the pump. Measured 10.3 → 1153 ms of recovery across the travel — the parameter a producer actually rides. |
| 5 | `attack` | measured t90 0.75 → 381 ms, **and it moves the ducking DEPTH by 6 dB as a side effect** (§4-D). |
| 6 | `sidecar-duck-{n}` | the PANEL… **no.** See below — this face has no audition and the panel must be rank 7. Rank 6 goes to `sc_hpf`. |
| 6 | `sc_hpf` | the detector high-pass, and **the one control that can switch the module off entirely** (measured env peak 0.0000 at 1 kHz against a 60 Hz kick). |
| 7 | `sidecar-duck-{n}` | the picture. First legal panel rank. |
| 8 | `inputLevel` | dock-only. **Prints `1.00 %` on a face** (§4-F). |
| 9 | `envMag` | dock-only. Scales the CV taps only; **already overshoots at its default** (§4-E). |
| 10 | `knee` | **LAST, and it is the honest place for it: its entire 0..24 dB travel is worth at most 1.71 dB** (§4-G). |

**⚠ THIS FACE HAS NO AUDITION, DELIBERATELY.** sidecar is an INSERT: it processes what
you patch in and produces nothing on its own. There is no note to strike. An `action`
cell here would have to synthesise a test kick, which is a different module's job.
`ShellActionCell.probe` is required precisely so that a face cannot ship a button that
reaches nothing — the right answer is not to declare one.

---

## 3. INERT AT SPAWN — except for one output that is not

Nothing patched: `audio_l_out` peak **0.000e+0**, `env_out` peak **0.000e+0** …

…and **`env_inv_out` sits at a constant 1.0000** (measured RMS 1.0000 over a 1 s
render). That is correct — `env_inv = 1 − env` and env is 0 — but it means a freshly
spawned SIDECAR is **emitting full-scale CV on one jack**. Patch `env_inv_out` into a
VCA strength and the VCA is held wide open by a module with nothing patched into it.
Worth a sentence on the faceplate; it is the kind of thing that reads as a bug the
first time you meet it.

---

## 4. WHAT THE FACE MUST MAKE VISIBLE — seven measured facts

### A. MAKEUP is not a makeup gain, and it is the biggest level hazard in the batch

`docs.controls.makeup` (`sidecar.ts:143`): *"A fixed **output** gain in dB added after
ducking (0 to 24, default 0) to bring the overall level back up."*

**Measured, with a negative control:**

| | makeup 0 | makeup 24 |
|---|---|---|
| **SC SILENT** (main only) | RMS −17.9588 dB, peak 0.20000 | RMS **−17.9588 dB**, peak **0.20000** |
| **SC PRESENT** | RMS −9.8544 dB, peak 0.67276 | RMS **+11.0906 dB**, peak **7.92447** |

With nothing in the sidechain, 24 dB of "output gain" is **bit-identical** to 0 dB. It
is a **sidechain-path gain**, applied inside the ducked branch
(`compressor-dsp.ts:276` region), and the passthrough never sees it. The doc's own word
— *output* — describes a control that does not exist here.

And it is unbounded: **peak 7.92447 = +17.98 dBFS**, with no limiter anywhere on this
module. Two knobs (`makeup` and `inputLevel`, each 0..2 / 0..24) multiply into the same
branch.

**Two separable fixes, and they are not the same PR.** (i) the doc sentence — cheap,
`docs:accept`, no audio change. (ii) whether MAKEUP *should* apply to the sum — that is
a DSP/behaviour change with an ART re-pin and an owner audition, and **it must not be
folded into the face wave.**

### B. The stereo link SUMS — a centred trigger is detected 6.02 dB hot

`mag = |fL| + |fR|`, not `(|fL| + |fR|)/2` and not `max`. *Measured*, same source, same
settings, only the panning changed:

| trigger level | centred (L = R) | LEFT only |
|---|---|---|
| −18.0 dBFS | **3.67 dB** reduction | 0.37 dB |
| −12.0 dBFS | **7.86 dB** | 3.62 dB |
| −6.0 dBFS | **12.25 dB** | 7.86 dB |

Read the diagonal: **L-only at −6 dBFS gives 7.86 dB, exactly what centred at −12 dBFS
gives.** A clean, exact 6.02 dB offset — `20·log10(2)`.

So the THRESHOLD dial is calibrated for a **hard-panned mono** trigger, and every
centred kick in every real patch trips it 6 dB early. The docs say "Detection is
stereo-linked so a transient on either main channel ducks both output channels equally
(no image shift)", which is true about the *image* and silent about the *level*.

**This is exactly the class the face exists for**: a control whose printed number is 6 dB
away from what it does in the normal case. The derived readout in §6-A prints the
effective threshold.

### C. RATIO is 79 % spent at its own default

*Measured* peak gain reduction against a 4 Hz kick train at the shipped threshold:

| ratio | 1 | 2 | **4 (default)** | 8 | 12 | 20 |
|---|---|---|---|---|---|---|
| reduction | 0.00 dB | 5.60 | **8.40** | 9.80 | 10.26 | **10.64** |

From the default to the maximum — the top 84 % of a log-tapered dial — is **2.24 dB**.
This is compression math, not a defect (reduction asymptotes at `input − threshold` as
ratio → ∞), but it is unreadable from a knob that sweeps 1..20 and the face should say
so. Same shape as treeohvox's RESONANCE, from a completely different cause.

### D. ATTACK changes the DEPTH of the duck, not just its speed

*Measured* with the step probe (a hard onset into a steady sine, threshold −30):

| attack | 0.1 ms | 1 | 5 | 10 | 50 | 200 |
|---|---|---|---|---|---|---|
| **t90** | 0.750 ms | 3.688 | 18.396 | 33.604 | 131.396 | 381.313 |
| **settled reduction** | 23.56 dB | 23.33 | 22.78 | 22.34 | 20.50 | **17.51** |

The time constants are well-scaled and correct. The second row is the finding: a slower
attack also **ducks 6 dB less deeply** on a rectified-sine detector, because the
smoother never reaches the peaks. A producer lengthening ATTACK "to let the transient
through" also quietly reduces the pump.

*(RELEASE, measured on a step-off: t-to-10 % = 10.3 / 26.1 / 232.4 / 1153.3 ms at
release 1 / 10 / 100 / 500 ms. The 2000 ms setting did not reach 10 % inside the 2.5 s
probe window — an **instrument limit**, stated rather than reported as a number.)*

### E. `env_out` exceeds 1.0 at the DEFAULT `envMag`, and the header says it does not

`sidecar.ts:20-28`: *"At envMag = 1 + reduction = 24 dB, env_out reaches 1.0. At
envMag = 2 … 2.0 (overshoot). Downstream modules MUST tolerate env_out > 1.0 **when
envMag > 1**."*

The condition is wrong: the overshoot is a function of **reduction depth**, and 24 dB of
reduction is easy to reach at `envMag = 1`. *Measured*, `envMag = 1`, step probe:

| threshold | −60 | −48 | −36 | −30 | −24 | −18 |
|---|---|---|---|---|---|---|
| settled `env_out` | **1.9774** | **1.6024** | **1.2277** | **1.0406** | 0.8537 | 0.6676 |

At `threshold −60` the CV tap reaches **1.98** and `env_inv_out` reaches **−0.98** — a
*negative* CV on a jack a player will patch into a VCA strength. The behaviour is
deliberate and documented as un-clamped; the **precondition in the doc is false**, which
is worse than no note, because it tells a reader they are safe at the default.

### F. `inputLevel` will print `1.00 %` the moment this module gets a face

The def declares `{ id: 'inputLevel', min: 0, max: 2, units: '%' }` (`sidecar.ts:112`)
while the doc says "0 to 200%, default 100%". `formatParamNumber(v, units)` returns
`` `${str} ${units}` `` (`param-format.ts:32-41`), so the value 1 renders **`1.00 %`**.

**Why this is latent today and why the face is what exposes it:** `SidecarCard.svelte`
passes **no `units` prop at all** on any of its nine faders (`:64-74`), so the card
prints bare numbers and the def's units are invisible. But `heroReadoutText` prints a
`paramId` readout through `knobValueReadout(v, …, pd.units ?? '')`
(`dock-faceplate-model.ts:406-411`) — **the face reads the def.** So promoting this
module surfaces a unit that has never been seen.

**Fix before the face, one line:** either `units: '%'` with a `format` that multiplies
by 100, or drop `units` and range 0..200. ⚠ **Check the consumer before "fixing" the
declaration** — the CLAUDE.md `curve="discrete"` precedent. Changing `max` to 200 is a
contract change that rescales every saved patch; adding a `format` is not.

### G. KNEE's entire travel is worth at most 1.71 dB — measured properly

⚠ **My first measurement said 0.09 dB and it was WRONG** — it probed at a signal level
far above the threshold, where a knee is *supposed* to do nothing. Stated because the
number looked authoritative. The honest probe sweeps the input level **across** the
threshold. Reduction in dB, threshold −18, ratio 4:

| input level | knee 0 | knee 6 | knee 12 | knee 24 |
|---|---|---|---|---|
| −30.5 dB | 0.00 | 0.00 | 0.00 | **0.36** |
| −24.4 | 0.00 | 0.27 | 0.72 | **1.71** |
| −20.9 | 1.71 | 1.74 | 2.05 | 3.01 |
| −18.0 | 3.65 | 3.67 | 3.71 | 4.37 |
| −12.0 | 7.85 | 7.86 | 7.87 | 7.95 |
| −6.0 | 12.25 | 12.25 | 12.26 | 12.29 |
| −3.1 | 14.40 | 14.40 | 14.41 | 14.43 |

The knee behaves exactly as a GMR soft knee should. Its **maximum authority anywhere in
the control space is 1.71 dB**, and above ~6 dB over threshold it is under 0.1 dB.
**NEGATIVE CONTROL, run on the same probe:** RATIO at the same input level moves
0.00 → 6.65 → 9.98 → 12.64 dB, so the probe is not blind.

That is why KNEE is ranked last: it is real, correct, and the smallest control on the
module by more than a factor of six.

---

## 5. THE FACE

```ts
face: {
  title: 'Dynamics',
  hint:
    'The MAIN pair is the trigger and passes through UNPROCESSED; the SIDECHAIN pair is what ducks. ' +
    'The detector sums |L| + |R|, so a CENTRED trigger reads 6.02 dB hotter than its own level and ' +
    'the threshold dial is calibrated for a hard-panned one. MAKEUP is a gain on the SIDECHAIN ' +
    'branch, not on the output, and nothing on this module limits.',

  order: [
    'threshold', 'makeup', 'ratio', 'release', 'attack', 'sc_hpf',   // 1-6 = the lane budget
    'sidecar-duck-{n}',                                              // panel: first legal rank is 7
    'inputLevel', 'envMag', 'knee',
  ],
  pages: [
    { id: 'detect', label: '1 · detector — reads MAIN, hears |L| + |R|',
      hint: 'The link SUMS rather than averages: a centred trigger trips 6.02 dB early (measured — ' +
            'L-only at −6 dBFS ducks the same 7.86 dB as centred at −12). SC HPF filters the ' +
            'DETECTOR only, and at 1 kHz against a 60 Hz kick the module stops ducking entirely.',
      controls: ['sidecar-duck-{n}', 'threshold', 'sc_hpf'] },
    { id: 'shape',  label: '2 · the curve',
      hint: 'RATIO is 79 % spent at its own default — 1→4 buys 8.40 dB and 4→20 buys 2.24 more. ' +
            'KNEE is worth at most 1.71 dB anywhere, and under 0.1 dB once the trigger is 6 dB over.',
      controls: ['ratio', 'knee'] },
    { id: 'time',   label: '3 · attack also sets DEPTH',
      hint: 'Measured t90 0.75 → 381 ms across ATTACK, and the settled reduction falls 23.56 → ' +
            '17.51 dB over the same travel. RELEASE recovers in 10 → 1153 ms.',
      controls: ['attack', 'release'] },
    { id: 'branch', label: '4 · the ducked branch — and the level trap',
      hint: 'INPUT LVL and MAKEUP both multiply the SIDECHAIN path and nothing after them limits: ' +
            'measured peak 7.92 (+17.98 dBFS) at MAKEUP 24. Neither touches the MAIN passthrough.',
      controls: ['inputLevel', 'makeup'] },
    { id: 'cv',     label: '5 · the CV taps',
      hint: 'ENV = reduction/24 × ENV MAG, un-clamped. At the DEFAULT ENV MAG of 1 it already ' +
            'reaches 1.98 at threshold −60, and ENV INV goes to −0.98. Unpatched, ENV INV sits at a ' +
            'constant 1.0.',
      controls: ['envMag'] },
  ],
  glyph: 'meter',

  hero: {
    cell:    'sidecar-duck-{n}',
    control: 'threshold',
    readouts: [
      { label: 'effective thr', valueId: 'sidecar-effective-threshold-db' },
      { label: 'reduction',     valueId: 'sidecar-reduction-db' },
      { label: 'branch gain',   valueId: 'sidecar-branch-gain-db' },
    ],
  },

  sidebar: [
    { kind: 'signal-flow', label: 'signal flow', stages: [
      { label: 'MAIN L/R',    role: 'generator', note: 'the trigger' },
      { label: 'SC HPF',      role: 'bus', note: 'detector only' },
      { label: '|L| + |R|',   role: 'bus', note: 'SUM — +6.02 dB on a centred source' },
      { label: 'GAIN COMPUTER', role: 'bus', note: 'threshold · ratio · knee' },
      { label: 'SMOOTHER',    role: 'bus', note: 'attack / release' },
      { label: 'MAIN PASSTHRU', role: 'bus', parallel: true, note: 'NEVER ducked, NEVER made up' },
      { label: 'SC × IN LVL × MAKEUP', role: 'bus', note: 'the only branch those two touch' },
      { label: 'SUM → OUT',   role: 'bus', note: 'no limiter' },
    ] },
    { kind: 'readouts', label: 'CV taps', entries: [
      { label: 'ENV',      valueId: 'sidecar-env-peak' },
      { label: 'ENV INV',  text: '1 − ENV, un-clamped' },
      { label: 'unpatched', text: 'ENV INV rests at 1.0' },
    ] },
  ],
}
```

**Why five bands on a nine-param module.** Because the five are five different *ideas*,
and four of them carry a measured warning that has nowhere else to live: the detector's
6 dB sum, the two spent controls, the attack/depth coupling, and the un-limited branch.
PF-21 row packing shares consecutive packable bands into one row (≤10 cells), so five
bands is not five rows.

⚠ **Band 1's label is 38 characters** (`1 · detector — reads MAIN, hears |L| + |R|`).
Label clipping is invisible to `faces-parity`. **Measure it in the dock**; the fallback
that keeps the point is `1 · detector — sums |L| + |R|`.

⚠ `title` / `hint` / band hints are ANNOTATION and paint nothing at rest
(`dock-faceplate-model.ts:90`).

⚠ **The `parallel: true` on MAIN PASSTHRU is a correctness field, not decoration.**
Drawn inline between the gain computer and the sum, the diagram would teach that MAKEUP
lifts the trigger. It does not (§4-A, measured bit-identical). This is the kickdrum
TRANSLATE precedent exactly.

---

## 6. DERIVED READOUTS

### A. `sidecar-effective-threshold-db` — the number the dial cannot print

```
effective_dbfs = threshold − 20·log10(channels_contributing)
               = threshold − 6.02   for a centred / mono-summed trigger
```
**NEGATIVE CONTROL — the knob.** `paramId: 'threshold'` prints `−18.00`; the module
starts ducking a centred source at **−24.02 dBFS**. Verified by the panning diagonal in
§4-B (L-only −6 dB ≡ centred −12 dB, both 7.86 dB reduction).
⚠ **HONESTY TERM: the readout cannot know the incoming correlation.** It must print
the *centred* case and label it, e.g. `−24.0 (centred)`, not assert a single truth. A
readout that silently assumed mono would be a second wrong number replacing the first.
**SECOND CONTROL — `threshold_cv`:** invisible to a knob readback; needs `readLive`.

### B. `sidecar-reduction-db` — the live gain reduction, in dB

Not `env_out` and not a knob: `−gainDb`, printed in dB. **NEGATIVE CONTROL — `attack`.**
A readout derived from threshold+ratio alone is invariant to ATTACK, yet the measured
settled reduction moves 23.56 → 17.51 dB across the travel (§4-D). **SECOND — `sc_hpf`:**
at 1 kHz against a 60 Hz trigger the real reduction is **0.00 dB** and every static
computation still says 8.40. This readout must come off the live envelope, which means
it needs the analyser/engine leg of the widened `FaceReadoutValue` — **until that lands
it cannot ship honestly at all, and the right move is to omit it rather than print a
static estimate.** Named here so the next author does not "fix" it into existence.

### C. `sidecar-branch-gain-db` — the level trap, as a number

```
branch_db = 20·log10(inputLevel) + makeup
```
Defaults: **0.0 dB**. At `inputLevel 2, makeup 24`: **+30.0 dB**, and the measured peak
at `makeup 24` alone is already 7.92 (+17.98 dBFS).
**NEGATIVE CONTROL — the MAIN passthrough.** The readout must NOT move when only the
main level changes, because MAKEUP provably does not touch it (measured bit-identical).
**SECOND — `input_level_cv`**, which is the CV most likely to be automated.
Print it **red above ~+12 dB**; it is the only warning this module has.

---

## 7. THE BESPOKE CELL

**LEGITIMATE — `sidecar-duck-{n}`: the transfer curve plus the detector offset.** The
GMR three-region curve (input dB → output dB) with the knee width drawn as the soft
region, the ratio as the slope, **and a second vertical rule 6.02 dB left of the
threshold marked "centred trigger"** — which is the single most useful thing this
module could draw, because it makes §4-B visible instead of surprising. Overlay the live
operating point.

No audition (§2). No other bespoke mechanism.

---

## 8. ALREADY-WRONG

- **A · `docs.controls.makeup` says "output gain"; it is a sidechain-branch gain.**
  Measured bit-identical with the SC silent. `STRICT_DOCS`. §4-A.
- **B · the `env_out` header's overshoot precondition ("when envMag > 1") is false.**
  Measured 1.9774 at `envMag = 1`. §4-E.
- **C · `inputLevel` declares `units: '%'` on a 0..2 range** — renders `1.00 %`.
  Latent only because the card drops units entirely; **a face makes it visible.** §4-F.
- **D · the card passes NO units on any of nine faders** (`SidecarCard.svelte:64-74`)
  while the def declares `dB` / `ms` / `Hz` / `%` on seven of them. The inverse of the
  usual divergence: the card is not contradicting the def, it is **ignoring** it — and
  no gate we own reads that direction either.
- **E · the card re-types every range as a literal** (`min={-60} max={0}`,
  `min={0.1} max={200}`, …, nine times) while `defaults.*` **is** def-sourced on the
  same lines. `sidecar` is not in `RANGE_BOUND_CARDS`.
- **F · `docs.explanation`'s "Detection is stereo-linked … (no image shift)"** is true
  and incomplete: it never says the link is a SUM, which is a 6 dB calibration offset.
  §4-B. `STRICT_DOCS`.
- **No dead controls.** All nine measurably move the output — including KNEE, once
  probed where a knee operates (§4-G). ⚠ **My own first KNEE measurement said 0.09 dB
  and was an instrument error**, kept in the record because the wrong number read
  exactly as authoritative as the right one.

---

## 9. COST

| | |
|---|---|
| **contract-lock** | **+1 line** (`sidecar family sidecar-duck kind=cell prefix=sidecar-duck`). No audition, so no second family. **Plus 1 if §4-F is fixed by a `format`** (a ParamDef field change is a contract change → `task docs:accept`). |
| **ART** | none from the face. `art/scenarios/sidecar/{profile,static-ratio-curve}.test.ts` and `art/baselines/sidecar/` exist. **§4-A's behaviour half — if the owner decides MAKEUP should apply to the sum — is a real audio change** needing `task art:update` + audition. **Not in the face PR.** |
| **VRT** | not in `STRICT_VRT_MODULES`; required lane unmoved. +4 informational baselines. ⚠ **`glyph: 'meter'` on a module that is silent unpatched** reads zeros under #1420's frozen-graph capture — deterministic, same as every other face. |
| **e2e** | +1 `faces-parity` row, 10 cells, **no audition probe** (§2) ≈ +16 s on one shard. |
