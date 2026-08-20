# Faceplate build specs — the ROLLING index, continued (opened 2026-08-20)

This file continues `.myrobots/plans/face-specs-rolling-2026-08-19.md`. That file
holds §B9 (batch 9) and §B10 (batch 10); this one opens with **§B11**.

**Why a new file rather than an append.** §B10's own lesson: specs that live only
in one agent's checkout are lost when that checkout is. Several specs §B10 cites
by name — `2026-08-19-spec-ruttetra-grainsofvision.md`,
`2026-08-19-spec-moog904bc.md`, `2026-08-19-spec-moog961-moog984.md` — are **not
in the primary checkout** and could not be read while writing this. They exist
somewhere; that is the problem. This section is committed to a branch
(`docs/specs-b11`) the moment it is written, before any PR exists.

---

# BATCH 11 — the spec lane's four, appended 2026-08-20 (2 AUDIO + 2 VIDEO)

**Measured against `origin/main` @ `77b32a6e8`.** ⚠ **This checkout is at
`origin/main` exactly — `git rev-list --count HEAD..origin/main` = 0.** That is
worth stating because §B10 was written 34 commits behind and its ATTACK 5 is
about precisely the confusion that causes. Nothing here needed a
`git show origin/main:<path>` re-take, and no def in this batch was diffed
against a newer copy because there is no newer copy.

Where a figure came from a **resolver** (`paramCellKind`, `looksLikeToggle`,
`glyphBinding`, `primaryAudioOutPortId`, `isInBasis`, `resolveWebglBasis`) that
resolver was **RUN on the live def** through a scratch vitest inside
`packages/web` (deleted before commit), not reasoned from its source. Where a
figure came from a def or a card it is quoted with `file:line`. Anything derived
by reading says so.

**Why this cohort is 2 + 2 and not 3 + 1.** The owner cadence prefers 2-3 audio.
The audio pool does not currently support three: after exclusions, **every
remaining unfaced audio module in `generic-face` has ≤ 4 params**, and the top of
that list is `moog992` at 4. This is not a judgement about appetite — it is the
measured shape of what is left, and B11.0 shows the working. Two audio picks are
taken on merit that is not param count; the third slot would have been padding.

---

## ⚠ B11.-1 A CORRECTION TO §B10 THAT CHANGES HOW SPECS ARE WRITTEN — read before building anything from that bank

**§B10's Q46, Q47 and Q48 each instruct a builder to declare a `FaceReadoutValue`.
That mechanism does not exist, and it did not exist in the tree §B10 measured.**

```
$ git show --stat 740bac121 | grep readout
 .../web/src/lib/ui/workflow/face-readout-values.ts | 1809 --------------------
```

`740bac121` (*"the resting faceplate printed derived-state text in THREE shapes —
delete the shape, not the mechanism (#1970, #1957)"*) landed **2026-08-19
20:15**. §B10 states it measured `origin/main` @ `8e856e0f1`, dated **2026-08-20
04:28**, and:

```
$ git merge-base --is-ancestor 740bac121 8e856e0f1 && echo ALREADY-IN-BASE
ALREADY-IN-BASE
```

So the deletion preceded §B10's own base by ~8 hours. B10.2 nonetheless quotes
the deleted file's header as authority (*"`face-readout-values.ts` header: 'a pure
function of the live params'"*) — a read taken from its 34-commits-stale working
tree, where the file still existed. **§B10's ATTACK 5 identified exactly this
class and the re-take was applied to `face-migration.generated.md` and
`contract-lock.txt` but not to the platform file the spec was recommending.**

`packages/web/src/lib/graph/types.ts:960` is unambiguous about the consequence:

> ⚠ THERE IS NO `readouts` FIELD, AND THERE IS NO `sidebar` ON `ModuleFace`. Both
> are DELETED, not deprecated, and **re-adding either — under any name — is the
> mistake this note exists to prevent.**

**Filed as #2020.** It is the same class as #1964 (the index recommending
`face.paramCells: 'toggle'`, which does not typecheck) — two instances in two
batches, which is why #2020 also asks for a line in the index preamble: **the
spec bank is not pinned to the platform, so a spec written against tree T
recommends tree T's mechanisms forever.**

**What this section does instead.** No entry below proposes a painted readout in
any shape. Where a derived quantity is genuinely worth having, it goes to
**`aria-valuetext` on the control it describes** — unpainted, speakable, and
already what every face spec that tracks the graph reads — or into the module's
`<mod>-face-model.test.ts` unit lane. The permitted resting text on a faceplate
is exhaustively the module NAME, tab/section LABELS, control CAPTIONS, and
option/landmark NAMES; the gate that holds it is
`face-resting-text-source.test.ts`, and it denies the **shape**, not any
particular mechanism, so a fifth mechanism cannot walk around it.

⚠ §B10's B10.1 advice *"declare no `face.sidebar`"* is stale in the same commit
but harmless — it advises against a field that no longer exists, so following it
produces the right output for the wrong reason. Not filed.

---

## B11.0 CANDIDATE SELECTION — from the artifact, and what was passed over

`docs/design/face-migration.generated.md` on `origin/main` reads **198 registered
/ 72 done**. Its `generic-face` table is the pool; `blocked` (3),
`bespoke-surface` (51) and `organizational-native` (3) are not candidates. The
not-done `generic-face` remainder is **29 audio + 40 video**.

**PICKED — `colourofmagic`, `acidwarp` (video); `cvBuddy`+`cvBuddyMini`,
`gatemaiden` (audio).** Four different KINDS of merit, deliberately, per Q28's
pairing test (B11.6 ATTACK 8): the pool's largest module and the first adopter of
a shipped-but-unused cell kind; a module blocked by its own VRT exemption in a way
its own `freeze` param does not fix; a PAIR whose entire visible surface is text a
faceplate is no longer allowed to paint; and the cheapest possible regression test
for the two silent build bugs batch 13 caught.

### ⚠ THE BLOCKER THAT REMOVED FOUR OF THE STRONGEST VIDEO CANDIDATES

Before triage, the four highest-param unfaced video modules after
`colourofmagic` were `monoglitch` (8), `milkdrop` (8), `reshaper` (6) and
`graphicEq` (5, with a 401-line card). **All four are blocked**, and not by
anything visible in the def:

**#1865** enumerates the cards mounting the `hideControls` → resizable-monitor
affordance and joins them against the pinned inventory. Eight `generic-face` pool
modules carry it; `graphicEq`, `milkdrop`, `monoglitch` and `reshaper` are four of
them. **#2009** then establishes that the affordance has **no faced home**:
`fullViewBody` paints *above* the bands and cannot suppress them, and
`editorSurface` — the slot whose description fits — is **UNWIRED**
(`WIRED_SHELL_EXTENSION_SLOTS = ['glyph', 'fullViewBody']`).

Since functional parity is a hard requirement, a face over any of those four
silently deletes a documented capability. `ruttetra` is not promoted for exactly
this reason despite having an owner ruling on its tab question.

⚠ **This is the single most valuable thing in this section for the next triage:
param count ranks these four at the top of the video pool and they are all
unbuildable.** The blocker is invisible to every def-reading gate and to
`face:inventory`. Check a video candidate against #1865's list *first*.

### PASSED OVER, with the reason, because a triage nobody records gets re-run

| module(s) | why not, this round |
|---|---|
| `graphicEq` · `milkdrop` · `monoglitch` · `reshaper` | **#1865 / #2009** — the `hideControls` monitor mode has no faced home (`editorSurface` unwired). The four strongest video candidates by param count, all blocked. `monoglitch` is named in #2009's title alongside `ruttetra`; `video-hide-controls.spec.ts` is parameterised over the pair. |
| `ruttetra` | #2009 (owner ruling settled the TAB question; STOP 2 is still not clean). |
| `grainsOfVision` · `mirrorpool` | #1936 — the face-scene roster requires baselines their owner-look hold forbids. `grainsOfVision` additionally #2014, #1929. |
| `quadralogical` (Q27) · `joystick` (Q43, #1974) · `scope` · `timelorde` (#1932) · `synesthesia` (Q48, #2004) | owner-gated / blocked, unchanged. |
| `doom` | never, and it is `bespoke-surface` regardless. |
| `rasterize` · `wavecel` · `foxy` (Q46/Q47/Q49) | §B10's bank — being built. ⚠ All three carry the #2020 readout defect; see B11.-1. |
| `moog905` (Q21) · `samsloop` · `wavesculpt` | spec'd, unbuilt — bank, not triage. `wavesculpt` is also on #1865's list. |
| `bentbox` · `mandelbulb` · `4plexvid` · `warrensvisions` · `spirographs` | in flight or done. ⚠ `spirographs` is `done` in the artifact and carries **#2015** (SCREEN OFF stops the render loop) — a fleet-standard defect, not a triage entry. |
| `moog903a` · `moog904b` · `moog904c` · `moog960` · `moog961` · `moog962` · `moog992` · `moog994` · `moog995` | Answered by the queue's audio cohorts per §B10.0. ⚠ **Unverifiable from the primary checkout** — the specs §B10 names (`2026-08-19-spec-moog904bc.md`, `-moog961-moog984.md`) are not in it. Recorded as a gap, not re-triaged. `moog960` is separately disqualified by **#1915** (playhead class). Measured for the record: 903a 1 param · 904b 2 · 904c 3 · 960 1 · 961 2 · 962 1 · **992 4** · 994 **0** · 995 3. |
| `flipper` | **0 params.** Unchanged from B9.0/B10.0. |
| `polarizer` · `depolarizer` · `scaler` | **1 param each**, all three in `STRICT_VRT_MODULES` — a *required* baseline to save one knob. Worst ratio in the pool, unchanged. |
| `sampleHold` | **1 param.** §B10.0's reading confirmed: `scale` is `discrete 0..SAMPLE_HOLD_MAX_SCALE` with no `options[]` while `SAMPLE_HOLD_SCALE_NAMES` is exported. **The roster is worth declaring on its own merits and does not need a face to justify it.** It is the #2007 class, and it is now the *fifth* member (see B11.1). |
| `spectrograph` | **1 param**, and the module IS its screen. §B10.0's correction stands: there is no B/W toggle param. |
| `dockscope` | Same display class as `scope` (#1932). ⚠ It is also the live `AUDIO_FIXTURE`, so faceing it moves the fixture pool — a systemic consequence that wants its own decision, not a batch slot. |
| `cellshade` · `chroma` · `chromakey` · `feedback` · `mandleblot` (6 params each) · `peakstate` · `lines` · `lushgarden` · `shapes` (5) | **The genuine video remainder, and the bank for batch 15.** None is blocked by #1865. Not picked only because `colourofmagic` and `acidwarp` are the two strongest of the unblocked set. ⚠ `mandleblot` is a DIFFERENT module from the excluded `mandelbulb` — easy to confuse, checked. `lushgarden` carries the dekey/DENY asset pipeline. |
| `shapedramps` | 8 params, 12 in / 6 out, a 96-line card and **no canvas**. Flagged for batch 15 as its own question: a `generic-face` **video** module with no screen has nothing for the SCREEN ON/OFF ruling to attach to, and `video-face-screen-source.test.ts` is deny-by-default with only `videoOut` exempt. |
| `vfpgaRunner` | **0 declared params against a 397-line card** mounting 3 knobs and 2 selects. That mismatch says the interaction is not param-shaped; it looks **mis-dispositioned** as `generic-face`. Flagged, not filed — confirming it needs a read of the card's state model, which this batch did not do. |
| `fader` · `tiler` · `mapper` · `onetonine` · `edges` · `colorizer` · `inwards` · `destructor` · `luma` · `lumakey` · `posterbox` · `scoreboard` · `sourcery` · `shapegen` · `tempest` · `vdelay` · `videoMixer` · `chroma`… | ≤ 4 params. The thin tail of the video pool; ranked but not spent. |

---

## B11.1 What all four share (measured, so it is not restated per entry)

| property | `colourofmagic` | `acidwarp` | `cvBuddy` / `Mini` | `gatemaiden` |
|---|---|---|---|---|
| domain | video | video | audio | audio |
| params | **37** | **5** | **2** / **2** | **2** |
| inputs | **31** | 2 `cv` | 3 / 2 | 1 `gate` |
| outputs | **22** | 1 `video` | 5 / 4 | 2 `gate` |
| declares `face` | no | no | no | no |
| declares `controlFamilies` | no | no | no | no |
| `primaryAudioOutPortId` | **null** | **null** | **null** | **null** |
| glyph (RUN) | **must be `'none'`** | **`'none'`** | **`'none'`** | **`'none'`** |
| in WebGL attest basis | ⚠ **YES** | ⚠ **YES** (+ `acidwarp-patterns.ts`) | no | no |
| in `STRICT_DOCS` | yes (`:351`) | yes (`:356`) | yes (`:38`,`:39`) | yes (`:155`) |
| `DESCRIPTIONS` | present | **absent — and that is legal** | present | present |
| `PUSH_CARD_CONTROLS` | none → GENERIC | none → GENERIC | none → GENERIC | none → GENERIC |
| VRT | FULL lane + **canvas mask** | ⚠ **EXEMPT (nondeterminism)** | ⚠ **cvBuddy EXEMPT / Mini has a COMMITTED baseline** | no baseline, no exemption |
| `raw-write-ledger` | — | — | — | ⚠ **`trigShape`, kind `debt`** |
| honest page count | **5** (+ hero) | **1** | **1** | **1** |
| filed this batch | #2022 | #2023 | #2024 | #2025 |

Five cohort-level facts, each measured rather than inherited:

- **⚠ THE GLYPH IS `'none'` FOR ALL FOUR, AND FOR ONE REASON.** RUN, not reasoned
  (B11.7): `primaryAudioOutPortId` returns **null** on all five defs — the video
  pair declare no `audio` output at all, and both audio picks declare `gate`
  ports, not `audio` ones. Every non-`none` glyph kind therefore resolves
  `{kind:'static'}`, which reddens the dead-glyph clause. This cohort adds **no**
  new witness to §23-15's *"a glyph that resolves is not a glyph that reads"* —
  it is four straightforward instances of B10.7's consequence 4. Recorded so no
  entry below has to re-derive it, and so nobody proposes a meter on a gate port.

- **⚠ THE ATTEST COST IS INVERTED RELATIVE TO §B10, AND IT SPLITS THIS COHORT
  DOWN THE MIDDLE.** Run through the real `isInBasis(relPath, resolveWebglBasis())`
  — the basis is **217 files**:

  ```
  IN   packages/web/src/lib/video/modules/colourofmagic.ts
  IN   packages/web/src/lib/video/modules/acidwarp.ts
  IN   packages/web/src/lib/video/modules/acidwarp-patterns.ts
  out  packages/web/src/lib/audio/modules/cv-buddy.ts
  out  packages/web/src/lib/audio/modules/cv-buddy-mini.ts
  out  packages/web/src/lib/audio/modules/gatemaiden.ts
  out  packages/web/src/lib/ui/modules/ColourofmagicCard.svelte
  out  packages/web/src/lib/ui/modules/AcidwarpCard.svelte
  ```

  §B10.1's cohort was "attest-free and contract-free" on all four; **this one is
  attest-free on the audio half and NOT on the video half.** The consequence is
  not uniform per module either, because `attest-code-basis.ts:53` strips the
  `docs` / `controlFamilies` / `face` / `noUserControl` properties of a def
  before hashing:

  | declaration | on a basis file (`colourofmagic`, `acidwarp`) | on a non-basis file (`cvBuddy`, `gatemaiden`) |
  |---|---|---|
  | `face: {...}` | **free** | free |
  | `noUserControl: [...]` | **free** | free |
  | `options[]` (lives in `params:`) | ⚠ **costs an owner-machine re-attest** | free |

  So the #1964 asymmetry lands on the video half of this batch. **Sequence the
  `options[]` work on `colourofmagic` and `acidwarp` into ONE re-attest**, not
  two, and note that the `acidwarp` seed hook (#2023 item 4) is engine code that
  costs one anyway — batch it with the roster.

  ⚠ `options=` and `landmarks=` appear **zero** times in `contract-lock.txt`, so
  the contract golden does not move for any of the four. Attest ≠ contract, and
  this cohort is the case where they differ.

- **⚠ THE #2007 CLASS NOW HAS FIVE MEASURED MEMBERS AND IS A FLEET PATTERN, NOT A
  MODULE BUG.** A discrete param with a real display roster that the param model
  cannot see:

  | module | param | positions | where the names live | filed |
  |---|---|---|---|---|
  | `foxy` | `sync_mode` | 3 | **def**, exported | #2007 |
  | `gatemaiden` | `trigShape` | 2 | **card** `:24` | #2025 |
  | `acidwarp` | `paletteType` | 8 | **card** `:110` | #2023 |
  | `colourofmagic` | `preview` | **22** | **card** `:107` | #2022 |
  | `cvBuddy`/`Mini` | `ppqn` | 48 declared / **7 legal** | **def**, exported `:96` | #2024 |
  | *(triage)* `sampleHold` | `scale` | 10 | **def**, exported | — |

  Two observations worth carrying forward. **First: where the roster lives
  decides the cost of the fix.** `foxy` and `cvBuddy` export a symbol
  `options[]` can point at; `gatemaiden`, `acidwarp` and `colourofmagic` keep
  their names in the *card*, so the fix has to author them into the def and the
  card's copy must then be deleted rather than left to drift. **Second:
  `cvBuddy` is not the same defect as the other four.** The others lose *names*;
  `ppqn` loses *legality* — 41 of its 48 reachable positions are values the card
  cannot produce and nothing rejects them.

- **NO PAINTED READOUTS, AND NO ENTRY BELOW PROPOSES ONE.** See B11.-1. Three of
  the four cards print derived text today (`cvBuddy`'s slot label and skip
  counter, `acidwarp`'s palette name, `colourofmagic`'s preview pills). On a
  face the *names* survive as `options[]` rosters — the declared-name route
  `paintsReadout` allows — and the *values* survive in `aria-valuetext`. Nothing
  is proposed for a readout strip, because there is no readout strip.

- **`bareCells`: NO on all four, decided rather than skipped.** `colourofmagic`
  is the one arguable case — 15 `bias_*` knobs under five block headings is the
  mixmstrs shape — and B11.2 rules against it there, because unlike mixmstrs the
  captions carry a CHANNEL identity (`R`/`G`/`B` vs `Y`/`Db`/`Dr`) that the
  block heading does not repeat. The other three have too few controls for the
  question to arise.

---

## B11.2 Q50 · `colourofmagic` — the pool's largest module, whose three COLOUR params resolve to a knob sweeping 16.7 million values that every gate passes

**Merit: YES, and it is the strongest entry in the batch.** Thirty-seven params,
31 inputs, 22 outputs — the biggest unfaced module in the `generic-face` pool by
a wide margin, and the only remaining one whose size is the point. It is also the
**first adopter of a shipped cell kind with zero adopters**, which is a real cost
and is priced rather than hidden.

**What it is FOR, musically.** A multi-colorspace video processor: one video input
runs through FIVE parallel colorspace blocks at once — RGB, YDbDr (SECAM), HSV-or-HSL,
YIQ (NTSC composite) and YCbCr BT.601 studio-swing — each encoding the picture into
that space, biasing each component, then decoding back. Per channel there is a BIAS
knob, a MONO OVERRIDE input that *replaces* that channel from a patched grayscale
stream, and an OVER/CLAMP toggle deciding out-of-range behaviour (CLAMP clips legal,
OVER wraps via `fract()` — the LZX chroma-wrap look). Twenty-two outputs run in
parallel: the untouched source, each block's colorized picture, and per-block
grayscale channel taps. The RGB block additionally has a palette REPLACE mode
remapping R/G/B to three chosen swatch colours — a duotone/tritone recolour.

**Control-heavy: YES on count — and it does NOT reach the tab rail.** This is the
entry's most counter-intuitive measurement and B11.6 ATTACK 10 is about getting
it wrong first. `DOCK_TAB_MIN_BANDS = 7` (`dock-tabs-model.ts:57`). The honest
band count is **5**, one per colorspace block, because that is how the card is
built (`colourofmagic-block-rgb` / `-ydbdr` / `-hsv` / `-yiq` / `-ycc`) and how
the module is described:

| page | params | n |
|---|---|---|
| `rgb` | bias_r/g/b, over_r/g/b, replace, pal_r/g/b | 10 |
| `ydbdr` | bias_y/db/dr, over_y/db/dr | 6 |
| `hsv` | bias_h/s/v, over_h/s/v, mode_hsl | 7 |
| `yiq` | bias_yiq_y/i/q, over_yiq_y/i/q | 6 |
| `ycc` | bias_ycc_y/cb/cr, over_ycc_y/cb/cr | 6 |

= 35, plus `preview` in the hero and `freeze` excluded via `noUserControl` = 37. ✓

⚠ **Do NOT pad to 7 to get the rail.** The owner ruling is explicit that pages are
never padded to force it, and `strict-faces.ts:2108` already records a precedent
face at *"SIX pages, which does NOT reach `DOCK_TAB_MIN_BANDS = 7`"*. **37 params
is not 37 bands** — the param count and the band count are different quantities
and only the second one decides the rail.

**HERO — the preview canvas plus the preview selector, and it costs nothing.**
`ModuleFaceHero` takes a `cell` (the module's own PICTURE, a registered panel) and
a promoted `control`. The natural pairing is `cell` = the preview canvas panel,
`control` = `preview`. Two notes from the contract:

- *"A face that promotes a PICTURE (`cell`) suppresses the shell glyph at the
  dock"* — free here, because the glyph is `'none'` anyway (B11.1).
- `control` **promotes** a key out of its band, it does not duplicate it, so
  `preview` must not also appear in a page's `controls` or faces-parity's exact
  param multiset fails.

This also avoids a one-control `preview` page, which would have been the thin
alternative.

**⚠ THE RANKING ARGUMENT, AND WHY `preview` RANKS FIRST.** `preview` decides
*which of 22 pictures you are looking at*. Every other control adjusts a picture;
this one chooses it, and with 22 outputs the module is unusable without it. The
five blocks then rank in the card's own order (RGB first — it is the only block
with a palette mode), and within a block BIAS ranks above its OVER toggle because
bias is the continuous gesture and OVER is a mode for its edges.

**⚠ THE THREE PACKED-RGB PARAMS ARE THE ENTRY'S SHARPEST FINDING, AND THE
PLATFORM ALREADY PREDICTED IT.** `pal_r` / `pal_g` / `pal_b` are packed
`0xRRGGBB` integers (`colourofmagic.ts:464-466`), declared
`min: 0, max: 0xffffff, curve: 'discrete'`. The card renders them as native
colour swatches (`ColourofmagicCard.svelte:330`, `<input type="color">`).
Measured through the real resolver:

| param | declared | default | lane | dock |
|---|---|---|---|---|
| `pal_r` | `discrete 0..16777215` | `16738816` (`0xFF6A00`) | `knob` | **`knob`** |
| `pal_g` | `discrete 0..16777215` | `57536` (`0x00E0C0`) | `knob` | **`knob`** |
| `pal_b` | `discrete 0..16777215` | `8011007` (`0x7A3CFF`) | `knob` | **`knob`** |

`ModuleFace.paramCells`' own doc-comment (`types.ts:776-784`) describes this exact
situation as the reason the `'color'` kind is declared rather than sniffed:

> A packed RGB is `0..16777215 discrete` — structurally identical to any other
> discrete param, differing only in MAGNITUDE, and nothing in the repo reads
> magnitude. Undeclared it resolves to a KNOB sweeping 16.7 million values, and
> **`faces-parity` PASSES that** (it drags the knob and the param moves), so **the
> absence of a declaration is invisible to every gate.**

**DECLARE `face.paramCells: { pal_r: 'color', pal_g: 'color', pal_b: 'color' }`.**

⚠ **Price the first-adopter cost honestly, exactly as §B10.3 did for `wavecel`'s
`toggle`.** Grepping every def in `packages/web/src/lib/{audio,video}/modules`:
**`'color'` has ZERO declared adopters.** The kind has a type, a documented
contract and a `<ColorField>` renderer; `colourofmagic` would be the first module
through it. Budget it as real work, not a one-line declaration.

**⚠ `preview` — DECLARE A 22-ENTRY `options[]`, AND ACCEPT THE SHAPE CHANGE.**
Measured: no roster → `knob` at BOTH tiers, i.e. a 22-position unlabelled dial.
The names exist but in the CARD (`ColourofmagicCard.svelte:107-112`): `PASS, RGB,
YDbDr, HSV, R, G, B, LUMA, dY, Db, Dr, H, S, V, YIQ, iY, I, Q, YCC, cY, Cb, Cr`.
Two consequences to decide deliberately rather than discover:

1. 22 > `SEGMENTED_MAX_OPTIONS` (6), so the dock resolves **`selector`** — a
   dropdown — where the card paints 22 pills. That is a genuine look change on a
   module whose look is owner-visible. **It is the decision-shaped half of #2022
   and it stays open.**
2. The roster must be authored INTO the def (there is no exported symbol to point
   at) and the card's copy then deleted, or the two drift. ⚠ And it **costs a
   re-attest** (B11.1) because `params` is not stripped.

⚠ Labels must not trip `looksNumeric` in `face-readout-source.test.ts`. All 22 are
safe.

**⚠ `freeze` — DECLARE `noUserControl`, `writer: 'internal'`.** The def's own docs
(`:568`) say *"hidden determinism toggle … Default 0; **no card control**"*. It is
a declared `ParamDef`, so a generic face ranks and paints it, putting a **VRT
harness switch on the player's faceplate** where freezing the picture reads as a
broken module. `writer: 'internal'` is asserted against the def's own ports to
have no `paramTarget`, so the day one is added the entry stops being true and says
so. **Free even on a basis file.**

**Tier ladder as a sentence:** the glyph is `'none'`, so the compact cap is
`LANE_ROW_MAX_CELLS = 3` (not the 2 that `LANE_ROW_MAX_CELLS_WITH_GLYPH` imposes)
— `preview` plus the two most-reached biases at compact, `preview` alone at mini,
everything plus the hero panel at dock.

**⚠ SCREEN ON/OFF IS MANDATORY AND GATED.** `video-face-screen-source.test.ts` is
**deny-by-default over `STRICT_FACES ∩ video defs`**, with `videoOut` the only
exemption. So this face must own a `fullViewBody` shell extension carrying a screen
switch over the shared `previewCollapsed` key, and per #2015 the engine **keeps
rendering while OFF** — a SCREEN OFF that stops the render loop is the defect that
issue is about. The gate reads SOURCE only and says so; the render half is e2e's.

**STOP 2 — the card was read, and the non-`ParamDef` affordances are:**

1. **`colourofmagic-canvas`** (`:266`) — the preview canvas. → the hero `cell`
   panel. ⚠ Its VRT treatment already exists: `vrt-exemptions.ts:326-327` masks
   `canvas` on this module because it is *"live on-card preview … blitted off the
   engine clock, black when nothing is patched"*. **The face's panel needs the
   same mask**, or the new scenes will not be stable.
2. **`colourofmagic-preview-{n}`** (`:271-276`) — the 22 pills. → the `options[]`
   roster above. ✓
3. **`colourofmagic-swatches` / `-pal_r|g|b`** (`:324-334`) — → the `'color'`
   cells. ✓
4. **`colourofmagic-replace` / `-hsl`** (`:289`, `:378`) — plain 0/1 params that
   resolve `toggle` cleanly with no roster needed. ✓
5. **The five `{#each}` block loops** — these are the reason B11.6 ATTACK 4
   exists: the card mounts `<Knob>` five times in SOURCE and fifteen times at
   RUNTIME. Nothing is lost here (they are all real params), but any count taken
   off card source in this batch is a source-occurrence count.

**VRT:** FULL (informational) lane, not `STRICT_VRT_MODULES`, plus the canvas mask
above and a bespoke `vrt-colourofmagic.spec.ts` for the deterministic per-block
composite. **Check that spec against the face before dispatching.** Ten new
`face-colourofmagic-*` scenes need `{ type: 'colourofmagic', pages: 5 }` in
`e2e/vrt/_shell-faces.ts`.

**e2e:** a bespoke `e2e/tests/colourofmagic.spec.ts`, plus the shared per-port
sweeps. ⚠ It also appears in `sourcery.spec.ts` and `grains-of-vision.spec.ts` —
**check whether either uses it as a fixture** before promoting; a spec that spawns
it and addresses `colourofmagic-card` keeps passing on `?shell=legacy` while the
thing it proves stops being true on the default rack (the #1606 / #1929 shape).

**Push 2:** no entry → GENERIC today. ⚠ 22-entry selector and three colour cells
are both new shapes for `push-card-schema`; check before accepting the golden.

**Rear card:** **31 inputs, 22 outputs** — the second-largest port field the face
program has met after `synesthesia`'s 48 outputs, and §B10.4's warning applies
verbatim: **run `rearFieldPlan` at this count BEFORE building.** The
`{block}_{ch}_{cv|in}` naming is the grouping to keep.

**ART:** none; a face changes no DSP.

**DEFECT FILED, not folded in: #2022** — the 22 preview names live in the card,
three packed-RGB params resolve to a 16.7M-position knob, and a VRT-only `freeze`
would ship to players.

**RISK: MEDIUM-HIGH, and it is size plus first-adopter, not uncertainty.** 37
cells, a hero panel, 10 VRT scenes, a 31×22 rear field, the `'color'` cell's first
adoption, and a re-attest for the roster. **This is its own PR, alone.**

---

## B11.3 Q51 · `acidwarp` — a module whose VRT exemption blocks its own promotion, and whose `freeze` param stops only half the motion

**Merit: YES, but it is BLOCKED, and the blocker is the entry.** Five params is
thin and this entry does not pretend otherwise. What makes it worth a slot is that
the blocker is **precisely diagnosable, fix-shaped, and small** — and that it is a
trap no def-reading triage would have found.

**What it is FOR, musically.** A pure-GPU plasma SOURCE with no video input — a
faithful port of Noah Spurrier's 1992-93 ACIDWARP demo. A 320×240 buffer of 8-bit
palette indices is generated once per scene by a per-pixel formula; every frame a
256-entry palette is rotated by one or more slots and sampled per pixel. **The
scrolling palette is what makes the pattern appear to flow, even though the index
field is static until the scene changes.** 41 scenes, 8 palettes. A generative
video bed: ride SPEED for the cycling rate, nudge SCENE by hand or clock it.

**Control-heavy: NO.** Five params, one idea. Honest page count **1**. Say "1
page" rather than manufacturing a second.

**THE RANKING ARGUMENT.** Read off the def and the card (this is a GPU source; no
worklet was pumped).

| param | range / curve | default | delivered | authority |
|---|---|---|---|---|
| `speed` | 0…1 linear | 0.5 | 0 = still, 0.5 = native 1×, 1.0 = 4× | the only continuous control, and the one that sets the whole feel |
| `scene` | **0…40** discrete | 0 | picks 1 of 41 index fields | changes what the picture IS |
| `paletteType` | **0…7** discrete | 0 | picks 1 of 8 palettes | changes the colour, not the form |
| `freeze` | 0…1 discrete | 0 | halts the auto scene cycler; **palette still rotates** | a mode, not a sound |
| `sceneTrig` | 0…1 linear | 0 | ⚠ **CV-only; no card control** | not a user control at all |

**Rank order: `speed, scene, paletteType, freeze`** — with `sceneTrig` not ranked
at all (below).

**⚠ THE BLOCKER, AND IT IS THE REASON THIS ENTRY EXISTS.**
`vrt-exemptions.ts:723` exempts `acidwarp` from VRT:

> `'animated palette rotation + auto scene cycler defeats deterministic capture;
> unit + E2E provide coverage'`

Promotion does not escape that, because `workflow-shell-faces.spec.ts:611-618`
asserts the **FACES ↔ STRICT_FACES identity in BOTH directions**:

> * in STRICT_FACES, not in FACES → a shipped face with no pixel scene.
> * in FACES, not in STRICT_FACES → a scene for a face users cannot reach.

So a promoted `acidwarp` **must** have face VRT scenes, on a module whose standing
exemption says it cannot have stable ones.

**And its own `freeze` param does not fix it — this is the half-measure that makes
the entry sharp.** The exemption names *two* motion sources. `freeze` halts one.
`acidwarp.ts:27`, the def's own header:

> `FREEZE button on the card → halts auto scene-change (**palette still rotates**)`

A frozen acidwarp still animates every frame, because palette rotation *is* the
animation — the index field was already static. **A builder who reasons "it has a
freeze param, so it must be capturable" gets a flaky baseline.**

The fix is the seed-hook pattern already shipping twice — `__rasterizeVrtSeed`
(§B10.2) and `__foxyVrtSeed` (§B10.5) — a short-circuit pinning palette rotation
*as well as* the cycler. Small, self-contained, and **it must land first**. Filed
as **#2023 item 4**.

**⚠ `paletteType` — DECLARE `options[]`; the eight names are in the card.**
`AcidwarpCard.svelte:110`:

```ts
const PALETTE_NAMES = ['RGBW', 'GREY', 'HALF', 'PASTEL', 'RGBW✨', 'GREY✨', 'HALF✨', 'PSTL✨'] as const;
```

Measured: no roster → `knob` at both tiers, an 8-position unlabelled dial. With a
roster, 8 > `SEGMENTED_MAX_OPTIONS` (6) → the dock resolves **`selector`**. The
`✨` labels do not trip `looksNumeric`. ⚠ Costs a re-attest (basis file) — batch it
with the seed hook.

**⚠ `scene` — honestly anonymous, and the face CHANGES THE GESTURE.** 41 positions
(`SCENE_COUNT = 41`, `acidwarp-patterns.ts:21`) and **no scene names exist
anywhere in the tree**, so there is no roster to declare and a dial is the honest
cell. But the card's affordance is not a picker: `AcidwarpCard.svelte:101` is
`(cur + 1) % SCENE_COUNT`, a **cycle button**. A face's dial can jump; the card
cannot. That makes the face strictly *more* capable — which is fine, and is
exactly why it should be written down as a decision rather than arrived at by
default. Recorded in #2023 item 2.

**⚠ `sceneTrig` — DECLARE `noUserControl`, `writer: 'cv-port'`.** It is CV-driven
(`scene_cv` declares `paramTarget: 'sceneTrig'`, `acidwarp.ts:140`) and the draw
loop edge-detects it; there is no card control. Unranked, it cannot be painted as
a knob that does nothing repeatable when dragged. `writer: 'cv-port'` is checked
against the def's own ports, so it is anchored. **Free even on a basis file.**

**Tier ladder as a sentence:** glyph `'none'` → compact cap is
`LANE_ROW_MAX_CELLS = 3`: SPEED, SCENE, PALETTE at compact; SPEED at mini; all
four plus the panel at dock.

**⚠ SCREEN ON/OFF IS MANDATORY** — same deny-by-default gate as Q50. `acidwarp` is
a video def and will be in `STRICT_FACES`, so it needs a `fullViewBody` with the
screen switch, and the engine keeps rendering while OFF (#2015).

**STOP 2 — the card's non-`ParamDef` affordances:**

1. **`acidwarp-screen`** (`:120`) — the plasma canvas. → a registered **panel**,
   hero. Its probe must be an effect a dead panel cannot produce, and ⚠ **not a
   pixel diff**, for the same reason the module is VRT-exempt.
2. **`acidwarp-scene`** (`:137`) — the cycle button. → carried by the `scene`
   cell, with the gesture change noted above.
3. **`acidwarp-freeze`** (`:144`) — → the `freeze` toggle. ✓
4. **`acidwarp-palette`** (`:150`) — → the `paletteType` selector. ✓

**e2e:** `render-worker-acidwarp.spec.ts` and `acidwarp-render-smoke.spec.ts`,
plus appearances in `recording-survives-card-collapse.spec.ts`,
`scratch-persist-video-live.spec.ts`, `extras-producer-lifetime.spec.ts`,
`freezeframe.spec.ts` and `mapper.spec.ts`. ⚠ **That is a wide fixture surface for
a 5-param module** — acidwarp is evidently a convenient "cheap live video source"
across the suite. **Grep every one for card-shaped selectors before promoting**;
this is the entry's main sequencing risk and it is larger than the module.

**VRT:** exempt (above), and also listed at `vrt-exemptions.ts:1094` in the
permanent-exempt roster. Two new `face-acidwarp-*` scenes need
`{ type: 'acidwarp', pages: 1 }` in `_shell-faces.ts` — **after** the seed lands.

**`DESCRIPTIONS`: absent, and NOT a defect.** `module-manifest.ts:1090-1095`
falls back to a derived one-liner when a **video** module carries no hand-written
entry (*"AUDIO is byte-unchanged: every audio module already has a DESCRIPTIONS
entry, so the `||` short-circuits"*). Checked so the next triage does not file it.

**Push 2 / rear card / ART:** GENERIC today; 2 CV in / 1 video out, both inputs
declare `paramTarget` so the rear groups derive from the param model; no ART
scenario, and a face changes no DSP.

**DEFECT FILED, not folded in: #2023** — the VRT exemption blocks promotion and
`freeze` does not fix it (**prerequisite**); 8 palette names stranded in the card;
`sceneTrig` paintable.

**RISK: MEDIUM.** No DSP change, no required baseline, contract NIL — but a
re-attest, a seed hook, and a fixture surface across six specs. **Build order:
seed + rosters first (one PR, one re-attest), then the face.**

---

## B11.4 Q52 · `cvBuddy` + `cvBuddyMini` — a PAIR whose entire visible surface is text a faceplate is no longer allowed to paint

**Merit: YES on the question it forces, QUALIFIED on the face itself.** This is
§B10.8's explicit handoff — *"someone should deliberately re-open `cvBuddy` /
`cvBuddyMini`… not because the reason survived"* — and this is that re-open.
Two params each is thin; the entry's value is that it surfaces a **collision
between a module's design and a ruling that post-dates it**, and that collision
will recur.

**ONE ENTRY, NOT TWO, AND THAT IS MEASURED.** Applying Q28's pairing test rather
than taste: both cards are 13-line wrappers rendering **one shared
`CvBuddyBody.svelte`** with a `kind` prop (`CvBuddyCard.svelte:13`,
`CvBuddyMiniCard.svelte:13`). The body's own header says why they must not
diverge: *"⚠ ONE body on purpose… Two copies would drift, and the drift would be
invisible until a user noticed one card telling the truth and the other not."*
Same merit argument, same fix, shared implementation → **one entry, and they move
together.**

**What it is FOR, musically.** Sends a clip lane out to a real Eurorack voice
through an ES-9. Hand-patch a lane's pitch / gate / velocity in; CV Buddy passes
them to CV/gate outputs which the ES-9 reconciler auto-routes to physical jacks by
slot (first instance → jacks 1-3, second → 4-6) and sets each jack's voltage class.
The id-smallest instance additionally generates transport: RUN on jack 7 and CLOCK
on jack 8 at a selectable PPQN, phase-locked to TIMELORDE. The MINI drops velocity.

**Control-heavy: NO.** Two params. Honest page count **1**.

**THE RANKING ARGUMENT.** `ppqn` then `clockOffsetMs` — and note that **both are
invisible on every instance except the clock owner**, which is the entry's
structural oddity (below).

| param | range / curve | default | delivered | authority |
|---|---|---|---|---|
| `ppqn` | **1…48 discrete** | 24 | ⚠ **only 7 values are legal** | the clock's whole resolution |
| `clockOffsetMs` | −20…20 linear, `units: 'ms'` | 0 | manual latency trim | a calibration, not a performance control |

**⚠ `ppqn` — DECLARE `options[]`, AND THIS IS A LEGALITY BUG, NOT A NAMING ONE.**
The roster is exported (`cv-buddy.ts:96`):

```ts
export const CV_BUDDY_PPQN_CHOICES: readonly number[] = [1, 2, 4, 8, 12, 24, 48];
```

and the def **names it in the param's own comment and then declares no roster**
(`:342-343`): *"Discrete PPQN menu; the card renders a select over
CV_BUDDY_PPQN_CHOICES"*, `{ id: 'ppqn', min: 1, max: 48, curve: 'discrete' }`.

Measured, identical on both defs: `knob` at lane AND dock. So a face paints a
**48-position dial of which 41 positions are values the card cannot produce**, and
nothing rejects them — `cv-buddy.ts:278` is `if (paramId === 'ppqn') ppqn = value;`
straight into the clock scheduler, no snap, no clamp to the roster.

⚠ **This is the #2007 class's worst member because the others lose names and this
one loses legality.** 7 > `SEGMENTED_MAX_OPTIONS` (6) → the dock resolves
**`selector`**, verbatim parity with the card's `<select>`. **Attest-free and
contract-free** (B11.1). This half is fix-shaped and cheap.

**⚠ THE PARITY BLOCKER — ALMOST EVERYTHING THIS MODULE SHOWS IS DERIVED-STATE
TEXT.** `CvBuddyBody.svelte` shows, per its own header (`:10-17`):

- **which ES-9 jacks this instance owns** — `slotLabel` (`:87-92`), e.g.
  `Jacks 1–3 (pitch/gate/vel)`, derived by `allocateCvBuddySlots()` over **every
  CV Buddy on the rack, of either kind** (`:66-84`);
- **a CLOCK section rendered ONLY on the id-smallest instance** (`ownsClock`,
  `:85`) — PPQN + offset + `run → jack 7 · clock → jack 8`;
- **an ES-9 presence mirror** prompting the user when no ES-9 is in the rack
  (`:76-82`);
- **a late-tick `clockSkips` counter** (`:117-130`), whose own comment argues a
  zero must always render: *"A ZERO IS INFORMATION… Hiding it until non-zero would
  make 'healthy' and 'not instrumented' look identical."*

Per the resting-text ruling the permitted text on a faceplate is exhaustively the
module NAME, tab/section LABELS, control CAPTIONS and option/landmark NAMES.
**All four items above are derived values, and `ModuleFace` has no field that can
carry them** — `readouts` and `sidebar` are deleted and re-adding either under any
name is refused (`types.ts:960`, and see B11.-1).

⚠ **And none of it is reachable by a param-reading mechanism anyway**: all four are
functions of **rack-global** state (which other CV Buddies exist, whether an ES-9
exists, engine clock state), not of this node's params. §B10.3 established that
`shell-cells` specs are NODE-taking closures and can see `node.data`; **that does
not extend to rack-global state**, and this entry is the case that draws the line.

**The shape of the answer, neither route free:**

1. **A registered `panel`** — a hand-written component with its own DOM and its
   own reads, which is how `dx7` / `cube` / `bluebox` already carry non-param
   affordances. A panel's contents are *drawn*, and `face-resting-text-source`
   states that text drawn inside a panel is its blind spot. This is the honest
   carrier for the slot readout and the ES-9 mirror.
2. **`aria-valuetext`** for what is genuinely *about a control* — the ruling's
   named home. Fits the clock section; does **not** fit the ES-9 mirror, which is
   about the rack, not about a control.

⚠ Whichever is chosen, `clockSkips` is a **diagnostic the card's own comment argues
must be visible at zero**. Dropping it on promotion is the #1865 functional-parity
shape — *"never surface 'we would lose X' as an owner choice."*

**⚠ THE VRT HOLD IS CONTRADICTED BY A COMMITTED BASELINE OF THE SAME PIXELS.**
`vrt-exemptions.ts:428` exempts `cvBuddy`:

> *"VRT baseline pending — hardware-facing card whose look is NOT yet owner-locked
> (Part A preview; the slot/clock readout + ES-9 mirror will likely change on owner
> feedback), so a baseline now would just churn."*

That reads as the #1936 shape — an owner-look hold a face cannot be promoted
through, since FACES ↔ STRICT_FACES is asserted both ways. **Except the premise is
already false.** `cvBuddyMini` is **not** exempt and carries a committed baseline:

```
e2e/vrt/__screenshots__/vrt.spec.ts/cvBuddyMini.png
```

Both cards render the same body. So the shared body's look **is** pinned today for
one of its two consumers, and *"a baseline now would just churn"* is not true of a
body that already churns the mini's baseline on any change. Either the look is
settled enough to pin — and the face is unblocked — or it is not, and the mini's
committed baseline is itself the bug. **Both cannot be right, and the pair shares
one body.** This is the decision-shaped half of **#2024** and it stays open.

**Tier ladder as a sentence:** glyph `'none'` → compact cap 3, but there are only
2 params; the interesting question is not truncation but that on a **non-owner
instance the clock params are meaningless**, so a face shows two controls that do
nothing on most instances. That asymmetry has no faced expression today and is
part of what route (1) or (2) must answer.

**`paramCells`: NONE.** The card renders a `<select>` and a numeric input, neither
of which is `'grid'` / `'color'` / `'fader'`. Declaring nothing is correct and is
recorded as a decision.

**Rear card:** cvBuddy 3 in / 5 out; Mini 2 in / 4 out. ⚠ The *ports* are the
module's real surface here, and the rear card is where a player checks which jack
is which — **worth curating rather than deriving** for this pair specifically.

**e2e / Push 2 / ART:** only the shared per-port sweeps plus
`workflow-channel-columns.spec.ts` for cvBuddy. No `PUSH_CARD_CONTROLS` entry →
GENERIC. No ART scenario. Both in `STRICT_DOCS` with `DESCRIPTIONS` entries.

**DEFECT FILED, not folded in: #2024** — `ppqn`'s 41 illegal positions
(fix-shaped, cheap); the VRT hold contradicted by the mini's baseline
(**decision-shaped**); the derived-text parity blocker (**decision-shaped**, and
possibly an argument that the pair is mis-dispositioned as `generic-face` at all).

**RISK: HIGH on the face, LOW on the fix.** The `options[]` roster is a clean
attest-free win that should land regardless. The FACE should not start until
#2024's two decisions are answered — this is the `synesthesia`/#2004 shape at a
smaller size, and the honest recommendation is **land the roster, hold the face.**

---

## B11.5 Q53 · `gatemaiden` — both of batch 13's silent build bugs, in eleven lines of markup

**Merit: YES, and it is the cheapest entry the program has had.** Two params. It
earns its slot because it carries **both** regressions batch-13's reconciliation
caught — an anonymous two-state switch losing its only labels, and a fader
rendering as a dial — on one small card, plus a ledgered raw write a face pays.
If a spec is supposed to be able to catch that class, this is the module to prove
it on.

**What it is FOR, musically.** A gate shaper: one gate IN; a GATE out (held square,
minimum width `Len`) and a TRIG out (a short pulse) — so a ragged or too-short gate
becomes a clean, minimum-width gate plus a reliable trigger.

**Control-heavy: NO.** Two params. Honest page count **1**.

**THE RANKING ARGUMENT.**

| param | range / curve | default | authority |
|---|---|---|---|
| `gateLen` | 0.005…2 s, **log**, `units: 's'` | 0.05 | the module's whole job — the minimum gate width |
| `trigShape` | 0…1 discrete | 0 (TRI) | the TRIG output's shape |

**Rank order: `gateLen, trigShape`** — declaration order, and for once that is
also the right order.

**⚠ FINDING 1 — `trigShape`'s ONLY labels are card-only.**
`GatemaidenCard.svelte:24`:

```ts
const shapeLabels = ['△ TRI', '▭ SQR'] as const;
```

rendered by a single cycle button (`:49`). The def declares no `options[]`.
Measured:

| param | declared | `looksLikeToggle` | lane | dock |
|---|---|---|---|---|
| `trigShape` | `discrete 0..1`, no roster | **true** | `toggle` | `toggle` |

So a face paints a **Toggle with no name**, and the two labels — the only thing
distinguishing the states — die with the card. **This is exactly the bug batch 13
caught**, and it is caught here *before* the build because the spec ran the
resolver.

Declaring `options: [{value:0,label:'TRI'},{value:1,label:'SQR'}]` fixes it:
`options` outranks `looksLikeToggle` (`shell-control-kind.ts:266-271`), so the
dock resolves **`segmented`** (2 ≤ `SEGMENTED_MAX_OPTIONS`) — two captioned
buttons, verbatim parity — and the lane resolves `knob`, painting the NAME via
`paintsReadout`. Neither label trips `looksNumeric`.

⚠ **And #2008 makes those labels load-bearing rather than cosmetic.** That open
issue measured the docs claim *"Display/feel only; both fire once per rising edge
with the same canonical pulse width"* to be **FALSE** — TRI delivers exactly
**half** the area of SQR (120 vs 240). The names label a real behavioural
difference, so losing them is worse than a cosmetic regression. **Fix #2008's docs
and this roster together.**

**⚠ FINDING 2 — `gateLen` is a FADER and would silently become a dial.**
`GatemaidenCard.svelte:40` mounts `<NeonFader>`. Nothing in a `ParamDef`
distinguishes "a level drawn as a throw" from any other continuous scalar
(`types.ts:785-791`), so **declare `face.paramCells: { gateLen: 'fader' }`**.
⚠ Price the lane consequence: a fader cell is materially taller than a plate row.

**⚠ FINDING 3 — the face PAYS a ledgered raw write, and the entry must be
DELETED in the same PR.** `raw-write-ledger.ts:195-199`:

```ts
'ui/modules/GatemaidenCard.svelte': { keys: ['trigShape'], kind: 'debt',
  why: 'card button write — user gesture, should be undoable + synced' },
```

A face routes `trigShape` through the normal param path, so the debt is paid by
construction. The ledger is anchored to the artifact — **an entry naming a write
that no longer exists is RED** — and the precedent sits a few lines below it in
the same file (`JoystickCard`'s entry, deleted when Q43 paid it).

**Two facts a builder would otherwise re-derive:**

- **Glyph `'none'`.** RUN: `primaryAudioOutPortId(gatemaidenDef)` is **null** —
  its ports are `gate`, not `audio` — so every other kind resolves
  `{kind:'static'}`.
- **It renders `.faceplate.gate`, not `.faceplate.audio`.** Already recorded in
  `e2e/tests/_face-fixtures.ts:430`: *"`gatemaiden` is `domain: 'audio'` with GATE
  ports and renders `.faceplate.gate`: it satisfied the requirement as written and
  still could not satisfy the assertion."* **Any selector or CSS keyed on
  `.faceplate.audio` will not match.** Same trap B9.3 hit on `joystick` and B10.1
  hit on all four.

**Tier ladder as a sentence:** glyph `'none'` → cap 3, and there are 2 params, so
no truncation at any tier. LEN at mini.

**STOP 2 — the card is otherwise CLEAN.** Beyond the fader and the shape button
there is a `portsFromDef` PatchPanel (`:22`) with decorative port labels
(`▭ GATE` / `▷ TRIG`) — those belong to the rear card, not the face.

**VRT / e2e / Push 2 / ART:** no baseline and no exemption — the cheapest VRT
position in the batch. Two new `face-gatemaiden-*` scenes need
`{ type: 'gatemaiden', pages: 1 }`. It appears in `docs-virtual-module.spec.ts`,
`_per-port-drivers.ts` and `_face-fixtures.ts` — ⚠ in the last it is named as a
**rejected fixture candidate**, i.e. prose, not a live dependency; check it is
still only prose before promoting. GENERIC push tier; no ART scenario.

**Cost:** attest-free, contract-free, in `STRICT_DOCS` (`:155`), has a
`DESCRIPTIONS` entry. Two cells → `faces-parity` ≈ **11.6 s**.

**DEFECT FILED, not folded in: #2025** (both build bugs + the ledger), adjacent to
the open **#2008** (the docs claim is false).

**RISK: LOW.** The lowest in the batch by every measure. **Build this one first
— it is the batch's proof that the spec bar catches the class.**

---

## B11.6 THE ADVERSARIAL PASS — what I attacked in my own work, and what survived

Per `module-adversarial-audit.md`. Recorded because *"verified X by measuring Y"*
beats *"X is true"* — and because **five of these attacks succeeded against me,
one of them twice, and two of the five would have produced filed defects that do
not exist.**

**⚠ ATTACK 1 — SUCCEEDED, and it nearly put a module in this batch that is not the
module.** My def-locator grepped `type:\s*'<type>'` across the module dirs, audio
first. For `feedback` it returned **`packages/web/src/lib/audio/modules/dx7.ts`**,
because `dx7.ts:606` contains `workletNode.port.postMessage({ type: 'feedback',
value: f })` — a postMessage payload, not a def. The row it produced read
`feedback | A | 9 params | 3 in | 1 out | face | CF | card=145` — **dx7's face and
controlFamilies flags attached to a module that has neither**, and it was
internally consistent enough to survive a glance. The real
`video/modules/feedback.ts` is 6 params, 7 in, 1 out, no face, no CF.

Anchoring the pattern to a def's own property shape (`^  type:` — two-space
indent, line start) fixes it. ⚠ **A grep for a KEY:VALUE pair matches every place
that pair appears, including data.** Anchor to the structure, not the string.

**⚠ ATTACK 2 — SUCCEEDED TWICE against the same regex, and one half would have
been a filed defect that does not exist.** My range extractor was
`/\bmax:\s*(-?[\d.]+)/`. Two failures, opposite in flavour:

- `max: 0xffffff` → captured **`0`** (matched the leading `0`, stopped at the
  `x`). So `pal_r` / `pal_g` / `pal_b` printed as **`[0..0]`** — zero-width
  params. I had begun writing that up as *"three params whose min equals their
  max"*, which is a striking finding and **entirely an artefact of the regex**.
  The truth is the opposite and far more interesting: `0..16777215`, the packed
  RGB case the platform documents.
- `max: SCENE_COUNT - 1` → captured **nothing** (a const expression, not a
  literal), printing `[0..undefined]` and hiding a **41-position** rotary.

⚠ **The two failure modes are not symmetric and that is the lesson.** The second
announced itself (`undefined` is visibly wrong). The first returned a **clean,
plausible number** and would have been believed. A parser that silently truncates
looks exactly like a measurement.

**⚠ ATTACK 3 — SUCCEEDED against §B10, and the finding is #2020.** I set out to
copy B10's READOUTS section shape and went looking for `face-readout-values.ts` to
check the registry's format. It does not exist. Establishing *when* it stopped
existing is what turned a "my checkout is odd" shrug into a filed defect:
`740bac121` deleted 1809 lines on 2026-08-19 20:15, and
`git merge-base --is-ancestor 740bac121 8e856e0f1` confirms the deletion was
**already in the base §B10 names**. ⚠ **This is §B10's own ATTACK 5 catching §B10
one file later** — it re-took the derived *artifacts* from `origin/main` and did
not re-take the *platform file it was recommending*. The class was known; the
sweep was incomplete.

**⚠ ATTACK 4 — SUCCEEDED against my own card screen, and it weakens a claim I was
about to make cohort-wide.** I counted control primitives by grepping card source
for `<Knob` / `<NeonFader`. On `ColourofmagicCard.svelte` that returns **5**
knobs. The card renders **fifteen** — the five occurrences are inside five
`{#each}` block loops. So **every primitive count taken off card source in this
batch is a source-OCCURRENCE count, not a runtime count**, and it undercounts
exactly the cards that are built well (loops over a channel list).

⚠ The claim this killed: my screen showed most unfaced video cards mounting
`NeonFader` and I was ready to write *"the video fleet is fader-based, so every
video face needs `paramCells: 'fader'`"* as a cohort-level rule. It may well be
true, but **a source-occurrence count cannot establish it**, and neither of this
batch's video picks is fader-based (both use Knobs). Downgraded to a per-module
check, which is what B11.5 does for the one module where it bites.

**⚠ ATTACK 5 — SUCCEEDED against my own grep, and I nearly reported a §B10 claim
as FALSE.** §B10.0 says whoever faces `gatemaiden` *"pays a `raw-write-ledger`
`debt` entry on `trigShape`"*. My `grep -rn gatemaiden raw-write-ledger.ts`
returned **nothing**, and "B10 asserted a ledger entry that does not exist" was
briefly in my notes. The ledger is keyed by **card path**, not module name:
`'ui/modules/GatemaidenCard.svelte'` — capital G, and my lowercase module-name
grep could never match it. §B10's claim is **correct**; my instrument was
case- and key-space-blind. ⚠ **A null result from a grep is a statement about the
grep until you have checked the key space.**

**ATTACK 6 — "`acidwarp`'s VRT exemption is stale like the #1849 seam — it has a
`freeze` param, so it must be capturable." DISPROVEN by reading the def.** This
was my initial read and it is wrong. The exemption names two motion sources —
*"animated palette rotation + auto scene cycler"* — and `acidwarp.ts:27` says
`freeze` *"halts auto scene-change (**palette still rotates**)"*. Since the index
field is static until the scene changes, **palette rotation IS the animation**; the
param that sounds like the fix stops the half that was already still. ⚠ The
tempting generalisation after #1849 is *"blockers are usually stale"*; this one is
live, and the way to tell was reading what the exemption's two clauses each refer
to rather than counting them as one.

**ATTACK 7 — "`cvBuddy`'s VRT exemption blocks it, exactly like #1936."
HALF RIGHT, and the wrong half is the interesting one.** The exemption does have
the #1936 shape. But enumerating rather than asserting turned up
`e2e/vrt/__screenshots__/vrt.spec.ts/cvBuddyMini.png` — a **committed baseline**
of the *same shared body* the exemption calls not-yet-owner-locked. So the hold's
premise is already contradicted inside the repo. ⚠ **Two modules that share one
component can hold contradictory VRT positions and no gate compares them**, which
is a small blind spot worth someone's attention beyond this pair.

**ATTACK 8 — "these are four entries; or the cvBuddy pair is two."** Attacked with
Q28's pairing test rather than taste. *Shared implementation?* Only within the
cvBuddy pair — one `CvBuddyBody.svelte`, `kind` prop — which is why they are ONE
entry. Across the four: none. *Cross-references either way?* Zero between any
pair. *The same merit argument?* No — four different ones: a first-adopter cell
kind at scale, a self-blocking VRT exemption, a ruling collision over derived
text, and a two-bug regression fixture. **Four entries, one of which covers two
modules.**

**ATTACK 9 — "`acidwarp` has no `DESCRIPTIONS` entry — that's a defect." NOT
FILED, because the fallback is deliberate.** Memory says a new module needs a
`DESCRIPTIONS` entry or the unit gate fails, and acidwarp has none. Reading
`module-manifest.ts:1090-1095` rather than trusting the memory: there is an
explicit derived-description branch for video modules, with a comment stating
*"AUDIO is byte-unchanged: every audio module already has a DESCRIPTIONS entry, so
the `||` short-circuits before this branch."* The remembered rule is an **audio**
rule. ⚠ A near-miss false positive, recorded so the next triage does not file it.

**ATTACK 10 — "`colourofmagic` has 37 params, so it obviously trips the tab
rail." DISPROVEN by counting the right thing.** `DOCK_TAB_MIN_BANDS = 7` counts
**bands**, not params. The honest band count is **5** — one per colorspace block,
which is how the card is structured and how the module is documented. Getting to 7
would mean splitting a block's biases from its OVER toggles, which is padding, and
`strict-faces.ts:2108` already records a precedent face sitting at six and
declining to. ⚠ **The largest module in the pool does not reach the rail**, and
§B10.5's `foxy` (33 params, 7 honest pages) reaching it is not a precedent about
size — it is about how many genuine groups a module has.

**WHAT I DID NOT MEASURE — stated so a builder knows the edges of this spec:**

- **Nothing was rendered in a browser.** No dock layout, no band packing, no tier
  truncation, no VRT pixel, no GLSL, no panel. Every page count, cap consequence
  and cell-kind claim is either read off `curated-face.ts` / `dock-tabs-model.ts` /
  `module-shell-model.ts`, or produced by running those files' own exported pure
  functions under vitest.
- **NO DSP AND NO GPU WAS DRIVEN.** Unlike §B10, which pumped `wavecel` and
  `gatemaiden` through the `registerProcessor` shim, **this batch pumped nothing.**
  There is no measured audio or pixel claim anywhere in it. Every behavioural
  statement is read off a def, a card or a doc string. ⚠ In particular
  **`gatemaiden`'s TRI-vs-SQR area figures are quoted from #2008, not re-measured
  here** — if that number matters to a build, re-take it.
- **No panel was written, so no `probe` was validated.** Every probe proposed is a
  design. The standing rule is that a panel/action probe must have an effect a
  DEAD panel cannot produce; check each against that bar when you build it.
- **`rearFieldPlan` was NOT run against `colourofmagic`'s 31×22 port field**, which
  is the second-largest the program has met. B10.4 said the same of synesthesia's
  48 and it is still unrun.
- **Push 2 goldens are predicted from tier rules**, not computed. A 22-entry
  selector, three colour cells and a `selector` over a numeric roster are all new
  shapes for `push-card-schema`.
- **The fixture surfaces were greped, not read.** `acidwarp` appears in six e2e
  specs and `colourofmagic` in three; I confirmed the appearances and did **not**
  read each spec to classify card-shaped selectors. That is the single largest
  piece of unpaid diligence in this section.
- **`vfpgaRunner`'s mis-disposition is a hypothesis**, from a 0-param def against a
  397-line card. The card's state model was not read.

---

## B11.7 GLYPH RESOLUTION — RUN, NOT REASONED

§23-15's rule is *"a glyph that resolves is not a glyph that reads"*. Every glyph
claim in B11.2-B11.5 was **run through the real resolver**
(`$lib/ui/workflow/shell-glyph-live`) on the live defs, in a scratch vitest inside
`packages/web`.

| def | `primaryAudioOutPortId` | `'meter'` | `'waveform'` | `'envelope'` | `'algorithm'` | `'scope'` |
|---|---|---|---|---|---|---|
| `colourofmagic` | **null** | `static` | `static` | `static` | `static` | `static` |
| `acidwarp` | **null** | `static` | `static` | `static` | `static` | `static` |
| `cvBuddy` | **null** | `static` | `static` | `static` | `static` | `static` |
| `cvBuddyMini` | **null** | `static` | `static` | `static` | `static` | `static` |
| `gatemaiden` | **null** | `static` | `static` | `static` | `static` | `static` |

(`'none'` returns `{kind:'none'}` on all five, as the first arm.)

Three consequences:

1. **All four entries must declare `glyph: 'none'`**, since every non-`none` value
   resolves `{kind:'static'}` and reddens the dead-glyph clause. This is B10.7's
   consequence 4 applied to a whole cohort rather than to its triage remainder.
2. **The reason is the PORT TYPE, and it is two different reasons wearing one
   result.** `colourofmagic` and `acidwarp` declare no `audio` output because they
   are video modules. `cvBuddy`, `cvBuddyMini` and `gatemaiden` declare `gate`
   ports — `gate` is a cable type, not an `audio` output, so `primaryAudioOutPortId`
   correctly finds nothing on a module that is unmistakably in the audio domain.
   ⚠ **`domain: 'audio'` does not imply an audio glyph**, and the same split is
   why `gatemaiden` renders `.faceplate.gate` (B11.5).
3. **This cohort adds NO new witness to §23-15.** §B10.2 found the first glyph that
   resolves *live and blind* (`rasterize`'s `thru`). Nothing here is that; all five
   are the ordinary visibly-resolves-nothing case. Recorded so a future entry on
   any of them does not re-derive it, and so nobody proposes a meter on a `gate`
   port on the grounds that the module is "audio".

⚠ What this still does not prove: nothing about whether a picture MOVES. Both video
picks carry a live canvas whose motion is a *panel* question, not a glyph one — and
for `acidwarp` that motion is precisely why it is VRT-exempt (B11.3).

---

## B11.8 THE COHORT AT A GLANCE

| Q | module | dom | par | bands | why it earns a face, in one line |
|---|---|---|---|---|---|
| **Q50** | `colourofmagic` | V | **37** | 5 | The pool's largest unfaced module — its three packed-RGB palette params resolve to **a knob sweeping 16.7 million values that `faces-parity` PASSES**, its 22 output names live in the card, and a VRT-only `freeze` would ship to players (#2022). First adopter of the `'color'` cell, which has **zero** adopters today. |
| **Q51** | `acidwarp` | V | 5 | 1 | **Blocked by its own VRT exemption** — promotion requires face scenes (FACES ↔ STRICT_FACES is asserted both ways) on a module exempted for nondeterminism, and its `freeze` param halts the scene cycler while **the palette keeps rotating**, which is the actual animation (#2023). |
| **Q52** | `cvBuddy` + `cvBuddyMini` | A | 2 + 2 | 1 | One entry, two modules, one shared body. `ppqn` declares **48 positions where 7 are legal** and nothing rejects the other 41; and **almost everything the card shows is derived-state text a faceplate may no longer paint**, none of it reachable by a param reader (#2024). |
| **Q53** | `gatemaiden` | A | 2 | 1 | **Both of batch 13's silent build bugs in eleven lines** — `trigShape`'s only labels (`△ TRI` / `▭ SQR`) are card-only so a face paints an anonymous switch, and `gateLen`'s `NeonFader` becomes a dial — plus a ledgered raw write the face pays (#2025). |

**Issues filed by this lane:** **#2020** (the §B10 bank instructs three builds to
declare `FaceReadoutValue`, deleted 1809 lines *before* the base it measured —
sibling of #1964) · **#2022** (colourofmagic: three declaration defects) ·
**#2023** (acidwarp: VRT exemption blocks promotion, **prerequisite**; 8 palette
names stranded; `sceneTrig` paintable) · **#2024** (cvBuddy pair: `ppqn` legality;
the VRT hold contradicted by the mini's baseline; the derived-text parity blocker)
· **#2025** (gatemaiden: both build bugs + the ledger entry).

**Build order: Q53 → Q50 → Q51 → Q52.**

- **Q53 `gatemaiden` first** — lowest risk in the program's history, attest-free,
  no baseline, ~11.6 s of CI, and it is the batch's **proof that the spec bar
  catches the two bug classes**. Land it and check the built face against B11.5's
  two findings before spending anything larger.
- **Q50 `colourofmagic` alone in its own PR** — 37 cells, a hero panel, 10 VRT
  scenes, a 31×22 rear field, the `'color'` cell's first adoption, and a
  re-attest.
- **Q51 `acidwarp` after its seed hook** — the seed + `options[]` roster land
  together in ONE re-attest, then the face.
- **Q52 `cvBuddy` pair — land the `options[]` roster now, HOLD the face** until
  #2024's two decisions are answered. The roster is attest-free, contract-free and
  correct regardless.

**CI wall-time, priced at `faces-parity`'s ~`10 s + 0.8 s/cell`:** gatemaiden
11.6 s · colourofmagic ≈ 39.6 s · acidwarp 14 s · cvBuddy + Mini 23.2 s ≈ **88 s
for the wave**, before new face VRT scenes (1 + 5 + 1 + 2 = 9 dock scenes + 9
compact). Under the ~2 min bar as a wave, but ⚠ **do not land Q50 with anything
else**, and estimate each PR's delta before merge.

**BANK AFTER THIS SECTION** (an entry is in the bank when its module is NOT `done`
in `docs/design/face-migration.generated.md`):

| domain | buildable now | held / blocked / in flight |
|---|---|---|
| **audio** | **1** — Q53 `gatemaiden` | Q52 `cvBuddy`+`Mini` (**hold on #2024**) · Q46 `rasterize` · Q47 `wavecel` · Q49 `foxy` (§B10 bank — ⚠ all three carry #2020) · `moog905` (Q21) · `wavesculpt` · `samsloop` (batch 12) · Q48 `synesthesia` (#2004) · `joystick` (#1974) · `scope` / `timelorde` (#1932) |
| **video** | **1** — Q50 `colourofmagic` | Q51 `acidwarp` (**blocked on #2023 item 4**) · Q24 `bentbox` · Q25 `mandelbulb` · Q44 `4plexvid` · Q45 `warrensvisions` · `ruttetra` (#2009) · `grainsOfVision` / `mirrorpool` (#1936) · `quadralogical` (Q27) |

### ⚠ What should change batch 15's ordering

1. **Do the video triage against #1865 FIRST, not against param count.** The four
   highest-param unfaced video modules (`monoglitch` 8, `milkdrop` 8, `reshaper` 6,
   `graphicEq` 5) are all blocked by the `hideControls` gap, and nothing in a def
   or in `face:inventory` shows it. Any triage that ranks by size will keep
   re-discovering them.
2. **The unblocked video bank is real and should be spent next**: `cellshade`,
   `chroma`, `chromakey`, `feedback`, `mandleblot` (6 params each), then
   `peakstate`, `lines`, `lushgarden`, `shapes` (5). None is on #1865's list.
   ⚠ `mandleblot` ≠ the excluded `mandelbulb`.
3. **AUDIO IS EXHAUSTED AT THE TOP END AND THE CADENCE SHOULD REFLECT IT.** After
   exclusions, **every remaining unfaced audio module in `generic-face` has ≤ 4
   params** (`moog992` 4; `dockscope`, `moog904c`, `moog995` 3; then 2s, 1s and two
   0s). The 2-3-audio cadence cannot be met on merit much longer without either
   re-opening the moog cohort or accepting 1-2 param faces. **Raise it rather than
   letting each batch quietly pad.**
4. **`shapedramps` is worth an early look as a QUESTION, not a face**: a
   `generic-face` **video** module with 8 params, 6 outputs and **no canvas** has
   nothing for the mandatory SCREEN ON/OFF switch to attach to, and
   `video-face-screen-source.test.ts` is deny-by-default with only `videoOut`
   exempt. Better answered before a batch depends on it.
5. **`vfpgaRunner` looks mis-dispositioned** — 0 declared params against a 397-line
   card mounting 3 knobs and 2 selects. If that holds it belongs in
   `bespoke-surface`, and the inventory should be corrected rather than the module
   triaged for a generic face each round.
6. **The moog specs §B10 names are not in the primary checkout.** `moog904bc`,
   `moog961-moog984`, `ruttetra-grainsofvision` are cited by §B10 and absent here.
   Until they are on a branch someone can read, nine moog modules are being passed
   over on the strength of a reference nobody can open. **That is the same
   durability problem this file's header is about.**
