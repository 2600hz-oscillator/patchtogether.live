# FACE SPEC — `noise` (batch 3) — **RECOMMENDATION: DO NOT SHIP A FACE**

**Status:** SPEC + MOCKUP ONLY. PF-20 platform (PR #1301, unmerged). Citations file:line.

**Verdict: NO CURATED FACE ON MERIT.** The brief asked me to say so rather than invent one, so
this file is the argument, the contingency design if the owner overrules it, and the pile of real
defects the investigation turned up — which are worth more than the face would have been.

1 param, **0 inputs**, 3 outputs. contract-lock block = **5 lines**
(`packages/web/src/lib/docs/contract-lock.txt:2358-2362`: 1 meta + 3 out + 1 param) — among the
smallest audio contracts in the file. In `STRICT_DOCS` (`strict-docs.ts:45`) and in
**`STRICT_VRT_MODULES`** (`e2e/vrt/vrt-exemptions.ts:888`), the required gate.

---

## 1. WHAT IT ACTUALLY DOES

**There is no worklet.** `packages/dsp/src/noise.ts` does not exist; NOISE is pure Web Audio. Three
*independent* generators run **once at spawn** into three 2-second `AudioBuffer`s
(`packages/web/src/lib/audio/modules/noise.ts:51, 89, 106-108`) looped through
`AudioBufferSourceNode → GainNode` (`:110-139`). **The colour is baked into the table, not
reachable by a knob.** There is no filter node, no DC blocker, no gain normalisation between
colours, and no colour morph.

| tap | algorithm | coefficients | measured slope 20 Hz–20 kHz |
|---|---|---|---|
| white | `Math.random()·2 − 1`, uniform | `packages/dsp/src/lib/noise-dsp.ts:27` | **+0.01 dB/oct** |
| pink | **Voss-McCartney**, `ROWS = 16`, row = `log2(counter & −counter)`, **plus a fresh white sample**, normalised `/17` | `noise-dsp.ts:38-58` | **−3.10 dB/oct** |
| brown | one-pole leaky integrator `y[n] = 0.99·y[n−1] + 0.5·w[n]`, `out = y/8` | `LEAK = 0.99`, `NORM = 1/8`, `noise-dsp.ts:73-78` | **−5.07 dB/oct** |

**The one genuinely interesting DSP fact:** brown is a one-pole low-pass, so it is **flat below
its corner and −6 dB/oct only above it**. Measured band slopes: 20–100 Hz = **−1.01 dB/oct**,
100 Hz–1 kHz = −5.35, 1–10 kHz = −5.92. Exact −3 dB corner from `a = 0.99`:
`cos ω = (1+a² − 2(1−a)²)/2a` ⇒ **76.78 Hz at 48 kHz**. And because `LEAK` is a bare z-domain
constant with **no `sampleRate` term** (`noise-dsp.ts:73`) while `bufferLen` *does* scale with
rate (`noise.ts:89`), **the corner moves with the user's interface**: 70.54 Hz at 44.1 k,
76.78 at 48 k, **153.56 Hz at 96 k**.

`level` (0..1 linear, default 0.5) writes `setValueAtTime` on **all three** GainNodes
simultaneously (`noise.ts:151-155`). `readParam` returns `whiteGain.gain.value` (`:158`). That is
the entire param surface.

---

## 2. WHY IT DOES NOT DESERVE A FACE

- **One param, zero inputs, zero modes.** `faceTierCap` gives mini = 1 and compact = 2–3
  (`packages/web/src/lib/ui/workflow/curated-face.ts:62-79`), so **a one-param face is identical
  at mini, compact, full and dock.** A `face` here buys one fader and a glyph, and the four tiers
  the whole ranking system exists to serve collapse into one.
- **Nothing is inert, so there is nothing to teach.** All three buffers `.start()` unconditionally
  at factory time (`noise.ts:137-139`); every jack emits at spawn. This module is the *opposite* of
  the inert-at-spawn problem — which is also why it has nothing to explain.
- **The default glyph would actively mislead.** `primaryAudioOutPortId` picks the **first** audio
  output in declaration order (`packages/web/src/lib/ui/workflow/shell-glyph-live.ts:96`) =
  **`white`**, so an off-the-shelf `glyph: 'meter'` would meter the one tap whose level is least
  interesting and silently misrepresent the other two — which are **12.4 dB** and **7.0 dB** below
  it (§4).
- **It would be three faces, not one.** `moog903a` (`:87-88, :104-106`) and `moog923`
  (`:123-127, :133-136`) both `import { noiseGenerators } from '$lib/audio/modules/noise'` and
  rebuild the **identical** buffer-loop → per-tap-gain topology. 903A is NOISE minus brown with
  LEVEL default 0.8; 923 is 903A plus two biquads. Authoring three near-identical faces for what
  is one generator library is how a face program starts producing furniture.

**THE ONE REAL ARGUMENT FOR IT, stated fairly:** noise is currently a **`placeholder`** —
`curatedFace()` returns `null` (`curated-face.ts:222`) so `laneRenderKind` yields `'placeholder'`
(`packages/web/src/lib/ui/workflow/legacy-fallback.ts:109`), a tile showing a name, a type badge
and a **static decorative SVG squiggle**
(`packages/web/src/lib/ui/modules/ModuleShellPlaceholder.svelte:141-144`). Under `?shell=1` this
module has *no* controls in-lane at all and its LEVEL knob is reachable only through the dock. It
is also already in `STRICT_DOCS` **and** `STRICT_VRT_MODULES`, so it is the cheapest possible
promotion in the batch.

**My recommendation: do not promote it in this batch.** If the placeholder is the real complaint,
the right fix is a platform one — a placeholder that shows the module's *outputs* — not a
one-fader face. If the owner overrules, §3 is the contingency, and it is deliberately built around
the readouts rather than around the fader.

---

## 3. THE CONTINGENCY FACE (only if the owner overrules §2)

```ts
face: {
  title: 'Source',
  hint:
    'Three independent 2-second noise tables, generated once at spawn and looped. LEVEL scales all ' +
    'three together — but they are NOT level-matched: pink sits 12.4 dB and brown 7.0 dB below white.',

  order: ['level', 'noise-taps-{n}'],
  pages: [
    { id: 'taps', label: '1 · three taps',
      hint: 'white is uniform, pink is Voss-McCartney over 16 rows, brown is a leaky integrator — and brown is only −6 dB/oct ABOVE its corner',
      controls: ['noise-taps-{n}', 'level'] },
  ],
  glyph: 'meter',   // ⚠ see §2 — this meters `white` ONLY, and the sidebar must say so

  hero: {
    cell: 'noise-taps-{n}', control: 'level',
    readouts: [
      { label: 'white', valueId: 'noise-white-db' },
      { label: 'pink',  valueId: 'noise-pink-db' },
      { label: 'brown', valueId: 'noise-brown-db' },
    ],
  },
  sidebar: [
    { kind: 'readouts', label: 'brown corner', entries: [
      { label: '−3 dB at', valueId: 'noise-brown-corner-hz' },
      { label: 'below it', text: 'white, not brown' },
    ] },
  ],
}
```

---

## 4. DERIVED READOUTS — the slope is a dead end; the LEVELS are not

**Rejected outright: a spectral-slope readout.** Nothing about the slope is controllable — there
is no morph knob — so "−3 dB/oct" would be a **constant string**. Decoration, not a readout. I am
naming the rejection because it is the obvious idea and it is wrong.

What *is* worth showing is that **one LEVEL knob produces three wildly different output levels**,
which no knob-readback can reveal. Closed forms straight from the cited coefficients:

```
white = LEVEL/√3
pink  = LEVEL·√(ROWS+1)/(√3·(ROWS+1))        # ROWS = 16, noise-dsp.ts:38-58
brown = LEVEL·√(1/12)/(8·√(1 − 0.99²))       # NORM = 1/8, LEAK = 0.99, noise-dsp.ts:73-78
```

| tap | RMS at LEVEL 1 | dBFS | vs white | peak |
|---|---|---|---|---|
| white | 0.57744 (= 1/√3) | −4.77 | 0.00 dB | 1.000 |
| pink | 0.13817 | −17.19 | **−12.41 dB** | 0.657 |
| brown | 0.25686 | −11.81 | **−7.03 dB** | **1.123** |

**NEGATIVE CONTROL (the required one).** Change `NORM` at `noise-dsp.ts:74` from `1/8` to `1/4`. A
knob readback prints "Level 0.50" — **unchanged**. The derived brown readout moves from −17.87 to
−11.85 dBFS and its crest headroom flips from 5.3 dB to **−1.3 dB (clipping)**. **Second control:**
change `LEAK` from 0.99 to 0.999 — knob readback again unchanged; the derived corner moves
76.8 → 7.7 Hz and brown RMS rises ~10 dB. **Both perturbations are invisible to every gate this
module currently has** (the ART slope tolerance is ±2 dB/oct and RMS is only asserted `> 0.005`,
`art/scenarios/noise/profile.test.ts:125`).

**Secondary — `noise-brown-corner-hz`**, printed with the **live `ctx.sampleRate`**:
`fc = (fs/2π)·acos((1+a² − 2(1−a)²)/2a)`. **NEGATIVE CONTROL:** switch the interface to 96 kHz.
The knob, the def, the docs and the card are all unchanged and the number correctly reads
**154 Hz**. ⚠ This needs the widened `FaceReadoutValue` reader (`{ read, sampleRate }`) — the
registry as specified on the platform branch is params-only, so today this can only ship stated
against 48 kHz.

---

## 5. ALREADY-WRONG — the real yield of this investigation

- **A · `noise-dsp.ts:66-67` — "the integrator steady-state RMS is ~3.5".** It is **2.0464**
  (theory and measurement agree). Off by 1.7×.
- **B · `noise-dsp.ts:67-68` — "peak excursions stay comfortably under ±1 … (verified to ~64k
  samples)".** The shipped buffer is **96 000** samples (`noise.ts:51, 89`) and the measured peak
  is **1.1234**. The comment's own scope caveat is the tell: nobody re-checked at ship length.
  `art/scenarios/noise/profile.test.ts:120` quietly encodes the overshoot with
  `peakCeil.brown = 1.0` vs `LEVEL` for the others.
- **C · `packages/web/src/lib/audio/modules/noise.test.ts:145-146` — "steady-state RMS is ~0.4".**
  It is **0.2569**.
- **D · a VACUOUS TEST.** `noise.test.ts:110-119` says *"Voss-McCartney can excursion … peaks can
  briefly exceed ±1"*. That is **mathematically impossible**: 16 rows + 1 white, each in [−1,1),
  divided by 17, is hard-bounded by 1. Measured over 400 × 2 s buffers: **0 samples exceed 1.0**,
  peak **0.711**. The assertion `outOfRange/N < 0.001` **cannot fail for the stated reason** — it
  is the CLAUDE.md "gate that cannot fail is decoration" pattern, in the unit lane.
- **E · doc vs code on brown.** `noise.ts:32, 79` and `module-manifest.ts:680` claim a flat
  "−6 dB/oct, heavy low-frequency content". **Below ~77 Hz brown is white, not brown** (measured
  −1.01 dB/oct over 20–100 Hz), and **that corner is sample-rate dependent.** Neither the doc nor
  the comment mentions the pole. noise is in `STRICT_DOCS`.
- **F · an undisclosed loop-seam click on brown.** `noise.ts:13-16` asserts the 2 s seam "is
  inaudible because noise is by definition aperiodic". True for white (the seam step exceeds the
  buffer's own largest step in **0/200** seeds) and near-true for pink (**29/200**) — but brown's
  integrator restarts from `last = 0` each loop, so the seam step exceeds the buffer's **largest
  ordinary step in 169/200 seeds** (seam |Δ| 0.135 vs max ordinary |Δ| 0.070).
  **INFERENCE (well-supported, not auditioned): a 0.5 Hz broadband tick on the brown tap.**
- **G · pink DC and 0.5 Hz breathing.** No DC blocker anywhere. Per-instance pink DC has
  σ = **0.0364 (−28.8 dBFS)**, worst-of-200 **0.0843**, because the slow Voss rows never average
  out over one buffer. And pink's first 32 768 samples read **0.1205** RMS against a **0.1378**
  tail — a **1.16 dB LF ramp-in repeating every 2 s** while the rows refill. **INFERENCE:**
  marginal audibility, but it is real non-stationarity the docs deny.
- **H · the card re-types the def's range.** `packages/web/src/lib/ui/modules/NoiseCard.svelte:28`
  hardcodes `min={0} max={1} defaultValue={0.5} curve="linear"`, duplicating `noise.ts:67`, on the
  same screen as `:14`, which *correctly* reads `noiseDef.params[0]!.defaultValue`. Currently
  consistent — the latent form of the backdraft class.

**Not wrong, worth noting:** `noise.ts:143` ("No inputs declared. Map is intentionally empty") is
accurate, as is the `Math.random()` claim at `:6`.

---

## 6. COST — if it ships anyway

| | |
|---|---|
| **contract-lock** | +1 line (`noise family noise-taps kind=cell prefix=noise-taps`). 5 → 6. |
| **ART** | none from the face. **§5-A/B/E are real DSP claims that ART cannot see** — the three pinned baselines (`art/baselines/noise/{white,pink,brown}.f32`) exist, but the slope tolerance is ±2 dB/oct and the RMS floor is `> 0.005`, so both the brown corner and the 1.12 peak sail through. |
| **VRT — ⚠ REQUIRED LANE** | `noise` is in `STRICT_VRT_MODULES`, both platforms. A face adds `face-noise-{compact,dock}` × 2 = 4 informational baselines; a *card* change re-captures the two required ones. |
| **the honest bottom line** | one fader, one glyph, four new baselines and a required-lane re-capture, for a module whose four tiers are identical. **That is the arithmetic behind the recommendation in §2.** |
