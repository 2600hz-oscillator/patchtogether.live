# Faceplate build specs — `ruttetra` and `grainsOfVision`

**2026-08-19. SPEC ONLY. NEITHER MODULE IS CLEARED TO BUILD.**

Both are OWNER DECISION PENDING. Nothing here proposes that anyone start. The
job of this document is to make two decisions cheap by laying out merit, cost
and defects with the evidence attached, so the owner can say yes/no/not-yet
without re-reading two shaders.

Read against `.myrobots/plans/faceplate-queue-2026-08-14.md` §22.5 / §25.3 /
§25.5 (ruttetra) and Q26 (grainsOfVision). **Everything in those entries was
re-verified against the code at HEAD `7445d344`; §0 below lists what did not
survive.** The queue has been wrong before — a recent entry's proposed readout
formula was measured 29 % wrong and an inventory note named the wrong gesture —
so nothing is inherited.

**Figure labels used throughout:**

- **DERIVED-BY-READING** — read out of the source and computed on paper. No test
  was run (this session cannot run vitest in `packages/`).
- **MEASURED-BY-READING** — counted off a committed artifact at this SHA.
  Snapshot of a live list; re-derive at decision time.
- **INHERITED-UNVERIFIED** — a number from a prior session's probe that this
  session could not reproduce. Treat as a hypothesis, not a fact.

---

## §0 — WHAT THE QUEUE GOT WRONG (verify, don't inherit)

Seven claims in the queue entries do not survive contact with the code. Each is
corrected in place below; they are collected here because the pattern matters
more than any one of them.

| # | queue claim | what the code says |
|---|---|---|
| 1 | `grainsOfVision` is "the FIRST video `noUserControl` adopter" | **STALE.** `backdraft` (`video/modules/backdraft.ts:3238-3244`, six entries) and `spirographs` (`video/modules/spirographs.ts:375-385`, one) already declare it. GOV would be the **third**. The mechanism is landed and proven; that is *better* news than the queue's framing, not worse. |
| 2 | GOV's headline readout is "total grains = `density² · aspect`" | **STRUCTURALLY UNBUILDABLE as a face readout.** A `FaceReadoutValue` is `(read: (paramId) => number \| undefined) => string` (`face-readout-values.ts:83`) — it sees **params only**. `aspect` is `ctx.res.width / ctx.res.height` (`grainsOfVision.ts:736`), not a param. A grain-count readout would have to hard-code 4:3 and would print a **33 % wrong number** the moment the output aspect switches — the blind-metric trap, shipped. See §B.5. |
| 3 | GOV trail/tail readouts in **milliseconds** (113 ms / 709 ms / 5.70 s / 11.5 s) | **WRONG UNIT.** Both are per-**frame** gains. Milliseconds require a frame-rate assumption, and this repo's own measurement is 7.9 fps under `E2E_SWIFTSHADER=1` against ~60 fps on a real GPU (CLAUDE.md). A ms readout is a *different number on every renderer* — the exact defect the frames-not-ms rule exists for. **Print FRAMES.** The frame arithmetic is unchanged and is reproduced in §B.5. |
| 4 | ruttetra: declare `face.bareCells` for `tintR/G/B` | **BACKWARDS.** The owner's rule is that a label earns its place *when it disambiguates otherwise-identical controls*. R / G / B are three identical knobs whose captions are the **only** thing separating them — that is tidyVco's `A`/`D`/`S`/`R`, which the owner ruled **STAYS**. The redundancy is the word "Tint", not the letter. See §A.7. |
| 5 | ruttetra's card shape-name table "prints radial over the whole top 8.4 % where the DSP is 75 %..100.2 % of the way there" — offered as a disagreement | **TRUE BUT NOT A DEFECT.** The card's 7 bands are a consistent ±25 %-of-arm rule around each anchor (`linear` gets `[0, 0.083)` = the same half-band at the other end). The real problems are different and both real: the thresholds are **re-typed in the card**, and the DSP's `m = 1` endpoint is **not** the declared radial. See §A.6 / D-2. |
| 6 | ruttetra #1863's endpoint overshoot is a defect to file | **ALREADY PINNED AS CORRECT, WITH A WRITTEN RATIONALE.** `ruttetra.test.ts:63-81` asserts `sf + (radial − sf) · ((1 − 0.666) · 3)` verbatim — *"so the mirror stays bit-faithful to the shader rather than papering over that quirk"* — and `:96-104` pins it again for `morph > 1`. Changing the maths reddens two deliberate assertions and moves a VRT baseline. The **actionable** disagreement is DEF DOCS vs CODE (`ruttetra.ts:305`, "1 = radial"). See D-2. |
| 7 | `grainsOfVision` is "absent from `_face-fixtures.ts`" | **STALE and load-bearing.** `_face-fixtures.ts:459-474` now DERIVES its candidate pool (un-promoted video modules), so promotion drops a module out automatically. But `workflow-shell-video.spec.ts:447-450` names GOV explicitly **because it is un-migrated** — see D-9, the most dangerous item in this document. |

---

## §A — `ruttetra` (`label: 'xyz'`)

`packages/web/src/lib/video/modules/ruttetra.ts` (469 lines) ·
`packages/web/src/lib/ui/modules/RuttetraCard.svelte` (429 lines)

### A.1 STOP 1 — merit

**Verdict: YES ON MERIT — but as a COMPACT, UNTABBED face, which contradicts the
ruling that named it.** See §A.4; that contradiction *is* the owner decision.

DERIVED-BY-READING from the def (`:255-287`):

| | |
|---|---|
| params | 12 (`:275-286`) |
| inputs | 8 — one `video` `z` (`:260`) + seven `cv` (`:263-269`) |
| outputs | 1 — `out`, `type: 'video'` (`:272`) |
| CV coverage | `xShape yShape xDisp yDisp intensity xFreq yFreq` have CV; **`tintR tintG tintB xPhase yPhase` have NONE** |
| `primaryAudioOutPortId` | **`null`** — no `type: 'audio'` output (`shell-glyph-live.ts:95-97`) |

It is well past the `noise` refusal bar (≤2 params, no families, no `node.data`,
no derived quantity). It has 12 params, three `node.data`-backed affordances, and
two genuinely derived quantities nothing in the product prints (§A.5).

**What it is FOR, in one paragraph.** RUTTETRA turns a picture into a
*heightmap*. A 320×180 grid walks the source, reads luma at each point, and
displaces that point by `(lum − 0.5) · disp` — bright pixels push their scanline
out of the plane. Adjacent points within each row are joined into 57,420
additive LINE segments over black. Everything else in the module positions or
colours the raster that displacement acts on. **The verb is *tilt*: you are
sculpting relief out of a flat image.**

### A.2 STOP 2 — the card, read line by line

Grepped and then read. `RuttetraCard.svelte` owns **three** affordances that are
not `ParamDef`s, plus twelve faders:

| affordance | site | survives promotion? |
|---|---|---|
| `<button class="hide-toggle">` → `data.hideControls` | `:225-232` (`toggleHideControls` `:162-174`), testid `ruttetra-hide-toggle` | **NO** — needs a home |
| corner-drag resize → `data.resizedWidth` / `data.resizedHeight` | `:245-251`, `onpointerdown={onResizeStart}` `:250`, handler `:176-193`, testid `ruttetra-resize-handle` | **NO** — needs a home |
| double-click body to restore | `ondblclick={onBodyDblClick}` `:220`, handler `:195-206` | **NO** — needs a home |
| 12 `<NeonFader>` | `:272-293` | yes → `face.order` |
| two shape-NAME spans | `:266-269`, `shapeName()` `:57-66` | yes → `landmarks`, §A.6 |
| live canvas, `blitOutputForPreview(id)` | `:134`, testid `ruttetra-canvas` | yes → `hasVideoSurface` |

No `<select>`, no `<input>`, no `oncontextmenu`, no file loader.

**THE THREE ORPHANS HAVE A HOME, AND IT IS ALREADY WIRED.** The queue treated
this as an open blocker (#1865). It is not. The seam is
`face.extension: '<id>'` → `$lib/ui/modules/<id>/shell-extension.ts` exporting
the **`fullViewBody`** slot, which is in `WIRED_SHELL_EXTENSION_SLOTS`
(`shell-extensions.ts:124`) with **two landed adopters**:

- `backdraft` — `ui/modules/backdraft/shell-extension.ts`, whose header states
  the exact argument this module needs: *"the affordance is not a param… there
  is nothing for a `ParamCellKind` to bind to — and it is the SOLE entry to all
  three, so losing it in promotion would have left the module unable to show its
  own picture."*
- `videoOut` — `ui/modules/videoOut/shell-extension.ts` (#1821), where the slot
  **is** the whole faceplate.

`fullViewBody` is **dock-only** (`dockFullViewHeadPlan`); the lane keeps the
generic `VideoTileThumb`. So promotion **does** cost the resize gesture *in the
lane* — an accepted architectural consequence (a 192 px tile cannot carry a
module surface), not a silent loss, and it must be stated in the PR body.

⚠ **`e2e/tests/video-hide-controls.spec.ts` is a whole spec parameterised over
`'ruttetra' | 'monoglitch'`** (`:81-96`) driving `ruttetra-card` /
`ruttetra-hide-toggle` / `ruttetra-resize-handle` / `ruttetra-controls` /
`ruttetra-canvas`. It runs against the **legacy lane** (default fixture), so
promotion does not redden it — the dock swap is not behind `?shell=1` but the
*lane* swap is. **That is exactly the wrong kind of green:** the spec would keep
passing while the gesture disappears from the surface a workflow-mode user
actually operates. The face PR owes this spec a second leg on the faced dock, or
an explicit written note that it covers only the legacy surface.

### A.3 The ranking argument, from the vertex shader

The whole geometry is four lines (`ruttetra.ts:169-174`):

```
h = shapedRamp(h0 * uXFreq + uXPhase, vec2(h0, v0), uXShape);
v = shapedRamp(v0 * uYFreq + uYPhase, vec2(h0, v0), uYShape);
x = h + (lum - 0.5) * uXDisp;
y = v + (lum - 0.5) * uYDisp;
```

and the colour is one more (`:182`): `vColor = src.rgb * uIntensity * vec3(tintR, tintG, tintB)`.

**`yDisp` is the hero, and the def's own defaults prove it.** DERIVED-BY-READING
from `DEFAULTS` (`:208-224`): every geometry param ships at its neutral value —
`xShape 0`, `yShape 0`, `xDisp 0`, `xFreq 1` (identity), `yFreq 1` (identity),
`xPhase 0`, `yPhase 0` — and **`yDisp` alone ships off-centre at `−0.3`**, with
a comment naming why (`:212-214`, *"the classic 'raised terrain' Rutt-Etra look
out of the box (matches XYZState.swift)"*). The def spent its one non-neutral
default on it.

**The test that this argument would be WRONG for a different module.** On
`mirrorpool` the same argument fails: its defaults are non-neutral across the
whole weather block, so "the one off-centre default" selects nothing. On
`spirographs` it fails differently — `count` ships at 1 and twenty of thirty-one
dials are inert, so the ranking argument there is *inertness*, not *default
offset*. Here it is default offset, and it selects exactly one param.

**The colour path is NOT dead, and a geometry probe cannot see it.** A prior
session's probe reported `intensity` and `tintR/G/B` at `0/154` geometry
movement (INHERITED-UNVERIFIED). Reading the shader settles it without a probe:
`gl_Position` (`:181`) consumes `h, v, lum, xDisp, yDisp` only; `vColor`
(`:182`) consumes `src.rgb, intensity, tintR/G/B`. **The two sets are disjoint.**
Four params move colour and nothing else — DERIVED-BY-READING, and stronger than
the probe because it is a proof rather than a sample.

**Rank order (dock, `face.order`):**

```
yDisp, xDisp, yShape, xShape, yFreq, xFreq | intensity, tintR, tintG, tintB, yPhase, xPhase
```

Tier ladder as a sentence: *at mini you get RELIEF; at compact, relief and its X
partner; at plate, the whole geometry story (relief ×2, shape ×2, frequency ×2);
the beam, the tint and the phase pair are dock-only.*

`order` and `pages` deliberately DISAGREE — `order` interleaves the axes by
priority (Y first, because Y is the relief axis), `pages` groups by idea. Say so
in the comment.

### A.4 ⚠ Pages by FUNCTION — the honest count is **4**, not 6, and NOT 7

The queue said 6. Reading the DSP says fewer, and the ruling forbids inflating
either way.

The recommended grouping, one page per expression in the shader:

| page | controls | the idea, from the DSP |
|---|---|---|
| **relief** | `yDisp`, `xDisp` | the `(lum − 0.5) · disp` term — the module's identity |
| **shape** | `yShape`, `xShape` | `shapedRamp`'s morph argument |
| **scan** | `yFreq`, `xFreq`, `yPhase`, `xPhase` | ⚠ `h0 · uXFreq + uXPhase` is **ONE expression with two terms**, not two ideas |
| **beam** | `intensity`, `tintR`, `tintG`, `tintB` | the whole of `vColor` |

**4 pages, 12 controls, every page ≥ 2 controls, every page one line of shader.**

The queue's 6-page version splits `scan` into `frequency` + `phase` and `beam`
into `beam` + `tint`. Both splits are *arguable*, neither is *derived* — and the
`beam`/`tint` split leaves a **one-control page** (`intensity`), which the skill
allows only when that control is the module's identity. It is not; `yDisp` is.

> **So ruttetra does not land "one short of the rail". Under the grouping the
> DSP supports it lands THREE short, and under the most generous defensible
> grouping it lands one short. The owner's named first tabbed face is the
> WEAKEST tab candidate in the video bank.**

⚠ And a 4-band untabbed face is the *right* outcome by a second, independent
rule. `dock-row-plan` packs consecutive bands to `DOCK_ROW_MAX_CONTROLS = 10`,
so `(2+2)(4+4)` is **two rows** — a genuinely compact plate, which is what
*"we do not want useless gray horizontal space on cards, ever"* asks for. Forcing
a rail here would trade a compact 2-row plate for four clicks.

**MEASURED-BY-READING — the price of lowering the threshold.**
`dock-tabs-model.ts:57` sets `DOCK_TAB_MIN_BANDS = 7`, and its header says
lowering it *"MOVES EVERY DOCK BASELINE it newly captures — do it in its own PR,
with the regen."* §25.5 said *"count them before quoting a price"*. Counted, off
the `FACES` roster in `e2e/vrt/_shell-faces.ts` at this SHA:

| declared `pages` | faces | effect of 7 → 6 |
|---|---|---|
| **6** | **3** — `cube` (`:166`), `cofefve` (`:293`), `marbles` (`:314`) | newly railed → **3 dock baselines move** |
| 7 | 1 (`:937`) | already railed |
| 8 | 2 (`cloudseed` `:32`, `pentemelodica` `:124`) | already railed |
| 10 | 2 (incl. `spirographs` `:232`) | already railed |

So `7 → 6` costs **three** re-captured dock baselines and does **not** reach
ruttetra at 4 pages. A threshold that reached ruttetra would have to be 4, which
would rail most of the bank.

### A.5 Readouts — two, each with a permanent negative control

Hero readouts (`face.hero.readouts`, `FaceReadout` `graph/types.ts:986-998`) are
a labelled row **below the graphic** and are untouched by the
no-resting-decimals ruling, which targets the per-knob decimal. Both proposed
readouts are joins of two or more dials.

**R1 · `relief` — how far a bright pixel actually moves.**
`(lum − 0.5) ∈ [−0.5, 0.5]`, so peak displacement is `0.5 · |disp|` of the frame
in each axis. DERIVED-BY-READING: at the shipped `yDisp = −0.3, xDisp = 0` the
answer is **±15 % of frame height, 0 % of width**. Print as a percentage, never
pixels — pixels are `VIDEO_RES`-dependent and the output aspect switch changes
them.

> **PERMANENT NEGATIVE CONTROL:** hold `yDisp` and sweep `xDisp` 0 → 1. `relief`
> must move. A `yDisp` readback — the obvious implementation, and the one a
> reviewer's "does it move when I turn the relief knob?" check passes — is
> **blind** to it. Second leg: `intensity` 0 → 2 must move it **not at all**
> (the disjoint-sets proof in §A.3 is what makes that assertion meaningful).

**R2 · `span` — how much of the frame the raster actually covers.**
The finding this readout exists for, and nothing in the product says it:

> ⚠ **DERIVED-BY-READING: at `xFreq < 1` the entire raster is squeezed into a
> FRACTION of the frame.** With `xShape = 0, xPhase = 0`, `h = fract(h0 · xFreq)
> = h0 · xFreq` for `h0 ∈ [0,1]`, so at the declared minimum `xFreq = 0.25` the
> whole picture occupies the **left quarter** of the output; `yFreq = 0.25` puts
> it in the **top quarter**. The docs (`:313-314`) describe only the `> 1`
> direction — *"higher values repeat/fold the scan pattern across the width"* —
> and say nothing about the bottom three-quarters of the dial.

Compute it by importing the def's **own exported `shapedRamp`** (`:75`) and
sampling `h`/`v` over a fixed grid at the live `shape`/`freq`/`phase` — the
`spirographs-face-model.ts` pattern (`:33-36`, *"imported from `spirographs-math`
— the same functions `sampleSpiro` and the draw path call — rather than
re-implemented here"*). Never re-derive the span in closed form: it is only
`min(1, freq)` at `shape = 0`.

> **PERMANENT NEGATIVE CONTROL:** hold `xFreq = 1` and move `xShape` 0 → 1. The
> span must MOVE (radial's span is uv-dependent, not `t`-dependent). A
> frequency-only readback is blind to it. Second leg: `xDisp`/`yDisp` must move
> it **not at all** — displacement moves the picture, not the ramp's span.
> Totality leg: fresh node, `NaN`, `±Infinity` (`face-readout-values.ts:80` — a
> throw takes the faceplate down mid-drag).

**Rejected readouts, with reasons:** a grid-point or segment count is a constant
(`RUTTETRA_GRID`, `:241`). A flyback count would be a readout of a defect (D-1)
that dies when the defect is fixed. The shape name is a *landmark*, not a hero
readout — see next.

### A.6 The shape name: `landmarks`, not a ported table

`RuttetraCard.svelte:57-66` re-types seven thresholds (`0.083 / 0.25 / 0.416 /
0.583 / 0.75 / 0.916`) that appear nowhere in the def. A def-driven face would
lose the name entirely, and porting the table would ship the same re-typed
mapping with fresh paint.

**The landed mechanism is `ParamDef.landmarks` (PF-10), and its type comment
describes ruttetra exactly** (`graph/types.ts:402-406`): *"A NAMED WAYPOINT on a
CONTINUOUS param — for a param that MORPHS through its range rather than
switching between states (qbrt `mode`, lfo `shape`)."* `knobNameReadout`
(`knob-vocabulary-model.ts:138-144`) paints the **nearest** landmark's label,
and `paintsReadout` (`:114-116`) is true because neither shape param declares a
`format`. So the name survives the no-resting-decimals ruling **by name** — it
is a state name, not a decimal.

Declare landmarks at the DSP's **own** arm anchors, which the def's header
already names (`:70-73`):

```
landmarks: [
  { value: 0,     label: 'linear'   },
  { value: 0.333, label: 'triangle' },
  { value: 0.666, label: 'soft'     },
  { value: 1,     label: 'radial'   },
]
```

Nearest-match puts the boundaries at `0.1665 / 0.4995 / 0.833` — derived from the
shader's arms rather than re-typed. Cost: `landmarks` is **not** in
`serializeModuleContract` (the param line is `param <id> <min>..<max> <curve>
default=<v>`, `contract-signature.ts:270`) so **no `docs:accept`**; but it *is*
real code in a video def, so it **does** flip `computeWebglHash` — see §A.9.

### A.7 `bareCells`: DO NOT declare it (correcting the queue)

`face.bareCells` drops the caption TEXT while keeping the accessible name
(`shell-control-kind.ts` `bareCaptionParamIds`, and `NeonFader`'s `hideCaption`
prop at `:135-143`). Applied to `tintR/G/B` it would leave **three identical
knobs with no visible distinction** — the precise case the owner ruled must KEEP
its labels (tidyVco's `A`/`D`/`S`/`R`). mixmstrs' `1LO…8LO` are redundant with a
`LOW` heading; `R`/`G`/`B` under a `beam` heading are not.

The genuine redundancy is the word **"Tint"** in the def labels (`:280-282`
`'Tint R' / 'Tint G' / 'Tint B'`) under a page already called *beam*. The right
fix is shortening the **labels** to `R`/`G`/`B` — `ParamDef.label` is not
contract-projected (`contract-signature.ts:270`), so no `docs:accept`; it is real
code, so it costs the same attest as any other def edit (§A.9). It also aligns
the def with the card, which already passes `label="R"` (`:281`).

### A.8 SCREEN ON/OFF, and the gap the ruling has today

The mechanism the ruling names is spirographs' (`592ca4f6b`), and it is
verified in place:

- state in `node.data.previewCollapsed`, absent ⇒ ON
  (`SpirographsCard.svelte:148-157`) — survives tab switch, remount, reload, and
  syncs to collaborators;
- **overlay**, bottom-right, `position: absolute; right: 2px; bottom: 2px`, on a
  `rgba(5, 6, 8, 0.72)` backplate (`:365-378`) — the backplate exists because a
  transparent button over a live picture was never legible;
- `min-height: 16px` on the wrap (`:362-364`), inert behind the canvas and
  load-bearing only with SCREEN off;
- **zero height delta** — the stacked row cost ~18.8 px against ~11 px of slack
  and `io-spec-consistency` caught a 7.8 px overhang (`:348-360`).

⚠ **AND THE GAP: `previewCollapsed` EXISTS ONLY ON CARDS. The shell has no
SCREEN affordance at all.** Grepped: it appears in exactly
`SpirographsCard.svelte`, `backdraft/BackdraftOutputBody.svelte` and a
`VideoOutCard.svelte` comment — **zero** references in `ModuleShell.svelte` or
anywhere under `ui/workflow/`. All three of those modules are in `STRICT_FACES`
(`strict-faces.ts:848`, `:1802`, `:1833`).

backdraft and videoOut are fine, because their toggle rides inside a
`fullViewBody` shell extension. **spirographs is not**: its SCREEN switch lives
on `SpirographsCard.svelte`, which the dock full view no longer renders
(`DockFullView.svelte:319`). See D-8.

**So for ruttetra the SCREEN switch, the resize handle and the double-click
restore are ONE piece of work, in ONE place** — a `ruttetra` shell extension
declaring `fullViewBody`, modelled on `backdraft/shell-extension.ts`. That is
also the honest cost: a face here is *not* a pure declaration.

### A.9 Costs

| item | `docs:accept`? | WebGL attest? |
|---|---|---|
| `face` (order/pages/hero/glyph/bareCells/paramCells) | no — `FACE_FIELDS_NOT_IN_LOCK` | **no** — `face` is in `HASH_TRANSPARENT_PROPS` (`scripts/attest-code-basis.ts:96-99`) |
| `face.sidebar` | **YES** (`contract-signature.ts:142`) | no |
| `landmarks` on `xShape`/`yShape` (§A.6) | no (not projected) | **YES** — real code in `lib/video/`, flips `computeWebglHash` |
| shortening `Tint R` → `R` (§A.7) | no (`label` not projected) | **YES** — same reason |
| a `ruttetra` shell extension | no | no — it lives under `ui/modules/`, outside the WebGL basis |

⚠ **A video face is NOT attest-free the moment it touches the def outside
`face`/`docs`/`controlFamilies`/`noUserControl`.** Batch the two def edits above
into ONE commit so the real-GPU re-attest is paid once, and attest the **merged**
tree, not the branch tip.

`glyph` **must** be `'none'`: `primaryAudioOutPortId(ruttetraDef)` is `null`
(no `audio` output), so every other literal falls through `glyphBinding` to
`{kind:'static'}` and reddens the dead-glyph clause. The picture arrives from
`hasVideoSurface(def)` = `domain === 'video'` (`module-shell-model.ts:177-179`).
**Assert `hasVideoSurface`, not the declaration** — `'none' + blank tile` and
`'none' + live thumb` are indistinguishable from the declaration alone.

### A.10 Risk

**MEDIUM.** No `pullExempt` and no stateful ring, so nothing freezes (§C). One
`fullViewBody` extension to author. Two look-affecting defects that should land
as their own owner-preview PR *before* any face, so the VRT re-baselines once
(D-1, D-2). ⚠ ruttetra **has a real VRT scene whose canvas is diffed**
(`vrt-scenes.ts:354-361`; the mask at `vrt-exemptions.ts:158-160` is a
NO-SCENE FALLBACK the scene overrides) — **so the current baseline pins the
flyback streaks as correct.**

---

## §B — `grainsOfVision`

`packages/web/src/lib/video/modules/grainsOfVision.ts` (914 lines) ·
`packages/web/src/lib/ui/modules/GrainsOfVisionCard.svelte` (238 lines)

### B.1 STOP 1 — merit

**Verdict: YES ON MERIT, and it is the stronger of the two — but its page count
is marginal against the rail (§B.4), so it inherits the same owner question.**

DERIVED-BY-READING from the def (`:539-589`):

| | |
|---|---|
| params | 20 (19 user-facing + `freeze`) |
| inputs | 19 — `in_a`, `in_b` (`:541-542`) + 17 `cv` (`:545-561`) |
| outputs | 2 — `out` and `grains`, **both `type: 'video'`** (`:564-565`) |
| `primaryAudioOutPortId` | **`null`** — no `audio` output ⇒ `glyph: 'none'` mandatory, same as ruttetra |
| `resize()` | **IMPLEMENTED** (`:872-886`) — see below |

**`resize()` is implemented, and it is the pattern to cite.** `mandelbulb` does
not implement one (a filed defect, #1921); GOV rebuilds every target — history
ring, grains, feedback, `revTmp`, both ping-pongs — and resets `head`,
`framesElapsed`, `outFront`, `revFront`. ⚠ Which is also a finding: **the output
aspect switch WIPES the feedback trails, the reverb tail and the frame-history
ring** (`:883`), and nothing in `docs` says so (D-7).

**What it is FOR.** Granular synthesis, applied to a picture, with a real
temporal axis. A grain is a windowed patch sampled at a jittered *position* AND
a jittered *moment* from an 8-frame history ring, scattered into the output. Its
siblings shatter or smear space; **this one is the only video module in the bank
that grains TIME** — and then runs the result through a feedback block and a
genuine video reverb on one fixed chain. **The verb is *scatter*.**

### B.2 STOP 2 — the card, read line by line: CLEAN

`GrainsOfVisionCard.svelte` in full:

- one 176×132 canvas, `blitOutputForPreview(id)` (`:63`), testid
  `grainsOfVision-preview` (`:143-149`);
- 19 `<NeonFader>` from a `SECTIONS` table of 7 / 5 / 5 / 2 (`:108-128`,
  rendered `:158-169`);
- four section headings (`:155`);
- one card-local `formatValue={formatComp}` on `composite` only (`:41-43`,
  `:165`), reading `GOV_COMPOSITE_MODES`.

**No `<button>`, no `<select>`, no `<input>`, no drag handler, no
`oncontextmenu`, no `node.data`, no fullscreen menu.** Nothing is orphaned by
promotion.

Two things the card does **right** that the face must not lose: it reads
`pmin`/`pmax`/`pdef`/`pcurve` **off the def** (`:32-37`) rather than re-typing
ranges — unlike `RuttetraCard.svelte`, which re-types all twelve (they currently
agree, but `card-def-agreement` is the only thing checking, and `RANGE_BOUND_CARDS`
does not list it).

Two genuine gaps a face would close:

- ⚠ **`grains`, the second video output, has NO on-card view.** The card blits
  only the primary surface. The engine has the exact API —
  `blitOutputPortForPreview(nodeId, portId, opts)` (`engine.ts:1657`), the
  gated per-PORT sibling of the preview blit — and the handle already resolves
  it (`read('outputTexture:grains')`, `:907`). **A `fullViewBody` extension is
  the first surface that could show it.** Merit, in the same shape as
  spirographs' `mono_out`/`overlap`.
- ⚠ **ALL 19 CARD CONTROLS ARE DEAD TO CV.** `NeonFader` takes
  `readLive?: () => number | undefined` (`:121`, *"Motorized read — polled per
  rAF while idle, so CV visibly moves it"*) and the card passes it nowhere. A
  CV-driven `density`/`rate`/`feedback` moves the picture while every fader
  stays parked. **A face binding `readLive` FIXES A LIVE DEFECT** —
  and the same is true of `RuttetraCard.svelte`'s twelve.

### B.3 `noUserControl` — `freeze`, and the declaration is sound

`freeze` (`:588`) is `0..1 linear`, default 0, and `draw()` returns early at
`>= 0.5` (`:709`). Its own doc says *"hidden determinism toggle… No card
control."* (`:638`), and the card comment agrees (`:9`).

`writer: 'internal'` is the correct arm and **it is checked against the def's own
ports in both directions** (`no-user-control.ts:117-125`): the entry is red if
any input declares `paramTarget: 'freeze'`. None does — the def says so
explicitly at `:544` (*"No CV for the two dry toggles or freeze (hidden), like
BACKDRAFT"*). Verified against the port list.

**Cost: ZERO attest, ZERO `docs:accept`.** `'noUserControl'` is the fourth entry
in `HASH_TRANSPARENT_PROPS` (`scripts/attest-code-basis.ts:96-109`), added by
#1726 with the reasoning spelled out: *"every video def sits in the WebGL attest
basis, so a property that stayed in the hash would make declaring one cost a
real-GPU re-attest that CI (SwiftShader) cannot run."*

The `why` must clear `NO_USER_CONTROL_WHY_MIN = 24` chars and not be a
placeholder. Model it on spirographs' (`spirographs.ts:379-383`).

Consumers that change behaviour the moment it is declared
(`no-user-control.ts:19-42`): the group instrument-bar auto-expose stops
offering it; the Push 2 card ranking refuses it; face-lint completeness accepts
it unranked; **dock render-plan parity inverts to require EXACTLY ZERO cells**;
faces-parity asserts the DOM twin.

### B.4 ⚠ Pages — the honest count is **6**, with ONE defensible 7th

By the DSP's own blocks (`:739-861`) and the sub-ideas inside the grain pass:

| page | controls | n | the idea |
|---|---|---|---|
| grain | `density`, `grain_size`, `window` | 3 | what a grain IS — how many, how big, what edge |
| scatter | `spray`, `orient` | 2 | the randomisation of position and angle |
| **time** | `rate`, `time_spray` | 2 | **the temporal axis — the module's identity** |
| feedback | `feedback`, `fb_decay`, `fb_dry` | 3 | how much of the previous OUTPUT returns |
| reverb | `rev_mix`, `rev_size`, `rev_decay`, `rev_diffuse`, `rev_dry` | 5 | the diffuse decaying accumulator |
| composite | `composite`, `comp_amount` | 2 | how B modulates A |

**= 6 pages, 17 controls.** The remaining two, `fb_zoom` and `fb_rotate`, are
the **defensible 7th**: the def's own header separates them from the mix
(*"geometrically transformed a little each pass so the transform COMPOUNDS
(tunnels/spirals)"*, `:36-38`) and they are a different question — *how much
comes back* vs *what happens to it on the way*. Folding them into `feedback`
gives a 5-control page and **6 bands**; splitting them gives **7 bands and the
rail**.

> ⚠ **DO NOT LET THE THRESHOLD DECIDE THAT SPLIT.** A 7th page authored because
> `DOCK_TAB_MIN_BANDS` is 7 is precisely the padding the ruling forbids. The
> split is defensible on its own merits or it is not; if the owner wants a rail,
> the honest lever is the threshold, not the grouping.

`face.order` = the hero first, then page order:
`rate, time_spray, density, grain_size, spray, window, orient | feedback,
fb_decay, fb_zoom, fb_rotate, fb_dry, rev_mix, rev_size, rev_decay, rev_diffuse,
rev_dry, composite, comp_amount`.

**The ranking argument, and the test that it is wrong elsewhere.** `rate` is the
hero because it is the only control in the video bank that reaches into a frame
*history*; every other granular knob (`density`, `spray`, `window`, `orient`)
has a spatial analogue in `bentbox`, `cellshade` or `chroma`, and `feedback` /
`reverb` have one in `backdraft`. **`rate` is the only thing GOV does that none
of its siblings do.** On `backdraft` this argument selects nothing — its
identity is the feedback geometry, and its `delay` is a *consumer* of the same
idea rather than the module's point.

⚠ **But `rate` ships at `0.15`, one frame deep** (`:280`), i.e. barely on. So
the hero is a control that is *nearly* inert at spawn — which is the reason the
`smear` readout below is the most valuable thing on this faceplate.

### B.5 Readouts — three, each a genuine join, each with a permanent negative control

**R1 · `smear` — the one that exposes a bit-exact inertness.**

`govDelayFrames(rate) = clamp(round(clamp01(rate) · 7), 0, 7)` (`:155-157`).
DERIVED-BY-READING: `rate < 1/14 ≈ 0.0714` ⇒ **0 frames**, a hard no-op;
`0.15` (default) ⇒ `round(1.05)` = **1 frame**; `0.5` ⇒ 4; `1.0` ⇒ **7 frames**,
the ring's full depth (`GOV_HISTORY_FRAMES = 8`, `:79`).

And in that no-op zone, `time_spray` is **bit-exactly inert**: `tfrac` is
hard-zeroed when `!pastEnabled` in both the mirror (`:173-176`) and the GLSL
(`:406`), and `pastEnabled` also requires `framesElapsed >= delayFrames`
(`:732`). Neither the card nor `docs.controls.time_spray` (`:622`) mentions it.

Print `smear = time_spray × delayFrames` **frames**, printing `0 (live)`
whenever `delayFrames === 0`.

> **PERMANENT NEGATIVE CONTROL:** set `time_spray = 1` and `rate = 0.05`. The
> readout must print **`0 (live)`** while the T-Spray dial reads its maximum. A
> `time_spray` readback prints 1 and is confidently wrong. Second leg: at
> `rate = 1`, sweeping `time_spray` 0 → 1 must move it 0 → 7.

**R2 · `trail` — frames, not milliseconds (§0 #3).**

Per-frame feedback gain is `g = clamp(feedback, 0, 0.98) · clamp01(fb_decay)`
(mirror `:197-199`, GLSL `:435`). Frames to −60 dB = `ln(10⁻³) / ln(g)`.
DERIVED-BY-READING:

| `feedback` × `fb_decay` | g | frames to −60 dB |
|---|---|---|
| 0.4 × 0.9 (**shipped**) | 0.36 | **6.8** |
| 0.7 × 0.9 | 0.63 | 14.9 |
| 0.98 × 1.0 (max) | 0.98 | **341.9** |

> **PERMANENT NEGATIVE CONTROL — and it doubles as the toggle-defect probe:**
> set `fb_dry = 1`. The readout must print **`off`** while `feedback` and
> `fb_decay` still read 0.4 / 0.9. A `feedback`-only readback prints a trail
> over a bypassed block. Second leg: `fb_zoom` 0.8 → 1.2 and `fb_rotate`
> −20 → 20 must move it **not at all** — they change *where* the echo goes, not
> how long it lasts.

**R3 · `tail` — and it must print the DEFECT, not hide it.**

Per-frame reverb gain is `clamp(rev_decay, 0, 0.99)` alone (mirror `:204`, GLSL
`:460`). DERIVED-BY-READING: `0.85` (shipped) ⇒ **42.5 frames**; `0.99` (max) ⇒
**687.4 frames**.

⚠ At `rev_dry ≥ 0.5` or `rev_mix = 0` the reverb block is skipped
(`govReverbIsDry`, `:213-215`) — **and `revFront = revNext` sits INSIDE the wet
branch only (`:860`), so the tail is FROZEN, not decayed** (D-5). The readout
must therefore print **`held`**, not `off`, in that state. A readout that says
`off` would certify the bug.

> **PERMANENT NEGATIVE CONTROL:** `rev_size` 0 → 1 and `rev_diffuse` 0 → 1 must
> move `tail` **not at all** (both are spatial); `rev_decay` 0.85 → 0.99 must
> move it 42.5 → 687.4. Third leg: `rev_dry = 1` ⇒ `held`.

**Totality leg for all three** (`face-readout-values.ts:80`): fresh node,
missing params, `NaN`, `±Infinity` — the function runs on every render and a
throw takes the faceplate down mid-drag.

**REJECTED — and the rejection is the finding.**

- ❌ **The grain COUNT.** See §0 #2. `aspect` is not a param. DERIVED-BY-READING
  it would be `density² · aspect`: at `density = 14` that is ≈ **261** at 4:3
  (`VIDEO_RES = 1024×768`) and ≈ **348 (+33 %)** at 16:9. A readout that assumed
  4:3 would be wrong by a third in the other mode, silently. *The docs should
  say it (`:619` currently says only "grains across the frame"); the faceplate
  structurally cannot.*
- ❌ **The spray RATIO**, for the same reason it is interesting. Grain-centre
  jitter is `±spray · 0.5 · cellSize` in aspect-corrected space (`:372`,
  `GOV_SPRAY_SCALE`); source-read scatter is `±spray · 0.32` in **UV** (`:394`,
  `GOV_SRC_SPRAY_SCALE`). `spray` cancels, so DERIVED-BY-READING the vertical
  ratio is exactly **`0.64 × cells`** — **1.28× at `density = 2`, 8.96× at the
  shipped 14, 30.7× at 48.** ⚠ The queue quoted a fixed "~12×"; **the ratio is
  not fixed, it scales linearly with DENSITY**, so at low density the two
  scatters are comparable and at high density the read scatter dominates by 30×.
  That is a docs fact, not a readout — it needs `cells`, and it is one dial's
  function once `spray` cancels.

### B.6 `curve` and `options` — sort the three "linear booleans" deliberately

`looksLikeToggle(p)` is `p.curve === 'discrete' && p.min === 0 && p.max === 1`
(`graph/group-controls.ts:54-56`). `paramCellKind` (`shell-control-kind.ts:264-272`)
returns `'toggle'` only for that shape; `'linear'` falls through to `'knob'`, and
`NeonFader.fracToValue` rounds **only** for `curve === 'discrete'`.

| param | declared | consumed as | face renders |
|---|---|---|---|
| `fb_dry` (`:579`) | `0..1 linear` | `fbDry >= 0.5` (`:219`) | **continuous rotary over a 2-state value** |
| `rev_dry` (`:584`) | `0..1 linear` | `revDry >= 0.5` (`:214`) | **same** |
| `freeze` (`:588`) | `0..1 linear` | `>= 0.5` (`:709`) | n/a — `noUserControl` |
| `composite` (`:585`) | `0..4 discrete`, **no `options[]`** | `round()` (`:737`) | **a bare `0..4` knob** |

**The cost asymmetry the brief asked about, verified:**

- `curve: 'linear'` → `'discrete'` on `fb_dry`/`rev_dry` **IS contract-projected**
  — `contract-signature.ts:270` emits `param <id> <min>..<max> <curve>
  default=<v>` — so it costs **`task docs:accept` AND a real-GPU re-attest**.
- `options[]` on `composite` is **NOT** projected (no `options` anywhere in
  `contract-signature.ts`) — so **no `docs:accept`**, but it **is** real code in
  a video def, so it still costs a **re-attest**.

Both are worth doing and both should land in ONE commit so the GPU is paid once.
`options[]` from `GOV_COMPOSITE_MODES` (`:100`) gives 5 states ≤
`SEGMENTED_MAX_OPTIONS = 6`, so the dock paints a `<Segmented>` named button row
and the lane paints a knob with a name readout — `paintsReadout` is true because
`composite` declares no `format` (the card's `formatComp` `:41-43` is card-local
and dies with the card). Note the deliberate precedence: **`options` outranks
`looksLikeToggle`** (`shell-control-kind.ts:242-248`).

⚠ **AND A CV FACT NO DIAL SHOWS.** `composite`'s CV is `cvScale: { mode:
'discrete' }` (`:560`), and the discrete branch of `scaleCv`
(`cv-scale.ts:~86-92`) is `round(min + ((cv + 1) / 2) · span)` — **the knob term
is absent**. DERIVED-BY-READING: a cable at 0 V selects mode **2 (displace)**,
not the dial's 1; and **while that cable is patched the Comp control is
completely inert**, because the CV *replaces* the value rather than offsetting
it. On a face that renders `composite` as a named button row, a patched CV makes
the buttons lie.

### B.7 Params inert at spawn

DERIVED-BY-READING from `GRAINS_OF_VISION_DEFAULTS` (`:275-296`) and `compActive`
(`:737` — `inB ? round(clamp(composite, 0, 4)) : 0`):

- **With only A patched — the documented mono-source case — `composite` and
  `comp_amount` are bit-exactly inert**, along with their two CV ports. `docs`
  states it (`:611`, `:636`); the card does not, and a def-driven face would
  render two live-looking cells over a dead block. Not the scale of
  `quadralogical`'s twelve, but the same class — and the `composite` page is
  where a hint earns its keep.
- `fb_zoom = 1.0` and `fb_rotate = 0` ship at **identity** (`:285-286`), so the
  feedback transform is a pure decay at spawn. By design, but it means the
  defensible-7th-page split (§B.4) puts two identity-valued controls on their own
  page.
- `rate = 0.15` is one frame — see §B.4's hero caveat.

### B.8 SCREEN ON/OFF and the second output

Same answer as ruttetra (§A.8): a `grainsOfVision` shell extension declaring
`fullViewBody`, modelled on `backdraft/shell-extension.ts`, carrying

1. the SCREEN switch — overlay, bottom-right, `rgba(5,6,8,0.72)` backplate,
   `node.data.previewCollapsed`, **zero height delta**; the stacked row is the
   named anti-pattern;
2. the **GRAINS tap view**, via `blitOutputPortForPreview(id, 'grains')`
   (`engine.ts:1657`) — the merit argument of §B.2.

⚠ **AND THE PLATFORM WARNING THIS MODULE EXISTS TO CARRY — SEE §C. On this
module, SCREEN OFF is not free.**

### B.9 Risk

**MEDIUM-HIGH.** Two def edits that cost a real-GPU re-attest. A `fullViewBody`
extension. A stateful DSP that stops when nobody looks (§C). **No VRT baseline
is pinned** — `vrt-exemptions.ts:468` holds it *"pending owner look-approval
(look-affecting WebGL granular video)"*, canvas masked at `:269-270`, and it is
in `ALLOWED_PERMANENT_EXEMPT` (`:1039`). **So this face's baselines are an
owner-look gate, not a mechanical capture.** And D-9 is a green-and-blind hazard
that must be fixed *in the same PR*.

---

## §C — THE PLATFORM WARNING (applies to EVERY video face)

**A faceplate that stops blitting stops the module's DSP.** Verified end to end:

1. `blitOutputForPreview` calls `this.markWatched(nodeId)` **after** the gate —
   *"a refused frame is not an observation"* (`engine.ts:1626-1632`).
2. `markWatched` records the node as a pull ROOT for `WATCH_TTL_MS = 1500`
   (`:674`, `:997-999`).
3. `isPullRoot` (`:1096-1103`) returns false once the mark ages out, unless the
   node holds a render LEASE or is pull-EXEMPT.
4. `isPullExempt` (`:1123-1130`) is true only for `audioSources` / `audioInputs`
   / `subscribePulse` / a def-level `pullExempt`. **Neither module has any** —
   GOV's handle is `domain/surface/setParam/readParam/read/dispose` (`:895-912`),
   ruttetra's likewise (`:453-467`), and neither def declares `pullExempt`. GOV
   says so on purpose (`:535-538`).
5. `isPullEvalOn()` defaults **ON** (`pull-eval.ts:73`).

**Consequences, and they differ sharply between the two modules:**

- **ruttetra: HARMLESS.** `draw()` re-renders from scratch every frame — no ring,
  no ping-pong, no accumulator. Skipping draws costs nothing; re-observing paints
  the current frame.
- **grainsOfVision: NOT HARMLESS.** The 8-frame history ring, `framesElapsed`,
  the output ping-pong and the reverb ping-pong all pause. Re-observing resumes
  from the *paused* state: the trails and the reverb tail come back at full
  strength and the history ring hands out frames from before the pause — a
  temporal jump-cut. **This is the card-unmount-kills-node-resources class
  (#1531/#1574/#1583) reaching a module through its RENDER path rather than its
  lifecycle.**

⚠ **AND A CLAIM THE CODE DOES NOT HONOUR.** `SpirographsCard.svelte:256` tells
the user *"The module goes on rendering either way"*, and its code comment
(`:161-163`) says *"the ENGINE goes on rendering — this only stops the copy"*.
**When the card's blit is the node's only observer, that is false** by steps 1-5
above. It is *conditionally* true — a visible lane `VideoTileThumb` also blits —
but the condition is unstated. Copying that sentence onto a GOV faceplate would
be actively misleading. See D-6.

**Both specs owe a permanent leg on this**, and the shape is prescribed by
CLAUDE.md: put the accumulator IN THE PAGE, never a Playwright-side poll loop,
and report `samples` / `elapsedMs` / the values seen. The engine already exposes
the deterministic probe — `pullStats()` (`engine.ts:1043-1058`, returning
`framesDrawn` / `evaluated` / `skipped` / `cardVisible` / `leased`), which is
exactly what `workflow-shell-video.spec.ts:522-529` uses.

**MEASURE BEFORE BUILDING, in this order:** (1) `framesDrawn` for a GOV node
with SCREEN OFF and no downstream sink, across > 1500 ms; (2) the same with a
lane tile on screen; (3) whether the face's dock hero blit marks it watched.
Establish the real behaviour before deciding whether the SCREEN switch needs a
render lease (`acquireRenderLease`, `engine.ts:1022-1034`) on this module.

---

## §D — DEFECT REGISTER

All DERIVED-BY-READING at HEAD `7445d344`. **No issues were filed** (this
session is barred from `gh`); the owner or a follow-up agent must file them.

**D-1 · ruttetra — the end-of-row FLYBACK.**
`ruttetra.ts:141` — `h0 = col / (cols − 1)`, so the last column of every row has
`h0 = 1.0` exactly. At the shipped `xFreq = 1, xPhase = 0, xShape = 0`,
`shapedRamp` returns `fract(1.0) = 0` (`:76`), snapping that point back to
`x = 0`. **DERIVED-BY-READING: 180 of 57,420 segments** (index count
`2 · 319 · 180 = 114,840` ⇒ 57,420 segments, `:229-239`) **span 0.9969 of the
frame width — one per row.** It scales as the number of integer crossings of
`h0 · xFreq`: **360 at `xFreq = 2`, 1440 at `xFreq = 8`, and 0 at `xFreq = 0.25`**
(the ramp never reaches 1). Independently on Y: row 179 has `v0 = 1.0`, so
**the bottom scanline is drawn at the TOP of the frame**. ⚠ The current VRT
baseline (`e2e/vrt/__screenshots__/vrt.spec.ts/ruttetra.png`, scene
`vrt-scenes.ts:354`) **contains the streaks, so it pins the defect as correct.**

**D-2 · ruttetra — `Shape = 1` is not the declared "radial", and the docs are
the actionable half.**
Arm 3 of `shapedRamp` is `sf + (radial − sf) · ((m − 0.666) · 3)` (`:88`); at
`m = 1` the coefficient is **1.002**, an extrapolation 0.2 % past the endpoint.
DERIVED-BY-READING the residue: `result = radial · 1.002 − sf · 0.002`, so with
`sf ∈ [0,1]` the deviation reaches **0.002 of a frame = 2.05 px at 1024 wide**,
and at the frame CENTRE (`radial = 0`) it goes **negative**. Knock-on:
`xFreq`/`xPhase` should be bit-exactly inert at `Shape = 1` (radial has no `t`
term) and instead carry that residue. ⚠ **`ruttetra.test.ts:63-81` and `:96-104`
pin this as correct on purpose** (*"bit-faithful to the shader rather than
papering over that quirk"*), so "fixing" the maths reddens two deliberate
assertions and moves the baseline. **The cheap, correct fix is the DOCS**
(`ruttetra.ts:305-306`, *"1 = radial (distance from center)"*), which state
something the code does not do. Two prices, one owner call.

**D-3 · ruttetra — `Freq < 1` compresses the raster into a fraction of the
frame, undocumented.**
`h = fract(h0 · xFreq)` with `xFreq` declared down to **0.25** (`:283-284`).
DERIVED-BY-READING: at `xFreq = 0.25` the whole picture occupies the **left
quarter** of the output; `yFreq = 0.25` the **top quarter**. `docs.controls`
(`:313-314`) documents only the `> 1` direction. Three-quarters of the dial does
something the documentation does not mention. (Not a bug in the DSP — the ramp is
doing exactly what it says — but a real docs gap, and the reason readout R2
exists.)

**D-4 · grainsOfVision — TWO genuine user booleans declared `curve: 'linear'`.**
`fb_dry` (`:579`) and `rev_dry` (`:584`) are consumed as `>= 0.5` (`:214`,
`:219`) but declared `linear`, so `looksLikeToggle` is false and they paint as
continuous rotaries over two-state values. ⚠ **And the card's own comment
(`GrainsOfVisionCard.svelte:106-107`) claims *"fb_dry / rev_dry render as 2-step
DRY toggles"* — the code does not honour it:** the card passes
`curve={pcurve(k.id)}` (`:164`), `pcurve` returns the def's `'linear'`
(`:35-37`), and `NeonFader.fracToValue` rounds only for `'discrete'`. Anything in
`[0, 0.5)` looks set and does nothing. `docs` compounds it by stating `0/1`
(`:630`, `:635`). **Fix: `curve: 'discrete'` on both** — costs `docs:accept` AND
a re-attest.

**D-5 · grainsOfVision — the reverb tail FREEZES rather than decays when
bypassed.**
`revFront = revNext` (`:860`) sits inside the wet branch only, and `uHasPrevRev`
is gated on `framesElapsed > 0` (`:824`), not on whether the previous frame was
wet. So toggling `rev_dry` on **parks** the tail, and toggling it off **replays
it at full strength** instead of resuming a decayed one. A hard bypass that
stores energy is not a bypass.

**D-6 · SCREEN OFF's own tooltip is wrong (spirographs, and it would be copied).**
`SpirographsCard.svelte:255-256` promises *"the LIVE picture, not a stale
frame"* and *"The module goes on rendering either way"*; the code comment
(`:161-163`) asserts the same. Under the default pull-eval, with the card's blit
as the only observer, the node stops being a pull root after
`WATCH_TTL_MS = 1500` and `draw()` is skipped (§C). Conditionally false today,
**materially misleading on grainsOfVision**, where the state is a ring.

**D-7 · grainsOfVision — `resize()` silently wipes every accumulator, and the
half-resolution render is undocumented.**
`resize()` (`:872-886`) recreates the ring, both ping-pongs and `revTmp`, and
resets `head`/`framesElapsed`/`outFront`/`revFront` — so **the output aspect
switch erases the feedback trails, the reverb tail and the frame history.**
Nothing in `docs` says so. Separately, `GOV_RENDER_SCALE = 0.5` (`:77`) means the
module renders at half engine resolution and `docs.explanation` (`:592`) never
mentions it — `mandelbulb` states its own half-res in `docs`
(`mandelbulb.ts:408`), so the house style exists and this def departs from it.
(The `DESCRIPTIONS` entry, `module-manifest.ts:147`, *does* say it — so the two
prose surfaces disagree.)

**D-8 · the SCREEN ON/OFF ruling has no FACED implementation, and spirographs
already has the gap.**
`previewCollapsed` exists only in `SpirographsCard.svelte`,
`backdraft/BackdraftOutputBody.svelte` and a `VideoOutCard.svelte` comment —
**zero references in `ModuleShell.svelte` or `ui/workflow/`**. backdraft and
videoOut reach it from their faced dock through a `fullViewBody` shell extension;
**spirographs does not**, and spirographs is in `STRICT_FACES`
(`strict-faces.ts:848`) whose dock renders `ModuleShell`, not the card
(`DockFullView.svelte:319`). So the owner ruling is satisfied on spirographs' *card*
and unsatisfied on its *faceplate* — a gap in the just-landed #1874.

**D-9 · ⚠ PROMOTING `grainsOfVision` WOULD SILENTLY BLIND AN EXISTING SPEC. The
highest-priority item in this document.**
`e2e/tests/workflow-shell-video.spec.ts:444-450` spawns `g1: grainsOfVision`
with the reason stated in the comment: *"`grainsOfVision` is UN-MIGRATED, so it
exercises the PLACEHOLDER thumb loop, and b1 now exercises the FACED one. Two
hosts, one `VideoTileThumb`; dropping either would leave a host unproven."* The
assertions at `:516-536` — the thumb's blit drives the real chain
(*"the tap is the only watcher of g1"*), `framesDrawn` advances, the picture
animates — are the **placeholder-host** leg. **Promotion converts that tile to a
faced tile, which also has a thumb (#1785), so every assertion keeps passing
while the placeholder host stops being proven: GREEN AND BLIND.** This is exactly
CLAUDE.md's *"a gate whose PRECONDITION is the defect"* class. **The face PR must
re-point `g1` at another un-migrated video module, in the same diff**, and say so
in the PR body — `_face-fixtures.ts:459-474` derives that pool.

**D-10 · both cards are DEAD TO CV.**
`NeonFader` takes `readLive` (`:121`); neither `RuttetraCard.svelte` (12 faders,
`:272-293`) nor `GrainsOfVisionCard.svelte` (19 faders, `:158-169`) passes it. A
CV-driven param moves the picture while every fader stays parked. **A face binding
`readLive` fixes this for both** — merit, not ceremony.

**D-11 · `RuttetraCard.svelte` re-types twelve ranges as numeric literals**
(`:272-293`). They currently **agree** with the def, so `card-def-agreement` is
green, and the card is **not** in `RANGE_BOUND_CARDS`, so nothing at source level
stops the next edit from diverging. `GrainsOfVisionCard.svelte` does it right
(`:32-37`, reading the def). This is the backdraft class one level down; the
boy-scout fix is to add ruttetra to `RANGE_BOUND_CARDS` when it is next touched.

**D-12 · `RuttetraCard.svelte` already overflows its card by ~87 px.**
`e2e/tests/_card-overflow.ts:65` carries a NAMED exemption: *"DEFAULT-size fader
grid extends ~87px past the BOTTOM edge (user-resizable card whose default
min-height is shorter than its control stack); fix = raise the resize
default/min height."* MEASURED by that gate, pre-existing, and unaffected by
promotion (the card file survives) — but it is the same "control stack does not
fit" pressure the compact-face ruling is about.

**D-13 · `graph/types.ts:685-686` says *"no video def carries a `face` yet"*.**
Three do: `backdraft`, `spirographs`, `video-out`. Stale comment in the type that
defines `ModuleFace`.

---

## §E — WHAT THE OWNER ACTUALLY HAS TO DECIDE

Five questions. Nothing here should be built until 1 and 2 are answered.

**1. THE TAB RAIL — the ruling's first named application does not qualify.**
`ruttetra` groups honestly into **4** pages (DSP-derived) or **6** (most generous
defensible split); `grainsOfVision` into **6**, with one defensible 7th. The rail
engages at **7** (`DOCK_TAB_MIN_BANDS`, `dock-tabs-model.ts:57`). Options:

| | | price |
|---|---|---|
| **(a)** | Ship both **untabbed**; revisit when a genuinely 7-idea module arrives. `quadralogical` (21 params) is the standing candidate. | zero. ruttetra's 4 bands pack to 2 rows, which the compact ruling actively wants. |
| **(b)** | Lower the threshold to **6**. Reaches GOV (at 6) but **not** ruttetra (at 4). | **MEASURED-BY-READING: 3 existing faces are newly railed — `cube`, `cofefve`, `marbles` — so 3 dock baselines move.** Its own PR, with the regen. |
| **(c)** | Split GOV's feedback page to reach 7. | ⚠ the padding the ruling forbids, if the threshold is the reason. |

**This lane recommends (a) for ruttetra unconditionally, and (a) or (b) for GOV
at the owner's preference** — and notes that ruttetra, the module the ruling
named, is the module the ruling fits **worst**.

**2. BUILD OR NOT — and in what order.** Both merit a face. Neither is a pure
declaration: each needs a `fullViewBody` shell extension (§A.8 / §B.8), GOV needs
two def edits costing a real-GPU re-attest (§B.6), and GOV's baselines are an
**owner-look gate**, not a mechanical capture (`vrt-exemptions.ts:468`). If
either is built, D-1/D-2 (ruttetra) and D-4/D-5 (GOV) should land as their own
owner-preview behaviour PRs **first**, so the VRT re-baselines once instead of
twice.

**3. `Shape = 1` (D-2) — docs or maths?** The docs say radial; the code
overshoots by 0.2 %; a test pins the overshoot deliberately. Fixing the docs is
free. Fixing the maths is a look change plus a re-baseline plus two test edits.

**4. The FLYBACK (D-1) — is it a bug or the look?** 180 full-width streaks per
frame at the shipped defaults, 1440 at `xFreq = 8`, and **the committed VRT
baseline currently certifies them.** This is a *look* question, not an
engineering one.

**5. SCREEN ON/OFF's home (D-8).** The ruling says "every video module's CARD".
For a faced module the card is gone from the dock. The landed answer is a
`fullViewBody` shell extension (backdraft, videoOut). Confirm that is the
intended pattern for **every** future video face — and that spirographs' faceplate
gap gets closed.

---

## §F — MEASURE BEFORE BUILDING (both modules)

Nothing in this document was measured on a running engine. Before either face is
authored:

1. **§C first, on GOV** — `pullStats().framesDrawn` with SCREEN OFF and no
   downstream sink, over > `WATCH_TTL_MS`. Accumulate IN THE PAGE; report
   `samples` / `elapsedMs`.
2. **`hasVideoSurface(def)` on both**, before trusting `glyph: 'none'` —
   `'none' + blank tile` and `'none' + live thumb` are indistinguishable from
   the declaration.
3. **The flyback on a REAL render.** D-1's numbers are the pure `shapedRamp`
   mirror; confirm the GL path agrees.
4. **GOV at `rate = 0.0714` and `0.0715`** for the `time_spray` null, and
   `grain_size` at exactly `1.071`.
5. **`rev_dry` toggled on then off**, for D-5's frozen tail.
6. **That `face.pages` resolves the band count you expect** — `dockTabPlan` and
   `dockRowPlan` are pure and cheap: `task test:one -- dock-row-plan`,
   `task test:one -- dock-tabs-model`.
