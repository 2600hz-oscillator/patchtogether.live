# FACE SPEC — `warrensspectrum` (batch 5)

## 0. PROVENANCE

Measured against `main` at `153e5c36` (2026-08-10). **BANKED — not built.**

⚠ **NOT the same module as `warrensvisions` (#1475).** That is the VIDEO
analogue — a 2D spectral resynthesizer that shipped as its own module. This
AUDIO module still has no `face:` block and every finding below still stands
(the `resynthLevel` doc sentence in §4-C/§8-A was re-read on `main` 2026-08-12
and is unchanged).

**Verdict: PROMOTE — the largest and the most deserving in the batch. It has TWO
engines behind one control set, and SEVEN of its sixteen controls belong to only
one of them.**

archetype: **the SPECTRAL RESYNTHESIZER** — SMS partial tracking + a noise
residual, plus a second MASSPASS engine, plus an 8-band filterbank.

Not in `STRICT_FACES`; no `face:` block. In `STRICT_DOCS`; **in
`PUSH_CARD_CONTROLS`**; **not** in `STRICT_VRT_MODULES`. 16 params, **1 control
family** (`ws-filterbank`, 8 bands), 9 in, 1 out. `face.order` = **17 keys**.

**Method.** The REAL factory driving the REAL worklet
(`packages/dsp/src/warrensspectrum.ts` → `lib/warrensspectrum-dsp.ts`) under
`node-web-audio-api`'s `OfflineAudioContext`, 48 kHz, C4 saw at −6 dBFS on
`audio_in`, statistics over the tail half of a 2 s render. Determinism control:
`max|run1 − run2| = 0.000e+0`.

---

## 1. WHAT IT IS

Two engines and a bank, all behind one panel:

- **SPECTRAL** (`engineMode = 0`, the default) — SMS: partial tracking →
  additive resynthesis + a 16-band noise residual.
- **MASSPASS** (`engineMode = 1`) — a separate 326-line DSP class.
- **THE FILTERBANK** — 8 resonant bands, crossfaded in by a control the def
  calls `resynthLevel`.

*Measured*, defaults, C4 saw in: `out` peak 0.66685, rms −11.62 dB, centroid
4223 Hz, DC −0.00006. **It is an insert and it passes signal at spawn** — which
is worth stating because two of its three level controls default to 0.

---

## 2. THE CONTROLS — 17 keys, and SEVEN are mode-gated

| rank | key | tier | why |
|---|---|---|---|
| 1 | `engineMode` | mini | **it decides what seven other controls mean** (§4-A). Nothing else on this module comes close. |
| 2 | `spectralPartials` | compact | the thinning: 1 → 12 partials moves rms 2.0 dB and the centroid 261 → 3735 Hz. |
| 3 | `resynthLevel` | plate | the FILTERBANK wet — and **the param id lies** (§4-C). |
| 4 | `inputMix` | plate | the only way to hear the source; linear and honest (Δ = 0.100 per 0.2). |
| 5 | `spectralShape` | plate | 11.4 dB of NON-MONOTONIC level (§4-D). |
| 6 | `gain` | plate | reaches **+8.5 dBFS** (§4-E). |
| 7 | `spectralSlew` | dock | 10.2 dB of level across its range. |
| 8 | `spectralCenter` | dock | ±3600 ¢ of transposition; centroid 1444 → 6967 Hz. |
| 9 | `spectralResidual` | dock | centroid 3680 → 5455 Hz at constant level. |
| 10 | `spectralSlice` | dock | analysis window. |
| 11 | `spectralLock` | dock | |
| 12 | `engineFreeze` | dock | **outputs bit-silence from spawn** (§4-B). |
| 13 | `spectralFloor` | dock | **its bottom 60 % is bit-exactly inert** (§4-F). |
| 14 | `spectralStab` | dock | 16 positions worth `max|Δ| = 5.2e-3` (§4-F). |
| 15 | `spectralBandCount` | dock | **bit-exactly inert in SPECTRAL; fully live in MASSPASS** (§4-A). |
| 16 | `ws-filterbank-{n}` | dock (family) | the 8-band bank — 40 values behind one panel. |
| 17 | `ws-response-{n}` | dock (panel) | the picture — §7. |

⚠ **`engineMode` at rank 1 is the whole design.** It is a 2-position discrete
switch and it is the least "performable" control here — and it is still rank 1,
because a lane tile that shows a knob without showing which of two engines it
addresses is showing a number with no units. This is the deliberate inverse of
`resofilter`'s argument (where MODE ranked 3 because four params render at every
tier anyway). Seventeen keys is not four: here the subset actually is a subset.

⚠ **`ws-filterbank-{n}` is a `ControlFamily`, so it IS selectable at a lane
tier** (`curatedFace` resolves it to `kind: 'family'`) — the drumseqz rule. It is
ranked 16 anyway: eight bands × five values is patch design, the dx7 argument.

**NO AUDITION** — an insert with nothing to strike.

---

## 3. INERT AT SPAWN — three of sixteen, and the reason differs each time

| param | measured | why |
|---|---|---|
| `spectralBandCount` | `Δ = 0.00e+0`, **all six values** | wrong engine (§4-A) |
| `spectralFloor` | `Δ = 0.00e+0` over **−90 … −48 dB** | below the source's noise floor (§4-F) |
| `spectralStab` | `max|Δ| = 5.2e-3` over 16 positions | genuinely near-inert (§4-F) |

---

## 4. WHAT THE FACE MUST MAKE VISIBLE

### A. `spectralBandCount` is BIT-EXACTLY INERT in the default engine, and worth 10.35 dB in the other one

*Measured*, six values, C4 saw:

| `spectralBandCount` | 0 | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|---|
| **`engineMode = 0` (SPECTRAL, default)** rms | −11.62 | −11.62 | −11.62 | −11.62 | −11.62 | −11.62 |
| … centroid | 4223 | 4223 | 4223 | 4223 | 4223 | 4223 |
| … `Δ` vs value 0 | — | **0.00e+0** | **0.00e+0** | **0.00e+0** | **0.00e+0** | **0.00e+0** |
| **`engineMode = 1` (MASSPASS)** rms | −19.88 | −22.13 | −21.89 | −24.75 | −25.97 | **−30.23** |
| … centroid | 953 | 1355 | 1668 | 2230 | 2946 | 2025 |

Bit-identical in one engine, **10.35 dB and 3× of centroid** in the other. It is
an index into `WS_MASSPASS_BAND_COUNTS` (`warrensspectrum-dsp.ts:210`), so this
is a *layout fact*, not a bug — **and it is invisible from the panel**, which
shows a "Bands" knob next to fifteen others.

⚠ **THE SAME SWEEP AT WET = 1 IS ALSO BIT-IDENTICAL** (`resynthLevel = 1`,
`Δ = 0.00e+0` at all six). That matters because the obvious hypothesis — "it is
the filterbank's band count, so turn the bank up" — is *false*, and a face built
on it would put BANDS next to BANK WET and teach the wrong model.

### B. FREEZE from spawn is BIT-SILENCE

*Measured*, 2 s render, two windows:

| | 0.5–1.0 s | 1.5–2.0 s |
|---|---|---|
| freeze OFF | −13.90 dB | −11.27 dB |
| **`engineFreeze = 1` from spawn** | **−240.00 dB** | **−240.00 dB** |
| `gate` HIGH from t = 1.0 s | −13.90 dB | −11.27 dB |

**A rack saved with FREEZE engaged boots silent** — the engine holds a spectrum
it never analysed. Two things follow. **(i)** The face must not present FREEZE as
a neutral toggle; it is a "hold what you have" that has nothing at spawn.
**(ii)** The `gate` port — which the def documents as ORing with the FREEZE
control, level-sensitive, `edge: 'gate'` — measured **bit-identical to freeze
OFF** with a real held gate on it. Marked **NOT DETERMINED**: this harness wires
the driver straight to worklet input 2 and cannot distinguish "the OR is broken"
from "the offline path never reached it". **Verify in a browser before building
anything on the gate.**

### C. The param called `resynthLevel` is the FILTERBANK WET

`warrensspectrum.ts:148` — `e.setFilterbankWet(parameters.resynthLevel![0]!)`.
The label is `Bank Wet` and `docs.controls.resynthLevel` correctly describes a
crossfade into the 8-band bank. **The ID is the only thing that says
"resynthesis level".**

That is not cosmetic for a face: `FaceReadout.paramId` and every derived readout
key off ids, so an author reading `order` sees `resynthLevel` and reasonably
labels the cell "Resynth". *Measured* — it is a crossfade with a level cost:

| `resynthLevel` | 0 | 0.2 | 0.4 | 0.6 | 0.8 | 1.0 |
|---|---|---|---|---|---|---|
| rms dB | −11.62 | −10.06 | −8.67 | −7.44 | −6.34 | **−5.36** |
| peak | 0.667 | 0.770 | 0.899 | **1.032** | **1.174** | **1.315** |

**6.3 dB louder and +2.4 dBFS at the top** — for a control whose own doc says
*"it is a crossfade, not a level — turning it up does not make the module
louder"*. It does: 6.26 dB, measured. `warrensspectrum` is in `STRICT_DOCS`.

### D. SPECTRAL SHAPE swings 11.4 dB and is non-monotonic

| `spectralShape` | 0 | 0.2 | 0.4 | 0.6 | 0.8 | 1.0 |
|---|---|---|---|---|---|---|
| rms dB | −11.62 | **−20.28** | −17.03 | −18.32 | −17.02 | **−8.89** |
| peak | 0.667 | 0.271 | 0.417 | 0.334 | 0.417 | **0.990** |

Down 8.7 dB then up 11.4 dB, twice reversing. A face cannot fix that, but it can
print the level.

### E. GAIN reaches +8.5 dBFS and nothing limits

`gain = +12 dB` → peak **2.655**, rms +0.38 dB, from a −6 dBFS input.
`gain = −60` → peak 0.001. The control is exactly linear-in-dB and completely
unguarded at the top.

### F. Two controls that are almost not there

- **`spectralFloor` is bit-exactly inert from −90 to −48 dB** (`Δ = 0.00e+0`),
  starts moving at −34 (`Δ = 8.25e-2`) and is worth 0.27 dB at −20. **60 % of the
  travel does nothing** on a clean source, because it is a noise gate on the
  analysis bins.
- **`spectralStab` is 16 discrete positions worth `max|Δ| = 5.2e-3`** and
  **0.00 dB** — measured centroid drift 4223 → 4206 Hz across the whole range.
  Not zero, not audible.

---

## 5. THE FACE

```ts
// ⚠ NO `title`, NO `hint` — owner no-prose ruling, 2026-08-11. "Two engines
// behind one panel" is the module's `docs.explanation`; what carries it on the
// panel is the `ws-engine-name` readout and the band structure below.
face: {
  order: [
    'engineMode',          // rank 1: it decides what seven others mean
    'spectralPartials',
    'resynthLevel',        // NB: this id is the FILTERBANK WET (§4-C)
    'inputMix',
    'spectralShape',
    'gain',
    // dock tail
    'spectralSlew', 'spectralCenter', 'spectralResidual', 'spectralSlice',
    'spectralLock', 'engineFreeze', 'spectralFloor', 'spectralStab',
    'spectralBandCount',   // MASSPASS ONLY — bit-exactly inert in SPECTRAL
    'ws-filterbank-{n}',
    'ws-response-{n}',     // PANEL, rank 17
  ],

  pages: [
    // SIX bands. DOCK_TAB_MIN_BANDS is 7 — one more band and every hint below
    // stops rendering and the face becomes tabbed. Do not add a seventh.
    { id: 'engine', label: 'engine',
      hint: 'SPECTRAL = SMS partials + residual · MASSPASS = a different DSP',
      controls: ['engineMode', 'engineFreeze', 'ws-response-{n}'] },
    { id: 'partials', label: 'partials + residual',
      hint: 'SPECTRAL only',
      controls: ['spectralPartials', 'spectralResidual', 'spectralLock', 'spectralStab'] },
    { id: 'analysis', label: 'analysis',
      hint: 'FLOOR does nothing below about -40 dB on a clean source',
      controls: ['spectralSlice', 'spectralFloor', 'spectralSlew', 'spectralCenter', 'spectralShape'] },
    { id: 'masspass', label: 'masspass only',
      hint: 'inert while ENGINE is SPECTRAL',
      controls: ['spectralBandCount'] },
    { id: 'bank', label: 'filterbank',
      hint: 'BANK WET is the crossfade; it is +6.3 dB at the top',
      controls: ['resynthLevel', 'ws-filterbank-{n}'] },
    { id: 'output', label: 'output', controls: ['inputMix', 'gain'] },
  ],

  glyph: 'meter',   // see the warning below
  hero: {
    cell: 'ws-response-{n}',
    control: 'spectralPartials',
    readouts: [
      { label: 'engine',   valueId: 'ws-engine-name' },
      { label: 'partials', paramId: 'spectralPartials' },
      { label: 'out',      valueId: 'ws-peak-est-db' },
      { label: 'bands',    valueId: 'ws-bandcount-state' },
    ],
  },

  sidebar: [
    { kind: 'readouts', label: 'what belongs to which engine', entries: [
      { label: 'SPECTRAL', text: 'partials · residual · lock · stab · slice' },
      { label: 'MASSPASS', text: 'bands' },
      { label: 'both',     text: 'centre · shape · slew · floor · freeze' },
      { label: 'after both', text: 'bank wet · input mix · gain' },
    ] },
  ],
}
```

⚠ **SIX bands — one below the tabbing cliff.** `DOCK_TAB_MIN_BANDS = 7`; a
seventh band deletes **every band hint on this face at once**, and five of the
six hints above are load-bearing. If a seventh band is ever wanted, the hints
must move into the sidebar first.

⚠ **PF-21 row packing**: consecutive packable bands share a row at ≤10 cells.
`masspass` (1 cell) + `bank` (2) + `output` (2) = 5 cells and will pack onto one
row, which is why the one-control MASSPASS band costs almost nothing vertically.

⚠ **Band-hint budgets**, measured in characters:
`'SPECTRAL = SMS partials + residual · MASSPASS = a different DSP'` = **63**;
`'FLOOR does nothing below about -40 dB on a clean source'` = **54**;
`'BANK WET is the crossfade; it is +6.3 dB at the top'` = **50**. Shorter
fallbacks that keep the fact: **31** `'SPECTRAL: SMS · MASSPASS: other'`,
**28** `'FLOOR is inert under -40 dB'`, **24** `'WET is +6.3 dB at top'`.

⚠ **`glyph: 'meter'`, not `'scope'`.** `primaryAudioOutPortId` picks the first
audio output — here there is only one, so the tap is unambiguous (the
`attenumix` hazard does not apply). A meter is chosen because §4-C/§4-E put this
module over full scale from two different controls and the lane tile's job is to
show it.

---

## 6. DERIVED READOUTS

### A. `ws-engine-name` — `SPECTRAL` / `MASSPASS`

Trivial to compute, load-bearing to print. **NEGATIVE CONTROL —
`spectralPartials`:** must not move it. **SECOND — `engineMode`:** must be the
only input. It exists because everything else on the panel is conditional on it.

### B. `ws-bandcount-state` — the readout that pays for the module

Prints the band count **and its status**: `— (SPECTRAL)` when `engineMode = 0`,
`4 bands` when 1. **NEGATIVE CONTROL — `spectralBandCount` at `engineMode = 0`:**
it must NOT print a live-looking number, because the measurement says the control
is bit-exactly inert there (`Δ = 0.00e+0`, six values). **SECOND —
`spectralBandCount` at `engineMode = 1`:** it must move, because there the same
travel is worth 10.35 dB. A `paramId: 'spectralBandCount'` readout would print a
confident `3.00` in the state where the control does nothing — the canonical
knob-relabelled trap, and the exact reason `valueId` exists.

### C. `ws-peak-est-db` — the clip warning

A pure function of `gain` and `resynthLevel`, anchored on the measured peaks
(0.667 at defaults; 1.032 / 1.174 / **1.315** at wet 0.6 / 0.8 / 1.0; **2.655**
at gain +12). Print red above 1.00. **NEGATIVE CONTROL — `spectralPartials`:**
peak is nearly invariant to it (0.308 → 0.593 at low counts is a *content*
change, not a gain change) so the estimate must not track it. **SECOND —
`inputMix`,** which measurably adds peak (0.667 → 0.999 across 0..1) and must be
in the estimate.

---

## 7. THE PICTURE

**A spectrum-and-partials plot in the HERO** (rank 17 — legal, 17 keys). Draw the
tracked partials as vertical lines whose count is `spectralPartials`, the
residual as a shaded floor scaled by `spectralResidual`, the 8 bank bands as
translucent bells whose opacity is `resynthLevel`, and — critically — **grey the
whole partial/residual layer out and draw the MASSPASS layout instead when
`engineMode = 1`**. A picture that looked the same in both engines would be
making exactly the mistake the module's control set already makes.

---

## 8. ALREADY-WRONG

- **A · `docs.controls.resynthLevel` says turning it up "does not make the
  module louder".** Measured **+6.26 dB** and peak 1.315. §4-C. `STRICT_DOCS`.
- **B · FREEZE at spawn is bit-silence** (§4-B). A saved rack with FREEZE on
  boots dead. Its own DSP/UX PR — arguably FREEZE should be a no-op until the
  first analysis frame.
- **C · the `gate` FREEZE input measured inert** in this harness (§4-B). **NOT
  DETERMINED** — verify in a browser. If it really is dead, `warrensspectrum` is
  the second module after meowbox where the one port that owns the gate/trigger
  vocabulary is the one nobody checks.
- **D · `gain = +12` reaches +8.5 dBFS unlimited** (§4-E).
- **E · the param id `resynthLevel` names the filterbank wet** (§4-C). Renaming
  it is a contract change (`contract-lock` + `docs:accept` + the Push card) — its
  own PR, and worth doing before a face hard-codes the wrong word.
- **F · 60 % of `spectralFloor` and effectively all of `spectralStab` do
  nothing** on a clean source (§4-F). Not defects; not visible either.
- **G · the card is CLEAN.** `WarrensspectrumCard.svelte` imports
  `WARRENSSPECTRUM_RANGES` and re-types **zero** literal ranges — the only module
  in this batch that already does the right thing, and a working example for the
  other eleven. It is still not in `RANGE_BOUND_CARDS`, so nothing keeps it that
  way.

---

## 9. THE TWO COSTS THAT ARE NOT ARITHMETIC

- **⚠ `warrensspectrum` is already in `PUSH_CARD_CONTROLS`.** A face does not
  change a push card (the override REPLACES), but **check the 8 entries still
  match the face's top 8** so the two curations do not diverge silently.
- **25 driven cells** (16 params + an 8-cell family + 1 panel) makes this the
  largest `faces-parity` row on the roster. It is an insert, so with nothing
  patched the analyser reads zeros and the `meter` glyph pins deterministically
  — which matters more now that face baselines gate merges in `vrt-strict`
  (#1483) rather than sitting in the informational lane.

§8-B/D are audio/UX changes and are separate PRs; the face itself moves no ART.
