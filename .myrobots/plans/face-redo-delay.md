# face re-do — delay

> ⚠ **STATUS CORRECTED 2026-08-04 — read `face-redo-INDEX.md` §0 before building.**
> PF-20 (**PR #1301**) **HAS MERGED** (`c6ff9253`); every "unmerged branch" citation below
> now resolves on `main`. **`face.title` and `face.hint` do NOT paint by default** —
> `facePageHeader()` returns `null` before reading anything unless annotate mode is on
> (`packages/web/src/lib/ui/workflow/dock-faceplate-model.ts:90`), and the owner ruled on
> 2026-08-03 that `face.title` stays annotation-only. **Any argument below that parks a
> load-bearing fact in `face.hint` because it "still paints" is VOID** — including §3's
> "module header, which still paints under correction 2". PF-21 dock ROW PACKING
> (`9bf12df7`) also landed after this was written. **This re-do is NOT built** — the
> module's shipped `face` still declares no `hero` and no `sidebar`. Live backlog.

**Verdict: MECHANICAL ONLY** — the shipped control surface (`order`, `pages`, `rear`, `glyph`,
`params`, the card, the DSP) is right and **nothing in it moves**; the delta is the four PF-20
declarations (`title`/`hint`/`hero`/`sidebar`), one band relabel forced by correction 2, and two
pure derived-readout functions added to the existing `delay-echo-model.ts`. **contract-lock: ZERO.
ART `.sha`: ZERO.**

---

## 1. WHAT THE MODULE ACTUALLY DOES

Three params, two inputs, one output, no worklet, no Faust. The whole render path is the factory at
`packages/web/src/lib/audio/modules/delay.ts:330-424`.

**The signal path, in the factory's real order** (`delay.ts:344-371`):

```
inputGain ─┬─► dry  (√(1−mix)) ───────────────────────────┐
           │                                              ├─► output
           └─► DelayNode(delayTime = time) ─┬─► wet (√mix)┘
                                            └─► feedback (min(0.95,fb)) ─► DelayNode
```

**DRY is a parallel forward tap** (splits at the input, rejoins at the output). **FEEDBACK is a
recirculation** — it returns the line's output to the line's *input*, upstream. **The wet tap comes
straight off the DelayNode**, not off the feedback gain. **MIX is the only stage after the loop**,
which is the module's one counter-intuitive behaviour: the buffer keeps filling and recirculating at
`mix = 0`, so the tail is already running when you turn it up.

**What each control genuinely changes about the sound**

- **`time`** (log 0.001..2 s, default 0.25, `delay.ts:113`) — the echo *spacing*, and the module's
  only performance control. `DelayNode` is a **fractional-read** line, so *moving* `time` resamples
  the buffer and Dopplers what is already in it (`delay.ts:10-17`; see §9.2 for how well that claim
  is actually evidenced). It is also the only param with a CV jack and the only a-rate destination.
- **`feedback`** (linear 0..0.95, default 0.4, `delay.ts:119`) — a **ratio pretending to be a
  count**. `echoRepeats` solves `g^n < 10^(−60/20)` for the first integer n
  (`delay-echo-model.ts:72-76`): **1 REP at 0, 8 REP at the default, 135 REP at the ceiling**. The
  dial prints the count, not the ratio (`delay-echo-model.ts:121-124`).
- **`mix`** (linear 0..1, default 0.35, `delay.ts:124`) — an **equal-power** crossfade,
  `dry = √(1−mix)` / `wet = √mix`, identical at construction (`delay.ts:347,356`) and in `setParam`
  (`delay.ts:405-406`); `readParam` inverts it as `wet²` (`delay.ts:412`).

**Load-bearing vs incidental.** All three are load-bearing — there is nothing incidental on a
three-knob module — and **nothing is inert at spawn**: every knob changes the sound of a patched
insert immediately. (The *proposed* `time_cv_amt` would be inert at spawn; a CV attenuator multiplies
nothing with no cable in the jack. That round-2 claim is **correct**, and it is one of five reasons
the param stays out — see §3.)

**Measurable facts worth printing**

| fact | source | at defaults |
|---|---|---|
| repeats to −60 dB | `delay-echo-model.ts:72-76` | 8 |
| **tail** = repeats × spacing | derived, two knobs | **2.0 s** |
| **worst-case wet build-up** = √mix/(1−g) | geometric sum over `delay.ts:354,356` | **−0.1 dB** |
| feedback hard clamp | `delay.ts:354` | 0.95, absolute (no CV jack) |
| no render-quantum floor on the line | `delay.ts:19-22` | 1 ms ⇒ first echo at 48 samples @ 48 kHz |
| CV throw | `halfSpan=(2−0.001)/2`, `cv-scale.ts:57-62` | ±0.9995 s, clamped + knob-centred |

---

## 2. WHAT THE CURRENT SHIPPED FACE GETS WRONG

The face was re-done end to end in **#1290**, *after* the round-2 spec was written, and it already
answers most of round-2's proposals. It is **largely right**. Three genuine gaps:

1. **No `title`, no `hint`, no `hero`, no `sidebar`.** Absence, not error — PF-20 post-dates the
   face. This is the whole of the mechanical work.
2. **The band label is a SENTENCE in a name slot** — `label: 'one line, fed back · mix is outside
   the loop'` (`delay.ts:260`). Under PF-20 that sentence has two proper homes: `face.hint` (the
   module header, which **still paints** under correction 2) and `page.hint` (annotation-only). The
   *label* should be a name. This is the one thing the re-do genuinely fixes. Two tests pin it and
   move: `delay-echo-model.test.ts:339` (`expect(label).toContain('outside the loop')`) and
   `rear-card-model.test.ts:331` (which only asserts page-label ≠ rear-band-label — still true).
3. **`glyph: 'meter'` flatlines on a silent rack.** `glyphBinding` resolves `meter` + an audio out
   to `{ kind: 'live-audio' }` (`shell-glyph-live.ts:112-170`) — an RMS bar off the output. delay is
   an **insert**: silent until something is patched *and* playing, which is strictly rarer than for a
   voice. The correct answer is **not** a bespoke picture (§5) but the param-derived readout strip,
   which is always live. The glyph's blindness gets *covered*, not replaced.

**Explicitly right and NOT re-opened:** the `order` (argued twice over, independently, at
`delay.ts:154-189`), the 2→1 page collapse, the curated rear pair `signal`/`echo`, `meter` over
`scope` (the shell's scope window is ~43 ms, shorter than almost every useful echo spacing), the
three `format` functions, and the four-reason rejection of `time_cv_amt`. Re-deriving any of these
would be invention.

---

## 3. THE ~8 CONTROLS THAT MATTER

**delay declares THREE params.** `order` is `['time','feedback','mix']` (`delay.ts:258`) and **does
not change**. Restated with the arguments already on the def:

| rank | key | why it earns the rank (wrong for a different module) | cost to the ranks below |
|---|---|---|---|
| 1 | `time` | **The glyph buys the rank, inverted.** The `meter`'s own justification is that it pulses per repeat and steps down as the tail regenerates — i.e. it draws FEEDBACK. A mini tile spending its one cell on what the meter beside it already reports says one thing twice. An RMS scalar has no time axis, so *spacing* is what the glyph structurally cannot report. Independently: `time` is the only param with a CV jack, the only a-rate one, and the only one whose *movement* is audible. | takes the mini tile's single cell |
| 2 | `feedback` | It decides **what kind of echo this is** — one slap, eight repeats, a 135-repeat wash — and that is reachable nowhere else in the rack. | takes the 2nd compact cell; drops `mix` off compact |
| 3 | `mix` | **Replaceability, not importance.** The only control here that exists elsewhere: every module has a fader in MIXMSTRS, and the standard way to run a delay is an aux send at `mix = 1` with the send level *as* the blend. | — |

The ladder is DERIVED, not asserted: `delay-echo-model.test.ts:293` pins
`mini:['time'] · compact:['time','feedback'] · full/dock: all three` off `curatedFace`.

**THE LOSERS, NAMED.** One candidate, and it is not a shipped param:

- **`time_cv_amt`** (±1 attenuverter on the TIME CV jack — design program §4.B, round-2 rank 4).
  **Stays out**, five reasons; four are authored at `delay.ts:224-256` and **all four re-verified
  this session**:
  1. **PF-12 does not exist.** `AudioDomainNodeHandle.inputs` is `Map<string,{node,input,param?}>`
     (`engine.ts:38`); the string `attenuate` appears nowhere under
     `packages/web/src/lib/audio/`; the CV→AudioParam branch connects the WaveShaper **straight** to
     `din.param` (`engine.ts:456`).
  2. **The zero-platform workaround hijacks the automation seam.** `scheduleParam` (`engine.ts:634`)
     and `holdParam` (`engine.ts:688`) both reach a param through `handle.inputs.get(id)?.param`, so
     clip automation on TIME would write *seconds* into a CV-delta gain.
  3. **It kills the in-lane glyph permanently** — `delay-echo-model.test.ts:312` asserts it:
     `laneBodyPlan(3,true,'full') → glyph:true`, `laneBodyPlan(4,…) → glyph:false`.
  4. **The premise is falsifiable** — depth is set at the SOURCE (an LFO's 0..1 depth over a ±2
     swing means `depth ≈ 0.0025` *is* a ±5 ms sweep here, since `halfSpan = 0.9995`).
  5. **NEW, and the one this re-do adds:** it sits in `params:` + `factory`, both **outside** the
     `docs-hash-ignore` region, so it would cost an ART `.sha` re-pin — the exact cost this re-do is
     otherwise at zero for (§8).

---

## 4. BAND STRUCTURE + THE ANNOTATION PROSE

One band. `pages` stays **1** (`workflow-shell-faces.spec.ts:65` asserts it), far under
`DOCK_TAB_MIN_BANDS = 7` (`dock-tabs-model.ts:46`), so the page `hint` is legal — the lint's
dead-hint clause fires only on a TABBED face.

```ts
pages: [
  {
    id: 'echo',
    label: 'repeats · blend',
    hint:
      'FEEDBACK returns the line to its own INPUT — it sets the COUNT, not the level, and it is ' +
      'hard-clamped at 0.95 with no CV jack, so nothing patchable can push this into ' +
      'self-oscillation. MIX is the only stage AFTER the loop: the buffer keeps filling and ' +
      'recirculating at MIX 0, so the tail is already running when you turn it up.',
    controls: ['time', 'feedback', 'mix'],
  },
],
```

⚠ **`time` stays listed here even though the hero promotes it.** `face.hero` *moves* a key, it does
not add one (`heroFacePlan`, `dock-faceplate-model.ts` on `origin/feat/faceplate-platform-v2`); a key
no band claims falls into the defensive `__unpaged` band. The band therefore **declares three and
renders two** — which is why the label names the two that render.

**Label style.** `'repeats · blend'` follows the collapsed-band house style the round-2 fact-checker
cited (the lfo `'rate · depth · shape'` precedent): a member list, never a sentence, and the page id
is not repeated inside it. It names what the two rendered dials *do*.

**Does this face read correctly with EVERY hint hidden?** Yes — better than today's. With annotation
off a player sees: title `Echo`; the module hint (still painting) stating the topology; the meter;
the XL TIME dial reading `250 MS`; the strip reading `TAIL 2.00 S · BUILD-UP −0.1 dB · FLOOR −60 dB`;
then one band `repeats · blend` holding two dials reading `8 REP` and `35% WET`. Every number is
self-labelling — the payoff of the three `format` functions #1213 shipped. Nothing load-bearing is
smuggled into the label, and no fact needed to operate the module lives only in a hint.

---

## 5. THE HERO + THE READOUT STRIP

### `hero.cell` — **NONE.** No bespoke picture, and this is the argument, not an omission.

The only diagram delay could draw is **N evenly-spaced impulses at heights gⁿ**. The spacing is
always uniform (one `DelayNode`, one tap) and the envelope always geometric, so the picture is
**fully determined by two scalars** — and the strip below already prints both, one of them as a
*product* the picture cannot state numerically. That is a ~380 px picture bay, a `ControlFamily`
(+1 contract-lock line), a Svelte component, a `SHELL_CELLS` entry and an **operability probe**
(`ShellPanelProbe` demands an interaction that moves `node.data` or another element's text — a
read-only diagram has none) for approximately zero information gain. Contrast kickdrum, whose hero
graph draws an envelope + sweep that genuinely is not three numbers.

**Consequence, and it is the right one:** with no `hero.cell` the shell keeps painting the generic
glyph in the hero band (`heroGlyph = hasGlyph && !(view === 'dock-full' && hero?.cell)`,
`ModuleShell.svelte` on the platform branch). So the hero graphic **is** the `meter` — and it does
the one thing a diagram could not: answer *is the line ringing right now*. The diagram would answer
*what would it do*, which is what the strip beneath it now prints.

### `hero.control = 'time'` · `hero.action` — **NONE.**

`time` is rank 1 for two independent reasons; promoting anything else needs a re-rank, which §3
refuses.

**No audition.** delay is an **insert**, not a voice — it has no self-sound, so an audition means
*synthesising a stimulus* the module does not have. ⚠ Stated precisely so as not to repeat the
round-2 fan-out's most repeated defect: this is a **cost** judgement, **not** a platform blocker.
`getActiveEngine()` (`engine-ref.ts:23`) exists, is callable from plain `.ts`, and
`AudioEngine.nodes` / `.ctx` are public (`engine.ts:164,166`), so a host-side one-shot into
`handle.inputs.get('audio').node` is reachable with **zero factory change**. It costs a
`ControlFamily` (+1 contract-lock line — `contract-signature.ts:124-126` serialises families), a
`shell-cells.ts` action entry, and either a widened `ShellCellEnv` (typed today as `{ write(...) }`
only) or a `getActiveEngine()` back-door. Not worth it for a module whose input is one cable away.

### THE READOUT STRIP (correction 1) — **3 entries**, full-width beneath the graphic

```ts
hero: {
  control: 'time',
  readouts: [
    { label: 'tail',     valueId: 'delay-tail' },
    { label: 'build-up', valueId: 'delay-buildup' },
    { label: 'floor',    text: '−60 dB' },
  ],
},
```

**Why zero param readouts.** With `time` promoted, band 1 renders exactly `feedback` and `mix` — so
*every* param readout would repeat a knob directly under it. `{ paramId: 'feedback' }` would print
`8 REP`, byte-identical to the dial two rows down. That is the noise correction 1 names, and there
is no version of it that is not.

**1. `tail` — `valueId: 'delay-tail'` — DERIVED.**
*Formula, traced to the DSP:* `echoRepeats(feedback) × time` seconds. `echoRepeats` is
`floor(ECHO_FLOOR_DB / (20·log10 g)) + 1` (`delay-echo-model.ts:72-76`), whose oracle is a **real
recirculation simulation** rather than the closed form restated (`delay-echo-model.test.ts:93`);
spacing is `time`, set on `delay.delayTime` (`delay.ts:352,389-393`). The nth echo lands at
`n × time`, so the last audible one is at `echoRepeats × time`. Total: `echoRepeats` floors at 1, so
`feedback = 0` gives `1 × time` — the module's real behaviour (`delay-echo-model.ts:63-66`).
*Values:* **2.00 S** at defaults (8 × 0.25); **270 S = 4.5 MIN** at `feedback 0.95, time 2` — which
is what finally makes "very long but FINITE" legible.
*Format:* a new `formatDelayTail` (`<1 s → 'N MS'`, `<60 s → 'N.NN S'`, else `'N.N MIN'`).
Deliberately **not** `formatDelayTime`, which would print `270.00 S`.
*NEGATIVE CONTROLS (permanent, `delay-echo-model.test.ts`):*
 (a) hold `feedback`, move `time` 0.25→1.0 ⇒ 2.00 S → 8.00 S. **A `feedback` readback would not
 move.** (b) hold `time`, move `feedback` 0.4→0.8 ⇒ 2.00 S → 7.75 S. **A `time` readback would not
 move.** (c) **THE LEG THAT MUST NOT MOVE:** sweep `mix` ⇒ **unchanged**. Correct by construction
 and the assertion that stops a future "improvement" folding `mix` in: `ECHO_FLOOR_DB` is defined
 relative to the train's own first repeat (`delay-echo-model.ts:37-43`), and `mix` scales dry and wet
 **together** at the output — it changes the tail's level, not its duration.

**2. `build-up` — `valueId: 'delay-buildup'` — DERIVED.**
*Formula, traced to the DSP:* `20·log10( √mix / (1 − min(0.95, feedback)) )` dB — the worst-case
steady-state level of the recirculating wet against the input. `√mix` is the wet leg
(`delay.ts:356`), `min(0.95,fb)` is the loop gain **including the factory's own clamp**
(`delay.ts:354`), and `Σ gⁿ = 1/(1−g)` is the coherent sum (exact for a signal whose period divides
`time`; the incoherent-RMS case `1/√(1−g²)` is *lower*, so this is the worst case — the right
convention for a headroom number, and why the label says `build-up` rather than a level).
*Values:* **−0.1 dB** at defaults (0.5916/1.6667); **+11.0 dB** at the `dub wash` preset
(0.7071/0.2); **+26.0 dB** at `mix 1, feedback 0.95`.
*Totality:* `mix ≤ 0` ⇒ wet is silent ⇒ print `'DRY'`, never `−∞`. `FaceReadoutValue` is called every
render and must never throw (`face-readout-values.ts`).
*NEGATIVE CONTROLS (permanent):* (a) hold `feedback`, move `mix` 0.35→1.0 ⇒ −0.1 → +4.4 dB (**a
`feedback` readback would not move**). (b) hold `mix`, move `feedback` 0.4→0.8 ⇒ −0.1 → +9.0 dB (**a
`mix` readback would not move**). (c) **MUST NOT MOVE:** sweep `time` ⇒ unchanged; the loop gain is
time-invariant. (d) **THE CLAMP LEG:** `feedback = 0.99` (out of declared range, but readout
functions run on *live* values) must print **exactly** what `0.95` prints, because the factory clamps
(`delay.ts:354`). A naive `1/(1−g)` prints +40 dB — this leg is what proves the function mirrors the
DSP rather than the knob.

**3. `floor` — `text: '−60 dB'`.** The weakest, and named as such: a definition, not a value. It
earns its slot because `TAIL 2.00 S` is uninterpretable without knowing what "gone" means. Guard it
with a one-line assertion that the literal agrees with `ECHO_FLOOR_DB` (`delay-echo-model.ts:43`),
otherwise it is exactly the re-typed constant the one-source-of-truth rule forbids. **One-line
revert:** delete it for a 2-entry strip; nothing depends on it.

### REJECTED readouts, with the reason (the interesting half)

- **`CV THROW`** (*"a full-scale cable in TIME reaches −249 ms / +1.00 s from here"*) — looks like
  the perfect derived readout: two-sided, asymmetric, knob-dependent (the up-throw *shrinks* as
  `time` rises toward the 2 s ceiling while a `time` readback rises). **It is wrong, and only
  reading `attachCvScale` shows why.** `buildCvCurve` bakes a 4096-point LUT of `effective − knob`
  **at PATCH TIME**, clamped into `[min,max]` *before* the subtraction (`cv-scale.ts:189-206`), while
  the AudioParam's intrinsic value is the **live** knob. Move TIME after patching and the graph
  implements `liveKnob + delta(patchTimeKnob)` — so a readout computed from the live knob would
  confidently print a throw the audio graph does not implement. The blind-metric trap, on the
  faceplate.
- **`REPEATS`** — `echoRepeats(feedback)` is a bijection of one knob, and that knob's `format`
  already prints it. A param readout wearing a formula.
- **`INSERT LOSS`** (dry level in dB) and **`COMB`** (1/time Hz) — monotone functions of one knob
  each. Same class.
- **`TIME in musical units`** (1/8 @ 120) — needs the rack's live BPM, but `FaceReadoutValue` is
  `(read: (paramId) => number|undefined) => string` (`face-readout-values.ts`): param-only **by
  design**, to keep the registry pure. Widening it is a platform change nobody asked for.

---

## 6. THE SIDEBAR

Two blocks. Both pure data — no component, no registry line.

**(a) `presets` — the strongest sidebar available here, and nearly free.** The partial-recall hazard
the platform warns about (`FacePreset`, `types.ts`: *"a partial recall whose omissions are
undocumented is worse than either honest option"*) **cannot occur on a three-param module** — every
entry stamps all three, so recall is complete by construction. The roster is the module's own docs
turned clickable (`delay.ts:308` already names slapback, rhythmic echoes, ambient washes and the
flanger).

```ts
{ kind: 'presets', label: 'presets', entries: [
  { id: 'slapback', label: 'SLAPBACK', note: '90 ms · 1 rep', values: { time: 0.09,  feedback: 0,    mix: 0.30 } },
  { id: 'quarter',  label: 'QUARTER',  note: '500 ms @ 120',  values: { time: 0.5,   feedback: 0.45, mix: 0.35 } },
  { id: 'dub-wash', label: 'DUB WASH', note: '31 reps',       values: { time: 0.66,  feedback: 0.8,  mix: 0.50 } },
  { id: 'flange',   label: 'FLANGE',   note: '4 ms comb',     values: { time: 0.004, feedback: 0.6,  mix: 0.50 } },
] }
```

Every value in range (`time ∈ 0.001..2`, `feedback ∈ 0..0.95`, `mix ∈ 0..1`) — the lint's
out-of-range clause clears. FLANGE is deliberately the *starting point* for the documented
LFO→TIME-CV gesture, not a finished effect.

**(b) `signal-flow` — the topology, with one limitation named rather than hidden.**

```ts
{ kind: 'signal-flow', label: 'signal flow', stages: [
  { label: 'IN',         note: 'mono' },
  { label: 'DRY',        parallel: true, note: '× √(1−MIX)' },
  { label: 'DELAY LINE', note: 'TIME · fractional read · ⟲ FEEDBACK' },
  { label: 'WET',        note: '× √MIX' },
  { label: 'OUT',        note: 'dry + wet' },
] }
```

- **`DRY` is `parallel: true`, and that is textbook-correct** for the field: it taps at the input and
  rejoins further down — exactly `FaceFlowStage.parallel`'s definition.
- **`role` is omitted on every stage, deliberately.** delay has **no generator** — it is all bus — so
  the legend that field exists to print would draw a distinction this module does not have. The
  absence is the statement.
- ⚠ **FEEDBACK is a stage NOTE, not a stage.** `FaceFlowStage` has `parallel` (a *forward* tap that
  rejoins later) but no mark for a **recirculation** (a return that rejoins **upstream**). Drawing
  FEEDBACK inline between LINE and WET would teach that the wet passes *through* the feedback gain on
  its way out — it does not (`delay.ts:363-365`: `delay → feedback → delay` and, separately,
  `delay → wet`). A diagram that teaches the wrong chain is worse than none, so the loop lives in the
  LINE's note. **Optional platform ask, NOT taken:** a `feedback?: boolean` on `FaceFlowStage` (one
  type field, one renderer branch, one lint clause) would draw the return arc properly and would also
  serve cofefve / charlottesEchos / shimmershine.

---

## 7. RANGE / CURVE / VOCABULARY CHANGES

**NONE PROPOSED.** No `ParamDef` range, `curve`, `options`, `landmarks`, `format` or `units` moves —
which is what keeps §8's ART cost at zero.

**Card grep — clean.** `DelayCard.svelte` re-types **nothing**: all three faders read
`paramSpec(delayDef, …)` for `min`/`max`/`defaultValue`/`label`/`units`/`curve`/`formatValue`
(`DelayCard.svelte:38-40,56-58`), and `card-range-source.test.ts` guards it at the source level.
⚠ **This makes round-2's "THE BUG I FOUND" entry stale** — the nine re-typed literals and the
`Fb`-vs-`Feedback` caption divergence were both fixed in #1213 (the card header documents it).

**Priced but NOT taken:** `landmarks` on `time` (flange / slapback / echo / wash). `landmarks` lives
in `params:`, **outside** the `docs-hash-ignore` region **by policy**
(`art/scenarios/pattern3-face-pin.test.ts:45`: *"`params`/`inputs`/`outputs`/`factory` are
deliberately NOT here"*). It would cost one ART `.sha` re-pin with byte-identical audio. Keep this
wave at zero; fold it into the next PR that must re-pin anyway.

---

## 8. COST

**contract-lock: ZERO.** `face` is UI metadata — `contract-signature.ts` emits only
`meta`/`in`/`out`/`param`/`family` lines (`:124-126` for families) and has no `face` branch. No new
`ParamDef`, `PortDef`, `ControlFamily` or `edge:`. The delay block stays at **7 lines**
(`contract-lock.txt:787-793`).

**ART: ZERO `.sha`, ZERO `.f32`.** The item the parent asked to be priced, and **PF-11 already
landed** (#1213):

- `art/scenarios/delay/profile.test.ts:110` pins
  `docsStrippedRepoSourceSha('packages/web/src/lib/audio/modules/delay.ts')`.
- `stripDocsForPin` removes every `// docs-hash-ignore:start … :end` region before hashing
  (`art/setup/capture.ts:97-101`).
- **The whole `face:` block is inside one such region** — it opens at `delay.ts:128` and closes at
  `delay.ts:303`, with `face:` at `:257-302` fully enclosed. `docs:` has its own region at `:305-328`.
- `art/scenarios/pattern3-face-pin.test.ts` enforces it permanently: `TRANSPARENT_FIELDS =
  ['docs','face','controlFamilies']` (`:45`), failing any pinned def carrying one unwrapped.

So the design program's *"**PF-11 FIRST** … even a pure face edit moves the `.sha` today"* (§4 BATCH
B) is **STALE**, exactly as round-2 flagged. Every PF-20 declaration in §4-§6 lands inside that
region, and the two new model functions live in `delay-echo-model.ts`, which is **not in the pin
basis** (`docsStrippedRepoSourceSha` names exactly one path). **Nothing moves.** ⚠ The one thing that
*would*: any `params:` or `factory` edit — which is precisely why §7 proposes none and §3 lists it as
`time_cv_amt`'s fifth strike.

**VRT.**
- `face-delay-dock` — **MOVES, both platforms**: a title+hint header, a hero rail with an XL dial and
  the readout strip, a sidebar column, a relabelled band, and the band dropping from three knobs to
  two.
- `face-delay-compact` — **must be PIXEL-IDENTICAL, both platforms.** The compact cap is
  `LANE_ROW_MAX_CELLS_WITH_GLYPH` (`curated-face.ts:76-77`), ranks 1-2 are `time, feedback` before
  and after, and the lane tile never reads `pages`/`hero`/`sidebar` (all four PF-20 fields are
  dock-only). **Treat a compact diff as a FINDING, not a baseline to accept.**
- **Must NOT move:** any `vrt.spec.ts` scene. delay has **none** — it is in `EXEMPT_FROM_VRT`
  (`vrt-exemptions.ts:612`) and **not** in `STRICT_VRT_MODULES` (`:863`).
- ⚠ **CORRECTION to round-2:** it claims *"vrt-strict on CI (which runs linux) goes RED"*. It cannot.
  `VRT_STRICT=1` narrows `testMatch` to `['vrt.spec.ts']` (`vrt.config.ts:36,97`);
  `workflow-shell-faces.spec.ts` is in `FULL_MATCH` only. delay's face baselines are gated by the
  **non-required `vrt` lane**. Still fix them — just do not price it as a required-check risk.
- **No drain, and do NOT add an exemption.** Both linux pairs are committed and neither is in
  `EXEMPT_BASELINE_PAIRS`; they were drained in P1 batch 3 (`vrt-exemptions.ts:1100`). Parking a pair
  would raise a ceiling that only shrinks.
- ⚠ **`DOCK_MAX_DIFF` trap (A2 #1213):** this change is far over 1500 px so `--update-snapshots` will
  rewrite — **measure the darwin diff anyway**. If it lands under tolerance, `git rm` the linux PNG
  *before* dispatching: Playwright only rewrites a FAILING snapshot but always writes a MISSING one.
  A green dispatch that commits nothing is a red flag, never "nothing to do".

**Structural gate:** `workflow-shell-faces.spec.ts:65` `{ type: 'delay', pages: 1 }` — **stays 1**.
The hero removes a *control* from a band, never a band.

**e2e / faces-parity: ZERO cell delta.** delay has 3 params and 0 control families, so the dock
renders **3 cells before and 3 after** — `hero.control` *promotes* `time`, and `heroFacePlanIsTotal`
is asserted on every faced module. ⚠ **This corrects round-2 twice**: "4 cells → 5" was wrong (its
own fact-checker caught that), and the derived "+0.8 s" was wrong too, because there is no new cell.

**CI wall-time: ≈ +0.3 s**, all in the unit lane — two pure functions plus ~10 assertions in the
existing `delay-echo-model.test.ts` (no browser, no AudioContext). VRT scene count unchanged (2),
faces-parity unchanged (3), ART unchanged (same two `it`s, and this time not even the `.sha` string).
Far under the 2-minute threshold; state it in the PR body and confirm on CI.

---

## 9. DEFECTS FOUND IN SHIPPED CODE

*(Follow-up bugs. None is spec content; none proposes a DSP change.)*

**1. [MINOR] `equalPowerBlend`'s test is self-referential, and its header oversells the gate.**
`delay-echo-model.ts:78-80` calls it *"the EQUAL-POWER dry/wet split **the factory applies**"*, but
`delay-echo-model.test.ts:150-161` only asserts √-identities and `dry²+wet² = 1` — it never reads the
factory. The factory computes `Math.sqrt(1 - mix0)` / `Math.sqrt(mix0)` inline
(`delay.ts:347,356`), so the model is a **second copy of the law**, not its source; a revert to a
linear split would leave model and test green. *Only MINOR because* the ART baseline **would** catch
it (the `.f32` moves) — a gate exists, just not the one the header implies. *Fix:* a source-grep
assertion (the `kickdrum-face.test.ts` precedent, which reads the worklet source), or have the
factory **import** `equalPowerBlend` — the clean one-source fix, priced at one ART `.sha` re-pin with
byte-identical audio.

**2. [MINOR] The varispeed/Doppler measurement has no artifact in the tree, and it underwrites a
documented feature.** `delay.ts:10-17` records *"Probe in headless Chromium: ramping delayTime by
+0.5 s over 1 s drops a 1 kHz sine to ~498 Hz"*. `grep -rn "varispeed|Doppler|498"` over
`packages/web/src`, `packages/dsp/src`, `e2e` and `art` finds **no probe** — the only hits are the
unrelated `videovarispeed` module and the rear-card label. So round-2's *"measured, delay.ts:10-17"*
is a **citation of a one-off probe recorded in a comment**, not a repo-verifiable measurement. The
claim is nonetheless **analytically sound**: for `y(τ) = x(τ − t(τ))` the read rate is `1 − dt/dτ`,
so `dt/dτ = 0.5` gives exactly 500 Hz and the reported ~498 is within measurement error. But
**nothing in the repo would notice** if a browser stopped interpolating, and `docs.explanation`
(`delay.ts:308`) builds an advertised feature on it (*"patch a slow LFO into the TIME CV jack … and
you have a flanger/chorus"*). ⚠ It **cannot** be re-homed in the ART lane: that harness renders under
`node-web-audio-api`, a different implementation from the Chromium the claim is about. *Fix:* a
headless-Chromium e2e probe. *Robustness note:* `time`'s rank 1 does **not** depend on it — the def
carries a second independent argument (§3), so the ranking survives even if the probe were wrong.

**3. [MINOR] `docs.controls.time` overclaims the smoothness of a large TIME move.**
`setParam('time')` uses `setTargetAtTime(target, now, 0.01)` (`delay.ts:389-393`), whose initial
slope is `Δ/τ`. A 0.25 → 1.50 s jump gives `dt/dτ = 125`, so the read head momentarily runs
**backward at ~124×** (read rate `1 − 125`) before the exponential settles over ~30 ms. The docs call
this *"swoops in pitch like a tape motor catching up"* and *"it does not click"* (`delay.ts:321`).
"Does not click" is **true** (the read position stays continuous, so there is no discontinuity), but
"smooth" materially understates a 124× reverse transient. **INFERENCE from the `setTargetAtTime`
law — not measured**; the same probe as defect 2 would settle it. *Cost to a user:* none as a bug; a
prose-accuracy overclaim on the module's headline behaviour.

**4. Not a defect — a stale finding to retire.** Round-2's *"DelayCard.svelte RE-TYPES every
range"* is fixed. See §7.

---

## 10. VERIFICATION GATE

In order. Everything through `flox activate --`.

```sh
# 1. the two derived readouts + their negative controls (incl. the MUST-NOT-MOVE legs)
REPEAT=3 flox activate -- task test:one -- delay-echo-model

# 2. the PF-20 declarations: hero ranked + promoted once, readout valueIds registered,
#    sidebar presets in range, page hint legal on an untabbed face
flox activate -- task test:one -- module-face-lint
flox activate -- task test:one -- dock-faceplate-model      # heroFacePlanIsTotal on delay

# 3. the surfaces the band RELABEL touches (both currently pin the old sentence)
flox activate -- task test:one -- rear-card-model
flox activate -- task test:one -- curated-face

# 4. docs (delay is in STRICT_DOCS, strict-docs.ts:71) — expect ZERO diff; a diff means
#    something contract-shaped moved and this PR claims nothing did
flox activate -- task docs:check

# 5. dock parity — 3 cells before AND after; the hero must not add one
REPEAT=3 flox activate -- npx --workspace e2e playwright test faces-parity --grep delay
REPEAT=3 flox activate -- task e2e:one -- workflow-shell-faces     # pages:1 still asserted

# 6. VRT — regenerate darwin, INSPECT both PNGs, then dispatch linux UNSCOPED
REPEAT=3 flox activate -- task vrt:one -- delay
#   face-delay-dock    MUST move
#   face-delay-compact MUST NOT — a diff here is a FINDING, not a re-pin
flox activate -- gh workflow run vrt-update.yml -f ref=<branch> -f platform=linux

# 7. ART — the assertion of this whole spec: NOTHING moves
flox activate -- task art:one -- delay
#   confirm `git status` shows NO change to art/baselines/delay/audio.{sha,f32}
#   and none to packages/web/src/lib/art/fingerprints.generated.json

flox activate -- task typecheck
```

**The negative control that must be RUN, not assumed:** step 1 includes both must-NOT-move legs
(`tail` invariant to `mix`; `build-up` invariant to `time`) **and** the `build-up` clamp leg at
`feedback = 0.99`. Those three are what distinguish the registered functions from knob readbacks —
without them the registry entry is a relabelled knob and the whole of §5 is decoration.
