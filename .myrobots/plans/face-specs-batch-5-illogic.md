# FACE SPEC — `illogic` (batch 5)

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

**Verdict: PROMOTE — on a structural fact the panel cannot state: FOUR of its
ten outputs are bit-exactly unaffected by ALL FOUR of its knobs, and two others
reach 2.59 on a ±1 CV bus.**

archetype: **the ATTENUVERTER + MATH + LOGIC utility** — four attenuverters, a
sum/difference mixer and a digital-logic block, in one 4-knob box.

Not in `STRICT_FACES`; no `face:` block. In `STRICT_DOCS`; **not** in
`STRICT_VRT_MODULES`; **not** in `PUSH_CARD_CONTROLS`. **4 params**, 4 in,
**10 out**. contract-lock = **19 lines**.

**Method.** REAL `illogicDef.factory` (pure `GainNode` + `WaveShaperNode` +
`ConstantSourceNode` — no worklet) under `node-web-audio-api`'s
`OfflineAudioContext`, 48 kHz, four sub-audio sines (3 / 5 / 7 / 11 Hz at
0.9 / 0.9 / 0.6 / 0.4) so the logic thresholds and the mixer are both readable in
one render. Determinism control: identical renders. `Δ` = `max|x − x_ref|`.

---

## 1. THE KNOBS REACH SIX OF TEN JACKS

*Measured*, every attenuverter swept −1 → +1, all ten outputs watched:

| output | `att1_amount` | `att2_amount` | `att3_amount` | `att4_amount` |
|---|---|---|---|---|
| `att1` | Δ **1.80e+0** | 0.00e+0 | 0.00e+0 | 0.00e+0 |
| `att2` | 0.00e+0 | Δ 1.80e+0 | 0.00e+0 | 0.00e+0 |
| `att3` | 0.00e+0 | 0.00e+0 | Δ 1.20e+0 | 0.00e+0 |
| `att4` | 0.00e+0 | 0.00e+0 | 0.00e+0 | Δ 8.00e-1 |
| `sum` | Δ 1.80e+0 | Δ 1.80e+0 | Δ 1.20e+0 | Δ 8.00e-1 |
| `diff` | Δ 1.80e+0 | Δ 1.80e+0 | Δ 1.20e+0 | Δ 8.00e-1 |
| **`and`** | **0.00e+0** | **0.00e+0** | **0.00e+0** | **0.00e+0** |
| **`or`** | **0.00e+0** | **0.00e+0** | **0.00e+0** | **0.00e+0** |
| **`nand`** | **0.00e+0** | **0.00e+0** | **0.00e+0** | **0.00e+0** |
| **`not`** | **0.00e+0** | **0.00e+0** | **0.00e+0** | **0.00e+0** |

**The four logic outputs are bit-exactly immune to every knob on the module.**
They threshold the RAW inputs, before the attenuverters. That is a correct and
sensible design (an attenuverted gate is not a gate), and it is completely
unknowable from a card that shows four knobs above ten jacks.

**Each attenuverter is also perfectly orthogonal** — `att1_amount` leaves
`att2`/`att3`/`att4` at `Δ = 0.00e+0` and so on for all four. Verified, not
assumed.

---

## 2. TWO OUTPUTS EXCEED THE CV STANDARD BY 2.6×

*Measured*, defaults (all four attenuverters at +1), inputs of amplitude
0.9 / 0.9 / 0.6 / 0.4:

| output | peak | rms dB |
|---|---|---|
| `att1` | 0.900 | −4.08 |
| **`sum`** | **1.791** | **+0.29** |
| **`diff`** | **2.594** | **+0.25** |
| `and` | 1.000 | −11.46 |
| `or` | 1.000 | −3.06 |
| `nand` | 1.000 | −0.32 |
| `not` | 1.000 | −1.53 |

`sum` is `att1+att2+att3+att4` and `diff` is `(att1+att2) − (att3+att4)`, both
**unscaled**. With four unity inputs of ±1 they reach ±4 and ±4 by construction;
here, from a deliberately modest stimulus, they already measure **1.791** and
**2.594**. `diff` is the worse of the two because its two halves are
anti-correlated at this stimulus.

The face cannot clamp them. It can print them — and it can rank them so a player
knows the two jacks that will run a downstream input off its rails are the two
with no knob of their own.

---

## 3. RMS IS BLIND TO THE ONE THING AN ATTENUVERTER DOES

*Measured*, `att1` output at `att1_amount = −1` and `+1`:

| | rms dB | peak | centroid |
|---|---|---|---|
| `att1_amount = −1` | −4.08 | 0.900 | 4 Hz |
| `att1_amount = +1` | −4.08 | 0.900 | 4 Hz |

**Identical in every level statistic.** The two settings differ by
`Δ = 1.80e+0` — exactly twice the 0.9 amplitude, i.e. a pure sign flip. An
"is this control alive?" sweep built on RMS, peak or centroid reports the
attenuverter's *defining behaviour* as doing nothing.

That is a small, clean instance of the CLAUDE.md rule, and it is worth recording
here because **an attenuverter is the single most common control shape in the
unfaced tail** (`unityscalemathematik`, `moog9xx`, `polarizer`, `depolarizer`).
Any future sweep over those modules must use a signed comparison.

---

## 4. THE RANKING — four knobs, and the argument is about the JACKS

| rank | key | tier | why |
|---|---|---|---|
| 1 | `att1_amount` | mini | |
| 2 | `att2_amount` | compact | |
| 3 | `att3_amount` | plate | |
| 4 | `att4_amount` | plate | |
| 5 | `illogic-routing-{n}` | dock (panel) | the picture — §6. |

⚠ **THE RANKING IS FLAT ON PURPOSE, AND THAT IS ITSELF THE ARGUMENT.** Four
interchangeable channels have no priority — the `bluebox` situation. `order`
ranks them **by channel number**, so every prefix of the ranking is still a
recognisable "first N channels" rather than an arbitrary subset. The alternative
(rank by measured influence on `sum`: att1 = att2 > att3 > att4, which the Δ
column above literally gives) was considered and rejected: it produces the order
1, 2, 3, 4 anyway, and it would break the moment someone changed a driver.

⚠ **`faceTierCap('full') = 6` and this module has 4 params**, so `full` and
`dock` render the identical four cells — the `resofilter` collapse. The face's
value is entirely in the readouts, the sidebar and the picture, and this spec
says so rather than pretending the ladder buys anything.

⚠ **A panel's first legal rank is 7** and this face has **4** keys, so rank 7 is
**unreachable** — the drummergirl wall. The picture must be a sidebar `custom`
block (the meowbox answer), exactly as `resofilter` and `attenumix` did in
batch 4. There is no `hero.cell` on this face.

**NO AUDITION.** A passive utility.

---

## 5. THE FACE

```ts
face: {
  title: 'Attenuvert + logic',
  hint: 'The four logic jacks ignore all four knobs. SUM and DIFF are unscaled.',

  order: ['att1_amount', 'att2_amount', 'att3_amount', 'att4_amount'],
  // NO pages: four controls is one band, and a page costs ~81 px for nothing.
  glyph: 'meter',

  hero: {
    control: 'att1_amount',
    // NO `cell` — rank 7 unreachable with 4 keys. Picture -> sidebar.
    readouts: [
      { label: 'sum',  valueId: 'illogic-sum-headroom' },
      { label: 'diff', valueId: 'illogic-diff-headroom' },
      { label: 'logic', text: 'reads the RAW inputs' },
    ],
  },

  sidebar: [
    { kind: 'custom', label: 'what reaches what', panelId: 'illogic-routing',
      props: { channels: 4, attPrefix: 'att', logicOuts: 'and,or,nand,not' } },
    { kind: 'readouts', label: 'measured', entries: [
      { label: 'AND OR NAND NOT', text: 'pre-attenuverter — knobs do nothing' },
      { label: 'SUM',  text: 'unscaled: 1.79 peak at defaults' },
      { label: 'DIFF', text: 'unscaled: 2.59 peak at defaults' },
      { label: 'ATT n', text: 'sign flip is invisible to a level meter' },
    ] },
  ],
}
```

⚠ **`{ label: 'logic', text: 'reads the RAW inputs' }` is a `FaceReadout.text`,
not a hint** — deliberately. `face.hint` returns `null` at rest
(`facePageHeader(def, annotations = false)`), and this is the module's single most
load-bearing sentence. A `text` readout paints unconditionally.

⚠ **`glyph: 'meter'` needs a stated source, and here it has one.**
`primaryAudioOutPortId` picks the first **audio** output in declaration order —
illogic has **none** (four `cv`, four `gate`, two `cv`). So the shell glyph has
nothing to tap, the `drumseqz` case again. **Ship `glyph: 'none'` unless and
until the platform gains a declared glyph source**; `'meter'` is written above
only to name what it *should* read, which is `sum` — the jack most likely to be
over range.

⚠ **`panelId: 'illogic-routing'` must be registered in `sidebar-panels.ts`** and
is written generically (`channels`, `attPrefix`, `logicOuts`) so
`unityscalemathematik` and the `moog9xx` attenuverter family can reuse it.

---

## 6. DERIVED READOUTS + THE PICTURE

### A. `illogic-sum-headroom` / `illogic-diff-headroom`

The **worst-case** peak of each mixed bus from the four attenuverter values:
`|a1| + |a2| + |a3| + |a4|` and `|a1| + |a2| + |a3| + |a4|` (the difference bus
is worst-case identical), printed as **`x4.00 — clips`** at the defaults and
`x1.00` when three channels are at zero. Anchored on §2 (measured 1.791 / 2.594
from a 0.9/0.9/0.6/0.4 stimulus at unity).
**NEGATIVE CONTROL — the SIGN.** `att1_amount = −1` and `+1` must give the
**same** headroom number, because the worst case is the same; a derivation that
used the signed sum would read `x2.00` at the defaults and would be wrong the
moment two inputs went anti-phase — which is precisely the state that produced
the measured 2.594.
**SECOND CONTROL — `att1_amount = 0`,** which must drop the number by exactly one
unit, so the readout is proven to be counting channels rather than echoing a
constant.
⚠ **Publishing both `sum` and `diff` is their own pair control**: they must be
equal at every setting where the two halves are balanced and diverge nowhere,
because the worst case does not depend on the split. A derivation where they
differed would be reading the *actual* signal, which a param-only readout cannot.

### B. THE PICTURE — the routing map, in the SIDEBAR

Four input lines. Each passes a triangular attenuverter symbol (filled by the
knob's value, **hatched when negative** so the sign is visible) into the SUM and
DIFF buses. **A second, separate set of lines taps each input BEFORE its
attenuverter and runs to the four logic jacks**, drawn in a different weight.
That one drawing is the whole module, and it is the only representation in which
§1 is obvious rather than surprising.

---

## 7. ALREADY-WRONG

- **A · `sum` and `diff` are unscaled and reach 1.79 / 2.59** from a modest
  stimulus (§2), on a bus whose convention is ±1. Whether they should be scaled
  by `1/n` is an owner call and **its own PR** — it would re-pin
  `art/baselines/illogic/` (the profile pins `sum` and `diff` as signature
  outputs).
- **B · the four logic outputs are bit-exactly immune to the four knobs** (§1).
  Correct behaviour, **undocumented**: `docs.explanation` says "4 cv inputs feed
  bipolar attenuverters; post-attenuverter outputs sum into `sum` and `diff`"
  and then describes the logic block without saying the logic taps are *pre*.
  `illogic` is in `STRICT_DOCS`.
- **C · `IllogicCard.svelte` re-types 8 literal range props** in 42 lines;
  `illogic` is **not** in `RANGE_BOUND_CARDS`.
- **D · no audio output, so the shell glyph taps nothing** (§5).
- **No dead controls.** All four are live and orthogonal, verified in both
  directions.

---

## 8. COST

| | |
|---|---|
| **contract-lock** | **+0.** No control family, no audition, the picture is a sidebar `custom` block. |
| **ART** | none from the face. §7-A re-pins `art/baselines/illogic/` and is a separate PR. |
| **VRT** | +`face-illogic-{compact,dock}` × 2 = **4 informational baselines**. Silent unpatched. |
| **e2e** | +1 `faces-parity` row, **4 cells**. ≈ +11 s, ≈ +1.1 s per shard. |
| **the bottom line** | Four cells, identical at `full` and `dock`, no hero picture. It ships for one reason: **four of ten jacks are behind none of the knobs, and two more are 2.6× over the bus convention** — and the routing picture is the only place that can ever be said. |
