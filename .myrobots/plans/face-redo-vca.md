# face re-do — vca

> ⚠ **STATUS CORRECTED 2026-08-04 — read `face-redo-INDEX.md` §0 before building.**
> PF-20 (**PR #1301**) **HAS MERGED** (`c6ff9253`); every "unmerged branch" citation below
> now resolves on `main`. **`face.title` and `face.hint` do NOT paint by default** —
> `facePageHeader()` returns `null` before reading anything unless annotate mode is on
> (`packages/web/src/lib/ui/workflow/dock-faceplate-model.ts:90`), and the owner ruled on
> 2026-08-03 that `face.title` stays annotation-only. **Any argument below that parks a
> load-bearing fact in `face.hint` because it "still paints" is VOID.** PF-21 dock ROW
> PACKING (`9bf12df7`) also landed after this was written. **This re-do is NOT built** —
> the module's shipped `face` still declares no `hero` and no `sidebar`. Live backlog.
> ✅ The re-do ledger's vca defects **are FIXED** in **#1313** (`290dcdb5`): #3 (`si.smoo`
> applied to the SUM, so a 1 ms and a 5 ms attack produced a bit-identical 49.79 ms rise —
> now 0.81 ms / 4.00 ms) and #33 (the ART comment claiming "a VCA attenuates, never
> boosts"). **Any timing argument below that cites the 22.66 ms slew is now WRONG.**

**Verdict: MECHANICAL ONLY** (+ exactly one derived readout). The shipped face is already right —
its ranking is argued *and* property-tested, its band label is the gain law, and its two persistent
readouts do real vocabulary work. It needs `title` + `hint` + a band `hint` + a **2-entry readout
strip**, and it needs **no hero picture and no bespoke panel**. It must **NOT** be dropped from
`STRICT_FACES`.

> SPEC ONLY. No source touched. Designed against PF-20 (`origin/feat/faceplate-platform-v2`, PR
> #1301, unmerged) plus the two corrections in the brief. Citations are `file:line`; inferences are
> labelled in the sentence that makes them.

**Why not DROP** (the brief asked me to be willing to say it). `noise` was dropped because 1 param /
0 inputs collapses all four tiers into one (`face-specs-batch-3-noise.md` §2). vca is not that shape:
2 params, **2 inputs**, 2 outputs, and `faceTierCap` gives mini **1** vs compact/full/dock **2**
(`curated-face.ts:62-67`) — so `order` decides a real thing, pinned at `vca-gain-model.test.ts:287`.
Two harder reasons: `STRICT_FACES` **is** the migration switch (`migrated()` reads it,
`strict-faces.ts:79-81`), so dropping vca un-migrates it back to a `ModuleShellPlaceholder` with no
in-lane controls at all; and `vca-gain-model.test.ts:278` already fails with *"it was un-migrated"*.
Dropping is a regression, not a cleanup.

---

## 1. WHAT THE MODULE ACTUALLY DOES

The entire DSP is four lines (`packages/dsp/src/vca.dsp:9-12`):

```faust
process(audio, cv) = audio * gain
with { gain = base + cvAmount * cv : si.smoo; };
```

**Signal path, in the DSP's real order:** `base` and `cvAmount × cv` are summed → the **sum** runs
through a one-pole → the smoothed result multiplies the audio. `audio_inv` is a factory-side
`GainNode(-1)` tap of that output (`vca.ts:239-241`), always live.

**The response is LINEAR. There is no exponential option anywhere.** `gain` is affine in `cv`, both
params declare `curve: 'linear'` (`vca.ts:93,105`), and the model mirrors it as bare arithmetic
(`vca-gain-model.ts:74-76`). The design program's `vca response` param — the item that *would* make
the law non-linear — sits in the **DEMOTED** table
(`dx7-and-faces-design-program-2026-07-27.md:121`, *"Never fold a DSP change into a face wave"*).
So any face that draws a *curve* today is drawing a straight line. §5 turns on this.

**Is there a CV depth attenuator, and is it inert at spawn?** Yes and **yes**. `cvAmount` is a true
attenuverter (−1..1, default +1, `vca.ts:101-115`). On a bare spawn nothing is patched, so `cv = 0`
and the whole `cvAmount × cv` term is **zero for its entire travel** — the control cannot change the
gain at any setting. This is not my inference; it is the argument the def spends 30 lines on
(`vca.ts:134-153`) and it is *property-tested*, not asserted: `vca-gain-model.test.ts:299-343` reads
the mini cell **off the face**, sweeps its declared travel at the spawn state and fails if it reaches
fewer than 2 distinct gains. `base` is therefore the only load-bearing control at spawn.

**MEASURED — the number no surface prints, and the reason the face has a readout strip at all.**
`si.smoo` is `si.smooth(1 - 44.1/ma.SR)` (faust-2.85.5 `signals.lib:213`) over the standard one-pole
`y[n] = (1-s)x[n] + s·y[n-1]` (`signals.lib:369-382`). That pole is **sample-rate compensated**: τ =
22.664 / 22.665 / 22.671 ms and the −3 dB corner **7.0222 / 7.0220 / 7.0203 Hz** at 44.1 / 48 / 96 kHz
— a 0.03 % spread, so genuinely a constant, unlike noise's sample-rate-dependent brown corner.
**The CV path is a 7 Hz one-pole lowpass.** Attenuation: 1 Hz −0.09 dB, 5 Hz −1.78, 20 Hz **−9.60**,
100 Hz −23.09, 1 kHz **−43.07**. That confirms the def's claim that audio-rate CV is *"largely
filtered out rather than ring-modulated"* (`vca.ts:205`) and quantifies it for the first time — but
it also has a cost the def does not mention, which is §9.

**Load-bearing vs incidental:** `base` at every state; `cvAmount` **only once a cable reaches `cv`**.
There is no third control.

---

## 2. WHAT THE CURRENT SHIPPED FACE GETS WRONG

**Largely right, and it is worth saying so plainly.** This face was reworked *after* the design
program and deliberately overruled it twice, with the argument written down each time: `order` is
`['base','cvAmount']` (`vca.ts:162`) not the program's `['cvAmount','base']` (`design-program:678`),
on spawn-reachability; and `audio_inv`'s label is `out inv` (`vca.ts:76`) not the program's
`OUT ⌀ (phase flip)`, on a VRT font-subset argument (`vca.ts:69-71`). Both overrides are correct.
Ranges live in one model module both def and card import, guarded at source level
(`card-range-source.test.ts:77`); the page/rear `gain` id collision is intentional and pinned
(`rear-card-model.test.ts:234`).

The genuine gaps are all **PF-20 fields that did not exist when it was authored**:

- **No `face.title`, no `face.hint`.** `facePageHeader` returns `null` (`dock-faceplate-model.ts:
  67-73`), so the dock paints no header at all.
- **No band `hint`** on the single page (`vca.ts:177`).
- **No `hero`**, so no readout strip.
- **The dock is ~90 % empty.** Look at the committed baseline
  (`e2e/vrt/__screenshots__/workflow-shell-faces.spec.ts/darwin/face-vca-dock.png`): a ~1170 px band
  holding two 40 px knobs at the far left. That is the strongest argument in this file — there is
  abundant room for the strip and a sidebar column, and taking width away from *this* editor costs
  nothing.
- **The glyph does NOT flatline on a silent rack** (the brief's question). `meter` renders a
  `VuMeter`; unlit segments are drawn dimmed in their zone colours rather than hidden
  (`vu-meter-model.ts:66-70` — colour is *"independent of the live level; the level only decides lit
  vs. unlit"*), which is exactly the dim teal→amber ladder visible in the baseline. So the meter reads
  as a *scale* at rest, not as a dead rectangle. It also meters the correct port: `primaryAudioOutPortId`
  takes the first `type:'audio'` output (`shell-glyph-live.ts:95-97`) = `audio`, not `audio_inv`.

---

## 3. THE ~8 CONTROLS THAT MATTER

**This module has 2 params.** There is no top-8 to rank; the whole ranking decides one cell.

| rank | key | why it earns the rank (an argument that is WRONG for another module) | what it costs below |
|---|---|---|---|
| 1 | `base` | It is the only control that moves the gain **from the spawn state**. `cvAmount`'s term is multiplied by an unpatched input, so its entire travel is a no-op — and the `meter` glyph beside it is dark for the same reason, so the tile would offer no reachable way to make the module audible. This argument is wrong for nearly every other module, where rank 1 is "the most expressive control"; here it is "the only *reachable* one". | costs `cvAmount` the mini tile |
| 2 | `cvAmount` | The attenuverter, and the module's real mode switch (its **sign** turns an amplifier into a ducker). It returns at `compact`, one zoom step later. | — |

**THE LOSERS, NAMED.** `cvAmount` loses the mini tile only, and what is given up is real and already
documented (`vca.ts:155-160`): a meter cannot show sign, so at `mini` the face can say *"can I hear
it"* but not *"which way does the CV push"*. That is the right trade at the tier where audibility is
the question. Nothing else exists to lose.

---

## 4. BAND STRUCTURE + THE ANNOTATION PROSE

**Unchanged: one page, same id, same label.** Only a `hint` is added.

```ts
pages: [
  {
    id: 'gain',                                   // ⚠ collides with the rear group id ON PURPOSE
    label: 'gain = base + cv × amount',           // (vca.ts:167-176) — rename one, rename both
    hint:
      'the sum is NOT clamped: above 1 it boosts past unity, below 0 it passes phase-inverted — ' +
      'and the whole sum is one-pole smoothed before the multiply, so cv tracks at envelope rate ' +
      '(-3 dB at 7 Hz), never at audio rate',
    controls: ['base', 'cvAmount'],
  },
],
```

⚠ Do **not** touch `id` or `label`. `rear-card-model.ts` has **no `hint` branch** (verified: zero
matches for `hint` in that file), so a page hint cannot reach the rear card — but the id and label
are load-bearing on both surfaces and are pinned at `rear-card-model.test.ts:218,234` and
`vca-gain-model.test.ts:358-361`.

**Does the face read correctly with every hint hidden?** **Yes, and it is the one face in the set
that was already built that way.** The band *label* is the gain law itself, and the two persistent
knob readouts carry the vocabulary the numbers cannot: `CLOSED` / `-12 dB` / `UNITY` on `base`
(`vca-gain-model.ts:148-157`) and `OPEN` / `CV OFF` / `DUCK` on `cvAmount` (`:115-117`). With
annotation off, a player still reads the law, still learns the VCA spawns shut, and still learns
which way the CV pushes. The hint adds only the *unclamped* and *bandwidth* facts — and the readout
strip in §5 carries both of those with annotation off, which is precisely why the strip exists.

---

## 5. THE HERO + THE READOUT STRIP

### No bespoke `hero.cell` — and the transfer-curve picture is DECORATION

The brief asks directly. The answer is no, on three independent grounds:

1. **Every candidate picture is a straight line.** The input→output transfer curve of a pure
   multiplier is a line through the origin of slope `gain` — for *every* setting, because the module
   is linear in the input by construction. The cv→gain curve is *also* a line (`slope = cvAmount`,
   `intercept = base`). A picture with exactly two degrees of freedom, both of which are the two
   dials sitting directly under it, is the derived-readout trap wearing a graphic.
2. **The picture the design instinct wants requires the DEMOTED DSP param.** A transfer graph earns
   its place when the *shape* changes — i.e. once `vca response` (lin/exp) exists
   (`design-program:121`). Building the panel now and the param later inverts the order; building
   both now violates brief rule 7. **State it as the follow-up's UI, not as this wave's content.**
3. **It would cost the live meter.** `heroGlyph = hasGlyph && !(view === 'dock-full' && hero?.cell)`
   (`ModuleShell.svelte:353`, platform branch): a hero `cell` **suppresses the dock glyph**. Trading
   a live RMS meter of the actual output — on a module whose entire job is *"how loud right now"* —
   for a static line-graph of two knob values is a straight downgrade. A hero with only `readouts`
   keeps the meter.

It would also cost a `ControlFamily` = **a real contract-lock line** (the `noise` spec priced the
same cell at +1: *"noise family noise-taps kind=cell"*), plus a component, plus a `docs.controls`
entry (vca is in `STRICT_DOCS`, `strict-docs.ts:43`). Zero of that buys a picture of a line.

### No `hero.control`, no `hero.action`

- **`control`**: promoting `base` **removes it from the band** (`heroFacePlan` moves, never copies —
  `dock-faceplate-model.ts:122-155`), leaving a one-knob band — the single-control page the design
  program convicts elsewhere — and breaks the def's reason for keeping `pages` in function order:
  the band reads left-to-right in the same order as the law printed above it (`vca.ts:163-166`).
- **`action`**: a VCA makes no sound of its own, so there is nothing to audition without
  synthesising a test tone — a new family + factory work on the module whose job is transparency.

### THE READOUT STRIP — 2 entries (correction 1: full-width, directly under the meter)

```ts
hero: {
  readouts: [
    { label: 'at cv 1',   valueId: 'vca-gain-at-full-cv' },
    { label: 'cv tracks', text: '-3 dB at 7 Hz' },
  ],
},
```

**Two, not three, and that is the honest answer.** The brief forbids a readout that repeats the knob
under it. `base` *is* the gain at cv 0, so a `CV 0` entry is `readout-base` printed twice. And the
obvious third idea — a `PHASE: NORMAL / INVERTS` entry — is **fully redundant**: `base ≥ 0` always,
so the sweep crosses zero **iff** `base + cvAmount < 0`, i.e. iff entry 1 is negative. Naming that
rejection because it is the tempting one. (Precedent: the `noise` spec rejecting a spectral-slope
readout, §4.) A real strip of 2 beats a padded strip of 4.

**`vca-gain-at-full-cv` — FORMULA, traced to the DSP.**
`vcaGain(base, cvAmount, 1)` = `base + cvAmount` — `vca-gain-model.ts:74-76`, which mirrors
`vca.dsp:11` and is deliberately **unclamped exactly like the DSP** (`vca-gain-model.ts:64-67`).
Printed relative to unity: `CLOSED` at |g| < `VCA_DISPLAY_EPS`, `UNITY` at |g−1| < eps, else
`±d.d dB` with an explicit `+` for boost, suffixed ` INV` when `g < 0`. Worked: (0, +1) → `UNITY`;
(0.5, +1) → `+3.5 dB`; (0, −1) → `0.0 dB INV`; (0.5, −1) → `-6.0 dB INV`; (1, +1) → `+6.0 dB`.

⚠ **`LANE_KCOL_MAX_PX` does NOT apply here.** The 7-glyph budget that shapes `formatVcaBase`
(`vca-gain-model.ts:132-146`) is a *lane knob column* constraint; the hero strip is dock-only and
full-width under correction 1. A builder will assume it carries over — it does not, and this is the
module in the repo most likely to make that mistake.

**WHY IT IS DERIVED, not a knob readback.** It is the exact kickdrum-`tail` shape one level down:
each knob readout is individually correct and blind to the other, and their *sum* is the module's
clip risk. The def's own `docs.controls.base` tells a user to *"raise it to leave some dry signal
under modulation"* (`vca.ts:214`) — do that to 0.5 with the default `cvAmount = 1` and the VCA now
reaches **+3.5 dB past unity** at every envelope peak, on a gain the def states is unclamped
(`vca.ts:209`). `base` prints `-6.0 dB`; `cvAmount` prints `OPEN`. Nothing on any surface says 1.5.

**THE NEGATIVE CONTROLS** (permanent home: a new `describe` in
`packages/web/src/lib/audio/vca-gain-model.test.ts` — already pure, unit-lane, zero-flake):

| leg | perturbation | a knob readback | the derived readout |
|---|---|---|---|
| 1 · blind to `cvAmount` | hold `base = 0.5`, move `cvAmount` 1 → 0.5 | `readout-base` = `-6.0 dB` **both times** | `+3.5 dB` → `0.0 dB` — **must move** |
| 2 · blind to `base` | hold `cvAmount = 1`, move `base` 0 → 0.5 | `readout-cvAmount` = `OPEN` **both times** | `UNITY` → `+3.5 dB` — **must move** |
| 3 · the ORACLE | sweep a grid of (base, cvAmount) | — | must equal `linearToDb(vcaGain(b, a, 1))`, so the readout is pinned to the DSP law and not to its own table (the pattern `vca-gain-model.ts:70-73` already uses for `vcaCvSense`) |

**Why `cv tracks` is `text` and not a `valueId`.** It is a constant — 7.0222 / 7.0220 / 7.0203 Hz
across 44.1 / 48 / 96 kHz, because `si.smoo`'s pole carries an `ma.SR` term (`signals.lib:213`). A
`valueId` would be false precision, and the registry's reader is params-only anyway
(`face-readout-values.ts:45`), so it could not see the sample rate even if the number moved. This is
the *opposite* of noise's brown corner, which genuinely doubles at 96 k.

---

## 6. THE SIDEBAR — one `signal-flow` block, justified by exactly one stage

```ts
sidebar: [
  {
    kind: 'signal-flow',
    label: 'signal flow',
    stages: [
      { label: 'AUDIO IN',        role: 'bus' },
      { label: 'BASE + CV × AMT', parallel: true, note: 'the gain sum — unclamped' },
      { label: 'SMOOTH',          parallel: true, note: 'one-pole, -3 dB at 7 Hz' },
      { label: '× GAIN',          role: 'bus',    note: 'the multiply' },
      { label: 'OUT',             role: 'bus' },
      { label: 'OUT INV',         role: 'bus', parallel: true, note: '× -1 tap, always live' },
    ],
  },
],
```

**The whole justification is the `SMOOTH` stage.** Delete it and the diagram is `in → × → out`, which
is furniture. Keep it and the diagram states the two facts nothing else on the face can: the pole sits
on the **summed gain** (so it lowpasses the CV *and* the knob) and it sits **before** the multiply.
That answers the module's two most-asked questions — *why doesn't audio-rate CV ring-modulate* (43 dB
down at 1 kHz) and *why is my pluck soft* (§9). The gain stages are `parallel` because they are a
control branch, not links in the audio chain; drawing them inline would teach that the CV passes
*through* the audio path. `OUT INV` is `parallel` for kickdrum's `TRANSLATE` reason — a tap, not a
link — and it is the module's most undiscoverable feature, since that jack lives only on the **rear**
card (`vca.ts:76`).

**The layout argument, specific to this module:** a sidebar normally costs the editor width. Here the
editor holds two 40 px knobs in a ~1170 px band, so the column is free — it converts dead space into
content.

**No other block.** `presets` on a 2-param module is a list of coordinate pairs; a `readouts` block
duplicates the strip; a `custom` panel means a new registry entry (`stereo-crossover` is the only id
today, `sidebar-panels.ts:53-59`) for the straight line already rejected in §5.

**Full declaration** (everything else on `face` unchanged):

```ts
title: 'Amplifier',
hint:
  'Multiplies the audio input by base + cv × amount — it spawns CLOSED, silent until CV arrives ' +
  'or BASE is raised, and a phase-inverted copy of the output is always live on OUT INV.',
```

---

## 7. RANGE / CURVE / VOCABULARY CHANGES

**NONE.** No `min`/`max`/`curve`/`options`/`landmarks`/`format`/`units` moves.

**Card grep for re-typed ranges — clean, by construction.** `VcaCard.svelte:49-50` binds every
numeric prop through `paramSpec(vcaDef, …)` (`:30-31`). **Zero hardcoded range literals** — the only
literal in the file is `.vca-card { width: 160px }` (`:56`), which is not a range. The card
previously *did* re-type all six numbers (`vca-gain-model.ts:9-15`); hoisting them into the model
module fixed it, and `card-range-source.test.ts:77` guards it at source level *including* the
`formatValue` omission a textual matcher cannot see (`VcaCard.svelte:20-29`). Nothing to report in
either the AGREES-hazard or DISAGREES-bug column.

---

## 8. COST

| | |
|---|---|
| **contract-lock** | **ZERO.** The block is 7 lines (`contract-lock.txt:3464-3470`) and every added field — `title`, `hint`, `pages[].hint`, `hero`, `sidebar` — is UI metadata with no `contract-signature` branch (`vca.ts:82-85`; `types.ts` PF-20 header). No new `ParamDef`, `PortDef`, `ControlFamily` or `edge:`. |
| **VRT — MOVES** | `face-vca-dock` **darwin + linux** (header rows + strip + sidebar column). ⚠ Both baselines are committed and neither is exempt, so the diff will be **large** — `git rm` both and dispatch `vrt-update.yml` rather than relying on `--update-snapshots`, which cannot rewrite a passing-but-stale snapshot (CLAUDE.md). |
| **VRT — must NOT move** | `face-vca-compact` (all PF-20 fields are dock-only; `facePageHeader` → `null` at lane tiers). `vca.png` — the legacy card, and vca **is in `STRICT_VRT_MODULES`** (`vrt-exemptions.ts:907`), i.e. the **REQUIRED** lane; the card is untouched. `rear-vca` — `face.rear` untouched and `rear-card-model.ts` has no `hint` branch. **A surprise diff on any of these three is a finding, not a re-pin.** |
| **e2e** | faces-parity cell count **unchanged** (2 params; the hero promotes nothing, so `heroFacePlan` moves no key and `heroFacePlanIsTotal` is trivially satisfied). `workflow-shell-faces.spec.ts:48` `{ type: 'vca', pages: 1 }` unchanged. No new spec — `vca-face.spec.ts` already covers the readouts and stays green. |
| **CI wall-time** | **≈ +5 ms.** One `describe` added to an existing pure unit file already in the lane; one registry entry. No new browser boot, no new e2e, no new VRT *scene* (two existing baselines re-captured). |
| **ART** | **NIL, confirmed not assumed.** No face field can reach `vca.dsp`, and the pin is SHA-gated on that file (`art/scenarios/vca/profile.test.ts` → `dspSourceSha('vca.dsp')`). `art/baselines/vca/*` and `vca-invert/*` untouched. |
| **attest** | **NIL, confirmed.** vca is an AUDIO def → not in the WebGL basis, so no `docs-hash-ignore` markers. `packages/web/src/lib/audio/modules/vca.ts` is not in `COLLAB_DIR_ROOTS` or `COLLAB_STANDALONE_SOURCE` (`collab-attest-lib.ts:53-89`) → no collab re-attest. |

---

## 9. DEFECTS FOUND IN SHIPPED CODE

*(Follow-up bugs. Not spec content. The first is a DSP change and needs its own owner-audition PR.)*

**A · `si.smoo` is applied to the SUM, so the VCA cannot pass a fast envelope. — `vca.dsp:11`**
`gain = base + cvAmount * cv : si.smoo` smooths the whole gain including the CV term. `si.smoo` is
Faust's **knob de-zipper**; the CV path is already a continuous signal and needs none. Simulated
(one-pole, s = 1 − 44.1/48000, 48 kHz):

| driving CV | VCA gain 10–90 % rise | gain reached at end of the attack |
|---|---|---|
| ideal step | **49.81 ms** | — |
| 1 ms ADSR attack | **49.79 ms** | 0.021 |
| 5 ms ADSR attack | **49.79 ms** | 0.102 |
| 20 ms ADSR attack | 52.69 ms | 0.335 |
| 50 ms ADSR attack | 64.69 ms | 0.596 |

A 1 ms and a 5 ms attack produce the **identical** 49.79 ms result — the module is bit-for-bit blind
to any attack under ~20 ms. **Cost to a user:** no percussive envelope survives this VCA; a pluck or
a kick shaped by ADSR→VCA comes out as a ~50 ms soft swell, and the ADSR's ATTACK knob does nothing
over its bottom third. **Likely fix (needs owner ears + an ART re-pin):**
`gain = (base : si.smoo) + cvAmount * cv` — de-zip the knob, which genuinely steps at block rate,
and leave the CV alone. **Could a test catch it?** Not today: the ART profile measures `openRms`
over 0.05–0.45 s and `shutRms` over 0.7–1.0 s (`art/scenarios/vca/profile.test.ts:62-63`), both
windows ≫ τ = 22.7 ms, so the slew is *structurally* outside every assertion. A rise-time assertion
on a step-driven render would catch it and costs nothing.

**B · An ART comment states a module property that is false. — `art/scenarios/vca/profile.test.ts:68`**
*"Peak never exceeds the input (gain ≤ 1) — a VCA attenuates, never boosts."* The def says the
opposite and is right: the gain is unclamped and sums above 1 boost past unity (`vca.ts:209`;
`vca-gain-model.ts:64-67`). It is true *of this scenario* (base 0, cvAmount 1, cv ≤ 1) but is written
as a general claim, and the next person to widen the scenario will trust it. Comment-only fix.

**C · `formatVcaCvAmount` is blind to `base`, so `DUCK` can mean "inverts". — `vca-gain-model.ts:115-117`**
At `base = 0, cvAmount = −1` the readout prints `DUCK`, but there is nothing to duck: gain sweeps
0 → −1, so the output gets *louder* and phase-inverted. The readout is correct about the
*derivative* (raising cv does lower the gain) and blind to whether the result stays non-inverting.
**Not filed as a bug** — the model documents exactly this scope (`:110-114`, *"names direction,
never amount"*) — but it is the same one-sided-contract shape a level up, and the `at cv 1` readout
in §5 is its fix: at that state the strip prints `0.0 dB INV` while the dial still says `DUCK`.

Nothing else found. The def, the model module, the card and both test files are unusually clean.

---

## 10. VERIFICATION GATE

```sh
# 1. the model + the face ladder + THE NEW NEGATIVE CONTROLS (§5, legs 1-3)
REPEAT=3 flox activate -- task test:one -- vca-gain-model
# 2. lint: readouts name one source, the valueId resolves, heroFacePlanIsTotal holds
flox activate -- task test:one -- module-face-lint
flox activate -- task test:one -- dock-faceplate-model
# 3. the surfaces the page id/label must NOT disturb
flox activate -- task test:one -- rear-card-model
flox activate -- task test:one -- card-range-source
# 4. the shipped bespoke spec — must stay green untouched
flox activate -- task e2e:serve
REPEAT=3 flox activate -- task e2e:one -- tests/vca-face.spec.ts
flox activate -- task e2e:one -- faces-parity --grep vca
# 5. VRT. face-vca-dock MOVES; the other three MUST NOT (§8).
flox activate -- task vrt:one -- face-vca   # inspect BOTH dock and compact diffs
flox activate -- task vrt:one -- rear-vca   # expect ZERO diff
flox activate -- task vrt:one -- vca        # REQUIRED lane — expect ZERO diff
flox activate -- task e2e:stop
# then: git rm the two face-vca-dock baselines, dispatch vrt-update.yml -f platform=linux
```

**The negative control is not optional and is not a one-off.** Leg 1 of §5 is what distinguishes
`vca-gain-at-full-cv` from `{ paramId: 'base' }`, and it must live in `vca-gain-model.test.ts`
permanently — the same way `kickdrum-face-model.test.ts` perturbs SUB LEVEL forever.
