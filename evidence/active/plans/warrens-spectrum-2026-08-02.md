# Warren's Spectrum — kill two modules, ship one

**Date:** 2026-08-02

> **STATUS (ground-truthed 2026-08-12 against
> `packages/web/src/lib/audio/modules/warrensspectrum.ts`) — PHASES 1, 2 and 4
> shipped. PHASE 3 is NOT shipped.** (An earlier header on this file said
> "phases 1–3 shipped"; that mislabels #1334, which was phase 4.)
> - **#1305 — phase 1**: deleted BOTH `callsine` and the old `warrenspectrum`
>   and shipped the SPECTRAL engine, MONO, as `warrensspectrum` (double-s).
> - **#1308 — phase 2**: the 8-band FILTERBANK, and with it stereo.
> - **#1334 — phase 4**: MASSPASS, the second engine
>   (`warrensspectrum-masspass.ts`).
> - The module's own header states what is left, verbatim: *"STILL ABSENT: the
>   WAVETABLE engine, the feedback loop, the two FX slots (and so the bands'
>   `fx1Send`/`fx2Send`, which would be controls with nowhere to send), the
>   master filter, host-tempo SLICE, and `.wspr` fingerprint interchange."*
> - The whole §1 migration also shipped: `RETIRED_TYPE_ALIASES`
>   (`graph/persistence.ts:73`, `callsine` only, with its removal condition),
>   the two-legged fixture test (`graph/retired-type-migration.test.ts`) and the
>   load-diagnostic UI (`summarizeLoadDiagnostics`, surfaced in `Canvas.svelte`
>   as `data-testid="load-diagnostics"`).

**Owner directive, verbatim:**

> "for callsine yes we need to do the rewrite as the vst. but also look at our warren's
> spectrum module. i want to get rid of our existing warren's spectrum and callsine modules,
> and have a single module called Warren's Spectrum that is a 1:1 copy of the callsine vst"

> "i think we want to completely kill the existing warren's spectrum module, i believe this
> will be a total rewrite"

---

## STILL OPEN

- **Phase 3** — the feedback loop, the two FX slots (Reverb + Delay, types
  hard-wired per §3.1), the master SVF, and the `ws-wavetable` insert.
- **Phase 5** — `.wspr` / fingerprint JSON interchange (§3.5), so patches move
  between plugin and module. Constrains **param** ids only.
- **Host-tempo SLICE — CONDITIONAL, not scheduled.** §3.2.1 shows the VST's grid
  sync is broken at block ≥ 2048. It must be ported **fixed, not as shipped**
  (raise the ceiling to `fftSize-1` on both the free and synced paths,
  reconciling the 2× disagreement between them). Depends on
  `.myrobots/plans/callsine-vst-slice-fix-2026-08-02.md`. **Do not port the bug
  and call it fidelity.**
- **§4.3 item 3 — floor SLICE at ~5 ms.** *"Still stands on its own merits"* —
  it is a quantum-budget argument about the *fast* end, untouched by the Q8
  decision. ⚠ **Verified NOT applied**: `WS_SLICE_MIN_MS = 2`
  (`packages/dsp/src/lib/warrensspectrum-dsp.ts:147`). At 2 ms the hop is ≈96
  samples at 48 kHz — **a hop in every quantum**. Either floor it, or make the
  short end reduce the partial cap automatically.
- **The glyph.** `glyph: 'scope'` was a phase-1 placeholder; the module ships
  with no `face` block at all today. The obviously-right glyph is a **live
  spectrum with the tracked partials marked**, which is not a supported kind —
  and `graph/types.ts` is explicit that `'algorithm'` is *"NOT YET A GENERAL
  PRECEDENT"* and that a second topology-bearing module should **widen the
  binding**, not add a third literal. Do it as that widening, in its own PR.
- ⚠ **Never reuse the type string `warrenspectrum`. Load-bearing, not
  cosmetic.** A type string is resolved by **exact match against the registry**,
  so registering anything under the old id would make every old resonator-bank
  node resolve **silently, with no alias entry and no diagnostic at all** —
  reinstating by accident the exact behaviour the drop was chosen to avoid, and
  doing it *below* the layer that would have reported it. The distinct
  double-s id is what makes the drop observable, and the DROP leg of
  `retired-type-migration.test.ts` is what keeps it enforced.

---

## 0. Corrections to the brief

### 0.1 The VST has **104** runtime parameters, not 49

`49` is the number of `layout.add(...)` **call sites** in `PluginParams.h`. Seven of them are
inside `for (int i = 0; i < 8; ++i)` (the filterbank, `PluginParams.h:241-299`) and six inside
`for (int s = 1; s <= 2; ++s)` (the FX slots, `:334-365`). Expanded:

| group | call sites | runtime params |
|---|---:|---:|
| Master output (`gain`) | 1 | 1 |
| Filterbank dry/wet routing (`inputMix`, `resynthLevel`) | 2 | 2 |
| Spectral engine | 15 | 15 |
| **8-band resonant filterbank** (×8) | 7 | **56** |
| Feedback loop | 5 | 5 |
| **Two FX slots** (×2) | 6 | **12** |
| Wavetable insert | 9 | 9 |
| Global master filter | 4 | 4 |
| **TOTAL** | **49** | **104** |

The brief's parameter list omits the filterbank and the FX slots **entirely** — i.e. it omits
68 of the 104 params, including the subsystem (`FilterBank`) **that every drop of audio passes
through.** Any face/phasing plan built on "49 params" is sized for a different plugin.

*(Verified by brace-depth expansion of `PluginParams.h`. My first two attempts at this script
both returned 49 because the loop-scope flag reset one line early — the `for` line carries no
brace. Stated because a wrong count here reads exactly like a right one.)*

### 0.2 Our `callsine` shared the CORE ALGORITHM with the VST — and how that was missed

The brief said our `callsine` was "a Plaits-style MACRO-OSCILLATOR, sharing NOTHING with the
VST." Its *control surface* was Plaits-style; its *engine* was a direct port of the VST's
`SpectralResynth` — Hann window, radix-2 FFT, parabolic log-mag peak interpolation, harmonic-sum
F0 over 60–800 Hz with 8 harmonics, MQ-lite tracking. `packages/dsp/src/callsine.ts:5` said so
outright: *"Algorithmic port of Warren's Spectrum (a.k.a. CallSine), MIT-licensed."*

**Not "two implementations of a known algorithm" — the same ARBITRARY choices carried across
digit for digit:**

| | VST | ours |
|---|---|---|
| MQ match tolerance | `kMatchTolerance = 0.05f` | `bestDist = 0.05` |
| Nyquist alias ramp | `nyquist*0.85` / `nyquist*0.75` | the same two literals |
| F0 band / harmonics / weighting | 60-800 Hz, k=1..8, `1/√k` | identical |
| Peak interpolation | parabolic in **log** magnitude | identical |
| Amplitude scale | Hann coherent gain `4/N` | identical |

⚠ **Why this was missed twice.** The original assessment compared **parameter names** and
concluded "zero overlap". A name diff is **invariant to the algorithm underneath**, so it
returns a confident, plausible, false answer for a faithful port that renamed its knobs — the
exact failure class CLAUDE.md's *VALIDATE THE INSTRUMENT* section describes. The 30-second
negative control was: open the worklet and look for an FFT.

### 0.3 The VST is already called Warren's Spectrum

`callsine` is only the CMake project id. `PRODUCT_NAME` is `"Warren's Spectrum 0.6 FP"`,
presets are `.wspr`, the fingerprint type marker is `"wsp-fp"`. The owner's naming instruction
was a *restoration*, not a rename.

---

## 1. The migration — what is worth keeping now that it has shipped

The full argument now lives on `RETIRED_TYPE_ALIASES` in `graph/persistence.ts`. What is
*only* here:

**The alias hook existed before, and this repo deliberately deleted it.** `LEGACY_TYPE_ALIASES`
+ `canonicalizeVideoType()` lived in the video registry for `ruttetra → reshaper` and
`circles → outlines`, and was removed on 2026-07-05 (`8cfb7897`, in #1027). Its comment,
recovered from git, is the reason any alias exists at all:

> "When a module type is renamed we register it under the NEW id only … but nodes saved before
> the rename — in a user's localStorage, a live collab Y.Doc, or a hand-exported .json — still
> carry the OLD type string. **Without a remap the patch loader can't resolve the def and drops
> the node to a placeholder error card, LOSING that node's wiring + params.**"

So an alias is **designed with a finite life**: it converts live patches, and once they have
been re-saved it is retired and the drop path resumes. That is the shape of the removal
condition now on the table.

⚠ **Both repo rename precedents aliased a type onto an IDENTICAL contract** (`ruttetra-v1 IS
today's reshaper`; `export const circlesDef = outlinesDef`). Neither ever re-pointed one
instrument at another. That is the test any future alias must pass.

**Edge survival is decided port id by port id**, and this is the measurement that split the
decision:

| predecessor | ports | survive on the new contract | why |
|---|---:|---:|---|
| **`warrenspectrum`** | 43 | **0** | mono contract, no filterbank at phase 1, no ping model, every CV port names a param with no counterpart, `viz_out` is mono-video and there is no video domain |
| **`callsine`** | 10 | **4** | `audio_in` / `pitch` / `gate` / `out` — and all four map to the **same function** on both sides, not merely the same string |

**Still-unbuilt substrate, recorded because it is a known gap:** `persistence.ts`'s
unknown-type path carries `// Phase 1: skip. Future: insert placeholder error node.` — **the
placeholder was never built.** A dropped node leaves no visual trace in the graph itself; only
the load-diagnostic notice reports it.

**And the demand that must survive any future migration:** a **distinct diagnostic per migrated
node**, never a generic "controls reset". `callsine` declared `chainWiring: { role: 'source' }`
— it was a *voice* — while the new module is an *effect* that resynthesises whatever is patched
into `audio_in`. **A migrated node with nothing patched into `audio_in` is silent**, and the
diagnostic must say so, *"because 'it's there and it makes no sound' is the one failure this
migration can still ship."*

⚠ **The two ratchets an earlier draft named do not move.** It claimed the VRT
`SHARED_LINUX_PAIR_CEILING` and the linux-deficit ceiling had to be lowered in the same commit.
**Neither did.** Naming a ratchet that does not move is the same error class as missing one that
does: it makes the section *look* audited. (Both ceilings have since been deleted outright with
the platform dimension.)

**Repointing precedent, for the next deletion:** `e2e/tests/midi-learn.spec.ts` spawned a real
`callsine` node for its 6-fader coverage. It needed **repointing to another 6-fader module, not
a line delete** — precedent #1013, which repointed 5 fixtures from `hydrogen` to `drumseqz`
rather than deleting them.

**Never hand-edit anything under `__screenshots__`.**

---

## 3. THE VST — the parts that still gate unbuilt work

### 3.1 Two structural facts the parameter list hides

- **The engine is MONO.** `resynthBuf_` is one channel; stereo appears only at the
  filterbank's per-band pan (equal-power). The plugin is mono-in-stereo-out in its core.
- **FX slot type is hard-wired despite being a parameter.** `fxType(s)` exists in the layout
  and is saved in presets, but `processBlock:267-268` forces slot 1 = Reverb and slot 2 =
  Delay unconditionally. **Do not port `fxType` as a control** — it is dead in the shipped
  plugin, kept only for preset back-compat. (Phase 3 constraint.)

### 3.2.1 ⚠ SLICE: the declared range and the host-sync grid

**The fixed premise:** `fftOrder` is **not a parameter** — `PluginProcessor.cpp:55` is
`resynth_.prepare(sampleRate, 11)`, hardcoded, so `fftSize_` is **always 2048**.

**(a) FREE mode — the top ~61 % of the knob's travel is dead.** `setSliceMs`
(`SpectralResynth.cpp:362-373`) clamps the hop to

```
clamp(ms·SR/1000,  2 ms·SR,  fftSize·0.5)  →  clamp(·, 96, 1024) samples @48 kHz
                                           →  reachable hop = 2.00 … 21.33 ms
```

but the parameter is declared `NormalisableRange<float>(2.0f, 200.0f, 0.1f, 0.4f)`. So
**178.7 of the declared 198 ms — 90 % of the numeric range — is clamped away.** JUCE skew 0.4
means `value = 2 + 198·p^2.5`, so the 21.33 ms ceiling is hit at `p ≈ 0.394`: **turning SLICE
past ~39 % of its sweep changes nothing.**

**This one is total, and it is corroborated by an artifact rather than by arithmetic:** the
committed ART goldens `test/art/golden/metrics/sweep__spectralSlice__{mid,max}.json` (37 ms and
200 ms) are **identical in every audio field** — `dcOffset`, `peakDb`, `zeroCrossingRate`, all 8
`rmsDb`, all 8 `spectralCentroid`. They differ only in `realtimeFactor`, a wall-clock number
compared against a *ceiling* rather than against the golden. **The bug has been sitting in the
VST's own committed baselines**, unnoticed because that ART suite compares each golden to itself
and never to its siblings.

**(b) Host-sync — block-size-dependent, NOT universal.** `setHostSyncedHop` clamps to
`[32, fftSize_-1]` = 0.67…42.65 ms, and at 120 BPM the default 1/16 requests 6000 samples and
receives 2047.

#### ⚠ CORRECTION — (b) was overstated. The grid DOES engage at normal block sizes.

**An earlier revision concluded "the bar-grid phase is discarded too: analysis fires every 2047
samples, unrelated to the beat." That is FALSE at every common host block size, and the error is
instructive: every line it cited resolved, and the inference drawn from them did not hold.**
What it missed is that `setHostSyncedHop` is called **once per block** and **re-primes
`samplesSinceHop_` every block**, so the clamped `hopSize_` almost never free-runs to its own
period.

Simulated over the exact three cited sites, 1/16 @ 120 BPM / 48 kHz over 20 grid periods:

| host block | analyses (want 20) | max distance from the beat |
|---:|---:|---:|
| 64 · 128 · 256 | 25 · 23 · 22 | **1 sample** |
| 512 · 1024 | 21 · 21 | **1 sample** |
| **2048 · 4096** | **60 · 60** | **2946 · 2910 samples (≈61 ms)** |

- At **block ≤ 1024** — Ableton/Logic/Bitwig defaults — the analyser fires on the musical grid
  within one sample. The clamp is *masked*.
- At **block ≥ 2048** the clamp bites: **3× the requested analysis rate** and alignment gone.
- The residual 1-sample error at small blocks is a **separate, pre-existing off-by-one**
  (`samplesSinceHop_` is pre-incremented before the `>=` test), present with the ceiling removed
  too, so it is independent of it.

*(Instrument note: the block-size result is a simulation of the counter logic, not of the audio.
It is falsifiable by changing any one of the three cited sites. It was run precisely because the
arithmetic-only argument had already produced one confident wrong answer.)*

### 3.2.2 ✅ DECISION (owner, 2026-08-02): **CORRECT, not faithful.** Resolves Q8.

**This is the only record of a deliberate divergence from the reference plugin, and it is
settled — not a matter for re-litigation at implementation time.** Now encoded on the module at
`warrensspectrum.ts:56`.

1. **SLICE is reachable across its full declared range.** Whatever range we declare, every
   value in it changes the sound. We do **not** reproduce a ceiling that makes the top of the
   knob inert.
2. **Host/clock sync works at musical tempos** — and at every host block size, not only at
   ≤ 1024.

**Stated plainly, because it changes what "1:1 copy" is allowed to mean: on these two axes we
are deliberately NOT bit-identical to the current VST.** A faithful port of a control whose top
61 % of travel is inert is not fidelity, it is a reproduced defect — and "1:1 copy" must never
be read as a licence to reproduce dead knob travel. Anyone comparing the two products on a
SLICE value above ~21 ms, or on host-sync at a large buffer, **should expect them to differ**,
and that difference is the feature.

**Everything else stays 1:1.** Scoped to (i) the SLICE range ceiling and (ii) the host/grid-sync
clamp. It authorises no other divergence: the peak tracker, the harmonic lock, the F0 detector,
the SMS residual, the stability gate, the partial caps, the shape morph and every default value
continue to target bit-level agreement, and any further deviation is a new decision.

### 3.4 / 3.5 — constraints on the unbuilt phases

- **FilterBank**: a band with all three sends at 0 is **skipped entirely** — a real CPU
  optimisation worth keeping.
- **FeedbackLoop**: at the **0.5 ms default** it is a comb resonator with a ~2 kHz fundamental,
  and moving FB CUTOFF reads as FM — **not an echo**. That default is a character choice, not a
  neutral. (Phase 3.)
- **Wavetabler**: note the **startup passthrough** — if no cell has closed yet it passes input
  through rather than outputting silence. (Phase 3.)
- **Fingerprint** (`Fingerprint.cpp`): serialises every `RangedAudioParameter` to JSON as
  `{ type: "wsp-fp", version: 1, pluginVersion, params: { id: value } }`; `apply()` skips
  unknown keys for forward-compat and clamps to range. **A ready-made, already-versioned preset
  interchange format** — a user could copy a patch out of the VST and into the module and back,
  if we keep the param ids. Worth far more than matching knob layouts, and it constrains param
  naming. (Phase 5.)

---

## 4. BROWSER FEASIBILITY — the measurements

**All figures measured on Apple M5 / node v22.22.2, pure-JS `Float32Array` loops faithful to
`packages/dsp/src/callsine.ts` structure.** ⚠ **Node/V8 on a fast dev machine is an OPTIMISTIC
proxy** for an AudioWorklet on a user's laptop — treat every number as a floor.

**(a) Radix-2 complex FFT — ms per transform:** 1024 → 0.0247 · 2048 → 0.0453 · 4096 → 0.0948.

**(b) K-partial sine bank — 1.0 s of audio @ 48 kHz**

| K | render ms | % of one realtime core |
|---:|---:|---:|
| 16 | 6.0 | 0.6 % |
| 64 | 10.7 | 1.1 % |
| 128 | 19.1 | 1.9 % |
| 256 | 37.1 | 3.7 % |
| 512 | 68.0 | 6.8 % |
| 892 | 113.9 | 11.4 % |

**(c) MQ matcher — the `O(peaks × tracks)` loop**

| peaks | tracks | ms/hop | @ hop 512 (93.75/s) | @ hop 96 (500/s) |
|---:|---:|---:|---:|---:|
| 64 | 64 | 0.0152 | 0.14 % | 0.8 % |
| 128 | 128 | 0.0230 | 0.22 % | 1.2 % |
| 256 | 256 | 0.0825 | 0.77 % | 4.1 % |
| 512 | 512 | 0.3056 | 2.87 % | 15.3 % |
| 892 | 1024 | 1.0681 | **10.01 %** | **53.4 %** |

**(d) The rest of `analyzeFrame()`** (numBins = 1024 for FFT 2048): magnitude+phase 0.00762 ms,
peak pick + parabolic log-mag interp @ FLOOR −60 dB 0.00359 ms, `detectF0` 0.00020 ms —
**subtotal 0.0114 ms/hop.**

⚠ **`detectF0` is 32 candidates, not "~700".** `binHz = 48000/2048 = 23.44 Hz`, so
`binLo = max(2, ⌈60/23.44⌉) = 3` and `binHi = min(1024/8, ⌊800/23.44⌋) = min(128, 34) = 34` —
**32 candidates × 8 harmonics = 256 multiply-adds per hop.** Framing it as `O(N·k)` in the bin
count is wrong: it is `O(B·K)` in the *candidate* count, and B is tiny. The VST's own comment
reasons about *"~700 F0 candidates"* — not reachable at the order-11 FFT it hardcodes. (The
confidence normalisation is unaffected: `√(2 ln N)/√(ln N) = √2` for any N, so the z-score
threshold of 1.4 survives the correction. Worth knowing before anyone "fixes" it.)

⚠ **Instrument check, both directions.** Halving the bin count halved the magnitude+phase cost
(**2.12×**, must be ~2 if it is really `O(bins)`), and dropping the peak threshold to 0 so every
bin becomes a peak candidate **raised** the peak-pick cost **1.20×**. Both numbers moved with
the dimension under test, so neither is measuring loop overhead. A flat response would have
looked equally authoritative and meant nothing.

### 4.2 The finding: the **matcher** is the wall, not the FFT and not the bank

At the VST's maximum (892 partials, 1024 track slots) the FFT is **0.4 %** of a core while the
matcher is **10 %** — 24× more expensive — because it is quadratic where the FFT is `N log N`.

**And the average is the wrong statistic.** An AudioWorklet renders 128-sample quanta with a
**2.67 ms** deadline. The hop cost is a **spike inside one quantum**:

```
bank         113.9 ms/s × 128/48000  = 0.304 ms
matcher                               = 1.068 ms
FFT (N=2048)                          = 0.045 ms
mag+phase / peak-pick / F0            = 0.011 ms
                                        ─────────
                                        1.429 ms  =  53.5 % of the 2.67 ms deadline
```

**53 % of a single quantum's budget, on an M5, for ONE instance, with nothing else in the rack.**

⚠ **"% of one core" would have been the wrong statistic**, and an earlier analysis used it.
Audio does not die on an average; it dies on a **per-quantum deadline**. The worklet calls
`analyzeFrame()` **inline in the per-sample loop**, so the whole FFT + peak-pick + F0 + MQ burst
lands **inside one `process()` call** — and at small hop sizes inside **every** one. A budget
expressed as a percentage of a core is invariant to that, which is exactly what makes it useless
here.

*(The §4.1d stages an earlier draft omitted move this from 1.417 → 1.429 ms and the proposed cap
from 0.227 → 0.239 ms — **0.8 % and 5 %. The omission was real; it was not material, and saying
so is the honest close.**)*

### 4.4 The empirical anchor

The shipped `callsine` ran FFT 1024 / hop 256 / 64 tracks ≈ **1.9 % of a core**, hop-quantum
spike 0.068 ms = **2.6 % of the deadline**, and shipped without CPU complaints. The 256-partial
configuration is **3.3× that spike** (8.5 % vs 2.6 %) and still **~12× inside the deadline,
where the VST's maximum (53 %) is not.**

⚠ **The instrument, negative-controlled.** The bank benchmark scales 16→892 as
6.0/10.7/19.1/37.1/68.0/113.9 ms — from 128 upward each doubling of K costs 1.94×/1.83×/1.67×,
i.e. linear in K plus a fixed ~3 ms loop overhead. The matcher scales superlinearly with P·T as
expected. Both respond to the dimension under test. Had the numbers been flat, they would have
looked equally authoritative and meant nothing.

### 4.5 Two optimisations measured **NEGATIVE** — recorded so nobody spends a day on them

| "optimisation" | expected | **measured** | why |
|---|---|---:|---|
| Port the VST's `fastSin2Pi` polynomial in place of `Math.sin` | ~4× (what it gets over libm in C++) | **1.01×** | V8's `Math.sin` is already a fast intrinsic; the C++ win does not exist in JS. |
| Hoist the model `switch` out of the per-sample inner loop | ~2.5× | **1.11×** | the branch is perfectly predicted and JIT-hoisted already. |

⚠ **The 2.5× figure came from #1295's own first two benchmarks**, which appeared to support it
and were wrong — only a **single-variable** experiment (change the hoist, change nothing else)
disproved it. That is the lesson worth more than the two numbers: a micro-benchmark that varies
two things at once will confirm whichever hypothesis you brought to it.

⚠ Also from #1295: it measured the same partial bank four ways and got **7.5 % / 21.2 % /
30.1 % / 51.7 %** of a core. **That spread is itself the finding.** Every design choice above
survives the pessimistic end of it; none should be defended on the optimistic end.

---

## 5. THE FACE — 104 params against a 6-cell lane (still unbuilt)

### 5.1 The budget, measured

From `curated-face.ts` / `curated-face.test.ts`:

| tier | cells |
|---|---:|
| mini | 1 |
| compact (with glyph) | 2 |
| compact (no glyph) | 3 |
| **full (in-lane plate)** | **6** = `PLATE_COLS(3) × PLATE_MAX_ROWS(2)` |
| dock | all, grouped by `pages` |

So **6 of 104** reach the lane. 98 live in the dock — a ratio of ~17:1, worse than DX7, the
current largest face.

### 5.2 The six that earn the lane

`engineMode` · `spectralPartials` · `spectralLock` · `engineFreeze` · `spectralResidual` ·
`spectralSlice`. Each has an argument that would be **wrong for a different module**:

1. **`engineMode`** selects between three different DSP classes. On a single-engine module this
   rank would be absurd.
2. **`spectralPartials`** is the one true macro: density *and* the CPU dial *and* (via
   `cbrt((n-1)/47)`) the residual scale. Three jobs in one knob.
3. **`spectralLock`** decides whether the output is musical or warbly, defaults **on** (0.75),
   and self-disengages on unpitched input.
4. **`engineFreeze`** is the only *performative* control — a gesture, not a setting.
5. **`spectralResidual`** is the sine/noise balance; the plugin's own header calls it the #1 fix
   for the robot-vocoder character.
6. **`spectralSlice`** is the rhythmic axis. ⚠ Its rank is earned by its **live range**, *not*
   by the host-synced 1/16 default, which collapses to a fixed 42.65 ms hop (§3.2.1).

Deliberately **not** in the lane: `gain` (every module has one), `spectralFloor` (it pairs with
STABILITY, and pairs belong in a band), and the filterbank (56 params cannot be one cell
honestly).

### 5.3 The load-bearing decision: four subsystems become PANELS, not param lists

A `ControlFamily` renders one cell that opens a purpose-built editor:

| family | replaces | params absorbed |
|---|---|---:|
| `ws-filterbank` | 8 bands × (cutoff, Q, type, pan, main, fx1, fx2) | **56** |
| `ws-fx` | 2 slots × (on, p0, p1, p2, mix) — `fxType` **excluded**, §3.1 | **10** |
| `ws-wavetable` | size, spread, morph, width, mix, →fx1, →fx2 (+2 legacy bools) | **9** |
| `ws-feedback` | amount, time, cutoff, Q, type | **5** |
| | | **80** |

**80 of 104 params never appear as individual cells at all.** 104 − 80 = 24 discrete controls,
of which 6 reach the lane and 18 fill the dock bands — DX7-scale, and DX7 already works.

The filterbank panel should be a **curve editor**, not 56 knobs — the VST already ships one
(`visual/FilterCurveComponent.h`, 297 lines), and its vertical axis is the MAIN send over 0..1
with centre at 0.5.

⚠ **Page-id collision warning, from DX7's scar:** a page id colliding with a curated rear group
id renders that band **twice** and fails the rear-derivation totality gate. Avoid
`'voice'` / `'signal'`.

---

## 6. Scope, said plainly

**"A 1:1 copy of the CallSine VST" is not a batch item. It is months of DSP work.** 104 runtime
parameters across three independent engines (`SpectralResynth` 1,010 LOC + `MassPass` 326 +
`Wavetabler` 253), an 8-band morphing filterbank, a feedback loop, two FX slots, a master
filter, **and** a curve-editor UI the plugin ships as a 297-line component. **The remaining
phases are each a multi-PR project in their own right. Do not schedule against them.**

---

## 8. TESTABILITY

### 8.1 ⚠ What the ART gate actually IS

**The superseded #1295 got this wrong and built a recommendation on it.** It claimed ART's
protection is a *"long-term-average spectrum"* fingerprint and therefore *"structurally
invariant to SLICE, FREEZE, STABILITY and SLEW"* — a "harness hole". **It is not.** The real
gate is `assertBaseline` (`art/setup/capture.ts:176-197`):

1. a **source-SHA pin** — `expect(existingSha).toBe(srcSha)`, so a DSP edit fails loudly until
   deliberately re-pinned; then
2. `compareBuffers(..., tier 'B', 1e-4)` — a **length-equality check plus the RMS of the
   sample-wise difference over the whole buffer**, against `1e-4`.

That is a **time-domain, sample-aligned** comparison. It is not invariant to SLICE or FREEZE or
anything else — a one-hop timing shift moves it far past `1e-4`. `fingerprints.generated.json`
is **display / provenance data**, pinned to each `.f32`'s sha256 so the two artifacts cannot
drift; it **never renders audio and gates nothing on its own.** Do not design around a hole that
is not there.

### 8.2 The design constraint that makes goldens possible

The engine is deterministic given a fixed input, sample rate and params — *except* the residual
noise generator, which is an `xorshift32` seeded to a constant
(`SpectralResynth.cpp:200`, `residualNoiseState_ = 0x9E3779B9u`). **Seed it identically in the
port and the whole engine is byte-reproducible.** That must be an explicit design constraint on
any new worklet, not an accident.

Where a golden would be brittle (SLICE / PARTIALS sweeps), pin **relationships**: partial count
monotonic in PARTIALS; LOCK=1 on pitched input → peaks within 25 cents of `k·F0`; STABILITY↑ →
fewer track births/s; FLOOR↑ → fewer surviving peaks. **Each needs a negative control** — break
the specific thing and watch that specific assertion go red. A partial-count assertion that
passes when the tracker is disabled is measuring the harness.

### 8.3 What can never be covered — state it rather than pretend

- **"Does it sound like the VST?"** No automated test answers this. The C++ and the TS will
  never be sample-identical (different FFT implementations, different float ordering). Only an
  A/B listening session settles it, and it should be an explicit owner-review gate.
- **The real-user rack fixture** — the loader is testable; representativeness is not.
- **CPU under real load.** The §4 numbers are node-on-M5; the CI runner is not a proxy for a
  user's machine in either direction.
- **Host-tempo SLICE alignment** — quantum-granular (±2.67 ms) by construction, never
  sample-accurate.

⚠ Deleting e2e/ART specs **reshuffles Playwright sharding**, which is how #1033 turned three
unrelated specs red — expect it and do not read it as flake.

---

## 9. Owner questions still open

1. **Fingerprint interchange (§3.5, phase 5).** Worth constraining our param ids to the VST's so
   `.wspr`/JSON patches move both ways? (It constrains **param** ids only — port ids stay ours,
   which is what makes the `callsine` alias possible.)
2. **The alias grace period.** `RETIRED_TYPE_ALIASES`'s stated removal condition is "two minor
   releases after ship, then drop the table" — matching how #1027 retired the video aliases.
   Right length? The table is still in `persistence.ts` and nobody has started the clock.
