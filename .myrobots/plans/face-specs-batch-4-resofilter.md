# FACE SPEC — `resofilter` (batch 4)

## 0. STATUS

**Authored 2026-08-09. Every claim below was measured or read against `main`**
(`ecc48f2e`). Nothing here is implemented; no def, card or DSP file is touched.

**Verdict: PROMOTE — with a stated caveat: this is the CHEAPEST face in the batch
and the one whose lane tiers collapse.** `full` and `dock` show the identical four
cells. It earns its keep on one thing only, and that thing is worth it: **RESONANCE
means four different things depending on MODE, and in one mode it does not change the
magnitude at all.**

archetype: **the CLEAN multi-mode filter** (the character filter, `filter`, already has
a face; this is its transparent sibling).

Not in `STRICT_FACES`; no `face:` block. In `STRICT_DOCS`; **not** in
`STRICT_VRT_MODULES`. 4 params, 3 in, 2 out. contract-lock = **11 lines** — one of the
smallest audio contracts to be considered for promotion.

**Method.** `packages/dsp/src/resofilter.ts` bundled with esbuild against stub worklet
globals, run offline at 48 kHz. Magnitudes are steady-state RMS of the second half of a
1 s render against a −6 dBFS sine, referenced to the input's own RMS.

---

## 1. WHAT IT ACTUALLY DOES

One Cytomic/Zavalishin TPT state-variable filter with **all five modes sharing one
state** (`packages/dsp/src/lib/resofilter-dsp.ts`), so MODE is a pure output picker and
switching is pop-free. LP/HP/BP are the three SVF taps; NT is `lp + hp` (= `x − k·bp`);
AP is `lp + hp − k·bp`. `resonance` maps to `k = 2 − 2·res`, clamped above zero.

*Measured* magnitude response, dB re input, `cutoff 1000, resonance 0.3`:

| | 50 | 125 | 250 | 500 | **1000** | 2000 | 4000 | 8000 Hz |
|---|---|---|---|---|---|---|---|---|
| **LP** | 0.0 | 0.0 | −0.0 | −0.2 | **−2.9** | −12.3 | −24.5 | −37.8 |
| **HP** | −52.1 | −36.1 | −24.1 | −12.3 | **−2.9** | −0.2 | −0.0 | 0.0 |
| **BP** | −26.0 | −18.1 | −12.1 | −6.3 | **−2.9** | −6.3 | −12.2 | −18.9 |
| **NT** | −0.0 | −0.1 | −0.6 | −2.7 | **−155.1** | −2.7 | −0.5 | −0.1 |
| **AP** | −0.0 | −0.0 | −0.0 | −0.0 | **−0.0** | −0.0 | −0.0 | −0.0 |

Textbook. Four measured non-defects while we are here: **MIX 0 is bit-exact dry in all
five modes** (`max|out − in| = 0.000e+0`); **the module is silent unpatched** (peak
0.000e+0, correct for an insert); **the L/R state really is independent** — feeding
200 Hz on channel 0 and 4 kHz on channel 1 through LP at 1 kHz gives −9.03 dB and
−33.49 dB respectively, `max|L−R| = 5.281e-1`, so `docs.explanation`'s stereo claim
holds; and **MODE rounds at exactly 0.5** (0.4 → LP, 0.5 → HP) and clamps above 4.

---

## 2. THE CONTROLS THAT MATTER — 4 params, and why the ranking barely matters

| rank | control | why |
|---|---|---|
| 1 | `cutoff` | the sweep. |
| 2 | `resonance` | ranked 2 because **its meaning is mode-dependent** (§4-A) and its top 0.15 % is a **+44 dBFS hazard** (§4-C). |
| 3 | `mode` | ranked 3, not 1, **deliberately** — see below. |
| 4 | `mix` | the crossfade; bit-exact dry at 0. |

⚠ **`mode` is ranked 3 even though it is the most consequential control**, and this is
the one ranking argument on the module. `order` is a PRIORITY ranking for the tiers that
show a SUBSET; with four params, `full` and `dock` show all four regardless, so rank only
decides `mini` (1) and `compact` (2 with a glyph). What belongs in a 192 px tile is
**what a hand moves** — cutoff, then resonance — while MODE is set once and then read.
Its job at the small tiers is to be **legible**, which is the `glyph`/label problem, not
a ranking problem.

⚠ **THE TIERS COLLAPSE, AND THE SPEC SAYS SO.** `faceTierCap('full')` is 6 and this
module has 4 params, so **`full` and `dock` render the identical set.** That is the
`noise` argument, and it is why this face's value has to come from somewhere other than
the ranking: the mode diagram, the sidebar curve, and three derived readouts.

**NO AUDITION.** resofilter is an insert with nothing to strike (§1). Declaring an
`action` would require a probe that reaches nothing.

---

## 3. INERT AT SPAWN

Unpatched: `out_l` and `out_r` peak **0.000e+0**. Correct and unremarkable for an insert
— stated so the face does not promise a glyph that can show something.

---

## 4. WHAT THE FACE MUST MAKE VISIBLE — four measured facts

### A. RESONANCE means four different things, and in ALLPASS it changes no magnitude at all

*Measured*, broadband white noise, RMS in dB at `resonance 0 / 0.3 / 0.6 / 0.9 / 1.0`:

| mode | 0 | 0.3 | 0.6 | 0.9 | 1.0 | **span** |
|---|---|---|---|---|---|---|
| **LP** | −30.17 | −28.59 | −26.10 | −19.95 | −3.91 | **26.26 dB** |
| **BP** | −30.65 | −28.93 | −26.30 | −20.01 | −3.92 | **26.73 dB** |
| **HP** | −15.63 | −15.42 | −15.12 | −14.04 | −3.62 | 12.01 dB |
| **NT** | −15.75 | −15.60 | −15.45 | −15.28 | −15.23 | **0.52 dB** |
| **AP** | −15.23 | −15.23 | −15.23 | −15.23 | −15.23 | **0.00 dB** |

**In ALLPASS the RESONANCE dial changes the output level by exactly nothing** — and it
is not inert: `max|Δ|` against `resonance 0` measures 2.729e-4 / 2.842e-2 / 9.231e-2 /
2.053e-1 / 3.523e-1 / **4.520e-1** at res 0.001 / 0.1 / 0.3 / 0.6 / 0.9 / 1.0. It is a
**pure phase rotation**, which is the whole point of an allpass and is completely
invisible to every level-based instrument in the repo.

⚠ **AND THE NOTCH ROW IS WHERE MY OWN INSTRUMENT WAS BLIND.** The 0.52 dB span above
says "RESONANCE does nothing in NT". That is **false**, and a per-frequency probe shows
why — gain in dB across the notch:

| resonance | 500 | 800 | 950 | **1000** | 1050 | 1250 | 2000 Hz |
|---|---|---|---|---|---|---|---|
| 0 | −4.4 | −13.2 | −25.8 | **−155.2** | −26.2 | −13.1 | −4.4 |
| 0.3 | −2.7 | −10.3 | −22.7 | **−155.1** | −23.1 | −10.3 | −2.7 |
| 0.9 | −0.1 | −0.8 | −6.8 | **−154.9** | −7.1 | −0.8 | −0.1 |
| **1.0** | **−0.0** | **−0.0** | **−0.0** | **−50.5** | **−0.0** | **−0.0** | **−0.0** |

The notch **depth** is resonance-invariant at −155 dB; the notch **WIDTH** collapses
from ±2 octaves to nothing. At `resonance 1.0` it is 50 dB deep and **zero octaves
wide** — an infinitely narrow notch, i.e. audibly a **bypass**. So:

> **RESONANCE is a peak height in LP/BP, a much smaller peak in HP, a notch BANDWIDTH in
> NT, and a phase angle in AP.** One dial, four meanings, and the panel calls it "Reso".

**This is the entire argument for promoting this module**, and it is exactly the "a mode
changes what a knob means" case. A broadband RMS metric — the obvious one, and the one I
reached for first — reports "0.52 dB, nothing happening" for a control that takes the
notch from two octaves wide to zero.

### B. `mode` has NO `ParamDef.options`, so a face would print `0.00`…`4.00`

`resofilterDef.params` declares `{ id: 'mode', … curve: 'discrete', min: 0, max: 4 }`
with **no `options`**. The names live in `RESOFILTER_MODE_NAMES`, which is exported from
the web def, **duplicated by hand** in `packages/dsp/src/lib/resofilter-dsp.ts` (the def's
own comment says so), and read by the card.

The shell derives `'segmented'` / `'selector'` **from a declared `options` roster**
(`ModuleFace.paramCells` doc, `graph/types.ts`). With none, MODE renders as a bare
discrete knob and the faceplate prints **`0.00`** where the card prints **`Low-pass`**.

**Blocking, and cheap: declare `options` on the ParamDef, sourced from the existing
constant.** It is a contract change (`task docs:accept`), it deletes the second copy of
the names, and it is the same move `filter` already made (`filter.ts:113-117`).

⚠ **AND THE LABELS WILL CLIP.** `filter` ships **three** options with **two-letter**
labels and its dock MODE still renders `LP · H… · B…` — a live instance, and one that
`faces-parity` cannot see, because `toHaveText` reads `textContent` and a CSS ellipsis
leaves no trace. resofilter has **five**. Long names ("Low-pass", "Band-pass") are out
of the question; `LP HP BP NT AP` is five two-letter chips where three already clipped.
**Do not design this face around the Segmented fitting.** Either measure the dock width
first and accept a wrapped/two-row Segmented, or use `paramCells: { mode: 'grid' }` —
the chip + portaled diagram-grid popover, whose whole reason for existing is "this
param's states are PICTURES". Five filter response curves is a textbook use of it.

### C. The top 0.15 % of RESONANCE is a plateau, and it reaches +44 dBFS

`k = 2 − 2·res`, clamped. *Measured* LP gain at cutoff on a −6 dBFS sine:

| resonance | 0.9 | 0.95 | 0.99 | 0.995 | 0.998 | **0.999** | **0.9995** | **1.0** |
|---|---|---|---|---|---|---|---|---|
| gain | 13.98 dB | 20.00 | 33.98 | 40.00 | 47.96 | **50.441** | **50.441** | **50.441** |
| peak | 2.500 | 5.000 | 25.000 | 50.000 | 125.001 | **166.653** | **166.653** | **166.653** |
| implied `k` | — | — | 0.0200 | 0.0100 | 0.00400 | **0.003006** | 0.003006 | 0.003006 |

Two facts in one table. **(i) The clamp is `k_min ≈ 0.003006`**, i.e. `resonance ≈
0.9985`, and everything above it is the same filter to five significant figures — the
last 0.15 % of the dial is a **plateau**. **(ii) A −6 dBFS sine comes out at peak
166.65 = +44.4 dBFS**, with no limiter anywhere. Across a 60-corner grid
(5 modes × 6 resonances × 2 mixes), **18 corners exceed full scale.**

Compare: `resonance 0.9` is a comfortable +14 dB. The dangerous region is 0.99..1.0,
which is **1 % of the fader's physical travel**.

### D. HP at the bottom of CUTOFF, and NT/AP anywhere, are bypasses

*Measured* broadband RMS against a dry reference of −15.23 dB:

| | cutoff 20 Hz | cutoff 20 kHz |
|---|---|---|
| LP | −44.14 | −16.11 |
| HP | **−15.23** | −22.44 |
| BP | −44.80 | −23.96 |
| NT | **−15.23** | −16.55 |
| AP | **−15.22** | **−15.23** |

Three cells sit at the dry level to two decimals. Not a defect — a 20 Hz high-pass is
supposed to be a bypass — but it is the kind of thing that reads as a broken module when
a player lands there while sweeping, and the face can pre-empt it.

---

## 5. THE FACE

```ts
face: {
  title: 'Filter',
  hint:
    'One zero-delay SVF, five taps off the same state — switching MODE is pop-free by construction. ' +
    'RESO does NOT mean one thing: it is a resonant peak in LP/BP, a much smaller one in HP, the ' +
    'notch BANDWIDTH in NT (depth is fixed at −155 dB), and a pure phase angle in AP where the ' +
    'output level does not move at all. Above 0.9985 it is a flat plateau at +50 dB of peak gain, ' +
    'and nothing here limits.',

  order: ['cutoff', 'resonance', 'mode', 'mix'],
  // NO `pages`. Four controls is one band; a page costs an ~81 px band and buys
  // nothing here. The mode-dependence lives in the readouts and the sidebar, which is
  // where it can actually be model-aware.
  glyph: 'scope',
  paramCells: { mode: 'grid' },   // five response curves — see §4-B

  hero: {
    control: 'cutoff',
    // NO `cell`. A panel's first legal rank is 7 (module-face-lint refuses a PANEL
    // selected at a lane tier; faceTierCap('full') = 6) and this face has FOUR keys, so
    // rank 7 is unreachable — the drummergirl wall exactly. The picture goes in the
    // SIDEBAR as a `custom` block, which carries no `face.order` key and therefore no
    // rank at all: the meowbox answer.
    readouts: [
      { label: 'reso does',  valueId: 'resofilter-reso-meaning' },
      { label: 'peak gain',  valueId: 'resofilter-peak-gain-db' },
      { label: 'at cutoff',  valueId: 'resofilter-cutoff-gain-db' },
    ],
  },

  sidebar: [
    { kind: 'custom', label: 'response', panelId: 'filter-response-curve',
      props: { modeParam: 'mode', cutoffParam: 'cutoff', resoParam: 'resonance', mixParam: 'mix' } },
    { kind: 'readouts', label: 'what RESO does here', entries: [
      { label: 'LP · BP', text: 'peak height — 26 dB' },
      { label: 'HP',      text: 'peak height — 12 dB' },
      { label: 'NT',      text: 'notch WIDTH — depth is fixed' },
      { label: 'AP',      text: 'phase only — 0.00 dB' },
    ] },
  ],
}
```

⚠ **`title` / `hint` are ANNOTATION and paint nothing at rest**
(`dock-faceplate-model.ts:90`). Everything load-bearing above is a READOUT or a sidebar
`text` entry, both of which paint unconditionally. That is deliberate on a module this
small: there are no band labels to carry the facts.

⚠ **`panelId: 'filter-response-curve'` must be registered in `sidebar-panels.ts`.** It
is written generically on purpose — `filter`, `qbrt` and `moog904*` could all use the
same picture with different props, which is the `custom`-block contract ("the picture is
generic, the numbers are the module's"). If it ends up resofilter-specific, name it so.

---

## 6. DERIVED READOUTS

### A. `resofilter-reso-meaning` — the readout that IS the face

Prints what the RESONANCE dial is doing **in the current mode**: `peak +14 dB` /
`notch 0.3 oct wide` / `phase 112°` / `plateau (clamped)`.
**NEGATIVE CONTROL — `mode`.** A `paramId: 'resonance'` readout prints `0.30` in all
five modes while the measured magnitude span across the same travel is 26.73 dB in BP
and **0.00 dB in AP**. **SECOND CONTROL — `resonance` in AP:** the readout must still
MOVE there (the filter genuinely changes, `max|Δ| = 0.452` at res 1) — a derivation that
printed "no effect" in AP would be as wrong as the level metric was. This two-sided
control is what stops the readout from being a relabelled knob.

### B. `resofilter-peak-gain-db` — the hazard, before you hear it

```
peak_gain_db = 20·log10( 1 / max(2 − 2·resonance, 0.003006) )    # LP/BP/HP only
```
Anchors *measured*: res 0.9 → 13.98 dB, 0.99 → 33.98, 0.998 → 47.96, ≥0.9985 → **50.44
(plateau)**. Print **red above ~+12 dB**.
**NEGATIVE CONTROL — `mode`.** It must read `—` in NT and AP, where there is no peak
(measured 0.52 and 0.00 dB of span). A readout that printed +50 dB in ALLPASS would be
inventing a hazard that does not exist. **SECOND — `reso_cv`:** the CV most likely to
sweep into the clamp; needs `readLive`.

### C. `resofilter-cutoff-gain-db` — the number the curve is anchored on

Gain **at the cutoff frequency**, per mode. *Measured at res 0.3*: −2.9 dB in LP, HP and
BP alike; **−155.1 dB** in NT; **−0.0 dB** in AP.
**NEGATIVE CONTROL — `cutoff`.** It must be **invariant** to cutoff (all three of LP/HP/BP
read −2.9 dB at 1 kHz and the same at any other cutoff) while §6-B moves with resonance
and this one does not. Publishing both is the pair's own negative control: a derivation
that moves both, or neither, is falsified on the spot.
⚠ **State the units in the label.** `dB at cutoff`, not `cutoff` — the whole readout is
one character away from being mistaken for the frequency.

---

## 7. THE PICTURE

**The response curve, in the SIDEBAR** (§5). Magnitude vs log frequency for the current
mode, with the resonant peak height driven by `k`, the notch width driven by `k`, a
dashed dry trace under it scaled by `1 − mix`, and a **phase trace shown only in AP** —
because AP's magnitude curve is a flat line and a picture that shows only magnitude would
draw *nothing* for the one mode whose knob is hardest to understand.

That last clause is the design decision worth arguing over. Do not ship an AP tile that
is a straight horizontal line; that is a picture certifying that the control does nothing.

---

## 8. ALREADY-WRONG

- **A · `mode` declares no `ParamDef.options`.** §4-B. A face prints `0.00`; the card
  prints `Low-pass`; the names are hand-duplicated in the web def and the DSP lib.
  Contract change, and it removes a duplication.
- **B · nothing limits, and 18 of 60 measured corners exceed full scale**, worst
  **+44.4 dBFS** from a −6 dBFS input. §4-C. Whether resofilter should have an output
  guard is a DSP question — **its own PR**, with an ART re-pin
  (`art/scenarios/resofilter/profile.test.ts`, `art/baselines/resofilter/`).
- **C · `docs.controls.resonance`** (read on `main`) describes a single behaviour for a
  control with four. §4-A. `STRICT_DOCS`.
- **D · the card re-types the ranges** (`ResofilterCard.svelte`); `resofilter` is not in
  `RANGE_BOUND_CARDS`.
- **E · `RESOFILTER_MODE_NAMES` exists twice**, in `resofilter.ts` and in
  `resofilter-dsp.ts`, with a comment acknowledging the duplication and a test asserting
  only that the *count* matches. Fixed for free by A.
- **No dead controls**, but **two near-dead cells**: RESONANCE in AP is 0.00 dB of
  magnitude (by design, and audible only as phase) and 0.52 dB broadband in NT (a width
  control a level metric cannot see). Neither is a bug; both are why this face exists.

---

## 9. COST — the cheapest in the batch

| | |
|---|---|
| **contract-lock** | **+5 lines** if `options` lands (§4-B) — one per named mode, the `filter` precedent. **+0** from the face itself: no control family, no audition, and the picture is a sidebar `custom` block, which is not a control key. |
| **ART** | none from the face. §8-B is a real audio change and is not in the face PR. |
| **VRT** | not in `STRICT_VRT_MODULES`. +`face-resofilter-{compact,dock}` × 2 = **4 informational baselines**. Silent unpatched, so the `scope` glyph captures zeros deterministically. |
| **e2e** | +1 `faces-parity` row, **4 cells**, no audition — the smallest new row in the batch, ≈ +11 s dominated by the page boot. |
| **the honest bottom line** | four cells, identical at `full` and `dock`, no hero picture, no audition. It ships for **one** reason: RESO means four different things and nothing on the panel says so. If the owner would rather spend the slot elsewhere, **that is a defensible call** — but the §4-A/B/C findings stand either way and §4-B is a blocker for any future face on this module. |
