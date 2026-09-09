# `analogVco` — the face SHIPPED (#1416). What survives is the measurement.

The face landed on `main`; **read the def and `AnalogVcoCard.svelte`, not a face block written
here.** The spec's ranking, its `face:` mock-up, its readout wiring and its cost table are all
spent, and the shipped face differs from the mock-up anyway (**TWO bands + three clusters**, not
three bands — clusters paint at rest and band hints do not, since `facePageHeader()` returns
`null` when annotations are off, *including the title*). What is kept below is the DSP
measurement, the VRT finding, and the defects that are **still open**.

## The VRT finding — why `face-analogVco-compact` carries a mask

analogVco is a FREE-RUNNING oscillator, so its live `scope` glyph draws a moving saw where the
sibling faces draw a flat centreline. Re-derived under the corrected instrument — **10 SEPARATE
Playwright processes** via `scripts/vrt-derive-trials.sh`, **not** `--repeat-each`:

- **1/10 PASS unmasked**, diffs 227–322 px against an effective 72 px budget: a 90 % failure rate,
  far stronger than the 254/154/315 three-capture reading that got the face dropped once.
- **THE CONTROL, same machine and session, WITH the mask: 10/10 PASS.**
- The mask is `VRT_LIVE_SURFACES['face-analogVco-compact']` on `[data-testid="shell-glyph"]` —
  **8.7 % of the tile, the cheapest entry in the registry** (mandelbulb 22.6 %, the wavesculpt
  pair 84.8 %) — plus a MEASURED companion (ink ≥ 0.22 / stdDev ≥ 18 / buckets ≥ 5 / chroma ≥ 22
  against live 0.66/56/12/68 and a force-killed 0.0000/0.83/1/9.48), negative-controlled on every
  run by the capture seam.

Three captures were not enough to see a 90 % failure rate. **`--repeat-each` is the wrong
instrument for a determinism question** — separate processes are what moved the number.

---

## 1. WHAT IT ACTUALLY DOES

**One phase accumulator. Six outputs. The knobs do not all address the same output.**

Signal path, in DSP order (`packages/dsp/src/analog-vco.dsp`):

1. **Smoothing.** All six sliders pass `si.smoo` (`analog-vco.dsp:8,9,13,14,15,20`) —
   `si.smooth(1 - 44.1/ma.SR)`, τ ≈ **22.67 ms at 48 kHz**, sample-rate invariant. So a
   stepped CV on `shape` is a 23 ms portamento across the morph, not a jump.
2. **Frequency.** `freqHz(pitch, fm) = 261.626 * pow(2, pitch + tune/12 + fine/1200 +
   fmAmount*fm) : max(1) : min(20000)` (`analog-vco.dsp:24-27`). Four facts fall out of
   that one line: `pitch` is in **octaves**; FM is **exponential** and also in octaves, so
   `fmAmount = 1` against a ±1 modulator is **±12 semitones**; the [1 Hz, 20 kHz] clamp is
   unreachable from the panel (tune ±36 + fine ±100 ¢ spans **30.868 – 2217.465 Hz**); and
   the sounding pitch is a sum of four terms, only two of which are knobs.
3. **Hard-sync edge detect.** `syncEdge(s) = (s > 0) & (s' <= 0)` (`analog-vco.dsp:38`) —
   per-sample inside the worklet, correct by construction.
4. **Phase accumulator with reset.** `loop(prev) = (1 - reset) * ma.frac(prev + f/ma.SR)`
   (`analog-vco.dsp:50-53`). At `reset = 0` this is bit-identical to a plain phasor
   (unit-proven, `packages/dsp/src/analog-vco-sync.test.ts:88-112`).
5. **PM injection.** `p = ma.frac(pRaw + pmAmount * pm)` (`analog-vco.dsp:103`) — a phase
   offset **in cycles**, so `pmAmount = 1` is ±360°. `sync_out` is driven from `pRaw`
   (pre-PM) deliberately (`analog-vco.dsp:88-92`).
6. **Four fixed taps off the SAME `p`** (`analog-vco.dsp:56-59, 98`): `saw = 2p-1`,
   `sqr = select2(p<pw, 1, -1)`, `tri = 4|p-0.5|-1` (note: this triangle *starts* at +1 and
   troughs at p = 0.5 — polarity-inverted from the textbook shape), `sn = sin(2πp)`.
7. **The morph tap (5th output).** Two-segment crossfade over the same `p`
   (`analog-vco.dsp:78-84`): below 0.5, `sn·2·shape + saw·(1-2·shape)`; at or above,
   `sqr·(2·shape-1) + sn·(2-2·shape)`. Endpoints exact: 0 = saw, 0.5 = sine, 1 = the
   **live-`pw`** square (`analog-vco.dsp:68-77`).
8. **`sync_out`.** `(pRaw < pRaw') * 1.0` (`analog-vco.dsp:93`) — one +1 sample per wrap,
   a trigger train at the sounding fundamental.

**There is no band-limiting anywhere in the 105-line file** — no PolyBLEP, no oversampling,
no antialiasing filter, no DC blocker, no drift, no noise, no saturation. At C4/48 kHz the
naive saw aliases from harmonic 91 up; at `tune = +36` (2093 Hz) from harmonic **11**.

### The fact the legacy card could not express

`shape` touches **only** the `morph` output (`analog-vco.dsp:98` selects the four fixed taps
independently). `pw` touches the `square` tap always, and the morph **only in proportion to
`2·shape − 1`** (`analog-vco.dsp:80,83`) — and `shape` ships at **0**, so at spawn PW's
contribution to the morph tap is **exactly zero**
(`packages/dsp/src/analog-vco-morph.test.ts:204-210` asserts rms < 1e-9 for shape ∈
{0, 0.1, 0.25, 0.4}). That is what the shipped `analogvco-pw-authority` readout says out loud,
and it reads **0 %** at the defaults.

⚠ **`analogvco-knob-hz` is labelled `knob pitch`, deliberately.** It is
`261.626 · 2^(tune/12 + fine/1200)` — **blind to the `pitch` jack, to FM, and to CV on the
`tune`/`fine` jacks**, the same blindness the pre-existing helper `currentFreqHz()` has
(`analog-vco.ts:192-197` reads the *intrinsic* AudioParam, and its own comment discloses only the
`pitch` case). A readout that said `pitch` while a sequencer drove the module two octaves away
would be a lie the platform would happily paint.

⚠ **The hero picture SUPPRESSES the dock glyph** (`face.hero.cell` makes `heroGlyph` false at the
dock; mini/compact/full are untouched). Correct here: the `scope` glyph traces the *first* audio
output in declaration order (`shell-glyph-live.ts:96` `primaryAudioOutPortId`) = **`saw`**, the one
tap no control on this face changes.

---

## 2. STILL OPEN — verified against `main` on 2026-08-10

- **`shape` CV throws half its travel away.** `scaleCv`'s `halfSpan = (max-min)/2`
  (`packages/web/src/lib/audio/cv-scale.ts:69-70, 80-81`) gives `shape` ±0.5, and the LUT is baked
  with the knob value at plug-in time. At the shipped `shape = 0` a full ±1 LFO reaches only
  0…0.5 — **the morph never gets past sine.** The `shape` CV in declares no `center`
  (`analog-vco.ts:81`). A fix (`center: 'default'` or a port `depth`) is a CONTRACT change →
  contract-lock + owner review. **Its own PR.**
- **`sync` in and `sync` out are `audio`-typed, so they cannot declare `edge:`** — and the spec's
  original "missing `edge` declaration" framing is WRONG. `graph/types.ts` states `edge` is
  "Only meaningful on `gate`-typed ports", and `contract-lock.txt:69, 75` confirm both sync ports
  are `audio`. This is a **port-TYPING** gap (a trigger carried on an audio cable), not a missing
  declaration. **Do not "fix" it by adding `edge:`.**
- **The primary input is untested end-to-end.** `e2e/tests/vco-pitch-tracking.spec.ts:35-41`
  still excludes analogVco: its worklet "doesn't read the audio-rate `pitch` input in this test's
  setup (returns ~30 Hz at every reference pitch)", closing with *"Track in a follow-up."*
  ⚠ **INFERENCE, unresolved:** ~30 Hz is suspiciously close to the knob-only floor of 30.868 Hz
  (§1), which is consistent with the pitch signal never reaching channel 0 — the tree's comment
  asserts the math is correct end-to-end and that only a routing assertion is missing, but nothing
  measures which of those two it is.
- **`FaceReadoutValue` still sees params only** —
  `packages/web/src/lib/ui/workflow/face-readout-values.ts:176` is still
  `(read: (paramId: string) => number | undefined) => string`. The three readouts a VCO genuinely
  wants (measured sounding pitch, sync-out rate under CV, the alias harmonic at the *real* sample
  rate) are functions of the patch, not of params. The minimal extension is
  `{ read, sampleRate, readLive }` — `engine.readParam` already returns *intrinsic + modulator-tap
  sample* (`packages/web/src/lib/audio/engine.ts:737-747`) and the card already consumes it, so the
  CV-aware half is wiring, not new machinery. **Platform PR, not a face PR.**
  (macrooscillator asks for the identical widening.)

**Closed, recorded so nobody re-opens them:** the card's `min={0}` on `fmAmount`/`pmAmount`
(the whole negative half of both depth controls was unreachable) was fixed by **#1311**
(`de2c956b`) binding all six faders through `paramSpec()`, with `dead-control-fixes.test.ts` as the
source-level gate; `docs.controls.pw`'s impossible "animate with an LFO" (there is no `pw` CV
jack), `docs.controls.fmAmount`'s wrong sign mechanism, the "classic analog-modeled / like a
hardware Moog VCO" prose, the "four waveform tap-offs" header on a 6-channel splitter, the
`DESCRIPTIONS` entry that omitted morph/PM/sync, and a `vrt-exemptions.ts` comment claiming a
live-surface entry that did not exist — all fixed in `897b6515` / #1416.
