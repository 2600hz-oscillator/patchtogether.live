# drummergirl — face record: the MEASUREMENTS, and what is still open

**BUILT — PROMOTED in #1332 (`2d111616`); drummergirl is in `STRICT_FACES`.** The SHAPE-unbundling
hero, the five derived readouts and the 16-row preset roster all landed. The `face` block, the
layout tables and the cell rationale have been deleted from here — read the shipped def.

⚠ **Owner ruling 2026-08-11** (verbatim at `packages/web/src/lib/audio/modules/rings.ts:585-590`,
`:645-650`): *"we should prefer almost zero AI authored text, and all future faceplate work should
reflect that"* and *"lets stop doing these and clean up the existing ones, get rid of them. lose the
signal flow diagrams."* The `signal-flow` sidebar block this spec proposed is struck; the one thing
it encoded that is not obvious — **the PITCH ADSR is not in the audio path at all**, it modulates
the sine's *frequency* (`drummergirl.dsp:71`) and never touches the noise — is §1 below.

⚠ **Framing correction, load-bearing:** drummergirl is **not** a multi-voice drum machine. It is
one sine oscillator, one noise generator, one amplitude ADSR and one pitch ADSR:
`process(gate) = mixed(gate) * env(gate) * volumeKnob` (`packages/dsp/src/drummergirl.dsp:84`).
No internal sequencer, no clock, no step grid, no voice bank, no summing bus.

---

## 1 · WHAT IT ACTUALLY DOES

**Sources — two, both fixed.** `vco(g) = os.osc(baseFreq · pow(2, pitchEnv(g)))`
(`drummergirl.dsp:71`), where `os.osc` is a `rdtable` **sine** and nothing ever changes its
waveform; and `noise = no.noise` (`:72`), Faust's seeded LCG (`noises.lib:66-72,113`), uniform ±1,
RMS 1/√3, **deterministic**.

**The crossfade — this is TONE, not SHAPE:** `mixed(g) = vco(g)·toneKnob + noise·(1 − toneKnob)`
(`:74`). `tone = 1` is a pure sine; `tone = 0` is pure noise. **At the shipped default 0.3 the
voice is 70 % noise** (`drummergirl.ts:62`).

**Base pitch.** `baseFreq = 65.406 · pow(2, pitchKnob/12)` (`:60`) — C2.

**Pitch envelope, in OCTAVES.**
`pitchEnv(g) = en.adsr(0, max(0.005, decayOf(shape)), 0, 0.001, g) · sweepOf(shape) · 4` (`:69`),
fed to `pow(2, ·)` at `:71`. Max depth four octaves. **Its decay time comes from
`decayOf(shapeKnob)`, not from the Decay knob.**

**The preset morph — the reason this module needs a face.** Five 16-entry tables
(`attackAt :27-29`, `decayAt :31-33`, `sustainAt :35-37`, `releaseAt :39-41`, `sweepAt :43-45`)
indexed by `shapeIdx(s) = clamp(0, 15, s·15)` (`:48`), split into `seg`/`seg2`/`frac` (`:49-51`)
and **linearly crossfaded** (`:53-57`). So `shape` means *"which of 16 percussion presets, and how
far between two of them"* — and it moves **five** independent quantities at once: the amp
envelope's attack, sustain and release, plus the pitch sweep's depth **and** duration.

**Amplitude envelope** (`:76-82`): A = `attackOf(shape)`, D = **`decayKnob`** (`:78`),
S = `sustainOf(shape)`, R = `releaseOf(shape)`. The Decay knob **replaces** the preset decay for
amplitude; the `decayAt` table survives only inside line 69.

**Envelope mechanics that matter.** `en.adsr` is **piecewise LINEAR**, not exponential
(`envelopes.lib:213-244`), release starts only when the gate reaches 0 (`:240`), and
`atime = +(gate) ~ *(gate' >= gate)` accumulates the **gate's value** — so envelope timing is
gate-*level* dependent. All five knobs are `si.smoo`-ed, τ ≈ 22.7 ms.

---

## 2 · INERT AT SPAWN — and the headline knob is in a dead zone

1. **Nothing sounds until a gate arrives.** The factory wires a `ConstantSource` at offset 0 into a
   1-channel merger (`drummergirl.ts:95-100`); gate ≡ 0 → `rtime` counts from boot → `R ≫ 1` →
   `max(0)` → digital silence.
2. **The pitch sweep is OFF at the shipped defaults.** `shape = 0.3` → `shapeIdx = 4.5` → seg 4,
   frac 0.5 → `sweepOf = 0.0·0.5 + 0.0·0.5 = 0` (`drummergirl.dsp:44` indices 4 **and** 5 are both
   `0.0`; crossfade `:57`). Line 69 multiplies by zero. **The module's most characterful behaviour
   is disabled out of the box, and the default sits in a three-wide dead zone** (index 6 is also
   0.0).
3. Consequently the **whole `decayAt` table is inert at spawn** — it feeds only `:69`.
4. `sustainOf` at default = 0.01 (`:36`) = −40 dB, effectively inert.
5. `volume = 1.0` is the identity multiplier.

---

## 3 · THE DERIVED READOUTS AND THEIR NEGATIVE CONTROLS

All use `sweepOf` / `decayOf` / `attackOf` / `sustainOf` / `releaseOf` = the crossfade at
`drummergirl.dsp:53-57` over the tables at `:27-45`, indexed by `:48-51`.

**A · `drummergirl-strike-hz` — where the hit STARTS.**
`body_hz = 65.406 · 2^(pitch/12)`; `strike_hz = body_hz · 2^(4 · sweepOf(shape))`.
*NEGATIVE CONTROL:* hold PITCH at 0 st and move SHAPE 0.30 → 0.00. The strike pitch goes
**65.4 → 1046.5 Hz (+48 semitones)** while the PITCH readback never moves a pixel. The knob called
"Pitch" tells you where the hit *ends*, and nothing else on the module tells you where it *starts*.

**B · `drummergirl-sweep` / `drummergirl-sweep-ms`.** `depth_st = 48 · sweepOf(shape)`;
`time_ms = 1000 · max(0.005, decayOf(shape))`; `rate = depth_st/12 / (time_ms/1000)` oct/s.
*NEGATIVE CONTROL — the DECAY knob.* Sweep it 0.001 → 0.5 (its whole range) and **neither number
moves**, because line 69 contains no `decayKnob` at all. A readout wired to `decay` would move; the
correct one must not — a *falsifiable* prediction, which is what makes this an instrument rather
than a label. Defaults: depth 0, time **60 ms**; at shape 0, time **400 ms**. The rate is
**non-monotonic in shape** (10 oct/s at shape 0, 13.3 at 0.2) — invisible to any knob readback.

**C · `drummergirl-hit-ms`.**
`S ≈ 0 : 1000·( min(gateHigh, attackOf(shape) + decay) + releaseOf(shape) )`;
`S > 0 and gateHigh ≥ A+D : 1000·( gateHigh + releaseOf(shape) )`.
*NEGATIVE CONTROL:* pin DECAY at 150 ms and move SHAPE 0.30 → 0.90 (idx 13.5 → R = 0.45 s). Hit
length goes **186 → 601 ms** with the DECAY readback frozen. A `paramId: 'decay'` readout prints
150 ms in both states.

**D · `drummergirl-sustain-db`.** `20·log10( sustainOf(shape) )`.
*NEGATIVE CONTROL:* shape 0.30 → 0.90. **−40 dB → −6 dB** — the voice stops being a one-shot and
becomes a *sustaining* voice, purely from the "shape" fader.

**E · `drummergirl-body-noise-db`.** `20·log10( tone / (1 − tone) )`. Default **−7.4 dB** — the
body is *below* the noise. *NEGATIVE CONTROL:* it must be invariant to VOLUME and SHAPE (neither
appears in `:74`); a derivation that drifts with either is instrumented wrong.

**F · Rejected, and stated.** The ~22.7 ms `si.smoo` slew is a **constant** with no param that
moves it — static annotation, never a live readout. And a "hit length" readout must be told whether
it is quoting a gate-high assumption; the assumption is stated rather than hidden, because ledger
item C means gate length genuinely matters.

⚠ **A caveat to design around, not to print:** because `ddelta = (1−sl)/dn` is recomputed each
sample and `D = D0 − atime·ddelta` (`envelopes.lib:222, 228-229`), changing DECAY or SHAPE *mid-hit*
produces a discontinuous amplitude jump proportional to `atime·Δddelta`. **Decay CV is a zipper
hazard, not a smooth modulation target.**

---

## 4 · DEFECT LEDGER — §7 re-verified 2026-08-12

| # | item | verdict |
|---|---|---|
| **A** | TONE and SHAPE swapped in every doc string — `shape` was documented as the body/noise crossfade the `.dsp` does with **`toneKnob`**, and with the **opposite polarity** | ✅ **FIXED** |
| **B** | `tone` described as a timbre macro | ⛔ **STILL OPEN.** `drummergirl.ts:274` reads verbatim *"shifts the oscillator's brightness/character from dark and round toward bright and edgy"*. The oscillator is a fixed sine (`oscillators.lib:463`); its timbre never changes. |
| **C** | "Only the rising edge matters / hit length is set by Decay rather than how long the gate stays high" | ✅ **FIXED.** The measurement that killed it stands: `en.adsr` sustains at `sustainOf(shape)` while high and release begins only at `gate == 0`; at shape ≈ 0.733 sustain is **0.5**. **With a typical drumseqz gate (120 BPM 16th, `gateLength` 0.5 → 62.5 ms — `drumseqz.ts:451-452`) the default 150 ms decay NEVER COMPLETES — the release truncates it at ~0.59 amplitude.** |
| **D** | "sampled at the gate edge that fires the note" | ⛔ **STILL OPEN** — `drummergirl.ts:263`. There is **no sample-and-hold** anywhere in the `.dsp`; `pitchKnob` is continuously smoothed (`:6`) and read continuously (`:60, :71`). |
| **E** | "an internal AD envelope" | ⛔ **STILL OPEN** — `drummergirl.ts:9`. It is a full **ADSR** (`:76-82`) whose A, S and R are shape-driven. |
| **F** | the `gate` port declares no `edge:` | ✅ **FIXED** — `drummergirl.ts:47` is now `edge: 'gate'`. (Its absence is why C survived: `module-docs-lint`'s vocabulary gate short-circuits on `if (!p.edge) continue`.) |
| **G** | a lying VRT comment | ⛔ **STILL OPEN** — `e2e/vrt/vrt-exemptions.ts:1101` still reads *"drum-sample card … sample preview is static post-load"*. There is no sample, no sample preview and no post-load anything; the card is five faders and the voice is fully synthesised. |
| **H** | `art/DETERMINISM.md:17` lists drummergirl among modules consuming `Math.random` — false; it is Faust's seeded LCG inside the WASM worklet, and the repo's own drift report contradicts it (pearson 1.0000, "sample-identical", `art/audio-drift/report-2026-05-07.md:99-112`) | **UNVERIFIED** — not re-checked in this pass. |
| **I** | misclassified as a sequencer | ⛔ **STILL OPEN** — `packages/web/src/lib/mike/music-theory.ts:196` puts `drummergirl` in `SEQUENCER_TYPES` while `catalog.ts:61` correctly lists it under `drumVoices`; via `personality.ts:167,175` a Mike-owned drummergirl would be classified as a melody/bass sequencer. Latent (no `clock` port makes `findClockSource` unreachable) but real. |
| **J** | card units divergence | ⛔ **STILL OPEN** — `DrummergirlCard.svelte:31` passes `units="st"` where the def declares `units: 'semi'` (`drummergirl.ts:61`), and `:31-35` re-type every range as literals while `:14-18` correctly read defaults from the def. |

**Related, from §2:** the card renders `pitch, tone, shape, decay, volume`
(`DrummergirlCard.svelte:31-35`) while the def declares `pitch, tone, shape, volume, decay`
(`drummergirl.ts:61-65`) — two different orders for the same five controls, and the Push 2 card
follows the *def*, so the hardware and the card already disagree.

**No ART pin exists.** drummergirl has **no ART baseline at all** — it is on `ART_BACKLOG`
(`art/setup/profile-coverage.ts:76`), so there is no audio regression pin for a future DSP-touching
fix. Worth flagging on its own.

⚠ **drummergirl is in `STRICT_VRT_MODULES`**, i.e. the `vrt-strict` context ruleset 16042163
**REQUIRES**. Any card change re-captures that baseline.
