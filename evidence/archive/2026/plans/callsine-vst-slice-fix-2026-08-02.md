# callsine VST — fixing the SLICE ceiling and the host-sync clamp

**Date:** 2026-08-02 · **Status:** PLAN (docs-only in this repo; the code lands in
`../callsine`) · **Target repo:** `/Users/2600hz/Documents/workspace/callsine`
(`chore/v0.6.0-instrumentation` @ `88f4886`) · **Companion:**
`.myrobots/plans/warrens-spectrum-2026-08-02.md` §3.2.1 / §3.2.2

> **STATUS 2026-08-12 — THE CEILING FIX HAS LANDED UPSTREAM (uncommitted).**
> Checked directly against `/Users/2600hz/Documents/workspace/callsine`
> (`chore/v0.6.0-instrumentation`, HEAD still `88f4886`, `src/dsp/SpectralResynth.cpp`
> **modified in the working tree**):
> - **D1 FIXED** — `setSliceMs` now clamps the *milliseconds* to `[2, 200]` and
>   derives the hop from that; the `fftSize_ * 0.5` ceiling is gone, and the new
>   comment carries §3.1's no-OLA argument.
> - **D2 FIXED** — `setHostSyncedHop` is now `std::max(samplesPerSlice, 32)` with
>   **no ceiling**, for §1.2's reason (blocks ≥ hop fire spurious off-grid frames).
> - **D3 NOT FIXED** — the priming is still `hopSize_ - samplesUntilNext`, with no
>   `-1` (§1.3).
> - **D4 NOT FIXED** — `PluginProcessor.cpp:170` is still a bare
>   `juce::roundToInt(sps)` feeding `t % spsInt` (§1.4).
> - **None of §7's tests exist** — no `getHopSize`/`getAnalysisCount` accessors, no
>   sibling-comparison ART gate, no `PlayHead` anywhere under `test/art/`. The
>   §7.1 blind gates now pass *for the right reason* but still assert only tail
>   RMS on a single 24000-sample block.
> The trimmed sections below are the surviving work. On our side nothing is
> blocked either way: `callsine` was deleted from this repo (**#1305**) and
> replaced by `warrensspectrum`, whose owner ruling was **CORRECT, not faithful**.

**Every claim below is `file:line`-cited into `../callsine`. Where a conclusion is an
inference rather than a read, it is labelled `[INFERENCE]`.** That discipline exists because
the previous two passes over this exact area were reliable readers and unreliable reasoners:
every citation resolved, and one of the conclusions drawn from them was still wrong (§1.2).

---

## 1. The diagnosis — what each defect was, and which survive

### 1.2 ⚠ What the brief (and the merged plan) got WRONG — the host-sync grid is NOT destroyed

The brief states the bar alignment "is destroyed as well" because `prime` is computed from the
clamped hop. **That does not follow, and it is false at every common host block size.**

`setHostSyncedHop` is called **once per block**, from inside `processBlock`
(`PluginProcessor.cpp:85`; the param-apply block runs at `:143-189`), and it **overwrites**
`samplesSinceHop_` every block (`SpectralResynth.cpp:387`). The clamped `hopSize_` therefore
never gets to free-run: the per-block re-prime re-establishes musical alignment before the
counter can drift away from it.

Simulated over the three cited sites exactly as written (`PluginProcessor.cpp:172-175`,
`SpectralResynth.cpp:382-387`, `SpectralResynth.cpp:922-930`) — 1/16 @ 120 BPM, 48 kHz, 20 grid
periods, `samplesPerSlice = 6000`, ceiling 2047:

| host block | analyses (want 20) | max distance from the beat |
|---:|---:|---:|
| 64 / 128 / 256 | 25 / 23 / 22 | **1 sample** |
| 512 / 1024 | 21 / 21 | **1 sample** |
| **2048 / 4096** | **60 / 60** | **2946 / 2910 samples (≈ 61 ms)** |

Read that carefully:

- At **block ≤ 1024** — the default in Ableton, Logic and Bitwig — the analyser fires **on the
  musical grid, at the correct period, within one sample**. The clamp is masked.
- At **block ≥ 2048** the clamp bites hard: **3× the requested analysis rate**, alignment gone.
- The "min BPM for the grid to engage" table says when `hopSize_` passes through *unclamped*.
  It does **not** say when the grid works. Conflating those two is the error.

**`[INFERENCE]`** The reason nobody noticed: the existing unit tests call
`r.process(in.data(), out.data(), N)` with `N = 24000` — the whole buffer as **one block**
(`test/unit/test_spectral_resynth.cpp:413`). Block size 24000 is deep in the broken regime and
resembles no host. The tests exercise a configuration that only they produce.

### 1.3 A third defect, found while simulating — a priming off-by-one

The residual "1 sample" and the extra fires at small blocks in the table above are **not** the
clamp. `samplesSinceHop_` is **pre-incremented** before the `>=` test
(`SpectralResynth.cpp:922-923`, and identically at `:839-840` in `processMultiBus`), so at
sample *n* of the block its value is `prime + n + 1`. Firing therefore first happens at
`n = hop - prime - 1`. To fire at offset `until` you need `prime = hop - until - 1`; the code
uses `prime = hop - until` (`:386`).

Consequences: every analysis fires **one sample early**, and when a block boundary coincides
with a grid boundary the frame **fires twice** (once at the end of block *k*, once at sample 0
of block *k+1*). At block 64 that is 25 analyses where 20 were requested — **25 % spurious
extra FFTs**. It is present with the ceiling removed too, so it is independent of it.

### 1.4 A fourth defect — an unguarded modulo

`PluginProcessor.cpp:170-172`:

```cpp
const int    spsInt = juce::roundToInt(sps);
const int64_t t     = *time;
const int phase     = static_cast<int>(t % spsInt);   // spsInt may be 0
```

`spsInt` is not guarded before the `%`. `sps` rounds to 0 for absurd-but-host-supplied BPM
(> 720 000 at 1/32 / 48 k) → integer division by zero. `effDenom` itself *is* safely guarded —
`kEffDenom[0] = 0.0f` would divide by zero but the `sliceMode > 0` test at `:149` excludes it.
**`[INFERENCE]`** no real host sends such a BPM; this is defensive hardening, not a live bug.

### 1.5 Two facts about the defaults that the rest of the plan rests on

- **default SLICE is 10.0 ms** (`PluginParams.h:165`) = 480 samples — under every
  old ceiling, so the FREE default was never clamped and is unaffected by the fix.
- **default SLICE MODE is `1/16`, choice index 3** (`PluginParams.h:231`), **not
  FREE**. A fresh instance in a playing host takes the host-sync path. The comment at
  `PluginParams.h:226-227` ("Existing presets with no saved value land on FREE") is about
  *loading old presets*, not about the default. This is why §8.2's sound change hits the
  out-of-the-box patch.

Also confirmed while reading, and worth not re-discovering: there is **no latency
reporting anywhere in the plugin** (one comment hit at `SpectralResynth.h:194`, no
`setLatencySamples`), so nothing downstream of the hop can break on it.

### 1.6 The strongest evidence, and it is an artifact rather than an argument

`test/art/golden/metrics/sweep__spectralSlice__mid.json` (37 ms — the auto-derived
`convertFrom0to1(0.5)` of a skew-0.4 `2..200` range) and `sweep__spectralSlice__max.json`
(200 ms) are **identical in every audio-describing field**: `dcOffset` 0.000531028199475,
`peakDb` −2.520324945449829, `zeroCrossingRate` 0.009833333082497, all 8 `rmsDb`, all 8
`spectralCentroid`. The only difference in the two files is `realtimeFactor`
(0.176134586334229 vs 0.175805747509003) — a wall-clock number that `art_metrics.cpp:167`
compares against a **ceiling**, never against the golden value.

`sweep__spectralSlice__min.json` (2 ms) genuinely differs (`peakDb` −2.514362335205078,
`rmsDb[0]` −25.256…). That is exactly the signature of a ceiling somewhere between 2 and 37 ms.

**The bug has been sitting in the plugin's own committed baselines and nobody saw it, because
the ART suite compares each golden to itself and never to its siblings.** §7.3 closes that.

Same story for the mode param: all three `sweep__spectralSliceMode__{min,mid,max}.json` share
`peakDb` −2.547379493713379 — audio-identical. The offline ART harness installs no playhead, so
every SliceMode value falls back to FREE. **`spectralSliceMode` has zero ART coverage today.**

---

## 2. The four defects — two fixed upstream, two still live

| # | defect | scope | status |
|---|---|---|---|
| **D1** | FREE-mode SLICE ceiling `fftSize·0.5` | **always**, every host, every block size | **FIXED** — clamp is now on the *ms* value, `[2, 200]` |
| **D2** | host-sync ceiling `fftSize−1` | **only** at host block ≥ 2048 | **FIXED** — no ceiling; `max(samplesPerSlice, 32)` |
| **D3** | priming off-by-one (`:386`) | all block sizes, host-sync only | **LIVE** — 1 sample early; up to 25 % duplicate FFTs |
| **D4** | unguarded `t % spsInt` (`:172`) | pathological BPM only | **LIVE** — latent div-by-zero |

What D1 cost, kept because it is the argument for the ceiling never coming back:
`NormalisableRange(2, 200, 0.1, 0.4)` means `value = 2 + 198·p^2.5` (JUCE
`convertFrom0to1` applies `p^(1/skew)`). Solving for the 21.33 ms ceiling gives
`p = (19.33/198)^0.4 = 0.394` — **the top 60.6 % of the knob did nothing**, 178.7 of
198 ms, 90.2 % of the span, unreachable.

---

## 3. The fix

### 3.1 The conceptual error that was corrected — do not let it back in

The old ceiling comment read:

> *"ceiling at half the FFT window so the hop never exceeds the window we're integrating over."*

That is a **correct constraint on an ANALYSIS hop** — and Hann COLA does want `hop ≤ N/2`. But
it was applied to a control that means something else. **SLICE is a RESYNTHESIS control: how
long one analysed spectrum is HELD by the sine bank.** The header is explicit that there is no
overlap-add reconstruction at all — *"Per-frame inverse FFT or OLA"* is listed under **what
this class deliberately does NOT do** (`SpectralResynth.h:32-37`); the bank renders
continuously and the FFT only updates targets. **With no OLA there is no COLA requirement**, so
the reconstruction argument for `hop ≤ N/2` does not exist here.

What *does* survive is a weaker, real constraint: `circular_` is exactly `fftSize_` long
(`SpectralResynth.cpp:151`) and `analyzeFrame` reads the most recent `N` samples, so with
`hop > N` the input between frames is never analysed. **For a hold control that is the
intended semantic, not a defect** — SLICE = 200 ms means *"snapshot the spectrum and hold it
for 200 ms"*, and a snapshot is by definition not a continuous integral.

### 3.2 The measured grid behaviour — why D3 is still worth fixing

Simulated across every block size (1/16 @ 120 BPM, 48 kHz, 20 grid periods):

| variant | analyses (want 20) | exactly on-grid | max offset |
|---|---:|---:|---:|
| original (clamped) | 21–60 depending on block | 1–5 of 20 | 1 … 2946 |
| **ceiling removed only** ← *upstream is here* | **21 at every block** | 1 of 20 | **1** |
| **ceiling removed + `prime−1`** | **20 at every block** | **20 of 20** | **0** |

One extra analysis per 20 grid periods and a 1-sample offset survive on the current
upstream tree. No new state, no new members, no refactor of `analyzeFrame` closes it.

### 3.3 ⛔ Why the brief's commit-decimation design is NOT phase 1

The brief specifies decoupling: fix the analysis hop at N/4 or N/2 and
`commitEvery = max(1, round(sliceSamples / hopSize))`. **Be adversarial about this — the code
does not need it, and as specified it would introduce a regression.**

1. **It quantises SLICE to multiples of the analysis hop.** With hop = N/4 = 512, `commitEvery`
   for SLICE = 30 ms (1440 samples) is `round(1440/512) = 3` → 32 ms; for SLICE = 12 ms it is
   `round(12·48/512) = 1` → 10.67 ms. **SLICE could no longer reach anything below 10.67 ms,
   destroying the 2–10 ms band that works correctly today.** The currently-working part of the
   range would regress to buy a fix for the broken part.
2. **It requires splitting `analyzeFrame`.** Today that one function does peak detection + F0 +
   harmonic lock (`:413-652`), *then* MQ track matching that writes `tracks_` directly
   (`:663-747`), *then* residual estimation (`:749-800`). Decimating commits means splitting it
   at `:654` into `analyse → peaks_` and `commit → tracks_`. That is a real refactor of the
   hottest function in the plugin.
3. **The intermediate analyses would be pure waste.** If they may not touch `tracks_`, the only
   thing they still do is advance the F0 smoother. Running an FFT every 512 samples to feed a
   hold that updates every 9600 is CPU spent to produce nothing audible.

Decoupling buys exactly one thing: **partial-track continuity across long slices** — MQ
identity survives the gap, so the result is smoother rather than steppier. That is a **taste**
question about the character of long SLICE values, not a correctness one, and it should be
decided by ear after phase 1 ships (phase 4, §10).

### 3.4 ⛔ Why raising `fftOrder` is NOT the fix — the arithmetic

- SLICE 200 ms @48 k = **9600 samples**. The ceiling is `fftSize·0.5`, so reaching it needs
  `fftSize ≥ 19200` → **order 15 (32768)**, which `prepare()`'s own
  `std::clamp(fftOrder, 8, 14)` (`SpectralResynth.cpp:146`) forbids. **The plugin cannot reach
  its own advertised range by this route at all.**
- Even the maximum permitted **order 14** gives `fftSize = 16384`, ceiling `8192` samples =
  **170.7 ms** — still short of the declared 200 ms.
- And order 14 is a **16384-sample = 341 ms analysis window**. SLICE exists to control transient
  tracking (`:364-365`: *"Shorter = more responsive (tracks transients)"*). A 341 ms window
  smears every transient it is supposed to track, and the frequency resolution goes from
  23.4 Hz/bin to 2.9 Hz/bin — the MQ matcher's 5 % relative tolerance
  (`SpectralResynth.h:226`) would start splitting single partials across bins.
- It also scales the per-frame FFT cost 8× and `fftScratch_` to `2·32768` floats
  (`:162`), on the audio thread.

**Raising the order trades the control's entire purpose for a range it still cannot reach.**

---

## 4. Remaining edit list

E1 and E2's ceiling halves are **already applied upstream** (see the status block
at the top); what follows is what is not.

### E2b — `src/dsp/SpectralResynth.cpp` · `setHostSyncedHop` priming (fixes **D3**)

```cpp
// TODAY (still)
    const int prime = std::clamp(hopSize_ - samplesUntilNext, 0, hopSize_ - 1);
    samplesSinceHop_ = prime;
```

```cpp
// WANTED
    // The -1 is load-bearing: process() PRE-increments samplesSinceHop_
    // before the >= test (:922-923), so at sample n it holds prime+n+1 and
    // first fires at n = hop-prime-1. Priming to hop-until therefore fires
    // one sample EARLY and fires TWICE whenever a block boundary lands on
    // a grid boundary (25 % spurious extra FFTs at a 64-sample block).
    const int prime = std::clamp(hopSize_ - samplesUntilNext - 1,
                                 0, hopSize_ - 1);
    samplesSinceHop_ = prime;
```

### E3 — `src/PluginProcessor.cpp:170` · guard the modulo (fixes **D4**)

```cpp
// BEFORE
const int    spsInt         = juce::roundToInt(sps);
// AFTER — spsInt feeds `t % spsInt` two lines down
const int    spsInt         = juce::jmax(1, juce::roundToInt(sps));
```

### E4 — `src/dsp/SpectralResynth.h:57` · the comment is now wrong

```cpp
// BEFORE
void setSliceMs(float ms);              // analysis hop time (Panharmonium "Slice")
// AFTER
void setSliceMs(float ms);              // spectrum HOLD time (Panharmonium "Slice")
```

Also update `SpectralResynth.h:164` (`int hopSize_ = 512; // 4x overlap with Hann window`) —
after E1/E2 it is the **hold period**, and "4× overlap" only describes its `prepare()` seed.

### E5 — `src/PluginProcessor.cpp:140-141` vs `:143-189` · ordering **`[INFERENCE]`**

`setSlewSeconds` (`:140-141`) runs **before** the SLICE block (`:143-189`), and
`setSlewSeconds` derives `freqCoefPerHop_` from the *current* `hopSize_`
(`SpectralResynth.cpp:358`). So the coefficient always reflects the **previous block's** hop —
a one-block lag, harmless in steady state, wrong for one block after any SLICE change. Moving
the `setSlewSeconds` call to after `:189` fixes it. **Optional; do it in phase 2, not phase 1**,
because it perturbs output on the block after every automation move and would muddy the
phase-1 golden diff.

### Call sites — the complete set (grepped, not assumed)

`setSliceMs`: `PluginProcessor.cpp:186`, `tools/callsine_render.cpp:98`,
`test/unit/test_spectral_resynth.cpp:416`. (`MassPass::setSliceMs` at
`PluginProcessor.cpp:187` is a **different class** — see §5.3.)
`setHostSyncedHop`: `PluginProcessor.cpp:175`, `test/unit/test_spectral_resynth.cpp:417,444`.
**No caller passes a value that the new bounds reject.**

---

## 5. Blast radius — every consumer of `hopSize_`

Grepped across `src/`, `tools/`, `test/`. There are **six** reads. `hopSize_` is private with
no accessor, so this list is closed.

| # | site | what it does | effect of the fix |
|---|---|---|---|
| 1 | `SpectralResynth.cpp:148` | `hopSize_ = fftSize_/4` seed in `prepare()` | none — overwritten by the first `setSliceMs`/`setHostSyncedHop`, which `processBlock` calls every block |
| 2 | `SpectralResynth.cpp:169-170` | `hopsPerSecond` → `f0SmoothCoef_` | ⚠ see §5.1 |
| 3 | `SpectralResynth.cpp:358` | `hops` → `freqCoefPerHop_` in `setSlewSeconds` | ⚠ see §5.2 — **becomes correct where it was wrong** |
| 4 | `SpectralResynth.cpp:840` | fire test in `processMultiBus` | structurally unchanged |
| 5 | `SpectralResynth.cpp:923` | fire test in `process` | structurally unchanged |
| 6 | `SpectralResynth.h:164` | declaration | comment only (E4) |

**No consumer breaks.** Nothing divides by `hopSize_` without a `std::max(1, …)` guard
(`:170`, `:358`), and `hopSize_ ≥ 32` is enforced by both setters. There is **no** latency
computation, **no** buffer sized from the hop, and **no** allocation keyed to it — `circular_`,
`fftScratch_`, `mag_`, `phaseBin_` are all sized from `fftSize_` in `prepare()` (`:151-164`),
which the fix does not touch. **`hopSize_` growing past `fftSize_` allocates nothing and
indexes nothing** (`circularWrite_` wraps `% fftSize_` at `:838`/`:921`).

### 5.1 `f0SmoothCoef_` — already stale, and the fix widens the gap

`prepare()` computes it **once**, from the seed hop of 512, and the comment admits the drift:
*"derive from sampleRate_/hopSize_ even if hopSize gets updated later via Slice; per-hop drift
is small"* (`:166-172`). The nominal 30 ms F0 time constant is `tauHops = max(1, 0.030 ×
93.75) = 2.81` frames. Today at a 21 ms slice that is ≈59 ms; **after the fix, at a 200 ms
slice it is ≈562 ms.** The detector will feel sluggish at long SLICE.

**Not a phase-1 change** — recomputing it in the setters alters output at *every* SLICE value
including the defaults, which would forfeit the §8 bit-identity argument. Phase 3.

### 5.2 `freqCoefPerHop_` — the fix corrects a *second* latent bug

`setSlewSeconds:358` computes `hops = slewSamples / hopSize_`, i.e. "how many analysis frames
fit in one SLEW time constant". In host-sync mode today `hopSize_` is **2047** while frames
actually fire every **6000** samples (§1.2) — so the coefficient is computed against a period
the engine does not use. At the defaults (SLEW 0.6 s = 28800 samples):

- today: `hops = 28800/2047 = 14.07` → `freqCoefPerHop_ = 1 − e^(−1/14.07) = 0.0686`
- fixed: `hops = 28800/6000 = 4.80` → `freqCoefPerHop_ = 1 − e^(−1/4.80) = 0.1885`

**2.75× faster per-frame frequency glide — and the new value is the correct one**, because
frames genuinely are 6000 samples apart. `hopSize_` was lying about the analysis rate and this
consumer swallowed the lie. This is the one place the fix *changes the sound of the default
patch* (§8.2).

### 5.3 MassPass was never affected — and it was the proof the ceilings were a bug

`MassPass::setSliceMs` clamps to **`[1, 200] ms`** (`MassPass.cpp:206-214`) and
`MassPass::setHostSyncedSlice` to **`[32, 1<<20]`** (`:216-223`). It always honoured the whole
declared range and every musical division, while `SpectralResynth` did not — and both engines
are driven from the *same knob* (`PluginProcessor.cpp:186-187`, `:175-176`), A/B-able via the
MODE switch (`PluginParams.h:125`). **The plugin contained a correct implementation of this
control alongside the broken one**, which was the strongest single argument that the
`SpectralResynth` ceilings were a defect and not a design choice. The two now agree.

---

## 6. What changes meaning — the honest list

Anything whose time constant was implicitly "per hop" now means something different at long
SLICE, because "one hop" grows from ≤ 21 ms to up to 200 ms.

### 6.1 ⚠ The stability gate — the biggest behavioural consequence, and a real risk

`minBirthFrames_` (`SpectralResynth.h:84`, param `1..16` default **3**,
`PluginParams.h:207-209`) gates a track's output until it has been matched on N consecutive
**frames**, ramping `stabilityGain = framesAlive / minBirthFrames_`
(`SpectralResynth.cpp:968-971`).

- Today at hop 512 that is ≈32 ms — and the parameter's own doc comment says exactly that
  (`PluginParams.h:205-206`: *"Default 3 hops (≈30 ms at hop=512 / 48 kHz)"*). **That comment
  becomes wrong** and must be updated.
- After the fix at SLICE 200 ms it is a **600 ms fade-in**; at `stability = 16`, **3.2 s**.
- ⚠ **The dangerous interaction:** MQ matching uses a 5 % relative tolerance
  (`SpectralResynth.h:226`). Across a 200 ms gap, partials on anything non-stationary will move
  more than 5 % and **fail to match**, so tracks die and are reborn every slice
  (`:734-746` kills unmatched, `:721` sets `framesAlive = 1` on birth). If tracks never survive
  two consecutive slices, `stabilityGain` is pinned at `1/3` **forever** — the bank sits
  **≈9.5 dB quiet** and never opens up. **This is the number-one thing to listen for and the
  one the tests must cover** (§7.2 test 4).

### 6.2 The rest

- **Partial-track continuity.** Mass birth/death per slice at long SLICE. Arguably *is* the
  Panharmonium stepping character — but see 6.1 for where it stops being cosmetic.
- **`freqCoefPerHop_`** — §5.2. Changes at the host-synced default; the new value is correct.
- **`f0SmoothCoef_`** — §5.1. Already stale; gap widens; deliberately unaddressed in phase 1.
- **SMS residual.** `residualBandTarget_` is set once per analysis (`:770-780`) but
  `residualBandEnv_` is smoothed **per sample** at a 25 ms tau derived from `sampleRate_` only
  (`:199-203`, `:996-999`). So the residual's *smoothing* is hop-independent; only its *target*
  becomes stepped at long SLICE. Expected, low risk.
- **CPU goes DOWN.** Long slices mean fewer FFTs. The `realtimeFactor` metric already in the
  ART goldens will drop for the SLICE mid/max cases. `[INFERENCE]` — it is a wall-clock number,
  do not treat a change in it as a finding.
- **`processMultiBus` has no stability gate.** `:849-884` renders without the `stabilityGain`
  factor that `process` applies at `:968-977`. Pre-existing asymmetry, unchanged by this fix,
  but it means 6.1's risk applies to the mono path only. Worth a follow-up issue.

---

## 7. How it is tested

### 7.0 What that repo actually has — I looked

**There is a real harness.** The brief's "if there is none, propose one" branch does not apply.

| target | what it is | where |
|---|---|---|
| `callsine_unit_tests` | Catch2 console app; 5 files incl. `test_spectral_resynth.cpp` (595 lines) | `CMakeLists.txt` "Catch2 unit tests" block |
| `callsine_art_tests` | Catch2 + golden metrics JSON, full processor in-process | `CMakeLists.txt` "ART suite" block |
| `art_regen` | re-baseline target, `CALLSINE_ART_REGEN=1` | `CMakeLists.txt`, `art_test_helpers.h:20` |
| `callsine_render` | offline CLI driving **`SpectralResynth` alone**, has `--slice` | `tools/callsine_render.cpp:94-100` |
| `callsine_editor_smoke` | GUI open/close cycles, macOS only | `CMakeLists.txt`, ctest `editor_smoke_*` |
| ART sweeps | **auto-derived min/mid/max for every APVTS param** | `test/art/test_art_sweeps.cpp:44-80` |
| CI | macos-14, `flox activate -- task test` | `.github/workflows/ci.yml` |

Entry points: `flox activate -- task test-unit` (unit only, `ctest -L unit`),
`flox activate -- task test` (unit + smoke + ART).

### 7.1 ⚠ Two existing tests were blind gates — the fix made them TRUE, not SIGHTED

Both still stand exactly as described; the ceiling removal changed the *facts* they
assert without changing what they can *see*. This is the most transferable finding in
the file, so it is kept in full.

**`test_spectral_resynth.cpp:397-431`** — *"host-synced hop matches equivalent ms-based slice"*.
Its stated rationale used to be **factually false**:

> *"setHostSyncedHop(6000, 0) at 48 kHz should be functionally equivalent to setSliceMs(125) —
> both pin `hopSize_` to 6000 samples"*

Before the fix, neither did: `setSliceMs(125)` → **1024**; `setHostSyncedHop(6000,0)` → **2047**.
Not 6000, and not equal to each other. The test passed anyway because it compares **tail RMS of
a steady 220 Hz sine within 5 %** (`:419-430`) — a metric **invariant to hop size** for a
stationary input. Textbook blind gate: *a metric blind to the very dimension under test returns
a clean number.* Both now genuinely become 6000, so it passes **for the right reason** — but
the assertion is still the blind one. **Still owed: an assertion that can actually see the hop.**

**`test_spectral_resynth.cpp:433-463`** — sweeps `sps ∈ {480, 2400, 6000, 12000, 24000}`. Four
of the five used to clamp to 2047, so it tested one value four times while asserting only
`rms > 1e-3` and no NaN, under a comment claiming coverage of "~30 BPM @ 1/4 … ~300 BPM @
1/32T". All five are distinct now — again, right for the right reason.

**Both still call `process()` with the entire 24000-sample buffer as one block**
(`:413`, `:448`), i.e. block size 24000 — a regime no host uses.

### 7.2 New unit tests

To assert on the analysis schedule the class needs two const accessors. One line each, no
behaviour, no audio-thread cost:

```cpp
int getHopSize()       const { return hopSize_; }        // SpectralResynth.h
int getAnalysisCount() const { return analysisCount_; }  // ++ in the fire branch (:845, :928)
```

**Test 1 — SLICE reachability (the mandatory NEGATIVE CONTROL, output-level).**
The accessor alone is not enough: it tests the setter, not the sound, and the whole bug is that
the sound does not move. So assert on **output**.

- Input: 220 Hz for 0.5 s, then a **step** to 880 Hz, fed in **512-sample blocks**.
- Measure `lagMs` = time from the input step until the output's dominant frequency crosses to
  880 Hz.
- Assert `lag(SLICE=200 ms) > lag(SLICE=2 ms) + 50 ms`, and `lag` **strictly increases** across
  `{2, 10, 40, 100, 200} ms`.
- ⚠ **This assertion had to FAIL on the pre-fix code** — record that in the test comment.
  Pre-fix, `lag(37 ms) == lag(200 ms)` exactly, which was the bug. A test that passes before
  *and* after is not measuring the fix. **Writing it now means writing it against the fixed
  code, so verify it fails with the ceiling temporarily restored** (the same discipline as
  test 3), or it is untested as an instrument.

**Test 2 — host-sync grid across BLOCK SIZES.** The gap nothing covers today.
For `block ∈ {64, 128, 256, 512, 1024, 2048, 4096}`: feed 20 grid periods of 1/16 @ 120 BPM,
recomputing `until` per block exactly as `PluginProcessor.cpp:172-174` does, and assert
**exactly 20 analyses, each within 0 samples of `k × 6000`**. Simulation says the fixed code
gives 20/20/0 at every block size, so this can be an equality, not a tolerance. Print
`block`, `fires`, `wanted`, `maxOffset` in the failure message.

**Test 3 — negative control on the instrument itself.** Run test 2 with the *old* ceiling
restored via a local constant and assert it goes **red at block 2048** (60 fires). This is the
`blind-gates` two-direction discipline: prove the gate can fail, permanently, on every run —
not once at authoring time.

**Test 4 — the §6.1 stability-gate interaction.** With `stability = 3` (default) and
`SLICE = 200 ms`, feed a **vibrato-modulated** tone (±8 %, exceeding the 5 % match tolerance)
and assert output RMS stays within 3 dB of the same input at `SLICE = 10 ms`. This is the test
for the "bank pinned at 1/3 gain" failure mode, and it is the one most likely to go red.

**Test 5 — `spsInt` guard.** `setHostSyncedHop(0, 0)` and `(-5, 0)` must not crash and must
leave `getHopSize() >= 32`.

Flake-check: **3× locally** per repo standard, e.g.
`for i in 1 2 3; do flox activate -- task test-unit || break; done`.

### 7.3 ART — and closing the hole that hid this for months

**The prediction, which is the acceptance criterion when the upstream change is committed.**
Re-running the ART suite must move **exactly two** goldens:

- `sweep__spectralSlice__mid.json` (37 ms) and `sweep__spectralSlice__max.json` (200 ms) must
  change **and must become different from each other**.
- **Every other golden must be byte-identical apart from `realtimeFactor`** (§8) — the FREE
  default at 10 ms was never clamped, and the harness installs no playhead, so every non-SLICE
  sweep takes the unchanged path. The fix is *self-verifying* against 100+ committed baselines.

If `min` moves, or if a non-SLICE golden moves, **stop — the change is broader than intended.**
Regenerate with `cmake --build build --target art_regen` and review the diff entry by entry.

**Add a sibling-comparison gate** — this is the general fix, and without it this class of bug
returns. For every **continuous** swept param, assert `min`, `mid`, `max` metrics are **not
pairwise identical** (compare the audio fields only; `realtimeFactor` is wall-clock and
`art_metrics.cpp:167` already treats it as a ceiling). Today that gate goes red on
`spectralSlice` immediately — which is the point. **`[INFERENCE]`** other params may also trip
it; each hit is either a second dead control or a legitimately no-op mid-value, and both are
worth knowing before this ships.

**Add playhead coverage.** No `getPlayHead`/`setPlayHead` appears anywhere under `test/art/`,
which is why all three `spectralSliceMode` goldens are audio-identical (§1.6). Add one ART case
with a stub `juce::AudioPlayHead` reporting 120 BPM + `isPlaying` so the host-sync path is
exercised at all. **Without this, D2 has no ART coverage in either direction.**

### 7.4 CI wall-time

`[INFERENCE]` — the new unit tests are pure DSP over ≤ 1 s buffers; test 2's seven block sizes ×
20 grid periods ≈ 2.5 s of audio total. Well under a minute added to a macos-14 job that already
builds JUCE. The one ART playhead case adds one render. **No sign-off threshold reached.**

---

## 8. Default preservation

FREE mode at the default is **bit-identical**: SLICE 10.0 ms = 480 samples, under the old
1024 ceiling, so the clamp never engaged there. Same for the whole 2–21 ms band — the fix is
strictly additive over the range that already worked. The host-synced default is not, and
that is the one thing to be deliberate about:

### 8.2 ⚠ Host-synced default — NOT bit-identical. Exactly why, and by how much.

Default SLICE MODE is **1/16** (`PluginParams.h:231`), so a fresh instance in a playing host
takes the host-sync path. There:

- **The analysis firing times do not change** at block ≤ 1024 — the simulation rows for
  "clamped" and "ceiling removed" are identical (21 fires, ≤ 1 sample off) up to block 1024.
- **But `hopSize_` changes 2047 → 6000**, and `setSlewSeconds` reads it
  (`SpectralResynth.cpp:358`). At the defaults `freqCoefPerHop_` goes **0.0686 → 0.1885, a
  2.75× faster per-frame frequency glide** (§5.2).
- E2's `−1` additionally removes the 1-sample-early fire and the duplicate frames — at block
  512, one duplicate analysis per 20 grid periods disappears.
- At block ≥ 2048 the change is large and intended: **60 → 20 analyses**, alignment restored.

**So: the host-synced default sounds different, by a 2.75× change in one smoothing coefficient
plus the removal of ~5 % duplicate frames.** It cannot be otherwise — `freqCoefPerHop_` was
computed from a hop the engine was not using, and preserving that would mean preserving the bug.
Bit-identity here is available only by pinning `freqCoefPerHop_` to the old 2047-derived value,
which this plan **recommends against**.

---

## 9. Presets and saved state — no migration needed, but the sound changes

**No migration is required.** The fix changes **no `ParameterID`, no `NormalisableRange`, no
default, and no parameter count**, and JUCE's APVTS stores the *denormalised* value in the tree
(`ParameterAdapter::setDenormalisedValue` /`flushToTree`), so a preset with SLICE at 150 ms
stores `value="150"` and round-trips identically. Nothing to re-map.

### 9.1 ⚠ The real risk: presets don't move, but they will SOUND different

Any preset saved with SLICE **above ~21.33 ms** has been *sounding like 21.33 ms*. After the fix
it sounds like the number it stores. **For those presets this is not a regression — it is the
first time the saved value has ever been honoured.** But it is a change the user did not ask
for on that day, and it should ship as such:

- Bump the **minor** version and say it in the release notes, naming the two axes.
- The same applies to the host-synced default at large buffers (§8.2).

**A version-gated legacy mode is possible but asymmetric and is NOT recommended.**
`PresetManager` writes `version="1"` (`PresetManager.h:42`) so `.preset` **files** could be
gated — but `getStateInformation` writes the **bare** APVTS XML with no version wrapper
(`PluginProcessor.cpp:513-518`), so **DAW session state carries no version tag and could not be
gated at all.** A compat flag that works for preset files and silently does nothing for
sessions is worse than no flag: it would make the behaviour depend on how the patch was saved.
Ship the fix, document it. `[INFERENCE]` on user impact — the owner's own preset library is the
evidence to check before release; grep it for `spectralSlice` values > 21.33.

---

## 10. Phasing — smallest shippable first

**Phase 1 — the fix (ship alone).** The two ceilings are **already applied in the upstream
working tree**; still owed in the same commit: **E2b** (the `prime−1`, D3), **E3** (the
`spsInt` guard, D4), **E4** (the two now-wrong header comments), the assertions the §7.1 blind
gates still lack, unit tests 1/2/3/5 (§7.2), a re-run of ART confirming **exactly two goldens
moved** (§7.3), and `PluginParams.h:205-206`'s now-wrong "≈30 ms at hop=512" comment.
*Self-verifying against 100+ existing baselines, and complete on its own.*

**Phase 2 — the gate that stops this recurring.** ART sibling-comparison for continuous params
+ the ART playhead case (§7.3). Triage whatever else the sibling gate turns red. Optionally E5
(the `setSlewSeconds` ordering). *Ships the instrument, not just the fix.*

**Phase 3 — the per-frame time constants.** Recompute `f0SmoothCoef_` in the setters (§5.1);
decide whether `minBirthFrames_` should be re-expressed in **milliseconds** rather than frames
(§6.1). Both change output at every SLICE value, so they must not ride along with phase 1 —
they would destroy phase 1's bit-identity argument.

**Phase 4 — decoupling, only if the ear asks for it.** Split `analyzeFrame` at `:654` into
analyse/commit and let the analysis hop stay at N/2 while commits follow SLICE (§3.3). This is
a **taste** decision about long-SLICE character. Do not build it before phase 1 has been
listened to. If built, the fast end must keep `hop = sliceSamples` for `slice ≤ N/2` so the
2–21 ms range stays bit-identical, and the commit boundary must stay an **exact sample count**
rather than a rounded frame multiple, or SLICE becomes quantised (§3.3 item 1).

**Phase 5 — `processMultiBus` stability-gate asymmetry** (§6.2). Separate issue, separate PR.

---

## 11. Open questions for the owner

1. **§8.2** — the host-synced default changes (2.75× on the frequency-glide coefficient).
   Correct as argued, but it is the out-of-the-box sound. Ship it, or pin `freqCoefPerHop_` to
   preserve it?
2. **§6.1** — at long SLICE the stability gate becomes a 600 ms (up to 3.2 s) fade and can pin
   the bank at 1/3 gain on non-stationary input. Re-express `stability` in **ms** (phase 3), or
   leave it as "N slices" and document?
3. **§9.1** — do you have presets with SLICE above 21.33 ms? They will change. Worth a scan of
   your library before release.
4. **§10 phase 4** — is the *steppier* long-SLICE character (tracks die and rebirth each slice)
   what you want from a Panharmonium-style SLICE, or do you want the smoother decoupled version?
   This is the only genuinely aesthetic question here.
5. ~~sanity ceilings~~ — **settled by the upstream edit**: FREE clamps the *ms* to the declared
   `[2, 200]`, host-sync takes `max(sps, 32)` with no ceiling at all. Both are better answers
   than the arbitrary 1 s / 4 s this plan proposed.
