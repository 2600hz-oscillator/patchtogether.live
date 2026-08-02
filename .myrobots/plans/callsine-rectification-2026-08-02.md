# CALLSINE RECTIFICATION

**Date:** 2026-08-02
**Status:** PLAN — nothing built. No code in this PR.
**Trigger (owner):** *"if callsine is done it's worth a do-over with an eye towards fully
replicating the controls, behavior and faceplate from ../callsine repo. the thing we have is not
nearly as powerful as the callsine vst, and we should rectify that."*

**Upstream read at:** `../callsine` @ `88f4886` ("phase 42: MassPass adds 66 and 99 band options
+ v0.6.0 bump (#39)"), `project(callsine VERSION 0.6.0)`.
**Ours read at:** `f5cb7550`.

---

## TL;DR

1. **The briefing premise for this task was wrong, and the correction changes the answer.** Ours is
   not "a different instrument wearing the name". It is a **faithful but reduced port of the VST's
   own `SpectralResynth` class** — same algorithm, same constants, some of them digit-for-digit.
   Only the *parameter names* differ (Plaits macros bolted over spectral quantities).
2. **The real naming defect is elsewhere and nobody has noticed it.** The plugin is ONE product with
   TWO names — "Warren's Spectrum" *is* "CallSine" (`../callsine/README.md:3`). We shipped **two
   separate modules, one under each name**, each porting a **different half of the same signal
   chain**, neither aware of the other: `callsine` = the spectral engine, `warrenspectrum` = the
   8-band filterbank.
3. **Recommendation: (b) replace in place. Do NOT rename.** Extend `callsine`. A rename costs 17
   repo files *and* **silently deletes the module + its cables from every saved rack** — there is no
   migration substrate left to catch it.
4. **Do NOT port the whole plugin.** Of the VST's **104** runtime parameters, only ~15 belong inside
   a module in a modular rack. The filterbank, feedback loop, reverb, delay and master filter are
   things this rack **already does with other modules and a cable**. Porting them inside `callsine`
   would rebuild a DAW inside a patch point.
5. **The gap that actually matters is small and cheap.** Seven analyzer-side scalars — `SLICE`,
   `FLOOR`, `STABILITY`, `RESIDUAL`, `PARTIALS`(scale-up), `PARTIAL CAP`, `SHAPE` — plus FFT
   1024→2048. That is the whole "not nearly as powerful" complaint.

---

## §0 — CORRECTION TO THE BRIEF (read this before trusting any prior summary)

The task brief carried three measured claims. I re-verified all three, as instructed. **Two are
wrong and one is imprecise.** They are corrected here because the recommendation inverts on them.

| Brief said | Actual | Evidence |
|---|---|---|
| "Our module and the VST share a name and **NOTHING else**." | **False.** Ours is a direct port of the VST's `SpectralResynth`. | See the constants table below. |
| "OURS … is a **Plaits-style MACRO-OSCILLATOR**." | **False.** Ours is an FFT peak-tracking additive **resynthesizer**. The *names* are Plaits macros; the DSP underneath is spectral. | `packages/dsp/src/callsine.ts` — 1024-pt radix-2 FFT, Hann, parabolic peak interpolation, MQ tracking, HSS F0 detect. |
| "THE VST (**49 parameters**)" | **104** runtime parameters. 49 is the count of `layout.add(` *source lines*; 7 of them sit in an 8-iteration band loop and 6 in a 2-iteration FX-slot loop. | `49 − 7 − 6 + (8×7) + (2×6) = 104`. |

### The constants that prove the lineage

These are not "both implement a known algorithm" coincidences. They are the same **arbitrary
choices**, carried across:

| Quantity | VST | Ours | |
|---|---|---|---|
| MQ match tolerance | `kMatchTolerance = 0.05f` (`SpectralResynth.h:226`) | `bestDist = 0.05` (`packages/dsp/src/callsine.ts:559`) | identical |
| Anti-alias ramp | `nyquist*0.85` cutoff, `nyquist*0.75` ramp start (`SpectralResynth.cpp:894-895`) | same two literals (`callsine.ts` render loop) | identical |
| F0 search band | 60–800 Hz (`SpectralResynth.cpp:244`) | `F0_LO_HZ = 60`, `F0_HI_HZ = 800` (`callsine.ts:71-72`) | identical |
| F0 harmonic count | `kMaxHarmonics = 8` (`SpectralResynth.cpp:246`) | `F0_KMAX = 8` | identical |
| F0 weighting | `mag / sqrt(k)` | `mag / sqrt(k)` | identical |
| Peak interpolation | parabolic in **log**-magnitude | parabolic in **log**-magnitude | identical |
| Amp scale | Hann coherent gain `4/N` | `ampScale = 4 / FFT_SIZE` | identical |
| Freeze semantics | skip `analyzeFrame()`, bank holds (`SpectralResynth.cpp:845,928`) | same | identical |

**Conclusion: `callsine` is a correct port that stopped early.** That is a completely different
repair job from "wrong instrument, start over", and it is why the recommendation below is *extend*,
not *replace*.

> **Why the brief got it wrong, and the lesson.** The brief's instrument was a **parameter-name
> diff**. A name diff is *invariant to the algorithm underneath* — it returns a clean, confident
> "zero overlap" for a faithful port that merely renamed its knobs. This is the exact failure mode
> in CLAUDE.md's *VALIDATE THE INSTRUMENT* section: a metric blind to the dimension under test will
> happily return a number. The negative control that would have caught it in 30 seconds: open the
> worklet and look for an FFT.

---

## §1 — THE VERDICT AND THE NAMING PROBLEM

### 1.1 The naming problem is not the one we were looking for

`../callsine/README.md:3`:

> "# Warren's Spectrum … The internal CMake target is still named `callsine` for repo continuity."

One plugin. Two names. And we have shipped **two modules, one per name, each porting a different
subsystem of that one plugin**:

| Our module | What it actually is | Upstream subsystem |
|---|---|---|
| `callsine` | FFT peak-tracking additive resynth, 6 params | `dsp/SpectralResynth.{h,cpp}` |
| `warrenspectrum` | 8-band resonator bank, per-band level/pan/Q + per-band sends & returns, 16 params | `dsp/FilterBank.{h,cpp}` (8 bands, per-band cutoff/Q/type/pan + 3 sends) |

Neither def mentions the other. `warrenspectrum` has drifted genuinely away from upstream (vactrol
ping excitation, a bleed matrix, per-band insert send/return jacks, a `mono-video` output — none of
which exist in the VST), so this is **not** a duplicate to be merged. But it does mean the honest
statement of the situation is:

> We did not fail to port CallSine. We ported it **twice, under both of its names, in halves**, and
> the halves cannot see each other.

**Action:** cross-reference the two defs' `docs.explanation` and `ossAttribution` so the lineage is
discoverable. `warrenspectrum` currently carries no `ossAttribution` at all while `callsine` does
(`callsine.ts` — `ossAttribution: { author: "callsine contributors (Warren's Spectrum)" }`).

### 1.2 The verdict: (b) replace in place. Do not rename. RECOMMENDED.

The owner asked for a rectification, so here is the decision rather than the question.

**Rename ours + build callsine fresh — REJECTED.** Three reasons, in descending force:

1. **It would rename a correct port.** §0 establishes ours *is* the VST's spectral engine. There is
   no honest new name for it; "what it actually is" is *CallSine's resynth engine*.
2. **It silently destroys user data.** The persistence loader drops any node whose type is not
   registered, and **the migration substrate that could have remapped it no longer exists**:

   > `packages/web/src/lib/graph/persistence.ts:26-30` — *"an unknown type is dropped (flagged as a
   > load diagnostic). It no longer reads any per-module version/migrate metadata: the
   > `schemaVersion` / `moduleSchemas` migration substrate was collapsed in the schema cleanup."*

   > `packages/web/src/lib/graph/persistence.ts:369-375` — `if (!isKnownModuleType(node.type)) {
   > diagnostics.push(…); continue; // Phase 1: skip. }`

   The node vanishes, **and so does every cable attached to it** (`persistence.ts:410` — *"Drop
   edges referencing dropped nodes (e.g. unknown module types)"*). A saved rack silently comes back
   smaller. A rename therefore requires **building a type-alias migration first** — new
   infrastructure, not a rename.
3. **The blast radius is 17 files** — `git grep -l callsine` over `*.ts *.svelte *.txt *.json *.yml`:
   `packages/dsp/src/callsine.ts`, `…/modules/callsine.ts`, `…/modules/callsine.test.ts`,
   `…/ui/modules/CallsineCard.svelte`, `…/docs/contract-lock.txt`, `…/docs/module-manifest.ts`,
   `…/docs/strict-docs.ts`, `…/docs/interactive/interactive-doc-modules.ts`,
   `…/ui/modules-card-map.test.ts`, `…/ui/rack-sizes.ts`, `…/graph/patch-convenience.ts`,
   `…/graph/patch-convenience-columns.test.ts`, `…/modules/oss-attribution.test.ts`,
   `art/setup/profile-coverage.ts`, `e2e/vrt/vrt-exemptions.ts`,
   `e2e/tests/docs-virtual-module.spec.ts`, `e2e/tests/midi-learn.spec.ts`.
   Plus a `docs:accept` re-pin and a VRT-baseline re-capture.

**Replace in place — ACCEPTED.** Keep `type: 'callsine'` (`callsine.ts:517`). Grow the def. Every
phase below is additive to the contract: new params, new docs keys, one `contract-lock` re-pin per
phase, zero saved-rack breakage. Existing racks keep working because every new param ships with a
default that reproduces today's sound (§5 makes this a hard rule).

**The one thing to rename is a label, not a type.** Our param names are Plaits macros over spectral
quantities, which is why the brief misread the module. `harmonics`→PARTIALS, `timbre`→SLEW,
`morph`→LOCK. **Change the `label:` and the docs prose; keep the `id:`.** Param *ids* are persisted
in saved racks exactly like module types — but `label` is display-only and free. This buys the whole
readability win at zero migration cost, and it is why §5 Phase 1 does it first.

---

## §2 — WHAT THE VST ACTUALLY DOES

### 2.1 The signal path

Read from `PluginProcessor.cpp:288-451` (the block comments there number the stages; this follows
them).

```
 input (stereo)
   │
   ├── mono downmix ──────────────────────────────────────┐
   │                                                       │
   ▼  (1) ENGINE — one of three, mutually exclusive        │
 ┌──────────────────────────────────────────────┐          │
 │ SPECTRAL : SpectralResynth  (FFT → sine bank)│          │
 │ MASSPASS : MassPass (16..99 BP → ZC-pitched  │          │
 │            osc per band, no FFT at all)      │          │
 │ WAVETABLE: engine silent; the WT insert at   │          │
 │            (4.5) becomes the engine          │          │
 └──────────────────────────────────────────────┘          │
   │ mono                                                  │
   ▼  (2) FILTERBANK — 8 parallel SVFs, each morphable     │
   │      LP→BP→HP, panned, then split THREE ways:         │
   │      MAIN / FX1 / FX2   (FilterBank.h:26-46)          │
   │                                                       │
   ▼  (3) WET CROSSFADE  filterbankWet·bank                │
   │      + (1-wet)·drySrc + inputMix·rawInput ◄───────────┘
   │
   ▼  (4) FEEDBACK LOOP (per channel, in place)
   │      out[n] = softclip(in[n] + amount · SVF(out[n-D]))
   │      D = 0.5..1000 ms  →  comb resonator .. echo
   │
   ▼  (4.5) WAVETABLE INSERT (8-cell ring, morph/spread/width)
   │        + post-WT sends into FX1/FX2
   │
   ▼  (5) FX1 (Reverb) and FX2 (Delay), on their own buses
   │
   ▼  (6) SUM → MASTER FILTER (morphable SVF) → GAIN → out
```

### 2.2 The spectral engine, stage by stage

`SpectralResynth.h:19-45` states the design intent, including what it deliberately refuses:

> "What this class deliberately does NOT do: **Phase-vocoder IFFT reconstruction** (too faithful —
> output would sound like the input). The user wants a tracked-peaks resynth, which is audibly
> synthetic rather than transparent."

That refusal is the whole aesthetic. It is also **already true of ours**, and it must stay true — see
§3.4.

Per analysis hop (`analyzeFrame()`, `SpectralResynth.cpp:413`):

1. **Window + transform.** Linearise the circular buffer × Hann, real FFT. `fftOrder_ = 11` →
   **N = 2048**, `hopSize_ = fftSize_/4 = 512` default (`SpectralResynth.h:162-164`).
2. **Magnitude + phase per bin**, and `maxMag` / `totalEnergy`.
3. **F0 detection** (`detectF0`, `:232`). Harmonic-sum over candidate bins 60–800 Hz, `k = 1..8`,
   weighted `1/sqrt(k)` to prefer the true fundamental over its octave. Confidence is a **z-score of
   the winner against the whole candidate distribution**, normalised by `sqrt(log n)`; white noise
   lands ≈1.0–1.2, a pitched stack ≈1.7–2.5. Confidence is what gates LOCK.
4. **Peak detection.** Local maxima above `thr = maxMag · 10^(FLOOR/20)` (`:453`), parabolic
   interpolation in **log** magnitude for sub-bin frequency and amplitude.
5. **Salience ranking** (`peakSalience`, `:110-137`) — *not* raw amplitude. A peak within 25 cents of
   an integer multiple of F0 gets a bonus up to `1 + 3·(1/sqrt(k))·conf·lock`. This is why reducing
   PARTIALS collapses toward the fundamental instead of toward "whichever bin was loudest" (often a
   formant). Degrades to plain amplitude ranking when LOCK is 0 or F0 confidence is low.
6. **MQ tracking.** Each surviving peak claims the nearest unclaimed live track within 5 % relative
   frequency; unmatched peaks are born into a free slot; unmatched tracks are killed.
   Birth is click-avoidant: **do not reset amp** (a decaying slot keeps its amplitude), and **only
   snap phase to the bin phase if the oscillator is currently silent** (`:702-727`).
7. **Residual estimation.** Mask ±3 bins around every claimed peak; integrate the *unclaimed* energy
   into 16 log-spaced bands (80 Hz .. min(12 kHz, 0.45·SR)); those become the noise-bank envelopes.

Per sample (`process()`, `:888`): advance every track's amp toward its target, advance phase, apply
the Nyquist ramp, render `voiceWaveform(phase, dt, shape)`, sum, add the modulated noise residual,
scale by gain.

### 2.3 What the four mysterious controls actually do

The brief flagged these as unexplained. They are all analyzer-side and all cheap.

**FREEZE** (`engineFreeze`) — *skips `analyzeFrame()` on the hop boundary* (`:845`, `:928`). Nothing
else. The track bank keeps rendering the last-acquired set of `(freq, amp)` forever. Not a buffer
loop, not a sample hold: a **spectrum** hold, so it stays smooth and phase-continuous and you can
still transpose it. **We already have this**, on a gate rising edge.

**LOCK** (`spectralLock`, 0..1, default **0.75**) — Panharmonium-style harmonic snap. Pulls each
detected peak toward the nearest integer multiple of F0, scaled by `lock × confidence`, so it
disengages by itself on unpitched material. Two effects, not one: it moves the partials, **and**
(via `peakSalience`) it changes *which* partials survive culling. **We have this as `morph` — but
defaulted to 0.0 while the VST defaults it to 0.75.** A fresh instance of ours therefore sounds
markedly less tonal than a fresh instance of the VST. This is a **one-line default change** and it
is likely the single largest "doesn't sound like the plugin" contributor. (Changing a default is a
contract change: `docs:accept` + review the diff.)

**RESIDUAL** (`spectralResidual`, 0..2, default 0.5) — the stochastic half of the Serra/Smith SMS
model. The sinusoidal tracker throws away everything that is not a peak: breath, fricatives (/s/,
/sh/, /f/), noise. RESIDUAL re-injects it as 16 bandpassed noise generators driven by the masked-bin
envelopes. The upstream comment is unusually direct (`PluginParams.h`):

> "Default 0.5 — biased on because pure-sines vocal output reads as **'robot vocoder'**, which
> fights the engine's pitch-coherent character."

Scaled by `cbrt(partialFraction)` (`:906`) so it vanishes at 1 partial and is fully present at ≥48.
**We do not have this at all.** It is the #1 timbral gap.

**STABILITY** (`spectralStab`, 1..16 hops, default 3) — a peak must be matched on N consecutive hops
before its oscillator is allowed to sound. Implemented as a *gain ramp*, not a mute:
`stabilityGain = framesAlive / minBirthFrames` (`:968-971`), so it fades in rather than clicking.
Kills the one-frame phantom partials that read as "robot beeping". **We do not have this.**

**FLOOR** (`spectralFloor`, −90..−20 dB, default **−42**) — the peak-detection threshold relative to
the loudest bin. **We have this hardcoded at −60 dB** (`packages/dsp/src/callsine.ts:420`,
`const thr = maxMag * 0.001; // -60 dB`) — which matches the VST's *internal* default
(`thresholdDb_ = -60.0f`, `SpectralResynth.h:205`) but **not its user-facing default of −42 dB**.
Ours is 18 dB more permissive than a fresh VST instance, admitting far more noise-floor junk. Second
one-line contributor to the character gap.

**SLICE** (`spectralSlice`, 2..200 ms, default 10 ms) — **the analysis hop, decoupled from the FFT
size.** This is the signature Panharmonium control and we do not have it: our hop is welded to
`FFT_SIZE/4` (`packages/dsp/src/callsine.ts:64`, `const HOP_SIZE = FFT_SIZE / 4`). Long slices hold
each spectral snapshot audibly, producing rhythmic spectral stepping. `SLICE MODE` additionally locks
the hop to a host musical division (1/4 … 1/16T) with grid-aligned priming
(`setHostSyncedHop`, `:375`), and the upstream default is **1/16**, explicitly so that:

> "fresh instances produce rhythmic stepping immediately, which is the signature Panharmonium feel."

### 2.4 Ours vs the VST's engine, parameter by parameter

| VST | Range / default | Ours | Verdict |
|---|---|---|---|
| Partials | 1..892, def 64 | `harmonics` 0..1 → 1..**64** | **capped 14× low** |
| Partial Cap | {16,64,128,256,512,892}, def 128 | — | missing |
| Slew | 0.02..4 s, def 0.6 | `timbre` 0..1 → 5 ms..2 s | present, different taper |
| **Slice** | 2..200 ms, def 10 | — hop fixed 256 smp (5.33 ms) | **missing** |
| Slice Mode | FREE/1/4..1/16T, def 1/16 | — | missing (needs clock) |
| Center | ±3600 cents | `note` ±60 st **+ `pitch` V/oct** | **ours is better** |
| **Lock** | 0..1, def **0.75** | `morph` 0..1, def **0.0** | present, **wrong default** |
| **Residual** | 0..2, def 0.5 | — | **missing** |
| **Floor** | −90..−20 dB, def −42 | hardcoded −60 | **missing** |
| **Stability** | 1..16, def 3 | — | **missing** |
| Shape | 0..1 continuous sine→saw→square | `model` discrete 0..13 | **divergent** |
| Freeze | bool | gate rising edge toggles | present |
| FFT size | 2048 (order 11) | **1024** (order 10) | half the resolution |

FFT size is not cosmetic: at 48 kHz, N=1024 gives **46.9 Hz** bins, N=2048 gives **23.4 Hz**. A 46.9
Hz bin cannot separate adjacent harmonics of anything below ~100 Hz — the parabolic interpolator
recovers sub-bin *centre* frequency but cannot resolve two partials sharing a bin.

**Ours is richer in exactly one respect:** `model` (14 discrete voices) against the VST's single
continuous `SHAPE`. Ours also has a real **V/oct pitch input** and **CV on every macro**, which the
VST structurally cannot have. Do not discard these to chase parity — see §5 Phase 5.

---

## §3 — WHAT IS FEASIBLE IN A BROWSER

### 3.1 Measured, with the honest error bars

Benchmarks run on this machine (node v22.22.2, arm64 / Apple Silicon — the same V8 that runs
AudioWorklet code in Chrome). Scripts in the session scratchpad; all figures are **% of one CPU core
required to sustain real time at 48 kHz**.

I measured the oscillator bank **four ways** and got **7.5 %, 21.2 %, 30.1 % and 51.7 %** for the
same nominal quantity (512-partial sine bank). That spread is not noise to be averaged away — it is
the finding:

> ⚠ **JS microbenchmarks of this loop are not trustworthy to better than ~2×.** Loop shape,
> accumulator placement and what else lives in the same file move the number by 3–7×. Every figure
> below is therefore a **range**, and the design decisions in §5 are chosen to survive the
> pessimistic end. Anyone re-deriving these must re-measure **in an actual AudioWorklet**, not in
> node, before treating any single number as real.

**What is robust across all implementations (this is what to rely on):**

| Component | Scaling | Cost |
|---|---|---|
| **FFT** (radix-2, N=1024..4096) | flat in N — bigger N is offset by proportionally fewer hops | **0.2 – 0.9 % of one core.** 14–48 µs/transform × 47–188 hops/s. |
| **Oscillator bank** | **linear** in partial count | **0.04 – 0.10 % per partial.** Dominant cost. |
| **MQ peak↔track matcher** | **quadratic** in partial count | 0.13 % @ 64 → ~10 % @ 892 (hop 512). The scaling wall. |
| **8-band SVF filterbank** | linear in bands | 0.22 % @ 8 bands, 1.0 % @ 99 bands. Negligible. |

**The counter-intuitive headline: the FFT is not the problem.** It is under 1 % at every size tested.
Anyone budgeting this feature will instinctively worry about the transform; the transform is free.
**The oscillator bank is 90 % of the cost, and it is linear in exactly the number the owner wants
raised.**

### 3.2 The partial-count budget

Bank cost per partial, worst measured case, at 48 kHz:

| Partials | Bank (range) | + matcher @hop512 | Verdict |
|---|---|---|---|
| 64 (today) | 1.1 – 6.4 % | +0.13 % | trivial |
| 128 | 1.9 – 13 % | +0.20 % | trivial |
| **256** | **3.6 – 26 %** | +0.74 % | **safe default ceiling** |
| 512 | 7.5 – 52 % | +2.8 % | opt-in only |
| 892 (VST max) | 11 – 96 % | +10 % | **not shippable** |

**Recommendation: raise the cap 64 → 256, expose a `PARTIAL CAP` selector {32, 64, 128, 256}, default
128.** That is a 4× increase in the number the owner is complaining about, at a worst case of ~26 %
of one core — for **one instance**. It stays sane with three or four `callsine`s in a rack.

**512 and 892 would be a lie to ship as defaults.** The audio thread is shared by the *entire*
graph — every other worklet in the patch is spending from the same core — and this rack routinely
runs a dozen modules. At the pessimistic end a single 892-partial instance is the whole core.

**Two prerequisites before anyone tries to exceed 256:**

1. **Fix the matcher.** It is `O(P × T)` (`packages/dsp/src/callsine.ts:559` region; upstream
   `SpectralResynth.cpp:663-698`) and confirmed quadratic by two independent implementations:
   14 µs/hop @ 64 → 1075 µs/hop @ 892, a **78× rise for 14× the partials**. Both peak and track lists
   can be kept frequency-sorted and matched with a **two-pointer merge → O(P)**. Until that lands,
   partial count is capped by the matcher, not by the bank.
2. **Non-sine models cost 1.4–2× the sine.** One measurement (bench3): SINES 20.9 ns/partial/sample,
   METAL 29.4 ns (1.4×), FORMANT 40.8 ns (**2.0×**). At 512 partials FORMANT alone measured **96 % of
   one core**. Any partial-count ceiling must be **per-model**, or FORMANT/METAL will blow the budget
   that SINES fits inside. *This interaction does not exist upstream* — the VST has one continuous
   SHAPE, not 14 models — so it is our problem alone and nothing in the VST's design will warn us.

### 3.3 Two optimisations NOT worth doing (both measured, both negative)

Recording these so the next person does not spend a day on them:

- **Porting `fastSin2Pi`.** The VST's 9-term Horner polynomial claims ~4× over libm in C++
  (`SpectralResynth.cpp:18-20`). In V8 it is **1.01×** — `Math.sin` 5.91 ns/call, the polynomial
  5.87 ns/call. V8 already lowers `Math.sin` to a fast path. **Do not port it.**
- **Hoisting the model `switch` out of the per-partial loop.** I predicted ~2.5×; the controlled
  experiment (identical loop bodies, one variable) measured **1.11×** at 256 and 512 partials, and
  **0.96×** at 64. Real but marginal — not worth restructuring the render loop for. *(I record this
  because my own first two benchmarks appeared to support the 2.5× story; only the single-variable
  experiment disproved it. Two benchmarks agreeing is not evidence when both vary the same
  confounder.)*

### 3.4 What would be a lie to claim

- **"Faithful spectral resynthesis / it will sound like the input."** No — and deliberately not.
  Upstream refuses phase-vocoder IFFT/OLA reconstruction on purpose (`SpectralResynth.h:29-33`).
  This engine is a *tracked-peaks* resynth: audibly synthetic. Neither we nor the VST can
  transparently timestretch, and we must not imply it.
- **"892 partials, like the VST."** §3.2. Not at the pessimistic end of the budget, not on a shared
  audio thread.
- **"Host-tempo SLICE MODE."** The VST reads a DAW playhead (`PluginProcessor.cpp:151-181`) for BPM
  *and* absolute sample position, and primes the hop counter so the analysis fires on the bar grid.
  We have `seq-clock` and a transport, but whether an equivalent absolute grid position is available
  to a worklet here is **UNCONFIRMED** — I did not verify it. Treat SLICE MODE as a separate spike.
- **Sample rate.** Every figure above assumes 48 kHz. A 44.1 kHz `AudioContext` shifts bin widths and
  all hop-derived milliseconds by 8.8 %.

---

## §4 — THE FACEPLATE

### 4.1 The budget, stated exactly

From `packages/web/src/lib/ui/workflow/module-shell-model.ts:289-292` and
`curated-face.ts:40-79`:

| Tier | Cells | Source |
|---|---|---|
| mini | **1** | `FACE_TIER_CAPS.mini` |
| compact | **3**, or **2** with a glyph | `LANE_ROW_MAX_CELLS` / `…_WITH_GLYPH` |
| full (in lane) | **6** — a 3×2 plate | `LANE_PLATE_MAX_CELLS = PLATE_COLS × PLATE_MAX_ROWS` |
| dock | ∞ — every ranked control, paged | — |

These are **geometry, not an authored ladder** — the tile is a fixed 192×180 box. Ranks 7+ are
dock-only *by construction*.

`callsine` has **no `face` today**, so it renders through `legacy-fallback.ts` as a `placeholder` in
the lane with its verbatim 88-line card in the dock. That is survivable at 6 params and untenable at
~15. **The face must land in Phase 1**, because Phase 1 itself pushes the count past 6.

### 4.2 The sketch

Ranking rule: the six lane cells go to what you **perform**; everything you **set up** goes to the
dock pages.

```ts
face: {
  order: [
    // ── the six lane cells (perform) ───────────────────────────
    'harmonics',   // PARTIALS — the headline "how much of the sound"
    'slice',       // SLICE    — the signature stepping (Phase 1)
    'morph',       // LOCK     — tonal ⇄ inharmonic
    'timbre',      // SLEW     — crisp ⇄ smeared
    'residual',    // RESIDUAL — sines ⇄ breath (Phase 4)
    'level',
    // ── dock tail (set up) ─────────────────────────────────────
    'note', 'model', 'floor', 'stability', 'partialCap', 'sliceMode',
    // ── panels: dock-only by the PF-14 rule ────────────────────
    'callsine-spectrum-{n}',   // live analyser + tracked-peak overlay
  ],
  pages: [
    { id: 'analysis',  label: 'analysis',
      controls: ['slice', 'sliceMode', 'floor', 'stability', 'callsine-spectrum-{n}'] },
    { id: 'partials',  label: 'partials',
      controls: ['harmonics', 'partialCap', 'morph', 'timbre'] },
    { id: 'voice',     label: 'voice',
      controls: ['model', 'residual'] },
    { id: 'transpose', label: 'pitch · out',
      controls: ['note', 'level'] },
  ],
  glyph: 'spectrum',   // ⚠ see below
}
```

**Notes and traps, in order of how much time they will cost you:**

- **The page-id collision trap.** DX7 documents it at length (`dx7.ts` `face.pages`): `rearFieldPlan`
  gives a curated rear group whose id is `voice` or `signal` the leading band slot, then walks
  `face.pages` claiming a group per page id. **A page id colliding with the leading rear-group id
  renders that band twice and fails the rear-derivation totality gate.** I have used `voice` as a
  page id above — **check `callsine`'s rear curation before keeping it**, and rename the page (not
  the label) if it collides. Cheaper to check than to debug: DX7 lost a cycle to exactly this.
- **`glyph: 'spectrum'` is aspirational and UNCONFIRMED.** I have not verified which glyph kinds the
  shell supports; `dx7` uses `'algorithm'`. If no spectrum glyph exists, either omit the glyph
  (which *raises* the compact budget from 2 cells to 3) or add one. **A glyph is not free — it costs
  a compact cell.** For this module a live spectrum is worth it: it is the only control-independent
  way to see whether the analyser is finding anything.
- **Panels are dock-only** (PF-14), which is correct here: the analyser display is diagnosis, not
  performance.
- **`SHAPE`/`model` is a picture-state candidate.** DX7 uses `paramCells: { algorithm: 'grid' }` to
  get a chip + portaled picker that is *tier-independent*. 14 waveform models is the same problem.
  Worth `paramCells: { model: 'grid' }` in Phase 5.
- **New param ids must be added to `docs.controls` and re-pinned** (`task docs:accept`), and any
  control family needs a `controlFamilies` entry plus the card-testid grep guard.

### 4.3 What we deliberately do not build

The VST's editor is 1094 lines laying out 104 parameters: 8 filterbank columns × 7 knobs, two FX
slots, a feedback panel, a master-filter panel, a wavetable row. **None of that belongs in this
module**, because in a rack it is a *cable*:

| VST subsystem | params | Our equivalent |
|---|---|---|
| 8-band filterbank + sends | 56 | `warrenspectrum`, patched |
| Feedback loop (delay + SVF in loop) | 5 | `charlottes-echos` / `cofefve` |
| FX1 Reverb / FX2 Delay | 12 | existing reverb / delay modules |
| Master filter (morphable SVF) | 4 | `filter` / `resofilter` |
| Wavetable insert | 9 | `wavecel` / `samsloop` (partial — **UNCONFIRMED** how close) |
| Gain / input mix / bank wet | 3 | mixer + the module's own `level` |
| **Spectral engine** | **15** | **← the only part that must live inside `callsine`** |

**104 − 89 = 15.** That is the actual scope of "fully replicating the controls". A VST must bundle
its rack because it cannot be patched; we already have the rack. Rebuilding it inside one card would
be building a DAW inside a patch point, and would produce a module nobody can fit on screen.

**MASSPASS is the one genuine omission that is not covered by a cable.** It is a *third engine* —
16..99 bandpasses, per-band envelope follower + zero-crossing pitch detection, no FFT at all
(`MassPass.h:12-31`) — and it sounds nothing like the FFT path. Measured at 1.0 % of a core for 99
bands, it is cheap. **Recommend a separate `masspass` module, not a mode of `callsine`**: it shares
no state with the spectral path, and a mode switch that silently swaps engines is exactly the
"controls revealed by a mode switch" hazard CLAUDE.md flags for `card-control-overflow`.

---

## §5 — PHASING

**The hard rule for every phase: the new param's default must reproduce today's output bit-for-bit,
except where the phase's stated purpose is to change it** (Phase 2 changes two defaults on purpose,
loudly). This keeps saved racks sounding the same and keeps each ART diff attributable.

**Prerequisite folded into Phase 1, not its own phase.** `callsine` has **no ART scenario and no ART
baseline** (`art/scenarios/` has no `callsine` entry; `art/baselines/` has none). Every phase below
changes the sound, so without a baseline first there is no way to tell an intended change from a
regression. Phase 1 therefore ships the scenario + goldens **in the same PR** as its feature.
It also has **no VRT baseline** (`e2e/vrt/vrt-exemptions.ts:631` — *"VRT baseline pending"*), which
must be drained **before** the face lands (see the drain-first rule in CLAUDE.md).

---

### Phase 1 — SLICE, the signature. *(ships a sound, not scaffolding)*

**Why first:** it is the single most identifiable CallSine/Panharmonium behaviour we lack, it is the
smallest diff of any missing feature, and it is **back-compatible by construction** — default the
slice to 256 samples (5.33 ms) and the output is unchanged.

- Decouple the hop from the FFT size: replace `const HOP_SIZE = FFT_SIZE/4`
  (`packages/dsp/src/callsine.ts:64`) with a param-driven `hopSize`, clamped `[2 ms, FFT_SIZE/2]`
  exactly as `setSliceMs` does (`SpectralResynth.cpp:362-373`).
- New param `slice`, 2..200 ms, **default 5.33 ms** (today's behaviour), log taper.
- Relabel the Plaits macros — `harmonics`→"Partials", `timbre`→"Slew", `morph`→"Lock". **`label:`
  only; ids unchanged** (§1.2).
- Introduce `face` (§4.2) — forced, because this makes 7 params against a 6-cell plate.
- Drain the VRT exemption and capture baselines; add the first ART scenario + goldens.

**Provable:** at slice = 100 ms the output holds each spectrum ~19× longer than at 5.33 ms. A
windowed spectral-centroid trace (§6.2) separates them unmistakably; a long-term average does not.

### Phase 2 — The two wrong defaults. *(one line each, largest character payoff)*

- `morph`/LOCK default **0.0 → 0.75** (`SpectralResynth`'s user-facing default).
- FLOOR: unhardcode `thr = maxMag * 0.001` (`callsine.ts:420`) into a param, −90..−20 dB,
  **default −42 dB** (the VST's user default, not its internal −60).

**This phase deliberately changes the sound of existing saved racks** — it is the "make it sound like
the plugin" phase. That makes it the one phase requiring **owner ears before merge**, and its ART
diff will be large and *expected*. Re-pin baselines **and** the fingerprint manifest together
(`task art:update`).

### Phase 3 — STABILITY.

`stability` 1..16 hops, **default 1** (= today), implemented as the upstream **gain ramp**
`framesAlive / minBirthFrames` (`SpectralResynth.cpp:968-971`), not a mute. Kills phantom-partial
beeping. Cheap: one int compare per track per sample.

### Phase 4 — RESIDUAL, the anti-robot fix.

The largest build in this plan and the largest timbral gain. 16 log-spaced SVF bandpasses
(80 Hz .. min(12 k, 0.45·SR)), peak-bin masking (±3 bins), per-band envelope smoothing (~25 ms),
`cbrt(partialFraction)` scaling. **Default 0.0** (= today) even though upstream defaults 0.5 — the
default move is a separate, owner-visible decision, not a side effect of the build.

Measured cost: 16 SVFs ≈ **0.25 % of one core**. We already have the SVF; `warrenspectrum` runs a
comparable bank.

### Phase 5 — Resolution and depth.

- FFT 1024 → **2048** (bins 46.9 Hz → 23.4 Hz). Hop stays param-driven from Phase 1.
- Partial cap 64 → **256**; add `partialCap` selector {32, 64, 128, 256}, **default 128**.
- **Prerequisite: the O(P²) → O(P) sorted-merge matcher** (§3.2), *and* a **per-model** ceiling
  (FORMANT is 2× SINES; 512 FORMANT partials measured 96 % of a core).
- Reconcile SHAPE: keep our 14 discrete models, add the VST's continuous sine→saw→square morph as
  model 0's sub-axis, or promote `model` to `paramCells: 'grid'` (§4.2). **Do not delete the 14
  models to chase parity** — they are ours and they are a superset.

### Phase 6 — The rest, only if wanted.

`sliceMode` host-tempo lock (spike the clock question first — §3.4, UNCONFIRMED); a separate
`masspass` module (§4.3); the live spectrum panel; adopting the VST's `wsp-fp` fingerprint JSON as a
preset-interchange format (§6.4).

---

## §6 — TESTABILITY

### 6.1 What exists upstream, and it is worth copying

The VST has its own ART harness: `test/art/` with **313 golden metric JSONs**. Its `Metrics` struct
(`test/art/art_metrics.h`) is explicitly *not* a sample diff:

> "The harness gates pass/fail on these — *not* on per-sample audio diff — because the engine drifts
> intentionally with feature work and exact correctness is secondary to 'did we produce sensical
> output'."

Fields: `hasNaN`, `hasInf`, `dcOffset`, `peakDb`, **`rmsDb[8]`**, **`spectralCentroid[8]`**,
`zeroCrossingRate`, `realtimeFactor`. Tolerances: peak ±3 dB, rms ±6 dB/window, centroid ±0.3
octaves, ZCR ±25 %, |DC| < 0.02, render < 1.5× realtime.

**The load-bearing detail is the `[8]`.** Level and centroid are stored **per time window**, so —
their words — "a case that goes silent halfway through fails differently from one that dropouts to
noise at the end."

### 6.2 ⚠ Our ART fingerprint is structurally blind to this engine's main behaviour

`packages/web/src/lib/art/fingerprints.generated.json` stores per baseline: a **48-column
log-spaced spectrum**, three scalar features (`crest`, `zcr`, `centroid`), and `labels`
(`peakDb`, `rmsDb`, `durS`, `samples`). All of it is **long-term average** over the whole render.
The repo already knows this loses information — `fingerprints.consistency.test.ts:41-42` notes two
`analog-vco` baselines legitimately collide because they share a *"same long-term-average spectrum +
same crest/zcr/centroid"*.

For a **spectral resynthesizer that is a subtractive-style oscillator, that is fatal**, because every
feature in this plan is *temporal*:

| Change under test | Long-term average spectrum |
|---|---|
| SLICE 5 ms vs 200 ms | ~identical — same partials, different **hold time** |
| FREEZE engaged at t=0.5 s | ~identical if the frozen spectrum resembles the average |
| STABILITY 1 vs 16 hops | ~identical — removes short-lived partials that barely move the mean |
| SLEW 5 ms vs 2 s | ~identical — smearing is a **time** operation |

A single averaged spectrum is **invariant to precisely the dimension every phase modifies.** It would
return a clean, confident PASS for a SLICE knob wired to nothing. This is the CLAUDE.md
*validate-the-instrument* failure in its purest form, and it is a hole in our harness, not just in
this module's plan.

**Required before Phase 1's golden means anything: a windowed fingerprint variant.** Adopt the VST's
shape — `rmsDb[8]` and `spectralCentroid[8]` over 8 equal windows. This is additive to
`fingerprints.generated.json` (new optional field, existing entries untouched, no re-pin of other
modules) and it is the *only* thing that makes a spectral golden mean anything.

**Negative control, mandatory (CLAUDE.md):** before trusting any new golden, **perturb the thing it
claims to measure** — change SLICE from 5.33 ms to 100 ms and confirm the *windowed* metric moves
while the *averaged* one does not. If both move, or neither, the instrument is wrong regardless of
what the code does.

### 6.3 The rest of the test surface

- **Unit** (`callsine.test.ts`, 383 lines) is already good — peak detection, F0, round-trip render,
  per-model audibility, all against the pure-math mirror in the def. **Every phase extends the
  mirror**; the mirror↔worklet sync is a standing hazard (the def already warns "Any algorithmic
  change in the worklet MUST be mirrored here") and nothing enforces it. **Worth a guard**: the
  mirror and worklet should agree on a fixed input to within tolerance, as a test.
- **Registry sweeps** are automatic — new params/ports enrol in `per-module-per-port`, `behavioral`
  and `vrt.spec`. Run them per CLAUDE.md before pushing.
- **Contract-lock** re-pins once per phase (`task docs:accept`), diff reviewed.
- **The card↔def range trap applies here.** CLAUDE.md's backdraft case: a card can pass literal
  ranges that contradict the def, and *every def-reading gate is blind to it*. `slice`, `floor` and
  `stability` all have non-obvious ranges. **Export the ranges from the def and import them in the
  card** — never retype the numbers.

### 6.4 What can never be covered

- **"Does it sound like the plugin?"** No golden answers this. The two engines will not be
  sample-identical (different FFT size, different peak sets, JS vs C++ float order) and chasing that
  is a trap. Only **owner ears** close Phase 2. The honest automatable claim is *"it is a resynth
  that tracks pitch, holds on freeze, steps on slice, and does not clip / NaN / drift DC"*.
- **A/B against the VST binary.** `callsine_render` (`../callsine/tools/callsine_render.cpp`) is a
  CLI that runs the real `SpectralResynth` over a WAV — so a **manual** comparison is possible and
  worth doing once per phase. Wiring it into CI would need a macOS runner with the JUCE toolchain:
  not worth it, and CLAUDE.md's ">2 min CI wall-time needs sign-off" rule would bite.
- **CPU claims.** §3.1 — a node microbenchmark is not an AudioWorklet. `realtimeFactor` in an ART
  case is a smoke ceiling, not a bench, and on a loaded CI runner it is nearly meaningless. Do not
  gate on it tightly.

---

## §7 — UNCONFIRMED REGISTER

Everything I did **not** verify, collected so nobody inherits it as fact:

1. **`glyph: 'spectrum'` exists.** Not checked against the shell's supported glyph kinds. (§4.2)
2. **The `voice` page-id collision.** I did not read `callsine`'s rear-field curation; DX7's warning
   may or may not apply. Check before using that page id. (§4.2)
3. **Host-tempo SLICE MODE is reachable.** Whether a worklet here can get an absolute, bar-aligned
   grid position equivalent to a DAW playhead. (§3.4)
4. **`wavecel`/`samsloop` cover the VST's wavetable insert.** Asserted from module names and the
   descriptions, not from reading them. (§4.3)
5. **All CPU figures.** Node/V8 on Apple Silicon, ±2× between implementations, never measured in an
   AudioWorklet, never measured under a loaded graph or on CI. (§3.1)
6. **`warrenspectrum` descends from the VST's `FilterBank`.** Strongly implied by the name pair, the
   8-band structure and the per-band send topology; the def carries no `ossAttribution` saying so.
   (§1.1)
7. **Non-sine model cost multipliers (1.4×/2.0×).** One benchmark, one implementation, not
   cross-checked — unlike the FFT and matcher figures, which two implementations agree on. (§3.2)

---

## APPENDIX — orientation for whoever picks this up

| What | Where |
|---|---|
| Our def (+ pure-math mirror + docs) | `packages/web/src/lib/audio/modules/callsine.ts` (639 L) |
| Our worklet | `packages/dsp/src/callsine.ts` (728 L) |
| Our card | `packages/web/src/lib/ui/modules/CallsineCard.svelte` (88 L) |
| Our unit tests | `packages/web/src/lib/audio/modules/callsine.test.ts` (383 L) |
| The sibling half | `packages/web/src/lib/audio/modules/warrenspectrum.ts` |
| VST params (the 104) | `../callsine/src/PluginParams.h` (419 L) |
| VST signal path | `../callsine/src/PluginProcessor.cpp:288-451` |
| VST spectral engine | `../callsine/src/dsp/SpectralResynth.{h,cpp}` (237 + 1010 L) |
| VST filterbank / masspass / wavetable | `../callsine/src/dsp/{FilterBank,MassPass,Wavetabler}.*` |
| VST faceplate | `../callsine/src/PluginEditor.cpp` (1094 L) |
| VST ART harness + 313 goldens | `../callsine/test/art/` |
| VST preset-interchange JSON (`wsp-fp`) | `../callsine/src/Fingerprint.{h,cpp}` |

**Two things to read first, in this order:** `SpectralResynth.h:19-45` (the design intent, including
what it refuses to do), then `PluginParams.h` (every parameter carries a comment explaining *why*
its default is what it is — that is where the character lives, not in the DSP).
