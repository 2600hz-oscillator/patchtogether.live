# FACEPLATE BUILD SPEC — `electraControl` (meta, the Electra One hardware mapper)

> **SPEC + MOCKS. Nothing here is implemented.** Authored to the bar of
> `.myrobots/plans/face-redo-dx7.md` and `.myrobots/2026-08-22-quadralogical-face-mocks/spec.md`.
> The HERO READOUT STRIP and the SIDEBAR are **not reproduced** (deleted fleet-wide
> 2026-08-19, #1957). §10 (the ARIA CONTRACT) replaces them.
>
> **Mocks:** `drawer.html` · `drawer-renaming.html` (open in a browser; self-contained).
>
> **Figure labels** — `DERIVED-BY-READING` · `MEASURED` · `MUST-VERIFY` (re-listed in §15).

**Verdict: DO NOT PROMOTE YET — and the value of this document is that it says exactly what
"yet" costs, in what order, and which of the three blockers turns out not to be real.**

This is the **carve-out wall**, in its sharpest form in the fleet. `electraControl` is in
`NON_SHELL_LANE_TYPES` *and* it is a workflow PIN with `surface: 'drawer'` — so in workflow
mode it renders **only** in the bottom drawer, and `dockRailRendersFace` is
`shellFaces && pinned && migrated`. **The moment `migrated('electraControl')` becomes true,
the drawer stops painting `ElectraControlCard` and starts painting `<ModuleShell view='drawer'>`
— and the def has ZERO params and ZERO ports, so that faceplate is an empty plate with a patch
panel that has no jacks.** The 36-slot matrix, the rename affordance and the connect button
all vanish at once, on a module the owner's rack always contains.

The design below is the face that survives that, and §12 is the platform sequence. **The
headline research result: the blocker the inventory records for this module is the WRONG one.**

---

## 0. THE CONSTRAINT MAP, READ FIRST — and it is the whole spec

| registry | member? | what it means here |
|---|---|---|
| `NON_SHELL_LANE_TYPES` (`legacy-fallback.ts:85`) | **YES** | `laneRenderKind` returns `'legacy'` **unconditionally**: `hasCard` is *"resolves to a real card AND is not a NON_SHELL_LANE_TYPE"*, so promotion **cannot** change the lane. The carve-out's stated reason (`:40-43`): *"clipplayer + the MIDI control surfaces — SNOWFLAKES whose lane face is a grid / launcher / mapper, not a ranked-knob skeleton: they get bespoke faces in a later spike, and stay on the verbatim legacy card until then rather than a lossy placeholder."* **This spec IS that later spike.** |
| `WORKFLOW_PINNED_MODULES` (`workflow-pins.ts:99`) | **YES — the `E` of the M/E/C trio** | `{ type:'electraControl', domain:'meta', id:'pinned-electraControl', key:'e', surface:'drawer' }`. Every workflow rackspace **always has exactly one**, auto-spawned with `data.pinned: true`, **undeletable while pinned**, **excluded from `maxInstances` counting**, and it **renders ONLY in the drawer — never as a canvas card**. |
| `dockRailRendersFace` (`legacy-fallback.ts:213-215`) | ⚠ **THE WALL** | `shellFaces && pinned && migrated`. `migrated` is false today, so the drawer paints the verbatim card — which is why the `NON_SHELL` membership is currently consistent and invisible. **Promotion flips it.** |
| `DOM_SOURCE_LANE_TYPES` / `CARD_PRODUCER_LANE_TYPES` | **NO / NO** | correct — the card produces no engine-visible state. There is no producer seam to protect. |
| `EXEMPT_FROM_VRT` | **NO** | ⚠ **and it carries a LIVE, GATING baseline**: `e2e/vrt/__screenshots__/vrt.spec.ts/electraControl.png`. See §13.2 — three files say it belongs in the exemption and it is not in it. |
| `STRICT_FACES` | **NO — and structurally impossible today** | the set is asserted as *"every def that declares a `face`"* in both directions, and `MetaModuleDef` **has no `face` field**. |
| `PUSH_CARD_CONTROLS` | **NO** | harmless — zero params, nothing to rank. The Push 2 instead gets a **bespoke mode** (`push-electra-model.ts`). |
| `RANGE_BOUND_CARDS` | **NO — and harmlessly so** | `ElectraControlCard.svelte:242-247` binds every range/curve/default off the SOURCE `ParamDef` (`c.def`). It re-types **zero** numbers. ⚠ **The best-behaved card in this wave on the one-source rule**, and worth saying because the other three all fail it. |
| WebGL attest basis | **NO — VERIFIED** | `webgl-attest-hash.sh --list` (218 files) contains no electra file. Editing it is attest-transparent. |
| `face-migration-inventory.ts:647-654` | `bespoke-surface`, blockers `['needs-note-entry-cell']` | ⚠ **§12.3 argues this blocker does not apply to the route this spec takes.** |

---

## 1. WHAT THE MODULE IS FOR

**In one paragraph.** ELECTRA CONTROL is the only module in the fleet whose subject is
**other modules**. It is a 6×6 board of thirty-six named holes, and you fill a hole by
right-clicking any knob anywhere in the rack and sending it here. It stores **pointers, not
values** — a slot is `{ moduleId, paramId, name? }` and nothing else
(`meta/modules/electra-control.ts:26-32`) — so a filled slot is a *live proxy*: turning the
knob on the board turns the real knob on the real module, and the colour stripe above it is
the source module's own control colour, read live and never copied. The verb is **LAY OUT THE
BOARD**: you are not performing here, you are deciding what your hands will find when you reach
for the hardware.

**And the second half, which is what makes the layout matter at all.** The grid is not a
convenience view — it is the **preset the Electra One hardware is flashed with**. Press *Send
to Electra* and the thirty-six slots become an `.epr` preset plus a Lua bundle pushed over
SysEx; the geometry is fixed and positional because the hardware's is
(`graph/electra-control.ts:93-98`):

```
controlSetId = ceil(row / 2)                 // three stacked 2-row banks -> three control sets
potId        = (row odd ? 0 : 6) + knob      // odd rows are pots 1-6, even rows are pots 7-12
slotIndex    = (row - 1) * 6 + (knob - 1)    // STORAGE order, row-major
```

⚠ **The storage order is NOT the firmware's walk**, and the file says so at `:28-34`: *"Do NOT
derive (controlSetId, potId) from a naive `floor(slot/12)+1` / `slot%12+1`."* Two anchors are
pinned in the unit suite: `Row2→2 = cs1 / pot8 / slot7` and `Row6→6 = cs3 / pot12 / slot35`
(`graph/electra-control.test.ts:82-87`, `:136-164`), plus a **bijection** proof that the 36
slots hit every (controlSet, pot) of the 3×12 firmware grid exactly once (`:95-110`).

**What has no analogue on any other module:** there are **zero params, zero inputs, zero
outputs**. `contract-lock.txt:1012` is a single line — `electraControl meta domain=meta
maxInstances=1` — with no port or param rows at all. **Everything persistent is
`node.data.slots`**, a sparse `Record<"0".."35", ControlBinding>` synced through Yjs.

⚠ **THE MUTATION RULE IS LOAD-BEARING AND HAS ALREADY BROKEN ONCE.**
`graph/electra-control.ts:36-41` and `:215-222`: *"never rebuild-and-reassign `data.slots` …
once integrated, spreading it into a fresh object re-integrates already-integrated Y types and
Yjs throws 'Type already integrated' (the same trap that broke the second send-to-surface)."*
Every mutator writes IN PLACE inside one `ydoc.transact`, and the regression is a named unit
leg: *"a SECOND assign to a DIFFERENT slot does NOT throw"* (`electra-control.test.ts:260-270`).
**Any body that rebuilds this map is a shipped crash.**

---

## 2. STOP 1 — is promoting this module a PARITY LOSS?

**YES, catastrophically, unless the face IS the grid.** This is the clearest instance of the
#1974/#2065 refusal bar in the fleet, and it fails on the strictest possible reading:

- **#1974 (`joystick`) — does every tier resolve to zero controls?** Worse than joystick's.
  Joystick at least *has* a param to rank; `electraControl.params` is `[]`, so a generic face
  ranks **nothing at all**, on every tier, by construction.
- **The drawer amplifies it.** `videoOut` survived its carve-out exit *"only because the face
  ranks NOTHING: `laneBodyPlan`'s ROW branch returns `glyph: hasGlyph` unconditionally"*
  (`legacy-fallback.ts:56-59`) — a glyph is a picture and a picture is enough for a LANE TILE
  whose job is identity. **The drawer's job is not identity, it is operation.** An empty plate
  in the drawer is not a diminished view of the module; it is the module gone.

**So the refusal is real and the face is the answer to it**, not an exception from it. §7 is
the entire design.

---

## 3. STOP 2 — does every way of getting DATA IN survive?

```sh
grep -nE '<button|<select|<input|oncontextmenu|manualTrigger|Toggle|Selector|accept=' \
  packages/web/src/lib/ui/modules/ElectraControlCard.svelte
```

| # | affordance | site | after promotion |
|---|---|---|---|
| 1 | `<ModuleTitle defaultLabel="ELECTRA CONTROL" inline>` — rename + control-colour dot | `:204` | **YES** — the shell's own title bar |
| 2 | **`<ElectraConnectButton />`** — the whole flash pipeline (identify → generate `.epr` → push preset + Lua → import CC map → feedback pump → page 1) | `:208` | ⚠ **NO GENERIC CELL EXISTS.** It is not a param, so `face.order` cannot reach it; a `ShellActionCell` could, but it needs a `probe` and this action's observable is a MIDI device (§8). **It goes in the BODY.** |
| 3 | the three bank labels `TOP` / `MID` / `BOT` | `:214-215` | **YES** — body |
| 4 | **36 slot cells**, enumerated from `(row, knob)` and never from the data (`:106-109`) so all 36 always render | `:222-229` | **YES** — body. ⚠ The enumeration is deliberate and must be preserved: it is what makes an EMPTY slot a visible place rather than an absence. |
| 5 | the per-slot colour stripe — a LIVE read of the source module's control colour | `:234-239` | **YES** — body |
| 6 | **the proxied `<Knob>`** — every range/curve/default off the SOURCE `ParamDef`, `onchange` writing the SOURCE node | `:240-252` | **YES** — body. ⚠ It must stay a real `<Knob>`, because rows 7–9 are all things `<Knob>` brings. |
| 7 | per-proxy right-click → MIDI learn / Send to Control Surface / **Remove from ⟨electra⟩** | `Knob.svelte:298` → `ControlContextMenu.svelte:205-215` | **YES** — inherited. ⚠ **This is the ONLY way to clear a slot** (§13.9). |
| 8 | per-proxy drag / dbl-click-to-default / wheel / hover readout / MIDI badge | `Knob.svelte:286-316` | **YES** — inherited |
| 9 | ⚠ **the rename `<input maxlength="14">`**, Enter commits / Escape cancels / blur commits | `:257-268` | ⚠ **THE INVENTORY'S RECORDED BLOCKER — and §12.3 argues it is not one for the body route.** |
| 10 | the rename ✎ button | `:270-281` | **YES** — body |
| 11 | the empty-slot placeholder, `aria-hidden`, **fully inert** | `:284-286` | **YES**, verbatim. §13.9 argues it should not stay inert, as a separate PR. |
| 12 | `onpointerdown` stopPropagation on every cell — pointer PLUMBING that stops the XYFlow canvas drag stealing the gesture | `:222-229` | ⚠ **MUST-VERIFY §15.1** — the drawer is not the canvas, so the guard may be unnecessary there and harmful nowhere. Do not drop it without measuring. |
| — | `PatchPanel` | **absent** | correct: zero ports. `modules-card-map.test.ts:196-198` permits it via a `portCount > 0` guard. ⚠ But `<ModuleShell view='drawer'>` is *"the dock faceplate PLUS the lane `PatchPanel`"* (`legacy-fallback.ts:205-207`) — so promotion **adds** a jack rail with no jacks. §13.10. |

**There is no `node.data` write on this card other than the rename** (`setSlotName`, `:192`) and
one **side effect on every ydoc tick**: `$effect(() => { void cardVersion; pruneElectraDangling(id); })`
(`:75-78`). ⚠ That effect must move with the card or dangling slots stop being pruned — and
nothing tests the wiring, only the pure function (§13.7).

---

## 4. THE RANK — `face.order` IS EMPTY, and that is the design

```ts
face: {
  glyph: 'none',      // no audio out, no video surface — every other literal is a dead glyph
  order: [],          // ZERO params. Not a gap: this module HAS no params.
  pages: [],
  extension: 'electraControl',
}
```

**There is no ranking section in this spec because there is nothing to rank**, and that is the
statement rather than an omission. The entire interaction is the body.

⚠ **`module-face-lint` completeness is VACUOUS here** — it loops `def.params`, and `def.params`
is `[]`, so it asserts nothing and passes. **A green completeness run on this module is not
evidence of anything**, which is exactly the blind-gate shape CLAUDE.md warns about: *"would
its green run look any different if the answer were 'everything'?"* No. **So the gate that must
carry this module is a bespoke source gate over the body** (§11), not the shared one.

⚠ **And `faces-parity`'s exact-multiset assertion is likewise vacuous and NOT harmless.** It
compares the dock's `control-*` testids against the def's param ids. The def has none; the body
paints up to 36 `<Knob>`s each carrying `data-testid="control-<paramId>"` from the SOURCE
param (`Knob.svelte:293`). **So a filled board emits `control-attack` etc. from a module that
declares no params.** MUST-VERIFY §15.2 — this may red the parity sweep on the first filled
scene, and if it does the fix is a scoping rule on the body, not a weakened assertion. It is
also §13.5, which is a live defect independent of any face.

---

## 5. VOCABULARY CHANGES — none possible

Zero params, so no `options`, no `landmarks`, no ranges, no curves. `contract-lock.txt:1012`
does not move. **The only def change this spec proposes is a `face` block, and it does not
typecheck today** (§12.1).

---

## 6. BAND STRUCTURE — none

`pages: []`. Every band would be empty and `dock-faceplate-model.ts:319-321` filters empty
bands, so the plate below the body is nothing at all. **That is correct**: the body IS the
faceplate here, in a way it is not for any of the twenty-eight `picture` adopters, whose bodies
sit ABOVE real control bands.

⚠ **AND THAT IS A GENUINE FIRST, which the body-slot's own doc warns about.**
`shell-extensions.ts:89-95`: *"⚠ IT IS NOT A REPLACEMENT FOR THE FACEPLATE. The pre-wiring
draft of this slot said 'replacing the generic faceplate bands'; wiring it that way would make
the first adopter lose every one of its controls — which is the exact `warrensspectrum` failure
this seam exists to prevent."* **Here there is nothing to lose** — the bands would be empty
whatever the body did — so this module is the one case where "the body is the whole plate" is
honest rather than a regression. **Say so in the face comment**, because a reader who knows
that warning will otherwise read this face as the mistake it names.

**REAR CARD.** Zero ports ⇒ no rear rail. ⚠ `<ModuleShell view='drawer'>` mounts a
`PatchPanel` regardless (§3 row 12, §13.10) — MUST-VERIFY what an empty one renders.

---

## 7. THE BODY — `face.extension: 'electraControl'`

### 7.1 It reaches the DRAWER, and that is not obvious

```ts
// $lib/ui/modules/electraControl/shell-extension.ts
import ElectraGridBody from './ElectraGridBody.svelte';
export default { fullViewBody: ElectraGridBody } satisfies ShellExtension;
```

`dockFullViewHeadPlan` gates `extBody` on **`isFaceplateView(view)`**, which is
`view !== 'lane'` (`module-shell-model.ts:823-824`, `:876-877`) — and the comment is explicit
about why: *"`isFaceplateView`, not `=== 'dock-full'`: the pinned drawer paints the same full
faceplate and wants the same head precedence (#1739)."* **So a `fullViewBody` DOES paint in the
drawer.** DERIVED-BY-READING, and it is the single fact that makes this module promotable at
all. MUST-VERIFY §15.3 in a browser, because a pure-model read is not a render.

⚠ **`editorSurface` is the slot a reader will reach for and it is UNWIRED**
(`shell-extensions.ts:65-69`, `WIRED_SHELL_EXTENSION_SLOTS = ['glyph','fullViewBody']` at
`:124`) — *"the DECLARED contract for the rest of the LEG-05 bespoke-surface cohort. The first
adopter wires the render site in ModuleShell and moves the slot to the wired list IN THE SAME
DIFF."* It is described as *"for controls that are not cell-shaped at all (a clip arranger, a
pad matrix)"*, which is **literally this module**. **Do not wire it.** `fullViewBody` already
does the job, is already wired, is already gated for the drawer, and adopting the unwired slot
would mean a ModuleShell render-site change inside a face PR for no behavioural gain.
Recorded because it is the tempting wrong turn.

### 7.2 The zone map — the body reproduces the card, and it is DELIBERATELY not a redesign

```
┌─ workflow drawer ─────────────────────────────────────────────────────────┐
│ ELECTRA CONTROL                                    [ Send to Electra ]     │
├───────────────────────────────────────────────────────────────────────────┤
│  ┌──────────── fullViewBody: the 6x6 board ────────────────────────────┐   │
│  │ TOP  ▏ ▁▂▃  ▁▂▃  ▁▂▃  ▁▂▃  · · ·  · · ·                             │   │
│  │      ▏ ( ) ✎( ) ✎( ) ✎( ) ✎ ⌀    ⌀                                  │   │  row 1
│  │      ▏ ( ) ✎( ) ✎ ⌀    ⌀    ⌀    ⌀                                  │   │  row 2
│  │ MID  ▏ ( ) ✎ ⌀    ⌀    ⌀    ⌀    ⌀                                  │   │  rows 3-4
│  │ BOT  ▏ ⌀    ⌀    ⌀    ⌀    ⌀    ( ) ✎                               │   │  rows 5-6
│  └─────────────────────────────────────────────────────────────────────┘   │
└───────────────────────────────────────────────────────────────────────────┘
   ( ) = a proxied Knob, striped in the SOURCE module's control colour
   ⌀   = an empty slot: a dim dashed 30px circle that always renders
   ✎   = the rename button (filled slots only)
```

**The design instruction, stated once and load-bearing: PORT THE CARD, DO NOT REDESIGN IT.**
`ElectraControlCard.svelte` is 417 lines of correct, tested, hard-won behaviour — the in-place
Yjs mutations, the live colour passthrough, the shared `electraSlotLabel` expression that the
Push 2 renderer also uses (`:129-132`: *"the SAME expression the Push 2's ElectraControl mode
renders… Never re-type it here"*), the pointer-plumbing guards, the 14-char clamp. **The body
should be that component, moved.** Every deviation is a place the three renderers of this one
grid (card, body, Push) can disagree.

**WIDTH.** `width: max-content; min-width: 360px` (`:298-305`), six columns of ~54 px plus bank
gutters. ⚠ **This is one of the few faces in the fleet that GENUINELY EARNS its width** — six
columns is the hardware's geometry, not a layout choice, and compressing it would break the
1:1 correspondence with the pots a player's hands are on. **Say that in the
`face-width-source` exemption entry, naming the hardware as the thing that consumes the
width.** It is the strongest such argument available: the width is not a design, it is a
device.

### 7.3 The SCREEN switch — NOT APPLICABLE, and the reason is worth recording

The 2026-08-18 ruling covers **video** modules and `video-face-screen-source.test.ts` sweeps
`listVideoModuleDefs()`. This is a meta module with no picture and nothing to collapse.
⚠ **But there IS an adjacent affordance worth NOT building here**: a MONITOR-style
"hide the empty slots" toggle. **Refused** — the always-render enumeration (`:106-109`) is what
makes the board a board; hiding empties would turn a fixed hardware map into a variable list
and break the one property the player's hands rely on.

---

## 8. CONTROL INVENTORY — the two that are not `<Knob>`

| element | primitive | decision |
|---|---|---|
| the 36 proxies | **`<Knob>`, verbatim, in the body** | Not face cells — they proxy params of OTHER nodes, which no `face.order` can address. This is the definitional reason the module needs a body rather than a ranking. |
| the rename field | **a raw `<input maxlength="14">` inside the body** | §12.3. |
| **`ElectraConnectButton`** | ⚠ **in the BODY, not a `ShellActionCell`** | A `ShellActionCell` requires a `probe` (`shell-cells.ts:157`), and the honest observable of this action is *a MIDI device received a SysEx preset*. `{kind:'audition'}` reads the audition ledger for a callable resolved off the ENGINE handle — and this action does not touch the engine; it goes through `ElectraAutoconfig` → `broker` → `navigator.requestMIDIAccess({sysex:true})`. A `param` probe has no param. **A probe that cannot observe the effect is the sixstrum defect with a green tick**, so the button stays a plain button inside the body, where nothing requires a probe it cannot supply. ⚠ **Recorded as a real platform gap** (§13.11): there is no probe shape for a hardware-egress action, and this module, `launchpadControl` and `controlSurface` all have one. |

⚠ **AND THE CONNECT BUTTON CARRIES A SHIPPED-BUG GUARD THAT MUST MOVE WITH IT.**
`ElectraConnectButton.svelte:36-42`: `auto?.stop()` before every new run, because *"its inbound
listeners + feedback pump hold the OLD allocation table, and leaving them live makes one
hardware twist write two params (the row-2↔row-3 ElectraControl crosstalk)"* — with a named
regression at `autoconfig.test.ts:355`. ⚠ **`onDestroy` also calls `auto?.stop();
clearElectraDisplayBindings();` (`:76-79`), and a body in a drawer has a DIFFERENT unmount
lifetime than a card in a lane.** MUST-VERIFY §15.4: if the drawer body unmounts on a rackspace
switch where the card did not, the flash is torn down at a new moment. This is the
`card-unmount-kills-node-resources` class (#1531/#1574/#1583) on a MIDI device.

---

## 9. THE STATE MATRIX

| # | board | connect | body paints | what a reviewer checks |
|---|---|---|---|---|
| 1 | **empty** (fresh spawn) | idle | 36 dim dashed circles, three bank labels, `Send to Electra` | ⚠ **the VRT baseline state** — deterministic by construction, and the reason §13.2 matters |
| 2 | one slot filled (Row2→2 = slot 7) | idle | one striped proxy + ✎, 35 empties | the mock that shows the geometry. Anchored: slot 7 = cs1 / pot8 |
| 3 | slot filled, **renaming** | idle | the ✎ replaced by a focused `<input maxlength="14">` | §12.3 — the affordance the inventory calls a blocker |
| 4 | filled, source module **deleted** | idle | ⚠ the cell goes EMPTY on the next ydoc tick (`pruneElectraDangling`) | the prune fires from the BODY's effect, not the card's (§13.7) |
| 5 | filled, source **param** renamed/removed, module still present | idle | ⚠ **an empty-looking cell with a LIVE binding the user cannot see or remove** | §13.9 — prune covers module-gone only |
| 6 | filled | **flashing** | button reads `connecting` | ⚠ `detail` is computed on four paths and rendered on none (§13.6) |
| 7 | ⚠ **TWO ElectraControls** (pinned + canvas) | flash | both boards paint; **only the id-first one is flashed** | §13.8 — and `pinned-electraControl` sorts first, so the one the user is looking at is the one ignored |

⚠ **Row 7 is reachable on a shipping product today** — `workflow-pins.ts:18-20` excludes the
pinned instance from `maxInstances` counting, so `maxInstances: 1` does not prevent a second.

---

## 10. THE ARIA CONTRACT

⚠ **The resting-text ruling costs this module almost nothing, and that is worth stating.** The
card paints no derived-state values: what it paints is **slot LABELS** — either the source
param's own `label` or the user's typed 14-char name (`electraSlotLabel`). Those are
**CONTROL CAPTIONS**, the first item on the permitted list. **Nothing is deleted here.**

| element | contract |
|---|---|
| each proxied `<Knob>` | `role="slider"` + `aria-valuetext` from `Knob`'s own readout — **inherited, unchanged.** ⚠ `aria-label` should become **`"<slot label> — Row <r> knob <k>, control set <cs> pot <p>"`**: the firmware coordinate is the one fact a player needs and the one the grid position only implies. It is a NAME for a position, not a measurement, so it is permitted — and it is `aria-label` because `<Knob>`'s `aria-valuetext` already carries the VALUE. |
| each empty cell | `aria-hidden="true"` today (`:284-286`). ⚠ **Change it**: an empty slot is a *place*, and a board where 30 of 36 places are unspeakable is a board a screen reader cannot describe. `role="img"` + `aria-label="Row 3 knob 4 — empty"`. **This is not keyboard a11y** (which the owner has ruled out); it is the accessible NAME of a rendered element, which every other cell in the fleet carries. |
| the ✎ button | `aria-label={`Rename ${label}`}` — **already correct** (`:277`). |
| the rename `<input>` | `aria-label={`Rename ${label}`}` — already correct (`:264`). |
| `ElectraConnectButton` | `aria-label="Send this board to the Electra One"`, extended with `detail` (§13.6): `"— failed: no MIDI access"`. ⚠ **`detail` must go here and NOT be painted** — that is the ruling-compatible fix for a string that is currently computed and discarded. |
| the board container | `role="group"`, `aria-label="Electra One board — 6 rows of 6, 4 slots assigned"` ⚠ **a COUNT, and therefore derived — permitted only because it is in an accessible name and never painted.** ⚠ It is also a *population count in a string*: derive it from `Object.keys(data.slots).length`, never type it. |

⚠ **Keyboard.** Owner ruling: no keyboard-a11y work. The rename input's Enter/Escape handling
is a **product** gesture that predates the face and is untouched.

---

## 11. DETERMINISM AND VRT

**Two new scenes** — `face-electraControl-compact` and `face-electraControl-dock` — ⚠ **and
the first one is a problem.** `NON_SHELL_LANE_TYPES` membership means there IS no shell lane
tile: the lane always renders the legacy card. **So a `compact` scene would capture the legacy
card under a face-scene name**, which is worse than having no scene: a green
`face-electraControl-compact` would be evidence about a surface the face does not own.
**MUST-VERIFY §15.5 — the roster may need a per-entry `scenes` narrowing, or this module takes
`dock` only.** That mechanism exists for `FACES_WITHOUT_SCENES` (`scenes: ['compact','dock']`)
and, as far as this spec can read, **not** for `FACES`. If it does not exist, say so; do not
capture a scene that means nothing.

**The dock/drawer scene IS deterministic, for free, and that is unusual.** The capture state is
the fresh spawn: **all 36 slots empty** (asserted at `electra-control.spec.ts:73`), no
animation, no canvas, no clock. `freezeFaceVideo` is not needed and `simPin` is not needed —
so `videoFaceWhy` must be **absent** from the roster entry (it is opt-in, and declaring it
would run a video freeze on a module with no video).

⚠ **This is the strongest determinism story in the wave and the weakest coverage story**, and
those are the same fact: a baseline of an empty board can only ever prove that an empty board
still renders. **It cannot see the 36 proxies, the colours, the rename field or the button
state** — the entire subject of the module. So the gate that carries this face is NOT VRT:

- a **bespoke source gate** over the body, on the `face-rack-status-source` model — assert the
  body really mounts 36 enumerated cells, really imports `electraSlotLabel` rather than
  re-typing it, and really uses the in-place mutators rather than a spread (§1's crash);
- the existing `e2e/tests/electra-control.spec.ts`, **re-pointed at the drawer face** — it
  already drives the full assign → rename → re-assign → proxy-writes-the-source → clear
  lifecycle (`:55-144`), which is the coverage that matters.

⚠ **`freezeIsNotASeam` is NOT APPLICABLE**, and for a structural reason worth recording: it is
a field on `UnbaselinableFace` (`_shell-faces.ts:2841`), read only for `FACES_WITHOUT_SCENES`
entries, and its `declaresFreeze` probe greps
`packages/web/src/lib/video/modules/<type>.ts` (`workflow-shell-faces.spec.ts:770-776`) —
**a meta module is structurally invisible to it.** Neither the field nor the exemption is
reachable here.

---

## 12. THE PLATFORM SEQUENCE — what "not yet" actually costs

Three claimed blockers. **One is a real typing change, one is a real gate change, and one is
not a blocker at all.**

### 12.1 ⚠ REAL — `MetaModuleDef` has no `face` field. This face does not typecheck.

`meta/module-registry.ts:23-56` declares exactly `type, domain, label, category, inputs,
outputs, params, noUserControl?, size?, hp?, maxInstances?, undeletable?, palette?, card?`.
`AudioModuleDef` additionally has `face?` (`audio/module-registry.ts:181`), `docs?` (`:167`),
`controlFamilies?` (`:174`).

**The change:** add `face?: ModuleFace` (and, while there, `docs?: ModuleDocs` — §13.1) to
`MetaModuleDef`. ⚠ **Then check every consumer that enumerates faced defs**: `STRICT_FACES` is
asserted as *"every def that declares a `face`"* in both directions, and
`face-rack-status-source.test.ts` already calls `listMetaModuleDefs()` (`:73`), so the meta
registry is in scope for at least one face gate today. **Small, but it widens a population
several gates iterate — measure before assuming it is one line.**

### 12.2 ⚠ REAL — `BodyRole` has no value for a control matrix.

`face-rack-status-source.test.ts:142`: `type BodyRole = 'picture' | 'status-primitive'`, and
**every `fullViewBody` in the tree must have a roster entry** (the gate's ROSTERED arm, which
*"converts `face-resting-text-source`'s largest named blind spot — 'an extension body can
`fillText()` anything and no gate will ever see it' — from an unbounded admission into an
enumerated, anchored population"*). A grid of proxied knobs is neither a picture nor a status
primitive.

**The change:** a third role — `'control-matrix'` — **with its own MECHANICAL predicate**,
because the gate's whole design is that *"an entry cannot be wrong in the direction that
matters without reddening"*: a `picture` body must mount a `<canvas>`; a `status-primitive`
body must import `StatusLed` and have no canvas. The honest predicate for the new role is
**mounts no `<canvas>` and imports a control primitive from `$lib/ui/controls`**. ⚠ Write the
predicate first; a role with no predicate is a ledger of claims, which is the thing that file
exists to refuse.

### 12.3 ⚠ **NOT A BLOCKER — and this is the research finding of this package.**

`face-migration-inventory.ts:647-654` records `blockers: ['needs-note-entry-cell']` (#1509).
That blocker is defined as *"a note/short-text entry **face cell** — `card-primitive-parity`
declares `NoteEntry` `via: none`, and a raw `<input type="text">` shares the gap, so a typed
pitch field, a MIDI note number or a name field has **no face representation** at all"*, and its
probe looks for typed entry mounted by **`ModuleShell.svelte` — "the ONE renderer every face
cell is painted by"** (`:184-186`).

**Every word of that is about a CELL.** The rename field in this design is **not a cell**: it
is markup inside a module-owned `fullViewBody`, rendered by
`ElectraGridBody.svelte`, which the module owns and statically imports in its own
`shell-extension.ts`. `ModuleShell` never paints it and never needs to.

⚠ **The blocker is real for the modules whose typed field must be a RANKED CONTROL** —
`vstInstrument` and `vstFx` carry the same entry with the same reason, and their picker filter
genuinely wants a cell. **It is not real for a module whose entire surface is a body.** The
inventory entry is a scoping claim that has gone quietly green, which is the exact failure mode
`module-faceplates.md` names: *"A stale SCOPING CLAIM goes quietly green forever — it produces
no failure, only absent work — and it reads as a considered architectural boundary rather than a
snapshot… Before deferring to any scoping claim in this file, check the primitive it says is
missing."* **Recommendation: correct the inventory entry to drop the blocker for this module,
with the argument above written into its `why`.** ⚠ The inventory's own capability probe is
deny-by-default (*"a declaration nobody needs … is RED"*), so **check whether removing this
module leaves `needs-note-entry-cell` still claimed by somebody** — it does (`vstInstrument`,
`vstFx`), so the blocker itself survives and only this membership changes.

### 12.4 The order

1. **12.1** (`MetaModuleDef.face` + `docs`) — its own small PR, with the consumer sweep.
2. **12.2** (`BodyRole: 'control-matrix'` + predicate) — folds into the face PR; the predicate
   is the work, not the enum.
3. **12.3** — an inventory correction, folds into the face PR, one entry.
4. **the face itself** — port the card into `ElectraGridBody.svelte`, declare the extension,
   promote, re-point the e2e at the drawer, resolve §13.2's VRT contradiction.

**Total: two PRs, and the first one is small.**

---

## 13. DEFECT LEDGER

**13.1 — ZERO documentation, and the type system makes it unfixable in place.** No `docs`
block (impossible: `MetaModuleDef` has no field), no `DESCRIPTIONS` entry, no `STRICT_DOCS`
membership. `contract-lock.txt:1012` is one line with no ports and no params. **The module's
entire specification is a 54-line source comment (`electra-control.ts:1-54`) that no gate reads
and no user can see.** ⚠ Compare `matrixMix`, whose undocumented state is *deliberate and
recorded* (`strict-docs.ts:301`); this one is silent. **Severity: fold into 12.1** — adding
`docs?` to `MetaModuleDef` costs the same PR, and the prose already exists in the comment.

**13.2 — ⚠ THE VRT TREATMENT CONTRADICTS ITSELF IN THREE FILES.**
`vrt-exemptions.ts:598` exempts `controlSurface` because *"content is binding-dependent
(proxied controls vary by patch); empty state is a blank square."* Lines `:608-610` and
`:620-621` both assert electraControl is in that class (*"Like CONTROL SURFACE / ELECTRA, the
card body is DEVICE-dependent"*). **Yet `electraControl` is NOT in `EXEMPT_FROM_VRT` and
carries a live gating baseline.** It passes because the solo-spawn state is genuinely
deterministic — which is *stronger* than the exemption and arguably the right answer — but
three files state the opposite rationale for one module, so nobody can tell rigour from
oversight. **Resolve it explicitly in the face PR:** either the exemption prose stops naming
electraControl, or the module joins `EXEMPT_FROM_VRT` **and** `ALLOWED_PERMANENT_EXEMPT` in
the SAME commit (they are anchored in both directions, `:1100-1102`) and the PNG is `git rm`'d.
⚠ If you take the second route: **a `git rm`-ed baseline is silently recreated by the next
plain VRT run as an untracked PNG no gate reads** — `git status` for untracked PNGs after every
run in that window. **Recommendation: keep the baseline, fix the prose.** The empty board is a
real invariant worth pinning.

**13.3 — absent from `EXPECTED_NODE_TYPES` against that file's own instruction.**
`modules-card-map.test.ts:32-35` says *"When you add a NEW module, add its type id here too —
that's the one intentional touch"*; `electraControl` is not in the list. Nothing reddens (the
`dropped` leg is one-directional; the derived leg at `:113-131` covers the real risk). ⚠ **The
consequence is narrow and real**: CLAUDE.md names that file as a hand-maintained collision
surface *reviewed as a list*, and a module missing from it is invisible in that review.
**Severity: fold in.**

**13.4 — dead ternary.** `ElectraConnectButton.svelte:68`:
`status = res.isElectra ? 'ready' : 'ready';` — both arms identical, with the comment
`// uploaded either way`. The next line branches on `isElectra` for `detail`, and `detail` is
never rendered (13.6), **so `res.isElectra` currently has no observable effect anywhere in the
UI.** **Severity: fold in with 13.6.**

**13.5 — ⚠ `data-testid` COLLISION on the proxied knobs, and a spec already works around it
without naming it.** `Knob.svelte:293` keys the testid on **`paramId` alone**, not
`moduleId:paramId`. On this board, two slots bound to `adsr-1.attack` and `adsr-2.attack` both
emit `data-testid="control-attack"` — and each **also collides with the source module's own
knob elsewhere on the canvas**. `electra-control.spec.ts` dodges it by scoping through
`slot22.locator('[role="slider"]')` (`:97`, `:127`, `:135`) rather than the testid.
⚠ **This is also §4's `faces-parity` hazard**: the multiset gate reads exactly these testids.
**Severity: report — it is a shared-primitive defect, not a module one**, and the fix
(`control-<moduleId>-<paramId>`, or a `data-control-params` scoping attribute the way the pad
body does it) touches every card in the fleet.

**13.6 — the `detail` status string is computed on four paths and rendered on none.**
`ElectraConnectButton.svelte:34`, `:48` (`res.reason ?? 'failed'`), `:69`, `:72` (a caught
exception's message) — and the template (`:91-99`) renders only the five `status` words. **A
flash that fails discards its own reason, including a thrown error's message.** ⚠ The fix is
**not** to paint it (that would be a fifth resting-derived-text mechanism); it is
`aria-label` / `title` on the button — speakable, assertable, unpainted (§10). **Severity:
fold in.**

**13.7 — `pruneElectraDangling` fires from the CARD's `$effect` and nothing tests the wiring.**
`ElectraControlCard.svelte:75-78`. The pure function is exhaustively unit-tested
(`electra-control.test.ts:322-336`); **the fact that anything CALLS it is not.** ⚠ Porting the
card into a body moves that effect to a component with a different mount lifetime (§8), so this
is the moment it would silently stop firing. **Severity: fold into the face PR — add the leg.**

**13.8 — ⚠ ONLY THE FIRST ElectraControl'S SLOTS EVER REACH THE HARDWARE, SILENTLY.**
`electra/host.ts:52-54`: `const electras = listElectraControls(patch.nodes); … readElectraData(patch.nodes[electras[0]!.id])`
— **`[0]` only**, ordered by `id.localeCompare`. `maxInstances: 1` looks like the guard, but
`workflow-pins.ts:18-20` **explicitly excludes the pinned instance from `maxInstances`
counting** (*"additional instances spawn as normal canvas cards"*). So a workflow user can hold
**two**, and `pinned-electraControl` sorts before most generated ids — **so the canvas one, the
one the user is looking at, is the one silently ignored.** Meanwhile
`midi-assignable.svelte.ts:275` offers **every** ElectraControl in the *Send to…* menu, so the
user can assign into the dead one. No UI signal, no test. **Severity: report — owner decision**
(is a second board legal at all, or should the pin consume the cap?).

**13.9 — a slot can hold a binding the user can neither see nor remove.**
`pruneElectraDangling` *"only removes a binding when we are CERTAIN the source module is
absent"* (`graph/electra-control.ts:283-286`). A binding to a **renamed or removed PARAM on a
still-present module** is never pruned: `resolveSurfaceParam` returns null, the cell renders as
EMPTY (`:284-286`, inert, `aria-hidden`), and `generatePreset` drops it
(`electra-control.test.ts:183-196`). ⚠ **And the only way to clear a slot is to right-click the
PROXY** (`ControlContextMenu.svelte:205-215`) — which does not exist for an empty-looking cell.
**Permanently invisible dead state.** ⚠ Compounding it: **an empty slot has no affordance at
all**, so a user cannot assign FROM the board either; the only path is a 3-level, 72-leaf
cascade on the source control. **Severity: report — it is a UX design question**, and the
obvious fix (a context menu on the empty cell) is a feature, not a promotion.

**13.10 — `view='drawer'` mounts a `PatchPanel` for a module with zero ports.**
`legacy-fallback.ts:205-207` describes the drawer view as *"the dock faceplate PLUS the lane
`PatchPanel`"*, and the reason is real (the tray has no flip-to-rear affordance, and the owner's
ES-9 rack patches through exactly this surface). ⚠ **electraControl has no ports**, so
promotion adds an empty jack rail below the board. **Severity: MUST-VERIFY §15.6** — it may
render as nothing, in which case this is a note; if it renders a visible empty rail it is a
layout defect to fix before capture.

**13.11 — there is no PROBE SHAPE for a hardware-egress action.** §8. `ShellActionCell.probe`
supports `audition` (the engine ledger), `param`, `data` and `text` — none of which can observe
*a SysEx preset reached a MIDI device*. This module, `launchpadControl` and `controlSurface` all
have such an action, so it is a cohort blocker rather than a module one. ⚠ The honest first
step is a **broker-side ledger** on the same model as the audition ledger — recording
`delivered: false` rather than dropping it, so *"never pressed"* and *"pressed and reached
nothing"* stay distinguishable. **Severity: report — platform, and it gates the rest of the
bespoke-surface cohort.**

**13.12 — the 6×6 geometry is re-typed in the ASSIGNMENT WRITER.**
`graph/electra-control.ts` is explicitly the one home (`:16-17`), and `push-electra-model.ts:47-48`
correctly re-exports rather than re-deriving (*"so the Push layer never re-derives 6"*).
⚠ **`ControlContextMenu.svelte:71-77` does neither** — it hand-writes `ELECTRA_ROWS`,
`ELECTRA_KNOBS` and `electraSlot(row, knob) = (row-1)*6 + (knob-1)`, held together only by a
comment saying *"matching $lib/graph/electra-control"*. **That is the one place a wrong slot
index silently binds a control to the wrong pot**, and it is the only one of the three
renderers not bound to the source. Separately, `ELECTRA_CONTROL_TYPE` is declared **twice**
(`meta/modules/electra-control.ts:58` and `graph/electra-control.ts:47`). **Severity: fold in —
import the symbols.** This is the backdraft one-source rule applied to a coordinate map.

**13.13 (minor) — bank labels disagree with every comment describing them.** Shipping:
`'TOP'`, `'MID'`, `'BOT'` (`graph/electra-control.ts:62-64`), asserted by the e2e
(`electra-control.spec.ts:68-70`). Four headers say `MIDDLE` / `BOTTOM`
(`graph/electra-control.ts:22-23`, `:55-56`; `meta/modules/electra-control.ts:7`, `:21-22`;
`ElectraControlCard.svelte:8`). **Severity: fold in.** A spec that quotes one of the two will
be wrong somewhere.

**13.14 (latent) — the self-proxy guard names only its sibling.**
`graph/control-surface-params.ts:116`: `if (node.type === CONTROL_SURFACE_TYPE) return null; //
never proxy a surface onto itself`. **`ELECTRA_CONTROL_TYPE` is not checked.** Inert today only
because `electraControlDef.params` is `[]`, so `resolveFlat` finds no def and returns null
anyway. **The rule is stated about surfaces and implemented about one type.** **Severity:
report — one line, and it costs nothing to be right.**

---

## 14. TASTE CALLS, EACH WITH ITS ONE-LINE REVERT

1. **`fullViewBody`, not `editorSurface` (§7.1).** Revert: wire `editorSurface` — a ModuleShell
   render-site change inside a face PR, for no behavioural gain.
2. **Port the card verbatim; do not redesign the board (§7.2).** Revert: redesign — and accept
   three renderers of one grid that can disagree.
3. **The connect button lives in the body, not as a `ShellActionCell` (§8).** Revert: a
   `ShellActionCell` with a probe that cannot observe the effect — which is the sixstrum defect.
4. **Empty cells gain an accessible name (§10).** Revert: keep `aria-hidden` — and 30 of 36
   places on the board stay unspeakable.
5. **Keep the VRT baseline and fix the exemption prose (§13.2).** Revert: exempt the module —
   and the empty-board invariant loses its only pixel gate.
6. **`dock` scene only, no `compact` (§11).** Revert: capture both — and the compact PNG is a
   picture of the legacy card filed under a face name.

---

## 15. MUST-VERIFY

1. **The per-cell `onpointerdown` stopPropagation** — still needed in the drawer, which is not
   the XYFlow canvas. Measure; do not drop it on reasoning.
2. **`faces-parity` on a FILLED board.** The body emits `control-<sourceParamId>` testids from a
   def with zero params (§4, §13.5). If the multiset gate reds, the fix is a scoping rule on the
   body — **never a weakened assertion**.
3. **`fullViewBody` really paints in `view='drawer'`.** `isFaceplateView` says yes
   (`module-shell-model.ts:823-824`, `:876-877`) — confirm in a browser, because a pure-model
   read is not a render.
4. **The connect button's unmount lifetime in the drawer** vs the card (§8). `onDestroy` calls
   `auto?.stop()` + `clearElectraDisplayBindings()`; if the drawer body unmounts on a rackspace
   switch where the card did not, the flash is torn down at a new moment.
5. **Can the `FACES` roster narrow a module to `dock` only?** (§11.) If not, say so; do not
   capture a compact scene that photographs the legacy card.
6. **What `view='drawer'`'s `PatchPanel` renders for a zero-port def** (§13.10).
7. **The `BodyRole` predicate for `'control-matrix'`** (§12.2) — written FIRST, and
   negative-controlled in both directions, before any entry adopts it.
8. **`MetaModuleDef.face` does not widen a population a face gate iterates in a way that reds
   something else** (§12.1) — `face-rack-status-source.test.ts:73` already calls
   `listMetaModuleDefs()`.
9. **`pruneElectraDangling` still fires from the body** (§13.7) — the leg that does not exist
   today.
10. **The in-place Yjs mutators survive the port** (§1) — the *"a SECOND assign does NOT throw
    'Type already integrated'"* regression must still pass against the body.

---

## 16. VERIFICATION GATE

```sh
# 1. the geometry + the REAL Y.Doc mutators — the crash regression lives here
REPEAT=3 flox activate -- task test:one -- electra-control
# 2. the face's own model + the body source gate (new)
REPEAT=3 flox activate -- task test:one -- electracontrol-face-model
# 3. the shared plans (mostly VACUOUS here — see §4; run them, do not trust them)
flox activate -- task test:one -- module-face-lint
flox activate -- task test:one -- dock-faceplate-model
flox activate -- task test:one -- curated-face
flox activate -- task test:one -- shell-extensions           # declared id <-> discovered module
flox activate -- task test:one -- module-shell-import-guard  # ModuleShell stays module-free
# 4. the rulings' source gates
flox activate -- task test:one -- face-resting-text-source
flox activate -- task test:one -- face-readout-source        # packages/web/src/lib/ui/controls/
flox activate -- task test:one -- face-width-source          # packages/web/src/lib/ui/dock/
flox activate -- task test:one -- face-rack-status-source    # the NEW BodyRole + its predicate
# 5. the workflow pin + the carve-out anchors
flox activate -- task test:one -- legacy-fallback            # NON_SHELL members resolve to real defs
flox activate -- task test:one -- workflow-surfaces
flox activate -- task test:one -- vrt-meta                   # the two exemption lists stay anchored
flox activate -- task test:one -- modules-card-map
# 6. the OTHER renderers of this same grid must not drift
flox activate -- task test:one -- push-electra-model
flox activate -- task test:one -- preset                     # electraControlName, the positional path
flox activate -- task test:one -- autoconfig                 # the zombie-instance crosstalk guard
# 7. the contract must NOT move — contract-lock.txt:1012 is one line
flox activate -- task docs:accept && flox activate -- git diff
# 8. e2e — the full lifecycle, RE-POINTED at the drawer face
flox activate -- task e2e:serve
REPEAT=3 flox activate -- task e2e:one -- tests/electra-control.spec.ts
REPEAT=3 flox activate -- task e2e:one -- tests/faces-parity.spec.ts
flox activate -- task e2e:stop
# 9. typecheck LAST — and 12.1 is a TYPE change, so this is the gate that proves it
flox activate -- task typecheck
# 10. VRT: dispatch only. Predict the file count, and resolve 13.2 FIRST.
flox activate -- task vrt:commit
# 11. attest: NIL for this module — nothing to run.
```

**The negative controls, spelled out so a builder cannot ship a green stub:** assigning a
SECOND control to a DIFFERENT slot must not throw (`Type already integrated` — the shipped
crash); deleting a source module must empty its cell on the next ydoc tick **from the BODY's
effect**; the `Row6→6` anchor must still resolve `controlSet 3 / pot 12 / slot 35` after the
port; a slot renamed to 15 characters must reach the preset clamped to 14; and
`module-face-lint`'s completeness pass must be **explicitly marked vacuous** in the face model
test, with the reason, so nobody later reads its green as coverage.

## 17. BUILD-COST ESTIMATE

| phase | estimate |
|---|---|
| **PR 1** — `MetaModuleDef.face` + `docs`, plus the consumer sweep (§12.1) | ~2 h |
| **PR 1** — `docs` block ported from the 54-line header + `STRICT_DOCS` + `DESCRIPTIONS` (§13.1) | ~1.5 h |
| **PR 2** — `BodyRole: 'control-matrix'` + its mechanical predicate + negative controls (§12.2) | ~2 h |
| **PR 2** — port `ElectraControlCard` → `ElectraGridBody.svelte` + `shell-extension.ts` | ~3 h |
| **PR 2** — `face` block, `STRICT_FACES`, roster row, inventory correction (§12.3) | ~1 h |
| **PR 2** — the bespoke body source gate + `electracontrol-face-model.test.ts` (§11) | ~3 h |
| **PR 2** — re-point `electra-control.spec.ts` at the drawer face | ~2 h |
| **PR 2** — §13.2 VRT decision, §13.4/13.6 connect button, §13.12 import the geometry, §13.13 labels | ~2 h |
| gate loop, 3× flake checks, typecheck | ~2.5 h |
| **total** | **≈ 19 h across two PRs** |

**Risk rank: HIGH — the highest in the wave, and for a reason no other module in it has: this
module is IN THE OWNER'S RACK ON EVERY LOAD.** It is a workflow pin, it is undeletable while
pinned, and it is the front end of a hardware pipeline with two already-shipped-and-fixed bugs
in its teardown path. A regression here is not a cosmetic one; it is *the board is empty and
the Electra will not flash*. ⚠ **Do not auto-merge this one, whatever the green says.**
