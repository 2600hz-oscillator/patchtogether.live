# batch-23 — the next video face batch: derivation (no code written)

Derived while batch-22 G4's VRT capture (run 32585693456) was in flight, so that
building can start the moment the G4 PR is open. **Nothing implemented. No branch,
no issues filed.**

## Derivation basis — verify this FIRST on resume

Everything below was derived at **HEAD = `0df01414d`**, which is the G4 branch with
`origin/main = f722d1623` already merged in. So the pool reflects: batch-22 G1
(edges/colorizer/inwards/vdelay), G2a (lumakey/shapegen) and G4
(mapper/destructor/luma/videoMixer) as DONE.

⚠ **NOT yet reflected: G2b (`tempest`, `fader`, PR #2100) and G3 (`posterbox`,
`tiler`, `sourcery`, `onetonine`), which were unmerged at derivation time.** They are
subtracted by NAME below rather than by the inventory's `done` column. Re-run the
arithmetic after they land; the conclusion does not change, because none of the six is
in the batch-23 candidate set.

⚠ **Every card-primitive scan below was run LIVE against this tree**, not carried over.
The batch-22 doc's equivalent scans went stale within a week and its own header says so
— that warning was correct, and re-deriving is what turned up the `shapes` and
`acidwarp` findings.

## The arithmetic — and the headline

| | count |
|---|---|
| unfaced video modules (all dispositions) | 41 |
| …of those, `generic-face` | 21 |
| …minus in-flight G2b (`tempest`, `fader`) | 19 |
| …minus in-flight G3 (`posterbox`, `tiler`, `sourcery`, `onetonine`) | 15 |
| …minus CLAIMED by lane A (`cellshade`) and routed solo (`graphicEq`) — see Q4 | 13 |
| …minus rides-alone by owner policy (`scoreboard` #2089) | 12 |
| **…of those with ≤4 params** | **ZERO** |

### ⚠ THE ≤4-PARAM VIDEO TAIL IS EXHAUSTED

This is the finding that shapes the whole batch. Param counts read live from
`contract-lock.txt` (the pinned I/O golden, so no registry import needed):

```
scoreboard      3     ← the ONLY ≤4 left, and it is already split out to ride ALONE (#2089)
acidwarp        5
graphicEq       5     ← PARKED (batch-19 worktree)
lines           5
peakstate       5
shapes          5
cellshade       6     ← PARKED (attest decision on its bits roster)
chroma          6
chromakey       6
feedback        6
mandleblot      6
lushgarden      7
shapedramps     8
vfpgaRunner    16
quadralogical  21
```

**So batch-23 cannot be a ≤4 batch. There is no such set of four left.** The next
honest cut is **≤5**, which yields exactly four available modules — `acidwarp`,
`lines`, `peakstate`, `shapes` — with `graphicEq` (also 5p) excluded only because it is
parked in another lane's tree.

### ✅ DECIDED (coordinator, 2026-08-22): the cut is ≤5 for SIMPLE modules

Raised as a policy question rather than assumed, and **approved by the coordinator, who
flagged it to the owner for veto.** The recorded reasoning, because the next lane will
ask the same question:

> The owner's *"<4 controls get batched"* line divides SIMPLE from
> COMPLEX-NEEDING-DESIGN — **the number was a proxy**, and a 5-identical-knobs module
> is on the simple side of that line by any reading. What stays owner-sacred is the
> other half: **complex modules ride alone.**

So the ≤5 cut is a clarification of the proxy, not a relaxation of the rule. The half
that did NOT move is the half that decides `acidwarp` below.

The alternative — go to AUDIO — was rejected as worse right now: the `_face-fixtures`
AUDIO pool is down to **2** candidates (`dockscope`, `samsloop`) against a `> 1` slack
assertion, so any audio promotion must widen that pool in the same PR.

## The four, with LIVE-VERIFIED card primitives

### `peakstate` (5p) — the clean one, ZERO attest

| param | contract | card primitive |
|---|---|---|
| `speed` | 0.1..4 linear | `Knob` |
| `color_speed` | 0..4 linear | `Knob` |
| `complexity` | 4..32 **discrete** | `Knob` |
| `move` | 0..1 linear | `Knob` |
| `oblong` | 0..1 linear | `Knob` |

Card draws **5 `Knob`s and nothing else** — no buttons, no selects, no `node.data`.
Every param has exactly one control.

- **`paramCells`: DECLARE NOTHING.** A knob IS the shell default. This is the `shapegen`
  side of the batch-22 G2a lesson: copying a sibling's `paramCells: {…'fader'}` here
  would be a silent regression in the opposite direction.
- `complexity` is discrete 4..32 (29 steps) — a knob is correct and snaps
  (`knob-conic-model.ts:71`). ⚠ Do **not** declare it `fader`: `module-face-lint`
  refuses a throw over a discrete param, which is exactly what it did to
  `luma.posterizeLevels` in G4.
- **The card already has a live `<canvas>`**, so the `fullViewBody` is a PORT of an
  existing preview, not an addition — unlike all four of G4's.
- **Attest: NIL.** No `params` change.

### `lines` (5p) — faders, ZERO attest, one real decision

| param | contract | card primitive |
|---|---|---|
| `amp` | 0.5..50 linear (lpx) | `NeonFader` |
| `orient` | 0..1 linear | `NeonFader` |
| `phase` | 0..1 linear | `NeonFader` |
| `thickness` | 0..1 linear | `NeonFader` |
| `fmDepth` | 0..1 linear | **NO CONTROL** |

- **`paramCells`: `{amp, orient, phase, thickness}` all `'fader'`.** Four `NeonFader`s,
  live-verified; an undeclared face silently swaps them to knobs and no def-reading gate
  sees it.
- Card has **no canvas and no buttons** — so the `fullViewBody` is an ADDITION, like
  G4's four.
- ⚠ **`fmDepth` IS DELIBERATELY INERT, AND MY FIRST READ OF IT WAS WRONG.** I initially
  scored it as a live defect (a depth control with no way to set it, leaving the `fm`
  input dead). The def says otherwise, explicitly: *"The uniform is plumbed but
  multiplied by 0.0 in this Phase 0 shader, and there is no CV input or card fader for
  it, so it currently has no visible effect."* The `fm` mono-video input is likewise
  forward-compatible plumbing for Phase 3. **It is documented dead weight, not a bug —
  do not file an issue for it.**
- **The face consequence is real regardless:** `module-face-lint` completeness demands
  every param be ranked and render exactly one interactive cell, so ranking `fmDepth`
  would paint a control the shader multiplies by zero — "a faceplate must not paint a
  dead control as a working one" (the macrooscillator rule). It wants `noUserControl`
  (#1726).
- ✅ **RESOLVED — `writer: 'internal'`, and NO vocabulary extension is needed.** Checked
  `no-user-control.ts` + `NoUserControlParam` in `graph/types.ts` before building, as
  instructed. The union is `'cv-port' | 'internal'`, and `'internal'` is defined
  MECHANICALLY, not by example: *"NOTHING on the patch surface targets it… Asserted to
  have no such port, so the day one is added this entry stops being true and says so."*
  That is `fmDepth` exactly. (The parenthetical "a determinism or harness toggle" is an
  example of the class, not the definition — a forward-compat param with no port is the
  same mechanical case.)
- ⚠ **AND THE WRONG ANSWER WAS STRUCTURALLY IMPOSSIBLE TO SHIP QUIETLY**, which is worth
  recording because it is why the coordinator's "do not shoehorn `cv-port`" instruction
  could not have been violated by accident: `writer` is anchored to the def's own ports
  in BOTH directions — *"'cv-port' asserts a port targeting the param EXISTS, 'internal'
  asserts one does NOT."* `cvWritersOf(linesDef, 'fmDepth')` returns `[]`, so a
  `'cv-port'` declaration here would have gone RED on the first lint run. The typed
  field does the job it exists for.
- **Attest: NIL.** `noUserControl` is in `HASH_TRANSPARENT_PROPS`
  (`attest-code-basis.ts`), verified for milkdrop in #2083.

### `shapes` (5p) — TWO declared-vs-rendered defects, ATTEST MOVEMENT

| param | contract | card primitive |
|---|---|---|
| `tileN` | 1..16 linear | `NeonFader` |
| `rotate` | -3.14..3.14 linear | `NeonFader` |
| `zoom` | 0.05..10 **log** | `NeonFader` (card `curve="log"`, agrees) |
| `shape` | 0..2 **linear** | **`<button>` cycling 3 NAMED states** |
| `tile` | 0..1 **linear** | **`<button>` 2-state toggle** |

Two genuine defects, both the #2090 class, both needing a `params` change:

1. **`shape` is a 3-state named cycle declared as a bare linear range.** The names
   ALREADY EXIST in the card — `const SHAPE_LABELS = ['CIRCLE', 'SQUARE', 'TRI']` — so
   a roster can be promoted without inventing anything. Needs `curve: 'discrete'` +
   `options`. Un-fixed, the faceplate would render the module's most visible decision as
   a continuous dial reading `0` / `1` / `2` — the fourplexer/spirographs `inside` class.
2. **`tile` is a 2-state toggle declared `linear`.** `looksLikeToggle` requires
   `curve === 'discrete'`, so as declared it resolves to a **KNOB over a 2-state param**
   — the moog962 defect, where such a control is INERT because a dial cannot reliably
   land on two values. Needs `curve: 'discrete'`.
   ⚠ **And fixing it TRIGGERS a second requirement:** once `tile` is `0..1 discrete
   default 0` it satisfies `looksLikeSwitch`, so it must be classified as momentary or
   `ACKNOWLEDGED_LATCHING` — **verified at the READ SITE**, not assumed. The card reads
   `tileOn = p('tile') >= 0.5`, i.e. a LEVEL, which points to LATCHING; confirm against
   the shader's own use before declaring.

- **Both fixes are `params` changes**, so `contract-lock` moves **and** the WebGL attest
  basis moves. Budget an attest window and a `docs:accept`.
- Card also has no canvas → `fullViewBody` is an ADDITION.

### `acidwarp` (5p) — ⚠ RECOMMEND SPLITTING OUT; it is not "simple"

| param | contract | card primitive |
|---|---|---|
| `speed` | 0..1 linear | `Knob` |
| `scene` | 0..40 **discrete** (41 states) | `<button>` cycling + a **live readout** |
| `paletteType` | 0..7 **discrete** (8 NAMED states) | `<button>` cycling |
| `freeze` | 0..1 **discrete** default 0 | `<button>` (latching) |
| `sceneTrig` | 0..1 **linear** default 0 | **NO CONTROL** — synthetic |

Five params, but four distinct control shapes, a 320×240 live plasma display, three
buttons and a resting text readout. On the owner's own split (*"big modules needing
complex design go 1 PR at a time"*) this reads as the complex side, and it carries four
separate decisions:

1. **`paletteType` roster.** `const PALETTE_NAMES = ['RGBW','GREY','HALF','PASTEL',
   'RGBW✨','GREY✨','HALF✨','PSTL✨']` exists in the card, so the roster is promotable
   without inventing. Already `discrete`; adding `options` is a `params` change →
   **ATTEST**.
2. **`scene` gets NO roster.** 41 states and the card names none of them — it prints
   `SCENE n/41`. Inventing 41 names is forbidden; it stays a numeric discrete control.
3. **`sceneTrig` is the synthetic trigger**, and it is exactly milkdrop's `nextTrig`
   class: `acidwarp in scene_cv cv param=sceneTrig`, so a CV port writes it and no card
   control exists. → `noUserControl` with `writer: 'cv-port'`, which milkdrop already
   established and which is attest-transparent. ⚠ Note it is declared **`linear`**, so
   painted it would be a continuous rotary over a gate edge.
4. **`freeze` is a REAL user control here, not a VRT hook** — worth stating because the
   name collides with the determinism seam on other defs. Its docs: *"halts only the
   automatic scene cycler — the palette keeps rotating."* Already `discrete 0..1`
   default 0, so it resolves to a Toggle on its own, **but it satisfies
   `looksLikeSwitch` and therefore needs an explicit momentary/latching classification**
   (it latches — the card reads FREEZE / FROZEN).

⚠ **And one thing the face must DELETE:** the card's `<div class="scene-readout">SCENE
{n}/{SCENE_COUNT}</div>` is resting derived text, forbidden on a faceplate by the
2026-08-19 ruling. The scene number survives in `aria-valuetext`. Do not port it.
(`SCENE_COUNT` / `PALETTE_COUNT` are imported constants, not hand-typed — leave them
alone; they are not population-count violations.)

## Packaging — ✅ APPROVED (coordinator, 2026-08-22)

### SPLIT-ON-THE-ATTEST-LINE — now the standing pattern, by name

Batch-22 split G2a from G2b on exactly this line and it paid: G2a shipped zero-attest
while G2b needed a real GPU pin, and dragging them together would have put an attest
window on modules that did not need one. **The coordinator has named this the standing
pattern for face batches: group by whether the PR moves `params`, never by module
count.** Use the name in future PR bodies so it is greppable.

- **batch-23a — ZERO ATTEST: `peakstate` + `lines`.** No `params` change on either.
  Ships the knob/fader distinction cleanly (peakstate declares nothing, lines declares
  four faders), and `peakstate` is the first of this wave whose preview is a PORT rather
  than an addition. **Needs no attest-window coordination, so it can start the moment
  the G4 PR is open.**
- **batch-23b — ATTEST: `shapes`.** Two `params` fixes, both real defects, one attest
  window, one `docs:accept`. Full handoff protocol (clean committed tree, report the
  expected refusal hash, never run `task webgl:attest` yourself).
- **`acidwarp` RIDES ALONE → REASSIGNED to the DESIGN LANE (coordinator-routed,
  2026-08-22).** Approved solo on the owner-sacred half of the rule: *"it isn't 'a
  5-param module', it's four control shapes + a live display + buttons + a readout
  deletion, i.e. a module needing design, and policy says those never batch."* It then
  went to the **third lane (the quadralogical agent), which has just shipped the bespoke
  pattern** and is therefore the right home for the design-heavy solo.
  ⚠ **NOT this lane's work — do not queue it.** The per-module analysis below stays in
  this doc as HANDOFF MATERIAL for whoever builds it (the roster/no-roster split, the
  `sceneTrig` classification and the readout deletion are all derived and verified); it
  is not a claim on the module.

## Carried-forward obligations (do not re-derive these)

- **All four are VIDEO faces**, so each needs: `glyph: 'none'` (mandatory — no `audio`
  output, so any other literal reddens the dead-glyph clause), a `fullViewBody` with the
  SCREEN ON/OFF switch over the shared `previewCollapsed` key, an `EXTENSION_BODY_ROLES`
  entry declaring its role, and a `FACES` roster entry in `_shell-faces.ts` with a
  `videoFaceWhy`.
- ⚠ **Each also needs a `SUBJECTS` entry in `e2e/tests/face-screen-render.spec.ts`** —
  the fleet render-leg table established by the G4 PR. That file's header states the
  convention: a face PR adds its module's entry in the same diff. Adding four costs
  roughly **8 s** of CI (measured: 26 cases in 51.8 s under `E2E_SWIFTSHADER=1`).
- None of the four is a MONITOR-mode module (`hideControls` appears only on
  `RuttetraCard`, `MonoglitchCard`, `MilkdropCard`, `ReshaperCard`, `GraphicEqCard`), so
  do not invent one.
- All four already carry co-located `docs` and are already in `STRICT_DOCS` — **zero
  boy-scout docs cost**, verified live.
- None is in `NON_SHELL_LANE_TYPES` (`group`, `sticky`, `cadillac`, `clipplayer`,
  `controlSurface`, `electraControl`, `launchpadControlLeft`, `cameraInput`), so all
  four take the shell lane tile.

## Questions — ALL FOUR ANSWERED 2026-08-22. Nothing blocks batch-23a.

1. ✅ **Is a ≤5-param cut acceptable for "simple"?** **YES** — coordinator's call,
   flagged to the owner for veto. The number was a proxy for SIMPLE-vs-NEEDS-DESIGN; the
   complex-modules-ride-alone half is untouched. See the decision block above.
2. ✅ **`acidwarp`: batch or alone?** **ALONE**, on the untouched half of the rule.
3. ✅ **`lines.fmDepth` writer vocabulary?** **`writer: 'internal'`; no extension
   needed.** Resolved against the real type before building — see the `lines` section.
4. ✅ **`graphicEq`(5p) / `cellshade`(6p) — NEITHER joins 23a.** Answered by the
   coordinator 2026-08-22; the ≤5 set stays exactly four.

   - **`cellshade` is CLAIMED, not parked.** Lane A is rebuilding it off current main
     right now — roster approved, attest staged to the coordinator. Do not touch it, and
     do not resurrect the old parked worktree.
   - **`graphicEq` is routed SOLO, for three reasons**, all of which are worth keeping
     because they are a reusable test for "does this module belong in this batch?":
     1. **It is AUDIO**, so its PR owes the `_face-fixtures` audio-pool widening in the
        same diff (the pool is at 2 against a `> 1` slack assertion). That is a
        different KIND of work, and folding it in would break 23a's uniformity.
     2. **It is parked with recon in the batch-19 tree**, which should be HARVESTED when
        someone picks it up rather than re-derived from scratch.
     3. **23a as scoped is ready to fly.** Adding a fifth module in a different domain to
        a batch whose whole virtue is simplicity is the wrong trade.

     It becomes its own assignment — solo, audio, pool-widening included — for whichever
     lane frees first after `cellshade` / 23a. **The coordinator routes it; do not
     self-assign it.**

   ⚠ The generalisable rule, since it will come up again: **a batch's virtue is
   uniformity, and domain is part of uniformity.** One module that drags a different
   class of obligation (a pool widening, an attest window, a platform change) into an
   otherwise uniform batch belongs in its own PR — the same instinct that produced
   SPLIT-ON-THE-ATTEST-LINE above, applied to domain instead of attest.

## Sequencing and ROUTING (coordinator, 2026-08-22)

**This lane's queue, explicit:**

1. **G4 PR** — on capture reconcile → merge on green.
2. **batch-23a** (`peakstate` + `lines`, zero-attest) — **starts the moment G4's PR is
   open, no gap.** Needs no attest-window coordination.
3. **batch-23b** (`shapes`) — attest handoff to the coordinator.
4. Then **ping the coordinator for the next derivation target**: after 23b the ≤5 video
   tail is DONE, and the next cut is *a decision, not an assumption* — do not pick one
   unilaterally, which is the same trap the ≤4→≤5 move was caught by above.

**Routing of everything NOT this lane's:**

| module | routed to | note |
|---|---|---|
| `acidwarp` | **design lane** (the quadralogical agent), coordinator-routed | the design-heavy solo; that lane had just shipped the bespoke pattern |
| `cellshade` | lane A, in flight | rebuilding off current main; roster approved, attest staged |
| `graphicEq` | unassigned — **coordinator routes** | solo, audio, `_face-fixtures` pool widening included; harvest the batch-19 tree's recon |
| `scoreboard` | unassigned (#2089) | rides alone |

⚠ **Do not self-assign anything in that table.**
