# FACE SPEC — `depolarizer` (batch 6) — **VERDICT: NO FACE ON MERIT**

## 0. STATUS + THE ONE-LINE ANSWER

**Authored 2026-08-11 against the working tree of `main`.** Nothing here is
implemented; no def, card, DSP or test file is touched. Every number was
measured through the **REAL shipping factory** (`depolarizerDef.factory`) under
`node-web-audio-api`'s `OfflineAudioContext` — the render path
`art/setup/offline.ts` uses — at 48 kHz. **Determinism control: two identical
renders, `max|r1 − r2| = 0.000e+0`.**

**VERDICT: NO CURATED FACE ON MERIT.** 1 param, 1 in, 1 out. `faceTierCap`
(`curated-face.ts:62-79`) caps the tiers at 1 / 2-or-3 / 6 / ∞, so
`face.order = ['depth']` selects **the same single knob at all four tiers**.
Same arithmetic as noise (`face-specs-batch-3-noise.md` §2), same conclusion.

**AND: this module should not exist separately from `polarizer`.** They are one
affine operator with the direction flipped. The full merge argument, with the
measured composition law, is in **`face-specs-batch-6-polarizer.md` §3**; §3
below states it standalone. **That finding is worth more than either face.**

**But this module also carries the one defect of the pair that is not merely a
documentation slip: its stated purpose contradicts the repo's own CV
convention** (§5-A). That is worth more than the merge is worth arguing about.

---

## 1. THE COMPLETE CONTRACT

`contract-lock.txt:800-803` — **4 lines**:

```
depolarizer meta domain=audio
depolarizer in in cv
depolarizer out out cv
depolarizer param depth 0..1 linear default=1
```

| kind | id | type | range / default | notes |
|---|---|---|---|---|
| input | `in` | `cv` | — | no `paramTarget`, no `cvScale`, no `edge`. A raw node→node edge: **unscaled, unclamped**. |
| output | `out` | `cv` | — | `out = 0.5 + depth·(in/2)` |
| param | `depth` | linear | **0 … 1, default 1** | `depolarizer.ts:67`. **No CV input targets it** — see §5-E. |

**Registry membership.** In `STRICT_DOCS` (`strict-docs.ts:61`). In
**`STRICT_VRT_MODULES`** (`vrt-exemptions.ts:1079`) — the required pixel gate.
**Not** in `STRICT_FACES`, no `face:` block. **Not** in `PUSH_CARD_CONTROLS`.
Has an ART profile (`art/scenarios/depolarizer/profile.test.ts`) and a composite
VRT scene (`depolarizer-cv-unipolar`, `vrt-composite-scenes.ts:683-693`).

**No DSP.** No worklet, no Faust. The factory (`depolarizer.ts:84-108`) builds:

```
in ──▶ inScale (gain = depth/2) ──┐
                                  ├──▶ out (unity summing GainNode) ──▶ OUT
const(1) ──▶ centre (gain = 0.5, FIXED) ──┘
```

⚠ **Note the asymmetry with `polarizer`, which is real and load-bearing:** here
the offset gain is a **constant 0.5** written once at construction
(`depolarizer.ts:95`) and only the slope tracks DEPTH (`:103`). In `polarizer`
**both** terms track DEPTH. That is the difference between "the output is
centred on the destination domain's neutral" and "the output shrinks toward
zero" — see §2.4.

---

## 2. WHAT IT MEASURES AS

### 2.1 The instrument, and why the obvious one is wrong

⚠ **RMS and absolute peak are polarity-blind, and this module's whole subject is
where zero sits.** Measured on the sibling's default render against its own
exact inversion, as the instrument's negative control:

| metric | signal | its exact inversion | verdict |
|---|---|---|---|
| rms | 0.707106781 | 0.707106781 | **BLIND** |
| abs peak | 1.000000000 | 1.000000000 | **BLIND** |
| least-squares slope | +2.000000 | −2.000000 | sees it |

Worse for *this* module specifically: **abs-peak is also blind to the 0.5
pedestal**, which is the only thing `depolarizer` adds. Every measurement below
therefore comes from a **least-squares affine fit of `out` vs `in`**, recovering
`(slope, intercept)` — where the intercept *is* the pedestal — plus signed
min/max.

### 2.2 The transfer function, swept

*Measured*, 0.25 s window, bipolar 4 Hz sine in `[−1,+1]`, N = 12 000:

| `depth` | slope | intercept | out range | max fit residual |
|---|---|---|---|---|
| 0.00 | 0.000000 | **0.500000** | [0.5000, 0.5000] | 0.00e+0 |
| 0.10 | 0.050000 | 0.500000 | [0.4500, 0.5500] | 2.98e-8 |
| 0.25 | 0.125000 | 0.500000 | [0.3750, 0.6250] | 3.05e-8 |
| 0.50 | 0.250000 | 0.500000 | [0.2500, 0.7500] | 3.02e-8 |
| 0.75 | 0.375000 | 0.500000 | [0.1250, 0.8750] | 3.78e-8 |
| 0.90 | 0.450000 | 0.500000 | [0.0500, 0.9500] | 4.55e-8 |
| 1.00 | 0.500000 | 0.500000 | [0.0000, 1.0000] | 3.04e-8 |

`slope = depth/2`, `intercept = 0.5` **invariantly**, to float32.
**The intercept does not move. That is the whole difference from `polarizer`**,
whose intercept tracks `−depth` row for row.

The exported `depolarize()` helper (`depolarizer.ts:46-48`) agrees with the real
graph to **≤ 4.77e-8** at every depth tested — a true mirror.

### 2.3 Plateau width against the quantisation floor

⚠ Required, because "bit-identical" alone proves nothing. *Measured* against a
`depth = 0.5` baseline:

| Δ`depth` | max\|Δ out\| |
|---|---|
| +1e-9 | **0.000e+0 (bit-identical)** |
| +1e-8 | **0.000e+0 (bit-identical)** |
| +1e-7 | 5.960e-8 |
| +1e-6 | 2.980e-7 |

**The plateau is ~1e-8 wide in `depth`** — float32 `eps` on the `depth/2 ≈ 0.25`
gain, about **1.7e-8 of full travel**. Continuous to the floor; no dead zone,
no stair, no inert region. (The absolute deltas run 2× smaller than
`polarizer`'s at the same Δ`depth`, which is exactly the 4× gain ratio between
`2·depth` and `depth/2` showing up in the mantissa — a second, independent
confirmation that the instrument is reading the right quantity.)

### 2.4 The rest state — **an unpatched DEPOLARIZER is a +0.5 DC source, at EVERY depth**

*Measured*, nothing connected to `in`:

| `depth` | `out`, constant |
|---|---|
| 0.00 | **0.500000** |
| 0.25 | **0.500000** |
| 0.50 | **0.500000** |
| 0.75 | **0.500000** |
| **1.00 (shipped default)** | **0.500000** |

**DEPTH cannot silence this module.** At `depth = 0` it is not off — it is a
constant +0.5 CV source, and it emits that constant whether or not anything is
patched. Compare `polarizer`, whose rest output is `−depth` and *does* reach
0.000000 at `depth = 0`. **The two halves of one operator have opposite idle
behaviour and opposite "off" semantics, and neither card says a word.**

The def calls 0.5 *"the natural 'neutral' unipolar value"* (`depolarizer.ts:16`,
and again in `docs.controls.depth` at `:80`). §5-A is why that is the wrong
neutral for this repo.

### 2.5 The wrong-domain behaviour — benign, and the asymmetry is the finding

*Measured*, feeding it a unipolar `0..1` source (i.e. patched the wrong way
round):

| `depth` | out range | span |
|---|---|---|
| 0.25 | [0.5000, 0.6250] | 0.1250 |
| 0.50 | [0.5000, 0.7500] | 0.2500 |
| **1.00** | [0.5000, 1.0000] | 0.5000 |

A full-scale 1 kHz audio signal at the shipped default measures
**[0.0000, 1.0000] with +0.500000 of DC** — in bounds.

**Patched wrong, DEPOLARIZER is merely lossy: half the range, no overshoot.
Patched wrong, POLARIZER produces [−3.0000, +1.0000] — three times full scale
with a full-scale DC offset** (measured; `face-specs-batch-6-polarizer.md`
§2.5). One direction of the pair is dangerous and the other is safe, and the two
identical-looking cards give the user no way to know which is which. **That
asymmetry is the single most useful thing either module could tell you, and §4-C
is why a face cannot tell you it.**

---

## 3. THE CATALOGUE FINDING (standalone) — this is half of one module

```
polarize(x, d)   = (2x − 1)·d    = 0    + d·(x − 0.5)·2
depolarize(y, d) = 0.5 + d·(y/2) = 0.5  + d·(y − 0)·0.5
```

One operator, `out = centre_out + depth·(in − centre_in)·gain`, direction
reversed. **Measured** composition through both real factories,
`polarizer(d₁) → depolarizer(d₂)`, ramp input:

| chain | slope | intercept |
|---|---|---|
| `d₁ = 0.5 → d₂ = 1` | 0.500000 | 0.250000 |
| `d₁ = 1 → d₂ = 0.5` | **0.500000** | **0.250000** |
| `d₁ = 0.25 → d₂ = 1` | 0.250000 | 0.375000 |
| `d₁ = 1 → d₂ = 0.25` | **0.250000** | **0.375000** |

**The chain depends only on the product `d₁·d₂` — the two DEPTH knobs are
exactly interchangeable, to six decimals in both slope and intercept.**

`DepolarizerCard.svelte` and `PolarizerCard.svelte` are 90 lines each and differ
in five places (header comment, imported def, `data-testid` prefix,
`defaultLabel`, one inline formula comment). Both correctly source their ranges
from the def — neither carries the backdraft-class card/def divergence.

The merged shape (`type: 'polarize'`, a `direction` param with
`options: ['UNI→BI','BI→UNI']` plus `depth`) is spelled out in
`face-specs-batch-6-polarizer.md` §3.4. It uses **the same four Web Audio nodes
both modules already build**. It is also the version that would *earn* a face,
because `direction` is a `segmented` cell at the dock and a knob in the lane
(`shell-control-kind.ts:141-146`) — the first thing in this batch that makes the
tiers differ from each other.

⚠ **And the operation already exists inside the repo twice more.**
`applyBipolar(env01, bipolar) => bipolar ? 2 * env01 - 1 : env01`
(`packages/dsp/src/lib/synesthesia-dsp.ts:91-93`) is `polarize(x, 1)` verbatim,
shipping as a POLARITY toggle on `featurecv` and `synesthesia` — i.e. the
catalogue already treats unipolar↔bipolar as **a mode on the source**. Two
standalone modules make it three implementations of a two-line function.

⚠ **What I could not determine: whether the owner wants the merge.** It is a
contract change with a persisted-patch migration behind it — an owner call.

---

## 4. WHY NO FACE — THE ARITHMETIC AND THE FOUR WALLS

**A · One param means one control at every tier.** `curatedFace` does
`ranked.slice(0, cap)` with cap ∈ {1, 2, 6, ∞}; a one-key `order` yields one
`KnobConic` at mini, compact, full and dock alike. Only the dock's *chrome*
(title / hint / hero / sidebar) would differ, so all the value has to come from
readouts.

**B · The readout registry DEGENERATES here.** `valueId` exists because "the
nearest knob is not always the answer", and its admission bar
(`face-readout-values.ts:26-31`) is a **negative control on an input the knob
readback is blind to**. On a one-param module there is no such input: every
computable readout is a function of `depth`. A face here could reformat, not
inform, and could not clear the registry's own bar.

**C · The best readout is STRUCTURALLY UNREACHABLE.** The thing this module most
needs to say is *"nothing is patched, so OUT is a constant 0.5 and your
destination is pinned 25 % above its knob"* — and readouts read `node.params`.
A cable is a node **input**, so connectivity never reaches the reader. This is
the bluebox wall verbatim (`strict-faces.ts`, bluebox entry), landing precisely
on this module's most important fact.

**D · A hero PICTURE is illegal here.** `module-face-lint.test.ts:629-663` fails
a panel cell selected at any lane tier and the `full` cap is 6, so a panel's
first legal rank is **7** — unreachable with one param. The transfer-function
plot, which is the obvious and genuinely good picture for an affine mapper,
cannot be a `hero.cell`. The meowbox escape (a sidebar `custom` block, which
carries no `face.order` key and so no rank) works but is **dock-only** — the
picture would never reach a lane tile.

**E · It is in the REQUIRED pixel lane** (`vrt-exemptions.ts:1079`). New face
baselines are informational, but any card edit re-captures a required one plus
the `depolarizer-cv-unipolar` composite.

---

## 5. ALREADY-WRONG — five defects, and the first is not a typo

### A · ⚠ THE STATED PURPOSE CONTRADICTS THE REPO'S OWN CV CONVENTION

`depolarizer.ts:72` (`docs.explanation`, `STRICT_DOCS`) and
`module-manifest.ts:200` both say the same thing: *"feed a bipolar source into a
destination that expects a 0..1 control voltage — a level, depth or mix-amount
CV input."*

`cv-scale.ts:1-8` says the opposite, as a **project convention**:

> the `cv` cable type carries a bipolar -1..+1 modulation signal. ±1 should
> sweep the destination param through its FULL natural range, **centered on the
> user-set knob position**.

And the code enforces it. `scaleCv` **clamps the incoming CV to `[−1, +1]`**
(`cv-scale.ts:62`) and then, in `linear` mode, computes
`knob + cv·depth·halfSpan` (`:67-71`). Under that law a `0..1` CV is not
"what the destination wants" — it is **a half-range modulator that can only push
a knob UP**, which is the exact deficiency `polarizer` exists to cure. Counted
across the audio modules: **449** `paramTarget` CV ports vs **3**
`mode: 'passthrough'` declarations, so ~all destinations are `±1`-scaled.

Concretely, at `depth = 1` with **nothing patched**, DEPOLARIZER emits
`cv = 0.5` forever; into a `0..1 linear` param sitting at knob 0.5 that resolves
to `0.5 + 0.5·0.5 = **0.75**` — the destination is permanently pinned a quarter
of its span high by a module the user believes is neutral. At `depth = 0`,
supposedly "off", it is **the same 0.5**.

**This is not a wording slip. It is a module whose documented use case is the
one the platform's CV standard rules out, and whose "neutral" value is a
non-neutral offset under that standard.** It has real uses — a raw multiply
input (`scaler`, a VCA gain, another module's non-`paramTarget` `in`), or one of
the three `passthrough` ports — and the doc should name *those* instead of
"a level, depth or mix-amount CV input".

### B · "the output always rests at 0.5 … the natural 'neutral' unipolar value"

`depolarizer.ts:16` and `:80`. True of the `[0,1]` domain in the abstract; false
of this repo, where neutral is **0** (§5-A). And measured (§2.4), the rest value
is 0.5 at **every** depth including 0 — so the module cannot be turned off from
its own front panel. That combination is worth saying out loud somewhere, and
today it is said nowhere.

### C · "The exact inverse of POLARIZER" holds at exactly one knob position

`polarizer.ts:70` carries the reciprocal claim; both are in `STRICT_DOCS`.
*Measured*, both real factories at matched depths, ramp input:

| `depth` on both | chain slope | chain intercept | max\|out − in\| |
|---|---|---|---|
| 0.25 | 0.062500 | 0.468750 | 0.468750 |
| 0.50 | 0.250000 | 0.375000 | 0.375000 |
| 0.75 | 0.562500 | 0.218750 | 0.218750 |
| 0.90 | 0.810000 | 0.095000 | 0.095000 |
| **1.00** | **1.000000** | **−0.000000** | **0.000000** |

The round trip is `d²·in + (1 − d²)/2`; an identity **only at `depth = 1`**. The
reverse order (`depolarizer → polarizer`) measures the same `d²` slope with
intercept 0. **True of the defaults, false of the control.**

### D · The def calls DEPTH a "fader"; the card renders a knob

`depolarizer.ts:80` — *"on a linear 0..1 **fader**"*. `DepolarizerCard.svelte:52`
renders `<Knob>`. Harmless today. It matters for a face only because
**`ParamCellKind` has no `'fader'` member**: `shell-control-kind.ts:33-40` is
exactly `'knob' | 'momentary' | 'toggle' | 'segmented' | 'selector' | 'grid' |
'color'`. A face could not honour the doc, so the **doc** should change, not the
shell. (Stated because the batch brief asked for a `fader` cell where the card
uses one — this card does not use one, and the primitive does not exist.)

### E · DEPTH has no CV input, and the sibling utilities all do

`unityscalemathematik` gives every attenuverter and every curve its own
`paramTarget` CV port (`unityscalemathematik.ts:88-97`); `depolarizer` gives
DEPTH none, and neither does `polarizer`. For a modulation utility, "the amount
cannot be modulated" is a genuine functional gap — and adding it once to the
merged module of §3 is strictly cheaper than adding it twice.

---

## 6. THE CONTINGENCY FACE — only if §3 is rejected AND the owner overrules §4

Built entirely around §5-A, because that is the only thing here a user cannot
work out from the dial.

```ts
face: {
  title: 'Polarity',
  hint: 'Bipolar in, 0..1 out centred on 0.5. DEPTH never moves the centre.',

  order: ['depth'],          // the entire control surface. Ranks 2+ do not exist.

  pages: [
    { id: 'map', label: 'map',
      hint: 'out = 0.5 + DEPTH x (in / 2)  -  slope d/2, offset 0.5 ALWAYS',
      controls: ['depth'] },
  ],

  glyph: 'none',             // see the note below

  hero: {
    control: 'depth',
    // NO `cell:` — a panel cannot be ranked on a 1-param module (SS4-D).
    readouts: [
      { label: 'in -1',   valueId: 'depolarizer-at-min' },   // "0.00"
      { label: 'in +1',   valueId: 'depolarizer-at-max' },   // "1.00"
      { label: 'at rest', valueId: 'depolarizer-rest' },     // "0.50 - always"
    ],
  },

  sidebar: [
    { kind: 'readouts', label: 'into a scaled CV input', entries: [
      { label: 'offset',  valueId: 'depolarizer-knob-push' },  // "+25% of span"
      { label: 'reaches', valueId: 'depolarizer-reach' },      // "up only"
      { label: 'note',    text: 'A cv port is +-1 centred on the knob. 0..1 only pushes UP.' },
    ] },
    { kind: 'readouts', label: 'round trip', entries: [
      { label: 'x POLARIZER', valueId: 'depolarizer-roundtrip' },  // "0.25x  NOT unity"
      { label: 'unity only at', text: 'DEPTH = 1.00 on both' },
    ] },
    { kind: 'presets', label: 'settings', entries: [
      { id: 'full', label: 'full 0..1',  note: '0.00-1.00', values: { depth: 1 } },
      { id: 'half', label: 'half swing', note: '0.25-0.75', values: { depth: 0.5 } },
      { id: 'dc',   label: 'flat 0.5',   note: 'still emits', values: { depth: 0 } },
    ] },
  ],
}
```

⚠ **`glyph: 'none'` is deliberate.** `'scope'` on this module paints a trace
that at rest is a **flat line offset above centre**, which reads as a stuck tap
rather than a working pedestal; `'meter'` is level, and level is the
polarity-and-pedestal-blind metric §2.1 disqualifies. ⚠ Note also the preset
label — *"flat 0.5 — still emits"* — is doing the work the word "off" would get
wrong.

⚠ **`title` / `hint` paint NOTHING at rest** (PF-20 block is dock-only).

**Band-hint budget:** `'out = 0.5 + DEPTH x (in / 2)  -  slope d/2, offset 0.5 ALWAYS'`
= **60 chars**; fallback **28**: `'slope d/2, offset ALWAYS 0.5'`.

---

## 7. THE READOUTS — what each says, and its honest status

| id | prints (at `depth = 1`) | more than the knob? |
|---|---|---|
| `depolarizer-at-min` | `0.00` | units, not information. |
| `depolarizer-at-max` | `1.00` | units, not information. |
| `depolarizer-rest` | `0.50 - always` | **YES.** States §2.4: the value is depth-INVARIANT, which is precisely what a dial cannot show. |
| `depolarizer-knob-push` | `+25% of span` | **YES, the best one.** `0.5 · halfSpan / span` from `cv-scale.ts:67-71`. States §5-A in the one unit a patcher can act on. |
| `depolarizer-reach` | `up only` | **YES.** A `0..1` CV never goes negative, so the destination can only rise. Flips to `up + down` only if the merged module of §3 is built. |
| `depolarizer-roundtrip` | `1.00x` at 1, **`0.25x` at 0.5** | **YES — contradicts the def's own prose** (§5-C), and is the only surface anywhere that would. |

**The negative control, stated honestly.** The registry's bar is a perturbation
the knob readback is blind to, and **there is none** — one param. What a
permanent `depolarizer-face-model.test.ts` CAN gate is the *shape* of each
function against the others under one `depth` sweep: `depolarizer-rest` must be
**invariant** while `-at-max` moves **linearly** and `-roundtrip` moves
**quadratically** (`d²`). A relabelled-knob implementation of any one of the
three fails the other two's assertions. **That is weaker than the registry asks
for, and I am not going to present it as equivalent.**

---

## 8. WHAT I COULD NOT DETERMINE

- **The shape of a DEPTH-change click.** `OfflineAudioContext.suspend()` under
  `node-web-audio-api` never returned (harness ran > 300 s at that step and was
  killed; every other step completed in seconds). Established: the write is
  `setValueAtTime` with no ramp (`depolarizer.ts:103`) and the step's
  *magnitude* is bounded by the §2.2 endpoint table (a full `depth 1 → 0` move
  with a DC +1 input steps `out` by 0.500000 — half the sibling's, because only
  the slope term moves). The waveform is **not measured**.
- **Whether the owner wants the merge** (§3).
- **The pixel cost of a face** — nothing was rendered; §9's counts are predicted.
- **Whether any live patch relies on the +0.5 rest offset.** I did not survey
  saved patches, so §5-A is a design finding, not a regression report.

---

## 9. COST — if a face ships anyway

| | |
|---|---|
| **contract-lock** | **+0 lines.** `face` is UI metadata, out of `contract-signature.ts` (`types.ts:522-527`). §5-E, if taken, is +1 line and a real contract change. |
| **attest** | **zero.** `scripts/attest-code-basis.ts` strips `face` from every attest hash. |
| **ART** | none from the face. `art/scenarios/depolarizer/profile.test.ts` is untouched; a §3 merge WOULD re-pin it. |
| **VRT — ⚠ REQUIRED LANE** | in `STRICT_VRT_MODULES`. +`face-depolarizer-{compact,dock}` = 2 informational baselines; any card edit re-captures the required one plus `depolarizer-cv-unipolar`. |
| **e2e** | +1 `faces-parity` row, **1 cell**. |
| **the honest bottom line** | One knob, four identical tiers. The face's whole case rests on `depolarizer-knob-push`, and **that readout is really a bug report about §5-A**. Fix the doc and the convention mismatch; do §3; do not ship a faceplate to carry a correction. |
