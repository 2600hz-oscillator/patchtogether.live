# FACE SPEC — `pentemelodica` (batch 3)

**Status:** SPEC + MOCKUP ONLY. PF-20 platform (PR #1301, unmerged). Citations file:line.

**Verdict: PROMOTE — and it is the batch's hardest layout problem, because 48 params in five
identical strips is the one shape `face.order` cannot express.** · archetype:
**five-voice polyphonic synth VOICE** (a sink for a chord bus, not a generator).

⚠ **FRAMING CORRECTION, load-bearing:** pentemelodica is **not** a melodic generator, a sequencer
or a quantiser. There is no scale table, no pentatonic anything, no PRNG, no clock, no step
engine. A grep of the def, worklet, DSP lib and card for
`pentatonic|SCALE|quantis|degree|random|seed|clock|bpm|tempo|step` returns **zero hits outside
the prose**. The name is a pun on *five* — `PENTE_VOICES = 5`
(`packages/dsp/src/lib/pentemelodica-dsp.ts:67`). It is closer to CUBE or DX7 than to a sequencer
(`packages/web/src/lib/audio/modules/pentemelodica.ts:3-25`).

Not in `STRICT_FACES`; no `face:` block. **48 params**, 6 in / 7 out. contract-lock block =
**63 lines** (48 param + 7 out + 6 in + 1 stereo + 1 meta). In `STRICT_DOCS`
(`strict-docs.ts:168`). VRT: two scenes, **both darwin-only**, via two *different* gap mechanisms.

---

## 1. WHAT IT ACTUALLY DOES

Per sample, per voice (`renderPentemelodica`, `pentemelodica-dsp.ts:296-388`):

- **Block preamble** (`:308-324`): filter coefficients `g = tan(π·fc/sr)`
  (`packages/dsp/src/lib/resofilter-dsp.ts:82-87`) and `k = max(0.003, 2 − 2·res)` (`:76-79`) once
  per block; then a five-iteration gate-edge loop reading `poly[2v+1] > 0.5` (`:317`), firing
  `env[v].trigger(true/false)` on transitions, and updating a **persistent held V/oct** — tracked
  while gated, **held through release** (`packages/dsp/src/lib/poly-osc-sum.ts:53-55`) so a tail
  does not snap to C4.
- **Pitch selection** — `laneRenderVOct` uses the voice's own held pitch if gated *or* still
  audible, **else lane 0's** (`poly-osc-sum.ts:69-76`). That fallback is invisible on the panel and
  §5-A is the only way to see it.
- **Frequency** — one exponential:
  `f = 261.626 · 2^(voct + tune/12 + fine/1200 + fm·fmIn)`, clamped `[0.01, min(40000, 0.49·sr)]`
  (`:139-151`). **FM is exponential; PM is added to the phase READ only, not the accumulator**
  (`:350-351`). The phase advances **unconditionally**, gated or not (`:358-360`).
- **Waves** — `moogWaves()` emits four polyBLEP/polyBLAMP band-limited taps off one phase
  (`packages/dsp/src/lib/moog-vco-dsp.ts:118-150`); `waveMorph` crossfades tri→saw below 0.5 and
  saw→square above (`:161-172`).
- **Envelope** — one `Envelope.tick()` per voice reading the **single shared A/D/S/R** (`:362`).
- **Sum → filter → out** (`:376-386`): `sumL/R × PENTE_MASTER_GAIN = 0.6` — a **constant,
  deliberately not `1/√N`** (`:263-265`), unlike the sibling helper which does normalise
  (`poly-osc-sum.ts:161`). Then one TPT SVF step per channel and a `modeMorph` blending
  lp → bp → hp → (x − bp) (`:184-197`), then a linear wet/dry.

### The 5×8 problem, stated plainly

Forty of the forty-eight params are **five identical strips of eight**
(`v{1-5}_{tune,fine,fm,pm,pw,wave,level,pan}`). `face.order` is a flat priority list and
`face.pages` is a flat band list; **neither can express "this group, five times"**. The
consequences are arithmetic, not taste:

- Five voice bands + an envelope band + a filter band = **7 bands**, and
  `DOCK_TAB_MIN_BANDS = 7` (`packages/web/src/lib/ui/workflow/dock-tabs-model.ts:46, 62`) — **at
  exactly seven the whole faceplate collapses into a TAB RAIL.** That is not a hypothetical: it is
  the boundary condition, hit precisely.
- The lane budget is six (`curated-face.ts:46, 65`), so **at most six of forty-eight controls ever
  reach a lane tile**, and any six chosen from five symmetric strips are arbitrary in the same way
  bluebox's keypad ranks are arbitrary.

**This face therefore takes the tab rail deliberately** rather than merging voices into a band
that would fuse five different ideas — and it ranks the *global* controls, not voice 1's, because
voice 1 is not more important than voice 4.

---

## 2. THE CONTROLS THAT MATTER

| rank | control | why |
|---|---|---|
| 1 | `cutoff` | the one control that acts on **all five voices at once** and is the module's principal timbre. |
| 2 | `resonance` | rank 2 not for the usual reason but because it **silently sets the notch depth** (§5-C) — it is two controls. |
| 3 | `mode` | which of four filter responses the whole instrument has. |
| 4 | `wetdry` | the filter's authority; at the shipped 1.0 the dry path is gone entirely. |
| 5 | `attack` | the shared amp attack — the only envelope stage that is live at defaults. |
| 6 | `release` | the shared tail. ⚠ its knob value is a **time constant**, not a duration (§5-D). |
| — | *lane budget ends* | |
| 7 | `pente-voices-{n}` | the picture: five voice strips at a glance. |
| 8-9 | `sustain`, `decay` | `decay` is **inert at the shipped `sustain = 1`** (§3). |
| 10+ | the forty voice params | five tab bands of eight. |

**LOSERS, named:**
- **All forty voice params lose the lane**, and there is no honest alternative: promoting
  `v1_tune` would say voice 1 matters more than voice 4, which the DSP does not (lanes map
  fixed 1:1 with no allocator, `pentemelodica.ts:196`).
- **`decay` loses to `release`** because at the shipped `sustain = 1` the Decay branch hits
  `|value − susTarget| < 1e-4` on its **first tick** and jumps straight to Sustain
  (`packages/dsp/src/lib/adsr-env.ts:74-84`) — **zero samples of decay ever run.**
- **`v*_fm` / `v*_pm` (10 params) lose everything**: they multiply the `fm{N}` inputs, which are
  unpatched at spawn — formally exempted for that reason at
  `e2e/tests/per-module-per-port-behavioral.spec.ts:1028-1032`.
- **`v*_pw` (5 params) lose**: the rectangular tap's weight is zero for `wave < 0.5`
  (`moog-vco-dsp.ts:166-169`) and `wave` ships at 0.

---

## 3. INERT AT SPAWN — the module makes NO sound, and that is worth saying on the face

**All 48 params are inert on a bare spawn.** With nothing patched, input 0 carries only the
0-offset `ConstantSource` keep-alive (`pentemelodica.ts:289-292`), so `polyScratch` is all zeros,
`gated` is false for every lane (`pentemelodica-dsp.ts:317`), `trigger()` never fires, every
envelope stays `Idle` returning 0, and **all seven outputs are exactly silence.** There is no
drone and no free-run — explicitly unlike CUBE and WAVECEL, which *do* drone when ungated
(`per-module-per-port-behavioral.spec.ts:1044-1050`). **It requires an external poly gate
source.** CPU cost is nonetheless constant: the phase accumulators and SVF state advance every
sample regardless.

Even *with* a chord patched, **16 of 48 are dead at defaults**: 10 FM/PM, 5 PW, and `decay`.

---

## 4. THE FACE

```ts
face: {
  title: 'Poly voice',
  hint:
    'Five band-limited oscillators, one shared amp envelope, one shared filter. It makes NO sound ' +
    'on its own — it needs a poly gate source. An ungated voice borrows lane 1\'s pitch, and the ' +
    'sum is scaled by a CONSTANT, so five notes are 4.6 dB hotter than one.',

  order: [
    'cutoff', 'resonance', 'mode', 'wetdry', 'attack', 'release',   // 1-6 = the lane budget
    'pente-voices-{n}',
    'sustain', 'decay',
    // the five strips, in lane order
    'v1_tune','v1_fine','v1_wave','v1_pw','v1_level','v1_pan','v1_fm','v1_pm',
    'v2_tune','v2_fine','v2_wave','v2_pw','v2_level','v2_pan','v2_fm','v2_pm',
    'v3_tune','v3_fine','v3_wave','v3_pw','v3_level','v3_pan','v3_fm','v3_pm',
    'v4_tune','v4_fine','v4_wave','v4_pw','v4_level','v4_pan','v4_fm','v4_pm',
    'v5_tune','v5_fine','v5_wave','v5_pw','v5_level','v5_pan','v5_fm','v5_pm',
  ],
  // ⚠ SEVEN BANDS IS DELIBERATE. DOCK_TAB_MIN_BANDS = 7 (dock-tabs-model.ts:46),
  // so this face renders as a TAB RAIL — which is the right answer for five
  // symmetric strips, and strictly better than merging voices into one band
  // that would fuse five different ideas. State it here so the next author does
  // not "fix" it back to six.
  pages: [
    { id: 'filter', label: 'filter · envelope',
      hint: 'ONE filter and ONE ADSR shared by all five voices — DECAY is inert while SUSTAIN is 1',
      controls: ['pente-voices-{n}','cutoff','resonance','mode','wetdry','attack','decay','sustain','release'] },
    { id: 'v1', label: 'voice 1', hint: 'lane 1 of the poly bus — and the pitch every ungated voice falls back to',
      controls: ['v1_tune','v1_fine','v1_wave','v1_pw','v1_level','v1_pan','v1_fm','v1_pm'] },
    { id: 'v2', label: 'voice 2', hint: 'lane 2 — fixed 1:1, there is no voice allocator',
      controls: ['v2_tune','v2_fine','v2_wave','v2_pw','v2_level','v2_pan','v2_fm','v2_pm'] },
    { id: 'v3', label: 'voice 3', hint: 'lane 3 — PW is silent until WAVE passes 0.5',
      controls: ['v3_tune','v3_fine','v3_wave','v3_pw','v3_level','v3_pan','v3_fm','v3_pm'] },
    { id: 'v4', label: 'voice 4', hint: 'lane 4 — FM and PM need a cable on this voice\'s own fm jack',
      controls: ['v4_tune','v4_fine','v4_wave','v4_pw','v4_level','v4_pan','v4_fm','v4_pm'] },
    { id: 'v5', label: 'voice 5', hint: 'lane 5 — each voice also has its own pre-level, pre-pan tap',
      controls: ['v5_tune','v5_fine','v5_wave','v5_pw','v5_level','v5_pan','v5_fm','v5_pm'] },
  ],
  glyph: 'scope',

  hero: {
    cell: 'pente-voices-{n}', control: 'cutoff',
    readouts: [
      { label: 'sounding',  valueId: 'pente-sounding' },
      { label: 'mode gain', valueId: 'pente-mode-gain' },
      { label: 'peak',      valueId: 'pente-peak-db' },
    ],
  },
  sidebar: [
    { kind: 'signal-flow', label: 'signal flow', stages: [
      { label: 'POLY BUS',    role: 'generator', note: '5 lanes, fixed' },
      { label: '5 × OSC',     role: 'generator', note: 'polyBLEP' },
      { label: 'FM',          role: 'bus', parallel: true, note: 'exponential' },
      { label: 'PM',          role: 'bus', parallel: true, note: 'phase read only' },
      { label: '5 × ADSR',    role: 'bus', note: 'ONE shared shape' },
      { label: 'LEVEL · PAN', role: 'bus', note: 'equal power' },
      { label: 'SUM ×0.6',    role: 'bus', note: 'CONSTANT, not 1/√N' },
      { label: 'SVF · MODE',  role: 'bus', note: 'lp→bp→hp→x−bp' },
      { label: 'WET / DRY',   role: 'bus', note: 'linear' },
    ] },
    { kind: 'readouts', label: 'envelope, really', entries: [
      { label: 'release tail', valueId: 'pente-release-ms' },
      { label: 'decay to S',   valueId: 'pente-decay-ms' },
    ] },
    { kind: 'readouts', label: 'per-voice pitch', entries: [
      { label: 'voice 1', valueId: 'pente-v1-note' }, { label: 'voice 2', valueId: 'pente-v2-note' },
      { label: 'voice 3', valueId: 'pente-v3-note' }, { label: 'voice 4', valueId: 'pente-v4-note' },
      { label: 'voice 5', valueId: 'pente-v5-note' },
    ] },
  ],
}
```

---

## 5. DERIVED READOUTS

### A. `pente-vN-note` — the resolved sounding pitch per voice
```
f_v = 261.626 · 2^(voct_v + tune_v/12 + fine_v/1200)          # pentemelodica-dsp.ts:146
voct_v = own held pitch if gated-or-ringing, ELSE lane 0's    # poly-osc-sum.ts:69-76
```
**NEGATIVE CONTROL:** change the incoming chord's octave without touching a knob. **Every knob
readback is invariant to the played note**; the resolved Hz/name moves a full octave.
**Second leg, and it is the important one:** with nothing gated, **voice 3's resolved pitch must
display lane 0's pitch, not its own.** A per-voice-knob readout is structurally incapable of
showing that fallback, and the fallback is the single most confusing behaviour in the module.

### B. `pente-detune-beat` — the beat rate a FINE knob cannot express
```
beat_Hz = f · | 2^(Δst/12 + Δ¢/1200) − 1 |
```
**NEGATIVE CONTROL:** the FINE knob is **invariant to register**; the beat rate is not. A fixed
+10 ¢ beats at **0.38 Hz at C2, 1.52 Hz at C4, 6.06 Hz at C6**. Move only the played octave: the
readback freezes, the derived number moves **16×**.

### C. `pente-mode-gain` — the most valuable readout, and it exposes a live bug
```
segments: m3 = 3·mode, seg = min(2, ⌊m3⌋), t = m3 − seg       # :190-192
corners : LP / BP / HP / "notch" at 0, ⅓, ⅔, 1               # pinned pentemelodica-dsp.test.ts:110-121
gain at cutoff, MODE = 1 :  | 1 − 1/(2 − 2·resonance) |
```
That closed form exists because **pentemelodica's mode-1 tap is `x − bp` while the true SVF notch
is `lp + hp = x − k·bp`** (`resofilter-dsp.ts:41, 118`). Measured (matches the closed form to 4 dp):

| res | k | gain at fc | dB |
|---|---|---|---|
| 0 | 2.000 | 0.500 | −6.0 |
| **0.2 (default)** | 1.600 | **0.375** | **−8.5** |
| 0.5 | 1.000 | 0 | **true null** |
| 0.8 | 0.400 | 1.500 | +3.5 |
| **0.99** | 0.020 | **49.0** | **+33.8** |

**NEGATIVE CONTROL — turn RESONANCE.** Both dials read "Notch, max reso" at res 0.99, and the
filter is a **49× resonant boost on the master bus** — the exact opposite of a notch. **A readout
that is a function of MODE alone is invariant to RESONANCE and cannot see any of it.**

### D. `pente-release-ms` / `pente-decay-ms` — the knobs are time CONSTANTS, not durations
```
tail_s     = release · ln(sustain / 1e-5)                     # :117-123
decay_to_S = decay   · ln((1 − sustain) / 1e-4)               # :105-113
```
At the shipped defaults (r = 0.005, s = 1) the actual tail is **58 ms — 11.5× the labelled 5 ms**.
At d = 0.1, s = 0.7 the decay takes **0.80 s, 8× the label**.
**NEGATIVE CONTROL:** drop SUSTAIN 1.0 → 0.1 without touching RELEASE. The release readback is
frozen; the derived tail moves 58 → 46 ms. At sustain 0 the tail is ~0 while the knob still says
0.005 s.

### E. `pente-peak-db` — the headroom nobody guards
```
peak = 0.6 · Σ_gated ( level_v · cos((pan_v + 1)·π/4) )       # :369-377, PENTE_MASTER_GAIN :263-265
```
Five gated voices at defaults = **1.697 = +4.59 dBFS**; one voice = 0.339. There is **no `1/√N`**.
**NEGATIVE CONTROL:** gate a 4th and 5th note. **No knob moves**, and the peak climbs
1.018 → 1.358 → 1.697 through clipping. **Second leg:** spread PAN — `peak_L` falls with every
LEVEL unchanged.

### F. `pente-sounding` — gated vs sounding
`gated = poly[2v+1] > 0.5` (`:317`) vs `sounding = gated || env > 0` (`:337`).
**NEGATIVE CONTROL:** release the chord. Gated drops to 0 instantly; **sounding stays 5 for the
tail.** A gate-count readout is invariant to release length.

---

## 6. BESPOKE CELL, RANGES, AND WHAT IS ALREADY WRONG

**LEGITIMATE — `pente-voices-{n}`:** five compact strips, each showing its single-cycle waveform
(the card already draws exactly this, `PentemelodicaCard.svelte:62-108`, an 84×40 static preview
from the real `moogWaves`/`waveMorph`, redrawn by `$effect` with **no rAF** so VRT needs no mask),
plus a lit/unlit gate lamp, the resolved note name and the pan position. It makes §5-A and §5-F
visible at once. **NOT LEGITIMATE:** anything else — the flow, the readouts and the per-voice note
list are platform blocks.

**RANGES — no change proposed.** ⚠ The card **re-types 44 of 48 ranges** as literals
(`PentemelodicaCard.svelte:137-142, 154-155, 185-188`); only the ADSR block imports from the def
(`:48-53`, used at `:166-169`). All twelve distinct literal ranges currently **match**. Convert to
`paramSpec()` and add pentemelodica to `RANGE_BOUND_CARDS`.

**ALREADY-WRONG:**
- **A · the notch is not a notch, and the comment says the wrong identity.**
  `pentemelodica-dsp.ts:179` comments *"notch = x − bp (the SVF identity)"* — the identity is
  `x − k·bp` (`resofilter-dsp.ts:41`). The docs promise "…high-pass → notch"
  (`pentemelodica.ts:265`); §5-C measures **−8.5 dB at the default and +33.8 dB at res 0.99**.
  **The sibling module in the same repo does it correctly** (`resofilter-dsp.ts:118`). A lying
  comment, a real DSP defect and a master-bus gain hazard, in one place.
- **B · "a single mono note source only lights one voice" is FALSE** (`pentemelodica.ts:196`,
  repeated `:198` and `module-manifest.ts:423`). A mono `pitch`/`cv`/`audio` → poly merges into
  **input 0 = channel 0 = lane 0 PITCH**; channel 1 (lane 0's *gate*) gets no source
  (`packages/web/src/lib/audio/poly.ts:395-405`) ⇒ gate = 0 ⇒ the envelope never triggers ⇒
  **total silence**. Only a mono **`gate`** source (`poly.ts:406-415`, `mergeInputs: [1]`) opens
  voice 1 — and then at 0 V/oct = C4 regardless of any pitch.
- **C · `decay` documented as "the fall from the attack peak down to the sustain level"**
  (`:259`) — at the shipped `sustain = 1` there is no fall; it ships **inert**.
- **D · `release` documented as "how long each voice takes to fade out"** (`:261`) — it is a time
  constant and the tail is **11.5× longer** (§5-D). Same for decay.
- **E · stale comment:** `pentemelodica.test.ts:5` says "60 params"; the assertion below it says
  48 (`:17-19`).
- **F · no headroom protection**, and the constant master gain is admitted to have been chosen for
  *baseline determinism*, not level (`pentemelodica-dsp.ts:263-264`).
- **G · zero `edge:` declarations.** Gate semantics live in the poly bus channel layout,
  thresholded at 0.5 (`:317`), never declared on a `PortDef`.

**Verified correct (no bug):** the `voiceN` taps really are pre-level/pre-pan (`:366` precedes
`:369-373`); FM really is exponential (`:345` inside the pow2) and PM really is through-phase
(`:350-351`); and the card's waveform preview is honestly invariant to PW below wave 0.5, matching
the audio.

---

## 7. COST

| | |
|---|---|
| **contract-lock** | **+1 line** (`pentemelodica family pente-voices kind=cell prefix=pente-voices`). 63 → 64. No param, port or range moves. |
| **ART** | none. No DSP edit. **§6-A is a real DSP defect and its fix is a separate owner-audition PR** — do not fold it into a face wave. |
| **VRT — two darwin-only scenes, two different mechanisms** | the auto per-card scene (`darwin/pentemelodica.png`; linux gap via **mechanism A**, `e2e/vrt/vrt-exemptions.ts:1205`) **and** a MIDI-LANE composite whose linux gap is via **mechanism C**, a blanket `test.skip` at `e2e/vrt/pentemelodica-composite.spec.ts:61`. **No linux baseline exists for either.** A face adds `face-pentemelodica-{compact,dock}` × 2 = 4; capturing linux for them means the vrt-meta ratchet moves, and the two *existing* gaps stay declared unless drained in the same PR. |
| **e2e** | +1 `faces-parity` row, and it is the **most expensive row in the batch: 49 cells** (48 params + 1 family). At the ~0.8 s/cell figure the round-2 specs measured on the SwiftShader runner that is **≈ +39 s on one required-lane shard** — the single largest CI item in this batch and the one to confirm on CI rather than locally. `FACE_PER_CELL_MS` (`e2e/tests/faces-parity.spec.ts:98`) is a derived timeout, so the ceiling self-adjusts, but the wall time does not. |
| **⚠ tab rail** | `workflow-shell-faces.spec.ts` asserts `[data-testid="face-page"]` count == the declared `pages` length. With 6 pages the dock renders a **tab rail** (`DOCK_TAB_MIN_BANDS = 7` is *bands*, and the hero is a slot not a band — **verify which number the tab planner counts before pinning `pages: 6`**). PF-16's decision is that inactive pages are hidden with CSS rather than unmounted, so `evaluateAll`-based assertions still see them; only the per-cell `toBeVisible()` drive loop needs a tab walk. |
