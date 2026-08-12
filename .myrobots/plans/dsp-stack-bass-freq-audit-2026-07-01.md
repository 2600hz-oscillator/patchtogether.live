# DSP-stack bass / freq-response improvement plan (2026-07-01)

> ## STATUS — MOSTLY DISCHARGED. THREE ITEMS REMAIN: **A3**, **A6**, **LIC**.
>
> Closed and deleted from this file: **A1** (master limiter — #1369), **A2a** (pin
> the AudioContext to 48 kHz — `Canvas.svelte` now passes `sampleRate: 48000`),
> **A2b** (baked 48000/44100 — no literals left in `chowkick-dsp.ts`, and
> `cocoadelay` no longer exists, superseded by `cofefve`), **A4** (shared 2×/4×
> oversampler — #997, consumed by tidyVco's wavefolder #1075), **A5** (denormal
> floors — #1374 put 1e-20 floors in `moog-ladder-dsp.ts`, 6 flush sites).
>
> **Still open:**
> - **A3 — band-limit the analog VCO (BLEP).** Verified 2026-08-12:
>   `packages/dsp/src/analog-vco.dsp:56` is still `saw(p) = 2.0 * p - 1.0`, and the
>   file contains **zero** `blep` occurrences. ⚠ **Read the #1379 correction block
>   below FIRST — A3's stated premise is half wrong as measured on the shipped
>   wasm.**
> - **A6 — headroom convention.** Folded into A1, which shipped without it being
>   separately settled. Needs a re-read of `audio-out.ts` + `mixmstrs.dsp` to decide
>   whether it survived the limiter rework. Related measured fact still standing:
>   `drummergirl.dsp:11` `volume` slider max = **2.0** (200 %).
> - **LIC — the resonarium licence.** `resofilter-dsp.ts:3-4` still says *"ported
>   from gabrielsoule/resonarium (Source/dsp/MultiFilter.{h,cpp})"* with **no
>   license asserted in-file**. This is the only legal item in the corpus and it has
>   been open since 2026-07-01.
>
> ⚠ **The ART re-pin arithmetic anywhere in this file is stale.** ART has grown from
> 48 to **134** `.f32` baselines across 56 groups since it was written, so any "no
> golden protects it" claim must be re-checked against the tree before acting. And
> `task art:update` now chains `art:fingerprints:accept`, which did not exist then —
> re-pinning a baseline by any other route means running that yourself.

---

## The #1369 measurement, kept because it is the reference for master-bus work

Implemented the prescribed **option 2** — an own-code look-ahead brickwall limiter
worklet at a −1 dBFS ceiling (`packages/dsp/src/lib/master-limiter-dsp.ts`),
replacing the `DynamicsCompressorNode`. Measured on a sustained 40 Hz sub + a kick
every 500 ms:

| input peak | OLD ripple → out peak | NEW ripple → out peak |
|---|---|---|
| −2.90 dBFS | 0.210 dB → 0.8048 | **0.000** → 0.7071 |
| +3.12 dBFS | 2.671 dB → **1.2395 CLIPS** | 1.203 → 0.8913 |
| +9.14 dBFS | 4.279 dB → **1.6022 CLIPS** | 3.136 → 0.8913 |

**Three corrections to this audit, from measurement:**

1. **"Engaged during normal play, continuously attenuating low end" was
   OVERSTATED.** `DynamicsCompressorNode` uses an averaging detector, so real
   engagement is ~−3 dBFS, not the nominal −6. At −5.4 dBFS the measured ripple is
   **0.003 dB**.
2. **The audit MISSED the two larger defects.** The node never bounded the output at
   all — its sole purpose — and it applied **+1.35 dB of automatic makeup to every
   patch**.
3. **"1 ART scenario re-pin" was wrong — ZERO moved.** All fingerprints
   byte-identical; nothing renders through `audio-out`. `grand-integration` did not
   move either (it sums the four cores directly), so **no grand re-attest was
   needed**.

⚠ **Two owner-visible consequences**: every patch is now **~1.35 dB quieter** (that
makeup is gone), and the limiter release is **1.5 s** — deliberately long, because
shorter releases just relocate the pumping onto the beat.

---

## Remaining items

| P | Item | What | Re-pin cost |
|---|------|------|-------------|
| **P1** | A3 | Band-limit the Faust analog VCO | Faust rebuild; ART gate is weaker than the audit claimed — see below |
| **P2** | A6 | Headroom convention (was folded into A1) | none if convention-only |
| **P2** | LIC | Confirm resonarium license before building more on the SVF | none — legal, not audio |

### P1-A3 — Band-limit the Faust analog VCO

> ### ⚡ 2026-08-04 — A3 MEASURED ON THE SHIPPED WASM, AND ITS PREMISE IS HALF WRONG
>
> A3 was never measured — the audit asserted the aliasing from reading the
> source (`saw(p)=2p-1`, no BLEP). It is now measurable: #1376 established that
> `art/setup/faust-offline.ts` renders the real analog-vco wasm headlessly, so
> the "no faithful automated gate exists" objection is GONE.
>
> **Measured** — worst inharmonic image in the AUDIBLE band (20 Hz–16 kHz),
> relative to the fundamental, on the shipped `saw` tap:
>
> | pitch | worst audible alias | where | vs fundamental | leakage floor | REAL? |
> |---|---|---|---|---|---|
> | C4  262 Hz | −31.7 dB | 245 Hz | **−27.8 dB** | **−28.9 dB** | ❌ **NO — instrument** |
> | C5  523 Hz | −32.7 dB | 490 Hz | −28.8 dB | −56.0 dB | ✅ yes |
> | C6 1047 Hz | −33.8 dB | 15558 Hz | −29.9 dB | ~−76 dB | ✅ yes |
> | C7 2093 Hz | −28.0 dB | 14512 Hz | −24.1 dB | ~−76 dB | ✅ yes |
> | C8 4186 Hz | −22.0 dB | 14512 Hz | **−18.1 dB** | ~−76 dB | ✅ yes |
>
> ⚠ **THE C4 ROW IS AN ARTEFACT, AND IT IS THE ROW THE AUDIT'S PREMISE RESTS
> ON.** A3's stated motivation is that images "fold back down into the audible/
> low band, muddying bass". At C4 the worst thing I could find sits at 245 Hz —
> 17 Hz from the fundamental, about 4 bins of an unwindowed Goertzel. Feeding
> the SAME estimator a pure sine (zero aliasing by construction) returns
> **−28.9 dB at that exact bin**. The measurement was spectral leakage from the
> fundamental, not aliasing. At 490 Hz the same control reads −56 dB and at
> 14512 Hz −76 dB, so the other four rows clear their floor by 27–58 dB and
> ARE real.
>
> **What that changes:**
> * The aliasing is **real and worth fixing at high pitch** — −18.1 dB at C8 is
>   plainly audible, and it worsens monotonically with pitch, exactly as theory
>   says for a raw phasor.
> * The **low-end/bass premise is NOT demonstrated**. Anyone re-opening A3
>   should either measure it with a windowed estimator or drop that
>   justification. Do not repeat "muddies the bass" as established.
> * **Route 2 (polyBLEP in the `.dsp`) is no longer the weaker option.** It had
>   been rejected *because* it had no automated proof. The offline harness supplies
>   exactly that proof now — re-render the shipped wasm and re-run the table above.
>   Re-decide the route on quality alone.
>
> **Still owner-gated.** Band-limiting audibly changes the VCO's character and
> `analogVco`/`swolevco` are shipped; "owner-review the timbre change before merge"
> stands. This entry supplies the numbers that decision needs; it does not make it.
>
> ⚠ Method note, since it cost a false finding here: a bare Goertzel has no
> window, so its sidelobes read ~−29 dB only a few bins out. **ALWAYS
> negative-control an alias measurement against a signal known to have none.**

**Evidence.** `packages/dsp/src/analog-vco.dsp` — `saw(p)=2p-1`,
`sqr(p)=select2(p<pw,1,-1)`, `tri(p)=4*abs(p-0.5)-1`, `sn(p)=sin(2πp)` — all derived
from a raw phasor (`phasorReset`/`phasorPm`) with **no polyBLEP/polyBLAMP**.
Contrast the own-code `packages/dsp/src/lib/moog-vco-dsp.ts:78-150`, which *does*
band-limit its saw/rect/triangle.

**Affected modules.** `analogVco`, `swolevco`, and anything using the analog VCO as
its oscillator.

**Two routes — decide with the owner (Q1 below):**
1. **Route through the own-code polyBLEP `MoogVco` core** (already permissive
   own-code) instead of the Faust naive waveforms — best quality, but a larger
   structural change to two shipping modules.
2. **Add polyBLEP residuals in the Faust source** — smaller surface, keeps the
   module Faust-native, and now provable via `faust-offline.ts`.

**Gate.** The primary gate is a **spectral alias-rejection test** (sweep the
fundamental up, FFT, assert alias energy drops by a target vs the naive reference),
negative-controlled against a pure sine per the method note. `swolevco` has **no
`.f32`** (inline pitch-tracking asserts), so do not claim an ART re-pin for it.

### P2-A6 — Headroom convention

**Evidence.** `mixmstrs.dsp` sums 6 channels + 2 returns then `×masterVol` with no
per-channel headroom scaling; `mixer.dsp` is a raw linear sum; `drummergirl.dsp:11`
allows `volume` up to 2.0 (200 %). Several loud sources trivially exceed the old
−6 dBFS threshold.

**Why it was real.** It is *why* the old limiter was active during normal play.
Raising the ceiling without a nominal per-voice level just moves the problem — and
#1369 raised the ceiling, so re-read `audio-out.ts` to see whether A6 is now moot or
still owed.

**Concrete change.** Establish a nominal per-voice output level and give new voices a
sane unity-ish output rather than a ×2 poke. This is a **convention decision**, not
a big code change — document it and apply going forward. **Do NOT mass-rescale every
existing module** (that would re-pin the world) unless the owner explicitly wants a
one-time gain-staging pass (Q2).

### P2-LIC — Confirm resonarium (SVF) license before building more on it

**Evidence.** `resofilter-dsp.ts:3-4` says "ported from gabrielsoule/resonarium
(Source/dsp/MultiFilter.{h,cpp})" and does **not** assert that project's license
in-file — the one core whose provenance isn't stated permissive. Owner mandates
permissive-only.

**Why it's here (not a bass item).** Out of scope for frequency response, but the SVF
is a candidate building block for future low-end work, so confirm resonarium is
permissive (MIT/BSD) **before** any new module depends on it. If it is
GPL/copyleft, the SVF must be re-derived clean-room or avoided.

**Action.** Legal/license check, not a code test. Add the confirmed license SPDX to
the file header once verified. Audio unchanged; documentation only.

---

## DO NOTHING here — areas that are already good (honest negatives)

This section exists to stop a future agent re-auditing them.

- **The 5 Hz master DC-block HPF is NOT a sub killer.** `audio-out.ts`, Butterworth
  Q=0.707, 2nd-order. At 40 Hz that's 3 octaves up → ≈ **−0.03 dB**. The in-file
  comment is accurate. **Leave it.**
- **There is no stack-wide low-cut that kills sub.** The only high-passes in the
  audio path are the 5 Hz master DC block (fine), chowkick's own 25 Hz DC block
  (`chowkick-dsp.ts:653-665`, fine), and treeohvox's 150 Hz feedback HP
  (`treeohvox-dsp.ts:21`, **by design** for a formant/vocal module — just don't
  route bass through treeohvox). The compressor's HPF (`compressor-dsp.ts:121-132`,
  `sidecar.ts` `sc_hpf`) is on the **detector/sidechain only** — it does not touch
  the audio path. All correct.
- **The Moog ladder and SVF cores are high quality for low end.** Cutoff clamped to
  a safe band (`ladderCutoffToG` fmin=10 Hz; `cutoffToG` fmin=10 Hz), zero-delay TPT
  feedback (stable under audio-rate CV), bounded self-oscillation via tanh. **No
  low-frequency accuracy problem.** Don't "improve" the filter math.
- **The own-code Moog VCO is properly band-limited** (`moog-vco-dsp.ts:78-150`
  polyBLEP/polyBLAMP). The aliasing problem is *specifically* the Faust analog VCO
  (A3), not the own-code oscillator. Don't touch moog-vco.
- **`destroy.dsp` decimation aliases by design** (it's a bitcrusher). Not a defect.
- **`reverb.dsp` is mono freeverb** (`re.mono_freeverb`) — a stereo-image note,
  **not** a bass issue. Out of scope.

---

## OPEN QUESTIONS for the owner

1. **A3 — reroute vs re-BLEP the analog VCO?** Route `analogVco`/`swolevco` through
   the own-code polyBLEP `MoogVco` core (best quality, larger change to two shipping
   modules, audible timbre shift) vs. add polyBLEP residuals in the Faust `.dsp`
   (smaller surface, keeps it Faust-native, and now automatically provable via
   `faust-offline.ts`)? Both audibly change the VCO character — confirm you want
   that character change at all, or should band-limiting be a new *opt-in* "clean"
   mode?
2. **A6 — one-time master gain-staging pass?** A deliberate headroom/normalization
   pass across existing loud modules (re-pins many scenarios, fixes gain-staging
   globally), or just set the *convention* + new modules' levels and leave existing
   modules alone (no mass re-pin)? The audit leans "convention only".
3. **LIC — is `gabrielsoule/resonarium` confirmed permissive?** Need the actual
   license before any *new* module builds on `resofilter-dsp.ts`'s SVF. If copyleft,
   we re-derive the SVF clean-room.
