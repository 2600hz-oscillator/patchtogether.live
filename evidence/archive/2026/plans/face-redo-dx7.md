# face re-do — dx7

> **LIVE BACKLOG — not built.** dx7 declares `order`/`pages`/`glyph`/`rear` and no `hero`,
> no `sidebar`, no readout strip; none of the re-cut below is in the def. `face.title` does
> NOT paint by default (`dock-faceplate-model.ts:90`), owner ruling 2026-08-03.
>
> ⚠ **Owner ruling 2026-08-11** (verbatim at `packages/web/src/lib/audio/modules/rings.ts:585-590`,
> `:645-650`): *"we should prefer almost zero AI authored text, and all future faceplate work
> should reflect that"* and *"lets stop doing these and clean up the existing ones, get rid of
> them. lose the signal flow diagrams."* The page `hint`s and the whole `signal-flow` sidebar
> this spec originally proposed are struck; the numbers they carried are kept in §1 and §6.

**Verdict: REAL REWORK — STRUCTURAL ONLY.** The control roster, the rank order, the
`paramCells` grid, the `algorithm` glyph choice and the rear curation are all correct and
this spec changes NONE of them; what changes is that the operator map becomes the hero
PICTURE (which also deletes a duplicate diagram the dock paints today), the voice page
merges away so map and detail stay adjacent, and three genuinely derived readouts land in the
full-width strip.

---

## 1. WHAT THE MODULE ACTUALLY DOES

Six sine operators. Phase-modulation, not filtering. The signal path in the worklet's real
order, per `packages/dsp/src/dx7.ts`:

1. **Note source.** `poly` (32-ch polyPitchGate, first `voiceCount` ≤ 5 lanes) or, only when
   `poly` is unpatched, the mono `pitch_cv` + `gate` pair (`modules/dx7.ts:126-135`). Sampled
   once per render block.
2. **Per voice: six operators, wired by `algorithm`.** `DX7_ALGORITHMS`
   (`audio/dx7-algorithms.ts:65-96`) gives each of the 32 charts a `carriers` list, a
   `modSrcs` fan-in per operator, and a `feedback: {from,to}` pair. The pair form is shipped —
   algorithms 4 and 6 are multi-operator loops (`from:3→to:5`, `from:4→to:5`), every other
   chart is a self-loop, and the loop sits on op6 in only 17 of 32.
3. **Carriers summed → the per-voice MASTER VCA.** `sum += voiceOut * ampEnvVal`
   (`dsp/src/dx7.ts:831`), where `ampEnv` is the shared `Envelope`
   (`dsp/src/lib/adsr-env.ts:34-98`) driven by the four ADSR params.
4. **Voice sum → `level` → a FIXED 0.4 trim → `out`.** `out[i] = sum * level * 0.4`
   (`dsp/src/dx7.ts:849`). LEVEL 1.0 is therefore −8 dB end to end, which the docs already
   state (`modules/dx7.ts:298`) and nothing on the faceplate shows.

**What each control genuinely changes about the sound.**

- `algorithm` — re-binds the routing at the top of the next render block; a held note morphs
  rather than retriggers. It changes *both* which operators you hear AND where the one
  feedback loop sits, and for pairs like 1/2 and 26/27 the loop placement is the ONLY
  difference (`dx7-algorithms.ts:65-66`, `:90-91` — identical `carriers`/`modSrcs`, feedback
  on op6 vs op2 and op6 vs op3).
- `feedback` — depth of that loop, 0..7. 0 disables it. On a modulator it walks a clean bell
  to a metallic crash; on a carrier it is the DX7 brass edge. The one continuous timbral
  control an FM player rides, and the reason it is a ParamDef at all while the other 78
  operator values live in `node.data.voice`.
- `attack/decay/sustain/release` — a master output VCA **layered on top of** the patch's own
  operator EGs, per voice. `attack`/`decay` are near pass-through at their defaults
  (0.001 s, and `sustain` 1 leaves `decay` nothing to slide toward). `release` is NOT
  pass-through: it is a CEILING on every tail the patch has.
- `level` / `transpose` / `voiceCount` — performance, not timbre.

**LOAD-BEARING vs incidental.** Load-bearing: the preset selector (it supplies 78 of the 80
values), `algorithm`, `feedback`, `release`. Incidental at their defaults: `decay` (inert
until `sustain` < 1 — stated at `modules/dx7.ts:301`) and `attack` (0.001 s = instantly
open). **Inert at spawn:** every control is inert until a note source is patched — this
module makes no sound on its own, and unlike kickdrum it has no audition button.

**Measured facts worth printing.**

- The master VCA's release is `value *= exp(-1/(sr·release))` terminating at `value < 1e-5`
  (`adsr-env.ts:88-94`), entered from the sustain level (`:85-86`). So the VCA's full close
  after gate-off is **`release · ln(sustain / 1e-5)`** — at the defaults `0.005 · 11.513` =
  **57.6 ms**, which is the "~60 ms" the def's own comment already claims
  (`modules/dx7.ts:155-157`). The knob says `0.005 s`. The two differ by 11.5×.
- The fixed 0.4 output trim (`dsp/src/dx7.ts:849`), invisible on every surface.
- Carrier count per algorithm ranges 1 (alg 16-18) to 6 (alg 32) — the single fact that most
  predicts whether a chart sounds like a stack or an organ.

---

## 2. WHAT THE CURRENT SHIPPED FACE GETS WRONG

The face (`modules/dx7.ts:193-263`) is **largely right**: the rank order is argued control by
control, `paramCells: { algorithm: 'grid' }` (`:249`) is the correct answer for a 32-topology
picture-state param, `glyph: 'algorithm'` (`:242`) already rejects the flatlining scope trace,
and the rear curation (`:259-262`) plus its page-id warning (`:215-224`) are correct and must
be preserved verbatim. The genuine gaps:

1. **No `hero`, no `sidebar`** — the face predates PF-20, so the faceplate opens as a wall of
   bands.
2. **The dock paints the algorithm topology TWICE.** With `glyph: 'algorithm'` the dock hero
   rail renders a 64 px `Dx7AlgorithmGlyph`, and the `operators` band renders the 280 px
   `Dx7OperatorMap` — which is built by rescaling *the same* `dx7GlyphGeometry` placement
   (`ui/modules/dx7/dx7-op-map-model.ts:101-103`). The small one carries strictly less: no
   role colour, no carrier rail, no frequency, no EG thumbnail, no mutes. Design defect, not a
   bug → §9.1.
3. **`patch` is a two-control band** whose two members are the same job ("get a voice in"),
   and it sits between the hero rail and the operator editor, pushing the 560 px detail panel
   one band further from the map the shipped comment (`:228-231`) went to arithmetic lengths
   to keep adjacent to it.

Not wrong, and explicitly kept: `order` (`:194-213`), `paramCells`, `glyph`, `rear`,
`controlFamilies` (`:313-324`), every `docs.controls` blurb.

---

## 3. THE ~8 CONTROLS THAT MATTER

`order` is **unchanged from shipped**. It is re-defended here, not re-cut, and there is a
hard external reason it must not move: `push-card-schema.test.ts:417-423` asserts
`voiceCount` is inside the FACE-DERIVED top-8 window (it is rank 7), so a re-ranking that
pushes it past rank 8 turns that test red for no design gain.

| # | key | why it earns this rank (an argument that is WRONG elsewhere) | what it costs below |
|---|---|---|---|
| 1 | `dx7-preset-select-{n}` | On a patch-driven instrument the selector is not "a preset menu" — it writes 78 of the 80 values that make the sound. On a subtractive synth rank 1 would be a filter cutoff; here nothing else can be rank 1. | pushes the whole timbral set down one |
| 2 | `feedback` | The ONE continuous timbral control here. Wrong for a VA (feedback would be a colour trim); right for FM, where it is the axis from bell to crash. | keeps `algorithm` off the 2-cell compact tier |
| 3 | `algorithm` | Biggest single shaper, but DISCRETE — at compact it would spend the second cell on a selector next to a selector, and the glyph already draws the topology. Rank 3 is the highest rank that respects that. | — |
| 4 | `level` | The only output control; a rack needs it reachable at plate tier. | — |
| 5 | `transpose` | Continuous, re-applied under a held gate — a live control, not a setup one. | — |
| 6 | `release` | **The lane budget ends here, and it is a deliberate spend.** Its 0.005 s default closes the master VCA in 57.6 ms, cutting the long tails stored in bell and pad voices. It is the "why don't my bells ring" trap; leaving it dock-only means the trap has no lane-tier fix. | evicts `voiceCount` from the plate |
| 7 | `voiceCount` | Set once per patch, not ridden. Rank 7 because it is still the first thing you reach in the dock. | — |
| 8-10 | `attack`, `decay`, `sustain` | Near pass-through at defaults; `decay` is fully inert until `sustain` < 1. | — |
| 11-12 | `dx7-operator-map-{n}`, `dx7-op-detail-{n}` | Panels; rank 7+ was their first LEGAL rank under `panelTierProblems`, and patch DESIGN belongs in the dock anyway. | — |
| 13 | `dx7-syx-input-{n}` | Once per session, if ever. | — |

**THE LOSERS, NAMED.** `voiceCount` lost the plate to `release` — a wrong voice count is
audible and self-explaining, a truncated tail is audible and blames the patch. `attack` and
`decay` lost because at their defaults they do nothing at all, and a lane cell that does
nothing on a fresh spawn is worse than absent. `sustain` lost because it is the *enabler* of
`decay`, not a control anyone reaches for first. `dx7-syx-input-{n}` lost to everything: it
is a once-per-session import.

---

## 4. BAND STRUCTURE

**Pages go 4 → 3.** The `patch` band is merged away, not deleted: its two keys are homed in
`operators` and immediately promoted out of it by the hero. This is the ONLY structure that
satisfies all four constraints at once — the map must sit directly above the detail; a hero
key must be ranked (and, to avoid the empty-band trap of §9.3, must leave its band non-empty);
`order` must not move; and no page id may collide with the curated rear group `voice`
(`modules/dx7.ts:215-224` — that warning is preserved verbatim).

```ts
pages: [
  // ⚠ THE PAGE ID IS NOT 'voice' AND THAT IS STILL LOAD-BEARING — the curated rear
  // group already owns { id: 'voice' } (see face.rear), and a page id colliding with
  // the leading group's id renders that band TWICE and reddens the rear-derivation
  // totality gate. Do not "tidy" 'operators' into 'voice'.
  //
  // ⚠ THE TWO VOICE KEYS ARE LISTED HERE AND NEVER RENDER HERE. `face.hero` promotes
  // both out (heroFacePlan REMOVES, it does not copy), so this band paints
  // [ALG chip ~90][FEEDBACK ~56] on row 1 and [OP DETAIL 560] on row 2. They are
  // listed because a hero key must have a home: a ranked-but-unpaged key falls into
  // the defensive '__unpaged' band, which is a different (and wrong) faceplate. If
  // the hero declaration is ever dropped they degrade gracefully back into this band.
  { id: 'operators',   label: 'algorithm · operators',
    controls: ['dx7-preset-select-{n}', 'dx7-syx-input-{n}', 'algorithm', 'feedback',
               'dx7-operator-map-{n}', 'dx7-op-detail-{n}'] },
  { id: 'performance', label: 'performance', controls: ['voiceCount', 'transpose', 'level'] },
  { id: 'ampenv',      label: 'master adsr', controls: ['attack', 'decay', 'sustain', 'release'] },
],
```

The one load-bearing fact that used to live in a hint — **RELEASE is a ceiling on every tail** —
is NOT prose: it is a printed number in the readout strip (`vca close`, §5). Band labels stay
names.

---

## 5. THE HERO + THE READOUT STRIP

```ts
hero: {
  cell:    'dx7-operator-map-{n}',   // rank 11, kind:'panel' (shell-cells.ts:247-251)
  control: 'dx7-preset-select-{n}',  // rank 1
  action:  'dx7-syx-input-{n}',      // rank 13
  readouts: [
    { label: 'alg carriers', valueId: 'dx7-carriers' },
    { label: 'feedback',     valueId: 'dx7-feedback-op' },
    { label: 'vca close',    valueId: 'dx7-vca-close' },
  ],
},
```

**Does this module need a bespoke `hero.cell`? YES, and it is the strongest case in the
fan-out.** The platform's own doc names "a routing map" as the archetype, and the map already
exists as a registered panel. The decisive argument is not aesthetic: **`hero.cell` SUPPRESSES
the dock glyph** (`ModuleShell.svelte:353`), which is exactly how the duplicate diagram of §2.2
gets deleted. The generic glyph it would otherwise use is `'algorithm'` — a strictly smaller
version of the same picture — and the glyph is untouched at every other tier, so the compact
tile keeps it.

**The map belongs in the HERO, not in its band** — but only because the band merge of §4
keeps it directly above the detail panel. Map in the hero with the voice band still in
between would have been worse than shipped: you click a tile and the panel that responds is
two bands down.

**`hero.control` = the preset selector.** On a patch-driven instrument the selector is the
biggest control by construction. ⚠ **Honest limitation:** `controlCell(key, 'xl')` only
applies the size to the KNOB branch (`ModuleShell.svelte:516`, `size={…knobSize}`); the
family/selector branch ignores it. So the promotion buys the selector the hero POSITION, not
hero typography. That is acceptable and should not be "fixed" by turning the roster into a
param.

**`hero.action` = the .syx loader.** dx7 has no audition — it is note-driven, has no
momentary param and no strike family, and adding one would cost a `controlFamily`
contract-lock line plus a `docs.controls` blurb. A TEST NOTE button is a defensible future
PR; it is not this one. The loader is the honest second half of "get a voice in" and it is a
`file` cell, already in faces-parity's allowed `data-cell-control` union.

### The READOUT STRIP — three entries, all derived

⚠ **First, the platform limit that shapes every choice below.**
`FaceReadoutValue = (read: (paramId: string) => number | undefined) => string`
(`face-readout-values.ts:45`). A derived readout can read **PARAMS ONLY**. It cannot see
`node.data.voice`, `node.data.opOn`, `node.data.preset` or `node.data.voiceRev`. That
kills three otherwise-obvious candidates outright, recorded because they are the ones a reader
will ask about:

- **the resolved frequency of the SELECTED operator** — needs `node.data.voice` *and* the
  selection, which is deliberately local component `$state` and not in `node.data` at all
  (so a rack-mate's click cannot yank your panel). Doubly unreachable. It already prints in
  the detail panel (`Dx7OpDetail.svelte:148`), which is where it belongs.
- **the voice name + dirty marker** — `node.data.preset`; unreachable. Covered by the hero
  control and by `dx7-dirty-chip` in the detail header.
- **anything about operator levels or EGs** — `node.data.voice`; unreachable.

**1 · `alg carriers` → `dx7-carriers`.** `getAlgorithm(algorithm).carriers.length` of 6, via
`dx7OpRoles` (`audio/dx7-op-role.ts:110-115`). Prints `3 of 6`. Mirrors the DSP directly: the
`carriers` array at `dx7-algorithms.ts:65-96` is the same array the worklet sums.

**2 · `feedback` → `dx7-feedback-op`.** `getAlgorithm(algorithm).feedback` `{from,to}`, 1-indexed.
Self-loop → `op 6`; cross-operator → `op 4 → op 6` (algs 4 and 6 only). Mirrors
`dx7-algorithms.ts:60-61` and the injection the worklet keys on.

**The negative control for 1 and 2 is EACH OTHER, and it is a genuine two-legged control.**
Neither is a multi-input derivation — both are pure functions of `algorithm` — so the
honest test is not "does it move with a knob" but "**is it a proxy for the knob**", and it
is not, in both directions:

- **LEG A** `algorithm` 1 → 2: `alg carriers` must stay `2 of 6` while `feedback` moves
  `op 6` → `op 2`. (Verified against the shipped table: `dx7-algorithms.ts:65-66` — identical
  `carriers` and `modSrcs`, feedback `{5,5}` vs `{1,1}`.)
- **LEG B** `algorithm` 5 → 32: `feedback` must stay `op 6` while `alg carriers` moves
  `3 of 6` → `6 of 6` (`dx7-algorithms.ts:69`, `:96`).

A readout that were secretly `paramId: 'algorithm'` would move on BOTH legs, and either leg
alone would miss it. `paramId` is not an option here anyway: it prints the raw value through
the knob's own ladder (`dock-faceplate-model.ts` `readoutText`), so it would print `5`, and
adding a `ParamDef.format` to reshape it would change the picker chip too.

⚠ **Stated blindness, and why the label says `alg carriers`.** This readout is invariant to
`node.data.opOn` — mute a carrier and it is no longer summed, but the strip still counts it.
That is unfixable at the registry (params only), so the label names the ALGORITHM's carrier
count rather than the audible one, and the mute is carried by the hero picture 100 px above
it, which dims the tile while still drawing its rail drop (`dx7-op-map-model.ts:66`, `:129`).
If `FaceReadoutValue` is ever widened to take a node reader, re-derive this over `opOn` and
re-label it `carriers` — recorded as the follow-up.

**3 · `vca close` → `dx7-vca-close`.** The honest tail-ceiling, and the one true multi-input
derivation on this module.

- **FORMULA** `release · ln(sustain / 1e-5)`, formatted by `dx7FormatSeconds`
  (`audio/dx7-format.ts:140-149`). Traced to `dsp/src/lib/adsr-env.ts:87-94`: the release
  state is `value *= exp(-1/(sr·release))` per sample, terminating at `value < 1e-5`, and
  `:85-86` is what puts `value` at the sustain level for a note held past attack and decay.
  Defaults → `0.005 · 11.513` = **57.6 ms**, matching the def's own claim at
  `modules/dx7.ts:155-157`. `sustain ≤ 1e-5` prints `closed` (the VCA is already shut).
- **NEGATIVE CONTROL (the blind input)** — hold `release` at 0.005 and move `sustain`
  1 → 0.01: the printed value must move **57.6 ms → 34.5 ms**. A `paramId: 'release'`
  readback prints `0.005 s` for both and is blind to the input that genuinely changes the
  answer. This is the kickdrum-tail trap in its dx7 form.
- **SECOND LEG (must NOT move)** — move `attack` 0.001 → 2 and `decay` 0.1 → 3: the printed
  value must not change. The release law reads neither, and this catches the plausible
  mis-derivation of summing all four ADSR params.
- ⚠ **Why not the −60 dB convention kickdrum uses.** Measuring −60 dB *below the sustain
  level* gives `release · ln(1000)` — **invariant to `sustain`**, which would silently
  reinstate the very blindness the readout exists to remove. The DSP's own termination
  threshold is absolute, so the absolute form is both the traceable one and the one with a
  live negative control.
- **Where the control lives permanently:** a new
  `packages/web/src/lib/ui/modules/dx7/dx7-face-model.test.ts`, alongside the pure functions.

**Why exactly three.** `algorithm` as a `paramId` readout is the named noise case — the ALG
chip is in the band immediately below it. `voiceCount`, `transpose` and `level` are plain knob
readbacks two bands down and would pad the strip to five without adding a fact. The
`level × 0.4` end-to-end gain is a real hidden number, but it is a monotone transform of one
param with no second input and no distinguishing perturbation — so it is not a derived readout.

---

## 6. THE SIDEBAR — NONE

The `signal-flow` block this spec originally proposed (the fixed OUTER chain: POLY/PITCH·GATE →
OPERATORS ×6 → CARRIER SUM → MASTER ADSR → VOICE SUM → LEVEL → ×0.4 HEADROOM → OUT) is **struck
by the 2026-08-11 owner ruling.** The two facts it carried survive as numbers in §1: the fixed
0.4 trim (`dsp/src/dx7.ts:849`) and the per-voice master VCA layered on the patch's own EGs.

**`presets` is REJECTED, and the argument is the strongest reason to say no in this batch.**
`FacePreset.values` is `Record<paramId, number>` (`graph/types.ts:759-765`). A DX7 voice is 80
values, of which exactly **two** are params. So a `presets` block for E.PIANO 1 could write
`{ algorithm: 5, feedback: 4 }` and nothing else — it would rewire the current operators into
E.PIANO 1's chart and produce a sound that is neither patch. That is not a partial recall, it
is a wrong one. And the module already ships the correct implementation: `selectDx7Preset`
stamps `data.preset` + `data.voice` + `data.opOn` + `data.voiceRev` + both params in ONE
`mutateNode` transaction (`ui/modules/dx7-patch-actions.ts:231-240`), reachable from the hero
control. A sidebar `presets` block would duplicate a working control with a broken version.

**`readouts` is rejected** — params only, and the three worth printing are already in the
strip. **`custom` is rejected** — the only picture worth drawing is the operator map, and it
is the hero.

**MEASURED, kept from the struck sidebar's layout arithmetic.** `.faceplate-body` floors at
900 px (`_dock-faceplate.css:123-124`); `.editor` adds 22 px padding each side (`:315-316`);
`.section` adds **zero** horizontal padding (`:339-341`). `dx7-op-detail` declares
`minWidth: 560` (`shell-cells.ts:266`). With the 288 px sidebar (`--dock-sidebar-w`, `:45`,
`:313`) the band content width at the floor was **900 − 288 − 44 = 568 px — a margin of 8 px**,
the whole reason that sidebar needed a `vrt:one` confirmation before merge. **With no sidebar
the width is 856 px and the constraint is gone.** That is the one concrete thing the ruling
bought this face.

---

## 7. RANGE / CURVE / VOCABULARY CHANGES

**None required.** No `ParamDef` range, `curve`, `options`, `landmarks`, `format` or `units`
changes. Two optional items and three hazards found by grepping for re-typed ranges:

- OPTIONAL (needs PF-3): `feedback` gains `format: (v) => v === 0 ? 'off' : String(v)`. 0
  genuinely disables the loop (`modules/dx7.ts:296`) and the knob currently prints a bare
  number for a state that means "off". Costs a knob readout change ⇒ a dock VRT move.
- OPTIONAL (needs PF-3): `algorithm` gains `format: (v) => 'ALG ' + …` — see §9.2.
  ⚠ It would also flow to the picker chip, which already reads `ALGORITHM nn`; check for a
  doubled prefix before adopting.
- **HAZARD** `Dx7OpDetail.svelte:132,137,142,185` re-types `min="0" max="31"` (coarse),
  `min="0" max="99"` (fine, level) and `min="-7" max="7"` (detune) as HTML literals. These
  are SYX byte ranges, not ParamDefs, so there is no def to disagree with — but the same
  bounds already exist as code (`dx7-format.ts:36-39` `clampByte(v, 31)`, and
  `dx7DetuneSigned`/`dx7DetuneFromSigned` at `:102-117` own the ±7 mapping). They AGREE
  today. Export them and import them.
- **HAZARD** `modules/dx7.ts:421-422` re-types `1/32` and `0/7` in `clampAlgo`/`clampFeedback`
  rather than reading its own `params` array 270 lines above. Same file, so it cannot drift
  across files — but it is the same class.
- **CLEAN** No `data-testid="control-<paramId>"` is emitted by `Dx7OperatorMap.svelte`,
  `Dx7OpDetail.svelte` or `Dx7EgEditor.svelte` — every testid is a `dx7-*` prefix. Hard rule
  3 holds; faces-parity's multiset is unaffected.

---

## 8. COST

- **contract-lock: ZERO.** No new `ParamDef`, `PortDef`, `ControlFamily` or `edge`. `face` is
  UI metadata and has no branch in `contract-signature.ts`. Cell count is unchanged at
  **13** (9 params + 4 families), so faces-parity's `defIds.length + families` assert holds
  untouched.
- **Code added:** 3 pure functions + 3 registry entries in `face-readout-values.ts`, plus
  their negative-control test file. No new component, no new sidebar panel, no new shell cell.
- **VRT — MOVES:** `face-dx7-dock` (hero rail appears, 64 px glyph disappears, bands 4 → 3).
  Baselines are authored by the linux capture job; never commit one.
- **VRT — MUST NOT MOVE, treat a diff as a finding, not a re-pin:**
  - `vrt.spec.ts/dx7.png` — the **REQUIRED `vrt-strict` lane** scene
    (`vrt-exemptions.ts:882` puts dx7 in `STRICT_VRT_MODULES`). It renders the LEGACY
    `Dx7Card.svelte`, which this spec does not touch. A diff here means something leaked out
    of `face`.
  - `face-dx7-compact` — `hero`/`sidebar` are dock-only, the glyph is suppressed only at dock
    (`ModuleShell.svelte:353`), and `order` is unchanged.
  - `rear-dx7` — `face.rear` is unchanged and no page id ever claimed a curated group;
    deleting the `patch` page cannot reach the rear.
- **e2e:** exactly one line moves — `e2e/vrt/workflow-shell-faces.spec.ts:52`
  `{ type: 'dx7', pages: 4 }` → `pages: 3`. That row is a hard structural gate
  (`toHaveCount(pages)` fires before the pixel pin), so it fails loudly if the merge is
  botched. No new bespoke spec: both readout controls are unit tests.
- **CI wall-time: ≈ 0.** faces-parity budgets `FACE_FIXED_MS + cells × FACE_PER_CELL_MS`
  = 45 000 + 13 × 1 800 ≈ 68.4 s on CI, and the cell count does not change. The 3 new unit
  tests are pure arithmetic (< 50 ms). The 13 existing dx7 e2e tests are untouched.
- **ART: NIL — confirmed, not assumed.** No `.sha` pin names any dx7 file; the six
  `art/scenarios/dx7/*.test.ts` are threshold assertions and there is no `art/baselines/dx7/`.
- **WebGL attest: NIL — confirmed.** `resolveWebglBasis()`'s `AUDIO_WEBGL_MODULE_DEFS` is
  cube/wavesculpt only; no dx7 card creates a WebGL context.
- **Push 2: NIL.** dx7 has an explicit override (`push-card-config.ts:66`), so the card cannot
  drift — provided `face.order` does not move, which this spec guarantees (§3).
- **Docs:** dx7 is in `STRICT_DOCS`. No new param or family ⇒ no new `docs.controls` key ⇒
  `task docs:accept` should produce an EMPTY diff. A non-empty one is a finding.

---

## 9. DEFECT LEDGER

**9.1 — STILL OPEN. The dock renders the algorithm topology twice.** `modules/dx7.ts:243` is
still `glyph: 'algorithm'` and **no `hero.cell` exists to suppress it**, so the dock hero rail
paints a 64 px `Dx7AlgorithmGlyph` while the `operators` band paints the 280 px
`Dx7OperatorMap` from the same geometry (`dx7-op-map-model.ts:101-103`). Costs a player ~64 px
of the most valuable strip on the faceplate for a strictly-lesser copy of the picture directly
below it. No gate can see it — VRT pins whatever is there and faces-parity counts cells, not
pictures. **This spec closes it** as a side effect of `hero.cell`; recorded because the same
shape will recur on the next module that pairs a glyph with a panel of the same subject.

**9.2 — STILL OPEN. The topology caption prints a bare, unlabelled number.**
`modules/dx7.ts:142` is `{ id:'algorithm', … curve:'discrete' }` and declares **neither
`format` nor `options`**, so `topologyLabel` (`ModuleShell.svelte:327-336`) falls through to
`String(Math.round(v))` — the caption beside the diagram reads `5` while the picker chip in the
same faceplate reads `ALGORITHM nn`. Two surfaces naming one param two ways. After this spec
the dock glyph is suppressed, so the defect survives only at the compact and plate tiers —
where it is arguably worse, since there is no chip beside it to disambiguate. Costs
comprehension, not correctness. Catchable by a unit assertion on `topologyLabel`; nothing tests
it today.

**9.3 — `heroFacePlan` dropped emptied CLUSTERS but not emptied BANDS. ✅ FIXED.**
`withoutKeys` filtered `clusters` on `cl.controls.length > 0` under the comment "a sub-header
over zero cells is a caption for nothing", but the dock band loop had no such guard, so a face
promoting every control of a band rendered a labelled `<section>` with an empty grid.
`dock-faceplate-model.ts:319-321` now filters `bands` on
`controls.length > 0 || clusters.length > 0`, with a comment naming **dx7 and mixer** as the
two faces that found it. §4 still merges the voice page rather than emptying it, for the
adjacency reason, not the empty-band one.

No DSP defects found. The algorithm table, the `{from,to}` feedback pair, the envelope law
and the message protocol all read as internally consistent with `dx7-render.ts`.

---

## 10. VERIFICATION GATE

```sh
# 1. the pure model + the PERMANENT negative controls for all three readouts
REPEAT=3 flox activate -- task test:one -- dx7-face-model
# 2. face lint: hero keys ranked, hero.cell resolves to a panel, every valueId registered,
#    no page id colliding with the rear group
flox activate -- task test:one -- module-face-lint
# 3. the hero split is TOTAL for every faced module (the unit twin of faces-parity)
flox activate -- task test:one -- dock-faceplate-model
# 4. the shell-cell registry still resolves all four dx7 family/panel keys
flox activate -- task test:one -- shell-cells
# 5. the push card did not drift (voiceCount must stay in the face-derived window)
flox activate -- task test:one -- push-card-schema
# 6. contract + docs must both produce an EMPTY diff — a non-empty one is a finding
flox activate -- task docs:check
# 7. e2e — the dock faceplate still renders 13 cells, both panels operable, ALG grid portaled
flox activate -- task e2e:serve
flox activate -- task e2e:one -- "faces-parity"
flox activate -- task e2e:one -- tests/dx7-operator-panel.spec.ts
flox activate -- task e2e:one -- tests/dx7-algorithm-picker.spec.ts
# 8. VRT — the one that moves, then the three that must NOT
flox activate -- task vrt:one -- face-dx7-dock
flox activate -- task vrt:one -- face-dx7-compact   # expect NO diff
flox activate -- task vrt:one -- rear-dx7           # expect NO diff
flox activate -- task vrt:one -- dx7                # legacy card, REQUIRED lane: NO diff
flox activate -- task e2e:stop
```

**The negative controls in step 1, spelled out so a builder cannot ship a green stub:**
`algorithm` 1→2 must leave `alg carriers` at `2 of 6` and move `feedback` `op 6`→`op 2`;
`algorithm` 5→32 must leave `feedback` at `op 6` and move `alg carriers` `3 of 6`→`6 of 6`;
`sustain` 1→0.01 at `release` 0.005 must move `vca close` `57.6 ms`→`34.5 ms`; and
`attack` 0.001→2 with `decay` 0.1→3 must leave `vca close` unchanged.
