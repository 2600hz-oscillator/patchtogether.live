# DSP-stack bass / freq-response improvement plan (2026-07-01)

> **TRIAGE 2026-08-04 — HALF-EXECUTED. The P0 headline item is STILL OPEN.**
> Verified item by item against the tree:
>
> | item | verdict | evidence |
> |---|---|---|
> | **P0-A1** master "limiter" ducks/pumps the sub | ❌ **NOT DONE — still live** | `audio-out.ts` still builds a plain `createDynamicsCompressor()` at `threshold -6 / ratio 4 / knee 6 / attack 0.003 / release 0.05` feeding `ctx.destination` — the exact full-band stereo-linked compressor this audit indicts |
> | **P0-A2a** pin AudioContext to 48 kHz | ✅ done | `Canvas.svelte:6981` `sampleRate: 48000` |
> | **P1-A2b** kill baked 48000/44100 | ✅ effectively done | no `48000`/`44100` left in `chowkick-dsp.ts`; **`cocoadelay` no longer exists** (superseded by `cofefve`), so its half of A2b is moot |
> | **P1-A3** band-limit the Faust analog VCO | ❌ **NOT DONE** | `analog-vco.dsp:56-58` is still raw-phasor `saw(p)=2p-1`, `sqr`, `tri` — no BLEP anywhere |
> | **P2-A4** shared 2×/4× oversampling wrapper | ✅ done | **#997** "shared 2×/4× oversampler for nonlinear stages (audit A4, kick prereq)"; consumed by tidyVco's wavefolder (#1075) |
> | **P2-A5** denormal floors in ladder/SVF | ❌ **NOT DONE** | `packages/dsp/src/lib/moog-ladder-dsp.ts` still has **zero** `1e-` flush sites |
> | **P2-A6 / P2-LIC** | ⚠ unverified | A6 folds into A1 (open); the resonarium licence question is not answered in-tree |
>
> ⚠ The ART re-pin advice in the ADVERSARIAL REVIEW section is also stale in one
> respect: ART has grown from 48 to 136 `.f32` baselines since (see
> `art-backfill-audio-profiles-2026-07-01.md`), so A1's "no golden protects it"
> claim must be re-checked before the re-pin plan is followed — and `task
> art:update` now chains `art:fingerprints:accept`, which did not exist then.
>
> **Keep — this is live backlog with its P0 unresolved.**

**Scope.** This is the SEPARATE, parallel work block the owner asked for: fixing what is
genuinely wrong (or 48 kHz-fragile) in the *existing* DSP stack's low-end behavior. It is
**not** the new kick voice — the kick is a net-new module built alongside this (see
`## Parallelism with the kick build`). Everything below is grounded in the DSP audit's
file:line evidence, re-verified against the tree on 2026-07-01. Items the audit called
speculative are kept speculative; areas that are already correct are called out honestly in
`## DO NOTHING here`.

**Audit-vs-tree corrections (verified this session):**
- ART baseline count is **48** `.f32` files under `art/baselines/**`, not 66. (`find art/baselines -name '*.f32' | wc -l` → 48.)
- **`cocoadelay` has NO ART scenario** (`art/scenarios/` has `audio-out`, `chowkick`, `analog-vco`, `swolevco` but no `cocoadelay`). So the A2 cocoadelay constant fix re-pins **nothing** in ART — it's guarded only by behavioral/e2e, if at all. That *lowers* its re-pin cost but *raises* the "no golden protects it" risk. Reflected below.
- `audio-out` has exactly one ART scenario: `art/scenarios/audio-out/dc-blocker-and-limiter.test.ts` (verified). A1 re-pins that one file.
- `moog-ladder-dsp.ts` has **zero** denormal floors (grep for `1e-`/`denorm` empty), confirming A5. `chowkick-dsp.ts` flushes at 1e-6/1e-7 (lines 173-174, 334-335, 496, 501, 631), confirming the asymmetry.
- `resofilter-dsp.ts:3-4` header literally says "ported from gabrielsoule/resonarium (Source/dsp/MultiFilter.{h,cpp})" with **no license asserted in-file** — provenance flag confirmed.
- `analog-vco.dsp` `saw(p)=2p-1`, `sqr(p)=select2(p<pw,1,-1)`, `tri(p)` are raw-phasor / non-band-limited (verified) — A3 confirmed.
- `drummergirl.dsp:11` `volume` slider max is **2.0** (verified) — A6 confirmed.

---

## Priority summary

| P | Item | What | Stack-wide? | Re-pin cost | Parallel-safe w/ kick |
|---|------|------|-------------|-------------|-----------------------|
| **P0** | A1 | Master "limiter" ducks & pumps the sub | stack-wide (terminal stage) | 1 ART scenario + broad e2e/behavioral level shift | Yes (kick benefits) |
| **P0** | A2a | Pin AudioContext to 48 kHz | stack-wide | none (ART already 48k) | Yes |
| **P1** | A2b | Kill baked 48000/44100 constants (chowkick, cocoadelay) | per-module (2) | chowkick: 1 ART; cocoadelay: 0 ART | Yes |
| **P1** | A3 | Band-limit the Faust analog VCO | per-module (analogVco/swolevco) | 2 ART + Faust rebuild | Yes |
| **P2** | A4 | Shared 2×/4× oversampling wrapper | new shared lib (kick consumes first) | 0 if scoped to new lib | **Shared dependency w/ kick — coordinate** |
| **P2** | A5 | Denormal floors in ladder/SVF | per-module (2) | 2 ART (LSB) | Yes |
| **P2** | A6 | Headroom convention | convention, folds into A1 | folds into A1 | Yes |
| **P2** | LIC | Confirm resonarium license before building more on SVF | legal, not audio | none | Yes |

---

## P0 — biggest bass wins, do first

### P0-A1 — The master "limiter" is a full-band, stereo-linked compressor that ducks and pumps the sub
**Evidence.** `packages/web/src/lib/audio/modules/audio-out.ts:133-140`:
`DynamicsCompressorNode`, `threshold -6 dB, ratio 4, knee 6, attack 0.003 s, release 0.05 s`,
fed by a single `ChannelMergerNode` (lines 129-131) → `ctx.destination` (line 140). The
in-file comment (117-128) markets it as "transparent ceiling," but the numbers say otherwise
for low end.

**Why it's real.** It is full-band (can't separate sub from mids) and stereo-linked (one node
across L/R). Attack 3 ms + release 50 ms is on the order of the sub period (40 Hz = 25 ms), so
on a −6 dBFS+ kick it **modulates the sub waveform itself** and pulls the whole mix down each
strike — the exact "shake-the-house" transient the owner wants gets shaved. Because everything
sums hot into −6 dB (see A6), this node is engaged during *normal* play, so it is continuously
attenuating low end rather than acting as a rare safety ceiling.

**Affected modules.** Every module — this is the terminal stage for all audio. Most damaging to
the kick.

**Concrete change (pick one, prefer the first that ships):**
1. **Sidechain-HPF the detector.** `DynamicsCompressorNode` has no detector-HPF, so this needs a
   real change of topology: split into a detector path where the sub is high-passed (~100-120 Hz)
   before it drives gain reduction, OR
2. **Replace with a look-ahead brickwall limiter worklet** (own-code): raise the ceiling to ~−1 dB,
   sub passes at full level, true peak control, optional 2× oversampled soft-clip. This is the
   correct long-term answer and reuses the A4 oversampler.
   - Minimal interim: raise `threshold` to ~−1 dB and lengthen `release` so the node stops
     riding the sub on every strike — a 1-value tweak that de-risks the P0 while the worklet is built.

**Test / measurement that proves it.**
- **Spectral A/B unit test (new):** render a 40 Hz sine + transient click at −3 dBFS through the
  old vs new master path; assert the **sub band (30-80 Hz) gain-reduction ripple** at the kick
  rate drops below a threshold (i.e. no per-strike pumping). This is the load-bearing proof.
- **ART re-pin:** `art/scenarios/audio-out/dc-blocker-and-limiter.test.ts` (the only audio-out
  scenario) — run `UPDATE_BASELINES=1` for it, then **review the diff** (a diff = the master
  sound changed on purpose).
- E2E audibility asserts read the `outputSnapshot` tap (`audio-out.ts:142-153, 188-190`); any that
  assert an absolute output level will shift and must be re-baselined.

**Blast radius / re-pin.** 1 ART scenario re-pin. Behaviorally changes the master sound of **every**
patch → expect behavioral/e2e level assertions to move. Moderate. **Owner-review before merge**
(this is a master-bus tone change; falls under the "video aspect/look = review before merge" spirit
for audio).

### P0-A2a — Pin the AudioContext sample rate to 48 kHz
**Evidence.** `packages/web/src/lib/ui/Canvas.svelte:~4414` —
`audioCtx = new AudioContext({ latencyHint: audioLatencyStore.latencyHint })`, **no `sampleRate`**.
ART renders at a hardcoded `SAMPLE_RATE = 48000` (`art/setup/render.ts:15`). So a 44.1 kHz user
(common on Macs) hears a signal the 48 pinned baselines never verified.

**Why it's real.** It's the root cause that makes A2b's baked constants audible and makes the ART
pins only *partially* protect real users. Pinning the context makes every ART `.f32` pin actually
represent what users hear.

**Concrete change.** `new AudioContext({ sampleRate: 48000, latencyHint })`. One line.
- Guard: a tiny fallback if the browser rejects 48000 (rare); log + fall back to default and accept
  the constants risk on that machine.

**Test / measurement.** No ART re-pin (baselines already assume 48k). Add a 1-line unit/e2e assert
that `ctx.sampleRate === 48000` after boot so a future regression is caught. Re-runs all
e2e/behavioral (they already pass at whatever the CI machine's rate is; pinning makes them
deterministic).

**Blast radius / re-pin.** 1-line change, **no ART re-pin**, re-runs e2e/behavioral. Low. Stack-wide
determinism win. (One caveat to confirm with owner — see OPEN QUESTIONS: does forcing 48k on a 44.1k
device add a resampling stage at the OS/output that could raise latency or CPU on low-end machines?)

---

## P1 — real, per-module, moderate cost

### P1-A2b — Stop baking 48000 / 44100 into filter/decay math
**Evidence.**
- `packages/dsp/src/lib/chowkick-dsp.ts:410-412` — `RES_R_LONG = pow(0.01, 1/(0.28*48000))`,
  `RES_R_SHORT = pow(0.01, 1/(0.018*48000))`. The pole radius is fixed but samples-per-ms is not, so
  the resonator decay times drift ~9% at 44.1k.
- `packages/dsp/src/cocoadelay-core.ts:46,57,71` — `let c = cutoff * 44100 * dt;` in OnePole/TwoPole/
  FourPole. Hardcoded 44100 → the filter cutoff is wrong when the context is 48k.
- **Counter-evidence (already correct):** `gatemaiden`, `seq-clock`, `spring-reverb`, `trigger-convert`
  correctly thread live `sr` and only fall back to 48000 when `sr <= 0`. So this is a *localized* defect,
  not a stack-wide pattern.

**Why it's real.** Even with A2a pinning the context to 48k, cocoadelay's `44100` literal is simply the
*wrong* number and skews its filter cutoff at 48k regardless. chowkick's `48000` becomes correct once the
context is pinned, but is still fragile (breaks the instant anyone runs it at another rate, e.g. ART could
change SAMPLE_RATE, or a future 44.1k fallback path).

**Concrete change.** Thread the live `sr`/`sampleRate` that the core already receives into these constants
(chowkick: compute `RES_R_*` from the passed `sr`; cocoadelay: replace `44100` with the core's `sr`).

**Test / measurement.**
- chowkick: **ART re-pin** of `art/scenarios/chowkick/*` (run `UPDATE_BASELINES=1`, confirm only the
  chowkick `.f32` moved). Note the ART-SHA-pin discipline: re-pin the `.sha` LAST, confirm only `.sha`
  changed if audio is unchanged — but here audio *does* change at any non-48k rate, so the `.f32` moves at
  48k only if you also change SAMPLE_RATE; **add a dedicated unit test** that renders the core at 44100 and
  48000 and asserts the measured decay time (RES) / −3 dB cutoff (cocoadelay) is within tolerance of the
  target **at both rates** — that's the real proof the literal is gone.
- cocoadelay: **no ART scenario exists** → the unit test above is the *only* gate. Strongly recommend
  adding one either way.

**Blast radius / re-pin.** chowkick: 1 ART scenario (+ it's a heavily-used drum, broad behavioral). cocoadelay:
0 ART, new unit test. Low-moderate. Parallel-safe.

### P1-A3 — Band-limit the Faust analog VCO (aliasing folds into the low end)
**Evidence.** `packages/dsp/src/analog-vco.dsp` — `saw(p)=2p-1`, `sqr(p)=select2(p<pw,1,-1)`,
`tri(p)=4*abs(p-0.5)-1`, `sn(p)=sin(2πp)` — all derived from a raw phasor (`phasorReset`/`phasorPm`) with
**no polyBLEP/polyBLAMP**. Contrast the own-code `packages/dsp/src/lib/moog-vco-dsp.ts:78-150`, which *does*
band-limit its saw/rect/triangle.

**Why it's real.** At higher fundamentals the alias images fold back down into the audible/low band, muddying
bass and intermodulating with it. A VCO used as a bass/lead source is exactly where this shows.

**Affected modules.** `analogVco`, `swolevco` (both have ART scenarios: `art/scenarios/analog-vco`,
`art/scenarios/swolevco`), and anything using the analog VCO as its oscillator.

**Concrete change (two routes — decide with owner, see OPEN QUESTIONS):**
1. **Route through the own-code polyBLEP `MoogVco` core** (already permissive own-code) instead of the Faust
   naive waveforms — best quality, but a larger structural change to two shipping modules.
2. **Add polyBLEP residuals in the Faust source** — smaller surface, keeps the module Faust-native, but
   re-implements BLEP in `.dsp`.

**Test / measurement.** **Spectral unit test:** sweep the fundamental up (e.g. 2-8 kHz), FFT the output, assert
alias energy below the fundamental drops by a target (e.g. >20 dB) vs the current naive waveform. Then **ART
re-pin** `analog-vco` + `swolevco` (Faust rebuild required; confirm both `.f32` moved intentionally, review diff).

**Blast radius / re-pin.** Faust rebuild + 2 ART scenarios; broad behavioral (widely used oscillator).
Moderate-high. **Owner-review the timbre change before merge** — band-limiting audibly changes the VCO's
character, which some users may have dialed in.

---

## P2 — real but lower-severity / infra

### P2-A4 — One shared 2×/4× oversampling wrapper (nonlinearities alias at 1×)
**Evidence.** No oversampling utility exists anywhere in the stack (confirmed: `cube-dsp.ts:34` explicitly notes
"no separate sample-clock decimation"; no `oversample`/`halfband`/`2x` anti-alias code under `lib/`). Every tanh
saturator runs at 1×: `moog-ladder-dsp.ts:225` (feedback tanh), `chowkick-dsp.ts:494-505,687` (body drive/shape),
plus treeohvox/cube/synesthesia drive stages and Faust `destroy.dsp`.

**Why it's real (for the kick) / speculative (severity elsewhere).** tanh generates infinite harmonics; at 1× the
top ones alias and part of that inharmonic energy lands in the low band as grit. This directly undercuts a kick
whose "sub reads on small speakers via harmonic saturation" strategy — the harmonics you add to expose the
fundamental are partly aliased garbage. For the *existing* modules the audible severity is unquantified (hence
speculative); the audit does not claim they're broken.

**Concrete change.** Build one shared `lib/oversample.ts` (own-code): upsample → nonlinearity callback →
half-band decimate, 2×/4× selectable. The **new kick consumes it first**; retrofitting existing modules is
optional and separate.

**Test / measurement.** Unit test the wrapper in isolation (feed a tone through a tanh at 1× vs 2× vs 4×, FFT,
assert alias floor drops with the OS factor). No existing module changes → no existing re-pin.

**Blast radius / re-pin.** Additive new lib, used only by the new kick → **0 existing re-pin**. Retrofitting any
existing module re-pins that module's scenario (defer). Low if scoped.

**⚠ Shared dependency with the kick build.** This is the ONE item that is not cleanly parallel — the kick wants
this wrapper. See `## Parallelism with the kick build`.

### P2-A5 — Denormal floors in the ladder / SVF cores (perf, not freq-response)
**Evidence.** `moog-ladder-dsp.ts` (states `s1..s4`, `yPrev`) and `resofilter-dsp.ts` (`ic1/ic2`, `svfStep`) have
**no denormal floor** (grep confirmed empty), unlike `chowkick-dsp.ts` which flushes at 1e-6/1e-7 (lines 173-174,
334-335, 496, 501, 631).

**Why it's real (but low).** On long resonant tails decaying into silence the integrator states enter denormal
range → CPU spikes on some x86 CPUs → underrun clicks under load (the "clicks when I touch the UI" class). It is a
**perf/glitch** bug, not a frequency-response bug — be honest that it won't change the tone, only stop the
occasional click.

**Concrete change.** Add a tiny floor (`if (Math.abs(s) < 1e-20) s = 0;` or the `+1e-20` offset trick) in the
ladder step and the SVF `svfStep`. Match the existing chowkick idiom.

**Test / measurement.** Hard to prove audibly; the honest test is a **unit test that runs a long decaying tail and
asserts states never go denormal** (magnitude either 0 or ≥ floor), plus a manual CPU-under-load spot check. Changes
output at the LSB → **ART re-pin** moog-ladder/resofilter/consumer scenarios (confirm only LSB moved).

**Blast radius / re-pin.** LSB-level `.f32` change → re-pins moog-ladder/resofilter + any consumer scenario. Low.

### P2-A6 — Headroom convention (folds into A1)
**Evidence.** `mixmstrs.dsp` sums 6 channels + 2 returns then `×masterVol` with no per-channel headroom scaling;
`mixer.dsp` is a raw linear sum; `audio-out` master defaults 0.7 (`audio-out.ts:95`); `drummergirl.dsp:11` allows
`volume` up to 2.0 (200%). Several loud sources trivially exceed −6 dBFS, keeping A1's limiter engaged in normal use.

**Why it's real.** It's *why* A1's "safety ceiling" is actually active during normal play. Fixing A1's threshold
without a nominal per-voice level just moves the problem.

**Concrete change.** Raise the limiter ceiling (A1) and establish a nominal per-voice output level; give the new
kick a sane unity-ish output rather than a ×2 poke. This is a **convention decision**, not a big code change —
document it and apply going forward; don't mass-rescale every existing module (that would re-pin the world).

**Test / measurement.** Folds into A1's spectral A/B + the master ART re-pin. No separate re-pin if you only change
the convention doc + the new kick's output level.

**Blast radius / re-pin.** Folds into A1. If you rescale existing modules, each re-pins — **don't**, unless owner
wants a one-time master gain-staging pass (OPEN QUESTION).

### P2-LIC — Confirm resonarium (SVF) license before building more on it
**Evidence.** `resofilter-dsp.ts:3-4` says "ported from gabrielsoule/resonarium (Source/dsp/MultiFilter.{h,cpp})"
and does **not** assert that project's license in-file — the one core whose provenance isn't stated permissive.
Owner mandates permissive-only.

**Why it's here (not a bass item).** Out of scope for frequency response, but the SVF is a candidate building block
for future low-end work, so confirm resonarium is permissive (MIT/BSD) **before** any new module depends on it. If
it's GPL/copyleft, the SVF must be re-derived clean-room or avoided.

**Test / measurement.** Legal/license check, not a code test. Add the confirmed license SPDX to the file header
once verified.

**Blast radius.** None (audio unchanged). Documentation only.

---

## DO NOTHING here — areas that are already good (honest negatives)

- **The 5 Hz master DC-block HPF is NOT a sub killer.** `audio-out.ts:106-115`, Butterworth Q=0.707, 2nd-order.
  At 40 Hz that's 3 octaves up → ≈ −0.03 dB. The in-file comment (100-105) is accurate. **Leave it.** Genuinely
  inaudible; correct and cheap.
- **There is no stack-wide low-cut that kills sub.** The only high-passes in the audio path are the 5 Hz master DC
  block (fine), chowkick's own 25 Hz DC block (`chowkick-dsp.ts:653-665`, fine), and treeohvox's 150 Hz feedback HP
  (`treeohvox-dsp.ts:21`, **by design** for a formant/vocal module — just don't route bass through treeohvox). The
  compressor's HPF (`compressor-dsp.ts:121-132`, `sidecar.ts` `sc_hpf`) is on the **detector/sidechain only** — it
  does not touch the audio path. All correct.
- **The Moog ladder and SVF cores are high quality for low end.** Cutoff clamped to a safe band
  (`ladderCutoffToG` fmin=10 Hz; `cutoffToG` fmin=10 Hz), zero-delay TPT feedback (stable under audio-rate CV),
  bounded self-oscillation via tanh. **No low-frequency accuracy problem** — the only gap is the denormal floor
  (A5, perf-only). Don't "improve" the filter math.
- **The own-code Moog VCO is properly band-limited** (`moog-vco-dsp.ts:78-150` polyBLEP/polyBLAMP). The aliasing
  problem is *specifically* the Faust analog VCO (A3), not the own-code oscillator. Don't touch moog-vco.
- **`destroy.dsp` decimation aliases by design** (it's a bitcrusher). Not a defect. Leave it.
- **`reverb.dsp` is mono freeverb** (`re.mono_freeverb`) — a stereo-image note, **not** a bass issue. Out of scope.

---

## Parallelism with the kick build

Almost every item is parallel-safe with the net-new stereo kick module, because the kick is additive
(new `AudioModuleDef` + worklet + new ART scenario + new VRT card → **re-pins nothing existing**). Specifically:

- **A1 / A6** — the kick *benefits* from the master fix (its sub stops getting eaten), but doesn't block on it;
  build both, integrate at the end.
- **A2a** — pin the context once; both efforts want it. Land early so both build against 48k.
- **A2b / A3 / A5 / LIC** — touch different files than the kick; fully parallel.
- **A4 (oversampler) — the ONE coupling.** The kick's drive stage wants this shared `lib/oversample.ts`. Two
  options: (1) build A4 first as a tiny standalone lib PR, then both the kick and any retrofit consume it; or
  (2) the kick author writes the oversampler inline first and we extract it to `lib/` later. **Recommend option 1**
  (build the shared lib first, unit-tested, so the kick lands clean). Decide before the kick author starts the
  drive stage.

Shared-file conflict note: none of these items touch the registry conflict surfaces
(`module-manifest.ts`, `vrt-exemptions.ts`, `modules-card-map.test.ts`, per-port spec lists,
`strict-docs.ts`) except the new-module work, which the kick PR owns — so this block and the kick PR won't
collide on those.

---

## OPEN QUESTIONS for the owner

1. **A2a — force 48 kHz on 44.1 kHz hardware?** Pinning `sampleRate: 48000` makes ART pins protect all users and
   kills the baked-constant risk, but on a native-44.1k device the OS/output inserts a resample that can add a
   little latency/CPU on low-end machines. Accept that trade for cross-machine determinism, or instead fix the
   constants (A2b) and leave the context at hardware rate? (Audit recommends pinning; it's cheaper and safer.)
2. **A1 — how far to go on the master limiter?** Minimal (raise threshold to ~−1 dB + longer release, 1-line, ships
   today) vs. the real fix (own-code look-ahead brickwall limiter worklet with sidechain HPF + optional oversampled
   soft-clip). The worklet is the correct answer and reuses A4, but it's a bigger, owner-review-gated master-tone
   change. Which for the first pass?
3. **A3 — reroute vs re-BLEP the analog VCO?** Route `analogVco`/`swolevco` through the own-code polyBLEP `MoogVco`
   core (best quality, larger change to two shipping modules, audible timbre shift) vs. add polyBLEP residuals in
   the Faust `.dsp` (smaller surface, keeps it Faust-native)? Both re-pin ART + audibly change the VCO character —
   confirm you want that character change at all, or should band-limiting be a new *opt-in* "clean" mode?
4. **A4 — build the shared oversampler as its own PR first, or inline in the kick then extract?** (Recommend
   standalone-first so the kick lands clean.)
5. **A6 — one-time master gain-staging pass?** Do you want a deliberate headroom/normalization pass across existing
   loud modules (re-pins many scenarios, but fixes gain-staging globally), or just set the *convention* + the new
   kick's level and leave existing modules alone (no mass re-pin)? Audit leans "convention only."
6. **LIC — is `gabrielsoule/resonarium` confirmed permissive?** Need the actual license before any *new* module
   builds on `resofilter-dsp.ts`'s SVF. If copyleft, we re-derive the SVF clean-room.

---

## ADVERSARIAL REVIEW + RESOLUTIONS

Every load-bearing file:line claim was re-verified against the tree on 2026-07-01.
**VERDICT: the underlying bugs are all REAL (not speculative) — but the ART re-pin
MECHANICS and COSTS in the priority table are materially WRONG for several items,
and A4 is mis-labeled parallel-safe.** The frequency-response diagnoses stand; the
*verification story* needs correcting so the owner isn't told an auto-golden protects
something that has no `.f32` at all. Findings and resolutions below.

### Confirmed real (bugs + honest negatives both verified)

- **A1** — `audio-out.ts:133-140` full-band, stereo-linked `DynamicsCompressorNode`
  (thr −6 / ratio 4 / knee 6 / att 0.003 / rel 0.05), merger (`:129-131`) →
  destination (`:140`). No detector-HPF is possible on that node → the fix is a real
  topology change, as the plan says. The sub-modulation concern is plausible (rel
  50 ms vs 40 Hz period 25 ms; WebAudio applies no auto-makeup). P0 defensible. ✔
- **A2a** — `Canvas.svelte:4414` `new AudioContext({ latencyHint })`, no `sampleRate`;
  `render.ts:15` `SAMPLE_RATE = 48000`. ✔
- **A2b** — `cocoadelay-core.ts:46,57,71` `let c = cutoff * 44100 * dt` ✔;
  `chowkick-dsp.ts:410-411` `RES_R_* = pow(0.01, 1/(…*48000))` ✔.
- **A3** — `analog-vco.dsp:56-59` naive `saw=2p-1` / `sqr` / `tri` ✔.
- **A5** — moog-ladder + resofilter have no denormal floor; chowkick flushes
  1e-6/1e-7 (`:173-174,:334-335,:631`) ✔.
- **A6** — `drummergirl.dsp:11` volume max 2.0 ✔; `audio-out.ts:95` master 0.7 ✔.
- **DO-NOTHING negatives all verified** — 5 Hz DC block inaudible; treeohvox 150 Hz
  is a by-design feedback HP; sidecar `sc_hpf` is detector-only (`compressor-dsp.ts:98`
  "NOT the audio path"); moog-VCO already band-limited. The audit's own
  self-corrections (48 baselines not 66; cocoadelay has no scenario) are accurate. ✔

### Finding 1 — [MUST CHANGE] The ART re-pin mechanism is WRONG for A1, A2b/chowkick, and A5 (they have no `.f32` golden; `UPDATE_BASELINES=1` does nothing)

**Problem.** The priority table's "Re-pin cost" column describes an auto-golden diff
flow for scenarios that don't have one. Verified against the tree:
- `audio-out/dc-blocker-and-limiter.test.ts` is an **inline `expect()`** test on a
  real `OfflineAudioContext` render (the compressor IS simulated — asserts at
  `:153-171`), so **A1 is genuinely testable**, but the gate is *hand-edited hardcoded
  peak bounds* (`expect(peak).toBeLessThan(1.2)`), NOT "review a regenerated `.f32`
  diff." There is no `.f32` for this scenario.
- `chowkick/canonical-kicks.test.ts` is inline asserts at `SR = 48000`. Threading
  `sr` (which already equals 48000 in the test) yields byte-identical output → the
  asserts pass unchanged → **chowkick A2b re-pin cost is 0, not "1 ART."**
- moog-ladder / resofilter have **no `.f32`**, and a 1e-20 denormal flush changes no
  observable output → **A5 re-pin cost is 0, not "2 ART (LSB)."**
- The ONLY genuine `.f32` re-pins in the whole tree are: analog-vco, cube, featurecv,
  hypercube, sample-hold, synesthesia, treeohvox.

**RESOLUTION (adopted — correct the table + the per-item "Test / measurement").**
| Item | Table said | Corrected gate |
|---|---|---|
| A1 | "1 ART scenario re-pin + review diff" | **No `.f32`.** Gate = manually re-tune the inline hardcoded peak/ripple bounds in `dc-blocker-and-limiter.test.ts` + author the NEW spectral A/B sub-pump unit test. Still owner-review (master tone). |
| A2b chowkick | "chowkick: 1 ART" | **0 ART** (inline test already at 48k → identical). Gate = the NEW dual-rate (44100 + 48000) decay-time unit test. |
| A2b cocoadelay | "0 ART" | Correct — 0 ART; the NEW dual-rate −3 dB cutoff unit test is the ONLY gate. |
| A5 | "2 ART (LSB)" | **0 ART** (no `.f32`; flush is unobservable). Gate = the NEW "states never denormal on a long tail" unit test + manual CPU-under-load check. |

Net: the audit **over-states re-pin cost** (cheaper than claimed) but, more importantly,
**mis-describes the gate** — for A1/A2b/A5 the load-bearing proof is a NEW unit test
(and, for A1, manual bound re-tuning), not an auto-golden. Update each item's
"Blast radius / re-pin" line to match.

### Finding 2 — [GAP — the audit's biggest blind spot] A3's ART gate does not exercise the code being changed

**Problem.** The analog-vco `.f32` baselines are NOT rendered from the shipped Faust
wasm — `hard-sync.test.ts:12-16` states "node-web-audio-api cannot host the Faust
AudioWorklet directly … we render from a faithful TS mirror," and that TS mirror
itself uses the naive `saw = 2p-1` (`:49`). Consequences:
- Band-limiting the **Faust `.dsp`** source would NOT move the ART baseline at all
  unless you *also* hand-port polyBLEP into the TS mirror — and even then you'd be
  proving the mirror, not the shipped wasm.
- `swolevco` has **no `.f32`** (inline pitch-tracking asserts; band-limiting won't
  move them).

So A3's "Faust rebuild + 2 ART re-pin" verification story is materially weaker than
stated: **node can't host Faust, so there is no faithful automated gate for the
shipped oscillator in the current harness.**

**RESOLUTION (adopted).** Rewrite A3's "Test / measurement" to be honest about the gate:
1. **Primary gate = the spectral alias-rejection unit test** (sweep fundamental
   2-8 kHz, FFT, assert alias energy drops ≥ target vs the naive reference) — run
   against the **own-code polyBLEP core** if A3 chooses Route 1 (reroute through
   `MoogVco`), which IS node-testable.
2. If A3 chooses Route 2 (polyBLEP residuals in the Faust `.dsp`), acknowledge there
   is **no automated proof the shipped wasm is band-limited** in this harness — the
   gate degrades to (a) the TS-mirror updated in lockstep + (b) a manual/e2e listen +
   a real-browser spectral e2e on the actual worklet. Flag this asymmetry as a reason
   Route 1 is technically preferable (folds into Q3).
3. Drop the "2 ART re-pin" claim for A3 unless the TS mirror is deliberately updated;
   `swolevco` has no `.f32` to re-pin regardless.

### Finding 3 — [DECIDE] A4 is NOT "parallel-safe" — it is a direct shared-file collision with the kick

**Problem.** The top-line "almost every item is parallel-safe" is contradicted by A4's
own row: both this plan and `kick-drum-voice-2026-07-01.md` create the identical new
path `packages/dsp/src/lib/oversample.ts`. That's a hard file collision (whoever lands
second conflicts), not the merge-registry surface. Everything *else* in the audit IS
genuinely parallel-safe — it touches DSP cores + audio-out + Canvas + Faust `.dsp`,
none of which are registry conflict surfaces, and none are in the WebGL attest basis
(audio isn't hashed; A1 is correctly owner-review-gated; A2a/A5 are no-re-pin). The
only real coupling is `oversample.ts` ownership.

**RESOLUTION (owner-decision flagged; recommended path stated).** Elevate A4 from a
footnote to an explicit blocking sequencing decision: **build A4 as its own
standalone lib PR FIRST** (unit-tested to ≥60 dB image rejection, incl. the kick's
worst-case wavefold/asym-even nonlinearities per the kick plan's Finding 2), then BOTH
the kick's drive stage and any existing-module retrofit consume it. Correct the
"almost every item is parallel-safe" sentence to "every item EXCEPT A4 is
parallel-safe; A4 is the single shared dependency and must be built first / single-
owner." This is the same decision as the kick plan's §9 Q9 — resolve once, applies to
both. (Q4 already asks it; this finding makes the collision consequence explicit.)
