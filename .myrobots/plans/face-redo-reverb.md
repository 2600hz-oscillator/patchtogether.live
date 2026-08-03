# face re-do — reverb

**Verdict: REAL REWORK** — but a much *smaller* one than round-2 proposed: the shipped 3-knob ranking is right and stays, `diffusion` is REJECTED out of this wave (no DSP edit, no card edit, no ART re-pin), and the real work is the PF-20 declaration (title/hint/hero/**readout strip**/sidebar), the 2→1 band merge, and **two `ParamDef.format` functions that make SIZE and DAMP print physics instead of a 0..1 fraction** — all at ZERO contract cost.

---

## 1. WHAT THE MODULE ACTUALLY DOES

Three short files: `reverb.ts` (164 lines), `packages/dsp/src/reverb.dsp` (**19** lines), `ReverbCard.svelte` (39 lines). The DSP is one stdlib call.

**The graph, in the DSP's real order** (`reverb.dsp:12-18` → `reverbs.lib:739-740`, faust-2.85.5 `share/faust/reverbs.lib`; the npm `@grame/faustwasm` VFS carries the byte-identical line — round-2 extracted the same text from `libfaust-wasm.data`):

```
mono_freeverb(fb1,fb2,damp,spread) =
  _ <: par(i,8, lbcf(combtuningL(i)+spread, fb1, damp))                 -- 8 PARALLEL combs
    :> seq(i,4, fi.allpass_comb(1024, allpasstuningL(i)+spread, -fb2))  -- 4 SERIES allpasses
```

`audio` fans to **eight** lowpass-feedback combs; `:>` **sums them with no scaling**; the sum runs **four** Schroeder allpasses in series; `reverb.dsp:12` blends that against a dry tap (`audio * (1.0 - mixSm) + wet * mixSm`). **Mono in, mono out — one tank, not two.** The stereo sibling (`reverbs.lib:797`) is what would need `spread`; we do not call it.

**The comb, exactly** (`reverbs.lib:760`):

```
lbcf(dt, fb, damp) = (+ : @(max(0, dt-1))) ~ ( *(1-damp) : (+ ~ *(damp)) : *(fb) ) : mem;
```

`~` supplies the missing sample, so the loop delay is exactly `dt`. The feedback chain is a one-pole `H(z) = (1-damp)/(1 - damp·z⁻¹)` — **unity at DC by construction** — then `*(fb)`. So the loop magnitude is

> **g(ω) = fb1 · (1 − damp) / √(1 − 2·damp·cos ω + damp²)**

which is the whole module in one line; every claim below reads off it.

**Taps are FIXED and SR-adapted** (`reverbs.lib:744-751,762-763`, `adaptSR(v) = v*ma.SR/44100 : int`): at 48 kHz the 8 taps are `1214,1293,1389,1475,1547,1622,1694,1760` = **25.29 … 36.67 ms** (verified numerically). The *times* are SR-invariant; `reverb.ts:16-17` is correct.

**What each control genuinely does:**

- **`size`** (`reverb.dsp:14`, `fb1 = (0.5 + 0.45*size) : si.smoo`) — **not a room size**: it sweeps comb feedback 0.50→0.95, i.e. decay TIME. Modal colour, density and the 25 ms onset are identical at both ends. LOAD-BEARING; biggest perceptual mover.
- **`damp`** (`reverb.dsp:16`) — the one-pole coefficient *inside* every comb loop. Because that one-pole is unity at DC, **damp cannot shorten the low-frequency tail at all**; it removes highs, progressively, once per round trip. At `damp = 1` the loop opens and only the allpasses ring (~0.14 s). LOAD-BEARING and the module's most misunderstood knob.
- **`mix`** (`reverb.dsp:12,17`) — a **LINEAR** crossfade. *Verified*: the round-2 delay spec's claim that reverb leads with `mix` because its crossfade is linear (where delay's is equal-power, `delay.ts:185-193`) is TRUE — though the citation should be `reverb.ts:96` (the `order`), not `:99`.

**Nothing is inert at spawn and there is nothing to enter**: no modes, no CV, no families, no statics, no momentary, no `paramCells`. `si.smoo` on all three (`reverb.dsp:14,16,17`) initialises at 0, so for ~23 ms after a spawn the tank is dead and the output fully dry — benign, but the pinned ART capture starts at sample 0 (`art/scenarios/reverb/profile.test.ts:30-32`), so that ramp is *inside* the baseline.

**Measurable facts worth printing** — all derived from g(ω), all cross-checked against the def's own ladders:

| fact | closed form | at defaults (size .5 / damp .3, 48 kHz) |
|---|---|---|
| low-band T60 (damp-invariant) | `−3·τmax / log10(fb1)`, τmax = 36.67 ms | **0.79 s** |
| 1 kHz T60 | `−3·τmax / log10(g(2π·1000/SR))` | **0.78 s** → **0.19 s** at damp 0.95 |
| wet-leg broadband gain | `10·log10( 8·⟨1/(1−g(ω)²)⟩_ω )` | **+10.6 dB** |
| onset (built-in pre-delay) | shortest comb tap | **25.3 ms**, fixed forever |

**The low-band T60 formula is validated, not asserted.** Against the five damp-0 figures the def documents (`reverb.ts:128`: 0.33 / 0.46 / 0.71 / 1.28 / 4.4 s at size 0/.25/.5/.75/1) it predicts 0.365 / 0.517 / 0.788 / 1.428 / 4.938 — a **constant ratio of 1.107 / 1.123 / 1.109 / 1.116 / 1.122** across a 13× span. A wrong model does not track to ±0.8 % over 13×; the uniform 1.115 is the Schroeder-T30×2 estimator's own offset (it fits the early decay, where the seven shorter combs still contribute). The wet-gain formula is cross-checked the same way: the def's three mix figures (`reverb.ts:132`: +2.4 / +5.7 / +11.4 dB at mix .3/.5/1) are *mutually* consistent with exactly one wet amplitude gain, **+11.4 dB**; the formula returns +10.6 dB.

---

## 2. WHAT THE CURRENT SHIPPED FACE GETS WRONG

The face (`reverb.ts:95-113`) is **largely right and honestly argued** — the rank rationale (`:66-82`), the `meter` glyph argument (`:89-94`) and the rear curation (`:104-112`) all hold. Reverb has zero CV inputs, so `byPage` is empty and the rear plan is one band + the outputs rail; **change nothing there**. The genuine gaps:

1. **No `title`, no `hint`, no `hero`, no `sidebar`** — authored before PF-20. The dock faceplate is a bare stack of two band headers.
2. **`output blend` (`:99`) is a one-knob house-template band**, copied verbatim across four defs. Delay already dropped it (`delay.ts:259-262`; `workflow-shell-faces.spec.ts:66` already reads `delay, pages: 1`). Reverb still carries it.
3. **Both tank dials print a meaningless number.** `SIZE 0.50`, `DAMP 0.30` are raw coefficients. `docs.controls.size` (`:128`) opens *"The decay TIME, despite the name"* — the documentation apologises for the control surface. `ParamDef.format` (`types.ts:400-410`) has been on main since PF-3 and reverb declares none.
4. **The module's one real hazard has nowhere to live.** The unscaled wet leg is stated *four* times in prose (`:22-25, 117, 124, 132`) and *zero* times on the faceplate. Under correction 2 a band hint would not paint, and the brief forbids smuggling it into a band LABEL — so round-2's proposed header `'reverb tank → blend · the wet leg runs +10..+18 dB'` is out. It has to become a **readout**.

Checked and fine: page id `tank` does not collide with the leading rear group id `signal` (`:111`), so the dx7 double-band scar (`module-face-lint.test.ts:836`) does not apply — and must not be "fixed" by renaming the page to `signal`.

---

## 3. THE ~8 CONTROLS THAT MATTER

**This module has THREE params** — no top-8 to select. Ranks 1-3 are **UNCHANGED** from `reverb.ts:96`; presenting an identical array as a redesign is the anti-pattern. What follows is why each rank survives adversarial re-derivation.

| rank | key | why it earns the rank (an argument that is WRONG elsewhere) | cost below |
|---|---|---|---|
| 1 | `mix` | No wet fader exists, so MIX *is* "how much reverb" — and because the crossfade is LINEAR into a leg **+10.6 dB hotter** (§1), it is the only control that can clip a downstream stage. **On delay the same param is rank 3**, precisely because delay's mix is equal-power (`delay.ts:185-193`) and therefore not level-critical. Same name, opposite rank; the difference is one DSP line. | forces `size` off the mini tile |
| 2 | `size` | The decay time; biggest perceptual mover (0.37 s → 4.9 s low-band). Second because a reverb you cannot *hear* is worse than one whose tail is the wrong length. | forces `damp` off the compact tile (cap 2 with a glyph) |
| 3 | `damp` | Bounded tone-plus-second-decay; set-and-forget. **On shimmershine the same param would be rank 2** — there `damp = 1` collapses the tank whatever DECAY says, a panic button. Here it still leaves the allpasses ringing: a trim, not a cliff. | — |

**THE LOSERS, NAMED** — both are *rejected new params*, not demoted existing ones.

- **`diffusion` (the `fb2 = 0.5` literal at `reverb.dsp:15`)** — REJECTED from this wave. It is a Faust rebuild + ART re-pin, which the design program's own recipe forbids folding into a face PR (`dx7-and-faces-design-program-2026-07-27.md:1414-1417`: *"Never fold a DSP change into a face wave"*) even while its Batch-B bullet at `:748-752` lists it; round-2 adopted `:748` and was silent on `:1417`. Rejecting it removes at a stroke: the mandatory 4th `<Fader>`, the card widening, the **required-lane** `vrt.spec.ts/*/reverb.png` move, the ART byte-identity gamble, the `landmarks`-on-a-Fader impossibility (`Fader.svelte` has zero landmark support), and the **`full`-tier glyph cliff** (`laneBodyPlan`, `module-shell-model.ts:341-345`: at 3 controls `rows = ceil(3/3) = 1` so the glyph renders; a 4th makes `rows = 2` and the meter silently vanishes from the lane plate). It belongs in its own owner-audition PR, with range `0..0.95` not `0..1`, for the DC-integrator reason round-2 correctly derived.
- **`room` (Faust `spread`)** — REJECTED, and **the design program's argument holds and is in fact stronger than it states** (`plan:120`). Two legs verify directly: `spread` is documented *"spatial spread in number of samples"* (`reverbs.lib:722`) and is the **stereo decorrelation** parameter (`stereo_freeverb` passes `0` left / `spread` right, `:797`), so on a mono tank it is a uniform offset. The third leg is *understated*: `combtuningL(i)` is already `: int` (`:763`) and the delay primitive takes an integer index, so **`+ 0.5` truncates away entirely — `reverb.dsp:18`'s literal `0.5` is a NO-OP, bit-identical to `0`** (inferred from Faust's float→int delay-index cast; the arithmetic is +0.5 on an integer tap). A 0..1 knob would be a knob with two states, one of them ±1 sample = 20 µs. Never, as specified.

---

## 4. BAND STRUCTURE + THE ANNOTATION PROSE

One band. `mix` is listed here and **promoted out by `heroFacePlan`** (a hero promotes, it does not copy — `dock-faceplate-model.ts:127-157`).

```ts
title: 'Room',
hint: 'Freeverb’s mono tank — eight damped combs into four allpasses, then a linear dry/wet blend. The wet leg is not level-matched to the dry.',
pages: [
  {
    id: 'tank',
    label: 'the tank',
    hint:
      'Eight comb filters in PARALLEL, each recirculating through its own one-pole lowpass, then ' +
      'four allpasses in SERIES. The comb taps are fixed at 25–37 ms and never move: SIZE sets how ' +
      'much of each loop comes back (0.50 → 0.95), not how big the room is, and DAMP is the lowpass ' +
      'inside that loop — it takes the top off the tail without touching the bottom, so a heavily ' +
      'damped tail is shorter AND lower, never just darker.',
    controls: ['size', 'damp', 'mix'],
  },
],
```

**Does this read correctly with every hint hidden?** Yes, by design. With annotation off a player sees the title/hint pair (carrying the level warning in one clause), the hero MIX dial, a strip reading `tail 1k · 0.78 s | wet · +10.6 dB | onset · 25 ms`, a band called *the tank* holding SIZE (printing **`0.79 s`**, not `0.50`) and DAMP (printing **`10.6 kHz`**, not `0.30`), and a sidebar diagram showing 8 parallel / 4 series. Every load-bearing fact — tail length, damping corner, hot wet leg, fixed onset, topology — is carried by a **number or a picture**, never by a sentence. The band hint adds depth when annotation is on; it carries nothing the face needs.

---

## 5. THE HERO + THE READOUT STRIP

**No bespoke `hero.cell`. The generic `glyph: 'meter'` stays and is NOT suppressed** (a hero cell would suppress it — `types.ts:697-700`). The candidate picture was a two-line decay plot (LF + 1 kHz slopes off a marked 25 ms onset); I reject it because its whole information content is *two numbers*, and two numbers are what the strip prints exactly — a curve you eyeball is strictly worse than the value. It would also cost a `ControlFamily` (contract lines, brief rule 6) plus a panel component and a `shell-cells` registration, on the one module whose thesis is "three knobs and no menu". The live meter does the one thing no static graph can: show the **actual** tail on the **actual** signal and warn about the hot wet leg in real time — the argument already in the def at `:89-94`.

**`hero.control: 'mix'`** — rank 1, the only level-critical control, the knob a hand reaches for on every send and insert. Promoting it also *empties* the old `output blend` page, so the 2→1 merge is forced rather than chosen.

**`hero.action`: NONE.** Reverb is a processor with no internal source: there is nothing to audition, because with nothing patched there is nothing to make wet. ⚠ That is a **design** fact, not a platform limit — I am explicitly not repeating the round-2 false blocker: `getActiveEngine()` (`engine-ref.ts`) is reachable from plain `.ts` and an `action` could drive the engine. An audition here would have to *inject a test impulse into another module's input*, a new engine capability, not worth it for a module that is audible the instant you patch it.

### THE READOUT STRIP (correction 1) — three entries

```ts
readouts: [
  { label: 'tail 1k', valueId: 'reverb-t60-1k' },
  { label: 'wet',     valueId: 'reverb-wet-gain' },
  { label: 'onset',   text: '25 ms' },
],
```

**Does an RT60 readout survive? YES — per band. NO — as a single broadband scalar.**

- **Exactly solvable.** For any frequency the tail is dominated asymptotically by the *slowest* comb (longest tap, τmax = 1617/44100 = 36.667 ms, SR-invariant):

  > **T60(f) = −3 · τmax / log₁₀( fb1 · (1−damp) / √(1 − 2·damp·cos(2πf/SR) + damp²) )**, **fb1 = 0.5 + 0.45·size**

  traced line by line to `reverb.dsp:14` (fb1) and `reverbs.lib:760` (the loop) + `:751` (τmax).
- **NOT solvable in closed form** is the *broadband* T60 the def documents. The tank is a sum of eight exponentials times a frequency-dependent loop gain; the n-th echo's energy is the n-fold self-convolution of a one-pole, whose energy integral is hypergeometric — and the def's numbers are additionally a Schroeder **T30×2** *estimator*, not a T60. I checked whether one reference frequency could reproduce the measured ladder: size 0.5 needs f\* ≈ 4.5 kHz, size 1 needs f\* ≈ 1.5 kHz. There is no single f\*. **I am not inventing one.**

So the strip prints the mid-band number and the SIZE dial (§7) prints the low-band one — a bracket, both exact, neither pretending to be the perceived average.

**`reverb-t60-1k`** — the equation above at f = 1000 Hz, from `$lib/audio/reverb-tank-model` (new; the `ringback-crush-model` precedent, §7).

**NEGATIVE CONTROL (permanent, `reverb-tank-model.test.ts`), three legs:**
1. **MOVES on `damp`, which a knob readback is blind to.** At size 1, damp 0 → 0.95 drives the readout **4.94 s → 0.24 s** (20×). `{ paramId: 'size' }` cannot move at all. This is the leg that makes the readout a derivation rather than a relabelled dial.
2. **MUST NOT MOVE on `damp` at the LF limit** — the same model function at f = 0 is *provably* damp-invariant (the one-pole is unity at DC), so the test asserts `t60(size, 0, 0) === t60(size, 0.95, 0)` exactly. An implementation that accidentally damped the whole spectrum fails here, and only here.
3. **MUST NOT MOVE on `mix`** — mix is outside the tank (`reverb.dsp:12` blends *after* `mono_freeverb`), so the model does not take it; a signature change that leaked it in goes red.

Plus an **instrument validation** that is not a tautology: the LF formula must track the def's five documented damp-0 measurements (`reverb.ts:128`) at a **constant ratio inside 1.09…1.14 across the whole travel**. That fails if either the formula or the documented ladder drifts.

**`reverb-wet-gain`** — `10·log₁₀( 8 · (1/π)∫₀^π dω / (1 − g(ω)²) )`: the eight combs' broadband power gain (the allpasses are unity-magnitude and contribute nothing). At `damp = 0` it collapses to the exact closed form **8/(1 − fb1²)**. ⚠ **This one carries a model assumption I could not fully close** — it treats the eight comb outputs as mutually uncorrelated. It returns +10.6 dB at defaults against the def's independently-derived +11.4 dB, and +19.1 dB at size 1 / damp 0 against the def's *"about +18 dB"* (`reverb.ts:24`). **MANDATORY before ship:** calibrate against `renderFaustOffline` at four (size, damp) corners in the ART lane and assert **±1.5 dB**. If it misses, downgrade to `{ label: 'wet', text: '+10…+19 dB' }` — the def's own measured range, honest and static — rather than shipping a confident wrong number. **NEGATIVE CONTROL:** damp 0 → 0.95 at size 1 must fall **+19.1 → +9.3 dB** (a `size` readback is blind to it); `mix` must not move it.

`onset` is a `text` literal because it genuinely never changes — 25.3 ms is the shortest comb tap and no control reaches it. It is the fact that most distinguishes this module from CLOUDSEED (which has a real PRE-DELAY), and a strip is where a permanent fact belongs.

**Rejected from the strip:** `{ paramId: 'mix' }` (repeats the hero dial directly above — the brief's noise rule); `{ paramId: 'size' }` / `{ paramId: 'damp' }` (repeat the band-1 dials, which after §7 print the same numbers through the same ladder).

---

## 6. THE SIDEBAR

Two blocks. No `custom` (nothing needs a bespoke picture; `stereo-crossover` is the only registered panel and is irrelevant to a mono tank). No `readouts` block — correction 1 moved the numbers into the strip and a sidebar copy would be the same value twice.

```ts
sidebar: [
  { kind: 'signal-flow', label: 'signal flow', stages: [
    { label: 'IN',           role: 'bus', note: 'mono' },
    { label: '8 × COMB',     role: 'bus', note: 'parallel · 25–37 ms, fixed' },
    { label: 'SUM',          role: 'bus', note: 'unscaled' },
    { label: '4 × ALLPASS',  role: 'bus', note: 'series · diffusion' },
    { label: 'DRY',          role: 'bus', parallel: true, note: 'tapped at IN' },
    { label: 'BLEND',        role: 'bus', note: 'linear · MIX' },
  ] },
  { kind: 'presets', label: 'presets', entries: [
    { id: 'room',  label: 'ROOM',      note: 'dark · 0.6 s',   values: { size: 0.35, damp: 0.45, mix: 0.22 } },
    { id: 'plate', label: 'PLATE',     note: 'bright · 1.0 s', values: { size: 0.62, damp: 0.15, mix: 0.28 } },
    { id: 'hall',  label: 'HALL',      note: 'long · 2.3 s',   values: { size: 0.88, damp: 0.40, mix: 0.30 } },
    { id: 'send',  label: 'AUX SEND',  note: '100% wet',       values: { size: 0.70, damp: 0.30, mix: 1.00 } },
  ] },
],
```

⚠ **`parallel` is set on `DRY` and on nothing else, deliberately.** `parallel` means *"taps the bus earlier and rejoins further down"* (`types.ts:737-747`) — exactly the dry leg (`reverb.dsp:12` taps `audio`, rejoins at the blend) and exactly **not** the comb bank. The eight combs are parallel *with each other*, but they are the spine, not a branch; flagging them would draw a dashed bypass and teach that the tank can be routed around. The parallelism the reader needs is in the label (`8 ×`) and the note. A diagram that teaches the wrong chain is worse than none.

Presets are complete 3-param recalls (with only three params, "complete" is trivially guaranteed — the honest option the platform demands); every value is inside `0..1`; the notes are the low-band T60 from §1's formula. The roster is not decoration on a 3-knob module: with band hints hidden by default it is how the face *shows* where the safe territory is. Three of four sit at mix ≤ 0.30 (the docs' safe zone); `AUX SEND` is the deliberate exception and its note says so.

---

## 7. RANGE / CURVE / VOCABULARY CHANGES

**No range, curve, `options`, `landmarks` or `units` change.** Two `format` functions, both contract-transparent (`contract-signature.ts:109-110` projects only `id min..max curve default=… [unit=…]`):

- **`size.format` → the LOW-BAND T60 in seconds.** `0.50` becomes **`0.79 s`**. This is PF-3 done right and it **replaces the `size` → `Decay` relabel** the program still lists as open (`plan:1455` item 6): the knob stops lying about its name without renaming it, so it does not collide with shimmershine's *separate* `size` and `decay` params, and it does not break `e2e/tests/param-edit-undo.spec.ts:61-62`, which hard-couples to `.track[role="slider"][aria-label="Size"]` on this card.
  ⚠ **Round-2 rejected `format` for reverb on a false premise** — *"a T60-seconds readout on `size` would be a lie whenever `damp` ≠ 0.3"*. At DC it is **exactly** damp-invariant, because the lbcf's one-pole has unity DC gain (`reverbs.lib:760`). What is true is the weaker claim that this is the *low-band* tail, not the broadband average: at defaults it reads 0.79 s where the def's broadband T30×2 figure is 0.55 s. **Both belong in `docs.controls.size`, and that docs edit is mandatory in the same PR** — nobody should later "fix" one to match the other.
- **`damp.format` → the in-loop lowpass CORNER in Hz.** `0.30` becomes **`10.6 kHz`**; 0.5 → 5.5 kHz, 0.8 → 1.7 kHz, 0.95 → 392 Hz. Closed form `cos ω_c = (−1 + 4d − d²)/(2d)`, `f_c = ω_c·SR/2π`, with three regimes: `d = 0` → `'off'`; `d < 3−√8 ≈ 0.1716` → the −3 dB point is above Nyquist, `'open'`; `d = 1` → `'closed'`.

**ONE SOURCE OF TRUTH.** All of it (the 8 taps, `FB1_MIN = 0.5` / `FB1_SPAN = 0.45`, the three ranges, the two formatters, the three model functions) lives in a new **`packages/web/src/lib/audio/reverb-tank-model.ts`**, imported by the def *and* the card. Not new machinery — the batch-B+ precedent already in `STRICT_FACES` (`strict-faces.ts:34-40`, `$lib/audio/ringback-crush-model`).

**Card range grep, per the brief.** `ReverbCard.svelte:29-31` hardcodes `min={0} max={1} defaultValue={0.5|0.3|0.3}`, `curve="linear"` and `label="Size|Damp|Mix"` on all three Faders — **six duplicated facts per row, eighteen in total**. Every one currently **AGREES** with `reverb.ts:56-58`, so this is a **latent hazard, not a live bug** — but it is the backdraft `camTiltX` class CLAUDE.md legislates against and is invisible to every def-reading gate. Drive the three Faders off `reverbDef.params` (the card already imports `reverbDef` at `:5` and reads it for defaults at `:14-16`) and pass `formatValue={pd.format}` so the legacy card and the shell dial cannot print different numbers for one param.

---

## 8. COST

- **contract-lock: ZERO.** No `ParamDef`, `PortDef`, `ControlFamily` or `edge:`. `face` has no branch in `contract-signature.ts` and `format` is not projected; the reverb block stays exactly 6 lines (`contract-lock.txt:2662-2667`). `docs:accept` *will* move — the `docs.controls.size`/`damp` rewrites are living-docs content — so run it and review the diff.
- **VRT — MOVES:**
  - `workflow-shell-faces.spec.ts/{darwin,linux}/face-reverb-dock.png` (1220×398). Title + hint + hero rail + readout strip + sidebar column + one band instead of two: far past `DOCK_MAX_DIFF = 1500` (`:79`), so the gate fails loudly and the regen writes.
  - `workflow-shell-faces.spec.ts/{darwin,linux}/face-reverb-compact.png` (88×82). ⚠ **the #1213 sub-tolerance trap.** The compact tile shows ranks 1-2 (`faceTierCap('compact', true) = LANE_ROW_MAX_CELLS_WITH_GLYPH = 2`) = `mix, size`, and `size` now declares a vocabulary, so `KnobConic`'s lane readout — *"in the LANE it renders only when the param declared a vocabulary"* — starts painting. That row plausibly lands **under** `COMPACT_MAX_DIFF = 150` (`:78`; the whole image is 7 216 px). **`git rm` both files BEFORE dispatching** — Playwright always writes a *missing* snapshot and never rewrites a passing-but-stale one.
- **VRT — MUST NOT MOVE (a diff there is a finding, not a re-pin):** `vrt.spec.ts/{darwin,linux}/reverb.png` (360×361), the **REQUIRED** `vrt-strict` lane (`reverb` ∈ `STRICT_VRT_MODULES`, `vrt-exemptions.ts:891`). No param added, no Fader added, no width change — and the Fader's value tag renders `{#if dragging || hovering}` (`Fader.svelte:423-425`), so even the `formatValue` prop is invisible to a static capture.
- **VRT — exemptions/ratchet:** no drain, no ratchet edit. None of the four faces is in `EXEMPT_BASELINE_PAIRS`; reverb's pairs were drained in the P1-batch-3 wave (`vrt-exemptions.ts:1100`), its PF-8 re-capture recorded at `:1080`.
- **Structural gate:** `e2e/vrt/workflow-shell-faces.spec.ts:66` `{ type: 'reverb', pages: 2 }` → `pages: 1`, in the SAME commit. That assert (`:230`) runs *before* the pixel pin, so forgetting it fails first with a readable message.
- **e2e:** faces-parity cell delta **0** — no param added, and `hero.control` promotes rather than copies, so the `control-*` multiset is untouched. No new bespoke spec.
- **CI wall-time: ≈ +2.5 s.** faces-parity +0 cells × ~0.8 s = 0; VRT scene *count* unchanged in all three lanes (only bytes move, free); unit lane gains one pure-model spec (no DOM, no engine) ≈ +0.1 s; the ART calibration leg for `reverb-wet-gain` adds 4 offline Faust renders at ~0.6 s ≈ **+2.4 s** in the `art` job. Well under the 2-minute threshold — state it in the PR body and confirm on CI.
- **ART / attest: NIL — confirmed, not assumed.** `reverb.dsp` is untouched, so `dspSourceSha('reverb.dsp')` (`art/scenarios/reverb/profile.test.ts:65`) is unchanged and `art/baselines/reverb/audio.{f32,sha}` must not move. Audio def, outside the WebGL basis — no `docs-hash-ignore` markers, no collab/grand basis file touched. ⚠ For anyone re-reading round-2: the pinned render is **not** at defaults (`profile.test.ts:32` uses `{ size: 0.85, damp: 0.3, mix: 0.5 }`).
- **Push 2:** reverb has no entry in `push-card-config.ts`, so its card resolves from the live def; no param added or renamed, so the generic tier cannot re-rank. Unchanged.

---

## 9. DEFECTS FOUND IN SHIPPED CODE

*(follow-up bugs, not spec content)*

1. **DAMP's tone is SAMPLE-RATE DEPENDENT while the tank's timing is not.** `reverb.dsp:16` feeds `damp` in as a raw one-pole coefficient, so the pole sits at `z = damp` and its corner **in Hz scales with SR** (9.7 kHz at 44.1 k, 10.6 kHz at 48 k, 21.2 kHz at 96 k for the same knob position) — while the comb taps are explicitly SR-adapted (`reverbs.lib:763`) so the *times* are held constant. **Cost:** the same saved rack is audibly brighter on 96 kHz hardware than on 44.1 kHz, in the damping only. **Catchable?** No test sees it today — ART renders at one SR. A cheap gate is an offline render at two SRs asserting the HF/LF tail balance matches. Inherited from the Faust stdlib, so a real fix diverges from `re.mono_freeverb` (e.g. `ba.tau2pole`) — owner-audition DSP PR, and it *would* move the ART baseline.
2. **`reverb.dsp:18`'s `spread` literal `0.5` is a no-op** yet reads as if it does something; the comment at `:11` documents `spread` as a live argument. Passing `0` and dropping the implication is byte-identical audio and honest source. **Cost:** zero to users; it cost two planning rounds to re-derive. (Round-2's "two hidden constants" finding is correct; its implication — "un-exposed capability" — is not: on a mono tank `spread` is not a capability at any value.)
3. **`ReverbCard.svelte:29-31` re-types eighteen facts already on the def** (min/max/default/curve/label × 3). They currently AGREE, so **latent**, not live — reported because it is the divergence class no gate in the repo can see; §7's model module closes it.
4. **`e2e/tests/param-edit-undo.spec.ts:47-81` — the repo's only undo-tracking test — is hard-coupled to reverb's card DOM** (`:51` spawns `type: 'reverb'`; `:61-62` selects `[role="slider"][aria-label="Size"]`). Nothing is wrong today, but it is an undocumented landmine under two edits still listed as open (the `size`→`Decay` relabel; any ReverbCard row rework). Worth a comment naming the coupling.

---

## 10. VERIFICATION GATE

In this order. Every new test is **new**, so the 3× flake-check applies.

```sh
# 1. the model + its permanent negative controls (NEW spec — 3x)
REPEAT=3 flox activate -- task test:one -- reverb-tank-model

# 2. the face declaration gates
flox activate -- task test:one -- module-face-lint   # hero ranked/promoted-once, valueIds registered,
                                                     # presets in range, sidebar non-empty
flox activate -- task test:one -- curated-face
flox activate -- task test:one -- param-vocabulary    # the two `format` fns
flox activate -- task test:one -- rear-card-model     # expected UNCHANGED — prove it, don't assume it
flox activate -- task test:one -- module-docs-lint
flox activate -- task docs:check && flox activate -- task docs:accept   # diff must be docs only, ZERO contract lines

# 3. the wet-gain CALIBRATION against a real offline render (NEW — 3x).
#    Miss ±1.5 dB at any of the four corners => downgrade the readout to `text` (see §5).
REPEAT=3 flox activate -- task art:one -- reverb
flox activate -- git status   # art/baselines/reverb/audio.{f32,sha} MUST be untouched

# 4. parity + the structural page count
REPEAT=3 flox activate -- npx --workspace e2e playwright test faces-parity --grep reverb
REPEAT=3 flox activate -- task e2e:one -- workflow-shell-faces   # pages 2 -> 1 asserts BEFORE the pixels
flox activate -- npx --workspace e2e playwright test param-edit-undo   # the aria-label="Size" coupling

# 5. VRT — DRAIN-FIRST, then dispatch
flox activate -- git rm e2e/vrt/__screenshots__/workflow-shell-faces.spec.ts/{darwin,linux}/face-reverb-compact.png
REPEAT=3 flox activate -- task vrt:one -- reverb   # inspect EVERY diff PNG; a look change never auto-merges
# vrt.spec.ts reverb.png (REQUIRED lane) must come back PIXEL-IDENTICAL — a diff there is a finding
flox activate -- gh workflow run vrt-update.yml -f ref=<branch> -f platform=linux   # UNSCOPED, never -f grep=
# a green dispatch that committed nothing is a RED FLAG, not "nothing to do"

# 6. the stricter type gate
flox activate -- task typecheck
```
