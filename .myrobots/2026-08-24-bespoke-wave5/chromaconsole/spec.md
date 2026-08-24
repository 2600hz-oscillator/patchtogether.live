# FACEPLATE BUILD SPEC — `chromaconsole` (audio, the DEVICE control surface)

**Mocks:** [`dock.html`](dock.html) · [`dock-assign.html`](dock-assign.html)
**Cohort analysis:** [`../BINDERS.md`](../BINDERS.md) — §1, §2, §4, §6 are shared.

> ## ⚠ VERDICT: **BLOCKED**, on ONE precisely-located platform capability.
>
> **A face cell's caption is `ParamDef.label` and nothing else** — static, def-derived,
> no node input (verified: `ModuleShell.svelte:959/977/999/1022/1055/1083/1164/1183/1203`
> are all `label={pd.label}`; `:943`'s `paramCell.label` is a def-derived warped-fader plan).
>
> chromaconsole's eight params are `slot1`…`slot8` with labels `"slot 1"`…`"slot 8"`
> (`device-module.ts:91`), and **what each one actually controls is per-node
> `node.data.assign`.** So a face today paints **eight identical knobs captioned "slot 1"
> through "slot 8"** over a pedal whose controls are called TILT, RATE, TIME, MIX,
> SENSITIVITY, DRIFT and OUTPUT LEVEL.
>
> **The card solves this and the face cannot** — `ChromaconsoleCard.svelte:165-169`'s
> `knobLabel()` reads the live assignment. That is a **functional-parity loss**, which is
> never surfaced as an owner choice: it is a thing to solve. §0.2 sizes the fix.

Nothing here is implemented. This is a spec.

---

## 0. THE CONSTRAINT MAP, READ FIRST

```
def          packages/web/src/lib/audio/modules/chromaconsole.ts        120 lines
descriptor   packages/web/src/lib/devices/hologram-chroma-console.ts    35 controls, 5 groups
shared       packages/web/src/lib/devices/device-module.ts              deviceSlotParams, createDeviceHandle
             packages/web/src/lib/devices/device-descriptor.ts          formatControlValue, quantize
card         packages/web/src/lib/ui/modules/ChromaconsoleCard.svelte   383 lines
e2e          e2e/tests/chromaconsole.spec.ts                            10 tests — the richest in this cohort
docs         STRICT_DOCS:253 — ALREADY STRICT, with per-slot docs.controls
VRT          ⚠ NOT exempt. ONE COMMITTED BASELINE: e2e/vrt/__screenshots__/vrt.spec.ts/chromaconsole.png
push2        ⚠ PUSH_CARD_CONTROLS:64 — an explicit override pinning all eight slots
attest       NOT in the WebGL basis. ZERO.
ART          zero ports. ZERO.
```

| the fact | where | what it forces |
|---|---|---|
| **eight IDENTICAL params** | `deviceSlotParams`, `device-module.ts:86-100` | all `0..127 linear`; the #2181 family-key problem in its purest form — §2 |
| what each slot MEANS is per-node | `node.data.assign` (`chromaconsole.ts:96-111`) | ⚠ **the blocker.** A cell caption cannot read it — §0.2 |
| `inputs: []`, `outputs: []` | `:52-53` | zero ports both ways. `glyph: 'none'` forced; the rear rail has nothing to lay out |
| the device is **RECEIVE-ONLY** | card header `:4-18` | there is no true state to display, only what was sent — §0.3 |
| the card is already VRT-deterministic **by design** | card header `:20-28` | ⚠ and its determinism pass independently arrived at most of the resting-text ruling — §0.3 |
| it is the FIRST device module | def header `:1-31` | `livecode` and `clockedRunner` are the precedents for the audio-domain choice; **whatever this face does is the template for every device module after it** |

### 0.1 WHY THIS IS AUDIO-DOMAIN WITH ZERO PORTS, AND WHY IT MATTERS HERE

`chromaconsole.ts:9-26` answers a question a face author will otherwise ask: it has zero
ports, so `meta` looks natural, and it is not — *"`MetaModuleDef` carries NO FACTORY — the
reconciler skips meta nodes entirely — and the factory is precisely what this module needs."*

⚠ **That matters for this wave specifically.** Wave 4's headline was that `MetaModuleDef`
has **no `face` field at all**, so no meta module can be promoted. **chromaconsole dodged
that blocker by a decision taken months earlier for unrelated reasons** — it is an
`AudioModuleDef`, so `face` is available to it today.

The def also records that `video` was rejected because it *"would additionally have dragged
the module into the WebGL attest basis and forced a GPU re-attest for a module with no
pixels in it."* Verified: `webgl-attest-lib.ts:68-69` names exactly two audio defs in the
basis (`cube.ts`, `wavesculpt.ts`). **The reasoning was right and the cost saving is real.**

### 0.2 ⚠ THE BLOCKER — a face cell's caption cannot read the node

**The measurement.** Every param cell in `ModuleShell.svelte` passes `label={pd.label}`:
`:959`, `:977`, `:999`, `:1022`, `:1055`, `:1083`, `:1164`, `:1183`, `:1203`. The one
exception, `:943`, passes `paramCell.label` — a `warped-fader` PLAN, derived from the def's
landmark declaration, still with no node input. Shell-cell captions (`:1231`, `:1248`,
`:1264`) are `cell.tag` / `cell.label`, static strings on the `SHELL_CELLS` record.

**There is no node-derived caption anywhere in the shell.**

**And the params must be face cells** — this is the half that closes the escape hatch.
`module-face-lint.test.ts:312-355` walks `def.params` with no filter and requires each id to
appear in `face.order`, satisfied without a rank **only** when the def declares it
`noUserControl`. Its render-side twin (`:375-411`) then requires each to resolve to exactly
one INTERACTIVE param cell.

So all four escapes are closed, and each for a different reason:

| escape | why it fails |
|---|---|
| put the slot grid in the `fullViewBody` | the eight params would then be in `face.order` with no cell — the render-plan twin reddens |
| declare them `noUserControl` | false. They have user control; `no-user-control` says *nobody* sets the param, and CLAUDE.md's rule is explicit about not "fixing" a declaration a consumer contradicts |
| declare a `controlFamily` so ONE key covers eight | `isFamilyMember` (`:127-133`) exempts family members from the **legend static-key** sweep, not from the **param** sweep. `def.params` still carries eight ParamDefs and the loop is unconditional |
| bake the assignment into `ParamDef.label` | `deviceSlotParams` runs at MODULE-DEF construction, once per process. The assignment is per NODE. A static structure cannot carry per-instance data — this is not an implementation gap, it is a category error |

**THE ASK, sized.** One capability, one shape, and it is smaller than wave 4's:

> **`ParamDef` gains an optional `labelFor?: (node: ModuleNode | undefined) => string`**, and
> `ModuleShell`'s param-cell arms pass `pd.labelFor?.(node) ?? pd.label`.

* **What changes:** one optional field on `ParamDef`; one `??` at each of the ten
  `label={pd.label}` sites (mechanical); a lint clause requiring `labelFor` to fall back to
  a non-empty `label`, so a face is never captionless.
* **What it does NOT change:** the contract. `serializeModuleContract` projects
  id/min/max/curve/defaultValue/units/ports/flags — a function is not projected, so
  `contract-lock` does not move. ⚠ **Verify that** rather than trusting it; if the projector
  walks keys generically, a new key needs a `FACE_FIELDS_NOT_IN_LOCK`-style entry with a
  `why` and a `coveredBy`.
* **What else it unblocks:** every device module. This is the FIRST one (`:1-6`), and the
  pattern — N fixed assignable slots over a named control roster — is the shape every one
  after it will have. It is also the general answer for any param whose meaning is
  per-instance.
* **The smallest version:** the field plus ONE call site (the plain knob arm), with the
  other nine deferred. chromaconsole needs only the knob arm.

⚠ **Negative-control it in BOTH directions**, per CLAUDE.md: a face WITHOUT `labelFor`
still captions from `label` (so no existing face moves), and a face WITH it captions from
the node (so a node-data change moves the caption). One of those must be a permanent leg of
the test — a gate that only proves the new path works is blind to the regression it can
cause in every already-promoted face.

⚠ **THIS ASK IS NOT WAVE 4's ASK.** Wave 4 wanted `env` on `ShellSelectorCell`, which
BINDERS §1 shows was both too narrow and unnecessary. This one is verified in the opposite
direction: **the capability genuinely does not exist**, the search that established that is
recorded above by file and line, and the thing it blocks is a functional-parity loss rather
than a convenience.

### 0.3 ⚠ THE CARD ALREADY DID MOST OF THIS WORK, FOR A DIFFERENT REASON

`ChromaconsoleCard.svelte:20-28`:

> *"The card carries a committed VRT baseline, so its resting render must be byte-stable: no
> message counters, no activity blink, no elapsed times, no 'last CC sent' readout. Those
> would flap the baseline on every capture — and, conveniently, the 'last CC sent' readout is
> also the element that most tempts a reader into thinking the card mirrors the pedal. **The
> two constraints agree.**"*

**They agree a THIRD time.** Every element that paragraph excludes is exactly what the
resting-text ruling forbids. A card authored for VRT determinism, months before the ruling,
independently arrived at most of it.

**That is the strongest evidence available that the ruling is a design principle rather than
a preference** — three unrelated pressures (pixel determinism, honesty about a receive-only
device, and the owner's screen-real-estate ruling) selecting the same set of deletions. It
also makes chromaconsole cheap to get right: the author already did the removal pass.

---

## 1. WHAT THE MODULE IS FOR

**One sentence:** it makes one specific guitar pedal automatable from inside the rack.

The verb is *turn a knob here and the pedal changes*. The pedal has **34 documented CCs**;
`deviceSlotParams` exposes **eight at a time** as real params, and those eight are the ones
clip automation, MIDI learn, Electra and the Push 2 card can drive. `docs.explanation`
(`:69-70`) gives the reason the number is eight and not thirty-four: *"a clip can hold
sixteen automation lanes in total, so one device taking half of them still leaves room for
the rest of your patch."*

**So the module's real primary interaction is not turning a knob. It is CHOOSING WHICH EIGHT
OF THIRTY-FOUR.** Turning them is what every module does. The assignment is what makes this
one bespoke, and it is why §3's design puts assignment on its own footing rather than
treating it as a setting.

The descriptor's 35 controls fall in five groups (`hologram-chroma-console.ts`):
`primary` (8), `secondary` (8), `modules` (4, `role: 'enum'`), `bypass` (6, mostly `enum`),
`other`. The card's picker uses `<optgroup>` per group (`:245-251`) — that grouping is
authored data and the face must keep it; a flat 27-item list is unusable.

---

## 2. THE FAMILY-KEY PROBLEM — eight identical instances, and #2181's exact shape

**Eight `0..127 linear` params with identical everything except `id` and `defaultValue`.**

CLAUDE.md's rule for this cohort is *"A family key is ONE cell for ALL instances."* Applied
naively here it produces the wrong answer, and the reason is worth writing down because the
next device module will meet it.

**A `controlFamily` is the right shape when the instances are INTERCHANGEABLE** — eight
identical voices, eight identical channel strips. `mixmstrs` is the worked case, and its
`face.bareCells` declaration exists precisely because `1LO`…`8LO` under a `LOW` heading say
nothing the grid has not said twice.

**These eight are NOT interchangeable, and that is the whole module.** Slot 3 is TIME today
and MIX tomorrow; slot 3 and slot 5 do completely different things; and a player's muscle
memory attaches to the ASSIGNMENT, not to the ordinal. Collapsing them to one template cell
would collapse the one axis that carries meaning.

**So the resolution is the opposite of mixmstrs' and for the same underlying reason.**
mixmstrs drops its per-control captions because a section heading already conveys them;
chromaconsole's per-control captions are **the only thing distinguishing eight otherwise
identical knobs**, which is the tidyVco `A`/`D`/`S`/`R` case exactly — and CLAUDE.md rules
that those STAY.

⚠ **And that is precisely why §0.2's blocker blocks.** The one thing the ruling says must
stay is the one thing a face cell cannot currently render. A face shipped without
`labelFor` would satisfy the letter of the caption rule — eight captions, all present, all
distinct — while conveying nothing, because `"slot 1"` disambiguates an ordinal rather than
a function. **That is a green gate certifying a live bug**, which is the class CLAUDE.md's
blind-gates section exists for.

---

## 3. THE FACE — what it looks like once `labelFor` exists

```ts
face: {
  glyph: 'none',                                  // forced: zero ports (§4)
  order: ['slot1','slot2','slot3','slot4','slot5','slot6','slot7','slot8'],
  pages: [{ id: 'slots', label: 'slots', controls: [...all eight] }],
  extension: 'chromaconsole',                     // fullViewBody: bind + assign + actions
}
```

### 3.1 RANK — and an honest statement that the rank means nothing

`face.order` is ordinal because the params are ordinal. **There is no defensible
DSP-derived rank over eight slots whose meaning is per-node**, and the skill's rule
("a rank is only defended if the argument would be wrong for a different module") cannot be
satisfied — any argument for putting slot 5 before slot 2 would be equally true of every
device module ever.

**Write that in the comment on the face.** A rank presented as considered when it is
positional is worse than a positional rank admitted to be positional: the next author
inherits a false premise, which is the failure mode `module-faceplates.md`'s own corrected
`samsloop` entry is about.

⚠ **The rank is not free even so.** Ranks 1–6 are the entire lane budget and 7+ is
dock-only, so **slots 7 and 8 never appear at any lane tier.** With ordinal ranks that is
arbitrary — slot 7 might hold the control the player actually performs. `PUSH_CARD_CONTROLS:64`
already pins all eight for the Push 2 card for the analogous reason; **there is no
equivalent for lane tiers, and this is the one place the ordinal rank has a user-visible
cost.** Recorded, not solved: the honest fix is per-node ranking, which is the same
capability as per-node captions and should not be scope-crept into `labelFor`'s PR.

### 3.2 BANDS — ONE, and no tab rail

Eight cells of one kind, one idea. `DOCK_TAB_MIN_BANDS = 7`; this is one band.

⚠ **A reviewer may reach for the owner's control-heavy tab ruling and it does not apply.**
That ruling is about *"lots of controls of DIFFERENT types"* — backdraft's eight semantic
pages across feedback/loop/colour/key/switches/screen/camera. chromaconsole has **eight
controls of ONE type**. Splitting them into pages would be padding pages to force a rail,
which is named as an anti-pattern in the same ruling. The honest structure is one band and
**one band is correct** — the owner ruled `ruttetra` ships untabbed at twelve params in the
same breath as ruling `spirographs` tabbed at three.

`face.tabbed` is owner-instruction-only and is not reached for.

### 3.3 THE BODY — `face.extension: 'chromaconsole'`, slot `fullViewBody`

Three groups of things that are not param cells:

```
┌─ bind ─────────────────────────────────────────┐
│ [ Connect MIDI… ]  [ HOLOGRAM Chroma… ▾ ] [ ch 1 ▾ ] │
├─ assign  (a MODE, not a resting row) ──────────┤
│ [ ⇄ ASSIGN ]                                    │
├─ actions ──────────────────────────────────────┤
│ [ Push all ]  [ tap ]  [ …descriptor actions ] │
└────────────────────────────────────────────────┘
```

**ASSIGN is a MODE, and that is the design call on this module.**

The card renders eight `<select>`s permanently, one above each knob (`:238-252`). At rest
that is **eight dropdowns of chrome for a setting changed rarely**, and it doubles the
plate's height for an editing affordance.

**Instead: one ASSIGN toggle swaps the eight knobs, in place, for eight pickers.** It is
`dock-assign.html`.

Three independent reasons, and it matters that they are independent:

1. **It is the compact answer.** Owner: *"prefer compact. screen real estate is expensive!"*
   Resting height roughly halves.
2. **A control that appears in ONE MODE ONLY is one of the four NAMED genuine width
   earners** in CLAUDE.md's width ruling. The assign pickers need ~200 px each for a
   grouped roster of 27; the knobs need ~68. **The mode is what lets the resting plate be
   narrow and the editing view be wide** — the earner is spent only while earning.
3. **It matches the module's own model of itself.** `docs.explanation` (`:66-71`) treats
   assignment as a setup act (*"Assign any control to any slot from the card; the assignment
   is saved with your rack"*) and slot-turning as the performance act.

⚠ **The mode's state is COMPONENT state, not `node.data`** — and this is deliberate, against
the pattern the SCREEN-toggle ruling establishes. `previewCollapsed` lives on `node.data`
because it is a persistent VIEW PREFERENCE that must survive a reload and sync to
collaborators. An assign mode is a transient EDITING state; persisting it would reopen the
editor on every load and sync one collaborator's editing into another's performance view.
**Reason about which of the two any new toggle is** — the #1531/#1574/#1583 unmount class
makes component state the wrong default, so choosing it needs the argument written down.

⚠ **PUSH ALL and the descriptor actions are `ShellActionCell`s and REQUIRE a probe.**
`shell-cells.ts:293` makes `probe` required. An audition writes nothing to the graph, so
`readParam`/`readData` are structurally blind — `faces-parity` once asserted `toBeEnabled()`,
clicked, and asserted nothing, and **sixstrum shipped a face over an instrument that could
not be sounded.** The observable is the audition ledger. **chromaconsole already has the
right instrument**: `read('ledger')` (card header `:28`), and `chromaconsole.spec.ts:240`
already proves *"with NO output selected, a write sends nothing and is RECORDED
undelivered"* — `delivered: false` recorded, never dropped, which is exactly the shape the
probe contract wants. `probe: { effect: { kind: 'audition', seam: 'engine-message' } }`.

### 3.4 WIDTH

`.chroma-console { width: 360px; }` (`:320`) with the comment *"2 × the 180px rack tile, so
the card lands on the grid"* — a rack-geometry constant, not a content measurement.

**Content:** eight knob columns. Measured off the live dock (20 faces, 104 cells, a 1220 px
pane), knob columns are **40–68.8 px**. Eight at 68.8 plus gaps is ~600 px on one row, or
**~300 px as 4×2**.

**4×2, and the plate is ~340 px** — the card's own grid (`knobLabel`'s doc says the labels
are shortened *"for a 4-across grid cell"*, `:157-163`). Nothing else earns width at rest;
the assign mode earns it while active and gives it back on exit.

---

## 4. THE LANE PICTURE — refused; zero ports

`inputs: []`, `outputs: []` (`:52-53`). No output of any type, so `primaryAudioOutPortId`
cannot resolve and every glyph literal falls to `{kind:'static'}`. `glyph: 'none'`, forced.

**Lane tile after promotion:** title plus ranks 1–6 (slots 1–6 as knobs), no jacks —
`PatchPanel` has nothing to render. ⚠ **That is MORE than the card shows at lane size and
it is the §3.1 problem seen from the other end**: six of eight knobs, chosen ordinally,
captioned by `labelFor`. Without `labelFor` it is six knobs captioned `"slot 1"`…`"slot 6"`,
which is the clearest single demonstration of why the blocker blocks.

---

## 5. STOP 1 and STOP 2

**STOP 1 — parity:** ⚠ **FAILS TODAY**, on §0.2. `knobLabel()` (`:165-169`) is an
affordance the card has and the face cannot reproduce. Per the skill, a parity loss is
never surfaced as an owner choice after the build — but it is also not a permanent refusal
when the gap is one optional field. **The verdict is BLOCKED, not REFUSED**, and §0.2 is
the unblock.

**STOP 2 — the grep**, `ChromaconsoleCard.svelte`:

| # | line | affordance | survives as |
|---|---|---|---|
| 1 | `:186` | `Connect MIDI…` | `fullViewBody` button. ⚠ `:108-110`'s user-activation rule travels with it |
| 2 | `:190` | MIDI output `<select>` | `fullViewBody`. Roster from `api().listOutputs()` (BINDERS §1) |
| 3 | `:201` | MIDI channel `<select>` (1..16) | `fullViewBody` |
| 4 | `:238` ×8 | per-slot assignment `<select>` over grouped 27 | `fullViewBody`, **ASSIGN mode** — §3.3 |
| 5 | `:259` | `Segmented` for `role: 'enum'` slots | ⚠ **`face.paramCells` cannot declare `segmented`** — §5.1 |
| 6 | `:272` | `KnobConic` for continuous slots | a face param cell (knob) |
| 7 | `:298` | `Push all to device` | `ShellActionCell` + audition probe — §3.3 |
| 8 | `:302` ×n | descriptor `role: 'action'` buttons | `ShellActionCell` + audition probe each |
| 9 | `:214` / `:221` / `:228` | problem / stale / open-loop prose | BINDERS §2 rows 4 and 7 — §6 |
| 10 | `:284` | per-slot value readout | ⛔ removes itself — BINDERS §2.4 |
| 11 | `:291` | `pedal-snapped` marker | ⛔ **the cohort's one genuine loss** — BINDERS §2.4 |

### 5.1 ⚠ THE ENUM SLOTS — a second, smaller blocker hiding behind the first

Four `modules` controls and six `bypass` controls are `role: 'enum'`
(`hologram-chroma-console.ts:353,366,379,392,407,420,437,450,463,476,491`). The card renders
those as a `Segmented` over `control.ranges` (`:259-267`, via `segmentOptions`).

**A face cannot.** `paramCellKind` derives `'segmented'` from a param's own `options`
roster; `face.paramCells` has no segmented kind to declare
(`.claude/skills/module-faceplates.md`, "Rosters make states SELECTABLE"). And these params
**cannot carry an `options` roster**: they are `0..127 linear`, `param-vocabulary` requires a
roster to be TOTAL against the param's `min`/`max` span, and a roster of 128 entries for a
3-range enum is not writable.

**So a slot assigned to `bypass` renders as a smooth 0..127 dial over a 2-state control** —
the `moog962` inertness class, arrived at from the opposite direction. `moog962` was a
discrete param drawn as a knob with two reachable positions; this is a continuous param
whose *consumer* has two states.

⚠ **The param cannot be re-declared, and `device-module.ts:79-84` already explains why** —
`curve` stays `'linear'` because *"declaring `discrete` over 0..127 would claim 128 detents,
which is a different and equally false statement, and `param-vocabulary.test.ts` would then
require an `options` roster covering all 128 steps."* **That argument was written about the
card and it is exactly as binding on the face.**

**This is the same shape as §0.2 — a per-node property (the assigned control's ROLE)
determining how a cell should render, where the cell kind is static.** The two should be
sized together: `labelFor` and a `cellKindFor` are one capability wearing two hats, and
solving only the caption would ship eight correctly-labelled knobs, ten of which are the
wrong primitive.

**⚠ Do NOT solve this by restricting which controls are slottable.** `slottableControls`
(`device-descriptor.ts`) is descriptor data describing the pedal, and narrowing it to make
the face easier would delete real capability from the module to satisfy a UI limitation.

---

## 6. RESTING TEXT

BINDERS §2 rows 4–7. Module-specific:

| what | verdict |
|---|---|
| per-slot value readout (`:284`) | ⛔ **removes itself.** `format` is on the DEVICE CONTROL, not the ParamDef; `deviceSlotParams` emits no `format` and no `options`, so `paintsReadout` is false and a bare `0..127 linear` knob has no readout to paint. **Zero work** |
| `pedal-snapped` (`:291`) | ⛔ REMOVED. ⚠ **The cohort's one genuine information loss** — BINDERS §2.4. Two controls (RATE, TIME) become smooth-looking dials over a stepped response. `quantize.note` reaches `aria-valuetext`; a sighted player gets nothing. **Owner-facing item 2** |
| stale-slot count (`:221-223`) | ⛔ text REMOVED, **signal KEPT per-cell** — `status.staleSlots` names WHICH, and the face has eight cells to mark. Strictly better than the card, which says how many and not which |
| `problem` line (`:214`) | ✅ **KEPT** — the outcome of a gesture, not resting text. Same split as `../midiCvBuddy/spec.md §3.2` |
| the open-loop sentence (`:228-230`) | ⛔ **REMOVED — DECIDED, and it is a RELOCATION rather than a coverage loss.** `docs.explanation` (`:69-76`) carries the text verbatim and at greater length, so the warning changes surface rather than disappearing — which is NOT true of any other row here. BINDERS §2.3 answers the card author's argument rather than ignoring it |
| the eight slot captions | ✅ **KEPT and REQUIRED** — §2. They are the only thing separating eight identical knobs. `face.bareCells` must NOT be declared here |

⚠ **`face-resting-text-source.test.ts` sees NONE of this.** It denies `ModuleFace` FIELDS
with no permitted text role — it reads the TYPE. Everything above lives in a
`fullViewBody`'s markup, which is invisible to it exactly as text drawn into a canvas is.
**The enforcement is the dock VRT baseline and a human reading it, and nothing else.**

---

## 7. WHERE STATE LIVES

| what | lives | tagged | face path |
|---|---|---|---|
| slot VALUES (1..8) | `node.params` | via `set()`/`cardParams` | face param cells |
| slot ASSIGNMENTS | `node.data.assign` | ⚠ `ydoc.transact` **without `LOCAL_ORIGIN`** (`:105`) | `fullViewBody`, assign mode |
| port + channel | the device HANDLE, not the graph | n/a | `fullViewBody` |

⚠ **`node.data.assign` is transacted but untagged.** `store.ts:70` tracks
`trackedOrigins=[LOCAL_ORIGIN]`, so **Cmd-Z does not undo a slot reassignment** — atomic but
outside the undo stack. This is a third state BINDERS §4's ✓/✗ column cannot express, and it
is worse here than on the siblings: a reassignment is a **destructive, hard-to-reconstruct**
edit (which of 27 controls was slot 5 before?), and it is exactly the operation a player
would reach for undo after.

**Fixed in this PR:** `ydoc.transact(fn, LOCAL_ORIGIN)`. One argument.

⚠ **And the port/channel do NOT persist in the graph at all.** They live on the device
handle (`createDeviceHandle`). A reload therefore lands on a rack with assignments intact
and no output selected. That is arguably correct (a port id is machine-local), but it is
worth confirming it is a decision and not an omission — **check whether the performance
bundle keys a stable NAME off it**, as `midi-out-buddy.ts:225-229` says it does for its own
device. Recorded, not fixed.

---

## 8. THE e2e SURFACE — the richest in this cohort, and almost all of it survives

`e2e/tests/chromaconsole.spec.ts`, ten tests. Every one drives the GRAPH and asserts on the
WIRE (a fake MIDI output) or on the LEDGER — **not on card markup**:

| line | asserts | after promotion |
|---|---|---|
| `:115` | a slot write reaches the wire as the RIGHT CC on the RIGHT channel | ✅ unaffected |
| `:134` | RATE is CC 66 and TIME is CC 68 (*"the pair the research had swapped"*) | ✅ unaffected |
| `:177` | repeating a value puts no second message on the wire | ✅ unaffected |
| `:195` | a CHANGED value IS transmitted, including a return to a previous one | ✅ unaffected |
| `:216` | PUSH ALL re-asserts every slot though nothing changed | ⚠ **re-point to the ACTION cell** |
| `:240` | with no output, a write sends nothing and is RECORDED undelivered | ✅ unaffected — **and it is the audition probe's oracle** (§3.3) |
| `:273` | an ACTION fires on every press, at the same value | ⚠ re-point |
| `:291` | auto-detect picks the pedal by name and ignores the decoy | ⚠ re-point (the button moves to the body) |
| `:308` | with no matching port, auto-detect selects nothing rather than guessing | ⚠ re-point |

**Six of ten need no change at all.** That is unusually good and it is because the suite was
written against behaviour rather than markup — the property `feedback_e2e_quality_refactor`
asks for. The four re-points all follow the same button into the `fullViewBody`.

⚠ **The testids already exist and are node-scoped** — `chromaconsole-connect-{id}`,
`chromaconsole-port-{id}`, `chromaconsole-assign-{id}-{n}`, `chromaconsole-pushall-{id}`,
`chromaconsole-action-{id}-{actionId}`. **Carry the SAME testids into the extension body**
and three of the four re-points become no-ops. Do not invent new ones; a renamed testid
turns a mechanical move into a behavioural review.

---

## 9. VRT — one committed baseline, and it will MOVE

⚠ **Not exempt.** `e2e/vrt/__screenshots__/vrt.spec.ts/chromaconsole.png` exists, and
promotion replaces the card with a faceplate, so **the card scene must be removed and two
face scenes added** — 1 moved, 2 added.

Three hazards, all named in `vrt-baselines.md`, all live here:

1. ⚠ **`--update-snapshots` cannot regenerate a PASSING-but-stale baseline.** If the card
   scene is retired rather than changed, `git rm` it first — Playwright rewrites only on a
   FAILING comparison. **A green dispatch that commits nothing is a RED FLAG.**
2. ⚠ **A `git rm`-ed baseline is silently recreated by the next plain VRT run** as an
   untracked PNG no gate reads. **`git status` for untracked PNGs after every run.**
3. ⚠ **Never `git rm` a LINUX baseline** — it manufactures an undeclared platform gap and
   reddens `vrt-meta`. Check which this is before deleting anything.

**Predict THREE files (1 removed, 2 added) and COUNT what the bot commits.**
`GREP=chromaconsole flox activate -- task vrt:commit` — ⚠ and note that a face PR touches
shared roster files whose paths name no module, so a **bare dispatch derives FULL**. Pass
`GREP=` and pay ~3 min instead of 41–56.

**And the card's determinism argument transfers.** `:60-63` — *"There is no polling timer:
nothing on this card changes on its own, which is what keeps the resting render stable."*
The face must preserve that: **no activity blink, no counter, no elapsed time.** BINDERS §2.1
permits a non-text activity dot in principle; **here it is refused**, because a blinking
element would break a determinism property this module deliberately holds. That is a
module-specific override of a cohort-wide allowance and it should be written on the face.

---

## 10. COST

| | |
|---|---|
| **WebGL attest** | **ZERO.** Not in the basis (`webgl-attest-lib.ts:68-69`), which the def chose deliberately (§0.1) |
| **ART** | **ZERO.** Zero ports; no audio path |
| **contract-lock** | ⚠ **depends on §0.2.** The FACE is transparent; `ParamDef.labelFor` may not be. **Verify against `contract-lock.test.ts`'s coverage gate** before assuming |
| **Push 2** | **UNCHANGED** — `PUSH_CARD_CONTROLS:64` pins all eight slots explicitly, and an override REPLACES, so a face cannot re-rank it. ⚠ Exactly the protection CLAUDE.md recommends, already in place |
| **docs** | already `STRICT_DOCS:253` with per-slot `docs.controls`. ⚠ If PUSH ALL or an action becomes a `controlFamilies` entry, that IS in the contract — `docs:accept` plus a `docs.controls` entry for the family |
| **VRT** | 1 moved, 2 added — §9 |
| **CI wall-time** | faces-parity ≈ `10 s + 0.8 s/cell` on CI. **8 param cells + ~4 action cells ≈ 22 s.** Plus 3 VRT scenes. Under the ~2 min threshold, but it is the largest in this cohort |
| ⚠ **BOTH cost artifacts** | re-pin `e2e-timings.generated.json` AND `vrt-strict-timings.generated.json`. An unmeasured scene rides the median and reddened `main` once already |

---

## 11. DEFECT LEDGER

| # | defect | where | fix |
|---|---|---|---|
| D1 | `node.data.assign` transacted **without `LOCAL_ORIGIN`** — Cmd-Z does not undo a slot reassignment, the most destructive edit on the module | `:105` | add the origin argument. §7 |
| D2 | ten `role: 'enum'` controls render as smooth 0..127 dials on a face — the `moog962` inertness class from the other direction | §5.1 | **BLOCKED.** Size with D3 |
| D3 | eight face cells captioned `"slot 1"`…`"slot 8"` over a pedal whose controls have names | §0.2 | **BLOCKED.** `ParamDef.labelFor` |
| D4 | port + channel do not persist in the graph; a reload lands with assignments intact and no output | §7 | **verify it is a decision, not an omission.** Not fixed here |

D1 rides the face PR. D2/D3 are the blocker. D4 is a question.

---

## 12. MUST-VERIFY

1. **`ParamDef.labelFor` does not move `contract-lock`.** §10. If the projector walks keys
   generically, it needs a named non-golden entry with a `why` and a `coveredBy`.
2. **The `labelFor` negative control moves in BOTH directions**, and one leg is permanent. §0.2.
3. **`isFamilyMember` really does not exempt the param sweep.** §0.2's third escape rests on
   reading `:127-133` and `:312-355`; re-read both rather than trusting this spec.
4. **The audition probe's ledger oracle distinguishes "never pressed" from "pressed and
   reached nothing".** `chromaconsole.spec.ts:240` says it does. §3.3.
5. **The VRT baseline is not a linux one being `git rm`-ed.** §9 hazard 3.
6. **The four e2e re-points are testid-preserving.** §8.
7. **The user-activation rule survives into the body** (`:108-110`). Same as the siblings.

---

## 13. VERIFICATION GATE

```sh
# ── PR 1: the platform capability (§0.2), ALONE ─────────────────────────────
flox activate -- task test:one -- module-face-lint          # no existing face may move
flox activate -- task test:one -- curated-face
flox activate -- task test:one -- contract-lock             # ⚠ MUST-VERIFY 1
flox activate -- task docs:check                            # expect NO diff
flox activate -- task typecheck
# + the BOTH-DIRECTIONS negative control, one leg permanent (§0.2)

# ── PR 2: the face ──────────────────────────────────────────────────────────
# 1. the rulings' source gates FIRST
flox activate -- task test:one -- face-resting-text-source
flox activate -- task test:one -- face-readout-source
flox activate -- task test:one -- face-width-source

# 2. face lint + promotion anchor + plans
flox activate -- task test:one -- module-face-lint
flox activate -- task test:one -- dock-row-plan
flox activate -- task test:one -- dock-faceplate-model
flox activate -- task test:one -- dock-tabs-model            # assert NO rail (§3.2)

# 3. cells + extension registry + shell module-freedom
flox activate -- task test:one -- shell-cells                # probe shape; no inert cell
flox activate -- task test:one -- shell-extensions
flox activate -- task test:one -- module-shell-import-guard

# 4. the device layer — SHARED, so a regression here hits every future device module
flox activate -- task test:one -- device-module
flox activate -- task test:one -- device-descriptor
flox activate -- task test:one -- mutate.guard               # D1

# 5. registries + neighbours
flox activate -- task test:one -- rear-card-model
flox activate -- task test:one -- push-card-schema           # expect NO diff (override pins it)
flox activate -- task test:one -- param-vocabulary           # §5.1's rosters
flox activate -- task test:one -- module-docs-lint
flox activate -- task docs:accept                            # then REVIEW the diff

# 6. VRT meta — the card baseline is REMOVED, so this is not a no-op
flox activate -- task test:one -- vrt-meta
flox activate -- task test:ledger:accept

# 7. e2e — all ten, REPEAT=3 (four are re-points)
flox activate -- task e2e:serve
REPEAT=3 flox activate -- task e2e:one -- tests/chromaconsole.spec.ts
REPEAT=3 flox activate -- npx --workspace e2e playwright test faces-parity --grep chromaconsole
flox activate -- task e2e:stop

# 8. typecheck LAST
flox activate -- task typecheck

# 9. VRT: dispatch only, SCOPED. Predict THREE files (1 removed, 2 added). COUNT them.
#    ⚠ git rm the retired card baseline FIRST (§9 hazard 1), then git status for
#    untracked PNGs afterwards (hazard 2). NEVER commit a PNG.
GREP=chromaconsole flox activate -- task vrt:commit

# 10. BOTH cost artifacts
flox activate -- task e2e:timings:accept -- <run>
flox activate -- task vrt:strict:timings:accept -- <run>

# 11. attest: NIL.
```

---

## 14. VERDICT

**BLOCKED** on `ParamDef.labelFor` (§0.2) and, sized with it, a per-node cell KIND (§5.1).
**TWO PRs** once unblocked. Risk **MEDIUM**. Estimate **≈ 10 h** for the face, **≈ 3 h** for
the precursor.

**Build it THIRD in the cohort**, after both siblings, and **land the precursor alone.** It
opens a capability to the whole registry rather than to one module, and it should be looked
at on its own — the same argument that made wave 4 put `matrixMix`'s one-field precursor in
its own PR.

⚠ **And it is the template.** `chromaconsole.ts:1-6` calls itself *"The first device
module."* The next one will have N fixed assignable slots over a named control roster and
will meet §0.2 and §5.1 on its first day. **Whatever this face does is what they all do**,
which is the argument for solving the capability rather than working around it here.
