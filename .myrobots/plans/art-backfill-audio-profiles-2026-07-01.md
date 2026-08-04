# FEATURE SPEC — Backfill "audio profiles" (ART) for every audio module

**Status:** proposed · **Date:** 2026-07-01 · **Owner ask:** every audio module
gets ART coverage, and every *output* of every audio module is profiled where
possible. Deliver in batches.

> **TRIAGE 2026-08-04 — IN PROGRESS; §0's headline numbers are STALE.**
> The batch plan was accepted and is running. Shipped: **Phase 0 (#999** — capture
> harness + the coverage-gate ratchet + pilots**), batch 1 (#1001), batch 2
> (#1002), batch 3 (#1005), batch 4 (#1006)**, and batches 5–6 (see the ledger in
> `art/setup/profile-coverage.ts:47-59`). The ratchet has walked
> **101 → 95 → 89 → 83 → 75 → 67 → 59 → 56**; `ART_BACKLOG_MAX` in that file is
> the live number, and `art/scenarios/_meta/audio-profile-gate.test.ts` is the
> gate the owner asked for in §6b.
> **Do not read §0's numbers as current:** "48 `.f32` files / 7 covered modules"
> was true on 2026-07-01; the tree now has **136 `.f32` baselines across 57
> baseline groups**. §0's *method*, the exclusion-list reasoning and the batch
> ordering are still the working plan; only the counts moved.
> §6b (the owner's verbatim answers: "1 - gate. 2 - signature, distinct.") is the
> reason this file is kept rather than deleted.

---

## 0. Executive summary

- **Coverage headline:** **7 of 126** audio-domain module defs currently produce
  ANY committed ART baseline (an "audio profile" that shows up in the ART
  gallery). **119 modules produce ZERO ARTs.** There are **48** `.f32` baseline
  files total, all belonging to those 7 modules (`analogVco`, `cube`,
  `featurecv`, `hypercube`, `sampleHold`, `synesthesia`, `treeohvox`).
- **Uncovered outputs:** across all 126 modules there are **466 audio-family
  output ports** (cable types `audio`/`cv`/`gate`/`pitch`/`polyPitchGate`). The
  119 uncovered modules account for **408** of them (157 are the main `audio`
  signal). Even inside the 7 "covered" modules, only a handful of their 58
  audio-family ports have a dedicated per-output baseline (e.g. `synesthesia`
  has 40 audio-family outputs but 4 band baselines).
- **What an audio profile IS (product sense):** a committed raw
  `art/baselines/<group>/<name>.f32` mono/48 kHz float dump that the ART gallery
  (`art/build_gallery.py`) renders as a **waveform + log-frequency spectrogram +
  stats card** (peak dBFS, RMS dBFS, duration/samples). It is regression-pinned
  by a companion `.sha` source hash (RMS tier-B compare + SHA gate).
- **The load-bearing constraint:** `node-web-audio-api` **cannot host our custom
  `AudioWorklet`/Faust-WASM processors**, so ART renders offline from a
  **pure-TS DSP core** (extracted `packages/dsp/src/lib/<name>-dsp.ts`) or a
  **faithful TS mirror** of the `.dsp` recurrences — NOT the live worklet. Native
  Web Audio primitive nodes (`OscillatorNode`, `BiquadFilterNode`) DO work under
  `OfflineAudioContext` for verification. Therefore the real per-module effort
  is: *does a pure core exist / can it be extracted / must a mirror be written?*
- **Batch plan outline:** ~15 ordered batches of ~5–8 modules, easiest-highest-
  value first — (1) modules that ALREADY have a pure `-dsp.ts` core, (2) the Moog
  pure-core cluster, (3) self-driving sources, (4) FX driven by a shared VCO/noise
  source, (5) envelopes/modulators driven by a shared gate/clock, (6) poly/MIDI
  voices via the real poly source, then the long tail. ~13–18 modules go on an
  explicit EXCLUSION list (live mic/HID/MIDI-device/user-code/free-running games).
- **Open questions:** (a) require ≥1 audio profile per module as a CI gate, or
  keep informational? (b) capture every output or just the "signature" outputs?
  (c) accept the pure-TS-mirror rendering path as canonical, or invest in a real
  worklet-hosting offline renderer first?

---

## 1. How the ART system works today

### 1.1 Harness + tasks

- Workspace: `art/` (`@patchtogether.live/art`, `art/package.json`). Runner is
  vitest under Node with `node-web-audio-api` shimming `OfflineAudioContext`
  (`art/vitest.config.ts` — `include: ['scenarios/**/*.test.ts']`, `pool:'forks'`
  + `singleFork:true` for determinism, `$lib` alias mirrors the web package).
- Tasks (`Taskfile.yml`): `art:415` (`task art` → `npm test -w art`, deps
  `dsp:build`), `art:update:421` (`task art:update` → `UPDATE_BASELINES=1 …`,
  regenerates `.f32`+`.sha`), `art:one:427` (single scenario by path/name;
  honours `REPEAT=N` for the pre-MR 3× flake-check; deps `dsp:ensure` so a
  Faust-less worktree still runs).
- CI gate: `.github/workflows/ci.yml:234` (`art` job, ~60 s) — restores the
  `dsp-dist` artifact + LFS baselines, runs `task art`. ART is part of the
  required `typecheck + unit + ART + E2E` status check (ci.yml header).

### 1.2 The render → capture → pin flow

`art/setup/render.ts` is the shared helper library:
- `SAMPLE_RATE = 48000` (`render.ts:15`) — every offline render is mono, 48 kHz.
- `render()` (`render.ts:42`) is a **Phase-1 STUB**: it asserts the compiled
  `dist/<name>.{wasm|js}` + `.sha` exist, then returns a **synthetic 440 Hz
  sine** (`render.ts:66`) — it does NOT actually render the module. Real
  scenarios therefore do NOT use it for capture (see 1.3).
- `moduleSourceSha(name)` (`render.ts:74`) hashes `packages/dsp/src/<name>.{dsp,ts}`
  (16-hex sha256 slice, matches the build). `builtSha(name)` (`render.ts:83`)
  reads `dist/<name>.sha`.
- Baseline I/O: `readBaseline`/`writeBaseline` (`render.ts:89`/`106`) read/write
  `art/baselines/<scenario>.f32`; `readBaselineSha`/`writeBaselineSha`
  (`render.ts:113`/`120`) the companion `.sha`.
- `compareBuffers()` (`render.ts:135`) — **tier A** = bit-identical, **tier B** =
  RMS diff < 1e-4 (the default used for real audio), **tier C** = a loose
  mel-spectrogram stub (RMS×100).
- `SHOULD_UPDATE_BASELINES` (`render.ts:181`) = `UPDATE_BASELINES=1`.

**Canonical capture-and-pin pattern** (see `assertBaseline` in
`art/scenarios/analog-vco/fm-sync-model.test.ts`): compute `srcSha =
moduleSourceSha(name)`; if `UPDATE_BASELINES` or no baseline exists → write
`.f32` + write `.sha`; else **assert `existingSha === srcSha`** (forces a
re-capture when the DSP source changes) THEN `compareBuffers(rendered, baseline,
'B')`. The `.sha` is a source-hash PIN: a coefficient change in the DSP flips
the gate red and demands an intentional `task art:update`.

> **`.sha`-regenerate-LAST discipline** (repo memory `art-sha-pin-regenerate-last`
> + CLAUDE.md): the source-SHA pin hashes the worklet (and its `-dsp.ts` lib —
> see `combinedSourceSha` in `treeohvox/voice-character.test.ts`). Re-pin the
> `.sha` as the FINAL edit step and confirm only `.sha` (not `.f32`) changed for
> a pure re-pin, else CI `art` fails on a stale pin though audio is unchanged.

### 1.3 The rendering constraint (why scenarios don't use `render()`)

`node-web-audio-api` cannot instantiate our custom `AudioWorkletProcessor`s (or
the Faust-WASM worklets). Every REAL baseline scenario therefore renders through
one of three offline-safe paths:

1. **Pure-TS DSP core** the worklet wraps — e.g. `treeohvox/voice-character.test.ts`
   imports `renderVoiceSequence` from `packages/dsp/src/lib/treeohvox-dsp.ts`;
   `sample-hold/quantized-vco-steps.test.ts` imports `sampleHoldStep`/
   `quantizeVoltage` from `sample-hold-dsp.ts`. Bit-exact + SHA-pinnable.
2. **Faithful TS mirror** of the `.dsp` per-sample recurrences written inline in
   the scenario — `analog-vco/fm-sync-model.test.ts` mirrors `analog-vco.dsp`
   (with an explicit 1-sample sync-propagation delay to stay deterministic).
3. **Native Web Audio primitives under `OfflineAudioContext`** for verification
   — `sample-hold` renders `OscillatorNode`s at the quantized frequencies and
   FFT-confirms. (Primitive nodes work; only custom worklets don't.)

There is NO "drive the real module graph and snapshot every port" offline
harness today — that only exists in the E2E lane (Playwright, real browser).

### 1.4 The "audio profile" product surface (the gallery)

`art/build_gallery.py` walks `art/baselines/<scenario>/<name>.f32`, and for each
renders ONE deterministic PNG: a **waveform** (amp vs time; min/max envelope for
long signals) on top and a **log-frequency STFT spectrogram** (Hann, 3/4 overlap,
magma, −80 dB floor) below, plus a per-baseline **stats line** — `peak (dBFS) ·
rms (dBFS) · duration ms · N samples`. It emits `docs/art/index.html` grouping
cards by scenario (dark theme, mirrors the VRT gallery). Published to GitHub
Pages by `.github/workflows/art-gallery.yml` (triggers on `art/baselines/**`;
shares the single Pages site with `pages.yml`). The landing blurb: *"per-baseline
waveform + spectrogram of every ART audio baseline."*

**Consequence:** a module has a "profile" iff it has ≥1 `.f32` under
`art/baselines/`. The gallery reads `art/baselines/` ONLY — the 53 stub scenarios
(below) contribute nothing.

### 1.5 Honesty guard

`art/scenarios/_meta/baseline-uniqueness.test.ts` md5-hashes every committed
`.f32` and fails if two are byte-identical — this exists BECAUSE the old
`render()` stub returned the same 440 Hz sine for every module, producing ~11
self-comparing baselines that were deleted. Any backfill must produce genuinely
distinct captures or this guard (correctly) fails.

---

## 2. Inventory + coverage

### 2.1 Method

Enumerated the live registry by importing `listModuleDefs()`
(`packages/web/src/lib/audio/module-registry.ts:221`) after `registerAudioModules()`
(glob-driven registration, `packages/web/src/lib/audio/modules/index.ts` —
`collectAudioDefs()` keeps every exported `*Def` with `domain:'audio'` + a
`factory`). Output-port cable types per `PortDef` (`graph/types.ts:231`) and the
`StandardCableType` union (`graph/types.ts:41`). "Audio-family" = `audio`, `cv`,
`gate`, `pitch`, `polyPitchGate`. Cross-referenced against `art/baselines/**` and
the 60 `art/scenarios/*` dirs.

### 2.2 Headline numbers

| Metric | Count |
|---|---|
| Audio-domain module defs (`domain:'audio'`) | **126** |
| Modules with ≥1 committed `.f32` baseline (has an "audio profile") | **7** |
| Modules with ZERO ART baseline | **119** |
| Committed `.f32` baseline files (total) | 48 |
| `art/scenarios/*` dirs (total) | 60 |
| …that actually `writeBaseline` (produce `.f32`) | **9 files / 7 module groups** |
| …that are STUBS (SHA/artifact-existence or behavioural asserts, no `.f32`) | 53 dirs |
| Audio-family output ports (all 126 modules) | 466 |
| …on the 119 uncovered modules | **408** (157 are `audio`-typed main signal) |
| …on the 7 covered modules | 58 (only ~a dozen individually pinned) |
| Modules that render WebGL but live in the audio registry | 3 (`cube`, `hypercube`, `wavesculpt`) |

The 7 covered scenario groups + baseline counts: `analog-vco` (17), `cube` (16),
`featurecv` (4), `hypercube` (4), `synesthesia` (4), `sample-hold` (2),
`treeohvox` (1). (Scenario/baseline dirs are kebab-case; module `type` ids are
camelCase — e.g. dir `analog-vco` ↔ type `analogVco`, `sample-hold` ↔ `sampleHold`.)

### 2.3 Stub scenarios ≠ profiles

53 of the 60 scenario dirs exist but capture NO baseline — e.g. `meowbox`,
`helm`, `dx7`, `clouds`, `warps`, `veils`, `noise`, `drumseqz`, `polyseqz`,
`macrooscillator`, plus cross-cutting behavioural dirs (`cv-range-uniformity`,
`note-pitch`, `lfo-shared-clock`, `tempo-stability`, `sequencer-transport`,
`adsr-invert`, `vca-invert`). Many are "toolchain validation" — they call the
stub `render()` + assert `builtSha === moduleSourceSha` (e.g.
`meowbox/meow-c4.test.ts`). These prove the module COMPILES; they do NOT profile
its audio. They are re-authoring targets, not coverage.

---

## 3. Why the gaps exist — what each uncovered module NEEDS

Grouped by "what it takes to profile it" (`*` = a pure `-dsp.ts` core already
exists in `packages/dsp/src/lib/`, so it is near-zero-authoring; full per-module
table in Appendix A).

**A. Has an extractable/existing pure core — LOW effort (highest value first).**
Rendering path #1 is already available; the only work is a scenario that drives
the core and pins outputs.
`bluebox*`, `chowkick*`, `reverb*`(spring-reverb-dsp), `ringback*`, `resofilter*`,
`ninelives*`, `wavetableVco*`, `flipper*`, `gatemaiden*`, `moog962*`, `moog960*`,
`moog911*`, `moog911a*`, `moogCp3*`, `moog904a/b/c*`, `moog907a*`, `moog914*`,
`moog921Vco*`, `twotracks*`, `pentemelodica*`, `polyhelm*`, `helm*`, `adsr*`,
`wavesculpt*`.

**B. Self-driving SOURCE (no required input) — LOW/MED.** Generate audio from
params alone; some need a seeded PRNG (determinism, §5).
`noise` (seed RNG), `moog903a`/`moog923` (noise sources — seed RNG), `moog956`,
plus the `*` sources above (`bluebox`, `chowkick`, `wavetableVco`, `moog921Vco`).

**C. SOURCE needing a pitch/gate note — MED.** A voice; drive with a fixed
pitch/gate schedule (or the pure core's own sequence renderer).
`meowbox`, `macrooscillator` (async wavetable load), `drummergirl`, `hydrogen`
(seed sample-trigger jitter), `marbles` (seed RNG), `symbiote`, `numpadPlus`,
`elements`, `rings`, `swolevco`, `riotgirls`, `samsloop`, `dx7`, `foxy`, `wavecel`,
`qbrt`.

**D. FX / PROCESSOR — needs a DRIVING SOURCE — MED.** No audio without input;
feed a canonical VCO (or noise) test signal, capture wet output(s).
`delay`, `cocoadelay`, `charlottesEchos`, `clouds`, `cloudseed`, `shimmershine`,
`warps`, `warrenspectrum` (8 band outs), `destroy`, `callsine`, `filter`,
`resofilter*`, `reverb*`, `ringback*`, `twotracks*`, `vca`, `stereovca`, `scaler`,
`sidecar`, `veils`, `attenumix`, `mixer`, `mixmstrs`, `aquaTank`, `moog902`,
`moog905`, `moog912`, `moog921b`, `moog984`, `moog994`, `moog995`, `moog961`,
`rasterize`, `scope`, `peaks`.

**E. MODULATION / ENVELOPE — needs a GATE/TRIGGER or CLOCK source — MED.** CV/gate
outputs only; drive with a canonical gate (envelopes) or clock (sequencers).
`adsr*`, `moog911*`, `moog911a*`, `moog912`, `moog993`, `lfo` (pin phase/epoch),
`stages`, `tides2`, `buggles` (seed RNG), `cartesian`, `illogic`, `slewSwitch`,
`fourplexer`, `unityscalemathematik`, `analogLogicMaths`, `depolarizer`,
`polarizer`, `negativity`, `moog992`, `moog921a`, `moog960*`.
Clocked step sources: `sequencer`, `polyseqz`, `drumseqz`, `macseq`, `kria`,
`grids` (seed RNG), `score`, `writeseq`, `timelorde`, `atlantisCatalyst`,
`clipplayer`.

**F. POLY / MIDI note voice — needs the REAL poly source — MED/HIGH.** Per repo
memory `poly-modules-test-real-source-chain`: driving the engine class directly
passes-but-lies; the profile must be driven by a poly note schedule that mirrors
the MIDI-LANE/POLYSEQZ `polyPitchGate` source.
`dx7`, `polyhelm*`, `pentemelodica*`, `wavecel`, `numpadPlus`, plus every
`polyPitchGate`-out step source (`sequencer`, `polyseqz`, `cartesian`,
`clipplayer`, `midiLane`).

**G. Genuinely UNPROFILABLE (offline) — EXCLUDE (§4.2).** Live external input or
non-deterministic gameplay: `audioIn` (mic/getUserMedia), `gamepad`/`joystick`
(HID), `midiLane`/`midiCvBuddy`/`midiOutBuddy`/`midiclock` (live MIDIAccess),
`livecode` (user-authored runtime code), the free-running games
`pong`/`modtris`/`frogger`/`skifree`/`qbrt` (audio driven by RNG + gameplay
state), and the terminal sinks with no capturable audio-family OUTPUT port —
`audioOut`, `midiOutBuddy`, `clockedRunner`, `spectrograph` (video-only out).

---

## 4. The spec

### 4.1 Definition of an "audio profile" (precise)

For a given module output port, an **audio profile** is:

- **Captured artifact:** a raw little-endian **Float32, MONO, 48 000 Hz** PCM
  dump at `art/baselines/<group>/<scenario-variant>.f32`, plus a companion
  `<…>.sha` = `moduleSourceSha` (worklet + any `-dsp.ts` lib, per
  `combinedSourceSha`) at capture time.
- **Length:** default **0.5 s** for steady sources/FX (matches `analog-vco`,
  `DURATION_S`); **≥1.0 s** for envelope/sequence/decay-tail modules so the ADSR
  or step pattern is visible; drivers that need async loads (wavetables, FLAC/WAV
  samples) render **after** the load settles (DETERMINISM.md convention).
- **Derived in the gallery (not stored):** waveform, log-freq spectrogram, and
  **stats** (peak dBFS, RMS dBFS, duration, samples) — all computed by
  `build_gallery.py` from the `.f32`. Optional future: add spectral-centroid to
  the stats line (§7 Q).
- **Regression semantics:** RMS **tier B** (`compareBuffers(...,'B')`, < 1e-4)
  against the committed `.f32`, gated by the `.sha` source pin.

**Per-output rule:** capture **each distinct audio-family output** the module
exposes that carries independent information. Bus duplicates (`out_l`/`out_r` of a
mono-summed effect) may share one profile if provably identical; genuinely
different taps (VCO `saw`/`square`/`sine`, `env`/`env_inv`, per-band outs) each
get their own baseline. Video (`mono-video`/`video`) outputs are OUT of ART scope
(they belong to VRT/WebGL-attest).

### 4.2 Standard driving scenario per category

A profile scenario = **(driver) → (module core) → capture every output**.
Canonical drivers (reuse the existing pinned constants; do not re-derive):

| Category | Driver | Notes |
|---|---|---|
| **source** (self-driving) | none — params only | seed PRNG if RNG-based (§5) |
| **source** (voice) | fixed pitch/gate schedule, e.g. C-D-Eb-F @ 130 BPM (treeohvox precedent) | render the core's own sequence fn where present |
| **FX / processor** | canonical VCO test signal (C4 saw + sine) and/or seeded white noise, ~0.5 s | dry→wet; capture all wet taps |
| **envelope / modulator** | canonical gate: `TRIGGER_PULSE_S` / `GATE_HI` held square from `$lib/audio/gate-trigger` | ≥1 s to show attack→release |
| **clocked step source** | fixed clock (240 BPM per DETERMINISM.md) + seeded steps | epoch pinned to 0; assert stepped output |
| **poly voice** | `polyPitchGate` note schedule mirroring MIDI-LANE/POLYSEQZ | real-source-chain rule (poly memory) |
| **video-module-with-audio-out** (`cube`/`hypercube`/`synesthesia`/`wavesculpt`/`swolevco`/`foxy`/`wavecel`) | drive audio path only; capture `L`/`R`/band audio; ignore `video_out` | video handled by VRT/WebGL, hash-transparent |

### 4.3 Reusable harness / template ("drive + capture every output")

Add to `art/setup/` a small **capture helper** so a new module is a ~30-line
scenario. Two tiers, matching the existing rendering paths:

1. **`captureCore(coreModule, driver, outputs[])`** — for modules with a pure
   `-dsp.ts` core (path #1). Given a per-block/per-sample core step fn, a driver
   (source/gate/clock/poly schedule from a shared `art/setup/drivers.ts`), and
   the list of output taps, it renders N samples, returns a `Record<outputId,
   Float32Array>`, and a `pinAll(group, srcSha, buffers)` writes/asserts every
   output via the `assertBaseline` pattern (lifted out of `analog-vco` into
   `art/setup`). This is the low-effort common case.
2. **`captureOffline(buildGraph)`** — for modules verifiable with native Web
   Audio primitives (path #3), wrapping `OfflineAudioContext` render.

`art/setup/drivers.ts`: shared canonical drivers — `vcoTestSignal()`,
`seededNoise(seed)`, `gateTrain(bpm, pulse)`, `clock(bpm)`, `polySchedule(notes)`
— each pure + deterministic, pinning epoch/phase/PRNG-seed.

**Minimal per-module authoring** then becomes:
```ts
// art/scenarios/<name>/profile.test.ts
import { captureCore, pinAll, srcSha } from '../../setup/capture';
import { drive } from '../../setup/drivers';
import { <core> } from '../../../packages/dsp/src/lib/<name>-dsp';
it('profiles every output', async () => {
  const bufs = captureCore(<core>, drive.vco(), ['out', 'aux']);
  await pinAll('<name>', await srcSha('<name>'), bufs);      // writes .f32 + .sha
});
```
Optionally add a **registry-driven sweep** (mirroring the per-module-per-port
E2E pattern) that asserts every non-excluded `AudioModuleDef` has ≥1 baseline
group — turning "add a module" into "add a profile or add to the exclusion
list", a self-enforcing ratchet like the living-docs `STRICT_DOCS` set.

### 4.4 Coverage target + exclusion list

**Target:** every audio-domain module NOT on the exclusion list has ≥1 audio
profile, and every independent audio-family output is captured. Realistic scope:
**~108 of 126** modules profilable (126 − 18 excluded), covering **~380+** of the
408 currently-uncovered audio-family output ports.

**Exclusion list (18) — cannot be deterministically profiled offline:**

| Module | Why excluded |
|---|---|
| `audioIn` | live `getUserMedia` mic; no offline signal (output is pass-through of external) |
| `gamepad`, `joystick` | HID controller CV; no deterministic input |
| `midiLane`, `midiCvBuddy`, `midiOutBuddy`, `midiclock` | live MIDIAccess device stream |
| `livecode` | user-authored code evaluated at runtime; no fixed output |
| `pong`, `modtris`, `frogger`, `skifree`, `qbrt` | free-running game audio driven by RNG + gameplay state (see DETERMINISM.md free-running list) |
| `audioOut`, `midiOutBuddy` | terminal sink — no audio-family OUTPUT port to capture |
| `clockedRunner` | utility, no audio output |
| `spectrograph` | video-only outputs (analysis sink) |

*Conditional/stretch:* the games could get a **seeded, scripted** capture (fixed
input tape + `CHAOS_SEED`-style replay) if the owner wants game bleeps profiled;
`audioIn`/MIDI modules could get a **synthetic-input pass-through** profile that
tests only their scaling, not a "real" source. Both are explicitly deferred.

### 4.5 Batch plan (ordered; ~5–8 modules each)

Easiest-highest-value first. "Effort" is rough per-batch author+flake-check time.

| # | Theme | Modules (~) | Path | Effort |
|---|---|---|---|---|
| **1** | **Pure-core sources/FX (already extractable)** | `bluebox`, `chowkick`, `wavetableVco`, `reverb`, `ringback`, `resofilter`, `twotracks` | #1 core | **S** (½ day) |
| 2 | Moog filter/util pure cores | `moog904a`, `moog904b`, `moog904c`, `moog907a`, `moog914`, `moogCp3`, `moog962` | #1 core | S–M |
| 3 | Moog VCO + envelope pure cores | `moog921Vco`, `moog911`, `moog911a`, `moog960`, `adsr`, `ninelives`, `gatemaiden`, `flipper` | #1 core | M |
| 4 | Self-driving primitive sources | `noise`, `moog903a`, `moog923`, `moog956`, `moog921b`, `moog905`, `moog902` | #2 mirror | M (seed RNG) |
| 5 | Utility CV/logic math | `analogLogicMaths`, `illogic`, `depolarizer`, `polarizer`, `negativity`, `unityscalemathematik`, `fourplexer`, `slewSwitch` | #2/#3 | S–M |
| 6 | Mix/VCA/attenuator FX | `vca`, `stereovca`, `scaler`, `attenumix`, `mixer`, `mixmstrs`, `veils`, `moog984`/`994`/`995` | #3 offline | M (needs VCO driver) |
| 7 | Time-domain FX (delay/reverb family) | `delay`, `cocoadelay`, `charlottesEchos`, `clouds`, `cloudseed`, `shimmershine`, `warps` | #1/#2 | M |
| 8 | Spectral / destructive FX | `destroy`, `callsine`, `filter`, `warrenspectrum`(8 bands), `sidecar`, `peaks`, `rasterize`, `scope` | #1/#3 | M |
| 9 | Voice sources (mono) | `meowbox`, `elements`, `rings`, `swolevco`, `samsloop`, `foxy`, `wavecel` | #1/#2 | M |
| 10 | Drum/sample voices (seeded) | `drummergirl`, `hydrogen`, `riotgirls`, `macrooscillator`, `symbiote`, `marbles` | #1/#2 | M (async loads + RNG seed) |
| 11 | Envelopes / function gens | `moog912`, `moog993`, `stages`, `tides2`, `lfo`, `moog921a`, `moog992` | #3 gate | M (gate driver) |
| 12 | Modulation utilities | `buggles`, `cartesian`, `atlantisCatalyst` (seed), `featurecv`(extend), `moog961` | #2/#3 | M |
| 13 | Clocked step sequencers | `sequencer`, `polyseqz`, `drumseqz`, `macseq`, `kria`, `grids`(seed), `score`, `writeseq` | #3 clock | M–L (clock+epoch pin) |
| 14 | Poly voices (real source chain) | `dx7`, `polyhelm`, `pentemelodica`, `wavecel`, `numpadPlus` | #1 + poly | **L** (real poly source) |
| 15 | WebGL-audio + big multi-out | `cube`(extend), `hypercube`(extend), `wavesculpt`, `synesthesia`(extend to all bands), `timelorde` | #1 core | M (hash-transparent audio path) |

(Batches 1–3 are the "first batch" cluster: all path-#1, already-extracted cores,
maximum profiles for minimum authoring. Modules with `*` cores in §3 concentrate
here.) Total ≈ 15 batches; the 7 covered modules get *extended* (more outputs) in
batches 12/15 rather than re-created.

### 4.6 Determinism + source-SHA discipline (folded into delivery)

Every batch PR follows the repo test discipline:
- **Seed all non-determinism.** Inject a fixed PRNG for `noise`/`buggles`/
  `drummergirl`/`hydrogen`/`marbles`/`grids`/`moog903a`/`moog923`; pin
  `epoch=0`/`phase=0` for `lfo` + clocked sources (DETERMINISM.md "Random seed"
  row currently says *None pinned* — the offline profiles MUST pin it; add a row
  to the matrix per batch). Prefer the `analog-vco` explicit-1-sample-delay
  technique for any feedback/mutual loop.
- **`.sha` regenerate LAST.** Author the scenario → run `task art:update` →
  confirm `git diff` shows the intended `.f32` change → re-pin `.sha` as the
  final step → confirm ONLY `.sha` changed on a pure re-pin.
- **Flake-check 3×** the new scenario before the MR:
  `REPEAT=3 flox activate -- task art:one -- <name>` (bails on first failure).
- **Uniqueness guard** (`_meta/baseline-uniqueness.test.ts`) must stay green —
  distinct captures only, never a placeholder.
- **Merge only on the final commit's green `art` job**; a red `art` on main is a
  P0, never absorbed as flake.
- **LFS + gallery:** `.f32` are LFS-tracked (`art/baselines/**`); the merge to
  main triggers `art-gallery.yml` to re-render `docs/art/`. Estimate CI delta:
  each batch adds ~seconds to the `art` job (offline renders are fast); flag if a
  batch pushes the ~60 s `art` job past ~2 min (CLAUDE.md >2 min rule).

---

## 5. Risks / notes

- **Rendering-path debt.** Path #2 (hand-written TS mirror) is labor + drift
  risk: the mirror can silently diverge from the `.dsp`. The `.sha` pin catches
  *source* changes but not a mirror that was wrong from day one. Prefer
  extracting a real `-dsp.ts` core (path #1) — this doubles as unit-testable DSP
  and matches the extracted-core campaign (#944/#945). Recommend: **when a module
  needs a mirror, extract a core instead** and land it in the same PR.
- **Faust-only modules.** 12 `.dsp` files vs 73 TS worklets in `packages/dsp/src`.
  Faust modules with no TS core need either a mirror or a `faustwasm`-node offline
  host (does not exist yet — see §7 Q3).
- **Multi-out explosion.** `synesthesia` (40 af-outs), `clipplayer` (24),
  `gamepad` (18), `timelorde` (13) — capturing *every* port is a lot of `.f32`.
  Apply the "independent information only" rule (4.1) to avoid 40 near-identical
  band dumps; profile a representative subset + assert the rest structurally.
- **The `render()` stub.** Either finish it into a real offline host or delete it
  and standardize on `art/setup/capture.ts`; leaving a 440 Hz-sine `render()` in
  the shared helper invites new stub scenarios (the exact thing the uniqueness
  guard polices).

---

## 6. Open questions for the owner

1. **Gate or informational?** Should "≥1 audio profile per non-excluded module"
   become a **required** registry-sweep CI check (like living-docs `STRICT_DOCS`
   / per-module-per-port), or stay informational until the backfill completes?
2. **Every output, or signature outputs?** Capture *every* independent
   audio-family output (408 ports), or a curated "signature" set per module
   (main + notably-distinct taps)? Affects `.f32` count + LFS size materially.
3. **Rendering path.** Accept the pure-TS-core / TS-mirror path as canonical
   (fast, but requires a core per module), or invest first in a real
   worklet-hosting offline renderer (`@grame/faustwasm` in Node + a custom-worklet
   host) so ART renders the ACTUAL shipped DSP? The latter is a bigger up-front
   build but removes mirror-drift risk permanently.
4. **Games + live-input.** Leave `pong`/`modtris`/`frogger`/`skifree`/`qbrt` +
   `audioIn`/MIDI on the exclusion list, or invest in seeded scripted-input /
   synthetic-input profiles for them (stretch)?
5. **Stats surface.** Add spectral-centroid (and maybe a spectral-flatness /
   crest factor) to the gallery stats line, per the "profile" framing, or keep
   peak/RMS/duration only?
6. **Batch cadence + ownership.** Agent-fan-out batches of 5–8 (like the
   living-docs rollout), or owner-reviewed one batch at a time? Any modules to
   prioritize out of order (e.g. the ones most prone to silent DSP regressions)?

## 6b. OWNER DECISIONS (2026-07-01, verbatim: "1 - gate. 2 - signature, distinct.
## 3 - ts-pure for now 4 - exclusion list 5 - yes add 6 - agent fan")

1. **GATE.** "≥1 audio profile per non-excluded module" becomes a REQUIRED
   registry-sweep unit check. Implemented as a RATCHET so CI stays green during
   the backfill: new modules required immediately; the current backlog lives in
   an explicit `ART_BACKLOG` exclusion list that each batch SHRINKS (like the
   behavioral quarantine caps — the list only ever gets shorter, enforced).
2. **SIGNATURE outputs** — profile the DISTINCT outs per module (main outs +
   genuinely different taps), not all 408 ports (no 8× identical clipplayer lanes).
3. **TS-pure cores** are the canonical render path for now; the worklet-hosting
   offline renderer is a separate future infra project.
4. **Exclusion list stands** (games/HID/MIDI-device/live-input/sinks, ~18).
5. **Gallery stats:** ADD spectral-centroid + crest factor (+ flatness) to the
   stats card alongside peak/RMS/duration.
6. **Agent fan-out** batches of 5–8, adversarially reviewed per batch; sources +
   filters with existing pure cores go first.

---

## Appendix A — full per-module coverage table

`af_out` = audio-family output ports · `baseline` = has a committed `.f32` ·
`core` = a pure `-dsp.ts` core exists in `packages/dsp/src/lib/`.

```
adsr                 modulation   af_out=2  baseline=none     core  env, env_inv (cv)
analogLogicMaths     utilities    af_out=5  baseline=none     -     min/max/diff/sum/product (cv)
analogVco            sources      af_out=6  baseline=COVERED  -     saw/square/triangle/sine/morph/sync (audio)
aquaTank             effects      af_out=6  baseline=none     -     out1-4/mix_l/mix_r (audio)
atlantisCatalyst     modulation   af_out=10 baseline=none     -     drift1-8 (cv), scene_pulse (gate), scene_idx (cv)
attenumix            utilities    af_out=5  baseline=none     -     out1-4/mix (audio)
audioIn              sources      af_out=2  baseline=none     -     audio_l_out/audio_r_out  [EXCLUDE: mic]
audioOut             output       af_out=0  baseline=none     -     (no output)  [EXCLUDE: sink]
bluebox              sources      af_out=1  baseline=none     core  out (audio)
buggles              modulation   af_out=5  baseline=none     -     smooth/stepped (cv), clock/burst (gate), ring (audio)  [seed RNG]
callsine             effects      af_out=1  baseline=none     -     out (audio)
cartesian            modulation   af_out=5  baseline=none     -     pitch (poly), gate/clock (gate), lfo_x/lfo_y (cv)
charlottesEchos      effects      af_out=2  baseline=none     -     L/R (audio)
chowkick             sources      af_out=1  baseline=none     core  audio_out (audio)
clipplayer           modulation   af_out=24 baseline=none     -     8× (pitch/gate/vel)  [big multi-out]
clockedRunner        utilities    af_out=0  baseline=none     -     (no output)  [EXCLUDE]
clouds               effects      af_out=2  baseline=none     -     out_l/out_r (audio)
cloudseed            effects      af_out=2  baseline=none     -     out_l/out_r (audio)
cocoadelay           effects      af_out=2  baseline=none     -     outL/outR (audio)
cube                 sources      af_out=3  baseline=COVERED  core  L/R/sync (audio) + video_out
delay                effects      af_out=1  baseline=none     -     audio
depolarizer          utilities    af_out=1  baseline=none     -     out (cv)
destroy              effects      af_out=1  baseline=none     -     audio
drummergirl          sources      af_out=1  baseline=none     -     audio  [seed RNG]
drumseqz             modulation   af_out=9  baseline=none     -     4× (gate/pitch) + clock
dx7                  sources      af_out=1  baseline=none     -     out (audio)  [poly source]
elements             sources      af_out=2  baseline=none     -     main/aux (audio)
featurecv            modulation   af_out=4  baseline=COVERED  core  loud/bright/punch (cv), onset (gate)
filter               filters      af_out=1  baseline=none     -     audio
flipper              utilities    af_out=2  baseline=none     core  flip/flop (gate)
fourplexer           utility      af_out=4  baseline=none     -     out1-4 (cv)
foxy                 sources      af_out=2  baseline=none     -     out_l/out_r (audio) + scope/wave3d/combined video
frogger              games        af_out=3  baseline=none     -     home/dead/level_gate  [EXCLUDE: game]
gamepad              utility      af_out=18 baseline=none     -     sticks/triggers/buttons  [EXCLUDE: HID]
gatemaiden           utility      af_out=2  baseline=none     core  gate/trig (gate)
grids                modulation   af_out=5  baseline=none     -     bd/sd/hh/accent/clock (gate)  [seed RNG]
helm                 sources      af_out=2  baseline=none     core  out_l/out_r (audio)  [poly]
hydrogen             sources      af_out=2  baseline=none     -     out_l/out_r (audio)  [seed RNG + async samples]
hypercube            sources      af_out=2  baseline=COVERED  -     L/R (audio) + video_out
illogic              utilities    af_out=10 baseline=none     -     att1-4/sum/diff (cv), and/nand/or/not (gate)
joystick             utility      af_out=4  baseline=none     -     x/y/nx/ny (cv)  [EXCLUDE: HID]
kria                 modulation   af_out=8  baseline=none     -     4× (pitch/gate)
lfo                  modulation   af_out=4  baseline=none     -     phase0/90/180/270 (cv)  [pin phase/epoch]
livecode             utilities    af_out=0  baseline=none     -     (no output)  [EXCLUDE: user code]
macrooscillator      sources      af_out=2  baseline=none     -     out/aux (audio)  [async WT loads]
macseq               modulation   af_out=4  baseline=none     -     pitch/modelcv/clock/gate
marbles              sources      af_out=6  baseline=none     -     t1/t2/clk (gate), x1-3 (cv)  [seed RNG]
meowbox              sources      af_out=2  baseline=none     -     L/R (audio)  [stub scenario exists]
midiCvBuddy          sources      af_out=3  baseline=none     -     pitch_cv/velocity_cv (cv), gate  [EXCLUDE: MIDI]
midiLane             sources      af_out=7  baseline=none     -     pitch/vel/cc_a/cc_b (cv), gate/note_gate, poly  [EXCLUDE: MIDI]
midiOutBuddy         output       af_out=0  baseline=none     -     (no output)  [EXCLUDE]
midiclock            sources      af_out=4  baseline=none     -     clock/midistart/midistop (gate), run (cv)  [EXCLUDE: MIDI]
mixer                utilities    af_out=1  baseline=none     -     audio
mixmstrs             utilities    af_out=6  baseline=none     -     masterL/R, send1L/R, send2L/R (audio)
modtris              games        af_out=2  baseline=none     -     line_cleared/overfill (gate)  [EXCLUDE: game]
moog902              utilities    af_out=2  baseline=none     -     audio/audio_inv
moog903a             sources      af_out=2  baseline=none     -     white/pink (audio)  [seed RNG]
moog904a             filters      af_out=1  baseline=none     core  audio
moog904b             filters      af_out=1  baseline=none     core  audio
moog904c             filters      af_out=1  baseline=none     core  audio
moog905              processors   af_out=1  baseline=none     -     audio
moog907a             filters      af_out=1  baseline=none     core  audio
moog911              modulation   af_out=2  baseline=none     core  env/env_inv (cv)
moog911a             modulation   af_out=2  baseline=none     core  out1/out2 (gate)
moog912              modulation   af_out=2  baseline=none     -     env (cv), gate
moog914              filters      af_out=1  baseline=none     core  audio
moog921Vco           sources      af_out=4  baseline=none     core  sine/triangle/sawtooth/rectangular (audio)
moog921a             modulation   af_out=2  baseline=none     -     freq_bus/width_bus (cv)
moog921b             sources      af_out=4  baseline=none     -     sine/triangle/saw/rect (audio)
moog923              filter       af_out=4  baseline=none     -     white/pink/lp/hp (audio)  [seed RNG]
moog956              utility      af_out=2  baseline=none     -     pitch/gate
moog960              modulation   af_out=4  baseline=none     core  row1-3 (cv), clock_out (gate)
moog961              utilities    af_out=4  baseline=none     -     v_out1/2, s_out_a/b (gate)
moog962              utilities    af_out=1  baseline=none     core  out (cv)
moog984              utilities    af_out=4  baseline=none     -     out1-4 (audio)
moog992              modulation   af_out=1  baseline=none     -     cv_out (cv)
moog993              modulation   af_out=5  baseline=none     -     trig_out1-3 (gate), env_out1/2 (cv)
moog994              utilities    af_out=6  baseline=none     -     a1-3/b1-3 (audio)
moog995              utilities    af_out=3  baseline=none     -     out1-3 (audio)
moogCp3              utilities    af_out=7  baseline=none     core  out_pos/neg, multiple_1-3 (audio), +12/-6 (cv)
negativity           utilities    af_out=1  baseline=none     -     out (cv)
ninelives            modulation   af_out=9  baseline=none     core  out1-9 (cv)
noise                sources      af_out=3  baseline=none     -     white/pink/brown (audio)  [seed RNG]
numpadPlus           sources      af_out=9  baseline=none     -     4× (pitch/gate) + poly  [poly]
peaks                modulation   af_out=2  baseline=none     -     out0/out1 (audio)
pentemelodica        sources      af_out=7  baseline=none     core  out_l/r + voice1-5 (audio)  [poly]
polarizer            utilities    af_out=1  baseline=none     -     out (cv)
polyhelm             sources      af_out=2  baseline=none     core  out_l/out_r (audio)  [poly, real-source memory]
polyseqz             modulation   af_out=3  baseline=none     -     poly, gate/clock
pong                 games        af_out=2  baseline=none     -     score_left/right (gate)  [EXCLUDE: game]
qbrt                 filters      af_out=2  baseline=none     -     L/R (audio)  [game-ish]
rasterize            utilities    af_out=1  baseline=none     -     thru (audio) + out video
resofilter           processors   af_out=2  baseline=none     core  out_l/out_r (audio)
reverb               effects      af_out=1  baseline=none     core  audio  (spring-reverb-dsp)
ringback             effects      af_out=2  baseline=none     core  out_l/out_r (audio)
rings                sources      af_out=2  baseline=none     -     odd/even (audio)
riotgirls            sources      af_out=2  baseline=none     -     outL/outR (audio)
sampleHold           utility      af_out=2  baseline=COVERED  core  cv_out/cv_quant (cv)
samsloop             sources      af_out=1  baseline=none     -     out (audio)
scaler               utilities    af_out=1  baseline=none     -     out (audio)
scope                utilities    af_out=2  baseline=none     -     ch1_out/ch2_out (audio) + out video
score                modulation   af_out=4  baseline=none     -     pitch/gate/env/clock
sequencer            modulation   af_out=3  baseline=none     -     pitch (poly), gate/clock
shimmershine         effects      af_out=2  baseline=none     -     out_l/out_r (audio)
sidecar              processors   af_out=4  baseline=none     -     audio_l/r (audio), env/env_inv (cv)
skifree              games        af_out=1  baseline=none     -     gate + out video  [EXCLUDE: game]
slewSwitch           utility      af_out=7  baseline=none     -     out1-4/switched/step_idx (cv), eoc (gate)
spectrograph         hybrid       af_out=0  baseline=none     -     color/bw (video only)  [EXCLUDE: sink]
stages               modulation   af_out=6  baseline=none     -     out0-5 (cv)
stereovca            utilities    af_out=2  baseline=none     -     out_l/out_r (audio)
swolevco             sources      af_out=3  baseline=none     -     out/mod_out/sum_out (audio) + scope video
symbiote             sources      af_out=7  baseline=none     -     t1-3/x1/x3/y (gate), x2 (cv)
synesthesia          hybrid       af_out=40 baseline=COVERED  core  2 sides × 4 bands × (audio/env×2/gate/trig)  [extend]
tides2               modulation   af_out=4  baseline=none     -     out0-3 (cv)
timelorde            modulation   af_out=13 baseline=none     -     clock multiples + swing (gate) + video
treeohvox            sources      af_out=1  baseline=COVERED  core  audio_out (audio)
twotracks            effects      af_out=2  baseline=none     core  out_l/out_r (audio)
unityscalemathematik utilities    af_out=3  baseline=none     -     u_out/a_out/b_out (cv)
vca                  utilities    af_out=2  baseline=none     -     audio/audio_inv
veils                utilities    af_out=5  baseline=none     -     out1-4/mix (audio)
warps                effects      af_out=1  baseline=none     -     out (audio)
warrenspectrum       effects      af_out=10 baseline=none     -     out_l/r + 8 band outs (audio)
wavecel              sources      af_out=2  baseline=none     -     out_l/out_r (audio) + scope/wave3d video  [poly]
wavesculpt           sources      af_out=6  baseline=none     core  L/R + out_red/grn/blu/alp (audio) + video
wavetableVco         sources      af_out=1  baseline=none     core  audio
writeseq             modulation   af_out=3  baseline=none     -     pitch/gate/clock
```

## Appendix B — key source references

- Harness/tasks: `Taskfile.yml:415/421/427`; CI gate `.github/workflows/ci.yml:234`.
- Render + pin helpers: `art/setup/render.ts` (`:15` SR, `:42/66` stub `render()`,
  `:74` `moduleSourceSha`, `:83` `builtSha`, `:89/106` baseline I/O, `:113/120`
  `.sha` I/O, `:135` `compareBuffers` tiers A/B/C, `:181` `UPDATE_BASELINES`).
- Capture-and-pin pattern: `art/scenarios/analog-vco/fm-sync-model.test.ts`
  (`assertBaseline`); pure-core render: `art/scenarios/treeohvox/voice-character.test.ts`
  (`combinedSourceSha`, `renderVoiceSequence`); offline-primitive render:
  `art/scenarios/sample-hold/quantized-vco-steps.test.ts`.
- Gallery: `art/build_gallery.py` (waveform+spectrogram+stats); deploy
  `.github/workflows/art-gallery.yml`; landing blurb in the same workflow.
- Honesty guard: `art/scenarios/_meta/baseline-uniqueness.test.ts`.
- Determinism matrix: `art/DETERMINISM.md`.
- Registry/model: `packages/web/src/lib/audio/module-registry.ts:58/221`;
  glob registration `packages/web/src/lib/audio/modules/index.ts`;
  `PortDef`/`CableType`/`Domain` `packages/web/src/lib/graph/types.ts:231/41/14`.
- Pure cores available: `packages/dsp/src/lib/*-dsp.ts` (+ `*-engine.ts`,
  `*-core.ts`) — 30+ files incl. bluebox/chowkick/resofilter/reverb/ringback/
  twotracks/moog-*/treeohvox/synesthesia/sample-hold/featurecv/cube/wavesculpt.
- Relevant memories: `art-sha-pin-regenerate-last`, `poly-modules-test-real-source-chain`,
  `flake-check-3x-standard`, `project_resume_2026-06-28` (extracted-core campaign #944/#945).
