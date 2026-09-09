# Synesthesia → Lines orient under-modulation: diagnosis + plan

**Date:** 2026-06-20

> **RE-VERIFIED 2026-08-12 — findings 1 and 2 still hold; finding 3 is FIXED and
> its section is deleted.**
> - **Finding 1 (a CV cable only reaches half a param's range because it is
>   additive around the knob)** — STILL TRUE, and it is the **documented
>   convention**, `docs/adr/004-cv-range-convention.md`. Not a bug.
> - **Finding 2 (synesthesia's envelope outputs are unipolar by default; the
>   per-copy Polarity toggle exists but is OFF)** — STILL TRUE:
>   `synesthesia.ts:191-192` still declares `a_bipolar` / `b_bipolar` with
>   `defaultValue: 0`.
> - **Finding 3 — "SCALER's knob is dead" — FIXED.** SCALER is now
>   type-transparent: `scaler.ts:66` declares
>   `{ id: 'out', type: 'audio', adoptsUpstreamFrom: 'in' }`, so a CV source
>   makes it emit CV and the cross-domain RMS envelope-follower that clamped the
>   knob at 1.0 is no longer in the path. **The old conclusion "through SCALER
>   it is not achievable" is no longer true — do not cite it.** The section that
>   argued it has been removed; the measured saturation numbers it produced are
>   kept below because they are the worked example of the RMS-clamp mechanism,
>   which still bites every module listed under §4(ii).

---

## The core math (this is the finding)

A `cv` cable is **bipolar −1..+1** by convention, and `±1` is supposed to sweep the
target's *full* range **centered on the knob** (ADR-004
`docs/adr/004-cv-range-convention.md:31-34`). The linear scaler implements that
as (`packages/web/src/lib/audio/cv-scale.ts:57-62`):

```
halfSpan  = (max - min) / 2
effective = clamp( knob + cv * depth * halfSpan , min, max )      // depth defaults 1.0
cv        = clamp(c, -1, +1)
```

The load-bearing word is **halfSpan**. A single-sided source can only move the
param by `depth * (max-min)/2` = **HALF the range**, measured *from the knob*.

Lines `orient` is `min:0 max:1 default:0` (`lines.ts:124`), and the shader maps
it linearly to a quarter turn — `theta = uOrient * 1.5707963` (`lines.ts:60`):
`orient 0 → 0°`, `0.5 → 45°`, `1.0 → 90°`. No clamp in the shader; the cap is
entirely upstream in the CV scaling. So with the orient **knob at its default 0**:

```
effective_orient = clamp(0 + cv * 1.0 * 0.5, 0, 1) = clamp(cv * 0.5, 0, 1)
cv = +1  → orient 0.5 → 45°   (NOT vertical)
cv = +2  → would be 90°, but cv is clamped to +1 → unreachable
```

**Vertical (90°) is mathematically unreachable from knob = 0, for ANY source.**

### Measured envelope levels

Synesthesia's `env_slow`/`env_fast` are typed `cv` but emit **UNIPOLAR `[0,1]`**
by default (`applyBipolar` is a pass-through when off,
`synesthesia-dsp.ts:91-93`). The pipeline is `env → ×CV_MAKEUP → cvClamp[0,1]`;
**`CV_MAKEUP = [1.6, 1.6, 1.6, 1.5]` and raw fast-env peaks cluster at ~0.62–0.68
on a full-amplitude hit** (`synesthesia-dsp.ts:57-70`). So:

- The signal occupies only the **upper half** `[0,1]` of the `[-1,+1]` window —
  half the LFO's peak-to-peak swing to start with.
- A *realistic* (sub-full) hit peaks well under 1.0 → `orient = env*0.5` lands
  around **0.15–0.40 → ~14°–36°**, visibly less than the LFO's 45°.

### The RMS-clamp saturation point (the worked example)

`followEnvelope` clamps RMS to 1.0 (`toybox-cv-math.ts:121-133`). For a ~1.0-amp
source RMS ≈ 0.707, so the RMS **saturates once `amount ≥ 1/0.707 ≈ 1.42`**.
Measured reproduction, 1.0-amp source:

| amount | orient angle |
|---:|---:|
| 0.5 | 15.9° |
| 1.0 | 31.8° |
| 1.42 | 45° |
| 2 / 5 / 10 | **all 45.0° (pinned)** |

Above 1.42 every knob position gives `env = 1.0 → orient = 0.5 → 45°`,
**invariant**. This is what a dead knob looks like in numbers, and it is still
the live behaviour for every audio-typed output feeding a video CV input.

---

## The no-code recipe (still the answer for findings 1 + 2)

**Goal:** Synesthesia envelope drives Lines orient all the way to vertical.

1. **Use a `cv` env output wired DIRECTLY to `LINES.orient`** — `env_fast` (or
   `env_slow`), not a band/audio out.
2. **Turn ON Synesthesia "Polarity" for that copy** — the `A Polarity` /
   `B Polarity` toggle (`a_bipolar`/`b_bipolar` → 1). This remaps the env CV to
   bipolar `[-1,+1]` (silence → −1, strong hit → +1). The toggle's own code
   comment (`synesthesia-dsp.ts:81-89`) describes exactly this problem and says
   this is the fix.
3. **Raise the LINES `orient` knob to ~0.5 (center).** With the knob at center a
   bipolar `±1` env sweeps `orient` across the **full** `0→1` (`0° ↔ 90°`).

Result: a strong onset → `cv ≈ +1` → `orient = 0.5 + 1*0.5 = 1.0` → **90°**;
silence → −1 → 0°.

> Caveat: even bipolar, a sub-full hit peaks below `+1`, so quieter hits won't
> reach a full 90° — honest envelope dynamics, not a defect.

---

## The systemic statement

> **Envelope-style sources emit unipolar `[0,1]` (and often sub-1.0), but the
> linear `scaleCv` convention assumes bipolar `±1` for a full sweep and grants
> only HALF the range per side. So every "envelope → linear CV input" patch
> under-modulates; and every "audio-typed output → video CV input" patch is
> additionally RMS-clamped to `[0,1]`.**

Three levers remain, all UNBUILT.

### (i) Make Synesthesia's env CV bipolar by default — SOURCE-side. **OWNER SIGN-OFF REQUIRED.**

Flip `a_bipolar`/`b_bipolar` default `0 → 1` (`synesthesia.ts:191-192`), so env CV
uses the full `[-1,+1]` via the existing `applyBipolar`. This is the **only**
change that makes "Synesthesia → *any* CV input" full-range **without per-patch
fiddling**, because the half-span math is per-input and by design — you can't fix
it once at a destination. The mechanism already exists, written for this exact
purpose; only the default changes.

- **Fixes uniformly:** every downstream CV input, audio OR video, plus consumers
  like gibribbon that read the env CV directly.
- **RISK — this is the documented `changing a default` bug class.** Bipolar
  changes silence from `0 → −1`, which **inverts the resting modulation offset of
  existing patches** and will move ART/behavioral/VRT baselines and any unit test
  asserting the old `[0,1]` env. Mitigations: (a) keep the per-copy toggle so
  users can opt back to unipolar; (b) re-pin ART `.sha` baselines LAST and
  confirm only `.sha` changed; (c) regenerate the VRT baselines via
  `vrt-update.yml`; (d) audit `gibribbon`'s demo calibration — its comment at
  `synesthesia-dsp.ts:66-68` warns it reads the boosted slow env directly.
  Because of the blast radius, the **conservative variant** is to leave the
  default OFF and instead surface the toggle prominently in the card + docs:
  zero baseline churn, but the owner must flip it per patch.

### (ii) Generalize the type-transparent fix beyond SCALER — **UNBUILT**

The SCALER fix generalized: any module meant to *pass/scale* a CV but emitting
`audio` gets RMS-clamped on the cross-domain bridge, losing bipolarity and
saturating per the table above. **Verified 2026-08-12: `adoptsUpstreamFrom`
appears in exactly ONE module file — `scaler.ts`.** MIXER, ATTENUMIX and
MOOG 995 are all still hard-typed `audio` and still RMS-clamped when used as
modulators into a video CV input.

Either (a) let pass-through utilities adopt the upstream CV type on their output
(MIXER-as-CV, ATTENUMIX, MOOG 995), or (b) only auto-envelope-follow a *true*
audio source — i.e. when an `audio`-typed edge feeds a video CV param but the
upstream chain originates from a CV source, prefer the tail-sample branch.
(a) is simpler and localized to the few utility modules, and is the pattern
already proven by `scaler.ts`.

### (iii) Activate the reserved per-edge `depth` — **UNBUILT**

`depth` is plumbed through `scaleCv` but pinned at 1.0. Verified still reserved:
`graph/types.ts:222` — *"`depth` is reserved for a future per-param 'modulation
depth' knob"* — with `depth?: number` at `:228`. Exposing a per-input
"modulation depth" knob (depth > 1 lets `±1` exceed half-span) would let users
push a destination to full range *without* moving the destination knob. A
nice-to-have, not the root fix, and orthogonal to the polarity issue.

**Files in play:** `packages/web/src/lib/audio/modules/synesthesia.ts`
(defaults), `packages/dsp/src/lib/synesthesia-dsp.ts` (`applyBipolar`, already
present), `packages/web/src/lib/video/engine.ts` + `toybox-cv-math.ts` (the
audio-RMS bridge branch), `packages/web/src/lib/audio/cv-scale.ts` +
`graph/types.ts` (half-span / `depth`).

Lines itself needs **no change** — the half-span convention is working as
designed.
