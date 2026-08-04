# FACE SPEC — `drummergirl` (batch 3)

> ⚠ **STATUS CORRECTED 2026-08-04 — THE FACE SHIPPED.** drummergirl was PROMOTED in **#1332**
> (`2d111616`) and is in `STRICT_FACES`; the SHAPE-unbundling hero, the five derived readouts
> and the 16-row preset roster all landed. PF-20 (**PR #1301**) has MERGED (`c6ff9253`).
> **The face half of this spec is spent — read the shipped def, not this.** What is still
> worth keeping is **§7 ALREADY-WRONG ("this module has the worst docs in the batch")**,
> which was **NOT re-verified** on 2026-08-04 — treat every row in it as unconfirmed rather
> than as either fixed or live.

**Status:** ~~SPEC + MOCKUP ONLY~~ **BUILT.** PF-20 platform (PR #1301 — MERGED, `c6ff9253`). Citations file:line.

**Verdict: PROMOTE — and the face's whole job is to unbundle ONE knob.** · archetype:
**monophonic one-shot percussion voice with a 16-preset morph.**

⚠ **Framing correction, load-bearing:** drummergirl is **not** a multi-voice drum machine. It is
one sine oscillator, one noise generator, one amplitude ADSR and one pitch ADSR:
`process(gate) = mixed(gate) * env(gate) * volumeKnob` (`packages/dsp/src/drummergirl.dsp:84`).
No internal sequencer, no clock, no step grid, no voice bank, no summing bus.

Not in `STRICT_FACES`; no `face:` block. 5 params, 6 in / 1 out. contract-lock block =
**13 lines** (`packages/web/src/lib/docs/contract-lock.txt:931-943`: 1 meta + 6 in + 1 out + 5 param).

---

## 1. WHAT IT ACTUALLY DOES

**Sources — two, both fixed.** `vco(g) = os.osc(baseFreq · pow(2, pitchEnv(g)))`
(`drummergirl.dsp:71`), where `os.osc` is a `rdtable` **sine** and nothing ever changes its
waveform; and `noise = no.noise` (`:72`), Faust's seeded LCG (`noises.lib:66-72,113`), uniform
±1, RMS 1/√3, **deterministic**.

**The crossfade — this is TONE, not SHAPE:**
```
mixed(g) = vco(g)·toneKnob + noise·(1 − toneKnob)      # drummergirl.dsp:74
```
`tone = 1` is a pure sine; `tone = 0` is pure noise. **At the shipped default 0.3 the voice is
70 % noise** (`packages/web/src/lib/audio/modules/drummergirl.ts:62`).

**Base pitch.** `baseFreq = 65.406 · pow(2, pitchKnob/12)` (`:60`) — C2.

**Pitch envelope, in OCTAVES.**
`pitchEnv(g) = en.adsr(0, max(0.005, decayOf(shape)), 0, 0.001, g) · sweepOf(shape) · 4`
(`:69`), fed to `pow(2, ·)` at `:71`. Max depth four octaves. **Its decay time comes from
`decayOf(shapeKnob)`, not from the Decay knob.**

**The preset morph — the reason this module needs a face.** Five 16-entry tables
(`attackAt :27-29`, `decayAt :31-33`, `sustainAt :35-37`, `releaseAt :39-41`, `sweepAt :43-45`)
indexed by `shapeIdx(s) = clamp(0, 15, s·15)` (`:48`), split into `seg`/`seg2`/`frac` (`:49-51`)
and **linearly crossfaded** (`:53-57`). So `shape` means *"which of 16 percussion presets, and
how far between two of them"* — and it moves **five** independent quantities at once: the amp
envelope's attack, sustain and release, plus the pitch sweep's depth **and** duration.

**Amplitude envelope** (`:76-82`): A = `attackOf(shape)`, D = **`decayKnob`** (`:78`),
S = `sustainOf(shape)`, R = `releaseOf(shape)`. The Decay knob **replaces** the preset decay for
amplitude; the `decayAt` table survives only inside line 69.

**Envelope mechanics that matter.** `en.adsr` is **piecewise LINEAR**, not exponential
(`envelopes.lib:213-244`), release starts only when the gate reaches 0 (`:240`), and
`atime = +(gate) ~ *(gate' >= gate)` accumulates the **gate's value** — so envelope timing is
gate-*level* dependent. All five knobs are `si.smoo`-ed (`drummergirl.dsp:6-15`), τ ≈ 22.7 ms.

---

## 2. THE CONTROLS THAT MATTER — five params, and one of them is five controls

| rank | control | why |
|---|---|---|
| 1 | `shape` | **the most load-bearing control in the batch.** One fader moves A, S, R, sweep depth and sweep time simultaneously (`:48-57, 69, 77, 79, 80`). It deserves its own band with derived sub-readouts, not a peer slot next to Tone. |
| 2 | `tone` | the sine↔noise crossfade (`:74`) and nothing else. The single largest timbral lever. |
| 3 | `pitch` | `baseFreq` only (`:60`). ±36 semitones about C2. |
| 4 | `decay` | amp-env decay only (`:78`); does **not** touch the pitch sweep, which is the confusion this face exists to dispel. |
| 5 | `volume` | a plain output multiplier (`:84`), 0..2, linear, no shaping. |
| 6 | `drummergirl-strike-{n}` | **NEW — the audition.** The module makes no sound until a gate arrives (§3) and the card has **no strike button** (`packages/web/src/lib/ui/modules/DrummergirlCard.svelte` is five faders). |

**LOSERS: none are cut** — five params fit the six-cell lane budget with one slot to spare, and
that slot goes to the audition. What *loses* is the current card's ordering: it renders
`pitch, tone, shape, decay, volume` (`DrummergirlCard.svelte:31-35`) while the def declares
`pitch, tone, shape, volume, decay` (`drummergirl.ts:61-65`) — two different orders for the same
five controls, and the Push 2 card follows the *def*, so the hardware and the card already
disagree.

---

## 3. INERT AT SPAWN — and the headline knob is in a dead zone

1. **Nothing sounds until a gate arrives.** The factory wires a `ConstantSource` at offset 0
   into a 1-channel merger (`drummergirl.ts:95-100`); gate ≡ 0 → `rtime` counts from boot →
   `R ≫ 1` → `max(0)` → digital silence.
2. **The pitch sweep is OFF at the shipped defaults.** `shape = 0.3` → `shapeIdx = 4.5` → seg 4,
   frac 0.5 → `sweepOf = 0.0·0.5 + 0.0·0.5 = 0` (`drummergirl.dsp:44` indices 4 **and** 5 are
   both `0.0`; crossfade `:57`). Line 69 multiplies by zero. **The module's most characterful
   behaviour is disabled out of the box, and the default sits in a three-wide dead zone**
   (index 6 is also 0.0).
3. Consequently the **whole `decayAt` table is inert at spawn** — it feeds only `:69`.
4. `sustainOf` at default = 0.01 (`:36`) = −40 dB, effectively inert.
5. `volume = 1.0` is the identity multiplier.

**This is the single most valuable thing the face can say**, and §5-A/B say it as numbers.

---

## 4. THE FACE

```ts
face: {
  title: 'Voice',
  hint:
    'One sine and one noise source crossfaded by TONE, through one amplitude envelope. SHAPE is ' +
    'not a knob — it is a morph across 16 percussion presets that moves the attack, the sustain, ' +
    'the release AND the pitch sweep together. At the shipped default the sweep is zero.',

  order: [
    'shape', 'tone', 'pitch', 'decay', 'volume', 'drummergirl-strike-{n}',  // 1-6 = the lane budget
    'drummergirl-hero-{n}',                                                  // panel: first legal rank is 7
  ],
  pages: [
    { id: 'shape',  label: '1 · shape — the preset morph',
      hint: 'one fader across 16 presets: attack, sustain, release, sweep depth and sweep time move together',
      controls: ['drummergirl-hero-{n}', 'drummergirl-strike-{n}', 'shape'] },
    { id: 'source', label: '2 · source — sine vs noise',
      hint: 'TONE is a straight crossfade — 1 is a pure sine, 0 is pure noise, and the default 0.30 is 70 % noise',
      controls: ['tone', 'pitch'] },
    { id: 'amp',    label: '3 · amplitude',
      hint: 'DECAY replaces the preset decay for the amplitude only — the pitch sweep keeps its own, from SHAPE',
      controls: ['decay', 'volume'] },
  ],
  glyph: 'scope',

  hero: {
    cell:    'drummergirl-hero-{n}',
    control: 'shape',
    action:  'drummergirl-strike-{n}',
    readouts: [
      { label: 'strike pitch', valueId: 'drummergirl-strike-hz' },
      { label: 'sweep',        valueId: 'drummergirl-sweep' },
      { label: 'hit length',   valueId: 'drummergirl-hit-ms' },
    ],
  },

  sidebar: [
    { kind: 'signal-flow', label: 'signal flow', stages: [
      { label: 'GATE',        role: 'generator', note: 'level-sensitive' },
      { label: 'PITCH ADSR',  role: 'generator', parallel: true, note: 'octaves, from SHAPE' },
      { label: 'SINE',        role: 'generator', note: 'os.osc' },
      { label: 'NOISE',       role: 'generator', note: 'seeded LCG' },
      { label: 'TONE XFADE',  role: 'bus', note: 'sine ↔ noise' },
      { label: 'AMP ADSR',    role: 'bus', note: 'A·S·R from SHAPE, D from the knob' },
      { label: 'VOLUME',      role: 'bus', note: '×0…2' },
    ] },
    { kind: 'custom', label: 'preset morph', panelId: 'preset-morph',
      props: { count: 16, paramId: 'shape' } },
    { kind: 'readouts', label: 'derived', entries: [
      { label: 'sweep time',    valueId: 'drummergirl-sweep-ms' },
      { label: 'sustain floor', valueId: 'drummergirl-sustain-db' },
      { label: 'body : noise',  valueId: 'drummergirl-body-noise-db' },
    ] },
  ],
}
```

**Why `PITCH ADSR` is `parallel: true`:** it is not in the audio path at all. It modulates the
sine's *frequency* (`drummergirl.dsp:71`) and never touches the noise. Drawn inline between GATE
and SINE it would teach that the pitch envelope shapes the amplitude, which is exactly what the
DECAY-vs-sweep confusion already looks like.

---

## 5. DERIVED READOUTS

All use `sweepOf` / `decayOf` / `attackOf` / `sustainOf` / `releaseOf` = the crossfade at
`drummergirl.dsp:53-57` over the tables at `:27-45`, indexed by `:48-51`.

### A. `drummergirl-strike-hz` — where the hit STARTS
```
body_hz   = 65.406 · 2^(pitch/12)                                 # :60
strike_hz = body_hz · 2^(4 · sweepOf(shape))                      # :60, :69, :71
```
**NEGATIVE CONTROL:** hold PITCH at 0 st and move SHAPE 0.30 → 0.00. The strike pitch goes
**65.4 → 1046.5 Hz (+48 semitones)** while the PITCH readback never moves a pixel. This is the
whole reason the readout exists: the knob called "Pitch" tells you where the hit *ends*, and
nothing on the module tells you where it *starts*.

### B. `drummergirl-sweep` / `drummergirl-sweep-ms`
```
depth_st = 48 · sweepOf(shape)                                    # :69
time_ms  = 1000 · max(0.005, decayOf(shape))                      # :69, :54, :31-33
rate     = depth_st/12 / (time_ms/1000)   oct/s
```
**NEGATIVE CONTROL — the DECAY knob.** Sweep it 0.001 → 0.5 (its whole range) and **neither
number moves**, because line 69 contains no `decayKnob` at all. A readout wired to `decay` would
move; the correct one must not. That is a *falsifiable* prediction, which is what makes this an
instrument rather than a label. Defaults: depth 0, time **60 ms**; at shape 0, time **400 ms**.
Note the rate is **non-monotonic in shape** (10 oct/s at shape 0, 13.3 at 0.2) — invisible to any
knob readback.

### C. `drummergirl-hit-ms` — how long the hit actually lasts
```
S ≈ 0 :  1000·( min(gateHigh, attackOf(shape) + decay) + releaseOf(shape) )
S > 0 and gateHigh ≥ A+D :  1000·( gateHigh + releaseOf(shape) )      # :76-82 + envelopes.lib:240
```
**NEGATIVE CONTROL:** pin DECAY at 150 ms and move SHAPE 0.30 → 0.90 (idx 13.5 → R = 0.45 s).
Hit length goes **186 → 601 ms** with the DECAY readback frozen. A `paramId: 'decay'` readout
prints 150 ms in both states.

### D. `drummergirl-sustain-db` — the one-shot/sustain tell
```
sustain_db = 20·log10( sustainOf(shape) )                          # :79
```
**NEGATIVE CONTROL:** shape 0.30 → 0.90. −40 dB → **−6 dB** — the voice stops being a one-shot
and becomes a *sustaining* voice, purely from the "shape" fader. No other surface says so.

### E. `drummergirl-body-noise-db`
```
ratio_db = 20·log10( tone / (1 − tone) )                           # :74
```
Default **−7.4 dB** — the body is *below* the noise, which immediately exposes the doc error in
§7-A. **NEGATIVE CONTROL:** it must be invariant to VOLUME and SHAPE (neither appears in `:74`);
a derivation that drifts with either is instrumented wrong.

### F. Rejected, and stated
The ~22.7 ms `si.smoo` slew (`signals.lib:213`) is a **constant** with no param that moves it —
it belongs as static annotation, never as a live readout. And a "hit length" readout must be told
whether it is quoting a gate-high assumption; the sidebar states the assumption rather than
hiding it, because §7-C means gate length genuinely matters.

⚠ **A caveat to design around, not to print:** because `ddelta = (1−sl)/dn` is recomputed each
sample and `D = D0 − atime·ddelta` (`envelopes.lib:222, 228-229`), changing DECAY or SHAPE
*mid-hit* produces a discontinuous amplitude jump proportional to `atime·Δddelta`. Decay CV is a
zipper hazard, not a smooth modulation target.

---

## 6. BESPOKE CELL vs PLATFORM

**LEGITIMATE — `drummergirl-hero-{n}`:** the amplitude envelope drawn against the pitch sweep on
one time axis, with the preset index and the two neighbouring presets it is crossfading between
marked. Every number in §5 becomes visible, and the sweep-is-zero-at-default fact stops needing
a sentence.

**LEGITIMATE — `preset-morph`, a `custom` sidebar panel:** a 16-tick strip with the current
`shapeIdx` and the `frac` between two neighbours. It is generic (a discrete-table morph
indicator, `props: { count, paramId }`) in exactly the way `stereo-crossover` is generic, so it
registers once and any future table-morph module reuses it.

**NOT LEGITIMATE:** anything else. There is no signal-flow component, no preset roster component,
no readout component — those are `signal-flow` / `presets` / `readouts` blocks.

---

## 7. ALREADY-WRONG (this module has the worst docs in the batch)

- **A · TONE and SHAPE are swapped in every doc string.** `drummergirl.ts:85` says `shape`
  *"crossfades the hit between its pitched body and its noise/transient layer (0 = mostly body,
  1 = mostly noise)"*. The `.dsp` does that crossfade with **`toneKnob`** (`:74`), and with the
  **opposite polarity** (tone 0 = all noise). Shape does not crossfade anything. **Wrong twice
  over**, and it is the sentence a user reads first.
- **B · `tone` described as a timbre macro.** `drummergirl.ts:84`: *"shifts the oscillator's
  brightness/character from dark and round toward bright and edgy."* The oscillator is a fixed
  sine (`oscillators.lib:463`); its timbre never changes. Repeated at `drummergirl.ts:8-9, 14-15, 25`.
- **C · "Only the rising edge matters / hit length is set by Decay rather than how long the gate
  stays high"** (`drummergirl.ts:72`) — **false**. `en.adsr` sustains at `sustainOf(shape)` while
  high (`:79`) and release begins only at `gate == 0` (`envelopes.lib:240`); at shape ≈ 0.733
  sustain is **0.5**. With a typical drumseqz gate (120 BPM 16th, `gateLength` 0.5 → 62.5 ms;
  `packages/web/src/lib/audio/modules/drumseqz.ts:451-452`) the default 150 ms decay **never
  completes** — the release truncates it at ~0.59 amplitude.
- **D · "sampled at the gate edge that fires the note"** (`drummergirl.ts:73`) — there is **no
  sample-and-hold** anywhere in the `.dsp`; `pitchKnob` is continuously smoothed (`:6`) and read
  continuously (`:60, :71`).
- **E · "an internal AD envelope"** (`drummergirl.ts:9`) — it is a full **ADSR** (`:76-82`) whose
  A, S and R are shape-driven.
- **F · the `gate` port declares no `edge:`** (`drummergirl.ts:47`) despite being an unambiguous
  gate consumer (level-sensitive sustain `:79`, release-on-fall `envelopes.lib:240`). Declare
  `edge: 'gate'`; `module-docs-lint`'s vocabulary gate is skipped entirely without it
  (`module-docs-lint.test.ts:217`), which is why C above survived.
- **G · a lying VRT comment.** `e2e/vrt/vrt-exemptions.ts:880`:
  `'drummergirl', // drum-sample card (chrome only — sample preview is static post-load)`. There
  is no sample, no sample preview and no post-load anything; the card is five faders and the
  voice is fully synthesised.
- **H · `art/DETERMINISM.md:17`** lists drummergirl among modules consuming `Math.random`. False —
  Faust's seeded LCG inside the WASM worklet. The repo's own drift report contradicts it
  (pearson 1.0000, "sample-identical", `art/audio-drift/report-2026-05-07.md:99-112`).
- **I · misclassified as a sequencer.** `packages/web/src/lib/mike/music-theory.ts:190-197` puts
  `drummergirl` in `SEQUENCER_TYPES` while `catalog.ts:61` correctly lists it under `drumVoices`;
  via `personality.ts:167,175` a Mike-owned drummergirl would be classified as a melody/bass
  sequencer. Latent (no `clock` port makes `findClockSource` unreachable) but real.
- **J · card units divergence.** `DrummergirlCard.svelte:31` `units="st"` vs def
  `units: 'semi'` (`drummergirl.ts:61`), and lines `:31-35` re-type every range as literals while
  `:14-18` correctly read defaults from the def.

---

## 8. COST

| | |
|---|---|
| **contract-lock** | **+2 lines** — `drummergirl family drummergirl-hero kind=cell prefix=drummergirl-hero` and `… drummergirl-strike kind=other prefix=drummergirl-strike`; **+1 MODIFIED** if `edge: 'gate'` ships with it (`drummergirl in gate gate` → `… edge=gate`). 13 → 15 lines. Both families need a `docs.controls` blurb (drummergirl is in `STRICT_DOCS`). |
| **ART** | none. No `.dsp` edit. drummergirl has **no ART baseline at all** — it is on `ART_BACKLOG` (`art/setup/profile-coverage.ts:76`), so there is no audio regression pin for a future DSP-touching fix. Worth flagging on its own. |
| **VRT — ⚠ REQUIRED LANE** | `drummergirl` **is in `STRICT_VRT_MODULES`** (`e2e/vrt/vrt-exemptions.ts:880`), i.e. the `vrt-strict (visual regression — strict subset)` context that ruleset 16042163 **REQUIRES**. Both platform baselines are committed and neither is exempt. **If the card gains a strike button, both must be re-captured in the same PR** — darwin locally, linux by `vrt-update.yml` dispatch. New face scenes add `face-drummergirl-{compact,dock}` × 2 = 4 more (informational lane). |
| **e2e** | +1 `faces-parity` row (7 cells) in the REQUIRED lane. |
