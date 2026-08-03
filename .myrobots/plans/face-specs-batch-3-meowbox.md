# FACE SPEC — `meowbox` (batch 3)

**Status:** SPEC + MOCKUP ONLY. PF-20 platform (PR #1301, unmerged). Citations file:line.

**Verdict: PROMOTE — four params, and one of them secretly drives thirteen tables.** ·
archetype: **formant-resonator VOICE with a five-anchor preset morph.**

Not in `STRICT_FACES`; no `face:` block. 4 params, 5 in / 2 out. contract-lock block =
**12 lines** (1 meta + 5 in + 2 out + 4 param). In `STRICT_DOCS` (`strict-docs.ts:164`),
`interactive-doc-modules.ts:119`, and **`STRICT_VRT_MODULES`** (`e2e/vrt/vrt-exemptions.ts:885`)
— the required gate.

---

## 1. WHAT IT ACTUALLY DOES

**It is not a glottal model and it has no vowels.** The `declare description` at
`packages/dsp/src/meowbox.dsp:2` is the honest one: *"morph crossfades 5 anchor presets (kitten,
adult meow, purr, yowl, hiss)"*. There is no vowel table in the file.

- **Source** (`meowbox.dsp:86-90`): four table-lookup sines at F, 2F, 3F, 4F with amplitudes
  1, 0.5, 0.25, 0.125 (peak sum 1.875), blended with `no.noise` (an LCG in ±1) as
  `voicedExc·voicedOf(m) + noise·(1 − voicedOf(m))` (`:98-100`).
- **Tremolo** (`:96`): `1 − 0.4·(1−voiced) + 0.4·(1−voiced)·os.osc(15)` — a **fixed 15 Hz AM
  applied only to the voiced path**, depth `0.4·(1 − voicedOf(m))`. Always on: 0.06 at the
  default morph.
- **Formants** (`:103-106`): three parallel `fi.resonbp(fN, qN, 1.0)` summed with weights `aN`.
  `resonbp` is `tf2s(0, gain, 0, 1/Q, 1, 2π·fc)` (`filters.lib:2263-2271`), so
  **|H(fc)| = gain·Q exactly** (verified numerically against the exact bilinear coefficients:
  10.0000 at Q=10, 14.0000 at Q=14). **The effective peak gain of band N is `aN(m)·qN(m)`, not
  `aN(m)`** — which is the fact §4-B exists to expose.
- **The morph** (`:44-63`): `mIdx = clamp(0,4, m·4)`, `mSeg = int(mIdx)`, `mFrac = mIdx − mSeg`,
  `xfade(g,m) = g(mSeg)·(1−mFrac) + g(mSeg2)·mFrac` — **linear in Hz, not in log-frequency**,
  over **thirteen** tables (`:29-41`). One knob moves F1/F2/F3, Q1/Q2/Q3, A1/A2/A3, `voiced`,
  `riseAmt`, `fallAmt` and `decayScale` together.
- **Envelopes.** `ampEnv = en.adsr(0.005, 0.05, 0.4, decay·decayScaleOf(m), g)` (`:109`) — Faust's
  `adsr` is **linear-segment** and **sustains at 0.4 while the gate is non-zero**. Pitch contour
  (`:78-82`): `en.are(0.03,0.08,g)·riseAmt·12 − en.adsr(0,0.25,0,decay·decayScaleOf(m),g)·fallAmt·12`.
  `en.are` is exponential and **sustains at 1.0** (`envelopes.lib:582-589, 652`). Net: the note
  starts `−fallAmt·12` semitones flat, sweeps up, and **settles `+riseAmt·12` semitones sharp and
  stays there** — see §4-C, this is the module's most surprising behaviour.
- **Stereo** (`:113-117`): `R = de.fdelay(48, (1−ampEnv)·0.6·48, L)` — R is L delayed by
  0–28.8 samples (0–0.6 ms), *inversely* to the envelope. Not a decorrelated voice.

**Resolved anchor table** (computed from `meowbox.dsp:29-41`):

| morph | F1 | F2 | F3 | Q1/Q2/Q3 | peak gain a·Q | voiced | rise/fall (st) | decayScale |
|---|---|---|---|---|---|---|---|---|
| 0.00 kitten | 700 | 1900 | 3000 | 12/14/12 | 12 / 11.9 / 6.0 | .85 | +3.00 / −2.64 | 0.7 |
| **0.25 default** | **450** | **1300** | **2700** | 10/12/12 | **10 / 8.4 / 4.8** | .85 | **+1.80 / −2.16** | **1.0** |
| 0.50 purr | 180 | 350 | 800 | 6/8/8 | 6 / 4.8 / 2.4 | .60 | 0 / 0 | 1.5 |
| 0.75 yowl | 380 | 1100 | 2400 | 14/16/14 | 14 / 13.6 / 8.4 | .80 | +0.96 / −1.68 | 2.0 |
| 1.00 hiss | 100 | 4500 | 8000 | 0.5/8/8 | **0** / 5.6 / 4.0 | .15 | 0 / 0 | 0.6 |

---

## 2. THE CONTROLS THAT MATTER — four params, and no loser

| rank | control | why |
|---|---|---|
| 1 | `morph` | **the only timbre control on the module**, and it drives thirteen tables at once (`:51-63`). Everything the module can sound like is on this one fader. |
| 2 | `pitch` | ±36 st, summed with the V/oct volts inside one `pow(2,·)` (`:72`). |
| 3 | `decay` | the ADSR release **and** the pitch-fall term's release (`:80, :109`), multiplied by `decayScaleOf(morph)` — so it is not a seconds value, which §4-D says out loud. |
| 4 | `level` | a scalar on L only (`:116`); R inherits it through the delay. |
| 5 | `meowbox-strike-{n}` | **NEW — the audition.** The module is silent until a gate arrives (§3) and the card has no button. |

**Losers: none — four params fit the six-cell lane with two slots spare**, one of which goes to
the audition. What loses is the *presentation*: four peer knobs in one row
(`packages/web/src/lib/ui/modules/MeowboxCard.svelte:30-37`) presents a thirteen-table morph and
an output trim as equals.

---

## 3. INERT AT SPAWN

**Everything.** With no gate cable `g = 0` → `ampEnv = 0` → `leftCh = 0` and
`rightCh = fdelay(…, 0) = 0`; the factory feeds a `ConstantSource` at 0 into both merger channels
(`packages/web/src/lib/audio/modules/meowbox.ts:132-136`), so the DSP runs and is silent. Also:
`max(0.5, …)` on Q (`meowbox.dsp:54-56`) is **dead code** — the table minimum is already 0.5, and
a lerp of two values ≥ 0.5 is ≥ 0.5, so the clamp can never bind. At `morph = 1.0` exactly,
`a1Of = 0` (`:35`) so F1/Q1 are inert — but **not** in (0.75, 1.0), where they still steer the
interpolation.

---

## 4. THE FACE

```ts
face: {
  title: 'Voice',
  hint:
    'Four harmonic sines and a noise bed through three resonant band-passes. MORPH is not a tone ' +
    'knob — it crossfades FIVE anchor presets, moving all three formant frequencies, all three Qs, ' +
    'their weights, the voiced/noise balance, the pitch contour AND the decay scale together.',

  order: ['morph', 'pitch', 'decay', 'level', 'meowbox-strike-{n}', 'meowbox-hero-{n}'],
  pages: [
    { id: 'morph', label: '1 · morph — the five anchors',
      hint: 'kitten · adult · purr · yowl · hiss, linearly interpolated in Hz between neighbours',
      controls: ['meowbox-hero-{n}', 'meowbox-strike-{n}', 'morph'] },
    { id: 'note',  label: '2 · note',
      hint: 'V/OCT plus PITCH in one exponent — but the contour settles SHARP of it, by an amount MORPH sets',
      controls: ['pitch'] },
    { id: 'out',   label: '3 · length · out',
      hint: 'DECAY is a time constant scaled by MORPH, not a duration; R is L delayed by up to 0.6 ms, so mono-summing combs',
      controls: ['decay', 'level'] },
  ],
  glyph: 'scope',

  hero: {
    cell: 'meowbox-hero-{n}', control: 'morph', action: 'meowbox-strike-{n}',
    readouts: [
      { label: 'formants', valueId: 'meowbox-formants' },
      { label: 'settles',  valueId: 'meowbox-settled-hz' },
      { label: 'length',   valueId: 'meowbox-length-ms' },
    ],
  },

  sidebar: [
    { kind: 'signal-flow', label: 'signal flow', stages: [
      { label: 'GATE',        role: 'generator', note: 'sustains at 0.4' },
      { label: 'PITCH CONTOUR', role: 'generator', parallel: true, note: 'settles sharp' },
      { label: '4 SINES',     role: 'generator', note: 'F · 2F · 3F · 4F' },
      { label: 'NOISE',       role: 'generator', note: 'LCG' },
      { label: 'VOICED MIX',  role: 'bus', note: 'from MORPH' },
      { label: '15 Hz TREMOLO', role: 'bus', note: 'voiced path only' },
      { label: 'F1 · F2 · F3', role: 'bus', note: '3 × resonbp' },
      { label: 'AMP ADSR',    role: 'bus', note: 'sustain 0.4' },
      { label: 'R = DELAYED L', role: 'bus', parallel: true, note: '0–0.6 ms' },
    ] },
    { kind: 'custom', label: 'formant map', panelId: 'formant-map',
      props: { bands: 3, paramId: 'morph' } },
    { kind: 'readouts', label: 'derived', entries: [
      { label: 'peak gain F1/F2/F3', valueId: 'meowbox-formant-gain' },
      { label: 'tremolo depth',      valueId: 'meowbox-tremolo' },
      { label: 'mono-sum null',      valueId: 'meowbox-comb-null' },
    ] },
  ],
}
```

---

## 5. DERIVED READOUTS

### A. `meowbox-formants` — the resolved F1 / F2 / F3 in Hz
```
fN(m) = fNAt(⌊4m⌋)·(1 − frac(4m)) + fNAt(min(4, ⌊4m⌋+1))·frac(4m)     # meowbox.dsp:29-31, :44-53
```
**NEGATIVE CONTROL:** set morph = 0.375. F1 = **315 Hz**, F2 = **825 Hz** — values that appear in
**no table row**. A knob readback prints `0.375` and cannot express that you are mid-glide between
two anchors; the resolved triple is the only surface that can.

### B. `meowbox-formant-gain` — the effective peak gain, and it is NOT the amplitude table
```
peak_N(m) = aN(m) · qN(m)   in dB      # meowbox.dsp:104-106 + filters.lib:2263-2271, |H(fc)| = gain·Q
```
**NEGATIVE CONTROL — morph 0.5 → 0.75.** `A1` is **1.0 at both endpoints and everywhere between**
(`meowbox.dsp:35`), so a readout of the amplitude table is *flat across that entire move* — while
the F1 peak goes 6 → 14, **+7.4 dB**, because Q1 goes 6 → 14. **Any readout that reads the `a`
table alone is blind by construction**, and that blindness is invisible from its output.

### C. `meowbox-settled-hz` — where the note ends up, which is not where you asked
```
f_sus = 261.6256 · 2^(pitchVolt + pitchSemi/12) · 2^(riseAmtOf(morph))   # meowbox.dsp:72, :79, :82
```
At the factory defaults (0 V, 0 semi, morph 0.25): onset = 261.63·2^(−0.18) = **230.9 Hz**,
sustain = 261.63·2^(0.15) = **290.3 Hz**. **The module never settles on the notated pitch — it
ends 1.80 semitones sharp.**
**NEGATIVE CONTROL:** move MORPH 0.25 → 0.50. `riseAmt` → 0, so the sustained fundamental drops
290.3 → 261.6 Hz — **a real 1.8-semitone pitch change caused by the timbre knob**, with the PITCH
knob reading 0 in both states.

### D. `meowbox-length-ms` — the note's real length
```
t_total ≈ max(gateHighSec, 0.055) + decay · decayScaleOf(morph)      # meowbox.dsp:41, :109
```
**NEGATIVE CONTROL:** hold DECAY at 0.40 s and move morph 0.25 → 0.75. The tail goes
**0.40 s → 0.80 s** (2×); at morph 1.0 it is 0.24 s. **The DECAY knob's own "0.40 s" caption is
correct at exactly one morph position** out of a continuum. Full reachable range 0.03 s → 4.0 s.

### E. `meowbox-tremolo` / `meowbox-comb-null` — two smaller ones with clean controls
`tremolo_depth = 0.4·(1 − voicedOf(morph))` (`:96`) — **NEGATIVE CONTROL:** it must be *maximal*
at hiss and *minimal* at kitten, which is the opposite of what the source comment claims (§6-B).
`f_null1 = 1 / (2·(1−ampEnv)·0.6·0.001)` (`:113-117`) → **833 Hz idle, 1389 Hz at sustain, ∞ at
the envelope peak** — **NEGATIVE CONTROL:** it moves with the *envelope*, so no panel control
moves it at all; a readout that responded to a knob would be measuring something else.

---

## 6. BESPOKE CELL, RANGES, AND WHAT IS ALREADY WRONG

**LEGITIMATE — `meowbox-hero-{n}`:** the three resonance peaks drawn on a log-frequency axis with
the four source partials marked underneath, so "which harmonic is inside which formant" is
visible. §5-B's Q-vs-amplitude fact becomes a picture. **LEGITIMATE — `formant-map`**, a `custom`
sidebar panel: the five anchors as ticks with the current interpolation between two of them
(generic: `props { bands, paramId }`).

**RANGES — no change proposed.** ⚠ The card **re-types every range** and **is not in
`RANGE_BOUND_CARDS`** (`packages/web/src/lib/ui/modules/card-range-source.test.ts:71-78`), so the
source-level guard is blind to it. The numbers agree; two other things do not: `units="st"`
(`MeowboxCard.svelte:32`) vs def `units: 'semi'` (`meowbox.ts:94`), and labels
`"Pitch"`/`"Decay"`/`"Level"` (`:32,34,35`) vs def `'Ptch'`/`'Dcy'`/`'Lvl'` — **the doc page
prints one set and the card another.**

**ALREADY-WRONG:**
- **A · `meowbox.dsp:26` contradicts `:29` and `:32`.** The comment says hiss `F=(0,…)`, `Q=(0,…)`;
  the tables say `100.0` and `0.5`. Not cosmetic: at morph 0.875 the interpolated F1 is **240 Hz
  actual vs 190 Hz if the comment were true (26 % error)**, and it feeds every F1 readout in
  (0.75, 1.0).
- **B · `meowbox.dsp:92-95` is backwards.** *"Strength scales with `voicedOf(m)` so non-purr
  presets aren't affected"* — `:96` scales the depth by `(1 − voicedOf(m))`, i.e. **inversely**.
  Depth is 0.16 at purr and **0.34 at hiss** — maximal exactly where the comment claims minimal.
- **C · `meowbox.dsp:111-112` "delayed by up to 1 ms"** — the `·0.6` at `:114` caps it at
  **0.6 ms**.
- **D · `meowbox.dsp:74-77` "a fast rise + slow fall … then it falls toward 0"** — `en.are`
  sustains at 1.0 (`envelopes.lib:652`), so under a held gate the offset **stays** at
  `+riseAmt·12` and never falls until release. §4-C is the consequence.
- **E · vowels do not exist.** `meowbox.ts:28, 102, 116` all claim "vowel" and "the a/e/i/o/u
  regions". The DSP crossfades five *cat* presets (`meowbox.dsp:2, 17-27`). **The def's own
  `docs.explanation` names a taxonomy the source does not implement**, and meowbox is in
  `STRICT_DOCS`.
- **F · `docs.inputs.gate` is factually inverted** (`meowbox.ts:104`): *"It responds to the edge,
  not how long the level stays up — the meow's length comes from the Decay control."* `ampEnv` is
  an `en.adsr` with **sustain level 0.4** (`meowbox.dsp:109`), so length = gate-high time +
  release. It is a **gate** consumer, not a trigger. Compounding: Faust's `adsr` uses
  `atime = +(gate) ~ *(gate' >= gate)` (`envelopes.lib:226`), so **a gate at level 0.5 runs the
  attack and decay at half speed**, and release fires only on `gate == 0` — the repo's
  `GATE_HI = 0.5` threshold (`packages/web/src/lib/audio/gate-trigger.ts:24`) is never applied.
  `module-manifest.ts:581` repeats the error ("Trigger.").
- **G · why nothing catches F:** the def declares **no `edge:`**, and
  `module-docs-lint.test.ts:217` does `if (!p.edge) continue`. **The one gate that owns this
  vocabulary is structurally unable to see it.** Declare `edge: 'gate'`.
- **H · `module-manifest.ts:582`** `'meowbox.pitch': 'CV -> pitch.'` is stale — the port is
  `pitch`/V-oct since the schema-v2 change (`meowbox.ts:7-13`).
- **I · `docs.outputs.L`: "summing to mono is fine"** (`meowbox.ts:111`) — R is a delayed copy of
  L, so mono-summing combs at 833 → 1389 Hz **through the formant region**, and the null moves
  with the envelope.
- **J · stale CV LUT:** the `decay` `cvScale` chain bakes `liveKnob` at edge-attach time
  (`engine.ts:438-444`), so turning DECAY *after* patching its CV leaves the multiplicative
  scaling centred on the old value.

---

## 7. COST

| | |
|---|---|
| **contract-lock** | **+2 lines** (`meowbox family meowbox-hero kind=cell …`, `… meowbox-strike kind=other …`) **+1 modified** if `edge: 'gate'` ships. 12 → 14. Both families need `docs.controls` keys (STRICT_DOCS). |
| **ART** | none. meowbox is on `ART_BACKLOG` (`art/setup/profile-coverage.ts:26`) — **no `.f32` audio profile exists**; both ART scenarios are SHA/toolchain checks and an *OscillatorNode stand-in*, never the real worklet (`art/scenarios/meowbox/voct-tracking.test.ts:98-112, 146-151`). Worth reporting on its own: a module in the required VRT lane with no audio pin. |
| **VRT — ⚠ REQUIRED LANE** | **`meowbox` is in `STRICT_VRT_MODULES`** (`e2e/vrt/vrt-exemptions.ts:885`) with baselines on **both** platforms. A card gaining a strike button re-captures both, in the same PR. New face scenes add 4 more (informational lane). |
| **e2e** | +1 `faces-parity` row (6 cells), REQUIRED lane. |
