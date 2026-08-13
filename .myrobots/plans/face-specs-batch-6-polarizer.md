# FACE SPEC — `polarizer` (batch 6) — **VERDICT: NO FACE ON MERIT**

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


## 0. STATUS + THE ONE-LINE ANSWER

**Authored 2026-08-11 against the working tree of `main`.** Nothing here is
implemented; no def, card, DSP or test file is touched. Every number below was
measured through the **REAL shipping factory** (`polarizerDef.factory`) under
`node-web-audio-api`'s `OfflineAudioContext` — the same render path
`art/setup/offline.ts` uses — at 48 kHz. **Determinism control: two identical
renders, `max|r1 − r2| = 0.000e+0`,** for both this module and `depolarizer`.

**VERDICT: NO CURATED FACE ON MERIT.** 1 param, 1 in, 1 out. `faceTierCap`
(`curated-face.ts:62-79`) gives mini = 1, compact = 2-with-glyph / 3-without,
full = 6, dock = all, so **`face.order = ['depth']` selects the same single knob
at all four tiers** — the exact arithmetic that produced noise's `NO FACE ON
MERIT` (`face-specs-batch-3-noise.md` §2). The four tiers the whole curation
ladder exists to serve collapse into one.

**AND THE FINDING THAT IS WORTH MORE THAN THE SPEC: `polarizer` and
`depolarizer` are ONE MODULE.** Not "similar" — the same affine operator with
its direction flipped, implemented twice, in two files that differ by four
constants, behind two cards that are byte-identical apart from the def they
import and the string in `defaultLabel`. §3 makes the case, with the measured
composition law that proves it. **If one thing comes out of this batch, it
should be the merge, not two faceplates.**

**Six real defects fell out of the measurement** (§7), two of them in prose that
is in `STRICT_DOCS`.

---

## 1. THE COMPLETE CONTRACT

`contract-lock.txt:2516-2519` — **4 lines**, one of the smallest audio contracts
in the file:

```
polarizer meta domain=audio
polarizer in in cv
polarizer out out cv
polarizer param depth 0..1 linear default=1
```

| kind | id | type | range / default | notes |
|---|---|---|---|---|
| input | `in` | `cv` | — | no `paramTarget`, no `cvScale`, no `edge`. A raw signal input: the connection is a plain node→node edge, **unscaled and unclamped**. |
| output | `out` | `cv` | — | `out = (2·in − 1)·depth` |
| param | `depth` | linear | **0 … 1, default 1** | `polarizer.ts:65`. **No CV input targets it** — see §7-E. |

**Registry membership.** In `STRICT_DOCS` (`strict-docs.ts:60`). In
**`STRICT_VRT_MODULES`** (`vrt-exemptions.ts:1080`) — the required pixel gate.
**Not** in `STRICT_FACES`, no `face:` block. **Not** in `PUSH_CARD_CONTROLS`.
Has an ART profile (`art/scenarios/polarizer/profile.test.ts`, real-factory
offline render at `depth 0.8`) and a composite VRT scene
(`polarizer-cv-bipolar`, `vrt-composite-scenes.ts:905-916`).

**No DSP.** There is no worklet and no Faust source. The factory
(`polarizer.ts:82-106`) builds four native nodes:

```
in ──▶ inScale (gain = 2·depth) ──┐
                                  ├──▶ out (unity summing GainNode) ──▶ OUT
const(1) ──▶ offset (gain = −depth) ──┘
```

Both gains are written with `setValueAtTime` at `ctx.currentTime`
(`polarizer.ts:100-101`) — a **step**, never a ramp.

---

## 2. WHAT IT MEASURES AS

### 2.1 The instrument, and why the obvious one is wrong

⚠ **RMS and absolute peak are BLIND to polarity, and inverting a signal is the
entire subject of this module.** Measured, on the shipping default render and
its own exact inversion:

| metric | `out` | `−out` | verdict |
|---|---|---|---|
| rms | 0.707106781 | 0.707106781 | **BLIND** — identical |
| abs peak | 1.000000000 | 1.000000000 | **BLIND** — identical |
| least-squares slope of `out` vs `in` | **+2.000000** | **−2.000000** | sees it |
| signed mean | −2.384e-10 | +2.384e-10 | sees it |

So every number below comes from a **least-squares affine fit of `out` against
`in`**, which recovers `(slope, intercept)` directly — the two numbers the
module *is* — plus the signed min/max. A polarity-blind metric would have
returned a clean, confident, wrong answer for every row in §2.2.

### 2.2 The transfer function, swept

*Measured*, 0.25 s window, unipolar 4 Hz sine in `[0,1]`, N = 12 000:

| `depth` | slope | intercept | out range | max fit residual |
|---|---|---|---|---|
| 0.00 | 0.000000 | 0.000000 | [0.0000, 0.0000] | 0.00e+0 |
| 0.10 | 0.200000 | −0.100000 | [−0.1000, 0.1000] | 6.85e-9 |
| 0.25 | 0.500000 | −0.250000 | [−0.2500, 0.2500] | 7.46e-9 |
| 0.50 | 1.000000 | −0.500000 | [−0.5000, 0.5000] | 1.49e-8 |
| 0.75 | 1.500000 | −0.750000 | [−0.7500, 0.7500] | 6.02e-8 |
| 0.90 | 1.800000 | −0.900000 | [−0.9000, 0.9000] | 6.19e-8 |
| 1.00 | 2.000000 | −1.000000 | [−1.0000, 1.0000] | 2.99e-8 |

`slope = 2·depth`, `intercept = −depth`, exactly, to float32. The residual is
the two-staged-f32-op error and nothing else.

**Sample-accuracy confirmed, not assumed.** Max deviation from `(2·in − 1)·depth`
across the whole render: **2.980e-8 at 10 Hz, 2.980e-8 at 1 kHz, 1.490e-8 at
10 kHz, 1.490e-8 at 20 kHz.** No smoothing, no `linearRampToValueAtTime`
artefact, no block quantisation. The exported `polarize()` helper
(`polarizer.ts:43-45`) agrees with the real graph to **≤ 5.96e-8** at every
depth tested — it is a true mirror, not a drifted copy.

### 2.3 Plateau width against the quantisation floor

⚠ Required because "bit-identical" alone proves nothing. *Measured*, against a
`depth = 0.5` baseline:

| Δ`depth` | max\|Δ out\| |
|---|---|
| +1e-9 | **0.000e+0 (bit-identical)** |
| +1e-8 | **0.000e+0 (bit-identical)** |
| +1e-7 | 1.192e-7 |
| +1e-6 | 4.768e-7 |
| +1e-5 | 4.828e-6 |
| +1e-4 | 4.816e-5 |

**The plateau is ~1e-8 wide in `depth`** — i.e. `eps(float32)` on the
`2·depth ≈ 1.0` gain value, about **1.7e-8 of the knob's full travel**. There is
no dead zone, no stair, no inert region anywhere on this dial: it is continuous
to the float32 floor. Any "the knob did nothing" report on this module is a
report about something else.

### 2.4 The rest state — **an unpatched POLARIZER is a DC source**

*Measured*, nothing connected to `in`:

| `depth` | `out`, constant |
|---|---|
| 0.00 | 0.000000 |
| 0.25 | **−0.250000** |
| 0.50 | **−0.500000** |
| 0.75 | **−0.750000** |
| **1.00 (shipped default)** | **−1.000000** |

**A POLARIZER you drop on the canvas and never patch emits a full-scale
negative constant on its OUT jack.** This is arithmetically correct
(`(2·0 − 1)·1 = −1`) and completely unannounced: the card
(`PolarizerCard.svelte`), the def docs (`polarizer.ts:70-79`), the manifest
(`module-manifest.ts:198`) and the contract all say nothing about it. Patched
into a `cvScale: linear` param it pins that param at its **minimum**; patched
into an audio path it is a −1.0 DC offset. Compare `depolarizer`, whose rest
output is **+0.5 at every depth including 0** — the two halves of one operator
have opposite and equally unannounced idle behaviour.

Because `apply()` uses `setValueAtTime` (`polarizer.ts:100-101`), moving DEPTH
from 1 to 0 with nothing patched **steps** the OUT jack from −1.000000 to
0.000000 in one sample. ⚠ I could not capture the transition samples: see §8.

### 2.5 The wrong-domain hazard, and it is ASYMMETRIC

*Measured*, feeding each module the other one's domain:

| `depth` | **bipolar ±1 → POLARIZER** | span | unipolar 0..1 → DEPOLARIZER | span |
|---|---|---|---|---|
| 0.25 | [−0.7500, +0.2500] | 1.0000 | [0.5000, 0.6250] | 0.1250 |
| 0.50 | [−1.5000, +0.5000] | 2.0000 | [0.5000, 0.7500] | 0.2500 |
| **1.00** | **[−3.0000, +1.0000]** | **4.0000** | [0.5000, 1.0000] | 0.5000 |

A full-scale 1 kHz audio signal into POLARIZER at the shipped default measures
**[−3.0000, +1.0000] with −1.000000 of DC**.

**Patch it the wrong way round and POLARIZER produces three times full scale,
asymmetrically, plus a full-scale DC offset. DEPOLARIZER, patched the wrong way
round, merely halves the range and stays in bounds.** One direction of the pair
is dangerous and the other is lossy, and nothing on either card distinguishes
them. This is the single best argument for *any* surface on this module — and
§4 explains why a face cannot carry it.

---

## 3. THE CATALOGUE FINDING — `polarizer` and `depolarizer` are ONE MODULE

### 3.1 They are the same operator

```
polarize(x, d)   = (2x − 1)·d      = 0    + d·(x − 0.5)·2
depolarize(y, d) = 0.5 + d·(y/2)   = 0.5  + d·(y − 0)·0.5
```

Both are `out = centre_out + depth · (in − centre_in) · gain`, with

| | `centre_in` | `centre_out` | `gain` |
|---|---|---|---|
| polarizer | 0.5 | 0 | 2 |
| depolarizer | 0 | 0.5 | 0.5 |

That is one operator — *re-centre and rescale between the unipolar `[0,1]` and
bipolar `[−1,+1]` domains* — with the direction reversed. Nothing else differs.

### 3.2 The composition law, MEASURED through both real factories

`polarizer(d₁) → depolarizer(d₂)`, ramp input, least-squares fit of the chain:

| chain | slope | intercept |
|---|---|---|
| `d₁ = 0.5 → d₂ = 1` | 0.500000 | 0.250000 |
| `d₁ = 1 → d₂ = 0.5` | **0.500000** | **0.250000** |
| `d₁ = 0.25 → d₂ = 1` | 0.250000 | 0.375000 |
| `d₁ = 1 → d₂ = 0.25` | **0.250000** | **0.375000** |
| `d₁ = 0.5 → d₂ = 0.5` | 0.250000 | 0.375000 |

**The chain depends only on the PRODUCT `d₁·d₂`.** The two DEPTH knobs are
exactly interchangeable — measured to six decimals, both slope and intercept.
Two knobs on two modules that are one knob.

### 3.3 The cards are the same file

`PolarizerCard.svelte` and `DepolarizerCard.svelte` are **90 lines each** and
differ in exactly five places: the header comment, the imported def, the
`data-testid` prefix, `defaultLabel`, and the inline comment naming the formula.
Same `.vcard card cv` classes, same `--cable-cv` stripe, same `160px × 150px`
box, same single `<Knob>`, same `margin-top: 24px` body, same `.knob-row`.
Both correctly read their ranges from the def (`def('depth').min/max/
defaultValue`) — **neither has the backdraft-class card/def divergence**, which
is worth stating because it is the one thing they get right that a lot of cards
do not.

### 3.4 The merged module, concretely

```ts
{
  type: 'polarize',
  inputs:  [{ id: 'in', type: 'cv' }],
  outputs: [{ id: 'out', type: 'cv' }],
  params: [
    { id: 'direction', label: 'DIR', defaultValue: 0, min: 0, max: 1,
      curve: 'discrete', options: ['UNI→BI', 'BI→UNI'] },
    { id: 'depth', label: 'DEPTH', defaultValue: 1, min: 0, max: 1, curve: 'linear' },
  ],
}
```

One `GainNode` + one `ConstantSourceNode` + one summing node — the **same four
nodes both modules already build**; `direction` only chooses which pair of
constants `apply()` writes. Cost: 2 modules → 1, 8 contract lines → 6, two
`STRICT_VRT_MODULES` baselines → one, two ART profiles → one (or two scenarios
on one module), two 91-line cards → one.

**And the merged module is the one that DOES merit a face**, because it has a
`segmented` DIRECTION cell that only paints at the dock
(`shell-control-kind.ts:141-146`: an `options` roster is `segmented` at the dock
and a plain knob at every lane tier), which is the first thing in this whole
batch that makes the tiers differ from one another.

⚠ **What I could not determine: whether the owner wants it.** A merge is a
contract change (two module types disappear from the palette, two sets of
persisted patches need a migration or a compatibility alias) and that is an
owner call, not a spec's. **The engineering case is unambiguous; the product
case is not mine to make.**

### 3.5 …and the operation already exists twice more inside the repo

`applyBipolar(env01, bipolar) => bipolar ? 2 * env01 - 1 : env01`
(`packages/dsp/src/lib/synesthesia-dsp.ts:91-93`) is **`polarize(x, 1)`
verbatim**, and it ships as a per-module POLARITY toggle on `featurecv` and
`synesthesia`. So the catalogue already holds the position that
unipolar↔bipolar is a **mode on the source**, not a module. Two standalone
modules for it is a third implementation of a two-line function.

---

## 4. WHY NO FACE — THE ARITHMETIC, AND THE TWO WALLS

**A · One param means one control at every tier.** `face.order = ['depth']`;
`curatedFace` does `ranked.slice(0, cap)` with cap ∈ {1, 2, 6, ∞}. Mini,
compact, full and dock all paint the same `KnobConic`. The only thing that would
differ between tiers is the dock's *chrome* — title, hint, hero, sidebar — so
100 % of a face's value here has to come from readouts, and:

**B · THE READOUT REGISTRY DEGENERATES ON A ONE-PARAM MODULE.** `valueId` exists
precisely because "the nearest knob is not always the answer"
(`face-readout-values.ts:1-32`), and its stated bar is that a derived readout be
*negative-controlled on the input a knob readback would be blind to*. **On a
module with one param there is no such input.** Every computable readout is a
function of `depth`, so it is arithmetically a relabelled knob. A face here
could not clear the registry's own admission bar; it could only reformat.

**C · The one readout worth having is STRUCTURALLY UNREACHABLE.** The fact this
module most needs to state is *"IN is unpatched, so OUT is a constant −1.00"* —
and readouts read `node.params` only. A cable is a node input, not a param, so
connectivity never reaches the reader. This is the bluebox wall verbatim
(`strict-faces.ts`, bluebox entry: *"a gate cable is a node input, so neither
reaches `node.params`"*), and it lands on exactly the number that matters here.

**D · A hero PICTURE is illegal on this module.** `module-face-lint.test.ts:629-663`
fails a panel cell selected at any lane tier, and the `full` cap is 6, so a
panel's first legal rank is **7**. A module with one param can never reach rank
7. The transfer-function plot — the obvious and genuinely good picture for an
affine mapper — cannot be a `hero.cell`. meowbox's escape (a sidebar `custom`
block, which carries no `face.order` key and therefore no rank) is available and
is **dock-only**, so the picture would never appear in a lane at all.

**E · It is in the REQUIRED pixel lane.** `polarizer` is in
`STRICT_VRT_MODULES` (`vrt-exemptions.ts:1080`). A face adds
`face-polarizer-{compact,dock}` informational baselines *and* any card change
re-captures the required one. That is real CI cost against a one-knob tile.

**The honest bottom line: a `polarizer` face buys one dial, one glyph and some
reformatted arithmetic, at the price of new baselines in a required lane, for a
module that should not exist separately in the first place.**

---

## 5. THE CONTINGENCY FACE — only if §3 is rejected AND the owner overrules §4

Deliberately built around the two facts that are not on the dial (the overrange
hazard and the round-trip law), not around the dial.

```ts
face: {
  title: 'Polarity',
  hint: 'Unipolar 0..1 in, bipolar +-depth out. Unpatched, OUT sits at -DEPTH.',

  order: ['depth'],          // the entire control surface. Ranks 2+ do not exist.

  pages: [
    { id: 'map', label: 'map',
      hint: 'out = (2 x in - 1) x DEPTH  -  slope 2d, offset -d',
      controls: ['depth'] },
  ],

  glyph: 'none',             // see the note below

  hero: {
    control: 'depth',
    // NO `cell:` — a panel cannot be ranked on a 1-param module (SS4-D).
    readouts: [
      { label: 'in 0',    valueId: 'polarizer-at-zero' },   // "-1.00"
      { label: 'in 1',    valueId: 'polarizer-at-one'  },   // "+1.00"
      { label: 'unpatched', valueId: 'polarizer-rest' },    // "-1.00 at OUT"
    ],
  },

  sidebar: [
    { kind: 'readouts', label: 'if IN is bipolar', entries: [
      { label: 'at in -1', valueId: 'polarizer-overrange' },   // "-3.00  OVER"
      { label: 'span',     valueId: 'polarizer-span' },        // "4.00 (of 2.00)"
      { label: 'note',     text: 'POLARIZER wants 0..1. A +-1 source overshoots 3x.' },
    ] },
    { kind: 'readouts', label: 'round trip', entries: [
      { label: 'x DEPOLARIZER', valueId: 'polarizer-roundtrip' }, // "0.25x  NOT unity"
      { label: 'unity only at', text: 'DEPTH = 1.00 on both' },
    ] },
    { kind: 'presets', label: 'settings', entries: [
      { id: 'full', label: 'full swing',  note: '+-1.00', values: { depth: 1 } },
      { id: 'half', label: 'half swing',  note: '+-0.50', values: { depth: 0.5 } },
      { id: 'mute', label: 'flat zero',   note: '0.00',   values: { depth: 0 } },
    ] },
  ],
}
```

⚠ **`glyph: 'none'` is deliberate and is the opposite of the reflex choice.**
`'scope'` would paint the OUT trace, and at rest that trace is a **flat line at
−1.00, pinned to the bottom of the box** — visually indistinguishable from a
broken tap, on the module whose whole job is sign. `'meter'` is worse: it is
level, and level is exactly the polarity-blind metric §2.1 disqualifies.
A glyph here would be the blind-instrument failure drawn on a faceplate.

⚠ **`hint` and `title` paint nothing at rest** (dock-only, like the whole PF-20
block).

**Band-hint budget:** `'out = (2 x in - 1) x DEPTH  -  slope 2d, offset -d'` =
**51 chars**; fallback **24**: `'slope 2d, offset -d'`.

---

## 6. THE READOUTS — what each would say, and its honest status

| id | prints (at `depth = 1`) | is it more than the knob? |
|---|---|---|
| `polarizer-at-zero` | `-1.00` | **units, not information.** Reformats `−depth`. |
| `polarizer-at-one` | `+1.00` | reformats `+depth`. |
| `polarizer-rest` | `-1.00 at OUT` | **YES — states the §2.4 fact nobody documents.** Unconditionally true (`in = 0 ⟹ out = −depth`), so it does not need the connectivity the reader cannot see. |
| `polarizer-overrange` | `-3.00  OVER` | **YES, the best one.** `(2·(−1) − 1)·depth = −3·depth`. Names the §2.5 hazard, which appears on no dial and in no doc. |
| `polarizer-span` | `4.00 (of 2.00)` | the same fact as a ratio. |
| `polarizer-roundtrip` | `1.00x` at depth 1, **`0.25x` at depth 0.5** | **YES — it contradicts the def's own prose** (§7-A) and it is the only surface anywhere that would. |

**The negative control, stated honestly.** The registry's bar is a perturbation
the knob readback is blind to. **There is none available**, because there is one
param. What *can* be permanently gated in a `polarizer-face-model.test.ts` is
the pair of directional legs: `polarizer-overrange` must move **3×** as fast as
`polarizer-at-one` under the same `depth` change (`−3d` vs `+d`), and
`polarizer-roundtrip` must move **quadratically** (`d²`) where both others move
linearly. A relabelled-knob implementation of any of the three would fail the
other two's ratio assertions. That is a weaker guarantee than the registry
asks for and I am not going to dress it up as an equal one.

---

## 7. ALREADY-WRONG — six defects, two of them in `STRICT_DOCS` prose

**A · "It is the exact inverse of DEPOLARIZER" is FALSE except at one knob
position.** `polarizer.ts:70`, in the `docs.explanation` of a module that is in
`STRICT_DOCS`. *Measured*, both real factories, matched depths, ramp input:

| `depth` on both | chain slope | chain intercept | max\|out − in\| |
|---|---|---|---|
| 0.00 | 0.000000 | 0.500000 | 0.500000 |
| 0.25 | 0.062500 | 0.468750 | 0.468750 |
| 0.50 | 0.250000 | 0.375000 | 0.375000 |
| 0.75 | 0.562500 | 0.218750 | 0.218750 |
| 0.90 | 0.810000 | 0.095000 | 0.095000 |
| **1.00** | **1.000000** | **−0.000000** | **0.000000** |

The round trip is `out = d²·in + (1 − d²)/2` — an identity **only at
`depth = 1`**. At the halfway position it crushes the signal to a quarter of its
range and re-centres it on 0.375. The reverse chain (`depolarizer → polarizer`)
measures the same `d²` slope with intercept 0. The sentence is true of the
defaults and false of the control.

**B · The rest output is a full-scale DC source and nothing says so** (§2.4).
Not a bug — an undocumented behaviour on a module in `STRICT_DOCS`, in a repo
whose CV convention (`cv-scale.ts:1-8`) makes **0**, not −1, the neutral value.

**C · The overrange is unbounded and unwarned** (§2.5): −3.0 at the shipped
default from a source the user is very likely to have (any `±1` LFO — which is
what this repo's own CV standard says a `cv` cable carries). `scaleCv` clamps at
`±1` on the way into a *param* (`cv-scale.ts:62`), so a param destination is
protected — but **`in` on a module like `scaler`, `vca`, another `polarizer`, or
any audio node is a raw edge with no clamp at all**, and that is where −3.0
lands.

**D · The card and the def disagree about the primitive, harmlessly, today.**
`polarizer.ts:78` documents DEPTH as *"a linear 0..1 **fader**"*;
`PolarizerCard.svelte:52` renders a `<Knob>`. Currently cosmetic. It matters for
a face because **`ParamCellKind` has no `'fader'` member** —
`shell-control-kind.ts:33-40` is exactly
`'knob' | 'momentary' | 'toggle' | 'segmented' | 'selector' | 'grid' | 'color'`
— so a face could not honour the doc even if it wanted to, and the doc should be
corrected to "knob" rather than the face inventing a primitive.

**E · DEPTH has no CV input, and its sibling utilities all do.**
`unityscalemathematik` gives every attenuverter and every curve its own
`paramTarget` CV port (`unityscalemathematik.ts:88-97`); `polarizer` gives DEPTH
none. Across the audio modules there are **449** `paramTarget` CV ports and
**zero** of them are on this module. For a *modulation* utility, "the amount
cannot be modulated" is a real functional gap — and it is the single feature
that would make the merged module of §3.4 worth more than the sum of the two.

**F · `modules-card-map.test.ts` no longer covers what its header claims.** Its
comment promises the glob map reproduces the migration set *"no module dropped,
none spuriously added"*, but only the **dropped** direction is asserted, and a
source scan finds **34** registered module types outside `EXPECTED_NODE_TYPES`
(one, `cadillac`, is declared `NO_CARD_BY_DESIGN`). `polarizer` and
`depolarizer` are *in* the list; `flipper` is not. Filed here because it is the
gate a new merged module would be added to. ⚠ The 34 is from a regex scan of
`type: '…'` declarations, not from the live registry — treat the *existence* of
the gap as measured and the *count* as approximate.

---

## 8. WHAT I COULD NOT DETERMINE

- **The shape of a DEPTH-change click.** `OfflineAudioContext.suspend()` under
  `node-web-audio-api` never returned — the harness ran > 300 s at that step and
  had to be killed, with every earlier step completing in seconds — so I could
  not capture the transition samples. What is established: the write is
  `setValueAtTime` with no ramp (`polarizer.ts:100-101`), and the step's
  *magnitude* is bounded by the measured endpoint tables (a full `depth 1 → 0`
  move with a DC +1 input steps `out` by 1.000000; unpatched, by 1.000000).
  The waveform is **not measured**.
- **Whether the owner wants the merge** (§3.4). Engineering case: unambiguous.
  Product case: not mine.
- **The actual pixel cost of a face.** No face was rendered; the baseline counts
  in §9 are predicted, not measured.

---

## 9. COST — if a face ships anyway

| | |
|---|---|
| **contract-lock** | **+0 lines.** `face` is UI metadata, out of `contract-signature.ts` (`types.ts:522-527`). §7-E, if taken, is +1 line and a real contract change. |
| **attest** | **zero.** `face` is stripped from every attest hash by `scripts/attest-code-basis.ts`. No re-attest, nothing to remember. |
| **ART** | none from the face. `art/scenarios/polarizer/profile.test.ts` pins the real-factory render at `depth 0.8`; the face does not touch it. A §3 merge WOULD re-pin it. |
| **VRT — ⚠ REQUIRED LANE** | `polarizer` is in `STRICT_VRT_MODULES`. +`face-polarizer-{compact,dock}` = 2 informational baselines; any card edit re-captures the required one plus the `polarizer-cv-bipolar` composite. |
| **e2e** | +1 `faces-parity` row, **1 cell**. The smallest possible. |
| **the honest bottom line** | One knob, four identical tiers, one legitimately-new readout (`polarizer-overrange`), and a module that should be half of one module. **Do §3 instead.** |
