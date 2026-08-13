# face re-do — delay

> ⚠ **Read `face-redo-INDEX.md` §0 first.** Two owner rulings (2026-08-11) void
> the prose half of this spec: a face declares **no `title`, no `hint`, no page
> `hint`** (all explanation goes to `docs`, read by right-click → annotate), and
> the **`signal-flow` sidebar kind is DELETED** from the platform. Both are
> struck below. The faceplate pipeline is PAUSED; this is not a queue item.

**Verdict: MECHANICAL ONLY** — the shipped control surface (`order`, `pages`,
`rear`, `glyph`, `params`, the card, the DSP) is right and **nothing in it
moves**; what remains after the rulings is the hero (`control` + the readout
strip), a `presets` sidebar block, one band relabel, and two pure derived-readout
functions added to the existing `delay-echo-model.ts`.

---

## 1. WHAT THE MODULE ACTUALLY DOES

Three params, two inputs, one output, no worklet, no Faust. The whole render path
is the factory at `packages/web/src/lib/audio/modules/delay.ts:330-424`.

**The signal path, in the factory's real order** (`delay.ts:344-371`):

```
inputGain ─┬─► dry  (√(1−mix)) ───────────────────────────┐
           │                                              ├─► output
           └─► DelayNode(delayTime = time) ─┬─► wet (√mix)┘
                                            └─► feedback (min(0.95,fb)) ─► DelayNode
```

**DRY is a parallel forward tap** (splits at the input, rejoins at the output).
**FEEDBACK is a recirculation** — it returns the line's output to the line's
*input*, upstream. **The wet tap comes straight off the DelayNode**, not off the
feedback gain. **MIX is the only stage after the loop**, which is the module's
one counter-intuitive behaviour: the buffer keeps filling and recirculating at
`mix = 0`, so the tail is already running when you turn it up.

**What each control genuinely changes about the sound**

- **`time`** (log 0.001..2 s, default 0.25, `delay.ts:113`) — the echo *spacing*,
  and the module's only performance control. `DelayNode` is a **fractional-read**
  line, so *moving* `time` resamples the buffer and Dopplers what is already in it
  (`delay.ts:10-17`; see §7.2 for how well that claim is actually evidenced). It
  is also the only param with a CV jack and the only a-rate destination.
- **`feedback`** (linear 0..0.95, default 0.4, `delay.ts:119`) — a **ratio
  pretending to be a count**. `echoRepeats` solves `g^n < 10^(−60/20)` for the
  first integer n (`delay-echo-model.ts:72-76`): **1 REP at 0, 8 REP at the
  default, 135 REP at the ceiling**. The dial prints the count, not the ratio.
- **`mix`** (linear 0..1, default 0.35, `delay.ts:124`) — an **equal-power**
  crossfade, `dry = √(1−mix)` / `wet = √mix`, identical at construction
  (`delay.ts:347,356`) and in `setParam` (`delay.ts:401-402`); `readParam`
  inverts it as `wet²`.

**Load-bearing vs incidental.** All three are load-bearing — there is nothing
incidental on a three-knob module — and **nothing is inert at spawn**: every knob
changes the sound of a patched insert immediately. (The *proposed* `time_cv_amt`
would be inert at spawn; a CV attenuator multiplies nothing with no cable in the
jack.)

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

The face was re-done end to end in **#1290**, *after* the round-2 spec was
written, and it already answers most of round-2's proposals. It is **largely
right**. Two genuine gaps:

1. **No `hero`, no `sidebar`.** Absence, not error — PF-20 post-dates the face.
   (The `title` / `hint` half of this gap is now void per §0: it is not to be
   filled.)
2. **The band label is a SENTENCE in a name slot** — `label: 'one line, fed back
   · mix is outside the loop'` (`delay.ts:260`). A label is a name. Under the
   no-prose ruling the sentence does **not** move to `face.hint` or a page hint —
   it goes to `docs`, and the label becomes a member list. Two tests pin the old
   string and move with it: `delay-echo-model.test.ts:339`
   (`expect(label).toContain('outside the loop')`) and `rear-card-model.test.ts:331`
   (which only asserts page-label ≠ rear-band-label — still true).
3. **`glyph: 'meter'` flatlines on a silent rack.** `glyphBinding` resolves
   `meter` + an audio out to `{ kind: 'live-audio' }` (`shell-glyph-live.ts:112-170`)
   — an RMS bar off the output. delay is an **insert**: silent until something is
   patched *and* playing, which is strictly rarer than for a voice. The correct
   answer is **not** a bespoke picture (§4) but the param-derived readout strip,
   which is always live. The glyph's blindness gets *covered*, not replaced.

**Explicitly right and NOT re-opened:** the `order` (argued twice over,
independently, at `delay.ts:154-189`), the 2→1 page collapse, the curated rear
pair `signal`/`echo`, `meter` over `scope` (the shell's scope window is ~43 ms,
shorter than almost every useful echo spacing), the three `format` functions, and
the four-reason rejection of `time_cv_amt`. Re-deriving any of these would be
invention.

---

## 3. THE RANKING

**delay declares THREE params.** `order` is `['time','feedback','mix']`
(`delay.ts:258`) and **does not change**. Restated with the arguments already on
the def:

| rank | key | why it earns the rank (wrong for a different module) | cost to the ranks below |
|---|---|---|---|
| 1 | `time` | **The glyph buys the rank, inverted.** The `meter`'s own justification is that it pulses per repeat and steps down as the tail regenerates — i.e. it draws FEEDBACK. A mini tile spending its one cell on what the meter beside it already reports says one thing twice. An RMS scalar has no time axis, so *spacing* is what the glyph structurally cannot report. Independently: `time` is the only param with a CV jack, the only a-rate one, and the only one whose *movement* is audible. | takes the mini tile's single cell |
| 2 | `feedback` | It decides **what kind of echo this is** — one slap, eight repeats, a 135-repeat wash — and that is reachable nowhere else in the rack. | takes the 2nd compact cell; drops `mix` off compact |
| 3 | `mix` | **Replaceability, not importance.** The only control here that exists elsewhere: every module has a fader in MIXMSTRS, and the standard way to run a delay is an aux send at `mix = 1` with the send level *as* the blend. | — |

The ladder is DERIVED, not asserted: `delay-echo-model.test.ts:293` pins
`mini:['time'] · compact:['time','feedback'] · full/dock: all three` off
`curatedFace`.

**THE LOSERS, NAMED.** One candidate, and it is not a shipped param:

- **`time_cv_amt`** (±1 attenuverter on the TIME CV jack — design program §4.B,
  round-2 rank 4). **Stays out**, four reasons, all authored at
  `delay.ts:224-256` and all re-verified:
  1. **PF-12 does not exist.** `AudioDomainNodeHandle.inputs` is
     `Map<string,{node,input,param?}>` (`engine.ts:38`); the string `attenuate`
     appears nowhere under `packages/web/src/lib/audio/`; the CV→AudioParam
     branch connects the WaveShaper **straight** to `din.param`
     (`engine.ts:456`).
  2. **The zero-platform workaround hijacks the automation seam.**
     `scheduleParam` (`engine.ts:634`) and `holdParam` (`engine.ts:688`) both
     reach a param through `handle.inputs.get(id)?.param`, so clip automation on
     TIME would write *seconds* into a CV-delta gain.
  3. **It kills the in-lane glyph permanently** — `delay-echo-model.test.ts:312`
     asserts it: `laneBodyPlan(3,true,'full') → glyph:true`,
     `laneBodyPlan(4,…) → glyph:false`.
  4. **The premise is falsifiable** — depth is set at the SOURCE (an LFO's 0..1
     depth over a ±2 swing means `depth ≈ 0.0025` *is* a ±5 ms sweep here, since
     `halfSpan = 0.9995`).

---

## 4. THE HERO + THE READOUT STRIP

### `hero.cell` — **NONE.** No bespoke picture, and this is the argument, not an omission.

The only diagram delay could draw is **N evenly-spaced impulses at heights gⁿ**.
The spacing is always uniform (one `DelayNode`, one tap) and the envelope always
geometric, so the picture is **fully determined by two scalars** — and the strip
below already prints both, one of them as a *product* the picture cannot state
numerically. That is a ~380 px picture bay, a `ControlFamily` (+1 contract-lock
line), a Svelte component, a `SHELL_CELLS` entry and an **operability probe**
(`ShellPanelProbe` demands an interaction that moves `node.data` or another
element's text — a read-only diagram has none) for approximately zero information
gain. Contrast kickdrum, whose hero graph draws an envelope + sweep that
genuinely is not three numbers.

**Consequence, and it is the right one:** with no `hero.cell` the shell keeps
painting the generic glyph in the hero band (`heroGlyph = hasGlyph && !(view ===
'dock-full' && hero?.cell)`, `ModuleShell.svelte:403`). So the hero graphic **is**
the `meter` — and it does the one thing a diagram could not: answer *is the line
ringing right now*. The diagram would answer *what would it do*, which is what
the strip beneath it now prints.

### `hero.control = 'time'` · `hero.action` — **NONE.**

`time` is rank 1 for two independent reasons; promoting anything else needs a
re-rank, which §3 refuses.

**No audition.** delay is an **insert**, not a voice — it has no self-sound, so an
audition means *synthesising a stimulus* the module does not have. ⚠ Stated
precisely so as not to repeat the round-2 fan-out's most repeated defect: this is
a **cost** judgement, **not** a platform blocker. `getActiveEngine()`
(`engine-ref.ts:23`) exists, is callable from plain `.ts`, and `AudioEngine.nodes`
/ `.ctx` are public, so a host-side one-shot into
`handle.inputs.get('audio').node` is reachable with **zero factory change**. It
costs a `ControlFamily` (+1 contract-lock line), a `shell-cells.ts` action entry,
and either a widened `ShellCellEnv` or a `getActiveEngine()` back-door. Not worth
it for a module whose input is one cable away.

### THE READOUT STRIP — **3 entries**, full-width beneath the graphic

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

**Why zero param readouts.** With `time` promoted, band 1 renders exactly
`feedback` and `mix` — so *every* param readout would repeat a knob directly
under it. `{ paramId: 'feedback' }` would print `8 REP`, byte-identical to the
dial two rows down.

⚠ `time` stays listed in the band's `controls` even though the hero promotes it:
`face.hero` *moves* a key, it does not add one, and a key no band claims falls
into the defensive `__unpaged` band. The band therefore **declares three and
renders two** — which is why the label names the two that render
(`'repeats · blend'`, the collapsed-band house style, a member list and never a
sentence).

**1. `tail` — `valueId: 'delay-tail'` — DERIVED.**
*Formula, traced to the DSP:* `echoRepeats(feedback) × time` seconds.
`echoRepeats` is `floor(ECHO_FLOOR_DB / (20·log10 g)) + 1`
(`delay-echo-model.ts:72-76`), whose oracle is a **real recirculation simulation**
rather than the closed form restated (`delay-echo-model.test.ts:93`); spacing is
`time`, set on `delay.delayTime`. The nth echo lands at `n × time`, so the last
audible one is at `echoRepeats × time`. `echoRepeats` floors at 1, so
`feedback = 0` gives `1 × time` — the module's real behaviour.
*Values:* **2.00 S** at defaults (8 × 0.25); **270 S = 4.5 MIN** at
`feedback 0.95, time 2` — which is what finally makes "very long but FINITE"
legible.
*Format:* a new `formatDelayTail` (`<1 s → 'N MS'`, `<60 s → 'N.NN S'`, else
`'N.N MIN'`). Deliberately **not** `formatDelayTime`, which would print
`270.00 S`.
*NEGATIVE CONTROLS (permanent, `delay-echo-model.test.ts`):*
 (a) hold `feedback`, move `time` 0.25→1.0 ⇒ 2.00 S → 8.00 S. **A `feedback`
 readback would not move.** (b) hold `time`, move `feedback` 0.4→0.8 ⇒ 2.00 S →
 7.75 S. **A `time` readback would not move.** (c) **THE LEG THAT MUST NOT
 MOVE:** sweep `mix` ⇒ **unchanged**. Correct by construction and the assertion
 that stops a future "improvement" folding `mix` in: `ECHO_FLOOR_DB` is defined
 relative to the train's own first repeat, and `mix` scales dry and wet
 **together** at the output — it changes the tail's level, not its duration.

**2. `build-up` — `valueId: 'delay-buildup'` — DERIVED.**
*Formula, traced to the DSP:* `20·log10( √mix / (1 − min(0.95, feedback)) )` dB —
the worst-case steady-state level of the recirculating wet against the input.
`√mix` is the wet leg (`delay.ts:356`), `min(0.95,fb)` is the loop gain
**including the factory's own clamp** (`delay.ts:354`), and `Σ gⁿ = 1/(1−g)` is
the coherent sum (exact for a signal whose period divides `time`; the
incoherent-RMS case `1/√(1−g²)` is *lower*, so this is the worst case — the right
convention for a headroom number, and why the label says `build-up` rather than a
level).
*Values:* **−0.1 dB** at defaults (0.5916/1.6667); **+11.0 dB** at the `dub wash`
preset (0.7071/0.2); **+26.0 dB** at `mix 1, feedback 0.95`.
*Totality:* `mix ≤ 0` ⇒ wet is silent ⇒ print `'DRY'`, never `−∞`.
`FaceReadoutValue` is called every render and must never throw.
*NEGATIVE CONTROLS (permanent):* (a) hold `feedback`, move `mix` 0.35→1.0 ⇒ −0.1
→ +4.4 dB (**a `feedback` readback would not move**). (b) hold `mix`, move
`feedback` 0.4→0.8 ⇒ −0.1 → +9.0 dB (**a `mix` readback would not move**).
(c) **MUST NOT MOVE:** sweep `time` ⇒ unchanged; the loop gain is time-invariant.
(d) **THE CLAMP LEG:** `feedback = 0.99` (out of declared range, but readout
functions run on *live* values) must print **exactly** what `0.95` prints,
because the factory clamps. A naive `1/(1−g)` prints +40 dB — this leg is what
proves the function mirrors the DSP rather than the knob.

**3. `floor` — `text: '−60 dB'`.** The weakest, and named as such: a definition,
not a value. It earns its slot because `TAIL 2.00 S` is uninterpretable without
knowing what "gone" means. Guard it with a one-line assertion that the literal
agrees with `ECHO_FLOOR_DB` (`delay-echo-model.ts:43`), otherwise it is exactly
the re-typed constant the one-source-of-truth rule forbids. **One-line revert:**
delete it for a 2-entry strip; nothing depends on it.

### REJECTED readouts, with the reason (the interesting half)

- **`CV THROW`** (*"a full-scale cable in TIME reaches −249 ms / +1.00 s from
  here"*) — looks like the perfect derived readout: two-sided, asymmetric,
  knob-dependent (the up-throw *shrinks* as `time` rises toward the 2 s ceiling
  while a `time` readback rises). **It is wrong, and only reading
  `attachCvScale` shows why.** `buildCvCurve` bakes a 4096-point LUT of
  `effective − knob` **at PATCH TIME**, clamped into `[min,max]` *before* the
  subtraction (`cv-scale.ts:189-206`), while the AudioParam's intrinsic value is
  the **live** knob. Move TIME after patching and the graph implements
  `liveKnob + delta(patchTimeKnob)` — so a readout computed from the live knob
  would confidently print a throw the audio graph does not implement. The
  blind-metric trap, on the faceplate.
- **`REPEATS`** — `echoRepeats(feedback)` is a bijection of one knob, and that
  knob's `format` already prints it. A param readout wearing a formula.
- **`INSERT LOSS`** (dry level in dB) and **`COMB`** (1/time Hz) — monotone
  functions of one knob each. Same class.
- **`TIME in musical units`** (1/8 @ 120) — needs the rack's live BPM, but
  `FaceReadoutValue` is `(read: (paramId) => number|undefined) => string`:
  param-only **by design**, to keep the registry pure. Widening it is a platform
  change nobody asked for.

---

## 5. THE SIDEBAR

**One block: `presets`.** Pure data — no component, no registry line.

~~A `signal-flow` block was drafted and is STRUCK~~ — the kind was deleted from
the platform (INDEX §0). Its one genuine finding is worth keeping regardless of
the ruling: **`FaceFlowStage` had `parallel` (a *forward* tap that rejoins later)
but no mark for a RECIRCULATION** (a return that rejoins **upstream**), so delay's
feedback loop was undrawable — putting FEEDBACK inline between LINE and WET would
have taught that the wet passes *through* the feedback gain on its way out, which
it does not (`delay.ts:363-365`: `delay → feedback → delay` and, separately,
`delay → wet`). That is a concrete instance of the general reason the kind died:
a hand-authored chain picture nothing verifies teaches the wrong chain.

**`presets` — the strongest sidebar available here, and nearly free.** The
partial-recall hazard the platform warns about (`FacePreset`, `types.ts`: *"a
partial recall whose omissions are undocumented is worse than either honest
option"*) **cannot occur on a three-param module** — every entry stamps all
three, so recall is complete by construction. The roster is the module's own docs
turned clickable (`delay.ts:305` already names slapback, rhythmic echoes, ambient
washes and the flanger).

```ts
{ kind: 'presets', label: 'presets', entries: [
  { id: 'slapback', label: 'SLAPBACK', note: '90 ms · 1 rep', values: { time: 0.09,  feedback: 0,    mix: 0.30 } },
  { id: 'quarter',  label: 'QUARTER',  note: '500 ms @ 120',  values: { time: 0.5,   feedback: 0.45, mix: 0.35 } },
  { id: 'dub-wash', label: 'DUB WASH', note: '31 reps',       values: { time: 0.66,  feedback: 0.8,  mix: 0.50 } },
  { id: 'flange',   label: 'FLANGE',   note: '4 ms comb',     values: { time: 0.004, feedback: 0.6,  mix: 0.50 } },
] }
```

Every value in range (`time ∈ 0.001..2`, `feedback ∈ 0..0.95`, `mix ∈ 0..1`) — the
lint's out-of-range clause clears. FLANGE is deliberately the *starting point* for
the documented LFO→TIME-CV gesture, not a finished effect.

---

## 6. RANGE / CURVE / VOCABULARY CHANGES

**NONE PROPOSED.** No `ParamDef` range, `curve`, `options`, `landmarks`, `format`
or `units` moves.

**Card grep — clean.** `DelayCard.svelte` re-types **nothing**: all three faders
read `paramSpec(delayDef, …)` for
`min`/`max`/`defaultValue`/`label`/`units`/`curve`/`formatValue`
(`DelayCard.svelte:38-40,56-58`). ⚠ **This makes round-2's "THE BUG I FOUND"
entry stale** — the nine re-typed literals and the `Fb`-vs-`Feedback` caption
divergence were both fixed in #1213.

**Priced but NOT taken:** `landmarks` on `time` (flange / slapback / echo / wash).
It lives in `params:`, so it costs one ART `.sha` re-pin with byte-identical
audio. Fold it into the next PR that must re-pin anyway.

---

## 7. DEFECTS FOUND IN SHIPPED CODE

*(Follow-up bugs. None is spec content; none proposes a DSP change. All three
re-verified against the tree 2026-08-12 and all three are STILL LIVE.)*

**1. [MINOR] `equalPowerBlend`'s test is self-referential, and its header
oversells the gate.** `delay-echo-model.ts:81` is described as *"the EQUAL-POWER
dry/wet split **the factory applies**"*, but `delay-echo-model.test.ts:150-166`
only asserts √-identities and `dry²+wet² = 1` — it never reads the factory. The
factory computes `Math.sqrt(1 - mix0)` / `Math.sqrt(mix0)` inline
(`delay.ts:343,352,401-402`), so the model is a **second copy of the law**, not
its source; a revert to a linear split would leave model and test green. *Only
MINOR because* the ART baseline **would** catch it (the `.f32` moves) — a gate
exists, just not the one the header implies. *Fix:* a source-grep assertion (the
`kickdrum-face.test.ts` precedent, which reads the worklet source), or have the
factory **import** `equalPowerBlend` — the clean one-source fix, priced at one
ART `.sha` re-pin with byte-identical audio.

**2. [MINOR] The varispeed/Doppler measurement has no artifact in the tree, and
it underwrites a documented feature.** `delay.ts:10-17` records *"Probe in
headless Chromium: ramping delayTime by +0.5 s over 1 s drops a 1 kHz sine to
~498 Hz"*. A grep for `varispeed|Doppler|498` over `packages/web/src`,
`packages/dsp/src`, `e2e` and `art` finds **no probe** — the only hits are the
unrelated `videovarispeed` module and the rear-card label. So round-2's
*"measured, delay.ts:10-17"* is a **citation of a one-off probe recorded in a
comment**, not a repo-verifiable measurement. The claim is nonetheless
**analytically sound**: for `y(τ) = x(τ − t(τ))` the read rate is `1 − dt/dτ`, so
`dt/dτ = 0.5` gives exactly 500 Hz and the reported ~498 is within measurement
error. But **nothing in the repo would notice** if a browser stopped
interpolating, and `docs.explanation` (`delay.ts:305`) builds an advertised
feature on it (*"patch a slow LFO into the TIME CV jack … and you have a
flanger/chorus"*). ⚠ It **cannot** be re-homed in the ART lane: that harness
renders under `node-web-audio-api`, a different implementation from the Chromium
the claim is about. *Fix:* a headless-Chromium e2e probe. *Robustness note:*
`time`'s rank 1 does **not** depend on it — the def carries a second independent
argument (§3), so the ranking survives even if the probe were wrong.

**3. [MINOR] `docs.controls.time` overclaims the smoothness of a large TIME
move.** `setParam('time')` uses `setTargetAtTime(target, now, 0.01)`
(`delay.ts:385`), whose initial slope is `Δ/τ`. A 0.25 → 1.50 s jump gives
`dt/dτ = 125`, so the read head momentarily runs **backward at ~124×** (read rate
`1 − 125`) before the exponential settles over ~30 ms. The docs call this *"swoops
in pitch like a tape motor catching up"* and *"it does not click"*
(`delay.ts:318`). "Does not click" is **true** (the read position stays
continuous, so there is no discontinuity), but "smooth" materially understates a
124× reverse transient. **INFERENCE from the `setTargetAtTime` law — not
measured**; the same probe as defect 2 would settle it. *Cost to a user:* none as
a bug; a prose-accuracy overclaim on the module's headline behaviour.
