# `pentemelodica` — the face SHIPPED (#1332). What survives is the measurement.

The face landed in **#1332** (`2d111616`) and pentemelodica is in `STRICT_FACES`; the ranking
table, the `face:` mock-up and the cost estimate this spec carried are spent. **Read the shipped
def.** What is kept below is the mechanism, the layout arithmetic that explains *why* the face is
a tab rail, the measured readout derivations, and the defects that are **still open**.

✅ **The headline defect is FIXED.** "The notch is not a notch" was corrected in
**#1412** (`6f83b138`): `modeMorph` now computes `x − k·bp`
(`packages/dsp/src/lib/pentemelodica-dsp.ts:207`) and the measured ladder that proved the bug is
kept in the source as a comment (`:184-195`), cross-checked against `resofilter-dsp`'s
`pickModeOutput` in the unit test.

---

## 1. WHAT IT ACTUALLY DOES

⚠ **FRAMING CORRECTION, load-bearing:** pentemelodica is **not** a melodic generator, a sequencer
or a quantiser. There is no scale table, no pentatonic anything, no PRNG, no clock, no step
engine. A grep of the def, worklet, DSP lib and card for
`pentatonic|SCALE|quantis|degree|random|seed|clock|bpm|tempo|step` returns **zero hits outside
the prose**. The name is a pun on *five* — `PENTE_VOICES = 5`. It is a **five-voice polyphonic
synth VOICE** — a sink for a chord bus, not a generator; closer to CUBE or DX7 than to a sequencer.

Per sample, per voice (`renderPentemelodica`, `pentemelodica-dsp.ts:296-388`):

- **Block preamble** (`:308-324`): filter coefficients `g = tan(π·fc/sr)`
  (`packages/dsp/src/lib/resofilter-dsp.ts:82-87`) and `k = max(0.003, 2 − 2·res)` (`:76-79`) once
  per block; then a five-iteration gate-edge loop reading `poly[2v+1] > 0.5` (`:317`), firing
  `env[v].trigger(true/false)` on transitions, and updating a **persistent held V/oct** — tracked
  while gated, **held through release** (`packages/dsp/src/lib/poly-osc-sum.ts:53-55`) so a tail
  does not snap to C4.
- **Pitch selection** — `laneRenderVOct` uses the voice's own held pitch if gated *or* still
  audible, **else lane 0's** (`poly-osc-sum.ts:69-76`). That fallback is invisible on the panel and
  the per-voice note readout is the only way to see it.
- **Frequency** — one exponential:
  `f = 261.626 · 2^(voct + tune/12 + fine/1200 + fm·fmIn)`, clamped `[0.01, min(40000, 0.49·sr)]`
  (`:139-151`). **FM is exponential; PM is added to the phase READ only, not the accumulator**
  (`:350-351`). The phase advances **unconditionally**, gated or not (`:358-360`).
- **Waves** — `moogWaves()` emits four polyBLEP/polyBLAMP band-limited taps off one phase
  (`packages/dsp/src/lib/moog-vco-dsp.ts:118-150`); `waveMorph` crossfades tri→saw below 0.5 and
  saw→square above (`:161-172`).
- **Envelope** — one `Envelope.tick()` per voice reading the **single shared A/D/S/R** (`:362`).
- **Sum → filter → out** (`:376-386`): `sumL/R × PENTE_MASTER_GAIN = 0.6` — a **constant,
  deliberately not `1/√N`** (`:279`), unlike the sibling helper which does normalise
  (`poly-osc-sum.ts:161`). Then one TPT SVF step per channel and a `modeMorph` blending
  lp → bp → hp → notch, then a linear wet/dry.

### The 5×8 problem, and why the faceplate is a TAB RAIL on purpose

Forty of the forty-eight params are **five identical strips of eight**
(`v{1-5}_{tune,fine,fm,pm,pw,wave,level,pan}`). `face.order` is a flat priority list and
`face.pages` is a flat band list; **neither can express "this group, five times"**. The
consequences are arithmetic, not taste:

- Five voice bands + an envelope band + a filter band = **7 bands**, and
  `DOCK_TAB_MIN_BANDS = 7` (`packages/web/src/lib/ui/workflow/dock-tabs-model.ts:46, 62`) — **at
  exactly seven the whole faceplate collapses into a TAB RAIL.** That is the boundary condition,
  hit precisely. It was taken deliberately rather than merging voices into a band that would fuse
  five different ideas. **Do not "fix" it back to six.**
- The lane budget is six (`curated-face.ts:46, 65`), so **at most six of forty-eight controls ever
  reach a lane tile**, and any six chosen from five symmetric strips would be arbitrary. The face
  ranks the *global* controls instead — voice 1 is not more important than voice 4, and the DSP
  agrees (lanes map fixed 1:1 with no allocator).

---

## 2. INERT AT SPAWN — the module makes NO sound, and the face says so

**All 48 params are inert on a bare spawn.** With nothing patched, input 0 carries only the
0-offset `ConstantSource` keep-alive (`pentemelodica.ts:289-292`), so `polyScratch` is all zeros,
`gated` is false for every lane (`pentemelodica-dsp.ts:317`), `trigger()` never fires, every
envelope stays `Idle` returning 0, and **all seven outputs are exactly silence.** There is no
drone and no free-run — explicitly unlike CUBE and WAVECEL, which *do* drone when ungated
(`per-module-per-port-behavioral.spec.ts:1044-1050`). **It requires an external poly gate
source.** CPU cost is nonetheless constant: the phase accumulators and SVF state advance every
sample regardless.

Even *with* a chord patched, **16 of 48 are dead at defaults**: 10 FM/PM (they multiply the `fmN`
inputs, unpatched at spawn — formally exempted for that reason at
`per-module-per-port-behavioral.spec.ts:1028-1032`), 5 PW (the rectangular tap's weight is zero for
`wave < 0.5`, `moog-vco-dsp.ts:166-169`, and `wave` ships at 0), and `decay` — at the shipped
`sustain = 1` the Decay branch hits `|value − susTarget| < 1e-4` on its **first tick** and jumps
straight to Sustain (`packages/dsp/src/lib/adsr-env.ts:74-84`): **zero samples of decay ever run.**

---

## 3. THE DERIVED READOUTS AND WHAT EACH ONE SEES

### A. per-voice resolved pitch
```
f_v = 261.626 · 2^(voct_v + tune_v/12 + fine_v/1200)          # pentemelodica-dsp.ts:146
voct_v = own held pitch if gated-or-ringing, ELSE lane 0's    # poly-osc-sum.ts:69-76
```
**NEGATIVE CONTROL:** change the incoming chord's octave without touching a knob. **Every knob
readback is invariant to the played note**; the resolved Hz/name moves a full octave.
**Second leg, and it is the important one:** with nothing gated, **voice 3's resolved pitch must
display lane 0's pitch, not its own.** A per-voice-knob readout is structurally incapable of
showing that fallback, and the fallback is the single most confusing behaviour in the module.

### B. detune as a beat rate
`beat_Hz = f · |2^(Δst/12 + Δ¢/1200) − 1|`. **NEGATIVE CONTROL:** the FINE knob is **invariant to
register**; the beat rate is not. A fixed +10 ¢ beats at **0.38 Hz at C2, 1.52 Hz at C4, 6.06 Hz at
C6**. Move only the played octave: the readback freezes, the derived number moves **16×**.

### C. release / decay — the knobs are time CONSTANTS, not durations
```
tail_s     = release · ln(sustain / 1e-5)                     # :117-123
decay_to_S = decay   · ln((1 − sustain) / 1e-4)               # :105-113
```
At the shipped defaults (r = 0.005, s = 1) the actual tail is **58 ms — 11.5× the labelled 5 ms**.
At d = 0.1, s = 0.7 the decay takes **0.80 s, 8× the label**.
**NEGATIVE CONTROL:** drop SUSTAIN 1.0 → 0.1 without touching RELEASE. The release readback is
frozen; the derived tail moves 58 → 46 ms. At sustain 0 the tail is ~0 while the knob still says
0.005 s.

### D. peak — the headroom nobody guards
```
peak = 0.6 · Σ_gated ( level_v · cos((pan_v + 1)·π/4) )       # :369-377, PENTE_MASTER_GAIN :279
```
Five gated voices at defaults = **1.697 = +4.59 dBFS**; one voice = 0.339. There is **no `1/√N`**.
**NEGATIVE CONTROL:** gate a 4th and 5th note. **No knob moves**, and the peak climbs
1.018 → 1.358 → 1.697 through clipping. **Second leg:** spread PAN — `peak_L` falls with every
LEVEL unchanged.

### E. gated vs sounding
`gated = poly[2v+1] > 0.5` (`:317`) vs `sounding = gated || env > 0` (`:337`).
**NEGATIVE CONTROL:** release the chord. Gated drops to 0 instantly; **sounding stays 5 for the
tail.** A gate-count readout is invariant to release length.

### F. mode gain — the readout that found the notch bug
The closed form `|1 − 1/(2 − 2·resonance)|` existed only *because* mode 1 computed `x − bp`
instead of `x − k·bp`. **#1412 removed the bug**, so the modern notch nulls at fc for every
resonance and this readout's whole point is gone. Recorded because the *method* transfers: a
readout that is a function of MODE alone is invariant to RESONANCE and could not have seen any of
it — the two-input derivation is what made it an instrument.

---

## 4. ALREADY-WRONG — still open on `main`, verified 2026-08-10

- **B · "a single mono note source only lights one voice" is FALSE** — still in the authored
  explanation (`pentemelodica.ts:499`, and repeated in `DESCRIPTIONS`). A mono
  `pitch`/`cv`/`audio` → poly merges into **input 0 = channel 0 = lane 0 PITCH**; channel 1
  (lane 0's *gate*) gets no source (`packages/web/src/lib/audio/poly.ts:395-405`) ⇒ gate = 0 ⇒ the
  envelope never triggers ⇒ **total silence**. Only a mono **`gate`** source (`poly.ts:406-415`,
  `mergeInputs: [1]`) opens voice 1 — and then at 0 V/oct = C4 regardless of any pitch.
- **C · `decay` documented as "the fall from the attack peak down to the sustain level"**
  (`pentemelodica.ts:562`) — at the shipped `sustain = 1` there is no fall; it ships **inert**.
- **D · `release` documented as "how long each voice takes to fade out"** (`:564`) — it is a time
  constant and the real tail is **11.5× longer** (§3-C). Same for decay.
- **E · stale comment:** `pentemelodica.test.ts:4` still says "60 params"; the assertion below it
  says 48.
- **F · no headroom protection**, and the constant master gain is admitted in the source to have
  been chosen for *baseline determinism*, not level (`pentemelodica-dsp.ts` around
  `PENTE_MASTER_GAIN`, `:279`).
- **G · no `edge:` anywhere, and there is nowhere to put one.** Gate semantics live in the poly
  bus channel layout, thresholded at 0.5 (`:317`); pentemelodica declares no `gate`-typed port
  (`contract-lock.txt:2475-2480` — five `audio` fm ins and one `polyPitchGate`), and `edge` is only
  meaningful on `gate` ports. Recorded as a **taxonomy gap**, not a missing declaration.

**Verified correct (no bug):** the `voiceN` taps really are pre-level/pre-pan (`:366` precedes
`:369-373`); FM really is exponential (`:345` inside the pow2) and PM really is through-phase
(`:350-351`); and the card's waveform preview is honestly invariant to PW below wave 0.5, matching
the audio. ⚠ The card **re-types 44 of 48 ranges** as literals (`PentemelodicaCard.svelte:137-142,
154-155, 185-188`); only the ADSR block imports from the def. All twelve distinct literal ranges
currently **match** — which is the hazard, not the reprieve. Convert to `paramSpec()`.
