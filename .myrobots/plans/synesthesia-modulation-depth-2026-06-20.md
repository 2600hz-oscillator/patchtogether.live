# Synesthesia → Lines orient under-modulation: diagnosis + plan

**Date:** 2026-06-20
**Status:** Diagnosis — **finding 3 has since been FIXED; findings 1 and 2 still hold.**

> **TRIAGE 2026-08-04 — re-verified finding by finding.**
> - **Finding 1 (a CV cable only reaches half a param's range because it is
>   additive around the knob)** — STILL TRUE. It is the documented convention,
>   `docs/adr/004-cv-range-convention.md`. Not a bug; the recipe ("bipolar source
>   + knob at centre") is still the answer.
> - **Finding 2 (synesthesia's envelope outputs are unipolar by default; the
>   per-copy Polarity toggle exists but is OFF)** — STILL TRUE:
>   `synesthesia.ts:190-191` still declares `a_bipolar` / `b_bipolar` with
>   `defaultValue: 0`.
> - **Finding 3 — "SCALER's knob is dead… This is a real defect" — FIXED.**
>   SCALER is now **type-transparent**: `packages/web/src/lib/audio/modules/scaler.ts:66`
>   declares `{ id: 'out', type: 'audio', adoptsUpstreamFrom: 'in' }`, so a CV
>   source makes it emit CV and the cross-domain RMS envelope-follower that
>   clamped the knob at 1.0 is no longer in the path. The doc's "Through SCALER it
>   is *not* achievable" conclusion is therefore **no longer true** — do not cite
>   it.
> This file is cited from source. Kept for findings 1–2 and the worked numbers.
**Patch under investigation:** `/Users/2600hz/Downloads/patch.imp (31).json`
**Reported by:** owner

---

## TL;DR

Three separate things stack up, none of them a bug in Lines:

1. **The CV-range convention only gives you HALF a parameter's range per side** (it's
   additive *around the knob*). With the Lines `orient` knob at its default `0`, even a
   perfect bipolar `+1` CV can only reach `orient = 0.5` → **45°, never 90°.** That's
   why "LFO at full depth never quite goes vertical."
2. **Synesthesia's envelope outputs are UNIPOLAR `[0,1]` by default**, and a real
   envelope peaks *below* 1.0. So it lives in the upper-half sub-range and pushes even
   less than the LFO. There is already a per-copy **"Polarity" toggle** (`a_bipolar`/
   `b_bipolar`) that fixes this — it's just OFF by default.
3. **SCALER's knob is "dead"** because its output is hard-typed `audio`, which forces the
   cross-domain bridge into an **RMS envelope-follower that clamps to 1.0**. Any hot
   signal pins the RMS at 1.0, so the AMOUNT knob does nothing above ~1.4×. SCALER's
   GainNode is fine; the downstream bridge eats the knob. **This is a real defect** for
   using SCALER as a CV utility.

**Can the owner get FULLY vertical (90°) from a Synesthesia envelope today, with no code
change?** **Yes — but only by also raising the Lines `orient` knob.** Bipolar source +
knob at center is the intended full-sweep recipe. Through SCALER it is *not* achievable
(SCALER collapses CV to clamped RMS). Details below.

---

## 1. What's happening (each symptom, with numbers)

### The core math (applies to all three)

A `cv` cable is **bipolar −1..+1** by convention, and `±1` is supposed to sweep the
target's *full* range **centered on the knob** (ADR-004 `docs/adr/004-cv-range-convention.md:31-34`).
The linear scaler implements that as (`packages/web/src/lib/audio/cv-scale.ts:57-62`):

```
halfSpan  = (max - min) / 2
effective = clamp( knob + cv * depth * halfSpan , min, max )      // depth defaults 1.0
cv        = clamp(c, -1, +1)                                       // cv-scale.ts:52
```

The load-bearing word is **halfSpan**. A single-sided source can only move the param by
`depth * (max-min)/2` = **HALF the range**, measured *from the knob*. `depth` is reserved
and always 1.0 (`packages/web/src/lib/graph/types.ts:222-228`).

Lines `orient` is `min:0 max:1 default:0` (`packages/web/src/lib/video/modules/lines.ts:124`),
and the shader maps it linearly to a quarter turn — `theta = uOrient * 1.5707963`
(`lines.ts:60`): `orient 0 → 0° (horizontal)`, `0.5 → 45°`, `1.0 → 90° (vertical)`. No
clamp or ceiling in the shader; the cap is entirely upstream in the CV scaling.

So with the orient **knob at its default 0**:

```
effective_orient = clamp(0 + cv * 1.0 * 0.5, 0, 1) = clamp(cv * 0.5, 0, 1)
cv = +1  → orient 0.5 → 45°   (NOT vertical)
cv = +2  → would be 90°, but cv is clamped to +1 → unreachable
```

**Vertical (90°) is mathematically unreachable from knob=0, for ANY source.**

### Symptom 1 — LFO at full depth never quite goes vertical (~45° ceiling)

The LFO emits a true bipolar `±1` (`packages/web/src/lib/audio/modules/lfo.ts` + DSP;
default depth 0.5 = unity swing). The bridge tail-samples it; at the peak `cv=+1`,
`orient = 0 + 1*0.5 = 0.5 → 45°`. It "never quite goes vertical" because **45° IS the
ceiling with the knob at 0** — not a bug, the half-span convention meeting a knob sitting
at the bottom of the range.

### Symptom 2 — Synesthesia → orient = even LESS movement

Synesthesia's `env_slow`/`env_fast` are typed `cv` (`synesthesia.ts:44-47`) but emit
**UNIPOLAR `[0,1]`** by default: `a_bipolar`/`b_bipolar` default `0`
(`synesthesia.ts:60,155-156`), and `applyBipolar` is a pass-through when off
(`packages/dsp/src/lib/synesthesia-dsp.ts:91-93`). The pipeline is `env → ×CV_MAKEUP →
cvClamp[0,1]`; `CV_MAKEUP=[1.6,1.6,1.6,1.5]` and raw fast-env peaks cluster at
**~0.62–0.68** on a *full-amplitude* hit (`synesthesia-dsp.ts:57-70`). So:

- The signal occupies only the **upper half** `[0,1]` of the `[-1,+1]` window — half the
  LFO's peak-to-peak swing to start with.
- A *realistic* (sub-full) hit peaks **well under 1.0** → `orient = env*0.5` lands around
  `0.15–0.40` → **~14°–36°**, i.e. visibly less than the LFO's 45°.

That is the literal "even less movement than the LFO": unipolar + sub-unity source vs the
LFO's reliable full bipolar `±1`.

### Symptom 3 — through SCALER: MORE dramatic (~45°) but SCALER knob is DEAD

There is exactly **one** SCALER and it is **audio-domain**
(`packages/web/src/lib/audio/modules/scaler.ts`) — a single GainNode, `gain = AMOUNT`
(log, 0.1..10, default 1.0). The knob is correctly wired (`scaler.ts:68,77`) and unit
tests prove `out = in*amount`. **The GainNode is not buggy.**

The trap is the output port type: SCALER's `out` is hard-typed **`audio`** (`scaler.ts:53`).
The edge `SCALER.out → LINES.orient` is therefore an *audio→video* edge, and the
cross-domain bridge gives an **audio source an RMS envelope-follower**
(`packages/web/src/lib/video/engine.ts:1082` — `env` only created when
`sourceType === 'audio'`). Every video frame, `tickCvBridges` runs the audio branch
(`video/engine.ts:1100-1109`): `env = followEnvelope(window)` = `clamp01(RMS(window))`
(`packages/web/src/lib/video/toybox-cv-math.ts:121-133`), then `scaleCv`.

Two consequences, both matching the report exactly:

- **More dramatic than direct:** routing through SCALER converts the signal to `audio`, so
  it gets the hot, sustained **RMS follower** (0..1) instead of the small unipolar
  tail-sample — a much stronger modulation that drives orient straight to its 45° ceiling.
- **Knob dead:** `followEnvelope` **clamps RMS to 1.0**. For a ~1.0-amp source RMS≈0.707,
  so the RMS saturates at 1.0 once `amount ≥ ~1/0.707 ≈ 1.42`. Above that, every knob
  position → `env=1.0` → `orient = 0.5` → 45°, **invariant**. The knob only does anything
  in a narrow low window the owner can't perceive against the already-saturating signal.

**Numeric reproduction (1.0-amp source, RMS 0.707):** amount 0.5 → 15.9°; 1.0 → 31.8°;
1.42 → 45°; 2 / 5 / 10 → **all 45.0° (pinned)**. Confirms both the ~45° ceiling *and* the
dead knob.

---

## 2. Recommended patching RIGHT NOW (current code, no changes)

**Goal:** Synesthesia envelope drives Lines orient all the way to vertical.

**Reachable today? YES — direct, with two settings. NOT through SCALER.**

1. **Use a `cv` env output, wired DIRECTLY to `LINES.orient`.** Use `env_fast` (or
   `env_slow`) — NOT a band/audio out, and **NOT through SCALER** (SCALER's `audio` output
   collapses CV to a clamped RMS and breaks modulation — see §3).
2. **Turn ON Synesthesia "Polarity" for that copy** — the `A Polarity` / `B Polarity`
   toggle on the card (`a_bipolar`/`b_bipolar` → 1, `synesthesia.ts:155`). This remaps the
   env CV to bipolar `[-1,+1]` (silence → −1, strong hit → +1). The toggle's own code
   comment (`synesthesia-dsp.ts:81-89`) describes exactly the owner's problem and says
   this is the fix.
3. **Raise the LINES `orient` knob to ~0.5 (center).** With the knob at center, a bipolar
   `±1` env sweeps `orient` across the **full** `0→1` (`0° ↔ 90°`). Bipolar source +
   knob-at-center is exactly what the convention intends for an edge-to-edge sweep.

Result: a strong onset → `cv ≈ +1` → `orient = 0.5 + 1*0.5 = 1.0` → **90°, fully vertical;
silence → −1 → 0° horizontal.** This is the only no-code path to true vertical.

> Caveat: even bipolar, a sub-full hit peaks below `+1`, so quieter hits won't reach a
> full 90° — that's honest envelope dynamics, not a defect. For a guaranteed full sweep on
> every hit you'd want a compressor/normalizer or the universal source-side change in §4.
> **Through SCALER, full vertical is NOT reachable** at any knob setting (RMS clamp +
> half-span cap = hard 45°).

---

## 3. The SCALER bug

**Root cause:** SCALER's `out` is unconditionally typed `audio` (`scaler.ts:53`). When its
input is actually CV/gate/pitch (it advertises `accepts: ['cv','pitch','gate']`,
`scaler.ts:49`), the **output still claims `audio`**, so any downstream cross-domain
(audio→video) edge runs the RMS-envelope-follower branch
(`video/engine.ts:1082,1100-1109`) which **clamp01's to 1.0**
(`toybox-cv-math.ts:129-131`). That clamp — not the GainNode — is what kills the knob, and
it also discards the CV's instantaneous level/sign, so SCALER cannot function as a CV
attenuator/attenuverter at all.

**Fix (small, well-contained):** make SCALER's `out` type **follow its input's type**
instead of hard-coding `audio` — i.e. when driven by a `cv`/`pitch`/`gate` source, emit
that family so the edge takes the **tail-sample (cv) branch**, not the audio-RMS branch.
This is the same "output adopts the upstream family" pattern SCOPE uses for its probe
input. With a CV-typed output, SCALER becomes a real CV gain/attenuverter and the AMOUNT
knob scales the actual ±CV value linearly. (Alternative if dynamic typing is awkward: ship
a dedicated CV-attenuverter module and document SCALER as audio-only — less good, leaves
the `accepts` claim misleading.)

This bug is **not specific to SCALER** — it hits **any audio-typed output used as a
modulator into a video CV input** (MIXER, ATTENUMIX, MOOG 995, etc.): all get RMS-clamped
to `[0,1]`, losing bipolarity and saturating. See §4(ii).

---

## 4. The UNIVERSAL fix ("Synesthesia → ANY modulation input", all modules)

The systemic mismatch, stated once:

> **Envelope-style sources emit unipolar `[0,1]` (and often sub-1.0), but the linear
> `scaleCv` convention assumes bipolar `±1` for a full sweep and grants only HALF the
> range per side. So every "envelope → linear CV input" patch under-modulates; and every
> "audio-typed output → video CV input" patch is additionally RMS-clamped to `[0,1]`.**

There are three levers; pick by how universal you want the fix:

### (Primary, recommended) Make Synesthesia's env CV bipolar by default — SOURCE-side

Flip `a_bipolar`/`b_bipolar` default `0 → 1` (`synesthesia.ts:60,155-156`), so env CV uses
the full `[-1,+1]` via the existing `applyBipolar` (`synesthesia-dsp.ts:91-93`). This is
the **only** change that makes "Synesthesia → *any* CV input" full-range **without
per-patch fiddling**, because the half-span math is per-input and by-design — you can't fix
it once at a destination. The mechanism already exists, written for this exact purpose; we
just change the default.

- **Fixes uniformly:** every downstream CV input, audio OR video (Lines orient, every
  video param, every audio modulation target), plus consumers like gibribbon that read the
  env CV directly.
- **RISK — "changing a default surfaces every test asserting the old scale."** This is the
  documented `changing a default` lesson (synesthesia kick-bass / RECORDERBOX SIZE
  history). Bipolar changes silence from `0 → −1`, which **inverts the resting modulation
  offset** of existing patches and will move ART/behavioral/VRT baselines and any unit test
  asserting the old `[0,1]` env. Mitigations: (a) keep the per-copy toggle so users can opt
  back to unipolar; (b) re-pin ART `.sha` baselines LAST and confirm only `.sha` changed;
  (c) regenerate linux+darwin VRT baselines via `vrt-update.yml`; (d) audit `gibribbon`'s
  demo calibration (its comment at `synesthesia-dsp.ts:66-68` warns it reads the boosted
  slow env directly). Because of the blast radius, a **conservative variant** is to leave
  the default OFF and instead surface the toggle prominently in the card + docs — zero
  baseline churn, but the owner must flip it per patch.

### (ii) Fix the audio-typed-output → video-CV RMS clamp — the SCALER class

The §3 SCALER fix generalized: any module that is meant to *pass/scale* a CV but emits
`audio` gets RMS-clamped on the cross-domain bridge. Either (a) let pass-through utilities
adopt the upstream CV type on their output (SCALER, MIXER-as-CV, ATTENUMIX, MOOG 995), or
(b) only auto-envelope-follow a *true* audio source — i.e. when an `audio`-typed edge feeds
a video CV param but the upstream chain originates from a CV source, prefer the
tail-sample branch. (a) is simpler and localized to the few utility modules.

### (iii) (optional, longer-horizon) Activate the reserved per-edge `depth`

`depth` is plumbed through `scaleCv` but pinned at 1.0 (`graph/types.ts:222-228`). Exposing
a per-input "modulation depth" knob (depth > 1 lets `±1` exceed half-span) would let users
push a destination to full range *without* moving the destination knob — a nice-to-have,
not the root fix, and orthogonal to the polarity issue.

**Files in play:** `packages/web/src/lib/audio/modules/synesthesia.ts` (defaults),
`packages/dsp/src/lib/synesthesia-dsp.ts` (`applyBipolar`, already present),
`packages/web/src/lib/audio/modules/scaler.ts` (output typing),
`packages/web/src/lib/video/engine.ts` + `toybox-cv-math.ts` (the audio-RMS bridge branch),
`packages/web/src/lib/audio/cv-scale.ts` + `graph/types.ts` (half-span/`depth`).

---

## 5. Recommended next step (decision-ready)

**Confirm to the owner the no-code recipe (§2) immediately** — direct `env_fast` →
`LINES.orient`, Synesthesia **Polarity ON**, Lines **orient knob ~0.5** → full vertical
today; through SCALER it is not reachable.

**Then, two small PRs (each self-contained, each with the real source→module→render e2e):**

1. **SCALER CV-passthrough fix (§3)** — output adopts the upstream CV family so the AMOUNT
   knob actually scales CV. Clear defect, low blast radius, no convention change. **Do this
   first.**
2. **Synesthesia bipolar default (§4 primary)** — flip `a_bipolar`/`b_bipolar` default to
   `1`, keeping the toggle. **Owner sign-off required** because it's a `changing-a-default`
   change with VRT/ART/behavioral baseline churn (regenerate baselines, re-pin ART `.sha`
   last, audit gibribbon). If the owner prefers zero baseline churn, ship the conservative
   variant (default OFF + surface the toggle + docs) instead.

Lines itself needs **no change** — the half-span convention is working as designed; the
"can't reach vertical from knob=0" is the convention, addressed by the bipolar source +
knob-at-center recipe (or, longer-term, the optional `depth` knob in §4(iii)).
