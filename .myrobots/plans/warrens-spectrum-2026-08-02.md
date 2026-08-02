# Warren's Spectrum — kill two modules, ship one

**Date:** 2026-08-02 · **Status:** PLAN (docs-only; no code in this PR)
**Owner directive, verbatim:**

> "for callsine yes we need to do the rewrite as the vst. but also look at our warren's
> spectrum module. i want to get rid of our existing warren's spectrum and callsine modules,
> and have a single module called Warren's Spectrum that is a 1:1 copy of the callsine vst"

> "i think we want to completely kill the existing warren's spectrum module, i believe this
> will be a total rewrite"

Both existing modules are DELETED. One new module — **Warren's Spectrum** — is built from the
`../callsine` VST. Total rewrite, not a merge.

---

## 0. Corrections to the brief — read these first

Three load-bearing premises in the task brief are wrong. Each was re-verified against source.

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
68 of the 104 params, including the subsystem (`FilterBank`) that every drop of audio passes
through. Any face/phasing plan built on "49 params" is sized for a different plugin.

*(Verified by brace-depth expansion of `PluginParams.h`. My first two attempts at this script
both returned 49 because the loop-scope flag reset one line early — the `for` line carries no
brace. Stated because a wrong count here reads exactly like a right one.)*

### 0.2 There is a **third** engine mode: MASSPASS

The brief lists `Mode` without its values. `engineMode` is a 3-way choice —
`{ "SPECTRAL", "WAVETABLE", "MASSPASS" }` (`PluginParams.h:126`) — and MASSPASS is a whole
separate 326-line DSP class (`dsp/MassPass.cpp`) with its own band-count parameter
(16/24/33/48/66/99). It is the plugin's most recent work: phases 39-42, four of the last six
commits (`ec707d3`, `99128d1`, `0c7f8a6`, `88f4886`). A plan that ships "the spectral engine"
ships one of three.

### 0.3 Our `callsine` does **not** share "nothing" with the VST — it shares the CORE ALGORITHM

The brief says our `callsine` is "a Plaits-style MACRO-OSCILLATOR, sharing NOTHING with the
VST." Its *control surface* is Plaits-style. Its *engine* is a direct port of the VST's
`SpectralResynth`:

| stage | VST `dsp/SpectralResynth.cpp` | our `packages/dsp/src/callsine.ts` |
|---|---|---|
| window | Hann, precomputed | Hann, precomputed (`:78-81`) |
| FFT | `juce::dsp::FFT`, order 11 → **2048** | hand-rolled radix-2, **1024** (`:62`, `:109-118`) |
| hop | `fftSize/4` = 512, Slice-overridable | `FFT_SIZE/4` = **256**, fixed (`:64`) |
| peak detect | parabolic interp in log-mag (`:474-486`) | same |
| F0 | harmonic sum, 60–800 Hz, 8 harmonics (`:244-246`) | same, `F0_LO_HZ 60` / `F0_HI_HZ 800` / `F0_MAX_HARMONICS 8` (`:71-73`) |
| tracking | McAulay-Quatieri-lite, 5 % rel tolerance (`:226`) | same (`callsine.ts:11-12`) |
| bank | up to **892** partials | up to **64** (`N_TRACKS`, `:65`) |

`packages/dsp/src/callsine.ts:5` says so outright: *"Algorithmic port of Warren's Spectrum
(a.k.a. CallSine), MIT-licensed."* And `oss-attribution.test.ts:55` already credits
`"callsine contributors (Warren's Spectrum)"`.

**Why this matters for the plan, in both directions:**
- It is *good* news for feasibility: the hardest half (a real-time STFT partial tracker in an
  AudioWorklet) is **already shipped and tested in this repo**. This is not a green-field port.
- It is *bad* news for the "1:1 copy" framing: our port is the VST's engine with 15 spectral
  params collapsed into 4 macros, a 4× smaller FFT and a 14× smaller bank. The gap to 1:1 is
  large, and it is mostly **the 68 params the brief omitted** plus the two other engines.

### 0.4 The VST is already called Warren's Spectrum

`callsine` is only the CMake project id. `PRODUCT_NAME` is `"Warren's Spectrum 0.6 FP"`
(`CMakeLists.txt:62`), `COMPANY_NAME "Warren"` (`:52`), presets are `.wspr`, the fingerprint
type marker is `"wsp-fp"` (`Fingerprint.cpp:8`), and `README.md:1` is `# Warren's Spectrum`.
So the owner's naming instruction is a *restoration*, not a rename: the module takes the name
the plugin already has. Nothing in the VST needs renaming to match.

---

## 1. THE MIGRATION — this is the part that destroys user data

**Lead with this because it is irreversible and currently silent.**

### 1.1 What this repo actually does today — there is NO type-migration seam

I searched for one. The finding is not "it's elsewhere" — it is that the substrate was
**deliberately removed**.

`packages/web/src/lib/graph/persistence.ts:13-15`:

> "The per-module `schemaVersion` / `moduleSchemas` migration substrate was collapsed in the
> schema cleanup (envelope v2) — a patch now stores TOPOLOGY + authored / sequenced values
> only, and **is never reshaped on load**."

`schema-cleanup-roundtrip-golden.test.ts:16` is the gate that keeps it collapsed. So there is
**no precedent for renaming or replacing a node type**, and no hook to add one to without
re-opening a closed design decision.

### 1.2 What happens today to a rack containing `callsine` or `warrenspectrum`

Exactly this, traced through `loadEnvelopeIntoStore` (`persistence.ts:342-449`):

1. `isKnownModuleType(node.type)` (`:31-35`) checks all three registries. After deletion both
   types resolve to `undefined` → **false**.
2. `:369-376` — the node is **silently dropped**. A `LoadDiagnostic { nodeId, type, reason:
   'module type not registered in this build' }` is pushed. The code comment reads
   `// Phase 1: skip. Future: insert placeholder error node.` — the placeholder was never built.
3. `:409-418` — **every edge touching that node is also dropped**, each with its own
   `'edge references a dropped node'` diagnostic.
4. `Canvas.svelte:2952-2954` — the diagnostics are emitted with **`console.warn`**. Nothing
   else. No toast, no modal, no banner, no count in the UI.

**Net user-visible behaviour: the modules and all their cables vanish, the rack loads
"successfully", and the only evidence is in a devtools console nobody has open.**

The blast radius is *not* limited to the two cards. `warrenspectrum` has 8 per-band sends and
8 per-band returns, so a rack using it as an insert bank loses up to **16 cables plus the
external FX chain's connectivity** — the FX modules survive as orphans, silently unpatched.

The three shipped example patches are clean (checked by decoding each envelope's Yjs update
and scanning for both type strings: `gibribbon-demo`, `glitches`, `media-burn` — all clean),
so no in-repo fixture breaks. User racks are the exposure, and they are not in the repo.

### 1.3 Proposal: **REPLACE, loudly** — with the drop path as the safety net

Three options considered:

| option | verdict |
|---|---|
| Silent drop (status quo) | **REJECTED.** Destroys work with no notice. The owner did not ask for data loss; he asked for one module instead of two. |
| Re-introduce the general `moduleSchemas` migration substrate | **REJECTED.** Re-opens a closed design decision and adds a permanent generic mechanism for a one-off. |
| **A narrow, explicit type-alias table consulted at load** | **CHOSEN.** ~15 LOC, one table, dies when the aliases are eventually retired. |

**The mechanism.** Add to `persistence.ts` a single table and consult it *before*
`isKnownModuleType`:

```ts
/** RETIRED module types → the type that replaces them. Consulted ONCE, at load,
 *  before the unknown-type drop. NOT a general migration substrate: no value
 *  reshaping, no per-module hooks, no schemaVersion. A node's `type` string is
 *  rewritten and its `params` are DISCARDED (the replacement's contract shares
 *  no param ids with either predecessor). Entries are removed when the grace
 *  period ends and the drop path takes over again. */
const RETIRED_TYPE_ALIASES: Readonly<Record<string, string>> = {
  callsine: 'warrensspectrum',
  warrenspectrum: 'warrensspectrum',
};
```

**Semantics, stated precisely because each clause is testable:**

- **The node survives, at its saved position, with its saved id.** Position and id are the
  parts a user cannot reconstruct.
- **`params` are dropped, not mapped.** Neither predecessor shares a single param id with the
  new contract (`callsine`: `model/note/harmonics/timbre/morph/level`; `warrenspectrum`:
  `level1..8/master/viznoise/ping_decay/tuning_mode/root/q/spread/bleed`). Silently
  reinterpreting `morph` as something else would be worse than resetting. The node loads at
  the new module's defaults.
- **Edges are re-validated, not blanket-dropped.** They already are: `validateEdge` at
  `:429-437` drops a structurally-invalid edge individually with its own diagnostic. A
  `callsine.out → x` edge whose port id survives on the new module reconnects; one whose port
  is gone is dropped **one edge at a time**, each reported. This is existing machinery — the
  alias table changes nothing about it. **This is the single strongest argument for
  REPLACE-over-DROP:** an aliased node keeps every cable whose port name survives, where a
  dropped node loses all of them unconditionally.
- **A diagnostic is emitted for every migrated node**, with a distinct reason string —
  `'migrated from retired type "<old>"; controls reset to defaults'`.

**And the migration must be VISIBLE.** The alias table alone still reports through
`console.warn`. Silent success is what makes the current drop path dangerous, and it would
make the migration equally dangerous. **`Canvas.svelte` must surface a non-blocking summary**
("2 modules migrated to Warren's Spectrum; their controls were reset") on any load whose
diagnostics are non-empty. This is a small UI change with a value beyond this PR — it also
lights up the *existing* silent-drop path for every unknown type.

**Grace period.** The aliases stay for two minor releases, then are removed; after that the
drop path handles them, correctly and by then harmlessly. Put the removal condition in the
comment so it does not become permanent by default.

### 1.4 Testability — with a REAL saved-rack fixture

The seam already has a test to extend: `persistence.test.ts:302` —
`'drops nodes whose module type is not registered, plus edges referencing them'`.

**Fixture, generated once and committed** (`packages/web/src/lib/graph/__fixtures__/retired-warrenspectrum.imp.json`):
a v2 envelope built on a branch where both modules still exist, containing —

- one `callsine` node with non-default params and one patched `out` edge,
- one `warrenspectrum` node with two band send/return pairs patched through a `delay`,
- one unrelated module (`vco`) that must survive **untouched** — the negative control for
  "the migration didn't just eat the graph".

**Assertions:**

1. Both retired nodes are present after load, with their **original ids and positions**.
2. Both have `type === 'warrensspectrum'`.
3. `diagnostics` contains exactly two `migrated from retired type` entries, naming
   `callsine` and `warrenspectrum`.
4. Params equal the new module's **defaults** — asserted against `warrensSpectrumDef.params`,
   never against literals, so a default change cannot silently pass.
5. The `vco` node and its edges are **byte-identical** to pre-load.
6. Edge survival is asserted **per edge**, not by count: an edge onto a surviving port id is
   present; an edge onto a vanished port id is absent **and** has its own diagnostic.

**The negative control this test needs** (and the reason to write it this way): temporarily
empty `RETIRED_TYPE_ALIASES` and assertions 1-4 must go red — specifically assertion 1, on
node *presence*. If they stay green with an empty table, the fixture never contained a retired
node and the test proves nothing. Run it, watch it fail, restore, and record the verbatim
failure in the PR.

⚠ **What this test cannot cover:** the fixture is generated on a branch where the old modules
exist and is then frozen. It proves the *loader* handles a retired type; it does **not** prove
the fixture resembles any real user's rack. That gap is unclosable in-repo and should be
stated rather than papered over.

---

## 2. WHAT IS BEING DELETED — the exhaustive list

A half-deletion leaves a red gate. Every item below was located by grep across the worktree.

### 2.1 `callsine` — 4 files, 1,838 LOC

| path | LOC |
|---|---:|
| `packages/web/src/lib/audio/modules/callsine.ts` | 639 |
| `packages/web/src/lib/audio/modules/callsine.test.ts` | 383 |
| `packages/dsp/src/callsine.ts` | 728 |
| `packages/web/src/lib/ui/modules/CallsineCard.svelte` | 88 |

⚠ **`packages/dsp/src/callsine.ts` is the file the new module should be built FROM, not
deleted outright.** See §6. It is the only working STFT partial tracker in the repo.

### 2.2 `warrenspectrum` — 10 files, 2,428 LOC

| path | LOC |
|---|---:|
| `packages/web/src/lib/audio/modules/warrenspectrum.ts` | 479 |
| `packages/dsp/src/warrenspectrum.ts` | 437 |
| `packages/web/src/lib/audio/modules/warrenspectrum-draw.ts` | 153 |
| `packages/web/src/lib/audio/modules/warrenspectrum-draw.test.ts` | 179 |
| `packages/web/src/lib/audio/warrenspectrum-math.ts` | 185 |
| `packages/web/src/lib/audio/warrenspectrum-math.test.ts` | 262 |
| `packages/web/src/lib/ui/modules/WarrenspectrumCard.svelte` | 259 |
| `art/scenarios/warrenspectrum/warrenspectrum.test.ts` | 165 |
| `art/scenarios/warrenspectrum/ping-rings.test.ts` | 213 |
| `e2e/tests/warrenspectrum.spec.ts` | 96 |

### 2.3 Baselines

**ART:** `find art/baselines -iname '*warren*' -o -iname '*callsine*'` → **zero files**.
Neither module has a `.f32`/`.sha` golden. Both ART scenarios are **assertion-based**, not
golden-pinned (`warrenspectrum.test.ts` asserts band-3 isolation and ping ringing by FFT
magnitude ratios; `ping-rings.test.ts` asserts top-3 band ranking and bleed). **So no ART
re-pin and no `art:fingerprints:accept` is needed for the deletion** — but see §8, because it
also means the deletion destroys *no* golden and the new module starts with none.

**VRT:** exactly two PNGs, both for `warrenspectrum`:
- `e2e/vrt/__screenshots__/vrt.spec.ts/darwin/warrenspectrum.png`
- `e2e/vrt/__screenshots__/vrt.spec.ts/linux/warrenspectrum.png`

`callsine` has **no** baseline — it is exempt (`vrt-exemptions.ts:631`, *"VRT baseline
pending"*).

⚠ **Do not hand-delete the linux PNG selectively or hand-edit anything under
`__screenshots__/*/linux/`.** For a pure deletion, `git rm` of both is correct and needs no
dispatch (the scene is gone, so nothing re-renders it). The `vrt-update.yml` dispatch is
needed only for the NEW module's baselines — see §8.

### 2.4 Registry / list entries — every one is a red gate if missed

| file | what |
|---|---|
| `packages/web/src/lib/docs/contract-lock.txt` | **17** `callsine` lines + **62** `warrenspectrum` lines = **79 lines**. GENERATED — never hand-edit; `task docs:accept` re-pins. |
| `packages/web/src/lib/docs/module-manifest.ts` | `DESCRIPTIONS.callsine` (:366), `DESCRIPTIONS.warrenspectrum` (:310) |
| `packages/web/src/lib/docs/strict-docs.ts` | `'callsine'` (:167), `'warrenspectrum'` (:264) + two comment references (:156, :253) |
| `packages/web/src/lib/ui/modules-card-map.test.ts` | `EXPECTED_NODE_TYPES` — both (:38, :59) |
| `packages/web/src/lib/ui/rack-sizes.ts` | `callsine: 1u/2hp` (:36), `warrenspectrum: 3u/3hp` (:144) |
| `packages/web/src/lib/docs/interactive/interactive-doc-modules.ts` | `'callsine'` (:122) + comments (:115, :162) |
| `packages/web/src/lib/audio/modules/oss-attribution.test.ts` | import (:32) + roster row (:55) |
| `art/setup/profile-coverage.ts` | `'callsine'` (:71), `'warrenspectrum'` (:111) |
| `e2e/vrt/vrt-exemptions.ts` | `callsine` exemption (:631); `linux/warrenspectrum` drained-pair comment (:1392); comment refs (:51, :956) |
| `e2e/vrt/vrt-scenes.ts` | the whole `warrenspectrum` scene (:635-653) incl. the `__warrenspectrumVrtSeed` hook |
| `e2e/vrt/vrt-geom-probe.spec.ts` | an entire test — `'warrenspectrum capture geometry'` (:247-320) |
| `e2e/vrt/vrt-live-surfaces.ts` | 8 measurement comments (:22, :66, :82, :88, :94, :173, :177, :256, :262) |
| `e2e/vrt/vrt-capture.ts` | mask-tuning comment (:61) |
| `e2e/tests/per-module-per-port-behavioral.spec.ts` | **24** `warrenspectrum.*` exemption rows (:1419-1435 + block header :1406-1418); `callsine` has **0** |
| `e2e/tests/coverage-groups-6-7-8-9.spec.ts` | `warrenspectrum` coverage rows |
| `e2e/tests/docs-virtual-module.spec.ts` | `callsine` doc-page case (:392-393) + comments (:356, :480) |
| `e2e/tests/midi-learn.spec.ts` | **the spec spawns a real `callsine` node** (:131, :135) — needs a substitute module, not just a line delete |
| `e2e/tests/video-orientation.spec.ts` | `warrenspectrum` reference |
| `packages/web/src/lib/graph/patch-convenience.ts` | comment (:437) |
| `packages/web/src/lib/audio/module-registry.ts` | comment (:104) |
| `docs/testing/test-ledger.generated.md` | GENERATED — `task test:ledger:accept`, never hand-merge |

**Two ratchets move in the SAME commit as the deletion:**

- `packages/web/src/lib/audio/modules/vrt-meta.test.ts` — `SHARED_LINUX_PAIR_CEILING = 91`
  (:333) and the linux-deficit ceiling. Both are asserted **in both directions**
  (`<= CEILING` **and** `CEILING - actual === 0`, :524-529), so removing scenes without
  lowering the constants **fails the unit lane immediately**. That is the gate working; do not
  route around it.
- `docs/testing/test-ledger.generated.md` — regenerated, not hand-edited.

**Registration itself needs no edit.** Module registration is glob+palette-driven since PR
#551, so deleting the def files de-registers the modules automatically. `modules/index.ts`,
`Canvas.svelte`, `module-categories.ts` and `graph/types.ts` are **not** part of this
deletion.

### 2.5 What is being destroyed, recorded — the owner asked for this

**`warrenspectrum` (the existing module) is not a spectral resynthesizer at all.** It is a
**stereo 8-band resonator bank with vactrol ping excitation** — much closer to the VST's
`FilterBank` than to its `SpectralResynth`:

- 8 RBJ bandpass filters, octave-spaced 80/160/320/640/1280/2560/5120/10240 Hz, Q=6, or
  retuned as harmonic partials of a `root` MIDI note (`tuning_mode`).
- Per-band **ping gates**: a rising edge fires a vactrol envelope (soft attack 10-30 ms ±10 %
  jitter, exp decay 100-800 ms ±10 % jitter, tanh-saturated) which *both* injects a ~1 ms
  broadband click into the bandpass input *and* pumps the band's post-filter gain. Energy
  bleeds to n±1, n±2 with weights `[1.0, 0.35, 0.12] × bleed`.
- **Per-band sends and returns** — 8 mono outs + 8 mono ins; a patched return *replaces* that
  band in the mix, making it an 8-way parallel insert bank.
- A `viz_out` **mono-video** acidwarp EQ-curve render — a cross-domain audio→video bridge.

**Capabilities that die with it and have no home in the VST design:** the video output, the
per-band send/return insert matrix, the harmonic-partial tuning mode, and the whole ping/
vactrol/bleed excitation model. The VST's `FilterBank` has 8 bands with cutoff/Q/type/pan and
three sends (MAIN/FX1/FX2) — it has **no ping, no returns, no video**. If any of those four
matter to the owner, they need to be raised **now**, because this plan does not preserve them.

---

## 3. THE VST, FOR REAL — signal path, not parameter names

Read: `PluginProcessor.cpp` (532), `dsp/SpectralResynth.{h,cpp}` (237+1010), `dsp/MassPass.cpp`
(326), `dsp/FilterBank.cpp` (138), `dsp/Wavetabler.h` (253), `Fingerprint.cpp` (84).

### 3.1 The block-level chain

`PluginProcessor::processBlock` (`:85-476`) is explicit and ordered:

```
stereo in ──┬─ mono sum (0.5·(L+R))  ─────────────► ENGINE ──► resynthBuf_ (MONO)
            └─ inputL/inputR kept for dry paths          │
                                                          ▼
   [1] engine: SPECTRAL → SpectralResynth::process   (:292-294)
               MASSPASS → MassPass::process          (:296-298)
               WAVETABLE→ resynthBuf_ zeroed         (:300-303)
                                                          ▼
   [2] FilterBank::process(mono) → SIX buses:        (:307-311)
         mainL/R  +  fx1L/R  +  fx2L/R      (post-EQ, post-pan, post-send)
                                                          ▼
   [3] FILTERBANK WET crossfade + INPUT MIX add      (:324-339)
         main = wet·bankOut + (1-wet)·drySrc + inputMix·rawIn
         drySrc = resynth output (SPECTRAL/MASSPASS) or raw input (WAVETABLE)
                                                          ▼
   [4] FeedbackLoop::processInPlace per channel      (:342-343)
                                                          ▼
   [4.5] Wavetabler insert  (ONLY when MODE==WAVETABLE)  (:354-397)
         source = raw input in WAVETABLE mode, main bus otherwise
         + post-WT sends accumulate onto fx1/fx2
                                                          ▼
   [5] FxSlot 1 (Reverb) / FxSlot 2 (Delay), in place (:405-408)
                                                          ▼
   [6] sum main + fx1·mix + fx2·mix → master SVF morph → gain → out (:419-451)
```

Two structural facts the parameter list hides:

- **The engine is MONO.** `resynthBuf_` is one channel; stereo appears only at the
  filterbank's per-band pan (`FilterBank::setPan`, equal-power, `:59-67`). The plugin is
  mono-in-stereo-out in its core.
- **FX slot type is hard-wired despite being a parameter.** `fxType(s)` exists in the layout
  and is saved in presets, but `processBlock:267-268` forces slot 1 = Reverb and slot 2 =
  Delay unconditionally. **Do not port `fxType` as a control** — it is dead in the shipped
  plugin, kept only for preset back-compat.

### 3.2 SPECTRAL — what actually analyses and what actually resynthesises

`SpectralResynth::process` (`:888-1008`) is a **per-sample** loop; the FFT is *not* an
overlap-add. Per sample:

1. Push input into a circular buffer, `++samplesSinceHop_`; when it reaches `hopSize_`, run
   `analyzeFrame()` — **unless frozen** (`:923-930`).
2. Render **every live track** as a continuously-running oscillator and sum (`:934-979`).
3. Add the SMS residual noise bank (`:985-1004`).

`analyzeFrame()` (`:413-784`), in order:

- Hann-window the linearised circular buffer → `performRealOnlyForwardTransform` (`:421-430`).
- Magnitude + phase per bin; track `maxMag` and `totalEnergy` (`:441-450`).
- **Adaptive threshold** `thr = maxMag · 10^(FLOOR/20)` — FLOOR is **relative to the loudest
  bin**, not absolute dBFS (`:453`).
- **F0 detection** (`detectF0`, `:232-340`): harmonic sum over 60-800 Hz candidates, harmonics
  1..8 weighted `1/√k`. Confidence is a **z-score of the winner against the candidate
  distribution**, normalised by `√(log N)` (`:305-311`) — noise lands ≈1.0-1.2, pitched
  material ≈1.7-2.5, threshold 1.4. Parabolic sub-bin interpolation on the winner.
- **Peak picking**: local maxima above `thr`, parabolic interpolation in **log-magnitude**
  space, amplitude scaled by Hann coherent gain `4/N` (`:467-498`).
- **Salience ranking** (`peakSalience`, `:110-137`): `amp × bonus`, where a peak within 25
  cents of `k·F0` gets `bonus = 1 + 3·(1/√k)·confTerm·harmonicLock`. `partial_sort` keeps the
  top `activePartials_` **by salience, not amplitude** (`:504-519`) — so reducing PARTIALS
  collapses toward F0 and low harmonics rather than toward whichever formant bin was loudest.
- **F0 force-inject** (`:530-619`): if confident and F0 is absent from the surviving set,
  inject it — using `max(F0 bin amplitude, strongest surviving peak amplitude)`. The comment
  at `:566-585` is worth reading: an earlier gate blocked injection when F0 was weak, which
  fired constantly on formant-heavy vocals and left the bank playing a formant instead of the
  perceived pitch.
- **Harmonic LOCK** (`:627-652`): snap each peak toward `round(f/F0)·F0`, by
  `harmonicLock × clamp((conf-1.3)/1.1, 0, 1)`. **Only peaks within ~100 cents** of a harmonic
  are snapped (`relErr > 0.06 → continue`, `:648`); everything else passes through so formants
  and noise are not forced onto the comb.
- **MQ tracking** (`:661-747`): each peak seeks the nearest alive track within **5 % relative
  Hz**. Matched → frequency is *smoothed* toward the peak at the per-hop SLEW coefficient (not
  snapped — `:689`, and the comment says why: bin-to-bin migration otherwise sounds like
  chirped beeps), amplitude target updated, `framesAlive++`. Unmatched peak → birth in the
  first free slot; **amp is deliberately NOT reset and phase is only adopted if the slot is
  already silent** (`:715-727`) — both to avoid click discontinuities. Unmatched alive track →
  `ampTarget = 0`, `alive = false`.
- **SMS residual** (`:749-783`): mask ±3 bins around every surviving peak, integrate the
  *unclaimed* bin energy into 16 log-spaced bands (80 Hz → min(12 kHz, 0.45·SR)), store as
  per-band targets. In `process()` those drive 16 bandpass-filtered white-noise generators
  (`:986-1004`), each envelope-smoothed at ~25 ms.

**So, precisely, the four params the brief asked about:**

- **FREEZE** — `frozen_` skips `analyzeFrame()` on hop boundaries (`:928`). The bank keeps
  playing its last-acquired frequencies and amplitudes forever. It does **not** loop a buffer;
  it holds an oscillator state. That is why it is a *sustain* rather than a *stutter*.
- **LOCK** — the harmonic-comb snap above. Its strength is multiplied by F0 confidence, so on
  unpitched material it self-disengages. Default **0.75** — biased on.
- **RESIDUAL** — the SMS stochastic half: filtered noise carrying the energy the sinusoidal
  tracker discarded (sibilants, breath, noise floor). Range 0..2, default **0.5**. Header
  comment `:96-99` calls it *"the #1 fix for 'vocoder/robot vibe'"*. Additionally scaled by
  `cbrt((activePartials-1)/47)` (`:904-907`) so collapsing PARTIALS also cleans up the noise.
- **STABILITY** — `minBirthFrames_`: a track must be matched on N consecutive hops before it
  is audible, and it **ramps in linearly over the gate window** rather than hard-muting
  (`:968-971`). Default 3 hops ≈30 ms at hop 512/48 kHz. It is the anti-"robot beep" control
  that FLOOR alone cannot provide.

Two more that matter and are easy to mis-port:
- **SHAPE** morphs every voice sine→saw→square via PolyBLEP (`voiceWaveform`, `:83-98`), and
  there is an anti-alias gain ramp from `0.75·Nyquist` to `0.85·Nyquist` per partial
  (`:957-961`).
- **SLICE** is the analysis hop, and in non-FREE mode it is **host-tempo locked**
  (`PluginProcessor.cpp:145-189` → `setHostSyncedHop`), aligned to the bar grid. Default is
  `1/16` — the rhythmic stepping is the signature Panharmonium feel and is **on by default**.

### 3.3 MASSPASS — the other resynthesiser

`MassPass::process` (`:225-323`). Not FFT-based at all:

- N bandpass filters (N ∈ 16/24/33/48/66/99), log-spaced 50 Hz → 12 kHz, Q derived so each
  band's edges sit at `center/√ratio .. center·√ratio` (`:146-150`).
- Per band: envelope follower on `|bp|/Q` (3 ms attack / 80 ms release, `:170-173`) **and**
  zero-crossing pitch estimate smoothed at ~30 ms (`:179-180`, `:290-292`).
- **SLICE snapshots** `(env, smoothedHz)` into `(heldAmp, heldHz)`; the oscillator uses the
  *held* values between snapshots (`:260-269`). That sample-and-hold is what gives MASSPASS
  its stepping.
- Only the loudest `activeBands_` sound (`selectLoudestBands`, `:108-131`); phase advances even
  for inactive bands so re-activation does not pop (`:296-299`).
- Output normalised by `1/√N` (`:318-322`).

It shares the SHAPE knob and reuses the PARTIALS slider as a band limiter
(`PluginProcessor.cpp:204-220`).

### 3.4 FilterBank, FeedbackLoop, Wavetabler

- **FilterBank** (`:93-136`): 8 SVFs, each morphed LP→BP→HP by a continuous `typeMorph`
  (`morphSvf`), equal-power panned, fanned into three buses by MAIN/FX1/FX2 sends. A band with
  all three sends at 0 is **skipped entirely** (`:107-110`) — a real CPU optimisation worth
  keeping. Defaults: lows HP, mids BP, highs LP (`PluginParams.h:260-264`).
- **FeedbackLoop**: delay 0.5-1000 ms with an in-loop morphable SVF. At the **0.5 ms default**
  it is a comb resonator with a ~2 kHz fundamental, and moving FB CUTOFF reads as FM
  (`PluginParams.h:306-311`) — not an echo. That default is a character choice, not a neutral.
- **Wavetabler** (`Wavetabler.h`): 8 cells, per-cell length 0.1-100 ms, continuously captured
  from the post-feedback bus; playback triangular-blends cells centred at `morph` with width
  `spread`, L2-normalised, L/R centres fanned by `width`. Freeze stops the writer only. Note
  the **startup passthrough** at `:215-219` — if no cell has closed yet it passes input
  through rather than outputting silence.

### 3.5 Fingerprint — a portable preset format we should reuse

`Fingerprint.cpp` serialises every `RangedAudioParameter` to JSON as
`{ type: "wsp-fp", version: 1, pluginVersion, params: { id: value } }`, and `apply()` skips
unknown keys for forward-compat (`:71`) and clamps to range (`:76-78`). **This is a
ready-made, already-versioned preset interchange format**, and it means a user can copy a
patch out of the VST and into the module (and back) if we keep the param ids. That is a real
"1:1 copy" affordance worth far more than matching knob layouts, and it should be a phase-1
consideration rather than an afterthought — it constrains param naming.

---

## 4. BROWSER FEASIBILITY — with numbers

**All figures measured on Apple M5 / node v22.22.2 via `flox activate -- node`, pure-JS
`Float32Array` loops faithful to `packages/dsp/src/callsine.ts` structure.** Scratch
benchmarks, not committed. ⚠ Node/V8 on a fast dev machine is an **optimistic** proxy for an
AudioWorklet on a user's laptop — treat every number as a floor, and see §4.4.

### 4.1 The three hot loops

**(a) Radix-2 complex FFT — ms per transform**

| N | ms |
|---:|---:|
| 1024 | 0.0247 |
| 2048 | 0.0453 |
| 4096 | 0.0948 |

**(b) K-partial sine bank — 1.0 s of audio @ 48 kHz**

| K | render ms | % of one realtime core |
|---:|---:|---:|
| 16 | 6.0 | 0.6 % |
| 64 | 10.7 | 1.1 % |
| 128 | 19.1 | 1.9 % |
| 256 | 37.1 | 3.7 % |
| 512 | 68.0 | 6.8 % |
| 892 | 113.9 | 11.4 % |

**(c) MQ matcher — the `O(peaks × tracks)` loop at `SpectralResynth.cpp:663-698`**

| peaks | tracks | ms/hop | @ hop 512 (93.75/s) | @ hop 96 (500/s) |
|---:|---:|---:|---:|---:|
| 64 | 64 | 0.0152 | 0.14 % | 0.8 % |
| 128 | 128 | 0.0230 | 0.22 % | 1.2 % |
| 256 | 256 | 0.0825 | 0.77 % | 4.1 % |
| 512 | 512 | 0.3056 | 2.87 % | 15.3 % |
| 892 | 1024 | 1.0681 | **10.01 %** | **53.4 %** |

### 4.2 The finding: the **matcher** is the wall, not the FFT and not the bank

At the VST's maximum (892 partials, 1024 track slots) the FFT is **0.4 %** of a core while the
matcher is **10 %** — 24× more expensive — because it is quadratic where the FFT is
`N log N`. Every intuition that says "an FFT in a worklet is the scary part" is wrong here.

**And the average is the wrong statistic.** An AudioWorklet renders 128-sample quanta with a
**2.67 ms** deadline. The hop cost is a **spike inside one quantum**, not an amortised load.
At 892/1024 with hop 512, the quantum in which the hop fires costs:

```
bank   113.9 ms/s × 128/48000  = 0.304 ms
matcher                         = 1.068 ms
FFT (N=2048)                    = 0.045 ms
                                  ─────────
                                  1.417 ms   =  53 % of the 2.67 ms deadline
```

**53 % of a single quantum's entire budget, on an M5, for ONE voice, with nothing else in the
rack.** A machine 2× slower blows the deadline outright. This is the number that decides the
design.

### 4.3 What must be simplified — and what would be a lie to claim

**Must be simplified:**

1. **Cap partials at 256, not 892.** At 256/256 the matcher is 0.77 % and the bank 3.7 %; the
   hop-quantum cost is `0.099 + 0.083 + 0.045 = 0.227 ms` — **8.5 % of the deadline**. That is
   a **6.25×** headroom improvement for a partial count already past the point of perceptual
   return on most material. The VST's own default is **64** (`PluginParams.h:149`) with a
   **128** cap (`:156`), so a 256 ceiling is *above the plugin's own shipping default*.
2. **Replace the linear matcher with a frequency-sorted scan.** Peaks come out of the FFT in
   ascending bin order already; keeping tracks sorted by frequency makes matching a merge
   rather than a nested scan, turning `O(P·T)` into `O(P + T)`. This is the single
   highest-value deviation from the C++ and it changes no audible behaviour.
3. **Floor the SLICE range.** The VST allows 2 ms (hop ≈96 at 48 kHz → 500 hops/s). Even at
   256 partials that is 4.1 % continuous plus a spike every 96 samples — i.e. a hop in **every
   quantum**. Floor SLICE at ~5 ms in the browser, or make the short end reduce the partial
   cap automatically.
4. **One instance, not N voices.** This is an *effect*, not a polyphonic voice: it analyses
   whatever is patched in. "N voices" is the wrong axis — the real question is **N instances
   in a rack**, and the answer at 256 partials is roughly 3-4 before a single core is
   saturated. That should be stated in the module's docs.

**What would be a lie to claim:**

- **"1:1 with the VST at 892 partials."** Not on a mid-range laptop. See the deadline
  arithmetic above.
- **"Sample-accurate host-tempo SLICE sync."** The VST reads `getPlayHead()` for BPM and bar
  position (`PluginProcessor.cpp:151-177`). We have a clock, but the worklet would need the
  grid phase pushed to it per block; the alignment will be **quantum-accurate (±2.67 ms), not
  sample-accurate**. Say so.
- **"All three engines in phase 1."** MASSPASS at 99 bands is a second full DSP with its own
  cost profile; it is not measured here at all. **UNCONFIRMED: MASSPASS browser cost.**
- **"Zero added CI wall-time."** An ART scenario that renders several seconds of spectral
  resynth is not free. Measure it before merging (§8).

### 4.4 Against what `packages/dsp/` already does

`packages/dsp/src/callsine.ts` is the **only** FFT-using worklet in the repo (`grep -l FFT
packages/dsp/src/*.ts` → one file). It runs FFT 1024 / hop 256 / 64 tracks — i.e. **187.5
hops/s** with a 64×64 matcher. From the tables: bank 1.1 % + matcher 0.29 % + FFT 0.46 % ≈
**1.9 % of a core**, and its hop-quantum spike is `0.029 + 0.015 + 0.025 = 0.068 ms` —
**2.6 % of the deadline**. It has shipped without CPU complaints, which is the empirical
anchor: the proposed 256-partial configuration is **3.3× that spike** (8.5 % vs 2.6 %) and
still ~12× inside the deadline, where the VST's maximum (53 %) is not.

⚠ **The instrument, negative-controlled.** The bank benchmark scales 16→892 as
6.0/10.7/19.1/37.1/68.0/113.9 ms — from 128 upward each doubling of K costs 1.94×/1.83×/1.67×,
i.e. linear in K plus a fixed ~3 ms loop overhead. The matcher scales superlinearly with P·T
as expected. Both respond to the dimension under test, so neither is measuring loop overhead
alone. Had the numbers been flat, they would have looked equally authoritative and meant
nothing.

---

## 5. THE FACE — 104 params against a 6-cell lane

### 5.1 The budget, measured

From `curated-face.ts` / `curated-face.test.ts:243-259`:

| tier | cells |
|---|---:|
| mini | 1 |
| compact (with glyph) | 2 |
| compact (no glyph) | 3 |
| **full (in-lane plate)** | **6** = `PLATE_COLS(3) × PLATE_MAX_ROWS(2)` |
| dock | all, grouped by `pages` |

So **6 of 104** reach the lane. 98 live in the dock. The ratio is ~17:1 — worse than DX7,
which is the current largest face.

⚠ **The brief names face fields — `readouts`, page `title`/`hint`, `sidebar` blocks, `hero`
slot — that do NOT exist in this worktree.** `ModuleFace` at `graph/types.ts:540-618` carries
exactly: `order`, `pages` (with `clusters`), `glyph`, `glyphDepthGain`, `paramCells`,
`momentary`, `rear`. **UNCONFIRMED: the sibling agent's platform additions.** Everything below
is written against the *shipped* platform so it cannot rot; where a new affordance would
obviously help, it is flagged rather than assumed.

### 5.2 Proposed `order` — the 6 that reach the lane

```ts
order: [
  'engineMode',        // 1
  'spectralPartials',  // 2
  'spectralLock',      // 3
  'engineFreeze',      // 4
  'spectralResidual',  // 5
  'spectralSlice',     // 6
  // ── dock tail below the lane budget ──
  'spectralFloor', 'spectralStab', 'spectralShape', 'spectralSlew',
  'spectralCenter', 'spectralPartialCap', 'spectralSliceMode', 'spectralBandCount',
  'ws-filterbank-{n}', 'ws-feedback-{n}', 'ws-fx-{n}', 'ws-wavetable-{n}',
  'resynthLevel', 'inputMix', 'masterFiltOn', 'masterFiltCutoff',
  'masterFiltQ', 'masterFiltType', 'gain',
]
```

Each of the six has an argument that would be **wrong for a different module** (the Step-3
bar):

1. **`engineMode`** — it selects between **three different DSP classes**. No other control can
   change more. On a single-engine module this rank would be absurd.
2. **`spectralPartials`** — the module's one true macro: it sets density *and* is the CPU
   dial *and* (via `cbrt((n-1)/47)`, `SpectralResynth.cpp:904-907`) scales the residual. Three
   jobs in one knob.
3. **`spectralLock`** — decides whether the output is musical or warbly, defaults **on**
   (0.75), and self-disengages on unpitched input. It is the difference between "instrument"
   and "artefact".
4. **`engineFreeze`** — the only *performative* control on the module: press it and the
   spectrum becomes a held pad. Ranked above RESIDUAL because it is a gesture, not a setting.
5. **`spectralResidual`** — the sine/noise balance; the plugin's own header calls it the #1
   fix for the robot-vocoder character.
6. **`spectralSlice`** — the rhythmic axis, and the one control whose default (host-synced
   1/16) makes a fresh instance *sound like* Panharmonium.

Deliberately **not** in the lane: `gain` (every module has one; it earns no scarce cell),
`spectralFloor` (interacts with STABILITY — a pair, and pairs belong in a band), and the
filterbank (56 params cannot be represented by one cell honestly).

### 5.3 Proposed `pages` — 6 dock bands

```ts
pages: [
  { id: 'engine',     label: 'engine · what resynthesises',
    controls: ['engineMode', 'spectralBandCount', 'engineFreeze',
               'spectralPartials', 'spectralPartialCap'] },
  { id: 'analysis',   label: 'analysis · what gets heard',
    controls: ['spectralFloor', 'spectralStab', 'spectralLock',
               'spectralResidual', 'spectralCenter'],
    clusters: [
      { label: 'peak gate',    controls: ['spectralFloor', 'spectralStab'] },
      { label: 'harmonic',     controls: ['spectralLock', 'spectralResidual'] },
    ] },
  { id: 'motion',     label: 'motion · how fast it follows',
    controls: ['spectralSlice', 'spectralSliceMode', 'spectralSlew', 'spectralShape'] },
  { id: 'bands',      label: 'filterbank · 8 bands · everything passes here',
    controls: ['ws-filterbank-{n}', 'resynthLevel', 'inputMix'] },
  { id: 'fx',         label: 'feedback · reverb · delay',
    controls: ['ws-feedback-{n}', 'ws-fx-{n}'] },
  { id: 'out',        label: 'wavetable · master',
    controls: ['ws-wavetable-{n}', 'masterFiltOn', 'masterFiltCutoff',
               'masterFiltQ', 'masterFiltType', 'gain'] },
]
```

**The load-bearing decision: four subsystems become PANELS, not param lists.**

A `ControlFamily` renders one cell that opens a purpose-built editor. Applied to:

| family | replaces | params absorbed |
|---|---|---:|
| `ws-filterbank` | 8 bands × (cutoff, Q, type, pan, main, fx1, fx2) | **56** |
| `ws-fx` | 2 slots × (on, p0, p1, p2, mix) — `fxType` **excluded**, see §3.1 | **10** |
| `ws-wavetable` | size, spread, morph, width, mix, →fx1, →fx2 (+2 legacy bools) | **9** |
| `ws-feedback` | amount, time, cutoff, Q, type | **5** |
| | | **80** |

That is the only honest way to fit this module: **80 of 104 params never appear as individual
cells at all.** 104 − 80 = 24 discrete controls, of which 6 reach the lane and 18 fill the
dock bands — which is DX7-scale, and DX7 already works.

The filterbank panel should be a **curve editor**, not 56 knobs — the VST already ships one
(`visual/FilterCurveComponent.h`, 297 lines), and its vertical axis is the MAIN send over
0..1 with centre at 0.5 (`PluginParams.h:281-284`). Porting that interaction is a far better
use of effort than 56 dials.

**Page-id collision warning, from DX7's scar** (`dx7.ts` face comment): a page id colliding
with a curated rear group id renders that band **twice** and fails the rear-derivation
totality gate. `'engine'`, `'analysis'`, `'motion'`, `'bands'`, `'fx'`, `'out'` are chosen to
avoid `'voice'`/`'signal'`.

### 5.4 Glyph

`glyph: 'scope'` for phase 1. The obviously-right glyph is a **live spectrum with the tracked
partials marked** — which is not a supported kind, and `graph/types.ts:560-563` is explicit
that `'algorithm'` is *"NOT YET A GENERAL PRECEDENT"* and that a second topology-bearing
module should **widen the binding**, not add a third literal. So: ship `'scope'`, and if a
partial-spectrum glyph is wanted, do it as the layout-source widening that comment asks for —
in its own PR.

---

## 6. PHASING — phase 1 must SHIP and sound like the VST

**Phase 1 must not be scaffolding.** The identifiable respect in which it sounds like the VST
is: **the SLICE-stepped, harmonically-locked spectral resynth with its SMS noise residual** —
the Panharmonium character. That is one coherent instrument and it is reachable, because the
engine is already in the repo (§0.3).

### Phase 1 — the module ships (SPECTRAL only)

- New `warrensspectrum` module: def, card, worklet, docs, `STRICT_DOCS`, `rack-sizes`,
  `DESCRIPTIONS`.
- Worklet **derived from `packages/dsp/src/callsine.ts`** (do not start over), with:
  - FFT 1024 → **2048**, hop from SLICE, partial cap **256** (§4.3).
  - Frequency-sorted merge matcher replacing the linear scan (§4.3 item 2).
  - The full spectral parameter set: FLOOR, STABILITY, LOCK, RESIDUAL, SHAPE, SLEW, SLICE,
    CENTER, PARTIALS, PARTIAL CAP, FREEZE. **SMS residual is in phase 1**, not deferred — it
    is the single biggest contributor to not sounding like a robot vocoder, and shipping
    without it means phase 1 does *not* sound like the VST.
- **`RETIRED_TYPE_ALIASES` + the fixture test + the load-diagnostic UI** (§1). Migration ships
  with the thing that breaks the racks, never after it.
- Both old modules deleted, every §2 entry drained, both ratchets lowered in the same commit.
- Face: `order` + a reduced `pages` (`engine` / `analysis` / `motion` / `out`).

**Phase 1 explicitly excludes** the filterbank, feedback, FX slots, wavetable, MASSPASS,
WAVETABLE mode, and host-tempo SLICE. `engineMode` ships as SPECTRAL-only (declared, single
option) so phase 2 does not change the contract shape.

### Phase 2 — the filterbank

8-band bank + `resynthLevel` (FILTERBANK WET) + `inputMix`, plus the `ws-filterbank` curve
panel. This is where it starts sounding *stereo* — the engine is mono and pan lives here
(§3.1).

### Phase 3 — feedback, FX slots, master filter, wavetable

`ws-feedback`, `ws-fx` (Reverb + Delay, types hard-wired per §3.1), master SVF, `ws-wavetable`.

### Phase 4 — MASSPASS

Second engine, after its browser cost is actually measured (§4.3, currently UNCONFIRMED).

### Phase 5 — host-tempo SLICE + `.wspr`/fingerprint interchange

Quantum-accurate grid sync, and JSON fingerprint import/export (§3.5) so patches move between
plugin and module.

---

## 7. Naming

Module type id: **`warrensspectrum`** (one word, lowercase, no apostrophe). `label:` must be
lowercase per the repo's `lowercase-module-labels` guard: **`warren's spectrum`**.

⚠ **Do not reuse the type string `warrenspectrum`.** Reusing it would make an old
resonator-bank node load as the new module *by accident*, bypassing `RETIRED_TYPE_ALIASES`
entirely and silently reinterpreting its params. The alias table must be the only path in, so
the new id must differ. The double-s spelling is deliberate and its reason belongs in a
comment on the def.

---

## 8. TESTABILITY

### 8.1 What an ART golden looks like for a spectral engine

**Today neither module has a `.f32` baseline** (§2.3) — both ART scenarios are
assertion-based. For the new module that is not good enough: a spectral resynth has a huge
state space and a "produces non-silent output" assertion passes for an engine that is subtly
broken.

**Proposal — two tiers, deliberately:**

**(a) Byte-exact goldens for DETERMINISTIC configurations.** The engine is deterministic given
a fixed input, sample rate and params — *except* the residual noise generator, which is an
`xorshift32` seeded to a constant (`SpectralResynth.cpp:200`, `residualNoiseState_ =
0x9E3779B9u`). **Seed it identically in the port and the whole engine is byte-reproducible.**
That is what makes a golden possible at all, and it must be an explicit design constraint on
the worklet, not an accident. Pin:
- `spectral/sine-440` — a pure tone: the bank should converge to one partial. The cleanest
  possible regression signal.
- `spectral/voice-lock` — a pitched vocal clip at LOCK=0.75, RESIDUAL=0.5 (the defaults).
- `spectral/freeze-hold` — freeze mid-clip, render 2 s: asserts the hold is *steady*, which is
  where an amp-smoothing bug shows up as drift.
- `spectral/residual-only` — PARTIALS=1, RESIDUAL=2: isolates the noise bank.

Re-pin via `task art:update` (which chains `art:fingerprints:accept` — never re-pin a baseline
by another route).

**(b) Property assertions where a golden would be brittle.** SLICE and PARTIALS sweeps change
output continuously; pin *relationships*, not bytes:
- partial count monotonic in PARTIALS,
- LOCK=1 on a pitched input → detected peaks land within 25 cents of `k·F0`,
- STABILITY↑ → fewer track births per second,
- FLOOR↑ (stricter) → fewer surviving peaks.

**Each of these needs a negative control**: break the specific thing and watch that specific
assertion go red. A partial-count assertion that passes when the tracker is disabled is
measuring the harness.

### 8.2 What can never be covered

State it plainly rather than pretending:

- **"Does it sound like the VST?"** No automated test answers this. The C++ and the TS will
  never be sample-identical (different FFT implementations, different float ordering). Only
  an A/B listening session against the plugin settles it, and it should be an explicit
  owner-review gate before phase 1 merges — precedent: the `video-aspect-resolution-review-
  before-merge` and Milkdrop preview-PR rules.
- **The real-user rack fixture** (§1.4) — the loader is testable; representativeness is not.
- **CPU under real load.** The §4 numbers are node-on-M5. Worklet-thread behaviour under a
  loaded rack is only observable in the browser, and the CI runner is not a proxy for a user's
  machine in either direction.
- **Host-tempo SLICE alignment** (phase 5) — quantum-granular by construction.

### 8.3 The rest of the gate set

- `per-module-per-port` + `behavioral` + `vrt.spec` auto-enroll the new module. Run those rows
  specifically, not just the suites they live in.
- **VRT baselines**: darwin renders locally; **linux must be dispatched** —
  `gh workflow run vrt-update.yml -f ref=<branch> -f platform=linux`, **unscoped** (never
  `-f grep=`, which dies as `startup_failure`), and **verify the bot actually committed PNGs**.
  A green dispatch that committed nothing is a red flag, not a no-op.
- `task docs:accept` after the contract lands; the diff should show 79 lines removed
  (17 `callsine` + 62 `warrenspectrum`) plus the new module's lines. **State the exact delta in
  the PR.**
- `task test:ledger:accept` — regenerate, never hand-merge.
- `task typecheck` = 0 errors, full web unit lane (the CV-port registry gates only fail there).
- **Flake-check 3×** in separate processes for every new/changed test.
- **CI wall-time**: the new ART scenarios are the risk. Measure the delta; anything over
  ~2 min needs owner sign-off before merge.

---

## 9. Open questions for the owner

1. **§2.5 — four capabilities die with the old `warrenspectrum`**: the `viz_out` video bridge,
   the 8-way per-band send/return insert matrix, harmonic-partial tuning, and the ping/vactrol
   excitation model. The VST design has homes for none of them. Are any of them wanted, or do
   they go?
2. **§4.3 — the 256-partial cap.** It is 4× the VST's own default (64) and 2× its default cap
   (128), but it is not 892. Acceptable?
3. **§6 — phase 1 is SPECTRAL only.** No filterbank means no stereo and no per-band routing on
   first ship. Acceptable, or should phase 1 wait for phase 2?
4. **§3.5 — fingerprint interchange.** Worth constraining our param ids to the VST's so
   `.wspr`/JSON patches move both ways?
5. **§1.3 — grace period.** Two minor releases for `RETIRED_TYPE_ALIASES`, then removal. Right
   length?
