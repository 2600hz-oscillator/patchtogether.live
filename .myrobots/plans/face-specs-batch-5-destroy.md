# FACE SPEC — `destroy` (batch 5)

> ⚠ **PLATFORM CORRECTIONS SINCE THIS WAS WRITTEN — 2026-08-12 janitorial sweep.**
> - **PF-22 freed the hero rank** (#1480): `face.hero.cell` no longer consumes a
>   LANE rank, so a `panel` may now rank FIRST. Any argument below that a module
>   cannot be faced because a panel's first legal rank is 7 is OBSOLETE.
> - **A card↔face PRIMITIVE-PARITY gate now exists** (#1480,
>   `card-primitive-parity.test.ts`): ranking a param whose card binds it to a
>   primitive the platform has no cell kind for now FAILS, naming the
>   `(module, param, primitive)` triple. `XyPad` and `NoteEntry` are the two
>   declared gaps.
> - **The faceplate pipeline is PAUSED by owner directive.** This spec is BANKED,
>   not cancelled and not blocked.


## 0. STATUS

**Authored 2026-08-10. Every claim below was measured or read against `main`**
(`153e5c36`). Nothing here is implemented; no def, card or DSP file is touched.

**Verdict: PROMOTE — the cheapest in the batch, on one finding: the bottom third
of DECIMATE is bit-exactly inert, and the top of BITS is a 28 dB level drop with
a doubled peak.**

archetype: **the BITCRUSHER** — 3 params, the smallest audio contract in the
batch and one a player reaches for constantly.

Not in `STRICT_FACES`; no `face:` block. In `STRICT_DOCS`; **not** in
`STRICT_VRT_MODULES`; **not** in `PUSH_CARD_CONTROLS`. 3 params, 4 in, 1 out.
contract-lock = **9 lines**.

**Method.** `destroy` is **Faust** (`packages/dsp/src/destroy.dsp`), so the
harness is `art/setup/faust-offline.ts` `renderFaustOffline` over the committed
`packages/dsp/dist/destroy.{wasm,json}` — the same path the shipping worklet
loads. 48 kHz, C4 **sine** at 0.5 amplitude (a sine has one partial and thousands
of distinct sample values, so both quantisation axes are unambiguous),
statistics over t ≥ 1.05 s of a 1.5 s render. Every param is `si.smoo`-smoothed,
which is why the window starts a second in.

⚠ **The def factory does NOT load under `renderOfflineDef`** —
`FaustWasmInstantiator.loadDSPFactory` returns null in Node against the `?url`
artifact path. Not a defect in `destroy`; a note for the next person with a
harness.

---

## 1. THE THREE CONTROLS, MEASURED

`distinct` = the number of distinct sample values in the settled tail — the
direct read of a quantiser.

| patch | rms dB | peak | centroid | distinct |
|---|---|---|---|---|
| **defaults** (`bits 16 dec 1 wet 1`) | −9.03 | 0.5000 | 275 Hz | **12 698** |
| `bits 8` | −9.03 | 0.5001 | 1997 | **158** |
| `bits 4` | −8.87 | 0.5000 | 6032 | **41** |
| `bits 2` | −7.78 | 0.5000 | 7103 | **35** |
| **`bits 1`** | **−37.32** | **1.0000** | 12 000 | **34** |
| `decimate 1` | −9.03 | 0.5000 | 275 | 12 698 |
| **`decimate 1.5`** | −9.03 | 0.5000 | **275** | **12 698** |
| **`decimate 2`** | −9.03 | 0.5000 | **275** | **12 698** |
| `decimate 2.5` | −9.03 | 0.5000 | 665 | 13 365 |
| `decimate 8` | −9.03 | 0.5000 | 1822 | 9 502 |
| `decimate 32` | −9.03 | 0.5000 | 4246 | 7 895 |
| `decimate 64` | −9.04 | 0.5000 | 4742 | 7 174 |
| `wet 0` | −9.03 | 0.5000 | 262 | 21 248 |
| `bits 1 dec 64` | **−98.81** | **0.0000** | 262 | 33 |

Plus two identity checks:

- **`wet = 0` is BIT-EXACT DRY**: `max|out − in| = 0.000e+0`.
- **`wet = 1, bits = 16, decimate = 1` is NOT**: `max|out − in| = 1.529e-5`. The
  "transparent" factory default is a 16-bit quantiser, ~96 dB down. Correct, and
  worth one sentence somewhere, because the module's default state is described
  as clean and is not bit-clean.

---

## 2. THE THREE FINDINGS

### A. DECIMATE does nothing from 1 to 2 — and that is 1.6 % of the fader

`decimate` is `1..64 linear`, default 1. *Measured*: **`decimate = 1`,
`1.5` and `2` are identical in every statistic** — same rms to two decimals, same
peak to four, **same centroid (275 Hz) and the same 12 698 distinct values**.
`2.5` is the first setting that moves anything (centroid 665 Hz).

A sample-and-hold of length 2 halves the effective rate and is plainly audible on
a 261 Hz sine; measuring it as byte-for-byte identical to no decimation at all is
an off-by-one in the hold counter, not a rounding subtlety. **Marked: measured;
cause read-in-code as `ba.sAndH` counter arithmetic and NOT confirmed** — the
Faust source is one line and an owner should read it before anyone "fixes" it.

### B. BITS = 1 is a 28 dB drop AND a doubled peak

From a 0.5-amplitude input: `bits 1` → **rms −37.32 dB** (vs −9.03 at the
default: a 28.3 dB collapse) with **peak 1.0000** — twice the input's peak. The
output is mostly near-zero with full-scale spikes. Combined with `decimate 64`
it is **−98.81 dB, peak 0.0000** — silence.

So the two extremes of the same knob are "twice as loud, instantaneously" and
"gone", and the transition between them depends on the *other* knob. That is the
whole reason this three-control module earns a face.

### C. The BITS ladder is not linear in anything a player would guess

`distinct` goes **12 698 → 158 → 41 → 35 → 34** for bits 16 → 8 → 4 → 2 → 1. The
audible action is entirely in the top half of the knob (16 → 8 is 80× the
resolution loss; 2 → 1 changes the level, not the grid). `bits` is declared
`1..16 **linear**`, so half the fader travel does almost nothing to the timbre
and then the last notch does something violent to the level.

⚠ **`distinct` at `bits 1` is 34, not 2.** The params are `si.smoo`-smoothed, so
even a settled tail carries the smoother's residual. The count is a
*relative* instrument (16 → 8 → 4 is unambiguous), not an absolute one, and the
spec says so rather than claiming a 1-bit quantiser emits 34 levels.

---

## 3. THE FACE

3 params, so `faceTierCap('full') = 6` means **`full` and `dock` render the
identical three cells** — the `resofilter` tier collapse, harder. The face's
value is therefore entirely in the readouts and the picture, and the spec says so
up front.

```ts
face: {
  title: 'Bitcrusher',
  hint: 'DECIMATE does nothing below 2.5. BITS 1 is 28 dB quieter and twice the peak.',

  order: ['bits', 'decimate', 'wet'],
  // NO pages. Three controls is one band; a page costs ~81 px and buys nothing.
  glyph: 'scope',

  hero: {
    control: 'bits',
    // NO `cell`: a panel's first legal rank is 7 and this face has THREE keys,
    // so rank 7 is unreachable — the drummergirl wall. The picture goes to the
    // sidebar as a `custom` block, which carries no order key and no rank
    // (the meowbox answer, exactly as resofilter/attenumix use it).
    readouts: [
      { label: 'levels', valueId: 'destroy-levels' },
      { label: 'rate',   valueId: 'destroy-eff-rate' },
      { label: 'out',    valueId: 'destroy-level-est' },
    ],
  },

  sidebar: [
    { kind: 'custom', label: 'quantisation grid', panelId: 'quantise-grid',
      props: { bitsParam: 'bits', decimateParam: 'decimate', wetParam: 'wet' } },
    { kind: 'readouts', label: 'measured', entries: [
      { label: 'DEC 1 - 2',  text: 'identical to no decimation' },
      { label: 'BITS 1',     text: '-28 dB, peak x2' },
      { label: 'WET 0',      text: 'bit-exact dry' },
    ] },
  ],
}
```

⚠ **`title` / `hint` paint NOTHING at rest.** On a module with no band labels
that is severe: every fact above lives in a readout or a sidebar `text` entry.
The `hint` is for the annotated view only.

⚠ **`panelId: 'quantise-grid'` must be registered in `sidebar-panels.ts`.**
Written generically on purpose — a second crusher (or `ringback`'s crush stage)
can reuse it with different props.

---

## 4. DERIVED READOUTS

### A. `destroy-levels` — the grid, in numbers

`2^round(bits)` printed as `256 levels` / `4 levels`, with the measured `distinct`
ladder as the anchor (158 at bits 8, 41 at 4, 35 at 2). **NEGATIVE CONTROL —
`decimate`:** must be invariant to it (measured: `distinct` 12 698 at decimate 1
and 2, and the bits ladder is unchanged by decimation). **SECOND — `wet`:** it
must NOT read `2 levels` at `wet = 0`, where the output is measured **bit-exact
dry**; a grid readout that ignored WET would print a destruction that is not in
the signal.

### B. `destroy-eff-rate` — the effective sample rate, and the dead zone

`48000 / round(decimate)` printed as `24.0 kHz`, **and it must print
`48.0 kHz (no effect)` for `decimate < 2.5`**, because that is what was measured
(§2-A) rather than what the arithmetic says. This is the readout that carries the
finding.
**NEGATIVE CONTROL — `bits`:** must not move it. **SECOND — `decimate` 2 → 2.5:**
the readout must change class exactly there, matching the measurement, and not at
the arithmetic boundary of 1.5.
⚠ **State the units.** `kHz`, and never print a bare `24`.

### C. `destroy-level-est` — the drop nobody expects

From `bits` and `decimate`, anchored on §2: −9.03 dB at defaults, −8.87 at bits 4,
−7.78 at 2, **−37.32 at 1**, **−98.81 at bits 1 + decimate 64**. Print red below
−20 dB — *quiet* is the hazard here, not loud.
**NEGATIVE CONTROL — `wet`:** at `wet = 0` it must read the dry level (measured
−9.03 dB), not the crushed one.

---

## 5. THE PICTURE

**The quantisation grid, in the SIDEBAR.** One cycle of the input with the
horizontal quantisation lines at `2^bits` spacing and the vertical sample-and-hold
steps at `decimate` spacing, the dry trace under it at `1 − wet`. It is the one
drawing that makes both axes legible at once, and at `bits 16 / decimate 1` it
correctly looks like a smooth curve — a picture that is honest about the default
being nearly transparent.

---

## 6. ALREADY-WRONG

- **A · `decimate` 1 → 2 is bit-exactly inert** (§2-A). A one-line Faust fix, its
  own PR, and it **re-pins `art/baselines/destroy/`** (the existing scenario runs
  at `decimate 8`, which is unaffected — so the ART gate would *not* have caught
  this, and would not catch the fix either).
- **B · `bits = 1` is −28 dB with a doubled peak** (§2-B). Arguably correct for a
  1-bit quantiser of a bipolar signal; arguably a missing output compensation.
  Owner call, and its own PR.
- **C · `bits` is declared `1..16 linear`** while the audible action is
  logarithmic (§2-C). A `curve: 'log'` would spread it properly — a contract
  change, and ⚠ **check the consumer first**: `DestroyCard.svelte` uses `<Fader>`,
  which *does* implement curves, so unlike the four `<Knob>` cards named in
  CLAUDE.md this one would actually change behaviour.
- **D · `DestroyCard.svelte` re-types all six range props** in 40 lines, and
  `destroy` is **not** in `RANGE_BOUND_CARDS`.
- **E · the default is not bit-transparent** (1.529e-5). Harmless; undocumented.

---

## 7. COST

| | |
|---|---|
| **contract-lock** | **+0.** No control family, no audition, and the picture is a sidebar `custom` block. §6-C, if taken, is +0 lines but a real contract diff (`curve` changes). |
| **ART** | none from the face. §6-A/B re-pin `art/baselines/destroy/` and must not be in the face PR. |
| **VRT** | +`face-destroy-{compact,dock}` × 2 = **4 informational baselines**. An insert, silent unpatched → the `scope` glyph pins deterministically. |
| **e2e** | +1 `faces-parity` row, **3 cells** — the smallest new row in the batch, ≈ +10 s dominated by the page boot. |
| **the honest bottom line** | Three cells, identical at `full` and `dock`, no hero picture, no audition. It ships because **DECIMATE's first 1.6 % is dead and BITS' last notch is a 28 dB cliff**, and nothing on a three-fader card can say either. If the owner would rather spend the slot elsewhere, that is defensible — but §6-A is a live audio bug either way. |
