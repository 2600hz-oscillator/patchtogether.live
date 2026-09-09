# FEATURE SPEC — Backfill "audio profiles" (ART) for every audio module

**Date:** 2026-07-01 · **Owner ask:** every audio module gets ART coverage, and
every *output* of every audio module is profiled where possible. Deliver in
batches.

> **TRIAGE 2026-08-12 — the backfill is RUNNING; batches 7–15 are the remainder.**
> Phase 0 (capture harness + the coverage gate) and batches 1–6 shipped. Measured
> on this tree: **134 `.f32` baselines across 56 baseline groups**, and
> `art/setup/profile-coverage.ts` still lists **44** unprofiled modules in
> `ART_BACKLOG`. The live inventory is that file — read it, do not re-count from
> prose here.
>
> ⚠ **`ART_BACKLOG_MAX` (`profile-coverage.ts:120`) is exactly the hand-typed
> population count that was killed repo-wide** (CLAUDE.md, "NEVER hand-type a
> population count", owner P0 2026-08-10). It is legacy, not precedent: it is a
> boy-scout removal target for whoever next touches that file, and §6b's
> "self-enforcing ratchet like `STRICT_DOCS`" framing is **against repo standard**
> now. The *deliverable* — a profile per non-excluded module — is alive and
> unaffected; only the enforcement shape is wrong. Replace it with a derived
> assertion over the registry, never a successor counter.

---

## 1. How the ART system works today

### 1.1 Harness + tasks

- Workspace: `art/` (`@patchtogether.live/art`). Runner is vitest under Node with
  `node-web-audio-api` shimming `OfflineAudioContext` (`art/vitest.config.ts` —
  `pool:'forks'` + `singleFork:true` for determinism).
- Tasks: `task art`, `task art:update` (regenerates `.f32`+`.sha`, and now chains
  `art:fingerprints:accept`), `task art:one` (single scenario; honours `REPEAT=N`).
- CI gate: the `art` job in `.github/workflows/ci.yml`, part of the required
  `typecheck + unit + ART + E2E` status check.

### 1.2 The render → capture → pin flow

`art/setup/render.ts` is the shared helper library: `SAMPLE_RATE = 48000` (mono),
`moduleSourceSha(name)` (16-hex sha256 slice of the DSP source), `builtSha(name)`,
baseline/`.sha` I/O, and `compareBuffers()` — **tier A** bit-identical, **tier B**
RMS diff < 1e-4 (the default for real audio), **tier C** a loose mel stub.

**Canonical capture-and-pin pattern** (`assertBaseline` in
`art/scenarios/analog-vco/fm-sync-model.test.ts`): compute `srcSha =
moduleSourceSha(name)`; if `UPDATE_BASELINES` or no baseline exists → write `.f32`
+ `.sha`; else **assert `existingSha === srcSha`** (forces a re-capture when the
DSP source changes) THEN `compareBuffers(rendered, baseline, 'B')`. The `.sha` is a
source-hash PIN: a coefficient change flips the gate red and demands an intentional
`task art:update`.

### 1.3 THE LOAD-BEARING CONSTRAINT (why scenarios don't use `render()`)

`node-web-audio-api` **cannot instantiate our custom `AudioWorkletProcessor`s** or
the Faust-WASM worklets. Every REAL baseline scenario therefore renders through one
of three offline-safe paths:

1. **Pure-TS DSP core** the worklet wraps — e.g. `treeohvox/voice-character.test.ts`
   imports `renderVoiceSequence` from `packages/dsp/src/lib/treeohvox-dsp.ts`.
   Bit-exact + SHA-pinnable.
2. **Faithful TS mirror** of the `.dsp` per-sample recurrences written inline in the
   scenario — `analog-vco/fm-sync-model.test.ts` mirrors `analog-vco.dsp` (with an
   explicit 1-sample sync-propagation delay to stay deterministic).
3. **Native Web Audio primitives under `OfflineAudioContext`** for verification —
   `OscillatorNode`/`BiquadFilterNode` DO work; only custom worklets don't.

So the real per-module effort is always: *does a pure core exist / can it be
extracted / must a mirror be written?* There is NO "drive the real module graph and
snapshot every port" offline harness — that only exists in the E2E lane.

(#1376 later added `art/setup/faust-offline.ts`, which renders a real Faust wasm
headlessly in Node. That is a fourth path for Faust modules and it is what
invalidated the "no faithful automated gate exists for the shipped wasm" objection
— see the A3 block in `dsp-stack-bass-freq-audit-2026-07-01.md`.)

### 1.4 The "audio profile" product surface (the gallery)

`art/build_gallery.py` walks `art/baselines/<scenario>/<name>.f32` and renders ONE
deterministic PNG per baseline: a **waveform** on top and a **log-frequency STFT
spectrogram** (Hann, 3/4 overlap, magma, −80 dB floor) below, plus a **stats line**
— `peak (dBFS) · rms (dBFS) · duration ms · N samples`. Emitted to
`docs/art/index.html`, published by `.github/workflows/art-gallery.yml`.

**Consequence:** a module has a "profile" iff it has ≥1 `.f32` under
`art/baselines/`. Stub scenarios (SHA/artifact-existence asserts, no `.f32`)
contribute nothing to the gallery and are re-authoring targets, not coverage.

### 1.5 Honesty guard

`art/scenarios/_meta/baseline-uniqueness.test.ts` md5-hashes every committed `.f32`
and fails if two are byte-identical. It exists BECAUSE the old `render()` stub
returned the same 440 Hz sine for every module, producing ~11 self-comparing
baselines that were deleted.

⚠ **THE STUB IS STILL THERE, AND THE GUARD ONLY POLICES ITS SYMPTOM.**
`art/setup/render.ts:66-68` still returns
`Math.sin(2π·440·i/sr) * 0.1` with the comment *"Deterministic placeholder: 440 Hz
sine. Replaced when real render lands."* Leaving a 440 Hz-sine `render()` in the
shared helper invites new stub scenarios — the exact thing the md5 guard exists to
catch *after the fact*. **Either finish it into a real offline host or delete it
and standardise on `art/setup/capture.ts`.** This is the one genuine source defect
left in the harness.

---

## 2. The spec

### 2.1 Definition of an "audio profile" (precise)

For a given module output port, an **audio profile** is:

- **Captured artifact:** a raw little-endian **Float32, MONO, 48 000 Hz** PCM dump
  at `art/baselines/<group>/<scenario-variant>.f32`, plus a companion `<…>.sha` =
  `moduleSourceSha` (worklet + any `-dsp.ts` lib, per `combinedSourceSha`).
- **Length:** default **0.5 s** for steady sources/FX; **≥1.0 s** for
  envelope/sequence/decay-tail modules so the ADSR or step pattern is visible;
  drivers that need async loads (wavetables, FLAC/WAV samples) render **after** the
  load settles.
- **Derived in the gallery (not stored):** waveform, log-freq spectrogram, stats.
- **Regression semantics:** RMS **tier B** against the committed `.f32`, gated by
  the `.sha` source pin.

**Per-output rule:** capture **each distinct audio-family output** that carries
independent information. Bus duplicates (`out_l`/`out_r` of a mono-summed effect)
may share one profile if provably identical; genuinely different taps (VCO
`saw`/`square`/`sine`, `env`/`env_inv`, per-band outs) each get their own baseline.
Video outputs are OUT of ART scope (VRT/WebGL-attest owns those).

### 2.2 Standard driving scenario per category

A profile scenario = **(driver) → (module core) → capture every output**. Reuse the
existing pinned constants; do not re-derive.

| Category | Driver | Notes |
|---|---|---|
| **source** (self-driving) | none — params only | seed PRNG if RNG-based |
| **source** (voice) | fixed pitch/gate schedule, e.g. C-D-Eb-F @ 130 BPM (treeohvox precedent) | render the core's own sequence fn where present |
| **FX / processor** | canonical VCO test signal (C4 saw + sine) and/or seeded white noise, ~0.5 s | dry→wet; capture all wet taps |
| **envelope / modulator** | canonical gate: `TRIGGER_PULSE_S` / `GATE_HI` held square from `$lib/audio/gate-trigger` | ≥1 s to show attack→release |
| **clocked step source** | fixed clock (240 BPM per DETERMINISM.md) + seeded steps | epoch pinned to 0; assert stepped output |
| **poly voice** | `polyPitchGate` note schedule mirroring MIDI-LANE/POLYSEQZ | real-source-chain rule (poly memory) |
| **video-module-with-audio-out** (`cube`/`synesthesia`/`wavesculpt`/`swolevco`/`foxy`/`wavecel`) | drive audio path only; capture `L`/`R`/band audio; ignore `video_out` | video handled by VRT/WebGL |

The shared harness this table assumes now exists: `art/setup/capture.ts` and
`art/setup/drivers.ts` (plus `clip-driver.ts`, `offline.ts`, `faust-offline.ts`).

### 2.3 Coverage target + exclusion list

**Target:** every audio-domain module NOT on the exclusion list has ≥1 audio
profile, and every independent audio-family output is captured.

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

*Conditional/stretch, both **explicitly deferred**:* the games could get a
**seeded, scripted** capture (fixed input tape + `CHAOS_SEED`-style replay) if the
owner wants game bleeps profiled; `audioIn`/MIDI modules could get a
**synthetic-input pass-through** profile that tests only their scaling, not a
"real" source.

### 2.4 Remaining batches (7–15)

Batches 1–6 shipped. What is left, easiest-highest-value first:

| # | Theme | Modules (~) | Path | Effort |
|---|---|---|---|---|
| 7 | Time-domain FX (delay/reverb family) | `delay`, `charlottesEchos`, `clouds`, `cloudseed`, `shimmershine`, `warps` | #1/#2 | M |
| 8 | Spectral / destructive FX | `destroy`, `callsine`, `filter`, `warrenspectrum`(8 bands), `sidecar`, `peaks`, `rasterize`, `scope` | #1/#3 | M |
| 9 | Voice sources (mono) | `meowbox`, `elements`, `rings`, `swolevco`, `samsloop`, `foxy`, `wavecel` | #1/#2 | M |
| 10 | Drum/sample voices (seeded) | `drummergirl`, `riotgirls`, `macrooscillator`, `symbiote`, `marbles` | #1/#2 | M (async loads + RNG seed) |
| 11 | Envelopes / function gens | `moog912`, `moog993`, `stages`, `tides2`, `lfo`, `moog921a`, `moog992` | #3 gate | M (gate driver) |
| 12 | Modulation utilities | `buggles`, `cartesian`, `atlantisCatalyst` (seed), `featurecv`(extend), `moog961` | #2/#3 | M |
| 13 | Clocked step sequencers | `sequencer`, `polyseqz`, `drumseqz`, `macseq`, `kria`, `grids`(seed), `score`, `writeseq` | #3 clock | M–L (clock+epoch pin) |
| 14 | Poly voices (real source chain) | `dx7`, `pentemelodica`, `wavecel`, `numpadPlus` | #1 + poly | **L** (real poly source) |
| 15 | WebGL-audio + big multi-out | `cube`(extend), `wavesculpt`, `synesthesia`(extend to all bands), `timelorde` | #1 core | M (hash-transparent audio path) |

Cross-check the module lists against `ART_BACKLOG` before starting a batch — some
of the names above have since been profiled or deleted (`helm`/`polyhelm`/
`hydrogen`/`hypercube` are gone from the tree entirely).

### 2.5 Determinism, per batch

**Seed all non-determinism.** Inject a fixed PRNG for `noise`/`buggles`/
`drummergirl`/`marbles`/`grids`/`moog903a`/`moog923`; pin `epoch=0`/`phase=0` for
`lfo` + clocked sources (DETERMINISM.md's "Random seed" row says *None pinned* —
the offline profiles MUST pin it; add a row to the matrix per batch). Prefer the
`analog-vco` explicit-1-sample-delay technique for any feedback/mutual loop.

The uniqueness guard must stay green — distinct captures only, never a placeholder.

---

## 3. Risks / notes

- **Rendering-path debt.** Path #2 (hand-written TS mirror) is labour + drift risk:
  the mirror can silently diverge from the `.dsp`. The `.sha` pin catches *source*
  changes but not a mirror that was wrong from day one. **When a module needs a
  mirror, extract a real `-dsp.ts` core instead** and land it in the same PR — or
  use the `faust-offline.ts` path, which renders the shipped wasm and has no
  mirror-drift class at all.
- **Faust-only modules.** Faust modules with no TS core need either a mirror or the
  offline Faust host.
- **Multi-out explosion.** `synesthesia` (40 audio-family outs), `clipplayer` (24),
  `gamepad` (18), `timelorde` (13). Apply the "independent information only" rule
  to avoid 40 near-identical band dumps; profile a representative subset + assert
  the rest structurally. (This is the owner's "signature, distinct" answer below.)

---

## 4. OWNER DECISIONS (2026-07-01, verbatim: "1 - gate. 2 - signature, distinct. 3 - ts-pure for now 4 - exclusion list 5 - yes add 6 - agent fan")

1. **GATE.** "≥1 audio profile per non-excluded module" is a REQUIRED
   registry-sweep unit check (`art/scenarios/_meta/audio-profile-gate.test.ts`).
   ⚠ It was implemented as a shrinking backlog **ratchet**; see the triage note at
   the top — that shape is now against repo standard even though the requirement
   stands.
2. **SIGNATURE outputs** — profile the DISTINCT outs per module (main outs +
   genuinely different taps), not every port (no 8× identical clipplayer lanes).
3. **TS-pure cores** are the canonical render path for now; a worklet-hosting
   offline renderer is a separate future infra project.
4. **Exclusion list stands** (games/HID/MIDI-device/live-input/sinks, ~18).
5. **Gallery stats: ADD spectral-centroid + crest factor (+ flatness)** to the
   stats card alongside peak/RMS/duration. **STILL UNVERIFIED — check
   `art/build_gallery.py` before assuming this shipped.**
6. **Agent fan-out** batches of 5–8, adversarially reviewed per batch; sources +
   filters with existing pure cores go first.

---

## Appendix A — per-module table (`af_out` / `core`)

`af_out` = audio-family output ports · `baseline` = had a committed `.f32` when this
was written (**stale — read `ART_BACKLOG` for current coverage**) · `core` = a pure
`-dsp.ts` core exists in `packages/dsp/src/lib/`. **The `core` column is the reason
this table is kept**: it is the only written inventory of which modules already have
a pure core, i.e. which are near-zero-authoring under render path #1.

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

- Render + pin helpers: `art/setup/render.ts` (SR, the stub `render()`,
  `moduleSourceSha`, `builtSha`, baseline/`.sha` I/O, `compareBuffers` tiers,
  `UPDATE_BASELINES`). Capture harness: `art/setup/capture.ts`,
  `art/setup/drivers.ts`, `art/setup/clip-driver.ts`, `art/setup/offline.ts`,
  `art/setup/faust-offline.ts`.
- Coverage gate + backlog: `art/setup/profile-coverage.ts`,
  `art/scenarios/_meta/audio-profile-gate.test.ts`.
- Capture-and-pin pattern: `art/scenarios/analog-vco/fm-sync-model.test.ts`
  (`assertBaseline`); pure-core render: `art/scenarios/treeohvox/voice-character.test.ts`
  (`combinedSourceSha`, `renderVoiceSequence`); offline-primitive render:
  `art/scenarios/sample-hold/quantized-vco-steps.test.ts`.
- Gallery: `art/build_gallery.py`; deploy `.github/workflows/art-gallery.yml`.
- Honesty guard: `art/scenarios/_meta/baseline-uniqueness.test.ts`.
- Determinism matrix: `art/DETERMINISM.md`.
- Pure cores available: `packages/dsp/src/lib/*-dsp.ts` (+ `*-engine.ts`,
  `*-core.ts`).
- Relevant memories: `art-sha-pin-regenerate-last`,
  `poly-modules-test-real-source-chain`, `flake-check-3x-standard`.
